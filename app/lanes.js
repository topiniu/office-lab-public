// 工作区（lane）：一条需求/版本 = 一组 git worktree（后端 + 前端）+ 一个端口槽位 + 绑定的任务档案。
//
// 缘起（2026-09-28，老板：「lab 支持同时开发多需求了，加速一下 worktree 的应用」）：
// 并行开发早就发生了——v0.1.3 通知管理占着主检出做人工预检，Temu v0.1.0 由 GG Bond 手工开了
// `../.worktrees/temu-{be,fe}` + 旁路端口 8002/18040/18042。但这套做法只存在于员工记忆里：
//   · 旁路端口、`--xxl.job.executor.port`/`server-url` 覆盖、`package` 不 `install`、前端 junction 复用
//     node_modules、重打包前先停进程（memories/ggbond.md 2026-09-24 两条）；
//   · `git worktree add` 相对路径会建进仓库里（memories/bobby.md）；
//   · 前端代理写死在 `.umirc.test.ts` 的 8042 → 只能改被跟踪文件并备注「勿提交」。
// 引擎侧 rebuild_restart_backend / backend_status 只认主检出 8040/8041/8042，handoffFreeze.worktreePlan
// 只打印命令不建树；迷糊按红线 10 不做环境预检、入口写死 localhost:8000 —— 两个版本并行时她没有任何
// 途径知道 8000 上跑的是哪一版。
//
// 本模块把上面这些收成一等公民：
//   ① 注册表 runs/lanes.json（唯一事实源）：lane = { id, title, version, taskFile, slot, repos{key:{path,branch}} }；
//      主检出是虚拟的 `main` lane（slot 0，不入库、不可删）。
//   ② 端口槽位：slot k 的端口 = 主检出端口按固定步长平移（见 portsForSlot）。slot 1 恰好等于 Temu 手工用的那组。
//   ③ 建树/收树：绝对路径、分支命名、--no-track、node_modules junction、.umirc.local.ts 代理覆盖（gitignored，
//      不再动被跟踪文件）；收树前查脏/未推送、先拆 junction（别让递归删除顺着 junction 删掉主检出的 node_modules）。
//   ④ 起停：复用仓根 manage-backend.sh / manage-frontend.ps1（加了 PORT_OFFSET/RUN_TAG/SHARED_BUILD 等向后兼容覆盖），
//      detached 异步 + .done 退出码文件判终态（与 rebuild_restart_backend 同一套路，跨平台、不靠 PID 探活）。
//   ⑤ 状态：端口探活（TCP connect）+ 各树分支/HEAD/脏 + 后端「构建新鲜度」（HEAD vs 上次成功构建的 sha）。
//
// 刻意不做：不自动删分支（分支是交付物）、不 force 删树、不替员工决定「这条需求该不该开 lane」。
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'

export const MAIN_LANE_ID = 'main'
export const MAX_SLOT = 3                 // 一个后端 lane ≈ 2~3 个 JVM（每个 -Xmx2048m），本机同时 3 条旁路已是上限
export const WORKTREE_DIR = '.worktrees'  // 相对工作区根；与 Temu 手工开的 ../.worktrees/temu-* 同处
export const BRANCH_SUFFIX = '-lab'     // monorepo 分支命名：feature/<version>-<feature>-lab
export const MARK = 'office-lab lane'     // 引擎生成文件的标记（.umirc.local.ts）：只覆盖带标记的，手写的不碰

// 仓库：key → 主检出目录（相对工作区根）。worktree 目录名 = `<laneId>-<suffix>`。
// ownNodeModules：前端不 junction 复用主检出的 node_modules，首次起服务时在工作树里自己 install——
// 2026-10-07 Temu 迁移实撞：component-center 主检出的 node_modules 比 release 旧（缺 release 新加的 i18next），junction 过去 dev 直接编不过。
export const REPOS = {
  backend: { dir: 'backend', label: '后端', suffix: 'be' },
  'fe-supplier': { dir: 'frontend/web-app', label: 'GYS 前端', suffix: 'fe', app: 'web-app' },
  'fe-cj': { dir: 'frontend/partner-app', label: '供应商前端', suffix: 'fecj', app: 'partner-app' },
  // 2026-10-08 老板「要加一下对新项目的支持」：批量管理迁出供应商项目后落在这两个仓
  iwo: { dir: 'auxiliary-web-workspace', label: '独立站工程（auxiliary-api + 跨境管理中台）', suffix: 'iwo', ownNodeModules: true },
  'fe-cc': { dir: 'frontend/component-center', label: '组件中心前端', suffix: 'cc', ownNodeModules: true },
}
// 可起停的服务：主检出端口 base，每个槽位平移 step。前端 step=2（8000/8001 → 8002/8003…，两个 app 不互撞），
// 后端 step=10000（8040 → 18040…，与 Temu 手工口径一致；xxl executor 9981 同步平移）。
// runner：不走仓根 manage-backend.sh / manage-frontend.ps1（那两个脚本只认供应商三仓），由本模块 customCommand 拼命令。
// step=0：端口被被跟踪的配置写死、不能平移（component-center 的 .umirc.test.ts 固定 8899，publicPath 也拼它）——同一时间只能一个工作区起它。
export const SERVICES = {
  'fe-supplier': { repo: 'fe-supplier', kind: 'fe', base: 8000, step: 2, label: 'GYS 前端' },
  'fe-cj': { repo: 'fe-cj', kind: 'fe', base: 8001, step: 2, label: '供应商前端' },
  service: { repo: 'backend', kind: 'be', base: 8040, step: 10000, label: 'service' },
  web: { repo: 'backend', kind: 'be', base: 8041, step: 10000, label: 'web' },
  'gys-web': { repo: 'backend', kind: 'be', base: 8042, step: 10000, label: 'gys-web' },
  cba: { repo: 'iwo', kind: 'be', runner: 'cba', base: 8097, step: 10000, label: 'auxiliary-api', env: { REDIS_HOST: '127.0.0.1' } },
  kjglzt: { repo: 'iwo', kind: 'fe', runner: 'kjglzt', base: 8106, step: 2, label: '跨境管理中台' },
  cc: { repo: 'fe-cc', kind: 'fe', runner: 'cc', base: 8899, step: 0, label: '组件中心' },
}
const BE_SERVICES = Object.keys(SERVICES).filter(k => SERVICES[k].kind === 'be')
export const BACKEND_OFFSET_STEP = 10000

// ---------- 纯函数（有单测） ----------

export function portsForSlot(slot) {
  const k = Number(slot) || 0
  const out = {}
  for (const [key, s] of Object.entries(SERVICES)) out[key] = s.base + s.step * k
  out.xxl = 9981 + BACKEND_OFFSET_STEP * k
  return out
}

// lane id：小写字母数字与连字符，2~32 位，不许撞 main。用作目录名/RUN_TAG/URL 段，所以卡得严。
export function normalizeLaneId(raw) {
  const id = String(raw || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '')
  if (id.length < 2 || id.length > 32) return { ok: false, error: `工作区 id 需 2~32 位小写字母/数字/连字符（收到「${raw}」）` }
  if (id === MAIN_LANE_ID) return { ok: false, error: '「main」是主检出的保留名' }
  return { ok: true, id }
}

