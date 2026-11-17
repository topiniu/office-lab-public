import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { createEngineRegistry } from '../engines/index.js'
import { ENGINE_DEFAULTS, createEngineConfigStore, engineForRun, selectNewEngine, enabledEngineIds, validateEngineConfig } from '../engines/config.js'
import { tool, createToolServer, toolCatalog } from '../engines/tools.js'
import { approveCodexAction } from '../engines/codex-policy.js'
import { codexQuery, codexInput, toolOutput, codexToolName } from '../engines/codex.js'
import { CodexRpc } from '../engines/rpc.js'
import { waitForRunInput, answerRunInput } from '../user-input.js'

test('global switch is persisted, old sessions remain Claude, invalid updates are atomic', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-engines-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'engines.json'), store = createEngineConfigStore(file)
  const config = { ...store.get(), defaultEngine: 'codex' }
  store.set(config)
  assert.equal(createEngineConfigStore(file).get().defaultEngine, 'codex')
  assert.equal(engineForRun({ sessionId: 'old-claude-session' }), 'claude')
  assert.equal(selectNewEngine({ config }, ['claude', 'codex']), 'codex')
  assert.equal(selectNewEngine({ config, callerEngine: 'claude' }, ['claude', 'codex']), 'claude')
  assert.equal(selectNewEngine({ config, callerEngine: 'claude', engine: 'codex' }, ['claude', 'codex']), 'codex')
  assert.throws(() => store.set({ ...config, defaultEngine: 'missing' }))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), config)
})

test('a disabled engine is excluded from selection and cannot become the default', () => {
  const config = structuredClone(ENGINE_DEFAULTS); config.providers.codex.disabled = true
  const ids = enabledEngineIds(validateEngineConfig(config), ['claude', 'codex'])
  assert.deepEqual(ids, ['claude'])
  assert.throws(() => selectNewEngine({ engine: 'codex', config }, ids), /未知执行引擎/)
  assert.equal(selectNewEngine({ config }, ids), 'claude')
  assert.throws(() => validateEngineConfig({ ...config, defaultEngine: 'codex' }), /已停用/)
  assert.throws(() => validateEngineConfig({ ...config, providers: { ...config.providers, codex: { ...config.providers.codex, disabled: 'yes' } } }), /停用标记/)
})

test('a third engine registers without changing orchestration and never silently falls back', async () => {
  const registry = createEngineRegistry([{ id: 'third', label: 'Third', async *query({ prompt }) { yield { type: 'result', result: prompt } } }])
  const result = []
  for await (const ev of registry.query({ prompt: 'hello', options: { engine: 'third' } })) result.push(ev)
  assert.equal(result[0].result, 'hello')
  assert.throws(() => registry.query({ prompt: '', options: { engine: 'claude' } }))
})

test('shared tools preserve input validation, whitelist, errors and images', async () => {
  let called = 0
  const catalog = toolCatalog({ lab: createToolServer({ name: 'lab', tools: [
    tool('sum', 'add', { n: z.number().int() }, async ({ n }) => { called++; return { content: [{ type: 'text', text: String(n + 1) }] } }),
    tool('hidden', 'no', {}, async () => { throw new Error('must not run') }),
  ] }) }, ['mcp__lab__sum'])
  assert.equal(catalog.size, 1)
  await assert.rejects(catalog.get('mcp__lab__sum').invoke({ n: '1' }))
  assert.equal(called, 0)
  const output = toolOutput(await catalog.get('mcp__lab__sum').invoke({ n: 1 }))
  assert.equal(output.contentItems[0].text, '2')
  assert.equal(toolOutput({ isError: true }).success, false)
  assert.equal(toolOutput({ content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] }).contentItems[0].imageUrl, 'data:image/png;base64,AA==')
})

