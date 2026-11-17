import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

// 小呆呆巡检雷达：叠在他头像上的光环 + 向四周扩散的涟漪（样式与关键帧在 index.css）。
// ★ 四态严格对应引擎的真实动作（2026-08-20 老板反馈「状态完全跟实际动作对不上」后重定）：
//   off       打烊（patrolEnabled=false）→ 不渲染
//   countdown 巡逻倒计时：引擎一动不动，等下一跳定时扫描 → 只有极慢光环，**不放涟漪**
//   sweeping  巡逻中：刚跑完一轮 sweepIdleStops（SSE patrol-sweep）→ 单道快波，1.6s 回执后回落
//   handling  处置中：真派出去了、他有在跑的 run（/api/patrol-status 的 active）→ 大波连绵
// 纯装饰、不可交互：aria-hidden + pointer-events-none，绝不挡住头像的「看详情」点击。
export type PatrolPhase = 'off' | 'countdown' | 'sweeping' | 'handling'

export function PatrolRadar({ phase, className }: { phase: PatrolPhase; className?: string }) {
  if (phase === 'off') return null
  return (
    <span
      aria-hidden
      data-phase={phase}
      data-testid="patrol-radar"
      className={cn('pointer-events-none absolute', className)}
    >
      <span className="patrol-aura" />
      <span className="patrol-ripple">
        <i />
        <i />
        <i />
      </span>
    </span>
  )
}

// 倒计时文案自带 1s 心跳：nextSweepAt 是绝对时间戳，只按它渲染、自己不累计（多端一致、刷新不漂）。
// 单独抽成组件是为了让这颗 1s 定时器只重渲染这一个 <span>，不带着整条员工列表每秒重渲。
// 不足 1 分钟按秒走字——你把巡逻间隔调到 1 分钟时，分钟取整会让文案永远停在「即将巡逻」，那正是老板撞到的坑。
export function PatrolCountdown({ nextSweepAt }: { nextSweepAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  if (!nextSweepAt) return <>巡逻倒计时</>
  const left = Math.max(0, nextSweepAt - now)
  if (left < 60_000) return <>巡逻倒计时 · 剩 {Math.ceil(left / 1000)} 秒</>
  return <>巡逻倒计时 · 剩 {Math.round(left / 60_000)} 分</>
}
