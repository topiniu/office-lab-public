import { useEffect, useState, type ReactNode } from 'react'
import { PaperPlaneRightIcon } from '@phosphor-icons/react'
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
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEmployees } from '@/hooks/use-employees'
import { useRunDetail } from '@/components/run-detail-provider'
import { GuardedArchiveDialog } from '@/components/guarded-archive-dialog'
import { apiPost, ApiError } from '@/lib/api'
import { EnginePicker } from '@/components/engine-settings'

export function DispatchDialog({
  trigger,
  defaultEmployee,
  defaultTaskFile,
  defaultInstruction,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger?: ReactNode
  defaultEmployee?: string
  defaultTaskFile?: string
  defaultInstruction?: string
  open?: boolean
  onOpenChange?: (o: boolean) => void
}) {
  const { employees } = useEmployees()
  const { open: openRun, newConsult } = useRunDetail()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen

  const [employee, setEmployee] = useState(defaultEmployee ?? '')
  const [engine, setEngine] = useState('')
  const [model, setModel] = useState('')
  const [instruction, setInstruction] = useState(defaultInstruction ?? '')
  const [taskFile, setTaskFile] = useState(defaultTaskFile ?? '')
  const [kind, setKind] = useState<'dispatch' | 'chat'>('dispatch')
  const [guarded, setGuarded] = useState(false) // 全时双态：守航态派工（executionMode 沿交接链传播）
  const [submitting, setSubmitting] = useState(false)
  // v0.11.0 二期：勾守航态不再「派一条挂着旧契约的会话」——改为签一份只管这份档案的契约（守航推进弹窗），
  // 否则会静默认领别的版本的契约、或根本没有契约（没有目标循环、没有验收卡，链一停就停，§22.8 同族）。
  const [guardOpen, setGuardOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    setGuarded(false) // 守航态开关每次打开复位（防误留上次勾选）
    if (defaultEmployee) setEmployee(defaultEmployee)
    if (defaultTaskFile) setTaskFile(defaultTaskFile)
    if (defaultInstruction !== undefined) setInstruction(defaultInstruction)
  }, [open, defaultEmployee, defaultTaskFile, defaultInstruction])

  const keys = Object.keys(employees)

  async function submit() {
    if (!employee) return toast.error('请选择员工')
    if (!instruction.trim()) return toast.error('请填写指令')
    if (guarded && kind === 'dispatch') {
      if (!taskFile.trim()) return toast.error('守航推进要挂一份任务档案', { description: '没有档案的话，用侧栏「守航开工」让菲菲从 0 起草' })
      setGuardOpen(true)
      return
    }
    setSubmitting(true)
    try {
      const res = await apiPost<{ runId: string }>('/api/dispatch', {
        employee,
        engine: engine || undefined,
        model: model || undefined,
        instruction: instruction.trim(),
        taskFile: taskFile.trim() || undefined,
        kind,
        ...(guarded && kind === 'dispatch' ? { executionMode: 'guarded_run' } : {}),
      })
      toast.success(`已派工给 ${employees[employee]?.displayName ?? employee}${guarded && kind === 'dispatch' ? '（守航态）' : ''}`, {
        description: `运行 ${res.runId}`,
      })
      setInstruction('')
      setTaskFile('')
      setGuarded(false)
      setOpen(false)
      if (res.runId) openRun(res.runId) // 派工后直接打开实时观测

    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const b = e.body as { displayName?: string }
        // 同员工不能两条会话并发改同一个工作树（server.js busyRunFor）；但"只想问/排查"可以开只读窗，不占他的活
        toast.error(`${b?.displayName ?? '该员工'} 正忙`, {
          description: '请等其当前任务结束；只是想问/排查的话开一个只读窗',
          action: { label: '开只读窗', onClick: () => newConsult(employee) },
        })
      } else {
        toast.error('派工失败', { description: (e as Error).message })
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>派工 / 发起对话</DialogTitle>
          <DialogDescription>向某位员工下达一条指令，实时观测其运行。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <Tabs value={kind} onValueChange={(v) => setKind(v as 'dispatch' | 'chat')}>
            <TabsList className="w-full">
              <TabsTrigger value="dispatch" className="flex-1">派工</TabsTrigger>
              <TabsTrigger value="chat" className="flex-1">对话</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="grid gap-2">
            <Label htmlFor="dispatch-emp">员工</Label>
            <Select value={employee} onValueChange={setEmployee}>
              <SelectTrigger id="dispatch-emp" className="w-full">
                <SelectValue placeholder="选择员工" />
              </SelectTrigger>
              <SelectContent>
                {keys.map((k) => (
                  <SelectItem key={k} value={k}>
                    {employees[k].emoji} {employees[k].displayName} · {employees[k].title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <EnginePicker engine={engine} onChange={setEngine} model={model} onModelChange={setModel} />
          <div className="grid gap-2">
            <Label htmlFor="dispatch-instruction">指令</Label>
            <Textarea
              id="dispatch-instruction"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="要做什么…"
              className="min-h-28 resize-y"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="dispatch-taskfile">任务档案（可选）</Label>
            <Input
              id="dispatch-taskfile"
              value={taskFile}
              onChange={(e) => setTaskFile(e.target.value)}
              placeholder="office-lab/tasks/xxx.md"
            />
          </div>

          {kind === 'dispatch' && (
            <label className="flex cursor-pointer select-none items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={guarded}
                onChange={(e) => setGuarded(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span className="text-muted-foreground">
                守航推进（你不在时全权推进这份档案：签一份只管它的契约，链停了系统接着派人，直到验收卡填满；不发测）
              </span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={submit} disabled={submitting}>
            <PaperPlaneRightIcon weight="fill" />
            {submitting ? '发送中…' : kind === 'chat' ? '发起对话' : '派工'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <GuardedArchiveDialog
      engine={engine || undefined}
      model={model || undefined}
      open={guardOpen}
      onOpenChange={setGuardOpen}
      onLaunched={() => { setGuarded(false); setOpen(false) }}
      file={taskFile.trim()}
      defaultStarter={['feifei', 'mihu', 'ggbond'].includes(employee) ? employee : 'feifei'}
      defaultNote={instruction.trim()}
    />
    </>
  )
}
