import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSignoff, leakedInvocations, SIGNOFF_EXEMPT_EMPLOYEES, signoffNudge, classifyWait, pushSnapshot, renderResumeSnapshot, snapshotDue, patrolReason, SNAPSHOT_MAX, SNAPSHOT_STALE_MS, SNAPSHOT_NUDGE_AFTER_MS } from '../stall-guard.js'

// ---------- G1 收工即校验 ----------
test('三种合规标记都放行', () => {
  assert.equal(validateSignoff('做完了。\n【下一棒】迷糊老师 跑全量 QA').kind, 'next')
  assert.equal(validateSignoff('结论如下。\n【交回】facet 已冻结').kind, 'back')
  assert.equal(validateSignoff('卡在口径。\n【等你拍板】损耗率默认值是否回填存量').kind, 'gate')
})
test('`【等你拍板】无` 是协议里合法的「无需动作」收尾 —— 放行但不算待拍事项', () => {
  const v = validateSignoff('已闭环。\n【等你拍板】无')
  assert.equal(v.ok, true)
  assert.equal(v.kind, 'gate-none')
})
test('一个标记都没有 → 当场拒收（不再事后派巡视）', () => {
  const v = validateSignoff('我把用例更新了一下，看起来还不错。')
  assert.equal(v.ok, false)
  assert.equal(v.code, 'no-marker')
  assert.match(v.nudge, /独占一行/)
  assert.match(v.nudge, /别重头做/)
})
test('空收尾单独一类（常见于工具报错后没恢复）', () => {
  const v = validateSignoff('   ')
  assert.equal(v.ok, false)
  assert.equal(v.code, 'empty')
})
test('写了【等你拍板】但后面是空的 → 拒收，并点明「写不出来说明这不是要老板拍的事」', () => {
  const v = validateSignoff('干了些活。\n【等你拍板】')
  assert.equal(v.ok, false)
  assert.equal(v.code, 'gate-empty')
  assert.match(v.nudge, /是你自己该干完的活/)
})
test('写了【下一棒】但没写交给谁 → 拒收', () => {
  const v = validateSignoff('【下一棒】')
  assert.equal(v.ok, false)
  assert.equal(v.code, 'next-empty')
})
test('标记必须独占行首——引用别人的标记名不算自己写了', () => {
  const v = validateSignoff('我用你自己的【下一棒】迷糊 那套办法试了一下，没成。')
  assert.equal(v.ok, false)
  assert.equal(v.code, 'no-marker')
})
test('多个标记时按 下一棒 > 交回 > 等你拍板 的优先级取（交接优先于停等）', () => {
  assert.equal(validateSignoff('【等你拍板】某事\n【下一棒】GG Bond 改代码').kind, 'next')
  assert.equal(validateSignoff('【等你拍板】某事\n【交回】结论').kind, 'back')
})
test('无标记但有在跑的后台句柄 → 算合法等待，不拒收（G3）', () => {
  const v = validateSignoff('已把 3 个 headless 会话甩出去，在等结果。', { handles: ['sess-abc123def'] })
  assert.equal(v.ok, true)
  assert.equal(v.code, 'waiting')
})
test('signoffNudge 对每种 code 都给出针对性尾注，不是同一段套话', () => {
  const a = signoffNudge('no-marker'), b = signoffNudge('gate-empty'), c = signoffNudge('empty')
  assert.notEqual(a, b); assert.notEqual(b, c)
  assert.match(a, /想到但没试过的路/)
})

// ---------- G3 合法等待 ----------
test('声称等待 + 收尾里给了可查句柄 → 合法', () => {
  const w = classifyWait('批次已提交，在等 sessionId: sess-9f3a2b1c 跑完。')
  assert.equal(w.legit, true)
  assert.equal(w.escalate, false)
})
test('引擎侧有在跑的后台任务 → 合法（哪怕它自己没提句柄）', () => {
  assert.equal(classifyWait('在等后台批次。', ['bg-task-1']).legit, true)
})
test('声称在等、但给不出任何句柄、引擎侧也没后台任务 → 立刻升级（不是合法等待）', () => {
  const w = classifyWait('我在等 DDL 执行完。', [])
  assert.equal(w.legit, false)
  assert.equal(w.escalate, true)
  assert.match(w.why, /句柄丢了还在等/)
})
test('压根没提等待 → 既不合法等待也不升级（走别的判据）', () => {
  const w = classifyWait('我改完代码了。', [])
  assert.equal(w.legit, false)
  assert.equal(w.escalate, false)
})

