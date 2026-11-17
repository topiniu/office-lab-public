// ============================================================================
// 术语 → 人话（引擎侧唯一翻译层）
//
// 缘起（2026-09-09，老板：「晨检验收这个交互很奇怪：1 内容并不准确，2 有内容的话内容也是抽象用语，
// 不适合人类阅读」）。实况取证：给老板看的晨检包里印着 `REQ-0341-F29(HUMAN_INHERENT)` ×8 堆在一格、
// `forbidden_action` / `fake_green` / `over_budget` 三个英文 key 直接进表、`引擎派生状态：in_qa`、
// 拟定口径里甚至出现 `草稿表 sampling_tech_sheet_doc 有行且…`——**表名进了给老板看的单子**。
//
// 判断：这些词是**引擎的内部状态**，它们出现在人的界面上是泄漏，不是信息。人不需要学一遍词汇表——
// 词汇表的作用已经在门禁里兑现过了（gate 据它放行/拦下），到人这一层要回答的是**另一个问题**：
//   ❌ 「这条 facet 是 HUMAN_INHERENT」          ← 状态，人得自己翻译成行动
//   ✅ 「这条机器测不了，要你亲眼看：<看什么>」   ← 行动，人照着做就行
// 所以本模块的每个翻译都产出三段：**一句人话 · 你要做什么 · 谁来做**，而不只是换个中文词。
//
// 单一事实源纪律：晨检包（morning-report）、档案简报（task-brief）、看板/前端共用本模块。
// 以前每处各写一套中文，同一个 HUMAN_INHERENT 在三个地方是三种说法（这也是"抽象"的一部分：
// 读者得先判断这三种说法是不是同一件事）。
// ============================================================================

// ---------------------------------------------------------------------------
// 覆盖矩阵状态（coverage.js 的 COVERAGE_STATUS_ENUM）
// ---------------------------------------------------------------------------
// who: 'machine' | 'you'(老板) | 'qa'(迷糊) | 'dev'(GG Bond)——决定这条落到谁的待办里。
const COVERAGE = {
  COVERED_GREEN: {
    label: '机器验过', tone: 'ok', who: 'machine',
    plain: '机器真跑过、拿到了带哈希的证据',
    action: '不用你看',
  },
  SOURCE_ATTESTED: {
    label: '只读了代码', tone: 'risk', who: 'qa',
    plain: '只读了源码确认"实现在那儿"，**没真跑过**',
    action: '风险：代码看着对、跑起来不一定对（v5.10 就栽过一次：读代码判可保存，真跑发现补录接口 404）。让迷糊补一条真用例，或你自己点一下',
  },
  BLOCKED_WITH_PROOF: {
    label: '测不了·有凭据', tone: 'warn', who: 'qa',
    plain: '想测但被环境/依赖挡住了，且留了挡在哪的凭据',
    action: '看一眼挡的理由成不成立：成立就等前置，不成立就退回迷糊接着测',
  },
  HUMAN_INHERENT: {
    label: '要人亲眼看', tone: 'human', who: 'you',
    plain: '这条机器天生测不了（观感/真机/外部到达）',
    action: '要你或迷糊亲眼看一眼',
  },
  UNCOVERED: {
    label: '没测', tone: 'bad', who: 'qa',
    plain: '压根没测、也没给理由',
    action: '退回迷糊：要么测，要么如实标"为什么测不了"',
  },
}

// 三红灯（guard-ledger 的 forbidden_action / fake_green / over_budget）
const REDLIGHT = {
  forbidden_action: { label: '碰了不许碰的东西', plain: '员工试图做契约明令禁止的动作（生产 DDL / 真发企微 / 发布生产等），被引擎当场拦下' },
  fake_green: { label: '假绿', plain: '把"没真测过"报成了"测过并通过"——这是最贵的一种错，因为它让你以为可以放行' },
  over_budget: { label: '超预算', plain: '这一轮烧的 token 超过契约给的额度' },
}

// 版本派生态（server 的 version_state）
const VERSION_STATE = {
  drafting: '还在梳理需求',
  in_dev: '在开发',
  in_qa: '在测',
  rc_ready: '测完了，等你验收',
  released_test: '已发测试环境',
  released_prod: '已上线',
  done: '收尾完成',
}

