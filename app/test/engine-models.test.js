import test from 'node:test'
import assert from 'node:assert/strict'
import { listCodexModels, createModelCatalog } from '../engines/models.js'

function fake(pages) {
  const calls = []; let closed = 0
  const rpc = { request: async (method, args) => {
    calls.push([method, args])
    if (method === 'initialize') return {}
    const p = pages.shift(); if (p instanceof Error) throw p; return p
  }, send: () => {}, close: async () => { closed++ } }
  return { rpc, calls, closed: () => closed }
}
test('model discovery paginates, uses model slug not UI id, hides hidden entries and closes without a turn', async () => {
  const f = fake([{ data: [{ id: 'ui-id', model: 'slug', displayName: 'Shown', isDefault: true }, { model: 'hidden', hidden: true }], nextCursor: 'next' }, { data: [{ model: 'slug' }, { model: 'other' }, { model: 'bad\n' }] }])
  const models = await listCodexModels({ rpcFactory: () => f.rpc })
  assert.deepEqual(models.map(m => m.id), ['slug', 'other'])
  assert.deepEqual(f.calls.map(c => c[0]), ['initialize', 'model/list', 'model/list'])
  assert.equal(f.calls[2][1].cursor, 'next'); assert.equal(f.closed(), 1)
})
test('model discovery closes on RPC errors, malformed data and repeated cursors', async () => {
  for (const pages of [[new Error('offline')], [{}], [{ data: [], nextCursor: 'a' }, { data: [], nextCursor: 'a' }]]) {
    const f = fake(pages)
    await assert.rejects(listCodexModels({ rpcFactory: () => f.rpc }))
    assert.equal(f.closed(), 1)
  }
})
test('catalog coalesces, caches briefly, refreshes, changes command and retries failures', async () => {
  let calls = 0, time = 0, fail = false
  const catalog = createModelCatalog(async () => { calls++; if (fail) throw new Error('offline'); return [{ id: String(calls) }] }, () => time)
  const options = { command: 'one', cwd: '/project' }
  const a = await Promise.all([catalog(options), catalog(options, true)])
  assert.deepEqual(a[0], a[1]); assert.equal(calls, 1)
  await catalog(options); assert.equal(calls, 1)
  await catalog(options, true); assert.equal(calls, 2)
  time = 61000; await catalog(options); assert.equal(calls, 3)
  await catalog({ ...options, command: 'two' }); assert.equal(calls, 4)
  fail = true; await assert.rejects(catalog(options)); assert.equal(calls, 5)
  fail = false; await catalog(options); assert.equal(calls, 6)
})
