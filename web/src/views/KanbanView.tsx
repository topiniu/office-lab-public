import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'
import {
  CaretDownIcon,
  FileTextIcon,
  DotsThreeIcon,
  SealCheckIcon,
  CopyIcon,
} from '@phosphor-icons/react'
import { toast } from 'sonner'

import { usePoll } from '@/hooks/use-poll'
import { useIsMobile } from '@/hooks/use-mobile'
import { useSseEvent } from '@/components/sse-provider'
import { useEmployees } from '@/hooks/use-employees'
import { useFileViewer } from '@/components/file-viewer'
import { EmployeeAvatar } from '@/components/employee-avatar'
import { apiPost } from '@/lib/api'
import { statusTone, entryBall } from '@/lib/status'
import type { Coverage, TaskEntry, TaskFile } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DispatchDialog } from '@/components/dispatch-dialog'
import { CoverageDrawer } from '@/components/coverage-drawer'
import { cn } from '@/lib/utils'

const CLOSED = new Set(['人工Pass', 'QA通过', '已上线', '已归档'])
const PRECHECK_SELECTABLE = new Set(['待预检', '待复验'])
// 批量人工验收（老板 2026-10-10「一个一个点验收太慢」）：只开放给 QA 已收束、到了老板验收门的「待人工验收」。
// 「待人工」（QA 没收束）刻意不进批量——那种要逐条看，单条仍可走 ⋯ → 人工通过。
const ACCEPT_SELECTABLE = new Set(['待人工验收'])
type SelKind = 'precheck' | 'accept'
function selKindOf(status: string): SelKind | null {
  return PRECHECK_SELECTABLE.has(status) ? 'precheck' : ACCEPT_SELECTABLE.has(status) ? 'accept' : null
}
// 健康条按生命周期顺序展示所有出现过的状态
const STATUS_ORDER = [
  '待梳理', '需求确认', '待开发', '开发中', '已定稿', '已开发', '待审', '待QA', 'QA中',
  '待测', '待预检', '待复验', '待人工', '阻塞', '打回', '人工Pass', 'QA通过', '已上线', '已归档',
]

// 员工可能给单元格加 ** 强调/全角空格——比对前统一去噪（对齐旧 UI normState）
function clean(s: unknown): string {
  return String(s ?? '').replace(/\*\*/g, '').trim()
}
// 人工通过：非终结、且非「待预检/待复验」（那两态走批量预检，REQ-0241 教训）
function canManualPass(status: string): boolean {
  return !CLOSED.has(status) && !PRECHECK_SELECTABLE.has(status)
}

const GATE_LABEL: Record<string, string> = {
  requirement_trace_complete: '需求溯源',   // 横向：源材料每个可枚举单元都有处置
  feature_tree_complete: '功能树',          // 纵向：叶子四要素齐（两者互为分母，见复盘 §3.122/§3.123）
  req_analysis_complete: '需求分析',        // 拷问问出去 / 工作流走得通 / 机器点名的可疑点逐条回应（见复盘 §3.124）
  tripartite_review: '三方会审',
  pm_confirmed: 'PM确认',
  dev_confirmed: '开发确认',
  dev_selfcheck: '开发自检',
  dev_adversarial_swept: '对抗自查',
  human_precheck_passed: '最终验收',
  qa_coverage_complete: 'QA覆盖',
  qa_red_calibrated: 'RED校准',
  qa_passed: 'QA通过',
  released_test: '测试发布',
  released_prod: '线上发布',
  post_release_done: '上线收尾',
}

// 条目状态 → 状态点色
function dotColor(status: string): string {
  if (status === '阻塞' || status === '打回') return 'bg-destructive'
  if (CLOSED.has(status)) return 'bg-emerald-500'
  if (status.includes('中')) return 'bg-primary'
  return 'bg-amber-500'
}

// name 里的 ｜P1 → 提取优先级 + 去掉后缀
function splitPriority(name: string): { priority?: string; clean: string } {
  const m = name.match(/[｜|]\s*(P[0-3])\s*$/)
  if (m) return { priority: m[1], clean: name.slice(0, m.index).trim() }
  const m2 = name.match(/\b(P[0-3])\b/)
  return { priority: m2?.[1], clean: name }
}

// 覆盖分段条
const SEG = [
  { key: 'GREEN', alt: 'COVERED_GREEN', cls: 'bg-emerald-500' },
  { key: 'SOURCE', alt: 'SOURCE_ATTESTED', cls: 'bg-teal-400' },
  { key: 'HUMAN', alt: 'HUMAN_INHERENT', cls: 'bg-zinc-400/60' },
  { key: 'BLOCKED', alt: 'BLOCKED_WITH_PROOF', cls: 'bg-amber-500' },
  { key: 'UNCOVERED', alt: 'UNCOVERED', cls: 'bg-destructive' },
]
function FacetBar({
  counts,
  total,
  green,
  className,
}: {
  counts: Record<string, number>
  total: number
  green: number
  className?: string
}) {
  if (!total) return <span className="text-[11px] text-muted-foreground md:text-xs">—</span>
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {/* 44×5（对齐旧 UI `.cov-cell-bar`）——窄屏那 12px 宽差值省下来给判据文字 */}
      <span className="flex h-[5px] w-11 shrink-0 overflow-hidden rounded-full bg-muted md:h-1.5 md:w-14">
        {SEG.map((s) => {
          const n = counts[s.key] ?? counts[s.alt] ?? 0
          if (!n) return null
          return <span key={s.key} className={s.cls} style={{ width: `${(n / total) * 100}%` }} />
        })}
      </span>
      {/* 定宽右对齐：两位数(如 3/17)不再把进度条挤偏、各行对齐 */}
      <span className="shrink-0 text-end font-mono text-[10.5px] tabular-nums text-muted-foreground md:w-9 md:text-[11px]">
        {green}/{total}
      </span>
    </span>
  )
}

