import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRESCREEN_DIMENSIONS, PRESCREEN_VERDICTS, dimensionOf, isHollowNote, normShotPath, isImagePath,
  parseMotherDoc, renderPrescreenMaterial, validatePrescreenVerdict, renderPrescreenVerdict,
  isPrecheckGateItem, isRetiredPrecheckGate, isBossSelfTestGate, prescreenNotApplicable,
} from '../visual-prescreen.js'

// fixture 取自 Temu v0.1.0 那 13 次打回里真实出现过的问题（09-29「档位名被挤成一字一行」等）
const SHOT = 'D:\\shots\\temu-scheme-drawer.png'
const MOTHER = '/workspace/office-lab/docs/示例项目需求/00-通用资料/母版/drawer-form.png'
const fullNotes = (text = '档位名与输入框同一行，宽度够、没有换行') => Object.fromEntries(PRESCREEN_DIMENSIONS.map(d => [d.key, `${d.label}：${text}`]))
const page = (extra = {}) => ({ page: '编辑方案抽屉·更多设置展开', screenshots: [SHOT], notes: fullNotes(), ...extra })
const squeeze = {
  page: '编辑方案抽屉·更多设置展开', dimension: 'layout-fit', severity: '高',
  observed: '「最大降价幅度」档位名被挤成一字一行', expected: '档位名一行显示、输入框占剩余宽度',
  reference: 'WCAG 1.4.10 Reflow；母版 drawer-form 同宽度下标签不换行', suggestion: '档位名固定宽度 nowrap，输入框 flex:1',
}
const READ = new Set([normShotPath(SHOT), normShotPath(MOTHER)])

test('诊断维度：每条都有出处、问句、母版对照；key 唯一', () => {
  assert.ok(PRESCREEN_DIMENSIONS.length >= 10)
  const keys = new Set()
  for (const d of PRESCREEN_DIMENSIONS) {
    assert.ok(d.key && d.label && d.source && d.mother, d.key)
    assert.match(d.ask, /\?|？/)
    assert.ok(['高', '中', '低'].includes(d.severity))
    assert.ok(!keys.has(d.key)); keys.add(d.key)
  }
  assert.equal(dimensionOf('layout-fit').label, '布局与容器')
  assert.equal(dimensionOf('vibe'), null)
})
test('空话判定：无/正常/符合/OK/太短都算没写', () => {
  for (const s of ['', '无', '正常', '符合', 'OK', '通过。', '还行']) assert.equal(isHollowNote(s), true, s)
  assert.equal(isHollowNote('主按钮在右上，与母版同位'), false)
})
test('截图路径归一：反斜杠 / 正斜杠 / git-bash /d/ 三种写法等价', () => {
  const a = normShotPath('D:\\x\\Y.png'), b = normShotPath('d:/x/y.png'), c = normShotPath('/d/x/y.png')
  assert.equal(a, b); assert.equal(b, c)
  assert.equal(isImagePath('a.PNG'), true); assert.equal(isImagePath('a.md'), false)
})

// ---------- 母版文档 ----------
const MOTHER_MD = `
| 型号 | 场景 | 母版页面 | 截图 | 要点 |
|------|------|----------|------|------|
| \`drawer-form\` | 抽屉表单 | 核价抽屉 | \`${MOTHER}\` | 标签左对齐、24px 内边距 |
| filter-bar | 筛选区 | 打样看板 | | 查询/重置在右 |
| 不是key | x | x | a.png | x |
`
test('母版解析：只认 kebab key 行；空截图的型如实记「未采」', () => {
  const m = parseMotherDoc(MOTHER_MD)
  assert.deepEqual(m.patterns.map(p => p.key), ['drawer-form', 'filter-bar'])
  assert.equal(m.shotCount, 1)
  assert.deepEqual(m.missing, ['filter-bar'])
})
test('素材页：列母版与维度；母版缺位时明说「未对照母版」', () => {
  const md = renderPrescreenMaterial({ pages: [{ page: 'p', screenshot: SHOT }], mother: parseMotherDoc(MOTHER_MD), motherPath: 'x.md' })
  assert.match(md, /母版：示例项目/)
  assert.match(md, /未采截图/)
  for (const d of PRESCREEN_DIMENSIONS) assert.ok(md.includes(d.key))
  assert.match(renderPrescreenMaterial({ pages: [] }), /母版缺位/)
})

