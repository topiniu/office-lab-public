// ============================================================================
// QA 报告卡片（大白话）+ 版本级 QA 结果报告 + 视觉/UX 验收 + 造数租户与残留
// （方案 §3.3 C2 / C3 / C4 / C5 / C6）
//
// 缘起（方案原文的实测事实）：观测窗口内 **57 个 E2E 批次、42 个红，产品缺陷 0** —— 全是 reach 脆弱 /
// 并发改码 / 环境陈旧；**两个真缺陷都由老板手工用出来**；5 条 facet 判 HUMAN_INHERENT 挂晨检；
// 为了让 RED 被闸门认可，得给中文步骤标题**硬加 `assert`**；QA 造的品类污染全局主数据、靠手工清；
// v5.19 **没有 QA 结果报告**（她自己的角色规范里是硬要求，v5.18 有）。
//
// C4 的铁律，本模块靠机器落实：**LLM 只改写，不新增事实。**
//   → `buildFactSheet` 把机器事实固化成一份带 key 的清单；
//   → `validateRewrite` 事后校验「改写稿里有没有凭空多出来的数字/run id/facet id」，多出来就打回。
//     未覆盖项必须**照抄** reason 与建议能力，不许 LLM 自己润色成「基本覆盖」。
// ============================================================================

// ---------- C4 · 机器事实清单（LLM 的唯一素材） ----------
// 入参全部是机器给的：覆盖矩阵行 + 猪猪 report-card + 三红灯 + 未覆盖项。
export function buildFactSheet({ version = '', reqs = [], rows = [], reportCard = null, redLights = null, runIds = [], residue = null } = {}) {
  const byStatus = {}
  for (const r of rows || []) { const s = String(r.status || 'UNCOVERED').toUpperCase(); byStatus[s] = (byStatus[s] || 0) + 1 }
  const uncovered = (rows || [])
    .filter(r => String(r.status || '').toUpperCase() !== 'COVERED_GREEN')
    .map(r => ({ facetId: r.facetId, status: String(r.status || 'UNCOVERED').toUpperCase(), criterion: r.criterion || '', reason: r.reason || r.note || '' }))
  return {
    version: String(version || ''),
    reqs: (reqs || []).map(String),
    // 本版 facet 全集的 ID —— validateRewrite 用它当白名单。**必须包含 GREEN 行**：
    // 只收 uncovered 的话，如实提到自己测过的绿 facet 反而会被判成「凭空多出的事实」（踩过一次）。
    facetIds: (rows || []).map(r => String(r.facetId || '').toUpperCase()).filter(Boolean),
    facetTotal: (rows || []).length,
    byStatus,
    greenCount: byStatus.COVERED_GREEN || 0,
    uncovered,
    // 猪猪 report-card 的机器事实（缺位则空数组，**不编**）
    did: reportCard?.card?.did || [],
    checked: reportCard?.card?.checked || [],
    evidence: reportCard?.card?.evidence || [],
    risks: reportCard?.card?.risks || [],
    runIds: [...new Set([...(runIds || []), ...(reportCard?.card?.runIds || [])])].map(String),
    redLights: redLights || null,
    residue: residue || null,
    reportCardAvailable: !!reportCard?.available,
  }
}

// LLM 可用的事实 token 集合（改写稿里出现的这类 token 必须在集合内）
function factTokens(sheet) {
  const set = new Set()
  const add = s => { for (const m of String(s || '').matchAll(/REQ-\d+(?:-F\d+)?|\b\d{8,}-[0-9a-f]{6}\b|\bsess-[\w-]+\b|\b\d+\b/gi)) set.add(m[0].toUpperCase()) }
  add(sheet.version); (sheet.reqs || []).forEach(add); (sheet.runIds || []).forEach(add); (sheet.facetIds || []).forEach(add)
  ;(sheet.uncovered || []).forEach(u => { add(u.facetId); add(u.reason); add(u.criterion) })
  ;[...(sheet.did || []), ...(sheet.checked || []), ...(sheet.evidence || []), ...(sheet.risks || [])].forEach(add)
  for (const n of [sheet.facetTotal, sheet.greenCount, ...Object.values(sheet.byStatus || {})]) set.add(String(n))
  if (sheet.redLights) for (const n of Object.values(sheet.redLights)) set.add(String(n))
  if (sheet.residue) set.add(String(sheet.residue.count ?? ''))
  return set
}

// C4 的机器校验：改写稿里的 facet ID / run id / 数字必须来自事实清单。
// 只查「可核对的硬 token」——散文措辞随便改（那正是"改写成人话"要做的事），但**不许多出事实**。
export function validateRewrite(draft, sheet) {
  const allowed = factTokens(sheet)
  const violations = []
  const text = String(draft || '')
  for (const m of text.matchAll(/REQ-\d+(?:-F\d+)?/gi)) if (!allowed.has(m[0].toUpperCase())) violations.push({ token: m[0], why: 'facet/需求编号不在机器事实清单里（凭空多出的事实）' })
  for (const m of text.matchAll(/\b\d{8,}-[0-9a-f]{6}\b/g)) if (!allowed.has(m[0].toUpperCase())) violations.push({ token: m[0], why: 'run id 不在机器事实清单里' })
  // 未覆盖项必须照抄：每条 uncovered 的 facetId 都得出现在稿子里
  const missingUncovered = (sheet.uncovered || []).filter(u => !text.includes(u.facetId)).map(u => u.facetId)
  // 「未覆盖被写成通过」的典型措辞
  const whitewash = []
  if ((sheet.uncovered || []).length && /全部(?:通过|覆盖|绿)|无未覆盖|覆盖率\s*100\s*%/.test(text)) whitewash.push('稿子里写了「全部通过/无未覆盖/100%」，但机器事实里还有未覆盖项')
  return {
    ok: violations.length === 0 && missingUncovered.length === 0 && whitewash.length === 0,
    violations, missingUncovered, whitewash,
    hint: '铁律：LLM 只改写、不新增事实。未覆盖项必须逐条照抄（facet ID + reason + 建议能力），不许润色成「基本覆盖」。',
  }
}

