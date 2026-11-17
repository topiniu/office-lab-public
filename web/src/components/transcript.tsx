import { memo, useMemo, useState, type ReactNode } from 'react'
import { WrenchIcon, BrainIcon, XCircleIcon, CaretRightIcon, WarningIcon, ArrowSquareOutIcon } from '@phosphor-icons/react'

import type { RunEvent } from '@/hooks/use-run-stream'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Badge } from '@/components/ui/badge'
import { EmployeeAvatar } from '@/components/employee-avatar'
import { useEmployees } from '@/hooks/use-employees'
import { cn } from '@/lib/utils'
import { SafeOLCard, OLContent, type CardCtx } from '@/components/olcard'
import { hasActionCard, hasCard, parseGateMarker } from '@/lib/olcards'
import { Markdown } from '@/components/markdown'
import { UserContent, splitUserMessage, plainMessageText } from '@/components/message-content'
import { stripLeakedInvokes, isSdkParseNoise } from '@/lib/leaked-invoke'
import { CopyMessage } from '@/components/copy-message'
import { stripDispatchNoise, dispatchLead, ccFrom } from '@/lib/dispatch'
import { Bubble as UIBubble, BubbleContent } from '@/components/ui/bubble'
import { useRunDetail } from '@/components/run-detail-provider'
import { SystemNoticeCard } from '@/components/system-notice-card'
import { parseSystemNotice } from '@/lib/system-notice'

type Block = { type: string; [k: string]: any }
type ToolResult = { content: unknown; is_error?: boolean; ts?: string }

