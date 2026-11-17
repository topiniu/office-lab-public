import test from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITIES, diagnoseBaseUnreachable, callCapability, normalizeVerifyRow, classifyRedFromSummary, RED_BASIS_STRUCTURAL, RED_BASIS_REGEX, probeCapabilities, fetchCatalog, verifyEvidenceBatch, classifyRedCalibration, RED_CALIBRATED, RED_NOT_CALIBRATED, RED_UNKNOWN, admissionProbe, envFreshness, visualReviewFromSummary, visualReviewFromArtifact, pageErrorsFromSummary, assertionKindsInSummary, docWorkspace, sessionRunDirs, uiContractGraph, localEntryMap, reportCard } from '../zhuzhu-capabilities.js'

// 假 fetch：按 URL 路由到预设响应
const fakeFetch = routes => async (url, init) => {
  for (const [frag, r] of Object.entries(routes)) {
    if (String(url).includes(frag)) return { ok: r.status < 400, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null)), _init: init }
  }
  return { ok: false, status: 404, text: async () => 'not found' }
}
const OPTS = base => ({ baseUrl: base || 'http://127.0.0.1:32147' })

// ---------- 降级第一性：接口缺位绝不当通过 ----------
test('基地址为空 → available:false，并提示去设置页填（主机会漂移，别写死）', async () => {
  const r = await callCapability('verifyEvidence', { baseUrl: '', fetchImpl: fakeFetch({}) })
  assert.equal(r.available, false)
  assert.match(r.why, /猪猪对接设置/)
})
test('未登记的 key 直接拒（拼错端点不该静默返回空数据）', async () => {
  assert.match((await callCapability('nope', OPTS())).why, /未登记的猪猪能力/)
})
test('404 / 501 → 明确写「猪猪未实现，v1.5 待上线」，不是「失败」也不是「通过」', async () => {
  for (const status of [404, 501]) {
    const r = await callCapability('verifyEvidence', { ...OPTS(), fetchImpl: fakeFetch({ '/evidence/verify': { status } }) })
    assert.equal(r.available, false)
    assert.match(r.why, /v1\.5 待上线/)
  }
})
test('401/403 → 指向「写操作需 token」（方案 §7.3 的安全变更）', async () => {
  const r = await callCapability('verifyEvidence', { ...OPTS(), fetchImpl: fakeFetch({ '/evidence/verify': { status: 401 } }) })
  assert.match(r.why, /写操作需 token/)
  assert.match(r.why, /§7\.3/)
})
test('带 token 时统一加 Authorization 头（免得 v1.5 上线那天写调用一起 401）', async () => {
  let seen = null
  const f = async (url, init) => { seen = init; return { ok: true, status: 200, text: async () => '{}' } }
  await callCapability('verifyEvidence', { ...OPTS(), token: 'tk-1', body: { items: [] }, fetchImpl: f })
  assert.equal(seen.headers.Authorization, 'Bearer tk-1')
  assert.equal(seen.headers['Content-Type'], 'application/json')
  assert.equal(seen.body, '{"items":[]}')
})
test('无 body 的 POST 不硬塞 Content-Type（探活用的空调用）', async () => {
  let seen = null
  const f = async (url, init) => { seen = init; return { ok: true, status: 200, text: async () => '{}' } }
  await callCapability('verifyEvidence', { ...OPTS(), fetchImpl: f })
  assert.equal(seen.headers['Content-Type'], undefined)
  assert.equal(seen.body, undefined)
})
test('GET 能力不发 body、query 拼进 URL', async () => {
  let seenUrl = '', seenInit = null
  const f = async (url, init) => { seenUrl = url; seenInit = init; return { ok: true, status: 200, text: async () => '{}' } }
  await callCapability('uiContract', { ...OPTS(), query: { scope: 'sampling' }, fetchImpl: f })
  assert.match(seenUrl, /\/ui-contract\?scope=sampling$/)
  assert.equal(seenInit.body, undefined)
})
test('非 JSON 响应不炸（落成 raw 片段）', async () => {
  const r = await callCapability('verifyEvidence', { ...OPTS(), fetchImpl: fakeFetch({ '/evidence/verify': { status: 200, body: '<html>oops' } }) })
  assert.equal(r.available, true)
  assert.match(r.data.raw, /oops/)
})
test('data 包一层时自动解包（猪猪两种返回形状都吃）', async () => {
  const r = await callCapability('preflight', { ...OPTS(), fetchImpl: fakeFetch({ '/preflight': { status: 200, body: { data: { pageErrors: 0 } } } }) })
  assert.deepEqual(r.data, { pageErrors: 0 })
})
// Z-K 的端点是 `GET /test-sessions/{id}/report-card`（路线图原文）。没 sessionId 时打出的地址必然 404，
// 那会把「我们没给 id」误报成「猪猪未实现」——所以直接如实拒，不发请求。
test('路径模板缺 sessionId → 直接拒，不发一个必然 404 的请求（免得误报「未实现」）', async () => {
  let called = false
  const r = await callCapability('reportCard', { ...OPTS(), fetchImpl: async () => { called = true; return { ok: false, status: 404, text: async () => '' } } })
  assert.equal(r.available, false)
  assert.match(r.why, /需要 sessionId/)
  assert.equal(called, false)
})
test('sessionId 填进路径模板并 URL 编码', async () => {
  let seenUrl = ''
  const f = async (url) => { seenUrl = url; return { ok: true, status: 200, text: async () => '{}' } }
  await callCapability('reportCard', { ...OPTS(), sessionId: 'sess/1 2', fetchImpl: f })
  assert.equal(seenUrl, 'http://127.0.0.1:32147/test-sessions/sess%2F1%202/report-card')
})
test('capabilityPaths 可逐个覆盖端点（路线图只定了 Z-K 一个路径，其余待定稿）', async () => {
  let seenUrl = ''
  const f = async (url) => { seenUrl = url; return { ok: true, status: 200, text: async () => '{}' } }
  await callCapability('verifyEvidence', { ...OPTS(), pathOverrides: { verifyEvidence: '/api/v2/evidence/verify' }, body: {}, fetchImpl: f })
  assert.equal(seenUrl, 'http://127.0.0.1:32147/api/v2/evidence/verify')
})
test('基地址尾斜杠被规范化，不出现双斜杠', async () => {
  let seenUrl = ''
  const f = async url => { seenUrl = url; return { ok: true, status: 200, text: async () => '{}' } }
  await callCapability('uiContract', { baseUrl: 'http://h:1/', fetchImpl: f })
  assert.equal(seenUrl, 'http://h:1/ui-contract')
})

