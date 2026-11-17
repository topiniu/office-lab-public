// ============================================================================
// 晨检包自动装配器（方案 §1 E2）+ 版本冻结与结算（§1 E3）
//
// 缘起（方案原文，最刺眼的一条）：`templates/守航晨检验收包.md` **模板存在四个月、0 份实例**；
// 老板每早自己翻 130KB 时间线。守航契约里 `produce_morning_report: true` 从来只是个字面。
//
// 本模块把它变成装配器：引擎从**机器事实**拼包 —— 条目结果表（看板+覆盖矩阵）、猪猪 report-card、
// 契约 vs 实际 diff、三红灯、park 决策卡、发布对账。**agent 自述单列并标注**（模板 H5 诚实铁律：
// 被 reward-hack 出 GREEN 的 agent 会照样报 GREEN，所以自述绝不与机器事实混排）。
//
// 设计取舍：装配器**只吃已经算好的结论**（guard-ledger / release-chain / audit-trust / qa-report-card
// 各自的输出），自己不做判定。这样每块都能单测，晨检包也能在次日「照原样复算一遍」。
// ============================================================================

import { renderRedLights, redLightTotals } from './guard-ledger.js'
import { renderReleaseChain, renderDeployManifest, renderRollbackPlan } from './release-chain.js'
import { renderTrustSection, renderMisjudge, renderEscapeCase } from './audit-trust.js'
import { renderParkLedger, mustAnswer } from './requirement-pool.js'
import { renderGateMatrix } from './gate-matrix.js'
import { renderVisualAcceptance, renderResidueReport, renderHumanDebt } from './qa-report-card.js'
import { renderImpactRadar } from './handoff-freeze.js'

const yn = v => v === true ? '是' : v === false ? '否' : '—'
const num = v => (v === null || v === undefined || v === '') ? '—' : String(v)

