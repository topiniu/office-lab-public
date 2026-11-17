// ============================================================================
// 示例项目「模块设计基线」与审美判定（2026-09-07，老板拍板：以示例项目模块的页面为标准 + 加审美判定）
//
// 缘起：此前视觉验收的标准是**元素自己的上一次**（`assertVisual` 像素基线）。它能证明「没变」，
// 证明不了「对」——首跑录的那一版就是标准，坏布局第一趟就固化成参照物。而老板要的标准是
// **「示例项目这套页面长什么样」**：新页面/新元素该像这个模块里的同类元素，而不是像它自己的历史。
//
// 于是分三层，**性质不同、必须分开报**：
//   ① 模块基线一致性（可测·相对）—— 同类元素的设计 token 与模块里 N 个同类的规范值比。
//      判据不是我编的阈值，而是「模块里 12/13 个同类都是 2px 圆角，这个是 8px」这种**数出来的多数**。
//   ② 设计系统量化指标（可测·绝对）—— 间距是否落在模块刻度上、字号/圆角/色彩用量有没有爆掉、
//      同一行控件是否对齐。这是**审美的可测代理**：不需要品味也能算，且能解释自己。
//   ③ 审美判定（判断·非测量）—— 真正需要眼睛的那部分，由迷糊看截图按 rubric 出结论。
//      **硬约束：每条审美意见必须挂一条可指认的机器事实**（元素 selector / token 值 / 量化偏离），
//      挂不上的意见一律打回，不许进结论。这是防「AI 拍脑袋说不好看」的唯一办法。
//
// 老板保留一票否决（他是终审），但迷糊**必须先出意见**——不再把整件事推回去说「审美归老板」。
//
// 纯函数、无 fs、无网络，便于 `node --test`。素材来源是猪猪 `visual-review.json` 的 items。
// ============================================================================

// ---------- 元素分类：示例项目 testid 命名约定（`<模块>-<组件简称>-<功能>`，见 CLAUDE.md） ----------
// 顺序敏感：先匹配更具体的（search-btn / reset-btn 早于泛化的 btn）。
export const ELEMENT_CLASSES = [
  { key: 'primary-btn', label: '筛选区主按钮', test: id => /-search-btn$/.test(id) },
  { key: 'secondary-btn', label: '筛选区次按钮', test: id => /-reset-btn$/.test(id) },
  { key: 'action-btn', label: '行内/操作按钮', test: id => /-btn$/.test(id) },
  { key: 'table', label: '表格', test: id => /-table$/.test(id) },
  { key: 'modal', label: '弹窗', test: id => /-modal$/.test(id) },
  { key: 'drawer', label: '抽屉', test: id => /-drawer$/.test(id) },
  { key: 'panel', label: '面板/容器', test: id => /-(panel|board|body|shell)$/.test(id) },
  { key: 'tabs', label: '页签', test: id => /-tabs?$/.test(id) },
  { key: 'select', label: '下拉选择', test: id => /-(select|range|scope)$/.test(id) },
  { key: 'input', label: '输入框', test: id => /-(input|search-input)$/.test(id) },
  { key: 'cell', label: '表格单元格', test: id => /-cell$/.test(id) },
]
// selector（`[data-testid="x"]`）→ testid
export function testIdOf(selector) {
  const m = /\[data-testid="([^"]+)"\]/.exec(String(selector || ''))
  return m ? m[1] : ''
}
export function classifyElement(selector) {
  const id = testIdOf(selector) || String(selector || '')
  for (const c of ELEMENT_CLASSES) if (c.test(id)) return c.key
  return 'other'
}
export const classLabel = key => (ELEMENT_CLASSES.find(c => c.key === key)?.label || '其他')

// ---------- 从素材里把「每个元素的 token」摊平出来 ----------
// items 里两种 kind 都带 tokens；`peers` 那种还额外带 peers[].tokens（同一次采集的隔壁元素）。
// **采样套件就靠这一点省事**：一页挑若干代表元素做一次 assertVisualPeers（mustMatch 留空、只出素材），
// 一步就把整页的 token 采齐。
export function flattenObservations(items = []) {
  const out = []
  for (const it of (Array.isArray(items) ? items : [])) {
    if (it?.selector && it?.tokens) out.push({ selector: String(it.selector), tokens: it.tokens, box: it.box || null, accessibility: it.accessibility || null, truncation: it.truncation || null, viewport: it.viewport || null })
    for (const p of (Array.isArray(it?.peers) ? it.peers : [])) {
      if (p?.found !== false && p?.selector && p?.tokens) out.push({ selector: String(p.selector), tokens: p.tokens, box: null, accessibility: null, truncation: null, viewport: it.viewport || null })
    }
  }
  // 同一个 selector 采到多次（多 case 重复走同一页）时只留一份——否则"多数票"会被重复采样刷票
  const seen = new Set()
  return out.filter(o => { if (seen.has(o.selector)) return false; seen.add(o.selector); return true })
}

