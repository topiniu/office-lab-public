import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRAY_MUTEX_NAME, PROBE_ALIVE, PROBE_DEAD,
  trayAliveProbeArgs, parseTrayAliveProbe, trayRelaunchSpec,
  decideTrayAction, noteRelaunch,
  RELAUNCH_COOLDOWN_MS, RELAUNCH_WINDOW_MS, RELAUNCH_MAX_IN_WINDOW,
} from '../tray-watchdog.js'

const WIN = { platform: 'win32', enabled: true, sawTrayAlive: true }

// ---------- 跨语言契约 ----------


// ---------- 判活探针 ----------
test('探针脚本用 OpenExisting、带 -NoProfile/-NonInteractive、且不枚举进程（§3.130 的自匹配坑）', () => {
  const a = trayAliveProbeArgs()
  assert.ok(a.includes('-NoProfile'))
  assert.ok(a.includes('-NonInteractive'))
  const script = a[a.length - 1]
  assert.match(script, /OpenExisting/)
  assert.ok(script.includes(TRAY_MUTEX_NAME))
  assert.doesNotMatch(script, /Get-CimInstance|Get-Process|CommandLine/, '判活不得走枚举进程比命令行那条路')
})
test('探针输出解析：ALIVE / DEAD / 说不清各成一态', () => {
  assert.equal(parseTrayAliveProbe(`${PROBE_ALIVE}\n`), true)
  assert.equal(parseTrayAliveProbe(`noise\n${PROBE_DEAD}\r\n`), false)
  assert.equal(parseTrayAliveProbe(''), null, '空输出=说不清')
  assert.equal(parseTrayAliveProbe('some powershell error'), null, '认不出的输出=说不清')
  assert.equal(parseTrayAliveProbe(undefined), null)
  assert.equal(parseTrayAliveProbe(PROBE_ALIVE, { timedOut: true }), null, '超时一律说不清，哪怕拿到了字样')
})

// ---------- 拉起规格 ----------
test('拉起必须 windowsHide（否则每次看护都在桌面弹终端窗口，§3.129 的交接坑）', () => {
  const spec = trayRelaunchSpec('D:\\x\\tray\\office-lab-tray.ps1')
  assert.equal(spec.options.windowsHide, true)
  assert.equal(spec.file, 'powershell.exe')
  assert.ok(spec.args.includes('-Sta'), 'WinForms 需要 STA')
  assert.ok(spec.args.includes('-File'))
  assert.equal(spec.args[spec.args.length - 1], 'D:\\x\\tray\\office-lab-tray.ps1')
})
test('★★ 绝不能 detached —— Windows 上它=DETACHED_PROCESS，PowerShell 没控制台会「静默退出且码 0」', () => {
  // 这条测试是**翻案留下的护栏**（§3.131）。第一版规格写了 `detached: true`（"脱离进程组好让托盘
  // 比引擎活得久"，听起来完全正确），而且当时的单测断言的正是 `detached === true` —— **单测替这个
  // 错误盖了章，只有端到端跑真链路才发现托盘压根没起来、tray.log 一行都没写**。
  // 隔离实验（`Write-Output "PS_RAN_OK"; exit 7`）：windowsHide→exit 7 跑了；detached→exit 0 没跑；
  // 两者并用→exit 0 没跑；都不给→exit 7 跑了。
  // 「活得比引擎久」不靠 detached：Windows 上 Node 不在父退出时杀子进程，且托盘用 CreateNoWindow
  // 起的 node/vite 在托盘被硬杀后实测活到自然结束（§3.130）。
  const spec = trayRelaunchSpec('D:\\x\\tray\\office-lab-tray.ps1')
  assert.ok(!spec.options.detached, 'detached 会让 PowerShell 拿不到控制台、启动即静默退出（码 0，最难查的一种失败）')
})
test('stdio 用 ignore：不与引擎共享句柄（托盘要比引擎活得久，留 pipe 会在引擎重启后变坏管子）', () => {
  assert.equal(trayRelaunchSpec('x').options.stdio, 'ignore')
})

