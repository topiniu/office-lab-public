// 任务档案「要点」页 —— 给人看的那 4%
//
// 缘起（2026-09-09 老板：「lab 的任务档案查看观感很差」）。实测大货备货 v0.1.0 档案 137KB，
// 其中时间线 56.6% + 覆盖矩阵 30.3% 全是机器台账/agent 叙述，人真正要看的只占 3.6%——
// 而查看器是一坨平铺 markdown，**要滚过 77KB 才能找到"今天等我拍什么"**。
//
// 本页按**人打开档案的四个时刻**排版（结构与数据全在引擎侧 `app/task-brief.js` 算好，
// 前端只负责摆）：① 等你的三件事 → ② 自上次打开变了什么 → ③ 逐条决定（带不拍的代价）
// → ④ 要你亲眼看 / 证据不硬的 → 台账只给一行汇总（点「档案」页签看原文）。
//
// 为什么解析放引擎不放这里：档案解析器（登记表/覆盖矩阵/待确认/facet 全集/三道需求闸）都在引擎侧，
// 前端再写一套 TS 版必然漂移——同一份档案会有两个答案（本仓踩过多次）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { apiGet } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export type BriefDecision = {
  id: string
  section?: string
  scope?: string
  topic: string
  proposal?: string
  cost?: string
  status?: string
}
type FacetItem = { facetId: string; what?: string; action?: string }
export type Brief = {
  version?: string
  task?: string
  owner?: string
  stateText?: string
  updated?: string
  delta: { since?: string; count: number; days: string[]; items: { date: string; head: string }[]; truncated: number }
  decisions: BriefDecision[]
  costMissing: { id: string }[]
  waitingYouCount: number
  needYouEyes: FacetItem[]
  riskyCount: number
  riskyGroups: { label: string; plain: string; items: FacetItem[] }[]
  blocked: { no: string; name: string; status: string; stage?: string }[]
  unmet: { key: string; label: string; why: string }[]
  milestones: { date: string; kind: string; head: string }[]
  ledger: {
    facets: number; matrixRows: number; timelineRows: number; timelineBytes: number
    units: number | null; leaves: number | null
    candidates: number | null; answered: number | null; driftText?: string
  }
}

// 「你上次打开这份档案是哪天」——delta 的基准。**存在前端**：它是"这个人"的阅读进度，
// 不是档案的属性（两个人各自的 delta 不同）。日期粒度够用：人问的是"我睡了一觉之后发生了什么"。
const SEEN_KEY = 'olab.archiveSeen'
function loadSeen(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') } catch { return {} }
}
function markSeen(path: string) {
  try {
    const all = loadSeen()
    all[path] = new Date().toISOString().slice(0, 10)
    localStorage.setItem(SEEN_KEY, JSON.stringify(all))
  } catch { /* localStorage 不可用就退化成"每次都给最近 5 条" */ }
}

function Stat({ n, label, hint, tone, onClick }: { n: number; label: string; hint: string; tone: 'primary' | 'warn' | 'bad' | 'ok'; onClick?: () => void }) {
  const toneCls = {
    primary: 'border-primary/40 bg-primary/5',
    warn: 'border-amber-500/40 bg-amber-500/5',
    bad: 'border-destructive/40 bg-destructive/5',
    ok: 'border-border',
  }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick || !n}
      className={cn('flex-1 rounded-md border p-2.5 text-start transition-colors sm:p-3', toneCls, onClick && n && 'hover:bg-accent/50')}
    >
      <div className="flex items-baseline gap-1.5">
        <span className={cn('font-mono text-xl font-semibold tabular-nums sm:text-2xl', !n && 'text-muted-foreground')}>{n}</span>
        <span className="text-xs font-medium sm:text-sm">{label}</span>
      </div>
      <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</div>
    </button>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
        {title}
        {count != null && <Badge variant="secondary" className="px-1.5 py-0 text-[10.5px]">{count}</Badge>}
      </h3>
      {children}
    </section>
  )
}

