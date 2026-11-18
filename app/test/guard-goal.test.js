// 守航目标循环（v0.11.0）：链停了、活没干完 → 引擎接着派人。这里钉死判据：
// 什么算做完 / 什么算等老板 / 什么时候不许续（有人在跑、报错、老板按停、到点、超轮数、连续没进展）。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as goal from '../guard-goal.js'
import * as card from '../acceptance-card.js'
import { emptyLedger, parseContract } from '../guard-ledger.js'

const future = new Date(Date.now() + 8 * 3600_000).toISOString()
const past = new Date(Date.now() - 3600_000).toISOString()
const named = (items, extra = {}) => ({ selection: { source: 'boss_named', named_items: items, max_items: items.length }, deadline: future, goal: { loop: 'active', max_goal_turns: 8 }, limits: { max_tokens: 2000000 }, ...extra })
const L = () => card.ensureStores(emptyLedger('t'))
const fullCard = (l, req) => card.upsertCard(l, req, { summary: 's', noUi: '纯后端', impactNone: '无' })

test('契约没有 goal 块（旧契约）→ 影子模式；全局开关关 → off', () => {
  assert.equal(goal.goalModeOf({}), 'shadow')
  assert.equal(goal.goalModeOf({ goal: { loop: 'active' } }), 'active')
  assert.equal(goal.goalModeOf({ goal: { loop: 'active' } }, { globalEnabled: false }), 'off')
})

test('契约 yaml 的 goal 块能被解析（两级 map）', () => {
  const c = parseContract('```yaml\ngoal:\n  loop: active            # 注释\n  max_goal_turns: 6\n```')
  assert.equal(c.goal.loop, 'active')
  assert.equal(c.goal.max_goal_turns, 6)
})

test('09-18 guarded-01 的形状：点名 3 条只做完 1 条 → 判「还没干完」并派人，而不是收工', () => {
  const l = L()
  l.itemResults = { 'REQ-0342': { result: 'rc_ready' }, 'REQ-0352': { result: 'parked', stopWhy: 'A/B 样式待业务同事乙定' }, 'REQ-0353': { result: 'parked', stopWhy: '超 max_changed_repositories:2' } }
  fullCard(l, 'REQ-0342')
  const ev = goal.evaluateGoal({ contract: named(['REQ-0342', 'REQ-0352', 'REQ-0353']), ledger: l, mode: 'active' })
  assert.equal(ev.verdict, 'continue')
  assert.equal(ev.next.owner, 'feifei', '普通 park（不是只有老板能定的）交回菲菲按三种不确定重判')
  assert.deepEqual(ev.next.items.map(i => i.req), ['REQ-0352', 'REQ-0353'])
})

test('全部做完且验收卡齐 → met；有条目在等老板拍高危 → waiting_boss（不再续）', () => {
  const l = L()
  l.itemResults = { 'REQ-0001': { result: 'rc_ready' }, 'REQ-0002': { result: 'rc_ready' } }
  fullCard(l, 'REQ-0001'); fullCard(l, 'REQ-0002')
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0001', 'REQ-0002']), ledger: l, mode: 'active' }).verdict, 'met')
  l.itemResults['REQ-0002'] = { result: 'parked', needsBoss: true, stopWhy: '要改线上表结构' }
  card.raiseRisk(l, { req: 'REQ-0002', what: '改表结构', why: '加列', options: ['照做'] })
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0001', 'REQ-0002']), ledger: l, mode: 'active' }).verdict, 'waiting_boss')
})

test('测完了但验收卡没补齐 → 不算做完，派人补卡（缺截图派迷糊）', () => {
  const l = L()
  l.itemResults = { 'REQ-0001': { result: 'rc_ready' } }
  card.upsertCard(l, 'REQ-0001', { summary: '多了一列', impactNone: '无' })
  const ev = goal.evaluateGoal({ contract: named(['REQ-0001']), ledger: l, mode: 'active' })
  assert.equal(ev.verdict, 'continue')
  assert.equal(ev.next.owner, 'mihu')
  assert.equal(ev.next.items[0].need, 'card')
})

test('看板状态驱动派给谁：在测 → 迷糊；在开发/被打回 → GG Bond', () => {
  const l = L()
  l.itemResults = { 'REQ-0001': { result: 'in_progress' }, 'REQ-0002': { result: 'in_progress' } }
  const e1 = new Map([['REQ-0001', { status: '待测' }], ['REQ-0002', { status: '待测' }]])
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0001', 'REQ-0002']), ledger: l, entries: e1, mode: 'active' }).next.owner, 'mihu')
  const e2 = new Map([['REQ-0001', { status: '打回' }], ['REQ-0002', { status: '开发中' }]])
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0001', 'REQ-0002']), ledger: l, entries: e2, mode: 'active' }).next.owner, 'ggbond')
})

