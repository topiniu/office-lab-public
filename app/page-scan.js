// ============================================================================
// 页面「一眼巡检」（page sanity scan）—— 2026-09-08 老板拍板
//
// 缘起：迷糊测完判绿之后，人工打开页面**第一眼**就是一堆问题——菜单项重复、标签渲染两遍、
// 头部写着「未登录」右上角却挂着用户名、分项加起来比总数多 1、生产环境露出「测试」字样和
// 「-v23」的造数残留、数字没有单位。这些没有一条被现有三层视觉能力拦住，因为：
//
//   · `visual_acceptance`  比的是**元素自己的上一次**（像素基线），只答「变没变」；
//   · `design_conformance` 比的是**模块里同类的多数写法**，只答「像不像一家人」；
//   · `aesthetic_review`   问的是 rubric 八维**设计语言**，只答「好不好看」。
//
// 三层全是**比对式**：都需要一个参照物（历史基线 / 模块多数 / 设计 rubric）。而人第一眼用的
// 根本不是参照物，是几条内建的**一致性直觉**——跟自己一致（同页两处数字对不上）、跟常识一致
// （生产完成日 = 到仓日不可能）、跟宣称一致（说未登录却有人名）。这类判断**无基线、零前置**，
// 一张图就能做，恰恰是缺陷密度最高、而机器这边最贵的那一步（三层都要先挂断言、跑会话、录基线）。
//
// 所以本模块是**第四档，与那三层并列而不是串联**：
//   入口不锁 sessionId（任意截图都能吃）· 判据换成「异常巡检 rubric」· 产出分两档（自证/待复核）
//   · 结论直接转缺陷单骨架。
//
// 三条硬边界，是它区别于「AI 拍脑袋说这页有问题」的分界线：
//   ① **只看页面主体**。左侧菜单、顶栏、面包屑、页脚属于**通用外壳**，每个页面都一样，不是这个
//      功能的缺陷——声明成外壳区的 finding 一律打回（老板明确要求）。更进一步：同一条现象在多张
//      页面截图里反复出现的，自动降级为「全站议题」，不算本次改动的账（沿用 C3 对比度那条既有口径）。
//   ② **算术类真的验算**。说「130+132+2+1=265 但页面写 264」就得把 parts 和 total 交出来，机器
//      加一遍；加得上的（自己算错的）直接打回。这是本模块最硬的一条证据。
//   ③ **只报可观测事实，不诊断根因**（红线 5）。所以每条要 `quote`（截图里抄下来的原文）+
//      `expected`（本该是什么样），**不要 suggestion**——「怎么改」是开发的活，QA 越界过一次
//      （v5.10 BUG-001「疑似重复提交」把开发带偏）。
//
// 纯函数、无 fs、无网络，便于 `node --test`。
// ============================================================================

// ---------- 判据 rubric：10 类「一眼能看出的不正常」 ----------
// 不是拍脑袋列的——这 10 类是从 2026-09-08 那张跟单看板截图的实际发现里反推出来的，
// 13 个发现有 12 个落在这张表内。新增维度要有真实案例撑，别为了凑齐而凑。
export const SCAN_RUBRIC = [
  { key: 'duplicate', label: '重复渲染', ask: '有没有同一个东西出现了两遍？（菜单项、标签、列、按钮、整块区域）', severity: '中' },
  { key: 'contradiction', label: '自相矛盾', ask: '同一屏里有没有两处互相打脸的状态？（写着"未登录"但右上角有用户名；标题说 0 条但下面列了 5 行）', severity: '高' },
  { key: 'arithmetic', label: '数字不勾稽', ask: '分项加起来等于总计吗？标签页数字和列表条数对得上吗？明细数和标题数一致吗？', severity: '中' },
  { key: 'dirty-data', label: '脏数据外泄', ask: '有没有造数/测试痕迹漏到界面上？（"测试"字样、`-v23` 版本后缀、lorem、undefined/null/NaN、占位邮箱）', severity: '高' },
  { key: 'format', label: '格式与单位', ask: '数值有单位吗？同类数值单位一致吗？时间格式、小数位、千分位是不是同一套？', severity: '低' },
  { key: 'placeholder', label: '空态与占位', ask: '该有内容的地方是不是显示了"--"/"未维护"/空白？为 0 的项还占着位吗？兜底默认值（"标准 1h"）像不像没配？', severity: '低' },
  { key: 'truncation', label: '截断与溢出', ask: '文字被切了吗？出现省略号了吗？有没有双滚动条、元素叠在一起、内容溢出容器？', severity: '中' },
  { key: 'impossible', label: '业务不可能值', ask: '这个值在业务上说得通吗？（生产完成日 = 到仓日、负库存、未来的完成时间、超期天数两处不一致）', severity: '中' },
  { key: 'leak', label: '敏感信息未脱敏', ask: '手机号/身份证/银行卡/邮箱/地址是不是明文全量展示？', severity: '高' },
  { key: 'broken', label: '明显破损', ask: '有没有裂图、报错文案、英文键名/变量名外露、样式塌陷、控件错位到不可用？', severity: '高' },
]
export const rubricOf = key => SCAN_RUBRIC.find(r => r.key === key) || null

