# 望子成龙小学 · 系统托盘（Windows / PowerShell + WinForms，零安装）
# ─────────────────────────────────────────────────────────────────────────────
# 目的：把「只能在命令行里 node server.js、关了终端就断」升级成常驻托盘应用。
#   · 托盘托管 app/server.js（隐藏窗口起进程、崩溃自动重启、退出托盘一并停服）
#   · 右键菜单：打开控制台 / 服务状态 / 启动·停止·重启 / 看日志 / 开机自启 / 退出
#   · 定时轮询 /api/health，把「运行中·端口·在跑数·内存·上线时长」显示在托盘提示上
# 启动方式：双击同目录 启动托盘.cmd（或 office-lab.vbs）；也可 powershell -File 本脚本 手动调试。
#   无论哪条路径，脚本开头都会把自己重启成 CREATE_NO_WINDOW 实例，确保常驻期没有可被误关的终端窗口。
# 依赖：仅 Win11 自带的 Windows PowerShell 5.1 + .NET WinForms/Drawing，无需 npm/额外安装。

param(
  # 引擎 API + 旧 UI 端口：默认 4800（新 shadcn UI 在 4700 由 Vite/同源部署提供）；OFFICE_LAB_PORT 可覆盖
  [int]$Port = $(if ($env:OFFICE_LAB_PORT) { [int]$env:OFFICE_LAB_PORT } else { 4800 })
)

# ---------- 诊断日志：隐藏窗口下任何启动失败都写进 app/runs/tray.log，杜绝「点了没反应」查无实据 ----------
$script:TrayLog = Join-Path $PSScriptRoot '..\app\runs\tray.log'
function Write-TrayLog([string]$m) {
  try { ('[{0}] {1}' -f (Get-Date -Format 'MM-dd HH:mm:ss'), $m) | Out-File -FilePath $script:TrayLog -Append -Encoding UTF8 } catch {}
}
trap { Write-TrayLog ('FATAL: ' + ($_ | Out-String) + ' @ ' + $_.InvocationInfo.PositionMessage) }
Write-TrayLog "==== 托盘启动 (PID $PID, Port $Port) ===="

# ---------- 消灭自身控制台黑窗：自我重启为 CREATE_NO_WINDOW 实例（覆盖所有启动方式） ----------
# 根因：托盘进程的宿主就是这个 PowerShell 控制台。只要它可见地挂在任务栏，用户一旦关掉那个窗口，
#   托盘被硬杀（Quit-Tray/Stop-Server 都不会跑）——即用户反馈的「关掉这个终端窗口整个 lab 都没了」。
#   实测：被杀的只有托盘本身，CreateNoWindow 起的 node/vite 会变孤儿继续跑；但托盘图标、悬浮窗、
#   health 轮询、Toast 审批回执、崩溃自动重启这些控制面全丢，用户观感就是「整个 lab 关了」。
#
# 为什么原来的两道防线在 Win11 上双双失效（2026-09-09 实测，复盘 §3.129）：
#   Win11 的「默认终端应用」若是 Windows Terminal（HKCU\Console\%%Startup 的 DelegationTerminal 不是
#   conhost 的 GUID），任何新建控制台的进程都会被**交接**给 WindowsTerminal.exe，窗口由**另一个进程**创建：
#   · launcher 的 -WindowStyle Hidden —— 管的是「本该由本进程创建的那个控制台窗口」，交接后的 WT 窗口不吃；
#   · 脚本内 ShowWindow(GetConsoleWindow(), SW_HIDE) —— 交接后 GetConsoleWindow() 返回的是系统留作兼容的
#     **替身窗口**（属主还是自己，所以 SW_HIDE 确实"成功"），屏幕上可见的那个 HWND 属于 WindowsTerminal.exe。
#     旧代码因此往 tray.log 写「已隐藏自身控制台窗口」的**假成功**，而窗口纹丝不动。
# ⚠ §3.105（2026-08-26）曾用三个判据「实测否掉」这套交接解释，本次翻案——那三个判据全在交接边界的**里侧**，
#   结构上看不见交接：MainWindowHandle 对控制台程序恒为 0；conhost 子进程在交接下照样存在（先起后交，且
#   CREATE_NO_WINDOW 下参数是 `0x4`）；GetConsoleWindow() 非 0 正是那个替身。唯一测得出的判据是**跨进程枚举
#   可见窗口、按控制台标题匹配**——这次拿它抓到了属主为 WindowsTerminal.exe 的那个 HWND，关掉它托盘即被硬杀。
#   §3.105 的真凶（4700 挂在手工终端链上）另有其事、依旧成立；这是**同一句抱怨下的第二个窗口**。
#
# 正解 = 别造窗口，而不是造完再藏：CREATE_NO_WINDOW（.NET CreateNoWindow=$true）压根不创建窗口，
#   因此**不触发默认终端交接**，屏幕上无窗可关。这正是本文件起 node 时用的那招（见 Start-Server），
#   只是一直没用在托盘自己身上。这里让脚本把自己重新拉起一次并立即退出，`.cmd`/`.vbs`/开机自启的 `.lnk`/
#   右键「用 PowerShell 运行」**所有启动路径一次覆盖**。引导那一下仍会闪一个窗口（引导进程退出即消失）。
# 注意：本块必须留在下面单实例 mutex **之前**——否则引导进程先占住 mutex，重启出来的子进程会被判成
#   「已有实例在运行」而静默退出，托盘永远起不来。
# 调试启动器设 OFFICE_LAB_TRAY_DEBUG=1 时整块跳过（要在可见窗口里看报错）。

# ---------- 先做一次「已经有托盘在跑吗」的廉价判活（引导阶段就短路，不白起一层） ----------
# 为什么需要：引擎侧的伙伴看护（app/tray-watchdog.js）会周期性敲门；没有这道快速判活的话，
#   每次敲门都要「引导进程 → 自我重启出真身 → 真身走到 mutex 才发现重复 → 退出」白起两个 PowerShell。
# 判据用 `Mutex::OpenExisting`：命名 mutex 对象只在有进程持有句柄时存在，托盘退出（含被杀）句柄即释放、
#   对象随之销毁——所以「能打开 = 确实有活实例」，且**不需要**枚举进程或比对命令行（后者在 §3.130 里
#   已经吃过一次自匹配的亏：查询进程自己的命令行里也含脚本名，会把查询者数成托盘）。
# 这只是快速路径，**不改变**权威判定——下面那次带 createdNew 的真正 mutex 抢占仍是唯一事实源。
# 实测（2026-09-09，托盘活着时跑）：OpenExisting 成功；不存在的名字抛 WaitHandleCannotBeOpenedException；
#   `New-Object Mutex($true,name,[ref]$isNew)` 第二次抢同名得到 createdNew=False——三条都通。
if (-not $env:OFFICE_LAB_TRAY_DEBUG) {
  try {
    $probe = [System.Threading.Mutex]::OpenExisting('OfficeLabTray_wangzichenglong')
    $probe.Dispose()
    Write-TrayLog '已有托盘实例在运行（引导阶段判活命中），本次静默退出'
    return
  } catch [System.Threading.WaitHandleCannotBeOpenedException] {
    # 没有活实例 → 正常往下走（这是看护敲门时的"该拉起了"分支）
  } catch {
    Write-TrayLog ('引导阶段判活异常（忽略，交给下面的 mutex 权威判定）：' + $_.Exception.Message)
  }
}

if (-not $env:OFFICE_LAB_TRAY_DEBUG -and -not $env:OFFICE_LAB_TRAY_NOWINDOW) {
  try {
    # 用当前宿主 exe 重启，pwsh/powershell 都照原样延续（-Sta 只有 powershell.exe 认）
    $hostExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass')
    if ([System.IO.Path]::GetFileName($hostExe) -ieq 'powershell.exe') { $argv += '-Sta' }
    $argv += @('-File', $PSCommandPath, '-Port', "$Port")   # -Port 显式传，别让子进程再去猜环境变量
    $env:OFFICE_LAB_TRAY_NOWINDOW = '1'                     # 递归护栏：子进程见到即跳过本块
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $hostExe
    $psi.Arguments = (($argv | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_ + '"' } else { "$_" } }) -join ' ')
    $psi.WorkingDirectory = $PSScriptRoot
    $psi.UseShellExecute = $false    # 继承本进程环境（含上面的护栏变量）
    $psi.CreateNoWindow = $true      # ★ 关键：不创建窗口 → 不触发默认终端交接 → 无窗可误关
    $child = [System.Diagnostics.Process]::Start($psi)
    Write-TrayLog ("已自我重启为无窗口实例（子进程 PID {0}，CreateNoWindow），本引导进程退出" -f $child.Id)
    return
  } catch {
    # 重启失败不能让托盘起不来：降级继续在当前（可能可见的）窗口里跑，并落一行响亮的日志。
    $env:OFFICE_LAB_TRAY_NOWINDOW = $null
    Write-TrayLog ('自我重启为无窗口实例失败，降级为「就地运行 + 尝试隐窗」：' + $_.Exception.Message)
  }
}

# ---------- 降级兜底：就地把控制台窗口藏掉（belt-and-suspenders） ----------
# 走到这里的三种情形：① 上面已是无窗口子进程（本块基本是空操作）；② 自我重启失败的降级；
#   ③ OFFICE_LAB_TRAY_DEBUG（调试要可见，整块跳过）。
# 这里**不再谎报成功**：SW_HIDE 之后用 IsWindowVisible 复核，并把默认终端交接状态一并记下——
#   否则就是上面说的那条假成功日志，害人查不出「日志说藏了、窗口还在」。
if (-not $env:OFFICE_LAB_TRAY_DEBUG) {
  try {
    Add-Type -Name Win32ConsoleWin -Namespace OfficeLab -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
'@ -ErrorAction Stop
    $hwnd = [OfficeLab.Win32ConsoleWin]::GetConsoleWindow()
    if ($hwnd -ne [System.IntPtr]::Zero) {
      [void][OfficeLab.Win32ConsoleWin]::ShowWindow($hwnd, 0)   # 0 = SW_HIDE
      $stillVisible = [OfficeLab.Win32ConsoleWin]::IsWindowVisible($hwnd)
      # 默认终端不是 conhost({B23D10C0-...}) → 控制台被交接给第三方终端，SW_HIDE 对屏幕上那个窗口无效
      $handoff = $false
      try {
        $dt = (Get-ItemProperty -Path 'HKCU:\Console\%%Startup' -Name DelegationTerminal -ErrorAction Stop).DelegationTerminal
        $handoff = ($dt -and $dt -ne '{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}')
      } catch {}
      if ($stillVisible) {
        Write-TrayLog 'SW_HIDE 后控制台窗口仍可见——本进程仍有可被误关的窗口（关掉它=杀掉托盘）'
      } elseif ($handoff) {
        Write-TrayLog ('已 SW_HIDE 自身控制台窗口，但默认终端已交接给第三方终端（DelegationTerminal=' + $dt + '）：屏幕上那个窗口属于终端进程、可能仍在——以托盘图标是否为唯一入口为准')
      } else {
        Write-TrayLog '已隐藏自身控制台窗口（防误关连带停服）'
      }
    } else {
      Write-TrayLog '本进程无控制台窗口（无窗可误关）'
    }
  } catch { Write-TrayLog ('隐藏控制台窗口失败（忽略，不影响托盘）：' + $_.Exception.Message) }
}

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------- 托盘凭什么活着：UI 线程异常不再静默弄死进程 + 退出必留痕 ----------
# 病史（2026-09-09 查 tray.log 全量）：**59 次「托盘启动」里只有 3 次留下退出记录、0 条 FATAL**——
#   也就是说托盘 56 次是**无声消失**的。原因不是"没查出来"，是**结构上查不出来**：
#   `Application.Run($appContext)` 之后没有任何日志，于是「消息循环正常返回」与「进程被外部杀死」
#   在日志上完全同形；WinForms 默认的 UnhandledExceptionMode 又会让**任何一个回调里漏出的异常直接
#   终结进程**，而托盘的 stdout 无处可去（无窗口），异常连一行都留不下。
# 这里三件事，先把"查不出来"本身修掉：
#   ① CatchException + ThreadException：消息循环回调（Tick / 菜单点击 / Toast 回执）里漏出的异常
#      记一行然后**继续跑**，不再让一次网络抖动或一次 WinRT/COM 失手杀掉整个托盘；
#   ② AppDomain.UnhandledException：非 UI 线程的漏网异常至少留下最后一句话（拦不住退出，但能归因）；
#   ③ SessionEnding/SessionEnded：注销/关机导致的退出与"莫名死亡"区分开。
# 配合文件末尾「消息循环已返回」那行日志：下次托盘再消失，日志一定能说出是哪一类。
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
[System.Windows.Forms.Application]::add_ThreadException({
  param($s, $e)
  try { Write-TrayLog ('UI线程异常已捕获（托盘继续运行）：' + $e.Exception.GetType().FullName + ': ' + $e.Exception.Message + ' @ ' + ($e.Exception.StackTrace -split "`n" | Select-Object -First 3 | ForEach-Object { $_.Trim() }) -join ' <- ') } catch {}
})
[System.AppDomain]::CurrentDomain.add_UnhandledException({
  param($s, $e)
  try { Write-TrayLog ('★ AppDomain 未捕获异常（进程即将终止）：' + $e.ExceptionObject) } catch {}
})
[Microsoft.Win32.SystemEvents]::add_SessionEnding({
  param($s, $e)
  try { Write-TrayLog ('系统会话结束中（Reason=' + $e.Reason + '）：本次退出属注销/关机，非异常死亡') } catch {}
})