// ---------- 探活（2026-09-07：目录优先、不盲调需参端点） ----------
// 真实目录形状：{ok, data:{service, capabilities:[{id, status, http:{method,path}, since}]}}
const CATALOG_BODY = {
  ok: true,
  data: {
    service: 'zhuzhu-runtime-v2', catalogVersion: 1,
    capabilities: [
      { id: 'get_capabilities', status: 'ga', since: '1.9.0', http: { method: 'GET', path: '/capabilities' } },
      { id: 'get_integration_doc', status: 'ga', since: '1.2.1', http: { method: 'GET', path: '/external-integration-documents' } },
      { id: 'verify_evidence', status: 'ga', since: '1.5.0', http: { method: 'POST', path: '/evidence/verify' } },
      { id: 'get_report_card', status: 'ga', since: '1.5.0', http: { method: 'GET', path: '/test-sessions/{sessionId}/report-card' } },
      { id: 'preflight', status: 'ga', since: '1.5.0', http: { method: 'GET', path: '/preflight' } },
      { id: 'get_env_fingerprint', status: 'ga', since: '1.5.0', http: { method: 'GET', path: '/env-fingerprint' } },
      { id: 'get_ui_contract', status: 'ga', since: '1.6.0', http: { method: 'GET', path: '/ui-contract' } },
      { id: 'get_run_summary', status: 'ga', since: '1.2.0', http: { method: 'GET', path: '/test-sessions/{sessionId}' } },
      { id: 'bootstrap_auth_profile', status: 'ga', since: '1.6.0', http: { method: 'POST', path: '/auth-profiles/{profile}/bootstrap' } },
    ],
  },
}
test('能力目录把 {sessionId}/{profile} 归一成 {id}（我方模板口径）', async () => {
  const c = await fetchCatalog({ ...OPTS(), fetchImpl: fakeFetch({ '/capabilities': { status: 200, body: CATALOG_BODY } }) })
  assert.equal(c.available, true)
  assert.equal(c.byId.get_report_card.path, '/test-sessions/{id}/report-card')
  assert.equal(c.byId.bootstrap_auth_profile.path, '/auth-profiles/{id}/bootstrap')
})
test('目录可用时全部采信目录，不再逐个真调（一枪都不打）', async () => {
  let calls = 0
  const f = async (url, init) => { calls += 1; return fakeFetch({ '/capabilities': { status: 200, body: CATALOG_BODY } })(url, init) }
  const p = await probeCapabilities({ ...OPTS(), fetchImpl: f })
  assert.equal(calls, 1)                                    // 只调了目录本身
  assert.equal(p.ready.length, Object.keys(CAPABILITIES).length)
  assert.equal(p.allReady, true)
  assert.equal(p.map.verifyEvidence.source, 'catalog')
  assert.ok(p.map.verifyEvidence.z)                          // 带 Z 编号，晨检包要显示
  assert.deepEqual(p.catalog, { service: 'zhuzhu-runtime-v2', count: 9 })
})
test('目录里没有这条 → 判 false 并明说「别再按名字猜端点」（Z-E 那个幻觉端点的解药）', async () => {
  const body = { ok: true, data: { service: 'zhuzhu-runtime-v2', capabilities: [{ id: 'preflight', status: 'ga', http: { method: 'GET', path: '/preflight' } }] } }
  const p = await probeCapabilities({ ...OPTS(), fetchImpl: fakeFetch({ '/capabilities': { status: 200, body } }) })
  assert.equal(p.map.verifyEvidence.available, false)
  assert.match(p.map.verifyEvidence.why, /没有 verify_evidence/)
  assert.match(p.map.verifyEvidence.why, /别再按名字猜端点/)
})
test('目录标 experimental/deprecated → 不算 ready', async () => {
  const body = { ok: true, data: { capabilities: [{ id: 'preflight', status: 'experimental', http: { method: 'GET', path: '/preflight' } }] } }
  const p = await probeCapabilities({ ...OPTS(), fetchImpl: fakeFetch({ '/capabilities': { status: 200, body } }) })
  assert.equal(p.map.preflight.available, false)
  assert.match(p.map.preflight.why, /experimental/)
})
test('目录缺位（老猪猪）→ 需参/需 id 的端点判 null「未探测」，绝不因空参 4xx 判缺位', async () => {
  // 这正是四个月假事实的成因：/env-fingerprint 少 baseUrl → 400、report-card 拿占位 id → 404
  const p = await probeCapabilities({ ...OPTS(), fetchImpl: fakeFetch({ '/preflight': { status: 200, body: {} } }) })
  assert.equal(p.map.envFingerprint.available, null)
  assert.equal(p.map.reportCard.available, null)
  assert.equal(p.map.sessionInfo.available, null)
  assert.match(p.map.envFingerprint.why, /不盲调/)
  assert.ok(p.unknown.includes('envFingerprint'))
  assert.deepEqual(p.ready, ['preflight'])   // 目录与对接文档这两枪也真打了，只是这份 fake 只放行 /preflight
  assert.equal(p.catalog, null)
})

