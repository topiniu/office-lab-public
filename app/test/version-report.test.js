// 版本验收单（晨检包 v2）。钉的是 2026-08-28 那次概念错位的三个症状：
//   ① 一个版本裂成 N 份轮次包，每份只讲那夜领的 2 条；
//   ② 条目从契约+矩阵倒推，从没读过「## 需求条目登记表」——最该被看见的「阻塞」一条都没进过包；
//   ③ park 台账没有出口，做完的条目还以「等你拍板」的姿态印着。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  matchesVersion, deriveVersionState, deriveVersionItems, deriveRoundDelta,
  versionGaps, assembleVersionReport, versionReportName, scopeParkToVersion,
} from '../version-report.js'

// 取自 v5.20 的真实形状：9 条登记表 + 4 轮守航 + 4 种契约书写形态
const ENTRIES = [
  { no: 'REQ-0284', name: '审版/审价看板就地展示核价', source: '原始需求', enteredAt: '2026-08-25', status: '已上线', stage: '' },
  { no: 'REQ-0303', name: '工艺单导出排版优化 3 项', source: '原始需求', enteredAt: '2026-08-25', status: '阻塞', stage: '导出观感待人眼' },
  { no: 'REQ-0316', name: '定制款/现货款标签', source: '再追加(2026-08-27 点名)', enteredAt: '2026-08-27', status: 'QA通过', stage: '' },
  { no: 'REQ-0317', name: '当前节点进入时间范围筛选', source: '再追加(2026-08-27 点名)', enteredAt: '2026-08-27', status: 'QA通过', stage: '' },
  { no: 'REQ-0318', name: '工艺母版删「童装」文案', source: '再追加(2026-08-27 点名 guarded-02)', enteredAt: '2026-08-27', status: 'QA中', stage: '' },
]
const EV = { runId: 'session-20260827-193012-a00d85a5-round-1', commit: 'e105c77ce5' }   // 19:30，落在 guarded-02 窗口内
const ROWS = [
  { req: 'REQ-0318', facetId: 'REQ-0318-F1', status: 'COVERED_GREEN', green: EV, redOk: true },
  { req: 'REQ-0318', facetId: 'REQ-0318-F4', status: 'HUMAN_INHERENT' },
  { req: 'REQ-0316', facetId: 'REQ-0316-F1', status: 'COVERED_GREEN', green: EV, redOk: true },
  { req: 'REQ-0271', facetId: 'REQ-0271-F1', status: 'COVERED_GREEN', green: EV, redOk: true },   // 不在登记表 → orphan
]
const ROUND = (runName, named, starts, ends, ledger = {}) => ({
  runName, startsAt: starts, endsAt: ends,
  contract: { selection: { named_items: named }, starts_at: starts, deadline: ends },
  ledger: { forbidden: [], overBudget: [], fakeGreen: { count: 0 }, usage: {}, gateDecisions: {}, itemResults: {}, ...ledger },
})
const ROUNDS = [
  ROUND('2026-08-27-guarded-01', ['req-316', 'req-317'], '2026-08-27T09:55:17', '2026-08-27T18:30:22'),
  ROUND('2026-08-27-guarded-02', ['REQ-0313', 'REQ-0318'], '2026-08-27T18:30:22', '2026-08-28T08:00:00',
    { gateDecisions: { 'REQ-0318': { item: 'REQ-0318', riskClass: 'low' } }, forbidden: [{ tool: 'x' }], usage: { tokens: 36985188 } }),
]

// ---------- 版本归属 ----------
test('matchesVersion 吃四种真实书写形态（带引号 / 不带 / office-lab 前缀 / 裸 tasks）', () => {
  const want = { version: 'v5.20', archiveBasename: 'office-lab/tasks/2026-08-25-示例项目-v5.20.md' }
  assert.ok(matchesVersion({ version: "'v5.20'", archive: "'office-lab/tasks/2026-08-25-示例项目-v5.20.md'" }, want))
  assert.ok(matchesVersion({ version: 'v5.20', archive: 'office-lab/tasks/2026-08-25-示例项目-v5.20.md' }, want))
  assert.ok(matchesVersion({ version: 'v5.20', archive: 'tasks/2026-08-25-示例项目-v5.20.md' }, want), '裸 tasks/ 前缀（guarded-02 就是这么写的）')
  assert.ok(matchesVersion({ archive: 'tasks/2026-08-25-示例项目-v5.20.md' }, want), '没写 version 时靠档案文件名兜')
  assert.ok(!matchesVersion({ version: 'v5.19', archive: 'tasks/2026-08-21-v5.19-批次.md' }, want))
})
test('versionReportName 遵《文档格式规范》的 <日期>-<版本>-<类型>', () => {
  assert.equal(versionReportName('v5.20', '2026-08-28'), '2026-08-28-v5.20-晨检包.md')
  assert.equal(versionReportName('', '2026-08-28'), '2026-08-28-未定版-晨检包.md')
})