export function ArchiveBrief({
  path, onOpenRaw, onDispatch,
}: {
  path: string
  onOpenRaw: () => void
  onDispatch?: (instruction: string) => void
}) {
  const [brief, setBrief] = useState<Brief | null>(null)
  const [err, setErr] = useState('')
  const since = useMemo(() => loadSeen()[path] || '', [path])

  useEffect(() => {
    let alive = true
    setBrief(null); setErr('')
    apiGet<{ brief: Brief }>(`/api/task-brief?path=${encodeURIComponent(path)}&since=${encodeURIComponent(since)}`)
      .then((r) => { if (alive) { setBrief(r.brief); markSeen(path) } })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [path, since])

  const copy = useCallback((t: string) => {
    navigator.clipboard?.writeText(t).then(
      () => toast.success('已复制'),
      () => toast.error('复制失败'),
    )
  }, [])

  if (err) return <p className="text-xs text-destructive">读简报失败：{err}</p>
  if (!brief) return <div className="grid gap-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-full" /></div>

  const b = brief
  const missing = new Set(b.costMissing.map((d) => d.id))
  return (
    <div className="text-[13px]">
      {/* 顶行：这一版现在什么状态、谁手上 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {b.version && <span className="font-medium text-foreground">{b.version}</span>}
        {b.stateText && <span>{b.stateText}</span>}
        {b.owner && <span>在 {b.owner} 手上</span>}
        {b.updated && <span>更新于 {b.updated}</span>}
      </div>

      {/* ① 等你的三件事 —— 首屏只放这个。任务目标/背景第一天看过一次，之后不再需要 */}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Stat n={b.decisions.length} label="等你拍板" tone="primary" hint={b.decisions.length ? '一句话就能推动' : '没有'} />
        <Stat n={b.waitingYouCount} label="等你验收" tone={b.needYouEyes.length ? 'warn' : 'ok'}
          hint={b.needYouEyes.length ? `其中 ${b.needYouEyes.length} 处机器测不了、要你亲眼看` : '机器能给的证据都齐了'} />
        <Stat n={b.blocked.length} label="卡住" tone={b.blocked.length ? 'bad' : 'ok'}
          hint={b.blocked.length ? b.blocked.map((x) => x.no).join('、') : '没有'} />
      </div>

      {/* ② 自上次打开变了什么 —— 不是第二份时间线 */}
      {b.delta.count > 0 && (
        <Section title={since ? `你上次看（${since}）之后变了什么` : '最近的进展'} count={b.delta.count}>
          <ul className="space-y-1">
            {b.delta.items.map((d, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{d.date.slice(5)}</span>
                <span className="min-w-0 text-foreground/90">{d.head}</span>
              </li>
            ))}
            {b.delta.truncated > 0 && <li className="text-[11px] text-muted-foreground">…另有 {b.delta.truncated} 条（细节在原档案时间线）</li>}
          </ul>
        </Section>
      )}

      {/* ③ 逐条决定 —— 每条必须带「不拍的代价」，缺了就亮红 */}
      {b.decisions.length > 0 && (
        <Section title="⭐ 等你拍板" count={b.decisions.length}>
          <div className="space-y-2">
            {b.decisions.map((d) => (
              <div key={d.id} className="rounded-md border p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10.5px]">{d.id}</Badge>
                  {d.scope && <span className="text-[11px] text-muted-foreground">{d.scope}</span>}
                </div>
                <p className="mt-1 font-medium leading-snug">{d.topic}</p>
                {d.proposal && (
                  <p className="mt-1.5 text-xs leading-snug">
                    <span className="text-muted-foreground">不拍就按这个执行：</span>{d.proposal}
                  </p>
                )}
                <p className={cn('mt-1 text-xs leading-snug', missing.has(d.id) ? 'text-destructive' : 'text-foreground/80')}>
                  <span className="text-muted-foreground">不拍的代价：</span>
                  {missing.has(d.id) ? '⚠ 菲菲没写——已记为她的必填缺口' : d.cost}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {/* 拍板结果由**菲菲回写档案**，引擎不去手改那张长表格（锚点易失配、并发会互相覆盖）。
                      所以这里给的是"派工"而不是"直接改档案"——与 office-lab 的分工一致。 */}
                  <Button size="sm" variant="secondary" className="h-7 text-xs"
                    onClick={() => onDispatch?.(`【拍板】${d.id}：按你的拟定口径执行（${d.proposal || '见档案'}）。请回写任务档案「待确认事项」把这条标为已定、补上结论与日期，并把受影响的 facet/功能树同步改掉；若这条会连带改动别的口径，一并列出来再往下推。`)}
                    disabled={!onDispatch}>
                    按拟定的来 → 派菲菲落实
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs"
                    onClick={() => onDispatch?.(`【拍板】${d.id}：我不按拟定口径，改为——（请在这里写你的口径）。原拟定是：${d.proposal || '见档案'}。请据此回写档案并同步 facet/功能树。`)}
                    disabled={!onDispatch}>
                    我来写
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => copy(`${d.id} ${d.topic}\n拟定：${d.proposal || ''}\n代价：${d.cost || '（未写）'}`)}>
                    复制
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 卡住的条目 */}
      {b.blocked.length > 0 && (
        <Section title="⛔ 卡住的条目" count={b.blocked.length}>
          <ul className="space-y-1.5">
            {b.blocked.map((x) => (
              <li key={x.no} className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs">
                <span className="font-mono">{x.no}</span> {x.name}
                <span className="ms-1.5 text-destructive">（{x.status}）</span>
                {x.stage && <div className="mt-0.5 text-[11px] text-muted-foreground">{x.stage}</div>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* ④ 要你亲眼看 —— 术语已在引擎侧翻成"看什么" */}
      {b.needYouEyes.length > 0 && (
        <Section title="👀 机器测不了、要你亲眼看" count={b.needYouEyes.length}>
          <ul className="space-y-1">
            {b.needYouEyes.map((i) => (
              <li key={i.facetId} className="flex gap-2 text-xs">
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{i.facetId}</span>
                <span className="min-w-0">{i.what || i.action}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 证据不硬的：同类只解释一遍风险，底下逐条只给判据 */}
      {b.riskyGroups?.length > 0 && (
        <Section title="⚠ 证据不硬的（放行前值得知道）" count={b.riskyCount}>
          <div className="space-y-2">
            {b.riskyGroups.map((g) => (
              <div key={g.label} className="rounded border border-amber-500/30 bg-amber-500/5 p-2">
                <p className="text-xs font-medium">{g.label}</p>
                <p className="text-[11px] leading-snug text-muted-foreground">{g.plain}</p>
                <ul className="mt-1 space-y-0.5">
                  {g.items.slice(0, 10).map((i) => (
                    <li key={i.facetId} className="flex gap-2 text-[11px]">
                      <span className="shrink-0 font-mono text-muted-foreground">{i.facetId}</span>
                      <span className="min-w-0">{i.what}</span>
                    </li>
                  ))}
                  {g.items.length > 10 && <li className="text-[11px] text-muted-foreground">…另有 {g.items.length - 10} 条</li>}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* 还差哪几道门（只列没过的，且说清"没过意味着什么"） */}
      {b.unmet.length > 0 && (
        <Section title="还差哪几道门" count={b.unmet.length}>
          <ul className="space-y-1">
            {b.unmet.map((g) => (
              <li key={g.key} className="text-xs">
                <span className="font-medium">{g.label}</span>
                <span className="text-muted-foreground">：{g.why}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 里程碑：时间线压成人会关心的那几类 */}
      {b.milestones.length > 0 && (
        <Section title="里程碑" count={b.milestones.length}>
          <ul className="space-y-1">
            {b.milestones.slice(-10).map((m, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{m.date.slice(5)}</span>
                <Badge variant="outline" className="h-4 shrink-0 px-1 py-0 text-[10px]">{m.kind}</Badge>
                <span className="min-w-0 text-foreground/90">{m.head}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* 台账只给一行汇总：它是审计底料，价值是"出事能查"，不是"每天给人看" */}
      <div className="mt-4 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
        台账（不用每天看）：facet {b.ledger.facets} 条 · 覆盖矩阵 {b.ledger.matrixRows} 行 · 时间线 {b.ledger.timelineRows} 条（
        {Math.round((b.ledger.timelineBytes || 0) / 1024)}KB）
        {b.ledger.units != null && ` · 源材料 ${b.ledger.units} 单元`}
        {b.ledger.leaves != null && ` · 功能树 ${b.ledger.leaves} 叶`}
        {b.ledger.candidates != null && ` · 自我批判 ${b.ledger.answered ?? 0}/${b.ledger.candidates}`}
        {b.ledger.driftText && ` · ${b.ledger.driftText}`}
        <button onClick={onOpenRaw} className="ms-1.5 underline hover:text-foreground">看原始档案 →</button>
      </div>
    </div>
  )
}
