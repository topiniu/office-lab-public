import { useEffect, useMemo, useState } from 'react'
import { ArrowRightIcon, ArrowsClockwiseIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { usePoll } from '@/hooks/use-poll'
import { useSseEvent } from '@/components/sse-provider'
import { useEmployees, employeeName } from '@/hooks/use-employees'
import { useRunDetail } from '@/components/run-detail-provider'
import { clockTime, relTime } from '@/lib/format'
import { apiGet, apiPost } from '@/lib/api'
import type { Conversation, SseEvent } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { EmployeeAvatar } from '@/components/employee-avatar'
import { Label } from '@/components/ui/label'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import type { BadgeVariant } from '@/lib/status'

const KIND_LABEL: Record<string, string> = {
  dispatch: '派工',
  chat: '对话',
  call: '接棒',
  return: '交回',
  cc: '受阅',
  blocked: '拦截',
  meeting: '会议',
}
function kindVariant(kind: string): BadgeVariant {
  if (kind === 'blocked') return 'destructive'
  if (kind === 'dispatch' || kind === 'call') return 'default'
  return 'secondary'
}

export default function ConversationsView() {
  const { data, refresh } = usePoll<Conversation[]>('/api/conversations?limit=300')
  const { employees } = useEmployees()
  const { open: openRun } = useRunDetail()
  const [rows, setRows] = useState<Conversation[]>([])
  const [chain, setChain] = useState<boolean | null>(null)

  useEffect(() => {
    if (data) setRows(data)
  }, [data])
  useEffect(() => {
    apiGet<{ enabled: boolean }>('/api/chain-config').then((c) => setChain(!!c.enabled)).catch(() => {})
  }, [])
  useSseEvent('conversation', (ev: SseEvent) =>
    setRows((rs) => [...rs, ev as unknown as Conversation].slice(-500)),
  )

  const threads = useMemo(() => {
    const map = new Map<string, Conversation[]>()
    for (const c of rows) {
      const k = c.threadRootId || c.ts
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(c)
    }
    const arr = [...map.entries()].map(([id, msgs]) => {
      const who = new Set<string>()
      for (const c of msgs) {
        if (c.fromKind === 'employee') who.add(c.from)
        if (employees[c.to]) who.add(c.to)
      }
      return {
        id,
        msgs,
        first: msgs[0],
        last: msgs[msgs.length - 1],
        participants: [...who],
      }
    })
    arr.sort((a, b) => (b.last?.ts || '').localeCompare(a.last?.ts || ''))
    return arr
  }, [rows, employees])

  const name = (kind: string, who: string) =>
    kind === 'user' ? '老板' : kind === 'wecom' ? `企微·${who}` : employeeName(employees, who)

  async function toggleChain(v: boolean) {
    setChain(v)
    try {
      const cur = await apiGet<Record<string, unknown>>('/api/chain-config')
      await apiPost('/api/chain-config', { ...cur, enabled: v })
      toast.success(v ? '已开启自动接棒' : '已关闭自动接棒')
    } catch (e) {
      toast.error('保存失败', { description: (e as Error).message })
    }
  }

  return (
    <div className="grid gap-3 p-2.5 pb-24 md:p-4 md:pb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{threads.length} 个会话线程</p>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => refresh()}>
            <ArrowsClockwiseIcon /> 刷新
          </Button>
          {chain != null && (
            <label className="flex items-center gap-2 text-sm">
              <Label htmlFor="chain-sw" className="cursor-pointer text-muted-foreground">自动接棒</Label>
              <Switch id="chain-sw" checked={chain} onCheckedChange={toggleChain} />
            </label>
          )}
        </div>
      </div>
      {threads.length === 0 && (
        <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无会话线程
        </div>
      )}

      <Accordion type="multiple" defaultValue={threads.slice(0, 2).map((t) => t.id)}>
        {threads.map((t) => (
          <AccordionItem key={t.id} value={t.id}>
            {/* 窄屏折成两行：第一行头像 + 首句（truncate），第二行「N 条 · 多久前」。
                原来三样挤一行，390px 上首句把条数/时间整个推出视口（连折叠箭头都被顶到屏幕外）。 */}
            <AccordionTrigger className="py-2.5 md:py-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1 text-start md:flex-row md:items-center md:gap-2 md:pe-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex shrink-0 -space-x-1.5">
                    {t.participants.slice(0, 4).map((k) => (
                      <EmployeeAvatar key={k} employee={employees[k]} fallback={k} className="size-5 ring-2 ring-background" />
                    ))}
                  </span>
                  <span className="truncate text-sm">{t.first?.text || t.last?.text || '(空)'}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground md:ms-auto">
                  {t.msgs.length} 条 · {relTime(t.last?.ts)}
                </span>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-2">
                {t.msgs.map((c, i) => (
                  <button
                    key={`${c.ts}-${i}`}
                    onClick={() => c.toRunId && openRun(c.toRunId)}
                    className="grid gap-1 rounded-lg border p-3 text-start hover:border-primary/50"
                  >
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="font-medium">{name(c.fromKind, c.from)}</span>
                      <ArrowRightIcon className="size-3 text-muted-foreground" />
                      <span className="font-medium">{employeeName(employees, c.to)}</span>
                      <Badge variant={kindVariant(c.kind)} className="ms-1">
                        {KIND_LABEL[c.kind] ?? c.kind}
                      </Badge>
                      <span className="ms-auto text-muted-foreground">{clockTime(c.ts)}</span>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {c.text}
                    </p>
                  </button>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  )
}
