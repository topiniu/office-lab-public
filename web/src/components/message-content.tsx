import { Fragment, type ReactNode } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { PaperclipIcon, ChatTextIcon, CaretDownIcon } from '@phosphor-icons/react'
import { parseChatlog } from '@/lib/chatlog'
import { ShotThumb } from '@/components/image-viewer'
import { cn } from '@/lib/utils'

// 正文哨兵：〖截图〗path｜name〖/截图〗 / 〘聊天记录〙…〘/聊天记录〙 / [附件] name：path
const CHATLOG_RE = /〘聊天记录〙([\s\S]*?)〘\/聊天记录〙/g
// 截图 或 附件文件，一次 tokenize 两种（附件用全角/半角冒号皆可）
const TOKEN_RE =
  /〖截图〗([\s\S]*?)〖\/截图〗|\[附件\]\s*([^\n：:]+)[：:]\s*(\/?\S+)/g

// office-lab/app/uploads/xxx → /uploads/xxx（供 <img> / 链接）
function toUrl(path: string): string {
  const p = path.trim()
  const i = p.indexOf('/uploads/')
  if (i >= 0) return p.slice(i)
  return p.startsWith('/') ? p : `/${p}`
}

// 文件附件卡片：用 currentColor 自适应所在气泡底色（primary 气泡=白字→浅片，muted 气泡=常规）
function FileChip({ name, path, k }: { name: string; path: string; k: string }) {
  const ext = (name.split('.').pop() || '').toUpperCase()
  return (
    <a
      key={k}
      href={toUrl(path)}
      target="_blank"
      rel="noreferrer"
      className="my-0.5 inline-flex max-w-full items-center gap-2 rounded-lg border border-current/20 bg-current/5 px-2 py-1.5 no-underline transition hover:bg-current/10"
    >
      <PaperclipIcon className="size-4 shrink-0 opacity-80" />
      <span className="min-w-0 leading-tight">
        <span className="block truncate font-medium">{name}</span>
        {ext && <span className="block text-[10px] opacity-70">{ext} 文件</span>}
      </span>
    </a>
  )
}

// @某人 / @某人(备注) 着色（只在聊天记录卡里开：那里 @ 是「点名谁办」的关键信息）
const MENTION_RE = /(^|[\s(（【「])@([^\s@()（）【】「」,，。；;：:！!？?]{1,16}(?:[（(][^）)]{0,24}[）)])?)/g
function withMentions(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  MENTION_RE.lastIndex = 0
  let i = 0
  while ((m = MENTION_RE.exec(text))) {
    const at = m.index + m[1].length
    if (at > last) out.push(<Fragment key={`${keyBase}-mt${i}`}>{text.slice(last, at)}</Fragment>)
    out.push(
      <span key={`${keyBase}-m${i}`} className="font-medium text-primary">
        @{m[2]}
      </span>,
    )
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-mt${i}`}>{text.slice(last)}</Fragment>)
  return out
}

type ShotOpts = { mentions?: boolean; thumb?: 'sm' | 'md' }
// 一段纯文本里内联渲染 〖截图〗图片 与 [附件] 文件卡片 + 保留其余文字
function inlineShots(text: string, keyBase: string, opts: ShotOpts = {}): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  let i = 0
  const plain = (s: string, k: string) =>
    opts.mentions ? withMentions(s, k) : <Fragment key={k}>{s}</Fragment>
  let lastWasShot = false
  while ((m = TOKEN_RE.exec(text))) {
    if (m.index > last) {
      const gap = text.slice(last, m.index)
      // 连续几张截图之间只隔着换行（哨兵本来就是一行一个）——原样保留会让缩略图一张一行排成一竖列。
      // 图挨图时吞掉这段纯空白，让它们横着排成一排（放不下再自然折行）。
      const eat = m[1] != null && lastWasShot && /^\s*$/.test(gap)
      if (!eat) out.push(<Fragment key={`${keyBase}-t${i}`}>{plain(gap, `${keyBase}-t${i}`)}</Fragment>)
    }
    lastWasShot = m[1] != null
    if (m[1] != null) {
      const [path, name] = m[1].split('｜')
      // 截图走缩略图（点开落进可拖拽浮窗），不再原样铺一张大图把会话顶成一面墙
      out.push(
        <ShotThumb key={`${keyBase}-img${i}`} src={toUrl(path)} name={(name || '').trim()} size={opts.thumb} />,
      )
    } else {
      out.push(<FileChip key={`${keyBase}-f${i}`} k={`${keyBase}-f${i}`} name={(m[2] || '').trim()} path={(m[3] || '').trim()} />)
    }
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-t${i}`}>{plain(text.slice(last), `${keyBase}-t${i}`)}</Fragment>)
  return out
}

/* 聊天记录卡：解析成结构化会话（发言人 + 时间 + 正文/内联图），非标准格式回落原文。
   自带 card 表面 —— 它**不该**再吃所在气泡的底色：套在 bg-primary 用户气泡里时，原先的
   bg-muted/30 是半透明，紫色直接透上来，整张卡糊成一片紫（老板 08-31 反馈的正是这个）。
   短记录（≤4 条 / ≤2 图 / 正文 ≤400 字）默认展开——贴一段两句话的对话还要点一下才知道贴了
   什么，是白折；长记录仍折叠，避免霸屏。 */
