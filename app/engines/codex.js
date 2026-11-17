import { CodexRpc, AsyncQueue } from './rpc.js'
import { toolCatalog } from './tools.js'
import { approveCodexAction, codexExecutionPolicy, protectedCodeRoots } from './codex-policy.js'
import { createHash, randomUUID } from 'node:crypto'
import { explicitWorkRequest, feedbackText } from '../user-input.js'
import { createCodexOwnerManager } from './codex-owner.js'

// Codex reserves mcp__ for its own MCP client. Keep Lab transcript names stable,
// but publish host tools under a separate, bounded model-facing namespace.
export function codexToolName(name) {
  const mapped = name.replace(/^mcp__/, 'lab__')
  return mapped.length <= 64 ? mapped : mapped.slice(0, 51) + '_' + createHash('sha256').update(name).digest('hex').slice(0, 12)
}

export function codexInput(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) throw new Error('Codex 输入必须为文字或内容块')
  return content.map(block => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'image' && block.source?.type === 'base64') return { type: 'image', url: `data:${block.source.media_type};base64,${block.source.data}` }
    if (block.type === 'image' && block.source?.url) return { type: 'image', url: block.source.url }
    throw new Error(`Codex 暂不支持输入块：${block.type}`)
  })
}

export function toolOutput(result) {
  const contentItems = (result?.content || []).map(block => {
    if (block.type === 'text') return { type: 'inputText', text: block.text }
    if (block.type === 'image') return { type: 'inputImage', imageUrl: `data:${block.mimeType};base64,${block.data}` }
    return { type: 'inputText', text: JSON.stringify(block) }
  })
  if (!contentItems.length) contentItems.push({ type: 'inputText', text: JSON.stringify(result ?? null) })
  return { success: !result?.isError, contentItems }
}

// Map Codex items into the persisted Lab transcript contract, not into SDK objects.
export function itemTool(item) {
  switch (item.type) {
    case 'commandExecution': return { name: 'Bash', input: { command: item.command, cwd: item.cwd } }
    case 'fileChange': return { name: 'Edit', input: { file_path: item.changes?.map(c => c.path).join(', '), changes: item.changes } }
    case 'mcpToolCall': return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments }
    case 'dynamicToolCall': return { name: item.tool, input: item.arguments }
    case 'imageView': return { name: 'Read', input: { file_path: item.path } }
    case 'webSearch': return { name: 'WebSearch', input: { query: item.query } }
    default: return null
  }
}

const writerConflictError = message => Object.assign(new Error(message), { code: 'CODEX_WRITER_CONFLICT' })