// ---------- 区域：外壳不判，只判主体 ----------
// 老板原话「除了菜单/通用部分外的页面里面」——外壳每个页面都长一样，它的毛病不是这个功能的账。
export const SHELL_ZONES = [
  { key: 'sidebar', label: '左侧主菜单 / 导航树' },
  { key: 'header', label: '顶栏（logo / 用户区 / 全局操作）' },
  { key: 'breadcrumb', label: '面包屑' },
  { key: 'footer', label: '全局页脚' },
]
export const BODY_ZONES = [
  { key: 'filter', label: '筛选 / 查询区' },
  { key: 'stat', label: '统计条 / 指标卡 / 页签计数' },
  { key: 'list', label: '列表 / 表格 / 卡片流' },
  { key: 'detail', label: '详情区 / 主内容面板' },
  { key: 'action', label: '操作区 / 行内按钮' },
  { key: 'modal', label: '弹窗 / 抽屉' },
  { key: 'form', label: '表单' },
  { key: 'empty', label: '空态 / 加载态 / 错误态' },
]
export const isShellZone = z => SHELL_ZONES.some(s => s.key === z)
export const isBodyZone = z => BODY_ZONES.some(b => b.key === z)
export const zoneLabel = z => (SHELL_ZONES.find(s => s.key === z) || BODY_ZONES.find(b => b.key === z))?.label || z

// ---------- 两档结论 ----------
// 人第一眼真正"看出来"的是**形状异常**（重复的菜单项、突兀的"测试"字样）；
// 而"合计差 1"是**算出来的**，是第二遍的事。混成一档报出去，等于让开发替 QA 复核。
export const SCAN_TIERS = {
  CONFIRMED: '截图自证',   // 图上直接读得出，不需要再查
  SUSPECT: '待复核',       // 有嫌疑，但要查数据/接口/需求才能定性
}

// ---------- 算术验算：本模块最硬的一条证据 ----------
// findings 里声称"加起来对不上"的，必须把加数和总数交出来。机器加一遍：
//   · 加得上（sum === total）→ **打回**，是你自己算错了，别让开发白跑一趟；
//   · 加不上 → 接受，并把差值算进结论（「差 1」这种描述最有用）。
export function checkArithmetic(f = {}) {
  const parts = Array.isArray(f.parts) ? f.parts.map(Number) : []
  const total = Number(f.total)
  if (!parts.length || parts.some(n => !Number.isFinite(n))) return { ok: false, why: '`parts` 缺失或含非数字——声称数字不勾稽就必须把加数交出来' }
  if (!Number.isFinite(total)) return { ok: false, why: '`total` 缺失或非数字——要跟哪个总数比？' }
  const sum = parts.reduce((a, b) => a + b, 0)
  const diff = sum - total
  if (diff === 0) return { ok: false, why: `机器验算：${parts.join('+')} = ${sum}，与页面写的 ${total} **相等**——不勾稽这条不成立（是你算错了）`, sum, diff }
  return { ok: true, sum, diff, expr: `${parts.join('+')} = ${sum}，页面写 ${total}，${diff > 0 ? '多' : '少'} ${Math.abs(diff)}` }
}

