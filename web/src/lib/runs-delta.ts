import { apiGet } from '@/lib/api'
import type { Run } from '@/lib/types'

// /api/runs 的增量拉取（服务端 runsDeltaBody）。列表全量已 2000+ 条、4MB+，每次 run-status 都整包重拉
// 是网页卡顿的主因；这里只取「上次之后变了的条目 + 被删的 id」合进上一份。
// 没变的 run 沿用原对象引用、整体无变化时原数组原样返回——usePoll 据此跳过通知，下游 memo 不被打穿。
type Delta = { epoch: string; rev: number; full: boolean; removed: string[]; runs: Run[] }

let epoch = ''
let rev = 0

const byStartedDesc = (a: Run, b: Run) => (b.startedAt || '').localeCompare(a.startedAt || '')

export async function fetchRunsDelta(prev: Run[] | undefined): Promise<Run[]> {
  const qs = prev && epoch ? `?epoch=${encodeURIComponent(epoch)}&since=${rev}` : '?since=-1'
  const d = await apiGet<Delta | Run[]>('/api/runs' + qs)
  // 旧引擎不认 since、照旧回整包数组（前端先 build、引擎还没重启的窗口期）——当全量用，下次仍带 since 试
  if (Array.isArray(d)) { epoch = ''; return d }
  epoch = d.epoch
  rev = d.rev
  if (d.full || !prev) return d.runs.sort(byStartedDesc)
  if (!d.runs.length && !d.removed.length) return prev
  const byId = new Map(prev.map((r) => [r.id, r]))
  for (const id of d.removed) byId.delete(id)
  for (const r of d.runs) byId.set(r.id, r)
  return [...byId.values()].sort(byStartedDesc)
}
