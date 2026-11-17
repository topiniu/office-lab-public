import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { SseEvent } from '@/lib/types'

export type SseStatus = 'connecting' | 'open' | 'closed'
type Listener = (ev: SseEvent) => void

// 本连接在引擎侧的订阅身份（hello 下发）：undefined = 还没收到 hello（连接中 / 断线待重连）；
// null = 引擎太旧、hello 不带 clientId（聊天窗口退回每窗一条 /api/runs/:id/events）；string = 可挂会话订阅。
export type SseClientId = string | null | undefined

type Ctx = {
  status: SseStatus
  clientId: SseClientId
  subscribe: (type: string, fn: Listener) => () => void
}

const SseContext = createContext<Ctx | null>(null)

// 单一 EventSource 连 /api/events，按 payload.type 向订阅者广播。
// '*' 订阅所有事件。原生 EventSource 自带断线重连。
// 聊天窗口的会话事件也走这一条（run-event，见 use-run-stream.ts 与 app/run-subs.js）：HTTP/1.1 每主机只有 6 条连接，
// 每窗一条长连接时开到第 5 个窗口就把连接池吃光、其余请求全部挂死（2026-10-16 实测）。
export function SseProvider({ children, path = '/api/events' }: { children: ReactNode; path?: string }) {
  const [status, setStatus] = useState<SseStatus>('connecting')
  const [clientId, setClientId] = useState<SseClientId>(undefined)
  const listeners = useRef<Map<string, Set<Listener>>>(new Map())

  useEffect(() => {
    let es: EventSource
    // 判活：引擎每 25s 发一帧 {type:'ping'}。4700 的 vite 代理在引擎被强杀时不关浏览器这头，EventSource 会一直停在
    // OPEN 却再也收不到东西（原生重连永远不触发）——超过 STALE_MS 没收到任何帧就自己关掉重连。
    // 只在 hello 带了 clientId（=新引擎、确定会发 data 心跳）之后才启用，旧引擎只发 `: ping` 注释，看不见、不能拿来判。
    let lastMsgAt = Date.now()
    let watch = false
    const connect = () => {
      es = new EventSource(path)
      lastMsgAt = Date.now()
      watch = false
      setStatus('connecting')
      es.onopen = () => setStatus('open')
      // 断线即作废旧 clientId：引擎侧已随连接关闭清掉它的订阅，重连后新 hello 会给新的，订阅方据此重挂
      es.onerror = () => {
        setStatus('closed')
        setClientId(undefined)
      }
      es.onmessage = (e) => {
        lastMsgAt = Date.now()
        let payload: SseEvent
        try {
          payload = JSON.parse(e.data)
        } catch {
          return
        }
        const type = payload?.type
        if (!type || type === 'ping') return
        if (type === 'hello') {
          const id = typeof payload.clientId === 'string' ? payload.clientId : null
          watch = id !== null
          setClientId(id)
        }
        listeners.current.get(type)?.forEach((fn) => fn(payload))
        listeners.current.get('*')?.forEach((fn) => fn(payload))
      }
    }
    connect()
    const STALE_MS = 60000
    const timer = setInterval(() => {
      if (!watch || Date.now() - lastMsgAt < STALE_MS) return
      es.close()
      setClientId(undefined)
      connect()
    }, 15000)
    return () => {
      clearInterval(timer)
      es.close()
    }
  }, [path])

  const ctx: Ctx = {
    status,
    clientId,
    subscribe(type, fn) {
      let set = listeners.current.get(type)
      if (!set) {
        set = new Set()
        listeners.current.set(type, set)
      }
      set.add(fn)
      return () => set!.delete(fn)
    },
  }

  return <SseContext.Provider value={ctx}>{children}</SseContext.Provider>
}

export function useSseStatus() {
  return useContext(SseContext)?.status ?? 'closed'
}

// 没有 Provider（不该发生）按「旧引擎」处理，让调用方走自带连接的兜底路径
export function useSseClientId(): SseClientId {
  const ctx = useContext(SseContext)
  return ctx ? ctx.clientId : null
}

// 订阅一个或多个事件 type。handler 用 ref 存，依赖变化不重订阅。
export function useSseEvent(types: string | string[], handler: Listener) {
  const ctx = useContext(SseContext)
  const ref = useRef(handler)
  ref.current = handler
  const key = Array.isArray(types) ? types.join(',') : types
  useEffect(() => {
    if (!ctx) return
    const list = Array.isArray(types) ? types : [types]
    const offs = list.map((t) => ctx.subscribe(t, (ev) => ref.current(ev)))
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, key])
}
