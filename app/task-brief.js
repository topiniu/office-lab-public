// ============================================================================
// 任务档案简报（给人看的那 4%）
//
// 缘起（2026-09-09，老板：「lab 的任务档案查看观感很差」）。实测大货备货 v0.1.0 档案 **137,139 字节**：
//   · 时间线   77,568 字节（56.6%，99 条、平均 783 字/条 —— agent 叙述）
//   · 覆盖矩阵 41,525 字节（30.3%，106 行 —— 机器台账）
//   · 人真正要看的（目标/背景/登记表/流程状态/待确认）合计 **5,001 字节 = 3.6%**
// 而查看器是 `<Markdown>` 一坨平铺（file-viewer.tsx:212）——**要滚过 77KB 的 agent 叙述才能找到
// "今天等我拍什么"**。档案是「给引擎和 agent 记账」的，不是「给人做决定」的。
//
// 本模块把那 3.6% 抽出来，按**人打开档案的四个时刻**组织（每个时刻问的是完全不同的问题）：
//   ① 早上第一眼 → `delta`：自我上次看之后**变了什么**（不是全量状态）
//   ② 要拍板时   → `decisions`：等我一句话的事，每条带**不拍的代价**
//   ③ 要验收时   → `acceptance`：能验收的 / 要我亲眼看的（术语已翻成"看什么"，见 humanize.js）
//   ④ 回头复盘时 → `milestones`：时间线压成里程碑，细节留在原档案里
// 台账（覆盖矩阵/时间线全文）不进简报——它们是**审计底料**，价值是"出事能查"，不是"每天给人看"。
//
// 纯函数 + 只吃文本，可单测。
// ============================================================================
import { humanizeCoverage, humanizeFacetGroup, humanizeVersionState, unmetGates, humanizeTerms } from './humanize.js'

const _rc = line => { const c = line.split('|').map(x => x.trim()); c.shift(); if (c[c.length - 1] === '') c.pop(); return c }
const _isSep = line => /^[-:\s]+$/.test(line.replace(/\|/g, ''))
const _s = v => String(v == null ? '' : v).replace(/\*\*/g, '').trim()
const _blank = s => { const t = _s(s); return !t || /^[-—–]+$/.test(t) }
const _placeholder = s => /<[^>]*>/.test(String(s || ''))

// 「已拍板/已定」的说法很多（菲菲手写），这里只判**明确表示已经定了**的；其余一律算"还开着"。
// 宁可多报一条待拍，也不要把还开着的问题算成已定（后者会让问题静默消失——正是 §3.122 那类病）。
const CLOSED_MARK = /(已定|已拍|已确认|已回答|已收敛|已解决|closed|✅)/
export const isDecisionClosed = status => CLOSED_MARK.test(_s(status))