// 分支 → 人看的短名：去掉 feature/|hotfix/ 前缀与 -lab 后缀（`feature/0.1.3-通知管理-lab` → `0.1.3-通知管理`）
export function branchLabel(branch) {
  return String(branch || '').replace(/^(feature|hotfix|bugfix|chore)\//, '').replace(new RegExp(`${BRANCH_SUFFIX}$`), '')
}

// 展示名：别名 > （主检出按其分支取名 | 工作区 id）。老板 2026-09-28：「不需要什么主检出，就叫 0.1.3-通知管理，很直观」
export function laneDisplayName(lane, repoStates = null) {
  if (lane?.title) return lane.title
  if (lane?.id === MAIN_LANE_ID) {
    const br = repoStates?.backend?.branch || repoStates?.['fe-supplier']?.branch || Object.values(repoStates || {})[0]?.branch || ''
    return branchLabel(br) || '主检出'
  }
  return lane?.id || ''
}

// 自动生成 id（老板：手写麻烦）：功能短名 > 分支去前后缀与版本号 > 版本号，取 ASCII 片段 slug；全中文取不出就 wt-<版本>；撞名加 -2/-3…
export function suggestLaneId({ feature = '', branch = '', version = '' } = {}, taken = []) {
  const v = String(version || '').trim()
  const strip = (s) => branchLabel(s).replace(/^v?\d+(\.\d+)+[-_]?/i, '')
  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28).replace(/-+$/, '')
  let base = slug(feature) || slug(strip(branch))
  if (base.length < 2) base = 'wt' + (v ? '-' + slug(v.replace(/\./g, '-')) : '')
  if (base === MAIN_LANE_ID) base = 'wt-main'
  const used = new Set(taken)
  let id = base, n = 2
  while (used.has(id)) id = `${base}-${n++}`
  return id
}

// 最小空闲槽位；满了返回 0
export function allocSlot(lanes) {
  const used = new Set((lanes || []).map(l => l.slot))
  for (let k = 1; k <= MAX_SLOT; k++) if (!used.has(k)) return k
  return 0
}

export function defaultBranch({ version, feature } = {}) {
  const v = String(version || '').trim()
  const f = String(feature || '').trim().replace(/\s+/g, '-')
  if (!v || !f) return ''
  return `feature/${v}-${f}${BRANCH_SUFFIX}`
}

export function worktreePath(workspaceRoot, laneId, repoKey) {
  return path.join(workspaceRoot, WORKTREE_DIR, `${laneId}-${REPOS[repoKey].suffix}`)
}

// 任务档案路径归一：去 `office-lab/` 协议前缀、`./`、反斜杠（存量 taskFile 带前缀，UI 传来的也可能不带）
export function normTaskFile(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^office-lab\//, '')
}

export function laneForTask(lanes, taskFile) {
  const t = normTaskFile(taskFile)
  if (!t) return null
  return (lanes || []).find(l => l.taskFile && normTaskFile(l.taskFile) === t) || null
}

// web-app 的 dev 代理把 /gys-web-app-web 写死到 8042（.umirc.test.ts）。umi 3 dev 会把
// `.umirc.local.ts` deepmerge 到最上层（@umijs/core Config: localConfig），且该文件已被 .gitignore——
// 旁路实例靠它改代理，不再去改被跟踪文件、也就不会有「勿提交」的改动混进 MR。
export function umiLocalConfig(ports) {
  return [
    `// ${MARK}：引擎生成，勿提交（已 gitignore）。本工作区的 dev 代理指向本槽位的 gys-web。`,
    `// 删掉它 = 回到 .umirc.test.ts 的默认代理（localhost:8042 主检出）。`,
    `export default {`,
    `  proxy: {`,
    `    '/gys-web-app-web': { target: 'http://localhost:${ports['gys-web']}/', changeOrigin: true, secure: true },`,
    `  },`,
    `};`,
    ``,
  ].join('\n')
}

// 跨境管理中台（auxiliary-web-workspace/management-frontend-umi）本地起在 UMI_ENV=dev：
// 未跟踪的 .umirc.dev.ts 只放代理（/api → 本槽位 auxiliary-api）。**不能**在这里重写 qiankun apps——umi 3 合并
// `.umirc.<env>.ts` 时数组是追加，会多出两条没有 entry 的注册项、整页报「entry should not be empty」（迷糊 10-07 第 7 轮高危）。
export function shellDevConfig(ports) {
  return [
    `// ${MARK}：引擎生成，勿提交（已写进 info/exclude）。UMI_ENV=dev 本地预检：/api → 本槽位 auxiliary-api。`,
    `// 微应用地址在 .umirc.ts 两个地址表的 dev 键（引擎打的本机补丁，skip-worktree，收工作区时还原）。`,
    `export default {`,
    `  define: { ENV: 'test' },`,
    `  proxy: {`,
    `    '/api': { target: 'http://localhost:${ports.cba}', changeOrigin: true },`,
    `  },`,
    `};`,
    ``,
  ].join('\n')
}

// 给中台 .umirc.ts 的 ENTRYMAP（登录微应用）/ ZJKMAP（菜单微应用＝组件中心）各补一个 dev 键：
// 登录仍走测试 offline-pre，菜单区加载本机组件中心。已有带标记的 dev 行就替换（端口可能变），没有 local 键的表不动。
export function patchShellUmirc(text, ccPort) {
  const tag = `// ${MARK}（skip-worktree，不提交）`
  const lines = String(text).split('\n').filter(l => !l.includes(tag))
  const out = []
  let map = ''
  for (const l of lines) {
    const m = l.match(/^const (ENTRYMAP|ZJKMAP)\b/)
    if (m) map = m[1]
    else if (/^};?\s*$/.test(l)) map = ''
    // 表里已有的 dev 键（手打的 / 旧端口的）先去掉，否则对象字面量重复键
    if (map && /^\s+dev:\s*'/.test(l)) continue
    out.push(l)
    if (map && /^\s+local:\s*'/.test(l)) {
      const indent = l.match(/^\s+/)[0]
      out.push(map === 'ENTRYMAP'
        ? `${indent}dev: '//api.example.test/', ${tag}`
        : `${indent}dev: '//localhost:${ccPort}/', ${tag}`)
    }
  }
  return out.join('\n')
}

// 默认起哪些：前端按 lane 里有的仓；后端 gys-web↔GYS 前端、web↔供应商前端，service 恒起（两者都调它）。
// 不无脑三个全起：一个 JVM 就 2G，旁路 lane 多数只动 GYS 一侧。
// 独立站工程：auxiliary-api + 跨境管理中台（登录与菜单的外壳）；组件中心单独一仓。
export function defaultTargets(repoKeys) {
  const has = new Set(repoKeys || [])
  const t = []
  if (has.has('fe-supplier')) t.push('fe-supplier')
  if (has.has('fe-cj')) t.push('fe-cj')
  if (has.has('backend')) {
    t.push('service')
    if (has.has('fe-supplier') || !has.has('fe-cj')) t.push('gys-web')
    if (has.has('fe-cj')) t.push('web')
  }
  if (has.has('iwo')) t.push('cba', 'kjglzt')
  if (has.has('fe-cc')) t.push('cc')
  return t
}

// 校验 targets：只许 lane 里有对应仓的服务；'all' = lane 全部可起服务
export function resolveTargets(lane, targets) {
  const repoKeys = Object.keys(lane.repos || {})
  const avail = Object.keys(SERVICES).filter(s => repoKeys.includes(SERVICES[s].repo))
  const raw = Array.isArray(targets) ? targets.map(s => String(s).trim()).filter(Boolean) : []
  if (!raw.length) return { ok: true, targets: defaultTargets(repoKeys).filter(t => avail.includes(t)) }
  if (raw.includes('all')) return { ok: true, targets: avail }
  const bad = raw.filter(s => !avail.includes(s))
  if (bad.length) return { ok: false, error: `工作区 ${lane.id} 没有这些服务：${bad.join(', ')}（可选：${avail.join(' / ') || '无'}，或 all）` }
  return { ok: true, targets: [...new Set(raw)] }
}

