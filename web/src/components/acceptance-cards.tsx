// 验收卡（v0.11.0）——老板早上只看这个
//
// 缘起（2026-09-29 老板原话）：「晨检包是一个很难用的概念和交互，早晨我来了之后根本没有那么多心思去阅读
// 一大篇文档内容。我只关心我的功能有没有完成，完成后是什么样的，对老功能的影响如何，有哪些高危的事项。」
// 于是一个需求一张卡，四格：① 做完没 ② 长啥样 ③ 动了哪些老功能 ④ 要你拍板的高危事项，
// 外加一格「我替你定了什么」（守航期间员工自己拍的、可以反悔的决定——一键追认或改掉）。
//
// 数据全在引擎侧算好（`GET /api/acceptance-cards`，判定逻辑在 app/acceptance-card.js），前端只负责摆。
// 卡片上的每个按钮都会真的推动流水线：打回 / 改决定 / 给高危事项选路 → 引擎把条目交回菲菲接着做
// （契约过期就凭这次点击签一份续跑契约）。所以按钮文案必须说清「点了会发生什么」。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { apiGet, apiPost, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useSseEvent } from '@/components/sse-provider'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useImageViewer, viewInLab } from '@/components/image-viewer'

export type CardDecision = {
  id: string; req: string; kind: 'fact' | 'reversible'; topic: string; chosen: string; why: string
  alternative?: string; howToChange?: string; source?: string; status: 'open' | 'confirmed' | 'changed'; ruling?: string; by?: string; runName?: string
}
export type CardRisk = {
  id: string; req: string; what: string; why: string; options: string[]; recommend?: string; redline?: string
  status: 'open' | 'approved' | 'denied' | 'stale'; ruling?: string; by?: string; runName?: string; blocksNow?: boolean
}
export type AcceptanceCardData = {
  req: string; name: string; runName: string
  state: 'waiting_you' | 'stuck' | 'done' | 'finishing' | 'in_progress' | 'parked' | 'not_started' | 'accepted' | 'shipped'
  headline: string
  done: { reachedEnd: boolean; text: string; green: number; total: number; boardStatus: string }
  looks: { summary: string; shots: { src: string; caption?: string }[]; noUi: string }
  impact: { items: { feature: string; how?: string; verified: boolean | null; evidence?: string }[]; none: string }
  decisions: CardDecision[]
  risks: CardRisk[]
  missing: { part: string; who: string; what: string }[]
  verdict: { status: 'accepted' | 'rejected'; note?: string } | null
}
export type GoalView = { verdict: string; why: string; line: string; mode: string; turns: number; maxGoalTurns: number }
export type AcceptanceCardsResponse = {
  ok?: boolean; error?: string; scope: 'version' | 'round'; title: string; version?: string; file?: string
  runName?: string; contractRel?: string; deadline?: string; legacy?: boolean; goal: GoalView | null
  summary: { total: number; done: number; waitingYou: number; stuck: number; decisionsOpen: number; text: string }
  cards: AcceptanceCardData[]; empty?: string
  recent?: { runName: string; version: string; deadline: string }[]
}

