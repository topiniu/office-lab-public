import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseInquiryMarks, extractWorkflows, computeWorkflowCoverage,
  generateCritiqueCandidates, extractCritiqueResponses, computeCritique,
  snapshotBaseline, computeReqDrift, computeReqQuality, renderReqQuality, THRESHOLDS,
} from '../req-quality.js'
import { extractTreeRows, computeFeatureTree } from '../feature-tree.js'

const wfTable = rows => `
## 用户工作流

| 角色 | 流程 | 步序 | 这一步做什么 | 落在哪个节点 |
|------|------|------|-------------|-------------|
${rows.join('\n')}
`
const critiqueTable = rows => `
## 自我批判回应

| 候选ID | 机器点名的问题 | 我的回应 | 归宿 |
|--------|--------------|---------|------|
${rows.join('\n')}
`
const TREE_OK = extractTreeRows(`
| 节点路径 | 类型 | 目标用户 | 使用场景 | 源单元 | facet | 空态 | 失败态 | 无权限 |
|---|---|---|---|---|---|---|---|---|
| 工作台 | 页面 | 跟单员 | 每天早上看该催谁 | d0#0 | | | | |
| 工作台 / 列表 | 展示 | | | d0#1 | REQ-1-F1 | | | |
| 工作台 / 催单 | 动作 | | | d0#2 | REQ-1-F2 | REQ-1-F3 | N/A:纯前端 | REQ-1-F4 |
`)
const treeOf = rows => computeFeatureTree({
  rows, facetIds: ['REQ-1-F1', 'REQ-1-F2', 'REQ-1-F3', 'REQ-1-F4'],
  materialIds: ['d0'], treeDocRel: 'x.md', createdOn: '2026-09-20',
})

// ---------- ① 反向提问：标了不确定就必须问出去 ----------

test('七项拷问打标可数（【已知】/【假设·待确认】/【缺口·必问】）', () => {
  const r = parseInquiryMarks('①【已知】来源A ②【假设·待确认】 ③【缺口·必问】 ④【假设·待确认】\n\n## 五、待确认事项\n\n| # | 事项 |\n|---|---|\n| C1 | x |')
  assert.equal(r.known, 1)
  assert.equal(r.assume, 2)
  assert.equal(r.gap, 1)
  assert.equal(r.marked, 3)
  assert.equal(r.pendingRows, 1)
})

test('标了不确定却没进「待确认事项」→ 硬拦（别自己把问题消化掉）', () => {
  const r = computeReqQuality({
    facetDocText: '②【假设·待确认】 ③【缺口·必问】',
    qualityDocText: wfTable(['| 跟单员 | 早上跟单 | 1 | 打开工作台 | 工作台 |', '| 跟单员 | 早上跟单 | 2 | 看列表 | 工作台 / 列表 |', '| 跟单员 | 早上跟单 | 3 | 催单 | 工作台 / 催单 |']),
    treeNodes: [], createdOn: '2026-09-20',
  })
  assert.ok(r.errors.some(e => /标了 2 处不确定.*「待确认事项」表是空的/.test(e)))
})

test('老格式文档（一个打标都没有）零误报——由候选 Q8 兜底而不是硬拦', () => {
  const r = parseInquiryMarks('普通需求文档，没有任何打标')
  assert.equal(r.marked, 0)
  const q = computeReqQuality({ facetDocText: '普通需求文档', qualityDocText: '', treeNodes: [], createdOn: '2026-08-01' })
  assert.equal(q.active, false)
  assert.ok(!q.errors.some(e => /标了.*不确定/.test(e)))
})

// ---------- ⑤ 工作流优先：与功能树双向对账 ----------

test('工作流每步必须落在功能树节点上（落不上＝用户走不通）', () => {
  const tree = treeOf(TREE_OK)
  const wf = extractWorkflows(wfTable([
    '| 跟单员 | 早上跟单 | 1 | 打开工作台 | 工作台 |',
    '| 跟单员 | 早上跟单 | 2 | 看今天该催谁 | 工作台 / 列表 |',
    '| 跟单员 | 早上跟单 | 3 | 导出报表 | 工作台 / 导出 |',
  ]))
  const r = computeWorkflowCoverage({ workflows: wf, treeNodes: tree.tree.nodes })
  assert.ok(r.errors.some(e => /节点「工作台 \/ 导出」不在功能树里/.test(e)))
  assert.equal(r.orphanSteps, 1)
})

