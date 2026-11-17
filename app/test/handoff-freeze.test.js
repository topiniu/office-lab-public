import test from 'node:test'
import assert from 'node:assert/strict'
import { freezeCheck, renderFreezeBlock, impactRadar, renderImpactRadar, worktreePlan, WORKTREE_ROOT, ddlPrecheck, renderDdlPrecheck, DDL_CHECKLIST, draftImplementationRecord } from '../handoff-freeze.js'

const CLEAN = { repo: 'backend', branch: 'feature/v5.20-lab', head: 'a'.repeat(40), dirtyFiles: [], stagedFiles: [], remoteExists: true, aheadOfRemote: 0 }

// ---------- B1 交接即冻结 ----------
test('干净且已 push → 冻结通过，给出可写进交接卡的 sha', () => {
  const r = freezeCheck(CLEAN)
  assert.equal(r.ok, true)
  assert.equal(r.sha, 'a'.repeat(40))
  assert.match(r.handoffLine, /backend@feature\/v5\.20-lab/)
  assert.match(renderFreezeBlock(r), /冻结版本/)
})
test('有未提交改动 → 拒绝，并列出文件（v5.19 那 4 条 REQ 就是这么躺到发测才被发现）', () => {
  const r = freezeCheck({ ...CLEAN, dirtyFiles: ['a.java', 'b.tsx'] })
  assert.equal(r.ok, false)
  assert.equal(r.blockers[0].code, 'uncommitted')
  assert.match(r.blockers[0].why, /a\.java/)
  assert.match(r.blockers[0].why, /允许 `wip:` 提交/)
})
test('已 staged 但未 commit 同样算未提交（staged ≠ 冻结）', () => {
  assert.equal(freezeCheck({ ...CLEAN, stagedFiles: ['x.java'] }).ok, false)
})
test('只 commit 未 push → 拒绝，并点名那次 release MR「no commits yet」', () => {
  const r = freezeCheck({ ...CLEAN, aheadOfRemote: 3 })
  assert.equal(r.ok, false)
  assert.equal(r.blockers[0].code, 'unpushed')
  assert.match(r.blockers[0].why, /只 commit 未 push/)
})
test('远端还没有这条分支 → 拒绝并给出 push -u 命令', () => {
  const r = freezeCheck({ ...CLEAN, remoteExists: false })
  assert.equal(r.blockers[0].code, 'no-remote-branch')
  assert.match(r.blockers[0].why, /git push -u origin feature\/v5\.20-lab/)
})
test('多仓时逐仓判定，一个仓脏不影响另一个仓被记为已冻结', () => {
  const r = freezeCheck([CLEAN, { ...CLEAN, repo: 'fe-supplier', dirtyFiles: ['x.tsx'] }])
  assert.equal(r.ok, false)
  assert.equal(r.frozen.length, 1)
  assert.equal(r.frozen[0].repo, 'backend')
})
test('未提交的仓不再重复报「未 push」（先解决最前面的那道）', () => {
  const r = freezeCheck({ ...CLEAN, dirtyFiles: ['x'], aheadOfRemote: 5 })
  assert.equal(r.blockers.length, 1)
})
test('渲染里明说「改码即新 commit → 自动作废受影响 facet 证据」', () => {
  assert.match(renderFreezeBlock(freezeCheck({ ...CLEAN, dirtyFiles: ['x'] })), /自动作废受影响的 facet 证据/)
})

// ---------- B3 影响面雷达 ----------
const IDX = [
  { facetId: 'REQ-1-F1', files: ['src/pages/a.tsx'], components: ['btn-review'], caseIds: ['c1'] },
  { facetId: 'REQ-1-F2', files: ['src/pages/b.tsx'], components: [], caseIds: ['c2'] },
  { facetId: 'REQ-1-F3', files: [], components: ['btn-part-order'], caseIds: ['c3'] },
]
const EM = { 'btn-part-order': ['src/pages/order.tsx', 'src/pages/detail.tsx'] }

