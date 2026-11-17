import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRisk, maxRisk, gatesFor, classifyRisk, guardedScopeDecision, rcReadyGate, renderGateMatrix, HIGH_LINES, HIGH_BACKFILL_ROWS } from '../gate-matrix.js'

test('normalizeRisk 只认三档，其余归空（不静默当 low）', () => {
  assert.equal(normalizeRisk('HIGH'), 'high')
  assert.equal(normalizeRisk(' medium '), 'medium')
  assert.equal(normalizeRisk('中'), '')
  assert.equal(normalizeRisk(null), '')
})
test('maxRisk 取最高档', () => {
  assert.equal(maxRisk('low', 'medium'), 'medium')
  assert.equal(maxRisk('high', 'low'), 'high')
  assert.equal(maxRisk('', ''), 'low')
})
test('gatesFor：low 全自动、medium 加两类 facet、high 不许守航实施', () => {
  assert.equal(gatesFor('low').autoToRcReady, true)
  assert.deepEqual(gatesFor('medium').requiredFacetKinds, ['visual', 'cross-entry'])
  // 2026-09-30 起 high 照样做完（开发分支上可以反悔），只把上线不可逆的几步留给人
  assert.equal(gatesFor('high').guardedScope, 'dev_full')
  assert.equal(gatesFor('high').autoToRcReady, true)
  assert.equal(gatesFor('胡说').guardedScope, 'full')   // 未知→按 low
})
test('C1 三道全局门在任何等级都默认开', () => {
  for (const lv of ['low', 'medium', 'high']) {
    for (const g of ['page-error', 'env-fresh', 'discrimination']) assert.ok(gatesFor(lv).requiredGates.includes(g), `${lv} 缺 ${g}`)
  }
})

// ---------- 自动定级：人填的只作下限 ----------
test('DDL / 权限变化 / 主数据 一律顶到 high', () => {
  assert.equal(classifyRisk({ ddl: true }).riskClass, 'high')
  assert.equal(classifyRisk({ permissionChange: true }).riskClass, 'high')
  assert.equal(classifyRisk({ productionData: true }).riskClass, 'high')
})
test('回填行数/改动规模越阈值顶 high（REQ-0239 是 10,635 行）', () => {
  assert.equal(classifyRisk({ backfillRows: HIGH_BACKFILL_ROWS + 1 }).riskClass, 'high')
  assert.equal(classifyRisk({ backfillRows: HIGH_BACKFILL_ROWS }).riskClass, 'low')     // 边界不误杀
  assert.equal(classifyRisk({ changedLines: HIGH_LINES + 1 }).riskClass, 'high')
  assert.equal(classifyRisk({ changedFiles: Array.from({ length: 41 }, (_, i) => 'f' + i + '.java') }).riskClass, 'high')
})
test('不可逆外部副作用顶 high（方案 §6.4：测试路径也算）', () => {
  assert.equal(classifyRisk({ externalSideEffects: true }).riskClass, 'high')
})
test('复用组件 / 前端可见改动顶 medium', () => {
  assert.equal(classifyRisk({ reusedComponents: 2 }).riskClass, 'medium')
  assert.equal(classifyRisk({ changedFiles: ['src/a.tsx'] }).riskClass, 'medium')
  assert.equal(classifyRisk({ changedFiles: ['src/A.java'] }).riskClass, 'low')
})
test('机器算出更高就按更高的算，并显式说出「人填低估了」（REQ-0239 事发时表里填的就不是 high）', () => {
  const r = classifyRisk({ ddl: true }, 'low')
  assert.equal(r.riskClass, 'high')
  assert.equal(r.escalated, true)
  assert.equal(r.declared, 'low')
  assert.match(r.note, /机器定级 high 高于人填的 low/)
})
test('人填的更高时不降级（人可以更保守）', () => {
  const r = classifyRisk({}, 'high')
  assert.equal(r.riskClass, 'high')
  assert.equal(r.escalated, false)
})

