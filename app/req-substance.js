// ============================================================================
// 需求实质闸（requirement_substance）—— 「登记的那一行，落到的 facet 真的包含它吗」
//
// 缘起（2026-09-09 项目跟踪 v0.1.0 第二轮，老板：「我要的效果是她自己能找到疏漏，
// 而不是我一直告诉她哪里有疏漏」）：
// 09-08 事故（38 条 facet 对 308 个原型单元）之后上了 req-trace.js 溯源闸，菲菲这一轮补到
// **facet 100 条 / 映射表 357 行 / 0 空行**，三道闸全绿。老板再读原型，还是当场点出「详情抽屉
// 的功能梳理完全没有」——复核结果：d0 的 185 个单元里抽屉占 **约 50 个**（原型自己划的区块
// 「抽屉：头与两个页签」等），承载它们的只有 `REQ-0339-F40` 一条 P0 facet，另有 16 行直接落进
// `REQ-0339-F75`「页面基础展示基线」这个桶；而 F75 的验收原文里既没有解释链、也没有 SKU 明细页签。
// 时间轴六种结论、「上游超期不会让下游也超期」、已达成读快照/未达成读实时——facet 表 0 命中。
//
// 根因不是她又漏读了：**溯源闸的判据是「每个单元有没有一行、那一行有没有填一个存在的 facet 号」**，
// 填 F75 就合规。于是"缩水"从"没登记"变形成"登记在一个空壳里"——账面 357/357 覆盖，可测性为零。
// 老板每次都得亲自读一遍原型才能发现，这活没被机制接住。
//
// 本模块补的是"实质"那一维，四道判据全部**机器可判、不做语义相似度**（相似度实测 140/338 误报，
// 会被学会忽略，比没有更糟）：
//   ① 扇入上限 fanIn         —— 一条 facet 吸收了多少个源单元。F75=33、F29=40 当场现形。
//                               「存在性/回归类」facet（分类列含 存在性/纯展示/present）另给高额度：
//                               「现网 16 列原样保留」天然是一条聚合断言，拆开反而是噪音。
//   ② 阈值回落 threshold     —— PRD 原文里每个数值阈值（≤200字/10张/2MB/365天/到仓11天…），
//                               facet 表里搜不到就点名。实测 53 个阈值 → 25 个没落，其中
//                               「预告风险上界 365 天」「到仓目标 11 天」「缩略图 3 张」是真缺。
//   ③ 开放项台账 openItems   —— 把 PRD 自标的 ⏳ 全部抽出来建台账，每条只能三种终态：
//                               resolved（写决议出处）/ open（进拍板清单）/ dropped（写理由）。
//                               **不允许消失**。实测抽出 47 条，老板手工找到的每一条都在里面
//                               （轮次维 d1#a_submitall / 照片必填 d1#i_photo / 我方档位 d0#fwReason /
//                               单命中主标记 d0#grp7 / 已发货摊回 d0#skuShipped）——这道闸单独就够她自查。
//                               09-08 那份《PRD遗漏与返工清单》里写过"轮次维"，09-09 拍板清单里就没了：
//                               没有台账，开放项会在两轮之间静默蒸发。
//   ④ 区块配额 sectionQuota  —— 按原型自己的区块注释（`/* ==== 抽屉：头与两个页签 ==== */`）
//                               分组算 units:facet 比。抽屉那种「50 个单元 1 条 facet」不用人去数。
//
// 与另三道闸的分工（四个分母，别混）：
//   coverage      分母=facet 表      —— 登记的 facet 有没有被真测
//   req-trace     分母=源材料单元    —— 材料里的单元有没有都登记
//   feature-tree  分母=功能叶子      —— 功能拆到叶子了吗、四要素齐吗
//   本模块        分母=单元里的判据  —— 登记到的那条 facet 有没有真的把这个单元的判据写进去
//
// 硬/软分档：① ③ 硬挡（客观、无歧义、当场可补）；② ④ 出「点名清单」软提示——它们有约 30% 的
// 已知噪声（现网既有值、PRD 里的举例数字、聚合断言），硬挡会逼她跟闸门吵架而不是读 PRD。
// 点名清单的价值不在判决，在于**把"你自己去找"变成一张 20 分钟能清完的具体单子**。
//
// 向后兼容：SUBSTANCE_GATE_SINCE 之前创建的档案只软提示（在研版本不被新闸当场卡死）。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'

// 本闸门对「这一天及以后创建的任务档案」硬生效；之前的只软提示。
export const SUBSTANCE_GATE_SINCE = '2026-09-10'

