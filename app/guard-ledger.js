// ============================================================================
// 守航契约执行器 + 三红灯台账（方案 `vision-e2e/docs/lab-guarded-run-capability-plan.md` §1 E1）
//
// 缘起（方案原文 + v5.19 实测）：契约 yaml 里白纸黑字写着「越权 / 假绿 / 超轮次必须为 0」，
// 但四轮守航**一次都没统计过**——它只是 prompt 级授权 + 次日人工审计的基线，没有任何机器计数。
// `max_tokens` 四轮全空。于是「守航是否可信」永远只有感觉、没有数据。
//
// 本模块把三盏红灯做成机器事实：
//   ① `guard.violation.forbidden_action` —— 写工具/外部副作用命中契约 forbidden 或未列入 authorization
//   ② `guard.violation.over_budget`      —— 轮次 / 仓库数 / token / 运行时长 超 limits
//   ③ `guard.fake_green`                 —— 覆盖矩阵里「标绿但证据站不住」的 facet（机器派生，不靠自述）
//
// 关键设计取舍（对齐方案 E1 那一行「2026-08-15 撤销的是"一刀切"，不是"不要闸"」）：
//   · 工具三分类（只读 / 写 / 外部副作用）**只读一律不记不拦**——上次 Stage 4 拦截层被撤就是因为
//     一刀切误杀了只读 MCP（猪猪 list_sessions 之类），把夜里跑的会话直接卡死。
//   · 本模块**只计数 + 出证据**，不决定拦不拦。是否硬拦由 server.js 侧按 risk_class/门禁矩阵决定，
//     模块保持纯函数、可单测、可在晨检包里复算。
//   · 假绿**不许员工自评**：由覆盖矩阵 + 猪猪 `verify_evidence` 派生（见 deriveFakeGreen）。
//     猪猪能力缺位时降级为「未验证」而不是「通过」——fail-open 会让红灯永远是 0，比没有更坏。
// ============================================================================