test('Codex native approvals keep hard deny, read-only, role lock and explicit user decisions', async () => {
  let asked = 0
  const options = { cwd: process.cwd(), permissionMode: 'bypassPermissions', settings: { permissions: { deny: ['Bash(rm -rf *)', 'Bash(*mr merge*)'] } }, requestApproval: async () => { asked++; return { behavior: 'deny' } } }
  assert.equal(await approveCodexAction(options, 'Bash', { command: 'cd x && rm -rf project' }), false)
  assert.equal(await approveCodexAction(options, 'Bash', { command: 'glab mr merge 10' }), false)
  assert.equal(await approveCodexAction(options, 'Bash', { command: 'npm test' }), true)
  assert.equal(await approveCodexAction({ ...options, readOnly: true }, 'Edit', { file_path: path.join(process.cwd(), 'README.md') }), false)
  assert.equal(await approveCodexAction({ ...options, codeLocked: true }, 'Edit', { file_path: path.join(process.cwd(), 'frontend/a.ts') }), false)
  const customLock = { ...options, codeLocked: true, protectedCodeRoots: ['service'] }
  assert.equal(await approveCodexAction(customLock, 'Edit', { file_path: path.join(process.cwd(), 'service', 'a.ts') }), false)
  assert.equal(await approveCodexAction(customLock, 'Edit', { file_path: path.join(process.cwd(), 'service-notes.md') }), true)
  assert.equal(await approveCodexAction(options, 'Edit', { file_path: path.resolve(process.cwd(), '../outside') }), false)
  assert.equal(await approveCodexAction({ ...options, permissionMode: 'default' }, 'Bash', { command: 'npm test' }), false)
  assert.equal(asked, 1)
})

class FakeRpc {
  requests = []; sends = []; closed = false; rounds = 0
  async request(method, params) {
    this.requests.push({ method, params })
    if (method === 'initialize') return {}
    if (method === 'config/read') return { config: { mcp_servers: { ambient: { command: 'ambient-server' } } } }
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || 'codex-thread' }, model: 'test-model' }
    if (method === 'turn/start') {
      const round = ++this.rounds
      queueMicrotask(async () => {
        this.onNotification('turn/started', { threadId: 'codex-thread', turn: { id: `turn-${round}` } })
        if (this.hang) return
        if (this.tool) this.toolResult = await this.onRequest('item/tool/call', { threadId: 'codex-thread', tool: 'lab__lab__sum', arguments: { n: 4 } })
        this.onNotification('item/completed', { item: { type: 'agentMessage', id: `message-${round}`, text: `reply ${round}` } })
        this.onNotification('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 2 } } })
        this.onNotification('turn/completed', { turn: { id: `turn-${round}`, status: this.failed ? 'failed' : 'completed', error: this.failed ? { message: 'inference failed' } : null } })
      })
      return { turn: { id: `turn-${round}` } }
    }
    throw new Error(`Unexpected ${method}`)
  }
  send(message) { this.sends.push(message) }
  close() { this.closed = true }
}
const opts = () => ({ engine: 'codex', engineConfig: ENGINE_DEFAULTS.providers.codex, cwd: process.cwd(), systemPrompt: { append: 'Employee SOP' }, abortController: new AbortController() })

class WriterConflictRpc extends FakeRpc {
  conflicts = Infinity
  async request(method, params) {
    if (method === 'thread/resume' && this.conflicts-- > 0) {
      this.requests.push({ method, params })
      throw new Error(`thread ${params.threadId} already has an active writer`)
    }
    if (method === 'thread/fork') {
      this.requests.push({ method, params })
      return { thread: { id: 'codex-thread' } }
    }
    return super.request(method, params)
  }
}

test('writer conflict waits on an OL card before retrying the untouched original thread', async () => {
  const rpc = new WriterConflictRpc(); rpc.conflicts = 1
  const run = {}, options = { ...opts(), resume: 'codex-thread', requestUserInput: (_q, { signal }) => waitForRunInput(run, { signal }) }
  let cards = 0
  for await (const event of codexQuery({ prompt: '继续之前的工作', options, rpcFactory: () => rpc })) {
    if (!event.message?.content?.[0]?.text?.startsWith('```olcard')) continue
    cards++
    assert.ok(run._userInput)
    assert.equal(rpc.rounds, 0, 'input must not execute before the writer is released')
    assert.equal(rpc.requests.filter(r => r.method === 'thread/resume').length, 1)
    answerRunInput(run, '已释放占用，重试原会话')
  }
  assert.equal(cards, 1)
  assert.equal(rpc.rounds, 1)
  assert.equal(rpc.requests.filter(r => r.method === 'thread/resume').length, 2)
  assert.ok(!rpc.requests.some(r => r.method === 'thread/fork'))
  assert.equal(run._userInput, undefined)
})