// C4 的骨架：给 LLM 的填空模板（每段都标注「素材在哪」，避免它去别处找料）
export function reportCardSkeleton(sheet) {
  const L = []
  L.push(`# QA 报告卡片 · ${sheet.version || '(未标版本)'}`)
  L.push('')
  L.push('> 引擎生成骨架 + 机器事实；大白话叙述由 LLM 就**下面这些事实**改写而成。**只改写、不新增**。')
  L.push('')
  L.push('## 一、我做了什么（人话，第一人称）')
  L.push('')
  L.push('<★LLM 填：把下面的机器动作串成一段人能读的叙述。示范语气：「我以核价师身份新建了一个品类『内裤』，然后去录尺寸表页面确认它能被选中，并且选中后能正常生成全码尺寸表；为了确认这个检查是有效的，我故意把代码改坏了一次，检查确实变红了。」>')
  L.push('')
  if (sheet.did.length) { L.push('机器记录的动作：'); for (const d of sheet.did.slice(0, 40)) L.push(`- ${typeof d === 'string' ? d : JSON.stringify(d)}`) }
  else L.push(`_（猪猪 report-card ${sheet.reportCardAvailable ? '未返回动作明细' : '未接通（Z-K 待上线）'}——本段只能据覆盖矩阵与 run id 写，且必须**如实说明素材受限**）_`)
  L.push('')
  L.push('## 二、我检查了什么（逐条对应验收标准）')
  L.push('')
  L.push(`facet 总数 **${sheet.facetTotal}**，其中机器签发绿 **${sheet.greenCount}**；分布：${Object.entries(sheet.byStatus).map(([k, v]) => `${k}=${v}`).join('、') || '—'}`)
  if (sheet.checked.length) { L.push(''); for (const c of sheet.checked.slice(0, 60)) L.push(`- ${typeof c === 'string' ? c : JSON.stringify(c)}`) }
  L.push('')
  L.push('## 三、证据在哪')
  L.push('')
  if (sheet.runIds.length) L.push(`run id：${sheet.runIds.map(r => `\`${r}\``).join('、')}`)
  else L.push('⚠ **没有 run id** —— 无 run id 不算数（C5 硬口径）。')
  if (sheet.evidence.length) for (const e of sheet.evidence.slice(0, 40)) L.push(`- ${typeof e === 'string' ? e : JSON.stringify(e)}`)
  L.push('')
  L.push('## 四、没测到什么（★逐条照抄，不许润色）')
  L.push('')
  if (!sheet.uncovered.length) L.push('（本版所有 facet 都有机器签发的绿证据）')
  else {
    L.push('| facet | 状态 | 为什么没测到（照抄） | 需要什么能力才能测 |')
    L.push('|-------|------|-------------------|------------------|')
    for (const u of sheet.uncovered) L.push(`| ${u.facetId} | ${u.status} | ${u.reason || '★未给 reason——必须补，不许留空'} | ★ |`)
  }
  L.push('')
  L.push('## 五、风险')
  L.push('')
  if (sheet.risks.length) for (const r of sheet.risks.slice(0, 30)) L.push(`- ${typeof r === 'string' ? r : JSON.stringify(r)}`)
  else L.push('（猪猪未给风险项；如有人判风险，写在这里并标注「人判」）')
  if (sheet.residue) { L.push(''); L.push(`造数残留：${sheet.residue.count ?? '?'} 条${sheet.residue.cleaned ? '（已清）' : '（**未清**，见 C6 残留报告）'}`) }
  return L.join('\n')
}

// ---------- C5 · 版本级 QA 结果报告（恢复为硬要求，守航态也必须出） ----------
// = C4 的落盘形态 + 老功能回归段（逐条列重跑的用例 + run id + 绿否，**无 run id 不算数**）。
export function qaResultReport({ sheet, regression = [], cardBody = '' } = {}) {
  const L = []
  L.push(cardBody || reportCardSkeleton(sheet))
  L.push('')
  L.push('## 六、老功能回归（C5 硬要求：逐条列，无 run id 不算数）')
  L.push('')
  if (!regression.length) L.push('⚠ **没有回归段** —— 守航态也必须出（v5.19 就是缺这一段）。至少列本版触及模块的既有用例重跑结果。')
  else {
    L.push('| 用例 | run id | 结果 |')
    L.push('|------|--------|------|')
    for (const r of regression) L.push(`| ${r.caseId || r.case || '—'} | ${r.runId ? `\`${r.runId}\`` : '⚠ **无 run id → 不算数**'} | ${r.ok === true ? '✅ 绿' : r.ok === false ? '❌ 红' : '—'} |`)
    const noRun = regression.filter(r => !r.runId)
    if (noRun.length) { L.push(''); L.push(`> ⚠ ${noRun.length} 条回归没有 run id —— 按 C5 口径**不算数**，需重跑。`) }
  }
  return L.join('\n')
}
export function validateQaResultReport({ sheet, regression = [], visualGate = null, findingGate = null, uiVisualGate = null } = {}) {
  const errors = []
  if (!sheet?.version) errors.push('缺版本号')
  if (!(sheet?.runIds || []).length) errors.push('没有任何 run id —— QA 结果报告无 run id 不算数（C5）')
  if (!regression.length) errors.push('缺「老功能回归」段（守航态也是硬要求，v5.19 缺过一次）')
  for (const r of regression) if (!r.runId) errors.push(`回归项「${r.caseId || r.case || '?'}」没有 run id，不算数`)
  // C3.8：声明了「需人工视觉终验」却拿不出本轮视觉素材 → 那不是人工项，是没做（见 visualFinalityGate 注释）
  if (visualGate && visualGate.ok === false) errors.push(`「需人工视觉终验」声明门未过（C3.8）：${visualGate.why}`)
  // C3.9（2026-09-10）：巡检发现必须逐条有出口，无主状态一律当"没处置"（见 findingExitGate 注释）
  if (findingGate && findingGate.ok === false) errors.push(`巡检发现出口门未过（C3.9）：${findingGate.why}`)
  // C3.13（2026-10-06）：界面类 facet 判绿了，就得有本轮真跑出来的视觉素材 + 一份看过图的审美结论
  if (uiVisualGate && uiVisualGate.ok === false) errors.push(`UI 视觉验收门未过（C3.13）：${uiVisualGate.why}`)
  if (!sheet?.reportCardAvailable) errors.push('猪猪 report-card 未接通 → 报告里的「我做了什么」只能据覆盖矩阵写，必须**显式声明素材受限**，不许写成完整叙述')
  return { ok: errors.length === 0, errors }
}

// ---------- C3 · 视觉 / UX 验收 ----------
// 输入 = 猪猪的 **`visual-review.json` 素材包**（也挂在 run summary 的 `visualReview` 上）：
// 截图 + 盒模型 + 设计 token + 同族差异 + 无障碍要点 + 截断检测。
//
// ⚠ **2026-09-07 按 vision-e2e 源码重写（`runtime/perception/visual-baseline.js`）**。第一版按想象中的
// 扁平形状写（`d.truncated / d.overlap / d.contrast / d.tinyHit / d.familyDiffs`），**这些字段一个都不存在**；
// 加上我们那边还去调了一个并不存在的 `POST /visual-review`，于是这项能力从 v1.6 交付起白挂了四个月人工债。
// 真实形状：`{reviewVersion, generatedAt, note, items:[…]}`，每个 item 两种 kind：
//   · `baseline`（assertVisual）：key/slot/box/tokens/truncation/accessibility/theme/viewport/
//                                 diff{ratio,diffPixels,maxDiffRatio,bounds,sizeChanged}/baselineImagePath/actualImagePath
//   · `peers`（assertVisualPeers）：同上 + peers[{selector,found,tokens}] + differences[{token,…}]
// 注：**缺基线（`visual-no-baseline`）与主题不符（`visual-theme-mismatch`）不会进素材包**——它们在猪猪那边
// 提前返回、直接把该步判红。所以「素材包里没见到」不等于「没问题」，看步骤结论。
export const VISUAL_VERDICTS = { OK: '符合同族基线', DIFF: '与同族不一致', DEFECT: '明显缺陷' }
// 对比度阈值取 WCAG AA 正文的 4.5:1（大字 3:1 这里不细分，宁可多报一条让人看一眼）。
export const CONTRAST_FLOOR = 4.5
// 点击区**不自定阈值**：猪猪已按业界通用的 44×44 CSS px 算好 `accessibility.hitTargetOk`，直接消费它。
// （旧注释写的「一般 <32px」是我方自己编的口径，与平台不一致，已废。）
export const HARD_VISUAL_DEFECTS = [
  { key: 'truncated', label: '文本被截断 / 底部被裁', why: '「字被挤换行」「底部截断」这类必须机器拦住' },
  { key: 'contrast', label: '对比度不足', why: '无障碍要点，有量化阈值（AA 正文 4.5:1）' },
  { key: 'tinyHit', label: '点击区过小', why: '低于 44×44 CSS px（阈值由猪猪判，我们只消费 hitTargetOk）' },
]
// 「元素重叠」**刻意不做**：猪猪只给单个元素的 box，跨 item 的 box 来自不同步骤/不同页面，
// 两两求交必然误报。留一个永远为 false 的检查项冒充覆盖，比不做更坏——需要它就去猪猪提 Z-E 增强。
export const VISUAL_NOT_COVERED = [{ key: 'overlap', label: '元素重叠', why: '猪猪素材包只给单元素盒模型，跨步骤两两求交会误报 → 本项**未覆盖**，需人眼或平台增强' }]

// 单个 item → 硬缺陷列表（纯函数，便于单测）
// `class` 分两类，**因为它们的可诉性不同**（2026-09-07 真跑一遍才看清）：
//   · `layout` 截断 —— 布局被挤坏，几乎一定是本次改动或数据长度引入的，可直接开缺陷单；
//   · `a11y`   对比度 / 点击区 —— **绝对判据、与「是否本次引入」无关**。实测供应链看板的主按钮
//     contrastRatio=3.24、82×32 点击区，这是 AntD 默认主色与默认按钮高度的**全站属性**，
//     不是这条需求写坏的。照报，但必须标明「可能是设计系统基线问题」，否则每个按钮都红一遍、
//     真回归被淹掉（那就成了另一种形态的假信号）。
function itemDefects(it) {
  const out = []
  const where = String(it.selector || it.key || '?')
  if (it.truncation?.clipped) out.push({ key: 'truncated', cls: 'layout', label: '文本被横向截断', where, value: `scrollWidth ${it.truncation.scrollWidth} > clientWidth ${it.truncation.clientWidth}` })
  if (it.truncation?.clippedVertically) out.push({ key: 'truncated', cls: 'layout', label: '内容被纵向裁掉（底部截断）', where, value: `scrollHeight ${it.truncation.scrollHeight} > clientHeight ${it.truncation.clientHeight}` })
  const cr = it.accessibility?.contrastRatio
  if (typeof cr === 'number' && cr > 0 && cr < CONTRAST_FLOOR) out.push({ key: 'contrast', cls: 'a11y', label: '对比度不足', where, value: `${cr}:1 < ${CONTRAST_FLOOR}:1` })
  if (it.accessibility?.hitTargetOk === false) out.push({ key: 'tinyHit', cls: 'a11y', label: '点击区过小', where, value: `${it.box?.width ?? '?'}×${it.box?.height ?? '?'} < 44×44` })
  return out
}

// review: zhuzhuCaps.visualReviewFromSummary() 的返回（{available, items, why}），或 {available:false, why}
export function visualAcceptance(review) {
  if (!review || review.available === false || !Array.isArray(review.items) || !review.items.length) {
    return {
      verdict: null, degraded: true, defects: [], diffs: [], baselineRegressions: [], itemCount: 0,
      why: review?.why || '本轮没有视觉素材包 —— 用例里一条 `assertVisual` / `assertVisualPeers` 都没挂。结论只能记「未做视觉验收」（HUMAN_INHERENT），**不许当通过**',
    }
  }
  const items = review.items
  const rawDefects = [], diffs = [], baselineRegressions = []
  for (const it of items) {
    rawDefects.push(...itemDefects(it))
    if (it.kind === 'peers') {
      for (const row of (Array.isArray(it.differences) ? it.differences : [])) {
        diffs.push({ where: String(it.selector || '?'), token: String(row.token || ''), summary: String(row.summary || row.detail || JSON.stringify(row)) })
      }
    }
    // 基线回归：ratio 超过该条自己声明的 maxDiffRatio 才算（阈值是逐条声明的，别用全局常数）
    const d = it.diff
    if (d && typeof d.ratio === 'number' && typeof d.maxDiffRatio === 'number' && d.ratio > d.maxDiffRatio) {
      baselineRegressions.push({ where: String(it.key || it.selector || '?'), ratio: d.ratio, max: d.maxDiffRatio, bounds: d.bounds || null, actualImagePath: it.actualImagePath || '', baselineImagePath: it.baselineImagePath || '' })
    }
  }
  // 同一个元素的同一类缺陷只报一次（多条 case 断言同一个按钮时会重复采到）
  const seen = new Set(), defects = []
  for (const d of rawDefects) { const k = `${d.key}|${d.where}`; if (seen.has(k)) continue; seen.add(k); defects.push(d) }
  const layout = defects.filter(d => d.cls === 'layout'), a11y = defects.filter(d => d.cls === 'a11y')
  const base = { degraded: false, defects, layout, a11y, diffs, baselineRegressions, itemCount: items.length }
  if (defects.length) {
    const parts = []
    if (layout.length) parts.push(`布局缺陷 ${layout.length} 处（截断）`)
    if (a11y.length) parts.push(`无障碍不达标 ${a11y.length} 处（对比度/点击区）`)
    return { ...base, verdict: VISUAL_VERDICTS.DEFECT, why: `机器判定 ${parts.join(' + ')}，都是确定性判据、不需要审美` }
  }
  if (baselineRegressions.length) return { ...base, verdict: VISUAL_VERDICTS.DIFF, why: `与自己的视觉基线有 ${baselineRegressions.length} 处 diff 超阈值` }
  if (diffs.length) return { ...base, verdict: VISUAL_VERDICTS.DIFF, why: `与同族模块有 ${diffs.length} 处设计 token 差异（字号/间距/圆角/主色…）` }
  return { ...base, verdict: VISUAL_VERDICTS.OK, why: `${items.length} 处视觉断言：无截断/对比度/点击区缺陷，与基线及同族无量化差异；「好不好看」仍留老板终审` }
}
export function renderVisualAcceptance(v) {
  const L = ['### 视觉 / UX 验收（C3）', '']
  if (v.degraded) return L.concat([`${v.attached ? '⚠ **无可判素材**' : '⚠ **未做**'}：${v.why}`]).join('\n')
  L.push(`结论：**${v.verdict}** —— ${v.why}`)
  const layout = v.layout || v.defects.filter(d => d.cls !== 'a11y')
  const a11y = v.a11y || v.defects.filter(d => d.cls === 'a11y')
  if (layout.length) { L.push(''); L.push('**布局缺陷（机器拦下，不是审美问题）**'); for (const d of layout) L.push(`- ${d.label} @ \`${d.where}\`：${d.value}`) }
  if (a11y.length) {
    L.push(''); L.push('**无障碍量化事实（绝对判据，不区分是否本次引入）**')
    for (const d of a11y) L.push(`- ${d.label} @ \`${d.where}\`：${d.value}`)
    L.push('> ⚠ 这两项（对比度 / 点击区）是**与被测改动无关的绝对判据**：若同款元素全站都这样（如 AntD 默认主色按钮 3.24:1、默认按钮高 32px），那是**设计系统基线问题**，该作为独立议题提给老板/前端，**不是打回本次改动的理由**；只有本次改动把它从达标改成不达标，才算本轮缺陷。')
  }
  if (v.baselineRegressions.length) {
    L.push(''); L.push('**视觉基线回归**')
    for (const r of v.baselineRegressions.slice(0, 20)) L.push(`- \`${r.where}\`：diff ${r.ratio} > 阈值 ${r.max}${r.bounds ? `，差异集中在 x=${r.bounds.x},y=${r.bounds.y} ${r.bounds.width}×${r.bounds.height}` : ''}${r.actualImagePath ? `（实际图 ${r.actualImagePath}）` : ''}`)
  }
  if (v.diffs.length) {
    L.push(''); L.push('**与同族的量化差异（素材）**')
    for (const d of v.diffs.slice(0, 20)) L.push(`- \`${d.where}\` ${d.token}：${d.summary}`)
    L.push('> 口径：平台**只对用例 `mustMatch` 里列的 token 判红**，其余差异一律只出素材——「和隔壁不一致」有时正是设计意图（如主按钮 vs 次按钮的主色/边框色本就该不同）。要把某个 token 变成硬要求，就把它加进该 case 的 `mustMatch`，别在报告里替设计拍板。')
  }
  L.push('')
  L.push(`> 未覆盖：${VISUAL_NOT_COVERED.map(x => `${x.label}（${x.why}）`).join('；')}`)
  L.push('> 边界（方案 §6.3）：机器管「和隔壁不一致 / 明显缺陷」，**「好不好看」的终审仍是老板**。')
  return L.join('\n')
}

