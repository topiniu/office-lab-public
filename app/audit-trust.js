// ============================================================================
// 菲斯拉：证据可信度的机器背书（方案 §3.5 F1 / F2 / F3）
//
// 缘起（方案原文）：她是唯一盯「QA 结论成不成立」的角色，但**手上没有机器工具**，全靠读文档对抗；
// 观测窗口内多轮守航基本没参与（被中断状态挂了 13 天）。
//
// 三件事：
//   F1 假绿猎手：对每条 COVERED_GREEN 抽查六项机器判据，产出「证据可信度」章节 +
//                `guard.fake_green` 的计数来源；
//   F2 intake 误判审计：抽查「被判零歧义并跑了的」条目，事后是否发生口径反转/返工
//                （REQ-0302→0312 就是一例），产出 `eligibility_misjudge` 指标反馈给菲菲的就绪标准；
//   F3 逃逸复盘自动立案：凡「上线后 / 老板手工发现」的缺陷，自动立一条复盘条目——
//                问「哪道门本该拦住它、缺哪项能力」，指向猪猪能力编号或 lab 门禁。
//
// 纯函数。F1 复用 guard-ledger.deriveFakeGreen 的判据，但**多一条**它没有的：
//   「同 REQ 已有真绿链却停在 SOURCE_ATTESTED」——这条 coverage.js 已经在算，这里把它纳入可信度视图。
// ============================================================================

import { deriveFakeGreen } from './guard-ledger.js'

// ---------- F1 · 假绿猎手 ----------
// rows: coverage.mergeFacetRows 输出；verify: 猪猪 verify_evidence map（可为 null）；
// extra: { suspectAttestations:[facetId], envFingerprintFresh:bool|null, pageErrorRuns:[runId] }
export function fakeGreenHunt({ rows = [], verify = null, extra = {} } = {}) {
  const derived = deriveFakeGreen(rows, verify)
  const findings = derived.hits.map(h => ({ ...h, severity: 'error' }))
  // 六项抽查里 coverage.js 已算好的那条：同 REQ 有真绿、这条却停在 SOURCE_ATTESTED
  for (const fid of (extra.suspectAttestations || [])) {
    findings.push({ facetId: String(fid).toUpperCase(), code: 'attested_while_green_exists', severity: 'error', why: 'SOURCE_ATTESTED 但同 REQ 已有真绿用例（造数链已证明可跑通）——「源码坐实」在这里等于逃避真跑' })
  }
  // 环境指纹整体陈旧 → 本轮所有绿都要打问号（不是逐条，是整批）
  const batchWide = []
  if (extra.envFingerprintFresh === false) batchWide.push({ code: 'stale_env_batch', why: '本轮环境指纹陈旧（跑的是旧 bundle）——**整批绿都不可信**，不是逐条问题（Z-B；「故意改坏两次都不红」那次就是这个）' })
  else if (extra.envFingerprintFresh == null) batchWide.push({ code: 'env_unknown', why: '拿不到环境指纹（Z-B 未接通）——无法确认跑的是不是最新构建，所有绿只能记「未验证新鲜度」' })
  if ((extra.pageErrorRuns || []).length) batchWide.push({ code: 'page_error_batch', why: `${extra.pageErrorRuns.length} 个 run 期间页面在报错（Z-A）——这些 run 签发的绿全部可疑` })
  const greens = (rows || []).filter(r => String(r.status || '').toUpperCase() === 'COVERED_GREEN')
  const trusted = greens.length - findings.length - derived.unverified.length
  return {
    greenCount: greens.length,
    findings,
    unverified: derived.unverified,
    batchWide,
    verifyAvailable: derived.verifyAvailable,
    trustedCount: Math.max(0, trusted),
    // 可信度不是百分比游戏：**只要有 batchWide，可信度直接判 0**（整批不可信）
    trustScore: batchWide.some(b => b.code === 'stale_env_batch') ? 0 : (greens.length ? Math.max(0, trusted) / greens.length : null),
    fakeGreenCount: findings.length,
  }
}
export function renderTrustSection(h) {
  const L = ['### 证据可信度（F1 假绿猎手 · 机器抽查）', '']
  if (!h.greenCount) return L.concat(['_（本版没有 COVERED_GREEN 行，无可抽查）_']).join('\n')
  const pct = h.trustScore === null ? '—' : `${Math.round(h.trustScore * 100)}%`
  L.push(`COVERED_GREEN **${h.greenCount}** 条：可信 **${h.trustedCount}**、假绿 **${h.fakeGreenCount}**、未验证 **${h.unverified.length}** → 可信度 **${pct}**`)
  if (!h.verifyAvailable) L.push('')
  if (!h.verifyAvailable) L.push('> ⚠ 猪猪 `verify_evidence` 未接通，抽查只做了引擎能做的那一半（证据字段完整性 / 哈希）。**未验证 ≠ 通过。**')
  if (h.batchWide.length) { L.push(''); L.push('**整批级问题（不是逐条，影响本轮所有绿）**'); for (const b of h.batchWide) L.push(`- ${b.why}`) }
  if (h.findings.length) { L.push(''); L.push('**假绿明细**'); for (const f of h.findings.slice(0, 30)) L.push(`- ${f.facetId} —— ${f.why}`) }
  if (h.unverified.length) { L.push(''); L.push('**未验证的绿（不计假绿，但不算可信）**'); for (const f of h.unverified.slice(0, 30)) L.push(`- ${f.facetId} —— ${f.why}`) }
  return L.join('\n')
}

