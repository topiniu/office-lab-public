// ============================================================================
// 需求分析质量闸（req_analysis_complete）—— 把剩下四条业界方法落成机器判据
//
// 缘起（2026-09-08，老板：「我需要把这几条方法都落地，确保菲菲能够最大程度分析需求内容，
// 不要遗漏任何功能点」）。此前两轮已落：③trace-to-source（`req-trace.js` 横向：材料→需求）、
// ②功能树+叶子四要素（`feature-tree.js` 纵向：需求→叶子）。本模块补剩下四条：
//
//   ① 反向提问「先问清再动」 → **七项拷问打标必须问出去**：标了【假设·待确认】/【缺口·必问】
//      却没进「待确认事项」表 = 自己把问题吞了（她标了不确定，就必须问，不许自己消化掉）。
//   ④ 多轮 refine + 自我批判      → **机器点名、她必须逐条回应**（见下方那段"为什么反着做"）。
//   ⑤ 工作流优先 / 多方法层叠     → **用户工作流与功能树双向对账**：每步必须落在树的某个节点上
//      （落不上＝用户走不通）；反过来没被任何流程用到的交互叶子要解释（多余的？还是流程漏了？）。
//   ⑥ 需求缺陷率度量             → 冻结基线 vs 当前，算「冻结后新增/删除了多少 facet」。
//      **它是度量、不是门禁**：拦它会逼人不改需求，而改需求本身没错，错的是没人知道改了多少。
//
// ★ 为什么 ④ 要反着做（本模块最重要的一条设计）：
//   业界原话是「最后专门问一轮：还漏了什么、哪条被我做浅了」。但这次事故已经证明——**让她自己
//   找自己的盲区是无效的**：308 个原型单元只登记 38 条，她当时的自评是"需求梳理完成"，直到老板
//   打开页面才发现。人（和模型）对自己的盲区天然看不见，"自我批判"写成散文要求＝又一条没人验的规定
//   （本仓 §3.106/§3.118 反复栽在这上面）。
//   所以这里把方向倒过来：**引擎从已有产物算出「可疑点」并点名，她必须逐条给归宿**——
//   已补(填 facet/节点) / 不是问题(写理由) / 已问老板(写拍板题)。留空不许交棒。
//   机器判不了"她想得深不深"，但机器能判"她有没有正面回应每一条可疑点"——**判后者就够了**，
//   因为一旦必须逐条回应，"做浅"就从"没人发现"变成"要当面解释"。
//
// 独立成 ESM 模块：纯函数，可单测（不启动 server）。
// ============================================================================

import { extractDecisions, costMissing } from './task-brief.js'   // 待确认事项解析（唯一实现，避免两处各写一套）

// ---------------------------------------------------------------------------
// 阈值（全部可调，每条都写清"为什么是这个数"——没有出处的阈值等于没有阈值）
// ---------------------------------------------------------------------------
export const THRESHOLDS = {
  // 一条 REQ 的 facet 数 / 它名下源单元数 低于此比例 → 疑似"做浅"。
  // 0.25 的出处：事故版 38 facet / 308 单元 = 0.123，而返工后 44 facet + 大量树节点仍在爬；
  // 取 0.25 是"每 4 个源单元至少凝练出 1 条验收标准"，比事故值宽一倍，仍能把那次拦下。
  facetPerUnitMin: 0.25,
  // 「本版不做」占比高于此 → 疑似批量甩包袱（不是不许砍，是砍这么多必须当面说）。
  outOfScopeRatioMax: 0.4,
  // 交互类叶子占全部叶子低于此 → 疑似把动作都登记成了展示（展示类免边界判据，是最省事的分类）。
  interactiveLeafRatioMin: 0.15,
  // 边界类 facet（空/失败/无权限等）占全部 facet 低于此 → 疑似只写了 happy path。
  boundaryFacetRatioMin: 0.15,
  // 功能树最大深度 ≤ 此值 → 没真拆（一层页面 + 一层功能 = 只是把材料标题抄了一遍）。
  shallowTreeDepthMax: 2,
  // 需求缺陷率高于此 → 在版本收尾如实报「这版需求冻结后又动了这么多」（只报不拦）。
  reqDefectRateWarn: 0.2,
}

