// ============================================================================
// 门禁矩阵（方案 §1 E6）+ 高风险自动降级（§3.2 B6）
//
// 缘起（方案原文，全是 v5.19 实际发生的）：三方会审 v5.19/v5.20 **整版豁免**、人工预检门撤掉，
// 却又临时手写一张预检单——**哪道门该留全靠当场决定**。REQ-0239 明明是 high（大范围重构 + 触碰
// 已上线主数据 + 10,635 行回填），却整条留在守航里做，代价是 4 天长尾 + 2 个逃逸缺陷。
//
// 本模块把「哪道门该留」从临场判断变成一张表：`risk_class` 决定门，不由当晚的心情决定。
//   low    → 全自动到 RC_READY
//   medium → 加「视觉验收 + 跨入口一致性 facet」为必需
//   high   → 守航只做调查 + 方案 + facet 起草，实施必须共驾（B6 自动降级）
//
// 同时提供 `classifyRisk`：从机器信号自动**升级**风险等级。人填的 risk_class 只能作为下限——
// 因为 REQ-0239 事发时表里填的就不是 high。**机器算出来更高就按更高的算**，这是本模块的核心。
// ============================================================================

export const RISK_CLASSES = ['low', 'medium', 'high']
export const normalizeRisk = v => {
  const s = String(v || '').trim().toLowerCase()
  return RISK_CLASSES.includes(s) ? s : ''
}
const rank = r => Math.max(0, RISK_CLASSES.indexOf(normalizeRisk(r) || 'low'))
export const maxRisk = (...rs) => RISK_CLASSES[Math.max(...rs.map(rank))]

// ---------- 门禁矩阵 ----------
// requiredFacetKinds：这一级**必须存在**的 facet 种类（缺了不许进 RC_READY）。
// guardedScope：守航态允许做到哪一步。'full'=整链；'dev_full'=整链做完（开发分支 + 测试环境），但**上线时不可逆的那几步**
//   （线上执行 DDL / 迁移线上数据 / 配权限）只写成上线步骤、不执行——那些本来就在守航 forbidden 里，留给人上线时按下。
// ⚠ 2026-09-30 改（老板：「为什么菲菲把最重要的需求给跳过了……只做简单的那我签约守航干什么！」）：原先 high = 'design_only'
//   （只调查+方案+facet，实施 park 到共驾），于是 v6.0.0 最重要的 REQ-0350 / 0390 / 0389 写完需求就被置「阻塞」、一行代码没写。
//   那条规矩与 v0.11.0 的「三种不确定」自相矛盾：在开发分支上写代码、在测试环境验证，**随时能改能丢，是可以反悔的**；
//   反悔代价大的只有上线那几步，而它们本来就不许守航做。所以风险高照样做完，只把上线那一步留给人。
export const GATE_MATRIX = {
  low: {
    guardedScope: 'full',
    autoToRcReady: true,
    requiredFacetKinds: [],
    requiredGates: ['page-error', 'env-fresh', 'discrimination'],   // C1 三道全局门：任何等级都默认开
    why: 'low：复用已交付基线、口径无歧义、不碰主数据 → 全自动到 RC_READY',
  },
  medium: {
    guardedScope: 'full',
    autoToRcReady: true,
    requiredFacetKinds: ['visual', 'cross-entry'],
    requiredGates: ['page-error', 'env-fresh', 'discrimination', 'visual-baseline'],
    why: 'medium：改动落在被复用的组件/有可见 UI 变化 → 「视觉验收 + 跨入口一致性」facet 必需（部位排序那个逃逸缺陷的解药）',
  },
  high: {
    guardedScope: 'dev_full',
    autoToRcReady: true,
    requiredFacetKinds: ['visual', 'cross-entry', 'data-migration'],
    requiredGates: ['page-error', 'env-fresh', 'discrimination', 'visual-baseline', 'ddl-precheck'],
    why: 'high：大范围重构 / 触碰已上线主数据 / 生产 DDL / 权限变化 → 守航照样在开发分支上做完、测试环境验证；数据迁移与存量回填必须有可重复执行的脚本 + 影响行数预估 + 回滚方案，线上执行 DDL / 迁移 / 配权限写成上线步骤、留给人按下',
  },
}
export const gatesFor = riskClass => GATE_MATRIX[normalizeRisk(riskClass) || 'low']

