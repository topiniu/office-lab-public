// ============================================================================
// 示例项目「模块 UX 契约」静态检查（2026-09-08 老板拍板 · 方案 A）
//
// 缘起（老板原话）：「示例项目里面 upload 是支持粘贴的，ggbond 新开发的页面一定不会注意到这个特性，
// 还有 modal 快捷键提交功能，ggbond 也不会注意到，这些都属于示例项目模块沉淀下来的 ux 准则」。
//
// 查实（2026-09-08，前端源码计数）：两条约定都真实存在、都已有**共享实现**，但模块自己就没统一——
//   · Upload 支持粘贴：`hooks/useClipboardImages.ts` + `components/PasteImages/` → **12/18 个 Upload**
//   · Modal ⌘/Ctrl+Enter 提交：`samplingWorkflow/components/modalShortcut.tsx` 的 `useCommandEnterSubmit`
//     （配 `renderModalOkText` 在确认按钮上显示快捷键提示）→ **33/60 个含 Modal 的文件**
// 采纳率才 67% / 55%，所以「新页面会漏」不是可能、是必然，而在此之前**没有任何机制会发现它**。
//
// 为什么是静态检查而不是 E2E（两条路我都查了）：
//   · 视觉验收那三层（模块 token 基线 / 量化指标 / 审美 rubric）**全部只看静态渲染态**，
//     而 `onPaste`、`useCommandEnterSubmit` 是 React handler，既不在 computed style、也不在 DOM 属性、
//     也不在截图里 —— 素材包压根采不到，不是判据没写好。
//   · 猪猪当前 19 个 step type 里**没有 press / keyboard / paste / hover** —— 组合键按不下去、
//     剪贴板塞不进去，行为用例这条路当前是堵死的（已另开需求单）。
//   · 而静态检查**全覆盖**（18 个 Upload 一个不漏，E2E 不可能每个都跑）、**便宜**、
//     且能**左移到 GG Bond 交接前**——他改完当场知道漏了什么，不必等到 QA。
//
// 判据口径（与模块设计基线同一条）：**数出来的多数，不是我编的规则**。
// 每条契约都报「模块里 N/M 这么做」，采纳率低于门槛时自动降级成「候选·先统一再当契约」，
// 而不是拿一条我拍的规矩去打人。
//
// 诚实边界（必须随结论一起说）：检测是**源码正则**，不是 AST——
//   · 可能误报（把注释里的 `<Modal` 当使用）、可能漏报（换了别名导入）；
//   · 所以每条命中都带**证据行**，人一眼能核；
//   · 确有正当例外时在源码里写 `// ux-contract-ack: <契约key> <理由>`，检查器认这行并如实列成「已申诉」，
//     **它只记录、不改变采纳率统计**（同 lintAck 的精神：申诉不等于豁免）。
//
// 纯函数、无 fs（文件内容由调用方读入），便于 `node --test`。
// ============================================================================

export const ADOPTION_CONVENTION = 0.6      // ≥60% 视为「已沉淀的约定」，可用来判新代码
export const ADOPTION_CANDIDATE = 0.3       // 30%~60%：候选，先统一存量再当契约用

const has = (src, re) => re.test(src)
const firstMatchLine = (src, re) => {
  for (const [i, line] of String(src).split('\n').entries()) if (re.test(line)) return { line: i + 1, text: line.trim().slice(0, 160) }
  return null
}

