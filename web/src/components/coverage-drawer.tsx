import { useEffect, useMemo, useRef, useState } from 'react'
import { CaretDownIcon, CaretRightIcon } from '@phosphor-icons/react'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { apiGet } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Coverage, CoverageRow, TaskEntry } from '@/lib/types'

const STATUS_META: Record<string, { label: string; mark: string; tone: string; seg: string }> = {
  COVERED_GREEN: { label: '已覆盖', mark: '✓', tone: 'text-emerald-500', seg: 'bg-emerald-500' },
  SOURCE_ATTESTED: { label: '源证', mark: '✓', tone: 'text-teal-500', seg: 'bg-teal-400' },
  BLOCKED_WITH_PROOF: { label: '阻塞有据', mark: '◐', tone: 'text-amber-500', seg: 'bg-amber-500' },
  HUMAN_INHERENT: { label: '人验', mark: '◉', tone: 'text-muted-foreground', seg: 'bg-zinc-400/60' },
  UNCOVERED: { label: '未覆盖', mark: '✕', tone: 'text-destructive', seg: 'bg-destructive' },
}
// reqRollup 的键是短名（GREEN/SOURCE/…），行状态是长名——同一件事两套叫法，这里做一次映射
const SEG_ORDER = [
  ['GREEN', 'COVERED_GREEN'],
  ['SOURCE', 'SOURCE_ATTESTED'],
  ['HUMAN', 'HUMAN_INHERENT'],
  ['BLOCKED', 'BLOCKED_WITH_PROOF'],
  ['UNCOVERED', 'UNCOVERED'],
]

type Rollup = { counts?: Record<string, number>; total?: number }

