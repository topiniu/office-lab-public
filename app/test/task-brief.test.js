import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  extractDecisions, costMissing, isDecisionClosed, buildAcceptance,
  extractTimeline, buildMilestones, buildDelta, buildBrief, renderBrief,
} from '../task-brief.js'
import { humanizeCoverage, coverageCell, humanizeFacetGroup, humanizeVersionState, unmetGates, findTermLeaks, humanizeTerms, KNOWN_TERMS } from '../humanize.js'

// ---------- humanize：术语 → 行动 ----------

test('HUMAN_INHERENT 不再是状态，而是「要你亲眼看：看什么」', () => {
  const h = humanizeCoverage('HUMAN_INHERENT', { facetId: 'REQ-0341-F29', criterion: '备货单列表出现「首单/返单」列' })
  assert.equal(h.label, '要人亲眼看')
  assert.equal(h.who, 'you')
  assert.ok(h.action.includes('备货单列表出现「首单/返单」列'), '必须把"看什么"拼进行动')
})

test('SOURCE_ATTESTED 要说清风险，不只是换个中文词', () => {
  const h = humanizeCoverage('SOURCE_ATTESTED', { criterion: '保存后回读一致' })
  assert.equal(h.label, '只读了代码')
  assert.ok(/没真跑/.test(h.plain))
  assert.ok(/404|真跑/.test(h.action), '要带上"读代码看着对、跑起来不一定对"的判据')
})

test('未知状态不硬翻（known=false），提示退回补状态', () => {
  const h = humanizeCoverage('WHATEVER')
  assert.equal(h.known, false)
  assert.ok(/补状态/.test(h.action))
})

test('★一格堆 8 个 REQ-xxxx-Fn(HUMAN_INHERENT) 摊成按「谁来做」分组的清单', () => {
  const rows = [
    { facetId: 'REQ-0341-F29', status: 'HUMAN_INHERENT', criterion: '出现首返列' },
    { facetId: 'REQ-0341-F30', status: 'HUMAN_INHERENT', criterion: '出现进度列' },
    { facetId: 'REQ-0341-F33', status: 'SOURCE_ATTESTED', criterion: '快照取不到时降级为—' },
    { facetId: 'REQ-0341-F31', status: 'COVERED_GREEN', criterion: '首返判定' },
  ]
  const gs = humanizeFacetGroup(rows)
  assert.equal(gs.length, 3)
  assert.equal(gs[0].who, 'you', '要老板做的排最前')
  assert.equal(gs[0].items.length, 2)
  assert.ok(gs[0].items[0].what)
})

test('版本态与门禁都说人话；门禁只报没过的那几道、且说清"没过意味着什么"', () => {
  assert.equal(humanizeVersionState('in_qa'), '在测')
  assert.ok(/没有对应人话/.test(humanizeVersionState('新枚举没登记')), '新枚举要自曝，别静默显英文')
  const un = unmetGates({ qa_passed: false, released_prod: false, requirement_trace_complete: true, 不认识的字段: false })
  assert.deepEqual(un.map(g => g.label), ['QA 通过', '线上发布'])
  assert.ok(un[0].why)
})

test('术语泄漏自检：给人看的文本里混进机器枚举要被揪出来', () => {
  assert.deepEqual(findTermLeaks('REQ-0341-F29(HUMAN_INHERENT)、F30(HUMAN_INHERENT)'), ['HUMAN_INHERENT'])
  assert.deepEqual(findTermLeaks('三红灯：forbidden_action 0 / fake_green 0').sort(), ['fake_green', 'forbidden_action'])
  assert.deepEqual(findTermLeaks('要你亲眼看：备货单列表出现首返列'), [])
})

// ---------- ② 决定：扫全档案的待拍表 ----------