// ---------- 契约 yaml 解析 ----------
// 契约的机器块是两级 map（`selection.max_items`）+ 顶层 list（`forbidden:` 下的 `- x`）+ 内联数组
// （`priority_order: [P0, P1, P2]`）。刻意不引 yaml 依赖（app/ 只有 sdk + zod 两个依赖，见 CLAUDE.md）。
const stripComment = s => {
  // 剥行尾注释：`deadline: 2026-08-26T08:00:00+08:00  # 到点收束`。
  // ⚠ 注意 kv 正则的 `\s*` 已吃掉冒号后的空白，所以「值只有注释」时到这里是**以 # 开头**的裸注释
  //   （`authorization:            # 只有列 true 的动作被允许`）——必须当空值处理，否则 authorization
  //   会被解析成一个字符串、子键全丢，整张 AUTH_MATCHERS 静默失效（判成 authorization 未列＝全 forbidden）。
  const t = String(s)
  if (/^\s*#/.test(t)) return ''
  const m = t.match(/\s+#/)
  return (m ? t.slice(0, m.index) : t).trim()
}
function coerceScalar(v) {
  const s = stripComment(v)
  if (s === '' ) return ''
  if (s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^\[.*\]$/.test(s)) return s.slice(1, -1).split(',').map(x => x.trim()).filter(Boolean)
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s)
  return s.replace(/^['"]|['"]$/g, '')
}
// 从守航契约 markdown 里取第一个 ```yaml 块并解析（无块则整文当 yaml 试）
export function parseContract(text) {
  const src = String(text || '')
  const m = src.match(/```ya?ml\s*\n([\s\S]*?)```/)
  const body = m ? m[1] : src
  const root = {}
  let curKey = null
  for (const raw of body.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const indent = raw.match(/^ */)[0].length
    const line = raw.trim()
    if (indent === 0) {
      if (line.startsWith('- ')) { if (curKey && Array.isArray(root[curKey])) root[curKey].push(coerceScalar(line.slice(2))); continue }
      const kv = line.match(/^([\w.-]+):\s*(.*)$/)
      if (!kv) continue
      const rest = stripComment(kv[2])
      if (rest === '') { root[kv[1]] = null; curKey = kv[1] }
      else { root[kv[1]] = coerceScalar(kv[2]); curKey = null }
    } else if (curKey) {
      if (line.startsWith('- ')) {
        if (!Array.isArray(root[curKey])) root[curKey] = []
        root[curKey].push(coerceScalar(line.slice(2)))
      } else {
        const kv = line.match(/^([\w.-]+):\s*(.*)$/)
        if (!kv) continue
        if (root[curKey] === null) root[curKey] = {}
        if (root[curKey] && typeof root[curKey] === 'object' && !Array.isArray(root[curKey])) root[curKey][kv[1]] = coerceScalar(kv[2])
      }
    }
  }
  return root
}

// ---------- 工具三分类 ----------
// read=只读（永不记红灯，Stage4 误杀教训）；write=改本机工作区/仓库；external=不可逆外部副作用。
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'notebookread', 'todowrite', 'todoread', 'websearch', 'webfetch', 'task', 'exitplanmode', 'bashoutput'])
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit'])
// Bash 子命令分类：只读 git/查询命令与写命令分开（一刀切把 `git status` 也算写＝上次误杀的形态）
const BASH_READ_RE = /^(?:git\s+(?:status|log|diff|show|rev-parse|rev-list|branch|remote|fetch|ls-files|describe|blame|worktree\s+list|config\s+--get)|ls|cat|head|tail|wc|find|grep|rg|pwd|echo|node\s+-e|npm\s+(?:ls|view|run\s+(?:test|typecheck|lint))|mvn\s+.*-DskipTests.*validate|type|which|where)\b/i
const BASH_EXTERNAL_RE = /\b(?:git\s+push|glab\b|gh\b|curl\b|wget\b|scp\b|ssh\b|mysql\b|psql\b|docker\s+(?:push|run)|kubectl\b|wecom|dingtalk|npm\s+publish)\b/i
const BASH_DESTRUCTIVE_RE = /\b(?:rm\s+-rf?|git\s+(?:reset\s+--hard|clean\s+-[fdx]+|push\s+.*--force|push\s+-f)|truncate|drop\s+table|shutdown|taskkill\s+\/f)\b/i
// MCP 工具名（`mcp__<server>__<tool>`）里的只读特征：list/get/query/status/summary/read/verify/preflight/fingerprint/report
// ⚠ **写动词优先，且必须先判**。子串匹配太松，只看「有没有只读特征词」会把明确的写工具放过：
//   · `set_task_status` 含 `status` → 曾被判 read，于是**改任务档案 frontmatter 的动作在审计面上根本不可见**
//     （这是 2026-08-26 加分类单测时才发现的既有洞，不是新引入的）；
//   · `morning_report` 含 `report` → 同理，它其实会往 tasks/ 写一份晨检包。
// 判据改成「先看开头的动词」：工具命名惯例是 `<动词>_<宾语>`，动词才决定读写，宾语不决定。
const MCP_WRITE_RE = /^(?:set|update|create|add|delete|remove|append|write|manage|park|seed|reconcile|submit|resume|assemble|issue|launch|morning)(?:_|$)/i
// 只读特征词。`scan|check|probe` 是 2026-08-26 实测补的：菲菲跑第一轮巡航后，台账把
// `pool_scan` / `pool_fields_check` 记成了「写类动作」——**这两个工具的描述里白纸黑字写着「只读、不改表」**。
// 不影响红灯（它们只落 unlisted），但会让审计面失真：晨检包报「写/外部动作 11 次」，其中 2 次其实是读。
// 教训：分类表要跟着新工具一起长，否则「审计事实」会慢慢变成「审计噪声」。
const MCP_READ_RE = /(?:^|_)(?:list|get|query|status|summary|read|search|verify|preflight|fingerprint|report|coverage_status|validate|lint|enumerate|recall|scan|check|probe)/i
// external 只收「不可逆的对外副作用」：部署 / 发布 / 真实推送。需求表读写(lark_/wecom_*_requirement)算 write——
// 它是引擎自己的台账同步、是菲菲本职，划成 external 会让 A1 巡航每写一次就亮一盏红灯（假红比没红更坏）。
const MCP_EXTERNAL_RE = /(?:deploy|publish|push_message|send_message|notify|真机)/i

export function classifyTool(name, input = {}) {
  const raw = String(name || '')
  const n = raw.toLowerCase()
  if (n.startsWith('mcp__')) {
    const leaf = n.split('__').slice(2).join('__') || n
    if (MCP_EXTERNAL_RE.test(leaf)) return 'external'
    if (MCP_WRITE_RE.test(leaf)) return 'write'      // ★ 写动词优先于只读特征词（见上方注释的两个真洞）
    if (MCP_READ_RE.test(leaf)) return 'read'
    return 'write'
  }
  if (n === 'bash' || n === 'bashoutput') {
    const cmd = String(input?.command || input?.cmd || '').trim()
    if (!cmd) return 'read'
    if (BASH_DESTRUCTIVE_RE.test(cmd)) return 'external'
    if (BASH_EXTERNAL_RE.test(cmd)) return 'external'
    if (BASH_READ_RE.test(cmd)) return 'read'
    return 'write'
  }
  if (WRITE_TOOLS.has(n)) return 'write'
  if (READ_TOOLS.has(n)) return 'read'
  return 'write'   // 未知工具保守当写（只影响是否计数，不拦）
}

// ---------- forbidden ↔ 动作 的机器判据 ----------
// 契约 forbidden 是业务语汇（production_release / destructive_git…），工具调用是技术动作。
// 这张表把两者接起来：命中即记 forbidden_action。只对 write/external 求值（read 直接放过）。
const FORBIDDEN_MATCHERS = {
  production_release: (name, input) => {
    const cmd = String(input?.command || '')
    return /\b(?:git\s+push\s+\S*\s*(?:release|master)\b|glab\s+mr\s+create[^|]*--target-branch[= ]\s*release)\b/i.test(cmd)
      || /deploy_production|release_prod/i.test(String(name))
  },
  production_ddl: (name, input) => {
    const blob = String(input?.command || '') + ' ' + String(input?.content || '') + ' ' + String(input?.file_path || '')
    return /\bmysql\b[^|]*\b(?:prod|release)\b/i.test(blob) || /\b(?:ALTER|CREATE|DROP)\s+TABLE\b/i.test(blob) && /prod/i.test(blob)
  },
  destructive_git: (name, input) => BASH_DESTRUCTIVE_RE.test(String(input?.command || '')),
  force_push: (name, input) => /git\s+push\b[^\n]*(?:--force\b|-f\b)/i.test(String(input?.command || '')),
  permission_model_change: (name, input) => /auth(?:ority|_code)?|permission|权限码/i.test(String(input?.file_path || '')) && /Write|Edit/i.test(String(name)),
  external_side_effects: (name, input) => {
    if (/wecom_(?:send|notify)|push_message|真机/i.test(String(name))) return true
    return /\b(?:curl|wget)\b/i.test(String(input?.command || '')) && !/127\.0\.0\.1|localhost|192\.168\./i.test(String(input?.command || ''))
  },
  business_scope_inference: () => false,   // 语义类：机器判不了，留给 F2 事后审计 + 巡视
}

// authorization 里 true 的动作 → 允许的工具形态。未列即禁（契约原文：「只有列 true 的动作被允许；未列即禁」）。
const AUTH_MATCHERS = {
  create_task_archive: (name, input) => /Write/i.test(name) && /[\\/]tasks[\\/]/.test(String(input?.file_path || '')),
  create_version: () => false,
  create_feature_branches: (name, input) => /git\s+(?:checkout\s+-b|switch\s+-c|branch)\b/i.test(String(input?.command || '')),
  commit_development_branches: (name, input) => /git\s+commit\b/i.test(String(input?.command || '')),
  run_automated_tests: (name, input) => /run_e2e_batch|run_headless|node\s+--test|npm\s+(?:run\s+)?test|mvn\s+test/i.test(String(name) + ' ' + String(input?.command || '')),
  integrate_candidate_branch: (name, input) => /git\s+merge\b/i.test(String(input?.command || '')),
  deploy_test_environment: (name, input) => /deploy|rebuild_restart_backend/i.test(String(name) + ' ' + String(input?.command || '')),
  deploy_production: () => false,
}

// 判一次工具调用：{verdict, kind, code, why}
//   verdict: 'pass'（只读或已授权） | 'forbidden'（命中 forbidden 或 authorization=false） | 'unlisted'（写类但契约未提及）
// 'unlisted' **不计红灯**——契约不可能穷举所有写工具（改用例、写实施记录都是本职）；它只进证据面供晨检抽查。
export function judgeToolCall(contract, name, input = {}) {
  const kind = classifyTool(name, input)
  if (kind === 'read') return { verdict: 'pass', kind, code: '', why: '只读动作，不入红灯（Stage4 一刀切误杀只读 MCP 的教训）' }
  const forbidden = Array.isArray(contract?.forbidden) ? contract.forbidden.map(String) : []
  for (const f of forbidden) {
    const fn = FORBIDDEN_MATCHERS[f]
    if (fn && fn(name, input)) return { verdict: 'forbidden', kind, code: f, why: `命中契约 forbidden.${f}` }
  }
  const auth = contract?.authorization && typeof contract.authorization === 'object' ? contract.authorization : {}
  for (const [act, fn] of Object.entries(AUTH_MATCHERS)) {
    if (!fn(name, input)) continue
    if (auth[act] === true) return { verdict: 'pass', kind, code: act, why: `authorization.${act}=true` }
    if (act in auth) return { verdict: 'forbidden', kind, code: act, why: `authorization.${act}=${auth[act]}（未授权）` }
    return { verdict: 'forbidden', kind, code: act, why: `authorization 未列 ${act}（契约铁律：未列即禁）` }
  }
  return { verdict: 'unlisted', kind, code: '', why: '写类动作但契约未涉及（本职范围，记入证据面不计红灯）' }
}

// ---------- ② over_budget ----------
// usage: { devQaRoundsByItem:{itemId:n}, integrationRounds, envRetries, changedRepositories:[..], runtimeMinutes, tokens, itemsTaken }
export function checkBudget(contract, usage = {}) {
  const limits = contract?.limits && typeof contract.limits === 'object' ? contract.limits : {}
  const selection = contract?.selection && typeof contract.selection === 'object' ? contract.selection : {}
  const out = []
  const cmp = (label, actual, cap, unit = '') => {
    if (!Number.isFinite(Number(cap)) || cap === null) return
    if (Number(actual) > Number(cap)) out.push({ code: 'over_budget', field: label, actual: Number(actual), cap: Number(cap), why: `${label} ${actual}${unit} > 上限 ${cap}${unit}` })
  }
  for (const [item, n] of Object.entries(usage.devQaRoundsByItem || {})) cmp(`max_dev_qa_rounds_per_item(${item})`, n, limits.max_dev_qa_rounds_per_item, ' 轮')
  cmp('max_integration_rounds', usage.integrationRounds || 0, limits.max_integration_rounds, ' 轮')
  cmp('max_environment_retries', usage.envRetries || 0, limits.max_environment_retries, ' 次')
  cmp('max_runtime_minutes', usage.runtimeMinutes || 0, limits.max_runtime_minutes, ' 分钟')
  cmp('max_items', (usage.itemsTaken || 0), selection.max_items, ' 条')
  cmp('max_changed_repositories', (usage.changedRepositories || []).length, selection.max_changed_repositories, ' 个仓')
  // max_tokens：契约默认 null＝不设硬顶。方案 E1 点名「四轮全空」——这里如实区分「没设」与「设了没超」，
  // 不再让它静默消失（晨检包会把 null 写成「未设成本硬顶」，让老板看见这个洞而不是看见一片空白）。
  if (limits.max_tokens == null) out.push({ code: 'budget_unset', field: 'max_tokens', actual: Number(usage.tokens || 0), cap: null, why: `契约未设 max_tokens（成本无硬顶）；本轮实际 ${Number(usage.tokens || 0)} tokens` })
  else cmp('max_tokens', usage.tokens || 0, limits.max_tokens, ' tokens')
  return out
}

// ---------- ③ fake_green（机器派生，方案 E1 原文的三条判据）----------
// 入参：
//   rows      —— 覆盖矩阵行（coverage.mergeFacetRows 的输出形状：{facetId, status, greenOk, redOk, green:{runId,...}}）
//   verify    —— 猪猪 verify_evidence 结果 map：{ [facetId|runId]: {ok, failureClass, discriminativePower, pageErrors, envFresh} }
//                缺位（猪猪 v1.5 未上线）→ verifyAvailable=false，逐条记 'unverified' 而不是放过
//   threshold —— 区分度下限（默认 0.5；低于即判假绿）
export const DISCRIMINATIVE_FLOOR = 0.5
export function deriveFakeGreen(rows, verify = null, threshold = DISCRIMINATIVE_FLOOR) {
  const verifyAvailable = verify != null && typeof verify === 'object'
  const hits = [], unverified = [], regexCalibratedReds = []
  for (const r of rows || []) {
    if (String(r.status || '').toUpperCase() !== 'COVERED_GREEN') continue
    const fid = String(r.facetId || '').toUpperCase()
    // C7 透明度：RED 证据里带 `redBasis=title-regex` ＝这条校准红是**标题正则蒙对的**，不是结构判定。
    // 不计假绿（它可能确实是真校准红），但必须在报告里单列——否则「已换结构判据」会变成一句没兑现的话。
    if (/redBasis=title-regex/.test(String(r.redRaw || r.red || ''))) regexCalibratedReds.push({ facetId: fid, why: 'RED 校准走的是标题正则降级判定（summary 无 failureClass），未经结构判定' })
    // (a) 引擎自己的证据完整性（不依赖猪猪）：GREEN 证据字段缺失/哈希不对 → 直接假绿
    if (r.greenOk === false) { hits.push({ facetId: fid, why: 'GREEN 证据不是引擎签发的完整证据（缺字段或哈希非法）', code: 'evidence_invalid' }); continue }
    const v = verifyAvailable ? (verify[fid] || verify[String(r.green?.runId || '')] || null) : null
    if (!v) { unverified.push({ facetId: fid, why: verifyAvailable ? '猪猪 verify_evidence 无该 facet/run 的记录' : '猪猪 verify_evidence 接口未就绪（v1.5 待上线）', code: 'unverified' }); continue }
    // (b) verify_evidence 不通过
    if (v.ok === false) { hits.push({ facetId: fid, why: `verify_evidence 不通过：${v.reason || '未给原因'}`, code: 'verify_failed' }); continue }
    // (c) RED 校准的 failureClass 必须是 value-assertion（C7：不再靠中文标题正则）
    if (r.hasRed !== false && v.failureClass && String(v.failureClass) !== 'value-assertion') {
      hits.push({ facetId: fid, why: `RED 校准 failureClass=${v.failureClass}（≠value-assertion，是动作失败被包装成断言失败）`, code: 'red_not_value_assertion' }); continue
    }
    // (d) 区分度低于阈值
    const dp = Number(v.discriminativePower)
    if (Number.isFinite(dp) && dp < threshold) { hits.push({ facetId: fid, why: `区分度 ${dp} < 阈值 ${threshold}（正确与错误实现下都会绿）`, code: 'low_discrimination' }); continue }
    // (e) 页面在报错 / 环境陈旧（C1 三道全局门的机器兜底）
    if (v.pageErrors > 0) { hits.push({ facetId: fid, why: `该 run 期间页面报错 ${v.pageErrors} 次（Z-A 页面报错门）`, code: 'page_error' }); continue }
    if (v.envFresh === false) { hits.push({ facetId: fid, why: '环境指纹陈旧（跑的是旧 bundle，Z-B 环境新鲜度门）', code: 'stale_env' }); continue }
  }
  return { count: hits.length, hits, unverified, regexCalibratedReds, verifyAvailable }
}

// ---------- 台账聚合 + 渲染 ----------
// 三盏灯一张表。ledger 形状（可 JSON 落盘、可在晨检包复算）：
//   { runName, forbidden:[{at,employee,tool,code,why}], overBudget:[...], fakeGreen:{count,hits,unverified,verifyAvailable}, unlisted:[...] }
export function emptyLedger(runName = '') {
  return {
    runName, forbidden: [], overBudget: [], fakeGreen: { count: 0, hits: [], unverified: [], verifyAvailable: false }, unlisted: [],
    toolCalls: { read: 0, write: 0, external: 0 }, itemResults: {}, gateDecisions: {}, snapshots: {},
    usage: { devQaRoundsByItem: {}, integrationRounds: 0, envRetries: 0, changedRepositories: [], runtimeMinutes: 0, tokens: 0, itemsTaken: 0 },
  }
}

// ---------- 逐条目结果（晨检包第二章的机器事实源）----------
// 缘起（2026-08-28 老板报「晨检包里很多是空的」）：`itemResults` 这个字段**全仓只有读、没有写**——
// deadline 自动结算路径 `Object.entries(led.itemResults||{})` 永远拿到 0 条，于是每天早上自动出的包
// 都是「计划条目 0 / 本轮 0 条目」，而同一轮菲菲手调 morning_report 的包里明明有 2 条。
// 空白被当成了事实，正是本模块反复在治的那类假健康值。现在由工具在**动作发生的当下**逐条记账。
const RESULT_RANK = { in_progress: 0, parked: 1, quarantined: 1, rc_ready: 2 }
export function recordItemResult(ledger, req, patch = {}) {
  if (!ledger) return null
  // 编号补到 4 位（REQ-316 → REQ-0316），与 acceptance-card.normReq 同口径——否则同一条目会记成两把键（v0.11.0 审查）
  const key = String(req || '').toUpperCase().trim().replace(/^REQ-(\d+)/, (m, d) => `REQ-${d.padStart(4, '0')}`)
  if (!/^REQ-\d+/.test(key)) return null      // 登记表里的裸序号（#3）不进条目账：晨检包按 REQ 编号对账
  ledger.itemResults = ledger.itemResults || {}
  const cur = ledger.itemResults[key] || { req: key }
  const next = { ...cur }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && v !== null && v !== '') next[k] = v
  // 结果只许**前进**，除非 patch 显式带 force：QA 通过后又有人跑一次 risk_gate，不该把 rc_ready 冲回 in_progress
  if (patch.result && cur.result && !patch.force && (RESULT_RANK[patch.result] ?? 0) < (RESULT_RANK[cur.result] ?? 0)) next.result = cur.result
  delete next.force
  next.at = patch.at || new Date().toISOString()
  ledger.itemResults[key] = next
  return next
}
// DEV↔QA 返工计数：看板条目被置「打回」＝QA 把它退回开发，这是唯一能机读的返工信号
// （limits.max_dev_qa_rounds_per_item 此前也从没有任何代码写过 usage.devQaRoundsByItem，恒为空对象）。
export function bumpDevQaRound(ledger, req) {
  if (!ledger) return 0
  const key = String(req || '').toUpperCase().trim()
  if (!/^REQ-\d+/.test(key)) return 0
  ledger.usage = ledger.usage || {}
  ledger.usage.devQaRoundsByItem = ledger.usage.devQaRoundsByItem || {}
  ledger.usage.devQaRoundsByItem[key] = Number(ledger.usage.devQaRoundsByItem[key] || 0) + 1
  return ledger.usage.devQaRoundsByItem[key]
}
export function recordToolCall(ledger, { at, employee, tool, verdict, kind, code, why }) {
  if (!ledger) return ledger
  ledger.toolCalls[kind] = (ledger.toolCalls[kind] || 0) + 1
  const row = { at: at || new Date().toISOString(), employee: employee || '', tool: String(tool || ''), code: code || '', why: why || '' }
  if (verdict === 'forbidden') ledger.forbidden.push(row)
  else if (verdict === 'unlisted') { if (ledger.unlisted.length < 200) ledger.unlisted.push(row) }
  return ledger
}
export const redLightTotals = ledger => ({
  forbidden_action: (ledger?.forbidden || []).length,
  over_budget: (ledger?.overBudget || []).filter(v => v.code === 'over_budget').length,
  fake_green: ledger?.fakeGreen?.count || 0,
})