// ---------- 版本状态：只认 gates + 条目终态，绝不回读 fm.status ----------
test('deriveVersionState 不读 fm.status（v5.16 实证：字面停在 QA_PASSED 而 gates 早已 true）', () => {
  assert.equal(deriveVersionState({ status: 'QA_PASSED', gates: { released_test: true } }, ENTRIES), 'released_test')
  assert.equal(deriveVersionState({ status: 'DRAFT', gates: { released_prod: true } }, []), 'released_prod')
  assert.equal(deriveVersionState({}, ENTRIES), 'in_qa', '有条目在测')
  assert.equal(deriveVersionState({}, ENTRIES.map(e => ({ ...e, status: '已上线' }))), 'released_prod')
  assert.equal(deriveVersionState({}, ENTRIES.map(e => ({ ...e, status: 'QA通过' }))), 'rc_ready')
})
test('★「待人工验收」＝守航终点，必须派生 rc_ready（漏了它整版会掉回 drafting「还在梳理需求」）', () => {
  // 2026-09-19 v5.24 实账形状：一条 QA通过 + 一条 待人工验收，两条都在验收门上。
  // 旧判据只认 VER_CLOSED_STATUS（不含「待人工验收」）→ every() 不成立 → 又没有 qa/dev/blocked 档
  // → 一路落到 drafting，晨检包第一行印「还在梳理需求」，而同表下面写着「待你验收 2/2」。
  assert.equal(deriveVersionState({}, [{ no: 'REQ-0352', status: 'QA通过' }, { no: 'REQ-0353', status: '待人工验收' }]), 'rc_ready')
  assert.equal(deriveVersionState({}, [{ no: 'A', status: '待人工验收' }]), 'rc_ready', '全部待人工验收也是 rc_ready')
  // 对照组：混进一条真在测的，就**不该**是 rc_ready（证明改的是漏档、不是把闸放松）
  assert.equal(deriveVersionState({}, [{ no: 'A', status: '待人工验收' }, { no: 'B', status: 'QA中' }]), 'in_qa')
  // 对照组：「待人工」(QA 未收束) 与「待人工验收」(已到验收门) 是两个词，前者仍算在测
  assert.equal(deriveVersionState({}, [{ no: 'A', status: '待人工' }]), 'in_qa')
})