// ---------- F2 · intake 误判审计 ----------
// history: [{ req, judgedUnambiguousAt, reworkEvents:[{at, kind:'semantics-reversal'|'rework'|'user-reject', note}], releasedAt }]
// 产出 eligibility_misjudge 指标 + 反馈给菲菲就绪标准的具体条目。
export const MISJUDGE_KINDS = { 'semantics-reversal': '口径反转（冻结后又被推翻）', rework: '返工', 'user-reject': '上线后用户当天就说不满足' }
export function intakeMisjudge(history) {
  const rows = (history || []).filter(h => h && h.req)
  const judged = rows.filter(h => h.judgedUnambiguousAt)
  const misjudged = judged.filter(h => (h.reworkEvents || []).length > 0).map(h => ({
    req: String(h.req).toUpperCase(),
    kinds: [...new Set((h.reworkEvents || []).map(e => e.kind))],
    notes: (h.reworkEvents || []).map(e => e.note).filter(Boolean),
    // 「被判零歧义」到「口径被推翻」的间隔越短，说明 intake 标准漏得越明显
    hoursToReversal: (() => {
      const t0 = Date.parse(h.judgedUnambiguousAt || '')
      const t1 = Math.min(...(h.reworkEvents || []).map(e => Date.parse(e.at || '') || Infinity))
      return Number.isFinite(t0) && Number.isFinite(t1) ? Math.round((t1 - t0) / 3600_000) : null
    })(),
  }))
  const rate = judged.length ? misjudged.length / judged.length : null
  // 反馈给 A2 就绪标准：哪一项拷问最该加严
  const probeAdvice = []
  if (misjudged.some(m => m.kinds.includes('user-reject'))) probeAdvice.push('「范围」拷问加严：A3 窄口径声明的第二段（提出人原话可能还期待 Y）必须写实、且要在**冻结前**给老板看（REQ-0302 就是漏了这段）')
  if (misjudged.some(m => m.kinds.includes('semantics-reversal'))) probeAdvice.push('「口径」拷问加严：只有在同源语料库里**找得到已定过的口径并能注明来源**才算「零歧义」，凭措辞判断不算')
  if (misjudged.some(m => m.kinds.includes('rework'))) probeAdvice.push('「影响面」拷问加严：改动落在被 ≥2 入口复用的组件上时，必须先枚举入口（A4）再判就绪')
  return { judgedCount: judged.length, misjudged, misjudgeRate: rate, probeAdvice }
}
export function renderMisjudge(m) {
  const L = ['### intake 误判审计（F2）', '']
  if (!m.judgedCount) return L.concat(['_（本窗口没有「被判零歧义并跑了」的条目）_']).join('\n')
  L.push(`被判零歧义并跑了 **${m.judgedCount}** 条，事后发生口径反转/返工 **${m.misjudged.length}** 条 → \`eligibility_misjudge\` = **${m.misjudgeRate === null ? '—' : Math.round(m.misjudgeRate * 100) + '%'}**`)
  if (m.misjudged.length) {
    L.push('')
    L.push('| 条目 | 形态 | 判零歧义→被推翻 | 备注 |')
    L.push('|------|------|----------------|------|')
    for (const x of m.misjudged) L.push(`| ${x.req} | ${x.kinds.map(k => MISJUDGE_KINDS[k] || k).join('、')} | ${x.hoursToReversal === null ? '—' : x.hoursToReversal + ' 小时'} | ${x.notes.join('；') || '—'} |`)
  }
  if (m.probeAdvice.length) { L.push(''); L.push('**反馈给菲菲就绪标准（A2）**'); for (const a of m.probeAdvice) L.push(`- ${a}`) }
  return L.join('\n')
}

