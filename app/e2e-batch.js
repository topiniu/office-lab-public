// E2E 批次执行（迷糊专用）——把「并发甩批 + 等待 + 翻产物 + 取 repair-context」从员工手里收归引擎。
//
// 缘起（2026-08-21 复盘 §3.93 + §3.90）：run 20260821041830-ad60b6 两条需求测了 142min，其中
//   · 17 个 headless 会话**完全串行**跑掉 68.3min（并发本可压到 ~23min）；
//   · 前台 `sleep` 36 次 60.4min（14 次撞 Bash 默认 120s 超时白烧），`ls -1dt` 按 mtime 猜会话目录 24 次；
//   · 45min 纯思考里 13.7min 花在「手工翻 summary/aggregate 判断怎么办」、7.9min 翻源码。
// 而这三件事她工牌里本来都有规矩（headless 迭代 / 别死等 / 并发甩批），**软约束没拦住**。故按 §3.78 的教训
// （「对 SDK 员工，SOP 是软约束、工具与门禁才是硬约束」）把正确姿势做成工具契约：
//   提交即返回（她无法前台 sleep）→ 引擎并发跑（并发是默认值）→ 全部 settle 后引擎唤起她，
//   **失败的自动附 repair-context 摘要**（她不必再翻产物、也不必按 mtime 猜目录）。
//
// 本文件只放**纯函数 + 依赖注入的编排**（fetch 由调用方传入），便于 `node --test` 单测；
// 与引擎的接线（MCP 工具、后台标记、唤起注入）在 server.js。

export const DEFAULT_CONCURRENCY = 3          // 默认并发：3 个 headless 会话（保守，机器还要跑被测前后端）
export const MAX_CONCURRENCY = 5              // 上限：再高抢 CPU 反而拖慢每条会话
export const MAX_FILES = 12                   // 单批文件上限（防一次甩几十个把机器打满）
export const DEFAULT_SESSION_TIMEOUT_MS = 15 * 60_000   // 单会话硬超时：实测最长会话 551s，15min 留足余量
// 2026-10-27 提效改造（v6.3.0 F31 复盘：7.2h 墙钟里 144min 重跑已绿 case、78min 两次挂死、142min RED 校准插在中途）：
//   · 超时**按粒度**下发给猪猪（以前只在我方轮询侧计时，到点只"放弃等"不取消，挂死会话在猪猪那边空转到它自己的 40min 兜底）；
//   · 空闲看门狗：步与步之间卡住（无任何 step 事件）5min 即判挂死，由猪猪侧收尾；
//   · 轮询到点 → 主动 POST /cancel，绝不留僵尸会话占槽。
export const CASE_SESSION_TIMEOUT_MS = 10 * 60_000      // 只跑指定 caseIds（单/少量 case 修复迭代）
export const FILE_SESSION_TIMEOUT_MS = 25 * 60_000      // 整文件（今天最长 spot 10 case 14.7min）
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60_000       // 无任何 step 事件即判挂死
export const isRedCalibration = (p) => /-RED\.json$/i.test(String(p || ''))
// RED 校准件的判定（2026-10-27）：它们故意带错误预期跑，**红才是成功**——但只有「断言按预期没过」(assertion-false)
// 才算护栏有效；页面报错/超时/定位失败等在断言前就挂的红证明不了任何东西（无效红）；跑绿则说明断言没抓到错（意外通过）。
// 以前一律按普通件算「未通过」，一批 11 个如期红的校准件在看板上显示成 11 个失败，误导老板以为成功率极低。
export function redCalibrationVerdict(r) {
  if (!r || !isRedCalibration(r.testFilePath)) return null
  if (r.status === 'passed' || r.ok) return { ok: false, kind: 'unexpected-pass', text: '意外通过：断言没抓到错，护栏无效（检查 RED 改动是否落到断言上）' }
  if (r.failureType === 'assertion-false') return { ok: true, kind: 'expected-red', text: '如期红' }
  return { ok: false, kind: 'invalid-red', text: `无效红：${r.failureType || r.status || 'unknown'}，断言前就挂了，证明不了护栏，需重跑` }
}
export const MAX_DIGEST_CHARS = 1400          // 单条 repair-context 摘要字符上限（唤起消息要能读，不能糊脸）

