import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { usePoll } from '@/hooks/use-poll'
import { useSseEvent } from '@/components/sse-provider'
import { RunDetail } from '@/components/run-detail'
import { raiseCard } from '@/hooks/use-card-stack'
import { useIsMobile } from '@/hooks/use-mobile'
import { applyDockVar, clampDockW, loadDock, saveDock } from '@/hooks/use-dock'
import { mostRecentRun } from '@/lib/run-threads'
import type { Run } from '@/lib/types'

type Ctx = {
  open: (runId: string) => void
  openChat: (employee: string) => void
  // taskFile：开一张「派工到该任务」的新对话（组合器默认派工模式 + 目标档案）
  // lane：从侧栏「工作区」开会话时带上——引擎据此绑定工作区（注入【运行环境】、按工作区过并发闸）
  newChat: (employee: string, taskFile?: string, lane?: string) => void
  // 只读咨询窗：员工正忙时也能开的第二个窗口（零写能力，见 server.js isConsult）
  newConsult: (employee: string) => void
}
const RunDetailContext = createContext<Ctx>({
  open: () => {},
  openChat: () => {},
  newChat: () => {},
  newConsult: () => {},
})
export function useRunDetail() {
  return useContext(RunDetailContext)
}

// cid=卡片实例；emp=该卡片的员工（即便 run 尚未进轮询也能正确显示头像/名字）
// taskFile=开新对话时预置的派工目标档案；consult=这张卡是只读咨询窗（草稿期就要知道，好切界面与发送口径）
type Card = { cid: string; runId: string | null; emp: string; taskFile?: string; consult?: boolean; lane?: string }

// 刷新后恢复刷新前开着的对话框（老板 2026-10-09）：只记有 runId 的卡（草稿没有可恢复的会话）+ 哪张在第三栏。
// 用 sessionStorage：按标签页隔离、刷新保留、关标签即清——多开的标签页 / 手机互不串窗。
const OPEN_KEY = 'ol.openCards.v1'
type Saved = { cards: { runId: string; emp: string; consult?: boolean; lane?: string }[]; docked: string | null }
function loadOpen(): { cards: Card[]; docked: string | null } {
  try {
    const raw = JSON.parse(sessionStorage.getItem(OPEN_KEY) || 'null') as Saved | null
    if (!raw || !Array.isArray(raw.cards)) return { cards: [], docked: null }
    const cards = raw.cards
      .filter((c) => c && typeof c.runId === 'string' && c.runId)
      .map((c, i) => ({ cid: `r${i + 1}`, runId: c.runId, emp: String(c.emp || ''), consult: c.consult || undefined, lane: c.lane }))
    const docked = cards.find((c) => c.runId === raw.docked)?.cid ?? null
    return { cards, docked }
  } catch {
    return { cards: [], docked: null }
  }
}
function saveOpen(cards: Card[], dockedCid: string | null) {
  try {
    const keep = cards.filter((c) => c.runId)
    const saved: Saved = {
      cards: keep.map((c) => ({ runId: c.runId as string, emp: c.emp, consult: c.consult, lane: c.lane })),
      docked: keep.find((c) => c.cid === dockedCid)?.runId ?? null,
    }
    sessionStorage.setItem(OPEN_KEY, JSON.stringify(saved))
  } catch { }
}

function stub(employee: string, id = '', consult = false): Run {
  return {
    id, employee, taskFile: null, model: null, instruction: '', status: id ? '' : 'draft',
    sessionId: null, chainDepth: 0, callerRunId: null, threadRootId: id, startedAt: '', updatedAt: '',
    consult: consult || undefined,
  }
}