// 一条 facet 最多吸收多少个源单元。超了不是"她偷懒"，是**这条 facet 太粗、测不动**：
// 6 个单元的判据挤进一条验收标准，迷糊只能挑一个测，剩下 5 个在账面上是绿的。
export const FANIN_CAP = 6
// 存在性/回归类 facet 的额度（「现网 13 筛选/16 列/6 行操作原样保留」= 一条 present 断言吃几十个单元，
// 这是对的：它们不是本版要实现的行为，是"别弄坏"的回归面）。
export const FANIN_CAP_PRESENCE = 60
// 区块 units:facet 比的告警线（一个区块平均 8 个单元才换来 1 条 facet ⇒ 这块几乎没被拆开）
export const SECTION_RATIO_CAP = 8

export const SUBSTANCE_HINT =
  '实质闸要一份东西（任务档案 frontmatter）：\n' +
  '  · open_items_doc —— 《源材料开放项台账》路径，表头含「开放项 ID」「终态」两列。\n' +
  '    跑 `scan_open_items` 让引擎把源材料里所有 ⏳ 抽出来（带稳定 ID，形如 `d1#a_submitall⏳1`），\n' +
  '    逐条给终态：`已决`（决议列写口径 + 出处，如「老板 2026-09-09 定 K：自然日 24:00」）／\n' +
  '    `待拍`（决议列写它在哪份拍板清单的第几条）／`不做`（决议列写理由）。**一条都不许缺行。**\n' +
  '  其余三道判据不用你写文档，引擎自己算：facet 扇入、PRD 数值阈值回落、区块 units:facet 配额。\n' +
  '  模板：templates/pm-源材料开放项台账.md；规矩见 roles/feifei.md「源材料清点与溯源」。'

const _rc = line => { const c = line.split('|').map(x => x.trim()); c.shift(); if (c[c.length - 1] === '') c.pop(); return c }
const _isSep = line => /^[-:\s]+$/.test(line.replace(/\|/g, ''))