// ---------- verify_evidence ----------
test('没有可核验项时算 available（不是错误），返回空 map', async () => {
  const r = await verifyEvidenceBatch([], OPTS())
  assert.equal(r.available, true)
  assert.deepEqual(r.map, {})
})
test('缺 runId/caseId 的项被过滤掉（核验不了的别混进去）', async () => {
  const r = await verifyEvidenceBatch([{ facetId: 'A-F1' }], OPTS())
  assert.equal(r.available, true)
  assert.deepEqual(r.map, {})
})
test('接口缺位 → map 为 null，交给上层记「未验证」', async () => {
  const r = await verifyEvidenceBatch([{ facetId: 'A-F1', runId: 'r1' }], { ...OPTS(), fetchImpl: fakeFetch({}) })
  assert.equal(r.available, false)
  assert.equal(r.map, null)
})
test('归一化 snake_case / camelCase 两种字段名（别让上层去猜）', async () => {
  const body = { items: [{ facetId: 'A-F1', ok: true, failure_class: 'value-assertion', discriminative_power: 0.8, page_errors: 0, env_fresh: true, codeRefs: { dirty: true } }] }
  const r = await verifyEvidenceBatch([{ facetId: 'A-F1', runId: 'r1' }], { ...OPTS(), fetchImpl: fakeFetch({ '/evidence/verify': { status: 200, body } }) })
  const row = r.map['A-F1']
  assert.equal(row.failureClass, 'value-assertion')
  assert.equal(row.discriminativePower, 0.8)
  assert.equal(row.envFresh, true)
  assert.equal(row.dirty, true)
})
// Z-D 的 discriminativePower 是 `{score: 78, signals:[], weak:[]}`，score 是 **0–100**；
// 而 lab 侧的假绿阈值口径是 0..1。归一化错了会把 78 分的健康用例判成「区分度 78 > 0.5，正常」——
// 看着对，但把 0.3 分（＝0.003）这类真弱断言也判成正常，阈值形同虚设。
test('discriminativePower 的 0–100 分被归一化到 0..1；已是 0..1 的原样用', () => {
  assert.equal(normalizeVerifyRow({ discriminativePower: { score: 78 } }).discriminativePower, 0.78)
  assert.equal(normalizeVerifyRow({ discriminativePower: 78 }).discriminativePower, 0.78)
  assert.equal(normalizeVerifyRow({ discriminativePower: 0.42 }).discriminativePower, 0.42)
  assert.equal(normalizeVerifyRow({ discriminativePower: { score: 100 } }).discriminativePower, 1)
  assert.equal(normalizeVerifyRow({}).discriminativePower, null)
})
test('weak signals 带出来（供报告说明「弱在哪」）', () => {
  assert.deepEqual(normalizeVerifyRow({ discriminativePower: { score: 20, weak: ['presence-only'] } }).discriminativeWeak, ['presence-only'])
})
test('pageErrors 是数组时取长度（Z-D 给的是数组，不是计数）', () => {
  assert.equal(normalizeVerifyRow({ pageErrors: [{ msg: 'TypeError' }, { msg: 'x' }] }).pageErrors, 2)
  assert.equal(normalizeVerifyRow({ pageErrors: 3 }).pageErrors, 3)
  assert.equal(normalizeVerifyRow({}).pageErrors, 0)
})
test('envFresh 从 environmentFingerprint.fresh 取；拿不到就是 undefined（**不当新鲜**）', () => {
  assert.equal(normalizeVerifyRow({ environmentFingerprint: { fresh: false } }).envFresh, false)
  assert.equal(normalizeVerifyRow({ environmentFingerprint: {} }).envFresh, undefined)
  assert.equal(normalizeVerifyRow({}).envFresh, undefined)
})
test('Z-D 的 valid 字段被认；reasons 数组拼成一行', () => {
  const r = normalizeVerifyRow({ valid: false, reasons: ['summaryHash 不符', '签名过期'] })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'summaryHash 不符；签名过期')
})
test('codeRefs.dirty 带出来——证据绑的是脏工作区，即 B1 未落地的机读信号', () => {
  assert.equal(normalizeVerifyRow({ codeRefs: { commit: 'abc', dirty: true } }).dirty, true)
  assert.equal(normalizeVerifyRow({ codeRefs: { commit: 'abc' } }).dirty, false)
})
test('verified:false 也算不通过（两种字段名都认）', async () => {
  const body = { items: [{ facetId: 'A-F1', verified: false, reason: 'hash 不匹配' }] }
  const r = await verifyEvidenceBatch([{ facetId: 'A-F1', runId: 'r1' }], { ...OPTS(), fetchImpl: fakeFetch({ '/evidence/verify': { status: 200, body } }) })
  assert.equal(r.map['A-F1'].ok, false)
})

