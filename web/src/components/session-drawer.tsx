// 聊天窗内的会话抽屉：取代原「历史会话」下拉（老板 2026-09-28：下拉太局限、看不到会话内容，且希望活动会话有动画方便定位）。
//
// 形态：只覆盖**本聊天窗**的内容区（absolute，不 portal 到 body）——每个窗口各有各的抽屉，互不遮挡；
// 左侧滑入 + 遮罩，Esc / 点遮罩关。在跑的会话固定置顶成一组、卡片带流动描边（index.css .ol-live-card）；
// 其余按「置顶 → 时间」排。每张卡给：标题摘要、两行内容预览（收工汇报尾 / 派工指令）、状态·时间·运行环境·档案。
// 277 条这种量级只先渲染前 PAGE 条，「再显示」按需展开（抽屉每次打开都重算，不值得上虚拟列表）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { MagnifyingGlassIcon, PushPinSimpleIcon, XIcon, FileTextIcon, GitBranchIcon } from '@phosphor-icons/react'

import { Input } from '@/components/ui/input'
import { employeeThreads, runSummary, runTitle } from '@/lib/run-threads'
import { isLive, runLabel } from '@/lib/status'
import { dispatchLead, stripDispatchNoise } from '@/lib/dispatch'
import { relTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { LanesResponse, Run } from '@/lib/types'

export type DrawerFilter = 'all' | 'live' | 'pinned'
const PAGE = 60
const FILTERS: { v: DrawerFilter; label: string }[] = [
  { v: 'all', label: '全部' },
  { v: 'live', label: '在跑' },
  { v: 'pinned', label: '置顶' },
]

// 标题 / 预览：在跑的会话 runSummary 会取到 activity（「正在执行命令」），标题预览两行一模一样且看不出这条会话在干嘛
// → 在跑：标题＝派工指令首句（这条会话是做什么的），预览＝当前活动；收工：标题沿用 runSummary，预览＝收工汇报尾 / 指令。
const clean = (t: unknown) => String(t || '').replace(/[#*`>|]/g, '').replace(/\s+/g, ' ').trim()
function title(r: Run): string {
  if (r.title) return runTitle(r, 60) // 有会话标题（自动/手动）优先，下面是没有标题时的老口径
  if (isLive(r) && r.instruction) return dispatchLead(r.instruction) || runSummary(r, 60)
  return runSummary(r, 60)
}
function preview(r: Run): string {
  if (isLive(r)) return r.activity ? `▶ ${clean(r.activity)}` : ''
  return clean(r.resultTail || r.result || stripDispatchNoise(r.instruction || ''))
}
const taskName = (f?: string | null) => (f ? f.replace(/^.*\//, '').replace(/\.md$/, '') : '')

// 卡片必须是模块级组件：定义在 SessionDrawer 里的话每次轮询重渲染都会换一个组件类型 → 整列重挂载，
// 在跑卡片的流动描边动画每 15s 从头重播一次（闪）。
function SessionCard({
  r,
  currentId,
  laneName,
  onSwitch,
  onClose,
  onPin,
}: {
  r: Run
  currentId?: string
  laneName: (id?: string) => string
  onSwitch: (id: string) => void
  onClose: () => void
  onPin: (id: string, pinned: boolean) => void
}) {
  const liveNow = isLive(r)
  const cur = r.id === currentId
  const pv = preview(r)
  const ln = laneName(r.lane)
  return (
    <div
      className={cn(
        'group/sess rounded-lg border bg-card transition hover:border-primary/40 hover:bg-accent/40',
        liveNow && 'ol-live-card border-transparent bg-primary/[0.04]',
        cur && !liveNow && 'border-primary/50 bg-accent/60',
      )}
      data-testid={`session-drawer-item-${r.id}`}
    >
      <div className="flex items-start gap-1.5 p-2">
        <button
          type="button"
          className="grid min-w-0 flex-1 gap-1 text-start"
          onClick={() => {
            onSwitch(r.id)
            onClose()
          }}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {liveNow ? (
              <span className="relative flex size-2 shrink-0">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
            ) : null}
            <span className={cn('min-w-0 truncate text-xs font-medium', liveNow && 'text-primary')}>{title(r) || '（空会话）'}</span>
            {cur && <span className="shrink-0 rounded bg-primary/15 px-1 text-[10px] text-primary">当前</span>}
          </span>
          {pv && <span className={cn('line-clamp-2 text-[11px] leading-snug text-muted-foreground', liveNow && 'text-primary/80')}>{pv}</span>}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground/80">
            {r.consult && <span className="text-amber-600 dark:text-amber-400">只读</span>}
            <span className={cn(liveNow && 'text-primary')}>{runLabel(r.status)}</span>
            <span>· {relTime(r.updatedAt || r.startedAt)}</span>
            {ln && (
              <span className="inline-flex min-w-0 items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                · <GitBranchIcon className="size-2.5 shrink-0" />
                <span className="max-w-28 truncate">{ln}</span>
              </span>
            )}
            {r.taskFile && (
              <span className="inline-flex min-w-0 items-center gap-0.5" title={r.taskFile}>
                · <FileTextIcon className="size-2.5 shrink-0" />
                <span className="max-w-36 truncate">{taskName(r.taskFile)}</span>
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onPin(r.id, !!r.pinned)}
          className={cn(
            'shrink-0 rounded p-1 text-muted-foreground hover:text-foreground',
            !r.pinned && 'opacity-0 group-hover/sess:opacity-100 focus-visible:opacity-100',
          )}
          title={r.pinned ? '取消置顶' : '置顶'}
        >
          <PushPinSimpleIcon weight={r.pinned ? 'fill' : 'regular'} className={cn('size-3.5', r.pinned && 'text-primary')} />
        </button>
      </div>
    </div>
  )
}

export function SessionDrawer({
  open,
  onClose,
  runs,
  employee,
  employeeName,
  currentId,
  initialFilter = 'all',
  lanes,
  onSwitch,
  onPin,
}: {
  open: boolean
  onClose: () => void
  runs?: Run[]
  employee: string
  employeeName: string
  currentId?: string
  initialFilter?: DrawerFilter
  lanes?: LanesResponse
  onSwitch: (id: string) => void
  onPin: (id: string, pinned: boolean) => void
}) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<DrawerFilter>(initialFilter)
  const [limit, setLimit] = useState(PAGE)
  const inputRef = useRef<HTMLInputElement>(null)
  // onClose 走 ref：调用方多半传内联箭头函数，放进 effect 依赖会让每次轮询重渲染都重置筛选/搜索
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // 每次打开：按调用方给的筛选重置（「N 在跑」胶囊进来直接落在「在跑」），清搜索、聚焦搜索框
  useEffect(() => {
    if (!open) return
    setFilter(initialFilter)
    setQ('')
    setLimit(PAGE)
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    // capture + preventDefault：抽屉在聊天卡里，Esc 先关抽屉、不连带把整张卡关掉（卡的 Esc 见 floating-card.tsx）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, initialFilter])

  const all = useMemo(() => employeeThreads(runs, employee), [runs, employee])
  const laneName = (id?: string) => (id ? lanes?.lanes.find((l) => l.id === id)?.name || (id === 'main' ? '主检出' : id) : '')
  const { live, rest, total } = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const hit = (r: Run) =>
      !kw ||
      [r.title, r.instruction, r.result, r.resultTail, r.activity, r.id, r.taskFile, r.lane].some((s) => String(s || '').toLowerCase().includes(kw))
    const list = all.filter(hit)
    const liveList = list.filter((r) => isLive(r))
    const others = list.filter((r) => !isLive(r) && (filter !== 'pinned' || r.pinned))
    return {
      live: filter === 'pinned' ? liveList.filter((r) => r.pinned) : liveList,
      rest: filter === 'live' ? [] : others,
      total: list.length,
    }
  }, [all, q, filter])

  if (!open) return null
  const liveCount = all.filter((r) => isLive(r)).length

  return (
    <div className="absolute inset-0 z-30 flex" data-testid="session-drawer">
      <div className="ol-drawer-fade absolute inset-0 bg-background/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="ol-drawer-in relative flex h-full w-[min(24rem,92%)] flex-col border-e bg-background shadow-xl">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <div className="min-w-0 flex-1 text-sm font-medium">
            {employeeName} 的会话
            <span className="ms-1 text-xs font-normal text-muted-foreground">{all.length}</span>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="关闭">
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="grid gap-2 border-b px-3 py-2">
          <div className="relative">
            <MagnifyingGlassIcon className="pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜指令 / 汇报 / 档案 / 环境 / 会话 ID" className="h-8 ps-7 text-xs" />
          </div>
          <div className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.v}
                type="button"
                onClick={() => setFilter(f.v)}
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-[11px] transition',
                  filter === f.v ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {f.label}
                {f.v === 'live' && liveCount > 0 && <span className="ms-1 tabular-nums">{liveCount}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2">
          {live.length > 0 && (
            <div className="mb-3 grid gap-1.5">
              <div className="text-[11px] font-medium text-primary">正在活动 · {live.length}</div>
              {live.map((r) => (
                <SessionCard key={r.id} r={r} currentId={currentId} laneName={laneName} onSwitch={onSwitch} onClose={onClose} onPin={onPin} />
              ))}
            </div>
          )}
          {rest.length > 0 && (
            <div className="grid gap-1.5">
              {live.length > 0 && <div className="text-[11px] text-muted-foreground">其余会话</div>}
              {rest.slice(0, limit).map((r) => (
                <SessionCard key={r.id} r={r} currentId={currentId} laneName={laneName} onSwitch={onSwitch} onClose={onClose} onPin={onPin} />
              ))}
              {rest.length > limit && (
                <button
                  type="button"
                  onClick={() => setLimit((n) => n + PAGE)}
                  className="rounded-md py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  再显示 {Math.min(PAGE, rest.length - limit)} 条（还有 {rest.length - limit} 条）
                </button>
              )}
            </div>
          )}
          {!live.length && !rest.length && (
            <div className="py-10 text-center text-xs text-muted-foreground">
              {total ? '这个筛选下没有会话' : q ? '没有匹配的会话' : '还没有会话'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