// ---------- 跨页重复抑制：把"全站议题"从"本次缺陷"里摘出去 ----------
// 同一条现象在多张页面截图里反复出现 → 它多半是外壳/设计系统/框架的账，不是这次改动引入的。
// 沿用 C3 已定的口径（AntD 主按钮对比度 3.24:1 全站都这样，提独立议题、不打回本次改动）。
export function suppressGlobalRepeats(findings = [], { minPages = 3 } = {}) {
  const byKey = new Map()
  for (const f of findings) {
    const k = `${f.rubricKey}|${String(f.quote || '').trim().slice(0, 40)}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(f)
  }
  const local = [], global = []
  for (const group of byKey.values()) {
    const pages = new Set(group.map(f => f.page || '').filter(Boolean))
    if (pages.size >= minPages) global.push({ ...group[0], seenOnPages: [...pages], why: `同一现象在 ${pages.size} 个页面都出现——按全站议题记，不算本次改动的账` })
    else local.push(...group)
  }
  return { local, global }
}

// ---------- 主校验 ----------
// 允许的证据形态，逐条都要挂得住：
//   ① `zone` 必须是主体区（外壳区直接打回）；
//   ② `quote` 必须非空；调用方给了页面文本（DOM 文本 / OCR）就再校验它确实出现在页面上；
//   ③ `expected` 必须非空（本该是什么样）——不要 suggestion，红线 5 禁止 QA 诊断根因；
//   ④ arithmetic 类额外过验算；duplicate 类要求 occurrences ≥ 2。
export function validateScanFindings({ findings = [] } = {}, { pageText = '', pages = [] } = {}) {
  const text = String(pageText || '')
  const errors = [], accepted = [], rejected = []
  for (const raw of (Array.isArray(findings) ? findings : [])) {
    const f = { ...raw }
    const r = rubricOf(f.rubricKey)
    if (!r) { rejected.push({ ...f, reason: `rubricKey 不在巡检 rubric 里（${SCAN_RUBRIC.map(x => x.key).join('/')}）——不许自造维度` }); continue }
    if (!f.zone) { rejected.push({ ...f, reason: '没声明 `zone`（在页面哪一块）——说不清位置的发现，开发定位不了' }); continue }
    if (isShellZone(f.zone)) { rejected.push({ ...f, reason: `\`${zoneLabel(f.zone)}\` 属于**通用外壳**，不在本次判定范围（老板定：只看页面主体）。真要报，走全站议题、别挂在这个功能头上` }); continue }
    if (!isBodyZone(f.zone)) { rejected.push({ ...f, reason: `zone \`${f.zone}\` 不认识（可用：${BODY_ZONES.map(b => b.key).join('/')}）` }); continue }
    const quote = String(f.quote || '').trim()
    if (!quote) { rejected.push({ ...f, reason: '没给 `quote`（从截图里抄下来的原文）——指不出具体是哪句话/哪个数，就是读后感' }); continue }
    if (!String(f.expected || '').trim()) { rejected.push({ ...f, reason: '没给 `expected`（本该是什么样）——只说"不对"不说"该怎样"，开发无法判断是不是真 bug' }); continue }

    let tier = SCAN_TIERS.SUSPECT, note = ''
    if (f.rubricKey === 'arithmetic') {
      const a = checkArithmetic(f)
      if (!a.ok) { rejected.push({ ...f, reason: a.why }); continue }
      tier = SCAN_TIERS.CONFIRMED; note = a.expr; f.diff = a.diff; f.sum = a.sum
    } else if (f.rubricKey === 'duplicate') {
      const n = Number(f.occurrences)
      if (!Number.isFinite(n) || n < 2) { rejected.push({ ...f, reason: '`occurrences` 缺失或 < 2——说重复就得说清出现了几次' }); continue }
      tier = SCAN_TIERS.CONFIRMED; note = `「${quote}」出现 ${n} 次`
    } else if (['dirty-data', 'leak', 'broken', 'contradiction'].includes(f.rubricKey)) {
      tier = SCAN_TIERS.CONFIRMED
    }

    // 文本可验时再收一道：quote 必须真的在页面上，防"看花眼"和凭印象编原文。
    if (text) {
      if (text.includes(quote)) f.quoteVerified = true
      else { rejected.push({ ...f, reason: `\`quote\` 在页面文本里找不到：「${quote.slice(0, 30)}」——抄错了或不存在，两种都不能进结论` }); continue }
    } else f.quoteVerified = false

    accepted.push({ ...f, tier, note, severity: f.severity || r.severity, rubricLabel: r.label })
  }
  const { local, global } = suppressGlobalRepeats(accepted, { minPages: Math.max(3, Math.ceil((pages.length || 0) * 0.6)) })
  if (!accepted.length && Array.isArray(findings) && findings.length && !rejected.length) errors.push('一条都没通过校验，也没给出打回原因——内部异常')
  return { ok: !rejected.length, errors, accepted: local, global, rejected, counts: tierCounts(local) }
}
export function tierCounts(list = []) {
  const c = { [SCAN_TIERS.CONFIRMED]: 0, [SCAN_TIERS.SUSPECT]: 0 }
  for (const f of list) c[f.tier] = (c[f.tier] || 0) + 1
  return c
}

