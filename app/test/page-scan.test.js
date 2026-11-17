import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SCAN_RUBRIC, SCAN_TIERS, SHELL_ZONES, BODY_ZONES, rubricOf, isShellZone, isBodyZone, zoneLabel,
  checkArithmetic, suppressGlobalRepeats, validateScanFindings, tierCounts, sampleShots, isAssertStep,
  renderScanMaterial, renderScanReport, scanFindingsToBugs, renderBugPlan,
  FINDING_EXITS, findingKey, validateDisposition, dispositionLedger,
} from '../page-scan.js'

// fixture 全部取自 2026-09-08 那张跟单看板截图的真实发现——这套判据就是从它反推的。
const F = {
  dupTab: { rubricKey: 'duplicate', zone: 'stat', quote: '待确认 2', occurrences: 2, expected: '同一个统计标签在一张卡片里只出现一次' },
  loginContradiction: { rubricKey: 'contradiction', zone: 'detail', quote: '未登录', expected: '右上角已显示登录用户时，工作台标题旁不应显示「未登录」' },
  sumOff: { rubricKey: 'arithmetic', zone: 'stat', quote: '待跟 264 批', parts: [130, 132, 2, 1], total: 264, expected: '分项标签之和应等于「待跟 N 批」的 N' },
  testData: { rubricKey: 'dirty-data', zone: 'list', quote: '杭州长风信息有限公司-v23', expected: '生产数据里不应出现 -v23 这类造数版本后缀' },
  noUnit: { rubricKey: 'format', zone: 'detail', quote: '已停留 1857 / 标准 1 h', expected: '停留时长应带单位，与右侧「标准 1 h」口径一致' },
  phone: { rubricKey: 'leak', zone: 'detail', quote: '17757417372', expected: '手机号应脱敏展示（如 177****7372）' },
}

// ---------- rubric / 分区 ----------
test('rubric 10 类，每条都有 key/label/ask/severity', () => {
  assert.equal(SCAN_RUBRIC.length, 10)
  for (const r of SCAN_RUBRIC) {
    assert.ok(r.key && r.label && r.severity)
    assert.match(r.ask, /\?|？/)
  }
  assert.equal(rubricOf('duplicate').label, '重复渲染')
  assert.equal(rubricOf('nope'), null)
})
test('外壳区与主体区分得开（老板定：只看主体）', () => {
  assert.ok(isShellZone('sidebar') && isShellZone('header'))
  assert.ok(!isShellZone('list') && isBodyZone('list'))
  assert.equal(zoneLabel('stat'), '统计条 / 指标卡 / 页签计数')
  assert.equal(SHELL_ZONES.length, 4)
  assert.ok(BODY_ZONES.length >= 8)
})

// ---------- 算术验算：本模块最硬的一条 ----------
test('加不上 → 接受，并算出差值', () => {
  const a = checkArithmetic(F.sumOff)
  assert.equal(a.ok, true)
  assert.equal(a.sum, 265)
  assert.equal(a.diff, 1)
  assert.match(a.expr, /130\+132\+2\+1 = 265，页面写 264，多 1/)
})
test('加得上 → 打回（是 QA 自己算错了，不能让开发白跑）', () => {
  const a = checkArithmetic({ parts: [130, 132, 2], total: 264 })
  assert.equal(a.ok, false)
  assert.match(a.why, /相等.*不勾稽这条不成立/)
})
test('parts/total 缺失或非数字 → 打回', () => {
  assert.equal(checkArithmetic({ total: 264 }).ok, false)
  assert.equal(checkArithmetic({ parts: [1, 'x'], total: 2 }).ok, false)
  assert.match(checkArithmetic({ parts: [1, 2] }).why, /total/)
})

