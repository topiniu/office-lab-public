// app/paths.js 的回归测试：工作区根探测 + L(协议前缀)↔P(物理路径) 互转 + 三候选解析。
//
// 缘起 2026-08-24（老板要求「仓库搬到其他电脑能开箱即用」）：原 server.js 的
// `ROOT = path.resolve(__dirname,'..','..')` 写死「office-lab 的父目录」，独立 clone 后 ROOT 会逃到仓库外，
// 而它正是员工 agent 的 cwd。详见 paths.js 顶部的「三层路径语义」与复盘 §3.102。
//
// paths.js 的导出是 import 时算定的常量，故每种形态都用「改 env + 带 ?v= 的动态 import」重新求值
// （ESM 模块缓存按解析后的 URL 作键，加 query 即得到全新实例）。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const HERE = path.resolve(import.meta.dirname, '..')            // …/office-lab/app
const OFFICE = path.resolve(HERE, '..')                          // …/office-lab
const PARENT = path.resolve(OFFICE, '..')                        // monorepo 顶层
const GRANDPARENT = path.resolve(PARENT, '..')
const IS_MONOREPO = ['frontend', 'backend', 'manage-backend.sh'].some(f => fs.existsSync(path.join(PARENT, f)))
const AUTO_ROOT = IS_MONOREPO ? PARENT : OFFICE

let _v = 0
// 以指定 OFFICE_LAB_WORKSPACE_ROOT 载入一份全新的 paths.js（undefined = 不设、走自动探测）
async function load(workspaceRoot) {
  const prev = process.env.OFFICE_LAB_WORKSPACE_ROOT
  if (workspaceRoot === undefined) delete process.env.OFFICE_LAB_WORKSPACE_ROOT
  else process.env.OFFICE_LAB_WORKSPACE_ROOT = workspaceRoot
  try { return await import(`../paths.js?v=${++_v}`) }
  finally {
    if (prev === undefined) delete process.env.OFFICE_LAB_WORKSPACE_ROOT
    else process.env.OFFICE_LAB_WORKSPACE_ROOT = prev
  }
}

// ---------- 形态探测 ----------

test('自动探测适应当前检出形态，不要求工作树在 monorepo 下', async () => {
  const P = await load(undefined)
  assert.equal(P.WORKSPACE_MODE, IS_MONOREPO ? 'monorepo' : 'standalone')
  assert.equal(P.WORKSPACE_ROOT, AUTO_ROOT)
  assert.equal(P.OFFICE_ROOT, OFFICE)
  assert.equal(P.OFFICE_PREFIX, IS_MONOREPO ? path.basename(OFFICE) : '')
})

test('独立夹具验证 standalone 与 monorepo 自动探测', async t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lab-path-fixture-')))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'office-lab'), app = path.join(root, 'app')
  fs.mkdirSync(app, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}')
  fs.copyFileSync(path.join(HERE, 'paths.js'), path.join(app, 'paths.js'))
  const prev = process.env.OFFICE_LAB_WORKSPACE_ROOT
  delete process.env.OFFICE_LAB_WORKSPACE_ROOT
  try {
    const uri = pathToFileURL(path.join(app, 'paths.js')).href
    const alone = await import(uri + '?standalone')
    assert.equal(alone.WORKSPACE_ROOT, root)
    assert.equal(alone.WORKSPACE_MODE, 'standalone')
    fs.mkdirSync(path.join(temp, 'frontend'))
    const nested = await import(uri + '?nested')
    assert.equal(nested.WORKSPACE_ROOT, temp)
    assert.equal(nested.WORKSPACE_MODE, 'monorepo')
  } finally { if (prev !== undefined) process.env.OFFICE_LAB_WORKSPACE_ROOT = prev }
})

test('★ 最重要的安全属性：嵌套且目录同名时 toAgentPath 必须恒等（原机器行为一字不变）', async () => {
  const P = await load(PARENT)
  assert.equal(P.OFFICE_PREFIX, path.basename(OFFICE))
  for (const s of [
    '去读 `office-lab/tasks/2026-08-21-v5.19.md` 这份档案',
    'office-lab/app/uploads/a.png｜截图',
    '〖截图〗office-lab/app/uploads/x.png〖/截图〗',
    'office-lab/templates/task-archive.md 与 office-lab/roles/feifei.md',
  ]) assert.equal(P.toAgentPath(s), s.replaceAll('office-lab/', path.basename(OFFICE) + '/'))
})

