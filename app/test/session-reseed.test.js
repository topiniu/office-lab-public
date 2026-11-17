// 会话中毒判定与「换会话重开」的回归测试（§3.109）。
// 缘起 2026-08-31（菲菲 run 20260831080340-e5f6c2 / session 55b19d93）：
//   ① 模型单条消息 `stop_reason=max_tokens`、`output_tokens=64000` 全烧在思考上，21 分 47 秒零产出——
//      引擎本以为有 24k 思考顶，实际 env MAX_THINKING_TOKENS 在 Opus 4.6+ 只当 on/off，数字被丢弃；
//   ② 此后整条会话反复只思考不产出。老板回「继续」→ 引擎 resume 同一条 transcript → 把空转样例重新喂回去，
//      再空转一轮。全库实测 P(下一条零产出|上一条零产出)=40.5% vs 基线 0.26%，156 倍——会话会自我毒化。
// 本测试锁住三件事：思考顶走的是 SDK option 而非 env；连续零产出会当场判中毒；重开的交接不丢进度。
// 同 spin-and-patrol.test.js：server.js 是自启服务的单体，按名从源码抠出定义 eval 后测；抠不到就抛错。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
function grab(name, re) {
  const m = src.match(re)
  if (!m) throw new Error(`抠不到 ${name}：server.js 结构变了，请同步更新 test/session-reseed.test.js`)
  return m[0]
}
const PIECES = [
  grab('BARREN_ABORT_STREAK', /^const BARREN_ABORT_STREAK = .*$/m),
  grab('MAX_SPIN_RESEEDS', /^const MAX_SPIN_RESEEDS = .*$/m),
  grab('THINKING_BUDGET', /^const THINKING_BUDGET = .*$/m),
  grab('THINKING_RUNAWAY_TOKENS', /^const THINKING_RUNAWAY_TOKENS = .*$/m),
  grab('thinkingConfig', /^function thinkingConfig\(budgetTokens\) \{.*\}$/m),
  grab('brakeRunawayThinking', /^function brakeRunawayThinking\(run, est\) \{[\s\S]*?\n\}/m),
  grab('finalizeTopMsg', /^function finalizeTopMsg\(run, allowAbort = true\) \{[\s\S]*?\n\}/m),
  grab('markPoisoned', /^function markPoisoned\(run, why\) \{[\s\S]*?\n\}/m),
  grab('canAutoReseed', /^function canAutoReseed\(run\) \{[\s\S]*?\n\}/m),
  grab('tailRunEvents', /^function tailRunEvents\(runId, maxBytes = 400_000\) \{[\s\S]*?\n\}/m),
  grab('buildReseedPrompt', /^function buildReseedPrompt\(run, extra = ''\) \{[\s\S]*?\n\}/m),
]

const RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-reseed-'))
const labs = []
const ctx = vm.createContext({
  fs, path, Buffer, RUNS_DIR,
  shuttingDown: false,
  appendEvent: (runId, obj) => labs.push({ runId, ...obj }),
  broadcast: () => { },
  stallGuard: { renderResumeSnapshot: list => (list?.length ? `【进度快照】${list.map(s => s.text).join(' / ')}\n` : '') },
})
vm.runInContext(`${PIECES.join('\n')}
globalThis.__api = { BARREN_ABORT_STREAK, MAX_SPIN_RESEEDS, THINKING_BUDGET, THINKING_RUNAWAY_TOKENS, thinkingConfig, brakeRunawayThinking, finalizeTopMsg, markPoisoned, canAutoReseed, tailRunEvents, buildReseedPrompt }`, ctx)
const A = vm.runInContext('__api', ctx)

