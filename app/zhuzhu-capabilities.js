// ============================================================================
// 猪猪新能力的 lab 侧消费层（方案 §7.2：「lab 侧的 reconcile_coverage 需要改成消费它们」）
//
// 本模块的第一性原则是 **fail-closed 降级**：
//   接口缺位 → 返回 `{ available:false, why }`，让上层把结论写成「未验证」，
//   **绝不把「问不到」当成「通过」**。fail-open 会让 guard.fake_green 永远是 0——比没建更坏，
//   因为纸面上「三灯全 0」和「从没统计过」长得一模一样（这正是方案 E1 要治的病）。
//
// ⚠ **2026-09-07 实测大修（读 vision-e2e 源码 + 真调坐实，见复盘 §3.112）**。第一版是在
// 「猪猪一个接口都还没上线」时按路线图**猜**着写的，猜错了三处，其中两处是**假绿**——比 404 更坏，
// 因为 404 至少诚实降级成「未验证」：
//
//   1. **`POST /visual-review` 从来不存在**（Z-E 视觉验收）。猪猪 v1.6 就交付了 Z-E，但形态是
//      **测试文件里的步骤类型** `assertVisual` / `assertVisualPeers`，产物是 **run 级的
//      `visual-review.json`**，并且已经挂在我们本来就在读的 run summary 上（`summary.visualReview`，
//      vision-e2e `runtime/reporting/run-feedback.js:316`）。**它压根没有 HTTP 端点**——
//      `GET /capabilities` 全表 26 条里没有，他们自己那份 `docs/lab-guarded-run-capability-plan.md:101`
//      （C3 就是我们提的需求）写的输入也是「猪猪 `visual-review.json`」。**是我们凭同族命名习惯造了一个端点，
//      然后把它 404 读成「猪猪没实现」，白挂四个月人工债。**
//   2. **`/preflight` 不是「三道门」，是 Z-L 无人值守准入探针**（vision-e2e `runtime/server/preflight.js`
//      开头原文："can this machine be trusted to run unattended tonight?"）：查 workspace 可写 / 磁盘 /
//      CPU 内存并发建议 / 发现文件 / 两条通道 / 前端可达 / auth profile / 孤儿会话。**它的响应里根本没有
//      `pageErrors` / `envFresh` / `visualRegressions` 这三个字段**，于是旧代码 `undefined > 0 === false`
//      三连、`blocking` 恒空 → 每轮都在打印「✅ 三道全局门通过」。一道门都没开却报三道全通。
//   3. **`/env-fingerprint` 不返回 `fresh` 布尔**：它给的是 `{frontend:{buildId,chunkHashes},compositeId,…}`
//      这份**指纹**。旧代码 `r.data?.fresh !== false` → `undefined !== false` → **true**，同样是假绿。
//      新鲜度在猪猪那边是**跑中判**的（测试文件 `settings.freshness.{maxAgeMinutes,requireChangedSince}`
//      → 命中就 `blocked` + `stale-artifact`，见 `runtime/perception/environment-fingerprint.js:345`）；
//      lab 侧只有指纹、没有比较基线时，新鲜度就是 **null（未验证）**，不是 true。
//
// 教训（已进员工工牌）：**「我猜的路径 404」和「猪猪没实现」长得一模一样**；而「我猜的字段不存在」
// 比 404 更毒——它不报错，它给你一个绿灯。故本模块此后**只认两个事实源**：
//   · `GET /capabilities`（v1.9 REQ-Z25 起，26 条能力的 id/状态/**真实路径**）—— 端点在不在，问它；
//   · 真实响应里**确实存在的字段** —— 判定用的字段必须在实测样本里见过，`undefined` 一律当未验证。
// 版本号不作判据（`since` 只用来解释，不用来推断能力有无）。
//
// 纯编排 + 依赖注入（fetch 由调用方传入），便于 `node --test` 单测、不启动 server。
// ============================================================================

export const ZHUZHU_TIMEOUT_MS = 20_000

