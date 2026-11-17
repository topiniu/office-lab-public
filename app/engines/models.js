import { CodexRpc } from './rpc.js'

// Discovery only: never starts a thread/turn or executes task tools.
export async function listCodexModels({ command, cwd, rpcFactory = args => new CodexRpc(args) }) {
  const rpc = rpcFactory({ command: command || 'codex', cwd, env: process.env, timeoutMs: 10000 })
  const deadline = setTimeout(() => rpc.close(new Error('读取 Codex 模型列表超时')), 20000)
  try {
    await rpc.request('initialize', { clientInfo: { name: 'office_lab', title: 'Office Lab', version: '0.12.0' } })
    rpc.send({ method: 'initialized' })
    const models = new Map(), cursors = new Set()
    let cursor = null
    for (let page = 0; page < 10; page++) {
      const result = await rpc.request('model/list', { cursor, limit: 100, includeHidden: false })
      if (!Array.isArray(result?.data)) throw new Error('Codex 模型列表格式不正确')
      for (const m of result.data) {
        if (m.hidden || typeof m.model !== 'string' || !m.model || m.model.length > 200 || /[\r\n\0]/.test(m.model)) continue
        models.set(m.model, { id: m.model, label: m.displayName || m.model, isDefault: !!m.isDefault })
      }
      cursor = result.nextCursor
      if (!cursor) return [...models.values()]
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw new Error('Codex 模型列表分页异常')
      cursors.add(cursor)
    }
    throw new Error('Codex 模型列表分页过多')
  } finally {
    clearTimeout(deadline)
    await rpc.close()
  }
}

// Coalesce simultaneous settings/dispatch queries; failures are never cached.
export function createModelCatalog(load = listCodexModels, now = Date.now) {
  let cached = null, pending = null
  return async (options, refresh = false) => {
    const key = JSON.stringify([options.command, options.cwd])
    if (pending?.key === key) return pending.promise
    if (!refresh && cached?.key === key && now() - cached.at < 60000) return cached.models
    const request = { key }
    request.promise = Promise.resolve().then(() => load(options)).then(models => {
      cached = { key, at: now(), models }; return models
    }).finally(() => { if (pending === request) pending = null })
    pending = request
    return request.promise
  }
}