// `git status -b --porcelain` 首行：`## feat/x...origin/feat/x [ahead 1, behind 2]` / `## HEAD (no branch)`
export function parseStatusHeader(line) {
  const m = String(line || '').match(/^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/)
  if (!m) return { branch: '', upstream: '', ahead: 0, behind: 0 }
  const info = m[3] || ''
  const ahead = Number((info.match(/ahead (\d+)/) || [])[1] || 0)
  const behind = Number((info.match(/behind (\d+)/) || [])[1] || 0)
  let branch = m[1]
  if (/^No commits yet on /.test(branch)) branch = branch.replace(/^No commits yet on /, '')
  if (branch === 'HEAD (no branch)') branch = '(detached)'
  return { branch, upstream: m[2] || '', ahead, behind }
}

// `git worktree list --porcelain` → [{ path, head, branch }]
export function parseWorktreeList(text) {
  const out = []
  let cur = null
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim(), head: '', branch: '' }; out.push(cur) }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim()
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
  }
  return out
}

// 比真实路径：git 回的是长路径，而 os.tmpdir()/某些调用方给的可能是 8.3 短名（C:\Users\EXAMPL~1）——
// 只做字符串比较会把「分支就在主检出上」漏判成可认领（单测踩到过）。
const realOr = (p) => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
export const samePath = (a, b) => realOr(String(a || '')).replace(/\\/g, '/').toLowerCase() === realOr(String(b || '')).replace(/\\/g, '/').toLowerCase()

// Windows 路径 → Git Bash 能吃的形态（D:\a\b → /d/a/b）；非 Windows 原样
export function toMsys(p) {
  if (process.platform !== 'win32') return p
  return String(p).replace(/^([A-Za-z]):[\\/]/, (_, d) => '/' + d.toLowerCase() + '/').replace(/\\/g, '/')
}

// 原生 Windows 程序（powershell.exe）吃的形态：保留盘符、只把反斜杠换成正斜杠（MSYS 不会再去改写它）
export const toWinFwd = (p) => String(p).replace(/\\/g, '/')

// 注入会话系统提示的【运行环境】块。status 可缺（同步拼 prompt 时只有缓存），缺了就不说运行态、只给坐标。
// 这是 lane 对员工「可见」的唯一入口——没有它，建了 lane 也只是换个地方存路径。
// bound=false：本会话**没有指定**运行环境（老板直接开的聊天、没绑档案的派工）——明说「未指定」、默认对应主检出，
// 并告诉员工用 lane_status 自己查有哪些环境，而不是默认 8000 上跑的就是被测版本（2026-09-28 老板：员工要能知道当前聊天有没有指定运行环境）。
export function renderLaneBlock(lane, { employee = '', status = null, others = [], bound = true } = {}) {
  if (!lane) return ''
  const ports = portsForSlot(lane.slot)
  const isMain = lane.id === MAIN_LANE_ID
  const name = laneDisplayName(lane, status?.repos)
  const otherList = others.map(o => `\`${o.id}\`${o.title ? `（${o.title}）` : ''}`).join('、')
  const L = []
  if (isMain && !bound) {
    L.push(`【运行环境 · 未指定】（引擎注入；唯一事实源＝看板侧栏「运行环境」/ lane_status）`)
    L.push(`- 本会话**没有指定运行环境**，默认对应主检出「${name}」（槽位 0）。${otherList ? `当前另有并行工作区：${otherList}——各自 worktree、端口平移。` : '当前没有登记其它并行工作区。'}`)
    L.push(`- 活要落在某个具体版本/环境上、而你拿不准是哪个时：先 \`lane_status\` 看有哪些环境（分支 / 端口 / 绑定的任务档案），**对不上就问老板**，别默认 8000 上跑的就是你要的版本。`)
    L.push(`- 聊下来已经确认在说哪份任务档案（版本）时，**动手改代码 / 查环境之前**先调 \`bind_task_file\` 把本会话绑上——它会自动认领该档案的运行环境，并把环境坐标（工作树 / 端口）回给你；拿不准是哪份就先问，别猜着绑。`)
  } else {
    L.push(`【运行环境 · ${name}${isMain ? '（主检出）' : ''}】（引擎注入；唯一事实源＝看板侧栏「运行环境」/ lane_status）`)
  }
  const what = [lane.title, lane.version].filter(Boolean).join(' ')
  if (isMain) {
    if (bound) L.push(`- 本会话绑定**主检出**「${name}」（槽位 0）。${otherList ? `另有并行工作区：${otherList}——那些版本的代码在各自 worktree、端口平移，**别去动**。` : ''}`)
  } else {
    L.push(`- 本会话绑定工作区 \`${lane.id}\`${what ? `（${what}）` : ''}，端口槽位 ${lane.slot}。**代码改动只落在下面这几棵工作树**；主检出属于别的版本（可能正在人工预检），不要在主检出上改、切分支或重启服务：`)
  }
  // 环境挂了档案就点名：老板从这张环境卡找员工聊，话题默认就是这份档案（2026-10-06 菲菲把「这个」对号入座到别的版本上）
  if (lane.taskFile && bound) L.push(`- 本环境挂载任务档案 \`${lane.taskFile}\`——在本环境里老板找你说的事，**默认就是这份档案的版本 / 功能**，除非他明确点名了别的。`)
  for (const [k, r] of Object.entries(lane.repos || {})) {
    const st = status?.repos?.[k]
    const br = st?.branch || r.branch || ''
    L.push(`  · ${REPOS[k]?.label || k}：\`${String(r.path).replace(/\\/g, '/')}\`${br ? `（分支 \`${br}\`）` : ''}`)
  }
  const addr = []
  for (const [svc, s] of Object.entries(SERVICES)) {
    if (!lane.repos?.[s.repo]) continue
    const alive = status?.services?.[svc]?.alive
    const mark = alive === true ? '●' : alive === false ? '○' : ''
    addr.push(s.kind === 'fe' ? `${s.label} http://localhost:${ports[svc]}${mark ? ' ' + mark : ''}` : `${s.label} :${ports[svc]}${mark ? ' ' + mark : ''}`)
  }
  if (addr.length) L.push(`- 运行地址：${addr.join(' ｜ ')}${status ? '（● 在监听 ○ 未起；开会话那一刻的快照，以 lane_status 现值为准）' : ''}`)
  if (lane.repos?.iwo) L.push(`- 独立站工程：登录 / 菜单入口是**跨境管理中台 http://localhost:${ports.kjglzt}**（UMI_ENV=dev，/api 代理到本槽位 auxiliary-api :${ports.cba}）${lane.repos?.['fe-cc'] ? `；页面代码在组件中心，作为子应用从 :${ports.cc} 加载（端口被被跟踪配置写死，同一时间只能一个工作区起它）` : ''}。`)
  if (!isMain && lane.repos?.['fe-supplier']) L.push(`- GYS 前端的 dev 代理已由工作树里的 \`.umirc.local.ts\`（gitignored）指向本槽位 gys-web :${ports['gys-web']}——**别再去改 \`.umirc.test.ts\` 的代理**（那是被跟踪文件，改了会混进 MR）。`)
  const stale = status?.backend?.stale
  if (stale) L.push(`- ⚠ 后端构建已陈旧：上次成功构建于 ${status.backend.builtSha}，当前 HEAD ${status.backend.headSha}。`)
  if (employee === 'ggbond') {
    L.push(`- 起停/重编走 \`lane_up({lane:"${lane.id}", targets:[…]})\` / \`lane_down\`（异步，返回 op id，用 \`lane_status({op})\` 轮询到终态）。${isMain ? '主检出也可以继续用 rebuild_restart_backend。' : '**不要用 rebuild_restart_backend**（它只管主检出 8040/8042），也别手敲 manage-backend.sh / 手改端口参数。'}交预检前必须让本 lane 的后端「新鲜」。`)
  } else if (employee === 'mihu' || employee === 'feisila') {
    const fe = lane.repos?.['fe-supplier'] ? ports['fe-supplier'] : lane.repos?.['fe-cj'] ? ports['fe-cj'] : lane.repos?.iwo ? ports.kjglzt : null
    if (fe) L.push(`- **被测入口 origin = \`http://localhost:${fe}\`**。用例/登录 setup 里写死 \`localhost:8000\` 的地方${isMain ? '正是主检出，照旧' : '指向的是**主检出、不是本工作区**——本轮必须换成这个 origin，否则测的是另一个版本'}。`)
    L.push(`- 开测前 \`lane_status({lane:"${lane.id}"})\` 看一眼：服务在不在监听、后端是否「陈旧」。这是**只读**核对，不违反红线 10；陈旧/未起就【交回】GG Bond 让他重建，**你自己不起、不重启**。`)
  } else if (employee === 'bobby') {
    L.push(`- 发布枚举与建 MR 以上面这几棵工作树的分支为准（\`git -C <工作树> …\`）；主检出分支属于别的版本，别混。`)
  }
  return L.join('\n') + '\n\n'
}

