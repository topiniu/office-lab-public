import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  LinkSimpleIcon,
  CodeIcon,
  ListChecksIcon,
  TableIcon,
  StepsIcon,
  RowsIcon,
  ImagesIcon,
  SealCheckIcon,
  QuestionIcon,
  CheckSquareIcon,
  BugIcon,
  ToggleLeftIcon,
  GavelIcon,
  CopyIcon,
  DownloadSimpleIcon,
  ArrowSquareOutIcon,
  FileTextIcon,
  FolderOpenIcon,
  ClipboardTextIcon,
  WarningIcon,
  CheckIcon,
  XIcon,
  SpinnerIcon,
  PaperclipIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  type Icon,
} from '@phosphor-icons/react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { ErrorBoundary } from '@/components/error-boundary'
import { useCardBatch, useSendHotkey } from '@/components/card-batch'
import { useFileViewer } from '@/components/file-viewer'
import { useImageViewer, viewInLab } from '@/components/image-viewer'
import { apiPost, ApiError } from '@/lib/api'
import { useAttachments, AttachmentBar } from '@/components/attachments'
import { Markdown } from '@/components/markdown'
import { cn } from '@/lib/utils'
import { normAction, parseSegments, type CardData, type Segment } from '@/lib/olcards'

export type CardCtx = {
  // 返回 false = 发送失败（如员工忙 409）→ 卡片不锁定、可重试
  onReply?: (text: string) => void | boolean | Promise<void | boolean>
  // gate「展开到底部输入框」：聚焦主组合器
  focusReply?: () => void
  runId?: string
  // Stable event occurrence for legacy Codex feedback cards with duplicated IDs.
  messageKey?: string
}
// 攒批（一轮多张待拍板卡凑齐一起发）不走 ctx，而是走 CardBatchProvider 的 React context
// —— 只有卡片自己会因暂存态变化而重渲染，不会连累整条 transcript（几百个事件+markdown）。

const ACTION_TYPES = new Set(['approval', 'decision', 'toggle', 'multiselect'])

/* 归组连贯（见 OLContent 的 joined）：一条消息里正文段与卡片要读成**一条**消息，靠的是
   「同宽 + 间距收紧 + 相邻圆角削平」。圆角得由外层按段的位置决定，但 Shell 深埋在
   OLCard 的十几个分支下面——prop 钻透要改每个分支，所以走一个只装 className 的 context：
   OLContent 逐段 Provider 一个值，Shell 直接消费。默认空串＝独立卡片，行为原样。 */
const ShellCorner = createContext('')

// 卡片级「补充意见」：拼进回复正文 / 给「已选择」标签打个记号
function withNote(text: string, note: string): string {
  const n = note.trim()
  return n ? `${text}\n【补充意见】${n}` : text
}
function noteLabel(label: string, note: string): string {
  return note.trim() ? `${label}（附意见）` : label
}

const ACTED_KEY = 'ol-card-acted'
function loadActed(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(ACTED_KEY) || '{}')
  } catch {
    return {}
  }
}
function saveActed(id: string, choice: string) {
  const m = loadActed()
  m[id] = choice
  localStorage.setItem(ACTED_KEY, JSON.stringify(m))
}
function clearActed(id: string) {
  // Empty receipt keeps this occurrence open across refresh, without falling
  // back to an older receipt stored under the duplicated legacy ID.
  saveActed(id, '')
}

// 类型 → 默认强调色 + 眉标兜底 + 图标（对齐旧 cards.js TYPE_META）
const TYPE_META: Record<string, { accent: string; eyebrow: string; icon: Icon }> = {
  link: { accent: 'accent', eyebrow: '链接', icon: LinkSimpleIcon },
  code: { accent: 'neutral', eyebrow: '代码', icon: CodeIcon },
  checklist: { accent: 'neutral', eyebrow: '清单', icon: ListChecksIcon },
  table: { accent: 'neutral', eyebrow: '明细', icon: TableIcon },
  stepper: { accent: 'accent', eyebrow: '进度', icon: StepsIcon },
  fields: { accent: 'neutral', eyebrow: '字段', icon: RowsIcon },
  gallery: { accent: 'neutral', eyebrow: '证据', icon: ImagesIcon },
  file: { accent: 'neutral', eyebrow: '文件', icon: FileTextIcon },
  approval: { accent: 'warn', eyebrow: '待放行', icon: SealCheckIcon },
  decision: { accent: 'warn', eyebrow: '待拍板', icon: QuestionIcon },
  multiselect: { accent: 'warn', eyebrow: '多选', icon: CheckSquareIcon },
  defect: { accent: 'danger', eyebrow: '缺陷单', icon: BugIcon },
  toggle: { accent: 'warn', eyebrow: '开关', icon: ToggleLeftIcon },
  gate: { accent: 'warn', eyebrow: '等你拍板', icon: GavelIcon },
}
// 带描边的强调色图标底片（对齐旧 UI olc-ic：底纹 + 同色描边，比纯填充更精致）
const ACCENT_CHIP: Record<string, string> = {
  accent: 'border-primary/25 bg-primary/10 text-primary',
  success: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warn: 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  danger: 'border-destructive/25 bg-destructive/10 text-destructive',
  neutral: 'border-border bg-muted text-muted-foreground',
}

// 状态归一（对齐旧 toneCls）
function tone(s: unknown): string {
  const m: Record<string, string> = {
    ok: 'ok', done: 'ok', success: 'ok', pending: 'pending', wait: 'pending',
    running: 'running', active: 'running', fail: 'fail', error: 'fail', danger: 'fail',
    warn: 'warn', skip: 'skip', neutral: '',
  }
  return m[String(s ?? '')] ?? String(s ?? '')
}
const TONE_CLS: Record<string, string> = {
  ok: 'text-emerald-500',
  fail: 'text-destructive',
  running: 'text-amber-500',
  warn: 'text-amber-500',
  skip: 'text-muted-foreground line-through',
  pending: 'text-muted-foreground',
}
const STATUS_LABEL: Record<string, string> = {
  running: '进行中', pending: '待处理', skip: '跳过', warn: '注意',
}
function StatusMark({ t }: { t: string }) {
  if (t === 'ok') return <CheckIcon className="size-3.5 text-emerald-500" />
  if (t === 'fail') return <XIcon className="size-3.5 text-destructive" />
  if (t === 'running') return <SpinnerIcon className="size-3.5 animate-spin text-amber-500" />
  return <span className="inline-block size-1.5 rounded-full bg-muted-foreground/40" />
}