// 门禁（任务档案 gates.*）：中文名 + **没过意味着什么**（不是重复 key 的字面意思）
const GATES = {
  requirement_trace_complete: { label: '需求溯源', unmet: '源材料还有单元没登记成需求——可能漏功能' },
  feature_tree_complete: { label: '功能树', unmet: '功能还没拆到叶子/叶子的边界没交代——可能漏边界' },
  req_analysis_complete: { label: '需求分析', unmet: '拷问的不确定没问出去、或引擎点名的可疑点没回应' },
  requirement_substance_complete: { label: '需求实质', unmet: '有 facet 一条吃十几个源单元、或 PRD 自标的待确认没进台账——登记了但没真梳理' },
  tripartite_review: { label: '三方会审', unmet: '开工前技术/测试没和菲菲对齐设计' },
  pm_confirmed: { label: '需求拍板', unmet: '会审暴露的口径还没你拍' },
  dev_confirmed: { label: '技术确认', unmet: 'GG Bond 的技术待确认项还没拍' },
  dev_selfcheck: { label: '开发自检', unmet: '性能/权限/testid/数据流四项自检没做完' },
  dev_adversarial_swept: { label: '对抗自查', unmet: 'GG Bond 没用红队视角打过自己的代码' },
  human_precheck_passed: { label: '最终验收', unmet: '你还没验收测过的版本' },
  qa_coverage_complete: { label: 'QA 覆盖', unmet: '还有验收标准没测到' },
  qa_red_calibrated: { label: 'RED 校准', unmet: '用例没验证过"实现坏掉时它会变红"——没校准的绿灯不算绿' },
  qa_passed: { label: 'QA 通过', unmet: '还有 P0 没过或缺陷没闭合' },
  released_test: { label: '测试发布', unmet: '还没发测试环境' },
  released_prod: { label: '线上发布', unmet: '还没上线' },
  post_release_done: { label: '上线收尾', unmet: '验证 SQL/权限确认/分支清理/发布四件套还没收' },
}

const _s = v => String(v == null ? '' : v).replace(/\*\*/g, '').trim()

// 覆盖状态 → {label, plain, action, tone, who}。带上 facet 的判据原文时，把「看什么」拼进 action
// ——这是本模块最要紧的一处：`HUMAN_INHERENT` 告诉人"要人看"，但**看什么**只能从判据原文来。
export function humanizeCoverage(status, { facetId = '', criterion = '' } = {}) {
  const key = _s(status).toUpperCase()
  const base = COVERAGE[key]
  if (!base) return { label: _s(status) || '状态未填', plain: '这条的状态没填或不是合法值', action: '退回迷糊补状态', tone: 'bad', who: 'qa', known: false }
  const what = _s(criterion)
  let action = base.action
  if ((key === 'HUMAN_INHERENT' || key === 'SOURCE_ATTESTED') && what) {
    // 判据原文常写成「给定→操作→可观测结果」或「场景 → 断言」，直接摊给人看比任何转述都准
    action = `${base.action}：**${what}**`
  }
  return { ...base, action, facetId: _s(facetId), known: true }
}

// 一句话版（表格单元格用）：`要人亲眼看 · <看什么>`
export function coverageCell(status, opts = {}) {
  const h = humanizeCoverage(status, opts)
  const what = _s(opts.criterion)
  return what ? `${h.label} · ${what}` : h.label
}

// 把「一格里堆 8 个 REQ-xxxx-Fn(HUMAN_INHERENT)」摊成人能读的分组清单。
// 输入 rows: [{facetId, status, criterion}]；输出按「谁来做」分组，每组一句总结 + 逐条要做什么。
// 事故形态（2026-09-09 实况）：晨检包某一格是
//   `REQ-0341-F29(HUMAN_INHERENT)、REQ-0341-F30(HUMAN_INHERENT)、…` × 8
// ——它同时犯了三个错：术语没翻、没说看什么、把 8 条压成一格让人无从下手。
export function humanizeFacetGroup(rows = []) {
  const groups = new Map()
  for (const r of rows) {
    const h = humanizeCoverage(r.status, r)
    const k = `${h.who}|${h.label}`
    if (!groups.has(k)) groups.set(k, { who: h.who, label: h.label, tone: h.tone, plain: h.plain, items: [] })
    groups.get(k).items.push({ facetId: _s(r.facetId), what: _s(r.criterion), action: h.action })
  }
  return [...groups.values()].sort((a, b) => (a.who === 'you' ? -1 : b.who === 'you' ? 1 : 0))
}