// ---------- 带副作用：注册表 + git + 端口 + 起停 ----------

function runProc(cmd, args, { cwd, timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child
    try { child = spawn(cmd, args, { cwd, env: env || process.env, windowsHide: true }) } catch (e) { return resolve({ code: -1, out: '', err: String(e?.message || e) }) }
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill() } catch { }; resolve({ code: -1, out, err: err + '\n[timeout]' }) } }, timeoutMs)
    child.stdout?.on('data', d => { out += d })
    child.stderr?.on('data', d => { err += d })
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e?.message || e) }) } })
    child.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }) } })
  })
}
// git 一律丢到 worker 线程里起进程（2026-10-08 实测）：本机起一次 git.exe，spawn 这一步本身就**同步**阻塞
// 调用线程 0.6~1.3s（安全软件扫描进程创建），侧栏面板 10s/3s 一轮、每轮 ~14 个 git，引擎主线程 25s 里有 22s
// 卡在这里，连 /api/health 都要排 5~6s。worker 里阻塞的只是 worker 自己；建不起 worker 才退回主线程。
let gitWorker = null, gitSeq = 0
const gitPending = new Map()
// eval worker 在不同 Node 版本/包类型下可能按 CJS 或 ESM 解析，统一用动态 import()（两种都认）
const GIT_WORKER_SRC = `
Promise.all([import('node:worker_threads'), import('node:child_process')]).then(([{ parentPort }, { spawn }]) =>
parentPort.on('message', ({ id, args, cwd, timeoutMs }) => {
  let out = '', err = '', done = false, child
  const fin = (code, e) => { if (done) return; done = true; clearTimeout(timer); parentPort.postMessage({ id, code, out, err: e ?? err }) }
  try { child = spawn('git', args, { cwd, env: process.env, windowsHide: true }) } catch (e) { done = true; return parentPort.postMessage({ id, code: -1, out: '', err: String(e && e.message || e) }) }
  const timer = setTimeout(() => { try { child.kill() } catch { }; fin(-1, err + ' [timeout]') }, timeoutMs)
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  child.on('error', e => fin(-1, String(e && e.message || e)))
  child.on('close', code => fin(code))
}))`
function ensureGitWorker() {
  if (gitWorker) return gitWorker
  try {
    gitWorker = new Worker(GIT_WORKER_SRC, { eval: true })
    gitWorker.on('message', (m) => { const r = gitPending.get(m.id); if (r) { gitPending.delete(m.id); if (!gitPending.size) gitWorker.unref(); r({ code: m.code, out: m.out, err: m.err }) } })
    const fail = (e) => { gitWorker = null; for (const r of gitPending.values()) r({ code: -1, out: '', err: String(e?.message || e || 'git worker exited') }); gitPending.clear() }
    gitWorker.on('error', fail)
    gitWorker.on('exit', (c) => { if (gitWorker) fail(`git worker exited ${c}`) })
    gitWorker.unref()   // 必须在挂完监听之后：挂 message 监听会把 worker 重新 ref 上，进程（测试）就退不掉
  } catch { gitWorker = null }
  return gitWorker
}
const git = (cwd, args, timeoutMs = 20000) => {
  const w = ensureGitWorker()
  if (!w) return runProc('git', args, { cwd, timeoutMs })
  return new Promise((resolve) => { const id = ++gitSeq; gitPending.set(id, resolve); w.ref(); w.postMessage({ id, args, cwd, timeoutMs }) })
}

export function probePort(port, host = '127.0.0.1', timeoutMs = 350) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host })
    let settled = false
    const fin = (v) => { if (settled) return; settled = true; try { s.destroy() } catch { }; resolve(v) }
    s.setTimeout(timeoutMs, () => fin(false))
    s.once('connect', () => fin(true))
    s.once('error', () => fin(false))
  })
}

