import { useEffect, useRef, useState } from 'react'
import {
  PlusIcon,
  ArrowLeftIcon,
  StopIcon,
  TrashIcon,
  PaperPlaneRightIcon,
} from '@phosphor-icons/react'
import { toast } from 'sonner'

import { usePoll } from '@/hooks/use-poll'
import { useSseEvent } from '@/components/sse-provider'
import { useEmployees } from '@/hooks/use-employees'
import { apiPost, apiDelete, ApiError } from '@/lib/api'
import { clockTime, relTime } from '@/lib/format'
import type { Meeting } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmployeeAvatar } from '@/components/employee-avatar'

const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  stopped: '已结束',
  interrupted: '已中断',
  done: '已完成',
}

export default function MeetingView() {
  const { data, refresh } = usePoll<{ meetings: Meeting[]; active: boolean }>('/api/meetings', 12000)
  const [openId, setOpenId] = useState<string | null>(null)
  useSseEvent(['meeting-status', 'meeting-deleted'], () => refresh())

  const meetings = data?.meetings ?? []
  const current = meetings.find((m) => m.id === openId) || null

  if (current) return <MeetingRoom meeting={current} onBack={() => setOpenId(null)} onChanged={refresh} />

  return (
    <div className="grid gap-4 p-2.5 pb-24 md:p-4 md:pb-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{meetings.length} 场会议</p>
        <CreateMeeting onCreated={refresh} disabled={data?.active} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {meetings.map((m) => (
          <MeetingCard key={m.id} m={m} onOpen={() => setOpenId(m.id)} />
        ))}
        {meetings.length === 0 && (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground sm:col-span-2 xl:col-span-3">
            还没有会议
          </div>
        )}
      </div>
    </div>
  )
}