// ---------- C7 RED 校准结构判据 ----------
test('只认 failureClass=value-assertion 算校准红（中文标题不再影响判定）', () => {
  assert.equal(classifyRedCalibration({ failureClass: 'value-assertion' }).verdict, RED_CALIBRATED)
})
test('Z-D 取值域里的每一类非值断言失败都判 not-calibrated，且给出人话理由', () => {
  for (const [fc, re] of [['action', /没跑到断言/], ['reach', /没被执行过/], ['page-error', /Z-A/], ['env', /环境坏了/], ['timeout', /超时红/]]) {
    const r = classifyRedCalibration({ failureClass: fc })
    assert.equal(r.verdict, RED_NOT_CALIBRATED, fc)
    assert.match(r.why, re, fc)
  }
})
test('取值域外的 failureClass 也判 not-calibrated，并点明「不在 Z-D 定义的取值域内」', () => {
  const r = classifyRedCalibration({ failureClass: 'action-failure' })   // 像但不是（Z-D 里是 `action`）
  assert.equal(r.verdict, RED_NOT_CALIBRATED)
  assert.match(r.why, /不在 Z-D 定义的取值域/)
})
test('无记录 / 无 failureClass 字段 → unknown，且明说「不许当通过」', () => {
  assert.equal(classifyRedCalibration(null).verdict, RED_UNKNOWN)
  assert.match(classifyRedCalibration(null).why, /不许当通过/)
  assert.equal(classifyRedCalibration({}).verdict, RED_UNKNOWN)
})

// ---------- Z-L 无人值守准入探针（真实 checks[] 形状） ----------
// 2026-09-07 大修：旧版读 pageErrors/envFresh/visualRegressions —— 猪猪响应里**没有这三个字段**，
// 于是 blocking 恒空、每轮打印「✅ 三道全局门通过」。下面这条回归就是钉死那个假绿。
const PREFLIGHT_BODY = {
  ok: true,
  data: {
    ready: true, verdict: 'run-with-warnings', message: 'Safe to start, with 1 caveat', recommendedConcurrency: 3,
    counts: { pass: 9, warn: 1, fail: 0 },
    checks: [
      { name: 'workspace.writable', status: 'pass', detail: 'ok' },
      { name: 'auth.profile', status: 'warn', detail: 'profile 过期', fix: '跑 authBootstrap' },
    ],
  },
}
test('preflight 缺位 → ok:null 且标 degraded（不是 false、也不是 true）', async () => {
  const r = await admissionProbe({}, { ...OPTS(), fetchImpl: fakeFetch({}) })
  assert.equal(r.ok, null)
  assert.equal(r.degraded.length, 1)
})
test('按 checks[].status 分 fail→blocking / warn→warnings，并原样带出 fix', async () => {
  const r = await admissionProbe({ baseUrl: 'http://localhost:8000' }, { ...OPTS(), fetchImpl: fakeFetch({ '/preflight': { status: 200, body: PREFLIGHT_BODY } }) })
  assert.equal(r.ok, true)
  assert.deepEqual(r.blocking, [])
  assert.equal(r.warnings.length, 1)
  assert.equal(r.warnings[0].gate, 'auth.profile')
  assert.equal(r.warnings[0].fix, '跑 authBootstrap')
  assert.equal(r.recommendedConcurrency, 3)
})
test('有 fail 项 → ok:false（今晚别开跑）', async () => {
  const body = { ok: true, data: { ready: false, verdict: 'do-not-start', checks: [{ name: 'frontend.reachable', status: 'fail', detail: '8000 没人应答', fix: '起前端' }] } }
  const r = await admissionProbe({}, { ...OPTS(), fetchImpl: fakeFetch({ '/preflight': { status: 200, body } }) })
  assert.equal(r.ok, false)
  assert.deepEqual(r.blocking.map(b => b.gate), ['frontend.reachable'])
})
test('**回归：preflight 不含页面报错/视觉字段时，绝不冒充「三道门全过」**', async () => {
  // 旧代码在这份响应上会打印「✅ 三道全局门通过：页面无报错、环境指纹新鲜、视觉基线无回归」
  const r = await admissionProbe({}, { ...OPTS(), fetchImpl: fakeFetch({ '/preflight': { status: 200, body: PREFLIGHT_BODY } }) })
  assert.equal(r.raw.pageErrors, undefined)        // 字段确实不存在
  assert.equal(r.raw.visualRegressions, undefined)
  // 本函数只答准入，不答那两道门：结果里没有任何以门为名的通过结论
  assert.ok(!Object.keys(r).includes('visualBaseline'))
})