// ---------- finding 出口硬化（2026-09-10 老板定）----------
// 事故驱动：巡检**真的捞出了东西，然后东西在流程里消失了**。三笔实账（项目跟踪 v0.1.0）：
//   ① 模板列表「更新时间」列每行 `Invalid date` —— 09-08 就写进 QA 报告 §7.5「建议顺手修」，
//      09-10 又当"新候选缺陷"重报一次；两次都没建行、没派工，至今没修。
//   ② 跟单工作台页头显「未登录」（右上角却已登录）—— 收口时写「留人工定性/归晨检编排」，此后全档再无提及。
//   ③ `listBindings` 传 templateId=null 返回全量绑定 —— 被当挡路石「改断言规避」，没报没建单。
// 共同形态：**发现被写成了散文，而散文没有 owner**。「留人工定性」听起来是个处置，实际是无主状态——
// 谁都没接、谁都不欠，两天后它和"没发现"完全同形（同族：§3.104「沉默不许冒充通过」）。
//
// 对策：每条被接受的 finding 必须**当场**落一个三选一的出口，且每个出口都带可核对的落点：
//   · bug        → 建缺陷单：要 bugId（走 page_scan_to_bugs 出骨架 + 四件套）
//   · increment  → 并入在研版本迭代增量：要 entryId + owner + date（**走增量 ≠ 不派工**）
//   · not-defect → 判不是缺陷：要 reason（写明为何不算，供复盘回查）
// 收工自检（qa_report_card）按此硬判：有 open（未落出口）的 finding 就不许出报告。
export const FINDING_EXITS = {
  BUG: 'bug',
  INCREMENT: 'increment',
  NOT_DEFECT: 'not-defect',
}
export const FINDING_EXIT_LABEL = {
  [FINDING_EXITS.BUG]: '建缺陷单',
  [FINDING_EXITS.INCREMENT]: '并入迭代增量（须派工）',
  [FINDING_EXITS.NOT_DEFECT]: '判非缺陷（须写理由）',
}
// 稳定 key：同一条发现在 verdict / disposition / 报告三处必须能对上。
// 取 rubricKey + page + quote 前 40 字（与 suppressGlobalRepeats 同口径，避免两套指纹）。
export function findingKey(f = {}) {
  return `${f.rubricKey || '?'}|${String(f.page || '').trim()}|${String(f.quote || '').trim().slice(0, 40)}`
}
// 校验单条出口声明。返回 {ok, why, record}
export function validateDisposition(d = {}) {
  const key = String(d.key || '').trim()
  const exit = String(d.exit || '').trim()
  if (!key) return { ok: false, why: '缺 key（page_scan_verdict 结论里每条发现都印了 key，照抄）' }
  if (!Object.values(FINDING_EXITS).includes(exit)) return { ok: false, why: `exit 必须是三选一：${Object.values(FINDING_EXITS).join(' / ')}` }
  const rec = { key, exit, at: String(d.at || '').trim() }
  if (exit === FINDING_EXITS.BUG) {
    if (!String(d.bugId || '').trim()) return { ok: false, why: '出口=bug 必须给 bugId（如 STOCKUP-v0.1.0-BUG-002）——单号是四件套的锚：建单/登看板/进 facet_doc/RED 校准都靠它串' }
    rec.bugId = String(d.bugId).trim()
    rec.file = String(d.file || '').trim()
  } else if (exit === FINDING_EXITS.INCREMENT) {
    // 这三项是「走增量 ≠ 不派工」的可核对形态：没有 entryId 就是没登记，没有 owner 就是没人欠，
    // 没有 date 就是没有到期日 —— 三者缺一，两天后它就又是一条无主散文。
    const miss = ['entryId', 'owner', 'date'].filter(k => !String(d[k] || '').trim())
    if (miss.length) return { ok: false, why: `出口=increment 必须同时给 ${miss.join(' / ')}——「并入增量」不等于「不派工」：要在条目登记表建行(entryId)、指名 owner、给日期，否则等于把发现写成散文然后丢掉（血泪：Invalid date 两天没人接）` }
    rec.entryId = String(d.entryId).trim(); rec.owner = String(d.owner).trim(); rec.date = String(d.date).trim()
  } else {
    const reason = String(d.reason || '').trim()
    if (reason.length < 10) return { ok: false, why: '出口=not-defect 必须写 reason（≥10 字）说明为何不算缺陷——「留人工定性」「待确认」不是理由，那是无主状态' }
    rec.reason = reason
  }
  return { ok: true, why: '', record: rec }
}
// 台账：open = 已接受但没落出口的 finding；closed = 已落出口的
export function dispositionLedger({ findings = [], dispositions = {} } = {}) {
  const open = [], closed = []
  const seen = new Set()
  for (const f of findings) {
    const k = findingKey(f)
    if (seen.has(k)) continue
    seen.add(k)
    const d = dispositions[k]
    if (d) closed.push({ ...f, key: k, disposition: d })
    else open.push({ ...f, key: k })
  }
  return { open, closed, total: seen.size }
}

