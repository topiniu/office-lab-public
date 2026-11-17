import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleMorningReport, reportGaps, appendItemDecision, settleAtDeadline, VERSION_STATES, deriveItems } from '../morning-report.js'
import { parseContract, emptyLedger, recordToolCall, judgeToolCall, checkBudget, deriveFakeGreen, recordItemResult, bumpDevQaRound } from '../guard-ledger.js'
import { reconcileRelease, CHAIN_LINKS, rollbackPlan } from '../release-chain.js'

const CONTRACT_TEXT = `\`\`\`yaml
mode: guarded_run
run_name: 2026-08-26-guarded-01
starts_at: 2026-08-26T01:00:00+08:00
deadline: 2026-08-26T08:00:00+08:00
selection:
  max_items: 3
  max_changed_repositories: 2
authorization:
  commit_development_branches: true
limits:
  max_dev_qa_rounds_per_item: 2
  max_tokens: null
forbidden:
  - force_push
exit:
  target: rc_ready
\`\`\``
const contract = parseContract(CONTRACT_TEXT)
const full = over => ({ ...Object.fromEntries(CHAIN_LINKS.map(k => [k, true])), ...over })

function ledgerWithAll() {
  const led = emptyLedger('2026-08-26-guarded-01')
  recordToolCall(led, { employee: 'ggbond', tool: 'Bash', ...judgeToolCall(contract, 'Bash', { command: 'git push --force origin x' }) })
  recordToolCall(led, { employee: 'mihu', tool: 'Read', ...judgeToolCall(contract, 'Read', {}) })
  recordToolCall(led, { employee: 'ggbond', tool: 'Edit', ...judgeToolCall(contract, 'Edit', { file_path: 'app/x.js' }) })
  led.overBudget = checkBudget(contract, { devQaRoundsByItem: { 'REQ-0301': 3 }, tokens: 98_000, itemsTaken: 2, changedRepositories: ['fe'] })
  led.fakeGreen = deriveFakeGreen([{ facetId: 'REQ-0301-F2', status: 'COVERED_GREEN', greenOk: false }], null)
  led.usage = { itemsTaken: 2, changedRepositories: ['fe'], tokens: 98_000, devQaRoundsByItem: { 'REQ-0301': 3 } }
  return led
}
const ITEMS = [
  { req: 'REQ-0301', result: 'rc_ready', commit: 'abc1234567', green: 8, facetTotal: 8, redCalibrated: true, devQaRounds: 3, humanInherent: '导出 xlsx 内文' },
  { req: 'REQ-0302', result: 'parked', stopWhy: '口径 open：存量要不要回填', proposal: '按"只做新增行"执行' },
  { req: 'REQ-0303', result: 'quarantined', stopWhy: '2 轮 DEV↔QA 未过', evidencePath: 'runs/x/summary.json', branch: 'feature/v5.20-req-0303' },
]

