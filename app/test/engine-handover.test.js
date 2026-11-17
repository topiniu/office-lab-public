import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { buildHandoverSeed, handoverRun } from '../engines/handover.js'

function fixture(extra = {}) {
  const calls = []
  const run = { id: 'old-run', employee: 'ggbond', engine: 'claude', sessionId: 'claude-session', model: 'claude-model',
    taskFile: 'tasks/a.md', lane: 'dev-a', consult: true, callerRunId: 'caller', threadRootId: 'root', ccChildren: [{ runId: 'child' }],
    guardContract: 'contract.md', executionMode: 'guarded_run', status: 'error', result: '503 No available accounts',
    lastSnapshot: { done: '登录完成', next: '引导页', avoid: '不要重复发布' }, ...extra }
  const deps = { engineIds: ['claude', 'codex'], checkBusy() {}, save() { calls.push('save') },
    cancel() { calls.push('cancel') }, buildSeed: r => buildHandoverSeed(r),
    event(r, text) { calls.push(text) }, start(r) { calls.push({ engine: r.engine, session: r.sessionId, seed: r.engineHandoverSeed }) }, timeoutMs: 30 }
  return { run, deps, calls, request: { engine: 'codex', expectedEngine: 'claude', note: '接着做' } }
}
test('503 without an available Claude model: handover uses saved facts, preserves collaboration and isolation', async () => {
  const { run, deps, calls, request } = fixture()
  await handoverRun(run, request, deps)
  assert.equal(run.id, 'old-run'); assert.equal(run.sessionId, null); assert.equal(run.model, null)
  assert.equal(run.engine, 'codex'); assert.equal(run.callerRunId, 'caller'); assert.equal(run.threadRootId, 'root')
  assert.equal(run.lane, 'dev-a'); assert.equal(run.consult, true); assert.equal(run.guardContract, 'contract.md')
  assert.equal(run.ccChildren[0].runId, 'child'); assert.equal(run.engineHistory[0].sessionId, 'claude-session')
  const started = calls.find(x => typeof x === 'object')
  assert.equal(started.session, null); assert.match(started.seed, /登录完成/); assert.match(started.seed, /503/)
})
test('invalid, same, and stale targets do not stop or mutate the source', async () => {
  for (const change of [{ engine: 'invalid' }, { engine: 'claude' }, { expectedEngine: 'codex' }, { model: 'x\ny' }, { note: 1 }]) {
    const { run, deps, calls, request } = fixture()
    await assert.rejects(handoverRun(run, { ...request, ...change }, deps))
    assert.deepEqual(calls, []); assert.equal(run.sessionId, 'claude-session'); assert.equal(run.engineHandoverPending, undefined)
  }
})
test('waits for actual stream AND in-process tool completion; duplicate click cannot start another engine', async () => {
  let endStream, endTool
  const { run, deps, calls, request } = fixture({
    _streamPromise: new Promise(r => { endStream = r }), _hostTools: new Set([new Promise(r => { endTool = r })]),
  })
  deps.timeoutMs = 1000
  const pending = handoverRun(run, request, deps)
  await assert.rejects(handoverRun(run, request, deps), /重复提交/)
  endStream(); await new Promise(r => setImmediate(r))
  assert.equal(calls.some(x => typeof x === 'object'), false)
  endTool(); await pending
  assert.equal(calls.filter(x => typeof x === 'object').length, 1)
})
test('timeout keeps source engine/session and durable pause, then explicit retry can succeed', async () => {
  let finish
  const { run, deps, calls, request } = fixture({ _streamPromise: new Promise(r => { finish = r }) })
  await assert.rejects(handoverRun(run, request, deps), /未启动新基座/)
  assert.equal(run.engine, 'claude'); assert.equal(run.sessionId, 'claude-session'); assert.ok(run.engineHandoverPending)
  assert.equal(run._handoverBusy, false); assert.equal(calls.some(x => typeof x === 'object'), false)
  const persisted = JSON.parse(JSON.stringify(run, (k, v) => k.startsWith('_') ? undefined : v))
  assert.ok(persisted.engineHandoverPending); assert.ok(persisted.userStoppedAt)
  finish(); await handoverRun(run, request, deps)
  assert.equal(run.engine, 'codex'); assert.equal(run.engineHandoverPending, undefined)
})
test('busy employee is rejected before stop; failed new startup retains recoverable seed, no fallback', async () => {
  const a = fixture(); a.deps.checkBusy = () => { throw new Error('busy') }
  await assert.rejects(handoverRun(a.run, a.request, a.deps), /busy/); assert.deepEqual(a.calls, [])
  const b = fixture(); b.deps.start = () => { throw new Error('missing executable') }
  await assert.rejects(handoverRun(b.run, b.request, b.deps), /missing executable/)
  assert.equal(b.run.engine, 'codex'); assert.equal(b.run.sessionId, null); assert.ok(b.run.engineHandoverSeed)
})
test('reverse handover uses a fresh Claude session and never copies the Codex model', async () => {
  const { run, deps } = fixture({ engine: 'codex', sessionId: 'codex-thread', model: 'codex-model' })
  await handoverRun(run, { engine: 'claude', expectedEngine: 'codex' }, deps)
  assert.equal(run.engine, 'claude'); assert.equal(run.sessionId, null); assert.equal(run.model, null)
  assert.equal(run.engineHistory[0].sessionId, 'codex-thread')
})
test('summary preserves latest instruction, partial work and warnings without treating attempted tool as success', () => {
  const { run } = fixture({ lastSnapshot: null })
  const summary = buildHandoverSeed(run, [
    { type: 'user-msg', userText: '不准发布', text: 'wrapped' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/setup.js' } }, { type: 'text', text: '只完成了一半' }] } },
    { type: 'user-msg', engineHandover: true, text: 'old recursive handover' },
  ], '补完测试')
  for (const text of ['不准发布', 'src/setup.js', '只完成了一半', '没有进度快照', '不等于成功', '补完测试']) assert.ok(summary.includes(text))
  assert.ok(!summary.includes('old recursive handover'))
})

// Exercise the actual server lifecycle gates without importing its self-starting HTTP service.
const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8')
const grab = name => {
  const found = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'))
  assert.ok(found, name); return found[0]
}
test('late old result cannot auto-chain/retry; messages arriving during stop are retained', async () => {
  const { run } = fixture({ engineHandoverPending: { to: 'codex' }, _q: 'old', _input: {}, _abort: {} })
  const events = [], ctx = vm.createContext({
    clearTimeout, liveRuns: new Map([[run.id, run]]), saveRegistry() {},
    normalizeEvent: msg => msg, appendEvent: (id, ev) => events.push(ev),
    // Any attempt to process a late result normally would hit missing dependencies and fail.
  })
  vm.runInContext(['clearLive', 'handleStreamEnd', 'consumeStream', 'holdHandoverMessage', 'sendToRun'].map(grab).join('\n'), ctx)
  await ctx.consumeStream(run, (async function* () { yield { type: 'result', result: '【下一棒】迷糊' } })(), 'dispatch')
  assert.equal(run.result, '503 No available accounts'); assert.equal(run._q, null); assert.equal(events.length, 1)
  ctx.sendToRun(run, '同事的检查结果', { kind: 'dispatch', resume: true })
  assert.equal(run.handoverInbox[0].prompt, '同事的检查结果')
})
test('paused handover is not a terminal cc child and occupies employee/lane even after stream removal', () => {
  const { run } = fixture({ consult: false, status: 'interrupted', engineHandoverPending: { to: 'codex' } })
  const ctx = vm.createContext({ runs: { [run.id]: run }, liveRuns: new Map(), LANE_SERIAL_EMPLOYEES: new Set(),
    isConsult: r => !!r.consult, laneKeyOf: r => r.lane || 'main' })
  vm.runInContext(grab('busyRunFor') + '\n' + source.match(/^const isTerminalRun = .*$/m)[0] + '\nglobalThis.terminal = isTerminalRun', ctx)
  assert.equal(ctx.terminal(run), false); assert.equal(ctx.busyRunFor('ggbond', 'dev-a'), run)
  assert.equal(ctx.busyRunFor('ggbond', 'other'), null)
})
test('old stop fallback timer cannot mark the replacement stream interrupted', () => {
  const code = source.match(/const finalizeStopped = \(\) => \{[^]*?\n      \}/)[0]
  const oldStream = Promise.resolve(), newStream = Promise.resolve()
  const run = { status: 'running', _streamPromise: newStream }
  const ctx = vm.createContext({ run, stoppedStream: oldStream })
  vm.runInContext(code + '\nfinalizeStopped()', ctx)
  assert.equal(run.status, 'running')
})