// ---------- 截图采样：76 步全给她看是不可能的 ----------
// 实测一份真 summary（2026-09-01 req0322-f2，vision-e2e/output/runs/…）：**76 步，每一步都有
// afterScreenshotPath**。粗暴 `slice(0, 20)` 取到的全是表单填写过程中同一个弹窗的微小变化——
// 看 20 张等于看 1 张，而真正该看的终态被截在外面。
//
// ⚠ **第一版规则被真数据当场证伪**：本来设计成「按导航步（openUrl/reload）分组、每组取终态」，
// 而真实 case 阶段 29 步里**导航类 0 个**（全是 click/fill/uploadFile）——分组规则一次都不会触发。
// 教训同 §3.107/§3.108：**规则要照着真产物写，不是照着想象中的产物写。**
//
// 改用真实可得的三个信号，按价值排序取：
//   ① `phase === 'case'` —— 被测内容；`fixtureSetup`（实测 47/76）是登录/造数/导航的准备工作，
//      它的页面状态不是这次要验收的东西。**这一条就砍掉 62%。**
//   ② 必取：**最后一步**（终态，页面信息最全）、**失败步**、**断言步**（用例自己认为该检查的时刻）。
//   ③ 余额**均匀间隔**补齐——不是取前 N 个（前 N 个都是过程态）。
// 丢掉多少**一定要说**（no silent caps）：静默截断读起来像「全看过了」。
//
// ⚠ **第二版规则也被真数据证伪了一半**（同一批真产物回放，2026-09-09）：原本 `isAssertStep` 写成
// 「actionType 以 assert 开头 **或带 expectation**」，而真产物里 **23/29 个 case 步都带 expectation**
// （多是 `expectNetworkResponse` 这类**接口断言，页面上根本看不出来**），actionType 真以 assert 开头的
// 只有 1 个。结果断言配额被瞬间吃光，采出来是 48,49,52,53,54,55,56,57,58,76 —— **中间连号 7 张高度相似、
// 59~75 一张没采**，正是要避免的东西。两处修：
//   ① `isAssertStep` 只认**页面可见**的断言（`expectText*`/`expectVisible`/`assert*`），排除纯网络断言；
//   ② 更根本的一条：**断言步配额封顶到 limit 的一半**，永远给均匀采样留出名额——
//      不管断言步判得准不准，采样都不会退化成一段连号。
const VISIBLE_ASSERT = /^(assert|expect(text|visible|element|value|count|url|title))/i
export const isAssertStep = s =>
  VISIBLE_ASSERT.test(String(s?.actionType || '')) || VISIBLE_ASSERT.test(String(s?.expectation?.type || ''))
