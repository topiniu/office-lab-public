// ============================================================================
// 事件驱动的空停拦截 + 进度快照 + 合法等待识别
// （方案 §1 E5 / §3.6 G1–G3）
//
// 缘起（方案原文的实测数字）：小呆呆在观测窗口内被派 **79 次，只有 2 次是真停** —— 97% 的巡视是
// 浪费，因为判据挪错了位置：引擎在**事后**发现「收工没写标记」，于是派一个 agent 去读收尾原文、
// 猜它是不是该停。而这件事**在收工那一刻就能机器判**。
//
// 于是三件事：
//   G1（=E5）收工即校验：收尾必须含 `【下一棒】/【交回】/【等你拍板】<真事项>` 之一，
//            缺失即**当场拒收并回灌提示**，不再事后派巡视。小呆呆保留，但只处理
//            「标记写了但语义可疑」的模糊态（QA 空心停靠、发布交付物未齐那类）。
//   G2 长任务心跳与进度快照：员工在长任务中定期落「做到哪 / 下一步是什么」；续跑时**注入快照**，
//            不再让它自己回忆（老板 08-24 连喊 3 次「接着上次进度往下做，不要从头重来」）。
//   G3 合法等待不算空停：「在等后台批次 / 在等 DDL 执行」这类带**可查句柄**的要能识别；
//            反之「句柄丢了还在等」立刻升级。
//
// 纯函数、可单测；接线（onTurnComplete 拒收回灌、resume 注入、patrol 分流）在 server.js。
// ============================================================================

// ---------- G1 · 收工即校验 ----------
export const MARKERS = { next: '【下一棒】', back: '【交回】', gate: '【等你拍板】' }

// **不进流水线的角色豁免收工标记**（巡视员 / 审计）。
//
// 这条豁免不是"照顾"，是拿真实存量数据量出来的：把校验跑过 `app/runs/index.json` 里全部 604 条
// 历史 dispatch 收工，拒收率分布是
//   chaorenq 389 条拒收 47.8% · feisila 7 条拒收 100% · feifei 4.1% · mihu 10.2% · ggbond/bobby 0%
// 前两个高得离谱不是因为它们爱空停，是因为**它们的产出本身就是结论**：
//   · 小呆呆的三种合法结局之一就是「汇报无需动作」（见 roles/chaorenq.md），它写完判定就该收工，
//     没有下一棒可交、也没有要老板拍的事；
//   · 菲斯拉走 `submit_audit_findings` 提交发现，**不掌握放行/打回权**，同样无棒可交。
// 不豁免的后果很具体：每一次巡视都会被拒收 2 次再放行——把 E5 省下的成本原封不动还回去，
// 而且是自指的（巡视本来就是来处理空停的，结果它自己被判空停）。
// 豁免后真流水线四角色（feifei/ggbond/mihu/bobby）的拒收率是 **8/208 = 3.8%**，那才是真空停率。
export const SIGNOFF_EXEMPT_EMPLOYEES = new Set(['chaorenq', 'feisila'])
const markerBlock = (text, re) => {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return lines[i]
  return ''
}
// 「真事项」判据：`【等你拍板】` 后面得有实质内容。空的、只写「无」、只写标点 → 不算事项。
// ⚠ 但 `【等你拍板】无` 是协议里合法的「无需动作」收尾（见 patrolEscalating），所以它算**合规标记**、
//   只是不算「待拍板事项」——两件事分开判，别把合法收尾也拒收。
const TRIVIAL_GATE_RE = /^\s*(?:无|none|no|n\/a|-|—|暂无|没有)\s*[。.!！]?\s*$/i