// ---------- 逐条目结果：从机器事实派生 ----------
// 缘起（2026-08-28）：本函数以前不存在 —— 条目表**只吃 agent 手填的 items**，自动结算路径没人填就是 0 条。
// 现在由五个机器源合成：契约点名 / 台账 itemResults / 门禁定级 / park 台账 / 覆盖矩阵；agent 填报**只补空**，
// 绝不覆盖机器算得出的字段（诚实铁律：自述不与机器事实混排）。每条带 sources，晨检包脚注里逐条标出处。
const REQ_RE = /^REQ-\d+/
// 编号归一：老板在契约里点名常写成 `req-316`，而 facet/看板/park 台账一律是 `REQ-0316`。不归一就会在
// 条目表里同时出现 REQ-316（空壳）和 REQ-0316（真数据）两行，「计划条目」还会翻倍（2026-08-27-guarded-01 实测）。
const upper = s => String(s || '').toUpperCase().trim().replace(/^REQ-(\d{1,3})\b/, (_, d) => 'REQ-' + d.padStart(4, '0'))
const ts = s => Date.parse(String(s || '').replace(' ', 'T')) || 0
// 证据签发时刻：从 runId 里抠。**两种真实形态都要认** —— 引擎侧 `20260826010203-1ead52`，
// 猪猪侧 `session-20260827-182259-a00d85a5-round-1`（只认前者会把猪猪的证据当成「没有时间」，
// 于是「park 和证据谁更新」永远判成 park 更新）。所以在整串里找「8 位日期 + 可选分隔 + 6 位时刻」。
const runIdTs = id => {
  const m = String(id || '').match(/(\d{4})(\d{2})(\d{2})[-_ ]?(\d{2})(\d{2})(\d{2})/)
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`) || 0 : 0
}
export function deriveItems({ contract = {}, ledger = null, park = [], rows = [], agentItems = [], startedAt = '', endedAt = '' } = {}) {
  const items = new Map()
  const since = ts(startedAt)
  const until = ts(endedAt)
  const get = (req, source) => {
    const k = upper(req)
    if (!REQ_RE.test(k)) return null
    if (!items.has(k)) items.set(k, { req: k, sources: [] })
    const it = items.get(k)
    if (source && !it.sources.includes(source)) it.sources.push(source)
    return it
  }
  // ① 契约点名：boss_named 轮次的本轮范围就写在 selection.named_items 里（机器可读，无需问 agent）
  const named = contract?.selection?.named_items
  for (const r of Array.isArray(named) ? named : String(named || '').split(/[,，\s]+/)) get(r, '契约点名')
  // ② 台账 itemResults：risk_gate / park_item / set_entry_status 在动作当下记的
  for (const [req, v] of Object.entries(ledger?.itemResults || {})) {
    const it = get(req, '台账')
    if (!it) continue
    for (const k of ['result', 'commit', 'stopWhy', 'proposal', 'branch', 'evidencePath', 'riskClass', 'boardStatus']) if (v[k]) it[k] = v[k]
  }
  // ③ 门禁定级：跑过 risk_gate 即属本轮范围
  for (const [req, d] of Object.entries(ledger?.gateDecisions || {})) { const it = get(req, '门禁定级'); if (it && d?.riskClass) it.riskClass = d.riskClass }
  // ④ park 台账：**只认本轮**。台账是跨轮累积的，不筛就会把历史 park 全灌进今天。两条边界不对称：
  //   · 下界（starts_at）对谁都成立 —— 上一轮的 park 不许污染本轮；
  //   · 上界（deadline）只用来**拦新条目**：同一天两轮守航时，后一轮 park 的条目会落进前一轮的窗口右侧
  //     （实测 REQ-0313 被 guarded-02 park，却混进了 guarded-01 的包）。但对本轮**已经在册**的条目，
  //     deadline 之后的 park 仍要收 —— 引擎自己的「到点顺延自动 park」正是发生在 deadline 之后。
  for (const e of park || []) {
    const at = ts(e.lastAt || e.firstAt)
    if (since && at < since) continue
    const known = items.has(upper(e.req))
    if (!known && until && at > until) continue
    const it = get(e.req, 'park台账')
    if (!it) continue
    if (!it.result) it.result = 'parked'
    if (!it.stopWhy && e.reason) it.stopWhy = e.reason
    if (!it.proposal && e.proposal) it.proposal = e.proposal
    it.parkedAt = Math.max(it.parkedAt || 0, ts(e.lastAt || e.firstAt))
  }
  // ⑤ agent 填报：只补空。「需人工必验」另存一格 —— 它在覆盖矩阵里有机器口径（HUMAN_INHERENT 等状态），
  // agent 的散文不许挤掉那份事实，只能以「agent 补注」的身份挂在后面。
  for (const a of agentItems || []) {
    const it = get(a.req, 'agent填报')
    if (!it) continue
    for (const [k, v] of Object.entries(a)) {
      if (k === 'req' || v === undefined || v === '') continue
      if (k === 'humanInherent') { if (!it.humanInherentAgent) it.humanInherentAgent = v; continue }
      if (it[k] === undefined) it[k] = v
    }
  }
  // ⑥ 覆盖矩阵：绿/总、证据 commit、RED 校准、需人工必验 —— 这几项一律以矩阵为准（agent 说了不算）
  const byReq = new Map()
  for (const r of rows || []) { const k = upper(r.req); if (!k) continue; if (!byReq.has(k)) byReq.set(k, []); byReq.get(k).push(r) }
  for (const [req, rs] of byReq) {
    if (!items.has(req)) continue   // 任务档案是跨轮共用的（v5.20 一份档案 8 条 REQ），只认本轮范围内的
    const it = items.get(req)
    const greens = rs.filter(r => String(r.status).toUpperCase() === 'COVERED_GREEN')
    it.facetTotal = rs.length
    it.green = greens.length
    // 「够不够 RC_READY」的机器判据：全部 facet 要么真绿、要么 HUMAN_INHERENT（机器本来就测不了、
    // 等的就是人验收——守航 exit.final_state 正是 awaiting_human_acceptance）。SOURCE_ATTESTED / BLOCKED
    // / UNCOVERED 一律算没到（源码坐实是弱证据，F1 会把它列为可疑，不能当已处置）。
    it.dispositioned = rs.length > 0 && greens.length > 0 && rs.every(r => ['COVERED_GREEN', 'HUMAN_INHERENT'].includes(String(r.status).toUpperCase()))
    it.greenAt = Math.max(0, ...greens.map(g => runIdTs(g.green?.runId)))
    it.commit = it.commit || greens.map(g => g.green?.commit).filter(Boolean)[0] || ''
    it.redCalibrated = greens.length ? greens.every(g => g.redOk === true) : null
    const manual = rs.filter(r => ['HUMAN_INHERENT', 'SOURCE_ATTESTED', 'BLOCKED_WITH_PROOF'].includes(String(r.status).toUpperCase()))
    if (manual.length) it.humanInherent = manual.map(r => `${r.facetId}(${r.status})`).join('、')
    if (!it.sources.includes('覆盖矩阵')) it.sources.push('覆盖矩阵')
  }
  // ⑦ 兜底：返工轮次 + 没人显式记过结果时按覆盖矩阵判
  const rounds = ledger?.usage?.devQaRoundsByItem || {}
  for (const it of items.values()) {
    if (rounds[it.req] != null && it.devQaRounds === undefined) it.devQaRounds = rounds[it.req]
    if (!it.result) it.result = it.dispositioned ? 'rc_ready' : 'in_progress'
    // park 与证据打架时：GREEN **只能由引擎从真 summary 签发、不可手填**，park 只是 PM 侧的一条笔记。
    // 证据比 park 新 → park 已过期，按证据算并点名；park 比证据新 → 保持 park，但也要点名（全绿之后又被 park
    // 是真事，老板得知道）。两种情形都留一行 note，绝不静默选一边。
    if (it.result === 'parked' && it.dispositioned) {
      if (!it.parkedAt || (it.greenAt && it.greenAt > it.parkedAt)) {
        it.result = 'rc_ready'
        it.note = `park 台账里还挂着这一条，但覆盖矩阵 ${it.green}/${it.facetTotal} 已全部处置且证据更晚 → 以引擎签发的证据为准，park 记录已过期`
        it.stopWhy = ''
      } else {
        it.note = `覆盖矩阵 ${it.green}/${it.facetTotal} 已全部处置，但之后又被 park —— 按 park 算，原因见停靠明细`
      }
    }
    delete it.dispositioned; delete it.greenAt; delete it.parkedAt
    if (it.humanInherentAgent) { it.humanInherent = [it.humanInherent, `（agent 补注：${it.humanInherentAgent}）`].filter(Boolean).join(' '); delete it.humanInherentAgent }
  }
  return [...items.values()].sort((a, b) => a.req.localeCompare(b.req))
}

// ---------- 一眼摘要 ----------
function summaryTable({ contract, items = [], ledger, rcCommit = '', testEnvUrl = '', prevVersion = '', tokens = null, idleMinutes = null, usage = {} }) {
  const t = redLightTotals(ledger)
  const by = k => items.filter(i => i.result === k).length
  const rounds = items.reduce((n, i) => n + Number(i.devQaRounds || 0), 0)
  const maxTokens = contract?.limits?.max_tokens
  const L = ['## 一、一眼摘要（机器汇总）', '', '| 指标 | 值 |', '|------|-----|']
  L.push(`| 计划条目 | ${items.length} |`)
  L.push(`| 已到 RC_READY（awaiting_acceptance） | ${by('rc_ready')} |`)
  L.push(`| 已隔离（quarantined） | ${by('quarantined')} |`)
  L.push(`| 已跳过 / park 待拍（skipped） | ${by('parked')} |`)
  L.push(`| DEV↔QA 返工次数 | ${rounds} |`)
  L.push(`| **越权拦截** \`guard.violation.forbidden_action\`（须 0） | **${t.forbidden_action}**${t.forbidden_action ? ' 🚨' : ' ✅'} |`)
  L.push(`| **假绿** \`guard.fake_green\`（须 0） | **${t.fake_green}**${t.fake_green ? ' 🚨' : ' ✅'} |`)
  L.push(`| **超预算** \`guard.violation.over_budget\`（须 0） | **${t.over_budget}**${t.over_budget ? ' 🚨' : ' ✅'} |`)
  // RC commit 两种形态：单仓给 sha（截断显示），多仓给 freeze_handoff 的整行（`仓@分支 sha` 串起来）——
  // 后者整行都是信息，不能截断成 12 个字符（截了就只剩半个仓名，还不如不写）。
  const rcCell = !rcCommit ? '⚠ 未记录（证据没绑不可变版本，B1 未落地）'
    : /^[0-9a-f]{7,40}$/i.test(String(rcCommit).trim()) ? '`' + String(rcCommit).trim().slice(0, 12) + '`'
    : String(rcCommit).replace(/\|/g, '\\|')
  L.push(`| 当前 RC commit | ${rcCell} |`)
  L.push(`| 测试环境 | ${testEnvUrl || '—（守航终点是 RC_READY，未发测）'} |`)
  L.push(`| 上一个可回退版本 | ${prevVersion ? '`' + prevVersion + '`' : '⚠ 未记录（D4）'} |`)
  // token 显示三态：量到了报数 / 量不到明说「量不到」（**绝不印 0**，0 与量不到在纸面上长得一样）/ 没传就是 —
  const tokenCell = tokens != null && tokens !== '' ? String(tokens)
    : (usage.tokensUnmeasured > 0 && !usage.tokensMeasured) ? `⚠ **量不到**（SDK 有 ${usage.tokensUnmeasured} 轮 result 未带 usage）`
    : (usage.tokens > 0 ? String(usage.tokens) : '—')
  L.push(`| 本轮 token / 熔断上限 | ${tokenCell} / ${maxTokens == null ? '**未设**（契约 max_tokens: null，成本无硬顶）' : maxTokens} |`)
  L.push(`| 夜间空停累计 | ${idleMinutes == null ? '—' : idleMinutes + ' 分钟'} |`)
  L.push('')
  L.push('> **红灯规则**：三项任一 > 0 → 本轮**不满足放行门**（成熟度晋级需连续三轮全 0）。老板重点看那三行。')
  return L.join('\n')
}

