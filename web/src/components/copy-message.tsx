import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { cn } from '@/lib/utils'

// 气泡下方的「复制这条消息」动作，与旧 UI 的 `.msg-copy` 同口径（hover 才现、点后短暂变「已复制」、
// 只在失败时吐司）。两点值得说明：
//   ① **复制源用原始文本、不读 DOM innerText** —— 气泡里混着图片/附件卡/markdown 渲染结果，
//      读 DOM 会把图片吃成空串、把渲染出来的装饰一起抄走，抄回去的东西粘出来不是当初发的那段。
//   ② hover 之外补一个 `pointer-coarse` 常显淡态 —— 触屏没有 hover，纯 hover 露出等于移动端永远复制不了。
// 需要外层给一个 `group/msg` 容器（hover 该消息整行才淡入）。
export function CopyMessage({ text, className }: { text: string; className?: string }) {
  const [ok, setOk] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), [])
  if (!text.trim()) return null
  return (
    <button
      type="button"
      title="复制这条消息"
      aria-label="复制这条消息"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setOk(true)
            if (timer.current) window.clearTimeout(timer.current)
            timer.current = window.setTimeout(() => setOk(false), 1200)
          })
          .catch(() => toast.error('复制失败（浏览器限制或非 https）'))
      }}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] leading-none transition-opacity',
        'opacity-0 group-hover/msg:opacity-70 hover:opacity-100! focus-visible:opacity-100 pointer-coarse:opacity-60',
        ok ? 'text-emerald-500 opacity-100!' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
    >
      {ok ? (
        <>
          <CheckIcon className="size-3" weight="bold" />
          已复制
        </>
      ) : (
        <CopyIcon className="size-3" />
      )}
    </button>
  )
}