// ---------- B6 自动降级 ----------
test('守航态 + high → 照样实施到底，只把上线不可逆的几步写成上线步骤（2026-09-30 老板：只做简单的那我签约守航干什么）', () => {
  const d = guardedScopeDecision({ executionMode: 'guarded_run', signals: { ddl: true, backfillRows: 10635 }, declared: 'low' })
  assert.equal(d.riskClass, 'high', '机器升级照旧')
  assert.equal(d.downgrade, false)
  assert.equal(d.highDev, true)
  assert.equal(d.allowImplementation, true)
  assert.match(d.preamble, /照样实施到底/)
  assert.match(d.preamble, /写成上线步骤、不执行/)
  assert.match(d.preamble, /「要不要今晚做」不是问题/)
})
test('共驾态 high 不降级（白天有人能拍板/能停手）', () => {
  const d = guardedScopeDecision({ executionMode: 'co_drive', signals: { ddl: true } })
  assert.equal(d.downgrade, false)
  assert.equal(d.allowImplementation, true)
})
test('守航态 low/medium 不降级，但 preamble 点明必需 facet 与必开门', () => {
  const d = guardedScopeDecision({ executionMode: 'guarded_run', signals: { reusedComponents: 3 } })
  assert.equal(d.downgrade, false)
  assert.equal(d.riskClass, 'medium')
  assert.match(d.preamble, /cross-entry/)
  assert.match(d.preamble, /visual-baseline/)
})

// ---------- RC_READY 放行门 ----------
test('medium 缺 visual/cross-entry facet 时不许进 RC_READY', () => {
  const r = rcReadyGate({ riskClass: 'medium', facetKinds: ['auto'], gateResults: { 'page-error': true, 'env-fresh': true, discrimination: true, 'visual-baseline': true } })
  assert.equal(r.passed, false)
  assert.deepEqual(r.missingFacets, ['visual', 'cross-entry'])
})
test('门「未验证」按未通过算——未验证不等于通过', () => {
  const r = rcReadyGate({ riskClass: 'low', gateResults: { 'page-error': true, 'env-fresh': null, discrimination: undefined } })
  assert.equal(r.passed, false)
  assert.equal(r.blocked.filter(b => /未验证（接口缺位/.test(b)).length, 2)
})
test('low 全门通过即可进 RC_READY', () => {
  const r = rcReadyGate({ riskClass: 'low', gateResults: { 'page-error': true, 'env-fresh': true, discrimination: true } })
  assert.equal(r.passed, true)
  assert.deepEqual(r.blocked, [])
})
test('high 门都过了可以到 RC_READY；缺数据迁移 facet 或 DDL 前置核查没验证就不行（2026-09-30 起 high 照样做完）', () => {
  const ok = rcReadyGate({ riskClass: 'high', facetKinds: ['visual', 'cross-entry', 'data-migration'], gateResults: { 'page-error': true, 'env-fresh': true, discrimination: true, 'visual-baseline': true, 'ddl-precheck': true } })
  assert.equal(ok.passed, true)
  const no = rcReadyGate({ riskClass: 'high', facetKinds: ['visual', 'cross-entry'], gateResults: { 'page-error': true, 'env-fresh': true, discrimination: true, 'visual-baseline': true } })
  assert.equal(no.passed, false)
  assert.ok(no.blocked.some(b => /data-migration/.test(b)))
  assert.ok(no.blocked.some(b => /ddl-precheck/.test(b)))
})

test('renderGateMatrix 把升级过的条目单独点名', () => {
  const d1 = guardedScopeDecision({ executionMode: 'guarded_run', signals: { ddl: true }, declared: 'low' })
  const md = renderGateMatrix([{ item: 'REQ-0239', ...d1 }])
  assert.match(md, /REQ-0239/)
  assert.match(md, /机器升级了这些条目的风险等级/)
  assert.match(md, /整链做完·上线步骤留人/)
})
