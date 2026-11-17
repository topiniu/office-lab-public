import { useMemo } from 'react'
import { PaperPlaneRightIcon } from '@phosphor-icons/react'

import { usePoll } from '@/hooks/use-poll'
import { useEmployees } from '@/hooks/use-employees'
import { isLive } from '@/lib/status'
import { mostRecentRun, runSummary } from '@/lib/run-threads'
import type { Run } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { EmployeeAvatar } from '@/components/employee-avatar'
import { DispatchDialog } from '@/components/dispatch-dialog'
import { useEmployeeDetail } from '@/components/employee-detail'
import { useRunDetail } from '@/components/run-detail-provider'

export default function EmployeesView() {
  const { employees } = useEmployees()
  const { open: openDetail } = useEmployeeDetail()
  const { openChat } = useRunDetail()
  const { data: runs } = usePoll<Run[]>('/api/runs', 15000)

  const busy = useMemo(() => {
    const set = new Set<string>()
    // 只读咨询窗不算忙（它不占工作树、也不挡派工）——与侧栏状态点同口径
    for (const r of runs ?? []) if (isLive(r) && !r.consult) set.add(r.employee)
    return set
  }, [runs])

  const keys = Object.keys(employees)

  return (
    <div className="grid gap-3 p-2.5 pb-24 md:grid-cols-2 md:p-4 md:pb-4 xl:grid-cols-3">
      {keys.map((k) => {
        const e = employees[k]
        const isBusy = busy.has(k)
        return (
          <Card
            key={k}
            className="cursor-pointer gap-3 transition-colors hover:border-primary/50"
            onClick={() => openChat(k)}
            title="点击对话"
          >
            <CardHeader className="gap-0">
              {/* min-w-0：CardHeader 是 grid，栅格项默认 min-width:auto **不收缩** ——
                  里面的 truncate 因此从不生效，「最近：…」那行长文本会直接顶穿卡片右边界。 */}
              <div className="flex min-w-0 items-center gap-3">
                <EmployeeAvatar employee={e} className="size-10" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{e.displayName}</span>
                    <Badge variant={isBusy ? 'default' : 'secondary'}>
                      {isBusy ? '运行中' : '空闲'}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{e.title}</div>
                  {(() => {
                    const s = runSummary(mostRecentRun(runs, k), 48)
                    return s ? (
                      <div className="mt-0.5 truncate text-xs text-muted-foreground/80" title={s}>
                        最近：{s}
                      </div>
                    ) : null
                  })()}
                </div>
              </div>
            </CardHeader>
            <CardContent
              className="flex items-center justify-between gap-2"
              onClick={(ev) => ev.stopPropagation()}
            >
              <Badge variant="outline" className="font-mono text-[10px]">
                {e.permissionMode}
              </Badge>
              <div className="flex gap-1.5">
                {/* size=sm 只有 24px 高，触屏上是「看得见按不中」的典型；窄屏抬到 36px */}
                <Button size="sm" variant="ghost" className="h-9 px-3 md:h-6 md:px-2" onClick={() => openDetail(k)}>
                  详情
                </Button>
                <DispatchDialog
                  defaultEmployee={k}
                  trigger={
                    <Button size="sm" variant="outline" className="h-9 px-3 md:h-6 md:px-2">
                      <PaperPlaneRightIcon />
                      派工
                    </Button>
                  }
                />
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
