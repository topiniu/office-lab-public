import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFactSheet, validateRewrite, reportCardSkeleton, qaResultReport, validateQaResultReport,
  visualAcceptance, renderVisualAcceptance, VISUAL_VERDICTS, HARD_VISUAL_DEFECTS,
  tenantPrefix, residueReport, renderResidueReport, humanDebtStatus, renderHumanDebt, HUMAN_DEBT,
  isVisualHumanClaim, textClaimsVisualHuman, visualFinalityGate, renderVisualFinalityGate, VISUAL_GATE,
  findingExitGate, renderFindingExitGate, FINDING_GATE,
  uiVisualGate, renderUiVisualGate, UI_VISUAL_GATE,
} from '../qa-report-card.js'

const ROWS = [
  { facetId: 'REQ-0301-F1', req: 'REQ-0301', status: 'COVERED_GREEN', criterion: '新建品类可被选中', green: { runId: '20260826010203-1ead52' } },
  { facetId: 'REQ-0301-F2', req: 'REQ-0301', status: 'HUMAN_INHERENT', criterion: '导出 xlsx 单元格内文正确', reason: '导出产物断言能力缺位（Z-C）' },
]
const CARD = { available: true, card: { did: ['以核价师身份新建品类'], checked: ['尺寸表页可选中'], evidence: ['summary.json'], risks: [], uncovered: [], runIds: ['20260826010203-1ead52'] } }

// ---------- C4 事实清单与「只改写不新增」 ----------
test('事实清单从机器事实拼：facet 分布 / 未覆盖项 / run id', () => {
  const s = buildFactSheet({ version: 'v5.20', reqs: ['REQ-0301'], rows: ROWS, reportCard: CARD })
  assert.equal(s.facetTotal, 2)
  assert.equal(s.greenCount, 1)
  assert.equal(s.uncovered.length, 1)
  assert.equal(s.uncovered[0].facetId, 'REQ-0301-F2')
  assert.ok(s.runIds.includes('20260826010203-1ead52'))
  assert.equal(s.reportCardAvailable, true)
})
test('猪猪 report-card 缺位时 did/checked 为空且如实标 unavailable（不编）', () => {
  const s = buildFactSheet({ version: 'v5.20', rows: ROWS, reportCard: null })
  assert.deepEqual(s.did, [])
  assert.equal(s.reportCardAvailable, false)
  assert.match(reportCardSkeleton(s), /未接通（Z-K 待上线）/)
})
test('改写稿里出现事实清单外的 facet 编号 → 打回（凭空多出的事实）', () => {
  const s = buildFactSheet({ version: 'v5.20', rows: ROWS, reportCard: CARD })
  const v = validateRewrite('我测了 REQ-0301-F1 和 REQ-0301-F2，还顺手测了 REQ-9999-F1。', s)
  assert.equal(v.ok, false)
  assert.ok(v.violations.some(x => x.token === 'REQ-9999-F1'))
})
test('改写稿里出现清单外的 run id → 打回', () => {
  const s = buildFactSheet({ version: 'v5.20', rows: ROWS, reportCard: CARD })
  const v = validateRewrite('REQ-0301-F1 REQ-0301-F2 证据在 run 20260101000000-3cb22f。', s)
  assert.ok(v.violations.some(x => /20260101000000/.test(x.token)))
})
test('未覆盖项被漏写 → 打回（必须逐条照抄）', () => {
  const s = buildFactSheet({ version: 'v5.20', rows: ROWS, reportCard: CARD })
  const v = validateRewrite('我测了 REQ-0301-F1，全都过了。', s)
  assert.equal(v.ok, false)
  assert.deepEqual(v.missingUncovered, ['REQ-0301-F2'])
})
test('把「有未覆盖」润色成「全部通过 / 100%」→ 打回（这是最该拦的一类）', () => {
  const s = buildFactSheet({ version: 'v5.20', rows: ROWS, reportCard: CARD })
  const v = validateRewrite('REQ-0301-F1 与 REQ-0301-F2 全部通过。', s)
  assert.equal(v.ok, false)
  assert.match(v.whitewash.join(), /全部通过/)
})
test('如实改写（含未覆盖项）→ 通过；散文措辞随便改不算新增事实', () => {
  const s = buildFactSheet({ version: 'v5.20', rows: ROWS, reportCard: CARD })
  const v = validateRewrite('我以核价师身份新建了品类，去尺寸表页确认能被选中（REQ-0301-F1 绿）。REQ-0301-F2 的导出内文没测到，原因是导出产物断言能力缺位（Z-C）。', s)
  assert.equal(v.ok, true, JSON.stringify(v))
})
test('骨架把「没测到什么」做成必填表，且要求 reason 不许留空', () => {
  const md = reportCardSkeleton(buildFactSheet({ version: 'v5.20', rows: [{ facetId: 'A-F1', status: 'UNCOVERED' }], reportCard: null }))
  assert.match(md, /没测到什么（★逐条照抄，不许润色）/)
  assert.match(md, /★未给 reason——必须补，不许留空/)
})
test('无 run id 时骨架明说「不算数」', () => {
  assert.match(reportCardSkeleton(buildFactSheet({ rows: [], reportCard: null })), /无 run id 不算数/)
})

