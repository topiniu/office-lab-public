import test from 'node:test'
import assert from 'node:assert/strict'
import {
  POOL_FIELDS, missingPoolFields, PROBES, evaluateReadiness, sortPool, pickForContract,
  recordPark, mustAnswer, renderParkLedger, PARK_ESCALATE_ROUNDS, toPoolRow, recordParkRuling,
  PARK_KIND, classifyParkKind, reconcilePark, shouldSkipDefer,
  validateNarrowScope, NARROW_SCOPE_TEMPLATE, crossEntryFacets, renderCrossEntryFacets, CROSS_ENTRY_KIND,
} from '../requirement-pool.js'

// ---------- §2 字段 ----------
test('八项就绪池字段齐全，且「一个 tag 不够」——就绪缺口是多选、能说出差哪一项', () => {
  const names = POOL_FIELDS.map(f => f.name)
  for (const n of ['守航就绪', '就绪缺口', 'risk_class', '紧急度', 'park轮次', '窄口径声明', 'facet冻结', '影响入口']) assert.ok(names.includes(n), '缺 ' + n)
  assert.equal(POOL_FIELDS.find(f => f.name === '就绪缺口').type, 4)   // 4=多选
})
test('missingPoolFields 忽略空白差异，已有的不重复建', () => {
  const miss = missingPoolFields(['守航就绪', '就绪 缺口', 'risk_class'])
  assert.ok(!miss.some(f => f.name === '守航就绪'))
  assert.ok(!miss.some(f => f.name === '就绪缺口'))
  assert.ok(miss.some(f => f.name === '窄口径声明'))
})

// ---------- A2 就绪标准 ----------
const ALL_PROBES_OK = Object.fromEntries(PROBES.map(p => [p.field, true]))
const HARD_OK = { facetFrozen: true, riskClass: 'low', narrowScope: '本次只做：加默认值\n提出人原话可能还期待：存量也带出\n若要那部分，需要工作量：加一条回填 DDL' }

test('七项全过 + 三条硬前置齐 → 就绪', () => {
  const r = evaluateReadiness(ALL_PROBES_OK, HARD_OK)
  assert.equal(r.ready, true)
  assert.equal(r.readinessValue, '就绪')
  assert.deepEqual(r.gaps, [])
})
test('缺的拷问一律当 open（不是"没说就算过"）', () => {
  const r = evaluateReadiness({}, HARD_OK)
  assert.equal(r.ready, false)
  assert.equal(r.gaps.length, PROBES.length)
  assert.equal(r.readinessValue, '待澄清')
  assert.equal(r.questions.length, PROBES.length)
})
test('三条硬前置各自能单独卡住就绪', () => {
  assert.match(evaluateReadiness(ALL_PROBES_OK, { ...HARD_OK, facetFrozen: false }).hardBlockers.join(), /facet 未冻结/)
  assert.match(evaluateReadiness(ALL_PROBES_OK, { ...HARD_OK, riskClass: '' }).hardBlockers.join(), /risk_class 未定/)
  assert.match(evaluateReadiness(ALL_PROBES_OK, { ...HARD_OK, narrowScope: '' }).hardBlockers.join(), /窄口径声明未写/)
})
test('测试路径有不可逆外部副作用也卡住（方案 §6.4：测试路径也算）', () => {
  const r = evaluateReadiness(ALL_PROBES_OK, { ...HARD_OK, irreversibleSideEffect: true })
  assert.equal(r.ready, false)
  assert.match(r.hardBlockers.join(), /测试路径也算/)
})
test('显式判「不适合守航」时 readinessValue 随之改变', () => {
  assert.equal(evaluateReadiness({}, { unsuitable: true }).readinessValue, '不适合守航')
})

