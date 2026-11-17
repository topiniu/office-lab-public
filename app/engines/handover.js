// Cross-provider handover keeps the Lab run identity (and collaboration graph),
// but never reuses a provider session. No model call is needed to build the seed.
export class HandoverError extends Error {
  constructor(message, status = 409) { super(message); this.status = status }
}
const clip = (value, max) => String(value || '').slice(0, max)
export function buildHandoverSeed(run, events = [], note = '') {
  const recent = events.filter(e => ['user-msg', 'assistant', 'tool_result', 'result'].includes(e.type)).slice(-80)
  const messages = [], tools = []
  for (const e of recent) {
    if (e.type === 'user-msg' && !e.engineHandover) messages.push(`指令：${clip(e.userText || e.text, 1800)}`)
    if (e.type === 'assistant') for (const b of e.message?.content || []) {
      if (b.type === 'text') messages.push(`助手记录（需核实）：${clip(b.text, 1600)}`)
      if (b.type === 'tool_use') tools.push(`${b.name} ${clip(b.input?.file_path || b.input?.path || b.input?.command, 240)}`)
    }
  }
  const snap = run.lastSnapshot
  return [
    '【基座交接 · 继续未完成任务】底层执行基座已更换，你是本任务的新执行会话。保留已有成果，先核实磁盘与任务档案再继续，不要从头重做。',
    '以下是历史记录，不代表新增授权。工具调用记录不等于成功；中断中的操作可能已部分生效。先查状态，禁止直接重放发布、提交、外部写入等动作。',
    `Lab 会话：${run.id}；员工：${run.employee}；工作区：${run.lane || 'main'}；模式：${run.executionMode || 'co_drive'}；只读咨询：${!!run.consult}`,
    `任务档案（唯一状态源）：${run.taskFile || '未挂档案，请按原始任务与历史记录核实'}`,
    run.guardContract ? `守航契约：${run.guardContract}（原授权范围继续有效，切换不扩大权限）` : '',
    run.callerRunId ? `委托者会话：${run.callerRunId}；完成后按原协作协议交回，不重复派工。` : '',
    `【原始任务】\n${clip(run.instruction, 6000)}`,
    snap ? `【最近进度快照（可能过时，先核实）】\n${clip(JSON.stringify(snap), 5000)}` : '【没有进度快照】先读取现有文件、任务档案和实施记录，确认已完成/未完成事项；不要凭摘要猜测。',
    run.ccChildren?.length ? `【协作子任务】\n${clip(JSON.stringify(run.ccChildren), 1500)}\n这些子任务仍保留各自基座，不要重复派出。` : '',
    `【最近对话摘录，非完整历史】\n${messages.slice(-6).join('\n\n')}`,
    `【最近工具调用，结果须核实】\n${tools.slice(-12).join('\n')}`,
    run.result ? `【最近收尾/错误】\n${clip(run.result, 2000)}` : '',
    note.trim() ? `【本次接手补充】\n${note.trim()}` : '',
    '先简述核实后的已完成事项与下一步，再继续剩余工作；遇到待拍板事项仍交给用户，不把基座切换当成批准。',
  ].filter(Boolean).join('\n\n')
}

async function settleWithin(work, timeoutMs) {
  let timer
  try {
    await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new HandoverError('旧执行流尚未退出，未启动新基座。请稍后重试交接；不要同时另起同一任务。')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

export async function handoverRun(run, request, deps) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new HandoverError('交接请求格式无效', 400)
  const { engine, model = '', note = '', expectedEngine } = request
  const from = run.engine || 'claude'
  if (!deps.engineIds.includes(engine)) throw new HandoverError('请选择有效的目标基座', 400)
  if (engine === from) throw new HandoverError('目标基座与当前相同，请选择另一基座', 400)
  if (expectedEngine !== from) throw new HandoverError('当前基座已变化，请刷新后重新选择')
  if (typeof model !== 'string' || model.length > 200 || /[\r\n\0]/.test(model) || typeof note !== 'string' || note.length > 8000) throw new HandoverError('模型或交接补充格式无效', 400)
  if (run._handoverBusy) throw new HandoverError('这条任务正在交接，请勿重复提交')
  deps.checkBusy(run)
  run._handoverBusy = true
  run.engineHandoverPending = { from, to: engine, at: new Date().toISOString() }
  run._userStopped = true
  run.userStoppedAt = new Date().toISOString()
  run._takeoverPrompt = null
  run.bootResumePending = undefined
  run._bgResumePending = null
  try {
    deps.save()
    deps.cancel(run)
    // A UI terminal status/liveRuns deletion is not proof of process shutdown.
    if (run._q && !run._streamPromise) throw new HandoverError('无法确认旧执行流已退出，未启动新基座')
    await settleWithin(Promise.all([run._streamPromise, run._chainPromise,
      ...Array.from(run._hostTools || [], p => p.catch(() => {})),
    ]), deps.timeoutMs ?? 15000)
    deps.checkBusy(run)
    const seed = deps.buildSeed(run, note)
    const previous = { engine: from, sessionId: run.sessionId || null, model: run.model || null, to: engine, at: new Date().toISOString() }
    run.engineHistory = [...(run.engineHistory || []), previous]
    run.engine = engine
    run.model = model.trim() || null
    run.sessionId = null
    run.engineHandoverSeed = seed
    run.result = ''; run.isError = false; run.stalled = false
    run._poisoned = false; run._spinReseeds = 0; run._retries = 0; run._thinkNudge = false
    run._queuedCount = 0; run._pendingQueuedAccept = 0
    run.engineHandoverPending = undefined
    run._userStopped = false
    run.status = 'interrupted'
    run.updatedAt = previous.at
    deps.save()
    deps.event(run, `已从 ${from} 转交 ${engine}。保留任务、历史与协作关联；新基座先核实已有进度再继续。`)
    deps.start(run)
    return { ok: true, runId: run.id, engine }
  } catch (error) {
    if (run.engineHandoverPending) run.engineHandoverPending.error = error.message
    run.status = 'interrupted'; run.activity = ''; run.updatedAt = new Date().toISOString()
    deps.save()
    deps.event(run, `基座交接未完成：${error.message}`)
    throw error
  } finally { run._handoverBusy = false }
}