# ---------- 纯决策层（可单测，见 tray/test/tray-logic.tests.ps1） ----------
# 崩溃重启限流 / 探活三振裁决 / 通知游标这三处**都出过真事故**（§3.85 撞端口自杀、§3.130 Toast 毒丸），
# 而托盘此前零测试覆盖。逻辑搬到 lib 里由 22 条断言钉住，本文件只负责把决策落地（起进程、写日志、弹气泡）。
# ⚠ 不许在本文件里再写一份同样的判断——两份实现必然分叉（§3.128）。
$LibPath = Join-Path (Join-Path $PSScriptRoot 'lib') 'tray-logic.ps1'
if (-not (Test-Path $LibPath)) {
  Write-TrayLog "★ 致命：找不到纯决策层 $LibPath —— 仓库不完整（tray/lib/ 没跟着部署）。托盘无法继续。"
  throw "缺少 tray/lib/tray-logic.ps1"
}
. $LibPath

# kernel32：供悬浮窗用 WebView2 时，让原生 WebView2Loader.dll 可被托管 Core.dll 的 P/Invoke 命中。
# 根因：P/Invoke 按「进程 exe 目录 + PATH」搜索原生 DLL，不看托管程序集所在目录；vendored loader 放在
#   tray/vendor 里默认找不到（DllNotFoundException 0x8007007E）。故须 SetDllDirectory 纳入该目录，并按全
#   路径 LoadLibrary 预加载——之后按名解析即命中已加载模块。仅定义，实际加载在首次开悬浮窗时惰性执行。
Add-Type -Namespace OfficeLab -Name NativeLoader -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr LoadLibrary(string lpFileName);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern bool SetDllDirectory(string lpPathName);
'@

# WinRT 原生 Toast 类型（Win10/11 自带）：借用 PowerShell 自己的 AppUserModelID，无需注册开始菜单快捷方式即可弹通知。
# 通知里的「同意/拒绝/回复」= foreground 动作，由本进程存活期间的 Activated 事件回执；「打开」= protocol 动作，交系统开浏览器。
$script:ToastOk = $true
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
} catch { $script:ToastOk = $false }
$script:AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$script:ToastGroup = 'officelab'

# ---------- 单实例：已在运行则静默退出，避免托盘图标重复 ----------
# 注意：这里用静默 return，不弹 MessageBox——隐藏窗口模式下模态框无宿主会永久阻塞成隐形僵尸进程。
$isNew = $false
$script:mutex = New-Object System.Threading.Mutex($true, 'OfficeLabTray_wangzichenglong', [ref]$isNew)
if (-not $isNew) { Write-TrayLog '已有托盘实例在运行，本次静默退出'; return }

# ---------- 路径与运行时状态 ----------
$TrayDir  = $PSScriptRoot
$AppDir   = Join-Path (Split-Path $TrayDir -Parent) 'app'
$ServerJs = Join-Path $AppDir 'server.js'
$LogoPng  = Join-Path $AppDir 'public\logo.png'
$LogDir   = Join-Path $AppDir 'runs'
$OutLog   = Join-Path $LogDir 'server.out.log'
$ErrLog   = Join-Path $LogDir 'server.err.log'
$VbsPath  = Join-Path $TrayDir 'office-lab.vbs'
$BaseUrl  = "http://127.0.0.1:$Port"          # 引擎 API / 健康检查基址（旧 UI 与之同源）
# 新 shadcn UI：托盘一并托管，端口 4700 = `vite preview`（服务 web/dist 构建产物，见 web/vite.config.ts）。
# 为什么不是 dev server：隧道（localhost → 4700）下 dev 要拉几百个未打包模块，远程慢到没法用（复盘 §3.81）。
# 产物新鲜度由 Start-WebBuild 挂的 `pnpm build:watch` 增量维护；本地要 HMR 手动 `pnpm dev`（→ 4701）。
$WebDir   = Join-Path (Split-Path $TrayDir -Parent) 'web'
$WebPort  = 4700
$WebOut   = Join-Path $LogDir 'web.out.log'
$WebErr   = Join-Path $LogDir 'web.err.log'
$WebBuildOut = Join-Path $LogDir 'web.build.log'
$WebBuildErr = Join-Path $LogDir 'web.build.err.log'
$UiUrl    = "http://localhost:$WebPort"        # 「打开控制台/双击/悬浮窗」打开的界面 = 新 UI(4700)。用 localhost 而非 127.0.0.1：某些机器的系统/浏览器代理会绕过 localhost 但把 127.0.0.1 走代理导致打不开（服务端两者都在监听，纯客户端解析差异）。
$VendorWv2   = Join-Path $TrayDir 'vendor\webview2'   # 悬浮窗用的 WebView2 托管 DLL + 原生 loader（随仓库）
$Wv2UserData = Join-Path $LogDir 'webview2'           # WebView2 用户数据目录（缓存/Cookie 等，落 app/runs 下）

if (-not (Test-Path $ServerJs)) {
  [System.Windows.Forms.MessageBox]::Show("找不到 server.js：`n$ServerJs", '望子成龙小学', 'OK', 'Error') | Out-Null
  return
}
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# node.exe 定位（找不到 / 版本不够就报错退出——没有合格的 node 一切免谈）
#
# ⚠ 为什么不能只信 PATH 上那个 node：PATH 上通常是 nvm 的符号链接（NVM_SYMLINK，本机
# C:\nvm4w\nodejs），指向哪个版本由「最后一次 nvm use」决定——而那次 `nvm use` 往往是为
# 别的项目切的（如 frontend/web-app 的老 umi dev 要 node 16）。engine 依赖的
# claude-agent-sdk 用了 Node 17+ 才有的 `DOMException` 全局，在 node 16 上一启动就
# `ReferenceError: DOMException is not defined` 秒退（exit code 1）。
# 旧实现只检查 node 存不存在、不看版本，于是 2026-09-04 13:39 有人 `nvm use 16` 之后，
# 16:13 服务一崩，托盘连拉 5 次全部秒崩、耗尽重启上限彻底停服（tray.log 有完整现场）。
# 现在：PATH node 版本够就用它（保持原行为）；不够则回退到 nvm 版本目录里 >=18 的最高版本
# 绝对路径，把 lab 和全局 nvm 解耦；一个都没有就弹窗说明并退出——绝不带着注定失败的
# node 去空转 5 次重启，那只会把「版本不对」伪装成「服务不稳定」。
$NodeMinMajor = 18   # 与 app/package.json 的 engines.node 保持一致