test('链上还有人在跑 / 在等后台任务 → wait；上一棒报错或老板按停 → paused（不自动续）', () => {
  const l = L()
  const c = named(['REQ-0001'])
  assert.equal(goal.evaluateGoal({ contract: c, ledger: l, mode: 'active', liveness: { busy: true } }).verdict, 'wait')
  assert.equal(goal.evaluateGoal({ contract: c, ledger: l, mode: 'active', liveness: { bgWaiting: 'E2E 批次' } }).verdict, 'wait')
  assert.equal(goal.evaluateGoal({ contract: c, ledger: l, mode: 'active', liveness: { errored: true } }).verdict, 'paused')
  assert.equal(goal.evaluateGoal({ contract: c, ledger: l, mode: 'active', liveness: { userStopped: true } }).verdict, 'paused')
})

test('到点 / 超续跑轮数 / 超 token 参考顶 → budget_limited', () => {
  const l = L()
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0001'], { deadline: past }), ledger: l, mode: 'active' }).verdict, 'budget_limited')
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0001']), ledger: l, mode: 'active', goal: { turns: 8 } }).verdict, 'budget_limited')
  l.usage.tokens = 3_000_000
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0001']), ledger: l, mode: 'active' }).verdict, 'budget_limited')
})

test('连续 3 次续跑局面没变 → blocked；有进展就清零', () => {
  const l = L()
  l.itemResults = { 'REQ-0001': { result: 'in_progress' } }
  const sig = goal.progressSignature({ reqs: ['REQ-0001'], ledger: l })
  let g = {}
  g = goal.noteContinuation(g, sig); assert.equal(g.noProgress, 0)
  g = goal.noteContinuation(g, sig); assert.equal(g.noProgress, 1)
  g = goal.noteContinuation(g, sig); g = goal.noteContinuation(g, sig); assert.equal(g.noProgress, 3)
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0001']), ledger: l, mode: 'active', goal: g }).verdict, 'blocked')
  card.upsertCard(l, 'REQ-0001', { summary: '有进展了' })
  const sig2 = goal.progressSignature({ reqs: ['REQ-0001'], ledger: l })
  assert.notEqual(sig2, sig)
  g = goal.noteContinuation(g, sig2); assert.equal(g.noProgress, 0)
})

test('planContinuation：派之前核指纹——连着没推进就改判 blocked、不派', () => {
  const l = L()
  l.itemResults = { 'REQ-0001': { result: 'in_progress' } }
  const c = named(['REQ-0001'])
  const sig = goal.progressSignature({ reqs: ['REQ-0001'], ledger: l })
  let g = {}
  for (let i = 0; i < 3; i++) {
    const ev = goal.evaluateGoal({ contract: c, ledger: l, mode: 'active', goal: g })
    const p = goal.planContinuation(ev, g, sig)
    assert.equal(p.dispatch, true, `第 ${i + 1} 次还该派`)
    g = p.goal
  }
  const ev = goal.evaluateGoal({ contract: c, ledger: l, mode: 'active', goal: g })
  const p = goal.planContinuation(ev, g, sig)
  assert.equal(p.dispatch, false)
  assert.equal(p.ev.verdict, 'blocked')
  assert.equal(p.goal.turns, g.turns, '判卡住那次不计入续跑轮数')
})

test('老板动手 → 清零轮数与无进展计数', () => {
  const g = goal.resetGoal({ turns: 8, noProgress: 3, lastDispatchSig: 'x' }, '老板打回')
  assert.equal(g.turns, 0); assert.equal(g.noProgress, 0); assert.equal(g.lastDispatchSig, '')
})

test('自选轮：挑够之前、或菲菲没说「挑完了」→ 续派菲菲继续挑', () => {
  const l = L()
  const c = { selection: { source: 'ready_pool_then_triage', max_items: 3 }, deadline: future, goal: { loop: 'active' } }
  const ev = goal.evaluateGoal({ contract: c, ledger: l, mode: 'active' })
  assert.equal(ev.verdict, 'continue')
  assert.equal(ev.next.items[0].need, 'select')
  l.selection = { done: true, picked: [], why: '待处理 20 条全是③类' }
  assert.notEqual(goal.evaluateGoal({ contract: c, ledger: l, mode: 'active' }).verdict, 'continue')
})

test('续跑指令：带现状表、你这棒的活、四条硬规矩与三种不确定', () => {
  const l = L()
  l.itemResults = { 'REQ-0001': { result: 'in_progress' } }
  const ev = goal.evaluateGoal({ contract: named(['REQ-0001']), ledger: l, mode: 'active', entries: new Map([['REQ-0001', { status: '开发中' }]]) })
  const t = goal.renderContinuation({ ev, runName: 'r', turn: 2 })
  assert.match(t, /第 2 轮自动续跑/)
  assert.match(t, /REQ-0001/)
  assert.match(t, /不缩水/)
  assert.match(t, /三种不确定/)
})