// 能力清单：key → { path, method, label, z, catalogId }。path 相对猪猪 base。
// ⚠ 端点以猪猪 `GET <base>/capabilities`（v1.9 REQ-Z25）为权威，`catalogId` 就是对表用的 id；
// 目录缺位时才退回这里登记的路径（老版本猪猪没有这个端点）。**路径全部经 2026-09-07 真调坐实。**
//
// `requiresQuery` / `requiresSession`：**探活时必须跳过盲调**的端点。踩过：`/env-fingerprint` 不带
// `baseUrl` 必然 400、`/test-sessions/{id}/report-card` 拿占位 id 必然 404 —— 两个都被旧探活读成
// 「猪猪未实现」，而它们其实一直是 `ga`。**参数不全导致的 4xx 不是能力缺位。**
export const CAPABILITIES = {
  // 2026-08-27 实测定稿：真实端点是 `POST /evidence/verify`（对接文档 endpoints 全表坐实；
  // 我方原先自己猜的 `/verify-evidence` 常年 404 → 被 probeCapabilities 当成「猪猪未实现」，
  // 于是 RED 校准一直降级走标题正则。**猜的路径 404 与真的没实现，长得一模一样。**
  verifyEvidence: { path: '/evidence/verify', method: 'POST', label: 'verify_evidence（证据包签发/核验）', z: 'Z-D', catalogId: 'verify_evidence', pathConfirmed: true },
  reportCard: { path: '/test-sessions/{id}/report-card', method: 'GET', label: 'report-card（QA 报告卡片素材）', z: 'Z-K', catalogId: 'get_report_card', pathConfirmed: true, requiresSession: true },
  // Z-L：**无人值守准入探针**（今晚这台机器能不能放手跑），不是页面报错/视觉门。别再把它当三道门。
  preflight: { path: '/preflight', method: 'GET', label: 'preflight（Z-L 无人值守准入探针）', z: 'Z-L', catalogId: 'preflight', pathConfirmed: true },
  envFingerprint: { path: '/env-fingerprint', method: 'GET', label: 'get_env_fingerprint（环境指纹）', z: 'Z-B', catalogId: 'get_env_fingerprint', pathConfirmed: true, requiresQuery: ['baseUrl'] },
  uiContract: { path: '/ui-contract', method: 'GET', label: 'GET /ui-contract（组件→入口图谱）', z: 'Z-P', catalogId: 'get_ui_contract', pathConfirmed: true },
  // 会话信封（`{id,status,rounds:[{runtimeReports:[…report.json 绝对路径]}]}`）。
  // ⚠ **它不是 run summary**（2026-09-07 实测踩到）：`visualReview` / `pageErrors` / `environmentFingerprint`
  // 那份 `createRunSummary` 落在**磁盘**上——`<outputRoot>/runs/<runId>/summary.json`，
  // 信封只给到达那里的路径。所以 Z-E 的消费路径是「信封或 runId → 磁盘 summary.json」，见 sessionRunDirs()。
  sessionInfo: { path: '/test-sessions/{id}', method: 'GET', label: 'get_run_summary（会话信封：状态/轮次/产物路径）', z: 'Z-15', catalogId: 'get_run_summary', pathConfirmed: true, requiresSession: true },
  // 对接文档 —— workspace / output 绝对路径的唯一权威源（CLAUDE.md 铁律：别在别处存副本）
  integrationDoc: { path: '/external-integration-documents', method: 'GET', label: 'get_integration_doc（workspace/output 绝对路径）', z: '—', catalogId: 'get_integration_doc', pathConfirmed: true },
  // Z-F 权限矩阵 login-as：受限账号 facet 可测的那件人工债，靠它。
  authBootstrap: { path: '/auth-profiles/{id}/bootstrap', method: 'POST', label: 'bootstrap_auth_profile（Z-F 权限矩阵 login-as）', z: 'Z-F', catalogId: 'bootstrap_auth_profile', pathConfirmed: true, requiresSession: true },
  // 能力目录本身（v1.9 REQ-Z25）。它在 = 从此不必猜端点；它不在 = 老版本猪猪，退回逐个真调。
  catalog: { path: '/capabilities', method: 'GET', label: 'get_capabilities（能力目录：真实路径的唯一事实源）', z: 'Z25', catalogId: 'get_capabilities', pathConfirmed: true },
}
// Z-D 定义的 failureClass 取值域（路线图 §Z-D 原文）。**只有 value-assertion 算校准红**：
// action/reach/page-error/env/timeout 都是「没跑到断言」或「环境坏了」，把它们当校准红＝假校准。
export const FAILURE_CLASSES = ['value-assertion', 'action', 'reach', 'page-error', 'env', 'timeout']

const trimBase = b => String(b || '').trim().replace(/\/+$/, '')

// 单次调用。返回统一信封 `{ available, data, why, status }`——上层只看 available，不用各自 try/catch。
// pathOverrides：来自 `runs/zhuzhu-config.json` 的 `capabilityPaths`，端点定稿后改配置即可（见 CAPABILITIES 注释）。
export async function callCapability(key, { baseUrl, token, body, query, fetchImpl, timeoutMs, pathOverrides, sessionId } = {}) {
  const cap = CAPABILITIES[key]
  if (!cap) return { available: false, why: `未登记的猪猪能力 key「${key}」`, data: null, status: 0 }
  const base = trimBase(baseUrl)
  if (!base) return { available: false, why: '猪猪基地址为空——去看板「猪猪对接设置」填（主机会漂移，别写死）', data: null, status: 0 }
  const f = fetchImpl || globalThis.fetch
  if (typeof f !== 'function') return { available: false, why: '本进程没有 fetch（Node 18+ 才有）', data: null, status: 0 }
  const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : ''
  // 路径模板里的 {id} 用 sessionId 填（Z-K 是 /test-sessions/{id}/report-card）。没给 sessionId 时
  // 留成字面 `{id}` 会打出一个必然 404 的地址，反而误报「未实现」→ 直接如实拒。
  let p = String((pathOverrides && pathOverrides[key]) || cap.path)
  if (p.includes('{id}')) {
    if (!sessionId) return { available: false, why: `${cap.label} 的端点需要 sessionId（路径模板 ${p}），本次没有可用的会话 id`, data: null, status: 0 }
    p = p.replace('{id}', encodeURIComponent(String(sessionId)))
  }
  const url = base + p + qs
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || ZHUZHU_TIMEOUT_MS) : null
  try {
    const headers = { Accept: 'application/json' }
    // 方案 §7.3 安全变更预告：猪猪 v1.5 把写操作改成「默认回环 + 需 token」。
    // 只读不受影响，但我们**统一带上** token（有就带），免得 v1.5 上线那天所有写调用一起 401。
    if (token) headers.Authorization = `Bearer ${token}`
    const init = { method: cap.method, headers, signal: ctl?.signal }
    if (cap.method !== 'GET' && body != null) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body) }
    const res = await f(url, init)
    const text = await res.text().catch(() => '')
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text.slice(0, 2000) } }
    if (res.status === 404 || res.status === 501) return { available: false, why: `猪猪未实现 ${cap.label}（HTTP ${res.status}，v1.5 待上线）`, data: null, status: res.status }
    if (res.status === 401 || res.status === 403) return { available: false, why: `猪猪拒绝鉴权（HTTP ${res.status}）——写操作需 token，见「猪猪对接设置」的写 token 字段（方案 §7.3）`, data: null, status: res.status }
    if (!res.ok) return { available: false, why: `猪猪 ${cap.label} 返回 HTTP ${res.status}：${text.slice(0, 200)}`, data, status: res.status }
    return { available: true, data: data && typeof data === 'object' && data.data !== undefined ? data.data : data, why: '', status: res.status }
  } catch (e) {
    const msg = String(e?.name === 'AbortError' ? `超时 ${timeoutMs || ZHUZHU_TIMEOUT_MS}ms` : (e?.message || e))
    return { available: false, why: `连不上猪猪 ${cap.label}：${msg}（确认猪猪桌面 App 在运行、主机可达）`, data: null, status: 0 }
  } finally { if (timer) clearTimeout(timer) }
}

