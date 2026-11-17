import test from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findUnparsedFacetRows, computeCoverage, lintTestFile, validateMachineEvidence, rollupReqFacets, parseEvidenceFields, extractCoverageMatrix, mergeFacetRows, engineSetFacetRow, engineSeedCoverage, validateArchive, facetDocList, mergeFacetSets, extractFacetsFromDoc, caseChannel, inferFacetVia, viaSatisfies } from '../coverage.js'

const hash = `sha256:${'a'.repeat(64)}`
const evidence = `runId=run-1;case=case-1;testHash=${hash};summaryHash=${hash};commit=abc123;env=e2e;summary=output/run-1/summary.json`
const matrix = (status, ev = '', red = '') => `
## 覆盖矩阵

| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |
|----------|------|------|------|------|------|---------|
| REQ-1-F1 | REQ-1 | P0 | auto | ${status} | ${ev} | ${red} |
`
const facets = [{ id: 'REQ-1-F1', cls: 'content' }]

test('只有机器签发且 RED 完整的 GREEN 才通过', () => {
  const r = computeCoverage(matrix('COVERED_GREEN', evidence, evidence), facets)
  assert.equal(r.passed, true)
  assert.equal(r.coverageComplete, true)
  assert.equal(r.redComplete, true)
})

for (const status of ['SOURCE_ATTESTED', 'BLOCKED_WITH_PROOF', 'HUMAN_INHERENT']) {
  test(`${status} 不冒充 QA 通过`, () => {
    const r = computeCoverage(matrix(status, '有说明', ''), facets)
    assert.equal(r.passed, false)
    assert.equal(r.coverageComplete, false)
  })
}

// 同 REQ 已有真绿用例（造数链已证明可跑通）→ 该 REQ 的 SOURCE_ATTESTED 升级为 suspectAttestations 点名。
// 治 BUG-004 那类「源码坐实掩盖端到端从没真跑通」——REQ-0261 F3 真绿、F1 却停坐实、真提交才暴露 404。（2026-08-11）
test('同 REQ 已有真绿 → 该 REQ 的 SOURCE_ATTESTED 被点名 suspect', () => {
  const m = `
## 覆盖矩阵

| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |
|----------|------|------|------|------|------|---------|
| REQ-1-F1 | REQ-1 | P0 | auto | COVERED_GREEN | ${evidence} | ${evidence} |
| REQ-1-F2 | REQ-1 | P0 | auto | SOURCE_ATTESTED | 源码坐实 |  |
`
  const r = computeCoverage(m, [{ id: 'REQ-1-F1', cls: 'content' }, { id: 'REQ-1-F2', cls: 'content' }])
  assert.deepEqual(r.suspectAttestations, ['REQ-1-F2'])
  assert.equal(r.passed, false)
  assert.ok(r.gaps.some(g => g.facetId === 'REQ-1-F2' && /同 REQ 已有真绿/.test(g.why)))
})

test('同 REQ 无真绿 → SOURCE_ATTESTED 不点名（不误伤合法源码坐实）', () => {
  const r = computeCoverage(matrix('SOURCE_ATTESTED', '源码坐实', ''), facets)
  assert.deepEqual(r.suspectAttestations, [])
})

test('自由文本证据不能冒充机器证据', () => {
  assert.match(validateMachineEvidence('runId=随便写一个', 'GREEN'), /缺/)
})

test('lintAck 只记录申诉，不能把 content 假绿降级', () => {
  const testJson = { cases: [{
    id: 'case-1',
    coversFacets: ['REQ-1-F1'],
    lintAck: { borrowExisting: '状态太深', readOnly: '只读', presenceOnly: '页面展示' },
    steps: [
      { action: 'fill', stepTitle: '搜索', value: 'JY2026A01052' },
      { action: 'capture', expectation: { kind: 'text-present' } },
    ],
  }] }
  const r = lintTestFile(testJson, { facetClass: { 'REQ-1-F1': 'content' } })
  assert.equal(r.clean, false)
  assert.ok(r.blocking.some(f => f.code === 'DB_FISHING' && f.acked))
  assert.ok(r.blocking.some(f => f.code === 'TRACE_INVALID'))
})

test('content case 必须有同实体 AAA 血缘', () => {
  const testJson = { cases: [{
    id: 'case-1',
    coversFacets: ['REQ-1-F1'],
    fixtures: [{ macro: 'createQuickTask' }],
    qaTrace: {
      arrange: { provenance: 'fixture:createQuickTask', entityRef: '{{taskId}}' },
      act: { operationId: 'ui.save-price', entityRef: '{{taskId}}' },
      assert: { oracle: 'price.equals:100', entityRef: '{{taskId}}' },
    },
    steps: [
      { action: 'fill', stepTitle: '填写价格', value: '100' },
      { action: 'click', stepTitle: '保存' },
      { action: 'capture', expectation: { equals: '100' } },
    ],
  }] }
  const r = lintTestFile(testJson, { facetClass: { 'REQ-1-F1': 'content' } })
  assert.equal(r.clean, true)
})

