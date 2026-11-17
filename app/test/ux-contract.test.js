import test from 'node:test'
import assert from 'node:assert/strict'
import {
  UX_CONTRACTS, ADOPTION_CONVENTION, ADOPTION_CANDIDATE, LEVEL_CONVENTION, LEVEL_CANDIDATE, LEVEL_RARE,
  ackOf, scanUxContracts, judgeChangedFiles, renderInventory, renderChangedCheck,
  discoverCandidates, renderCandidates,
} from '../ux-contract.js'

const f = (file, src) => ({ file, src })
const uploadOk = src => f(src, '<Upload multiple>\nconst x = useClipboardImages()')
const modalSrc = (file, extra = '') => f(file, `<Modal title="x" open>\n${extra}\n</Modal>`)

// ---------- 契约清单本身 ----------
test('每条契约都有 applies/satisfies 判据 + 为什么 + 共享实现 + 怎么补', () => {
  assert.ok(UX_CONTRACTS.length >= 2)
  for (const c of UX_CONTRACTS) {
    assert.equal(typeof c.applies, 'function', c.key)
    assert.equal(typeof c.satisfies, 'function', c.key)
    assert.ok(c.why && c.shared && c.suggest, c.key + ' 缺 why/shared/suggest')
  }
})
test('老板点名的两条都在（upload 粘贴 / modal 快捷键提交）', () => {
  const keys = UX_CONTRACTS.map(c => c.key)
  assert.ok(keys.includes('upload-paste'))
  assert.ok(keys.includes('modal-cmd-enter'))
})

// ---------- 扫描与采纳率 ----------
test('采纳率是数出来的：3/4 → 60% 以上算「约定」', () => {
  const files = [
    f('pages/samplingDemo/a.tsx', '<Upload />\nuseClipboardImages()'),
    f('pages/samplingDemo/b.tsx', '<Upload />\nonPaste={h}'),
    f('pages/samplingDemo/c.tsx', '<Upload />\n<PasteImages />'),
    f('pages/samplingDemo/d.tsx', '<Upload />'),
  ]
  const s = scanUxContracts(files, UX_CONTRACTS.filter(c => c.key === 'upload-paste'))
  const c = s.byContract['upload-paste']
  assert.equal(c.applies.length, 4)
  assert.equal(c.satisfied.length, 3)
  assert.equal(c.level, LEVEL_CONVENTION)
  assert.equal(c.missing[0].file, 'pages/samplingDemo/d.tsx')
})
test('★ 采纳率低时自动降级成「候选」——不许拿一条模块自己都没统一的规矩去打人', () => {
  const files = [f('pages/samplingDemo/a.tsx', '<Upload />\nonPaste={h}'), f('pages/samplingDemo/b.tsx', '<Upload />'), f('pages/samplingDemo/c.tsx', '<Upload />')]
  const s = scanUxContracts(files, UX_CONTRACTS.filter(c => c.key === 'upload-paste'))
  assert.equal(s.byContract['upload-paste'].level, LEVEL_CANDIDATE)   // 33%
  assert.ok(ADOPTION_CANDIDATE < ADOPTION_CONVENTION)
})
test('极低采纳率判「零星」（连候选都算不上）', () => {
  const files = Array.from({ length: 10 }, (_, i) => f(`pages/samplingDemo/f${i}.tsx`, '<Upload />'))
  const s = scanUxContracts([...files, f('pages/samplingDemo/x.tsx', '<Upload />\nonPaste={h}')], UX_CONTRACTS.filter(c => c.key === 'upload-paste'))
  assert.equal(s.byContract['upload-paste'].level, LEVEL_RARE)
})
test('不适用的文件不进分母（没有 Upload 的文件不该被问粘贴）', () => {
  const s = scanUxContracts([f('pages/samplingDemo/a.tsx', '<Table />')], UX_CONTRACTS.filter(c => c.key === 'upload-paste'))
  assert.equal(s.byContract['upload-paste'].applies.length, 0)
  assert.equal(s.byContract['upload-paste'].adoption, 0)
})
test('快捷键提示契约只对「已绑快捷键」的文件适用（没绑的不该被问提示）', () => {
  const only = UX_CONTRACTS.filter(c => c.key === 'modal-shortcut-hint')
  const s = scanUxContracts([modalSrc('pages/samplingDemo/a.tsx'), f('pages/samplingDemo/b.tsx', 'useCommandEnterSubmit(x)')], only)
  assert.deepEqual(s.byContract['modal-shortcut-hint'].applies, ['pages/samplingDemo/b.tsx'])
})
test('页面级契约按路径判适用（只问页面入口 index.tsx）', () => {
  const only = UX_CONTRACTS.filter(c => c.key === 'page-breadcrumb')
  const s = scanUxContracts([
    f('pages/samplingWorkflow/index.tsx', 'export default X'),
    f('pages/samplingWorkflow/components/Foo.tsx', 'export default Y'),
  ], only)
  assert.deepEqual(s.byContract['page-breadcrumb'].applies, ['pages/samplingWorkflow/index.tsx'])
})

