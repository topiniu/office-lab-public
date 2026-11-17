import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolveCodexExecutable } from './executable.js'
export class AsyncQueue {
  values = []; waiting = []; ended = false; error = null
  push(value) {
    if (this.ended) return
    const waiter = this.waiting.shift()
    if (waiter) waiter.resolve({ value, done: false }); else this.values.push(value)
  }
  end(error) {
    if (this.ended) return
    this.ended = true; this.error = error
    for (const waiter of this.waiting.splice(0)) error ? waiter.reject(error) : waiter.resolve({ done: true })
  }
  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false })
    if (this.ended) return this.error ? Promise.reject(this.error) : Promise.resolve({ done: true })
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }))
  }
  [Symbol.asyncIterator]() { return this }
}
// One stdio child per live Lab session. No shell interpolation or TCP listener.
export class CodexRpc {
  constructor({ command = 'codex', args = ['app-server', '--listen', 'stdio://'], cwd, env, spawnProcess = spawn, timeoutMs = 30000, closeTimeoutMs = 5000, onDiagnostic = () => {} }) {
    this.pending = new Map(); this.seq = 0; this.closed = false; this.timeoutMs = timeoutMs
    this.closeTimeoutMs = closeTimeoutMs; this.onDiagnostic = onDiagnostic; this.stderrBytes = 0
    this.child = spawnProcess(resolveCodexExecutable(command, { env: env || process.env }), args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    // 'close' also waits for inherited stdio handles in descendants. The owned
    // process may already be gone while that event never arrives.
    this.exited = new Promise(resolve => { this.resolveExit = resolve })
    this.diagnose('spawn')
    this.lines = createInterface({ input: this.child.stdout })
    this.lines.on('line', line => {
      let message
      try { message = JSON.parse(line) } catch { this.fail(new Error('Codex 返回了无效 JSON-RPC 数据')); return }
      if (message.method) {
        if (message.id !== undefined) {
          Promise.resolve().then(() => this.onRequest?.(message.method, message.params || {}))
            .then(result => this.send({ id: message.id, result: result ?? {} }))
            .catch(error => this.send({ id: message.id, error: { code: -32603, message: error.message } }))
        } else {
          try { this.onNotification?.(message.method, message.params || {}) } catch (error) { this.fail(error) }
        }
        return
      }
      const entry = this.pending.get(message.id)
      if (!entry) return
      clearTimeout(entry.timer); this.pending.delete(message.id)
      this.diagnose('response', { method: entry.method, elapsedMs: Date.now() - entry.startedAt, ok: !message.error })
      message.error ? entry.reject(new Error(message.error.message || JSON.stringify(message.error))) : entry.resolve(message.result)
    })
    // Raw stderr may contain paths/account data; don't expose it in the UI.
    this.child.stderr.on('data', data => { this.stderrBytes += data.length })
    this.child.stdin.on('error', error => this.fail(error))
    this.child.on('error', error => {
      if (!this.child.pid) this.resolveExit()
      this.diagnose('process-error', { code: error.code })
      this.fail(new Error(`无法启动 Codex：${error.message}`))
    })
    this.child.on('exit', (code, signal) => {
      this.resolveExit(); this.diagnose('process-exit', { code, signal, stderrBytes: this.stderrBytes })
      if (!this.closed) this.fail(new Error(`Codex 进程退出（${code ?? signal}）`))
    })
    this.child.on('close', (code, signal) => { this.diagnose('stdio-close', { code, signal }) })
  }
  diagnose(event, fields = {}) {
    try { this.onDiagnostic({ event, pid: this.child.pid ?? null, ...fields }) } catch { /* Logging must not affect execution. */ }
  }
  send(message) { if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n') }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Codex 连接已关闭'))
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.diagnose('request-timeout', { method }); reject(new Error(`Codex ${method} 超时`)) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method, startedAt: Date.now() }); this.diagnose('request', { method }); this.send({ id, method, params })
    })
  }
  fail(error) { if (this.closed) return; this.close(error); this.onError?.(error) }
  close(error = new Error('Codex 连接已关闭')) {
    if (this.closed) return this.closePromise || this.exited
    this.closed = true
    this.diagnose('close-start', { pendingRequests: this.pending.size })
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear(); this.lines.close()
    this.child.stdin.end()
    let killedTree = Promise.resolve()
    const alive = this.child.pid && this.child.exitCode === null && this.child.signalCode === null
    if (process.platform === 'win32' && alive) {
      // Kill only our owned app-server tree, including in-flight native commands.
      const killer = spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' })
      killedTree = new Promise(resolve => {
        killer.on('error', () => { this.child.kill(); resolve() })
        killer.on('close', code => { this.diagnose('tree-stop', { code }); if (code) this.child.kill(); resolve() })
      })
    } else if (alive) {
      try { if (this.child.pid) process.kill(-this.child.pid, 'SIGTERM'); else this.child.kill() }
      catch { this.child.kill() }
    }
    const bounded = (promise, label) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.diagnose('close-timeout', { phase: label }); reject(new Error(`Codex 关闭超时：${label}`)) }, this.closeTimeoutMs)
      promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
    this.closePromise = (async () => {
      try {
        await bounded(Promise.all([this.exited, killedTree]), 'process-exit')
      } finally {
        // Once the owned process has exited, release inherited pipes locally.
        // Never wait indefinitely for an unrelated holder to close them.
        if (!this.child.pid || this.child.exitCode !== null || this.child.signalCode !== null) {
          this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy()
        }
      }
      this.diagnose('close-complete')
    })()
    // fail() initiates cleanup without awaiting; callers still receive rejection.
    this.closePromise.catch(() => {})
    return this.closePromise
  }
}
