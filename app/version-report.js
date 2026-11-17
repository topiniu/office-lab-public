// ============================================================================
// 版本验收单（晨检包 v2）—— 一版一份、每天覆盖写
//
// 缘起（2026-08-28 老板原话）：「感觉晨检包的概念很混乱」「5.20 我多次守航追加条目，晨检包只展示了
// 一开始的 2 条需求，而且下面的进度跟真实的任务进度不一样」。查下来是**概念单位错位**：
//   · 包按守航轮次（run_name）出，而一个业务版本跨多轮 —— v5.20 = 4 轮 = 4 份包，每份只讲自己
//     那夜领的 2 条，没有一份回答「v5.20 现在到哪了」；
//   · 条目从「契约 named_items + 覆盖矩阵」倒推，**一次没读过任务档案的「## 需求条目登记表」**
//     ——而那才是任务进度的唯一状态源（README 设计原则）。于是登记表里明明写着「已上线」的条目，
//     包里还印着「park 待拍」；
//   · 而模板第五章写的是「**整版**通过 / 部分通过 / **整版**打回」——版本级的决策语言，垫在轮次级
//     的数据上。概念从模板那一层就分叉了。
//
// 本模块把单位改回**版本**：行集以登记表为准，覆盖矩阵/台账/门禁只补列，轮次降为「本轮增量 + 审计」
// 两节。轮次级的 `morning-report.js` 保留不动 —— deadline 结算算「本轮领了没做完的该顺延谁」时，
// 需要的仍是轮次语义（换成版本级会把整版未完条目全顺延，把病治反）。
//
// 纯函数：只吃已经算好的结论（entries / rows / rounds / park），自己不读盘、不判定放行。
// ============================================================================

import { classifyEntryStatus, entryResultOf, VER_CLOSED_STATUS, SHIPPED_STATUS } from './entry-status.js'
import { classifyParkKind, PARK_KIND } from './requirement-pool.js'
import { humanizeVersionState, humanizeCoverage, findTermLeaks } from './humanize.js'   // 术语→人话（唯一翻译层，见 §3.125）