// ---------- 逐条目结果 ----------
const RESULT_LABEL = { rc_ready: '已到 RC_READY', quarantined: '已隔离', parked: 'park 待拍', in_progress: '仍在途' }
function itemsTable(items = [], zeroWhy = '') {
  const L = ['## 二、逐条目结果（机器事实）', '', '| 条目 | 结果 | RC commit | 测试(绿/总) | RED 校准 | facet 覆盖 | 契约越界 | 需人工必验 |', '|------|------|-----------|------------|---------|-----------|---------|-----------|']
  if (!items.length) L.push('| — | 本轮 0 条目 | — | — | — | — | — | — |')
  for (const i of items) {
    L.push(`| ${i.req || '—'} | ${RESULT_LABEL[i.result] || i.result || '—'} | ${i.commit ? '`' + String(i.commit).slice(0, 10) + '`' : '—'} | ${num(i.green)}/${num(i.facetTotal)} | ${i.redCalibrated === true ? '✓' : i.redCalibrated === false ? '✗' : '未验证'} | ${num(i.green)}/${num(i.facetTotal)} | ${i.violations ? `**${i.violations}**` : '无'} | ${i.humanInherent || '—'} |`)
  }
  // 0 条目**必须说清为什么**（就绪池空？全部 park？还是根本没人记账）——guarded-02 那轮抽 0 条却一句说明都没有，
  // 而 2026-08-28 更糟：条目其实有，只是引擎自己没记账，空表被当成了「本轮什么都没做」。
  if (!items.length) { L.push(''); L.push(`> **为什么 0 条**：${zeroWhy || '⚠ 引擎给不出原因 —— 契约没点名条目、台账无 itemResults、park 台账本轮无记录、覆盖矩阵也无本轮 REQ。这本身是缺口，不是「本轮无事发生」。'}`) }
  const notes = items.filter(i => i.note)
  if (notes.length) {
    L.push('')
    L.push('**⚠ 事实打架的条目（引擎不静默选边，两边都摆出来）**')
    for (const i of notes) L.push(`- **${i.req}**：${i.note}`)
  }
  const withSrc = items.filter(i => (i.sources || []).length)
  if (withSrc.length) {
    L.push('')
    L.push('> 条目结果出处（每条都可复核）：' + withSrc.map(i => `${i.req}←${i.sources.join('/')}`).join('；'))
  }
  return L.join('\n')
}

