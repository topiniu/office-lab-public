import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const socket = createServer()
socket.listen(0, '127.0.0.1')
await once(socket, 'listening')
const { port } = socket.address()
await new Promise(resolve => socket.close(resolve))

const runs = await mkdtemp(join(tmpdir(), 'office-lab-smoke-'))
const base = 'http://127.0.0.1:' + port
const child = spawn(process.execPath, ['scripts/bootstrap.mjs', '--start-only', '--no-open', '--port', String(port)], {
  env: { ...process.env, OFFICE_LAB_RUNS_DIR: runs },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const stopped = once(child, 'exit')

async function json(path, options) {
  const response = await fetch(base + path, options)
  assert.equal(response.status, 200, path)
  return response.json()
}

try {
  for (let attempt = 0; ; attempt++) {
    try {
      assert.equal((await json('/api/health')).ok, true)
      break
    } catch (error) {
      if (child.exitCode !== null || attempt >= 50) throw error
      await delay(200)
    }
  }
  assert.deepEqual(Object.keys(await json('/api/employees')).sort(), ['bobby', 'feifei', 'ggbond', 'mihu'])
  assert.deepEqual(await json('/api/tasks?slim=1'), [])
  assert.deepEqual(await json('/api/runs'), [])
  const config = await json('/api/engine-config')
  assert.deepEqual(config.engines.map(({ id }) => id).sort(), ['claude', 'codex'])
  assert.equal(config.providers.claude.model, '')
  const saved = await json('/api/engine-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ ...config, defaultEngine: 'codex' }),
  })
  assert.equal(saved.defaultEngine, 'codex')
  assert.equal((await json('/api/engine-config')).defaultEngine, 'codex')

  const html = await (await fetch(base)).text()
  const entry = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
  assert.ok(entry, 'expected the built workbench at the engine URL')
  assert.equal((await fetch(base + entry)).status, 200)
  assert.equal((await fetch(base + '/api/dispatch', { method: 'POST', headers: { Origin: 'https://example.test' } })).status, 403)
  console.log('Fresh workbench, four employees, model settings and origin check passed.')
} finally {
  child.kill()
  await stopped
  await rm(runs, { recursive: true, force: true })
}
