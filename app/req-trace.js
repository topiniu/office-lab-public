// ============================================================================
// 需求溯源闸（requirement_trace_complete）—— 「facet 表齐不齐」的机器判据
//
// 缘起（2026-09-08 项目跟踪 v0.1.0 事故，老板：「为什么她一而再再而三把需求简单化、遗漏掉」）：
// 老板给的原型 Demo 里每个元素都带 `data-logic="x" data-logic-no="N"` + 一本 LOGIC 字典
// （触发条件/系统处理/页面反馈/二次确认/PRD 出处），**d0 185 条 + d2 78 条 + d3 43 条 ≈ 290 条编号规格**。
// 菲菲登记了 **38 条 facet**，然后：三方会审背书（两位读的是她那份缩水文档）→ GG Bond 照 facet 做 →
// 迷糊照 facet 测 → 覆盖矩阵 38/38 COVERED_GREEN → RC_READY → 老板打开一看「跟 demo 完全不一样」。
//
// 根因不是"材料读不完"：她 9-07 读过的注释里，「抽屉」出现 18 次、「模板列表/模板详情两级页」写在
// `_cmt_d2` 第 3 行、「对外语料」「撤回栈」「逐尺码」全在——**读到了，没有一条机制逼她把读到的东西
// 一条一条落成 facet**。而 coverage.js 的分母就是她自己写的 facet 表（`extractFacetsFromDoc`），
// 于是整条流水线只会问「facet 都测了吗」，从来没有一环问「facet 齐了吗」：写少了照样全绿。
//
// 本模块补的就是那一环：**给 facet 表一个外部锚点 = 源材料的可枚举单元**。
//   ① 源材料清点单（archive frontmatter `source_materials`）：每份材料的可枚举单元数 + 读法（读全没读全）。
//      —— 治「工具失败→降级读法→静默交付」：四个 subagent 被 hook 拦掉后她改用关键词词频，没人知道。
//   ② 溯源映射表（archive frontmatter `trace_doc`）：源材料每个单元一行，处置三选一
//      立需求→facet ID / 本版不做→理由 / 待老板拍。**留空不许冻结、不许进开发。**
//   ③ 机算 traceComplete：单元数对不上、指向不存在的 facet、"本版不做"没理由、还有"待老板拍"没清零 → 拦。
//
// 与 coverage.js 的分工（别混）：coverage 管「已登记的 facet 有没有被真测」（分母=facet 表），
// 本模块管「facet 表本身有没有覆盖源材料」（分母=源材料单元）。两个分母，两道闸，缺一个都能全绿放行。
//
// 向后兼容（同 coverage.js 的 opt-in 传统）：`TRACE_GATE_SINCE` 之前创建的档案只软提示、不硬挡——
// 在研版本不能被新闸门当场卡死；之后创建的档案一律硬挡（模板已内建必填占位）。
//
// 独立成 ESM 模块：纯函数 + 一个只读扫描器，可单测（不启动 server）。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'

// 本闸门对「这一天及以后创建的任务档案」硬生效；之前的只软提示（不卡死在研版本）。
export const TRACE_GATE_SINCE = '2026-09-08'

// 处置枚举（映射表「处置」列）。同义写法一律归一——菲菲手写表格，别为措辞把闸门变成错字检查器。
export const DISPOSITIONS = ['立需求', '本版不做', '待老板拍']
const DISPOSITION_ALIAS = [
  [/^(立需求|本版做|纳入|已立|立facet|→facet)/i, '立需求'],
  [/^(本版不做|不做|二期|下一期|后续版本|范围外|out)/i, '本版不做'],
  [/^(待老板拍|待拍|待拍板|待确认|待定|pending)/i, '待老板拍'],
]
export const normalizeDisposition = v => {
  const s = String(v || '').replace(/\*\*/g, '').trim()
  if (!s) return ''
  for (const [re, to] of DISPOSITION_ALIAS) if (re.test(s)) return to
  return ''
}

// 读法枚举（源材料清点单 `read=`）：full=正文逐段读完；degraded=用了代理信号（只读注释/关键词词频/
// 只读摘要/子代理失败未兜底）；none=压根没读（引用但未消化）。degraded/none 必须写 why。
export const READ_MODES = ['full', 'degraded', 'none']

export const FACET_ID_RE = /REQ-\d+-F\d+/i

