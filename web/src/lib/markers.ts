// 引擎/员工识别的正文哨兵标记（与 app/server.js、旧前端 app.js 对齐）。

export const CHATLOG_OPEN = '〘聊天记录〙'
export const CHATLOG_CLOSE = '〘/聊天记录〙'

// 沉浸式图文预检单引导行：告诉员工正文穿插 〖截图〗 路径，逐张 Read。
export const IMMERSIVE_LEAD =
  '（人工预检发现，正文穿插截图；每个〖截图〗标记内是图片路径，请逐张用 Read 工具查看）'

export function wrapChatlog(text: string): string {
  return `${CHATLOG_OPEN}\n${text.trim()}\n${CHATLOG_CLOSE}`
}

// 收工汇报末行的机器可读门：`【等你拍板】<事项>` / `【等你拍板】无`。
// **必须独占一行**——不锚行的话，正文里白话提一句「末行要写【等你拍板】无」也会被当成门。
export const GATE_LINE_RE = /^[ \t]*【等你拍板】[ \t]*(\S[^\n]*?)?[ \t]*$/gm

// 「空门」判定：员工写「无」的花样很多（无 / 无。/ （无）/ 暂无 / 没有待办…），
// 都得算「没事项」。**这条谓词是唯一事实源**：状态徽标（status.ts runStateKind）与
// 会话里合成 gate 卡（olcards.ts parseGateMarker）必须共用它——两处口径一旦漂移，就会出现
// 「徽标已是已完成、下面还挂着一张空的『等你拍板 / 无。』卡」（老板 2026-09-09 截图）。
export function isEmptyGateItem(item: string): boolean {
  const s = String(item || '').trim().replace(/^[（(【[]\s*/, '')
  return !s || /^(?:无|暂无|没有|none|n\/a)/i.test(s)
}