// ---------- 条目全表：行集必须是登记表 ----------
test('行集 = 登记表全量；矩阵有而登记表无的 REQ 进 orphanReqs，不混进主表', () => {
  const { items, orphanReqs } = deriveVersionItems({ entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park: [] })
  assert.equal(items.length, ENTRIES.length, '9 条进 9 条出——「这一版有几条」不许有第二个答案')
  assert.deepEqual(orphanReqs.map(o => o.req), ['REQ-0271'])
})
test('「阻塞」条目必须在册且被标出来（旧形态 8 份包里一个字都没有）', () => {
  const { items } = deriveVersionItems({ entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park: [] })
  const b = items.find(i => i.req === 'REQ-0303')
  assert.equal(b.boardStatus, '阻塞')
  assert.equal(b.bucket, 'blocked')
  const md = assembleVersionReport({ version: 'v5.20', date: '2026-08-28', entries: ENTRIES, rows: ROWS, rounds: ROUNDS })
  assert.match(md, /REQ-0303/)
  assert.match(md, /卡住的条目/)
})
test('绿数/RED/证据 commit 来自覆盖矩阵；没有 facet 的条目如实标注', () => {
  const { items } = deriveVersionItems({ entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park: [] })
  const f = items.find(i => i.req === 'REQ-0318')
  assert.equal(f.green, 1)
  assert.equal(f.facetTotal, 2)
  assert.equal(f.commit, 'e105c77ce5')
  // 2026-09-09 改：这一格不再堆 `REQ-0318-F4(HUMAN_INHERENT)` —— 术语没翻、没说看什么、
  // 多条压一格让人无从下手（老板点名的"抽象用语"）。改成按类计数的一句人话，
  // 逐条明细挪到第三章「👀 机器测不了、要你亲眼看」那节（带"看什么"）。
  assert.match(f.humanInherent, /条要人亲眼看/)
  assert.doesNotMatch(f.humanInherent, /HUMAN_INHERENT|SOURCE_ATTESTED/, '机器枚举不许出现在给人看的格子里')
  assert.equal(items.find(i => i.req === 'REQ-0284').noFacets, true)
})
test('park 只在未关闭时才算「还挂着」', () => {
  const park = [
    { req: 'REQ-0303', rounds: 1, reason: '口径待拍', proposal: 'A 案' },
    { req: 'REQ-0316', rounds: 1, reason: '旧问题', proposal: 'B 案', closedAt: '2026-08-28T01:00:00Z' },
  ]
  const { items } = deriveVersionItems({ entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park })
  assert.ok(items.find(i => i.req === 'REQ-0303').parkOpen)
  assert.equal(items.find(i => i.req === 'REQ-0316').parkOpen, null)
})

// ---------- 本轮增量 ----------
test('同日双轮用契约点名消歧（进入日期只精确到天，消不了歧）', () => {
  const d1 = deriveRoundDelta({ round: ROUNDS[0], entries: ENTRIES, rows: ROWS })
  const d2 = deriveRoundDelta({ round: ROUNDS[1], entries: ENTRIES, rows: ROWS })
  assert.deepEqual(d1.planned, ['REQ-0316', 'REQ-0317'], 'req-316 要归一成 REQ-0316')
  assert.deepEqual(d1.entered, ['REQ-0316', 'REQ-0317'])
  assert.deepEqual(d2.entered, ['REQ-0318'], '0316/0317 是前一轮带进来的，不算 guarded-02 的')
})
test('证据 runId 落在轮次窗口内即算「真动过」——历史轮次唯一还成立的硬证据', () => {
  // itemResults 的写侧 2026-08-28 才落地，已发生的四轮全空；只信台账会让「本轮增量」上线第一天就是空的
  const d = deriveRoundDelta({ round: ROUNDS[1], entries: ENTRIES, rows: ROWS })
  const t = d.touched.find(x => x.req === 'REQ-0318')
  assert.ok(t, '19:30 的猪猪证据落在 guarded-02 窗口内')
  assert.ok(t.via.includes('证据runId'))
  assert.ok(t.via.includes('门禁定级'))
})
// 边界保持严格：早于 starts_at 的证据不算这一轮的产出（宁可少认，不替它认领）
test('证据早于本轮 starts_at 就不算本轮动的（该条目仍会以「契约点名」身份出现）', () => {
  const rows = [{ req: 'REQ-0318', facetId: 'REQ-0318-F1', status: 'COVERED_GREEN', redOk: true, green: { runId: 'session-20260827-182259-x' } }]
  const d = deriveRoundDelta({ round: ROUNDS[1], entries: ENTRIES, rows })   // 18:22 < 18:30 开跑
  assert.ok(!d.touched.some(x => x.via.includes('证据runId')))
  assert.ok(d.planned.includes('REQ-0318'))
})
test('点了名却一整轮零机器痕迹 → 必须印差集（08-25 那轮 token=0 就是这形状）', () => {
  const d = deriveRoundDelta({ round: ROUNDS[1], entries: ENTRIES, rows: ROWS })
  assert.deepEqual(d.plannedNotTouched, ['REQ-0313'])
  const md = assembleVersionReport({ version: 'v5.20', date: '2026-08-28', entries: ENTRIES, rows: ROWS, rounds: ROUNDS })
  assert.match(md, /点了名却一整轮零机器痕迹/)
  assert.match(md, /REQ-0313/)
})
test('登记表「来源」列不参与轮次归属（实测 3 条追加里只有 1 条写了轮次名，且同日双轮消歧不了）', () => {
  // 这一条来源列白纸黑字写着 guarded-02，但进入日期落在窗口外 —— 不许靠文本把它认领进来
  const entries = [{ no: 'REQ-0318', name: 'x', source: '再追加(2026-08-27 点名 guarded-02)', enteredAt: '2026-08-20', status: 'QA中' }]
  const d = deriveRoundDelta({ round: ROUNDS[1], entries, rows: [] })
  assert.deepEqual(d.entered, [])
  assert.ok(!d.touched.some(t => t.via.includes('进入登记表')))
})