// ---------- 能力目录（v1.9 REQ-Z25）：端点真相的唯一事实源 ----------
// 返回 { available, byId:{id:{status,method,path,since,summary}}, service, why }。
// 目录里的 path 模板用 `{sessionId}` / `{profile}`，我方模板统一用 `{id}`，这里归一。
const normalizePathTemplate = p => String(p || '').replace(/\{(?:sessionId|externalRunId|profile|name)\}/g, '{id}')
export async function fetchCatalog(opts = {}) {
  const r = await callCapability('catalog', { ...opts, timeoutMs: opts.timeoutMs || 6000 })
  if (!r.available) return { available: false, byId: {}, service: '', why: r.why }
  const d = r.data || {}
  const byId = {}
  for (const c of (Array.isArray(d.capabilities) ? d.capabilities : [])) {
    const id = String(c.id || '').trim()
    if (!id) continue
    byId[id] = {
      status: String(c.status || ''), since: String(c.since || ''), summary: String(c.summary || ''),
      method: c.http?.method ? String(c.http.method).toUpperCase() : '', path: normalizePathTemplate(c.http?.path || ''),
      readOnly: c.readOnly !== false, surface: String(c.surface || ''),
    }
  }
  return { available: true, byId, service: String(d.service || ''), catalogVersion: d.catalogVersion ?? null, why: '' }
}

// 一次探活全部能力（看板「猪猪对接设置」的能力矩阵 + 晨检包的「本轮哪些机器门是开的」）。
//
// **2026-09-07 重写**：目录优先、盲调兜底。旧版逐个真调，对两类端点必然误判成「未实现」：
//   · 需查询参数的（`/env-fingerprint` 少 `baseUrl` → 400）；
//   · 需真实 id 的（`/test-sessions/{id}/report-card` 拿 `__probe__` → 404）。
// 这两个其实一直是 `ga`，却被写进晨检包「猪猪未实现」四个月。**参数不全导致的 4xx ≠ 能力缺位。**
export async function probeCapabilities(opts = {}) {
  const keys = Object.keys(CAPABILITIES)
  const cat = await fetchCatalog(opts)
  const results = await Promise.all(keys.map(async k => {
    const cap = CAPABILITIES[k]
    const base = { label: cap.label, z: cap.z }
    // ① 目录里点了名 → 直接采信（`status` 非 ga/beta 才算不可用），并带出目录里的真实路径。
    if (cat.available && cap.catalogId && cat.byId[cap.catalogId]) {
      const c = cat.byId[cap.catalogId]
      const ok = c.status === 'ga' || c.status === 'beta'
      return [k, { ...base, available: ok, status: 200, source: 'catalog', catalogStatus: c.status, path: c.path, since: c.since, why: ok ? '' : `猪猪能力目录把 ${cap.catalogId} 标为 ${c.status || '(无状态)'}` }]
    }
    // ② 目录在、但没有这条 → 这是**真的没有**（目录是全表），不必再打一枪。
    if (cat.available && cap.catalogId) {
      return [k, { ...base, available: false, status: 404, source: 'catalog', why: `猪猪能力目录（${cat.service || 'capabilities'}）里没有 ${cap.catalogId} —— 该能力不存在 HTTP 面，别再按名字猜端点` }]
    }
    // ③ 目录缺位（老版本猪猪）→ 退回真调；但需参/需 id 的端点不盲调，如实记「未探测」。
    if (cap.requiresQuery?.length || cap.requiresSession) {
      return [k, { ...base, available: null, status: 0, source: 'skipped', why: `需要${cap.requiresQuery?.length ? ` ${cap.requiresQuery.join('/')} 参数` : '真实 sessionId'}才能调，空参探活只会拿到 4xx —— 不盲调、不据此判缺位（结论：未探测）` }]
    }
    const r = await callCapability(k, { ...opts, body: cap.method === 'GET' ? undefined : { probe: true }, timeoutMs: opts.timeoutMs || 6000 })
    return [k, { ...base, available: r.available, why: r.why, status: r.status, source: 'probe' }]
  }))
  const map = Object.fromEntries(results)
  const ready = keys.filter(k => map[k].available === true)
  return {
    map, ready,
    missing: keys.filter(k => map[k].available === false),
    unknown: keys.filter(k => map[k].available == null),
    catalog: cat.available ? { service: cat.service, count: Object.keys(cat.byId).length } : null,
    allReady: ready.length === keys.length,
  }
}

// ---------- verify_evidence：批量核验一批 facet 的 GREEN/RED 证据 ----------
// 入参 items: [{ facetId, runId, caseId }]；出参 map: { FACET_ID: {ok, failureClass, discriminativePower, pageErrors, envFresh, reason, dirty} }
// 猪猪缺位 → `{ available:false, map:null }`，交给 guard-ledger.deriveFakeGreen 记「未验证」。
// 归一化一行 verify 结果 → lab 内部形状。**按 Z-D 的原文字段收口**，同时容忍常见变体：
//   valid / ok / verified          → ok
//   reasons[] / reason / why       → reason
//   discriminativePower: {score}   → 0..1（路线图给的 score 是 0–100，这里除以 100；给纯数字且 ≤1 时按已归一化处理）
//   pageErrors: [...] 或 数字      → 计数
//   environmentFingerprint.fresh   → envFresh（拿不到就是 undefined，**不当新鲜**）
export function normalizeVerifyRow(row) {
  const r = row && typeof row === 'object' ? row : {}
  const dpRaw = r.discriminativePower ?? r.discriminative_power
  let dp = null
  if (dpRaw != null) {
    const n = typeof dpRaw === 'object' ? Number(dpRaw.score) : Number(dpRaw)
    if (Number.isFinite(n)) dp = n > 1 ? n / 100 : n     // 0–100 → 0..1；已是 0..1 的原样用
  }
  const pe = r.pageErrors ?? r.page_errors
  const env = r.environmentFingerprint ?? r.environment_fingerprint ?? r.environment
  const reasons = Array.isArray(r.reasons) ? r.reasons.filter(Boolean).map(String) : []
  return {
    // Z-D 用 `valid`；兼容 ok/verified。三者全缺时视为通过（能返回一行就说明核过了），但只要有一个说 false 就是 false。
    ok: r.valid !== false && r.ok !== false && r.verified !== false,
    verdict: r.verdict || '',
    failureClass: r.failureClass || r.failure_class || '',
    discriminativePower: dp,
    discriminativeWeak: Array.isArray(dpRaw?.weak) ? dpRaw.weak.map(String) : [],
    pageErrors: Array.isArray(pe) ? pe.length : (Number(pe || 0) || 0),
    envFresh: r.envFresh !== undefined ? !!r.envFresh
      : (env && typeof env === 'object' && env.fresh !== undefined) ? !!env.fresh
      : (r.env_fresh !== undefined ? !!r.env_fresh : undefined),
    dirty: r.codeRefs?.dirty === true || r.dirty === true,      // 证据绑的代码是脏工作区 → B1 未落地的机读信号
    reason: reasons.length ? reasons.join('；') : String(r.reason || r.why || ''),
  }
}