// 紧凑签（对齐旧 UI `.entry-status` / `.entry-pri`：10.5px + line-height 1.7 + 6~8px 横向内边距）。
// shadcn Badge 默认那套（12px + px-2 + py-0.5）在窄屏是「一行只放得下两个签」的尺寸，
// 而这块看板一行要放状态/优先级/覆盖/终结四样，签必须先瘦下来。md 起回到默认尺寸。
const CHIP = 'px-1.5 py-0 text-[10.5px] leading-[1.55] md:px-2 md:py-0.5 md:text-xs md:leading-normal'

const selKey = (file: string, no: string) => `${file}|${no}`

const COLLAPSE_KEY = 'olab.collapsedTasks'
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'))
  } catch {
    return new Set()
  }
}

// 弹窗动作出口（引用恒定）：看板里任何一行点「facet 覆盖 / 派工」都只调这两个函数，
// **弹窗的开关 state 不再住在看板组件里**——否则开/关一次弹窗就要把整块看板（上百个 Radix
// 下拉/上千个节点）重渲染两遍，实测单次 open 86ms / close 162ms 的长任务主要就来自这里。
// 现在 state 住在外层 KanbanView，看板是 memo 组件、props 恒空 → 开关弹窗完全不碰看板。见复盘。
// 条目详情（窄屏点条目名弹的那张底部卡）所需的一切：数据 + 两个引用恒定的动作
type EntryPeek = {
  entry: TaskEntry
  file: string
  coverage: Coverage | null
  owner?: string
  rollup?: { counts: Record<string, number>; total: number }
  onManualPass: (file: string, no: string) => void
}
type KanbanActions = {
  openCoverage: (file: string, coverage: Coverage | null, req?: string) => void
  openDispatch: (d: { employee?: string; file?: string; instruction?: string }) => void
  openEntry: (e: EntryPeek) => void
}
const ActionsCtx = createContext<KanbanActions>({
  openCoverage: () => {},
  openDispatch: () => {},
  openEntry: () => {},
})
function useKanbanActions() {
  return useContext(ActionsCtx)
}

export default function KanbanView() {
  const [cov, setCov] = useState<{ file: string; coverage: Coverage | null; req?: string } | null>(null)
  const [disp, setDisp] = useState<{ employee?: string; file?: string; instruction?: string } | null>(null)
  const [peek, setPeek] = useState<EntryPeek | null>(null)
  // 空依赖 useMemo：actions 引用永不变 → 消费它的行/卡片不会因为弹窗开关而重渲染
  const actions = useMemo<KanbanActions>(
    () => ({
      openCoverage: (file, coverage, req) => setCov({ file, coverage, req }),
      openDispatch: (d) => setDisp(d),
      openEntry: (e) => setPeek(e),
    }),
    [],
  )

  return (
    <ActionsCtx.Provider value={actions}>
      <KanbanBoard />
      <EntrySheet
        peek={peek}
        onOpenChange={(o) => !o && setPeek(null)}
        onCoverage={(file, coverage, req) => setCov({ file, coverage, req })}
        onDispatch={(d) => setDisp(d)}
      />
      <DispatchDialog
        open={!!disp}
        onOpenChange={(o) => !o && setDisp(null)}
        defaultEmployee={disp?.employee}
        defaultTaskFile={disp?.file}
        defaultInstruction={disp?.instruction}
      />
      <CoverageDrawer
        file={cov?.file ?? ''}
        coverage={cov?.coverage ?? null}
        highlightReq={cov?.req}
        open={!!cov}
        onOpenChange={(o) => !o && setCov(null)}
      />
    </ActionsCtx.Provider>
  )
}

