import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { CaretRightIcon, CheckIcon, CopyIcon, FileTextIcon, FolderIcon } from '@phosphor-icons/react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { Markdown } from '@/components/markdown'
import { splitFrontmatter, parseMetaRows } from '@/lib/frontmatter'
import { cn } from '@/lib/utils'
import { ArchiveBrief } from '@/components/archive-brief'
import { AcceptanceCards } from '@/components/acceptance-cards'
import { GuardedArchiveDialog } from '@/components/guarded-archive-dialog'
import {apiGet, apiPost} from '@/lib/api'
import { copyText } from '@/lib/clipboard'

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i
// 二进制文档（导出的 xlsx 证据等）没法在文本弹层里看：/api/file 预览分支按 utf8 读 + 1MB 上限，
// 1.4MB 的导出件直接 413「打开文件失败」，小的也只是一屏乱码 → 点开改成直接下载，交给本机 Excel/WPS 打开。
const BINARY_RE = /\.(xlsx?|xlsm|docx?|pptx?|pdf|zip|rar|7z|gz|tar|jar|exe|mp4|mov|mp3|wav)$/i

type Ctx = { openFile: (path: string) => void }

// /api/file 命中目录时的返回（file 卡指向一整个证据目录，如「视觉初筛截图/第2轮」）
type DirEntry = { name: string; path: string; dir: boolean; size: number | null }
type DirListing = { kind: 'dir'; path: string; entries: DirEntry[]; truncated?: boolean; total?: number }
const isDirListing = (v: unknown): v is DirListing =>
  !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'dir' && Array.isArray((v as { entries?: unknown }).entries)

