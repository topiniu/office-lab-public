import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planBatch, runPool, normalizeSessionResult, digestRepairContext, buildWakePrompt, executeBatch,
  DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MAX_FILES, isTerminal, extractHandle,
  readCaseOutcomes, CASE_SESSION_TIMEOUT_MS, FILE_SESSION_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS,
  redCalibrationVerdict,
} from '../e2e-batch.js'

// ---------- planBatch：入参校验（路径安全 / 去重 / 并发钳制） ----------
test('planBatch 拒空与超量', () => {
  assert.ok(planBatch([]).error)
  assert.ok(planBatch(null).error)
  assert.ok(planBatch(Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ testFilePath: `a${i}.json` }))).error)
})

test('planBatch 拒绝越界/绝对路径/带前缀/非 json', () => {
  assert.match(planBatch([{ testFilePath: '../x.json' }]).error, /\.\./)
  assert.match(planBatch([{ testFilePath: '/abs/x.json' }]).error, /相对路径/)
  assert.match(planBatch([{ testFilePath: 'D:/x.json' }]).error, /相对路径/)
  assert.match(planBatch([{ testFilePath: 'test-workflows/x.json' }]).error, /前缀/)
  assert.match(planBatch([{ testFilePath: 'x.txt' }]).error, /\.json/)
  assert.ok(planBatch([{ testFilePath: '' }]).error)
})

test('planBatch 归一化：反斜杠、scope 推导、去重、并发钳制', () => {
  const p = planBatch([
    { testFilePath: 'v519\\a.json' },
    { testFilePath: 'v519/a.json' },                          // 与上条同签名 → 合并
    { testFilePath: 'v519/b.json', caseIds: ['c1', 'c2'] },
    { testFilePath: 'v519/b.json', caseIds: ['c2', 'c1'] },    // caseIds 顺序不同但同集合 → 合并
  ], { concurrency: 99 })
  assert.equal(p.error, undefined)
  assert.equal(p.items.length, 2)
  // 2026-10-27：指定 caseIds 的修复项排到整文件前面
  assert.equal(p.items[0].scope, 'selected')
  assert.equal(p.items[0].label, 'v519/b.json(c1,c2)')
  assert.equal(p.items[1].testFilePath, 'v519/a.json')
  assert.equal(p.items[1].scope, 'all')
  assert.equal(p.concurrency, 2)                              // 上限 min(MAX, items.length)
  assert.equal(p.warnings.length, 3)                          // 2 条合并 + 1 条重排
})

test('planBatch 并发默认值与下限', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ testFilePath: `f${i}.json` }))
  assert.equal(planBatch(many).concurrency, DEFAULT_CONCURRENCY)
  assert.equal(planBatch(many, { concurrency: 0 }).concurrency, DEFAULT_CONCURRENCY)
  assert.equal(planBatch(many, { concurrency: 'x' }).concurrency, DEFAULT_CONCURRENCY)
  assert.equal(planBatch(many, { concurrency: 100 }).concurrency, MAX_CONCURRENCY)
  assert.equal(planBatch(many, { concurrency: 1 }).concurrency, 1)
})

// ---------- runPool：真并发 + 有序 + 单项失败不掀桌 ----------
test('runPool 并发上限生效、结果有序、抛错落成该项 error', async () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ label: 'i' + i }))
  let live = 0, peak = 0
  const out = await runPool(items, 3, async (it, i) => {
    live++; peak = Math.max(peak, live)
    await new Promise(r => setTimeout(r, 5))
    live--
    if (i === 4) throw new Error('boom')
    return { ...it, ok: true, i }
  })
  assert.equal(peak, 3)                       // 从未超过 3 并发
  assert.equal(out.length, 7)
  assert.equal(out[0].i, 0)                   // 有序（不是完成顺序）
  assert.equal(out[6].i, 6)
  assert.equal(out[4].ok, false)
  assert.match(out[4].error, /boom/)
})