const KanbanBoard = memo(function KanbanBoard() {
  // slim=1：不要 coverage.rows（逐条 facet 明细）——看板只用 summary + reqRollup，rows 却占这份
  // 15s 一轮的载荷 42%。明细由 CoverageDrawer 开窗时按需拉 /api/coverage。见复盘 §3.99。
  const { data, loading, refresh } = usePoll<TaskFile[]>('/api/tasks?slim=1')
  const { employees } = useEmployees()
  const { openFile } = useFileViewer()
  const { openCoverage, openDispatch } = useKanbanActions()
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [sel, setSel] = useState<Map<string, { file: string; no: string; kind: SelKind }>>(new Map())
  useSseEvent('tasks-changed', () => refresh())

  function toggleCollapse(file: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      next.has(file) ? next.delete(file) : next.add(file)
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]))
      return next
    })
  }

  // toggleSel / manualPass 走 useCallback 保持引用恒定 —— EntryRow 是 memo 组件，
  // 回调每渲染新建一个的话 memo 直接失效（props 浅比较必不等）。
  const toggleSel = useCallback((file: string, no: string, on: boolean, kind: SelKind) => {
    setSel((prev) => {
      const next = new Map(prev)
      if (on) {
        // 批量限定同一档案（跨版本批量无意义、交接卡各自独立）+ 同一种动作（预检和验收后续动作不同，混选没法给按钮）
        for (const [k, v] of [...next]) if (v.file !== file || v.kind !== kind) next.delete(k)
        next.set(selKey(file, no), { file, no, kind })
      } else next.delete(selKey(file, no))
      return next
    })
  }, [])

  const manualPass = useCallback(
    async (file: string, no: string) => {
      try {
        await apiPost('/api/task/manual-pass', { file, kind: 'entry', no })
        toast.success(`已人工通过 ${no}`)
        refresh()
      } catch (e) {
        toast.error('操作失败', { description: (e as Error).message })
      }
    },
    [refresh],
  )

  function selNames(file: string): (no: string) => string {
    const t = (data ?? []).find((x) => x.file === file)
    return (no) => {
      const e = (t?.entries || []).find((en) => clean(en.no) === clean(no))
      return e ? clean(e.name) : ''
    }
  }

  const selFirst = sel.size ? [...sel.values()][0] : null
  const selKind: SelKind | null = selFirst?.kind ?? null
  const sameKindNos = selFirst
    ? ((data ?? []).find((x) => x.file === selFirst.file)?.entries || [])
        .filter((e) => selKindOf(clean(e.status)) === selFirst.kind)
        .map((e) => clean(e.no))
    : []

  // 全选：本档案里与当前所选同一种的条目全勾上
  function selectAllSame() {
    if (!selFirst) return
    const next = new Map<string, { file: string; no: string; kind: SelKind }>()
    for (const no of sameKindNos) next.set(selKey(selFirst.file, no), { file: selFirst.file, no, kind: selFirst.kind })
    setSel(next)
  }

  // 批量人工通过：逐条串行调单条端点（同一份档案并发写会互相覆盖；串行也不用等引擎重启加新端点）。
  // facet 门禁是档案级的，撞上一次后面必然同样被拦，直接停、整句报出来。
  const [accepting, setAccepting] = useState(false)
  async function batchAccept() {
    const items = [...sel.values()]
    if (!items.length || accepting) return
    setAccepting(true)
    const ok: string[] = []
    const failed: string[] = []
    let gate = ''
    for (const it of items) {
      try {
        await apiPost('/api/task/manual-pass', { file: it.file, kind: 'entry', no: it.no })
        ok.push(it.no)
      } catch (e) {
        const body = (e as { body?: { error?: string; message?: string } }).body
        if (body?.error === 'facet-gate') {
          gate = body.message || 'facet 门禁未过'
          break
        }
        failed.push(it.no)
      }
    }
    setAccepting(false)
    if (ok.length) toast.success(`已人工通过 ${ok.length} 条`)
    if (gate) toast.error('被 facet 门禁拦下，没通过的条目未改动', { description: gate })
    else if (failed.length) toast.error(`${failed.length} 条没通过`, { description: failed.map((n) => `#${n}`).join('、') })
    // 成功的从选择里拿掉，失败的留着方便重试
    setSel((prev) => {
      const next = new Map(prev)
      for (const no of ok) next.delete(selKey(items[0].file, no))
      return next
    })
    refresh()
  }

  // 预检通过：置待测 + stage，然后派 GG Bond 出一张交接卡交迷糊
  async function batchPass() {
    const items = [...sel.values()]
    if (!items.length) return
    const file = items[0].file
    const nos = items.map((i) => i.no)
    const nameOf = selNames(file)
    const list = nos.map((no) => `#${no}「${nameOf(no)}」`).join('、')
    try {
      await apiPost('/api/task/precheck', { file, nos, status: '待测', stage: '预检通过 → 待迷糊：QA' })
    } catch (e) {
      toast.error('批量置待测失败', { description: (e as Error).message })
      return
    }
    openDispatch({
      employee: 'ggbond',
      file,
      instruction: `以下 ${nos.length} 条条目人工预检通过、已置『待测』：${list}。\n请【一次性出一张交接卡】把这些条目连同登记表里其它已在『待测』的条目一并交迷糊（别一条条发）；交接卡逐条写清影响面/造数提示。`,
    })
    setSel(new Map())
    refresh()
  }

  // 有发现：不改状态，派菲菲分诊
  function batchFinding() {
    const items = [...sel.values()]
    if (!items.length) return
    const file = items[0].file
    const nameOf = selNames(file)
    const list = items.map((i) => `#${i.no}「${nameOf(i.no)}」`).join('、')
    openDispatch({
      employee: 'feifei',
      file,
      instruction: `以下条目人工${items[0].kind === 'accept' ? '验收' : '预检'}有发现（请把下面替换成各条目的具体现象/页面/截图位置）：${list}\n【逐条写你发现的问题】\n\n请分诊：判缺陷 vs 变更、按需更新 facet、合并需求卡增量回 GG Bond 处理后交迷糊（有界面改动先初筛，再补跑受影响的 QA），全绿后回到我最终验收。`,
    })
    setSel(new Map())
  }

  const archives = useMemo(
    () =>
      (data ?? []).slice().sort((a, b) => {
        const au = String(a.frontmatter.updated ?? '')
        const bu = String(b.frontmatter.updated ?? '')
        return bu.localeCompare(au)
      }),
    [data],
  )

  if (loading && !data) return null
  if (archives.length === 0)
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div>
          <h1 className="text-base font-semibold">暂无任务档案</h1>
          <p className="mt-2 text-sm text-muted-foreground">在设置中配置执行基座，然后给员工派一项任务。</p>
          <Button className="mt-4" onClick={() => openDispatch({ employee: 'feifei' })}>派工</Button>
        </div>
      </div>
    )

  return (
    // 窄屏收内边距（p-4 两侧就吃掉 32px，390 的屏幕上标题被挤到只剩四个字）+ 底部留出悬浮键的地盘
    <div className="flex flex-col gap-2 p-2 pb-24 md:gap-3 md:p-4 md:pb-4">
      {archives.map((t) => {
        const fm = t.frontmatter
        const open = !collapsed.has(t.file)
        const counts: Record<string, number> = {}
        for (const e of t.entries) {
          const st = clean(e.status)
          counts[st] = (counts[st] ?? 0) + 1
        }
        const owner = fm.owner as string | undefined
        const s = t.coverage?.summary
        const green = s ? (s.byStatus.COVERED_GREEN ?? 0) + (s.byStatus.SOURCE_ATTESTED ?? 0) : 0
        const rollup = (t.coverage?.reqRollup ?? {}) as Record<string, any>
        const gates = fm.gates as Record<string, boolean> | undefined
        const anySelectable = t.entries.some((e) => selKindOf(clean(e.status)) !== null)

        return (
          <Collapsible
            key={t.file}
            open={open}
            onOpenChange={() => toggleCollapse(t.file)}
            className="cv-auto rounded-lg border bg-card"
          >
            {/* 档案头。窄屏**折行**：标题独占第一行（basis-full），徽标/头像/档案键落到第二行——
                原来它们跟标题挤同一行，390px 上把「大货备货节点时点治理…」截成了「大货备货…」。
                桌面(≥768)维持单行不变（basis-auto）。 */}
            <div className="flex flex-col gap-1 p-2 md:gap-2 md:p-3">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 md:gap-x-2 md:gap-y-1.5">
                <CollapsibleTrigger className="flex min-w-0 flex-1 basis-full items-center gap-1.5 text-start md:basis-auto md:gap-2">
                  <CaretDownIcon className={cn('size-3.5 shrink-0 transition-transform md:size-4', !open && '-rotate-90')} />
                  {/* 15px/600（对齐旧 UI `.task-title` 的 16px 收一档）：标题是这张卡的锚，但不该占两行 */}
                  <span className="truncate text-[15px] leading-tight font-semibold md:text-base">
                    {String(fm.task ?? t.file)}
                  </span>
                </CollapsibleTrigger>
                {!!fm.frozen && <Badge variant="secondary" className={CHIP}>封板</Badge>}
                {fm.status && <Badge variant="outline" className={CHIP}>{String(fm.status)}</Badge>}
                {/* 员工透亮罗列：点头像 = 开派工弹窗（预置该员工 + 本任务档案）。
                    窄屏头像放大到 28px 并拉开间距（24px 半掩半叠的脸，手指按不准也看不清是谁）。 */}
                <div className="flex items-center">
                  {Object.keys(employees).map((k) => (
                    <button
                      key={k}
                      onClick={() => openDispatch({ employee: k, file: t.file })}
                      title={`派工「${String(fm.task ?? '')}」给 ${employees[k]?.displayName ?? k}`}
                      className="-ms-1.5 rounded-full transition first:ms-0 hover:z-10 hover:-translate-y-0.5"
                    >
                      <EmployeeAvatar
                        employee={employees[k]}
                        fallback={k}
                        className={cn(
                          'size-5 ring-2 ring-card transition-transform md:size-6',
                          k === owner && 'ring-primary',
                        )}
                      />
                    </button>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ms-auto size-7 md:ms-0"
                  onClick={() => openFile(t.file)}
                  aria-label="打开档案"
                  title="打开任务档案"
                >
                  <FileTextIcon className="size-4" />
                </Button>
              </div>

              {/* 健康条（窄屏不再缩进 24px 对齐标题——那点缩进换不来可读性，宽度更值钱）。
                  窄屏 11px + 8px 列距，并把两样「已经有别处表达」的东西摘掉，让这行收进一行：
                  ① 负责人名字（头像里那个 ring-primary 就是他）；② 三方会审只留印章图标（gates 点里也有它）。 */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground md:gap-x-3 md:gap-y-1.5 md:ps-6 md:text-xs">
                <span className="font-medium text-foreground">{t.entries.length} 条</span>
                {STATUS_ORDER.filter((k) => counts[k]).map((k) => (
                  <span key={k} className="inline-flex items-center gap-1">
                    <span className={cn('size-1.5 rounded-full', dotColor(k))} />
                    {counts[k]} {k}
                  </span>
                ))}
                {s && (
                  <button
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    onClick={() => openCoverage(t.file, t.coverage ?? null)}
                    title="facet 覆盖明细"
                  >
                    facet
                    <FacetBar counts={s.byStatus} total={s.denom} green={green} />
                  </button>
                )}
                {owner && (
                  <span className="hidden items-center gap-1 md:inline-flex">
                    {employees[owner]?.emoji} {employees[owner]?.displayName ?? owner}
                  </span>
                )}
                {gates?.tripartite_review && (
                  <span
                    className="inline-flex items-center gap-1 text-emerald-500 md:rounded-full md:border md:px-2 md:py-0.5"
                    title="三方会审已过"
                  >
                    <SealCheckIcon weight="fill" className="size-3" />
                    <span className="hidden md:inline">三方会审</span>
                  </span>
                )}
                {/* 门禁里程碑点：用原生 title 而非 Radix Tooltip —— 一屏门禁点常有近 200 个，
                    每个 Tooltip 都是一套 provider/context/id 机器，白扛掉整块看板的渲染预算；
                    悬浮提示的信息量（门禁名 + 过/未过）原生 title 一模一样能给。 */}
                {gates && (
                  <span className="inline-flex items-center gap-0.5">
                    {Object.entries(gates).map(([k, v]) => (
                      <span
                        key={k}
                        title={`${GATE_LABEL[k] ?? k}：${v ? '✓ 已过' : '未过'}`}
                        className={cn('size-1.5 rounded-full', v ? 'bg-emerald-500' : 'bg-muted-foreground/30')}
                      />
                    ))}
                  </span>
                )}
              </div>
            </div>

            {/* 需求条目台账 */}
            <CollapsibleContent>
              <div className="border-t">
                {t.entries.map((e) => (
                  <EntryRow
                    key={`${t.file}-${e.no}`}
                    file={t.file}
                    coverage={t.coverage ?? null}
                    owner={owner}
                    // 这份档案里一条可勾选的都没有 → 整列勾选框连占位都不留（省下 22px 给需求名）。
                    // 有的话才留占位，保住同一张卡内各行左边界对齐。
                    showSelect={anySelectable}
                    entry={e}
                    rollup={rollup[clean(e.no).toUpperCase()] || rollup[clean(e.no)]}
                    selected={sel.has(selKey(t.file, clean(e.no)))}
                    onSel={toggleSel}
                    onManualPass={manualPass}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )
      })}

      {/* 批量操作条。窄屏是**贴边的一条卡**（不再 w-fit 居中 —— 三个按钮 + 一句话在 390px 上直接顶出屏幕，
          「取消」和半个「交菲菲」都在视口外）：第一行说选了几条 + 取消，第二行两个动作各占一半、
          点按面积够手指用；底部避开系统手势条。桌面维持原来那颗胶囊。 */}
      {sel.size > 0 && (
        <div className="fixed inset-x-2.5 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-20 flex flex-wrap items-center gap-2 rounded-2xl border bg-background/95 p-2.5 shadow-lg backdrop-blur md:inset-x-0 md:bottom-4 md:mx-auto md:w-fit md:flex-nowrap md:rounded-full md:px-4 md:py-2">
          <span className="text-sm">已选 {sel.size} 条{selKind === 'accept' ? '待验收' : '待预检'}</span>
          {sel.size < sameKindNos.length && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={selectAllSame}>
              全选本档 {sameKindNos.length} 条
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ms-auto md:order-last" onClick={() => setSel(new Map())}>
            取消
          </Button>
          {/* 强制断行：让「已选 N 条 / 取消」独占第一行，两个动作在第二行各占一半（不加这条，
              「预检通过」会挤进第一行的余量里，两个动作一上一下参差） */}
          <span aria-hidden className="basis-full md:hidden" />
          {selKind === 'accept' ? (
            <Button size="sm" className="h-9 grow basis-[45%] md:h-8 md:basis-auto" disabled={accepting} onClick={batchAccept}>
              {accepting ? '处理中…' : `人工通过 ${sel.size} 条`}
            </Button>
          ) : (
            <Button size="sm" className="h-9 grow basis-[45%] md:h-8 md:basis-auto" onClick={batchPass}>
              预检通过 · 交 QA
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-9 grow basis-[45%] md:h-8 md:basis-auto"
            onClick={batchFinding}
          >
            有发现 · 交菲菲
          </Button>
        </div>
      )}
    </div>
  )
})

const EntryRow = memo(function EntryRow({
  file,
  coverage,
  owner,
  entry,
  rollup,
  selected,
  showSelect,
  onSel,
  onManualPass,
}: {
  file: string
  coverage: Coverage | null
  owner?: string
  entry: TaskEntry
  rollup?: { counts: Record<string, number>; total: number }
  selected: boolean
  showSelect: boolean
  onSel: (file: string, no: string, on: boolean, kind: SelKind) => void
  onManualPass: (file: string, no: string) => void
}) {
  // 动作出口从 context 取（引用恒定），行只吃「数据 + 恒定回调」→ memo 才真正生效
  const { openCoverage, openDispatch, openEntry } = useKanbanActions()
  const { openFile } = useFileViewer()
  const status = clean(entry.status)
  const no = clean(entry.no)
  const isBug = /^BUG/i.test(no) // 编号区分：BUG=红、REQ/其它=信息蓝（对齐旧 UI entry-id.bug/.req）
  const { priority, clean: cleanName } = splitPriority(clean(entry.name))
  const kind = selKindOf(status)
  const selectable = kind !== null
  const toggle = () => {
    if (kind) onSel(file, no, !selected, kind)
  }
  const peek = () => openEntry({ entry, file, coverage, owner, rollup, onManualPass })
  const onCoverage = () =>
    openCoverage(file, coverage, /^REQ-\d+/i.test(no) ? no.toUpperCase() : undefined)

  return (
    // 窄屏两行堆叠（行1：编号+名称；行2：优先级/状态/facet/终结），md(768) 起恢复单行。
    // 断点跟 use-mobile 的 768 对齐：640~767 那段本来就吃「移动外壳」（悬浮键 + 全屏聊天页），
    // 排版却按桌面单行挤，是杂交态。
    // 密度对齐旧 UI（Linear）`.entry-line`：8px/10px 内边距 + 5px 行距 —— 两行块约 44px，
    // 既够手指点，又不像原来那样一条需求占掉 66px（一屏只剩四条）。
    // relative 是给「⋯」用的：窄屏它绝对定位到行首行的右端（见 RowMenu），
    // 否则它挂在第二行末尾、和左边那簇签之间留出一大片空地——正是「布局空泛」的来源。
    // 可勾选的行：**点整行即勾选**（老板 2026-10-10）。行内自带动作的控件（复制编号 / facet / ⋯ / 勾选框本身）
    // 都是 button，各管各的，这里遇到 button 就让开；需求名在可勾选行上也改成勾选（它占了行宽的大半），
    // 详情改从 hover 卡 / ⋯ →「查看详情」进。
    <div
      onClick={
        selectable
          ? (ev) => {
              if (!(ev.target as HTMLElement).closest('button,a,input,[role="menuitem"]')) toggle()
            }
          : undefined
      }
      className={cn(
        'relative flex flex-col gap-1 border-b px-2 py-1.5 last:border-0 hover:bg-accent/40 md:flex-row md:items-center md:gap-2 md:px-3 md:py-2',
        selectable && 'cursor-pointer select-none',
        selected && 'bg-primary/5',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 leading-tight pe-8 md:flex-1 md:gap-2 md:leading-normal md:pe-0">
        {selectable ? (
          // 视觉仍是 16px 方框（跟桌面一致），外面套 24px 的点按区——窄屏靠行高够，不靠把框画大
          <span className="-my-1 grid size-6 shrink-0 place-items-center md:m-0 md:size-4">
            <Checkbox
              checked={selected}
              onCheckedChange={(c) => kind && onSel(file, no, !!c, kind)}
              aria-label="选择"
              className="size-4"
            />
          </span>
        ) : showSelect ? (
          <span className="w-4 shrink-0" />
        ) : null}
        <span className={cn('size-2 shrink-0 rounded-full', dotColor(status))} />
        <button
          onClick={(e) => {
            e.stopPropagation()
            navigator.clipboard
              .writeText(no)
              .then(() => toast.success(`已复制 ${no}`))
              .catch(() => toast.error('复制失败'))
          }}
          className={cn(
            'group/no flex shrink-0 items-center gap-1 text-start font-mono text-[11.5px] font-bold md:text-xs',
            isBug ? 'text-destructive' : 'text-sky-500',
          )}
          title="点击复制编号"
        >
          <span className="whitespace-nowrap">#{no}</span>
          <CopyIcon className="size-3 shrink-0 opacity-0 transition-opacity group-hover/no:opacity-60" />
        </button>
        <EntryNameHover
          entry={entry}
          no={no}
          name={cleanName}
          priority={priority}
          status={status}
          onPeek={selectable ? toggle : peek}
        />
      </div>
      {/* 第二行＝状态簇，**左侧紧凑成一串**（旧 UI 窄档同样口径：`gap: 4px 10px` 的换行 flex 簇）。
          缩进 22px 让它对齐上一行的编号，读起来是「同一条的续行」而不是新的一行。 */}
      {/* text/leading 必须写在**这一层**：不写的话这个 div 继承 body 的 16px/24px，
          里面 20px 高的状态签会被一个 24px 的行盒撑成 25px，凭空多出 5px×每一行。 */}
      <div className="flex items-center gap-x-2 gap-y-1 ps-[22px] text-[10.5px] leading-none md:gap-2 md:ps-0 md:text-xs md:leading-normal">
        {/* 没有优先级时窄屏**整格不留**（旧 UI 的 `.entry-pri.none { display:none }`）——
            桌面要留 28px 占位保住列对齐，窄屏没有列可对齐，留着就是一块空地。 */}
        <span className={cn('shrink-0 text-center md:block md:w-7', !priority && 'hidden')}>
          {priority && <Badge variant="outline" className="px-1 py-0 text-[10px] leading-[1.7]">{priority}</Badge>}
        </span>
        {/* 窄屏按内容宽（原来锁死 5.5rem＝88px，「开发中」三个字撑不满、右边空一截） */}
        <span className="shrink-0 md:w-[5.5rem]">
          <Badge
            variant="outline"
            title={status}
            className={cn('w-full justify-center truncate', CHIP, statusTone(status))}
          >
            {status}
          </Badge>
        </span>
        <button
          className="flex shrink-0 justify-end md:w-24"
          onClick={onCoverage}
          title="facet 覆盖"
          aria-label="facet 覆盖"
        >
          {rollup ? (
            <FacetBar counts={rollup.counts} total={rollup.total} green={rollup.counts?.GREEN ?? 0} />
          ) : (
            <span className="text-[11px] text-muted-foreground md:text-xs">—</span>
          )}
        </button>
        {/* 「球在谁手里」——旧 UI 有这一列、新 UI 丢了。它是这行最该有的一格：
            终结了就说已终结，在飞就说下一棒是谁（头像+名字 / 待老板）。窄屏顺势把右边那片空地填掉。 */}
        <EntryBallCell status={status} />
        <RowMenu
          canPass={canManualPass(status)}
          onPeek={peek}
          onOpenFile={() => openFile(file)}
          onDispatch={() => openDispatch({ employee: owner, file })}
          onCoverage={onCoverage}
          onManualPass={() => onManualPass(file, no)}
        />
      </div>
    </div>
  )
})

// 「球在谁手里」格：已终结 / 待老板 / 下一棒员工（头像 + 名字）。
// 窄屏用 ms-auto 贴到第二行右端——它是这行的「去向」，贴右读起来像表格的最后一列，
// 同时把原来那片空地占掉；桌面维持 3rem 定宽列以保住跨行对齐。
function EntryBallCell({ status }: { status: string }) {
  const { employees } = useEmployees()
  const ball = entryBall(status)
  if (ball.kind === 'done')
    return <span className="ms-auto shrink-0 text-[10.5px] text-emerald-500 md:ms-0 md:w-12 md:text-end md:text-xs">已终结</span>
  if (ball.kind === 'boss')
    return <span className="ms-auto shrink-0 text-[10.5px] text-amber-500 md:ms-0 md:w-12 md:text-end md:text-xs">待老板</span>
  if (ball.kind === 'employee') {
    const e = employees[ball.employee]
    return (
      <span
        className="ms-auto flex min-w-0 shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground md:ms-0 md:w-12 md:justify-end md:text-xs"
        title={`下一棒：${e?.displayName ?? ball.employee}`}
      >
        <EmployeeAvatar employee={e} fallback={ball.employee} className="size-3.5 shrink-0 md:size-4" />
        <span className="truncate md:hidden">{e?.displayName ?? ball.employee}</span>
      </span>
    )
  }
  return <span className="ms-auto shrink-0 text-[10.5px] text-muted-foreground md:ms-0 md:w-12 md:text-end">—</span>
}

// 需求名 hover → 完整条目卡。行里的名字被 truncate 截断，登记表的「当前阶段/来源/进入日期」
// 在看板上更是一个字都没露出过——想看完整这条需求只能去开档案。这里 hover 就给全。
// **首次 hover 才挂 Radix**（同下面 RowMenu 的道理：一屏上百行，每行常驻一套 HoverCard
// 就是把 99% 永远不会被 hover 的浮层成本摊在每次渲染上）；挂上之后交给 Radix 自己开合。
function EntryNameHover({
  entry,
  no,
  name,
  priority,
  status,
  onPeek,
}: {
  entry: TaskEntry
  no: string
  name: string
  priority?: string
  status: string
  onPeek: () => void
}) {
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const arm = () => {
    setMounted(true)
    setOpen(true)
  }

  // 触屏没有 hover —— 这张 hover 卡在手机上等于不存在，被 truncate 吃掉的名字和「当前阶段/来源/
  // 进入日期」在窄屏一个字都拿不回来。所以名字同时是个**可点**的东西：点开底部详情卡（见 EntrySheet），
  // 那里给全名 + 登记表字段 + 一整排大按钮的行操作。桌面点它也开，与 hover 卡并行不冲突。
  const label = (
    <button
      type="button"
      onMouseEnter={mounted ? undefined : arm}
      onClick={onPeek}
      className="min-w-0 flex-1 truncate text-start text-sm"
      title="查看这条需求"
    >
      {name}
    </button>
  )
  if (!mounted) return label

  const source = clean(entry.source)
  const stage = clean(entry.stage)
  const enteredAt = clean(entry.enteredAt)
  const rows: [string, string][] = [
    ['当前阶段', stage],
    ['来源', source],
    ['进入日期', enteredAt],
  ]

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>{label}</HoverCardTrigger>
      <HoverCardContent className="w-96">
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('font-mono text-xs font-bold', /^BUG/i.test(no) ? 'text-destructive' : 'text-sky-500')}>
              #{no}
            </span>
            {priority && <Badge variant="outline" className="text-[10px]">{priority}</Badge>}
            <Badge variant="outline" className={cn('text-[10px]', statusTone(status))}>{status}</Badge>
          </div>
          {/* 名字整段摊开：行里被 truncate 吃掉的正是这里 */}
          <div className="text-sm leading-relaxed font-medium [overflow-wrap:anywhere]">{name}</div>
          {rows.some(([, v]) => v) && (
            <div className="grid gap-1 border-t pt-2">
              {rows.map(([k, v]) =>
                v ? (
                  <div key={k} className="grid grid-cols-[4.5rem_1fr] gap-2 text-xs">
                    <span className="text-muted-foreground">{k}</span>
                    <span className="[overflow-wrap:anywhere]">{v}</span>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}

// 条目详情卡：点条目名弹出。给三样（窄屏尤其）原本拿不到的东西——
//   ① 被 truncate 吃掉的完整需求名；② 登记表里的当前阶段/来源/进入日期（看板上从没露过）；
//   ③ 行操作的按钮版（那颗 28px 的「⋯」在手机上是个笑话）。
// **一份内容、两种外壳**：窄屏走底部 Sheet（拇指区就在屏幕下沿，下滑关闭符合手机直觉）；
// 桌面走居中 Dialog——bottom Sheet 是 `inset-x-0` 且**不带任何断点收窄**，1920px 上会横贯
// 整幅、把 h-11 的整行大按钮摊成四条大横杠；而全站其它弹窗（覆盖明细/档案/派工/设置）一律
// 居中 Dialog，桌面继续用底卡也和它们不是一路货。
function EntrySheet({
  peek,
  onOpenChange,
  onCoverage,
  onDispatch,
}: {
  peek: EntryPeek | null
  onOpenChange: (o: boolean) => void
  onCoverage: (file: string, coverage: Coverage | null, req?: string) => void
  onDispatch: (d: { employee?: string; file?: string }) => void
}) {
  const isMobile = useIsMobile()
  // peek 为空时弹窗本就是关的，不渲染内容（Radix 只在开着时要求 Title 存在）
  const body =
    peek && peek.entry ? (
      <EntryPeekBody peek={peek} desktop={!isMobile} onOpenChange={onOpenChange} onCoverage={onCoverage} onDispatch={onDispatch} />
    ) : null

  if (isMobile) {
    return (
      <Sheet open={!!peek} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[88svh] gap-0 overflow-y-auto rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]"
        >
          {body}
        </SheetContent>
      </Sheet>
    )
  }
  return (
    <Dialog open={!!peek} onOpenChange={onOpenChange}>
      {/* p-0 + 内部分段自带 border-t/p-4，与窄屏同一套排版；max-w-md 比默认的 sm 宽一点，
          刚好装下一排四个行操作按钮 */}
      <DialogContent className="max-h-[85svh] gap-0 overflow-y-auto p-0 sm:max-w-md">{body}</DialogContent>
    </Dialog>
  )
}

// 详情卡正文。SheetTitle / DialogTitle 底层是同一个 Radix Dialog.Title，两种外壳里都合法，
// 这里统一用 DialogTitle，免得为外壳再分一次叉。
function EntryPeekBody({
  peek,
  desktop,
  onOpenChange,
  onCoverage,
  onDispatch,
}: {
  peek: EntryPeek
  desktop: boolean
  onOpenChange: (o: boolean) => void
  onCoverage: (file: string, coverage: Coverage | null, req?: string) => void
  onDispatch: (d: { employee?: string; file?: string }) => void
}) {
  const { openFile } = useFileViewer()
  const entry = peek.entry
  const no = clean(entry.no)
  const status = clean(entry.status)
  const { priority, clean: cleanName } = splitPriority(clean(entry.name))
  const isBug = /^BUG/i.test(no)
  const rows: [string, string][] = [
    ['当前阶段', clean(entry.stage)],
    ['来源', clean(entry.source)],
    ['进入日期', clean(entry.enteredAt)],
  ]
  const close = () => onOpenChange(false)
  // 桌面：常规尺寸、右对齐排成一行（放不下自动折行）；窄屏：44px 高的整行大按钮，拇指点得中
  const actionRow = desktop ? 'flex flex-wrap justify-end gap-2' : 'grid gap-2'
  const actionBtn = desktop ? '' : 'h-11 justify-start'

  return (
    <>
      {/* pe-12：给外壳自带的右上关闭键留位，别让长标题钻到它底下 */}
      <div className="flex flex-col gap-2 p-4 pb-3 pe-12">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() =>
              navigator.clipboard
                .writeText(no)
                .then(() => toast.success(`已复制 ${no}`))
                .catch(() => toast.error('复制失败'))
            }
            className={cn(
              'flex items-center gap-1 font-mono text-xs font-bold',
              isBug ? 'text-destructive' : 'text-sky-500',
            )}
            title="点击复制编号"
          >
            #{no}
            <CopyIcon className="size-3 opacity-60" />
          </button>
          {priority && <Badge variant="outline" className="text-[10px]">{priority}</Badge>}
          <Badge variant="outline" className={cn('text-[10px]', statusTone(status))}>{status}</Badge>
          {CLOSED.has(status) && <span className="text-xs text-emerald-500">已终结</span>}
        </div>
        {/* 整段摊开：行里被 truncate 吃掉的正是这里 */}
        <DialogTitle className="text-sm leading-relaxed [overflow-wrap:anywhere]">
          {cleanName}
        </DialogTitle>
      </div>

      <div className="grid gap-3 border-t p-4">
        {rows.some(([, v]) => v) && (
          <div className="grid gap-1.5">
            {rows.map(([k, v]) =>
              v ? (
                <div key={k} className="grid grid-cols-[4.5rem_1fr] gap-2 text-xs">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="[overflow-wrap:anywhere]">{v}</span>
                </div>
              ) : null,
            )}
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>facet 覆盖</span>
          {peek.rollup ? (
            <FacetBar
              counts={peek.rollup.counts}
              total={peek.rollup.total}
              green={peek.rollup.counts?.GREEN ?? 0}
            />
          ) : (
            <span>—</span>
          )}
        </div>
      </div>

      {/* 行操作的按钮版 */}
      <div className={cn('border-t p-4', actionRow)}>
        <Button
          variant="outline"
          className={actionBtn}
          onClick={() => {
            onCoverage(peek.file, peek.coverage, /^REQ-\d+/i.test(no) ? no.toUpperCase() : undefined)
            close()
          }}
        >
          facet 覆盖明细
        </Button>
        <Button
          variant="outline"
          className={actionBtn}
          onClick={() => {
            openFile(peek.file)
            close()
          }}
        >
          打开任务档案
        </Button>
        <Button
          variant="outline"
          className={actionBtn}
          onClick={() => {
            onDispatch({ employee: peek.owner, file: peek.file })
            close()
          }}
        >
          派工
        </Button>
        {canManualPass(status) && (
          <Button
            className={actionBtn}
            onClick={() => {
              peek.onManualPass(peek.file, no)
              close()
            }}
          >
            <SealCheckIcon weight="fill" /> 人工通过
          </Button>
        )}
      </div>
    </>
  )
}

// 行操作菜单：**点开才挂 Radix**。一屏有上百行，每行都常驻一套 DropdownMenu（context/id/
// 事件层）就是把 99% 永远不会被点开的菜单成本摊在每次渲染上。未点开时只是一个普通按钮。
function RowMenu({
  canPass,
  onPeek,
  onOpenFile,
  onDispatch,
  onCoverage,
  onManualPass,
}: {
  canPass: boolean
  onPeek: () => void
  onOpenFile: () => void
  onDispatch: () => void
  onCoverage: () => void
  onManualPass: () => void
}) {
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  // 窄屏：绝对定位到「行首行」的右端（32px 见方，四周还有行内边距兜着，手指够用），
  // 不再挂在第二行末尾——那样它和左边那簇状态签之间会留出一大片空地（老板：「布局空泛」）。
  // 桌面：回到常规流，作为单行的最后一列。
  const trigger = 'absolute end-1 top-1 size-8 shrink-0 md:static md:size-7'

  if (!mounted)
    return (
      <Button
        variant="ghost"
        size="icon"
        className={trigger}
        aria-label="操作"
        onClick={() => {
          setMounted(true)
          setOpen(true)
        }}
      >
        <DotsThreeIcon className="size-4" />
      </Button>
    )

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={trigger} aria-label="操作">
          <DotsThreeIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onPeek}>查看详情</DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenFile}>打开档案</DropdownMenuItem>
        <DropdownMenuItem onClick={onDispatch}>派工</DropdownMenuItem>
        <DropdownMenuItem onClick={onCoverage}>facet 覆盖</DropdownMenuItem>
        {canPass && <DropdownMenuItem onClick={onManualPass}>人工通过</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
