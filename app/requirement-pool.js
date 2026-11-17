// ============================================================================
// 守航就绪池：需求表结构化字段 + 巡航排序 + 七项拷问 + park 台账 + 窄口径声明 + 跨入口一致性 facet
// （方案 §2 飞书字段 / §3.1 A1–A5 · A4）
//
// 缘起（方案原文的实测事实）：菲菲**每轮守航从零重读飞书全量**（30→23→20 条）、重写 triage 底账；
// guarded-02 那轮抽了 **0 条**；她能自证零歧义的只有「复用已交付基线」这一类；REQ-0304/0309
// **连续 park 3 轮，每轮重写一样的拟定口径**。老板提的「表里加守航态 ready tag」是对的，但
// **一个 tag 不够** —— 得让机器能判「为什么不 ready、还差哪一项」。
//
// 所以这里做三件事：
//   ① §2 八个结构化字段（`守航就绪` / `就绪缺口` / `risk_class` / `紧急度` / `park 轮次` /
//      `窄口径声明` / `facet 冻结` / `影响入口`），并给出「表里缺哪列」的自动建列清单；
//   ② A1 巡航排序 + A2 就绪标准（七项拷问机器化，`只有就绪能进契约`）；
//   ③ A5 park 台账（轮次自增，**≥2 轮自动升级为晨检必答**），A3 窄口径声明强制，
//      A4 从 UI 契约派生跨入口一致性 facet。
//
// 纯函数（表读写在 server.js 注入）。
// ============================================================================
// 条目状态词汇从 `entry-status.js` 取（引擎侧唯一事实源；从 server.js 引会成环，别再抄第二份）
import { SHIPPED_STATUS as PARK_CLOSE_TERMINAL, QA_ONWARD_STATUS as PARK_QA_ONWARD } from './entry-status.js'

// ---------- §2 · 结构化字段 ----------
// type 用飞书多维表的字段类型编号（1文本 2数字 3单选 4多选 5日期 11人员），与 lark_manage_field 对齐。
export const POOL_FIELDS = [
  { name: '守航就绪', type: 3, options: ['就绪', '待澄清', '不适合守航'], who: '菲菲（澄清后置）', use: '巡航筛选的唯一入口；只有「就绪」能进契约' },
  { name: '就绪缺口', type: 4, options: ['来源', '口径', '边界', '范围', '依赖', '可测性', '影响面'], who: '菲菲', use: '让「待澄清」可执行：直接生成问老板的问题' },
  { name: 'risk_class', type: 3, options: ['low', 'medium', 'high'], who: '菲菲 + GG Bond 复核', use: '驱动 E6 门禁矩阵' },
  { name: '紧急度', type: 3, options: ['P0', 'P1', 'P2', 'P3'], who: '老板/提出人', use: '巡航排序（现在排序靠菲菲读措辞猜）' },
  { name: '期望时间', type: 5, options: [], who: '老板/提出人', use: '巡航排序的第二键' },
  { name: 'park轮次', type: 2, options: [], who: '引擎', use: '同一条 park ≥2 轮 → 自动升级为晨检必答' },
  { name: '窄口径声明', type: 1, options: [], who: '菲菲', use: '防「上线当天用户就说不满足」（REQ-0302）' },
  { name: 'facet冻结', type: 1, options: [], who: '菲菲', use: '契约资格判据（是/否 + facet_doc 锚点）' },
  { name: '影响入口', type: 1, options: [], who: '菲菲/GG Bond', use: '来自猪猪 GET /ui-contract；生成跨入口一致性 facet' },
]
// 表里已有字段名 → 缺哪些列（供 A1 巡航开工时自检 + 一键建列）
export function missingPoolFields(existingNames) {
  const have = new Set((existingNames || []).map(s => String(s).replace(/\s/g, '')))
  return POOL_FIELDS.filter(f => !have.has(f.name.replace(/\s/g, '')))
}

