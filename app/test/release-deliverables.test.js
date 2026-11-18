// 发布沟通「四件交付物」核对（releaseDeliverableCheck / releaseTurnMissing）与教训库注入（buildLessonsBlock）的回归测试。
//
// 缘起 2026-08-25 事故（菲菲 run `20260825075631-27368f`）：波比的派工只点名了**一件**交付物（版本发布说明），
// 菲菲照着派工做完就【交回】——PM_RELEASE_NOTES 四件只交了 1 件。三道闸全没拦住：
//   ① 旧软门禁 `releaseCopyCardMissing` 的触发条件是「本轮汇报里同时出现 版本发布说明 + CHANGELOG」＝**做完三件才检查
//      第四件**，这次汇报里根本没有 CHANGELOG 二字 → 静默跳过（漏得越狠越不报警）；
//   ② 波比据此把任务置 DONE，置终态无任何交付物门禁；
//   ③ 小呆呆巡视只读收尾原文，被「已闭环、已交回」说服，判合法收工。
// 本测试钉住三件事：新判据按**阶段 + 落盘事实**触发（不再依赖汇报措辞）、缺件清单逐件准确、教训库真的会被选中注入。
//
// server.js 是自启服务的单体（import 即 listen），沿用 test/spin-and-patrol.test.js 的做法：按名从源码抠出定义、
// 在 vm 里 eval 后测。抠不到就抛错（不静默测空壳），源码重构改了这些函数名/签名时本测试会立刻红。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

import { safeResolve, resolveRepoFile, resolveEmpFile, OFFICE_URI_PREFIX } from '../paths.js'
import { facetDocList } from '../coverage.js'   // primaryFacetDoc 依赖它（server.js 里是 import 进来的，沙箱得喂真的）

const APP = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(APP, 'server.js'), 'utf8')
const EMPLOYEES = JSON.parse(fs.readFileSync(path.join(APP, 'employees.json'), 'utf8'))