function Get-NodeMajor([string]$exe) {
  # 返回 node 主版本号（int）；取不到返回 0。走 `-v` 而不是猜路径：PATH 上是符号链接，路径名不含真实版本。
  if (-not $exe -or -not (Test-Path $exe)) { return 0 }
  try {
    $v = (& $exe -v 2>$null | Select-Object -First 1)
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

$NodeExe   = $null
$pathNode  = (Get-Command node -ErrorAction SilentlyContinue).Source
$pathMajor = Get-NodeMajor $pathNode

if ($pathMajor -ge $NodeMinMajor) {
  $NodeExe = $pathNode
} else {
  # PATH 上的不合格（不存在 / 太老）——去 nvm 版本根里翻。root 优先取 NVM_HOME，回退到 nvm4w 惯例路径。
  $nvmRoot = $env:NVM_HOME
  if (-not $nvmRoot -or -not (Test-Path $nvmRoot)) { $nvmRoot = Join-Path $env:LOCALAPPDATA 'nvm' }
  $cand = $null
  if (Test-Path $nvmRoot) {
    $cand = Get-ChildItem -Path $nvmRoot -Directory -Filter 'v*' -ErrorAction SilentlyContinue |
      ForEach-Object {
        $exe = Join-Path $_.FullName 'node.exe'
        $mj  = Get-NodeMajor $exe
        if ($mj -ge $NodeMinMajor) { [pscustomobject]@{ Exe = $exe; Major = $mj; Name = $_.Name } }
      } | Sort-Object Major -Descending | Select-Object -First 1
  }
  if ($cand) {
    $NodeExe = $cand.Exe
    $whichBad = if ($pathNode) { "PATH 上的 node 是 v$pathMajor（低于 $NodeMinMajor，engine 起不来）" } else { 'PATH 上没有 node' }
    Write-TrayLog "$whichBad —— 改用 nvm 里的 $($cand.Name)：$NodeExe（本次仅 lab 用，不改全局 nvm）"
  } else {
    $detail = if ($pathNode) { "当前 PATH: $pathNode (v$pathMajor)" } else { '当前 PATH 上找不到 node' }
    Write-TrayLog "未找到 >=$NodeMinMajor 的 node（$detail，nvm 根 $nvmRoot 里也没有），退出"
    [System.Windows.Forms.MessageBox]::Show(
      "未找到 Node.js $NodeMinMajor+，望子成龙小学无法启动。`n`n$detail`n`n" +
      "engine 依赖的 claude-agent-sdk 需要 Node $NodeMinMajor+（低版本会以 DOMException 报错秒退）。`n" +
      "请装一个 Node $NodeMinMajor+（如 nvm install 24），或 nvm use 到该版本后重开托盘。",
      '望子成龙小学', 'OK', 'Error') | Out-Null
    return
  }
}
# 把选中的 node 目录顶到 PATH 最前（仅本托盘进程及其子进程，不动机器/用户级环境变量）。
# 光用绝对路径起 server.js 不够：新 UI 那条链是 `corepack.cmd → pnpm → vite`，pnpm/vite 的
# bin 包装脚本各自去 PATH 上找 `node`，于是引擎跑在 24、界面还在 16——表现为 4700 起不来、
# web.err.log 报 `node:util does not provide an export named 'styleText'`（styleText 是
# Node 20.12+ 才有）。PATH 一并对齐，整棵进程树才是同一个 node（2026-09-04 排查）。
$nodeDir = Split-Path $NodeExe -Parent
if ($env:PATH -notlike "$nodeDir;*") { $env:PATH = "$nodeDir;$env:PATH" }

Write-TrayLog "node=$NodeExe (v$(Get-NodeMajor $NodeExe)); server=$ServerJs; ToastOk=$($script:ToastOk)"

# corepack（随 node 附带）：用于起新 UI 的 `corepack pnpm dev`；同目录找不到就退回 PATH 上的 corepack
$CorepackCmd = Join-Path (Split-Path $NodeExe -Parent) 'corepack.cmd'

$script:proc         = $null      # 当前 node 子进程（System.Diagnostics.Process）
$script:webproc      = $null      # 新 UI vite preview 子进程（cmd 外壳；taskkill /T 连带清）
$script:webbuildproc = $null      # 新 UI `vite build --watch` 子进程（保持 web/dist 常新；同起同停）
# 4700 被**外部进程**（终端里手工跑的 pnpm dev/preview 之类）占着时记下它的 PID。
# 与引擎的 $script:monitorPid 同构：托盘不重复拉起，但保留把手——「重启服务」据此接管收编。
# 这个字段的存在本身就是要回答「界面到底挂在谁身上」——旧实现只写一句日志就 return，
# 把自己降级成旁观者，于是用户关掉那个终端窗口时界面无声消失（2026-08-26 排查记录）。
$script:webMonitorPid = $null
$script:userStopped  = $false     # 用户主动停服？（true 则不触发自动重启）
$script:autoRestart  = $true      # 崩溃自动重启开关
$script:state        = 'stopped'  # stopped | starting | running | unhealthy
$script:health       = $null      # 最近一次 /api/health 结果
$script:restarts     = 0          # 崩溃自动重启累计次数
$script:probeFails   = 0          # 连续 /api/health 探活失败次数（满 3 次才允许判死，单次超时只是引擎在忙）
$script:lastCrashAt  = $null
$script:monitorPid   = $null      # 监控模式下「端口上正在跑的 office-lab 服务」的 PID（非本托盘拉起，如上一实例遗留/终端启动）——记住它才能经托盘停止/重启接管

# 本地通知（Windows Toast）相关状态
$script:notifyEnabled = $true                                   # Windows 通知总开关
$script:notifyInit    = $false                                  # 是否已建立 since 基线（首轮只取基线、不回放历史收工）
$script:notifySince   = 0                                       # /api/notifications 增量游标
$script:shownReqIds   = New-Object 'System.Collections.Generic.HashSet[string]'  # 已弹出的审批 reqId（去重 + 消失时撤下）
$script:toastRefs     = @{}                                     # tag -> @{toast;handler} 防 GC（活到被点击/撤下）
$script:actQueue      = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'  # Toast 回执队列（回调线程 → 主线程）
$CfgFile = Join-Path $LogDir 'tray-config.json'

# 悬浮窗（WebView2 置顶小窗）相关状态
$script:wv2Loaded    = $false   # WebView2 程序集是否已惰性加载
$script:floatForm    = $null    # 悬浮窗 Form
$script:floatWv      = $null    # 内嵌 WebView2 控件
$script:floatVisible = $false   # 当前是否显示
$script:floatQuitting = $false  # 退出托盘中（放行 FormClosing 真正关闭，不再拦成隐藏）
# 以下随 tray-config.json 持久化
$script:floatTopMost = $true    # 置顶开关
$script:floatOpacity = 100      # 不透明度百分比（100=不透明，85=半透明）
$script:floatX = $null; $script:floatY = $null; $script:floatW = $null; $script:floatH = $null  # 上次窗口位置/大小

# 托盘本地配置（notifyEnabled / autoRestart）持久化
function Load-Cfg {
  try {
    if (Test-Path $CfgFile) {
      $c = Get-Content $CfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($null -ne $c.notifyEnabled) { $script:notifyEnabled = [bool]$c.notifyEnabled }
      if ($null -ne $c.autoRestart)   { $script:autoRestart   = [bool]$c.autoRestart }
      if ($null -ne $c.floatTopMost)  { $script:floatTopMost  = [bool]$c.floatTopMost }
      if ($null -ne $c.floatOpacity)  { $script:floatOpacity  = [int]$c.floatOpacity }
      if ($null -ne $c.floatX) { $script:floatX = [int]$c.floatX; $script:floatY = [int]$c.floatY; $script:floatW = [int]$c.floatW; $script:floatH = [int]$c.floatH }
    }
  } catch {}
}
function Save-Cfg {
  try {
    @{
      notifyEnabled = $script:notifyEnabled; autoRestart = $script:autoRestart
      floatTopMost = $script:floatTopMost; floatOpacity = $script:floatOpacity
      floatX = $script:floatX; floatY = $script:floatY; floatW = $script:floatW; floatH = $script:floatH
    } | ConvertTo-Json | Set-Content $CfgFile -Encoding UTF8
  } catch {}
}
Load-Cfg

# ---------- 托盘图标 ----------
# 首选：officelab 统一 logo（猪鼻子）裁成圆角方 + 右下角状态点（绿运行/琥珀启动/灰停/红异常），既保品牌又见状态。
# 回退：logo 读不到时用纯色状态圆点（GDI 现画，不依赖任何文件）。
function New-DotIcon([System.Drawing.Color]$fill) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $fill
  $g.FillEllipse($brush, 3, 3, 25, 25)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(90, 255, 255, 255)), 2
  $g.DrawEllipse($pen, 3, 3, 25, 25)
  $g.Dispose(); $brush.Dispose(); $pen.Dispose()
  $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $bmp.Dispose()
  return $ico
}
function New-LogoIcon([System.Drawing.Image]$logo, [System.Drawing.Color]$dot) {
  $sz = 32
  $bmp = New-Object System.Drawing.Bitmap $sz, $sz
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  # 圆角方裁剪 + 铺 logo
  $r = 6; $d = 2 * $r
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddArc(0, 0, $d, $d, 180, 90)
  $gp.AddArc($sz - $d, 0, $d, $d, 270, 90)
  $gp.AddArc($sz - $d, $sz - $d, $d, $d, 0, 90)
  $gp.AddArc(0, $sz - $d, $d, $d, 90, 90)
  $gp.CloseFigure()
  $g.SetClip($gp)
  $g.DrawImage($logo, 0, 0, $sz, $sz)
  $g.ResetClip()
  # 右下角状态点（白圈描边保证在任意背景上可辨）
  $dd = 13; $dx = $sz - $dd; $dy = $sz - $dd
  $ring = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $fill = New-Object System.Drawing.SolidBrush $dot
  $g.FillEllipse($ring, $dx - 1, $dy - 1, $dd + 2, $dd + 2)
  $g.FillEllipse($fill, $dx, $dy, $dd, $dd)
  $g.Dispose(); $ring.Dispose(); $fill.Dispose(); $gp.Dispose()
  $ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $bmp.Dispose()
  return $ico
}
$C_RUN = [System.Drawing.Color]::FromArgb(39, 166, 68)     # #27a644 语义绿
$C_STA = [System.Drawing.Color]::FromArgb(217, 158, 41)    # 琥珀
$C_STOP = [System.Drawing.Color]::FromArgb(150, 150, 150)  # 灰
$C_ERR = [System.Drawing.Color]::FromArgb(214, 69, 69)     # 红
# 读 logo（读进内存再解码，不锁定文件；失败则回退纯色圆点）
$LogoImg = $null; $LogoMs = $null
try {
  if (Test-Path $LogoPng) {
    $LogoMs = New-Object System.IO.MemoryStream (, [System.IO.File]::ReadAllBytes($LogoPng))
    $LogoImg = [System.Drawing.Image]::FromStream($LogoMs)
  }
} catch { $LogoImg = $null }
if ($LogoImg) {
  $IcoRunning = New-LogoIcon $LogoImg $C_RUN
  $IcoStarting = New-LogoIcon $LogoImg $C_STA
  $IcoStopped = New-LogoIcon $LogoImg $C_STOP
  $IcoError = New-LogoIcon $LogoImg $C_ERR
  try { $LogoImg.Dispose(); $LogoMs.Dispose() } catch {}
  Write-TrayLog 'logo 图标已生成（猪鼻子 + 状态点）'
} else {
  $IcoRunning = New-DotIcon $C_RUN
  $IcoStarting = New-DotIcon $C_STA
  $IcoStopped = New-DotIcon $C_STOP
  $IcoError = New-DotIcon $C_ERR
  Write-TrayLog "logo 读取失败（$LogoPng），回退纯色状态圆点"
}

# ---------- 本地通知：原生 Toast + 回执（审批同意/拒绝、打开、快速回复） ----------
function Escape-Xml([string]$s) {
  if ($null -eq $s) { return '' }
  return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}