// ---------- normalizeSessionResult：吃两种返回形状 ----------
test('normalizeSessionResult 兼容扁平与 data 包一层、status/ok 派生', () => {
  const item = { testFilePath: 'a.json', caseIds: [], label: 'a.json' }
  const flat = normalizeSessionResult({ ok: true, sessionId: 's1', roundId: 'round-1', status: 'passed', reportPath: 'r.md' }, item)
  assert.equal(flat.ok, true)
  assert.equal(flat.sessionId, 's1')
  assert.equal(flat.firstFailure, null)

  const wrapped = normalizeSessionResult({ ok: true, data: { id: 's2', status: 'failed', firstFailure: { stepId: 'st1', stepTitle: 'T', index: 12, message: 'target-not-found', actionType: 'click' } } }, item)
  assert.equal(wrapped.sessionId, 's2')
  assert.equal(wrapped.ok, false)
  assert.equal(wrapped.firstFailure.stepIndex, 12)
  assert.equal(wrapped.firstFailure.message, 'target-not-found')

  const bare = normalizeSessionResult({}, item)
  assert.equal(bare.status, 'unknown')
  assert.equal(bare.ok, false)
})

test('normalizeSessionResult：信封 ok:true + status:failed 必须判红（防假绿）', () => {
  const item = { testFilePath: 'a.json', caseIds: [], label: 'a.json' }
  // 这是真实陷阱：MCP/HTTP 的外层 ok 表示「调用成功」，不是「用例通过」
  assert.equal(normalizeSessionResult({ ok: true, status: 'failed', sessionId: 's' }, item).ok, false)
  assert.equal(normalizeSessionResult({ ok: true, status: 'blocked', sessionId: 's' }, item).ok, false)
  assert.equal(normalizeSessionResult({ ok: true, data: { status: 'failed' } }, item).ok, false)
  // 反向：status 说 passed 但信封说 ok:false → 同样 fail-closed 到红
  assert.equal(normalizeSessionResult({ ok: false, status: 'passed', sessionId: 's' }, item).ok, false)
  // 只有两者一致（或无信封 ok）才算绿
  assert.equal(normalizeSessionResult({ ok: true, status: 'passed', sessionId: 's' }, item).ok, true)
  assert.equal(normalizeSessionResult({ status: 'passed', sessionId: 's' }, item).ok, true)
})

// ---------- digestRepairContext：字段对齐真实产物 ----------
const RC_LOCATOR = {   // 形状取自真实 repair-context.json（session-20260731-230118）
  failureType: 'locator', status: 'failed',
  firstFailure: { caseId: null, stepId: 'setup-nav-product-manage', stepTitle: '进入开品管理', actionType: 'click', message: 'low-confidence-target' },
  normalizedTarget: { text: '开品管理', name: '开品管理', strategy: 'auto' },
  resolution: { strategy: 'ocr:none', matchedCount: 0, triedStrategies: [], selectedCandidate: null, candidates: [] },
  suggestedPatches: [],
  validateIssues: [{ code: 'missing-login-bootstrap', severity: 'warning', path: 'setup.steps' }],
  evidence: { afterScreenshotPath: 'D:\\out\\after.png' },
}

test('digestRepairContext 摘出定位类关键信息，并在零候选时给出正确指引', () => {
  const d = digestRepairContext(RC_LOCATOR)
  assert.match(d, /failureType=locator/)
  assert.match(d, /setup-nav-product-manage/)
  assert.match(d, /low-confidence-target/)
  assert.match(d, /normalizedTarget/)
  assert.match(d, /matchedCount=0/)
  assert.match(d, /候选元素：0 个/)
  assert.match(d, /DOM 语义字段\/testid 重写 target/)
  assert.match(d, /after\.png/)
  assert.match(d, /红线13/)                     // 提醒先看截图判「产品崩溃 vs 定位漂移」
  assert.doesNotMatch(d, /warnings 0/)
})