test('env 覆盖指向仓根 → 独立语义（mode=env，前缀为空）', async () => {
  const P = await load(OFFICE)
  assert.equal(P.WORKSPACE_MODE, 'env')
  assert.equal(P.WORKSPACE_ROOT, OFFICE)
  assert.equal(P.OFFICE_PREFIX, '')
})

test('env 覆盖指向更上一层 → 多段前缀', async () => {
  const P = await load(GRANDPARENT)
  assert.equal(P.WORKSPACE_MODE, 'env')
  assert.equal(P.OFFICE_PREFIX, `${path.basename(PARENT)}/${path.basename(OFFICE)}`)
})

test('env 无效（不包含 office-lab / 不存在）→ 落回自动探测，不接受', async () => {
  for (const bad of [path.join(OFFICE, 'app'), path.join(OFFICE, '这个目录不存在-xyz')]) {
    const P = await load(bad)
    assert.notEqual(P.WORKSPACE_MODE, 'env', `不该接受 ${bad}`)
    assert.equal(P.WORKSPACE_ROOT, AUTO_ROOT)
  }
})

// ---------- L→P 改写 ----------

test('独立模式：office-lab/ 前缀整段剥掉', async () => {
  const { toAgentPath } = await load(OFFICE)
  assert.equal(toAgentPath('读 office-lab/tasks/x.md'), '读 tasks/x.md')
  assert.equal(toAgentPath('`office-lab/app/uploads/a.png`'), '`app/uploads/a.png`')
  assert.equal(toAgentPath('office-lab/roles/feifei.md'), 'roles/feifei.md')
})

test('多段前缀：换成真实相对路径', async () => {
  const { toAgentPath } = await load(GRANDPARENT)
  assert.equal(toAgentPath('office-lab/tasks/x.md'), `${path.basename(PARENT)}/${path.basename(OFFICE)}/tasks/x.md`)
})

test('只替换路径起始位置的那一段，不吃相似串', async () => {
  const { toAgentPath } = await load(OFFICE)
  // 前面紧邻 \w . / - 的都不算路径起始 → 原样保留
  assert.equal(toAgentPath('my-office-lab/x'), 'my-office-lab/x')
  assert.equal(toAgentPath('docs/office-lab/x'), 'docs/office-lab/x')
  assert.equal(toAgentPath('a.office-lab/x'), 'a.office-lab/x')
  assert.equal(toAgentPath('xoffice-lab/x'), 'xoffice-lab/x')
  // 不带斜杠的裸词（仓库名/产品名）不该被动
  assert.equal(toAgentPath('office-lab 这个项目'), 'office-lab 这个项目')
  // 各种分隔符后的才算
  assert.equal(toAgentPath('（office-lab/tasks/x.md）'), '（tasks/x.md）')
  assert.equal(toAgentPath('见「office-lab/tasks/x.md」'), '见「tasks/x.md」')
})

test('幂等：重复调用无副作用（roleText 会被改写两次）', async () => {
  const { toAgentPath } = await load(OFFICE)
  const once = toAgentPath('office-lab/tasks/x.md')
  assert.equal(toAgentPath(once), once)
})

test('非字符串与空值安全', async () => {
  const { toAgentPath } = await load(OFFICE)
  for (const v of [null, undefined, 42, {}, []]) assert.equal(toAgentPath(v), v)
  assert.equal(toAgentPath(''), '')
})

// ---------- officeRel / stripOfficePrefix ----------

test('officeRel 产出 L 形式（协议形式），与形态无关', async () => {
  for (const ws of [undefined, OFFICE, GRANDPARENT]) {
    const { officeRel } = await load(ws)
    assert.equal(officeRel('app', 'runs'), 'office-lab/app/runs')
    assert.equal(officeRel('tasks'), 'office-lab/tasks')
    assert.equal(officeRel('/app/', '/uploads/'), 'office-lab/app/uploads')
  }
})