// ---------- C5 版本级 QA 结果报告 ----------
test('缺回归段 / 无 run id → 校验不通过（守航态也是硬要求，v5.19 缺过一次）', () => {
  const s = buildFactSheet({ version: 'v5.20', rows: ROWS, reportCard: CARD })
  const r = validateQaResultReport({ sheet: s, regression: [] })
  assert.equal(r.ok, false)
  assert.match(r.errors.join(), /缺「老功能回归」段/)
})
test('回归项没有 run id → 逐条报「不算数」', () => {
  const s = buildFactSheet({ version: 'v5.20', rows: ROWS, reportCard: CARD })
  const r = validateQaResultReport({ sheet: s, regression: [{ caseId: 'c1' }] })
  assert.match(r.errors.join(), /没有 run id，不算数/)
  assert.match(qaResultReport({ sheet: s, regression: [{ caseId: 'c1' }] }), /无 run id → 不算数/)
})
test('猪猪 report-card 未接通时要求「显式声明素材受限」', () => {
  const s = buildFactSheet({ version: 'v5.20', rows: ROWS, reportCard: null })
  assert.match(validateQaResultReport({ sheet: s, regression: [{ caseId: 'c', runId: 'r' }] }).errors.join(), /显式声明素材受限/)
})

// ---------- C3 视觉验收（2026-09-07 按 vision-e2e 源码的真实 items 形状重写） ----------
// 素材包真实形状：{reviewVersion, items:[{kind:'baseline'|'peers', selector, box, tokens,
//   truncation:{clipped,clippedVertically,...}, accessibility:{contrastRatio,hitTargetOk,...},
//   diff:{ratio,maxDiffRatio,bounds}, differences:[{token,summary}], peers:[...]}]}
const okItem = (over = {}) => ({
  kind: 'baseline', key: 'size-rule-modal', selector: '[data-testid="m"]',
  box: { x: 0, y: 0, width: 400, height: 300 },
  tokens: { fontSize: 14 },
  truncation: { clipped: false, clippedVertically: false, scrollWidth: 400, clientWidth: 400 },
  accessibility: { contrastRatio: 8.2, hitTargetOk: true, focusVisible: true },
  diff: { ratio: 0.001, maxDiffRatio: 0.02 },
  ...over,
})
test('没有素材包 → 落回「未做」，明确不许当通过', () => {
  const v = visualAcceptance({ available: false, why: '本轮一条视觉断言都没挂' })
  assert.equal(v.verdict, null)
  assert.equal(v.degraded, true)
  assert.match(renderVisualAcceptance(v), /未做/)
})
test('**回归：旧扁平形状（truncated/contrast/familyDiffs）不再被当成有效素材**', () => {
  // 这些字段猪猪从来没有过；旧实现在这份输入上会判 DEFECT/DIFF，等于对着幻觉字段下结论
  const v = visualAcceptance({ available: true, items: [] })
  assert.equal(v.degraded, true)
  assert.equal(v.verdict, null)
})
test('截断（横向/纵向）判「明显缺陷」，并指名是哪个元素、给出量化值', () => {
  for (const key of ['clipped', 'clippedVertically']) {
    const v = visualAcceptance({ available: true, items: [okItem({ truncation: { [key]: true, scrollWidth: 520, clientWidth: 400, scrollHeight: 380, clientHeight: 300 } })] })
    assert.equal(v.verdict, VISUAL_VERDICTS.DEFECT, key)
    assert.equal(v.defects[0].where, '[data-testid="m"]')
    assert.match(renderVisualAcceptance(v), /截断|裁掉/)
  }
})
test('对比度 < 4.5:1 判缺陷；点击区用猪猪的 hitTargetOk（不自定 32px 阈值）', () => {
  const c = visualAcceptance({ available: true, items: [okItem({ accessibility: { contrastRatio: 3.1, hitTargetOk: true } })] })
  assert.equal(c.verdict, VISUAL_VERDICTS.DEFECT)
  assert.match(c.defects[0].value, /3\.1:1 < 4\.5:1/)
  const h = visualAcceptance({ available: true, items: [okItem({ accessibility: { contrastRatio: 9, hitTargetOk: false }, box: { width: 20, height: 20 } })] })
  assert.equal(h.verdict, VISUAL_VERDICTS.DEFECT)
  assert.match(h.defects[0].value, /20×20 < 44×44/)
})
test('contrastRatio 取不到（null）时不判缺陷 —— 未验证不是缺陷', () => {
  const v = visualAcceptance({ available: true, items: [okItem({ accessibility: { contrastRatio: null, hitTargetOk: true } })] })
  assert.equal(v.verdict, VISUAL_VERDICTS.OK)
})
test('基线 diff 超过该条自己声明的 maxDiffRatio → 判「与同族不一致」并带 bounds', () => {
  const v = visualAcceptance({ available: true, items: [okItem({ diff: { ratio: 0.08, maxDiffRatio: 0.02, bounds: { x: 10, y: 20, width: 30, height: 40 } }, actualImagePath: 'visual/x-actual.png' })] })
  assert.equal(v.verdict, VISUAL_VERDICTS.DIFF)
  assert.equal(v.baselineRegressions.length, 1)
  assert.match(renderVisualAcceptance(v), /差异集中在 x=10,y=20 30×40/)
})
test('阈值逐条声明：ratio 0.05 在 maxDiffRatio 0.1 下不算回归', () => {
  const v = visualAcceptance({ available: true, items: [okItem({ diff: { ratio: 0.05, maxDiffRatio: 0.1 } })] })
  assert.equal(v.verdict, VISUAL_VERDICTS.OK)
})
test('peers 的 differences → 「与同族不一致」，每行可直接贴评审', () => {
  const v = visualAcceptance({ available: true, items: [okItem({ kind: 'peers', diff: undefined, differences: [{ token: 'fontSize', summary: '字号 12 vs 14' }, { token: 'borderRadius', summary: '圆角 2 vs 6' }] })] })
  assert.equal(v.verdict, VISUAL_VERDICTS.DIFF)
  assert.equal(v.diffs.length, 2)
  assert.match(renderVisualAcceptance(v), /字号 12 vs 14/)
})
test('缺陷优先于差异（先报确定性缺陷，别让审美讨论盖住截断）', () => {
  const v = visualAcceptance({ available: true, items: [okItem({ truncation: { clipped: true }, differences: [{ token: 'gap', summary: '间距 8 vs 12' }], kind: 'peers', diff: undefined })] })
  assert.equal(v.verdict, VISUAL_VERDICTS.DEFECT)
})
test('无缺陷无差异 → 符合同族基线，但明说「好不好看仍是老板终审」+ 点明未覆盖项', () => {
  const v = visualAcceptance({ available: true, items: [okItem()] })
  assert.equal(v.verdict, VISUAL_VERDICTS.OK)
  const md = renderVisualAcceptance(v)
  assert.match(md, /「好不好看」的终审仍是老板/)
  assert.match(md, /元素重叠/)         // 未覆盖项要如实写出来，不许静默当已覆盖
})
test('HARD_VISUAL_DEFECTS 不再包含 overlap（猪猪不出，留着就是永远为 false 的假覆盖）', () => {
  assert.ok(!HARD_VISUAL_DEFECTS.some(d => d.key === 'overlap'))
})