test('digestRepairContext 列候选元素、建议补丁、断言 expected/actual，并区分阻断项', () => {
  const d = digestRepairContext({
    firstFailure: { stepId: 's', stepTitle: 'x', message: 'Expected text not found: ¥100.00' },
    resolution: { strategy: 'dom', matchedCount: 3, triedStrategies: ['testid', 'role', 'text'], candidates: [{ testId: 'a' }, { testId: 'b' }, { testId: 'c' }, { testId: 'd' }, { testId: 'e' }, { testId: 'f' }] },
    assertion: { expected: '¥100.00', actual: '¥105.00' },
    suggestedPatches: [{ op: 'replace', path: 'target.testId', value: 'a' }],
    validateIssues: [{ code: 'proof-regression', severity: 'blocking', path: 'cases[0]' }, { code: 'w', severity: 'warning' }],
  })
  assert.match(d, /tried=testid\/role\/text/)
  assert.match(d, /候选元素\(6\)/)
  assert.ok(!d.includes('"testId":"f"'))        // 只列前 5 个
  assert.match(d, /expected=/)
  assert.match(d, /平台建议补丁\(1\)/)
  assert.match(d, /validate 阻断项\(1\)/)
  assert.match(d, /proof-regression/)
})

test('digestRepairContext 空输入与截断', () => {
  assert.equal(digestRepairContext(null), '')
  assert.equal(digestRepairContext('x'), '')
  const long = digestRepairContext({ firstFailure: { stepId: 'a', stepTitle: 'T'.repeat(500), message: 'M'.repeat(500) }, normalizedTarget: { t: 'x'.repeat(500) } }, { maxChars: 120 })
  assert.ok(long.length <= 120 + 40)
  assert.match(long, /截断/)
})

// ---------- buildWakePrompt ----------
test('buildWakePrompt 分列绿红、带摘要、明确禁止 sleep/猜目录', () => {
  const p = buildWakePrompt({
    batchId: 'e2e-abc', elapsedMs: 8 * 60000, concurrency: 3,
    results: [
      { label: 'a.json', ok: true, status: 'passed', sessionId: 's1' },
      { label: 'b.json(c1)', ok: false, status: 'failed', sessionId: 's2', firstFailure: { stepIndex: 12, stepId: 'st', stepTitle: '断言小计', message: 'Expected text not found' }, repairDigest: 'failureType=assertion-false\ncandidates…', reportPath: 'rep.md' },
      { label: 'c.json', ok: false, status: 'error', sessionId: null, error: '硬超时' },
    ],
  })
  assert.match(p, /e2e-abc/)
  assert.match(p, /绿 1 \/ 红 2/)
  assert.match(p, /a\.json/)
  assert.match(p, /step 12/)
  assert.match(p, /failureType=assertion-false/)
  assert.match(p, /硬超时/)
  assert.match(p, /不要用前台 `sleep` 等/)
  assert.match(p, /不要 `ls -1dt` 猜/)
  assert.match(p, /§②\.3\.5/)
})

test('buildWakePrompt 全绿时不出现红段落', () => {
  const p = buildWakePrompt({ batchId: 'b', elapsedMs: 60000, concurrency: 2, results: [{ label: 'a', ok: true, sessionId: 's' }] })
  assert.match(p, /绿 1 \/ 红 0/)
  assert.doesNotMatch(p, /❌ 未通过/)
})

// ---------- isTerminal / extractHandle（平台 v1.4 的 terminal 契约） ----------
test('isTerminal 以 terminal 字段为权威，缺它时按 status 白名单，waitTimedOut 一律非终态', () => {
  assert.equal(isTerminal({ terminal: true, status: 'running' }), true)      // 权威字段说停就停
  assert.equal(isTerminal({ terminal: false, status: 'passed' }), false)
  assert.equal(isTerminal({ status: 'passed' }), true)                        // 老版本无 terminal → 按 status
  assert.equal(isTerminal({ status: 'failed' }), true)
  assert.equal(isTerminal({ status: 'cancelled' }), true)
  assert.equal(isTerminal({ status: 'running' }), false)
  assert.equal(isTerminal({ status: 'pending' }), false)
  assert.equal(isTerminal({ waitTimedOut: true, status: 'running' }), false)  // 有界阻塞到点：会话还在后台跑
  assert.equal(isTerminal({ data: { terminal: true, status: 'failed' } }), true)
})