// ---------- G2 进度快照 ----------
test('done 与 next 至少给一个', () => {
  assert.match(pushSnapshot([], { avoid: '别再试 A 方案' }).error, /至少给一个/)
  assert.ok(pushSnapshot([], { done: 'facet F1-F3 已绿' }).snapshot)
})
test('快照只保最近 N 条', () => {
  let list = []
  for (let i = 0; i < SNAPSHOT_MAX + 5; i++) list = pushSnapshot(list, { done: 'step' + i }).list
  assert.equal(list.length, SNAPSHOT_MAX)
  assert.equal(list[list.length - 1].done, 'step' + (SNAPSHOT_MAX + 4))
})
test('续跑注入块含三段，且明说「不是你的记忆」', () => {
  const { list } = pushSnapshot([], { done: 'F1-F3 已绿', next: '跑 F4 的 RED 校准', avoid: 'openUrl 那条路已确认不通' })
  const md = renderResumeSnapshot(list, Date.parse(list[0].at) + 1000)
  assert.match(md, /不是你的记忆/)
  assert.match(md, /已做到：F1-F3 已绿/)
  assert.match(md, /下一步：跑 F4 的 RED 校准/)
  assert.match(md, /别再重做：openUrl/)
  assert.ok(!md.includes('先花一分钟核对现状'))   // 新鲜快照不加过期提示
})
test('陈旧快照仍注入，但标注「可能已过期，先核对现状」', () => {
  const { list } = pushSnapshot([], { done: 'x', next: 'y' })
  const md = renderResumeSnapshot(list, Date.parse(list[0].at) + SNAPSHOT_STALE_MS + 60_000)
  assert.match(md, /先花一分钟核对现状再动手/)
})
test('无快照时注入块为空串（调用方据此改提示语，不注一段空壳）', () => {
  assert.equal(renderResumeSnapshot([]), '')
  assert.equal(renderResumeSnapshot(null), '')
})
test('多条快照时只注最新一条，但说明共有几条', () => {
  let list = pushSnapshot([], { done: 'a', next: 'b' }).list
  list = pushSnapshot(list, { done: 'c', next: 'd' }).list
  const md = renderResumeSnapshot(list, Date.now())
  assert.match(md, /已做到：c/)
  assert.match(md, /本会话共 2 条快照/)
})
test('snapshotDue：跑够时长且从未落过 → 该催；刚落过 → 不催', () => {
  const now = Date.now()
  assert.equal(snapshotDue({ elapsedMs: SNAPSHOT_NUDGE_AFTER_MS + 1000, list: [], now }), true)
  assert.equal(snapshotDue({ elapsedMs: 1000, list: [], now }), false)
  assert.equal(snapshotDue({ elapsedMs: SNAPSHOT_NUDGE_AFTER_MS + 1000, list: [{ at: new Date(now).toISOString() }], now }), false)
  assert.equal(snapshotDue({ elapsedMs: SNAPSHOT_NUDGE_AFTER_MS + 1000, list: [{ at: new Date(now - SNAPSHOT_NUDGE_AFTER_MS - 1000).toISOString() }], now }), true)
})

// ---------- 巡视分流 ----------
test('G1 落地后巡视只留四类模糊态，按固定优先级返回', () => {
  assert.equal(patrolReason({}), null)
  assert.equal(patrolReason({ qa_hollow: true }).code, 'qa_hollow')
  assert.equal(patrolReason({ release_incomplete: true, wait_no_handle: true }).code, 'release_incomplete')
})

