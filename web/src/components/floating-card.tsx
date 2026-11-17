import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  XIcon,
  CornersOutIcon,
  CaretLeftIcon,
  ColumnsPlusRightIcon,
  PictureInPictureIcon,
} from '@phosphor-icons/react'

import { useVisualViewport } from '@/hooks/use-visual-viewport'
import { useIsMobile } from '@/hooks/use-mobile'
import { useCardZ, raiseCard, isTopCard } from '@/hooks/use-card-stack'
import { applyDockVar, clampDockW } from '@/hooks/use-dock'

type Size = { w: number; h: number }
type Pos = { x: number; y: number }

const MIN_W = 340
const MIN_H = 320
const KEY = 'ol-chat-card'
const OUT_MS = 120 // 退场动画时长，须与 index.css 的 ol-card-*-out 一致

function loadGeom(): { pos: Pos; size: Size } | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null')
  } catch {
    return null
  }
}
function saveGeom(pos: Pos, size: Size) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ pos, size }))
  } catch {
    /* ignore */
  }
}

// 第三栏此刻占了右边多少像素（没停靠时是 0）。读的就是外壳用来预留空间的那个变量，
// 保证「浮窗认为的右边界」与「主内容真实的右边界」是同一个数，不会各算各的。
function dockReservedW(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--ol-dock-w')
  return parseFloat(v) || 0
}

function initialSize(offset: number): Size {
  // 默认高度尽量高些——消息气泡偏高，太矮几条就顶满、看不了几句。留出上下边距后取到约 820，超小屏再收缩。
  return (
    (offset === 0 && loadGeom()?.size) || { w: 460, h: Math.min(820, Math.max(MIN_H, window.innerHeight - 96)) }
  )
}

// 出生位置。**要避开第三栏**：停靠栏开着时新开的 popup 若按整窗右缘算，会正好压在第三栏上面
// （浮动带 z≥40 盖过停靠栏的 z-30），第三栏「稳定」就只剩内容不变、视觉上仍被糊住。
// 所以右边界一律取「窗口右缘 − 第三栏宽」；连记忆的几何也做一次落地钳位（只在出生时钳一次，
// 之后用户想把窗拖到栏上面盖着是他的自由，不再纠正）。
function initialPos(offset: number): Pos {
  const right = window.innerWidth - dockReservedW()
  const g = offset === 0 ? loadGeom()?.pos : null
  const d = offset * 28
  if (!g) return { x: Math.max(16, right - 480 - d), y: 64 + d }
  const w = initialSize(offset).w
  return g.x + w <= right ? g : { x: Math.max(16, right - w - 16), y: g.y }
}