test('extractHandle 取 sessionId，超时响应走 partial（平台承诺「超时也吐句柄」）', () => {
  assert.equal(extractHandle({ sessionId: 's1' }), 's1')
  assert.equal(extractHandle({ data: { id: 's2' } }), 's2')
  assert.equal(extractHandle({ waitTimedOut: true, partial: { sessionId: 's3', roundId: 'r1' } }), 's3')
  assert.equal(extractHandle({}), null)
})

// ---------- executeBatch：异步提交 + 轮询 terminal ----------
function fakeFetch(routes) {
  return async (url, init = {}) => {
    for (const [re, handler] of routes) if (re.test(url)) return handler(url, init)
    throw new Error('unrouted: ' + url)
  }
}
const jsonResp = (obj, ok = true) => ({ ok, text: async () => JSON.stringify(obj) })
const noSleep = { sleep: async () => { } }

test('executeBatch 异步提交拿句柄 → 轮询到 terminal → 红件自动附 repair-context', async () => {
  const posted = []
  let polls = 0
  const fetchImpl = fakeFetch([
    [/\/test-sessions$/, async (_u, init) => {
      const b = JSON.parse(init.body); posted.push(b)
      return jsonResp({ ok: true, sessionId: 'S-' + b.testFilePath, roundId: 'round-1', status: 'running', terminal: false, mode: 'async' })
    }],
    [/\/test-sessions\/[^/?]+$/, async (u) => {
      polls++
      const id = decodeURIComponent(u.split('/').pop())
      if (polls <= 2) return jsonResp({ sessionId: id, status: 'running', terminal: false })   // 前两轮还在跑
      const fail = id.includes('b.json')
      return jsonResp({ sessionId: id, status: fail ? 'failed' : 'passed', terminal: true, ok: !fail, repairContextPath: 'X:\\rc.json' })
    }],
    [/\/repair-context$/, async () => jsonResp(RC_LOCATOR)],
  ])
  const { items, concurrency } = planBatch([{ testFilePath: 'a.json' }, { testFilePath: 'b.json' }], { concurrency: 2 })
  const prog = []
  const { results } = await executeBatch({ items, concurrency, base: 'http://h:32147/', authProfile: 'localhost-pre', authBootstrap: 'run' },
    { fetchImpl, onProgress: e => prog.push(e), ...noSleep })
  assert.equal(posted[0].wait, false)                       // 异步提交
  assert.equal(posted[0].authProfile, 'localhost-pre')
  assert.equal('reuseBrowser' in posted[0], false)          // 不再强制 false：v1.4 确认会话之间天然隔离，改 false 只会更慢
  assert.equal(results.length, 2)
  assert.equal(results[0].ok, true)
  assert.equal(results[0].sessionId, 'S-a.json')
  assert.equal(results[1].ok, false)
  assert.match(results[1].repairDigest, /low-confidence-target/)
  assert.ok(prog.some(p => p.phase === 'polling'))
})

test('回归防护：有界阻塞在 50s 返回 status:running 时，绝不能判成红件', async () => {
  // 平台 v1.4 把阻塞模式改成服务端设界（默认 50s），到点返回句柄 + waitTimedOut。
  // 旧实现会把这个响应当最终结果 → status=running → 判红；而她的会话中位 170s，等于几乎全部误报。
  let polled = 0
  const fetchImpl = fakeFetch([
    [/\/test-sessions$/, async () => jsonResp({ ok: true, status: 'running', terminal: false, waitTimedOut: true, waitedMs: 50000, partial: { sessionId: 'S-late', roundId: 'round-1' } })],
    [/\/test-sessions\/[^/?]+$/, async () => { polled++; return jsonResp({ sessionId: 'S-late', status: 'passed', terminal: true, ok: true }) }],
  ])
  const { items, concurrency } = planBatch([{ testFilePath: 'slow.json' }])
  const { results } = await executeBatch({ items, concurrency, base: 'http://h' }, { fetchImpl, ...noSleep })
  assert.equal(results[0].ok, true)              // ← 关键：按终态判绿，不是按 50s 那一刻的 running 判红
  assert.equal(results[0].sessionId, 'S-late')   // 句柄从 partial 里捞出来了
  assert.ok(polled >= 1)
})

