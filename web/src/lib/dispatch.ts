// 派工/抄送消息里塞满了注入块（任务快照 / 同事近况 / 委托回发说明）+ 机器 marker，
// 直接铺成大气泡会霸屏（见截图）。这里抽出「真正的正文 / 一句话指令」用于折叠头摘要与展开正文，
// 完整原文原样保留在二级「查看原文」里。口径对齐旧 UI app/public/app.js 的
// stripDispatchNoise / dispatchLead / ccFrom，以及服务端 cleanForPush 的注入剥离。

const NOISE_BLOCK = /【(?:任务快照|同事近况|完整档案)】[\s\S]*?(?=\n\s*\n|$)/g   // 注入块：从标记到下一空行
const NOISE_LINE = /^\s*(?:【派工】|【交回】|【等你拍板】|【抄送】|📄|任务档案：)/       // 样板/marker 行（含抄送头）
const DELEGATE_NOTE = /^\s*（本次由[\s\S]*?回发其会话[\s\S]*?）\s*$/m               // 委托回发说明段
const ATTACH_TAIL = /\n*\[附(?:图|件)，请用 Read 工具查看\][\s\S]*$/                 // 附件占位尾巴

/** 剥掉注入块 + 样板行 + 委托说明 = 真正的正文 */
export function stripDispatchNoise(text: string): string {
  return String(text || '')
    .replace(ATTACH_TAIL, '')
    .replace(NOISE_BLOCK, '')
    .split('\n')
    .filter((l) => !NOISE_LINE.test(l))
    .join('\n')
    .replace(DELEGATE_NOTE, '')
    .trim()
}

/** 折叠头一行摘要：正文里首个非列表/标题/引用行，去 md 强调符，最长 46 字 */
export function dispatchLead(text: string): string {
  const line =
    stripDispatchNoise(text)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^[-*#>]/.test(l)) || '派工任务'
  const clean = line.replace(/\*\*|`/g, '')
  return clean.length > 46 ? clean.slice(0, 46) + '…' : clean
}

/** 抄送发起人：【抄送】来自 X（并行知会…）——先剥【同事近况】（其 peer-pulse 也含别人的「【抄送】来自 …」，否则抓错人） */
export function ccFrom(text: string): string {
  const noPulse = String(text || '').replace(NOISE_BLOCK, '')
  const m = noPulse.match(/【抄送】\s*来自\s*(.+?)\s*[（(]/)
  return m ? m[1].trim() : ''
}