// ---------- 结论校验 ----------
test('合规打回：看过图 + 逐维作答 + 发现带依据和建议 → 接受', () => {
  const v = validatePrescreenVerdict({ verdict: PRESCREEN_VERDICTS.REJECT, pages: [page()], findings: [squeeze] }, { readShots: READ, motherShots: [MOTHER] })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
  assert.equal(v.counts.高, 1)
  assert.match(renderPrescreenVerdict({ verdict: '打回', pages: [page()] }, v), /一字一行/)
})
test('合规通过：零发现也可以，前提是看过图、逐维写了', () => {
  const v = validatePrescreenVerdict({ verdict: PRESCREEN_VERDICTS.PASS, pages: [page()], findings: [] }, { readShots: READ, motherShots: [MOTHER] })
  assert.equal(v.ok, true, JSON.stringify(v.errors))
})
test('★ 截图本轮没 Read 过 → 不接受（没看过的图不能出结论）', () => {
  const v = validatePrescreenVerdict({ verdict: '通过', pages: [page()], findings: [] }, { readShots: new Set([normShotPath(MOTHER)]), motherShots: [MOTHER] })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => /没 Read 过/.test(e)))
})
test('★ 母版有截图却一张没看 → 不接受（「与母版一致」成了空判）', () => {
  const v = validatePrescreenVerdict({ verdict: '通过', pages: [page()], findings: [] }, { readShots: new Set([normShotPath(SHOT)]), motherShots: [MOTHER] })
  assert.ok(v.errors.some(e => /母版/.test(e)))
})
test('母版缺位（没有母版截图）不拦——照跑，报告里写明', () => {
  const v = validatePrescreenVerdict({ verdict: '通过', pages: [page()], findings: [] }, { readShots: new Set([normShotPath(SHOT)]), motherShots: [] })
  assert.equal(v.ok, true)
  assert.match(renderPrescreenVerdict({ verdict: '通过' }, v, { motherMissing: true }), /未对照母版/)
})
test('★ 有维度写空话 → 不接受，并点名是哪几维', () => {
  const notes = { ...fullNotes(), spacing: '正常', minimalism: '无' }
  const v = validatePrescreenVerdict({ verdict: '通过', pages: [page({ notes })], findings: [] }, { readShots: READ, motherShots: [MOTHER] })
  assert.ok(v.errors.some(e => /间距与留白/.test(e) && /简洁克制/.test(e)))
})
test('★ 有高危却判通过 → 不接受', () => {
  const v = validatePrescreenVerdict({ verdict: '通过', pages: [page()], findings: [squeeze] }, { readShots: READ, motherShots: [MOTHER] })
  assert.ok(v.errors.some(e => /高.*只能打回|高危只能打回/.test(e)))
})
test('★ 打回却没有一条合规发现 → 不接受', () => {
  const v = validatePrescreenVerdict({ verdict: '打回', pages: [page()], findings: [] }, { readShots: READ, motherShots: [MOTHER] })
  assert.ok(v.errors.some(e => /打回要给开发/.test(e)))
})
test('★ 发现缺依据 / 缺建议 / 页面没报过 / 维度自造 → 逐条打回', () => {
  const bad = [
    { ...squeeze, reference: '' },
    { ...squeeze, suggestion: '' },
    { ...squeeze, page: '没截过的页' },
    { ...squeeze, dimension: 'vibe' },
  ]
  const v = validatePrescreenVerdict({ verdict: '打回', pages: [page()], findings: bad }, { readShots: READ, motherShots: [MOTHER] })
  assert.equal(v.rejected.length, 4)
  assert.match(v.rejected[0].reason, /reference/)
  assert.match(v.rejected[1].reason, /suggestion/)
  assert.match(v.rejected[2].reason, /不在本次报的页面里/)
  assert.match(v.rejected[3].reason, /dimension 不在/)
})
test('verdict 只认两档；一页都没报不行', () => {
  const v = validatePrescreenVerdict({ verdict: '还行', pages: [], findings: [] }, {})
  assert.ok(v.errors.some(e => /通过」或「打回/.test(e)))
  assert.ok(v.errors.some(e => /一页都没报/.test(e)))
})

// ---------- 收工判定 ----------
test('收工门识别：人工预检门 + 「视觉初筛：不适用」声明要有理由', () => {
  assert.equal(isPrecheckGateItem('人工预检｜见预检单'), true)
  assert.equal(isPrecheckGateItem('F88 权限怎么配'), false)
  assert.equal(prescreenNotApplicable('视觉初筛：不适用（纯后端接口改动，无页面变化）'), '纯后端接口改动，无页面变化')
  assert.equal(prescreenNotApplicable('视觉初筛：不适用'), null)
  assert.equal(prescreenNotApplicable('没提这事'), null)
})

// 2026-10-22 人工预检门撤销：「人工预检」一律当已撤销门退回；「老板亲测」是唯一合法的 QA 前交老板
test('收工门识别：已撤销的人工预检 vs 老板亲测例外 vs 最终验收', () => {
  assert.equal(isRetiredPrecheckGate('人工预检｜见预检单'), true)
  assert.equal(isRetiredPrecheckGate('老板亲测｜VELATTI 开演练'), false)
  assert.equal(isBossSelfTestGate('老板亲测｜VELATTI 开演练'), true)
  assert.equal(isPrecheckGateItem('老板亲测｜VELATTI 开演练'), true)
  // QA 之后的最终验收不是「QA 前交老板」，要照常按覆盖率闸门判
  assert.equal(isPrecheckGateItem('最终验收｜8 条全绿'), false)
  assert.equal(isRetiredPrecheckGate('最终验收｜8 条全绿'), false)
})