export function createLaneManager({ workspaceRoot, runsDir, manageBackendSh, manageFrontendPs1, resolveBash = () => 'bash', onChange = () => { } }) {
  const REG_FILE = path.join(runsDir, 'lanes.json')
  const OPS_FILE = path.join(runsDir, 'lane-ops.json')
  const LOG_DIR = path.join(workspaceRoot, 'run', 'lanes')
  const repoRoot = (k) => path.join(workspaceRoot, REPOS[k].dir)

  // 注册表按 mtime 缓存：并发闸 busyRunFor 在巡视 sweep 里高频调用，别每次都 JSON.parse。返回副本，调用方随便改。
  // 文件形态 { lanes:[…], main:{ title } }——main 段只存主检出的别名（主检出本身不入库）。
  // ccLane＝当前占着组件中心固定端口（8899）的工作区
  let regCache = { mtime: -1, lanes: [], main: {}, ccLane: '' }
  const readReg = () => {
    let mtime = 0
    try { mtime = fs.statSync(REG_FILE).mtimeMs } catch { return { lanes: [], main: {}, ccLane: '' } }
    if (mtime !== regCache.mtime) {
      try { const j = JSON.parse(fs.readFileSync(REG_FILE, 'utf8')); regCache = { mtime, lanes: Array.isArray(j.lanes) ? j.lanes : [], main: j.main && typeof j.main === 'object' ? j.main : {}, ccLane: typeof j.ccLane === 'string' ? j.ccLane : '' } } catch { return { lanes: [], main: {}, ccLane: '' } }
    }
    return JSON.parse(JSON.stringify({ lanes: regCache.lanes, main: regCache.main, ccLane: regCache.ccLane }))
  }
  const load = () => readReg().lanes
  const writeReg = (reg) => { fs.writeFileSync(REG_FILE, JSON.stringify(reg, null, 2)); regCache.mtime = -1; repoCache.clear(); onChange() }
  const save = (lanes) => writeReg({ ...readReg(), lanes })
  const loadOps = () => { try { return JSON.parse(fs.readFileSync(OPS_FILE, 'utf8')) } catch { return [] } }
  const saveOps = (ops) => { try { fs.writeFileSync(OPS_FILE, JSON.stringify(ops.slice(-60), null, 2)) } catch { } }

  // 主检出＝虚拟 lane：只收「工作区里确实存在」的仓（独立 clone 形态下三个都没有 → repos 为空，面板只显示空态）
  function mainLane() {
    const repos = {}
    for (const k of Object.keys(REPOS)) if (fs.existsSync(path.join(repoRoot(k), '.git'))) repos[k] = { path: repoRoot(k), branch: '' }
    return { id: MAIN_LANE_ID, title: readReg().main.title || '', slot: 0, repos, main: true }
  }
  const list = () => [mainLane(), ...load()]
  const get = (id) => (id === MAIN_LANE_ID ? mainLane() : load().find(l => l.id === id) || null)

  // ---- 运行态 op（起停）----
  function refreshOp(op) {
    if (op.status !== 'running') return op
    const parts = op.parts || []
    let allDone = true, anyFail = false
    for (const p of parts) {
      if (p.exitCode == null) {
        if (p.doneFile && fs.existsSync(p.doneFile)) { try { p.exitCode = fs.readFileSync(p.doneFile, 'utf8').trim() } catch { p.exitCode = '?' } }
      }
      if (p.exitCode == null) allDone = false
      else if (p.exitCode !== '0') anyFail = true
    }
    if (allDone) { op.status = anyFail ? 'failed' : 'done'; op.finishedAt = new Date().toISOString() }
    return op
  }
  function ops() {
    const all = loadOps()
    let changed = false
    for (const op of all) { const before = op.status; refreshOp(op); if (op.status !== before) changed = true }
    if (changed) { saveOps(all); onChange() }
    return all
  }
  const runningOp = (laneId) => ops().find(o => o.lane === laneId && o.status === 'running') || null
  const tail = (file, n = 8) => { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n).join('\n') } catch { return '' } }

  // 最近一次**成功**的后端 up 所记的 sha（构建新鲜度的基准）
  function lastBuiltSha(laneId) {
    const all = ops().filter(o => o.lane === laneId && o.action === 'up' && o.status === 'done' && o.backendSha)
    return all.length ? all[all.length - 1].backendSha : ''
  }

  // 仓库 git 状态按路径缓存 REPO_TTL_MS：面板 3s/10s 轮询 + 多标签页 + 引擎 60s 预热都打到这里，没必要每次都起 git。
  // 工作区增删（writeReg）清缓存；员工的 lane_status 工具要现值（判后端是否陈旧），走 fresh 绕过。
  const REPO_TTL_MS = 20000
  const repoCache = new Map()   // path -> { at, p: Promise<state> }
  function repoStateCached(p, fresh) {
    const c = repoCache.get(p)
    if (!fresh && c && Date.now() - c.at < REPO_TTL_MS) return c.p
    const e = { at: Date.now(), p: repoState(p) }
    repoCache.set(p, e)
    e.p.then((st) => { if (st.error) repoCache.delete(p) }, () => repoCache.delete(p))
    return e.p
  }

  async function repoState(p) {
    if (!fs.existsSync(p)) return { exists: false }
    // HEAD 一条 git log 顺带取提交时间与标题（面板悬浮卡的「时间信息」），不多一次 spawn
    const [st, head] = await Promise.all([git(p, ['-c', 'core.quotePath=false', 'status', '-b', '--porcelain']), git(p, ['log', '-1', '--format=%h%x09%cI%x09%s'])])
    if (st.code !== 0) return { exists: true, error: (st.err || '').trim().split('\n')[0] || 'git status 失败' }
    const lines = st.out.split(/\r?\n/).filter(Boolean)
    const h = parseStatusHeader(lines[0])
    const [hash = '', commitAt = '', subject = ''] = head.code === 0 ? head.out.trim().split('	') : []
    // 「未提交」只算**已跟踪文件的改动**；`??` 未跟踪文件单独计（老板 2026-09-28：已上线的版本怎么会未提交？——
    // 实为主检出根目录里有人解压 jar 留下的 BOOT-INF/ 与旧的 需求文档目录/，都是未跟踪的残留，混算成「未提交」是误导）
    const body = lines.slice(1)
    const untrackedList = body.filter(l => l.startsWith('?? ')).map(l => l.slice(3).replace(/^"|"$/g, ''))
    return { exists: true, ...h, head: hash, commitAt, subject, dirty: body.length - untrackedList.length, untracked: untrackedList.length, untrackedList: untrackedList.slice(0, 8) }
  }

  let cache = { at: 0, byId: {} }
  // 全量 status 在途合流：同一时刻多个调用方（多个标签页、引擎预热）共用一轮，不各自再起一批 git
  let statusAll = null
  function status(id, { fresh = false } = {}) {
    if (id || fresh) return statusNow(id, true)   // 点名查单个工作区＝要现值（员工 lane_status / 改完即查），不吃面板缓存
    if (!statusAll) statusAll = statusNow().finally(() => { statusAll = null })
    return statusAll
  }
  async function statusNow(id, fresh = false) {
    const lanes = id ? [get(id)].filter(Boolean) : list()
    const out = []
    await Promise.all(lanes.map(async (lane) => {
      const ports = portsForSlot(lane.slot)
      const repos = {}
      await Promise.all(Object.entries(lane.repos || {}).map(async ([k, r]) => { repos[k] = { path: r.path, branch: r.branch || '', adopted: !!r.adopted, ...(await repoStateCached(r.path, fresh)) } }))
      const services = {}
      await Promise.all(Object.entries(SERVICES).filter(([, s]) => lane.repos?.[s.repo]).map(async ([svc]) => {
        services[svc] = { port: ports[svc], alive: await probePort(ports[svc]) }
      }))
      const headSha = repos.backend?.head || repos.iwo?.head || ''
      const builtSha = lastBuiltSha(lane.id)
      const beAlive = BE_SERVICES.some(s => services[s]?.alive)
      const backend = lane.repos?.backend || lane.repos?.iwo
        ? { headSha, builtSha, stale: !!(beAlive && builtSha && headSha && builtSha !== headSha), unknown: !!(beAlive && !builtSha) }
        : null
      const op = runningOp(lane.id)
      const recent = ops().filter(o => o.lane === lane.id).slice(-1)[0] || null
      // expected：这个工作区「该起」的服务（= 默认 targets）。健康度只按它算——Temu 只动 GYS 一侧、不起 web，
      // 不该因为 web 没起就一直显示「部分在跑」（面板初版实测的噪音）。
      const expected = defaultTargets(Object.keys(lane.repos || {}))
      out.push({ ...lane, name: laneDisplayName(lane, repos), ports, repos, services, expected, backend, op: op ? opView(op) : null, lastOp: recent ? opView(recent) : null })
    }))
    out.sort((a, b) => a.slot - b.slot)
    for (const s of out) cache.byId[s.id] = s
    cache.at = Date.now()
    return out
  }
  const cached = (id) => cache.byId[id] || null

  function opView(op) {
    return {
      id: op.id, lane: op.lane, action: op.action, targets: op.targets, status: op.status, startedAt: op.startedAt, finishedAt: op.finishedAt,
      by: op.by, parts: (op.parts || []).map(p => ({ group: p.group, exitCode: p.exitCode ?? null, logFile: p.logFile, tail: tail(p.logFile, 6) })),
    }
  }

  // 某槽位上（按本 lane 会用到的仓）哪些端口已在监听
  async function portsBusy(slot, repoKeys) {
    const ports = portsForSlot(slot)
    // step=0 的固定端口各槽位相同，拿它判槽位空不空没有意义（会让所有槽位都显得被占）
    const svcs = Object.entries(SERVICES).filter(([, s]) => repoKeys.includes(s.repo) && s.step > 0).map(([k]) => k)
    const alive = await Promise.all(svcs.map(async k => ((await probePort(ports[k])) ? `${k}:${ports[k]}` : '')))
    return alive.filter(Boolean)
  }

  // ---- 建 / 收 / 改 ----
  async function create({ id: rawId, title = '', version = '', feature = '', branch = '', taskFile = '', repos: repoKeys = [], base = 'release', slot: wantSlot, by = '' } = {}) {
    const lanes = load()
    // id 留空＝自动生成（功能短名 / 分支 / 版本号 → slug，撞名自动加序号）
    const n = String(rawId || '').trim() ? normalizeLaneId(rawId) : { ok: true, id: suggestLaneId({ feature, branch, version }, lanes.map(l => l.id)) }
    if (!n.ok) return { ok: false, error: n.error }
    const id = n.id
    if (lanes.some(l => l.id === id)) return { ok: false, error: `工作区 ${id} 已存在` }
    const keys = [...new Set((repoKeys || []).map(String))].filter(k => REPOS[k])
    if (!keys.length) return { ok: false, error: `repos 至少选一个：${Object.keys(REPOS).join(' / ')}` }
    const br = String(branch || '').trim() || defaultBranch({ version, feature })
    if (!br) return { ok: false, error: '给 branch，或同时给 version + feature（按 feature/<version>-<feature>-lab 生成）' }
    if (!/^[\w./\u4e00-\u9fa5-]+$/.test(br) || br.includes('..')) return { ok: false, error: `分支名不合法：${br}` }
    // 槽位：显式给 → 只校验没被别的 lane 登记（端口在监听也放行——认领手工旁路实例时，那正是它自己的进程）；
    // 不给 → 取「未登记 且 端口全空」的最小槽位，别撞上没登记的手工旁路实例（2026-09-28 单测实撞：Temu 正占着 slot 1）
    let slot = 0
    if (wantSlot != null && wantSlot !== '') {
      slot = Number(wantSlot)
      if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOT) return { ok: false, error: `slot 需为 1~${MAX_SLOT}` }
      const owner = lanes.find(l => l.slot === slot)
      if (owner) return { ok: false, error: `槽位 ${slot} 已被工作区 ${owner.id} 占用` }
    } else {
      const used = new Set(lanes.map(l => l.slot))
      for (let k = 1; k <= MAX_SLOT && !slot; k++) {
        if (used.has(k)) continue
        if (!(await portsBusy(k, keys)).length) slot = k
      }
      if (!slot) return { ok: false, error: `没有空闲端口槽位（最多 ${MAX_SLOT} 条；未登记但端口已被占的槽位也跳过了）。先收掉一条不用的，或显式指定 slot 认领。` }
    }
    const ports = portsForSlot(slot)
    const log = []
    const made = {}
    for (const k of keys) {
      const root = repoRoot(k)
      if (!fs.existsSync(path.join(root, '.git'))) return { ok: false, error: `找不到主检出仓库 ${root}`, log }
      const wl = await git(root, ['worktree', 'list', '--porcelain'])
      const trees = parseWorktreeList(wl.out)
      // 认领：该分支已在某棵树上检出（如 Temu 手工开的 .worktrees/temu-be）→ 直接登记那棵，不另建
      const onBranch = trees.find(t => t.branch === br)
      if (onBranch) {
        if (samePath(onBranch.path, root)) return { ok: false, error: `${REPOS[k].label}：分支 ${br} 正检出在**主检出**上——主检出不能再当 worktree 用。先把主检出切走，或换个分支名。`, log }
        made[k] = { path: path.resolve(onBranch.path), branch: br, adopted: true }
        log.push(`${REPOS[k].label}：认领已有工作树 ${onBranch.path}`)
      } else {
        const wt = worktreePath(workspaceRoot, id, k)
        if (fs.existsSync(wt)) return { ok: false, error: `${wt} 已存在但不是分支 ${br} 的工作树——手工看一下是什么再处理（引擎不覆盖）`, log }
        const f = await git(root, ['fetch', 'origin', base], 90000)
        if (f.code !== 0) log.push(`${REPOS[k].label}：fetch origin ${base} 失败（${(f.err || '').trim().split('\n').pop()}），按本地已有的 origin/${base} 继续`)
        const hasLocal = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${br}`])).code === 0
        const hasRemote = !hasLocal && (await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${br}`])).code === 0
        // 新分支从 origin/<base> 切且 --no-track：否则上游会被设成 origin/release，ahead/behind 全按 release 算、误导「未推送」判断
        const args = hasLocal ? ['worktree', 'add', wt, br]
          : hasRemote ? ['worktree', 'add', '--track', '-b', br, wt, `origin/${br}`]
            : ['worktree', 'add', '--no-track', '-b', br, wt, `origin/${base}`]
        const r = await git(root, args, 180000)
        if (r.code !== 0) return { ok: false, error: `${REPOS[k].label}：git ${args.join(' ')} 失败：${(r.err || r.out).trim().split('\n').slice(-2).join(' ')}`, log, partial: made }
        made[k] = { path: wt, branch: br }
        log.push(`${REPOS[k].label}：${hasLocal ? '检出已有本地分支' : hasRemote ? '跟踪远端分支' : `从 origin/${base} 新切`} ${br} → ${wt}`)
      }
      const wt = made[k].path
      if (REPOS[k].ownNodeModules) log.push(`${REPOS[k].label}：不复用主检出 node_modules，首次 lane_up 时在工作树里 yarn install`)
      else if (k !== 'backend') {
        // node_modules：junction 复用主检出（免管理员；umi3 老栈重装一次十几分钟）
        const link = path.join(wt, 'node_modules'), target = path.join(root, 'node_modules')
        if (!fs.existsSync(link) && fs.existsSync(target)) {
          try { fs.symlinkSync(target, link, 'junction'); log.push(`${REPOS[k].label}：node_modules → junction 复用主检出`) } catch (e) { log.push(`${REPOS[k].label}：建 node_modules junction 失败（${e.message}），起前端前需手动处理`) }
        }
      }
      if (k === 'fe-supplier') {
        const f = path.join(wt, '.umirc.local.ts')
        const existing = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
        if (existing === null || existing.includes(MARK)) { fs.writeFileSync(f, umiLocalConfig(ports)); log.push(`GYS 前端：写 .umirc.local.ts，dev 代理 → gys-web :${ports['gys-web']}`) }
        else log.push('GYS 前端：已有手写 .umirc.local.ts，未覆盖——请自行确认代理指向 :' + ports['gys-web'])
        const ig = await git(wt, ['check-ignore', '-q', '.umirc.local.ts'])
        if (ig.code !== 0) log.push('⚠ GYS 前端：.umirc.local.ts 未被 gitignore，提交前留意别带上')
      }
    }
    const lane = { id, title: String(title || '').trim(), version: String(version || '').trim(), taskFile: normTaskFile(taskFile) ? `office-lab/${normTaskFile(taskFile)}` : '', slot, base, repos: made, createdAt: new Date().toISOString(), createdBy: by }
    save([...load(), lane])
    return { ok: true, lane, ports, log }
  }

  function update(id, patch = {}) {
    if (id === MAIN_LANE_ID) {   // 主检出只能改别名（它不入库、没有档案绑定）
      const reg = readReg()
      reg.main = { ...reg.main, title: String(patch.title || '').trim() }
      writeReg(reg)
      return { ok: true, lane: mainLane() }
    }
    const lanes = load()
    const l = lanes.find(x => x.id === id)
    if (!l) return { ok: false, error: `没有工作区 ${id}` }
    if (patch.title !== undefined) l.title = String(patch.title || '').trim()
    if (patch.version !== undefined) l.version = String(patch.version || '').trim()
    if (patch.taskFile !== undefined) l.taskFile = normTaskFile(patch.taskFile) ? `office-lab/${normTaskFile(patch.taskFile)}` : ''
    // 起服务时追加的环境变量（如 TEMU_ENROLL_STUB_ENABLED=true 开测试桩）；值给空串＝删掉该键。只作用于 runner 服务
    if (patch.env && typeof patch.env === 'object') {
      const env = { ...(l.env || {}) }
      for (const [k, v] of Object.entries(patch.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return { ok: false, error: `环境变量名不合法：${k}` }
        if (v === '' || v == null) delete env[k]; else env[k] = String(v)
      }
      l.env = env
    }
    save(lanes)
    return { ok: true, lane: l }
  }

  async function remove(id, { keepWorktrees = false } = {}) {
    const lanes = load()
    const lane = lanes.find(x => x.id === id)
    if (!lane) return { ok: false, error: id === MAIN_LANE_ID ? '主检出不能删' : `没有工作区 ${id}` }
    if (runningOp(id)) return { ok: false, error: '该工作区有起停操作在跑，等它结束再收' }
    const ports = portsForSlot(lane.slot)
    const alive = []
    const ccMine = readReg().ccLane === id
    for (const [svc, s] of Object.entries(SERVICES)) {
      if (!lane.repos?.[s.repo] || (s.step === 0 && !ccMine)) continue   // 固定端口被别的工作区占着，不算本工作区的
      if (await probePort(ports[svc])) alive.push(`${svc}:${ports[svc]}`)
    }
    if (alive.length) return { ok: false, error: `还有服务在跑（${alive.join('、')}）——先 lane_down 停掉再收` }
    const log = []
    if (!keepWorktrees) {
      // 先还原引擎给跨境管理中台打的本机补丁（.umirc.ts skip-worktree / 生成的 .umirc.dev.ts），否则体检会把它当未提交 / 未跟踪拦下
      if (lane.repos?.iwo && fs.existsSync(lane.repos.iwo.path)) log.push(...(await restoreShell(lane.repos.iwo.path)))
      // 先全部体检、再动手：不留「删了一半」的状态
      for (const [k, r] of Object.entries(lane.repos || {})) {
        if (!fs.existsSync(r.path)) { log.push(`${REPOS[k].label}：工作树已不存在，跳过`); continue }
        const st = await repoState(r.path)
        if (st.dirty > 0) return { ok: false, error: `${REPOS[k].label}（${r.path}）有 ${st.dirty} 处未提交改动——先提交/推送，或只从看板移除（keepWorktrees）`, log }
        // 未跟踪文件 git worktree remove 同样会拒（且可能是没 add 的新代码），先体检说清楚，别删到一半才失败
        if (st.untracked > 0) return { ok: false, error: `${REPOS[k].label}（${r.path}）有 ${st.untracked} 个未跟踪文件（${st.untrackedList.join('、')}${st.untracked > st.untrackedList.length ? '…' : ''}）——是新代码就提交，是垃圾就删掉，或只从看板移除（keepWorktrees）`, log }
        const up = st.upstream
          ? await git(r.path, ['rev-list', '--count', `${st.upstream}..HEAD`])
          : await git(r.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
        const unpushed = Number((up.out || '').trim() || 0)
        if (unpushed > 0) return { ok: false, error: `${REPOS[k].label}：分支 ${st.branch} 有 ${unpushed} 个提交还没推到远端——先推送，或只从看板移除（keepWorktrees）`, log }
      }
      for (const [k, r] of Object.entries(lane.repos || {})) {
        if (!fs.existsSync(r.path)) continue
        // 先拆 junction：递归删除若顺着 junction 走，会把主检出的 node_modules 一起删掉
        const link = path.join(r.path, 'node_modules')
        try { if (fs.lstatSync(link).isSymbolicLink()) { fs.unlinkSync(link); log.push(`${REPOS[k].label}：拆除 node_modules junction`) } } catch { }
        const f = path.join(r.path, '.umirc.local.ts')
        try { if (fs.readFileSync(f, 'utf8').includes(MARK)) fs.unlinkSync(f) } catch { }
        const rr = await git(repoRoot(k), ['worktree', 'remove', r.path], 120000)
        if (rr.code !== 0) { log.push(`⚠ ${REPOS[k].label}：git worktree remove 失败（${(rr.err || '').trim().split('\n').pop()}）——工作树保留，需手工处理`); continue }
        log.push(`${REPOS[k].label}：已移除工作树 ${r.path}（分支 ${r.branch} 保留）`)
      }
    } else log.push('只从看板移除登记；工作树与分支原样保留')
    save(load().filter(x => x.id !== id))
    return { ok: true, log }
  }

  // ---- 独立站工程（runner 服务）----
  // 供应商三仓有仓根 manage-backend.sh / manage-frontend.ps1；独立站工程没有，这里按 Temu 迁移时手工跑通的那套拼命令：
  // auxiliary-api = JDK17 maven package → 拷 jar 到 run/lanes/<id>/ → nohup java -jar；两个 umi 前端 = nohup npx umi dev。
  // 都是「先按端口杀旧进程 → 起 → 轮询端口到监听才 exit 0」，终态同样写 .done（与 manage-*.sh 的口径一致，跨重启可判）。
  const SHELL_SUB = 'management-frontend-umi'
  const toolsDir = path.join(workspaceRoot, '.tools')

  async function prepareShell(iwoPath, ports) {
    const dir = path.join(iwoPath, SHELL_SUB)
    const log = []
    const devFile = path.join(dir, '.umirc.dev.ts')
    const existing = fs.existsSync(devFile) ? fs.readFileSync(devFile, 'utf8') : null
    if (existing === null || existing.includes(MARK)) fs.writeFileSync(devFile, shellDevConfig(ports))
    else log.push('⚠ 跨境管理中台：已有手写 .umirc.dev.ts，未覆盖——请确认它没有重写 qiankun apps、/api 代理指向 :' + ports.cba)
    const cd = await git(dir, ['rev-parse', '--git-common-dir'])
    if (cd.code === 0) {
      const ex = path.join(path.resolve(dir, cd.out.trim()), 'info', 'exclude')
      const line = `${SHELL_SUB}/.umirc.dev.ts`
      try { const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : ''; if (!cur.split(/\r?\n/).includes(line)) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n') } } catch { }
    }
    const umirc = path.join(dir, '.umirc.ts')
    if (fs.existsSync(umirc)) {
      const before = fs.readFileSync(umirc, 'utf8')
      const after = patchShellUmirc(before, ports.cc)
      if (after !== before) fs.writeFileSync(umirc, after)
      await git(dir, ['update-index', '--skip-worktree', '.umirc.ts'])
    }
    return log
  }

  async function restoreShell(iwoPath) {
    const dir = path.join(iwoPath, SHELL_SUB)
    const log = []
    const devFile = path.join(dir, '.umirc.dev.ts')
    try { if (fs.readFileSync(devFile, 'utf8').includes(MARK)) { fs.unlinkSync(devFile); log.push('跨境管理中台：删除引擎生成的 .umirc.dev.ts') } } catch { }
    const umirc = path.join(dir, '.umirc.ts')
    try {
      if (fs.readFileSync(umirc, 'utf8').includes(MARK)) {
        await git(dir, ['update-index', '--no-skip-worktree', '.umirc.ts'])
        await git(dir, ['checkout', '--', '.umirc.ts'])
        log.push('跨境管理中台：.umirc.ts 本机补丁已还原')
      }
    } catch { }
    return log
  }

  // 一条 runner 服务的 bash 命令（up / down）
  function customCommand(svc, lane, ports, action, logDir) {
    const s = SERVICES[svc]
    const port = ports[svc]
    const q = (p) => `"${toMsys(p)}"`
    const kill = `for p in $(netstat -ano 2>/dev/null | grep LISTENING | grep ":${port} " | awk '{print $5}' | sort -u); do taskkill //PID $p //T //F >/dev/null 2>&1; done; ` +
      `command -v lsof >/dev/null 2>&1 && lsof -ti tcp:${port} | xargs -r kill 2>/dev/null; sleep 2; `
    if (action === 'down') return `${kill}echo "已停 ${s.label} :${port}"`
    const wait = (secs) => `ok=0; for i in $(seq 1 ${Math.ceil(secs / 3)}); do if (echo > /dev/tcp/127.0.0.1/${port}) 2>/dev/null; then ok=1; break; fi; sleep 3; done; ` +
      `if [ $ok = 1 ]; then echo "${s.label} 已在 :${port} 监听"; else echo "等 ${s.label} :${port} 监听超时（${secs}s），看 ${toMsys(path.join(logDir, svc + '.out.log'))}"; exit 1; fi`
    const node = `export PATH=${q(path.join(toolsDir, 'node18'))}:$PATH NODE_OPTIONS=--openssl-legacy-provider; `
    const install = `if [ ! -d node_modules ]; then echo "首次起：yarn install"; yarn install --frozen-lockfile --ignore-scripts --network-timeout 600000 || exit 1; fi; `
    const out = q(path.join(logDir, `${svc}.out.log`))
    const repoPath = lane.repos[s.repo].path
    if (s.runner === 'cba') {
      const jdk = path.join(toolsDir, 'jdk17')
      const jar = path.join(logDir, 'cba.jar')
      return `${kill}cd ${q(path.join(repoPath, 'backend'))} || exit 1; ` +
        `export JAVA_HOME=${q(jdk)} PATH=${q(path.join(jdk, 'bin'))}:$PATH MAVEN_OPTS="-Duser.language=en"; ` +
        `${q(path.join(toolsDir, 'maven', 'bin', 'mvn'))} -q -Dmaven.test.skip=true package || exit 1; ` +
        `cp "$(ls target/*.jar | grep -v original | head -1)" ${q(jar)} || exit 1; cd ${q(logDir)}; ` +
        `nohup java -Duser.timezone=Asia/Shanghai -Dfile.encoding=UTF-8 -jar ${q(jar)} --spring.profiles.active=\${CBA_PROFILE:-local} --server.port=${port} > ${out} 2>&1 & ` +
        wait(240)
    }
    if (s.runner === 'kjglzt') {
      return `${kill}cd ${q(path.join(repoPath, SHELL_SUB))} || exit 1; ${node}${install}` +
        `if [ ! -f authority/index.ts ]; then npx authority --upload --ts --env=test || exit 1; fi; ` +
        `UMI_ENV=dev PORT=${port} nohup npx umi dev > ${out} 2>&1 & ` + wait(600)
    }
    if (s.runner === 'cc') {
      return `${kill}cd ${q(repoPath)} || exit 1; ${node}${install}` +
        `UMI_ENV=test QIANKUN_MODE=slave nohup npx umi dev > ${out} 2>&1 & ` + wait(900)
    }
    return `echo "未知 runner ${s.runner}"; exit 1`
  }

  // ---- 起停 ----
  // action: 'up'（重编+重启：后端 manage-backend.sh restart；前端 manage-frontend.ps1 restart）| 'down'（停）
  // runner 服务（独立站工程）走 customCommand，一个服务一条后台命令。
  async function runOp(id, { action = 'up', targets, by = '' } = {}) {
    const lane = get(id)
    if (!lane) return { ok: false, error: `没有工作区 ${id}` }
    if (!['up', 'down'].includes(action)) return { ok: false, error: `未知动作 ${action}` }
    const busy = runningOp(id)
    if (busy) return { ok: false, error: `工作区 ${id} 已有操作在跑（${busy.id}：${busy.action} ${busy.targets.join(',')}）`, opId: busy.id }
    const t = resolveTargets(lane, targets)
    if (!t.ok) return t
    if (!t.targets.length) return { ok: false, error: `工作区 ${id} 没有可起停的服务` }
    const ports = portsForSlot(lane.slot)
    const opId = 'lo' + Date.now().toString(36)
    const dir = path.join(LOG_DIR, lane.id, 'ops')
    fs.mkdirSync(dir, { recursive: true })
    const custom = t.targets.filter(s => SERVICES[s].runner)
    const be = t.targets.filter(s => SERVICES[s].kind === 'be' && !SERVICES[s].runner)
    const fe = t.targets.filter(s => SERVICES[s].kind === 'fe' && !SERVICES[s].runner)
    const parts = []
    const verb = action === 'up' ? 'restart' : 'stop'
    const tag = lane.id === MAIN_LANE_ID ? '' : `lane-${lane.id}`
    if (custom.length) {
      const laneDir = path.join(LOG_DIR, lane.id)
      fs.mkdirSync(laneDir, { recursive: true })
      // 组件中心端口写死：另一个工作区正占着（登记的占用者 + 端口在监听）就别去杀它；占用者记在注册表顶层 ccLane
      if (custom.includes('cc')) {
        const reg = readReg()
        if (action === 'up') {
          if (reg.ccLane && reg.ccLane !== lane.id && get(reg.ccLane) && await probePort(ports.cc)) {
            return { ok: false, error: `组件中心端口 ${ports.cc} 固定，工作区 ${reg.ccLane} 正在用——先 lane_down({lane:"${reg.ccLane}", targets:["cc"]})` }
          }
          writeReg({ ...reg, ccLane: lane.id })
        } else if (reg.ccLane === lane.id) writeReg({ ...reg, ccLane: '' })
      }
      if (action === 'up' && custom.includes('kjglzt')) {
        const plog = await prepareShell(lane.repos.iwo.path, ports)
        if (plog.length) fs.appendFileSync(path.join(laneDir, 'prepare.log'), plog.join('\n') + '\n')
      }
      for (const s of custom) {
        parts.push({ group: s, cmd: customCommand(s, lane, ports, action, laneDir), env: { ...(SERVICES[s].env || {}), ...(lane.env || {}) }, raw: true })
      }
    }
    if (be.length) {
      if (!fs.existsSync(manageBackendSh)) return { ok: false, error: `找不到 ${manageBackendSh}` }
      const env = { PORT_KILL_CONFIRM: 'always' }
      if (lane.slot > 0) Object.assign(env, { BACKEND_DIR: toMsys(lane.repos.backend.path), PORT_OFFSET: String(BACKEND_OFFSET_STEP * lane.slot), RUN_TAG: tag, SHARED_BUILD: 'reactor' })
      parts.push({ group: 'backend', cmd: `"${toMsys(manageBackendSh)}" ${verb} ${be.join(' ')}`, env })
    }
    for (const s of fe) {
      if (!fs.existsSync(manageFrontendPs1)) return { ok: false, error: `找不到 ${manageFrontendPs1}` }
      const env = { PORT_KILL_CONFIRM: 'always' }
      if (lane.slot > 0) Object.assign(env, { FRONTEND_APP_DIR: toWinFwd(lane.repos[SERVICES[s].repo].path), APP_PORT: String(ports[s]), RUN_TAG: tag })
      parts.push({ group: s, cmd: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${toWinFwd(manageFrontendPs1)}" ${verb} ${REPOS[SERVICES[s].repo].app}`, env })
    }
    let backendSha = ''
    const beRepo = be.length ? lane.repos.backend : custom.includes('cba') ? lane.repos.iwo : null
    if (beRepo && action === 'up') { const h = await git(beRepo.path, ['rev-parse', '--short', 'HEAD']); backendSha = h.code === 0 ? h.out.trim() : '' }
    const op = { id: opId, lane: lane.id, action, targets: t.targets, status: 'running', startedAt: new Date().toISOString(), by, backendSha, parts: [] }
    for (const p of parts) {
      const logFile = path.join(dir, `${opId}-${p.group}.log`)
      const doneFile = path.join(dir, `${opId}-${p.group}.done`)
      // runner 命令是多条语句、里面有 exit：包进子 shell，重定向罩住全部、exit 只退子 shell，.done 照样写
      const body = p.raw ? `( ${p.cmd} )` : p.cmd
      const shellCmd = `${body} > "${toMsys(logFile)}" 2>&1; ec=$?; echo "$ec" > "${toMsys(doneFile)}"; exit $ec`
      const rec = { group: p.group, logFile, doneFile, exitCode: null }
      try {
        const child = spawn(resolveBash(), ['-lc', shellCmd], { cwd: workspaceRoot, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...p.env } })
        child.on('error', (e) => { try { fs.appendFileSync(logFile, `\n[spawn error] ${e.message}\n`); if (!fs.existsSync(doneFile)) fs.writeFileSync(doneFile, '127') } catch { } })
        child.unref()
      } catch (e) { rec.exitCode = '127'; try { fs.writeFileSync(logFile, `[spawn error] ${e.message}\n`) } catch { } }
      op.parts.push(rec)
    }
    const all = loadOps(); all.push(op); saveOps(all); onChange()
    return { ok: true, op: opView(op), ports }
  }

  function opStatus(opId) {
    const op = ops().find(o => o.id === opId)
    return op ? opView(op) : null
  }

  return { list, get, load, status, cached, create, update, remove, runOp, opStatus, ops: () => ops().map(opView) }
}
