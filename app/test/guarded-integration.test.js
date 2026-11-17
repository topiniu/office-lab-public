// 守航链路的端到端串联测试：真契约文件 → 三红灯台账 → 覆盖矩阵 → 晨检包 → 发布对账。
// 为什么单独一个文件：各模块的单测只证「这一块对」，但方案的价值在**串起来**——
// 「契约里写着 forbidden，员工真的越了，晨检包里真的有那一行」这条链断在任何一环都等于没建。
// 这里用临时目录 + 真文件走一遍（不启动 server，故仍是 `node --test` 可跑的纯测试）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseContract, emptyLedger, recordToolCall, judgeToolCall, checkBudget, deriveFakeGreen, redLightTotals } from '../guard-ledger.js'
import { extractFacetsFromDoc, extractCoverageMatrix, mergeFacetRows, engineSetFacetRow, engineSeedCoverage } from '../coverage.js'
import { assembleMorningReport, settleAtDeadline } from '../morning-report.js'
import { reconcileRelease, CHAIN_LINKS } from '../release-chain.js'
import { fakeGreenHunt } from '../audit-trust.js'
import { guardedScopeDecision, rcReadyGate } from '../gate-matrix.js'
import { recordPark, crossEntryFacets } from '../requirement-pool.js'
import { impactRadar, freezeCheck } from '../handoff-freeze.js'
import { buildFactSheet, validateRewrite } from '../qa-report-card.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ol-guard-'))

const CONTRACT = `---
type: guarded-run-contract
---

# 守航任务契约 · 2026-08-26-guarded-01

\`\`\`yaml
mode: guarded_run
run_name: 2026-08-26-guarded-01
starts_at: 2026-08-26T01:00:00+08:00
deadline: 2026-08-26T08:00:00+08:00

selection:
  source: ready_pool_then_triage
  max_items: 2
  allowed_risk_class: [low, medium]
  max_changed_repositories: 2

authorization:                           # 只有列 true 的动作被允许；未列即禁
  create_task_archive: true
  commit_development_branches: true
  run_automated_tests: true
  deploy_test_environment: false
  deploy_production: false

limits:
  max_dev_qa_rounds_per_item: 2
  max_runtime_minutes: 480
  max_tokens: 2000000

forbidden:
  - production_release
  - destructive_git
  - force_push
  - external_side_effects

exit:
  target: rc_ready
  produce_morning_report: true
  settle_at_deadline: true
\`\`\`
`

const FACET_DOC = `# 需求说明与验收标准 · v5.20

| facet ID | 需求 | 层级 | 分类 | 验收标准 |
|----------|------|------|------|---------|
| REQ-0301-F1 | REQ-0301 | P0 | auto | 新建品类后在尺寸表页可被选中 |
| REQ-0301-F2 | REQ-0301 | P1 | auto | 选中后能生成全码尺寸表 |
| REQ-0301-F3 | REQ-0301 | P1 | human | 导出 xlsx 单元格内文正确 |
`

const ARCHIVE = `---
type: task-archive
version: v5.20
status: QA_IN_PROGRESS
facet_doc: docs/facet.md
gates:
  released_test: false
  released_prod: false
---

# 任务档案 · v5.20

## 时间线

- 2026-08-26 立账
`

function fixture() {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'contract.md'), CONTRACT)
  fs.writeFileSync(path.join(dir, 'facet.md'), FACET_DOC)
  fs.writeFileSync(path.join(dir, 'archive.md'), ARCHIVE)
  return dir
}