// ---------- 入参规划与校验 ----------
// 返回 { error } 或 { items, concurrency, warnings }。items 已去重、已补默认值。
export function planBatch(files, opts = {}) {
  if (!Array.isArray(files) || !files.length) return { error: 'files 必须是非空数组（每项至少给 testFilePath）' }
  if (files.length > MAX_FILES) return { error: `单批最多 ${MAX_FILES} 个文件，收到 ${files.length} 个——拆成多批` }
  const warnings = []
  const seen = new Set()
  const items = []
  for (const raw of files) {
    const f = raw && typeof raw === 'object' ? raw : { testFilePath: raw }
    const p = String(f.testFilePath || '').trim().replace(/\\/g, '/')
    if (!p) return { error: '有一项缺 testFilePath' }
    // 与猪猪自身约束对齐：必须是 test-workflows/ 下的安全相对 json 路径
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return { error: `testFilePath 必须是相对路径（相对 test-workflows/），不要绝对路径：${p}` }
    if (p.split('/').includes('..')) return { error: `testFilePath 不允许 ..（越界）：${p}` }
    if (!/\.json$/i.test(p)) return { error: `testFilePath 必须是 .json：${p}` }
    if (/^test-workflows\//i.test(p)) return { error: `testFilePath 不要带 test-workflows/ 前缀（它已是根）：${p}` }
    const caseIds = Array.isArray(f.caseIds) ? f.caseIds.map(String).filter(Boolean) : []
    const sig = p + '|' + caseIds.slice().sort().join(',')
    if (seen.has(sig)) { warnings.push(`重复项已合并：${sig}`); continue }
    seen.add(sig)
    items.push({
      testFilePath: p,
      caseIds,
      scope: caseIds.length ? 'selected' : (f.scope === 'selected' ? 'selected' : 'all'),
      label: caseIds.length ? `${p}(${caseIds.join(',')})` : p,
      rootCause: f.rootCause ? String(f.rootCause) : '',
      fullFileReason: f.fullFileReason ? String(f.fullFileReason) : '',
    })
  }
  if (!items.length) return { error: '去重后没有可跑的文件' }
  // 批内排序（稳定）：修复迭代（指定 caseIds）最先出结果 → 整文件 → RED 校准垫底。
  // 串行(并发1)时顺序就是反馈时延：别让一个 13min 的整文件或一串 RED 件挡在你正等着验的那条修复前面。
  const rank = (it) => (isRedCalibration(it.testFilePath) ? 2 : it.caseIds.length ? 0 : 1)
  const before = items.map(it => it.label).join('|')
  items.sort((a, b) => rank(a) - rank(b))
  if (items.map(it => it.label).join('|') !== before) warnings.push('已按「指定 case 的修复项 → 整文件 → RED 校准」重排执行顺序')
  let concurrency = Number(opts.concurrency)
  if (!Number.isFinite(concurrency) || concurrency < 1) concurrency = DEFAULT_CONCURRENCY
  concurrency = Math.min(MAX_CONCURRENCY, Math.floor(concurrency), items.length)
  return { items, concurrency, warnings }
}

// ---------- 并发池（有序返回；worker 抛错不掀桌，落成该项的 error） ----------
export async function runPool(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try { results[i] = await worker(items[i], i) }
      catch (e) { results[i] = { ...items[i], ok: false, status: 'error', error: String(e?.message || e) } }
    }
  })
  await Promise.all(lanes)
  return results
}

