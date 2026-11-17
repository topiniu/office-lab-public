// ============================================================================
// 交接即冻结 / 条目级 worktree 隔离 / 变更影响面雷达 / DDL 前置核查
// （方案 §3.2 B1 / B2 / B3 / B5 / B7）
//
// 缘起（方案原文的实测事实）：4 条 REQ 的代码**在工作区躺了几天**，发测时才被发现；QA 进行中
// GG Bond 还在同一个文件改（老板临时令「隐藏停用」），而迷糊同文件正在做 RED 注入；
// **至少 8 次「QA 后又改码」让旧证据作废、全量 QA 重跑 3 轮**；DDL 的 MySQL 5.7 兼容、
// DMS 拦临时表、回填 10,635 行三处风险靠老板抽问才暴露。
//
// 核心命题：**证据必须绑在不可变版本上**。
//   B1 交给迷糊前必须 commit（哪怕 `wip:`）并 push，交接卡带 commit sha；
//   B3 改码 = 新 commit → 算出「影响哪些入口、作废哪些 facet 证据」→ 自动把它们打回 UNCOVERED；
//   B2 每条目一个 worktree，老板在线追加打磨时不在迷糊正测的那份工作树上改。
//
// 纯函数（git 探测由 server.js 注入）。
// ============================================================================

// ---------- B1 · 交接即冻结 ----------
// gitState: { repo, branch, dirtyFiles:[], stagedFiles:[], head:'sha', aheadOfRemote:n, remoteExists:bool }
// 返回 { ok, blockers:[], sha, hint }
export function freezeCheck(states, { allowWip = true } = {}) {
  const list = Array.isArray(states) ? states : [states].filter(Boolean)
  const blockers = [], frozen = []
  for (const s of list) {
    const label = `${s.repo || '?'}（分支 ${s.branch || '?'}）`
    const dirty = [...(s.dirtyFiles || []), ...(s.stagedFiles || [])]
    if (dirty.length) {
      blockers.push({
        repo: s.repo, code: 'uncommitted',
        why: `${label} 有 ${dirty.length} 个未提交改动 —— 证据不能绑在会变的工作区上。${allowWip ? '先 `git commit`（**允许 `wip:` 提交**，交接不等于定稿）' : '先提交'}：\n` + dirty.slice(0, 12).map(f => `　· ${f}`).join('\n') + (dirty.length > 12 ? `\n　· …另有 ${dirty.length - 12} 个` : ''),
      })
      continue
    }
    if (!s.head) { blockers.push({ repo: s.repo, code: 'no-head', why: `${label} 取不到 HEAD sha（仓库状态异常）` }); continue }
    if (s.remoteExists === false) blockers.push({ repo: s.repo, code: 'no-remote-branch', why: `${label} 远端还没有这条分支 —— 先 \`git push -u origin ${s.branch}\`。只 commit 不 push 的形态就是 v5.19 那次 release MR 显示「no commits yet」的原因` })
    else if (Number(s.aheadOfRemote || 0) > 0) blockers.push({ repo: s.repo, code: 'unpushed', why: `${label} 有 ${s.aheadOfRemote} 个提交**只 commit 未 push** —— 迷糊/波比看不到、MR 也拿不到（v5.19 真踩过）` })
    else frozen.push({ repo: s.repo, branch: s.branch, sha: s.head })
  }
  return {
    ok: blockers.length === 0,
    blockers, frozen,
    sha: frozen.length === 1 ? frozen[0].sha : '',
    // 交接卡里该写的那一行（B1 要求「交接卡里带 commit sha」）
    handoffLine: frozen.length ? frozen.map(f => `${f.repo}@${f.branch} \`${String(f.sha).slice(0, 10)}\``).join('　') : '',
  }
}
export function renderFreezeBlock(r) {
  if (r.ok) return `**冻结版本**（证据绑定的不可变基线）：${r.handoffLine}`
  return ['**⛔ 交接被扣住：证据不能绑在会变的工作区上（B1 交接即冻结）**', '', ...r.blockers.map(b => `- ${b.why}`), '', '> 冻结之后改码就是**新 commit**，引擎会自动作废受影响的 facet 证据并打回 UNCOVERED（B3），不会再出现「QA 拿旧证据签发绿灯」。'].join('\n')
}