// ---------- C6 造数租户与残留 ----------
test('租户前缀从 run_name 派生、可读且受限长度', () => {
  const p = tenantPrefix('2026-08-26-guarded-01')
  assert.match(p, /^qa-/)
  assert.ok(p.length <= 32)
  assert.equal(tenantPrefix('2026-08-26-guarded-01'), p)   // 稳定
})
test('残留清点不可用时按「未清」记录，不许写成「已清理」', () => {
  const r = residueReport({ prefix: 'qa-x-', residue: null, baseline: null })
  assert.equal(r.available, false)
  assert.match(renderResidueReport(r), /按「未清」记录（不许写成「已清理」）/)
})
test('不带租户前缀的造数 → 点名「污染了全局主数据」（v5.19 品类污染的形状）', () => {
  const r = residueReport({ prefix: 'qa-x-', residue: { items: [{ entity: '品类', name: '内裤' }, { entity: '品类', name: 'qa-x-上衣' }] } })
  assert.equal(r.foreign.length, 1)
  assert.match(renderResidueReport(r), /污染了全局主数据/)
})
test('预置数据被改动 → baselineGuard 报警（「预置『上衣』被谁停用了」缺的就是这个）', () => {
  const r = residueReport({ prefix: 'qa-', baseline: { violations: [{ entity: '品类', name: '上衣', change: '被停用' }] } })
  assert.equal(r.ok, false)
  assert.match(renderResidueReport(r), /预置数据被改动/)
})
test('无残留且预置未动 → ok', () => {
  const r = residueReport({ prefix: 'qa-', residue: { items: [] }, baseline: { violations: [] } })
  assert.equal(r.ok, true)
  assert.equal(r.cleaned, true)
})