test('工作流缺失 / 步数过少 → 拦（不足 3 步说明拆的是功能不是流程）', () => {
  assert.ok(computeWorkflowCoverage({ workflows: [], treeNodes: [] }).errors.some(e => /缺「用户工作流」表/.test(e)))
  const short = computeWorkflowCoverage({
    workflows: extractWorkflows(wfTable(['| 跟单员 | 早上跟单 | 1 | 打开 | 工作台 |', '| 跟单员 | 早上跟单 | 2 | 看 | 工作台 / 列表 |'])),
    treeNodes: treeOf(TREE_OK).tree.nodes,
  })
  assert.ok(short.errors.some(e => /只有 2 步/.test(e)))
})

test('模板占位行不当数据（<角色> / <节点> 那种）', () => {
  assert.deepEqual(extractWorkflows(wfTable(['| <角色> | <流程> | 1 | <做什么> | <节点路径> |'])), [])
})

test('全部落点合法 → 无 error，并记下用到了哪些节点（供 Q9 反查）', () => {
  const tree = treeOf(TREE_OK)
  const r = computeWorkflowCoverage({
    workflows: extractWorkflows(wfTable([
      '| 跟单员 | 早上跟单 | 1 | 打开工作台 | 工作台 |',
      '| 跟单员 | 早上跟单 | 2 | 看今天该催谁 | 工作台 / 列表 |',
      '| 跟单员 | 早上跟单 | 3 | 复制话术去催 | 工作台 / 催单 |',
    ])),
    treeNodes: tree.tree.nodes,
  })
  assert.deepEqual(r.errors, [])
  assert.equal(r.stepCount, 3)
  assert.ok(r.usedNodes.has('工作台 / 催单'))
})

// ---------- ④ 自我批判：机器点名、她必须逐条回应 ----------

test('候选 Q1：一条 `补充:` 都没有 = 没跳出材料想过', () => {
  const tree = treeOf(TREE_OK)
  const c = generateCritiqueCandidates({ tree, facets: [] })
  assert.ok(c.some(x => x.id === 'Q1'))
})

test('候选 Q2：facet 数远低于源单元数（事故版 38/308=0.12 会被点名）', () => {
  const trace = { materials: [{ id: 'd0', units: 308 }], rowCount: 308, outTotal: 0 }
  const facets = Array.from({ length: 38 }, (_, i) => ({ id: `REQ-1-F${i}` }))
  const c = generateCritiqueCandidates({ trace, facets })
  const q2 = c.find(x => x.id === 'Q2')
  assert.ok(q2, '事故版必须被点名')
  assert.ok(/38 对源单元 308/.test(q2.title))
  // 比例达标就不点名
  const ok = generateCritiqueCandidates({ trace, facets: Array.from({ length: 100 }, (_, i) => ({ id: `REQ-1-F${i}` })) })
  assert.ok(!ok.some(x => x.id === 'Q2'))
})

test('候选 Q3/Q4/Q6/Q7：甩包袱 / 动作登记成展示 / 没分层 / 树太浅', () => {
  const c3 = generateCritiqueCandidates({ trace: { materials: [], rowCount: 10, outTotal: 6 } })
  assert.ok(c3.some(x => x.id === 'Q3'))

  const leaves = ['| P | 页面 | u | s | d0#0 | | | | |']
  for (let i = 0; i < 10; i++) leaves.push(`| P / L${i} | 展示 | | | d0#${i} | REQ-1-F1 | | | |`)
  const flat = computeFeatureTree({ rows: extractTreeRows(`| 节点路径 | 类型 | 目标用户 | 使用场景 | 源单元 | facet | 空态 | 失败态 | 无权限 |\n|---|---|---|---|---|---|---|---|---|\n${leaves.join('\n')}`), facetIds: ['REQ-1-F1'], materialIds: ['d0'], treeDocRel: 'x', createdOn: '2026-09-20' })
  const c4 = generateCritiqueCandidates({ tree: flat })
  assert.ok(c4.some(x => x.id === 'Q4'), '交互类叶子占比过低要点名')
  assert.ok(c4.some(x => x.id === 'Q7'), '树只有 2 层要点名')

  const c6 = generateCritiqueCandidates({ facets: Array.from({ length: 12 }, (_, i) => ({ id: `REQ-1-F${i}`, level: 'P0', criterion: '空态 无权限 失败' })) })
  assert.ok(c6.some(x => x.id === 'Q6'))
})

