import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCodexOwnerManager } from '../engines/codex-owner.js'

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-owner-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const state = { current: { pid: 123, parentPid: 17, startedAt: '123456', executable: 'C:\\codex.exe', isStandalone: true }, kills: [], closes: 0, stops: 0 }
  const settings = { directory, runId: 'run-one', parentPid: 17, inspect: async () => state.current,
    terminate: async identity => { state.kills.push(identity); state.current = null; return true } }
  const rpc = { child: { pid: 123 }, async close() { state.closes++; state.current = null } }
  const manager = createCodexOwnerManager(settings)
  const release = await manager.register(rpc, 'thread-one', () => { state.stops++ })
  return { directory, state, settings, manager, release, file: path.join(directory, 'run-one--thread-one.json') }
}

test('force stop is scoped to the same run/thread and closes its registered live RPC', async t => {
  const f = await fixture(t)
  assert.equal((await f.manager.stop('another-thread')).stopped, false)
  assert.equal((await createCodexOwnerManager({ ...f.settings, runId: 'another-run' }).stop('thread-one')).stopped, false)
  assert.equal(f.state.closes, 0)
  assert.equal((await f.manager.stop('thread-one')).stopped, true)
  assert.equal(f.state.closes, 1); assert.equal(f.state.stops, 1); assert.equal(f.state.kills.length, 0)
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' })
  await f.release()
})

test('PID reuse, a shared desktop process, and a different executable must never be stopped', async t => {
  const f = await fixture(t), original = { ...f.state.current }
  for (const changed of [{ startedAt: '654321' }, { isStandalone: false }, { executable: 'C:\\other.exe' }, { pid: 999 }]) {
    f.state.current = { ...original, ...changed }
    assert.equal((await f.manager.stop('thread-one')).stopped, false)
  }
  assert.equal(f.state.closes, 0); assert.equal(f.state.kills.length, 0)
  await f.release()
})

test('a persisted orphan lease validates identity before tree termination; failure retains recovery evidence', async t => {
  const f = await fixture(t)
  const record = JSON.parse(await fs.readFile(f.file, 'utf8'))
  record.token = 'previous-lab-process'
  await fs.writeFile(f.file, JSON.stringify(record))
  const failure = createCodexOwnerManager({ ...f.settings, terminate: async () => false })
  await assert.rejects(failure.stop('thread-one'), /未确认/)
  assert.ok(await fs.stat(f.file))
  const ctrl = new AbortController(); ctrl.abort()
  await assert.rejects(f.manager.stop('thread-one', { signal: ctrl.signal }), /取消/)
  assert.equal(f.state.kills.length, 0)
  assert.equal((await f.manager.stop('thread-one')).stopped, true)
  assert.equal(f.state.kills.length, 1); assert.equal(f.state.closes, 0)
  await f.release()
})

test('cleanup does not delete a replacement lease, missing processes release stale records, invalid ids cannot escape the directory', async t => {
  const f = await fixture(t)
  const record = JSON.parse(await fs.readFile(f.file, 'utf8'))
  record.token = 'newer-owner'
  await fs.writeFile(f.file, JSON.stringify(record))
  await f.release()
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).token, 'newer-owner')
  f.state.current = null
  assert.equal((await f.manager.stop('thread-one')).stopped, true)
  await assert.rejects(f.manager.stop('../escape'), /identity/)
  assert.equal(createCodexOwnerManager({ ...f.settings, runId: '../escape' }), null)
})

test('only a standalone Codex process directly spawned by this Lab can be registered', async t => {
  const f = await fixture(t)
  await f.release()
  for (const change of [{ isStandalone: false }, { parentPid: 999 }]) {
    f.state.current = { pid: 123, parentPid: 17, startedAt: '123456', executable: 'C:\\codex.exe', isStandalone: true, ...change }
    await f.manager.register({ child: { pid: 123 } }, 'thread-one')
    assert.equal((await f.manager.stop('thread-one')).stopped, false)
  }
})