test('executeBatch 兼容老平台：阻塞 POST 直接返回终态则不轮询', async () => {
  let polled = 0
  const fetchImpl = fakeFetch([
    [/\/test-sessions$/, async () => jsonResp({ ok: true, sessionId: 's', status: 'passed' })],   // 无 terminal 字段
    [/\/test-sessions\/[^/?]+$/, async () => { polled++; return jsonResp({ status: 'passed', terminal: true }) }],
  ])
  const { items, concurrency } = planBatch([{ testFilePath: 'a.json' }])
  const { results } = await executeBatch({ items, concurrency, base: 'http://h' }, { fetchImpl, ...noSleep })
  assert.equal(results[0].ok, true)
  assert.equal(polled, 0)                        // status=passed 已是终态 → 不该多跑一次轮询
})

test('executeBatch 句柄丢失 → 用 list_sessions 反查（取代 ls -1dt 猜目录）', async () => {
  const fetchImpl = fakeFetch([
    [/\/test-sessions\?/, async (u) => { assert.match(u, /testFileId=slow/); return jsonResp({ data: [{ sessionId: 'S-recovered', status: 'running' }] }) }],
    [/\/test-sessions$/, async () => jsonResp({ ok: true, status: 'running', terminal: false })],   // 没给 sessionId
    [/\/test-sessions\/[^/?]+$/, async () => jsonResp({ sessionId: 'S-recovered', status: 'failed', terminal: true, ok: false })],
  ])
  const { items, concurrency } = planBatch([{ testFilePath: 'v519/slow.json' }])
  const { results } = await executeBatch({ items, concurrency, base: 'http://h' }, { fetchImpl, ...noSleep })
  assert.equal(results[0].sessionId, 'S-recovered')
  assert.equal(results[0].ok, false)
})

test('executeBatch 轮询到 deadline 仍未终态 → 报 timeout 但**带着句柄**（绝不丢）', async () => {
  const fetchImpl = fakeFetch([
    [/\/test-sessions$/, async () => jsonResp({ ok: true, sessionId: 'S-stuck', status: 'running', terminal: false })],
    [/\/test-sessions\/[^/?]+$/, async () => jsonResp({ sessionId: 'S-stuck', status: 'running', terminal: false })],
  ])
  const { items, concurrency } = planBatch([{ testFilePath: 'stuck.json' }])
  let t = 0
  const { results } = await executeBatch({ items, concurrency, base: 'http://h', sessionTimeoutMs: 30 },
    { fetchImpl, sleep: async () => { t += 20 }, now: () => t })
  assert.equal(results[0].status, 'timeout')
  assert.equal(results[0].ok, false)
  assert.equal(results[0].sessionId, 'S-stuck')        // ← 句柄必须留着，否则回捞无从下手
  assert.match(results[0].error, /get_run_summary|cancel_run/)
})

// ---------- 2026-10-27 提效改造 ----------
test('planBatch 排序：caseIds 修复项 → 整文件 → RED 校准', () => {
  const p = planBatch([
    { testFilePath: 'v/x-RED.json' },
    { testFilePath: 'v/full.json' },
    { testFilePath: 'v/fix.json', caseIds: ['c1'] },
  ])
  assert.deepEqual(p.items.map(i => i.testFilePath), ['v/fix.json', 'v/full.json', 'v/x-RED.json'])
})

test('executeBatch 把会话超时与空闲超时下发给猪猪（按粒度）', async () => {
  const posted = []
  const fetchImpl = fakeFetch([[/\/test-sessions$/, async (_u, init) => { posted.push(JSON.parse(init.body)); return jsonResp({ ok: true, sessionId: 's', status: 'passed', terminal: true }) }]])
  const { items, concurrency } = planBatch([{ testFilePath: 'a.json' }, { testFilePath: 'b.json', caseIds: ['c'] }])
  await executeBatch({ items, concurrency, base: 'http://h' }, { fetchImpl, ...noSleep })
  const byPath = Object.fromEntries(posted.map(b => [b.testFilePath, b]))
  assert.equal(byPath['a.json'].sessionTimeoutMs, FILE_SESSION_TIMEOUT_MS)
  assert.equal(byPath['b.json'].sessionTimeoutMs, CASE_SESSION_TIMEOUT_MS)
  assert.equal(byPath['a.json'].sessionIdleTimeoutMs, SESSION_IDLE_TIMEOUT_MS)
})