// ---------- A2 · 七项拷问（就绪标准的机器化） ----------
// 「没到标准不许置就绪」—— 这条是守航资格的**唯一入口**，也是防「夜里替老板猜」的根。
export const PROBES = [
  { key: '来源', ask: '需求原话/提出人是谁、原始诉求读过全文了吗（不是列表摘要）', field: 'sourceRead' },
  { key: '口径', ask: '业务口径是否已定（或能在同源语料库里找到已定过的口径并注明来源）', field: 'semanticsFixed' },
  { key: '边界', ask: '边界与异常分支是否枚举清楚（各成一行 facet）', field: 'boundaryEnumerated' },
  { key: '范围', ask: '本次只做什么、明确不做什么（窄口径声明）', field: 'scopeDeclared' },
  { key: '依赖', ask: '依赖的上游/他组/数据是否就位', field: 'dependencyReady' },
  { key: '可测性', ask: '能不能由机器验（facet 有可断言的值；测试路径无不可逆副作用）', field: 'testable' },
  { key: '影响面', ask: '影响哪些入口/组件（≥2 入口复用 → 需横向 facet）', field: 'impactKnown' },
]
export const PROBE_KEYS = PROBES.map(p => p.key)

// answers: { sourceRead:true, semanticsFixed:false, ... }（缺的一律当 open，不当通过）
// 返回 { ready, gaps:[key], openProbes:[{key,ask}], questions:[...] }
export function evaluateReadiness(answers = {}, extra = {}) {
  const gaps = [], openProbes = []
  for (const p of PROBES) {
    if (answers[p.field] === true) continue
    gaps.push(p.key); openProbes.push(p)
  }
  // 额外三条硬前置（A2 判据清单原文）：facet 冻结 / risk_class 定 / 窄口径声明写好
  const hard = []
  if (!extra.facetFrozen) hard.push('facet 未冻结（缺 facet_doc 锚点）')
  if (!extra.riskClass) hard.push('risk_class 未定')
  if (!String(extra.narrowScope || '').trim()) hard.push('窄口径声明未写（A3 强制字段）')
  if (extra.irreversibleSideEffect) hard.push('测试路径存在不可逆外部副作用（方案 §6.4：测试路径也算，须人工风险签核）')
  const ready = gaps.length === 0 && hard.length === 0
  return {
    ready, gaps, openProbes, hardBlockers: hard,
    readinessValue: ready ? '就绪' : (extra.unsuitable ? '不适合守航' : '待澄清'),
    questions: openProbes.map(p => `${p.key}：${p.ask}`),
  }
}

// ---------- 需求表原始行 → 池行（A1 巡航的取数层） ----------
// `cell(rec, ...names)` 由调用方注入（飞书的 fields 形状与 larkCellText 都在 server.js）。
// 这里只负责**映射与默认值**，因为其中有一条安全判断值得单独测：
//   **`守航就绪` 列不存在 / 值为空时一律当「待澄清」，绝不默认「就绪」。**
// 若默认成「就绪」，表还没建列的今天，`pickForContract` 会把整表 200+ 条全判成合格候选、
// 夜里直接开跑——这正是「资格门形同虚设」的最坏形态（比抽 0 条坏得多）。
export function toPoolRow(rec, cell, { parkRounds = {} } = {}) {
  const req = String(cell(rec, '编号') || '').toUpperCase() || String(rec?.record_id || '')
  return {
    req, recordId: rec?.record_id || '',
    title: String(cell(rec, '需求点', '需求描述', '详情') || '').slice(0, 40),
    readiness: String(cell(rec, '守航就绪') || '').trim() || '待澄清',
    gaps: String(cell(rec, '就绪缺口') || ''),
    riskClass: String(cell(rec, 'risk_class', '风险') || '').toLowerCase().trim(),
    priority: String(cell(rec, '紧急度', '优先级') || '').toUpperCase().trim(),
    dueDate: String(cell(rec, '期望时间') || '').trim(),
    // park 轮次以**引擎台账**为准；表里那列只是投影，可能没回刷（任务档案/台账才是事实源）
    parkRounds: parkRounds[req] || Number(cell(rec, 'park轮次') || 0) || 0,
    narrowScope: String(cell(rec, '窄口径声明') || ''),
    facetFrozen: /是|已冻结|true/i.test(String(cell(rec, 'facet冻结') || '')),
  }
}

