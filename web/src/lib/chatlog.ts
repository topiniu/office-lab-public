// 聊天记录解析（对齐旧 UI parseChatlog）：识别企微「多选复制」头行 姓名(姓名) M/D HH:MM:SS，
// 拆成 entries；≥2 条视为标准格式，否则按整段原文保留。用于组合器里把聊天记录抽象成一枚待发 chip。
const CHATLOG_HEAD = /^(.+?)\((.+?)\)\s+(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2}:\d{2})\s*$/

export type ChatlogEntry = { sender: string; date: string; time: string; text: string }
export type ParsedChatlog = {
  format: 'wecom-multiselect' | 'raw'
  raw: string
  entries: ChatlogEntry[]
  meta: { count: number; participants: string[]; span: string }
}

export function parseChatlog(raw: string): ParsedChatlog {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n')
  const entries: ChatlogEntry[] = []
  let cur: ChatlogEntry | null = null
  for (const ln of lines) {
    const m = ln.match(CHATLOG_HEAD)
    if (m) {
      cur = { sender: m[1].trim(), date: m[3], time: m[4], text: '' }
      entries.push(cur)
    } else if (cur) {
      cur.text += (cur.text ? '\n' : '') + ln
    }
  }
  entries.forEach((e) => (e.text = e.text.trim()))
  const ok = entries.length >= 2
  const participants = [...new Set(entries.map((e) => e.sender))]
  const dates = entries.map((e) => e.date)
  const span = dates.length
    ? dates[0] === dates[dates.length - 1]
      ? dates[0]
      : `${dates[0]}–${dates[dates.length - 1]}`
    : ''
  return {
    format: ok ? 'wecom-multiselect' : 'raw',
    raw: String(raw || ''),
    entries: ok ? entries : [],
    meta: { count: ok ? entries.length : 0, participants, span },
  }
}

// chip 文案（对齐旧 UI renderAttach）
export function chatlogChipLabel(c: ParsedChatlog): string {
  return c.format === 'raw'
    ? '聊天记录（原文）'
    : `聊天记录 · ${c.meta.count}条${c.meta.participants.length ? ' · ' + c.meta.participants.join('、') : ''}`
}

// 企微多选复制的剪贴板：纯文本是标准头行格式、图片处写 [图片]；HTML（带 <wxwork-data> 标记）按同样顺序给出图片的
// 本地缓存路径 file:///…/WXWork/<账号>/Cache/Image/…。以纯文本为骨架，第 i 个 [图片] 对应第 i 张缓存图。
// 表情在 HTML 里是 Temp 目录的小图、纯文本里已是 [破涕为笑] 这类文字，不取。非企微来源返回 null。
const WECOM_IMG_CACHE = /[\\/]WXWork[\\/][^\\/]+[\\/]Cache[\\/]Image[\\/]/i
// 自己用企微截图工具截的图不进 Cache/Image，而是 %TEMP%\企业微信截图_<数字>.png（2026-10-20 老板实测：
// 只按 Cache 过滤 → 自己发的截图被当表情扔掉、整段退化成纯文本）。按文件名精确认，表情小图仍排除。
const WECOM_SCREENSHOT = /[\\/]企业微信截图_\d+\.(png|jpe?g)$/i
const isWecomImage = (p: string) => WECOM_IMG_CACHE.test(p) || WECOM_SCREENSHOT.test(p)

export function splitWecomClipboard(text: string, html: string): { parts: string[]; paths: string[] } | null {
  if (!html.includes('wxwork-data')) return null
  const paths = [...html.matchAll(/<img[^>]+src="file:[/]{3}([^"]+)"/gi)]
    .map((m) => {
      try {
        return decodeURIComponent(m[1])
      } catch {
        return m[1]
      }
    })
    .filter(isWecomImage)
  if (!paths.length) return null
  return { parts: text.replace(/\r\n/g, '\n').split('[图片]'), paths }
}
