// ============================================================================
// 发布链机器对账（方案 §1 E4 / §3.4 D1–D4）
//
// 缘起（全是 v5.19 实际发生的三次事故）：
//   ① 4 条 REQ 的代码全躺在**未提交工作区**，发测时才被发现；
//   ② 打磨的 commit **只 commit 未 push**，release MR 打开是「no commits yet」；
//   ③ 生产**半发布**（test 有、release 漏），靠人逐文件比对捞回。
// 三次都是「人以为发了」和「仓库里真发了」之间的缝。所以：
//
//   **`released_prod=true` 由对账器写，不由人写。**
//   一条 REQ 的状态链落成机器事实：facet 绿(证据) → commit → push → MR opened → merged
//   → deployed → 目标分支 content 坐实。任一环缺失，看板对应条目**不许显示「已上线」**。
//
// 本模块只做纯函数判定与渲染；git/glab 的实际探测在 server.js 侧注入（便于单测、也便于离线降级）。
// ============================================================================

// 链条七环，顺序即依赖。`content` 是最后一环也是最硬的一环——
// merged 了不等于目标分支真有这段内容（cherry-pick 漏、merge 冲突解错、半发布都在这一环暴露）。
export const CHAIN_LINKS = ['evidence', 'commit', 'push', 'mr_opened', 'merged', 'deployed', 'content']
export const LINK_LABEL = {
  evidence: 'facet 绿（引擎签发证据）',
  commit: '已 commit（工作区无未提交改动）',
  push: '已 push 到远端',
  mr_opened: 'MR 已创建（target 显式）',
  merged: 'MR 已合入',
  deployed: '已部署（服务清单逐项）',
  content: '目标分支 content 坐实（内容真在目标分支上）',
}

// 判一条 REQ 的链。facts 每环取值：true=坐实 / false=缺失 / null|undefined=查不到（按缺失算，但原因写「未探测」）
// 返回 { req, links:{link:{ok,why}}, firstMissing, released, displayStatus }
export function reconcileReq(req, facts = {}) {
  const links = {}
  let firstMissing = null
  for (const k of CHAIN_LINKS) {
    const v = facts[k]
    const ok = v === true
    const why = ok ? '' : (v === false ? (facts[k + 'Why'] || '缺失') : '未探测到（离线/无权限/工具缺位）——按缺失算，不按通过算')
    links[k] = { ok, why }
    if (!ok && !firstMissing) firstMissing = k
  }
  const released = firstMissing === null
  return {
    req: String(req || ''),
    links, firstMissing, released,
    // 看板显示口径：**只有整链坐实才许显示「已上线」**。断在哪就显示断在哪，别显示「已上线」。
    displayStatus: released ? '已上线' : `未上线（断在「${LINK_LABEL[firstMissing]}」）`,
  }
}

// 整批对账。released_prod 只有「所有 REQ 全链坐实」才为 true。
export function reconcileRelease(rows) {
  const results = (rows || []).map(r => reconcileReq(r.req, r.facts || r))
  const allReleased = results.length > 0 && results.every(r => r.released)
  const broken = results.filter(r => !r.released)
  return {
    results, allReleased,
    releasedProd: allReleased,          // ← 写 gates.released_prod 的唯一依据
    broken,
    // 半发布检测：有的 REQ 整链坐实、有的断在 merged/content → 典型半发布形态，必须点名
    halfReleased: results.some(r => r.released) && broken.some(r => ['merged', 'content', 'deployed'].includes(r.firstMissing)),
  }
}

