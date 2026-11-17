// 可达性回归：新增能力模块里的**导出函数**必须真的被接上（server.js 或别的模块调用）。
//
// 缘起（2026-08-25，老板追问「所以菲菲现在有自动需求巡查了是吗」时核出来的）：
// v0.10.0 第一版写了 10 个模块、385 条单测全绿，但其中 7 个**能力级函数**全仓零调用：
//   requirement-pool.sortPool / pickForContract   ← A1 巡航的排序与取候选（菲菲拿到的仍是要肉眼筛的表）
//   gate-matrix.guardedScopeDecision / rcReadyGate ← **E6/B6 的自动降级与 RC_READY 放行门根本不会触发**
//   handoff-freeze.worktreePlan · stall-guard.snapshotDue / patrolReason
// 单测全绿掩盖了它——因为测试自己会 import，"被测到"和"被接上"是两回事。
//
// **「写了函数」不等于「员工够得着」**：SDK 员工只能看见 MCP 工具表里的东西，
// 模块里的导出对它不存在。这条测试就是把那次教训钉住，别再靠人记得反查。
//
// 判据：某个导出函数，若「模块内除定义外零处调用」且「server.js 零引用」且「其它模块零引用」
//       → 判不可达。常量（export const）不查——它们大多是模块内自用的阈值与表。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MODULES = [
  'requirement-pool', 'guard-ledger', 'gate-matrix', 'release-chain', 'stall-guard',
  'handoff-freeze', 'qa-report-card', 'audit-trust', 'morning-report', 'zhuzhu-capabilities', 'version-report', 'entry-status',
]
// 允许「只被 API/前端消费、不被引擎内部调用」的导出登记豁免（目前为空——有就必须写清理由）
const ALLOW_UNREACHED = new Set()

// 判据演进（两次打脸，都记在这）：
//   v1 数「出现次数」→ 反向自检当场失败：把 `gateMatrix.rcReadyGate(` 改名后仍然绿，
//      因为上一行**注释**里也写了 `rcReadyGate`，「被提到」被当成了「被接上」。
//   v2 先剥注释再数 → 更糟：`stripComments` 的块注释正则会被 server.js 里**正则字面量里的 `/*`**
//      骗到（如 `/--[^\n]*|\/\*[\s\S]*?\*\//g`），一路吃掉几百行真代码，于是 `parseContract`
//      这类明明在用的函数被判成不可达。用正则剥注释本就是个已知的坑活。
//   v3（现在）**只数调用点**：`fn(` 或 `.fn(`。注释里提函数名极少带括号，而真调用必然带。
//      比剥注释简单，也不会误伤——判据本身越简单，它自己出假绿的概率越低。
const read = f => { try { return fs.readFileSync(path.join(APP, f), 'utf8') } catch { return '' } }
// 调用点计数：`fn(` / `fn (` / `obj.fn(`。定义处 `export function fn(` 也会命中 → 调用方自行减 1。
const countCalls = (text, fn) => (String(text).match(new RegExp(`(?:\\.|\\b)${fn}\\s*\\(`, 'g')) || []).length

test('每个能力模块的导出函数都必须被真正接上（不是只被单测 import）', () => {
  const server = read('server.js')
  const sources = Object.fromEntries(MODULES.map(m => [m, read(`${m}.js`)]))
  const unreachable = []
  for (const m of MODULES) {
    const src = sources[m]
    assert.ok(src, `读不到 app/${m}.js`)
    for (const line of src.split('\n')) {
      const hit = line.match(/^export function ([A-Za-z_$][\w$]*)/)
      if (!hit) continue
      const fn = hit[1]
      if (ALLOW_UNREACHED.has(`${m}.${fn}`)) continue
      const selfUses = countCalls(src, fn) - 1                                  // 减掉定义处 `export function fn(` 那一次
      const inServer = countCalls(server, fn)
      const inOthers = MODULES.filter(x => x !== m).reduce((n, x) => n + countCalls(sources[x], fn), 0)
      if (selfUses <= 0 && inServer === 0 && inOthers === 0) unreachable.push(`${m}.${fn}`)
    }
  }
  assert.deepEqual(unreachable, [],
    `以下导出函数全仓零调用——要么接成 MCP 工具/接进引擎、要么删掉，别留成「看起来做了」：\n  ${unreachable.join('\n  ')}`)
})

// 反向自检：这条测试本身得真的能抓到东西，否则它只是个永远绿的摆设。
// **判据自己也会有假绿**，所以这几条不是可选项——上面注释里那两次打脸都是它抓出来的。
test('可达性判据：模块内被调=可达，无人调用=不可达', () => {
  const src = 'export function neverUsed() { return 1 }\nexport function usedInternally() { return neverUsed() }\n'
  assert.equal(countCalls(src, 'neverUsed') - 1, 1, '模块内被调了一次 → 可达')
  assert.equal(countCalls('export function lonely() { return 1 }\n', 'lonely') - 1, 0, '无人调用 → 判不可达')
})
test('★ 只在注释里被提到（无括号）→ 仍判不可达；v1 就栽在这里', () => {
  assert.equal(countCalls('// rcReadyGate 会把它算进 blocked\nconst x = 1\n', 'rcReadyGate'), 0)
  assert.equal(countCalls('/* 见 rcReadyGate 的说明 */\n', 'rcReadyGate'), 0)
  assert.equal(countCalls('  · `gateMatrix.rcReadyGate` 里 high 恒不放行\n', 'rcReadyGate'), 0)
})
test('★ 成员调用与裸调用都算可达（v3 的核心：只认括号）', () => {
  assert.equal(countCalls('const g = gateMatrix.rcReadyGate({})\n', 'rcReadyGate'), 1)
  assert.equal(countCalls('const g = rcReadyGate({})\n', 'rcReadyGate'), 1)
  assert.equal(countCalls('const g = rcReadyGate ({})\n', 'rcReadyGate'), 1)
})
test('★ 正则字面量里的 /* 不该吃掉真代码；v2 剥注释就栽在这里', () => {
  const src = 'const RE = /--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\//g\nconst c = guardLedger.parseContract(text)\n'
  assert.equal(countCalls(src, 'parseContract'), 1, '正则里的 /* 不能让后面的真调用消失')
})
test('★ 同名前缀不误命中（otherFn 不该算作 fn 的调用）', () => {
  assert.equal(countCalls('xxrcReadyGate({})\n', 'rcReadyGate'), 0)
})
