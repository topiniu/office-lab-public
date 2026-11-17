// 本机文件动作：在文件管理器里定位、把文件本体放进系统剪贴板。
//
// 缘起：发布交付物（release SQL / RELEASE_CHECKLIST）要转发进企微，老板得单独开一次文件管理器
// 翻到那个目录再拖拽。lab 里明明已经把路径显示出来了，却只能「预览成文本」——差的就是这两个动作。
//
// 为什么走引擎而不是浏览器：浏览器打不开宿主机的文件管理器、也写不了「文件型剪贴板」（只能写文本）。
// 这两件事必须由跑在本机的引擎 spawn 系统命令完成。
//
// 为什么抽成模块：server.js 是单文件巨石，平台命令与本机判定是纯函数、值得单测（照 coverage.js /
// guard-ledger.js 的做法）。真正的 spawn 留在 server.js，这里只产出「该执行什么」。

import path from 'node:path'

// 回环地址集合。Node 的 remoteAddress 在双栈监听下会给出 IPv4-mapped 形式（::ffff:127.0.0.1）。
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'])

// 一跳地址是否回环。去掉 IPv6 方括号与端口尾巴（XFF 里偶尔会带）。
function isLoopback(addr) {
  let a = String(addr || '').trim()
  if (!a) return false
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']') > 0 ? a.indexOf(']') : undefined)
  else if (a.split(':').length === 2) a = a.split(':')[0]   // 'ip:port'（IPv6 冒号多于一个，不误伤）
  return LOOPBACK.has(a)
}

// 请求是否来自**本机浏览器**。
//
// ⚠ socket 层的 remoteAddress 单独不可信：4700 是 `vite preview`，/api 被代理到引擎 4800，
// 于是无论请求来自本机还是隧道外的手机，引擎看到的都是 127.0.0.1。真实客户端 IP 只能靠代理写的
// `x-forwarded-for` 首跳（web/vite.config.ts 的 proxy 已开 xfwd）。
// 判据：socket 是回环 **且**（没有 XFF，或 XFF 首跳也是回环）。缺 XFF 时保持旧行为（直连引擎 4800
// 的老 UI 照常可用）；XFF 存在就以它为准——远程访问必然带上它。
export function isLocalRequest({ remoteAddress, forwardedFor } = {}) {
  if (!isLoopback(remoteAddress)) return false
  const xff = String(forwardedFor || '').trim()
  if (!xff) return true
  return isLoopback(xff.split(',')[0])
}

// 在文件管理器里定位并选中该文件。返回 {cmd, args}；不支持的平台返回 null。
export function revealCommand(platform, abs) {
  if (!abs) return null
  switch (platform) {
    // ⚠ explorer 的参数必须是 `/select,<路径>` **整体一个 argv 项**（逗号紧贴路径，中间不能断开），
    //   拆成两项或加空格都会变成「只打开我的文档」。不走 shell → 路径里的空格/中文/& 不需要转义。
    //   另：explorer 即便成功也常以退出码 1 结束，**调用方不得据退出码判失败**。
    case 'win32': return { cmd: 'explorer.exe', args: ['/select,' + abs] }
    case 'darwin': return { cmd: 'open', args: ['-R', abs] }
    // Linux 没有通用的「定位并选中」，退而求其次开所在目录。
    default: return { cmd: 'xdg-open', args: [path.dirname(abs)] }
  }
}

// 直接打开**目录本身**（file 卡指向的是一个目录时，用户要看的是里面的东西，而不是在父目录里选中它）。
export function openDirCommand(platform, abs) {
  if (!abs) return null
  switch (platform) {
    case 'win32': return { cmd: 'explorer.exe', args: [abs] }
    case 'darwin': return { cmd: 'open', args: [abs] }
    default: return { cmd: 'xdg-open', args: [abs] }
  }
}

