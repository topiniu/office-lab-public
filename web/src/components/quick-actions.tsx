// 聊天窗快捷动作按钮（组合器工具条里）。
//
// 缘起（2026-08-26 老板提）：A1 需求巡航按拍板定为「只给工具、不自动触发」，但**触发口一直没有**——
// 老板得自己打一段「去跑一轮需求巡航」，每次措辞还不一样，等于把 SOP 的执行质量押在临场打字上。
// 一个按钮解决：点一次 = 发一段引擎写好的完整指令。
//
// ★ 指令文本**不在本文件**，在引擎的 `QUICK_ACTIONS`（`GET /api/quick-actions?employee=`）。
//   同 `guardedColdStartInstruction` 的理由：prompt 是行为契约的一部分，散到前端就会出现
//   「同一件事两处措辞、改了一处忘另一处」。这里只负责渲染按钮 + 把 instruction 原样交回去发。
import { useEffect, useState } from 'react'
import { CompassIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { apiGet } from '@/lib/api'

export type QuickAction = { id: string; label: string; title: string; instruction: string }

// 按 action.id 选图标；没登记的用默认。图标留在前端是对的——它是纯展示，不属于行为契约。
const ICONS: Record<string, typeof CompassIcon> = { 'pool-scan': CompassIcon }

export function QuickActions({
  employee,
  disabled,
  guarded,
  onRun,
}: {
  employee: string
  disabled?: boolean
  /** 当前会话是否守航态。守航态里不给按——理由见下方 blockedWhy。 */
  guarded?: boolean
  /** 交回整段指令，由调用方走它自己的 send()（复用草稿建 run / 409 降级等动线） */
  onRun: (instruction: string) => void | Promise<void>
}) {
  const [actions, setActions] = useState<QuickAction[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!employee) { setActions([]); return }
    apiGet<{ actions: QuickAction[] }>(`/api/quick-actions?employee=${encodeURIComponent(employee)}`)
      .then((r) => { if (alive) setActions(r.actions || []) })
      .catch(() => { if (alive) setActions([]) })   // 拿不到就不显示按钮：宁可少一个入口，也别显示一个点了没反应的
    return () => { alive = false }
  }, [employee])

  if (!actions.length) return null

  // 守航态会话里不给按。**这是实测抓出来的**：第一版在菲菲的聊天窗点了按钮，而那个窗口恰好是昨天
  // 一条守航冷启动会话（executionMode=guarded_run），于是「白天养池子」的指令被塞进了守航 session——
  // 指令自己第一句写着「这是白天的活，**不是守航**」，却和该会话已注入的 guardedRunPreamble 直接打架
  // （park-不-guess vs. 主动澄清、终点 RC_READY vs. 终点是问题卡）。两套规则同场，员工只能猜听谁的。
  // 不静默改模式、也不静默照发：**禁用 + 说清为什么 + 告诉他去哪按**。
  const blockedWhy = guarded
    ? '这条会话是守航态（无人值守），而巡航是白天的活——两套规则会打架。请新开一个与她的对话再点这个按钮。'
    : ''

  return (
    <>
      {actions.map((a) => {
        const Icon = ICONS[a.id] ?? CompassIcon
        const running = busy === a.id
        return (
          <Tooltip key={a.id}>
            <TooltipTrigger asChild>
              {/* 禁用态的 Button 不触发 pointer 事件 → tooltip 也不会出，等于「点不了还不告诉你为什么」。
                  套一层 span 承接悬浮，理由才说得出口。 */}
              <span className="inline-flex">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 shrink-0 gap-1 px-2 text-xs text-muted-foreground md:h-8"
                  disabled={disabled || !!busy || !!blockedWhy}
                  aria-label={a.label}
                  onClick={async () => {
                    setBusy(a.id)
                    try { await onRun(a.instruction) } finally { setBusy(null) }
                  }}
                >
                  {running ? <SpinnerGapIcon className="animate-spin" /> : <Icon />}
                  <span>{a.label}</span>
                </Button>
              </span>
            </TooltipTrigger>
            {/* 悬浮说明用 tooltip 而不是 title：这段话有点长，原生 title 要悬停一秒才出、还不换行 */}
            <TooltipContent side="top" className="max-w-80">
              {blockedWhy || a.title}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </>
  )
}
