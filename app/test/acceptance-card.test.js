// 验收卡（v0.11.0）：一个需求一张卡，四格 + 「我替你定了什么」。
// 这里钉死三件事：① 卡片「填满」的判据（goal 模式靠它判完成）；② 三种不确定的写侧校验
// （查得清的要写依据、可反悔的要写备选、反悔代价大的要给路）；③ 老板在卡片上的动作会把条目交回流水线。
import test from 'node:test'
import assert from 'node:assert/strict'
import * as card from '../acceptance-card.js'
import { emptyLedger } from '../guard-ledger.js'

const led = () => card.ensureStores(emptyLedger('2026-09-29-guarded-01'))

test('空卡不算填满：缺说明、缺截图、缺老功能影响申报', () => {
  const c = card.cardCompleteness({})
  assert.equal(c.complete, false)
  assert.deepEqual(c.missing.map(m => m.who), ['ggbond', 'mihu', 'ggbond'])
})

test('四格齐（说明 + 截图 + 影响申报且逐条验过）才算填满', () => {
  const l = led()
  card.upsertCard(l, 'REQ-0352', { summary: '列表每行右侧多了标签', shots: [{ src: 'tasks/x.png', caption: '列表页' }], impact: [{ feature: '打样列表', how: '同一个表格组件' }] }, 'ggbond')
  assert.equal(card.cardCompleteness(l.cards['REQ-0352']).complete, false, '影响面没验证前不算完')
  card.upsertCard(l, 'REQ-0352', { impactVerify: [{ feature: '打样列表', ok: true, evidence: 'session-1 全绿' }] }, 'mihu')
  assert.equal(card.cardCompleteness(l.cards['REQ-0352']).complete, true)
})

test('纯后端改动写明「无界面改动」+ 真没碰老功能写明理由，也算填满', () => {
  const l = led()
  card.upsertCard(l, 'REQ-0001', { summary: '导出接口多返回一列', noUi: '只改接口，页面不变', impactNone: '新增字段、老调用方不读它' })
  assert.equal(card.cardCompleteness(l.cards['REQ-0001']).complete, true)
})

test('老功能验证没过 → 不算完，且点名交回开发', () => {
  const l = led()
  card.upsertCard(l, 'REQ-0002', { summary: 's', noUi: 'x', impact: [{ feature: '详情页' }], impactVerify: [{ feature: '详情页', ok: false, evidence: '标签错位' }] })
  const c = card.cardCompleteness(l.cards['REQ-0002'])
  assert.equal(c.complete, false)
  assert.ok(c.missing.some(m => m.who === 'ggbond' && /验证没过/.test(m.what)))
})

test('截图按 src 去重、最多留 12 张', () => {
  const l = led()
  for (let i = 0; i < 15; i++) card.upsertCard(l, 'REQ-0003', { shots: [{ src: `a${i}.png` }, { src: 'a0.png' }] })
  assert.equal(l.cards['REQ-0003'].shots.length, 12)
})

test('record_decision：查得清的必须写依据，可反悔的必须写备选', () => {
  const l = led()
  assert.match(card.recordDecision(l, { req: 'REQ-0001', topic: '导出指哪个', chosen: 'v5.19 那个', why: '代码里只有它', kind: 'fact' }).error, /source/)
  assert.match(card.recordDecision(l, { req: 'REQ-0001', topic: '默认值', chosen: '0.05', why: '行业常见', kind: 'reversible' }).error, /alternative/)
  const ok = card.recordDecision(l, { req: 'REQ-0001', topic: '默认值', chosen: '0.05', why: '行业常见', alternative: '0', kind: 'reversible' })
  assert.equal(ok.decision.id, 'D1')
  assert.equal(card.recordDecision(l, { req: 'REQ-0001', topic: 't', chosen: 'c', why: 'w', source: 'docs/a.md', kind: 'fact' }).decision.id, 'D2')
})

test('record_decision 撞上「反悔代价大」的信号会提醒改用 raise_risk', () => {
  const l = led()
  const r = card.recordDecision(l, { req: 'REQ-0001', topic: '存量数据要不要回填', chosen: '回填', why: 'w', alternative: '不回填', kind: 'reversible' })
  assert.ok(r.costlyHint, '回填存量数据是③类信号')
})

