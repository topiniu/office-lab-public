import { CaretRightIcon, CheckCircleIcon, XCircleIcon, TestTubeIcon, BellRingingIcon, EyeIcon, ClockIcon, CrosshairIcon, WarningCircleIcon } from '@phosphor-icons/react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { CopyMessage } from '@/components/copy-message'
import { UserContent } from '@/components/message-content'
import { cn } from '@/lib/utils'
import type { SystemNotice, E2eCase } from '@/lib/system-notice'

// 系统唤起消息的卡片形态：人只需一眼看到「什么事 + 结果 + 接下来」，
// 写给 AI 的操作指令（工具名/SOP 条款/红线）收进底部「给员工的完整指令」。
export function SystemNoticeCard({ notice, raw }: { notice: SystemNotice; raw: string }) {
  return (
    <div className="flex min-w-0 justify-end" data-testid="system-notice-card">
      <div className="w-full max-w-[85%] min-w-0 overflow-hidden rounded-xl border bg-card">
        {notice.kind === 'e2e-batch' ? <E2eBody n={notice} /> : <GenericBody n={notice} />}
        <RawFold raw={raw} />
      </div>
    </div>
  )
}

function Head({ icon, title, meta, tone = 'muted' }: { icon: React.ReactNode; title: string; meta?: string; tone?: 'ok' | 'bad' | 'muted' }) {
  return (
    <div className="flex min-w-0 items-center gap-2 px-3 pt-2.5 pb-2">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full [&>svg]:size-3.5',
          tone === 'ok' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
          tone === 'bad' && 'bg-destructive/10 text-destructive',
          tone === 'muted' && 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 truncate text-sm font-medium">{title}</span>
      {meta && <span className="ms-auto shrink-0 font-mono text-[11px] text-muted-foreground">{meta}</span>}
    </div>
  )
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'bad' }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] whitespace-nowrap',
        tone === 'ok' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        tone === 'bad' && 'bg-destructive/10 text-destructive',
        !tone && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

function E2eBody({ n }: { n: Extract<SystemNotice, { kind: 'e2e-batch' }> }) {
  // RED 校准件（-RED.json）故意带错误预期，红=护栏有效：单独成组、不计入通过/未通过，只有异常才标红
  const normalCases = n.cases.filter((c) => !c.calibration)
  const calCases = n.cases.filter((c) => c.calibration)
  const calBad = n.calTotal - n.calOk
  const allGreen = n.red === 0 && calBad === 0 && (n.green > 0 || n.calOk > 0)
  const next: string[] = []
  if (n.red) next.push(`修复 ${n.red} 个红件后重跑`)
  if (calBad) next.push(`处理 ${calBad} 个异常 RED 校准`)
  if (n.scanCount) next.push(`页面巡检 ${n.scanCount} 个绿件`)
  if (n.green) next.push('覆盖率机签')
  return (
    <>
      <Head icon={<TestTubeIcon weight="bold" />} title={n.title} meta={n.batchId} tone={n.red || calBad ? 'bad' : allGreen ? 'ok' : 'muted'} />
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5">
        {(normalCases.length > 0 || !n.calTotal) && (
          <>
            <Pill tone="ok">通过 {n.green}</Pill>
            <Pill tone={n.red ? 'bad' : undefined}>未通过 {n.red}</Pill>
          </>
        )}
        {n.calTotal > 0 && (
          <Pill tone="ok">
            <CrosshairIcon className="size-3" />
            {n.calLegacy ? `RED 红 ${n.calOk}/${n.calTotal}（未判类型）` : `RED 如期红 ${n.calOk}/${n.calTotal}`}
          </Pill>
        )}
        {calBad > 0 && <Pill tone="bad">RED 异常 {calBad}</Pill>}
        <Pill>{n.total} 个用例 · 并发 {n.concurrency}</Pill>
        <Pill><ClockIcon className="size-3" />{n.minutes} 分钟</Pill>
      </div>
      {normalCases.length > 0 && (
        <ul className="grid gap-px border-t bg-border/40">
          {normalCases.map((c, i) => <CaseRow key={i} c={c} />)}
        </ul>
      )}
      {calCases.length > 0 && (
        <>
          <div className="border-t px-3 pt-1.5 pb-1 text-[11px] text-muted-foreground">RED 校准 · 故意带错误预期，红 = 护栏有效</div>
          <ul className="grid gap-px bg-border/40">
            {calCases.map((c, i) => <CaseRow key={i} c={c} />)}
          </ul>
        </>
      )}
      {next.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-3 py-2 text-[11px] text-muted-foreground">
          <span>接下来</span>
          {next.map((s) => (
            <span key={s} className="inline-flex h-5 items-center gap-1 rounded-full border px-2">
              {s.startsWith('页面巡检') && <EyeIcon className="size-3" />}
              {s}
            </span>
          ))}
        </div>
      )}
    </>
  )
}

function CaseRow({ c }: { c: E2eCase }) {
  // 用例名只显文件名，目录（版本夹）弱化在前——窄窗里文件名才是要认的那部分
  const slash = c.label.lastIndexOf('/')
  const dir = slash >= 0 ? c.label.slice(0, slash + 1) : ''
  const file = slash >= 0 ? c.label.slice(slash + 1) : c.label
  const detail = c.error || c.failure
  return (
    <li className="grid min-w-0 gap-0.5 bg-card px-3 py-1.5" title={c.session ? `session: ${c.session}` : undefined}>
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        {c.calibration ? (
          c.ok ? (
            <CrosshairIcon weight="bold" className="size-3.5 shrink-0 text-emerald-500" />
          ) : (
            <WarningCircleIcon weight="fill" className="size-3.5 shrink-0 text-destructive" />
          )
        ) : c.ok ? (
          <CheckCircleIcon weight="fill" className="size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <XCircleIcon weight="fill" className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="min-w-0 truncate">
          <span className="text-muted-foreground/70">{dir}</span>
          {file}
        </span>
        {c.calibration && c.verdict && (
          <span className={cn('ms-auto shrink-0 text-[11px]', c.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive/80')}>{c.verdict}</span>
        )}
        {!c.calibration && !c.ok && c.status && <span className="ms-auto shrink-0 text-[11px] text-destructive/80">{c.status}</span>}
      </span>
      {detail && <span className="line-clamp-2 ps-5 text-[11px] text-muted-foreground">{detail}</span>}
    </li>
  )
}

function GenericBody({ n }: { n: Extract<SystemNotice, { kind: 'generic' }> }) {
  const bad = /异常|失败|错误/.test(n.title)
  return (
    <>
      <Head icon={bad ? <XCircleIcon weight="bold" /> : <BellRingingIcon weight="bold" />} title={n.title} tone={bad ? 'bad' : 'muted'} />
      {n.summary && <p className="line-clamp-3 px-3 pb-2.5 text-xs text-muted-foreground">{n.summary}</p>}
    </>
  )
}

function RawFold({ raw }: { raw: string }) {
  return (
    <Collapsible className="group/raw border-t">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <CaretRightIcon className="size-2.5 transition-transform group-data-[state=open]/raw:rotate-90" />
          给员工的完整指令
        </CollapsibleTrigger>
        <CopyMessage text={raw} className="ms-auto" />
      </div>
      <CollapsibleContent>
        <div className="max-h-72 overflow-auto border-t bg-muted/30 px-3 py-2 text-xs">
          <UserContent text={raw} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