function Post-Json([string]$url, $bodyHash) {
  try {
    Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' `
      -Body ([System.Text.Encoding]::UTF8.GetBytes(($bodyHash | ConvertTo-Json -Compress))) -TimeoutSec 5 | Out-Null
    return $true
  } catch { return $false }
}
# 撤下某 tag 的 Toast（审批被别处处理/超时后不再可点）
function Remove-Toast([string]$tag) {
  try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($tag, $script:ToastGroup, $script:AUMID) } catch {}
  $script:toastRefs.Remove($tag) | Out-Null
}
# 展示一条 Toast（带 tag/分组去重 + 前台动作的 Activated 回执）；WinRT 不可用时回退托盘气泡
function Show-Toast([string]$xml, [string]$tag) {
  if (-not $script:ToastOk) { $notify.ShowBalloonTip(6000, '望子成龙小学', ($xml -replace '<[^>]+>', ' ').Trim(), 'Info'); return }
  try {
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xml)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
    $toast.Tag = $tag; $toast.Group = $script:ToastGroup
    $handler = [Windows.Foundation.TypedEventHandler[Windows.UI.Notifications.ToastNotification, System.Object]] {
      param($sender, $eventArgs)
      try { Handle-ToastActivated $eventArgs } catch {}
    }
    $toast.add_Activated($handler)
    $script:toastRefs[$tag] = @{ toast = $toast; handler = $handler }   # 防 GC
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($script:AUMID).Show($toast)
  } catch {
    $notify.ShowBalloonTip(6000, '望子成龙小学', ($xml -replace '<[^>]+>', ' ').Trim(), 'Info')
  }
}
# Toast 前台动作回执（运行在 WinRT 回调线程）：只做最小事——读参数+文本框、塞进线程安全队列，
# 真正的网络回执留给主线程 Drain-Activations 处理（PowerShell runspace 非线程安全，回调线程里跑网络会崩）。
function Handle-ToastActivated($eventArgs) {
  try {
    $e = [Windows.UI.Notifications.ToastActivatedEventArgs]$eventArgs
    $argStr = [string]$e.Arguments
    if (-not $argStr) { return }
    $reply = ''
    try { $reply = [string]$e.UserInput['replyBox'] } catch {}
    if ($reply) { $argStr += '&reply=' + [uri]::EscapeDataString($reply) }
    $script:actQueue.Enqueue($argStr)
  } catch {}
}
# 主线程消费回执队列：解析 action → 调后端（同意/拒绝/回复）或开浏览器
function Drain-Activations {
  $item = $null
  while ($script:actQueue.TryDequeue([ref]$item)) {
    $kv = @{}
    foreach ($pair in ([string]$item).Split('&')) {
      $p = $pair.Split('=', 2)
      if ($p.Count -eq 2) { $kv[$p[0]] = [uri]::UnescapeDataString($p[1]) }
    }
    switch ($kv['action']) {
      'approve' { [void](Post-Json "$BaseUrl/api/runs/$($kv['runId'])/permission" @{ reqId = $kv['reqId']; behavior = 'allow' }); Remove-Toast $kv['reqId'] }
      'deny'    { [void](Post-Json "$BaseUrl/api/runs/$($kv['runId'])/permission" @{ reqId = $kv['reqId']; behavior = 'deny' });  Remove-Toast $kv['reqId'] }
      'reply'   {
        $text = [string]$kv['reply']
        if ($text -and $text.Trim()) {
          $ok = Post-Json "$BaseUrl/api/runs/$($kv['runId'])/reply" @{ message = $text.Trim(); kind = 'chat' }
          if (-not $ok) { $notify.ShowBalloonTip(4000, '望子成龙小学', '回复发送失败（会话可能已收工/无上下文）。', 'Warning') }
        }
      }
      'open'    { Start-Process $UiUrl }
      default   { Start-Process $UiUrl }
    }
  }
}
# 审批 Toast：同意 / 拒绝 / 打开（reminder 场景常驻直到处理，配合后端 5min 超时）
function Show-ApprovalToast($pp) {
  $who = Escape-Xml $pp.employeeName
  $tool = Escape-Xml $pp.toolName
  $brief = Escape-Xml ([string]$pp.brief)
  $reqId = [uri]::EscapeDataString([string]$pp.reqId)
  $runId = [uri]::EscapeDataString([string]$pp.runId)
  $xml = @"
<toast scenario="reminder" launch="action=open">
  <visual><binding template="ToastGeneric">
    <text>🙋 $who 请求审批</text>
    <text>$tool · $brief</text>
    <text placement="attribution">望子成龙小学 · 危险操作待你放行</text>
  </binding></visual>
  <actions>
    <action content="同意" activationType="foreground" arguments="action=approve&amp;reqId=$reqId&amp;runId=$runId"/>
    <action content="拒绝" activationType="foreground" arguments="action=deny&amp;reqId=$reqId&amp;runId=$runId"/>
    <action content="打开控制台" activationType="protocol" arguments="$UiUrl"/>
  </actions>
</toast>
"@
  Show-Toast $xml ([string]$pp.reqId)
}
# 收工/异常 Toast：done 带回复框 + 打开；error/interrupted 仅打开。done 有 gate 时高亮「待你拍板」
function Show-StopToast($ev) {
  # ⚠ 先判空、再索引：`notifyLog` 里混着非收工事件（实测 20 条里 13 条是 `kind=lark-sync`，**根本没有 status 字段**），
  #   而 PowerShell 的 `$hash[$null]` 会**抛异常**而不是返回 $null——所以原来写在下一行的 `if (-not $meta) { return }`
  #   永远等不到执行。这个顺序错误把整条 Toast 链路毒死了（详见 Poll-Notifications 里的游标注释与 §3.130）。
  $status = [string]$ev.status
  if (-not $status) { return }        # 非收工类事件（lark-sync 等）：不弹 Toast，直接跳过
  $meta = @{ done = @('✅','收工'); error = @('❌','异常停止'); interrupted = @('⏸','中断') }[$status]
  if (-not $meta) { return }
  $who = Escape-Xml $ev.employeeName
  $task = Escape-Xml ([string]$ev.taskName)
  $gate = [string]$ev.gate
  $tail = Escape-Xml ([string]$ev.resultTail)
  $line2 = if ($gate) { '🙋 待你拍板：' + (Escape-Xml $gate) } elseif ($task) { $task } else { $tail }
  $title = if ($gate) { "🙋 $who 收工·待你拍板" } else { "$($meta[0]) $who $($meta[1])" }
  $runId = [uri]::EscapeDataString([string]$ev.runId)
  $third = if ($gate -and $tail) { "    <text>$tail</text>`n" } else { '' }
  if ($ev.status -eq 'done') {
    $xml = @"
<toast launch="action=open">
  <visual><binding template="ToastGeneric">
    <text>$title</text>
    <text>$line2</text>
$third  </binding></visual>
  <actions>
    <input id="replyBox" type="text" placeHolder="回复员工，催他继续或拍板…"/>
    <action content="发送回复" activationType="foreground" hint-inputId="replyBox" arguments="action=reply&amp;runId=$runId"/>
    <action content="打开控制台" activationType="protocol" arguments="$UiUrl"/>
  </actions>
</toast>
"@
  } else {
    $xml = @"
<toast launch="action=open">
  <visual><binding template="ToastGeneric">
    <text>$title</text>
    <text>$line2</text>
  </binding></visual>
  <actions>
    <action content="打开控制台" activationType="protocol" arguments="$UiUrl"/>
  </actions>
</toast>
"@
  }
  Show-Toast $xml ("stop-$($ev.seq)")
}
# 每个心跳周期拉取本地通知：先弹审批（并撤下已处理的），再弹增量收工事件
function Poll-Notifications {
  if (-not $script:notifyEnabled) { return }
  try { $r = Invoke-RestMethod -Uri "$BaseUrl/api/notifications?since=$($script:notifySince)" -TimeoutSec 2 } catch { return }
  # 审批：新出现的弹卡；已消失（别处/超时处理）的撤下
  $curr = @{}
  foreach ($pp in @($r.pending)) { $curr[[string]$pp.reqId] = $pp }
  foreach ($reqId in @($curr.Keys)) {
    if (-not $script:shownReqIds.Contains($reqId)) { Show-ApprovalToast $curr[$reqId]; [void]$script:shownReqIds.Add($reqId) }
  }
  foreach ($reqId in @($script:shownReqIds)) {
    if (-not $curr.ContainsKey($reqId)) { Remove-Toast $reqId; [void]$script:shownReqIds.Remove($reqId) }
  }
  # 收工事件：首轮只建基线（不回放历史），之后弹增量
  if (-not $script:notifyInit) {
    $script:notifyInit = $true
    $script:notifySince = [int]$r.seq
  } else {
    # ★ 游标必须**先推进、再弹卡**，且单条失败不许拖累整批（2026-09-09，见 §3.130）。
    # 原写法 `Show-StopToast $ev` 在前、推游标在后、且两者都不设防：**任何一条事件让 Show-StopToast 抛异常，
    #   foreach 当场中断，`$script:notifySince` 就永远停在它前面**——下一轮 4 秒后拉回同一批、又抛在同一条，
    #   于是 Toast 整条链路被一条坏事件永久毒死（poison pill），且此前这个异常被 PowerShell 的事件委托静默吞掉，
    #   连一行日志都没有。实测：`notifyLog` 里 20 条有 13 条是 `kind=lark-sync`、**没有 `status` 字段**，
    #   而 Show-StopToast 第一句就 `@{done=…;error=…;interrupted=…}[$ev.status]`——PowerShell 里 `$hash[$null]`
    #   直接抛「索引操作失败；数组索引的计算结果为 Null」，那句本该拦住它的 `if (-not $meta) { return }` 晚了一行。
    # 游标一次性推到整批最大 seq（`Get-NextNotifyCursor`，纯函数 + 4 条断言）：**先推进、再弹卡**，
    # 这样哪一条弹卡失手都不会让下一轮重放整批。
    $script:notifySince = Get-NextNotifyCursor -Since ([int]$script:notifySince) -Events $r.events
    foreach ($ev in (@($r.events) | Sort-Object seq)) {
      if (-not (Test-IsStopEvent $ev)) { continue }   # 非收工事件（lark-sync 等）直接跳过，见 Test-IsStopEvent 注释
      try { Show-StopToast $ev } catch { Write-TrayLog ("收工 Toast 失败（已跳过 seq=$($ev.seq)，游标已推进）：" + $_.Exception.Message) }
    }
  }
}

# ---------- 托盘图标 + 右键菜单 ----------
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $IcoStopped
$notify.Text = '望子成龙小学 · 未启动'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Add-Item([string]$text, [scriptblock]$onClick, [bool]$enabled = $true) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem
  $it.Text = $text
  $it.Enabled = $enabled
  if ($onClick) { $it.add_Click($onClick) }
  [void]$menu.Items.Add($it)
  return $it
}

# 顶部：实时状态行（不可点，仅展示）
$miStatus = Add-Item '● 未启动' $null $false
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miOpen    = Add-Item '打开控制台' { Start-Process $UiUrl }
# 悬浮窗（全局置顶小窗）子菜单：显示/隐藏 · 重载 · 置顶 · 半透明 · 重置几何
$miFloatMenu = New-Object System.Windows.Forms.ToolStripMenuItem
$miFloatMenu.Text = '悬浮窗'
function Add-Sub([System.Windows.Forms.ToolStripMenuItem]$parent, [string]$text, [scriptblock]$onClick) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem
  $it.Text = $text
  if ($onClick) { $it.add_Click($onClick) }
  [void]$parent.DropDownItems.Add($it)
  return $it
}
$miFloatToggle = Add-Sub $miFloatMenu '显示悬浮窗（置顶）' { Toggle-Float }
$miFloatReload = Add-Sub $miFloatMenu '重新加载页面' { Reload-Float }
[void]$miFloatMenu.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miFloatTop = Add-Sub $miFloatMenu '窗口置顶' { Set-FloatTopMost (-not $script:floatTopMost) }
$miFloatDim = Add-Sub $miFloatMenu '半透明（85%）' { if ($script:floatOpacity -lt 100) { Set-FloatOpacity 100 } else { Set-FloatOpacity 85 } }
$miFloatReset = Add-Sub $miFloatMenu '重置位置与大小' { Reset-FloatBounds }
[void]$menu.Items.Add($miFloatMenu)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miStart   = Add-Item '启动服务' { Start-Server }
$miStop    = Add-Item '停止服务' { Stop-Server $true }
$miRestart = Add-Item '重启服务' { Restart-Server }
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miDetail  = Add-Item '查看服务状态' { Show-StatusBalloon }
$miLog     = Add-Item '查看运行日志' { if (Test-Path $OutLog) { Start-Process notepad.exe $OutLog } else { [System.Windows.Forms.MessageBox]::Show('暂无日志文件。','望子成龙小学','OK','Information') | Out-Null } }
$miErrLog  = Add-Item '查看错误日志' { if ((Test-Path $ErrLog) -and (Get-Item $ErrLog).Length -gt 0) { Start-Process notepad.exe $ErrLog } else { [System.Windows.Forms.MessageBox]::Show('错误日志为空（没有崩溃/报错）。','望子成龙小学','OK','Information') | Out-Null } }
$miWebLog  = Add-Item '查看新 UI 日志' { $f = if ((Test-Path $WebErr) -and (Get-Item $WebErr).Length -gt 0) { $WebErr } else { $WebOut }; if (Test-Path $f) { Start-Process notepad.exe $f } else { [System.Windows.Forms.MessageBox]::Show('暂无新 UI 日志（可能未起或 web/ 缺失）。','望子成龙小学','OK','Information') | Out-Null } }
$miDir     = Add-Item '打开安装目录' { Start-Process explorer.exe $TrayDir }
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miAutoStart = Add-Item '开机自启' { Toggle-AutoStart }
$miNotify = Add-Item 'Windows 通知（审批/收工回执）' { $script:notifyEnabled = -not $script:notifyEnabled; $miNotify.Checked = $script:notifyEnabled; Save-Cfg }
$miNotify.Checked = $script:notifyEnabled
$miAutoRestart = Add-Item '崩溃自动重启' { $script:autoRestart = -not $script:autoRestart; $miAutoRestart.Checked = $script:autoRestart; Save-Cfg }
$miAutoRestart.Checked = $script:autoRestart
# 注意：悬浮窗子菜单的初始文案/勾选（Sync-FloatMenu）不在此处调用——PowerShell 不提升函数，
#   Sync-FloatMenu 定义在本文件更靠后处，此刻尚未定义。改在文件末尾启动区（函数都已定义后）调用。
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miExit    = Add-Item '退出（并停服）' { Quit-Tray }

