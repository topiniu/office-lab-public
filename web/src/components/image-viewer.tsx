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
import { createPortal } from 'react-dom'
import {
  XIcon,
  ArrowSquareOutIcon,
  MagnifyingGlassPlusIcon,
  MagnifyingGlassMinusIcon,
  ArrowsOutIcon,
} from '@phosphor-icons/react'

import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

/* 图片查看器：聊天里的截图缩略图点开后，落在一扇**自由浮窗**里（可拖、可缩放窗、可缩放图、可同时开多张），
   而不是 window.open 甩去新标签页（旧 UI 的做法：离开工作台、回不来、多图互相顶掉）。

   两处与 FloatingCard（聊天窗）刻意不同，别照抄过去：
   ① **z 轴在 Radix 弹层之上（≥60）**，不进 use-card-stack 的 [40,49] 窗口带 —— 图片可能从
      档案预览 Dialog / 派工弹窗（z-50 且 modal）里点开，落在 49 就会被自己来源的那张弹窗盖住。
   ② 因 ①，必须显式 `pointer-events-auto`：Radix 模态开着时会把 `document.body` 设成
      `pointer-events:none`，我们 portal 到 body 的浮窗会继承成"看得见点不动"。 */

type Shot = { id: number; src: string; name: string }
type Ctx = { openImage: (src: string, name?: string) => void }

const ImageViewerContext = createContext<Ctx>({
  // 没挂 Provider 的场合（理论上不该有）退回新标签页，至少别把图点丢了
  openImage: (src) => {
    window.open(src, '_blank', 'noreferrer')
  },
})

export function useImageViewer() {
  return useContext(ImageViewerContext)
}

