// ============================================================================
// 视觉初筛（visual prescreen）—— 2026-10-06 老板拍板
//
// 缘起：批量管理 v0.1.0（REQ-0368）09-25~09-29 老板预检打回界面 13 次左右，
// 其中约一半是「档位名被挤成一字一行」「底栏遮住表格末行」「抽屉内容贴标题栏」「核对页全是无图」
// 「浮层闪滚动条」这类**一眼可见**的毛病。查下来迷糊全程没打开过页面——流程是
// 「GG Bond 开发 → 老板人工预检 → 迷糊 QA」，预检没过她就不许碰，于是**老板成了第一道视觉关**。
//
// 对策：在老板预检前加一道「迷糊视觉初筛」。GG Bond 开发完先交迷糊，她用真实浏览器逐页截图、
// **拿示例项目当母版对照 + 按业内 UI/UX 准则逐维诊断**，有高危就打回 GG Bond，过了才由她交老板预检。
//
// 2026-10-22 老板再定：有了视觉初筛，**人工预检门整个撤掉**——初筛通过直接进迷糊正式 QA，
// 老板改在 QA 之后做「最终验收」（看已测版本 + go/no-go，同守航态）。唯一例外：本版约定「老板亲测、
// 迷糊不做 QA」（如 Temu 报名助手，紫鸟无测试环境）——初筛通过后交老板亲测（【等你拍板】老板亲测）。
//
// 它和已有几档的分工（别串）：
//   · `page_scan`（一眼巡检）判「数据/内容不正常」（重复、矛盾、算不平、脏数据）——不判设计；
//   · `aesthetic_review`（审美 rubric）判「像不像示例项目一家人」，绑猪猪会话素材；
//   · 本模块判「**这页交给老板之前，设计和交互上站不站得住**」：母版对照 + 业内准则，
//     入口是任意截图（不锁猪猪会话——初筛阶段还没写用例），出口是「通过 / 打回」。
//
// 三条硬边界（区别于"AI 看一眼说挺好"）：
//   ① **看图门**：报上来的每页截图，必须在本轮真的被 Read 过（引擎从工具流记账，不是自报）；
//      母版有截图时，至少要看过一张母版图——没对照过母版就谈不上「像不像」。
//   ② **逐维作答**：每页对每个诊断维度都要写一句「看到了什么」，空话（无/正常/符合/OK）打回。
//      「符合、零问题」可以是结论，但必须是逐维看过之后的结论。
//   ③ **发现要落地**：每条发现要指认页面、写看到的现象、写本该怎样、写依据（母版哪一型 / 业内哪条），
//      并给可执行建议——初筛结果直接交 GG Bond 改，说不出怎么改的不算。
//
// 纯函数、无 fs、无网络，便于 `node --test`。fs 读母版文档、记账 Read 足迹都在 server.js。
// ============================================================================

