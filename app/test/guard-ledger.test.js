import test from 'node:test'
import assert from 'node:assert/strict'
import { parseContract, classifyTool, judgeToolCall, checkBudget, deriveFakeGreen, emptyLedger, recordToolCall, redLightTotals, renderRedLights, DISCRIMINATIVE_FLOOR } from '../guard-ledger.js'

const CONTRACT = `# 守航契约

\`\`\`yaml
mode: guarded_run
run_name: 2026-08-26-guarded-01
starts_at: 2026-08-26T01:00:00+08:00
deadline: 2026-08-26T08:00:00+08:00

selection:
  source: ready_pool_then_triage   # 先从就绪池取
  max_items: 3
  max_changed_repositories: 2
  priority_order: [P0, P1, P2]

authorization:                     # 只有列 true 的动作被允许；未列即禁
  create_task_archive: true
  commit_development_branches: true
  run_automated_tests: true
  deploy_test_environment: false
  deploy_production: false

limits:
  max_dev_qa_rounds_per_item: 2
  max_runtime_minutes: 480
  max_tokens: null

forbidden:
  - production_release
  - destructive_git
  - force_push
  - external_side_effects
\`\`\`
`

// ---------- 契约解析 ----------
test('parseContract 解析嵌套 map / 列表 / 内联数组 / 行尾注释', () => {
  const c = parseContract(CONTRACT)
  assert.equal(c.mode, 'guarded_run')
  assert.equal(c.selection.max_items, 3)
  assert.deepEqual(c.selection.priority_order, ['P0', 'P1', 'P2'])
  assert.equal(c.selection.source, 'ready_pool_then_triage')   // 行尾注释被剥掉
  assert.equal(c.limits.max_tokens, null)
  assert.deepEqual(c.forbidden, ['production_release', 'destructive_git', 'force_push', 'external_side_effects'])
})

// 这一条是真踩过的坑：kv 正则的 `\s*` 吃掉冒号后空白，「值只有注释」时到达 stripComment 的是**以 # 开头**
// 的裸注释。旧实现把它当字符串存进 authorization → 子键全丢 → AUTH_MATCHERS 整张表静默失效。
test('「键: <只有注释>」必须当空值——否则 authorization 子键会被整块吞掉', () => {
  const c = parseContract(CONTRACT)
  assert.equal(typeof c.authorization, 'object')
  assert.equal(c.authorization.commit_development_branches, true)
  assert.equal(c.authorization.deploy_production, false)
})

test('parseContract 无 yaml 块时把整文当 yaml 试；空输入不炸', () => {
  assert.equal(parseContract('mode: guarded_run').mode, 'guarded_run')
  assert.deepEqual(parseContract(''), {})
  assert.deepEqual(parseContract(null), {})
})

// ---------- 工具三分类 ----------
test('只读工具 / 只读 bash / 只读 MCP 一律归 read（Stage4 一刀切误杀只读 MCP 的教训）', () => {
  assert.equal(classifyTool('Read', {}), 'read')
  assert.equal(classifyTool('Grep', {}), 'read')
  assert.equal(classifyTool('Bash', { command: 'git status --porcelain' }), 'read')
  assert.equal(classifyTool('Bash', { command: 'git log --oneline -5' }), 'read')
  assert.equal(classifyTool('mcp__zhuzhu__list_sessions', {}), 'read')
  assert.equal(classifyTool('mcp__guarded__guard_status', {}), 'read')
  assert.equal(classifyTool('mcp__release__enumerate_release', {}), 'read')
})
test('写工具与破坏性/外部 bash 分开归类', () => {
  assert.equal(classifyTool('Write', {}), 'write')
  assert.equal(classifyTool('Edit', {}), 'write')
  assert.equal(classifyTool('Bash', { command: 'git commit -m x' }), 'write')
  assert.equal(classifyTool('Bash', { command: 'rm -rf app' }), 'external')
  assert.equal(classifyTool('Bash', { command: 'git push origin main' }), 'external')
  assert.equal(classifyTool('Bash', { command: 'curl https://example.com/hook' }), 'external')
})
test('需求表读写归 write 而非 external——否则 A1 巡航每写一次就亮一盏假红灯', () => {
  assert.equal(classifyTool('mcp__feifei-caps__lark_update_requirement', {}), 'write')
  assert.equal(classifyTool('mcp__x__push_message', {}), 'external')
})
test('未知工具保守当写（只影响是否计数，不拦）', () => {
  assert.equal(classifyTool('SomeBrandNewTool', {}), 'write')
})
test('空 bash 命令不炸、归 read', () => {
  assert.equal(classifyTool('Bash', {}), 'read')
})

