<#
  office-lab 整机迁移 · 打包（源机器执行）

  把档案、会话、设置打成一个目录，拿到另一台 Windows 上用「迁移恢复.ps1」还原。两种模式：

  ① 完整包（默认）：连代码一起打，新机器上不需要 git。
       workspace\office-lab\   本仓全部（含 .git、app\runs、app\uploads、tasks、memories…）
       workspace\<兄弟仓>\     仅 -IncludeSiblings 时（排除 node_modules/target/dist）

  ② 数据包（-DataOnly）：只打 git 里没有的运行数据，代码在新机器上 git clone。
       data\app\runs\                   会话流水、索引、各渠道设置（*-config.json）
       data\app\uploads\                上传的附件
       data\.claude\settings.local.json 本仓的 Claude 本地权限设置
       data\templates\uploads\          模板目录里的接口留档
     打包前会检查：本仓没有未提交的改动、当前提交已推送到远端（否则新机器 clone 不到一致的代码）。
     清单里记下当前提交号，恢复时核对 clone 下来的是不是同一个提交。

  两种模式都会带上：
       home\.claude\       Claude 会话原文（员工续跑同一上下文靠它）、全局设置、技能、记忆
       home\.claude.json   Claude Code 全局配置（MCP 等）
       迁移恢复.ps1         恢复脚本副本，新机器上直接运行它即可
       manifest.json       来源路径、时间、提交号、统计

  不打包：.tmp（临时快照，GB 级）、wecom_sidecar\.venv（虚拟环境写死本机路径，到新机器重建）、调试残渣。
  Claude 登录态存在 Windows 凭据管理器里，打不进包，到新机器要重新登录。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\迁移打包.ps1 -Dest D:\ol-migrate -DataOnly
    可选：-DataOnly          只打运行数据（配合 git clone 使用，包小很多）
          -IncludeSiblings   完整包模式下连同工作区里的兄弟仓一起打
          -SkipNodeModules   完整包模式下不拷 node_modules（新机器上 bootstrap 会自动安装）
          -Force             office-lab 仍在运行、或数据包模式下代码未提交/未推送时也继续（不建议）
#>
param(
  [Parameter(Mandatory = $true)][string]$Dest,
  [switch]$DataOnly,
  [switch]$IncludeSiblings,
  [switch]$SkipNodeModules,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$OfficeRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WorkspaceRoot = Split-Path $OfficeRoot -Parent
$OfficeName = Split-Path $OfficeRoot -Leaf
$ClaudeHome = Join-Path $env:USERPROFILE '.claude'
$ClaudeJson = Join-Path $env:USERPROFILE '.claude.json'
# 数据包模式要带的「git 里没有、但运行状态依赖」的路径（相对本仓根）
$DataPaths = @(
  'tasks', 'memories','app\runs', 'app\uploads', '.claude\settings.local.json', 'templates\uploads')

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  $t" -ForegroundColor Red; exit 1 }

# robocopy：退出码 >= 8 才是失败
function Copy-Tree($src, $dst, [string[]]$xd = @(), [string[]]$xf = @()) {
  $rcArgs = @($src, $dst, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NP')
  if ($xd.Count) { $rcArgs += '/XD'; $rcArgs += $xd }
  if ($xf.Count) { $rcArgs += '/XF'; $rcArgs += $xf }
  & robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）：$src -> $dst" }
}
function Size-Of($p, [string]$excludeRe = '') {
  if (-not (Test-Path $p)) { return 0 }
  $items = Get-ChildItem $p -Recurse -File -Force -ErrorAction SilentlyContinue
  if ((Get-Item $p -Force).PSIsContainer -eq $false) { $items = @(Get-Item $p -Force) }
  if ($excludeRe) { $items = $items | Where-Object { $_.FullName -notmatch $excludeRe } }
  $s = ($items | Measure-Object Length -Sum).Sum
  if ($s) { return $s } else { return 0 }
}
# git 输出 UTF-8（中文文件名），PowerShell 默认按系统代码页解码会乱码，调用期间临时切成 UTF-8
function GitOut([string[]]$a) {
  $prev = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $out = & git -C $OfficeRoot -c core.quotepath=false @a 2>&1
    return @{ code = $LASTEXITCODE; out = ($out -join "`n").Trim() }
  } finally { [Console]::OutputEncoding = $prev }
}

# ---------- 0. 运行中检查 ----------
Step '检查 office-lab 是否在运行'
$escRoot = [regex]::Escape($OfficeRoot)
# 引擎（node app\server.js）、托盘（office-lab-tray.ps1）、悬浮窗（user-data-dir 在本仓的 msedgewebview2）任一在跑都算
$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'app[\\/]server\.js') -or
  ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'office-lab-tray\.ps1') -or
  ($_.Name -eq 'msedgewebview2.exe' -and $_.CommandLine -match $escRoot) })