// ---------- 〇、缺料自检 ----------
// 缘起（2026-08-28）：`reportGaps()` 算出的缺料清单以前**只出现在 MCP 工具给 agent 的返回文本里**，
// 没写进包、自动结算路径更是直接丢弃。于是缺席的章节在包里既没内容也没标注 —— 而模块开头白纸黑字写着
// 「绝不用空白冒充通过」。前端 toast 甚至已经在对老板说「已在包里如实标注」。现在真的标进去。
function gapsSection(gaps = [], settleActions = []) {
  const L = ['## 〇、本包缺了哪些料（引擎自检，缺席≠通过）', '']
  if (!gaps.length) L.push('✅ 机器事实齐备：三红灯台账 / 发布链对账 / 证据可信度 / RC commit / 回退方案 / QA 报告卡片 / 条目表都有料。')
  else {
    L.push(`本包有 **${gaps.length}** 处缺料。**缺席的章节一律按「未接通/未记录」读，不得当成「已通过」**：`)
    for (const g of gaps) L.push(`- ${g}`)
  }
  if (settleActions.length) {
    L.push('')
    L.push('**deadline 到点强制结算（E3）本次动作**')
    for (const a of settleActions) L.push(`- \`${a.code}\` —— ${a.why}`)
  }
  return L.join('\n')
}

