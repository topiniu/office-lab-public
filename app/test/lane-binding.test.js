// 会话 ↔ 任务档案 ↔ 运行环境（lane）绑定回归测试。
// 缘起 2026-10-14：老板给迷糊派「项目跟踪 v0.1.5」被 409「迷糊老师正忙」挡下——迷糊在跑的是 v6.1.0 视觉初筛。
// 根因三层：① 菲菲把 REQ-0392 拆成 v6.1.0 新档案，但 bind_task_file 不许改挂，整条线 37 条会话一路继承 v6.0.0 档案；
// ② GG Bond 建 v610 环境绑的是 REQ-0392 档案，与线上挂的档案对不上，绑定落空且没人察觉；
// ③ v600 环境收掉后，laneForNewRun 不校验就继承委托者的 lane / 回落主检出，全程静默。
// server.js 是自启服务的单体（import 即 listen），按名从源码抠函数 eval 后测（同 cc-join.test.js 口径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { laneForTask, normTaskFile, MAIN_LANE_ID } from '../lanes.js'

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
function grab(name, re) {
  const m = src.match(re)
  if (!m) throw new Error(`抠不到 ${name}：server.js 结构变了，请同步更新 test/lane-binding.test.js`)
  return m[0]
}
const PIECES = [
  grab('laneLive', /^function laneLive\(id, lanes\) \{[\s\S]*?\n\}/m),
  grab('laneKeyOf', /^function laneKeyOf\(run\) \{[\s\S]*?\n\}/m),
  grab('laneForNewRun', /^function laneForNewRun\(\{ lane, caller, taskFile \}, out\) \{[\s\S]*?\n\}/m),
  grab('bindRunToTask', /^function bindRunToTask\(run, taskFileRaw, \{ by = '', reason = '' \} = \{\}\) \{[\s\S]*?\n\}/m),
  grab('laneArchiveMismatchHint', /^function laneArchiveMismatchHint\(run, laneId, taskFile\) \{[\s\S]*?\n\}/m),
  grab('pendingLaneKey', /^function pendingLaneKey\(it\) \{[\s\S]*?\n\}/m),
]

const V600 = 'office-lab/tasks/2026-09-29-示例项目-v6.0.0.md'
const REQ0392 = 'office-lab/tasks/2026-10-06-项目组数据隔离-REQ-0392.md'
const FOLLOW = 'office-lab/tasks/2026-10-14-项目跟踪-v0.1.5.md'

function makeEngine(lanes) {
  const calls = { events: [], saves: 0 }
  const ctx = vm.createContext({
    runs: {},
    MAIN_LANE_ID, laneForTask, normTaskFile,
    lanesMgr: () => ({ load: () => ctx.lanes }),
    lanes,
    fs: { statSync: () => ({ isFile: () => true }) },   // 档案存在性不在本测范围
    safeResolve: p => p,
    saveRegistry: () => { calls.saves++ },
    appendEvent: (id, e) => calls.events.push({ id, ...e }),
  })
  vm.runInContext(`${PIECES.join('\n')}
globalThis.__api = { laneLive, laneKeyOf, laneForNewRun, bindRunToTask, laneArchiveMismatchHint, pendingLaneKey }`, ctx)
  return { ctx, calls, api: vm.runInContext('__api', ctx) }
}
const V610_LANE = { id: 'v610', taskFile: REQ0392 }

test('收掉的环境不再被继承：委托者 lane=v600 已不存在 → 回落档案绑定/主检出，并记 stale', () => {
  const { api } = makeEngine([V610_LANE])
  const out = {}
  assert.equal(api.laneForNewRun({ caller: { lane: 'v600' }, taskFile: V600 }, out), undefined)
  assert.equal(out.stale, 'v600')
  // 显式传入的 lane（抄送路径 lane: run.lane）同理
  const out2 = {}
  assert.equal(api.laneForNewRun({ lane: 'v600', taskFile: REQ0392 }, out2), 'v610')   // 档案有绑定 → 认档案的
  assert.equal(out2.stale, 'v600')
})