const ARCHIVE = `---
task: 项目跟踪监控 v0.1.0
version: v0.1.0
status: IN_QA
owner: ggbond
updated: 2026-09-09
gates:
  qa_passed: false
  requirement_trace_complete: true
---

# 任务：大货备货

## 需求条目登记表

| # | 条目 | 来源 | 进入日期 | 状态 | 当前阶段 | 影响面备注 |
|---|------|------|---------|------|---------|-----------|
| REQ-0338 | 环节标准配置 | 原始需求 | 2026-09-07 | 待人工验收 | → 待老板 | facet F1-F9 |
| REQ-0341 | 备货单列表+2列 | 原始需求 | 2026-09-07 | 打回 | 老板预检打回 | facet F29-F37 |

## 待确认事项

| # | 事项 | 拟定口径 | 不拍的代价 | 状态 |
|---|------|---------|-----------|------|
| C1 | 双库核表 | 方案a | 阻塞 REQ-0339 开工 | ✅ 已定 |
| C2 | 首返判定态 | 曾进已发货 | 判定引擎口径错，返工 2 处 |  |

## 全量梳理复盘（2026-09-09）

### 待老板拍（本轮新发现·13 条口径未定 A-M）

| # | 页 | 事项 | 拟定口径（不拍时的默认） | 不拍的代价 |
|---|----|------|------------------------|-----------|
| A | 环节配置 | 跟单负责人必填还是选填 | 选填、可就地改 | 改了要返工绑定弹窗+汇总分组 |
| H | 供应商确认 | F22 硬校验粒度（疑似测错粒度） | 逐尺码 0≤填≤计划 |  |
| M | 备货列表 | 首返快照取不到的严重度 | 定「中」 | 只影响告警分级 |

## 时间线

- 2026-09-07 创建任务。老板给原型 Demo+PRD，菲菲做需求分析
- 2026-09-08 老板预检打回：太浅显，与 Demo 丰富度差距大
- 2026-09-09 菲菲全量重新梳理完成，facet 38→100
- 2026-09-09 GG Bond gap 调查交回，2 项待拍

## 覆盖矩阵

| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |
|----------|------|------|------|------|------|---------|
| REQ-0338-F1 | REQ-0338 | P0 | auto | COVERED_GREEN | x | y |
| REQ-0338-F7 | REQ-0338 | P0 | auto | SOURCE_ATTESTED | | |
| REQ-0341-F29 | REQ-0341 | P0 | human-inherent | HUMAN_INHERENT | | |
`

test('★扫全档案：「待确认事项」和「### 待老板拍」两张表都收，已定的自动排除', () => {
  const ds = extractDecisions(ARCHIVE)
  const open = ds.filter(d => !d.closed)
  assert.equal(ds.length, 5)
  assert.equal(open.length, 4, '只有 C1 是已定')
  assert.ok(open.some(d => d.id === 'A' && /必填还是选填/.test(d.topic)))
  assert.ok(open.some(d => d.id === 'C2'))
  // 出自哪一节要留着——人得知道这条是哪一轮/谁提的
  assert.ok(open.find(d => d.id === 'A').section.includes('待老板拍'))
})

test('已定的判定宽松（已定/已拍/✅ 都算），拿不准一律算还开着', () => {
  assert.equal(isDecisionClosed('✅ 已定'), true)
  assert.equal(isDecisionClosed('已拍板'), true)
  assert.equal(isDecisionClosed(''), false)
  assert.equal(isDecisionClosed('在讨论'), false, '拿不准要算还开着——宁可多报一条，不许让问题静默消失')
})

test('★「不拍的代价」缺失要被点名（菲菲必填、引擎校空）', () => {
  const miss = costMissing(extractDecisions(ARCHIVE).filter(d => !d.closed))
  assert.deepEqual(miss.map(d => d.id).sort(), ['H'])
})

test('模板占位行不当数据', () => {
  const ds = extractDecisions('## 待确认事项\n\n| # | 事项 | 拟定口径 |\n|---|---|---|\n| C1 | <事项> | <拟定> |')
  assert.deepEqual(ds, [])
})

// ---------- ③ 验收 ----------

test('验收区按条目分组，并把「要你亲眼看」单独拎出来（带看什么）', () => {
  const entries = [
    { no: 'REQ-0338', name: '环节标准配置', status: '待人工验收' },
    { no: 'REQ-0341', name: '备货单列表+2列', status: '打回' },
  ]
  const matrix = [
    { facetId: 'REQ-0338-F1', status: 'COVERED_GREEN' },
    { facetId: 'REQ-0338-F7', status: 'SOURCE_ATTESTED' },
    { facetId: 'REQ-0341-F29', status: 'HUMAN_INHERENT' },
  ]
  const facets = [{ id: 'REQ-0338-F7', criterion: '保存后回读一致' }, { id: 'REQ-0341-F29', criterion: '列表出现首返列' }]
  const acc = buildAcceptance({ entries, matrix, facets })
  const a338 = acc.find(a => a.no === 'REQ-0338')
  assert.equal(a338.acceptable, true)
  assert.equal(a338.green, 1)
  assert.equal(a338.risky.length, 1)
  assert.ok(a338.risky[0].action.includes('保存后回读一致'))
  const a341 = acc.find(a => a.no === 'REQ-0341')
  assert.equal(a341.acceptable, false, '打回态不算"可验收"')
  assert.ok(a341.needYou[0].what.includes('首返列'))
})