// ---------- 诊断维度：业内准则 × 示例项目母版 ----------
// 来源都是业内公认、可查的准则（Nielsen 十原则 / WCAG 2.2 / Ant Design 设计规范 / Linear 与 no-slop 的克制风格），
// 不自造。每条的 `ask` 都落到 B 端后台页面能看到的具体现象上；`mother` 写母版里对应的参照方式。
// 前 5 条是 Temu 那 13 次打回里实际出现过的问题类型（逐条对得上），其余是业内准则里 B 端最常见的缺口。
export const PRESCREEN_DIMENSIONS = [
  { key: 'layout-fit', label: '布局与容器', source: 'WCAG 2.2 · 1.4.10 Reflow / 1.4.12 Text Spacing', severity: '高',
    ask: '有没有文字被挤成竖排/一字一行、被截断、溢出容器、元素互相遮挡？固定栏（底栏/顶栏）会不会盖住内容的最后一行？窗口变窄时还成立吗？',
    mother: '对照母版同类容器（表单行、抽屉、底栏）在同宽度下的排布' },
  { key: 'spacing', label: '间距与留白', source: 'Ant Design · 间距（8px 基础网格，常用 8/16/24）', severity: '中',
    ask: '容器内边距是否一致？内容有没有贴着标题栏/边框？同级块之间的距离是否相同？有没有莫名的大片空白？',
    mother: '对照母版抽屉/弹窗/卡片的内边距与区块间距' },
  { key: 'consistency', label: '与母版一致', source: 'Nielsen #4 一致性与标准', severity: '中',
    ask: '同一种东西（筛选区、主表格、弹窗、抽屉、操作按钮位置、状态标签、金额展示、叫法）是不是和示例项目一个做法？哪个一眼看出是"外来的"？',
    mother: '逐型对照母版：筛选区 / 主表格 / 行操作 / 弹窗表单 / 抽屉 / 底栏 / 状态标签 / 金额数字' },
  { key: 'hierarchy', label: '信息层级', source: 'Ant Design · 设计价值观（确定性）/ Linear 克制风格', severity: '中',
    ask: '一屏是否只有一个最显眼的主操作？主/次/弱信息分得开吗？关键数字与结论有没有被淹没，辅助说明有没有抢戏？',
    mother: '对照母版页面主操作的位置与按钮层级' },
  { key: 'data-display', label: '数据表格与数字', source: 'Ant Design · 数据展示（表格）规范', severity: '中',
    ask: '数字/金额右对齐、精度与单位统一、同类金额同一字体吗？列头看得懂（必要时有说明）、不截断？表格有没有横向滚动、一屏放不下的关键列？图片列缺图时有占位吗？',
    mother: '对照母版主表格的列宽、对齐、金额列与图片列' },
  { key: 'feedback', label: '状态反馈', source: 'Nielsen #1 系统状态可见', severity: '中',
    ask: '加载中、空数据、成功、失败各有清楚的提示吗？空态有没有告诉用户下一步做什么？操作后用户能看出发生了什么？',
    mother: '对照母版的空态、加载态与操作结果提示' },
  { key: 'error-prevention', label: '防错与可撤回', source: 'Nielsen #3 用户控制 / #5 防错', severity: '高',
    ask: '不可逆或影响面大的操作有没有二次确认、确认文案写清后果？没保存就关闭会不会丢东西？禁用的按钮有没有说明为什么不能点？',
    mother: '对照母版危险操作的确认弹窗与未保存提示' },
  { key: 'recognition', label: '一看就懂', source: 'Nielsen #6 识别而非回忆 / #2 贴近用户语言', severity: '低',
    ask: '字段、列头、按钮用的是业务语言吗？有没有技术词、英文键名、要靠记忆才懂的缩写？需要解释的地方有就近说明吗？',
    mother: '对照母版的叫法（同一个业务概念别换词）' },
  { key: 'minimalism', label: '简洁克制', source: 'Nielsen #8 简约设计 / no-slop-ui 规范', severity: '低',
    ask: '有没有为装饰而装饰（渐变、发光、阴影堆叠、无意义图标/emoji）？文案是不是够短？同一信息有没有在一屏里重复说两遍？',
    mother: '对照母版的视觉克制程度' },
  { key: 'color-contrast', label: '色彩与对比', source: 'WCAG 2.2 · 1.4.3 对比度（正文 ≥ 4.5:1）', severity: '中',
    ask: '颜色只用来表达语义（主操作/危险/成功/禁用）吗？浅灰字在白底上看得清吗？同一语义在本页与母版是同一个颜色吗？',
    mother: '对照母版的语义色用法' },
  { key: 'task-flow', label: '任务流程', source: 'Nielsen #7 效率 / Ant Design · 自然', severity: '中',
    ask: '完成主任务要几步？下一步在哪一眼能找到吗？批量操作、默认值是否省掉了重复劳动？有没有走到死胡同（没有返回/取消）？',
    mother: '对照母版同类任务的步骤数与默认值' },
]
export const dimensionOf = key => PRESCREEN_DIMENSIONS.find(d => d.key === key) || null

export const PRESCREEN_VERDICTS = { PASS: '通过', REJECT: '打回' }
const SEVERITIES = ['高', '中', '低']