export const TRACE_HINT =
  '溯源闸要两样东西（都在任务档案 frontmatter）：\n' +
  '  ① source_materials —— 源材料清点单，每份一行：`- <id> | <路径或路径#片段> | <类型> | units=<可枚举单元数> | read=full|degraded|none | why=<降级理由>`\n' +
  '     可枚举单元数别手估：跑 `scan_source_material` 让引擎数（原型 HTML 数 data-logic 元素、md 数标题），数出来多少就是多少。\n' +
  '     确实没有可枚举源材料（纯缺陷 hotfix / 老板口头需求）→ 写 `source_materials: none — <理由>`，显式声明可审计，不许静默省略。\n' +
  '  ② trace_doc —— 《源材料溯源映射表》路径，表头含「源单元」「处置」两列；源材料每个单元一行，处置三选一：\n' +
  '     `立需求`（facet 列填 REQ-xxxx-Fn，必须真在 facet 全集里）/ `本版不做`（理由列必填）/ `待老板拍`（开工前必须清零）。\n' +
  '  模板：templates/pm-源材料溯源映射表.md；规矩见 roles/feifei.md「源材料清点与溯源」。'

const _rc = line => { const c = line.split('|').map(x => x.trim()); c.shift(); if (c[c.length - 1] === '') c.pop(); return c }
const _isSep = line => /^[-:\s]+$/.test(line.replace(/\|/g, ''))

// ---------------------------------------------------------------------------
// ① 源材料清点单：frontmatter.source_materials
// ---------------------------------------------------------------------------
// 形态（刻意做成「一份一行的管道串」而不是 YAML 嵌套 map）：server.js 的 parseFrontmatter 是浅解析器，
// `- id: d0` 这种 list-of-maps 会被它读成字符串 "id: d0"、后续同缩进的 path/units 行**静默丢弃**——
// 声明看着写了、引擎读到的是空。管道串对浅解析器无损，也和档案里既有的 `k=v;k=v` 证据串同风格。
export function parseSourceMaterials(value) {
  const out = { declared: false, none: false, noneReason: '', materials: [], errors: [] }
  if (value == null || value === '' || value === false) return out
  // `none — 理由` / `none` （无可枚举源材料的显式声明）
  if (!Array.isArray(value)) {
    const s = String(value).trim()
    if (!s) return out
    out.declared = true
    const m = s.match(/^(none|无)\s*(?:[—\-–:：]+\s*)?(.*)$/i)
    if (m) {
      out.none = true
      out.noneReason = (m[2] || '').trim()
      if (out.noneReason.replace(/\s/g, '').length < 4) out.errors.push('source_materials: none 必须写理由（如 `none — 纯缺陷 hotfix，老板口头描述，无可枚举源材料`）——不写理由的 none 等于静默省略')
      return out
    }
    // 单份材料写成裸标量也认（一行的情况）
    return parseSourceMaterials([s])
  }
  out.declared = value.length > 0
  const seen = new Set()
  for (const raw of value) {
    const line = String(raw || '').trim()
    if (!line) continue
    if (/^(none|无)\b/i.test(line)) { out.none = true; out.noneReason = line.replace(/^(none|无)\s*[—\-–:：]*\s*/i, '').trim(); continue }
    const parts = line.split('|').map(s => s.trim()).filter(s => s !== '')
    if (parts.length < 2) { out.errors.push(`源材料清点行读不出「id | 路径 | …」：「${line}」。${TRACE_HINT}`); continue }
    const mat = { id: parts[0], path: parts[1], kind: '', units: null, read: '', why: '', enumeratedBy: '' }
    for (const seg of parts.slice(2)) {
      const kv = seg.match(/^([\w一-鿿]+)\s*=\s*(.*)$/)
      if (!kv) { if (!mat.kind) mat.kind = seg; continue }
      const k = kv[1].toLowerCase(), v = kv[2].trim()
      if (k === 'units' || k === '单元数') mat.units = /^\d+$/.test(v) ? Number(v) : v
      else if (k === 'read' || k === '读法') mat.read = v.toLowerCase()
      else if (k === 'why' || k === '理由') mat.why = v
      else if (k === 'by' || k === 'enumerated_by') mat.enumeratedBy = v
      else if (k === 'kind' || k === '类型') mat.kind = v
    }
    if (!mat.kind) mat.kind = 'unknown'
    if (seen.has(mat.id.toLowerCase())) out.errors.push(`源材料 id「${mat.id}」重复——每份材料一个唯一 id（映射表按它归属单元）`)
    seen.add(mat.id.toLowerCase())
    if (!(typeof mat.units === 'number' && mat.units >= 0)) out.errors.push(`源材料「${mat.id}」缺 units=<可枚举单元数>（跑 scan_source_material 让引擎数，别手估；截图类人工逐控件数）`)
    if (!READ_MODES.includes(mat.read)) out.errors.push(`源材料「${mat.id}」缺 read=full|degraded|none —— 读法必须显式：读全了就写 full，用了代理信号（只读注释/关键词词频/只读摘要/子代理失败未兜底）就写 degraded 并写 why`)
    else if (mat.read !== 'full' && mat.why.replace(/\s/g, '').length < 4) out.errors.push(`源材料「${mat.id}」read=${mat.read} 必须写 why=<降级理由>（降级读法要留痕、要带进会审与交接卡，不许静默）`)
    out.materials.push(mat)
  }
  return out
}