test('用例不能声明权威 facet_doc 之外的 facet', () => {
  const r = lintTestFile({ cases: [{ id: 'case-x', coversFacets: ['REQ-9999-F1'], steps: [] }] }, { facetClass: { 'REQ-1-F1': 'content' } })
  assert.equal(r.clean, false)
  assert.ok(r.blocking.some(f => f.code === 'FACET_UNKNOWN'))
})

// ---------- facet/覆盖生命周期门禁：validateArchive（纯函数） ----------
const FACET_DOC = `# v-x 需求说明与验收标准

| facet ID | 需求 | 层级 | 分类 | 验收标准 |
|----------|------|------|------|----------|
| REQ-1-F1 | REQ-1 | P1 | auto | 给定X→操作→结果 |
| REQ-1-F2 | REQ-1 | P1 | auto | 边界 |
`
const ARCHIVE = ['---', 'task: t', 'status: 待测', 'facet_doc: docs/x.md', '---', '', matrix('UNCOVERED')].join('\n')

test('validateArchive：缺 frontmatter.facet_doc → error（含 hotfix/cc菲菲 教学提示）', () => {
  const r = validateArchive({ text: ARCHIVE, facetDocRel: null, facetDocText: null })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /缺 frontmatter\.facet_doc/)
  assert.match(r.errors[0], /hotfix/i)
  assert.match(r.errors[0], /cc_colleague\("feifei"/)
})

test('validateArchive：facet_doc 指了但文件找不到（text=null）→ error', () => {
  const r = validateArchive({ text: ARCHIVE, facetDocRel: 'docs/missing.md', facetDocText: null })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /找不到\/读不到/)
})

test('validateArchive：facet_doc 存在但无带 ID 的 facet 表 → error', () => {
  const r = validateArchive({ text: ARCHIVE, facetDocRel: 'docs/x.md', facetDocText: '# 只是散文，没有 facet 表' })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /解析不到带 ID/)
})

test('validateArchive：facet_doc 合法 → 0 error', () => {
  const r = validateArchive({ text: ARCHIVE, facetDocRel: 'docs/x.md', facetDocText: FACET_DOC })
  assert.equal(r.errors.length, 0)
  assert.equal(r.facetCount, 2)
})

// ---------- facet 表的两种列名写法（2026-09-03：`场景|断言` 那批解析出来判据是空的） ----------
test('extractFacetsFromDoc：`场景 | 断言（可测值） | 类型` 拼成「场景 → 断言」，不再是空判据', () => {
  const f = extractFacetsFromDoc(`
| facet ID | 场景 | 断言（可测值） | 类型 |
|----------|------|----------------|------|
| REQ-9-F1 | 选「有」 | 列表只剩 patternFiles 非空的任务 | 正向 |
`)
  assert.equal(f.length, 1)
  assert.equal(f[0].criterion, '选「有」 → 列表只剩 patternFiles 非空的任务')
  assert.equal(f[0].kind, '正向')   // 「类型」列＝分类列的另一种叫法
  assert.equal(f[0].cls, 'content')
})

test('extractFacetsFromDoc：`场景 | 期望可观测结果` 同样拼得起来', () => {
  const f = extractFacetsFromDoc(`
| facet ID | 场景 | 期望可观测结果 | 类型 |
|----------|------|----------------|------|
| REQ-9-F2 | 打开弹窗 | 六类图上传区全在 | 正向 |
`)
  assert.equal(f[0].criterion, '打开弹窗 → 六类图上传区全在')
})

test('extractFacetsFromDoc：有「验收标准」列时以它为准，不去拼 场景（旧口径不受影响）', () => {
  const f = extractFacetsFromDoc(`
| facet ID | 场景 | 验收标准 | 层级 | 分类 |
|----------|------|----------|------|------|
| REQ-9-F3 | 场景文字 | 给定X→操作→结果 | P0 | auto |
`)
  assert.equal(f[0].criterion, '给定X→操作→结果')
  assert.equal(f[0].level, 'P0')
  assert.equal(f[0].kind, 'auto')
})

// ---------- facet_doc 多份（2026-09-03 v5.21 事故：一版聚合多条 REQ，facet 散在 9 份文档里） ----------
test('facetDocList：单条路径 / 内联列表 / YAML 块列表 三种写法都归一成数组', () => {
  assert.deepEqual(facetDocList('docs/a.md'), ['docs/a.md'])
  assert.deepEqual(facetDocList('[docs/a.md, docs/b.md]'), ['docs/a.md', 'docs/b.md'])
  assert.deepEqual(facetDocList(['docs/a.md', 'docs/b.md']), ['docs/a.md', 'docs/b.md'])
  assert.deepEqual(facetDocList('[ "docs/a.md" , \'docs/b.md\' ]'), ['docs/a.md', 'docs/b.md'])   // 引号/空白容忍
  assert.deepEqual(facetDocList('[docs/a.md, docs/a.md]'), ['docs/a.md'])                          // 去重
  assert.deepEqual(facetDocList(''), [])
  assert.deepEqual(facetDocList(null), [])
})

