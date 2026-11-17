import fs from 'node:fs'
import path from 'node:path'

// Desktop updates replace the hashed bin directory. Recover only that known
// managed location; a missing custom executable must still fail visibly.
export function resolveCodexExecutable(command = 'codex', { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || fs.existsSync(command)) return command
  const local = env.LOCALAPPDATA
  if (!local) return command
  const bin = path.join(local, 'OpenAI', 'Codex', 'bin')
  const bare = command === 'codex' || command === 'codex.exe'
  const managed = path.basename(command).toLowerCase() === 'codex.exe' &&
    /^[a-f0-9]{16}$/i.test(path.basename(path.dirname(command))) &&
    path.resolve(path.dirname(path.dirname(command))).toLowerCase() === path.resolve(bin).toLowerCase()
  if (!bare && !managed) return command
  if (bare) {
    for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), 'codex.exe')
      try { if (fs.statSync(candidate).isFile()) return candidate } catch {}
    }
  }
  try {
    const candidates = fs.readdirSync(bin, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[a-f0-9]{16}$/i.test(entry.name))
      .map(entry => {
        const file = path.join(bin, entry.name, 'codex.exe')
        try { const stat = fs.statSync(file); return stat.isFile() ? { file, at: fs.statSync(path.dirname(file)).mtimeMs } : null } catch { return null }
      }).filter(Boolean).sort((a, b) => b.at - a.at || a.file.localeCompare(b.file))
    return candidates[0]?.file || command
  } catch { return command }
}
