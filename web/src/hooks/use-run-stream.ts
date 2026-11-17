import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPost } from '@/lib/api'
import { useSseClientId, useSseEvent } from '@/components/sse-provider'
import type { SseEvent } from '@/lib/types'

export type RunEvent = {
  type: string
  _seq?: number
  message?: any
  text?: string
  kind?: string
  subtype?: string
  result?: string
  is_error?: boolean
  model?: string
  status?: string
  [k: string]: unknown
}

// 订阅单个 run 的流式事件：挂在全局 SSE 连接上（POST /api/events/subscribe），断线重连后按已收最大 seq 续传；
// 旧引擎退回独立的 /api/runs/:id/events。另支持向前翻页（/history）。
export function useRunStream(runId: string | null) {
  const [events, setEvents] = useState<RunEvent[]>([])
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const seen = useRef<Set<number>>(new Set())

  // per-run 事件流只在连接时给一次 lab-sync 状态，之后不再推状态变化；而全局 run-status 广播
  // 覆盖了 running/starting/done/error/interrupted 各转换。订阅它保持 runStatus 实时——否则给「已完成」的
  // 常驻会话追加消息、服务端已 resume 成 running，客户端仍以为 done（live=false），导致「正在思考…」气泡不显（旧 UI 靠此常鲜）。
  useSseEvent('run-status', (ev: SseEvent) => {
    if (ev.runId === runId && typeof ev.status === 'string') setRunStatus(ev.status)
  })

  // 已收到的最大 seq：全局连接断线重连（换了 clientId）后重订阅时作续传游标，只补断线期间的增量
  const maxSeq = useRef(0)
  const clientId = useSseClientId()

  function ingest(ev: RunEvent) {
    if (ev.type === 'lab-sync') {
      if (typeof ev.status === 'string') setRunStatus(ev.status)
      return
    }
    if (typeof ev._seq === 'number') {
      if (seen.current.has(ev._seq)) return
      seen.current.add(ev._seq)
      if (ev._seq > maxSeq.current) maxSeq.current = ev._seq
    }
    setEvents((prev) => [...prev, ev])
  }

  // 换会话：清空重来（必须声明在下面的订阅 effect 之前——同一次提交里先重置游标，订阅才按冷开回放尾窗）
  useEffect(() => {
    setEvents([])
    setStatus('connecting')
    setRunStatus(null)
    setHasMore(true)
    seen.current = new Set()
    maxSeq.current = 0
  }, [runId])

  // 主路径：挂在全局 SSE 上（run-event 帧 = {runId, _seq, ev}，见 app/run-subs.js），不再自开长连接
  useSseEvent('run-event', (p: SseEvent) => {
    if (!runId || p.runId !== runId || !p.ev) return
    const ev = { ...(p.ev as RunEvent) }
    if (typeof p._seq === 'number') ev._seq = p._seq
    ingest(ev)
  })
  useEffect(() => {
    if (!runId || typeof clientId !== 'string') return
    let live = true
    apiPost('/api/events/subscribe', { clientId, runId, lastId: maxSeq.current })
      .then(() => live && setStatus('open'))
      // 409 = clientId 已随断线作废；provider 收到新 hello 会换 clientId，本 effect 随之重跑
      .catch(() => live && setStatus('closed'))
    return () => {
      live = false
      apiPost('/api/events/unsubscribe', { clientId, runId }).catch(() => {})
    }
  }, [runId, clientId])

  // 兜底：引擎太旧、hello 不带 clientId → 退回每窗一条 /api/runs/:id/events（行为同改造前）
  useEffect(() => {
    if (!runId || clientId !== null) return
    const es = new EventSource(`/api/runs/${runId}/events`)
    es.onopen = () => setStatus('open')
    es.onerror = () => setStatus('closed')
    es.onmessage = (e) => {
      let ev: RunEvent
      try {
        ev = JSON.parse(e.data)
      } catch {
        return
      }
      // 实时流的 seq 只在 SSE `id:` 行里（→ event.lastEventId），data JSON 里没有；
      // 补进 _seq 后翻页/去重/稳定 key 才生效。/history 事件自带 _seq。
      if (typeof ev._seq !== 'number') {
        const s = Number(e.lastEventId)
        if (Number.isFinite(s)) ev._seq = s
      }
      ingest(ev)
    }
    return () => es.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, clientId])

  const loadEarlier = useCallback(async () => {
    if (!runId || loadingEarlier || !hasMore) return
    const oldest = events.reduce<number | null>(
      (min, e) => (typeof e._seq === 'number' && (min == null || e._seq < min) ? e._seq : min),
      null,
    )
    if (oldest == null) return
    setLoadingEarlier(true)
    try {
      const r = await apiGet<{ events: RunEvent[]; hasMore: boolean }>(
        `/api/runs/${runId}/history?before=${oldest}&limit=25`,
      )
      const fresh = (r.events || []).filter(
        (e) => typeof e._seq !== 'number' || !seen.current.has(e._seq),
      )
      fresh.forEach((e) => typeof e._seq === 'number' && seen.current.add(e._seq))
      // 一条新的都没有就别换数组：换了会让依赖 events 的贴底/翻页补偿空跑一轮
      if (fresh.length) setEvents((prev) => [...fresh, ...prev])
      setHasMore(!!r.hasMore)
    } finally {
      setLoadingEarlier(false)
    }
  }, [runId, events, hasMore, loadingEarlier])

  return { events, status, runStatus, hasMore, loadingEarlier, loadEarlier }
}
