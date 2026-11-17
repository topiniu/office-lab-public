// ============================================================================
// 守航目标循环（goal 模式，v0.11.0）：一轮守航的活没干完，引擎就接着派人干，直到做完 / 真卡住 / 到点
//
// 缘起（2026-09-29 与老板的讨论，对照 Codex / Claude Code / Hermes 三家的 /goal 实现）：
//   守航原来只有「交接链」——菲菲→GG Bond→迷糊，谁收工没写下一棒，这一轮就停了。停下的那一刻没人问
//   「这一轮的目标达成了吗」。实账：09-18 guarded-01 点名 3 条只做完 1 条，每一次停都合规，合起来却只做了三分之一。
//
// 取舍（为什么是这个形状）：
//   · **完成由机器判，不靠员工自报**（Claude Code 的「做活的和判完成的分开」+ Hermes 的确定性门优先）：
//     判据全是台账 / 登记表 / 验收卡里的事实——每个条目要么「做完且验收卡填满」，要么「等老板拍高危事项」，
//     要么「隔离（试尽了）」。LLM 不参与判完成。
//   · **每一棒都开新会话**（Ralph 的「每轮新上下文」+ 进度快照当记忆）：续跑派的是新 run，带任务档案 + 最近一条
//     progress_snapshot，不在一条越滚越长的会话里硬续——长会话压缩后方向会漂（业界共识，复盘里也踩过）。
//   · **没进展要数出来**（Codex 的 blocked audit）：同样的局面连续 3 次续跑都没推进 → 判「卡住」，停下交给老板，
//     不许一直烧。有进展就清零。
//   · **只在链路真的静下来时判**：还有人在跑 / 有后台任务 / 上一棒报错或空转 / 老板按过停 → 不续
//     （2026-07-27「自动热推续跑」事故：错误态自动续会把坏会话越续越卡，所以错误态一律交回老板）。
//   · **有上限**：续跑轮数（默认 8）、截止时间、token 参考顶，任一到了就收手，把现状摆在验收卡上。
//
// 纯函数、可单测；接线（何时 tick、派给谁、广播）在 server.js 的 guardGoalTick。
// ============================================================================
import { cardCompleteness, UNCERTAINTY_RULES, normReq, rejectionActive, blockingRisks } from './acceptance-card.js'
import { classifyEntryStatus } from './entry-status.js'

export const GOAL_DEFAULTS = { maxGoalTurns: 8, noProgressBlock: 3 }
export const GOAL_MODES = ['active', 'shadow', 'off']
export const VERDICTS = ['met', 'waiting_boss', 'continue', 'wait', 'paused', 'blocked', 'budget_limited', 'off', 'no_contract']

const _s = v => String(v == null ? '' : v).replace(/\*\*/g, '').trim()
const up = normReq
// 台账里的旧键可能没补位（REQ-316）——读之前统一归一，否则回放/续跑时查不到
const normMap = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [up(k), v]))

// 契约里的 goal 块：goal.loop = active | shadow | off。旧契约（v0.11.0 前签发）没有这个块 → shadow（只记不派），
// 不给历史契约「悄悄上一个会自己派活的新机制」。全局开关关掉 → off。
export function goalModeOf(contract, { globalEnabled = true } = {}) {
  if (!globalEnabled) return 'off'
  const g = contract?.goal
  const m = g && typeof g === 'object' ? _s(g.loop).toLowerCase() : ''
  return GOAL_MODES.includes(m) ? m : 'shadow'
}
export function goalLimitsOf(contract) {
  const g = contract?.goal && typeof contract.goal === 'object' ? contract.goal : {}
  const n = Math.floor(Number(g.max_goal_turns))
  return { maxGoalTurns: Number.isFinite(n) && n > 0 ? Math.min(n, 30) : GOAL_DEFAULTS.maxGoalTurns, noProgressBlock: GOAL_DEFAULTS.noProgressBlock }
}

// 本轮范围：契约点名 ∪ 台账里记过的条目。自选轮再加「还要不要继续挑需求」这一项（见 selectionPending）。
export function scopeReqs(contract, ledger) {
  const named = (contract?.selection?.named_items || []).map(up).filter(r => /^REQ-\d+/.test(r))
  const touched = Object.keys(ledger?.itemResults || {}).map(up).filter(r => /^REQ-\d+/.test(r))
  const picked = (ledger?.selection?.picked || []).map(up).filter(r => /^REQ-\d+/.test(r))
  return [...new Set([...named, ...touched, ...picked])]
}
export function selectionPending(contract, ledger) {
  const src = _s(contract?.selection?.source)
  if (src === 'boss_named') return false
  if (ledger?.selection?.done) return false
  const max = Math.max(1, Number(contract?.selection?.max_items) || 1)
  return scopeReqs(contract, ledger).length < max
}