// ---------- C3.8 · 「需人工视觉终验」声明门（2026-09-10 老板拍板）----------
// 缘起（run 20260909123227-fc95e1）：迷糊守航 QA 收工写「7 条前端视觉/行为 facet + 抽屉视觉 + UX 增量：
// 需真实浏览器视觉终验，**真人工项**」。查下来这一轮 `visual_acceptance` / `design_conformance` /
// `aesthetic_review` / `run_app` **一次都没调**，用例里一条 `assertVisual` 都没挂；她给的两条理由也不成立：
//   ① 「App-run visual 首跑仅出红基线无 verdict」—— 首跑判 `visual-no-baseline` 录基线不算过，这是 C3 步骤 4
//      写死的**流程**（跑第二趟才有判定），不是阻断。何况唯一那次尝试（09-08 uiux-review）是 openUrl
//      `step-hard-timeout` 挂在第 0 步，**连基线都没录成**，`visual-baselines/` 里至今没有该模块任何一个槽位。
//   ② 「RMS 未注册码 gating 写 UI 不渲染」—— 那 7 条全在 REQ-0340 **对外免登录移动页**（token 鉴权），
//      同一轮她自己的用例正在成功 `issueToken`，浏览器带 `?_t=` 直连即可，跟 RMS 配码无关。
//
// 所以这道门只问一件事：**你说「只能人眼看」，那机器这条路你走到哪一步了？** 判据是本轮真跑出来的
// 视觉素材，不是一句声明。与 §3.123 页面巡检足迹同一路子：「一次都没跑」和「跑了没结论」长得完全不一样。
// 口径沿用 C2：「未验证」不算清零，「平台有但没挂」更不算。
//
// 只拦**视觉类**的人工声明。权限矩阵 / 现网回归 / 真机三方这类人工项不在本门范围（它们没有视觉素材可给），
// 判据是「人工措辞 ∧ 视觉措辞」同时命中——这也正好覆盖「RMS 未注册码 gating 写 UI 不渲染」那种
// 「借一个真实的非视觉阻断，去豁免一整批视觉 facet」的写法。
export const VISUAL_GATE = { NO_CLAIM: 'NO_CLAIM', BACKED: 'BACKED', NO_MATERIAL: 'NO_MATERIAL', NO_ATTEMPT: 'NO_ATTEMPT' }
// 视觉措辞：`\b` 在中文旁边成立（中文字符不是 \w），所以 `\bUI\b` 不会误吃 build/require 里的 ui。
const VISUAL_WORD_RE = /视觉|渲染|样式|布局|截断|配色|颜色维|截图|看图|人眼|肉眼|眼看|\bUI\b|\bUX\b|visual|render/i
const HUMAN_WORD_RE = /人工|人眼|肉眼|眼看|晨检|终验|待老板|留给老板|需老板看|manual|human/i
export function isVisualHumanClaim(row) {
  if (!row) return false
  // 只读 QA 自己写的处置说明（reason/note/evidence），**不读 criterion**：验收标准原文里出现「布局」
  // 这类词是需求在描述功能，不是她在声明「这条只能人眼看」，拿它当判据会误伤一片。
  const said = [row.reason, row.note, row.evidence].map(x => String(x || '')).join(' ')
  const status = String(row.status || '').toUpperCase()
  const human = status === 'HUMAN_INHERENT' || HUMAN_WORD_RE.test(said)
  return human && VISUAL_WORD_RE.test(said)
}
// 同一判据的「自由文本」版：收工汇报 / 【等你拍板】 里写的「这几条留晨间人工视觉终验」也是一次声明，
// 而它**不进覆盖矩阵**（她可以一条 set_facet_coverage 都不写就把活推走）——所以收工路径要单独认这一种。
// 与 isVisualHumanClaim 同口径：人工措辞 ∧ 视觉措辞，两个都命中才算。
export function textClaimsVisualHuman(text) {
  const t = String(text || '')
  if (!t.trim()) return false
  return HUMAN_WORD_RE.test(t) && VISUAL_WORD_RE.test(t)
}
function normVisualFootprint(fp) {
  const f = fp || {}
  const uniq = a => [...new Set((Array.isArray(a) ? a : []).map(String).filter(Boolean))]
  return {
    attempts: Number(f.attempts || 0),
    withMaterial: Number(f.withMaterial || 0),
    attachedNoMaterial: Number(f.attachedNoMaterial || 0),
    itemCount: Number(f.itemCount || 0),
    sessions: uniq(f.sessions),
    materialSessions: uniq(f.materialSessions),
  }
}
export function visualFinalityGate({ rows = [], footprint = null } = {}) {
  const claims = (rows || []).filter(isVisualHumanClaim)
    .map(r => ({ facetId: String(r.facetId || '?'), status: String(r.status || 'UNCOVERED').toUpperCase(), reason: String(r.reason || r.note || r.evidence || '') }))
  const fp = normVisualFootprint(footprint)
  if (!claims.length) return { ok: true, verdict: VISUAL_GATE.NO_CLAIM, claims, footprint: fp, why: '本轮没有「需人工视觉终验」这类声明 —— 本门不适用（不是通过，是不涉及）' }
  if (fp.withMaterial > 0) {
    return {
      ok: true, verdict: VISUAL_GATE.BACKED, claims, footprint: fp,
      why: `${claims.length} 条视觉人工声明，且本轮真跑出了视觉素材（${fp.withMaterial} 个 run、${fp.itemCount} 条断言素材，会话 ${fp.materialSessions.join(' / ') || '—'}）—— 机器这条路走到头了，剩下的交人眼是诚实的`,
    }
  }
  if (fp.attempts > 0) {
    return {
      ok: false, verdict: VISUAL_GATE.NO_MATERIAL, claims, footprint: fp,
      why: `${claims.length} 条声明「需人工视觉终验」，本轮**调了 ${fp.attempts} 次视觉工具但一条可判素材都没拿到**（${fp.attachedNoMaterial} 个 run 挂了断言却判 \`visual-no-baseline\`）。按 C3 步骤 4：**首跑录基线不算过，跑第二趟才有判定** —— 首跑红是流程、不是「机器够不到」，不构成人工项的理由`,
    }
  }
  return {
    ok: false, verdict: VISUAL_GATE.NO_ATTEMPT, claims, footprint: fp,
    why: `${claims.length} 条声明「需人工视觉终验」，而本轮 \`visual_acceptance\` / \`design_conformance\` / \`aesthetic_review\` **一次都没调**、也没有任何视觉素材 —— 按「未做」记，**不是「机器测不了」**`,
  }
}
export function renderVisualFinalityGate(g) {
  const badge = { [VISUAL_GATE.NO_CLAIM]: '· 不涉及', [VISUAL_GATE.BACKED]: '✅ 有素材撑着', [VISUAL_GATE.NO_MATERIAL]: '⛔ 挂了断言但没跑第二趟', [VISUAL_GATE.NO_ATTEMPT]: '⛔ 一次都没跑' }
  const L = ['### 「需人工视觉终验」声明门（C3.8）', '', `${badge[g.verdict] || g.verdict}：${g.why}`]
  if (g.claims.length) {
    L.push('')
    L.push('| facet | 状态 | 你写的理由 |')
    L.push('|-------|------|-----------|')
    for (const c of g.claims.slice(0, 40)) L.push(`| ${c.facetId} | ${c.status} | ${c.reason.slice(0, 120) || '（没写理由）'} |`)
  }
  if (!g.ok) {
    L.push('')
    L.push('> **补法（按这个顺序，不是四选一）**：① 用例挂 `assertVisual` / `assertVisualPeers`（**跑两趟**：首跑录基线、第二趟出判定）→ `visual_acceptance({sessionId})`；② 静态渲染态比不出来的行为约定走 `ux_contract_check`（**源码静态检查，压根不需要浏览器**）；③ headless 真够不到的（如权限门后的写 UI）走 `run_app` 可视化终验；④ 以上都走完仍留下的，才写进人工队列，并把**走到哪一步、卡在哪**一起写清。')
    L.push('> 判 `HUMAN_INHERENT` 前先问 C2 那一句：**这四件人工债里，有没有能替我做掉的？**')
  }
  return L.join('\n')
}