// ---------- 源码内申诉 ----------
test('ux-contract-ack 认得出契约 key 与理由', () => {
  assert.equal(ackOf('// ux-contract-ack: upload-paste 只收 PDF，粘贴无意义', 'upload-paste'), '只收 PDF，粘贴无意义')
  assert.equal(ackOf('// ux-contract-ack: upload-paste', 'upload-paste'), '(未写理由)')
  assert.equal(ackOf('// ux-contract-ack: other-key 理由', 'upload-paste'), '')
})
test('★ 申诉只记录、不豁免：仍算未守，采纳率照旧把它算进分母', () => {
  const files = [f('pages/samplingDemo/a.tsx', '<Upload />\nonPaste={h}'), f('pages/samplingDemo/b.tsx', '<Upload />\n// ux-contract-ack: upload-paste 只收 PDF')]
  const s = scanUxContracts(files, UX_CONTRACTS.filter(c => c.key === 'upload-paste'))
  const c = s.byContract['upload-paste']
  assert.equal(c.satisfied.length, 1)
  assert.equal(c.missing.length, 1)
  assert.equal(c.adoption, 0.5, '申诉不能把采纳率洗高')
  assert.equal(c.missing[0].ack, '只收 PDF')
  const j = judgeChangedFiles(s, ['pages/samplingDemo/b.tsx'])
  assert.equal(j.findings[0].verdict, 'acked')
  assert.match(renderChangedCheck(j, s), /已申诉/)
})

// ---------- 只判本次改动 ----------
test('只判改动到的文件，存量欠账不连坐（否则每次都被别人的债淹掉）', () => {
  const files = [f('pages/samplingDemo/old.tsx', '<Upload />'), f('pages/samplingDemo/new.tsx', '<Upload />'), f('pages/samplingDemo/ok1.tsx', '<Upload />\nonPaste={h}'), f('pages/samplingDemo/ok2.tsx', '<Upload />\nonPaste={h}')]
  const s = scanUxContracts(files, UX_CONTRACTS.filter(c => c.key === 'upload-paste'))
  const j = judgeChangedFiles(s, ['pages/samplingDemo/new.tsx'])
  assert.equal(j.findings.length, 1)
  assert.equal(j.findings[0].file, 'pages/samplingDemo/new.tsx')
})
test('结论必须带「模块里 N/M 这么做」+ 为什么 + 怎么补（不是丢一条规矩）', () => {
  const files = [f('pages/samplingDemo/new.tsx', '<Upload />'), ...Array.from({ length: 3 }, (_, i) => f(`pages/samplingDemo/ok${i}.tsx`, '<Upload />\nonPaste={h}'))]
  const s = scanUxContracts(files, UX_CONTRACTS.filter(c => c.key === 'upload-paste'))
  const md = renderChangedCheck(judgeChangedFiles(s, ['pages/samplingDemo/new.tsx']), s)
  assert.match(md, /模块里 \*\*3\/4\*\*/)
  assert.match(md, /为什么：/)
  assert.match(md, /怎么补：/)
  assert.match(md, /useClipboardImages/)
})
test('候选级只给「·提醒」不给「⚠漏了」（语气随采纳率变）', () => {
  const files = [f('pages/samplingDemo/new.tsx', '<Upload />'), f('pages/samplingDemo/ok.tsx', '<Upload />\nonPaste={h}'), f('pages/samplingDemo/no.tsx', '<Upload />')]
  const s = scanUxContracts(files, UX_CONTRACTS.filter(c => c.key === 'upload-paste'))
  const j = judgeChangedFiles(s, ['pages/samplingDemo/new.tsx'])
  assert.equal(j.findings[0].verdict, 'hint')
  const md = renderChangedCheck(j, s)
  assert.match(md, /候选级/)
  assert.ok(!/漏了 \d+ 处模块约定/.test(md))
})
test('全守住 → 明确说「都守住了」，不含糊', () => {
  const files = [f('pages/samplingDemo/a.tsx', '<Upload />\nonPaste={h}')]
  const s = scanUxContracts(files, UX_CONTRACTS.filter(c => c.key === 'upload-paste'))
  assert.match(renderChangedCheck(judgeChangedFiles(s, ['pages/samplingDemo/a.tsx']), s), /都守住了/)
})

// ---------- 盘点渲染 ----------
test('盘点表列采纳率与存量欠账，并写明「正则不是 AST」的边界', () => {
  const files = [f('pages/samplingDemo/a.tsx', '<Upload />\nonPaste={h}'), f('pages/samplingDemo/b.tsx', '<Upload />')]
  const md = renderInventory(scanUxContracts(files, UX_CONTRACTS.filter(c => c.key === 'upload-paste')))
  assert.match(md, /采纳率/)
  assert.match(md, /存量欠账/)
  assert.match(md, /源码正则不是 AST/)
  assert.match(md, /申诉不等于豁免/)
})