// ---------- 从机器信号自动定级 ----------
// signals（全部可选，缺的当没有；每一条都能指回方案「附」表里的一件真事）：
//   changedFiles:[]        改了哪些文件（git diff --name-only）
//   changedLines:number    净改动行数
//   backfillRows:number    存量回填影响行数（B5 的 SELECT count(*) 预估）
//   ddl:boolean            本次含 DDL
//   productionData:boolean 触碰已上线主数据（品类/权限码/枚举等全局主数据）
//   permissionChange:boolean 权限模型变化
//   reusedComponents:number  改动落在被 ≥2 入口复用的组件上的个数（来自 Z-P / 本地 UI 契约）
//   externalSideEffects:boolean 路径上有不可逆外部副作用（真实企微/真机/三方，测试路径也算）
export const HIGH_LINES = 800            // 净改动行数阈值：>800 视为「大范围重构」
export const HIGH_BACKFILL_ROWS = 1000   // 存量回填行数阈值（REQ-0239 是 10,635 行）
export const HIGH_FILES = 40

export function classifyRisk(signals = {}, declared = '') {
  const reasons = []
  let level = normalizeRisk(declared) || 'low'
  const bump = (to, why) => { if (rank(to) > rank(level)) level = to; reasons.push({ to, why }) }
  const files = Array.isArray(signals.changedFiles) ? signals.changedFiles : []
  if (signals.ddl) bump('high', '本次含 DDL（生产 DDL 属 high；执行通道兼容/影响行数必须前置核查，见 B5）')
  if (signals.permissionChange) bump('high', '权限模型变化（契约 forbidden.permission_model_change）')
  if (signals.productionData) bump('high', '触碰已上线主数据（改错会污染全局，且回滚不等于恢复）')
  if (Number(signals.backfillRows) > HIGH_BACKFILL_ROWS) bump('high', `存量回填 ${signals.backfillRows} 行 > ${HIGH_BACKFILL_ROWS}（REQ-0239 是 10,635 行）`)
  if (Number(signals.changedLines) > HIGH_LINES) bump('high', `净改动 ${signals.changedLines} 行 > ${HIGH_LINES}（大范围重构）`)
  if (files.length > HIGH_FILES) bump('high', `改动文件 ${files.length} 个 > ${HIGH_FILES}（大范围重构）`)
  if (signals.externalSideEffects) bump('high', '路径上有不可逆外部副作用（真实企微/真机/三方；**测试路径也算**，方案 §6.4）')
  if (Number(signals.reusedComponents) > 0) bump('medium', `改动落在 ${signals.reusedComponents} 个被 ≥2 入口复用的组件上 → 需跨入口一致性 facet`)
  if (files.some(f => /\.(?:tsx|jsx|vue|less|css|scss)$/i.test(String(f)))) bump('medium', '含前端可见改动 → 需视觉验收 facet')
  const declaredLevel = normalizeRisk(declared)
  const escalated = !!declaredLevel && rank(level) > rank(declaredLevel)
  return {
    riskClass: level,
    declared: declaredLevel || null,
    escalated,
    reasons,
    // 方案的关键教训：填表的人低估过（REQ-0239）。机器算高就按机器的算，且要**显式说出来**。
    note: escalated ? `⚠ 机器定级 ${level} 高于人填的 ${declaredLevel}——按 ${level} 走门禁（填表低估过一次，代价是 4 天长尾）` : '',
  }
}