// ---------- C3.9 · 巡检发现出口门（2026-09-10 老板定）----------
// 与 C3.8 同一路子：C3.8 治「声明只能人眼看、却没跑过机器这条路」；C3.9 治**发现捞出来了、然后消失**。
// 判据只有一条：本轮被接受的每条 finding，都得落进 bug / increment / not-defect 三个出口之一
// （形态校验在 page-scan.js·validateDisposition —— increment 出口强制 entryId+owner+date，
//  因为「并入增量」在实账里恰恰是发现失踪的高发出口：说了并入，没人建行、没人认领、没有到期日）。
// 入参 ledger = page-scan.js·dispositionLedger 的产物（{open, closed, total}）。
export const FINDING_GATE = { NO_FINDING: 'NO_FINDING', ALL_DISPOSED: 'ALL_DISPOSED', OPEN: 'OPEN' }
export function findingExitGate({ ledger = null } = {}) {
  const open = (ledger && ledger.open) || [], closed = (ledger && ledger.closed) || []
  if (!open.length && !closed.length) return { ok: true, verdict: FINDING_GATE.NO_FINDING, open, closed, why: '本轮巡检零发现 —— 本门不适用（不是通过，是没有待处置项）' }
  if (!open.length) {
    const byExit = {}
    for (const c of closed) { const e = String(c.disposition?.exit || '?'); byExit[e] = (byExit[e] || 0) + 1 }
    return { ok: true, verdict: FINDING_GATE.ALL_DISPOSED, open, closed, why: `${closed.length} 条发现全部落了出口（${Object.entries(byExit).map(([k, v]) => `${k}×${v}`).join('、')}）` }
  }
  return {
    ok: false, verdict: FINDING_GATE.OPEN, open, closed,
    why: `${open.length} 条巡检发现**没有出口**（另有 ${closed.length} 条已落）——每条必须当场 \`finding_disposition\` 三选一：` +
      `建缺陷单(bug) / 并入在研版本增量(increment：须 entryId+owner+date，走增量≠不派工) / 判非缺陷(not-defect：须写理由)。` +
      `「留人工定性」「待晨检编排」不是出口，是无主状态——它和「没发现」在两天后完全同形`,
  }
}
export function renderFindingExitGate(g) {
  const badge = { [FINDING_GATE.NO_FINDING]: '· 不涉及', [FINDING_GATE.ALL_DISPOSED]: '✅ 逐条有出口', [FINDING_GATE.OPEN]: '⛔ 有发现没出口' }
  const L = ['### 巡检发现出口门（C3.9）', '', `${badge[g.verdict] || g.verdict}：${g.why}`]
  if (g.open.length) {
    L.push('')
    L.push('| 待落出口的发现 | key |')
    L.push('|----------------|-----|')
    for (const f of g.open.slice(0, 40)) L.push(`| ${f.rubricLabel || f.rubricKey}${f.page ? `（${f.page}）` : ''}：「${String(f.quote || '').slice(0, 40)}」 | \`${f.key}\` |`)
  }
  if (g.closed.length) {
    L.push('')
    L.push('| 已落出口 | 出口 | 落点 |')
    L.push('|----------|------|------|')
    for (const c of g.closed.slice(0, 40)) {
      const d = c.disposition || {}
      const where = d.exit === 'bug' ? (d.bugId || '—') : d.exit === 'increment' ? `${d.entryId} · ${d.owner} · ${d.date}` : String(d.reason || '').slice(0, 40)
      L.push(`| 「${String(c.quote || '').slice(0, 30)}」 | ${d.exit} | ${where} |`)
    }
  }
  return L.join('\n')
}