test('executeBatch 轮询到点 → 主动 POST cancel，不留僵尸会话', async () => {
  const cancels = []
  const fetchImpl = fakeFetch([
    [/\/cancel$/, async (u) => { cancels.push(u); return jsonResp({ ok: true, cancelled: true }) }],
    [/\/test-sessions$/, async () => jsonResp({ ok: true, sessionId: 'S-z', status: 'running', terminal: false })],
    [/\/test-sessions\/[^/?]+$/, async () => jsonResp({ sessionId: 'S-z', status: 'running', terminal: false })],
  ])
  const { items, concurrency } = planBatch([{ testFilePath: 'z.json' }])
  let t = 0
  const { results } = await executeBatch({ items, concurrency, base: 'http://h', sessionTimeoutMs: 30 },
    { fetchImpl, sleep: async () => { t += 60_000 }, now: () => t })
  assert.equal(results[0].status, 'timeout')
  assert.equal(cancels.length, 1)
  assert.match(cancels[0], /S-z\/cancel$/)
  assert.match(results[0].error, /已主动取消/)
})

test('executeBatch isCancelled：在跑的会话被取消、未开跑的项直接跳过', async () => {
  let cancelled = false
  const cancels = []
  let submits = 0
  const fetchImpl = fakeFetch([
    [/\/cancel$/, async (u) => { cancels.push(u); return jsonResp({ ok: true }) }],
    [/\/test-sessions$/, async () => { submits++; return jsonResp({ ok: true, sessionId: 'S' + submits, status: 'running', terminal: false }) }],
    [/\/test-sessions\/[^/?]+$/, async () => { cancelled = true; return jsonResp({ status: 'running', terminal: false }) }],
  ])
  const { items } = planBatch([{ testFilePath: 'a.json' }, { testFilePath: 'b.json' }])
  const { results } = await executeBatch({ items, concurrency: 1, base: 'http://h' }, { fetchImpl, ...noSleep, isCancelled: () => cancelled })
  assert.equal(submits, 1)
  assert.equal(cancels.length, 1)
  assert.deepEqual(results.map(r => r.status), ['cancelled', 'cancelled'])
})

test('readCaseOutcomes 从 round aggregate 取逐 case 结果；唤起消息给出只跑红 case 的入参', () => {
  const agg = { caseResults: [
    { caseId: 'c1', result: { ok: false, telemetry: { durationMs: 60_000 } } },
    { caseId: 'c2', result: { ok: true, telemetry: { durationMs: 120_000 } } },
  ] }
  const cases = readCaseOutcomes({ data: { rounds: [{ aggregatePath: '/x/aggregate.json' }] } }, (p) => { assert.equal(p, '/x/aggregate.json'); return agg })
  assert.deepEqual(cases.map(c => [c.caseId, c.ok]), [['c1', false], ['c2', true]])
  const prompt = buildWakePrompt({ batchId: 'b', elapsedMs: 1, concurrency: 1, results: [
    { label: 'v/f.json', testFilePath: 'v/f.json', ok: false, status: 'failed', sessionId: 's', cases,
      repeats: [{ caseId: 'c1', stepKey: 'step-9', count: 2 }] },
  ] })
  assert.match(prompt, /"caseIds":\["c1"\]/)
  assert.match(prompt, /2\.0min 纯浪费/)
  assert.match(prompt, /同一处第 2 次红/)
})

