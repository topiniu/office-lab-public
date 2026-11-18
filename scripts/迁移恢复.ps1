<#
  office-lab 整机迁移 · 恢复（新机器执行）

  把「迁移打包.ps1」产出的包还原到本机。包根有本脚本的副本，直接运行它即可（-Source 默认取脚本所在目录）。

  ① 完整包：把 workspace\ 放回工作区根（默认原路径），代码和数据一起还原。
  ② 数据包（-DataOnly 打的）：先在本机 git clone office-lab 到原路径，本脚本只把运行数据填进去，
     并核对 clone 下来的提交与打包时一致。不一致默认停下，因为任务档案在 git 里、会话流水在包里，两边对不上会错位。

  两种包都会：合并 ~/.claude（不覆盖本机较新的文件）、还原 ~/.claude.json（本机已有则另存不覆盖）、
  跑 bootstrap --doctor 体检、重建企微 sidecar 虚拟环境。不会启动服务——体检通过后双击 tray\启动托盘.cmd。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File <包目录>\迁移恢复.ps1
    可选：-Source <包目录>                   包所在目录，默认取本脚本所在目录
          -WorkspaceRoot D:\Workspace\Projects   工作区根，默认取包里记录的原路径（建议保持一致，员工续跑同一上下文靠它）
          -Force                            目标已有运行数据时仍合并写入；数据包模式下提交号对不上也继续
          -SkipWecom                        不重建企微 sidecar 虚拟环境
#>
param(
  [string]$Source,
  [string]$WorkspaceRoot,
  [switch]$Force,
  [switch]$SkipWecom
)

$ErrorActionPreference = 'Stop'
if (-not $Source) { $Source = $PSScriptRoot }
$Source = (Resolve-Path $Source).Path
$ClaudeHome = Join-Path $env:USERPROFILE '.claude'
$ClaudeJson = Join-Path $env:USERPROFILE '.claude.json'