// ---------- 候选发现 ----------
test('候选发现只列不判，并说明为什么不判（applies 判据不可靠）', () => {
  const files = Array.from({ length: 6 }, (_, i) => f(`pages/samplingDemo/p${i}.tsx`, "import B from '@/components/BreadcrumbHeader'\nimport Q from '@/components/QueryPlaceholder'"))
  const list = discoverCandidates(files, { min: 5 })
  assert.equal(list.length, 2)
  assert.equal(list[0].files, 6)
  const md = renderCandidates(list, files.length)
  assert.match(md, /只列不判/)
  assert.match(md, /宁可少一条契约/)
})
test('同一文件重复 import 同一模块只计一次（别把引用数刷高）', () => {
  const files = [f('pages/samplingDemo/a.tsx', "from '@/components/CopySpan'\nfrom '@/components/CopySpan'")]
  assert.deepEqual(discoverCandidates(files, { min: 1 }), [{ module: '@/components/CopySpan', files: 1, alreadyContract: false }])
})

// ---------- 作用域：模块内 vs 全站共享（2026-09-08 首次真扫抓到的必需分层） ----------
test('★ 全站共享组件不进采纳率分母——混算会把真约定误判成候选（等于放过）', () => {
  // 真实形状：Modal ⌘+Enter 混算 31/59=53%「候选」，只看 pages/sampling* 则 31/39=79%「约定」
  const mod = [
    f('pages/samplingA/index.tsx', '<Modal />\nuseCommandEnterSubmit(x)'),
    f('pages/samplingB/index.tsx', '<Modal />\nuseCommandEnterSubmit(x)'),
    f('pages/samplingC/index.tsx', '<Modal />\nuseCommandEnterSubmit(x)'),
    f('pages/samplingD/index.tsx', '<Modal />'),
  ]
  const shared = Array.from({ length: 10 }, (_, i) => f(`components/Foo${i}/index.tsx`, '<Modal />'))
  const only = UX_CONTRACTS.filter(c => c.key === 'modal-cmd-enter')
  const c = scanUxContracts([...mod, ...shared], only).byContract['modal-cmd-enter']
  assert.equal(c.applies.length, 4, '分母只算模块内')
  assert.equal(c.adoption, 0.75)
  assert.equal(c.level, LEVEL_CONVENTION, '不许被全站共享组件拖成候选')
  assert.equal(c.sharedApplies.length, 10)
  assert.equal(c.sharedMissing.length, 10)
})
test('改到全站共享组件 → 判 cross-module，并明说「示例项目的约定管不到它」', () => {
  const files = [
    f('pages/samplingA/index.tsx', '<Modal />\nuseCommandEnterSubmit(x)'),
    f('pages/samplingB/index.tsx', '<Modal />\nuseCommandEnterSubmit(x)'),
    f('components/Shared/index.tsx', '<Modal />'),
  ]
  const only = UX_CONTRACTS.filter(c => c.key === 'modal-cmd-enter')
  const s = scanUxContracts(files, only)
  const j = judgeChangedFiles(s, ['components/Shared/index.tsx'])
  assert.equal(j.findings.length, 1)
  assert.equal(j.findings[0].verdict, 'cross-module')
  const md = renderChangedCheck(j, s)
  assert.match(md, /示例项目的约定管不到它们/)
  assert.match(md, /得更高层拍/)
  assert.ok(!/漏了 \d+ 处模块约定/.test(md), '跨模块的不算本次漏了')
})
test('没改到共享组件时，共享组件的欠账不出现在自查结论里（不连坐）', () => {
  const files = [f('pages/samplingA/index.tsx', '<Modal />'), f('components/Shared/index.tsx', '<Modal />')]
  const only = UX_CONTRACTS.filter(c => c.key === 'modal-cmd-enter')
  const s = scanUxContracts(files, only)
  const j = judgeChangedFiles(s, ['pages/samplingA/index.tsx'])
  assert.equal(j.findings.length, 1)
  assert.equal(j.findings[0].scope, 'module')
})
test('盘点里共享组件单列且写明「不进采纳率」', () => {
  const files = [f('pages/samplingA/index.tsx', '<Modal />\nuseCommandEnterSubmit(x)'), f('components/Shared/index.tsx', '<Modal />')]
  const md = renderInventory(scanUxContracts(files, UX_CONTRACTS.filter(c => c.key === 'modal-cmd-enter')))
  assert.match(md, /只按 `pages\/sampling\*` 算/)
  assert.match(md, /会把真约定误判成候选/)
})