// 把刚弹出的文件管理器窗口**提到最前**。仅 Windows；其它平台返回 null（open -R 自带激活）。
//
// 缘起（2026-10-19 老板：「卡片里打开文件夹不 work」）：explorer 其实每次都开了（Shell.Windows 里能看到
// 同目录窗口一点一个），只是**开在浏览器后面**——Windows 的前台锁不许后台进程（引擎）抢焦点，新窗口只在
// 任务栏闪一下。用户看到的就是「点了没反应」。
// 解法：另起一个 powershell，等到该目录的资源管理器窗口出现，先发一次 Alt 键（解除本进程的前台锁，
// 业界通行做法），再 SetForegroundWindow；最小化的先还原。
// 选哪一扇窗：同目录可能已开着旧窗，所以先记下已有的 HWND，优先等**新出现**的那扇（≤1s）；
// explorer 复用了旧窗或在我们快照前就开好了，则退回最后一扇匹配窗（Shell.Windows 按创建顺序）。
// 这一步纯属体验增强：失败（超时/COM 异常）不影响 explorer 本身已打开，调用方不等它、不据它判成败。
export function focusRevealCommand(platform, dir) {
  if (!dir || platform !== 'win32') return null
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`
  const script = [
    `Add-Type -Namespace OL -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);'`,
    `$d = ${q(dir)}`,
    `$sh = New-Object -ComObject Shell.Application`,
    `function M { @($sh.Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq $d } catch { $false } } | ForEach-Object { [long]$_.HWND }) }`,
    `$old = M`,
    `$h = 0`,
    `for ($i = 0; $i -lt 10; $i++) { $n = @(M | Where-Object { $old -notcontains $_ }); if ($n.Count) { $h = $n[-1]; break }; Start-Sleep -Milliseconds 100 }`,
    `if (-not $h) { $all = M; if ($all.Count) { $h = $all[-1] } }`,
    `if ($h) { $p = [IntPtr]$h; if ([OL.W]::IsIconic($p)) { [void][OL.W]::ShowWindow($p, 9) }; [OL.W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [OL.W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero); [void][OL.W]::SetForegroundWindow($p) }`,
  ].join('\n')
  // ⚠ 必须走 -EncodedCommand（UTF-16LE → Base64），不能 `-Command <脚本>`（2026-10-20 实测）：脚本里有双引号
  //   （DllImport("user32.dll")），Node 拼命令行时转成 \"，powershell.exe 重新解析 -Command 时把路径里的反斜杠
  //   一并吃掉 → $d 变成 `D:WorkProjects…`，永远匹配不上窗口、退出码 0 静默失败（上一版置前因此从未生效）。
  //   Base64 不含引号/反斜杠/非 ASCII，中文目录也不受命令行代码页影响。
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
}

// 把**文件本体**放进系统剪贴板（不是路径文本）——这样在企微/邮件里直接 Ctrl+V 就是一个附件，
// 省掉「开文件管理器 → 找到 → 拖拽」整套动作。不支持的平台返回 null（前端据此隐藏按钮）。
//
// ⚠ 调用方**不得用 `detached: true` 起这条命令**（实测：detached 起的 powershell 退出码 0、
//   剪贴板纹丝不动——静默失败，界面还报成功）。定位见 spawn 处注释。
export function clipboardCommand(platform, abs) {
  if (!abs) return null
  switch (platform) {
    // ⚠ 整条命令**必须拼成一个字符串参数**：`-Command` 之后 PowerShell 会把剩余参数用空格连起来
    //   重新解析，拆成 ['Set-Clipboard','-LiteralPath',abs] 三项时，路径里只要有一个空格
    //   （`D:\Workspace\My Projects\x.sql`）就会被当成两个参数 → 命令解析失败、剪贴板悄悄没变。
    // -LiteralPath：路径按字面处理，不吃 [] ? * 等通配符（任务目录名里出现中括号是迟早的事）。
    //   PowerShell 单引号串里的转义只有 '' 一种。
    case 'win32': return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', `Set-Clipboard -LiteralPath '${String(abs).replace(/'/g, "''")}'`] }
    case 'darwin': return { cmd: 'osascript', args: ['-e', `set the clipboard to POSIX file ${JSON.stringify(abs)}`] }
    // Linux 下把文件塞剪贴板要看桌面环境（xclip/wl-copy + text/uri-list），没有可靠的通用做法 → 不做。
    default: return null
  }
}
