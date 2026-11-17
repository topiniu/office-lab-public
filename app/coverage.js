// ============================================================================
// 覆盖率闸门核心（提案见 docs/迷糊QA覆盖率闸门-方案设计.md）
// 把「这版 QA 测没测全 / 绿是不是真绿」从 LLM 自评挪成引擎算：facet（验收标准）升为一等可追溯单元
// （ID 形如 REQ-0212-F2），引擎据「facet 全集(分母·菲菲 facet 文档) vs 覆盖矩阵(任务档案 ## 覆盖矩阵)」
// 机算 qa_coverage_complete / qa_red_calibrated；缺口 → 发波比闸门拦下、bounce 回迷糊。
// 独立成 ESM 模块：纯函数 + 文件读写，可单测（不启动 server）。
// ============================================================================
import fs from 'node:fs'
import crypto from 'node:crypto'

const COVERAGE_STATUS_ENUM = ['UNCOVERED', 'COVERED_GREEN', 'SOURCE_ATTESTED', 'BLOCKED_WITH_PROOF', 'HUMAN_INHERENT']

// ---------------------------------------------------------------------------
// 验证通道（via）——「这条 facet 是从界面验的，还是从接口绕过去的」
// ---------------------------------------------------------------------------
// 事故驱动（2026-09-10 老板点名·项目跟踪 v0.1.0）：196 条 facet、47 条 COVERED_GREEN，
// **全部由 callApi 打后端端点签出**，这个产品的前端到那天为止基本没被测过。
// 根因不是 QA 偷懒，是**制度在奖励绕过 UI**：走界面的验证被有效性 linter 成批拒签
// （只读属性断言判 NO_ACTION、列/表头存在性判 PRESENCE_ONLY、点 tab 挂载判 TRACE_INVALID），
// 而 callApi + 一条 value-assertion RED 必得绿。于是「最省力的合规路径」恰好是不打开页面。
// 代价当场兑现：`moment(updateAt)` 漏 `Number()` 的纯渲染 bug（模板列表每行「Invalid date」），
// callApi 打一万次 `template/list` 都是绿的，只有睁眼看页面才能发现。
//
// 对策：覆盖矩阵加一维「证据从哪条通道来」，与状态正交。
//   · facet 侧（分母）：expectedVia —— 三层，见 inferFacetViaDetailed：facet_doc 显式列 `通道/via`
//     → 「分类」列（ui-visual/视觉/渲染/存在性 → ui）→ **判据原文的高精词表**（置灰/弹窗/空态/表头…）。
//     第三层是 2026-09-10 实测补的：只看前两层时，这套闸在真实档案上**一条都没咬到**（详见词表上方）。
//   · 证据侧：actualVia —— reconcile 时从用例 JSON 的 steps 机读（callApi 步 vs UI 断言步），
//     写进 GREEN/RED 证据串的 `via=` 字段。**不是自报**，与 runId/testHash 同一批机器事实。
//   · 闸门：expectedVia==='ui' 的 facet，证据 via 必须是 ui/mixed；api 或缺失 → 不计 COVERED_GREEN。
//
// 刻意**不改覆盖矩阵表头**：via 存在证据串里而不是新加一列——400+ 条存量行的表头不动，
// engineSetFacetRow 按列名写的老档案照旧可读（同 testFile/redBasis 字段的处置）。
const VIA_ENUM = ['ui', 'api', 'source', 'any']
// 「UI 面」判据·分类列：命中就是必须靠界面才能证明的 facet（渲染/视觉/存在性/交互）
const VIA_UI_RE = /ui-?visual|视觉|渲染|样式|布局|配色|截断|存在性|presence|前端|界面|交互/i
const VIA_API_RE = /接口|api|端点|后端|服务端/i
// 「UI 面」判据·**判据原文**（2026-09-10 实测补：只看分类列的推断是装饰性的）。
// 实测数据：项目跟踪 v0.1.0 的 196 条 facet，分类列只有 11 条写了 `ui-visual`，而那 11 条早就
// parked 成 HUMAN_INHERENT —— 于是通道闸对 46 条由 callApi 签出的绿**一条都没咬到**。翻开判据原文才看清：
//   F2「照片必填选项**置灰不可选**」/ F4「点保存**弹影响清单**」/ F6「页面正常**空态**、非报错」
//   F41「首屏是**模板列表**：每行显 模板名／版本号／…」/ F42「**两级页**、非与列表同屏 inline 糊在一起」
// 全是界面的事，却都标着 `auto`、全由 callApi 签绿 —— **「这是 UI 面」这个事实写在判据里，没写在分类列里。**
//
// 故补一层判据原文推断，词表按「只有在屏幕上才成立」筛，**刻意不收**泛义词（"页面/显示/列表/提示"这类
// 后端 facet 的判据里也句句都有，收进来等于全站皆 ui、噪声比不做更坏）。收的是：
//   · 控件态：置灰/不可选/禁用（API 返回值里没有"灰"这个概念）
//   · 容器形态：弹窗/抽屉/页签/tab/首屏/两级页/inline/同屏
//   · 渲染形态：空态/占位/表头/每行显/徽标/标记显/图标/颜色/色条/进度条/节点条/折叠/展开/截断
// 命中任一即判 ui。**这是 stopgap 不是终局**——终局是菲菲在 facet_doc 显式写 `通道` 列
// （见 validateArchive 的 via 未声明提示），推断只保证"今天就能咬到"。
const VIA_UI_CRITERION_RE = /置灰|不可选|不可点|禁用态|弹窗|抽屉|页签|\btab\b|首屏|两级页|inline|同屏|空态|占位|表头|每行显|徽标|标记显|图标|色条|进度条|节点条|折叠|展开层|截断|置顶|悬浮|hover/i
// 步骤动作 → 通道信号。归一化时去掉 _ - 空格，兼容 callApi / call_api / call-api 三种写法。
const VIA_API_ACTION_RE = /^(callapi|api|apirequest|httprequest|request|sql|db)$/
const VIA_UI_ASSERT_RE = /^(assertvisible|assertdom|assertvisual|assertvisualpeers|assertlayout|assertcount|asserttext|capture|screenshot)$/
const VIA_UI_ACTION_RE = /^(click|dblclick|doubleclick|fill|type|select|check|uncheck|press|hover|scroll|uploadfile|upload|navigate|goto|open|drag|waitfor)$/