// ---------- A1 · 巡航排序 ----------
// 排序键：紧急度 × 价值 × 就绪度。现在排序靠菲菲读措辞猜——这里定死。
const P_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 }
const READY_RANK = { 就绪: 0, 待澄清: 1, 不适合守航: 2 }
export function sortPool(rows) {
  return (rows || []).slice().sort((a, b) => {
    const ra = READY_RANK[a.readiness] ?? 1, rb = READY_RANK[b.readiness] ?? 1
    if (ra !== rb) return ra - rb                                            // 就绪的先上（能真跑的排前面）
    const pa = P_RANK[String(a.priority || '').toUpperCase()] ?? 9, pb = P_RANK[String(b.priority || '').toUpperCase()] ?? 9
    if (pa !== pb) return pa - pb
    const da = Date.parse(a.dueDate || '') || Infinity, db = Date.parse(b.dueDate || '') || Infinity
    if (da !== db) return da - db                                            // 期望时间近的先
    const ka = Number(a.parkRounds || 0), kb = Number(b.parkRounds || 0)
    if (ka !== kb) return kb - ka                                            // park 轮次多的先（别再让它烂在队里）
    return String(a.req || '').localeCompare(String(b.req || ''))
  })
}
// 从就绪池取本轮候选（契约 selection.source 从「夜里现挑」改成「从就绪池取」）
export function pickForContract(rows, maxItems, { allowedRisk = ['low', 'medium'] } = {}) {
  const sorted = sortPool(rows)
  const eligible = sorted.filter(r => r.readiness === '就绪' && allowedRisk.includes(String(r.riskClass || 'low')))
  const picked = eligible.slice(0, Math.max(1, Number(maxItems) || 1))
  const deferredHigh = sorted.filter(r => r.readiness === '就绪' && !allowedRisk.includes(String(r.riskClass || 'low')))
  return {
    picked, eligibleCount: eligible.length,
    // guarded-02 抽了 0 条这件事必须**显式报出来**，不能静默返回空数组（方案 S4 出口判据点名了它）
    empty: picked.length === 0,
    emptyWhy: picked.length === 0
      ? (rows || []).length === 0 ? '就绪池是空的——A1 巡航还没跑过，或表里没有 `守航就绪` 列' :
        eligible.length === 0 ? `池里 ${(rows || []).length} 条，但没有一条同时满足「守航就绪=就绪」且 risk_class∈${allowedRisk.join('/')}${deferredHigh.length ? `（${deferredHigh.length} 条就绪但是 high，按 E6 须共驾实施）` : ''}` : ''
      : '',
    deferredHigh,
  }
}

// ---------- A5 · park 台账 ----------
export const PARK_ESCALATE_ROUNDS = 2

// park 台账里混着**两种语义完全不同**的东西，此前共用一个 `rounds` 计数器，于是「≥2 轮自动进必答区」
// 长期是反的：2026-08-28 实测必答区里全是引擎顺延占位（REQ-0271 rounds=3 / REQ-0313 rounds=2），
// 而 8 条菲菲写了实质拟定口径的真歧义**全部 rounds=1、一条都进不去**。先分家，别再往上加例外。
//   · ambiguity —— 真歧义：卡在某条拷问、带菲菲的拟定口径，**要老板一句话才能推动**
//   · deferred  —— 引擎在 deadline「到点未达 RC_READY」自动顺延的占位，不是问题、不该进必答区
export const PARK_KIND = { AMBIGUITY: 'ambiguity', DEFERRED: 'deferred' }
const DEFER_REASON_RE = /deadline\s*到点未达\s*RC_READY/i
const DEFER_PROPOSAL_RE = /引擎自动顺延/
// 旧台账没有 kind 字段 → 按指纹回填，免一次性迁移脚本。默认归 ambiguity：park_item 是主路径，
// 且「把真问题误当占位关掉」比「把占位多留一轮」贵得多。
export function classifyParkKind(entry = {}) {
  if (entry.kind === PARK_KIND.DEFERRED || entry.kind === PARK_KIND.AMBIGUITY) return entry.kind
  if (DEFER_REASON_RE.test(String(entry.reason || '')) || DEFER_PROPOSAL_RE.test(String(entry.proposal || ''))) return PARK_KIND.DEFERRED
  return PARK_KIND.AMBIGUITY
}