test('executeBatch 单次轮询失败不放弃，下一轮继续', async () => {
  let n = 0
  const fetchImpl = fakeFetch([
    [/\/test-sessions$/, async () => jsonResp({ ok: true, sessionId: 's', status: 'running', terminal: false })],
    [/\/test-sessions\/[^/?]+$/, async () => { n++; if (n === 1) throw new Error('ECONNRESET'); return jsonResp({ status: 'passed', terminal: true, ok: true }) }],
  ])
  const { items, concurrency } = planBatch([{ testFilePath: 'a.json' }])
  const { results } = await executeBatch({ items, concurrency, base: 'http://h' }, { fetchImpl, ...noSleep })
  assert.equal(results[0].ok, true)
  assert.equal(n, 2)
})

test('executeBatch 显式传 reuseBrowser 才带该字段', async () => {
  const posted = []
  const fetchImpl = fakeFetch([[/\/test-sessions$/, async (_u, init) => { posted.push(JSON.parse(init.body)); return jsonResp({ ok: true, sessionId: 's', status: 'passed', terminal: true }) }]])
  const { items, concurrency } = planBatch([{ testFilePath: 'a.json' }])
  await executeBatch({ items, concurrency, base: 'http://h', reuseBrowser: false }, { fetchImpl, ...noSleep })
  assert.equal(posted[0].reuseBrowser, false)
})

test('executeBatch 提交异常 → 落 error 且提示用 list_sessions 反查', async () => {
  const fetchImpl = fakeFetch([[/\/test-sessions$/, async () => { throw new Error('The operation was aborted due to timeout') }]])
  const { items, concurrency } = planBatch([{ testFilePath: 'a.json' }])
  const { results } = await executeBatch({ items, concurrency, base: 'http://h' }, { fetchImpl, ...noSleep })
  assert.equal(results[0].ok, false)
  assert.match(results[0].error, /list_sessions/)
})

test('executeBatch 缺 fetchImpl 直接报错（别静默什么都不做）', async () => {
  const { items, concurrency } = planBatch([{ testFilePath: 'a.json' }])
  await assert.rejects(() => executeBatch({ items, concurrency, base: 'http://h' }, {}), /fetchImpl/)
})


// ---------- 巡检钩子（§3.123）：批次跑完点名**绿件**去巡检 ----------
test('唤醒消息点名绿件的 session 跑 page_scan（红件不点——它已带 repair-context）', () => {
  const p = buildWakePrompt({
    batchId: 'e2e-scan', elapsedMs: 60000, concurrency: 2,
    results: [
      { label: 'g1.json', ok: true, status: 'passed', sessionId: 'sess-green-1' },
      { label: 'g2.json', ok: true, status: 'passed', sessionId: 'sess-green-2' },
      { label: 'r1.json', ok: false, status: 'failed', sessionId: 'sess-red-1', repairDigest: 'failureType=x' },
    ],
  })
  assert.match(p, /页面一眼巡检/)
  assert.match(p, /page_scan\(\{sessionId: "sess-green-1"\}\)/)
  assert.match(p, /page_scan\(\{sessionId: "sess-green-2"\}\)/)
  assert.ok(!p.includes('page_scan({sessionId: "sess-red-1"})'), '红件不该被点名巡检')
  assert.match(p, /为什么是绿件/)
  assert.match(p, /基本不阻塞你继续测/)
})
test('全红时不出巡检段（没有绿件可巡）', () => {
  const p = buildWakePrompt({
    batchId: 'e2e-allred', elapsedMs: 1000, concurrency: 1,
    results: [{ label: 'r.json', ok: false, status: 'failed', sessionId: 's1' }],
  })
  assert.ok(!p.includes('页面一眼巡检'))
})
test('绿件没有 sessionId 时不点名（取不到图，点了也是空跑）', () => {
  const p = buildWakePrompt({
    batchId: 'e2e-nosess', elapsedMs: 1000, concurrency: 1,
    results: [{ label: 'g.json', ok: true, status: 'passed', sessionId: null }],
  })
  assert.ok(!p.includes('页面一眼巡检'))
})

