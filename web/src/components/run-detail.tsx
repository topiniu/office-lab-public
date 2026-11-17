import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  PaperPlaneRightIcon,
  StopIcon,
  PushPinIcon,
  TrashIcon,
  LightningIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ShieldCheckIcon,
  PaperclipIcon,
  CaretDownIcon,
  PlusIcon,
  CopyIcon,
  CircleNotchIcon,
  DotsThreeIcon,
  EyeIcon,
  GitBranchIcon,
  EyeSlashIcon,
  ClipboardTextIcon,
  XIcon,
  BriefcaseIcon,
  ChatCircleIcon,
  CheckIcon,
  ListBulletsIcon,
  PencilSimpleIcon,
  ArrowsClockwiseIcon,
} from '@phosphor-icons/react'
import { toast } from 'sonner'

import { FloatingCard } from '@/components/floating-card'
import { EngineHandoverDialog } from '@/components/engine-handover-dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { EmployeeAvatar, EmployeeStatusBadge } from '@/components/employee-avatar'
import { Transcript } from '@/components/transcript'
import { CardBatchProvider, CardBatchBar } from '@/components/card-batch'
import { QuickPhraseBar } from '@/components/quick-phrase-bar'
import { useAttachments, AttachmentBar } from '@/components/attachments'
import { ComposerExtras } from '@/components/composer-extras'
import { QuickActions } from '@/components/quick-actions'
import { parseChatlog, chatlogChipLabel, type ParsedChatlog } from '@/lib/chatlog'
import { wrapChatlog } from '@/lib/markers'
import { dispatchLead } from '@/lib/dispatch'
import { PatrolBanner } from '@/components/patrol-banner'
import { SessionDrawer, type DrawerFilter } from '@/components/session-drawer'
import { useRunStream } from '@/hooks/use-run-stream'
import { usePoll } from '@/hooks/use-poll'
import { useEmployees } from '@/hooks/use-employees'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSseEvent } from '@/components/sse-provider'
import { isLive, runLabel, runVariant, empState, EMP_STATE_LABEL } from '@/lib/status'
import { apiGet, apiPost, apiDelete, ApiError } from '@/lib/api'
import type { Notifications, TaskFile } from '@/lib/types'
import type { LanesResponse, Run, SseEvent } from '@/lib/types'