function fmtSize(n: number | null) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// 目录预览：图片铺缩略图（截图目录是最常见的情形），其余文件/子目录列成行，点开都走同一个 openFile。
function DirView({ listing, onOpen }: { listing: DirListing; onOpen: (p: string) => void }) {
  const images = listing.entries.filter((e) => !e.dir && IMAGE_RE.test(e.name))
  const others = listing.entries.filter((e) => e.dir || !IMAGE_RE.test(e.name))
  if (!listing.entries.length) return <div className="text-xs text-muted-foreground italic">（空文件夹）</div>
  return (
    <div className="grid gap-3" data-testid="file-viewer-dir">
      <div className="text-xs text-muted-foreground">
        文件夹 · {listing.total ?? listing.entries.length} 项{listing.truncated ? '（只列出前 500 项）' : ''}
      </div>
      {images.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => onOpen(e.path)}
              title={e.name}
              className="group min-w-0 overflow-hidden rounded border text-start transition-colors hover:border-primary/50"
            >
              <img
                src={`/api/file?raw=1&path=${encodeURIComponent(e.path)}`}
                alt={e.name}
                loading="lazy"
                className="aspect-video w-full bg-muted/30 object-contain"
              />
              <span className="block truncate border-t px-2 py-1 text-[11px] text-muted-foreground group-hover:text-foreground">{e.name}</span>
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="grid min-w-0 gap-1">
          {others.map((e) => (
            <button
              key={e.path}
              type="button"
              onClick={() => onOpen(e.path)}
              className="flex min-w-0 items-center gap-2 rounded border px-2 py-1.5 text-start text-sm transition-colors hover:border-primary/50"
            >
              {e.dir ? <FolderIcon className="size-4 shrink-0 text-muted-foreground" /> : <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              {!e.dir && <span className="shrink-0 text-[11px] text-muted-foreground">{fmtSize(e.size)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
const FileViewerContext = createContext<Ctx>({ openFile: () => {} })

export function useFileViewer() {
  return useContext(FileViewerContext)
}

// frontmatter 元数据：紧凑定义网格，布尔值上色片，行内注释淡显
function FrontmatterCard({ meta }: { meta: string }) {
  const rows = useMemo(() => parseMetaRows(meta), [meta])
  const title = rows.find((r) => r.key === 'task')?.value
  const status = rows.find((r) => r.key === 'status')?.value
  return (
    <Collapsible defaultOpen className="mb-3 rounded-md border bg-muted/20">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-start text-xs font-medium">
        <CaretRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span className="text-muted-foreground">元数据</span>
        <span className="truncate text-foreground">{title || 'frontmatter'}</span>
        {status && (
          <span className="ms-auto shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
            {status}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 border-t px-3 py-2 text-xs">
          {rows.map((r, i) =>
            r.isGroup ? (
              <dt
                key={i}
                className="col-span-2 mt-1 font-mono font-medium text-muted-foreground first:mt-0"
              >
                {r.key}
              </dt>
            ) : (
              <div
                key={i}
                className="col-span-2 grid grid-cols-subgrid items-baseline"
                style={r.indent > 0 ? { paddingInlineStart: r.indent * 4 } : undefined}
              >
                <dt className="truncate font-mono text-muted-foreground" title={r.key}>
                  {r.key}
                </dt>
                <dd className="min-w-0 break-words">
                  <BoolOrText value={r.value} />
                  {r.comment && (
                    <span className="ms-1.5 text-muted-foreground/60"># {r.comment}</span>
                  )}
                </dd>
              </div>
            ),
          )}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}

function BoolOrText({ value }: { value: string }) {
  if (value === 'true' || value === 'false') {
    return (
      <span
        className={cn(
          'inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
          value === 'true'
            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
        )}
      >
        {value}
      </span>
    )
  }
  return <span className="text-foreground">{value || '—'}</span>
}

// 晨检验收：**视图，不是文件**。任务档案与版本验收单本来就是 1:1（一版一份档案），而验收单的内容
// 100% 派生自档案 + 台账 + 契约 —— 落成第二个文件就是把登记表抄了一遍（违反 README「指针不复制」），
// 还得靠定时巡检防它过期。做成页签后新鲜是免费的。先例：facet 覆盖抽屉（`/api/coverage`，从不落文件）。
type Acceptance = {
  ok?: boolean
  error?: string
  version?: string
  body?: string
  gaps?: string[]
  entries?: number
  rounds?: number
  snapshotRel?: string
}

// 三选一置顶：老板要做的动作不该埋在正文第四章下面等他滚。正文仍完整渲染在下方。
function AcceptancePanel({
  acc,
  busy,
  onDecide,
}: {
  acc: Acceptance | null
  busy: boolean
  onDecide: (d: 'pass' | 'partial' | 'reject', label: string) => void
}) {
  if (busy || !acc) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-4/5" />
      </div>
    )
  }
  if (acc.error) {
    return <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">出不了验收单：{acc.error}</div>
  }
  const DECISIONS = [
    ['pass', '整版通过'],
    ['partial', '部分通过'],
    ['reject', '整版打回'],
  ] as const
  return (
    <>
      <div className="mb-3 rounded-md border bg-muted/20 p-3">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{acc.version}</span>
          <span>登记表 {acc.entries} 条</span>
          <span>守航 {acc.rounds} 轮</span>
          {!!acc.gaps?.length && <span className="text-amber-600 dark:text-amber-400">缺料 {acc.gaps.length} 处</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          {DECISIONS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => onDecide(k, label)}
              className="rounded border px-2.5 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
            >
              {label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          点了只**记录**进任务档案时间线：不改 gates、不触发发布。生产发布永远由你自己按下。
        </p>
      </div>
      <Markdown>{acc.body || ''}</Markdown>
    </>
  )
}

// 一键复制文件全文（2026-10-07 老板：SQL 这类文件看完要整段拿去执行，手动全选拖不到底）。
// 复制的是接口返回的原文（含 .md 的 frontmatter），不是渲染后的 DOM 文字。
function CopyFileButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false)
  return (
    <button
      type="button"
      data-testid="file-viewer-copy"
      title="复制文件全文"
      onClick={() =>
        copyText(text)
          .then(() => {
            setOk(true)
            setTimeout(() => setOk(false), 1500)
          })
          .catch(() => toast.error('复制失败', { description: '浏览器不允许写剪贴板' }))
      }
      className={cn(
        // 与弹窗自带的关闭 ✕（absolute top-2 end-2、size-6）同一行同高、紧挨在它左边，不跟标题挤在一行里
        'absolute top-2 end-10 z-10 inline-flex h-6 items-center gap-1 rounded-md border bg-background px-2 text-xs transition-colors',
        ok ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {ok ? <CheckIcon className="size-3.5" weight="bold" /> : <CopyIcon className="size-3.5" />}
      {ok ? '已复制' : '复制全文'}
    </button>
  )
}

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState('')
  const [text, setText] = useState<string | null>(null)
  const [dir, setDir] = useState<DirListing | null>(null)
  // 'cards' = 验收卡（v0.11.0 起老板早上看的东西）；'acceptance' = 底稿（机器证据全文，原「晨检验收」长文档，从验收卡里点进来）
  const [tab, setTab] = useState<'brief' | 'file' | 'cards' | 'acceptance'>('file')
  const [acc, setAcc] = useState<Acceptance | null>(null)
  const [accBusy, setAccBusy] = useState(false)
  const [guardOpen, setGuardOpen] = useState(false)   // 「守航推进」这份档案（v0.11.0 二期）

  const openFile = useCallback((p: string) => {
    if (BINARY_RE.test(p)) {
      const a = document.createElement('a')
      a.href = `/api/file?download=1&path=${encodeURIComponent(p)}`
      a.download = p.replace(/^.*\//, '')
      a.click()
      toast.info('该类型文件不支持预览，已改为下载', { description: p.replace(/^.*\//, '') })
      return
    }
    setPath(p)
    setText(null)
    setDir(null)
    // 图片（证据截图等）不走文本预览：/api/file 默认按 utf8 读，PNG 会被读成一屏乱码
    if (IMAGE_RE.test(p)) {
      setTab('file')
      setAcc(null)
      setOpen(true)
      return
    }
    // 任务档案默认落「要点」页：人打开它是来做决定的，不是来读 137KB 台账的（§3.125）。
    // 别的文档（交接卡/复盘/需求文档）照旧直接给正文。
    setTab(/\/tasks\/.+\.md$/.test(p) ? 'brief' : 'file')
    setAcc(null)
    setOpen(true)
    apiGet<string>(`/api/file?path=${encodeURIComponent(p)}`)
      .then((t) => {
        if (isDirListing(t)) {
          setTab('file')
          setDir(t)
          return
        }
        setText(typeof t === 'string' ? t : JSON.stringify(t, null, 2))
      })
      .catch((e) => {
        toast.error('打开文件失败', { description: (e as Error).message })
        setOpen(false)
      })
  }, [])

  const isMd = path.endsWith('.md')
  const isImage = IMAGE_RE.test(path)
  // 拆 frontmatter + 记忆化正文渲染：大档案（可达 200KB+）解析很贵，
  // 不能让背景 SSE/轮询触发的父层重渲染反复重新 parse（原先的卡顿根因）。
  const parsed = useMemo(() => {
    if (text == null) return null
    if (!isMd) return { meta: null as string | null, body: text }
    return splitFrontmatter(text)
  }, [text, isMd])

  const rendered = useMemo(() => {
    if (parsed == null) return null
    if (!isMd) return <pre className="text-xs whitespace-pre-wrap break-words">{parsed.body}</pre>
    return (
      <>
        {parsed.meta && <FrontmatterCard meta={parsed.meta} />}
        <Markdown>{parsed.body}</Markdown>
      </>
    )
  }, [parsed, isMd])

  // 只有「带 version 的任务档案」才谈得上版本验收单——交接卡、复盘文档、晨检快照都不该出这个页签。
  const isVersionArchive = useMemo(() => {
    if (!isMd || !parsed?.meta || !path.includes('/tasks/')) return false
    const rows = parseMetaRows(parsed.meta)
    const has = (k: string) => rows.some((r) => r.key === k && r.value)
    return has('version') && has('task') && has('status')
  }, [isMd, parsed, path])

  const loadAcceptance = useCallback(() => {
    setTab('acceptance')
    if (acc || accBusy) return
    setAccBusy(true)
    apiGet<Acceptance>(`/api/version-report?file=${encodeURIComponent(path)}`)
      .then(setAcc)
      .catch((e) => setAcc({ error: (e as Error).message }))
      .finally(() => setAccBusy(false))
  }, [acc, accBusy, path])

  const decide = useCallback(
    (decision: 'pass' | 'partial' | 'reject', label: string) => {
      fetch('/api/version-report/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: path, decision }),
      })
        .then((r) => r.json())
        .then((r) => {
          if (r.error) toast.error('记录决策失败', { description: r.error })
          // 只记录、不动 gates —— 发布仍由你按下，引擎从不替你按发布门
          else toast.success(`已记录：${label}`, { description: '写进任务档案时间线；未改 gates、未触发发布' })
        })
        .catch((e) => toast.error('记录决策失败', { description: String(e) }))
    },
    [path],
  )

  // 「要点」页的拍板按钮 → 派工菲菲落实。
  // **刻意不让引擎直接改档案**：拍板结论要回写「待确认事项」那张长表格 + 同步受影响的
  // facet/功能树 + 记时间线，这是菲菲的活（引擎手改长表格锚点易失配、并发会互相覆盖，§3.3 事故）。
  // 老板拍板 → 菲菲落实，与 office-lab 的既有分工一致：老板只做决定，回写永远由 owner 做。
  const dispatchFeifei = useCallback(
    (instruction: string) => {
      apiPost<{ runId: string }>('/api/dispatch', { employee: 'feifei', instruction, taskFile: path, kind: 'dispatch' })
        .then((r) => toast.success('已派工菲菲落实这条拍板', { description: `运行 ${r.runId}` }))
        .catch((e) => toast.error('派工失败', { description: (e as Error).message }))
    },
    [path],
  )

  // value 恒定（openFile 本身是 useCallback）：否则打开/关闭档案预览这个 state 变化，
  // 会顺带把全站每个 useFileViewer() 消费者重渲染一遍。
  const value = useMemo(() => ({ openFile }), [openFile])

  return (
    <FileViewerContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        {/* 窄屏几乎占满视口（w-[calc(100%-1rem)] + 92svh）：文档是拿来**读**的，
            手机上还留一圈 2rem 边距等于把本就窄的正文再切掉一截。 */}
        <DialogContent className="max-h-[92svh] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] gap-0 overflow-hidden p-0 sm:max-h-[85svh] sm:max-w-5xl lg:max-w-6xl">
          {/* 只在看原文时给：要点 / 验收卡页签是加工过的视图，复制原文会让人误以为复制的是眼前这页 */}
          {tab === 'file' && !isImage && text != null && <CopyFileButton text={text} />}
          {/* 标题右侧让出关闭 ✕（+ 复制按钮）的位置，长路径截断而不是钻到按钮底下 */}
          <DialogHeader className={cn('border-b p-3 pb-0 pe-10 sm:p-4 sm:pb-0', tab === 'file' && !isImage && text != null && 'pe-32 sm:pe-32')}>
            {/* 路径在窄屏只留文件名（前面那串目录挤掉标题不说，本身也不是这时候要看的） */}
            <DialogTitle className="truncate font-mono text-xs sm:text-sm">
              <span className="sm:hidden">{path.replace(/^.*\//, '')}</span>
              <span className="hidden sm:inline">{path}</span>
            </DialogTitle>
            {isVersionArchive && (
              <div className="-mb-px flex gap-1 pt-3">
                {([
                  ['brief', '要点'],
                  ['file', '档案'],
                  ['cards', '验收卡'],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setTab(k)}
                    data-testid={`file-viewer-tab-${k}`}
                    className={cn(
                      'rounded-t border border-b-0 px-3 py-1.5 text-xs',
                      tab === k || (k === 'cards' && tab === 'acceptance')
                        ? 'border-border bg-background font-medium text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
                <button
                  onClick={() => setGuardOpen(true)}
                  data-testid="file-viewer-guarded-launch"
                  title="签一份只管这份档案的守航契约，交负责人（默认菲菲）全权推进到验收卡填满"
                  className="ms-auto mb-1 rounded border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  🛡 守航推进
                </button>
              </div>
            )}
          </DialogHeader>
          <div className="max-h-[80svh] overflow-auto p-3 sm:max-h-[70svh] sm:p-4">
            {tab === 'brief' ? (
              <ArchiveBrief path={path} onOpenRaw={() => setTab('file')} onDispatch={dispatchFeifei} />
            ) : tab === 'cards' ? (
              <AcceptanceCards file={path} onOpenRaw={loadAcceptance} />
            ) : tab === 'acceptance' ? (
              <>
                <button type="button" onClick={() => setTab('cards')} className="mb-2 text-xs text-muted-foreground underline-offset-2 hover:underline">
                  ← 回到验收卡
                </button>
                <AcceptancePanel acc={acc} busy={accBusy} onDecide={decide} />
              </>
            ) : dir ? (
              <DirView listing={dir} onOpen={openFile} />
            ) : isImage ? (
              <a href={`/api/file?raw=1&path=${encodeURIComponent(path)}`} target="_blank" rel="noopener" title="新标签页打开原图">
                <img
                  src={`/api/file?raw=1&path=${encodeURIComponent(path)}`}
                  alt={path.replace(/^.*\//, '')}
                  className="mx-auto h-auto max-w-full rounded border"
                  onError={() => toast.error('图片加载失败', { description: path })}
                />
              </a>
            ) : rendered == null ? (
              <div className="grid gap-2">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-5/6" />
              </div>
            ) : (
              rendered
            )}
          </div>
        </DialogContent>
      </Dialog>
      {isVersionArchive && <GuardedArchiveDialog open={guardOpen} onOpenChange={setGuardOpen} file={path} />}
    </FileViewerContext.Provider>
  )
}
