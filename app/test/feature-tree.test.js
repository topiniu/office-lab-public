import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractTreeRows, buildTree, computeFeatureTree, renderFeatureTree,
  NODE_KINDS, INTERACTIVE_KINDS,
} from '../feature-tree.js'

const table = rows => `
## 功能树

| 节点路径 | 类型 | 目标用户 | 使用场景 | 源单元 | facet | 空态 | 失败态 | 无权限 |
|---------|------|---------|---------|--------|-------|------|-------|-------|
${rows.join('\n')}
`
const FACETS = ['REQ-1-F1', 'REQ-1-F2', 'REQ-1-F3', 'REQ-1-F4', 'REQ-1-F5']
const base = { facetIds: FACETS, materialIds: ['d0'], treeDocRel: 'docs/x/tree.md', createdOn: '2026-09-20' }

// 一棵最小合规树：页面 → 区域 → 两个叶子（一个展示、一个交互）
const OK_ROWS = [
  '| 跟单工作台 | 页面 | 跟单员 | 每天早上看该催谁 | d0#logic-no=0 | | | | |',
  '| 跟单工作台 / 工厂聚合区 | 区域 | | | d0#logic-no=3 | | | | |',
  '| 跟单工作台 / 工厂聚合区 / 待问工厂计数 | 展示 | | | d0#logic-no=4 | REQ-1-F1 | | | |',
  '| 跟单工作台 / 工厂聚合区 / 复制催单话术 | 动作 | | | d0#logic-no=21 | REQ-1-F2 | REQ-1-F3 | N/A:纯前端拼串无请求 | REQ-1-F4 |',
]

// ---------- 解析 ----------

test('解析：表头嗅探「节点路径 + 类型」，路径分隔符 / ／ > 混用都认', () => {
  const rows = extractTreeRows(table([
    '| A / B | 区域 | u | s | d0#1 | | | | |',
    '| A ／ C | 区域 | u | s | d0#2 | | | | |',
    '| A > D | 区域 | u | s | d0#3 | | | | |',
  ]))
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(r => r.key), ['A / B', 'A / C', 'A / D'])
  assert.equal(rows[0].depth, 2)
})

test('解析：不是功能树的表格不误吃', () => {
  assert.deepEqual(extractTreeRows('| facet ID | 验收标准 |\n|---|---|\n| REQ-1-F1 | x |'), [])
  assert.deepEqual(extractTreeRows('| 源单元 | 处置 |\n|---|---|\n| d0#1 | 立需求 |'), [])
})

// ---------- 建树：叶子由机器判 ----------

test('叶子由机器判、不由她声明（没有更深路径以它为前缀＝叶子）', () => {
  const t = buildTree(extractTreeRows(table(OK_ROWS)))
  const leaf = k => t.byKey.get(k).isLeaf
  assert.equal(leaf('跟单工作台'), false)
  assert.equal(leaf('跟单工作台 / 工厂聚合区'), false)
  assert.equal(leaf('跟单工作台 / 工厂聚合区 / 待问工厂计数'), true)
  assert.equal(t.roots.length, 1)
})

test('目标用户/使用场景沿路径向上继承（写一次在区域上即可，叶子不必重复）', () => {
  const t = buildTree(extractTreeRows(table(OK_ROWS)))
  const n = t.byKey.get('跟单工作台 / 工厂聚合区 / 复制催单话术')
  assert.equal(n.user, '')              // 自己没写
  assert.equal(n.effUser, '跟单员')      // 从根继承
  assert.equal(n.effScene, '每天早上看该催谁')
})

test('孤儿节点与重复路径都被抓出来（树必须连通、一节点一行）', () => {
  const r = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table([
      '| A | 页面 | u | s | d0#1 | | | | |',
      '| A / B / C | 展示 | | | d0#2 | REQ-1-F1 | | | |',
      '| A | 页面 | u | s | d0#1 | | | | |',
    ])),
  })
  assert.ok(r.errors.some(e => /孤儿节点「A \/ B \/ C」/.test(e)))
  assert.ok(r.errors.some(e => /重复节点路径「A」/.test(e)))
})

// ---------- 三条硬判据 ----------

test('最小合规树 → treeComplete', () => {
  const r = computeFeatureTree({ ...base, rows: extractTreeRows(table(OK_ROWS)) })
  assert.equal(r.treeComplete, true, r.errors.join(' / '))
  assert.equal(r.stats.leaves, 2)
  assert.equal(r.stats.interactive, 1)
  assert.equal(r.stats.maxDepth, 3)
})