// ---------- C6 · 造数租户 + 残留报告 ----------
// 用猪猪 dataTenant 前缀造数、residueCheck 清点、baselineGuard 守住预置数据
// （「预置『上衣』被谁停用了」当时缺的就是这个）。
export const TENANT_PREFIX = 'qa-'
export function tenantPrefix(runName) {
  const slug = String(runName || 'run').toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  return `${TENANT_PREFIX}${slug}-`
}
// residue: 猪猪 residueCheck 返回 { items:[{entity,id,name}] }；baseline: baselineGuard 返回 { violations:[{entity,name,change}] }
export function residueReport({ prefix = '', residue = null, baseline = null } = {}) {
  const items = Array.isArray(residue?.items) ? residue.items : []
  const foreign = items.filter(i => prefix && !String(i.name || i.id || '').startsWith(prefix))
  const violations = Array.isArray(baseline?.violations) ? baseline.violations : []
  return {
    prefix,
    count: items.length,
    cleaned: items.length === 0,
    foreign,                            // 不带租户前缀的造数＝污染了全局主数据（v5.19 的品类污染形状）
    baselineViolations: violations,
    available: !!residue || !!baseline,
    ok: items.length === 0 && violations.length === 0,
  }
}
export function renderResidueReport(r) {
  const L = ['### 造数租户与残留（C6）', '']
  if (!r.available) return L.concat(['⚠ 猪猪 `residueCheck`/`baselineGuard` 未接通 —— 本轮**无法清点造数残留**，按「未清」记录（不许写成「已清理」）。']).join('\n')
  L.push(`- 租户前缀：\`${r.prefix || '(未用租户前缀——造数会落进全局主数据)'}\``)
  L.push(`- 残留：${r.count} 条${r.cleaned ? '（已清）' : '（**未清**）'}`)
  if (r.foreign.length) { L.push(''); L.push(`**${r.foreign.length} 条造数没有租户前缀 → 污染了全局主数据**（这正是「QA 造的品类污染全局、靠手工清」的形状）`); for (const f of r.foreign.slice(0, 20)) L.push(`- ${f.entity || '?'}：${f.name || f.id}`) }
  if (r.baselineViolations.length) { L.push(''); L.push(`**预置数据被改动 ${r.baselineViolations.length} 处**（baselineGuard 报警；「预置『上衣』被谁停用了」当时缺的就是这个）`); for (const v of r.baselineViolations.slice(0, 20)) L.push(`- ${v.entity || '?'} \`${v.name || ''}\`：${v.change || ''}`) }
  return L.join('\n')
}