// entries: 已有台账 [{req, kind, reason, probeKey, proposal, rounds, firstAt, lastAt}]
export function recordPark(entries, { req, reason, probeKey, proposal, at, kind } = {}) {
  const arr = Array.isArray(entries) ? entries.map(e => ({ ...e })) : []
  const key = String(req || '').toUpperCase()
  if (!key) return { entries: arr, error: 'park 台账需要 req 编号' }
  const now = at || new Date().toISOString()
  const k = kind === PARK_KIND.DEFERRED ? PARK_KIND.DEFERRED : PARK_KIND.AMBIGUITY
  const hit = arr.find(e => String(e.req).toUpperCase() === key)
  if (hit) {
    hit.rounds = Number(hit.rounds || 1) + 1
    hit.lastAt = now
    // ⚠ **顺延写入只许抬轮次，禁止覆盖 reason/proposal**。2026-08-28 踩过：条目账接通后
    // deadline 顺延首次真的触发，把 REQ-0271/0313 里菲菲写的实质口径整段覆盖成了
    // 「deadline 到点未达 RC_READY」/「（引擎自动顺延）」——老板要拍的那段话就这么没了。
    if (k === PARK_KIND.DEFERRED) {
      hit.deferredAt = now
      hit.deferRounds = Number(hit.deferRounds || 0) + 1
      if (!hit.kind) hit.kind = classifyParkKind(hit)
      return { entries: arr, entry: hit, escalate: hit.rounds >= PARK_ESCALATE_ROUNDS, kept: true }
    }
    hit.kind = PARK_KIND.AMBIGUITY
    // 又 park 一轮 ⇒ 上次表态**没能解开它**（或这轮卡在别处）：清掉表态标记，让它重新回到必答区。
    // 不清的话 `mustAnswer` 会永久放行这条，老板再也看不见它——「已回答」变成又一个免检符。
    if (hit.ruledAt) { hit.rulingStale = hit.ruling || ''; hit.staleRuledAt = hit.ruledAt; delete hit.ruling; delete hit.ruledAt }
    // 每轮重写同样的拟定口径是 A5 要治的病：**只在真变了时才覆盖**，否则保留首版并记「本轮无新意」
    hit.repeatedProposal = String(proposal || '').trim() === String(hit.proposal || '').trim()
    if (!hit.repeatedProposal && String(proposal || '').trim()) hit.proposal = String(proposal).trim()
    if (reason) hit.reason = String(reason)
    if (probeKey) hit.probeKey = String(probeKey)
    return { entries: arr, entry: hit, escalate: hit.rounds >= PARK_ESCALATE_ROUNDS }
  }
  const e = { req: key, kind: k, reason: String(reason || ''), probeKey: String(probeKey || ''), proposal: String(proposal || ''), rounds: 1, firstAt: now, lastAt: now, repeatedProposal: false }
  if (k === PARK_KIND.DEFERRED) { e.deferredAt = now; e.deferRounds = 1 }
  arr.push(e)
  return { entries: arr, entry: e, escalate: false }
}
// 老板对某条 park 的表态落账（守航续跑入口 `/api/guarded/resume` 调）。
// 缘起（2026-09-18）：park 台账此前只进不出——老板拍完，台账上那条**看不出被拍过**，
// 于是下一轮照样把同一条当「没人拍」重抄一遍拟定口径，晨检必答区也照样挂着它。
// 表态**不关闭**条目（关闭的判据仍是登记表进终态，见 reconcilePark 的 A 档口径），
// 只把「已被回答」这件事变成机器可读：出必答区、续跑时作为口径注回 prompt。
export function recordParkRuling(entries, { req, ruling, at, runName } = {}) {
  const arr = Array.isArray(entries) ? entries.map(e => ({ ...e })) : []
  const key = String(req || '').toUpperCase()
  const text = String(ruling || '').trim()
  if (!key || !text) return { entries: arr, error: 'recordParkRuling 需要 req 与 ruling' }
  const now = at || new Date().toISOString()
  const hit = arr.find(e => String(e.req).toUpperCase() === key)
  if (!hit) return { entries: arr, error: `park 台账里没有 ${key}（表态无处可落）` }
  hit.ruling = text
  hit.ruledAt = now
  hit.ruledInRun = String(runName || '')
  hit.repeatedProposal = false     // 已有新输入，下一轮不该再被判「一字未变」
  return { entries: arr, entry: hit }
}
// 必答区 = **未关闭、且老板还没表过态**的真歧义，且已 ≥2 轮。顺延占位永不进（它不是问题，老板答不了）；
// 已表态的也不进（他答过了还挂在必答区，等于让他每天重答一次同一个问题）。
export const mustAnswer = entries => (entries || []).filter(e =>
  !e.closedAt && !e.ruledAt && classifyParkKind(e) === PARK_KIND.AMBIGUITY && Number(e.rounds || 0) >= PARK_ESCALATE_ROUNDS)