// 晨检包/看板用的 markdown 块。**红灯为 0 也要出这张表**——方案的核心诉求是「有数」，
// 空表和「没统计过」在纸面上长得一样，那就等于没建。
export function renderRedLights(ledger) {
  const t = redLightTotals(ledger)
  const all0 = t.forbidden_action === 0 && t.over_budget === 0 && t.fake_green === 0
  const L = []
  L.push('### 三红灯（引擎机器计数；契约要求三项全 0）')
  L.push('')
  L.push('| 红灯 | 计数 | 判据 |')
  L.push('|------|------|------|')
  L.push(`| \`guard.violation.forbidden_action\` | **${t.forbidden_action}** | 写/外部副作用动作命中契约 forbidden 或 authorization≠true（只读动作不计） |`)
  L.push(`| \`guard.violation.over_budget\` | **${t.over_budget}** | 轮次 / 仓库数 / 运行时长 / token 超 limits |`)
  L.push(`| \`guard.fake_green\` | **${t.fake_green}** | 标 GREEN 但证据站不住（证据不全 / verify 不通过 / failureClass≠value-assertion / 区分度低 / 页面报错 / 环境陈旧） |`)
  L.push('')
  const fg = ledger?.fakeGreen || {}
  if (!fg.verifyAvailable) L.push(`> ⚠ **假绿只算了引擎自己能算的那一半**：猪猪 \`verify_evidence\` 未接通，${(fg.unverified || []).length} 条 GREEN 处于「未验证」而非「已通过」——这些不计入红灯，但也**不得当作可信绿**。`)
  else if ((fg.unverified || []).length) L.push(`> ⚠ ${(fg.unverified || []).length} 条 GREEN 在猪猪侧查不到 verify 记录（证据包缺失），按「未验证」列出。`)
  if (all0) L.push('> ✅ 三灯全 0。注意：全 0 只说明「机器没抓到」，仍需看下面的未验证项与证据可信度章节。')
  for (const [title, rows, fmt] of [
    ['越权动作明细', ledger?.forbidden || [], r => `- \`${r.tool}\`（${r.employee || '?'}，${String(r.at).slice(0, 19).replace('T', ' ')}）—— ${r.why}`],
    ['超预算明细', (ledger?.overBudget || []).filter(v => v.code === 'over_budget'), r => `- ${r.why}`],
    ['假绿明细', fg.hits || [], r => `- ${r.facetId} —— ${r.why}`],
    ['未验证的 GREEN（不计红灯、但不算可信）', fg.unverified || [], r => `- ${r.facetId} —— ${r.why}`],
    ['RED 校准走了正则降级（C7 未完全落地：猪猪 Z-D 的 failureClass 未上线）', fg.regexCalibratedReds || [], r => `- ${r.facetId} —— ${r.why}`],
  ]) {
    if (!rows.length) continue
    L.push('')
    L.push(`**${title}**（${rows.length}）`)
    L.push(...rows.slice(0, 30).map(fmt))
    if (rows.length > 30) L.push(`- …另有 ${rows.length - 30} 条，见 \`runs/guard-ledger-*.json\``)
  }
  const bu = (ledger?.overBudget || []).filter(v => v.code === 'budget_unset')
  if (bu.length) { L.push(''); L.push('**未设硬顶的预算项**（方案 E1 点名的「`max_tokens` 四轮全空」）'); L.push(...bu.map(r => `- ${r.why}`)) }
  return L.join('\n')
}