// ---------- C2 · 人工债清零四件（状态表） ----------
// v5.19 的 5 条 HUMAN_INHERENT 里 4 条属于这四件。这张表让「还欠几条人工债」有数。
//
// ⚠ **2026-09-07 改为三态（此前是「端点通不通」的两态，把债算错了家）**。旧版拿一个端点探活结果当
// 「这件债能不能机器测」，于是：`loginAs`/`perfAssertion` 被硬写 `false`（从没查过），`visualReview` 指向
// 一个并不存在的端点（恒 false）。晨检包因此连报四个月「4/4 仍需人眼」，而猪猪 **v1.6 就把四件全交付了**
// ——债其实欠在我们这边：**平台给了，用例没挂，消费层没接**。把这两件事分开记，才知道该催谁。
//
// 判据分两类，**都不靠版本号猜**：
//   · `endpoint`  —— 有独立 HTTP 面（Z-F），问能力目录；
//   · `assertion` —— 是**测试文件里的断言类型**（Z-C/Z-E/Z-G），没有端点可探；诚实的机器信号是
//                    「本轮 `summary.steps[].actionType` 里有没有真挂过这些断言」。
//                    有 = 真用了（债清）；没有 = 平台有能力但**我们这轮没挂断言**（债在我方）。
//
// ⚠ **别拿 telemetry 字段的存在当判据**（2026-09-07 实测差点又踩）：`summary.performance` 与
// `summary.downloads` 是**采集器产物，无论有没有断言都会写**（实测一条没挂任何断言的 run 里
// `performance` 有完整 spread、`downloads` 是 `{count:0,files:[]}`）——拿它们判「债清了」＝换个地方再造一次假绿。
// `visualReview` 是唯一例外：`buildVisualReview(entries)` 在没有视觉断言时返回 null，天然由断言驱动。
export const DEBT_CLEARED = 'CLEARED', DEBT_UNUSED = 'AVAILABLE_UNUSED', DEBT_ABSENT = 'ABSENT', DEBT_UNKNOWN = 'UNKNOWN'
export const HUMAN_DEBT = [
  { key: 'artifact', label: '产物断言（导出 xlsx 单元格内文 / 导出 PNG 完整性）', cap: 'Z-C', kind: 'assertion', actionTypes: ['assertDownload', 'assertFileContent', 'assertArtifact'], how: '用例挂 `assertDownload` 类断言（读导出物单元格内文 / 图片完整性）' },
  { key: 'permission', label: '权限矩阵 login-as（受限账号 facet 可测）', cap: 'Z-F', kind: 'endpoint', capKey: 'authBootstrap', how: '`POST /auth-profiles/{profile}/bootstrap` 切受限账号后跑同一批 facet' },
  { key: 'performance', label: '性能断言（「无卡顿」→ long task / DOM 节点回归判据）', cap: 'Z-G', kind: 'assertion', actionTypes: ['assertPerf'], how: '用例挂 `assertPerf`（domNodes / longTaskTotalMs / interactionMaxMs，**只做同环境回归比对**）' },
  { key: 'visual', label: '视觉验收（UI/UX 有量化依据）', cap: 'Z-E', kind: 'assertion', actionTypes: ['assertVisual', 'assertVisualPeers'], summaryField: 'visualReview', how: '用例挂 `assertVisual` / `assertVisualPeers` → 素材落 `summary.visualReview`' },
]
// capMap: probeCapabilities().map；summaries: 本轮已拿到的 run summary 数组（没有就传空）
// assertionKinds: 可选，(summary)=>Set<actionType>（由 zhuzhu-capabilities.assertionKindsInSummary 注入，保持本模块无依赖）
export function humanDebtStatus({ capMap = {}, summaries = [], assertionKinds = null } = {}) {
  const list = Array.isArray(summaries) ? summaries.filter(Boolean) : []
  const kindsOf = assertionKinds || (s => new Set((Array.isArray(s?.steps) ? s.steps : []).map(x => String(x?.actionType || x?.type || '')).filter(Boolean)))
  const rows = HUMAN_DEBT.map(d => {
    if (d.kind === 'endpoint') {
      const a = capMap[d.capKey]?.available
      if (a === true) return { ...d, status: DEBT_CLEARED, why: '猪猪能力目录确认该端点在（ga）' }
      if (a === false) return { ...d, status: DEBT_ABSENT, why: capMap[d.capKey]?.why || '猪猪未提供该能力' }
      return { ...d, status: DEBT_UNKNOWN, why: capMap[d.capKey]?.why || '未探测（需要真实参数才能调）' }
    }
    const hit = list.find(s => [...kindsOf(s)].some(k => d.actionTypes.includes(k)))
      // 视觉那件额外认素材包（老产物 steps 里可能没记 actionType，但素材包在就是真跑过）
      || (d.summaryField ? list.find(s => s && s[d.summaryField] != null) : null)
    if (hit) return { ...d, status: DEBT_CLEARED, why: `本轮真挂了 ${d.actionTypes.join(' / ')} —— 断言跑过、有产物` }
    if (!list.length) return { ...d, status: DEBT_UNKNOWN, why: '本轮没有可读的 run summary，无法判断断言挂没挂（**不是「仍需人眼」，也不是「已清」**）' }
    return { ...d, status: DEBT_UNUSED, why: `平台早已交付（v1.5/v1.6），但本轮 ${list.length} 份 summary 里**一条 ${d.actionTypes.join(' / ')} 都没挂** —— 债欠在我们这边：${d.how}` }
  })
  const count = st => rows.filter(r => r.status === st).length
  return {
    rows, cleared: count(DEBT_CLEARED), unused: count(DEBT_UNUSED), absent: count(DEBT_ABSENT), unknown: count(DEBT_UNKNOWN),
    remaining: rows.length - count(DEBT_CLEARED), allCleared: count(DEBT_CLEARED) === rows.length,
  }
}
const DEBT_BADGE = {
  [DEBT_CLEARED]: '✅ 本轮真用了',
  [DEBT_UNUSED]: '⚠ 平台已给·**我们没挂**',
  [DEBT_ABSENT]: '❌ 平台缺位',
  [DEBT_UNKNOWN]: '· 未验证',
}
export function renderHumanDebt(s) {
  const L = ['### 人工债清零四件（C2）', '', '| 债项 | 依赖猪猪能力 | 状态 | 说明 |', '|------|-------------|------|------|']
  for (const r of s.rows) L.push(`| ${r.label} | ${r.cap} | ${DEBT_BADGE[r.status] || r.status} | ${r.why} |`)
  L.push('')
  L.push(`已清 **${s.cleared}/${s.rows.length}**${s.unused ? `；**${s.unused} 件是平台给了、我们没挂断言**（催的是自己，不是猪猪）` : ''}${s.absent ? `；${s.absent} 件平台缺位` : ''}${s.unknown ? `；${s.unknown} 件未验证` : ''}。`)
  if (!s.allCleared) L.push('> 方案 S3 的出口判据是「v5.19 那 5 条 HUMAN_INHERENT ≤1 条仍需人眼」。**「未验证」不算清零，「平台有但没挂」更不算。**')
  return L.join('\n')
}

