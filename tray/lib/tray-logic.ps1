# ============================================================================
# 托盘的「纯决策」层 —— 无副作用、可单测
#
# 缘起（2026-09-09，§3.131）：托盘脚本 1264 行、44 个函数，而 `app/test/` 里 30 个测试文件对它的
# 覆盖是 **0**。同一天在它里面查出三个 bug（窗口宿主 §3.129、无声消失 + Toast 毒丸 §3.130），
# 全靠人肉复现。问题不是"没人写测试"，是**最容易错的判断被焊死在 WinForms 事件回调里，结构上测不了**：
# 端口仲裁、探活三振、崩溃限流这些纯逻辑，跟画图标、弹 Toast 挤在同一个 Tick 闭包中。
#
# 本文件先搬**出过真事故的那两个**（不是全部——一次性重构 1264 行、又赶在刚修完它的当天，是拿
# 未来的排查清晰度换今天的整洁，不划算）：
#   ① 崩溃自动重启限流 —— 判错的代价是「烧钱死循环」或「该拉不拉」
#   ② 探活失败裁决     —— 判错的代价就是 §3.85 那次事故：引擎在忙被判死 → 拉替身撞端口 → 引擎自杀 →
#                          再判死…… 用户看到一串「服务异常退出」，而引擎一直在正常干活
#
# 纪律：**本文件里的函数不许有副作用**（不写日志、不弹气泡、不起进程、不读 $script:*）。
#   所有输入显式传参、所有输出用 hashtable 返回，调用方（office-lab-tray.ps1）负责把决策落地。
#   这样才能在没有 WinForms、没有服务、没有端口的环境里把每条分支跑一遍。
#
# 行为约定：本次抽取**刻意一字不改原有行为**（含下面 ① 那处注释与实现不一致的地方——见函数内说明）。
#   重构和改行为分两步走，否则出问题时分不清是哪一步引入的。
# ============================================================================

# ---------------------------------------------------------------------------
# ① 崩溃自动重启限流
# ---------------------------------------------------------------------------
# 原实现（office-lab-tray.ps1 心跳 Tick 内）：
#   if ($userStopped) { state = 'stopped' }
#   else {
#     if ($lastCrashAt -and ($now - $lastCrashAt).TotalSeconds -gt 60) { $restarts = 0 }
#     $lastCrashAt = $now
#     if ($autoRestart -and $restarts -lt 5) { $restarts++; 重启 } else { state='stopped'; 放弃 }
#   }
#
# ⚠ 一处「注释与实现不一致」，抽取时原样保留并在此点名（不在重构里顺手改行为）：
#   注释写的是「**60s 内累计** 5 次以上则停手」，实现其实是「**与上一次崩溃的间隔** ≤60s 才累计」。
#   所以每 59 秒崩一次、连崩 5 次（总跨度约 4 分钟）也会到上限。两者对"崩溃循环"都算合理防护，
#   但语义不同：真要改成固定窗口，得改成保留崩溃时刻列表。这里先用测试把**实际语义**钉住，
#   免得下次有人照注释理解、改出一个自以为等价的版本。
function Get-CrashRestartDecision {
  param(
    [bool]$UserStopped,
    [bool]$AutoRestart,
    [int]$Restarts,
    [Nullable[datetime]]$LastCrashAt,
    [datetime]$Now,
    [int]$WindowSec = 60,
    [int]$MaxRestarts = 5
  )
  if ($UserStopped) {
    # 用户主动停的：不是崩溃，不计数、不重启、不动 lastCrashAt
    return @{ action = 'user-stopped'; restarts = $Restarts; lastCrashAt = $LastCrashAt }
  }
  $r = $Restarts
  if ($null -ne $LastCrashAt -and ($Now - $LastCrashAt).TotalSeconds -gt $WindowSec) { $r = 0 }
  if ($AutoRestart -and $r -lt $MaxRestarts) {
    return @{ action = 'restart'; restarts = $r + 1; lastCrashAt = $Now }
  }
  return @{ action = 'give-up'; restarts = $r; lastCrashAt = $Now }
}

