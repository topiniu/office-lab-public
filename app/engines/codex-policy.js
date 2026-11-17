import path from 'node:path'

export function protectedCodeRoots(options) {
  return options.protectedCodeRoots ?? ['frontend']
}

export function codexExecutionPolicy(options, noTools = false) {
  // Explicit read-only consultations and tool-less auxiliaries never inherit staff bypass.
  if (options.readOnly || noTools) return { approvalPolicy: 'never', sandbox: 'read-only' }
  if (options.permissionMode === 'bypassPermissions') return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
  return { approvalPolicy: 'untrusted', sandbox: options.codeLocked ? 'read-only' : 'workspace-write' }
}

const glob = pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
export function matchesRule(rule, name, input, cwd) {
  const match = /^([^()]+)(?:\((.*)\))?$/.exec(rule)
  if (!match || match[1] !== name) return false
  if (match[2] === undefined) return true
  const pattern = match[2].replace(/:\*$/, '*')
  if (name === 'Bash') {
    const command = String(input.command || '')
    return [command, ...command.split(/(?:&&|\|\||[;\n])/).map(s => s.trim())].some(c => glob(pattern).test(c))
  }
  const file = path.resolve(cwd, input.file_path || '').replace(/\\/g, '/')
  const relative = path.relative(cwd, file).replace(/\\/g, '/')
  return [file, '/' + file, './' + relative, relative].some(p => glob(pattern).test(p))
}

export async function approveCodexAction(options, name, input) {
  const rules = options.settings?.permissions || {}
  const denied = (rules.deny || []).some(rule => matchesRule(rule, name, input, options.cwd))
  if (denied || options.readOnly || options.tools?.length === 0) return false
  // A command outside the sandbox could circumvent a non-coding role's code lock.
  if (options.codeLocked && name === 'Bash') return false
  if (name === 'Edit') {
    const relative = path.relative(options.cwd, path.resolve(options.cwd, input.file_path))
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false
    const normalized = relative.replace(/\\/g, '/').toLowerCase()
    if (options.codeLocked && protectedCodeRoots(options).some(root => {
      const prefix = root.toLowerCase()
      return normalized === prefix || normalized.startsWith(prefix + '/')
    })) return false
  }
  const ask = (rules.ask || []).some(rule => matchesRule(rule, name, input, options.cwd))
  if (!ask && options.permissionMode === 'bypassPermissions') return true
  if (!ask && name === 'Edit' && options.permissionMode === 'acceptEdits') return true
  // Let the Lab approval card decide all remaining native requests. No execpolicy
  // amendment/session-wide grant is returned, so a grant cannot bypass later deny.
  const callback = options.requestApproval || options.canUseTool
  if (!callback) return false
  const result = await callback(name, input, { signal: options.abortController?.signal })
  return result?.behavior === 'allow'
}
