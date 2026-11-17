// 「守航推进」：从任意任务档案发起守航（v0.11.0 二期，老板 2026-09-29：「能不能任意档案、任意员工发起」）
//
// 勾这份档案里要推进的条目 → 引擎签一份**只授权这几条**的契约（frontmatter 直接写好 archive/version，
// 不再静默认领别的版本的契约，§22.8）→ 以守航态派给「负责人」。默认菲菲：推进一个需求第一步是摸清现状，
// 那是 PM 的活，她盘点完再决定第一棒交给谁（只差测试就直接交迷糊）。也可以指定直接从某位员工开工。
// 目标循环与验收卡挂在这份契约上：链停了没干完，引擎按「谁该做」接着派，直到每条的验收卡填满。
import { useEffect, useState } from 'react'
import { ShieldCheckIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useRunDetail } from '@/components/run-detail-provider'
import { apiGet, apiPost, ApiError } from '@/lib/api'

type ArchiveItem = { req: string; name: string; status: string; done: boolean }
type ArchiveItems = { file: string; version: string; task: string; items: ArchiveItem[] }

const STARTERS = [
  { key: 'feifei', label: '菲菲（负责人：先盘点现状，再决定交给谁）' },
  { key: 'mihu', label: '迷糊老师（直接从测试开工）' },
  { key: 'ggbond', label: 'GG Bond（直接从开发开工）' },
]

function defaultDeadline() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
function errText(e: unknown) {
  const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null
  return body?.error || (e as Error).message
}

export function GuardedArchiveDialog({
  open,
  onOpenChange,
  file,
  defaultStarter = 'feifei',
  defaultNote = '',
  onLaunched,
  engine,
  model,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  file: string
  defaultStarter?: string
  defaultNote?: string
  onLaunched?: () => void
  engine?: string
  model?: string
}) {
  const { open: openRun, newConsult } = useRunDetail()
  const [data, setData] = useState<ArchiveItems | null>(null)
  const [err, setErr] = useState('')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [starter, setStarter] = useState(defaultStarter)
  const [note, setNote] = useState(defaultNote)
  const [deadline, setDeadline] = useState(defaultDeadline)
  const [goalLoop, setGoalLoop] = useState<'active' | 'shadow'>('active')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open || !file) return
    setErr('')
    setData(null)
    setStarter(defaultStarter)
    setNote(defaultNote)
    setDeadline(defaultDeadline())
    apiGet<ArchiveItems>(`/api/guarded/archive-items?file=${encodeURIComponent(file)}`)
      .then((d) => {
        setData(d)
        // 默认勾上全部没做完的（已上线 / 你已验收的不勾）
        setPicked(Object.fromEntries(d.items.map((i) => [i.req, !i.done])))
      })
      .catch((e) => setErr(errText(e)))
  }, [open, file, defaultStarter, defaultNote])

  const chosen = (data?.items || []).filter((i) => picked[i.req])

  async function submit() {
    if (!chosen.length) return toast.error('至少勾一条要推进的条目')
    setSubmitting(true)
    try {
      const r = await apiPost<{ runId: string; contract: string; starter: string }>('/api/guarded/archive-launch', {
        file, picks: chosen.map((i) => i.req), startWith: starter, deadline, note: note.trim() || undefined, goalLoop, engine, model,
      })
      toast.success('守航推进已开工', { description: `契约 ${r.contract}` })
      onOpenChange(false)
      onLaunched?.()
      if (r.runId) openRun(r.runId)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const b = e.body as { displayName?: string; employee?: string }
        toast.error(`${b?.displayName ?? '该员工'} 正忙`, {
          description: '等其当前会话结束或停掉它；只想问话可开只读窗',
          action: b?.employee ? { label: '开只读窗', onClick: () => newConsult(b.employee!) } : undefined,
        })
      } else toast.error('守航推进失败', { description: errText(e) })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="guarded-archive-dialog">
        <DialogHeader>
          <DialogTitle>🛡 守航推进这份档案</DialogTitle>
          <DialogDescription>
            你不在的时候，由负责人把勾选的条目一路推到做完：链停了系统会接着派人，直到每条的验收卡填满。不发测、不发布生产。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          {err && <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">{err}</div>}
          <div className="grid gap-1.5">
            <Label>要推进的条目{data?.version ? `（${data.version}）` : ''}</Label>
            {!data && !err && <div className="text-xs text-muted-foreground">正在读登记表…</div>}
            <div className="grid max-h-56 gap-1 overflow-auto rounded-md border p-2">
              {(data?.items || []).map((i) => (
                <label key={i.req} className="flex cursor-pointer items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 shrink-0"
                    checked={!!picked[i.req]}
                    onChange={(e) => setPicked((p) => ({ ...p, [i.req]: e.target.checked }))}
                    data-testid={`guarded-archive-item-${i.req}`}
                  />
                  <span className="min-w-0">
                    <span className="font-mono text-xs text-muted-foreground">{i.req}</span> {i.name}
                    <span className="ms-1 text-xs text-muted-foreground">· {i.status || '（没写状态）'}{i.done ? ' · 已做完' : ''}</span>
                  </span>
                </label>
              ))}
              {data && !data.items.length && <div className="text-xs text-muted-foreground">登记表里没有 REQ 条目</div>}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="guarded-archive-starter">谁来负责推进</Label>
            <select
              id="guarded-archive-starter"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={starter}
              onChange={(e) => setStarter(e.target.value)}
              data-testid="guarded-archive-starter"
            >
              {STARTERS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <p className="text-[11px] leading-snug text-muted-foreground">
              建议交菲菲：她先盘点每条在哪一步、卡在谁，再决定第一棒——只差测试时她会直接交给迷糊。
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="guarded-archive-deadline">截止时间</Label>
              <Input id="guarded-archive-deadline" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>链停了、活没干完</Label>
              <select className="h-9 rounded-md border bg-background px-2 text-sm" value={goalLoop} onChange={(e) => setGoalLoop(e.target.value as 'active' | 'shadow')}>
                <option value="active">自动接着做，直到做完</option>
                <option value="shadow">只记录，不自动续</option>
              </select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="guarded-archive-note">一句话说明（可选，原话会带给负责人）</Label>
            <Textarea
              id="guarded-archive-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：重点把测试跑完；REQ-0352 按 A 方案做"
              className="min-h-16 resize-y"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={submitting || !chosen.length} data-testid="guarded-archive-submit">
            <ShieldCheckIcon weight="fill" />
            {submitting ? '签发中…' : `签契约并开工（${chosen.length} 条）`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
