#!/usr/bin/env node
// office-lab 跨平台一条命令首启 —— `node scripts/bootstrap.mjs`（无需任何前置 install）。
//
// 缘起（2026-08-24）：老板要求「仓库搬到其他电脑能开箱即用」。原先做不到，且文档还写反了——
// README.md / app/README.md 都声称「零依赖，无需 npm install」，但 server.js 顶层 import 了
// @anthropic-ai/claude-agent-sdk 与 zod，而 app/node_modules 未入库 → 全新 clone 上 `node server.js`
// 直接 module-not-found。新 UI 还需 pnpm install，而托盘脚本只在 web/dist 缺失时 build、从不 install。
//
// 设计要点：
//   · 纯 Node 内置模块、零依赖、.mjs 强制 ESM（不受仓根 package.json 的 type 影响）。
//   · **分级降级**：只有「引擎起不来」才硬失败；新 UI、浏览器、凭据一律只告警不阻塞。
//     旧 UI（app/public）已入库、免构建、且覆盖 push/zhuzhu/wecom/lark/mirror 五个配置面板，
//     是「总能跑起来」的兜底主路径。
//   · 每步幂等，重复跑安全。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const OFFICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_DIR = path.join(OFFICE_ROOT, 'app')
const WEB_DIR = path.join(OFFICE_ROOT, 'web')
const IS_WIN = process.platform === 'win32'

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const FLAGS = {
  doctor: has('--doctor'),
  noWeb: has('--no-web'),
  noOpen: has('--no-open'),
  startOnly: has('--start-only'),   // 跳过安装/构建，直接起（已装好时最快）
  port: String(valOf('--port', process.env.OFFICE_LAB_PORT || '4800')),
}
if (has('--help') || has('-h')) {
  console.log(`用法: node scripts/bootstrap.mjs [选项]

  （无选项）      检查依赖 → 按需安装 → 构建新 UI → 起引擎 → 开浏览器
  --doctor        只体检、不装不起（排查环境问题用）
  --start-only    跳过安装与构建，直接起引擎
  --no-web        不碰新 UI（只用已入库、免构建的旧 UI）
  --no-open       不自动开浏览器
  --port <N>      引擎端口（默认 4800，或环境变量 OFFICE_LAB_PORT）
`)
  process.exit(0)
}

// ---------- 输出 ----------
const C = process.stdout.isTTY && !process.env.NO_COLOR
const c = (n, s) => (C ? `\x1b[${n}m${s}\x1b[0m` : s)
const step = (n, s) => console.log(`\n${c(36, `[${n}]`)} ${c(1, s)}`)
const ok = (s) => console.log(`  ${c(32, '✓')} ${s}`)
const warn = (s) => console.log(`  ${c(33, '!')} ${s}`)
const info = (s) => console.log(`    ${c(90, s)}`)
const fail = (s, hint) => {
  console.error(`\n${c(31, '✗ 起不来：')}${s}`)
  if (hint) console.error(hint.split('\n').map(l => '  ' + l).join('\n'))
  process.exit(1)
}

// ---------- 子进程 ----------
// Windows 上 npm/pnpm/corepack 都是 .cmd 批处理。Node 20.12+ 起（CVE-2024-27980 的修复）**不带 shell 直接
// spawn .cmd 会抛 EINVAL**，不带后缀则 ENOENT —— 两条路都不通，必须 shell:true。这条是自测时踩出来的：
// 本机明明有 corepack 0.33.0，脚本却报「没有可用的 pnpm」。
// 注意：走 shell 后参数会被拼成命令行，故本文件传给这些命令的参数一律不含空格（路径只经 cwd 传，不进 argv）。
// Windows 走 shell 时**把命令拼成单串、不传 args 数组**：传数组会触发 Node 的 DEP0190 弃用告警
// （shell 下参数只拼接不转义）。拼串安全的前提正是上面那条约束——本文件的参数一律不含空格。
const binName = (n) => n
function winShell(cmd, args) { return [cmd, ...args].join(' ') }
function runSync(cmd, args, opts = {}) {
  const r = IS_WIN
    ? spawnSync(winShell(cmd, args), { encoding: 'utf8', windowsHide: true, shell: true, ...opts })
    : spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), err: r.error }
}
function runLive(cmd, args, opts = {}) {
  const r = IS_WIN
    ? spawnSync(winShell(cmd, args), { stdio: 'inherit', windowsHide: true, shell: true, ...opts })
    : spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts })
  return r.status === 0
}
const probe = (cmd, args = ['-v']) => { const r = runSync(cmd, args); return r.code === 0 ? (r.out.split('\n')[0] || '').trim() : null }