// ---------- A1 巡航排序 ----------
test('排序键：就绪度 > 紧急度 > 期望时间 > park 轮次', () => {
  const rows = [
    { req: 'A', readiness: '待澄清', priority: 'P0' },
    { req: 'B', readiness: '就绪', priority: 'P2' },
    { req: 'C', readiness: '就绪', priority: 'P0' },
    { req: 'D', readiness: '就绪', priority: 'P0', dueDate: '2026-08-27' },
  ]
  assert.deepEqual(sortPool(rows).map(r => r.req), ['D', 'C', 'B', 'A'])
})
test('同档时 park 轮次多的先（别再让它烂在队里）', () => {
  const rows = [{ req: 'A', readiness: '就绪', priority: 'P1', parkRounds: 0 }, { req: 'B', readiness: '就绪', priority: 'P1', parkRounds: 3 }]
  assert.deepEqual(sortPool(rows).map(r => r.req), ['B', 'A'])
})
test('从就绪池取候选：只取「就绪」且 risk_class 在允许集内', () => {
  const rows = [
    { req: 'A', readiness: '就绪', riskClass: 'low' },
    { req: 'B', readiness: '待澄清', riskClass: 'low' },
    { req: 'C', readiness: '就绪', riskClass: 'high' },
  ]
  const p = pickForContract(rows, 3)
  assert.deepEqual(p.picked.map(r => r.req), ['A'])
  assert.deepEqual(p.deferredHigh.map(r => r.req), ['C'])
})
test('抽 0 条必须显式报出原因——guarded-02 那轮抽 0 条却没有任何说明', () => {
  assert.match(pickForContract([], 3).emptyWhy, /就绪池是空的/)
  assert.match(pickForContract([{ req: 'C', readiness: '就绪', riskClass: 'high' }], 3).emptyWhy, /1 条就绪但是 high/)
  assert.match(pickForContract([{ req: 'B', readiness: '待澄清' }], 3).emptyWhy, /没有一条同时满足/)
})
test('maxItems 生效且至少取 1', () => {
  const rows = [1, 2, 3, 4].map(i => ({ req: 'R' + i, readiness: '就绪', riskClass: 'low' }))
  assert.equal(pickForContract(rows, 2).picked.length, 2)
  assert.equal(pickForContract(rows, 0).picked.length, 1)
})

// ---------- A5 park 台账 ----------
test('同一条 park 轮次自增，≥2 轮升级必答区', () => {
  let s = recordPark([], { req: 'REQ-0304', reason: '口径未定', probeKey: '口径', proposal: 'A 案' })
  assert.equal(s.entry.rounds, 1)
  assert.equal(s.escalate, false)
  s = recordPark(s.entries, { req: 'REQ-0304', reason: '口径未定', probeKey: '口径', proposal: 'A 案' })
  assert.equal(s.entry.rounds, 2)
  assert.equal(s.escalate, true)
  assert.equal(mustAnswer(s.entries).length, 1)
  assert.equal(PARK_ESCALATE_ROUNDS, 2)
})
test('拟定口径一字未变 → 打 repeatedProposal 标（REQ-0304/0309 每轮重写一样的建议）', () => {
  let s = recordPark([], { req: 'A', proposal: 'A 案' })
  s = recordPark(s.entries, { req: 'A', proposal: 'A 案' })
  assert.equal(s.entry.repeatedProposal, true)
  s = recordPark(s.entries, { req: 'A', proposal: 'B 案（老板给了新输入）' })
  assert.equal(s.entry.repeatedProposal, false)
  assert.equal(s.entry.proposal, 'B 案（老板给了新输入）')
})
test('新拟定口径为空时不覆盖已有的（别把有内容的擦成空）', () => {
  let s = recordPark([], { req: 'A', proposal: 'A 案' })
  s = recordPark(s.entries, { req: 'A', proposal: '' })
  assert.equal(s.entry.proposal, 'A 案')
})
test('缺 req 时报错不静默', () => {
  assert.match(recordPark([], {}).error, /需要 req 编号/)
})