// ---------- judgeToolCall ----------
test('只读动作恒 pass 且不入红灯', () => {
  const c = parseContract(CONTRACT)
  const v = judgeToolCall(c, 'Read', { file_path: 'a.md' })
  assert.equal(v.verdict, 'pass')
  assert.equal(v.kind, 'read')
})
test('命中 forbidden → forbidden，并点名是哪一条', () => {
  const c = parseContract(CONTRACT)
  assert.equal(judgeToolCall(c, 'Bash', { command: 'git push --force origin x' }).code, 'destructive_git')
  assert.equal(judgeToolCall(c, 'Bash', { command: 'git push origin release' }).code, 'production_release')
  assert.equal(judgeToolCall(c, 'Bash', { command: 'rm -rf /' }).verdict, 'forbidden')
})
test('authorization=true 的动作放行、=false 的记越权', () => {
  const c = parseContract(CONTRACT)
  assert.equal(judgeToolCall(c, 'Bash', { command: 'git commit -m wip' }).verdict, 'pass')
  const dep = judgeToolCall(c, 'mcp__backend__deploy_test_environment', {})
  assert.equal(dep.verdict, 'forbidden')
  assert.match(dep.why, /deploy_test_environment=false/)
})
test('authorization 未列的动作按契约铁律「未列即禁」判 forbidden', () => {
  const c = parseContract(CONTRACT)
  const v = judgeToolCall(c, 'Bash', { command: 'git merge origin/master' })
  assert.equal(v.verdict, 'forbidden')
  assert.match(v.why, /未列 integrate_candidate_branch/)
})
test('写类但契约完全没涉及的动作 → unlisted，不计红灯（改用例/写实施记录是本职）', () => {
  const c = parseContract(CONTRACT)
  const v = judgeToolCall(c, 'Edit', { file_path: 'app/server.js' })
  assert.equal(v.verdict, 'unlisted')
})
test('空契约不炸：一切写动作落 unlisted、只读仍 pass', () => {
  assert.equal(judgeToolCall({}, 'Edit', {}).verdict, 'unlisted')
  assert.equal(judgeToolCall({}, 'Read', {}).verdict, 'pass')
})

// ---------- 预算 ----------
test('checkBudget 逐项比对上限并给出实际值', () => {
  const c = parseContract(CONTRACT)
  const v = checkBudget(c, { devQaRoundsByItem: { 'REQ-1': 3, 'REQ-2': 1 }, itemsTaken: 5, changedRepositories: ['a', 'b', 'c'], runtimeMinutes: 500 })
  const codes = v.filter(x => x.code === 'over_budget').map(x => x.field)
  assert.ok(codes.some(f => f.includes('REQ-1')))
  assert.ok(!codes.some(f => f.includes('REQ-2')))
  assert.ok(codes.includes('max_items'))
  assert.ok(codes.includes('max_changed_repositories'))
  assert.ok(codes.includes('max_runtime_minutes'))
})
test('max_tokens 为 null 时记 budget_unset（不静默消失——方案点名「四轮全空」）', () => {
  const c = parseContract(CONTRACT)
  const v = checkBudget(c, { tokens: 12345 })
  const unset = v.find(x => x.code === 'budget_unset')
  assert.ok(unset)
  assert.equal(unset.actual, 12345)
  assert.equal(redLightTotals({ overBudget: v }).over_budget, 0)   // budget_unset 不算红灯
})
test('max_tokens 有值时正常比对', () => {
  const c = parseContract(CONTRACT.replace('max_tokens: null', 'max_tokens: 1000'))
  const v = checkBudget(c, { tokens: 2000 })
  assert.equal(v.filter(x => x.code === 'over_budget').length, 1)
})

// ---------- 假绿 ----------
const G = (id, over = {}) => ({ facetId: id, status: 'COVERED_GREEN', greenOk: true, hasRed: true, green: { runId: 'run-' + id }, ...over })

