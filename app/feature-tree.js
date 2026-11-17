// ============================================================================
// 功能树闸（feature_tree_complete）—— 纵向那半个分母
//
// 缘起（2026-09-08，老板问「现在菲菲梳理需求，会生成齐全的功能树状图吗」→ 答：不会，一处都没有）：
// 同日刚落的溯源闸（`req-trace.js`）堵住的是**横向**那半——「源材料每个可枚举单元都有处置」，
// 它的分母来自**材料**。于是材料里没有的东西，它一条都发现不了：
//   · 老板口头需求 / 只有截图 / PRD 本身写得浅 → units=null 或 none → 闸门直接放行、零约束；
//   · 材料写了「点进详情页」但没写详情页的空态/无权限/失败态 → 那是 **1 个源单元，映射 1 行就算齐**。
// 本模块补的是**纵向**那半（业界方法②「功能树穷尽拆解 + 每个叶子标四要素」，老板拍板要全 6 条）：
// 逐层拆到叶子，每个叶子标目标用户 / 使用场景 / 边界 / 异常。
//
// ★ 与溯源闸**互为分母**（这是本模块存在的真正理由，不是"多一份文档"）：
//   · 溯源表：材料 → 需求（防漏读材料）
//   · 功能树：需求 → 叶子，且**每个节点必须回指一个源单元、或显式标「材料未覆盖·我补的」**
//     → 于是「材料本身写得浅」第一次**可见、可数**（`supplemented` 计数）。
//
// ★ 为什么树用「节点路径表」而不是缩进列表 / 手画的 ASCII 图：
//   · 表和 facet 表/溯源表同款形态，解析器同款（表头嗅探），菲菲手写不易跑偏；
//   · 路径列可机算深度、可机判叶子（没有以它为前缀的更深路径＝叶子）——**"是不是叶子"不由她声明**，
//     声明式的东西一定会被腐蚀（同 `qa-report-card` 的 tier「由机器判、不由 QA 自己声明」）；
//   · **ASCII 树状图由 `renderFeatureTree` 从表生成、不许手画**：手画的图与 facet 必然漂移，
//     而漂移的图比没有图更坏（人会信它）。
//
// ★ 三条硬判据（机器能算的只有结构性下限——"树齐不齐"没有外部分母，机器判不了，别装作能判）：
//   R1 叶子必须挂 ≥1 个**真实存在**的 facet（不在 facet 全集里的号一律拦）——没 facet 的叶子只是标题。
//   R2 **交互类**叶子（交互/动作/表单）的 空态 / 失败态 / 无权限 三类边界，每类要么给 facet ID、
//      要么显式 `N/A:<理由>` —— 这是把七项拷问④「边界与异常逐个」从散文变成**可数**。
//   R3 每个节点必须有源单元回指（`<材料id>#<单元>`）或显式 `补充:<理由>`。
// 另有结构完整性：路径不许有孤儿（父节点必须在表里）、不许重复；类型必填且合枚举；
// 叶子的「目标用户/使用场景」可**向上继承**（写一次在区域上即可，不必每叶重复——humane 且是常规做法）。
//
// 独立成 ESM 模块：纯函数，可单测（不启动 server）。
// ============================================================================

export const NODE_KINDS = ['页面', '区域', '展示', '交互', '动作', '表单', '数据']
// 交互类＝会产生副作用/需要用户操作的叶子。只有这类才强制三类边界（展示类强制反而制造噪音）。
export const INTERACTIVE_KINDS = new Set(['交互', '动作', '表单'])
export const BOUNDARY_COLS = [
  { key: 'empty', label: '空态', names: ['空态', '空', 'empty'] },
  { key: 'failure', label: '失败态', names: ['失败态', '失败', '异常', 'failure'] },
  { key: 'forbidden', label: '无权限', names: ['无权限', '权限', 'forbidden'] },
]

const FACET_ID_RE = /REQ-\d+-F\d+/i
const PATH_SEP_RE = /\s*[/／>»]\s*/            // 「A / B / C」「A > B」都认（她手写会混用）

export const TREE_HINT =
  '功能树要一份《功能树与叶子四要素》（任务档案 frontmatter.feature_tree_doc，模板 templates/pm-功能树.md）：\n' +
  '  表头含「节点路径」「类型」两列；一个节点一行，路径用 ` / ` 分隔（如 `跟单工作台 / 工厂聚合区 / 计数卡片`）。\n' +
  '  · 叶子（没有更深路径以它为前缀的节点）必须挂 ≥1 个真实 facet；\n' +
  '  · 类型 ∈ ' + NODE_KINDS.join('/') + '；**交互/动作/表单**类叶子的「空态」「失败态」「无权限」三列，\n' +
  '    每列要么填 facet ID、要么写 `N/A:<理由>`（这是把"边界与异常逐个"从散文变成可数）；\n' +
  '  · 每个节点的「源单元」列必须回指清点单里的单元（`<材料id>#<单元>`），材料里没写、你按行业经验补的\n' +
  '    写 `补充:<理由>` —— 这一列让「材料本身写得浅」第一次可见，是溯源闸够不到的那一半；\n' +
  '  · 「目标用户」「使用场景」可向上继承（写在区域节点上即可，叶子不必重复）。\n' +
  '  自检 `validate_feature_tree`（它顺带把 ASCII 树状图打出来——**图由引擎生成，别手画**）。'