// ---------------------------------------------------------------------------
// 扫描器：把原型的 LOGIC 注册表切成「单元原文」，再从原文里抽三样东西
// ---------------------------------------------------------------------------
// 为什么按 key 切片而不解析 JS：老板 4 页原型的注册表有四种写法（d0/d3 是 `key:{no:N,type:'…'}`
// 对象字面量，d1 是 `key:fld(1,'…','…')` 位置参数助手，d2 是 `key:dp(act(1,…),[[…]])` 嵌套助手）。
// 解析器要认全四种、还得跟着老板下次换写法一起改；按「下一个顶层 key 出现处」切片对四种都无损，
// 拿到的是那个单元的**全部原文**——判据就在原文里，不需要理解结构。
const UNIT_KEY_RE = /(?:^|\n)[ \t]*([A-Za-z_]\w*)[ \t]*:[ \t]*(\{|dp\(|fld\(|act\(|inp\(|sta\(|pg\()/g
// 区块横幅：`/* ======== 抽屉：头与两个页签 ======== */`。原型作者自己划的功能分区，
// 比任何我们外部强加的分类都准——它就是"这一屏有哪几块"的作者原意。
const SECTION_RE = /\/\*[\s=\-]*([^*]*?)[\s=\-]*\*\//g

// 数值阈值：`≤200 字` / `最多 10 张` / `2MB` / `1–365 天`。
// 只收「数字 + 量词」与「比较符 + 数字」两种形态：光秃秃的数字（编号、序号、举例里的 5）没有判据含量。
const THRESHOLD_RE = /(≤|≥|<|>|＜|＞)?\s?(\d+(?:\.\d+)?)\s?(小时|天|张|字|家|件|条|次|页|个|MB|%)/g
// PRD 自标的开放项：⏳ 后面跟「待确认/待拍/待定/未定…」。
const OPEN_RE = /⏳\s*(?:<b>)?\s*(?:待确认|待拍板?|待定|待业务确认|待\s?PM\s?拍|尚未拍板|未定|待老板拍?)/g

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
// facet 文本侧的归一化：她写「两个页签」「三档」，PRD 写「2 个」「3 档」——不归一会把中文数字全判成"没落"。
const expandCn = s => String(s).replace(/[一二两三四五六七八九十](?=[个条张页天字家件次组档种步轮])/g, c => String(CN_NUM[c]))
export const normNum = s => String(s).replace(/\s/g, '').replace(/＜/g, '<').replace(/＞/g, '>').replace(/<=/g, '≤').replace(/>=/g, '≥').replace(/(\d)h\b/gi, '$1小时')

const stripDeco = s => String(s).replace(/<\/?[a-z]+>/gi, '').replace(/[🔴🔵➖⏳🆕🕒🟡✅⚙️👆★📷📋📅⚠]/g, '').replace(/\s+/g, ' ').trim()

// ⏳ 摘要：从标记处向后取一句。JS 源码里一句话的结束可能是 `。`、`；`，也可能是字符串字面量的
// 收尾（`'], [`、`']]`、`', '`）——不切会把后面的 JS 语法一起抄进台账，那种摘要没人读得下去。
function openSnippet(raw) {
  let t = stripDeco(raw).replace(/^(?:待确认|待拍板?|待定|待业务确认|待\s?PM\s?拍|尚未拍板|未定|待老板拍?)\s*[（(]?\s*[:：·—-]*\s*/, '')
  const cuts = [t.indexOf("'],"), t.indexOf("']]"), t.indexOf("', '"), t.indexOf('。'), t.indexOf('；')].filter(i => i > 0)
  if (cuts.length) t = t.slice(0, Math.min(...cuts))
  return t.replace(/^[。；，、）)'"\][\s—-]+/, '').replace(/['"\],[\s]+$/, '').trim().slice(0, 120)
}

// 从一段 HTML/JS 源码里切出全部单元（含区块归属、阈值、开放项）
export function extractUnits(source) {
  const text = String(source || '')
  const m = text.match(/\n\s*var\s+LOGIC\s*=\s*\{/)
  if (!m) return { units: [], sections: [], note: '没找到 `var LOGIC={…}` 注册表——这份材料的单元原文抽不出来，实质闸的②③④三道判据对它不生效（①扇入仍生效）' }
  const start = m.index + m[0].length
  const rel = text.slice(start).search(/\n\};/)
  const body = text.slice(start, rel < 0 ? text.length : start + rel)

  const keys = []
  UNIT_KEY_RE.lastIndex = 0
  let k
  while ((k = UNIT_KEY_RE.exec(body))) keys.push({ key: k[1], at: k.index })
  const secs = []
  SECTION_RE.lastIndex = 0
  let s
  while ((s = SECTION_RE.exec(body))) {
    const name = s[1].replace(/[=\-★\s]+$/g, '').replace(/^[=\-★\s]+/g, '').trim()
    if (name && !/^[\d\s]*$/.test(name)) secs.push({ at: s.index, name })
  }

  const units = keys.map((h, i) => {
    const raw = body.slice(h.at, i + 1 < keys.length ? keys[i + 1].at : body.length)
    // `no:` 在对象字面量里是 `no:101`，在助手调用里是第一个位置参数 `fld(1,…)`
    const noM = raw.match(/\bno\s*:\s*(\d+)/) || raw.match(/^\s*\w+\s*:\s*(?:dp\()?(?:fld|act|inp|sta|pg)\(\s*(\d+)/)
    let section = ''
    for (const x of secs) if (x.at < h.at) section = x.name

    const thresholds = []
    const seenTh = new Set()
    THRESHOLD_RE.lastIndex = 0
    for (const t of raw.matchAll(THRESHOLD_RE)) {
      const cmp = t[1] ? normNum(t[1]) : '', num = t[2], unit = t[3]
      if (Number(num) < 2 && !cmp) continue                 // 「1 个」这类没有判据含量
      const id = cmp + num + unit
      if (seenTh.has(id)) continue
      seenTh.add(id)
      thresholds.push({ id, cmp, num, unit })
    }

    const openItems = []
    const seenOpen = []
    OPEN_RE.lastIndex = 0
    for (const o of raw.matchAll(OPEN_RE)) {
      const snip = openSnippet(raw.slice(o.index + 1, o.index + 320))
      if (snip.replace(/\s/g, '').length < 5) continue
      // 同单元内去重：标题行的「（⏳待确认 是否显倒计时）」与 deep 段里那条长的是同一问，
      // 台账里出现两次只会让她多花时间对齐"这两条是不是一回事"。
      const head = snip.slice(0, 16)
      if (seenOpen.some(x => x.includes(head) || snip.includes(x.slice(0, 16)))) continue
      seenOpen.push(snip)
      openItems.push({ seq: openItems.length + 1, text: snip })
    }
    return { key: h.key, no: noM ? String(noM[1] || noM[2]) : '', section, chars: raw.length, thresholds, openItems }
  })
  return { units, sections: [...new Set(units.map(u => u.section).filter(Boolean))], note: '' }
}

// 扫一份源材料（支持 `路径#片段`：老板 4 页原型是 base64 内嵌在一个 HTML 里的 `<script id="doc-d0">`）
export function scanSubstance(abs, { fragment = '', maxBytes = 8 * 1024 * 1024 } = {}) {
  const ext = path.extname(String(abs || '')).toLowerCase()
  const out = { path: abs, fragment, kind: 'unknown', units: [], sections: [], note: '' }
  const st = fs.statSync(abs)
  if (st.size > maxBytes) return { ...out, note: `文件 ${st.size} 字节超过扫描上限 ${maxBytes}` }
  if (!/^\.html?$/.test(ext)) return { ...out, kind: ext.slice(1) || 'unknown', note: `实质闸的单元原文抽取只支持带 LOGIC 注册表的原型 HTML（本文件是 ${ext || '无扩展名'}）——其余材料只走①扇入判据` }
  const text = fs.readFileSync(abs, 'utf8')
  let source = text
  if (fragment) {
    const re = new RegExp('<script[^>]*id="' + fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>([\\s\\S]*?)</script>')
    const m = text.match(re)
    if (!m) return { ...out, kind: 'prototype-html', note: `材料声明了片段 #${fragment}，但文件里找不到 <script id="${fragment}">` }
    const bodyRaw = m[1].trim()
    // 片段可能是 base64 内嵌页，也可能是普通内联脚本。判据不用长度阈值（阈值定多少都是猜），
    // 而是「解出来像不像一份文档」：base64 字符集 + 解码后含 html/LOGIC 标志才认，否则按原文用。
    source = bodyRaw
    if (bodyRaw.length >= 200 && /^[A-Za-z0-9+/=\s]+$/.test(bodyRaw)) {
      try {
        const decoded = Buffer.from(bodyRaw, 'base64').toString('utf8')
        if (/<html|<body|<div|var\s+LOGIC/i.test(decoded)) source = decoded
      } catch { /* 解不开就按原文用，不报错——片段本来就允许是普通脚本 */ }
    }
  }
  const ex = extractUnits(source)
  return { ...out, kind: 'prototype-html', units: ex.units, sections: ex.sections, note: ex.note }
}

// ---------------------------------------------------------------------------
// 开放项台账：open_items_doc 里表头含「开放项 ID」+「终态」的那张表
// ---------------------------------------------------------------------------
export const OPEN_STATES = ['已决', '待拍', '不做']
const OPEN_STATE_ALIAS = [
  [/^(已决|已定|已拍|resolved|closed|决了)/i, '已决'],
  [/^(待拍|待定|待确认|open|pending|待老板)/i, '待拍'],
  [/^(不做|本版不做|dropped|范围外|二期|后续)/i, '不做'],
]
export const normalizeOpenState = v => {
  const s = String(v || '').replace(/\*\*/g, '').trim()
  if (!s) return ''
  for (const [re, to] of OPEN_STATE_ALIAS) if (re.test(s)) return to
  return ''
}

export function extractLedgerRows(docText) {
  const out = []
  if (!docText) return out
  let header = null
  for (const raw of String(docText).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) { header = null; continue }
    const cells = _rc(line)
    if (!header) {
      const flat = cells.map(c => c.replace(/\*\*/g, ''))
      if (flat.some(c => /开放项|open.?item|⏳/i.test(c)) && flat.some(c => /终态|状态|state/i.test(c))) header = flat
      continue
    }
    if (_isSep(line)) continue
    const col = (...names) => { for (const n of names) { const i = header.findIndex(h => h.replace(/\*\*/g, '').toLowerCase().startsWith(String(n).toLowerCase())); if (i >= 0) return (cells[i] || '').replace(/\*\*/g, '').trim() } return '' }
    const id = col('开放项', 'open', 'id', '⏳')
    if (!id || /^[-—–]+$/.test(id)) continue
    out.push({
      id: id.replace(/\s/g, ''),
      state: normalizeOpenState(col('终态', '状态', 'state')),
      stateRaw: col('终态', '状态', 'state'),
      resolution: col('决议', '去向', '结论', '出处', '理由'),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 四道判据
// ---------------------------------------------------------------------------
const isPresenceFacet = f => /存在性|纯展示|presence|仅渲染|仅展示|回归/.test(String(f?.kind || '') + ' ' + String(f?.criterion || '').slice(0, 40))

// ①b 孤儿 facet：立了，但映射表里没有任何源单元指向它
//
// 缘起（2026-09-09 第二跑，实测抓到 34 条）：菲菲被要求重读 PRD 后把 facet 从 99 补到 129——
// **但溯源映射表一行没改**。于是那 30 条新 facet 在映射表里没有任何源单元指向它，而抽屉那 15 个
// 单元至今仍记在 `F75` 名下。两处账不一致的代价是真实的：**迷糊测什么、GG Bond 做什么，读的是映射表**，
// 于是"新登的 facet"与"单元由谁承载"分成两套事实，而 ① 扇入判据看的也是映射表——不补这一条，
// 「补了 facet 但没回填映射」这个状态会一路绿过去（它甚至会让 ①④ 的数字永远停在旧值，看起来像没改进）。
//
// 反向那一半引擎早就有（映射表指向不存在的 facet → computeTrace 报 error），本条补的是正向的对称位。
// 豁免：缺陷单壳号 facet（`REQ-9NNN-Fn`）来自缺陷单而非源材料，天然不在映射表里。
export const SHELL_REQ_RE = /^REQ-9\d{3}-F\d+$/i
export function computeOrphanFacets({ rows = [], facets = [] } = {}) {
  const mapped = new Set()
  for (const r of rows) if (r.disposition === '立需求') for (const f of r.facets || []) mapped.add(String(f).toUpperCase())
  const orphans = (facets || [])
    .filter(f => !SHELL_REQ_RE.test(String(f.id)))
    .filter(f => !mapped.has(String(f.id).toUpperCase()))
    .map(f => ({ id: String(f.id).toUpperCase(), criterion: String(f.criterion || '').slice(0, 56) }))
  return { orphans, facetTotal: (facets || []).length, mappedTotal: mapped.size }
}

// ① 扇入：一条 facet 吸收了多少源单元
export function computeFanIn({ rows = [], facets = [], cap = FANIN_CAP, presenceCap = FANIN_CAP_PRESENCE } = {}) {
  const byFacet = new Map()
  for (const r of rows) {
    if (r.disposition !== '立需求') continue
    for (const f of r.facets || []) {
      if (!byFacet.has(f)) byFacet.set(f, [])
      byFacet.get(f).push(r.unit)
    }
  }
  const meta = new Map((facets || []).map(f => [String(f.id).toUpperCase(), f]))
  const over = []
  for (const [id, units] of byFacet) {
    const f = meta.get(id)
    const limit = isPresenceFacet(f) ? presenceCap : cap
    if (units.length > limit) over.push({ facet: id, count: units.length, limit, presence: isPresenceFacet(f), units: units.slice(0, 12), criterion: String(f?.criterion || '').slice(0, 60) })
  }
  over.sort((a, b) => b.count - a.count)
  return { over, facetCount: byFacet.size, max: over[0]?.count || 0 }
}

// ② 阈值回落：PRD 原文里的数值阈值，facet 表搜不到就点名
// 只在「本版要实现的行为」上点名：`unitScope` 给出每个单元的处置与断言类，凡某阈值的全部来源单元
// 都是「本版不做」或只落在存在性/回归类 facet 上（现网筛选框 maxLength=100 字、分页 20 条/页、
// 样衣 32 小时…），就不点名——那些数字本来就不该出现在本版的验收标准里，点了是纯噪音。
export function computeThresholdLanding({ units = [], facetText = '', unitScope = new Map() } = {}) {
  const hay = normNum(expandCn(facetText))
  const all = new Map()
  for (const u of units) for (const t of u.thresholds || []) {
    if (!all.has(t.id)) all.set(t.id, { ...t, units: [], inScope: false })
    const rec = all.get(t.id)
    rec.units.push(u.ref || u.key)
    if (unitScope.size === 0 || unitScope.get(String(u.ref || u.key).toLowerCase()) === 'inScope') rec.inScope = true
  }
  for (const [id, t] of all) if (!t.inScope) all.delete(id)
  const landed = t => {
    if (t.cmp && hay.includes(t.cmp + t.num)) return true
    if (hay.includes(t.num + t.unit)) return true
    // 量词同义：PRD 写「13 个」，facet 写「13 筛选」；PRD 写「2 个页签」，facet 写「两页签」（已 expandCn）
    if ('个条次'.includes(t.unit)) return new RegExp(t.num + '(?:个|条|次|项|组|档|页签|环节|批次|张|种|步|轮|列|筛选|动作|分组)').test(hay)
    return false
  }
  const missing = [...all.values()].filter(t => !landed(t)).sort((a, b) => b.units.length - a.units.length)
  return { total: all.size, missing, missingCount: missing.length }
}

// ③ 开放项台账闭合
export function computeOpenItems({ units = [], ledgerRows = [], ledgerRel = '', ledgerMissing = false } = {}) {
  const errors = [], warnings = []
  const items = []
  for (const u of units) for (const o of u.openItems || []) items.push({ id: `${u.ref || u.key}⏳${o.seq}`, text: o.text, unit: u.ref || u.key })
  if (!items.length) return { items: [], errors, warnings, total: 0, missing: [], open: 0, resolved: 0, dropped: 0, active: false }

  if (!ledgerRel) { errors.push(`源材料里有 ${items.length} 条 PRD 自标的开放项（⏳），但缺 frontmatter.open_items_doc（开放项台账）——没有台账，开放项会在两轮梳理之间静默蒸发（2026-09-08 那份返工清单里写过的"唯一键要不要加轮次维"，09-09 的拍板清单里就没了）。` + SUBSTANCE_HINT); return { items, errors, warnings, total: items.length, missing: items, open: 0, resolved: 0, dropped: 0, active: true } }
  if (ledgerMissing) { errors.push(`open_items_doc 指向的文件找不到/读不到：${ledgerRel}`); return { items, errors, warnings, total: items.length, missing: items, open: 0, resolved: 0, dropped: 0, active: true } }

  const byId = new Map(ledgerRows.map(r => [r.id.toLowerCase(), r]))
  const missing = [], bad = []
  let open = 0, resolved = 0, dropped = 0
  for (const it of items) {
    const row = byId.get(it.id.toLowerCase())
    if (!row) { missing.push(it); continue }
    if (!row.state) { bad.push(`台账「${it.id}」终态「${row.stateRaw || '(空)'}」不合枚举（${OPEN_STATES.join(' / ')}）`); continue }
    if (row.state === '已决') { resolved++; if (row.resolution.replace(/\s/g, '').length < 4) bad.push(`台账「${it.id}」终态=已决 但决议列没写口径与出处——"已决"必须能追到是谁哪天怎么定的，否则和"我按默认猜的"分不开`) }
    else if (row.state === '待拍') { open++; if (row.resolution.replace(/\s/g, '').length < 2) bad.push(`台账「${it.id}」终态=待拍 但没写它在哪份拍板清单的第几条——待拍不落到清单上就是丢了`) }
    else { dropped++; if (row.resolution.replace(/\s/g, '').length < 4) bad.push(`台账「${it.id}」终态=不做 但没写理由——"不做"和"漏了"在账面上必须分得开`) }
  }
  errors.push(...bad)
  if (missing.length) errors.push(`开放项台账缺 ${missing.length} 条行（源材料共 ${items.length} 条 ⏳）：${missing.slice(0, 8).map(m => m.id).join('、')}${missing.length > 8 ? ' …' : ''}——跑 \`scan_open_items\` 拿全量清单，逐条给终态（已决/待拍/不做），一条都不许缺行`)
  const activeOpen = open
  return { items, errors, warnings, total: items.length, missing, open: activeOpen, resolved, dropped, active: true }
}

// ④ 区块配额：按原型自己的区块注释（作者原意的功能分块）算「专属 facet」
//
// 为什么不是简单的 units:facet 比（第一版这么写，对抽屉完全失灵）：抽屉横跨好几个区块，
// 而承载它的 F75/F40 又是跨区块的桶——`抽屉：头与两个页签 15 单元 : 6 facet = 2.5` 看着很健康。
// 改判「专属 facet」= 该 facet 的源单元 ≥80% 落在本区块。抽屉那 6 条一算，**专属 0**：
// 这一块的功能全靠跟顶栏/左栏/行卡片共用的条目兜着，没有一条 facet 是它自己的——这正是
// 老板肉眼读出来的那句「详情抽屉的功能梳理完全没有」，机器现在也能说出同一句。
//
// 专属 0 不一定是错（`⋯ 更多面板` 6 个单元全是通往别处动作的入口，专属 0 是对的），所以出
// 点名清单让她逐块给说法，不硬挡。
export const SECTION_OWN_MIN_UNITS = 5           // 少于这个单元数的小块不点名（噪音）
export const SECTION_OWN_RATIO = 0.8             // facet 的单元 ≥80% 落在本区块 ⇒ 算本区块专属

export function computeSectionQuota({ rows = [], unitIndex = new Map(), ratioCap = SECTION_RATIO_CAP } = {}) {
  const bySec = new Map()
  const facetSpread = new Map()                  // facet → Map(区块 → 该区块贡献的单元数)
  for (const r of rows) {
    if (r.disposition !== '立需求') continue
    const u = unitIndex.get(String(r.unit).toLowerCase().replace(/\s/g, ''))
    if (!u) continue
    const key = `${u.material}·${u.section || '(未分区)'}`
    if (!bySec.has(key)) bySec.set(key, { key, material: u.material, section: u.section || '(未分区)', units: 0, facets: new Set() })
    const b = bySec.get(key)
    b.units++
    for (const f of r.facets || []) {
      b.facets.add(f)
      if (!facetSpread.has(f)) facetSpread.set(f, new Map())
      const m = facetSpread.get(f)
      m.set(key, (m.get(key) || 0) + 1)
    }
  }
  const sections = [...bySec.values()].map(b => {
    let own = 0
    const ownIds = []
    for (const f of b.facets) {
      const m = facetSpread.get(f)
      const total = [...m.values()].reduce((a, c) => a + c, 0)
      if ((m.get(b.key) || 0) / total >= SECTION_OWN_RATIO) { own++; ownIds.push(f) }
    }
    return {
      key: b.key, material: b.material, section: b.section,
      units: b.units, facets: b.facets.size, own, ownIds,
      ratio: own ? +(b.units / own).toFixed(1) : b.units,
    }
  })
  // 排序把「无专属」放最前：它是本判据的头条（抽屉那一块就是这么被顶上来的），其次按粗细排
  sections.sort((a, b) => (b.own === 0 ? 1 : 0) - (a.own === 0 ? 1 : 0) || b.ratio - a.ratio || b.units - a.units)
  const orphan = sections.filter(s => s.units >= SECTION_OWN_MIN_UNITS && s.own === 0)
  const thin = sections.filter(s => s.own > 0 && s.units >= SECTION_OWN_MIN_UNITS && s.ratio > ratioCap)
  return { sections, orphan, thin }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
// 入参：
//   scans      [{ materialId, units:[…], sections:[…] }]  —— 每份材料一次 scanSubstance 的结果
//   rows       溯源映射表的行（req-trace.extractTraceRows）
//   facets     facet 全集（coverage.extractFacetsFromDoc，含 criterion/kind）
//   facetText  facet 文档全文（阈值回落在全文里搜——阈值落在哪条 facet 上不重要，落了就行）
//   ledgerRows 开放项台账的行
export function computeSubstance({ scans = [], rows = [], facets = [], facetText = '', ledgerRows = [], ledgerRel = '', ledgerMissing = false, createdOn = '' } = {}) {
  const errors = [], warnings = []
  const active = String(createdOn || '') >= SUBSTANCE_GATE_SINCE

  // 单元索引：溯源表里的源单元写法两种都要能寻址（`d0#xpLink` 按 key、`d1#19` 按 no）
  const unitIndex = new Map()
  const flatUnits = []
  for (const sc of scans) {
    const mid = String(sc.materialId || '').toLowerCase()
    for (const u of sc.units || []) {
      const rec = { ...u, material: mid, ref: `${mid}#${u.key}` }
      flatUnits.push(rec)
      unitIndex.set(`${mid}#${u.key}`.toLowerCase(), rec)
      if (u.no) unitIndex.set(`${mid}#${u.no}`.toLowerCase(), rec)
    }
  }

  // 每个单元的「本版范围」标位：阈值点名只在本版要实现的行为上做（见 computeThresholdLanding 注释）
  const facetMeta = new Map((facets || []).map(f => [String(f.id).toUpperCase(), f]))
  const unitScope = new Map()
  for (const r of rows) {
    const u = unitIndex.get(String(r.unit).toLowerCase().replace(/\s/g, ''))
    if (!u) continue
    const key = String(u.ref).toLowerCase()
    if (r.disposition !== '立需求') { if (!unitScope.has(key)) unitScope.set(key, 'outOfScope'); continue }
    const behavioural = (r.facets || []).some(f => !isPresenceFacet(facetMeta.get(f)))
    unitScope.set(key, behavioural ? 'inScope' : (unitScope.get(key) === 'inScope' ? 'inScope' : 'presenceOnly'))
  }

  const fanIn = computeFanIn({ rows, facets })
  const orphan = computeOrphanFacets({ rows, facets })
  const threshold = computeThresholdLanding({ units: flatUnits, facetText, unitScope })
  const openItems = computeOpenItems({ units: flatUnits, ledgerRows, ledgerRel, ledgerMissing })
  const quota = computeSectionQuota({ rows, unitIndex })

  // ① 硬：桶装 facet
  for (const o of fanIn.over) {
    errors.push(
      `facet ${o.facet} 一条吃掉 ${o.count} 个源单元（上限 ${o.limit}）——${o.count} 个单元的判据挤进一条验收标准，` +
      `迷糊只能挑一个测、剩下的在账面上是绿的。拆开：给这批单元里判据不同的各立一条 facet。\n` +
      `    验收原文：「${o.criterion}…」\n    被吸收的单元（前 12 个）：${o.units.join('、')}`)
  }
  // ①b 硬：孤儿 facet（补了 facet 却没回填映射表）
  if (flatUnits.length && orphan.orphans.length) {
    errors.push(
      `有 ${orphan.orphans.length} 条 facet 立了，但溯源映射表里**没有任何源单元指向它**（facet 全集 ${orphan.facetTotal} / 映射表指到 ${orphan.mappedTotal}）。` +
      `补 facet 只做了一半：原来落在桶里的那些单元还记在旧 facet 名下——**迷糊测什么、GG Bond 做什么读的是映射表**，两处账不一致等于新 facet 对下游不存在。\n` +
      `    处置：把那些单元的 facet 列改指到新 facet（一个单元可指多条）；确实不来自源材料的（口径来自功能文档/老板后决），在映射表补一行合成源单元（如 \`d3#待拍L-进度下钻\`）说明来源。\n` +
      `    孤儿清单（前 20）：${orphan.orphans.slice(0, 20).map(o => o.id).join('、')}${orphan.orphans.length > 20 ? ` …还有 ${orphan.orphans.length - 20} 条` : ''}`)
  }
  // ③ 硬：台账
  errors.push(...openItems.errors)
  warnings.push(...openItems.warnings)
  if (openItems.open > 0) warnings.push(`开放项台账里还有 ${openItems.open} 条终态=待拍——它们必须同时出现在任务档案的拍板清单里，开工前清零`)

  // ② 软：阈值点名清单
  if (threshold.missingCount) {
    warnings.push(
      `PRD 原文里有 ${threshold.total} 个数值阈值，facet 表里搜不到 ${threshold.missingCount} 个（点名清单，逐条给个说法：已落在哪条 facet / 现网既有非本版 / PRD 里只是举例不是阈值）：\n` +
      threshold.missing.slice(0, 20).map(t => `    ${t.id}（出现在 ${t.units.length} 个单元：${t.units.slice(0, 4).join('、')}${t.units.length > 4 ? ' …' : ''}）`).join('\n') +
      (threshold.missingCount > 20 ? `\n    …还有 ${threshold.missingCount - 20} 个，跑 validate_req_substance 看全量` : ''))
  }
  // ④ 软：区块专属 facet
  if (quota.orphan.length) {
    warnings.push(
      `按原型自己划的区块看，这 ${quota.orphan.length} 块**没有一条专属 facet**（承载它的 facet 都是跟别处共用的，` +
      `≥${Math.round(SECTION_OWN_RATIO * 100)}% 单元落在本块的一条都没有）——逐块给说法：是该给它立专属 facet，还是它本来就只是通往别处功能的入口：\n` +
      quota.orphan.slice(0, 10).map(s => `    ${s.material}·${s.section}：${s.units} 个单元 / ${s.facets} 条共用 facet / 专属 0`).join('\n'))
  }
  if (quota.thin.length) {
    warnings.push(
      `这些块有专属 facet 但太粗（单元/专属 > ${SECTION_RATIO_CAP}）：\n` +
      quota.thin.slice(0, 8).map(s => `    ${s.material}·${s.section}：${s.units} 个单元 / 专属 ${s.own} 条（${s.ownIds.join('、')}）→ 比 ${s.ratio}`).join('\n'))
  }

  return {
    active, hard: active,
    substanceComplete: errors.length === 0,
    errors, warnings,
    unitTotal: flatUnits.length,
    fanIn, orphan, threshold, openItems, quota,
  }
}

export function renderSubstanceSummary(res) {
  if (!res) return ''
  const L = ['### 需求实质闸（登记到的那条 facet 真的包含这个单元吗）', '']
  L.push(`- **扇入**：${res.fanIn.facetCount} 条 facet 承载 ${res.unitTotal} 个单元；超上限 ${res.fanIn.over.length} 条${res.fanIn.over.length ? `（最粗的 ${res.fanIn.over[0].facet} 吃 ${res.fanIn.over[0].count} 个）` : ''}`)
  L.push(`- **孤儿 facet**：立了但映射表没指过来 ${res.orphan.orphans.length} 条（facet 全集 ${res.orphan.facetTotal} / 映射表指到 ${res.orphan.mappedTotal}）`)
  L.push(`- **阈值回落**：PRD ${res.threshold.total} 个数值阈值 → 未落 ${res.threshold.missingCount} 个`)
  L.push(`- **开放项台账**：PRD 自标 ⏳ ${res.openItems.total} 条 → 已决 ${res.openItems.resolved} / 待拍 ${res.openItems.open} / 不做 ${res.openItems.dropped} / 缺行 ${res.openItems.missing.length}`)
  L.push(`- **区块专属 facet**：${res.quota.sections.length} 个区块 → 无专属 ${res.quota.orphan.length} 块 / 有但太粗 ${res.quota.thin.length} 块`)
  if (res.quota.sections.length) {
    L.push('', '| 源材料·区块 | 单元 | 共用 facet | 专属 facet | 单元/专属 |', '|---|---|---|---|---|')
    for (const s of res.quota.sections.slice(0, 12)) L.push(`| ${s.material}·${s.section} | ${s.units} | ${s.facets} | ${s.own === 0 ? '**0**' : s.own} | ${s.own ? s.ratio : '—'} |`)
  }
  L.push('', `→ ${res.substanceComplete ? '✅ 实质闸通过' : '⛔ 未通过，不许进开发'}`)
  if (res.errors?.length) { L.push('', '**拦下的原因**'); for (const e of res.errors) L.push(`- ${e}`) }
  if (res.warnings?.length) { L.push('', '**点名清单（软提示·逐条给说法）**'); for (const w of res.warnings) L.push(`- ${w}`) }
  return L.join('\n')
}
