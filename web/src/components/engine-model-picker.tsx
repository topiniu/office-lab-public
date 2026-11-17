import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type Model = { id: string; label: string; isDefault: boolean }
export function EngineModelPicker({ id, engine, value, onChange, disabled, placeholder = '使用基座默认模型' }: {
  id: string; engine: string; value: string; onChange: (model: string) => void; disabled?: boolean; placeholder?: string
}) {
  const [models, setModels] = useState<Model[]>([])
  const [manual, setManual] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (engine !== 'codex') return
    const abort = new AbortController()
    setLoading(true); setError('')
    apiGet<{ models: Model[] }>(`/api/engines/codex/models${refresh ? '?refresh=1' : ''}`, abort.signal)
      .then(data => { if (!abort.signal.aborted) setModels(data.models) })
      .catch(() => { if (!abort.signal.aborted) setError('读取失败，可重试或手动填写模型 ID。') })
      .finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [engine, refresh])
  if (engine !== 'codex') return <Input id={id} value={value} disabled={disabled} maxLength={200} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
  const custom = manual || (!!value && !models.some(m => m.id === value))
  return <div className="grid min-w-0 gap-2">
    <div className="flex min-w-0 gap-2">
      <Select value={custom ? 'custom' : value ? `model:${value}` : 'default'} disabled={disabled} onValueChange={v => {
        setManual(v === 'custom')
        if (v !== 'custom') onChange(v === 'default' ? '' : v.slice(6))
      }}>
        <SelectTrigger id={id} className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="default">{placeholder}</SelectItem>
          {models.map(m => <SelectItem key={m.id} value={`model:${m.id}`}>{m.label}{m.label !== m.id ? ` (${m.id})` : ''}{m.isDefault ? ' · Codex 默认' : ''}</SelectItem>)}
          <SelectItem value="custom">手动填写模型 ID</SelectItem>
        </SelectContent>
      </Select>
      <Button type="button" variant="outline" disabled={disabled || loading} onClick={() => setRefresh(n => n + 1)} aria-label="刷新模型列表">{loading ? '读取中…' : '刷新'}</Button>
    </div>
    {custom && <Input id={`${id}-custom`} aria-label="自定义模型 ID" value={value} maxLength={200} disabled={disabled} onChange={e => onChange(e.target.value)} placeholder="填写模型 ID" />}
    <p className="text-xs text-muted-foreground" role="status">{error || (loading ? '正在读取 Codex 模型列表…' : !models.length ? '暂无模型选项，可刷新或手动填写。' : '来自本机 Codex；实际可用性取决于账号和服务配置。')}</p>
  </div>
}
