import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EngineModelPicker } from '@/components/engine-model-picker'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type Provider = { model: string; command?: string; reasoningEffort?: string }
export type EngineConfig = { defaultEngine: string; providers: Record<string, Provider>; engines: { id: string; label: string }[] }
const errorText = (e: unknown) => e instanceof ApiError ? (e.body as { error?: string })?.error || e.message : (e as Error).message

export function EngineSettings() {
  const [config, setConfig] = useState<EngineConfig | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { const abort = new AbortController(); apiGet<EngineConfig>('/api/engine-config', abort.signal).then(setConfig).catch(e => { if (!abort.signal.aborted) setError(errorText(e)) }); return () => abort.abort() }, [])
  function update(id: string, patch: Partial<Provider>) {
    setConfig(c => c && ({ ...c, providers: { ...c.providers, [id]: { ...c.providers[id], ...patch } } }))
  }
  async function save() {
    if (!config) return
    setBusy(true); setError('')
    try { setConfig(await apiPost<EngineConfig>('/api/engine-config', config)); toast.success('已保存，新会话使用新的基座设置') }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  if (!config) return <p role="status" className="text-sm text-muted-foreground">{error || '正在读取基座设置…'}</p>
  return <div className="grid gap-5" data-testid="engine-settings">
    <div className="grid gap-2">
      <Label htmlFor="engine-default">默认基座</Label>
      <Select value={config.defaultEngine} onValueChange={defaultEngine => setConfig({ ...config, defaultEngine })}>
        <SelectTrigger id="engine-default" data-testid="engine-default"><SelectValue /></SelectTrigger>
        <SelectContent>{config.engines.map(engine => <SelectItem key={engine.id} value={engine.id}>{engine.label}</SelectItem>)}</SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">用于新会话、会议和辅助任务。已有会话继续使用原基座，交接链沿用发起方基座。</p>
    </div>
    {config.engines.map(engine => <fieldset className="grid gap-3 rounded-md border p-4" key={engine.id}>
      <legend className="px-1 text-sm font-medium">{engine.label}</legend>
      <div className="grid gap-2">
        <Label htmlFor={`engine-model-${engine.id}`}>默认模型</Label>
        <EngineModelPicker id={`engine-model-${engine.id}`} engine={engine.id} value={config.providers[engine.id]?.model || ''} onChange={model => update(engine.id, { model })} placeholder="使用基座默认模型" />
      </div>
      {engine.id === 'codex' && <>
        <div className="grid gap-2"><Label htmlFor="codex-command">Codex 可执行文件</Label><Input id="codex-command" value={config.providers.codex.command || ''} onChange={e => update('codex', { command: e.target.value })} placeholder="codex 或可执行文件的绝对路径" /></div>
        <div className="grid gap-2"><Label htmlFor="codex-effort">思考强度</Label><Select value={config.providers.codex.reasoningEffort} onValueChange={reasoningEffort => update('codex', { reasoningEffort })}><SelectTrigger id="codex-effort"><SelectValue /></SelectTrigger><SelectContent>{['minimal', 'low', 'medium', 'high', 'xhigh'].map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}</SelectContent></Select></div>
        <p className="text-xs text-muted-foreground">模型列表按已保存的 Codex 路径读取。修改路径后请先保存，再刷新列表。</p>
      </>}
    </fieldset>)}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button onClick={save} disabled={busy} data-testid="engine-save">{busy ? '保存中…' : '保存基座设置'}</Button>
  </div>
}

export function EnginePicker({ engine, onChange, model, onModelChange }: { engine: string; onChange: (engine: string) => void; model: string; onModelChange: (model: string) => void }) {
  const [config, setConfig] = useState<EngineConfig | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { const abort = new AbortController(); apiGet<EngineConfig>('/api/engine-config', abort.signal).then(setConfig).catch(e => { if (!abort.signal.aborted) setError(errorText(e)) }); return () => abort.abort() }, [])
  return <div className="grid grid-cols-2 gap-3" data-testid="dispatch-engine-options">
    <div className="grid gap-2"><Label>执行基座</Label><Select value={engine || 'default'} onValueChange={v => { onChange(v === 'default' ? '' : v); onModelChange('') }}><SelectTrigger aria-label="执行基座" data-testid="dispatch-engine"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">跟随设置{config ? `（${config.engines.find(e => e.id === config.defaultEngine)?.label}）` : ''}</SelectItem>{config?.engines.map(e => <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>)}</SelectContent></Select></div>
    <div className="grid min-w-0 gap-2"><Label htmlFor="dispatch-model">本次模型（可选）</Label><EngineModelPicker key={engine || config?.defaultEngine} id="dispatch-model" engine={engine || config?.defaultEngine || ''} value={model} onChange={onModelChange} /></div>
    {error && <p className="col-span-2 text-xs text-destructive" role="alert">无法读取基座设置：{error}</p>}
  </div>
}
