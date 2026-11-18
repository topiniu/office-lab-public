// 空转熔断（isSpunTurn / barrenTurns）与巡视升级识别（patrolEscalating）的回归测试。
// 缘起 2026-08-24 事故（菲菲 run 20260824015731-60a5b7 + 小呆呆 run 20260824020309-2e5946）：
//   ① 模型读完大档案后连出两条「只含 thinking 块」的顶层 assistant 消息（SDK 直接重发请求、不注入 no-visible-output
//      user 消息）→ 旧闸门 _sdkNudges 恒为 0 → 兜底取上一句陈旧文本假绿收工，老板看到 ✅；
//   ② 小呆呆判「不续、留给老板」时只写白话 + decision 卡、没写 `【等你拍板】` 标记行 → parsePendingGate 抽不出门 →
//      降噪逻辑把推送整条吞掉，老板体感「压根没巡」。
// server.js 是自启服务的单体（import 即 listen），没法直接 import 这几个纯函数，故按名从源码抠出定义 eval 后测。
// 抠不到就抛错（不静默测空壳），源码重构改了这些函数名/签名时本测试会立刻红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'server.js'), 'utf8')
function grab(name, re) {
  const m = src.match(re)
  if (!m) throw new Error(`抠不到 ${name}：server.js 结构变了，请同步更新 test/spin-and-patrol.test.js`)
  return m[0]
}
const PIECES = [
  grab('MARKER_LINE_RE', /^const MARKER_LINE_RE = .*$/m),
  grab('SILENT_SPIN_NUDGES', /^const SILENT_SPIN_NUDGES = .*$/m),
  grab('BARREN_TURN_LIMIT', /^const BARREN_TURN_LIMIT = .*$/m),
  grab('barrenTurns', /^function barrenTurns\(run\) \{[\s\S]*?\n\}/m),
  grab('isSpunTurn', /^function isSpunTurn\(run\) \{[\s\S]*?\n\}/m),
  grab('lastMarkerBlock', /^function lastMarkerBlock\(text, headRe\) \{[\s\S]*?\n\}/m),
  grab('parsePendingGate', /^function parsePendingGate\(result\) \{[\s\S]*?\n\}/m),
  grab('PATROL_ESCALATE_RE', /^const PATROL_ESCALATE_RE = .*$/m),
  grab('patrolEscalating', /^function patrolEscalating\(run\) \{[\s\S]*?\n\}/m),
]
const ctx = vm.createContext({})
vm.runInContext(`${PIECES.join('\n')}
globalThis.__api = { barrenTurns, isSpunTurn, patrolEscalating, parsePendingGate, SILENT_SPIN_NUDGES, BARREN_TURN_LIMIT }`, ctx)
const { barrenTurns, isSpunTurn, patrolEscalating, parsePendingGate, BARREN_TURN_LIMIT } = vm.runInContext('__api', ctx)

// ---------- 消息流回放：重演 consumeStream 的 _turnMsgs/_turnText/_sdkNudges 记账 + result 兜底判据 ----------
// 与 server.js consumeStream 同构（那段逻辑内嵌在 for-await 里，抠不出来单测，故此处等价重演；
// 判据本身用的是从源码抠出的真函数 isSpunTurn/barrenTurns，重演只负责喂它记账状态）。
function replay(msgs) {
  const run = { _turnActive: false, _turnMsgs: new Map(), _turnText: '', _sdkNudges: 0 }
  const turns = []
  for (const msg of msgs) {
    if (msg.type === 'user' && msg.message) {
      const uc = msg.message.content
      const ut = typeof uc === 'string' ? uc : (Array.isArray(uc) ? uc.filter(b => b?.type === 'text').map(b => b.text || '').join('') : '')
      if (/no visible output/i.test(ut)) run._sdkNudges++
    }
    if (msg.type === 'assistant') {
      if (!run._turnActive) { run._turnMsgs = new Map(); run._sdkNudges = 0 }
      run._turnActive = true
      const blocks = msg.message?.content || []
      const t = blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('')
      if (t.trim()) run._turnText = t
      if (!msg.parent_tool_use_id && msg.message?.id) {
        const produced = !!t.trim() || blocks.some(b => b?.type === 'tool_use')
        run._turnMsgs.set(msg.message.id, (run._turnMsgs.get(msg.message.id) || false) || produced)
      }
    }
    if (msg.type === 'result') {
      run._turnActive = false
      let r = typeof msg.result === 'string' ? msg.result : ''
      const spun = isSpunTurn(run)
      let fromFallback = false
      if (!String(r).trim() && String(run._turnText || '').trim() && !spun) { r = run._turnText; fromFallback = true }
      turns.push({ barren: barrenTurns(run), nudges: run._sdkNudges, spun, fromFallback, result: r, empty: !String(r).trim() })
      run._turnText = ''   // 下一轮由 beginTurn 归零（/reply 路径）
    }
  }
  return turns
}
const asst = (id, blocks, extra = {}) => ({ type: 'assistant', message: { id, content: blocks }, parent_tool_use_id: null, ...extra })
const think = { type: 'thinking', thinking: '', signature: 'sig' }
const text = (s) => ({ type: 'text', text: s })
const tool = (name) => ({ type: 'tool_use', id: 'toolu_x', name, input: {} })
const done = (r = '') => ({ type: 'result', subtype: 'success', is_error: false, result: r })