// ---------- 0. 部署形态 ----------
step(0, '部署形态')
let paths = null
try {
  paths = await import(path.join(APP_DIR, 'paths.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'))
  ok(paths.describeWorkspace())
  if (paths.WORKSPACE_MODE === 'standalone') info('独立部署：员工的工作树 = 本仓根，兄弟仓相关能力（后端构建/发布枚举/UI 契约）自动跳过')
  else info('monorepo 嵌套：员工的工作树 = 上级目录，兄弟仓能力可用')
} catch (e) {
  warn(`读不到 app/paths.js（${e?.message || e}）——不影响启动，继续`)
}

// ---------- 1. Node 版本闸 ----------
step(1, 'Node 版本')
const [NMAJ, NMIN] = process.versions.node.split('.').map(Number)
if (NMAJ < 18) {
  fail(`当前 Node ${process.versions.node}，引擎要求 18+。`,
    '装个 Node 20 LTS 或更新版本再来：\n  https://nodejs.org/  （或 nvm / fnm / volta 任选）')
}
ok(`Node ${process.versions.node}（${process.platform}-${process.arch}）`)
// vite 8 要求 ^20.19 || >=22.12；不够就只跑旧 UI，别让新 UI 构建把首启拖死
let webAllowed = !FLAGS.noWeb
if (webAllowed && (NMAJ < 20 || (NMAJ === 20 && NMIN < 19) || (NMAJ === 21) || (NMAJ === 22 && NMIN < 12))) {
  warn(`Node ${process.versions.node} 构建不了新 UI（vite 需 ^20.19 或 >=22.12）→ 本次只用旧 UI`)
  webAllowed = false
}

// ---------- 2. 仓库完整性 ----------
// 这一步是「clone 到别的机器能不能用」的第一道闸，缘起是本轮自测的实测事故：真 clone 一份后发现
// app/ui-contract.js 与 app/e2e-batch.js **从来没被提交过**（不是被 .gitignore 忽略，是漏 add），
// 而 server.js 顶层就 import 它们 → 全新 clone 上 `node server.js` 直接 ERR_MODULE_NOT_FOUND。
// 同批还漏了 10 个 web/src 模块（dispatch.ts 被 11 个文件引用）→ 新 UI 构建必失败。
// 这类「本机有、库里没有」的漏网文件，只有真 clone 一次才发现得了。故做成两个方向的自检：
//   · 任何机器：server.js 的本地 import 是否都在 → 缺就硬失败，并直说"这是仓库不完整，不是你环境的问题"。
//   · 源机器（有 git）：列出「被引用却未入库」的文件 → 提醒交付前先提交，别让对面 clone 到一个残缺仓。
step(2, '仓库完整性')
{
  const src = fs.readFileSync(path.join(APP_DIR, 'server.js'), 'utf8')
  const localImports = [...src.matchAll(/^import\s+.*?\bfrom\s+'\.\/([^']+)'/gm)].map(m => m[1])
  const absent = localImports.filter(f => !fs.existsSync(path.join(APP_DIR, f)))
  if (absent.length) {
    fail(`app/server.js 要 import 的本地模块缺了：${absent.join('、')}`,
      `**这是仓库本身不完整，不是你的环境问题** —— 这些文件在源机器上存在、但没被提交进 git。\n` +
      `请让仓库维护者在源机器上执行：\n  git add ${absent.map(f => `app/${f}`).join(' ')}\n  git commit\n然后你重新 pull / clone。`)
  }
  ok(`server.js 的 ${localImports.length} 个本地模块齐备`)

  // 源机器自检（非 git 仓 / 无 git 命令则静默跳过）
  const g = runSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: OFFICE_ROOT })
  if (g.code === 0 && g.out.trim() === 'true') {
    // -c core.quotepath=false：否则中文文件名会被 git 转义成 \345\267\245… 的八进制串，列出来没人看得懂
    const st = runSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall'], { cwd: OFFICE_ROOT })
    if (st.code === 0) {
      const untracked = st.out.split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3).replace(/^"|"$/g, ''))
      // 只挑「代码/用例/看板数据」这三类会真影响对面可用性的，其余（草稿、调试残渣）不啰嗦
      const risky = untracked.filter(f => /^app\/.*\.(js|mjs)$/.test(f) || /^web\/src\//.test(f) || /^scripts\//.test(f) || /^tasks\/.*\.md$/.test(f) || /^templates\/.*\.md$/.test(f))
      if (risky.length) {
        warn(`有 ${risky.length} 个文件在本机存在但**未入库** —— 别人 clone 会缺，交付前先提交`)
        for (const f of risky.slice(0, 12)) info('· ' + f)
        if (risky.length > 12) info(`· …另有 ${risky.length - 12} 个`)
        info('（本机自己跑不受影响；这条是给"要把仓交出去"的人看的）')
      } else ok('没有「被引用却未入库」的代码/用例/看板文件')
    }
  }
}

