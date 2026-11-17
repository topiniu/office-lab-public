import fs from 'node:fs'
import path from 'node:path'
export const ENGINE_DEFAULTS = {
  defaultEngine: 'claude',
  providers: {
    claude: { model: '' },
    codex: { model: '', command: 'codex', reasoningEffort: 'medium' },
  },
}
export function validateEngineConfig(value, engineIds = ['claude', 'codex']) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('引擎设置必须为对象')
  if (!engineIds.includes(value.defaultEngine)) throw new Error('未知默认引擎')
  if (!value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) throw new Error('缺少引擎配置')
  for (const [id, config] of Object.entries(value.providers)) {
    if (!engineIds.includes(id)) throw new Error(`未知引擎：${id}`)
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`无效配置：${id}`)
    if (config.disabled !== undefined && typeof config.disabled !== 'boolean') throw new Error(`无效停用标记：${id}`)
    if (typeof config.model !== 'string' || config.model.length > 200 || /[\r\n\0]/.test(config.model)) throw new Error('无效模型 ID')
    if (id === 'codex') {
      if (typeof config.command !== 'string' || !config.command.trim() || /[\r\n\0]/.test(config.command)) throw new Error('请填写 Codex 可执行文件路径')
      if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(config.reasoningEffort)) throw new Error('无效 Codex 思考强度')
    }
  }
  if (!value.providers[value.defaultEngine]) throw new Error('默认引擎未配置')
  if (value.providers[value.defaultEngine].disabled) throw new Error('默认引擎已停用，请先改默认引擎')
  return structuredClone(value)
}
export function createEngineConfigStore(file, engineIds) {
  let current = structuredClone(ENGINE_DEFAULTS)
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    current = validateEngineConfig({ ...current, ...saved, providers: { ...current.providers, ...saved.providers } }, engineIds)
  }
  return {
    get: () => structuredClone(current),
    set(value) {
      const next = validateEngineConfig(value, engineIds)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const temp = `${file}.tmp-${process.pid}`
      try { fs.writeFileSync(temp, JSON.stringify(next, null, 2)); fs.renameSync(temp, file) }
      finally { try { fs.unlinkSync(temp) } catch {} }
      current = next
      return this.get()
    },
  }
}
// providers.<id>.disabled=true 停用该基座：新会话/派工/交接目标均不可选，已有会话不可续跑（仍可交接回启用基座）。
export const enabledEngineIds = (config, engineIds) => engineIds.filter(id => !config.providers[id]?.disabled)
// Old records always belong to Claude, regardless of today's default.
export const engineForRun = run => run.engine || 'claude'
export function selectNewEngine({ engine, employeeEngine, callerEngine, config }, engineIds) {
  const selected = engine || employeeEngine || callerEngine || config.defaultEngine
  if (!engineIds.includes(selected)) throw new Error(`未知执行引擎：${selected}`)
  return selected
}
