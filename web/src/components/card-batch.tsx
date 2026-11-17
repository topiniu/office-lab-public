import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { PaperPlaneRightIcon, CircleNotchIcon, NotePencilIcon } from '@phosphor-icons/react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export type StagedItem = { id: string; label: string; reply: string; title?: string }

type Ctx = {
  staged: StagedItem[]
  /** 这一下该攒批还是直接发：本轮只剩一张待处理动作卡 → 直接发；有兄弟卡或已攒了东西 → 攒批 */
  shouldBatch: () => boolean
  /** 动作卡挂载时登记「我还等你处理」，卸载/已处理时注销。返回注销函数。 */
  registerAction: (id: string) => () => void
  stage: (item: StagedItem, markSent: () => void) => void
  unstage: (id: string) => void
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

// 最近一次操作过（点击 / 聚焦）的聊天窗。焦点掉到 body 时（典型：gate 卡打字 Enter 选定后输入框随卡片卸载，
// 焦点无处可去）用它判定「这一下是给哪个窗的」——否则多开窗口时 idle 一律不接，用户就得先点一下窗口才能发。
let lastActiveChatWindow: Element | null = null
if (typeof window !== 'undefined') {
  const track = (e: Event) => {
    const w = (e.target as HTMLElement | null)?.closest?.('[data-chat-window]')
    if (w) lastActiveChatWindow = w
  }
  window.addEventListener('pointerdown', track, true)
  window.addEventListener('focusin', track, true)
}

/**
 * 「待发送」类浮条（攒批条 / 单卡已选确认条）共用的 Ctrl/⌘+Enter 窗口级监听：浮条在就生效，焦点在哪都行，不必先点进输入框。
 * - 只认本聊天窗内的按键（可能同时开着多个窗，各自有待发送）；焦点在页面空白处时，交给「最近操作过的那个窗」（单窗时直接接）。
 * - 别的输入框（组合器等）里已打了字时不抢——那是在发自己那句话；浮条自己的输入框（ownInput）除外。
 * - accept 可再收窄（如同窗多张确认条时只认本卡内的按键）。
 * capture 阶段拦截，免得组合器把同一下也当成发送。
 */
export function useSendHotkey(
  ref: { current: HTMLElement | null },
  fire: () => void,
  opts: { ownInput?: string; accept?: (target: HTMLElement | null, root: Element) => boolean } = {},
) {
  const fireRef = useRef(fire)
  fireRef.current = fire
  const optsRef = useRef(opts)
  optsRef.current = opts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.isComposing) return
      const root = ref.current?.closest('[data-chat-window]')
      if (!root) return
      const t = e.target as HTMLElement | null
      const inWin = !!t && root.contains(t)
      const idle = !t || t === document.body || t === document.documentElement
      const idleOwnsIt =
        idle &&
        (document.querySelectorAll('[data-chat-window]').length === 1 ||
          (lastActiveChatWindow === root && root.isConnected))
      if (!inWin && !idleOwnsIt) return
      const { ownInput, accept } = optsRef.current
      const isOwn = !!ownInput && !!t?.closest(ownInput)
      if (!isOwn && t && (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement) && t.value.trim()) return
      if (accept && !accept(inWin ? t : null, root)) return
      e.preventDefault()
      e.stopPropagation()
      fireRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [ref])
}

const CardBatchContext = createContext<Ctx | null>(null)
// 攒批条元素本身（inlineBar=false 时由调用方用 <CardBatchBar/> 摆到想要的位置，如悬浮组合器里）
const CardBatchBarContext = createContext<ReactNode>(null)

export function CardBatchBar() {
  return <>{useContext(CardBatchBarContext)}</>
}

/** 动作卡用：拿不到 provider（如员工详情里的静态卡片）就返回 null → 退回「点一下立即发」的老行为 */
export function useCardBatch() {
  return useContext(CardBatchContext)
}

/**
 * 动作卡攒批（一轮里多张「待你拍板」卡，点了先暂存，凑齐后一次性合并回发）。
 *
 * 病根（2026-08-24 老板报）：一轮里菲菲同时出 2 张决策卡，点一张就单独回发一条消息 —— 员工被打断两次、
 * 且第二条到达时他已在处理第一条。旧 app/public UI 早有这套攒批（app.js `cardBatch`），新 shadcn UI 重写时
 * `CardCtx.onStage` 接口留了、**但没有任何调用方接线**，于是攒批能力整块丢了。这里把它补回来，并且
 * 规则沿用旧 UI：**本轮只有一张待处理动作卡 → 点了立即发**（单卡场景零多余点击），有兄弟卡或已暂存 → 进攒批。
 *
 * 每个聊天窗一个实例；`key={runId}` 挂载 → 切会话自然清空（暂存是当前会话的视图态，不该跨会话残留）。
 */