// ---------- 3. 引擎依赖 ----------
step(3, '引擎依赖（app/）')
let selectedEngine = 'claude', codexCommand = 'codex'
try {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.OFFICE_LAB_RUNS_DIR || path.join(APP_DIR, 'runs'), 'engine-config.json'), 'utf8'))
  selectedEngine = config.defaultEngine || selectedEngine
  codexCommand = config.providers?.codex?.command || codexCommand
} catch (error) { if (error.code !== 'ENOENT') warn(`引擎配置读取失败：${error.message}`) }
info(`新会话默认引擎：${selectedEngine}`)
const NEED = selectedEngine === 'claude' ? ['@anthropic-ai/claude-agent-sdk', 'zod'] : ['zod']
const missing = () => NEED.filter(m => !fs.existsSync(path.join(APP_DIR, 'node_modules', ...m.split('/'))))
let lack = missing()
if (!lack.length) ok('已就位：' + NEED.join('、'))
else if (FLAGS.doctor || FLAGS.startOnly) warn('缺：' + lack.join('、') + (FLAGS.doctor ? '（--doctor 不安装）' : '（--start-only 不安装）'))
else {
  info('缺 ' + lack.join('、') + '，安装中（首次约需 1 分钟）…')
  const npm = binName('npm')
  const lock = fs.existsSync(path.join(APP_DIR, 'package-lock.json'))
  let done = lock && runLive(npm, ['ci', '--no-audit', '--no-fund'], { cwd: APP_DIR })
  if (!done) {
    if (lock) warn('npm ci 失败，退回 npm install')
    done = runLive(npm, ['install', '--no-audit', '--no-fund'], { cwd: APP_DIR })
  }
  lack = missing()
  if (!done || lack.length) {
    fail(`引擎依赖没装上（缺 ${lack.join('、') || '未知'}）。`,
      `手动跑一遍看报什么错：\n  cd "${APP_DIR}"\n  npm ci\n\n常见原因：没网 / 需要代理 / npm registry 不可达。\n配代理示例：npm config set proxy http://<host>:<port>`)
  }
  ok('依赖安装完成')
}

// ---------- 4. SDK 平台二进制 ----------
step(4, 'SDK 平台二进制')
const plat = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const platDir = path.join(APP_DIR, 'node_modules', ...plat.split('/'))
// musl 变体（Alpine 等）名字带 -musl，装的是哪个由 npm 依 libc 决定，这里两种都认
const platAny = fs.existsSync(platDir) || fs.existsSync(platDir + '-musl')
if (platAny) ok(plat.split('/').pop())
else if (selectedEngine !== 'claude' || lack.length || FLAGS.doctor || FLAGS.startOnly) warn(`未见 ${plat}（只影响 Claude 会话）`)
else {
  fail(`缺 SDK 的平台二进制 ${plat}（没有它拉不起员工）。`,
    `多半是安装时带了 --omit=optional。重装一次：\n  cd "${APP_DIR}"\n  npm ci --include=optional`)
}