test('R1 叶子没挂真实 facet → 拦（没 facet 的叶子只是个标题）', () => {
  const r = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table(['| A | 页面 | u | s | d0#1 | | | | |', '| A / B | 展示 | | | d0#2 | | | | |'])),
  })
  assert.ok(r.errors.some(e => /叶子「A \/ B」没挂任何真实 facet/.test(e)))
})

test('R1 叶子挂了不存在的 facet → 拦（写了号但 facet 没真立进 facet_doc）', () => {
  const r = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table(['| A | 页面 | u | s | d0#1 | | | | |', '| A / B | 展示 | | | d0#2 | REQ-1-F99 | | | |'])),
  })
  assert.ok(r.errors.some(e => /不存在的 facet REQ-1-F99/.test(e)))
})

test('R2 交互类叶子三类边界逐个交代；展示类不强制（免噪音）', () => {
  const miss = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table([
      '| A | 页面 | u | s | d0#1 | | | | |',
      '| A / 提交 | 动作 | | | d0#2 | REQ-1-F1 | | | |',
    ])),
  })
  for (const label of ['空态', '失败态', '无权限']) {
    assert.ok(miss.errors.some(e => e.includes(`「${label}」没交代`)), `应点名缺${label}`)
  }
  // 同一棵树把类型改成展示 → 三类边界不再强制
  const show = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table([
      '| A | 页面 | u | s | d0#1 | | | | |',
      '| A / 提交 | 展示 | | | d0#2 | REQ-1-F1 | | | |',
    ])),
  })
  assert.equal(show.treeComplete, true, show.errors.join(' / '))
})

test('R2 N/A 必须写理由（"不适用"和"忘了想"必须分得开）', () => {
  const rows = extractTreeRows(table([
    '| A | 页面 | u | s | d0#1 | | | | |',
    '| A / 提交 | 动作 | | | d0#2 | REQ-1-F1 | N/A | N/A:无请求 | REQ-1-F2 |',
  ]))
  const r = computeFeatureTree({ ...base, rows })
  assert.ok(r.errors.some(e => /写了 N\/A 但没写理由/.test(e)))
})

test('R2 边界列填了别的话（既不是 facet 也不是 N/A:理由）→ 拦', () => {
  const r = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table([
      '| A | 页面 | u | s | d0#1 | | | | |',
      '| A / 提交 | 动作 | | | d0#2 | REQ-1-F1 | 会有提示 | N/A:无请求 | REQ-1-F2 |',
    ])),
  })
  assert.ok(r.errors.some(e => /既不是 facet ID 也不是/.test(e)))
})

test('R3 源单元必须回指，或显式「补充:理由」——这一列让「材料本身写得浅」可数', () => {
  const missing = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table(['| A | 页面 | u | s | | | | | |', '| A / B | 展示 | | | d0#2 | REQ-1-F1 | | | |'])),
  })
  assert.ok(missing.errors.some(e => /节点「A」缺源单元回指/.test(e)))

  const bare = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table(['| A | 页面 | u | s | 补充: | | | | |', '| A / B | 展示 | | | d0#2 | REQ-1-F1 | | | |'])),
  })
  assert.ok(bare.errors.some(e => /`补充:` 必须写理由/.test(e)))

  const ok = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table([
      '| A | 页面 | u | s | d0#1 | | | | |',
      '| A / 详情空态 | 展示 | | | 补充:PRD 只写了点进详情，没写查不到数据时显示什么 | REQ-1-F1 | | | |',
    ])),
  })
  assert.equal(ok.treeComplete, true, ok.errors.join(' / '))
  assert.equal(ok.stats.supplemented, 1)     // ← 这就是溯源闸够不到的那一半，第一次可数
})

test('源单元归属到未清点的材料 → warning（别静默）', () => {
  const r = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table(['| A | 页面 | u | s | dX#1 | | | | |', '| A / B | 展示 | | | d0#2 | REQ-1-F1 | | | |'])),
  })
  assert.ok(r.warnings.some(w => /未清点的材料「dx」/i.test(w)))
})

test('类型必填且合枚举（一个词的成本，换来 R2 能分档）', () => {
  const r = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table(['| A | | u | s | d0#1 | | | | |', '| A / B | 神秘类型 | | | d0#2 | REQ-1-F1 | | | |'])),
  })
  assert.ok(r.errors.some(e => /节点「A」缺类型/.test(e)))
  assert.ok(r.errors.some(e => /类型「神秘类型」不合枚举/.test(e)))
})