// ---------- 主校验 ----------
test('合规 finding 全部接受，且 tier 由机器判、不由 QA 声明', () => {
  const v = validateScanFindings({ findings: [F.dupTab, F.sumOff, F.noUnit, F.phone] })
  assert.equal(v.ok, true)
  assert.equal(v.accepted.length, 4)
  const byKey = Object.fromEntries(v.accepted.map(f => [f.rubricKey, f]))
  assert.equal(byKey.duplicate.tier, SCAN_TIERS.CONFIRMED)
  assert.equal(byKey.arithmetic.tier, SCAN_TIERS.CONFIRMED)
  assert.equal(byKey.leak.tier, SCAN_TIERS.CONFIRMED)
  assert.equal(byKey.format.tier, SCAN_TIERS.SUSPECT, 'format 类要人复核口径，不自证')
  assert.equal(byKey.arithmetic.note, '130+132+2+1 = 265，页面写 264，多 1')
  assert.equal(byKey.leak.severity, '高')
})
test('外壳区的发现一律打回（菜单重复不算这个功能的账）', () => {
  const v = validateScanFindings({ findings: [{ rubricKey: 'duplicate', zone: 'sidebar', quote: '自动化搜品', occurrences: 2, expected: '菜单项不重复' }] })
  assert.equal(v.ok, false)
  assert.equal(v.accepted.length, 0)
  assert.match(v.rejected[0].reason, /通用外壳.*不在本次判定范围/)
})
test('缺 quote / 缺 expected / 自造维度 / 不认识的 zone → 逐条打回', () => {
  const bad = [
    { rubricKey: 'duplicate', zone: 'list', occurrences: 2, expected: 'x' },
    { rubricKey: 'duplicate', zone: 'list', quote: 'a', occurrences: 2 },
    { rubricKey: 'vibe', zone: 'list', quote: 'a', expected: 'x' },
    { rubricKey: 'duplicate', zone: 'nowhere', quote: 'a', occurrences: 2, expected: 'x' },
    { rubricKey: 'duplicate', quote: 'a', occurrences: 2, expected: 'x' },
  ]
  const v = validateScanFindings({ findings: bad })
  assert.equal(v.accepted.length, 0)
  assert.equal(v.rejected.length, 5)
  assert.match(v.rejected[0].reason, /quote/)
  assert.match(v.rejected[1].reason, /expected/)
  assert.match(v.rejected[2].reason, /不许自造维度/)
  assert.match(v.rejected[3].reason, /不认识/)
  assert.match(v.rejected[4].reason, /没声明 `zone`/)
})
test('duplicate 声称重复却给不出次数 → 打回', () => {
  const v = validateScanFindings({ findings: [{ rubricKey: 'duplicate', zone: 'list', quote: 'a', expected: 'x' }] })
  assert.match(v.rejected[0].reason, /occurrences/)
})
test('给了页面文本时，quote 必须真在页面上（防看花眼 / 凭印象编原文）', () => {
  const pageText = '当日跟进 269 待确认 2 无异常 1'
  const ok = validateScanFindings({ findings: [F.dupTab] }, { pageText })
  assert.equal(ok.accepted.length, 1)
  assert.equal(ok.accepted[0].quoteVerified, true)
  const bad = validateScanFindings({ findings: [{ ...F.dupTab, quote: '待确认 7' }] }, { pageText })
  assert.equal(bad.accepted.length, 0)
  assert.match(bad.rejected[0].reason, /在页面文本里找不到/)
})
test('没给页面文本时不硬拦，但标记 quoteVerified=false（结论里会写"凭图抄录"）', () => {
  const v = validateScanFindings({ findings: [F.dupTab] })
  assert.equal(v.accepted[0].quoteVerified, false)
  assert.match(renderScanReport(v, { screenshots: 1 }), /凭图抄录/)
})