test('recovery questions have fresh card IDs across retries and separate queries before resume succeeds', async () => {
  const ids = new Set()
  for (let query = 0; query < 2; query++) {
    const rpc = new WriterConflictRpc(), run = {}
    let cards = 0
    const task = (async () => {
      for await (const event of codexQuery({ prompt: '继续', options: { ...opts(), resume: 'original-thread', requestUserInput: (_q, { signal }) => waitForRunInput(run, { signal }) }, rpcFactory: () => rpc })) {
        const text = event.message?.content?.[0]?.text
        if (!text?.startsWith('```olcard')) continue
        const card = JSON.parse(text.split('\n')[1])
        assert.equal(event.session_id, null)
        assert.equal(card.id, event.message.id)
        assert.ok(!ids.has(card.id), 'a previous choice must never resolve a later question')
        ids.add(card.id)
        answerRunInput(run, ++cards === 1 ? '已释放占用，重试原会话' : '稍后处理')
      }
    })()
    await assert.rejects(task, e => e.code === 'CODEX_WRITER_CONFLICT')
    assert.equal(cards, 2)
    assert.equal(rpc.rounds, 0)
    assert.equal(run._userInput, undefined)
  }
  assert.equal(ids.size, 4)
})

test('only an explicit stopped-other-host choice forks history and publishes the replacement id before execution', async () => {
  const rpc = new WriterConflictRpc(), run = {}, events = []
  const options = { ...opts(), resume: 'original-thread', requestUserInput: (_q, { signal }) => waitForRunInput(run, { signal }) }
  for await (const event of codexQuery({ prompt: '保留原始输入', options, rpcFactory: () => rpc })) {
    events.push(event)
    if (event.message?.content?.[0]?.text?.startsWith('```olcard')) {
      assert.ok(!rpc.requests.some(r => r.method === 'thread/fork'))
      answerRunInput(run, '已停止另一端，复制历史接回')
    }
    if (event.subtype === 'session_recovered') {
      assert.equal(event.session_id, 'codex-thread')
      assert.equal(event.sourceThreadId, 'original-thread')
    }
  }
  const fork = rpc.requests.find(r => r.method === 'thread/fork').params
  assert.equal(fork.threadId, 'original-thread')
  assert.equal(fork.excludeTurns, true)
  assert.equal(fork.deferGoalContinuation, true)
  assert.equal(fork.dynamicTools, undefined, 'fork keeps persisted tools; protocol has no override')
  assert.ok(events.findIndex(e => e.subtype === 'session_recovered') < events.findIndex(e => e.subtype === 'execution_intent'))
  const turn = rpc.requests.find(r => r.method === 'turn/start').params
  assert.equal(turn.threadId, 'codex-thread')
  assert.equal(turn.input[0].text, '保留原始输入')
  assert.equal(rpc.rounds, 1)
})

test('writer recovery is bounded, free text cannot approve a fork, and abort releases its waiter', async () => {
  for (const answer of ['稍后处理', '继续', '已释放占用，重试原会话', null]) {
    const rpc = new WriterConflictRpc(), run = {}
    const options = { ...opts(), resume: 'original-thread', requestUserInput: (_q, { signal }) => waitForRunInput(run, { signal }) }
    const task = (async () => {
      for await (const ev of codexQuery({ prompt: '继续', options, rpcFactory: () => rpc })) {
        if (!ev.message?.content?.[0]?.text?.startsWith('```olcard')) continue
        if (answer) answerRunInput(run, answer); else options.abortController.abort()
      }
    })()
    await assert.rejects(task, answer === null ? /取消/ : answer.includes('重试') ? /执行端持锁/ : /已暂停接回/)
    assert.equal(rpc.rounds, 0)
    assert.ok(!rpc.requests.some(r => r.method === 'thread/fork'))
    assert.ok(rpc.requests.filter(r => r.method === 'thread/resume').length <= 3)
    assert.equal(run._userInput, undefined)
    assert.equal(rpc.closed, true)
  }
  const rpc = new WriterConflictRpc()
  await assert.rejects(async () => { for await (const _ of codexQuery({ prompt: '继续', options: { ...opts(), resume: 'original-thread' }, rpcFactory: () => rpc })) {} }, /本次任务尚未开始/)
})