// 一个条目在目标意义上的状态。state ∈ done | waiting_boss | quarantined | actionable
export function classifyGoalItem({ req, result = null, card = null, risks = [], entry = null }) {
  const key = up(req)
  const comp = cardCompleteness(card)
  const status = _s(entry?.status)
  const bucket = entry ? classifyEntryStatus(status).bucket : ''
  const reachedEnd = result?.result === 'rc_ready' || bucket === 'accepted' || bucket === 'shipped'
  // 只算仍然有效的高危：链一路走到做完且卡齐、终点晚于登记 → 视为已在别处拍过（老板在会话里拍的那种）
  // 只有「现在就得停」的高危才让条目等老板；「按推荐先做」的照常往下推（2026-09-30 口径）
  const openRisks = blockingRisks(risks, key, { result, reachedEnd, complete: comp.complete })
  // 打回只在「返工还没重新走到终点」时算数；返工做完（台账回到 rc_ready 且晚于打回）就不再挡
  const rejected = rejectionActive(card, result)
  if (card?.verdict?.status === 'accepted') return { req: key, state: 'done', why: '老板已验收' }
  if (openRisks.length) return { req: key, state: 'waiting_boss', why: `等老板拍 ${openRisks.length} 件高危的事（${openRisks.map(r => r.id).join('、')}）` }
  if (result?.result === 'parked' && result?.needsBoss) return { req: key, state: 'waiting_boss', why: `暂停等老板：${_s(result.stopWhy) || '（没写原因）'}` }
  if (bucket === 'shipped') return { req: key, state: 'done', why: '已上线' }
  if (reachedEnd && comp.complete && !rejected) return { req: key, state: 'done', why: '做完了、验收卡四格齐' }
  if (reachedEnd && !rejected) {
    const m = comp.missing[0]
    return { req: key, state: 'actionable', need: 'card', owner: m?.who || 'mihu', why: `功能测完了，验收卡还缺：${comp.missing.map(x => x.what).join('；')}` }
  }
  if (!rejected && (result?.result === 'quarantined' || status === '阻塞' || status === '已隔离')) return { req: key, state: 'quarantined', why: `隔离：${_s(result?.stopWhy) || `看板「${status}」`}` }
  if (rejected) {
    // 打回后的活按它现在走到哪一步派（卡片动作那一刻已直接派过菲菲，别每轮都派回她）
    const why = `老板打回：「${_s(card.verdict.note)}」`
    if (bucket === 'qa') return { req: key, state: 'actionable', need: 'qa', owner: 'mihu', why: `${why}（返工后在测试）` }
    if (bucket === 'dev' || status === '打回') return { req: key, state: 'actionable', need: 'develop', owner: 'ggbond', why: `${why}（返工开发中）` }
    return { req: key, state: 'actionable', need: 'rework', owner: 'feifei', why }
  }
  if (result?.result === 'parked' || bucket === 'parked') return { req: key, state: 'actionable', need: 'redecide', owner: 'feifei', why: `暂停了，但理由不是「只有老板能定」：${_s(result?.stopWhy) || '（没写原因）'}——按三种不确定重新判` }
  if (!result?.result && !entry) return { req: key, state: 'actionable', need: 'start', owner: 'feifei', why: '点名了但还没人碰过' }
  if (status === '打回') return { req: key, state: 'actionable', need: 'develop', owner: 'ggbond', why: 'QA 打回，待开发返工' }
  if (bucket === 'qa') return { req: key, state: 'actionable', need: 'qa', owner: 'mihu', why: `在测试（看板「${status}」）` }
  if (bucket === 'dev') return { req: key, state: 'actionable', need: 'develop', owner: 'ggbond', why: `在开发（看板「${status}」）` }
  if (bucket === 'intake' || /待梳理|需求确认/.test(status)) return { req: key, state: 'actionable', need: 'spec', owner: 'feifei', why: '需求还在梳理' }
  const emp = _s(result?.employee)
  return { req: key, state: 'actionable', need: 'continue', owner: ['feifei', 'ggbond', 'mihu'].includes(emp) ? emp : 'feifei', why: `在途（${_s(result?.result) || status || '未知'}）` }
}