// ---------- 决策：跳过的每一条理由 ----------
test('非 Windows 一律不动手', () => {
  assert.deepEqual(decideTrayAction({ ...WIN, platform: 'darwin', trayAlive: false }), { action: 'skip', reason: 'not-windows' })
  assert.deepEqual(decideTrayAction({ ...WIN, platform: 'linux', trayAlive: false }), { action: 'skip', reason: 'not-windows' })
})
test('总开关关掉就不动手', () => {
  assert.equal(decideTrayAction({ ...WIN, enabled: false, trayAlive: false }).reason, 'disabled')
})
test('托盘活着 → 跳过', () => {
  assert.equal(decideTrayAction({ ...WIN, trayAlive: true }).reason, 'tray-alive')
})
test('★ 探不到（null）绝不能当成"死了"去拉起 —— 那是 spawn 风暴的入口（§3.85 同族）', () => {
  const d = decideTrayAction({ ...WIN, trayAlive: null })
  assert.equal(d.action, 'skip')
  assert.equal(d.reason, 'probe-inconclusive')
})
test('★ 只恢复不引入：没见过托盘活着（用户就想前台跑 bootstrap）→ 引擎不得凭空弹一个托盘出来', () => {
  const d = decideTrayAction({ ...WIN, sawTrayAlive: false, trayAlive: false })
  assert.equal(d.action, 'skip')
  assert.equal(d.reason, 'never-saw-tray')
})

// ---------- 决策：该拉起 ----------
test('见过它活着 + 现在不在 → 拉起', () => {
  const d = decideTrayAction({ ...WIN, trayAlive: false })
  assert.equal(d.action, 'relaunch')
  assert.equal(d.reason, 'tray-gone')
})

// ---------- 限流 ----------
test('冷却期内不重复拉（别和正在初始化的托盘抢）', () => {
  const now = 1_000_000
  assert.equal(decideTrayAction({ ...WIN, trayAlive: false, now, lastRelaunchAt: now - 1000 }).reason, 'cooldown')
  assert.equal(decideTrayAction({ ...WIN, trayAlive: false, now, lastRelaunchAt: now - RELAUNCH_COOLDOWN_MS - 1 }).action, 'relaunch')
})
test('窗口内拉够次数就停手并点名（有东西在系统性地杀托盘时，别陪着刷进程）', () => {
  const now = 2_000_000
  const many = Array.from({ length: RELAUNCH_MAX_IN_WINDOW }, (_, i) => now - (i + 1) * 60_000)
  assert.equal(decideTrayAction({ ...WIN, trayAlive: false, now, relaunchedAt: many }).reason, 'rate-limited')
})
test('窗口外的历史不计入限流（旧账要滚出去，否则一天后就永久停手了）', () => {
  const now = 3_000_000
  const old = Array.from({ length: RELAUNCH_MAX_IN_WINDOW + 3 }, (_, i) => now - RELAUNCH_WINDOW_MS - (i + 1) * 1000)
  assert.equal(decideTrayAction({ ...WIN, trayAlive: false, now, relaunchedAt: old }).action, 'relaunch')
})
test('限流优先级低于冷却，但都高于"该拉起"', () => {
  const now = 4_000_000
  const d = decideTrayAction({ ...WIN, trayAlive: false, now, lastRelaunchAt: now - 1, relaunchedAt: [now - 1] })
  assert.equal(d.reason, 'cooldown')
})

// ---------- 历史裁剪 ----------
test('noteRelaunch 记一次并裁掉窗口外的旧账', () => {
  const now = 5_000_000
  const out = noteRelaunch([now - RELAUNCH_WINDOW_MS - 1, now - 1000], now)
  assert.deepEqual(out, [now - 1000, now])
})
test('noteRelaunch 不改入参（纯函数）', () => {
  const now = 6_000_000
  const input = [now - 500]
  const out = noteRelaunch(input, now)
  assert.deepEqual(input, [now - 500])
  assert.equal(out.length, 2)
})
test('连续拉起时历史单调增长到上限即触发限流（端到端串一遍状态机）', () => {
  let hist = []
  let last = null
  let now = 7_000_000
  let launched = 0
  for (let i = 0; i < 12; i++) {
    const d = decideTrayAction({ ...WIN, trayAlive: false, now, relaunchedAt: hist, lastRelaunchAt: last })
    if (d.action === 'relaunch') { hist = noteRelaunch(hist, now); last = now; launched++ }
    now += RELAUNCH_COOLDOWN_MS + 1   // 每轮都过了冷却，只剩限流能挡
  }
  assert.equal(launched, RELAUNCH_MAX_IN_WINDOW, `窗口内应恰好拉 ${RELAUNCH_MAX_IN_WINDOW} 次后停手，实际 ${launched}`)
})
