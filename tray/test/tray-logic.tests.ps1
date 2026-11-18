# 托盘纯决策层的测试（零依赖：不用 Pester，不需要 WinForms / 服务 / 端口）
#   跑法：powershell -NoProfile -ExecutionPolicy Bypass -File tray/test/tray-logic.tests.ps1
#   或经仓根 npm script：npm run test:tray
# 失败即非零退出码，便于接 CI / 一键全测。
$ErrorActionPreference = 'Stop'
# 注意：Windows PowerShell 5.1 的 Join-Path 只接两个位置参数（多段拼接是 PS7 才有），必须嵌套。
. (Join-Path (Join-Path $PSScriptRoot '..') 'lib\tray-logic.ps1')

$script:pass = 0
$script:fail = 0
function It([string]$name, [scriptblock]$body) {
  try { & $body; $script:pass++; Write-Host "  [PASS] $name" -ForegroundColor DarkGray }
  catch { $script:fail++; Write-Host "  [FAIL] $name" -ForegroundColor Red; Write-Host "         $($_.Exception.Message)" -ForegroundColor Red }
}
function Should-Be($actual, $expected, [string]$because = '') {
  if ("$actual" -ne "$expected") { throw "期望 [$expected]，实得 [$actual]$(if ($because) { " —— $because" })" }
}

$T0 = Get-Date '2026-09-09T18:00:00'

Write-Host '① 崩溃自动重启限流' -ForegroundColor Cyan

It '用户主动停止：不算崩溃，不计数、不重启' {
  $d = Get-CrashRestartDecision -UserStopped $true -AutoRestart $true -Restarts 0 -LastCrashAt $null -Now $T0
  Should-Be $d.action 'user-stopped'
  Should-Be $d.restarts 0
}
It '首次崩溃 + 自动重启开着 → 重启，计数变 1' {
  $d = Get-CrashRestartDecision -UserStopped $false -AutoRestart $true -Restarts 0 -LastCrashAt $null -Now $T0
  Should-Be $d.action 'restart'
  Should-Be $d.restarts 1
  Should-Be $d.lastCrashAt $T0 '必须把本次崩溃时刻记下来，否则限流窗口无从计算'
}
It '自动重启被用户关掉 → 一次都不重启（哪怕是第一次崩）' {
  $d = Get-CrashRestartDecision -UserStopped $false -AutoRestart $false -Restarts 0 -LastCrashAt $null -Now $T0
  Should-Be $d.action 'give-up'
  Should-Be $d.restarts 0
}
It '★ 到达上限就停手（防烧钱死循环）：已重启 5 次 → give-up' {
  $d = Get-CrashRestartDecision -UserStopped $false -AutoRestart $true -Restarts 5 -LastCrashAt $T0.AddSeconds(-10) -Now $T0
  Should-Be $d.action 'give-up'
}
It '上限前一步仍然重启（第 5 次要放行，别提前一次停手）' {
  $d = Get-CrashRestartDecision -UserStopped $false -AutoRestart $true -Restarts 4 -LastCrashAt $T0.AddSeconds(-10) -Now $T0
  Should-Be $d.action 'restart'
  Should-Be $d.restarts 5
}
It '★ 离上次崩溃超过窗口 → 计数清零重新来（否则跑了一天崩两次也会永久停手）' {
  $d = Get-CrashRestartDecision -UserStopped $false -AutoRestart $true -Restarts 5 -LastCrashAt $T0.AddSeconds(-61) -Now $T0
  Should-Be $d.action 'restart' '间隔 61s > 60s 窗口，应清零后重启'
  Should-Be $d.restarts 1
}
It '窗口边界：正好 60s 不清零（实现用的是 -gt，边界含在窗口内）' {
  $d = Get-CrashRestartDecision -UserStopped $false -AutoRestart $true -Restarts 5 -LastCrashAt $T0.AddSeconds(-60) -Now $T0
  Should-Be $d.action 'give-up'
}
It '★ 钉住实际语义：窗口是「与上一次崩溃的间隔」，不是「60s 内累计」——每 59s 崩一次连崩 5 次也会到上限' {
  # 这条刻意存在：源码注释写的是「60s 内累计 5 次」，实现是「相邻间隔 ≤60s 才累计」。
  # 两者对崩溃循环都算合理防护，但语义不同。先把**实际行为**钉死，防止有人照注释改出一个
  # 自以为等价的版本（真要改成固定窗口，得改成保留崩溃时刻列表，那是另一件事）。
  $r = 0; $last = $null; $t = $T0
  $actions = @()
  for ($i = 0; $i -lt 6; $i++) {
    $d = Get-CrashRestartDecision -UserStopped $false -AutoRestart $true -Restarts $r -LastCrashAt $last -Now $t
    $actions += $d.action; $r = $d.restarts; $last = $d.lastCrashAt
    $t = $t.AddSeconds(59)   # 每次间隔 59s < 60s，故一路累计
  }
  Should-Be ($actions -join ',') 'restart,restart,restart,restart,restart,give-up' '第 6 次应停手，总跨度已约 5 分钟'
}