// ---------- 停靠原因明细 ----------
function stopReasons(items = []) {
  const stopped = items.filter(i => i.result === 'quarantined' || i.result === 'parked')
  const L = ['## 三、停靠原因明细（隔离 / park，逐条给可复核事实）', '']
  if (!stopped.length) return L.concat(['_（本轮没有隔离/park 条目）_']).join('\n')
  for (const i of stopped) {
    L.push(`- **${i.req}（${RESULT_LABEL[i.result]}）**：${i.stopWhy || '⚠ 没写停靠原因（这本身是问题：停了必须说清卡在哪）'}`)
    if (i.evidencePath) L.push(`　· 失败证据：\`${i.evidencePath}\``)
    if (i.proposal) L.push(`　· 拟定口径/建议：${i.proposal}`)
    if (i.branch) L.push(`　· 分支保留：\`${i.branch}\``)
    if (i.result === 'parked' && !i.proposal) L.push('　· ⚠ park 了却没给拟定口径 —— 老板没法一句话推动，这条要打回菲菲补')
  }
  return L.join('\n')
}

// ---------- 契约 vs 实际 diff ----------
// 导出供**版本验收单**的「最近一轮审计」节复用：契约 vs 实际永远是轮次语义（契约按轮签发），
// 版本包里它只是其中一节，口径与这里必须逐字一致，所以共用同一个渲染器而不是各写一份。
export function renderContractDiff({ contract, ledger, usage = {}, heading = '## 四、契约 vs 实际（审计 diff · 机器比对）' }) {
  const L = [heading, '']
  const fb = ledger?.forbidden || []
  const ob = (ledger?.overBudget || []).filter(v => v.code === 'over_budget')
  const unset = (ledger?.overBudget || []).filter(v => v.code === 'budget_unset')
  L.push(`- **authorization**：实际写/外部动作 ${ (ledger?.toolCalls?.write || 0) + (ledger?.toolCalls?.external || 0) } 次，其中越界 **${fb.length}** 次${fb.length ? '——明细见「三红灯」章节' : '（全部 ∈ 授权集）'}；只读动作 ${ledger?.toolCalls?.read || 0} 次（不计入判定）。`)
  L.push(`- **limits**：${ob.length ? '触顶/超限 ' + ob.length + ' 项：' + ob.map(o => o.field).join('、') : '未触顶'}${unset.length ? `；**未设硬顶**：${unset.map(u => u.field).join('、')}` : ''}。`)
  L.push(`- **forbidden**：命中并被记录 **${fb.length}** 次${fb.length ? '' : '（0）'}。`)
  L.push(`- **selection**：本轮取 ${num(usage.itemsTaken)} 条（上限 ${num(contract?.selection?.max_items)}）；改动仓库 ${num((usage.changedRepositories || []).length)} 个（上限 ${num(contract?.selection?.max_changed_repositories)}）。`)
  L.push(`- **exit**：契约 target=${contract?.exit?.target || '—'}，实际是否达成见第二章逐条目结果。`)
  const unlisted = ledger?.unlisted || []
  if (unlisted.length) {
    L.push('')
    L.push(`> 另有 ${unlisted.length} 次「写类动作但契约未涉及」（改用例、写实施记录这类本职）——**不计红灯**，列在此供抽查：${[...new Set(unlisted.map(u => u.tool))].slice(0, 12).join('、')}`)
  }
  return L.join('\n')
}

