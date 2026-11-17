import { useEffect, useRef, useState } from 'react'

import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'

// 移动端悬浮导航按钮（FAB）：替代顶栏汉堡键，默认落在右下角、便于单手拇指够到；
// 可拖动到任意位置（记忆），点击打开全屏导航抽屉。属于应用外壳，进入 /chat 聊天页时随外壳一并隐藏。
const KEY = 'ol-fab-pos'
const SIZE = 56 // px, = size-14

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}
function load(): { x: number; y: number } | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null')
  } catch {
    return null
  }
}
function save(p: { x: number; y: number }) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

export function MobileFab() {
  const { toggleSidebar } = useSidebar()
  const isMobile = useIsMobile()
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const start = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)
  const moved = useRef(false)

  // 初始位置：优先记忆，否则右下角（留出底部安全区手势条空间）
  useEffect(() => {
    if (!isMobile || pos) return
    setPos(
      load() ?? {
        x: window.innerWidth - SIZE - 16,
        y: window.innerHeight - SIZE - 32,
      },
    )
  }, [isMobile, pos])

  useEffect(() => {
    if (!pos) return
    function onMove(e: PointerEvent) {
      if (!start.current) return
      if (Math.hypot(e.clientX - start.current.px, e.clientY - start.current.py) > 5) {
        moved.current = true
      }
      setPos({
        x: clamp(start.current.ox + (e.clientX - start.current.px), 8, window.innerWidth - SIZE - 8),
        y: clamp(start.current.oy + (e.clientY - start.current.py), 8, window.innerHeight - SIZE - 8),
      })
    }
    function onUp() {
      if (start.current) {
        start.current = null
        setPos((p) => {
          if (p) save(p)
          return p
        })
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [pos])

  // 视口变化时拉回可见范围
  useEffect(() => {
    function onResize() {
      setPos(
        (p) =>
          p && {
            x: clamp(p.x, 8, window.innerWidth - SIZE - 8),
            y: clamp(p.y, 8, window.innerHeight - SIZE - 8),
          },
      )
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  if (!isMobile || !pos) return null
  return (
    <button
      className="fixed z-40 size-14 touch-none overflow-hidden rounded-full border bg-card shadow-lg transition-transform active:scale-95"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => {
        ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        moved.current = false
        start.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y }
      }}
      onClick={() => {
        if (!moved.current) toggleSidebar() // 拖动过就不当作点击
      }}
      aria-label="打开导航"
      title="导航"
    >
      <img src="/logo.png" alt="" className="size-full object-cover" draggable={false} />
    </button>
  )
}