// ---------- barrenTurns / isSpunTurn ----------
test('一条 assistant 消息按块分多次透传（thinking→tool_use，同 message.id）不算零产出', () => {
  // 这是 SDK 的常态透传形状；按「每次透传一条」计数会把正常轮误判成空转，故必须按 message.id 归并
  const [t] = replay([asst('m1', [think]), asst('m1', [tool('Read')]), done('干完了')])
  assert.equal(t.barren, 0)
  assert.equal(t.spun, false)
})

test('事故形状：连出两条纯 thinking 顶层消息 + 空 result → 判空转、不取陈旧文本兜底', () => {
  const [t] = replay([
    asst('m1', [think]), asst('m1', [text('先读它。')]), asst('m1', [tool('Read')]),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    asst('m2', [think]),   // 第一次纯思考
    asst('m3', [think]),   // SDK 又发一次请求，仍纯思考
    done(''),
  ])
  assert.equal(t.barren, 2)
  assert.equal(t.nudges, 0, '事故里 SDK 没注入 no-visible-output，旧闸门抓不到')
  assert.equal(t.spun, true)
  assert.equal(t.fromFallback, false, '不能拿上一句「先读它。」假绿')
  assert.equal(t.empty, true, 'result 保持空 → onTurnComplete 落 error 红灯')
})

test('只有一条纯 thinking 消息（未达阈值）仍走兜底取文本，不误伤合法长活', () => {
  const [t] = replay([asst('m1', [text('已改完 A 文件')]), asst('m2', [think]), done('')])
  assert.equal(t.barren, 1)
  assert.ok(BARREN_TURN_LIMIT > 1, '阈值必须 >1，否则单次结尾停思考块就被判死')
  assert.equal(t.spun, false)
  assert.equal(t.fromFallback, true)
  assert.equal(t.result, '已改完 A 文件')
})

test('子 agent 的纯 thinking 不计入（parent_tool_use_id 非空）', () => {
  const sub = (id) => asst(id, [think], { parent_tool_use_id: 'toolu_parent' })
  const [t] = replay([asst('m1', [tool('Task')]), sub('s1'), sub('s2'), sub('s3'), asst('m2', [text('子代理跑完了')]), done('子代理跑完了')])
  assert.equal(t.barren, 0)
  assert.equal(t.spun, false)
})

test('旧闸门仍有效：no-visible-output 自催达阈值 → 空转', () => {
  const nudge = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Your previous response had no visible output. Please continue]' }] } }
  const [t] = replay([asst('m1', [text('嗯')]), nudge, asst('m2', [think]), nudge, done('')])
  assert.equal(t.nudges, 2)
  assert.equal(t.spun, true)
  assert.equal(t.fromFallback, false)
})

test('跨轮不累加：SDK 后台 settle 自动续跑的新一轮从零起算', () => {
  const turns = replay([
    asst('m1', [think]), done(''),                                  // 第 1 轮：1 个零产出
    asst('m2', [think]), asst('m2', [text('回来接着做')]), done('回来接着做'),  // 第 2 轮（无 beginTurn）：应归零
  ])
  assert.equal(turns[1].barren, 0, '上一轮的零产出串到这一轮会把正常自续误判成空转')
  assert.equal(turns[1].spun, false)
})

// ---------- patrolEscalating ----------
const PATROL_INCIDENT = `我看了菲菲会话 20260824015731-60a5b7 的收尾……

判断：这轮对端就是项目负责人本人在直接发问，按判据这种情况默认不续，留给老板决定下一步。

不做 resume，升级处理。

\`\`\`olcard
{"type":"decision","id":"patrol-feifei","title":"巡视：菲菲收尾未挂标记，是否需要她继续","options":[{"label":"我去看一下","reply":"我看看再说"},{"label":"够了，收尾","reply":"够了"}]}
\`\`\`

无需我方动作，等你拍板。`

test('事故形状：白话升级 + decision 卡、无标记行 → 旧判据抽不出门，新判据判为升级', () => {
  assert.equal(parsePendingGate(PATROL_INCIDENT), null, '复现旧漏：规范标记解析不出门')
  assert.equal(patrolEscalating({ result: PATROL_INCIDENT }), true, '必须判升级，否则推送被静默吞掉')
})

test('规范标记升级 → 判升级', () => {
  assert.equal(patrolEscalating({ result: '情况如下……\n\n【等你拍板】迷糊卡在 SC259，要不要让她续' }), true)
})

test('合法收工（【等你拍板】无）仍静默——降噪初衷不能破', () => {
  assert.equal(patrolEscalating({ result: '已巡查，任务已终态、真没剩余活，合法收工。\n\n【等你拍板】无' }), false,
    '兜底正则不能把标记里「等你拍板」四个字本身当白话请示')
})

test('白话「无需动作」不误判为升级', () => {
  assert.equal(patrolEscalating({ result: '已巡查，GG Bond 这轮到了预检门，属合法收工，无需动作。' }), false)
})

test('标了「无」但同时抛 decision 卡 → 仍判升级（卡就是在问老板）', () => {
  const r = '看完了。\n\n```olcard\n{"type":"decision","id":"x","options":[{"label":"续","reply":"续"}]}\n```\n\n【等你拍板】无'
  assert.equal(patrolEscalating({ result: r }), true)
})

test('空 result 不算升级（那是空收工，走红灯那条路）', () => {
  assert.equal(patrolEscalating({ result: '' }), false)
  assert.equal(patrolEscalating({}), false)
})