const STATE: Record<AcceptanceCardData['state'], { label: string; cls: string }> = {
  waiting_you: { label: '等你拍板', cls: 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  stuck: { label: '卡住了', cls: 'border-destructive/50 bg-destructive/10 text-destructive' },
  done: { label: '做完了', cls: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  accepted: { label: '已验收', cls: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700/80 dark:text-emerald-300/80' },
  finishing: { label: '在补验收卡', cls: 'border-primary/40 bg-primary/10 text-primary' },
  in_progress: { label: '还在做', cls: 'border-border bg-muted/40 text-muted-foreground' },
  parked: { label: '暂停', cls: 'border-border bg-muted/40 text-muted-foreground' },
  not_started: { label: '还没开始', cls: 'border-border bg-muted/40 text-muted-foreground' },
  shipped: { label: '已上线', cls: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700/80 dark:text-emerald-300/80' },
}
const GOAL_TONE: Record<string, string> = {
  met: 'border-emerald-500/40 bg-emerald-500/5',
  waiting_boss: 'border-amber-500/40 bg-amber-500/5',
  blocked: 'border-destructive/40 bg-destructive/5',
  paused: 'border-amber-500/40 bg-amber-500/5',
  budget_limited: 'border-border bg-muted/30',
}

// 截图地址：仓内相对路径走 /api/file?raw=1（同 olcard 画廊的口径），http/data 原样用
function imgSrc(src: string) {
  const s = String(src || '').trim()
  if (!s || /^(https?:|data:|blob:)/i.test(s) || (s.startsWith('/') && !s.startsWith('//'))) return s
  return `/api/file?raw=1&path=${encodeURIComponent(s.replace(/\\/g, '/'))}`
}
function errText(e: unknown) {
  const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null
  return body?.error || (e as Error).message
}

function Section({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="text-[11px] font-medium text-muted-foreground">
        <span className="me-1 text-foreground">{n}</span>
        {title}
      </div>
      <div className="text-sm leading-snug">{children}</div>
    </div>
  )
}


// ---------- 阅读体验（2026-09-30 老板截图：「验收台的阅读效果太差了」）----------
// 病根：①一张卡把四格全部摊开，员工写的理由/证据（session 号、facet 号、接口名）整段平铺，一张卡要滚好几屏；
// ②窗口窄且长串不换行，右侧状态被截、底部冒横向滚动条；③「要我处理的」和「已经做完的」混在一起。
// 改法：默认每张卡只占一行半（状态 + 一句话 + 几个关键数字），要处理的才默认展开；长文字截两行、证据收进「看证据」；
// 顶部按「要我处理 / 做完了 / 还在做」筛；窗口放宽、全部文字允许在任意处断行。
const WRAP = 'min-w-0 break-words [overflow-wrap:anywhere]'

// 超过 N 行就截断，点「展开」看全文
function Clamp({ text, lines = 2, className = '' }: { text: string; lines?: 1 | 2 | 3; className?: string }) {
  const [open, setOpen] = useState(false)
  if (!text) return null
  const long = text.length > (lines === 1 ? 60 : lines === 2 ? 120 : 200)
  const clamp = lines === 1 ? 'line-clamp-1' : lines === 2 ? 'line-clamp-2' : 'line-clamp-3'
  return (
    <div className={cn(WRAP, className)}>
      <span className={cn(!open && long ? clamp : 'block')}>{text}</span>
      {long && (
        <button type="button" onClick={() => setOpen(!open)} className="text-[11px] text-primary underline-offset-2 hover:underline">
          {open ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}

type Act = (a: { card: AcceptanceCardData; action: string; id?: string; choice?: string; note?: string; runName?: string }) => Promise<void>

function RiskBlock({ card, r, act, busy }: { card: AcceptanceCardData; r: CardRisk; act: Act; busy: boolean }) {
  const [note, setNote] = useState('')
  const [noting, setNoting] = useState(false)
  if (r.status !== 'open') {
    return (
      <div className={cn('text-xs text-muted-foreground', WRAP)}>
        <span className="me-1">·</span>
        <span className="text-foreground">{r.what}</span>
        {' — '}
        {r.status === 'approved' ? `你选了：${r.ruling}` : r.status === 'stale' ? '已一路做到终点、卡也齐了（看起来你在别处拍过）' : `你决定不做${r.ruling ? `：${r.ruling}` : ''}`}
      </div>
    )
  }
  return (
    <div className={cn('grid gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/5 p-2.5', WRAP)} data-testid={`acceptance-risk-${r.id}`}>
      <div className="text-sm font-medium">{r.what}</div>
      <Clamp text={`为什么要你拍：${r.why}${r.redline ? `（碰到红线：${r.redline}）` : ''}`} className="text-xs text-muted-foreground" />
      {r.recommend && <Clamp text={`推荐：${r.recommend}`} lines={1} className="text-xs text-muted-foreground" />}
      {r.blocksNow === false && <div className="text-xs text-emerald-700 dark:text-emerald-300">已按推荐的路先做着——你选别的路，会自动交回返工</div>}
      <div className="grid gap-1.5">
        {r.options.map((o, i) => (
          <Button
            key={i}
            size="sm"
            variant={i === 0 ? 'default' : 'outline'}
            disabled={busy}
            data-testid={`acceptance-risk-${r.id}-option-${i}`}
            onClick={() => act({ card, action: 'risk_choose', id: r.id, choice: o, note, runName: r.runName })}
            className="h-auto min-h-7 justify-start whitespace-normal py-1 text-left text-xs"
          >
            {o}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {r.blocksNow !== false && (
          <Button size="sm" variant="outline" disabled={busy} data-testid={`acceptance-risk-${r.id}-proceed`} onClick={() => act({ card, action: 'risk_proceed', id: r.id, note, runName: r.runName })} className="h-7 text-xs">
            先按推荐做（我之后再定）
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} data-testid={`acceptance-risk-${r.id}-deny`} onClick={() => act({ card, action: 'risk_deny', id: r.id, note, runName: r.runName })} className="h-7 text-xs">
          都不做
        </Button>
        <button type="button" onClick={() => setNoting(!noting)} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
          {noting ? '不补了' : '补一句话'}
        </button>
      </div>
      {noting && <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="补一句（会和你的选择一起交给员工）" className="min-h-10 resize-y text-xs" />}
    </div>
  )
}

function DecisionRow({ card, d, act, busy }: { card: AcceptanceCardData; d: CardDecision; act: Act; busy: boolean }) {
  const [why, setWhy] = useState(false)
  return (
    <div className={cn('grid gap-1 border-b py-1.5 last:border-b-0', WRAP)} data-testid={`acceptance-decision-${d.id}`}>
      <div className="text-sm">
        <span className="me-1.5 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">{d.kind === 'fact' ? '查到的' : '替你定的'}</span>
        <span className="text-muted-foreground">{d.topic}：</span>
        <span className="font-medium">{d.chosen}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {d.status === 'open' ? (
          <>
            <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={busy} data-testid={`acceptance-decision-${d.id}-ok`} onClick={() => act({ card, action: 'decision_ok', id: d.id, runName: d.runName })}>
              没问题
            </Button>
            {d.kind === 'reversible' && d.alternative && (
              <Button size="sm" variant="outline" className="h-auto min-h-6 max-w-full whitespace-normal py-0.5 text-left text-[11px]" disabled={busy} data-testid={`acceptance-decision-${d.id}-change`} onClick={() => act({ card, action: 'decision_change', id: d.id, runName: d.runName })} title={d.alternative}>
                改成：{d.alternative.length > 40 ? `${d.alternative.slice(0, 40)}…` : d.alternative}
              </Button>
            )}
          </>
        ) : (
          <span className="text-[11px] text-muted-foreground">{d.status === 'confirmed' ? '✓ 你已追认' : `↺ 你改成了：${d.ruling}`}</span>
        )}
        <button type="button" onClick={() => setWhy(!why)} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
          {why ? '收起理由' : '为什么这么定'}
        </button>
      </div>
      {why && (
        <div className="rounded bg-muted/40 p-2 text-xs leading-relaxed text-muted-foreground">
          <div>理由：{d.why}</div>
          {d.kind === 'fact' && d.source && <div>依据：{d.source}</div>}
          {d.kind === 'reversible' && d.alternative && <div>不满意可改成：{d.alternative}{d.howToChange ? `（${d.howToChange}）` : ''}</div>}
        </div>
      )}
    </div>
  )
}

// 一张卡「要不要老板现在动手」：要拍的高危 / 卡住 / 做完等验收。「替你定了 N 条」不算——几乎每张卡都有，
// 算进来「要我处理」就等于「全部」（2026-09-30 截图实测 9/9），筛选失去意义；它们仍在卡上，愿意看再点开。
function needsMe(c: AcceptanceCardData) {
  return c.state === 'waiting_you' || c.state === 'stuck' || (c.state === 'done' && c.verdict?.status !== 'accepted')
}

function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'ok' | 'warn' | 'bad' }) {
  const cls = { muted: 'bg-muted/60 text-muted-foreground', ok: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', warn: 'bg-amber-500/10 text-amber-700 dark:text-amber-300', bad: 'bg-destructive/10 text-destructive' }[tone]
  return <span className={cn('rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap', cls)}>{children}</span>
}

function CardView({ card, act, busy }: { card: AcceptanceCardData; act: Act; busy: boolean }) {
  const { openImage } = useImageViewer()
  const [open, setOpen] = useState(card.state === 'waiting_you' || card.state === 'stuck')
  const [evidence, setEvidence] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const st = STATE[card.state] || STATE.in_progress
  const openRisks = card.risks.filter((r) => r.status === 'open')
  const doneRisks = card.risks.filter((r) => r.status !== 'open')
  const openDecisions = card.decisions.filter((d) => d.status === 'open').length
  const imp = card.impact.items
  const impOk = imp.filter((i) => i.verified === true).length
  const impBad = imp.filter((i) => i.verified === false).length
  const canJudge = card.state === 'done' || card.state === 'finishing' || card.state === 'stuck' || card.state === 'waiting_you'
  return (
    <div className={cn('rounded-lg border bg-card', open && 'shadow-sm')} data-testid={`acceptance-card-${card.req}`}>
      {/* 折叠头：一眼能扫完的那一行半 */}
      <button type="button" onClick={() => setOpen(!open)} className="grid w-full gap-1.5 p-3 text-left" data-testid={`acceptance-card-toggle-${card.req}`}>
        <div className="flex items-start gap-2">
          <span className={cn('mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium', st.cls)}>{st.label}</span>
          <div className={cn('flex-1', WRAP)}>
            <div className="text-sm font-medium leading-snug">
              {card.name || '（未写需求名）'}
              <span className="ms-2 font-mono text-[11px] font-normal text-muted-foreground">{card.req}</span>
            </div>
            <div className="line-clamp-1 text-xs text-muted-foreground">{card.looks.summary || card.headline}</div>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{open ? '收起 ▴' : '展开 ▾'}</span>
        </div>
        <div className="flex flex-wrap gap-1.5 ps-0.5">
          {card.done.total > 0 && <Chip tone={card.done.green === card.done.total ? 'ok' : 'muted'}>测试 {card.done.green}/{card.done.total}</Chip>}
          {imp.length > 0 && <Chip tone={impBad ? 'bad' : impOk === imp.length ? 'ok' : 'warn'}>老功能 {impOk}/{imp.length} 验过{impBad ? ` · ${impBad} 个没过` : ''}</Chip>}
          {openRisks.length > 0 && <Chip tone="warn">高危 {openRisks.length} 件要你拍</Chip>}
          {openDecisions > 0 && <Chip>替你定了 {openDecisions} 条待看</Chip>}
          {card.looks.shots.length > 0 && <Chip>截图 {card.looks.shots.length}</Chip>}
          {card.missing.length > 0 && <Chip tone="warn">卡片还缺 {card.missing.length} 格</Chip>}
        </div>
      </button>

      {open && (
        <div className="grid gap-4 border-t p-3">
          {card.headline && card.looks.summary && <div className={cn('text-xs text-muted-foreground', WRAP)}>{card.headline}</div>}

          {openRisks.length > 0 && (
            <Section n="④" title="要你拍板的高危事项">
              <div className="grid gap-2">{openRisks.map((r) => <RiskBlock key={`${r.runName}-${r.id}`} card={card} r={r} act={act} busy={busy} />)}</div>
            </Section>
          )}

          <Section n="②" title="长啥样">
            {card.looks.summary ? <div className={WRAP}>{card.looks.summary}</div> : <div className="text-xs text-muted-foreground">（还没写）</div>}
            {card.looks.noUi && <div className="text-xs text-muted-foreground">无界面改动：{card.looks.noUi}</div>}
            {card.looks.shots.length > 0 && (
              <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {card.looks.shots.map((s) => (
                  <a key={s.src} href={imgSrc(s.src)} target="_blank" rel="noopener" onClick={viewInLab(openImage, imgSrc(s.src), s.caption || '')} title={s.caption || s.src} className="block min-w-0 cursor-zoom-in">
                    <img src={imgSrc(s.src)} alt={s.caption || card.req} className="aspect-[16/10] w-full rounded border object-cover object-top" loading="lazy" />
                    {s.caption && <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{s.caption}</div>}
                  </a>
                ))}
              </div>
            )}
          </Section>

          <div className="grid items-start gap-4 sm:grid-cols-2">
            <Section n="①" title="做完没">
              <div className={WRAP}>{card.done.text}</div>
              {card.done.boardStatus && <div className="text-xs text-muted-foreground">看板：{card.done.boardStatus}</div>}
            </Section>
            <Section n="③" title="动了哪些老功能">
              {imp.length ? (
                <ul className="grid gap-1">
                  {imp.map((i) => (
                    <li key={i.feature} className={cn('text-sm', WRAP)}>
                      <span className="me-1">{i.verified === true ? '✅' : i.verified === false ? '❌' : '⏳'}</span>
                      {i.feature}
                      <span className="ms-1 text-xs text-muted-foreground">{i.verified === true ? '正常' : i.verified === false ? '验证没过' : '还没重跑'}</span>
                      {evidence && (i.how || i.evidence) && (
                        <div className="mt-0.5 rounded bg-muted/40 p-1.5 text-[11px] leading-relaxed text-muted-foreground">
                          {i.how && <div>怎么碰到的：{i.how}</div>}
                          {i.evidence && <div>证据：{i.evidence}</div>}
                        </div>
                      )}
                    </li>
                  ))}
                  {imp.some((i) => i.how || i.evidence) && (
                    <li>
                      <button type="button" onClick={() => setEvidence(!evidence)} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
                        {evidence ? '收起证据' : '看证据'}
                      </button>
                    </li>
                  )}
                </ul>
              ) : card.impact.none ? (
                <Clamp text={`没碰老功能：${card.impact.none}`} className="text-xs text-muted-foreground" />
              ) : (
                <div className="text-xs text-muted-foreground">（还没申报）</div>
              )}
            </Section>
          </div>

          {card.decisions.length > 0 && (
            <Section n="✎" title={`我替你定了什么${openDecisions ? `（${openDecisions} 条待你看）` : ''}`}>
              <div className="grid">{card.decisions.map((d) => <DecisionRow key={`${d.runName}-${d.id}`} card={card} d={d} act={act} busy={busy} />)}</div>
            </Section>
          )}

          {doneRisks.length > 0 && <div className="grid gap-1">{doneRisks.map((r) => <RiskBlock key={`${r.runName}-${r.id}`} card={card} r={r} act={act} busy={busy} />)}</div>}

          {card.missing.length > 0 && (
            <div className={cn('rounded border border-dashed px-2 py-1.5 text-xs text-muted-foreground', WRAP)}>
              卡片还缺：{card.missing.map((m) => m.what).join('；')}（系统会自动派人补）
            </div>
          )}

          {card.verdict?.status !== 'accepted' && canJudge && (
            <div className="grid gap-2 border-t pt-3">
              {rejecting ? (
                <>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="哪里不对 / 你想要什么样（一句话就行，员工按这句话改）" className="min-h-14 resize-y text-sm" data-testid={`acceptance-card-reject-reason-${card.req}`} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="destructive" disabled={busy || !reason.trim()} data-testid={`acceptance-card-reject-confirm-${card.req}`} onClick={() => act({ card, action: 'reject', note: reason }).then(() => { setRejecting(false); setReason('') })}>
                      打回去改
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>算了</Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" disabled={busy || openRisks.length > 0} data-testid={`acceptance-card-accept-${card.req}`} onClick={() => act({ card, action: 'accept' })} title={openRisks.length ? '先把上面的高危事项拍了' : '记为你已验收（看板置「人工Pass」），不会触发发布'}>
                    验收通过
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} data-testid={`acceptance-card-reject-${card.req}`} onClick={() => setRejecting(true)}>
                    打回
                  </Button>
                  {openRisks.length > 0 && <span className="text-[11px] text-muted-foreground">先拍上面的高危事项，才能验收通过</span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type Filter = 'me' | 'all' | 'done' | 'doing'
const FILTERS: { key: Filter; label: string; test: (c: AcceptanceCardData) => boolean }[] = [
  { key: 'me', label: '要我处理', test: needsMe },
  { key: 'done', label: '做完了', test: (c) => ['done', 'accepted', 'shipped'].includes(c.state) },
  { key: 'doing', label: '还在做', test: (c) => ['in_progress', 'finishing', 'parked', 'not_started'].includes(c.state) },
  { key: 'all', label: '全部', test: () => true },
]

export function AcceptanceCards({ file, runName: initialRun, onOpenRaw }: { file?: string; runName?: string; onOpenRaw?: () => void }) {
  const [runName, setRunName] = useState(initialRun || '')
  const [data, setData] = useState<AcceptanceCardsResponse | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<Filter | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(() => {
    const q = file ? `file=${encodeURIComponent(file)}` : runName ? `runName=${encodeURIComponent(runName)}` : ''
    apiGet<AcceptanceCardsResponse>(`/api/acceptance-cards${q ? `?${q}` : ''}`)
      .then((d) => { setData(d); setErr('') })
      // 404＝前端已是 v0.11.0、引擎还跑着旧代码（dist 一构建 4700 就换新，引擎要走托盘重启才换）——说人话，别甩一句 GET failed
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? '引擎还没重启到 v0.11.0：请在托盘点「重启」后再打开' : errText(e)))
  }, [file, runName])
  useEffect(() => { load() }, [load])
  // 员工填卡 / 目标循环判定 / 看板状态变化都会推 SSE——合并 1 秒再刷，别一条事件拉一次
  useSseEvent(['acceptance-cards-changed', 'guard-goal', 'tasks-changed'], () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(load, 1000)
  })

  const act: Act = useCallback(async ({ card, action, id, choice, note, runName: rn }) => {
    setBusy(true)
    try {
      const r = await apiPost<{ ok: boolean; runId?: string; queued?: boolean; contract?: string }>('/api/acceptance-cards/action', {
        // 版本视图里没有轮次的卡（共驾做的）就不带轮次，由引擎按非守航条目处理；只有「一轮」视图才能退到本轮
        runName: rn || card.runName || (data?.scope === 'round' ? data.runName || '' : ''), req: card.req, action, id, choice, note, file: data?.file || file || '',
      })
      toast.success(
        action === 'accept' ? `${card.req} 已记为验收通过` : action === 'decision_ok' ? '已追认' : '已交回流水线',
        { description: r.contract ? `契约已过期，已凭这次操作签了续跑契约 ${r.contract}` : r.queued ? '菲菲正忙，已排队' : r.runId ? `菲菲接手（${r.runId}）` : undefined },
      )
      load()
    } catch (e) {
      toast.error('操作没成功', { description: errText(e) })
    } finally {
      setBusy(false)
    }
  }, [data, file, load])

  if (err) return <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">读不到验收卡：{err}</div>
  if (!data) return <div className="grid gap-2"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>

  const cards = data.cards.map((c) => (data.legacy ? { ...c, missing: [] } : c))
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, cards.filter(f.test).length])) as Record<Filter, number>
  // 默认先看「要我处理」；一张都没有就看全部
  const active: Filter = filter ?? (counts.me ? 'me' : 'all')
  const shown = cards.filter(FILTERS.find((f) => f.key === active)!.test)

  return (
    <div className={cn('grid gap-3', WRAP)} data-testid="acceptance-cards">
      <div className={cn('grid gap-1.5 rounded-md border p-3', GOAL_TONE[data.goal?.verdict || ''] || 'bg-muted/20')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium">{data.title}</div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {data.deadline && <span>截止 {data.deadline.replace('T', ' ').slice(5, 16)}</span>}
            {!file && (data.recent?.length || 0) > 1 && (
              <select className="max-w-56 rounded border bg-background px-1 py-0.5 text-xs" value={data.runName || ''} onChange={(e) => setRunName(e.target.value)} data-testid="acceptance-cards-round-select">
                {data.recent!.map((r) => <option key={r.runName} value={r.runName}>{r.runName}{r.version ? ` · ${r.version}` : ''}</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="text-sm">{data.summary.text}</div>
        {data.goal && <div className="text-xs text-muted-foreground">{data.goal.line}</div>}
        {data.legacy && <div className="text-[11px] text-muted-foreground">这一轮在验收卡上线（v0.11.0）之前跑的：只有「做完没」是机器补的，其余几格当时没人填，不是漏了。</div>}
        {onOpenRaw && (
          <button type="button" onClick={onOpenRaw} className="w-fit text-[11px] text-muted-foreground underline-offset-2 hover:underline">
            看底稿（机器证据全文）
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5" data-testid="acceptance-cards-filter">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            data-testid={`acceptance-cards-filter-${f.key}`}
            className={cn('rounded-full border px-3 py-1 text-xs', active === f.key ? 'border-primary bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted/50')}
          >
            {f.label} {counts[f.key]}
          </button>
        ))}
      </div>

      {data.empty && <div className="text-sm text-muted-foreground">{data.empty}</div>}
      <div className="grid gap-2" data-testid="acceptance-cards-list">
        {shown.map((c) => <CardView key={c.req} card={c} act={act} busy={busy} />)}
        {!shown.length && !data.empty && <div className="py-6 text-center text-sm text-muted-foreground">这一栏没有卡片</div>}
      </div>
    </div>
  )
}

// 侧栏「验收台」：不用先找到任务档案——打开就是最近一轮守航的卡片（可切到前几轮）。
export function AcceptanceDeskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[94svh] w-[calc(100%-1rem)] max-w-[calc(100%-1rem)] gap-0 overflow-hidden p-0 sm:max-w-4xl lg:max-w-5xl" data-testid="acceptance-desk-dialog">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>验收台</DialogTitle>
          <DialogDescription>先看「要我处理」；每张卡点开才看细节。按钮点了会真的推动流水线。</DialogDescription>
        </DialogHeader>
        <div className="max-h-[84svh] overflow-y-auto overflow-x-hidden p-3 sm:p-4">{open && <AcceptanceCards />}</div>
      </DialogContent>
    </Dialog>
  )
}