test('实现文件被改 → 该 facet 证据作废，并给出重跑用例', () => {
  const r = impactRadar({ diffFiles: ['src/pages/a.tsx'], facetIndex: IDX, evidenceByFacet: { 'REQ-1-F1': { commit: 'old12345678', runId: 'r1' } }, newCommit: 'new98765432' })
  assert.deepEqual(r.toUncovered, ['REQ-1-F1'])
  assert.deepEqual(r.rerunCaseIds, ['c1'])
  assert.equal(r.invalidated[0].staleEvidenceCommit, 'old12345678')
  assert.ok(r.keptFresh.includes('REQ-1-F2'))
})
test('复用组件的任一实现文件被改 → 该组件的 facet 也作废，并列出受影响入口', () => {
  const r = impactRadar({ diffFiles: ['src/pages/detail.tsx'], entryMap: EM, facetIndex: IDX })
  assert.deepEqual(r.toUncovered, ['REQ-1-F3'])
  assert.deepEqual(r.affectedEntries, ['src/pages/detail.tsx', 'src/pages/order.tsx'])
  assert.match(r.invalidated[0].why, /复用组件被改/)
})
test('没命中任何 facet 时明说「没有作废任何证据」（别让人误以为漏算了）', () => {
  const r = impactRadar({ diffFiles: ['README.md'], facetIndex: IDX })
  assert.equal(r.invalidated.length, 0)
  assert.match(renderImpactRadar(r), /没有作废任何已签发的 facet 证据/)
})
test('路径分隔符差异（Windows 反斜杠）不影响命中', () => {
  const r = impactRadar({ diffFiles: ['src\\pages\\a.tsx'], facetIndex: IDX })
  assert.deepEqual(r.toUncovered, ['REQ-1-F1'])
})
test('重跑清单去重（多个 facet 共用一条用例时不重复列）', () => {
  const idx = [{ facetId: 'F1', files: ['a'], caseIds: ['c1'] }, { facetId: 'F2', files: ['a'], caseIds: ['c1'] }]
  assert.deepEqual(impactRadar({ diffFiles: ['a'], facetIndex: idx }).rerunCaseIds, ['c1'])
})
test('渲染带「抄送迷糊的重跑清单」（B3 要的就是自动抄送）', () => {
  const md = renderImpactRadar(impactRadar({ diffFiles: ['src/pages/a.tsx'], facetIndex: IDX, newCommit: 'abc1234567' }))
  assert.match(md, /抄送迷糊的重跑清单/)
  assert.match(md, /已自动打回 UNCOVERED|打回 UNCOVERED/)
})

// ---------- B2 worktree ----------
test('每条目一棵树，路径落在 .claude/worktrees 下', () => {
  const p = worktreePlan(['REQ-0301', { req: 'REQ-0302', branch: 'wt/custom' }], { baseBranch: 'feature/v5.20-lab' })
  assert.equal(p.plans.length, 2)
  assert.ok(p.plans[0].path.startsWith(WORKTREE_ROOT))
  assert.equal(p.plans[1].branch, 'wt/custom')
  assert.match(p.hint, /不动正在被测的那棵/)
})
test('单条目时说明可不开 worktree，但仍须 B1 冻结', () => {
  assert.match(worktreePlan(['REQ-1']).hint, /仍须 B1 冻结/)
})
test('req 里的非法字符被 slug 化，不生成非法路径', () => {
  const p = worktreePlan(['REQ 0301/存量 回填'])
  assert.ok(!/[/\s]/.test(p.plans[0].name))
})

// ---------- B5 DDL 前置核查 ----------
test('五项齐备才 ok', () => {
  const all = Object.fromEntries(DDL_CHECKLIST.map(c => [c.key, 'done']))
  assert.equal(ddlPrecheck(all).ok, true)
  assert.equal(ddlPrecheck({}).missing.length, DDL_CHECKLIST.length)
  assert.match(ddlPrecheck({}).summary, /缺 5 项/)
})
test('回填行数/主数据触碰把风险顶到 high', () => {
  assert.equal(ddlPrecheck({ backfillRows: 10635 }).escalateHigh, true)
  assert.equal(ddlPrecheck({ productionData: true }).escalateHigh, true)
  assert.equal(ddlPrecheck({ backfillRows: 10 }).escalateHigh, false)
})
test('渲染逐项写「为什么必须」（不是空清单）', () => {
  const md = renderDdlPrecheck(ddlPrecheck({}), {})
  assert.match(md, /MySQL 5\.7 不支持窗口函数/)
  assert.match(md, /DMS 拦临时表/)
  assert.match(md, /10,635 行/)
})

// ---------- B7 实施记录初稿 ----------
test('初稿把「改了什么」填好、「为什么」留 ★ 给人补', () => {
  const md = draftImplementationRecord({
    version: 'v5.20', reqs: [{ req: 'REQ-0301', title: '损耗率默认值' }],
    diffStat: { 'src/a.tsx': { added: 12, removed: 3 } },
    commits: [{ sha: 'abcdef1234', subject: 'feat: x' }],
    builds: [{ target: 'service', ok: true }], smokes: [{ endpoint: '/api/x', ok: true, status: 200 }],
  })
  assert.match(md, /为什么这么改（★人补）/)
  assert.match(md, /abcdef1234/)
  assert.match(md, /\+12\/-3/)
  assert.match(md, /性能自检结论/)          // CLAUDE.md 强制项被带进清单
  assert.match(md, /机器写不了的部分/)
})
test('文件数超上限时截断且明说（不静默吞）', () => {
  const diffStat = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`f${i}.java`, { added: 1, removed: 0 }]))
  assert.match(draftImplementationRecord({ diffStat }), /另有 10 个文件/)
})
test('无任何输入时也出一份可用骨架（不炸、不空白）', () => {
  const md = draftImplementationRecord({})
  assert.match(md, /实施记录初稿/)
  assert.match(md, /待人补/)
})