export const DISPOSITION_PREFIXES = ['已补', '不是问题', '已问老板']

const _rc = line => { const c = line.split('|').map(x => x.trim()); c.shift(); if (c[c.length - 1] === '') c.pop(); return c }
const _isSep = line => /^[-:\s]+$/.test(line.replace(/\|/g, ''))
const _clean = s => String(s == null ? '' : s).replace(/\*\*/g, '').trim()
const _blank = s => { const t = _clean(s); return !t || /^[-—–]+$/.test(t) }
const FACET_ID_RE = /REQ-\d+-F\d+/i

// 通用表格读取：表头需同时命中 must 里的每组别名（任一命中即算该组过）
function readTable(docText, mustGroups) {
  const out = []
  if (!docText) return out
  let header = null
  for (const raw of String(docText).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) { header = null; continue }
    const cells = _rc(line)
    if (!header) {
      const flat = cells.map(c => _clean(c))
      if (mustGroups.every(g => flat.some(c => g.some(n => new RegExp(n, 'i').test(c))))) header = flat
      continue
    }
    if (_isSep(line)) continue
    // ⚠ 必须把表头**快照**进闭包：`header` 会在遇到下一个非表格行时被置 null，而 col() 是
    // 调用方稍后才执行的——直接闭包引用 header 会在解析完成后读到 null（第一版就栽在这）。
    const hdr = header
    const col = (...names) => {
      for (const n of names) { const i = hdr.findIndex(h => new RegExp('^' + n, 'i').test(_clean(h))); if (i >= 0) return _clean(cells[i]) }
      return ''
    }
    out.push({ col, cells })
  }
  return out
}