// ---------- ① delta / ④ 里程碑 ----------

test('delta 只给"上次看之后"的变化，不是第二份时间线', () => {
  const tl = extractTimeline(ARCHIVE)
  assert.equal(tl.length, 4)
  const d = buildDelta({ timeline: tl, since: '2026-09-08' })
  assert.equal(d.count, 2)
  assert.deepEqual(d.days, ['2026-09-09'])
  assert.ok(d.items[0].head.length <= 120)
})

test('delta 有上限（12 条），超出的如实说还有多少——不静默截断', () => {
  const tl = Array.from({ length: 30 }, (_, i) => ({ date: '2026-09-09', head: 'x' + i, len: 10 }))
  const d = buildDelta({ timeline: tl, since: '2026-09-08' })
  assert.equal(d.items.length, 12)
  assert.equal(d.truncated, 18)
})

test('里程碑只挑人会关心的几类（拍板/返工/交付/过检），普通进展不进', () => {
  const ms = buildMilestones(extractTimeline(ARCHIVE))
  assert.ok(ms.some(m => m.kind === '开档'))
  assert.ok(ms.some(m => m.kind === '返工'))
  assert.ok(!ms.some(m => /gap 调查/.test(m.head)), '普通进展不该进里程碑')
})

// ---------- 汇总 ----------

function briefOf(since) {
  const entries = [
    { no: 'REQ-0338', name: '环节标准配置', status: '待人工验收' },
    { no: 'REQ-0341', name: '备货单列表+2列', status: '打回', stage: '老板预检打回' },
  ]
  const matrix = [
    { facetId: 'REQ-0338-F1', status: 'COVERED_GREEN' },
    { facetId: 'REQ-0338-F7', status: 'SOURCE_ATTESTED' },
    { facetId: 'REQ-0341-F29', status: 'HUMAN_INHERENT' },
  ]
  return buildBrief({
    text: ARCHIVE,
    fm: { task: '大货备货', version: 'v0.1.0', status: 'IN_QA', owner: 'ggbond', updated: '2026-09-09', gates: { qa_passed: false, requirement_trace_complete: true } },
    entries, matrix,
    facets: [{ id: 'REQ-0338-F7', criterion: '保存后回读一致' }, { id: 'REQ-0341-F29', criterion: '列表出现首返列' }],
    since,
  })
}

test('简报＝三件事 + 变化 + 台账只给汇总数', () => {
  const b = briefOf('2026-09-08')
  assert.equal(b.stateText, '在测')
  assert.equal(b.decisions.length, 4)
  assert.equal(b.blocked.length, 1)
  assert.equal(b.waitingYouCount, 1)
  assert.equal(b.needYouEyes.length, 1)
  assert.equal(b.delta.count, 2)
  assert.deepEqual(b.unmet.map(g => g.label), ['QA 通过'])
  assert.equal(b.ledger.matrixRows, 3)
})

test('★渲染出来的简报里不许有机器术语（术语泄漏自检兜底）', () => {
  const md = renderBrief(briefOf('2026-09-08'))
  assert.deepEqual(findTermLeaks(md), [], '简报正文出现机器枚举 = 翻译层漏了')
  assert.ok(md.includes('等你拍板'))
  assert.ok(md.includes('不拍的代价'))
  assert.ok(md.includes('⚠ **没写代价**'), '缺代价要在单子上显式亮出来，而不是留空')
  // 「要你亲眼看」这一节的小标题已经说了要干什么，逐条只给"看什么"，不再复述一遍动作
  assert.ok(/机器测不了、要你亲眼看/.test(md))
  assert.ok(/REQ-0341-F29\*\*：列表出现首返列/.test(md))
  // 证据不硬的那节：同类只解释一遍风险（组标题），底下逐条只给判据
  assert.ok(/\*\*只读了代码\*\*（.*没真跑/.test(md), '组标题要说清这类为什么不硬')
  assert.ok(/- REQ-0338-F7：保存后回读一致/.test(md))
})

// ---------- 对真实档案跑一遍（回归防漂） ----------

