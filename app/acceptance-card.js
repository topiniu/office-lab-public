// ============================================================================
// 验收卡（守航自助托管 v0.11.0）：一个需求一张卡，只回答老板早上关心的四件事
//
// 缘起（2026-09-29 老板原话）：「晨检包是一个很难用的概念和交互，早晨我来了之后根本没有那么多心思去阅读
// 一大篇文档内容。我只关心我的功能有没有完成，完成后是什么样的，对老功能的影响如何，有哪些高危的事项
// 比如有的功能必须违反红线约束才能实现。」
//
// 于是一张卡 = 四格：
//   ① 做完没      —— 机器事实：台账结果 + 登记表状态 + 覆盖矩阵（绿几条/共几条）
//   ② 长啥样      —— 一句话说明 + 截图（迷糊跑测试时截的；纯后端改动要写明「无界面改动」+ 理由）
//   ③ 动了哪些老功能 —— GG Bond 报「碰到了哪些老功能」，迷糊逐条重跑验证（验过才算数）
//   ④ 要你拍板的高危事项 —— 只收「反悔代价大」的事（改线上数据 / 动权限 / 花钱 / 对外发消息 / 推翻已上线规则）
// 另附一格「我替你定了什么」：守航期间员工自己拍的、**可以反悔**的决定，老板一眼可追认或一键改掉。
//
// 三种不确定（菲菲守航选需求的新口径，也是 record_decision / raise_risk / park_item 三个工具的分界）：
//   fact       查得清的 —— 翻代码 / 历史需求 / 文档 / 以前定过的口径就能回答 → 自己查，写明依据
//   reversible 可以反悔的 —— 界面摆法 / 默认值 / 先只改显示 … 改起来便宜 → 自己拍、做出来、在卡上亮明
//   costly     反悔代价大的 —— 才停下来问老板（进卡片第④格）
//
// 纯函数、可单测；数据落在守航台账（ledger.cards / ledger.decisions / ledger.risks），接线在 server.js。
// ============================================================================
import { classifyEntryStatus } from './entry-status.js'

export const UNCERTAINTY = { FACT: 'fact', REVERSIBLE: 'reversible', COSTLY: 'costly' }

// 三种不确定的**唯一措辞源**：preamble / 冷启动指令 / 工具描述都从这里取，别各写一份（§21.5「指令住在引擎」同理）
export const UNCERTAINTY_RULES = `【三种不确定，三种处理】
① 查得清的（例：「这个导出指哪个」「这个字段现在从哪来」）→ **自己查**：翻最新代码、历史需求/确认文档/实施记录、以前定过的口径。查到了就是答案，写明依据（record_decision kind=fact）。
② 可以反悔的（例：界面怎么摆、默认值多少、先只改显示还是连数据一起改）→ **自己拍板、直接做**，用 record_decision（kind=reversible）记下「我替你定了 A、理由、不满意可改成 B、改起来要多大动静」——它会出现在老板验收卡的「我替你定了什么」里，老板一键追认或改掉。
③ 反悔代价大的（改线上数据/表结构、动权限、影响钱、对外发消息、推翻已上线的规则、删东西）→ **才停下来问老板**：用 raise_risk 登记（为什么非做不可 + 有哪几条路 + 你推荐哪条），它进验收卡最显眼的「高危事项」那一格。
拿不准是②还是③时，问自己：「做错了，老板说一句话我能不能在一小时内改回来、且不留后遗症？」能 → ②；不能 → ③。
**两条铁律（2026-09-30 老板：「只做简单的那我签约守航干什么！」）**：
· **「做不做 / 要不要今晚做 / 什么时候做」从来不是③**——老板签了契约就是要做，风险等级 high 也一样：在开发分支上写代码、在测试环境验证都可以反悔，真正不可逆的只有上线时那几步（线上执行 DDL / 迁移线上数据 / 配权限），它们本来就不许守航做，写成上线步骤留给人。
· **③ 登记完不等于停手**：raise_risk 之后，只要这条路不需要**现在就**执行不可逆动作，就**按你推荐的那条先做下去**，老板在验收卡上改选再返工；只有非做不可、且一做就回不去的那一步才真的停。`