export function humanizeRedlight(key, count = 0) {
  const k = _s(key)
  const b = REDLIGHT[k] || { label: k, plain: '' }
  return { key: k, label: b.label, plain: b.plain, count: Number(count) || 0, ok: !Number(count) }
}

export function humanizeVersionState(state) {
  const k = _s(state).toLowerCase()
  return VERSION_STATE[k] || (k ? `状态「${k}」（引擎内部态，没有对应人话——该补进 humanize.js）` : '状态未定')
}

export function humanizeGate(key, value) {
  const k = _s(key)
  const g = GATES[k] || { label: k, unmet: '' }
  const passed = value === true || value === 'true'
  return { key: k, label: g.label, passed, why: passed ? '' : (g.unmet || '还没过') }
}

// 一版的门禁 → 「还差哪几道」的人话清单（只列没过的；全过则空数组）
export function unmetGates(gates = {}) {
  return Object.entries(gates || {})
    .map(([k, v]) => humanizeGate(k, v))
    .filter(g => !g.passed && GATES[g.key])       // 未登记的 key 不猜（避免把无关字段当门禁报出来）
}

export const KNOWN_TERMS = {
  coverage: Object.keys(COVERAGE),
  redlight: Object.keys(REDLIGHT),
  versionState: Object.keys(VERSION_STATE),
  gates: Object.keys(GATES),
}

// 兜底自检：给定一段将要展示给人的文本，挑出里面**没翻译的机器术语**。
// 用途：晨检包/简报装配完最后自查一遍——**新增枚举时最容易忘了同步翻译层**，让机器自己报出来，
// 而不是等老板下次说"这什么玩意"。
//
// ⚠ 正则不做成模块级共享实例：`matchAll` 与 `replace` 都要 /g，共享一个带 lastIndex 的对象
//   是经典的隐蔽状态 bug（两处交替调用时会从上次的位置接着找）。每次现造，代价可忽略。
const LEAK_TERMS = [...KNOWN_TERMS.coverage, ...KNOWN_TERMS.redlight]
const leakRe = () => new RegExp('\\b(' + LEAK_TERMS.join('|') + ')\\b', 'g')
export function findTermLeaks(text) {
  const hits = [...String(text || '').matchAll(leakRe())].map(m => m[1])
  return [...new Set(hits)]
}

// 自由文本里的术语就地换成人话短名。
//
// 缘起（2026-09-09，跑全仓测试时 `task-brief` 的真实档案用例变红：简报里印着
// 「本session签F51/F73(累计 COVERED_GREEN 27)」）。根因**不是**员工写错——迷糊在任务档案的时间线里
// 写机器术语是完全正常的，那是给引擎和 QA 自己看的台账；根因是**简报把档案原文透传给了老板**，
// 绕过了本模块这唯一的翻译层。`findTermLeaks` 存在的意义正是拦这个，但此前只有"报警"没有"修"。
//
// 为什么翻译要放在**渲染的唯一收口处**、而不是逐个字段翻：字段会长出新的（delta/里程碑/待拍/
// 口径修订…），逐个翻就是把同一个谓词实现 N 遍，迟早有一处漏——那正是 §3.128 的教训。
// 收口翻一次的不变量很硬：**`findTermLeaks(humanizeTerms(x))` 恒为空**（有单测锁住）。
//
// 用 label（短名）而不是 plain（整句）：这是在句子中间做替换，塞一整句解释会把原文冲烂。
const TERM_LABELS = {
  ...Object.fromEntries(Object.entries(COVERAGE).map(([k, v]) => [k, v.label])),
  ...Object.fromEntries(Object.entries(REDLIGHT).map(([k, v]) => [k, v.label])),
}
export function humanizeTerms(text) {
  if (text == null) return ''
  return String(text).replace(leakRe(), m => TERM_LABELS[m] ?? m)
}
