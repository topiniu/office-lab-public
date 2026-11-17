import type { Run } from './types'

// 某员工的会话：置顶优先 → 时间倒序（用于历史会话选择器列表）
export function employeeThreads(runs: Run[] | undefined, employee: string): Run[] {
  return (runs ?? [])
    .filter((r) => r.employee === employee)
    .sort(
      (a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
        (b.startedAt || '').localeCompare(a.startedAt || ''),
    )
}

// 某员工最近一次会话（纯按时间，忽略置顶）——用于「点员工开最近对话」「列表最近摘要」。
// 排除只读咨询窗：点员工要开的是正式会话，不该被上一次随手问话的只读窗顶掉（只读窗从会话切换器/放大镜入口进）。
export function mostRecentRun(runs: Run[] | undefined, employee: string): Run | undefined {
  return (runs ?? [])
    .filter((r) => r.employee === employee && !r.consult)
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0]
}

// 会话名：有标题用标题（自动命名/手动改名），否则退回摘要——列表里「这条会话叫什么」统一走它
export function runTitle(run: Run | undefined, max = 42): string {
  const t = run?.title?.trim()
  if (t) return t.length > max ? t.slice(0, max) + '…' : t
  return runSummary(run, max)
}

// 会话摘要：优先活动(live) → 结果尾 → 指令
export function runSummary(run: Run | undefined, max = 42): string {
  if (!run) return ''
  const raw = run.activity || run.result || run.instruction || ''
  const one = String(raw).replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}