test('晨检包出得来，且三红灯出现在「一眼摘要」的显眼处', () => {
  const md = assembleMorningReport({ runName: 'r1', version: 'v5.20', contract, items: ITEMS, ledger: ledgerWithAll(), usage: { itemsTaken: 2, changedRepositories: ['fe'] } })
  assert.match(md, /type: guarded-run-morning-report/)
  assert.match(md, /assembled_by: engine/)
  assert.match(md, /guard\.violation\.forbidden_action/)
  assert.match(md, /🚨/)
  assert.ok(md.indexOf('一眼摘要') < md.indexOf('逐条目结果'))
})
test('agent 自述单列并标注「不作放行依据」（被 reward-hack 出 GREEN 的 agent 会照样报 GREEN）', () => {
  const md = assembleMorningReport({ contract, items: ITEMS, selfReports: [{ employee: '迷糊老师', text: '我这轮 8 个 facet 全绿。' }] })
  assert.match(md, /不作放行依据/)
  assert.match(md, /（自述，非机器事实）/)
  assert.ok(md.indexOf('机器事实') < md.indexOf('agent 自述栏'))
})
test('停靠条目逐条给可复核事实；park 了却没给拟定口径要被点名', () => {
  const md = assembleMorningReport({ contract, items: [...ITEMS, { req: 'REQ-0304', result: 'parked', stopWhy: 'x' }] })
  assert.match(md, /runs\/x\/summary\.json/)
  assert.match(md, /feature\/v5\.20-req-0303/)
  assert.match(md, /park 了却没给拟定口径/)
})
test('停靠却没写原因 → 明说「这本身是问题」', () => {
  const md = assembleMorningReport({ contract, items: [{ req: 'R', result: 'quarantined' }] })
  assert.match(md, /没写停靠原因（这本身是问题/)
})
test('契约 vs 实际 diff 里只读动作不计入判定、unlisted 单列供抽查', () => {
  const md = assembleMorningReport({ contract, items: ITEMS, ledger: ledgerWithAll(), usage: { itemsTaken: 2, changedRepositories: ['fe'] } })
  assert.match(md, /只读动作 1 次（不计入判定）/)
  assert.match(md, /写类动作但契约未涉及/)
})
test('max_tokens 未设时摘要里写「未设」而不是留空', () => {
  const md = assembleMorningReport({ contract, items: ITEMS, ledger: ledgerWithAll(), tokens: 98_000 })
  assert.match(md, /\*\*未设\*\*（契约 max_tokens: null/)
})
// 「量不到」和「0」在纸面上长得一样 —— 这正是 §21.3 反复在治的那类假健康值。
test('token 量不到时印「量不到」，绝不印 0', () => {
  const md = assembleMorningReport({ contract, items: ITEMS, ledger: ledgerWithAll(), usage: { tokensUnmeasured: 5 } })
  assert.match(md, /⚠ \*\*量不到\*\*（SDK 有 5 轮 result 未带 usage）/)
  assert.ok(!/token \/ 熔断上限 \| 0 /.test(md))
})
test('量到了就报真数（usage.tokens 与显式 tokens 都认）', () => {
  assert.match(assembleMorningReport({ contract, items: ITEMS, usage: { tokens: 12345, tokensMeasured: true } }), /\| 12345 \//)
  assert.match(assembleMorningReport({ contract, items: ITEMS, tokens: 999 }), /\| 999 \//)
})
test('RC commit 未记录时点名 B1 未落地（证据没绑不可变版本）', () => {
  assert.match(assembleMorningReport({ contract, items: ITEMS }), /证据没绑不可变版本，B1 未落地/)
})
test('回退方案里的 prev 会自动回填到摘要的「上一个可回退版本」（同一事实不用两处各填一次）', () => {
  const md = assembleMorningReport({ contract, items: ITEMS, rollback: rollbackPlan({ prevTag: 'v5.19', services: ['service(8040)'], ddlReversible: true }) })
  assert.match(md, /上一个可回退版本 \| `v5\.19`/)
})
test('半发布会在发布对账章节被点名', () => {
  const rec = reconcileRelease([{ req: 'A', facts: full({}) }, { req: 'B', facts: full({ content: false }) }])
  assert.match(assembleMorningReport({ contract, items: ITEMS, releaseChain: rec }), /半发布形态/)
})
test('猪猪能力缺位 → 显式列出「哪些门开不了」，并说明结论只能记未验证', () => {
  const probe = { map: { verifyEvidence: { label: 'verify_evidence', z: 'Z-D', available: false, why: 'HTTP 404' }, preflight: { label: 'preflight', z: 'Z-A', available: true, why: '' } }, missing: ['verifyEvidence'], ready: ['preflight'] }
  const md = assembleMorningReport({ contract, items: ITEMS, zhuzhuProbe: probe })
  assert.match(md, /本轮哪些机器门是开的/)
  assert.match(md, /1 项能力缺位/)
  assert.match(md, /一律记「未验证」，不记「通过」/)
})
test('0 条目也出包（不许静默不出）', () => {
  const md = assembleMorningReport({ contract, items: [] })
  assert.match(md, /本轮 0 条目/)
  assert.match(md, /老板三选一/)
})
test('必答区（park ≥2 轮）出现在决策段，一句话就能推动', () => {
  const md = assembleMorningReport({ contract, items: ITEMS, park: [{ req: 'REQ-0304', rounds: 3, proposal: 'A 案', repeatedProposal: true, probeKey: '口径', reason: 'x' }] })
  assert.match(md, /必答区/)
  assert.match(md, /拟定口径一字未变/)
})
test('不满足 RC_READY 放行门时，在「整版通过」之前先警示', () => {
  const md = assembleMorningReport({ contract, items: ITEMS, gateBlocked: ['缺 cross-entry 类 facet（medium 级必需）'] })
  assert.match(md, /暂不满足 RC_READY 放行门/)
})

// ---------- 缺料自检 ----------
test('reportGaps 逐条列出因缺料而缺席的章节（但包照出）', () => {
  const g = reportGaps({})
  assert.ok(g.some(x => /三红灯台账缺失/.test(x)))
  assert.ok(g.some(x => /发布链对账缺失/.test(x)))
  assert.ok(g.some(x => /RC commit 未记录/.test(x)))
  assert.ok(g.some(x => /本轮 0 条目/.test(x)))
})
test('料齐时无缺口', () => {
  const g = reportGaps({ ledger: emptyLedger('r'), releaseChain: {}, trust: {}, rcCommit: 'abc', rollback: {}, qaReportCard: 'x', items: ITEMS, archiveRel: 'tasks/a.md', version: 'v5.20' })
  assert.deepEqual(g, [])
})
// 缺料清单以前只出现在给 agent 的返回文本里、没写进包 —— 前端 toast 却已经在对老板说「已在包里如实标注」。
test('缺料清单必须印在包里（缺席≠通过），且 0 条目要说清为什么', () => {
  const md = assembleMorningReport({ contract, items: [], zeroItemsWhy: '契约点名 0 条、台账无 itemResults' })
  assert.match(md, /本包缺了哪些料/)
  assert.match(md, /缺席的章节一律按「未接通\/未记录」读/)
  assert.match(md, /为什么 0 条.*契约点名 0 条/)
  assert.ok(md.indexOf('本包缺了哪些料') < md.indexOf('一眼摘要'))
})
test('deadline 结算动作写进包（不再只打 console）', () => {
  const md = assembleMorningReport({ contract, items: ITEMS, settleActions: [{ code: 'defer_items', why: 'B 未达 RC_READY → 明确顺延' }] })
  assert.match(md, /deadline 到点强制结算/)
  assert.match(md, /`defer_items`/)
})
test('多仓 RC commit 是整行、不许被截断成半个仓名', () => {
  const md = assembleMorningReport({ contract, items: ITEMS, rcCommit: 'backend@feature/v5.20 `abc1234567`　fe-supplier@feature/v5.20 `def8901234`' })
  assert.match(md, /fe-supplier@feature\/v5\.20/)
  assert.match(assembleMorningReport({ contract, items: ITEMS, rcCommit: 'abc1234567def' }), /\| `abc1234567de` \|/)
})

// ---------- 条目结果的机器派生（2026-08-28：itemResults 全仓只读不写，条目表恒为空）----------
test('deriveItems：契约点名 + 台账 + park + 覆盖矩阵合成条目表，agent 填报只补空', () => {
  const led = emptyLedger('r')
  led.itemResults = { 'REQ-0318': { req: 'REQ-0318', result: 'rc_ready' } }
  led.gateDecisions = { 'REQ-0318': { item: 'REQ-0318', riskClass: 'low' } }
  led.usage.devQaRoundsByItem = { 'REQ-0318': 2 }
  const ev = { commit: 'c0ffee1234' }
  const rows = [
    { req: 'REQ-0318', facetId: 'REQ-0318-F1', status: 'COVERED_GREEN', green: ev, redOk: true },
    { req: 'REQ-0318', facetId: 'REQ-0318-F2', status: 'HUMAN_INHERENT' },
    { req: 'REQ-0271', facetId: 'REQ-0271-F1', status: 'COVERED_GREEN', green: ev, redOk: true },   // 跨轮共用档案里的别轮条目
  ]
  const items = deriveItems({
    contract: { selection: { named_items: ['REQ-0313', 'REQ-0318'] } },
    ledger: led, rows, startedAt: '2026-08-27T18:30:00+08:00',
    park: [
      { req: 'REQ-0313', reason: '口径待拍', proposal: '默认(A)', lastAt: '2026-08-27T20:00:00+08:00' },
      { req: 'REQ-0304', reason: '历史 park', proposal: 'x', lastAt: '2026-08-20T10:00:00+08:00' },   // 上轮的，不该混进来
    ],
    agentItems: [{ req: 'REQ-0318', green: 99, humanInherent: 'agent 说的' }],
  })
  assert.deepEqual(items.map(i => i.req), ['REQ-0313', 'REQ-0318'], '只取本轮范围：别轮 REQ-0271 与历史 park 都不进')
  const f = items.find(i => i.req === 'REQ-0318')
  assert.equal(f.result, 'rc_ready')
  assert.equal(f.green, 1, 'agent 填的 99 不许覆盖覆盖矩阵算出的绿数')
  assert.equal(f.facetTotal, 2)
  assert.equal(f.commit, 'c0ffee1234')
  assert.equal(f.devQaRounds, 2)
  assert.match(f.humanInherent, /REQ-0318-F2/)
  const p = items.find(i => i.req === 'REQ-0313')
  assert.equal(p.result, 'parked')
  assert.equal(p.proposal, '默认(A)')
})
test('deriveItems：没人显式记结果时按覆盖矩阵判（全处置=rc_ready，否则在途）', () => {
  const named = { selection: { named_items: ['REQ-1'] } }
  const rows = [{ req: 'REQ-1', facetId: 'REQ-1-F1', status: 'COVERED_GREEN', green: {}, redOk: true }]
  assert.equal(deriveItems({ contract: named, rows })[0].result, 'rc_ready')
  // HUMAN_INHERENT 是「机器本来就测不了、等的就是人验收」＝守航终点 awaiting_human_acceptance，不算没到
  assert.equal(deriveItems({ contract: named, rows: [...rows, { req: 'REQ-1', facetId: 'REQ-1-F2', status: 'HUMAN_INHERENT' }] })[0].result, 'rc_ready')
  // UNCOVERED / SOURCE_ATTESTED（弱证据，F1 列为可疑）一律算没到
  assert.equal(deriveItems({ contract: named, rows: [...rows, { req: 'REQ-1', facetId: 'REQ-1-F2', status: 'UNCOVERED' }] })[0].result, 'in_progress')
  assert.equal(deriveItems({ contract: named, rows: [...rows, { req: 'REQ-1', facetId: 'REQ-1-F2', status: 'SOURCE_ATTESTED' }] })[0].result, 'in_progress')
  // 一条 facet 都没有 → 不许凭空说到位
  assert.equal(deriveItems({ contract: named, rows: [] })[0].result, 'in_progress')
})

// ---------- E3 版本冻结与追加 ----------
test('未到 RC_READY 可直接追加', () => {
  const d = appendItemDecision({ versionState: 'in_dev', newItems: ['REQ-9'] })
  assert.equal(d.allowed, true)
  assert.equal(d.needsResign, false)
})
test('已达 RC_READY 后追加 → 必须重签契约 + 显式回退，且默认建议独立成版', () => {
  const d = appendItemDecision({ versionState: 'rc_ready', newItems: ['REQ-9', 'REQ-10'], currentRunName: 'r1', reason: '老板临时加' })
  assert.equal(d.allowed, false)
  assert.equal(d.needsResign, true)
  assert.equal(d.options[0].key, 'new_version')
  assert.match(d.why, /v5\.19 就是这么把 3 条已 RC_READY 的拖了 4 天/)
  assert.match(d.confirmText, /会让已经能发的条目一起等/)
})
test('已发测/已上线的版本同样按「需重签」处理（比 rc_ready 更严不更松）', () => {
  for (const st of ['released_test', 'released_prod']) assert.equal(appendItemDecision({ versionState: st, newItems: ['X'] }).allowed, false)
  assert.deepEqual(VERSION_STATES.slice(-2), ['released_test', 'released_prod'])
})

// ---------- E3 deadline 结算 ----------
const DL = '2026-08-26T08:00:00+08:00'
const at = s => Date.parse(s)
test('未到点不结算，并给出还剩多少分钟', () => {
  const s = settleAtDeadline({ deadlineIso: DL, now: at('2026-08-26T07:00:00+08:00') })
  assert.equal(s.due, false)
  assert.equal(s.minutesLeft, 60)
})
test('到点必出晨检包（现在到点什么都不发生——这就是 E3 要治的）', () => {
  const s = settleAtDeadline({ deadlineIso: DL, now: at('2026-08-26T08:00:01+08:00'), items: [{ req: 'A', result: 'rc_ready' }] })
  assert.equal(s.due, true)
  assert.ok(s.actions.some(a => a.code === 'write_morning_report'))
})
test('已达 RC_READY 的条目 → 版本状态要跟着置 rc_ready，不许停在 in_dev', () => {
  const s = settleAtDeadline({ deadlineIso: DL, now: at('2026-08-26T09:00:00+08:00'), versionState: 'in_dev', items: [{ req: 'A', result: 'rc_ready' }], reportWritten: true })
  assert.ok(s.actions.some(a => a.code === 'set_version_rc_ready'))
})
test('未达 RC_READY 的条目 → 明确顺延并点名，不许无声挂着', () => {
  const s = settleAtDeadline({ deadlineIso: DL, now: at('2026-08-26T09:00:00+08:00'), items: [{ req: 'A', result: 'rc_ready' }, { req: 'B', result: 'parked' }], reportWritten: true })
  const d = s.actions.find(a => a.code === 'defer_items')
  assert.deepEqual(d.items, ['B'])
  assert.match(d.why, /不许无声挂着/)
})
test('0 条目到点 → 必须显式说明「为什么一条都没做」（guarded-02 那次没有任何说明）', () => {
  const s = settleAtDeadline({ deadlineIso: DL, now: at('2026-08-26T09:00:00+08:00'), items: [], reportWritten: true })
  assert.ok(s.actions.some(a => a.code === 'report_zero_items'))
})
test('deadline 无法解析时不结算，但明说这本身该修', () => {
  const s = settleAtDeadline({ deadlineIso: '不是时间' })
  assert.equal(s.due, false)
  assert.match(s.why, /这本身该修/)
})

// ---------- 台账侧：itemResults 的写入语义 ----------
test('recordItemResult：结果只许前进，rc_ready 不会被后来的 risk_gate 冲回 in_progress', () => {
  const led = emptyLedger('r')
  recordItemResult(led, 'req-0318', { result: 'in_progress', riskClass: 'low' })
  recordItemResult(led, 'REQ-0318', { result: 'rc_ready', commit: 'abc' })
  recordItemResult(led, 'REQ-0318', { result: 'in_progress' })
  assert.equal(led.itemResults['REQ-0318'].result, 'rc_ready')
  assert.equal(led.itemResults['REQ-0318'].commit, 'abc')
  assert.equal(led.itemResults['REQ-0318'].riskClass, 'low')
})
test('recordItemResult：登记表裸序号不进条目账（晨检包按 REQ 编号对账）', () => {
  const led = emptyLedger('r')
  assert.equal(recordItemResult(led, '3', { result: 'rc_ready' }), null)
  assert.deepEqual(led.itemResults, {})
})
test('bumpDevQaRound：打回一次记一轮（limits.max_dev_qa_rounds_per_item 此前从没有过输入）', () => {
  const led = emptyLedger('r')
  bumpDevQaRound(led, 'REQ-0318')
  bumpDevQaRound(led, 'REQ-0318')
  assert.equal(led.usage.devQaRoundsByItem['REQ-0318'], 2)
})

test('deriveItems：老板写 req-316、facet 表写 REQ-0316 —— 必须归一成一条，不许两行', () => {
  const items = deriveItems({
    contract: { selection: { named_items: ['req-316', 'req-317'] } },
    rows: [{ req: 'REQ-0316', facetId: 'REQ-0316-F1', status: 'COVERED_GREEN', green: {}, redOk: true }],
  })
  assert.deepEqual(items.map(i => i.req), ['REQ-0316', 'REQ-0317'])
  assert.equal(items[0].green, 1)
})
test('deriveItems：park 与证据打架不静默选边（证据更晚→按证据算并点名）', () => {
  const named = { selection: { named_items: ['REQ-0316'] } }
  const rows = [{ req: 'REQ-0316', facetId: 'REQ-0316-F1', status: 'COVERED_GREEN', green: { runId: '20260827100000-f4aee5' }, redOk: true }]
  const park = [{ req: 'REQ-0316', reason: '等 DDL 授权', proposal: 'x', lastAt: '2026-08-27T10:00:00+08:00' }]
  const [a] = deriveItems({ contract: named, rows, park })
  assert.equal(a.result, 'rc_ready')
  assert.match(a.note, /park 记录已过期/)
  // 反过来：park 比证据新 → 保持 park，但同样点名
  const [b] = deriveItems({ contract: named, rows, park: [{ ...park[0], lastAt: '2026-08-27T23:00:00+08:00' }] })
  assert.equal(b.result, 'parked')
  assert.match(b.note, /之后又被 park/)
})
test('deriveItems：猪猪的 session-20260827-182259-… 也要认出时间（只认引擎格式会让 park 永远显得更新）', () => {
  const named = { selection: { named_items: ['REQ-0316'] } }
  const rows = [{ req: 'REQ-0316', facetId: 'REQ-0316-F1', status: 'COVERED_GREEN', redOk: true, green: { runId: 'session-20260827-182259-a00d85a5-round-1' } }]
  const [a] = deriveItems({ contract: named, rows, park: [{ req: 'REQ-0316', reason: '等授权', lastAt: '2026-08-27T10:17:55' }] })
  assert.equal(a.result, 'rc_ready', '18:22 的证据晚于 10:17 的 park')
})
test('deriveItems：同一天两轮守航时，后一轮 park 的新条目不许混进前一轮的包（deadline 只拦新条目）', () => {
  const win = { startedAt: '2026-08-27T01:55:00+08:00', endedAt: '2026-08-27T08:00:00+08:00' }
  const named = { selection: { named_items: ['REQ-0317'] } }
  const park = [
    { req: 'REQ-0313', reason: '这是下一轮 park 的', lastAt: '2026-08-27T18:39:00+08:00' },
    { req: 'REQ-0317', reason: '到点顺延（引擎在 deadline 之后自动记的）', lastAt: '2026-08-27T08:05:00+08:00' },
  ]
  const items = deriveItems({ contract: named, park, ...win })
  assert.deepEqual(items.map(i => i.req), ['REQ-0317'])
  assert.match(items[0].stopWhy, /到点顺延/, '本轮已在册的条目，deadline 之后的 park 仍要收')
})
