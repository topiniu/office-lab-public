// UI 状态契约的「变更侦测 + 注入块」——纯逻辑（可单测），引擎接线在 server.js。
//
// 缘起（复盘 §3.96）：E2E 里 48% 的红趟是「定位类失败」，但 92% 的 testid 在源码里明明存在——
// 真因是「状态流转后数据换了看板/子 tab」，而写用例的人不知道，只能靠「跑红 → 读源码 → 改用例」一趟换一条知识。
// 前端仓的 `scripts/extract-ui-contract.js` 已把这份知识抽成产物；本模块负责**算出「自上次以来变了什么」**
// 并格式化成派工注入块——把「变更」主动送到消费者面前。
//
// 为什么不做 CI（老板 2026-08-21 定）：CI 只会告诉**前端开发**"契约变了"，而他本来就知道（他就是改的人）；
// 真正需要这条信息的是下游写用例的人。引擎在派工链路上算 diff 并注入，比 CI 更贴。
//
// 指纹**刻意不含行号**：按钮上下移动不该产生 diff 噪声，只有「看板/子 tab/状态条件/权限码/disabled」真变了才算变。

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
const sortJoin = (a) => (Array.isArray(a) ? [...a].map(String).sort().join(',') : '')

// 单个 action 的语义指纹（变了才算变）
export function fingerprint(a) {
  if (!a || typeof a !== 'object') return ''
  return [
    'board=' + norm(a.board),
    'subTab=' + norm(a.subTab),
    'status=' + sortJoin(a.statusFields),
    'auth=' + sortJoin(a.authCodes),
    'cond=' + norm(a.conditionReadable || a.condition),
    'disabled=' + norm(a.disabledWhen),
  ].join('|')
}

// 把产物索引成 { byTestid, meta }
export function indexContract(json) {
  const byTestid = {}
  const actions = Array.isArray(json?.actions) ? json.actions : []
  for (const a of actions) {
    if (!a || !a.testid) continue
    byTestid[a.testid] = {
      fp: fingerprint(a),
      board: a.board || null, subTab: a.subTab ?? null,
      statusFields: Array.isArray(a.statusFields) ? a.statusFields : [],
      authCodes: Array.isArray(a.authCodes) ? a.authCodes : [],
      cond: norm(a.conditionReadable || a.condition).slice(0, 240),
      label: norm(a.label).replace(/^['"]|['"]$/g, ''),
      file: a.file || null,
    }
  }
  const noCond = Array.isArray(json?.actionsWithoutCondition) ? json.actionsWithoutCondition.length : 0
  return {
    byTestid,
    meta: {
      total: actions.length + noCond,
      withCondition: actions.length,
      coverage: (actions.length + noCond) ? +(actions.length / (actions.length + noCond)).toFixed(3) : 0,
      enums: Array.isArray(json?.enums) ? json.enums.length : 0,
    },
  }
}

// 新旧对比。prev 为 null（首次）时返回 firstRun=true，不把全部 action 当成"新增"（否则第一次就糊一屏）
export function diffContracts(prev, next) {
  const p = prev?.byTestid || null
  const n = next?.byTestid || {}
  if (!p) return { firstRun: true, added: [], removed: [], changed: [] }
  const added = [], removed = [], changed = []
  for (const [id, cur] of Object.entries(n)) {
    const old = p[id]
    if (!old) { added.push({ testid: id, ...cur }); continue }
    if (old.fp !== cur.fp) changed.push({ testid: id, label: cur.label, file: cur.file, from: old, to: cur })
  }
  for (const id of Object.keys(p)) if (!n[id]) removed.push({ testid: id, ...p[id] })
  const cmp = (a, b) => a.testid.localeCompare(b.testid)
  return { firstRun: false, added: added.sort(cmp), removed: removed.sort(cmp), changed: changed.sort(cmp) }
}

// 变更的人类可读说明：只说变了哪一维，别把整条条件糊上来
function whatChanged(c) {
  const bits = []
  if (norm(c.from.board) !== norm(c.to.board)) bits.push(`看板 ${c.from.board || '(无)'} → ${c.to.board || '(无)'}`)
  if (String(c.from.subTab ?? '') !== String(c.to.subTab ?? '')) bits.push(`子tab ${c.from.subTab ?? '(无)'} → ${c.to.subTab ?? '(无)'}`)
  const fs = sortJoin(c.from.statusFields), ts = sortJoin(c.to.statusFields)
  if (fs !== ts) bits.push(`状态字段 [${fs || '无'}] → [${ts || '无'}]`)
  const fa = sortJoin(c.from.authCodes), ta = sortJoin(c.to.authCodes)
  if (fa !== ta) bits.push(`权限码 [${fa || '无'}] → [${ta || '无'}]`)
  if (!bits.length) bits.push('可见条件表达式变了')
  return bits.join('；')
}

// 派工注入块。无变化时只给一行坐标（省 token）；有变化时列清单并点明"先查这几条"。
export function formatBlock({ diff, meta, refreshedAt, artifactPath, error, maxItems = 12 } = {}) {
  const L = []
  L.push('【UI 状态契约】（机器抽自前端源码：按钮可见需要「哪个看板 / 哪个子 tab / 什么状态值 / 什么权限码」）')
  if (artifactPath) L.push(`事实源：${artifactPath}　—— 写用例前按 testid 查它，别跑红了再查源码。`)
  if (error) {
    L.push(`⚠ 本次刷新失败（${norm(error).slice(0, 160)}），下方结论基于磁盘上的旧产物；如与实跑对不上，回退去读源码谓词。`)
  }
  if (meta) L.push(`当前：${meta.withCondition}/${meta.total} 个操作项有可见条件（覆盖 ${(meta.coverage * 100).toFixed(0)}%），${meta.enums} 组看板/tab 枚举${refreshedAt ? `；刷新于 ${refreshedAt}` : ''}。`)
  if (!diff || diff.firstRun) {
    L.push('（本次为首次建立基线，无变更清单。）')
    return L.join('\n')
  }
  const n = diff.added.length + diff.removed.length + diff.changed.length
  if (!n) { L.push('自上次以来**无变更**。'); return L.join('\n') }
  L.push(`\n⚠ 自上次以来有 ${n} 处变化——**相关用例先查这几条**（这类变化正是"跑红才发现"的主要来源）：`)
  // 注意：计数用「先判后增」，别写 `shown++ >= maxItems`——那样 break 时 shown 已多加 1，
  // 剩余数会少报一个（截断必须如实报，静默少报等于假装覆盖全了）。
  let shown = 0
  for (const c of diff.changed) {
    if (shown >= maxItems) break
    L.push(`  ~ ${c.testid}${c.label ? `（${c.label}）` : ''}：${whatChanged(c)}`); shown++
  }
  for (const a of diff.added) {
    if (shown >= maxItems) break
    L.push(`  + ${a.testid}${a.label ? `（${a.label}）` : ''} 新增：看板=${a.board || '(未判定)'}${a.subTab != null ? ` 子tab=${a.subTab}` : ''}${a.statusFields.length ? ` 状态=[${a.statusFields.join(',')}]` : ''}${a.authCodes.length ? ` 权限=[${a.authCodes.join(',')}]` : ''}`); shown++
  }
  for (const r of diff.removed) {
    if (shown >= maxItems) break
    L.push(`  - ${r.testid}${r.label ? `（${r.label}）` : ''} 消失（被删或改名）——引用它的用例会红，先确认新入口`); shown++
  }
  if (n > shown) L.push(`  …还有 ${n - shown} 处，详见事实源文件。`)
  return L.join('\n')
}