// ---------- 跨页重复抑制 ----------
test('同一现象在 3+ 页面复现 → 降级全站议题，不算本次改动的账', () => {
  const many = ['A', 'B', 'C'].map(p => ({ rubricKey: 'truncation', quote: '双滚动条', page: p }))
  const { local, global } = suppressGlobalRepeats(many, { minPages: 3 })
  assert.equal(local.length, 0)
  assert.equal(global.length, 1)
  assert.deepEqual(global[0].seenOnPages, ['A', 'B', 'C'])
  assert.match(global[0].why, /全站议题/)
})
test('只在 1-2 个页面出现 → 仍算本次缺陷', () => {
  const few = ['A', 'B'].map(p => ({ rubricKey: 'truncation', quote: '双滚动条', page: p }))
  assert.equal(suppressGlobalRepeats(few, { minPages: 3 }).local.length, 2)
})
test('tierCounts 两档都统计到', () => {
  const c = tierCounts([{ tier: SCAN_TIERS.CONFIRMED }, { tier: SCAN_TIERS.CONFIRMED }, { tier: SCAN_TIERS.SUSPECT }])
  assert.equal(c[SCAN_TIERS.CONFIRMED], 2)
  assert.equal(c[SCAN_TIERS.SUSPECT], 1)
})

// ---------- 截图采样 ----------
// fixture 形状照抄真产物（vision-e2e/output/runs/20260901-112118-270-…/summary.json：
// 76 步、每步都有 afterScreenshotPath、phase 分 fixtureSetup(47)/case(29)、case 段导航类 0 个）
const mkStep = (i, over = {}) => ({
  index: i, stepId: `s-${i}`, title: `步骤 ${i}`, actionType: 'click', phase: 'case',
  status: 'passed', afterScreenshotPath: `D:/w/runs/r1/steps/${String(i).padStart(2, '0')}-after.png`, ...over,
})
test('只采 phase=case，fixtureSetup 的准备工作不算被测页面', () => {
  const steps = [
    ...Array.from({ length: 47 }, (_, i) => mkStep(i, { phase: 'fixtureSetup', sourceFixture: 'fxSampleReviewApproved' })),
    ...Array.from({ length: 29 }, (_, i) => mkStep(100 + i)),
  ]
  const r = sampleShots(steps, { limit: 10 })
  assert.equal(r.total, 76)
  assert.equal(r.caseSteps, 29)
  assert.equal(r.picked, 10)
  assert.equal(r.dropped, 66)
  for (const s of r.shots) assert.ok(!/\/(0[0-9]|[1-3][0-9]|4[0-6])-after/.test(s) || Number(s.match(/(\d+)-after/)[1]) >= 100, '不该采到 fixtureSetup 的图')
  assert.match(r.notes.join(''), /fixtureSetup 准备工作/)
})
test('必取终态与失败步；断言步优先于普通步', () => {
  const steps = [
    ...Array.from({ length: 8 }, (_, i) => mkStep(i)),
    mkStep(8, { actionType: 'assertVisible' }),
    mkStep(9, { status: 'failed' }),
    ...Array.from({ length: 5 }, (_, i) => mkStep(10 + i)),
  ]
  const r = sampleShots(steps, { limit: 4 })
  const idx = r.shots.map(s => Number(s.match(/(\d+)-after/)[1]))
  assert.ok(idx.includes(14), '最后一步（终态）必取')
  assert.ok(idx.includes(9), '失败步必取')
  assert.ok(idx.includes(8), '断言步优先')
  assert.equal(r.picked, 4)
})
// 真产物回放固化（2026-09-09）：29 个 case 步里 **23 个带 expectation**，但多是
// `expectNetworkResponse`（接口断言，页面上看不出来），真正页面可见的只有 5 个。
// 第一版 isAssertStep 把这 23 个全判成断言步 → 配额吃光 → 采出 48,49,52..58,76：中间连号 7 张、
// 后 17 步一张没采。**这个比例是真数据给的，不是编的**——单测里必须留着它。
test('★ 断言步再多也不许吃光名额：接口断言不算页面可见断言 + 配额封顶 limit/2', () => {
  const steps = Array.from({ length: 29 }, (_, i) => mkStep(48 + i, {
    // 前 23 个带 expectation，其中只有 5 个是页面可见断言（照真产物比例）
    ...(i < 23 ? { expectation: { type: i < 5 ? 'expectTextExist' : 'expectNetworkResponse', ok: true } } : {}),
  }))
  const r = sampleShots(steps, { limit: 10 })
  const idx = r.shots.map(s => Number(s.match(/(\d+)-after/)[1]))
  assert.equal(steps.filter(isAssertStep).length, 5, '接口断言 expectNetworkResponse 不该算页面可见断言')
  // 真判据是**跨度**，不是连号：断言步扎堆时采出连号是对的（那是用例自己要求检查的时刻，
  // 不是"高度相似的表单过程态"）。要防的是「10 张全挤在一段、后面整段没采」——修复前正是那样
  // （48,49,52..58,76：断言配额吃光，59~75 十七步一张没采）。
  assert.ok(Math.max(...idx) - Math.min(...idx) >= 20, `采样应跨越大部分流程（实际跨度 ${Math.max(...idx) - Math.min(...idx)}）`)
  const tail = idx.filter(i => i >= 48 + 15)
  assert.ok(tail.length >= 3, `流程后半段至少要采到 3 张（实际 ${tail.length}）——修复前是 1 张（只有终态）`)
  assert.ok(idx.includes(76), '终态必取')
})
test('刻意不取前 N 张（那些是表单过程态）——余额走均匀间隔', () => {
  const steps = Array.from({ length: 20 }, (_, i) => mkStep(i))
  const r = sampleShots(steps, { limit: 5 })
  const idx = r.shots.map(s => Number(s.match(/(\d+)-after/)[1]))
  assert.ok(idx.includes(19), '终态必取')
  assert.notDeepEqual(idx, [0, 1, 2, 3, 4], '不该退化成取前 5 张')
  assert.ok(Math.max(...idx) - Math.min(...idx) > 5, '采样应跨越整个流程，不是挤在开头')
})
test('没有 phase=case 时退回全部步骤，并如实说明', () => {
  const steps = Array.from({ length: 6 }, (_, i) => mkStep(i, { phase: 'fixtureSetup' }))
  const r = sampleShots(steps, { limit: 3 })
  assert.equal(r.caseSteps, 0)
  assert.equal(r.picked, 3)
  assert.match(r.notes.join(''), /没有 `phase=case`/)
})
test('一张带截图的步都没有 → 空结果 + 说明，不炸', () => {
  const r = sampleShots([{ index: 0, actionType: 'click' }], { limit: 5 })
  assert.equal(r.picked, 0)
  assert.equal(r.total, 0)
  assert.match(r.why, /没有任何带 afterScreenshot/)
  assert.deepEqual(sampleShots(null).shots, [])
})
test('采样过就必须说丢了多少（no silent caps）', () => {
  const steps = Array.from({ length: 30 }, (_, i) => mkStep(i))
  const md = renderScanMaterial({ screenshots: sampleShots(steps, { limit: 6 }).shots, sampling: sampleShots(steps, { limit: 6 }) })
  assert.match(md, /共 30 张步后截图，采了 \*\*6\*\* 张、\*\*丢了 24\*\* 张/)
  assert.match(md, /别把「采样过」当成「全看过」/)
})
test('没采样（直接给图）时不印采样说明', () => {
  const md = renderScanMaterial({ screenshots: ['/a/1.png'], sampling: null })
  assert.ok(!md.includes('采样说明'))
})