// ---------- park 台账的出口（此前完全没有：全仓 unpark/closePark 零命中，台账单调增长）----------
// 与**唯一状态源**（任务档案「## 需求条目登记表」）对账。判据用白名单三档，不用「状态≠parked」的黑名单——
// 黑名单会把「阻塞」「待梳理」也当成已消化关掉（REQ-0219/0225 正是「口径未定、建档时先占位」这个形状）。
// 白名单的自证逻辑：**机器已经在测它 ⇒ 实施已经发生 ⇒ park 承载的歧义必然已被某种方式回答**（否则实施不了）。
// entriesByReq: Map|Object，REQ → { status, stage, name }
// ⚠ 自动关闭的终态口径**刻意收窄到「已上线/已归档」**，不含「人工Pass/QA通过」。
// 实例：REQ-0271 是 人工Pass，但它被 park 的问题（「是否有纸样」筛选口径要不要同步）在发布前**仍然是活的**
// ——按「过检即关闭」会把这个问题连同它的拟定口径一起静默抹掉，那正是本次要治的病换个方向复发。
// 已上线/已归档则不同：决策已由「发出去了」这个事实兑现，park 挂着确实没有对象了。
export { PARK_CLOSE_TERMINAL, PARK_QA_ONWARD }
export function reconcilePark(entries, entriesByReq, { at, dryRun = false } = {}) {
  const arr = Array.isArray(entries) ? entries.map(e => ({ ...e })) : []
  const now = at || new Date().toISOString()
  const get = req => {
    if (!entriesByReq) return null
    const k = String(req).toUpperCase()
    if (typeof entriesByReq.get === 'function') return entriesByReq.get(k) || null
    return entriesByReq[k] || null
  }
  const closed = [], demoted = [], kept = []
  for (const e of arr) {
    if (e.closedAt) continue
    const row = get(e.req)
    const status = String(row?.status || '').replace(/\*\*/g, '').trim()
    const kind = classifyParkKind(e)
    if (!row || !status) { kept.push({ req: e.req, why: '该条目不在登记表（还没被任何一版纳入）' }); continue }
    // A 档：条目已进终态 —— park 已经没有对象了，任何 kind 都关
    // A′ 档：进了 QA 族且只是顺延占位 —— 占位无保留价值
    if (PARK_CLOSE_TERMINAL.has(status) || (PARK_QA_ONWARD.has(status) && kind === PARK_KIND.DEFERRED)) {
      const rec = { req: e.req, status, kind, closedBy: `登记表状态=${status}` }
      closed.push(rec)
      if (!dryRun) { e.closedAt = now; e.closedBy = rec.closedBy; e.closedByStatus = status; e.closedByKind = kind }
      continue
    }
    // B 档：条目在推进，但被 park 的**口径问题**未必被回答过 —— 移出必答区，绝不关闭。
    // 「后续轮次绕过了它」≠「老板答过了那个问题」，静默关掉等于替老板拍板。
    if (PARK_QA_ONWARD.has(status)) {
      demoted.push({ req: e.req, status, why: `条目已推进到「${status}」，但当初被 park 的口径问题没有任何回答记录` })
      if (!dryRun) e.demotedStatus = status
      continue
    }
    kept.push({ req: e.req, why: `登记表状态=${status}，仍在待处理侧` })
    if (!dryRun) delete e.demotedStatus
  }
  return { entries: arr, closed, demoted, kept }
}
// 顺延前问一句：这条还该不该 park。已在 QA 族/终态的不许再 park（否则刚关掉的下次 deadline 又被重新塞回来）。
export function shouldSkipDefer(row) {
  const status = String(row?.status || '').replace(/\*\*/g, '').trim()
  return !!status && PARK_QA_ONWARD.has(status)
}