// ---------- park 的出口：老板表态（2026-09-18 守航续跑）----------
test('老板表态落账 → 出必答区，但**不关闭**条目（关闭仍只看登记表终态）', () => {
  let s = recordPark([], { req: 'REQ-0352', reason: 'A/B 二选一', probeKey: '口径', proposal: '默认 A' })
  s = recordPark(s.entries, { req: 'REQ-0352', reason: 'A/B 二选一', probeKey: '口径', proposal: '默认 A' })
  assert.equal(mustAnswer(s.entries).length, 1)
  const r = recordParkRuling(s.entries, { req: 'req-0352', ruling: '就按 A 做', runName: '2026-09-18-guarded-02' })
  assert.equal(r.entry.ruling, '就按 A 做')
  assert.equal(r.entry.ruledInRun, '2026-09-18-guarded-02')
  assert.ok(r.entry.ruledAt)
  assert.equal(r.entry.closedAt, undefined, '表态不等于关闭——关闭的判据仍是登记表进终态')
  assert.equal(mustAnswer(r.entries).length, 0, '他答过了还挂必答区＝让他每天重答一次同一个问题')
})
test('表态后又被 park 一轮 → 表态标记作废、重回必答区（「已回答」不许变成免检符）', () => {
  let s = recordPark([], { req: 'A', proposal: 'A 案' })
  s = recordPark(s.entries, { req: 'A', proposal: 'A 案' })
  s = recordParkRuling(s.entries, { req: 'A', ruling: '按 A' })
  assert.equal(mustAnswer(s.entries).length, 0)
  s = recordPark(s.entries, { req: 'A', reason: '换了个地方卡住', proposal: 'C 案' })
  assert.equal(s.entry.ruledAt, undefined)
  assert.equal(s.entry.rulingStale, '按 A', '作废的表态留痕，别让它凭空消失')
  assert.equal(mustAnswer(s.entries).length, 1)
})
test('表态无处可落时如实报错（台账里没有这条）', () => {
  assert.match(recordParkRuling([], { req: 'REQ-9999', ruling: 'x' }).error, /没有 REQ-9999/)
  assert.match(recordParkRuling([{ req: 'A' }], { req: 'A', ruling: '  ' }).error, /需要 req 与 ruling/)
})
test('renderParkLedger 把「已表态待续跑」单独成段，不混进「可以再等一轮」', () => {
  const md = renderParkLedger([
    { req: 'REQ-0352', rounds: 2, proposal: '默认 A', probeKey: '口径', reason: 'A/B', ruling: '按 A 做', ruledAt: '2026-09-18T14:00:00.000Z' },
    { req: 'REQ-0400', rounds: 1, proposal: 'B 案' },
  ])
  assert.match(md, /你已表态、待续跑消化（1 条）/)
  assert.match(md, /按 A 做/)
  const ruledSeg = md.slice(md.indexOf('你已表态'), md.indexOf('首轮 park'))
  assert.ok(!ruledSeg.includes('REQ-0400'))
  assert.ok(md.slice(md.indexOf('首轮 park')).includes('REQ-0400'))
})
test('renderParkLedger 把必答区提到最前，并点明「不是想不出，是没人拍」', () => {
  const entries = [{ req: 'REQ-0304', rounds: 3, repeatedProposal: true, proposal: 'A 案', probeKey: '口径', reason: 'x' }, { req: 'REQ-0400', rounds: 1, proposal: 'B 案' }]
  const md = renderParkLedger(entries)
  assert.ok(md.indexOf('必答区') < md.indexOf('首轮 park'))
  assert.match(md, /不是想不出，是没人拍/)
})
test('park 了却没给拟定口径 → 渲染里点名（老板没法一句话推动）', () => {
  assert.match(renderParkLedger([{ req: 'A', rounds: 2 }]), /没给拟定口径/)
})
test('空台账不炸', () => {
  assert.match(renderParkLedger([]), /没有 park 条目/)
})

