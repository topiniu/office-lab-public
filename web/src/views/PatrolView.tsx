import { useMemo } from 'react'
import { ShieldCheckIcon, ArrowRightIcon } from '@phosphor-icons/react'

import { usePoll } from '@/hooks/use-poll'
import { useSseEvent } from '@/components/sse-provider'
import { useEmployees, employeeName } from '@/hooks/use-employees'
import { useRunDetail } from '@/components/run-detail-provider'
import { clockTime } from '@/lib/format'
import type { Conversation, Run } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type PatrolStatus = {
  enabled: boolean
  sweepMin: number
  graceSec: number
  active: boolean
  activeCount: number
  checking: string | null
  nextSweepAt?: number
}

const PATROL = 'chaorenq'
const PATROL_KIND: Record<string, string> = {
  dispatch: '派工', chat: '对话', call: '接棒', return: '交回', cc: '受阅', blocked: '拦截', meeting: '会议',
}
function nextSweepIn(at: number): string {
  const s = Math.max(0, Math.round((at - Date.now()) / 1000))
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}分`
}

export default function PatrolView() {
  const { data: status, refresh: refreshStatus } = usePoll<PatrolStatus>('/api/patrol-status', 10000)
  const { data: convos, refresh } = usePoll<Conversation[]>('/api/conversations?limit=500')
  const { data: runs } = usePoll<Run[]>('/api/runs', 15000)
  const { employees } = useEmployees()
  const { open: openRun } = useRunDetail()

  // 点巡查记录：优先消息自带 toRunId；否则找时间最接近的 chaorenq run
  function pickRun(c: Conversation): string | undefined {
    if (c.toRunId) return c.toRunId
    const t = Date.parse(c.ts) || 0
    let best: Run | undefined
    let bestDelta = Infinity
    for (const r of runs ?? []) {
      if (r.employee !== PATROL) continue
      const d = Math.abs(t - (Date.parse(r.startedAt || '') || 0))
      if (d < bestDelta) {
        bestDelta = d
        best = r
      }
    }
    return best?.id
  }

  useSseEvent(
    ['patrol-detected', 'patrol-escalate', 'patrol-resume', 'patrol-pending', 'patrol-cancelled'],
    () => {
      refresh()
      refreshStatus()
    },
  )

  const rows = useMemo(
    () =>
      (convos ?? [])
        .filter((c) => c.from === PATROL || c.to === PATROL)
        .slice()
        .reverse(),
    [convos],
  )

  return (
    <div className="grid gap-4 p-2.5 pb-24 md:p-4 md:pb-4">
      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheckIcon weight="fill" className="size-5 text-primary" />
            巡视员 · {employeeName(employees, PATROL)}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          {status ? (
            <>
              <Badge variant={status.enabled ? 'default' : 'secondary'}>
                {status.enabled ? '巡查开启' : '巡查关闭'}
              </Badge>
              <Badge variant="outline">扫描 {status.sweepMin} 分钟</Badge>
              <Badge variant="outline">宽限 {status.graceSec} 秒</Badge>
              {status.nextSweepAt && !status.active && (
                <Badge variant="outline">下次扫描 {nextSweepIn(status.nextSweepAt)}</Badge>
              )}
              {status.active && <Badge>正在巡查 {employeeName(employees, status.checking ?? '') || ''}</Badge>}
            </>
          ) : (
            <span className="text-muted-foreground">加载中…</span>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">巡查记录</h2>
        {rows.length === 0 && (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            暂无巡查记录
          </div>
        )}
        {rows.map((c, i) => (
          <button
            key={`${c.ts}-${i}`}
            onClick={() => {
              const id = pickRun(c)
              if (id) openRun(id)
            }}
            className="grid gap-1 rounded-lg border p-3 text-start hover:border-primary/50"
          >
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="font-medium">{employeeName(employees, c.from)}</span>
              <ArrowRightIcon className="size-3 text-muted-foreground" />
              <span className="font-medium">{employeeName(employees, c.to)}</span>
              <Badge variant="secondary" className="ms-1">{PATROL_KIND[c.kind] ?? c.kind}</Badge>
              <span className="ms-auto text-muted-foreground">{clockTime(c.ts)}</span>
            </div>
            <p className="line-clamp-3 text-sm text-muted-foreground">{c.text}</p>
          </button>
        ))}
      </div>
    </div>
  )
}
