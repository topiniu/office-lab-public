// facet_doc 多文档：frontmatter 读写往返 + 分母取并集。
//
// 缘起 2026-09-03（老板看 v5.21 的 facet 覆盖明细，判据一片空白）：`facet_doc` 是个标量，而一版聚合多条 REQ 时
// facet 分散在各自的《需求说明与验收标准》里（v5.21 共 9 份）。`seed_coverage` 每播一份就 **无条件改写** 这个指针，
// 于是中途插单播一次、版本主文档的指针就被顶掉一次——最后播的那份赢（v5.21 停在 REQ-0247 那份，14 条）。
// 后果两层：① 看板上其余 135 条 facet 全成 unlisted、判据原文为空（矩阵里不存判据，谁也补不回来）；
//          ② **门禁分母跟着塌到 14**，剩下的 facet 根本不进 computeCoverage 的 gaps ＝ fail-open。
// 本测试钉住：写侧能把列表写成块列表并原样读回、形态来回切换不留孤儿 `- ` 行、分母取并集。
//
// server.js 是自启服务的单体（import 即 listen），沿用 test/release-deliverables.test.js 的做法：
// 按名从源码抠出定义、在 vm 里 eval 后测。抠不到就抛错（不静默测空壳）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

import { facetDocList, mergeFacetSets, extractFacetsFromDoc, computeCoverage } from '../coverage.js'

const src = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'server.js'), 'utf8')
function grab(name, re) {
  const m = src.match(re)
  if (!m) throw new Error(`抠不到 ${name}：server.js 结构变了，请同步更新 test/facet-doc-multi.test.js`)
  return m[0]
}
const sandbox = { fs, path, console, crypto: (await import('node:crypto')).default, resolveRepoFile: () => null, facetDocList, mergeFacetSets, extractFacetsFromDoc }
const ctx = vm.createContext(sandbox)
vm.runInContext([
  grab('findComment', /^function findComment\(s\) \{[\s\S]*?\n\}/m),
  grab('coerce', /^function coerce\(v\) \{[\s\S]*?\n\}/m),
  grab('parseFrontmatter', /^function parseFrontmatter\(text\) \{[\s\S]*?\n\}/m),
  grab('atomicWrite', /^function atomicWrite\(abs, content\) \{[\s\S]*?\n\}/m),
  grab('engineSetFrontmatterScalar', /^function engineSetFrontmatterScalar\(abs, key, value\) \{[\s\S]*?\n\}/m),
  grab('engineSetFrontmatterList', /^function engineSetFrontmatterList\(abs, key, items\) \{[\s\S]*?\n\}/m),
  grab('loadFacetDocs', /^function loadFacetDocs\(fm\) \{[\s\S]*?\n\}/m),
  grab('loadFacetSet', /^function loadFacetSet\(fm\) \{[\s\S]*?\n\}/m),
  grab('primaryFacetDoc', /^function primaryFacetDoc\(fm\) \{.*$/m),
  'globalThis.__api = { parseFrontmatter, engineSetFrontmatterScalar, engineSetFrontmatterList, loadFacetSet, primaryFacetDoc }',
].join('\n'), ctx)
const { parseFrontmatter, engineSetFrontmatterScalar, engineSetFrontmatterList, loadFacetSet, primaryFacetDoc } = vm.runInContext('__api', ctx)

const A = 'docs/x/主文档.md', B = 'docs/x/REQ-0247.md', C = 'docs/储备/REQ-0332.md'
function archive(facetDocLine = `facet_doc: ${A}`) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-facetdoc-'))
  const abs = path.join(tmp, 't.md')
  fs.writeFileSync(abs, ['---', 'task: t', 'version: v9.9', facetDocLine, 'updated: 2026-09-03', 'gates:', '  qa_passed: false', '---', '', '# 任务', ''].join('\n'))
  return abs
}

test('facet_doc 写成块列表 → parseFrontmatter 读回数组、facetDocList 归一、主文档＝第一项', () => {
  const abs = archive()
  engineSetFrontmatterList(abs, 'facet_doc', [A, B, C])
  const text = fs.readFileSync(abs, 'utf8')
  assert.match(text, /facet_doc:\n {2}- docs\/x\/主文档\.md\n {2}- docs\/x\/REQ-0247\.md\n {2}- docs\/储备\/REQ-0332\.md\n/)
  const fm = parseFrontmatter(text)
  assert.deepEqual(Array.from(fm.facet_doc), [A, B, C])   // Array.from：vm realm 的数组原型与宿主不同，deepStrictEqual 会较真
  assert.deepEqual(facetDocList(fm.facet_doc), [A, B, C])
  assert.equal(primaryFacetDoc(fm), A)
  // 同一 frontmatter 里其它键没被块列表带偏
  assert.equal(fm.version, 'v9.9')
  assert.equal(fm.updated, '2026-09-03')
  assert.equal(fm.gates.qa_passed, false)
})

