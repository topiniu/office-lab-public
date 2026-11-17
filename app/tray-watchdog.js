// ============================================================================
// 伙伴看护：引擎反过来盯托盘（Windows）
//
// 缘起（2026-09-09 实测，复盘 §3.130/§3.131）：翻 `app/runs/tray.log` 全量——托盘启动 **59 次，
// 只有 3 次留下退出记录、0 条 FATAL**，即 **56 次无声消失**；且 59 次启动没有一次撞上活着的前实例，
// 说明每次去启动上一个都真的已经死了。死因至今未定（已排除崩溃/WER/计划任务/Tick 异常）。
//
// 关键的不对称是本模块存在的理由：**托盘死了，引擎不会跟着死**。实测过——托盘被硬杀时
// `Quit-Tray`/`Stop-Server` 一行都不跑，而它用 `CreateNoWindow` 起的 node/vite 是孤儿进程、
// 继续跑到底（托盘没有 JobObject，server.js 也不守望父进程）。所以用户感知的「整个 lab 没了」
// 实际是**丢了全部控制面**（托盘图标、悬浮窗、health 轮询、Toast 审批回执、崩溃自动重启），
// 而引擎还在。既然引擎活得比托盘久、又天生无窗口，那它就是唯一现成、合适的看护者。
//
// 于是互为看护，谁都不是单点：
//   托盘 → 引擎：health 轮询 + 崩溃自动重启（既有能力，见 tray/office-lab-tray.ps1）
//   引擎 → 托盘：本模块（判活 + 限流拉起）
//   两个都死：开机自启兜下一次登录
//
// ---------------------------------------------------------------------------
// 三条刻意的设计约束（都是被真实踩坑逼出来的，改之前先读）
//
// ① **只"恢复"、绝不"引入"**：必须先亲眼见过托盘活着（`sawTrayAlive` 闭锁），才允许拉起。
//    否则在「用户就是要用 `node scripts/bootstrap.mjs` 前台跑、根本没打算开托盘」的机器上，
//    引擎会凭空弹出一个托盘图标——那是引擎替用户做决定，越权。闭锁把语义钉死成
//    「**把消失的那个托盘恢复回来**」，而不是「保证机器上有托盘」。
//
// ② **判活走命名 mutex，不枚举进程比命令行**。§3.130 里已经吃过一次亏：查询进程自己的命令行里
//    也含 `office-lab-tray.ps1`，于是 `Where-Object CommandLine -like '*office-lab-tray*'`
//    把**查询者本身**数成了托盘，PID 每查一次都变、险些据此得出错误结论。命名 mutex 没有这个问题：
//    对象只在有进程持有句柄时存在，托盘退出（含被杀）即释放销毁——「能打开 = 确实有活实例」。
//    这把锁的语义已实测确认（OpenExisting 命中活实例 / 不存在的名字抛 WaitHandleCannotBeOpened /
//    `New-Object Mutex($true,name,[ref]$isNew)` 二次抢占得 createdNew=False）。
//
// ③ **用户主动退出托盘不会被这里复活**，而且不需要额外的"用户意图"标志位：托盘的
//    「退出（并停服）」会先 `Stop-Server` 把引擎（含监控模式下接管的那个 PID）杀掉——**引擎都没了，
//    自然没人来复活**。所以「引擎活着 + 托盘不见了」这个组合本身就等价于「托盘意外死亡」，
//    判据天然干净。别再往上加 flag，加了反而多一处会漂的状态。
//
// 纯函数、可单测；接线（定时器 + 真正 spawn）在 server.js。
// ============================================================================

// 托盘的单实例锁名（与 tray/office-lab-tray.ps1 里的字面量必须一致）。
// ⚠ 这是**跨语言的隐藏契约**：改名要两处同改，否则看护永远判「托盘不在」→ 不停拉起 →
//   而真托盘的 mutex 又会把新起的挡掉，表现为日志里刷一串启动/静默退出。写成常量并在测试里锁住。
export const TRAY_MUTEX_NAME = 'OfficeLabTray_wangzichenglong'

// 判活探针输出的哨兵字符串。刻意不用退出码：PowerShell 里 `exit` 语义在 -Command/-File 下
// 不总一致（还会被 profile/策略干扰），而 stdout 里找一个不可能自然出现的词最稳。
export const PROBE_ALIVE = 'OLTRAY_ALIVE'
export const PROBE_DEAD = 'OLTRAY_DEAD'

// 看护节奏与限流默认值
export const WATCHDOG_INTERVAL_MS = 120_000      // 2 分钟敲一次门（托盘心跳是 5 分钟，这个粒度够）
export const RELAUNCH_COOLDOWN_MS = 60_000       // 刚拉起过就先等等，别和正在初始化的托盘抢
export const RELAUNCH_WINDOW_MS = 30 * 60_000    // 限流窗口
export const RELAUNCH_MAX_IN_WINDOW = 5          // 窗口内最多拉几次；超了就停手并点名

/**
 * 判活探针的 PowerShell 参数。
 * 只做一件事：能不能打开托盘那把命名 mutex，打得开打印 ALIVE、打不开打印 DEAD。
 * 注意 `-NoProfile`（避免用户 profile 拖慢/污染）与 `-NonInteractive`（绝不能弹任何东西）。
 */