export async function verifyEvidenceBatch(items, opts = {}) {
  const list = (items || []).filter(x => x && (x.runId || x.caseId))
  if (!list.length) return { available: true, map: {}, why: '无需核验（没有带 runId/case 的 GREEN 行）' }
  // Z-D 的 verify_evidence 签名是 `({bundlePath | sessionId, caseId})` 单条。我们按 facet 批量发一个
  // `items` 数组；若猪猪只收单条，端点会返 4xx，上层照旧走「未验证」而不是假装通过（fail-closed）。
  const r = await callCapability('verifyEvidence', { ...opts, body: { items: list.map(x => ({ facetId: String(x.facetId || '').toUpperCase(), sessionId: x.runId || '', caseId: x.caseId || '' })) } })
  if (!r.available) return { available: false, map: null, why: r.why }
  const rows = Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.items) ? r.data.items : (Array.isArray(r.data?.results) ? r.data.results : []))
  const map = {}
  for (const row of rows) {
    const key = String(row.facetId || row.facet || '').toUpperCase() || String(row.sessionId || row.runId || '')
    if (!key) continue
    map[key] = normalizeVerifyRow(row)
  }
  return { available: true, map, why: '' }
}

// ---------- C7：RED 校准判据换成结构判据 ----------
// 旧口径：扫步骤标题里有没有 `assert` 字样（中文标题得硬加英文 assert 才被认可，且「把动作失败包装成
// 断言失败」这条后门一直开着）。新口径：只认 `failureClass === 'value-assertion'`。
// 猪猪缺位时返回 `unknown`——**不是 pass**。上层据此把该 facet 的 RED 记为「未校准」。
// ---------- C7 的落点②：reconcile_coverage 签发 RED 证据那一刻的判据 ----------
// 旧口径（`isCalibratedRed`）是 `/assert|capture|expect/i` 扫 `firstFailure.actionType + title`。
// 两个后果都实测过：① 中文步骤标题必须硬加英文 `assert` 才被认可（迷糊 memories 里记了这条）；
// ② 「把动作失败包装成 assert 标题」这条后门一直开着——动作步挂了也能签成校准红。
//
// 新口径：**只要 summary 里有 `failureClass`（Z-D），就只认 `value-assertion`**；
// 没有该字段时才退回标题正则，且**把这次的判据来源标出来**（`redBasis=title-regex`），
// 让 F1 假绿猎手与晨检包能区分「结构判定的校准红」和「正则蒙对的校准红」。
// 刻意**不**在猪猪未上线时直接判不校准：那会让今天所有 QA 轮一夜之间全签不出 RED（真回归），
// 而本模块的原则是「未验证不等于通过」，不是「未验证等于失败」——所以降级但留痕。
//
// **2026-08-27 更正**：`failureClass` 从来不在 `summary.json` 里——Z-D 把它写在同级的
// `evidence-bundle.json`（连同 verdict / discriminativePower / testHash / signature）。
// 我方只翻 summary，于是「字段不存在」被读成「猪猪未上线」，一路降级到标题正则，还把这个
// 假事实印进了员工提示与晨检包。故本函数改收第二个入参 `bundle`（同目录 evidence-bundle.json），
// 优先级：bundle.failureClass > summary.failureClass > firstFailure.failureClass > 标题正则。
export const RED_BASIS_STRUCTURAL = 'failureClass', RED_BASIS_REGEX = 'title-regex'
const RED_TITLE_RE = /assert|capture|expect/i
export function classifyRedFromSummary(summary, bundle) {
  const s = summary && typeof summary === 'object' ? summary : {}
  const b = bundle && typeof bundle === 'object' ? bundle : {}
  const f = s.firstFailure || {}
  const fc = String(b.failureClass || s.failureClass || f.failureClass || f.failure_class || '')
  if (fc) {
    const ok = fc === 'value-assertion'
    return { calibrated: ok, basis: RED_BASIS_STRUCTURAL, failureClass: fc, why: ok ? `failureClass=${fc}（结构判定：真的是值断言断出来的红）` : classifyRedCalibration({ failureClass: fc }).why }
  }
  const hit = RED_TITLE_RE.test(`${f.actionType || ''} ${f.title || ''}`)
  return {
    calibrated: hit, basis: RED_BASIS_REGEX, failureClass: '',
    why: hit
      ? '标题/actionType 命中 assert|capture|expect（**正则降级判定**：该 run 目录下没读到 `evidence-bundle.json` 的 `failureClass`——多半是猪猪版本偏旧或产物被裁剪，**不要据此断定 Z-D 未上线**；本条 RED 未经结构判定，晨检包会标注）'
      : '红没落在断言/capture 步（正则降级判定），不算校准红',
  }
}