const upper = s => String(s || '').toUpperCase().trim().replace(/^REQ-(\d{1,3})\b/, (_, d) => 'REQ-' + d.padStart(4, '0'))
const clean = s => String(s || '').replace(/\*\*/g, '').trim()
const ts = s => Date.parse(String(s || '').replace(' ', 'T')) || 0
const num = v => (v === null || v === undefined || v === '') ? '—' : String(v)
const cell = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ')
// 证据签发时刻：引擎侧 `20260826010203-1ead52` 与猪猪侧 `session-20260827-182259-…` 两种形态都要认
const runIdTs = id => {
  const m = String(id || '').match(/(\d{4})(\d{2})(\d{2})[-_ ]?(\d{2})(\d{2})(\d{2})/)
  // Lab writes its compact run ID from toISOString(). External E2E IDs encode local time.
  const zone = /^\d{14}-[a-f0-9]{6}$/i.test(String(id || '')) ? 'Z' : ''
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`) || 0 : 0
}
const reqOf = (...cands) => {
  for (const c of cands) { const m = String(c || '').match(/REQ-\d+/i); if (m) return upper(m[0]) }
  return ''
}

// 落点命名。遵 `文档格式规范.md` §2.2 的 `<日期>-<版本>-<类型>.md`；**全仓唯一拼名点**。
// 旧形态 `<日期>-晨检包-<run_name>.md` 带两个日期、还按轮次分裂，已停产。
export function versionReportName(version, date) {
  const v = String(version || '').trim() || '未定版'
  return `${String(date || '').trim()}-${v}-晨检包.md`
}

// 一份契约属不属于这个版本。**主键是版本号**：实测 7 份契约的 `archive` 有 4 种写法
// （带引号 / 不带 / `office-lab/tasks/…` / 裸 `tasks/…`），按字符串比会漏掉一整轮。
export function matchesVersion(fm = {}, { version, archiveBasename } = {}) {
  const norm = v => String(v || '').trim().toLowerCase().replace(/^['"]|['"]$/g, '').replace(/^v/, '').replace(/\s+/g, '')
  const want = norm(version)
  const has = norm(fm.version)
  if (want && has) return has === want          // 契约写了版本号就以它为准，**不再退到档案名**
  if (want && has === want) return true
  if (!archiveBasename) return false
  const base = s => String(s || '').replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').split('/').pop()
  return !!base(fm.archive) && base(fm.archive) === base(archiveBasename)
}

// 版本状态：只认 `fm.gates` 布尔位 + 条目终态，**绝不回读 `fm.status`**
// （实证 v5.16 字面停在 QA_PASSED，而 gates.released_test 早已 true——status 会滞后且不自洽）。
export const VERSION_STATES = ['drafting', 'in_dev', 'in_qa', 'rc_ready', 'released_test', 'released_prod']
export function deriveVersionState(fm = {}, entries = []) {
  const g = fm.gates || {}
  if (g.released_prod === true) return 'released_prod'
  if (g.released_test === true) return 'released_test'
  const rows = entries || []
  if (rows.length && rows.every(e => SHIPPED_STATUS.has(clean(e.status)))) return 'released_prod'
  // ⚠ `待人工验收` **必须算进 rc_ready**（2026-09-19 实账）：它不在 `VER_CLOSED_STATUS` 里
  //   （那张表是「过检」口径，待人工验收还没过检），但它正是**守航契约的终点词**
  //   （`exit.final_state: awaiting_human_acceptance`）。漏了它，一个两条条目全部停在验收门的
  //   守航版本会一路落到 `drafting`——晨检包第一行于是印「v5.24（**还在梳理需求**）」，
  //   而同一张表下面写着「待你验收 2/2、卡住 0」。老板一眼看到的第一句话跟事实正好相反。
  //   判据改用 `classifyEntryStatus` 的 `accepted` 档（它已正确收编「待人工验收」+ VER_CLOSED 四态），
  //   不再各维护一份状态名单——同一套词汇有两张表，就是这次漏掉的成因。
  if (rows.length && rows.every(e => classifyEntryStatus(e.status).bucket === 'accepted')) return 'rc_ready'
  if (rows.some(e => classifyEntryStatus(e.status).bucket === 'qa')) return 'in_qa'
  if (rows.some(e => ['dev', 'blocked'].includes(classifyEntryStatus(e.status).bucket))) return 'in_dev'
  return 'drafting'
}

// ---------- 版本条目全表 ----------
// **行集 = 登记表**（唯一状态源）。覆盖矩阵/台账/门禁只补列；矩阵里有而登记表没有的 REQ
// 单独进 orphanReqs，绝不混进主表——否则「这一版到底有几条」这个最基本的问题又会有两个答案。
export function deriveVersionItems({ entries = [], rows = [], rounds = [], park = [] } = {}) {
  const byReqRows = new Map()
  for (const r of rows) { const k = upper(r.req); if (!k) continue; if (!byReqRows.has(k)) byReqRows.set(k, []); byReqRows.get(k).push(r) }
  const parkByReq = new Map((park || []).map(e => [upper(e.req), e]))
  const gateByReq = new Map()
  const itemAcctByReq = new Map()
  for (const rd of rounds) {
    for (const [req, d] of Object.entries(rd?.ledger?.gateDecisions || {})) gateByReq.set(upper(req), d)
    for (const [req, v] of Object.entries(rd?.ledger?.itemResults || {})) itemAcctByReq.set(upper(req), v)
  }

  const items = []
  const seen = new Set()
  for (const e of entries) {
    const req = reqOf(e.no, e.name)
    if (!req || seen.has(req)) continue
    seen.add(req)
    const rs = byReqRows.get(req) || []
    const greens = rs.filter(r => String(r.status).toUpperCase() === 'COVERED_GREEN')
    const manual = rs.filter(r => ['HUMAN_INHERENT', 'SOURCE_ATTESTED', 'BLOCKED_WITH_PROOF'].includes(String(r.status).toUpperCase()))
    const p = parkByReq.get(req)
    const boardStatus = clean(e.status)
    const cls = classifyEntryStatus(boardStatus)
    items.push({
      req,
      name: clean(e.name),
      enteredAt: clean(e.enteredAt),
      source: clean(e.source),
      stage: clean(e.stage),
      boardStatus,
      bucket: cls.bucket,
      bucketLabel: cls.label,
      result: entryResultOf(boardStatus),
      green: rs.length ? greens.length : null,
      facetTotal: rs.length || null,
      redCalibrated: greens.length ? greens.every(g => g.redOk === true) : null,
      commit: greens.map(g => g.green?.commit).filter(Boolean)[0] || '',
      // 旧写法是 `REQ-0341-F29(HUMAN_INHERENT)、REQ-0341-F30(HUMAN_INHERENT)…` 一格堆 8 个
      // ——术语没翻、没说看什么、8 条压一格让人无从下手（老板 2026-09-09 点名的"抽象用语"）。
      // 改成按类计数的一句人话；逐条明细去第三章「👀 要你亲眼看」那节（带"看什么"）。
      humanInherent: (() => {
        const byLabel = new Map()
        for (const r of manual) {
          const label = humanizeCoverage(r.status).label
          byLabel.set(label, (byLabel.get(label) || 0) + 1)
        }
        return [...byLabel].map(([label, n]) => `${n} 条${label}`).join('、')
      })(),
      riskClass: gateByReq.get(req)?.riskClass || '',
      // park 只在**未关闭**时才算「还挂着」；关闭/降级的分别由 park 台账章节交代
      parkOpen: p && !p.closedAt ? { kind: classifyParkKind(p), rounds: Number(p.rounds || 0), reason: p.reason || '', proposal: p.proposal || '', demotedStatus: p.demotedStatus || '' } : null,
      touchedBy: (itemAcctByReq.has(req) ? ['台账'] : []).concat(gateByReq.has(req) ? ['门禁定级'] : []),
      noFacets: rs.length === 0,
    })
  }
  // 矩阵里有、登记表里没有 —— 要么漏登记，要么是别版的 facet 混进了这份档案，两种都得说出来
  const orphanReqs = [...byReqRows.keys()].filter(r => !seen.has(r)).map(r => ({
    req: r,
    facetTotal: byReqRows.get(r).length,
    green: byReqRows.get(r).filter(x => String(x.status).toUpperCase() === 'COVERED_GREEN').length,
  }))
  return { items, orphanReqs }
}

// ---------- 本轮增量 ----------
// 四源分档、**逐条标出处**，并印差集。刻意不用「登记表『来源』列文本含 run_name」：
// 实测 3 条追加行里只有 1 条写了轮次名，且同日双轮（08-27 的 guarded-01/02）用文本根本消歧不了。
export function deriveRoundDelta({ round, entries = [], rows = [], park = [] } = {}) {
  if (!round) return { planned: [], touched: [], entered: [], plannedNotTouched: [] }
  const named = round.contract?.selection?.named_items
  const planned = (Array.isArray(named) ? named : String(named || '').split(/[,，\s]+/)).map(upper).filter(r => /^REQ-\d+/.test(r))
  const from = ts(round.startsAt || round.contract?.starts_at)
  const to = ts(round.endsAt || round.contract?.deadline)
  const inWindow = t => t && (!from || t >= from) && (!to || t <= to)

  const touched = new Map()
  const mark = (req, via) => { const k = upper(req); if (!/^REQ-\d+/.test(k)) return; if (!touched.has(k)) touched.set(k, new Set()); touched.get(k).add(via) }
  for (const req of Object.keys(round.ledger?.itemResults || {})) mark(req, '台账')
  for (const req of Object.keys(round.ledger?.gateDecisions || {})) mark(req, '门禁定级')
  // 证据落在本轮窗口内 —— **历史轮次唯一还成立的硬证据**（itemResults 的写侧 2026-08-28 才落地，
  // 已发生的四轮全是空的；只信台账会让「本轮增量」在上线第一天就是空的）。
  for (const r of rows) {
    if (String(r.status).toUpperCase() !== 'COVERED_GREEN') continue
    if (inWindow(runIdTs(r.green?.runId))) mark(r.req, '证据runId')
  }
  // 「进入日期」只精确到**天**，拿它去比 `starts_at` 那种带时分秒的窗口一定落空
  // （guarded-01 09:55 开跑，而 2026-08-27 解析出来是当天 00:00）。所以按日历天比，跨天的轮次取闭区间。
  const day = t => (t ? new Date(t).toISOString().slice(0, 10) : '')
  const dFrom = day(from), dTo = day(to)
  const entered = entries
    .filter(e => { const d = clean(e.enteredAt).slice(0, 10); return d && (!dFrom || d >= dFrom) && (!dTo || d <= dTo) })
    .map(e => reqOf(e.no, e.name))
    .filter(Boolean)
  // 同日双轮：进入日期只精确到天，用契约点名消歧——没点名的不算这一轮带进来的
  const enteredOwned = planned.length ? entered.filter(r => planned.includes(r)) : entered
  for (const r of enteredOwned) mark(r, '进入登记表')
  return {
    planned,
    touched: [...touched.entries()].map(([req, via]) => ({ req, via: [...via] })).sort((a, b) => a.req.localeCompare(b.req)),
    entered: enteredOwned,
    plannedNotTouched: planned.filter(r => !touched.has(r)),
  }
}

// ---------- 缺料自检 ----------
export function versionGaps(input = {}) {
  const g = []
  if (!input.version) g.push('**版本未绑定**：契约 frontmatter 的 `archive`/`version` 没回填 → 条目全表 / 覆盖 / 门禁 / 历史轮次全部取不到')
  if (!input.archiveRel) g.push('任务档案未绑定 → 登记表读不到，本包退回轮次级口径')
  if (!(input.entries || []).length) g.push('**登记表为空**（唯一状态源缺失）——「这一版有几条」这个问题引擎答不了')
  if (!(input.rows || []).length) g.push('覆盖矩阵为空（facet_doc 缺失或未播种）→ 绿/总、RED 校准、证据 commit 全列不可用')
  if (!(input.rounds || []).length) g.push('本版没有任何守航契约（不是守航产出，或契约未回填 version）')
  if ((input.orphanReqs || []).length) g.push(`覆盖矩阵里有 ${input.orphanReqs.length} 条 REQ **不在登记表**（${input.orphanReqs.map(o => o.req).join('、')}）——要么漏登记，要么别版 facet 混了进来`)
  if (!input.releaseChain) g.push('发布链对账缺失（E4/D1 未跑）')
  if (!input.rollback) g.push('回退方案缺失（D4）')
  if (!input.qaReportCard) g.push('QA 报告卡片缺失（C4/C5）')
  return g
}

// ---------- 各章渲染 ----------
const BUCKET_ORDER = ['blocked', 'intake', 'dev', 'qa', 'accepted', 'parked', 'shipped']
// ★ park 的版本作用域（2026-09-09 事故对策）。park 台账是**全局**的（跨版本跨模块累积），
// 而这是一份**版本级**单子：不筛就会把别的模块挂着的历史 park 全灌进来。
// 实况：v0.1.0 的单子报「待你拍板 12 条」，其中 **9 条是示例项目 v5.x 的需求储备**
// （REQ-0304/0219/0225/0319/0322/0295/0266/0242/0323）——命中率 3/12。
// `deriveVersionItems` 早就按 REQ 做过 join（只认本版条目），但 summary/stuck/decision 三处
// 各自又拿了原始 park 列表。修法：统一从 items 派生作用域，三处共用。
export function scopeParkToVersion(park = [], items = []) {
  const inVersion = new Set((items || []).map(i => upper(i.req)).filter(Boolean))
  if (!inVersion.size) return []          // 登记表为空时**一条都不报**（宁可空，也不报别版的）
  return (park || []).filter(e => inVersion.has(upper(e.req)))
}
const openAmbiguity = (park = []) => (park || []).filter(e => !e.closedAt && classifyParkKind(e) === PARK_KIND.AMBIGUITY && !e.demotedStatus)

function summary({ version, versionState, items, rounds, latest, park, decisions = [], costMissing = [] }) {
  const by = b => items.filter(i => i.bucket === b).length
  const redOf = led => ({
    forbidden: (led?.forbidden || []).length,
    over: (led?.overBudget || []).filter(v => v.code === 'over_budget').length,
    fake: led?.fakeGreen?.count || 0,
  })
  const all = rounds.map(r => redOf(r.ledger)).reduce((a, b) => ({ forbidden: a.forbidden + b.forbidden, over: a.over + b.over, fake: a.fake + b.fake }), { forbidden: 0, over: 0, fake: 0 })
  const one = redOf(latest?.ledger)
  const tokens = rounds.reduce((n, r) => n + Number(r.ledger?.usage?.tokens || 0), 0)
  const openPark = openAmbiguity(scopeParkToVersion(park, items))
  const L = ['## 一、一眼摘要（版本级 · 机器汇总）', '', '| 指标 | 值 |', '|------|-----|']
  L.push(`| 版本 | **${version || '未定版'}**（${humanizeVersionState(versionState)}） |`)
  L.push(`| 条目总数 | **${items.length}** 条（来自任务档案「需求条目登记表」，与看板同源） |`)
  L.push(`| 已交付 / 待你验收 | ${by('shipped')} / ${by('accepted')} |`)
  L.push(`| 在测 / 开发中 | ${by('qa')} / ${by('dev')} |`)
  L.push(`| **卡住**（阻塞·打回·隔离） | **${by('blocked')}**${by('blocked') ? ' 🚨' : ' ✅'} |`)
  {
    const total = openPark.length + decisions.length
    const src = []
    if (decisions.length) src.push(`档案待确认 ${decisions.length} 条`)
    if (openPark.length) src.push(`park 台账 ${openPark.length} 条（${openPark.map(e => upper(e.req)).join('、')}）`)
    L.push(`| ⭐ **等你一句话** | ${total ? `**${total}** 条 —— ${src.join(' + ')}` : '0 ✅'} |`)
    if (costMissing.length) L.push(`| └ 其中没写「不拍的代价」 | **${costMissing.length}** 条（${costMissing.map(d => d.id).join('、')}）⚠ 菲菲必填 |`)
  }
  L.push(`| 守航轮次 | ${rounds.length} 轮${rounds.length ? `（${rounds.map(r => r.runName).join(' → ')}）` : ''} |`)
  L.push(`| **越权拦截**（员工碰了契约明令禁止的东西，须 0） | 本版累计 **${all.forbidden}**${all.forbidden ? ' 🚨' : ' ✅'} ｜ 最近一轮 ${one.forbidden} |`)
  L.push(`| **假绿**（把没真测过的报成测过，须 0） | 本版累计 **${all.fake}**${all.fake ? ' 🚨' : ' ✅'} ｜ 最近一轮 ${one.fake} |`)
  L.push(`| **超预算**（这一轮烧的 token 超了契约额度，须 0） | 本版累计 **${all.over}**${all.over ? ' 🚨' : ' ✅'} ｜ 最近一轮 ${one.over} |`)
  L.push(`| 本版 token 累计 | ${tokens ? tokens : '—'} |`)
  L.push('')
  L.push('> **红灯规则**：三项任一 > 0 → 不满足放行门（成熟度晋级需连续三轮全 0）。「本版累计」看整体健康，「最近一轮」看昨夜。')
  return L.join('\n')
}

function itemsTable(items, orphanReqs) {
  const L = ['## 二、版本条目全表（← 需求条目登记表 × 覆盖矩阵 × 门禁）', '']
  if (!items.length) {
    L.push('| — | 登记表里一条都没有 | — | — | — | — |')
    L.push('')
    L.push('> ⚠ **登记表为空**——任务档案是任务进度的唯一状态源，它空着就说明这一版根本没立账，而不是「没有进展」。')
    return L.join('\n')
  }
  L.push('| 条目 | 需求 | 看板状态 | 测试(绿/总) | RED | 证据 commit | 进入 | 需人工/备注 |')
  L.push('|------|------|---------|------------|-----|------------|------|------------|')
  const rank = i => BUCKET_ORDER.indexOf(i.bucket)
  for (const i of [...items].sort((a, b) => rank(a) - rank(b) || a.req.localeCompare(b.req))) {
    const flag = i.bucket === 'blocked' ? ' 🚨' : ''
    const note = [i.humanInherent, i.parkOpen ? `⭐ 待拍：${String(i.parkOpen.reason).slice(0, 40)}…` : '', i.noFacets ? '⚠ 覆盖矩阵里没有它的 facet' : ''].filter(Boolean).join('；')
    L.push(`| ${i.req} | ${cell(i.name).slice(0, 28)} | **${i.boardStatus || '—'}**${flag} | ${num(i.green)}/${num(i.facetTotal)} | ${i.redCalibrated === true ? '✓' : i.redCalibrated === false ? '✗' : '—'} | ${i.commit ? '`' + i.commit.slice(0, 10) + '`' : '—'} | ${i.enteredAt || '—'} | ${cell(note) || '—'} |`)
  }
  L.push('')
  L.push('> 「看板状态」直接取自登记表原文（与看板圆点同源），不再翻译成第二套词汇。')
  if (orphanReqs.length) {
    L.push('')
    L.push(`**⚠ 覆盖矩阵里有 ${orphanReqs.length} 条 REQ 不在登记表**（漏登记？还是别版 facet 混进了这份档案）：${orphanReqs.map(o => `${o.req}(${o.green}/${o.facetTotal})`).join('、')}`)
  }
  return L.join('\n')
}

function stuckSection({ items, park, gateBlocked = [], decisions = [], costMissing = [], needYouEyes = [] }) {
  const L = ['## 三、卡住与待拍（这一节决定你今天要说哪几句话）', '']
  const blocked = items.filter(i => i.bucket === 'blocked')
  if (blocked.length) {
    L.push(`### 🚨 卡住的条目（${blocked.length}）`)
    L.push('')
    for (const i of blocked) L.push(`- **${i.req} ${cell(i.name).slice(0, 30)}** —— 看板状态「${i.boardStatus}」${i.stage ? `；当前阶段：${cell(i.stage).slice(0, 120)}` : '；⚠ 登记表没写卡在哪，这本身要补'}`)
    L.push('')
  }
  // ★ 档案里的待确认事项优先列（2026-09-09 事故对策）：实况里菲菲把本轮新发现的 13 条口径写在
  // 档案的 `### 待老板拍` 小节，而本单只读 park 台账 → **今天真正等老板拍的 15 条一条没报**。
  // 档案是唯一状态源，它里面开着的问题必须进这张单子，而且排在 park 台账之前（那是更旧的账）。
  if (decisions.length) {
    const missing = new Set(costMissing.map(d => d.id))
    L.push(`### ⭐ 等你一句话（${decisions.length}）—— 来自任务档案`)
    L.push('')
    L.push('| # | 哪块 | 问题 | 不拍就按这个执行 | **不拍的代价** |')
    L.push('|---|------|------|----------------|--------------|')
    for (const d of decisions) {
      L.push(`| ${cell(d.id)} | ${cell(d.scope || d.section).slice(0, 20) || '—'} | ${cell(d.topic).slice(0, 110)} | ${cell(d.proposal).slice(0, 110) || '⚠ 没给拟定口径'} | ${missing.has(d.id) ? '⚠ **没写**（菲菲必填）' : cell(d.cost).slice(0, 80)} |`)
    }
    L.push('')
    if (missing.size) L.push(`> ⚠ 上面 ${missing.size} 条没写「不拍的代价」——**人做决定靠的是后果，不是选项**。缺这一栏，你只能逐条追问"这条不拍会怎样"。已记为菲菲的必填缺口。`)
    L.push('')
  }
  const openPark = openAmbiguity(scopeParkToVersion(park, items))
  if (openPark.length) {
    L.push(`### ⭐ 等你一句话的口径问题（${openPark.length}）—— 来自 park 台账（已按本版条目作用域过滤）`)
    L.push('')
    L.push('| 条目 | 卡在哪 | 已 park 轮次 | 拟定口径（你不拍就按这个执行） |')
    L.push('|------|--------|-------------|------------------------------|')
    for (const e of openPark) L.push(`| **${upper(e.req)}** | ${cell(e.probeKey || '—')}：${cell(e.reason).slice(0, 90)} | ${e.rounds || 1}${e.repeatedProposal ? '（口径一字未变——不是想不出，是没人拍）' : ''} | ${cell(e.proposal) || '⚠ 没给拟定口径'} |`)
    L.push('')
  }
  if (gateBlocked.length) {
    L.push('### ⚠ 机器门未过（未验证 ≠ 通过）')
    L.push('')
    for (const b of gateBlocked) L.push(`- ${b}`)
    L.push('')
  }
  if (needYouEyes.length) {
    L.push(`### 👀 机器测不了、要你亲眼看（${needYouEyes.length}）`)
    L.push('')
    // 取代旧的「REQ-0341-F29(HUMAN_INHERENT)、F30(HUMAN_INHERENT)…×8 堆一格」——那种写法
    // 同时犯三个错：术语没翻、没说看什么、把 8 条压成一格让人无从下手。
    for (const i of needYouEyes.slice(0, 20)) L.push(`- **${i.facetId}**：${i.what || i.action}`)
    if (needYouEyes.length > 20) L.push(`- …另有 ${needYouEyes.length - 20} 条（见档案覆盖矩阵）`)
    L.push('')
  }
  if (!blocked.length && !openPark.length && !decisions.length && !gateBlocked.length && !needYouEyes.length) L.push('✅ 没有卡住的条目，也没有等你拍板的口径问题。')
  return L.join('\n')
}