export function RunDetailProvider({ children }: { children: ReactNode }) {
  const { data: runs, refresh } = usePoll<Run[]>('/api/runs', 15000)
  // 会话标题旁路生成完（~5s）就换名，别让卡头等到下一轮 15s 轮询才从指令摘要变成标题
  useSseEvent('run-title', () => refresh())
  const restored = useRef<ReturnType<typeof loadOpen> | null>(null)
  if (!restored.current) restored.current = loadOpen()
  const [cards, setCards] = useState<Card[]>(restored.current.cards)
  // cardsRef 是**同步**镜像（不是渲染期赋值的那种）：所有增删都先写它、再 setState。
  // 为什么必须同步：StrictMode 会把 effect 双跑，DeepLink 的 openRun 因此在同一 tick 里被调两次；
  // 渲染期镜像那时还是旧值，第二次会误判「这条会话还没开」而另起一个 cid —— 卡片被 setCards 里的
  // 去重挡住没多开，但 dockedCid 却指向了那个不存在的 cid，于是「外壳留了一条空白栏、里面没有卡」。
  const cardsRef = useRef<Card[]>(restored.current.cards)
  const setCardsSync = useCallback((fn: (cs: Card[]) => Card[]) => {
    cardsRef.current = fn(cardsRef.current)
    setCards(cardsRef.current)
  }, [])
  const seq = useRef(0)

  // ---- 停靠（主页面右侧第三栏）----
  // dockOn = 用户想要停靠模式（工作区偏好，持久化）；dockedCid = 当前占着第三栏的那张卡（瞬态）。
  // 「第三栏占住就钉住」（老板 2026-08-24 改口径，推翻 08-21 的「后开即换内容」）：第三栏一旦有卡占着，
  // 再点员工头像/看板卡片开的会话一律走**浮动 popup**，第三栏那张原地不动（它通常是正在盯的主线，
  // 被顺手一点就换掉等于把上下文冲没了）。只有第三栏**空着**时（模式开着但没人占），新开的会话才落进去。
  // 想换第三栏的内容 → 走标题栏的停靠开关显式换。同时只停靠一张。
  const isMobile = useIsMobile()
  const [dock, setDock] = useState(loadDock)
  // 恢复的停靠卡只在停靠模式仍开着时才进第三栏，否则按浮动窗恢复
  const [dockedCid, setDockedCid] = useState<string | null>(() => (dock.on ? restored.current!.docked : null))
  const dockRef = useRef(dock)
  dockRef.current = dock
  // dockedCid 的**同步**镜像。与 cardsRef 同理：StrictMode / 同一 tick 内连开两张时，渲染期镜像还是旧值，
  // 会把「第三栏空着」误判成真、让两张卡都去抢第三栏（后写的赢，前一张变成没人认领的孤儿）。
  const dockedCidRef = useRef<string | null>(dockedCid)
  const setDockedCidSync = useCallback((cid: string | null) => {
    dockedCidRef.current = cid
    setDockedCid(cid)
  }, [])
  // 第三栏此刻空不空：模式开着、且没有任何一张真实存在的卡占着它（cid 记账偏差也算空，见 cardsRef 注释）
  const dockSlotFree = useCallback(
    () => dockRef.current.on && !cardsRef.current.some((c) => c.cid === dockedCidRef.current),
    [],
  )
  // 停靠中才占位；移动端恒为 0（<768px 没有第三栏的空间，聊天仍走全屏页）。
  // 不变量：**必须真有这张卡**才占位——否则一旦 cid 记账出偏差，就会留出一条空白栏（踩过，见上方 cardsRef 注释）。
  const dockActive = !isMobile && cards.some((c) => c.cid === dockedCid)
  useEffect(() => {
    applyDockVar(dockActive ? dock.w : 0)
  }, [dockActive, dock.w])
  // 窗口变窄时重新钳宽，别让第三栏把主内容挤没
  useEffect(() => {
    if (!dockActive) return
    const onResize = () => setDock((d) => ({ ...d, w: clampDockW(d.w) }))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [dockActive])

  // 新开一张卡：第三栏空着就落进去，否则就是浮动 popup（新卡进场自带最高 z，见 use-card-stack）
  const addCard = useCallback(
    (card: Omit<Card, 'cid'>) => {
      const cid = `c${++seq.current}`
      const takeDock = dockSlotFree() // 必须在插卡**之前**判，插完自己也在 cards 里了
      setCardsSync((cs) => [...cs, { ...card, cid }])
      if (takeDock) setDockedCidSync(cid)
    },
    [dockSlotFree, setCardsSync, setDockedCidSync],
  )
  // 已开着的卡再被点到：不新开，也**不抢第三栏**——已在第三栏的原地不动，浮动的抬到最前
  // （老板「再次点员工 → 窗口置顶」）；只有第三栏空着时才顺势把它落进去。
  const focusCard = useCallback(
    (cid: string) => {
      if (cid === dockedCidRef.current) return
      if (dockSlotFree()) setDockedCidSync(cid)
      else raiseCard(cid)
    },
    [dockSlotFree, setDockedCidSync],
  )

  const openRun = useCallback(
    (id: string, emp = '') => {
      const existing = cardsRef.current.find((c) => c.runId === id)
      if (existing) return focusCard(existing.cid)
      addCard({ runId: id, emp })
    },
    [addCard, focusCard],
  )
  const newChat = useCallback(
    (employee: string, taskFile?: string, lane?: string) => {
      addCard({ runId: null, emp: employee, taskFile, lane })
    },
    [addCard],
  )
  // 只读咨询窗：该员工已有一张开着的只读卡 → 抬到最前（引擎侧同样只允许一条在跑，见 liveConsultFor）
  const newConsult = useCallback(
    (employee: string) => {
      const existing = cardsRef.current.find((c) => c.consult && c.emp === employee)
      if (existing) return focusCard(existing.cid)
      addCard({ runId: null, emp: employee, consult: true })
    },
    [addCard, focusCard],
  )
  // 点员工＝打开「最近一次」对话（按时间，忽略置顶）；没有则空白新对话
  const openChat = useCallback(
    (employee: string) => {
      const recent = mostRecentRun(runs, employee)
      if (recent) openRun(recent.id, employee)
      else newChat(employee)
    },
    [runs, openRun, newChat],
  )
  const close = useCallback(
    (cid: string) => {
      // 关掉停靠栏里的会话 → 第三栏收起（变量归 0、主内容恢复满宽），但**停靠模式保留**：
      // 它是工作区偏好，下次开会话仍进第三栏（此时栏空着，正是唯一会自动落位的时机）。
      if (dockedCidRef.current === cid) setDockedCidSync(null)
      setCardsSync((cs) => cs.filter((c) => c.cid !== cid))
    },
    [setCardsSync, setDockedCidSync],
  )
  // 标题栏的停靠开关：未停靠 → 把这张卡放进第三栏并开启模式；已停靠这张 → 关模式，卡按原保存几何弹回浮动。
  // **这是换第三栏内容的唯一显式入口**。
  // 换栏语义是**替换**而非让位（老板 2026-09-01：「直接替换右侧原来窗口即可，不需要把右侧窗口弹出来」）：
  // 原来占着第三栏的那张直接关掉，不再弹回浮动窗——否则每换一次栏就凭空多一张盖在页面上的浮窗、
  // 还得再手动关一次；而 run 本身在引擎侧不受影响，想找回从会话列表/员工头像重开即可。
  const toggleDock = useCallback(
    (cid: string) => {
      const prev = dockedCidRef.current
      const next = prev === cid ? null : cid
      setDockedCidSync(next)
      if (next && prev && prev !== cid) setCardsSync((cs) => cs.filter((c) => c.cid !== prev))
      setDock((d) => {
        const s = { on: next !== null, w: clampDockW(d.w) }
        saveDock(s)
        return s
      })
    },
    [setCardsSync, setDockedCidSync],
  )
  // 拖左边缘缩放：松手才提交（拖动期间由 FloatingCard 逐帧直写 DOM + CSS 变量）
  const setDockW = useCallback((w: number) => {
    setDock((d) => {
      const s = { ...d, w: clampDockW(w) }
      saveDock(s)
      return s
    })
  }, [])
  const switchRun = useCallback(
    (cid: string, id: string) => {
      setCardsSync((cs) => cs.map((c) => (c.cid === cid ? { ...c, runId: id } : c)))
      refresh() // 刚创建的 run 尽快进轮询、解析出真身
    },
    [refresh, setCardsSync],
  )

  // 开着哪些卡变了就记一笔，供刷新后恢复
  useEffect(() => {
    saveOpen(cards, dockedCid)
  }, [cards, dockedCid])
  // 恢复回来的会话若已被删除：首轮拉到列表后把它们剔掉（别留一张空壳窗）
  const pruned = useRef(false)
  useEffect(() => {
    if (pruned.current || !runs) return
    pruned.current = true
    const ids = new Set(runs.map((r) => r.id))
    const gone = new Set(restored.current!.cards.filter((c) => c.runId && !ids.has(c.runId)).map((c) => c.cid))
    if (!gone.size) return
    if (dockedCidRef.current && gone.has(dockedCidRef.current)) setDockedCidSync(null)
    setCardsSync((cs) => cs.filter((c) => !gone.has(c.cid)))
  }, [runs, setCardsSync, setDockedCidSync])

  function resolve(card: Card): Run {
    if (card.runId) {
      const found = runs?.find((r) => r.id === card.runId)
      // 轮询还没拉到时，用卡片记住的 emp 兜底，避免头像/名字空白
      return found ?? stub(card.emp, card.runId, card.consult)
    }
    return stub(card.emp, '', card.consult)
  }

  return (
    <RunDetailContext.Provider value={{ open: openRun, openChat, newChat, newConsult }}>
      {children}
      {cards.map((card, i) => (
        <RunDetail
          key={card.cid}
          stackId={card.cid}
          run={resolve(card)}
          runs={runs}
          open
          index={i}
          consult={card.consult}
          onOpenChange={(o) => !o && close(card.cid)}
          onRunCreated={(id) => switchRun(card.cid, id)}
          onSwitch={(id) => switchRun(card.cid, id)}
          onNewChat={newChat}
          onNewConsult={newConsult}
          onPinned={refresh}
          initialTaskFile={card.taskFile}
          initialLane={card.lane}
          docked={dockActive && card.cid === dockedCid}
          dockW={dock.w}
          onToggleDock={() => toggleDock(card.cid)}
          onDockWidth={setDockW}
        />
      ))}
    </RunDetailContext.Provider>
  )
}