// ---------- Z-B 环境新鲜度：只有能证明时才说话 ----------
const FP_BODY = { ok: true, data: { baseUrl: 'http://localhost:8000', frontend: { buildId: 'abc+def' }, compositeId: 'fe:abc+def' } }
test('没有被测环境地址 → 直接拒（/env-fingerprint 少 baseUrl 必然 400）', async () => {
  const r = await envFreshness({}, OPTS())
  assert.equal(r.available, false)
  assert.equal(r.fresh, null)
  assert.match(r.why, /baseUrl/)
})
test('**回归：拿到指纹但没有比较基线 → fresh:null（旧代码读 data.fresh 恒 true，是假绿）**', async () => {
  const r = await envFreshness({ baseUrl: 'http://localhost:8000' }, { ...OPTS(), fetchImpl: fakeFetch({ '/env-fingerprint': { status: 200, body: FP_BODY } }) })
  assert.equal(r.available, true)
  assert.equal(r.fresh, null)                      // 不是 true
  assert.equal(r.raw.fresh, undefined)             // 猪猪压根不返回这个字段
  assert.match(r.why, /未验证/)
})
test('指纹变了 → fresh:true；指纹没变且声明改过码 → fresh:false（改动没进浏览器）', async () => {
  const opts = { ...OPTS(), fetchImpl: fakeFetch({ '/env-fingerprint': { status: 200, body: FP_BODY } }) }
  assert.equal((await envFreshness({ baseUrl: 'x', previousCompositeId: 'fe:old' }, opts)).fresh, true)
  assert.equal((await envFreshness({ baseUrl: 'x', previousCompositeId: 'fe:abc+def', codeChanged: true }, opts)).fresh, false)
  // 同指纹但没声明改码：正常，不许判陈旧、也不许判新鲜
  assert.equal((await envFreshness({ baseUrl: 'x', previousCompositeId: 'fe:abc+def' }, opts)).fresh, null)
})

// ---------- Z-E / Z-A 的真实落点：run summary 字段 ----------
// 2026-09-07 真跑一遍后按实测重写：`summary.visualReview` 只是存根 `{items:<数量>, artifactPath}`，
// 真素材在单独的 visual-review.json；且判 visual-no-baseline 的那趟**提前返回、根本不采集素材**。
test('没挂视觉断言 → 判「未做视觉验收」（不是「视觉没问题」）', () => {
  const r = visualReviewFromSummary({ steps: [{ actionType: 'click' }] })
  assert.equal(r.available, false)
  assert.equal(r.attached, false)
  assert.match(r.why, /一条视觉断言都没挂/)
})
test('★ 挂了断言但判 visual-no-baseline（首跑录基线）→ 「无可判素材」，既不是没挂也不是通过', () => {
  // 真实首跑形状：steps 里有断言（actionType 归一成 capture、种类在 expectation.type），visualReview 为 null
  const r = visualReviewFromSummary({ visualReview: null, steps: [{ actionType: 'capture', expectation: { type: 'assertVisual' }, message: 'visual-no-baseline' }] })
  assert.equal(r.available, false)
  assert.equal(r.attached, true)          // 关键：别把「跑了但无素材」冤枉成「没挂」
  assert.match(r.why, /既不是没挂，也不是通过/)
})
test('★ visualReview 是存根（items 是数量 + artifactPath）→ 要求调用方去读素材文件', () => {
  const r = visualReviewFromSummary({
    visualReview: { items: 1, artifactPath: 'D:/w/output/runs/r1/visual-review.json' },
    steps: [{ actionType: 'capture', expectation: { type: 'assertVisual' } }],
  })
  assert.equal(r.needsArtifact, true)
  assert.equal(r.available, false)        // 存根本身不足以判定
  assert.equal(r.itemCount, 1)
  assert.equal(r.artifactPath, 'D:/w/output/runs/r1/visual-review.json')
})
test('存根有数量但没 artifactPath → 「无可判素材」，不许当通过', () => {
  const r = visualReviewFromSummary({ visualReview: { items: 2 }, steps: [{ actionType: 'capture', expectation: { type: 'assertVisual' } }] })
  assert.equal(r.available, false)
  assert.match(r.why, /不许当通过/)
})
test('素材文件内容 → available + items（visualReviewFromArtifact）', () => {
  const r = visualReviewFromArtifact({ reviewVersion: 1, items: [{ kind: 'peers', selector: '[data-testid="m"]' }] })
  assert.equal(r.available, true)
  assert.equal(r.items.length, 1)
})
test('素材文件 items 为空 → 不可判（不静默当过）', () => {
  assert.equal(visualReviewFromArtifact({ items: [] }).available, false)
})
test('老形状兼容：summary 里直接内联 items 数组时仍能直接用', () => {
  const r = visualReviewFromSummary({ visualReview: { reviewVersion: 1, items: [{ kind: 'baseline' }] }, steps: [] })
  assert.equal(r.available, true)
  assert.equal(r.items.length, 1)
})
test('pageErrors 为 null → 未验证；**null 绝不当 0**（口径同猪猪 run-feedback 注释）', () => {
  const a = pageErrorsFromSummary({ pageErrors: null })
  assert.equal(a.available, false)
  assert.equal(a.count, null)
  assert.match(a.why, /null 不是 0/)
  const b = pageErrorsFromSummary({ pageErrors: [] })
  assert.equal(b.available, true)
  assert.equal(b.count, 0)
  const c = pageErrorsFromSummary({ pageErrors: [{ message: 'TypeError: x' }] })
  assert.equal(c.count, 1)
  assert.deepEqual(c.samples, ['TypeError: x'])
})