function decision({ version, items, park, decisions = [] }) {
  const openPark = openAmbiguity(scopeParkToVersion(park, items))
  const notClosed = items.filter(i => !['shipped', 'accepted'].includes(i.bucket))
  const L = ['## 四、老板验收决策（三选一）', '']
  L.push(`- [ ] **整版通过** → ${version || '本版'} 进正式发布准备（生产发布仍由你按下，守航从不自动发布生产）。`)
  L.push('- [ ] **部分通过** → 点名保留哪几条，其余隔离。')
  L.push('- [ ] **整版打回** → 按回退方案退回上一个可回退版本、转共驾态处理。')
  if (notClosed.length) {
    L.push('')
    L.push(`**⚠ 还有 ${notClosed.length} 条没到「待你验收」**：${notClosed.map(i => `${i.req}(${i.boardStatus || '无状态'})`).join('、')} —— 选「整版通过」前先看第三章。`)
  }
  const mustCount = openPark.length + decisions.length
  if (mustCount) {
    L.push('')
    const bits = []
    if (decisions.length) bits.push(`档案 ${decisions.length} 条（${decisions.slice(0, 8).map(d => d.id).join('、')}${decisions.length > 8 ? '…' : ''}）`)
    if (openPark.length) bits.push(`park ${openPark.length} 条（${openPark.map(e => upper(e.req)).join('、')}）`)
    L.push(`**⭐ 必答（${mustCount} 条）**：${bits.join(' + ')} —— 每条都带了拟定口径，你说「按拟定的来」也算答。`)
  }
  return L.join('\n')
}