test('候选 Q5：边界类 facet 占比过低（只写了 happy path）', () => {
  const facets = Array.from({ length: 20 }, (_, i) => ({ id: `REQ-1-F${i}`, level: i % 2 ? 'P0' : 'P1', criterion: '点击后正常展示列表' }))
  assert.ok(generateCritiqueCandidates({ facets }).some(x => x.id === 'Q5'))
  const withBoundary = facets.map((f, i) => (i < 6 ? { ...f, criterion: '无权限时不渲染' } : f))
  assert.ok(!generateCritiqueCandidates({ facets: withBoundary }).some(x => x.id === 'Q5'))
})

test('候选 Q8：七项拷问全标【已知】、零假设零缺口', () => {
  const c = generateCritiqueCandidates({ inquiry: { known: 7, marked: 0, assume: 0, gap: 0 } })
  assert.ok(c.some(x => x.id === 'Q8'))
})

test('候选 Q9：交互类叶子没出现在任何工作流里（孤立动作）', () => {
  const tree = treeOf(TREE_OK)
  const wf = computeWorkflowCoverage({
    workflows: extractWorkflows(wfTable([
      '| 跟单员 | 早上跟单 | 1 | 打开 | 工作台 |',
      '| 跟单员 | 早上跟单 | 2 | 看列表 | 工作台 / 列表 |',
      '| 跟单员 | 早上跟单 | 3 | 再看一眼 | 工作台 / 列表 |',
    ])),
    treeNodes: tree.tree.nodes,
  })
  const c = generateCritiqueCandidates({ tree, workflows: wf })
  const q9 = c.find(x => x.id === 'Q9')
  assert.ok(q9 && /催单/.test(q9.why))
})

test('候选 Q10：降级读法的材料要被点名（那块口径出错概率更高）', () => {
  const c = generateCritiqueCandidates({ trace: { materials: [{ id: 'd1', units: 2, read: 'degraded' }], rowCount: 2, outTotal: 0 } })
  assert.ok(c.some(x => x.id === 'Q10'))
})

test('★每条候选必须有归宿，留空/格式不合一律拦', () => {
  const candidates = [{ id: 'Q1', title: 'x', why: 'y' }, { id: 'Q2', title: 'x', why: 'y' }]
  const none = computeCritique({ candidates, responses: [] })
  assert.equal(none.errors.length, 2)
  assert.ok(none.errors[0].includes('还没回应'))

  const bad = computeCritique({ candidates, responses: extractCritiqueResponses(critiqueTable(['| Q1 | x | 我觉得还行 | 应该没问题 |', '| Q2 | x | y | 已补: |'])) })
  assert.ok(bad.errors.some(e => /Q1 的归宿.*不合格式/.test(e)))
  assert.ok(bad.errors.some(e => /Q2 的「已补」后面没写内容/.test(e)))

  const good = computeCritique({ candidates, responses: extractCritiqueResponses(critiqueTable(['| Q1 | x | 确实没跳出材料 | 已补:REQ-1-F9 详情空态 |', '| Q2 | x | 源单元里有 80 条是同一张表的列 | 不是问题:同表列合并成一条 facet 是刻意的 |'])) })
  assert.deepEqual(good.errors, [])
  assert.equal(good.answered, 2)
})

