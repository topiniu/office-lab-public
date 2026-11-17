import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { MoonStarsIcon } from '@phosphor-icons/react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useRunDetail } from '@/components/run-detail-provider'
import { apiGet, apiPost, ApiError } from '@/lib/api'

// 守航冷启动入口：不依赖任何任务卡片/任务档案——菲菲以守航态从 0 起草需求（自主挑需求 → 需求说明与
// 验收标准 → 建任务档案 → 交棒 GG Bond，整链自动继承守航）。契约由引擎签发（POST /api/guarded/launch），
// 指令也由引擎组装（单一事实源，前端只传字段）。派工弹窗的守航勾选保留给「已有卡片」的场景。
//
// 第三个来源「承接上轮」（2026-09-18 加）：guarded-01 老板点名三条、只走完一条，另两条 park 后**没有回路**
// ——台账里逐条记着卡点与拟定口径，老板拍完却只能手工重开一轮、重敲编号，还会撞上契约的
// `append_after_rc_ready: requires_resign`。这个 tab 就是那条回路：读 /api/guarded/pending 把未完成项摆出来，
// 逐条填一句表态，POST /api/guarded/resume 签发续跑契约（那份新契约本身即 E3 要的重签）。

type PendingItem = {
  req: string
  result: string
  stopWhy: string
  proposal: string
  probeKey: string
  parkRounds: number
  ruling: string
}
type PendingState = {
  runName: string
  contractRel: string
  version: string
  items: PendingItem[]
  done: PendingItem[]
  why?: string
}

const RESULT_LABEL: Record<string, string> = {
  parked: 'park',
  quarantined: '已隔离',
  in_progress: '在途',
  untouched: '一次都没碰',
}

function errText(e: unknown) {
  const body = e instanceof ApiError ? (e.body as { error?: string } | null) : null
  return body?.error || (e as Error).message
}