test('mergeFacetSets：按 facet ID 去重，先出现的赢（主文档排头 → 主文档口径覆盖储备文档）', () => {
  const merged = mergeFacetSets([
    [{ id: 'REQ-1-F1', criterion: '主文档定稿口径' }],
    [{ id: 'REQ-1-F1', criterion: '储备文档旧口径' }, { id: 'REQ-2-F1', criterion: '插单的' }],
  ])
  assert.deepEqual(merged.map(f => f.id), ['REQ-1-F1', 'REQ-2-F1'])
  assert.equal(merged[0].criterion, '主文档定稿口径')
})

test('validateArchive：多份 facet_doc → 全集取并集，孤儿行判据按并集算', () => {
  const docB = `
| facet ID | 需求 | 层级 | 分类 | 验收标准 |
|----------|------|------|------|----------|
| REQ-1-F9 | REQ-1 | P1 | auto | 插单那条 |
`
  const text = ['---', 'task: t', 'status: 待测', 'facet_doc: [docs/x.md, docs/y.md]', '---', '',
    '## 覆盖矩阵', '',
    '| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |',
    '|----------|------|------|------|------|------|---------|',
    '| REQ-1-F1 | REQ-1 | P1 | auto | UNCOVERED |  |  |',
    '| REQ-1-F9 | REQ-1 | P1 | auto | UNCOVERED |  |  |', ''].join('\n')
  // 只登记主文档时 F9 是孤儿；把插单那份也登记上，孤儿告警就该消失
  const one = validateArchive({ text, facetDocs: [{ rel: 'docs/x.md', text: FACET_DOC }] })
  assert.ok(one.warnings.some(w => /REQ-1-F9/.test(w)))
  const both = validateArchive({ text, facetDocs: [{ rel: 'docs/x.md', text: FACET_DOC }, { rel: 'docs/y.md', text: docB }] })
  assert.equal(both.errors.length, 0)
  assert.equal(both.facetCount, 3)
  assert.equal(both.warnings.filter(w => /REQ-1-F9/.test(w)).length, 0)
})

test('validateArchive：多份里有一份找不到 → error（分母不完整绝不放行）', () => {
  const r = validateArchive({ text: ARCHIVE, facetDocs: [{ rel: 'docs/x.md', text: FACET_DOC }, { rel: 'docs/gone.md', text: null }] })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /docs\/gone\.md/)
  assert.match(r.errors[0], /找不到\/读不到/)
})

test('validateArchive：多份里有一份读到了却零 facet → warning（白列一份，不阻断）', () => {
  const r = validateArchive({ text: ARCHIVE, facetDocs: [{ rel: 'docs/x.md', text: FACET_DOC }, { rel: 'docs/empty.md', text: '# 散文' }] })
  assert.equal(r.errors.length, 0)
  assert.ok(r.warnings.some(w => /docs\/empty\.md/.test(w) && /白列一份/.test(w)))
})

test('facet_doc 多份时 computeCoverage 的分母＝并集（塌成单份就是 v5.21 的 fail-open）', () => {
  const all = mergeFacetSets([extractFacetsFromDoc(FACET_DOC), extractFacetsFromDoc(`
| facet ID | 需求 | 层级 | 分类 | 验收标准 |
|----------|------|------|------|----------|
| REQ-2-F1 | REQ-2 | P0 | auto | 插单那条 |
`)])
  const text = ['---', 'task: t', '---', '', '## 覆盖矩阵', '',
    '| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |',
    '|----------|------|------|------|------|------|---------|',
    '| REQ-1-F1 | REQ-1 | P1 | auto | COVERED_GREEN | ' + evidence + ' | ' + evidence + ' |', ''].join('\n')
  assert.equal(computeCoverage(text, all).denom, 3)
  // 只认插单那一份 → 分母 1、REQ-1 的两条 facet 根本不进 gaps（漏判）
  const shrunk = computeCoverage(text, extractFacetsFromDoc(`
| facet ID | 需求 | 层级 | 分类 | 验收标准 |
|----------|------|------|------|----------|
| REQ-2-F1 | REQ-2 | P0 | auto | 插单那条 |
`))
  assert.equal(shrunk.denom, 1)
  assert.equal(shrunk.gaps.filter(g => /REQ-1/.test(g.facetId)).length, 0)
})

test('validateArchive：矩阵孤儿行（不在 facet_doc 全集）→ warning、不进 error', () => {
  const text = ['---', 'task: t', 'status: 待测', 'facet_doc: docs/x.md', '---', '',
    '## 覆盖矩阵', '',
    '| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |',
    '|----------|------|------|------|------|------|---------|',
    '| REQ-1-F1 | REQ-1 | P1 | auto | UNCOVERED |  |  |',
    '| REQ-1-F9 | REQ-1 | P1 | auto | UNCOVERED |  |  |', ''].join('\n')   // F9 不在 facet_doc
  const r = validateArchive({ text, facetDocRel: 'docs/x.md', facetDocText: FACET_DOC })
  assert.equal(r.errors.length, 0)
  assert.ok(r.warnings.some(w => /REQ-1-F9/.test(w) && /未登记/.test(w)))
})