// 「看到了什么」里的空话：这些写法等于没看。逐维作答的意义就是逼出具体观察。
const HOLLOW = /^(无|没有|暂无|无问题|没问题|正常|符合|符合规范|符合要求|ok|okay|good|pass|通过|一致|良好|无异常|-|—|\/|n\/a|na)[。.!！]?$/i
export const MIN_NOTE_LEN = 6
export function isHollowNote(s) {
  const t = String(s || '').trim()
  return !t || HOLLOW.test(t) || t.length < MIN_NOTE_LEN
}

// 截图路径归一：工具流里的 Read 可能是 `D:\x\y.png`、`D:/x/y.png`、`/d/x/y.png` 三种写法。
export function normShotPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/')
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/)
  if (m) s = `${m[1]}:/${m[2]}`
  return s.toLowerCase()
}
export const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i
export const isImagePath = p => IMAGE_EXT.test(String(p || ''))

// ---------- 母版文档解析 ----------
// 母版 = `示例项目-UI母版.md` 里的一张表：| 型号 key | 场景 | 母版页面 | 截图 | 要点 |
// 只认第一列是 kebab-case key 的行；截图列可以写多个路径（逗号/顿号/<br> 分隔）。空截图的行如实算「未采」。
export function parseMotherDoc(md = '') {
  const patterns = []
  for (const line of String(md).split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    if (cells.length < 5) continue
    const key = cells[0].replace(/`/g, '')
    if (!/^[a-z][a-z0-9-]*$/.test(key)) continue
    const shots = cells[3].replace(/`/g, '').split(/<br\s*\/?>|[,，、;；]/).map(s => s.trim()).filter(s => s && isImagePath(s))
    patterns.push({ key, scene: cells[1], page: cells[2], shots, points: cells[4] })
  }
  return { patterns, shotCount: patterns.reduce((n, p) => n + p.shots.length, 0), missing: patterns.filter(p => !p.shots.length).map(p => p.key) }
}

// ---------- 素材页 ----------
export function renderPrescreenMaterial({ pages = [], mother = null, motherPath = '', baselineSummary = '' } = {}) {
  const L = ['### 视觉初筛素材（你要逐页看图、对照母版、逐维作答）', '']
  L.push('**本次要初筛的页面**')
  if (pages.length) for (const p of pages) L.push(`- ${p.page}${p.screenshot ? `：\`${p.screenshot}\`` : ''}`)
  else L.push('- （还没给截图——先用浏览器把每个改动页面/状态截下来，再带 `pages` 调一次）')
  L.push('')
  if (mother && mother.patterns.length) {
    L.push(`**母版：示例项目**（\`${motherPath}\`，${mother.patterns.length} 型、${mother.shotCount} 张截图）——"像不像一家人"就跟它比`)
    for (const p of mother.patterns) L.push(`- \`${p.key}\` ${p.scene}（${p.page || '—'}）：${p.shots.length ? p.shots.map(s => `\`${s}\``).join('、') : '⚠ 未采截图'}${p.points ? ` —— ${p.points}` : ''}`)
    if (mother.missing.length) L.push(`> ⚠ 母版里 ${mother.missing.length} 型还没截图（${mother.missing.join('、')}）——这几型只能按业内准则判，报告里要写明。`)
  } else {
    L.push(`⚠ **母版缺位**：\`${motherPath || '示例项目-UI母版.md'}\` 不存在或一型都没登记。本次只能按业内准则判，**报告里必须写明「未对照母版」**；建母版的做法见工牌 §C3.12。`)
  }
  if (baselineSummary) { L.push(''); L.push(baselineSummary) }
  L.push('')
  L.push('**诊断维度（每页逐条答，答的是"看到了什么"，不是"有没有问题"）**')
  for (const d of PRESCREEN_DIMENSIONS) L.push(`- **${d.label}**（\`${d.key}\`·默认${d.severity}危·${d.source}）：${d.ask} 〔母版：${d.mother}〕`)
  L.push('')
  L.push('**提交要求（`visual_prescreen_verdict`，机器逐条校验）**：')
  L.push('1. 每页截图必须本轮真的 `Read` 过（引擎记账，不是自报）；母版有截图时至少看过一张。')
  L.push(`2. 每页对上面 ${PRESCREEN_DIMENSIONS.length} 个维度都写一句看到了什么（≥${MIN_NOTE_LEN} 个字；「无/正常/符合/OK」这类空话打回）。`)
  L.push('3. 每条发现：页面 + 维度 + 看到的现象 + 本该怎样 + 依据（母版哪一型 / 业内哪条）+ 可执行建议 + 高/中/低。')
  L.push('4. 有一条「高」就只能判「打回」。')
  return L.join('\n')
}