export const RED_CALIBRATED = 'calibrated', RED_NOT_CALIBRATED = 'not-calibrated', RED_UNKNOWN = 'unknown'
// Z-D 的取值 → 「为什么这条不算校准红」的人话（措辞要能直接抄进 QA 报告，别让员工自己编）
const NOT_CALIBRATED_WHY = {
  action: '动作步失败（点不动/填不进），根本没跑到断言——把它当校准红＝假校准',
  reach: 'reach 失败（页面/状态没到达），断言没被执行过',
  'page-error': '页面在报错导致失败——这是 Z-A 页面报错门该拦的，不是断言区分度的证明',
  env: '环境失败（陈旧产物/服务没起/网络）——证明的是环境坏了，不是代码坏了能被测出来',
  timeout: '超时——超时红不能证明断言断得着',
}
export function classifyRedCalibration(verifyRow) {
  if (!verifyRow) return { verdict: RED_UNKNOWN, why: '无 verify_evidence 记录（猪猪 v1.5 未接通或该 run 无证据包）——按「未校准」处理，不许当通过' }
  const fc = String(verifyRow.failureClass || '')
  if (!fc) return { verdict: RED_UNKNOWN, why: '证据包没有 failureClass 字段（猪猪版本偏旧）——按「未校准」处理' }
  if (fc === 'value-assertion') return { verdict: RED_CALIBRATED, why: 'failureClass=value-assertion（真的是值断言断出来的红）' }
  const known = NOT_CALIBRATED_WHY[fc]
  return {
    verdict: RED_NOT_CALIBRATED,
    why: known ? `failureClass=${fc}：${known}` : `failureClass=${fc}——不在 Z-D 定义的取值域（${FAILURE_CLASSES.join(' / ')}）内，无法确认是值断言失败，按未校准处理`,
  }
}

// ---------- Z-L：无人值守准入探针（今晚这台机器能不能放手跑） ----------
// **这不是「三道门」**——见文件头 §2 的实测更正。它查的是 workspace 可写 / 磁盘 / CPU 内存与并发建议 /
// 服务发现文件 / app-run 与 headless 两条通道 / 前端可达 / auth profile / 孤儿会话。
// 猪猪口径（`runtime/server/preflight.js` 的设计规则）：`fail` = 今晚别开跑；`warn` = 能跑但会费时间；
// 每条都带 `detail` + `fix`（"一个没有指令的黄灯只是把 debug 推到凌晨三点"）。我们原样透传，不二次解释。
export async function admissionProbe({ baseUrl: target } = {}, opts = {}) {
  const r = await callCapability('preflight', { ...opts, query: target ? { baseUrl: target } : undefined })
  if (!r.available) return { ok: null, blocking: [], warnings: [], degraded: [{ gate: 'preflight', why: r.why }], raw: null }
  const d = r.data || {}
  const checks = Array.isArray(d.checks) ? d.checks : []
  const pick = s => checks.filter(c => String(c.status) === s).map(c => ({ gate: String(c.name || ''), why: String(c.detail || ''), fix: String(c.fix || '') }))
  const blocking = pick('fail')
  return {
    ok: blocking.length === 0, blocking, warnings: pick('warn'), degraded: [],
    ready: d.ready === true, verdict: String(d.verdict || ''), message: String(d.message || ''),
    recommendedConcurrency: Number(d.recommendedConcurrency) || null,
    counts: d.counts || null, raw: d,
  }
}

// ---------- Z-B：环境新鲜度（**只有能证明时才说话**） ----------
// `/env-fingerprint` 给的是指纹不是判决：`{frontend:{buildId,chunkHashes,buildTime},backends,compositeId}`。
// 旧代码读 `data.fresh`（不存在）→ `undefined !== false` → true，是本模块治了一路的那种假绿。
//
// 真正的新鲜度门在**猪猪跑中**：测试文件 `settings.freshness.{maxAgeMinutes,requireChangedSince}`，
// 命中就整轮 `blocked` + `stale-artifact`、零步执行。lab 侧能做的只有比对指纹：
//   · 给了 `previousCompositeId` 且**不同** → 产物确实换过 → fresh:true
//   · 相同 **且调用方声明改过码**（codeChanged）→ 改动没进浏览器 → fresh:false（陈旧）
//   · 其余一律 **null＝未验证**（相同指纹 + 没改码是正常的，不能算陈旧，也不能算新鲜）
export async function envFreshness({ baseUrl: target, previousCompositeId = '', codeChanged = null } = {}, opts = {}) {
  if (!target) return { available: false, fresh: null, compositeId: '', why: '没有被测环境地址（baseUrl）——`/env-fingerprint` 必须带它，否则 400。去「猪猪对接设置」填被测前端地址' }
  const r = await callCapability('envFingerprint', { ...opts, query: { baseUrl: target } })
  if (!r.available) return { available: false, fresh: null, compositeId: '', why: r.why }
  const d = r.data || {}
  const compositeId = String(d.compositeId || '')
  const buildId = String(d.frontend?.buildId || '')
  const prev = String(previousCompositeId || '')
  let fresh = null, why = ''
  if (prev && compositeId && prev !== compositeId) { fresh = true; why = `指纹已变（${prev.slice(0, 24)}… → ${compositeId.slice(0, 24)}…）——跑的确实是新产物` }
  else if (prev && compositeId && prev === compositeId && codeChanged === true) { fresh = false; why = '指纹与上一轮逐字节相同、但本轮声明改过码 —— **改动没进浏览器**（dev-server watcher 死掉长这样），这批绿不可信' }
  else why = prev
    ? '指纹与上一轮相同、且没有「改过码」的声明——这本身正常，**不能据此说新鲜**（要判定请在测试文件挂 `settings.freshness.requireChangedSince`，由猪猪跑中判 stale-artifact）'
    : '只拿到指纹、没有比较基线 —— 新鲜度**未验证**（不是通过）。要真判定请在测试文件挂 `settings.freshness.{maxAgeMinutes,requireChangedSince}`，猪猪会跑中拦成 blocked'
  return { available: true, fresh, compositeId, buildId, why, raw: d }
}