// ---------- F3 · 逃逸复盘自动立案 ----------
// 凡「上线后 / 老板手工发现」的缺陷 → 自动立案，问「哪道门本该拦住它、缺哪项能力」。
// 门 → 能力的映射就是方案「附」表的逆向：这两个月的两个逃逸就是这么定位到 Z-A / Z-J 的。
export const ESCAPE_GATE_MAP = [
  { match: /输入即崩|TypeError|白屏|页面报错|console\s*error/i, gate: '页面报错门', capability: 'Z-A', labSide: 'B4 开发自检左移 + C1 三道全局门默认开', precedent: '新建品类输入即崩：17/17 facet 全绿之后由老板贴报错发现' },
  { match: /不一致|顺序|排序|多个入口|四入口|跨入口/i, gate: '跨入口一致性', capability: 'Z-J', labSide: 'A4 一致性 facet 生成器', precedent: '部位顺序四入口三套序，老板一句话报出' },
  { match: /陈旧|旧 ?bundle|缓存|改坏.*不红|umi/i, gate: '环境新鲜度门', capability: 'Z-B', labSide: 'C1 环境指纹门', precedent: 'umi 缓存崩发陈旧 bundle，"故意改坏两次都不红"才发现' },
  { match: /导出|xlsx|excel|png|截图|附件/i, gate: '产物断言', capability: 'Z-C', labSide: 'C2 人工债四件之一', precedent: '导出 xlsx/PNG 只能人工看' },
  { match: /权限|受限账号|看不到|越权查看/i, gate: '权限矩阵 login-as', capability: 'Z-F', labSide: 'C2 人工债四件之一', precedent: '受限权限 facet 挂 HUMAN_INHERENT' },
  { match: /卡顿|慢|性能|超时|加载久/i, gate: '性能断言', capability: 'Z-G', labSide: 'C2 人工债四件之一', precedent: '「无卡顿」无量化判据' },
  { match: /难看|样式|截断|重叠|换行|对比度|挤/i, gate: '视觉基线 diff', capability: 'Z-E', labSide: 'C3 视觉验收', precedent: 'REQ-0296/0311 白天返工 5 轮' },
  { match: /没提交|未提交|只 ?commit|没 ?push|半发布|漏发/i, gate: '发布链对账', capability: '—（lab 侧）', labSide: 'E4/D1 发布对账器', precedent: '4 条 REQ 躺在未提交工作区；生产半发布' },
  { match: /存量|回填|历史数据|默认值/i, gate: '窄口径声明', capability: '—（lab 侧）', labSide: 'A3 窄口径声明', precedent: '损耗率默认值只做新增行，上线当天用户就要存量也带出' },
]
export function fileEscapeCase({ defect = '', foundBy = '', foundAt = '', req = '', version = '' } = {}) {
  const text = `${defect} ${foundBy}`
  const hits = ESCAPE_GATE_MAP.filter(g => g.match.test(text))
  const escaped = /上线后|生产|老板|手工|自己用出来|用户反馈/i.test(String(foundBy) + ' ' + String(defect))
  return {
    shouldFile: escaped,
    req: String(req).toUpperCase(), version: String(version), defect: String(defect), foundBy: String(foundBy), foundAt: String(foundAt),
    gates: hits.map(h => ({ gate: h.gate, capability: h.capability, labSide: h.labSide, precedent: h.precedent })),
    // 一条也没匹配上＝我们的门谱里没有能拦它的门，这本身是最重要的发现
    novel: escaped && hits.length === 0,
  }
}
export function renderEscapeCase(c) {
  if (!c.shouldFile) return ''
  const L = [`### 逃逸复盘立案（F3）· ${c.req || '(未标 REQ)'}${c.version ? ' @ ' + c.version : ''}`, '']
  L.push(`- 缺陷：${c.defect}`)
  L.push(`- 谁发现的：${c.foundBy}${c.foundAt ? `（${c.foundAt}）` : ''}`)
  L.push('')
  if (c.novel) {
    L.push('**⚠ 现有门谱里没有一道门能拦住它** —— 这是本次复盘最重要的结论：需要新建一道门/新提一项猪猪能力，不是加强现有的。')
  } else {
    L.push('**哪道门本该拦住它 / 缺哪项能力**')
    L.push('')
    L.push('| 本该拦住的门 | 猪猪能力 | lab 侧对应 | 同类先例 |')
    L.push('|-------------|---------|-----------|---------|')
    for (const g of c.gates) L.push(`| ${g.gate} | ${g.capability} | ${g.labSide} | ${g.precedent} |`)
  }
  return L.join('\n')
}