test('单项仍写裸标量（不给历史档案平白加列表语法）', () => {
  const abs = archive()
  engineSetFrontmatterList(abs, 'facet_doc', [B])
  assert.match(fs.readFileSync(abs, 'utf8'), new RegExp(`facet_doc: ${B.replace(/[.\/]/g, '\\$&')}\\n`))
  assert.equal(parseFrontmatter(fs.readFileSync(abs, 'utf8')).facet_doc, B)
})

test('块列表 → 单项：旧的 `- ` 子行必须被吃掉，不留孤儿行', () => {
  const abs = archive()
  engineSetFrontmatterList(abs, 'facet_doc', [A, B, C])
  engineSetFrontmatterList(abs, 'facet_doc', [B])
  const text = fs.readFileSync(abs, 'utf8')
  assert.equal(text.split('\n').filter(l => l.trim().startsWith('- ')).length, 0, '换回单项后不该还剩列表项')
  assert.equal(parseFrontmatter(text).facet_doc, B)
  assert.equal(parseFrontmatter(text).updated, '2026-09-03')   // 后面的键没被啃掉
})

test('key 行的行尾注释在块列表下留在 key 行上（不会跟到最后一项后面）', () => {
  const abs = archive(`facet_doc: ${A}  # 第一项＝版本主文档`)
  engineSetFrontmatterList(abs, 'facet_doc', [A, B])
  const text = fs.readFileSync(abs, 'utf8')
  assert.match(text, /facet_doc:\s+# 第一项＝版本主文档\n {2}- /)
  assert.deepEqual(Array.from(parseFrontmatter(text).facet_doc), [A, B])
})

test('内联列表写法也读得回来（与档案里 repos: [...] 同风格）', () => {
  const abs = archive(`facet_doc: [${A}, ${B}]`)
  assert.deepEqual(facetDocList(parseFrontmatter(fs.readFileSync(abs, 'utf8')).facet_doc), [A, B])
})

// ---------- 分母：并集 vs 塌成单份 ----------
const doc = (req, n) => `\n| facet ID | 验收标准 | 层级 | 分类 |\n|---|---|---|---|\n` +
  Array.from({ length: n }, (_, i) => `| ${req}-F${i + 1} | 判据${i + 1} | P0 | auto |`).join('\n') + '\n'

test('loadFacetSet：多份文档取并集，missing 如实报出（读不到≠没这条 facet）', () => {
  const files = { 'docs/main.md': doc('REQ-1', 3), 'docs/add.md': doc('REQ-2', 2) }
  sandbox.resolveRepoFile = rel => (rel in files ? rel : null)
  sandbox.fs = { readFileSync: rel => files[rel] }
  try {
    const ok = loadFacetSet({ facet_doc: ['docs/main.md', 'docs/add.md'] })
    assert.equal(ok.facets.length, 5)
    assert.deepEqual(ok.missing, [])
    const bad = loadFacetSet({ facet_doc: ['docs/main.md', 'docs/gone.md'] })
    assert.deepEqual(bad.missing, ['docs/gone.md'])
    assert.equal(bad.facets.length, 3)   // 能读到的照常解析，但 missing 非空时调用方必须 fail-closed
  } finally { sandbox.fs = fs; sandbox.resolveRepoFile = () => null }
})

test('分母塌成单份就是 v5.21 的 fail-open：另一份的 facet 直接不进 gaps', () => {
  const matrix = ['## 覆盖矩阵', '',
    '| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |',
    '|---|---|---|---|---|---|---|',
    '| REQ-1-F1 | REQ-1 | P0 | auto | UNCOVERED |  |  |',
    '| REQ-2-F1 | REQ-2 | P0 | auto | UNCOVERED |  |  |', ''].join('\n')
  const union = mergeFacetSets([extractFacetsFromDoc(doc('REQ-1', 3)), extractFacetsFromDoc(doc('REQ-2', 2))])
  assert.equal(computeCoverage(matrix, union).denom, 5)
  const shrunk = computeCoverage(matrix, extractFacetsFromDoc(doc('REQ-2', 2)))
  assert.equal(shrunk.denom, 2)
  assert.equal(shrunk.gaps.filter(g => g.facetId.startsWith('REQ-1')).length, 0, 'REQ-1 的 facet 被静默漏掉＝事故现场')
})