test('端到端①：契约文件 → 解析 → 越权/超预算/假绿三盏灯都进得了晨检包', () => {
  const dir = fixture()
  const contract = parseContract(fs.readFileSync(path.join(dir, 'contract.md'), 'utf8'))
  assert.equal(contract.run_name, '2026-08-26-guarded-01')
  assert.equal(contract.authorization.deploy_production, false)

  const led = emptyLedger(contract.run_name)
  // 员工真的做了这些动作
  for (const [tool, input] of [
    ['Read', { file_path: 'x.md' }],                                   // 只读：不该进红灯
    ['Bash', { command: 'git status' }],                               // 只读 bash：不该进红灯
    ['Bash', { command: 'git commit -m "wip: 交接冻结"' }],             // 授权内
    ['Bash', { command: 'git push --force origin feature/x' }],        // 越权①
    ['mcp__backend__deploy_test_environment', {}],                     // 越权②（authorization=false）
    ['Edit', { file_path: 'app/server.js' }],                          // 本职（unlisted）
  ]) recordToolCall(led, { employee: 'ggbond', tool, ...judgeToolCall(contract, tool, input) })

  assert.equal(led.toolCalls.read, 2)
  assert.equal(redLightTotals(led).forbidden_action, 2)
  assert.equal(led.unlisted.length, 1)

  // 超预算：同一条目 3 轮 > 上限 2
  led.usage = { devQaRoundsByItem: { 'REQ-0301': 3 }, itemsTaken: 2, changedRepositories: ['fe-supplier'], tokens: 2_500_000 }
  led.overBudget = checkBudget(contract, led.usage)
  assert.equal(redLightTotals(led).over_budget, 2)   // 轮次超 + token 超

  // 覆盖矩阵：F1 真绿、F2 证据不全（假绿）、F3 人工
  const abs = path.join(dir, 'archive.md')
  const facets = extractFacetsFromDoc(fs.readFileSync(path.join(dir, 'facet.md'), 'utf8'))
  assert.equal(facets.length, 3)
  engineSeedCoverage(abs, facets)
  const goodEv = 'runId=20260826010203-1ead52; case=c1; testHash=sha256:' + 'a'.repeat(64) + '; summaryHash=sha256:' + 'b'.repeat(64) + '; commit=abc1234567; env=test; summary=runs/x/summary.json'
  engineSetFacetRow(abs, { facetId: 'REQ-0301-F1', status: 'COVERED_GREEN', evidence: goodEv, red: goodEv })
  engineSetFacetRow(abs, { facetId: 'REQ-0301-F2', status: 'COVERED_GREEN', evidence: 'runId=x; case=c2' })
  engineSetFacetRow(abs, { facetId: 'REQ-0301-F3', status: 'HUMAN_INHERENT' })

  const rows = mergeFacetRows(facets, extractCoverageMatrix(fs.readFileSync(abs, 'utf8')))
  assert.equal(rows.length, 3)
  led.fakeGreen = deriveFakeGreen(rows, null)
  assert.equal(led.fakeGreen.count, 1, '证据不全的 F2 必须被判假绿')
  assert.equal(led.fakeGreen.hits[0].facetId, 'REQ-0301-F2')
  assert.equal(led.fakeGreen.unverified.length, 1, '证据完整但猪猪未接通的 F1 记「未验证」而不是通过')

  // 晨检包串起来
  const md = assembleMorningReport({
    runName: contract.run_name, version: 'v5.20', contract, ledger: led, usage: led.usage,
    items: [{ req: 'REQ-0301', result: 'rc_ready', commit: 'abc1234567', green: 1, facetTotal: 3, devQaRounds: 3 }],
    rcCommit: 'abc1234567',
    trust: fakeGreenHunt({ rows, verify: null, extra: { envFingerprintFresh: null } }),
    selfReports: [{ employee: '迷糊老师', text: '本轮 facet 全部通过。' }],
  })
  // 三盏灯的数字必须真出现在包里
  assert.match(md, /`guard\.violation\.forbidden_action`（须 0） \| \*\*2\*\* 🚨/)
  assert.match(md, /`guard\.fake_green`（须 0） \| \*\*1\*\* 🚨/)
  assert.match(md, /`guard\.violation\.over_budget`（须 0） \| \*\*2\*\* 🚨/)
  assert.match(md, /max_tokens 2500000 tokens > 上限 2000000 tokens/)
  // 越权明细点名到具体动作
  assert.match(md, /force_push|destructive_git/)
  assert.match(md, /deploy_test_environment/)
  // 自述与机器事实分离，且自述里那句「全部通过」不会污染机器结论
  assert.ok(md.indexOf('三红灯') < md.indexOf('agent 自述栏'))
  assert.match(md, /不作放行依据/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('端到端②：QA 后改码 → 影响面雷达作废证据 → 覆盖矩阵真被打回 UNCOVERED', () => {
  const dir = fixture()
  const abs = path.join(dir, 'archive.md')
  const facets = extractFacetsFromDoc(fs.readFileSync(path.join(dir, 'facet.md'), 'utf8'))
  engineSeedCoverage(abs, facets)
  const ev = 'runId=r1; case=c1; testHash=sha256:' + 'a'.repeat(64) + '; summaryHash=sha256:' + 'b'.repeat(64) + '; commit=oldsha1234; env=test; summary=s.json'
  engineSetFacetRow(abs, { facetId: 'REQ-0301-F1', status: 'COVERED_GREEN', evidence: ev, red: ev })

  const radar = impactRadar({
    diffFiles: ['src/pages/sizeChart.tsx'],
    facetIndex: [{ facetId: 'REQ-0301-F1', files: ['src/pages/sizeChart.tsx'], caseIds: ['c1'] }],
    evidenceByFacet: { 'REQ-0301-F1': { commit: 'oldsha1234', runId: 'r1' } },
    newCommit: 'newsha5678',
  })
  assert.deepEqual(radar.toUncovered, ['REQ-0301-F1'])
  assert.deepEqual(radar.rerunCaseIds, ['c1'])

  // 引擎真的写回矩阵（这一步是 B3 的「自动」，不是「提醒员工去改」）
  for (const fid of radar.toUncovered) engineSetFacetRow(abs, { facetId: fid, status: 'UNCOVERED', evidence: '', red: '' })
  const after = extractCoverageMatrix(fs.readFileSync(abs, 'utf8')).find(r => r.facetId === 'REQ-0301-F1')
  assert.equal(after.status, 'UNCOVERED')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('端到端③：high 风险条目机器升级后照样做完；进 RC_READY 仍要它那一级的全部 facet 与机器门', () => {
  const d = guardedScopeDecision({ executionMode: 'guarded_run', signals: { ddl: true, backfillRows: 10635, productionData: true }, declared: 'medium' })
  assert.equal(d.riskClass, 'high')
  assert.equal(d.escalated, true)
  assert.equal(d.allowImplementation, true)
  const full = rcReadyGate({ riskClass: d.riskClass, facetKinds: ['visual', 'cross-entry', 'data-migration'], gateResults: { 'page-error': true, 'env-fresh': true, discrimination: true, 'visual-baseline': true, 'ddl-precheck': true } })
  assert.equal(full.passed, true, '门都过了就能到 RC_READY')
  const noMig = rcReadyGate({ riskClass: d.riskClass, facetKinds: ['visual', 'cross-entry'], gateResults: { 'page-error': true, 'env-fresh': true, discrimination: true, 'visual-baseline': true, 'ddl-precheck': null } })
  assert.equal(noMig.passed, false, '缺数据迁移 facet / DDL 前置核查未验证 → 不算到 RC_READY')
})

test('端到端④：deadline 到点 → 出包 + 顺延清单 + 顺延项进 park 台账（≥2 轮升必答）', () => {
  const contract = parseContract(CONTRACT)
  const items = [{ req: 'REQ-0301', result: 'rc_ready' }, { req: 'REQ-0302', result: 'parked' }]
  const s = settleAtDeadline({ deadlineIso: contract.deadline, now: Date.parse('2026-08-26T08:30:00+08:00'), versionState: 'in_qa', items, reportWritten: false })
  assert.equal(s.due, true)
  const codes = s.actions.map(a => a.code)
  assert.ok(codes.includes('write_morning_report'))
  assert.ok(codes.includes('set_version_rc_ready'))
  assert.ok(codes.includes('defer_items'))

  // 顺延项进 park 台账；第二轮同样顺延即升必答
  let park = recordPark([], { req: 'REQ-0302', reason: 'deadline 到点未达 RC_READY', probeKey: '范围', proposal: '（引擎自动顺延）' }).entries
  const second = recordPark(park, { req: 'REQ-0302', reason: 'deadline 到点未达 RC_READY', probeKey: '范围', proposal: '（引擎自动顺延）' })
  assert.equal(second.escalate, true)
  assert.equal(second.entry.repeatedProposal, true)
})

test('端到端⑤：交接冻结 → 发布链对账 → released_prod 由机器派生（半发布被拦）', () => {
  const fz = freezeCheck({ repo: 'backend', branch: 'feature/v5.20-lab', head: 'c'.repeat(40), dirtyFiles: [], stagedFiles: [], remoteExists: true, aheadOfRemote: 0 })
  assert.equal(fz.ok, true)
  const full = over => ({ ...Object.fromEntries(CHAIN_LINKS.map(k => [k, true])), ...over })
  const rec = reconcileRelease([{ req: 'REQ-0301', facts: full({}) }, { req: 'REQ-0302', facts: full({ content: false }) }])
  assert.equal(rec.releasedProd, false, '任一条断链 → released_prod 必须是 false，人不许手写它')
  assert.equal(rec.halfReleased, true)
  assert.match(rec.results[1].displayStatus, /未上线/)
})

test('端到端⑥：跨入口 facet 生成 → 进 facet 全集 → QA 报告卡片认它为「已有事实」', () => {
  const entryMap = { 'sampling-part-order-select': ['priceReview', 'sampleReview', 'supplyChain', 'patternReview'] }
  const gen = crossEntryFacets(entryMap, ['sampling-part-order-select'], { reqId: 'REQ-0311', startIndex: 4 })
  assert.equal(gen.facets.length, 1)
  const rows = [{ facetId: gen.facets[0].id, req: 'REQ-0311', status: 'UNCOVERED', criterion: gen.facets[0].criterion }]
  const sheet = buildFactSheet({ version: 'v5.21', reqs: ['REQ-0311'], rows, reportCard: null })
  // 未覆盖项必须照抄，且提到这条 facet 不算「凭空多出事实」
  const draft = `${gen.facets[0].id} 这条跨入口一致性还没测（原因：需要猪猪 consistencyGroup 能力）。`
  const v = validateRewrite(draft, sheet)
  assert.equal(v.ok, true, JSON.stringify(v))
  // 漏写它就要被打回
  assert.equal(validateRewrite('本轮全都测了。', sheet).ok, false)
})

// ---------- 续跑轮（2026-09-18）：契约多了 carried_over_from + 非 2 的仓数上限，机器块必须照读 ----------
// 缘起：guarded-01 老板点名三条只走完一条，另两条 park 后没有回路。续跑轮的契约是那条回路的载体，
// 它的两处新字段若在 parseContract 掉了，checkBudget 会拿 undefined 当"没设上限"静默放过。
const RESUME_CONTRACT = `# 守航任务契约 · 2026-09-19-guarded-02

\`\`\`yaml
mode: guarded_run
run_name: 2026-09-19-guarded-02

selection:
  source: boss_named
  named_items: [REQ-0352, REQ-0353]
  carried_over_from: 2026-09-18-guarded-01
  max_items: 2
  max_changed_repositories: 3

limits:
  max_tokens: 2000000
\`\`\`
`
test('续跑契约：carried_over_from 与放宽后的仓数上限都读得到，且 3 仓不再算超预算', () => {
  const c = parseContract(RESUME_CONTRACT)
  assert.equal(c.selection.carried_over_from, '2026-09-18-guarded-01')
  assert.equal(c.selection.max_changed_repositories, 3)
  assert.deepEqual(c.selection.named_items, ['REQ-0352', 'REQ-0353'])
  // 正是 REQ-0353 被挡掉的那个形状：后端 + web-app + partner-app 三个仓
  const usage = { changedRepositories: ['backend', 'frontend/web-app', 'frontend/partner-app'], tokens: 10 }
  assert.equal(checkBudget(c, usage).filter(v => v.field === 'max_changed_repositories').length, 0)
  // 对照组：老的写死 2 会亮红灯——证明这道闸确实咬得到，改的是阈值不是把闸拆了
  const old = parseContract(RESUME_CONTRACT.replace('max_changed_repositories: 3', 'max_changed_repositories: 2'))
  assert.equal(checkBudget(old, usage).filter(v => v.field === 'max_changed_repositories').length, 1)
})