// ---------- A3 窄口径声明 ----------
test('三段齐备才合格', () => {
  const ok = validateNarrowScope('本次只做：新增行默认值\n提出人原话可能还期待：存量历史也带出\n若要那部分，需要工作量：一条回填 DDL + 10,635 行影响')
  assert.equal(ok.ok, true)
  assert.equal(ok.sections.doPart, '新增行默认值')
})
test('缺「提出人可能还期待 Y」→ 不合格，并点名这正是 REQ-0302 漏的那一行', () => {
  const r = validateNarrowScope('本次只做：新增行默认值\n若要那部分，需要工作量：一条 DDL')
  assert.equal(r.ok, false)
  assert.match(r.errors.join(), /REQ-0302/)
})
test('把「历史不回填」冻成负向 facet 却没写「提出人可能要存量」→ 专门点名这个形状', () => {
  const r = validateNarrowScope('本次只做：新增行默认值，历史不回填')
  assert.match(r.errors.join(), /这正是 REQ-0302 的形状/)
})
test('空声明直接不合格', () => {
  assert.equal(validateNarrowScope('').ok, false)
  assert.equal(validateNarrowScope(null).ok, false)
})
test('模板本身能通过校验（否则给的模板是错的）', () => {
  const filled = NARROW_SCOPE_TEMPLATE.replace(/<[^>]*>/g, '某内容')
  assert.equal(validateNarrowScope(filled).ok, true)
})

// ---------- A4 跨入口一致性 facet ----------
const EM = {
  'sampling-part-order-select': ['priceReview', 'sampleReview', 'supplyChain', 'patternReview'],
  'sampling-only-here-btn': ['priceReview'],
}
test('被 ≥2 入口复用的组件才生成横向 facet（单入口的不生成）', () => {
  const g = crossEntryFacets(EM, ['sampling-part-order-select', 'sampling-only-here-btn'], { reqId: 'REQ-0311' })
  assert.equal(g.facets.length, 1)
  assert.equal(g.facets[0].component, 'sampling-part-order-select')
  assert.equal(g.facets[0].kind, CROSS_ENTRY_KIND)
  assert.equal(g.facets[0].id, 'REQ-0311-F1')
  assert.match(g.facets[0].criterion, /这 4 个入口表现一致/)
  assert.match(g.facets[0].consistencyGroup, /^cg:/)
})
test('startIndex 接续现有 facet 序号，不覆盖已有 facet', () => {
  const g = crossEntryFacets(EM, ['sampling-part-order-select'], { reqId: 'REQ-0311', startIndex: 8 })
  assert.equal(g.facets[0].id, 'REQ-0311-F8')
})
test('入口图谱不可用/无命中时如实给出原因，不返回空数组了事', () => {
  const g = crossEntryFacets({}, ['whatever'], { reqId: 'REQ-1' })
  assert.equal(g.facets.length, 0)
  assert.match(g.why, /没有落在被 ≥2 入口复用的组件上/)
  assert.match(renderCrossEntryFacets(g), /不生成横向 facet/)
})
test('入口去重且排序稳定（避免每次生成的 facet 文案抖动）', () => {
  const g1 = crossEntryFacets({ x: ['b', 'a', 'a'] }, ['x'], { reqId: 'R' })
  const g2 = crossEntryFacets({ x: ['a', 'b'] }, ['x'], { reqId: 'R' })
  assert.deepEqual(g1.facets[0].entries, g2.facets[0].entries)
})
test('renderCrossEntryFacets 带 consistencyGroup 列（迷糊要用它跑猪猪）', () => {
  const md = renderCrossEntryFacets(crossEntryFacets(EM, ['sampling-part-order-select'], { reqId: 'R' }))
  assert.match(md, /consistencyGroup/)
})

// ---------- A1 取数层：表行 → 池行 ----------
// 注入一个模拟 cell()：按「去空白 + 包含」匹配列名（飞书列名常被手工加空格/后缀）
const mkCell = fields => (rec, ...names) => {
  for (const n of names) for (const [k, v] of Object.entries(rec.fields || {})) if (k.replace(/\s/g, '').includes(n)) return String(v)
  return ''
}
const REC = fields => ({ record_id: 'rec1', fields })

