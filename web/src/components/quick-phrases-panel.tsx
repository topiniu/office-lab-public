// 设置 →「快捷短语」：增删改查 + 排序 + 指定出现在哪些员工的聊天窗（不选 = 全部员工）。
// 数据在引擎 runs/quick-phrases.json，见 lib/quick-phrases.ts。
import { useState } from 'react'
import {
  PlusIcon,
  PencilSimpleIcon,
  TrashIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { useEmployees, employeeName } from '@/hooks/use-employees'
import { ApiError } from '@/lib/api'
import {
  useQuickPhrases,
  saveQuickPhrase,
  deleteQuickPhrase,
  reorderQuickPhrases,
  type QuickPhrase,
  type QuickPhraseInput,
} from '@/lib/quick-phrases'
import { cn } from '@/lib/utils'

function errMsg(e: unknown): string {
  const b = (e as ApiError)?.body as { error?: string } | undefined
  return b?.error || (e as Error)?.message || String(e)
}

const EMPTY: QuickPhraseInput = { label: '', text: '', employees: [] }

function PhraseEditor({
  initial,
  onDone,
}: {
  initial: QuickPhraseInput
  onDone: () => void
}) {
  const { employees } = useEmployees()
  const [draft, setDraft] = useState<QuickPhraseInput>(initial)
  const [saving, setSaving] = useState(false)
  const keys = Object.keys(employees)
  const toggleEmp = (k: string, on: boolean) =>
    setDraft((d) => ({ ...d, employees: on ? [...d.employees, k] : d.employees.filter((x) => x !== k) }))

  async function save() {
    if (!draft.text.trim()) {
      toast.error('短语内容不能为空')
      return
    }
    setSaving(true)
    try {
      await saveQuickPhrase(draft)
      toast.success(draft.id ? '已保存' : '已新增')
      onDone()
    } catch (e) {
      toast.error('保存失败', { description: errMsg(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="grid gap-1.5">
        <Label className="text-sm">按钮名</Label>
        <Input
          value={draft.label}
          maxLength={24}
          onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          placeholder="留空则取内容第一行"
        />
      </div>
      <div className="grid gap-1.5">
        <Label className="text-sm">内容</Label>
        <Textarea
          value={draft.text}
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
          placeholder="点一下就直接发出去的话"
          className="max-h-60 min-h-20"
          autoFocus
        />
      </div>
      <div className="grid gap-1.5">
        <Label className="text-sm">出现在谁的聊天窗</Label>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {keys.map((k) => (
            <label key={k} className="flex cursor-pointer items-center gap-1.5 text-sm">
              <Checkbox checked={draft.employees.includes(k)} onCheckedChange={(v) => toggleEmp(k, !!v)} />
              {employeeName(employees, k)}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {draft.employees.length ? `只在这 ${draft.employees.length} 位的聊天窗出现` : '一个都不勾 = 所有员工的聊天窗都出现'}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          取消
        </Button>
        <Button size="sm" onClick={save} disabled={saving}>
          保存
        </Button>
      </div>
    </div>
  )
}

function PhraseRow({
  p,
  index,
  total,
  onEdit,
  onMove,
}: {
  p: QuickPhrase
  index: number
  total: number
  onEdit: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const { employees } = useEmployees()
  const [confirmDel, setConfirmDel] = useState(false)
  async function del() {
    if (!confirmDel) {
      setConfirmDel(true)
      setTimeout(() => setConfirmDel(false), 3000)
      return
    }
    try {
      await deleteQuickPhrase(p.id)
      toast.success('已删除')
    } catch (e) {
      toast.error('删除失败', { description: errMsg(e) })
    }
  }
  return (
    <div className="group flex items-start gap-2 rounded-lg border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{p.label}</span>
          {p.employees.length ? (
            p.employees.map((k) => (
              <Badge key={k} variant="outline" className="h-4 px-1.5 text-[10px]">
                {employeeName(employees, k)}
              </Badge>
            ))
          ) : (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              全部员工
            </Badge>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs break-all whitespace-pre-wrap text-muted-foreground">{p.text}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="icon" className="size-7" aria-label="上移" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUpIcon />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" aria-label="下移" disabled={index === total - 1} onClick={() => onMove(1)}>
          <ArrowDownIcon />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" aria-label="编辑" onClick={onEdit}>
          <PencilSimpleIcon />
        </Button>
        <Button
          variant={confirmDel ? 'destructive' : 'ghost'}
          size={confirmDel ? 'sm' : 'icon'}
          className={cn(confirmDel ? 'h-7 px-2 text-xs' : 'size-7')}
          aria-label="删除"
          onClick={del}
        >
          {confirmDel ? '确认删除' : <TrashIcon />}
        </Button>
      </div>
    </div>
  )
}

export function QuickPhrasesPanel() {
  const phrases = useQuickPhrases()
  const { employees } = useEmployees()
  const [q, setQ] = useState('')
  // null = 不在编辑；'new' = 新增；其它 = 正在编辑的短语 id
  const [editing, setEditing] = useState<string | null>(null)

  if (phrases == null)
    return (
      <div className="grid gap-2">
        <Skeleton className="h-9" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    )

  const kw = q.trim().toLowerCase()
  const shown = kw
    ? phrases.filter(
        (p) =>
          p.label.toLowerCase().includes(kw) ||
          p.text.toLowerCase().includes(kw) ||
          p.employees.some((k) => employeeName(employees, k).toLowerCase().includes(kw)),
      )
    : phrases

  async function move(id: string, dir: -1 | 1) {
    const ids = phrases!.map((p) => p.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    try {
      await reorderQuickPhrases(ids)
    } catch (e) {
      toast.error('排序失败', { description: errMsg(e) })
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        常用的话存成短语，聊天输入框上方会出现一排按钮，点一下就直接发给这位员工。
      </p>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜按钮名 / 内容 / 员工" className="ps-8" />
        </div>
        <Button size="sm" onClick={() => setEditing('new')} disabled={editing === 'new'}>
          <PlusIcon /> 新增
        </Button>
      </div>
      {editing === 'new' && <PhraseEditor initial={EMPTY} onDone={() => setEditing(null)} />}
      {shown.length === 0 && editing !== 'new' && (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          {kw ? '没有匹配的短语' : '还没有快捷短语，点「新增」加一条'}
        </p>
      )}
      <div className="grid gap-2">
        {shown.map((p) =>
          editing === p.id ? (
            <PhraseEditor
              key={p.id}
              initial={{ id: p.id, label: p.label, text: p.text, employees: p.employees }}
              onDone={() => setEditing(null)}
            />
          ) : (
            <PhraseRow
              key={p.id}
              p={p}
              index={phrases.indexOf(p)}
              total={phrases.length}
              onEdit={() => setEditing(p.id)}
              onMove={(dir) => move(p.id, dir)}
            />
          ),
        )}
      </div>
    </div>
  )
}