// ---------- 结果归一化 ----------
// 猪猪的 POST /test-sessions 与 MCP run_headless 返回形状略有差异（sessionId vs id、扁平 vs data 包一层），
// 这里统一收口，别让上层去猜。
// 终态判定（v1.4 起平台给了权威字段 `terminal`；缺它时退回按 status 白名单判，兼容老版本）
export const TERMINAL_STATUS = new Set(['passed', 'failed', 'blocked', 'cancelled', 'error', 'timeout'])
export function isTerminal(raw) {
  const d = (raw && typeof raw === 'object') ? (raw.data && typeof raw.data === 'object' ? { ...raw, ...raw.data } : raw) : {}
  if (typeof d.terminal === 'boolean') return d.terminal          // 权威依据（平台 v1.4：判断能否停止轮询的唯一字段）
  if (d.waitTimedOut === true) return false                        // 有界阻塞到点：会话还在后台跑
  return TERMINAL_STATUS.has(String(d.status || '').toLowerCase())
}
// 取会话句柄：异步提交返回 sessionId；有界阻塞到点走 partial.sessionId（平台 v1.4 承诺「超时也吐句柄」）
export function extractHandle(raw) {
  const d = (raw && typeof raw === 'object') ? (raw.data && typeof raw.data === 'object' ? { ...raw, ...raw.data } : raw) : {}
  return d.sessionId || d.id || d.partial?.sessionId || d.partial?.roundId && d.partial?.sessionId || null
}

export function normalizeSessionResult(raw, item) {
  const base = (raw && typeof raw === 'object') ? (raw.data && typeof raw.data === 'object' ? { ...raw, ...raw.data } : raw) : {}
  // 2026-10-27 修：轮询 GET /test-sessions/{id} 返回的是 {ok, summary, data:<会话文档>}——firstFailure / failureType /
  // repairContextPath 只在 summary 与 rounds[最后一轮] 里，顶层没有。以前只读顶层，导致**所有**唤起消息的「首个失败」和
  // repair-context 摘要恒为空（消息却写着「摘要已附」），员工只能自己翻会话目录。按 顶层 → summary → 最后一轮 依次兜底。
  const lastRound = Array.isArray(base.rounds) && base.rounds.length ? base.rounds[base.rounds.length - 1] : null
  const summary = base.summary && typeof base.summary === 'object' ? base.summary : null
  const pick = (k) => base[k] ?? summary?.[k] ?? lastRound?.[k] ?? null
  const d = { ...base, firstFailure: pick('firstFailure'), failureType: pick('failureType'), repairContextPath: pick('repairContextPath'), reportPath: pick('reportPath') }
  const statusRaw = d.status ? String(d.status) : ''
  const status = statusRaw || (d.ok === true ? 'passed' : d.ok === false ? 'failed' : 'unknown')
  const ff = d.firstFailure && typeof d.firstFailure === 'object' ? d.firstFailure : null
  return {
    label: item.label,
    testFilePath: item.testFilePath,
    caseIds: item.caseIds,
    sessionId: d.sessionId || d.id || d.partial?.sessionId || null,
    roundId: d.roundId || d.partial?.roundId || null,
    terminal: isTerminal(raw),
    status,
    // ok 判定**以 status 为准**，绝不用信封的 ok 兜底：外层 `ok:true` 只表示「这次调用成功」，
    // 而 MCP/HTTP 常在 `ok:true` 的信封里带 `status:"failed"`——用 `||` 会把红判成绿。
    // 假绿比假红坏得多（迷糊红线 12：假绿灯比漏验更坏），故一律 fail-closed 到红。
    ok: status === 'passed' && d.ok !== false,
    failureType: d.failureType || null,
    firstFailure: ff ? {
      caseId: ff.caseId || null, stepId: ff.stepId || null, stepIndex: ff.index ?? ff.stepIndex ?? null,
      stepTitle: ff.stepTitle || ff.title || null, actionType: ff.actionType || null, message: ff.message || null,
    } : null,
    repairContextPath: d.repairContextPath || d.artifactPaths?.repairContextPath || null,
    reportPath: d.reportPath || d.artifactPaths?.reportPath || null,
    error: null,
  }
}

