// 抄送(cc)汇合闸回归测试。
// 缘起 2026-09-01 事故（发起 run 20260901063554-dc604c 菲菲「REQ-0326~0330 三方会审」）：
//   菲菲 cc 双发技术体检(GG Bond)/可测性体检(迷糊)后收工，自述「两人完成时看板会通知我」——引擎没有这个机制。
//   cc 子 run 是 callerRunId=null（cc 不回发），ccFrom 只用于记流水，扇出的终点悬空；两人各自收工，
//   小呆呆三条巡视分别判「合法收工」（各自都判对了），没有任何一轮的视角是「汇合点没人接」→ 47 个 facet
//   永久卡在「_待菲菲汇总_」。本测试把「谁 cc 出去、引擎负责在扇出全部收工那刻唤回他」钉死。
// server.js 是自启服务的单体（import 即 listen），故按名从源码抠出这几个函数 eval 后测（同 spin-and-patrol.test.js 口径）。
// 抠不到就抛错（不静默测空壳），源码重构改了函数名/签名时本测试会立刻红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
function grab(name, re) {
  const m = src.match(re)
  if (!m) throw new Error(`抠不到 ${name}：server.js 结构变了，请同步更新 test/cc-join.test.js`)
  return m[0]
}
const PIECES = [
  grab('CC_JOIN_MAX_FIRES', /^const CC_JOIN_MAX_FIRES = .*$/m),
  grab('MARKER_LINE_RE', /^const MARKER_LINE_RE = .*$/m),
  grab('lastMarkerBlock', /^function lastMarkerBlock\(text, headRe\) \{[\s\S]*?\n\}/m),
  grab('parseNextHop', /^function parseNextHop\(result\) \{[\s\S]*?\n\}/m),
  grab('parseReturnHop', /^function parseReturnHop\(result\) \{[\s\S]*?\n\}/m),
  grab('isTerminalRun', /^const isTerminalRun = .*$/m),
  grab('ccQueuedFor', /^const ccQueuedFor = .*$/m),
  grab('bindCcChild', /^function bindCcChild\(senderRun, childRun\) \{[\s\S]*?\n\}/m),
  grab('tryFireCcJoin', /^function tryFireCcJoin\(sender\) \{[\s\S]*?\n\}/m),
  grab('notifyCcOrigins', /^function notifyCcOrigins\(child\) \{[\s\S]*?\n\}/m),
  grab('sweepCcJoins', /^function sweepCcJoins\(\) \{[\s\S]*?\n\}/m),
]

// 每个用例一套干净的假引擎：runs / pendingQueues / liveRuns(用 busyEmployee 代) + 记录副作用
function makeEngine() {
  const calls = { sendToRun: [], queuePending: [], broadcast: [], events: [], conversations: [], saves: 0 }
  const ctx = vm.createContext({
    console,
    runs: {},
    pendingQueues: {},
    EMPLOYEES: { feifei: { displayName: '菲菲' }, ggbond: { displayName: 'GG Bond' }, mihu: { displayName: '迷糊老师' } },
    stallGuard: { renderResumeSnapshot: () => '「进度快照」\n' },
    saveRegistry: () => { calls.saves++ },
    logConversation: c => calls.conversations.push(c),
    broadcast: e => calls.broadcast.push(e),
    emitHandoff: e => calls.broadcast.push({ type: 'handoff', ...e }),
    appendEvent: (id, e) => calls.events.push({ id, ...e }),
    sendToRun: (run, prompt, opts) => { calls.sendToRun.push({ runId: run.id, prompt, opts }); run.status = 'running' },
    queuePending: (emp, item) => { calls.queuePending.push({ emp, item }); (ctx.pendingQueues[emp] ||= []).push(item) },
    busyRunFor: emp => ctx.busyEmployee === emp ? { id: 'other-run' } : null,
    busyEmployee: null,
  })
  vm.runInContext(`${PIECES.join('\n')}
globalThis.__api = { bindCcChild, tryFireCcJoin, notifyCcOrigins, sweepCcJoins, ccQueuedFor, isTerminalRun, CC_JOIN_MAX_FIRES }`, ctx)
  const api = vm.runInContext('__api', ctx)
  const mk = (id, employee, status, extra = {}) => (ctx.runs[id] = {
    id, employee, status, sessionId: 'sess-' + id, result: '（收尾汇报）', threadRootId: 'root-1',
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra,
  })
  return { ctx, calls, api, mk }
}