// ---------- B3 · 变更影响面雷达 ----------
// 输入：
//   diffFiles      —— 本次新 commit 相对冻结基线改了哪些文件
//   entryMap       —— 组件/testid → 全部入口（猪猪 Z-P 或本地 UI 契约）
//   facetIndex     —— [{facetId, files:[], components:[], caseIds:[]}] facet↔代码/用例映射
//   evidenceByFacet—— {facetId: {commit, runId}} 已签发证据绑的 commit
// 输出：受影响入口 + 需作废的 facet 证据 + 抄送迷糊的「需重跑清单」
export function impactRadar({ diffFiles = [], entryMap = {}, facetIndex = [], evidenceByFacet = {}, newCommit = '' } = {}) {
  const changed = new Set((diffFiles || []).map(f => String(f).replace(/\\/g, '/')))
  const touchedComponents = new Set()
  const invalidated = [], keptFresh = []
  for (const f of facetIndex || []) {
    const files = (f.files || []).map(x => String(x).replace(/\\/g, '/'))
    const hitFile = files.some(x => changed.has(x))
    const comps = (f.components || []).map(String)
    // 组件级命中：facet 声明的组件在 entryMap 里、且该组件的任一实现文件被改
    const hitComp = comps.some(c => {
      if (changed.has(c)) return true
      const entries = entryMap[c]
      return Array.isArray(entries) && entries.some(e => changed.has(String(e)))
    })
    if (!hitFile && !hitComp) { keptFresh.push(f.facetId); continue }
    comps.forEach(c => touchedComponents.add(c))
    const ev = evidenceByFacet[f.facetId] || {}
    invalidated.push({
      facetId: f.facetId,
      why: hitFile ? `实现文件被改（${files.filter(x => changed.has(x)).slice(0, 3).join(', ')}）` : `复用组件被改（${comps.join(', ')}）`,
      staleEvidenceCommit: ev.commit || '',
      staleRunId: ev.runId || '',
      caseIds: f.caseIds || [],
    })
  }
  const affectedEntries = new Set()
  for (const c of touchedComponents) for (const e of (entryMap[c] || [])) affectedEntries.add(String(e))
  return {
    newCommit: String(newCommit || ''),
    touchedComponents: [...touchedComponents].sort(),
    affectedEntries: [...affectedEntries].sort(),
    invalidated,
    keptFresh,
    rerunCaseIds: [...new Set(invalidated.flatMap(i => i.caseIds))],
    // 自动置 UNCOVERED 的清单（引擎直接写覆盖矩阵，不请求 agent 配合——B3 要的是"自动"）
    toUncovered: invalidated.map(i => i.facetId),
  }
}
export function renderImpactRadar(r) {
  if (!r.invalidated.length) return `### 变更影响面雷达（B3）\n\n本次改动（\`${String(r.newCommit).slice(0, 10)}\`）**没有作废任何已签发的 facet 证据**${r.touchedComponents.length ? `；触及组件：${r.touchedComponents.join(', ')}` : ''}。`
  const L = [`### 变更影响面雷达（B3）· 改动 \`${String(r.newCommit).slice(0, 10)}\``, '']
  L.push(`**作废 ${r.invalidated.length} 条 facet 证据 → 已自动打回 UNCOVERED**（证据绑的是旧 commit，改码即失效）`)
  L.push('')
  L.push('| facet | 为什么作废 | 旧证据 commit | 需重跑用例 |')
  L.push('|-------|-----------|--------------|-----------|')
  for (const i of r.invalidated) L.push(`| ${i.facetId} | ${i.why} | \`${String(i.staleEvidenceCommit).slice(0, 10) || '—'}\` | ${(i.caseIds || []).join(', ') || '—'} |`)
  if (r.affectedEntries.length) { L.push(''); L.push(`**受影响入口**（${r.affectedEntries.length}）：${r.affectedEntries.join(' / ')}`) }
  if (r.rerunCaseIds.length) { L.push(''); L.push(`**抄送迷糊的重跑清单**：\`${r.rerunCaseIds.join('`, `')}\``) }
  return L.join('\n')
}

