import { useEffect, useRef, useState } from 'react'
import { PaperclipIcon, ClipboardTextIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { splitWecomClipboard } from '@/lib/chatlog'
import { uploadFile, uploadLocalPath, type Upload } from '@/lib/upload'

// 取光标相邻(前/后)的直接子节点（dir: -1=Backspace 前 / +1=Delete 后）。对齐旧 UI richNodeBeside。
function richNodeBeside(ed: HTMLElement, range: Range, dir: number): Node | null {
  const c = range.startContainer
  const o = range.startOffset
  if (c.nodeType === 3) {
    if (dir < 0 && o > 0) return null // 文本中间删字符 → 默认
    if (dir > 0 && o < (c.nodeValue || '').length) return null
    let n: Node | null = c // 文本边界 → 上溯到 ed 直接子级再取相邻
    while (n && n !== ed && !(dir < 0 ? n.previousSibling : n.nextSibling)) n = n.parentNode
    if (!n || n === ed) return null
    return dir < 0 ? n.previousSibling : n.nextSibling
  }
  if (dir < 0) return o > 0 ? c.childNodes[o - 1] : null
  return c.childNodes[o] || null
}

// 粘贴聊天记录 —— 提为组合器一级按钮（不再埋进 ＋ 菜单）。
// onChatlog 收到编辑器序列化后的 raw（不含哨兵包裹）——由外层抽象成一枚待发 chip、发送时才拼进消息。
export function ComposerExtras({ onChatlog }: { onChatlog: (raw: string) => void }) {
  const [chatlogOpen, setChatlogOpen] = useState(false)

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground md:size-8"
        onClick={() => setChatlogOpen(true)}
        aria-label="粘贴聊天记录"
        title="粘贴聊天记录"
      >
        <ClipboardTextIcon />
      </Button>

      <ChatlogDialog open={chatlogOpen} onOpenChange={setChatlogOpen} onConfirm={onChatlog} />
    </>
  )
}