// ---------- C2 人工债四件（2026-09-07 改三态：平台有没有 / 我们用没用） ----------
test('没有 run summary → 断言类三件判「未验证」，既不算清零也不算仍需人眼', () => {
  const s = humanDebtStatus({ capMap: {}, summaries: [] })
  assert.equal(s.cleared, 0)
  assert.equal(s.unknown, 4)          // 端点类那件也未探测
  assert.equal(s.allCleared, false)
})
test('**关键：平台给了但本轮没挂断言 → 明说「债欠在我们这边」**（这正是白挂四个月的形状）', () => {
  const s = humanDebtStatus({ capMap: { authBootstrap: { available: true } }, summaries: [{ steps: [] }] })
  const visual = s.rows.find(r => r.key === 'visual')
  assert.equal(visual.status, 'AVAILABLE_UNUSED')
  assert.match(visual.why, /债欠在我们这边/)
  assert.match(visual.why, /assertVisual/)          // 顺手告诉该怎么挂
  assert.equal(s.rows.find(r => r.key === 'permission').status, 'CLEARED')   // 端点类问目录即可
  assert.match(renderHumanDebt(s), /我们没挂/)
})
test('真挂了 assertVisual/assertPerf/assertDownload → 判真用了（债清）', () => {
  const s = humanDebtStatus({
    capMap: { authBootstrap: { available: true } },
    summaries: [{ steps: [{ actionType: 'assertVisual' }, { actionType: 'assertPerf' }, { actionType: 'assertDownload' }] }],
  })
  assert.equal(s.allCleared, true)
  assert.equal(s.cleared, 4)
})
test('**回归：`performance`/`downloads` 这类采集器产物存在，绝不算「债清」**（实测：没挂任何断言的 run 里它们也齐全）', () => {
  const s = humanDebtStatus({
    capMap: { authBootstrap: { available: true } },
    // 真实样本形状：performance 有完整 spread、downloads 是 {count:0,files:[]}，而 steps 里一条断言都没有
    summaries: [{ performance: { samples: 1, spread: { domNodes: { min: 1659 } } }, downloads: { count: 0, files: [] }, steps: [{ actionType: 'click' }, { actionType: 'fill' }] }],
  })
  assert.equal(s.rows.find(r => r.key === 'performance').status, 'AVAILABLE_UNUSED')
  assert.equal(s.rows.find(r => r.key === 'artifact').status, 'AVAILABLE_UNUSED')
  assert.equal(s.cleared, 1)   // 只有端点类那件（Z-F）算清
})
test('视觉那件额外认素材包：老产物 steps 没记 actionType，但 visualReview 在就是真跑过', () => {
  const s = humanDebtStatus({ capMap: {}, summaries: [{ visualReview: { items: [{ kind: 'baseline' }] }, steps: [] }] })
  assert.equal(s.rows.find(r => r.key === 'visual').status, 'CLEARED')
})
test('端点类能力目录说没有 → 判平台缺位（与「我们没挂」区分开，催的对象不同）', () => {
  const s = humanDebtStatus({ capMap: { authBootstrap: { available: false, why: '目录里没有' } }, summaries: [{ steps: [] }] })
  assert.equal(s.rows.find(r => r.key === 'permission').status, 'ABSENT')
  assert.equal(s.absent, 1)
})
test('渲染里带 S3 出口判据，且点明「未验证不算清零」', () => {
  const md = renderHumanDebt(humanDebtStatus({ capMap: {}, summaries: [] }))
  assert.match(md, /≤1 条仍需人眼/)
  assert.match(md, /「未验证」不算清零/)
})