function roundDeltaSection({ latest, delta, contractDiffMd, redLightsMd }) {
  const L = ['## 五、最近一轮守航（增量 + 审计）', '']
  if (!latest) return L.concat('_（本版没有守航轮次记录）_').join('\n')
  L.push(`**轮次** \`${latest.runName}\`　起 ${latest.startsAt || '—'}　止 ${latest.endsAt || '—'}`)
  L.push('')
  L.push(`- **契约点名**：${delta.planned.length ? delta.planned.join('、') : '（未点名，走就绪池）'}`)
  L.push(`- **本轮真动过**：${delta.touched.length ? delta.touched.map(t => `${t.req}（${t.via.join('/')}）`).join('、') : '⚠ 没有任何机器痕迹'}`)
  if (delta.entered.length) L.push(`- **本轮新进登记表**：${delta.entered.join('、')}`)
  if (delta.plannedNotTouched.length) {
    L.push('')
    L.push(`**⚠ 点了名却一整轮零机器痕迹**：${delta.plannedNotTouched.join('、')} —— 既没进条目账、没跑门禁、也没有落在本轮窗口内的证据。这不等于「没做」，但等于「做了也没留下机器可查的痕迹」，两者都要问一句。`)
  }
  L.push('')
  if (redLightsMd) { L.push(redLightsMd); L.push('') }
  if (contractDiffMd) L.push(contractDiffMd)
  return L.join('\n')
}