test('叶子缺目标用户/使用场景（且祖先也没有）→ 拦', () => {
  const r = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table(['| A | 页面 | | | d0#1 | | | | |', '| A / B | 展示 | | | d0#2 | REQ-1-F1 | | | |'])),
  })
  assert.ok(r.errors.some(e => /叶子「A \/ B」缺目标用户/.test(e)))
  assert.ok(r.errors.some(e => /叶子「A \/ B」缺使用场景/.test(e)))
})

// ---------- 与溯源闸双向对账 ----------

test('溯源表里已立需求的 facet 没挂到树上 → warning（它属于哪块功能？）', () => {
  const r = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table(OK_ROWS)),
    traceMappedFacets: ['REQ-1-F1', 'REQ-1-F5'],
  })
  assert.ok(r.warnings.some(w => /facet REQ-1-F5 在溯源表里已立需求，但没挂到功能树/.test(w)))
  assert.ok(!r.warnings.some(w => /REQ-1-F1 在溯源表/.test(w)))   // F1 挂在叶子上，不该报
})

// ---------- 指针与向后兼容（同溯源闸的 opt-in 传统）----------

test('缺 feature_tree_doc：新档案硬挡、老档案只软提示', () => {
  const fresh = computeFeatureTree({ rows: [], createdOn: '2026-09-20' })
  assert.equal(fresh.active, true)
  assert.ok(fresh.errors.some(e => /缺 frontmatter.feature_tree_doc/.test(e)))
  const old = computeFeatureTree({ rows: [], createdOn: '2026-08-01' })
  assert.equal(old.active, false)
  assert.equal(old.errors.length, 0)
  assert.ok(old.warnings.some(w => /缺 frontmatter.feature_tree_doc/.test(w)))
})

test('指针在但文件读不到 / 表解析不到 → 拦（读不到≠没缺口）', () => {
  const gone = computeFeatureTree({ ...base, rows: [], treeDocMissing: true })
  assert.ok(gone.errors.some(e => /找不到\/读不到/.test(e)))
  const empty = computeFeatureTree({ ...base, rows: [] })
  assert.ok(empty.errors.some(e => /解析不到功能树表/.test(e)))
})

// ---------- 渲染：图由引擎生成，不许手画 ----------

test('renderFeatureTree 画出层级 + 叶子标记（facet / 材料未覆盖 / 缺边界）', () => {
  const r = computeFeatureTree({
    ...base,
    rows: extractTreeRows(table([
      '| A | 页面 | u | s | d0#1 | | | | |',
      '| A / B | 动作 | | | 补充:PRD 没写 | REQ-1-F1 | | | |',
    ])),
  })
  const out = renderFeatureTree(r)
  assert.ok(out.includes('├─ ') || out.includes('└─ '))
  assert.ok(out.includes('〈动作〉'))
  assert.ok(out.includes('✚材料未覆盖'))
  assert.ok(out.includes('⚠缺边界:空态/失败态/无权限'))
  assert.ok(out.includes('不许进开发'))
})

test('渲染有行数上限（300+ 节点的树别把工具返回撑爆）', () => {
  const many = ['| A | 页面 | u | s | d0#1 | | | | |']
  for (let i = 0; i < 60; i++) many.push(`| A / N${i} | 展示 | | | d0#${i} | REQ-1-F1 | | | |`)
  const r = computeFeatureTree({ ...base, rows: extractTreeRows(table(many)) })
  const out = renderFeatureTree(r, { maxLines: 10 })
  assert.ok(out.includes('还有 51 行'))
})

test('枚举自身的约定：交互类是动作/交互/表单三种', () => {
  assert.deepEqual([...INTERACTIVE_KINDS].sort(), ['交互', '动作', '表单'].sort())
  for (const k of INTERACTIVE_KINDS) assert.ok(NODE_KINDS.includes(k))
})

test('★模板占位行不当数据：`<一级：页面/模块>` 不会被拆成野节点', () => {
  const rows = extractTreeRows(table([
    '| <一级：页面/模块> | 页面 | <谁在用> | <场景> | d0#0 | | | | |',
    '| A | 页面 | u | s | d0#1 | | | | |',
    '| A / B | 展示 | | | d0#2 | REQ-1-F1 | | | |',
  ]))
  assert.deepEqual(rows.map(r => r.key), ['A', 'A / B'])
  assert.equal(computeFeatureTree({ ...base, rows }).treeComplete, true)
})