# ---------------------------------------------------------------------------
# ② 探活失败裁决（§3.85 事故的判据本体）
# ---------------------------------------------------------------------------
# 两条铁律，测试逐条钉住：
#   · **一次超时不算死**：引擎忙一下（多会话流式 + jsonl 落盘 + 大响应压缩）就可能超过 3s。
#     要连续 $Strikes 次（≈12s）才认。
#   · **「端口还有没有主」只信 TCP 监听表**，不拿 HTTP 应答当代理。端口仍被占 → 判「卡顿」而非
#     「退出」，绝不拉替身（拉了就撞 EADDRINUSE、把真引擎连累自杀），也绝不丢 monitorPid
#     （那是右键「停止/重启」唯一的把手，丢了用户只能去任务管理器手杀）。
#
# @param Monitor      是否监控模式（托盘没托管进程、但端口上有别人的服务）
# @param ProbeFails   本次失败**已计入后**的连续失败次数
# @param PortOwnerPid Get-PortOwnerPid 的结果（0 = 端口无人监听）
# @param State        当前状态（非监控模式下用来区分 starting/已 running 过）
function Get-HealthProbeDecision {
  param(
    [bool]$Monitor,
    [int]$ProbeFails,
    [int]$PortOwnerPid,
    [string]$State = '',
    [int]$Strikes = 3
  )
  if ($Monitor) {
    if ($ProbeFails -lt $Strikes) {
      return @{ action = 'wait'; state = 'unhealthy'; keepMonitorPid = $true; resetFails = $false }
    }
    if ($PortOwnerPid -gt 0) {
      # 端口仍有主 = 服务还在（只是卡/慢）。保住把手、绝不拉替身。
      return @{ action = 'stuck-not-dead'; state = 'unhealthy'; keepMonitorPid = $true; newMonitorPid = $PortOwnerPid; resetFails = $false }
    }
    # 端口确实空了 → 服务真的走了，托盘接管拉起
    return @{ action = 'takeover-start'; state = 'stopped'; keepMonitorPid = $false; resetFails = $true }
  }
  # 托盘自己托管的进程：刚起时 health 还没就绪 → 维持 starting；已 running 过又失联 → unhealthy
  if ($State -eq 'starting') {
    return @{ action = 'starting'; state = 'starting'; keepMonitorPid = $true; resetFails = $false }
  }
  return @{ action = 'unhealthy'; state = 'unhealthy'; keepMonitorPid = $true; resetFails = $false }
}

# ---------------------------------------------------------------------------
# ③ 通知游标推进（§3.130 毒丸的那一处）
# ---------------------------------------------------------------------------
# 规则：**先推进游标、再弹卡**，且单条失败只跳过它自己。
#   原写法把推进放在弹卡之后且两者都不设防 → 一条坏事件让 foreach 中断、游标永久停在它前面 →
#   4 秒一轮无限重放同一批 → Toast 链路被永久毒死（且异常被 PowerShell 委托吞掉、零日志）。
# 这里只算「游标该推到哪」，弹卡与异常兜底留给调用方。
function Get-NextNotifyCursor {
  param([int]$Since, $Events)
  $max = $Since
  foreach ($e in @($Events)) {
    if ($null -eq $e) { continue }
    $seq = 0
    try { $seq = [int]$e.seq } catch { continue }
    if ($seq -gt $max) { $max = $seq }
  }
  return $max
}

# 非收工事件（lark-sync 等）没有 status 字段。PowerShell 的 `$hash[$null]` **抛异常**而不是返回 $null，
# 所以「先判空再索引」不是风格问题、是正确性问题（§3.130：写在下一行的 guard 永远等不到执行）。
function Test-IsStopEvent {
  param($Ev)
  if ($null -eq $Ev) { return $false }
  $s = [string]$Ev.status
  if (-not $s) { return $false }
  return @('done', 'error', 'interrupted') -contains $s
}