// ---------------------------------------------------------------------------
// ① 反向提问：七项拷问打标 → 必须问出去
// ---------------------------------------------------------------------------
// 判据来源：`roles/feifei.md` ① 第 3 步要求每项结论三选一打标
// （`【已知】+来源` / `【假设·待确认】` / `【缺口·必问】`），且「禁止把假设当已定规则写进业务口径」。
// 这条规矩写了很久，但从来没被数过——本函数把它变成可数：**标了不确定，就必须出现在「待确认事项」里**。
// 只在文档里真出现过这些标记时才激活（老格式文档零误报；一个标记都没有的情况由 ④ 的候选 Q8 兜底）。
export function parseInquiryMarks(facetDocText) {
  const text = String(facetDocText || '')
  const assume = [...text.matchAll(/【假设[·•・]?待确认】/g)].length
  const gap = [...text.matchAll(/【缺口[·•・]?必问】/g)].length
  const known = [...text.matchAll(/【已知】/g)].length
  // 「五、待确认事项」章节（标题里含"待确认"的那一段）——标了不确定的东西必须落到这里
  const secMatch = text.match(/\n#{2,3}[^\n]*待确认事项[^\n]*\n([\s\S]*?)(?=\n#{2,3}\s|$)/)
  const pendingSection = secMatch ? secMatch[1] : ''
  const pendingRows = (pendingSection.match(/^\s*\|/gm) || []).filter(l => !_isSep(l)).length
  return { assume, gap, known, marked: assume + gap, hasPendingSection: !!secMatch, pendingRows: Math.max(0, pendingRows - 1) }
}

// ---------------------------------------------------------------------------
// ⑤ 工作流优先：用户工作流 ↔ 功能树 双向对账
// ---------------------------------------------------------------------------
// 表头：| 角色 | 流程 | 步序 | 这一步做什么 | 落在哪个节点 |
export function extractWorkflows(docText) {
  const rows = readTable(docText, [['角色', 'role'], ['步序', '步骤', 'step'], ['落在哪个节点', '节点', 'node']])
  const out = []
  for (const r of rows) {
    const role = r.col('角色', 'role')
    const flow = r.col('流程', 'flow')
    const step = r.col('步序', '步骤', 'step')
    const what = r.col('这一步做什么', '做什么', '动作', 'what')
    const node = r.col('落在哪个节点', '节点', 'node')
    if (_blank(role) && _blank(flow) && _blank(step) && _blank(node)) continue
    if (/^<.*>$/.test(role) || /^<.*>$/.test(node)) continue      // 模板占位行不算数据
    out.push({ role, flow, step, what, node, nodeKey: _clean(node).split(/\s*[/／>»]\s*/).filter(Boolean).join(' / ') })
  }
  return out
}

export function computeWorkflowCoverage({ workflows = [], treeNodes = [] } = {}) {
  const errors = [], warnings = []
  const byKey = new Map(treeNodes.map(n => [n.key, n]))
  if (!workflows.length) {
    errors.push('缺「用户工作流」表——先画"用户在这里怎么一步步干完一件事"，再从每一步倒推需要什么功能（工作流优先，治的是"字段优先/CRUD 化"）。表头：`| 角色 | 流程 | 步序 | 这一步做什么 | 落在哪个节点 |`')
    return { errors, warnings, flows: [], stepCount: 0, usedNodes: new Set(), orphanSteps: 0 }
  }
  // 按「角色+流程」归组
  const flows = new Map()
  for (const w of workflows) {
    const k = `${w.role}｜${w.flow}`
    if (!flows.has(k)) flows.set(k, [])
    flows.get(k).push(w)
  }
  const usedNodes = new Set()
  let orphanSteps = 0
  for (const [k, steps] of flows) {
    if (steps.length < 3) errors.push(`工作流「${k}」只有 ${steps.length} 步——一条真实的用户流程不会少于 3 步（打开→做事→拿到结果）；不足 3 步说明拆的是功能不是流程`)
    for (const s of steps) {
      if (_blank(s.what)) errors.push(`工作流「${k}」第 ${s.step || '?'} 步没写"这一步做什么"`)
      if (_blank(s.node)) { orphanSteps++; errors.push(`工作流「${k}」第 ${s.step || '?'} 步没落到功能树的任何节点——**用户走到这一步就走不通了**，要么补节点、要么这一步本就不该在流程里`); continue }
      if (byKey.size && !byKey.has(s.nodeKey)) { orphanSteps++; errors.push(`工作流「${k}」第 ${s.step || '?'} 步落到的节点「${s.node}」不在功能树里（路径写错，或这个功能压根没登记）`) }
      else usedNodes.add(s.nodeKey)
    }
  }
  return { errors, warnings, flows: [...flows.keys()], stepCount: workflows.length, usedNodes, orphanSteps }
}

// ---------------------------------------------------------------------------
// ④ 自我批判：机器点名的可疑点（候选）
// ---------------------------------------------------------------------------
// 每条候选有**稳定 id**（类型+主体），她按 id 逐条回应；id 稳定才能保证"回应过的下轮不用重答"。
// 只报机器能从产物算出来的事实，不猜动机；每条都带"为什么可疑"，避免她把它当噪音。
export function generateCritiqueCandidates({ trace = null, tree = null, facets = [], workflows = null, inquiry = null } = {}) {
  const out = []
  const add = (id, title, why) => out.push({ id, title, why })
  const T = THRESHOLDS

  // Q1 一条「补充:」都没有 = 没跳出材料想过
  if (tree?.stats && tree.stats.nodes > 0 && tree.stats.supplemented === 0) {
    add('Q1', '功能树里一条 `补充:` 都没有', '每个节点都能在材料里找到出处，通常不是材料写得全，而是没跳出材料想过——材料从来不写空态/并发/权限边界这些东西。')
  }
  // Q2 某条 REQ 的 facet 数远低于其源单元数（做浅）
  if (trace?.materials?.length && facets.length) {
    const totalUnits = trace.materials.reduce((n, m) => n + (m.units || 0), 0)
    const ratio = totalUnits ? facets.length / totalUnits : 1
    if (totalUnits >= 20 && ratio < T.facetPerUnitMin) {
      add('Q2', `facet 总数 ${facets.length} 对源单元 ${totalUnits}（比 ${ratio.toFixed(2)} < ${T.facetPerUnitMin}）`,
        `平均每 ${Math.round(1 / Math.max(ratio, 0.001))} 个源单元才凝练出 1 条验收标准。事故版是 38/308=0.12——这个比例低到一定程度，通常意味着"一条 facet 概括了一屏功能"。`)
    }
  }
  // Q3 「本版不做」占比过高（批量甩包袱）
  if (trace && trace.rowCount > 0) {
    const ratio = (trace.outTotal || 0) / trace.rowCount
    if (ratio > T.outOfScopeRatioMax) {
      add('Q3', `溯源表里「本版不做」占 ${(ratio * 100).toFixed(0)}%（${trace.outTotal}/${trace.rowCount}）`,
        '砍范围本身没错，但砍掉近半必须当面说清是"老板拍过的范围"还是"我自己觉得来不及"。')
    }
  }
  // Q4 交互类叶子占比过低（动作被登记成了展示——展示类免三类边界判据，是最省事的分类）
  if (tree?.stats && tree.stats.leaves >= 8) {
    const ratio = tree.stats.interactive / tree.stats.leaves
    if (ratio < T.interactiveLeafRatioMin) {
      add('Q4', `交互类叶子只占 ${(ratio * 100).toFixed(0)}%（${tree.stats.interactive}/${tree.stats.leaves}）`,
        '展示类叶子免「空态/失败态/无权限」三类边界判据——所以把动作登记成展示是绕开判据最省事的方式。请确认这些叶子里真的没有会写数据/改状态的。')
    }
  }
  // Q5 边界类 facet 占比过低（只写了 happy path）
  if (facets.length >= 10) {
    const boundary = facets.filter(f => /空|无权限|失败|超时|异常|并发|极值|重复|越权|降级/.test(String(f.criterion || '') + String(f.id || ''))).length
    const ratio = boundary / facets.length
    if (ratio < T.boundaryFacetRatioMin) {
      add('Q5', `边界/异常类 facet 只占 ${(ratio * 100).toFixed(0)}%（${boundary}/${facets.length}）`,
        '七项拷问④要求"空/极值/无权限/失败/并发逐个成行"。占比这么低，通常是只写了主路径（happy path）。')
    }
  }
  // Q6 全是 P0（没分层）
  if (facets.length >= 10) {
    const lv = new Set(facets.map(f => _clean(f.level)).filter(Boolean))
    if (lv.size <= 1) add('Q6', `所有 facet 层级相同（${[...lv][0] || '未标'}）`, '一版需求里所有验收标准同等重要是不太可能的。没分层意味着排期时没法砍，也意味着没想过"哪些是核心、哪些可以后补"。')
  }
  // Q7 功能树太浅（只把材料标题抄了一遍）
  if (tree?.stats && tree.stats.nodes >= 6 && tree.stats.maxDepth <= T.shallowTreeDepthMax) {
    add('Q7', `功能树最深只有 ${tree.stats.maxDepth} 层`, '一层页面 + 一层功能 ≈ 把材料的标题抄了一遍，没有真正拆到"用户点得到的那一下"。')
  }
  // Q8 七项拷问一个不确定都没标（不可能全都已知）
  if (inquiry && inquiry.known > 0 && inquiry.marked === 0) {
    add('Q8', `七项拷问全部标了【已知】，没有一条【假设·待确认】或【缺口·必问】`, '一版新需求里每一项都已知、零假设零缺口，几乎不可能。更常见的情况是：拿不准的地方被顺手写成了确定口径（这正是"把假设当已定规则"那条红线要防的）。')
  }
  // Q9 工作流没用到的交互类叶子（孤立动作）
  if (workflows && tree?.tree) {
    const used = workflows.usedNodes || new Set()
    const idle = tree.tree.nodes.filter(n => n.isLeaf && ['交互', '动作', '表单'].includes(_clean(n.kind)) && !used.has(n.key))
    if (idle.length) {
      add('Q9', `有 ${idle.length} 个交互类叶子没出现在任何用户工作流里`,
        `（${idle.slice(0, 5).map(n => n.name).join('、')}${idle.length > 5 ? ' 等' : ''}）——要么是流程漏写了这一步，要么这个功能其实没人会用到。两种都得说清。`)
    }
  }
  // Q10 有材料声明了降级读法（read≠full）
  const degraded = (trace?.materials || []).filter(m => m.read && m.read !== 'full')
  if (degraded.length) {
    add('Q10', `有 ${degraded.length} 份源材料是降级读的（${degraded.map(m => m.id).join('、')}）`,
      '降级读＝这块口径不是逐段读出来的。这几份材料对应的功能，出错概率显著高于其它部分——确认一下是否值得回头补读。')
  }
  return out
}

// 模板占位识别：`<...>` 包着的格子是骨架里的示例，不是数据。
// **必须挡掉**——否则模板里那行 `| Q1 | <从…抄下来> | <你的判断> | 已补:REQ-xxxx-Fn |` 会被当成
// 对 Q1 的合格回应，闸门直接放行（"照抄模板即可过闸"是这类判据最典型的死法）。
const _placeholder = s => /<[^>]*>/.test(String(s || ''))

// 她的回应表：| 候选ID | 我的回应 | 归宿 |
export function extractCritiqueResponses(docText) {
  const rows = readTable(docText, [['候选', 'id'], ['回应', 'response', '结论']])
  const out = []
  for (const r of rows) {
    const id = _clean(r.col('候选', 'id')).toUpperCase().replace(/[^Q0-9]/g, '')
    if (!/^Q\d+$/.test(id)) continue
    const response = r.col('我的回应', '回应', 'response', '结论')
    const landing = r.col('归宿', 'landing', '处置')
    if (_placeholder(response) || _placeholder(landing)) continue     // 模板占位行：当没写
    out.push({ id, response, landing })
  }
  return out
}

export function computeCritique({ candidates = [], responses = [] } = {}) {
  const errors = [], warnings = []
  const byId = new Map(responses.map(r => [r.id, r]))
  for (const c of candidates) {
    const r = byId.get(c.id)
    if (!r) { errors.push(`自我批判：${c.id}「${c.title}」还没回应——每条机器点名的可疑点都必须给归宿：\`已补:<facet或节点>\` / \`不是问题:<理由>\` / \`已问老板:<拍板题>\``); continue }
    const landing = _clean(r.landing) || _clean(r.response)
    const hit = DISPOSITION_PREFIXES.find(p => landing.startsWith(p))
    if (!hit) { errors.push(`自我批判：${c.id} 的归宿「${landing || '(空)'}」不合格式——必须以 ${DISPOSITION_PREFIXES.map(p => `\`${p}:\``).join(' / ')} 开头`); continue }
    const body = landing.slice(hit.length).replace(/^[:：]\s*/, '')
    if (body.replace(/\s/g, '').length < 2) errors.push(`自我批判：${c.id} 的「${hit}」后面没写内容——${hit === '已补' ? '写补了哪条 facet/节点' : hit === '不是问题' ? '写为什么不是问题' : '写你问了老板什么'}`)
    if (hit === '已补' && !FACET_ID_RE.test(body) && !/\//.test(body)) warnings.push(`自我批判：${c.id} 标了「已补」但没给出可核对的落点（facet ID 或功能树节点路径）`)
  }
  const answered = candidates.filter(c => byId.has(c.id)).length
  return { errors, warnings, total: candidates.length, answered, stale: responses.filter(r => !candidates.some(c => c.id === r.id)).map(r => r.id) }
}

// ---------------------------------------------------------------------------
// ⑥ 需求缺陷率：冻结基线 vs 当前
// ---------------------------------------------------------------------------
// 定义（业界口径）：sign-off 之后被改/加/拒的需求条数 ÷ sign-off 时的条数。
// 这里用 facet ID 集合做载体（它是本仓需求的最小可追溯单元）。**只报不拦**——拦它会逼人不改需求，
// 而"需求变更"本身没错；错的是**没人知道这版改了多少**（v0.1.0 事故里，冻结 38 条、返工后 44 条
// 加 30+ 条清单项，量级从来没被算过，"这版需求梳理得怎么样"全靠老板肉眼）。
export function snapshotBaseline({ facetIds = [], treeStats = null, traceStats = null, at = '' } = {}) {
  return {
    at, facets: [...new Set(facetIds.map(s => String(s).toUpperCase()))].sort(),
    leaves: treeStats?.leaves ?? null, nodes: treeStats?.nodes ?? null,
    units: traceStats?.unitTotal ?? null,
  }
}

// 基线的落盘形态：任务档案里一段 `## 需求基线`（同覆盖矩阵的做法——引擎维护、人可读、可 grep）。
// 刻意不塞 frontmatter：facet 列表可能上百条，frontmatter 是给"一眼能读完的元数据"用的。
export const BASELINE_HEADING = '## 需求基线'
export function renderBaseline(b) {
  return `${BASELINE_HEADING}\n\n> 引擎维护（首次通过需求侧门禁进开发时自动落，不手改）。用于算**需求缺陷率**＝冻结之后又增删了多少条 facet。\n> 它不是门禁，是一把尺子：需求变更本身没错，错的是没人知道这版改了多少。\n\n- at: ${b.at || ''}\n- scale: leaves=${b.leaves ?? '-'} / nodes=${b.nodes ?? '-'} / units=${b.units ?? '-'}\n- facets(${b.facets.length}): ${b.facets.join(', ')}\n`
}
export function parseBaseline(text) {
  const m = String(text || '').match(/\n##\s*需求基线[^\n]*\n([\s\S]*?)(?=\n##\s|$)/)
  if (!m) return null
  const sec = m[1]
  const at = (sec.match(/-\s*at:\s*([^\n]*)/) || [, ''])[1].trim()
  const facetsLine = (sec.match(/-\s*facets\([^)]*\):\s*([^\n]*)/) || [, ''])[1]
  const facets = (facetsLine.match(/REQ-\d+-F\d+/gi) || []).map(s => s.toUpperCase())
  const num = k => { const v = (sec.match(new RegExp(k + '=(\\d+|-)')) || [, ''])[1]; return v && v !== '-' ? Number(v) : null }
  if (!facets.length) return null
  return { at, facets, leaves: num('leaves'), nodes: num('nodes'), units: num('units') }
}

export function computeReqDrift(baseline, { facetIds = [] } = {}) {
  if (!baseline || !Array.isArray(baseline.facets) || !baseline.facets.length) return null
  const base = new Set(baseline.facets.map(s => String(s).toUpperCase()))
  const now = new Set(facetIds.map(s => String(s).toUpperCase()))
  const added = [...now].filter(f => !base.has(f))
  const removed = [...base].filter(f => !now.has(f))
  const rate = (added.length + removed.length) / base.size
  return {
    baselineAt: baseline.at || '', baseCount: base.size, nowCount: now.size,
    added, removed, rate,
    warn: rate > THRESHOLDS.reqDefectRateWarn,
    text: `需求缺陷率 ${(rate * 100).toFixed(0)}%（冻结时 ${base.size} 条 → 现在 ${now.size} 条：新增 ${added.length}、删除 ${removed.length}）`,
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
export function computeReqQuality({
  facetDocText = '', qualityDocText = '', treeNodes = [], tree = null, trace = null, facets = [],
  baseline = null, createdOn = '', since = '2026-09-08', declared = true,
  // ★ 2026-09-09 加：任务档案正文（用来校「待确认事项每条有没有写『不拍的代价』」）。
  // 老板定：这条信息**菲菲必填、引擎校空**——「拟定口径：选填、可就地改」这种条目人看不出重不重要，
  // **人做决定靠的是后果，不是选项**；缺了代价栏，老板只能逐条追问"这条不拍会怎样"，等于没交付。
  archiveText = '',
} = {}) {
  const active = String(createdOn || '') >= since
  const errors = [], warnings = []
  const inquiry = parseInquiryMarks(facetDocText)
  const workflows = computeWorkflowCoverage({ workflows: extractWorkflows(qualityDocText), treeNodes })
  const candidates = generateCritiqueCandidates({ trace, tree, facets, workflows, inquiry })
  const critique = computeCritique({ candidates, responses: extractCritiqueResponses(qualityDocText) })
  const drift = computeReqDrift(baseline, { facetIds: facets.map(f => f.id) })

  // ① 标了不确定就必须问出去（只在真有打标时激活，老格式文档零误报）
  if (inquiry.marked > 0 && inquiry.pendingRows < 1) {
    errors.push(`七项拷问里标了 ${inquiry.marked} 处不确定（${inquiry.assume} 假设 / ${inquiry.gap} 缺口），但「待确认事项」表是空的——**标了不确定就必须问出去**，别自己消化掉（"把假设当已定规则写进业务口径"是 facet 臆断的根）`)
  } else if (inquiry.marked > inquiry.pendingRows * 2 && inquiry.marked >= 4) {
    warnings.push(`七项拷问标了 ${inquiry.marked} 处不确定，「待确认事项」却只有 ${inquiry.pendingRows} 行——核一遍是不是有几处标了却没问`)
  }
  // ① 的第二半：开着的待确认事项，每条必须写「不拍的代价」
  const openDecisions = archiveText ? extractDecisions(archiveText).filter(d => !d.closed) : []
  const noCost = costMissing(openDecisions)
  if (noCost.length) {
    errors.push(`有 ${noCost.length} 条待老板拍的事项没写「不拍的代价」（${noCost.slice(0, 8).map(d => d.id).join('、')}${noCost.length > 8 ? '…' : ''}）——每条都要写清「老板不拍会怎样」：阻塞谁、拖多久、按默认做了之后若要改需返工哪几块。**人做决定靠的是后果，不是选项。**`)
  }
  errors.push(...workflows.errors, ...critique.errors)
  warnings.push(...workflows.warnings, ...critique.warnings)
  if (drift?.warn) warnings.push(`${drift.text}——冻结后又动了这么多，值得在版本收尾里说清是"老板加需求"还是"我当初漏了"`)
  for (const id of critique.stale) warnings.push(`自我批判回应表里 ${id} 已不在当前候选清单里（产物改过之后这条不再可疑）——可以删掉这行`)

  return {
    active, hard: active, complete: errors.length === 0,
    errors, warnings, inquiry, workflows, candidates, critique, drift,
    stats: { flows: workflows.flows.length, steps: workflows.stepCount, candidates: candidates.length, answered: critique.answered },
  }
}

export function renderReqQuality(res) {
  if (!res) return ''
  const L = ['### 需求分析自检（①反向提问 / ④自我批判 / ⑤工作流优先 / ⑥缺陷率）', '']
  L.push(`- **工作流**：${res.stats.flows} 条流程 / ${res.stats.steps} 步${res.workflows.orphanSteps ? `　⚠ ${res.workflows.orphanSteps} 步落不到功能树上` : '　（每步都落在功能树上）'}`)
  L.push(`- **七项拷问**：【已知】${res.inquiry.known} / 【假设·待确认】${res.inquiry.assume} / 【缺口·必问】${res.inquiry.gap}　→ 待确认事项 ${res.inquiry.pendingRows} 行`)
  L.push(`- **自我批判**：机器点名 ${res.stats.candidates} 条，已回应 ${res.stats.answered} 条`)
  if (res.drift) L.push(`- **${res.drift.text}**`)
  if (res.candidates.length) {
    L.push('', '**机器点名的可疑点（每条都要在回应表里给归宿）**', '', '| 候选ID | 可疑点 | 为什么可疑 |', '|--------|-------|-----------|')
    for (const c of res.candidates) L.push(`| ${c.id} | ${c.title} | ${c.why} |`)
  }
  L.push('', res.complete ? '✅ 需求分析自检通过' : '⛔ 未通过，不许进开发')
  return L.join('\n')
}