// 给 <a href=图片> 用的点击拦截：普通左键 → Lab 看图器（不再跳新标签页）；Ctrl/⌘/Shift/中键照旧走浏览器默认（想新开 tab 的还能开）
export function viewInLab(openImage: Ctx['openImage'], src: string, name = '') {
  return (e: React.MouseEvent) => {
    if (!src || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    openImage(src, name)
  }
}

const MIN_W = 280
const MIN_H = 220
const MIN_ZOOM = 0.1
const MAX_ZOOM = 8
// 图片窗整体在 Radix 弹层（z-50）之上；多开时按叠放次序往上垒，封顶避免无限增长
const Z_BASE = 60
const Z_TOP = 90

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

// 出生尺寸/位置：先给一个稳妥的中等窗，图片 onLoad 拿到真实像素后再按原始比例收一次（见 fitToImage）
function birthSize() {
  return {
    w: clamp(Math.round(window.innerWidth * 0.46), MIN_W, 720),
    h: clamp(Math.round(window.innerHeight * 0.56), MIN_H, 620),
  }
}
function birthPos(index: number, size: { w: number; h: number }) {
  const d = (index % 6) * 28 // 多张层叠错开，不让后开的完全压住前一张
  return {
    x: clamp(Math.round((window.innerWidth - size.w) / 2) + d, 8, Math.max(8, window.innerWidth - size.w - 8)),
    y: clamp(Math.round((window.innerHeight - size.h) / 2) - 40 + d, 8, Math.max(8, window.innerHeight - 120)),
  }
}

function fileName(src: string, name: string) {
  if (name) return name
  try {
    return decodeURIComponent(src.split('?')[0].split('/').pop() || '图片')
  } catch {
    return '图片'
  }
}

function ImageWindow({
  shot,
  index,
  zIndex,
  onRaise,
  onClose,
}: {
  shot: Shot
  index: number
  zIndex: number
  onRaise: () => void
  onClose: () => void
}) {
  const isMobile = useIsMobile()
  const winRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)

  const [size, setSize] = useState(birthSize)
  const [pos, setPos] = useState(() => birthPos(index, birthSize()))
  const [zoom, setZoom] = useState(1) // 1 = 贴合窗口（object-contain），>1 放大
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [broken, setBroken] = useState(false)
  const autoSized = useRef(false)

  // 最新值放 ref：拖拽监听只挂一次，且 wheel/pan 要读到"此刻"的缩放与位移
  const sizeRef = useRef(size)
  sizeRef.current = size
  const posRef = useRef(pos)
  posRef.current = pos
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const offRef = useRef(off)
  offRef.current = off

  const transform = (z: number, o: { x: number; y: number }) => `translate(${o.x}px, ${o.y}px) scale(${z})`

  // 拖窗 / 缩放窗 / 平移图共用一套骨架：pointermove 只更新 ref + 排一帧，rAF 内直接写 DOM，
  // 松手才提交回 state（与 FloatingCard 同源的做法：大图逐帧 setState 会明显拖手）。
  const drag = useRef<
    | null
    | { mode: 'move' | 'resize' | 'pan'; sx: number; sy: number; bx: number; by: number; cx: number; cy: number }
  >(null)
  const raf = useRef<number | null>(null)

  useEffect(() => {
    function paint() {
      raf.current = null
      const d = drag.current
      if (!d) return
      if (d.mode === 'move') {
        const el = winRef.current
        if (el) {
          el.style.left = `${d.cx}px`
          el.style.top = `${d.cy}px`
        }
      } else if (d.mode === 'resize') {
        const el = winRef.current
        if (el) {
          el.style.width = `${d.cx}px`
          el.style.height = `${d.cy}px`
        }
      } else {
        const im = imgRef.current
        if (im) im.style.transform = transform(zoomRef.current, { x: d.cx, y: d.cy })
      }
    }
    function schedule() {
      if (raf.current == null) raf.current = requestAnimationFrame(paint)
    }
    function move(e: PointerEvent) {
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.sx
      const dy = e.clientY - d.sy
      if (d.mode === 'move') {
        d.cx = clamp(d.bx + dx, -sizeRef.current.w + 80, window.innerWidth - 80)
        d.cy = clamp(d.by + dy, 0, window.innerHeight - 40)
      } else if (d.mode === 'resize') {
        d.cx = clamp(d.bx + dx, MIN_W, window.innerWidth - posRef.current.x - 8)
        d.cy = clamp(d.by + dy, MIN_H, window.innerHeight - posRef.current.y - 8)
      } else {
        d.cx = d.bx + dx
        d.cy = d.by + dy
      }
      schedule()
    }
    function up() {
      if (raf.current != null) {
        cancelAnimationFrame(raf.current)
        raf.current = null
      }
      const d = drag.current
      if (!d) return
      drag.current = null
      if (d.mode === 'move') setPos({ x: d.cx, y: d.cy })
      else if (d.mode === 'resize') setSize({ w: d.cx, h: d.cy })
      else setOff({ x: d.cx, y: d.cy })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (raf.current != null) cancelAnimationFrame(raf.current)
    }
  }, [])

  // 滚轮缩放，以指针为锚点（截图常是长图，只能整图缩放的话放大后永远看不到想看的那块）。
  // 原生监听 + passive:false：React 的 onWheel 在 root 上是被动的，preventDefault 会被忽略、整页跟着滚。
  useEffect(() => {
    const el = boxRef.current
    if (!el || isMobile) return
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const rect = el!.getBoundingClientRect()
      const cx = e.clientX - (rect.left + rect.width / 2)
      const cy = e.clientY - (rect.top + rect.height / 2)
      const prev = zoomRef.current
      const next = clamp(prev * Math.exp(-e.deltaY / 400), MIN_ZOOM, MAX_ZOOM)
      if (next === prev) return
      const k = next / prev
      const o = offRef.current
      // 让指针下的那一点保持不动：新位移 = 指针偏移×(1−k) + 旧位移×k
      const no = { x: cx * (1 - k) + o.x * k, y: cy * (1 - k) + o.y * k }
      zoomRef.current = next
      offRef.current = no
      setZoom(next)
      setOff(no)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isMobile])

  // 图片就位后按真实比例把窗调成「刚好装得下这张图」（只调一次；用户动过手就不再自作主张）
  function fitToImage(im: HTMLImageElement) {
    if (autoSized.current || isMobile) return
    autoSized.current = true
    const nw = im.naturalWidth
    const nh = im.naturalHeight
    if (!nw || !nh) return
    const maxW = Math.min(window.innerWidth - 48, 1100)
    const maxH = window.innerHeight - 120 // 留出标题栏与上下边距
    const k = Math.min(1, maxW / nw, maxH / nh)
    const w = clamp(Math.round(nw * k), MIN_W, maxW)
    const h = clamp(Math.round(nh * k) + 40, MIN_H, maxH + 40)
    setSize({ w, h })
    setPos(birthPos(index, { w, h }))
  }

  function reset() {
    setZoom(1)
    setOff({ x: 0, y: 0 })
  }

  function step(mul: number) {
    const next = clamp(zoomRef.current * mul, MIN_ZOOM, MAX_ZOOM)
    setZoom(next)
    if (next === 1) setOff({ x: 0, y: 0 })
  }

  const title = fileName(shot.src, shot.name)

  const body = (
    <div
      ref={boxRef}
      className={cn(
        'relative min-h-0 flex-1 overflow-hidden bg-muted/30',
        broken ? 'grid place-items-center' : '',
      )}
      onDoubleClick={reset}
      onPointerDown={(e) => {
        // 只有放大到超出窗口才谈得上"拖着看"；贴合态下拖动只会把图拽出窗外，纯属误操作
        if (isMobile || e.button !== 0 || zoom <= 1) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = {
          mode: 'pan',
          sx: e.clientX,
          sy: e.clientY,
          bx: off.x,
          by: off.y,
          cx: off.x,
          cy: off.y,
        }
      }}
    >
      {broken ? (
        <span className="p-6 text-center text-xs text-muted-foreground">
          图片加载失败
          <br />
          <span className="font-mono break-all opacity-70">{shot.src}</span>
        </span>
      ) : (
        <img
          ref={imgRef}
          src={shot.src}
          alt={title}
          draggable={false}
          onLoad={(e) => fitToImage(e.currentTarget)}
          onError={() => setBroken(true)}
          style={{ transform: transform(zoom, off) }}
          className={cn(
            'absolute inset-0 m-auto max-h-full max-w-full object-contain select-none',
            isMobile ? '' : zoom > 1 ? 'cursor-grab active:cursor-grabbing' : '',
          )}
        />
      )}
    </div>
  )

  // 移动端：拖拽窗没有意义（也没地方拖），走整屏查看层。
  // 底色用**不透明**黑：半透明时背后聊天页的顶栏（头像/＋/更多）会透上来，跟本层标题栏叠成一排看不懂的图标。
  if (isMobile) {
    return createPortal(
      <div className="pointer-events-auto fixed inset-0 z-[80] flex flex-col bg-black" onClick={onClose}>
        <div
          className="flex shrink-0 items-center gap-2 px-3 pt-[calc(0.5rem+env(safe-area-inset-top))] pb-2 text-white"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="min-w-0 flex-1 truncate text-xs opacity-80">{title}</span>
          <a
            href={shot.src}
            target="_blank"
            rel="noreferrer"
            className="grid size-9 place-items-center rounded-full active:bg-white/15"
            aria-label="原图"
            title="原图"
          >
            <ArrowSquareOutIcon className="size-5" />
          </a>
          <button
            onClick={onClose}
            className="grid size-9 place-items-center rounded-full active:bg-white/15"
            aria-label="关闭"
            title="关闭"
          >
            <XIcon className="size-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 p-2" onClick={(e) => e.stopPropagation()}>
          <img src={shot.src} alt={title} className="size-full object-contain" onError={() => setBroken(true)} />
        </div>
      </div>,
      document.body,
    )
  }

  return createPortal(
    <div
      ref={winRef}
      role="dialog"
      aria-label={`图片 ${title}`}
      className="pointer-events-auto fixed flex flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h, zIndex }}
      onPointerDownCapture={onRaise}
    >
      {/* 标题栏兼拖动手柄 */}
      <div
        className="flex shrink-0 cursor-grab items-center gap-1 border-b px-2.5 py-1.5 active:cursor-grabbing"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          if (!e.currentTarget.contains(e.target as Node)) return
          if ((e.target as HTMLElement).closest('[data-no-drag]')) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { mode: 'move', sx: e.clientX, sy: e.clientY, bx: pos.x, by: pos.y, cx: pos.x, cy: pos.y }
        }}
      >
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>
          {title}
        </span>
        <div data-no-drag className="flex shrink-0 items-center gap-0.5">
          <button
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => step(1 / 1.25)}
            aria-label="缩小"
            title="缩小（滚轮向下）"
          >
            <MagnifyingGlassMinusIcon className="size-4" />
          </button>
          <button
            className="min-w-10 rounded px-1 font-mono text-[11px] text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground"
            onClick={reset}
            title="适应窗口（双击图片同效）"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => step(1.25)}
            aria-label="放大"
            title="放大（滚轮向上）"
          >
            <MagnifyingGlassPlusIcon className="size-4" />
          </button>
          <button
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={reset}
            aria-label="适应窗口"
            title="适应窗口"
          >
            <ArrowsOutIcon className="size-4" />
          </button>
          <a
            href={shot.src}
            target="_blank"
            rel="noreferrer"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="在新标签打开原图"
            title="在新标签打开原图"
          >
            <ArrowSquareOutIcon className="size-4" />
          </a>
          <button
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onClose}
            aria-label="关闭"
            title="关闭（Esc）"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </div>

      {body}

      {/* 右下角缩放手柄 */}
      <div
        className="absolute end-0 bottom-0 size-4 cursor-nwse-resize"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = {
            mode: 'resize',
            sx: e.clientX,
            sy: e.clientY,
            bx: size.w,
            by: size.h,
            cx: size.w,
            cy: size.h,
          }
        }}
      >
        <div className="absolute end-1 bottom-1 size-2 border-e-2 border-b-2 border-muted-foreground/40" />
      </div>
    </div>,
    document.body,
  )
}