// 聊天记录富编辑器：contenteditable，可粘贴/拖入截图（图文按聊天顺序穿插），序列化成含 〖截图〗 哨兵的 raw。
// 对齐旧 UI serializeRichEditor + insertImg + pending 上传门禁；弹窗封顶 85svh、编辑区内滚（修高度超屏）。
function ChatlogDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onConfirm: (raw: string) => void
}) {
  const edRef = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState(0)
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    if (open && edRef.current) {
      edRef.current.innerHTML = ''
      setEmpty(true)
      setPending(0)
    }
  }, [open])

  function syncEmpty() {
    const ed = edRef.current
    setEmpty(!ed || (!ed.textContent?.trim() && !ed.querySelector('img')))
  }

  function makeImg(u: Upload) {
    const img = document.createElement('img')
    img.src = u.url
    img.dataset.path = u.path
    img.dataset.name = u.name
    // 内联图 + 单个 br：block+margin+br 会在图下留一大截空行（老板反馈的坑）
    img.className = 'inline-block max-h-40 max-w-full rounded border align-bottom'
    return img
  }

  // 在光标处插入一串节点（有选区先删掉；不在编辑器内则追加到末尾），光标落到末尾
  function insertNodes(nodes: Node[]) {
    const ed = edRef.current
    if (!ed || !nodes.length) return
    const sel = window.getSelection()
    let range: Range
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0)
      range.deleteContents()
    } else {
      range = document.createRange()
      range.selectNodeContents(ed)
      range.collapse(false)
    }
    const frag = document.createDocumentFragment()
    nodes.forEach((n) => frag.appendChild(n))
    const last = nodes[nodes.length - 1]
    range.insertNode(frag)
    range.setStartAfter(last)
    range.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(range)
    syncEmpty()
  }

  // 在光标处内联插入截图，图后补 <br> 便于继续输入
  function insertImg(u: Upload) {
    insertNodes([makeImg(u), document.createElement('br')])
  }

  // 粘贴：图片文件照旧上传；其余一律按纯文本插入，不让来源富文本（样式/缩进/读不到的 file:// 坏图）进编辑器。
  // 企微多选复制额外把 [图片] 占位换成本地缓存里的原图（见 splitWecomClipboard）。
  async function onEditorPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const cd = e.clipboardData
    const files = [...(cd?.files || [])].filter((f) => f.type.startsWith('image/') && f.size > 0)
    e.preventDefault()
    if (files.length) {
      uploadImages(files)
      return
    }
    const text = (cd?.getData('text/plain') || '').replace(/\r\n/g, '\n')
    const wc = splitWecomClipboard(text, cd?.getData('text/html') || '')
    if (!wc) {
      if (text) insertNodes([document.createTextNode(text)])
      return
    }
    // 先记下光标（上传是异步的，期间焦点可能变），上传完再按顺序一次性插入
    const sel = window.getSelection()
    const saved = sel && sel.rangeCount && edRef.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null
    setPending((p) => p + 1)
    let resps: (Upload | null)[] = []
    try {
      resps = await Promise.all(
        wc.parts.slice(1).map((_, i) => (wc.paths[i] ? uploadLocalPath(wc.paths[i]).catch(() => null) : Promise.resolve(null))),
      )
    } finally {
      setPending((p) => p - 1)
    }
    const nodes: Node[] = []
    wc.parts.forEach((t, i) => {
      if (i > 0) {
        const u = resps[i - 1]
        if (u?.path) {
          nodes.push(makeImg(u), document.createElement('br'))
          t = t.replace(/^[ \t]+/, '') // 图独占一行，吃掉 [图片] 后的空格
        } else nodes.push(document.createTextNode('[图片·未能带入，可手动拖入]'))
      }
      if (t) nodes.push(document.createTextNode(t))
    })
    if (saved) {
      sel?.removeAllRanges()
      sel?.addRange(saved)
    }
    insertNodes(nodes)
    const miss = resps.filter((u) => !u?.path).length
    if (miss) toast.warning(`${miss} 张图片没能自动带入`, { description: '企微可能还没缓存这张原图：在企微里点开一次再复制，或手动拖入。' })
  }

  // 图片删除修正：contenteditable 里 Backspace/Delete 删图浏览器行为不确定（选中/反向删/删不掉）——
  // 命中图片(或其配对 br)边界时确定性地删掉整张图 + 配对 br。对齐旧 UI richEditorDeleteFix（踩过的坑）。
  function onEditorKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return
    const ed = edRef.current
    if (!ed) return
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (!range.collapsed || !ed.contains(range.startContainer)) return // 有选区/焦点不在内 → 默认
    const dir = e.key === 'Backspace' ? -1 : 1
    const node = richNodeBeside(ed, range, dir)
    let img: HTMLElement | null = null
    let pairBr: ChildNode | null = null
    if (node && node.nodeName === 'IMG') {
      img = node as HTMLElement
      if (img.nextSibling && img.nextSibling.nodeName === 'BR') pairBr = img.nextSibling
    } else if (node && node.nodeName === 'BR') {
      const sib = dir < 0 ? node.previousSibling : node.nextSibling
      if (sib && sib.nodeName === 'IMG') {
        img = sib as HTMLElement
        pairBr = node as ChildNode
      }
    }
    if (!img) return // 非图片边界 → 默认（正常删字符/换行）
    e.preventDefault()
    const r = document.createRange()
    r.setStartBefore(img)
    r.collapse(true)
    img.remove()
    if (pairBr) pairBr.remove()
    sel.removeAllRanges()
    sel.addRange(r)
    syncEmpty()
  }

  async function uploadImages(files: FileList | File[] | null | undefined) {
    const imgs = Array.from(files || []).filter((f) => f.type.startsWith('image/') && f.size > 0)
    if (!imgs.length) return
    for (const f of imgs) {
      setPending((p) => p + 1)
      try {
        const u = await uploadFile(f)
        if (u?.path) insertImg(u)
      } catch (e) {
        toast.error('上传失败', { description: (e as Error).message })
      } finally {
        setPending((p) => p - 1)
      }
    }
  }

  // 序列化 contenteditable → raw（文本原样、IMG→〖截图〗path｜name〖/截图〗、块级换行）
  function serialize(): string {
    const ed = edRef.current
    if (!ed) return ''
    let out = ''
    const walk = (node: Node) => {
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) out += n.nodeValue ?? ''
        else if (n.nodeName === 'IMG') {
          const el = n as HTMLElement
          const path = el.dataset.path
          if (!path) return
          if (out && !out.endsWith('\n')) out += '\n'
          out += `〖截图〗${path}｜${el.dataset.name || ''}〖/截图〗\n`
        } else if (n.nodeName === 'BR') out += '\n'
        else if (n.nodeName === 'DIV' || n.nodeName === 'P') {
          if (out && !out.endsWith('\n')) out += '\n'
          walk(n)
        } else walk(n)
      })
    }
    walk(ed)
    return out.replace(/\n{3,}/g, '\n\n').trim()
  }

  function confirm() {
    if (pending > 0) return
    const raw = serialize()
    if (!raw) {
      edRef.current?.focus()
      return
    }
    onConfirm(raw)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        // 点遮罩不关：粘了一大段记录 + 截图，手一滑点到外面就全丢（老板 2026-10-06 反馈误操作）。只认取消 / 插入 / 右上角 × / Esc
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b p-4">
          <DialogTitle>粘贴聊天记录</DialogTitle>
          <DialogDescription>
            企微/群里「多选复制」粘到下面；<b>截图可直接粘贴/拖入，图文按顺序穿插</b>。原文用 〘聊天记录〙 哨兵包裹嵌入消息、对内容无害。
          </DialogDescription>
        </DialogHeader>

        <div className="relative min-h-0 flex-1 overflow-auto p-4">
          {empty && (
            <div className="pointer-events-none absolute inset-x-4 top-4 text-sm text-muted-foreground">
              把聊天记录粘到这里…（截图可直接粘/拖入，图文穿插）
            </div>
          )}
          <div
            ref={edRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            onInput={syncEmpty}
            onKeyDown={onEditorKeyDown}
            onPaste={onEditorPaste}
            onDragOver={(e) => {
              if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault()
            }}
            onDrop={(e) => {
              if ([...(e.dataTransfer?.types || [])].includes('Files')) {
                e.preventDefault()
                uploadImages(e.dataTransfer.files)
              }
            }}
            className="min-h-40 text-sm break-words whitespace-pre-wrap outline-none [&_img]:cursor-default"
          />
        </div>

        <DialogFooter className="items-center border-t p-4">
          <label className="me-auto inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <PaperclipIcon className="size-4" /> 加截图
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                uploadImages(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          {pending > 0 && <span className="text-xs text-muted-foreground">上传中…（{pending}）</span>}
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={pending > 0 || empty} onClick={confirm}>插入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