test('explicit force stop retries the same thread; a shared writer is retained and never forks automatically', async () => {
  for (const stopped of [true, false]) {
    const rpc = new WriterConflictRpc(), run = {}; let stops = 0, released = 0, cards = 0
    const manager = { async stop(id) { assert.equal(id, 'codex-thread'); stops++; if (stopped) rpc.conflicts = 0; return { stopped, reason: stopped ? '旧执行端已停止' : '共享后台会保留' } }, async register() { return async () => { released++ } } }
    const task = (async () => {
      for await (const ev of codexQuery({ prompt: '原始工作', options: { ...opts(), resume: 'codex-thread', requestUserInput: (_q, { signal }) => waitForRunInput(run, { signal }) }, rpcFactory: () => rpc, ownerManager: manager })) {
        const text = ev.message?.content?.[0]?.text
        if (!text?.startsWith('```olcard')) continue
        cards++
        assert.ok(JSON.parse(text.split('\n')[1]).options.some(o => o.reply === '强制停止本条旧执行端并重试'))
        answerRunInput(run, cards === 1 ? '强制停止本条旧执行端并重试' : '稍后处理')
      }
    })()
    if (stopped) await task; else await assert.rejects(task, e => e.code === 'CODEX_WRITER_CONFLICT')
    assert.equal(stops, 1)
    assert.equal(rpc.rounds, stopped ? 1 : 0)
    assert.equal(released, stopped ? 1 : 0)
    assert.ok(!rpc.requests.some(r => r.method === 'thread/fork'))
    assert.equal(run._userInput, undefined)
  }
})

class FeedbackRpc extends FakeRpc {
  async request(method, params) {
    if (method !== 'turn/start') return super.request(method, params)
    this.requests.push({ method, params }); this.rounds++
    this.task = Promise.resolve().then(async () => {
      this.onNotification('turn/started', { turn: { id: 'turn-feedback' } })
      this.response = await this.onRequest(this.dynamic ? 'item/tool/call' : 'item/tool/requestUserInput', this.dynamic
        ? { tool: 'lab_request_user_input', arguments: { question: '请关闭旧安装器', options: [{ label: '已关闭' }] } }
        : { questions: [{ id: 'close', question: '请关闭旧安装器', options: [{ label: '已关闭', description: '继续清理' }] }, { id: 'note', question: '补充说明' }] })
      this.onNotification('item/completed', { item: { type: 'agentMessage', id: 'done', text: '已继续完成清理\n【等你拍板】无' } })
      this.onNotification('turn/completed', { turn: { id: 'turn-feedback', status: 'completed' } })
    })
    this.task.catch(() => {})
    return { turn: { id: 'turn-feedback' } }
  }
}

test('native questions render OL cards, wait for real answers by id, and finish the same resumed turn', async () => {
  const rpc = new FeedbackRpc(), run = {}, events = [], cards = []
  const options = { ...opts(), resume: 'codex-thread', requestUserInput: (_q, { signal }) => waitForRunInput(run, { signal }) }
  for await (const ev of codexQuery({ prompt: '改一下吧', options, rpcFactory: () => rpc })) {
    events.push(ev)
    const text = ev.message?.content?.find(b => b.type === 'text')?.text
    if (!text?.startsWith('```olcard')) continue
    const card = JSON.parse(text.split('\n')[1]); cards.push(card)
    assert.equal(rpc.response, undefined, 'RPC cannot resolve with empty answers before user replies')
    assert.ok(run._userInput)
    answerRunInput(run, cards.length === 1 ? '已关闭' : '保留已有配置')
  }
  assert.equal(cards.length, 2)
  assert.notEqual(cards[0].id, cards[1].id)
  assert.equal(cards[0].options[0].reply, '已关闭')
  assert.equal(cards[0].options[0].desc, '继续清理')
  assert.deepEqual({ ...rpc.response.answers }, { close: { answers: ['已关闭'] }, note: { answers: ['保留已有配置'] } })
  assert.equal(rpc.rounds, 1)
  assert.equal(events.filter(e => e.type === 'result').length, 1)
  assert.ok(events.find(e => e.subtype === 'execution_intent').requiresSignoff)
  assert.equal(rpc.requests.find(r => r.method === 'thread/resume').params.dynamicTools, undefined)
  assert.equal(run._userInput, undefined)
})

