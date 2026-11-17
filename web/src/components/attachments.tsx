import { useCallback, useState, type ClipboardEvent } from 'react'
import { XIcon, FileIcon, TextAlignLeftIcon, ArrowUDownLeftIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { uploadFile, attachmentMarker, type Upload } from '@/lib/upload'
import { useImageViewer } from '@/components/image-viewer'
import { cn } from '@/lib/utils'

// 粘贴长文本的阈值：超过就不往输入框里塞，转成附件 chip（一大坨 JSON/日志铺进气泡会把会话顶成一面墙）
const LONG_PASTE_CHARS = 1500
const LONG_PASTE_LINES = 30

export function isLongPaste(text: string): boolean {
  return text.length >= LONG_PASTE_CHARS || text.split('\n').length >= LONG_PASTE_LINES
}

function pastedTextFile(text: string): File {
  const t = text.trim()
  let ext = 'txt'
  let type = 'text/plain'
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t)
      ext = 'json'
      type = 'application/json'
    } catch {
      /* 不是合法 JSON，按纯文本 */
    }
  }
  // 名字里不能有冒号：消息哨兵 `[附件] name：path` 靠冒号切名字和路径
  const d = new Date()
  const hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('')
  return new File([text], `粘贴文本-${hms}.${ext}`, { type })
}

// 待发附件；粘贴文本转来的额外带原文（chip 上给「还原为正文」）
export type PendingUpload = Upload & { text?: string }

export function useAttachments() {
  const [items, setItems] = useState<PendingUpload[]>([])
  const [busy, setBusy] = useState(false)

  const addFiles = useCallback(async (files: FileList | File[] | null | undefined) => {
    if (!files) return
    const list = Array.from(files)
    if (!list.length) return
    setBusy(true)
    for (const f of list) {
      try {
        const u = await uploadFile(f)
        setItems((p) => [...p, u])
      } catch (e) {
        toast.error('上传失败', { description: (e as Error).message })
      }
    }
    setBusy(false)
  }, [])

  const addText = useCallback(async (text: string) => {
    setBusy(true)
    try {
      const u = await uploadFile(pastedTextFile(text))
      setItems((p) => [...p, { ...u, text }])
    } catch (e) {
      toast.error('粘贴文本转附件失败', { description: (e as Error).message })
    }
    setBusy(false)
  }, [])

  // 输入框统一粘贴口：剪贴板带文件（截图 / 资源管理器里复制的文件）→ 附件；长文本 → 文本附件；
  // 短文本不拦，照常进输入框。
  const onPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData.files)
      if (files.length) {
        e.preventDefault()
        addFiles(files)
        return
      }
      const text = e.clipboardData.getData('text/plain')
      if (text && isLongPaste(text)) {
        e.preventDefault()
        addText(text)
      }
    },
    [addFiles, addText],
  )

  const remove = useCallback((i: number) => setItems((p) => p.filter((_, j) => j !== i)), [])
  const clear = useCallback(() => setItems([]), [])
  const markers = useCallback(() => items.map(attachmentMarker).join('\n'), [items])

  return { items, busy, addFiles, addText, onPaste, remove, clear, markers }
}

function textMeta(text: string): string {
  const lines = text.split('\n').length
  const kb = new Blob([text]).size / 1024
  return `${lines} 行 · ${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
}

// 待发附件条：图片给真缩略图（一眼看出"我挂的是哪张"，而不是一排同款图标 + 截屏默认长文件名），
// 点缩略图＝按原图开浮窗，发出去之前也能先核一眼。
export function AttachmentBar({
  items,
  onRemove,
  onInline,
  className,
}: {
  items: PendingUpload[]
  onRemove: (i: number) => void
  // 粘贴文本 chip 的「还原为正文」：把原文交回输入框（不传则不显示该键）
  onInline?: (text: string, i: number) => void
  className?: string
}) {
  const { openImage } = useImageViewer()
  if (!items.length) return null
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {items.map((u, i) => (
        <span key={i} className="flex items-center gap-1.5 rounded-lg border bg-muted/40 py-1 pe-1.5 ps-1.5 text-xs">
          {u.kind === 'image' ? (
            <button
              type="button"
              onClick={() => openImage(u.url, u.name)}
              title="点击查看大图"
              className="size-7 shrink-0 cursor-zoom-in overflow-hidden rounded-md border transition hover:border-primary"
            >
              <img src={u.url} alt={u.name} className="size-full object-cover" />
            </button>
          ) : (
            <span className="grid size-5 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              {u.text != null ? <TextAlignLeftIcon className="size-3" /> : <FileIcon className="size-3" />}
            </span>
          )}
          <span className="max-w-40 truncate font-medium" title={u.text != null ? u.text.slice(0, 300) : u.name}>
            {u.name}
          </span>
          {u.text != null && <span className="shrink-0 text-muted-foreground">{textMeta(u.text)}</span>}
          {u.text != null && onInline && (
            <button
              onClick={() => onInline(u.text!, i)}
              aria-label="还原为正文"
              title="还原为正文（贴回输入框）"
              className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ArrowUDownLeftIcon className="size-3" />
            </button>
          )}
          <button
            onClick={() => onRemove(i)}
            aria-label="移除"
            className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  )
}