export function renderReleaseChain(rec) {
  const L = ['### 发布链对账（机器事实；`released_prod` 由本表派生，不由人写）', '']
  L.push('| REQ | ' + CHAIN_LINKS.map(k => LINK_LABEL[k].split('（')[0]).join(' | ') + ' | 结论 |')
  L.push('|-----|' + CHAIN_LINKS.map(() => '----').join('|') + '|------|')
  for (const r of rec.results || []) {
    L.push(`| ${r.req} | ` + CHAIN_LINKS.map(k => r.links[k].ok ? '✅' : '❌').join(' | ') + ` | ${r.displayStatus} |`)
  }
  if (rec.halfReleased) {
    L.push('')
    L.push('> 🚨 **半发布形态**：部分 REQ 整链坐实、部分断在 merged/deployed/content —— 这正是 v5.19 那次「test 有 release 漏、靠人逐文件比对捞回」的形状。**先补齐再声明上线。**')
  }
  for (const r of rec.broken || []) {
    const bad = CHAIN_LINKS.filter(k => !r.links[k].ok)
    L.push('')
    L.push(`**${r.req} 断链明细**`)
    for (const k of bad) L.push(`- ${LINK_LABEL[k]}：${r.links[k].why}`)
  }
  if (!(rec.results || []).length) L.push('_（本版没有可对账的 REQ 条目）_')
  return L.join('\n')
}

// ============================================================================
// D2 · 部署清单自动生成
// 关键修正：用**三点 merge-base 净 delta**（`origin/<target>...HEAD`），不是两点 diff。
// 缘起：`enumerate_release` 的两点 diff 会把他组模块的改动也算进来（他们合了 master 而我们没有），
// 于是「部署清单」里冒出根本没碰过的服务。三点 diff 只算「我们这条分支相对共同祖先做了什么」。
// ============================================================================
export const BACKEND_DEPLOYABLE = {
  'web-app-service': 'service(8040)',
  'web-app-web': 'web(8041)',
  'web-app-gys-web': 'gys-web(8042)',
  'partner-app-biz-usa': 'partner-app-biz-usa(8217)',
}
export const BACKEND_LIB_MODULES = new Set(['web-app-common', 'web-app-datasource', 'web-app-service-interface', 'web-app-external-service-interface'])
export const ALL_DEPLOYABLE = ['service(8040)', 'web(8041)', 'gys-web(8042)', 'partner-app-biz-usa(8217)']

// changedFiles：三点 diff 的文件列表（仓内相对路径）。返回含端口的清单 + 「不发的也点名说明」。
export function deployManifest(changedFiles) {
  const mods = new Set()
  for (const f of changedFiles || []) { const seg = String(f).replace(/\\/g, '/').split('/')[0]; if (seg) mods.add(seg) }
  const deploy = new Map()   // service → reasons[]
  const libTouched = [...mods].filter(m => BACKEND_LIB_MODULES.has(m))
  for (const m of mods) {
    const svc = BACKEND_DEPLOYABLE[m]
    if (svc) { if (!deploy.has(svc)) deploy.set(svc, []); deploy.get(svc).push(`直接改了 ${m}`) }
  }
  if (libTouched.length) {
    for (const svc of ALL_DEPLOYABLE) {
      if (!deploy.has(svc)) deploy.set(svc, [])
      deploy.get(svc).push(`库模块 ${libTouched.join('/')} 有改动 → 连带重新部署（jar 库不单独部署）`)
    }
  }
  const skipped = ALL_DEPLOYABLE.filter(s => !deploy.has(s))
  const nonDeployable = [...mods].filter(m => !BACKEND_DEPLOYABLE[m] && !BACKEND_LIB_MODULES.has(m))
  return {
    modules: [...mods].sort(),
    libTouched,
    deploy: [...deploy.entries()].map(([service, reasons]) => ({ service, reasons })),
    skipped,
    nonDeployable,
  }
}

export function renderDeployManifest(m) {
  const L = ['### 本次需要部署的后端服务清单（含端口；不发的也点名）', '']
  if (!m.deploy.length) L.push('- **无需部署任何后端服务**（本次 diff 未落到可部署模块或库模块）')
  for (const d of m.deploy) L.push(`- ✅ **${d.service}** —— ${d.reasons.join('；')}`)
  for (const s of m.skipped) L.push(`- ◻ ${s}：无改动、不发`)
  if (m.nonDeployable.length) { L.push(''); L.push(`> 非可部署代码目录（不触发部署）：${m.nonDeployable.join(', ')}`) }
  L.push('')
  L.push('> 口径：三点 merge-base 净 delta（`origin/<target>...HEAD`），不是两点 diff——两点会把他组模块误算进来。')
  return L.join('\n')
}