test('explicit feedback tool resumes with the exact free text; abort also releases a native question', async () => {
  const rpc = new FeedbackRpc(); rpc.dynamic = true
  const run = {}, options = { ...opts(), requestUserInput: (_q, { signal }) => waitForRunInput(run, { signal }) }
  for await (const ev of codexQuery({ prompt: '修复问题', options, rpcFactory: () => rpc })) {
    if (ev.message?.content?.[0]?.text?.startsWith('```olcard')) answerRunInput(run, '暂时无法关闭，先做其他部分')
  }
  assert.equal(rpc.response.contentItems[0].text, '暂时无法关闭，先做其他部分')
  const hung = new FeedbackRpc(), abortOptions = { ...opts(), requestUserInput: options.requestUserInput }
  const work = (async () => {
    for await (const ev of codexQuery({ prompt: '修复问题', options: abortOptions, rpcFactory: () => hung })) {
      if (ev.message?.content?.[0]?.text?.startsWith('```olcard')) abortOptions.abortController.abort()
    }
  })()
  await assert.rejects(work, /取消/)
  assert.equal(run._userInput, undefined)
  assert.equal(hung.closed, true)
})

test('staff bypass uses full access for new and resumed Codex threads, with explicit read-only exceptions', async () => {
  const cases = [
    [{ permissionMode: 'bypassPermissions', codeLocked: true }, 'never', 'danger-full-access'],
    [{ permissionMode: 'bypassPermissions', codeLocked: true, resume: 'old-thread' }, 'never', 'danger-full-access'],
    [{ permissionMode: 'bypassPermissions', readOnly: true }, 'never', 'read-only'],
    [{ permissionMode: 'bypassPermissions', tools: [] }, 'never', 'read-only'],
    [{ permissionMode: 'bypassPermissions', allowedTools: ['mcp__lab__read'] }, 'never', 'read-only'],
    [{ permissionMode: 'acceptEdits', codeLocked: true }, 'untrusted', 'read-only'],
    [{ permissionMode: 'default' }, 'untrusted', 'workspace-write'],
  ]
  for (const [overrides, approvalPolicy, sandbox] of cases) {
    const rpc = new FakeRpc(), events = []
    for await (const ev of codexQuery({ prompt: 'check policy', options: { ...opts(), ...overrides }, rpcFactory: () => rpc })) events.push(ev)
    const params = rpc.requests.find(r => /^thread\/(start|resume)$/.test(r.method)).params
    assert.equal(params.approvalPolicy, approvalPolicy)
    assert.equal(params.sandbox, sandbox)
    assert.equal(events[0].sandbox, sandbox)
    if (overrides.codeLocked) assert.match(params.developerInstructions, /不得修改业务代码/)
  }
})

test('Codex cold resume, two hot turns, host tool, usage and cleanup use real protocol shapes', async () => {
  const rpc = new FakeRpc(); rpc.tool = true
  const options = { ...opts(), resume: 'codex-thread', mcpServers: { lab: createToolServer({ name: 'lab', tools: [tool('sum', 'sum', { n: z.number() }, ({ n }) => ({ content: [{ type: 'text', text: String(n + 1) }] }))] }) } }
  async function* prompts() { yield { message: { content: 'one' } }; yield { message: { content: 'two' } } }
  const events = []
  for await (const event of codexQuery({ prompt: prompts(), options, rpcFactory: () => rpc })) events.push(event)
  assert.equal(events.filter(e => e.type === 'result').length, 2)
  assert.equal(events.at(-1).result, 'reply 2')
  assert.equal(events.at(-1).usage.input_tokens, 7)
  assert.equal(rpc.toolResult.contentItems[0].text, '5')
  assert.equal(rpc.requests.find(r => r.method === 'thread/resume').params.threadId, 'codex-thread')
  assert.equal(rpc.requests.find(r => r.method === 'thread/resume').params.config['mcp_servers.ambient.enabled'], false)
  assert.equal(rpc.closed, true)
})