export function CardBatchProvider({
  onSend,
  inlineBar = true,
  children,
}: {
  /** 真正的回发出口；返回 false = 发送失败（如员工忙 409）→ 暂存保留，可重试 */
  onSend: (message: string) => Promise<boolean>
  /** false = 不在 children 之后自动渲染攒批条，改由 <CardBatchBar/> 摆放 */
  inlineBar?: boolean
  children: ReactNode
}) {
  const [staged, setStaged] = useState<StagedItem[]>([])
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  // 「本轮还有几张卡等你处理」——纯计数，不需要触发渲染，故放 ref
  const live = useRef<Set<string>>(new Set())
  const stagedRef = useRef<StagedItem[]>([])
  stagedRef.current = staged
  const finalizers = useRef<Map<string, () => void>>(new Map())

  const registerAction = useCallback((id: string) => {
    live.current.add(id)
    return () => {
      live.current.delete(id)
    }
  }, [])

  const shouldBatch = useCallback(
    () => stagedRef.current.length > 0 || live.current.size > 1,
    [],
  )

  const stage = useCallback((item: StagedItem, markSent: () => void) => {
    finalizers.current.set(item.id, markSent)
    setStaged((prev) => [...prev.filter((s) => s.id !== item.id), item])
  }, [])

  const unstage = useCallback((id: string) => {
    finalizers.current.delete(id)
    setStaged((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const ctx = useMemo<Ctx>(
    () => ({ staged, shouldBatch, registerAction, stage, unstage }),
    [staged, shouldBatch, registerAction, stage, unstage],
  )

  async function send() {
    const items = stagedRef.current.slice()
    if (!items.length) return
    const lines = items.map((d, i) => `${i + 1}. ${d.title ? `【${d.title}】` : ''}${d.reply}`)
    const parts = [`【本轮 ${items.length} 项拍板，一并回复】`, lines.join('\n')]
    if (note.trim()) parts.push(`【总体补充】${note.trim()}`)
    setSending(true)
    try {
      const ok = await onSend(parts.join('\n'))
      if (!ok) return // 失败已由调用方 toast；暂存保留供重试
      for (const d of items) {
        try {
          finalizers.current.get(d.id)?.()
        } catch {
          /* 单张卡收尾失败不连累其它 */
        }
      }
      finalizers.current.clear()
      setStaged([])
      setNote('')
    } finally {
      setSending(false)
    }
  }

  const bar = staged.length > 0 && (
    <BatchBar
      staged={staged}
      note={note}
      onNote={setNote}
      sending={sending}
      onSend={send}
      onUnstage={unstage}
      onReset={() => {
        finalizers.current.clear()
        setStaged([])
        setNote('')
      }}
    />
  )

  return (
    <CardBatchContext.Provider value={ctx}>
      <CardBatchBarContext.Provider value={bar}>
        {children}
        {inlineBar && bar}
      </CardBatchBarContext.Provider>
    </CardBatchContext.Provider>
  )
}

// 攒批条：贴在组合器上方。逐项可撤、可写整批总备注、一键发送。
function BatchBar({
  staged,
  note,
  onNote,
  sending,
  onSend,
  onUnstage,
  onReset,
}: {
  staged: StagedItem[]
  note: string
  onNote: (s: string) => void
  sending: boolean
  onSend: () => void
  onUnstage: (id: string) => void
  onReset: () => void
}) {
  const [noteOpen, setNoteOpen] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend
  const sendingRef = useRef(sending)
  sendingRef.current = sending

  // Ctrl/⌘+Enter 一键「发送 N 项」：攒批条在就生效，不必先点进总体补充框。
  useSendHotkey(barRef, () => {
    if (!sendingRef.current) onSendRef.current()
  }, { ownInput: '[data-batch-note]' })

  return (
    <div ref={barRef} className="border-t border-primary/30 bg-primary/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium">
          已选 <b className="text-primary">{staged.length}</b> 项，待一起发送
        </span>
        <button
          type="button"
          onClick={() => setNoteOpen((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <NotePencilIcon className="size-3" />
          {note.trim() ? '总体补充（已填）' : '加总体补充'}
        </button>
        <div className="ms-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={onReset} disabled={sending}>
            重选
          </Button>
          <Button size="sm" onClick={onSend} disabled={sending} title="Ctrl/⌘+Enter 发送">
            {sending ? <CircleNotchIcon className="animate-spin" /> : <PaperPlaneRightIcon weight="fill" />}
            发送 {staged.length} 项
            <kbd className="ms-0.5 hidden font-sans text-[10px] opacity-70 md:inline">{isMac ? '⌘' : 'Ctrl'}↵</kbd>
          </Button>
        </div>
      </div>
      <div className="grid gap-1">
        {staged.map((s, i) => (
          <div key={s.id} className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <span className="shrink-0 tabular-nums">{i + 1}.</span>
            <span className="min-w-0 flex-1 truncate">
              {s.title && <span className="text-foreground">{s.title} · </span>}
              {s.label}
            </span>
            <button
              type="button"
              onClick={() => onUnstage(s.id)}
              disabled={sending}
              className="shrink-0 underline-offset-2 hover:text-foreground hover:underline"
            >
              撤销
            </button>
          </div>
        ))}
      </div>
      {noteOpen && (
        <Textarea
          value={note}
          onChange={(e) => onNote(e.target.value)}
          autoFocus
          placeholder="对这一整批的补充说明（可选）…　Ctrl/⌘+Enter 发送"
          className="mt-2 max-h-28 min-h-9 resize-none bg-background/60 text-xs"
          // Enter 留给换行；Ctrl/⌘+Enter 整批发送由上面的窗口级监听统一处理
          data-batch-note
        />
      )}
    </div>
  )
}
