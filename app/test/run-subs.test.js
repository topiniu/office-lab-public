import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunSubs } from '../run-subs.js'

// 假 SSE 响应：只收 write 的帧，按 data 行解析回对象，方便断言
function fakeRes() {
  const frames = []
  return {
    frames,
    write(s) { frames.push(s) },
    get msgs() { return frames.map((f) => JSON.parse(f.replace(/^data: /, '').trim())) },
  }
}

test('attach 分配唯一 clientId，未订阅的会话不推', () => {
  const subs = createRunSubs()
  const a = fakeRes(), b = fakeRes()
  const ida = subs.attach(a), idb = subs.attach(b)
  assert.ok(ida && idb && ida !== idb)
  subs.publish('r1', 1, '{"type":"assistant"}')
  assert.equal(a.frames.length, 0)
  assert.equal(b.frames.length, 0)
})

test('subscribe 先回放再收增量；帧形状 = run-event{runId,_seq,ev}', () => {
  const subs = createRunSubs()
  const a = fakeRes()
  const id = subs.attach(a)
  const ok = subs.subscribe(id, 'r1', (write) => {
    write(3, '{"type":"user","text":"hi"}')
    write(4, '{"type":"assistant"}')
  })
  assert.equal(ok, true)
  subs.publish('r1', 5, '{"type":"result"}')
  subs.publish('r2', 1, '{"type":"result"}')   // 别的会话不串
  assert.deepEqual(a.msgs, [
    { type: 'run-event', runId: 'r1', _seq: 3, ev: { type: 'user', text: 'hi' } },
    { type: 'run-event', runId: 'r1', _seq: 4, ev: { type: 'assistant' } },
    { type: 'run-event', runId: 'r1', _seq: 5, ev: { type: 'result' } },
  ])
})

test('seq 为 null（lab-sync 之类非落盘帧）不带 _seq', () => {
  const subs = createRunSubs()
  const a = fakeRes()
  const id = subs.attach(a)
  subs.subscribe(id, 'r1', (write) => write(null, '{"type":"lab-sync","status":"done"}'))
  assert.deepEqual(a.msgs, [{ type: 'run-event', runId: 'r1', ev: { type: 'lab-sync', status: 'done' } }])
})

test('未知 clientId 订阅失败（连接已断 / 引擎已重启）', () => {
  const subs = createRunSubs()
  assert.equal(subs.subscribe('nope', 'r1', () => {}), false)
})

test('同一连接同会话订阅两次（两张卡）→ 引用计数，退一次仍在推，退两次才停', () => {
  const subs = createRunSubs()
  const a = fakeRes()
  const id = subs.attach(a)
  subs.subscribe(id, 'r1', () => {})
  subs.subscribe(id, 'r1', () => {})
  subs.publish('r1', 1, '{}')
  assert.equal(a.frames.length, 1, '同连接只推一份')
  subs.unsubscribe(id, 'r1')
  subs.publish('r1', 2, '{}')
  assert.equal(a.frames.length, 2)
  subs.unsubscribe(id, 'r1')
  subs.publish('r1', 3, '{}')
  assert.equal(a.frames.length, 2)
})

test('detach 清掉该连接的全部订阅', () => {
  const subs = createRunSubs()
  const a = fakeRes(), b = fakeRes()
  const ida = subs.attach(a), idb = subs.attach(b)
  subs.subscribe(ida, 'r1', () => {})
  subs.subscribe(idb, 'r1', () => {})
  subs.detach(ida)
  subs.publish('r1', 1, '{}')
  assert.equal(a.frames.length, 0)
  assert.equal(b.frames.length, 1)
  assert.equal(subs.subscribe(ida, 'r2', () => {}), false)
})

test('写失败的连接不影响其他订阅者', () => {
  const subs = createRunSubs()
  const bad = { write() { throw new Error('EPIPE') } }
  const a = fakeRes()
  subs.subscribe(subs.attach(bad), 'r1', () => {})
  subs.subscribe(subs.attach(a), 'r1', () => {})
  subs.publish('r1', 1, '{}')
  assert.equal(a.frames.length, 1)
})