test('归宿标「已补」但给不出可核对落点 → warning', () => {
  const r = computeCritique({
    candidates: [{ id: 'Q1', title: 'x', why: 'y' }],
    responses: extractCritiqueResponses(critiqueTable(['| Q1 | x | 补过了 | 已补:补了几条 |'])),
  })
  assert.deepEqual(r.errors, [])
  assert.ok(r.warnings.some(w => /没给出可核对的落点/.test(w)))
})

test('产物改过后不再可疑的旧回应 → 提示可删（不当错）', () => {
  const r = computeCritique({ candidates: [], responses: extractCritiqueResponses(critiqueTable(['| Q7 | x | y | 已补:REQ-1-F1 |'])) })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.stale, ['Q7'])
})

// ---------- ⑥ 需求缺陷率：只报不拦 ----------

test('缺陷率 = (新增+删除)/冻结时条数；无基线返回 null（不瞎算）', () => {
  assert.equal(computeReqDrift(null, { facetIds: ['REQ-1-F1'] }), null)
  const base = snapshotBaseline({ facetIds: ['REQ-1-F1', 'REQ-1-F2', 'REQ-1-F3', 'REQ-1-F4'], at: '2026-09-08' })
  const d = computeReqDrift(base, { facetIds: ['REQ-1-F1', 'REQ-1-F2', 'REQ-1-F5'] })
  assert.equal(d.baseCount, 4)
  assert.deepEqual(d.added, ['REQ-1-F5'])
  assert.deepEqual(d.removed.sort(), ['REQ-1-F3', 'REQ-1-F4'])
  assert.equal(d.rate, 0.75)
  assert.equal(d.warn, true)
})

test('缺陷率只进 warnings，绝不硬拦（拦它会逼人不改需求）', () => {
  const base = snapshotBaseline({ facetIds: ['REQ-1-F1', 'REQ-1-F2'], at: '2026-09-08' })
  const r = computeReqQuality({
    facetDocText: '', qualityDocText: wfTable([
      '| 跟单员 | 早上跟单 | 1 | 打开 | 工作台 |',
      '| 跟单员 | 早上跟单 | 2 | 看列表 | 工作台 / 列表 |',
      '| 跟单员 | 早上跟单 | 3 | 催单 | 工作台 / 催单 |',
    ]) + critiqueTable([]),
    treeNodes: treeOf(TREE_OK).tree.nodes, tree: treeOf(TREE_OK),
    facets: [{ id: 'REQ-1-F1' }, { id: 'REQ-1-F9' }], baseline: base, createdOn: '2026-09-20',
  })
  assert.ok(r.drift && r.drift.rate === 1)
  assert.ok(r.warnings.some(w => /需求缺陷率 100%/.test(w)))
  assert.ok(!r.errors.some(e => /缺陷率/.test(e)))
})

// ---------- 汇总与渲染 ----------

test('汇总：工作流齐 + 候选全回应 + 打标问出去 → complete', () => {
  const tree = treeOf(TREE_OK)
  const qdoc = wfTable([
    '| 跟单员 | 早上跟单 | 1 | 打开工作台 | 工作台 |',
    '| 跟单员 | 早上跟单 | 2 | 看今天该催谁 | 工作台 / 列表 |',
    '| 跟单员 | 早上跟单 | 3 | 复制话术去催 | 工作台 / 催单 |',
  ]) + critiqueTable(['| Q1 | 一条补充都没有 | 确实没跳出材料 | 已补:工作台 / 列表 / 空态 |'])
  const r = computeReqQuality({
    facetDocText: '①【已知】A ②【假设·待确认】\n## 五、待确认事项\n| # | 事项 |\n|---|---|\n| C1 | 撤销后能否再发链接 |',
    qualityDocText: qdoc, treeNodes: tree.tree.nodes, tree, facets: [], createdOn: '2026-09-20',
  })
  assert.equal(r.complete, true, r.errors.join(' / '))
  assert.equal(r.stats.flows, 1)
  assert.equal(r.stats.steps, 3)
})