// ---------- 5. Claude 凭据（尽力而为的提示，绝不下断言、绝不阻塞）----------
// ⚠ 这一步刻意**不判定"没有凭据"**：SDK 的登录态在 macOS/Windows 上存在系统钥匙串 / 凭据管理器里，
// 不是文件（本机实测 ~/.claude/ 下根本没有 .credentials.json，可派工完全正常）。早期版本按文件存在与否
// 报「没找到任何 Claude 凭据」，在这台机器上就是纯误报、只会吓人。故：能确认就确认，不能确认就说不能确认。
step(5, '引擎凭据与可执行文件')
if (selectedEngine === 'codex') {
  const check = spawnSync(codexCommand, ['--version'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000 })
  if (check.status === 0) ok(check.stdout.trim())
  else warn('Codex 无法启动；在 Agent 基座设置填写可执行文件路径（Windows 使用 codex.exe），并在本机完成登录。')
  info('实际连通性：node scripts/check-engine.mjs codex --live；不会修改业务文件。')
} else {
const CFG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
if (process.env.ANTHROPIC_API_KEY) ok('环境变量 ANTHROPIC_API_KEY')
else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) ok('环境变量 CLAUDE_CODE_OAUTH_TOKEN')
else if (fs.existsSync(path.join(CFG_DIR, '.credentials.json'))) ok(`宿主机登录态（${CFG_DIR}`.concat('/.credentials.json）'))
else if (fs.existsSync(CFG_DIR) || fs.existsSync(path.join(os.homedir(), '.claude.json'))) {
  ok('本机装过 Claude Code —— 登录态多半就绪')
  info('（登录态可能存在系统钥匙串/凭据管理器里，脚本查不到文件，这里不下断言。真没登录的话第一次派工会失败。）')
} else {
  warn('本机看不出装过 Claude Code —— 看板能打开，但派工可能失败')
  info('二选一：① 装 Claude Code 并登录一次   ② 设环境变量 ANTHROPIC_API_KEY=sk-ant-…')
  info('本仓不含任何凭据，这一步只能在本机做一次。')
}

}
// ---------- 6. 新 UI（尽力而为，绝不阻塞）----------
step(6, '新 UI（web/）')
let webReady = fs.existsSync(path.join(WEB_DIR, 'dist', 'index.html'))
let pm = null   // [命令, 前置参数]
if (!webAllowed) warn('已跳过（' + (FLAGS.noWeb ? '--no-web' : 'Node 版本不够') + '）→ 用旧 UI')
else if (!fs.existsSync(WEB_DIR)) warn('web/ 不存在 → 用旧 UI')
else {
  // 包管理器三级择一：直装的 pnpm → corepack 代跑 → npm exec 临时拉一个
  const v = probe(binName('pnpm'))
  if (v) { pm = [binName('pnpm'), []]; ok(`pnpm ${v}`) }
  else {
    const cv = probe(binName('corepack'), ['--version'])
    if (cv) {
      process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
      if (probe(binName('corepack'), ['pnpm', '-v'])) { pm = [binName('corepack'), ['pnpm']]; ok(`corepack ${cv} 代跑 pnpm`) }
    }
    if (!pm && probe(binName('npm'), ['-v'])) {
      if (probe(binName('npm'), ['exec', '-y', 'pnpm@10', '--', '-v'])) { pm = [binName('npm'), ['exec', '-y', 'pnpm@10', '--']]; ok('npm exec pnpm@10') }
    }
  }
  if (!pm) { warn('本机没有可用的 pnpm（也没有 corepack / npm exec 能代跑）→ 跳过新 UI，用旧 UI') }
  else if (FLAGS.startOnly && webReady) ok('web/dist 已就绪（--start-only 不重建）')
  else if (FLAGS.doctor) info('（--doctor 不安装不构建）')
  else {
    try {
      const [cmd, pre] = pm
      if (!fs.existsSync(path.join(WEB_DIR, 'node_modules'))) {
        info('装新 UI 依赖（首次约需 1~3 分钟）…')
        if (!runLive(cmd, [...pre, 'install', '--frozen-lockfile'], { cwd: WEB_DIR })) {
          warn('--frozen-lockfile 失败，退回普通 install')
          if (!runLive(cmd, [...pre, 'install'], { cwd: WEB_DIR })) throw new Error('pnpm install 失败')
        }
      }
      if (!webReady) {
        info('构建 web/dist…')
        if (!runLive(cmd, [...pre, 'build'], { cwd: WEB_DIR })) {
          warn('pnpm build 失败，跳过类型检查再试一次（vite build）')
          if (!runLive(cmd, [...pre, 'exec', 'vite', 'build'], { cwd: WEB_DIR })) throw new Error('构建失败')
        }
        webReady = fs.existsSync(path.join(WEB_DIR, 'dist', 'index.html'))
      }
      if (webReady) ok('web/dist 就绪')
      else throw new Error('构建后仍无 dist/index.html')
    } catch (e) {
      webReady = false
      warn(`新 UI 不可用（${e?.message || e}）→ 已回落旧 UI，功能不缺（仅「企微表格降级」设置页只在新 UI）`)
      info(`想手动修：cd "${WEB_DIR}" && pnpm install && pnpm build`)
    }
  }
}