test('validateArchive：矩阵非法覆盖状态 → warning', () => {
  const text = ARCHIVE.replace('UNCOVERED', 'WHATEVER')
  const r = validateArchive({ text, facetDocRel: 'docs/x.md', facetDocText: FACET_DOC })
  assert.ok(r.warnings.some(w => /状态「WHATEVER」非法/.test(w)))
})

// ---------- 看板显示层派生：rollupReqFacets ----------
test('rollup：全 GREEN 且 RED 完整 → QA通过', () => {
  const r = rollupReqFacets([{ status: 'COVERED_GREEN', redOk: true }, { status: 'COVERED_GREEN', redOk: true }])
  assert.equal(r.status, 'QA通过')
  assert.equal(r.dot, 'ok')
  assert.equal(r.flight, false)
  assert.equal(r.redPending, 0)
})

test('rollup：全 GREEN 但缺 RED → QA通过·RED待补', () => {
  const r = rollupReqFacets([{ status: 'COVERED_GREEN', redOk: true }, { status: 'COVERED_GREEN', redOk: false }])
  assert.equal(r.status, 'QA通过·RED待补')
  assert.equal(r.dot, 'ok')
  assert.equal(r.redPending, 1)
})

test('rollup：含 UNCOVERED → 待测（还没测完，交迷糊）', () => {
  const r = rollupReqFacets([{ status: 'COVERED_GREEN', redOk: true }, { status: 'UNCOVERED' }])
  assert.equal(r.status, '待测')
  assert.equal(r.dot, 'flight')
  assert.equal(r.next, 'mihu')
})

test('rollup：无未覆盖、含风险处置 → 待人工（REQ-0277 那类 4/6 GREEN + 源码/人工）', () => {
  const r = rollupReqFacets([
    { status: 'COVERED_GREEN', redOk: false }, { status: 'COVERED_GREEN', redOk: false },
    { status: 'COVERED_GREEN', redOk: false }, { status: 'COVERED_GREEN', redOk: false },
    { status: 'SOURCE_ATTESTED' }, { status: 'HUMAN_INHERENT' },
  ])
  assert.equal(r.status, '待人工')
  assert.equal(r.dot, 'flight')
  assert.equal(r.next, 'manual')
  assert.deepEqual(r.counts, { GREEN: 4, SOURCE: 1, HUMAN: 1, BLOCKED: 0, UNCOVERED: 0, other: 0 })
  assert.equal(r.total, 6)
})

test('rollup：含 BLOCKED_WITH_PROOF → 阻塞（高亮，优先级最高）', () => {
  const r = rollupReqFacets([{ status: 'COVERED_GREEN', redOk: true }, { status: 'BLOCKED_WITH_PROOF' }, { status: 'UNCOVERED' }])
  assert.equal(r.status, '阻塞')
  assert.equal(r.dot, 'blocked')
})

test('rollup：空输入 → 中性 idle，不误报', () => {
  const r = rollupReqFacets([])
  assert.equal(r.dot, 'idle')
  assert.equal(r.total, 0)
})

// ---------- 证据串解析（含新增 testFile= 字段） ----------
test('parseEvidenceFields：解析出 testFile 字段（新签发证据一键跳用例）', () => {
  const ev = `${evidence};testFile=vision-e2e/test-workflows/v5.17/sampling.json`
  const f = parseEvidenceFields(ev)
  assert.equal(f.case, 'case-1')
  assert.equal(f.testFile, 'vision-e2e/test-workflows/v5.17/sampling.json')
})

test('新增 testFile= 不破坏 fail-closed：老证据无该字段仍通过机器校验', () => {
  assert.equal(validateMachineEvidence(evidence, 'GREEN'), '')   // 无 testFile 也合法
})

// ---------- 解析健壮性：散文里的「## 覆盖矩阵」字样不得劫持真正的矩阵段 ----------
test('时间线散文引用 "## 覆盖矩阵" 不劫持真实矩阵（2026-08-11 巡视写档触发的回归）', () => {
  const doc = `## 时间线

- 建议老板核实"## 覆盖矩阵"与时间线的结论是否支撑放行。

## 覆盖矩阵

| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |
|----------|------|------|------|------|------|---------|
| REQ-1-F1 | REQ-1 | P0 | auto | SOURCE_ATTESTED | 源码坐实 |  |
| REQ-1-F2 | REQ-1 | P0 | auto | UNCOVERED |  |  |
`
  const rows = extractCoverageMatrix(doc)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].facetId, 'REQ-1-F1')
})

// ---------- 写侧防劫持回归（2026-08-12 迷糊 QA 会话：engineSetFacetRow 崩 undefined.split，废整轮机签） ----------
// 根因：旧写侧取「文档里第一个 ## 覆盖矩阵」，命中时间线巡视 note 里内联/独占的同名标题 → 段无表头 → _rc(undefined).split 崩。
// 修复：findMatrixSection 按「正文含 facet 表头行」认真段，散文复述一律跳过。此处覆盖内联+独占两种前置散文形态。
const REAL_MATRIX = ['## 覆盖矩阵', '', '> 引擎维护', '',
  '| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |',
  '|----------|------|------|------|------|------|---------|',
  '| REQ-1-F1 | REQ-1 | P0 | auto | UNCOVERED |  |  |', ''].join('\n')