// ---------- 落盘产物的定位：Z-E 视觉素材 / Z-A 页面报错 / Z-B 指纹的真实落点 ----------
// 这三样都在**磁盘上的 run summary** 里：`<outputRoot>/runs/<runId>/summary.json`。
// outputRoot 由对接文档给（`workspace.outputRoot`），**不在我方存副本**（CLAUDE.md 铁律：会漂移）。
export async function docWorkspace(opts = {}) {
  const r = await callCapability('integrationDoc', opts)
  if (!r.available) return { available: false, why: r.why, workspaceRoot: '', outputRoot: '' }
  const w = r.data?.workspace || {}
  const outputRoot = String(w.outputRoot || '')
  if (!outputRoot) return { available: false, why: '对接文档里没有 workspace.outputRoot —— 定位不到 run 产物目录', workspaceRoot: String(w.workspaceRoot || ''), outputRoot: '' }
  return { available: true, why: '', workspaceRoot: String(w.workspaceRoot || ''), outputRoot }
}

// 会话 → 它各轮的 run 目录（信封 `rounds[].runtimeReports[]` 是 report.json 的绝对路径，取其所在目录）。
// 给 `visual_acceptance` 之类「我只有 sessionId」的场景用。
export async function sessionRunDirs(sessionId, opts = {}) {
  const r = await callCapability('sessionInfo', { ...opts, sessionId })
  if (!r.available) return { available: false, why: r.why, dirs: [] }
  const rounds = Array.isArray(r.data?.rounds) ? r.data.rounds : []
  const dirs = []
  for (const rd of rounds) {
    for (const p of (Array.isArray(rd.runtimeReports) ? rd.runtimeReports : [])) {
      const dir = String(p || '').replace(/[\\/][^\\/]*$/, '')     // 去掉文件名，留目录（Win/POSIX 两种分隔符都吃）
      if (dir && !dirs.includes(dir)) dirs.push(dir)
    }
  }
  if (!dirs.length) return { available: false, why: `会话 ${sessionId} 的信封里没有 runtimeReports 路径（可能还没跑完，或产物被清理）`, dirs: [] }
  return { available: true, why: '', dirs }
}

// ---------- Z-E 素材包的定位与三态（**2026-09-07 真跑一遍后按实测形状重写**） ----------
// 踩到的两件事，都是「按名字想象形状」的老病：
//   ① `summary.visualReview` **只是存根**：`{ items: <数量>, artifactPath: <绝对路径> }`。
//      真素材（box / tokens / accessibility / truncation / peers / differences）在**单独的
//      `visual-review.json`** 里。第一版按 `Array.isArray(v.items)` 读 → 拿到数字 1 → 判「素材为空」。
//   ② **判 `visual-no-baseline` / `visual-theme-mismatch` 的那趟根本不产素材**：
//      `evaluateVisualAssertion` 在这两个分支**提前 return**，走不到 `collectVisualReview`
//      （vision-e2e visual-baseline.js:386-404 / 420-434）。所以「首跑录基线」那趟 `visualReview` 为
//      null，而它**确实挂了断言、确实跑了**——把它说成「一条视觉断言都没挂」是冤枉用例。
// 故这里必须给三态，并且「挂没挂」要去 steps 里数，不能只看素材有没有。
export function visualReviewFromSummary(summary) {
  const v = summary?.visualReview
  const kinds = assertionKindsInSummary(summary)
  const attached = kinds.has('assertVisual') || kinds.has('assertVisualPeers')
  if (!v) {
    return attached
      ? {
          available: false, attached: true, itemCount: 0, artifactPath: '', items: [],
          why: '视觉断言**跑了但没产出素材** —— `assertVisual` 判 `visual-no-baseline`（首跑刚录基线，硬口径：录了也不算过）或 `visual-theme-mismatch` 时会提前返回、不采集素材。结论是「本轮无可判素材」：**既不是没挂，也不是通过**。基线已录的话，下一趟再跑就有 GREEN/差异可判了',
        }
      : {
          available: false, attached: false, itemCount: 0, artifactPath: '', items: [],
          why: '该 run 一条视觉断言都没挂（steps 里没有 `assertVisual` / `assertVisualPeers`）。结论只能是「未做视觉验收」，不许写成「视觉无问题」',
        }
  }
  const itemCount = Array.isArray(v.items) ? v.items.length : (Number(v.items) || 0)
  const artifactPath = String(v.artifactPath || '')
  // 老形状兼容：万一哪天 summary 里直接内联了 items 数组，直接用
  if (Array.isArray(v.items) && v.items.length) return { available: true, attached: true, itemCount, artifactPath, items: v.items, why: '' }
  if (!itemCount || !artifactPath) {
    return { available: false, attached, itemCount, artifactPath, items: [], why: `\`visualReview\` 存根在但取不到素材（items=${itemCount}, artifactPath=${artifactPath || '(空)'}）——按「无可判素材」记，不许当通过` }
  }
  // 素材要从 artifactPath 那个文件读（本模块不碰 fs，交调用方；读法见 server.js 的 readVisualReviewArtifact）
  return { available: false, needsArtifact: true, attached: true, itemCount, artifactPath, items: [], why: `素材在 ${artifactPath}（${itemCount} 条），需读该文件后再判` }
}

// 素材文件（`visual-review.json`）的内容 → 判定入参。纯函数，便于单测。
// 形状：`{runId, testContext, reviewVersion, generatedAt, note, items:[…]}`。
export function visualReviewFromArtifact(doc) {
  const items = Array.isArray(doc?.items) ? doc.items : []
  if (!items.length) return { available: false, attached: true, items: [], why: '素材文件里 items 为空——按「无可判素材」记' }
  return { available: true, attached: true, items, itemCount: items.length, why: '', raw: doc }
}

