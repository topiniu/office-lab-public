import test from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint, indexContract, diffContracts, formatBlock } from '../ui-contract.js'

const A = (over = {}) => ({
  testid: 'sampling-supply-chain-board-review-price-btn',
  key: 'reviewSupplyPrice', label: "'审核'", file: 'pages/samplingSupplyChainBoard/index.tsx', line: 2610,
  board: 'priceReview', subTab: null, statusFields: ['priceReviewStatus'], authCodes: ['GYS-SAMPLING-SUPPLY-011'],
  conditionReadable: "(boardMode === 'priceReview') && (record.priceReviewStatus === 1)",
  disabledWhen: null, ...over,
})
const doc = (actions, noCond = []) => ({ actions, actionsWithoutCondition: noCond, enums: [{ name: 'X', options: [] }] })

// ---------- fingerprint：语义变了才变，行号/label 变了不算 ----------
test('fingerprint 忽略行号与 label，只认语义维度', () => {
  assert.equal(fingerprint(A()), fingerprint(A({ line: 9999, label: "'审核(改文案)'", key: 'other' })))
  assert.notEqual(fingerprint(A()), fingerprint(A({ board: 'sampleReview' })))
  assert.notEqual(fingerprint(A()), fingerprint(A({ subTab: '2' })))
  assert.notEqual(fingerprint(A()), fingerprint(A({ statusFields: ['priceReviewStatus', 'supplyChainStatus'] })))
  assert.notEqual(fingerprint(A()), fingerprint(A({ authCodes: [] })))
  assert.notEqual(fingerprint(A()), fingerprint(A({ conditionReadable: 'record.priceReviewStatus === 4' })))
  assert.notEqual(fingerprint(A()), fingerprint(A({ disabledWhen: 'isNonResidentSupplier(record)' })))
})

test('fingerprint 对数组顺序与空白不敏感（避免假变更）', () => {
  assert.equal(fingerprint(A({ statusFields: ['a', 'b'] })), fingerprint(A({ statusFields: ['b', 'a'] })))
  assert.equal(fingerprint(A({ authCodes: ['x', 'y'] })), fingerprint(A({ authCodes: ['y', 'x'] })))
  assert.equal(fingerprint(A()), fingerprint(A({ conditionReadable: "(boardMode === 'priceReview')   &&\n (record.priceReviewStatus === 1)" })))
  assert.equal(fingerprint(null), '')
  assert.equal(fingerprint('x'), '')
})

// ---------- indexContract ----------
test('indexContract 统计覆盖率并索引到 testid', () => {
  const idx = indexContract(doc([A(), A({ testid: 'b' })], [{ testid: 'c' }, { testid: 'd' }]))
  assert.equal(idx.meta.total, 4)
  assert.equal(idx.meta.withCondition, 2)
  assert.equal(idx.meta.coverage, 0.5)
  assert.equal(idx.meta.enums, 1)
  assert.equal(idx.byTestid.b.board, 'priceReview')
  assert.equal(idx.byTestid[A().testid].label, '审核')   // 引号已剥
})

test('indexContract 容忍畸形输入', () => {
  assert.equal(indexContract(null).meta.total, 0)
  assert.equal(indexContract({}).meta.coverage, 0)
  assert.equal(Object.keys(indexContract({ actions: [null, { noTestid: 1 }] }).byTestid).length, 0)
})

// ---------- diffContracts ----------
test('diffContracts 首次不把全部当新增（否则第一次就糊一屏）', () => {
  const idx = indexContract(doc([A(), A({ testid: 'b' })]))
  const d = diffContracts(null, idx)
  assert.equal(d.firstRun, true)
  assert.equal(d.added.length, 0)
})

test('diffContracts 识别 新增/消失/变更 三类', () => {
  const prev = indexContract(doc([A(), A({ testid: 'gone-btn' })]))
  const next = indexContract(doc([A({ statusFields: ['priceReviewStatus', 'supplyChainStatus'] }), A({ testid: 'new-btn' })]))
  const d = diffContracts(prev, next)
  assert.equal(d.firstRun, false)
  assert.deepEqual(d.added.map(x => x.testid), ['new-btn'])
  assert.deepEqual(d.removed.map(x => x.testid), ['gone-btn'])
  assert.deepEqual(d.changed.map(x => x.testid), [A().testid])
})

test('diffContracts 行号漂移不算变更（真实场景：按钮上下移动）', () => {
  const prev = indexContract(doc([A({ line: 100 })]))
  const next = indexContract(doc([A({ line: 3000 })]))
  const d = diffContracts(prev, next)
  assert.equal(d.changed.length, 0)
  assert.equal(d.added.length + d.removed.length, 0)
})

// ---------- formatBlock ----------
test('formatBlock 首次只给基线坐标', () => {
  const idx = indexContract(doc([A()]))
  const s = formatBlock({ diff: diffContracts(null, idx), meta: idx.meta, artifactPath: 'docs/x.json' })
  assert.match(s, /UI 状态契约/)
  assert.match(s, /docs\/x\.json/)
  assert.match(s, /首次建立基线/)
})

test('formatBlock 无变化时不糊清单', () => {
  const idx = indexContract(doc([A()]))
  const s = formatBlock({ diff: diffContracts(idx, idx), meta: idx.meta })
  assert.match(s, /无变更/)
  assert.doesNotMatch(s, /先查这几条/)
})

test('formatBlock 有变化时逐条点明变了哪一维', () => {
  const prev = indexContract(doc([A(), A({ testid: 'gone-btn' })]))
  const next = indexContract(doc([
    A({ board: 'sampleReview', authCodes: ['NEW-AUTH'] }),
    A({ testid: 'new-btn', subTab: '7', statusFields: ['status'] }),
  ]))
  const s = formatBlock({ diff: diffContracts(prev, next), meta: next.meta })
  assert.match(s, /3 处变化/)
  assert.match(s, /先查这几条/)
  assert.match(s, /看板 priceReview → sampleReview/)
  assert.match(s, /权限码 \[GYS-SAMPLING-SUPPLY-011\] → \[NEW-AUTH\]/)
  assert.match(s, /\+ new-btn/)
  assert.match(s, /子tab=7/)
  assert.match(s, /- gone-btn/)
  assert.match(s, /消失（被删或改名）/)
})

test('formatBlock 变更超上限时截断并说明剩余（不静默吞）', () => {
  const mk = (n, over) => Array.from({ length: n }, (_, i) => A({ testid: 't' + i, ...over }))
  const prev = indexContract(doc(mk(20)))
  const next = indexContract(doc(mk(20, { board: 'sampleReview' })))
  const s = formatBlock({ diff: diffContracts(prev, next), meta: next.meta, maxItems: 5 })
  assert.match(s, /20 处变化/)
  assert.match(s, /还有 15 处/)
})

test('formatBlock 刷新失败要如实说明并给回退指引', () => {
  const s = formatBlock({ error: 'Cannot find module typescript', artifactPath: 'docs/x.json' })
  assert.match(s, /本次刷新失败/)
  assert.match(s, /Cannot find module typescript/)
  assert.match(s, /旧产物/)
  assert.match(s, /回退去读源码谓词/)
})

test('formatBlock 只变了条件表达式（未变维度）也要报出来', () => {
  const prev = indexContract(doc([A()]))
  const next = indexContract(doc([A({ conditionReadable: "(boardMode === 'priceReview') && (record.priceReviewStatus === 1) && extraGuard" })]))
  const s = formatBlock({ diff: diffContracts(prev, next), meta: next.meta })
  assert.match(s, /可见条件表达式变了/)
})