// ---------- 装配 ----------
test('章节顺序固定，决策块在第四章（老板读到第三章末信息已闭合）', () => {
  const md = assembleVersionReport({ version: 'v5.20', date: '2026-08-28', entries: ENTRIES, rows: ROWS, rounds: ROUNDS })
  const idx = t => md.indexOf(t)
  assert.ok(idx('〇、本单缺了哪些料') < idx('一、一眼摘要'))
  assert.ok(idx('一、一眼摘要') < idx('二、版本条目全表'))
  assert.ok(idx('二、版本条目全表') < idx('三、卡住与待拍'))
  assert.ok(idx('三、卡住与待拍') < idx('四、老板验收决策'))
  assert.ok(idx('四、老板验收决策') < idx('五、最近一轮守航'))
  assert.ok(idx('五、最近一轮守航') < idx('六、历史轮次汇总'))
  assert.ok(idx('六、历史轮次汇总') < idx('八、agent 自述栏'))
  assert.match(md, /type: version-acceptance-report/)
  assert.match(md, /assembled_by: engine/)
})
test('三红灯给「本版累计 + 最近一轮」两个数（只给一个就退回症状 1 或读不出晋级判据）', () => {
  const md = assembleVersionReport({ version: 'v5.20', date: '2026-08-28', entries: ENTRIES, rows: ROWS, rounds: ROUNDS })
  assert.match(md, /本版累计 \*\*1\*\* 🚨 ｜ 最近一轮 1/)
})
test('frontmatter 不写 task/status —— 否则这份带版本号的文件会被当成该版本的主档案', () => {
  const md = assembleVersionReport({ version: 'v5.20', date: '2026-08-28', entries: ENTRIES, rows: ROWS, rounds: ROUNDS })
  const fm = md.slice(0, md.indexOf('\n---', 4))
  assert.ok(!/^task:/m.test(fm))
  assert.ok(!/^status:/m.test(fm))
})
test('缺料照出单，且第〇章逐条标注（绝不用空白冒充通过）', () => {
  const md = assembleVersionReport({ version: '', date: '2026-08-28', entries: [], rows: [], rounds: [] })
  assert.match(md, /版本未绑定/)
  assert.match(md, /登记表为空/)
  assert.match(md, /缺席的章节一律按「未接通\/未记录」读/)
  assert.match(md, /老板验收决策/, '缺料也要出决策块')
})
test('versionGaps 点名 orphan 与缺失的上游', () => {
  const g = versionGaps({ version: 'v5.20', archiveRel: 'tasks/a.md', entries: ENTRIES, rows: ROWS, rounds: ROUNDS, orphanReqs: [{ req: 'REQ-0271' }] })
  assert.ok(g.some(x => /REQ-0271/.test(x) && /不在登记表/.test(x)))
  assert.ok(g.some(x => /发布链对账缺失/.test(x)))
})
test('历史轮次汇总一轮一行，并列出已停产的轮次级包防误读', () => {
  const md = assembleVersionReport({
    version: 'v5.20', date: '2026-08-28', entries: ENTRIES, rows: ROWS, rounds: ROUNDS,
    historicalRunReports: ['2026-08-28-晨检包-2026-08-27-guarded-02.md'],
  })
  assert.match(md, /2026-08-27-guarded-01/)
  assert.match(md, /2026-08-27-guarded-02/)
  assert.match(md, /已停产的轮次级晨检包/)
})
// 踩过的真事故：显式要 v5.19 的单，却把当前 run 那份 v5.20 档案带了进来，出来一份
// 「版本写 v5.19、条目却是 v5.20 那 9 条」的假单。契约写了版本号就以版本号为准，不许退到档案名。
test('契约写了 version 就以它为准，绝不退回档案名匹配（否则跨版本串台）', () => {
  const v520Archive = { version: 'v5.20', archive: 'tasks/2026-08-25-示例项目-v5.20.md' }
  assert.ok(!matchesVersion(v520Archive, { version: 'v5.19', archiveBasename: 'tasks/2026-08-25-示例项目-v5.20.md' }),
    '档案名相同也不算——版本号已经说了它不是 v5.19')
  assert.ok(matchesVersion(v520Archive, { version: 'v5.20', archiveBasename: 'tasks/别的.md' }))
})