// ---------- 事故重演：这条路径以前是死的 ----------
test('事故重演：cc 双发的两人全部收工 → 发起人被唤回收口（20260901063554-dc604c）', () => {
  const { ctx, calls, api, mk } = makeEngine()
  const feifei = mk('20260901063554-dc604c', 'feifei', 'running')
  const gg = mk('20260901065038-18c917', 'ggbond', 'running')
  const mihu = mk('20260901065101-80a036', 'mihu', 'running')
  api.bindCcChild(feifei, gg)
  api.bindCcChild(feifei, mihu)
  assert.deepEqual([...feifei.ccChildren].map(c => c.employee), ['ggbond', 'mihu'])   // 跨 vm realm：铺回宿主数组再比
  assert.deepEqual([...gg.ccOriginRunIds], [feifei.id])

  // 菲菲先收工（等两人），此刻两人还在跑 → 不该唤
  feifei.status = 'done'
  feifei.result = '五条会审已并行发起。\n\n【等你拍板】无'
  assert.equal(api.tryFireCcJoin(feifei), false, '子 run 还在跑就唤回 = 提前收口')

  // 迷糊先收工 → 仍差 GG Bond，不该唤
  mihu.status = 'done'; mihu.result = '可测性体检已全部落档。\n\n【等你拍板】无'
  assert.equal(api.notifyCcOrigins(mihu), false)
  assert.equal(calls.sendToRun.length, 0)

  // GG Bond 最后收工 → 汇合成立，唤回菲菲
  gg.status = 'done'; gg.result = '全部完成。技术体检五条判档已填入会审记录。'
  assert.equal(api.notifyCcOrigins(gg), true, '最后一个子 run 收工时必须唤回发起人')
  assert.equal(calls.sendToRun.length, 1)
  const fired = calls.sendToRun[0]
  assert.equal(fired.runId, feifei.id, '唤的必须是发起人那条会话（保上下文），不是新起会话')
  assert.equal(fired.opts.resume, true)
  assert.match(fired.prompt, /抄送汇合/)
  assert.match(fired.prompt, /GG Bond/)
  assert.match(fired.prompt, /迷糊老师/)
  assert.match(fired.prompt, /技术体检五条判档已填入会审记录/, '摘要要带各自收尾原文尾部，发起人才判得动')
  assert.match(fired.prompt, /进度快照/, '同巡视续跑口径：注回进度快照，别让它从头重来')
  assert.ok(feifei.ccJoinFiredAt, '汇合已触发要落持久标记')
  assert.equal(feifei.ccJoinFires, 1)
  assert.ok(calls.broadcast.some(e => e.type === 'handoff' && e.kind === 'cc-join' && e.runId === feifei.id))
  assert.ok(calls.conversations.some(c => c.to === 'feifei' && /抄送汇合/.test(c.text)), '会话看板要能看到这一跳')

  // 幂等：同一轮扇出不重复唤
  assert.equal(api.notifyCcOrigins(gg), false)
  assert.equal(api.tryFireCcJoin(feifei), false)
  assert.equal(calls.sendToRun.length, 1)
})

