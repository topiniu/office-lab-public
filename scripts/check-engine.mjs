// Explicit live smoke test. Uses a throwaway directory and no business tools.
// node scripts/check-engine.mjs codex --live [--command ABSOLUTE_CODEX_EXE]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { engines } from '../app/engines/index.js'
import { CodexRpc } from '../app/engines/rpc.js'
import { tool, createToolServer } from '../app/engines/tools.js'

const engine = process.argv[2] || 'codex'
if (!engines.ids().includes(engine)) throw new Error('Expected claude or codex')
const commandFlag = process.argv.indexOf('--command')
const command = commandFlag >= 0 ? process.argv[commandFlag + 1] : 'codex'
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'office-lab-engine-smoke-'))
const abortController = new AbortController()
const timer = setTimeout(() => abortController.abort(), 90000)
try {
  if (!process.argv.includes('--live')) {
    if (engine !== 'codex') throw new Error('Claude smoke requires --live')
    const rpc = new CodexRpc({ command, cwd, env: process.env })
    try {
      await rpc.request('initialize', { clientInfo: { name: 'office_lab_smoke', version: '0.12.0' }, capabilities: { experimentalApi: true } })
      rpc.send({ method: 'initialized' })
      const models = await rpc.request('model/list', {})
      console.log(JSON.stringify({ engine, protocol: 'ok', modelCount: models.data?.length || 0 }))
    } finally { await rpc.close() }
  } else {
    if (process.argv.includes('--tools')) {
      const nonce = crypto.randomBytes(12).toString('hex')
      let called = 0, sessionId = null
      const options = { engine, engineConfig: { command, reasoningEffort: 'low' }, cwd, tools: [], settingSources: [], abortController, allowedTools: ['mcp__smoke__nonce'],
        systemPrompt: 'You are a tool protocol tester. Use the provided host tool when asked. Never use native filesystem, shell or network tools.',
        mcpServers: { smoke: createToolServer({ name: 'smoke', tools: [tool('nonce', 'Return a fresh test nonce. No arguments.', {}, async () => { called++; return { content: [{ type: 'text', text: nonce }] } })] }) },
      }
      let rounds = 0
      let releaseFirstTurn
      const firstTurnDone = new Promise(resolve => { releaseFirstTurn = resolve })
      async function* prompts() {
        yield { type: 'user', message: { role: 'user', content: 'Call mcp__smoke__nonce once and reply with its exact result.' }, parent_tool_use_id: null }
        // Claude eagerly consumes the input stream and may coalesce queued text.
        // A real hot follow-up arrives only after the preceding result.
        await firstTurnDone
        yield { type: 'user', message: { role: 'user', content: 'Repeat the same nonce from the previous turn without calling any tool.' }, parent_tool_use_id: null }
      }
      for await (const event of engines.query({ prompt: prompts(), options })) {
        if (event.session_id) sessionId = event.session_id
        if (event.type === 'result') {
          if (event.is_error || !event.result?.includes(nonce)) throw new Error('Tool/hot-turn verification failed')
          rounds++
          releaseFirstTurn()
        }
      }
      if (rounds !== 2 || called !== 1 || !sessionId) throw new Error(`Expected one tool call and two completed turns; got calls=${called}, turns=${rounds}`)
      console.log(JSON.stringify({ engine, hostTool: 'ok', hotTurns: rounds }))
      let recovered = false
      for await (const event of engines.query({ prompt: 'Repeat the nonce from our previous conversation, without calling a tool.', options: { ...options, resume: sessionId } })) {
        if (event.type === 'result') { recovered = !event.is_error && event.result?.includes(nonce); break }
      }
      if (!recovered || called !== 1) throw new Error('Cold resume verification failed')
      console.log(JSON.stringify({ engine, coldResume: 'ok' }))
    } else {
    let result
    for await (const event of engines.query({ prompt: 'Reply only OFFICE_LAB_ENGINE_OK. Do not call any tools.', options: {
      engine, engineConfig: { command, reasoningEffort: 'low' }, cwd,
      systemPrompt: 'You are a connectivity test assistant. Reply with the requested phrase.',
      tools: [], settingSources: [], maxTurns: 1, abortController,
    } })) {
      if (event.type === 'system' && event.subtype === 'init') console.log(JSON.stringify({ engine, initialized: true, model: event.model }))
      if (event.type === 'result') { result = event; break }
    }
    if (!result || result.is_error || !result.result?.includes('OFFICE_LAB_ENGINE_OK')) throw new Error(result?.result || 'No successful result')
    console.log(JSON.stringify({ engine, inference: 'ok' }))
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { clearTimeout(timer); fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