function MeetingCard({ m, onOpen }: { m: Meeting; onOpen: () => void }) {
  const { employees } = useEmployees()
  return (
    <Card className="cursor-pointer gap-2 transition-colors hover:border-primary/50" onClick={onOpen}>
      <CardHeader className="gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-muted-foreground">
            No.{String(m.seq ?? 0).padStart(3, '0')}
          </span>
          <Badge variant={m.status === 'running' ? 'default' : 'secondary'}>
            {STATUS_LABEL[m.status] ?? m.status}
          </Badge>
        </div>
        <CardTitle className="line-clamp-2 text-sm leading-snug">{m.topic}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2">
        <div className="flex -space-x-2">
          {m.participants.slice(0, 6).map((k) => (
            <EmployeeAvatar key={k} employee={employees[k]} fallback={k} className="size-6 ring-2 ring-background" />
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{relTime(m.startedAt)}</span>
      </CardContent>
    </Card>
  )
}

function CreateMeeting({ onCreated, disabled }: { onCreated: () => void; disabled?: boolean }) {
  const { employees } = useEmployees()
  const keys = Object.keys(employees)
  const [open, setOpen] = useState(false)
  const [topic, setTopic] = useState('')
  const [focusVersion, setFocusVersion] = useState('')
  const [participants, setParticipants] = useState<string[]>(keys)
  const [chair, setChair] = useState(keys[0] ?? '')
  const [rounds, setRounds] = useState(3)

  useEffect(() => {
    if (open && keys.length && participants.length === 0) setParticipants(keys)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function submit() {
    if (!topic.trim()) return toast.error('请填写议题')
    try {
      await apiPost('/api/meetings', {
        topic: topic.trim(),
        focusVersion: focusVersion.trim() || undefined,
        participants,
        chair,
        rounds,
      })
      toast.success('会议已发起')
      setOpen(false)
      setTopic('')
      onCreated()
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) toast.error('已有进行中的会议')
      else toast.error('发起失败', { description: (e as Error).message })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled} title={disabled ? '已有进行中的会议' : undefined}>
          <PlusIcon weight="bold" /> 发起会议
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>发起会议</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label>议题</Label>
            <Textarea value={topic} onChange={(e) => setTopic(e.target.value)} className="min-h-16" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>聚焦版本（可选）</Label>
              <Input value={focusVersion} onChange={(e) => setFocusVersion(e.target.value)} placeholder="v5.17" />
            </div>
            <div className="grid gap-2">
              <Label>轮数</Label>
              <Select value={String(rounds)} onValueChange={(v) => setRounds(Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5].map((r) => (
                    <SelectItem key={r} value={String(r)}>{r} 轮</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>参会人</Label>
            <div className="flex flex-wrap gap-3">
              {keys.map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={participants.includes(k)}
                    onCheckedChange={(c) =>
                      setParticipants((p) => (c ? [...p, k] : p.filter((x) => x !== k)))
                    }
                  />
                  {employees[k].displayName}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-2">
            <Label>主持人</Label>
            <Select value={chair} onValueChange={setChair}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {participants.map((k) => (
                  <SelectItem key={k} value={k}>{employees[k]?.displayName ?? k}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={submit}>发起</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Speech = { speaker: string; displayName?: string; role?: string; text: string; round?: number; ts?: string }

function MeetingRoom({
  meeting,
  onBack,
  onChanged,
}: {
  meeting: Meeting
  onBack: () => void
  onChanged: () => void
}) {
  const { employees } = useEmployees()
  const [speeches, setSpeeches] = useState<Speech[]>([])
  const [speaking, setSpeaking] = useState<string | null>(meeting.speaking)
  const [reply, setReply] = useState('')
  const roundRef = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  // 「谁在发言」是全局广播（非本会议流），按 meetingId 过滤
  useSseEvent('meeting-speaking', (ev) => {
    if (ev.meetingId === meeting.id) setSpeaking(String(ev.speaker ?? '') || null)
  })
  useSseEvent(['meeting-status'], (ev) => {
    if (ev.meetingId === meeting.id) onChanged()
  })

  useEffect(() => {
    setSpeeches([])
    roundRef.current = 0
    const es = new EventSource(`/api/meetings/${meeting.id}/events`)
    es.onmessage = (e) => {
      let ev: any
      try {
        ev = JSON.parse(e.data)
      } catch {
        return
      }
      if (ev.type === 'round') {
        roundRef.current = Number(ev.round) || roundRef.current
        return
      }
      if (ev.type === 'meeting-end') {
        onChanged()
        return
      }
      if (ev.type === 'speech' && ev.text) {
        setSpeaking(null)
        setSpeeches((s) => [
          ...s,
          {
            speaker: String(ev.speaker ?? ''),
            displayName: ev.displayName,
            role: ev.role,
            text: String(ev.text),
            round: roundRef.current || undefined,
            ts: ev._ts,
          },
        ])
      }
    }
    return () => es.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [speeches, speaking])

  const live = meeting.status === 'running'

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn()
      toast.success(ok)
      onChanged()
    } catch (e) {
      toast.error('操作失败', { description: (e as Error).message })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="返回">
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{meeting.topic}</div>
          <div className="text-xs text-muted-foreground">
            {STATUS_LABEL[meeting.status]} · {meeting.rounds} 轮 · 主持 {employees[meeting.chair]?.displayName ?? meeting.chair}
          </div>
        </div>
        {live && (
          <Button variant="ghost" size="icon" onClick={() => act(() => apiPost(`/api/meetings/${meeting.id}/stop`), '已结束')} aria-label="结束" title="结束会议">
            <StopIcon />
          </Button>
        )}
        <Button variant="ghost" size="icon" onClick={() => act(() => apiDelete(`/api/meetings/${meeting.id}`).then(onBack), '已删除')} aria-label="删除" title="删除">
          <TrashIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto grid max-w-3xl gap-3">
          {speeches.map((s, i) => {
            const prevRound = i > 0 ? speeches[i - 1].round : undefined
            const showDivider = s.round != null && s.round !== prevRound
            const name = s.displayName || employees[s.speaker]?.displayName || s.speaker
            return (
              <div key={i} className="grid gap-2">
                {showDivider && (
                  <div className="my-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="h-px flex-1 bg-border" />第 {s.round} 轮
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
                <div className="flex gap-2">
                  <EmployeeAvatar employee={employees[s.speaker]} fallback={name} className="size-8" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{name}</span>
                      {s.role && <Badge variant="outline">{s.role}</Badge>}
                      {s.ts && <span>{clockTime(s.ts)}</span>}
                    </div>
                    <p className="mt-1 text-sm whitespace-pre-wrap break-words">{s.text}</p>
                  </div>
                </div>
              </div>
            )
          })}
          {speaking && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <EmployeeAvatar employee={employees[speaking]} fallback={speaking} className="size-6" />
              {employees[speaking]?.displayName ?? speaking} 正在发言…
            </div>
          )}
          {speeches.length === 0 && !speaking && (
            <p className="py-8 text-center text-sm text-muted-foreground">连接会议中…</p>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {live && (
        <div className="border-t p-3">
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <Textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder="老板插话…"
              className="min-h-11 resize-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (reply.trim()) {
                    apiPost(`/api/meetings/${meeting.id}/reply`, { message: reply.trim() })
                      .then(() => setReply(''))
                      .catch((err) => toast.error('发送失败', { description: (err as Error).message }))
                  }
                }
              }}
            />
            <Button
              size="icon"
              disabled={!reply.trim()}
              onClick={() =>
                apiPost(`/api/meetings/${meeting.id}/reply`, { message: reply.trim() })
                  .then(() => setReply(''))
                  .catch((err) => toast.error('发送失败', { description: (err as Error).message }))
              }
              aria-label="发送"
            >
              <PaperPlaneRightIcon weight="fill" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