// ---------- C3.13 · UI 视觉验收门（2026-10-06 老板定）----------
// 缘起：「UI 用例要带视觉检查」在工牌里写了很久，但没有一处硬拦——实账 09-15 / 09-18 两次 `visual_acceptance`
// 直接返回「未做：一条视觉断言都没挂」，报告照出；审美判定七次全是「符合、零发现」。
// 判据：本版有**界面类 facet（via=ui）判了 COVERED_GREEN**，那么本轮必须同时有：
//   ① 视觉素材 —— 至少一个会话真产出了可判素材（用例挂了 assertVisual / assertVisualPeers，且跑过第二趟）；
//   ② 一份被接受的审美结论 —— `aesthetic_verdict` 过了看图门（看够了图、八维逐条有观察）。
// 没有界面类绿行 → 本门不适用（纯接口版本不该被它拦）。
export const UI_VISUAL_GATE = { NOT_APPLICABLE: 'NOT_APPLICABLE', BACKED: 'BACKED', NO_MATERIAL: 'NO_MATERIAL', NO_VERDICT: 'NO_VERDICT' }
export function uiVisualGate({ rows = [], footprint = null } = {}) {
  const uiGreen = (rows || []).filter(r => String(r.via || '') === 'ui' && String(r.status || '').toUpperCase() === 'COVERED_GREEN').map(r => String(r.facetId || '?'))
  const fp = normVisualFootprint(footprint)
  const aesthetic = Number(footprint?.aestheticAccepted || 0)
  if (!uiGreen.length) return { ok: true, verdict: UI_VISUAL_GATE.NOT_APPLICABLE, uiGreen, footprint: fp, aesthetic, why: '本版没有界面类 facet 判绿 —— 本门不适用' }
  if (!(fp.withMaterial > 0)) {
    return { ok: false, verdict: UI_VISUAL_GATE.NO_MATERIAL, uiGreen, footprint: fp, aesthetic,
      why: `${uiGreen.length} 条界面类 facet 判了绿，但本轮**没有任何可判视觉素材**${fp.attempts ? `（调了 ${fp.attempts} 次视觉工具，素材为零——多半是用例没挂 \`assertVisual\`/\`assertVisualPeers\`，或只跑了首趟录基线）` : '（`visual_acceptance` 一次都没调）'}。界面绿了却没看过界面，等于没做视觉验收` }
  }
  if (!(aesthetic > 0)) {
    return { ok: false, verdict: UI_VISUAL_GATE.NO_VERDICT, uiGreen, footprint: fp, aesthetic,
      why: `有视觉素材（${fp.withMaterial} 个会话），但本轮没有一份被接受的审美结论——\`aesthetic_review\` 取素材、看图，再 \`aesthetic_verdict\`（过看图门：看够图、八维逐条写观察）` }
  }
  return { ok: true, verdict: UI_VISUAL_GATE.BACKED, uiGreen, footprint: fp, aesthetic,
    why: `${uiGreen.length} 条界面类绿行，本轮有 ${fp.withMaterial} 个会话的视觉素材 + ${aesthetic} 份看过图的审美结论` }
}
export function renderUiVisualGate(g) {
  const badge = { [UI_VISUAL_GATE.NOT_APPLICABLE]: '· 不涉及', [UI_VISUAL_GATE.BACKED]: '✅ 有素材有结论', [UI_VISUAL_GATE.NO_MATERIAL]: '⛔ 界面绿了但零视觉素材', [UI_VISUAL_GATE.NO_VERDICT]: '⛔ 有素材没出审美结论' }
  const L = ['### UI 视觉验收门（C3.13）', '', `${badge[g.verdict] || g.verdict}：${g.why}`]
  if (!g.ok) {
    L.push('')
    L.push(`> 涉及：${g.uiGreen.slice(0, 20).join('、')}${g.uiGreen.length > 20 ? ` …共 ${g.uiGreen.length} 条` : ''}`)
    L.push('> **补法**：界面类用例挂 `assertVisual`（`mask` 遮动态区）/ `assertVisualPeers`（拿示例项目同类元素当 peers），**跑两趟**（首趟录基线）→ `visual_acceptance({sessionId})` → `aesthetic_review` → 看图 → `aesthetic_verdict`。')
  }
  return L.join('\n')
}
