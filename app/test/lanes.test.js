import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  portsForSlot, normalizeLaneId, allocSlot, defaultBranch, normTaskFile, laneForTask, umiLocalConfig,
  defaultTargets, resolveTargets, parseStatusHeader, parseWorktreeList, toMsys, toWinFwd, renderLaneBlock,
  createLaneManager, MAX_SLOT, MARK, SERVICES, shellDevConfig, patchShellUmirc,
} from '../lanes.js'

// ---------- 纯函数 ----------
test('slot 1 的端口恰好是 Temu 手工旁路那组（8002/18040/18042/19981），slot 0 = 主检出原端口', () => {
  const p1 = portsForSlot(1)
  assert.equal(p1['fe-supplier'], 8002)
  assert.equal(p1.service, 18040)
  assert.equal(p1['gys-web'], 18042)
  assert.equal(p1.xxl, 19981)
  const p0 = portsForSlot(0)
  assert.deepEqual([p0['fe-supplier'], p0['fe-cj'], p0.service, p0.web, p0['gys-web']], [8000, 8001, 8040, 8041, 8042])
})
test('各槽位端口两两不撞（前端 step=2 让两个 app 不互占；step=0 的固定端口除外）', () => {
  const seen = new Set()
  for (let k = 0; k <= MAX_SLOT; k++) for (const [svc, v] of Object.entries(portsForSlot(k))) {
    if (SERVICES[svc]?.step === 0) continue
    assert.ok(!seen.has(v), `端口 ${v} 重复`)
    seen.add(v)
  }
})
test('lane id 归一且拒 main / 过短', () => {
  assert.deepEqual(normalizeLaneId(' Temu_Batch '), { ok: true, id: 'temu-batch' })
  assert.equal(normalizeLaneId('main').ok, false)
  assert.equal(normalizeLaneId('x').ok, false)
  assert.equal(normalizeLaneId('跟单').ok, false)   // 纯中文清空后过短
})
test('allocSlot 取最小空位，满了给 0', () => {
  assert.equal(allocSlot([]), 1)
  assert.equal(allocSlot([{ slot: 1 }, { slot: 3 }]), 2)
  assert.equal(allocSlot([{ slot: 1 }, { slot: 2 }, { slot: 3 }]), 0)
})
test('分支名按 monorepo 规范生成', () => {
  assert.equal(defaultBranch({ version: 'v0.1.0', feature: 'temu batch' }), 'feature/v0.1.0-temu-batch-lab')
  assert.equal(defaultBranch({ version: '', feature: 'x' }), '')
})
test('任务档案绑定：office-lab/ 前缀有无都认', () => {
  const lanes = [{ id: 'temu', taskFile: 'office-lab/tasks/a.md' }]
  assert.equal(normTaskFile('office-lab\\tasks\\a.md'), 'tasks/a.md')
  assert.equal(laneForTask(lanes, 'tasks/a.md')?.id, 'temu')
  assert.equal(laneForTask(lanes, 'office-lab/tasks/a.md')?.id, 'temu')
  assert.equal(laneForTask(lanes, 'tasks/b.md'), null)
  assert.equal(laneForTask(lanes, ''), null)
})
test('.umirc.local.ts 带标记、代理指向本槽位 gys-web', () => {
  const s = umiLocalConfig(portsForSlot(2))
  assert.ok(s.includes(MARK))
  assert.ok(s.includes("'/gys-web-app-web'"))
  assert.ok(s.includes('http://localhost:28042/'))
})
test('默认 targets：gys-web 跟 GYS 前端、web 跟供应商前端，不无脑三个全起', () => {
  assert.deepEqual(defaultTargets(['backend', 'fe-supplier']), ['fe-supplier', 'service', 'gys-web'])
  assert.deepEqual(defaultTargets(['backend', 'fe-cj']), ['fe-cj', 'service', 'web'])
  assert.deepEqual(defaultTargets(['backend']), ['service', 'gys-web'])
  assert.deepEqual(defaultTargets(['fe-supplier']), ['fe-supplier'])
})
test('独立站工程：auxiliary-api 8097+10000×槽位、中台外壳按 2 平移、组件中心固定 8899', () => {
  const p1 = portsForSlot(1)
  assert.equal(p1.cba, 18097)
  assert.equal(p1.kjglzt, 8108)
  assert.equal(p1.cc, 8899)
  assert.equal(portsForSlot(3).cc, 8899)
  assert.deepEqual(defaultTargets(['iwo', 'fe-cc']), ['cba', 'kjglzt', 'cc'])
  assert.deepEqual(defaultTargets(['fe-cc']), ['cc'])
  assert.deepEqual(resolveTargets({ id: 'x', repos: { iwo: {} } }, ['all']).targets, ['cba', 'kjglzt'])
  assert.equal(resolveTargets({ id: 'x', repos: { iwo: {} } }, ['cc']).ok, false)
})
test('中台本地 dev 配置只放代理、不重写 qiankun apps（umi 合并数组是追加）', () => {
  const s = shellDevConfig(portsForSlot(1))
  assert.ok(s.includes(MARK))
  assert.ok(s.includes('http://localhost:18097'))
  const code = s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.ok(!/apps|qiankun/.test(code))
})
test('中台 .umirc.ts 补丁：两个地址表各补 dev 键、去掉手打的旧 dev 行、可重复执行', () => {
  const src = [
    "const ENTRYMAP: { [n: string]: string } = {",
    "  test: '//rms.test/',",
    "  local: '//rms.test/',",
    "  dev: '//old/', // 手打的",
    "};",
    "const ZJKMAP: { [n: string]: string } = {",
    "  local: '//zjk.test/',",
    "};",
    "const OTHER = {",
    "  local: 'x',",
    "};",
  ].join('\n')
  const out = patchShellUmirc(src, 8899)
  const devs = out.split('\n').filter(l => /^\s+dev:/.test(l))
  assert.equal(devs.length, 2)
  assert.ok(devs[0].includes('api.example.test') && devs[0].includes(MARK))
  assert.ok(devs[1].includes('//localhost:8899/'))
  assert.ok(!out.includes('//old/'))
  assert.equal(patchShellUmirc(out, 8899), out)
  assert.ok(patchShellUmirc(out, 8901).includes('//localhost:8901/') && !patchShellUmirc(out, 8901).includes('//localhost:8899/'))
})
test('【运行环境】块：独立站工程给出中台登录入口，QA 的被测 origin 是中台', () => {
  const lane = { id: 'temu', slot: 1, repos: { iwo: { path: 'D:/w/temu-iwo' }, 'fe-cc': { path: 'D:/w/temu-cc' } } }
  const qa = renderLaneBlock(lane, { employee: 'mihu' })
  assert.ok(qa.includes('http://localhost:8108'))
  assert.ok(qa.includes('auxiliary-api :18097'))
  assert.ok(qa.includes(':8899'))
})
test('resolveTargets 拒 lane 里没有的仓对应的服务', () => {
  const lane = { id: 'x', repos: { 'fe-supplier': {} } }
  assert.equal(resolveTargets(lane, ['service']).ok, false)
  assert.deepEqual(resolveTargets(lane, ['all']).targets, ['fe-supplier'])
  assert.deepEqual(resolveTargets(lane, []).targets, ['fe-supplier'])
})
test('git status -b 首行解析', () => {
  assert.deepEqual(parseStatusHeader('## feat/x...origin/feat/x [ahead 1, behind 2]'), { branch: 'feat/x', upstream: 'origin/feat/x', ahead: 1, behind: 2 })
  assert.deepEqual(parseStatusHeader('## feature/0.1.3-通知管理-lab'), { branch: 'feature/0.1.3-通知管理-lab', upstream: '', ahead: 0, behind: 0 })
  assert.equal(parseStatusHeader('## HEAD (no branch)').branch, '(detached)')
  assert.equal(parseStatusHeader('## No commits yet on main').branch, 'main')
})
test('worktree list --porcelain 解析', () => {
  const t = 'worktree D:/a\nHEAD abc\nbranch refs/heads/release\n\nworktree D:/w/b\nHEAD def\ndetached\n'
  assert.deepEqual(parseWorktreeList(t), [{ path: 'D:/a', head: 'abc', branch: 'release' }, { path: 'D:/w/b', head: 'def', branch: '' }])
})
test('路径形态：bash 吃 /d/…，powershell 吃 D:/…', { skip: process.platform !== 'win32' }, () => {
  assert.equal(toMsys('D:\\Workspace\\x'), '/d/Workspace/x')
  assert.equal(toWinFwd('D:\\Workspace\\x'), 'D:/Workspace/x')
})
test('【运行环境】块：旁路 lane 给 QA 换 origin、给开发指 lane_up 而非 rebuild_restart_backend', () => {
  const lane = { id: 'temu', title: 'Temu', version: 'v0.1.0', slot: 1, repos: { backend: { path: 'D:/w/temu-be', branch: 'b' }, 'fe-supplier': { path: 'D:/w/temu-fe', branch: 'b' } } }
  const qa = renderLaneBlock(lane, { employee: 'mihu' })
  assert.ok(qa.includes('http://localhost:8002'))
  assert.ok(qa.includes('不是本工作区'))
  const dev = renderLaneBlock(lane, { employee: 'ggbond', status: { services: { service: { alive: true } }, backend: { stale: true, builtSha: 'aaa', headSha: 'bbb' } } })
  assert.ok(dev.includes('lane_up({lane:"temu"'))
  assert.ok(dev.includes('不要用 rebuild_restart_backend'))
  assert.ok(dev.includes('已陈旧'))
  assert.ok(dev.includes('.umirc.local.ts'))
  const main = renderLaneBlock({ id: 'main', slot: 0, repos: { backend: { path: 'D:/p/b' } } }, { employee: 'mihu', others: [{ id: 'temu', title: 'Temu' }] })
  assert.ok(main.includes('主检出'))
  assert.ok(main.includes('`temu`'))
  assert.equal(renderLaneBlock(null), '')
})