// 菲菲挑中一条需求后的「产品经理五步」（老板 2026-09-29：「根据需求相关的上下文，结合最新的代码仓库和文档资料
// 秉着第一性原理衡量用户到底想要什么、怎么真正解决痛点、行业经验怎么处理、落到我们系统里怎么尽可能维护模块的
// 独立性和易用性」）。**唯一措辞源**：冷启动指令 / 菲菲 SOP 引这一段，别各写一份。
export const PM_FIVE_STEPS = `【挑中一条需求后，像产品经理那样把它想透（五步，别跳）】
1. **用户到底要什么**：谁在用、在什么场景下、现在卡在哪一步、痛在哪。需求原文是用户说的话，不等于用户真正要的东西——从第一性原理推：他做这件事是为了达成什么？
2. **我们现在怎么做的**：翻**最新**代码仓库和文档（任务档案、历史需求说明/确认文档/实施记录、业务知识库），看已有的功能、数据从哪来、相关模块怎么分工。
3. **行业里一般怎么做**：同类系统（ERP / 供应链 / 打样平台 / SaaS 后台）怎么处理这类问题——需要时去网上查（WebSearch），记下出处。
4. **放进我们系统怎么做最好**：能复用的复用，别到处改；这个模块的功能不要写进别的模块（**模块独立**）；用户操作步骤尽量少、默认值尽量聪明（**易用**）。
5. **给方案、做决定**：列 2~3 个做法，选一个，写清为什么选它、放弃别的代价是什么——用 record_decision 记下来（它会出现在老板的验收卡上）。
做完这五步，这条需求里还剩哪些不确定、各属于哪一种，你自己就判得出来。`

// ③ 类的机器信号（record_decision 若撞上这些词，引擎会提醒「这像是反悔代价大的事，改用 raise_risk」）
const COSTLY_RE = /(ddl|alter\s+table|drop\s|truncate|回填|存量数据|线上数据|生产|删除|删掉|权限|权限码|数据权限|金额|价格|计费|扣款|付款|对外|企微|短信|邮件|通知供应商|推送|真机|第三方|推翻|已上线)/i
export function looksCostly(text) {
  const m = String(text || '').match(COSTLY_RE)
  return m ? m[0] : ''
}

const now = () => new Date().toISOString()
const _s = v => String(v == null ? '' : v).replace(/\*\*/g, '').trim()
// 编号归一：契约里有人写 `req-316`、登记表里是 `REQ-0316`（2026-08-27 guarded-01 实账，回放时对不上）→ 统一补到 4 位
export const normReq = r => { const s = String(r || '').toUpperCase().trim(); const m = s.match(/^REQ-(\d+)(.*)$/); return m ? `REQ-${m[1].padStart(4, '0')}${m[2]}` : s }
const reqKey = normReq
const isReq = r => /^REQ-\d+/.test(reqKey(r))

// ---------- 写侧：卡片 / 决定 / 高危 ----------
export function ensureStores(ledger) {
  if (!ledger) return ledger
  if (!ledger.cards || typeof ledger.cards !== 'object') ledger.cards = {}
  if (!Array.isArray(ledger.decisions)) ledger.decisions = []
  if (!Array.isArray(ledger.risks)) ledger.risks = []
  if (!Array.isArray(ledger.cardActions)) ledger.cardActions = []
  return ledger
}