const withTmpFile = (body, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'))
  const abs = path.join(dir, 'task.md')
  fs.writeFileSync(abs, body)
  try { return fn(abs) } finally { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { } }
}
const FM = ['---', 'task: t', 'facet_doc: docs/x.md', 'updated: 2026-08-11', '---', ''].join('\n') + '\n'

for (const [name, prose] of [
  ['内联在时间线 bullet 里', '- 2026-08-11 巡视：核实 ## 覆盖矩阵 段的结论是否支撑放行\n- 又一条\n'],
  ['独占一行的裸标题（旧锚定补丁挡不住的残留缺口）', '- note\n## 覆盖矩阵\n段被复述\n- 含 | 管道 | 的行 |\n'],
]) {
  test(`写侧不被散文里的「## 覆盖矩阵」劫持：${name}（08-12 崩 split 回归）`, () => {
    withTmpFile(`${FM}## 时间线\n\n${prose}\n${REAL_MATRIX}`, abs => {
      assert.doesNotThrow(() => engineSetFacetRow(abs, { facetId: 'REQ-1-F1', status: 'SOURCE_ATTESTED', evidence: 'ev' }))
      const rows = extractCoverageMatrix(fs.readFileSync(abs, 'utf8'))
      assert.equal(rows.length, 1)                                      // 写进真表、没在散文处另建段
      assert.equal(rows[0].status, 'SOURCE_ATTESTED')                   // 状态确实落到真表
    })
  })
}

test('seed_coverage 在散文含同名标题时仍播进真表、不崩（08-12 播种失败回归）', () => {
  withTmpFile(`${FM}## 时间线\n\n- 回顾 ## 覆盖矩阵 收口\n\n${REAL_MATRIX}`, abs => {
    let res
    assert.doesNotThrow(() => { res = engineSeedCoverage(abs, [{ id: 'REQ-1-F1', req: 'REQ-1' }, { id: 'REQ-1-F2', req: 'REQ-1' }]) })
    assert.equal(res.added, 1)                                          // 只补缺的 F2
    const rows = extractCoverageMatrix(fs.readFileSync(abs, 'utf8'))
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(r => r.facetId).sort(), ['REQ-1-F1', 'REQ-1-F2'])
  })
})

// ---------- 看板显示全集：mergeFacetRows（A+甲：facet_doc 为全集权威） ----------
test('mergeFacetRows：facet_doc 有、矩阵空 → 全骨架 UNCOVERED（需求确认起上板）', () => {
  const facets = [{ id: 'REQ-1-F1', req: 'REQ-1', criterion: '给定X→操作→结果', level: 'P1', cls: 'content' }, { id: 'REQ-1-F2', req: 'REQ-1', criterion: '边界', level: 'P1', cls: 'content' }]
  const rows = mergeFacetRows(facets, [])
  assert.equal(rows.length, 2)
  assert.ok(rows.every(r => r.status === 'UNCOVERED' && !r.unlisted))
  assert.equal(rows[0].criterion, '给定X→操作→结果')   // 验收标准原文来自 facet_doc
})

test('mergeFacetRows：矩阵状态覆盖到 facet_doc 骨架、doc 独有仍 UNCOVERED', () => {
  const facets = [{ id: 'REQ-1-F1', req: 'REQ-1', cls: 'content' }, { id: 'REQ-1-F2', req: 'REQ-1', cls: 'content' }]
  const matrix = [{ facetId: 'REQ-1-F1', req: 'REQ-1', status: 'SOURCE_ATTESTED', evidence: '源码坐实', red: '' }]
  const rows = mergeFacetRows(facets, matrix)
  const f1 = rows.find(r => r.facetId === 'REQ-1-F1'), f2 = rows.find(r => r.facetId === 'REQ-1-F2')
  assert.equal(f1.status, 'SOURCE_ATTESTED')
  assert.equal(f2.status, 'UNCOVERED')
  assert.ok(!f1.unlisted && !f2.unlisted)
})

test('mergeFacetRows：矩阵有、facet_doc 无 → 标 unlisted（待回写菲菲）', () => {
  const facets = [{ id: 'REQ-1-F1', req: 'REQ-1', cls: 'content' }]
  const matrix = [{ facetId: 'REQ-1-F1', req: 'REQ-1', status: 'UNCOVERED' }, { facetId: 'REQ-1-F9', req: 'REQ-1', status: 'SOURCE_ATTESTED', evidence: '迷糊临时加' }]
  const rows = mergeFacetRows(facets, matrix)
  const f9 = rows.find(r => r.facetId === 'REQ-1-F9')
  assert.ok(f9 && f9.unlisted, 'facet_doc 之外的矩阵行应标 unlisted')
  assert.equal(rows.find(r => r.facetId === 'REQ-1-F1').unlisted, false)
})