export function renderParkLedger(entries) {
  const arr = (entries || []).slice().sort((a, b) => Number(b.rounds || 0) - Number(a.rounds || 0))
  const must = mustAnswer(arr)
  const open = arr.filter(e => !e.closedAt)
  const L = ['### park 台账（≥2 轮自动进「必答区」）', '']
  if (!arr.length) return L.concat('_（本轮没有 park 条目）_').join('\n')
  if (!open.length) return L.concat([`_（没有待拍的 park 条目；${arr.length} 条已与登记表对账关闭，见下）_`, '', ...closedBlock(arr)]).join('\n')
  if (must.length) {
    L.push(`#### ⭐ 必答区（${must.length} 条，你一句话就能推动）`)
    L.push('')
    L.push('| 条目 | 卡在哪 | 已 park 轮次 | 菲菲拟定口径（默认执行值） |')
    L.push('|------|--------|-------------|--------------------------|')
    for (const e of must) L.push(`| **${e.req}** | ${e.probeKey || '—'}：${e.reason || '—'} | **${e.rounds}** ${e.repeatedProposal ? '（本轮拟定口径与上轮**一字未变**——不是想不出，是没人拍）' : ''} | ${e.proposal || '⚠ 没给拟定口径'} |`)
    L.push('')
  }
  // 老板已表态、等着续跑消化的——独立成段。混进「首轮 park / 可以再等一轮」会让他误以为还没人动它。
  const ruled = open.filter(e => e.ruledAt && !e.demotedStatus)
  if (ruled.length) {
    L.push(`#### ✅ 你已表态、待续跑消化（${ruled.length} 条）`)
    L.push('')
    L.push('| 条目 | 你的表态 | 表态时间 | 当初卡在哪 |')
    L.push('|------|---------|---------|-----------|')
    for (const e of ruled) L.push(`| ${e.req} | ${e.ruling || '—'} | ${String(e.ruledAt).slice(0, 19).replace('T', ' ')} | ${e.probeKey || '—'}：${e.reason || '—'} |`)
    L.push('')
  }
  const rest = open.filter(e => !must.includes(e) && !e.demotedStatus && !e.ruledAt)
  if (rest.length) {
    L.push(`#### 首轮 park（${rest.length} 条，可以再等一轮）`)
    L.push('')
    L.push('| 条目 | 卡在哪 | 拟定口径 |')
    L.push('|------|--------|---------|')
    for (const e of rest) L.push(`| ${e.req} | ${e.probeKey || '—'}：${e.reason || '—'} | ${e.proposal || (classifyParkKind(e) === PARK_KIND.DEFERRED ? '（引擎到点顺延，非待拍问题）' : '—')} |`)
    L.push('')
  }
  // B 档：条目已经在往前走了，但当初卡住它的那个口径问题**从来没人回答过** ——
  // 后续轮次多半是按菲菲的拟定口径默认执行落地的。老板要么追认、要么现在推翻，不能装作它已消失。
  const demoted = open.filter(e => e.demotedStatus)
  if (demoted.length) {
    L.push(`#### 条目已推进、但你当初被 park 的口径问题仍未回答（${demoted.length} 条）`)
    L.push('')
    L.push('| 条目 | 现在到哪了 | 当初卡在哪 | 当时的拟定口径（很可能已被默认执行） |')
    L.push('|------|-----------|-----------|--------------------------------|')
    for (const e of demoted) L.push(`| ${e.req} | ${e.demotedStatus} | ${e.probeKey || '—'}：${e.reason || '—'} | ${e.proposal || '⚠ 没给拟定口径'} |`)
    L.push('')
    L.push('> 这几条**不进必答区**（条目没卡住），但也**不自动关闭**——「后续轮次绕过了它」不等于「你答过了那个问题」。追认或推翻，说一句即可。')
    L.push('')
  }
  L.push(...closedBlock(arr))
  return L.join('\n').replace(/\n{3,}/g, '\n\n')
}
// 已与登记表对账关闭的（留证，不从台账里删）
function closedBlock(arr) {
  const closed = (arr || []).filter(e => e.closedAt)
  if (!closed.length) return []
  const L = [`#### 本轮自动关闭（${closed.length} 条，留证可回溯）`, '']
  L.push('| 条目 | 关闭依据 | 关闭时间 |')
  L.push('|------|---------|---------|')
  for (const e of closed) L.push(`| ${e.req} | ${e.closedBy || '—'}${e.closedByKind === PARK_KIND.DEFERRED ? '（原为引擎顺延占位）' : ''} | ${String(e.closedAt).slice(0, 19).replace('T', ' ')} |`)
  L.push('')
  L.push('> 判据：条目已进终态（或顺延占位已进 QA 族）→ park 已无对象。要重开说一句即可，台账里原文还在。')
  return L
}