const SHOT_CAP = 12
// patch: { summary, shots:[{src,caption}], noUi:'理由', impact:[{feature,how}], impactVerify:[{feature,ok,evidence}] }
export function upsertCard(ledger, req, patch = {}, by = '') {
  if (!ledger || !isReq(req)) return { error: `条目编号不合法：${req}` }
  ensureStores(ledger)
  const key = reqKey(req)
  const cur = ledger.cards[key] || { req: key, shots: [], impact: [] }
  const next = { ...cur, shots: [...(cur.shots || [])], impact: [...(cur.impact || [])] }
  if (_s(patch.summary)) next.summary = _s(patch.summary)
  if (_s(patch.name)) next.name = _s(patch.name)
  if (patch.noUi !== undefined) next.noUi = _s(patch.noUi) || undefined
  for (const sh of Array.isArray(patch.shots) ? patch.shots : []) {
    const src = _s(sh?.src)
    if (!src) continue
    const at = next.shots.findIndex(x => x.src === src)
    const row = { src, caption: _s(sh.caption) || (at >= 0 ? next.shots[at].caption : ''), by }
    if (at >= 0) next.shots[at] = row
    else next.shots.push(row)
  }
  if (next.shots.length > SHOT_CAP) next.shots = next.shots.slice(-SHOT_CAP)
  // 影响面：GG Bond 申报（feature + how）→ 迷糊逐条验证（ok + evidence）。按 feature 名合并。
  const findImp = f => next.impact.findIndex(x => x.feature === f)
  for (const im of Array.isArray(patch.impact) ? patch.impact : []) {
    const f = _s(im?.feature)
    if (!f) continue
    const at = findImp(f)
    const base = at >= 0 ? next.impact[at] : { feature: f, verified: null, evidence: '' }
    const row = { ...base, how: _s(im.how) || base.how || '', declaredBy: by || base.declaredBy || '' }
    if (at >= 0) next.impact[at] = row
    else next.impact.push(row)
  }
  if (patch.impactNone !== undefined) next.impactNone = _s(patch.impactNone) || undefined
  for (const v of Array.isArray(patch.impactVerify) ? patch.impactVerify : []) {
    const f = _s(v?.feature)
    if (!f) continue
    const at = findImp(f)
    const base = at >= 0 ? next.impact[at] : { feature: f, how: '（验证时补登）' }
    const row = { ...base, verified: v.ok === true ? true : v.ok === false ? false : null, evidence: _s(v.evidence), verifiedBy: by }
    if (at >= 0) next.impact[at] = row
    else next.impact.push(row)
  }
  next.updatedAt = now()
  next.updatedBy = by || next.updatedBy || ''
  ledger.cards[key] = next
  return { card: next }
}

const nextId = (list, prefix) => `${prefix}${(list || []).reduce((m, x) => Math.max(m, Number(String(x.id || '').replace(/\D/g, '')) || 0), 0) + 1}`

// 员工替老板做的决定（①②类）。③类不许走这里——引擎发现像③的会提醒改 raise_risk（见 looksCostly）。
export function recordDecision(ledger, { req, topic, chosen, why, alternative, howToChange, kind, source }, by = '') {
  if (!ledger) return { error: '无台账（本会话不在守航态或无有效契约）' }
  ensureStores(ledger)
  const k = kind === UNCERTAINTY.FACT ? UNCERTAINTY.FACT : UNCERTAINTY.REVERSIBLE
  if (!_s(topic) || !_s(chosen)) return { error: 'topic（在定什么）和 chosen（定成了什么）都要写' }
  if (!_s(why)) return { error: 'why 必填：老板要看的是「为什么这么定」，没有理由他没法追认' }
  if (k === UNCERTAINTY.FACT && !_s(source)) return { error: '查得清的（kind=fact）必须写 source：答案出自哪份文档/哪段代码/哪次拍板' }
  if (k === UNCERTAINTY.REVERSIBLE && !_s(alternative)) return { error: '可以反悔的（kind=reversible）必须写 alternative：老板不满意时一键改成什么' }
  const d = {
    id: nextId(ledger.decisions, 'D'), req: isReq(req) ? reqKey(req) : '', kind: k,
    topic: _s(topic), chosen: _s(chosen), why: _s(why), alternative: _s(alternative), howToChange: _s(howToChange), source: _s(source),
    status: 'open', by, at: now(),
  }
  ledger.decisions.push(d)
  return { decision: d, costlyHint: looksCostly(`${topic} ${chosen} ${howToChange}`) }
}

