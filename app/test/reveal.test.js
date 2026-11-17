import test from 'node:test'
import assert from 'node:assert/strict'
import { isLocalRequest, revealCommand, clipboardCommand, focusRevealCommand } from '../reveal.js'

// ---------- 本机判定 ----------
test('直连引擎：socket 回环即本机（IPv4 / IPv6 / v4-mapped 都认）', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLocalRequest({ remoteAddress: a }), true, a)
  }
})
test('局域网/公网直连 → 非本机', () => {
  assert.equal(isLocalRequest({ remoteAddress: '192.0.2.143' }), false)
  assert.equal(isLocalRequest({ remoteAddress: '192.0.2.7' }), false)   // Tailscale
  assert.equal(isLocalRequest({}), false)
})
// 这条是整个鉴权的命门：4700 的 vite preview 把 /api 代理到 4800，socket 永远是回环，
// 只看 socket 等于对隧道外的手机也放行。
test('**经 4700 代理：socket 回环但 XFF 首跳是远端 → 判非本机**', () => {
  assert.equal(isLocalRequest({ remoteAddress: '127.0.0.1', forwardedFor: '192.0.2.20' }), false)
  assert.equal(isLocalRequest({ remoteAddress: '::ffff:127.0.0.1', forwardedFor: '192.0.2.7, 127.0.0.1' }), false)
})
test('经代理但 XFF 首跳也是回环（本机浏览器打 4700）→ 本机', () => {
  assert.equal(isLocalRequest({ remoteAddress: '127.0.0.1', forwardedFor: '127.0.0.1' }), true)
  assert.equal(isLocalRequest({ remoteAddress: '127.0.0.1', forwardedFor: '::1' }), true)
})
test('XFF 带端口 / IPv6 方括号形态不误判', () => {
  assert.equal(isLocalRequest({ remoteAddress: '127.0.0.1', forwardedFor: '127.0.0.1:53211' }), true)
  assert.equal(isLocalRequest({ remoteAddress: '127.0.0.1', forwardedFor: '[::1]' }), true)
  assert.equal(isLocalRequest({ remoteAddress: '127.0.0.1', forwardedFor: '192.0.2.20:8080' }), false)
})

// ---------- 文件管理器定位 ----------
// explorer 的参数必须是 `/select,<路径>` **同一个 argv 项**——拆成两项或中间加空格，
// 结果是「只打开我的文档」而不是定位到那个文件。
test('**win32：`/select,` 与路径必须黏在同一个 argv 项里**', () => {
  const c = revealCommand('win32', 'D:\\Workspace\\Projects\\office-lab\\CHANGELOG.md')
  assert.equal(c.cmd, 'explorer.exe')
  assert.deepEqual(c.args, ['/select,D:\\Workspace\\Projects\\office-lab\\CHANGELOG.md'])
})
test('win32：路径含空格与中文也不做任何转义（不走 shell）', () => {
  const c = revealCommand('win32', 'D:\\Workspace\\示例项目 需求\\V1__x.sql')
  assert.deepEqual(c.args, ['/select,D:\\Workspace\\示例项目 需求\\V1__x.sql'])
})
test('darwin 用 open -R 定位；linux 没有通用「定位」→ 退回开所在目录', () => {
  assert.deepEqual(revealCommand('darwin', '/a/b/c.sql'), { cmd: 'open', args: ['-R', '/a/b/c.sql'] })
  const l = revealCommand('linux', '/a/b/c.sql')
  assert.equal(l.cmd, 'xdg-open')
  assert.equal(l.args[0].replace(/\\/g, '/'), '/a/b')
})
test('没有路径 → null（调用方据此回错，不要 spawn 一个空参数的 explorer）', () => {
  assert.equal(revealCommand('win32', ''), null)
  assert.equal(clipboardCommand('win32', ''), null)
})

// ---------- 文件塞剪贴板 ----------
test('win32 用 Set-Clipboard -LiteralPath（字面路径，不吃通配符）', () => {
  const c = clipboardCommand('win32', 'D:\\a\\[v5.21]\\x.sql')
  assert.equal(c.cmd, 'powershell.exe')
  assert.ok(c.args.includes('-NoProfile'))
  const cmd = c.args[c.args.length - 1]
  assert.match(cmd, /-LiteralPath/, '必须是 -LiteralPath，-Path 会把 [] 当通配符')
  assert.equal(cmd, "Set-Clipboard -LiteralPath 'D:\\a\\[v5.21]\\x.sql'")
})
// `-Command` 之后 PowerShell 把剩余参数用空格连起来重新解析：拆成多项时，路径里一个空格就把命令
// 拆错、剪贴板悄悄没变。必须是「一整条命令字符串 + 单引号包路径」。
test('**win32：整条命令是单个参数，带空格的路径不会被拆断**', () => {
  const c = clipboardCommand('win32', 'D:\\Workspace\\My Projects\\示例项目 v5.21.sql')
  assert.equal(c.args.length, 4, '-NoProfile/-NonInteractive/-Command/<整条命令> 共 4 项')
  assert.equal(c.args[3], "Set-Clipboard -LiteralPath 'D:\\Workspace\\My Projects\\示例项目 v5.21.sql'")
})
test('win32：路径里的单引号按 PowerShell 规矩转义成两个', () => {
  const c = clipboardCommand('win32', "D:\\a\\it's.sql")
  assert.equal(c.args[3], "Set-Clipboard -LiteralPath 'D:\\a\\it''s.sql'")
})
test('darwin 走 osascript 的 POSIX file', () => {
  const c = clipboardCommand('darwin', '/a/b.sql')
  assert.equal(c.cmd, 'osascript')
  assert.match(c.args[1], /POSIX file "\/a\/b\.sql"/)
})
test('linux 不支持文件型剪贴板 → null（前端据此隐藏按钮，而不是报一个假成功）', () => {
  assert.equal(clipboardCommand('linux', '/a/b.sql'), null)
})

// ---------- 定位后把窗口提到最前 ----------
test('win32：整段脚本是 -Command 后的单个参数，目录按 PS 单引号字面量嵌入（单引号转义成两个）', () => {
  const c = focusRevealCommand('win32', "D:\\Workspace\\示例项目 需求\\o'k")
  assert.equal(c.cmd, 'powershell.exe')
  assert.equal(c.args.length, 4)
  // 走 -EncodedCommand：Base64 里没有会被命令行转义的字符（-Command 传原文时反斜杠被吃、窗口永远匹配不上）
  assert.equal(c.args[2], '-EncodedCommand')
  assert.match(c.args[3], /^[A-Za-z0-9+/=]+$/)
  const script = Buffer.from(c.args[3], 'base64').toString('utf16le')
  assert.ok(script.includes("$d = 'D:\\Workspace\\示例项目 需求\\o''k'"))
  assert.match(script, /SetForegroundWindow/)
})
test('非 Windows / 空目录不需要置前 → null', () => {
  assert.equal(focusRevealCommand('darwin', '/a/b'), null)
  assert.equal(focusRevealCommand('linux', '/a/b'), null)
  assert.equal(focusRevealCommand('win32', ''), null)
})