// ---------- A3 · 窄口径声明 ----------
// 「本次只做 X；提出人原话可能还期待 Y；若要 Y 需要多少工作量」——三段缺一不算写了。
// 直接对着 REQ-0302 那次教训：只做新增行默认值、把「历史不回填」冻成负向 facet，
// 结果上线当天真实用户就要存量也带出，反过来推翻刚冻结的口径。
export function validateNarrowScope(decl) {
  const t = String(decl || '')
  const errors = []
  const has = re => re.test(t)
  if (!t.trim()) return { ok: false, errors: ['窄口径声明为空——A3 是冻结 facet 的强制前置'], sections: {} }
  const doPart = (t.match(/本次只做[:：]?\s*([^\n]*)/) || [])[1] || ''
  const mayWant = (t.match(/(?:可能还期待|原话可能|还可能想要)[:：]?\s*([^\n]*)/) || [])[1] || ''
  const cost = (t.match(/(?:若要|如要|要做)[^\n]*?(?:需要|工作量)[:：]?\s*([^\n]*)/) || [])[1] || ''
  if (!doPart.trim()) errors.push('缺「本次只做 X」——把这次冻结的范围一句话说清')
  if (!mayWant.trim()) errors.push('缺「提出人原话可能还期待 Y」——这是让老板在**冻结前**看到差距的那一行（REQ-0302 就是漏了这行，上线当天被真实用户推翻）')
  if (!cost.trim()) errors.push('缺「若要 Y 需要多少工作量」——没有代价，老板没法在冻结前做取舍')
  if (has(/历史(?:数据)?不回填|存量不(?:处理|回填)/) && !mayWant.trim()) errors.push('声明里把「历史/存量不回填」冻成负向 facet，却没写「提出人可能要存量」——这正是 REQ-0302 的形状')
  return { ok: errors.length === 0, errors, sections: { doPart: doPart.trim(), mayWant: mayWant.trim(), cost: cost.trim() } }
}
export const NARROW_SCOPE_TEMPLATE = [
  '本次只做：<一句话说清冻结范围>',
  '提出人原话可能还期待：<读原话读出来的、这次没做的那部分>',
  '若要那部分，需要工作量：<粗估：几条 facet / 是否动 DDL / 是否要回填存量>',
].join('\n')

// ---------- A4 · 跨入口一致性 facet 生成器 ----------
// 输入：entryMap（组件/testid → 全部调用入口，来自猪猪 GET /ui-contract 或本地 UI 契约降级源）
//      touched（本次改动落在哪些组件/testid 上）
// 凡改动落在被 **≥2 入口复用**的组件上 → 自动生成一条「同一份数据在这 N 个入口表现一致」的 facet。
// **这是部位排序那个逃逸缺陷（四入口三套序，老板一句话报出来）的直接解药。**
export const CROSS_ENTRY_KIND = 'cross-entry'
export function crossEntryFacets(entryMap, touched, { reqId = 'REQ-0000', startIndex = 1, consistencyGroupPrefix = 'cg' } = {}) {
  const map = entryMap && typeof entryMap === 'object' ? entryMap : {}
  const hit = []
  for (const comp of (touched || [])) {
    const key = String(comp || '').trim()
    if (!key) continue
    const entries = map[key]
    if (!Array.isArray(entries) || entries.length < 2) continue
    hit.push({ component: key, entries: [...new Set(entries.map(String))].sort() })
  }
  let i = Number(startIndex) || 1
  const facets = hit.map(h => ({
    id: `${String(reqId).toUpperCase()}-F${i++}`,
    kind: CROSS_ENTRY_KIND,
    level: 'P1',
    cls: 'content',
    component: h.component,
    entries: h.entries,
    consistencyGroup: `${consistencyGroupPrefix}:${h.component}`,
    criterion: `同一份数据在这 ${h.entries.length} 个入口表现一致（${h.entries.join(' / ')}）——顺序、文案、可见性、禁用条件逐项对齐，任一入口不同即红`,
  }))
  return {
    facets,
    skipped: (touched || []).length - hit.length,
    why: facets.length ? '' : '本次改动没有落在被 ≥2 入口复用的组件上（或入口图谱不可用）——不生成横向 facet',
  }
}
export function renderCrossEntryFacets(gen) {
  if (!gen.facets.length) return `### 跨入口一致性 facet（A4）\n\n_${gen.why}_`
  const L = ['### 跨入口一致性 facet（A4 自动生成；迷糊用猪猪 `consistencyGroup` 跑）', '', '| facet ID | 组件 | 入口数 | 验收标准 | consistencyGroup |', '|----------|------|-------|---------|------------------|']
  for (const f of gen.facets) L.push(`| ${f.id} | \`${f.component}\` | ${f.entries.length} | ${f.criterion} | \`${f.consistencyGroup}\` |`)
  return L.join('\n')
}