// ---------- 渲染 ----------
test('素材页写明「只看主体」、列出判据、并禁止写 suggestion（红线 5）', () => {
  const md = renderScanMaterial({ screenshots: ['/a/1.png', '/a/2.png'], source: '猪猪会话 s-1' })
  assert.match(md, /只看页面主体/)
  assert.match(md, /左侧主菜单/)
  assert.match(md, /不要写 `suggestion`/)
  assert.match(md, /机器会真的加一遍/)
  for (const r of SCAN_RUBRIC) assert.ok(md.includes(r.label), `判据 ${r.label} 应出现在素材页`)
})
test('零发现是正常结论，且不许被读成「功能正确」', () => {
  const md = renderScanReport(validateScanFindings({ findings: [] }), { screenshots: 3 })
  assert.match(md, /未发现异常/)
  assert.match(md, /不代表功能正确/)
})
test('结论按两档分组，自证档标"可直接开单"、待复核档要求先查实', () => {
  const md = renderScanReport(validateScanFindings({ findings: [F.dupTab, F.noUnit] }), { screenshots: 1 })
  assert.match(md, /截图自证.*可直接开单/)
  assert.match(md, /待复核.*先复核再开单/)
})

// ---------- 转缺陷单 ----------
test('只有「截图自证」档转单，待复核不转（不把复核甩给开发）', () => {
  const v = validateScanFindings({ findings: [F.dupTab, F.sumOff, F.noUnit] })
  const bugs = scanFindingsToBugs(v.accepted, { version: '5.20', module: '跟单看板', startSeq: 7, date: '2026-09-08', archive: 'office-lab/tasks/x.md' })
  assert.equal(bugs.length, 2, 'format 那条是待复核档，不该转')
  assert.equal(bugs[0].id, 'SAMPLING-v5.20-BUG-007')
  assert.equal(bugs[1].id, 'SAMPLING-v5.20-BUG-008')
})
test('壳号 facet 用缺陷号末三位，符合覆盖率引擎的 REQ-9NNN-Fn 形态', () => {
  const v = validateScanFindings({ findings: [F.dupTab] })
  const [b] = scanFindingsToBugs(v.accepted, { version: '5.20', startSeq: 13, date: '2026-09-08' })
  assert.equal(b.shellId, 'REQ-9013')
  assert.match(b.body, /REQ-9013-F1/)
  assert.match(b.body, /FACET|facet/)
})
test('缺陷单正文对齐模板：frontmatter + 六段 + 四件套提醒 + 不含根因诊断', () => {
  const v = validateScanFindings({ findings: [F.testData] })
  const [b] = scanFindingsToBugs(v.accepted, { version: '5.20', module: '跟单看板', date: '2026-09-08', archive: 'office-lab/tasks/x.md', runId: 'r-9' })
  assert.match(b.body, /^---\ntype: bug\nversion: v5\.20\n/)
  for (const seg of ['## 一、基本信息', '## 四、复现步骤', '## 五、预期结果', '## 六、实际结果', '## 九、修复验收标准']) {
    assert.ok(b.body.includes(seg), `缺少 ${seg}`)
  }
  assert.match(b.body, /四件套/)
  assert.match(b.body, /runId `r-9`/)
  assert.equal(b.severity, '高')
  assert.ok(!/根因|因为|由于/.test(b.body.split('## 十')[0]), '巡检转出的单不得含根因诊断')
})
// 2026-09-08 端到端 dry-run 当场抓到：原实现末尾 `.filter(x => x !== '')` 把刻意留的
// markdown 空行全吃了 → 表格/标题前无空行、渲染不出来。单测只断言"段落在不在"抓不到这类问题。
test('骨架的 markdown 结构成立：每个标题与表格前都有空行（空行别被 filter 吃掉）', () => {
  const v = validateScanFindings({ findings: [F.dupTab] })
  const [b] = scanFindingsToBugs(v.accepted, { version: '5.20', module: '跟单看板', date: '2026-09-08', screenshots: ['/a/1.png'] })
  const lines = b.body.split('\n')
  lines.forEach((ln, i) => {
    if (/^#{1,4} /.test(ln) && i > 6) assert.equal(lines[i - 1], '', `标题「${ln}」前应有空行（第 ${i + 1} 行）`)
    // 表格首行（前一行不是任何表格行——含 `|---|` 分隔行）才要求空行
    if (/^\|/.test(ln) && !/^\|/.test(lines[i - 1] || '')) {
      assert.equal(lines[i - 1], '', `表格「${ln.slice(0, 20)}」前应有空行（第 ${i + 1} 行）`)
    }
  })
  assert.match(b.body, /\n\n证据截图：/)
  assert.ok(!b.body.includes('\n\n\n'), '不应出现连续三个换行（多余空行）')
})
test('没有自证档时给出明确的"不建单"结论，并点名待复核数', () => {
  assert.match(renderBugPlan([], { suspects: 3 }), /不生成缺陷单.*3 条待复核/s)
  const v = validateScanFindings({ findings: [F.loginContradiction] })
  const md = renderBugPlan(scanFindingsToBugs(v.accepted, { version: '5.20', date: '2026-09-08' }))
  assert.match(md, /待建缺陷单 1 张/)
  assert.match(md, /一个回合一张/)
})


// ---------- C3.9 finding 出口硬化（2026-09-10 老板定：发现捞出来了、然后消失）----------
test('findingKey 稳定且区分页面（同一句话在两个页面是两条）', () => {
  const a = { rubricKey: 'format', page: '环节配置', quote: 'Invalid date' }
  assert.equal(findingKey(a), findingKey({ ...a }))
  assert.notEqual(findingKey(a), findingKey({ ...a, page: '变更历史' }))
})

test('出口=increment 必须同时给 entryId+owner+date —— 走增量≠不派工', () => {
  const base = { key: 'k', exit: FINDING_EXITS.INCREMENT }
  const v = validateDisposition(base)
  assert.equal(v.ok, false)
  assert.match(v.why, /entryId/)
  assert.match(v.why, /owner/)
  assert.match(v.why, /date/)
  assert.match(v.why, /不等于/)
  assert.equal(validateDisposition({ ...base, entryId: 'REQ-0338', owner: 'ggbond' }).ok, false, '缺 date 也不行')
  assert.equal(validateDisposition({ ...base, entryId: 'REQ-0338', owner: 'ggbond', date: '2026-09-11' }).ok, true)
})

test('出口=bug 必须给 bugId；出口=not-defect 必须写够理由', () => {
  assert.equal(validateDisposition({ key: 'k', exit: FINDING_EXITS.BUG }).ok, false)
  assert.equal(validateDisposition({ key: 'k', exit: FINDING_EXITS.BUG, bugId: 'STOCKUP-v0.1.0-BUG-002' }).ok, true)
  const short = validateDisposition({ key: 'k', exit: FINDING_EXITS.NOT_DEFECT, reason: '待确认' })
  assert.equal(short.ok, false)
  assert.match(short.why, /不是理由/)
  assert.equal(validateDisposition({ key: 'k', exit: FINDING_EXITS.NOT_DEFECT, reason: '设计稿本就如此，同族页面一致' }).ok, true)
})

test('出口不认自造枚举（「留人工定性」不是出口）', () => {
  const v = validateDisposition({ key: 'k', exit: '留人工定性' })
  assert.equal(v.ok, false)
  assert.match(v.why, /三选一/)
})

test('dispositionLedger：没落出口的进 open，落了的进 closed', () => {
  const findings = [
    { rubricKey: 'format', page: '环节配置', quote: 'Invalid date' },
    { rubricKey: 'contradiction', page: '跟单工作台', quote: '未登录' },
  ]
  const k0 = findingKey(findings[0])
  const led = dispositionLedger({ findings, dispositions: { [k0]: { exit: 'increment', entryId: 'REQ-0338', owner: 'ggbond', date: '2026-09-11' } } })
  assert.equal(led.total, 2)
  assert.equal(led.closed.length, 1)
  assert.equal(led.open.length, 1)
  assert.equal(led.open[0].quote, '未登录')
})