// 猪猪能力探活表（版本验收单的「机器门」一节共用）：**能力缺位 → 那道门开不了 → 结论只能记「未验证」**。
// 2026-09-07 起走三态：可用 / 缺位 / **未探测**（需真实参数才能调的端点不盲调——旧版拿空参 4xx
// 判缺位，把 `get_env_fingerprint`、`report-card` 这两个一直 ga 的能力写成「猪猪未实现」四个月）。
export function renderZhuzhuProbe(probe, title = '本轮哪些机器门是开的（猪猪能力探活）') {
  if (!probe) return ''
  const L = [`### ${title}`, '', '| 能力 | 编号 | 状态 |', '|------|------|------|']
  for (const v of Object.values(probe.map || {})) {
    const badge = v.available === true ? `✅ 可用${v.source === 'catalog' ? `（能力目录 ${v.catalogStatus || 'ga'}${v.since ? ` · since ${v.since}` : ''}）` : ''}`
      : v.available === false ? '❌ ' + (v.why || '不可用')
      : '· 未探测：' + (v.why || '需真实参数')
    L.push(`| ${v.label} | ${v.z} | ${badge} |`)
  }
  if (probe.catalog) { L.push(''); L.push(`> 事实源：猪猪能力目录 \`GET /capabilities\`（${probe.catalog.service}，${probe.catalog.count} 条）——端点在不在问它，**不按命名习惯猜**。`) }
  if ((probe.missing || []).length) { L.push(''); L.push(`> ⚠ ${probe.missing.length} 项能力缺位 → 对应的门**开不了**。凡依赖它们的结论一律记「未验证」，不记「通过」。`) }
  if ((probe.unknown || []).length) { L.push(''); L.push(`> · ${probe.unknown.length} 项未探测（需真实 sessionId/参数）——**未探测既不算可用、也不算缺位**，用到时按实际调用结果说话。`) }
  return L.join('\n')
}

// ---------- 老板三选一 ----------
function decisionBlock({ items = [], park = [], gateBlocked = [] }) {
  const must = mustAnswer(park)
  const L = ['## 五、老板三选一（晨审决策）', '']
  L.push('- [ ] **整版通过** → 进正式发布准备（生产发布仍由你按下，守航从不自动发布生产）。')
  L.push('- [ ] **部分通过** → 保留通过条目、隔离其余；点名保留哪几条。')
  L.push('- [ ] **整版打回** → 按「回退方案」退回上一个可回退版本、转共驾态处理。')
  if (gateBlocked.length) {
    L.push('')
    L.push('**⚠ 引擎判定「暂不满足 RC_READY 放行门」**（选「整版通过」前先看这几条）')
    for (const b of gateBlocked) L.push(`- ${b}`)
  }
  if (must.length) {
    L.push('')
    L.push(`**⭐ 必答区（${must.length} 条，你一句话就能推动；已 park ≥2 轮）**`)
    for (const e of must) L.push(`- **${e.req}**（已 park ${e.rounds} 轮${e.repeatedProposal ? '，拟定口径一字未变——不是想不出，是没人拍' : ''}）：${e.proposal || '⚠ 没给拟定口径'}`)
  }
  return L.join('\n')
}