function roundsTable(rounds) {
  const L = ['## 六、历史轮次汇总（一轮一行）', '']
  if (!rounds.length) return L.concat('_（本版没有守航轮次）_').join('\n')
  L.push('| 轮次 | 起 | 契约点名 | token | 越权 | 假绿 | 超预算 | 已结算 |')
  L.push('|------|----|---------|-------|------|------|--------|-------|')
  for (const r of rounds) {
    const led = r.ledger || {}
    const named = r.contract?.selection?.named_items
    const n = (Array.isArray(named) ? named : String(named || '').split(/[,，\s]+/)).filter(Boolean)
    L.push(`| \`${r.runName}\` | ${String(r.startsAt || '').slice(0, 16).replace('T', ' ') || '—'} | ${n.length ? n.map(upper).join('、') : '（就绪池）'} | ${led.usage?.tokens || '—'} | ${(led.forbidden || []).length} | ${led.fakeGreen?.count || 0} | ${(led.overBudget || []).filter(v => v.code === 'over_budget').length} | ${led.settledAt ? String(led.settledAt).slice(0, 16).replace('T', ' ') : '否'} |`)
  }
  return L.join('\n')
}

// ---------- 装配 ----------
// **绝不因缺料而不出包**：缺的章节如实标「未接通/未记录」，不用空白冒充通过。
export function assembleVersionReport(input = {}) {
  const {
    version = '', date = '', archiveRel = '', entries = [], rows = [], rounds = [], park = [],
    gateBlocked = [], qaReportCard = '', selfReports = [], extraSections = [], settleActions = [],
    historicalRunReports = [],
    // ★ 2026-09-09 加：档案里开着的待确认事项 / 缺「不拍的代价」的那几条 / 要老板亲眼看的 facet。
    // 由调用方（server）用 task-brief 从**任务档案**抽——档案是唯一状态源，它里面等着拍的问题
    // 必须进这张单子。此前本单只读 park 台账，于是「今天真正等老板拍的 15 条一条没报」。
    decisions = [], costMissing = [], needYouEyes = [],
  } = input
  const { items, orphanReqs } = deriveVersionItems({ entries, rows, rounds, park })
  const latest = rounds.length ? rounds[rounds.length - 1] : null
  const delta = deriveRoundDelta({ round: latest, entries, rows, park })
  const versionState = deriveVersionState(input.fm || {}, entries)
  const gaps = Array.isArray(input.gaps) ? input.gaps : versionGaps({ ...input, entries, rows, rounds, orphanReqs })

  const S = []
  S.push('---')
  S.push('type: version-acceptance-report')
  S.push(`version: ${version || "''"}`)
  S.push(`date: ${date}`)
  S.push(`archive: ${archiveRel || "''"}`)
  S.push(`rounds: [${rounds.map(r => r.runName).join(', ')}]`)
  S.push(`version_state: ${versionState}`)
  S.push('assembled_by: engine')
  S.push('---')
  S.push('')
  S.push(`# ${version || '未定版'} 晨检验收单 · ${date}`)
  S.push('')
  S.push('> **这是什么**：**一个版本一份**，每天覆盖写。守航终点不是「发布完成」，而是「已就绪、等待人工接管」——一睁眼先看这张单，几分钟内做三选一。')
  S.push('> **★诚实铁律**：本单**由引擎从机器事实装配**（登记表 / 覆盖矩阵 / 三红灯台账 / 契约 diff / park 台账）——**不取 agent 自述**。agent 叙述另置文末「自述栏」并标注，绝不与机器事实混排。')
  S.push('')
  // 〇
  const G = ['## 〇、本单缺了哪些料（引擎自检，缺席≠通过）', '']
  if (!gaps.length) G.push('✅ 机器事实齐备。')
  else { G.push(`本单有 **${gaps.length}** 处缺料，**缺席的章节一律按「未接通/未记录」读，不得当成「已通过」**：`); for (const x of gaps) G.push(`- ${x}`) }
  if (settleActions.length) { G.push(''); G.push('**deadline 到点强制结算（E3）本次动作**'); for (const a of settleActions) G.push(`- \`${a.code}\` —— ${a.why}`) }
  if (historicalRunReports.length) { G.push(''); G.push(`> 本版另有 ${historicalRunReports.length} 份**已停产的轮次级晨检包**（${historicalRunReports.join('、')}）——它们停留在各自那一夜的口径，别当成今天的结论。`) }
  S.push(G.join('\n'))
  S.push('')
  S.push(summary({ version, versionState, items, rounds, latest, park, decisions, costMissing }))
  S.push('')
  S.push(itemsTable(items, orphanReqs))
  S.push('')
  S.push(stuckSection({ items, park, gateBlocked, decisions, costMissing, needYouEyes }))
  S.push('')
  S.push(decision({ version, items, park, decisions }))
  S.push('')
  S.push(roundDeltaSection({ latest, delta, contractDiffMd: input.contractDiffMd, redLightsMd: input.redLightsMd }))
  S.push('')
  S.push(roundsTable(rounds))
  S.push('')
  S.push('## 七、机器门与人工债')
  S.push('')
  for (const sec of extraSections) if (sec) { S.push(sec); S.push('') }
  if (qaReportCard) { S.push('### QA 报告卡片'); S.push(''); S.push(qaReportCard); S.push('') }
  S.push('---')
  S.push('')
  S.push('## 八、agent 自述栏（与上方机器事实分离，仅供参考、不作放行依据）')
  S.push('')
  if (!selfReports.length) S.push('_（无 agent 自述）_')
  for (const r of selfReports) {
    S.push(`### ${r.employee || '?'}（自述，非机器事实）`)
    S.push('')
    S.push(String(r.text || '').slice(0, 3000))
    S.push('')
  }
  // ★ 术语泄漏自检（2026-09-09）：装配完扫一遍自己，把还没翻译的机器枚举**自己报出来**。
  // 缘起：老板说这单子"抽象用语、不适合人类阅读"——而这种漏是**新增枚举时最容易忘同步翻译层**造成的，
  // 靠人下次再骂一遍代价太高。同 §3.118 的思路：**能自检的东西别等人来发现**。
  // 只提示不阻断（单子该出还得出），但把缺口写在正文里，谁看到都知道该去补 humanize.js。
  const out = S.join('\n').replace(/\n{4,}/g, '\n\n\n')
  const leaks = findTermLeaks(out)
  if (!leaks.length) return out
  return out + `\n\n> ⚠ **本单有 ${leaks.length} 个机器术语没翻成人话**：\`${leaks.join('`、`')}\`——` +
    `它们是引擎内部状态，不该出现在给人看的单子上。请在 \`app/humanize.js\` 补对应翻译（一句人话 + 你要做什么 + 谁来做）。\n`
}