// ---------- 真 git：建树 / 认领 / 收树（在临时目录里，不碰真仓） ----------
function sh(cwd, ...args) { return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString() }
function mkRepo(ws, rel, { nodeModules = false } = {}) {
  const bare = path.join(ws, '_remotes', rel.replace(/\//g, '_') + '.git')
  fs.mkdirSync(bare, { recursive: true })
  sh(bare, 'init', '--bare', '-q')
  const dir = path.join(ws, rel)
  fs.mkdirSync(dir, { recursive: true })
  sh(dir, 'init', '-q', '-b', 'release')
  sh(dir, 'config', 'user.email', 't@t'); sh(dir, 'config', 'user.name', 't')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.umirc.local.ts\n')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
  sh(dir, 'add', '.'); sh(dir, 'commit', '-q', '-m', 'init')
  sh(dir, 'remote', 'add', 'origin', bare)
  sh(dir, 'push', '-q', 'origin', 'release')
  if (nodeModules) { fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true }); fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), '1') }
  return dir
}

test('建树→认领→拒收脏树→收树：junction 拆掉、主检出 node_modules 完好、分支保留', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-'))
  const runsDir = path.join(ws, '_runs'); fs.mkdirSync(runsDir)
  try {
    const be = mkRepo(ws, 'backend')
    const fe = mkRepo(ws, 'frontend/web-app', { nodeModules: true })
    const mgr = createLaneManager({ workspaceRoot: ws, runsDir, manageBackendSh: '/nope', manageFrontendPs1: '/nope' })

    // 主检出虚拟 lane 只收存在的仓
    assert.deepEqual(Object.keys(mgr.get('main').repos).sort(), ['backend', 'fe-supplier'])

    const r = await mgr.create({ id: 'Demo', title: 'Demo', version: 'v0.0.1', feature: 'demo', repos: ['backend', 'fe-supplier'], taskFile: 'tasks/demo.md', by: 'test', slot: 3 })   // 显式 slot 3：本机 slot 1 可能正被真实旁路实例占着
    assert.equal(r.ok, true, r.error)
    assert.equal(r.lane.slot, 3)
    const wtBe = path.join(ws, '.worktrees', 'demo-be'), wtFe = path.join(ws, '.worktrees', 'demo-fe')
    assert.equal(sh(wtBe, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature/v0.0.1-demo-lab')
    // --no-track：新分支上游不是 origin/release
    assert.throws(() => sh(wtBe, 'rev-parse', '--abbrev-ref', '@{u}'))
    assert.ok(fs.lstatSync(path.join(wtFe, 'node_modules')).isSymbolicLink(), 'node_modules 应是 junction')
    assert.ok(fs.readFileSync(path.join(wtFe, '.umirc.local.ts'), 'utf8').includes('38042'))
    assert.equal(mgr.load()[0].taskFile, 'office-lab/tasks/demo.md')

    // 重名拒
    assert.equal((await mgr.create({ id: 'demo', branch: 'x', repos: ['backend'] })).ok, false)

    // 认领：另一条 lane 用同一分支 → 直接登记已有工作树、不另建
    const adopt = await mgr.create({ id: 'demo2', branch: 'feature/v0.0.1-demo-lab', repos: ['backend'] })
    assert.equal(adopt.ok, true, adopt.error)
    assert.equal(adopt.lane.repos.backend.adopted, true)
    assert.ok(!fs.existsSync(path.join(ws, '.worktrees', 'demo2-be')))
    assert.equal((await mgr.remove('demo2', { keepWorktrees: true })).ok, true)
    assert.ok(fs.existsSync(wtBe), '只移除登记时工作树保留')

    // 主检出所在分支不许拿来开 lane
    assert.equal((await mgr.create({ id: 'bad', branch: 'release', repos: ['backend'] })).ok, false)

    // 状态：分支 / 脏 / 服务未起
    const st = (await mgr.status('demo'))[0]
    assert.equal(st.repos.backend.branch, 'feature/v0.0.1-demo-lab')
    assert.equal(st.repos.backend.dirty, 0)
    assert.equal(st.services['gys-web'].port, 38042)
    assert.equal(st.backend.stale, false)

    // 脏树拒收
    // 已跟踪文件改动 → 「未提交」；未跟踪文件单独计、不混进「未提交」（主检出里的 BOOT-INF/ 残留曾被误报成未提交）
    fs.writeFileSync(path.join(wtBe, 'a.txt'), 'changed')
    const st2 = (await mgr.status('demo'))[0]
    assert.equal(st2.repos.backend.dirty, 1)
    assert.equal(st2.repos.backend.untracked, 0)
    const refuse = await mgr.remove('demo')
    assert.equal(refuse.ok, false)
    assert.match(refuse.error, /未提交/)
    sh(wtBe, 'checkout', '--', 'a.txt')
    fs.writeFileSync(path.join(wtBe, 'b.txt'), 'dirty')
    const st3 = (await mgr.status('demo'))[0]
    assert.equal(st3.repos.backend.dirty, 0)
    assert.equal(st3.repos.backend.untracked, 1)
    assert.deepEqual(st3.repos.backend.untrackedList, ['b.txt'])
    const refuseU = await mgr.remove('demo')
    assert.equal(refuseU.ok, false)
    assert.match(refuseU.error, /未跟踪/)
    // 提交了但没推 → 仍拒
    sh(wtBe, 'config', 'user.email', 't@t'); sh(wtBe, 'config', 'user.name', 't')
    sh(wtBe, 'add', '.'); sh(wtBe, 'commit', '-q', '-m', 'x')
    const refuse2 = await mgr.remove('demo')
    assert.equal(refuse2.ok, false)
    assert.match(refuse2.error, /没推/)
    sh(wtBe, 'push', '-q', '-u', 'origin', 'feature/v0.0.1-demo-lab')

    const rm = await mgr.remove('demo')
    assert.equal(rm.ok, true, rm.error)
    assert.ok(!fs.existsSync(wtBe) && !fs.existsSync(wtFe), '工作树应已移除')
    assert.ok(fs.existsSync(path.join(fe, 'node_modules', 'pkg', 'index.js')), '主检出 node_modules 必须完好（junction 先拆）')
    assert.ok(sh(be, 'branch', '--list', 'feature/v0.0.1-demo-lab').includes('feature/v0.0.1-demo-lab'), '分支保留')
    assert.equal(mgr.load().length, 0)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

// ---------- 第二轮（2026-09-28）：展示名 / 自动 id / 未指定环境 ----------
import { branchLabel, laneDisplayName, suggestLaneId } from '../lanes.js'
test('展示名：别名优先；主检出按分支取名；工作区退回 id', () => {
  assert.equal(branchLabel('feature/0.1.3-通知管理-lab'), '0.1.3-通知管理')
  assert.equal(laneDisplayName({ id: 'main' }, { backend: { branch: 'feature/0.1.3-通知管理-lab' } }), '0.1.3-通知管理')
  assert.equal(laneDisplayName({ id: 'main', title: '预检环境' }, { backend: { branch: 'x' } }), '预检环境')
  assert.equal(laneDisplayName({ id: 'main' }, null), '主检出')
  assert.equal(laneDisplayName({ id: 'temu' }), 'temu')
})
test('自动 id：功能短名 > 分支去前后缀与版本号 > wt-版本；撞名加序号、不撞 main', () => {
  assert.equal(suggestLaneId({ branch: 'feature/v0.1.0-temu-batch-activity-lab' }), 'temu-batch-activity')
  assert.equal(suggestLaneId({ feature: 'Temu Batch' }), 'temu-batch')
  assert.equal(suggestLaneId({ feature: '跟单', version: 'v0.1.3' }), 'wt-v0-1-3')
  assert.equal(suggestLaneId({ feature: 'temu' }, ['temu', 'temu-2']), 'temu-3')
  assert.equal(suggestLaneId({ feature: 'main' }), 'wt-main')
})
test('未指定运行环境：明说「未指定」、指向 lane_status，并列出其它工作区', () => {
  const main = { id: 'main', slot: 0, repos: { backend: { path: 'D:/p/b' } } }
  const s = renderLaneBlock(main, { employee: 'feifei', bound: false, status: { repos: { backend: { branch: 'feature/0.1.3-通知管理-lab' } } }, others: [{ id: 'temu' }] })
  assert.ok(s.includes('未指定'))
  assert.ok(s.includes('0.1.3-通知管理'))
  assert.ok(s.includes('lane_status'))
  assert.ok(s.includes('`temu`'))
  const bound = renderLaneBlock(main, { employee: 'feifei', bound: true, others: [] })
  assert.ok(!bound.includes('未指定') && bound.includes('本会话绑定**主检出**'))
})