$notify.ContextMenuStrip = $menu
# 左键单击 = 开/关悬浮窗（最常用的动作给最轻的手势）；左键双击 = 浏览器打开新 UI(4700)，保持原有交互。
# 为什么要延时：NotifyIcon 的双击会**先**触发一次 MouseClick 再触发 MouseDoubleClick——直接在 MouseClick 里
#   开悬浮窗的话，每次双击都会顺带把悬浮窗翻一遍（开了又留着 / 或把已开的关掉）。故单击动作延后一个系统
#   双击时长再执行，其间若真来了双击就把它撤销。间隔取系统 DoubleClickTime + 60ms 余量（并兜底不低于 200ms）。
$script:trayClickTimer = New-Object System.Windows.Forms.Timer
$script:trayClickTimer.Interval = [Math]::Max(200, [System.Windows.Forms.SystemInformation]::DoubleClickTime + 60)
$script:trayClickTimer.add_Tick({ $script:trayClickTimer.Stop(); Toggle-Float })
$notify.add_MouseClick({
  param($s, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }   # 右键留给上下文菜单
  $script:trayClickTimer.Stop(); $script:trayClickTimer.Start()
})
$notify.add_MouseDoubleClick({
  param($s, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  $script:trayClickTimer.Stop()   # 撤销这一双击里第一下排下的「开悬浮窗」
  Start-Process $UiUrl
})

# ---------- 开机自启：在「启动」文件夹放/删一个指向 vbs 的快捷方式 ----------
$StartupDir = [Environment]::GetFolderPath('Startup')
$LnkPath    = Join-Path $StartupDir '望子成龙小学托盘.lnk'
function Test-AutoStart { Test-Path $LnkPath }
function Toggle-AutoStart {
  try {
    if (Test-AutoStart) {
      Remove-Item $LnkPath -Force
      $notify.ShowBalloonTip(3000, '望子成龙小学', '已关闭开机自启。', 'Info')
    } else {
      $sh = New-Object -ComObject WScript.Shell
      $lnk = $sh.CreateShortcut($LnkPath)
      $lnk.TargetPath = 'wscript.exe'
      $lnk.Arguments = "`"$VbsPath`""
      $lnk.WorkingDirectory = $TrayDir
      $lnk.Description = '望子成龙小学 AI 数字员工工作台 · 托盘'
      $lnk.Save()
      $notify.ShowBalloonTip(3000, '望子成龙小学', '已设为开机自启（下次登录自动拉起）。', 'Info')
    }
  } catch {
    $notify.ShowBalloonTip(3000, '望子成龙小学', "设置开机自启失败：$($_.Exception.Message)", 'Error')
  }
  $miAutoStart.Checked = Test-AutoStart
}
$miAutoStart.Checked = Test-AutoStart

# ---------- 端口真伪判定 ----------
# 病根（2026-08-20 排查「lab 崩溃好几次」）：原先「端口是否被占」「服务是否还活着」两处判定**都拿 health 应答当代理**
#   （Start-Server 用 1s 超时、心跳用 2s 超时）。引擎忙一下（多会话流式 + jsonl 落盘 + 大响应压缩）就被判成「死了/端口空」，
#   于是托盘拉起第二个 node → 撞 EADDRINUSE → 引擎自杀退出(1) → 托盘计为「异常退出」→ 自动重启 → 再自杀……
#   用户看到一串「服务异常退出」气泡（= 感知到的「崩溃好几次」），而真引擎其实一直在干活（run jsonl 一路在写）。
# 正解：「端口有没有主」只信 TCP 监听表（内核事实、与忙闲无关），health 只用来判「是不是我们自己的 server + 是否响应」。
function Get-PortOwnerPid([int]$p) {
  try {
    $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess }
  } catch {
    # 兜底：老系统/权限异常时退回 netstat 解析（-ano 最后一列即 PID）
    try {
      $line = (& netstat.exe -ano | Select-String -Pattern ":$p\s" | Select-String -Pattern 'LISTENING' | Select-Object -First 1).ToString()
      if ($line) { return [int](($line -split '\s+') | Where-Object { $_ } | Select-Object -Last 1) }
    } catch {}
  }
  return 0
}

# 某进程是不是另一进程的子孙（沿 ParentProcessId 上溯）。
# 用途：判「4700 端口的主是不是托盘自己起的」——$script:webproc 拿到的是 **cmd 外壳**的 PID，
# 而真正监听 4700 的是它下面好几层的 vite node，直接比 PID 永远不等，会把自己起的也误判成外部。
function Test-IsDescendant([int]$childPid, [int]$ancestorPid) {
  if ($childPid -le 0 -or $ancestorPid -le 0) { return $false }
  try {
    $cur = $childPid
    for ($i = 0; $i -lt 12; $i++) {
      if ($cur -eq $ancestorPid) { return $true }
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop
      if (-not $p -or -not $p.ParentProcessId) { return $false }
      $cur = [int]$p.ParentProcessId
      if ($cur -le 0) { return $false }
    }
  } catch {}
  return $false
}

# 进程的一行说明（PID + 名字 + 截断命令行），供日志与气泡点名「界面到底挂在谁身上」。
function Describe-Proc([int]$procId) {
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
    if (-not $p) { return "PID $procId（已退出）" }
    $cmd = ($p.CommandLine -replace '\s+', ' ')
    if ($cmd.Length -gt 90) { $cmd = $cmd.Substring(0, 90) + '…' }
    return "PID $procId $($p.Name) $cmd"
  } catch { return "PID $procId" }
}

# ---------- 启动前转存上一轮日志 ----------
# 病根（同上）：cmd 重定向用的是 `>`（截断），每次拉起都冲掉上一轮 stderr。今天三次拉起相隔 4~30s，
#   自杀实例写的 `[fatal] 端口已被占用` 全被下一次覆盖 → 事后零现场可查。
# 对策：启动前把非空的旧日志**追加**进 *.history.log（带转存时间/大小分隔线），再让 cmd 照旧截断写新的一轮
#   （历史全留、单轮日志不互相穿插；history 超 4MB 滚存一份 .1，不无限长）。
function Archive-Log([string]$path) {
  try {
    if (-not (Test-Path $path)) { return }
    $fi = Get-Item $path
    if ($fi.Length -le 0) { return }
    $body = Get-Content $path -Raw -Encoding UTF8
    # 只判字节数不够：BOM/空行也算「有长度」，会往 history 里灌一条空分隔线（自测时抓到）。实质空就跳过。
    if ([string]::IsNullOrWhiteSpace($body)) { return }
    $hist = [IO.Path]::ChangeExtension($path, $null).TrimEnd('.') + '.history.log'
    if ((Test-Path $hist) -and (Get-Item $hist).Length -gt 4MB) {
      Move-Item $hist "$hist.1" -Force -ErrorAction SilentlyContinue
    }
    $sep = "`r`n===== 转存于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')（上一轮 $([int]$fi.Length) 字节，来自 $($fi.Name)）=====`r`n"
    Add-Content -Path $hist -Value $sep -Encoding UTF8
    Add-Content -Path $hist -Value $body -Encoding UTF8
  } catch {}
}

# ---------- 服务生命周期 ----------
function Start-Server {
  if ($script:proc -and -not $script:proc.HasExited) { return }
  $script:userStopped = $false
  # ★ 先看端口有没有主（TCP 监听表，不受引擎忙闲影响）——有主就绝不拉第二个 node（否则必撞 EADDRINUSE 自杀）。
  $ownerPid = Get-PortOwnerPid $Port
  if ($ownerPid -gt 0) {
    # 再探 health 只为区分「活着且响应」还是「占着端口但没响应（卡顿/半死）」；两种都不拉替身。
    try { $hb = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 3; $alive = $true } catch { $alive = $false }
    $script:monitorPid = if ($alive) { try { [int]$hb.pid } catch { $ownerPid } } else { $ownerPid }
    $script:proc = $null
    if ($alive) {
      Write-TrayLog "端口 $Port 已有服务在跑（监听 PID $ownerPid / health PID $($script:monitorPid)），转为监控模式（可经托盘停止/重启接管）"
      $script:state = 'running'; Update-Ui
      $notify.ShowBalloonTip(6000, '望子成龙小学', "端口 $Port 已有 office-lab 服务在运行（PID $($script:monitorPid)，多为上一托盘实例遗留）。托盘已接管，可直接右键「停止/重启服务」。", 'Info')
    } else {
      # 占着端口但不应答：多为卡顿/半死实例。不拉替身（会自杀），但把 PID 记牢 + 状态置 unhealthy，
      # 让右键「停止/重启」能直接接管把它清掉——今天的事故里这个把手恰恰被丢掉了，用户只能去任务管理器手杀。
      Write-TrayLog "端口 $Port 被 PID $ownerPid 占着但 health 不应答（卡顿/半死）：不拉替身，转监控-unhealthy，可经托盘「停止/重启」接管清理"
      $script:state = 'unhealthy'; Update-Ui
      $notify.ShowBalloonTip(6000, '望子成龙小学', "端口 $Port 上的服务（PID $ownerPid）无响应但仍占着端口。托盘未重复拉起（会撞端口自杀）；可右键「重启服务」接管清理。", 'Warning')
    }
    Start-Web
    return
  }
  Archive-Log $OutLog; Archive-Log $ErrLog   # 保住上一轮现场（尤其自杀实例的 [fatal] 那行），再让 cmd 截断写新一轮
  $env:OFFICE_LAB_PORT = "$Port"     # 子进程继承；HOST 保持默认 0.0.0.0（局域网/Tailscale 仍可达）
  try {
    # 用 ProcessStartInfo + CreateNoWindow 起 node（经 cmd 做文件重定向），彻底不产生任何控制台窗口。
    # 根因（用户实测）：Start-Process -WindowStyle Hidden 对「宿主无可见控制台」下的控制台子进程并不可靠——
    #   会给 node 分配一个「可见的新终端窗口」，且该窗口就是 node 的宿主控制台；用户一关窗 → Windows 向
    #   控制台进程组发 CTRL_CLOSE → node 连同服务被杀（「重启弹出终端、关掉它整个服务就没了」）。
    #   -WindowStyle Hidden 只是 SW_HIDE（窗口仍被创建、仍可被关、仍属控制台组），治标不治本。
    # 正解 = CREATE_NO_WINDOW（.NET CreateNoWindow=$true）：node 有自己的控制台供 stdio，但根本不创建
    #   窗口 → 无窗可关、不挂在任何可见控制台上。日志重定向交给 cmd 的 > / 2>（原生落文件；不走 PowerShell
    #   流泵——回调线程跑 PowerShell 非线程安全会崩，见本文件 Toast 回调处同款注意）。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec        # cmd.exe：仅作重定向外壳，/c 结束即随 node 退出
    $psi.Arguments = '/d /s /c ""{0}" server.js > "{1}" 2> "{2}""' -f $NodeExe, $OutLog, $ErrLog
    $psi.WorkingDirectory = $AppDir
    $psi.UseShellExecute = $false       # 继承本进程环境（含上面的 OFFICE_LAB_PORT）
    $psi.CreateNoWindow = $true         # ★ 关键：无窗口、不挂可见控制台
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()
    $script:proc = $p                    # 此 proc 是 cmd 外壳；node 是其子进程，taskkill /T 会连带清掉
    $script:state = 'starting'
    Update-Ui
    Write-TrayLog "已拉起 node（cmd 外壳 PID $($script:proc.Id)，端口 $Port，CreateNoWindow）"
    $notify.ShowBalloonTip(2000, '望子成龙小学', "正在启动服务…（端口 $Port）", 'Info')
  } catch {
    Write-TrayLog "启动 node 失败：$($_.Exception.Message)"
    $script:state = 'stopped'; $script:proc = $null; Update-Ui
    $notify.ShowBalloonTip(4000, '望子成龙小学', "启动失败：$($_.Exception.Message)", 'Error')
  }
  Start-Web   # 引擎起好后一并拉起新 UI（vite preview → 4700）+ 产物 watcher
}

function Stop-Server([bool]$byUser) {
  if ($byUser) { $script:userStopped = $true }
  $p = $script:proc
  # 停服必留痕：原先只有「监控模式停服」写日志，托盘自己拉起的那条静默 → 事后无法区分
  # 「用户点了停止/重启」和「进程自己崩了被自动重启」（2026-08-20 排查时正卡在这个二义性上）。
  Write-TrayLog ("停服请求（{0}）：托管进程={1}，监控PID={2}" -f $(if ($byUser) { '用户操作' } else { '程序内部' }), $(if ($p -and -not $p.HasExited) { "PID $($p.Id)" } else { '无' }), $(if ($script:monitorPid) { $script:monitorPid } else { '无' }))
  if ($p -and -not $p.HasExited) {
    # 托盘自己拉起的：先温和 taskkill /T（连带杀掉 claude 子进程树，避免孤儿），3s 不退再 /F 强杀。
    # 注意：node/claude 是无窗口控制台进程，温和 /T（不带 /F）对它们必然失败并往 stderr 打「只能强行终止(带 /F 选项)」
    #   ——这是预期内的一跳，随后 /F 会兜底。这里连 stderr 一起吞掉（2>&1 | Out-Null），否则调试可见窗口下会刷出吓人的红字。
    try { & taskkill.exe /PID $p.Id /T 2>&1 | Out-Null } catch {}
    if (-not $p.WaitForExit(3000)) { try { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null } catch {} }
  } elseif ($script:monitorPid) {
    # 监控模式接管：停掉「端口上正在跑的 office-lab 服务」（上一实例遗留/终端启动），同样 /T 温和优先、稍候再 /F
    Write-TrayLog "监控模式停服：taskkill PID $($script:monitorPid)（含子进程树）"
    try { & taskkill.exe /PID $script:monitorPid /T 2>&1 | Out-Null } catch {}
    Start-Sleep -Milliseconds 800
    try { & taskkill.exe /PID $script:monitorPid /T /F 2>&1 | Out-Null } catch {}
  }
  $script:proc = $null; $script:monitorPid = $null
  $script:state = 'stopped'; $script:health = $null
  Stop-Web
  Update-Ui
}

# pnpm 子进程通用起法（cmd 外壳 + CreateNoWindow + 重定向，同 server.js 那套）
function Start-PnpmProc([string]$argLine, [string]$outLog, [string]$errLog) {
  $pnpm = if (Test-Path $CorepackCmd) { $CorepackCmd } else { 'corepack' }
  $env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'   # 非交互：corepack 首用 pnpm 时别弹确认（无窗口会卡住）
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /s /c ""{0}" pnpm {1} > "{2}" 2> "{3}""' -f $pnpm, $argLine, $outLog, $errLog
  $psi.WorkingDirectory = $WebDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  # 启动已验证的产物，不允许 pnpm 11 因包信息变化自动安装依赖（preview/watch 会并行起）。
  # 只作用于此子进程；依赖安装仍由显式部署/开发步骤负责。
  $psi.EnvironmentVariables['pnpm_config_verify_deps_before_run'] = 'false'
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  [void]$p.Start()
  return $p
}

# 新 UI（vite preview, 4700）——与引擎同起同停。无 web/ 或端口已占则跳过。
# 首次没有构建产物时先同步 build 一次（preview 没有 dist 会直接报错退出）。
function Start-Web {
  if (-not (Test-Path (Join-Path $WebDir 'package.json'))) { Write-TrayLog "无 web/（跳过新 UI）"; return }
  if ($script:webproc -and -not $script:webproc.HasExited) { return }
  # ★ 端口有没有主，只信 TCP 监听表（内核事实），别拿 HTTP 探测当代理——与引擎 Start-Server 同一条口径
  #   （见「端口真伪判定」那段的病根：用 health/HTTP 超时判端口，忙一下就误判）。
  # 更要紧的是**旧实现在这里只写一句「已在跑，跳过拉起」就 return 了**：托盘悄悄把自己降级成旁观者，
  #   用户完全不知道 4700 其实挂在一个托盘管不着的进程上（多为手工终端里的 `pnpm dev`/`vite preview`）。
  #   于是关掉那个终端 → 界面没了 → 用户感知是「关掉窗口整个程序都关掉了」，而引擎其实还活着
  #   （2026-08-26 实测：4700 的主是 `sh.exe → corepack pnpm preview → cmd → vite`，一路挂在 Git Bash 窗口上）。
  # 引擎侧早有对称处理（转监控模式 + 明确提示可接管），web 侧缺了——这次补上。
  $webOwner = Get-PortOwnerPid $WebPort
  if ($webOwner -gt 0) {
    $mine = Test-IsDescendant $webOwner ($(if ($script:webproc) { $script:webproc.Id } else { 0 }))
    if ($mine) { Write-TrayLog "新 UI 端口 $WebPort 由本托盘托管中（监听 PID $webOwner），无需重复拉起"; return }
    $script:webMonitorPid = $webOwner
    $desc = Describe-Proc $webOwner
    Write-TrayLog "新 UI 端口 $WebPort 被**外部进程**占用：$desc —— 转 web 监控模式（托盘不重复拉起；右键「重启服务」可接管收编）"
    $notify.ShowBalloonTip(7000, '望子成龙小学', "界面($WebPort)不是托盘起的，挂在外部进程 PID $webOwner 上（多为终端里手工跑的 pnpm dev/preview）。`n⚠ 关掉那个终端窗口，界面就会没（引擎不受影响）。右键「重启服务」可让托盘接管。", 'Warning')
    Start-WebBuild   # 产物 watcher 仍由托盘补上（它不占端口，与外部 preview 不冲突）
    return
  }
  $script:webMonitorPid = $null
  try {
    if (-not (Test-Path (Join-Path $WebDir 'dist\index.html'))) {
      Write-TrayLog "无 web/dist，先同步构建一次（约十几秒）…"
      $b = Start-PnpmProc 'build' $WebBuildOut $WebBuildErr
      if (-not $b.WaitForExit(300000)) { try { & taskkill.exe /PID $b.Id /T /F 2>&1 | Out-Null } catch {} ; Write-TrayLog "首次构建超时（见 $WebBuildErr）" }
    }
    $p = Start-PnpmProc 'preview' $WebOut $WebErr
    $script:webproc = $p
    Write-TrayLog "已拉起 新 UI vite preview（cmd 外壳 PID $($p.Id)，端口 $WebPort）"
  } catch {
    Write-TrayLog "启动 新 UI 失败：$($_.Exception.Message)（见 $WebErr）"
    $script:webproc = $null
  }
  Start-WebBuild
}

# 产物 watcher（`vite build --watch`）：改完前端代码几秒内 dist 自动更新，隧道那侧刷新即见新版。
# 不带 tsc -b，避免一个类型错就卡住产物更新；类型检查仍走 `pnpm build`。
function Start-WebBuild {
  if (-not (Test-Path (Join-Path $WebDir 'package.json'))) { return }
  if ($script:webbuildproc -and -not $script:webbuildproc.HasExited) { return }
  try {
    $p = Start-PnpmProc 'build:watch' $WebBuildOut $WebBuildErr
    $script:webbuildproc = $p
    Write-TrayLog "已拉起 新 UI 产物 watcher（cmd 外壳 PID $($p.Id)，日志 $WebBuildOut）"
  } catch {
    Write-TrayLog "启动 产物 watcher 失败：$($_.Exception.Message)（见 $WebBuildErr）"
    $script:webbuildproc = $null
  }
}

function Stop-Web {
  foreach ($name in @('webproc', 'webbuildproc')) {
    $p = Get-Variable -Name $name -Scope Script -ValueOnly
    if ($p -and -not $p.HasExited) {
      try { & taskkill.exe /PID $p.Id /T 2>&1 | Out-Null } catch {}
      if (-not $p.WaitForExit(3000)) { try { & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null } catch {} }
    }
    Set-Variable -Name $name -Scope Script -Value $null
  }
  # web 监控模式接管：4700 挂在外部进程上时，把那棵树也停掉——否则「重启服务」永远收编不了它，
  # 托盘每轮只会再写一遍「端口已在跑」（旧行为就是这么卡死在旁观者位置的）。与引擎监控模式停服同口径。
  # ⚠ 只杀「看起来确实是前端 dev/preview」的进程树：4700 万一被无关程序占着，不该被托盘顺手杀掉。
  if ($script:webMonitorPid) {
    $wp = $script:webMonitorPid
    $ok = $false
    try {
      $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$wp" -ErrorAction Stop
      $ok = $ci -and ($ci.Name -match '^(node|cmd|sh|bash|pwsh|powershell)\.exe$') -and ($ci.CommandLine -match 'vite|pnpm|npm|corepack|office-lab|web')
      if (-not $ok) { Write-TrayLog "web 监控模式停服：跳过 PID $wp（不像前端 dev/preview 进程，不擅自杀：$(Describe-Proc $wp)）" }
    } catch { Write-TrayLog "web 监控模式停服：PID $wp 已不存在，跳过" }
    if ($ok) {
      Write-TrayLog "web 监控模式停服：接管外部界面进程树 $(Describe-Proc $wp)"
      try { & taskkill.exe /PID $wp /T 2>&1 | Out-Null } catch {}
      Start-Sleep -Milliseconds 800
      try { & taskkill.exe /PID $wp /T /F 2>&1 | Out-Null } catch {}
      # 外部那棵树常是 sh/bash → corepack → cmd → vite 多层；杀叶子后祖先可能还挂着并再拉一个。
      # 顺着祖先链把「同属这条前端链」的也收掉，否则端口会被它立刻重新占上。
      try {
        $cur = (Get-CimInstance Win32_Process -Filter "ProcessId=$wp" -ErrorAction SilentlyContinue)
        $anc = if ($cur) { [int]$cur.ParentProcessId } else { 0 }
        for ($i = 0; $i -lt 5 -and $anc -gt 0; $i++) {
          $a = Get-CimInstance Win32_Process -Filter "ProcessId=$anc" -ErrorAction SilentlyContinue
          if (-not $a -or $a.CommandLine -notmatch 'vite|pnpm|corepack') { break }
          Write-TrayLog "  连带停掉外部界面链上的祖先：$(Describe-Proc $anc)"
          try { & taskkill.exe /PID $anc /T /F 2>&1 | Out-Null } catch {}
          $anc = [int]$a.ParentProcessId
        }
      } catch {}
    }
    $script:webMonitorPid = $null
  }
}

function Restart-Server {
  Stop-Server $false      # 非用户停：允许后续状态机继续
  Start-Sleep -Milliseconds 600
  $script:restarts = 0    # 手动重启清零崩溃计数
  Start-Server
}

# ---------- 悬浮窗（WebView2 置顶小窗）：全局悬浮、钉在最前，看别的东西不用来回切窗口 ----------
# 惰性加载 vendored WebView2 程序集 + 备好架构匹配的原生 loader；缺 DLL/运行时时返回 $false 优雅降级，不拖垮托盘。
function Init-WebView2 {
  if ($script:wv2Loaded) { return $true }
  try {
    $arch = if ([IntPtr]::Size -eq 8) { 'x64' } else { 'x86' }
    $srcLoader = Join-Path $VendorWv2 "WebView2Loader.$arch.dll"
    $dstLoader = Join-Path $VendorWv2 'WebView2Loader.dll'
    if (-not (Test-Path $srcLoader)) { throw "缺原生 loader：$srcLoader" }
    Copy-Item $srcLoader $dstLoader -Force
    [void][OfficeLab.NativeLoader]::SetDllDirectory($VendorWv2)
    if ([OfficeLab.NativeLoader]::LoadLibrary($dstLoader) -eq [IntPtr]::Zero) { throw '原生 WebView2Loader 加载失败' }
    Add-Type -Path (Join-Path $VendorWv2 'Microsoft.Web.WebView2.Core.dll')
    Add-Type -Path (Join-Path $VendorWv2 'Microsoft.Web.WebView2.WinForms.dll')
    $script:wv2Loaded = $true
    Write-TrayLog "WebView2 程序集已加载（arch=$arch）"
    return $true
  } catch {
    Write-TrayLog ('WebView2 加载失败：' + $_.Exception.Message)
    return $false
  }
}
# 保存悬浮窗当前位置/大小（仅正常态；最小化/最大化不存）
function Save-FloatBounds {
  $f = $script:floatForm
  if ($f -and -not $f.IsDisposed -and $f.WindowState -eq [System.Windows.Forms.FormWindowState]::Normal) {
    $b = $f.Bounds
    $script:floatX = $b.X; $script:floatY = $b.Y; $script:floatW = $b.Width; $script:floatH = $b.Height
    Save-Cfg
  }
}
# 惰性创建悬浮窗（Form + WebView2），跨显示/隐藏复用；不阻塞 UI 线程——异步 EnsureCoreWebView2Async + 事件里导航
# （切忌在菜单点击回调里对初始化任务 .GetResult() 同步等待，会与消息循环互锁死锁）。
function Ensure-FloatWindow {
  if ($script:floatForm -and -not $script:floatForm.IsDisposed) { return $true }
  if (-not (Init-WebView2)) {
    $notify.ShowBalloonTip(6000, '望子成龙小学', '悬浮窗组件加载失败（缺 WebView2 运行时或 vendor DLL）。', 'Error')
    return $false
  }
  $f = New-Object System.Windows.Forms.Form
  $f.Text = '望子成龙小学 · 悬浮窗'
  $f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $f.MinimumSize = New-Object System.Drawing.Size(320, 420)
  try { $f.Icon = $IcoRunning } catch {}   # 复用托盘 logo 图标
  # 恢复上次几何；无或已移出所有屏幕则给默认（主屏右侧靠边、竖长小窗）
  $rect = $null
  if ($script:floatW -and $script:floatH) {
    $cand = New-Object System.Drawing.Rectangle([int]$script:floatX, [int]$script:floatY, [int]$script:floatW, [int]$script:floatH)
    foreach ($sc in [System.Windows.Forms.Screen]::AllScreens) { if ($sc.WorkingArea.IntersectsWith($cand)) { $rect = $cand; break } }
  }
  if (-not $rect) {
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $w = 420; $h = [Math]::Min(760, $wa.Height - 48)
    $rect = New-Object System.Drawing.Rectangle(($wa.Right - $w - 24), ($wa.Top + 24), $w, $h)
  }
  $f.Bounds = $rect
  $f.TopMost = $script:floatTopMost
  $f.Opacity = [double]$script:floatOpacity / 100.0
  $wv = New-Object Microsoft.Web.WebView2.WinForms.WebView2
  $wv.Dock = [System.Windows.Forms.DockStyle]::Fill
  $props = New-Object Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
  $props.UserDataFolder = $Wv2UserData
  $wv.CreationProperties = $props
  $wv.add_CoreWebView2InitializationCompleted({
    param($s, $e)
    if ($e.IsSuccess) { try { $s.CoreWebView2.Navigate($UiUrl) } catch {} }
    else { Write-TrayLog ('悬浮窗 WebView2 初始化失败：' + $e.InitializationException.Message) }
  })
  $f.Controls.Add($wv)
  # 关闭按钮 = 隐藏（可再召唤）；退出托盘时置 floatQuitting 才真正放行关闭
  $f.add_FormClosing({ param($s, $e) if ($script:floatQuitting) { return } $e.Cancel = $true; Save-FloatBounds; $s.Hide(); $script:floatVisible = $false; Sync-FloatMenu })
  $f.add_ResizeEnd({ Save-FloatBounds })
  $f.add_Move({ Save-FloatBounds })
  $script:floatForm = $f
  $script:floatWv = $wv
  New-Item -ItemType Directory -Force -Path $Wv2UserData | Out-Null
  return $true
}
function Show-Float {
  if (-not (Ensure-FloatWindow)) { return }
  $f = $script:floatForm
  $f.Show(); [void]$f.Activate()
  if (-not $script:floatWv.CoreWebView2) { [void]$script:floatWv.EnsureCoreWebView2Async($null) }   # 首次显示才异步拉起内核
  $script:floatVisible = $true
  Write-TrayLog '悬浮窗已显示'
  Sync-FloatMenu
}
function Hide-Float {
  if ($script:floatForm -and -not $script:floatForm.IsDisposed) { Save-FloatBounds; $script:floatForm.Hide() }
  $script:floatVisible = $false
  Sync-FloatMenu
}
function Toggle-Float { if ($script:floatVisible) { Hide-Float } else { Show-Float } }
function Set-FloatTopMost([bool]$on) {
  $script:floatTopMost = $on
  if ($script:floatForm -and -not $script:floatForm.IsDisposed) { $script:floatForm.TopMost = $on }
  Save-Cfg; Sync-FloatMenu
}
function Set-FloatOpacity([int]$pct) {
  $script:floatOpacity = $pct
  if ($script:floatForm -and -not $script:floatForm.IsDisposed) { $script:floatForm.Opacity = [double]$pct / 100.0 }
  Save-Cfg; Sync-FloatMenu
}
function Reset-FloatBounds {
  $script:floatX = $null; $script:floatY = $null; $script:floatW = $null; $script:floatH = $null; Save-Cfg
  if ($script:floatForm -and -not $script:floatForm.IsDisposed) {
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $w = 420; $h = [Math]::Min(760, $wa.Height - 48)
    $script:floatForm.Bounds = New-Object System.Drawing.Rectangle(($wa.Right - $w - 24), ($wa.Top + 24), $w, $h)
    Save-FloatBounds
  }
}
function Reload-Float {
  if ($script:floatWv -and $script:floatWv.CoreWebView2) { try { $script:floatWv.CoreWebView2.Navigate($UiUrl) } catch {} }
}
function Sync-FloatMenu {
  if ($miFloatToggle) { $miFloatToggle.Text = if ($script:floatVisible) { '隐藏悬浮窗' } else { '显示悬浮窗（置顶）' } }
  if ($miFloatTop) { $miFloatTop.Checked = $script:floatTopMost }
  if ($miFloatDim) { $miFloatDim.Checked = ($script:floatOpacity -lt 100) }
}

function Quit-Tray {
  try { $timer.Stop() } catch {}
  # 先放行悬浮窗真正关闭（否则 FormClosing 拦成隐藏会阻塞 Application.Exit），存好几何再销毁
  try { if ($script:floatForm -and -not $script:floatForm.IsDisposed) { Save-FloatBounds; $script:floatQuitting = $true; $script:floatForm.Close(); $script:floatForm.Dispose() } } catch {}
  Stop-Server $true
  $notify.Visible = $false
  try { $notify.Dispose() } catch {}
  try { $script:mutex.ReleaseMutex() } catch {}
  [System.Windows.Forms.Application]::Exit()
}

# ---------- 托盘提示 / 状态行刷新 ----------
function Fmt-Uptime([int]$sec) {
  if ($sec -lt 60) { return "${sec}s" }
  if ($sec -lt 3600) { return "$([math]::Floor($sec/60))m" }
  if ($sec -lt 86400) { return "$([math]::Floor($sec/3600))h$([math]::Floor(($sec%3600)/60))m" }
  return "$([math]::Floor($sec/86400))d$([math]::Floor(($sec%86400)/3600))h"
}
function Update-Ui {
  switch ($script:state) {
    'running' {
      $notify.Icon = $IcoRunning
      $h = $script:health
      $up = if ($h) { Fmt-Uptime([int]$h.uptimeSec) } else { '' }
      $run = if ($h) { [int]$h.runs.running } else { 0 }
      $mem = if ($h) { [int]$h.memoryMB.rss } else { 0 }
      # 端口口径（2026-08-21 老板指正）：这条状态行里的 `:端口` 是**给人看的「去哪儿看」**，所以显示
      # 控制台端口 $WebPort(4700)——托盘的「打开控制台」/双击/悬浮窗全都开这个地址。引擎端口 $Port(4800)
      # 是 API/健康检查的内部基址，只在**诊断语境**里露脸（无响应那行、状态气泡明细、tray.log、错误提示），
      # 别再拿它冒充「本系统的地址」。
      # 界面托管方要露脸：4700 挂在外部进程上时，用户有权知道「关掉那个终端界面就没了」。
      # 不露脸正是这次的病根——托盘静默旁观，故障现象（关窗口整个没了）与真凶（手工终端）看不出关系。
      $webTag = if ($script:webMonitorPid) { " · 界面⚠外部托管(PID $script:webMonitorPid)" } else { '' }
      $miStatus.Text = "● 运行中 · :$WebPort · 在跑 $run · 内存 ${mem}MB · 上线 $up$webTag"
      $t = "望子成龙小学 · 运行中 :$WebPort · 在跑$run · ${mem}MB" + $(if ($script:webMonitorPid) { ' · 界面外部托管' } else { '' })
      $notify.Text = if ($t.Length -gt 63) { $t.Substring(0, 63) } else { $t }
    }
    'starting' {
      $notify.Icon = $IcoStarting
      $miStatus.Text = '● 启动中…'
      $notify.Text = "望子成龙小学 · 启动中… :$WebPort"
    }
    'unhealthy' {
      $notify.Icon = $IcoError
      # 诊断语境：这里说的是**引擎进程**占着端口却不应答，端口必须是引擎的 $Port，不能换成控制台端口
      $miStatus.Text = "● 引擎进程在但无响应 · 引擎 :$Port"
      $notify.Text = '望子成龙小学 · 无响应'
    }
    default {
      $notify.Icon = $IcoStopped
      $miStatus.Text = '● 未启动'
      $notify.Text = '望子成龙小学 · 未启动'
    }
  }
  # 可管理 = 托盘自己拉起的进程存活，或监控模式下接管到了正在跑的服务 PID（两种都能停/重启）
  $owned = ($script:proc -and -not $script:proc.HasExited)
  # unhealthy 也必须可管理：卡顿/半死实例（占着端口不应答）正是最需要「停止/重启」接管清理的时候。
  # 原先只认 running，一旦被判 unhealthy 菜单就灰掉，用户只能去任务管理器手杀（2026-08-20 事故现场）。
  $manageable = $owned -or ($script:monitorPid -and ($script:state -eq 'running' -or $script:state -eq 'unhealthy'))
  $miStart.Enabled = -not $manageable
  $miStop.Enabled = $manageable
  $miRestart.Enabled = $manageable
}

function Show-StatusBalloon {
  $h = $script:health
  if ($script:state -eq 'running' -and $h) {
    # 气泡明细是诊断语境：控制台端口（去哪看）与引擎端口（API/健康检查）都点名，别只报一个让人误认
    # 托管方一栏：把「引擎/界面各自挂在谁身上」讲清楚。旧版只报端口，于是「关掉某个终端窗口界面就没了」
    # 这件事既看不出、也归不了因（2026-08-26 排查：4700 一直挂在手工终端的 pnpm preview 上）。
    $engHost = if ($script:proc -and -not $script:proc.HasExited) { '托盘托管' } elseif ($script:monitorPid) { "外部 PID $($script:monitorPid)（监控模式）" } else { '未知' }
    $webHost = if ($script:webMonitorPid) { "⚠ 外部 PID $($script:webMonitorPid) —— 关掉那个终端界面就会没，可「重启服务」让托盘接管" } elseif ($script:webproc -and -not $script:webproc.HasExited) { '托盘托管' } else { '未拉起' }
    $body = "控制台 :$WebPort · 引擎 :$($h.port) · PID $($h.pid)`n上线 $(Fmt-Uptime([int]$h.uptimeSec)) · 在跑 $($h.runs.running) / 存活会话 $($h.runs.live) / 历史 $($h.runs.total)`n内存 RSS $($h.memoryMB.rss)MB · 待审批 $($h.pendingPerms)`nNode $($h.node) · 版本 $($h.version)`n引擎托管：$engHost`n界面托管：$webHost"
    $notify.ShowBalloonTip(6000, '望子成龙小学 · 运行中', $body, 'Info')
  } elseif ($script:state -eq 'unhealthy') {
    $notify.ShowBalloonTip(5000, '望子成龙小学 · 无响应', "node 进程存活但 $BaseUrl/api/health 无回应，可能卡死，可尝试「重启服务」。", 'Warning')
  } else {
    $notify.ShowBalloonTip(4000, '望子成龙小学 · 未启动', "服务未运行。点「启动服务」拉起，控制台 $UiUrl（引擎 API 在 '$BaseUrl'）。", 'Info')
  }
}

# ---------- 心跳定时器：探活 + 崩溃自动重启（UI 线程，避免后台事件不触发的坑） ----------
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
  # 心跳留痕：每 ~5 分钟一行，把「托盘是什么时候没的」从 40 分钟的窗口收窄到 5 分钟（见文件头 ThreadException 那段病史）
  $script:tickN = ($script:tickN + 1)
  if (($script:tickN % 75) -eq 1) { Write-TrayLog ("心跳：state=$($script:state) 托管=$(if ($script:proc -and -not $script:proc.HasExited) { $script:proc.Id } else { '无' }) 监控=$(if ($script:monitorPid) { $script:monitorPid } else { '无' }) 内存=$([int]([System.Diagnostics.Process]::GetCurrentProcess().WorkingSet64/1MB))MB") }
  # ↓ Drain-Activations / Poll-Notifications 都做 WinRT/COM + HTTP，是本 Tick 里原先**唯一不在 try 之外**的两处；
  #   现在各自兜住：一次回执失手不该连累探活，更不该杀掉托盘（上面 ThreadException 是第二道网）。
  try { Drain-Activations } catch { Write-TrayLog ('Toast 回执处理失败（忽略本轮）：' + $_.Exception.Message) }   # 用户在 Toast 上点的「同意/拒绝/回复」
  # 1) 进程意外退出？
  if ($script:proc -and $script:proc.HasExited) {
    $code = try { $script:proc.ExitCode } catch { 'unknown' }
    $script:proc = $null
    $script:health = $null
    # 崩溃限流的判断搬到 Get-CrashRestartDecision（纯函数 + 9 条断言，tray/test/tray-logic.tests.ps1）。
    # ⚠ 实际语义是「**与上一次崩溃的间隔** ≤60s 才累计」，不是字面的「60s 内累计 5 次」——
    #   原注释这句写得不准，测试里已把真实语义钉死，别照旧注释去改。
    $crash = Get-CrashRestartDecision -UserStopped ([bool]$script:userStopped) -AutoRestart ([bool]$script:autoRestart) `
      -Restarts ([int]$script:restarts) -LastCrashAt $script:lastCrashAt -Now (Get-Date)
    $script:restarts = $crash.restarts
    $script:lastCrashAt = $crash.lastCrashAt
    if ($crash.action -eq 'user-stopped') {
      $script:state = 'stopped'
    } else {
      if ($crash.action -eq 'restart') {
        # 崩溃必留痕：退出码 + 第几次自动重启（原先只弹气泡不落盘，气泡一消失线索就没了）。
        # code=1 且端口另有其主 = 典型「替身撞 EADDRINUSE 自杀」，日志里一眼可辨。
        $owner = Get-PortOwnerPid $Port
        Write-TrayLog ("服务异常退出（code=$code），自动重启第 $($script:restarts) 次" + $(if ($owner -gt 0) { "；注意：端口 $Port 当前仍被 PID $owner 占着（本次多为撞端口自杀）" } else { '' }))
        $notify.ShowBalloonTip(4000, '望子成龙小学', "服务异常退出（code=$code），正在自动重启（第 $($script:restarts) 次）…", 'Warning')
        Update-Ui
        Start-Server
        return
      } else {
        $script:state = 'stopped'
        Write-TrayLog "服务已停止（code=$code）：自动重启达上限（$($script:restarts) 次）或已关闭，等待手动启动"
        $notify.ShowBalloonTip(6000, '望子成龙小学', "服务已停止（code=$code）。自动重启已达上限或被关闭，请查看错误日志后手动「启动服务」。", 'Error')
      }
    }
    Update-Ui
    return
  }

  # 2) 进程在跑（托盘托管），或监控模式（proc 为空但曾探到端口有服务）→ 探 /api/health
  $monitor = (-not $script:proc) -and ($script:state -eq 'running' -or $script:state -eq 'unhealthy')
  if (($script:proc -and -not $script:proc.HasExited) -or $monitor) {
    try {
      $h = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 3
      $script:health = $h
      if (-not $script:proc) { $script:monitorPid = try { [int]$h.pid } catch { $script:monitorPid } }   # 监控模式：持续记住被托管服务的 PID，供停止/重启接管
      $script:state = 'running'
      $script:restarts = 0
      $script:probeFails = 0
    } catch {
      # ★ 一次探活超时不算死：引擎忙一下（多会话流式 + jsonl 落盘 + 大响应压缩）就可能超时。
      #   要连续 3 次（≈12s）失败才认，且「端口还有没有主」由 TCP 监听表说话——端口仍被占就绝不拉替身、也绝不丢 PID。
      $script:probeFails++
      # 裁决搬到 Get-HealthProbeDecision（纯函数 + 7 条断言）。这是 §3.85 那次事故的判据本体，
      # 判错的代价是「引擎在忙被判死 → 拉替身撞 EADDRINUSE → 真引擎自杀 → 再判死…」，
      # 用户看到一串「服务异常退出」而引擎一直在正常干活。**端口有没有主只信 TCP 表**（三振之后才去问）。
      # 只有 takeover-start 那一支才真去问端口——前两振压根不该付这个代价。
      $ownerForDecision = if ($monitor -and $script:probeFails -ge 3) { Get-PortOwnerPid $Port } else { 0 }
      $hd = Get-HealthProbeDecision -Monitor $monitor -ProbeFails ([int]$script:probeFails) `
        -PortOwnerPid ([int]$ownerForDecision) -State ([string]$script:state)
      switch ($hd.action) {
        'wait' {
          Write-TrayLog "被监控服务探活失败（第 $($script:probeFails)/3 次，未判死）"
          $script:state = $hd.state; Update-Ui; return
        }
        'stuck-not-dead' {
          if ($script:monitorPid -ne $hd.newMonitorPid) { $script:monitorPid = $hd.newMonitorPid }
          Write-TrayLog "被监控服务连续 $($script:probeFails) 次探活失败，但端口 $Port 仍被 PID $($hd.newMonitorPid) 占着 → 判为卡顿而非退出，不拉替身（可右键「重启服务」接管清理）"
          $script:state = $hd.state; Update-Ui; return
        }
        'takeover-start' {
          Write-TrayLog "被监控的外部服务已停止（连续 $($script:probeFails) 次探活失败且端口 $Port 无监听），托盘接管拉起"
          $script:monitorPid = $null
          if ($hd.resetFails) { $script:probeFails = 0 }
          $script:state = $hd.state; Update-Ui; Start-Server; return
        }
        default {
          # 托盘自己托管：'starting' 维持不动（刚起进程 health 还没就绪），否则 unhealthy
          $script:state = $hd.state
        }
      }
    }
    Update-Ui
    # 服务健康时才拉通知 + 弹 Toast。函数内只兜住了 HTTP 那一句，后面 Show-ApprovalToast/Remove-Toast/
    # Show-StopToast 全是 WinRT COM，任何一处失手原先都会漏出 Tick 直接终结进程（无窗口 → 连报错都看不见）。
    if ($script:state -eq 'running') {
      # 报错必须带上失败时的输入（游标/基线），否则「每 4 秒一条同样的错」看不出是卡住还是偶发——
      # 这次就是靠 since 一直不动才判出 poison pill（同「假成功日志」那条教训：日志要说清是哪个输入炸的）。
      try { Poll-Notifications } catch { Write-TrayLog ("通知轮询失败（忽略本轮，不影响探活；since=$($script:notifySince) init=$($script:notifyInit)）：" + $_.Exception.Message) }
    }
  }
})
$timer.Start()