test('再 cc 一轮 → 重新武装，可再次汇合', () => {
  const { calls, api, mk } = makeEngine()
  const sender = mk('s1', 'feifei', 'done')
  const c1 = mk('c1', 'ggbond', 'done')
  api.bindCcChild(sender, c1)
  assert.equal(api.tryFireCcJoin(sender), true)
  assert.equal(sender.status, 'running', '唤回＝把发起人跑起来')
  const c2 = mk('c2', 'mihu', 'running')     // 它被唤回后又 cc 了一个人
  api.bindCcChild(sender, c2)
  assert.equal(sender.ccJoinFiredAt, null, '新扇出要把汇合闸重新武装')
  assert.equal(api.tryFireCcJoin(sender), false, 'c2 还在跑')
  sender.status = 'done'                     // 发起人这一轮也收工了，继续等 c2
  c2.status = 'done'
  assert.equal(api.notifyCcOrigins(c2), true)
  assert.equal(calls.sendToRun.length, 2)
  assert.equal(sender.ccJoinFires, 2)
})

test('cc 还扣在待处理队列里（目标忙于别的任务线）→ 不算扇出到齐', () => {
  const { ctx, api, mk } = makeEngine()
  const sender = mk('s1', 'feifei', 'done')
  const c1 = mk('c1', 'ggbond', 'done')
  api.bindCcChild(sender, c1)
  ctx.pendingQueues.mihu = [{ id: 'pend-1', kind: 'cc', ccJoinOrigin: 's1', instruction: '…' }]
  assert.equal(api.ccQueuedFor('s1'), 1)
  assert.equal(api.tryFireCcJoin(sender), false, '还有 cc 没变成 run 就唤回 = 漏掉一个人的产出')
  ctx.pendingQueues.mihu = []   // 队列投递出去后由 drainPending 回绑（此处等价为已起 run 并收工）
  const c2 = mk('c2', 'mihu', 'done')
  api.bindCcChild(sender, c2)
  assert.equal(api.tryFireCcJoin(sender), true)
})

test('发起人已把棒交出去（【下一棒】/【交回】）→ 不唤，避免同线并发第二条 run', () => {
  const { api, mk } = makeEngine()
  for (const [tag, result] of [['下一棒', '干完了\n\n【下一棒】GG Bond｜开工实施'], ['交回', '干完了\n\n【交回】结果如下：…']]) {
    const { api: a, mk: m, calls } = makeEngine()
    const sender = m('s-' + tag, 'feifei', 'done', { result })
    const kid = m('k-' + tag, 'ggbond', 'done')
    a.bindCcChild(sender, kid)
    assert.equal(a.tryFireCcJoin(sender), false, `发起人写了【${tag}】仍被唤回 = 同一条线并发两条 run`)
    assert.equal(calls.sendToRun.length, 0)
  }
  // 反面：只写了【等你拍板】无 / 什么都没写 → 该唤（这正是事故形态）
  const sender = mk('s2', 'feifei', 'done', { result: '会审已发起。\n\n【等你拍板】无' })
  api.bindCcChild(sender, mk('k2', 'mihu', 'done'))
  assert.equal(api.tryFireCcJoin(sender), true)
})

test('发起人还在跑 / 该员工忙在别的会话 → 先不唤，定时兜底 sweep 之后能捞回来', () => {
  const { ctx, calls, api, mk } = makeEngine()
  const sender = mk('s1', 'feifei', 'running')
  const kid = mk('c1', 'ggbond', 'done')
  api.bindCcChild(sender, kid)
  assert.equal(api.notifyCcOrigins(kid), false, '发起人自己还在跑，不需要唤')

  sender.status = 'done'
  ctx.busyEmployee = 'feifei'     // 它已收工，但该员工正忙在另一条会话（共用工作树，不能并发）
  assert.equal(api.tryFireCcJoin(sender), false)
  assert.equal(calls.sendToRun.length, 0)

  ctx.busyEmployee = null         // 空出来了 → 定时兜底扫到
  api.sweepCcJoins()
  assert.equal(calls.sendToRun.length, 1, 'busy 分支没有二次触发点，必须靠 sweepCcJoins 兜底')
})