test('mergeFacetRows：facet_doc 缺（纯矩阵退化）→ 不标 unlisted', () => {
  const rows = mergeFacetRows([], [{ facetId: 'REQ-1-F1', req: 'REQ-1', status: 'SOURCE_ATTESTED' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].unlisted, false)   // 无 facet_doc 权威时不谈「未登记」
})

// ---------- 「写了但引擎没认到」检测（2026-09-09 实测缺陷）----------

test('未解析行：`F40-a` 这种没有 REQ 前缀的子项 → 抓出来（27 行实测形态）', () => {
  const doc = `
| 子 facet | 可断言标准 |
|---------|-----------|
| F40-a | 抽屉恒 2 页签 |
| F40-b | 六种结论 |
`
  const un = findUnparsedFacetRows(doc, [])
  assert.deepEqual(un.map(u => u.id), ['F40-a', 'F40-b'])
  assert.equal(un[0].hasReqPrefix, false)
  assert.equal(un[0].hint, '抽屉恒 2 页签')
})

test('未解析行：已解析出来的正常行不报（含 **加粗** 写法）', () => {
  const doc = `
| facet ID | 验收标准 |
|---|---|
| REQ-0338-F1 | 正常 |
| **REQ-0339-F82** | 加粗 |
`
  assert.deepEqual(findUnparsedFacetRows(doc, ['REQ-0338-F1', 'REQ-0339-F82']), [])
})

test('未解析行：`F1-F9` 区间写法不许误报（这是本仓库里常见的 facet 区间表达）', () => {
  const doc = `
| 条目 | facet 区间 |
|---|---|
| F1-F9 | 环节配置 |
| REQ-0338 环节配置=F1-F9 | 映射 |
`
  assert.deepEqual(findUnparsedFacetRows(doc, []), [])
})

test('未解析行：带 REQ 前缀却没解析出来 → 归 warning 档（表头缺 facet 列名/列序异常那类）', () => {
  const doc = `
| 编号 | 说明 |
|---|---|
| REQ-0339-F99 | 表头没有 facet 字样 |
`
  const un = findUnparsedFacetRows(doc, [])
  assert.equal(un.length, 1)
  assert.equal(un[0].hasReqPrefix, true)
})

test('validateArchive：facet_doc 里有无前缀子项 → 硬 error，并点明"以子项为准也没用、分母里没有它们"', () => {
  const facetDoc = `
| facet ID | 验收标准 | 层级 | 分类 |
|---|---|---|---|
| REQ-0339-F40 | 抽屉（太粗） | P0 | auto |

### 拆 REQ-0339-F40 → 2 子项
| 子 facet | 可断言标准 |
|---|---|
| F40-a | 恒 2 页签 |
| F40-b | 六种结论 |
`
  const v = validateArchive({ text: '## 覆盖矩阵\n', facetDocs: [{ rel: 'x.md', text: facetDoc }] })
  assert.equal(v.facetCount, 1, '只认到那条完整 ID 的')
  const e = v.errors.find(x => /没有 REQ 前缀/.test(x))
  assert.ok(e, v.errors.join('|'))
  assert.match(e, /F40-a/)
  assert.match(e, /覆盖矩阵播不进/)
  assert.match(e, /直接给新序号/)
})

test('validateArchive：facet_doc 全是完整 ID → 不报这一档（不给正常档案添噪音）', () => {
  const facetDoc = `
| facet ID | 验收标准 | 层级 | 分类 |
|---|---|---|---|
| REQ-0339-F40 | a | P0 | auto |
| REQ-0339-F83 | b | P0 | auto |
`
  const v = validateArchive({ text: '## 覆盖矩阵\n', facetDocs: [{ rel: 'x.md', text: facetDoc }] })
  assert.equal(v.facetCount, 2)
  assert.ok(!v.errors.some(x => /没有 REQ 前缀/.test(x)))
})

// ---------- 验证通道（via）：UI 面 facet 不许由 callApi 签绿（2026-09-10 老板定）----------
const uiFacetDoc = `
| facet ID | 验收标准 | 层级 | 分类 |
|---|---|---|---|
| REQ-1-F1 | 模板列表更新时间列显示为 yyyy-MM-dd | P0 | ui-visual |
| REQ-1-F2 | 保存无改动不递增版本号 | P0 | auto |
`

test('via：facet 分类含 ui-visual → 期望通道=ui；auto → any', () => {
  const fs2 = extractFacetsFromDoc(uiFacetDoc)
  assert.equal(fs2.find(f => f.id === 'REQ-1-F1').via, 'ui')
  assert.equal(fs2.find(f => f.id === 'REQ-1-F2').via, 'any')
})

test('via：facet_doc 显式「通道」列压过分类推断', () => {
  const doc = `
| facet ID | 验收标准 | 分类 | 通道 |
|---|---|---|---|
| REQ-1-F1 | x | ui-visual | api |
`
  assert.equal(extractFacetsFromDoc(doc)[0].via, 'api')
})

test('caseChannel：只有 callApi 步 → api；带 UI 断言 → ui；两者都有 → mixed', () => {
  assert.equal(caseChannel({ steps: [{ action: 'callApi' }, { action: 'call_api' }] }), 'api')
  assert.equal(caseChannel({ steps: [{ action: 'click' }, { action: 'assertDom' }] }), 'ui')
  assert.equal(caseChannel({ steps: [{ action: 'callApi' }, { action: 'assertVisible' }] }), 'mixed')
  assert.equal(caseChannel({ steps: [] }), 'unknown')
})

test('caseChannel：callApi 用例顺手带个登录导航步，不许冒充 ui 通道', () => {
  // 只有导航/点击、没有任何 UI 断言 ⇒ 不算「看了页面上的东西」
  assert.equal(caseChannel({ steps: [{ action: 'navigate' }, { action: 'callApi' }] }), 'api')
})

test('via 闸门：UI 面 facet 拿 api 通道的绿 → 不计通过、且点名 channelGaps', () => {
  const ev = evidence + ';via=api'
  const r = computeCoverage(matrix('COVERED_GREEN', ev, ev).replace(/REQ-1-F1 \| REQ-1 \| P0 \| auto/, 'REQ-1-F1 | REQ-1 | P0 | ui-visual'), extractFacetsFromDoc(uiFacetDoc).filter(f => f.id === 'REQ-1-F1'))
  assert.equal(r.passed, false)
  assert.equal(r.coverageComplete, false)
  assert.equal(r.channelGaps.length, 1)
  assert.match(r.channelGaps[0].why, /接口通道证明不了界面渲染/)
})

test('via 闸门：UI 面 facet 由 ui / mixed 通道签发 → 放行', () => {
  for (const v of ['ui', 'mixed']) {
    const ev = evidence + ';via=' + v
    const r = computeCoverage(matrix('COVERED_GREEN', ev, ev), extractFacetsFromDoc(uiFacetDoc).filter(f => f.id === 'REQ-1-F1'))
    assert.equal(r.passed, true, v)
    assert.equal(r.channelGaps.length, 0, v)
  }
})

test('via 闸门：UI 面 facet 的历史绿（证据无 via=）fail-closed，提示重跑 reconcile', () => {
  const r = computeCoverage(matrix('COVERED_GREEN', evidence, evidence), extractFacetsFromDoc(uiFacetDoc).filter(f => f.id === 'REQ-1-F1'))
  assert.equal(r.passed, false)
  assert.match(r.channelGaps[0].why, /没标验证通道/)
})

test('via 闸门：非 UI 面 facet 不受通道约束（后端 facet 照旧 callApi 签绿）', () => {
  const ev = evidence + ';via=api'
  const r = computeCoverage(matrix('COVERED_GREEN', ev, ev), [{ id: 'REQ-1-F1', cls: 'content', via: 'any' }])
  assert.equal(r.passed, true)
  assert.equal(r.channelGaps.length, 0)
})

test('via 闸门：无 facet_doc 时退回按矩阵「分类」列推断（ui-visual 行照样管）', () => {
  const m = `
## 覆盖矩阵

| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |
|----------|------|------|------|------|------|---------|
| REQ-1-F9 | REQ-1 | P1 | ui-visual | COVERED_GREEN | ${evidence};via=api | ${evidence} |
`
  const r = computeCoverage(m, [])
  assert.equal(r.channelGaps.length, 1)
  assert.equal(r.passed, false)
})

test('mergeFacetRows 把通道结论带给看板（via / evidenceVia / viaOk）', () => {
  const rows = mergeFacetRows(extractFacetsFromDoc(uiFacetDoc), extractCoverageMatrix(matrix('COVERED_GREEN', evidence + ';via=api', evidence)))
  const r1 = rows.find(r => r.facetId === 'REQ-1-F1')
  assert.equal(r1.via, 'ui')
  assert.equal(r1.evidenceVia, 'api')
  assert.equal(r1.viaOk, false)
})

test('via：判据原文的高精词表兜底（分类列写 auto，但判据说「置灰」「弹窗」「空态」「表头」→ ui）', () => {
  const doc = `
| facet ID | 验收标准 | 层级 | 分类 |
|---|---|---|---|
| REQ-1-F2 | 类型选"仓库回传" → "照片必填"选项置灰不可选 | P0 | auto |
| REQ-1-F6 | 模板未绑任何供应商 → 页面正常空态、非报错 | P0 | auto |
| REQ-1-F41 | 首屏是模板列表：每行显 模板名／版本号 | P0 | auto |
| REQ-1-F5 | 同供应商按首单绑 T1、返单绑 T3 → 两条绑定都成立(唯一键=供应商+单据类型+档位) | P0 | auto |
| REQ-1-F11 | 各组数字之和 = 当日跟进批次总数（不重复计） | P0 | auto |
`
  const fs2 = extractFacetsFromDoc(doc)
  const via = id => fs2.find(f => f.id === id)
  // 只有在屏幕上才成立的三条 → ui（且标明来源是推断、不是声明）
  for (const id of ['REQ-1-F2', 'REQ-1-F6', 'REQ-1-F41']) {
    assert.equal(via(id).via, 'ui', id)
    assert.equal(via(id).viaFrom, 'criterion', id)
  }
  // 纯数据/唯一键口径不该被词表卷进来（高精＝宁可漏，不可把后端 facet 判成 UI 面）
  assert.equal(via('REQ-1-F5').via, 'any')
  assert.equal(via('REQ-1-F11').via, 'any')
})

test('via：泛义词（页面/显示/列表/提示）不许触发 ui —— 否则全站皆 ui、噪声比不做更坏', () => {
  const doc = `
| facet ID | 验收标准 | 层级 | 分类 |
|---|---|---|---|
| REQ-1-F7 | 停用模板后新到达的待发货单不再建批次，列表里查不到该批次 | P0 | auto |
| REQ-1-F8 | 标准停留输入 0 或 >8760h → 保存被拦并提示区间 | P0 | auto |
`
  for (const f of extractFacetsFromDoc(doc)) assert.equal(f.via, 'any', f.id)
})

test('viaTally：声明度可见（declared / inferred / none 分开计）', () => {
  const doc = `
| facet ID | 验收标准 | 分类 | 通道 |
|---|---|---|---|
| REQ-1-F1 | a | auto | ui |
| REQ-1-F2 | 选项置灰不可选 | auto |  |
| REQ-1-F3 | 唯一键不冲突 | auto |  |
`
  const facets = extractFacetsFromDoc(doc)
  const m = `
## 覆盖矩阵

| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |
|----------|------|------|------|------|------|---------|
| REQ-1-F1 | REQ-1 | P0 | auto | UNCOVERED |  |  |
| REQ-1-F2 | REQ-1 | P0 | auto | UNCOVERED |  |  |
| REQ-1-F3 | REQ-1 | P0 | auto | UNCOVERED |  |  |
`
  const cov = computeCoverage(m, facets)
  assert.deepEqual(cov.viaTally, { declared: 1, inferred: 1, none: 1 })
})

test('validateArchive：facet_doc 没写「通道」列 → 软提示（催 facet 主人把推断变成口径，但不阻断）', () => {
  const doc = `
| facet ID | 验收标准 | 分类 |
|---|---|---|
| REQ-1-F1 | 选项置灰不可选 | auto |
| REQ-1-F2 | 唯一键不冲突 | auto |
`
  const v = validateArchive({ text: '## 覆盖矩阵\n', facetDocs: [{ rel: 'x.md', text: doc }] })
  const w = v.warnings.find(x => /没声明验证通道/.test(x))
  assert.ok(w, v.warnings.join('|'))
  assert.match(w, /1\/2/)
  assert.match(w, /推断只是兜底/)
  assert.ok(!v.errors.some(x => /通道/.test(x)), '不阻断')
})

// 猪猪 v1.11 assertLayout（迷糊 2026-10-21 需求单·REQ-0400-F1~F3）：排版类 facet 的机签通道
test('排版断言：只开页面+展开面板+assertLayout 的 ui 通道 case 不判 NO_ACTION，且算值断言', () => {
  const layoutCase = {
    id: 'layout-1280',
    coversFacets: ['REQ-0400-F3'],
    viewport: { width: 1280, height: 900 },
    qaTrace: { arrange: { provenance: 'fixture', entityRef: 'board' }, act: { operationId: 'open-more-filter', entityRef: 'board' }, assert: { oracle: 'layout-geometry', entityRef: 'board' } },
    steps: [
      { action: 'click', stepTitle: '展开更多筛选', target: { testId: 'more-filter' } },
      { action: 'assertLayout', target: { testId: 'filter-panel' }, items: '.ant-form-item' },
    ],
  }
  const r = lintTestFile({ cases: [layoutCase] }, { facetClass: { 'REQ-0400-F3': 'content' }, facetVia: { 'REQ-0400-F3': 'ui' } })
  assert.deepEqual(r.findings.map(f => f.code), [])
  assert.equal(caseChannel(layoutCase), 'ui')
})

test('排版断言豁免 fail-closed：facet 非 ui 通道或未传 facetVia 时照判 NO_ACTION', () => {
  const c = { id: 'c', coversFacets: ['REQ-1-F1'], steps: [{ action: 'assertLayout', items: '.x' }] }
  const apiFacet = lintTestFile({ cases: [c] }, { facetClass: { 'REQ-1-F1': 'presence' }, facetVia: { 'REQ-1-F1': 'api' } })
  assert.ok(apiFacet.findings.some(f => f.code === 'NO_ACTION'))
  const noVia = lintTestFile({ cases: [c] }, { facetClass: { 'REQ-1-F1': 'presence' } })
  assert.ok(noVia.findings.some(f => f.code === 'NO_ACTION'))
  assert.ok(!noVia.findings.some(f => f.code === 'PRESENCE_ONLY'), 'assertLayout 是值断言，不是存在性')
})