// ---------- 契约清单 ----------
// 只收「applies 判据可靠」的：能明确说出"这个文件该不该守这条"。判不可靠的一律不做成契约，
// 走 discoverCandidates() 列成候选让老板拍——**宁可少一条契约，不要多一条会误伤的规矩**。
export const UX_CONTRACTS = [
  {
    key: 'upload-paste',
    label: 'Upload 支持粘贴上传',
    why: '示例项目里图片素材大多来自截图/聊天窗，粘贴是主路径；只能点选择文件的上传区，用起来会明显比隔壁难用',
    shared: 'hooks/useClipboardImages.ts · components/PasteImages/',
    applies: src => has(src, /<Upload[\s/>]|Upload\.Dragger/),
    satisfies: src => has(src, /onPaste|useClipboardImages|PasteImages/),
    evidenceRe: /onPaste|useClipboardImages|PasteImages/,
    appliesRe: /<Upload[\s/>]|Upload\.Dragger/,
    suggest: '接 `useClipboardImages`（或复用 `PasteImages` 组件），让上传区能直接 ⌘/Ctrl+V 粘贴图片',
  },
  {
    key: 'modal-cmd-enter',
    label: 'Modal 支持 ⌘/Ctrl+Enter 提交',
    why: '模块里过半弹窗都能键盘提交；新弹窗不支持时，习惯了快捷键的人会以为「没反应」',
    shared: 'pages/samplingWorkflow/components/modalShortcut.tsx → useCommandEnterSubmit',
    applies: src => has(src, /<Modal[\s/>]/),
    satisfies: src => has(src, /useCommandEnterSubmit|modalShortcut/),
    evidenceRe: /useCommandEnterSubmit|modalShortcut/,
    appliesRe: /<Modal[\s/>]/,
    suggest: '接 `useCommandEnterSubmit`（modalShortcut.tsx），绑定 ⌘/Ctrl+Enter 触发与确认按钮同一个提交动作',
  },
  {
    key: 'modal-shortcut-hint',
    label: '绑了快捷键就要在确认按钮上显示提示',
    why: '快捷键不可见等于不存在——绑了却不提示，只有知道的人用得上；这条与上一条是配套的',
    shared: 'modalShortcut.tsx → renderModalOkText / renderModalShortcutText',
    applies: src => has(src, /useCommandEnterSubmit/),
    satisfies: src => has(src, /renderModalOkText|renderModalShortcutText/),
    evidenceRe: /renderModalOkText|renderModalShortcutText/,
    appliesRe: /useCommandEnterSubmit/,
    suggest: '确认按钮文案改用 `renderModalOkText`，把「Enter」提示显示出来',
  },
  {
    key: 'page-breadcrumb',
    label: '页面入口使用统一面包屑头',
    why: '模块内页面头部结构一致，是「像不像一家人」最先被看到的一层',
    shared: 'components/BreadcrumbHeader',
    applies: (src, file) => /pages[\\/]sampling[^\\/]*[\\/]index\.tsx$/i.test(String(file || '')),
    satisfies: src => has(src, /BreadcrumbHeader/),
    evidenceRe: /BreadcrumbHeader/,
    appliesRe: /BreadcrumbHeader/,
    suggest: '页面头部改用 `@/components/BreadcrumbHeader`，与模块其它页面一致',
  },
]

// 源码里的申诉：`// ux-contract-ack: upload-paste 这个上传只收 PDF，粘贴无意义`
const ACK_RE = /ux-contract-ack:\s*([a-z0-9-]+)\s*(.*)$/i
export function ackOf(src, key) {
  for (const line of String(src || '').split('\n')) {
    const m = ACK_RE.exec(line)
    if (m && m[1].toLowerCase() === String(key).toLowerCase()) return String(m[2] || '').trim() || '(未写理由)'
  }
  return ''
}

// ---------- 作用域：模块内 vs 全站共享 ----------
// ⚠ **这一层是必须的，不是锦上添花**（2026-09-08 首次真扫时抓到）：
// 把全站 `components/` 一起算进采纳率，「Modal ⌘+Enter」是 31/59 = 53% → 判「候选级·不当硬要求」；
// 只看 `pages/sampling*` 则是 **31/39 = 79% → 约定级**。拖低它的是**全站共享组件里 20 个 Modal 一个都没绑**
// （0%）——那些组件别的模块也在用，**示例项目的约定管不到它们**。
// 不分作用域就会把一条真约定误判成候选，**等于放过**——比误报更坏。
export const SCOPE_MODULE = 'module', SCOPE_SHARED = 'shared'
export const defaultScopeOf = file => (/^pages[\\/]sampling/i.test(String(file || '')) ? SCOPE_MODULE : SCOPE_SHARED)

// ---------- 扫描：files = [{ file, src }] ----------
// 采纳率/等级**只按模块内（pages/sampling*）算**；全站共享命中的单列成 `sharedMissing`，
// 只作参考、不进分母——要不要给共享组件立约定，是更高层的事。
export const LEVEL_CONVENTION = 'convention', LEVEL_CANDIDATE = 'candidate', LEVEL_RARE = 'rare'
export function scanUxContracts(files = [], contracts = UX_CONTRACTS, { scopeOf = defaultScopeOf } = {}) {
  const byContract = {}
  for (const c of contracts) {
    const applies = [], satisfied = [], missing = [], sharedApplies = [], sharedMissing = []
    for (const f of (files || [])) {
      const src = String(f?.src || '')
      if (!c.applies(src, f?.file)) continue
      const inModule = scopeOf(f.file) === SCOPE_MODULE
      const ok = c.satisfies(src, f?.file)
      if (inModule) {
        applies.push(f.file)
        if (ok) satisfied.push({ file: f.file, evidence: firstMatchLine(src, c.evidenceRe) })
        else missing.push({ file: f.file, ack: ackOf(src, c.key), hit: firstMatchLine(src, c.appliesRe) })
      } else {
        sharedApplies.push(f.file)
        if (!ok) sharedMissing.push({ file: f.file, ack: ackOf(src, c.key), hit: firstMatchLine(src, c.appliesRe) })
      }
    }
    const adoption = applies.length ? satisfied.length / applies.length : 0
    byContract[c.key] = {
      key: c.key, label: c.label, why: c.why, shared: c.shared, suggest: c.suggest,
      applies, satisfied, missing, adoption, sharedApplies, sharedMissing,
      level: adoption >= ADOPTION_CONVENTION ? LEVEL_CONVENTION : adoption >= ADOPTION_CANDIDATE ? LEVEL_CANDIDATE : LEVEL_RARE,
    }
  }
  return { byContract, scanned: (files || []).length, moduleFiles: (files || []).filter(f => scopeOf(f.file) === SCOPE_MODULE).length }
}