// 进度指纹：只要条目结果 / 看板状态 / 验收卡 / 高危与决定 / 测试绿数有任何变化，指纹就变。
export function progressSignature({ reqs = [], ledger = null, entries = new Map(), rows = [] } = {}) {
  const green = {}
  for (const r of rows || []) {
    const req = (String(r.facetId || '').match(/REQ-\d+/i) || [''])[0].toUpperCase()
    if (req) green[req] = (green[req] || 0) + (String(r.status || '').toUpperCase() === 'COVERED_GREEN' ? 1 : 0)
  }
  const results = normMap(ledger?.itemResults), cards = normMap(ledger?.cards)
  const parts = reqs.map(req => {
    const r = results[req] || {}
    const c = cards[req] || {}
    const e = entries.get ? entries.get(req) : null
    return [req, r.result || '', _s(r.stopWhy).slice(0, 60), _s(e?.status), c.updatedAt || '', green[req] || 0].join('|')
  })
  parts.push(`D${(ledger?.decisions || []).length}R${(ledger?.risks || []).map(r => r.status).join('')}S${ledger?.selection?.done ? 1 : 0}${(ledger?.selection?.picked || []).length}`)
  const s = parts.join('#')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

// 判一次。liveness 由 server 提供：{ busy, busyWhy, bgWaiting, errored, erroredWhy, userStopped }
export function evaluateGoal({ contract, ledger, entries = new Map(), mode = 'shadow', goal = {}, liveness = {}, now = Date.now() } = {}) {
  if (!contract) return { verdict: 'no_contract', why: '本轮没有有效的守航契约', items: [], next: null }
  if (mode === 'off') return { verdict: 'off', why: '目标循环已关闭（契约 goal.loop=off 或全局开关关）', items: [], next: null }
  const reqs = scopeReqs(contract, ledger)
  const results = normMap(ledger?.itemResults), cards = normMap(ledger?.cards)
  const items = reqs.map(req => classifyGoalItem({ req, result: results[req] || null, card: cards[req] || null, risks: ledger?.risks || [], entry: entries.get ? entries.get(req) : null }))
  if (selectionPending(contract, ledger)) {
    const max = Math.max(1, Number(contract?.selection?.max_items) || 1)
    items.push({ req: '(选需求)', state: 'actionable', need: 'select', owner: 'feifei', why: `自选轮最多 ${max} 条、现在挑了 ${reqs.length} 条，还没说「挑完了」` })
  }
  const actionable = items.filter(i => i.state === 'actionable')
  const counts = {
    done: items.filter(i => i.state === 'done').length,
    waitingBoss: items.filter(i => i.state === 'waiting_boss').length,
    quarantined: items.filter(i => i.state === 'quarantined').length,
    actionable: actionable.length,
    total: items.length,
  }
  const lim = goalLimitsOf(contract)
  const base = { items, counts, mode, turns: Number(goal.turns || 0), maxGoalTurns: lim.maxGoalTurns, noProgress: Number(goal.noProgress || 0) }
  if (!actionable.length) {
    if (!items.length) return ledger?.selection?.done
      ? { ...base, verdict: 'met', why: `菲菲挑完了，这一轮没挑到可做的需求：${_s(ledger.selection.why) || '（没写原因）'}`, next: null }
      : { ...base, verdict: 'wait', why: '还没有任何条目进入本轮（菲菲还没开工或没记账）', next: null }
    if (counts.waitingBoss) return { ...base, verdict: 'waiting_boss', why: `能做的都做完了；${counts.waitingBoss} 条在等你拍高危事项`, next: null }
    return { ...base, verdict: 'met', why: `本轮 ${counts.done} 条做完${counts.quarantined ? `、${counts.quarantined} 条试尽后隔离` : ''}，验收卡已齐`, next: null }
  }
  if (liveness.busy) return { ...base, verdict: 'wait', why: `还有人在干活：${liveness.busyWhy || '链上有会话在跑'}`, next: null }
  if (liveness.bgWaiting) return { ...base, verdict: 'wait', why: `在等后台任务：${liveness.bgWaiting}`, next: null }
  if (liveness.userStopped) return { ...base, verdict: 'paused', why: '老板按过「停止」——恢复权在老板，回一句「继续」或在验收卡上操作即可接着跑', next: null }
  if (liveness.interrupted) return { ...base, verdict: 'paused', why: `${liveness.interrupted}——半截活可能有没提交的改动，不自动在它上面另起续跑；回一句「继续」即可接着做`, next: null }
  if (liveness.errored) return { ...base, verdict: 'paused', why: `上一棒没正常收工（${liveness.erroredWhy || '报错/空转'}）——不自动续（2026-07-27 教训），回一句「继续」即可`, next: null }
  const dl = Date.parse(_s(contract.deadline).replace(' ', 'T'))
  if (Number.isFinite(dl) && now > dl) return { ...base, verdict: 'budget_limited', why: '到了契约截止时间，收手；没做完的摆在验收卡上', next: null }
  if (base.turns >= lim.maxGoalTurns) return { ...base, verdict: 'budget_limited', why: `已自动续跑 ${base.turns} 轮（上限 ${lim.maxGoalTurns}），收手`, next: null }
  const maxTok = Number(contract?.limits?.max_tokens)
  if (Number.isFinite(maxTok) && maxTok > 0 && Number(ledger?.usage?.tokens || 0) > maxTok) return { ...base, verdict: 'budget_limited', why: `token 用量 ${ledger.usage.tokens} 超过参考顶 ${maxTok}，收手`, next: null }
  if (base.noProgress >= lim.noProgressBlock) return { ...base, verdict: 'blocked', why: `连续 ${base.noProgress} 次续跑局面都没变，判卡住——需要你看一眼`, next: null }
  return { ...base, verdict: 'continue', why: `还有 ${actionable.length} 件事没做完`, next: pickNext(actionable) }
}

// 一次只派一个人（跨角色重叠由交接链自己完成；目标循环只负责「链停了、还有活」时把链重新点着）。
// 优先级：老板打回/改决定的返工 > 验收卡缺口 > 在测 > 在开发 > 需求侧 > 选需求。同一 owner 的活合并成一次派工。
const NEED_RANK = { rework: 0, redecide: 1, card: 2, qa: 3, develop: 4, continue: 5, spec: 6, start: 7, select: 8 }
export function pickNext(actionable) {
  const sorted = actionable.slice().sort((a, b) => (NEED_RANK[a.need] ?? 9) - (NEED_RANK[b.need] ?? 9))
  const owner = sorted[0]?.owner || 'feifei'
  return { owner, items: sorted.filter(i => i.owner === owner) }
}

// 记一次续跑：与上一次续跑时的指纹相同 ⇒ 上一次续跑没推进（noProgress+1）。
export function noteContinuation(goal = {}, sig = '', at = new Date().toISOString()) {
  const g = { ...goal }
  g.noProgress = g.lastDispatchSig && g.lastDispatchSig === sig ? Number(g.noProgress || 0) + 1 : 0
  g.turns = Number(g.turns || 0) + 1
  g.lastDispatchSig = sig
  g.lastDispatchAt = at
  return g
}
// 判完「continue」之后、真派之前再核一次「上一次续跑有没有推进」：指纹没变且已连着 N 次 → 改判 blocked、不派。
// 放在派工这一刻（而不是 evaluateGoal 里）是因为指纹只在「准备再派一次」时才有意义——链还在跑时指纹天天在变。
export function planContinuation(ev, goal = {}, sig = '', { noProgressBlock = GOAL_DEFAULTS.noProgressBlock, at } = {}) {
  if (ev?.verdict !== 'continue') return { dispatch: false, ev, goal }
  const trial = noteContinuation(goal, sig, at)
  if (trial.noProgress >= noProgressBlock) {
    return {
      dispatch: false,
      goal: { ...goal, noProgress: trial.noProgress },
      ev: { ...ev, verdict: 'blocked', why: `连续 ${trial.noProgress} 次续跑局面都没变（${(ev.next?.items || []).map(i => i.req).join('、')} 卡在同一处），判卡住——需要你看一眼`, next: null },
    }
  }
  return { dispatch: true, ev, goal: trial }
}

// 老板在卡片上动了手 / 回了「继续」：视为新的授权，清零无进展计数与轮数（Hermes 的 /goal resume 同口径）。
export function resetGoal(goal = {}, why = '') {
  return { ...goal, turns: 0, noProgress: 0, lastDispatchSig: '', resetAt: new Date().toISOString(), resetWhy: why }
}
export function recordVerdict(goal = {}, ev, at = new Date().toISOString()) {
  const g = { ...goal }
  const changed = g.lastVerdict !== ev.verdict
  g.lastVerdict = ev.verdict; g.lastWhy = ev.why; g.lastAt = at
  g.history = [...(g.history || []), { at, verdict: ev.verdict, why: ev.why, owner: ev.next?.owner || '' }].slice(-40)
  return { goal: g, changed }
}

const EMP_NAME = { feifei: '菲菲', ggbond: 'GG Bond', mihu: '迷糊老师', bobby: '波比' }
const NEED_TEXT = {
  select: '继续挑需求', start: '开工', spec: '把需求梳理完', develop: '接着开发', qa: '接着测试', card: '补齐验收卡',
  redecide: '重新判这条为什么暂停', rework: '按老板打回的意见返工', continue: '接着推进',
}

// 续跑指令（大白话 + Codex continuation.md 的四条硬规矩：不缩水 / 看现状别看记忆 / 没进展要自己说 / 完成要有证据）
export function renderContinuation({ ev, runName = '', contractRel = '', snapshot = '', turn = 1 } = {}) {
  const mine = ev?.next?.items || []
  const all = ev?.items || []
  const table = all.map(i => `| ${i.req} | ${i.state === 'done' ? '✅ 做完' : i.state === 'waiting_boss' ? '⏸ 等老板拍' : i.state === 'quarantined' ? '⛔ 隔离' : `▶ ${NEED_TEXT[i.need] || '待做'} → ${EMP_NAME[i.owner] || i.owner}`} | ${_s(i.why)} |`).join('\n')
  return `【守航目标循环 · 第 ${turn} 轮自动续跑】这一轮守航（契约 \`${contractRel || runName}\`）的活**还没干完**，链停了，引擎把你叫起来接着做。这不是新需求，是同一轮的续跑。

【本轮现状（引擎从台账/看板/验收卡机读，不是谁的自述）】
| 条目 | 状态 | 说明 |
|---|---|---|
${table}

【你这一棒的活】${mine.map(i => `**${i.req}**：${NEED_TEXT[i.need] || '接着推进'}（${_s(i.why)}）`).join('；') || '见上表'}。做完用【下一棒】交给下一位（这一棒是引擎派的、**没有委托者，别写【交回】**）——链会接着往下走；链再停时引擎会再判一次。
${snapshot ? `\n【上次做到哪（最近一条进度快照）】\n${snapshot}\n` : ''}
【四条硬规矩】
1. **不缩水**：目标是把老板要的那件事做成，不是挑最容易过测的小切片。别换成更窄、更好测、但不是他要的方案。
2. **看现状，别凭记忆**：先看代码仓库、任务档案、覆盖矩阵、验收卡的**当前**状态，再决定下一步；上面那张表就是当前状态。
3. **没进展要说出来**：如果你发现卡在同一个地方（上次也卡在这），换一条从没试过的路；真没路了，写清卡在哪、试过哪些——**同样的局面连续 3 次续跑没推进，引擎会判卡住并停下交给老板**，别用复述状态冒充进展。
4. **「做完」要有证据**：一个条目做完 = 测试通过 + **验收卡四格填满**（一句话说明 + 截图或「无界面改动」理由 + 碰到的老功能逐条重跑验过）。用 \`acceptance_card\` 填，用 \`goal_status\` 自查还缺什么。

${UNCERTAINTY_RULES}

【什么时候才停下来等老板】只有③类（raise_risk 登记后）——其余一律自己查、自己定、做出来亮明。老板现在不在，不要把能自己决定的事写成问句等他。`
}

// 给看板/验收台看的一行（大白话）
export function renderGoalLine(ev, goal = {}) {
  if (!ev) return ''
  const turn = Number(goal.turns || ev.turns || 0)
  const cap = ev.maxGoalTurns || GOAL_DEFAULTS.maxGoalTurns
  const who = ev.next ? `${EMP_NAME[ev.next.owner] || ev.next.owner}` : ''
  switch (ev.verdict) {
    case 'met': return `✅ 这一轮的活干完了：${ev.why}`
    case 'waiting_boss': return `⏸ ${ev.why}`
    case 'continue': return `▶ 还没干完（${ev.why}），${ev.mode === 'active' ? `已派 ${who} 接着做` : `影子模式：若开启会派 ${who}`}（已续跑 ${turn}/${cap} 轮）`
    case 'wait': return `⏳ ${ev.why}`
    case 'paused': return `⏸ 暂停：${ev.why}`
    case 'blocked': return `⛔ 卡住了：${ev.why}`
    case 'budget_limited': return `⏹ 收手：${ev.why}`
    case 'off': return '目标循环未开启'
    default: return ev.why || ''
  }
}