// ---------------------------------------------------------------------------
// ② 等你拍板：扫全档案里所有「待确认/待老板拍」类表
// ---------------------------------------------------------------------------
// 为什么要扫全档案而不只看「## 待确认事项」：实况里菲菲把本轮新发现的 13 条口径写在
// `### 待老板拍（本轮新发现·13 条口径未定 A-M）` 小节里（另一张表），而晨检包只读 park 台账，
// 于是**今天真正等老板拍的 15 条一条都没报**、报出来的 12 条里 9 条是别的模块的历史 park。
// 判据：表头含「事项」（或「卡在哪」）+ 含「拟定/口径/默认」→ 就是一张待拍表，不管它在哪个小节。
export function extractDecisions(text) {
  const out = []
  const lines = String(text || '').split('\n')
  let header = null, section = '', tableIdx = 0
  for (const raw of lines) {
    const line = raw.trim()
    const h = line.match(/^#{2,4}\s*(.+?)\s*$/)
    if (h) { section = _s(h[1]); header = null; continue }
    if (!line.startsWith('|')) { header = null; continue }
    const cells = _rc(line)
    if (!header) {
      const flat = cells.map(_s)
      const hasTopic = flat.some(c => /事项|卡在哪|问题|口径未定/.test(c))
      const hasProposal = flat.some(c => /拟定|口径|默认|建议/.test(c))
      if (hasTopic && hasProposal) { header = flat; tableIdx++ }
      continue
    }
    if (_isSep(line)) continue
    const idxOf = (...names) => {
      for (const n of names) { const i = header.findIndex(x => new RegExp(n).test(x)); if (i >= 0) return i }
      return -1
    }
    const at = i => (i >= 0 ? _s(cells[i]) : '')
    const col = (...names) => at(idxOf(...names))
    const topic = col('事项', '卡在哪', '问题')
    if (_blank(topic) || _placeholder(topic)) continue
    const id = col('^#$', '^#', '编号', '条目') || ''
    const status = col('状态')
    // ⚠ 代价列要排除「拟定口径」那一列再找。实况的表头是「拟定口径（**不拍**时的默认）」——
    // 松散的 `不拍` 别名会命中它，于是"不拍的代价"被填成了拟定口径本身（同一句话印两遍，
    // 而真正缺代价的行反而显示成"已写"）。这类**同前缀列名撞车**在 extractEntries 那边也踩过一次。
    const iProposal = idxOf('拟定', '默认', '建议', '口径')
    let iCost = idxOf('不拍的代价', '^代价', '不拍会', '后果', '^影响')
    if (iCost === iProposal) iCost = -1
    out.push({
      id: _s(id) || `T${tableIdx}-${out.length + 1}`,
      section,                                              // 出自哪一节（人要知道这条是谁提的/哪一轮的）
      scope: col('页', '模块', '范围'),
      topic,
      proposal: at(iProposal),
      cost: at(iCost),                                      // ★ 菲菲必填，引擎校空（见 costMissing）
      status,
      closed: isDecisionClosed(status),
    })
  }
  return out
}

// 「不拍的代价」缺失清单（引擎校空 —— 老板 2026-09-09 定：这条信息菲菲必填、引擎校空）。
// 为什么必须有：「拟定口径：选填、可就地改」这种条目，人看不出它重不重要。人做决定靠的是**后果**，
// 不是选项。缺了代价，老板只能逐条追问"这条不拍会怎样"，那就等于没交付。
export function costMissing(decisions = []) {
  return decisions.filter(d => !d.closed && (_blank(d.cost) || _placeholder(d.cost)))
}

// ---------------------------------------------------------------------------
// ③ 等你验收：条目 × 覆盖矩阵 → 「能验收的」/「要你亲眼看的」
// ---------------------------------------------------------------------------
const ACCEPT_STATUS = /(待人工验收|待预检|待复验|待人工)/
export function buildAcceptance({ entries = [], matrix = [], facets = [] } = {}) {
  const criterionOf = new Map(facets.map(f => [String(f.id || '').toUpperCase(), _s(f.criterion)]))
  const byReq = new Map()
  for (const r of matrix) {
    const req = (String(r.facetId || '').match(/REQ-\d+/i) || [''])[0].toUpperCase()
    if (!req) continue
    if (!byReq.has(req)) byReq.set(req, [])
    byReq.get(req).push({ facetId: r.facetId, status: r.status, criterion: criterionOf.get(String(r.facetId).toUpperCase()) || '' })
  }
  const out = []
  for (const e of entries) {
    const req = _s(e.no).toUpperCase()
    const rows = byReq.get(req) || []
    const groups = humanizeFacetGroup(rows)
    const needYou = groups.filter(g => g.who === 'you').flatMap(g => g.items)
    const risky = groups.filter(g => g.tone === 'risk' || g.tone === 'bad').flatMap(g => g.items)
    const green = rows.filter(r => String(r.status).toUpperCase() === 'COVERED_GREEN').length
    out.push({
      no: e.no, name: e.name, status: e.status,
      acceptable: ACCEPT_STATUS.test(_s(e.status)),
      total: rows.length, green,
      needYou,                       // 要你亲眼看的（已带"看什么"）
      risky,                         // 只读了代码 / 没测 —— 放行前值得知道
      groups,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// ① 早上第一眼：delta（自 since 之后变了什么）
// ---------------------------------------------------------------------------
// 时间线条目形如 `- 2026-09-09 xxx`（日期粒度到天，足够回答"我睡了一觉之后发生了什么"）。
// 刻意**只取日期而不解析内容**：内容是 agent 叙述（平均 783 字/条），简报只给首句 + 指回原档案。
export function extractTimeline(text) {
  const m = String(text || '').match(/\n##\s*时间线[^\n]*\n([\s\S]*?)(?=\n##\s|$)/)
  if (!m) return []
  const out = []
  for (const raw of m[1].split('\n')) {
    const line = raw.trim()
    const mm = line.match(/^[-*]\s*(\d{4}-\d{2}-\d{2})\s*(.*)$/)
    if (!mm) continue
    const body = _s(mm[2])
    out.push({ date: mm[1], head: body.split(/[。；;]\s*/)[0].slice(0, 120), len: body.length })
  }
  return out
}

// 里程碑：从时间线里挑「人回头复盘会关心的那几类」——拍板 / 返工 / 交付 / 冻结 / 打回。
// 不做语义理解，只按关键词标签化；标不出来的归 '进展'，且**不进里程碑视图**（那是 99 条噪音的来源）。
const MILESTONE_RULES = [
  [/打回|返工|重做|推翻/, '返工'],
  [/拍板|定[了下]|老板.*(定|拍)|拍A|拍B/, '拍板'],
  [/冻结|freeze|封板/, '冻结'],
  [/上线|发布完成|released|已发/, '交付'],
  [/QA ?(通过|完成)|全绿|RC_READY/, '过检'],
  [/创建任务|开档/, '开档'],
]
export function buildMilestones(timeline = []) {
  const out = []
  for (const t of timeline) {
    const hit = MILESTONE_RULES.find(([re]) => re.test(t.head))
    if (hit) out.push({ date: t.date, kind: hit[1], head: t.head })
  }
  return out
}

export function buildDelta({ timeline = [], since = '' } = {}) {
  const s = _s(since)
  const fresh = s ? timeline.filter(t => t.date > s) : timeline.slice(-5)
  return {
    since: s, count: fresh.length,
    days: [...new Set(fresh.map(t => t.date))].sort(),
    items: fresh.slice(-12),        // 上限：delta 是"扫一眼"，不是第二份时间线
    truncated: Math.max(0, fresh.length - 12),
  }
}

// ---------------------------------------------------------------------------
// 汇总：一份档案 → 一份简报
// ---------------------------------------------------------------------------
export function buildBrief({
  text = '', fm = {}, entries = [], matrix = [], facets = [], since = '', trace = null, tree = null, quality = null,
} = {}) {
  const decisions = extractDecisions(text).filter(d => !d.closed)
  const timeline = extractTimeline(text)
  const acceptance = buildAcceptance({ entries, matrix, facets })
  const blocked = entries.filter(e => /(阻塞|打回|已隔离)/.test(_s(e.status)))
  const waitingYou = entries.filter(e => ACCEPT_STATUS.test(_s(e.status)))
  return {
    version: _s(fm.version), task: _s(fm.task), owner: _s(fm.owner),
    stateText: humanizeVersionState(fm.status || ''),
    updated: _s(fm.updated),
    // ① 变化
    delta: buildDelta({ timeline, since }),
    // ② 决定
    decisions, costMissing: costMissing(decisions),
    // ③ 验收
    acceptance, waitingYouCount: waitingYou.length,
    needYouEyes: acceptance.flatMap(a => a.needYou),
    riskyEvidence: acceptance.flatMap(a => a.risky),
    // 按「哪种不硬」归组（只读了代码 / 测不了有凭据 / 没测）——渲染时同类只解释一遍风险
    riskyGroups: (() => {
      const m = new Map()
      for (const g of acceptance.flatMap(a => a.groups)) {
        if (g.tone !== 'risk' && g.tone !== 'bad') continue
        if (!m.has(g.label)) m.set(g.label, { label: g.label, plain: g.plain, items: [] })
        m.get(g.label).items.push(...g.items)
      }
      return [...m.values()]
    })(),
    // 卡住
    blocked: blocked.map(e => ({ no: e.no, name: e.name, status: _s(e.status), stage: _s(e.stage).slice(0, 160) })),
    // 门禁（只列没过的，且带"没过意味着什么"）
    unmet: unmetGates(fm.gates || {}),
    // ④ 复盘
    milestones: buildMilestones(timeline),
    // 台账只给汇总数（明细点开原档案）
    ledger: {
      facets: facets.length, matrixRows: matrix.length, timelineRows: timeline.length,
      timelineBytes: timeline.reduce((n, t) => n + t.len, 0),
      units: trace?.unitTotal ?? null, leaves: tree?.stats?.leaves ?? null,
      candidates: quality?.stats?.candidates ?? null, answered: quality?.stats?.answered ?? null,
      driftText: quality?.drift?.text || '',
    },
  }
}

// md 渲染（晨检包/交接卡复用；前端走 JSON 不走这个）
export function renderBrief(b) {
  if (!b) return ''
  const L = []
  L.push(`## 现在等你三件事`, '')
  L.push(`| | 数量 | 一句话 |`, `|---|---|---|`)
  L.push(`| ⭐ 等你拍板 | **${b.decisions.length}** | ${b.decisions.length ? '一句话就能推动，见下方逐条' : '没有'} |`)
  L.push(`| 👀 等你验收 | **${b.waitingYouCount}** | ${b.needYouEyes.length ? `其中 ${b.needYouEyes.length} 处机器测不了、要你亲眼看` : '机器能给的证据都齐了'} |`)
  L.push(`| ⛔ 卡住 | **${b.blocked.length}** | ${b.blocked.length ? b.blocked.map(x => x.no).join('、') : '没有'} |`)
  if (b.delta.count) {
    L.push('', `### 你上次看之后（${b.delta.since || '最近'}）变了什么`, '')
    for (const d of b.delta.items) L.push(`- \`${d.date}\` ${d.head}`)
    if (b.delta.truncated) L.push(`- …另有 ${b.delta.truncated} 条（细节在档案「## 时间线」）`)
  }
  if (b.decisions.length) {
    L.push('', `### ⭐ 等你拍板（${b.decisions.length}）`, '')
    L.push('| # | 哪块 | 问题 | 不拍就按这个执行 | **不拍的代价** |', '|---|------|------|----------------|--------------|')
    for (const d of b.decisions) L.push(`| ${d.id} | ${d.scope || d.section || '—'} | ${d.topic} | ${d.proposal || '⚠ 没给拟定口径'} | ${d.cost || '⚠ **没写代价**（菲菲必填）'} |`)
  }
  if (b.needYouEyes.length) {
    L.push('', `### 👀 机器测不了、要你亲眼看（${b.needYouEyes.length}）`, '')
    for (const i of b.needYouEyes) L.push(`- **${i.facetId}**：${i.what || i.action}`)
  }
  if (b.riskyEvidence.length) {
    L.push('', `### ⚠ 证据不硬的（${b.riskyEvidence.length}）——放行前值得知道`, '')
    // 按「哪种不硬」分组：同一类只解释一遍风险，底下逐条只给判据。
    // 平铺的话每条都要重复一遍"代码看着对、跑起来不一定对"，读三条就开始跳过——那就等于没写。
    for (const g of b.riskyGroups) {
      L.push(`**${g.label}**（${g.plain}）`)
      for (const i of g.items.slice(0, 10)) L.push(`- ${i.facetId}${i.what ? '：' + i.what : ''}`)
      if (g.items.length > 10) L.push(`- …另有 ${g.items.length - 10} 条`)
      L.push('')
    }
  }
  if (b.unmet.length) {
    L.push('', `### 还差哪几道门`, '')
    for (const g of b.unmet) L.push(`- **${g.label}**：${g.why}`)
  }
  L.push('', `> 台账（不用每天看）：facet ${b.ledger.facets} 条 / 覆盖矩阵 ${b.ledger.matrixRows} 行 / 时间线 ${b.ledger.timelineRows} 条（${Math.round(b.ledger.timelineBytes / 1024)}KB）${b.ledger.driftText ? ' ｜ ' + b.ledger.driftText : ''}`)
  // ★ 术语翻译放在**唯一收口**：简报里大量内容是档案原文透传（delta / 里程碑 / 待拍事项 / 口径修订），
  //   而员工在任务档案时间线里写 `COVERED_GREEN`、`fake_green` 这类机器术语是完全正常的——那是给
  //   引擎和 QA 看的台账。**绕过翻译层把它端给老板才是 bug**（2026-09-09 全仓测试抓到：简报里印着
  //   「本session签F51/F73(累计 COVERED_GREEN 27)」，`findTermLeaks` 报警了但此前没人去修）。
  //   为什么不逐个字段翻：字段还会长出新的，逐个翻＝同一谓词实现 N 遍、迟早漏一处（§3.128 的教训）。
  //   收口翻一次的不变量很硬：`findTermLeaks(renderBrief(...)) === []`，且**对以后新写进档案的
  //   术语同样成立**——这也让那条读真实档案的用例不再随业务内容变红（§3.131）。
  return humanizeTerms(L.join('\n'))
}
