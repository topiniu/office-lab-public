// 工作区根探测 + 逻辑/物理路径互转 —— **路径根的唯一事实源**，改路径先读本文件。
//
// 缘起（2026-08-24，老板要求「仓库搬到其他电脑能开箱即用」）：原先 server.js 里
// `const ROOT = path.resolve(__dirname,'..','..')` 写死「office-lab 的父目录」，而 ROOT 正是员工 agent 的
// cwd（permissionMode 多为 acceptEdits/bypassPermissions）。独立 clone 到 ~/dev/office-lab 后 ROOT 变成
// ~/dev —— 仓库外的任意父目录。今天不立刻崩只因为默认 clone 出来的目录恰好叫 office-lab、
// `ROOT/office-lab/...` 碰巧成立；目录一改名或换嵌套深度就全断。既是可移植性问题，也是个越权面。
//
// ── 三层路径语义（本模块的核心，别混）────────────────────────────────────────
// L（逻辑/协议）：`office-lab/…` 前缀。它**已经是线上协议常量、不是物理路径**——旧 UI 把它写死在正则里
//   （app/public/app.js:2510 的 REPO_MD_SRC、2627/2658/2753 的截图内联），且存量数据全带它
//   （runs/index.json 里 406 条 taskFile 首段 100% 是 office-lab；tasks/ 下 53 个档案共 136 处引用）。
//   → **冻结，一律不改**。出栈给前端/落库的字符串永远是 L 形式。
// P（物理）：agent 用原生 Read/Write/Bash 时相对 cwd 的真路径。只在「出栈给 agent 那一刻」由
//   toAgentPath() 做一次 L→P 改写（server.js 的 3 个咽喉：input push / roleText / 会议 prompt）。
// R（解析器）：引擎自己读写文件。repoCandidates() 三候选双向容忍，L 形式与仓内相对形式都认。
//
// 关键安全属性：**嵌套且目录同名时 OFFICE_PREFIX === OFFICE_URI_PREFIX，toAgentPath 恒等** ——
// 即原机器行为一字不变。这条有单测钉着（test/paths.test.js）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// office-lab 仓库根（roles/ tasks/ memories/ .claude/agents/ 所在）——恒等于 app/ 的上一级，与部署形态无关。
export const OFFICE_ROOT = path.resolve(__dirname, '..')

// 协议常量：**永远是这个字面量**，不随目录实际叫什么而变（见上方 L 层说明）。
export const OFFICE_URI_PREFIX = 'office-lab'

// 「是不是 monorepo 嵌套」的判据物。刻意不用「父目录有没有 .git」——这三个才是 monorepo 的**定义性事实**
// （CODE_ROOTS = ['frontend','backend'] 见 server.js:121；MANAGE_BACKEND_SH 见 server.js:1516），
// 判据与「ROOT 到底给谁用」同源，不会出现「判成嵌套但兄弟仓其实不在」的中间态。
const MONOREPO_MARKERS = ['backend', 'frontend', 'manage-backend.sh']

const isInside = (parent, child) => child === parent || child.startsWith(parent + path.sep)

function detectWorkspace() {
  // ① 显式覆盖优先：给「挪到更深一层」的布局留逃生阀，也是在原机器上就地验证独立语义的唯一无损手段。
  //    必须真包含 OFFICE_ROOT，否则后面所有越权校验都会把仓内路径判成越界 → 视为无效、落回自动探测。
  const env = process.env.OFFICE_LAB_WORKSPACE_ROOT
  if (env) {
    const abs = path.resolve(env)
    try { if (fs.statSync(abs).isDirectory() && isInside(abs, OFFICE_ROOT)) return { root: abs, mode: 'env' } } catch { /* 无效 → 自动探测 */ }
  }
  // ② 嵌套模式：父目录里有 monorepo 标志物
  const parent = path.resolve(OFFICE_ROOT, '..')
  if (parent !== OFFICE_ROOT && MONOREPO_MARKERS.some(m => fs.existsSync(path.join(parent, m)))) return { root: parent, mode: 'monorepo' }
  // ③ 独立模式：工作树 = 仓根，**绝不逃到仓库外**
  return { root: OFFICE_ROOT, mode: 'standalone' }
}

const _ws = detectWorkspace()
// agent 的工作树 + 越权校验的外边界。嵌套模式 = monorepo 顶层（员工要改 frontend/、backend/，
// 必须是这个）；独立模式 = office-lab 仓根（工作树收进仓库内，安全边界与解析边界一致）。
export const WORKSPACE_ROOT = _ws.root
export const WORKSPACE_MODE = _ws.mode   // 'env' | 'monorepo' | 'standalone'

// office-lab 相对工作区根的**物理**前缀：嵌套=`office-lab`（或改名后的真实目录名）、独立=`''`。
export const OFFICE_PREFIX = (() => {
  const rel = path.relative(WORKSPACE_ROOT, OFFICE_ROOT)
  return rel ? rel.split(path.sep).join('/') : ''
})()

// 拼一条 L 形式（协议形式）的仓内路径，供出栈字符串使用：officeRel('app','runs') → 'office-lab/app/runs'。
// 出栈后由 toAgentPath 统一改写成物理形式；落库/给前端的仍是这个 L 形式。
export function officeRel(...segs) {
  return [OFFICE_URI_PREFIX, ...segs.filter(Boolean).map(s => String(s).replace(/^\/+|\/+$/g, ''))].join('/')
}