// ---------- 豁免名单：拿真实存量数据量出来的边界 ----------
// 604 条历史 dispatch 收工的拒收率：chaorenq 47.8% / feisila 100% / feifei 4.1% / mihu 10.2% /
// ggbond·bobby 0%。前两个高不是因为爱空停，是**它们的产出本身就是结论、无棒可交**。
// 不豁免的后果是自指的：巡视本来就是来处理空停的，结果它自己每轮被判空停、被拒收 2 次再放行。
test('巡视员与审计在豁免名单里（否则 E5 省下的成本原封不动还回去）', () => {
  assert.ok(SIGNOFF_EXEMPT_EMPLOYEES.has('chaorenq'))
  assert.ok(SIGNOFF_EXEMPT_EMPLOYEES.has('feisila'))
})
test('流水线四角色不豁免——那 3.8% 才是真空停率，正是要抓的', () => {
  for (const k of ['feifei', 'ggbond', 'mihu', 'bobby']) assert.ok(!SIGNOFF_EXEMPT_EMPLOYEES.has(k), k)
})
test('巡视员那种「合法收工，无需动作」的白话收尾，本身确实过不了标记校验（所以必须靠豁免、不能靠改判据）', () => {
  const v = validateSignoff('判定：**合法收工，无需 resume，也无需升级老板**。已知会：会话 20260824014125-2d184a 不做处置。')
  assert.equal(v.ok, false)
  assert.equal(v.code, 'no-marker')
})

// ---------- G1.5 工具调用泄漏成正文（2026-09-07 事故 run 20260907053624-d858bf）----------
// 真实数据：那条 run 5 轮里 4 轮的**结尾**都是这种假调用，末轮丢掉的是 v5.22 的看板回写。
const REAL_LEAK =
  '两仓四条 REQ 全链对账绿（target=master）。回写看板：条目→待测（发测完成、待老板测试环境回归），落时间线，刷版本级状态。\n\n' +
  'card <invoke name="mcp__office-lab-collab__set_entry_status"> <parameter name="no">REQ-0334</parameter> ' +
  '<parameter name="status">待测</parameter> <parameter name="stage">已发测(FE!2211合入master+部署)→待老板:测试环境人工回归</parameter> </invoke>'

test('假调用（写成正文的 invoke）被抓出来，并点名具体工具', () => {
  assert.deepEqual(leakedInvocations(REAL_LEAK), ['mcp__office-lab-collab__set_entry_status'])
})
test('一轮里多个假调用：去重且保序', () => {
  const t = '<invoke name="Bash"><parameter name="command">git status</parameter></invoke>\n' +
    '<invoke name="Read"><parameter name="file_path">a.md</parameter></invoke>\n' +
    '<invoke name="Bash"><parameter name="command">git log</parameter></invoke>'
  assert.deepEqual(leakedInvocations(t), ['Bash', 'Read'])
})
test('正常收工汇报零误报', () => {
  assert.deepEqual(leakedInvocations('两仓 MR 已建、看板已回写。\n【等你拍板】合并 !303 与 !2211'), [])
  assert.deepEqual(leakedInvocations(''), [])
  assert.deepEqual(leakedInvocations(null), [])
})
// 与 §3.116 同一条教训：「谈论一种标记」≠「使用这种标记」。员工写 SOP / 复盘 / 解释本 bug 时
// 会**引用**这段语法，引用一律走代码块或行内代码 → 不能算泄漏，否则这条门禁会把讲解它的那份汇报也判死。
test('围栏代码块里引用的示例不算泄漏', () => {
  const t = '教训：别把调用写成正文，比如下面这样是错的\n\n```\n<invoke name="Bash"><parameter name="command">ls</parameter></invoke>\n```\n\n【交回】已记入 memories'
  assert.deepEqual(leakedInvocations(t), [])
})
test('行内代码里引用的不算泄漏；末尾未闭合围栏也当代码剥掉', () => {
  assert.deepEqual(leakedInvocations('上一轮我把 `<invoke name="Bash"><parameter name="x">1</parameter></invoke>` 写成了正文'), [])
  assert.deepEqual(leakedInvocations('例子如下：\n```xml\n<invoke name="Read"><parameter name="p">a</parameter></invoke>'), [])
})
test('只提一句工具名、没有参数也没有收尾 → 不算（判据要结构，不靠关键字）', () => {
  assert.deepEqual(leakedInvocations('我准备用 <invoke name="Bash"> 这种方式，但先问你'), [])
})