function Step($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  $t" -ForegroundColor Red; exit 1 }

# robocopy：退出码 >= 8 才是失败；extra 传 /XO 等附加开关
function Copy-Tree($src, $dst, [string[]]$extra = @()) {
  $rcArgs = @($src, $dst, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NP') + $extra
  & robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）：$src -> $dst" }
}
# Claude Code 按工作目录归档会话：非字母数字一律换成 '-'（D:\Workspace\Projects → D--Work-Projects）
function ProjectKey($p) { return ($p -replace '[^A-Za-z0-9]', '-') }

# ---------- 0. 读清单 ----------
Step '读取包清单'
$manifestPath = Join-Path $Source 'manifest.json'
if (-not (Test-Path $manifestPath)) { Fail "不是有效的迁移包（缺 manifest.json）：$Source" }
$m = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$dataOnly = ($m.mode -eq 'data-only')
Ok "$(if ($dataOnly) { '数据包' } else { '完整包' })，打包于 $($m.packedAt)，来源 $($m.sourceHost) / $($m.workspaceRoot)"
Ok "run $($m.runs) 条，其中 $($m.resumableRuns) 条可续跑同一上下文"
if (-not $WorkspaceRoot) { $WorkspaceRoot = $m.workspaceRoot }
$WorkspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\')
$OfficeName = $m.officeDirName
$OfficeRoot = Join-Path $WorkspaceRoot $OfficeName
$pathChanged = ($WorkspaceRoot -ne ([string]$m.workspaceRoot).TrimEnd('\'))
if ($pathChanged) { Warn "工作区根与原机器不同（原 $($m.workspaceRoot) → 现 $WorkspaceRoot）：会话目录会按新路径另存一份，但续跑同一上下文不保证可用" }
if ($Source.StartsWith($OfficeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { Fail '包目录不能放在目标 office-lab 里面，请把包放到别处再运行' }

# ---------- 1. 工作区 ----------
$hasRuntime = Test-Path (Join-Path $OfficeRoot 'app\runs\index.json')
if ($dataOnly) {
  Step "核对 git clone：$OfficeRoot"
  if (-not (Test-Path (Join-Path $OfficeRoot '.git'))) {
    Fail ("没找到 clone 下来的 office-lab。请先执行：`n    git clone $($m.git.remoteUrl) `"$OfficeRoot`"`n" +
      "    git -C `"$OfficeRoot`" checkout $($m.git.commit)`n  然后重新运行本脚本。")
  }
  $head = (& git -C $OfficeRoot rev-parse HEAD 2>$null)
  if ($head -ne $m.git.commit) {
    $msg = "clone 下来的提交（$head）与打包时（$($m.git.commit)，$($m.git.branch)）不一致；任务档案在 git 里、会话流水在包里，对不上会错位。" +
      "`n  对齐方法：git -C `"$OfficeRoot`" fetch && git -C `"$OfficeRoot`" checkout $($m.git.commit)"
    if (-not $Force) { Fail ($msg + "`n  确实要继续请加 -Force。") }
    Warn $msg
  } else { Ok "提交一致：$($head.Substring(0, 10))" }
  if ($hasRuntime -and -not $Force) { Fail "目标已有运行数据（app\runs\index.json 存在），为免覆盖已停下；确认要合并写入请加 -Force" }

  Step '填入运行数据'
  foreach ($p in @($m.dataPaths)) {
    $src = Join-Path $Source "data\$p"
    $dst = Join-Path $OfficeRoot $p
    if (-not (Test-Path $src)) { Warn "包里没有 $p，跳过"; continue }
    if ((Get-Item $src -Force).PSIsContainer) { Copy-Tree $src $dst }
    else { New-Item -ItemType Directory -Path (Split-Path $dst -Parent) -Force | Out-Null; Copy-Item $src $dst -Force }
    Ok $p
  }
} else {
  Step "还原工作区到 $WorkspaceRoot"
  if ($hasRuntime -and -not $Force) { Fail "目标已有运行数据（$OfficeRoot\app\runs\index.json 存在），为免覆盖已停下；确认要合并写入请加 -Force" }
  New-Item -ItemType Directory -Path $WorkspaceRoot -Force | Out-Null
  Copy-Tree (Join-Path $Source 'workspace') $WorkspaceRoot
  Ok "$OfficeName 已还原"
  if ($m.includeSiblings) { Ok ("兄弟仓已还原：" + (@($m.siblings) -join '、')) }
}
$markers = @('backend', 'frontend', 'manage-backend.sh') | Where-Object { Test-Path (Join-Path $WorkspaceRoot $_) }
if ($markers) { Ok ("工作区里的兄弟仓：" + ($markers -join '、')) }
else { Warn "工作区 $WorkspaceRoot 里没有 frontend / backend：请 git clone 到这里，否则引擎落到独立模式、员工改不了前后端代码" }

# ---------- 2. ~/.claude ----------
Step '合并 ~/.claude'
$srcClaude = Join-Path $Source 'home\.claude'
if (Test-Path $srcClaude) {
  # /XO：本机已有且更新的文件不覆盖（新机器若已用过 Claude，保留它自己的较新内容）
  Copy-Tree $srcClaude $ClaudeHome @('/XO')
  Ok "已合并到 $ClaudeHome"
  if ($pathChanged) {
    $from = Join-Path $ClaudeHome ('projects\' + (ProjectKey $m.workspaceRoot))
    $to = Join-Path $ClaudeHome ('projects\' + (ProjectKey $WorkspaceRoot))
    if (Test-Path $from) { Copy-Tree $from $to @('/XO'); Ok "会话目录另存为 $(Split-Path $to -Leaf)" }
  }
} else { Warn '包里没有 home\.claude' }

$srcJson = Join-Path $Source 'home\.claude.json'
if (Test-Path $srcJson) {
  if (Test-Path $ClaudeJson) {
    Copy-Item $srcJson "$ClaudeJson.from-migration" -Force
    Warn "本机已有 ~/.claude.json，未覆盖；原机器的版本放在 $ClaudeJson.from-migration，需要的话手工合并 mcpServers 等配置"
  } else { Copy-Item $srcJson $ClaudeJson; Ok '~/.claude.json 已还原' }
}

$settingsPath = Join-Path $ClaudeHome 'settings.json'
$cleanup = $null
if (Test-Path $settingsPath) { try { $cleanup = (Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json).cleanupPeriodDays } catch { } }
if (-not $cleanup) { Warn '~/.claude/settings.json 未设 cleanupPeriodDays，旧会话约 30 天后会被清掉；建议加 "cleanupPeriodDays": 3650' }

# ---------- 3. 工具链与体检 ----------
Step '检查工具链'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail '没有 node：请先安装 Node 20.19+ 或 22 LTS，再重新运行本脚本（加 -Force）' }
Ok "node $(& node -v)"
if (Get-Command claude -ErrorAction SilentlyContinue) { Ok 'claude 命令可用' }
else { Warn '没有 claude 命令：装好 Claude Code 后运行一次 claude 完成登录（登录态在凭据管理器里，打不进包）' }

Step '体检（bootstrap --doctor，不启动服务）'
Push-Location $OfficeRoot
# bootstrap 输出 UTF-8；输出被重定向（如存日志）时 PowerShell 按系统代码页解码会乱码，临时切成 UTF-8
$prevEnc = [Console]::OutputEncoding
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8; & node scripts/bootstrap.mjs --doctor } finally { [Console]::OutputEncoding = $prevEnc; Pop-Location }
if ($LASTEXITCODE -ne 0) { Warn "体检未通过（退出码 $LASTEXITCODE），按上面提示处理" }
Write-Host '  缺依赖时运行一次：node scripts/bootstrap.mjs --no-open（会安装依赖并构建新界面）' -ForegroundColor Gray

# ---------- 4. 企微 sidecar ----------
if (-not $SkipWecom) {
  Step '重建企微 sidecar 虚拟环境'
  $setup = Join-Path $OfficeRoot 'app\wecom_sidecar\setup.cmd'
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) { Warn '没有 python，跳过；不用企微渠道可忽略，要用时装好 Python 后运行 app\wecom_sidecar\setup.cmd' }
  elseif (Test-Path $setup) {
    & cmd /c "`"$setup`""
    if ($LASTEXITCODE -eq 0) { Ok '企微 sidecar 就绪' } else { Warn '企微 sidecar 安装失败，可稍后手工运行 app\wecom_sidecar\setup.cmd' }
  }
}

Write-Host "`n恢复完成。" -ForegroundColor Green
Write-Host '接下来：'
Write-Host '  1. 如未登录，运行 claude 完成登录'
Write-Host '  2. 以前设过的环境变量（LARK_APP_ID / LARK_APP_SECRET / WECOM_PYTHON / OFFICE_LAB_*）在本机重新设置'
Write-Host "  3. 双击 $OfficeRoot\tray\启动托盘.cmd 启动；需要开机自启在托盘菜单里重新勾选"