// L→P：把文本里的 `office-lab/…` 换成当前形态的真实相对路径。
// 前缀相同时直接返回原串（恒等短路）——原机器上这个函数不做任何事，零风险。
const _RE_PREFIX = new RegExp(`(?<![\\w./-])${OFFICE_URI_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g')
export function toAgentPath(s) {
  if (OFFICE_PREFIX === OFFICE_URI_PREFIX) return s
  if (typeof s !== 'string' || !s.includes(OFFICE_URI_PREFIX + '/')) return s
  // 独立模式 → 前缀整段剥掉；改名/更深嵌套 → 换成真实前缀。
  // 负向后顾 `(?<![\w./-])` 保证只替换「路径起始位置」的那一段：`my-office-lab/x`、`docs/office-lab/x` 都不动。
  return s.replace(_RE_PREFIX, OFFICE_PREFIX ? OFFICE_PREFIX + '/' : '')
}

// 剥掉首段的 office-lab 前缀，得到仓内相对路径。三种名字都认：协议常量、当前物理前缀、真实目录名
// （覆盖「clone 成 ai-office」）。没有前缀则返回 null（调用方据此跳过该候选）。
export function stripOfficePrefix(rel) {
  if (!rel) return null
  const norm = String(rel).replace(/\\/g, '/').replace(/^\.\//, '')
  for (const n of new Set([OFFICE_URI_PREFIX, OFFICE_PREFIX, path.basename(OFFICE_ROOT)].filter(Boolean))) {
    if (norm === n) return '.'
    if (norm.startsWith(n + '/')) return norm.slice(n.length + 1) || '.'
  }
  return null
}

// R 层：一条相对路径的候选绝对路径（按优先级）。每个候选都做「不得越出其基准根」校验 —— 基准根之所以
// 分别取 WORKSPACE_ROOT / OFFICE_ROOT（而非一律用外边界），是为了保住原 safeResolve 对 `../x` 的拒绝语义：
// 否则 `../secret` 会经「OFFICE_ROOT/../secret」落进工作区根、由抛错变成可读。
export function repoCandidates(rel) {
  if (!rel) return []
  const out = []
  const add = (base, r, bound) => {
    if (!r) return
    let abs
    try { abs = path.resolve(base, r) } catch { return }
    if (!isInside(bound, abs)) return                 // 越权：跳过该候选
    if (!out.includes(abs)) out.push(abs)
  }
  add(WORKSPACE_ROOT, rel, WORKSPACE_ROOT)            // ① 工作区相对：嵌套模式下 'office-lab/tasks/x.md' 直接命中（= 原行为）
  add(OFFICE_ROOT, rel, OFFICE_ROOT)                  // ② 仓内相对：'tasks/x.md'、'roles/…'、'docs/…'（office-lab CLAUDE.md 的惯例写法）
  add(OFFICE_ROOT, stripOfficePrefix(rel), OFFICE_ROOT) // ③ 剥前缀后仓内相对：**独立模式下 406 条存量 taskFile 靠这条命中**
  return out
}

// 越权校验 + 解析。取第一个**真实存在**的候选；都不存在则回首候选 —— 保留原行为「允许写尚不存在的文件」
// （新建任务档案就走这条）。全部候选都越权 → 抛错（与原实现一致）。
export function safeResolve(rel) {
  const c = repoCandidates(rel)
  if (!c.length) throw new Error('path outside repo')
  for (const abs of c) { try { if (fs.existsSync(abs)) return abs } catch { /* 试下一个 */ } }
  return c[0]
}

// 会话里点开的仓库 md：路径可能是 L 形式（`office-lab/…`）、monorepo 相对（`docs/示例项目需求/…`）、
// 或 office-lab 仓内相对（`docs/README.md`、`roles/…`、`tasks/…`）。依次试候选、返回首个真实存在的**文件**。
// 都不存在返回 null（调用方据此回 404，而非让 statSync 抛 ENOENT 冒泡成 500 —— 500 会让前端误报
// 「读取失败」而非「文件不存在」）。
export function resolveRepoFile(rel) {
  for (const abs of repoCandidates(rel)) {
    try { if (fs.statSync(abs).isFile()) return abs } catch { /* 该候选不存在 → 试下一个 */ }
  }
  return null
}

// 同 resolveRepoFile，但命中的是**目录**（file 卡偶尔指向一整个证据目录，如「视觉初筛截图/第2轮」）。
// 分开一个函数而不是放宽 resolveRepoFile：后者的调用方（档案解析/读文本）都默认拿到的是文件。
export function resolveRepoDir(rel) {
  for (const abs of repoCandidates(rel)) {
    try { if (fs.statSync(abs).isDirectory()) return abs } catch { /* 该候选不存在 → 试下一个 */ }
  }
  return null
}

// 解析员工资料文件：优先读 office-lab 仓库内副本（自带工牌/角色，开箱即用、不依赖 monorepo 布局），
// 再退回工作区根（兼容原始 .claude/agents 在 monorepo 顶层的老布局）。返回首个存在的绝对路径，否则 null。
export function resolveEmpFile(rel) {
  if (!rel) return null
  for (const base of [OFFICE_ROOT, WORKSPACE_ROOT]) {
    const abs = path.join(base, rel)
    if (fs.existsSync(abs)) return abs
  }
  return null
}

// 启动日志/诊断用的一行形态描述（排查路径问题的第一现场）。
export function describeWorkspace() {
  return `mode=${WORKSPACE_MODE} workspace=${WORKSPACE_ROOT} office=${OFFICE_ROOT} prefix='${OFFICE_PREFIX}'`
}
