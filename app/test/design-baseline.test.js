import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyElement, testIdOf, flattenObservations, buildDesignBaseline, baselineConfidence, MIN_CLASS_SAMPLES,
  judgeAgainstBaseline, designConformance, ALIGN_TOLERANCE_PX,
  AESTHETIC_RUBRIC, AESTHETIC_VERDICTS, validateAestheticVerdict, checkAestheticDiligence, minShotsToView,
  renderBaselineSummary, renderBaselineJudgement, renderConformance, renderAestheticMaterial, renderAestheticVerdict,
} from '../design-baseline.js'

const sel = id => `[data-testid="${id}"]`
// 真实素材形状（截自 2026-09-07 供应链看板 visual-review.json）
const mkItem = (id, tokens, over = {}) => ({
  kind: 'peers', selector: sel(id), box: { x: 0, y: 224, width: 82, height: 32 },
  tokens: { fontSize: 14, fontWeight: '400', lineHeight: 22, fontFamily: '-apple-system', borderRadius: 2, borderWidth: 1, paddingTop: 4, paddingRight: 15, paddingBottom: 4, paddingLeft: 15, gap: null, color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(24, 144, 255)', borderColor: 'rgb(24, 144, 255)', ...tokens },
  accessibility: { contrastRatio: 3.24, hitTargetOk: false }, truncation: { clipped: false }, viewport: { width: 1440, height: 900 },
  ...over,
})

// ---------- 分类 ----------
test('testid 命名约定 → 元素类（具体的先匹配，btn 泛化在后）', () => {
  assert.equal(classifyElement(sel('sampling-supply-chain-board-search-btn')), 'primary-btn')
  assert.equal(classifyElement(sel('sampling-supply-chain-board-reset-btn')), 'secondary-btn')
  assert.equal(classifyElement(sel('sampling-supply-chain-board-dispatch-btn')), 'action-btn')
  assert.equal(classifyElement(sel('sampling-costorder-table')), 'table')
  assert.equal(classifyElement(sel('sampling-create-task-modal')), 'modal')
  assert.equal(classifyElement(sel('sampling-whatever-xyz')), 'other')
})
test('selector → testid（拿不到就退回原串，不炸）', () => {
  assert.equal(testIdOf(sel('a-b')), 'a-b')
  assert.equal(testIdOf('.ant-table'), '')
})

// ---------- 素材摊平 ----------
test('peers 里的隔壁元素也算样本（一次 assertVisualPeers 采齐整页 token，采样套件靠这个省事）', () => {
  const items = [mkItem('a-search-btn', {}, { peers: [{ selector: sel('a-reset-btn'), found: true, tokens: { fontSize: 14, borderRadius: 2 } }] })]
  const obs = flattenObservations(items)
  assert.equal(obs.length, 2)
  assert.ok(obs.some(o => o.selector === sel('a-reset-btn')))
})
test('找不到的 peer 不算样本（没测到 ≠ 一致）', () => {
  const items = [mkItem('a-search-btn', {}, { peers: [{ selector: sel('gone'), found: false, tokens: null }] })]
  assert.equal(flattenObservations(items).length, 1)
})
test('同一 selector 重复采到只算一份（否则多数票被重复采样刷票）', () => {
  const obs = flattenObservations([mkItem('a-search-btn'), mkItem('a-search-btn')])
  assert.equal(obs.length, 1)
})

// ---------- 建基线 ----------
test('规范值是「模块里多数同类元素是什么」数出来的，带 count/total', () => {
  const items = [
    mkItem('p1-search-btn', { borderRadius: 2 }), mkItem('p2-search-btn', { borderRadius: 2 }),
    mkItem('p3-search-btn', { borderRadius: 2 }), mkItem('p4-search-btn', { borderRadius: 8 }),
  ]
  const b = buildDesignBaseline(items, { module: '示例项目', pages: ['p1', 'p2'] })
  const spec = b.byClass['primary-btn'].tokens.borderRadius
  assert.equal(spec.value, 2)
  assert.equal(spec.count, 3)
  assert.equal(spec.total, 4)
  assert.equal(b.sampleCount, 4)
  assert.match(renderBaselineSummary(b), /模块设计基线/)
})
test('语义上本该不同的 token（主色/文字色/对齐）不参与多数票——主次按钮主色不同不是错', () => {
  const b = buildDesignBaseline([mkItem('a-search-btn'), mkItem('a-reset-btn', { color: 'rgba(0,0,0,0.85)', backgroundColor: 'rgb(255,255,255)' })])
  for (const cls of Object.keys(b.byClass)) {
    assert.equal(b.byClass[cls].tokens.color, undefined)
    assert.equal(b.byClass[cls].tokens.backgroundColor, undefined)
  }
})
test('模块刻度 = 出现 ≥2 次的尺寸值（只出现一次的不算刻度，会被判刻度外）', () => {
  const b = buildDesignBaseline([
    mkItem('a-search-btn', { paddingLeft: 15 }), mkItem('b-search-btn', { paddingLeft: 15 }),
    mkItem('c-search-btn', { paddingLeft: 7 }),
  ])
  assert.deepEqual(b.scales.paddingLeft.scale, [15])
})
test('样本不足的类别标 low confidence，明说「别据此打回开发」', () => {
  const b = buildDesignBaseline([mkItem('a-search-btn')])
  const c = baselineConfidence(b, 'primary-btn')
  assert.equal(c.level, 'low')
  assert.match(c.why, /不足以当模块规范/)
  assert.ok(MIN_CLASS_SAMPLES >= 3)
})

// ---------- 判定 ----------
const BASE = buildDesignBaseline([
  mkItem('p1-search-btn'), mkItem('p2-search-btn'), mkItem('p3-search-btn'), mkItem('p4-search-btn'),
  mkItem('p1-reset-btn', { color: 'rgba(0,0,0,0.85)' }), mkItem('p2-reset-btn', { color: 'rgba(0,0,0,0.85)' }), mkItem('p3-reset-btn', { color: 'rgba(0,0,0,0.85)' }),
])
test('没有基线 → 判不了（标准得先存在），不静默放过', () => {
  const j = judgeAgainstBaseline([mkItem('x-search-btn')], null)
  assert.equal(j.available, false)
  assert.match(j.why, /先跑采样套件/)
  assert.match(renderBaselineJudgement(j), /判不了/)
})
test('与模块规范一致 → 零偏离', () => {
  const j = judgeAgainstBaseline([mkItem('new-search-btn')], BASE)
  assert.equal(j.available, true)
  assert.equal(j.deviations.length, 0)
  assert.match(renderBaselineJudgement(j), /没有偏离/)
})
test('★ 偏离时给的是「模块里 4/4 个同类是 2，你是 8」这种数出来的判据，不是我编的阈值', () => {
  const j = judgeAgainstBaseline([mkItem('new-search-btn', { borderRadius: 8 })], BASE)
  const d = j.deviations.find(x => x.token === 'borderRadius')
  assert.ok(d)
  assert.equal(d.actual, 8)
  assert.equal(d.canonical, 2)
  assert.equal(d.total, 4)
  assert.equal(d.alsoSeen, 0)
  assert.match(d.why, /模块里没有第二个这么写的/)
  assert.match(renderBaselineJudgement(j), /⚠/)
})
test('★ 被判元素自己在基线样本里时，不许拿自己当「模块里也有人这么写」的证据', () => {
  // 真实形状：采样套件采过的元素后来又被判定（供应链表格 padding=8，另 4 个板是 0）。
  // 不扣掉自己的话，「模块里没有第二个这么写的」会被它自己降级成「并存两套写法」——自己给自己作证。
  const base = buildDesignBaseline([
    mkItem('p1-table', { borderRadius: 0 }), mkItem('p2-table', { borderRadius: 0 }),
    mkItem('p3-table', { borderRadius: 0 }), mkItem('p4-table', { borderRadius: 0 }),
    mkItem('sc-table', { borderRadius: 8 }),
  ])
  const j = judgeAgainstBaseline([mkItem('sc-table', { borderRadius: 8 })], base)
  const d = j.deviations.find(x => x.token === 'borderRadius')
  assert.equal(d.selfInBaseline, true)
  assert.equal(d.alsoSeen, 0, '自己那一票必须扣掉')
  assert.match(d.why, /模块里没有第二个这么写的/)
  assert.match(d.why, /不许自己给自己作证/)
  assert.match(renderBaselineJudgement(j), /⚠/)
})
test('模块内并存两套写法时降级为「值得统一，不一定是错」，并排在后面', () => {
  const base = buildDesignBaseline([mkItem('a-search-btn', { fontSize: 14 }), mkItem('b-search-btn', { fontSize: 14 }), mkItem('c-search-btn', { fontSize: 12 })])
  const j = judgeAgainstBaseline([mkItem('new-search-btn', { fontSize: 12 })], base)
  const d = j.deviations.find(x => x.token === 'fontSize')
  assert.equal(d.alsoSeen, 1)
  assert.match(d.why, /并存两套写法/)
})

// ---------- 量化指标 ----------
test('刻度外值：尺寸没落在模块刻度上就报，并把刻度一起说出来', () => {
  const c = designConformance([mkItem('new-search-btn', { paddingLeft: 7 })], BASE)
  const hit = c.offScale.find(o => o.token === 'paddingLeft')
  assert.ok(hit)
  assert.match(hit.why, /不在模块刻度/)
  assert.match(renderConformance(c), /刻度外值/)
})
test('对齐：同一视觉行元素上边缘差超容差即报（同行内 ≤2px 不报）', () => {
  const a = mkItem('a-search-btn', {}, { box: { x: 0, y: 224, width: 82, height: 32 } })
  const b = mkItem('b-reset-btn', {}, { box: { x: 100, y: 229, width: 82, height: 32 } })
  const c = designConformance([a, b], BASE)
  assert.equal(c.misaligned.length, 1)
  assert.equal(c.misaligned[0].spread, 5)
  const ok = designConformance([a, mkItem('c-reset-btn', {}, { box: { x: 100, y: 225, width: 82, height: 32 } })], BASE)
  assert.equal(ok.misaligned.length, 0)
  assert.ok(ALIGN_TOLERANCE_PX >= 1)
})
test('用量：本页字号/圆角种类数与「模块里从未出现过的值」都列出来', () => {
  const c = designConformance([mkItem('a-search-btn', { fontSize: 14 }), mkItem('b-search-btn', { fontSize: 20 })], BASE)
  assert.equal(c.variety.fontSize.here, 2)
  assert.ok(c.variety.fontSize.unknown.includes(20))
})
test('没有基线时对齐仍可算（它不需要参照物）', () => {
  const a = mkItem('a-search-btn', {}, { box: { x: 0, y: 10, width: 10, height: 10 } })
  const b = mkItem('b-reset-btn', {}, { box: { x: 20, y: 18, width: 10, height: 10 } })
  const c = designConformance([a, b], null)
  assert.equal(c.available, false)
  assert.equal(c.misaligned.length, 1)
})

// ---------- 审美判定的证据强制 ----------
const CTX = { items: [mkItem('a-search-btn', { borderRadius: 8 })], deviations: [{ selector: sel('a-search-btn'), token: 'borderRadius' }], offScale: [], misaligned: [] }
const good = {
  verdict: AESTHETIC_VERDICTS.DIFF,
  findings: [{ rubricKey: 'family', selector: sel('a-search-btn'), fact: 'borderRadius=8，模块里 4/4 个同类是 2', opinion: '这个按钮一眼看出是外来的', suggestion: '圆角改回 2px，与模块其它看板一致' }],
}
test('rubric 覆盖八个维度且每条都在问「指认哪个元素」', () => {
  assert.equal(AESTHETIC_RUBRIC.length, 8)
  for (const r of AESTHETIC_RUBRIC) { assert.ok(r.key); assert.ok(r.label); assert.match(r.ask, /\?|？/) }
})
test('合规的审美结论：带 rubricKey + 真实元素 + 实测事实 + 可执行建议 → 通过', () => {
  const v = validateAestheticVerdict(good, CTX)
  assert.equal(v.ok, true)
  assert.equal(v.accepted.length, 1)
  assert.match(renderAestheticVerdict(good, v), /可接受但有偏离/)
})
test('★ 指认了素材里不存在的元素 → 打回（不许凭印象说不好看）', () => {
  const v = validateAestheticVerdict({ verdict: AESTHETIC_VERDICTS.BAD, findings: [{ rubricKey: 'family', selector: sel('not-collected'), fact: 'x', suggestion: 'y' }] }, CTX)
  assert.equal(v.ok, false)
  assert.match(v.rejected[0].reason, /不在本轮素材里/)
})
test('★ 没有实测值也不对应任何量化偏离 → 判「这是读后感不是判定」', () => {
  const v = validateAestheticVerdict({ verdict: AESTHETIC_VERDICTS.BAD, findings: [{ rubricKey: 'rhythm', selector: sel('a-search-btn'), suggestion: '调整一下' }] }, CTX)
  assert.match(v.rejected[0].reason, /读后感/)
})
test('★ 说了不好看却没给可执行建议 → 打回（开发无法动手）', () => {
  const v = validateAestheticVerdict({ verdict: AESTHETIC_VERDICTS.BAD, findings: [{ rubricKey: 'family', selector: sel('a-search-btn'), fact: 'borderRadius=8' }] }, CTX)
  assert.match(v.rejected[0].reason, /可执行建议/)
})
test('★ 判了非「符合」档却一条证据都没有 → 明确报错，不许无证据打回', () => {
  const v = validateAestheticVerdict({ verdict: AESTHETIC_VERDICTS.BAD, findings: [] }, CTX)
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => /不许无证据打回/.test(e)))
})
test('verdict 不在三档内 → 报错（不许自造档位）', () => {
  const v = validateAestheticVerdict({ verdict: '还行吧', findings: [] }, CTX)
  assert.ok(v.errors.some(e => /三档之一/.test(e)))
})
test('rubricKey 不在 rubric 里 → 打回（不许自造维度）', () => {
  const v = validateAestheticVerdict({ verdict: AESTHETIC_VERDICTS.DIFF, findings: [{ rubricKey: 'vibe', selector: sel('a-search-btn'), fact: 'x', suggestion: 'y' }] }, CTX)
  assert.match(v.rejected[0].reason, /rubricKey 不在 rubric 里/)
})
test('素材页明写「你要看图」+ 提交要求 + 老板终审边界', () => {
  const md = renderAestheticMaterial({ screenshots: ['a.png'], referenceShots: ['ref.png'], deviations: CTX.deviations })
  assert.match(md, /你要看图/)
  assert.match(md, /指不出元素、给不出改法的，一律不算判定/)
  assert.match(md, /老板是终审/)
  assert.match(md, /像不像一家人/)
})