$listen = @(Get-NetTCPConnection -State Listen -LocalPort 4800 -ErrorAction SilentlyContinue)
$skipWebview = $false
if ($running.Count -or $listen.Count) {
  if (-not $Force) {
    Fail "office-lab 仍在运行（相关进程 $($running.Count) 个 / 端口 4800 监听 $($listen.Count) 个）。请先从托盘菜单退出（引擎和托盘都要退），再重新运行本脚本；确实要继续请加 -Force。"
  }
  # 悬浮窗开着时 webview2 的 Cookies 等文件被独占锁住，robocopy 必失败；它只是悬浮窗界面缓存，跳过即可
  $skipWebview = $true
  Warn '仍在运行，按 -Force 继续：跳过 app\runs\webview2（悬浮窗缓存，被占用）；app\runs\index.json 可能拷到写一半的状态'
} else { Ok '未在运行' }

# ---------- 1. 数据包模式：代码必须已提交并推送 ----------
$gitInfo = $null
if ($DataOnly) {
  Step '检查代码是否已提交并推送（数据包模式）'
  if ((GitOut @('rev-parse', '--is-inside-work-tree')).out -ne 'true') { Fail "$OfficeRoot 不是 git 仓库，数据包模式用不了；请改用完整包（去掉 -DataOnly）" }
  $head = (GitOut @('rev-parse', 'HEAD')).out
  $branch = (GitOut @('rev-parse', '--abbrev-ref', 'HEAD')).out
  $upstream = GitOut @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  $problems = @()
  $dirty = @((GitOut @('status', '--porcelain')).out -split "`n" | Where-Object { $_ })
  if ($dirty.Count) { $problems += "有 $($dirty.Count) 处未提交的改动（新机器 clone 不到）：`n      " + (($dirty | Select-Object -First 10) -join "`n      ") }
  if ($upstream.code -ne 0) { $problems += "当前分支 $branch 没有跟踪远端分支，新机器 clone 不到这个提交" }
  else {
    & git -C $OfficeRoot fetch --quiet 2>$null
    $ahead = [int](GitOut @('rev-list', '--count', "$($upstream.out)..HEAD")).out
    if ($ahead -gt 0) { $problems += "有 $ahead 个提交还没推送到 $($upstream.out)" }
  }
  if ($problems.Count) {
    foreach ($p in $problems) { Write-Host "  [x]  $p" -ForegroundColor Red }
    if (-not $Force) { Fail '请先提交并推送后再打包；确实要继续请加 -Force（新机器上代码会和数据对不齐）。' }
    Warn '按 -Force 继续'
  } else { Ok "工作区干净，$branch 已推送到 $($upstream.out)" }
  $remoteName = if ($upstream.code -eq 0) { $upstream.out.Split('/')[0] } else { 'origin' }
  $gitInfo = [ordered]@{
    commit    = $head
    branch    = $branch
    upstream  = if ($upstream.code -eq 0) { $upstream.out } else { $null }
    remoteUrl = (GitOut @('remote', 'get-url', $remoteName)).out
    remotes   = @((GitOut @('remote', '-v')).out -split "`n" | Where-Object { $_ -match '\(fetch\)' } | ForEach-Object { ($_ -split '\s+')[0..1] -join ' ' })
  }
  Ok "提交 $($head.Substring(0, 10))（$branch）"
}