// ---------- Z-P 入口图谱 + 本地降级源 ----------
test('猪猪 /ui-contract 可用时解析 components→entries（两种键名都吃）', async () => {
  const body = { components: [{ name: 'btn-a', entries: ['e1', 'e2'] }, { component: 'btn-b', callers: ['e3'] }] }
  const g = await uiContractGraph({ ...OPTS(), fetchImpl: fakeFetch({ '/ui-contract': { status: 200, body } }) })
  assert.deepEqual(g.components['btn-a'], ['e1', 'e2'])
  assert.deepEqual(g.components['btn-b'], ['e3'])
})
test('猪猪缺位时上层可用本地 UI 契约降级：同一 testid 出现在多个 board 即视为多入口', () => {
  const doc = { actions: [
    { testid: 'x', board: 'priceReview' },
    { testid: 'x', board: 'sampleReview', subTab: '2' },
    { testid: 'y', board: 'priceReview' },
  ] }
  const m = localEntryMap(doc)
  assert.equal(m.available, true)
  assert.equal(m.components['x'].length, 2)
  assert.equal(m.components['y'].length, 1)
  assert.equal(m.source, 'local-ui-contract')
})
test('本地产物为空/畸形 → available:false 且给出原因（不静默返回空对象）', () => {
  assert.equal(localEntryMap(null).available, false)
  assert.match(localEntryMap({ actions: [] }).why, /为空\/未生成/)
})

// ---------- Z-K report-card（按路线图原文形状） ----------
const ZK_BODY = {
  sessionId: 'sess-1',
  verdictSummary: { green: 12, red: 1, blocked: 0, residue: 1 },
  byFacet: [{
    facet: 'REQ-0239-F1', verdict: 'green',
    whatWasDone: ['以 cj00001 登录', '复制『上衣』新建品类『内裤QA-x』'],
    whatWasChecked: [{ kind: 'value', subject: '品类下拉', expected: '含内裤QA-x', actual: '含内裤QA-x' }],
    evidence: { screenshots: ['a.png', 'b.png'], bundle: 'evidence-bundle.json' },
    redCalibration: { present: true, failureClass: 'value-assertion', injection: 'copy off' },
  }],
  risks: [{ kind: 'weak-oracle', facet: 'REQ-0239-F2', detail: '只断了存在性' }],
  notCovered: [{ facet: 'REQ-0303-F1', reason: 'human-inherent:导出排版观感', suggestedCapability: 'Z-C/Z-E' }],
  dataResidue: [{ entity: '品类', name: '内裤QA-x' }],
}
test('report-card 按 Z-K 的 byFacet 摊平成 did/checked/evidence，并带 facet 标签', async () => {
  const r = await reportCard({ sessionId: 'sess-1' }, { ...OPTS(), fetchImpl: fakeFetch({ '/report-card': { status: 200, body: ZK_BODY } }) })
  assert.equal(r.available, true)
  assert.equal(r.card.did.length, 2)
  assert.match(r.card.did[0], /^\[REQ-0239-F1\] 以 cj00001 登录$/)
  assert.match(r.card.checked[0], /品类下拉：期望 含内裤QA-x \/ 实际 含内裤QA-x（value）/)
  assert.ok(r.card.evidence.some(e => /证据包 evidence-bundle\.json/.test(e)))
  assert.ok(r.card.evidence.some(e => /截图 2 张/.test(e)))
  assert.ok(r.card.evidence.some(e => /RED 校准：failureClass=value-assertion/.test(e)))
})
test('notCovered 的 reason 与 suggestedCapability 原样带出——「人工债自动挂账，不许无限期挂着」', async () => {
  const r = await reportCard({ sessionId: 'sess-1' }, { ...OPTS(), fetchImpl: fakeFetch({ '/report-card': { status: 200, body: ZK_BODY } }) })
  assert.deepEqual(r.card.uncovered, [{ facetId: 'REQ-0303-F1', reason: 'human-inherent:导出排版观感', suggestedCapability: 'Z-C/Z-E' }])
})
test('risks 的结构体被渲染成可读一行（不丢 kind/facet/detail 任一）', async () => {
  const r = await reportCard({ sessionId: 'sess-1' }, { ...OPTS(), fetchImpl: fakeFetch({ '/report-card': { status: 200, body: ZK_BODY } }) })
  assert.match(r.card.risks[0], /weak-oracle（REQ-0239-F2）：只断了存在性/)
})
test('sessionId 进 runIds（报告里「证据在哪」要有它）', async () => {
  const r = await reportCard({ sessionId: 'sess-1' }, { ...OPTS(), fetchImpl: fakeFetch({ '/report-card': { status: 200, body: ZK_BODY } }) })
  assert.ok(r.card.runIds.includes('sess-1'))
})
test('平铺形状（无 byFacet）作为退路仍能解析', async () => {
  const body = { sessionId: 's', did: ['a'], checked: ['b'], evidence: ['e'], uncovered: ['F1'] }
  const r = await reportCard({ sessionId: 's' }, { ...OPTS(), fetchImpl: fakeFetch({ '/report-card': { status: 200, body } }) })
  assert.deepEqual(r.card.did, ['a'])
  assert.deepEqual(r.card.uncovered, [{ facetId: 'F1', reason: '', suggestedCapability: '' }])
})
test('report-card 缺位 → card:null（上层据此声明「素材受限」）', async () => {
  const r = await reportCard({ sessionId: 's' }, { ...OPTS(), fetchImpl: fakeFetch({}) })
  assert.equal(r.available, false)
  assert.equal(r.card, null)
})