// ============================================================================
// D3 · release SQL 校验器
// 三条判据都来自 v5.19 真踩过的坑：MySQL 5.7 不支持窗口函数、阿里云 DMS 拦临时表/多语句、
// 回填 10,635 行没人预估过。加上 CLAUDE.md 的纯净版格式与顺序要求。
// ============================================================================
const SQL_STRIP_RE = /--[^\n]*|\/\*[\s\S]*?\*\//g            // 剥注释后再判语句顺序（注释里的 CREATE TABLE 不算）
const DMS_INCOMPATIBLE = [
  { re: /\bCREATE\s+(?:TEMPORARY|TEMP)\s+TABLE\b/i, code: 'DMS_TEMP_TABLE', why: '阿里云 DMS 会拦临时表（它按语句拆连接，临时表跨语句不存活）——改成正式表 + 用完 DROP，或改写成单语句' },
  { re: /\bOVER\s*\(/i, code: 'MYSQL57_WINDOW_FN', why: '窗口函数（OVER）在 MySQL 5.7 不支持——先探测目标库版本，5.7 用自连接/变量改写' },
  { re: /\bWITH\s+[\w`]+\s+AS\s*\(/i, code: 'MYSQL57_CTE', why: 'CTE（WITH … AS）在 MySQL 5.7 不支持——改子查询' },
  { re: /\bSET\s+@/i, code: 'DMS_SESSION_VAR', why: '会话变量在 DMS 拆连接后会丢（每条语句可能换连接）——别依赖跨语句的 @var' },
  { re: /\bDELIMITER\b/i, code: 'DMS_DELIMITER', why: 'DELIMITER 是客户端指令，DMS 不认——存储过程/触发器请走另外通道' },
]

export function lintReleaseSql(text, opts = {}) {
  const raw = String(text || '')
  const code = raw.replace(SQL_STRIP_RE, ' ')
  const errors = [], warnings = []
  // ① DMS / MySQL 5.7 兼容 lint
  for (const c of DMS_INCOMPATIBLE) if (c.re.test(code)) errors.push({ code: c.code, why: c.why })
  // ② 语句顺序：先所有 CREATE TABLE，再所有 ALTER TABLE（CLAUDE.md 硬规）
  const stmts = []
  const stmtRe = /\b(CREATE\s+TABLE|ALTER\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([\w.]+)[`"]?/gi
  let m
  while ((m = stmtRe.exec(code))) stmts.push({ kind: /CREATE/i.test(m[1]) ? 'CREATE' : 'ALTER', table: m[2].toLowerCase(), at: m.index })
  const firstAlter = stmts.findIndex(s => s.kind === 'ALTER')
  if (firstAlter >= 0 && stmts.slice(firstAlter).some(s => s.kind === 'CREATE')) {
    errors.push({ code: 'SQL_ORDER', why: '语句顺序不合规：必须**先所有 CREATE TABLE、再所有 ALTER TABLE**（建表集中在前、改表集中在后，便于阅读与回滚定位）' })
  }
  // ③ 同一张表多次 ALTER 必须合并为一条（大表多次重建/锁表）
  const alterCount = {}
  for (const s of stmts) if (s.kind === 'ALTER') alterCount[s.table] = (alterCount[s.table] || 0) + 1
  for (const [t, n] of Object.entries(alterCount)) if (n > 1) errors.push({ code: 'SQL_MULTI_ALTER', why: `表 \`${t}\` 被 ALTER ${n} 次——同一张表的多处变更必须合并为一条 ALTER TABLE（避免大表多次重建/锁表）` })
  // ④ 纯净版格式：不许堆说明/横幅/回滚脚本；尾部要有注释形式的验证 SQL
  if (/█|═{5,}|─{10,}/.test(raw)) errors.push({ code: 'SQL_BANNER', why: '文件里有横幅装饰（█/═/─）——release SQL 必须是纯净版（只留可执行 DDL + 列注释 + 尾部验证注释）；说明搬去 RELEASE_CHECKLIST.md' })
  const headComment = (raw.match(/^(?:\s*--[^\n]*\n)+/) || [''])[0].split('\n').filter(l => l.trim()).length
  if (headComment > 3) warnings.push({ code: 'SQL_VERBOSE_HEAD', why: `头注 ${headComment} 行——纯净版最多一两行（执行库 + 「先 DDL 再发服务」顺序提示），其余搬 RELEASE_CHECKLIST.md` })
  const tail = raw.slice(-1200)
  if (!/--[^\n]*(?:SELECT|DESC|SHOW)/i.test(tail)) warnings.push({ code: 'SQL_NO_VERIFY', why: '文件尾部没有注释形式的验证 SQL——CLAUDE.md 要求附上，执行完取消注释即可验证' })
  // ⑤ 影响行数预估（B5 强制清单的一项）：必须由调用方传进来，SQL 自己看不出来
  if (opts.backfillRows == null && /\bUPDATE\b|\bINSERT\s+INTO\b/i.test(code)) {
    errors.push({ code: 'SQL_NO_ROW_ESTIMATE', why: '含 UPDATE/INSERT（存量回填）但没有影响行数预估——必须先跑 `SELECT count(*)` 拿数字（REQ-0239 是 10,635 行，事发前没人预估过）' })
  }
  if (opts.targetDbVersion == null) warnings.push({ code: 'SQL_NO_DB_VERSION', why: '未声明目标库版本——B5 要求先探测（5.7 / 8.0 决定能不能用窗口函数、CTE）' })
  if (opts.rollback == null) warnings.push({ code: 'SQL_NO_ROLLBACK', why: '未声明回滚口径（含「DDL 是否可逆」）——D4 要求每次发布都记「打回时怎么退」' })
  return { errors, warnings, clean: errors.length === 0, statements: stmts.length, tables: [...new Set(stmts.map(s => s.table))] }
}

// ============================================================================
// D4 · 回退演练与「上一个可回退版本」
// 设计里写了、实践中没有。晨检包里必须能看到「打回时怎么退」。
// ============================================================================
export function rollbackPlan({ version, prevTag, prevCommit, services = [], ddlReversible = null, ddlRollbackSql = '', frontendRepos = [] } = {}) {
  const missing = []
  if (!prevTag && !prevCommit) missing.push('缺「上一个可回退版本」（tag 或 commit）——回退无锚点')
  if (ddlReversible === null) missing.push('未声明 DDL 是否可逆（新增列可逆；改类型/删列/回填不可逆，回退需数据补偿方案）')
  if (ddlReversible === false && !ddlRollbackSql) missing.push('DDL 不可逆但没给数据补偿/回滚 SQL')
  if (!services.length && !frontendRepos.length) missing.push('未列出要回退的服务/前端仓')
  const steps = []
  if (prevTag || prevCommit) {
    steps.push(`① 后端：把 ${services.join('、') || '(未列服务)'} 回退部署到 \`${prevTag || prevCommit}\` 的构建产物`)
    if (frontendRepos.length) steps.push(`② 前端：${frontendRepos.join('、')} 回退到 \`${prevTag || prevCommit}\` 并重新发布静态资源`)
  }
  if (ddlReversible === true) steps.push('③ DDL：本次只做向后兼容的新增（新增列/新增表）→ **不回退 DDL**，旧代码忽略新列即可')
  else if (ddlReversible === false) steps.push(`③ DDL：不可逆 → 按数据补偿方案处理：${ddlRollbackSql ? '见随附回滚 SQL' : '⚠ 缺方案'}`)
  steps.push('④ 回退后立刻在测试环境跑本版 facet 的冒烟，确认回退到位（回退也要验证，不能只看部署成功）')
  return { ok: missing.length === 0, missing, steps, prev: prevTag || prevCommit || null, ddlReversible }
}

export function renderRollbackPlan(p) {
  const L = ['### 回退方案（打回时怎么退）', '']
  L.push(`- 上一个可回退版本：${p.prev ? `\`${p.prev}\`` : '⚠ **未记录**'}`)
  L.push(`- DDL 可逆性：${p.ddlReversible === true ? '可逆（纯新增）' : p.ddlReversible === false ? '**不可逆**（需数据补偿）' : '⚠ 未声明'}`)
  if (p.steps.length) { L.push(''); L.push(...p.steps.map(s => `${s}`)) }
  if (p.missing.length) { L.push(''); L.push('**回退方案不完整**'); L.push(...p.missing.map(s => `- ⚠ ${s}`)) }
  return L.join('\n')
}
