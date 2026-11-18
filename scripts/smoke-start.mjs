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
  env: { ...process.env, OFFICE_LAB_RUNS_DIR: runs, OFFICE_LAB_API_TARGET: base },
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
  assert.deepEqual(Object.keys(await json('/api/employees')).sort(), ['bobby', 'chaorenq', 'feifei', 'feisila', 'ggbond', 'mihu'])
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

  assert.ok((await (await fetch(base)).text()).includes('app.js'), 'expected the original legacy UI at the engine URL')
  const ui = 'http://127.0.0.1:4700'
  let html = ''
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(ui)
      if (response.ok) { html = await response.text(); break }
    } catch {}
    await delay(200)
  }
  const entry = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
  assert.ok(entry, 'expected the original built workbench on port 4700')
  assert.equal((await fetch(ui + entry)).status, 200)
  const proxiedHealth = await (await fetch(ui + '/api/health')).json()
  assert.equal(proxiedHealth.port, port, 'new UI must proxy to the isolated engine')
  for (const employee of ['feifei', 'ggbond', 'mihu', 'bobby', 'feisila', 'chaorenq']) {
    const detail = await json('/api/employees/' + employee + '/detail')
    assert.ok(detail.description.length > 10, employee + ' agent frontmatter')
    assert.ok(detail.roleMd.length > 1000, employee + ' full SOP')
    assert.ok(detail.agentMd.length > 1000, employee + ' full agent card')
    assert.equal(detail.lessonCount, 0)
  }
  console.log('Original new and legacy UIs, six full SOPs, empty runtime and model settings passed.')
} finally {
  child.kill()
  await stopped
  await rm(runs, { recursive: true, force: true })
}