const _rc = line => { const c = line.split('|').map(x => x.trim()); c.shift(); if (c[c.length - 1] === '') c.pop(); return c }
const _isSep = line => /^[-:\s]+$/.test(line.replace(/\|/g, ''))
const _clean = s => String(s == null ? '' : s).replace(/\*\*/g, '').trim()
const _blank = s => { const t = _clean(s); return !t || /^[-—–]+$/.test(t) }

// ---------------------------------------------------------------------------
// 解析：feature_tree_doc 里表头含「节点路径」+「类型」的那张表
// ---------------------------------------------------------------------------
export function extractTreeRows(docText) {
  const out = []
  if (!docText) return out
  let header = null
  for (const raw of String(docText).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) { header = null; continue }
    const cells = _rc(line)
    if (!header) {
      const flat = cells.map(c => _clean(c))
      if (flat.some(c => /节点路径|路径|node.?path/i.test(c)) && flat.some(c => /类型|kind|type/i.test(c))) header = flat
      continue
    }
    if (_isSep(line)) continue
    const col = (...names) => {
      for (const n of names) { const i = header.findIndex(h => h.toLowerCase().startsWith(String(n).toLowerCase())); if (i >= 0) return _clean(cells[i]) }
      return ''
    }
    const pathRaw = col('节点路径', '路径', 'node')
    if (_blank(pathRaw)) continue
    // 模板占位行（`<一级：页面/模块>` 这种）不当数据：它会被拆成一堆 `<一级：页面` / `模块>` 的野节点，
    // 报出一串看不懂的 error，把真正的缺口淹掉。骨架照抄不该"看起来像填过了"。
    if (/<[^>]*>/.test(pathRaw)) continue
    const parts = pathRaw.split(PATH_SEP_RE).map(s => _clean(s)).filter(Boolean)
    if (!parts.length) continue
    const b = {}
    for (const bc of BOUNDARY_COLS) b[bc.key] = col(...bc.names)
    out.push({
      pathRaw, parts, key: parts.join(' / '), name: parts[parts.length - 1], depth: parts.length,
      kind: col('类型', 'kind', 'type'),
      user: col('目标用户', '用户', 'user'),
      scene: col('使用场景', '场景', 'scene'),
      unit: col('源单元', 'source'),
      facets: (col('facet', '验收', '需求').match(/REQ-\d+-F\d+/gi) || []).map(s => s.toUpperCase()),
      boundaries: b,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 建树：路径 → 节点，机判叶子（**不由她声明**）
// ---------------------------------------------------------------------------
export function buildTree(rows) {
  const byKey = new Map()
  const dups = []
  for (const r of rows || []) {
    if (byKey.has(r.key)) { dups.push(r.key); continue }
    byKey.set(r.key, { ...r, children: [] })
  }
  const orphans = []
  const roots = []
  for (const n of byKey.values()) {
    if (n.depth === 1) { roots.push(n); continue }
    const parentKey = n.parts.slice(0, -1).join(' / ')
    const p = byKey.get(parentKey)
    if (!p) { orphans.push({ key: n.key, parentKey }); roots.push(n); continue }   // 孤儿仍进树，便于渲染出来看
    p.children.push(n)
  }
  for (const n of byKey.values()) n.isLeaf = n.children.length === 0
  // 继承：目标用户 / 使用场景 沿路径向上找最近一个非空
  const inherit = (n, chainUser, chainScene) => {
    n.effUser = _blank(n.user) ? chainUser : _clean(n.user)
    n.effScene = _blank(n.scene) ? chainScene : _clean(n.scene)
    for (const c of n.children) inherit(c, n.effUser, n.effScene)
  }
  for (const r of roots) inherit(r, '', '')
  return { byKey, roots, dups, orphans, nodes: [...byKey.values()] }
}

// ---------------------------------------------------------------------------
// 三条硬判据 + 结构完整性
// ---------------------------------------------------------------------------
// 入参：rows（extractTreeRows）、facetIds（facet 全集，大写）、materialIds（清点单里的材料 id）、
//       traceMappedFacets（溯源表里处置=立需求的 facet 集合，用于双向对账）、
//       treeDocRel/treeDocMissing/declared（指针与可读性）、createdOn（硬/软分档，同溯源闸）
export function computeFeatureTree({
  rows = [], facetIds = [], materialIds = [], traceMappedFacets = [],
  treeDocRel = '', treeDocMissing = false, createdOn = '', since = '2026-09-08',
} = {}) {
  const errors = [], warnings = []
  const active = String(createdOn || '') >= since || !!treeDocRel
  if (!treeDocRel) {
    (active ? errors : warnings).push('缺 frontmatter.feature_tree_doc（《功能树与叶子四要素》路径）——溯源闸只保证"材料里的都登记了"，材料本身写得浅的那部分要靠功能树逼出来。' + TREE_HINT)
    return { active, hard: active, declared: false, treeComplete: false, errors, warnings, stats: null, tree: null }
  }
  if (treeDocMissing) {
    errors.push(`feature_tree_doc 指向的文件找不到/读不到：${treeDocRel}`)
    return { active, hard: active, declared: true, treeComplete: false, errors, warnings, stats: null, tree: null }
  }
  const tree = buildTree(rows)
  if (!rows.length) {
    errors.push(`feature_tree_doc「${treeDocRel}」里解析不到功能树表（需表头含「节点路径」「类型」两列）。` + TREE_HINT)
    return { active, hard: active, declared: true, treeComplete: false, errors, warnings, stats: null, tree }
  }
  const facetSet = new Set((facetIds || []).map(s => String(s).toUpperCase()))
  const matSet = new Set((materialIds || []).map(s => String(s).toLowerCase()))
  const mappedSet = new Set((traceMappedFacets || []).map(s => String(s).toUpperCase()))

  for (const k of tree.dups) errors.push(`功能树有重复节点路径「${k}」——一个节点一行（重了就没法机判叶子）`)
  for (const o of tree.orphans) errors.push(`功能树孤儿节点「${o.key}」：父节点「${o.parentKey}」不在表里——树必须连通，别只写叶子`)

  let leaves = 0, interactive = 0, supplemented = 0, boundaryNA = 0, boundaryFacets = 0
  const treeFacets = new Set()
  for (const n of tree.nodes) {
    // 类型必填且合枚举（一个词的成本，换来 R2 能分档）
    const kind = _clean(n.kind)
    if (!kind) errors.push(`节点「${n.key}」缺类型（${NODE_KINDS.join('/')}）`)
    else if (!NODE_KINDS.includes(kind)) errors.push(`节点「${n.key}」类型「${kind}」不合枚举（${NODE_KINDS.join('/')}）`)

    // R3 每个节点必须有源单元回指，或显式「补充:<理由>」
    const unit = _clean(n.unit)
    if (_blank(unit)) {
      errors.push(`节点「${n.key}」缺源单元回指：填 \`<材料id>#<单元>\`，或材料里没写、你按行业经验补的写 \`补充:<理由>\``)
    } else if (/^补充\s*[:：]/.test(unit)) {
      const why = unit.replace(/^补充\s*[:：]\s*/, '')
      if (why.replace(/\s/g, '').length < 2) errors.push(`节点「${n.key}」的 \`补充:\` 必须写理由（凭什么补这一条：行业惯例/同源需求/用户工作流缺口）`)
      else supplemented++
    } else {
      const mid = unit.split('#')[0].trim().toLowerCase()
      if (matSet.size && !matSet.has(mid)) warnings.push(`节点「${n.key}」的源单元「${unit}」归属到未清点的材料「${mid}」——要么补进 source_materials，要么改成 \`补充:<理由>\``)
    }

    for (const f of n.facets) treeFacets.add(f)
    const bad = n.facets.filter(f => facetSet.size && !facetSet.has(f))
    if (bad.length) errors.push(`节点「${n.key}」挂了不存在的 facet ${bad.join('、')}——facet 全集里没有它（写错号，或还没真立进 facet_doc）`)

    if (!n.isLeaf) continue
    leaves++
    // R1 叶子必须挂 ≥1 真实 facet
    const good = n.facets.filter(f => !facetSet.size || facetSet.has(f))
    if (!good.length) errors.push(`叶子「${n.key}」没挂任何真实 facet——没 facet 的叶子只是个标题，不是可验收的功能`)
    // 四要素前两项（可继承）
    if (_blank(n.effUser)) errors.push(`叶子「${n.key}」缺目标用户（自己写，或写在它的某个祖先节点上继承）`)
    if (_blank(n.effScene)) errors.push(`叶子「${n.key}」缺使用场景（自己写，或写在祖先节点上继承）`)
    // R2 交互类叶子：三类边界逐个交代
    if (!INTERACTIVE_KINDS.has(kind)) continue
    interactive++
    for (const bc of BOUNDARY_COLS) {
      const v = _clean(n.boundaries[bc.key])
      if (_blank(v)) {
        errors.push(`交互类叶子「${n.key}」的「${bc.label}」没交代——填该边界的 facet ID，或写 \`N/A:<理由>\`（七项拷问④要求边界/异常逐个成行，这里把它变成可数）`)
        continue
      }
      // 裸 `N/A`（没写理由）也要落到"N/A 缺理由"这一支，别掉进下面"填了别的话"那支——
      // 报错文案指的方向不同："你忘了写理由" vs "你填的东西我不认"，后者会让人以为格式错了。
      if (/^n\s*\/?\s*a\b/i.test(v) || /^不适用/.test(v)) {
        const why = v.replace(/^(?:n\s*\/?\s*a\b|不适用)\s*[:：]?\s*/i, '')
        if (why.replace(/\s/g, '').length < 2) errors.push(`交互类叶子「${n.key}」的「${bc.label}」写了 N/A 但没写理由——"不适用"必须说为什么，否则和"忘了想"分不开`)
        else boundaryNA++
        continue
      }
      const ids = (v.match(/REQ-\d+-F\d+/gi) || []).map(s => s.toUpperCase())
      if (!ids.length) { errors.push(`交互类叶子「${n.key}」的「${bc.label}」既不是 facet ID 也不是 \`N/A:<理由>\`：「${v}」`); continue }
      const miss = ids.filter(f => facetSet.size && !facetSet.has(f))
      if (miss.length) errors.push(`交互类叶子「${n.key}」的「${bc.label}」指向不存在的 facet ${miss.join('、')}`)
      else { boundaryFacets++; ids.forEach(f => treeFacets.add(f)) }
    }
  }

  // 双向对账（软）：溯源表里「立需求」的 facet 都该落在树的某个节点上，否则那条需求没挂进结构里
  for (const f of mappedSet) if (!treeFacets.has(f)) warnings.push(`facet ${f} 在溯源表里已立需求，但没挂到功能树的任何节点上——它属于哪块功能？`)

  const stats = {
    nodes: tree.nodes.length, leaves, interactive, supplemented,
    boundaryFacets, boundaryNA,
    maxDepth: tree.nodes.reduce((m, n) => Math.max(m, n.depth), 0),
    treeFacets: treeFacets.size, mappedFacets: mappedSet.size,
  }
  return { active, hard: active, declared: true, treeComplete: errors.length === 0, errors, warnings, stats, tree }
}

// ---------------------------------------------------------------------------
// ASCII 树状图：**由引擎从表生成，不许手画**（手画的与 facet 必然漂移，而漂移的图比没有图更坏）
// ---------------------------------------------------------------------------
export function renderFeatureTree(res, { maxLines = 400 } = {}) {
  if (!res || !res.tree) return ''
  const L = []
  const mark = n => {
    const bits = []
    if (n.isLeaf) bits.push(n.facets.length ? n.facets.join(',') : '⚠无facet')
    if (/^补充\s*[:：]/.test(_clean(n.unit))) bits.push('✚材料未覆盖')
    if (n.isLeaf && INTERACTIVE_KINDS.has(_clean(n.kind))) {
      const miss = BOUNDARY_COLS.filter(bc => _blank(n.boundaries[bc.key])).map(bc => bc.label)
      bits.push(miss.length ? '⚠缺边界:' + miss.join('/') : '边界齐')
    }
    return bits.length ? `　［${bits.join(' · ')}］` : ''
  }
  // 全量生成再截断（**不在 walk 里提前 return**：那样 L.length 会停在上限上，
  // 「还有 N 行」永远算成 0——截断必须让人知道截了多少，否则又是一次"看着覆盖全了"）。
  const walk = (n, prefix, last, isRoot) => {
    const label = `${n.name}${n.kind ? `〈${_clean(n.kind)}〉` : ''}${mark(n)}`
    L.push(isRoot ? label : `${prefix}${last ? '└─ ' : '├─ '}${label}`)
    const childPrefix = isRoot ? '' : prefix + (last ? '   ' : '│  ')
    n.children.forEach((c, i) => walk(c, childPrefix, i === n.children.length - 1, false))
  }
  res.tree.roots.forEach(r => walk(r, '', true, true))
  const s = res.stats
  const head = s
    ? `功能树：${s.nodes} 节点 / ${s.leaves} 叶子（其中交互类 ${s.interactive}）/ 最深 ${s.maxDepth} 层；` +
      `边界交代 ${s.boundaryFacets} 条 facet + ${s.boundaryNA} 条 N/A；**材料未覆盖·我补的 ${s.supplemented} 个节点** → ` +
      (res.treeComplete ? '✅ 结构判据通过' : '⛔ 未通过，不许进开发')
    : ''
  return [head, '', '```', ...L.slice(0, maxLines), (L.length > maxLines ? `…（还有 ${L.length - maxLines} 行）` : ''), '```']
    .filter(x => x !== '').join('\n')
}