test('猪猪缺位 → 逐条记 unverified 而不是放过（fail-open 会让红灯永远是 0）', () => {
  const r = deriveFakeGreen([G('REQ-1-F1'), G('REQ-1-F2')], null)
  assert.equal(r.count, 0)
  assert.equal(r.unverified.length, 2)
  assert.equal(r.verifyAvailable, false)
})
test('引擎自己能算的那半：GREEN 证据不完整直接判假绿（不依赖猪猪）', () => {
  const r = deriveFakeGreen([G('REQ-1-F1', { greenOk: false })], null)
  assert.equal(r.count, 1)
  assert.equal(r.hits[0].code, 'evidence_invalid')
})
test('verify 不通过 / failureClass≠value-assertion / 区分度低 / 页面报错 / 环境陈旧 各判一类假绿', () => {
  const rows = [G('A-F1'), G('A-F2'), G('A-F3'), G('A-F4'), G('A-F5'), G('A-F6')]
  const verify = {
    'A-F1': { ok: false, reason: '证据包哈希不匹配' },
    'A-F2': { ok: true, failureClass: 'action-failure' },
    'A-F3': { ok: true, failureClass: 'value-assertion', discriminativePower: 0.1 },
    'A-F4': { ok: true, failureClass: 'value-assertion', discriminativePower: 0.9, pageErrors: 3 },
    'A-F5': { ok: true, failureClass: 'value-assertion', discriminativePower: 0.9, envFresh: false },
    'A-F6': { ok: true, failureClass: 'value-assertion', discriminativePower: 0.9, pageErrors: 0, envFresh: true },
  }
  const r = deriveFakeGreen(rows, verify)
  const byId = Object.fromEntries(r.hits.map(h => [h.facetId, h.code]))
  assert.equal(byId['A-F1'], 'verify_failed')
  assert.equal(byId['A-F2'], 'red_not_value_assertion')
  assert.equal(byId['A-F3'], 'low_discrimination')
  assert.equal(byId['A-F4'], 'page_error')
  assert.equal(byId['A-F5'], 'stale_env')
  assert.equal(byId['A-F6'], undefined)   // 全过 → 不是假绿
  assert.equal(r.count, 5)
})
test('区分度正好等于阈值不算假绿（边界不误杀）', () => {
  const r = deriveFakeGreen([G('A-F1')], { 'A-F1': { ok: true, failureClass: 'value-assertion', discriminativePower: DISCRIMINATIVE_FLOOR } })
  assert.equal(r.count, 0)
})
test('非 GREEN 行不参与假绿判定（它们本就不算通过）', () => {
  const r = deriveFakeGreen([{ facetId: 'A-F1', status: 'SOURCE_ATTESTED' }, { facetId: 'A-F2', status: 'UNCOVERED' }], {})
  assert.equal(r.count, 0)
  assert.equal(r.unverified.length, 0)
})
test('verify map 用 runId 也能命中（facetId 缺位时的退路）', () => {
  const r = deriveFakeGreen([G('A-F1')], { 'run-A-F1': { ok: false, reason: 'x' } })
  assert.equal(r.count, 1)
})

// ---------- 台账与渲染 ----------
test('recordToolCall 按 verdict 分流并累计三类工具计数', () => {
  const led = emptyLedger('r1')
  recordToolCall(led, { tool: 'Read', verdict: 'pass', kind: 'read' })
  recordToolCall(led, { tool: 'Bash', verdict: 'forbidden', kind: 'external', code: 'force_push', why: 'x' })
  recordToolCall(led, { tool: 'Edit', verdict: 'unlisted', kind: 'write' })
  assert.deepEqual(led.toolCalls, { read: 1, write: 1, external: 1 })
  assert.equal(led.forbidden.length, 1)
  assert.equal(led.unlisted.length, 1)
  assert.equal(redLightTotals(led).forbidden_action, 1)
})
test('unlisted 明细有上限，不无限膨胀', () => {
  const led = emptyLedger('r1')
  for (let i = 0; i < 500; i++) recordToolCall(led, { tool: 'Edit', verdict: 'unlisted', kind: 'write' })
  assert.equal(led.unlisted.length, 200)
  assert.equal(led.toolCalls.write, 500)   // 计数不受明细上限影响
})
test('renderRedLights 三灯全 0 也出表（空表和「没统计过」在纸面上长得一样——那就等于没建）', () => {
  const md = renderRedLights(emptyLedger('r1'))
  assert.match(md, /guard\.violation\.forbidden_action/)
  assert.match(md, /guard\.fake_green/)
  assert.match(md, /三灯全 0/)
})
test('renderRedLights 在猪猪缺位时明说「只算了一半」', () => {
  const led = emptyLedger('r1')
  led.fakeGreen = deriveFakeGreen([G('A-F1')], null)
  assert.match(renderRedLights(led), /只算了引擎自己能算的那一半/)
})
test('renderRedLights 明细超 30 条时截断且不静默吞', () => {
  const led = emptyLedger('r1')
  for (let i = 0; i < 40; i++) led.forbidden.push({ tool: 't' + i, employee: 'x', at: '2026-08-26T01:00:00Z', why: 'w' })
  const md = renderRedLights(led)
  assert.match(md, /另有 10 条/)
})
test('renderRedLights 单列「未设硬顶」的预算项', () => {
  const led = emptyLedger('r1')
  led.overBudget = checkBudget(parseContract(CONTRACT), { tokens: 999 })
  assert.match(renderRedLights(led), /未设硬顶的预算项/)
})