// 参与「模块规范值」统计的 token（刻意排除会因元素语义合理不同的：color / backgroundColor /
// borderColor / textAlign / display / margin —— 主按钮和次按钮的主色本就该不同，拿它做多数票是错的）
export const CANON_TOKENS = ['fontSize', 'fontWeight', 'lineHeight', 'fontFamily', 'borderRadius', 'borderWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap']
// 属于「模块刻度」的尺寸类 token（用于②的刻度外值检查）
export const SCALE_TOKENS = ['fontSize', 'borderRadius', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap', 'marginTop', 'marginBottom']

const norm = v => (v == null ? null : (typeof v === 'number' ? v : String(v)))
function histogram(values) {
  const h = new Map()
  for (const v of values) { const k = norm(v); if (k == null) continue; h.set(k, (h.get(k) || 0) + 1) }
  return h
}
function majority(h) {
  let best = null, bestN = 0, total = 0
  for (const [k, n] of h) { total += n; if (n > bestN) { best = k; bestN = n } }
  return { value: best, count: bestN, total, share: total ? bestN / total : 0 }
}

// ---------- ① 建模块设计基线 ----------
// 出参：{ generatedAt, sampleCount, byClass:{cls:{label, n, tokens:{t:{value,count,total,share,histogram}}}},
//         scales:{t:{values:[{value,count}], scale:[值(出现≥2次)]}}, colors:{…}, source:{…} }
// **刻意不设"容差阈值"**：基线只记事实（每个值出现几次），判定时说「模块里 12/13 个同类是 X」，
// 由读的人判断这算不算问题——阈值是我编的，计数是数出来的。
export function buildDesignBaseline(items = [], meta = {}) {
  const obs = flattenObservations(items)
  const byClass = {}
  for (const o of obs) {
    const cls = classifyElement(o.selector)
    const bucket = (byClass[cls] = byClass[cls] || { label: classLabel(cls), n: 0, selectors: [], raw: {} })
    bucket.n += 1
    bucket.selectors.push(o.selector)
    for (const t of CANON_TOKENS) (bucket.raw[t] = bucket.raw[t] || []).push(o.tokens?.[t])
  }
  for (const b of Object.values(byClass)) {
    b.tokens = {}
    for (const t of CANON_TOKENS) {
      const h = histogram(b.raw[t] || [])
      if (!h.size) continue
      b.tokens[t] = { ...majority(h), histogram: [...h.entries()].map(([value, count]) => ({ value, count })).sort((a, b2) => b2.count - a.count) }
    }
    delete b.raw
  }
  const scales = {}
  for (const t of SCALE_TOKENS) {
    const h = histogram(obs.map(o => o.tokens?.[t]))
    if (!h.size) continue
    const values = [...h.entries()].map(([value, count]) => ({ value, count })).sort((a, b2) => (Number(a.value) || 0) - (Number(b2.value) || 0))
    scales[t] = { values, scale: values.filter(v => v.count >= 2).map(v => v.value) }
  }
  const colorHist = {}
  for (const t of ['color', 'backgroundColor', 'borderColor']) {
    const h = histogram(obs.map(o => o.tokens?.[t]))
    colorHist[t] = [...h.entries()].map(([value, count]) => ({ value, count })).sort((a, b2) => b2.count - a.count)
  }
  return {
    baselineVersion: 1,
    module: String(meta.module || '示例项目'),
    sampleCount: obs.length,
    pages: Array.isArray(meta.pages) ? meta.pages.map(String) : [],
    runIds: Array.isArray(meta.runIds) ? meta.runIds.map(String) : [],
    viewport: obs.find(o => o.viewport)?.viewport || null,
    byClass, scales, colors: colorHist,
    note: '标准 = 示例项目模块自己：同类元素的规范值由「模块里多数同类元素是什么」数出来，不是谁拍的阈值。样本越多越可信；sampleCount 小的时候结论要当线索、不当判决。',
  }
}

// 基线可信度：样本太少的类别不该拿去判人
export const MIN_CLASS_SAMPLES = 3
export function baselineConfidence(baseline, cls) {
  const n = baseline?.byClass?.[cls]?.n || 0
  if (n >= 8) return { level: 'high', n, why: '' }
  if (n >= MIN_CLASS_SAMPLES) return { level: 'medium', n, why: `该类只采到 ${n} 个样本，结论按「线索」用` }
  return { level: 'low', n, why: `该类只采到 ${n} 个样本（< ${MIN_CLASS_SAMPLES}），**不足以当模块规范**——先扩采样，别据此打回开发` }
}

// ---------- ① 判定：新元素 vs 模块基线 ----------
// 出参 deviations: [{ selector, cls, token, actual, canonical, count, total, share, confidence, why }]
export function judgeAgainstBaseline(items = [], baseline = null) {
  if (!baseline?.byClass) return { available: false, why: '没有模块设计基线——先跑采样套件用 build 生成（标准得先存在，才能拿它判）', deviations: [], checked: 0 }
  const obs = flattenObservations(items)
  const deviations = []
  let checked = 0
  for (const o of obs) {
    const cls = classifyElement(o.selector)
    const b = baseline.byClass[cls]
    if (!b?.tokens) continue
    const conf = baselineConfidence(baseline, cls)
    for (const [t, spec] of Object.entries(b.tokens)) {
      const actual = norm(o.tokens?.[t])
      if (actual == null || spec.value == null) continue
      checked += 1
      if (actual === spec.value) continue
      // 基线里本来就有这个值（模块内并存多种）→ 不算偏离，只是不属多数
      const known = (spec.histogram || []).find(h => h.value === actual)
      // ⚠ **把被判元素自己从"模块里也有人这么写"里扣掉**（2026-09-07 实测抓到）：采样套件采过的元素
      // 后来又被拿去判定时，它自己也在基线的直方图里，于是「模块里没有第二个这么写的」会被它自己
      // 降级成「并存两套写法」——**自己给自己作证**，⚠ 就这么变成了 ·。基线里存了每类的 selectors，
      // 命中就减 1。这跟红线里「断言不许拿自己当证据」是同一条道理。
      const selfInBaseline = (b.selectors || []).includes(o.selector)
      const alsoSeen = Math.max(0, (known?.count || 0) - (selfInBaseline ? 1 : 0))
      deviations.push({
        selector: o.selector, cls, clsLabel: classLabel(cls), token: t, actual, canonical: spec.value,
        count: spec.count, total: spec.total, share: spec.share, alsoSeen, selfInBaseline,
        confidence: conf.level,
        why: alsoSeen > 0
          ? `模块里 ${spec.count}/${spec.total} 个${classLabel(cls)}是 ${spec.value}，本元素 ${actual}（模块里另有 ${alsoSeen} 个这么写）——并存两套写法，值得统一但不一定是错`
          : `模块里 ${spec.count}/${spec.total} 个${classLabel(cls)}是 ${spec.value}，本元素 ${actual}，**模块里没有第二个这么写的**${selfInBaseline ? '（本元素自己也在基线样本里，已从计数中扣除——不许自己给自己作证）' : ''}`,
      })
    }
  }
  // 「模块里没别人这么写」的排前面，其次按同类样本量（越多越有说服力）
  deviations.sort((a, b2) => (a.alsoSeen - b2.alsoSeen) || (b2.total - a.total))
  return { available: true, why: '', deviations, checked, sampleCount: baseline.sampleCount }
}

// ---------- ② 设计系统量化指标（审美的可测代理） ----------
// 四项，都能解释自己、都不需要品味：
//   · 刻度外值：尺寸没落在模块刻度上（模块用 4/8/12/16，这里冒出个 6）
//   · 字号/圆角用量：本页种类数比模块常用集合多多少（"字号种类爆掉"是最常见的廉价感来源）
//   · 对齐：同一视觉行（y 相近）的元素上边缘不齐
//   · 色彩用量：本页文字/背景色种类数
export const ALIGN_TOLERANCE_PX = 2
export const ROW_BAND_PX = 12
export function designConformance(items = [], baseline = null) {
  const obs = flattenObservations(items)
  const offScale = []
  if (baseline?.scales) {
    for (const o of obs) {
      for (const t of SCALE_TOKENS) {
        const v = norm(o.tokens?.[t])
        if (v == null || v === 0) continue
        const sc = baseline.scales[t]
        if (!sc || !sc.scale.length) continue
        if (!sc.scale.includes(v)) offScale.push({ selector: o.selector, token: t, actual: v, scale: sc.scale, why: `${t}=${v} 不在模块刻度 [${sc.scale.join(', ')}] 上` })
      }
    }
  }
  const variety = {}
  for (const t of ['fontSize', 'borderRadius', 'fontWeight', 'color', 'backgroundColor']) {
    const here = new Set(obs.map(o => norm(o.tokens?.[t])).filter(v => v != null))
    const moduleSet = new Set((baseline?.scales?.[t]?.values || baseline?.colors?.[t] || []).map(v => v.value))
    variety[t] = { here: here.size, values: [...here], moduleKnown: moduleSet.size, unknown: [...here].filter(v => moduleSet.size && !moduleSet.has(v)) }
  }
  // 对齐：把有 box 的元素按 y 分行，同行内 y 不一致即报
  const boxed = obs.filter(o => o.box && Number.isFinite(o.box.y))
  const rows = []
  for (const o of boxed.slice().sort((a, b2) => a.box.y - b2.box.y)) {
    const row = rows.find(r => Math.abs(r.y - o.box.y) <= ROW_BAND_PX)
    if (row) { row.items.push(o); row.y = Math.min(row.y, o.box.y) } else rows.push({ y: o.box.y, items: [o] })
  }
  const misaligned = []
  for (const r of rows) {
    if (r.items.length < 2) continue
    const ys = r.items.map(o => o.box.y)
    const spread = Math.max(...ys) - Math.min(...ys)
    if (spread > ALIGN_TOLERANCE_PX) misaligned.push({ y: r.y, spread, selectors: r.items.map(o => o.selector), why: `同一视觉行的 ${r.items.length} 个元素上边缘差 ${spread}px（> ${ALIGN_TOLERANCE_PX}px 容差）` })
  }
  const score = { offScale: offScale.length, misaligned: misaligned.length, unknownValues: Object.values(variety).reduce((n, v) => n + v.unknown.length, 0) }
  return { available: !!baseline, checked: obs.length, offScale, variety, misaligned, score, why: baseline ? '' : '没有模块基线，刻度/用量类指标算不了（对齐仍可算）' }
}

// ---------- ③ 审美判定：rubric + 证据强制 ----------
// rubric 取自「示例项目这套页面的设计语言」，逐条都要求指认元素——不是让人写读后感。
export const AESTHETIC_RUBRIC = [
  { key: 'hierarchy', label: '信息层级', ask: '主/次/弱三层是否分得开？该弱的（辅助说明、时间戳）有没有和正文抢注意力？该强的（页面主操作、关键数字）有没有被淹？' },
  { key: 'family', label: '同族相似度', ask: '这一屏放进示例项目其它看板中间，像不像一家人？哪个元素一眼看出是"外来的"（圆角/字号/间距/控件高度与隔壁不同款）？' },
  { key: 'rhythm', label: '间距节奏', ask: '相邻块之间的留白是否成规律（同级同距、层级差异靠留白表达）？有没有"挤在一起"或"莫名一大片空"？' },
  { key: 'alignment', label: '对齐与网格', ask: '标签、控件、按钮是否共用同一条基线/网格？有没有差几像素的错位？' },
  { key: 'density', label: '密度与可读', ask: '一屏信息量是否过载？表格列宽、行高、字号组合读起来累不累？' },
  { key: 'color', label: '色彩与语义', ask: '颜色是否只用于表达语义（主操作/危险/成功/禁用）而非装饰？同一语义在本页与模块其它页是否同色？' },
  { key: 'state', label: '状态可辨', ask: 'disabled / hover / 选中 / 加载 是否一眼可辨且与模块其它页一致？' },
  { key: 'copy-fit', label: '文案与容器', ask: '文字与容器是否合身（不挤、不截断、不换行成两行破坏对齐）？最长文案下还成立吗？' },
]
export const AESTHETIC_VERDICTS = { OK: '符合模块设计语言', DIFF: '可接受但有偏离', BAD: '明显不协调' }

// 审美结论的机器校验：**每条 finding 必须挂一条可指认的机器事实**。
// 允许的证据形态：① 素材里真实存在的 selector；② 该 selector 上真实存在的 token 值；
// ③ ①②里没有、但来自量化偏离清单（offScale / deviations / misaligned）的条目。
// 挂不上的一律 rejected，不进结论——这是 ③ 与「读后感」的唯一分界线。
export function validateAestheticVerdict({ verdict = '', findings = [] } = {}, { items = [], deviations = [], offScale = [], misaligned = [] } = {}) {
  const obs = flattenObservations(items)
  const known = new Set(obs.map(o => o.selector))
  const knownIds = new Set(obs.map(o => testIdOf(o.selector)).filter(Boolean))
  const quantified = new Set([
    ...deviations.map(d => `${d.selector}|${d.token}`),
    ...offScale.map(d => `${d.selector}|${d.token}`),
    ...misaligned.flatMap(m => m.selectors.map(s => `${s}|align`)),
  ])
  const errors = [], accepted = [], rejected = []
  if (!Object.values(AESTHETIC_VERDICTS).includes(String(verdict))) errors.push(`verdict 必须是三档之一：${Object.values(AESTHETIC_VERDICTS).join(' / ')}`)
  for (const f of (Array.isArray(findings) ? findings : [])) {
    const sel = String(f?.selector || '')
    const id = testIdOf(sel) || sel
    const hasEl = known.has(sel) || knownIds.has(id)
    const hasQuant = f?.token ? quantified.has(`${sel}|${f.token}`) : false
    const hasFact = !!String(f?.fact || '').trim()
    if (!f?.rubricKey || !AESTHETIC_RUBRIC.some(r => r.key === f.rubricKey)) { rejected.push({ ...f, reason: `rubricKey 不在 rubric 里（${AESTHETIC_RUBRIC.map(r => r.key).join('/')}）` }); continue }
    if (!hasEl) { rejected.push({ ...f, reason: `指认的元素 \`${sel || '(空)'}\` 不在本轮素材里——审美意见必须落在真实采到的元素上，不许凭印象` }); continue }
    if (!hasFact && !hasQuant) { rejected.push({ ...f, reason: '既没引用该元素上的实测值（fact），也没对应任何量化偏离条目——这是读后感不是判定' }); continue }
    if (!String(f?.suggestion || '').trim()) { rejected.push({ ...f, reason: '没给可执行建议（说了不好看却没说怎么改，开发无法动手）' }); continue }
    accepted.push(f)
  }
  if (String(verdict) !== AESTHETIC_VERDICTS.OK && !accepted.length) errors.push('判了非「符合」档，却没有一条通得过证据校验的 finding——不许无证据打回')
  return { ok: errors.length === 0 && !rejected.length, errors, accepted, rejected }
}

// 看图门 + 逐维作答（2026-10-06 老板定）：堵「符合模块设计语言 + findings:[]」的盖章式结论。
// 实账：09-18~09-21 七次审美判定全是「符合、零发现」，每次素材列了 12 张图、她只 Read 了 1~4 张。
// 「符合」本身可以是对的结论，但必须是**看够了图、八个维度逐条看过**之后的结论——这两件机器都能核：
//   · listedShots = aesthetic_review 本轮发给她的截图清单；readShots = 工具流里真被 Read 过的图（引擎记账）；
//   · observations = { rubricKey: 看到了什么 }，八维都要有一句具体观察（空话/过短都算没写）。
// 要求看的张数：清单 ≤ 3 张全看；更多则至少一半（12 张 → 6 张）。参照截图（母版）有就至少看一张。
export const minShotsToView = n => Math.min(n, Math.max(3, Math.ceil(n / 2)))
const normPath = p => { let s = String(p || '').trim().replace(/\\/g, '/'); const m = s.match(/^\/([a-zA-Z])\/(.*)$/); if (m) s = `${m[1]}:/${m[2]}`; return s.toLowerCase() }
const HOLLOW_OBS = /^(无|没有|无问题|没问题|正常|符合|一致|ok|good|pass|通过|良好|-|—)[。.!！]?$/i
export function checkAestheticDiligence({ observations = {} } = {}, { listedShots = [], referenceShots = [], readShots = [] } = {}) {
  const errors = []
  const read = new Set([...(readShots || [])].map(normPath))
  const listed = [...new Set((listedShots || []).map(normPath))]
  const need = minShotsToView(listed.length)
  const seen = listed.filter(s => read.has(s)).length
  if (listed.length && seen < need) errors.push(`本轮素材列了 ${listed.length} 张截图，你只 Read 了 ${seen} 张（至少要看 ${need} 张）——没看够图就出的结论是盖章，不是判定`)
  const refs = (referenceShots || []).map(normPath)
  if (refs.length && !refs.some(r => read.has(r))) errors.push('给了母版参照截图，但一张都没 Read——没对照母版，「同族相似度」就是空判')
  const obs = observations && typeof observations === 'object' ? observations : {}
  const missing = AESTHETIC_RUBRIC.filter(r => { const t = String(obs[r.key] || '').trim(); return !t || t.length < 6 || HOLLOW_OBS.test(t) }).map(r => r.label)
  if (missing.length) errors.push(`${missing.length} 个维度没写出看到了什么：${missing.join('、')}——每维一句具体观察（如「主按钮在右上、与母版同位」），「无/正常/符合」这类空话不算`)
  return { ok: !errors.length, errors, seen, need, listed: listed.length }
}

// ---------- 渲染 ----------
export function renderBaselineSummary(b) {
  const L = [`### 示例项目 模块设计基线（v${b.baselineVersion}）`, '']
  L.push(`采样 **${b.sampleCount}** 个元素${b.pages.length ? `，覆盖 ${b.pages.length} 个页面` : ''}${b.viewport ? `，viewport ${b.viewport.width}×${b.viewport.height}` : ''}`)
  L.push('')
  L.push('| 元素类 | 样本 | 规范值（模块多数） |')
  L.push('|--------|------|------------------|')
  for (const [cls, v] of Object.entries(b.byClass)) {
    const top = Object.entries(v.tokens || {}).filter(([, s]) => s.share < 1 || s.total > 1).slice(0, 4)
      .map(([t, s]) => `${t}=${s.value}（${s.count}/${s.total}）`).join('，')
    L.push(`| ${v.label} | ${v.n} | ${top || '—'} |`)
  }
  L.push('')
  for (const [t, s] of Object.entries(b.scales || {})) if (s.scale.length) L.push(`- **${t} 模块刻度**：${s.scale.join(' / ')}${s.values.length > s.scale.length ? `（另有 ${s.values.length - s.scale.length} 个只出现一次的值）` : ''}`)
  L.push('')
  L.push(`> ${b.note}`)
  return L.join('\n')
}
export function renderBaselineJudgement(j, conf = null) {
  const L = ['### 与模块设计基线的一致性（①·可测）', '']
  if (!j.available) return L.concat([`⚠ **判不了**：${j.why}`]).join('\n')
  if (!j.deviations.length) return L.concat([`✅ 检查 ${j.checked} 项 token，与模块基线（${j.sampleCount} 个样本）一致，没有偏离。`]).join('\n')
  L.push(`检查 ${j.checked} 项 token，**${j.deviations.length} 处偏离模块规范**：`)
  L.push('')
  for (const d of j.deviations.slice(0, 25)) {
    const flag = d.alsoSeen ? '·' : '⚠'
    L.push(`- ${flag} \`${testIdOf(d.selector) || d.selector}\`（${d.clsLabel}）**${d.token}**：${d.why}${d.confidence === 'low' ? ' 〔该类样本不足，当线索用〕' : ''}`)
  }
  L.push('')
  L.push('> ⚠＝模块里没有第二个这么写的（最该改）；·＝模块内并存两套写法（值得统一，不一定是错）。**判据是数出来的多数，不是我定的阈值。**')
  if (conf && conf.level === 'low') L.push(`> ⚠ ${conf.why}`)
  return L.join('\n')
}
export function renderConformance(c) {
  const L = ['### 设计系统量化指标（②·审美的可测代理）', '']
  if (!c.available && !c.misaligned.length) return L.concat([`⚠ ${c.why}`]).join('\n')
  L.push(`- **刻度外值**：${c.offScale.length} 处${c.offScale.length ? '' : '（尺寸都落在模块刻度上）'}`)
  for (const o of c.offScale.slice(0, 12)) L.push(`  - \`${testIdOf(o.selector) || o.selector}\` ${o.why}`)
  L.push(`- **对齐**：${c.misaligned.length} 处错位${c.misaligned.length ? '' : '（同行元素上边缘一致）'}`)
  for (const m of c.misaligned.slice(0, 8)) L.push(`  - ${m.why}：${m.selectors.map(s => testIdOf(s) || s).join(' / ')}`)
  const v = c.variety || {}
  L.push(`- **用量**：字号 ${v.fontSize?.here ?? '?'} 种、圆角 ${v.borderRadius?.here ?? '?'} 种、字重 ${v.fontWeight?.here ?? '?'} 种、文字色 ${v.color?.here ?? '?'} 种、背景色 ${v.backgroundColor?.here ?? '?'} 种`)
  const unknown = Object.entries(v).flatMap(([t, x]) => (x.unknown || []).map(u => `${t}=${u}`))
  if (unknown.length) L.push(`  - 模块里从未出现过的值：${unknown.slice(0, 10).join('，')}`)
  L.push('')
  L.push('> 这一节不需要品味也能算：**「用了 7 种字号而模块只有 3 种」是廉价感最常见的来源**，但它是数出来的。')
  return L.join('\n')
}
export function renderAestheticMaterial({ rubric = AESTHETIC_RUBRIC, screenshots = [], referenceShots = [], deviations = [], offScale = [], misaligned = [] } = {}) {
  const L = ['### 审美判定素材（③·你要看图，然后按 rubric 出结论）', '']
  L.push('**本轮截图**'); for (const s of screenshots.slice(0, 12)) L.push(`- ${s}`)
  if (referenceShots.length) { L.push(''); L.push('**模块参照截图（示例项目其它页面，"像不像一家人"的比较对象）**'); for (const s of referenceShots.slice(0, 12)) L.push(`- ${s}`) }
  L.push('')
  L.push(`**机器已算出的偏离（你的意见可以直接引用它们当证据）**：模块基线偏离 ${deviations.length} 处、刻度外值 ${offScale.length} 处、对齐错位 ${misaligned.length} 处`)
  L.push('')
  L.push('**rubric（逐条看，逐条答）**')
  for (const r of rubric) L.push(`- **${r.label}**（\`${r.key}\`）：${r.ask}`)
  L.push('')
  L.push('**提交要求（`aesthetic_verdict`，缺一条就打回）**：① `verdict` 三档之一；② 每条 finding 带 `rubricKey` + `selector`（必须是本轮素材里真实存在的元素）+ `fact`（该元素上的实测值或引用的量化偏离）+ `suggestion`（可执行建议）。**说不好看但指不出元素、给不出改法的，一律不算判定。** ③ `observations` 八维逐条写看到了什么（判「符合」也要写）。④ **看图门**：上面列的截图至少看一半（≤3 张全看），有母版参照至少看一张——引擎从工具流核你真 Read 了哪些图。')
  L.push('> 边界：这一节是**判断不是测量**，老板是终审、可一票否决；但你必须先出意见——「审美归老板」不是收工理由。')
  return L.join('\n')
}
export function renderAestheticVerdict(v, val) {
  const L = ['### 审美判定结论（③）', '']
  L.push(`结论：**${v.verdict}**`)
  if (val.accepted.length) {
    L.push(''); L.push('**发现（每条都挂着机器事实）**')
    for (const f of val.accepted) {
      const r = AESTHETIC_RUBRIC.find(x => x.key === f.rubricKey)
      L.push(`- [${r?.label || f.rubricKey}] \`${testIdOf(f.selector) || f.selector}\`：${f.fact}${f.opinion ? ` —— ${f.opinion}` : ''}`)
      L.push(`  → 建议：${f.suggestion}`)
    }
  }
  if (val.rejected.length) {
    L.push(''); L.push(`**被机器打回 ${val.rejected.length} 条（无证据/无建议，不进结论）**`)
    for (const f of val.rejected) L.push(`- ${f.reason}${f.opinion ? `（原话：${String(f.opinion).slice(0, 60)}）` : ''}`)
  }
  if (val.errors.length) { L.push(''); for (const e of val.errors) L.push(`⛔ ${e}`) }
  L.push('')
  L.push('> 判断不是测量：老板终审、可一票否决。但每条都指到了元素与实测值，**可以直接照着改**。')
  return L.join('\n')
}