// ---------- B2 · 条目级 worktree 隔离 ----------
// 设计 §7 的「开发隔离」从没落地。老板在线追加打磨时，**不在迷糊正测的那份工作树上改**。
export const WORKTREE_ROOT = '.claude/worktrees'
export function worktreePlan(entries, { repo = 'backend', baseBranch = '' } = {}) {
  const list = (entries || []).map(e => (typeof e === 'string' ? { req: e } : e)).filter(e => e && e.req)
  const plans = list.map(e => {
    const slug = String(e.req).toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
    return {
      req: String(e.req).toUpperCase(),
      name: `item-${slug}`,
      path: `${WORKTREE_ROOT}/item-${slug}`,
      branch: e.branch || (baseBranch ? `${baseBranch}-${slug}` : `wt/${slug}`),
      repo,
    }
  })
  return {
    plans,
    // 一条目一树的价值全在「并发」：QA 正测哪棵树、老板在线改哪棵树，必须能分开说。
    // 单条目时没有并发对象，开树只是白花磁盘 —— 但 B1 冻结照旧要做（那是证据绑版本，与隔离无关）。
    hint: plans.length > 1
      ? `每条目一棵工作树：${plans.map(p => `${p.req}→\`${p.path}\``).join('　')}。QA 在**冻结的 sha** 上测；老板在线追加打磨落到对应条目的树上，**不动正在被测的那棵**。`
      : `本轮只有 ${plans.length} 个条目、没有并发对象，可不开 worktree（但**仍须 B1 冻结**：证据要绑不可变版本，这与隔离是两件事）。`,
  }
}

// ---------- B5 · DDL / 存量数据前置核查 ----------
// 强制清单：目标库版本探测 + 执行通道兼容 + 影响行数预估 + 回滚脚本 + 「先 DDL 后发服务」顺序声明。
// 三条都是 v5.19 靠老板抽问才暴露的。
export const DDL_CHECKLIST = [
  { key: 'dbVersion', label: '目标库版本已探测', why: 'MySQL 5.7 不支持窗口函数/CTE；不探测就写＝上线现场报错' },
  { key: 'channel', label: '执行通道兼容已确认', why: '阿里云 DMS 拦临时表、按语句拆连接（会话变量丢失）' },
  { key: 'rowEstimate', label: '影响行数已预估（先跑 SELECT count(*)）', why: 'REQ-0239 回填 10,635 行，事发前没人预估过' },
  { key: 'rollback', label: '回滚脚本/数据补偿方案已备', why: '不可逆 DDL 的回退不是「退代码」那么简单' },
  { key: 'orderDeclared', label: '「先 DDL 再发服务」顺序已声明', why: '顺序错＝服务起来找不到列' },
]
export function ddlPrecheck(facts = {}) {
  const missing = DDL_CHECKLIST.filter(c => !facts[c.key])
  return {
    ok: missing.length === 0,
    missing,
    // 影响行数超阈值 → 顺带把 risk_class 顶到 high（与 gate-matrix.classifyRisk 同一口径）
    escalateHigh: Number(facts.backfillRows || 0) > 1000 || facts.productionData === true,
    summary: missing.length ? `DDL 前置核查缺 ${missing.length} 项：${missing.map(m => m.label).join('、')}` : 'DDL 前置核查五项齐备',
  }
}
export function renderDdlPrecheck(r, facts = {}) {
  const L = ['### DDL / 存量数据前置核查（B5）', '', '| 项 | 状态 | 为什么必须 |', '|----|------|-----------|']
  for (const c of DDL_CHECKLIST) L.push(`| ${c.label} | ${facts[c.key] ? '✅ ' + String(facts[c.key]).slice(0, 60) : '❌ 缺'} | ${c.why} |`)
  if (r.escalateHigh) { L.push(''); L.push(`> ⚠ 影响行数/主数据触碰达 high 阈值 → risk_class 自动顶到 **high**，守航态只做方案不做实施（E6/B6）。`) }
  return L.join('\n')
}

// ---------- B7 · 实施记录 / checklist 自动回填初稿 ----------
// 从 git diff + 构建产物 + 端点冒烟结果生成初稿，人只补「为什么这么改」。
// 减少收尾负担，也减少「活干完了忘写标记」导致的空停。
export function draftImplementationRecord({ version = '', reqs = [], diffStat = {}, builds = [], smokes = [], commits = [] } = {}) {
  const L = []
  L.push(`## 实施记录初稿（引擎自动生成 · ${version || '未标版本'}）`)
  L.push('')
  L.push('> ⚠ 这是**机器从 git diff / 构建产物 / 冒烟结果**拼出来的初稿：「改了什么」已填好，**「为什么这么改」必须人补**（那部分机器编不出来，编出来就是假的）。')
  L.push('')
  if (reqs.length) { L.push('### 本次条目'); L.push(''); for (const r of reqs) L.push(`- ${r.req || r}${r.title ? ` —— ${r.title}` : ''}`); L.push('') }
  if (commits.length) {
    L.push('### 提交')
    L.push('')
    for (const c of commits.slice(0, 30)) L.push(`- \`${String(c.sha || '').slice(0, 10)}\` ${c.subject || ''}`)
    if (commits.length > 30) L.push(`- …另有 ${commits.length - 30} 个提交`)
    L.push('')
  }
  const files = Object.entries(diffStat || {})
  if (files.length) {
    L.push('### 改动面（按文件）')
    L.push('')
    L.push('| 文件 | +/- | 为什么这么改（★人补） |')
    L.push('|------|-----|---------------------|')
    for (const [f, s] of files.slice(0, 60)) L.push(`| \`${f}\` | +${s.added ?? '?'}/-${s.removed ?? '?'} | ★ |`)
    if (files.length > 60) L.push(`| …另有 ${files.length - 60} 个文件 | | |`)
    L.push('')
  }
  if (builds.length) { L.push('### 构建'); L.push(''); for (const b of builds) L.push(`- ${b.target || b}：${b.ok === false ? '❌ 失败' : '✅ 通过'}${b.note ? `（${b.note}）` : ''}`); L.push('') }
  if (smokes.length) { L.push('### 端点冒烟'); L.push(''); for (const s of smokes) L.push(`- ${s.endpoint || s}：${s.ok === false ? `❌ ${s.status || ''}` : `✅ ${s.status || 200}`}`); L.push('') }
  L.push('### 待人补（机器写不了的部分）')
  L.push('')
  L.push('- [ ] 每处改动的**动机**（为什么这么改、放弃了什么方案）')
  L.push('- [ ] 性能自检结论（数据量级 / 是否走索引 / 是否分页 / 有无全量查询或内存聚合）——CLAUDE.md 强制项，无风险也要写「已评估，无全量查询」')
  L.push('- [ ] 已知残留与后续项')
  return L.join('\n')
}