// ---------- 装配 ----------
// 全部入参都可缺；缺的章节要么省略、要么如实标「未接通/未记录」——**绝不用空白冒充通过**。
export function assembleMorningReport(input = {}) {
  const {
    runName = '', version = '', date = '', archiveRel = '', contractRel = '',
    contract = {}, items = [], ledger = null, usage = {},
    rcCommit = '', testEnvUrl = '', tokens = null, idleMinutes = null,
    park = [], gateDecisions = [], gateBlocked = [],
    releaseChain = null, deployManifest = null, rollback = null,
    trust = null, misjudge = null, escapes = [],
    visual = null, residue = null, humanDebt = null, impact = null,
    qaReportCard = '', zhuzhuProbe = null, selfReports = [],
    settleActions = [], zeroItemsWhy = '',
  } = input
  const gaps = Array.isArray(input.gaps) ? input.gaps : reportGaps(input)

  const S = []
  S.push('---')
  S.push('type: guarded-run-morning-report')
  S.push(`version: ${version || "''"}`)
  S.push(`date: ${date || new Date().toISOString().slice(0, 10)}`)
  S.push(`archive: ${archiveRel || "''"}`)
  S.push(`contract: ${contractRel || "''"}`)
  S.push('assembled_by: engine')
  S.push('---')
  S.push('')
  S.push(`# 守航晨检验收包 · ${runName || '(未命名 run)'}`)
  S.push('')
  S.push('> **这是什么**：守航终点不是「发布完成」，而是「已就绪、等待人工接管」。一睁眼先看这张包，**几分钟内做三选一**。')
  S.push('> **★诚实铁律**：本包**由引擎从机器事实装配**（不可变 commit / facet 覆盖态 / RED 校准 / 契约 vs 实际 diff / 三红灯 / 发布对账）——**不取 agent 自述**。agent 叙述另置文末「自述栏」并标注，绝不与机器事实混排。')
  S.push('')
  // 「上一个可回退版本」两处入参择一即可：显式 prevVersion，或 D4 回退方案里的 prev（别让同一事实两处各填一次）
  const prevVersion = input.prevVersion || rollback?.prev || ''
  S.push(gapsSection(gaps, settleActions))
  S.push('')
  S.push(summaryTable({ contract, items, ledger, rcCommit, testEnvUrl, prevVersion, tokens, idleMinutes, usage }))
  S.push('')
  S.push(itemsTable(items, zeroItemsWhy))
  S.push('')
  S.push(stopReasons(items))
  S.push('')
  S.push(renderContractDiff({ contract, ledger, usage }))
  S.push('')
  if (ledger) { S.push(renderRedLights(ledger)); S.push('') }
  if (trust) { S.push(renderTrustSection(trust)); S.push('') }
  if (gateDecisions.length) { S.push(renderGateMatrix(gateDecisions)); S.push('') }
  if (releaseChain) { S.push(renderReleaseChain(releaseChain)); S.push('') }
  if (deployManifest) { S.push(renderDeployManifest(deployManifest)); S.push('') }
  if (rollback) { S.push(renderRollbackPlan(rollback)); S.push('') }
  if (impact) { S.push(renderImpactRadar(impact)); S.push('') }
  if (visual) { S.push(renderVisualAcceptance(visual)); S.push('') }
  if (residue) { S.push(renderResidueReport(residue)); S.push('') }
  if (humanDebt) { S.push(renderHumanDebt(humanDebt)); S.push('') }
  if (park.length) { S.push(renderParkLedger(park)); S.push('') }
  if (misjudge) { S.push(renderMisjudge(misjudge)); S.push('') }
  for (const e of escapes) { const t = renderEscapeCase(e); if (t) { S.push(t); S.push('') } }
  if (qaReportCard) { S.push('## QA 报告卡片（迷糊出稿 → 菲菲业务语言复核）'); S.push(''); S.push(qaReportCard); S.push('') }
  if (zhuzhuProbe) { S.push(renderZhuzhuProbe(zhuzhuProbe)); S.push('') }
  S.push(decisionBlock({ items, park, gateBlocked }))
  S.push('')
  S.push('---')
  S.push('')
  S.push('## agent 自述栏（与上方机器事实分离，仅供参考、不作放行依据）')
  S.push('')
  if (!selfReports.length) S.push('_（本轮无 agent 自述）_')
  for (const r of selfReports) {
    S.push(`### ${r.employee || '?'}（自述，非机器事实）`)
    S.push('')
    S.push(String(r.text || '').slice(0, 3000))
    S.push('')
  }
  return S.join('\n')
}

// 装配前自检：哪些章节因为缺料而缺席。**装配器绝不因缺料而不出包**——
// 一份「标满了未接通」的包也远好过第五个月仍然 0 份实例。
export function reportGaps(input = {}) {
  const gaps = []
  if (!input.ledger) gaps.push('三红灯台账缺失（E1 未接线：本轮没有任何越权/假绿/超预算计数）')
  if (!input.releaseChain) gaps.push('发布链对账缺失（E4/D1 未跑）')
  if (!input.trust) gaps.push('证据可信度章节缺失（F1 未跑）')
  if (!input.rcCommit) gaps.push('RC commit 未记录（B1 交接即冻结未落地，证据没绑不可变版本）')
  if (!input.rollback) gaps.push('回退方案缺失（D4）')
  if (!input.qaReportCard) gaps.push('QA 报告卡片缺失（C4/C5）')
  if (!(input.items || []).length) gaps.push('本轮 0 条目（若来自就绪池为空，见 A1 巡航）')
  // 档案/版本缺失会连累一整片：facet 覆盖、证据可信度、逐条目的绿/总全都取不到（2026-08-28 那两份空包就是这么空的）
  if (!input.archiveRel) gaps.push('任务档案未绑定（契约 frontmatter 的 `archive` 没回填，且 run 没带 taskFile）→ facet 覆盖 / 证据可信度 / 逐条目绿数全部取不到')
  if (!input.version) gaps.push('版本号未记录（契约与档案 frontmatter 都没有 version）')
  return gaps
}