test('环境还在时照旧：显式 > 委托者 > 档案绑定，不记 stale', () => {
  const { api } = makeEngine([V610_LANE, { id: 'temu', taskFile: 'office-lab/tasks/temu.md' }])
  const out = {}
  assert.equal(api.laneForNewRun({ lane: 'temu', caller: { lane: 'v610' }, taskFile: V600 }, out), 'temu')
  assert.equal(api.laneForNewRun({ caller: { lane: 'v610' }, taskFile: V600 }, out), 'v610')
  assert.equal(api.laneForNewRun({ taskFile: REQ0392 }, out), 'v610')
  assert.equal(api.laneForNewRun({ lane: MAIN_LANE_ID, caller: { lane: 'v610' } }, out), MAIN_LANE_ID)
  assert.equal(out.stale, undefined)
})

test('并发闸口径：挂着已收掉 lane 的会话不按幽灵环境算，按档案绑定/主检出算', () => {
  const { api } = makeEngine([V610_LANE])
  assert.equal(api.laneKeyOf({ lane: 'v600', taskFile: V600 }), MAIN_LANE_ID)
  assert.equal(api.laneKeyOf({ lane: 'v600', taskFile: REQ0392 }), 'v610')
  assert.equal(api.laneKeyOf({ lane: 'v610', taskFile: V600 }), 'v610')
  // 本次事故的两条会话：迷糊 v6.1.0（挂 v6.0.0 档案、无 lane）与老板派的 v0.1.5 跟单 → 都落主检出，撞闸
  assert.equal(api.laneKeyOf({ taskFile: V600 }), api.laneKeyOf({ taskFile: FOLLOW }))
})

test('待处理队列项的 lane 已收掉 → 按档案重新找', () => {
  const { api } = makeEngine([V610_LANE])
  assert.equal(api.pendingLaneKey({ lane: 'v600', taskFile: REQ0392 }), 'v610')
  assert.equal(api.pendingLaneKey({ lane: 'v610', taskFile: V600 }), 'v610')
})

test('改挂档案：从 v6.0.0 改挂 REQ-0392 → 环境跟到 v610，事件写明原因', () => {
  const { api, calls } = makeEngine([V610_LANE])
  const run = { id: 'r1', taskFile: V600, _laneStale: 'v600' }
  const r = api.bindRunToTask(run, REQ0392, { by: '菲菲', reason: '已拆成 v6.1.0' })
  assert.equal(r.ok, true)
  assert.equal(r.switching, true)
  assert.equal(run.taskFile, REQ0392)
  assert.equal(run.lane, 'v610')
  assert.equal(run._laneStale, undefined)
  assert.match(calls.events.at(-1).text, /改挂.*已拆成 v6\.1\.0/)
  // 改挂后往下的交棒继承委托者 → 进 v610
  assert.equal(api.laneForNewRun({ caller: run, taskFile: run.taskFile }, {}), 'v610')
})

test('改挂档案：旧版本显式环境不跟去新版本', () => {
  const { api } = makeEngine([V610_LANE, { id: 'temu', taskFile: 'office-lab/tasks/temu.md' }])
  const a = { id: 'a', taskFile: V600, lane: 'temu' }
  api.bindRunToTask(a, REQ0392, { reason: 'x' })
  assert.equal(a.lane, 'v610')
  const b = { id: 'b', taskFile: V600, lane: 'temu' }
  const r = api.bindRunToTask(b, FOLLOW, { reason: 'x' })   // 新档案没登记环境 → 去掉旧环境、回主检出
  assert.equal(b.lane, undefined)
  assert.match(r.laneNote, /已去掉/)
})

test('同一份档案重绑：尊重仍存在的显式环境（原口径不变）', () => {
  const { api } = makeEngine([V610_LANE, { id: 'temu', taskFile: 'office-lab/tasks/temu.md' }])
  const run = { id: 'r', taskFile: REQ0392, lane: 'temu' }
  const r = api.bindRunToTask(run, REQ0392)
  assert.equal(run.lane, 'temu')
  assert.match(r.laneNote, /保持原绑定/)
})

test('建/改工作区绑的档案与会话挂的不一致 → 提示绑定会落空；一致则不提示', () => {
  const { api } = makeEngine([V610_LANE])
  assert.match(api.laneArchiveMismatchHint({ taskFile: V600 }, 'v610', REQ0392), /绑定会落空[\s\S]*bind_task_file/)
  assert.equal(api.laneArchiveMismatchHint({ taskFile: REQ0392 }, 'v610', REQ0392.replace('office-lab/', '')), '')
  assert.equal(api.laneArchiveMismatchHint({ taskFile: V600 }, 'v610', undefined), '')
})