export async function* codexQuery({ prompt, options, rpcFactory = args => new CodexRpc(args),
  ownerManager = createCodexOwnerManager({ directory: options.codexOwnerDirectory, runId: options.env?.OFFICE_LAB_RUN }) }) {
  const output = new AsyncQueue()
  const signal = options.abortController?.signal
  if (signal?.aborted) throw new Error('Codex 已取消')
  const catalog = toolCatalog(options.mcpServers, options.allowedTools)
  const toolNames = new Map([...catalog.keys()].map(name => [codexToolName(name), name]))
  let threadId = null, turnId = null, completeTurn = null, failTurn = null, lastText = '', usage = null
  let feedbackAbort = new AbortController()
  let releaseOwner = async () => {}
  const diagnose = fields => {
    // Lifecycle metadata only: never log prompts, tool arguments, config or stderr.
    const record = { at: new Date().toISOString(), runId: options.env?.OFFICE_LAB_RUN || null, threadId, turnId, ...fields }
    try {
      if (options.onEngineDiagnostic) options.onEngineDiagnostic(record)
      else if (record.runId) console.error('[codex-rpc] ' + JSON.stringify(record))
    } catch { /* Diagnostic sinks must not affect the session. */ }
  }
  const rpc = rpcFactory({ command: options.engineConfig?.command || 'codex', cwd: options.cwd, env: options.env || process.env, onDiagnostic: diagnose })
  const items = new Map(), startedTools = new Set(), completedItems = new Set()
  const emit = event => output.push({ ...event, session_id: threadId })
  const assistant = (id, content) => emit({ type: 'assistant', parent_tool_use_id: null, message: { id, role: 'assistant', content } })
  const askUser = async question => {
    if (!options.requestUserInput) throw new Error('当前会话未接入 Lab 反馈通道；请用【等你拍板】明确等待事项，不要代答')
    if (!question?.question?.trim()) throw new Error('反馈问题不能为空')
    // Recovery can ask before thread/resume succeeds, with both native IDs null.
    // Each question must stay distinct across retries, queries and host restarts.
    const id = `codex-feedback-${randomUUID()}`
    const card = { type: 'gate', id, title: question.header || '需要你的反馈', question: question.question,
      options: (question.options || []).map(o => ({ label: o.label, reply: o.label, desc: o.description })) }
    // Register before publishing so an immediate click cannot race the waiter.
    const pending = options.requestUserInput(question, { signal: feedbackAbort.signal })
    assistant(id, [{ type: 'text', text: '```olcard\n' + JSON.stringify(card) + '\n```' }])
    return await pending
  }
  const fail = error => { feedbackAbort.abort(); failTurn?.(error); output.end(error); rpc.close() }
  const abort = () => {
    diagnose({ event: 'abort' })
    // Interrupt cooperatively first; close also guarantees a hung process cannot
    // keep the run alive. Lab's existing stream-end path handles takeover/reseed.
    if (threadId && turnId) rpc.send({ id: 'interrupt', method: 'turn/interrupt', params: { threadId, turnId } })
    fail(new Error('Codex 已取消'))
  }
  signal?.addEventListener('abort', abort, { once: true })
  rpc.onError = fail
  rpc.onRequest = async (method, params) => {
    if (params.threadId && params.threadId !== threadId) throw new Error('Unexpected Codex thread')
    if (method === 'item/tool/call') {
      if (params.tool === 'lab_request_user_input' && options.requestUserInput) {
        try { return toolOutput({ content: [{ type: 'text', text: await askUser(params.arguments) }] }) }
        catch (error) { return toolOutput({ isError: true, content: [{ type: 'text', text: error.message }] }) }
      }
      const entry = catalog.get(toolNames.get(params.tool))
      if (!entry) return toolOutput({ isError: true, content: [{ type: 'text', text: `工具未授权：${params.tool}` }] })
      try { return toolOutput(await entry.invoke(params.arguments, { signal })) }
      catch (error) { return toolOutput({ isError: true, content: [{ type: 'text', text: error.message }] }) }
    }
    if (method === 'item/commandExecution/requestApproval') {
      // Missing command / permission escalation / stdin must never be silently granted.
      const ok = params.command && !params.additionalPermissions && (!params.kind || params.kind === 'command') &&
        await approveCodexAction(options, 'Bash', { command: params.command, cwd: params.cwd })
      return { decision: ok ? 'accept' : 'decline' }
    }
    if (method === 'item/fileChange/requestApproval') {
      const changes = items.get(params.itemId)?.changes
      let ok = !!changes?.length && !params.grantRoot
      for (const change of changes || []) {
        if (!ok) break
        ok = await approveCodexAction(options, 'Edit', { file_path: change.path, diff: change.diff })
      }
      return { decision: ok ? 'accept' : 'decline' }
    }
    if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
    if (method === 'item/tool/requestUserInput') {
      // One card at a time keeps free text and choices bound to the correct id,
      // including clients that normally batch several cards into one reply.
      const answers = Object.create(null)
      for (const question of params.questions || []) {
        answers[question.id] = { answers: [await askUser(question)] }
      }
      return { answers }
    }
    if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null }
    throw new Error(`不支持的 Codex 请求：${method}`)
  }
  rpc.onNotification = (method, params) => {
    if (params.threadId && threadId && params.threadId !== threadId) return
    if (method === 'error' && !params.willRetry) { fail(new Error(params.error?.message || 'Codex 请求失败')); return }
    if (method === 'turn/started') { turnId = params.turn.id; diagnose({ event: 'turn-started' }); return }
    if (method === 'thread/tokenUsage/updated') { usage = params.tokenUsage?.last; return }
    if (method.endsWith('/delta')) { emit({ type: 'system', subtype: 'engine_activity' }); return }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item
      items.set(item.id, item)
      const tool = itemTool(item.type === 'dynamicToolCall' ? { ...item, tool: toolNames.get(item.tool) || item.tool } : item)
      if (tool && !startedTools.has(item.id)) {
        startedTools.add(item.id)
        assistant(item.id, [{ type: 'tool_use', id: item.id, ...tool }])
      }
      if (method !== 'item/completed' || completedItems.has(item.id)) return
      completedItems.add(item.id)
      if (item.type === 'agentMessage') {
        const text = options.requestUserInput ? feedbackText(item.text, item.id) : item.text
        lastText = text || lastText
        assistant(item.id, [{ type: 'text', text }])
      } else if (item.type === 'reasoning') {
        const text = (item.summary || []).join('\n')
        if (text) assistant(item.id, [{ type: 'thinking', thinking: text }])
      } else if (tool) {
        const content = item.aggregatedOutput ?? item.result?.content ?? item.contentItems?.map(c => c.text || '[图片]').join('\n') ?? item.diff ?? item.status ?? '完成'
        emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.id, content, is_error: ['failed', 'declined'].includes(item.status) || item.success === false }] } })
      }
      return
    }
    if (method === 'turn/completed') {
      feedbackAbort.abort()
      const turn = params.turn
      diagnose({ event: 'turn-completed', status: turn.status })
      const isError = turn.status !== 'completed'
      emit({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError,
        result: isError ? turn.error?.message || `Codex ${turn.status}` : lastText,
        ...(usage ? { usage: { input_tokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens), output_tokens: usage.outputTokens, cache_read_input_tokens: usage.cachedInputTokens, cache_creation_input_tokens: usage.cacheWriteInputTokens || 0 } } : {}),
      })
      turnId = null; completeTurn?.(); completeTurn = null; failTurn = null
    }
  }
  const work = async () => {
    await rpc.request('initialize', { clientInfo: { name: 'office_lab', title: 'Office Lab', version: '0.12.0' }, capabilities: { experimentalApi: true } })
    rpc.send({ method: 'initialized' })
    let system = typeof options.systemPrompt === 'string' ? options.systemPrompt : options.systemPrompt?.append || ''
    if (options.requestUserInput) system += options.resume
      ? '\n\n需要用户选择、补充或操作时，必须输出 OL 动作卡并以【等你拍板】具体事项收尾，用户回复后续跑；原生提问若可用也会接入 OL 卡片。不要把请求仅写在普通进度消息里。旧会话不一定具备 lab_request_user_input，不要调用未列出的工具。'
      : '\n\n需要用户选择、补充或操作时调用 lab_request_user_input，宿主会显示 OL 反馈卡并等待真实回复，然后在同一轮继续。不要把反馈请求仅写在普通进度消息里。'
    if (catalog.size) system += '\n\nOffice Lab 宿主工具名称映射（SOP 中的裸名对应下面实际工具名；不要自行拼 mcp__ 前缀）：\n' + [...toolNames].map(([actual, logical]) => `${logical} → ${actual}`).join('\n')
    const noTools = options.tools?.length === 0 || (options.allowedTools?.length > 0 && options.allowedTools.every(name => name.startsWith('mcp__')))
    const executionPolicy = codexExecutionPolicy(options, noTools)
    if (options.codeLocked) system += '\n\n你是非编码角色：可以读取文件、维护需求/发布文档和任务档案；不得修改业务代码（' + protectedCodeRoots(options).join('、') + '）。免审批执行不扩大你的职责或任务授权。'
    // Explicit thread overrides do not modify the user's Codex settings.
    const config = { 'agents.enabled': false, 'features.multi_agent': false, 'features.multi_agent_v2': false,
      'features.apps': false, 'plugins._default.enabled': false, 'web_search': noTools ? 'disabled' : 'live',
      'features.shell_tool': !noTools, 'features.unified_exec': !noTools, 'features.code_mode': false,
      'project_doc_fallback_filenames': ['agents.md', 'CLAUDE.md'],
    }
    // Disable ambient MCP servers; expose only the tools mounted for this role.
    const effective = await rpc.request('config/read', { includeLayers: false })
    config.plugins = Object.fromEntries(['_default', ...Object.keys(effective.config?.plugins || {})].map(name => [name, { enabled: false }]))
    for (const name of Object.keys(effective.config?.mcp_servers || {})) {
      if (!/^[\w-]+$/.test(name)) throw new Error(`Codex MCP 服务名不支持配置覆盖：${name}`)
      config[`mcp_servers.${name}.enabled`] = false
    }
    for (const [name, server] of Object.entries(options.mcpServers || {})) {
      if (server.type === 'http') {
        if (!/^[\w-]+$/.test(name)) throw new Error(`Codex MCP 服务名不支持配置覆盖：${name}`)
        config[`mcp_servers.${name}`] = { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}), enabled: true }
      }
      else if (server.type !== 'lab') throw new Error(`Codex 不支持 MCP 传输：${server.type}`)
    }
    const params = { cwd: options.cwd, ...executionPolicy, approvalsReviewer: 'user',
      developerInstructions: system + '\n\nOffice Lab 通过宿主工具进行员工交接。不要派生原生子代理。SOP 中 Read/Bash/Edit 等名称表示读文件、执行命令、编辑文件的职责，请使用本引擎对应工具。', config,
      ...(options.model ? { model: options.model } : {}),
    }
    const dynamicTools = [
        ...[...catalog.values()].map(({ name, description, inputSchema }) => ({ type: 'function', name: codexToolName(name), description, inputSchema })),
        ...(options.requestUserInput ? [{ type: 'function', name: 'lab_request_user_input', description: '需要用户选择、补充信息或完成手动操作时，显示 OL 反馈卡，等待真实回复后继续。不能用于职责内应自行完成的工作。', inputSchema: {
          type: 'object', properties: { question: { type: 'string' }, header: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'], additionalProperties: false } } }, required: ['question'], additionalProperties: false,
        } }] : []),
      ]
    let opened
    if (!options.resume) opened = await rpc.request('thread/start', { ...params, dynamicTools })
    else {
      // A desktop app can load an idle Lab thread and hold its writer lock.
      // Never steal that lock or fork automatically: the other host might still
      // be editing the same workspace. Ask through the real feedback channel.
      let recoveryNote = ''
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // Resume retains its original catalog; dynamicTools is start-only.
          opened = await rpc.request('thread/resume', { ...params, threadId: options.resume, excludeTurns: true })
          break
        } catch (error) {
          if (!/^thread [\w-]+ already has an active writer\b/i.test(error.message)) throw error
          diagnose({ event: 'writer-conflict', sourceThreadId: options.resume, attempt })
          const message = (recoveryNote ? recoveryNote + '\n\n' : '') + '原 Codex 会话仍有执行端持锁，本次任务尚未开始。同一个 Lab 窗口也可能遇到旧执行端占用。可强制停止本条 Lab 登记的旧执行端并重试；Codex 桌面共享后台及其他会话会保留。也可释放占用后重试，或确认原执行端已停止后复制历史接回。'
          if (!options.requestUserInput || attempt === 3) throw writerConflictError(message + ' 原会话和本次输入均已保留，请释放占用后再继续。')
          const answer = await askUser({ header: '会话执行端被占用', question: message, options: [
            ...(ownerManager ? [{ label: '强制停止本条旧执行端并重试', description: '仅停止本条 Lab 登记的进程，保留桌面共享后台与其他会话' }] : []),
            { label: '已释放占用，重试原会话' },
            { label: '已停止另一端，复制历史接回', description: '保留 Lab 会话及历史上下文，改用新的 Codex 会话编号' },
            { label: '稍后处理' },
          ] })
          if (answer === '强制停止本条旧执行端并重试' && ownerManager) {
            try {
              const result = await ownerManager.stop(options.resume, { signal })
              recoveryNote = result.reason
              emit({ type: 'system', subtype: 'writer_recovery_status', text: recoveryNote })
            } catch (stopError) { throw writerConflictError(`旧执行端强停未完成：${stopError.message}；已停止接回，原会话保留。`) }
            continue
          }
          if (answer === '已释放占用，重试原会话') continue
          if (answer !== '已停止另一端，复制历史接回') throw writerConflictError('会话占用尚未解除，已暂停接回；原会话和本次输入均已保留。')
          if (signal?.aborted) throw new Error('Codex 已取消')
          try {
            opened = await rpc.request('thread/fork', { ...params, threadId: options.resume, excludeTurns: true, deferGoalContinuation: true })
            if (!opened.thread?.id || opened.thread.id === options.resume) throw new Error('未返回新的历史分支')
          } catch (forkError) {
            throw writerConflictError(`复制历史接回失败：${forkError.message}；原会话仍保留，已停止接回。`)
          }
          threadId = opened.thread.id
          emit({ type: 'system', subtype: 'session_recovered', sourceThreadId: options.resume })
          break
        }
      }
    }
    threadId = opened.thread.id
    if (ownerManager) {
      try { releaseOwner = await ownerManager.register(rpc, threadId, () => fail(writerConflictError('本条旧执行端已被用户强制停止，不再自动续跑。'))) }
      catch { diagnose({ event: 'owner-register-failed' }) }
    }
    emit({ type: 'system', subtype: 'init', model: opened.model || options.model || '', permissionMode: options.permissionMode, ...executionPolicy })
    const source = typeof prompt === 'string' ? [prompt] : prompt
    for await (const message of source) {
      if (signal?.aborted || output.ended) break
      lastText = ''; usage = null; items.clear(); startedTools.clear(); completedItems.clear()
      feedbackAbort = new AbortController()
      const content = typeof message === 'string' ? message : message.message.content
      const intentText = typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => b.text).join('\n')
      emit({ type: 'system', subtype: 'execution_intent', requiresSignoff: explicitWorkRequest(intentText) })
      const done = new Promise((resolve, reject) => { completeTurn = resolve; failTurn = reject })
      // Attach rejection handling before a failed turn/start can race cancellation.
      done.catch(() => {})
      await rpc.request('turn/start', { threadId, input: codexInput(typeof message === 'string' ? message : message.message.content), effort: options.engineConfig?.reasoningEffort || 'medium' })
      await done
    }
    diagnose({ event: 'input-ended' })
    output.end()
  }
  work().catch(fail)
  try { yield* output }
  finally {
    feedbackAbort.abort(); diagnose({ event: 'stream-finally' }); signal?.removeEventListener('abort', abort)
    await rpc.close()
    try { await releaseOwner() } catch { diagnose({ event: 'owner-release-failed' }) }
    output.end(); completeTurn?.()
  }
}
