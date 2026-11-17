#!/usr/bin/env node
// PreToolUse 兜底守卫：禁止员工用 Agent/Task 工具把「别的员工的活」嵌套进自己 run。
//
// 背景（2026-07-16 事故）：GG Bond 在 run 20260716091809-ee6815 收工时，本该写
// 【下一棒】迷糊 把 QA 交给迷糊老师，却用 Agent(subagent_type="mihu") 在自己会话里
// spawn 了一个 mihu 子代理——office-lab 看不到、迷糊老师的 run 状态不亮、交接等于没发生。
// 工牌红线（.claude/agents/ggbond.md:34 / roles/ggbond.md:15）早写了禁令，但纯文字
// 约束在多次上下文压缩后没兜住。此 hook 把红线升级为工具层强制（与 server 端
// autoChain「所有守卫都在服务端强制，不依赖 agent 是否守规矩」同哲学）。
//
// 规则：Agent/Task 调用里 subagent_type 若解析到某个员工（feifei/ggbond/mihu/bobby
// 及其中文名/别名）→ deny，提示改用【下一棒】/【交回】标记走 office-lab dispatch。
// Explore / Plan / general-purpose 等非员工子代理照常放行（那是员工自己那段活的子步骤）。

// 员工 key → 别名（与 app/server.js EMP_ALIASES 保持一致）
const EMP_ALIASES = {
  feifei: ['菲菲', 'feifei'],
  ggbond: ['gg bond', 'ggbond', 'gg-bond'],
  mihu:   ['迷糊老师', '迷糊', 'mihu'],
  feisila: ['菲斯拉', 'feisila'],
  bobby:  ['波比', 'bobby'],
}
// 展开成「小写别名 → key」查找表
const NAME_TO_KEY = {}
for (const [key, aliases] of Object.entries(EMP_ALIASES)) {
  NAME_TO_KEY[key.toLowerCase()] = key
  for (const a of aliases) NAME_TO_KEY[a.toLowerCase()] = key
}

function resolveEmployeeKey(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return null
  if (NAME_TO_KEY[s]) return NAME_TO_KEY[s]
  // 退化匹配：subagent_type 里「包含」某员工名（如 "handoff-to-mihu"）
  for (const name of Object.keys(NAME_TO_KEY)) {
    if (name.length >= 2 && s.includes(name)) return NAME_TO_KEY[name]
  }
  return null
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => { input += c })
process.stdin.on('end', () => {
  let payload
  try { payload = JSON.parse(input || '{}') } catch { process.exit(0) }  // 解析失败不拦，避免误伤

  const toolName = payload.tool_name || ''
  if (toolName !== 'Agent' && toolName !== 'Task') process.exit(0)

  const subagentType = (payload.tool_input || {}).subagent_type
  const empKey = resolveEmployeeKey(subagentType)
  if (!empKey) process.exit(0)   // 非员工子代理（Explore/Plan/...）放行

  const displayName = { feifei: '菲菲', ggbond: 'GG Bond', mihu: '迷糊老师', feisila: '菲斯拉', bobby: '波比' }[empKey] || empKey
  const reason =
    `🚫 跨员工交接禁用 Agent/Task 工具（工牌红线）。\n` +
    `你正试图用 subagent_type="${subagentType}" 把 ${displayName} 的活嵌套进自己这次 run——` +
    `这样 office-lab 看不到、${displayName}的 run 状态不会亮、交接等于没发生。\n\n` +
    `正确做法（方案 B，只走 office-lab dispatch）：在收工汇报里写机器可读标记，由 server 建真实 run——\n` +
    `  • 派新活给别人：【下一棒】${displayName}｜<完整交接 prompt：目标+背景+定位线索+约束+验收/收工格式>\n` +
    `  • 回发委托你的人：【交回】<结果报告>（或 【交回】@<runId>｜<报告>）\n` +
    `Agent/Task 只能用于你自己这段活的子步骤（Explore 查资料等），不能用来当交接。`

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
})