// 自由浮动卡片：可拖动（拖标题栏）、可缩放（右下角）、非模态（不遮挡背景，背后可继续操作）。
// 另有**停靠态**（docked）：贴在窗口右侧成为主页面的第三栏，主内容靠 `--ol-dock-w` 预留空间让位收窄。
// 停靠**不换 portal 容器**（换 container = React 卸载重挂 = 丢 transcript 与草稿），只换定位与尺寸来源。
export function FloatingCard({
  open,
  offset = 0,
  stackId,
  onOpenChange,
  title,
  children,
  footer,
  docked = false,
  dockW = 460,
  onToggleDock,
  onDockWidth,
}: {
  open: boolean
  offset?: number
  // 层序标识：由外层（卡片管理者）传入稳定 id，好让「再次点该员工」能从外部把这张卡抬到最前。缺省用自动 id。
  stackId?: string
  onOpenChange: (o: boolean) => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  // 停靠态（主页面右侧第三栏）。移动端忽略——那里聊天恒为全屏页。
  docked?: boolean
  dockW?: number
  onToggleDock?: () => void
  onDockWidth?: (w: number) => void
}) {
  // 用全站统一的移动断点（768，与 sidebar/topbar 一致，且 matchMedia 响应式）——
  // 之前这里私用 window.innerWidth<640 且不响应式，640~767 的机型/旋转后会掉进桌面浮层分支，
  // 表现为「点员工出的是可拖动弹窗而不是全屏页」。
  const isMobile = useIsMobile()
  const vv = useVisualViewport() // 移动端跟随视觉视口（键盘弹起时收缩），全屏且输入框始终在键盘之上
  const autoId = useId()
  const cardId = stackId ?? autoId // 优先用外部稳定 id（供「再次点员工」从外部抬前），否则自动 id
  const z = useCardZ(cardId) // 前后层序：拖动/点按的卡抬到最前（限制在 50 以下、菜单/弹窗之下）
  const [size, setSize] = useState<Size>(() => initialSize(offset))
  const [pos, setPos] = useState<Pos>(() => initialPos(offset))
  const [maximized, setMaximized] = useState(false)
  // 出现/隐藏动画（老板 2026-10-19：「出现/隐藏能有动画吗？迅捷一点」）：进场靠 CSS 挂载即播；
  // 退场先打 data-closing 播 OUT_MS 的收起动画，播完才真正 onOpenChange(false) 卸载。ref 防重入（Esc 连按 / popstate 与按钮同到）。
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const closeTimer = useRef<number | null>(null)
  function animateOut(done: () => void) {
    if (closingRef.current) return
    closingRef.current = true
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return done()
    setClosing(true)
    closeTimer.current = window.setTimeout(done, OUT_MS)
  }
  useEffect(() => () => {
    if (closeTimer.current != null) clearTimeout(closeTimer.current)
  }, [])
  const animateOutRef = useRef(animateOut)
  animateOutRef.current = animateOut
  const cardRef = useRef<HTMLDivElement>(null)
  // 拖动/缩放状态放 ref、逐帧直接写 DOM，不走 setState —— 避免每次 pointermove 重渲染整窗（消息列表等重子树）造成的生硬卡顿。
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; curX: number; curY: number } | null>(null)
  const rez = useRef<{ ox: number; oy: number; ow: number; oh: number; curW: number; curH: number } | null>(null)
  // 停靠态拖左边缘调栏宽（同一套 rAF 骨架，逐帧同时写自身 width 与外壳预留变量，两边不脱节）
  const dkz = useRef<{ cur: number } | null>(null)
  const raf = useRef<number | null>(null)
  // pos/size 最新值放 ref：监听器只挂一次（deps=[]），读 ref 拿最新，杜绝「每移一像素卸装一遍 window 监听」的开销。
  const posRef = useRef(pos)
  posRef.current = pos
  const sizeRef = useRef(size)
  sizeRef.current = size
  // 同理：window 监听只挂一次，停靠态与提交回调也走 ref 读最新
  const dockedRef = useRef(docked)
  dockedRef.current = docked
  const onDockWidthRef = useRef(onDockWidth)
  onDockWidthRef.current = onDockWidth

  // 拖动 / 缩放：pointermove 只更新 ref + 排一帧，rAF 内把位移写成 GPU 合成的 transform（拖动）或直接改宽高（缩放），
  // 松手才把最终值提交回 React state。监听器一次性挂载（deps=[]）。
  useEffect(() => {
    function paint() {
      raf.current = null
      const el = cardRef.current
      if (!el) return
      if (drag.current) {
        el.style.transform = `translate3d(${drag.current.curX - posRef.current.x}px, ${drag.current.curY - posRef.current.y}px, 0)`
      } else if (rez.current) {
        el.style.width = `${rez.current.curW}px`
        el.style.height = `${rez.current.curH}px`
      } else if (dkz.current) {
        el.style.width = `${dkz.current.cur}px`
        applyDockVar(dkz.current.cur) // 主内容同帧跟着收窄，不会出现"栏动了内容没动"的撕裂
      }
    }
    function schedule() {
      if (raf.current == null) raf.current = requestAnimationFrame(paint)
    }
    function move(e: PointerEvent) {
      if (drag.current) {
        drag.current.curX = clamp(drag.current.baseX + (e.clientX - drag.current.startX), 0, window.innerWidth - 80)
        drag.current.curY = clamp(drag.current.baseY + (e.clientY - drag.current.startY), 0, window.innerHeight - 40)
        schedule()
      } else if (rez.current) {
        rez.current.curW = clamp(rez.current.ow + (e.clientX - rez.current.ox), MIN_W, window.innerWidth - posRef.current.x - 8)
        rez.current.curH = clamp(rez.current.oh + (e.clientY - rez.current.oy), MIN_H, window.innerHeight - posRef.current.y - 8)
        schedule()
      } else if (dkz.current) {
        // 栏宽 = 从指针到窗口右缘的距离（贴右边停靠，所以直接由 clientX 推，不用记基准）
        dkz.current.cur = clampDockW(window.innerWidth - e.clientX)
        schedule()
      }
    }
    function up() {
      if (raf.current != null) {
        cancelAnimationFrame(raf.current)
        raf.current = null
      }
      if (cardRef.current) cardRef.current.style.willChange = ''
      if (drag.current) {
        const nx = drag.current.curX
        const ny = drag.current.curY
        drag.current = null
        const el = cardRef.current
        if (el) el.style.transform = '' // 清掉临时位移，改由 state 的 left/top 定位（值一致，无回跳）
        setPos({ x: nx, y: ny })
        // 停靠态不许写浮动几何 —— 否则取消停靠弹回浮动时，尺寸/位置被停靠那套值污染
        if (offset === 0 && !dockedRef.current) saveGeom({ x: nx, y: ny }, sizeRef.current)
      } else if (rez.current) {
        const nw = rez.current.curW
        const nh = rez.current.curH
        rez.current = null
        setSize({ w: nw, h: nh })
        if (offset === 0 && !dockedRef.current) saveGeom(posRef.current, { w: nw, h: nh })
      } else if (dkz.current) {
        const nw = dkz.current.cur
        dkz.current = null
        const el = cardRef.current
        if (el) el.style.width = '' // 交回 React（style 里的 width: dockW），值一致、无回跳
        onDockWidthRef.current?.(nw)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (raf.current != null) cancelAnimationFrame(raf.current)
    }
  }, [offset])

  // 视口变化时把卡片拉回可见范围
  useEffect(() => {
    function onResize() {
      setPos((p) => ({
        x: clamp(p.x, 0, Math.max(0, window.innerWidth - 80)),
        y: clamp(p.y, 0, Math.max(0, window.innerHeight - 40)),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 移动端：把「打开聊天」当作一次页面导航——压入一条 history 记录，接管系统返回手势/浏览器后退，
  // 返回即关闭聊天回到列表（而非退出整个站点），获得近原生「新开页面」的返回体验。
  // 关键：① 压栈幂等（StrictMode 会双挂载，用 history.state 标记避免重复 push）；
  //      ② cleanup 只摘监听、绝不 history.back()（否则 StrictMode 卸载会把页面退回主页——踩过）；
  //      ③ 所有关闭统一走 history.back() → popstate → onOpenChange，后退栈自洽。
  useEffect(() => {
    if (!isMobile || !open) return
    // 隐藏应用外壳 → 聊天独占视口，背后无内容可透出（根治键盘顶飞露看板）。
    document.documentElement.classList.add('ol-chat-page')
    if (!(window.history.state && window.history.state.olCard)) {
      // 地址改写成 /chat：真正的「页」+ 系统返回手势可用。
      window.history.pushState({ olCard: true }, '', '/chat')
    }
    const onPop = () => animateOutRef.current(() => onOpenChange(false))
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      document.documentElement.classList.remove('ol-chat-page')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, open])

  function requestClose() {
    if (isMobile && window.history.state && window.history.state.olCard) {
      window.history.back() // 经 popstate 统一关闭，弹掉我们压入的历史态
    } else {
      animateOut(() => onOpenChange(false))
    }
  }
  const requestCloseRef = useRef(requestClose)
  requestCloseRef.current = requestClose

  // Esc 关窗（对齐常见聊天窗/Claude Code）。只关「该关的那一扇」：焦点在本卡内 → 关本卡；焦点不在任何输入处（body）→ 只关最前那张。
  // 让位规则：① 卡里的 Radix 菜单/弹窗、会话抽屉、看图器先吃 Esc（它们 preventDefault，抽屉/看图器挂 capture 抢在本监听前）；
  // ② 输入法组字中不算；③ 输入框里有没发出去的字 → 第一下只失焦（关窗会丢草稿，组合器不持久化），再按一次才关。
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
      const active = document.activeElement as HTMLElement | null
      const rel = focusRel(cardRef.current)
      if (!(rel === 'in' || (rel === 'idle' && isTopCard(cardId)))) return
      if (rel === 'in' && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && active.value.trim()) {
        active.blur()
        return
      }
      e.preventDefault()
      requestCloseRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, cardId])

  // 「按 Esc 会关的就是这扇」的可见标识：与上面 Esc 的判定**同一条规则**（焦点在本卡内，或焦点空闲且本卡最前），
  // 看到高亮的那扇＝按 Esc 关的那扇；焦点在卡外的输入框时 Esc 什么都不关，也就谁都不亮。
  // 焦点关系存成小枚举、值不变 setState 自动跳过——焦点在别处来回切不会重渲染本卡；children 引用不变，重渲染也不碰消息列表。
  const [rel, setRel] = useState<FocusRel>('idle')
  useEffect(() => {
    if (!open) return
    // focusout 时 activeElement 还没落到新元素，排到下一帧再读
    const sync = () => requestAnimationFrame(() => setRel(focusRel(cardRef.current)))
    sync()
    document.addEventListener('focusin', sync)
    document.addEventListener('focusout', sync)
    return () => {
      document.removeEventListener('focusin', sync)
      document.removeEventListener('focusout', sync)
    }
  }, [open])
  const escTarget = rel === 'in' || (rel === 'idle' && isTopCard(cardId)) // isTopCard 随 useCardZ 的层序重渲染而更新

  // 移动端软键盘弹起时锁掉背景滚动，阻止 iOS 把 position:fixed 的整屏卡片“顶飞”。
  useEffect(() => {
    if (!isMobile || !open) return
    const html = document.documentElement
    const body = document.body
    const prevH = html.style.overflow
    const prevB = body.style.overflow
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    return () => {
      html.style.overflow = prevH
      body.style.overflow = prevB
    }
  }, [isMobile, open])

  if (!open) return null

  // 停靠只在桌面生效（移动端聊天恒为全屏页，没有第三栏的空间）
  const isDocked = docked && !isMobile
  const style: React.CSSProperties = isMobile
    ? // 移动端：应用外壳已隐藏、背后无物可透，容器贴合视觉视口即可——键盘弹起 vv.height 收缩、
      // 顶部 offsetTop 上移，容器随之缩放，底部输入框始终压在键盘之上。
      { left: 0, top: vv.offsetTop, width: '100%', height: vv.height }
    : isDocked
      ? // 停靠：贴窗口右缘、通高的一栏。宽度由外层统一持有（同一个值也写进 --ol-dock-w 给外壳预留），
        // 所以这里不用 pos/size —— 取消停靠后它们仍是原来的浮动几何，弹回去位置不变。
        { top: 0, bottom: 0, right: 0, left: 'auto', width: dockW, height: 'auto' }
      : maximized
        ? { inset: 12, width: 'auto', height: 'auto' }
        : { left: pos.x, top: pos.y, width: size.w, height: size.h }

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label="对话"
      data-closing={closing || undefined}
      className={
        // ol-card--*：进场/退场动画按形态区分（浮窗=轻微缩放上浮，停靠栏=从右侧滑入，移动端=整页右滑），见 index.css
        `ol-card ol-card--${isMobile ? 'm' : isDocked ? 'd' : 'f'} ` +
        'fixed flex flex-col overflow-hidden bg-card transition-[box-shadow,border-color] duration-150 ' +
        // 移动端：整屏页面，去掉圆角/描边/投影这些「卡片感」，做到边到边不透背景
        // 停靠态：同理去掉卡片感，只留左侧一条分隔线——它是页面的一栏，不是浮在上面的窗
        (isMobile ? '' : isDocked ? 'border-s' : 'rounded-xl border shadow-2xl') +
        // 当前聚焦（Esc 目标）：薰衣草描边 + 加深投影；停靠栏没有投影语义，用内描边。移动端恒为全屏单页，不需要
        (isMobile || !escTarget
          ? ''
          : isDocked
            ? ' ring-2 ring-inset ring-primary/60'
            : ' border-primary/60 ring-2 ring-primary/40 shadow-[0_24px_64px_-12px_rgba(94,106,210,0.45)]')
      }
      data-active={escTarget || undefined}
      // 停靠面板固定 z-30：在 sidebar(z-10)/rail(z-20) 之上、浮动卡带 [40,49] 之下（浮动窗本就该能盖过它）、
      // Radix 弹层 z-50 之下（否则栏里的下拉会被自己盖住）。
      style={{ ...style, zIndex: isDocked ? 30 : z }}
      // 点按/聚焦本卡任意处即抬到最前（capture：内层 stopPropagation 也拦不住）
      onPointerDownCapture={() => raiseCard(cardId)}
      onFocusCapture={() => raiseCard(cardId)}
    >
      {/* 标题栏（桌面端兼作拖动手柄；移动端是页面顶栏，左返回箭头 = 关闭回列表）。
          移动端顶栏：吃掉刘海/状态栏安全区 + 行高 48px（近原生 IM 顶栏），别让头像和标题贴着屏幕边缘。 */}
      <div
        className={
          'flex shrink-0 items-center gap-2 border-b px-3 py-2 ' +
          (isMobile
            ? 'min-h-12 pt-[calc(0.5rem+env(safe-area-inset-top))] '
            : isDocked
              ? ''
              : 'cursor-grab active:cursor-grabbing')
        }
        onPointerDown={(e) => {
          if (isMobile || isDocked || maximized) return
          // 标题栏里的下拉/菜单（Radix）把内容 portal 到 body，但 React 仍沿组件树派发指针事件——
          // 点菜单项会「冒泡」到这里的 onPointerDown。用 DOM 包含判断挡掉：pointerdown 的真实目标不在
          // 标题栏 DOM 子树内（即来自 portal 浮层）就不当拖动，否则 setPointerCapture 会抢走菜单项的
          // pointerup、令 Radix 判不成「同一元素按起」而整条菜单点击失效（踩过：更多操作/历史会话点不动）。
          if (!e.currentTarget.contains(e.target as Node)) return
          if ((e.target as HTMLElement).closest('[data-no-drag]')) return
          e.currentTarget.setPointerCapture(e.pointerId) // 快速拖动/指针移出也不丢事件，跟手
          if (cardRef.current) cardRef.current.style.willChange = 'transform' // 提示浏览器提前建合成层
          drag.current = { startX: e.clientX, startY: e.clientY, baseX: pos.x, baseY: pos.y, curX: pos.x, curY: pos.y }
        }}
      >
        {isMobile && (
          <button
            data-no-drag
            className="-ms-1.5 grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground active:bg-accent active:text-foreground"
            onClick={requestClose}
            aria-label="返回"
            title="返回"
          >
            <CaretLeftIcon className="size-5" weight="bold" />
          </button>
        )}
        <div className="min-w-0 flex-1">{title}</div>
        {!isMobile && (
          <div data-no-drag className="flex items-center gap-1 border-s ps-1.5">
            {onToggleDock && (
              <button
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={onToggleDock}
                aria-label={isDocked ? '改为浮动窗' : '停靠到右侧'}
                title={isDocked ? '改为浮动窗' : '停靠到右侧'}
              >
                {isDocked ? <PictureInPictureIcon className="size-4" /> : <ColumnsPlusRightIcon className="size-4" />}
              </button>
            )}
            {/* 贴边的一栏没有「最大化」语义，停靠态藏掉 */}
            {!isDocked && (
              <button
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setMaximized((m) => !m)}
                aria-label="最大化"
                title={maximized ? '还原' : '最大化'}
              >
                <CornersOutIcon className="size-4" />
              </button>
            )}
            <button
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={requestClose}
              aria-label="关闭"
              title="关闭"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        )}
      </div>

      {/* 内容 */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>

      {footer}

      {/* 缩放手柄（浮动态：右下角双向；停靠态：左边缘调栏宽） */}
      {!isMobile && !isDocked && !maximized && (
        <div
          className="absolute end-0 bottom-0 size-4 cursor-nwse-resize"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            rez.current = { ox: e.clientX, oy: e.clientY, ow: size.w, oh: size.h, curW: size.w, curH: size.h }
          }}
        >
          <div className="absolute end-1 bottom-1 size-2 border-e-2 border-b-2 border-muted-foreground/40" />
        </div>
      )}
      {isDocked && (
        <div
          className="absolute inset-y-0 start-0 w-1.5 cursor-ew-resize hover:bg-primary/30"
          title="拖动调整栏宽"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            dkz.current = { cur: clampDockW(window.innerWidth - e.clientX) }
          }}
        />
      )}
    </div>,
    document.body,
  )
}

// 焦点相对本卡的位置：in = 焦点在卡内；out = 焦点在卡外的**可输入处**（正在别处打字，Esc 不该关聊天窗）；
// idle = 其余（body，或卡外的按钮/链接——比如刚点侧栏员工开窗，焦点还停在那颗按钮上，此时 Esc 应关新开的最前那张）
type FocusRel = 'in' | 'idle' | 'out'
function focusRel(card: HTMLElement | null): FocusRel {
  const a = document.activeElement as HTMLElement | null
  if (!a || a === document.body) return 'idle'
  if (card && card.contains(a)) return 'in'
  const editable = a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement || a.isContentEditable ||
    (a instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(a.type))
  return editable ? 'out' : 'idle'
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}
