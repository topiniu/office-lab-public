import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { waitForRunInput, answerRunInput, explicitWorkRequest, feedbackText } from '../user-input.js'

test('反馈保持挂起，真实回复只消费一次；中断释放等待且不编造答案', async () => {
  const run = {}, states = [], ctrl = new AbortController()
  let settled = false
  const p = waitForRunInput(run, { signal: ctrl.signal, changed: x => states.push(x) })
  p.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  await assert.rejects(waitForRunInput(run), /已有反馈/)
  assert.equal(answerRunInput(run, ''), false)
  assert.equal(answerRunInput(run, '已关闭'), true)
  assert.equal(await p, '已关闭')
  assert.equal(answerRunInput(run, '重复'), false)
  assert.deepEqual(states, [true, false])
  const aborted = waitForRunInput(run, { signal: ctrl.signal })
  ctrl.abort()
  await assert.rejects(aborted, /中断/)
  assert.equal(run._userInput, undefined)
  await assert.rejects(waitForRunInput(run, { signal: ctrl.signal }), /中断/)
})

test('明确执行指令要收尾；咨询、否定和方案讨论不能自动获得修改授权', () => {
  for (const text of ['修改吧', '改一下吧', '请帮我修复这个问题', '优化一下', '继续实现剩余功能']) assert.equal(explicitWorkRequest(text), true, text)
  for (const text of ['修复了吗？', '这样会不会更合理', '我们为什么失败', '不要修改', '先别修复', '只分析原因', '如何修改', '是否可以实现', '看一下日志', '修改是什么意思']) assert.equal(explicitWorkRequest(text), false, text)
})

// Exercise the actual server decisions without starting its HTTP listener.
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8')

test('占用冲突暂停后不自动重提问；历史接回的新编号在开工前持久化', () => {
  const retry = source.match(/^function shouldAutoRetry\(run, err\) \{[\s\S]*?^\}/m)[0]
  const control = source.match(/^function handleControlMsg\(run, msg\) \{[\s\S]*?^\}/m)[0]
  const saved = [], events = [], run = { id: 'run', sessionId: 'forked' }
  const ctx = vm.createContext({ MAX_AUTO_RETRIES: 3, saveRegistry: () => saved.push(run.sessionId), appendEvent: (_id, event) => events.push(event) })
  vm.runInContext(retry + '\n' + control, ctx)
  assert.equal(ctx.shouldAutoRetry({ sessionId: 'old', stalled: true }, { code: 'CODEX_WRITER_CONFLICT' }), false)
  assert.equal(ctx.handleControlMsg(run, { subtype: 'session_recovered', sourceThreadId: 'old' }), true)
  assert.deepEqual(saved, ['forked'])
  assert.match(events[0].text, /复制原 Codex 历史/)
})
test('截图中的手动请求成卡，建议和已有卡片不重复改写', () => {
  const text = '请关闭旧安装器。关闭后回复“已关闭”即可。'
  const rendered = feedbackText(text, 'message')
  const card = JSON.parse(rendered.split('\n')[1])
  assert.equal(card.options[0].reply, '已关闭')
  assert.equal(card.question, text)
  assert.equal(feedbackText(rendered, 'again'), rendered)
  assert.equal(feedbackText('建议关闭旧程序后安装', 'x'), '建议关闭旧程序后安装')
})
test('聊天咨询豁免；明确执行聊天按原有有界收尾检查续跑', () => {
  const fn = source.match(/^function signoffRejectIfNeeded\(run\) \{[\s\S]*?^\}/m)?.[0]
  assert.ok(fn)
  const calls = []
  const context = vm.createContext({ isConsult: r => r.consult, SIGNOFF_REJECT_MAX: 2,
    stallGuard: { SIGNOFF_EXEMPT_EMPLOYEES: new Set(), validateSignoff: () => ({ ok: false, why: '缺标记', nudge: '继续完成' }), classifyWait: () => ({}), renderResumeSnapshot: () => '' },
    EMPLOYEES: {}, appendEvent: () => {}, broadcast: () => {}, saveRegistry: () => {}, pushTurn: (...args) => calls.push(args),
  })
  vm.runInContext(fn + '\nglobalThis.check = signoffRejectIfNeeded', context)
  const base = { status: 'done', lastKind: 'chat', employee: 'ggbond', _input: {}, result: '需要补实现' }
  assert.equal(context.check({ ...base }), false)
  assert.equal(context.check({ ...base, _turnRequiresSignoff: true, consult: true }), false)
  assert.equal(context.check({ ...base, _turnRequiresSignoff: true }), true)
  assert.equal(calls.length, 1)
  assert.equal(context.check({ ...base, _turnRequiresSignoff: true, _signoffRejects: 2 }), false)
})

test('等待反馈不被 watchdog 当卡死，卡片输出也不能覆盖等待活动', () => {
  const grab = name => source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))[0]
  const waiting = { id: 'waiting', status: 'running', _userInput: {}, _lastActivity: 0 }
  const stale = { id: 'stale', status: 'running', _lastActivity: 0, _abort: { abort() {} } }
  const context = vm.createContext({ Date, liveRuns: new Map([['waiting', waiting], ['stale', stale]]), watchdogGrace: () => 1,
    appendEvent() {}, broadcast() {}, resolveThinking() {},
  })
  vm.runInContext(grab('sweepStalled') + '\n' + grab('deriveActivity'), context)
  context.sweepStalled()
  assert.equal(waiting.stalled, undefined)
  assert.equal(stale.stalled, true)
  assert.equal(context.deriveActivity({ type: 'assistant', message: { content: [{ type: 'text', text: '反馈卡' }] } }, waiting), '等待你的回复')
})

test('真实 reply 路由先解开当前反馈，不能把答案排入下一轮', async () => {
  const run = { id: 'test', sessionId: 'thread', status: 'running' }, events = []
  const answer = waitForRunInput(run)
  const route = source.slice(source.indexOf('    const reply = p.match('), source.indexOf('    // 取消巡视宽限窗'))
  const ctx = vm.createContext({ p: '/api/runs/test/reply', req: { method: 'POST' }, res: {}, runs: { test: run },
    readBody: async () => ({ message: '已关闭' }), appendEvent: (_id, e) => events.push(e), isConsult: () => true, answerRunInput,
    json: (_res, status, body) => ({ status, body }),
  })
  const result = await vm.runInContext('(async () => {' + route + '})()', ctx)
  assert.equal(result.status, 200)
  assert.equal(result.body.feedback, true)
  assert.equal(await answer, '已关闭')
  assert.equal(events[0].queued, undefined)
  assert.equal(run.status, 'running')
})