// ③类：反悔代价大、必须老板拍的事
// blocksNow：这条路是否**现在就**要执行不可逆动作才能往下走。false（默认）＝登记后按推荐的路先做、老板之后在卡上追认；
// true＝真的停在这里等老板（park 自动生成的那件恒为 true）。2026-09-30 起的口径，见 UNCERTAINTY_RULES 两条铁律。
export function raiseRisk(ledger, { req, what, why, options, recommend, redline, source, blocksNow }, by = '') {
  if (!ledger) return { error: '无台账（本会话不在守航态或无有效契约）' }
  ensureStores(ledger)
  if (!_s(what)) return { error: 'what 必填：要做的那件高危的事是什么（用老板听得懂的话）' }
  if (!_s(why)) return { error: 'why 必填：为什么非做不可 / 为什么反悔代价大' }
  const opts = (Array.isArray(options) ? options : String(options || '').split(/\n|；|;/)).map(_s).filter(Boolean)
  if (opts.length < 1) return { error: 'options 至少给一条路（通常 2~3 条：照做 / 不做这部分 / 换个做法），老板才能一键选' }
  const key = isReq(req) ? reqKey(req) : ''
  const src = source === 'park' ? 'park' : 'raise'
  const fields = { what: _s(what), why: _s(why), options: opts.slice(0, 4), recommend: _s(recommend), redline: _s(redline), blocksNow: src === 'park' ? true : blocksNow === true, by, at: now() }
  // 去重（审查发现 #3：park_item 每调一次就多一件、raise_risk 跟在 park 后又一件——老板裁一件，另一件继续把条目挂在「等你拍」）：
  //   · 同条目、同来源为 park 的 open 件 → 就地更新（park 重调＝更新理由，不是又一件事）
  //   · 同条目、同一句 what 的 open 件 → 就地更新
  //   · 显式 raise_risk 登记时，同条目由 park 自动生成的 open 件 → 标 superseded（被正式登记顶掉）
  const open = ledger.risks.filter(r => r.req === key && r.status === 'open')
  const same = open.find(r => (src === 'park' && r.source === 'park') || r.what === fields.what)
  if (same) { Object.assign(same, fields); return { risk: same, updated: true } }
  if (src === 'raise') for (const r of open) if (r.source === 'park') { r.status = 'superseded'; r.ruledAt = now() }
  const r = { id: nextId(ledger.risks, 'R'), req: key, ...fields, source: src, status: 'open' }
  ledger.risks.push(r)
  return { risk: r }
}

const ts = v => Date.parse(v || '') || 0
// 打回还算不算数（审查发现 #1：原先 verdict=rejected 永远不被清，返工做完也永远判不成「做完」）：
// 打回之后条目又一次被判到终点（台账结果回到 rc_ready、且时间晚于打回）→ 打回已被返工兑现，不再挡。
export function rejectionActive(card, result) {
  const v = card?.verdict
  if (v?.status !== 'rejected') return false
  return !(result?.result === 'rc_ready' && ts(result.at) > ts(v.at))
}
// 仍然有效的高危事项（审查发现 #4：老板在会话里拍了、链一路走到做完且卡齐，那件 open 的高危永远挂着）：
// 条目走到终点且卡齐、且终点晚于登记时间 → 视为已在别处拍过（stale），不再挡「做完」。
export function liveRisks(risks, req, { result = null, reachedEnd = false, complete = false } = {}) {
  const key = reqKey(req)
  const open = (risks || []).filter(r => reqKey(r.req) === key && r.status === 'open')
  if (reachedEnd && complete) return open.filter(r => ts(r.at) >= ts(result?.at))
  return open
}
const HIDDEN_RISK = new Set(['moved', 'superseded'])
// 真正挡路的高危：仍有效、且需要现在就停（blocksNow 未明确为 false 的一律算挡路——v0.11.0 早期登记的没有这个字段，按保守口径）
export function blockingRisks(risks, req, opts = {}) {
  return liveRisks(risks, req, opts).filter(r => r.blocksNow !== false)
}