export function sampleShots(steps = [], { limit = 10 } = {}) {
  const all = (Array.isArray(steps) ? steps : []).filter(s => s?.afterScreenshotPath)
  if (!all.length) return { shots: [], picked: 0, total: 0, dropped: 0, why: '没有任何带 afterScreenshot 的步骤', notes: [] }
  const cases = all.filter(s => String(s.phase || '') === 'case')
  const pool = cases.length ? cases : all
  const notes = []
  if (cases.length) notes.push(`只看 \`phase=case\` 的 ${cases.length} 步（另 ${all.length - cases.length} 步是 fixtureSetup 准备工作，不是本次要验收的页面）`)
  else notes.push(`这份 summary 没有 \`phase=case\` 的步骤，退回全部 ${all.length} 步采样`)

  const idx = new Set()
  const last = pool.length - 1
  idx.add(last)
  pool.forEach((s, i) => { if (String(s.status || '') && String(s.status) !== 'passed') idx.add(i) })
  // 断言步**配额封顶 limit/2**：留一半名额给均匀采样，保证采出来跨越整个流程而不是挤成一段连号。
  const asserts = pool.map((s, i) => isAssertStep(s) ? i : -1).filter(i => i >= 0)
  const assertQuota = Math.max(1, Math.floor(limit / 2))
  let taken = 0
  for (const i of asserts) { if (taken >= assertQuota || idx.size >= limit) break; if (!idx.has(i)) { idx.add(i); taken++ } }
  if (idx.size < limit && pool.length > idx.size) {
    const need = limit - idx.size
    const stride = Math.max(1, Math.floor(pool.length / (need + 1)))
    for (let i = stride; i < pool.length && idx.size < limit; i += stride) idx.add(i)
    // stride 落点可能与已选的重合，导致名额没用满；从头补齐（仍优先靠后的状态更完整，故倒着补）
    for (let i = pool.length - 2; i >= 0 && idx.size < limit; i--) idx.add(i)
  }
  const order = [...idx].sort((a, b) => a - b).slice(0, limit)
  const shots = order.map(i => pool[i].afterScreenshotPath)
  const dropped = all.length - shots.length
  if (asserts.length) notes.push(`必取断言步 ${Math.min(asserts.length, limit)} 张（用例自己认为该检查的时刻）`)
  notes.push('必取最后一步（终态，页面信息最全）；余额按均匀间隔补——**刻意不取前 N 张**，那些是表单过程态')
  return { shots, picked: shots.length, total: all.length, dropped, notes, caseSteps: cases.length }
}

// ---------- 渲染：看图前的指令 ----------
export function renderScanMaterial({ screenshots = [], pages = [], source = '', sampling = null } = {}) {
  const L = ['### 页面一眼巡检 · 素材与判据（第 1 步：你要真的把图看了）', '']
  if (source) { L.push(`素材来源：${source}`); L.push('') }
  L.push(`**待巡检截图（${screenshots.length} 张）**`)
  L.push('')
  for (const s of screenshots) L.push(`- ${s}`)
  L.push('')
  // 采样过就一定要说采了什么、丢了什么——静默截断读起来像「全看过了」。
  if (sampling && sampling.total > sampling.picked) {
    L.push(`> **采样说明**：本轮共 ${sampling.total} 张步后截图，采了 **${sampling.picked}** 张、**丢了 ${sampling.dropped}** 张。规则：${sampling.notes.join('；')}。`)
    L.push('> 要看被丢掉的那些，自己按 run 目录 `steps/` 取，或提高 `limit` 再调一次——**别把「采样过」当成「全看过」**。')
    L.push('')
  }
  L.push('**怎么看**：像第一次打开这个页面的人那样整屏扫一遍，先看形状不看细节——哪儿重复了、哪儿突兀、哪儿的字不该出现在这。扫完再回头算数字（分项 vs 总计、标题数 vs 列表条数）。')
  L.push('')
  L.push(`**只看页面主体**。以下属于通用外壳，${SHELL_ZONES.map(s => s.label).join('、')}——它们每个页面都一样，毛病不算这个功能的账，看到了也别往这张单里写。`)
  L.push('')
  L.push('**判据（逐条问自己，逐条答）**')
  for (const r of SCAN_RUBRIC) L.push(`- **${r.label}**（\`${r.key}\`）：${r.ask}`)
  L.push('')
  L.push('**提交要求（`page_scan_verdict`，缺一条就打回）**：每条 finding 带')
  L.push('① `rubricKey`（上表之内）；② `zone`（页面主体分区：' + BODY_ZONES.map(b => b.key).join('/') + '）；③ `quote`（**从截图里抄下来的原文**，一字不改）；④ `expected`（本该是什么样）。')
  L.push('- `arithmetic` 类**额外**要 `parts`（加数数组）+ `total`（页面写的总数）——**机器会真的加一遍**，加得上的直接打回（那是你算错了）。')
  L.push('- `duplicate` 类**额外**要 `occurrences`（出现几次，≥2）。')
  L.push('- 多张截图时带 `page`（页面/状态名）——同一现象在多个页面反复出现的，会自动降级成「全站议题」而不是本次缺陷。')
  L.push('')
  L.push('> **不要写 `suggestion`**：红线 5——QA 只报可观测事实，不诊断根因、不指定改法（v5.10 BUG-001「疑似重复提交」把开发带偏，是反面教材）。你给 `expected`，`怎么改` 是 GG Bond 的活。')
  L.push('> **一条都没发现是正常结论**，别为了凑数把「我觉得这里可以更好」写进来——那是 `aesthetic_verdict` 的地盘，不是巡检。')
  return L.join('\n')
}