// ---------- C3.8 「需人工视觉终验」声明门（§3.132）----------
// 原型取自 run 20260909123227-fc95e1 的真实措辞，别把这些字面量改软了——它们就是要拦的那句话。
const VIS_CLAIM_ROW = {
  facetId: 'REQ-0340-F21', status: 'HUMAN_INHERENT',
  criterion: '选"部分完成"→展开逐尺码数量输入',
  reason: '前端视觉/行为 facet，headless 够不到（App-run visual 首跑仅出红基线无 verdict；RMS 未注册码 gating 写 UI 不渲染），留晨间人工视觉终验',
}
const PERM_HUMAN_ROW = {
  facetId: 'REQ-0341-F29', status: 'HUMAN_INHERENT',
  criterion: '受限账号看不到导出按钮', reason: '现网回归/权限负向，需独立风险审批（人工升级流程）',
}

test('视觉人工声明的判据是「人工措辞 ∧ 视觉措辞」，权限/现网这类人工项不进本门', () => {
  assert.equal(isVisualHumanClaim(VIS_CLAIM_ROW), true)
  assert.equal(isVisualHumanClaim(PERM_HUMAN_ROW), false)   // 人工是真的，但没有视觉素材可给，本门管不着
  assert.equal(isVisualHumanClaim({ status: 'COVERED_GREEN', reason: '视觉基线一致' }), false)
})
test('criterion 里出现「布局」不算声明——那是需求在描述功能，不是 QA 在说只能人眼看', () => {
  assert.equal(isVisualHumanClaim({ facetId: 'REQ-1-F1', status: 'UNCOVERED', criterion: '表格布局不错位', reason: '功能未实施' }), false)
})
test('「RMS 未注册码 gating 写 UI 不渲染」这种「借非视觉阻断豁免整批视觉 facet」的写法必须被认出来', () => {
  assert.equal(isVisualHumanClaim({ facetId: 'REQ-0340-F50', status: 'HUMAN_INHERENT', reason: 'RMS 未注册码 gating 写 UI 不渲染，留人工' }), true)
})
test('零调用 + 有声明 → NO_ATTEMPT，按「未做」记而不是「机器测不了」', () => {
  const g = visualFinalityGate({ rows: [VIS_CLAIM_ROW], footprint: null })
  assert.equal(g.ok, false)
  assert.equal(g.verdict, VISUAL_GATE.NO_ATTEMPT)
  assert.equal(g.claims.length, 1)
  assert.match(g.why, /一次都没调/)
})
test('调了但只拿到 no-baseline（首跑）→ NO_MATERIAL，明说「跑第二趟」而不是判成人工项', () => {
  const g = visualFinalityGate({ rows: [VIS_CLAIM_ROW], footprint: { attempts: 1, withMaterial: 0, attachedNoMaterial: 3, itemCount: 0 } })
  assert.equal(g.ok, false)
  assert.equal(g.verdict, VISUAL_GATE.NO_MATERIAL)
  assert.match(g.why, /跑第二趟/)
})
test('真拿到素材 → BACKED 放行，并把会话 id 印出来（声明有据可查）', () => {
  const g = visualFinalityGate({ rows: [VIS_CLAIM_ROW], footprint: { attempts: 2, withMaterial: 2, itemCount: 5, materialSessions: ['session-x'] } })
  assert.equal(g.ok, true)
  assert.equal(g.verdict, VISUAL_GATE.BACKED)
  assert.match(g.why, /session-x/)
})
test('没有视觉声明时本门不适用，且措辞不许说成「通过」', () => {
  const g = visualFinalityGate({ rows: [PERM_HUMAN_ROW], footprint: null })
  assert.equal(g.ok, true)
  assert.equal(g.verdict, VISUAL_GATE.NO_CLAIM)
  assert.match(g.why, /不是通过/)
})
test('收工汇报的自由文本也算一次声明（那批 facet 可能一条 set_facet_coverage 都没写）', () => {
  assert.equal(textClaimsVisualHuman('7 条前端视觉/行为 + 抽屉视觉 + UX 增量：需真实浏览器视觉终验，真人工项。'), true)
  assert.equal(textClaimsVisualHuman('9 条 HUMAN_INHERENT 需走独立风险审批流程确认'), false)
  assert.equal(textClaimsVisualHuman(''), false)
})
test('声明门不过 → QA 结果报告直接判不可出（与「无 run id」同一档硬口径）', () => {
  const sheet = buildFactSheet({ version: 'v0.1.0', rows: ROWS, reportCard: CARD })
  const g = visualFinalityGate({ rows: [VIS_CLAIM_ROW], footprint: null })
  const v = validateQaResultReport({ sheet, regression: [{ caseId: 'c1', runId: 'r1', ok: true }], visualGate: g })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some(e => /C3\.8/.test(e)))
})
test('渲染要给出补法顺序，且点名 ux_contract_check 压根不需要浏览器', () => {
  const md = renderVisualFinalityGate(visualFinalityGate({ rows: [VIS_CLAIM_ROW], footprint: null }))
  assert.match(md, /REQ-0340-F21/)
  assert.match(md, /ux_contract_check/)
  assert.match(md, /不需要浏览器/)
  assert.match(md, /跑两趟/)
})