// 老板在卡片上的动作。返回 { ok, reopen:REQ|'' , instruction }：reopen 非空 ⇒ 引擎要把该条目重新交回流水线。
export const CARD_ACTIONS = ['accept', 'reject', 'decision_ok', 'decision_change', 'risk_choose', 'risk_deny', 'risk_proceed']
export function applyCardAction(ledger, { req, action, id, choice, note }, by = 'boss') {
  if (!ledger) return { error: '找不到这一轮的台账' }
  ensureStores(ledger)
  const key = reqKey(req)
  const text = _s(note)
  const log = extra => { ledger.cardActions.push({ at: now(), req: key, action, id: id || '', choice: _s(choice), note: text, by, ...extra }); if (ledger.cardActions.length > 200) ledger.cardActions = ledger.cardActions.slice(-200) }
  if (action === 'accept') {
    const card = ledger.cards[key] || (ledger.cards[key] = { req: key, shots: [], impact: [] })
    card.verdict = { status: 'accepted', at: now(), note: text }
    log({})
    return { ok: true, reopen: '', instruction: '' }
  }
  if (action === 'reject') {
    if (!text) return { error: '打回要写一句原因（哪里不对 / 想要什么样）——否则员工只能猜' }
    const card = ledger.cards[key] || (ledger.cards[key] = { req: key, shots: [], impact: [] })
    card.verdict = { status: 'rejected', at: now(), note: text }
    log({})
    return { ok: true, reopen: key, instruction: `老板打回了 ${key}：「${text}」。按他的话改，改完重新走 QA、重新补齐验收卡。` }
  }
  if (action === 'decision_ok' || action === 'decision_change') {
    const d = ledger.decisions.find(x => x.id === id)
    if (!d) return { error: `找不到决定 ${id}` }
    if (action === 'decision_ok') { d.status = 'confirmed'; d.ruledAt = now(); log({}); return { ok: true, reopen: '', instruction: '' } }
    const to = _s(choice) || d.alternative
    d.status = 'changed'; d.ruling = [to, text].filter(Boolean).join('；'); d.ruledAt = now()
    log({})
    return { ok: true, reopen: d.req || key, instruction: `老板改了你替他做的决定 ${d.id}（${d.topic}）：原来定的是「${d.chosen}」，他要改成「${to}」${text ? `，补充：「${text}」` : ''}。按他的话改，改完重跑受影响的测试、更新验收卡。` }
  }
  if (action === 'risk_proceed') {
    // 「先按推荐做，我之后再定」：高危事项仍开着（卡上还问他），但不再挡路——条目交回流水线按推荐的路做
    const r = ledger.risks.find(x => x.id === id)
    if (!r) return { error: `找不到高危事项 ${id}` }
    r.blocksNow = false; r.proceedAt = now(); r.proceedNote = text
    log({})
    return { ok: true, reopen: r.req || key, instruction: `老板对高危事项 ${r.id}（${r.what}）说：**先按推荐的路做下去**（${r.recommend || r.options[0] || '推荐项'}），他之后在验收卡上再定${text ? `；补充：「${text}」` : ''}。按推荐做到底；真正上线时不可逆的那一步（线上执行 DDL / 迁移线上数据 / 配权限）仍写成上线步骤、不执行。` }
  }
  if (action === 'risk_choose' || action === 'risk_deny') {
    const r = ledger.risks.find(x => x.id === id)
    if (!r) return { error: `找不到高危事项 ${id}` }
    if (action === 'risk_deny') {
      r.status = 'denied'; r.ruling = text || '不做这部分'; r.ruledAt = now()
      log({})
      return { ok: true, reopen: r.req || key, instruction: `老板对高危事项 ${r.id}（${r.what}）的决定：**不做**${text ? `——「${text}」` : ''}。把这部分从范围里拿掉，其余照做，验收卡上写清「这部分没做，因为老板不同意」。` }
    }
    const pick = _s(choice)
    if (!pick) return { error: '要选一条路（choice）' }
    r.status = 'approved'; r.ruling = [pick, text].filter(Boolean).join('；'); r.ruledAt = now()
    log({})
    return { ok: true, reopen: r.req || key, instruction: `老板对高危事项 ${r.id}（${r.what}）的决定：**选「${pick}」**${text ? `，补充：「${text}」` : ''}。这就是授权，按这条路做；仍然守住其余红线（生产发布、线上执行 DDL 这类动作依旧留给人按下）。` }
  }
  return { error: `不认识的动作：${action}` }
}