// ---------- 渲染：结论 ----------
export function renderScanReport(val, { screenshots = 0 } = {}) {
  const L = ['### 页面一眼巡检 · 结论', '']
  const n = val.accepted.length
  if (!n && !val.rejected.length && !val.global.length) {
    L.push(`✅ 巡检 ${screenshots} 张截图，**未发现异常**。`)
    L.push('')
    L.push('> 注意口径：这只代表「一眼扫不出问题」，**不代表功能正确**——功能逻辑仍以用例断言为准。')
    return L.join('\n')
  }
  const c = val.counts
  L.push(`巡检 ${screenshots} 张截图，**${n} 条发现**（${SCAN_TIERS.CONFIRMED} ${c[SCAN_TIERS.CONFIRMED] || 0} · ${SCAN_TIERS.SUSPECT} ${c[SCAN_TIERS.SUSPECT] || 0}）`)
  L.push('')
  for (const tier of [SCAN_TIERS.CONFIRMED, SCAN_TIERS.SUSPECT]) {
    const g = val.accepted.filter(f => f.tier === tier)
    if (!g.length) continue
    L.push(`**${tier}**${tier === SCAN_TIERS.CONFIRMED ? '（图上直接读得出，可直接开单）' : '（有嫌疑，需查数据/接口/需求才能定性——**先复核再开单**）'}`)
    for (const f of g) {
      L.push(`- [${f.rubricLabel}·${f.severity}] **${zoneLabel(f.zone)}**${f.page ? `（${f.page}）` : ''}：「${f.quote}」`)
      if (f.note) L.push(`  · 机器核实：${f.note}`)
      L.push(`  · 期望：${f.expected}${f.quoteVerified ? '' : '　〔原文未经页面文本核对，凭图抄录〕'}`)
      L.push(`  · key：\`${findingKey(f)}\`　→ 落出口时照抄`)
    }
    L.push('')
  }
  if (val.global.length) {
    L.push(`**已降级为全站议题 ${val.global.length} 条**（多页面复现，不算本次改动的账；提独立议题给前端/设计）`)
    for (const f of val.global) L.push(`- [${f.rubricLabel}] 「${f.quote}」—— ${f.why}`)
    L.push('')
  }
  if (val.rejected.length) {
    L.push(`**被机器打回 ${val.rejected.length} 条（不进结论）**`)
    for (const f of val.rejected) L.push(`- ${f.reason}`)
    L.push('')
  }
  if (val.errors.length) for (const e of val.errors) L.push(`⛔ ${e}`)
  L.push('> 下一步：`page_scan_to_bugs` 把「截图自证」这档转成缺陷单骨架；「待复核」那档先自己查实，别直接甩给开发。')
  if (n) {
    L.push('>')
    L.push(`> **★ 出口硬化（收工自检会硬判）**：上面 ${n} 条，每条都要**当场** \`finding_disposition\` 落三选一——`)
    L.push('> `bug`（给 bugId）／`increment`（并入在研版本增量：给 entryId + owner + date，**走增量 ≠ 不派工**）／`not-defect`（写明为何不算）。')
    L.push('> **禁止「留人工定性」「待确认」这类无主状态**：它和「没发现」两天后完全同形（血泪：Invalid date 报了两次没人接、页头「未登录」推给"晨检编排"后失踪）。')
  }
  return L.join('\n')
}