function normVia(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  if (!s) return ''
  if (VIA_ENUM.includes(s)) return s
  if (/^(ui|界面|前端|页面)$/.test(s)) return 'ui'
  if (/^(api|接口|后端)$/.test(s)) return 'api'
  if (/^(source|源码|坐实)$/.test(s)) return 'source'
  return ''
}
// facet 的**期望通道**：显式列优先 → 分类列 → 判据原文（高精词表）；都推不出＝'any'（不设限，闸门不管）。
// 返回值带来源标记：`declared`（菲菲写的）/`kind`/`criterion`/`none` —— 供 coverage_status 区分
// 「她声明的」和「引擎猜的」，别让 stopgap 冒充定稿口径。
function inferFacetViaDetailed({ explicit = '', kind = '', criterion = '' } = {}) {
  const ex = normVia(explicit)
  if (ex) return { via: ex, from: 'declared' }
  const k = String(kind || '')
  if (VIA_UI_RE.test(k)) return { via: 'ui', from: 'kind' }
  if (VIA_API_RE.test(k)) return { via: 'api', from: 'kind' }
  if (VIA_UI_CRITERION_RE.test(String(criterion || ''))) return { via: 'ui', from: 'criterion' }
  return { via: 'any', from: 'none' }
}
function inferFacetVia(opts) { return inferFacetViaDetailed(opts).via }
// 用例的**实际通道**：机读 steps。判据顺序有讲究——
// 一个 callApi 用例常常也带登录导航步，若只按「有没有 UI 动作」判，它会冒充 ui 通道；
// 故 ui 的充分条件是**存在 UI 断言步**（真的看了页面上的东西），单纯的导航/点击不算。
function caseChannel(c) {
  const steps = Array.isArray(c && c.steps) ? c.steps : []
  let api = 0, uiAssert = 0, uiAction = 0
  for (const s of steps) {
    const a = String((s && (s.action || s.type)) || '').toLowerCase().replace(/[_\s-]/g, '')
    if (VIA_API_ACTION_RE.test(a)) { api++; continue }
    if (VIA_UI_ASSERT_RE.test(a)) { uiAssert++; continue }
    if (VIA_UI_ACTION_RE.test(a)) { uiAction++; if (s && s.expectation) uiAssert++ }
  }
  if (uiAssert && api) return 'mixed'
  if (uiAssert) return 'ui'
  if (api) return 'api'
  if (uiAction) return 'ui'
  return 'unknown'
}
// 证据串的 via 能否满足 facet 的期望通道
function viaSatisfies(wantVia, gotVia) {
  const want = normVia(wantVia) || 'any'
  if (want !== 'ui') return { ok: true, why: '' }
  const got = String(gotVia || '').trim().toLowerCase()
  if (!got) return { ok: false, why: 'UI 面 facet，但 GREEN 证据没标验证通道（缺 via=）——该条签发早于「验证通道」维上线，或用例通道机读不出来：重跑 `reconcile_coverage` 补签' }
  if (got === 'ui' || got === 'mixed') return { ok: true, why: '' }
  return { ok: false, why: `UI 面 facet 却由 **${got}** 通道用例签发——接口通道证明不了界面渲染/交互（callApi 打一万次 list 也照不出「Invalid date」）。必须由带 UI 断言的用例签发（via=ui/mixed）；界面这条路真走不通的，如实标 HUMAN_INHERENT 走独立风险审批，别用接口绿冒充` }
}
const FACET_ID_RE = /REQ-\d+-F\d+/i   // facet ID：REQ-<编号>-F<序号>（编号一般 4 位如 0212，宽松到 \d+）
const COVERAGE_HEADER = '| facet ID | 需求 | 层级 | 分类 | 状态 | 证据 | RED证据 |'
const COVERAGE_SEP = '|----------|------|------|------|------|------|---------|'

function atomicWrite(abs, content) {
  const tmp = abs + '.tmp-' + crypto.randomBytes(3).toString('hex')
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, abs)
}
const _rc = line => { const c = line.split('|').map(x => x.trim()); c.shift(); if (c[c.length - 1] === '') c.pop(); return c }
const _isSep = line => /^[-:\s]+$/.test(line.replace(/\|/g, ''))