// ---------- 读侧：卡片是否填满（goal 模式的「完成」判据） ----------
// 「做完」＝①②③都有真凭实据：一句话说明 + 截图（或写明无界面改动）+ 老功能影响申报过且逐条验过。
export function cardCompleteness(card) {
  const missing = []
  const c = card || {}
  if (!_s(c.summary)) missing.push({ part: 'looks', who: 'ggbond', what: '缺一句话说明「做完长什么样」' })
  if (!(c.shots || []).length && !_s(c.noUi)) missing.push({ part: 'looks', who: 'mihu', what: '缺截图（纯后端改动请写明「无界面改动」+ 理由）' })
  const imp = c.impact || []
  if (!imp.length && !_s(c.impactNone)) missing.push({ part: 'impact', who: 'ggbond', what: '没申报碰到了哪些老功能（真没碰到也要写明理由）' })
  const unverified = imp.filter(i => i.verified !== true && i.verified !== false)
  if (unverified.length) missing.push({ part: 'impact', who: 'mihu', what: `${unverified.length} 个受影响的老功能还没重跑验证：${unverified.map(i => i.feature).join('、')}` })
  const broken = imp.filter(i => i.verified === false)
  if (broken.length) missing.push({ part: 'impact', who: 'ggbond', what: `${broken.length} 个老功能验证没过：${broken.map(i => i.feature).join('、')}` })
  return { complete: missing.length === 0, missing }
}