const compact = (v, n = 220) => {
  if (v === null || v === undefined) return null
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (!s || s === '{}' || s === '[]' || s === 'null') return null
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ---------- repair-context 摘要 ----------
// 字段名对齐真实产物（2026-08-21 实地核对 repair-context.json）：
//   failureType / firstFailure / normalizedTarget / resolution{strategy,matchedCount,triedStrategies,candidates}
//   / assertion / expected / actual / validateIssues[] / suggestedPatches[] / evidence{afterScreenshotPath,…}
// 只挑「改 JSON 真正要看的那几样」，其余给路径让她按需自取——目标是替掉那 13.7min 手工翻产物。
export function digestRepairContext(rc, { maxChars = MAX_DIGEST_CHARS } = {}) {
  if (!rc || typeof rc !== 'object') return ''
  const L = []
  const ff = rc.firstFailure || {}
  if (rc.failureType) L.push(`failureType=${rc.failureType}`)
  if (ff.stepId || ff.stepTitle) L.push(`失败步 ${ff.stepId || '?'}「${String(ff.stepTitle || '').slice(0, 60)}」actionType=${ff.actionType || '?'}`)
  if (ff.message) L.push(`message: ${compact(ff.message, 200)}`)
  const nt = compact(rc.normalizedTarget)
  if (nt) L.push(`normalizedTarget: ${nt}`)
  const r = rc.resolution
  if (r && typeof r === 'object') {
    const bits = []
    if (r.strategy) bits.push(`strategy=${r.strategy}`)
    if (r.matchedCount !== undefined && r.matchedCount !== null) bits.push(`matchedCount=${r.matchedCount}`)
    if (Array.isArray(r.triedStrategies) && r.triedStrategies.length) bits.push(`tried=${r.triedStrategies.slice(0, 6).join('/')}`)
    if (bits.length) L.push(`resolution: ${bits.join(' ')}`)
    if (Array.isArray(r.candidates) && r.candidates.length)
      L.push(`候选元素(${r.candidates.length})：${r.candidates.slice(0, 5).map(c => compact(c, 110)).filter(Boolean).join(' | ')}`)
    else if (r.matchedCount === 0) L.push('候选元素：0 个——定位彻底没命中，别微调选择器，改用 DOM 语义字段/testid 重写 target')
  }
  const exp = compact(rc.expected ?? rc.assertion?.expected), act = compact(rc.actual ?? rc.assertion?.actual)
  if (exp || act) L.push(`expected=${exp ?? 'null'} / actual=${act ?? 'null'}`)
  if (Array.isArray(rc.suggestedPatches) && rc.suggestedPatches.length)
    L.push(`平台建议补丁(${rc.suggestedPatches.length})：${rc.suggestedPatches.slice(0, 3).map(p => compact(p, 160)).filter(Boolean).join(' | ')}`)
  if (Array.isArray(rc.validateIssues)) {
    const blocking = rc.validateIssues.filter(i => i && /blocking|error/i.test(String(i.severity || '')))
    if (blocking.length) L.push(`validate 阻断项(${blocking.length})：${blocking.slice(0, 3).map(i => `${i.code}@${i.path || i.stepId || ''}`).join(' | ')}`)
    else if (rc.validateIssues.length) L.push(`validate warnings ${rc.validateIssues.length} 条（非阻断，详见产物）`)
  }
  const shot = rc.evidence?.afterScreenshotPath
  if (shot) L.push(`失败后截图：${shot}　← 红线13：先看它判「产品崩溃(白屏/异常)」还是「定位漂移」，别只读 error 码脑补`)
  let out = L.filter(Boolean).join('\n')
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…（截断，完整见 repair-context.json）'
  return out
}

// ---------- 唤起消息 ----------
export function buildWakePrompt({ batchId, results, elapsedMs, concurrency }) {
  const all = Array.isArray(results) ? results : []
  const cal = all.filter(r => r && isRedCalibration(r.testFilePath))
  const arr = all.filter(r => !(r && isRedCalibration(r.testFilePath)))
  const greens = arr.filter(r => r && r.ok)
  const reds = arr.filter(r => r && !r.ok)
  const mins = (elapsedMs / 60000).toFixed(1)
  const calVerdicts = cal.map(r => r.redVerdict || redCalibrationVerdict(r))
  const calOk = calVerdicts.filter(v => v && v.ok).length
  const L = [`【系统·E2E 批次已全部结束】批次 ${batchId}：${all.length} 个用例文件，并发 ${concurrency}，墙钟 ${mins}min。绿 ${greens.length} / 红 ${reds.length}。`
    + (cal.length ? `RED 校准 ${cal.length}：如期红 ${calOk} / 异常 ${cal.length - calOk}。` : '')]
  if (cal.length) {
    L.push('', '🎯 RED 校准（故意带错误预期，红=护栏有效，不计入上面的绿/红）：')
    cal.forEach((r, i) => {
      const v = calVerdicts[i] || { ok: false, text: '未知' }
      L.push(`  · ${r.label}　verdict=${v.ok ? '如期红' : v.kind === 'unexpected-pass' ? '意外通过' : '无效红'}　session=${r.sessionId || '?'}`)
      if (!v.ok) L.push(`    原因：${v.text}${r.firstFailure?.message ? '（' + String(r.firstFailure.message).slice(0, 100) + '）' : ''}`)
    })
  }
  if (greens.length) {
    L.push('', '✅ 通过：')
    for (const g of greens) L.push(`  · ${g.label}　session=${g.sessionId || '?'}`)
  }
  if (reds.length) {
    L.push('', '❌ 未通过（repair-context 摘要已附，别再凭 failure message 猜）：')
    for (const r of reds) {
      L.push('', `  · ${r.label}　status=${r.status}　session=${r.sessionId || '?'}`)
      if (r.error) L.push(`    提交/执行异常：${r.error}`)
      if (r.firstFailure) {
        const f = r.firstFailure
        L.push(`    首个失败：step ${f.stepIndex ?? '?'} ${f.stepId || ''}「${String(f.stepTitle || '').slice(0, 60)}」→ ${f.message || '(无 message)'}`)
      }
      if (Array.isArray(r.repeats) && r.repeats.length) {
        for (const rp of r.repeats) L.push(`    ⛔ 同一处第 ${rp.count} 次红：case ${rp.caseId} 仍死在 ${rp.stepKey}。**禁止再盲改**——先打开失败截图 + trace（必要时这一条 case 单独 headed 跑一次）把原因钉死；再投这条时必须在该项写 rootCause（引用你看到的截图/trace 事实），否则引擎拒收。`)
      }
      if (Array.isArray(r.cases) && r.cases.length) {
        const red = r.cases.filter(c => c.ran && !c.ok).map(c => c.caseId)
        const green = r.cases.filter(c => c.ok)
        if (red.length && green.length) {
          const savedMin = green.reduce((a, c) => a + (c.durationMs || 0), 0) / 60000
          for (const c of r.cases) if (c.ran && !c.ok && c.failedSteps?.length > 1) L.push(`    ${c.caseId} 本趟暴露 ${c.failedSteps.length} 个失败步（一并修）：${c.failedSteps.join(' ｜ ')}`)
          L.push(`    红 case ${red.length}/${r.cases.length}：${red.join(', ')}；已绿 ${green.length} 条重跑≈${savedMin.toFixed(1)}min 纯浪费。修完只投红 case：{"testFilePath":"${r.testFilePath}","caseIds":${JSON.stringify(red)}}`)
        }
      }
      if (r.repairDigest) L.push(...String(r.repairDigest).split('\n').map(s => '    ' + s))
      else if (r.repairContextPath) L.push(`    repair-context 取不到摘要，完整件：${r.repairContextPath}（Read 它，别跳过）`)
      if (r.reportPath) L.push(`    报告：${r.reportPath}`)
    }
  }
  // 页面一眼巡检（§3.123）：**绿件才是这一档的主战场**。
  // 红件已经带 repair-context + 失败截图，她一定会去看；而「测完判绿、人工一打开第一眼还是一堆问题」
  // 说的正是绿件——断言全过 ≠ 这一屏没毛病（断言只看它被要求看的那几个点）。
  // 所以这里点名的是**绿件的 session**，不是红件的。
  const scanTargets = greens.filter(g => g.sessionId)
  if (scanTargets.length) {
    L.push('', `👁 **页面一眼巡检（§C3.7，别跳过）**：本批 ${greens.length} 个绿件里 ${scanTargets.length} 个有 session，逐个跑 \`page_scan({sessionId})\` → 看图 → \`page_scan_verdict\`。`)
    for (const g of scanTargets) L.push(`  · page_scan({sessionId: "${g.sessionId}"})　# ${g.label}`)
    L.push('  **为什么是绿件**：红件你已经会去看失败截图了；而「断言全过」只代表**用例要求看的那几个点**过了，'
      + '页面上重复渲染、数字不勾稽、脏数据外泄、缺单位这些，一条断言都不会红——那正是人工一打开第一眼就看见的东西。')
    L.push('  巡检发现的问题**基本不阻塞你继续测**：记下来接着跑下一批，别停下等修。收工时 `qa_report_card` 会点名这一档做没做。')
  }
  L.push('', '下一步（按你工牌 §②.3.5 + 「E2E 修复迭代提效纪律」）：红的据上面 repair-context **和失败截图**钉死原因 → 改 JSON → `validate_test_file`（`mode=patch-review`）→ **立刻只投这几条红 case**（caseIds，小批快回，别攒成整文件大批）。整文件只在终验时跑一次；RED 校准放最后、只对已冻结的文件做一次。',
    '**不要用前台 `sleep` 等、不要 `ls -1dt` 猜 session 目录**——这条工具会在跑完时再次自动唤起你。绿的按 SOP 走 `reconcile_coverage` 机签。')
  return L.join('\n')
}

// ---------- 逐 case 结果（从 round 的 aggregate.json 取） ----------
// 用于：①唤起消息里点名「哪几条 case 红、哪几条已绿」并给出只跑红 case 的现成入参；②引擎侧收窄门禁。
export function readCaseOutcomes(raw, readJsonFile) {
  const d = (raw && typeof raw === 'object') ? (raw.data && typeof raw.data === 'object' ? { ...raw, ...raw.data } : raw) : {}
  const rounds = Array.isArray(d.rounds) ? d.rounds : []
  const aggPath = d.aggregatePath || rounds[rounds.length - 1]?.aggregatePath || null
  if (!aggPath || typeof readJsonFile !== 'function') return null
  let agg
  try { agg = readJsonFile(aggPath) } catch { return null }
  const list = Array.isArray(agg?.caseResults) ? agg.caseResults : null
  if (!list) return null
  return list.map(c => {
    const steps = Array.isArray(c.result?.data?.results) ? c.result.data.results : []
    const failedSteps = steps
      .filter(st => st && st.ok === false && !st.skipped && !st.data?.skipped)
      .slice(0, 8)
      .map(st => {
        const inp = st.input || {}
        return `#${st.index ?? '?'} ${inp.id || inp.stepId || ''}「${String(inp.stepTitle || inp.title || '').slice(0, 40)}」${st.error?.message ? '→ ' + String(st.error.message).slice(0, 80) : ''}`
      })
    return {
      caseId: c.caseId,
      ok: c.result?.ok === true,
      ran: !!c.result,
      durationMs: Number(c.result?.telemetry?.durationMs) || null,
      failedSteps,
    }
  })
}

// ---------- 编排（网络依赖注入） ----------
// deps: { fetchImpl, readJsonFile?, onProgress?, now? }
export async function executeBatch({ items, concurrency, base, authProfile, authBootstrap, reuseBrowser, sessionTimeoutMs = null, sessionIdleTimeoutMs = SESSION_IDLE_TIMEOUT_MS, stopOnFailure = undefined, pollIntervalMs = 5000 }, deps = {}) {
  const { fetchImpl, readJsonFile = null, onProgress = () => { }, now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)), isCancelled = () => false } = deps
  if (typeof fetchImpl !== 'function') throw new Error('executeBatch 需要注入 fetchImpl')
  const root = String(base || '').replace(/\/+$/, '')
  const t0 = now()
  const getJson = async (url, ms) => {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(ms) })
    const text = await resp.text()
    try { return JSON.parse(text) } catch { return { status: resp.ok ? 'unknown' : 'error', message: text.slice(0, 200) } }
  }

  // 全局槽位（2026-09-30 事故：两个运行环境各一条迷糊会话、各甩一批并发 3 的 headless，叠上两套 Java 后端 +
  // 两个前端 dev server，整机提交内存耗尽——chrome-headless-shell 先 OOM（0xE0000008），3s 后引擎也被系统掐死
  // （0xC0000409），两条守航会话一起断）。单批的 concurrency 只管自己这一批，跨会话的总数要由引擎统一发号：
  // deps.acquire(item) 返回 release 函数；不注入就维持原行为（纯函数单测不受影响）。
  const results = await runPool(items, concurrency, async (item) => {
    const release = typeof deps.acquire === 'function' ? await deps.acquire(item) : null
    try { return await runOne(item) } finally { try { release?.() } catch { } }
  })
  async function cancelSession(handle, reason) {
    try {
      await fetchImpl(`${root}/test-sessions/${encodeURIComponent(handle)}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }), signal: AbortSignal.timeout(20_000),
      })
      return true
    } catch { return false }
  }
  function cancelledResult(item, sessionId = null) { return { label: item.label, testFilePath: item.testFilePath, caseIds: item.caseIds, sessionId, status: 'cancelled', ok: false, firstFailure: null, repairContextPath: null, reportPath: null, error: '批次已被取消（会话停止）' } }
  async function runOne(item) {
    if (isCancelled()) { onProgress({ phase: 'cancelled', label: item.label }); return cancelledResult(item) }
    const itemT0 = now()
    const itemTimeoutMs = sessionTimeoutMs || (item.caseIds.length ? CASE_SESSION_TIMEOUT_MS : FILE_SESSION_TIMEOUT_MS)
    const body = {
      testFilePath: item.testFilePath,
      scope: item.scope,
      runNow: true,
      // 异步提交（平台 v1.4 起）：~1s 返回 {sessionId, roundId, status:'running', terminal:false}，随后轮询到 terminal。
      // 为什么必须这么改：v1.4 把**阻塞模式**改成服务端设界（`waitTimeoutMs` 默认 50s），而她的会话中位 170s、
      // 最长 551s —— 继续用阻塞 POST 会在 50s 拿到 `status:'running'`，被误判成红件。异步提交同时修掉旧实现的
      // 老弱点：阻塞式一旦连接断掉就**彻底丢句柄**（错误分支里写着"可用 get_run_summary 回捞"却根本没有 sessionId）。
      wait: false,
      ...(item.caseIds.length ? { caseIds: item.caseIds } : {}),
      ...(authProfile ? { authProfile } : {}),
      ...(authBootstrap ? { authBootstrap } : {}),
      // reuseBrowser 保持平台默认（true）：v1.4 完成说明逐层翻码确认——它只在**单个会话内部**复用一个 Chromium，
      // 会话之间从不共享 browser/context/cookie/storageState/runtime 变量，**并发不需要改 false**（改了只会更慢）。
      // （此前我方保守设成 false，理由是"隔离保证读不出来"；现在保证已明文+锁进他们的单测，故撤回。）
      ...(reuseBrowser !== undefined ? { reuseBrowser: !!reuseBrowser } : {}),
      // 超时下发到猪猪侧强制执行（硬上限 + 空闲看门狗），不再只靠我方轮询"放弃等"
      sessionTimeoutMs: itemTimeoutMs,
      sessionIdleTimeoutMs,
      // 调试轮 false：case 失败后继续跑完，一趟暴露全部坏步（以前 95% 红趟只换回 1 个失败步）；出证据轮别传（默认 true）
      ...(stopOnFailure === false ? { stopOnFailure: false } : {}),
    }
    onProgress({ phase: 'submit', label: item.label })
    let raw
    try {
      const resp = await fetchImpl(`${root}/test-sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.min(itemTimeoutMs, 120_000)),   // 异步提交只需 ~1s；兼容老版本阻塞也不必等满 15min
      })
      const text = await resp.text()
      try { raw = JSON.parse(text) } catch { raw = { status: resp.ok ? 'unknown' : 'error', message: text.slice(0, 300) } }
      if (!resp.ok && !raw.status) raw.status = 'error'
    } catch (e) {
      const msg = /timeout|abort/i.test(String(e?.message || e)) ? '提交超时（引擎侧放弃；若平台仍收到了提交，用 list_sessions({testFileId}) 反查句柄）' : String(e?.message || e)
      onProgress({ phase: 'error', label: item.label, error: msg })
      return { label: item.label, testFilePath: item.testFilePath, caseIds: item.caseIds, sessionId: null, status: 'error', ok: false, firstFailure: null, repairContextPath: null, reportPath: null, error: msg }
    }

    // 未终态 → 轮询 GET /test-sessions/{id} 到 terminal（平台 v1.4：terminal 是唯一停止依据）
    let handle = extractHandle(raw)
    if (!isTerminal(raw)) {
      if (!handle) {   // 句柄没拿到（老版本/异常）→ 按 testFileId 反查，替代「ls -1dt 按 mtime 猜目录」那套取证不安全的老姿势
        try {
          const ls = await getJson(`${root}/test-sessions?testFileId=${encodeURIComponent(item.testFilePath.replace(/\.json$/i, '').split('/').pop())}&limit=1`, 15_000)
          const arr = Array.isArray(ls?.data) ? ls.data : (Array.isArray(ls?.sessions) ? ls.sessions : (Array.isArray(ls) ? ls : []))
          handle = arr[0]?.sessionId || arr[0]?.id || null
        } catch { }
      }
      if (!handle) {
        const msg = '提交后拿不到会话句柄（平台未返回 sessionId，list_sessions 也没反查到）——无法轮询'
        onProgress({ phase: 'error', label: item.label, error: msg })
        return { label: item.label, testFilePath: item.testFilePath, caseIds: item.caseIds, sessionId: null, status: 'error', ok: false, firstFailure: null, repairContextPath: null, reportPath: null, error: msg }
      }
      onProgress({ phase: 'polling', label: item.label, sessionId: handle })
      // 猪猪侧自己会在 itemTimeoutMs 收尾；我方多留 2min 等它落 round 产物，仍不终态才主动取消
      const deadline = itemT0 + itemTimeoutMs + 120_000   // 从这一项真正开跑算起：排队等全机槽位的时间不该吃掉它的超时额度
      let last = raw
      while (now() < deadline) {
        if (isCancelled()) {
          await cancelSession(handle, '批次随员工会话停止而取消')
          onProgress({ phase: 'cancelled', label: item.label, sessionId: handle })
          return cancelledResult(item, handle)
        }
        await sleep(pollIntervalMs)
        try { last = await getJson(`${root}/test-sessions/${encodeURIComponent(handle)}`, 20_000) } catch { continue }   // 单次轮询失败不放弃，下轮再试
        if (isTerminal(last)) break
      }
      if (!isTerminal(last)) {
        const cancelled = await cancelSession(handle, `超过 ${Math.round(itemTimeoutMs / 60000)}min 未终态，引擎主动取消`)
        const msg = `等到 ${Math.round(itemTimeoutMs / 60000)}min 仍未进终态——${cancelled ? '已主动取消该会话（不留僵尸占槽）' : '取消请求失败，会话可能仍在跑，请 cancel_run 清障'}，句柄 ${handle}`
        onProgress({ phase: 'error', label: item.label, error: msg, sessionId: handle })
        return { label: item.label, testFilePath: item.testFilePath, caseIds: item.caseIds, sessionId: handle, status: 'timeout', ok: false, firstFailure: null, repairContextPath: null, reportPath: null, error: msg }
      }
      raw = last
    }
    const res = normalizeSessionResult(raw, item)
    if (!res.sessionId && handle) res.sessionId = handle
    res.cases = readCaseOutcomes(raw, readJsonFile)
    res.redVerdict = redCalibrationVerdict(res)
    // 红的：自动取 repair-context（先 HTTP，取不到再退回本机文件）——这一步就是替掉她「手工翻产物」的 13.7min
    if (!res.ok) {
      let rc = null
      if (res.sessionId) {
        try {
          const r2 = await fetchImpl(`${root}/test-sessions/${encodeURIComponent(res.sessionId)}/repair-context`, { signal: AbortSignal.timeout(20_000) })
          if (r2.ok) {
            const body = JSON.parse(await r2.text())
            // 猪猪返回 {ok, data:{session, latest, artifactPath, json:<repair-context>}}；老形状直接是正文，逐层兜底
            const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : null
            rc = data ? (data.json && typeof data.json === 'object' ? data.json : data) : body
          }
        } catch { }
      }
      if (!rc && res.repairContextPath && typeof readJsonFile === 'function') {
        try { rc = readJsonFile(res.repairContextPath) } catch { }
      }
      if (rc) res.repairDigest = digestRepairContext(rc)
    }
    onProgress({ phase: 'settled', label: item.label, ok: res.ok, status: res.status, sessionId: res.sessionId, redVerdict: res.redVerdict })
    return res
  }

  return { results, elapsedMs: now() - t0 }
}
