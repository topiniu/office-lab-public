import test from 'node:test'
import assert from 'node:assert/strict'
import { fakeGreenHunt, renderTrustSection, intakeMisjudge, renderMisjudge, fileEscapeCase, renderEscapeCase, ESCAPE_GATE_MAP } from '../audit-trust.js'

const G = (id, over = {}) => ({ facetId: id, status: 'COVERED_GREEN', greenOk: true, hasRed: true, green: { runId: 'run-' + id }, ...over })

// ---------- F1 假绿猎手 ----------
test('猪猪缺位 → 只算引擎那一半，可信度如实标出「未验证」', () => {
  const h = fakeGreenHunt({ rows: [G('A-F1'), G('A-F2')], verify: null })
  assert.equal(h.greenCount, 2)
  assert.equal(h.unverified.length, 2)
  assert.equal(h.fakeGreenCount, 0)
  assert.equal(h.trustedCount, 0)
  assert.match(renderTrustSection(h), /未验证 ≠ 通过/)
})
test('「同 REQ 已有真绿却停在 SOURCE_ATTESTED」被纳入可信度视图（coverage.js 已算，这里收进来）', () => {
  const h = fakeGreenHunt({ rows: [G('A-F1')], verify: {}, extra: { suspectAttestations: ['A-F2'] } })
  assert.ok(h.findings.some(f => f.code === 'attested_while_green_exists'))
})
test('环境指纹整体陈旧 → 整批不可信，可信度直接判 0（不是逐条打折）', () => {
  const h = fakeGreenHunt({ rows: [G('A-F1'), G('A-F2')], verify: { 'A-F1': { ok: true, failureClass: 'value-assertion' }, 'A-F2': { ok: true, failureClass: 'value-assertion' } }, extra: { envFingerprintFresh: false } })
  assert.equal(h.trustScore, 0)
  assert.ok(h.batchWide.some(b => b.code === 'stale_env_batch'))
  assert.match(renderTrustSection(h), /整批级问题/)
})
test('拿不到环境指纹 → 记「未验证新鲜度」而不是当新鲜', () => {
  const h = fakeGreenHunt({ rows: [G('A-F1')], verify: {}, extra: { envFingerprintFresh: null } })
  assert.ok(h.batchWide.some(b => b.code === 'env_unknown'))
})
test('页面报错的 run → 其签发的绿全部可疑', () => {
  const h = fakeGreenHunt({ rows: [G('A-F1')], verify: {}, extra: { pageErrorRuns: ['r1', 'r2'] } })
  assert.ok(h.batchWide.some(b => b.code === 'page_error_batch'))
})
test('全部真绿 → 可信度 100%', () => {
  const verify = { 'A-F1': { ok: true, failureClass: 'value-assertion', discriminativePower: 0.9, pageErrors: 0, envFresh: true } }
  const h = fakeGreenHunt({ rows: [G('A-F1')], verify, extra: { envFingerprintFresh: true } })
  assert.equal(h.trustScore, 1)
  assert.equal(h.fakeGreenCount, 0)
})
test('没有 GREEN 行时不炸、渲染给出「无可抽查」', () => {
  const h = fakeGreenHunt({ rows: [{ facetId: 'A-F1', status: 'UNCOVERED' }] })
  assert.equal(h.greenCount, 0)
  assert.equal(h.trustScore, null)
  assert.match(renderTrustSection(h), /无可抽查/)
})

// ---------- F2 intake 误判审计 ----------
test('算出 eligibility_misjudge 比例与到被推翻的间隔', () => {
  const m = intakeMisjudge([
    { req: 'REQ-0302', judgedUnambiguousAt: '2026-08-21T00:00:00Z', reworkEvents: [{ at: '2026-08-22T00:00:00Z', kind: 'user-reject', note: '上线当天用户要存量' }] },
    { req: 'REQ-0303', judgedUnambiguousAt: '2026-08-21T00:00:00Z', reworkEvents: [] },
  ])
  assert.equal(m.judgedCount, 2)
  assert.equal(m.misjudged.length, 1)
  assert.equal(m.misjudgeRate, 0.5)
  assert.equal(m.misjudged[0].hoursToReversal, 24)
})
test('三种误判形态各自触发对应的「哪项拷问该加严」建议', () => {
  const mk = kind => intakeMisjudge([{ req: 'R', judgedUnambiguousAt: '2026-08-21T00:00:00Z', reworkEvents: [{ kind }] }]).probeAdvice.join()
  assert.match(mk('user-reject'), /「范围」拷问加严/)
  assert.match(mk('semantics-reversal'), /「口径」拷问加严/)
  assert.match(mk('rework'), /「影响面」拷问加严/)
})
test('没被判过零歧义的条目不进分母', () => {
  const m = intakeMisjudge([{ req: 'R', reworkEvents: [{ kind: 'rework' }] }])
  assert.equal(m.judgedCount, 0)
  assert.equal(m.misjudgeRate, null)
  assert.match(renderMisjudge(m), /没有「被判零歧义并跑了」的条目/)
})

// ---------- F3 逃逸复盘自动立案 ----------
test('非逃逸（不是上线后/人工发现）不立案', () => {
  const c = fileEscapeCase({ defect: '按钮位置偏了', foundBy: 'E2E 批次红了' })
  assert.equal(c.shouldFile, false)
  assert.equal(renderEscapeCase(c), '')
})
test('「输入即崩」定位到页面报错门 Z-A（这两个月的逃逸就是这么定位的）', () => {
  const c = fileEscapeCase({ defect: '新建品类输入即崩，TypeError', foundBy: '老板手工贴报错发现', req: 'REQ-0311' })
  assert.equal(c.shouldFile, true)
  assert.ok(c.gates.some(g => g.capability === 'Z-A'))
  assert.match(renderEscapeCase(c), /本该拦住的门/)
})
test('「四入口三套序」定位到跨入口一致性 Z-J', () => {
  const c = fileEscapeCase({ defect: '部位顺序在四个入口有三套序，不一致', foundBy: '老板一句话报出' })
  assert.ok(c.gates.some(g => g.capability === 'Z-J'))
})
test('「上线当天要存量」定位到窄口径声明（lab 侧，不是猪猪能力）', () => {
  const c = fileEscapeCase({ defect: '损耗率默认值只做了新增行，用户要存量也带出', foundBy: '上线后用户反馈' })
  assert.ok(c.gates.some(g => /窄口径声明/.test(g.gate)))
})
test('门谱里一道门都匹配不上 → 标 novel，并点明「需新建门而非加强现有的」', () => {
  const c = fileEscapeCase({ defect: '某个前所未见的形态 zzzqqq', foundBy: '上线后用户反馈' })
  assert.equal(c.novel, true)
  assert.match(renderEscapeCase(c), /需要新建一道门/)
})
test('门谱每条都带「同类先例」（复盘要能指回一件真事）', () => {
  for (const g of ESCAPE_GATE_MAP) { assert.ok(g.precedent && g.precedent.length > 4, g.gate); assert.ok(g.labSide, g.gate) }
})