// ---------- 读侧：组装卡片 ----------
// 入参：
//   reqs     —— 要出卡的条目（契约点名 ∪ 台账 ∪ 登记表）
//   ledgers  —— 一轮或多轮台账（版本视图跨多轮时按时间升序传入，后者覆盖前者）
//   entries  —— Map<REQ,{status,name,stage}>（任务档案登记表，唯一状态源）
//   rows     —— 覆盖矩阵行 {facetId,status}
//   goal     —— 目标循环最近一次判定（可缺）
const GREEN = 'COVERED_GREEN'
export function buildCards({ reqs = [], ledgers = [], entries = new Map(), rows = [], goal = null } = {}) {
  const cards = {}, results = {}, decisions = [], risks = [], rounds = []
  for (const led of ledgers.filter(Boolean)) {
    rounds.push(led.runName || '')
    for (const [k, v] of Object.entries(led.cards || {})) cards[k] = { ...(cards[k] || {}), ...v, runName: led.runName }
    for (const [k, v] of Object.entries(led.itemResults || {})) results[k] = { ...v, runName: led.runName }
    for (const d of led.decisions || []) decisions.push({ ...d, runName: led.runName })
    for (const r of led.risks || []) risks.push({ ...r, runName: led.runName })
  }
  const byReqRows = new Map()
  for (const r of rows || []) {
    const req = (String(r.facetId || '').match(/REQ-\d+/i) || [''])[0].toUpperCase()
    if (!req) continue
    if (!byReqRows.has(req)) byReqRows.set(req, [])
    byReqRows.get(req).push(r)
  }
  const keys = [...new Set([...(reqs || []).map(reqKey).filter(isReq)])]
  const goalBlocked = new Set((goal?.items || []).filter(i => i.state === 'actionable' && goal?.verdict === 'blocked').map(i => i.req))
  const out = keys.map(req => {
    const card = cards[req] || { req, shots: [], impact: [] }
    const res = results[req] || {}
    const entry = entries.get ? entries.get(req) : null
    const cov = byReqRows.get(req) || []
    const green = cov.filter(r => String(r.status || '').toUpperCase() === GREEN).length
    const myDecisions = decisions.filter(d => d.req === req && d.status !== 'moved')
    const comp = cardCompleteness(card)
    const bucket = entry ? classifyEntryStatus(entry.status).bucket : ''
    const reachedEnd = res.result === 'rc_ready' || bucket === 'accepted' || bucket === 'shipped'
    const openRisks = liveRisks(risks, req, { result: res, reachedEnd, complete: comp.complete })
    const liveIds = new Set(openRisks.map(r => `${r.runName}|${r.id}`))
    const myRisks = risks.filter(r => r.req === req && !HIDDEN_RISK.has(r.status))
      .map(r => (r.status === 'open' && !liveIds.has(`${r.runName}|${r.id}`) ? { ...r, status: 'stale' } : r))
    const rejected = rejectionActive(card, res)
    let state, headline
    // 已上线的条目：验收这一问早已作废（老板已经发出去了），不再要求补卡、也不再给「通过/打回」
    if (bucket === 'shipped') { state = 'shipped'; headline = `已上线（看板「${_s(entry?.status)}」）` }
    else if (card.verdict?.status === 'accepted') { state = 'accepted'; headline = '你已验收通过' }
    else if (openRisks.some(r => r.blocksNow !== false)) { state = 'waiting_you'; headline = `等你拍板：${openRisks.length} 件高危的事` }
    else if (res.result === 'quarantined' || bucket === 'blocked' || goalBlocked.has(req)) { state = 'stuck'; headline = `卡住了：${_s(res.stopWhy) || (entry ? `看板状态「${_s(entry.status)}」` : '反复尝试仍没推进')}` }
    else if (reachedEnd && comp.complete && !rejected) { state = 'done'; headline = bucket === 'shipped' ? '已上线' : '做完了，等你验收' }
    else if (reachedEnd && !rejected) { state = 'finishing'; headline = '功能测完了，验收卡还在补' }
    else if (res.result === 'parked' || bucket === 'parked') { state = 'parked'; headline = `暂停：${_s(res.stopWhy) || '（没写原因）'}` }
    else if (res.result || bucket === 'dev' || bucket === 'qa') { state = 'in_progress'; headline = bucket === 'qa' ? '在测试' : '在开发' }
    else { state = 'not_started'; headline = '还没开始' }
    const proceeding = openRisks.filter(r => r.blocksNow === false)
    if (proceeding.length && state !== 'waiting_you') headline = `${headline} · ${proceeding.length} 件高危的事已按推荐先做、等你追认`
    if (rejected && state !== 'accepted') headline = `你打回了：「${card.verdict.note}」→ ${headline}`
    const doneText = cov.length
      ? `测试 ${green}/${cov.length} 项机器验过${green < cov.length ? `，另 ${cov.length - green} 项${reachedEnd ? '需要你看一眼（机器验不了）' : '还没验'}` : ''}`
      : (reachedEnd ? '（这条没有登记测试项）' : '还没有测试结果')
    return {
      req, name: _s(card.name) || _s(entry?.name) || '', state, headline,
      runName: card.runName || res.runName || '',
      done: { reachedEnd, text: doneText, green, total: cov.length, boardStatus: _s(entry?.status) },
      looks: { summary: _s(card.summary), shots: card.shots || [], noUi: _s(card.noUi) },
      impact: { items: card.impact || [], none: _s(card.impactNone) },
      decisions: myDecisions,
      risks: myRisks,
      missing: reachedEnd && state !== 'shipped' ? comp.missing : [],
      verdict: card.verdict ? { ...card.verdict, active: card.verdict.status !== 'rejected' || rejected } : null,
    }
  })
  const order = { waiting_you: 0, stuck: 1, done: 2, finishing: 3, in_progress: 4, parked: 5, not_started: 6, accepted: 7, shipped: 8 }
  out.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.req.localeCompare(b.req))
  return { cards: out, rounds, summary: summarizeCards(out), orphanRisks: risks.filter(r => !r.req && r.status === 'open'), orphanDecisions: decisions.filter(d => !d.req) }
}

export function summarizeCards(cards = []) {
  const n = s => cards.filter(c => c.state === s).length
  const done = n('done') + n('accepted')
  const shipped = n('shipped')
  const parts = []
  if (n('waiting_you')) parts.push(`${n('waiting_you')} 条等你拍板`)
  if (n('stuck')) parts.push(`${n('stuck')} 条卡住`)
  if (done) parts.push(`${done} 条做完了`)
  if (n('finishing')) parts.push(`${n('finishing')} 条在补验收卡`)
  if (n('in_progress')) parts.push(`${n('in_progress')} 条还在做`)
  if (n('parked')) parts.push(`${n('parked')} 条暂停`)
  if (n('not_started')) parts.push(`${n('not_started')} 条还没开始`)
  if (shipped) parts.push(`${shipped} 条已上线`)
  const decisionsOpen = cards.reduce((m, c) => m + c.decisions.filter(d => d.status === 'open').length, 0)
  return {
    total: cards.length, done, waitingYou: n('waiting_you'), stuck: n('stuck'), decisionsOpen,
    text: parts.length ? parts.join(' · ') : '这一轮还没有条目',
  }
}
