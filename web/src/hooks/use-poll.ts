import { useCallback, useEffect, useState } from 'react'
import { apiGet } from '@/lib/api'
import { fetchRunsDelta } from '@/lib/runs-delta'
import type { Run } from '@/lib/types'

type PollState<T> = {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  refresh: () => void
}

// 轻量轮询：拉取一个 GET 端点并按 interval 刷新。SSE 负责实时增量，轮询作为兜底与首屏。
// interval=0 表示只拉一次、不轮询。
//
// 同 path 的多个订阅者合流到**一个**轮询器（见复盘 §3.83）。病根：/api/runs 曾同时被 4 个 usePoll 各自轮询
// （employee-status-provider 10s + run-detail-provider 15s + 当前视图 15s + employee-detail 15s），
// 而它当时是 3.6MB 明文——远程经隧道 ≈11~14MB/15s，请求互相排队直接把员工列表拖成「十有八九加载失败」。
// 另两个放大器一并治掉：① 上一跳还在路上就发下一跳（慢链路上请求叠着堆）；② 页面切到后台仍照轮。
// 对外签名与返回值不变，17 处调用点无需改动。
type Entry = {
  data: unknown
  error: Error | undefined
  fetchedAt: number
  inflight: boolean
  again: boolean   // 在途期间又被要求刷新：回来后补拉一跳（否则 SSE 触发的刷新会被在途去重吞掉，要等下一轮轮询）
  timer: ReturnType<typeof setInterval> | undefined
  timerMs: number
  subs: Map<symbol, { interval: number; notify: () => void }>
}
const registry = new Map<string, Entry>()

function entryOf(path: string): Entry {
  let e = registry.get(path)
  if (!e) {
    e = { data: undefined, error: undefined, fetchedAt: 0, inflight: false, again: false, timer: undefined, timerMs: 0, subs: new Map() }
    registry.set(path, e)
  }
  return e
}

async function load(path: string) {
  const e = entryOf(path)
  if (e.inflight) { e.again = true; return }   // 在途去重：不叠发（慢链路上重复发只会雪上加霜），回来后补一跳
  e.inflight = true
  const prevData = e.data, prevErr = e.error, first = !e.fetchedAt
  try {
    // /api/runs 走增量（见 runs-delta.ts）；无变化时返回原引用，下面据此不通知、不重绘
    e.data = path === '/api/runs' ? await fetchRunsDelta(e.data as Run[] | undefined) : await apiGet(path)
    e.error = undefined
  } catch (err) {
    e.error = err as Error
  } finally {
    e.inflight = false
    e.fetchedAt = Date.now()
    if (first || e.data !== prevData || e.error !== prevErr) e.subs.forEach((s) => s.notify())
    if (e.again) { e.again = false; load(path) }
  }
}

// 定时器按当前订阅者里最小的 interval 走（0=不轮询的订阅者不参与）；订阅者增减时重算。
function arm(path: string) {
  const e = entryOf(path)
  const intervals = [...e.subs.values()].map((s) => s.interval).filter((n) => n > 0)
  const ms = intervals.length ? Math.min(...intervals) : 0
  if (ms === e.timerMs) return
  if (e.timer) { clearInterval(e.timer); e.timer = undefined }
  e.timerMs = ms
  if (ms > 0) e.timer = setInterval(() => { if (!document.hidden) load(path) }, ms)
}

// 页面转可见：所有在轮询的 path 立刻补一次（隐藏期间不轮询，回来时数据可能已经馊了）
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    registry.forEach((e, path) => { if (e.timerMs > 0) load(path) })
  })
}

export function usePoll<T = unknown>(path: string, interval = 0): PollState<T> {
  const e = entryOf(path)
  const [, bump] = useState(0)

  const refresh = useCallback(() => { load(path) }, [path])

  useEffect(() => {
    const id = Symbol('poll')
    const e = entryOf(path)
    e.subs.set(id, { interval, notify: () => bump((n) => n + 1) })
    arm(path)
    // 首屏/换 path：无缓存必拉；有缓存但过期则补拉（挂载即先用缓存渲染，不闪骨架屏）。
    // interval=0（只拉一次的订阅者）按 5s 判过期——否则「切走再切回」会一直吃很旧的缓存。
    const maxAge = interval > 0 ? interval : 5000
    if (!e.fetchedAt || Date.now() - e.fetchedAt > maxAge) load(path)
    return () => {
      e.subs.delete(id)
      if (e.subs.size === 0 && e.timer) { clearInterval(e.timer); e.timer = undefined; e.timerMs = 0 }
      else arm(path)
    }
  }, [path, interval])

  return {
    data: e.data as T | undefined,
    error: e.error,
    // 只有「从没拉到过数据」才算 loading——有缓存时后台刷新不该让界面退回骨架屏
    loading: !e.fetchedAt && !e.error,
    refresh,
  }
}