// 从 run summary 取页面报错（Z-A）。
// **2026-09-07 按真实形状修正**：`pageErrors` 是个对象
// `{policy, phasePolicy, baseUrl, total, failing, suppressed, outOfScope, dropped, allowlist[]}`，
// 不是数组也不是数字。门要看的是 **`failing`**——实测样本 `total: 200 / suppressed: 200 / failing: 0`
// （登录页企微 SSO 的 CDN 噪声被 allowlist 收了）。**拿 `total` 当门的取值会把每一轮都判红。**
// `pageErrors` 为 `null` 表示这一 run 早于该门存在（口径见 vision-e2e run-feedback.js:306 的注释：
// 「消费方必须能把它和 0 区分开」）——所以我们也**绝不把 null 当 0**。
export function pageErrorsFromSummary(summary) {
  const pe = summary?.pageErrors
  if (pe == null) return { available: false, count: null, why: '该 run 的 summary 里 `pageErrors` 为 null —— 收集器没跑过（run 早于 Z-A 页面报错门）。**null 不是 0**，按未验证记' }
  // 老产物兼容：早期若是数组/数字，按其长度/值当 failing
  if (Array.isArray(pe)) return { available: true, count: pe.length, suppressed: 0, policy: '', samples: pe.slice(0, 3).map(x => String(x?.message || x?.text || x)), why: '' }
  if (typeof pe === 'number') return { available: true, count: pe, suppressed: 0, policy: '', samples: [], why: '' }
  const failing = Number(pe.failing ?? pe.total ?? 0) || 0
  return {
    available: true, count: failing,
    total: Number(pe.total || 0) || 0, suppressed: Number(pe.suppressed || 0) || 0, dropped: Number(pe.dropped || 0) || 0,
    policy: String(pe.policy || ''), allowlistSize: Array.isArray(pe.allowlist) ? pe.allowlist.length : 0,
    samples: (Array.isArray(pe.failingSamples) ? pe.failingSamples : (Array.isArray(pe.entries) ? pe.entries : [])).slice(0, 3).map(x => String(x?.message || x?.text || x)),
    // policy=off 时这道门等于没开：`failing:0` 只说明「没人判」，不说明「没报错」
    why: String(pe.policy || '') === 'off' ? '⚠ `pageErrorPolicy=off` —— 这道门本轮**没开**，`failing:0` 不代表页面没报错' : '',
  }
}

// 本轮**真挂了哪些断言类型**。人工债三态靠它，而不是靠「telemetry 字段在不在」——
// `performance` / `downloads` 这类采集器**无论有没有断言都会产出**（orchestrator 注释原话：
// 性能采集 "entirely advisory"），拿它们的存在当「债清了」就是又一次假绿。
//
// ⚠ **必须同时看 `expectation.type`，不能只看 `actionType`**（2026-09-07 实测坐实）：
// 猪猪把「不碰元素的断言型步骤」（`assertVisual` / `assertVisualPeers` / `assertPerf` /
// `assertFile` / `assertResidue` / `assertNoPageError` / `assertConsistency`）**统一归一到
// `capture` 这个 no-op 动作**（`runtime/protocol/normalize.js:112-121` 原话：
// "assertion-only steps that touch no element reuse the no-op capture action path and carry
// their verdict entirely in the expectation"），真正的种类落在 `expectation.kind/type` 里。
// 只数 actionType 的话，**挂了视觉断言也会被判成「一条都没挂」**——判据必须跟着归一化走。
export function assertionKindsInSummary(summary) {
  const steps = Array.isArray(summary?.steps) ? summary.steps : []
  const out = new Set()
  for (const s of steps) {
    const a = String(s?.actionType || s?.type || '')
    if (a) out.add(a)
    const e = s?.expectation
    const k = String(e?.type || e?.kind || '')
    if (k) out.add(k)
  }
  return out
}

// ---------- Z-P：UI 契约图谱 → 「这个组件被哪些入口复用」 ----------
// A4（跨入口一致性 facet 生成器）与 B3（变更影响面雷达）都吃它。
// 猪猪缺位时**退回本地** `app/ui-contract.js` 抽取的产物（那份已在跑、覆盖 testid→board/subTab 维度），
// 是降级但不是空——方案 A4 的价值不该被一个未上线接口整条挡住。
export async function uiContractGraph(opts = {}) {
  const r = await callCapability('uiContract', opts)
  if (!r.available) return { available: false, why: r.why, components: {} }
  const d = r.data || {}
  const components = {}
  for (const c of (Array.isArray(d.components) ? d.components : [])) {
    const name = String(c.name || c.component || '').trim()
    if (!name) continue
    components[name] = (Array.isArray(c.entries) ? c.entries : (Array.isArray(c.callers) ? c.callers : [])).map(String)
  }
  return { available: true, why: '', components, raw: d }
}

// 从本地 UI 状态契约产物派生「组件 → 入口」（猪猪 Z-P 缺位时的降级源）。
// 本地契约的每条 action 带 board / subTab —— 同一个 testid 出现在多个 (board,subTab) 组合下，
// 就等价于「同一组件被多个入口复用」，正是 A4 需要的信号（部位排序那类逃逸缺陷的解药）。
export function localEntryMap(contractDoc) {
  const actions = Array.isArray(contractDoc?.actions) ? contractDoc.actions : []
  const byTestid = new Map()
  for (const a of actions) {
    const tid = String(a?.testid || '').trim()
    if (!tid) continue
    const entry = [a.board || '(无board)', a.subTab ? `subTab=${a.subTab}` : null].filter(Boolean).join('/')
    if (!byTestid.has(tid)) byTestid.set(tid, new Set())
    byTestid.get(tid).add(entry)
  }
  const components = {}
  for (const [tid, set] of byTestid) if (set.size >= 1) components[tid] = [...set].sort()
  return { available: Object.keys(components).length > 0, why: Object.keys(components).length ? '' : '本地 UI 状态契约产物为空/未生成', components, source: 'local-ui-contract' }
}