// ---------- 结论校验 ----------
// ctx.readShots：本轮工具流里真被 Read 过的图片（归一化路径集合）；ctx.motherShots：母版截图清单。
export function validatePrescreenVerdict({ verdict = '', pages = [], findings = [] } = {}, { readShots = new Set(), motherShots = [] } = {}) {
  const errors = [], rejected = [], accepted = []
  const read = readShots instanceof Set ? readShots : new Set([...(readShots || [])].map(normShotPath))
  if (!Object.values(PRESCREEN_VERDICTS).includes(String(verdict))) errors.push(`verdict 必须是「${PRESCREEN_VERDICTS.PASS}」或「${PRESCREEN_VERDICTS.REJECT}」`)
  const pageList = Array.isArray(pages) ? pages : []
  if (!pageList.length) errors.push('一页都没报——初筛的对象是页面，至少报一页（截图 + 逐维观察）')
  const pageNames = new Set()
  for (const p of pageList) {
    const name = String(p?.page || '').trim()
    if (!name) { errors.push('有一页没写 `page`（页面/状态名）'); continue }
    pageNames.add(name)
    const shots = (Array.isArray(p.screenshots) ? p.screenshots : [p.screenshot]).filter(Boolean)
    if (!shots.length) { errors.push(`「${name}」没给截图——初筛必须基于真实渲染出来的页面`); continue }
    const unread = shots.filter(s => !read.has(normShotPath(s)))
    if (unread.length) errors.push(`「${name}」有 ${unread.length} 张截图本轮没 Read 过（${unread.slice(0, 2).map(s => `\`${s}\``).join('、')}）——没看过的图不能出结论`)
    const notes = p.notes && typeof p.notes === 'object' ? p.notes : {}
    const hollow = PRESCREEN_DIMENSIONS.filter(d => isHollowNote(notes[d.key])).map(d => d.label)
    if (hollow.length) errors.push(`「${name}」有 ${hollow.length} 个维度没写出看到了什么：${hollow.join('、')}（空话、少于 ${MIN_NOTE_LEN} 个字都算没写）`)
  }
  const mothers = (motherShots || []).map(normShotPath)
  if (mothers.length && !mothers.some(m => read.has(m))) errors.push('母版有截图，但本轮一张都没 Read 过——没对照母版，「与母版一致」这一维就是空判')
  for (const f of (Array.isArray(findings) ? findings : [])) {
    const d = dimensionOf(f?.dimension)
    if (!d) { rejected.push({ ...f, reason: `dimension 不在诊断维度里（${PRESCREEN_DIMENSIONS.map(x => x.key).join('/')}）` }); continue }
    if (!pageNames.has(String(f?.page || '').trim())) { rejected.push({ ...f, reason: `page「${f?.page || ''}」不在本次报的页面里——发现要落在看过的页面上` }); continue }
    if (!String(f?.observed || '').trim()) { rejected.push({ ...f, reason: '没写 observed（看到了什么现象）' }); continue }
    if (!String(f?.expected || '').trim()) { rejected.push({ ...f, reason: '没写 expected（本该怎样）' }); continue }
    if (!String(f?.reference || '').trim()) { rejected.push({ ...f, reason: '没写 reference（依据：母版哪一型，或业内哪条准则）——没依据就是个人喜好' }); continue }
    if (!String(f?.suggestion || '').trim()) { rejected.push({ ...f, reason: '没写 suggestion（怎么改）——初筛结果直接交开发改，说不出改法的开发没法动手' }); continue }
    const severity = SEVERITIES.includes(f?.severity) ? f.severity : d.severity
    accepted.push({ ...f, severity, dimensionLabel: d.label })
  }
  const high = accepted.filter(f => f.severity === '高').length
  if (String(verdict) === PRESCREEN_VERDICTS.PASS && high) errors.push(`有 ${high} 条「高」危发现却判「通过」——高危只能打回 GG Bond 改完再筛`)
  if (String(verdict) === PRESCREEN_VERDICTS.REJECT && !accepted.length) errors.push('判「打回」却没有一条通过校验的发现——打回要给开发能照着改的清单')
  const counts = { 高: high, 中: accepted.filter(f => f.severity === '中').length, 低: accepted.filter(f => f.severity === '低').length }
  return { ok: !errors.length && !rejected.length, errors, accepted, rejected, counts, pages: pageList.length }
}

export function renderPrescreenVerdict({ verdict = '', pages = [] } = {}, val, { motherMissing = false } = {}) {
  const L = ['### 视觉初筛结论', '']
  L.push(`结论：**${verdict || '?'}**　｜　${val.pages} 页　｜　发现 高 ${val.counts.高} · 中 ${val.counts.中} · 低 ${val.counts.低}${motherMissing ? '　｜　⚠ 未对照母版（母版缺位）' : ''}`)
  if (val.accepted.length) {
    L.push('')
    L.push('| 危 | 页面 | 维度 | 看到的 | 本该 | 依据 | 建议 |')
    L.push('|----|------|------|--------|------|------|------|')
    const cell = s => String(s || '').replace(/\|/g, '/').replace(/\n/g, ' ')
    const order = { 高: 0, 中: 1, 低: 2 }
    for (const f of [...val.accepted].sort((a, b) => order[a.severity] - order[b.severity])) {
      L.push(`| ${f.severity} | ${cell(f.page)} | ${f.dimensionLabel} | ${cell(f.observed)} | ${cell(f.expected)} | ${cell(f.reference)} | ${cell(f.suggestion)} |`)
    }
  }
  if (Array.isArray(pages) && pages.length) {
    L.push('')
    L.push('<details><summary>逐页逐维观察</summary>')
    L.push('')
    for (const p of pages) {
      L.push(`**${p.page}**`)
      for (const d of PRESCREEN_DIMENSIONS) L.push(`- ${d.label}：${String(p.notes?.[d.key] || '').trim() || '（未写）'}`)
      L.push('')
    }
    L.push('</details>')
  }
  if (val.rejected.length) { L.push(''); L.push(`**被机器打回 ${val.rejected.length} 条（不进结论）**`); for (const f of val.rejected) L.push(`- ${f.reason}`) }
  if (val.errors.length) { L.push(''); for (const e of val.errors) L.push(`⛔ ${e}`) }
  return L.join('\n')
}

// ---------- 收工判定用 ----------
// 「交老板（预检 / 亲测）」：初筛之后、QA 之前就把活交到老板手里的收工。
export const isPrecheckGateItem = item => /人工预检|老板亲测/.test(String(item || ''))
// 已撤销的人工预检门（2026-10-22）：再写【等你拍板】人工预检 一律退回，改交迷糊 QA。
export const isRetiredPrecheckGate = item => /人工预检/.test(String(item || ''))
// 合法例外：本版约定老板亲测、迷糊不做 QA。
export const isBossSelfTestGate = item => /老板亲测/.test(String(item || ''))
// GG Bond 显式声明「本次没有界面改动、视觉初筛不适用」——引擎放行，但要写理由。
export function prescreenNotApplicable(text = '') {
  const m = String(text).match(/视觉初筛[：:]\s*不适用[（(]?([^\n）)]*)/)
  if (!m) return null
  const why = (m[1] || '').trim()
  return why.length >= 4 ? why : null
}