// 造一条 run：_turnMsgs 记「顶层消息 id → 是否产出过 text/tool_use」，与 consumeStream 同构
function mkRun(pairs = []) {
  return { id: 'r1', _turnMsgs: new Map(pairs), _barrenStreak: 0, _lastTopMsgId: null, _abort: null }
}
// 依次把若干条顶层消息「定稿」——模拟 consumeStream 里换 id 时调 finalizeTopMsg 的节奏
function feed(run, produced, allowAbort = true) {
  for (const [id, ok] of produced) {
    run._turnMsgs.set(id, ok)
    run._lastTopMsgId = id
    finalize(run, allowAbort)
  }
}
const finalize = (run, allowAbort) => A.finalizeTopMsg(run, allowAbort)

// ---------- 思考预算：平台侧管不住，真正生效的是引擎侧那道刹车 ----------
test('thinkingConfig 产出 SDK 认的 { type:"enabled", budgetTokens }（意图声明，非保障）', () => {
  const c = A.thinkingConfig(24000)   // vm 里造的对象跨 realm，逐字段比（deepEqual 会因原型不同误红）
  assert.equal(c.type, 'enabled')
  assert.equal(c.budgetTokens, 24000)
})

test('server.js 里不得再靠 env MAX_THINKING_TOKENS 设思考预算（Opus 4.6+ 只当 on/off，数字被丢弃）', () => {
  const bad = src.match(/MAX_THINKING_TOKENS\s*:/g) || []
  assert.equal(bad.length, 0, `还有 ${bad.length} 处在用 env 设思考预算，会静默失效（64k 空烧事故根因）——请改用 thinkingConfig()`)
})