// ---------- C7 落点②：reconcile 签发 RED 那一刻的判据（结构优先、正则降级留痕） ----------
test('summary 带 failureClass 时**只认**结构判据，标题写什么都不影响', () => {
  const a = classifyRedFromSummary({ failureClass: 'value-assertion', firstFailure: { title: '保存并提交' } })
  assert.equal(a.calibrated, true)
  assert.equal(a.basis, RED_BASIS_STRUCTURAL)
  // 反面：标题里明明有 assert，但结构判据说是动作失败 → 不算校准红（后门关闭）
  const b = classifyRedFromSummary({ failureClass: 'action', firstFailure: { title: 'assert 品类可选中', actionType: 'assertVisible' } })
  assert.equal(b.calibrated, false)
  assert.equal(b.basis, RED_BASIS_STRUCTURAL)
  assert.match(b.why, /没跑到断言/)
})
test('summary 无 failureClass 时退回标题正则，但**标明是降级判定**', () => {
  const r = classifyRedFromSummary({ firstFailure: { actionType: 'capture', title: '记录品类下拉' } })
  assert.equal(r.calibrated, true)
  assert.equal(r.basis, RED_BASIS_REGEX)
  assert.match(r.why, /正则降级判定/)
})
// 2026-08-27 回归：`failureClass` 的真实落点是同级 `evidence-bundle.json`，**不在 summary**。
// 只翻 summary 会常年降级到标题正则，还把「字段不存在」误报成「猪猪 Z-D 未上线」（真实事故，见 §3.106）。
test('failureClass 从 evidence-bundle 读得到时走结构判定（summary 里没有不代表平台没实现）', () => {
  const summary = { firstFailure: { actionType: 'click', title: '点击保存' } } // 标题正则本会判「不校准」
  const bundle = { bundleVersion: 1, verdict: 'red', failureClass: 'value-assertion' }
  const r = classifyRedFromSummary(summary, bundle)
  assert.equal(r.calibrated, true)
  assert.equal(r.basis, RED_BASIS_STRUCTURAL)
  assert.equal(r.failureClass, 'value-assertion')
})
test('bundle 说 action（动作步挂了）→ 即便标题写着 assert 也不算校准红', () => {
  const r = classifyRedFromSummary({ firstFailure: { title: 'assert 损耗率=0.05', actionType: 'capture' } }, { failureClass: 'action' })
  assert.equal(r.calibrated, false)
  assert.equal(r.basis, RED_BASIS_STRUCTURAL)
})
test('没有 bundle 时不改变旧行为（老产物兼容，仍降级留痕）', () => {
  const r = classifyRedFromSummary({ firstFailure: { actionType: 'capture', title: '记录损耗率' } }, null)
  assert.equal(r.basis, RED_BASIS_REGEX)
  assert.equal(r.calibrated, true)
})
test('降级提示不得再断言「Z-D 未上线」（那是我方探错路径得出的假事实）', () => {
  const r = classifyRedFromSummary({ firstFailure: { actionType: 'capture', title: '记录损耗率' } })
  assert.equal(r.basis, RED_BASIS_REGEX)
  // 文案必须指向真因（读不到 evidence-bundle.json），且必须显式劝阻「据此断定平台未实现」这一步推理
  assert.match(r.why, /evidence-bundle\.json/)
  assert.match(r.why, /不要据此断定/)
  assert.ok(!/，猪猪 Z-D 未上线/.test(r.why), '降级文案不许把「读不到字段」断言成「平台未实现」')
})
test('verifyEvidence 的端点必须是实测坐实的 /evidence/verify（猜路径会 404 → 误判未实现）', () => {
  assert.equal(CAPABILITIES.verifyEvidence.path, '/evidence/verify')
  assert.equal(CAPABILITIES.verifyEvidence.pathConfirmed, true)
})
test('降级判定下红没落在断言步 → 仍判不校准（旧行为保持，不放松）', () => {
  const r = classifyRedFromSummary({ firstFailure: { actionType: 'fill', title: '填写品类名称' } })
  assert.equal(r.calibrated, false)
  assert.equal(r.basis, RED_BASIS_REGEX)
})
test('空 summary 不炸，判不校准', () => {
  assert.equal(classifyRedFromSummary(null).calibrated, false)
  assert.equal(classifyRedFromSummary({}).calibrated, false)
})
test('firstFailure 上带 failureClass 也认（字段位置两种都吃）', () => {
  assert.equal(classifyRedFromSummary({ firstFailure: { failureClass: 'value-assertion' } }).basis, RED_BASIS_STRUCTURAL)
})

// ---------- §3.106：base 不通时必须区分「配置漂了」与「App 没起」 ----------
// 事故原文：办公室存 32148（已死）、App 活在 32147 → 员工侧 18 个 MCP 工具静默全缺；
// 而当时工牌写的是「工具不可见 → 多半是 App 没启动」，把她指向错误分支，最终误判「登录必须人工」。
test('同机别的端口有应答 → 判 base-drift，并给出该改成哪个（不许说成 App 没起）', () => {
  const d = diagnoseBaseUnreachable({ base: 'http://127.0.0.1:32148', aliveCandidates: ['http://127.0.0.1:32147'] })
  assert.equal(d.cause, 'base-drift')
  assert.match(d.why, /不是 App 没起/)
  assert.match(d.fix, /32147/)
})
test('同机都没应答 → 才判 app-down', () => {
  const d = diagnoseBaseUnreachable({ base: 'http://127.0.0.1:32147', aliveCandidates: [] })
  assert.equal(d.cause, 'app-down')
  assert.match(d.why, /App 确实没启动/)
  // 修法必须让她自己起猪猪，而不是读成「需人工」（run 20260922144153-c0f876 就是这么 park 掉整批的）
  assert.match(d.fix, /npm run dev/)
  assert.match(d.fix, /vision-e2e/)
  assert.match(d.fix, /ZHUZHU_APP_RUN_PORT=32147/)
})
test('aliveCandidates 缺省不炸，按 app-down 处理（探测本身失败时不冤枉配置）', () => {
  const d = diagnoseBaseUnreachable({ base: 'http://x:1' })
  assert.equal(d.cause, 'app-down')
  assert.deepEqual(d.aliveCandidates, [])
})