// ---------- 2026-09-09：准确性三修（park 作用域 / 档案待拍 / 术语翻译） ----------

test('★park 按版本作用域过滤——别版模块挂着的历史 park 不许灌进本版单子', () => {
  const park = [
    { req: 'REQ-0318', rounds: 2, reason: '本版口径待拍', proposal: 'A 案' },
    { req: 'REQ-0304', rounds: 1, reason: '示例项目 v5.x 的储备需求', proposal: 'B 案' },
    { req: 'REQ-0219', rounds: 1, reason: '另一个模块的历史 park', proposal: 'C 案' },
  ]
  const { items } = deriveVersionItems({ entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park })
  const scoped = scopeParkToVersion(park, items)
  assert.deepEqual(scoped.map(e => e.req), ['REQ-0318'], '只留登记表里有的那条')
  // 实况回归：v0.1.0 那份单子报 12 条、其中 9 条是别的模块的（命中率 3/12）
  const md = assembleVersionReport({ version: 'v5.20', date: '2026-09-09', entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park })
  assert.doesNotMatch(md, /REQ-0304/, '别版 park 不许出现在本版单子里')
  assert.doesNotMatch(md, /REQ-0219/)
})

test('★登记表为空时一条 park 都不报（宁可空，也不报别版的）', () => {
  assert.deepEqual(scopeParkToVersion([{ req: 'REQ-0304' }], []), [])
})

test('★档案里开着的待确认事项必须进单子，且缺「不拍的代价」要点名', () => {
  const decisions = [
    { id: 'A', scope: '环节配置', topic: '跟单负责人必填还是选填', proposal: '选填、可就地改', cost: '' },
    { id: 'M', scope: '备货列表', topic: '首返快照取不到的严重度', proposal: '定「中」', cost: '只影响告警分级' },
  ]
  const md = assembleVersionReport({
    version: 'v5.20', date: '2026-09-09', entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park: [],
    decisions, costMissing: [decisions[0]],
  })
  assert.match(md, /等你一句话（2）—— 来自任务档案/)
  assert.match(md, /跟单负责人必填还是选填/)
  assert.match(md, /⚠ \*\*没写\*\*（菲菲必填）/, '缺代价要在表里显式亮出来')
  assert.match(md, /人做决定靠的是后果，不是选项/)
  assert.match(md, /必答（2 条）/)
})

test('★要老板亲眼看的 facet 单列成节，带「看什么」', () => {
  const md = assembleVersionReport({
    version: 'v5.20', date: '2026-09-09', entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park: [],
    needYouEyes: [{ facetId: 'REQ-0341-F29', what: '备货单列表出现「首单/返单」列' }],
  })
  assert.match(md, /机器测不了、要你亲眼看（1）/)
  assert.match(md, /备货单列表出现「首单\/返单」列/)
})

test('★整份单子不许残留机器术语；残留时单子自己报出来（不等人骂）', () => {
  const md = assembleVersionReport({ version: 'v5.20', date: '2026-09-09', entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park: [] })
  assert.doesNotMatch(md, /没翻成人话/, '正常情况下不该有泄漏提示')
  assert.doesNotMatch(md, /forbidden_action|fake_green|over_budget/, '三红灯已翻成人话')
  assert.doesNotMatch(md, /引擎派生状态/, '版本态已翻成人话')
  // 反向：注入一个未翻译的枚举，单子必须自曝
  const dirty = assembleVersionReport({
    version: 'v5.20', date: '2026-09-09', entries: ENTRIES, rows: ROWS, rounds: ROUNDS, park: [],
    extraSections: ['### 补充\n\n某条 facet 是 UNCOVERED 状态'],
  })
  assert.match(dirty, /本单有 1 个机器术语没翻成人话/)
  assert.match(dirty, /humanize\.js/)
})