test('raise_risk：要写清是什么、为什么、至少一条路', () => {
  const l = led()
  assert.match(card.raiseRisk(l, { req: 'REQ-0001', what: '改表结构', why: '' , options: ['照做'] }).error, /why/)
  assert.match(card.raiseRisk(l, { req: 'REQ-0001', what: '改表结构', why: '要加列', options: [] }).error, /options/)
  const r = card.raiseRisk(l, { req: 'REQ-0001', what: '改表结构', why: '要加列', options: '照做；不做这部分；换成前端计算' })
  assert.equal(r.risk.id, 'R1')
  assert.equal(r.risk.options.length, 3)
})

test('卡片动作：打回必须写原因；打回/改决定/拍高危都会把条目交回流水线', () => {
  const l = led()
  assert.match(card.applyCardAction(l, { req: 'REQ-0001', action: 'reject' }).error, /原因/)
  const rej = card.applyCardAction(l, { req: 'REQ-0001', action: 'reject', note: '按钮放右边' })
  assert.equal(rej.reopen, 'REQ-0001')
  card.recordDecision(l, { req: 'REQ-0001', topic: '默认值', chosen: '0.05', why: 'w', alternative: '0', kind: 'reversible' })
  const ch = card.applyCardAction(l, { req: 'REQ-0001', action: 'decision_change', id: 'D1' })
  assert.equal(ch.reopen, 'REQ-0001')
  assert.match(ch.instruction, /改成「0」/, '没给 choice 时默认改成员工写的备选')
  card.raiseRisk(l, { req: 'REQ-0001', what: '改表结构', why: '要加列', options: ['照做', '不做'] })
  assert.match(card.applyCardAction(l, { req: 'REQ-0001', action: 'risk_choose', id: 'R1' }).error, /选一条路/)
  const ap = card.applyCardAction(l, { req: 'REQ-0001', action: 'risk_choose', id: 'R1', choice: '照做' })
  assert.equal(ap.reopen, 'REQ-0001')
  assert.equal(l.risks[0].status, 'approved')
  const ok = card.applyCardAction(l, { req: 'REQ-0001', action: 'accept' })
  assert.equal(ok.reopen, '')
  assert.equal(l.cards['REQ-0001'].verdict.status, 'accepted')
})

test('buildCards：有未拍高危的排最前；测完但卡没补齐 = 「在补验收卡」，补齐 = 「做完了」', () => {
  const l = led()
  l.itemResults = { 'REQ-0001': { result: 'rc_ready' }, 'REQ-0002': { result: 'rc_ready' }, 'REQ-0003': { result: 'in_progress' } }
  card.upsertCard(l, 'REQ-0002', { summary: 's', noUi: 'x', impactNone: '无' })
  card.raiseRisk(l, { req: 'REQ-0003', what: '改权限', why: '新菜单要权限码', options: ['加权限码'], blocksNow: true })
  const entries = new Map([['REQ-0001', { status: '待人工验收', name: '甲' }], ['REQ-0002', { status: 'QA通过', name: '乙' }], ['REQ-0003', { status: '开发中', name: '丙' }]])
  const rows = [{ facetId: 'REQ-0001-F1', status: 'COVERED_GREEN' }, { facetId: 'REQ-0001-F2', status: 'BLOCKED_WITH_PROOF' }]
  const out = card.buildCards({ reqs: ['REQ-0001', 'REQ-0002', 'REQ-0003'], ledgers: [l], entries, rows })
  assert.deepEqual(out.cards.map(c => [c.req, c.state]), [['REQ-0003', 'waiting_you'], ['REQ-0002', 'done'], ['REQ-0001', 'finishing']])
  const c1 = out.cards.find(c => c.req === 'REQ-0001')
  assert.match(c1.done.text, /1\/2/)
  assert.ok(c1.missing.length > 0)
  assert.equal(out.summary.waitingYou, 1)
  assert.match(out.summary.text, /1 条等你拍板/)
})

test('buildCards：跨多轮台账按时间先后合并，后一轮覆盖前一轮', () => {
  const a = led(); a.runName = 'r1'; card.upsertCard(a, 'REQ-0009', { summary: '旧说明' })
  const b = led(); b.runName = 'r2'; card.upsertCard(b, 'REQ-0009', { summary: '新说明' })
  const out = card.buildCards({ reqs: ['REQ-0009'], ledgers: [a, b] })
  assert.equal(out.cards[0].looks.summary, '新说明')
  assert.deepEqual(out.rounds, ['r1', 'r2'])
})