// ★ 这条是整个就绪池最重要的安全默认：表还没建 `守航就绪` 列的今天，若默认成「就绪」，
// pickForContract 会把整表 200+ 条全判成合格候选、夜里直接开跑——比抽 0 条坏得多。
test('`守航就绪` 列不存在 / 值为空 → 一律「待澄清」，绝不默认「就绪」', () => {
  const noCol = REC({ 需求编号: 'REQ-0301', 需求点: '损耗率默认值' })
  assert.equal(toPoolRow(noCol, mkCell()).readiness, '待澄清')
  assert.equal(toPoolRow(REC({ 需求编号: 'R', 守航就绪: '  ' }), mkCell()).readiness, '待澄清')
  assert.equal(toPoolRow(REC({ 需求编号: 'R', 守航就绪: '就绪' }), mkCell()).readiness, '就绪')
})
test('整表没有就绪列时，pickForContract 必须抽 0 条并报原因（不是全取）', () => {
  const rows = Array.from({ length: 200 }, (_, i) => toPoolRow(REC({ 需求编号: 'REQ-' + i }), mkCell()))
  const p = pickForContract(rows, 3)
  assert.equal(p.picked.length, 0)
  assert.match(p.emptyWhy, /没有一条同时满足/)
})
test('列名带空格/后缀仍能匹配（飞书列名会被手工改）', () => {
  const r = toPoolRow(REC({ '需求 编号': 'REQ-0302', 'risk_class（评估）': 'HIGH', '紧急度 ': 'p1', 'facet冻结': '是' }), mkCell())
  assert.equal(r.req, 'REQ-0302')
  assert.equal(r.riskClass, 'high')      // 归一化成小写，与 gate-matrix 的口径一致
  assert.equal(r.priority, 'P1')         // 归一化成大写，与 sortPool 的 P_RANK 对齐
  assert.equal(r.facetFrozen, true)
})
test('park 轮次以引擎台账为准，表里那列只是可能没回刷的投影', () => {
  const rec = REC({ 需求编号: 'REQ-0304', park轮次: '1' })
  assert.equal(toPoolRow(rec, mkCell(), { parkRounds: { 'REQ-0304': 3 } }).parkRounds, 3)
  assert.equal(toPoolRow(rec, mkCell()).parkRounds, 1)   // 台账没有该条时才退回表里的值
})
test('缺编号时退回 record_id，不produce 空 key', () => {
  assert.equal(toPoolRow(REC({ 需求点: 'x' }), mkCell()).req, 'rec1')
})
test('取数 → 排序 → 取候选 串起来：就绪的 low 排前面并被取中', () => {
  const recs = [
    REC({ 需求编号: 'REQ-1', 守航就绪: '待澄清', 紧急度: 'P0' }),
    REC({ 需求编号: 'REQ-2', 守航就绪: '就绪', 紧急度: 'P2', risk_class: 'low' }),
    REC({ 需求编号: 'REQ-3', 守航就绪: '就绪', 紧急度: 'P0', risk_class: 'high' }),
    REC({ 需求编号: 'REQ-4', 守航就绪: '就绪', 紧急度: 'P0', risk_class: 'medium' }),
  ]
  const rows = recs.map(r => toPoolRow(r, mkCell()))
  assert.deepEqual(sortPool(rows).map(r => r.req), ['REQ-3', 'REQ-4', 'REQ-2', 'REQ-1'])
  const p = pickForContract(rows, 2)
  assert.deepEqual(p.picked.map(r => r.req), ['REQ-4', 'REQ-2'])          // high 不进候选
  assert.deepEqual(p.deferredHigh.map(r => r.req), ['REQ-3'])              // 但单列出来，不静默丢
})