if (FLAGS.doctor) {
  console.log(`\n${c(36, '体检完毕')}（--doctor 不启动任何进程）`)
  process.exit(0)
}

// ---------- 7~10. 起服务 ----------
const children = []
let shuttingDown = false        // Ctrl+C / SIGTERM 是**我们自己**在收摊，别把随之而来的子进程退出当故障报
const spawnBg = (cmd, args, opts) => { const p = spawn(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts }); children.push(p); return p }
const killAll = () => { for (const p of children) { try { p.kill() } catch { } } }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { shuttingDown = true; killAll(); process.exit(0) })
process.on('exit', killAll)

const ENGINE = `http://127.0.0.1:${FLAGS.port}`
async function waitHealthy(url, ms = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

step(7, '起引擎')
const engine = spawnBg(process.execPath, ['server.js'], { cwd: APP_DIR, env: { ...process.env, OFFICE_LAB_PORT: FLAGS.port } })
engine.on('exit', (code, sig) => {
  if (shuttingDown || sig) return                      // 我们自己 kill 的（Ctrl+C / 被上层 SIGTERM）→ 静默收摊
  if (code) { console.error(c(31, `\n引擎退出（code=${code}）——原因见上方引擎日志（端口被占用最常见）`)); process.exit(code) }
})

step(8, '等引擎就绪')
if (!await waitHealthy(`${ENGINE}/api/health`)) {
  console.error(c(31, `\n等了 40 秒 ${ENGINE}/api/health 还没应答。引擎日志见上方；常见原因：端口 ${FLAGS.port} 被占用。`))
  console.error(`  换个端口再试：node scripts/bootstrap.mjs --port 4801`)
  killAll(); process.exit(1)
}
ok(`引擎在 ${ENGINE}`)

let uiUrl = ENGINE
if (webReady && pm) {
  step(8, '起新 UI')
  const [cmd, pre] = pm
  spawnBg(cmd, [...pre, 'preview', '--port', '4700', '--strictPort'], { cwd: WEB_DIR, env: { ...process.env, OFFICE_LAB_API_TARGET: process.env.OFFICE_LAB_API_TARGET || ENGINE } })
  if (await waitHealthy('http://127.0.0.1:4700', 20000)) { uiUrl = 'http://127.0.0.1:4700'; ok('新 UI 在 http://127.0.0.1:4700') }
  else warn('新 UI 没起来 → 用旧 UI ' + ENGINE)
}

if (!FLAGS.noOpen) {
  step(9, '打开浏览器')
  try {
    if (IS_WIN) spawn('cmd', ['/c', 'start', '', uiUrl], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else if (process.platform === 'darwin') spawn('open', [uiUrl], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [uiUrl], { detached: true, stdio: 'ignore' }).unref()
    ok(uiUrl)
  } catch { warn('开不了浏览器，自己点：' + uiUrl) }
}

console.log(`\n${c(32, '🏢 望子成龙小学已启动')} → ${c(1, uiUrl)}`)
console.log(c(90, '   外部集成的功能开关沿用原版，请在界面「设置」中填写自己的连接信息。'))
console.log(c(90, '   Ctrl+C 停止。'))