test('全机槽位：注入 acquire 时每项先拿号再跑、跑完归还（2026-09-30 整机内存耗尽事故）', async () => {
  const { executeBatch } = await import('../e2e-batch.js')
  let active = 0, peak = 0, released = 0
  const acquire = async () => { active++; peak = Math.max(peak, active); return () => { active--; released++ } }
  const fetchImpl = async () => ({ ok: true, text: async () => JSON.stringify({ sessionId: 's', status: 'passed', terminal: true }) })
  const items = ['a', 'b', 'c', 'd'].map(x => ({ testFilePath: `${x}.json`, caseIds: [], scope: 'all', label: x }))
  const out = await executeBatch({ items, concurrency: 2, base: 'http://x' }, { fetchImpl, acquire })
  assert.equal(out.results.length, 4)
  assert.equal(released, 4, '每一项都归还了槽位')
  assert.ok(peak <= 2)
})

// ---------- 2026-10-27 修：首个失败/摘要恒空 + RED 校准判定 ----------
test('normalizeSessionResult 从 summary / 最后一轮取 firstFailure、failureType、repairContextPath（猪猪轮询响应形状）', () => {
  const raw = { ok: true, summary: { status: 'failed', failureType: 'assertion-false', firstFailure: { caseId: 'c1', stepId: 's9', message: 'm' } },
    data: { id: 'S', status: 'failed', rounds: [{ failureType: 'x' }, { failureType: 'assertion-false', repairContextPath: '/r/rc.json', firstFailure: { caseId: 'c1' } }] } }
  const r = normalizeSessionResult(raw, { label: 'a', testFilePath: 'a.json', caseIds: [] })
  assert.equal(r.failureType, 'assertion-false')
  assert.equal(r.firstFailure.caseId, 'c1')
  assert.equal(r.firstFailure.stepId, 's9')
  assert.equal(r.repairContextPath, '/r/rc.json')
})

test('executeBatch 解包猪猪 repair-context 响应 {ok, data:{json}} 生成摘要', async () => {
  const fetchImpl = fakeFetch([
    [/repair-context$/, async () => jsonResp({ ok: true, data: { session: {}, latest: {}, artifactPath: '/p', json: { failureType: 'assertion-false', firstFailure: { stepId: 'z1', message: 'boom' } } } })],
    [/\/test-sessions$/, async () => jsonResp({ ok: true, sessionId: 'S', status: 'failed', terminal: true })],
  ])
  const { items, concurrency } = planBatch([{ testFilePath: 'a.json' }])
  const { results } = await executeBatch({ items, concurrency, base: 'http://h' }, { fetchImpl, ...noSleep })
  assert.match(results[0].repairDigest, /failureType=assertion-false/)
  assert.match(results[0].repairDigest, /z1/)
})

test('RED 校准判定：断言失败=如期红；其它红=无效红；跑绿=意外通过；唤起消息单独成段且不计入绿/红', () => {
  const mk = (status, failureType) => ({ label: 'v/x-RED.json', testFilePath: 'v/x-RED.json', status, ok: status === 'passed', failureType, sessionId: 's' })
  assert.equal(redCalibrationVerdict(mk('failed', 'assertion-false')).ok, true)
  assert.equal(redCalibrationVerdict(mk('failed', 'page-error')).kind, 'invalid-red')
  assert.equal(redCalibrationVerdict(mk('passed')).kind, 'unexpected-pass')
  assert.equal(redCalibrationVerdict({ testFilePath: 'v/x.json', status: 'failed' }), null)
  const prompt = buildWakePrompt({ batchId: 'b', elapsedMs: 1, concurrency: 1, results: [
    { label: 'v/ok.json', testFilePath: 'v/ok.json', status: 'passed', ok: true, sessionId: 's' },
    mk('failed', 'assertion-false'), { ...mk('failed', 'page-error'), label: 'v/y-RED.json', testFilePath: 'v/y-RED.json' },
  ] })
  assert.match(prompt, /绿 1 \/ 红 0。RED 校准 2：如期红 1 \/ 异常 1。/)
  assert.match(prompt, /🎯 RED 校准/)
  assert.match(prompt, /v\/y-RED\.json　verdict=无效红/)
})