// ---------- park 分家 + 出口（2026-08-28 老板报「进度跟真实的不一样」）----------
test('classifyParkKind：引擎顺延占位与真歧义分家，旧数据按指纹回填', () => {
  assert.equal(classifyParkKind({ reason: 'deadline 到点未达 RC_READY' }), PARK_KIND.DEFERRED)
  assert.equal(classifyParkKind({ proposal: '（引擎自动顺延；下一轮优先领取）' }), PARK_KIND.DEFERRED)
  assert.equal(classifyParkKind({ reason: '口径未定：存量要不要回填', proposal: '只补空不覆盖' }), PARK_KIND.AMBIGUITY)
  assert.equal(classifyParkKind({ kind: PARK_KIND.AMBIGUITY, reason: 'deadline 到点未达 RC_READY' }), PARK_KIND.AMBIGUITY, '显式 kind 优先于指纹')
})
// 这条钉的是真事故：条目账接通后 deadline 顺延首次触发，把菲菲写的实质口径整段覆盖成了占位符。
test('顺延写入只许抬轮次，绝不覆盖菲菲的 reason/proposal', () => {
  let s = recordPark([], { req: 'REQ-0271', reason: '下游口径分歧：纸样筛选要不要同步', probeKey: '范围', proposal: '拟定默认=保持一致' })
  s = recordPark(s.entries, { req: 'REQ-0271', reason: 'deadline 到点未达 RC_READY', proposal: '（引擎自动顺延；下一轮优先领取）', kind: PARK_KIND.DEFERRED })
  assert.equal(s.entry.reason, '下游口径分歧：纸样筛选要不要同步')
  assert.equal(s.entry.proposal, '拟定默认=保持一致')
  assert.equal(s.entry.rounds, 2)
  assert.equal(s.entry.deferRounds, 1)
  assert.equal(classifyParkKind(s.entry), PARK_KIND.AMBIGUITY, '被顺延过不改变它仍是真歧义')
})
test('必答区只收未关闭的真歧义（顺延占位永不进——此前必答区里全是它）', () => {
  const entries = [
    { req: 'REQ-0313', rounds: 3, kind: PARK_KIND.DEFERRED, reason: 'deadline 到点未达 RC_READY' },
    { req: 'REQ-0304', rounds: 2, reason: '口径未定', proposal: 'A 案' },
    { req: 'REQ-0309', rounds: 2, reason: '口径未定', proposal: 'B 案', closedAt: '2026-08-28T00:00:00Z' },
  ]
  assert.deepEqual(mustAnswer(entries).map(e => e.req), ['REQ-0304'])
})
const BY_REQ = o => new Map(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? { status: v } : v]))
test('reconcilePark A 档：条目已上线 → 关闭并留证（决策已由「发出去了」兑现）', () => {
  const r = reconcilePark([{ req: 'REQ-0309', rounds: 1, reason: '口径未定', proposal: 'B 案' }], BY_REQ({ 'REQ-0309': '已上线' }))
  assert.equal(r.closed.length, 1)
  assert.match(r.entries[0].closedBy, /登记表状态=已上线/)
  assert.ok(r.entries[0].closedAt)
})
// 收窄的关键一条：过检 ≠ 发布，发布前那个口径问题仍然是活的（REQ-0271 就是这形状）
test('reconcilePark：真歧义只是「人工Pass/QA通过」时绝不关闭，只降级', () => {
  for (const st of ['人工Pass', 'QA通过']) {
    const r = reconcilePark([{ req: 'REQ-0271', rounds: 1, reason: '筛选口径要不要同步', proposal: '保持一致' }], BY_REQ({ 'REQ-0271': st }))
    assert.equal(r.closed.length, 0, st)
    assert.equal(r.demoted.length, 1, st)
    assert.equal(r.entries[0].proposal, '保持一致', '拟定口径必须还在')
  }
})
test('reconcilePark A′ 档：顺延占位进了 QA 族即关闭', () => {
  const r = reconcilePark([{ req: 'REQ-0313', rounds: 2, kind: PARK_KIND.DEFERRED, reason: 'deadline 到点未达 RC_READY' }], BY_REQ({ 'REQ-0313': 'QA中' }))
  assert.equal(r.closed.length, 1)
})
test('reconcilePark B 档：真歧义即便条目在推进也不关闭，只降级（不许替老板拍板）', () => {
  const r = reconcilePark([{ req: 'REQ-0312', rounds: 1, reason: '存量识别口径未定', proposal: '只补空不覆盖' }], BY_REQ({ 'REQ-0312': 'QA中' }))
  assert.equal(r.closed.length, 0)
  assert.equal(r.demoted.length, 1)
  assert.equal(r.entries[0].demotedStatus, 'QA中')
  assert.ok(!r.entries[0].closedAt)
})
test('reconcilePark C 档：阻塞/待梳理/不在登记表 → 一律保留（旧黑名单会误关这些）', () => {
  const park = [{ req: 'REQ-0303', rounds: 1 }, { req: 'REQ-0219', rounds: 1 }, { req: 'REQ-0999', rounds: 1 }]
  const r = reconcilePark(park, BY_REQ({ 'REQ-0303': '阻塞', 'REQ-0219': '待梳理' }))
  assert.equal(r.closed.length, 0)
  assert.equal(r.kept.length, 3)
  assert.match(r.kept[2].why, /不在登记表/)
})
test('reconcilePark 幂等 + dryRun 不写盘', () => {
  const park = [{ req: 'A', rounds: 1 }]
  const dry = reconcilePark(park, BY_REQ({ A: '已上线' }), { dryRun: true })
  assert.equal(dry.closed.length, 1)
  assert.ok(!dry.entries[0].closedAt, 'dryRun 只报不写')
  const first = reconcilePark(park, BY_REQ({ A: '已上线' }), { at: '2026-08-28T01:00:00Z' })
  const second = reconcilePark(first.entries, BY_REQ({ A: '已上线' }), { at: '2026-08-29T01:00:00Z' })
  assert.equal(second.closed.length, 0, '已关闭的不再重复关')
  assert.equal(second.entries[0].closedAt, '2026-08-28T01:00:00Z')
})
test('shouldSkipDefer：已在 QA 及以后的条目不该被顺延 park（否则刚关掉又被塞回来）', () => {
  assert.equal(shouldSkipDefer({ status: 'QA通过' }), true)
  assert.equal(shouldSkipDefer({ status: '待测' }), true)
  assert.equal(shouldSkipDefer({ status: '开发中' }), false)
  assert.equal(shouldSkipDefer(null), false)
})
test('renderParkLedger 四分区：关闭的进留证区、降级的单列且写明「不等于你答过」', () => {
  const md = renderParkLedger([
    { req: 'REQ-0304', rounds: 2, reason: '口径未定', proposal: 'A 案', probeKey: '口径' },
    { req: 'REQ-0312', rounds: 1, reason: '存量口径', proposal: 'C 案', demotedStatus: 'QA中' },
    { req: 'REQ-0309', rounds: 1, closedAt: '2026-08-28T01:00:00Z', closedBy: '登记表状态=QA通过' },
  ])
  assert.match(md, /必答区/)
  assert.ok(md.indexOf('REQ-0304') < md.indexOf('REQ-0312'), '必答区在前')
  assert.match(md, /口径问题仍未回答/)
  assert.match(md, /不等于「你答过了那个问题」/)
  assert.match(md, /本轮自动关闭/)
  assert.match(md, /登记表状态=QA通过/)
})
test('全部关闭时不假装「没有 park 过」，而是说清已对账关闭', () => {
  const md = renderParkLedger([{ req: 'A', rounds: 1, closedAt: '2026-08-28T01:00:00Z', closedBy: '登记表状态=已上线' }])
  assert.match(md, /已与登记表对账关闭/)
  assert.match(md, /本轮自动关闭/)
})
