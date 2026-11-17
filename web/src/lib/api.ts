// 与既有引擎 server.js 的 HTTP 契约层。开发期 Vite 代理 /api → 127.0.0.1:4800，
// 生产期同源部署，因此这里一律用相对路径 /api/*，不写死 host。

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function parse(res: Response) {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function apiGet<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } })
  const body = await parse(res)
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed`, body)
  return body as T
}

export async function apiPost<T = unknown>(
  path: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const body = await parse(res)
  if (!res.ok) throw new ApiError(res.status, `POST ${path} failed`, body)
  return body as T
}

export async function apiDelete<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: 'DELETE', signal, headers: { Accept: 'application/json' } })
  const body = await parse(res)
  if (!res.ok) throw new ApiError(res.status, `DELETE ${path} failed`, body)
  return body as T
}