function grab(name, re) {
  const m = src.match(re)
  if (!m) throw new Error(`抠不到 ${name}：server.js 结构变了，请同步更新 test/release-deliverables.test.js`)
  return m[0]
}
const PIECES = [
  // frontmatter 解析（用真的，别自造 stub——档案格式变了本测试也该跟着红）
  grab('findComment', /^function findComment\(s\) \{[\s\S]*?\n\}/m),
  grab('coerce', /^function coerce\(v\) \{[\s\S]*?\n\}/m),
  grab('parseFrontmatter', /^function parseFrontmatter\(text\) \{[\s\S]*?\n\}/m),
  // 四件核对
  grab('RELEASE_COMMON_DIR', /^const RELEASE_COMMON_DIR = .*$/m),
  grab('RELEASE_CHANGELOG_FILE', /^const RELEASE_CHANGELOG_FILE = .*$/m),
  grab('RELEASE_PERMLOG_FILE', /^const RELEASE_PERMLOG_FILE = .*$/m),
  grab('escapeRe', /^const escapeRe = .*$/m),
  grab('hasCodeCard', /^const hasCodeCard = .*$/m),
  grab('sameArchive', /^const sameArchive = .*$/m),
  grab('primaryFacetDoc', /^function primaryFacetDoc\(fm\) \{.*$/m),   // 版本目录锚点＝facet_doc 列表第一项
  grab('releaseNoticePrinted', /^function releaseNoticePrinted\(taskFileRel, extraText = ''\) \{[\s\S]*?\n\}/m),
  grab('releaseDeliverableCheck', /^function releaseDeliverableCheck\(taskFileRel, extraText = ''\) \{[\s\S]*?\n\}/m),
  grab('releaseMissingLines', /^const releaseMissingLines = .*$/m),
  grab('TERMINAL_STATUS_RE', /^const TERMINAL_STATUS_RE = .*$/m),
  grab('archiveStatusOf', /^function archiveStatusOf\(taskFileRel\) \{[\s\S]*?\n\}/m),
  grab('inReleaseNotesPhase', /^const inReleaseNotesPhase = .*$/m),
  grab('releaseTurnMissing', /^function releaseTurnMissing\(run\) \{[\s\S]*?\n\}/m),
  // 教训库注入
  grab('LESSON_MAX_ITEMS', /^const LESSON_MAX_ITEMS = .*$/m),
  grab('LESSON_MAX_CHARS', /^const LESSON_MAX_CHARS = .*$/m),
  grab('LESSON_MIN_ITEMS', /^const LESSON_MIN_ITEMS = .*$/m),
  grab('LESSON_PINNED_MAX_ITEMS', /^const LESSON_PINNED_MAX_ITEMS = .*$/m),
  grab('LESSON_PINNED_MAX_CHARS', /^const LESSON_PINNED_MAX_CHARS = .*$/m),
  grab('PINNED_SECTION_RE', /^const PINNED_SECTION_RE = .*$/m),
  grab('textGrams', /^function textGrams\(s\) \{[\s\S]*?\n\}/m),
  grab('extractLessonItems', /^function extractLessonItems\(md\) \{[\s\S]*?\n\}/m),
  grab('buildLessonsBlock', /^function buildLessonsBlock\(employee, focusText\) \{[\s\S]*?\n\}/m),
]

// 沙箱的可变依赖：runs 注册表与三个路径解析器。默认用**真的** paths.js（跑真实档案那几例），
// 造场景时就地换成指向临时目录的 stub（对象属性即 vm 全局，改了立刻生效）。
const sandbox = {
  fs, path, console,
  runs: {},
  isConsult: r => !!(r && r.consult),
  EMPLOYEES,
  safeResolve, resolveRepoFile, resolveEmpFile, OFFICE_URI_PREFIX, facetDocList,
}
const ctx = vm.createContext(sandbox)
vm.runInContext(`${PIECES.join('\n')}
globalThis.__api = { releaseDeliverableCheck, releaseTurnMissing, releaseMissingLines, buildLessonsBlock, extractLessonItems, textGrams, LESSON_MAX_ITEMS, LESSON_MAX_CHARS, LESSON_PINNED_MAX_ITEMS, LESSON_PINNED_MAX_CHARS, PINNED_SECTION_RE }`, ctx)
const { releaseDeliverableCheck, releaseTurnMissing, buildLessonsBlock, extractLessonItems, LESSON_MAX_ITEMS, LESSON_MAX_CHARS, LESSON_PINNED_MAX_ITEMS, LESSON_PINNED_MAX_CHARS, PINNED_SECTION_RE } = vm.runInContext('__api', ctx)

const CODE_CARD = '```olcard\n{"type":"code","lang":"text","title":"发版通知","content":"【v9.9 发布完成】…"}\n```'


// Memory is per-installation runtime data. Test lesson selection against synthetic fixtures.
const memoryFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-lessons-'))
function fixtureMemory(rel) { return path.join(memoryFixture, rel) }
for (const [key, employee] of Object.entries(EMPLOYEES)) {
  const file = fixtureMemory(employee.memoryFile)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lessons = Array.from({ length: 40 }, (_, i) =>
    `- 发布沟通 ${i}：版本发布说明、CHANGELOG、权限变更和微信发版通知，四件交付物必须核对，即便派工只点名了前三件也要补齐。`)
  const pinned = key === 'bobby' ? '## 常驻\n- 固定工具链：git.example.test，项目 101 102 103。\n\n' : ''
  fs.writeFileSync(file, pinned + '## 发布沟通\n' + lessons.join('\n'))
}
sandbox.resolveEmpFile = fixtureMemory
test.after(() => fs.rmSync(memoryFixture, { recursive: true, force: true }))

// ---------- 造一棵最小档案树（版本目录 + 00-通用资料 两份台账），并把解析器指过去 ----------
function makeTree({ version = 'v9.9', notes = false, changelogVer = null, permVer = null, common: withCommon = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-rel-'))
  const verDir = path.join(tmp, 'docs', 'x需求', `06-${version}`)
  const common = path.join(tmp, 'docs', 'x需求', '00-通用资料')
  fs.mkdirSync(verDir, { recursive: true }); fs.mkdirSync(path.join(tmp, 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(verDir, 'spec.md'), '# 需求说明与验收标准\n')
  if (notes) fs.writeFileSync(path.join(verDir, `版本发布说明-${version}.md`), '# 版本发布说明\n')
  const ln = v => v ? `\n---\n\n## ${v} · 2026-08-25\n\n正文\n` : ''
  if (withCommon) {
    fs.mkdirSync(common, { recursive: true })
    fs.writeFileSync(path.join(common, '示例项目-版本变更日志(CHANGELOG).md'), '# 版本更新记录\n' + ln(changelogVer) + ln('v9.0'))
    fs.writeFileSync(path.join(common, '示例项目-权限变更记录(配置员).md'), '# 权限变更记录\n' + ln(permVer) + ln('v9.0'))
  }
  fs.writeFileSync(path.join(tmp, 'tasks', 't.md'),
    `---\ntask: 造的版本任务\nversion: ${version}\nstatus: PM_RELEASE_NOTES\nfacet_doc: docs/x需求/06-${version}/spec.md\ngates:\n  released_prod: true  # 2026-08-25 已发线上\n---\n\n# 任务\n`)
  sandbox.safeResolve = rel => path.join(tmp, rel)
  sandbox.resolveRepoFile = rel => { const p = path.join(tmp, rel); return fs.existsSync(p) ? p : null }
  sandbox.runs = {}
  return { tmp, archive: 'tasks/t.md' }
}
function restoreRealPaths() {
  sandbox.safeResolve = safeResolve; sandbox.resolveRepoFile = resolveRepoFile; sandbox.runs = {}
}

test('事故重放：只交了「版本发布说明」一件 → 明确报出缺 ②③④ 三件', () => {
  const { archive } = makeTree({ notes: true })
  const chk = releaseDeliverableCheck(archive)
  assert.equal(chk.version, 'v9.9')
  assert.deepEqual(Array.from(chk.missing, m => m.key), ['changelog', 'perm', 'notice'])
  // 同一份档案 + 同一轮「只字未提 CHANGELOG」的收尾汇报，旧判据（做完三件才查第四件）是**不报警**的：
  const oldResult = '版本发布说明已产出并落盘，飞书需求表已对账。【交回】波比'
  const oldWouldWarn = (/三件套/.test(oldResult) || (/版本发布说明/.test(oldResult) && /CHANGELOG/i.test(oldResult)))
  assert.equal(oldWouldWarn, false, '旧判据本就不会响——这正是本次要修的盲区')
  restoreRealPaths()
})

test('四件齐（两份台账都有本版条目 + 本任务线印过 code 卡）→ missing 为空', () => {
  const { archive } = makeTree({ notes: true, changelogVer: 'v9.9', permVer: 'v9.9' })
  sandbox.runs = { r1: { employee: 'feifei', taskFile: 'tasks/t.md', result: `搞定\n${CODE_CARD}` } }
  assert.equal(releaseDeliverableCheck(archive).missing.length, 0)
  restoreRealPaths()
})

test('第 ④ 件只认 code 卡：普通代码块 / 别人的 code 卡 / 只读窗的 code 卡都不算数', () => {
  const { archive } = makeTree({ notes: true, changelogVer: 'v9.9', permVer: 'v9.9' })
  const plainFence = '```text\n【v9.9 发布完成】…\n```'
  sandbox.runs = {
    r1: { employee: 'feifei', taskFile: 'tasks/t.md', result: plainFence },              // 普通代码块：前端不出复制按钮
    r2: { employee: 'bobby', taskFile: 'tasks/t.md', result: CODE_CARD },                 // 不是菲菲交的
    r3: { employee: 'feifei', taskFile: 'tasks/t.md', result: CODE_CARD, consult: true }, // 只读窗聊出来的不算交付
    r4: { employee: 'feifei', taskFile: 'tasks/别的任务.md', result: CODE_CARD },          // 别的任务线
  }
  assert.deepEqual(Array.from(releaseDeliverableCheck(archive).missing, m => m.key), ['notice'])
  // 本轮刚收工、尚未落进 runs 注册表 → extraText 兜底
  assert.equal(releaseDeliverableCheck(archive, `收工汇报\n${CODE_CARD}`).missing.length, 0)
  restoreRealPaths()
})

test('版本号前缀不误命中：台账里只有 v9.9.1 时，v9.9 仍判缺', () => {
  const { archive } = makeTree({ notes: true, changelogVer: 'v9.9.1', permVer: 'v9.9.1' })
  assert.deepEqual(Array.from(releaseDeliverableCheck(archive).missing, m => m.key), ['changelog', 'perm', 'notice'])
  restoreRealPaths()
})

test('不适用一律返 null，绝不误挡无关任务', () => {
  const { tmp } = makeTree({ notes: true })
  // ① 没有 facet_doc（拿不到版本目录锚点）
  fs.writeFileSync(path.join(tmp, 'tasks', 'nofacet.md'), '---\ntask: x\nversion: v9.9\nstatus: DONE\n---\n')
  assert.equal(releaseDeliverableCheck('tasks/nofacet.md'), null)
  // ② 没有 version
  fs.writeFileSync(path.join(tmp, 'tasks', 'nover.md'), '---\ntask: x\nfacet_doc: docs/x需求/06-v9.9/spec.md\n---\n')
  assert.equal(releaseDeliverableCheck('tasks/nover.md'), null)
  // ③ 版本没发过线上（被取消 / 并进别版 / 还在研）——四件是上线之后才欠的，归档它不该被拦
  fs.writeFileSync(path.join(tmp, 'tasks', 'unshipped.md'),
    '---\ntask: x\nversion: v9.9\nstatus: DONE\nfacet_doc: docs/x需求/06-v9.9/spec.md\ngates:\n  released_prod: false\n---\n')
  assert.equal(releaseDeliverableCheck('tasks/unshipped.md'), null)
  // ④ 压根没挂任务档案 / 档案读不到
  assert.equal(releaseDeliverableCheck(''), null)
  assert.equal(releaseDeliverableCheck('tasks/根本不存在.md'), null)
  restoreRealPaths()
  // ⑤ 这条流水线没有那两份通用台账（＝不走示例项目发布沟通口径）→ 整个门禁不适用
  const bare = makeTree({ notes: true, common: false })
  assert.equal(releaseDeliverableCheck(bare.archive), null)
  restoreRealPaths()
})

test('releaseTurnMissing 按阶段触发：汇报里只字不提 CHANGELOG 也照样报警（本次事故的正面回归）', () => {
  const { archive } = makeTree({ notes: true })   // 档案 status=PM_RELEASE_NOTES
  const run = { employee: 'feifei', status: 'done', taskFile: archive, result: '版本发布说明已落盘。【交回】波比' }
  const miss = releaseTurnMissing(run)
  assert.ok(miss, '处在发布沟通阶段 + 四件未齐 → 必须报警')
  assert.equal(miss.missing.length, 3)
  // 越界守卫：不是菲菲 / 没收工 / 只读窗，一律不报
  assert.equal(releaseTurnMissing({ ...run, employee: 'bobby' }), null)
  assert.equal(releaseTurnMissing({ ...run, status: 'running' }), null)
  assert.equal(releaseTurnMissing({ ...run, consult: true }), null)
  restoreRealPaths()
})

test('releaseTurnMissing 保留关键词旁路：档案已被推到 DONE、但本轮确在补发布交付物', () => {
  const { tmp, archive } = makeTree({ notes: true })
  const md = fs.readFileSync(path.join(tmp, 'tasks', 't.md'), 'utf8').replace('status: PM_RELEASE_NOTES', 'status: DONE')
  fs.writeFileSync(path.join(tmp, 'tasks', 't.md'), md)
  const run = { employee: 'feifei', status: 'done', taskFile: archive, result: '我来补 CHANGELOG 条目' }
  assert.ok(releaseTurnMissing(run), '非发布阶段但本轮在做发布交付物 → 仍按四件核对')
  assert.equal(releaseTurnMissing({ ...run, result: '今天梳理了新需求的 facet' }), null, '既不在阶段、也没在做发布交付物 → 不打扰')
  restoreRealPaths()
})

// ---------- 教训库注入 ----------
test('教训库按条目切分：菲菲的库能切出足量条目且带分类', () => {
  const items = extractLessonItems(fs.readFileSync(fixtureMemory(EMPLOYEES.feifei.memoryFile), 'utf8'))
  assert.ok(items.length >= 30, `切出的条目太少（${items.length}），解析可能失效`)
  assert.ok(items.some(i => i.section === '发布沟通'))
})

test('事故重放：那条派工进来时，教训库里「四件交付物」的教训会被选中注入', () => {
  restoreRealPaths()
  // 2026-08-25 那条派工的原文摘要（波比只点名了「版本发布说明」一件）
  const dispatch = [
    '【派工】任务档案：office-lab/tasks/2026-08-21-v5.19-示例项目体验优化批次.md',
    '版本：示例项目工作台 v5.19 ｜ 状态=PM_RELEASE_NOTES ｜ owner=feifei',
    'v5.19 已全部发线上。请产出**版本发布说明**，落盘 docs/示例项目需求/06-v5.19/版本发布说明-v5.19.md，与 RELEASE_CHECKLIST 同级。',
    '三来源交叉比对无遗漏：①原始需求 & ②需求确认 & ③实施记录。权限部分：本版无新增权限码，据此向配置管理员说明「无需新配权」即可。',
    '产出后按你 SOP 顺带更新飞书需求表这 6 条为「已完成」，并回写任务档案。',
  ].join('\n')
  const block = buildLessonsBlock('feifei', dispatch)
  assert.ok(block.includes('你的教训库'), '应产出教训注入块')
  // 这条 2026-08-18 的教训，字面就写着「即便派工只点名了前三件也要补齐」——正是本次该被想起来的那条
  assert.ok(block.includes('即便派工只点名了前三件'), '最该被选中的那条教训没进注入块')
  assert.ok(/四件/.test(block), '四件交付物相关教训未命中')
  const picked = block.split('\n').filter(l => l.startsWith('- '))
  assert.ok(picked.length <= LESSON_MAX_ITEMS && picked.length > 0)
  assert.ok(block.length < LESSON_MAX_CHARS * 2, `注入块过长（${block.length}），预算失效`)
})

test('教训库注入有界且不崩：不相关话题给兜底条数，无教训库的员工返空串', () => {
  restoreRealPaths()
  for (const key of Object.keys(EMPLOYEES)) {
    const block = buildLessonsBlock(key, '随便聊聊今天天气怎么样')
    if (!block) continue                          // 该员工没有教训库文件 → 空串，不报错
    const picked = block.split('\n').filter(l => l.startsWith('- '))
    // 上限＝相关性配额 + 常驻配额（常驻是加法、不摊薄相关性，见 server.js 常量注释）
    const cap = LESSON_MAX_ITEMS + LESSON_PINNED_MAX_ITEMS
    assert.ok(picked.length > 0 && picked.length <= cap, `${key}: 条数越界 ${picked.length}`)
    assert.ok(block.length < (LESSON_MAX_CHARS + LESSON_PINNED_MAX_CHARS) * 2, `${key}: 注入块过长 ${block.length}`)
  }
  assert.equal(buildLessonsBlock('查无此人', 'x'), '')
})

// ---------- 常驻教训段（2026-09-21，run `20260921074152-5a44fd`）----------
// 事故：纯相关性打分对**工具链/环境类**教训是系统性失灵的——打分看「教训正文 × 派工文本」的中文 bigram 字面重叠，
// 而这类教训的词是 host:port / ssh remote / -R 参数，派工头讲的是业务（规格正确性链 / REQ-0342 / QA 收束），
// 交集近乎为零。那一轮波比 8 条 glab 教训（记了 5 遍、跨 08-18～09-07）排名 118/121/123/124/125（共 125 条）全部垫底、
// 一条没注入，于是他花约 7 分钟、27 条 Bash 现场重新摸索 glab 的 host / 项目 ID / 可用命令形态。
test('常驻段无条件注入：与派工用词零重叠也照样进块（glab 那类固定坑不再靠打分抽签）', () => {
  restoreRealPaths()
  const memo = fs.readFileSync(fixtureMemory(EMPLOYEES.bobby.memoryFile), 'utf8')
  const pinnedItems = extractLessonItems(memo).filter(i => PINNED_SECTION_RE.test(i.section))
  assert.ok(pinnedItems.length > 0, '波比教训库应有常驻段（本回归的前提）')

  // 刻意用一条**与常驻段字面毫无交集**的派工（讲业务，不讲工具链）——正是事故那轮的形态
  const dispatch = '【派工】任务档案：office-lab/tasks/2026-09-18-示例项目-v5.23.md\n版本：示例项目 v5.23——规格正确性链（源头修复诉求关联落规格 + 下游展示）｜状态=PM_DRAFTING\n请完成本版发测准备。'
  const block = buildLessonsBlock('bobby', dispatch)
  assert.ok(block.includes('常驻'), '注入块标题应点明常驻条数')
  for (const it of pinnedItems.slice(0, LESSON_PINNED_MAX_ITEMS)) {
    assert.ok(block.includes(it.text.slice(0, 30)), `常驻条目未被注入：${it.text.slice(0, 30)}…`)
  }
  // 事故重放：正是这几样，上一轮靠相关性一条都没选上
  assert.ok(block.includes('git.example.test'), '合成工具链教训应常驻')
  assert.ok(block.includes('101 102 103'), '合成项目编号应常驻')
})

test('常驻是加法不是挤占：相关性名额一条不少；没写常驻段的员工行为与改造前一字不差', () => {
  restoreRealPaths()
  const dispatch = '【派工】v5.23 发测准备：逐仓枚举发布范围、建 MR、出部署清单、回填 RELEASE_CHECKLIST。'
  const lines = b => b.split('\n').filter(l => l.startsWith('- '))

  const bobby = buildLessonsBlock('bobby', dispatch)
  const nPinned = lines(bobby).filter(l => l.startsWith('- 〔常驻〕')).length
  assert.ok(nPinned > 0, '波比应注入到常驻条目')
  assert.equal(lines(bobby).length - nPinned, LESSON_MAX_ITEMS, '相关性配额应仍为满额，不被常驻摊薄')

  // 无常驻段的员工：条数/字符须严格落在**改造前**的老配额内
  for (const key of ['feifei', 'ggbond', 'mihu']) {
    if (!EMPLOYEES[key]) continue
    const block = buildLessonsBlock(key, dispatch)
    if (!block) continue
    assert.ok(!block.includes('〔常驻〕'), `${key}: 不该凭空多出常驻条目`)
    assert.ok(lines(block).length <= LESSON_MAX_ITEMS, `${key}: 条数被放大到 ${lines(block).length}`)
  }
})