// ============================================================================
// E3 · 版本冻结与追加规则 + deadline 强制结算
//
// 缘起：v5.19 从 2 条涨到 6 条 + 若干增量，`frozen` 直到上生产才置；**3 条已 RC_READY 的被拖 4 天**。
// 契约 deadline 到点强制「结算」：现在到点什么都不发生。
// ============================================================================

export const VERSION_STATES = ['drafting', 'in_dev', 'in_qa', 'rc_ready', 'released_test', 'released_prod']
const stateRank = s => Math.max(0, VERSION_STATES.indexOf(String(s || 'drafting')))

// 默认规则：**守航产出物默认独立成版、当晚可发**。往已达 RC_READY 的版本追加条目 → 必须显式重签契约
// （新 run_name）并把版本状态显式回退，看板要弹确认。
export function appendItemDecision({ versionState = 'drafting', newItems = [], currentRunName = '', reason = '' } = {}) {
  const atOrPastRcReady = stateRank(versionState) >= stateRank('rc_ready')
  if (!atOrPastRcReady) {
    return { allowed: true, needsResign: false, needsConfirm: false, why: `版本状态 ${versionState} 未到 RC_READY，可直接追加 ${newItems.length} 条` }
  }
  return {
    allowed: false, needsResign: true, needsConfirm: true,
    suggestNewVersion: true,
    why: `版本已达 **${versionState}**，往里追加 ${newItems.length} 条会把已经能发的条目一起拖住（v5.19 就是这么把 3 条已 RC_READY 的拖了 4 天）。`,
    options: [
      { key: 'new_version', label: '新条目独立成版（推荐）', detail: '守航产出物默认独立成版、当晚可发；已 RC_READY 的这版照原计划走，不受影响' },
      { key: 'resign', label: '重签契约并回退版本状态', detail: `必须签发新 run_name（当前 ${currentRunName || '—'}）并把版本状态从 ${versionState} **显式回退**到 in_dev；看板会弹确认` },
    ],
    confirmText: `确认要把 ${newItems.length} 条新条目并进已达 ${versionState} 的版本吗？这会让已经能发的条目一起等。原因：${reason || '（未填）'}`,
  }
}

// deadline 到点强制结算：出晨检包 + 版本要么 RC_READY 要么明确顺延。**不许什么都不发生。**
export function settleAtDeadline({ deadlineIso = '', now = Date.now(), versionState = '', items = [], reportWritten = false } = {}) {
  const dl = Date.parse(String(deadlineIso).replace(' ', 'T'))
  if (!Number.isFinite(dl)) return { due: false, why: 'deadline 无法解析，不结算（但这本身该修：契约 deadline 是必填）' }
  if (now < dl) return { due: false, why: `未到 deadline（还有 ${Math.round((dl - now) / 60000)} 分钟）`, minutesLeft: Math.round((dl - now) / 60000) }
  const done = items.filter(i => i.result === 'rc_ready')
  const undone = items.filter(i => i.result !== 'rc_ready')
  const actions = []
  if (!reportWritten) actions.push({ code: 'write_morning_report', why: '到点必须出晨检包（契约 exit.produce_morning_report=true；此前四个月 0 份实例）' })
  if (done.length && stateRank(versionState) < stateRank('rc_ready')) actions.push({ code: 'set_version_rc_ready', why: `${done.length} 条已达 RC_READY → 版本状态置 rc_ready，别让它停在 ${versionState || '(空)'}` })
  if (undone.length) actions.push({ code: 'defer_items', why: `${undone.length} 条未达 RC_READY → **明确顺延**（写进 park 台账 + 下轮候选），不许无声挂着`, items: undone.map(i => i.req) })
  if (!done.length && !undone.length) actions.push({ code: 'report_zero_items', why: '本轮 0 条目 → 晨检包里必须显式说明「为什么一条都没做」（就绪池空？全部 park？）——guarded-02 抽 0 条那次没有任何说明' })
  return { due: true, actions, doneCount: done.length, undoneCount: undone.length, why: `已到/超过 deadline（${deadlineIso}），强制结算 ${actions.length} 项` }
}