test('每条起 query 的地方都声明了 thinking（平台哪天认了就自动生效）', () => {
  const queries = (src.match(/^\s*includePartialMessages: /gm) || []).length
  const thinkings = (src.match(/thinking: thinkingConfig\(/g) || []).length
  assert.ok(thinkings >= queries, `有 ${queries} 条 query、只有 ${thinkings} 条声明了 thinking`)
})

test('刹车顶不会误伤正常工作：健康消息 output_tokens p99.9 实测 15,682、最大 28,428，顶须高于它', () => {
  assert.ok(A.THINKING_RUNAWAY_TOKENS > 28428, '顶低于实测最大健康消息会误杀正常长推理')
  assert.ok(A.THINKING_RUNAWAY_TOKENS < 64000, '顶必须低于模型输出上限，否则等于没刹车（64k 空烧就是这么来的）')
})

// ---------- 空想失控刹车 ----------
// 与 handleControlMsg 的 thinking_tokens 分支同构（那段内嵌在 switch 里抠不出来，此处等价重演；
// 刹车函数本身用的是从源码抠出的真 brakeRunawayThinking）。
function heartbeat(run, est) {
  if (est < (run._thinkLastEst || 0)) run._thinkBase = 0
  run._thinkLastEst = est
  if (est - (run._thinkBase || 0) > A.THINKING_RUNAWAY_TOKENS) A.brakeRunawayThinking(run, est - (run._thinkBase || 0))
}
const mkThinkRun = () => { const r = { id: 'r1', _aborts: 0, _abort: { abort: () => { r._aborts++ } } }; return r }

test('单条消息思考破顶 → 掐断 + 打纠偏标（不掐会一路烧到 64k 然后零产出）', () => {
  labs.length = 0
  const run = mkThinkRun()
  for (const est of [5000, 20000, A.THINKING_RUNAWAY_TOKENS + 1]) heartbeat(run, est)
  assert.equal(run._aborts, 1)
  assert.equal(run._thinkNudge, true)
  assert.match(labs.at(-1).text, /空想失控/)
})

test('顶以内不掐（正常长推理不受影响）', () => {
  const run = mkThinkRun()
  for (const est of [5000, 15000, A.THINKING_RUNAWAY_TOKENS]) heartbeat(run, est)
  assert.equal(run._aborts, 0)
  assert.ok(!run._thinkNudge)
})

test('每轮只掐一次（掐完交给纠偏续跑，别在这儿反复掐）', () => {
  const run = mkThinkRun()
  for (const est of [A.THINKING_RUNAWAY_TOKENS + 1, A.THINKING_RUNAWAY_TOKENS + 9999]) heartbeat(run, est)
  assert.equal(run._aborts, 1)
})

test('估算按块重置时基线跟着清零 —— 顶始终是「这一段连续思考」，不会被全轮累计误触发', () => {
  const run = mkThinkRun()
  heartbeat(run, 20000)          // 第一段思考
  heartbeat(run, 3000)           // 读数回落 = SDK 按块重置
  heartbeat(run, 20000)          // 第二段又想了 20k：两段累计 40k，但单段没破顶
  assert.equal(run._aborts, 0, '两段各 20k 不该被当成一段 40k 掐掉')
})

test('估算是全轮累计时，基线随内容块定稿前移 —— 同样按「单段」判', () => {
  const run = mkThinkRun()
  heartbeat(run, 20000)
  run._thinkBase = run._thinkLastEst   // 模拟 consumeStream：收到 assistant 事件（一个块定稿）后基线前移
  heartbeat(run, 45000)                // 累计 45k，但这一段只有 25k
  assert.equal(run._aborts, 0)
  heartbeat(run, 20000 + A.THINKING_RUNAWAY_TOKENS + 1)
  assert.equal(run._aborts, 1)
})

// ---------- 连续零产出 = 会话中毒 ----------
test('连续 BARREN_ABORT_STREAK 条纯思考 → 判中毒并掐断本轮', () => {
  labs.length = 0
  let aborted = 0
  const run = mkRun(); run._abort = { abort: () => aborted++ }
  feed(run, [['m1', false], ['m2', false]])
  assert.equal(run._barrenStreak, A.BARREN_ABORT_STREAK)
  assert.equal(run._poisoned, true)
  assert.equal(aborted, 1, '判中毒必须当场 abort，不能等到轮末——等下去 CLI 会继续往 transcript 里堆坏样例')
  assert.match(labs.at(-1).text, /会话状态已坏/)
})

test('中间夹一条正常消息 → 连击归零，不判中毒（单条零产出 CLI 自催常能救回来，别误杀）', () => {
  let aborted = 0
  const run = mkRun(); run._abort = { abort: () => aborted++ }
  feed(run, [['m1', false], ['m2', true], ['m3', false]])
  assert.equal(run._barrenStreak, 1)
  assert.ok(!run._poisoned)
  assert.equal(aborted, 0)
})

test('全程正常 → 永不判中毒', () => {
  const run = mkRun()
  feed(run, [['m1', true], ['m2', true], ['m3', true]])
  assert.equal(run._barrenStreak, 0)
  assert.ok(!run._poisoned)
})

test('result 到达时的补结算（allowAbort=false）仍打中毒标，但不 abort（流已到轮末，掐断无意义）', () => {
  let aborted = 0
  const run = mkRun(); run._abort = { abort: () => aborted++ }
  feed(run, [['m1', false], ['m2', false]], false)
  assert.equal(run._poisoned, true)
  assert.equal(aborted, 0)
})

test('markPoisoned 幂等：重复判定不重复落红灯', () => {
  labs.length = 0
  const run = mkRun()
  A.markPoisoned(run, '第一次')
  A.markPoisoned(run, '第二次')
  assert.equal(labs.length, 1)
  assert.equal(run._poisonWhy, '第一次')
})

// ---------- 自动重开额度 ----------
test('canAutoReseed：未中毒不重开；中毒且有额度才重开；额度用尽交回老板', () => {
  assert.ok(!A.canAutoReseed({ _poisoned: false, _spinReseeds: 0 }))
  assert.ok(A.canAutoReseed({ _poisoned: true, _spinReseeds: 0 }))
  assert.ok(!A.canAutoReseed({ _poisoned: true, _spinReseeds: A.MAX_SPIN_RESEEDS }))
})

test('canAutoReseed：老板主动停的会话不自动重开（别跟老板抢方向盘）', () => {
  assert.ok(!A.canAutoReseed({ _poisoned: true, _spinReseeds: 0, _userStopped: true }))
})

// ---------- 换会话的交接播种：不许从头重来 ----------
function seedRunFile(id, events) {
  fs.writeFileSync(path.join(RUNS_DIR, `${id}.jsonl`), events.map(e => JSON.stringify(e)).join('\n') + '\n')
}
const asst = (id, blocks) => ({ type: 'assistant', message: { id, content: blocks } })

test('交接里带上：任务档案 / 最后一条指令 / 员工自己说过的话 / 动过的工具 / 进度快照', () => {
  seedRunFile('seed1', [
    { type: 'user-msg', kind: 'chat', text: '把 5 个 facet 表的表头统一回历史约定' },
    asst('a1', [{ type: 'text', text: '逐表改：先 REQ-0319' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'D:/docs/v5.21.md' } }]),
    asst('a2', [{ type: 'tool_use', name: 'Grep', input: { pattern: 'facet ID' } }]),
    asst('a3', [{ type: 'text', text: '5 个表改了 2 个，还剩 REQ-0324/0266/0295' }]),
  ])
  const run = { id: 'seed1', taskFile: 'office-lab/tasks/2026-08-31-x.md', _snapshots: [{ text: '已改 2/5 张表' }] }
  const p = A.buildReseedPrompt(run)
  assert.match(p, /不要从头重来/)
  assert.match(p, /office-lab\/tasks\/2026-08-31-x\.md/)
  assert.match(p, /把 5 个 facet 表的表头统一回历史约定/)
  assert.match(p, /还剩 REQ-0324\/0266\/0295/)
  assert.match(p, /Edit · D:\/docs\/v5\.21\.md/)
  assert.match(p, /Grep/)
  assert.match(p, /已改 2\/5 张表/)
})

