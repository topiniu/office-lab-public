import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { usePoll } from '@/hooks/use-poll'
import { useSseEvent } from '@/components/sse-provider'
import type { Run } from '@/lib/types'

// enabled / nextSweepAt 都是 /api/patrol-status 一直在发的字段，之前这里没声明 → 侧栏表达不出「打烊」态
// 也说不出「下次 ~N 分」（旧 UI 的 patrolState 用的就是这两个）。
type PatrolStatus = {
  enabled?: boolean
  active: boolean
  activeCount?: number
  checking: string | null
  nextSweepAt?: number
  lastSweepAt?: number
  lastSweep?: { scanned: number; candidates: number; spawned: number } | null
}
type Ctx = {
  runs: Run[] | undefined
  pending: Record<string, unknown[]> | undefined
  patrol: PatrolStatus | undefined
  patrolBurst: boolean
  // 「刚扫过一轮」的瞬时态（SSE patrol-sweep 点亮、1.6s 后自灭），含本轮战果供副标题显示
  patrolSweeping: { scanned: number; spawned: number } | null
}

const EmployeeStatusContext = createContext<Ctx>({
  runs: undefined,
  pending: undefined,
  patrol: undefined,
  patrolBurst: false,
  patrolSweeping: null,
})

// 员工状态数据源，全站顶层常驻（不随侧栏/移动端抽屉挂载）。
// 之前 runs/pending/patrol 的轮询写在 EmployeeRail 里，而移动端侧栏是关闭即卸载的 Sheet，
// 导致「必须先打开抽屉才开始拉状态」。上移到此后：网页一加载就开始拉、并订阅 SSE 即时刷新。
export function EmployeeStatusProvider({ children }: { children: ReactNode }) {
  const runsP = usePoll<Run[]>('/api/runs', 10000)
  const pendingP = usePoll<Record<string, unknown[]>>('/api/pending', 12000)
  const patrolP = usePoll<PatrolStatus>('/api/patrol-status', 10000)

  // 实时：run 状态/后台/删除/交接/入队等事件即时刷新（与 RunsView 同口径），不必等下一轮询。
  // 不订阅高频的 run-activity（那是活动文案、非状态点，靠轮询兜底即可）。
  useSseEvent(
    ['run-status', 'run-bg', 'run-bg-settled', 'run-deleted', 'handoff', 'run-queued', 'run-title'],
    () => runsP.refresh(),
  )
  useSseEvent(
    ['patrol-pending', 'patrol-cancelled', 'patrol-resume', 'patrol-detected', 'patrol-escalate'],
    () => patrolP.refresh(),
  )
  // 待办（等你拍板）数量：权限请求/解决时刷新
  useSseEvent(['permission-request', 'permission-resolved'], () => pendingP.refresh())

  // 「处置中」burst（对齐旧 UI patrolBurst）：真派巡视的那一刻立刻放 5s 大波，不等轮询。
  // 为什么必须有：一次巡查的 active 窗口往往只有几秒，10s 轮询大概率整段错过 → 动画永远不亮。
  const [patrolBurst, setPatrolBurst] = useState(false)
  const burstT = useRef<number | null>(null)
  useSseEvent(['patrol-detected', 'patrol-resume', 'patrol-escalate'], () => {
    setPatrolBurst(true)
    if (burstT.current) window.clearTimeout(burstT.current)
    burstT.current = window.setTimeout(() => setPatrolBurst(false), 5000)
  })

  // 「巡逻中」那一跳：引擎每跑完一轮定时扫描就广播 patrol-sweep（微秒级动作，这里放 1.6s 回执动画）。
  // 没有这个事件，前端只能表达「倒计时 / 处置中」，中间「他确实巡了一轮、只是啥也没捞到」完全不可见。
  const [patrolSweeping, setPatrolSweeping] = useState<{ scanned: number; spawned: number } | null>(null)
  const sweepT = useRef<number | null>(null)
  useSseEvent('patrol-sweep', (ev) => {
    const e = ev as unknown as { scanned?: number; spawned?: number }
    setPatrolSweeping({ scanned: Number(e.scanned) || 0, spawned: Number(e.spawned) || 0 })
    patrolP.refresh() // 顺延后的 nextSweepAt 立刻取回，倒计时不等下一轮轮询才归位
    if (sweepT.current) window.clearTimeout(sweepT.current)
    sweepT.current = window.setTimeout(() => setPatrolSweeping(null), 1600)
  })

  useEffect(
    () => () => {
      if (burstT.current) window.clearTimeout(burstT.current)
      if (sweepT.current) window.clearTimeout(sweepT.current)
    },
    [],
  )

  return (
    <EmployeeStatusContext.Provider
      value={{
        runs: runsP.data,
        pending: pendingP.data,
        patrol: patrolP.data,
        patrolBurst,
        patrolSweeping,
      }}
    >
      {children}
    </EmployeeStatusContext.Provider>
  )
}

export function useEmployeeStatus() {
  return useContext(EmployeeStatusContext)
}