// 默认截止＝次日 08:00（晨检时点），格式为 datetime-local 需要的本地 `YYYY-MM-DDTHH:mm`
function defaultDeadline() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function GuardedLaunchDialog({
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger?: ReactNode
  open?: boolean
  onOpenChange?: (o: boolean) => void
}) {
  const { open: openRun, newConsult } = useRunDetail()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen

  const [source, setSource] = useState<'self' | 'named' | 'resume'>('self')
  const [picks, setPicks] = useState('')
  const [maxItems, setMaxItems] = useState('1')
  // 仓数上限：引擎此前写死 2，且入口连改它的字段都没有——2026-09-18 老板点名的 REQ-0353 就是被这个
  // 引擎自造的默认值挡掉的（它落点在第 3 个仓）。空＝用引擎默认（自选 2 / 点名·续跑 3）。
  const [maxRepos, setMaxRepos] = useState('')
  const [deadline, setDeadline] = useState(defaultDeadline)
  const [note, setNote] = useState('')
  // v0.11.0 目标循环：链停了、活没干完 → 引擎接着派人。默认「自动续跑到做完」；想先观察可选「只记录不续跑」（影子）。
  const [goalLoop, setGoalLoop] = useState<'active' | 'shadow'>('active')
  const [maxGoalTurns, setMaxGoalTurns] = useState('8')
  const [submitting, setSubmitting] = useState(false)
  const [pending, setPending] = useState<PendingState | null>(null)
  const [pendingLoading, setPendingLoading] = useState(false)
  const [rulings, setRulings] = useState<Record<string, string>>({})
  const [chosen, setChosen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!open) return
    setDeadline(defaultDeadline()) // 每次打开重算，别留昨天的截止时间
  }, [open])

  const loadPending = useCallback(async () => {
    setPendingLoading(true)
    try {
      const st = await apiGet<PendingState>('/api/guarded/pending')
      setPending(st)
      // 默认全选：老板点名过的条目没做完，默认就该全部承接，要删是他的动作不是他的作业
      setChosen(Object.fromEntries(st.items.map((i) => [i.req, true])))
      setRulings((prev) =>
        Object.fromEntries(st.items.map((i) => [i.req, prev[i.req] ?? i.ruling ?? ''])),
      )
    } catch (e) {
      toast.error('读不到上轮未完成条目', { description: errText(e) })
      setPending(null)
    } finally {
      setPendingLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && source === 'resume' && !pending && !pendingLoading) void loadPending()
  }, [open, source, pending, pendingLoading, loadPending])

  // 契约文件名由引擎定序号（同日多轮 guarded-01/02…），这里只给个可预期的形状提示
  const contractHint = useMemo(() => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `tasks/${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-守航契约-guarded-NN.md`
  }, [open])

  const carried = useMemo(
    () => (pending?.items || []).filter((i) => chosen[i.req]),
    [pending, chosen],
  )

  async function submit() {
    if (source === 'named' && !picks.trim()) {
      return toast.error('点名模式要填条目', { description: '例如 REQ-0243, REQ-0251' })
    }
    if (source === 'resume' && !carried.length) {
      return toast.error('没有勾选要承接的条目', { description: '至少选一条，或改用「我点名」另起一轮' })
    }
    setSubmitting(true)
    try {
      const common = {
        maxRepos: Number(maxRepos) || undefined,
        deadline,
        note: note.trim() || undefined,
        goalLoop,
        maxGoalTurns: Number(maxGoalTurns) || undefined,
      }
      const res =
        source === 'resume'
          ? await apiPost<{ runId: string; contract: string; carried: string[] }>(
              '/api/guarded/resume',
              {
                ...common,
                fromRunName: pending?.runName || undefined,
                picks: carried.map((i) => i.req),
                rulings: Object.fromEntries(
                  carried.map((i) => [i.req, (rulings[i.req] || '').trim()]).filter(([, v]) => v),
                ),
              },
            )
          : await apiPost<{ runId: string; contract: string }>('/api/guarded/launch', {
              ...common,
              source,
              picks: source === 'named' ? picks.trim() : undefined,
              maxItems: Number(maxItems) || 1,
            })
      toast.success(
        source === 'resume' ? '守航续跑已开工（菲菲 · 承接上轮）' : '守航已开工（菲菲 · 冷启动）',
        { description: `契约 ${res.contract}` },
      )
      setNote('')
      setPicks('')
      setPending(null) // 下次打开重新拉，别拿着已经被这一轮消化掉的旧清单
      setOpen(false)
      if (res.runId) openRun(res.runId) // 直接开观测窗，睡前扫一眼她起步对不对
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 菲菲正忙：守航冷启动必须是她的正式会话（要建档案、要交棒），不能挤进只读窗
        toast.error('菲菲正忙', {
          description: '先等她当前会话结束或停掉它；只想问话可开只读窗',
          action: { label: '开只读窗', onClick: () => newConsult('feifei') },
        })
      } else {
        toast.error(source === 'resume' ? '守航续跑失败' : '守航开工失败', { description: errText(e) })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>🌙 守航开工</DialogTitle>
          <DialogDescription>
            你不在的时候，菲菲当产品经理：挑需求、想清楚用户要什么、能定的自己定 → 开发 → 测试，一直做到验收卡填满。
            明早打开侧栏「验收台」，一个需求一张卡：做完没、长啥样、动了哪些老功能、要你拍的高危事项。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label>候选来源</Label>
            <Tabs value={source} onValueChange={(v) => setSource(v as 'self' | 'named' | 'resume')}>
              <TabsList className="w-full">
                <TabsTrigger value="self" className="flex-1">菲菲自选</TabsTrigger>
                <TabsTrigger value="named" className="flex-1">我点名</TabsTrigger>
                <TabsTrigger value="resume" className="flex-1">承接上轮</TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">
              {source === 'self'
                ? '菲菲读飞书「待处理」自己挑：查得清的自己查、可以反悔的自己定（写在验收卡上给你追认），只有反悔代价大的才留给你拍。'
                : source === 'named'
                  ? '只做你点名的这几条，不会自己加。'
                  : '承接上一轮没做到 RC_READY 的条目：逐条看她卡在哪、她的拟定口径是什么，你给一句表态就能解冻。签发的新契约即 append_after_rc_ready 要的重签。'}
            </p>
          </div>

          {source === 'resume' && (
            <div className="grid gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label>上轮未完成条目</Label>
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => void loadPending()}
                  disabled={pendingLoading}
                >
                  {pendingLoading ? '读取中…' : '重新读取'}
                </button>
              </div>
              {pendingLoading && <p className="text-xs text-muted-foreground">正在读守航台账…</p>}
              {!pendingLoading && pending && !pending.items.length && (
                <p className="text-xs text-muted-foreground">
                  {pending.why || '上一轮没有未完成条目'}
                  {pending.runName ? `（契约 ${pending.runName}）` : ''}
                </p>
              )}
              {!pendingLoading && pending && pending.items.length > 0 && (
                <>
                  <p className="text-xs text-muted-foreground">
                    来自 <code className="font-mono">{pending.runName}</code> 的守航台账
                    {pending.done.length > 0 && `；已达 RC_READY：${pending.done.map((d) => d.req).join('、')}`}
                  </p>
                  <div className="grid gap-3">
                    {pending.items.map((it) => (
                      <div key={it.req} className="rounded-md border p-3">
                        <label className="flex items-center gap-2 text-sm font-medium">
                          <input
                            type="checkbox"
                            checked={!!chosen[it.req]}
                            onChange={(e) =>
                              setChosen((c) => ({ ...c, [it.req]: e.target.checked }))
                            }
                          />
                          {it.req}
                          <span className="text-xs font-normal text-muted-foreground">
                            {RESULT_LABEL[it.result] || it.result || '未知'}
                            {it.parkRounds ? ` · 已 park ${it.parkRounds} 轮` : ''}
                          </span>
                        </label>
                        {it.stopWhy && (
                          <p className="mt-1.5 text-xs leading-snug text-muted-foreground">
                            <span className="font-medium">卡在：</span>
                            {it.stopWhy}
                          </p>
                        )}
                        {it.proposal && (
                          <p className="mt-1 text-xs leading-snug text-muted-foreground">
                            <span className="font-medium">她的拟定口径：</span>
                            {it.proposal}
                          </p>
                        )}
                        <Textarea
                          value={rulings[it.req] ?? ''}
                          onChange={(e) => setRulings((r) => ({ ...r, [it.req]: e.target.value }))}
                          placeholder="你的表态（留空＝她按三种不确定重新判；写「按你的拟定口径做」即批准上面那一条）"
                          className="mt-2 min-h-16 resize-y text-sm"
                          disabled={!chosen[it.req]}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {source === 'named' && (
            <div className="grid gap-2">
              <Label htmlFor="guarded-picks">点名条目</Label>
              <Input
                id="guarded-picks"
                value={picks}
                onChange={(e) => setPicks(e.target.value)}
                placeholder="REQ-0243, REQ-0251"
              />
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            {source !== 'resume' && (
              <div className="grid gap-2">
                <Label htmlFor="guarded-max">最多条数</Label>
                <Input
                  id="guarded-max"
                  type="number"
                  min={1}
                  max={5}
                  value={maxItems}
                  onChange={(e) => setMaxItems(e.target.value)}
                />
                {source === 'named' && (
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    点名即范围：比点名条数小的值不生效。
                  </p>
                )}
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor="guarded-repos">最多改几个仓</Label>
              <Input
                id="guarded-repos"
                type="number"
                min={1}
                max={9}
                value={maxRepos}
                onChange={(e) => setMaxRepos(e.target.value)}
                placeholder={source === 'self' ? '2' : '3'}
              />
              <p className="text-[11px] leading-snug text-muted-foreground">
                留空＝默认（自选 2 / 点名·续跑 3）。它防的是夜里摊子失控，不该用来否掉你点名的条目。
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="guarded-deadline">截止时间</Label>
              <Input
                id="guarded-deadline"
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>链停了、活没干完怎么办</Label>
            <Tabs value={goalLoop} onValueChange={(v) => setGoalLoop(v as 'active' | 'shadow')}>
              <TabsList className="w-full">
                <TabsTrigger value="active" className="flex-1" data-testid="guarded-goal-loop-active">自动接着做，直到做完</TabsTrigger>
                <TabsTrigger value="shadow" className="flex-1" data-testid="guarded-goal-loop-shadow">只记录，不自动续</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2">
              <Label htmlFor="guarded-goal-turns" className="text-xs font-normal text-muted-foreground">最多自动续</Label>
              <Input
                id="guarded-goal-turns"
                type="number"
                min={1}
                max={30}
                value={maxGoalTurns}
                onChange={(e) => setMaxGoalTurns(e.target.value)}
                className="h-7 w-16"
                disabled={goalLoop !== 'active'}
              />
              <span className="text-xs text-muted-foreground">轮</span>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {goalLoop === 'active'
                ? '每一棒收工后引擎会看一眼：还有没做完的，就派对应的人接着做。同样的局面连续 3 次没推进会判「卡住」停下；到截止时间也会停。'
                : '引擎照样判断「干完没」，但只写在验收台上、不自动派人——适合先观察几轮。'}
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="guarded-note">附加说明（可选）</Label>
            <Textarea
              id="guarded-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：优先看供应链看板那几条；别碰纸样通知相关的东西。"
              className="min-h-20 resize-y"
            />
          </div>

          <p className="text-xs text-muted-foreground">
            将签发 <code className="font-mono">{contractHint}</code> 并以守航态派菲菲。
            {source === 'resume'
              ? '承接项默认独立成新版本，不往已 RC_READY 的旧版追加。'
              : '只有反悔代价大的事（改线上数据、动权限、影响钱、对外发消息…）她才会停下来，而且只停那一条，其余照做。'}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={submit} disabled={submitting}>
            <MoonStarsIcon weight="fill" />
            {submitting
              ? '签发中…'
              : source === 'resume'
                ? `签发续跑契约（${carried.length} 条）`
                : '签发契约并开工'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