// ---------- B6：高风险自动降级 ----------
// 守航态 + high → 只许调查/方案/facet 起草，实施 park 到共驾，并在收工汇报里写清「为什么不夜里做」。
export function guardedScopeDecision({ riskClass, executionMode, signals = {}, declared = '' } = {}) {
  const cls = classifyRisk(signals, declared || riskClass)
  const gate = gatesFor(cls.riskClass)
  const guarded = executionMode === 'guarded_run'
  const downgrade = guarded && gate.guardedScope === 'design_only'   // 现在没有哪一级是 design_only；保留判断以兼容自定义矩阵
  const highDev = guarded && gate.guardedScope === 'dev_full'
  return {
    ...cls,
    gate,
    downgrade,
    highDev,
    allowImplementation: !downgrade,
    parkReason: downgrade
      ? `risk_class=${cls.riskClass} 在守航态自动降级为「只做调查 + 方案 + facet 起草」：${cls.reasons.map(r => r.why).join('；')}。实施 park 到共驾（白天有人能拍板/能看 UI/能停手），不夜里做。`
      : '',
    // 注入 prompt 的一段话（给员工看的、可执行的）
    preamble: downgrade
      ? `【门禁矩阵 · 本条自动降级】引擎按 risk_class=**${cls.riskClass}** 判定：本条目在守航态**只做调查 + 技术方案 + facet 起草**，**不许写实现代码、不许改 DDL、不许动主数据**。做完把该条目置「已跳过」park 到共驾，并在收工汇报里明确写「为什么不夜里做」（照抄：${cls.reasons.map(r => r.why).join('；')}）。其余 low/medium 条目照跑，不连坐。`
      : highDev
      ? `【门禁矩阵 · 高风险照样做完】引擎按 risk_class=**${cls.riskClass}** 定级（${cls.reasons.map(r => r.why).join('；')}）。**守航照样实施到底**：在开发分支上写完、测试环境验证、验收卡填满——在开发分支上改代码是可以反悔的。只有**上线时不可逆的那几步**（线上执行 DDL / 迁移线上数据 / 配权限）**写成上线步骤、不执行**：DDL 与迁移脚本要可重复执行、先跑 \`ddl_precheck\`、给出影响行数与回滚方案，写进 RELEASE_CHECKLIST。**「要不要今晚做」不是问题**——老板签契约就是要做。真有「具体怎么做会不可逆」的抉择（如迁移范围怎么圈），\`raise_risk\` 登记后**按你推荐的那条先做下去**，老板在验收卡上改选再返工。必需 facet：${gate.requiredFacetKinds.join(' / ')}。`
      : `【门禁矩阵】本条 risk_class=**${cls.riskClass}**${cls.escalated ? `（人填 ${cls.declared}，机器升级为 ${cls.riskClass}）` : ''}：${gate.why}。必需 facet 种类：${gate.requiredFacetKinds.length ? gate.requiredFacetKinds.join(' / ') : '（无额外要求）'}；必开机器门：${gate.requiredGates.join(' / ')}。`,
  }
}

// ---------- 出口判据：这一级的门都满足了吗（进 RC_READY 前算一次） ----------
// facetKinds：本版 facet 表实际出现的种类集合（菲菲的 facet 表「分类」列 + A4 自动生成的横向 facet）
// gateResults：{ 'page-error': true|false|null, ... }（null=门开不了/未验证，按未通过算）
export function rcReadyGate({ riskClass, facetKinds = [], gateResults = {} } = {}) {
  const gate = gatesFor(riskClass)
  const have = new Set((facetKinds || []).map(s => String(s).toLowerCase()))
  const missingFacets = gate.requiredFacetKinds.filter(k => !have.has(k))
  const missingGates = gate.requiredGates.filter(g => gateResults[g] !== true)
  const blocked = []
  if (!gate.autoToRcReady) blocked.push(`risk_class=${normalizeRisk(riskClass) || 'low'} 不允许守航自动到 RC_READY（必须共驾实施）`)
  for (const k of missingFacets) blocked.push(`缺 ${k} 类 facet（${normalizeRisk(riskClass)} 级必需）`)
  for (const g of missingGates) blocked.push(`机器门 ${g} ${gateResults[g] === null || gateResults[g] === undefined ? '未验证（接口缺位/没跑）' : '未通过'}——未验证不等于通过`)
  return { passed: blocked.length === 0, blocked, gate, missingFacets, missingGates }
}

// 渲染成晨检包/看板的一段（把「哪道门为什么留着」写清楚，别再靠当场解释）
export function renderGateMatrix(decisions) {
  const L = ['### 门禁矩阵（按 risk_class，不按临场判断）', '', '| 条目 | 人填 | 机器定级 | 守航范围 | 必需 facet | 结论 |', '|------|------|---------|---------|-----------|------|']
  for (const d of decisions || []) {
    L.push(`| ${d.item || '—'} | ${d.declared || '—'} | **${d.riskClass}**${d.escalated ? ' ⬆' : ''} | ${d.gate.guardedScope === 'full' ? '整链' : d.gate.guardedScope === 'dev_full' ? '整链做完·上线步骤留人' : '只调查+方案+facet'} | ${d.gate.requiredFacetKinds.join('/') || '—'} | ${d.downgrade ? '⛔ 降级共驾' : '✅ 可守航整链'} |`)
  }
  const esc = (decisions || []).filter(d => d.escalated)
  if (esc.length) { L.push(''); L.push('**机器升级了这些条目的风险等级**（人填的只作下限）'); for (const d of esc) L.push(`- ${d.item || '—'}：${d.declared} → ${d.riskClass}　${d.reasons.map(r => r.why).join('；')}`) }
  return L.join('\n')
}