export function trayAliveProbeArgs(mutexName = TRAY_MUTEX_NAME) {
  const script =
    `try { $m = [System.Threading.Mutex]::OpenExisting('${mutexName}'); $m.Dispose(); Write-Output '${PROBE_ALIVE}' } ` +
    `catch { Write-Output '${PROBE_DEAD}' }`
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

/**
 * 解析探针输出 → true(活) / false(死) / null(说不清)。
 * **说不清必须是独立的第三态**，不能塞进 false：PowerShell 起不来、被策略拦、超时……这些情形下
 * 把它当"托盘死了"就会去拉起，而那正是最容易演变成 spawn 风暴的一条路（同 §3.85 的教训：
 * 看门狗的判据必须能区分「这次值不值得动手」，探不到 ≠ 不在）。
 */
export function parseTrayAliveProbe(stdout, { timedOut = false } = {}) {
  if (timedOut) return null
  const s = String(stdout ?? '')
  if (s.includes(PROBE_ALIVE)) return true
  if (s.includes(PROBE_DEAD)) return false
  return null
}

/**
 * 拉起托盘的 spawn 规格。
 *
 * `windowsHide: true` → CREATE_NO_WINDOW：**不创建窗口，因此不触发 Win11 默认终端交接**
 *   （§3.129 的根因就是交接：`-WindowStyle Hidden` 与脚本内 SW_HIDE 都管不到 WindowsTerminal 造的那扇窗）。
 *   这里若用普通 spawn，看护每次拉起都会在用户桌面上弹一个终端窗口——比要解决的问题更烦。
 *
 * ★ **绝不能加 `detached: true`**（2026-09-09 实测确诊，§3.131）。直觉上"脱离进程组好让托盘比引擎活得久"
 *   完全说得通，我第一版就是这么写的、还配了一条单测断言 `detached === true`——**两个都错，而且单测
 *   替这个错误盖了章**。真相：Node 在 Windows 上把 `detached` 翻成 `DETACHED_PROCESS`，子进程**一个控制台
 *   都没有**，而 PowerShell 5.1 的 ConsoleHost 必须有控制台 → **启动即静默退出，退出码还是 0**。
 *   隔离实验（同一句 `Write-Output "PS_RAN_OK"; exit 7`）：
 *     windowsHide:true      → exit=7 跑起来了 ✔
 *     detached:true         → exit=0 没跑     ✘
 *     windowsHide+detached  → exit=0 没跑     ✘
 *     两个都不给            → exit=7 跑起来了 ✔
 *   表现有多阴：拉起"成功"（拿到 pid、close 事件给 0），托盘却连 tray.log 第一行都没写——
 *   和这一整天在修的那类静默失败一模一样。
 *
 * 那"活得比引擎久"怎么保证？**不需要 detached**：Windows 上 Node 不会在父进程退出时杀子进程，
 *   且同型证据现成——托盘用 CreateNoWindow（无 detached）起的 node/vite，在托盘被硬杀后
 *   实测活到自然结束（60/60 心跳，§3.130）。对称情形，同样成立。
 *
 * `stdio: 'ignore'` → 不与引擎共享任何句柄。刻意不接 pipe：托盘要比引擎活得久，留一条 stderr 管子
 *   意味着引擎重启后托盘那头变成坏管子（真写 stderr 时可能抛）。"拉起了却没起来"这件事改由
 *   **拉起后复核**来发现（server.js 里那个延时 re-probe），而不是靠读它的输出。
 */
export function trayRelaunchSpec(trayScriptPath) {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-File', trayScriptPath],
    options: { windowsHide: true, stdio: 'ignore' },
  }
}

// 拉起后多久回头复核「到底起来了没」。取 15s：托盘从启动到 `托盘图标已就绪` 实测约 3~5s（含
// 自我重启一层 + logo 生成 + 端口判定），留足余量但别让失败拖太久才被发现。
export const RELAUNCH_VERIFY_DELAY_MS = 15_000

/**
 * 该不该拉起。纯函数——所有输入显式传，便于单测覆盖每条分支。
 *
 * @param {object} s
 *   platform        process.platform
 *   enabled         总开关（env 可关）
 *   trayAlive       true/false/null（null=探不到）
 *   sawTrayAlive    本次引擎生命周期内是否曾见过托盘活着（约束①的闭锁）
 *   now             时间戳
 *   relaunchedAt    历史拉起时刻数组
 *   lastRelaunchAt  最近一次拉起时刻（null=没拉过）
 * @returns {{action:'skip'|'relaunch', reason:string}}
 */
export function decideTrayAction(s = {}) {
  const {
    platform = process.platform, enabled = true, trayAlive = null, sawTrayAlive = false,
    now = Date.now(), relaunchedAt = [], lastRelaunchAt = null,
    cooldownMs = RELAUNCH_COOLDOWN_MS, windowMs = RELAUNCH_WINDOW_MS, maxInWindow = RELAUNCH_MAX_IN_WINDOW,
  } = s

  if (platform !== 'win32') return { action: 'skip', reason: 'not-windows' }
  if (!enabled) return { action: 'skip', reason: 'disabled' }
  if (trayAlive === null) return { action: 'skip', reason: 'probe-inconclusive' }
  if (trayAlive === true) return { action: 'skip', reason: 'tray-alive' }

  // 约束①：没见过它活着，就不是"恢复"，不动手
  if (!sawTrayAlive) return { action: 'skip', reason: 'never-saw-tray' }

  if (lastRelaunchAt != null && (now - lastRelaunchAt) < cooldownMs) {
    return { action: 'skip', reason: 'cooldown' }
  }
  const recent = relaunchedAt.filter(t => (now - t) < windowMs)
  if (recent.length >= maxInWindow) {
    return { action: 'skip', reason: 'rate-limited' }
  }
  return { action: 'relaunch', reason: 'tray-gone' }
}

/** 记一次拉起（同时按窗口裁剪历史，别无限增长）。纯函数，返回新数组。 */
export function noteRelaunch(relaunchedAt = [], now = Date.now(), windowMs = RELAUNCH_WINDOW_MS) {
  return [...relaunchedAt.filter(t => (now - t) < windowMs), now]
}