// ---------- 判一批「本次改动的文件」----------
// 这是给 GG Bond 交接前自查、给迷糊验收复核用的：**只判本次改的文件**，
// 但把「模块里 N/M 这么做」作为判据一起带出来——不是拿一条规矩压人，是把模块惯例摆出来。
// `level` 决定语气：约定级 → ⚠ 该补；候选级 → · 提醒（模块自己都没统一，先别当硬要求）。
export function judgeChangedFiles(scan, changedFiles = []) {
  const set = new Set((changedFiles || []).map(String))
  const findings = []
  for (const c of Object.values(scan.byContract || {})) {
    const base = {
      contract: c.key, label: c.label, level: c.level, adoption: c.adoption,
      satisfiedCount: c.satisfied.length, appliesCount: c.applies.length,
      shared: c.shared, suggest: c.suggest, why: c.why,
    }
    for (const m of c.missing) {
      if (set.size && !set.has(m.file)) continue
      findings.push({ ...base, file: m.file, ack: m.ack, scope: SCOPE_MODULE, verdict: m.ack ? 'acked' : (c.level === LEVEL_CONVENTION ? 'missing' : 'hint') })
    }
    // 全站共享组件：只在「本次确实改了它」时提一句，且**明说示例项目的约定管不到它**
    for (const m of c.sharedMissing) {
      if (!set.size || !set.has(m.file)) continue
      findings.push({ ...base, file: m.file, ack: m.ack, scope: SCOPE_SHARED, verdict: 'cross-module' })
    }
  }
  findings.sort((a, b) => (a.verdict === b.verdict ? b.adoption - a.adoption : (a.verdict === 'missing' ? -1 : b.verdict === 'missing' ? 1 : 0)))
  return { findings, checkedFiles: set.size || null }
}

const pct = n => `${Math.round(n * 100)}%`
const LEVEL_BADGE = { [LEVEL_CONVENTION]: '约定', [LEVEL_CANDIDATE]: '候选', [LEVEL_RARE]: '零星' }

// ---------- 渲染：全模块盘点（产出《示例项目 UX 契约》那份清单） ----------
export function renderInventory(scan) {
  const L = ['### 示例项目 · 模块 UX 契约盘点', '', `扫描 ${scan.scanned} 个源文件（其中 ${scan.moduleFiles} 个属示例项目页面）。**采纳率是数出来的**：约定级（≥${pct(ADOPTION_CONVENTION)}）才用来判新代码；候选级先统一存量再当契约。`, '', `> 采纳率**只按 \`pages/sampling*\` 算**：全站 \`components/\` 里的同类元素单列，它们被别的模块也在用，**示例项目的约定管不到**。（把两者混算会把真约定误判成候选——首次真扫时就踩到：Modal 快捷键混算 53%「候选」，只看模块内则是 79%「约定」。）`, '']
  L.push('| 契约 | 模块内适用 | 已守 | 采纳率 | 等级 | 共享实现 |')
  L.push('|------|-----------|------|--------|------|----------|')
  for (const c of Object.values(scan.byContract)) {
    L.push(`| ${c.label} | ${c.applies.length} | ${c.satisfied.length} | **${pct(c.adoption)}** | ${LEVEL_BADGE[c.level]} | \`${c.shared}\` |`)
  }
  for (const c of Object.values(scan.byContract)) {
    if (!c.missing.length) continue
    L.push('')
    L.push(`#### 存量欠账 · ${c.label}（模块内 ${c.missing.length} 处）`)
    L.push(`> ${c.why}`)
    for (const m of c.missing) L.push(`- ${m.ack ? '〔已申诉〕' : ''}\`${m.file}\`${m.hit ? `（L${m.hit.line}）` : ''}${m.ack ? ` —— ${m.ack}` : ''}`)
    if (c.sharedMissing.length) L.push(`> 另有 **${c.sharedMissing.length}/${c.sharedApplies.length}** 个全站共享组件也没这么做（不进上面的采纳率）：${c.sharedMissing.slice(0, 6).map(m => '`' + m.file + '`').join('、')}${c.sharedMissing.length > 6 ? ' …' : ''} —— **要不要给共享组件立同样的约定，是跨模块的事，得更高层拍。**`)
  }
  L.push('')
  L.push('> 检测是**源码正则不是 AST**：可能把注释里的用法算进去、也可能漏掉换了别名的导入。每条都给了证据行，请一眼核。确有正当例外就在源码里写 `// ux-contract-ack: <契约key> <理由>` —— **它只记录、不改采纳率**（申诉不等于豁免）。')
  return L.join('\n')
}