test('渲染：候选表 + 四项统计 + 明确结论', () => {
  const tree = treeOf(TREE_OK)
  const r = computeReqQuality({ facetDocText: '', qualityDocText: '', treeNodes: tree.tree.nodes, tree, facets: [], createdOn: '2026-09-20' })
  const out = renderReqQuality(r)
  assert.ok(out.includes('| 候选ID | 可疑点 | 为什么可疑 |'))
  assert.ok(out.includes('Q1'))
  assert.ok(out.includes('不许进开发'))
})

test('阈值都有出处（改阈值必须同时改注释里的判据）', () => {
  assert.equal(THRESHOLDS.facetPerUnitMin, 0.25)
  assert.ok(THRESHOLDS.facetPerUnitMin > 38 / 308, '阈值必须严于事故值，否则拦不住那次')
})

// ---------- 基线落盘：渲染 ↔ 解析 往返 ----------

test('基线 render/parse 往返一致（落在档案 `## 需求基线` 段，不塞 frontmatter）', async () => {
  const { renderBaseline, parseBaseline, BASELINE_HEADING } = await import('../req-quality.js')
  const b = snapshotBaseline({ facetIds: ['REQ-1-F2', 'REQ-1-F1'], treeStats: { leaves: 42, nodes: 118 }, traceStats: { unitTotal: 308 }, at: '2026-09-08' })
  const md = renderBaseline(b)
  assert.ok(md.startsWith(BASELINE_HEADING))
  const back = parseBaseline('# 任务\n\n' + md + '\n## 时间线\n\n- x\n')
  assert.deepEqual(back.facets, ['REQ-1-F1', 'REQ-1-F2'])   // snapshot 已排序
  assert.equal(back.at, '2026-09-08')
  assert.equal(back.leaves, 42)
  assert.equal(back.units, 308)
})

test('没有基线段 / 段里没 facet → parse 返回 null（不瞎造一个空基线）', async () => {
  const { parseBaseline } = await import('../req-quality.js')
  assert.equal(parseBaseline('# 任务\n\n## 时间线\n'), null)
  assert.equal(parseBaseline('\n## 需求基线\n\n- at: 2026-09-08\n- facets(0): \n'), null)
})

// ---------- 模板占位不许糊弄闸门 ----------

test('★照抄模板不算回应：`<...>` 占位行一律当没写（否则闸门可以靠抄骨架通过）', () => {
  const tplRow = '| Q1 | <从 validate_req_analysis 抄下来> | <你的判断> | 已补:REQ-xxxx-Fn |'
  assert.deepEqual(extractCritiqueResponses(critiqueTable([tplRow])), [])
  const r = computeCritique({ candidates: [{ id: 'Q1', title: 'x', why: 'y' }], responses: extractCritiqueResponses(critiqueTable([tplRow])) })
  assert.ok(r.errors.some(e => /Q1.*还没回应/.test(e)))
})

test('★待确认事项没写「不拍的代价」→ 硬拦（老板 2026-09-09 定：菲菲必填、引擎校空）', () => {
  const archive = `## 待确认事项

| # | 事项 | 拟定口径 | 不拍的代价 | 状态 |
|---|------|---------|-----------|------|
| C1 | 双库核表 | 方案a | 阻塞 REQ-0339 开工 |  |
| C2 | 首返判定态 | 曾进已发货 |  |  |
`
  const tree = treeOf(TREE_OK)
  const wf = wfTable([
    '| 跟单员 | 早上跟单 | 1 | 打开 | 工作台 |',
    '| 跟单员 | 早上跟单 | 2 | 看列表 | 工作台 / 列表 |',
    '| 跟单员 | 早上跟单 | 3 | 催单 | 工作台 / 催单 |',
  ])
  const r = computeReqQuality({
    facetDocText: '', qualityDocText: wf, treeNodes: tree.tree.nodes, tree,
    facets: [], createdOn: '2026-09-20', archiveText: archive,
  })
  assert.ok(r.errors.some(e => /有 1 条待老板拍的事项没写「不拍的代价」（C2）/.test(e)), r.errors.join(' / '))
  assert.ok(r.errors.some(e => /人做决定靠的是后果，不是选项/.test(e)))
})
