// 会话事件复用全局 SSE：每个聊天窗口不再各开一条 /api/runs/:id/events，而是挂在全局 /api/events 那条上订阅。
//
// 缘起（2026-10-16 实测）：4700 是 HTTP/1.1，浏览器对同一主机最多 6 条并发连接。全局 SSE 1 条 + 每个聊天窗口
// 1 条长连接，开到第 5 个窗口正好占满 6 条——之后所有轮询 / 发消息 / 加载更早一律排队挂死（fetch >10s 不回），
// 而且这 6 条是同浏览器所有标签页共享的。JS 堆全程只有 15→26MB，「卡」不是内存，是连接池被长连接吃光。
// 对策：一个标签页只保留一条全局 SSE；窗口通过 POST /api/events/subscribe 把 runId 挂到这条连接上，
// 服务端把该会话的回放 + 增量包成 {type:'run-event', runId, _seq, ev} 推下来。
// 旧端点 /api/runs/:id/events 保留不动（旧 UI app/public 与未升级的前端仍在用）。

let nextClient = 0

export function createRunSubs() {
  const clients = new Map()   // clientId -> { res, runs: Map<runId, refCount> }
  const byRun = new Map()     // runId -> Set<clientId>

  // seq=null 表示非落盘帧（lab-sync 等），不带 _seq；line 是已序列化好的事件 JSON，直接拼接免二次 parse/stringify
  function frame(runId, seq, line) {
    const head = seq == null ? `{"type":"run-event","runId":${JSON.stringify(runId)}` : `{"type":"run-event","runId":${JSON.stringify(runId)},"_seq":${seq}`
    return `data: ${head},"ev":${line}}\n\n`
  }
  function send(c, s) { try { c.res.write(s) } catch { } }

  return {
    attach(res) {
      const id = `c${Date.now().toString(36)}${(++nextClient).toString(36)}`
      clients.set(id, { res, runs: new Map() })
      return id
    },
    detach(id) {
      const c = clients.get(id)
      if (!c) return
      for (const runId of c.runs.keys()) byRun.get(runId)?.delete(id)
      clients.delete(id)
    },
    // replay(write) 同步回放历史：write(seq, line)。回放与登记在同一同步段内完成，期间不会有 publish 插进来，故无缝无重。
    // 同一连接同会话重复订阅（两张卡开了同一条会话）只计数、各自再回放一遍（前端按 _seq 去重），推送仍只发一份。
    subscribe(id, runId, replay) {
      const c = clients.get(id)
      if (!c) return false
      replay((seq, line) => send(c, frame(runId, seq, line)))
      c.runs.set(runId, (c.runs.get(runId) || 0) + 1)
      if (!byRun.has(runId)) byRun.set(runId, new Set())
      byRun.get(runId).add(id)
      return true
    },
    unsubscribe(id, runId) {
      const c = clients.get(id)
      if (!c || !c.runs.has(runId)) return
      const n = c.runs.get(runId) - 1
      if (n > 0) return void c.runs.set(runId, n)
      c.runs.delete(runId)
      byRun.get(runId)?.delete(id)
    },
    publish(runId, seq, line) {
      const ids = byRun.get(runId)
      if (!ids || !ids.size) return
      const s = frame(runId, seq, line)
      for (const id of ids) { const c = clients.get(id); if (c) send(c, s) }
    },
  }
}