# ---------- 2. 目标目录与空间 ----------
Step '准备目标目录'
$destFull = [IO.Path]::GetFullPath($Dest)
$destDrive = [IO.Path]::GetPathRoot($destFull)
if (-not (Test-Path $destDrive)) {
  $drives = (Get-PSDrive -PSProvider FileSystem | ForEach-Object { "$($_.Name):（剩余 $([math]::Round($_.Free / 1GB, 1))G）" }) -join '、'
  Fail "目标盘 $destDrive 不存在。本机可用的盘：$drives"
}
if ($destFull.StartsWith($WorkspaceRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail "目标目录不能放在工作区里面：$destFull" }
# 粗估包大小，与目标盘剩余空间比较，留 10% 余量
if ($DataOnly) {
  $estBytes = 0; foreach ($p in $DataPaths) { $estBytes += Size-Of (Join-Path $OfficeRoot $p) }
} else {
  $excludeRe = '\\(\.tmp|\.playwright-mcp|\.itagent|\.venv|__pycache__|worktrees)(\\|$)'
  if ($SkipNodeModules) { $excludeRe = $excludeRe.Replace('worktrees', 'worktrees|node_modules') }
  $estBytes = Size-Of $OfficeRoot $excludeRe
}
$estBytes += Size-Of $ClaudeHome
$freeBytes = (Get-PSDrive -Name $destDrive.Substring(0, 1)).Free
$estGB = [math]::Round($estBytes / 1GB, 1); $freeGB = [math]::Round($freeBytes / 1GB, 1)
if ($freeBytes -lt $estBytes * 1.1) { Fail "目标盘 $destDrive 空间不够：预计需要约 ${estGB}G，剩余 ${freeGB}G。换个盘，或先腾出空间" }
Ok "预计约 ${estGB}G，目标盘剩余 ${freeGB}G"
if (Test-Path $destFull) {
  if (@(Get-ChildItem $destFull -Force).Count) { Fail "目标目录非空：$destFull（请换一个空目录，避免新旧包混在一起）" }
} else { New-Item -ItemType Directory -Path $destFull | Out-Null }
$Dest = $destFull
Ok $Dest

# ---------- 3. 会话保留期提醒 ----------
Step '检查 Claude 会话保留期'
$settingsPath = Join-Path $ClaudeHome 'settings.json'
$cleanup = $null
if (Test-Path $settingsPath) {
  try { $cleanup = (Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json).cleanupPeriodDays } catch { }
}
if ($cleanup) { Ok "cleanupPeriodDays = $cleanup" }
else { Warn '未设置 cleanupPeriodDays（默认约 30 天自动清理旧会话）。建议在两台机器的 ~/.claude/settings.json 加 "cleanupPeriodDays": 3650' }

# ---------- 4. office-lab ----------
$siblings = @()
if ($DataOnly) {
  Step '打包运行数据'
  foreach ($p in $DataPaths) {
    $src = Join-Path $OfficeRoot $p
    $dst = Join-Path $Dest "data\$p"
    if (-not (Test-Path $src)) { Warn "$p 不存在，跳过"; continue }
    if ((Get-Item $src -Force).PSIsContainer) {
      $xd = @(); if ($skipWebview -and $p -eq 'app\runs') { $xd += (Join-Path $src 'webview2') }
      Copy-Tree $src $dst $xd @('*.tmp-??????')
    } else {
      New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null
      Copy-Item $src $dst -Force
    }
    Ok $p
  }
} else {
  Step "打包 $OfficeName（完整包）"
  $xdOffice = @(
    (Join-Path $OfficeRoot '.tmp'), (Join-Path $OfficeRoot 'app\.tmp'),
    (Join-Path $OfficeRoot '.playwright-mcp'), (Join-Path $OfficeRoot '.itagent'),
    (Join-Path $OfficeRoot '.claude\worktrees'),
    (Join-Path $OfficeRoot 'app\wecom_sidecar\.venv'),
    '__pycache__'
  )
  if ($SkipNodeModules) { $xdOffice += 'node_modules' }
  if ($skipWebview) { $xdOffice += (Join-Path $OfficeRoot 'app\runs\webview2') }
  Copy-Tree $OfficeRoot (Join-Path $Dest "workspace\$OfficeName") $xdOffice @('*.tmp-??????', 'run-dump.json')
  Ok '本仓已拷贝'

  if ($IncludeSiblings) {
    Step '打包兄弟仓'
    foreach ($d in Get-ChildItem $WorkspaceRoot -Directory -Force) {
      if ($d.Name -ieq $OfficeName -or $d.Name -in @('tmp', 'temp', 'run')) { continue }
      Copy-Tree $d.FullName (Join-Path $Dest "workspace\$($d.Name)") @('node_modules', 'target', 'dist', '.cache')
      $siblings += $d.Name
      Ok $d.Name
    }
    foreach ($f in Get-ChildItem $WorkspaceRoot -File -Force | Where-Object { $_.Extension -in '.md', '.sh', '.ps1', '.cmd', '.json' }) {
      Copy-Item $f.FullName (Join-Path $Dest 'workspace') -Force
    }
    Ok '工作区根目录的脚本与说明文件已拷贝'
  }
}
if (-not $IncludeSiblings) { Warn '未带兄弟仓（frontend、backend 等）。新机器上请 git clone 到同一工作区，否则引擎会落到独立模式' }

# ---------- 5. Claude 用户目录 ----------
Step '打包 ~/.claude 与 ~/.claude.json'
if (Test-Path $ClaudeHome) {
  Copy-Tree $ClaudeHome (Join-Path $Dest 'home\.claude') @('shell-snapshots', 'paste-cache', 'file-history', 'session-env')
  Ok '~/.claude 已拷贝'
} else { Warn '没找到 ~/.claude' }
if (Test-Path $ClaudeJson) { Copy-Item $ClaudeJson (Join-Path $Dest 'home\.claude.json'); Ok '~/.claude.json 已拷贝' }

# 恢复脚本放一份在包根，新机器上不用先找它在哪
Copy-Item (Join-Path $PSScriptRoot '迁移恢复.ps1') (Join-Path $Dest '迁移恢复.ps1') -Force

# ---------- 6. 统计与清单 ----------
Step '核对与写清单'
$runsDir = Join-Path $OfficeRoot 'app\runs'
$runCount = 0; $resumable = 0
$projDir = Join-Path $ClaudeHome ('projects\' + ($WorkspaceRoot -replace '[^A-Za-z0-9]', '-'))
try {
  $idx = Get-Content (Join-Path $runsDir 'index.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $runs = if ($idx -is [array]) { $idx } elseif ($idx.runs) { $idx.runs } else { @($idx.PSObject.Properties.Value) }
  $runCount = @($runs).Count
  foreach ($r in $runs) { if ($r.sessionId -and (Test-Path (Join-Path $projDir "$($r.sessionId).jsonl"))) { $resumable++ } }
} catch { Warn "读 index.json 失败：$($_.Exception.Message)" }

$sizeMB = [math]::Round((Size-Of $Dest) / 1MB)
$manifest = [ordered]@{
  packedAt        = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')
  mode            = if ($DataOnly) { 'data-only' } else { 'full' }
  sourceHost      = $env:COMPUTERNAME
  sourceUser      = $env:USERNAME
  workspaceRoot   = $WorkspaceRoot
  officeDirName   = $OfficeName
  git             = $gitInfo
  dataPaths       = if ($DataOnly) { $DataPaths } else { @() }
  includeSiblings = [bool]$IncludeSiblings
  siblings        = $siblings
  skipNodeModules = [bool]$SkipNodeModules
  runs            = $runCount
  resumableRuns   = $resumable
  sizeMB          = $sizeMB
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Dest 'manifest.json') -Encoding UTF8
Ok "run 共 $runCount 条，其中 $resumable 条还能续跑同一上下文（其余仅能查看历史）"
Ok "包大小约 $sizeMB MB"

Write-Host "`n打包完成：$Dest" -ForegroundColor Green
Write-Host '注意：包内 app\runs\*-config.json 含飞书/企微密钥与群机器人地址明文，请妥善传输与保管。' -ForegroundColor Yellow
if ($DataOnly) {
  Write-Host "到新机器上：先 git clone $($gitInfo.remoteUrl) 到 $WorkspaceRoot\$OfficeName（同一路径），再运行："
} else { Write-Host '到新机器上运行：' }
Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File <包目录>\迁移恢复.ps1"