// checklist 条目归一：label 缺省回落 text/title/name/content；status 缺省由 checked/done 推出
function normChecklistItem(raw: any): any {
  if (raw == null || typeof raw !== 'object') return { label: raw == null ? '' : String(raw) }
  const label = raw.label ?? raw.text ?? raw.title ?? raw.name ?? raw.content ?? ''
  const checked = raw.checked ?? raw.done
  const status = raw.status ?? (checked === true ? 'ok' : checked === false ? 'pending' : undefined)
  return { ...raw, label, status, hint: raw.hint ?? raw.desc ?? raw.note }
}
function arr<T = any>(x: unknown): T[] {
  return Array.isArray(x) ? (x as T[]) : []
}

function Shell({
  data,
  acted,
  staged,
  onUnstage,
  onReselect,
  children,
}: {
  data: CardData
  acted?: string | null
  // 已暂存待批量发送（未真正回发）——与「已处理」区分开，并给一个撤销出口
  staged?: boolean
  onUnstage?: () => void
  onReselect?: () => void
  children: React.ReactNode
}) {
  const meta = TYPE_META[data.type]
  const accentKey = data.accent || meta?.accent || 'neutral'
  const chip = ACCENT_CHIP[accentKey] ?? ACCENT_CHIP.neutral
  const TypeIcon = meta?.icon ?? RowsIcon
  const eyebrow = data.eyebrow || meta?.eyebrow
  const isAction = ACTION_TYPES.has(data.type)
  // 归组时由 OLContent 指定这张卡在栈里的圆角（Tailwind 里 rounded-t/b-* 的规则排在 rounded-* 之后，
  // 故 'rounded-xl rounded-t-none' 就是"上平下圆"，无需自己算四角）
  const corner = useContext(ShellCorner)
  return (
    <div data-olcard className={cn('min-w-0 rounded-xl border bg-card p-3.5 text-sm transition-colors hover:border-border', corner)}>
      <div className="flex items-start gap-2.5">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg border', chip)}>
          <TypeIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 pt-px">
          {eyebrow && <div className="text-[11px] font-medium tracking-wide text-muted-foreground">{eyebrow}</div>}
          {data.title && <div className="text-[13.5px] leading-snug font-semibold">{data.title}</div>}
          {data.subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{data.subtitle}</div>}
        </div>
        {isAction && (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
              staged
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : acted
                  ? 'border-border bg-muted text-muted-foreground'
                  : 'border-primary/30 bg-primary/10 text-primary',
            )}
          >
            {!acted && !staged && <span className="size-1.5 rounded-full bg-primary" />}
            {staged ? '待发送' : acted ? '已处理' : '待你处理'}
          </span>
        )}
      </div>
      {children != null && <div className="mt-3 min-w-0">{children}</div>}
      {data.note && <div className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{data.note}</div>}
      {acted && (
        <div
          className={cn(
            'mt-3 flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs',
            staged
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
          )}
        >
          <CheckIcon className="size-3.5 shrink-0" /> 已选择：<b className="text-foreground">{acted}</b>
          {!staged && onReselect && (
            <button type="button" onClick={onReselect} className="ms-auto shrink-0 underline-offset-2 hover:underline">
              重新选择
            </button>
          )}
          {staged && (
            <>
              <span className="ms-1 shrink-0 opacity-80">· 待与其它项一起发送</span>
              {onUnstage && (
                <button
                  type="button"
                  onClick={onUnstage}
                  className="ms-auto shrink-0 underline-offset-2 hover:underline"
                >
                  撤销
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function metaRow(meta?: { k: string; v: string }[]) {
  if (!meta?.length) return null
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {meta.map((m, i) => (
        <Badge key={i} variant="secondary" className="text-[11px]">
          {m.k}: {m.v}
        </Badge>
      ))}
    </div>
  )
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('已复制')
  } catch {
    toast.error('复制失败')
  }
}
function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function OLCard({ data, ctx }: { data: CardData; ctx: CardCtx }) {
  const baseCardId: string =
    (ctx.runId ? ctx.runId + ':' : '') +
    (data.id || `${data.type}:${(data.title || '') + (data.question || '')}`.slice(0, 80))
  const legacy = /^codex-feedback-null-null-\d+$/.test(String(data.id || ''))
  const cardId = legacy && ctx.messageKey ? `${baseCardId}:${ctx.messageKey}` : baseCardId
  const [acted, setActed] = useState<string | null>(() => {
    const saved = loadActed()
    return (saved[cardId] ?? (legacy ? saved[baseCardId] : null)) || null
  })
  const [note, setNote] = useState('')
  const batch = useCardBatch()
  const { openImage } = useImageViewer()
  const stagedItem = batch?.staged.find((s) => s.id === cardId) ?? null
  // Codex consumes one native question at a time, using the exact reply text.
  // Historical gates must not turn that answer into a combined batch envelope.
  const directFeedback = data.type === 'gate' && /^codex-feedback-/.test(String(data.id || ''))
  const isActionCard = ACTION_TYPES.has(data.type) || data.type === 'gate'

  // 向攒批器登记「本轮还有一张卡等你处理」——攒批与否要靠这个计数判（只剩一张就别攒、点了直接发）
  useEffect(() => {
    if (!isActionCard || directFeedback || acted || !batch) return
    return batch.registerAction(cardId)
  }, [isActionCard, directFeedback, acted, batch, cardId])

  // 返回是否真发出去了：调用方据此决定「要不要清掉自己的输入框」——发失败（如员工忙 409）时
  // 必须把用户打的字留住，不能连内容一起吞掉。
  async function reply(text: string, choiceLabel: string): Promise<boolean> {
    if (batch && !directFeedback && batch.shouldBatch()) {
      // 攒批：暂存，等攒批条「发送 N 项」一起发；成功后 markSent 落「已处理」
      batch.stage(
        { id: cardId, label: choiceLabel, reply: text, title: String(data.title || data.question || '') },
        () => {
          saveActed(cardId, choiceLabel)
          setActed(choiceLabel)
        },
      )
      return true
    }
    const r = await ctx.onReply?.(text)
    if (r === false) return false
    saveActed(cardId, choiceLabel)
    setActed(choiceLabel)
    return true
  }
  const done = acted ?? stagedItem?.label ?? null
  const disabled = done != null
  const staged = !acted && !!stagedItem
  const onUnstage = staged ? () => batch?.unstage(cardId) : undefined
  // 动作卡的公共外壳参数（含暂存态）
  // Recovery choices may be needed again after "later". Reopening only restores
  // controls; the user must submit a choice through the normal reply path.
  // Also covers persisted legacy cards that accidentally shared a feedback ID.
  const canReselect = directFeedback &&
    ['会话被另一端占用', '会话执行端被占用'].includes(String(data.title))
  const onReselect = acted && canReselect && ctx.onReply ? () => {
    clearActed(cardId)
    setActed(null)
  } : undefined
  const shell = { acted: done, staged, onUnstage, onReselect }
  // 「点选 → 确认」两步（2026-08-26 老板反馈改）。
  //
  // 旧模型是「**先**写意见、**再**点选项」：折叠的 NoteBox 展开成输入框后，唯一的发送出口是回头去点上面的
  // 选项——但那些选项在视觉上像是「已经走过的一步」，而输入框旁边最近的按钮是 OtherInput 的 ➤
  //（它只发自由文本、不带选项），于是用户写完意见后**找不到出口**。老板原话：「点击输入意见之后就没办法
  // 选择选项了」。DOM 上选项其实一直可点，但**没有任何指向它的发送提示** —— 这是可发现性的死胡同，
  // 不是禁用 bug。教训：把「必须先做 A 再做 B」的顺序藏在占位符文案里，等于没说。
  //
  // 新模型：点选项 = **选中**（不直接发）→ 出确认条（已选 X · ✎补充意见 · 发送 · 取消）→ 发送。
  // 意见框长在确认条里、紧挨发送按钮，顺序与直觉一致；想换选项直接点另一项，意见保留。
  const [pending, setPending] = useState<{ reply: string; label: string } | null>(null)
  const rp = (text: string, label: string) => setPending({ reply: text, label })
  // 即时发送（不经确认条）：给「以上都不是？直接补充」那条自由文本用。
  // 为什么它不走两步：**用户打完字按下 Enter，那一下本身就是确认**，再要一步纯属多余；
  // 而且确认条会把自由文本渲染成「已选 <你刚打的那句话>」，语义很怪（老板截图里就是这个样子）。
  const sendNow = async (text: string, label: string) => {
    const ok = await reply(withNote(text, note), noteLabel(label, note))
    if (ok) { setPending(null); setNote('') }
    return ok
  }
  const sendPending = async () => {
    if (!pending) return
    const ok = await reply(withNote(pending.reply, note), noteLabel(pending.label, note))
    if (ok) { setPending(null); setNote('') }
  }
  // 取消＝明确放弃这次选择，连意见一起清。刻意不"留着以防你再选"——
  // 那正是这轮 bug 的成因：看不见的残留状态会在下一次操作里冒出来咬人。
  const cancelPending = () => { setPending(null); setNote('') }

  switch (data.type) {
    case '__error__':
      return (
        <Shell data={{ type: 'error', title: '卡片解析失败', eyebrow: 'JSON 格式有误', accent: 'danger' }}>
          <div className="flex items-center gap-1.5 text-xs text-destructive">
            <WarningIcon className="size-3.5" /> {String((data as any).__error || 'JSON 解析失败')}
          </div>
          {(data as any).__raw && (
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap break-words">
              {(data as any).__raw}
            </pre>
          )}
        </Shell>
      )

    case 'link': {
      const links: { label: string; url: string; hint?: string }[] = arr(data.links).length
        ? data.links
        : data.url
          ? [{ label: data.buttonText || '打开', url: data.url, hint: data.subtitle }]
          : []
      return (
        <Shell data={data}>
          {metaRow(data.meta)}
          <div className="grid gap-1.5">
            {links.map((l, i) => (
              <a
                key={i}
                href={l.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded border px-2 py-1.5 text-sm hover:border-primary/50"
              >
                <ArrowSquareOutIcon className="size-4 shrink-0 text-primary" />
                <span className="font-medium">{l.label || l.url}</span>
                {l.hint && <span className="ms-auto text-xs text-muted-foreground">{l.hint}</span>}
              </a>
            ))}
          </div>
        </Shell>
      )
    }

    case 'code': {
      const content = String(
        [data.content, data.code, data.sql, data.text, data.body].find(
          (v) => typeof v === 'string' && v !== '',
        ) ?? '',
      )
      const empty = !content.trim()
      const lang = data.lang || (data.filename ? String(data.filename).split('.').pop() : '')
      return (
        <Shell data={data}>
          {empty ? (
            <div className="rounded-lg border bg-muted/50 p-2.5 text-xs text-muted-foreground italic">
              {data.emptyHint || '（无内容）'}
            </div>
          ) : (
            // 代码/SQL 不折行（折了就读不懂缩进），但**纯文本**要折：发布通知话术里是两条很长的 MR
            // URL，不折行就只剩一条横向滚动条、一个链接都看不全——而这张卡的用途恰恰是「转发前扫一眼
            // 对不对」。`wrap` 可显式覆盖。
            <pre
              className={cn(
                'max-h-80 min-w-0 overflow-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs/relaxed',
                (data.wrap ?? String(lang).toLowerCase() === 'text')
                  ? 'whitespace-pre-wrap [overflow-wrap:anywhere]'   // URL 没有空格，只有 anywhere 断得开
                  : 'whitespace-pre',
              )}
            >
              {content}
            </pre>
          )}
          {(lang || data.filename || (!empty && data.copy !== false)) && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              {lang && <span className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-wide uppercase">{lang}</span>}
              {data.filename && <span className="truncate font-mono">{data.filename}</span>}
              <span className="ms-auto flex shrink-0 gap-2">
                {!empty && data.copy !== false && (
                  <Button size="sm" variant="outline" onClick={() => copyText(content)}>
                    <CopyIcon /> 复制
                  </Button>
                )}
                {!empty && data.download && data.filename && (
                  <Button size="sm" variant="outline" onClick={() => download(data.filename, content)}>
                    <DownloadSimpleIcon /> 下载
                  </Button>
                )}
              </span>
            </div>
          )}
        </Shell>
      )
    }

    case 'checklist':
      return (
        <Shell data={data}>
          <div className="grid gap-1.5">
            {arr(data.items).map((raw: any, i: number) => {
              // 容错：员工常按通用 todo 习惯写 {text,checked} 或纯字符串，别静默渲染成空圆点
              const it = normChecklistItem(raw)
              const t = tone(it.status)
              const badge = it.badge || STATUS_LABEL[t] || ''
              return (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5">
                    <StatusMark t={t} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={cn(t === 'skip' && 'text-muted-foreground line-through')}>{it.label}</div>
                    {it.hint && <div className="text-xs text-muted-foreground">{it.hint}</div>}
                  </div>
                  {badge && (
                    <Badge variant="outline" className={cn('shrink-0 text-[10px]', TONE_CLS[t])}>
                      {badge}
                    </Badge>
                  )}
                </div>
              )
            })}
          </div>
        </Shell>
      )

    case 'table':
      return (
        <Shell data={data}>
          <div className="overflow-auto">
            <table className="w-full text-xs">
              {arr(data.columns).length > 0 && (
                <thead>
                  <tr className="border-b text-muted-foreground">
                    {data.columns.map((c: string, i: number) => (
                      <th key={i} className="px-2 py-1 text-start font-medium">{c}</th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {arr(data.rows).map((row: any, ri: number) => (
                  <tr key={ri} className="border-b last:border-0">
                    {(Array.isArray(row) ? row : [row]).map((cell: any, ci: number) => {
                      const v = typeof cell === 'object' && cell ? cell.v : cell
                      const tn = typeof cell === 'object' && cell ? tone(cell.tone) : ''
                      return <td key={ci} className={cn('px-2 py-1', TONE_CLS[tn])}>{v}</td>
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Shell>
      )

    case 'stepper':
      return (
        <Shell data={data}>
          <div className="grid gap-2">
            {arr(data.steps).map((s: any, i: number) => {
              const t = tone(s.status)
              return (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 grid size-4 place-items-center">
                    {t === 'ok' || t === 'fail' || t === 'running' ? (
                      <StatusMark t={t} />
                    ) : (
                      <span className="text-[10px] text-muted-foreground">{i + 1}</span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className={cn(t === 'running' && 'font-medium text-amber-500')}>{s.label}</div>
                    {s.hint && <div className="text-xs text-muted-foreground">{s.hint}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </Shell>
      )

    case 'fields': {
      const groups: Record<string, any>[] = arr(data.groups).length
        ? data.groups
        : data.fields && typeof data.fields === 'object'
          ? [data.fields]
          : []
      return (
        <Shell data={data}>
          <div className="grid gap-2">
            {groups.map((g, i) => (
              <dl key={i} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded border p-2 text-xs">
                {Object.entries(g).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-medium break-words">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            ))}
          </div>
        </Shell>
      )
    }

    case 'gallery':
      return (
        <Shell data={data}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {arr(data.images).map((img: any, i: number) => {
              const src = imgSrc(typeof img === 'string' ? img : img?.src)
              const caption = typeof img === 'object' ? img?.caption : ''
              return (
                <a key={i} href={src} target="_blank" rel="noreferrer" onClick={viewInLab(openImage, src, caption || '')} className="grid cursor-zoom-in gap-1">
                  <img src={src} alt={caption || ''} loading="lazy" className="aspect-video w-full rounded border object-cover" />
                  {caption && <span className="truncate text-[11px] text-muted-foreground">{caption}</span>}
                </a>
              )
            })}
          </div>
        </Shell>
      )

    // 文件卡：交付物直接可取（预览 / 复制文件 / 打开所在文件夹 / 下载），不必再开文件管理器翻目录
    case 'file':
      return (
        <Shell data={data}>
          <FileList files={arr(data.files).length ? data.files : arr(data.items)} />
        </Shell>
      )

    // ---- 动作卡 ----
    case 'approval': {
      const approve = normAction(data.approve, { label: '批准执行', reply: '✅ 已批准，请执行上述动作' })!
      const reject = normAction(data.reject, { label: '暂缓', reply: '⛔ 暂缓，先不要执行' })!
      return (
        <Shell data={data} {...shell}>
          {arr(data.items).length > 0 && (
            <div className="mb-3 grid divide-y overflow-hidden rounded-lg border">
              {data.items.map((it: any, i: number) => (
                <div key={i} className="flex items-start gap-2.5 px-3 py-2 text-sm">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60" />
                  <div className="min-w-0">
                    <div className="leading-relaxed">{it.label || it}</div>
                    {it.hint && <div className="text-xs text-muted-foreground">{it.hint}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
          {!done && (
            <>
              <div className="mt-2 flex flex-wrap justify-end gap-2">
                <Button size="sm" disabled={disabled} onClick={() => rp(approve.reply, approve.label)}>
                  <CheckIcon /> {approve.label}
                </Button>
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => rp(reject.reply, reject.label)}>
                  {reject.label}
                </Button>
              </div>
              {pending && (
                <ChoiceConfirm label={pending.label} note={note} onNote={setNote} onSend={sendPending} onCancel={cancelPending} />
              )}
            </>
          )}
        </Shell>
      )
    }

    case 'decision':
      return (
        <Shell data={data} {...shell}>
          {data.question && <p className="mb-2 text-sm text-muted-foreground">{data.question}</p>}
          {!done && (
            <>
              <div className="grid gap-1.5">
                {arr(data.options).map((o: any, i: number) => {
                  const obj = typeof o === 'object' && o ? o : {}
                  const a = normAction(o, { label: obj.label, reply: obj.reply || obj.label || `决定：${obj.label ?? o}` })!
                  const on = pending?.label === a.label
                  return (
                    <button
                      key={i}
                      disabled={disabled}
                      onClick={() => rp(a.reply, a.label)}
                      className={cn(
                        'flex items-center gap-2 rounded border px-2 py-1.5 text-start text-sm hover:border-primary/50 disabled:opacity-50',
                        on && 'border-primary bg-primary/10',
                      )}
                    >
                      {on && <CheckIcon className="size-3.5 shrink-0 text-primary" weight="bold" />}
                      <span className="font-medium">{a.label}</span>
                      {obj.recommended && <Badge className="text-[10px]">建议</Badge>}
                      {obj.desc && <span className="ms-auto text-xs text-muted-foreground">{obj.desc}</span>}
                    </button>
                  )
                })}
              </div>
              {pending && (
                <ChoiceConfirm label={pending.label} note={note} onNote={setNote} onSend={sendPending} onCancel={cancelPending} />
              )}
              {data.other !== false && (
                <OtherInput
                  placeholder={data.otherPlaceholder || '以上都不是？直接补充…（Enter 发送）'}
                  onSend={(t) => sendNow(t, t.slice(0, 18))}
                />
              )}
            </>
          )}
        </Shell>
      )

    case 'multiselect':
      return (
        <MultiSelectCard
          data={data}
          shell={shell}
          disabled={disabled}
          note={note}
          onNote={setNote}
          onReply={reply}
        />
      )

    case 'defect': {
      const sev = String(data.severity || '').toUpperCase()
      return (
        <Shell data={data} {...shell}>
          <div className="mb-2 flex items-center gap-2">
            {sev && <Badge variant={sev === 'P0' ? 'destructive' : 'default'}>{sev}</Badge>}
            {data.status && (
              <Badge variant={/red/i.test(data.status) ? 'destructive' : 'secondary'}>{data.status}</Badge>
            )}
            {data.id && <span className="font-mono text-xs text-muted-foreground">#{data.id}</span>}
          </div>
          {data.desc && <p className="mb-2 text-sm whitespace-pre-wrap">{data.desc}</p>}
          {!done && arr(data.actions).length > 0 && (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.actions.map((ac: any, i: number) => {
                  const a = normAction(ac)!
                  return (
                    <Button
                      key={i}
                      size="sm"
                      variant={pending?.label === a.label ? 'default' : 'outline'}
                      disabled={disabled}
                      onClick={() => rp(a.reply, a.label)}
                    >
                      {a.label}
                    </Button>
                  )
                })}
              </div>
              {pending && (
                <ChoiceConfirm label={pending.label} note={note} onNote={setNote} onSend={sendPending} onCancel={cancelPending} />
              )}
            </>
          )}
        </Shell>
      )
    }

    case 'toggle': {
      const on = normAction(data.on, { label: '确认', reply: '确认' })!
      const off = normAction(data.off, { label: '暂不', reply: '暂不' })!
      return (
        <Shell data={data} {...shell}>
          {data.question && <p className="mb-2 text-sm text-muted-foreground">{data.question}</p>}
          {!done && (
            <>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant={pending?.label === on.label ? 'default' : 'secondary'} disabled={disabled} onClick={() => rp(on.reply, on.label)}>
                  <ToggleLeftIcon /> {on.label}
                </Button>
                <Button size="sm" variant={pending?.label === off.label ? 'default' : 'outline'} disabled={disabled} onClick={() => rp(off.reply, off.label)}>
                  {off.label}
                </Button>
              </div>
              {pending && (
                <ChoiceConfirm label={pending.label} note={note} onNote={setNote} onSend={sendPending} onCancel={cancelPending} />
              )}
            </>
          )}
        </Shell>
      )
    }

    case 'gate':
      return <GateCard data={data} shell={shell} onReply={reply} focusReply={ctx.focusReply} />

    default:
      return (
        <Shell data={{ ...data, title: data.title || `未知卡片：${data.type}`, eyebrow: '未知卡片' }}>
          <div className="text-xs text-muted-foreground">不支持的卡片类型</div>
        </Shell>
      )
  }
}

// 动作卡外壳的公共参数（含暂存态与撤销出口）
type ShellState = { acted: string | null; staged: boolean; onUnstage?: () => void; onReselect?: () => void }

/* ---------- file 卡：把交付物从「一行路径文字」变成可直接取走的文件 ---------- */

// 「复制文件 / 打开文件夹」发生在**引擎宿主机**上：手机经隧道点了，弹出的窗口在办公室那台机器上，
// 剪贴板也写在那边——对点的人毫无意义。所以远程直接把这两个按钮禁掉，只留「下载」。
// 服务端 /api/reveal 另有一道 403（见 app/reveal.js isLocalRequest），这里是前置的可见性，不是唯一防线。
function isLocalBrowser(): boolean {
  const h = typeof location !== 'undefined' ? location.hostname : ''
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
}

type CardFile = { path: string; label?: string; hint?: string }

function FileList({ files }: { files: (CardFile | string)[] }) {
  const { openFile } = useFileViewer()
  const local = isLocalBrowser()
  const [busy, setBusy] = useState('')

  async function hostAction(p: string, action: 'reveal' | 'clipboard') {
    setBusy(p + action)
    try {
      await apiPost('/api/reveal', { path: p, action })
      toast.success(action === 'clipboard' ? '文件已进剪贴板 —— 去企微直接 Ctrl+V' : '已在文件管理器里选中')
    } catch (e) {
      const err = e as ApiError
      if (err?.status === 403) toast.error('这两个按钮只能在跑 office-lab 的那台机器上点，远程请用「下载」')
      else if (err?.status === 404) toast.error(`文件不存在：${p}`)
      else if (err?.status === 501) toast.error('当前系统不支持这个动作')
      else toast.error('操作失败：' + String((err as Error)?.message || err))
    } finally {
      setBusy('')
    }
  }

  const rows = files.map((f) => (typeof f === 'string' ? { path: f } : f)).filter((f) => f && f.path)
  if (!rows.length) return <div className="text-xs text-muted-foreground italic">（没有列出文件）</div>

  // ⚠ 容器与每一行都要 `min-w-0`：grid/flex 子项的自动最小尺寸是 **max-content**，不写它，
  //   行里那条长路径就把整张卡顶宽、连带越出聊天窗右边缘，里面的 `truncate` 一个都不生效
  //   （本仓第四次踩：§3.72 / §3.88 / §3.99 / §3.121 —— 「写了 truncate 却没生效先查外层能不能收缩」）。
  return (
    <div className="grid min-w-0 gap-1.5">
      {rows.map((f, i) => {
        // 员工写的路径盘上是反斜杠也认（/api/file 的 resolveRepoFile 两种都能解），统一成正斜杠只是为了好看
        const p = String(f.path).replace(/\\/g, '/')
        const name = f.label || p.split('/').pop() || p
        return (
          <div key={i} className="flex min-w-0 items-center gap-2 rounded border px-2 py-1.5 transition-colors hover:border-primary/50">
            <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
            <button
              type="button"
              onClick={() => openFile(p)}
              title={`预览 ${p}`}
              className="min-w-0 flex-1 text-start"
            >
              <span className="block truncate text-sm font-medium">{name}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{f.hint ? `${f.hint} · ${p}` : p}</span>
            </button>
            <span className="flex shrink-0 items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={!local || busy === p + 'clipboard'}
                title={local ? '复制文件（企微里 Ctrl+V 直接粘成附件）' : '仅本机浏览器可用'}
                aria-label="复制文件"
                onClick={() => hostAction(p, 'clipboard')}
              >
                <ClipboardTextIcon />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                disabled={!local || busy === p + 'reveal'}
                title={local ? '在文件管理器里打开所在文件夹并选中' : '仅本机浏览器可用'}
                aria-label="打开所在文件夹"
                onClick={() => hostAction(p, 'reveal')}
              >
                <FolderOpenIcon />
              </Button>
              {/* 下载走原生 <a download>：手机/远程也能取件，且不吃前面那道本机限制 */}
              <a
                href={`/api/file?download=1&path=${encodeURIComponent(p)}`}
                download
                title="下载"
                aria-label="下载"
                className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <DownloadSimpleIcon className="size-4" />
              </a>
            </span>
          </div>
        )
      })}
    </div>
  )
}

// 卡片级「补充意见」：默认收成一行，点开写字。写了之后**任何一个选项**的回复都会带上它
// —— 老板反馈「很多情况是需要手动输入意见 + 选择」，而 approval/decision/toggle/defect 原来
// 只有按钮、没有输入位，只能"要么点选项、要么另发一条文字"，意见和决策对不上号。
function NoteBox({
  value,
  onChange,
  label = '补充意见',
}: {
  value: string
  onChange: (v: string) => void
  label?: string
}) {
  const [open, setOpen] = useState(false)
  if (!open && !value)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <PencilSimpleIcon className="size-3" /> + {label}
      </button>
    )
  return (
    <Textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={`${label}（会随你选的那一项一起发出）…`}
      autoFocus={open}
      className="mt-2 max-h-28 min-h-9 resize-none bg-muted/20 text-xs"
    />
  )
}

// 选中待确认条：点了某一项之后出现，紧贴在选项下方。
// 三件事都在一行手边：**改主意**（直接点别的选项，意见保留）/ **补意见**（✎ 就地展开）/ **发送**。
// 为什么把意见框放在这里而不是选项上方：写意见的下一步一定是「发出去」，发送按钮就该在它旁边——
// 旧版把意见框放在选项与 OtherInput 之间，写完之后离它最近的按钮是「发自由文本」的 ➤，指错了路。
function ChoiceConfirm({
  label,
  note,
  onNote,
  onSend,
  onCancel,
}: {
  label: string
  note: string
  onNote: (v: string) => void
  onSend: () => void
  onCancel: () => void
}) {
  const [editing, setEditing] = useState(false)
  const showNote = editing || !!note
  const rootRef = useRef<HTMLDivElement>(null)
  // Ctrl/⌘+Enter 发送：确认条在就生效（点完选项焦点还在选项按钮上，不必先点开意见框）。
  // 同一聊天窗里同时挂着多张确认条时，只认焦点在本卡内的按键，免得一下把几张卡全发出去。
  useSendHotkey(rootRef, onSend, {
    ownInput: '[data-choice-note]',
    accept: (t, root) => {
      if (root.querySelectorAll('[data-choice-confirm]').length <= 1) return true
      const card = rootRef.current?.closest('[data-olcard]')
      return !!t && !!card && card.contains(t)
    },
  })
  return (
    <div ref={rootRef} data-choice-confirm className="mt-2 rounded-lg border border-primary/40 bg-primary/5 p-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <CheckIcon className="size-3.5 shrink-0 text-primary" weight="bold" />
        <span className="min-w-0 truncate">
          已选 <span className="font-medium">{label}</span>
        </span>
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {!showNote && (
            <Button size="sm" variant="ghost" className="h-8 gap-1 px-2 text-[11px] md:h-7" onClick={() => setEditing(true)}>
              <PencilSimpleIcon className="size-3" /> 补充意见
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-8 px-2 text-[11px] text-muted-foreground md:h-7" onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" className="h-8 gap-1 px-2.5 text-[11px] md:h-7" onClick={onSend}>
            <PaperPlaneRightIcon weight="fill" className="size-3" /> 发送
          </Button>
        </div>
      </div>
      {showNote && (
        <Textarea
          value={note}
          onChange={(e) => onNote(e.target.value)}
          autoFocus={editing}
          placeholder="补充意见（随这一项一起发出）…　Ctrl/⌘+Enter 发送"
          className="mt-2 max-h-28 min-h-9 resize-none bg-background/60 text-xs"
          // 意见框里 Enter 要能换行（意见常有多行），所以发送用 Ctrl/⌘+Enter——由上面的窗口级监听统一处理
          data-choice-note
        />
      )}
      <div className="mt-1.5 text-[10px] text-muted-foreground">想换一项？直接点上面别的选项，写好的意见会留着。Ctrl/⌘+Enter 直接发送。</div>
    </div>
  )
}

// 「以上都不是？直接补充」自由文本框。
// ⚠ 发出去之后**必须自己清空**：它以前不清，靠的是「发送即整块 !done 卸载、残留跟着一起消失」这个
//   隐含假设——卡片改成「点选→确认」两步后卡片会留在原地，于是上次打的字就明晃晃留在框里
//   （老板反馈「填完意见确定后输入框还残留上次填写的内容」）。**别把清理托付给卸载。**
// 只在真发出去后才清（`onSend` 返回 false = 员工忙 409 之类），失败时把用户打的字留住。
function OtherInput({ placeholder, onSend }: { placeholder: string; onSend: (t: string) => boolean | Promise<boolean> }) {
  const [v, setV] = useState('')
  const [sending, setSending] = useState(false)
  async function fire() {
    const t = v.trim()
    if (!t || sending) return
    setSending(true)
    try {
      const ok = await onSend(t)
      if (ok !== false) setV('')
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="mt-2 rounded-lg border bg-muted/20 transition-colors focus-within:border-primary/50 focus-within:bg-muted/30">
      <Textarea
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        className="max-h-32 min-h-9 resize-none border-0 bg-transparent px-2.5 py-2 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void fire()
          }
        }}
      />
      <div className="flex justify-end px-1.5 pb-1.5">
        <Button size="icon" className="size-9 md:size-7" disabled={!v.trim() || sending} onClick={() => void fire()} aria-label="发送">
          <PaperPlaneRightIcon weight="fill" />
        </Button>
      </div>
    </div>
  )
}

function MultiSelectCard({
  data,
  shell,
  disabled,
  note,
  onNote,
  onReply,
}: {
  data: CardData
  shell: ShellState
  disabled: boolean
  note: string
  onNote: (v: string) => void
  onReply: (text: string, label: string) => void
}) {
  const opts: any[] = arr(data.options)
  const [checked, setChecked] = useState<boolean[]>(() => opts.map((o) => !!(typeof o === 'object' && o?.checked)))
  const min = Number.isFinite(data.min) ? data.min : 1
  const count = checked.filter(Boolean).length
  function submit() {
    const picked = opts.filter((_, i) => checked[i])
    const labels = picked.map((o) => (typeof o === 'object' ? o.label : String(o)))
    const prefix = data.replyPrefix || (data.question ? data.question + '\n' : '已选择：\n')
    const body = prefix + picked.map((o) => `- ${(typeof o === 'object' ? o.reply || o.label : o)}`).join('\n')
    onReply(withNote(body, note), noteLabel(labels.join('、'), note))
  }
  return (
    <Shell data={data} {...shell}>
      {data.question && <p className="mb-2 text-sm text-muted-foreground">{data.question}</p>}
      {!shell.acted && (
        <>
          <div className="grid gap-1.5">
            {opts.map((o, i) => {
              const obj = typeof o === 'object' && o ? o : { label: String(o) }
              return (
                <label key={i} className="flex items-start gap-2 rounded border px-2 py-1.5 text-sm">
                  <Checkbox
                    checked={checked[i]}
                    disabled={disabled}
                    onCheckedChange={(c) => setChecked((prev) => prev.map((v, j) => (j === i ? !!c : v)))}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">{obj.label}</span>
                    {obj.desc && <span className="ms-2 text-xs text-muted-foreground">{obj.desc}</span>}
                  </span>
                </label>
              )
            })}
          </div>
          <NoteBox value={note} onChange={onNote} />
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {count ? `已选 ${count} 项` : min > 1 ? `至少选 ${min} 项` : '未选'}
            </span>
            <Button size="sm" className="ms-auto" disabled={disabled || count < min} onClick={submit}>
              {data.submitLabel || '确认所选'}
            </Button>
          </div>
        </>
      )}
    </Shell>
  )
}

// gate：快捷选项 + 内联输入（文本 + 图片/文件附件 + 缩略图）
function GateCard({
  data,
  shell,
  onReply,
  focusReply,
}: {
  data: CardData
  shell: ShellState
  // 返回是否真发出去了 —— 决定要不要清输入框与附件（见 send/pick 里的注释）
  onReply: (text: string, label: string) => Promise<boolean> | boolean
  focusReply?: () => void
}) {
  const [v, setV] = useState('')
  const attach = useAttachments()
  const accept: string[] = Array.isArray(data.accept) ? data.accept : ['text', 'image']
  const canFile = accept.includes('image') || accept.includes('file')

  // ⚠ 清输入框/附件**必须等发送真的成功**。原来是无条件清：碰上员工忙 409（onReply 返回 false）
  //   就把用户打的字和贴的图一起吞掉、人得从头再来。与 OtherInput 那处是同一类毛病，一起收口。
  async function send() {
    if (attach.busy) {
      toast.info('附件上传中，稍等一下再发')
      return
    }
    const text = v.trim()
    if (!text && !attach.items.length) return
    const parts = [text || '（见附件）', attach.markers()].filter(Boolean)
    const ok = await onReply(parts.join('\n\n'), text ? text.slice(0, 20) : '已发送附件')
    if (ok === false) return
    setV('')
    attach.clear()
  }

  // 快捷选项也要带上已经写好的意见与附件 —— 原来点快捷项直接只发选项文案，
  // 用户在输入框里敲的字和贴的图**被静默丢掉**（gate 卡本就是「选项 + 自由输入」并存的卡型）。
  async function pick(label: string, replyText: string) {
    const text = v.trim()
    const parts = [replyText, text && `【补充意见】${text}`, attach.markers()].filter(Boolean)
    const ok = await onReply(parts.join('\n'), text || attach.items.length ? `${label}（附意见）` : label)
    if (ok === false) return
    setV('')
    attach.clear()
  }

  return (
    <Shell data={data} {...shell}>
      {data.question && <p className="mb-2 text-sm text-muted-foreground">{data.question}</p>}
      {!shell.acted && (
        <>
          {arr(data.options).length > 0 && (
            <div className="mb-2 grid gap-1.5">
              {data.options.map((o: any, i: number) => {
                const a = normAction(o, { label: typeof o === 'object' ? o.label : String(o), reply: typeof o === 'object' ? o.reply || o.label : String(o) })!
                return (
                  <Button key={i} size="sm" variant="outline" onClick={() => pick(a.label, a.reply)}>
                    {a.label}
                  </Button>
                )
              })}
            </div>
          )}
          <AttachmentBar
            items={attach.items}
            onRemove={attach.remove}
            onInline={(text, i) => {
              attach.remove(i)
              setV((r) => (r ? `${r}\n${text}` : text))
            }}
            className="mb-1.5"
          />
          <div className="rounded-lg border bg-muted/20 transition-colors focus-within:border-primary/50 focus-within:bg-muted/30">
            <Textarea
              value={v}
              onChange={(e) => setV(e.target.value)}
              placeholder={data.placeholder || '输入你的拍板意见…（可贴图/附件，Enter 发送）'}
              className="max-h-40 min-h-[52px] resize-none border-0 bg-transparent px-2.5 py-2 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
              onPaste={attach.onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            <div className="flex items-center gap-1 px-1.5 pb-1.5">
              {canFile && (
                <label className="grid size-9 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:size-7">
                  <PaperclipIcon className="size-4" />
                  <input
                    type="file"
                    multiple
                    hidden
                    accept={accept.includes('image') && !accept.includes('file') ? 'image/*' : undefined}
                    onChange={(e) => {
                      attach.addFiles(e.target.files)
                      e.target.value = ''
                    }}
                  />
                </label>
              )}
              {focusReply && (
                <button
                  type="button"
                  onClick={focusReply}
                  className="text-[11px] text-muted-foreground hover:text-foreground"
                >
                  底部展开 ↗
                </button>
              )}
              <Button
                size="icon"
                className="ms-auto size-9 md:size-7"
                disabled={!v.trim() && !attach.items.length}
                onClick={send}
                aria-label="发送"
              >
                <PaperPlaneRightIcon weight="fill" />
              </Button>
            </div>
          </div>
        </>
      )}
    </Shell>
  )
}

// OLCard + 错误边界：单张卡渲染出错只降级成一张错误提示卡，不连累整棵树。
export function SafeOLCard({ data, ctx }: { data: CardData; ctx: CardCtx }) {
  return (
    <ErrorBoundary
      fallback={() => (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          卡片渲染失败（type: {String(data?.type)}）
        </div>
      )}
    >
      <OLCard data={data} ctx={ctx} />
    </ErrorBoundary>
  )
}

// 渲染一段文本里的所有 md/card 段。
// wrapMd：给 md 段套外壳（员工侧传气泡）——**卡片在气泡外、正文仍在气泡里**是旧 UI 就定下的口径
// （旧 app.js renderEmpText：card 段 → cardRow，md 段 → msgRow 进 .bubble emp）。React 版迁移时
// 这里一度对 md 段直接裸渲染，结果「带卡的消息」正文没气泡也没复制按钮、和纯文字消息两副长相
// （老板 2026-09-02 截图）。不传 wrapMd 就是裸 markdown（卡片本身不该套气泡，见 §3.9x）。
// 画廊图片地址：员工给的多是仓内相对路径（docs/…/预检截图/x.png，偶尔带盘符或反斜杠），直接塞 <img src>
// 会按页面 URL 相对解析 → 404 裂图（老板 2026-09-29 截图）。只有 http(s)/data/blob/站内绝对路径原样用，
// 其余一律走 /api/file?raw=1（按真实 MIME 内联返回，同文件预览弹层的看图口径）。
function imgSrc(src: unknown): string {
  const s = String(src ?? '').trim()
  if (!s || /^(https?:|data:|blob:)/i.test(s) || (s.startsWith('/') && !s.startsWith('//'))) return s
  return `/api/file?raw=1&path=${encodeURIComponent(s.replace(/\\/g, '/'))}`
}

// 卡片沉底（老板 2026-09-29 定）：正文与卡片混排时，正文段合成一段在上、卡片按原顺序排到最下面。
// 原先按员工书写顺序「文 / 卡 / 文 / 卡」交错，窄气泡夹在满宽卡片之间，读着比例失重。
function cardsLast(segs: Segment[]): Segment[] {
  const md = segs.filter((s) => s.kind === 'md').map((s) => (s as { text: string }).text)
  const cards = segs.filter((s) => s.kind === 'card')
  if (!md.length || !cards.length) return segs
  return [{ kind: 'md', text: md.join('\n\n') }, ...cards]
}

export function OLContent({
  text,
  ctx,
  wrapMd,
  joined,
  className,
}: {
  text: string
  ctx: CardCtx
  wrapMd?: (mdText: string, cornerClass?: string) => React.ReactNode
  // 归组连贯（老板 2026-09-07 定）：正文段与卡片**左右同宽 + 间距 2px + 相邻圆角削平**，
  // 一条消息读成一条消息，而不是「气泡 / 卡 / 气泡」三条各自为政（宽窄参差最出戏）。
  // 卡片仍不套气泡（09-02 的「画框套画框」口径不变），只是把边界连起来。
  joined?: boolean
  className?: string
}) {
  const segs = cardsLast(parseSegments(text))
  // 只有一段时不必归组（就是一张卡或一段话，原样最好看）
  const corner = (i: number) =>
    joined && segs.length > 1
      ? cn('rounded-xl', i > 0 && 'rounded-t-none', i < segs.length - 1 && 'rounded-b-none')
      : undefined
  return (
    // grid-cols-[minmax(0,1fr)]：容器上的 min-w-0 **管不了轨道**——隐式 auto 轨道的最小尺寸取自
    // 子项的 min-content，任一子项忘了 min-w-0（或塞进不换行的 <pre>/宽表格）就会把整列顶宽、被外层裁掉。
    // 显式把唯一那条轨道钉成 minmax(0,1fr)，从结构上让「子项撑宽整列」不可能发生（这层装的是任意
    // markdown 段 + 各种卡片，最容易漏）。见 §3.88。
    <div
      className={cn(
        'grid min-w-0 grid-cols-[minmax(0,1fr)]',
        joined ? 'gap-[2px]' : 'gap-2',
        className,
      )}
    >
      {segs.map((s, i) =>
        s.kind === 'md' ? (
          wrapMd ? (
            <div key={i} className="min-w-0">{wrapMd(s.text, corner(i))}</div>
          ) : (
            <Markdown key={i}>{s.text}</Markdown>
          )
        ) : (
          <ShellCorner.Provider key={i} value={corner(i) ?? ''}>
            <SafeOLCard data={s.data} ctx={ctx} />
          </ShellCorner.Provider>
        ),
      )}
    </div>
  )
}