// facet 覆盖明细弹窗：左 REQ 目录 + 右明细表，顶部状态徽标兼作筛选器。
//
// 两条性能约束（2026-08-24 重做的由来，见复盘 §3.99）：
// ① **明细按需拉**。rows（逐条 facet + criterion 原文）此前搭 `/api/tasks` 的车每 15s 全量轮询下来，
//    占载荷 42%，而只有本弹窗读 → 看板改拉 `?slim=1`，这里开窗才 GET /api/coverage。
// ② **开场动画期间不铺内容**。旧版一开窗就同步渲染全部 REQ×全部 facet（实测 744 个 DOM 节点、
//    141ms 长任务），正好压在 Dialog 的 zoom/fade 上 → 肉眼就是"卡一下"。现在开窗先出骨架，
//    等动画跑完（duration-100，这里给 140ms 余量）再铺，且**一次只铺选中 REQ 那十几行**。
export function CoverageDrawer({
  file,
  coverage,
  highlightReq,
  open,
  onOpenChange,
}: {
  file: string
  // 看板手里的精简覆盖（summary + reqRollup，无 rows）——用来让表头徽标**开窗即有数**，不必等请求
  coverage: Coverage | null
  highlightReq?: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const [data, setData] = useState<Coverage | null>(null)
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false) // 开场动画跑完才铺内容
  const [req, setReq] = useState<string | null>(null) // 选中的 REQ；null = 全部
  const [filter, setFilter] = useState<string | null>(null) // 状态筛选；null = 不筛
  // 判据**默认展开**（来这儿就是为了读全文，逐条点开太费手）；这里记的是被手动折叠的行
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // 请求令牌：连着开两张不同档案时，只认最后一次的响应（先发的慢响应不许覆盖后发的）
  const token = useRef(0)

  useEffect(() => {
    if (!open) return
    const my = ++token.current
    setData(null)
    setErr('')
    setReady(false)
    setReq(highlightReq ?? null)
    setFilter(null)
    setCollapsed(new Set())
    const t = setTimeout(() => token.current === my && setReady(true), 140)
    // 引擎还没重启（前端产物由 build:watch 自动滚动、引擎重启是手动的，中间必然有一段窗口）时，
    // /api/coverage 要么 404、要么是不带 reqTitles 的老响应 —— 两种都退回全量 /api/tasks，用它的
    // entries 现拼 REQ→条目名。慢，但不至于开天窗、左栏也不至于退回光秃秃的编号。
    apiGet<Coverage>(`/api/coverage?file=${encodeURIComponent(file)}`)
      .then((d) =>
        d.reqTitles
          ? d
          : fetchTaskLite(file).then(
              (t) => ({ ...d, reqTitles: titlesOf(t) }),
              () => d,
            ),
      )
      .catch(() =>
        fetchTaskLite(file).then((t) => ({
          ...(t?.coverage ?? { rows: [], summary: null }),
          reqTitles: titlesOf(t),
        })),
      )
      .then((d) => token.current === my && setData(d))
      .catch((e) => token.current === my && setErr((e as Error).message))
    return () => clearTimeout(t)
  }, [open, file, highlightReq])

  const summary = data?.summary ?? coverage?.summary ?? null
  const rollups = useMemo(
    () => (data?.reqRollup ?? coverage?.reqRollup ?? {}) as Record<string, Rollup>,
    [data, coverage],
  )
  const rows = useMemo(() => data?.rows ?? [], [data])
  const titles = useMemo(() => data?.reqTitles ?? {}, [data])

  // REQ 目录：按编号升序（稳定可扫），计数走 reqRollup（显示层派生的权威口径），缺则现算
  const reqs = useMemo(() => {
    const map = new Map<string, CoverageRow[]>()
    for (const r of rows) {
      const k = r.req || '（未归属 REQ）'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(r)
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, list]) => {
        const ru = rollups[id]
        const counts =
          ru?.counts ??
          list.reduce<Record<string, number>>((acc, r) => {
            const short = SEG_ORDER.find(([, long]) => long === r.status)?.[0] ?? r.status
            acc[short] = (acc[short] ?? 0) + 1
            return acc
          }, {})
        const total = ru?.total ?? list.length
        // 筛选态下目录也跟着显示"这个 REQ 命中几条"，命中 0 的置灰——省得逐个点进去扑空
        const hit = filter ? list.filter((r) => r.status === filter).length : list.length
        return { id, list, counts, total, hit }
      })
  }, [rows, rollups, filter])

  // 落地默认选中：从版本级 facet 条点进来时没有 highlightReq，若默认「全部」就又回到了那面平铺的墙
  // （86 项全铺）。改成**默认落在第一个有缺口的 REQ**——打开这个弹窗十有八九就是来找没覆盖的；
  // 全都覆盖满了才落第一个 REQ。「全部」始终在目录第一项，一点就回得去。
  useEffect(() => {
    if (!data || highlightReq || req !== null || reqs.length === 0) return
    const gap = reqs.find((r) => (r.counts.GREEN ?? 0) < r.total)
    setReq((gap ?? reqs[0]).id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // 右侧要铺的行：先按选中 REQ 收窄（这是"一次只渲染十几行"的关键），再按状态筛
  const shown = useMemo(() => {
    const base = req ? (reqs.find((r) => r.id === req)?.list ?? []) : rows
    return filter ? base.filter((r) => r.status === filter) : base
  }, [req, reqs, rows, filter])

  function toggleExpand(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  // 表头的「全部展开 / 全部折叠」：看的行数一多，逐行点也烦
  const allCollapsed = shown.length > 0 && shown.every((r) => collapsed.has(r.facetId))
  function toggleAll() {
    setCollapsed((prev) => {
      const next = new Set(prev)
      for (const r of shown) {
        if (allCollapsed) next.delete(r.facetId)
        else next.add(r.facetId)
      }
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 窄屏几乎占满视口：判据是密集表格，留边距只会把它压得更挤（同 file-viewer 的取舍） */}
      <DialogContent className="max-h-[92svh] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] gap-0 overflow-hidden p-0 sm:max-h-[85svh] sm:max-w-5xl">
        <DialogHeader className="border-b px-3 py-3 pe-10 sm:px-4">
          <DialogTitle>facet 覆盖明细</DialogTitle>
          <p className="truncate font-mono text-xs text-muted-foreground">{file}</p>
          {summary && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant={summary.passed ? 'default' : 'secondary'}>
                {summary.passed ? '已通过' : '未通过'} · 共 {summary.denom}
              </Badge>
              {/* 徽标兼作筛选器：点一下只看这一类，再点取消（最常见的用法是「只看没过的」） */}
              {Object.entries(summary.byStatus).map(([k, v]) => (
                <button
                  key={k}
                  onClick={() => setFilter((f) => (f === k ? null : k))}
                  aria-pressed={filter === k}
                  title={filter === k ? '取消筛选' : `只看${STATUS_META[k]?.label ?? k}`}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] transition-colors hover:bg-accent',
                    STATUS_META[k]?.tone,
                    filter === k && 'border-current bg-accent',
                  )}
                >
                  {STATUS_META[k]?.label ?? k} {v}
                </button>
              ))}
              {filter && (
                <button
                  onClick={() => setFilter(null)}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                >
                  清除筛选
                </button>
              )}
              <button
                onClick={toggleAll}
                disabled={shown.length === 0}
                className="ms-auto flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent disabled:opacity-40"
                title={allCollapsed ? '展开全部判据' : '折叠全部判据'}
              >
                {allCollapsed ? <CaretRightIcon size={11} /> : <CaretDownIcon size={11} />}
                {allCollapsed ? '全部展开' : '全部折叠'}
              </button>
            </div>
          )}
        </DialogHeader>

        {/* 骨架期与内容期高度一致，铺上内容时弹窗不跳高。
            min-w-0 不能省：DialogContent 是 grid，**grid item 的自动最小尺寸是 max-content** ——
            少了它，右栏那 80 多行 nowrap 判据会把这一格顶到 3700px 宽（实测），被弹窗的 overflow-hidden
            裁掉，于是判据看着是"齐边切断"而不是省略号（省略号被顶到屏幕外去了）。 */}
        {/* 窄屏改上下分栏：左边那条 256px 的 REQ 目录横着摆，在 390px 的屏幕上只给判据留下 100 多像素，
            等于两栏都读不了。现在 REQ 目录压到顶部一条限高 8rem 的可滚区，判据占满整宽。 */}
        <div className="flex h-[62svh] min-h-0 min-w-0 flex-col md:flex-row">
          {!ready || !data ? (
            <CoverageSkeleton err={err} />
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">该档案暂无 facet 覆盖数据。</p>
          ) : (
            <>
              {/* 左：REQ 目录（编号 + 需求条目内容——光有编号认不出是哪条需求） */}
              <aside className="max-h-32 w-full shrink-0 space-y-0.5 overflow-y-auto border-b p-2 md:max-h-none md:w-64 md:border-e md:border-b-0">
                <RailItem
                  label="全部"
                  count={filter ? shownCount(rows, filter) : rows.length}
                  active={req === null}
                  onClick={() => setReq(null)}
                />
                {reqs.map((r) => (
                  <RailItem
                    key={r.id}
                    label={r.id}
                    desc={titles[r.id]}
                    count={filter ? r.hit : r.total}
                    dim={filter ? r.hit === 0 : false}
                    active={req === r.id}
                    onClick={() => setReq(r.id)}
                    bar={<MiniBar counts={r.counts} total={r.total} />}
                  />
                ))}
              </aside>

              {/* 右：明细行（一行一条，点开看全文） */}
              <div className="min-w-0 flex-1 overflow-y-auto">
                {shown.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">
                    没有符合筛选的 facet。
                  </p>
                ) : (
                  shown.map((r) => {
                    const m = STATUS_META[r.status]
                    const isOpen = !collapsed.has(r.facetId)
                    // 选中某个 REQ 时把 `REQ-0239-` 前缀省掉，只留 F1/F12——省出来的宽度给判据
                    const shortId = req && r.facetId.startsWith(`${req}-`)
                      ? r.facetId.slice(req.length + 1)
                      : r.facetId
                    const warn = [
                      r.unlisted && '未登记',
                      r.hasRed && !r.redOk && 'RED待补',
                      r.status === 'COVERED_GREEN' && !r.greenOk && '证据不全',
                    ].filter(Boolean) as string[]
                    return (
                      <button
                        key={r.facetId}
                        onClick={() => toggleExpand(r.facetId)}
                        className="flex w-full items-start gap-2 border-b px-3 py-1.5 text-start hover:bg-accent/40 last:border-0"
                        title={isOpen ? '收起' : '展开全文'}
                      >
                        {/* 折叠/展开箭头：默认展开，点行或点箭头都能收（箭头只是可见的示意，不单独绑事件） */}
                        <span className="mt-0.5 w-3 shrink-0 text-muted-foreground" aria-hidden>
                          {isOpen ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
                        </span>
                        <span className={cn('w-3 shrink-0 text-center', m?.tone)}>{m?.mark ?? '·'}</span>
                        <span className="w-14 shrink-0 truncate font-mono text-[11px] font-medium md:w-24">
                          {shortId}
                        </span>
                        <span className="w-6 shrink-0 font-mono text-[11px] text-muted-foreground">
                          {r.level}
                        </span>
                        {/* kind 在窄屏让位给判据正文（那才是要读的） */}
                        <span className="hidden w-10 shrink-0 truncate text-[11px] text-muted-foreground md:block">
                          {r.kind}
                        </span>
                        <span
                          className={cn(
                            'min-w-0 flex-1 text-xs',
                            isOpen ? 'whitespace-pre-wrap' : 'truncate',
                          )}
                        >
                          {r.criterion}
                        </span>
                        {warn.length > 0 && (
                          <span className="shrink-0 text-[10px] text-amber-500">{warn.join(' · ')}</span>
                        )}
                      </button>
                    )
                  })
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// 兜底取数：全量 /api/tasks 里挑这份档案（含 entries=需求条目登记表）
type TaskLite = { file: string; entries?: TaskEntry[]; coverage: Coverage | null }
function fetchTaskLite(file: string) {
  return apiGet<TaskLite[]>('/api/tasks').then((ts) => ts.find((x) => x.file === file) ?? null)
}
function titlesOf(t: TaskLite | null) {
  const m: Record<string, string> = {}
  for (const e of t?.entries ?? []) if (e.no && e.name) m[e.no] = e.name
  return m
}

function shownCount(rows: CoverageRow[], filter: string) {
  return rows.filter((r) => r.status === filter).length
}

function RailItem({
  label,
  desc,
  count,
  active,
  dim,
  bar,
  onClick,
}: {
  label: string
  desc?: string
  count: number
  active: boolean
  dim?: boolean
  bar?: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={desc ? `${label} · ${desc}` : label}
      className={cn(
        'grid w-full gap-1 rounded-md px-2 py-1.5 text-start hover:bg-accent',
        active && 'bg-accent',
        dim && 'opacity-40',
      )}
    >
      <span className="flex items-baseline gap-1.5">
        <span className={cn('min-w-0 flex-1 truncate font-mono text-[11px]', active && 'font-semibold')}>
          {label}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count}</span>
      </span>
      {/* 需求条目内容：选中的那条放开到 3 行，其余压 2 行——目录别被长条目撑成一堵墙 */}
      {desc && (
        <span
          className={cn(
            'text-[11px] leading-snug text-muted-foreground',
            active ? 'line-clamp-3 text-foreground/80' : 'line-clamp-2',
          )}
        >
          {desc}
        </span>
      )}
      {bar}
    </button>
  )
}

// 覆盖构成小条（与看板健康条同一套配色/语义，只是更窄）
function MiniBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  if (!total) return null
  return (
    <span className="flex h-1 w-full overflow-hidden rounded-full bg-muted">
      {SEG_ORDER.map(([short, long]) => {
        const n = counts[short] ?? counts[long] ?? 0
        if (!n) return null
        return (
          <span
            key={short}
            className={STATUS_META[long]?.seg}
            style={{ width: `${(n / total) * 100}%` }}
          />
        )
      })}
    </span>
  )
}

function CoverageSkeleton({ err }: { err: string }) {
  if (err) return <p className="p-4 text-sm text-destructive">覆盖明细加载失败：{err}</p>
  return (
    <>
      <div className="w-64 shrink-0 space-y-2 border-e p-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
      <div className="min-w-0 flex-1 space-y-2 p-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    </>
  )
}