// ---------- G1.5 · 工具调用泄漏成正文（2026-09-07 事故，run 20260907053624-d858bf）----------
// 现象：模型没有产出真正的 tool_use 块，而是把调用**当文本写了出来**——
//   `<invoke name="mcp__office-lab-collab__set_entry_status"> <parameter name="no">REQ-0334</parameter> …`
// 于是那一步**根本没执行**，但这一轮 result 非空、标记也写了，引擎照旧亮「✅ 本轮收工」绿灯。
// 那条 run 5 轮里 4 轮结尾都是这种假调用：三次靠下一棒续跑救回，末轮的 `set_entry_status`
// **彻底丢了**（v5.22 看板 REQ-0334 该置「待测/已发测」，档案里一个字没改，run 却显示已完成）。
// 危害不在"少写了一行"，在于**声称做了、事实没做，而且系统站在它那边发绿灯**。
//
// 判据刻意结构化、且先剥代码块：员工在汇报里**讲解**这段语法（讨论本 bug、写 SOP、贴例子）不算
// 泄漏——这正是 §3.116 那条教训「『谈论一种标记』与『使用这种标记』必须在词法层可区分」的直接套用。
// 剥围栏块 / 未闭合围栏 / 行内代码，剩下的裸写才算真泄漏；且要求后面跟着 `<parameter` 或 `</invoke>`，
// 单独一句提到 `<invoke name="x">` 不算。
const stripCodeSpans = s =>
  String(s || '')
    .replace(/^[ \t]{0,3}```[\s\S]*?^[ \t]{0,3}```[ \t]*$/gm, '')   // 闭合围栏块
    .replace(/^[ \t]{0,3}```[\s\S]*$/m, '')                          // 末尾未闭合围栏 → 收到文末
    .replace(/`[^`\n]*`/g, '')                                       // 行内代码
// 返回泄漏的工具名（去重、保序）；空数组＝这轮没有假调用
export function leakedInvocations(text) {
  const s = stripCodeSpans(text)
  const out = []
  for (const m of s.matchAll(/<(?:[a-z]+:)?invoke\s+name="([^"\n]{1,120})"\s*>/gi)) {
    const rest = s.slice(m.index + m[0].length, m.index + m[0].length + 600)
    if (/<(?:[a-z]+:)?parameter\s+name=|<\/(?:[a-z]+:)?invoke>/i.test(rest) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

// 返回 { ok, marker, kind, why, nudge }。ok=false 即「当场拒收」。
//   kind: 'next' | 'back' | 'gate' | 'gate-none' | null
export function validateSignoff(text, opts = {}) {
  const t = String(text || '')
  if (!t.trim()) {
    return { ok: false, marker: '', kind: null, code: 'empty', why: '收尾为空——没有任何汇报', nudge: signoffNudge('empty', opts) }
  }
  const nextLine = markerBlock(t, /^[ \t]*【下一棒】/)
  const backLine = markerBlock(t, /^[ \t]*【交回】/)
  const gateLine = markerBlock(t, /^[ \t]*【等你拍板】/)
  if (nextLine) {
    const body = nextLine.replace(/^[ \t]*【下一棒】/, '').trim()
    if (!body) return { ok: false, marker: nextLine, kind: 'next', code: 'next-empty', why: '写了【下一棒】但没写交给谁 + 干什么', nudge: signoffNudge('next-empty', opts) }
    return { ok: true, marker: nextLine, kind: 'next', code: '', why: '', nudge: '' }
  }
  if (backLine) return { ok: true, marker: backLine, kind: 'back', code: '', why: '', nudge: '' }
  if (gateLine) {
    const body = gateLine.replace(/^[ \t]*【等你拍板】/, '').trim()
    if (!body) return { ok: false, marker: gateLine, kind: 'gate', code: 'gate-empty', why: '写了【等你拍板】但后面是空的——说不出要老板拍什么', nudge: signoffNudge('gate-empty', opts) }
    if (TRIVIAL_GATE_RE.test(body)) return { ok: true, marker: gateLine, kind: 'gate-none', code: '', why: '', nudge: '' }   // 协议里的「无需动作」合法收尾
    return { ok: true, marker: gateLine, kind: 'gate', code: '', why: '', nudge: '' }
  }
  // G3：没写标记，但确实在合法等待（带可查句柄）→ 不拒收，但要求它把句柄写进收尾
  const wait = classifyWait(t, opts.handles)
  if (wait.legit) return { ok: true, marker: '', kind: 'waiting', code: 'waiting', why: wait.why, nudge: '' }
  return { ok: false, marker: '', kind: null, code: 'no-marker', why: '收尾里一个机器标记都没有——看板据此判「活交给谁了/停在哪」，缺了就是静默死停', nudge: signoffNudge('no-marker', opts) }
}

// 回灌给员工的提示（当场拒收，不派巡视）。措辞刻意具体到「你现在该写哪一行」——
// 事后巡视之所以贵，一半成本花在「让 agent 猜它当时该做什么」上。
export function signoffNudge(code, opts = {}) {
  const who = opts.employeeName || '你'
  const head = `【引擎当场拒收本轮收尾】${who}这一轮没写出合规的收工标记，本轮不算收工。**别重头做**——接着上次进度往下，把该收的尾收掉，然后在最后**独占一行**写下三者之一：`
  const menu = [
    `- \`${MARKERS.next}<员工> <要他干什么>\`　—— 活干完了、交给下一棒`,
    `- \`${MARKERS.back}<给派活的人的结论>\`　—— 回发给派你活的人`,
    `- \`${MARKERS.gate}<具体事项>\`　—— 真的只有老板能决定（业务口径 / 越界红线动作）；确实无需动作就写 \`${MARKERS.gate}无\``,
  ].join('\n')
  const tailByCode = {
    empty: '本轮完全没有汇报正文（常见于工具报错后没恢复、或结束在思考块上）。先说清「做了什么 / 卡在哪」，再写标记。',
    'no-marker': '⚠ 自问一句：我是不是还有想到但没试过的路？>0 就别停，接着干（守航态规则 4）。',
    'next-empty': '【下一棒】后面必须跟「员工 + 要他干什么」，只写标记名接不了棒。',
    'gate-empty': '【等你拍板】后面必须写**具体事项**。写不出来说明这不是要老板拍的事，是你自己该干完的活——回去干完。',
  }
  return `${head}\n${menu}\n\n${tailByCode[code] || ''}`.trim()
}

// ---------- G3 · 合法等待识别 ----------
// 合法 = 「在等一个**可查的句柄**」。猪猪已提供 list_sessions / get_run_summary / cancel_run 作为句柄事实源；
// 引擎侧的后台任务（run._bgTasks）也是句柄。反之「句柄丢了还在等」→ 立刻升级，不是合法等待。
const WAIT_HINT_RE = /在等|等待中|等着|等后台|等批次|等构建|等部署|等 ?DDL|轮询中|polling|waiting for/i
const HANDLE_RE = /\b(?:sess|session|run|batch|job|task|mr|pipeline)[-_ ]?(?:id)?[-_: ]?([A-Za-z0-9][\w-]{5,})\b/i
export function classifyWait(text, handles = null) {
  const t = String(text || '')
  const hinted = WAIT_HINT_RE.test(t)
  const inline = t.match(HANDLE_RE)
  const known = Array.isArray(handles) ? handles.map(String).filter(Boolean) : []
  const hasKnownHandle = known.length > 0
  const mentionsKnown = known.some(h => t.includes(h))
  if (!hinted && !hasKnownHandle) return { legit: false, why: '', escalate: false }
  // 引擎侧有在跑的句柄 → 一律合法，**不要求它在收尾里点名那个句柄**。
  // 理由：句柄的事实源是引擎（run._bgTasks / 猪猪 list_sessions），不是员工的措辞。要求它复述一遍
  // 只会把「引擎明知在跑」的正常等待判成空停——那是最贵的一类误杀（结果回来会自动唤起，本就不该踢）。
  if (hasKnownHandle) {
    return { legit: true, why: `合法等待：引擎侧有 ${known.length} 个在跑的句柄（${known.slice(0, 3).join(', ')}${known.length > 3 ? '…' : ''}），结果回来会自动唤起${mentionsKnown ? '；收尾里也点名了' : ''}`, escalate: false }
  }
  if (hinted && inline) return { legit: true, why: `合法等待：收尾里给了可查句柄 \`${inline[1]}\``, escalate: false }
  if (hinted && !hasKnownHandle && !inline) {
    return { legit: false, escalate: true, why: '⚠ 声称在等待、但**给不出任何可查句柄**，引擎侧也没有在跑的后台任务——这是「句柄丢了还在等」，不是合法等待，立刻升级（方案 G3）' }
  }
  return { legit: false, why: '', escalate: false }
}

// ---------- G2 · 进度快照 ----------
// 员工用 MCP 工具 `progress_snapshot` 落一条；引擎在**任何**续跑路径（watchdog 自愈 / 巡视 resume /
// 用户回复「继续」）注入最近一条。形状刻意极简：做到哪 / 下一步 / 别再重做什么。
export const SNAPSHOT_MAX = 8              // 每条会话保留的快照数（只保最近 N 条，防无限膨胀）
export const SNAPSHOT_STALE_MS = 45 * 60_000   // 超过 45min 的快照仍注入，但标注「可能已过期，先核对现状」

export function pushSnapshot(list, { done, next, avoid, at } = {}) {
  const arr = Array.isArray(list) ? list.slice() : []
  const snap = {
    at: at || new Date().toISOString(),
    done: String(done || '').trim().slice(0, 800),
    next: String(next || '').trim().slice(0, 500),
    avoid: String(avoid || '').trim().slice(0, 400),
  }
  if (!snap.done && !snap.next) return { list: arr, error: 'done 与 next 至少给一个（「做到哪」和「下一步是什么」）' }
  arr.push(snap)
  while (arr.length > SNAPSHOT_MAX) arr.shift()
  return { list: arr, snapshot: snap }
}

// 续跑注入块。now 可注入（便于单测）。
export function renderResumeSnapshot(list, now = Date.now()) {
  const arr = Array.isArray(list) ? list : []
  if (!arr.length) return ''
  const s = arr[arr.length - 1]
  const ageMs = now - Date.parse(s.at || '') || 0
  const stale = ageMs > SNAPSHOT_STALE_MS
  const L = ['【上次进度快照（引擎注入，不是你的记忆——按它接着往下做，别从头重来）】']
  L.push(`· 落于 ${String(s.at).slice(0, 19).replace('T', ' ')}${stale ? `（已过 ${Math.round(ageMs / 60000)} 分钟，先花一分钟核对现状再动手）` : ''}`)
  if (s.done) L.push(`· 已做到：${s.done}`)
  if (s.next) L.push(`· 下一步：${s.next}`)
  if (s.avoid) L.push(`· 别再重做：${s.avoid}`)
  if (arr.length > 1) L.push(`（本会话共 ${arr.length} 条快照，以上是最新一条；更早的在会话记录里）`)
  L.push('')
  return L.join('\n')
}

// 长任务该不该催快照：本轮已跑 elapsedMs、且距上次快照超过间隔 → 提醒它落一条。
export const SNAPSHOT_NUDGE_AFTER_MS = 12 * 60_000
export function snapshotDue({ elapsedMs, list, now = Date.now() } = {}) {
  if (!(elapsedMs > SNAPSHOT_NUDGE_AFTER_MS)) return false
  const arr = Array.isArray(list) ? list : []
  if (!arr.length) return true
  return (now - (Date.parse(arr[arr.length - 1].at || '') || 0)) > SNAPSHOT_NUDGE_AFTER_MS
}

// ---------- 巡视分流（G1 落地后小呆呆只留「模糊态」） ----------
// 引擎已在收工那一刻拒收「缺标记」，所以剩给巡视的只有三类模糊态。
// 这个函数就是那条分界线：返回 null＝不该派巡视。
export const PATROL_REASONS = {
  qa_hollow: '标记写了，但引擎算的 QA 覆盖闸门未达标（空心停靠）',
  release_incomplete: '标记写了，但发布四件交付物按落盘事实核对未齐',
  handoff_stuck: '标记写了，但交接被 fail-closed / 门禁 abort 掉，活其实没交出去',
  wait_no_handle: '声称在等待但给不出可查句柄（G3：句柄丢了还在等）',
}
export function patrolReason(flags = {}) {
  for (const k of ['qa_hollow', 'release_incomplete', 'handoff_stuck', 'wait_no_handle']) if (flags[k]) return { code: k, why: PATROL_REASONS[k] }
  return null
}
