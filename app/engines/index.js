import { claudeQuery } from './claude.js'
import { codexQuery } from './codex.js'
export { tool, createToolServer } from './tools.js'
export { createEngineConfigStore, engineForRun, selectNewEngine, enabledEngineIds } from './config.js'
// Stable Lab event contract: assistant/content, user/tool_result, system/init,
// result. New providers implement query(), not business workflow branches.
export function createEngineRegistry(adapters = []) {
  const entries = new Map()
  const registry = {
    register(adapter) {
      if (!/^[a-z][a-z0-9-]*$/.test(adapter.id) || typeof adapter.query !== 'function') throw new Error('Invalid engine adapter')
      if (entries.has(adapter.id)) throw new Error(`Engine already registered: ${adapter.id}`)
      entries.set(adapter.id, adapter)
    },
    list: () => [...entries.values()].map(({ query, ...metadata }) => metadata),
    ids: () => [...entries.keys()],
    query({ prompt, options }) {
      const adapter = entries.get(options.engine)
      if (!adapter) throw new Error(`未知执行引擎：${options.engine}`)
      return adapter.query({ prompt, options })
    },
  }
  adapters.forEach(registry.register)
  return registry
}
export const engines = createEngineRegistry([
  { id: 'claude', label: 'Claude Code', query: claudeQuery },
  { id: 'codex', label: 'Codex', query: codexQuery },
])