// ---------- C3.9 巡检发现出口门 ----------
const okSheet = { version: '0.1.0', runIds: ['r1'], reportCardAvailable: true, uncovered: [] }
const okReg = [{ caseId: 'c1', runId: 'r1', ok: true }]

test('出口门：零发现 → 不适用（不是通过，是没有待处置项）', () => {
  const g = findingExitGate({ ledger: { open: [], closed: [], total: 0 } })
  assert.equal(g.ok, true)
  assert.equal(g.verdict, FINDING_GATE.NO_FINDING)
})

test('出口门：有发现没出口 → 硬拦，且逐条点名', () => {
  const g = findingExitGate({ ledger: { open: [{ key: 'k1', rubricKey: 'format', quote: 'Invalid date', page: '环节配置' }], closed: [], total: 1 } })
  assert.equal(g.ok, false)
  assert.equal(g.verdict, FINDING_GATE.OPEN)
  assert.match(g.why, /没有出口/)
  assert.match(g.why, /无主状态/)
  const md = renderFindingExitGate(g)
  assert.match(md, /Invalid date/)
  assert.match(md, /k1/)
  // 收工自检必须因此不许出报告
  const chk = validateQaResultReport({ sheet: okSheet, regression: okReg, findingGate: g })
  assert.equal(chk.ok, false)
  assert.ok(chk.errors.some(e => /C3\.9/.test(e)), chk.errors.join('|'))
})