# ---------- 起步：拉起服务并进入消息循环 ----------
Start-Server
Update-Ui
Sync-FloatMenu   # 悬浮窗子菜单初始文案/勾选（置顶、半透明）随持久化配置定妥（此处所有函数已定义）
$notify.ShowBalloonTip(3000, '望子成龙小学', "托盘已就绪，新 UI $UiUrl · 引擎/旧 UI $BaseUrl（右键托盘图标管理）。", 'Info')

Write-TrayLog '托盘图标已就绪，进入消息循环'
$appContext = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($appContext)

# ★ 这一行是本次补上的关键证据（此前完全没有）：`Application.Run` 一返回就留痕。
#   有这行 = 消息循环自己退出的（正常「退出（并停服）」会先有「停服请求（用户操作）」，没有则是别的东西调了
#   Application.Exit / ExitThread）；**没有这行 = 进程被外部杀死或硬崩**。两者的修法完全不同，
#   而在补这行之前，59 次消失里 56 次两种可能无法区分（见文件头 ThreadException 那段病史）。
Write-TrayLog ('消息循环已返回（PID ' + $PID + '），托盘进入收尾')

# 消息循环退出后的收尾（正常走 Quit-Tray 已处理；这里兜底）
try { $notify.Visible = $false; $notify.Dispose() } catch {}
Write-TrayLog '托盘进程正常结束'