// ---------- Z-K：report-card 机器事实 ----------
// C4 的输入。铁律：LLM 只改写不新增事实 —— 所以这里把「机器给的事实」原样带出，
// 并附一份 `factKeys` 供 qa-report-card.js 做「有没有凭空多出事实」的机器校验。
// 按 Z-K 的原文形状解析：`{sessionId, verdictSummary, byFacet:[{facet, verdict, whatWasDone[],
// whatWasChecked[], evidence, redCalibration}], risks[], notCovered:[{facet, reason, suggestedCapability}],
// environment, dataResidue[]}`。把 byFacet 摊平成 did/checked（LLM 的素材），notCovered 原样带出。
// **关键**：`notCovered[].suggestedCapability` 必须原样保留 —— Z-K 的设计意图是「人工债自动挂账、
// 不许无限期挂着」，LLM 改写时要照抄，不许润色掉。
export async function reportCard(payload, opts = {}) {
  const r = await callCapability('reportCard', { ...opts, sessionId: payload?.sessionId || opts.sessionId, body: undefined })
  if (!r.available) return { available: false, why: r.why, card: null }
  const d = r.data || {}
  const byFacet = Array.isArray(d.byFacet) ? d.byFacet : []
  const did = [], checked = [], evidence = []
  for (const f of byFacet) {
    const tag = f.facet ? `[${f.facet}] ` : ''
    for (const s of (Array.isArray(f.whatWasDone) ? f.whatWasDone : [])) did.push(tag + String(s))
    for (const c of (Array.isArray(f.whatWasChecked) ? f.whatWasChecked : [])) {
      checked.push(typeof c === 'string' ? tag + c
        : `${tag}${c.subject || '?'}：期望 ${c.expected ?? '?'} / 实际 ${c.actual ?? '?'}${c.kind ? `（${c.kind}）` : ''}`)
    }
    const ev = f.evidence || {}
    if (ev.bundle) evidence.push(`${tag}证据包 ${ev.bundle}`)
    if (Array.isArray(ev.screenshots) && ev.screenshots.length) evidence.push(`${tag}截图 ${ev.screenshots.length} 张`)
    if (f.redCalibration?.present) evidence.push(`${tag}RED 校准：failureClass=${f.redCalibration.failureClass || '?'}${f.redCalibration.injection ? `（注入方式：${f.redCalibration.injection}）` : ''}`)
  }
  return {
    available: true, why: '',
    card: {
      // 兼容两种形状：Z-K 的 byFacet 摊平结果优先；平铺 did/checked 作为退路
      did: did.length ? did : (Array.isArray(d.did) ? d.did : []),
      checked: checked.length ? checked : (Array.isArray(d.checked) ? d.checked : []),
      evidence: evidence.length ? evidence : (Array.isArray(d.evidence) ? d.evidence : []),
      risks: (Array.isArray(d.risks) ? d.risks : []).map(x => (typeof x === 'string' ? x : `${x.kind || '风险'}${x.facet ? `（${x.facet}）` : ''}：${x.detail || ''}`)),
      uncovered: (Array.isArray(d.notCovered) ? d.notCovered : (Array.isArray(d.uncovered) ? d.uncovered : []))
        .map(x => (typeof x === 'string' ? { facetId: x, reason: '', suggestedCapability: '' }
          : { facetId: String(x.facet || x.facetId || '').toUpperCase(), reason: String(x.reason || ''), suggestedCapability: String(x.suggestedCapability || x.suggested_capability || '') })),
      runIds: [d.sessionId, ...(Array.isArray(d.runIds) ? d.runIds : [])].filter(Boolean).map(String),
      verdictSummary: d.verdictSummary || null,
      dataResidue: Array.isArray(d.dataResidue) ? d.dataResidue : [],
    },
  }
}

// ---------- 基地址不通时的归因（复盘 §3.106）----------
// 缘起：run 20260826094846-95a6e0 —— 办公室存的 base 是已死的 32148、活的 App 在 32147。
// MCP 挂载地址由 base 拼，于是员工侧 18 个 mcp__zhuzhu__* 工具**静默全缺**；而当时工牌里写的是
// 「工具不可见 → 多半是 App 没启动」，把她指向了错误分支（App 当时就在跑），最终误判「登录必须人工」。
// 这两种情况在员工眼里长得一模一样，唯一能区分它们的事实是：**同机其它端口有没有人应答**。
// 纯函数，便于单测；措辞直接进注入块，别让员工自己编。
export function diagnoseBaseUnreachable({ base, aliveCandidates } = {}) {
  const alive = (aliveCandidates || []).filter(Boolean)
  if (alive.length) {
    return {
      cause: 'base-drift',
      why: `办公室存的基地址 ${base} 不通，但同机 ${alive.join(' / ')} 有应答——**是 base 漂了，不是 App 没起**`,
      fix: `在看板「猪猪对接设置」把 baseUrl 改成 ${alive[0]}（或 POST /api/zhuzhu-config），改完 mcp__zhuzhu__* 工具才会回来`,
      aliveCandidates: alive,
    }
  }
  return {
    cause: 'app-down',
    why: `基地址 ${base} 不通，同机其它常见端口也没应答——多半是猪猪桌面 App 确实没启动`,
    // 2026-09-23：旧措辞只说「启动 App 后重试」，迷糊读成「需人工」把整批 park（run 20260922144153-c0f876）。
    // 起猪猪是她职责内的活——把在哪、怎么起写死在这句里，不给「够不到 GUI」留解释空间。
    fix: '猪猪是你的测试工具、你自己起：在 E2E 工具目录 vision-e2e（仓根同级 ../vision-e2e）脱离会话后台跑 `npm run dev`、钉 `ZHUZHU_APP_RUN_PORT=32147`（完整命令见 SOP 红线 10），轮询到 200 后继续；本会话 mcp__zhuzhu__* 若没挂上就直接调同源 HTTP 端点。起不来才贴日志尾升级，不许当阻塞 park',
    aliveCandidates: [],
  }
}