test('stripOfficePrefix 认协议常量与物理前缀，无前缀返回 null', async () => {
  const { stripOfficePrefix } = await load(OFFICE)
  assert.equal(stripOfficePrefix('office-lab/tasks/x.md'), 'tasks/x.md')
  assert.equal(stripOfficePrefix('office-lab'), '.')
  assert.equal(stripOfficePrefix('office-lab/'), '.')
  assert.equal(stripOfficePrefix('tasks/x.md'), null)          // 已是仓内相对
  assert.equal(stripOfficePrefix('docs/示例项目需求/x.md'), null)
  assert.equal(stripOfficePrefix(''), null)
  assert.equal(stripOfficePrefix(null), null)
  assert.equal(stripOfficePrefix('office-lab\\tasks\\x.md'), 'tasks/x.md')   // 反斜杠归一
})

// ---------- R 层：三候选解析 ----------

test('独立模式：L 形式与仓内相对形式都能解析到同一个真实文件', async () => {
  const { resolveRepoFile } = await load(OFFICE)
  const want = path.join(OFFICE, 'CLAUDE.md')
  assert.equal(resolveRepoFile('office-lab/CLAUDE.md'), want, '存量数据的 L 形式（406 条 taskFile 就是这个形状）')
  assert.equal(resolveRepoFile('CLAUDE.md'), want, '仓内相对形式')
  assert.equal(resolveRepoFile('roles/feifei.md'), path.join(OFFICE, 'roles', 'feifei.md'))
  assert.equal(resolveRepoFile('这个文件不存在.md'), null)
})

test('嵌套模式：L 形式仍走工作区根（= 原行为），仓内相对形式也能读到', async () => {
  const { resolveRepoFile } = await load(undefined)
  assert.equal(resolveRepoFile('office-lab/CLAUDE.md'), path.join(OFFICE, 'CLAUDE.md'))
  assert.equal(resolveRepoFile('roles/feifei.md'), path.join(OFFICE, 'roles', 'feifei.md'))
})

test('越权：.. 穿越一律拒绝（safeResolve 抛、resolveRepoFile 返回 null）', async () => {
  for (const ws of [undefined, OFFICE]) {
    const { safeResolve, resolveRepoFile, repoCandidates } = await load(ws)
    for (const bad of ['../secret.md', '../../etc/passwd', 'office-lab/../../x']) {
      assert.deepEqual(repoCandidates(bad), [], `${bad} 不该有任何候选`)
      assert.equal(resolveRepoFile(bad), null)
      assert.throws(() => safeResolve(bad), /path outside repo/)
    }
  }
})

test('safeResolve 对尚不存在的文件回首候选（保留「允许写新文件」的旧行为）', async () => {
  const { safeResolve } = await load(OFFICE)
  assert.equal(safeResolve('tasks/全新档案-xyz.md'), path.join(OFFICE, 'tasks', '全新档案-xyz.md'))
})

test('safeResolve 修掉存量 bug：嵌套模式下仓内相对路径不再解析到 monorepo 顶层', async () => {
  const { safeResolve } = await load(undefined)
  // 改动前：path.resolve(ROOT,'roles/feifei.md') → <monorepo>/roles/feifei.md（不存在，读抛 ENOENT / 写落错地方）
  assert.equal(safeResolve('roles/feifei.md'), path.join(OFFICE, 'roles', 'feifei.md'))
})

test('候选顺序：工作区相对 → 仓内相对 → 剥前缀后仓内相对', async () => {
  const { repoCandidates } = await load(PARENT)
  const c = repoCandidates('office-lab/tasks/x.md')
  assert.equal(c[0], path.join(PARENT, 'office-lab', 'tasks', 'x.md'))
  assert.ok(c.includes(path.join(OFFICE, 'tasks', 'x.md')), '剥前缀后的候选必须在（独立模式下靠它命中存量）')
})

test('describeWorkspace 一行带齐四要素（排查第一现场）', async () => {
  const P = await load(OFFICE)
  const d = P.describeWorkspace()
  for (const k of ['mode=', 'workspace=', 'office=', 'prefix=']) assert.ok(d.includes(k), `缺 ${k}`)
})
