import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { EngineModelPicker } from '@/components/engine-model-picker'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type Preview = { engine: string; engines: { id: string; label: string }[]; summary: string; pending?: { error?: string } | null }
const errorText = (e: unknown) => e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : (e as Error).message

export function EngineHandoverDialog({ runId, open, onOpenChange, onDone }: {
  runId: string; open: boolean; onOpenChange: (open: boolean) => void; onDone?: () => void
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [engine, setEngine] = useState('')
  const [model, setModel] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setPreview(null); setError(''); setNote(''); setModel('')
    apiGet<Preview>(`/api/runs/${runId}/handover`, abort.signal).then(p => {
      if (abort.signal.aborted) return
      setPreview(p)
      setEngine(p.engines.find(e => e.id !== p.engine)?.id || '')
    }).catch(e => { if (!abort.signal.aborted) setError(errorText(e)) })
    return () => abort.abort()
  }, [open, runId])
  async function submit() {
    if (!preview || !engine || busy) return
    setBusy(true); setError('')
    try {
      await apiPost(`/api/runs/${runId}/handover`, { engine, model, note, expectedEngine: preview.engine })
      toast.success('已交接，正在启动新基座')
      onDone?.(); onOpenChange(false)
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={v => { if (!busy) onOpenChange(v) }}>
    <DialogContent className="sm:max-w-xl" showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle>更换基座并接手</DialogTitle>
        <DialogDescription>停止当前执行与自动重试，把已有进度交给新基座继续。任务、历史消息和协作关联保留；其他同事的会话不受影响。</DialogDescription>
      </DialogHeader>
      {preview ? <>
        <p className="text-xs text-muted-foreground">当前基座：{preview.engines.find(e => e.id === preview.engine)?.label || preview.engine}。新基座会先核实文件和进度；待审批事项需要重新确认。</p>
        {preview.pending && <p role="status" className="text-xs text-destructive">上次交接尚未完成。{preview.pending.error || '可重试接手。'}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="grid gap-2"><Label htmlFor="handover-engine">接手基座</Label>
            <Select value={engine} disabled={busy} onValueChange={v => { setEngine(v); setModel('') }}>
              <SelectTrigger id="handover-engine"><SelectValue /></SelectTrigger>
              <SelectContent>{preview.engines.filter(e => e.id !== preview.engine).map(e => <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid min-w-0 gap-2"><Label htmlFor="handover-model">本次模型（可选）</Label><EngineModelPicker key={engine} id="handover-model" engine={engine} value={model} disabled={busy} onChange={setModel} placeholder="使用接手基座的默认模型" /></div>
        </div>
        <details className="rounded-md border p-3"><summary className="cursor-pointer">查看自动整理的交接摘要</summary><pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">{preview.summary}</pre></details>
        <div className="grid gap-2"><Label htmlFor="handover-note">补充说明（可选）</Label><Textarea id="handover-note" value={note} disabled={busy} maxLength={8000} onChange={e => setNote(e.target.value)} placeholder="例如：登录配置已完成，接下来完善引导页；不要重复发布。" /></div>
      </> : !error && <p role="status">正在从已有记录整理交接摘要…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button>
        <Button disabled={busy || !preview || !engine} onClick={submit}>{busy ? '正在停止旧会话并交接…' : '交接并继续'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