test('sweep 只捞近 24h 内武装中的扇出，不复活陈旧会话', () => {
  const { calls, api, mk } = makeEngine()
  const old = new Date(Date.now() - 30 * 60 * 60_000).toISOString()
  const sender = mk('s1', 'feifei', 'done', { updatedAt: old })
  api.bindCcChild(sender, mk('c1', 'ggbond', 'done'))
  sender.updatedAt = old   // bindCcChild 不改 updatedAt，这里显式压回陈旧值
  api.sweepCcJoins()
  assert.equal(calls.sendToRun.length, 0)
})

test('老板亲手按停的会话不自动唤回（人为中止意图优先）', () => {
  const { calls, api, mk } = makeEngine()
  const sender = mk('s1', 'feifei', 'interrupted', { userStoppedAt: new Date().toISOString() })
  api.bindCcChild(sender, mk('c1', 'ggbond', 'done'))
  assert.equal(api.tryFireCcJoin(sender), false)
  api.sweepCcJoins()
  assert.equal(calls.sendToRun.length, 0)
})

test('子 run 异常终态（error/interrupted）也算到齐——摘要带状态，由发起人判要不要重派', () => {
  const { calls, api, mk } = makeEngine()
  const sender = mk('s1', 'feifei', 'done')
  api.bindCcChild(sender, mk('c1', 'ggbond', 'error', { result: '❌ 会话异常结束' }))
  api.bindCcChild(sender, mk('c2', 'mihu', 'interrupted', { result: '' }))
  assert.equal(api.tryFireCcJoin(sender), true, '子 run 死法不好看不能成为永远不唤发起人的理由')
  const prompt = calls.sendToRun[0].prompt
  assert.match(prompt, /状态 error/)
  assert.match(prompt, /状态 interrupted/)
  assert.match(prompt, /无收尾汇报/)
})

test('发起会话已不可 resume（无 sessionId）→ 转新会话投递，不静默丢结果', () => {
  const { calls, api, mk } = makeEngine()
  const sender = mk('s1', 'feifei', 'done', { sessionId: null })
  api.bindCcChild(sender, mk('c1', 'ggbond', 'done'))
  assert.equal(api.tryFireCcJoin(sender), true)
  assert.equal(calls.sendToRun.length, 0)
  assert.equal(calls.queuePending.length, 1)
  assert.equal(calls.queuePending[0].emp, 'feifei')
  assert.match(calls.queuePending[0].item.instruction, /抄送汇合·转新会话/)
})

test('汇合唤回有上限（防「唤回→再 cc→再唤回」失控）', () => {
  const { calls, api, mk } = makeEngine()
  const sender = mk('s1', 'feifei', 'done')
  for (let i = 0; i < api.CC_JOIN_MAX_FIRES + 3; i++) {
    sender.status = 'done'                                   // 上一次唤回把它跑起来了，这里代表它又收工
    api.bindCcChild(sender, mk('c' + i, 'ggbond', 'done'))   // 每次新 cc 都重新武装
    api.tryFireCcJoin(sender)
  }
  assert.equal(calls.sendToRun.length, api.CC_JOIN_MAX_FIRES)
})

test('同一条会话被两人 cc → 各自的扇出独立汇合', () => {
  const { calls, api, mk } = makeEngine()
  const a = mk('sa', 'feifei', 'done')
  const b = mk('sb', 'mihu', 'done')
  const kid = mk('k', 'ggbond', 'done')
  api.bindCcChild(a, kid)
  api.bindCcChild(b, kid)
  assert.deepEqual([...kid.ccOriginRunIds], ['sa', 'sb'])
  assert.equal(api.notifyCcOrigins(kid), true)
  assert.deepEqual(calls.sendToRun.map(c => c.runId).sort(), ['sa', 'sb'])
})

test('没 cc 过的 run 不受影响（零副作用）', () => {
  const { calls, api, mk } = makeEngine()
  const plain = mk('p1', 'ggbond', 'done')
  assert.equal(api.tryFireCcJoin(plain), false)
  assert.equal(api.notifyCcOrigins(plain), false)
  api.sweepCcJoins()
  assert.equal(calls.sendToRun.length, 0)
  assert.equal(calls.queuePending.length, 0)
})