test('没落过进度快照 → 交接里明说，并要求这轮补一条（下次重开就有据可依）', () => {
  seedRunFile('seed2', [{ type: 'user-msg', text: '干活' }])
  const p = A.buildReseedPrompt({ id: 'seed2' })
  assert.match(p, /progress_snapshot/)
})

test('老板那句话作为「刚说」附在交接后面，不覆盖交接事实', () => {
  seedRunFile('seed3', [{ type: 'user-msg', text: '原始派工' }])
  const p = A.buildReseedPrompt({ id: 'seed3' }, '先别改了，先跟我确认口径')
  assert.match(p, /原始派工/)
  assert.match(p, /【老板刚说】[\s\S]*先别改了/)
})

test('子 agent 的发言不当作「你自己说过的话」（那是别人的上下文）', () => {
  seedRunFile('seed4', [
    { type: 'assistant', parent_tool_use_id: 'toolu_x', message: { id: 'sub1', content: [{ type: 'text', text: '我是子代理的话' }] } },
    asst('a1', [{ type: 'text', text: '我是顶层的话' }]),
  ])
  const p = A.buildReseedPrompt({ id: 'seed4' })
  assert.match(p, /我是顶层的话/)
  assert.ok(!p.includes('我是子代理的话'))
})

test('run 文件缺失/损坏也要能重开（交接退化成骨架，不能抛异常把自愈路径炸掉）', () => {
  const p = A.buildReseedPrompt({ id: 'does-not-exist' })
  assert.match(p, /换会话续跑/)
  fs.writeFileSync(path.join(RUNS_DIR, 'broken.jsonl'), '{不是 json\n{"type":"user-msg","text":"活的那行"}\n')
  assert.match(A.buildReseedPrompt({ id: 'broken' }), /活的那行/)
})

test('超大 run 文件只读尾部，且丢掉被截断的首行（不能把半行 JSON 喂进交接）', () => {
  const big = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ type: 'user-msg', text: 'x'.repeat(200) + i }))
  fs.writeFileSync(path.join(RUNS_DIR, 'big.jsonl'), big.join('\n') + '\n')
  const ev = A.tailRunEvents('big')
  assert.ok(ev.length > 0 && ev.length < 5000, '应只取尾部若干条')
  assert.ok(ev.every(e => e && e.type === 'user-msg'), '截断首行必须被丢掉，不能混进解析失败的碎片')
})
