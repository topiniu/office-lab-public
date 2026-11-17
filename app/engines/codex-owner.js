import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const liveOwners = new Map()
const validId = value => /^[\w-]{1,160}$/.test(value || '')

// Persist identity, not just PID: Windows can reuse a PID after a restart.
// The desktop app-server is shared and deliberately fails isStandalone.
const inspectScript = pid => `
$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop
if ($null -eq $p) { 'null'; exit }
$standalone = ($p.Name -ieq 'codex.exe') -and ($p.CommandLine -match '\\bapp-server\\s+--listen\\s+stdio://(?:\\s|$)')
@{ pid=[int]$p.ProcessId; parentPid=[int]$p.ParentProcessId; startedAt=$p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString(); executable=$p.ExecutablePath; isStandalone=[bool]$standalone } | ConvertTo-Json -Compress
`
const ps = async (script, signal) => {
  try {
    const source = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8\n" + script
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) })
    return JSON.parse(stdout.trim())
  } catch (error) {
    // execFile errors include the full encoded script and native stderr. Neither
    // belongs in the human-facing feedback card.
    throw new Error(signal?.aborted ? '操作已取消' : '无法核验或停止登记的执行端，可能权限不足、进程身份变化或操作超时；未扩大停止范围。')
  }
}
export async function inspectCodexOwner(pid, signal) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return null
  return ps(inspectScript(pid), signal)
}
const sameProcess = (a, b) => !!a && !!b && a.pid === b.pid && a.startedAt === b.startedAt &&
  a.executable?.toLowerCase() === b.executable?.toLowerCase() && a.isStandalone === true && b.isStandalone === true

async function terminateCodexOwner(identity, signal) {
  const executable = Buffer.from(identity.executable, 'utf8').toString('base64')
  // Recheck in the killing process too. Never accept a PID from UI/model input.
  return ps(`
$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${identity.pid}" -ErrorAction Stop
if ($null -eq $p) { 'true'; exit }
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${executable}'))
if (($p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() -ne '${identity.startedAt}') -or ($p.ExecutablePath -ine $expected) -or ($p.Name -ine 'codex.exe') -or ($p.CommandLine -notmatch '\\bapp-server\\s+--listen\\s+stdio://(?:\\s|$)')) { throw 'Codex process identity changed; refusing to stop' }
& taskkill.exe /PID ${identity.pid} /T /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not stop owned Codex process tree' }
'true'
`, signal)
}

export function createCodexOwnerManager({ directory, runId, inspect = inspectCodexOwner, terminate = terminateCodexOwner, parentPid = process.pid } = {}) {
  if (!directory || !validId(runId)) return null
  const fileFor = threadId => {
    if (!validId(threadId)) throw new Error('Invalid Codex thread identity')
    return path.join(directory, `${runId}--${threadId}.json`)
  }
  const read = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
  return {
    async register(rpc, threadId, onForcedStop) {
      const identity = await inspect(rpc.child?.pid)
      if (!identity?.isStandalone || identity.pid !== rpc.child?.pid || identity.parentPid !== parentPid) return () => {}
      const file = fileFor(threadId), token = randomUUID()
      const record = { runId, threadId, token, identity }
      await fs.mkdir(directory, { recursive: true })
      const tmp = file + '.' + token + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(record), { flag: 'wx' })
      try { await fs.rename(tmp, file) } finally { await fs.rm(tmp, { force: true }) }
      liveOwners.set(file, { token, rpc, onForcedStop })
      return async () => {
        if (liveOwners.get(file)?.token === token) liveOwners.delete(file)
        if ((await read(file))?.token === token) await fs.rm(file, { force: true })
      }
    },
    async stop(threadId, { signal } = {}) {
      const file = fileFor(threadId), record = await read(file)
      if (!record || record.runId !== runId || record.threadId !== threadId) return { stopped: false, reason: '未找到本条 Lab 会话登记的旧执行端。占用可能来自 Codex 桌面共享后台；共享后台会保留，不会停止其他会话。' }
      const current = await inspect(record.identity?.pid, signal)
      if (signal?.aborted) throw new Error('强制停止已取消')
      if (!current) { await fs.rm(file, { force: true }); return { stopped: true, reason: '登记的旧执行端已经退出，正在重试原会话。' } }
      if (!sameProcess(record.identity, current)) return { stopped: false, reason: '旧执行端身份已变化，未停止任何进程；Codex 桌面共享后台与其他会话保持运行。' }
      const live = liveOwners.get(file)
      if (live?.token === record.token) {
        live.onForcedStop?.()
        await live.rpc.close()
      } else {
        if (await terminate(current, signal) !== true) throw new Error('未确认旧执行端已停止')
      }
      // Native resume remains the final check that writer ownership was released.
      if ((await read(file))?.token === record.token) await fs.rm(file, { force: true })
      return { stopped: true, reason: '本条 Lab 旧执行端已停止，正在恢复原会话。' }
    },
  }
}