// ---------------------------------------------------------------------------
// ② 溯源映射表：trace_doc 里表头含「源单元」+「处置」的那张（或那几张）表
// ---------------------------------------------------------------------------
// 表头嗅探沿用 coverage.js·extractFacetsFromDoc 的宽松口径（列名前缀匹配、允许 **加粗**），
// 因为这张表是菲菲手写的，列序/措辞会漂；漂了就解析不到 = 闸门被措辞绕过，比误报更糟。
export function extractTraceRows(docText) {
  const out = []
  if (!docText) return out
  let header = null
  for (const raw of String(docText).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) { header = null; continue }
    const cells = _rc(line)
    if (!header) {
      const flat = cells.map(c => c.replace(/\*\*/g, ''))
      if (flat.some(c => /源单元|source.?unit/i.test(c)) && flat.some(c => /处置|disposition/i.test(c))) header = flat
      continue
    }
    if (_isSep(line)) continue
    const col = (...names) => { for (const n of names) { const i = header.findIndex(h => h.replace(/\*\*/g, '').toLowerCase().startsWith(String(n).toLowerCase())) ; if (i >= 0) return (cells[i] || '').replace(/\*\*/g, '').trim() } return '' }
    const unit = col('源单元', 'source')
    if (!unit || /^[-—–]+$/.test(unit)) continue
    const hashIdx = unit.indexOf('#')
    out.push({
      unit,
      material: (hashIdx > 0 ? unit.slice(0, hashIdx) : unit).trim(),
      what: col('说的是什么', '内容', '摘要', '元素'),
      disposition: normalizeDisposition(col('处置', 'disposition')),
      dispositionRaw: col('处置', 'disposition'),
      facets: (col('facet', '需求').match(/REQ-\d+-F\d+/gi) || []).map(s => s.toUpperCase()),
      reason: col('理由', '备注', '说明'),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// ③ 机算 traceComplete
// ---------------------------------------------------------------------------
// 入参：
//   materials  parseSourceMaterials(...) 的结果
//   rows       extractTraceRows(...) 的结果
//   facetIds   facet 全集的 ID 集合（来自 coverage.js·extractFacetsFromDoc，大写）
//   traceDocRel/traceDocMissing  trace_doc 指针与可读性
//   createdOn  档案 frontmatter.created（决定硬/软：TRACE_GATE_SINCE 之前的只软提示）
export function computeTrace({ materials, rows = [], facetIds = [], traceDocRel = '', traceDocMissing = false, createdOn = '' } = {}) {
  const errors = [], warnings = []
  const src = materials || { declared: false, none: false, materials: [], errors: [] }
  const since = String(createdOn || '') >= TRACE_GATE_SINCE      // 'YYYY-MM-DD' 字典序即时间序
  const active = src.declared || since
  const facetSet = new Set((facetIds || []).map(s => String(s).toUpperCase()))

  if (!src.declared) {
    (active ? errors : warnings).push('缺 frontmatter.source_materials（源材料清点单）——没有它就没人知道 facet 表该对着什么扫、更不知道哪份材料是"降级读"的。' + TRACE_HINT)
    return { active, hard: active, declared: false, none: false, traceComplete: false, errors, warnings, materials: [], pending: 0, unmapped: 0, rowCount: rows.length }
  }
  errors.push(...src.errors)

  // 显式声明「无可枚举源材料」→ 闸门放行（但留痕）。纯缺陷 hotfix / 口头需求走这条。
  if (src.none && !src.materials.length) {
    warnings.push(`source_materials: none（${src.noneReason || '未写理由'}）——本版按"无可枚举源材料"放行溯源闸；若其实有原型/PRD/截图，改成逐份清点`)
    return { active, hard: active, declared: true, none: true, traceComplete: errors.length === 0, errors, warnings, materials: [], pending: 0, unmapped: 0, rowCount: rows.length }
  }

  if (!traceDocRel) errors.push('缺 frontmatter.trace_doc（《源材料溯源映射表》路径）——清点单说了有多少单元，映射表才是"每个单元怎么处置"的账。' + TRACE_HINT)
  else if (traceDocMissing) errors.push(`trace_doc 指向的文件找不到/读不到：${traceDocRel}`)

  // 按材料归属统计
  const byMat = new Map(src.materials.map(m => [m.id.toLowerCase(), { ...m, rows: 0, mapped: 0, out: 0, pending: 0, bad: 0, dup: 0 }]))
  const seenUnit = new Set()
  const orphanMats = new Set()
  for (const r of rows) {
    const key = String(r.material || '').toLowerCase()
    const bucket = byMat.get(key)
    if (!bucket) { orphanMats.add(r.material || '(空)'); continue }
    const uk = key + '#' + r.unit.toLowerCase()
    if (seenUnit.has(uk)) { bucket.dup++; continue }
    seenUnit.add(uk)
    bucket.rows++
    if (r.disposition === '立需求') {
      if (!r.facets.length) { bucket.bad++; errors.push(`映射表「${r.unit}」处置=立需求 但 facet 列没有合法 facet ID（形如 REQ-0339-F45）`) }
      else {
        const missing = facetSet.size ? r.facets.filter(f => !facetSet.has(f)) : []
        if (missing.length) { bucket.bad++; errors.push(`映射表「${r.unit}」指向不存在的 facet ${missing.join('、')}——facet 全集里没有它（写错号，或 facet 还没真立进 facet_doc）`) }
        else bucket.mapped++
      }
    } else if (r.disposition === '本版不做') {
      if (r.reason.replace(/\s/g, '').length < 2) { bucket.bad++; errors.push(`映射表「${r.unit}」处置=本版不做 但理由列为空——"不做"必须写为什么，否则和"漏了"在账面上分不开`) }
      else bucket.out++
    } else if (r.disposition === '待老板拍') {
      bucket.pending++
    } else {
      bucket.bad++
      errors.push(`映射表「${r.unit}」处置「${r.dispositionRaw || '(空)'}」不合枚举（${DISPOSITIONS.join(' / ')}）`)
    }
  }
  for (const m of orphanMats) warnings.push(`映射表里有行归属到未清点的源材料「${m}」——要么把它补进 source_materials，要么改对源单元前缀`)

  let pending = 0, unmapped = 0
  const mats = []
  for (const b of byMat.values()) {
    const units = typeof b.units === 'number' ? b.units : 0
    const gap = Math.max(0, units - b.rows)
    unmapped += gap
    pending += b.pending
    if (b.read === 'none') warnings.push(`源材料「${b.id}」read=none（${b.why || '未写理由'}）——引用了但没消化；它的单元若也没进映射表，就是明摆着的需求缺口`)
    else if (b.read === 'degraded') warnings.push(`⚠ 降级读法：源材料「${b.id}」read=degraded（${b.why || '未写理由'}）——这条必须带进三方会审记录与交接卡，让 GG Bond/迷糊 知道这块口径不是逐段读出来的`)
    if (gap > 0) errors.push(`源材料「${b.id}」还有 ${gap} 个单元没进映射表（清点 ${units} / 已映射 ${b.rows}）——每个单元都得有处置：立需求 / 本版不做（写理由）/ 待老板拍`)
    if (b.dup > 0) warnings.push(`源材料「${b.id}」映射表里有 ${b.dup} 行源单元重复（按 unit 去重后计数）`)
    mats.push({ id: b.id, path: b.path, kind: b.kind, units, read: b.read, why: b.why, rows: b.rows, mapped: b.mapped, out: b.out, pending: b.pending, bad: b.bad, gap })
  }
  if (pending > 0) errors.push(`映射表还有 ${pending} 个单元停在「待老板拍」——开工前必须清零（拍成"立需求"或"本版不做"），带着未决口径开工就是让 GG Bond 猜`)

  return {
    active, hard: active, declared: true, none: false,
    traceComplete: errors.length === 0,
    errors, warnings, materials: mats,
    pending, unmapped, rowCount: rows.length,
    unitTotal: mats.reduce((n, m) => n + m.units, 0),
    mappedTotal: mats.reduce((n, m) => n + m.mapped, 0),
    outTotal: mats.reduce((n, m) => n + m.out, 0),
  }
}

// 渲染成看板/晨检包/交接卡可贴的一段（把"哪份材料读到什么程度、覆盖率多少"摊开，别再靠自述）
export function renderTraceSummary(res) {
  if (!res) return ''
  if (res.none) return `### 需求溯源闸\n\n本版声明「无可枚举源材料」（${res.noneReason || '未写理由'}）——溯源闸不适用。`
  const L = ['### 需求溯源闸（facet 表对着源材料扫没扫全）', '', '| 源材料 | 类型 | 清点单元 | 已映射 | 立需求 | 本版不做 | 待拍 | 缺口 | 读法 |', '|--------|------|---------|-------|-------|---------|-----|------|------|']
  for (const m of res.materials || []) L.push(`| ${m.id} | ${m.kind} | ${m.units} | ${m.rows} | ${m.mapped} | ${m.out} | ${m.pending} | ${m.gap > 0 ? '**' + m.gap + '**' : '0'} | ${m.read}${m.read !== 'full' ? '⚠' : ''} |`)
  L.push('', `**合计**：清点 ${res.unitTotal || 0} 单元 / 映射 ${res.rowCount} 行 / 缺口 ${res.unmapped} / 待拍 ${res.pending} → ${res.traceComplete ? '✅ 溯源完整' : '⛔ 未完整，不许进开发'}`)
  if (res.errors?.length) { L.push('', '**拦下的原因**'); for (const e of res.errors) L.push(`- ${e}`) }
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// 源材料可枚举单元扫描器（让 units 是机器数出来的事实，不是她手估的数字）
// ---------------------------------------------------------------------------
// 为什么必须机器数：这次事故里"290 条规格 vs 38 条 facet"的落差之所以没人发现，就是因为分母从来
// 没被数过。手估的 units 可以随手写小（写 38 就永远"覆盖完整"），机器数出来的不能。
// 支持的形态（数不出来就如实说数不出来，绝不猜一个数糊过去）：
//   .html         —— 数 data-logic 属性（老板原型 Demo 的标注协议：每个元素一条编号规格）；
//                    顺带解码 `<script id="doc-xx">` 里的 base64 内嵌页（1788759420388-f71a18.html 就是这形态，
//                    4 页 base64 = d0/d1/d2/d3，各自再数一遍），返回 subDocs。
//   .md/.txt      —— 数 `##` 及更深的标题（PRD/需求文档的自然单元）。
//   图片/其他     —— units=null + note：只能人工逐控件枚举，让她自己填并写 enumerated_by。
export function scanSourceMaterial(abs, { maxBytes = 8 * 1024 * 1024 } = {}) {
  const ext = path.extname(String(abs || '')).toLowerCase()
  const st = fs.statSync(abs)
  const base = { path: abs, bytes: st.size, kind: 'unknown', units: null, unitIds: [], subDocs: [], note: '' }
  if (/^\.(png|jpe?g|gif|webp|bmp|pdf|xlsx?|docx?)$/.test(ext)) {
    return { ...base, kind: ext.slice(1), note: '这类材料引擎数不出可枚举单元（截图/表格/PDF）——请人工逐控件/逐行枚举后手填 units，并写 by=<怎么枚举的>' }
  }
  if (st.size > maxBytes) return { ...base, note: `文件 ${st.size} 字节超过扫描上限 ${maxBytes}——先拆分或指定片段（路径#片段）再扫` }
  const text = fs.readFileSync(abs, 'utf8')
  if (ext === '.html' || ext === '.htm') {
    // 两路信号取大者。为什么不能只数 data-logic 属性：老板 Demo 的 d3 页有 43 条 LOGIC 字典规格
    // （`colOrderNo:{no:19,type:'field',elem:'…'}`），但只有 27 个元素真挂了 data-logic 属性——
    // 只数属性会把分母数小 16 条，而"分母数小"正是这次事故的形态。取大者 + 两路都报出来，让人能看出差。
    const countLogic = src => {
      const attrs = [...new Set([...src.matchAll(/data-logic="([^"]+)"/g)].map(m => m[1]))]
      const dict = [...new Set([...src.matchAll(/(\w+)\s*:\s*\{\s*no\s*:\s*\d+\s*,\s*type\s*:\s*'[^']*'/g)].map(m => m[1]))]
      const ids = attrs.length >= dict.length ? attrs : dict
      return { ids, attrs: attrs.length, dict: dict.length }
    }
    const subDocs = []
    for (const m of text.matchAll(/<script[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/script>/g)) {
      const id = m[1], body = m[2].trim()
      if (!/^[A-Za-z0-9+/=\s]{2000,}$/.test(body)) continue          // 只认整块 base64 的内嵌页
      let decoded = ''
      try { decoded = Buffer.from(body, 'base64').toString('utf8') } catch { continue }
      if (!/<html|<body|<div/i.test(decoded)) continue
      const c = countLogic(decoded)
      subDocs.push({
        id, chars: decoded.length, units: c.ids.length, unitIds: c.ids.slice(0, 400), attrs: c.attrs, dict: c.dict,
        note: c.ids.length === 0
          ? '⚠ 这一页没有 data-logic/LOGIC 标注 —— units 必须人工逐屏枚举可见元素与交互后手填，并写 by=；**这是最容易被漏掉的一页**（无标注＝机器帮不上，只能靠人读全）'
          // 稀疏度体检：一页几万字符却只有个别标注 = 机器数出来的分母本身就是缩水的（老板 Demo 的 d1
          // 就是这形态：83k 字符、只有 2 个 data-logic，而它恰是"逐尺码/数量来源"那批漏项的所在页）。
          // 这里必须主动喊出来，否则"机器数的"会给人一种"数过了"的错觉——那比手估更危险。
          : (c.ids.length * 5000 < decoded.length
            ? `⚠ 标注稀疏：${decoded.length} 字符只数出 ${c.ids.length} 条（data-logic ${c.attrs} / 字典 ${c.dict}）——这页的标注不成体系，机器数出来的分母**大概率是缩水的**，必须人工逐屏枚举后手填 units 并写 by=`
            : (c.attrs !== c.dict ? `两路信号不一致（data-logic 属性 ${c.attrs} / LOGIC 字典 ${c.dict}），按大者 ${c.ids.length} 计——差额那部分请人工核一遍` : '')),
      })
    }
    const own = countLogic(text)
    const note = subDocs.length
      ? `含 ${subDocs.length} 个 base64 内嵌页（${subDocs.map(d => `${d.id}=${d.units}`).join(' / ')}）——**逐页各清点一行**（路径#<id>），别把几页合成一行报一个总数`
      + (subDocs.some(d => d.units === 0) ? `；⚠ 其中 ${subDocs.filter(d => d.units === 0).map(d => d.id).join('、')} 无标注、机器数不出来，必须人工逐屏枚举后手填` : '')
      : (own.ids.length ? `按标注元素计数（data-logic 属性 ${own.attrs} / LOGIC 字典 ${own.dict}，取大者）` : '这份 HTML 没有 data-logic 标注——units 需人工逐屏枚举可见元素/交互后手填，并写 by=')
    return { ...base, kind: 'prototype-html', units: own.ids.length || null, unitIds: own.ids.slice(0, 400), signals: { attrs: own.attrs, dict: own.dict }, subDocs, note }
  }
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    const heads = (text.match(/^#{2,}\s+.+$/gm) || []).map(s => s.replace(/^#+\s+/, '').trim())
    return { ...base, kind: 'doc', units: heads.length || null, unitIds: heads.slice(0, 400), note: heads.length ? '按 `##` 及更深标题计数（章节即单元）；若文档是长表格驱动，改按表行数人工清点' : '没解析到标题——units 需人工清点后手填' }
  }
  return { ...base, note: `未支持的扩展名「${ext || '(无)'}」——人工清点 units 并写 by=<怎么枚举的>` }
}