// ---------- C7 透明度：正则降级签发的 RED 必须单列（否则「已换结构判据」是句没兑现的话） ----------
test('RED 证据带 redBasis=title-regex → 单列为「未经结构判定」，但不计假绿', () => {
  const ev = 'runId=r1;case=c1;testHash=sha256:' + 'a'.repeat(64) + ';summaryHash=sha256:' + 'b'.repeat(64) + ';commit=abc;env=test;summary=s.json'
  const r = deriveFakeGreen([{ facetId: 'A-F1', status: 'COVERED_GREEN', greenOk: true, hasRed: true, redRaw: ev + ';redBasis=title-regex' }], { 'A-F1': { ok: true, failureClass: 'value-assertion', discriminativePower: 0.9, pageErrors: 0, envFresh: true } })
  assert.equal(r.count, 0)
  assert.equal(r.regexCalibratedReds.length, 1)
  assert.equal(r.regexCalibratedReds[0].facetId, 'A-F1')
})
test('结构判定签发的 RED 不进降级清单', () => {
  const r = deriveFakeGreen([{ facetId: 'A-F1', status: 'COVERED_GREEN', greenOk: true, hasRed: true, redRaw: 'redBasis=failureClass;failureClass=value-assertion' }], { 'A-F1': { ok: true, failureClass: 'value-assertion' } })
  assert.equal(r.regexCalibratedReds.length, 0)
})
test('renderRedLights 把正则降级的 RED 单列成一节', () => {
  const led = emptyLedger('r1')
  led.fakeGreen = deriveFakeGreen([{ facetId: 'A-F1', status: 'COVERED_GREEN', greenOk: true, hasRed: true, redRaw: 'redBasis=title-regex' }], { 'A-F1': { ok: true, failureClass: 'value-assertion' } })
  assert.match(renderRedLights(led), /RED 校准走了正则降级（C7 未完全落地/)
})

// 2026-08-26 实测补：第一轮真实巡航后，台账把 pool_scan / pool_fields_check 记成了「写类动作」，
// 而这两个工具的描述里白纸黑字写着「只读、不改表」。不影响红灯（只落 unlisted），但审计面会失真
// ——晨检包报「写/外部动作 11 次」，其中 2 次其实是读。分类表要跟着新工具一起长。
test('只读语义的新工具（scan/check/probe）归 read，不再混进写类审计面', () => {
  assert.equal(classifyTool('mcp__guarded__pool_scan', {}), 'read')
  assert.equal(classifyTool('mcp__guarded__pool_fields_check', {}), 'read')
  assert.equal(classifyTool('mcp__feifei-caps__readiness_probe', {}), 'read')
})
// ★ 这一条抓的是**既有的洞**（加分类单测时才发现，不是这次引入的）：子串匹配下
// `set_task_status` 含 `status`、`morning_report` 含 `report`，双双被判 read
// ——于是「改任务档案 frontmatter」「往 tasks/ 写晨检包」这两类写动作在审计面上**根本不可见**。
// 修法：写动词优先且先判（工具命名惯例是 `<动词>_<宾语>`，动词才决定读写，宾语不决定）。
test('写动词优先：宾语里带只读特征词也不许判成 read', () => {
  assert.equal(classifyTool('mcp__collab__set_task_status', {}), 'write')      // 含 status
  assert.equal(classifyTool('mcp__guarded__morning_report', {}), 'write')      // 含 report
  assert.equal(classifyTool('mcp__collab__set_facet_coverage', {}), 'write')
  assert.equal(classifyTool('mcp__collab__append_timeline', {}), 'write')
  assert.equal(classifyTool('mcp__collab__seed_coverage', {}), 'write')
  assert.equal(classifyTool('mcp__collab__reconcile_coverage', {}), 'write')
  assert.equal(classifyTool('mcp__feifei-caps__lark_manage_field', {}), 'write')
  assert.equal(classifyTool('mcp__guarded__park_item', {}), 'write')
})
test('宾语带 status 但动词是读的，仍归 read（别矫枉过正）', () => {
  assert.equal(classifyTool('mcp__collab__backend_status', {}), 'read')
  assert.equal(classifyTool('mcp__collab__coverage_status', {}), 'read')
  assert.equal(classifyTool('mcp__feifei-caps__lark_get_requirement', {}), 'read')
})