// ---------- 落盘产物定位（2026-09-07 实测：会话信封 ≠ run summary） ----------
test('对接文档给 outputRoot（我方不存副本，主机与工作区会漂移）', async () => {
  const body = { ok: true, data: { workspace: { workspaceRoot: 'D:/w/vision-e2e', outputRoot: 'D:/w/vision-e2e/output' } } }
  const w = await docWorkspace({ ...OPTS(), fetchImpl: fakeFetch({ '/external-integration-documents': { status: 200, body } }) })
  assert.equal(w.available, true)
  assert.equal(w.outputRoot, 'D:/w/vision-e2e/output')
})
test('对接文档没有 outputRoot → 如实 false（定位不到产物就别猜路径）', async () => {
  const w = await docWorkspace({ ...OPTS(), fetchImpl: fakeFetch({ '/external-integration-documents': { status: 200, body: { ok: true, data: { workspace: {} } } } }) })
  assert.equal(w.available, false)
  assert.match(w.why, /outputRoot/)
})
test('会话信封 → 各轮 run 目录（runtimeReports 去掉文件名，Win/POSIX 分隔符都吃、去重）', async () => {
  const body = { ok: true, data: { id: 's1', rounds: [
    { runtimeReports: ['D:\\w\\output\\runs\\r1\\report.json'] },
    { runtimeReports: ['D:/w/output/runs/r2/report.json', 'D:/w/output/runs/r2/report.json'] },
  ] } }
  const r = await sessionRunDirs('s1', { ...OPTS(), fetchImpl: fakeFetch({ '/test-sessions/s1': { status: 200, body } }) })
  assert.deepEqual(r.dirs, ['D:\\w\\output\\runs\\r1', 'D:/w/output/runs/r2'])
})
test('信封里没有产物路径 → 如实 false（还没跑完/产物被清）', async () => {
  const r = await sessionRunDirs('s1', { ...OPTS(), fetchImpl: fakeFetch({ '/test-sessions/s1': { status: 200, body: { ok: true, data: { rounds: [] } } } }) })
  assert.equal(r.available, false)
})

// ---------- 页面报错：真实对象形状（`failing` 才是门的取值） ----------
// 实测样本：total 200 / suppressed 200 / failing 0（登录页企微 SSO 的 CDN 噪声被 allowlist 收了）。
// 拿 total 当取值会把每一轮都判红——这个方向的错和假绿一样贵。
test('pageErrors 是对象：门看 `failing`，不看 `total`', () => {
  const r = pageErrorsFromSummary({ pageErrors: { policy: 'fail', total: 200, suppressed: 200, failing: 0, dropped: 268, allowlist: [{ match: 'SyntaxError' }] } })
  assert.equal(r.available, true)
  assert.equal(r.count, 0)
  assert.equal(r.total, 200)
  assert.equal(r.suppressed, 200)
  assert.equal(r.allowlistSize, 1)
})
test('policy=off 时点明「这道门本轮没开」（failing:0 不代表页面没报错）', () => {
  const r = pageErrorsFromSummary({ pageErrors: { policy: 'off', total: 3, failing: 0 } })
  assert.match(r.why, /没开/)
})
test('老产物兼容：数组/数字形状仍能读出计数', () => {
  assert.equal(pageErrorsFromSummary({ pageErrors: [{ message: 'x' }] }).count, 1)
  assert.equal(pageErrorsFromSummary({ pageErrors: 2 }).count, 2)
})

// ---------- 断言类型：人工债的诚实判据 ----------
test('assertionKindsInSummary 从 steps[].actionType 数真挂了什么', () => {
  const k = assertionKindsInSummary({ steps: [{ actionType: 'click' }, { actionType: 'assertVisual' }, { type: 'assertPerf' }] })
  assert.ok(k.has('assertVisual'))
  assert.ok(k.has('assertPerf'))
  assert.ok(!k.has('assertDownload'))
})
// ★ 回归：猪猪把断言型步骤统一归一到 `capture`（normalize.js:112-121），种类只在 expectation 里。
// 只数 actionType 的第一版会把「挂了视觉断言」判成「一条都没挂」——判据必须跟着归一化走。
test('★ 断言型步骤的 actionType 是 `capture`，种类在 expectation.type —— 两处都要数', () => {
  const real = { steps: [
    { actionType: 'openUrl', expectation: { type: 'expectDom', ok: true } },
    { actionType: 'capture', expectation: { type: 'assertVisual', ok: false } },      // 真实形状
    { actionType: 'capture', expectation: { kind: 'assertVisualPeers', ok: true } },  // kind/type 两种键名都吃
  ] }
  const k = assertionKindsInSummary(real)
  assert.ok(k.has('assertVisual'), '视觉基线断言必须被数出来')
  assert.ok(k.has('assertVisualPeers'), '同族对比断言必须被数出来')
  assert.ok(k.has('capture'))
  assert.ok(k.has('expectDom'))
})