Write-Host '② 探活失败裁决（§3.85 事故的判据本体）' -ForegroundColor Cyan

It '★ 监控模式一次超时不算死（引擎忙一下就可能超时）' {
  $d = Get-HealthProbeDecision -Monitor $true -ProbeFails 1 -PortOwnerPid 0
  Should-Be $d.action 'wait'
  Should-Be $d.state 'unhealthy'
  Should-Be $d.keepMonitorPid $true 'PID 是右键停止/重启唯一的把手，绝不能丢'
}
It '两次也还不算死（三振才认）' {
  Should-Be (Get-HealthProbeDecision -Monitor $true -ProbeFails 2 -PortOwnerPid 0).action 'wait'
}
It '★★ 三振但端口仍有主 → 判「卡顿而非退出」，绝不拉替身（拉了就撞端口、把真引擎连累自杀）' {
  $d = Get-HealthProbeDecision -Monitor $true -ProbeFails 3 -PortOwnerPid 12556
  Should-Be $d.action 'stuck-not-dead'
  Should-Be $d.state 'unhealthy'
  Should-Be $d.newMonitorPid 12556 '要把端口真正的主人记成 monitorPid，接管清理才有把手'
}
It '★ 三振且端口确实空了 → 才允许接管拉起' {
  $d = Get-HealthProbeDecision -Monitor $true -ProbeFails 3 -PortOwnerPid 0
  Should-Be $d.action 'takeover-start'
  Should-Be $d.state 'stopped'
  Should-Be $d.resetFails $true
}
It '失败次数远超三振、端口仍有主 → 依然只判卡顿（次数多不改变「端口有主」这个事实）' {
  Should-Be (Get-HealthProbeDecision -Monitor $true -ProbeFails 99 -PortOwnerPid 777).action 'stuck-not-dead'
}
It '托盘自己托管、状态 starting → 维持 starting（刚起进程 health 还没就绪，不能判 unhealthy）' {
  $d = Get-HealthProbeDecision -Monitor $false -ProbeFails 1 -PortOwnerPid 0 -State 'starting'
  Should-Be $d.action 'starting'
  Should-Be $d.state 'starting'
}
It '托盘自己托管、已 running 过又失联 → unhealthy' {
  Should-Be (Get-HealthProbeDecision -Monitor $false -ProbeFails 1 -PortOwnerPid 0 -State 'running').state 'unhealthy'
}

Write-Host '③ 通知游标与事件判别（§3.130 毒丸）' -ForegroundColor Cyan

It '★ 游标推进不依赖弹卡成功：一批事件里取最大 seq' {
  $evs = @([pscustomobject]@{ seq = 21; status = 'done' }, [pscustomobject]@{ seq = 23; status = $null }, [pscustomobject]@{ seq = 22; status = 'error' })
  Should-Be (Get-NextNotifyCursor -Since 20 -Events $evs) 23 '含坏事件也要推过去，否则 4 秒一轮永久重放'
}
It '空批次不倒退游标' {
  Should-Be (Get-NextNotifyCursor -Since 20 -Events @()) 20
  Should-Be (Get-NextNotifyCursor -Since 20 -Events $null) 20
}
It '旧 seq 不倒退游标' {
  Should-Be (Get-NextNotifyCursor -Since 20 -Events @([pscustomobject]@{ seq = 5 })) 20
}
It 'seq 缺失/非数字的事件被跳过、不打断整批' {
  $evs = @([pscustomobject]@{ seq = $null }, [pscustomobject]@{ seq = 'abc' }, [pscustomobject]@{ seq = 30 })
  Should-Be (Get-NextNotifyCursor -Since 20 -Events $evs) 30
}
It '★ 无 status 的非收工事件（lark-sync）判 false，不进 Toast（$hash[$null] 会抛，必须先判空）' {
  Should-Be (Test-IsStopEvent ([pscustomobject]@{ seq = 1; kind = 'lark-sync' })) $false
  Should-Be (Test-IsStopEvent ([pscustomobject]@{ seq = 1; status = $null })) $false
  Should-Be (Test-IsStopEvent ([pscustomobject]@{ seq = 1; status = '' })) $false
  Should-Be (Test-IsStopEvent $null) $false
}
It '三种收工状态都认' {
  foreach ($s in @('done', 'error', 'interrupted')) {
    Should-Be (Test-IsStopEvent ([pscustomobject]@{ status = $s })) $true "status=$s 应判为收工事件"
  }
}
It '未知 status 不认（别把新枚举当收工瞎弹）' {
  Should-Be (Test-IsStopEvent ([pscustomobject]@{ status = 'queued' })) $false
}

Write-Host ''
Write-Host "通过 $script:pass · 失败 $script:fail" -ForegroundColor $(if ($script:fail) { 'Red' } else { 'Green' })
if ($script:fail -gt 0) { exit 1 }
exit 0