// ---------- 渲染：本次改动自查 ----------
export function renderChangedCheck(j, scan) {
  const L = ['### 模块 UX 契约自查（本次改动）', '']
  const miss = j.findings.filter(f => f.verdict === 'missing')
  const hint = j.findings.filter(f => f.verdict === 'hint')
  const acked = j.findings.filter(f => f.verdict === 'acked')
  const cross = j.findings.filter(f => f.verdict === 'cross-module')
  if (!j.findings.length) {
    L.push(`✅ 本次改动涉及的文件，模块已沉淀的 UX 约定都守住了（检查 ${Object.keys(scan?.byContract || {}).length} 条契约）。`)
    return L.join('\n')
  }
  if (miss.length) {
    L.push(`⚠ **漏了 ${miss.length} 处模块约定**（这些不会红、不会报错，只有用的人会觉得"这页怎么比别处难用"）：`)
    L.push('')
    for (const f of miss) {
      L.push(`- **${f.label}** @ \`${f.file}\``)
      L.push(`  - 模块里 **${f.satisfiedCount}/${f.appliesCount}**（${pct(f.adoption)}）这么做了`)
      L.push(`  - 为什么：${f.why}`)
      L.push(`  - 怎么补：${f.suggest}（共享实现 \`${f.shared}\`）`)
    }
  }
  if (hint.length) {
    L.push('')
    L.push(`· 另有 ${hint.length} 处**候选级**提醒（模块自己采纳率也不高，先别当硬要求）：`)
    for (const f of hint) L.push(`  - ${f.label} @ \`${f.file}\`（模块 ${f.satisfiedCount}/${f.appliesCount}）`)
  }
  if (cross.length) {
    L.push('')
    L.push(`· 本次还改到 ${cross.length} 处**全站共享组件**——示例项目的约定管不到它们（别的模块也在用），仅列出供参考：`)
    for (const f of cross) L.push(`  - ${f.label} @ \`${f.file}\`（模块内同类 ${f.satisfiedCount}/${f.appliesCount} 这么做）`)
    L.push('  > 要给共享组件立同样的约定，是跨模块的事、得更高层拍——**不要在这里自行决定**。')
  }
  if (acked.length) {
    L.push('')
    L.push(`〔已申诉 ${acked.length} 处（记录在案，不改采纳率统计）〕`)
    for (const f of acked) L.push(`  - ${f.label} @ \`${f.file}\` —— ${f.ack}`)
  }
  return L.join('\n')
}

// ---------- 候选契约发现：被多少个模块文件共用的 hook/组件 ----------
// 不做成硬检查（applies 判据不可靠时宁可不判），只列出来给老板拍：
// 「这 15 个页面都用了 QueryPlaceholder，要不要把它也立成契约？」
export function discoverCandidates(files = [], { min = 5 } = {}) {
  const counts = new Map()
  const IMP = /from\s+['"](@\/(?:hooks|components)\/[A-Za-z0-9_/-]+)['"]/g
  for (const f of files || []) {
    const seen = new Set()
    for (const m of String(f?.src || '').matchAll(IMP)) seen.add(m[1])
    for (const s of seen) counts.set(s, (counts.get(s) || 0) + 1)
  }
  const known = new Set(UX_CONTRACTS.map(c => c.shared))
  return [...counts.entries()]
    .filter(([, n]) => n >= min)
    .map(([mod, n]) => ({ module: mod, files: n, alreadyContract: [...known].some(k => k.includes(mod.split('/').pop())) }))
    .sort((a, b) => b.files - a.files)
}
export function renderCandidates(list, scannedCount) {
  const L = ['### 候选契约（被多个模块文件共用，尚未立成契约）', '']
  if (!list.length) return L.concat(['（没有达到门槛的候选）']).join('\n')
  L.push(`共 ${scannedCount} 个文件里，这些共享实现被反复使用——**用得多说明是沉淀，值得考虑立成契约**：`)
  L.push('')
  L.push('| 共享实现 | 被多少个文件用 | 已是契约 |')
  L.push('|----------|----------------|----------|')
  for (const c of list) L.push(`| \`${c.module}\` | ${c.files} | ${c.alreadyContract ? '是' : '否'} |`)
  L.push('')
  L.push('> 之所以只列不判：这些的「该不该用」判据不可靠（没法只看源码就说清"这个文件本来就该用它"）。**宁可少一条契约，不要多一条会误伤的规矩**——要立哪条由老板拍，拍了我再补 applies 判据。')
  return L.join('\n')
}