test('出口门：逐条落了出口 → 放行，并印出落点', () => {
  const g = findingExitGate({ ledger: { open: [], closed: [{ key: 'k1', quote: 'Invalid date', disposition: { exit: 'increment', entryId: 'REQ-0338', owner: 'ggbond', date: '2026-09-11' } }], total: 1 } })
  assert.equal(g.ok, true)
  assert.equal(g.verdict, FINDING_GATE.ALL_DISPOSED)
  assert.match(renderFindingExitGate(g), /ggbond/)
  assert.equal(validateQaResultReport({ sheet: okSheet, regression: okReg, findingGate: g }).ok, true)
})

test('出口门不传时不改变既有行为（老调用点兼容）', () => {
  assert.equal(validateQaResultReport({ sheet: okSheet, regression: okReg }).ok, true)
})

// ---------- C3.13 · UI 视觉验收门（2026-10-06）----------
const uiRow = (id, status = 'COVERED_GREEN', via = 'ui') => ({ facetId: id, status, via })
test('C3.13 没有界面类绿行 → 不适用（纯接口版本不拦）', () => {
  const g = uiVisualGate({ rows: [uiRow('REQ-1-F1', 'COVERED_GREEN', 'api'), uiRow('REQ-1-F2', 'UNCOVERED')], footprint: null })
  assert.equal(g.ok, true)
  assert.equal(g.verdict, UI_VISUAL_GATE.NOT_APPLICABLE)
})
test('★ C3.13 界面类判绿但零视觉素材 → 拦（09-15/09-18 实账形状：调了工具、用例没挂断言）', () => {
  const g = uiVisualGate({ rows: [uiRow('REQ-1-F1')], footprint: { attempts: 2, withMaterial: 0, attachedNoMaterial: 0 } })
  assert.equal(g.ok, false)
  assert.equal(g.verdict, UI_VISUAL_GATE.NO_MATERIAL)
  assert.match(g.why, /调了 2 次视觉工具/)
  assert.match(renderUiVisualGate(g), /assertVisual/)
})
test('★ C3.13 有素材但没出过看图门的审美结论 → 拦', () => {
  const g = uiVisualGate({ rows: [uiRow('REQ-1-F1')], footprint: { attempts: 1, withMaterial: 1, itemCount: 3 } })
  assert.equal(g.verdict, UI_VISUAL_GATE.NO_VERDICT)
})
test('C3.13 素材 + 审美结论都有 → 过；且进 validateQaResultReport 的错误清单', () => {
  const ok = uiVisualGate({ rows: [uiRow('REQ-1-F1')], footprint: { attempts: 1, withMaterial: 1, itemCount: 3, aestheticAccepted: 1 } })
  assert.equal(ok.verdict, UI_VISUAL_GATE.BACKED)
  const bad = uiVisualGate({ rows: [uiRow('REQ-1-F1')], footprint: null })
  const chk = validateQaResultReport({ sheet: { version: '0.1.0', runIds: ['r'], reportCardAvailable: true }, regression: [{ caseId: 'c', runId: 'r' }], uiVisualGate: bad })
  assert.ok(chk.errors.some(e => /C3.13/.test(e)))
})