function toBlocks(content: unknown): Block[] {
  if (!content) return []
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content as Block[]
  return [content as Block]
}
function stringify(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
function fmtDur(ms: number): string {
  if (ms <= 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}
function dayLabel(ts?: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
}

// 过程性内容（思考 / 工具调用）统一走「安静细行」——正式消息才是主角，这些只做背景陪衬。
function QuietRow({
  icon,
  label,
  meta,
  err,
  children,
}: {
  icon: ReactNode
  label: string
  meta?: string
  err?: boolean
  children: ReactNode
}) {
  return (
    <Collapsible className="group/quiet min-w-0">
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-1.5 rounded py-0.5 text-left text-[11px] hover:text-foreground',
          err ? 'text-destructive/80' : 'text-muted-foreground/70',
        )}
      >
        <CaretRightIcon className="size-2.5 shrink-0 transition-transform group-data-[state=open]/quiet:rotate-90" />
        {icon}
        <span className="truncate">{label}</span>
        {meta && <span className="shrink-0 tabular-nums opacity-80">· {meta}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ms-3 grid min-w-0 gap-1 border-s ps-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// 工具调用块：合并 tool_use（输入）与其 tool_result（结果）+ 耗时
function ToolBlock({
  name,
  input,
  result,
  durationMs,
  summary,
}: {
  name: string
  input: unknown
  result?: ToolResult
  durationMs?: number
  summary?: string // 精简视图的步骤列表里带上「在干什么」，全量视图不传＝原样
}) {
  const err = result?.is_error
  const dur = durationMs ? fmtDur(durationMs) : ''
  return (
    <QuietRow
      icon={<WrenchIcon className="size-3 shrink-0" />}
      label={`${name}${summary ? ` · ${summary}` : ''}${err ? ' · 出错' : ''}`}
      meta={dur}
      err={err}
    >
      <pre className="max-h-60 overflow-auto text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
        {stringify(input)}
      </pre>
      {result && (
        <pre className={cn('max-h-60 overflow-auto text-[11px] whitespace-pre-wrap break-words text-muted-foreground', err && 'text-destructive')}>
          → {stringify(result.content)}
        </pre>
      )}
    </QuietRow>
  )
}

function ExpandBlock({ icon, label, body }: { icon: ReactNode; label: string; body: string }) {
  return (
    <QuietRow icon={icon} label={label}>
      <pre className="max-h-72 overflow-auto text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
        {body}
      </pre>
    </QuietRow>
  )
}

// 系统细行（lab 事件）：居中一行灰字。文案长度不可控——「🔔 后台任务完成：<最长 300 字摘要>（结果在 <绝对路径>）」
// 里摘要常带换行/markdown，路径又是不可断词的长 token。原实现直接把整段塞进 rounded-full 的 span：
// ① 换行被折叠成一坨行内文字，markdown 记号（## / **）裸露；② span 被长路径撑到超过容器宽，而外层是
// justify-center，溢出量左右均分 → 左边的 🔔 和内边距被裁到窗口外、右边文字顶穿聊天区（2026-08-20 老板截图）。
// 现在：折行前先把空白压成一行 + truncate 单行省略（min-w-0/max-w 保证能收缩），点一下展开看原文（pre-wrap + 断词）。
function LabRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const oneLine = text.replace(/\s+/g, ' ').trim()
  const expandable = oneLine.length > 48 || oneLine !== text.trim()
  return (
    <div className="flex min-w-0 justify-center">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((v) => !v)}
        title={expandable && !open ? oneLine : undefined}
        className={cn(
          'min-w-0 max-w-[85%] bg-muted/60 px-3 py-1 text-xs text-muted-foreground',
          expandable && 'hover:text-foreground',
          open ? 'rounded-lg text-start whitespace-pre-wrap break-words' : 'rounded-full truncate',
        )}
      >
        {open ? text.trim() : oneLine}
      </button>
    </div>
  )
}

/* 员工→员工发消息的系统胶囊（老板 2026-10-19）：引擎在发送方会话里落一条 handoff 事件（server.js emitHandoff），
   这里渲染成居中的一枚胶囊——「→ 交棒给 迷糊老师 · 指令摘要」，点了直接打开对方那条会话。
   对方忙、消息还在待处理队列里（toRunId 为空）时，点开的是对方最近一次对话。 */
const HANDOFF_VERB: Record<string, string> = {
  call: '交棒给', cc: '抄送给', return: '交回给', 'cc-join': '唤回', self: '自续 · 新会话',
}
function HandoffRow({ ev }: { ev: RunEvent }) {
  const { open, openChat } = useRunDetail()
  const { employees } = useEmployees()
  const to = String(ev.to ?? '')
  const toRunId = ev.toRunId ? String(ev.toRunId) : ''
  const emp = employees[to]
  const name = String(ev.toName || emp?.displayName || to)
  const kind = String(ev.kind || 'call')
  const verb = HANDOFF_VERB[kind] || '发给'
  const state = !toRunId && ev.queued ? '对方忙，已排队' : ev.merged ? '并入其当前会话' : ''
  const text = String(ev.text ?? '')
  return (
    <div className="flex min-w-0 justify-center">
      <button
        type="button"
        onClick={() => (toRunId ? open(toRunId) : to && openChat(to))}
        title={`${verb}${kind === 'self' ? '' : ` ${name}`}${state ? `（${state}）` : ''}${text ? `
${text}` : ''}
点击打开对应会话`}
        className="group/ho inline-flex min-w-0 max-w-[85%] items-center gap-1.5 rounded-full border border-primary/25 bg-primary/8 py-0.5 ps-1 pe-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/15 hover:text-foreground"
      >
        <EmployeeAvatar employee={emp} fallback={name} className="size-4 shrink-0" />
        <span className="shrink-0 font-medium text-foreground/80">
          {verb}
          {kind !== 'self' && ` ${name}`}
        </span>
        {state && <span className="shrink-0 text-[10px] text-muted-foreground">· {state}</span>}
        {text && <span className="min-w-0 truncate">· {text}</span>}
        <ArrowSquareOutIcon className="size-3 shrink-0 opacity-60 group-hover/ho:opacity-100" />
      </button>
    </div>
  )
}

/* 本轮出错的落款行（老板 2026-09-07：「这个红框错误信息的展示太难看了」）。
   旧样子：**全宽**方框 + `border-destructive/50` 重红边 + 无底色 + 14px 正文，里面常常只有一句
   **裸英文**（`The model's tool call could not be parsed (retry also failed).`），紧跟着下面那行
   「❌ 本轮以错误结束」——同一件事报两遍，一个说英文一个说中文，还是整幅最扎眼的元素。
   现在：跟 LabRow / QuietRow 一个语言——**贴左、收窄、发丝红边 + 极浅红底**，一行中文摘要只说
   「怎么了」（**「怎么办」交给紧邻的 lab 行**，那本就是引擎给的恢复指引，别把两句话都塞进这一行然后
   双双被 truncate 吃掉）；**英文原文折叠留证、不藏也不占地**。未知签名就把原文压成一行当摘要。 */
const ERROR_HINTS: Array<[RegExp, string]> = [
  // §3.117 那个「假调用」的响亮版：调用被写成正文且截断 → SDK 解析失败重试无效
  [/tool call could not be parsed/i, '模型的工具调用格式坏了 —— 本轮零动作'],
  [/rate.?limit|429/i, '触发上游限流'],
  [/overloaded|529/i, '上游过载'],
  [/abort|cancell?ed/i, '本轮被中止'],
]
function RunErrorRow({ text }: { text: string }) {
  const raw = text.trim()
  const oneLine = raw.replace(/\s+/g, ' ')
  const hint = ERROR_HINTS.find(([re]) => re.test(raw))?.[1]
  const title = hint || (oneLine ? oneLine : '本轮运行出错（引擎没拿到错误原文）')
  // 有中文摘要时原文必留；没摘要时只有「长/多行」才值得折叠（短原文本身就是摘要，别让人多点一下）
  const showRaw = !!raw && (!!hint || raw.length > 90 || raw.includes('\n'))
  const shell =
    'max-w-[92%] min-w-0 overflow-hidden rounded-lg border border-destructive/25 bg-destructive/5 text-destructive'
  return (
    <div className="flex min-w-0 justify-start">
      {showRaw ? (
        <Collapsible className={cn('group/err', shell)}>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-start text-xs transition hover:bg-destructive/10">
            <XCircleIcon className="size-3.5 shrink-0" weight="fill" />
            <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
            <span className="shrink-0 text-[10px] opacity-70">原文</span>
            <CaretRightIcon className="size-2.5 shrink-0 transition-transform group-data-[state=open]/err:rotate-90" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="max-h-48 overflow-auto border-t border-destructive/15 px-2.5 py-1.5 text-[11px] whitespace-pre-wrap break-words opacity-80 [overflow-wrap:anywhere]">
              {raw}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div className={cn('flex items-center gap-1.5 px-2.5 py-1.5 text-xs', shell)}>
          <XCircleIcon className="size-3.5 shrink-0" weight="fill" />
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{title}</span>
        </div>
      )}
    </div>
  )
}

// copyText：给这条消息挂「复制」动作（hover 该行才现）。**放在气泡横向的旁边、不占一行**——
// 每条消息都留一条 16px 页脚会把整段会话的行距撑散；而气泡本就只占 80% 宽，横向那点空位是白给的。
// 用户侧按钮在气泡左边、员工侧在右边（都朝着空白那侧，不挤压正文）。
// full/contentClassName：归组连贯用（见 AssistantBlocks）——气泡撑满整列以便与卡片左右对齐，
// 圆角由调用方按段在栈里的位置给（相邻边削平）。不传＝原来的 w-fit / 80% 气泡。
function Bubble({
  role,
  children,
  copyText,
  full,
  contentClassName,
}: {
  role: 'user' | 'assistant'
  children: ReactNode
  copyText?: string
  full?: boolean
  contentClassName?: string
}) {
  return (
    // min-w-0：本行是消息列（grid）的栅格项，默认 min-width:auto 不会收缩——气泡里若有代码块(<pre>)等
    // 不换行内容，整行会被撑到内容宽、连累整列超出滚动区产生横向滚动条。min-w-0 让行收缩到栅格宽，
    // pre 自身 overflow-auto 再在气泡内横向滚动（长代码只在代码块里滚，不再顶穿整个聊天窗）。
    <div className={cn('group/msg flex min-w-0 items-end gap-1', role === 'user' ? 'justify-end' : 'justify-start')}>
      {role === 'user' && copyText && <CopyMessage text={copyText} className="mb-1" />}
      <UIBubble
        variant={role === 'user' ? 'default' : 'muted'}
        align={role === 'user' ? 'end' : 'start'}
        // 窄屏放宽到 88%：气泡默认 80% 是给宽屏留「谁说的」呼吸位的，390px 上那 20% 是白扔的
        // 一整列字宽，中文长句被压成一行五六个字。
        className={cn('max-w-[88%] md:max-w-[80%]', full && 'w-full max-w-full')}
      >
        <BubbleContent className={cn('rounded-md px-3 py-2 text-sm', full && 'w-full', contentClassName)}>
          {children}
        </BubbleContent>
      </UIBubble>
      {role === 'assistant' && copyText && <CopyMessage text={copyText} className="mb-1" />}
    </div>
  )
}

function SubAgentBlock({
  name,
  input,
  events,
  ctx,
  subAgents,
  toolResults,
}: {
  name: string
  input: unknown
  events: RunEvent[]
  ctx: CardCtx
  subAgents: Map<string, RunEvent[]>
  toolResults: Map<string, ToolResult>
}) {
  return (
    <Collapsible className="min-w-0 rounded-md border border-primary/30 bg-primary/5">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-primary">
        <WrenchIcon className="size-3.5 shrink-0" />
        <span className="truncate">子代理 · {name}（{events.length} 步）</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="min-w-0 border-t p-2">
          <pre className="mb-2 max-h-40 min-w-0 overflow-auto rounded bg-muted/50 p-2 text-[11px] break-words whitespace-pre-wrap">
            {stringify(input)}
          </pre>
          <div className="grid min-w-0 gap-2 border-s-2 border-primary/20 ps-2">
            {events.map((e, i) => (
              <EventRow key={e._seq ?? i} ev={e} ctx={ctx} subAgents={subAgents} toolResults={toolResults} />
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// 一个 assistant 事件里的所有 block（正文气泡 / 思考 / 工具调用 / 子代理）——不含头像
function AssistantBlocks({
  ev,
  ctx,
  subAgents,
  toolResults,
  showProcess = true,
}: {
  ev: RunEvent
  ctx: CardCtx
  subAgents: Map<string, RunEvent[]>
  toolResults: Map<string, ToolResult>
  showProcess?: boolean
}) {
  const blocks = toBlocks(ev.message?.content)
  return (
    <div className="grid min-w-0 gap-1.5">
      {blocks.map((b, i) => {
        // SDK 自己的报错文本会同时以 assistant 文本块 + result 事件两种身份到达（2026-09-07）——
        // 那不是员工说的话，而红框已经完整展示了它，气泡里再来一遍就是「同一句英文说两遍」。
        if (b.type === 'text' && isSdkParseNoise(b.text)) return null
        if (b.type === 'text' && b.text?.trim()) {
          // 「工具调用泄漏成正文」先剥出来（2026-09-07 事故）：模型把 `<invoke name="…">…</invoke>`
          // 当文本写出来时那一步**并没有执行**，旧渲染却把这一墙 XML 当正文铺在气泡里（老板 09-07 截图）。
          // 现在正文只留真话、假调用降级成一行红细行点名工具；引擎侧同时判本轮未正常收工（stall-guard）。
          const { clean, leaks } = stripLeakedInvokes(b.text)
          const text: string = clean            // 整条都是假调用时 clean 为空 → 只留那行细行，不再铺 XML
          // 有事项的【等你拍板】行从气泡里剥掉、改由下面那张 gate 卡承载（否则同一句话显示两遍）；
          // 「无」门不剥、也不出卡。复制仍复制 text 原文——那才是员工真发出来的这条消息。
          const { item: gate, rest: body } = parseGateMarker(text)
          return (
            <div key={i} className="grid min-w-0 gap-1.5">
              {/* 复制源给 markdown 原文（不是渲染后的 DOM 文本）——粘出去还能保留代码块/列表。
                  带卡的消息按段渲染：卡片裸放（不套气泡，否则画框套画框），**正文段照样进气泡**；
                  各段再**归组连贯**（同宽 + 2px 间距 + 相邻圆角削平 + 整条只一个复制按钮），
                  否则「窄气泡 / 宽卡 / 窄气泡」参差成三条独立消息（老板 2026-09-07 反馈）。 */}
              {!body.trim() ? null : hasCard(body) ? (
                <div className="group/msg flex min-w-0 items-end gap-1">
                  <OLContent
                    text={body}
                    ctx={{ ...ctx, messageKey: String(ev._ts ?? ev._seq ?? ev.message?.id ?? '') }}
                    joined
                    className="flex-1"
                    wrapMd={(md, corner) => (
                      <Bubble role="assistant" full contentClassName={corner}>
                        <Markdown>{md}</Markdown>
                      </Bubble>
                    )}
                  />
                  {/* 一条消息一个复制：复制整条原文（含卡片围栏——那才是员工真发出来的这条消息） */}
                  <CopyMessage text={text} className="mb-1" />
                </div>
              ) : (
                <Bubble role="assistant" copyText={text}>
                  <Markdown>{body}</Markdown>
                </Bubble>
              )}
              {/* 假调用排在正文之后（它在原文里也是结尾那一坨），一行点名 + 折叠原样留证 */}
              {leaks.length > 0 && (
                <QuietRow
                  icon={<WarningIcon className="size-3 shrink-0" />}
                  label={`未执行的工具调用（写成了正文）· ${leaks.map((l) => l.tool).join('、')}`}
                  meta={`${leaks.length} 个`}
                  err
                >
                  <div className="text-[11px] text-destructive/80">
                    模型没有真的调用工具，只是把调用写成了文字 —— 这一步零副作用（看板回写 / 对账 / 命令都没发生）。
                  </div>
                  <pre className="max-h-60 overflow-auto text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
                    {leaks.map((l) => l.body).join('\n\n')}
                  </pre>
                </QuietRow>
              )}
              {gate && !hasActionCard(body) && (
                <SafeOLCard data={{ type: 'gate', eyebrow: '等你拍板', title: gate }} ctx={ctx} />
              )}
            </div>
          )
        }
        if (b.type === 'thinking' || b.type === 'redacted_thinking')
          return showProcess ? (
            <ExpandBlock key={i} icon={<BrainIcon className="size-3 shrink-0" />} label="思考" body={b.thinking || '（隐藏）'} />
          ) : null
        if (b.type === 'tool_use') {
          if (!showProcess) return null
          const nested = b.id ? subAgents.get(b.id) : undefined
          if (nested?.length)
            return (
              <SubAgentBlock key={i} name={b.name} input={b.input} events={nested} ctx={ctx} subAgents={subAgents} toolResults={toolResults} />
            )
          const res = b.id ? toolResults.get(b.id) : undefined
          const startTs = ev._ts as string | undefined
          const dur = res?.ts && startTs ? new Date(res.ts).getTime() - new Date(startTs).getTime() : 0
          return <ToolBlock key={i} name={b.name} input={b.input} result={res} durationMs={dur} />
        }
        return null
      })}
    </div>
  )
}

function EventRow({
  ev,
  ctx,
  subAgents,
  toolResults,
  showProcess = true,
}: {
  ev: RunEvent
  ctx: CardCtx
  subAgents: Map<string, RunEvent[]>
  toolResults: Map<string, ToolResult>
  showProcess?: boolean
}) {
  switch (ev.type) {
    case 'system':
      return (
        <div className="flex justify-center">
          <Badge variant="outline" className="text-[10px]">
            会话初始化{ev.model ? ` · ${ev.model}` : ''}
          </Badge>
        </div>
      )
    case 'user-msg':
      return <UserMsg text={String(ev.text ?? '')} kind={String(ev.kind ?? '')} userText={String(ev.userText ?? '')} engineHandover={ev.engineHandover === true} />

    case 'lab':
      return <LabRow text={String(ev.text ?? '')} />

    case 'handoff':
      return <HandoffRow ev={ev} />

    case 'assistant':
      // 不再自带头像——整轮共用一个头像由外层分组渲染（见 Transcript）
      return <AssistantBlocks ev={ev} ctx={ctx} subAgents={subAgents} toolResults={toolResults} showProcess={showProcess} />

    case 'user': {
      if (!showProcess) return null
      // tool_result 已并入对应 tool_use 展示；这里只渲染没有配对 tool_use 的孤儿
      const blocks = toBlocks(ev.message?.content).filter(
        (b) => b.type === 'tool_result' && !(b.tool_use_id && toolResults.has(b.tool_use_id)),
      )
      if (!blocks.length) return null
      return (
        <div className="grid gap-2">
          {blocks.map((b, i) => (
            <ExpandBlock
              key={i}
              icon={<WrenchIcon className="size-3.5" />}
              label={b.is_error ? '工具结果（出错）' : '工具结果'}
              body={stringify(b.content)}
            />
          ))}
        </div>
      )
    }

    case 'result':
      if (!ev.is_error) return null
      return <RunErrorRow text={String(ev.result || '')} />
    default:
      return null
  }
}

// ---------- 精简视图：两条正文之间的过程收成一行「步骤摘要」 ----------
// 缘起（老板 2026-09-28）：「显示过程展示的太多，隐藏的话暴露的信息又太少」——隐藏过程原先是**整条跳过**
// 纯工具/思考事件（GG Bond 一轮 101 次工具调用、58 段思考，屏幕上只剩 2 句正文），反倒是「后台任务完成」
// 这类 lab 通知一条不落铺满屏。现在隐藏过程＝精简：过程不消失，而是按段聚合成一行（步数 / 按工具计数 / 出错数 /
// 最近一步在干什么），点开是逐步列表、每步再点看输入与结果；后台任务的完成/失败通知也并进这一行。
const BG_LAB = /^\s*(🔔|⚠️|⏹)\s*后台任务(完成|失败|停止)/
function friendlyTool(name: string): string {
  if (name.startsWith('mcp__')) return name.split('__').pop() || name
  const m: Record<string, string> = {
    Bash: '命令', BashOutput: '命令输出', KillShell: '停命令', Read: '读', Write: '写', Edit: '改', MultiEdit: '改',
    NotebookEdit: '改', Grep: '搜', Glob: '找文件', WebFetch: '抓网页', WebSearch: '搜网页', Task: '子代理', Agent: '子代理',
    TaskCreate: '待办', TaskUpdate: '待办', TaskOutput: '待办', TaskList: '待办', TodoWrite: '待办',
  }
  return m[name] || name
}
const baseName = (p: unknown) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || ''
function toolSummary(name: string, input: any): string {
  const i = input || {}
  const one = (s: unknown) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  if (name === 'Bash') return one(i.description || i.command)
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return baseName(i.file_path || i.notebook_path)
  if (name === 'Grep' || name === 'Glob') return one(i.pattern)
  if (name === 'WebFetch') return one(i.url)
  if (name === 'WebSearch') return one(i.query)
  if (name === 'Task' || name === 'Agent') return one(i.description)
  if (name.startsWith('Task') || name === 'TodoWrite') return one(i.subject || i.description || i.status)
  return ''
}
type Step =
  | { kind: 'tool'; block: Block; ev: RunEvent }
  | { kind: 'think'; block: Block }
  | { kind: 'bg'; text: string }

function ProcessGroup({
  steps,
  ctx,
  subAgents,
  toolResults,
}: {
  steps: Step[]
  ctx: CardCtx
  subAgents: Map<string, RunEvent[]>
  toolResults: Map<string, ToolResult>
}) {
  const counts = new Map<string, number>()
  let thinks = 0
  let errs = 0
  let n = 0
  let last = ''
  for (const s of steps) {
    if (s.kind === 'think') {
      thinks++
      continue
    }
    n++
    if (s.kind === 'bg') {
      counts.set('后台', (counts.get('后台') || 0) + 1)
      if (/失败/.test(s.text)) errs++
      last = s.text.replace(/\s+/g, ' ').trim().slice(0, 60)
      continue
    }
    const nm = friendlyTool(s.block.name)
    counts.set(nm, (counts.get(nm) || 0) + 1)
    if (s.block.id && toolResults.get(s.block.id)?.is_error) errs++
    const sum = toolSummary(s.block.name, s.block.input)
    last = sum ? `${nm} · ${sum}` : nm
  }
  if (!n && !thinks) return null
  const chips = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`)
  if (thinks) chips.push(`思考 ${thinks}`)
  return (
    <Collapsible className="group/steps min-w-0" data-testid="transcript-process-group">
      {/* 两行：① 步数 + 出错（窄窗也不许被截掉的两样）+ 各类计数；② 最近一步在干什么——窄窗里它最先被 truncate 吃掉，故单独一行 */}
      <CollapsibleTrigger className="grid w-full min-w-0 rounded py-0.5 text-left text-[11px] text-muted-foreground/80 hover:text-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <CaretRightIcon className="size-2.5 shrink-0 transition-transform group-data-[state=open]/steps:rotate-90" />
          <WrenchIcon className="size-3 shrink-0" />
          <span className="shrink-0 font-medium">{n ? `执行了 ${n} 步` : '思考中'}</span>
          {errs > 0 && <span className="shrink-0 text-destructive/80">出错 {errs}</span>}
          <span className="min-w-0 truncate text-muted-foreground/70">{chips.join(' · ')}</span>
        </span>
        {last && <span className="min-w-0 truncate ps-[26px] text-muted-foreground/60">最近：{last}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 ms-3 grid min-w-0 gap-0.5 border-s ps-2">
          {steps.map((s, i) => {
            // 精简列表不铺思考（计数已在摘要里；每步之间夹一行「思考」只是噪音）——要看思考内容走「显示全部过程」
            if (s.kind === 'think') return null
            if (s.kind === 'bg')
              return (
                <ExpandBlock
                  key={i}
                  icon={/失败/.test(s.text) ? <WarningIcon className="size-3 shrink-0" /> : <WrenchIcon className="size-3 shrink-0" />}
                  label={s.text.replace(/\s+/g, ' ').trim().slice(0, 90)}
                  body={s.text}
                />
              )
            const b = s.block
            const nested = b.id ? subAgents.get(b.id) : undefined
            if (nested?.length)
              return <SubAgentBlock key={i} name={b.name} input={b.input} events={nested} ctx={ctx} subAgents={subAgents} toolResults={toolResults} />
            const res = b.id ? toolResults.get(b.id) : undefined
            const startTs = s.ev._ts as string | undefined
            const dur = res?.ts && startTs ? new Date(res.ts).getTime() - new Date(startTs).getTime() : 0
            return <ToolBlock key={i} name={friendlyTool(b.name)} summary={toolSummary(b.name, b.input)} input={b.input} result={res} durationMs={dur} />
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

const FOLD_MARK = /^\s*【(派工|下一棒|抄送|交回|受阅|巡视)】/
function UserMsg({ text, kind, userText, engineHandover }: { text: string; kind: string; userText?: string; engineHandover?: boolean }) {
  // Render internal handover context separately from real user input, including stored events.
  if (engineHandover || text.trimStart().startsWith('【基座交接 · 继续未完成任务】')) return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="engine-handover-message">
      {userText?.trim() && <PlainUserMsg text={userText.trim()} />}
      <Collapsible className="group/handover flex min-w-0 flex-col items-center">
        <CollapsibleTrigger className="flex max-w-full items-center gap-1 rounded-full bg-muted/60 px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted">
          <CaretRightIcon className="size-3 shrink-0 transition-transform group-data-[state=open]/handover:rotate-90" />
          <span className="truncate">基座交接 · 已附带任务与进度</span>
          <span className="shrink-0">· 查看原文</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="w-full min-w-0">
          <div className="mt-2 rounded-md border bg-muted/30 p-3">
            <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>供新基座接手的上下文</span><CopyMessage text={text} /></div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{text}</pre>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
  // 老板自己敲的那条：气泡里就是他说的话。引擎注入（【派工】头 / 任务快照 / 同事近况 / 守航态续跑…）
  // 全部退到气泡下面那行小字里。此前折叠头取的是「正文第一行」，而正文第一行恰好是注入块，于是老板
  // 一句「5.23 其他功能没了」被一屏守航契约压在最底下（2026-09-21 老板：「看着就烦」）。
  // userText 由引擎在 user-msg 事件上带（见 server.js startRun 的注释）；存量事件没有它 → 走下面的老路径。
  if (userText?.trim()) return <BossMsg said={userText.trim()} full={text} />
  // 引擎代发的系统唤起（【系统·E2E 批次已全部结束】等）：正文是写给 AI 的操作指令，人看只要结果——
  // 渲染成结构化卡片，原文收进卡底折叠（2026-10-26 老板：消息体别出现长篇文字，要气泡/卡片）
  const notice = parseSystemNotice(stripDispatchNoise(text))
  if (notice) return <SystemNoticeCard notice={notice} raw={stripDispatchNoise(text)} />
  const foldable = kind === 'dispatch' || kind === 'cc' || FOLD_MARK.test(text)
  if (foldable) {
    const mk = text.match(FOLD_MARK)
    const from = ccFrom(text)
    // 折叠头：抄送优先显「抄送 · 来自 X」，否则用 marker 类型（派工/下一棒/交回…）
    const label = from ? '抄送' : mk ? mk[1] : kind === 'cc' ? '抄送' : '派工'
    const lead = dispatchLead(text)             // 一行干净摘要（剥注入 + 去 md 强调符）
    const body = stripDispatchNoise(text)       // 真正的正文（剥掉任务快照/同事近况/marker/委托说明）
    return (
      <div className="flex min-w-0 justify-end">
        <Collapsible className="group/msg max-w-[85%] min-w-0 rounded-lg border bg-primary/5">
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm">
            <Badge>{label}</Badge>
            {from && <span className="shrink-0 text-xs text-muted-foreground">来自 {from}</span>}
            <span className="truncate text-muted-foreground">{lead}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="border-t px-3 py-2 text-sm">
              {/* 展开：先给按 markdown 渲染的干净正文（此前是 pre-wrap 原文、``` 显示成字面） */}
              {body ? (
                <ClampBlock long={body.length > 480}>
                  <Markdown>{body}</Markdown>
                </ClampBlock>
              ) : (
                <span className="text-xs text-muted-foreground">（仅注入上下文，无正文）</span>
              )}
              {/* 二级：完整原文（含任务快照/同事近况/附件/聊天记录），需要时再展开 */}
              <Collapsible className="mt-2">
                <div className="flex items-center gap-2">
                  <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                    查看原文（含任务快照 / 同事近况）
                  </CollapsibleTrigger>
                  {/* 派工/抄送也能复制，但复制的是**干净正文**（body）而不是带任务快照的整段注入——
                      要复制那份原文的人，展开原文自己选文本即可 */}
                  <CopyMessage text={plainMessageText(body || text)} />
                </div>
                <CollapsibleContent>
                  <div className="mt-1 rounded-md border bg-muted/30 px-2.5 py-2 text-xs">
                    <UserContent text={text} />
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    )
  }
  return <PlainUserMsg text={text} />
}

// 长正文默认只露前几行 + 渐隐，按需「展开全文」——展开派工别一下子铺满一屏
function ClampBlock({ long, children }: { long: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  if (!long) return <>{children}</>
  return (
    <div className="min-w-0">
      <div className={cn('relative min-w-0', !open && 'max-h-40 overflow-hidden')}>
        {children}
        {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent" />}
      </div>
      <button type="button" className="mt-1 text-xs text-primary underline-offset-2 hover:underline" onClick={() => setOpen((v) => !v)}>
        {open ? '收起' : '展开全文'}
      </button>
    </div>
  )
}

// 用户气泡本体（正文气泡 + 气泡外的聊天记录卡）
function PlainUserMsg({ text }: { text: string }) {
  // 聊天记录卡提到气泡外：套在紫气泡里是「画框套画框」，卡片还得跟气泡底色/白字打架（见 message-content）
  const { body, cards } = splitUserMessage(text)
  // 自己发的消息同样可复制（老板 2026-09-01）：复制整条原文（含聊天记录内容，剥掉引擎哨兵），
  // 而不是只复制气泡里那半段——粘回去要能直接当成"我刚才说的话"再发一次。
  const copyText = plainMessageText(text)
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {body && <Bubble role="user" copyText={copyText}>{body}</Bubble>}
      {cards.length > 0 && (
        <div className="group/msg flex min-w-0 items-end justify-end gap-1">
          {/* 只有卡没正文时（气泡不存在），复制动作挂在卡这一行 */}
          {!body && <CopyMessage text={copyText} className="mb-1" />}
          {/* 记录常带截图，比气泡的 80% 再放宽一点 */}
          <div className="flex w-full max-w-[92%] min-w-0 flex-col gap-1.5">{cards}</div>
        </div>
      )}
    </div>
  )
}

// 老板自己发的消息：气泡＝他敲下的原话，引擎注入退成气泡下面一行小字（默认收起）。
// 刻意不显示「派工」徽标——他知道自己挂没挂档案；徽标只留给同事间的【下一棒】/【抄送】，
// 那里「谁发来的、什么类型」本身才是信息（2026-09-21 老板定的口径）。
function BossMsg({ said, full }: { said: string; full: string }) {
  const injected = full.trim() !== said   // 普通对话零注入 → 连那行小字都不出现，就是一条干净消息
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <PlainUserMsg text={said} />
      {injected && (
        <Collapsible className="flex min-w-0 flex-col items-end">
          <CollapsibleTrigger className="text-[11px] text-muted-foreground/70 underline-offset-2 hover:text-muted-foreground hover:underline">
            查看完整指令（含引擎注入的任务快照 / 同事近况）
          </CollapsibleTrigger>
          <CollapsibleContent className="w-full min-w-0">
            <div className="mt-1 rounded-md border bg-muted/30 px-2.5 py-2 text-xs">
              <UserContent text={full} />
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}

// memo：父层 RunDetail 持有输入框 state，每敲一个字都会重渲染；不 memo 的话整条会话（几百条气泡+卡片）
// 跟着重建，长会话打字明显卡顿。props 里的回调由父层 useCallback 稳定住，events 只在 SSE 来新事件时变。
export const Transcript = memo(function Transcript({
  events,
  onReply,
  focusReply,
  runId,
  employee,
  showProcess = false,
}: {
  events: RunEvent[]
  onReply?: (text: string) => void | boolean | Promise<void | boolean>
  focusReply?: () => void
  runId?: string
  employee?: string
  showProcess?: boolean
}) {
  const { employees } = useEmployees()
  // 攒批不从这里透传（走 CardBatchProvider 的 context，见 card-batch.tsx）：
  // 否则暂存态每变一次都要让整条 transcript 的 useMemo 失效重渲染。
  const ctx: CardCtx = { onReply, focusReply, runId }

  const rendered = useMemo(() => {
    // 子代理归组 + tool_use↔tool_result 关联（含耗时）
    const subAgents = new Map<string, RunEvent[]>()
    const toolResults = new Map<string, ToolResult>()
    for (const e of events) {
      const pid = (e as any).parent_tool_use_id
      if (pid) {
        if (!subAgents.has(pid)) subAgents.set(pid, [])
        subAgents.get(pid)!.push(e)
      }
      if (e.type === 'user') {
        for (const b of toBlocks(e.message?.content)) {
          if (b.type === 'tool_result' && b.tool_use_id)
            toolResults.set(b.tool_use_id, { content: b.content, is_error: b.is_error, ts: e._ts as string })
        }
      }
    }
    const top = events.filter((e) => !(e as any).parent_tool_use_id)
    const emp = employees[employee ?? '']
    const out: ReactNode[] = []
    let lastDay = ''
    let lastLeakLead: string | null = null   // 上一条「带假调用的纯文本事件」在 invoke 之前的正文（识别 SDK 重试的重复，见下）
    const dayDivider = (day: string, key: string) => {
      if (!day || day === lastDay) return
      out.push(
        <div key={`day-${key}`} className="my-1 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          {day}
          <span className="h-px flex-1 bg-border" />
        </div>,
      )
      lastDay = day
    }

    // 逐事件渲染：每条 assistant「消息」(有正文)各带一个头像；思考/工具（无正文的过程事件）
    // 无头像、缩进对齐在消息下方。精简视图（!showProcess）下过程不再跳过，而是攒进 steps、
    // 遇到下一条「非过程」内容（正文 / 用户消息 / 其它系统行）时收成一行 ProcessGroup。用户消息/系统/错误各自独立。
    let steps: Step[] = []
    let stepsKey = ''
    const flushSteps = () => {
      if (!steps.length) return
      const group = steps
      out.push(
        <div key={`pg-${stepsKey}`} className="flex min-w-0 gap-2">
          <div className="w-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <ProcessGroup steps={group} ctx={ctx} subAgents={subAgents} toolResults={toolResults} />
          </div>
        </div>,
      )
      steps = []
    }
    const pushSteps = (bs: Block[], ev: RunEvent, key: string) => {
      for (const b of bs) {
        if (b.type === 'tool_use') steps.push({ kind: 'tool', block: b, ev })
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') steps.push({ kind: 'think', block: b })
        else continue
        if (steps.length === 1) stepsKey = key
      }
    }
    // 员工→员工的发信胶囊（handoff）**挪到消息下面**（老板 2026-10-21：「给其他员工发信息这个气泡也要展示在
    // 消息下面，否则用户看不到」）。按时序它落在本轮回复之前（cc_colleague 调完才写结论），夹在步骤组和回复
    // 之间，一眼扫过去只看到回复、胶囊被埋在上面。现在先攒着：遇到下一条带正文的回复就紧跟其后渲染；
    // 本轮没有后续回复（交棒即收工）就在轮次边界（用户消息/结束/初始化）前、步骤组之后吐出，末尾兜底。
    // 也不再让它 flushSteps——否则一枚胶囊会把同一段过程劈成两个「执行了 N 步」。
    let handoffs: Array<{ ev: RunEvent; key: string }> = []
    const flushHandoffs = () => {
      for (const h of handoffs)
        out.push(
          <div key={`ho-${h.key}`} className="ol-msg-in min-w-0">
            <HandoffRow ev={h.ev} />
          </div>,
        )
      handoffs = []
    }
    for (let i = 0; i < top.length; i++) {
      const ev = top[i]
      const key = ev._seq ?? i
      const day = dayLabel(ev._ts as string)

      if (ev.type === 'handoff') {
        handoffs.push({ ev, key: String(key) })
        continue
      }
      if (ev.type === 'assistant') {
        const blocks = toBlocks(ev.message?.content)
        const hasText = blocks.some((b) => b.type === 'text' && (b as any).text?.trim())
        if (!showProcess && !hasText) {   // 精简视图：纯过程事件攒进步骤组，不单独成行
          pushSteps(blocks, ev, String(key))
          continue
        }
        // 整条只有 SDK 那句英文报错 → 跳过（红框已展示；否则留下空气泡 + 孤零零一个头像）
        if (blocks.length > 0 && blocks.every((b) => b.type === 'text' && isSdkParseNoise((b as any).text))) continue
        // 「工具调用解析不了 → SDK 重试」会把同一段话再发一遍（2026-09-07 run 20260907065645-c4b5f2：
        // 09:07 两条正文开头逐字相同、尾巴上各挂着一个写坏的 invoke，只是截断位置差 18 字）。屏幕上就是
        // 同一句话说了两遍、各带一坨 XML，看着像系统发疯（老板：「太吓人了」）。
        // 吞掉后一条的条件收窄到三条同时成立：纯文本事件 + 带假调用 + **`<invoke` 之前的正文逐字相同**
        // （不能要求整段相同——重试那次本就截断在别处）。中间只要夹了任何别的事件就重置，不跨轮误吞。
        const txt = blocks.every((b) => b.type === 'text') ? blocks.map((b) => String((b as any).text || '')).join('\n') : null
        const lead = txt && /<invoke\s+name="/i.test(txt) ? txt.split(/<(?:[a-z]+:)?invoke\s+name="/i)[0].trim() : null
        if (lead && lead === lastLeakLead) continue
        lastLeakLead = lead
        // 精简视图：正文前的思考/工具归上一组、先收掉；正文后的开启下一组（同一事件里 [思考, 正文, 工具] 的常见形态）
        const firstText = blocks.findIndex((b) => b.type === 'text' && (b as any).text?.trim())
        if (!showProcess) {
          pushSteps(blocks.slice(0, firstText), ev, String(key))
          flushSteps()
        }
        dayDivider(day, String(key))
        out.push(
          <div key={key} className="ol-msg-in flex min-w-0 gap-2">
            <div className="w-7 shrink-0">
              {hasText && <EmployeeAvatar employee={emp} fallback={employee} className="size-7" />}
            </div>
            <div className="min-w-0 flex-1">
              <AssistantBlocks ev={ev} ctx={ctx} subAgents={subAgents} toolResults={toolResults} showProcess={showProcess} />
            </div>
          </div>,
        )
        if (hasText) flushHandoffs()
        if (!showProcess) pushSteps(blocks.slice(firstText + 1), ev, String(key) + 'b')
      } else if (ev.type === 'user' && !showProcess) {
        continue // tool_result：已按 tool_use_id 并入对应步骤
      } else if (!showProcess && ev.type === 'lab' && BG_LAB.test(String(ev.text ?? ''))) {
        // 后台任务完成/失败通知：并进步骤组（计步数、失败计出错），不再一条一行刷屏
        steps.push({ kind: 'bg', text: String(ev.text ?? '') })
        if (steps.length === 1) stepsKey = String(key)
        continue
      } else {
        flushSteps()
        if (ev.type === 'user-msg' || ev.type === 'result' || ev.type === 'system') flushHandoffs()
        dayDivider(day, String(key))
        out.push(
          <div key={key} className="ol-msg-in min-w-0 empty:hidden">
            <EventRow ev={ev} ctx={ctx} subAgents={subAgents} toolResults={toolResults} showProcess={showProcess} />
          </div>,
        )
      }
    }
    flushSteps()
    flushHandoffs()
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, onReply, focusReply, employee, employees, showProcess])

  // 每条消息(含头像)一行，行距紧凑(gap-1.5)；过程细行缩进对齐在消息下方
  return <div className="grid min-w-0 gap-1.5">{rendered}</div>
})