// 任务档案短标签：版本号 + 标题（无标题回退到去日期前缀的文件名），供选择器与已选态展示。
function taskLabel(t: TaskFile): string {
  const fm = t.frontmatter
  const v = fm.version ? `${fm.version} ` : ''
  const name = fm.task || t.file.replace(/^.*\//, '').replace(/\.md$/, '')
  return `${v}${name}`
}

// 任务档案的「活动时间」——与 server.js /api/tasks 的排序口径同一套：frontmatter.updated（引擎每次写档都刷）
// 优先，缺失回退到文件名里的日期。存量档案的 updated 后面常跟一长段行尾说明，故只取开头那个日期/时间戳。
function taskTime(t: TaskFile): string {
  const m = /\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/.exec(String(t.frontmatter.updated ?? ''))
  if (m) return m[0].replace('T', ' ')
  const d = /\d{4}-\d{2}-\d{2}/.exec(t.file)
  return d ? d[0] : ''
}

type Perm = { reqId: string; toolName?: string; brief?: string; title?: string }

export function RunDetail({
  run,
  runs,
  open,
  index = 0,
  onOpenChange,
  onRunCreated,
  onSwitch,
  onNewChat,
  onNewConsult,
  onPinned,
  initialTaskFile,
  initialLane,
  stackId,
  consult: consultCard,
  docked,
  dockW,
  onToggleDock,
  onDockWidth,
}: {
  run: Run | null
  runs?: Run[]
  open: boolean
  index?: number
  onOpenChange: (o: boolean) => void
  onRunCreated?: (id: string) => void
  onSwitch?: (id: string) => void
  onNewChat?: (employee: string, taskFile?: string) => void
  onNewConsult?: (employee: string) => void
  onPinned?: () => void
  initialTaskFile?: string
  // 从侧栏「工作区」开的草稿：首次发送时把 lane 带给 /api/dispatch（已建 run 后以 run.lane 为准）
  initialLane?: string
  stackId?: string
  // 这张卡是「只读咨询窗」（草稿期由卡片标记带入；已建 run 后以 run.consult 为准）
  consult?: boolean
  // 停靠态（主页面右侧第三栏）——四个 prop 原样透给 FloatingCard，见 hooks/use-dock.ts
  docked?: boolean
  dockW?: number
  onToggleDock?: () => void
  onDockWidth?: (w: number) => void
}) {
  const { employees } = useEmployees()
  // 运行环境徽标的展示名：与侧栏共用 /api/lanes 的合流轮询（interval=0 不另起轮询，只吃缓存）
  const { data: lanesData } = usePoll<LanesResponse>('/api/lanes', 0)
  const isMobile = useIsMobile()
  const isDraft = !!run && !run.id
  // 只读咨询窗：草稿期看卡片标记；一旦有真 run 就**只认 run.consult**——否则从只读卡里切到一条正式历史会话时，
  // 卡片标记会残留、把正式会话误画成只读（run 尚未进轮询时 provider 的 stub 已带上 consult，不会闪）。
  const isConsult = !!run && !run.id ? !!consultCard : !!run?.consult
  const runId = open && run && run.id ? run.id : null
  const { events, runStatus, hasMore, loadingEarlier, loadEarlier } = useRunStream(runId)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  // 派工/对话不再是手动切换的「模式」，而是由「有没有挂任务档案」自动判定：
  // 选了档案 → 派工（kind:dispatch + taskFile）；没选 → 普通对话（kind:chat）。选择器常驻，不再时隐时现。
  // 默认档案：本 run 已绑定的 taskFile，或从任务卡开聊预置的 initialTaskFile。
  const [selectedTaskFile, setSelectedTaskFile] = useState<string>(run?.taskFile || initialTaskFile || '')
  // 只读窗没有派工语义（引擎侧 reply 也会强制按对话处理），故恒为对话模式、并隐藏档案选择器
  const dispatchMode = !isConsult && !!selectedTaskFile
  // 任务档案列表按需拉取（打开选择器时才取，避免每个常驻聊天窗都后台轮询）
  const [tasks, setTasks] = useState<TaskFile[] | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  function loadTasks() {
    apiGet<TaskFile[]>('/api/tasks?slim=1').then(setTasks).catch(() => setTasks([])) // 选择器只用档案名，不要 facet 明细
  }
  // 粘贴的聊天记录抽象成待发 chip（不直接塞进输入框），发送时才拼进消息（对齐旧 UI pendingChatlogs）
  const [pendingChatlogs, setPendingChatlogs] = useState<ParsedChatlog[]>([])
  const [perms, setPerms] = useState<Perm[]>([])
  // 每条审批的拒绝理由（可选，批量拒绝时各行沿用自己填的那条）+「全部允许」二次确认
  const [permReason, setPermReason] = useState<Record<string, string>>({})
  const [confirmAllowAll, setConfirmAllowAll] = useState(false)
  // 本轮是否正在生成：thinking_tokens / 工具活动只走全局 run-activity 广播、不落 per-run 事件流
  // （server.js「只广播不落库」），故订阅它补一个「本轮在跑」信号——收到活动即点亮、下条 result 落地归零。
  const [liveActivity, setLiveActivity] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [handoverOpen, setHandoverOpen] = useState(false)
  // 会话标题就地改名：null = 不在编辑；字符串 = 编辑中的草稿（卡头第二行变输入框）
  const [titleDraft, setTitleDraft] = useState<string | null>(null)
  const renamingRef = useRef(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  // 会话抽屉（取代原「历史会话」下拉）：标题栏按钮打开「全部」，「N 在跑」胶囊打开时直接落在「在跑」
  const [drawer, setDrawer] = useState<null | DrawerFilter>(null)
  // 默认「精简过程」：两条正文之间的思考/工具/后台通知收成一行步骤摘要（见 transcript.tsx ProcessGroup）；「显示全部过程」逐条铺开。偏好持久化
  const [showProcess, setShowProcess] = useState(() => localStorage.getItem('ol-show-process') === '1')
  const toggleProcess = () =>
    setShowProcess((v) => {
      const next = !v
      localStorage.setItem('ol-show-process', next ? '1' : '0')
      return next
    })
  const attach = useAttachments()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const replyTaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  // 「回到最新」平滑滚动进行中（见 scrollToBottom）：途中的 scroll 事件不改跟随态
  const autoScrolling = useRef(false)
  const stick = useRef(true)
  // 最近一次「程序贴底」落到的 scrollTop（浏览器钳过的真实值），供 onScroll 辨认自己滚的那一跳
  const pinnedTop = useRef(-1)
  // 滚动未贴底时显「回到最新」浮钮：stick 是 ref（不触发重渲染），另用 state 驱动浮钮显隐
  const [atBottom, setAtBottom] = useState(true)
  // 滚动容器的 DOM 节点（state 版）：停靠/取消停靠时整窗会被重建，挂在它上面的观察器必须跟着换新节点，
  // 只在首挂时 attach 一次会一直盯着那个已脱离的旧节点（2026-10-07 实测：停靠后底座量成 0 高，末张卡被盖）。
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  // 必须是稳定引用：每次渲染换一个新函数，React 会在每次提交时先传 null 再传节点，观察器跟着反复拆装
  const setScrollNode = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el
    setScrollEl(el)
  }, [])
  // 输入框按内容增高：Chromium 走 CSS field-sizing-content；不支持的浏览器（如部分 Safari）这里手动量高兜底，
  // 上限与 className 里的 max-h-[200px] 一致，超出后框内滚动。
  useLayoutEffect(() => {
    const ta = replyTaRef.current
    if (!ta || CSS.supports?.('field-sizing', 'content')) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight + 2, 200)}px`
  }, [reply])

  // 整窗拖拽收附件：拖到本聊天窗口任意处（不只底部组合器）即入「本窗会话」的附件区。
  // 每个聊天窗口是独立的 RunDetail 实例、各自持有独立的 attach —— 因此天然「拖到哪个窗口就进哪个会话」。
  // 用 dragenter/dragleave 计数消抖：在子元素之间穿梭时 enter/leave 成对触发，计数归零才隐藏遮罩，避免闪烁。
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  const dtHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files')
  function onWinDragEnter(e: React.DragEvent) {
    if (!dtHasFiles(e)) return
    dragDepth.current += 1
    setDragOver(true)
  }
  function onWinDragOver(e: React.DragEvent) {
    if (!dtHasFiles(e)) return
    e.preventDefault() // 必须阻止默认，drop 才会触发
    e.dataTransfer.dropEffect = 'copy'
  }
  function onWinDragLeave(e: React.DragEvent) {
    if (!dtHasFiles(e)) return
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragOver(false)
    }
  }
  function onWinDrop(e: React.DragEvent) {
    dragDepth.current = 0
    setDragOver(false)
    if (!dtHasFiles(e)) return
    e.preventDefault()
    attach.addFiles(e.dataTransfer.files)
  }

  // 权限请求（全局 SSE，按 runId 过滤）
  useSseEvent('permission-request', (ev: SseEvent) => {
    if (ev.runId !== runId) return
    setPerms((p) => [...p, { reqId: String(ev.reqId), toolName: ev.toolName as string, brief: ev.brief as string, title: ev.title as string }])
  })
  useSseEvent('permission-resolved', (ev: SseEvent) => {
    if (ev.runId !== runId) return
    setPerms((p) => p.filter((x) => x.reqId !== ev.reqId))
  })
  // 本轮活动（思考/工具）到达 → 点亮「正在生成」，并用作气泡文案（比 15s 轮询的 run.activity 实时）
  useSseEvent('run-activity', (ev: SseEvent) => {
    if (ev.runId !== runId) return
    setLiveActivity((ev.activity as string) || '处理中…')
  })
  // 新一轮开跑（含 resume / 排队消息被接 / 自动续跑）：run-activity 要等到「活动文案变化」才发，
  // 中间可能空窗很久；run-status 转 running 是「本轮已开跑」的第一手信号，先点亮兜底文案，
  // 等真正的 run-activity 到了再覆盖。转终态则归零（此时 live 也已为 false，双保险）。
  useSseEvent('run-status', (ev: SseEvent) => {
    if (ev.runId !== runId) return
    const st = String(ev.status ?? '')
    setLiveActivity((a) => (st === 'running' || st === 'starting' ? (a ?? '处理中…') : null))
  })
  useEffect(() => {
    if (!open || !runId) {
      setPerms([])
      return
    }
    // 重新打开已被挂起（等审批）的 run 时，从通知中心补回待处理权限，否则会话被卡死
    apiGet<Notifications>('/api/notifications')
      .then((n) =>
        setPerms(
          (n.pending || [])
            .filter((p) => p.runId === runId)
            .map((p) => ({ reqId: p.reqId, toolName: p.toolName, brief: p.brief })),
        ),
      )
      .catch(() => {})
  }, [open, runId])

  /* 贴底：直接写 scrollTop（不用 scrollIntoView —— 它依赖哨兵元素已完成布局、还会连带滚动祖先），
     并记下浏览器钳完的真实值给 onScroll 认领「这一跳是我们自己滚的」。 */
  function pinNow() {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    pinnedTop.current = el.scrollTop
  }
  /* markdown / 动作卡 / 图片都是异步撑开的，只贴一次会落在半中间 —— 沿用旧 UI 的三连补贴
     （app.js scrollChatToBottom：本帧 + 下一帧 + 120ms）。图片另有下面的 load 捕获兜底。 */
  function pinSoon() {
    pinNow()
    requestAnimationFrame(pinNow)
    setTimeout(pinNow, 120)
  }

  // 往前翻页（加载更早）：保持阅读位置不动。
  // 病根（2026-10-06 老板：「好像是从头开始加载」）：更早的一页插在顶部，scrollTop 还停在 0，视口当场被甩到
  // 新一页的**最老**那条（实测一页 25 条撑高 ~8800px）——读起来就像从会话开头往下翻。
  // 对策：内容插进来后，按「顶部多出来的高度」把 scrollTop 往下补同样的量（本帧 + 下一帧 + 120ms，盖住 markdown 异步撑高）。
  // ⚠ 只补「增量」，不回到「发请求那一刻的位置」：2026-10-07 老板报「chat box 滚动有问题」——原先拉之前记下距底部的
  // 距离、插入后把 scrollTop 写死回那个位置，请求在途时老板已往下滚，内容一到就被拽回顶部附近；短会话整个滚动范围
  // 都落在「<240px 触发翻页」区里，每滚一下都触发一次，读起来就是「滚不动 / 往回弹」。
  const anchorH = useRef<number | null>(null) // 上次量到的 scrollHeight；null = 不在翻页补偿中
  function restoreAnchor() {
    const el = scrollRef.current
    if (!el || anchorH.current == null) return
    const grew = el.scrollHeight - anchorH.current
    if (grew > 0) el.scrollTop += grew
    anchorH.current = el.scrollHeight
  }
  useLayoutEffect(() => {
    if (anchorH.current == null) return
    restoreAnchor()
    requestAnimationFrame(restoreAnchor)
    const t = setTimeout(() => {
      restoreAnchor()
      anchorH.current = null
    }, 120)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events])
  function loadOlder() {
    const el = scrollRef.current
    if (!el || loadingEarlier || !hasMore || !events.length) return
    anchorH.current = el.scrollHeight
    // 兜底清锚：这页若一条新事件都没有（events 不变 → 上面的 layout effect 不跑），锚点会一直挂着、挡住后续自动翻页
    loadEarlier().finally(() => setTimeout(() => (anchorH.current = null), 200))
  }

  // 新消息（含历史回放的逐条到达）→ 跟随态就贴底
  useEffect(() => {
    if (stick.current) {
      pinNow()
      requestAnimationFrame(pinNow)
    }
  }, [events])

  // 开窗 / 切会话：无条件回到「跟随最新」并贴底（老板 2026-09-01：点员工开聊天窗应直接落在最底下）。
  // 必须显式重置 stick —— 同一张卡切到另一条会话时，上一条被翻上去留下的 stick=false 会让新会话停在顶部。
  useEffect(() => {
    stick.current = true
    setAtBottom(true)
    pinSoon()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  // 内容在原地变高（动作卡/markdown/代码块异步排版、展开过程组）时，跟随态要补贴底——这类变化不产生新事件，
  // 只靠 [events] 那个 effect 贴不到，最后一张卡会停在半截被底座盖住。ResizeObserver 盯消息区的每个直接子元素，
  // MutationObserver 负责新增子元素时补挂。容器本身也盯：输入框增高 / 审批条出现会把消息区压矮，跟随态同样要补贴底。
  useEffect(() => {
    const el = scrollEl
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stick.current && !autoScrolling.current) pinNow()
    })
    ro.observe(el)
    const observeAll = () => Array.from(el.children).forEach((c) => ro.observe(c, { box: 'border-box' }))
    observeAll()
    const mo = new MutationObserver(observeAll)
    mo.observe(el, { childList: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl])

  // 图片/缩略图加载完会再撑高一次，此时要补贴底。load 事件不冒泡，故在滚动容器上走捕获阶段统一收，
  // 比「开窗那一刻逐个 img 挂 onload」更稳（后到的消息里的图片一样覆盖得到）。
  useEffect(() => {
    const el = scrollEl
    if (!el) return
    const onLoad = () => {
      if (stick.current) pinNow()
    }
    el.addEventListener('load', onLoad, true)
    return () => el.removeEventListener('load', onLoad, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl])

  // 末条有意义事件（忽略 lab/system 噪声）——供「本轮是否在生成」判定与气泡显隐
  const lastMeaningful = [...events].reverse().find((e) => e.type !== 'lab' && e.type !== 'system' && e.type !== 'handoff')
  // 切换会话时清空；本轮 result 落地 → 归零 liveActivity（下一轮 run-activity 再点亮）
  useEffect(() => { setLiveActivity(null) }, [runId])
  // 切换会话（或改从任务卡预置）时，把档案选择回落到该会话的默认档案
  useEffect(() => {
    setSelectedTaskFile(run?.taskFile || initialTaskFile || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, initialTaskFile])
  useEffect(() => {
    if (lastMeaningful?.type === 'result') setLiveActivity(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMeaningful?.type, lastMeaningful?._seq])

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    if (autoScrolling.current) return
    // 「算贴底」的容差 32px＝消息区底部留白里超出底座的那一截：再多一点，最后一条就有内容压在输入框底下了。
    // 原先是 100px——悬浮底座后，差 100px 意味着一张卡的下半截被盖住，却既不跟随、也不出「回到最新」浮钮（2026-10-07 老板报「消息卡片在最下面的时候会被遮挡」）。
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    // 自己贴底那一跳派发的 scroll 事件不参与「用户是不是上翻了」的判定：scroll 是异步派发的，
    // 派发时内容常已被后续消息/图片撑高，量出来成了「没贴底」——曾因此把跟随态永久打成 false
    // （表现：开窗停在半中间、后续消息也不再自动跟随）。scrollTop 仍等于我们写进去的值即认领为自己滚的。
    if (!bottom && el.scrollTop === pinnedTop.current) return
    stick.current = bottom
    setAtBottom(bottom)
    // 上翻到接近顶部 → 自动接着往前拉一页（像 IM 一样无感翻页；顶部按钮保留作兜底）。
    // 贴底跟随态（刚开窗 / 回放中）不触发；锚点恢复中的那一跳也不重复触发。
    if (!stick.current && el.scrollTop < 240 && anchorH.current == null) loadOlder()
  }

  // 一键回到最新：滚到底 + 恢复贴底跟随（后续新消息继续自动跟随）
  // 滚到容器真正的底（scrollHeight），而不是 scrollIntoView(bottomRef)：输入框改悬浮后消息区底部有一段 paddingBottom
  // 给底座让位，哨兵在留白之上——对准哨兵会停在差一截的地方，最后几行仍压在输入框底下（2026-10-07 老板报）。
  // 平滑滚动途中内容若又撑高（markdown/图片），落地后再补一次贴底。
  function scrollToBottom() {
    const el = scrollRef.current
    if (!el) return
    stick.current = true
    setAtBottom(true)
    // 平滑滚动途中的 scroll 事件不算「用户上翻」（不然半路就把跟随态打成 false）：落地（scrollend，旧浏览器 900ms 兜底）后贴死底
    autoScrolling.current = true
    const land = () => {
      if (!autoScrolling.current) return
      autoScrolling.current = false
      el.removeEventListener('scrollend', land)
      stick.current = true
      setAtBottom(true)
      pinNow()
    }
    el.addEventListener('scrollend', land)
    setTimeout(land, 900)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // useCallback + 下面 focusReply 同理：这俩作为 props 进 <Transcript>（memo），也是它内部 useMemo 的依赖。
  // 以前每次渲染都是新函数 → 输入框每敲一个字整条会话重建一遍（长会话打字卡顿的根因，2026-10-19）。
  const runIdForReply = run?.id
  const replyText = useCallback(async (text: string): Promise<boolean> => {
    try {
      await apiPost(`/api/runs/${runIdForReply}/reply`, { message: text, kind: 'chat' })
      toast.success('已回发')
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error('员工忙，稍后重试')
      } else {
        toast.error('回发失败', { description: (e as Error).message })
      }
      return false
    }
  }, [runIdForReply])
  const focusReply = useCallback(() => replyTaRef.current?.focus(), [])

  if (!run) return null
  const emp = employees[run.employee]
  // 任务档案选择器：**一律按活动时间倒序**，最新的在最上面。
  // 原来先把「本员工负责的」整组提到最前，结果最新档案被挤到列表中段——本机 23 份档案里 owner=菲菲 的有 5 份，
  // 在菲菲窗口打开选择器时，当天刚更新的 v0.1.0 落到第 6 位（2026-09-09 老板反馈「没有按照时间排序」）。
  // 挂档案是照「我最近在弄哪个版本」找的，owner 只是档案上的一个字段，不该改变时间轴。
  const sortedTasks = (tasks ?? [])
    .slice()
    .sort((a, b) => taskTime(b).localeCompare(taskTime(a)) || b.file.localeCompare(a.file))
  // 已选档案的展示名：命中列表用标题，否则回退到去路径/后缀的文件名
  const selectedTask = tasks?.find((t) => t.file === selectedTaskFile)
  const selectedLabel = selectedTaskFile
    ? selectedTask
      ? taskLabel(selectedTask)
      : selectedTaskFile.replace(/^.*\//, '').replace(/\.md$/, '')
    : '对话'
  const status = runStatus ?? run.status
  const live = isLive({ ...run, status })
  // 「会话仍在线(live)」≠「本轮正在生成」：常驻流式 query 收工后 run 仍是 running，
  // 但末条有意义事件是 result（本轮收工），此时不该再显「正在思考…」。
  // 反向陷阱：新一轮已开跑、还没吐第一条 assistant/tool 事件的「思考前奏」里，末条有意义事件仍是上一轮的 result，
  // 而思考/工具活动只走全局 run-activity 广播、不落 per-run 流——只看 lastMeaningful 会在这段（可能很长）漏掉气泡
  // （头像在动、却没有「正在思考…」）。
  // 故「本轮在生成」取三个互补信号的并集，任一为真即认：
  //  ① liveActivity —— run-activity / run-status 广播（最实时）；
  //  ② run.activity —— 轮询快照。★ 必不可少：引擎只在**活动文案变化时**才广播 run-activity
  //     （server.js `if (activity !== run.activity)`），所以「开窗那一刻」和「长工具调用期间」一条广播都收不到，
  //     liveActivity 恒 null；而 run.activity 开跑即非空、onTurnComplete/中断/出错都会清空，正是这段盲区的可靠快照。
  //     （2026-08-20 老板报「员工明明在跑、聊天窗没气泡」的根因：漏了这一路，只把 run.activity 当文案用。）
  //  ③ 末条有意义事件不是 result —— 本轮已吐过内容。
  // 反向不会误显：收工时 run-status 走 SSE 即刻把 live 打成 false，气泡先于轮询消失，不吃 activity 的 10s 滞后。
  const activelyThinking = live && (liveActivity !== null || !!run.activity || lastMeaningful?.type !== 'result')
  // 头像状态徽标：与侧栏同口径（该员工整体状态）——非草稿时才显
  const headerSt = isDraft || run.employee === 'chaorenq' ? null : empState(runs, run.employee)

  // overrideText：快捷动作按钮走这条——直接发引擎给的整段指令，绕过输入框但**复用后面所有动线**
  // （草稿建 run / 并发闸 409 降级到只读窗 / 忙碌提示）。刻意不另写一条发送路径：那样这些分支
  // 迟早要各自维护一份，而它们每一条都是踩出来的（见下面 catch 里的注释）。
  async function send(takeover = false, overrideText?: string) {
    // 附件还在传（大段粘贴转附件也走上传）时先别发，不然这条消息会漏掉它
    if (attach.busy && !overrideText) {
      toast.info('附件上传中，稍等一下再发')
      return
    }
    // 发送时才把待发聊天记录用哨兵包裹拼进消息（各自独立成块）
    const chatlogBlocks = pendingChatlogs.map((c) => wrapChatlog(c.raw)).join('\n\n')
    const parts = overrideText
      ? [overrideText]
      : [reply.trim(), attach.markers(), chatlogBlocks].filter(Boolean)
    const msg = parts.join('\n\n') || (takeover ? '继续' : '')
    // 快捷短语 / 快捷动作发的是一段现成的话（overrideText），跟输入框无关——别把老板写了一半的草稿和附件一起清掉
    const clearComposer = () => {
      if (overrideText) return
      setReply('')
      attach.clear()
      setPendingChatlogs([])
    }
    if (!msg) return
    setSending(true)
    try {
      // 挂了任务档案 → 派工；没挂 → 普通对话。二者共用同一套 kind/taskFile 推导。（只读窗恒对话）
      const dispatch = dispatchMode
      if (isDraft) {
        // 空白对话：首次发送创建 run。只读窗带 consult:true——引擎据此跳过并发闸、给零写能力的权限档。
        const res = await apiPost<{ runId: string }>('/api/dispatch', {
          employee: run!.employee,
          instruction: msg,
          kind: dispatch ? 'dispatch' : 'chat',
          taskFile: dispatch ? selectedTaskFile : undefined,
          consult: isConsult || undefined,
          lane: !isConsult && initialLane ? initialLane : undefined,
        })
        clearComposer()
        onRunCreated?.(res.runId)
      } else {
        await apiPost(`/api/runs/${run!.id}/reply`, {
          message: msg,
          takeover: takeover || undefined,
          kind: dispatch ? 'dispatch' : 'chat',
          taskFile: dispatch ? selectedTaskFile : undefined,
        })
        clearComposer()
        if (takeover) toast.success('已接管')
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as { error?: string; runId?: string }
        if (body?.error === 'consult exists') {
          toast.error('已有一条只读会话在跑', { description: '先用那个窗口，或等它答完' })
        } else if (onNewConsult && isDraft && !isConsult) {
          // 正式派工被并发闸挡下 → 一键降级为只读咨询窗（只想问不想改的动线，见 CHANGELOG 只读会话条）
          toast.error('该员工正忙（同员工不能两条会话并发改同一个工作树）', {
            description: '只是想问/排查？开一个只读窗，不占他的活',
            action: { label: '开只读窗', onClick: () => onNewConsult(run!.employee) },
          })
        } else {
          toast.error('该员工正忙，稍后再试')
        }
      } else {
        toast.error('发送失败', { description: (e as Error).message })
      }
    } finally {
      setSending(false)
    }
  }


  // 拒绝理由：引擎 /permission 一直支持 message（原样交给 SDK 当拒绝原因、员工能看到），
  // 而这里以前只发 {reqId, behavior} —— 拒了他不知道为什么被拒，只能瞎猜重试。现在带上。
  async function resolvePerm(reqId: string, behavior: 'allow' | 'deny', reason?: string) {
    try {
      await apiPost(`/api/runs/${run!.id}/permission`, {
        reqId,
        behavior,
        message: behavior === 'deny' ? (reason ?? permReason[reqId] ?? '').trim() || undefined : undefined,
      })
      setPerms((p) => p.filter((x) => x.reqId !== reqId))
    } catch (e) {
      toast.error('处理失败', { description: (e as Error).message })
    }
  }
  // 批量：引擎侧一个 reqId 一次挂起，只能逐条 resolve（没法合并成一发），但点击可以只点一次。
  async function resolveAllPerms(behavior: 'allow' | 'deny') {
    for (const p of perms.slice()) await resolvePerm(p.reqId, behavior)
  }

  async function togglePin() {
    try {
      await apiPost(`/api/runs/${run!.id}/pin`, { pinned: !run!.pinned })
      toast.success(run!.pinned ? '已取消置顶' : '已置顶')
      onPinned?.()
    } catch (e) {
      toast.error('操作失败', { description: (e as Error).message })
    }
  }
  // 改名：非空 = 手动命名（之后不再被自动命名覆盖）；空串 = 交给引擎重新自动起名。换名结果走 SSE run-title 回来。
  async function saveTitle(next: string, { regen = false } = {}) {
    setTitleDraft(null)
    const t = regen ? '' : next.replace(/\s+/g, ' ').trim()
    if (!regen && t === (run!.title || '')) return // 没改（含「本无标题、空着失焦」）＝放弃，别误触发重新生成
    try {
      await apiPost(`/api/runs/${run!.id}/title`, { title: t })
      if (!t) toast.success('正在重新生成标题…')
      onPinned?.()
    } catch (e) {
      toast.error('改名失败', { description: (e as Error).message })
    }
  }
  // 在会话列表里直接 pin/unpin 某条会话
  async function pinRun(id: string, pinned: boolean) {
    try {
      await apiPost(`/api/runs/${id}/pin`, { pinned: !pinned })
      onPinned?.()
    } catch (e) {
      toast.error('操作失败', { description: (e as Error).message })
    }
  }

  return (
    <FloatingCard
      open={open}
      offset={index}
      stackId={stackId}
      onOpenChange={onOpenChange}
      docked={docked}
      dockW={dockW}
      onToggleDock={onToggleDock}
      onDockWidth={onDockWidth}
      title={
        <div className="flex items-center gap-2">
          <span className="relative shrink-0">
            <EmployeeAvatar employee={emp} fallback={run.employee} className="size-7" />
            {headerSt && (
              <EmployeeStatusBadge
                kind={headerSt.kind}
                title={EMP_STATE_LABEL[headerSt.kind]}
                className="absolute -end-0.5 -bottom-0.5 ring-card"
              />
            )}
          </span>
          {/* flex-1：标题区吃满到右侧按钮组为止——原先只按内容宽，运行环境徽标被 max-w-28 截成「简..」毫无信息量 */}
          <div className="min-w-0 flex-1">
            <div className="@container/hd flex min-w-0 items-center gap-2 text-sm font-medium">
              <span className="shrink-0">{emp?.displayName ?? run.employee}</span>
              {/* 该员工正在跑的正式会话数（按工作区并行后 GG Bond 可能同时有好几条）：≥2 条，或本条已收工但他在别处跑时才出，
                  点它＝展开历史会话去切。只读咨询窗不计（它不占员工）。 */}
              {(() => {
                if (!runs || !onSwitch) return null
                const liveN = runs.filter((r) => r.employee === run.employee && !r.consult && isLive(r)).length
                const selfLive = !!run.id && isLive(run)
                if (liveN < 2 && !(liveN >= 1 && !selfLive)) return null
                return (
                  <button
                    type="button"
                    data-no-drag
                    data-testid="run-detail-live-count"
                    onClick={() => setDrawer('live')}
                    title={`${emp?.displayName ?? run.employee} 现在有 ${liveN} 条会话在跑${selfLive ? '（含本条）' : '（本条已停，他在别处干活）'}——点开切换`}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-semibold text-primary tabular-nums ring-1 ring-primary/30 transition hover:bg-primary/20"
                  >
                    <span className="relative flex size-1.5">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                      <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
                    </span>
                    {liveN} 在跑
                  </button>
                )
              })()}
              {!isDraft && <Badge variant="outline" title={run.model || '基座默认模型'}>{run.engine === 'codex' ? 'Codex' : run.engine && run.engine !== 'claude' ? run.engine : 'Claude Code'}</Badge>}
              <Badge variant={isDraft ? 'secondary' : runVariant(status)} className="shrink-0">
                {isDraft ? '新对话' : runLabel(status)}
              </Badge>
              {isConsult && (
                <Badge
                  variant="outline"
                  className="gap-1 border-amber-500/30 bg-amber-500/12 text-amber-600 dark:text-amber-400"
                  title="只读咨询窗：可读码/查 git/看日志，不能改文件、不能构建重启、不进流水线（他正式会话照旧跑）"
                >
                  <EyeIcon className="size-3" />
                  只读
                </Badge>
              )}
              {/* 运行环境：草稿看卡片带来的 initialLane，已建 run 看 run.lane；显式绑定（含主检出）才标，未指定不标。
                  名字取侧栏同一份 /api/lanes 缓存里的展示名（别名 / 主检出按分支取名），取不到退回 id。 */}
              {(() => {
                const lane = isDraft ? initialLane : run.lane
                if (!lane || isConsult) return null
                const name = lanesData?.lanes.find((l) => l.id === lane)?.name || (lane === 'main' ? '主检出' : lane)
                return (
                  <Badge
                    variant="outline"
                    className="hidden min-w-0 max-w-56 shrink gap-1 border-emerald-500/30 @[14rem]/hd:inline-flex bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
                    title={`本会话绑定运行环境「${name}」（${lane}）：代码落在它的工作树、端口按它的槽位（引擎注入【运行环境】）`}
                    data-testid="run-detail-lane-badge"
                  >
                    <GitBranchIcon className="size-3 shrink-0" />
                    {/* 三档（容器查询按标题列实宽判断，不按视口）：<14rem 整枚不显（默认 460px 浮窗再带「N 在跑」时
                        连一颗图标都挤不下，会压到右边按钮上）；14–20rem 只留分支图标、名字进 tooltip——截成「简..」
                        毫无信息量；≥20rem（停靠/最大化）露出名字。 */}
                    <span className="hidden truncate @[20rem]/hd:inline">{name}</span>
                  </Badge>
                )
              })()}
            </div>
            {isDraft ? (
              <div className="text-[10px] text-muted-foreground">发送后开始</div>
            ) : titleDraft !== null ? (
              // 就地改名：Enter 存、Esc 放弃（preventDefault，别让卡片的 Esc 关窗接着生效）、失焦即存
              <input
                ref={titleInputRef}
                data-no-drag
                autoFocus
                value={titleDraft}
                maxLength={40}
                placeholder="留空 = 自动生成标题"
                aria-label="会话标题"
                data-testid="run-detail-title-input"
                onChange={(e) => setTitleDraft(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => saveTitle(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') e.currentTarget.blur()
                  else if (e.key === 'Escape') {
                    e.preventDefault()
                    setTitleDraft(null)
                  }
                }}
                className="h-5 w-full min-w-0 rounded border bg-background px-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            ) : (
              // 第二行＝会话标题（引擎自动命名 / 手动改名；没有标题时退回派工指令首句）。双击改名；
              // 会话 ID 原先占这一行，现在只在桌面留个复制小钮（ID 全文在它的 tooltip 里）。
              <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <span
                  data-no-drag
                  className="cursor-text truncate hover:text-foreground"
                  title={`${run.title || '（标题生成中，暂显指令首句）'} —— 双击改名`}
                  data-testid="run-detail-title"
                  onDoubleClick={() => setTitleDraft(run.title || '')}
                >
                  {run.title || dispatchLead(run.instruction || '') || run.id}
                </span>
                <button
                  data-no-drag
                  onClick={() => {
                    navigator.clipboard
                      .writeText(run.id)
                      .then(() => toast.success('已复制会话 ID'))
                      .catch(() => toast.error('复制失败'))
                  }}
                  className="hidden shrink-0 text-muted-foreground/60 hover:text-foreground md:inline-flex"
                  title={`复制会话 ID（${run.id}）`}
                  aria-label="复制会话 ID"
                >
                  <CopyIcon className="size-3" />
                </button>
              </div>
            )}
          </div>
          {/* 顶栏动作。窄屏：图标键放到 36px（28px 是鼠标尺寸），并把「置顶」折进「更多操作」——
              四颗 28px 的键挤在标题右边，既点不准又把名字压到只剩几个字。 */}
          <div data-no-drag className="ms-auto flex shrink-0 items-center gap-0.5">
            {onNewChat && (
              <Button
                variant="ghost"
                size="icon"
                className="size-9 md:size-7"
                onClick={() => onNewChat(run!.employee)}
                aria-label="新对话"
                title="新对话"
              >
                <PlusIcon />
              </Button>
            )}
            {onSwitch && (
              <Button
                variant="ghost"
                size="icon"
                className="size-9 md:size-7"
                aria-label="会话列表"
                title="会话列表（抽屉）"
                data-testid="run-detail-sessions"
                onClick={() => setDrawer((d) => (d ? null : 'all'))}
              >
                <ListBulletsIcon />
              </Button>
            )}
            {/* 分隔：会话导航 ｜ 本会话操作 */}
            {!isDraft && <span className="mx-0.5 hidden h-4 w-px shrink-0 bg-border md:block" />}
            {!isDraft && (
              <Button variant="ghost" size="icon" className="hidden size-7 md:inline-flex" onClick={togglePin} aria-label="置顶" title={run.pinned ? '取消置顶' : '置顶'}>
                <PushPinIcon weight={run.pinned ? 'fill' : 'regular'} className={cn(run.pinned && 'text-primary')} />
              </Button>
            )}
            {!isDraft && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-9 md:size-7" aria-label="更多操作" title="更多操作">
                    <DotsThreeIcon weight="bold" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  // 点「重命名」后菜单关闭时 Radix 会把焦点还给触发钮——那会立刻让改名输入框失焦、当场提交。只在这一次拦掉
                  onCloseAutoFocus={(e) => {
                    if (renamingRef.current) {
                      e.preventDefault()
                      titleInputRef.current?.focus()
                    }
                    renamingRef.current = false
                  }}
                >
                  {/* 窄屏折进来的两项（桌面在顶栏各有一颗键 / 一行 ID，这里就不重复出现） */}
                  <DropdownMenuItem className="md:hidden" onClick={togglePin}>
                    <PushPinIcon weight={run.pinned ? 'fill' : 'regular'} />
                    {run.pinned ? '取消置顶' : '置顶'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="md:hidden"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(run.id)
                        .then(() => toast.success('已复制会话 ID'))
                        .catch(() => toast.error('复制失败'))
                    }}
                  >
                    <CopyIcon /> 复制会话 ID
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      renamingRef.current = true
                      setTitleDraft(run.title || '')
                    }}
                  >
                    <PencilSimpleIcon /> 重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => saveTitle('', { regen: true })}>
                    <ArrowsClockwiseIcon /> 重新生成标题
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={toggleProcess}>
                    {showProcess ? <EyeSlashIcon /> : <EyeIcon />}
                    {showProcess ? '改回精简过程' : '显示全部过程'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setHandoverOpen(true)}>
                    <ArrowsClockwiseIcon /> 更换基座并接手
                  </DropdownMenuItem>
                  {live && (
                    <DropdownMenuItem
                      onClick={() =>
                        apiPost(`/api/runs/${run.id}/stop`)
                          .then(() => toast.success('已请求停止'))
                          .catch((e) => toast.error('停止失败', { description: (e as Error).message }))
                      }
                    >
                      <StopIcon /> 停止运行
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <TrashIcon /> 删除会话
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      }
    >
      <div
        data-chat-window
        className="relative flex min-h-0 flex-1 flex-col"
        onDragEnter={onWinDragEnter}
        onDragOver={onWinDragOver}
        onDragLeave={onWinDragLeave}
        onDrop={onWinDrop}
      >
        {/* 动作卡攒批：provider 包住「消息区 + 权限区 + 巡视条」，攒批条渲染在它们之后、组合器之前。
            key=runId → 切会话即重置暂存（暂存是当前会话的视图态）。 */}
        <CardBatchProvider key={run.id || 'draft'} onSend={replyText} inlineBar={false}>
        {!isDraft && (status === 'error' || status === 'interrupted' || run.engineHandoverPending) && (
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
            <span className="text-muted-foreground">{run.engineHandoverPending ? '基座交接尚未完成' : '当前基座无法继续？可交接已有进度。'}</span>
            <Button variant="outline" size="sm" onClick={() => setHandoverOpen(true)}>更换基座并接手</Button>
          </div>
        )}
        <div className="relative flex min-h-0 flex-1">
        <div
          ref={setScrollNode}
          onScroll={onScroll}
          // 底部多留一截（pb-6）：最后一条别贴着短语行（2026-10-07 老板反馈「太近」）
          className="scroll-fade min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2.5 pt-3 pb-6 md:px-3"
        >
          {isDraft && (
            <div className="grid h-full place-items-center px-6 text-center">
              <div className="grid justify-items-center gap-2">
                <EmployeeAvatar employee={emp} fallback={run.employee} className="size-12" />
                <div className="text-sm font-medium">
                  {isConsult ? `找 ${emp?.displayName ?? run.employee} 只读咨询` : `与 ${emp?.displayName ?? run.employee} 的新对话`}
                </div>
                <div className="max-w-72 text-xs text-muted-foreground">
                  {isConsult
                    ? '他正式会话照旧跑，这个窗只读：能读码 / 查 git / 看日志、不能改文件或重启服务。要真动手就回正式会话派工。'
                    : selectedTaskFile
                      ? '已挂任务档案，发送即派工（Enter 发送）'
                      : '直接输入即普通对话；如需派工，点下方「对话」挂一个任务档案（Enter 发送）'}
                </div>
              </div>
            </div>
          )}
          {hasMore && events.length > 0 && (
            <div className="mb-3 flex justify-center">
              <Button variant="outline" size="sm" onClick={loadOlder} disabled={loadingEarlier}>
                <ArrowUpIcon /> {loadingEarlier ? '加载中…' : '加载更早'}
              </Button>
            </div>
          )}
          {events.length === 0 && run.instruction && (
            <div className="mb-3 rounded-md border bg-muted/30 p-3 text-sm">
              <div className="mb-1 text-xs font-medium text-muted-foreground">指令</div>
              <div className="whitespace-pre-wrap break-words">{run.instruction}</div>
            </div>
          )}
          <Transcript
            events={events}
            onReply={replyText}
            focusReply={focusReply}
            runId={run.id}
            employee={run.employee}
            showProcess={showProcess}
          />
          {activelyThinking && (
            <div className="mt-2 flex min-w-0 items-start gap-2">
              <EmployeeAvatar employee={emp} fallback={run.employee} className="size-7 shrink-0" />
              <div className="grid min-w-0 gap-1">
                <div className="w-fit rounded-full bg-muted px-2.5 py-2">
                  <span className="typing-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </div>
                <span className="truncate ps-1 text-[11px] text-muted-foreground">
                  {liveActivity || run.activity || `${emp?.displayName ?? run.employee} 正在处理…`}
                </span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
          {/* 浮钮水平居中于消息区（2026-10-07 老板要求从右下角挪到正中） */}
          {!atBottom && (
            <button
              type="button"
              onClick={scrollToBottom}
              aria-label="回到最新消息"
              title="回到最新消息"
              className="absolute bottom-3 left-1/2 z-20 grid size-10 -translate-x-1/2 place-items-center rounded-full border bg-card text-foreground shadow-lg transition hover:bg-accent md:size-9"
            >
              <ArrowDownIcon className="size-4" weight="bold" />
            </button>
          )}
        </div>

        {/* 底座：权限审批 / 巡视条 / 攒批条 / 短语行 / 组合器。
            2026-10-07 先做成「悬浮叠在消息上 + 量高度回填 paddingBottom」，连出三次「末张卡被输入框盖住」
            （容差过大、卡片原地变高、停靠后量到已脱离的旧节点 0 高）。老板拍板：消息滚动区直接减去底座高度。
            现在底座在正常文档流里（shrink-0），消息区 flex-1 自然止于它上沿——不需要任何测量，也就没有量错的可能。
            观感上仍不做硬切：底座没有分隔线、和消息区同底色，输入框自身是小圆角卡片。 */}
        <div className="shrink-0 bg-card px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:px-3 md:pb-3">
        <div>
        <div className="mb-2 overflow-hidden rounded-lg border bg-card empty:hidden [&>*:first-child]:border-t-0">
        {perms.length > 0 && (
          <div className="border-t bg-amber-500/5 p-3">
            {/* 多条挂起时给一次性出口（逐条点太累），「全部允许」走二次确认——批量放行不该手滑 */}
            {perms.length > 1 && (
              <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="font-medium">{perms.length} 项待你审批</span>
                <div className="ms-auto flex gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => resolveAllPerms('deny')}>
                    全部拒绝
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmAllowAll(true)}>
                    全部允许…
                  </Button>
                </div>
              </div>
            )}
            {perms.map((p) => (
              <div key={p.reqId} className="mb-2 rounded-md border border-amber-500/40 p-2 last:mb-0">
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <ShieldCheckIcon className="size-4 text-amber-500" />
                  <span className="font-medium">{p.title || '权限请求'}</span>
                  {p.toolName && <Badge variant="outline">{p.toolName}</Badge>}
                </div>
                {p.brief && <p className="mb-2 text-xs text-muted-foreground">{p.brief}</p>}
                <Textarea
                  value={permReason[p.reqId] ?? ''}
                  onChange={(e) => setPermReason((m) => ({ ...m, [p.reqId]: e.target.value }))}
                  placeholder="拒绝理由（可选，会原样转给他，省得他瞎猜重试）…"
                  className="mb-2 max-h-24 min-h-8 resize-none bg-background/60 text-xs"
                />
                {/* 允许/拒绝在窄屏是「卡住整条会话、必须现在拍」的键，size=sm 只有 24px 高——
                    这两颗按错代价太大，手机上给到 36px 且各占半行。 */}
                <div className="flex gap-2">
                  <Button size="sm" className="h-9 flex-1 md:h-6 md:flex-none" onClick={() => resolvePerm(p.reqId, 'allow')}>允许</Button>
                  <Button size="sm" variant="outline" className="h-9 flex-1 md:h-6 md:flex-none" onClick={() => resolvePerm(p.reqId, 'deny')}>拒绝</Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <CardBatchBar />
        </div>
        {!isDraft && <PatrolBanner runId={run.id} graceUntil={run.patrolGraceUntil} />}

        {/* 组合器 */}
        <div>
          <AttachmentBar
            items={attach.items}
            onRemove={attach.remove}
            onInline={(text, i) => {
              attach.remove(i)
              setReply((r) => (r ? `${r}\n${text}` : text))
            }}
            className="mb-2"
          />
          {pendingChatlogs.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {pendingChatlogs.map((c, i) => (
                <span
                  key={i}
                  className="flex items-center gap-1.5 rounded-lg border bg-muted/40 py-1 pe-1.5 ps-1.5 text-xs"
                  title={c.meta.span || undefined}
                >
                  <span className="grid size-5 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
                    <ClipboardTextIcon className="size-3" />
                  </span>
                  <span className="max-w-52 truncate font-medium">{chatlogChipLabel(c)}</span>
                  <button
                    onClick={() => setPendingChatlogs((p) => p.filter((_, j) => j !== i))}
                    aria-label="移除聊天记录"
                    className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attach.addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <QuickPhraseBar employee={run.employee} disabled={sending} onSend={(text) => send(false, text)} className="mb-1.5" />
          {/* 输入框：小圆角（rounded-md）+ 实底（悬浮在消息上，半透明会透字） */}
          <div className="rounded-md border bg-card transition-colors focus-within:border-primary/50">
            <Textarea
              ref={replyTaRef}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              // 窄屏用短提示：那句完整说明在 390px 上要折三行，把输入框顶成一堵灰墙
              // 提示只留一行：输入框按内容自动增高（field-sizing-content），空着时是按 placeholder 量高的，
              // 长提示一折行，最矮也成了两行。完整说明挪到悬停提示里。
              placeholder={isMobile ? '回复 / 追加指令…' : '回复 / 追加指令…（Enter 发送，Shift+Enter 换行）'}
              title="Enter 发送，Shift+Enter 换行；可粘贴 / 拖拽图片与文件，长文本自动转附件"
              rows={1}
              className="max-h-[200px] min-h-9 resize-none overflow-y-auto border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
              onPaste={attach.onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            {/* 工具行。**min-w-0 是这一行的命门**：Button 基类自带 shrink-0，任务档案选择器（可长达
                十几个字的档案名）撑起来后整行 scrollWidth 超出 clientWidth，最右的发送键就被裁掉半个
                ——390px 上「发送」按钮直接看不见（2026-09-08 老板反馈「聊天窗口也很糟糕」的头号实证）。
                现在：图标键 shrink-0 不动，选择器 min-w-0 + shrink 可压缩、名字自己 truncate。 */}
            <div className="flex min-w-0 items-center gap-0.5 px-1.5 pb-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 text-muted-foreground md:size-8"
                onClick={() => fileInputRef.current?.click()}
                aria-label="附件"
                title="添加附件"
              >
                <PaperclipIcon />
              </Button>
              <ComposerExtras onChatlog={(raw) => setPendingChatlogs((p) => [...p, parseChatlog(raw)])} />
              {/* 快捷动作（按员工由引擎下发，如菲菲的「需求巡航」）：点一次＝发一段引擎写好的完整指令。
                  只读窗不给——巡航要回写需求表，而只读窗连写工具都没挂，给了也是点了没用。
                  走 send() 而不是自己发请求：草稿建 run、并发闸 409 降级到只读窗这些动线都在里面。 */}
              {!isConsult && (
                <QuickActions
                  employee={run.employee}
                  disabled={sending}
                  guarded={run.executionMode === 'guarded_run'}
                  onRun={(instruction) => send(false, instruction)}
                />
              )}
              {/* 任务档案选择器（常驻）：挂档案=派工 / 不挂=普通对话，自动判定，不再手动切模式。
                  只读窗不显示——它没有派工语义（要落地得回正式会话派工）。 */}
              {!isConsult && (
              <DropdownMenu
                open={pickerOpen}
                onOpenChange={(o) => {
                  setPickerOpen(o)
                  if (o && tasks === null) loadTasks()
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    variant={dispatchMode ? 'default' : 'ghost'}
                    size="sm"
                    className="h-9 min-w-0 shrink gap-1 px-2 text-xs md:h-8 md:px-2.5"
                    title={
                      dispatchMode
                        ? `派工 · 已挂任务档案：${selectedTaskFile}（点选可换 / 取消）`
                        : '普通对话 · 点选一个任务档案即转为派工'
                    }
                  >
                    {dispatchMode ? <BriefcaseIcon weight="fill" /> : <ChatCircleIcon />}
                    <span className="min-w-0 truncate md:max-w-32">
                      {dispatchMode ? selectedLabel : '对话'}
                    </span>
                    <CaretDownIcon className="opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-auto">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    挂任务档案 = 派工 · 不挂 = 普通对话
                  </DropdownMenuLabel>
                  <DropdownMenuItem className="gap-2" onClick={() => setSelectedTaskFile('')}>
                    {!dispatchMode ? (
                      <CheckIcon className="shrink-0 text-primary" />
                    ) : (
                      <span className="size-4 shrink-0" />
                    )}
                    <span className={cn('min-w-0 flex-1 truncate', !dispatchMode && 'font-medium')}>
                      普通对话（不挂档案）
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {tasks === null ? (
                    <div className="px-2 py-3 text-center text-xs text-muted-foreground">加载任务档案…</div>
                  ) : sortedTasks.length === 0 ? (
                    <div className="px-2 py-3 text-center text-xs text-muted-foreground">暂无任务档案</div>
                  ) : (
                    sortedTasks.map((t) => (
                      <DropdownMenuItem
                        key={t.file}
                        className="gap-2"
                        onClick={() => setSelectedTaskFile(t.file)}
                      >
                        {selectedTaskFile === t.file ? (
                          <CheckIcon className="shrink-0 text-primary" />
                        ) : (
                          <span className="size-4 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{taskLabel(t)}</span>
                        {t.frontmatter.status && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {t.frontmatter.status}
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              )}
              {isConsult && (
                <span className="flex h-8 shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground">
                  <EyeIcon className="size-3.5" />
                  只读咨询
                </span>
              )}
              <div className="ms-auto flex shrink-0 items-center gap-1">
                {live && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-9 md:size-8"
                    onClick={() => send(true)}
                    disabled={sending}
                    aria-label="接管"
                    title="强制接管（僵尸会话）"
                  >
                    <LightningIcon weight="fill" />
                  </Button>
                )}
                <Button
                  onClick={() => send()}
                  disabled={sending || (!reply.trim() && !attach.items.length && !pendingChatlogs.length)}
                  size="icon"
                  className="size-10 transition-transform active:scale-90 md:size-8"
                  aria-label="发送"
                >
                  {sending ? (
                    <CircleNotchIcon className="animate-spin" />
                  ) : (
                    <PaperPlaneRightIcon weight="fill" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        </div>
        </div>
        </div>
        </CardBatchProvider>

        {onSwitch && (
          <SessionDrawer
            open={drawer !== null}
            initialFilter={drawer ?? 'all'}
            onClose={() => setDrawer(null)}
            runs={runs}
            employee={run.employee}
            employeeName={emp?.displayName ?? run.employee}
            currentId={run.id || undefined}
            lanes={lanesData}
            onSwitch={onSwitch}
            onPin={pinRun}
          />
        )}
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-primary/5 backdrop-blur-[1px]">
            <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-card/95 px-6 py-5 text-sm font-medium text-primary shadow-xl">
              <PaperclipIcon className="size-6" />
              拖放文件到此处 · 添加为本会话附件
            </div>
          </div>
        )}
      </div>

        <AlertDialog open={confirmAllowAll} onOpenChange={setConfirmAllowAll}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>放行全部 {perms.length} 项审批？</AlertDialogTitle>
              <AlertDialogDescription>
                会逐条以「允许」回复引擎。请确认你已看过每条要执行的动作。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>再看看</AlertDialogCancel>
              <AlertDialogAction onClick={() => resolveAllPerms('allow')}>全部允许</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <EngineHandoverDialog key={run.id} runId={run.id} open={handoverOpen} onOpenChange={setHandoverOpen} onDone={onPinned} />
        <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除这条会话？</AlertDialogTitle>
              <AlertDialogDescription>将删除该运行记录，不可恢复。</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  apiDelete(`/api/runs/${run.id}`)
                    .then(() => {
                      toast.success('已删除')
                      onOpenChange(false)
                    })
                    .catch((e) => toast.error('删除失败', { description: (e as Error).message }))
                }
              >
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
    </FloatingCard>
  )
}