// ---------- 转缺陷单骨架 ----------
// 只转 CONFIRMED 档：SUSPECT 没查实就开单 = 让开发替 QA 复核。
// 骨架对齐 `templates/qa-缺陷单.md`，含四件套提醒与壳号 facet 规则（REQ-9NNN-Fn）。
export function scanFindingsToBugs(accepted = [], { version = '', module = '', startSeq = 1, date = '', archive = '', runId = '', screenshots = [] } = {}) {
  const list = accepted.filter(f => f.tier === SCAN_TIERS.CONFIRMED)
  return list.map((f, i) => {
    const seq = String(startSeq + i).padStart(3, '0')
    const id = `SAMPLING-v${version}-BUG-${seq}`
    const shell = `REQ-9${seq}`
    const title = `${zoneLabel(f.zone)}${f.rubricLabel}：${String(f.quote).slice(0, 24)}`
    const body = [
      '---', 'type: bug', `version: v${version}`, `date: ${date}`, `archive: ${archive}`, '---', '',
      `# ${id} ${title}`, '',
      '> 来源：**页面一眼巡检**（`page_scan`）——非用例断言发现，属人工第一眼可见的页面异常。',
      '',
      '## 一、基本信息', '',
      '| 项 | 值 |', '|----|----|',
      `| ID / 标题 | ${id} ${title} |`,
      `| 提报人 / 日期 | 迷糊老师 / ${date} |`,
      `| 版本 / 模块 | v${version} / ${module} |`,
      `| 关联 facet ID | ${shell}-F1（壳号，需收进版本主 facet_doc） |`,
      `| 严重 / 优先 | ${f.severity} / 待定 |`,
      '| 状态 | 新建 |', '| 归属 | 待定位 |', '',
      '## 二、环境', '', `本地人工预检环境${runId ? ` · runId \`${runId}\`` : ''}`, '',
      '## 三、前置条件', '', `打开${module || '目标'}页面，进入 ${zoneLabel(f.zone)}${f.page ? `（${f.page}）` : ''}。`, '',
      '## 四、复现步骤', '', '1. 打开页面', `2. 观察 ${zoneLabel(f.zone)}`, '',
      '## 五、预期结果', '', f.expected, '',
      '## 六、实际结果', '', `${f.rubricLabel}：「${f.quote}」${f.note ? `\n\n机器核实：${f.note}` : ''}`,
      // 可选项用展开、**不要事后 filter 空串**——那会把上面刻意留的 markdown 空行一并吃掉，
      // 表格/标题前没有空行就渲染不出来（2026-09-08 端到端 dry-run 当场抓到）。
      ...(screenshots.length ? ['', `证据截图：${screenshots.slice(0, 3).map(s => `\`${s}\``).join(' / ')}`] : []),
      '',
      '## 七、影响面', '', '<!-- 待评估 -->', '',
      '## 九、修复验收标准', '',
      '| facet ID | 验收标准（给定→操作→可观测，RED→GREEN 可校准） | 层级 | 分类 |',
      '|----------|------------------------------------------------|------|------|',
      `| ${shell}-F1 | 给定<未修复版> → 打开页面观察 ${zoneLabel(f.zone)} → ${f.expected}（未修版此断言应跑 RED） | P1 | auto |`,
      '',
      '> 四件套：① 本单 + README 索引；② `set_entry_status` 建行；③ 上表 facet 收进版本主 facet_doc（请菲菲收口）；④ RED 校准。',
    ].join('\n')
    return { id, seq, shellId: shell, title, severity: f.severity, filename: `${id}-${f.rubricKey}.md`, body, finding: f }
  })
}

export function renderBugPlan(bugs = [], { suspects = 0 } = {}) {
  if (!bugs.length) return `没有「${SCAN_TIERS.CONFIRMED}」档发现，不生成缺陷单。${suspects ? `（另有 ${suspects} 条待复核——查实后再回来转单）` : ''}`
  const L = [`### 待建缺陷单 ${bugs.length} 张（由巡检「${SCAN_TIERS.CONFIRMED}」档转出）`, '']
  L.push('| 建议文件名 | 严重 | 壳号 facet | 标题 |')
  L.push('|-----------|------|-----------|------|')
  for (const b of bugs) L.push(`| \`${b.filename}\` | ${b.severity} | ${b.shellId}-F1 | ${b.title} |`)
  L.push('')
  L.push('> 骨架已按 `templates/qa-缺陷单.md` 生成（正文见下）。**逐张 Write 落盘、一个回合一张**（产出纪律：单回合多份大文件会触发连接中断整轮作废），落盘后补 README 索引 + `set_entry_status` 建行 + facet 收进主 facet_doc。')
  if (suspects) L.push(`> 另有 **${suspects} 条「${SCAN_TIERS.SUSPECT}」未转单**——那档要你先查实（查数据/接口/需求），别把复核工作甩给开发。`)
  return L.join('\n')
}