test('编号归一：契约写 req-316、登记表是 REQ-0316，也能对上（2026-08-27 guarded-01 回放踩到）', () => {
  const l = L()
  l.itemResults = { 'REQ-316': { result: 'rc_ready' } }
  fullCard(l, 'REQ-0316')
  const ev = goal.evaluateGoal({ contract: named(['req-316']), ledger: l, mode: 'active' })
  assert.deepEqual(ev.items.map(i => [i.req, i.state]), [['REQ-0316', 'done']])
  assert.equal(ev.verdict, 'met')
})

test('自选轮菲菲说「挑完了、0 条」→ 收手并写明原因，不在「等待」里空转', () => {
  const l = L()
  l.selection = { done: true, picked: [], why: '待处理里剩下的都要改线上表结构' }
  const ev = goal.evaluateGoal({ contract: { selection: { source: 'ready_pool_then_triage', max_items: 3 }, deadline: future, goal: { loop: 'active' } }, ledger: l, mode: 'active' })
  assert.equal(ev.verdict, 'met')
  assert.match(ev.why, /没挑到可做的需求/)
})

test('审查发现 #1：打回后返工重新走到终点、卡也齐 → 能判做完（打回不再永久挡住）', () => {
  const l = L()
  l.itemResults = { 'REQ-0001': { result: 'rc_ready', at: '2026-09-29T01:00:00.000Z' } }
  fullCard(l, 'REQ-0001')
  card.applyCardAction(l, { req: 'REQ-0001', action: 'reject', note: '按钮放右边' })
  l.cards['REQ-0001'].verdict.at = '2026-09-29T02:00:00.000Z'
  l.itemResults['REQ-0001'] = { result: 'in_progress', at: '2026-09-29T02:00:00.001Z' }
  const e = new Map([['REQ-0001', { status: '开发中' }]])
  const ev1 = goal.evaluateGoal({ contract: named(['REQ-0001']), ledger: l, entries: e, mode: 'active' })
  assert.equal(ev1.next.owner, 'ggbond', '返工开发中 → 派 GG Bond，不是每轮派回菲菲')
  l.itemResults['REQ-0001'] = { result: 'rc_ready', at: '2026-09-29T05:00:00.000Z' }
  const ev2 = goal.evaluateGoal({ contract: named(['REQ-0001']), ledger: l, entries: new Map([['REQ-0001', { status: 'QA通过' }]]), mode: 'active' })
  assert.equal(ev2.verdict, 'met')
})

test('审查发现 #3：park 重复调用只留一件高危；正式 raise_risk 会顶掉 park 自动生成的那件', () => {
  const l = L()
  card.raiseRisk(l, { req: 'REQ-0001', what: '口径 A/B', why: '要业务同事乙定', options: ['A', '先不做'], source: 'park' })
  card.raiseRisk(l, { req: 'REQ-0001', what: '口径 A/B（更新理由）', why: '要业务同事乙定', options: ['A', '先不做'], source: 'park' })
  assert.equal(l.risks.filter(r => r.status === 'open').length, 1)
  card.raiseRisk(l, { req: 'REQ-0001', what: '要改线上表结构', why: '加列', options: ['照做'] })
  assert.deepEqual(l.risks.map(r => r.status), ['superseded', 'open'])
})

test('审查发现 #4：高危在会话里拍过、链一路做到终点且卡齐 → 不再挂在「等你拍」', () => {
  const l = L()
  card.raiseRisk(l, { req: 'REQ-0001', what: '改表结构', why: '加列', options: ['照做'] })
  l.risks[0].at = '2026-09-29T01:00:00.000Z'
  l.itemResults = { 'REQ-0001': { result: 'rc_ready', at: '2026-09-29T06:00:00.000Z' } }
  fullCard(l, 'REQ-0001')
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0001']), ledger: l, mode: 'active' }).verdict, 'met')
})

test('2026-09-30 口径：高危事项默认「按推荐先做」不挡路；只有 blocksNow / park 生成的才让条目等老板；老板点「先按推荐做」即放行', () => {
  const l = L()
  l.itemResults = { 'REQ-0350': { result: 'in_progress' } }
  const e = new Map([['REQ-0350', { status: '开发中' }]])
  card.raiseRisk(l, { req: 'REQ-0350', what: '迁移范围怎么圈', why: '改线上在途任务', options: ['按款式类型圈', '全部人工确认'], recommend: '按款式类型圈' })
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0350']), ledger: l, entries: e, mode: 'active' }).next.owner, 'ggbond', '不挡路，照常派开发')
  card.raiseRisk(l, { req: 'REQ-0350', what: '要不要执行线上迁移', why: '一执行回不去', options: ['执行'], blocksNow: true })
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0350']), ledger: l, entries: e, mode: 'active' }).verdict, 'waiting_boss')
  const r = card.applyCardAction(l, { req: 'REQ-0350', action: 'risk_proceed', id: 'R2' })
  assert.equal(r.reopen, 'REQ-0350')
  assert.equal(l.risks[1].status, 'open', '卡上仍开着等他追认')
  assert.equal(goal.evaluateGoal({ contract: named(['REQ-0350']), ledger: l, entries: e, mode: 'active' }).verdict, 'continue')
})