// frontmatter.facet_doc 的形态归一 → 路径数组。三种写法都认：
//   facet_doc: docs/…/主文档.md                    （单份，历史形态）
//   facet_doc: [docs/…/主文档.md, docs/…/REQ-0247.md]（内联列表，与档案里 repos: [...] 同风格）
//   facet_doc:\n  - docs/…/主文档.md\n  - …          （YAML 块列表，parseFrontmatter 直接给数组）
// 为什么要多份（2026-09-03 v5.21 事故）：一版聚合多条 REQ 时 facet 分散在各自的《需求说明与验收标准》里
// （v5.21 有 9 份），单个标量装不下 —— `seed_coverage` 每播一份就改写一次指针，最后播的那份赢，
// 于是其余 REQ 的判据原文在看板上全成空白（unlisted），**且门禁分母跟着塌到那一份**（fail-open）。
// 约定：**列表第一项＝版本主文档**，QA 报告落点 / 发布四件核对都拿它当版本目录锚点（server.js·primaryFacetDoc）。
function facetDocList(value) {
  if (value == null || value === '') return []
  const one = s => String(s).trim().replace(/^['"]|['"]$/g, '').trim()
  const src = Array.isArray(value) ? value : (() => {
    const s = String(value).trim()
    return (s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s).split(',')
  })()
  const out = [], seen = new Set()
  for (const raw of src) { const p = one(raw); if (p && !seen.has(p)) { seen.add(p); out.push(p) } }
  return out
}

// 多份 facet 文档 → 一个全集（按 facet ID 去重，**先出现的赢**）。
// 所以主文档排第一位：同一 facet 若版本主文档与储备文档都有，以主文档的定稿口径为准。
function mergeFacetSets(sets) {
  const out = [], seen = new Set()
  for (const s of sets || []) for (const f of s || []) {
    const id = String((f && f.id) || '').toUpperCase()
    if (!id || seen.has(id)) continue
    seen.add(id); out.push(f)
  }
  return out
}

// 从菲菲《需求说明与验收标准》解析 facet 全集（分母）：扫所有 markdown 表格，取含「facet」表头下、首格是 facet ID 的行。
// 旧版（facet 还是自由文本 bullet、无 ID 表）→ 返回 []，覆盖率闸门对该版不激活（向后兼容、opt-in）。
function extractFacetsFromDoc(docText) {
  const out = []
  if (!docText) return out
  let header = null
  for (const raw of String(docText).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|')) { header = null; continue }
    const cells = _rc(line)
    if (!header) { if (cells.some(c => /facet/i.test(c))) header = cells.map(h => h.replace(/\*\*/g, '')); continue }
    if (_isSep(line)) continue
    const idIdx = header.findIndex(h => /facet/i.test(h))
    const id = (cells[idIdx >= 0 ? idIdx : 0] || '').replace(/\*\*/g, '').trim()
    if (!FACET_ID_RE.test(id)) continue
    const col = (...names) => { for (const n of names) { const i = header.findIndex(h => h.toLowerCase().startsWith(n.toLowerCase())); if (i >= 0) return (cells[i] || '').trim() } return '' }
    const kind = (col('分类', '类型') || 'auto').toLowerCase()
    // 判据原文的列名在菲菲手里有两种写法（截至 2026-09-03 实测 7 种表头）：
    //   ① `验收标准（…）` 单列  ② `场景 | 断言（可测值）` 或 `场景 | 期望可观测结果` 拆两列。
    // 只认 ①（旧口径）时，②那批 facet 的 criterion 会解析成空串 —— 看板 facet 明细里就是「有编号没判据」的白板，
    // 而覆盖矩阵本身不存判据原文，谁也补不回来。故 ② 就地拼成「场景 → 断言」。
    const criterion = col('验收', '标准', '判据') || [col('场景'), col('断言', '期望', '预期')].filter(Boolean).join(' → ')
    // 断言类（linter 用）：human-inherent 或标了「存在性/纯展示/presence/渲染」→ presence(免 G3/G4)；否则 content(严格·必值断言+被测动作)
    const cls = (/human|人工/.test(kind) || /存在性|纯展示|presence|仅渲染|仅展示/.test(col('分类', '验证', '断言类', '断言') + ' ' + criterion)) ? 'presence' : 'content'
    // 期望验证通道：菲菲显式写了 `通道/via` 列就用她的，否则按分类列推断（见 inferFacetVia 上方缘起）
    const viaInfo = inferFacetViaDetailed({ explicit: col('通道', 'via', '验证通道'), kind, criterion })
    out.push({ id: id.toUpperCase(), req: (id.match(/REQ-\d+/i) || [''])[0].toUpperCase(), criterion, level: col('层级', 'P'), kind, cls, via: viaInfo.via, viaFrom: viaInfo.from })
  }
  return out
}

// 定位「真正的」覆盖矩阵段——正文里含 facet 表头行（`| facet ID | …` 紧跟 `|---|` 分隔行）的那一段 `## 覆盖矩阵`。
// 关键：不再取「文档里第一个同名标题」，而是逐个 `## 覆盖矩阵` 标题看其正文有没有真表头，只认有表头的那一段；
// 时间线/正文散文里复述的字面「## 覆盖矩阵」（内联或独占一行、无表头）一律跳过。
// 事故根因（2026-08-11 两崩 + 2026-08-12 一崩，共废三个 QA 会话·见复盘）：旧 reader/writer 都取「首个同名标题」，
// 命中时间线里巡视 note 内联的「## 覆盖矩阵」→ 截出的段无表头行 → headerIdx=-1 → _rc(undefined).split 崩；
// 且此前的「锚定行首」补丁只把内联挡住、独占一行的裸标题仍会劫持（治标不治本）。此处按「表头存在」判真段，彻底解决。
// 返回 { index, section }：index=标题行首偏移；section=标题行首 → 下一个 `## ` 标题前 / EOF。无真表头段则 null。
function findMatrixSection(text) {
  const headingRe = /(^|\n)##[ \t]*覆盖矩阵[ \t]*\r?\n/g
  let mm
  while ((mm = headingRe.exec(text))) {
    const start = mm.index + mm[1].length            // 标题行首（跳过捕获组吃掉的前导 \n）
    const rest = text.slice(headingRe.lastIndex)     // 标题行之后的正文
    const nextH = rest.search(/\n##[ \t]/)           // 下一个 h2 标题（h3 `###` 不算，与旧口径一致）
    const end = nextH === -1 ? text.length : headingRe.lastIndex + nextH
    const section = text.slice(start, end)
    const sl = section.split('\n')
    for (let i = 0; i < sl.length - 1; i++)          // 真段判据：某 `|` 行含 facet 且紧跟分隔行
      if (sl[i].trim().startsWith('|') && /facet/i.test(sl[i]) && _isSep(sl[i + 1])) return { index: start, section }
  }
  return null
}

// 解析任务档案「## 覆盖矩阵」表 → [{facetId, req, level, kind, status, evidence, red}]
function extractCoverageMatrix(text) {
  const sec = findMatrixSection(text)
  if (!sec) return []
  const rows = sec.section.split('\n').filter(l => l.trim().startsWith('|'))
  if (rows.length < 2) return []
  const header = _rc(rows[0]).map(h => h.replace(/\*\*/g, ''))
  const idxOf = (...names) => { for (const n of names) { const i = header.findIndex(h => h.toLowerCase().startsWith(n.toLowerCase())); if (i >= 0) return i } return -1 }
  const iId = idxOf('facet'), iReq = idxOf('需求'), iLv = idxOf('层级'), iKind = idxOf('分类'), iSt = idxOf('状态'), iEv = idxOf('证据'), iRed = idxOf('red')
  const out = []
  for (let i = 1; i < rows.length; i++) {
    if (_isSep(rows[i])) continue
    const c = _rc(rows[i])
    const id = (c[iId >= 0 ? iId : 0] || '').replace(/\*\*/g, '').trim()
    if (!FACET_ID_RE.test(id)) continue
    out.push({ facetId: id.toUpperCase(), req: (c[iReq] || '').trim(), level: (c[iLv] || '').trim(), kind: (c[iKind] || '').trim(), status: (c[iSt] || '').trim(), evidence: (c[iEv] || '').trim(), red: (c[iRed] || '').trim() })
  }
  return out
}

// upsert「## 覆盖矩阵」一行（按 facet ID 定位、按列名写；段不存在则建）。原子写。
// 定位复用 findMatrixSection（按「表头存在」认真段）：散文里复述的同名标题不会被误当矩阵段写坏（根因见其注释）。
function engineSetFacetRow(abs, { facetId, status, evidence, red, req, level, kind }) {
  let text = fs.readFileSync(abs, 'utf8')
  let sec = findMatrixSection(text)
  if (!sec) {
    const block = `\n## 覆盖矩阵\n\n> 引擎维护（seed_coverage / set_facet_coverage）；\`qa_coverage_complete\` / \`qa_red_calibrated\` 据此机算，发波比前不达标闸门拦下。状态枚举：${COVERAGE_STATUS_ENUM.join(' / ')}。\n\n${COVERAGE_HEADER}\n${COVERAGE_SEP}\n`
    text = text.replace(/\s*$/, '\n') + block
    sec = findMatrixSection(text)
  }
  const section = sec.section
  const lines = section.split('\n')
  const headerIdx = lines.findIndex(l => l.trim().startsWith('|'))
  if (headerIdx === -1) throw new Error('覆盖矩阵段未找到表头行（| facet ID | …）——段被破坏或 ## 覆盖矩阵 标题非独占行')   // findMatrixSection 已保证有表头，理论不可达；留作防御
  const header = _rc(lines[headerIdx]).map(h => h.replace(/\*\*/g, ''))
  const idxOf = (...names) => { for (const n of names) { const i = header.findIndex(h => h.toLowerCase().startsWith(n.toLowerCase())); if (i >= 0) return i } return -1 }
  const iId = idxOf('facet'), iReq = idxOf('需求'), iLv = idxOf('层级'), iKind = idxOf('分类'), iSt = idxOf('状态'), iEv = idxOf('证据'), iRed = idxOf('red')
  const setCell = (cells, i, v) => { if (i >= 0 && v != null && v !== '') { while (cells.length <= i) cells.push(''); cells[i] = String(v).replace(/\|/g, '/').replace(/\n/g, ' ') } }
  let hit = null
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|') || _isSep(lines[i])) continue
    const cells = _rc(lines[i])
    if ((cells[iId >= 0 ? iId : 0] || '').replace(/\*\*/g, '').trim().toUpperCase() !== String(facetId).toUpperCase()) continue
    setCell(cells, iSt, status); setCell(cells, iEv, evidence); setCell(cells, iRed, red); setCell(cells, iReq, req); setCell(cells, iLv, level); setCell(cells, iKind, kind)
    lines[i] = '| ' + cells.join(' | ') + ' |'; hit = facetId; break
  }
  if (hit === null) {
    const cells = header.map(() => '')
    setCell(cells, iId, facetId); setCell(cells, iReq, req || (String(facetId).match(/REQ-\d+/i) || [''])[0]); setCell(cells, iLv, level); setCell(cells, iKind, kind || 'auto'); setCell(cells, iSt, status || 'UNCOVERED'); setCell(cells, iEv, evidence); setCell(cells, iRed, red)
    let lastRow = headerIdx
    for (let i = headerIdx + 1; i < lines.length; i++) if (lines[i].trim().startsWith('|')) lastRow = i
    lines.splice(lastRow + 1, 0, '| ' + cells.join(' | ') + ' |'); hit = facetId
  }
  atomicWrite(abs, text.slice(0, sec.index) + lines.join('\n') + text.slice(sec.index + section.length))
  return hit
}

// 播种：把 facet 全集里矩阵还没有的 facet 建成 UNCOVERED 行（三方会审 shift-left / 迷糊开工补建）
function engineSeedCoverage(abs, facets) {
  const existing = new Set(extractCoverageMatrix(fs.readFileSync(abs, 'utf8')).map(r => r.facetId.toUpperCase()))
  let added = 0
  for (const f of facets) { if (existing.has(f.id.toUpperCase())) continue; engineSetFacetRow(abs, { facetId: f.id, status: 'UNCOVERED', req: f.req, level: f.level, kind: f.kind || 'auto' }); added++ }
  return { added, total: facets.length }
}

// 设置 frontmatter 里 gates.<key>（嵌套 map，保留行尾 # 注释）；gates 块或子键不存在则补。
function engineSetGate(abs, key, value) {
  const text = fs.readFileSync(abs, 'utf8')
  if (!text.startsWith('---')) throw new Error('档案无 frontmatter')
  const end = text.indexOf('\n---', 3)
  if (end === -1) throw new Error('frontmatter 未闭合')
  const fmLines = text.slice(0, end).split('\n')
  const val = String(value)
  const gi = fmLines.findIndex(l => /^gates:\s*(#.*)?$/.test(l))
  if (gi === -1) { fmLines.push('gates:', `  ${key}: ${val}`); atomicWrite(abs, fmLines.join('\n') + text.slice(end)); return }
  const childRe = new RegExp(`^(\\s+)(${key})(\\s*:)(.*)$`)
  for (let j = gi + 1; j < fmLines.length; j++) {
    if (!/^\s+\S/.test(fmLines[j])) break   // 缩进结束=离开 gates 块
    const cm = fmLines[j].match(childRe)
    if (cm) { const v = cm[4]; const ci = v.search(/\s#/); const comment = ci >= 0 ? v.slice(ci) : ''; fmLines[j] = `${cm[1]}${cm[2]}${cm[3]} ${val}${comment}`; atomicWrite(abs, fmLines.join('\n') + text.slice(end)); return }
  }
  fmLines.splice(gi + 1, 0, `  ${key}: ${val}`); atomicWrite(abs, fmLines.join('\n') + text.slice(end))
}

const GREEN_EVIDENCE_FIELDS = ['runId', 'case', 'testHash', 'summaryHash', 'commit', 'env', 'summary']

function parseEvidenceFields(value) {
  const fields = {}
  for (const part of String(value || '').split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    fields[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return fields
}

function validateMachineEvidence(value, label = 'GREEN') {
  const fields = parseEvidenceFields(value)
  const missing = GREEN_EVIDENCE_FIELDS.filter(k => !fields[k])
  if (missing.length) return `${label} 证据不是引擎签发的完整证据（缺 ${missing.join(', ')}）`
  if (!/^sha256:[0-9a-f]{64}$/i.test(fields.testHash)) return `${label} 证据 testHash 非 sha256`
  if (!/^sha256:[0-9a-f]{64}$/i.test(fields.summaryHash)) return `${label} 证据 summaryHash 非 sha256`
  return ''
}

// 同 REQ 内是否已有「带完整机器证据的真绿 facet」——作为「该 REQ 的造数链已证明可跑通」的机读判据。
// 用途：若某 facet 停在 SOURCE_ATTESTED、而同 REQ 另有真绿，说明链路能端到端跑通，源码坐实即属「逃避真跑」，
// computeCoverage 会把它从泛泛 gap 升级为点名（suspectAttestations）。纯从覆盖矩阵算，不扫测试文件。
// （事故驱动 2026-08-11：REQ-0261 F3 真绿、F1 却停在 SOURCE_ATTESTED「源码坐实可保存」，真端到端跑才暴露补录接口 404=BUG-004。）
function reqsWithValidGreen(matrix) {
  const reqs = new Set()
  for (const r of matrix || []) {
    if (String(r.status || '').toUpperCase() !== 'COVERED_GREEN') continue
    if (validateMachineEvidence(r.evidence, 'GREEN')) continue   // 证据不完整不算真绿
    const rq = (String(r.facetId || '').match(/REQ-\d+/i) || [''])[0].toUpperCase()
    if (rq) reqs.add(rq)
  }
  return reqs
}

// 机算覆盖率：只有带完整机器证据的 COVERED_GREEN 才算通过。
// SOURCE_ATTESTED / BLOCKED_WITH_PROOF / HUMAN_INHERENT 都是风险处置，不是测试通过，必须 fail-closed。
function computeCoverage(text, facetSet) {
  const matrix = extractCoverageMatrix(text)
  const hasDoc = Array.isArray(facetSet) && facetSet.length > 0
  if (!matrix.length && !hasDoc) return null
  const byId = new Map(matrix.map(r => [r.facetId.toUpperCase(), r]))
  const facetById = new Map((hasDoc ? facetSet : []).map(f => [String(f.id).toUpperCase(), f]))
  const denomIds = [...new Set((hasDoc ? facetSet.map(f => f.id) : matrix.map(r => r.facetId)).map(s => String(s).toUpperCase()))]
  const gaps = [], redGaps = [], byStatus = {}, missingRows = [], suspectAttestations = [], channelGaps = []
  // 通道声明度：declared=菲菲在 facet_doc 写了「通道」列；inferred=引擎从分类/判据猜的；none=毫无信号。
  // 为什么要单独记：推断是 stopgap，而「闸门只覆盖了多少条」必须可见——否则这一维会以"已上线"的名义
  // 只管住零星几条，剩下的照旧从缺口穿过去（同族：§3.104 沉默不许冒充通过）。
  const viaTally = { declared: 0, inferred: 0, none: 0 }
  const greenReqs = reqsWithValidGreen(matrix)   // 同 REQ 有真绿 = 造数链已证明可跑通
  // 期望通道：facet_doc 的 via 优先；无 facet_doc（分母=矩阵自身）时退回按矩阵「分类」列推断
  const viaWantOf = (id, row) => {
    const f = facetById.get(id)
    if (f && f.via) return f.via
    return inferFacetVia({ kind: (row && row.kind) || '' })   // 无 facet_doc 时只有矩阵的分类列可用（矩阵不存判据原文）
  }
  for (const id of denomIds) {
    const row = byId.get(id)
    if (!row) { missingRows.push(id); gaps.push({ facetId: id, why: '未进覆盖矩阵（漏测·无行）' }); continue }
    const st = String(row.status || '').toUpperCase()
    byStatus[st] = (byStatus[st] || 0) + 1
    const vf = String((facetById.get(id) || {}).viaFrom || '')
    if (vf === 'declared') viaTally.declared++
    else if (vf === 'kind' || vf === 'criterion') viaTally.inferred++
    else viaTally.none++
    const ev = String(row.evidence || '').trim(), red = String(row.red || '').trim()
    if (st === 'COVERED_GREEN') {
      const evidenceError = validateMachineEvidence(ev, 'GREEN')
      if (evidenceError) gaps.push({ facetId: id, why: evidenceError })
      const redError = validateMachineEvidence(red, 'RED')
      if (redError) redGaps.push({ facetId: id, why: redError })
      // 验证通道闸：UI 面 facet 不许由 callApi 签绿（见文件头 via 段的缘起）
      const want = viaWantOf(id, row)
      const chk = viaSatisfies(want, parseEvidenceFields(ev).via)
      if (!chk.ok) { channelGaps.push({ facetId: id, want, got: parseEvidenceFields(ev).via || '', why: chk.why }); gaps.push({ facetId: id, why: chk.why }) }
    }
    else if (st === 'SOURCE_ATTESTED') {
      const rq = (String(id).match(/REQ-\d+/i) || [''])[0].toUpperCase()
      if (rq && greenReqs.has(rq)) { suspectAttestations.push(id); gaps.push({ facetId: id, why: 'SOURCE_ATTESTED 但同 REQ 已有真绿用例（造数链已证明可跑通）——不许停在源码坐实：补真闭环(reconcile→GREEN)，或如实标 BLOCKED_WITH_PROOF/HUMAN_INHERENT' }) }
      else gaps.push({ facetId: id, why: 'SOURCE_ATTESTED 仅证明实现被阅读，不等于 QA 通过' })
    }
    else if (st === 'BLOCKED_WITH_PROOF') gaps.push({ facetId: id, why: 'BLOCKED_WITH_PROOF 表示测试被阻断，不得计入通过' })
    else if (st === 'HUMAN_INHERENT') gaps.push({ facetId: id, why: 'HUMAN_INHERENT 需要独立风险审批，不得由 QA 自行计入通过' })
    else { gaps.push({ facetId: id, why: st === 'UNCOVERED' ? 'UNCOVERED(没测·没理由)' : `状态非法「${row.status}」` }) }
  }
  const passed = gaps.length === 0 && redGaps.length === 0
  return { denom: denomIds.length, present: matrix.length, missingRows, byStatus, gaps, redGaps, suspectAttestations, channelGaps, viaTally, coverageComplete: gaps.length === 0, redComplete: redGaps.length === 0, passed, hasDoc }
}

// facet_doc 生命周期硬门禁的可执行+教学提示（缺 facet_doc / 找不到 / 无 ID facet 时都追加）。
// 说明 hotfix 也要 facet_doc，且给出壳号形态，避免像早先那样把 hotfix 当新功能版找《需求说明与验收标准》而误判「缺失」。
const FACET_DOC_HINT =
  'facet_doc 是「进 QA」的硬前置：它是覆盖率闸门的 facet 全集权威源（分母），没有它迷糊无法做覆盖。' +
  '新功能版=版本主《需求说明与验收标准》(内嵌 facet 表)；纯缺陷 hotfix 也要，但可以是一份独立《修复验收 facet》文档，' +
  '壳号 REQ-9007-Fn（末三位=缺陷号↔BUG-007），因 FACET_ID_RE 只认 REQ-<数字>-F<序号>、BUG-00X-Fn 播不进矩阵。' +
  '正确做法：cc_colleague("feifei", …) 请菲菲创建/回写 facet_doc（她是 facet 全集的唯一创建人），并把相对路径写进任务档案 frontmatter.facet_doc，再交棒迷糊。'

// ---------------------------------------------------------------------------
// 「写了但引擎没认到」检测（2026-09-09 实测缺陷）
// ---------------------------------------------------------------------------
// 缘起：菲菲把太粗的 facet 拆成可断言子项，写成 `| F40-a | …`（她自创的写法，此前没有子 facet 的约定），
// 文档里还写着「实施与测试**以子项为准**」——而 FACET_ID_RE 认的是 `REQ-<数字>-F<序号>`，
// **27 条子项一条都没进 facet 全集**：不进覆盖矩阵、迷糊 seed 不到、门禁分母不含它们。
// 也就是说"以子项为准"那句话，恰恰写在引擎与迷糊唯一看不到的地方。
//
// 这是这个体系里反复出现的同一种失效：**写了，下游读不到**（同族：§3.113 facet_doc 指针被顶掉、
// req-substance 的孤儿 facet「立了但映射表没指过来」）。解析器沉默跳过一行，与那一行不存在，
// 在账面上完全同形——所以必须有人把"我扫到了 facet 形状的行、但没解析出来"这件事喊出来。
//
// 刻意**不做自动推断**（不从「拆 REQ-0339-F40 → 8 子项」这种小标题反推前缀补全）：推断会把子项
// 绑到错的 REQ 上，且立刻产生第二套 ID 约定；而 ID 是覆盖矩阵、seed、门禁分母三处的连接键，
// 宁可报错让人改成完整 ID。
//
// 判据故意不区分大小写敏感之外的宽松：只认整格就是一个 facet 形 ID 的单元格（首列），
// 且**不带 /i**——否则「REQ-0338 环节配置=F1-F9」这种区间写法会被当成 `F1` 加后缀 `-F9` 误报。
const FACETISH_CELL_RE = /^\**\s*((?:REQ-\d+-)?F\d+(?:-[a-z]\d?)?)\s*\**$/
export function findUnparsedFacetRows(docText, parsedIds = []) {
  const out = []
  if (!docText) return out
  const known = new Set((parsedIds || []).map(s => String(s).toUpperCase()))
  const seen = new Set()
  for (const raw of String(docText).split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('|') || _isSep(line)) continue
    const cells = _rc(line)
    const first = String(cells[0] || '').trim()
    const m = first.match(FACETISH_CELL_RE)
    if (!m) continue
    const id = m[1]
    if (known.has(id.toUpperCase())) continue          // 解析到了，正常
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      hasReqPrefix: /^REQ-/.test(id),
      // 行摘要给一点上下文，便于她定位是哪张表（首列之后的第一格非空内容）
      hint: String(cells.slice(1).find(c => c && c.trim()) || '').replace(/\|/g, '｜').slice(0, 48),
    })
  }
  return out
}

// facet/覆盖生命周期校验（纯函数、可单测）：给定档案文本 + facet_doc 文档清单，产出 {errors,warnings}。
// 入参 facetDocs：`[{rel, text}]`，text==null 表示那份找不到/读不出；单份的老写法 facetDocRel/facetDocText 仍认。
// errors=硬门禁项（进 QA 前必须满足）：facet_doc 缺失 / 列表里有文件找不到 / 全部加起来解析不到带 ID facet。
// warnings=软项（始终提示、不阻断）：某份文档读到了却零 facet / 矩阵孤儿行（不在全集）/ facet ID 形态不合 / 状态值非法。
// 路径解析（resolveRepoFile/parseFrontmatter 在 server.js）由调用方 validateArchiveFile 包装，这里只吃文本，保持可测。
function validateArchive({ text, facetDocRel, facetDocText, facetDocs }) {
  const errors = [], warnings = []
  const docs = facetDocs || (facetDocRel ? [{ rel: facetDocRel, text: facetDocText }] : [])
  const parsed = docs.map(d => ({ rel: d.rel, text: d.text, facets: d.text != null ? extractFacetsFromDoc(d.text) : [] }))
  const facets = mergeFacetSets(parsed.map(d => d.facets))
  const matrix = extractCoverageMatrix(String(text || ''))
  // ── 硬门禁：facet_doc 三态 ──
  if (!docs.length) errors.push('缺 frontmatter.facet_doc。' + FACET_DOC_HINT)
  else {
    for (const d of parsed) {
      if (d.text == null) errors.push(`facet_doc 指向的文件找不到/读不到：${d.rel}。` + FACET_DOC_HINT)
      else if (!d.facets.length && parsed.length > 1) warnings.push(`facet_doc「${d.rel}」里解析不到带 ID 的 facet 表——白列一份，请核对路径或补 facet 表`)
    }
    if (!facets.length && parsed.every(d => d.text != null)) errors.push(`facet_doc「${parsed.map(d => d.rel).join('、')}」里解析不到带 ID 的 facet 表（需 facet ID 列，形如 REQ-0212-F1）。` + FACET_DOC_HINT)
  }
  // ── 硬门禁：facet_doc 里写了 facet 形状的行、但引擎没认到（见 findUnparsedFacetRows 上方缘起）──
  // 硬而不软：这类行的作者以为自己已经把需求登记了（还会在正文写「以子项为准」），而分母里没有它们
  // ⇒ 迷糊播不到、门禁不数、GG Bond 也不知道要做。软提示在这种"作者确信已完成"的形态下不起作用。
  const parsedIdList = facets.map(f => f.id)
  for (const d of parsed) {
    if (d.text == null) continue
    const un = findUnparsedFacetRows(d.text, parsedIdList)
    if (!un.length) continue
    const noPrefix = un.filter(u => !u.hasReqPrefix)
    const withPrefix = un.filter(u => u.hasReqPrefix)
    if (noPrefix.length) errors.push(
      `facet_doc「${d.rel}」里有 ${noPrefix.length} 行写成了**没有 REQ 前缀**的 facet ID，引擎一条都没认到` +
      `（facet 全集里没有它们 ⇒ 覆盖矩阵播不进、迷糊测不到、门禁分母不含它们——哪怕正文写着"以子项为准"）：` +
      `${noPrefix.slice(0, 12).map(u => u.id).join('、')}${noPrefix.length > 12 ? ` …还有 ${noPrefix.length - 12} 条` : ''}。` +
      `\n    改法：写成完整 ID（\`REQ-<编号>-F<序号>\`）。拆分子项建议**直接给新序号**（如 F83、F84…），` +
      `别用 \`F40-a\` 这种后缀式——ID 是覆盖矩阵 / seed_coverage / 门禁分母三处的连接键，两套形态一定会漂。` +
      `改完记得 \`seed_coverage\` 把新 ID 播进覆盖矩阵。`)
    if (withPrefix.length) warnings.push(
      `facet_doc「${d.rel}」里这些行首列像 facet ID 却没被解析出来（可能表头缺 facet 列名、或列序异常）：` +
      `${withPrefix.slice(0, 8).map(u => u.id).join('、')}`)
  }
  // ── 软项：验证通道未声明（2026-09-10）──
  // 通道维靠推断能咬到一部分，但**推断不是口径**：facet 是不是「UI 面」这件事应当由 facet 主人写下来。
  // 软而不硬：一次性要求 196 条存量 facet 补列会把所有版本卡死；但必须可见，否则这一维会静默退化。
  for (const d of parsed) {
    if (d.text == null || !d.facets.length) continue
    const undeclared = d.facets.filter(f => f.viaFrom === 'none')
    const inferred = d.facets.filter(f => f.viaFrom === 'criterion' || f.viaFrom === 'kind')
    if (!undeclared.length) continue
    warnings.push(
      `facet_doc「${d.rel}」有 ${undeclared.length}/${d.facets.length} 条 facet **没声明验证通道**` +
      `（引擎已从分类/判据推断出 ${inferred.length} 条 UI 面，剩下的通道闸不生效）——` +
      `建议在 facet 表加一列 \`通道\`，逐条写 \`ui\`（要靠界面才能证明：渲染/存在性/控件态/交互）、` +
      `\`api\`（后端行为，接口可证）或 \`any\`（不设限）。推断只是兜底：它认的是「置灰/弹窗/空态/表头」这类词，` +
      `写法一变就漏，而漏掉的那条会重新变成"可以拿 callApi 绿冒充"的口子。`)
  }
  // ── 软项：矩阵一致性 ──
  const facetIds = new Set(facets.map(f => f.id.toUpperCase()))
  for (const r of matrix) {
    const id = String(r.facetId || '').toUpperCase()
    if (facets.length && !facetIds.has(id)) warnings.push(`覆盖矩阵行 ${id} 不在 facet_doc 全集（未登记 facet_doc）——请 cc 菲菲把它回写 facet_doc`)
    if (!FACET_ID_RE.test(id)) warnings.push(`覆盖矩阵行 facet ID「${r.facetId}」不合形态 REQ-<数字>-F<序号>`)
    const st = String(r.status || '').toUpperCase()
    if (st && !COVERAGE_STATUS_ENUM.includes(st)) warnings.push(`覆盖矩阵行 ${id} 状态「${r.status}」非法（枚举：${COVERAGE_STATUS_ENUM.join(' / ')}）`)
  }
  return { errors, warnings, facetCount: facets.length, matrixCount: matrix.length }
}

// 单个 REQ 的 facet 汇总 → 看板「显示层派生」状态（不改流水线权威，仅供卡片展示）。
// 入参 rows：该 REQ 名下 facet 行数组，每行含 { status(枚举大写), redOk?(GREEN 的 RED 证据是否完整) }。
// 出参 dot 复用 entryState 词汇 {ok/flight/dev/blocked/idle}；next 仅供显示、不驱动真实派工。
function rollupReqFacets(rows) {
  const counts = { GREEN: 0, SOURCE: 0, HUMAN: 0, BLOCKED: 0, UNCOVERED: 0, other: 0 }
  let redPending = 0
  for (const r of rows || []) {
    switch (String(r.status || '').toUpperCase()) {
      case 'COVERED_GREEN': counts.GREEN++; if (r.redOk === false) redPending++; break
      case 'SOURCE_ATTESTED': counts.SOURCE++; break
      case 'HUMAN_INHERENT': counts.HUMAN++; break
      case 'BLOCKED_WITH_PROOF': counts.BLOCKED++; break
      case 'UNCOVERED': counts.UNCOVERED++; break
      default: counts.other++
    }
  }
  const total = (rows || []).length
  let status = '—', dot = 'idle', flight = false, next = null
  if (counts.BLOCKED > 0) { status = '阻塞'; dot = 'blocked'; flight = true; next = 'manual' }
  else if (counts.UNCOVERED > 0 || counts.other > 0) { status = '待测'; dot = 'flight'; flight = true; next = 'mihu' }
  else if (counts.SOURCE + counts.HUMAN > 0) { status = '待人工'; dot = 'flight'; flight = true; next = 'manual' }
  else if (total > 0 && counts.GREEN === total) { status = redPending > 0 ? 'QA通过·RED待补' : 'QA通过'; dot = 'ok'; flight = false; next = null }
  return { counts, total, redPending, status, dot, flight, next }
}

// 看板显示层：facet_doc（全集权威）∪ 覆盖矩阵（状态/证据覆盖层）→ 逐 facet 行（纯函数、可单测）。
// A+甲：以 facet_doc 为主序全集——菲菲定稿即显完整骨架，矩阵未铺的 facet 显 UNCOVERED；
// 矩阵有而 facet_doc 无的行标 unlisted（迷糊临时加、待回写菲菲）。facet_doc 缺则退化为纯矩阵（无 unlisted）。
function mergeFacetRows(facets, matrix) {
  facets = facets || []; matrix = matrix || []
  const matrixById = new Map(matrix.map(r => [String(r.facetId || '').toUpperCase(), r]))
  const mkRow = (fid, f, r, unlisted) => {
    fid = String(fid).toUpperCase()
    const req = (String((r && r.req) || (f && f.req) || '').match(/REQ-\d+/i) || fid.match(/REQ-\d+/i) || [''])[0].toUpperCase()
    const status = String((r && r.status) || 'UNCOVERED').toUpperCase()
    return {
      facetId: fid, req,
      level: (r && r.level) || (f && f.level) || '', kind: (r && r.kind) || (f && f.kind) || '', cls: (f && f.cls) || '',
      criterion: (f && f.criterion) || '', status,
      // 验证通道：via=期望（facet 侧）、evidenceVia=实际（证据串机读）、viaOk=闸门结论
      via: (f && f.via) || inferFacetVia({ kind: (r && r.kind) || (f && f.kind) || '' }),
      evidenceVia: status === 'COVERED_GREEN' ? String(parseEvidenceFields(r && r.evidence).via || '') : '',
      viaOk: status !== 'COVERED_GREEN' || viaSatisfies((f && f.via) || inferFacetVia({ kind: (r && r.kind) || (f && f.kind) || '' }), parseEvidenceFields(r && r.evidence).via).ok,
      green: status === 'COVERED_GREEN' ? parseEvidenceFields(r && r.evidence) : {},
      greenOk: !validateMachineEvidence(r && r.evidence, 'GREEN'),
      redOk: !validateMachineEvidence(r && r.red, 'RED'),
      hasRed: !!String((r && r.red) || '').trim(),
      // RED 证据原串：消费方要从里面读 `redBasis=`（C7 判据来源：结构判定 vs 标题正则降级）。
      // 只暴露原串、不在此解析——解析口径归 guard-ledger/zhuzhu-capabilities，这里只做显示层合并。
      redRaw: String((r && r.red) || ''),
      unlisted: !!unlisted,
    }
  }
  const rows = [], seen = new Set()
  for (const f of facets) { const fid = String(f.id).toUpperCase(); if (seen.has(fid)) continue; seen.add(fid); rows.push(mkRow(fid, f, matrixById.get(fid), false)) }
  for (const r of matrix) { const fid = String(r.facetId || '').toUpperCase(); if (seen.has(fid)) continue; seen.add(fid); rows.push(mkRow(fid, null, r, facets.length > 0)) }
  return rows
}

// 自动回捞：从一批 case 结果（{caseId, ok}）+ caseId→facetIds 映射，产出应置 COVERED_GREEN 的 facet 更新。
// 失败 case 的 facet 不自动置（可能是真 bug、需迷糊看证据判），只列 report；减少迷糊「绿不绿」的自报面（证据回捞自 summary，非自评）。
function reconcileCoverage(caseResults, caseFacetMap, evidenceHint) {
  const greens = [], fails = [], unmapped = []
  const norm = s => String(s == null ? '' : s).trim()
  for (const c of caseResults || []) {
    const cid = norm(c.caseId)
    const facets = caseFacetMap[cid] || caseFacetMap[cid.toLowerCase()] || []
    if (!facets.length) { if (c.ok) unmapped.push(cid); continue }
    for (const fid of facets) {
      const id = norm(fid).toUpperCase()
      if (!FACET_ID_RE.test(id)) continue
      if (c.ok) greens.push({ facetId: id, evidence: (evidenceHint ? evidenceHint + ' ' : '') + `case=${cid}` })
      else fails.push({ facetId: id, caseId: cid })
    }
  }
  return { greens, fails, unmapped }
}
// 从测试文件 JSON 抽 caseId→coversFacets 映射（cases[].coversFacets；宽松兼容 id/caseId 键）
function caseFacetMapFromTestFile(testJson) {
  const map = {}
  if (!testJson || typeof testJson !== 'object') return map
  const cases = Array.isArray(testJson.cases) ? testJson.cases : []
  for (const c of cases) {
    const id = String(c.id || c.caseId || '').trim()
    if (!id) continue
    const cf = c.coversFacets || c.covers || []
    if (Array.isArray(cf) && cf.length) map[id] = cf.map(s => String(s).toUpperCase())
  }
  return map
}

// ============================================================================
// 测试有效性 linter（方案 §4 的 G2/G3/G4）——机器扫 case JSON，挡「翻库找数据 / 只验存在 / 没做被测动作」。
// 全部确定性、不讲道理；lintAck 只记录申诉，不改变严重级别。例外必须走独立、预审批且有期限的 policyId。
// 详见 docs/QA可信度体系-业界最佳实践落地方案.md。
// ============================================================================
const SPU_LITERAL_RE = /\b(?:JY|SH)[0-9A-Z]{4,}\b/   // 硬编码业务号（SPU 如 JY2026A01052 / 供应商号如 SH000322，字母数字混排）——DB 捞现成数据的铁证；{{token}} 造数不算
const MUTATION_VERB_RE = /保存|提交|生成|新增|补录|审核|审版|审价|派单|绑定|退回|放行|删除|覆盖|改价|改料|编辑|上传|创建|建单|下单|确认结束|通过|驳回|拒绝|结束/
const CREATE_MACRO_RE = /createQuickTask|quickTask|建单|造数|派单|dispatch|reassign|\bbind\b|submit|proxy|append|redo|complete|fxCreate|create[A-Z]/i
const SEARCH_HINT_RE = /搜索|查询|定位|筛选|search|filter/i   // 搜索/筛选类 fill 不算被测写动作
// 一个 expectation（含嵌套 composite）里有没有「值/区分度」信号（equals/changed/… / text-absent / assertCount / assertDom 带比较 / networkResponse 带 body 值）
function expectationHasValueSignal(exp) {
  if (exp == null || typeof exp !== 'object') return false
  const VALUE_KEYS = new Set(['equals', 'changed', 'unchanged', 'increased', 'decreased', 'notEquals', 'count', 'assertCount', 'min', 'max', 'atLeast', 'atMost', 'gt', 'lt', 'gte', 'lte'])
  const VALUE_OPS = new Set(['equals', 'notequals', 'changed', 'unchanged', 'increased', 'decreased', 'gt', 'lt', 'gte', 'lte', 'count', 'atleast', 'atmost'])
  let found = false
  const walk = x => {
    if (found || x == null) return
    if (Array.isArray(x)) { x.forEach(walk); return }
    if (typeof x !== 'object') return
    const kind = String(x.kind || '').toLowerCase()
    const op = String(x.operator || x.op || '').toLowerCase()
    if (kind === 'text-absent') found = true                                  // absent 对照 = 区分度
    if (op && VALUE_OPS.has(op)) found = true
    for (const k of Object.keys(x)) { if (VALUE_KEYS.has(k)) found = true }
    if (kind === 'assertdom' && (x.property || x.attribute) && (x.expected != null || op)) found = true   // 断 class/属性值
    if (!found) for (const v of Object.values(x)) walk(v)
  }
  walk(exp)
  return found
}
// 抽一个 case 的可 lint 特征
function caseLintFeatures(c) {
  const steps = Array.isArray(c.steps) ? c.steps : []
  const fixtures = Array.isArray(c.fixtures) ? c.fixtures : []
  const fxRaw = JSON.stringify(fixtures)
  let hasAssertion = false, hasValueAssertion = false, hasMutation = false, hardcodedSpu = null, hasLayoutAssertion = false
  // 只承认真实 fixture/arrange 声明；标题、注释或 lintAck 里写一个 create 字样不能再骗过 linter。
  const usesCreateMacro = CREATE_MACRO_RE.test(fxRaw) || CREATE_MACRO_RE.test(JSON.stringify(c.arrange || {}))
  for (const s of steps) {
    const action = String(s.action || s.type || '').toLowerCase()
    const title = String(s.stepTitle || s.title || '')
    const val = String(s.value || (s.target && s.target.value) || '')
    // 排版断言（猪猪 v1.11 assertLayout）：从渲染盒子量出来的「两两不相交 / 不截断」——是能区分对错的数值判据，算值断言
    if (action === 'assertlayout') { hasAssertion = true; hasValueAssertion = true; hasLayoutAssertion = true }
    // 断言步
    if (s.expectation || action === 'assertvisible' || action === 'assertdom' || action === 'capture') {
      hasAssertion = true
      if (expectationHasValueSignal(s.expectation) || action === 'assertdom' && (s.property || s.attribute)) hasValueAssertion = true
    }
    // 被测写动作：fill/upload/select/check（但搜索/筛选类 fill 不算），或 click/press 且标题含变更动词
    if (['uploadfile', 'select', 'check'].includes(action)) hasMutation = true
    if (action === 'fill' && !SEARCH_HINT_RE.test(title)) hasMutation = true
    if ((action === 'click' || action === 'press') && MUTATION_VERB_RE.test(title)) hasMutation = true
    // 硬编码 SPU/供应商号字面量（非 {{token}}）→ 翻库信号
    if (!val.includes('{{') && SPU_LITERAL_RE.test(val)) hardcodedSpu = (val.match(SPU_LITERAL_RE) || [''])[0]
  }
  return { hasAssertion, hasValueAssertion, hasMutation, usesCreateMacro, hardcodedSpu, hasLayoutAssertion }
}

function validateQaTrace(c) {
  const trace = c && c.qaTrace
  if (!trace || typeof trace !== 'object') return ['缺 qaTrace：content case 必须声明 arrange/act/assert 的数据血缘']
  const arrange = trace.arrange || {}, act = trace.act || {}, assertion = trace.assert || {}
  const errors = []
  if (!arrange.provenance) errors.push('qaTrace.arrange.provenance 缺失')
  if (!arrange.entityRef) errors.push('qaTrace.arrange.entityRef 缺失')
  if (!act.operationId) errors.push('qaTrace.act.operationId 缺失')
  if (!act.entityRef) errors.push('qaTrace.act.entityRef 缺失')
  if (!assertion.oracle) errors.push('qaTrace.assert.oracle 缺失')
  if (!assertion.entityRef) errors.push('qaTrace.assert.entityRef 缺失')
  const refs = [arrange.entityRef, act.entityRef, assertion.entityRef].filter(Boolean).map(String)
  if (new Set(refs).size > 1) errors.push('qaTrace 的 Arrange/Act/Assert entityRef 不一致')
  return errors
}
// lint 单个用例文件 → findings[]。facetClass: {facetId:'presence'|'content'}（来自菲菲 facet 表分类列）；
// content 类（写字段/改状态/算值）严格：unacked 判 error（阻断）；presence 类或未知类：judged 判 warn（surfaced 不阻断）。
function lintTestFile(testJson, opts = {}) {
  const facetClass = opts.facetClass || {}
  // {facetId: 'ui'|'api'|'source'|'any'}：facet 的期望通道（facet_doc 的「通道」列/推断）。排版类豁免只认 ui。
  const facetVia = opts.facetVia || {}
  const cases = Array.isArray(testJson && testJson.cases) ? testJson.cases : []
  const findings = []
  for (const c of cases) {
    const id = String(c.id || c.caseId || '(no-id)')
    const f = caseLintFeatures(c)
    const ack = c.lintAck || {}
    // 该 case 覆盖的 facet 里，有没有 content 类（决定 error vs warn）
    const covers = (c.coversFacets || c.covers || []).map(s => String(s).toUpperCase())
    const unknownFacets = covers.filter(fid => !Object.prototype.hasOwnProperty.call(facetClass, fid))
    for (const fid of unknownFacets) findings.push({ caseId: id, code: 'FACET_UNKNOWN', severity: 'error', acked: false, ackReason: '', msg: `coversFacets 包含不在权威 facet_doc 的 ${fid}` })
    const isContent = covers.some(fid => (facetClass[fid] || 'unknown') === 'content')
    const sev = isContent ? 'error' : 'warn'
    const add = (code, msg, ackKey) => {
      const acked = !!ack[ackKey]
      findings.push({ caseId: id, code, severity: sev, acked, ackReason: acked ? String(ack[ackKey]) : '', msg })
    }
    // G2 翻库：硬编码 SPU 字面量 + 没用造数 macro
    if (f.hardcodedSpu && !f.usesCreateMacro) add('DB_FISHING', `数据来自硬编码业务号「${f.hardcodedSpu}」且无造数 macro——疑翻库找现成数据。改用 createQuickTask/flow macro 造数；确须借存量只能走独立风险审批，lintAck 不豁免`, 'borrowExisting')
    // G3 无被测动作：有断言但零 mutation/create（纯 search+open+assert）
    // 排版类例外（迷糊 2026-10-21 需求单·REQ-0400-F1~F3）：版式本身就是被测结果，没有写动作可做。
    // 豁免条件全部机读、缺一不豁免（fail-closed）：① case 里有 assertLayout（数值版式断言，不是存在性）；
    // ② 它覆盖的**每条** facet 期望通道都是 ui（facet_doc「通道」列或推断）——写类/接口类 facet 塞一条 assertLayout 骗不过；
    // ③ 未传 facetVia（老调用方）时不豁免。
    const layoutExempt = f.hasLayoutAssertion && covers.length > 0 && covers.every(fid => facetVia[fid] === 'ui')
    if (f.hasAssertion && !f.hasMutation && !f.usesCreateMacro && !layoutExempt) add('NO_ACTION', `只 search+open+断言、没有任何被测写动作/造数（AAA 缺 Arrange+Act）——是在验既成态、不是验功能产生的结果。写类需求必须真做被测动作；例外走独立风险审批，lintAck 不豁免`, 'readOnly')
    // G4 只验存在：有断言但全是 presence、无值/反事实
    if (f.hasAssertion && !f.hasValueAssertion) add('PRESENCE_ONLY', `断言全是"元素/文本存在"、无一个值比较或反事实(equals/changed/unchanged/text-absent)——正确与错误实现下都会绿(假绿灯)。补一个能区分对错的值断言；例外走独立风险审批，lintAck 不豁免`, 'presenceOnly')
    if (isContent) {
      for (const msg of validateQaTrace(c)) findings.push({ caseId: id, code: 'TRACE_INVALID', severity: 'error', acked: false, ackReason: '', msg })
    }
  }
  const blocking = findings.filter(x => x.severity === 'error')
  return { findings, blocking, clean: blocking.length === 0, total: cases.length }
}

// facet 全集 → {facetId: 'presence'|'content'} 断言类映射（linter 严格度用）
function facetClassMap(facets) {
  const m = {}
  for (const f of (facets || [])) m[String(f.id).toUpperCase()] = f.cls || 'content'
  return m
}
// facet 全集 → {facetId: via} 期望通道映射（linter 的排版类豁免用）
function facetViaMap(facets) {
  const m = {}
  for (const f of (facets || [])) m[String(f.id).toUpperCase()] = f.via || inferFacetVia({ kind: f.kind || '', criterion: f.criterion || '' })
  return m
}
// lint 单个 case（供 reconcile/set_facet_coverage 在「置 GREEN」那一刻校验有效性）→ {clean, blocking[]}
function lintCase(c, facetClass, facetVia) {
  const r = lintTestFile({ cases: [c] }, { facetClass: facetClass || {}, facetVia: facetVia || {} })
  return { clean: r.clean, blocking: r.blocking, findings: r.findings }
}

export {
  COVERAGE_STATUS_ENUM, FACET_ID_RE, COVERAGE_HEADER, COVERAGE_SEP,
  extractFacetsFromDoc, facetDocList, mergeFacetSets, extractCoverageMatrix, engineSetFacetRow, engineSeedCoverage, engineSetGate, computeCoverage, reqsWithValidGreen, validateArchive,
  rollupReqFacets, mergeFacetRows, reconcileCoverage, caseFacetMapFromTestFile,
  lintTestFile, caseLintFeatures, expectationHasValueSignal, facetClassMap, facetViaMap, lintCase,
  parseEvidenceFields, validateMachineEvidence, validateQaTrace,
  VIA_ENUM, normVia, inferFacetVia, inferFacetViaDetailed, caseChannel, viaSatisfies,
}
