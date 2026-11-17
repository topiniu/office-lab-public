import { PulseIcon } from '@phosphor-icons/react'
import { usePoll } from '@/hooks/use-poll'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Health } from '@/lib/types'

export function HealthPill() {
  const { data } = usePoll<Health>('/api/health', 10000)
  if (!data) return null
  const { runs, memoryMB, version, uptimeSec } = data
  const hours = Math.floor(uptimeSec / 3600)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={runs.live > 0 ? 'default' : 'secondary'} className="gap-1.5">
          <PulseIcon weight="bold" className="size-3.5" />
          {runs.live} 在跑 · {runs.total} 总
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <div className="text-xs">
          <div>版本 {version}</div>
          <div>运行时长 {hours}h</div>
          <div>内存 {memoryMB.rss}MB</div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