test('真实档案（大货备货 v0.1.0）能抽出待拍与时间线，且简报不含术语', () => {
  const p = path.join(import.meta.dirname, '..', '..', 'tasks', '项目跟踪监控-v0.1.0.md')
  if (!fs.existsSync(p)) return                     // 档案被归档/改名不算测试失败
  const text = fs.readFileSync(p, 'utf8')
  const ds = extractDecisions(text).filter(d => !d.closed)
  // 阈值刻意只要 ≥1：这条测的是**抽取器认不认真实档案的排版**（多张同形表、加粗、口径修订行），
  // 不是"这份档案里有多少条待拍"——那是个会动的业务数字。2026-09-09 菲菲清了待拍表（7 条已拍的移除、
  // 剩 6 条），断言 ≥10 当场变红，而抽取器一行没坏。**把单测绑在活文档的条数上，改的是业务、红的是引擎。**
  assert.ok(ds.length >= 1, `真实档案应能抽出待拍条目，实得 ${ds.length}`)
  assert.ok(extractTimeline(text).length >= 20)
  const b = buildBrief({ text, fm: { version: 'v0.1.0', status: 'IN_QA' }, entries: [], matrix: [], facets: [], since: '2026-09-08' })
  assert.deepEqual(findTermLeaks(renderBrief(b)), [])
})

test('★表头「拟定口径（不拍时的默认）」不许被当成代价列（同前缀撞车，会把缺代价的行显示成已写）', () => {
  const md = `## 待老板拍

| # | 页 | 事项 | 拟定口径（不拍时的默认） |
|---|----|------|------------------------|
| A | 环节配置 | 负责人必填还是选填 | 选填、可就地改 |
`
  const [d] = extractDecisions(md)
  assert.equal(d.proposal, '选填、可就地改')
  assert.equal(d.cost, '', '这张表没有代价列，cost 必须是空')
  assert.deepEqual(costMissing([d]).map(x => x.id), ['A'])
})

// ---------- 术语透传：简报是给老板看的，档案原文里的机器术语不许直达（§3.131） ----------
test('★ 收口翻译的不变量：任何输入渲染出的简报都不含机器术语（对以后新写进档案的术语同样成立）', () => {
  const md = `---
version: v9.9.9
---

## 时间线

- 2026-09-09 迷糊 QA 进展：14 facet 机签 COVERED_GREEN + RED 校准齐；F17 判 SOURCE_ATTESTED、F18 是 HUMAN_INHERENT
- 2026-09-09 守航：三红灯 forbidden_action 0 / fake_green 1 / over_budget 0

## 待老板拍

| # | 事项 | 拟定口径 |
|---|------|---------|
| A | F20 到底算 BLOCKED_WITH_PROOF 还是 UNCOVERED | 先按 UNCOVERED 记 |
`
  const out = renderBrief(buildBrief({ text: md, fm: { version: 'v9.9.9', status: 'in_qa' }, entries: [], matrix: [], facets: [], since: '2026-09-08' }))
  assert.deepEqual(findTermLeaks(out), [], `简报里漏了机器术语：${findTermLeaks(out).join('、')}`)
  // 翻译不是删除——原意要还在（用短名替换，不能把整句冲烂）
  assert.match(out, /机器验过|只读了代码|要人亲眼看|假绿/)
})

// ---------- humanizeTerms：自由文本里的术语就地换人话 ----------
test('humanizeTerms 用短名就地替换，句子结构不被冲烂', () => {
  assert.equal(humanizeTerms('累计 COVERED_GREEN 27 条'), '累计 机器验过 27 条')
  assert.equal(humanizeTerms('F17 判 SOURCE_ATTESTED'), 'F17 判 只读了代码')
  assert.equal(humanizeTerms('三红灯：forbidden_action 0 / fake_green 1'), '三红灯：碰了不许碰的东西 0 / 假绿 1')
})
test('humanizeTerms 不认识的词原样留下（不猜、不吞）', () => {
  assert.equal(humanizeTerms('状态 SOME_FUTURE_ENUM 待定'), '状态 SOME_FUTURE_ENUM 待定')
})
test('humanizeTerms 对空值安全', () => {
  assert.equal(humanizeTerms(null), '')
  assert.equal(humanizeTerms(undefined), '')
  assert.equal(humanizeTerms(''), '')
})
test('★ findTermLeaks(humanizeTerms(x)) 恒为空 —— 两个函数共用同一份词表，不许分叉', () => {
  const soup = Object.values(KNOWN_TERMS).flat().join(' ') + ' 夹杂中文 COVERED_GREEN fake_green'
  assert.deepEqual(findTermLeaks(humanizeTerms(soup)), [])
})
test('★ 正则不共享 lastIndex：连续交替调用结果稳定（/g 正则共享实例是经典隐蔽 bug）', () => {
  const t = 'COVERED_GREEN 与 fake_green'
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(findTermLeaks(t).sort(), ['COVERED_GREEN', 'fake_green'])
    assert.equal(humanizeTerms(t), '机器验过 与 假绿')
  }
})