test('Codex failed turns never report success; abort closes a pending turn promptly', async () => {
  const failed = new FakeRpc(); failed.failed = true
  const events = []
  for await (const ev of codexQuery({ prompt: 'fail', options: opts(), rpcFactory: () => failed })) events.push(ev)
  assert.equal(events.at(-1).is_error, true)
  const hung = new FakeRpc(); hung.hang = true
  const options = opts()
  const task = (async () => { for await (const ev of codexQuery({ prompt: 'hang', options, rpcFactory: () => hung })) {
    if (ev.type === 'system') setTimeout(() => options.abortController.abort(), 10)
  } })()
  await assert.rejects(task, /取消/)
  assert.equal(hung.closed, true)
  assert.ok(hung.sends.some(s => s.method === 'turn/interrupt'))
})

test('multimodal input is translated losslessly; unsupported content is not silently dropped', () => {
  assert.equal(codexToolName('mcp__lab__sum'), 'lab__lab__sum')
  assert.ok(codexToolName('mcp__' + 'x'.repeat(100)).length <= 64)
  assert.notEqual(codexToolName('mcp__' + 'x'.repeat(100)), codexToolName('mcp__' + 'x'.repeat(101)))
  assert.deepEqual(codexInput([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]), [{ type: 'image', url: 'data:image/png;base64,AA==' }])
  assert.throws(() => codexInput([{ type: 'unknown' }]))
})

test('Codex exposes only role tools, declines unknown actions and never invents user answers', async () => {
  const rpc = new FakeRpc()
  const options = { ...opts(), allowedTools: ['mcp__lab__sum'], readOnly: true }
  for await (const event of codexQuery({ prompt: 'hello', options, rpcFactory: () => rpc })) {
    if (event.subtype !== 'init') continue
    const opened = rpc.requests.find(r => r.method === 'thread/start').params
    assert.equal(opened.sandbox, 'read-only')
    assert.equal(opened.config['features.shell_tool'], false)
    assert.equal(opened.config.web_search, 'disabled')
    await assert.rejects(rpc.onRequest('item/tool/requestUserInput', { questions: [{ id: 'x', question: 'Choose?' }] }), /未接入/)
    assert.equal((await rpc.onRequest('item/tool/call', { tool: 'lab__lab__hidden', arguments: {} })).success, false)
    assert.deepEqual(await rpc.onRequest('item/commandExecution/requestApproval', { command: 'echo x' }), { decision: 'decline' })
    assert.deepEqual(await rpc.onRequest('item/fileChange/requestApproval', { itemId: 'unknown' }), { decision: 'decline' })
  }
})

test('stdio RPC handles response, malformed output, timeout, missing executable and process cleanup', async () => {
  const make = code => new CodexRpc({ command: process.execPath, args: ['-e', code], cwd: os.tmpdir(), env: process.env, timeoutMs: 3000 })
  const rpc = make(`require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({id:m.id,result:{ok:true}}))})`)
  try { assert.deepEqual(await rpc.request('ping'), { ok: true }) } finally { await rpc.close() }
  assert.notEqual(rpc.child.exitCode ?? rpc.child.signalCode, null)
  const invalid = make(`process.stdin.on('data',()=>console.log('not-json'))`)
  await assert.rejects(invalid.request('ping'), /JSON-RPC/)
  await invalid.close()
  const hung = make(`process.stdin.resume()`); hung.timeoutMs = 200
  await assert.rejects(hung.request('ping'), /超时/)
  await hung.close()
  const missing = new CodexRpc({ command: path.join(os.tmpdir(), 'lab-intentionally-missing-executable'), cwd: os.tmpdir() })
  await assert.rejects(missing.request('ping'), /无法启动/)
  await missing.close()
})