export function ImageViewerProvider({ children }: { children: ReactNode }) {
  const [shots, setShots] = useState<Shot[]>([])
  const seq = useRef(0)

  const openImage = useCallback((src: string, name = '') => {
    if (!src) return
    setShots((prev) => {
      const i = prev.findIndex((s) => s.src === src)
      // 同一张图重复点：不再开第二扇窗，把已开的那扇抬到最前（数组末尾 = 最高层）
      if (i >= 0) return i === prev.length - 1 ? prev : [...prev.slice(0, i), ...prev.slice(i + 1), prev[i]]
      seq.current += 1
      return [...prev, { id: seq.current, src, name }]
    })
  }, [])

  const close = useCallback((id: number) => setShots((p) => p.filter((s) => s.id !== id)), [])
  const raise = useCallback(
    (id: number) =>
      setShots((p) => {
        const i = p.findIndex((s) => s.id === id)
        return i < 0 || i === p.length - 1 ? p : [...p.slice(0, i), ...p.slice(i + 1), p[i]]
      }),
    [],
  )

  // Esc 关最上面那扇（非模态，不拦其它键；没开图时完全不挂监听）
  useEffect(() => {
    if (!shots.length) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault() // 先关图，不连带关掉底下的聊天卡（capture 抢在卡的 Esc 监听之前）
      setShots((p) => p.slice(0, -1))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [shots.length])

  const value = useMemo(() => ({ openImage }), [openImage])

  return (
    <ImageViewerContext.Provider value={value}>
      {children}
      {shots.map((s, i) => (
        <ImageWindow
          key={s.id}
          shot={s}
          index={i}
          zIndex={Math.min(Z_BASE + i, Z_TOP)}
          onRaise={() => raise(s.id)}
          onClose={() => close(s.id)}
        />
      ))}
    </ImageViewerContext.Provider>
  )
}

/* 聊天里的截图缩略图：定尺方片（object-cover），点开落进上面的浮窗。
   为什么不是"原样铺一张大图"：一条消息贴 5 张截图就把会话顶成一面墙，滚半天看不到下一句；
   缩略图让"贴了几张图"一眼可数，要看细节再点开（点开的窗不遮会话，可以边看图边回消息）。 */
export function ShotThumb({
  src,
  name,
  size = 'md',
  className,
}: {
  src: string
  name?: string
  size?: 'sm' | 'md'
  className?: string
}) {
  const { openImage } = useImageViewer()
  const label = name || ''
  return (
    <button
      type="button"
      onClick={() => openImage(src, label)}
      title={label ? `${label}（点击查看大图）` : '点击查看大图'}
      aria-label={label ? `查看大图 ${label}` : '查看大图'}
      className={cn(
        'my-1 me-1 inline-block overflow-hidden rounded-lg border align-bottom transition',
        'cursor-zoom-in hover:border-primary focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:outline-none',
        size === 'sm' ? 'size-20' : 'size-28',
        className,
      )}
    >
      {/* contain 而非 cover：贴进来的多是整页截图，cover 会裁成左上角那一块
          （实测第二张截图的左上角恰好是一片空白，缩略图等于什么都没显示） */}
      <img src={src} alt={label} loading="lazy" className="size-full bg-muted/40 object-contain" />
    </button>
  )
}