// ---------- 看图门 + 逐维作答（2026-10-06）----------
// 实账：七次审美判定全是「符合、零发现」，每次素材列 12 张图、只 Read 了 1~4 张。
const BS = String.fromCharCode(92)   // 反斜杠：Windows 截图路径的原样写法
const shots = n => Array.from({ length: n }, (_, i) => ['D:', 'runs', 'steps', `${String(i + 1).padStart(2, '0')}-after.png`].join(BS))
const OBS = Object.fromEntries(AESTHETIC_RUBRIC.map(r => [r.key, `${r.label}：主按钮在右上、与母版同位同尺寸`]))
test('要看的张数：≤3 全看；更多至少一半', () => {
  assert.equal(minShotsToView(0), 0)
  assert.equal(minShotsToView(2), 2)
  assert.equal(minShotsToView(4), 3)
  assert.equal(minShotsToView(12), 6)
})
test('★ 实账形状：列了 12 张只看 1 张就判「符合」→ 打回', () => {
  const list = shots(12)
  const d = checkAestheticDiligence({ observations: OBS }, { listedShots: list, readShots: [list[0]] })
  assert.equal(d.ok, false)
  assert.ok(d.errors.some(e => /只 Read 了 1 张（至少要看 6 张）/.test(e)))
})
test('看够了图 + 八维都有观察 → 通过；路径写法不同也认（/d/ 与反斜杠）', () => {
  const list = shots(12)
  const read = list.slice(0, 6).map(p => '/d/' + p.slice(3).split(String.fromCharCode(92)).join('/'))
  const d = checkAestheticDiligence({ observations: OBS }, { listedShots: list, readShots: read })
  assert.equal(d.ok, true, JSON.stringify(d.errors))
  assert.equal(d.seen, 6)
})
test('★ 判「符合」但维度写空话 → 打回并点名', () => {
  const list = shots(2)
  const d = checkAestheticDiligence({ observations: { ...OBS, density: '正常', color: '' } }, { listedShots: list, readShots: list })
  assert.ok(d.errors.some(e => /密度与可读/.test(e) && /色彩与语义/.test(e)))
})
test('★ 给了母版参照却一张没看 → 打回', () => {
  const list = shots(2)
  const d = checkAestheticDiligence({ observations: OBS }, { listedShots: list, referenceShots: ['D:/ref/mother.png'], readShots: list })
  assert.ok(d.errors.some(e => /母版/.test(e)))
})