function ChatlogBlock({ raw, k }: { raw: string; k: string }) {
  const p = parseChatlog(raw)
  const imgN = (raw.match(/〖截图〗/g) || []).length
  const bits = (
    p.format === 'raw'
      ? ['原文']
      : [`${p.meta.count} 条`, p.meta.participants.join('、'), p.meta.span]
  )
    .concat(imgN ? [`${imgN} 图`] : [])
    .filter(Boolean)
  const textLen =
    p.format === 'raw' ? p.raw.length : p.entries.reduce((n, en) => n + en.text.length, 0)
  const defaultOpen = (p.entries.length || 1) <= 4 && imgN <= 2 && textLen <= 400
  // 聊天记录卡本就是"一段对话的缩影"，图再用小一号的缩略图，一屏能看下更多条
  const thumb = 'sm' as const

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="w-full overflow-hidden rounded-xl border bg-card text-card-foreground"
    >
      <CollapsibleTrigger className="group/cl flex w-full items-center gap-2 px-2.5 py-2 text-start transition hover:bg-accent/50">
        <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <ChatTextIcon className="size-3.5" weight="fill" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
          <span className="shrink-0 text-xs font-semibold">聊天记录</span>
          <span className="truncate text-[11px] text-muted-foreground">{bits.join(' · ')}</span>
        </span>
        <CaretDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]/cl:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {p.format === 'raw' ? (
          <div className="border-t px-3 pt-2 pb-2.5 text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {inlineShots(p.raw, `${k}-cl`, { mentions: true, thumb })}
          </div>
        ) : (
          <div className="border-t px-3 pt-0.5 pb-2.5 text-xs">
            {p.entries.map((en, i) => {
              // 同一人连说：省掉重复的名字行，只贴紧上一条（微信/企微观感）
              const same = i > 0 && p.entries[i - 1].sender === en.sender
              return (
                <div key={i} className={cn('grid gap-0.5', same ? 'pt-1' : 'pt-2.5')}>
                  {!same && (
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-semibold text-foreground">{en.sender}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {[en.date, en.time].filter(Boolean).join(' ')}
                      </span>
                    </div>
                  )}
                  <div className="leading-relaxed break-words whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                    {inlineShots(en.text, `${k}-e${i}`, { mentions: true, thumb })}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

/* 正文拆成两段：气泡里的正文 + 气泡外的聊天记录卡。
   卡片留在紫气泡里是「画框套画框」，还要跟气泡的白字/底色打架 —— 用户消息那条路径把 cards
   提到气泡外自成一卡（见 transcript.tsx）；派工「查看原文」那种中性容器里则原地铺开即可。 */
export function splitUserMessage(text: string): { body: ReactNode | null; cards: ReactNode[] } {
  const parts: ReactNode[] = []
  const cards: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  CHATLOG_RE.lastIndex = 0
  let i = 0
  // 折叠块前后残留的纯空白（换行）在 pre-wrap 下会撑出巨大留白，需剔除
  const pushText = (slice: string) => {
    const t = slice.replace(/^\n+|\n+$/g, '')
    if (t.trim()) parts.push(<span key={`p${i}`} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{inlineShots(t, `u${i}`)}</span>)
  }
  while ((m = CHATLOG_RE.exec(text))) {
    if (m.index > last) pushText(text.slice(last, m.index))
    cards.push(<ChatlogBlock key={`cl${i}`} raw={m[1]} k={`c${i}`} />)
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) pushText(text.slice(last))
  const body = parts.length
    ? <div className="flex flex-col gap-1 [overflow-wrap:anywhere]">{parts}</div>
    : null
  return { body, cards }
}

/* 复制用的纯文本：剥掉只对引擎有意义的哨兵，留下人读得懂、粘出去能直接用的正文。
   为什么不直接读气泡的 innerText：气泡里有 <img>（截图会被吃成空串）、附件卡（只剩文件名）、
   markdown 渲染结果（列表符号/代码块装饰会被一起抄走）——抄回去的不是当初发出去的那段话。
   〘聊天记录〙只脱掉包裹标记、内容照留（那是真发出去的内容）；截图换成 [截图 文件名] 占位。 */
export function plainMessageText(text: string): string {
  return text
    .replace(/〘聊天记录〙([\s\S]*?)〘\/聊天记录〙/g, (_m, inner: string) => inner.trim())
    .replace(/〖截图〗([\s\S]*?)〖\/截图〗/g, (_m, spec: string) => {
      const name = (spec.split('｜')[1] || '').trim()
      return name ? `[截图 ${name}]` : '[截图]'
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 用户/回复消息内容（正文与聊天记录卡就地顺排）：派工「查看原文」等中性容器用
export function UserContent({ text }: { text: string }) {
  const { body, cards } = splitUserMessage(text)
  return (
    <div className="flex flex-col gap-1.5 [overflow-wrap:anywhere]">
      {body}
      {cards}
    </div>
  )
}

// 附件标记检测（用于折叠判断，可选）
export function AttachChip({ name, path }: { name: string; path: string }) {
  return (
    <a
      href={toUrl(path)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 text-xs"
    >
      <PaperclipIcon className="size-3" /> {name}
    </a>
  )
}
