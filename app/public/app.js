/* 望子成龙小学 前端 — Linear 风格：侧边栏导航 / 任务(issue 式条目) / 运行会话流 / 派工弹层 */
let EMPLOYEES = {}
let tasksCache = []
let runsCache = []
let pendingCache = {}   // 每员工待处理队列（跨线程消息扣在这，忙完当前会话再排空）：{ [employee]: [{id,from,kind,text,ts}] }
let patrolStatus = null   // 小呆呆巡视实时状态（/api/patrol-status，驱动名牌状态点 + 巡检光标）
let currentRun = null
let evtSource = null
let replaying = false   // 打开会话时的历史回放阶段：期间抑制逐条自动贴底，避免视口跟着一条条渲染「从头滚到尾」，回放结束(lab-sync)再一次性贴底
let chatOldestSeq = 0   // 当前聊天区已渲染的最旧事件 seq(=jsonl 行号)；分页「加载更早」的游标，冷开由首条回放事件的 SSE id 定
let pickedEmployee = null
let takingOver = false   // ⚡接管中间态：点击后置真，输入框文字保留+禁用+pill 翻「正在停止…」，直到真正投递的 user-msg SSE 到达再收尾

const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
/* 剔除 U+FFFD 替换符：非 UTF-8（如 GBK）客户端发来的消息会残留乱码符，展示前清掉，全是乱码则回退空串 */
const clean = s => String(s ?? '').replace(/�/g, '').replace(/\s+/g, ' ').trim()
const avatar = (k, size) => {
  const e = EMPLOYEES[k]
  return e ? `<img class="avatar" width="${size}" height="${size}" style="width:${size}px;height:${size}px" src="${e.avatar}" alt="${esc(e.displayName)}" decoding="async" />` : ''
}

/* ---------- 全局网络进度条：包裹 window.fetch，任何请求在飞就顶部显示细条 ----------
   一处统一驱动，覆盖开机串行 fetch（loadEmployees/loadTasks/loadRuns）+ 所有现有/未来操作（含分页 /history）。
   隧道下「真空期」不再无反馈。SSE 不是 fetch、不走这里（会话 SSE 的真空期由聊天区转圈覆盖）。 */
;(function installNetBar() {
  let inflight = 0
  const sync = () => { const b = $('net-bar'); if (b) b.classList.toggle('active', inflight > 0) }
  const orig = window.fetch.bind(window)
  window.fetch = (...args) => {
    inflight++; sync()
    return orig(...args).finally(() => { inflight = Math.max(0, inflight - 1); sync() })
  }
})()
/* 打开会话时的聊天加载态：#chat-loading 转圈（补 SSE 连接+回放的真空期，lab-sync 到达即藏） */
function showChatLoading(on) { $('chat-loading')?.classList.toggle('hidden', !on) }

/* ---------- 视图切换（聊天坞独立于主视图，切页不关聊天） ---------- */
const VIEW_TITLES = { tasks: '任务', runs: '运行', chain: '会话看板', patrol: '巡检', meeting: '会议室' }
function showView(name) {
  for (const v of ['tasks', 'runs', 'chain', 'patrol', 'meeting']) $(`view-${v}`)?.classList.toggle('hidden', v !== name)
  document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.view === name))
  $('topbar-title').textContent = VIEW_TITLES[name]
}

/* ---------- 聊天坞开关 ---------- */
function openChatPanel() {
  $('chat-panel').classList.remove('hidden')
  closeSidebar()  // 移动端全屏打开聊天时收起抽屉
  applyChatExpand()
}
function closeChat() {
  $('chat-panel').classList.add('hidden')
  chatExpanded = false
  applyChatExpand()
  if (evtSource) { evtSource.close(); evtSource = null }
  currentRun = null
  resetCardBatch()
  hidePatrolBanner()
  loadRuns()
}

/* 全屏放大：聊天坞铺满主区（侧边栏保留），再点还原回停靠宽度 */
let chatExpanded = false
const EXPAND_ICONS = {
  expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  collapse: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
}
function expandBtnHtml() {
  const [icon, tip] = chatExpanded ? [EXPAND_ICONS.collapse, '还原停靠宽度'] : [EXPAND_ICONS.expand, '全屏放大']
  return `<button class="btn ghost" id="chat-expand" onclick="toggleChatExpand()" title="${tip}">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>
  </button>`
}
function toggleChatExpand() {
  chatExpanded = !chatExpanded
  applyChatExpand()
  const btn = $('chat-expand')
  if (btn) btn.outerHTML = expandBtnHtml()
}
function applyChatExpand() {
  const panelOpen = !$('chat-panel').classList.contains('hidden')
  $('chat-panel').classList.toggle('expanded', chatExpanded)
  document.querySelector('main').classList.toggle('hidden', chatExpanded && panelOpen)
  applyChatWidth()
  syncRunHeadClear()   // 展开/还原会改会话头宽度→高度，重量毛玻璃头净空
}

/* ---------- 聊天坞拖拽调宽（仅桌面停靠态：>1024px 且非全屏放大；持久化到 localStorage） ---------- */
const CHAT_W_KEY = 'ol-chat-width'
function chatDocked() { return window.matchMedia('(min-width: 1025px)').matches && !chatExpanded }
// 上限双约束：不超视口 70%，且给中栏(看板)留地板——sidebar 实测宽 + main 至少 360，
// 使两行状态行轨永远有落脚（小屏拖到极宽也不会把台账压到读不了）；下限 320。
// 用实测 sidebar 宽（折叠成 64px 轨时可让聊天坞相应更宽），不写死 232。
function clampChatW(w) {
  const sb = document.getElementById('sidebar')
  const sbw = sb ? Math.round(sb.getBoundingClientRect().width) : 232
  return Math.max(320, Math.min(w, Math.round(window.innerWidth * 0.7), window.innerWidth - sbw - 360))
}
function applyChatWidth() {
  const panel = $('chat-panel')
  if (!chatDocked()) { panel.style.width = ''; return }   // 浮层/全屏态交回 CSS
  const saved = parseInt(localStorage.getItem(CHAT_W_KEY) || '', 10)
  panel.style.width = saved ? clampChatW(saved) + 'px' : ''  // 无存值→用 CSS 默认 min(480px,42vw)
}
;(function initChatResize() {
  const grip = $('chat-resizer'); if (!grip) return
  let dragging = false
  grip.addEventListener('mousedown', e => {
    if (!chatDocked()) return
    dragging = true; grip.classList.add('dragging')
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
    e.preventDefault()
  })
  window.addEventListener('mousemove', e => {
    if (!dragging) return
    $('chat-panel').style.width = clampChatW(window.innerWidth - e.clientX) + 'px'   // 停靠在右侧：宽度=窗口右缘到光标
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false; grip.classList.remove('dragging')
    document.body.style.cursor = ''; document.body.style.userSelect = ''
    const w = parseInt($('chat-panel').style.width, 10)
    if (w) localStorage.setItem(CHAT_W_KEY, String(w))
  })
})()
window.addEventListener('resize', () => { if (!$('chat-panel').classList.contains('hidden')) { applyChatWidth(); syncRunHeadClear() } })
/* ---------- 移动端侧边栏抽屉（body 加类，样式靠 CSS media query 生效，桌面加类无副作用） ----------
   开抽屉时锁文档滚动（记录 scrollY、CSS 把 body 冻成 position:fixed），收起时还原——
   避免 iOS 上「文档滚过 + fixed 覆盖层」的合成鬼影（黑/白残留收起不消失），顺带挡背景误滚。仅移动端锁。 */
const _sbMobileMQ = window.matchMedia('(max-width: 640px)')
function openSidebar() {
  if (document.body.classList.contains('sidebar-open')) return
  if (_sbMobileMQ.matches) {
    const y = window.scrollY || window.pageYOffset || 0
    document.body.dataset.lockY = String(y)
    document.body.style.top = (-y) + 'px'   // 冻结文档在当前位置（配合 CSS body.sidebar-open{position:fixed}）
  }
  document.body.classList.add('sidebar-open')
}
function closeSidebar() {
  if (!document.body.classList.contains('sidebar-open')) return
  document.body.classList.remove('sidebar-open')
  if (document.body.dataset.lockY != null) {
    const y = parseInt(document.body.dataset.lockY, 10) || 0
    delete document.body.dataset.lockY
    document.body.style.top = ''
    window.scrollTo(0, y)   // 还原滚动位置（解冻后回到原处，无跳动）
  }
}
function toggleSidebar() { document.body.classList.contains('sidebar-open') ? closeSidebar() : openSidebar() }
/* 变宽到平板/桌面时清掉抽屉态，避免旋屏残留（closeSidebar 内含解锁，安全） */
window.matchMedia('(min-width: 641px)').addEventListener('change', e => { if (e.matches) closeSidebar() })

/* ---------- 侧栏折叠（桌面：232px 全展 ⇄ 64px 图标轨）----------
   折叠态挂 <html>.sb-collapsed（首帧前由 index.html 头脚本按 localStorage 恢复，无闪跳）；
   本处只管切换 + 持久化 + 同步按钮语义。宽度动画交给 CSS transition，main 随 flex 连续重排。 */
const SIDEBAR_COLLAPSE_KEY = 'ol-sidebar-collapsed'
function syncSidebarToggle() {
  const btn = $('sidebar-toggle'); if (!btn) return
  const collapsed = document.documentElement.classList.contains('sb-collapsed')
  const label = collapsed ? '展开侧栏' : '折叠侧栏'
  btn.title = label; btn.setAttribute('aria-label', label); btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false')
}
function toggleSidebarCollapse() {
  const collapsed = document.documentElement.classList.toggle('sb-collapsed')
  try { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0') } catch (e) {}
  syncSidebarToggle()
}

/* ---------- 统一设置模块（顶栏齿轮 → 单弹层多分区）----------
   通用分区的主题/自动接棒沿用原按钮同 id（applyTheme/renderChainToggle 不变）；
   4 个配置分区首次进入时按需拉取（每次打开设置重置，保证最新）；卡片分区渲染 OLCards.DEMO 画廊。 */
const SETTINGS_LOADERS = { engines: loadEngineConfig, push: loadPushConfig, zhuzhu: loadZhuzhuConfig, wecom: loadWecomConfig, lark: loadLarkConfig, wecomsheet: loadWecomMirrorConfig, cards: renderCardGallery }
const settingsLoaded = {}
function openSettings(section) {
  for (const k in settingsLoaded) delete settingsLoaded[k]   // 每次打开重新拉取最新配置
  $('settings-modal').classList.remove('hidden')
  switchSettingsSection(section || 'general')
}
function closeSettings() { $('settings-modal').classList.add('hidden') }
function switchSettingsSection(id) {
  document.querySelectorAll('#settings-modal .settings-nav-item').forEach(b => b.classList.toggle('active', b.dataset.section === id))
  document.querySelectorAll('#settings-modal .settings-panel').forEach(p => p.classList.toggle('active', p.dataset.section === id))
  const load = SETTINGS_LOADERS[id]
  if (load && !settingsLoaded[id]) { settingsLoaded[id] = true; try { load() } catch (e) { console.warn('[settings]', id, e) } }
}
// 消息卡片分区：渲染 OLCards.DEMO 全类型样例画廊（动作卡在此只预览、按钮不生效）
function renderCardGallery() {
  const host = $('settings-cards')
  if (!host) return
  if (!window.OLCards) { host.innerHTML = '<div class="ps-hint">卡片模块未加载</div>'; return }
  const inert = {
    runId: 'preview', employeeName: '预览',
    reply: () => { toast('预览卡片，动作不在这里生效', 'warn'); return false },   // 返 false：预览卡片不假装「已处理」
    focusReply: () => toast('预览卡片，动作不在这里生效', 'warn'),
    openUrl: u => { if (/^https?:\/\//i.test(u || '')) window.open(u, '_blank', 'noopener') },
    copy: async t => { try { await navigator.clipboard.writeText(t || ''); toast('已复制', 'ok') } catch {} },
    download: () => toast('预览卡片，动作不在这里生效', 'warn'),
    toast,
  }
  host.innerHTML = ''
  OLCards.DEMO.forEach(data => {
    const row = document.createElement('div')
    row.className = 'settings-card-item'
    row.innerHTML = `<div class="settings-card-type">${esc(data.type)}</div><div class="olc-wrap"></div>`
    try { row.querySelector('.olc-wrap').appendChild(OLCards.renderCard(data, inert)) } catch (e) { }
    host.appendChild(row)
  })
}

document.querySelectorAll('.nav-item').forEach(a =>
  a.addEventListener('click', () => { showView(a.dataset.view); if (a.dataset.view === 'runs') loadRuns(); if (a.dataset.view === 'chain') loadConversations(); if (a.dataset.view === 'patrol') loadPatrolLog(); if (a.dataset.view === 'meeting') loadMeetings(); closeSidebar() }))

function refreshAll() { loadTasks(); loadRuns() }

/* ---------- 员工（侧边栏） ---------- */
async function loadEmployees() {
  EMPLOYEES = await (await fetch('/api/employees')).json()
  $('emp-list').innerHTML = Object.entries(EMPLOYEES).map(([k, e]) =>
    `<div class="emp-row" onclick="openChat('${k}')" title="点头像看详情 · 点这里直接开聊">
       <div class="emp-av" onclick="event.stopPropagation();openEmployeeDetail('${k}')" title="查看 ${esc(e.displayName)} 的详情">
         ${avatar(k, 40)}
         <span class="emp-badge hidden" id="emp-st-${k}"></span>
         ${k === 'chaorenq' ? `<span class="patrol-aura" id="patrol-aura"></span><span class="patrol-ripple off" id="patrol-ripple"><i></i><i></i><i></i></span>` : ''}
       </div>
       <div class="emp-main">
         <div class="emp-l1"><span class="emp-name">${esc(e.displayName)}</span><span class="emp-title">${esc(e.title)}</span><span class="emp-queue-badge hidden" id="emp-q-${k}" onclick="event.stopPropagation();togglePendingList('${k}',event)" title="待处理消息队列（点看详情）"></span></div>
         <div class="emp-l2" id="emp-act-${k}">空闲 · 点我开聊</div>
       </div>
       ${k === 'chaorenq' ? `<span class="patrol-dot on" id="patrol-dot" title="巡视状态"></span>` : ''}
     </div>`).join('')
  $('d-employees').innerHTML = Object.entries(EMPLOYEES).map(([k, e]) =>
    `<div class="emp-pick" id="pick-${k}" onclick="pickEmployee('${k}')">
       ${avatar(k, 40)}
       <span>${esc(e.displayName)}</span>
     </div>`).join('')
}
function pickEmployee(k) {
  pickedEmployee = k
  document.querySelectorAll('.emp-pick').forEach(el => el.classList.toggle('selected', el.id === `pick-${k}`))
}

/* ---------- 员工详情弹层（点头像打开；聚合工牌/职责/教训库/履历/在办/交接/定义/模板） ---------- */
const HANDOFF = ['feifei', 'ggbond', 'mihu', 'bobby']   // 交接链：菲菲→GG Bond→迷糊→波比
// 权限模式下拉（SDK PermissionMode 子集；curated）
const PERM_MODE_OPTS = [
  { v: 'acceptEdits', label: 'acceptEdits · 自动接受编辑' },
  { v: 'auto', label: 'auto · 分类器放行' },
  { v: 'plan', label: 'plan · 只读/规划' },
  { v: 'bypassPermissions', label: 'bypassPermissions · 无限制（慎用）' },
]
// 切换某员工权限模式：写回 employees.json（下次派工生效）
async function setEmpPermission(k, mode) {
  const hint = $('ed-perm-hint-' + k)
  if (hint) hint.textContent = '保存中…'
  try {
    const resp = await fetch('/api/employees/' + encodeURIComponent(k) + '/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: mode }),
    })
    const raw = await resp.text()
    let r = null; try { r = JSON.parse(raw) } catch { }
    if (!r) {   // 非 JSON（多为旧服务无此路由的 404 "not found"）
      if (hint) hint.textContent = resp.status === 404
        ? '服务未识别该接口——请重启 office-lab 服务后再试（新增接口需重启加载）'
        : `保存失败（${resp.status}）：${raw.slice(0, 80)}`
      return
    }
    if (r.ok) {
      if (window.EMPLOYEES && EMPLOYEES[k]) EMPLOYEES[k].permissionMode = r.permissionMode
      if (hint) hint.textContent = `已设为 ${r.permissionMode}（下次派工生效；已在跑的会话保持原模式到收工）`
    } else if (hint) { hint.textContent = (r.error || '保存失败') }
  } catch (e) { if (hint) hint.textContent = (e.message || e) }
}
// 保存某员工的 Bark 通知头像直链（iconUrl）：写回 employees.json，下条通知即用；留空清除回退 iconBase+本地头像
async function saveEmpIconUrl(k, btn) {
  const input = $(`ed-iconurl-${k}`), hint = $(`ed-iconurl-hint-${k}`), prev = $(`ed-iconurl-prev-${k}`)
  const v = (input?.value || '').trim()
  if (hint) { hint.textContent = '保存中…'; hint.className = 'ed-perm-hint' }
  try {
    const resp = await fetch('/api/employees/' + encodeURIComponent(k) + '/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ iconUrl: v }),
    })
    const raw = await resp.text(); let r = null; try { r = JSON.parse(raw) } catch { }
    if (!r) {   // 非 JSON（多为旧服务无此字段的 404 "not found"）
      if (hint) hint.textContent = resp.status === 404
        ? '服务未识别该接口——请重启 office-lab 服务后再试（新增字段需重启加载）'
        : `保存失败（${resp.status}）：${raw.slice(0, 80)}`
      return
    }
    if (r.ok) {
      if (window.EMPLOYEES && EMPLOYEES[k]) EMPLOYEES[k].iconUrl = r.iconUrl
      if (prev) { prev.classList.remove('bad'); prev.src = r.iconUrl || EMPLOYEES[k]?.avatar || '' }
      if (hint) hint.textContent = r.iconUrl ? '已保存 · 下条通知即用新头像' : '已清空 · 回退 iconBase ＋ 本地头像'
      toast(r.iconUrl ? '通知头像已保存' : '通知头像已清空', 'ok')
    } else if (hint) { hint.textContent = (r.error || '保存失败') }
  } catch (e) { if (hint) hint.textContent = (e.message || e) }
}
function relTime(iso) {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0 || isNaN(diff)) return '刚刚'
  const m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d > 0) return `${d} 天前`
  if (h > 0) return `${h} 小时前`
  if (m > 0) return `${m} 分钟前`
  return '刚刚'
}
let edObserver = null
function closeEmployeeDetail() {
  $('emp-modal').classList.add('hidden')
  if (edObserver) { edObserver.disconnect(); edObserver = null }
}
/* 锚点跳转：把目标分区滚到内容区顶部（ed-scroll 为定位父，直接用 offsetTop） */
function edGoto(id) {
  const el = document.getElementById(id), scroller = $('ed-scroll')
  if (el && scroller) scroller.scrollTo({ top: Math.max(0, el.offsetTop - 4), behavior: 'smooth' })
}
/* 滚动时高亮当前分区对应的锚点（取最靠上的可见分区） */
function edSetupObserver() {
  if (edObserver) { edObserver.disconnect(); edObserver = null }
  const scroller = $('ed-scroll')
  if (!scroller || !('IntersectionObserver' in window)) return
  const items = [...document.querySelectorAll('.ed-nav-item')]
  edObserver = new IntersectionObserver(entries => {
    const vis = entries.filter(en => en.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
    if (vis[0]) items.forEach(it => it.classList.toggle('active', it.dataset.target === vis[0].target.id))
  }, { root: scroller, rootMargin: '0px 0px -70% 0px', threshold: 0 })
  document.querySelectorAll('.ed-section').forEach(s => edObserver.observe(s))
}

async function openEmployeeDetail(k) {
  const e = EMPLOYEES[k] || {}
  const body = $('emp-modal-body')
  body.innerHTML = `<div class="emp-detail-loading">加载 ${esc(e.displayName || k)} 的详情…</div>`
  $('emp-modal').classList.remove('hidden')
  let d
  try { d = await (await fetch('/api/employees/' + encodeURIComponent(k) + '/detail')).json() }
  catch (err) { body.innerHTML = `<div class="emp-detail-loading">加载失败：${esc(String(err.message || err))}</div>`; return }
  if (d.error) { body.innerHTML = `<div class="emp-detail-loading">加载失败：${esc(d.error)}</div>`; return }

  // 巡视员专属：拉取巡查配置（供「巡视设置」段渲染当前值）。巡视记录已移到顶部导航「巡检」面板。
  let patrolCfg = null
  if (k === 'chaorenq') { try { patrolCfg = await (await fetch('/api/chain-config')).json() } catch { } }

  // 履历统计（用前端已有 runsCache）；只算正式会话——只读咨询窗不是「派工」，算进来会稀释次数/成功率
  const runs = runsCache.filter(r => r.employee === k && !r.consult)
  const total = runs.length
  const done = runs.filter(r => r.status === 'done').length
  const rate = total ? Math.round(done / total * 100) + '%' : '—'
  const lastActive = relTime(runs[0]?.startedAt)
  const recent = runs.slice(0, 5).map(r => {
    const [cls, label] = runPill(r)
    const snip = clean((r.instruction || '').replace(/^【派工】/, '').replace(/任务档案：\S+\s*/, '')).slice(0, 40) || '（无摘要）'
    return `<div class="run-row" onclick="closeEmployeeDetail();openRun('${r.id}')">
      <div class="run-main"><div class="run-inst">${esc(snip)}</div></div>
      <span class="pill ${cls}"><span class="dot"></span>${label}</span>
      <span class="run-time">${esc((r.startedAt || '').slice(5, 16).replace('T', ' '))}</span>
    </div>`
  }).join('') || '<div class="ed-empty">还没有派过工</div>'

  // 在办事项（用前端已有 tasksCache：owner 命中的档案 + guessNext 归属该员工的在飞条目）
  const inflight = []
  for (const t of tasksCache) {
    const fm = t.frontmatter || {}
    if (fm.owner === k) inflight.push({ file: t.file, title: fm.task || t.file, label: `负责本版本 · ${fm.status || ''}` })
    for (const en of (t.entries || [])) {
      const s = entryState(en)
      if (s.flight && s.next === k) inflight.push({ file: t.file, title: `#${en.no} ${en.name.replace(/\*\*/g, '')}`, label: s.status ? `${s.status} · ${s.stage}` : s.stage })
    }
  }
  const inflightHtml = inflight.length
    ? inflight.map(it => `<div class="ed-task" onclick="closeEmployeeDetail();viewFile('${esc(it.file)}')">
        <div class="ed-task-title" title="${esc(it.title)}">${esc(it.title)}</div>
        <div class="ed-task-label" title="${esc(it.label)}">${esc(it.label)}</div>
      </div>`).join('')
    : '<div class="ed-empty">暂无在办事项</div>'

  // 交接关系（静态链）
  const idx = HANDOFF.indexOf(k)
  const prev = idx > 0 ? HANDOFF[idx - 1] : null
  const next = idx >= 0 && idx < HANDOFF.length - 1 ? HANDOFF[idx + 1] : null
  const hop = (kk, dir) => kk
    ? `<div class="ed-hop" onclick="closeEmployeeDetail();openEmployeeDetail('${kk}')" title="查看 ${esc(EMPLOYEES[kk].displayName)}">
         <span class="ed-hop-dir">${dir}</span>${avatar(kk, 26)}<span>${esc(EMPLOYEES[kk].displayName)}</span>
       </div>`
    : `<div class="ed-hop empty"><span class="ed-hop-dir">${dir}</span>—</div>`
  const handoffHtml = `<div class="ed-handoff">${hop(prev, '上一棒')}<span class="ed-hop-arrow">→</span><div class="ed-hop me">${avatar(k, 26)}<span>${esc(e.displayName)}</span></div><span class="ed-hop-arrow">→</span>${hop(next, '下一棒')}</div>`

  const tplHtml = (d.templates || []).length
    ? (d.templates.map(tp => `<div class="ed-tpl" onclick="closeEmployeeDetail();viewFile('${esc(tp.file)}')">${esc(tp.title)}</div>`).join(''))
    : '<div class="ed-empty">无对应模板</div>'

  // 概览段（简介 + 统计），随后各分区——同一个 sections 驱动左侧锚点与右侧内容，天然对齐
  const overviewHtml = `
    ${d.description ? `<div class="ed-desc">${esc(d.description)}</div>` : ''}
    <div class="ed-stats">
      <div class="ed-stat"><b>${total}</b><span>派工次数</span></div>
      <div class="ed-stat"><b>${rate}</b><span>成功率</span></div>
      <div class="ed-stat"><b>${lastActive}</b><span>最近活跃</span></div>
    </div>`
  const sections = [{ id: 'eds-overview', nav: '概览', head: '', html: overviewHtml }]
  if (k === 'chaorenq' && patrolCfg) {
    const c = patrolCfg
    sections.push({
      id: 'eds-patrol', nav: '巡视设置', head: '巡视设置', html: `
      <div class="ed-patrol">
        <label class="ed-patrol-row"><span>空停巡查（总开关）</span><input type="checkbox" id="pat-enabled" ${c.patrolEnabled !== false ? 'checked' : ''}></label>
        <label class="ed-patrol-row"><span>定时巡逻间隔 · 分钟</span><input type="number" id="pat-sweep" min="1" max="720" value="${Number(c.patrolSweepMin) || 6}"></label>
        <label class="ed-patrol-row"><span>聊天接管宽限窗 · 秒</span><input type="number" id="pat-grace" min="0" max="120" value="${Number(c.patrolGraceSec ?? 8)}"></label>
        <label class="ed-patrol-row"><span>同一会话续跑上限 · 次</span><input type="number" id="pat-max" min="1" max="50" value="${Number(c.patrolMax) || 6}"></label>
        <button class="btn sm" onclick="savePatrolConfig(this)">保存</button>
        <div class="ed-patrol-hint">事件驱动巡查（员工一空停即时判）<b>始终生效</b>；这里调的是「定时兜底」的频率——越小越勤、也越费；默认 6 分钟。改动即时生效、无需重启。<br><b>聊天接管宽限窗</b>：聊天会话空停时，小呆呆延后这么多秒再接管，其间输入框上方显示倒计时——你回话或点「取消接管」即撤销；<b>0＝关闭</b>（退回即时接管）。默认 8 秒。<br>巡检记录看顶部导航「巡检」页。</div>
      </div>` })
  }
  // 通知头像（Bark）：可在系统里直接配置每位员工的通知头像直链——手机端下载显示，需公网 http(s) 直链
  sections.push({
    id: 'eds-notify', nav: '通知头像', head: '通知头像（Bark 推送）', html: `
    <div class="ed-notify">
      <div class="ed-notify-top">
        <img class="ed-notify-prev" id="ed-iconurl-prev-${k}" src="${esc(e.iconUrl || e.avatar || '')}" onerror="this.classList.add('bad')" alt="通知头像预览">
        <label class="ed-notify-field">
          <span>通知头像直链（iconUrl）</span>
          <input type="url" id="ed-iconurl-${k}" value="${esc(e.iconUrl || '')}" placeholder="https://…/${esc(k)}.png" spellcheck="false">
        </label>
      </div>
      <div class="ed-notify-actions">
        <button class="btn sm" onclick="saveEmpIconUrl('${k}', this)">保存</button>
        <span class="ed-perm-hint" id="ed-iconurl-hint-${k}"></span>
      </div>
      <div class="ed-patrol-hint">Bark 通知图标由<b>手机端下载显示</b>，必须填<b>公网可访问的 HTTPS 直链</b>。本机 <code>/avatars/…</code>、Tailscale/内网或 HTTP 地址手机取不到——这正是没填直链的员工在通知里没头像的原因。留空＝回退推送设置里的 <code>iconBase</code> ＋ 本地头像（仅当手机能访问该地址时才生效）。改动即时生效、无需重启。</div>
    </div>` })
  if (d.roleMd) sections.push({ id: 'eds-role', nav: '职责与红线', head: '职责与红线', html: `<div class="md-mini ed-md">${mdRender(d.roleMd)}</div>` })
  sections.push({ id: 'eds-memory', nav: '教训库', head: `教训库 <span class="ed-count">${d.lessonCount || 0} 条</span>`, html: `<div class="md-mini ed-md">${d.memoryMd ? mdRender(d.memoryMd) : '<div class="ed-empty">暂无教训沉淀</div>'}</div>` })
  sections.push({ id: 'eds-tasks', nav: '在办事项', head: '在办事项', html: `<div class="ed-tasks">${inflightHtml}</div>` })
  sections.push({ id: 'eds-handoff', nav: '交接关系', head: '交接关系', html: handoffHtml })
  sections.push({ id: 'eds-runs', nav: '最近运行', head: '最近运行', html: `<div class="ed-runs">${recent}</div>` })
  sections.push({ id: 'eds-tpl', nav: '产出模板', head: `产出模板 <span class="ed-count">${(d.templates || []).length}</span>`, html: `<div class="ed-tpls">${tplHtml}</div>` })
  sections.push({ id: 'eds-agent', nav: 'Agent 定义', head: 'Agent 定义 · system prompt', html: `<div class="md-mini ed-md">${d.agentMd ? mdRender(d.agentMd) : '<div class="ed-empty">无</div>'}</div>` })

  const navHtml = sections.map((s, i) =>
    `<button class="ed-nav-item${i === 0 ? ' active' : ''}" data-target="${s.id}" onclick="edGoto('${s.id}')">${s.nav}</button>`).join('')
  const contentHtml = sections.map(s =>
    `<section class="ed-section" id="${s.id}">${s.head ? `<div class="section-label">${s.head}</div>` : ''}${s.html}</section>`).join('')

  body.innerHTML = `
    <div class="ed-head">
      ${avatar(k, 56)}
      <div class="ed-id">
        <div class="ed-name">${esc(e.displayName || k)} <span class="ed-emoji">${esc(e.emoji || '')}</span></div>
        <div class="ed-title">${esc(e.title || '')}</div>
        <div class="ed-chips">
          <span class="ed-chip">默认模型 · ${esc((d.defaultModel || '').replace('claude-', ''))}</span>
          <span class="ed-chip">权限 ·
            <select class="ed-perm-select" id="ed-perm-${k}" onchange="setEmpPermission('${k}', this.value)" title="切换该员工的权限模式（下次派工生效）">
              ${PERM_MODE_OPTS.map(o => `<option value="${o.v}"${(d.permissionMode || 'acceptEdits') === o.v ? ' selected' : ''}>${o.label}</option>`).join('')}
            </select>
          </span>
        </div>
        <div class="ed-perm-hint" id="ed-perm-hint-${k}"></div>
      </div>
      <div class="spacer"></div>
      <div class="ed-head-actions">
        <button class="btn sm primary" onclick="closeEmployeeDetail();openChat('${k}')">开聊</button>
        <button class="btn sm secondary" onclick="closeEmployeeDetail();openDispatch('${k}')">派工</button>
        <button class="btn ghost" onclick="closeEmployeeDetail()" title="关闭">✕</button>
      </div>
    </div>
    <div class="ed-main">
      <nav class="ed-nav">${navHtml}</nav>
      <div class="ed-scroll" id="ed-scroll">${contentHtml}</div>
    </div>`
  edSetupObserver()
}

/* ---------- 任务视图 ---------- */
/* 条目结构化状态枚举 → 圆点色（ok=绿/flight=琥珀/blocked=红）+ 是否在飞 + 下一棒归属。
   next='auto' 表示交给 guessNext(stage) 从阶段文字推断。未收录的状态或空值 → 回退旧的文字启发式。 */
// dot = 看板状态色：flight(琥珀=进行中/待办) / dev(蓝=某阶段已完成、在流水线上) / ok(绿=通过/上线) / blocked(红=阻塞/打回) / idle(灰)
// 条目「状态」枚举 → 圆点色 + 下一棒。键集是权威枚举，须与 server.js 的 `ENTRY_STATUS_ENUM`（set_entry_status 校验）
// 与 `文档格式规范.md` 状态枚举表三处保持一致（改一处必须同步另两处）。员工写状态只能用这些值，自造会落到下方灰色启发式。
const ENTRY_STATUS = {
  '待梳理':  { dot: 'flight',  flight: true,  next: 'feifei' },
  '需求确认': { dot: 'flight',  flight: true,  next: 'ggbond' },
  '待开发':  { dot: 'flight',  flight: true,  next: 'ggbond' },
  '开发中':  { dot: 'flight',  flight: true,  next: 'ggbond' },
  '已定稿':  { dot: 'dev',     flight: true,  next: 'ggbond' },
  '待审':    { dot: 'dev',     flight: true,  next: 'ggbond' },
  '已开发':  { dot: 'dev',     flight: true,  next: 'mihu' },    // 开发完成、待 QA/人工——蓝色区别于「已通过」的绿
  'QA中':    { dot: 'flight',  flight: true,  next: 'mihu' },
  '待QA':    { dot: 'flight',  flight: true,  next: 'mihu' },
  '待测':    { dot: 'flight',  flight: true,  next: 'mihu' },
  '待人工':  { dot: 'flight',  flight: true,  next: 'manual' },
  '待预检':  { dot: 'flight',  flight: true,  next: 'manual' },
  '待复验':  { dot: 'flight',  flight: true,  next: 'manual' },
  '已跳过':    { dot: 'flight',  flight: true,  next: 'manual' },   // 守航：不满足前提、park 待老板拍板（非失败，见设计 §3）
  '已隔离':    { dot: 'blocked', flight: true,  next: 'manual' },   // 守航：反复失败/污染候选、退出版本、留证待老板
  '待人工验收': { dot: 'flight',  flight: true,  next: 'manual' },   // 守航终点：RC 已发测、待老板晨检验收
  '人工Pass': { dot: 'ok',      flight: false, next: null },   // 用户自测通过、跳过流程（结构化状态优先于 stage 文字启发式）
  '阻塞':    { dot: 'blocked', flight: true,  next: 'auto' },
  '打回':    { dot: 'blocked', flight: true,  next: 'ggbond' },
  'QA通过':  { dot: 'ok',      flight: false, next: null },
  '已上线':  { dot: 'ok',      flight: false, next: null },
  '已归档':  { dot: 'ok',      flight: false, next: null },
}
/* 条目状态归一：优先用结构化「状态」列；老档案无该列时回退到「当前阶段」文字启发式。 */
function entryState(en) {
  const stage = (en.stage || '').replace(/\*\*/g, '')
  const status = (en.status || '').replace(/\*\*/g, '').trim()
  const sm = ENTRY_STATUS[status]
  if (sm) return { status, stage, dot: sm.dot, flight: sm.flight, next: sm.next === 'auto' ? guessNext(stage) : sm.next }
  const flight = /待|开发中|QA中|PM_/.test(stage) && !/^✅/.test(stage)
  // 未收录状态的颜色启发（status 文字优先于 stage）：红=阻塞打回 / 蓝=某阶段已完成 / 琥珀=进行中待办 / 绿=通过上线
  const both = status + ' ' + stage
  const dot = /阻塞|打回|缺陷|RED|失败|不通过/.test(both) ? 'blocked'
    : /已开发|已定稿|待审|开发完成|已提测/.test(status) ? 'dev'
    : flight ? 'flight'
    : /✅|已上线|已归档|全绿|PASSED|通过|Pass/.test(both) ? 'ok' : 'idle'
  // 未收录的自定义状态：优先用「状态」文字推断下一棒（状态=当前这一棒的权威标签；
  // stage 是长叙述、结尾的 → 常指向更远的未来跳，guessNext 取最后一段会误判，如"重开·待开发…→改完→待迷糊复验"会错算成迷糊）。
  const next = flight ? (guessNext(status) || guessNext(stage)) : null
  return { status, stage, dot, flight, next }
}
const STATUS_PILL = s => {
  if (/DONE|ARCHIVED|CLOSED/.test(s)) return 'success'
  if (/PROD|RELEASE|ONLINE/.test(s)) return 'accent'
  if (/BLOCK|FAIL/.test(s)) return 'danger'
  if (/TEST|QA|REVIEW/.test(s)) return 'warn'
  if (/DEV|PROGRESS|WIP|DOING/.test(s)) return 'dev'
  return 'warn'   // 兜底给个进行中的暖色，别再是无色灰
}

// 门禁圆点的中文 tooltip（hover 可读；圆点布局不变）。缺省回落原 key。
const GATE_LABEL = {
  tripartite_review: '开工前三方会审',
  pm_confirmed: '会审结果拍板',
  dev_confirmed: '技术待确认拍板',
  dev_selfcheck: '开发四项自检',
  dev_adversarial_swept: '对抗性 bug 自查',
  human_precheck_passed: '老板最终验收',
  qa_red_calibrated: 'QA RED 校准',
  qa_passed: 'QA 通过',
  released_test: '已发测试',
  released_prod: '已发线上',
  post_release_done: '上线收尾',
}
/* ---------- 看板图标（Lucide 形状 · currentColor · 同 cards.js 口径；替代 emoji 功能键） ---------- */
const BI = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  hop:   '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  file:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  bot:   '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  chat:  '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
}
const bicon = (n, sz) => `<svg class="bi" viewBox="0 0 24 24" width="${sz || 13}" height="${sz || 13}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${BI[n] || ''}</svg>`

/* ---------- 富 popover（替代原生 title：hover 展开信息卡，跟随锚点、贴边收拢） ---------- */
let POP_REG = {}
function ensureOlpop() {
  if ($('olpop')) return
  const d = document.createElement('div'); d.id = 'olpop'; d.className = 'olpop hidden'
  document.body.appendChild(d)
  // 悬停进出弹层本体：进入取消收起（让用户能把光标移进卡里点证据链接），离开延时收起
  d.addEventListener('mouseenter', cancelHideOlpop)
  d.addEventListener('mouseleave', scheduleHideOlpop)
  // 桌面 hover（仅「可 hover」设备）：进锚点显示、离锚点（且不是移进弹层）延时收起。
  // 触屏用合成 mouseover 会让卡浮在半屏、mouseout 又不可靠，故 hover 一律用 (hover:none) 守卫，触屏改走 click（见 cov-cell onclick）。
  document.addEventListener('mouseover', e => {
    if (window.matchMedia('(hover: none)').matches) return
    const el = e.target.closest && e.target.closest('[data-pop]')
    if (el && POP_REG[el.dataset.pop]) { cancelHideOlpop(); showOlpop(el.dataset.pop, el) }
  })
  document.addEventListener('mouseout', e => {
    if (window.matchMedia('(hover: none)').matches) return
    const el = e.target.closest && e.target.closest('[data-pop]'); if (!el) return
    const to = e.relatedTarget
    if (el.contains(to)) return
    if (to && to.closest && to.closest('#olpop')) return   // 移进弹层，别收
    scheduleHideOlpop()
  })
  // 触屏：点弹层外空白处收起（点弹层内证据链接、或另一个锚点不收）
  document.addEventListener('click', e => {
    const pop = $('olpop'); if (!pop || pop.classList.contains('hidden')) return
    if (e.target.closest('#olpop') || e.target.closest('[data-pop]')) return
    hideOlpop()
  })
  // 页面滚动收起弹层——但**在弹层内部滚动不收**（facets 弹层内容超高需内部滚动，捕获阶段 scroll 若一律收起就没法滚了）
  window.addEventListener('scroll', e => {
    const t = e.target
    if (t && t.nodeType === 1 && t.closest && t.closest('#olpop')) return
    hideOlpop()
  }, true)
}
let _olpopHideT = null
function cancelHideOlpop() { clearTimeout(_olpopHideT) }
function scheduleHideOlpop() { clearTimeout(_olpopHideT); _olpopHideT = setTimeout(hideOlpop, 220) }   // 稍长的宽限：从进度条移到弹层要跨 8px 间隙，太短会中途误收
// 触屏点击开关同一锚点的弹层（再点收起）；桌面走 hover，不用它
function toggleOlpopClick(key, btn) {
  const pop = $('olpop')
  if (pop && !pop.classList.contains('hidden') && pop.dataset.key === key) { hideOlpop(); return }
  showOlpop(key, btn)
}
function showOlpop(key, anchor) {
  const pop = $('olpop'); if (!pop) return
  pop.dataset.key = key
  pop.classList.toggle('facets', String(key).startsWith('facet'))   // facets 弹层：可交互（点证据链接）+ 更宽、列表左对齐
  pop.innerHTML = POP_REG[key]
  pop.style.maxHeight = 'none'; pop.style.top = '-9999px'; pop.style.left = '0'
  pop.classList.remove('hidden')
  const M = 12, GAP = 8
  const a = anchor.getBoundingClientRect()
  // 垂直：放到锚点「上/下可用空间较大」的一侧，并把弹层限高在该侧可用空间内、内部滚动。
  // → 内容再多，弹层也永不盖住锚点（进度条/鼠标），也不超出视口（超出就内部滚），修「内容多时挡住鼠标」。
  const below = (innerHeight - a.bottom) >= a.top
  const avail = Math.max(140, (below ? innerHeight - a.bottom : a.top) - GAP - M)
  pop.style.maxHeight = avail + 'px'
  const p = pop.getBoundingClientRect()   // 受 max-height 约束后的实际尺寸
  let left = a.left
  if (left + p.width > innerWidth - M) left = innerWidth - M - p.width
  const top = below ? a.bottom + GAP : a.top - GAP - p.height
  pop.style.left = Math.max(M, left) + 'px'; pop.style.top = Math.max(M, top) + 'px'
}
function hideOlpop() { const pop = $('olpop'); if (pop) { pop.classList.add('hidden'); pop.dataset.key = '' } }
/* 距今天数（看板停滞龄期）；dstr=YYYY-MM-DD */
function daysSince(dstr) {
  if (!dstr) return null
  const d = new Date(String(dstr) + 'T00:00:00'); if (isNaN(d)) return null
  return Math.floor((Date.now() - d.getTime()) / 86400000)
}

/* D 版本派生态：从条目状态聚合「最落后条目所处阶段」——日常推进的真相（frontmatter status 退为封板/发版里程碑）。
   顺序＝流水线推进方向（越靠前越落后）；阻塞/打回视作需注意的落后态排在开发段。 */
const ENTRY_ORDER = ['待梳理', '需求确认', '待开发', '开发中', '待审', '已定稿', '阻塞', '打回', '待预检', '待复验', '待人工', '已开发', '待测', '待QA', 'QA中', '人工Pass', 'QA通过', '已上线', '已归档']
const DOT_PILL = { ok: 'success', flight: 'warn', dev: 'dev', blocked: 'danger', idle: '' }
function derivedEntry(entries) {
  if (!entries || !entries.length) return null
  const rank = s => { const i = ENTRY_ORDER.indexOf((s || '').replace(/\*\*/g, '').trim()); return i < 0 ? -1 : i }
  let worst = null
  for (const e of entries) { if (worst === null || rank(e.status) < rank(worst.status)) worst = e }
  return worst
}

/* 看板卡片折叠态：按任务档案路径记在 localStorage，刷新/轮询重渲后仍保留 */
const COLLAPSE_KEY = 'olab.collapsedTasks'
function collapsedSet() { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]')) } catch { return new Set() } }
function toggleTaskCollapse(file, el) {
  const set = collapsedSet()
  set.has(file) ? set.delete(file) : set.add(file)
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]))
  const card = el.closest('.task-card'); if (card) card.classList.toggle('collapsed', set.has(file))
}

/* ---------- facet 覆盖展示（看板卡片：需求点逐 facet 明细 + 显示层派生） ---------- */
// 覆盖状态枚举 → 徽标文案 + 配色类（GREEN=真跑绿；源码坐实/真机人工/阻断=风险处置，明显区分）
const COVERAGE_META = {
  COVERED_GREEN: { label: 'GREEN', cls: 'green' },
  SOURCE_ATTESTED: { label: '源码坐实', cls: 'source' },
  HUMAN_INHERENT: { label: '真机人工', cls: 'human' },
  BLOCKED_WITH_PROOF: { label: '阻断', cls: 'blocked' },
  UNCOVERED: { label: '未覆盖', cls: 'uncovered' },
}
// 单条 facet 行：状态徽标 + facetId + 验收标准 + （GREEN）内联证据（用例/run/用例文件，MVP 只到文本 summary）
function facetRowHtml(r) {
  const meta = COVERAGE_META[r.status] || { label: r.status || '—', cls: 'uncovered' }
  const crit = r.criterion
    ? `<span class="facet-crit" title="${esc(r.criterion)}">${mdInline(r.criterion)}</span>`
    : `<span class="facet-crit muted" title="验收标准原文来自 facet_doc，本档未解析到">—</span>`
  const redBadge = (r.status === 'COVERED_GREEN' && !r.redOk) ? `<span class="facet-red-mini" title="缺 RED 校准证据（GREEN 但反事实未验）">RED待补</span>` : ''
  // 矩阵有、facet_doc 无：迷糊临时加、尚未回写菲菲的验收标准文档，淡提示促其回写（甲：facet_doc 为全集权威）
  const unlisted = r.unlisted ? `<span class="facet-unlisted" title="该 facet 在覆盖矩阵里、但未登记进 facet_doc（验收标准）——请回写菲菲的《需求说明与验收标准》">未登记 facet_doc</span>` : ''
  // 验证通道（2026-09-10）：UI 面 facet 拿接口通道的绿 = 假绿，看板上必须一眼看见
  // （血泪：大货备货 v0.1.0 的 47 条绿全是 callApi 签的，前端从没被测过，看板却一片绿）
  const viaBadge = (r.status === 'COVERED_GREEN' && r.viaOk === false)
    ? `<span class="facet-warn" title="UI 面 facet 却由 ${esc(r.evidenceVia || '未标通道')} 通道签发——接口通道证明不了界面渲染/交互，覆盖闸门不计通过">通道不符${r.evidenceVia ? '·' + esc(r.evidenceVia) : ''}</span>`
    : ''
  let ev = ''
  if (r.status === 'COVERED_GREEN') {
    const g = r.green || {}, links = []
    const toPath = p => encodeURIComponent(String(p || '').replace(/\\/g, '/'))   // 证据路径盘上是反斜杠，/api/file 要正斜杠
    if (g.summary) links.push(`用例 <a class="facet-link" href="/api/file?path=${toPath(g.summary)}" target="_blank" rel="noopener" title="打开 summary.json">${esc(g.case || 'case')}</a>`)
    else if (g.case) links.push(`用例 ${esc(g.case)}`)
    if (g.runId) links.push(`run <code>${esc(g.runId)}</code>`)
    if (g.testFile) links.push(`<a class="facet-link" href="/api/file?path=${toPath(g.testFile)}" target="_blank" rel="noopener" title="打开用例文件">用例文件</a>`)
    const warn = r.greenOk ? '' : `<span class="facet-warn" title="证据串未通过机器校验（字段不全）">证据不全</span>`
    if (links.length || warn) ev = `<div class="facet-ev">${links.join(' · ')} ${warn}</div>`
  }
  return `<div class="facet-row">
    <span class="facet-status cov-${meta.cls}">${esc(meta.label)}</span>
    <span class="facet-fid">${esc(r.facetId)}</span>
    ${crit}${redBadge}${viaBadge}${unlisted}${ev}
  </div>`
}
// 某需求条目的 facet 覆盖：行内「进度条」（细堆叠条 + GREEN/总）＝**侧边抽屉**触发器（点击打开右侧抽屉，桌面/移动一致）。
// 抽屉里列出该需求全部 facet（含 md 验收标准 + 证据）。矩阵无该 REQ 数据则返回空壳（进度条显 —、不可点）。
const SEG_LABEL = { green: 'GREEN 真跑绿', source: '源码坐实', human: '真机人工', blocked: '阻断', uncovered: '未覆盖' }
// 缺陷条目（BUG-NNN）的 facet 挂在壳号 REQ-9NNN 下（覆盖矩阵里就是 REQ-9NNN-F*）。
// 这里必须与引擎侧 server.js·bugShellReq 同一套算法，否则看板查不到壳号 facet、进度条永远显 —。
function facetReqOf(no) {
  const raw = String(no || '').replace(/\*\*/g, '').trim().toUpperCase()
  const m = raw.match(/^BUG-0*(\d+)/i)
  return m ? 'REQ-9' + String(m[1]).padStart(3, '0').slice(-3) : raw
}
function facetParts(t, en, drawerKey) {
  const cov = t.coverage
  const empty = { has: false, cell: '<span class="cov-none" title="本条无覆盖矩阵数据">—</span>', rowsHtml: '', summary: '' }
  if (!cov || !cov.reqRollup) return empty
  const req = facetReqOf(en.no)
  const roll = cov.reqRollup[req]
  if (!roll || !roll.total) return empty
  const rows = (cov.rows || []).filter(r => r.req === req)
  const c = roll.counts
  // 堆叠条：按各状态计数占比分段，只画有量的段
  const segs = [['green', c.GREEN], ['source', c.SOURCE], ['human', c.HUMAN], ['blocked', c.BLOCKED], ['uncovered', c.UNCOVERED]]
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `<i class="facet-seg seg-${k}" style="flex:${n}" title="${n} ${SEG_LABEL[k]}"></i>`).join('')
  const extra = [c.SOURCE ? `源${c.SOURCE}` : '', c.HUMAN ? `人${c.HUMAN}` : '', c.UNCOVERED ? `未测${c.UNCOVERED}` : ''].filter(Boolean).join(' · ')
  const summary = `${c.GREEN}/${roll.total} 真跑绿${extra ? '，' + extra : ''}`
  // 进度条 = 侧边抽屉触发器（点击打开；不再 hover 浮层）
  const cell = `<button type="button" class="cov-cell" title="facet 覆盖：${esc(summary)}（点击看明细）" onclick="event.stopPropagation();openFacetDrawer('${esc(drawerKey)}')">
      <span class="facet-bar cov-cell-bar">${segs}</span>
      <span class="facet-frac"><b class="${c.GREEN ? 'has' : ''}">${c.GREEN}</b>/${roll.total}</span>
    </button>`
  const rowsHtml = `<div class="facet-rows">${rows.map(facetRowHtml).join('')}</div>`
  return { has: true, cell, rowsHtml, summary }
}

// ---------- facet 侧边抽屉（点进度条 → 右侧滑入，列出该需求全部 facet；替代原浮层，长清单可自然滚动、不遮鼠标） ----------
let FACET_REG = {}
function ensureFacetDrawer() {
  if ($('facet-drawer')) return
  const scrim = document.createElement('div'); scrim.id = 'facet-scrim'; scrim.className = 'facet-scrim'; scrim.onclick = closeFacetDrawer
  const d = document.createElement('aside'); d.id = 'facet-drawer'; d.className = 'facet-drawer'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'facet 覆盖明细')
  document.body.appendChild(scrim); document.body.appendChild(d)
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFacetDrawer() })
}
function openFacetDrawer(key) {
  ensureFacetDrawer()
  const data = FACET_REG[key]; if (!data) return
  $('facet-drawer').innerHTML = `
    <div class="fd-head">
      <div class="fd-title">
        <span class="fd-id ${data.isBug ? 'bug' : 'req'}">#${esc(data.id)}</span>
        <span class="fd-name" title="${esc(data.name)}">${esc(data.name)}</span>
      </div>
      <button class="btn ghost fd-close" onclick="closeFacetDrawer()" title="关闭 (Esc)" aria-label="关闭">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="fd-sub">facet 覆盖明细 · ${esc(data.summary)}</div>
    <div class="fd-body">${data.rowsHtml}</div>`
  $('facet-scrim').classList.add('open'); $('facet-drawer').classList.add('open')
}
function closeFacetDrawer() {
  $('facet-drawer')?.classList.remove('open'); $('facet-scrim')?.classList.remove('open')
}

async function loadTasks() {
  tasksCache = await (await fetch('/api/tasks')).json()
  const collapsed = collapsedSet()
  const taskOpts = '<option value="">（不挂任务）</option>' + tasksCache.map(t =>
    `<option value="${esc(t.file)}">${esc(t.frontmatter?.version || '')} ${esc(t.frontmatter?.task || t.file)}</option>`).join('')
  for (const selId of ['d-task', 'r-task']) {   // 轮询重建 options 时保留已选值
    const sel = $(selId), prev = sel.value
    sel.innerHTML = taskOpts
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev
  }

  ensureOlpop(); POP_REG = {}; FACET_REG = {}
  $('view-tasks').innerHTML = tasksCache.map((t, ti) => {
    const fm = t.frontmatter || {}
    const gates = Object.entries(fm.gates || {})
    // 门禁：整排彩点 + 一颗富 popover 锚（hover 出明细清单，替代逐点原生 title）
    const gatesDots = gates.map(([k, v]) => `<span class="gate ${v ? 'ok' : ''}"></span>`).join('')
    const doneN = gates.filter(([, v]) => v).length
    POP_REG['g' + ti] = `<div class="olpop-h">门禁 · ${doneN}/${gates.length} 完成</div>` +
      gates.map(([k, v]) => `<div class="olpop-row"><span class="gdot ${v ? 'ok' : ''}"></span><span class="olpop-k">${esc(GATE_LABEL[k] || k)}</span><span class="olpop-v ${v ? 'ok' : ''}">${v ? '已完成' : '未完成'}</span></div>`).join('')
    const gatesHtml = gates.length ? `<span class="gates" data-pop="g${ti}">${gatesDots}</span>` : ''
    const ownerEmp = EMPLOYEES[fm.owner]

    // 三方会审 chip（醒目、非匿名圆点）：PM 段新功能版未做→琥珀警示；已做→绿勾；其余阶段/无 gate 不显（避免旧版/补丁版噪声）
    const trGate = fm.gates ? fm.gates.tripartite_review : undefined
    const inPmStage = /^PM_/.test(fm.status || '')
    const reviewChip = trGate === true
      ? `<span class="chip review-ok" title="开工前三方会审已完成">${bicon('check', 12)}三方会审</span>`
      : (trGate === false && inPmStage)
        ? `<span class="chip review-todo" title="新功能版开工前必过三方会审（技术+测试与菲菲聊设计与实现）；未过不派 GG Bond">${bicon('alert', 12)}三方会审未做</span>`
        : ''
    // 停滞龄期：非终态任务、updated 距今 > 2 天 → 提示看板可能落后
    const isTerminal = /DONE|ARCHIVED|CLOSED/.test(fm.status || '')
    const age = daysSince(fm.updated)
    const staleChip = (!isTerminal && age != null && age >= 2)
      ? `<span class="chip stale" title="任务档案 ${age} 天未更新（updated=${esc(fm.updated || '')}）——看板可能落后于实际进展">${bicon('clock', 12)}${age} 天未更新</span>`
      : ''
    const reviewDocBtn = fm.review_doc
      ? `<button class="btn sm secondary" onclick="viewFile('${esc(fm.review_doc)}')">查看三方会审记录</button>`
      : ''

    const entries = (t.entries || []).map((en, ei) => {
      const { status, stage, dot, flight: inFlight, next } = entryState(en)
      // 操作键：条目级「接棒/指派」按老板要求删除（节省卡片空间；接棒改走版本级「下一棒」或点员工会话）。
      // 仅保留 ①待预检/待复验的「批预检」勾选框（批量流入口）②人工Pass（免QA终结）。
      const action = (inFlight && next === 'manual') ? manualActionButtons(t, ti, ei, status, en) : ''
      // 人工Pass(免QA终结)：所有在途态都给，唯独「待预检/待复验」走批量勾选流(别给易误点成终态的键——REQ-0241 血泪)。
      // 「待人工」(待发测/联调/WPS 等)必须保留人工Pass——老板亲自验收即可一键终结，勿因 next==='manual' 一刀切误伤(2026-08-06 回归修复)
      const passBtn = (inFlight && !/待预检|待复验/.test(status))
        ? `<button class="btn sm pass icon" onclick="event.stopPropagation();manualPassEntry(${ti},${ei})" title="免 QA 直接终结：我已人工验收、无需迷糊测（置人工Pass 终态）">${bicon('check', 13)}</button>`
        : ''
      // 优先级从名字尾部剥出（…｜P1）单独成列；剩余作 hero 名
      const rawName = en.name.replace(/\*\*/g, '').trim()
      const priM = rawName.match(/[｜|]\s*(P\d)\s*$/i)
      const pri = priM ? priM[1].toUpperCase() : ''
      const name = priM ? rawName.slice(0, priM.index).replace(/[｜|\s]+$/, '') : rawName
      const priHtml = pri ? `<span class="entry-pri ${pri.toLowerCase()}">${esc(pri)}</span>` : '<span class="entry-pri none"></span>'
      const statusChip = status ? `<span class="entry-status ${dot || 'idle'}">${esc(status)}</span>` : '<span class="entry-status idle">—</span>'
      // 「球在谁手里」列：员工头像+短名 / 待老板 / 已终结
      const ballHtml = !inFlight
        ? '<span class="entry-owner done">已终结</span>'
        : next === 'manual'
          ? '<span class="entry-owner boss">待老板</span>'
          : (next && EMPLOYEES[next])
            ? `<span class="entry-owner">${avatar(next, 18)}<span class="eo-name">${esc(EMPLOYEES[next].displayName)}</span></span>`
            : '<span class="entry-owner none">—</span>'
      // 需求点编号区分 REQ/缺陷：BUG 用危险红、REQ 用信息蓝；字号加大加粗（编号是重要索引）
      const isBug = /^\**\s*BUG/i.test(en.no || '')
      // facet 覆盖：进度条＝侧边抽屉触发器（点击打开右侧抽屉列出该需求全部 facet），抽屉数据注册到 FACET_REG
      const drawerKey = `facet${ti}_${ei}`
      const fp = facetParts(t, en, drawerKey)
      if (fp.has) FACET_REG[drawerKey] = { id: en.no, name, isBug, summary: fp.summary, rowsHtml: fp.rowsHtml }
      return `<div class="entry-row">
        <div class="entry-line">
          <span class="entry-dot ${dot}"></span>
          <span class="entry-id ${isBug ? 'bug' : 'req'}">#${esc(en.no)}</span>
          <span class="entry-name" title="${esc(name)}">${esc(name)}</span>
          <span class="entry-meta">
            ${priHtml}
            ${statusChip}
            <span class="entry-cov">${fp.cell}</span>
            <span class="entry-ball">${ballHtml}</span>
            <span class="entry-act">${action}${passBtn}</span>
          </span>
        </div>
      </div>`
    }).join('')

    const pend = (t.pendingDecisions || []).map(p =>
      `<div class="pending-item"><span>${esc(p.item)}</span><span class="st">${esc(p.status)}</span></div>`).join('')

    // 版本级下一棒：从工具托管状态派生（条目登记表 + gates），不再读手写「## 流程状态」（会漂，复盘 §3.58）。
    // manual 态（待老板人工）只显标签不给派工键；发测/发线上是老板 go/no-go 停靠点，给「接棒·波比」一键派。
    const vhop = versionNextHop(t)
    let stepHtml = ''
    if (vhop) {
      const emp = vhop.employee
      stepHtml = `<div class="section-label">下一棒（版本级）</div>
        <div class="next-step">
          <span class="ns-text" title="${esc(vhop.label)}">${esc(vhop.label)}</span>
          ${emp && EMPLOYEES[emp] ? `<button class="btn sm secondary" onclick="dispatchStep(${ti})">${bicon('hop', 12)}接棒 · ${esc(EMPLOYEES[emp].displayName)}</button>` : ''}
        </div>`
    }
    // 版本级 facet 汇总 chip（4.4）：复用 computeCoverage 的 byStatus/denom；hover popover 展开各状态计数 + qa_passed
    let covChipHtml = ''
    const covSum = t.coverage && t.coverage.summary
    if (covSum && covSum.denom) {
      const bs = covSum.byStatus || {}
      const g = bs.COVERED_GREEN || 0, s = bs.SOURCE_ATTESTED || 0, h = bs.HUMAN_INHERENT || 0, b = bs.BLOCKED_WITH_PROOF || 0, u = bs.UNCOVERED || 0
      const row = (k, v) => `<div class="olpop-row"><span class="olpop-k">${k}</span><span class="olpop-v">${v}</span></div>`
      POP_REG[`cov${ti}`] = `<div class="olpop-h">facet 覆盖 · 共 ${covSum.denom}${covSum.hasDoc ? '' : '（分母取自覆盖矩阵）'}</div>`
        + row('GREEN 真跑绿', g) + row('源码坐实', s) + row('真机人工', h) + (b ? row('阻断', b) : '') + (u ? row('未覆盖', u) : '')
        + `<div class="olpop-row"><span class="olpop-k">qa_passed</span><span class="olpop-v ${covSum.passed ? 'ok' : ''}">${covSum.passed ? 'true' : 'false'}</span></div>`
      // 汇总长文（绿6·源23·人6·red2）改迷你堆叠条 + GREEN/总——meta 行降噪，完整拆解仍在 hover popover
      const covSegs = [['green', g], ['source', s], ['human', h], ['blocked', b], ['uncovered', u]]
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `<i class="facet-seg seg-${k}" style="flex:${n}" title="${n}"></i>`).join('')
      covChipHtml = `<span class="cov-chip${covSum.passed ? ' passed' : ''}" data-pop="cov${ti}">
        <span class="cov-chip-label">facet</span>
        <span class="facet-bar cov-chip-bar">${covSegs}</span>
        <span class="cov-chip-frac"><b class="${g ? 'has' : ''}">${g}</b>/${covSum.denom}</span>
      </span>`
    }
    // 快捷派工头像排（临时事务：bug/杂项 直接点人）
    const quick = Object.keys(EMPLOYEES).map(k =>
      `<img class="avatar qd-av" width="24" height="24" style="width:24px;height:24px" src="${EMPLOYEES[k].avatar}" decoding="async"
        title="派给 ${esc(EMPLOYEES[k].displayName)}" onclick="event.stopPropagation();openDispatch('${k}','${esc(t.file)}')" />`).join('')

    // 健康条计数（glance 层）：按条目状态分组、按流水线顺序(ENTRY_ORDER)排，彩点由该状态 dot 决定
    const entryList = t.entries || []
    const countMap = new Map()   // status -> {n, dot}
    for (const en of entryList) {
      const s = entryState(en)
      const st = s.status || '未定'
      const cur = countMap.get(st) || { n: 0, dot: s.dot || 'idle' }
      cur.n++; countMap.set(st, cur)
    }
    const rankOf = s => { const i = ENTRY_ORDER.indexOf((s || '').replace(/\*\*/g, '').trim()); return i < 0 ? 999 : i }
    const hsCounts = [...countMap.entries()].sort((a, b) => rankOf(a[0]) - rankOf(b[0]))
      .map(([st, v]) => `<span class="hs-count"><i class="entry-dot ${v.dot}"></i>${v.n} ${esc(st)}</span>`).join('')

    // 标题拆主/副：首个「(」或「（」前是主标题、括号内是副标题（安静灰）。无括号则整串为主标题、无副标题。
    const titleRaw = String(fm.task || t.file)
    const tMatch = titleRaw.match(/^(.*?)\s*[（(]([\s\S]*)$/)
    const mainTitle = tMatch ? tMatch[1].trim() : titleRaw
    const subTitle = tMatch ? tMatch[2].replace(/[）)]\s*$/, '').trim() : ''

    return `<div class="task-card${collapsed.has(t.file) ? ' collapsed' : ''}" data-file="${esc(t.file)}">
      <div class="task-head" onclick="toggleTaskCollapse('${esc(t.file)}', this)">
        <button class="task-collapse" type="button" title="折叠 / 展开卡片" aria-label="折叠 / 展开卡片">${bicon('chevron', 16)}</button>
        <div class="task-titlewrap">
          <div class="task-title">${esc(mainTitle)}</div>
          ${subTitle ? `<div class="task-subtitle">${esc(subTitle)}</div>` : ''}
        </div>
        <span class="task-milestone">
          <span class="pill milestone" title="版本里程碑（frontmatter status，封板/发版用）"><span class="dot"></span>${esc(fm.status || '?')}</span>
          ${fm.frozen ? '<span class="pill milestone"><span class="dot"></span>已封板</span>' : ''}
        </span>
      </div>
      <div class="health-strip">
        ${entryList.length ? `<span class="hs-total">${entryList.length} 条</span><span class="hs-counts">${hsCounts}</span>` : ''}
        <span class="hs-aux">
          ${covChipHtml}
          ${ownerEmp ? `<span class="owner-chip">${avatar(fm.owner, 18)}${esc(ownerEmp.displayName)}</span>` : ''}
          ${reviewChip}
          ${staleChip}
          ${gatesHtml}
        </span>
      </div>
      <div class="task-body">
      ${entries ? `<div class="section-label">需求条目</div><div class="entry-list">${entries}</div>` : ''}
      ${stepHtml}
      ${pend ? `<div class="section-label">等你拍板 / 待办</div><div class="pending-list">${pend}</div>` : ''}
      <div class="task-foot">
        <button class="btn sm secondary" onclick="viewFile('${esc(t.file)}')">${bicon('file', 12)}查看档案</button>
        ${reviewDocBtn}
        <span class="spacer"></span>
        <span class="qd-label">派给</span>${quick}
      </div>
      </div>
    </div>`
  }).join('') || '<div class="empty">tasks/ 目录暂无任务档案</div>'
  // 批量预检：剔除已不在「待预检/待复验」态的旧选择（状态变了/条目没了），再刷底部批量条
  {
    const valid = new Set()
    for (const t of tasksCache) for (const en of (t.entries || [])) { const s = entryState(en); if (s.next === 'manual' && /待预检|待复验/.test((en.status || '').replace(/\*\*/g, ''))) valid.add(t.file + '::' + en.no) }
    for (const k of [...selEntries.keys()]) if (!valid.has(k)) selEntries.delete(k)
  }
  renderPrecheckBar()
}

/* 版本级下一棒：从工具托管状态派生（条目登记表 + gates），不读手写「## 流程状态」（会漂，复盘 §3.58）。
   ① 先取最落后条目（derivedEntry）的下一棒——覆盖 dev/预检/QA 各阶段，条目状态由 set_entry_status 工具写、准；
   ② 当所有条目已 QA 闭环 → 转版本级发布关口，据 gates 布尔位派生（发测/发线上/收尾，都是老板 go/no-go）。
   返回 {employee?, label, instruction?} 或 null（本版完成/封板 → 不显下一棒）。employee 缺省=待老板人工、无派工键。 */
const VER_CLOSED = new Set(['人工Pass', 'QA通过', '已上线', '已归档'])
function versionNextHop(t) {
  const fm = t.frontmatter || {}
  const dv = derivedEntry(t.entries)
  if (dv) {
    const st = entryState(dv)
    const nm = (dv.name || '').replace(/\*\*/g, '').trim()
    if (st.next && st.next !== 'manual' && EMPLOYEES[st.next]) {
      return {
        employee: st.next,
        label: `${EMPLOYEES[st.next].displayName}：推进最落后条目 #${dv.no} ${nm}（${st.status || '在流水线'}）`,
        instruction: `接棒版本级流水线：当前最落后条目 #${dv.no}「${nm}」状态「${st.status || dv.stage || ''}」。请按你的 SOP 推进它（及同批同阶段条目），完成后用 set_entry_status 回写条目状态与时间线。`,
      }
    }
    if (st.next === 'manual') return { label: `待老板人工预检/验收：条目 #${dv.no} ${nm}（${st.status || '待人工'}）` }
  }
  // 所有条目已 QA 闭环（或无条目）→ 版本级发布关口，据 gates 派生（gates 是发布态权威，status 会滞后不用）
  const entries = t.entries || []
  const allClosed = entries.length > 0 && entries.every(e => VER_CLOSED.has((e.status || '').replace(/\*\*/g, '').trim()))
  if (!entries.length || allClosed) {
    // 注意：封板(frozen)=特性冻结、进入发布阶段的标志，恰恰是发测→发线上→收尾这段所处的状态，
    // 不能用 frozen 短路掉发布下一棒（否则封板后正要发线上的关口会被藏掉）。是否完成一律交 gates 判。
    const g = fm.gates || {}
    const v = fm.version || ''
    if (!g.released_test) return { employee: 'bobby', label: '波比：发布测试环境（全部条目已 dev+QA 闭环）', instruction: `接棒版本级发布：v${v} 全部需求条目已 dev+QA 闭环，请发布测试环境——先按 RELEASE_CHECKLIST 逐仓库枚举本次改动、给出待部署服务清单（含端口），再走两段式发测。` }
    if (!g.released_prod) return { employee: 'bobby', label: '波比：发布线上（测试环境回归通过后）', instruction: `接棒版本级发布：v${v} 已发测，测试环境回归通过后请发布线上——枚举涉及仓库/服务、确认权限中心配置前置，按线上发布流程执行。` }
    if (!g.post_release_done) return { employee: 'bobby', label: '波比：上线后收尾（完成后通知菲菲出版本发布说明）', instruction: `接棒版本级发布：v${v} 已发线上，请做上线后收尾（回归确认/分支清理建议/docs 文档仓发布），完成后通知菲菲产出版本发布说明。` }
    return null   // 全部关口过 → 本版完成
  }
  return null
}
function dispatchStep(ti) {
  const t = tasksCache[ti]; if (!t) return
  const v = versionNextHop(t)
  if (!v || !v.employee) return
  openDispatch(v.employee, t.file, v.instruction || '接棒版本级下一棒。请按你的 SOP 执行，完成后回写任务档案。')
}

/* 人工 Pass：用户自测通过，直接标记，跳过 agent 流程 */
async function manualPass(file, payload, confirmMsg) {
  if (!confirm(confirmMsg)) return
  try {
    const r = await fetch('/api/task/manual-pass', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, ...payload }),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return alert('人工 Pass 失败：' + (d.error || r.status))
    loadTasks()   // 刷看板（fs.watch 也会推 tasks-changed，这里主动刷更即时）
  } catch (e) { alert('人工 Pass 请求异常：' + (e.message || e)) }
}
function manualPassEntry(ti, ei) {
  const t = tasksCache[ti]; if (!t) return
  const en = (t.entries || [])[ei]; if (!en) return
  const name = (en.name || '').replace(/\*\*/g, '')
  manualPass(t.file, { kind: 'entry', no: en.no },
    `确认需求 #${en.no}「${name}」由你人工验收通过、且【无需 QA】直接终结？\n\n将把该条目状态置为「人工Pass」（终态、跳过迷糊）——仅适用文案级/极简、明确免测的条目；若还要进 QA，请改点「预检通过」。`)
}

function dispatchManual(ti, ei) {
  const t = tasksCache[ti], en = (t.entries || [])[ei]; if (!en) return
  const name = (en.name || '').replace(/\*\*/g, '')
  openDispatch(null, t.file,
    `需求条目 #${en.no}「${name}」当前是人工待办（${(en.status || '').replace(/\*\*/g, '') || '待人工'}）。\n【在此说明要谁做什么】`)
}
/* 人工介入态的操作入口：待预检/待复验 → 勾选框（多选，走底部批量条一次通过/分诊）。
   其余人工待办原本给「指派」键，已按老板要求删除（节省卡片空间）——指派改走版本级「下一棒」或点员工会话。 */
function manualActionButtons(t, ti, ei, status, en) {
  if (/待预检|待复验/.test(status)) {
    const on = selEntries.has(t.file + '::' + en.no)
    return `<label class="entry-sel-wrap" onclick="event.stopPropagation()" title="勾选以批量预检（可多选：一次全部通过/分诊，不用一条条来）">
      <input type="checkbox" class="entry-sel" ${on ? 'checked' : ''} onchange="toggleSel('${esc(t.file)}','${esc(en.no)}',this.checked)"><span>批预检</span></label>`
  }
  return ''
}
/* 批量预检：多选待预检条目 → 一次全部「预检通过（置待测 + 一张交接卡交迷糊）」或「有发现（交菲菲分诊）」 */
let selEntries = new Map()   // key = file::no → {file, no}
function toggleSel(file, no, on) {
  const key = file + '::' + no
  if (on) {   // 批量限定同一任务档案（跨版本批量无意义、交接卡各自独立）——选到别的档案就先清空
    for (const k of [...selEntries.keys()]) if (!k.startsWith(file + '::')) selEntries.delete(k)
    selEntries.set(key, { file, no })
  } else selEntries.delete(key)
  renderPrecheckBar()
}
function clearSel() { selEntries.clear(); renderPrecheckBar(); loadTasks() }
function renderPrecheckBar() {
  let bar = $('precheck-bar')
  if (!bar) { bar = document.createElement('div'); bar.id = 'precheck-bar'; bar.className = 'precheck-bar hidden'; document.body.appendChild(bar) }
  const n = selEntries.size
  if (!n) { bar.classList.add('hidden'); bar.innerHTML = ''; return }
  bar.classList.remove('hidden')
  bar.innerHTML = `<span class="pb-count">已选 ${n} 条待预检</span>`
    + `<button class="btn sm primary" onclick="batchPrecheckPass()" title="全部预检通过：置待测 + 一次派 GG Bond 出一张交接卡交迷糊">${bicon('check', 12)}预检通过 · 批量交 QA</button>`
    + `<button class="btn sm secondary" onclick="batchPrecheckFinding()" title="全部有发现：一次派菲菲分诊">${bicon('alert', 12)}有发现 · 交菲菲</button>`
    + `<button class="btn ghost" onclick="clearSel()">取消</button>`
}
function selNames(file) {
  const t = tasksCache.find(x => x.file === file)
  return no => { const e = (t?.entries || []).find(en => String(en.no) === String(no)); return e ? (e.name || '').replace(/\*\*/g, '') : '' }
}
async function batchPrecheckPass() {
  const items = [...selEntries.values()]; if (!items.length) return
  const file = items[0].file, nos = items.map(i => i.no), nameOf = selNames(file)
  const list = nos.map(no => `#${no}「${nameOf(no)}」`).join('、')
  let r
  try {
    r = await fetch('/api/task/precheck', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file, nos, status: '待测', stage: '预检通过 → 待迷糊：QA' }) })
  } catch (e) { toast('批量预检请求异常：' + (e.message || e), 'bad'); return }
  if (!r.ok) {
    const raw = await r.text().catch(() => ''); let d = null; try { d = JSON.parse(raw) } catch { }
    toast(r.status === 404
      ? '批量预检接口未找到——多半是 office-lab 服务还没重启（这是新增接口，需走托盘重启加载后再试）'
      : '批量置待测失败：' + (d?.error || (r.status + ' ' + raw.slice(0, 80))), 'bad')
    return
  }
  openDispatch('ggbond', file, `以下 ${nos.length} 条条目人工预检通过、已置『待测』：${list}。\n请【一次性出一张交接卡】把这些条目连同登记表里其它已在『待测』的条目一并交迷糊（别一条条发）；交接卡逐条写清影响面/造数提示。`)
  selEntries.clear(); renderPrecheckBar()
}
function batchPrecheckFinding() {
  const items = [...selEntries.values()]; if (!items.length) return
  const file = items[0].file, nameOf = selNames(file)
  const list = items.map(i => `#${i.no}「${nameOf(i.no)}」`).join('、')
  openDispatch('feifei', file, `以下条目人工预检有发现（请把下面替换成各条目的具体现象/页面/截图位置）：${list}\n【逐条写你发现的问题】\n\n请分诊：判缺陷 vs 变更、按需更新 facet、合并需求卡增量回 GG Bond 处理后重走预检。`)
  selEntries.clear(); renderPrecheckBar()
}

/* 猜下一棒：只看阶段文字的「下一步」片段（最后一个 → 之后；无 → 则从首个「待」起），
   先精确匹配员工名，再落活动关键词；识别「待人工/待用户」时返回 'manual'（不派员工，是用户的待办） */
function guessNext(stage) {
  let seg = stage
  const arrow = stage.lastIndexOf('→')
  if (arrow >= 0) seg = stage.slice(arrow + 1)
  else { const w = stage.indexOf('待'); if (w >= 0) seg = stage.slice(w) }
  // 员工名优先（精确指名压过一切关键词）
  if (seg.includes('菲菲')) return 'feifei'
  if (seg.includes('波比')) return 'bobby'
  if (seg.includes('迷糊')) return 'mihu'
  if (seg.includes('菲斯拉')) return 'feisila'
  if (/GG Bond|ggbond/i.test(seg)) return 'ggbond'
  // 人工/用户待办 → 不派员工
  if (/待人工|人工确认|待用户|待你|待配置|待安排/.test(seg)) return 'manual'
  // 活动关键词兜底
  if (/拍板|intake|发布说明|CHANGELOG/.test(seg)) return 'feifei'
  if (/发测试|发布|上线|MR|提交|部署|封板/.test(seg)) return 'bobby'
  if (/QA|回归|用例|测试/.test(seg)) return 'mihu'
  if (/开发|修复|编码/.test(seg)) return 'ggbond'
  return null
}

/* 条目「接棒」：预填派工弹层 */
function dispatchEntry(ti, ei) {
  const t = tasksCache[ti], en = t.entries[ei]
  const stage = en.stage.replace(/\*\*/g, '')
  const name = en.name.replace(/\*\*/g, '')
  const next = guessNext(stage)
  openDispatch(next && next !== 'manual' ? next : null, t.file,
    `接棒需求条目 #${en.no}「${name}」。\n当前阶段：${stage}\n请按你的 SOP 推进本条目，完成后回写任务档案的条目登记表与时间线。`)
}

async function viewFile(rel) {
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(rel)) {   // 图片走 raw=1 按真实 MIME 显示，别当 utf8 文本读成乱码
    $('file-title').textContent = rel
    const body = $('file-body')
    body.className = 'plain-body'
    body.innerHTML = `<img src="/api/file?raw=1&path=${encodeURIComponent(rel)}" alt="" style="max-width:100%;height:auto">`
    $('file-modal').classList.remove('hidden')
    return
  }
  const resp = await fetch('/api/file?path=' + encodeURIComponent(rel))
  if (!resp.ok) { toast(`打不开文件：${rel}（${resp.status === 404 ? '文件不存在' : '读取失败'}）`, 'bad'); return }
  const text = await resp.text()
  $('file-title').textContent = rel
  const body = $('file-body')
  if (rel.endsWith('.md') && window.marked) {
    // 任务档案的 YAML frontmatter 单独渲染为属性块，正文走 marked
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
    const fmHtml = m ? `<pre class="fm-block">${esc(m[1])}</pre>` : ''
    body.className = 'md-body'
    body.innerHTML = fmHtml + marked.parse(m ? text.slice(m[0].length) : text, { gfm: true, breaks: true })
  } else {
    body.className = 'plain-body'
    body.textContent = text
  }
  $('file-modal').classList.remove('hidden')
  body.scrollTop = 0
}

/* ---------- 派工弹层 ---------- */
let dispatchDefaultEngine = 'claude'
function setupModelPicker(id, engine) {
  const input = $(id)
  $(`${id}-choices`)?.remove()
  input.style.display = ''
  if (engine !== 'codex') return
  const host = document.createElement('div'); host.id = `${id}-choices`
  const select = document.createElement('select'); select.id = `${id}-picker`; select.setAttribute('aria-label', 'Codex 模型')
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = '刷新模型列表'
  const hint = document.createElement('small'); hint.setAttribute('role', 'status')
  host.append(select, refresh, hint); input.before(host)
  let models = [], manual = false
  function render() {
    const custom = manual || (input.value && !models.some(m => m.id === input.value))
    select.replaceChildren(new Option('使用基座默认模型', 'default'), ...models.map(m => new Option(m.label === m.id ? m.id : `${m.label} (${m.id})`, `model:${m.id}`)), new Option('手动填写模型 ID', 'custom'))
    select.value = custom ? 'custom' : input.value ? `model:${input.value}` : 'default'
    input.style.display = custom ? '' : 'none'
    select.disabled = input.disabled
  }
  select.onchange = () => {
    if (input.disabled) { render(); return }
    manual = select.value === 'custom'
    if (!manual) input.value = select.value === 'default' ? '' : select.value.slice(6)
    render()
  }
  async function load(force = false) {
    if (input.disabled) return
    refresh.disabled = true; hint.textContent = '正在读取模型列表…'
    try {
      const response = await fetch(`/api/engines/codex/models${force ? '?refresh=1' : ''}`)
      if (!response.ok) throw new Error('读取失败')
      const data = await response.json()
      if ($(host.id) !== host) return
      models = data.models; render()
      hint.textContent = models.length ? '来自已保存的 Codex 配置；实际可用性取决于账号和服务配置。' : '暂无模型选项，可刷新或手动填写。'
    } catch { if ($(host.id) === host) hint.textContent = '读取失败，可刷新或手动填写模型 ID。' }
    finally { refresh.disabled = false }
  }
  refresh.onclick = () => load(true)
  render(); load()
}
function updateDispatchModelPicker() { setupModelPicker('d-model', $('d-engine').value || dispatchDefaultEngine) }
function openDispatch(employee, taskFile, instruction) {
  $('d-model').value = ''
  fetch('/api/engine-config').then(r => r.json()).then(config => {
    const select = $('d-engine'); select.replaceChildren(new Option('跟随设置', ''))
    for (const engine of config.engines) select.add(new Option(engine.label, engine.id))
    dispatchDefaultEngine = config.defaultEngine; updateDispatchModelPicker()
  }).catch(() => toast('无法读取基座设置，请检查引擎连接'))
  if (employee) pickEmployee(employee)
  else if (!pickedEmployee) pickEmployee(Object.keys(EMPLOYEES)[0])
  if (taskFile !== undefined && taskFile !== null) $('d-task').value = taskFile
  if (instruction) $('d-instruction').value = instruction
  if ($('d-guarded')) $('d-guarded').checked = false   // 守航态开关每次打开复位（防误留上一次的勾选）
  $('dispatch-modal').classList.remove('hidden')
  $('d-instruction').focus()
}
function closeDispatch() { $('dispatch-modal').classList.add('hidden') }

/* ---------- 手机推送设置 ---------- */
let engineSettings = null
async function loadEngineConfig() {
  try {
    const response = await fetch('/api/engine-config')
    if (!response.ok) throw new Error('读取基座设置失败')
    engineSettings = await response.json()
    $('engine-default').replaceChildren(...engineSettings.engines.map(e => new Option(e.label, e.id)))
    $('engine-default').value = engineSettings.defaultEngine
    const host = $('engine-providers'); host.replaceChildren()
    for (const engine of engineSettings.engines) {
      const fields = [['model', '默认模型（留空使用基座默认）']]
      if (engine.id === 'codex') fields.push(['command', 'Codex 可执行文件'], ['reasoningEffort', '思考强度（minimal / low / medium / high / xhigh）'])
      const heading = document.createElement('h4'); heading.textContent = engine.label; host.append(heading)
      for (const [key, label] of fields) {
        const row = document.createElement('div'); row.className = 'field'
        const title = document.createElement('label'); title.textContent = label
        const input = document.createElement('input'); input.id = `engine-${engine.id}-${key}`
        input.value = engineSettings.providers[engine.id]?.[key] || ''; title.htmlFor = input.id
        row.append(title, input); host.append(row)
        if (engine.id === 'codex' && key === 'model') setupModelPicker(input.id, engine.id)
      }
    }
    $('engine-result').textContent = ''
  } catch (error) { $('engine-result').textContent = error.message }
}
async function saveEngineConfig() {
  if (!engineSettings) return
  const providers = structuredClone(engineSettings.providers)
  for (const engine of engineSettings.engines) {
    for (const key of ['model', 'command', 'reasoningEffort']) {
      const input = $(`engine-${engine.id}-${key}`)
      if (input) providers[engine.id][key] = input.value.trim()
    }
  }
  try {
    const response = await fetch('/api/engine-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultEngine: $('engine-default').value, providers }) })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '保存失败')
    engineSettings = result; $('engine-result').textContent = '已保存，新会话使用新的基座设置。'
  } catch (error) { $('engine-result').textContent = error.message }
}

async function loadPushConfig() {
  let cfg = {}
  try { cfg = await (await fetch('/api/push-config')).json() } catch { }
  $('ps-enabled').checked = !!cfg.enabled
  $('ps-barkUrl').value = cfg.barkUrl || ''
  $('ps-iconBase').value = cfg.iconBase || location.origin   // 默认＝当前访问地址（手机同网即可取到头像）
  $('ps-on-done').checked = cfg.on?.done !== false
  $('ps-on-error').checked = cfg.on?.error !== false
  $('ps-on-interrupted').checked = cfg.on?.interrupted !== false
  $('ps-scope').value = cfg.scope === 'dispatch' ? 'dispatch' : 'all'
  $('ps-aiSummary').checked = cfg.aiSummary !== false
  $('ps-sound').value = cfg.sound || ''
  $('ps-approvalPush').checked = cfg.approvalPush !== false
  $('ps-labBaseUrl').value = cfg.labBaseUrl || ''
  $('ps-result').classList.add('hidden')
}
function collectPushConfig() {
  return {
    enabled: $('ps-enabled').checked,
    barkUrl: $('ps-barkUrl').value.trim(),
    iconBase: $('ps-iconBase').value.trim(),
    on: { done: $('ps-on-done').checked, error: $('ps-on-error').checked, interrupted: $('ps-on-interrupted').checked },
    scope: $('ps-scope').value,
    aiSummary: $('ps-aiSummary').checked,
    sound: $('ps-sound').value.trim(),
    approvalPush: $('ps-approvalPush').checked,
    labBaseUrl: $('ps-labBaseUrl').value.trim(),
  }
}
function showPushResult(ok, msg) {
  const el = $('ps-result')
  el.innerHTML = (ok ? bicon('check', 12) : bicon('alert', 12)) + `<span>${esc(msg)}</span>`; el.classList.add('status-hint')
  el.classList.remove('hidden')
  el.classList.toggle('bad', !ok)
}
async function savePushSettings() {
  try {
    const r = await (await fetch('/api/push-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectPushConfig()),
    })).json()
    if (r.ok) showPushResult(true, '已保存')
    else showPushResult(false, r.error || '保存失败')
  } catch (e) { showPushResult(false, String(e.message || e)) }
}
async function testPush() {
  showPushResult(true, '发送中…')
  try {
    const r = await (await fetch('/api/push-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectPushConfig()),
    })).json()
    showPushResult(!!r.ok, r.ok ? '测试推送已发送，请查看手机' : (r.message || '发送失败'))
  } catch (e) { showPushResult(false, String(e.message || e)) }
}

/* ---------- 猪猪(Zhuzhu)对接设置 ---------- */
async function loadZhuzhuConfig() {
  let cfg = {}
  try { cfg = await (await fetch('/api/zhuzhu-config')).json() } catch { }
  $('zz-enabled').checked = cfg.enabled !== false
  $('zz-baseUrl').value = cfg.baseUrl || ''
  $('zz-targetBaseUrl').value = cfg.targetBaseUrl || ''
  $('zz-docPath').value = cfg.docPath || ''
  $('zz-note').value = cfg.note || ''
  const chosen = new Set(Array.isArray(cfg.injectFor) ? cfg.injectFor : [])
  $('zz-injectFor').innerHTML = Object.entries(EMPLOYEES)
    .map(([k, e]) => `<label><input type="checkbox" class="zz-emp" value="${esc(k)}" ${chosen.has(k) ? 'checked' : ''}/> ${esc(e.displayName || k)}</label>`)
    .join('')
  $('zz-result').classList.add('hidden')
}
function collectZhuzhuConfig() {
  return {
    enabled: $('zz-enabled').checked,
    baseUrl: $('zz-baseUrl').value.trim(),
    targetBaseUrl: $('zz-targetBaseUrl').value.trim(),
    docPath: $('zz-docPath').value.trim(),
    note: $('zz-note').value.trim(),
    injectFor: [...document.querySelectorAll('#zz-injectFor .zz-emp:checked')].map(el => el.value),
  }
}
function showZzResult(ok, msg) {
  const el = $('zz-result')
  el.innerHTML = (ok ? bicon('check', 12) : bicon('alert', 12)) + `<span>${esc(msg)}</span>`; el.classList.add('status-hint')
  el.classList.remove('hidden')
  el.classList.toggle('bad', !ok)
}
function zhuzhuDocUrlFromInputs() {
  const base = $('zz-baseUrl').value.trim().replace(/\/+$/, '')
  let dp = $('zz-docPath').value.trim()
  if (dp && !dp.startsWith('/')) dp = '/' + dp
  return base + dp
}
function openZhuzhuDoc() {
  const url = zhuzhuDocUrlFromInputs()
  if (/^https?:\/\//i.test(url)) window.open(url, '_blank')
  else showZzResult(false, '基地址无效（需 http(s):// 开头）')
}
async function saveZhuzhuSettings() {
  try {
    const r = await (await fetch('/api/zhuzhu-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectZhuzhuConfig()),
    })).json()
    if (r.ok) showZzResult(true, '已保存')
    else showZzResult(false, r.error || '保存失败')
  } catch (e) { showZzResult(false, String(e.message || e)) }
}
async function testZhuzhu() {
  showZzResult(true, '连接中…')
  try {
    const r = await (await fetch('/api/zhuzhu-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectZhuzhuConfig()),
    })).json()
    showZzResult(!!r.ok, (r.message || (r.ok ? '可读' : '失败')) + (r.snippet ? `｜文档片段：${r.snippet}` : ''))
  } catch (e) { showZzResult(false, String(e.message || e)) }
}

/* ---------- 聊天记录：显式按钮 → 独立粘贴框 → 可读 block（纯展示层，随文本消息发送）----------
   为什么显式而非自动识别：后期还会有其它形式的聊天记录（不同平台/格式），要一个可扩展入口。*/
const CHATLOG_OPEN = '〘聊天记录〙', CHATLOG_CLOSE = '〘/聊天记录〙'   // 哨兵：包裹原文嵌进消息供渲染识别；人类可读、对菲菲无害
const CHATLOG_HEAD = /^(.+?)\((.+?)\)\s+(\d{1,2}\/\d{1,2})\s+(\d{1,2}:\d{2}:\d{2})\s*$/   // 企微多选复制头行：姓名(姓名) M/D HH:MM:SS

/* 沉浸式图文编辑器（写给菲菲的图文预检单）用的内联截图哨兵：包裹图片路径嵌进消息，
   前端据此把图片按顺序内联渲染（图文交错）；对菲菲即「此处一张截图，路径如下，请 Read」。*/
const SHOT_OPEN = '〖截图〗', SHOT_CLOSE = '〖/截图〗'
const SHOT_RE = () => new RegExp(SHOT_OPEN + '([\\s\\S]*?)' + SHOT_CLOSE, 'g')
const IMMERSIVE_LEAD = '（人工预检发现，正文穿插截图；每个〖截图〗标记内是图片路径，请逐张用 Read 工具查看）'

// 解析企微多选复制格式；解析不出（<2 条）则标 raw，原文照样保留、不丢内容
function parseChatlog(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n')
  const entries = []
  let cur = null
  for (const ln of lines) {
    const m = ln.match(CHATLOG_HEAD)
    if (m) { cur = { sender: m[1].trim(), date: m[3], time: m[4], text: '' }; entries.push(cur) }
    else if (cur) cur.text += (cur.text ? '\n' : '') + ln
  }
  entries.forEach(e => { e.text = e.text.trim() })
  const ok = entries.length >= 2
  const participants = [...new Set(entries.map(e => e.sender))]
  const dates = entries.map(e => e.date)
  const span = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]}–${dates[dates.length - 1]}`) : ''
  return { format: ok ? 'wecom-multiselect' : 'raw', raw: String(raw || ''), entries: ok ? entries : [], meta: { count: ok ? entries.length : 0, participants, span } }
}

// 聊天记录富编辑器：contenteditable，可粘贴/拖入/添加截图（图文按聊天顺序穿插），序列化成含 〖截图〗 哨兵的 raw
let chatlogRange = null, chatlogPending = 0
function buildChatlogRaw() { return serializeRichEditor($('chatlog-input')) }
function openChatlogPaste() {
  $('chatlog-input').innerHTML = ''
  chatlogRange = null; chatlogPending = 0
  updateChatlogPreview()
  $('chatlog-modal').classList.remove('hidden')
  $('chatlog-input').focus()
}
function closeChatlogPaste() { $('chatlog-modal').classList.add('hidden') }
function updateChatlogPreview() {
  const raw = buildChatlogRaw()
  const el = $('chatlog-preview')
  const imgN = (raw.match(SHOT_RE()) || []).length
  const imgSuffix = imgN ? ` · 含 ${imgN} 张图` : ''
  if (!raw.trim()) { el.textContent = '把企业微信/群里「多选复制」的聊天记录粘到这里；截图可直接粘/拖入。'; return }
  const p = parseChatlog(raw)
  el.textContent = (p.format === 'raw'
    ? '没识别出标准格式，会作为整段「聊天记录」原文保留（不影响菲菲阅读）。'
    : `识别到 ${p.meta.count} 条 · 参与人 ${p.meta.participants.join('、')} · ${p.meta.span}`) + imgSuffix
}
function confirmChatlog() {
  if (chatlogPending > 0) { toast('截图还在上传，稍等一下', 'warn'); return }
  const raw = buildChatlogRaw().trim()
  if (!raw) { $('chatlog-input').focus(); return }
  pendingChatlogs.push(parseChatlog(raw))
  renderAttach()
  closeChatlogPaste()
  $('reply-text').focus()
}

/* ---------- 企微渠道设置（菲菲对外答疑 sidecar）---------- */
async function loadWecomConfig() {
  let cfg = {}
  try { cfg = await (await fetch('/api/wecom-config')).json() } catch { }
  $('wc-enabled').checked = !!cfg.enabled
  $('wc-botId').value = cfg.botId || ''
  $('wc-botSecret').value = ''
  $('wc-botSecret').placeholder = cfg.botSecretSet ? '已配置，留空则不修改' : '企微智能机器人 Secret'
  $('wc-ragApiUrl').value = cfg.ragApiUrl || 'http://127.0.0.1:8001'
  $('wc-wsUrl').value = cfg.wsUrl || ''
  $('wc-welcome').value = cfg.welcome || ''
  $('wc-kbDefault').value = (cfg.kbDailyQuotaDefault ?? 20)
  $('wc-kbWhitelist').checked = !!cfg.kbWhitelistOnly
  renderWecomUsers(cfg.users, cfg.userAliases)
  loadWecomKnownUsers()
  $('wc-result').classList.add('hidden')
  await refreshWecomStatus()
}
// 已对话用户：列出真正跟菲菲聊过的企微 userid（来自会话记录），支持一键预填进成员名单。
async function loadWecomKnownUsers() {
  const host = $('wc-known-users'); if (!host) return
  let list = []
  try { list = await (await fetch('/api/wecom/known-users')).json() } catch { }
  if (!Array.isArray(list) || !list.length) {
    host.innerHTML = '<div class="empty" style="padding:6px 0">还没有企微用户跟菲菲对话过。</div>'
    return
  }
  host.innerHTML = list.map(u => {
    const named = u.name && u.name !== u.userid
    const when = (u.lastTs || '').slice(5, 16).replace('T', ' ')
    const meta = `× ${u.count} 条${when ? ' · ' + esc(when) : ''}`
    const snippet = u.lastText ? `<div class="wc-ku-snippet">${esc(u.lastText)}</div>` : ''
    const right = u.inList
      ? '<span class="wc-ku-in">✓ 已在名单</span>'
      : `<button type="button" class="btn ghost wc-ku-add" onclick="joinWecomList('${esc(u.userid)}', this)">＋ 加入名单</button>`
    return `<div class="wc-ku-row">
      <div class="wc-ku-main">
        <div class="wc-ku-id">${named ? esc(u.name) + ' · ' : ''}<code>${esc(u.userid)}</code></div>
        <div class="wc-ku-meta">${meta}</div>${snippet}
      </div>${right}
    </div>`
  }).join('')
}
// 一键加入名单：把该 userid 预填成一行成员（未持久化，需点保存）；避免重复添加。
function joinWecomList(uid, btn) {
  const exists = [...document.querySelectorAll('#wc-users .wc-u-id')].some(i => i.value.trim() === uid)
  if (!exists) addWecomUserRow(uid, '', null)
  if (btn) { btn.textContent = '已添加，记得保存'; btn.disabled = true; btn.classList.add('wc-ku-added') }
  const last = $('wc-users').lastElementChild
  if (last) { last.querySelector('.wc-u-name')?.focus(); last.scrollIntoView({ block: 'nearest' }) }
}
// 渲染成员名单行；users 为空时回落 legacy userAliases（{userid:name}）迁移显示
function renderWecomUsers(users, legacyAliases) {
  let map = (users && typeof users === 'object' && Object.keys(users).length) ? users : null
  if (!map && legacyAliases && typeof legacyAliases === 'object') {
    map = {}
    for (const [uid, name] of Object.entries(legacyAliases)) map[uid] = { name, kbDailyQuota: null }
  }
  $('wc-users').innerHTML = ''
  for (const [uid, rec] of Object.entries(map || {})) addWecomUserRow(uid, rec && rec.name, rec && rec.kbDailyQuota)
}
function addWecomUserRow(uid = '', name = '', quota = null) {
  const row = document.createElement('div')
  row.className = 'wc-user-row'
  row.innerHTML = `<input type="text" class="wc-u-id" placeholder="userid" value="${esc(uid)}" />`
    + `<input type="text" class="wc-u-name" placeholder="备注名" value="${esc(name || '')}" />`
    + `<input type="number" class="wc-u-quota" min="0" step="1" placeholder="默认" value="${(quota == null ? '' : esc(quota))}" />`
    + `<button type="button" class="btn ghost wc-u-del" onclick="this.parentNode.remove()" title="删除">✕</button>`
  $('wc-users').appendChild(row)
}
const WC_CONN_TXT = { authenticated: '已连接企微（认证成功）', connected: '已建立连接，认证中…', reconnecting: '重连中…', disconnected: '连接已断开', error: '连接出错' }
async function refreshWecomStatus() {
  try {
    const s = await (await fetch('/api/wecom-status')).json()
    let txt
    if (!s.enabled) txt = '状态：未启用'
    else if (!s.shouldRun) txt = '状态：已启用但缺 BotID/Secret，未连接'
    else if (s.running) {
      const conn = WC_CONN_TXT[s.connState] || '进程运行中，等待企微连接…'
      txt = `状态：运行中（pid ${s.pid}）｜${conn}` + (s.connDetail && (s.connState === 'error' || s.connState === 'disconnected') ? `：${s.connDetail}` : '')
    }
    else txt = '状态：未运行' + (s.lastError ? `｜${s.lastError}` : '（拉起中…）')
    $('wecom-status').textContent = txt
  } catch { $('wecom-status').textContent = '' }
}
function collectWecomConfig() {
  // 从成员行收集：userid → { name, kbDailyQuota }（额度留空=null，用全局默认）
  const users = {}
  for (const row of document.querySelectorAll('#wc-users .wc-user-row')) {
    const uid = row.querySelector('.wc-u-id').value.trim()
    if (!uid) continue
    const q = row.querySelector('.wc-u-quota').value.trim()
    const quota = Number(q)
    users[uid] = {
      name: row.querySelector('.wc-u-name').value.trim(),
      kbDailyQuota: (q !== '' && Number.isFinite(quota) && quota >= 0) ? quota : null,
    }
  }
  const def = Number($('wc-kbDefault').value)
  const o = {
    enabled: $('wc-enabled').checked,
    botId: $('wc-botId').value.trim(),
    ragApiUrl: $('wc-ragApiUrl').value.trim(),
    wsUrl: $('wc-wsUrl').value.trim(),
    welcome: $('wc-welcome').value.trim(),
    users,
    kbDailyQuotaDefault: Number.isFinite(def) && def >= 0 ? def : 20,
    kbWhitelistOnly: $('wc-kbWhitelist').checked,
  }
  const sec = $('wc-botSecret').value.trim()
  if (sec) o.botSecret = sec   // 留空则不传，后端保留原值
  return o
}
function showWcResult(ok, msg) {
  const el = $('wc-result')
  el.innerHTML = (ok ? bicon('check', 12) : bicon('alert', 12)) + `<span>${esc(msg)}</span>`; el.classList.add('status-hint')
  el.classList.remove('hidden')
  el.classList.toggle('bad', !ok)
}
async function saveWecomSettings() {
  try {
    const r = await (await fetch('/api/wecom-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectWecomConfig()),
    })).json()
    if (r.ok) {
      $('wc-botSecret').value = ''
      setTimeout(refreshWecomStatus, 1200)   // sidecar 重启后刷新状态
      showWcResult(true, '已保存' + (r.config?.enabled ? '，正在应用（sidecar 重启中）' : ''))
    } else showWcResult(false, r.error || '保存失败')
  } catch (e) { showWcResult(false, String(e.message || e)) }
}
async function testWecom() {
  showWcResult(true, '连接中…')
  try {
    const r = await (await fetch('/api/wecom-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ragApiUrl: $('wc-ragApiUrl').value.trim() }),
    })).json()
    showWcResult(!!r.ok, 'RAG：' + (r.message || (r.ok ? '可达' : '失败')))
  } catch (e) { showWcResult(false, String(e.message || e)) }
}
async function testWecomConnect() {
  showWcResult(true, '正在连企微验证凭证…（最多约 20 秒）')
  try {
    const sec = $('wc-botSecret').value.trim()
    const body = { botId: $('wc-botId').value.trim(), wsUrl: $('wc-wsUrl').value.trim() }
    if (sec) body.botSecret = sec   // 留空则用已保存的 Secret
    const r = await (await fetch('/api/wecom-connect-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json()
    showWcResult(!!r.ok, '企微：' + (r.message || (r.ok ? '连通正常' : '失败')))
    refreshWecomStatus()
  } catch (e) { showWcResult(false, String(e.message || e)) }
}

/* ---------- 飞书需求表设置 ---------- */
async function loadLarkConfig() {
  let cfg = {}
  try { cfg = await (await fetch('/api/lark-config')).json() } catch { }
  $('lk-appId').value = cfg.appId || ''
  $('lk-appSecret').value = ''
  $('lk-appSecret').placeholder = cfg.appSecretSet ? '已配置，留空则不修改' : '飞书自建应用 app_secret'
  $('lk-appToken').value = cfg.appToken || ''
  $('lk-tableId').value = cfg.tableId || ''
  const st = cfg.credsFromEnv ? '凭证来自环境变量（env 优先）' : (cfg.credsReady ? '凭证已配置' : '未配置凭证')
  $('lark-status').textContent = `状态：${st}｜${cfg.configured ? '已就绪' : '未就绪（缺凭证或 base/table）'}`
  $('lark-result').classList.add('hidden')
}
function collectLarkConfig() {
  // 只收凭证 + base/table；字段不再手配（菲菲自己决定，后端自动识别兜底快速登记）
  const o = {
    appId: $('lk-appId').value.trim(),
    appToken: $('lk-appToken').value.trim(),
    tableId: $('lk-tableId').value.trim(),
  }
  const sec = $('lk-appSecret').value.trim()
  if (sec) o.appSecret = sec   // 留空则不传，后端保留原值
  return o
}
function showLarkResult(ok, msg) {
  const el = $('lark-result')
  el.innerHTML = (ok ? bicon('check', 12) : bicon('alert', 12)) + `<span>${esc(msg)}</span>`; el.classList.add('status-hint')
  el.classList.remove('hidden')
  el.classList.toggle('bad', !ok)
}
async function saveLarkSettings() {
  try {
    const r = await (await fetch('/api/lark-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectLarkConfig()),
    })).json()
    if (r.ok) { $('lk-appSecret').value = ''; showLarkResult(true, '已保存' + (r.config?.configured ? '（已就绪）' : '（还缺凭证或 base/table）')) }
    else showLarkResult(false, r.error || '保存失败')
  } catch (e) { showLarkResult(false, String(e.message || e)) }
}
async function larkListFields() {
  showLarkResult(true, '拉取字段中…')
  try {
    // 先存一下当前凭证/表，保证 introspect 用的是最新输入
    await fetch('/api/lark-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectLarkConfig()) })
    const r = await (await fetch('/api/lark/fields')).json()
    if (r.ok) {
      const a = r.auto || {}
      const autoLine = `自动识别 → 需求:「${a.summary || '未识别'}」· 状态:「${a.status || '未识别'}」=「${a.statusPending || '待处理'}」· 提出人:「${a.proposer || '—'}」· 时间:「${a.proposeTime || '—'}」`
      const tail = (a.summary && a.status) ? `　｜表字段：${r.fields.map(f => f.name).join('、')}` : '　关键字段没识别到，请在上方手动覆盖'
      showLarkResult(!!(a.summary && a.status), autoLine + tail)
    }
    else showLarkResult(false, r.message || '拉取失败')
  } catch (e) { showLarkResult(false, String(e.message || e)) }
}

/* ---------- 企微镜像设置（飞书主表 → 企微 Webhook 只读投影）---------- */
async function loadWecomMirrorConfig() {
  let cfg = {}
  try { cfg = await (await fetch('/api/wecom-mirror-config')).json() } catch { }
  $('wxm-enabled').checked = !!cfg.enabled
  $('wxm-webhookUrl').value = ''
  $('wxm-webhookUrl').placeholder = cfg.webhookUrlSet ? '已配置，留空则不修改' : '粘贴企微工作表 Webhook 地址'
  $('wxm-syncMin').value = cfg.syncMin || 3
  const lark = cfg.larkReady ? '飞书主表已就绪' : '⚠ 飞书主表未配置（镜像没有数据源）'
  const last = cfg.lastSyncAt ? `上次同步 ${new Date(cfg.lastSyncAt).toLocaleString()}` : '尚未同步'
  const err = cfg.lastError ? `｜上次出错：${cfg.lastError}` : ''
  $('wxm-status').textContent = `状态：${cfg.enabled ? '已启用' : '未启用'}｜${lark}｜${last}${err}`
  $('wxm-result').classList.add('hidden')
}
function collectWecomMirrorConfig() {
  const o = {
    enabled: $('wxm-enabled').checked,
    syncMin: Math.max(1, parseInt($('wxm-syncMin').value, 10) || 3),
  }
  const url = $('wxm-webhookUrl').value.trim()
  if (url) o.webhookUrl = url   // 留空则不传，后端保留原值
  return o
}
function showWecomMirrorResult(ok, msg) {
  const el = $('wxm-result')
  el.innerHTML = (ok ? bicon('check', 12) : bicon('alert', 12)) + `<span>${esc(msg)}</span>`; el.classList.add('status-hint')
  el.classList.remove('hidden')
  el.classList.toggle('bad', !ok)
}
async function saveWecomMirrorSettings() {
  try {
    const r = await (await fetch('/api/wecom-mirror-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectWecomMirrorConfig()),
    })).json()
    if (r.ok) { $('wxm-webhookUrl').value = ''; showWecomMirrorResult(true, '已保存' + (r.config?.enabled ? (r.config?.webhookUrlSet ? '（已启用）' : '（启用了但还缺 Webhook 地址）') : '（未启用）')); loadWecomMirrorConfig() }
    else showWecomMirrorResult(false, r.error || '保存失败')
  } catch (e) { showWecomMirrorResult(false, String(e.message || e)) }
}
async function wecomMirrorSyncNow() {
  showWecomMirrorResult(true, '同步中…')
  try {
    // 先存一下当前表单（开关/频率/地址），保证同步用最新配置
    await fetch('/api/wecom-mirror-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectWecomMirrorConfig()) })
    const r = await (await fetch('/api/wecom-mirror/sync', { method: 'POST' })).json()
    await loadWecomMirrorConfig()   // 先刷新状态/上次同步（它会隐藏结果条），再显示结果，避免提示一闪即隐
    if (r.skipped) showWecomMirrorResult(false, `没同步：${r.reason || '未启用或缺配置'}`)
    else if (r.ok) showWecomMirrorResult(!r.failed, r.failed ? `已同步 ${r.count} 行，${r.failed} 行失败${r.error ? '：' + r.error : ''}` : `已同步 ${r.count} 行到企微`)
    else showWecomMirrorResult(false, r.error || '同步失败')
  } catch (e) { showWecomMirrorResult(false, String(e.message || e)) }
}
// 重置映射并全量重传：清空本地「飞书↔企微」映射 → 全表按状态排序重新 add。企微 webhook 删不了行，须先手动清空企微表，否则叠加重复。
async function wecomMirrorResetNow() {
  const ok = confirm('重置并全量重传\n\n会清空本地「飞书↔企微」映射，然后把飞书所有行按状态（处理中→待处理→已完成→拒绝）排序重新写入企微。\n\n⚠ 企微 Webhook 删不了行——请先在企业微信里把镜像表所有行手动删光，再点确定；否则会在旧行之上叠加出重复行、且清不掉。\n\n已清空企微表、确定重传？')
  if (!ok) return
  showWecomMirrorResult(true, '重置并全量重传中…')
  try {
    await fetch('/api/wecom-mirror-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(collectWecomMirrorConfig()) })
    const r = await (await fetch('/api/wecom-mirror/reset', { method: 'POST' })).json()
    await loadWecomMirrorConfig()   // 先刷新状态（会隐藏结果条）再显示结果，避免一闪即隐
    if (r.skipped) showWecomMirrorResult(false, `没重传：${r.reason || '未启用或缺配置'}`)
    else if (r.ok) showWecomMirrorResult(!r.failed, `已清空 ${r.cleared || 0} 条旧映射并重传 ${r.count} 行${r.failed ? `，${r.failed} 行失败${r.error ? '：' + r.error : ''}` : ''}`)
    else showWecomMirrorResult(false, r.error || '重传失败')
  } catch (e) { showWecomMirrorResult(false, String(e.message || e)) }
}

async function submitDispatch() {
  const instruction = $('d-instruction').value.trim()
  if (!instruction || !pickedEmployee) return
  $('d-submit').disabled = true
  try {
    const guarded = $('d-guarded') && $('d-guarded').checked   // 全时双态：勾选=守航态派工（executionMode 沿交接链传播）
    const resp = await fetch('/api/dispatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee: pickedEmployee, taskFile: $('d-task').value || null, instruction, engine: $('d-engine').value || undefined, model: $('d-model').value.trim() || undefined, ...(guarded ? { executionMode: 'guarded_run' } : {}) }),
    })
    const r = await resp.json().catch(() => ({}))
    // 并发闸：该员工已有在跑的会话 → 不新派，提示先等收工/停止（保留弹层与指令，便于稍后重派）
    if (resp.status === 409 && r.error === 'employee busy') {
      toast(`${r.displayName || '该员工'} 正在跑另一条会话，先等它收工、或在该会话里「停止」后再派（避免并发改同一工作树）`, 'warn')
      return
    }
    $('d-instruction').value = ''
    closeDispatch()
    await loadRuns()
    if (r.runId) openRun(r.runId)
  } finally { $('d-submit').disabled = false }
}

/* ---------- 员工实时状态（Lucide 图标形状 + CSS 动画，随 loadRuns 5s 轮询刷新） ----------
   状态枚举：working 工作中 / question 等你拍板·有疑问 / done 已收工 / error 出错 / interrupted 已中断 / idle 无 */
const EMP_ST_ICONS = {
  working: ['st-working st-dots', '工作中…', ''],
  'working-bg': ['st-background st-dots', '本轮收工，后台任务仍在跑（结果回来自动接着做）', ''],
  question: ['st-question st-pulse', '收工了，有事项等你拍板/回复', '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'],
  done: ['st-done', '已收工', '<path d="M20 6 9 17l-5-5"/>'],
  error: ['st-error', '上次运行出错', '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'],
  interrupted: ['st-idle', '上次运行被中断', '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>'],
}
// 单条 run 的状态归类
function runStatus(r) {
  if (r.status === 'running' || r.status === 'starting') return 'working'
  if (r.status === 'error') return 'error'
  if (r.status === 'interrupted') return 'interrupted'
  if (r.status === 'done') {
    if (r.bgTasks && r.bgTasks.length) return 'working-bg'   // 本轮收工但后台任务仍在跑 → 「后台运行中」，别显示成空闲/已收工
    const tail = (r.result || '').slice(-500)
    // 优先认机器可读标记（工牌规定收工汇报最后一行：【等你拍板】无 / 【等你拍板】<事项>）
    const marks = [...tail.matchAll(/【等你拍板】\s*(\S[^\n]*)/g)]
    if (marks.length) return /^无/.test(marks[marks.length - 1][1].trim()) ? 'done' : 'question'
    // 旧格式汇报兜底：语义线索启发
    return /等你|待你|需要你|请.{0,6}(拍板|确认|回复)|吗？|？$/m.test(tail) ? 'question' : 'done'
  }
  return null
}
// 最近活动时间：优先 updatedAt（收发消息/收工时刷新），回退 startedAt
function runActivity(r) { return r.updatedAt || r.startedAt || '' }
// 员工的「代表会话」：有在跑的取最近在跑那条；否则取最近活动的那条。
// 徽标状态与「点员工进入的会话」都以它为准，保证「显示什么状态 = 点进去就是那条」。
// 只看这一条、不扫全部历史——否则老话题结尾文字命中「等你拍板」会把员工永久顶成待拍板。
function empRepRun(k) {
  // 排除只读咨询窗（run.consult，新 UI 的入口才能开）：它不代表员工在干活，算进来会把空闲员工显示成「工作中」
  const runs = runsCache.filter(r => r.employee === k && !r.consult)
  if (!runs.length) return null
  const active = runs.filter(r => r.status === 'running' || r.status === 'starting')
  const pool = active.length ? active : runs
  return pool.reduce((a, b) => (runActivity(b) > runActivity(a) ? b : a))
}
function empState(k) {
  const run = empRepRun(k)
  if (!run) return null
  const status = runStatus(run)
  return status ? { status, run } : null
}
function renderEmpStatus() {
  for (const k of Object.keys(EMPLOYEES)) {
    if (k === 'chaorenq') continue   // 巡视员状态用雷达渲染（renderPatrolRadar），不走通用徽标
    const badge = $(`emp-st-${k}`), act = $(`emp-act-${k}`)
    if (!badge) continue
    const state = empState(k)
    if (!state) { badge.classList.add('hidden') }
    else {
      const [cls, tip, path] = EMP_ST_ICONS[state.status]
      badge.className = `emp-badge ${cls.split(' ')[0]}`
      badge.title = tip
      badge.innerHTML = cls.includes('st-dots')
        ? '<span class="st-dots"><i></i><i></i><i></i></span>'
        : `<svg class="${cls.includes('st-spin') ? 'st-spin' : cls.includes('st-pulse') ? 'st-pulse' : ''}" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
    }
    if (act) {
      const rep = state?.run
      if (!rep) { act.textContent = '空闲 · 点我开聊'; act.className = 'emp-l2' }
      else {
        const snippet = clean((rep.instruction || '').replace(/^【派工】/, '').replace(/任务档案：\S+\s*/, '')).slice(0, 20)
        const working = state.status === 'working'
        const bg = state.status === 'working-bg'
        const live = working ? liveActivity[k] : ''
        if (!working) delete liveActivity[k]
        if (bg) {
          const n = rep.bgTasks.length
          const d = clean(rep.bgTasks[0].desc || rep.bgTasks[0].type || '').slice(0, 16)
          act.textContent = `后台运行中：${d || '任务'}${n > 1 ? ` 等${n}项` : ''}`
          act.className = 'emp-l2 busy bg'
        } else {
          act.textContent = live ? '正在：' + live : (working ? '正在：' : '') + (snippet || '（无摘要）')
          act.className = 'emp-l2' + (working ? ' busy' : '')
        }
        act.title = rep.instruction || ''
      }
    }
    // 待处理队列徽标 + 活动行提示（跨线程消息扣在队列里，忙完当前会话后单独起会话处理）
    const qb = $(`emp-q-${k}`), pend = pendingCache[k] || []
    if (qb) {
      if (pend.length) { qb.textContent = pend.length; qb.classList.remove('hidden'); qb.title = `${pend.length} 条待处理消息（点看详情）` }
      else { qb.classList.add('hidden'); if (_pendingPopFor === k) closePendingList() }
    }
    if (act && pend.length) {
      const busyTxt = act.className.includes('busy')
      if (busyTxt) act.textContent = act.textContent + ` · ${pend.length} 条待处理`
      else { act.textContent = `${pend.length} 条待处理，忙完即接`; act.className = 'emp-l2 pend' }
    }
  }
  renderPatrolRadar()
}

/* ---------- 待处理队列：侧边栏徽标点开的小浮层（来自谁 / 类型 / 摘要 / 时间） ---------- */
let _pendingPopFor = null
const PEND_KIND_LABEL = { cc: '抄送', return: '交回', forward: '派活' }
async function loadPending() {
  try { pendingCache = await (await fetch('/api/pending')).json() || {} } catch { pendingCache = {} }
}
function togglePendingList(k, e) {
  if (_pendingPopFor === k) { closePendingList(); return }
  showPendingList(k, e)
}
function showPendingList(k, e) {
  _pendingPopFor = k
  let pop = $('pending-pop')
  if (!pop) { pop = document.createElement('div'); pop.id = 'pending-pop'; pop.className = 'pending-pop'; document.body.appendChild(pop) }
  renderPendingList(k)
  const badge = (e && e.currentTarget) || $(`emp-q-${k}`)
  const r = badge ? badge.getBoundingClientRect() : { left: 60, bottom: 120 }
  pop.style.left = Math.round(r.left) + 'px'
  pop.style.top = Math.round(r.bottom + 6) + 'px'
  pop.classList.remove('hidden')
  setTimeout(() => document.addEventListener('click', _pendingOutside, { once: true }), 0)
}
function _pendingOutside(ev) {
  const pop = $('pending-pop')
  if (pop && !pop.contains(ev.target) && !(ev.target.className || '').includes('emp-queue-badge')) closePendingList()
}
function closePendingList() { _pendingPopFor = null; const pop = $('pending-pop'); if (pop) pop.classList.add('hidden') }
function renderPendingList(k) {
  const pop = $('pending-pop'); if (!pop) return
  const items = pendingCache[k] || []
  const name = EMPLOYEES[k]?.displayName || k
  if (!items.length) { pop.innerHTML = `<div class="pending-pop-hd">${esc(name)} · 待处理队列</div><div class="pending-empty">队列已清空</div>`; return }
  pop.innerHTML = `<div class="pending-pop-hd">${esc(name)} · 待处理队列（${items.length}）</div>` + items.map(it => {
    const from = EMPLOYEES[it.from]?.displayName || it.from || '?'
    return `<div class="pending-item">
      <div class="pending-item-top"><span class="pending-kind ${it.kind}">${PEND_KIND_LABEL[it.kind] || it.kind}</span><span class="pending-from">来自 ${esc(from)}</span><span class="pending-ts">${relTime(it.ts)}</span></div>
      <div class="pending-text">${esc((it.text || '').slice(0, 160))}</div>
    </div>`
  }).join('')
}

/* 小呆呆巡视雷达：巡视中(快扫+红ping) / 在岗待命(慢扫+下次倒计时) / 打烊(灯灭)。数据 = patrolStatus + runsCache。 */
// 名牌上的小状态点 + 活动行文案（主秀让给巡检光标 patrolRoam）
function patrolState() {
  const ps = patrolStatus || {}
  const activeRun = ps.active || runsCache.some(r => r.employee === 'chaorenq' && (r.status === 'running' || r.status === 'starting'))
  if (ps.enabled === false) return { state: 'off', txt: '打烊 · 暂不巡视' }
  if (activeRun) return { state: 'active', txt: '正在巡视…' }
  const mins = ps.nextSweepAt ? Math.max(0, Math.round((ps.nextSweepAt - Date.now()) / 60000)) : null
  return { state: 'on', txt: '在岗巡逻' + (mins == null ? '' : (mins <= 0 ? ' · 即将巡逻' : ` · 下次 ~${mins} 分`)) }
}
function renderPatrolRadar() {
  const dot = $('patrol-dot'), act = $('emp-act-chaorenq')
  const { state, txt } = patrolState()
  if (dot) { dot.className = `patrol-dot ${state}`; dot.title = txt }
  if (act) { act.textContent = txt; act.className = 'emp-l2' + (state === 'active' ? ' busy' : '') }
  patrolRoam()
}
// 巡检动画：从小呆呆头像向外扩散圆形涟漪（不拘上下、向四周散开）。在岗＝慢而淡 / 正在巡查＝快而亮 / 打烊＝无。
function patrolRoam() {
  const ps = patrolStatus || {}
  const aura = $('patrol-aura'), rip = $('patrol-ripple')
  const state = ps.enabled === false ? 'off' : (ps.active ? 'active' : 'on')
  if (aura) aura.className = 'patrol-aura ' + state
  if (rip) rip.className = 'patrol-ripple ' + state
}
// 巡查一开始（SSE patrol-* 事件）就放一段大波涟漪 burst ~5s，不依赖 5s 轮询抓那短暂 active 窗口；结束后回到实际状态。
let _patrolBurstT = null
function patrolBurst() {
  const rip = $('patrol-ripple'), aura = $('patrol-aura')
  if (rip) rip.className = 'patrol-ripple active'
  if (aura) aura.className = 'patrol-aura active'
  clearTimeout(_patrolBurstT)
  _patrolBurstT = setTimeout(patrolRoam, 5000)
}

/* ---------- 小呆呆接管倒计时横幅（巡视宽限窗）----------
   引擎在聊天会话空停时延后派巡视，期间广播 patrol-pending{deadline}；本横幅只**按 deadline 渲染**倒计时、
   自己不计时（多端一致）。老板点「取消接管」或直接回话 → 引擎撤销并广播 patrol-cancelled；走完窗口 → patrol-detected。*/
let _patrolBannerRAF = null, _patrolBannerRun = null
function patrolName() { return EMPLOYEES.chaorenq?.displayName || '小呆呆' }
function stopPatrolBannerTick() { if (_patrolBannerRAF) cancelAnimationFrame(_patrolBannerRAF); _patrolBannerRAF = null }
function hidePatrolBanner() {
  stopPatrolBannerTick(); _patrolBannerRun = null
  const el = $('patrol-banner'); if (!el) return
  el.classList.add('hidden'); el.classList.remove('ending', 'closing'); el.innerHTML = ''
}
// 终态动画：切一小段收尾文案后淡出（mode: 'taken' 已接管上浮 / 'cancelled' 已取消微弹 / 'reply' 回话左滑）
function finishPatrolBanner(mode, text) {
  stopPatrolBannerTick(); _patrolBannerRun = null
  const el = $('patrol-banner'); if (!el || el.classList.contains('hidden')) return
  el.classList.remove('ending'); el.classList.add('closing', `close-${mode}`)
  el.innerHTML = `<div class="pb-row"><span class="pb-final pb-final-${mode}"></span><span class="pb-msg">${esc(text)}</span></div>`
  setTimeout(() => { if (el.classList.contains(`close-${mode}`)) { el.classList.add('hidden'); el.classList.remove('closing', `close-${mode}`); el.innerHTML = '' } }, 1100)
}
function showPatrolBanner(runId, deadline, graceSec) {
  const el = $('patrol-banner'); if (!el || runId !== currentRun) return
  _patrolBannerRun = runId
  const total = Math.max(1000, (Number(graceSec) || 8) * 1000)
  el.classList.remove('hidden', 'closing', 'ending', 'close-taken', 'close-cancelled', 'close-reply')
  el.innerHTML = `
    <div class="pb-row">
      ${avatar('chaorenq', 26)}
      <div class="pb-body">
        <div class="pb-msg">${esc(patrolName())}将在 <b class="pb-sec">–</b> 后接管这条会话</div>
        <div class="pb-track"><span class="pb-fill"></span></div>
      </div>
      <button type="button" class="btn sm secondary pb-cancel" data-testid="patrol-cancel-btn" onclick="cancelPatrolTakeover()">取消接管</button>
    </div>`
  const secEl = el.querySelector('.pb-sec'), fillEl = el.querySelector('.pb-fill')
  const tick = () => {
    if (_patrolBannerRun !== runId || el.classList.contains('hidden')) return
    const left = deadline - Date.now()
    if (left <= 0) { if (secEl) secEl.textContent = '0s'; if (fillEl) fillEl.style.transform = 'scaleX(0)'; return }   // 到点：等 patrol-detected 收尾
    if (secEl) secEl.textContent = Math.ceil(left / 1000) + 's'
    if (fillEl) fillEl.style.transform = `scaleX(${Math.max(0, left / total)})`
    el.classList.toggle('ending', left <= 2000)   // 末 2s 变暖色催促
    _patrolBannerRAF = requestAnimationFrame(tick)
  }
  stopPatrolBannerTick(); tick()
}
async function cancelPatrolTakeover() {
  const runId = _patrolBannerRun || currentRun; if (!runId) return
  finishPatrolBanner('cancelled', `已取消接管，这条交给你`)   // 乐观收尾（引擎 patrol-cancelled 回来也幂等）
  try { await fetch(`/api/runs/${runId}/patrol-cancel`, { method: 'POST' }) } catch { }
}
// 打开会话/轮询同步时：据 run.patrolGraceUntil 补渲染横幅（切窗口/刷新不丢）
function syncPatrolBanner(r) {
  const until = Number(r && r.patrolGraceUntil) || 0
  if (r && r.id === currentRun && until > Date.now()) showPatrolBanner(r.id, until, Math.round((until - Date.now()) / 1000))
  else if (!_patrolBannerRun) hidePatrolBanner()
}

/* ---------- 运行列表 ---------- */
const RUN_PILL = { running: ['accent pulse', '运行中'], starting: ['accent pulse', '启动中'], done: ['success', '已收工'], error: ['danger', '出错'], interrupted: ['', '已中断'], interrupting: ['accent pulse', '正在停止…准备插入'] }
// bg 感知的 pill：本轮收工但后台任务仍在跑 → 「后台运行中·N」（否则回落 RUN_PILL[status]）
function runPill(r) {
  if (r && r.status === 'done' && r.bgTasks && r.bgTasks.length) return ['background pulse', `后台运行中·${r.bgTasks.length}`]
  return RUN_PILL[r.status] || ['', r.status]
}
async function loadRuns() {
  runsCache = await (await fetch('/api/runs')).json()
  try { patrolStatus = await (await fetch('/api/patrol-status')).json() } catch { }   // 巡视雷达状态（端点缺失时 null → 雷达降级为「在岗」慢扫）
  const running = runsCache.filter(r => r.status === 'running' || r.status === 'starting').length
  $('nav-running').textContent = running
  $('nav-running').classList.toggle('hidden', running === 0)
  renderEmpStatus()
  // 打开中的会话也从轮询同步状态（兜底 SSE 漏事件/看别的员工时本会话收工的场景）
  if (currentRun) {
    const cr = runsCache.find(r => r.id === currentRun)
    if (cr) { setRunPill(cr.status, cr); syncPatrolBanner(cr) }   // 兜底：SSE 漏掉 patrol-pending 时靠轮询据 patrolGraceUntil 补起横幅
  }

  $('view-runs').innerHTML = runsCache.map(r => {
    const e = EMPLOYEES[r.employee] || {}
    const [cls, label] = runPill(r)
    return `<div class="run-row" onclick="openRun('${r.id}')">
      ${avatar(r.employee, 30)}
      <div class="run-main">
        <div class="run-name">${esc(e.displayName || r.employee)}</div>
        <div class="run-inst">${esc(r.instruction || '')}</div>
      </div>
      <span class="pill ${cls}"><span class="dot"></span>${label}</span>
      <span class="run-time">${esc((r.startedAt || '').slice(5, 16).replace('T', ' '))}</span>
    </div>`
  }).join('') || '<div class="empty">还没有派过工 — 点右上角「派工」开始</div>'
}

/* ---------- 运行详情（SSE 会话流） ---------- */
let curToolGroup = null
let lastKind = null       // emp | user | sys | tool —— 控制头像分组
let lastRenderedDate = ''  // 上一条消息的「年-月-日」——跨天时插入日期分隔 Marker（参照 shadcn Message 的 date break）
let lastEmpText = ''      // 最近一条员工文本原文（用于 result 错误正文去重，避免与 assistant 文本重复渲染）

/* 时间/日期格式化（会话消息页脚 meta 用；参照 shadcn Message 的 header/footer 时间戳）*/
function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '' }
function fmtDayKey(ts) { const d = ts ? new Date(ts) : null; return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : '' }
function fmtDayLabel(ts) {
  const d = new Date(ts), now = new Date()
  const key = fmtDayKey(ts), todayKey = fmtDayKey(now.getTime())
  const y = new Date(now.getTime() - 864e5)
  if (key === todayKey) return '今天'
  if (key === fmtDayKey(y.getTime())) return '昨天'
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}
/* Marker：居中标签分隔（系统提示 / 日期分割 / 流式·工具活动）——对应 shadcn 的 Marker 组件 */
function marker(label, cls = '') {
  const div = document.createElement('div')
  div.className = 'chat-marker ' + cls
  div.innerHTML = `<span>${esc(label)}</span>`
  appendNode(div)
  return div
}
/* 跨天时插一条日期 Marker（ts 有值且日期变了才插）；lastRenderedDate 在换话题/换 run 时重置 */
function maybeDateSep(ts) {
  if (!ts) return
  const key = fmtDayKey(ts)
  if (key && key !== lastRenderedDate) { marker(fmtDayLabel(ts), 'date'); lastRenderedDate = key }
}

/* ---------- 子代理（SDK sub-agent）渲染上下文 ----------
   SDK 起子代理时，其 assistant/user 事件带 parent_tool_use_id（= 父级 Task 调用 id）。
   利用「一个 query 内子代理跑完前父级被阻塞」的连续块不变量：用单个 appendRoot 指针把这些事件
   路由进父级 Task 行下的可折叠嵌套块（默认收起），主线保持干净。 */
let appendRoot = null       // 当前 DOM 追加目标（子代理体）；null = 主线 run-output
let curSubAgent = null      // 当前渲染所属子代理 pid；null = 主线
let curSubAgentType = null  // 当前子代理类型（供 msgRow 出紧凑徽标代替员工头像）
let mainToolGroup = null    // 主线 curToolGroup 存档（切进/切出子代理时保存/恢复，不打断父级工具组）
const subAgents = {}        // pid -> { details, body, meta:{type,desc}, tg }
const subAgentMeta = {}     // pid -> { type, desc }（渲染父级 Task tool_use 时捕获其 input）

function resetSubAgentCtx() {
  appendRoot = null; curSubAgent = null; curSubAgentType = null; mainToolGroup = null
  for (const k of Object.keys(subAgents)) delete subAgents[k]
  for (const k of Object.keys(subAgentMeta)) delete subAgentMeta[k]
}
// 建一个子代理折叠块（不存在才建），挂到父级 Task 行之后；默认收起
function ensureSubAgent(pid) {
  if (subAgents[pid]) return
  const meta = subAgentMeta[pid] || { type: 'agent', desc: '' }
  const details = document.createElement('details')
  details.className = 'subagent-group'
  const dsc = meta.desc ? '：' + esc(meta.desc) : ''
  details.innerHTML = `<summary><span class="sa-badge">${bicon('bot', 12)}子代理</span><span class="sa-type">${esc(meta.type)}</span><span class="sa-desc">${dsc}</span><span class="sa-status pending">运行中…</span></summary><div class="sa-body"></div>`
  subAgents[pid] = { details, body: details.querySelector('.sa-body'), meta, tg: null }
  // 追加到当前上下文（顶层子代理→主线末尾；子代理再起子代理→外层子代理体内）。
  // 依「连续块」不变量，子代理事件紧跟父级 Task 之后到达 → 块自然落在那个 Task 工具组下方，作为可见的一等行。
  appendNode(details)
}
// 切换渲染上下文：pid 为空 → 回主线；否则进对应子代理体。保存/恢复各自的 curToolGroup 以维持工具分组
function switchContext(pid) {
  pid = pid || null
  if (pid === curSubAgent) return
  if (curSubAgent && subAgents[curSubAgent]) subAgents[curSubAgent].tg = curToolGroup
  else mainToolGroup = curToolGroup
  if (pid) {
    ensureSubAgent(pid)
    const sa = subAgents[pid]
    appendRoot = sa.body; curSubAgentType = sa.meta.type
    curToolGroup = sa.tg && sa.tg.isConnected ? sa.tg : null
  } else {
    appendRoot = null; curSubAgentType = null
    curToolGroup = mainToolGroup && mainToolGroup.isConnected ? mainToolGroup : null
  }
  curSubAgent = pid
}
let curEmployee = null
const liveActivity = {}   // employee -> 进行时活动标签（"正在写 X"），由 run-activity SSE 驱动侧边栏/会话实时显示

/* 会话状态角标（合并到头像上）：复用员工徽标 EMP_ST_ICONS + runStatus，工作中=动点/收工=√/出错=! */
function runHeadBadgeHtml(r) {
  const st = r ? runStatus(r) : null
  if (!st) return '<span class="emp-badge hidden" id="rh-badge"></span>'
  const [cls, tip, path] = EMP_ST_ICONS[st]
  const inner = cls.includes('st-dots')
    ? '<span class="st-dots"><i></i><i></i><i></i></span>'
    : `<svg class="${cls.includes('st-pulse') ? 'st-pulse' : ''}" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`
  return `<span class="emp-badge ${cls.split(' ')[0]}" id="rh-badge" title="${esc(tip)}">${inner}</span>`
}
/* 毛玻璃会话头是绝对定位悬浮条——量其高度写入 --rh-h，让消息流/置顶卡从其下留白起（不被盖） */
function syncRunHeadClear() {
  const head = $('run-head'), panel = $('chat-panel'); if (!head || !panel) return
  const h = head.offsetHeight
  if (h) panel.style.setProperty('--rh-h', h + 'px')
}
/* 会话头（一层）：头像(带状态角标) + 员工名 + 会话下拉 + 新话题/停止/复制ID/展开/关闭（均图标化；会话不可删，无删除键） */
function renderRunHead(r) {
  const e = EMPLOYEES[curEmployee] || {}
  // 档案路径 + runId + sessionId 全收进下拉触发器的 tooltip（不再单占一行/单独徽记）
  const ttTitle = r
    ? `切换会话\n\n档案：${esc(r.taskFile || '未挂任务档案')}\nrunId：${esc(r.id)}\nsessionId：${esc(r.sessionId || '（尚未分配）')}\n源文件：runs/${esc(r.id)}.jsonl`
    : '切换会话（新话题）'
  const ic = (p, sw) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="${sw || 1.7}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`
  $('run-head').innerHTML = `
    <div class="ch-row">
      <span class="emp-av rh-av">${avatar(curEmployee, 28)}${runHeadBadgeHtml(r)}</span>
      <span class="rh-name" title="${esc(e.displayName || '')}">${esc(e.displayName || '')}</span>
      ${r ? `<span class="badge" title="${esc(r.model || '基座默认模型')}">${esc(r.engine === 'codex' ? 'Codex' : r.engine || 'Claude')}</span>` : ''}
      <div class="thread-picker" id="thread-picker">
        <button class="thread-trigger" id="thread-trigger" onclick="toggleThreadMenu(event)" aria-haspopup="listbox" aria-expanded="false" title="${ttTitle}">
          ${r && r.pinned ? pinIconSvg(true, 'tt-pin') : ''}
          <span class="tt-label">${esc(threadLabel(r))}</span>
          <svg class="tt-caret" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
        </button>
        <div class="thread-menu hidden" id="thread-menu" role="listbox"></div>
      </div>
      <div class="spacer"></div>
      ${r ? `<button class="btn ghost" onclick="openEngineHandover()" title="更换基座并接手" aria-label="更换基座并接手">⇄</button>` : ''}
      ${r ? `<button class="btn ghost rh-stop hidden" id="run-stop" onclick="stopRun()" title="停止（终止当前运行）" aria-label="停止"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="3"/></svg></button>` : ''}
      <button class="btn ghost rh-newthread" onclick="openBlankChat(curEmployee)" title="开一个新话题" aria-label="新话题">${ic('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 8v6"/><path d="M9 11h6"/>')}</button>
      ${r ? `<button class="btn ghost" onclick="copyRunId('${r.id}')" title="复制会话 runId：${esc(r.id)}" aria-label="复制会话 ID">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>` : ''}
      ${expandBtnHtml()}
      <button class="btn ghost" onclick="closeChat()" title="关闭聊天" aria-label="关闭">${ic('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 1.8)}</button>
    </div>`
  syncRunHeadClear()
}

/* 会话在选择器/触发器里的一行摘要：时间 · 指令首段（去派工前缀/档案路径） */
function threadTitle(t) {
  const when = (t.startedAt || '').slice(5, 16).replace('T', ' ')
  const gist = clean((t.instruction || '').replace(/【派工】|任务档案：\S+/g, '')).slice(0, 22) || '（无摘要）'
  return `${when} · ${gist}`
}
function threadLabel(r) { return r ? threadTitle(r) : '（新话题）' }

/* 置顶图钉图标：实心=已置顶，描边=未置顶 */
function pinIconSvg(on, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 16 16" width="13" height="13" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5l4 4-2 .5-2.7 2.7-.4 2.8-1.2-1.2-2.9 2.9 2.9-2.9-1.2-1.2 2.8-.4L8.9 8.6l.6-2z"/></svg>`
}

/* 复制 runId（= runs/<id>.jsonl 源文件名），便于复盘时快速定位会话记录 */
async function copyRunId(id) {
  try { await navigator.clipboard.writeText(id); toast(`已复制会话 ID：${id}`, 'ok') }
  catch { toast('复制失败（浏览器限制或非 https）', 'warn') }
}

/* ---------- 会话选择器（可置顶）：置顶/最近分组，逐行图钉切换，参考主流 chatbox 的 pin 交互 ---------- */
let threadMenuOpen = false
function toggleThreadMenu(e) {
  e?.stopPropagation()
  threadMenuOpen ? closeThreadMenu() : openThreadMenu()
}
function openThreadMenu() {
  const menu = $('thread-menu'); if (!menu) return
  renderThreadMenu()
  menu.classList.remove('hidden')
  $('thread-trigger')?.setAttribute('aria-expanded', 'true')
  threadMenuOpen = true
}
function closeThreadMenu() {
  $('thread-menu')?.classList.add('hidden')
  $('thread-trigger')?.setAttribute('aria-expanded', 'false')
  threadMenuOpen = false
}
function renderThreadMenu() {
  const menu = $('thread-menu'); if (!menu) return
  const threads = runsCache.filter(x => x.employee === curEmployee)
  const byRecent = (a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')
  const pinned = threads.filter(t => t.pinned).sort(byRecent)
  const recent = threads.filter(t => !t.pinned).sort(byRecent)
  const row = t => {
    const active = currentRun && t.id === currentRun
    const [pc] = runPill(t)
    return `<div class="thread-item${active ? ' active' : ''}" role="option" aria-selected="${active ? 'true' : 'false'}" onclick="pickThread('${t.id}')" title="${esc(threadTitle(t))}">
      <span class="ti-dot pill ${pc}"><span class="dot"></span></span>
      <span class="ti-title">${esc(threadTitle(t))}</span>
      <button class="ti-pin${t.pinned ? ' on' : ''}" onclick="togglePin(event,'${t.id}')" title="${t.pinned ? '取消置顶' : '置顶（常复用会话钉在顶部）'}" aria-label="${t.pinned ? '取消置顶' : '置顶'}">${pinIconSvg(!!t.pinned)}</button>
    </div>`
  }
  const sec = (title, list) => list.length ? `<div class="thread-sec">${title}</div>${list.map(row).join('')}` : ''
  menu.innerHTML = threads.length
    ? (sec('置顶', pinned) + sec(pinned.length ? '最近' : '', recent))
    : '<div class="thread-empty">还没有会话 — 点「＋ 新话题」开始</div>'
}
function pickThread(id) { closeThreadMenu(); if (id && id !== currentRun) openRun(id) }
async function togglePin(e, id) {
  e?.stopPropagation()
  const r = runsCache.find(x => x.id === id); if (!r) return
  const next = !r.pinned
  r.pinned = next   // 乐观更新：立即重渲染菜单/触发器
  renderThreadMenu()
  if (currentRun === id) { const cr = runsCache.find(x => x.id === currentRun); renderRunHead(cr); setRunPill(cr?.status, cr); openThreadMenu() }
  try {
    const resp = await fetch(`/api/runs/${id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: next }) })
    if (!resp.ok) throw new Error()
    toast(next ? '已置顶该会话' : '已取消置顶', 'ok')
  } catch { r.pinned = !next; renderThreadMenu(); toast('置顶操作失败', 'bad') }   // 回滚
}
// 菜单外点击 / Esc 关闭
document.addEventListener('click', e => { if (threadMenuOpen && !e.target.closest('#thread-picker')) closeThreadMenu() })
document.addEventListener('keydown', e => { if (e.key === 'Escape' && threadMenuOpen) closeThreadMenu() })

/* 侧边栏点员工：进入「代表会话」（与徽标状态同一条），没有则开新话题 */
// 「＋预检单」沉浸式编辑器仅在菲菲窗口出现（发预检发现给她分诊的入口）
function syncPrecheckBtn() { $('precheck-btn')?.classList.toggle('hidden', curEmployee !== 'feifei') }

function openChat(empKey) {
  const rep = empRepRun(empKey)
  if (rep) openRun(rep.id)
  else openBlankChat(empKey)
}

/* 空白新话题（首条消息发出时才真正创建会话） */
function openBlankChat(empKey) {
  currentRun = null
  curEmployee = empKey
  curToolGroup = null
  lastKind = null
  lastRenderedDate = ''
  lastEmpText = ''
  chatOldestSeq = 0
  resetSubAgentCtx()
  resetCardBatch()
  if (evtSource) { evtSource.close(); evtSource = null }
  hidePatrolBanner()
  openChatPanel()
  renderRunHead(null)
  $('run-takeover')?.classList.add('hidden')   // 空白新话题无运行：隐藏「接管」（按钮已移到输入框旁，不再随 run-head 重建）
  $('run-output').innerHTML = ''
  clearPinnedCard()   // 新话题：清掉上一会话的置顶进度卡
  sysChip(`新话题 · 和 ${EMPLOYEES[empKey]?.displayName || empKey} 随意聊；正式任务点「派工」发送`)
  $('reply-text').disabled = false
  $('reply-text').focus()
  syncPrecheckBtn()
}

// 「整理需求」按钮已移除：菲菲 SOP（roles/feifei.md §读多方对话、提炼需求）已覆盖此行为——
// 直接在会话里自然对她说「整理一下需求：<贴日志>」即可触发同一套登记流程，无需专用入口 + 预置话术。

function openRun(id) {
  currentRun = id
  curToolGroup = null
  lastKind = null
  lastRenderedDate = ''
  lastEmpText = ''
  chatOldestSeq = 0   // 分页游标归零：本会话冷开由首条回放事件的 SSE id 重新定
  resetSubAgentCtx()
  resetCardBatch()   // 切会话清空动作卡攒批暂存（暂存是当前会话视图态）
  openChatPanel()
  const r = runsCache.find(x => x.id === id) || {}
  curEmployee = r.employee || curEmployee
  syncPrecheckBtn()
  renderRunHead(r)
  setRunPill(r.status)
  syncPatrolBanner(r)   // 打开会话即据 patrolGraceUntil 补渲染倒计时横幅（切窗口/刷新不丢）
  const out = $('run-output')
  out.innerHTML = ''
  clearPinnedCard()   // 切会话：清掉上一会话的置顶进度卡，本会话回放时最新 stepper 会重新钉上
  replaying = true            // 进入历史回放：先隐藏内容，避免逐条渲染时视口从头滚到尾被看见
  out.style.visibility = 'hidden'
  showChatLoading(true)       // 打开→首条消息前显示「加载消息…」转圈，补 SSE 连接+回放的真空期
  if (evtSource) evtSource.close()
  evtSource = new EventSource(`/api/runs/${id}/events`)
  evtSource.onmessage = m => {
    const n = +m.lastEventId   // SSE id = jsonl 行号；冷开首条回放即最旧 seq，作分页游标下限
    if (n && (!chatOldestSeq || n < chatOldestSeq)) chatOldestSeq = n
    try { renderEvent(JSON.parse(m.data)) } catch { }
  }
  evtSource.onerror = () => showChatLoading(false)   // 连接失败也别一直转圈
}

let handoverPreview = null, handoverBusy = false, handoverRunId = null
function closeEngineHandover() { if (!handoverBusy) $('handover-modal').classList.add('hidden') }
async function openEngineHandover() {
  if (!currentRun || handoverBusy) return
  handoverRunId = currentRun; handoverPreview = null
  $('handover-modal').classList.remove('hidden')
  $('handover-error').textContent = ''; $('handover-summary').textContent = '正在整理已有记录…'
  $('handover-current').textContent = ''; $('handover-engine').replaceChildren()
  $('handover-model').value = ''; $('handover-note').value = ''; $('handover-submit').disabled = true
  try {
    const response = await fetch(`/api/runs/${handoverRunId}/handover`)
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '读取交接信息失败')
    handoverPreview = data
    $('handover-current').textContent = `当前基座：${data.engines.find(e => e.id === data.engine)?.label || data.engine}。新基座先核实进度，待审批事项需要重新确认。`
    $('handover-engine').replaceChildren(...data.engines.filter(e => e.id !== data.engine).map(e => new Option(e.label, e.id)))
    $('handover-summary').textContent = data.summary
    setupModelPicker('handover-model', $('handover-engine').value)
    $('handover-submit').disabled = !$('handover-engine').value
    if (data.pending) $('handover-error').textContent = data.pending.error || '上次交接尚未完成，可重试接手。'
  } catch (e) { $('handover-error').textContent = e.message }
}
async function submitEngineHandover() {
  if (!handoverPreview || handoverBusy) return
  handoverBusy = true
  for (const id of ['handover-submit', 'handover-cancel', 'handover-engine', 'handover-model', 'handover-note']) $(id).disabled = true
  $('handover-submit').textContent = '正在停止旧会话并交接…'; $('handover-error').textContent = ''
  try {
    const response = await fetch(`/api/runs/${handoverRunId}/handover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: $('handover-engine').value, model: $('handover-model').value, note: $('handover-note').value, expectedEngine: handoverPreview.engine }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '交接失败')
    $('handover-modal').classList.add('hidden'); await loadRuns(); toast('已交接，正在启动新基座', 'ok')
  } catch (e) { $('handover-error').textContent = e.message }
  finally {
    handoverBusy = false
    for (const id of ['handover-submit', 'handover-cancel', 'handover-engine', 'handover-model', 'handover-note']) $(id).disabled = false
    $('handover-submit').textContent = '交接并继续'
  }
}
async function stopRun() { if (currentRun) await fetch(`/api/runs/${currentRun}/stop`, { method: 'POST' }) }

/* 删除此会话：抹掉 registry 记录 + 聊天记录（不可恢复）。清掉卡死/出错的陈旧会话，避免员工徽标长期顶成出错态 */
async function deleteRun(id) {
  if (!id || !confirm('删除此会话？聊天记录不可恢复。')) return
  try {
    await fetch(`/api/runs/${id}`, { method: 'DELETE' })
    if (currentRun === id) closeChat()
    await loadRuns()
    toast('已删除该会话', 'ok')
  } catch (e) { toast('删除失败：' + (e.message || e), 'bad') }
}

/* 接管：中断员工当前动作，把你输入的指令投递进去续跑（保留会话上下文，区别于 stop 的彻底终止） */
async function takeoverRun() {
  if (!currentRun) return
  const msg = $('reply-text').value.trim()
  if (!msg) { $('reply-text').focus(); sysChip('⚡ 接管：先在输入框写要插入的指令，再点「⚡接管」', 'warn'); return }
  const kind = dispatchMode ? 'dispatch' : 'chat'
  const taskFile = dispatchMode ? ($('r-task').value || null) : null
  const resp = await fetch(`/api/runs/${currentRun}/reply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, kind, taskFile, takeover: true }),
  })
  // 中间态：不清空输入框（文字保留至真正插入），进入「正在停止…准备插入」态；等真正投递的 user-msg SSE 到达再收尾（renderEvent 里 exitInterrupting）
  if (resp.ok) { enterInterrupting() }
  else sysChip('⚠ 接管失败：' + ((await resp.json().catch(() => ({}))).error || ''), 'bad')
}

/* ⚡接管中间态开合：从点击接管到真正投递之间，输入框文字保留但禁用、pill 翻「正在停止…准备插入」，让用户知道系统在停当前动作 */
function enterInterrupting() {
  takingOver = true
  $('reply-text').disabled = true
  setDispatchMode(false)
  setRunPill('interrupting')
  sysChip('⏹ 正在停止当前动作，准备插入你的消息…', 'warn')
}
function exitInterrupting(clearInput) {
  if (!takingOver) return
  takingOver = false
  $('reply-text').disabled = false               // 显式恢复（失败兜底路径可能不再调 setRunPill）
  if (clearInput) { $('reply-text').value = ''; autoGrowReply(); setRunPill('running') }   // 成功投递、下一轮在跑 → pill 回运行中
  // clearInput=false（接管失败/会话终结）：保留输入便于重发，pill 交由调用方的 setRunPill(done/error) 落定
}

/* 贴底跟随：用户上翻阅读时不打扰；打字指示器始终保持在最底 */
const MAX_CHAT_ROWS = 1500   // 聊天区 DOM 节点上限，超出从顶部裁剪旧节点，防止长会话把 Safari 内存拖爆导致标签页被回收
let activeChatRoot = null    // 渲染输出目标：null=真实 #run-output；分页加载更早时临时指向游离容器（沙箱），渲染完整体 prepend
function appendNode(node) {
  const realOut = $('run-output')
  const scroller = activeChatRoot || realOut   // 滚动容器/追加根：沙箱时为游离容器，否则 run-output
  const out = appendRoot || scroller           // 追加目标：子代理体或主线（沙箱下 appendRoot 已在沙箱内重置）
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90
  if (out === scroller) {
    const typing = out === realOut ? $('typing-row') : null   // 游离容器无 typing-row
    if (typing) out.insertBefore(node, typing)
    else out.appendChild(node)
    // 顶部裁剪只在真实主线做（游离沙箱容器不裁；单页 ≤ limit 也到不了上限）
    if (out === realOut)
      while (out.childElementCount > MAX_CHAT_ROWS && out.firstElementChild && out.firstElementChild !== typing)
        out.removeChild(out.firstElementChild)
  } else {
    out.appendChild(node)                      // 子代理体内：无 typing/裁剪，直接追加
  }
  if (replaying) return   // 历史回放阶段不逐条贴底，交给 lab-sync 结束时一次性定位到最新
  if (nearBottom) scroller.scrollTop = scroller.scrollHeight
}

/* iMessage 式成组：只在「紧挨着的上一条」也是消息气泡时续组——中间隔了系统签/工具组则断组（各自出头像） */
function lastMsgRow() {
  const out = appendRoot || activeChatRoot || $('run-output'); if (!out) return null   // 分组只在当前上下文内看上一条
  let el = out.lastElementChild
  if (el && el.id === 'typing-row') el = el.previousElementSibling   // 打字指示器不算真实消息
  return el && el.classList.contains('msg-row') ? el : null
}
/* 续组时：本行贴紧上一行（.grouped），且把上一条员工行的头像降级为占位（头像只留在组内最后一条） */
function applyGrouping(row, side) {
  const prev = lastMsgRow()
  if (!prev) return
  const prevSide = prev.classList.contains('user') ? 'user' : prev.classList.contains('emp') ? 'emp' : null
  if (prevSide !== side) return
  row.classList.add('grouped')
  // 续组：上一条降级为组中项——头像换占位（emp），页脚 meta（时间/复制）隐藏，只留组末那条显示（参照 shadcn 分组）
  prev.classList.add('grouped-mid')
  if (side === 'emp') {
    const av = prev.querySelector(':scope > .avatar')
    if (av) av.replaceWith(Object.assign(document.createElement('span'), { className: 'av-spacer' }))
  }
}

/* 员工消息（左·头像气泡·Markdown）/ 用户消息（右·薰衣草气泡）
   参照 shadcn Message：气泡下方页脚 meta（可见时间戳，组内仅末条显示）+ 员工气泡 hover 出「复制」动作。*/
const COPY_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const COPY_BTN = `<button type="button" class="msg-copy" title="复制这条消息" aria-label="复制这条消息">${COPY_ICON}</button>`
/* 排队消息被真正接受（服务端 queued-accepted 事件）：清掉之前排队气泡的「排队中·忙完就接」标与 queued 态。
   服务端在「本轮 result 后、下一轮首个 assistant」处发此事件（真被 coalesce 开跑），live 与回放同路。 */
function clearQueuedTags() {
  const out = $('run-output'); if (!out) return
  out.querySelectorAll('.bubble.queued').forEach(b => b.classList.remove('queued'))
  out.querySelectorAll('.queued-tag').forEach(t => t.remove())
}
// after：跟在气泡「之后、同列之内」的独立块（目前只用户侧用：聊天记录卡片自成一卡，不塞进紫气泡）
// tail：气泡后面那条**不算卡片**的附属行（如「查看完整指令」折叠）——与 after 分开，
// 免得它把 msg-col 顶成 has-card（那条是给聊天记录卡放宽列宽用的，纯文字折叠行不该跟着变宽）。
function msgRow(kind, html, extraCls = '', ts = '', after = '', tail = '') {
  curToolGroup = null
  maybeDateSep(ts)
  const row = document.createElement('div')
  row.className = 'msg-row ' + kind
  const time = fmtTime(ts)
  const foot = time ? `<div class="msg-time">${esc(time)}</div>` : ''
  applyGrouping(row, kind === 'emp' ? 'emp' : 'user')
  if (kind === 'emp' && appendRoot) {   // 子代理里的文本：紧凑徽标代替员工圆头像
    row.classList.add('sa-msg')
    row.innerHTML = `<span class="sa-badge sa-badge-sm" title="子代理 ${esc(curSubAgentType || 'agent')}">${bicon('bot', 12)}</span><div class="msg-col"><div class="bubble emp sa-bubble ${extraCls}">${html}</div>${foot}</div>`
  } else if (kind === 'emp') {
    row.innerHTML = `${avatar(curEmployee, 28)}<div class="msg-col"><div class="bubble emp ${extraCls}">${html}</div><div class="msg-foot">${foot}${COPY_BTN}</div></div>`
  } else {
    // 排队中：忙完这步 SDK 自然接（无感追加），气泡下低调标一行
    const qtag = extraCls.includes('queued') ? '<span class="queued-tag">排队中·忙完就接</span>' : ''
    const bubble = html.trim() ? `<div class="bubble user ${extraCls}">${html}</div>` : ''   // 只有卡片没正文时别留个空气泡
    // 自己发的消息也能复制（老板 2026-09-01）：与员工侧同一套页脚。只有卡片没正文时不挂——
    // 那种消息的可复制文本在折叠卡里（closed <details> 的内容取不到 innerText），给了也是复制个空。
    const foot2 = `<div class="msg-foot">${foot}${bubble ? COPY_BTN : ''}</div>`
    row.innerHTML = `<div class="msg-col user${after ? ' has-card' : ''}">${bubble}${after}${tail}${qtag}${foot2}</div>`
  }
  lastKind = kind
  appendNode(row)
}

/* 气泡「复制」动作（事件委托，一次绑定）：复制该气泡的纯文本（参照 shadcn MessageActions 的 copy） */
$('run-output')?.addEventListener('click', async e => {
  const btn = e.target.closest('.msg-copy'); if (!btn) return
  const bubble = btn.closest('.msg-col')?.querySelector('.bubble')
  const text = bubble ? (bubble.innerText || bubble.textContent || '').trim() : ''
  if (!text) return
  try { await navigator.clipboard.writeText(text); btn.classList.add('copied'); setTimeout(() => btn.classList.remove('copied'), 1200) }
  catch { toast('复制失败（浏览器限制或非 https）', 'warn') }
})

/* 派工折叠 chip 行（右对齐，无气泡底，点开看全文） */
function dispatchRow(html, ts = '') {
  curToolGroup = null
  const row = document.createElement('div')
  row.className = 'msg-row user dispatch-row'
  const time = ts ? new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
  applyGrouping(row, 'user')
  row.innerHTML = `<div class="dispatch-wrap" ${time ? `title="${time}"` : ''}>${html}</div>`
  lastKind = 'user'
  appendNode(row)
}

/* 系统事件（居中小签） */
/* 去 emoji：剥掉字符串开头的表情/符号 + 前导空白（历史文案里 ✅/⚠️/❌/ℹ️/⏹ 等都当前缀用）——统一改由图标系统承载 */
const stripLeadIcon = s => String(s == null ? '' : s).replace(/^[\s℀-⟿⬀-⯿️\u{1f000}-\u{1faff}]+/u, '')
function sysChip(text, cls = '') {
  curToolGroup = null
  lastKind = 'sys'
  const div = document.createElement('div')
  div.className = 'sys-chip ' + cls
  const ic = cls.includes('ok') ? bicon('check', 12) : cls.includes('bad') ? bicon('alert', 12) : ''
  div.innerHTML = `${ic}<span>${esc(stripLeadIcon(text))}</span>`
  appendNode(div)
}

/* 连续工具调用聚合为可折叠组（缩进对齐员工消息列）；记 id/起始时间供 tool_result 回填结果+耗时 */
let toolRows = {}   // tool_use_id -> { el, t0 }（let：分页沙箱渲染时临时换新表再还原，不污染实时流的回填映射）
function addToolRow(name, brief, id, ts) {
  if (!curToolGroup || !curToolGroup.isConnected) {
    curToolGroup = document.createElement('details')
    curToolGroup.className = 'tool-group'
    curToolGroup.innerHTML = '<summary><span class="tg-count"></span></summary><div class="tg-rows"></div>'
    appendNode(curToolGroup)
    lastKind = 'emp'   // 工具组属于员工的动作流，后续文本不重复头像
  }
  const rows = curToolGroup.querySelector('.tg-rows')
  const row = document.createElement('div')
  row.className = 'tool-row'
  row.innerHTML = `<span class="tr-name">${esc(name)}</span><span class="tr-brief" title="${esc(brief)}">${esc(brief)}</span><span class="tr-result pending" title="等待结果…">…</span>`
  rows.appendChild(row)
  curToolGroup.querySelector('.tg-count').textContent = `工具调用 · ${rows.children.length}`
  if (id) toolRows[id] = { el: row, t0: Date.parse(ts) || Date.now() }
}
/* 工具结果回填：把 output 摘要 + 耗时 + 成功/失败 写回对应工具行，让工作过程可见而非黑盒 */
function fillToolResult(id, isError, outText, ts) {
  const rec = toolRows[id]; if (!rec) return
  const cell = rec.el.querySelector('.tr-result'); if (!cell) return
  const secs = Math.max(0, ((Date.parse(ts) || Date.now()) - rec.t0) / 1000)
  const dur = secs >= 0.05 ? ` ${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s` : ''
  const snippet = String(outText || '').replace(/\s+/g, ' ').trim().slice(0, 140)
  cell.className = 'tr-result ' + (isError ? 'err' : 'ok')
  cell.innerHTML = (isError ? bicon('alert', 11) : bicon('check', 11)) + `<span>${esc(dur + (snippet ? ' · ' + snippet : ''))}</span>`
  cell.title = snippet || (isError ? '出错' : '成功')
  delete toolRows[id]
}

/* 打字指示器（可带进行时活动标签："正在写 X" / "思考中…"）*/
function setTyping(on, label) {
  let existing = $('typing-row')
  if (on) {
    if (!existing) {
      existing = document.createElement('div')
      existing.id = 'typing-row'
      existing.className = 'msg-row emp'
      existing.innerHTML = `<div class="typing-main">${avatar(curEmployee, 28)}<div class="bubble emp typing"><span></span><span></span><span></span></div></div><span class="typing-label"></span>`
      const out = $('run-output')
      out.appendChild(existing)
      out.scrollTop = out.scrollHeight
    }
    const lbl = existing.querySelector('.typing-label')
    if (lbl) lbl.textContent = label || ''
  } else if (existing) existing.remove()
}

function setRunPill(status, run) {
  const r = run || runsCache.find(x => x.id === currentRun) || {}
  const bgN = (status === 'done' && r.bgTasks) ? r.bgTasks.length : 0
  const [cls, label] = runPill({ status, bgTasks: bgN ? r.bgTasks : null })
  const badgeEl = $('rh-badge')   // 状态合并到头像角标：刷新会话头的 #rh-badge（原独立 pill 已移除）
  if (badgeEl) { badgeEl.outerHTML = runHeadBadgeHtml({ ...r, status }); syncRunHeadClear() }
  const active = status === 'running' || status === 'starting'
  const bg = bgN > 0
  const interrupting = status === 'interrupting' || takingOver   // ⚡接管中间态：停当前动作、准备插入
  $('run-stop')?.classList.toggle('hidden', !(active || bg || interrupting))   // 后台在跑时「停止」仍可用（取消后台）
  $('run-takeover')?.classList.toggle('hidden', !active)   // 中间态不再显示接管按钮（已在接管中）
  $('reply-text').disabled = interrupting   // 运行中可输入：回车=排队追加，点「⚡接管」=立刻打断；接管中间态期间禁用（文字保留但不可编辑）
  $('reply-text').placeholder = active
    ? `${EMPLOYEES[curEmployee]?.displayName || '员工'}工作中…回车=排队追加（忙完就接），点「⚡接管」=立刻打断`
    : bg ? '后台任务运行中…结果回来会自动继续，也可直接追问'
    : '和员工聊聊…（随意聊；点「派工」发正式任务）'
  if (interrupting) setTyping(true, '正在停止当前动作，准备插入你的消息…')
  else if (active) setTyping(true, liveActivity[curEmployee])
  else if (bg) setTyping(true, `后台任务运行中（${bgN}）`)
  else { delete liveActivity[curEmployee]; setTyping(false) }
}

const mdRender = t => (window.marked ? marked.parse(t, { gfm: true, breaks: true }) : esc(t))
// 内联 markdown（粗体/代码/斜体/链接，不裹 <p>）——用于短文案（facet 验收标准等），marked 缺失或不支持 parseInline 时回退转义
const mdInline = t => { try { return (window.marked && marked.parseInline) ? marked.parseInline(String(t ?? ''), { gfm: true }) : esc(t) } catch { return esc(t) } }

/* ---------- 消息卡片（OLCards）：员工文本里嵌的 ```olcard 渲染成富卡片（Linear 风格 + 头像 + 动态图标） ---------- */
/* 卡片上下文：动作卡按钮的写回全部复用现成的 /api/runs/:id/reply（kind=chat，员工带上下文续跑），无需新服务端接口 */
// 卡片回发的实际 POST（返回 true/false：成功才置卡片「已处理」，失败恢复可点）
async function postCardReply(message) {
  if (!message) return false
  if (!currentRun) { toast('当前没有在跑的会话可回发（历史会话请重新开聊）', 'warn'); return false }
  try {
    const resp = await fetch(`/api/runs/${currentRun}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, kind: 'chat', taskFile: null }),
    })
    if (resp.ok) { setRunPill('running'); loadRuns(); sysChip(`↩ 已回发你的选择，${EMPLOYEES[curEmployee]?.displayName || '员工'}继续处理…`, 'ok'); return true }
    const e = (await resp.json().catch(() => ({}))).error || ''
    toast('回发失败：' + e, 'warn'); return false
  } catch (e) { toast('回发失败：' + (e.message || e), 'warn'); return false }
}

// ---------- 动作卡攒批（一轮里多张「待你操作」卡，点了先暂存，凑齐后一次性合并回发）----------
let cardBatch = { staged: [], finalizers: {} }
function resetCardBatch() { cardBatch = { staged: [], finalizers: {} }; renderBatchBar() }
function renderBatchBar() {
  const bar = $('card-batch-bar'); if (!bar) return
  const n = cardBatch.staged.length
  if (!n) { bar.classList.add('hidden'); bar.innerHTML = ''; return }
  const emp = EMPLOYEES[curEmployee]?.displayName || '员工'
  bar.classList.remove('hidden')
  bar.innerHTML = `<span class="cbb-info">已选 <b>${n}</b> 项，待一起发送给 ${esc(emp)}</span>`
    + `<button type="button" class="btn sm ghost" id="cbb-reset">重选</button>`
    + `<button type="button" class="btn sm primary" id="cbb-send">发送 ${n} 项</button>`
  $('cbb-send').onclick = sendCardBatch
  $('cbb-reset').onclick = () => { const r = currentRun; resetCardBatch(); if (r) openRun(r) }   // 重开会话=从历史重渲染，暂存态自然清空、卡片恢复可点
}
async function sendCardBatch() {
  const items = cardBatch.staged.slice(); if (!items.length) return
  const combined = `【本轮 ${items.length} 项拍板，一并回复】\n` + items.map((d, i) => `${i + 1}. ${d.title ? `【${d.title}】` : ''}${d.reply}`).join('\n')
  const btn = $('cbb-send'); if (btn) btn.disabled = true
  const ok = await postCardReply(combined)
  if (!ok) { if (btn) btn.disabled = false; return }   // 失败已 toast，保留暂存让用户重试
  for (const d of items) { try { cardBatch.finalizers[d.id] && cardBatch.finalizers[d.id]() } catch { } }
  resetCardBatch()
}

function cardCtx() {
  const emp = EMPLOYEES[curEmployee] || {}
  return {
    runId: currentRun,
    employeeKey: curEmployee,
    employeeName: emp.displayName || curEmployee,
    focusReply: () => { const t = $('reply-text'); if (t) { t.focus(); t.scrollIntoView({ block: 'nearest' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200) } },
    reply: (message) => postCardReply(message),   // gate 内联输入等「立即发」路径
    // 动作卡按钮点击出口：本轮只有这一张待操作卡 → 立即回发；有兄弟卡或已暂存 → 暂存进攒批，等「发送」一起发
    act: async (id, label, reply, node) => {
      if (!currentRun) { toast('当前没有在跑的会话可回发', 'warn'); return 'failed' }
      const scroller = $('run-output')
      const live = scroller ? [...scroller.querySelectorAll('.ol-card[data-olc-action-id]')].filter(c => !c.classList.contains('olc-done') && !c.classList.contains('olc-staged')) : []
      const shouldBatch = cardBatch.staged.length > 0 || live.length > 1   // live 含当前这张；>1=还有兄弟卡
      if (!shouldBatch) return (await postCardReply(reply)) ? 'sent' : 'failed'
      cardBatch.staged.push({ id, label, reply, title: (node && node.dataset && node.dataset.olcTitle) || '' })
      renderBatchBar()
      return 'staged'
    },
    onSend: (id, fn) => { cardBatch.finalizers[id] = fn },
    uploadFile: (file) => uploadFile(file),   // 交互式 gate 内联附件：复用现成上传，返回 {path,url,name,kind}
    openUrl: (u) => { if (/^https?:\/\//i.test(u || '')) window.open(u, '_blank', 'noopener'); else toast('链接无效：' + (u || ''), 'warn') },
    copy: async (t) => { try { await navigator.clipboard.writeText(t || ''); toast('已复制到剪贴板', 'ok') } catch { toast('复制失败（浏览器限制或非 https）', 'warn') } },
    download: (name, content) => {
      try {
        const blob = new Blob([content || ''], { type: 'text/plain;charset=utf-8' })
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name || 'download.txt'
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      } catch (e) { toast('下载失败：' + (e.message || e), 'warn') }
    },
    toast,
  }
}
/* 卡片行：员工侧头像 + 卡片（成组降级头像，与消息气泡一致的 iMessage 观感） */
function cardRow(data, ts) {
  curToolGroup = null
  const row = document.createElement('div')
  row.className = 'msg-row emp card-row'
  applyGrouping(row, 'emp')
  row.innerHTML = `${avatar(curEmployee, 28)}<div class="olc-wrap"></div>`
  const wrap = row.querySelector('.olc-wrap')
  try { wrap.appendChild(OLCards.renderCard(data, cardCtx())) }
  catch (e) { wrap.innerHTML = `<div class="md-mini">卡片渲染失败：${esc(String(e.message || e))}</div>` }
  lastKind = 'emp'
  appendNode(row)
  // 进度框（stepper）置顶：把本会话最新的进度卡镜像钉到聊天区顶部、可折叠（回放时最后一张自然胜出）。
  if (data && data.type === 'stepper') pinProgressCard(data)
}

/* ---------- 置顶进度卡（stepper 快照钉顶部 + 可折叠）---------- */
// 镜像卡用 inert ctx：置顶的是「同一张卡的展示副本」，动作（若有）不在这里生效，避免与正文那张双触发。
function pinnedInertCtx() {
  return {
    runId: 'pinned', employeeName: EMPLOYEES[curEmployee]?.displayName || '',
    reply: () => { toast('这是置顶的进度副本，去下方原卡操作', 'warn'); return false },
    focusReply: () => { },
    openUrl: u => { if (/^https?:\/\//i.test(u || '')) window.open(u, '_blank', 'noopener') },
    copy: async t => { try { await navigator.clipboard.writeText(t || ''); toast('已复制', 'ok') } catch { } },
    download: () => toast('这是置顶的进度副本，去下方原卡下载', 'warn'),
    toast,
  }
}
function pinProgressCard(data) {
  const host = $('pinned-card'); if (!host) return
  const collapsed = host.dataset.collapsed === '1'
  host.classList.remove('hidden')
  host.innerHTML = `
    <div class="pc-bar" onclick="togglePinnedCard()" title="点击折叠/展开置顶进度">
      <span class="pc-eyebrow">📌 置顶进度</span>
      <span class="pc-title">${esc(data.title || data.eyebrow || '进度')}</span>
      <span class="spacer"></span>
      <button type="button" class="pc-toggle" onclick="event.stopPropagation();togglePinnedCard()" aria-label="折叠/展开">
        <svg class="pc-caret" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
      </button>
    </div>
    <div class="pc-body"></div>`
  try { host.querySelector('.pc-body').appendChild(OLCards.renderCard(data, pinnedInertCtx())) }
  catch (e) { host.querySelector('.pc-body').innerHTML = `<div class="md-mini">进度卡渲染失败</div>` }
  host.classList.toggle('collapsed', collapsed)
}
function togglePinnedCard() {
  const host = $('pinned-card'); if (!host) return
  const now = host.dataset.collapsed === '1' ? '0' : '1'
  host.dataset.collapsed = now
  host.classList.toggle('collapsed', now === '1')
}
function clearPinnedCard() {
  const host = $('pinned-card'); if (!host) return
  host.innerHTML = ''; host.classList.add('hidden'); host.dataset.collapsed = '0'; host.classList.remove('collapsed')
}
/* 仓库 markdown 路径 → 可点链接：员工在消息里写的档案路径（预检单/需求说明/交接卡/实施记录/tasks 档案…）
   变成可点 span，点击走现成的 viewFile 弹层（复用 /api/file，见 viewFile）。只认能从仓库根解析的前缀，避免死链。*/
const REPO_MD_SRC = '(?<![\\w./-])(?:office-lab\\/(?:tasks|templates|roles|docs|memories)|docs)\\/[^\\s"\'`）)】」》，、；：]+\\.md'
// 在 mdRender 产出的 HTML 上做 DOM 级 linkify（跳过 <a>，不双重链接；<code>/<pre> 内的路径也linkify，因为路径常写在反引号里）
function linkifyRepoPaths(html) {
  const tpl = document.createElement('template')
  tpl.innerHTML = html
  const walk = node => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const txt = child.nodeValue
        const re = new RegExp(REPO_MD_SRC, 'g')
        if (!re.test(txt)) continue
        re.lastIndex = 0
        const frag = document.createDocumentFragment()
        let last = 0, m
        while ((m = re.exec(txt))) {
          if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)))
          const span = document.createElement('span')
          span.className = 'file-link'; span.dataset.path = m[0]; span.textContent = m[0]
          frag.appendChild(span)
          last = m.index + m[0].length
        }
        if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)))
        child.replaceWith(frag)
      } else if (child.nodeType === 1 && child.tagName !== 'A') {
        walk(child)
      }
    }
  }
  walk(tpl.content)
  return tpl.innerHTML
}
const empHtml = text => linkifyRepoPaths(mdRender(text))

/* 会话区点击代理：点 .file-link（自动 linkify 的仓库路径）或员工写的指向仓库 .md 的 markdown 链接 → 走 viewFile 弹层，
   而非当成网页地址跳转（那会 404）。委托在 #run-output，覆盖历史回放与实时新增的所有气泡。*/
;(() => {
  const out = $('run-output')
  if (!out) return
  out.addEventListener('click', e => {
    const fl = e.target.closest('.file-link')
    if (fl && fl.dataset.path) { e.preventDefault(); viewFile(fl.dataset.path); return }
    const a = e.target.closest('a')
    if (a) {
      const href = a.getAttribute('href') || ''
      if (/\.md($|[?#])/.test(href) && !/^(?:https?:|mailto:|#|\/uploads\/)/.test(href)) {
        e.preventDefault(); viewFile(href.replace(/^\.?\//, ''))
      }
    }
  })
})()

/* 员工文本：无卡片 → 整段一个气泡；含 ```olcard → 按段切分，md 段出气泡、卡片段出卡片 */
// 从员工文本抽取 `【等你拍板】<事项>` 门（item 非空且非「无…」才算），取最后一处（同引擎 lastMarkerBlock 语义）。
// marker 只在显示层剥离并合成成 gate 卡；run.result 原文不动 → 引擎 parsePendingGate/autoChain 与状态徽标 runStatus 全不受影响。
function parseGate(text) {
  const s = String(text || '')
  const ms = [...s.matchAll(/^[ \t]*【等你拍板】[ \t]*(\S[^\n]*)?[ \t]*$/gm)]
  if (!ms.length) return { item: null, rest: s }
  const m = ms[ms.length - 1]
  const item = (m[1] || '').trim()
  if (!item || /^无/.test(item)) return { item: null, rest: s }
  const rest = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim()
  return { item, rest }
}
// 员工已产的交互动作卡类型：出现任一 → 它本身就是拍板交互面，不再补合成 gate（避免重复两张卡）
const ACTION_CARD_TYPES = new Set(['decision', 'approval', 'toggle', 'gate'])
function renderEmpText(text, ts) {
  const gate = parseGate(text)
  const body = gate.item ? gate.rest : text
  let hasActionCard = false
  if (!window.OLCards || !OLCards.hasCard(body)) {
    if (body && body.trim()) msgRow('emp', `<div class="md-mini">${empHtml(body)}</div>`, '', ts)
  } else {
    for (const seg of OLCards.parse(body)) {
      if (seg.kind === 'card') { cardRow(seg.data, ts); if (seg.data && ACTION_CARD_TYPES.has(seg.data.type)) hasActionCard = true }
      else if (seg.text && seg.text.trim()) msgRow('emp', `<div class="md-mini">${empHtml(seg.text)}</div>`, '', ts)
    }
  }
  // marker 有事项、但员工没配任何交互动作卡 → 兜底合成可内嵌输入的 gate（波比那种散文收尾也能就地拍板）
  if (gate.item && !hasActionCard) cardRow({ type: 'gate', eyebrow: '等你拍板 · ' + (EMPLOYEES[curEmployee]?.displayName || curEmployee || '员工'), title: gate.item }, ts)
}

/* 贴到最底：历史回放结束时调用。图片/markdown 是异步加载的，
   一次 scrollTop 会在图片撑高后落在半中间——所以下一帧 + 图片 onload 再各贴一次。 */
function scrollChatToBottom() {
  const out = $('run-output'); if (!out) return
  const pin = () => { out.scrollTop = out.scrollHeight }
  pin()
  requestAnimationFrame(pin)
  setTimeout(pin, 120)
  out.querySelectorAll('img').forEach(img => { if (!img.complete) img.addEventListener('load', pin, { once: true }) })
}
/* 派工消息里塞满了注入块（任务快照/同事近况/委托说明）+ 完整 SOP，直接铺成大气泡会霸屏。
   抽出「真正的一句话指令」作摘要，全文折叠进 <details>。口径对齐服务端 cleanForPush 的注入剥离。 */
function stripDispatchNoise(text) {
  return String(text || '')
    .replace(/\n*\[附(?:图|件)，请用 Read 工具查看\][\s\S]*$/, '')                 // 附件占位尾巴
    .replace(/【(?:任务快照|同事近况|完整档案)】[\s\S]*?(?=\n\s*\n|$)/g, '')          // 注入块
    .split('\n').filter(l => !/^\s*(?:【派工】|【交回】|【等你拍板】|【抄送】|📄|任务档案：)/.test(l)).join('\n')  // 含抄送头行——lead/正文都跳过样板
    .replace(/^\s*（本次由[\s\S]*?回发其会话[\s\S]*?）\s*$/m, '')                    // 委托回发说明段
    .trim()
}
function dispatchLead(text) {
  const line = stripDispatchNoise(text).split('\n').map(l => l.trim())
    .find(l => l && !/^[-*#>]/.test(l)) || '派工任务'
  const clean = line.replace(/\*\*|`/g, '')
  return clean.length > 46 ? clean.slice(0, 46) + '…' : clean
}
// 系统唤起（【系统·E2E 批次已全部结束】等）：正文是写给 AI 的操作指令，人看只要「结果 + 下一步」。
// 解析成紧凑摘要；格式唯一事实源 app/e2e-batch.js buildWakePrompt。口径对齐新 UI web/src/lib/system-notice.ts。
function systemNoticeHtml(body) {
  const m = String(body || '').match(/^\s*【系统·([^】]+)】\s*([\s\S]*)$/)
  if (!m) return null
  const title = m[1].trim(), rest = m[2]
  const h = rest.match(/批次\s*(\S+?)：(\d+)\s*个用例文件，并发\s*(\d+)，墙钟\s*([\d.]+)min。绿\s*(\d+)\s*\/\s*红\s*(\d+)/)
  if (!/E2E 批次已全部结束/.test(title) || !h) {
    const first = (rest.split('\n').find(l => l.trim()) || '').split(/(?<=。)/)[0].replace(/\*\*|`/g, '').trim()
    return { lead: title, html: `<div class="sn-sum">${esc(first.slice(0, 90))}</div>` }
  }
  const [, , total, conc, mins, gRaw, rRaw] = h
  const rows = []; let sec = ''
  for (const line of rest.split('\n')) {
    const t = line.trim()
    if (/^✅/.test(t)) { sec = 'ok'; continue }
    if (/^❌/.test(t)) { sec = 'bad'; continue }
    if (/^🎯/.test(t)) { sec = 'cal'; continue }   // RED 校准：故意带错误预期，红=护栏有效
    if (/^👁|^下一步/.test(t)) { sec = ''; continue }
    if (!sec) continue
    const it = line.match(/^ {2}· (.+)$/)
    if (it) {
      const parts = it[1].split('　'), verdict = (parts.find(p => p.startsWith('verdict=')) || '').slice(8)
      rows.push(sec === 'cal'
        ? { cal: true, ok: verdict === '如期红', verdict, label: parts[0].trim(), why: '' }
        : { ok: sec === 'ok', label: parts[0].trim(), why: '' })
      continue
    }
    const f = line.match(/^\s+(?:首个失败|提交\/执行异常|原因)：(.+)$/)
    if (f && rows.length && !rows[rows.length - 1].ok && !rows[rows.length - 1].why) rows[rows.length - 1].why = f[1].trim()
  }
  const calM = rest.match(/RED 校准\s*(\d+)：如期红\s*(\d+)/)
  let calTotal = calM ? +calM[1] : 0, calOk = calM ? +calM[2] : 0
  let g = gRaw, r = rRaw
  if (!calM) {   // 2026-10-27 前的旧消息：RED 件混在 ✅/❌ 里，按文件名归组并重算计数（历史回放不再显示成一片失败）
    for (const x of rows) if (/-RED\.json(\(|$)/i.test(x.label)) { x.cal = true; x.verdict = x.ok ? '意外通过' : '红（旧消息未判类型）'; x.ok = !x.ok; x.why = '' }
    const cal = rows.filter(x => x.cal)
    if (cal.length) { calTotal = cal.length; calOk = cal.filter(x => x.ok).length; g = rows.filter(x => !x.cal && x.ok).length; r = rows.filter(x => !x.cal && !x.ok).length }
  }
  const calBad = calTotal - calOk
  const scan = (rest.match(/^\s+· page_scan\(/gm) || []).length
  const next = [+r ? `修复 ${r} 个红件后重跑` : '', calBad ? `处理 ${calBad} 个异常 RED 校准` : '', scan ? `页面巡检 ${scan} 个绿件` : '', +g ? '覆盖率机签' : ''].filter(Boolean)
  const rowHtml = x => x.cal
    ? `<li class="${x.ok ? 'ok' : 'bad'}"><span class="sn-ic">${x.ok ? '◎' : '!'}</span><span class="sn-lb">${esc(x.label)} · ${esc(x.verdict)}</span>${x.why ? `<div class="sn-why">${esc(x.why.slice(0, 140))}</div>` : ''}</li>`
    : `<li class="${x.ok ? 'ok' : 'bad'}"><span class="sn-ic">${x.ok ? '✓' : '✕'}</span><span class="sn-lb">${esc(x.label)}</span>${x.why ? `<div class="sn-why">${esc(x.why.slice(0, 140))}</div>` : ''}</li>`
  const normalRows = rows.filter(x => !x.cal), calRows = rows.filter(x => x.cal)
  const html = `<div class="sn-pills">${normalRows.length || !calTotal ? `<span class="sn-pill ok">通过 ${g}</span><span class="sn-pill${+r ? ' bad' : ''}">未通过 ${r}</span>` : ''}${calTotal ? `<span class="sn-pill ok">${calM ? `RED 如期红 ${calOk}/${calTotal}` : `RED 红 ${calOk}/${calTotal}（未判类型）`}</span>` : ''}${calBad ? `<span class="sn-pill bad">RED 异常 ${calBad}</span>` : ''}<span class="sn-pill">${total} 个用例 · 并发 ${conc}</span><span class="sn-pill">${esc(mins)} 分钟</span></div>`
    + (normalRows.length ? `<ul class="sn-cases">${normalRows.map(rowHtml).join('')}</ul>` : '')
    + (calRows.length ? `<div class="sn-sum">RED 校准 · 故意带错误预期，红 = 护栏有效</div><ul class="sn-cases">${calRows.map(rowHtml).join('')}</ul>` : '')
    + (next.length ? `<div class="sn-next">接下来 ${next.map(x => `<span>${esc(x)}</span>`).join('')}</div>` : '')
  const lead = calTotal && !normalRows.length
    ? `E2E 批次结束 · RED ${calM ? '如期红' : '红'} ${calOk}/${calTotal}${calBad ? ` · 异常 ${calBad}` : ''}`
    : `E2E 批次结束 · 通过 ${g} / 未通过 ${r}${calTotal ? ` · RED ${calM ? '如期红' : '红'} ${calOk}/${calTotal}` : ''}`
  return { lead, html }
}
// 聊天记录哨兵段的正则（由常量拼，避免与发送端漂移）；一段 raw → 一个可读折叠块
const CHATLOG_RE = () => new RegExp(CHATLOG_OPEN + '\\n?([\\s\\S]*?)\\n?' + CHATLOG_CLOSE, 'g')
// 聊天记录正文里的 @某人 / @某人(备注) 着色（先 esc 再替换：字符类排除 & # ; 避开实体，不会咬进 &amp;）
const clAt = s => esc(s).replace(
  /(^|[\s(（【「])@([^\s@&#;()（）【】「」,，。；;：:！!？?]{1,16}(?:[（(][^）)]{0,24}[）)])?)/g,
  (_m, lead, name) => `${lead}<span class="cl-at">@${name}</span>`)
// 聊天记录文本里的 〖截图〗office-lab/app/uploads/…｜name〖/截图〗 → 内联 <img>；其余文本走 clAt（换行靠 CSS pre-wrap）
function clRichHtml(text) {
  const s = String(text || '')
  let html = '', last = 0, m
  const re = SHOT_RE()
  while ((m = re.exec(s))) {
    html += clAt(s.slice(last, m.index))
    const relM = (m[1] || '').match(/office-lab\/app\/uploads\/([^\s｜]+)/)
    if (relM) {
      const rel = relM[1], name = ((m[1] || '').split('｜')[1] || '').trim()
      html += `<img class="cl-img" src="/uploads/${esc(rel)}" title="${esc(name)}" onclick="window.open(this.src)" />`
    }
    last = m.index + m[0].length
  }
  html += clAt(s.slice(last))
  return html
}
/* 聊天记录 → 独立折叠卡（不是塞在用户紫气泡里的一块，见 style.css「聊天记录卡片」）。
   头部一行「图标 + 聊天记录 + N条·参与人·日期·N图」；正文按发言人分条，连续同一人只标一次名（微信/企微观感）。
   短记录（条数少、图少、字少）默认展开——不用点一下才知道贴了什么；长记录仍折叠，避免霸屏。 */
function chatlogBlockHtml(raw) {
  const p = parseChatlog(raw)
  const imgN = (String(raw || '').match(SHOT_RE()) || []).length
  const bits = (p.format === 'raw'
    ? ['原文']
    : [`${p.meta.count} 条`, p.meta.participants.join('、'), p.meta.span]
  ).concat(imgN ? [`${imgN} 图`] : []).filter(Boolean)
  const head = `<summary><span class="cl-icon">${bicon('chat', 13)}</span>`
    + `<span class="cl-head"><span class="cl-title">聊天记录</span><span class="cl-sub">${esc(bits.join(' · '))}</span></span>`
    + `<span class="cl-caret">${bicon('chevron', 14)}</span></summary>`
  let body, textLen = 0
  if (p.format === 'raw') { textLen = p.raw.length; body = `<pre class="cl-raw">${clRichHtml(p.raw)}</pre>` }
  else {
    let prev = ''
    body = p.entries.map(en => {
      const same = en.sender === prev
      prev = en.sender
      textLen += en.text.length
      const meta = same ? '' : `<div class="cl-meta"><span class="cl-who">${esc(en.sender)}</span>`
        + `<span class="cl-time">${esc([en.date, en.time].filter(Boolean).join(' '))}</span></div>`
      return `<div class="cl-entry${same ? ' same' : ''}">${meta}<div class="cl-text">${clRichHtml(en.text)}</div></div>`
    }).join('')
  }
  const open = (p.entries.length || 1) <= 4 && imgN <= 2 && textLen <= 400 ? ' open' : ''
  return `<details class="chatlog-block"${open}>${head}<div class="cl-body">${body}</div></details>`
}
// 图文交错渲染（沉浸式预检单）：文本片段 esc（气泡 pre-wrap 保留换行）+ 〖截图〗令牌 → 内联 <img>；剥掉顶部引导行
function renderInlineShots(ev) {
  const text = (ev.text || '').split(IMMERSIVE_LEAD).join('').replace(/^\s+/, '')
  let html = '', last = 0, m
  const re = SHOT_RE()
  while ((m = re.exec(text))) {
    html += esc(text.slice(last, m.index))
    const relM = (m[1] || '').match(/office-lab\/app\/uploads\/([^\s｜]+)/)
    if (relM) {
      const rel = relM[1], name = ((m[1] || '').split('｜')[1] || '').trim()
      html += `<img class="bubble-img" src="/uploads/${esc(rel)}" title="${esc(name)}" onclick="window.open(this.src)" />`
    }
    last = m.index + m[0].length
  }
  html += esc(text.slice(last))
  return msgRow('user', html.trim(), '', ev._ts)
}
/* 分页加载更早历史：把一页事件用现成的 renderEvent「沙箱」渲染进游离容器再整体 prepend。
   renderEvent 严格正序追加且依赖一堆全局聚合态（curToolGroup/toolRows/lastKind/日期分隔/子代理块）——
   直接对更老事件调用会污染在跑的实时流。故这里存/复原全部渲染态 + 把输出重定向到游离 div，渲染完再还原。
   页内事件正序，工具组/子代理块在单页内自然成形；跨页边界的 tool_use↔tool_result 断链降级为孤立结果签（可接受）。 */
function renderHistoryBatch(events) {
  const frag = document.createElement('div')
  // 快照
  const snap = { curToolGroup, lastKind, lastRenderedDate, lastEmpText, appendRoot, curSubAgent, curSubAgentType, mainToolGroup, replaying, activeChatRoot, toolRows }
  const saMeta = Object.entries(subAgentMeta), saGroups = Object.entries(subAgents)
  // 重置为「干净沙箱」
  curToolGroup = null; lastKind = null; lastRenderedDate = ''; lastEmpText = ''
  appendRoot = null; curSubAgent = null; curSubAgentType = null; mainToolGroup = null
  toolRows = {}
  for (const k of Object.keys(subAgentMeta)) delete subAgentMeta[k]
  for (const k of Object.keys(subAgents)) delete subAgents[k]
  activeChatRoot = frag; replaying = true   // 输出重定向到游离容器 + 抑制贴底
  try { for (const ev of events) renderEvent(ev) } catch (e) { console.warn('[history] 渲染批次出错:', e) }
  // 还原
  curToolGroup = snap.curToolGroup; lastKind = snap.lastKind; lastRenderedDate = snap.lastRenderedDate; lastEmpText = snap.lastEmpText
  appendRoot = snap.appendRoot; curSubAgent = snap.curSubAgent; curSubAgentType = snap.curSubAgentType; mainToolGroup = snap.mainToolGroup
  replaying = snap.replaying; activeChatRoot = snap.activeChatRoot; toolRows = snap.toolRows
  for (const k of Object.keys(subAgentMeta)) delete subAgentMeta[k]
  for (const k of Object.keys(subAgents)) delete subAgents[k]
  for (const [k, v] of saMeta) subAgentMeta[k] = v
  for (const [k, v] of saGroups) subAgents[k] = v
  return frag
}

// 「加载更早」：往前翻一页历史，prepend 到顶部并锚定滚动位置（视口不跳）
let loadingEarlier = false
async function loadEarlier() {
  if (!currentRun || loadingEarlier || chatOldestSeq <= 1) return
  loadingEarlier = true
  const btn = $('load-earlier')
  if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.querySelector('.le-label').textContent = '加载中…' }
  try {
    // limit = 本页要凑够的「有意义消息」条数（后端按用户/助手气泡计数，工具调用/子代理/后台完成签不计入）
    const data = await (await fetch(`/api/runs/${currentRun}/history?before=${chatOldestSeq}&limit=25`)).json()
    const evs = data.events || []
    if (!evs.length) { if (btn) btn.remove(); return }
    const frag = renderHistoryBatch(evs)
    const out = $('run-output')
    const h0 = out.scrollHeight, t0 = out.scrollTop
    // 插到「按钮之后、其余内容之前」，保持按钮恒在最顶
    const anchor = btn ? btn.nextSibling : out.firstChild
    while (frag.firstChild) out.insertBefore(frag.firstChild, anchor)
    out.scrollTop = t0 + (out.scrollHeight - h0)   // 锚定：新增高度补进 scrollTop，视口内容不位移
    chatOldestSeq = evs[0]?._seq ?? chatOldestSeq
    if (!data.hasMore || chatOldestSeq <= 1) { if (btn) btn.remove() }
    else if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.querySelector('.le-label').textContent = '↑ 加载更早消息' }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.querySelector('.le-label').textContent = '↑ 加载更早消息' }
    toast('加载更早消息失败：' + (e.message || e), 'warn')
  } finally { loadingEarlier = false }
}
// 冷开回放结束、若还有更早历史 → 在聊天区顶部放「加载更早」按钮
function ensureLoadEarlierBtn() {
  const out = $('run-output'); if (!out) return
  let btn = $('load-earlier')
  if (chatOldestSeq > 1) {
    if (!btn) {
      btn = document.createElement('button')
      btn.id = 'load-earlier'; btn.type = 'button'; btn.className = 'load-earlier'
      btn.innerHTML = '<span class="le-label">↑ 加载更早消息</span>'
      btn.onclick = loadEarlier
    }
    out.insertBefore(btn, out.firstChild)   // 恒置顶
  } else if (btn) btn.remove()
}

function renderEvent(ev) {
  switchContext(ev.parent_tool_use_id || null)   // 子代理事件路由进嵌套块，顶层事件回主线
  if (ev.type === 'queued-accepted') { clearQueuedTags(); return }   // 排队消息被接受 → 清「排队中」标
  if (ev.type === 'user-msg') {
    const handoverText = String(ev.text || '')
    if (!ev._handoverUserText && (ev.engineHandover === true || handoverText.trimStart().startsWith('【基座交接 · 继续未完成任务】'))) {
      // Keep a real follow-up visible; machine context belongs in a closed capsule.
      if (String(ev.userText || '').trim()) renderEvent({ ...ev, _handoverUserText: true, engineHandover: false, text: ev.userText, userText: ev.userText, kind: 'chat' })
      return dispatchRow(`<details class="dispatch-chip engine-handover-message"><summary><span class="dc-badge">基座交接</span><span class="dc-lead">已附带任务与进度 · 查看原文</span></summary><pre class="dc-full" style="max-height:260px;overflow:auto">${esc(handoverText)}</pre></details>`, ev._ts)
    }
    // ⚡接管收尾：真正投递的消息（非排队）到达 → 中间态结束，清空输入框（形成「文字保留→停当前动作→真正插入」闭环）。回放/沙箱不触发。
    if (!replaying && takingOver && !ev.queued) exitInterrupting(true)
    // 老板自己敲的那条：气泡里只放他说的话，引擎注入（派工头 / 任务快照 / 同事近况 / 守航块）退到气泡下面折叠。
    // ev.userText 由引擎在事件上带（见 server.js startRun 的注释）；存量事件没有它 → 照旧走下面的派工折叠卡。
    // 同事间的【下一棒】/【抄送】不带 userText，仍显示折叠卡——那里「谁发的、什么类型」本身就是信息。
    let injectedRaw = ''
    const said = String(ev.userText || '').trim()
    if (said) {
      if (said !== String(ev.text || '').trim()) injectedRaw = ev.text || ''
      ev = { ...ev, text: said, kind: 'chat' }   // 按普通消息渲染（下面的派工分支不再命中）
    }
    // 沉浸式图文预检单：正文穿插 〖截图〗路径〖/截图〗 → 按顺序内联渲染（图文交错），不落入下方「末尾图库」逻辑。
    // 但聊天记录块内部也含 〖截图〗（图文穿插），那类由下方 chatlog 分支渲染——故仅「有截图且非聊天记录」才走沉浸式内联。
    if ((ev.text || '').includes(SHOT_OPEN) && !(ev.text || '').includes(CHATLOG_OPEN)) return renderInlineShots(ev)
    // 聊天记录哨兵段 → 可读折叠块（块内 〖截图〗由 chatlogBlockHtml 内联成图）；先抽走，避免其内部图片路径被下方「末尾图库」重复抓取
    let logsHtml = ''
    for (const m of (ev.text || '').matchAll(CHATLOG_RE())) logsHtml += chatlogBlockHtml(m[1])
    const textNoLogs = (ev.text || '').replace(CHATLOG_RE(), '')
    // 消息里的附件：解析「uploads/<相对路径>｜<展示名>」（旧格式无展示名也兼容），按扩展名区分图片/文件（在剥掉聊天记录块的正文里找）
    const imgs = [], files = []
    for (const m of textNoLogs.matchAll(/office-lab\/app\/uploads\/([^\s｜]+)(?:｜([^\n]*))?/g)) {
      const rel = m[1], name = (m[2] || '').trim()
      if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(rel))
        imgs.push(`<img class="bubble-img" src="/uploads/${esc(rel)}" title="${esc(name)}" onclick="window.open(this.src)" />`)
      else
        files.push(`<a class="bubble-file" href="/uploads/${esc(rel)}" target="_blank" rel="noopener" title="${esc(name || rel)}">${FILE_ICON}<span>${esc(name || rel.split('/').pop())}</span></a>`)
    }
    const attach = (imgs.length ? `<div class="bubble-imgs">${imgs.join('')}</div>` : '')
      + (files.length ? `<div class="bubble-files">${files.join('')}</div>` : '')
    const stripAll = s => s.replace(CHATLOG_RE(), '').replace(/\n*\[附(?:图|件)，请用 Read 工具查看\][\s\S]*$/, '').replace(/\n{3,}/g, '\n\n').trim()
    // 派工 / 抄送：折叠 chip（摘要一行，点开看正文）——避免整段注入 SOP + 同事近况霸屏，且正文按 markdown 渲染（此前铺成转义原文，**加粗**/`代码`/- 列表 全显示成字面 md）
    if (ev.kind === 'dispatch') {
      const raw = ev.text || ''
      // cc 头：【抄送】来自 X（并行知会…）：——须先去掉注入的【同事近况】块（其 peer-pulse 里也含别人的「【抄送】来自 …」，否则会抓错发起人）
      const noPulse = raw.replace(/【(?:任务快照|同事近况|完整档案)】[\s\S]*?(?=\n\s*\n|$)/g, '')
      const ccM = noPulse.match(/【抄送】\s*来自\s*(.+?)\s*[（(]/)
      const ccFrom = ccM ? ccM[1].trim() : ''
      const bodyRaw = stripDispatchNoise(raw.replace(CHATLOG_RE(), ''))   // 去注入块 + 抄送头 + markers + chatlog 哨兵 = 真正的正文
      const sys = systemNoticeHtml(bodyRaw)
      const bodyHtml = sys ? sys.html : bodyRaw ? mdRender(bodyRaw) : '<span class="dc-empty">（仅注入上下文，无正文）</span>'
      const head = sys ? `<span class="dc-badge sys">系统</span>` : ccFrom
        ? `<span class="dc-badge cc">抄送</span><span class="dc-from">来自 ${esc(ccFrom)}</span>`
        : `<span class="dc-badge">派工</span>`
      const chip = `<details class="dispatch-chip${sys ? ' sys-notice" open' : '"'}>`
        + `<summary>${head}<span class="dc-lead">${esc(sys ? sys.lead : dispatchLead(raw))}</span></summary>`
        + `<div class="dc-full dc-md md-mini">${bodyHtml}</div>`
        + `<details class="dc-raw"><summary>${sys ? '给员工的完整指令' : '查看派工原文（含同事近况/任务快照）'}</summary><pre>${esc(stripAll(raw))}</pre></details>`
        + `</details>${logsHtml}${attach}`
      return dispatchRow(chip, ev._ts)
    }
    // 聊天记录卡走气泡外（msgRow 第 5 参）：套在紫气泡里是「画框套画框」，且气泡的 pre-wrap/白字会污染卡内排版
    const textPart = esc(stripAll(ev.text || ''))
    // 老板那条消息真被注入过 → 气泡下挂一行小字，想看整段注入再展开
    const rawFold = injectedRaw
      ? `<details class="dc-raw msg-raw"><summary>查看完整指令（含任务快照 / 同事近况）</summary><pre>${esc(stripAll(injectedRaw))}</pre></details>`
      : ''
    return msgRow('user', textPart + attach, ev.queued ? 'queued' : '', ev._ts, logsHtml, rawFold)
  }
  if (ev.type === 'lab') {
    const t = ev.text || ''
    if (t.startsWith('📨 用户回复：')) return msgRow('user', esc(t.slice(8)))
    if (t.startsWith('▶ 派工：')) return msgRow('user', esc(t.slice(5)))
    if (!replaying && takingOver && /✅.*收工|❌|⚠️/.test(t)) exitInterrupting(false)   // 接管中会话却终结（未投递即收工/出错）→ 兜底解除中间态，保留输入便于重发
    if (/✅.*收工/.test(t)) { sysChip(t, 'ok'); setRunPill('done'); return }
    if (/❌|⚠️/.test(t)) { sysChip(t, 'bad'); if (/退出/.test(t)) setRunPill('error'); return }
    return sysChip(t)
  }
  if (ev.type === 'lab-sync') {   // 历史回放结束标记：定位到最新消息
    setRunPill(ev.status)
    replaying = false             // 回放结束：恢复逐条贴底跟随
    showChatLoading(false)        // 藏「加载消息…」转圈
    Object.values(pendingPerms).filter(e => e.runId === currentRun).forEach(showPermCard)   // 打开时补渲染仍挂起的审批卡
    const out = $('run-output')
    if (out) { out.scrollTop = out.scrollHeight; out.style.visibility = '' }   // 先贴底再显示，避免露出中途滚动
    ensureLoadEarlierBtn()        // 若还有更早历史 → 顶部放「加载更早」按钮
    scrollChatToBottom()          // 图片/markdown 异步撑高后再补贴几次
    return
  }
  if (ev.type === 'system' && ev.subtype === 'init')
    return sysChip(`会话启动 · ${ev.model || ''} · ${(ev.session_id || '').slice(0, 8)}`)
  if (ev.type === 'assistant' && ev.message?.content) {
    for (const c of ev.message.content) {
      if (c.type === 'text' && c.text?.trim()) { lastEmpText = c.text.trim(); renderEmpText(c.text, ev._ts) }
      if (c.type === 'tool_use') {
        let brief = ''
        try {
          const inp = c.input || {}
          if (c.name === 'Task' || c.name === 'Agent') {   // 记子代理类型/描述，父级行 brief 也用它
            subAgentMeta[c.id] = { type: inp.subagent_type || 'agent', desc: (inp.description || '').trim() }
            brief = subAgentMeta[c.id].type + (subAgentMeta[c.id].desc ? '：' + subAgentMeta[c.id].desc : '')
          } else {
            brief = String(inp.file_path || inp.command || inp.path || inp.pattern || inp.prompt || inp.description || '').replace(/\s+/g, ' ').slice(0, 160)
          }
        } catch { }
        addToolRow(c.name, brief, c.id, ev._ts)
      }
    }
    return
  }
  if (ev.type === 'user' && ev.message?.content) {   // stream-json 工具结果（原先被丢弃）：回填到对应工具行
    for (const c of (Array.isArray(ev.message.content) ? ev.message.content : [])) {
      if (c.type !== 'tool_result') continue
      const out = Array.isArray(c.content) ? c.content.map(x => x.text || '').join(' ') : (c.content || '')
      fillToolResult(c.tool_use_id, !!c.is_error, out, ev._ts)
      const sa = subAgents[c.tool_use_id]   // Task 收工：给子代理块盖结果戳（块保持收起）
      if (sa) {
        const st = sa.details.querySelector('.sa-status')
        if (st) { st.className = 'sa-status ' + (c.is_error ? 'err' : 'ok'); st.innerHTML = (c.is_error ? bicon('alert', 11) : bicon('check', 11)) + `<span>${c.is_error ? '出错' : '完成'}</span>` }
      }
    }
    return
  }
  if (ev.type === 'result') {
    // 成功的 result 正文与最后一条员工消息重复，只出状态签；失败才展示错误正文，
    // 但错误正文常与上一条 assistant 文本（如 API Error 524）逐字重复 → 去重，只留一份 + 状态签
    if (ev.is_error) {
      const errText = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result || '')
      if (errText.trim() && errText.trim() !== lastEmpText)
        msgRow('emp', `<div class="md-mini">${esc(errText)}</div>`, 'error')
    }
    if (!replaying) {   // 实时收工才刷新/改 pill；历史回放 + 分页沙箱渲染(replaying=true)跳过这些副作用，lab-sync 收尾会正确置 pill
      setRunPill(ev.is_error ? 'error' : 'done')
      loadRuns(); loadTasks()   // 收工后刷新（员工可能回写了任务档案）
    }
  }
}

/* ---------- 权限审批（canUseTool 把危险/未知命令路由到这里，需人工放行） ---------- */
let pendingPerms = {}   // reqId -> ev {runId, employee, reqId, toolName, brief, title}
function permCard(ev) {
  const div = document.createElement('div')
  div.className = 'perm-card'
  div.id = `perm-${ev.reqId}`
  const who = EMPLOYEES[ev.employee]?.displayName || ev.employee || '员工'
  div.innerHTML = `<div class="perm-top"><span class="perm-dot"></span><span class="perm-eyebrow">等待放行</span></div>`
    + `<div class="perm-head">${esc(who)} 请求执行 <b>${esc(ev.toolName || '工具')}</b></div>`
    + `<pre class="perm-cmd">${esc(ev.brief || ev.title || '(无参数)')}</pre>`
    + `<div class="perm-actions"><button class="btn sm secondary" data-act="deny">拒绝</button><button class="btn sm primary" data-act="allow">允许</button></div>`
  div.querySelector('[data-act="allow"]').onclick = () => resolvePerm(ev.runId, ev.reqId, 'allow', div)
  div.querySelector('[data-act="deny"]').onclick = () => resolvePerm(ev.runId, ev.reqId, 'deny', div)
  return div
}
function showPermCard(ev) {
  if (currentRun !== ev.runId || $(`perm-${ev.reqId}`)) return
  appendNode(permCard(ev))
  scrollChatToBottom()
}
async function resolvePerm(runId, reqId, behavior, el) {
  if (el) el.querySelectorAll('button').forEach(b => (b.disabled = true))
  try {
    await fetch(`/api/runs/${runId}/permission`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reqId, behavior }),
    })
  } catch { }
  if (el) {
    el.classList.add('resolved', behavior === 'allow' ? 'allow' : 'deny')
    const eb = el.querySelector('.perm-eyebrow'); if (eb) eb.textContent = behavior === 'allow' ? '已允许' : '已拒绝'
    const acts = el.querySelector('.perm-actions'); if (acts) acts.remove()
  }
}
function removePermCard(reqId) {
  delete pendingPerms[reqId]
  const el = $(`perm-${reqId}`)
  if (el) setTimeout(() => el.remove(), 1500)
}

/* ---------- 附件：粘贴 / 拖拽 / 选择（图片 + 任意文件） ---------- */
let pendingFiles = []   // {path, url, name, kind:'image'|'file', mime}
let pendingChatlogs = []   // 待发聊天记录块：{format, raw, entries, meta} —— 见 parseChatlog
const FILE_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
function renderAttach() {
  const box = $('composer-attach')
  box.classList.toggle('hidden', pendingFiles.length === 0 && pendingChatlogs.length === 0)
  // 附件 chip：上传中显示转圈遮罩、失败显示红角标（参照 shadcn Attachment 的 upload state）
  const fileChips = pendingFiles.map((f, i) => {
    const rm = `<button type="button" class="attach-x" onclick="removeAttach(${i})">✕</button>`
    const state = f.uploading ? '<span class="attach-spin" title="上传中…"></span>' : f.error ? '<span class="attach-err" title="上传失败，请移除重试">!</span>' : ''
    const cls = `attach-item${f.kind === 'image' ? '' : ' file'}${f.uploading ? ' uploading' : ''}${f.error ? ' error' : ''}`
    return f.kind === 'image'
      ? `<span class="${cls}" title="${esc(f.name || '')}">${f.url ? `<img src="${esc(f.url)}" />` : ''}${state}${rm}</span>`
      : `<span class="${cls}" title="${esc(f.name || '')}"><span class="attach-file-ic">${FILE_ICON}</span><span class="attach-file-name">${esc(f.name || '文件')}</span>${state}${rm}</span>`
  }).join('')
  const logChips = pendingChatlogs.map((c, i) => {
    const label = c.format === 'raw' ? '聊天记录（原文）' : `聊天记录 · ${c.meta.count}条 · ${esc(c.meta.participants.join('、'))}`
    return `<span class="attach-item chatlog-chip" title="${esc(c.meta.span || '')}">📋 <span class="attach-file-name">${label}</span><button type="button" class="attach-x" onclick="removeChatlog(${i})">✕</button></span>`
  }).join('')
  box.innerHTML = fileChips + logChips
}
function removeAttach(i) { pendingFiles.splice(i, 1); renderAttach() }
function removeChatlog(i) { pendingChatlogs.splice(i, 1); renderAttach() }

// 上传一个文件到 uploads/，返回 {path,url,name,kind,mime}；失败返回 null（composer 附件与沉浸式编辑器共用）
async function uploadFile(file) {
  if (!file) return null
  const dataURL = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(file) })
  try {
    const resp = await (await fetch('/api/upload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: dataURL, name: file.name || '' }),
    })).json()
    if (resp.path) return resp
    sysChip('⚠ 上传失败：' + (resp.error || '未知错误'), 'bad'); return null
  } catch { sysChip('⚠ 上传失败', 'bad'); return null }
}
async function uploadOne(file) {
  // 先落一个「上传中」占位 chip（图片带本地预览），上传完成再原位替换成服务器结果 / 失败态
  const isImg = (file.type || '').startsWith('image/')
  const ph = { uploading: true, name: file.name || (isImg ? '图片' : '文件'), kind: isImg ? 'image' : 'file' }
  if (isImg) { try { ph.url = URL.createObjectURL(file) } catch { } }
  pendingFiles.push(ph); renderAttach()
  const resp = await uploadFile(file)
  const i = pendingFiles.indexOf(ph)
  if (resp) {
    if (ph.url) { try { URL.revokeObjectURL(ph.url) } catch { } }   // 换成服务器 URL，释放本地预览
    if (i >= 0) pendingFiles.splice(i, 1, resp); else pendingFiles.push(resp)
  } else if (i >= 0) {
    pendingFiles.splice(i, 1, { ...ph, uploading: false, error: true })   // 失败：保留 chip 供用户看到并移除
  }
  renderAttach()
}
async function uploadMany(fileList) {
  const files = [...(fileList || [])]
  if (!files.length) return false
  for (const f of files) await uploadOne(f)
  return true
}

// 粘贴：剪贴板里的文件（截图或从 Finder 拷贝的文件）→ 上传；纯文本粘贴不拦截
$('reply-text').addEventListener('paste', async e => {
  const fromFiles = [...(e.clipboardData?.files || [])]
  const fromItems = [...(e.clipboardData?.items || [])].filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean)
  const files = fromFiles.length ? fromFiles : fromItems
  if (!files.length) return
  e.preventDefault()
  await uploadMany(files)
})

// 选择文件按钮
$('attach-input').addEventListener('change', async e => {
  await uploadMany(e.target.files)
  e.target.value = ''   // 允许重复选同一文件
})

// 拖拽到聊天坞任意处上传
;(() => {
  const panel = $('chat-panel')
  let depth = 0
  const show = on => panel.classList.toggle('dropping', on)
  panel.addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; show(true) } })
  panel.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault() })
  panel.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; show(false) } })
  panel.addEventListener('drop', async e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return
    e.preventDefault(); depth = 0; show(false)
    await uploadMany(e.dataTransfer.files)
  })
})()

/* ---------- 沉浸式图文编辑器（写给菲菲的图文预检单：文字＋内联截图，图文按顺序一起发）---------- */
let immersivePending = 0     // 进行中的上传数：>0 时禁用「发送」防误发
let immersiveRange = null    // 粘贴/选图前保存的光标位置，异步上传回来后在此插图

function openImmersiveEditor() {
  const ed = $('immersive-editor')
  ed.innerHTML = ''
  immersivePending = 0; immersiveRange = null
  updateImmersiveSend()
  $('immersive-modal').classList.remove('hidden')
  ed.focus()
}
function closeImmersiveEditor() { $('immersive-modal').classList.add('hidden') }
function updateImmersiveSend() {
  $('immersive-send').disabled = immersivePending > 0
  $('immersive-hint').textContent = immersivePending > 0 ? `上传中…（${immersivePending}）` : ''
}

// 保存编辑器内当前选区（异步上传期间失焦也能插回原处）
function saveImmersiveRange() {
  const sel = window.getSelection()
  if (sel && sel.rangeCount && $('immersive-editor').contains(sel.anchorNode)) immersiveRange = sel.getRangeAt(0).cloneRange()
}
// 在保存的光标处插入一张已上传的图片（dataset 存路径/名，供发送时按序取）；range 失效则追加到末尾
function insertImmersiveImg(resp) {
  const ed = $('immersive-editor')
  const img = document.createElement('img')
  img.src = resp.url; img.dataset.path = resp.path; img.dataset.name = resp.name || ''
  const br = document.createElement('br')
  let range = immersiveRange
  if (!range || !ed.contains(range.startContainer)) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false) }
  range.collapse(false)
  range.insertNode(br)
  range.insertNode(img)
  range.setStartAfter(br); range.collapse(true)   // 光标移到图片之后
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
  immersiveRange = range.cloneRange()
}
async function immersiveUpload(files) {
  const imgs = [...(files || [])].filter(f => (f.type || '').startsWith('image/') && f.size > 0)   // 挡掉 0 字节「空图片」（某些应用粘贴会带空图占位）
  if (!imgs.length) return
  for (const f of imgs) {
    immersivePending++; updateImmersiveSend()
    const resp = await uploadFile(f)
    immersivePending--
    if (resp && resp.path) insertImmersiveImg(resp)   // 上传失败/无路径不插破图
    updateImmersiveSend()
  }
}
// ---------- 富编辑器（contenteditable 图文混排）删除修正 ----------
// 问题：插入的 <img>（我们的结构是 img 紧跟 br、光标落在 br 之后的编辑器边界）在 contenteditable 里
//   Backspace/Delete 常删不掉，某些浏览器在这个不稳定光标位还会把 Backspace 变成「反向删除」(删光标后内容)。
// 修法：collapsed 光标紧邻图片时，手动删掉图片（连同它那根配对 br），preventDefault，行为确定。非图片边界一律交默认（正常删字符/换行）。
function richNodeBeside(ed, range, dir) {   // dir: -1=前(Backspace)  +1=后(Delete)
  const c = range.startContainer, o = range.startOffset
  if (c.nodeType === 3) {                    // 文本节点内
    if (dir < 0 && o > 0) return null        // 文本中间删字符 → 默认
    if (dir > 0 && o < (c.nodeValue || '').length) return null
    let n = c                                // 处于文本边界 → 上溯到 ed 直接子级再取相邻
    while (n && n !== ed && !(dir < 0 ? n.previousSibling : n.nextSibling)) n = n.parentNode
    if (!n || n === ed) return null
    return dir < 0 ? n.previousSibling : n.nextSibling
  }
  if (dir < 0) return o > 0 ? c.childNodes[o - 1] : null   // 元素容器(含 ed)：取 o 处相邻子节点
  return c.childNodes[o] || null
}
function richEditorDeleteFix(ed, onChange) {
  ed.addEventListener('keydown', e => {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (!range.collapsed || !ed.contains(range.startContainer)) return   // 有选区（默认会连图一起删）/ 焦点不在内 → 交默认
    const dir = e.key === 'Backspace' ? -1 : 1
    const node = richNodeBeside(ed, range, dir)
    let img = null, pairBr = null
    if (node && node.nodeName === 'IMG') { img = node; if (img.nextSibling && img.nextSibling.nodeName === 'BR') pairBr = img.nextSibling }
    else if (node && node.nodeName === 'BR') {   // 命中 img 的配对 br：连同前/后那张 img 一起删
      const sib = dir < 0 ? node.previousSibling : node.nextSibling
      if (sib && sib.nodeName === 'IMG') { img = sib; pairBr = node }
    }
    if (!img) return   // 非图片边界 → 默认（正常删字符/换行/合并行）
    e.preventDefault()
    const r = document.createRange(); r.setStartBefore(img); r.collapse(true)
    img.remove(); if (pairBr) pairBr.remove()
    sel.removeAllRanges(); sel.addRange(r)
    if (typeof onChange === 'function') onChange()
  })
}

// 走一个 contenteditable 的 DOM（document 序）→ 文本累加，遇内联图 flush 文本再插 〖截图〗 哨兵行
// （沉浸式预检单编辑器 + 聊天记录富编辑器共用；纯函数，传入编辑器元素）
function serializeRichEditor(ed) {
  let out = ''
  const walk = node => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) out += n.nodeValue
      else if (n.nodeName === 'IMG') {
        const path = n.dataset.path; if (!path) continue
        if (out && !out.endsWith('\n')) out += '\n'
        out += SHOT_OPEN + path + '｜' + (n.dataset.name || '') + SHOT_CLOSE + '\n'
      }
      else if (n.nodeName === 'BR') out += '\n'
      else if (n.nodeName === 'DIV' || n.nodeName === 'P') { if (out && !out.endsWith('\n')) out += '\n'; walk(n) }
      else walk(n)
    }
  }
  walk(ed)
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
function buildImmersiveMessage() { return serializeRichEditor($('immersive-editor')) }
async function sendImmersiveEditor() {
  if (immersivePending > 0) return
  const body = buildImmersiveMessage()
  if (!body) { $('immersive-editor').focus(); return }
  const ok = await sendComposed(IMMERSIVE_LEAD + '\n\n' + body, 'chat', null)
  if (ok) closeImmersiveEditor()
}
// 编辑器事件：粘贴/拖入/选择图片 → 上传并内联；保存选区供异步插入
;(() => {
  const ed = $('immersive-editor')
  if (!ed) return
  richEditorDeleteFix(ed)   // 图片删除修正（Backspace/Delete 确定性删图，防反向删除）
  ed.addEventListener('keyup', saveImmersiveRange)
  ed.addEventListener('mouseup', saveImmersiveRange)
  ed.addEventListener('paste', async e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => (f.type || '').startsWith('image/') && f.size > 0)
    if (!files.length) return   // 纯文本粘贴不拦截，走默认
    e.preventDefault(); saveImmersiveRange()
    await immersiveUpload(files)
  })
  ed.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault() })
  ed.addEventListener('drop', async e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return
    e.preventDefault()
    const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null
    if (r && ed.contains(r.startContainer)) immersiveRange = r; else saveImmersiveRange()
    await immersiveUpload(e.dataTransfer.files)
  })
  $('immersive-file').addEventListener('change', async e => {
    saveImmersiveRange()
    await immersiveUpload(e.target.files)
    e.target.value = ''
  })
})()

// 聊天记录富编辑器事件：粘贴/拖入/选择图片 → 上传内联（图文按聊天顺序穿插）；文本变化刷新预览。自成一套 range/pending，不动沉浸式编辑器。
;(() => {
  const ed = $('chatlog-input')
  if (!ed) return
  const saveRange = () => {
    const sel = window.getSelection()
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) chatlogRange = sel.getRangeAt(0).cloneRange()
  }
  const insertImg = (resp) => {
    const img = document.createElement('img')
    img.src = resp.url; img.dataset.path = resp.path; img.dataset.name = resp.name || ''
    const br = document.createElement('br')
    let range = chatlogRange
    if (!range || !ed.contains(range.startContainer)) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false) }
    range.collapse(false); range.insertNode(br); range.insertNode(img)
    range.setStartAfter(br); range.collapse(true)
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
    chatlogRange = range.cloneRange()
    updateChatlogPreview()
  }
  const upload = async (files) => {
    const imgs = [...(files || [])].filter(f => (f.type || '').startsWith('image/') && f.size > 0)   // 挡掉 0 字节「空图片」
    if (!imgs.length) return
    const hint = $('chatlog-hint'), btn = $('chatlog-confirm')
    for (const f of imgs) {
      chatlogPending++; if (hint) hint.textContent = `上传中…（${chatlogPending}）`; if (btn) btn.disabled = true
      const resp = await uploadFile(f)
      chatlogPending--
      if (resp && resp.path) insertImg(resp)   // 上传失败/无路径不插破图
      if (hint) hint.textContent = chatlogPending > 0 ? `上传中…（${chatlogPending}）` : ''
      if (btn && chatlogPending === 0) btn.disabled = false
    }
  }
  richEditorDeleteFix(ed, updateChatlogPreview)   // 图片删除修正（删图后刷新预览）
  ed.addEventListener('input', updateChatlogPreview)
  ed.addEventListener('keyup', saveRange)
  ed.addEventListener('mouseup', saveRange)
  // 在光标处插入一段片段（文本节点 + 图片），光标落到末尾
  const insertFrag = (nodes) => {
    let range = chatlogRange
    const sel = window.getSelection()
    if (sel && sel.rangeCount && ed.contains(sel.anchorNode)) range = sel.getRangeAt(0)
    if (!range || !ed.contains(range.startContainer)) { range = document.createRange(); range.selectNodeContents(ed); range.collapse(false) }
    range.deleteContents()
    const frag = document.createDocumentFragment(); nodes.forEach(n => frag.appendChild(n))
    const last = frag.lastChild
    range.insertNode(frag)
    if (last) { range.setStartAfter(last); range.collapse(true) }
    sel.removeAllRanges(); sel.addRange(range)
    chatlogRange = range.cloneRange()
    updateChatlogPreview()
  }
  // 企微多选复制：纯文本是标准「姓名(姓名) M/D HH:MM:SS」格式、图片处写 [图片]；HTML 里按同样顺序给出图片的本地缓存路径
  // （…/WXWork/<账号>/Cache/Image/…）。以纯文本为骨架，把第 i 个 [图片] 换成第 i 张缓存图（经本机服务拷进 uploads/）。
  // 表情在 HTML 里是 Temp 目录的小图，纯文本里已是 [破涕为笑] 这类文字，不取。
  const wecomImgPaths = (html) => [...html.matchAll(/<img[^>]+src="file:\/\/\/([^"]+)"/gi)]
    .map(m => { try { return decodeURIComponent(m[1]) } catch { return m[1] } })
    .filter(p => /[\\/]WXWork[\\/][^\\/]+[\\/]Cache[\\/]Image[\\/]/i.test(p))
  const uploadLocal = async (p) => {
    try {
      const r = await (await fetch('/api/upload-local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })).json()
      return r && r.path ? r : null
    } catch { return null }
  }
  ed.addEventListener('paste', async e => {
    const cd = e.clipboardData
    const files = [...(cd?.files || [])].filter(f => (f.type || '').startsWith('image/') && f.size > 0)
    if (files.length) { e.preventDefault(); saveRange(); await upload(files); return }
    // 其余一律按纯文本插入：不让来源富文本（样式/缩进/读不到的 file:// 图）进编辑器
    e.preventDefault(); saveRange()
    const text = (cd?.getData('text/plain') || '').replace(/\r\n/g, '\n')
    const html = cd?.getData('text/html') || ''
    const paths = html.includes('wxwork-data') ? wecomImgPaths(html) : []
    const parts = paths.length ? text.split('[图片]') : [text]
    if (parts.length === 1) { insertFrag([document.createTextNode(text)]); return }
    const hint = $('chatlog-hint'), btn = $('chatlog-confirm')
    chatlogPending++; if (hint) hint.textContent = `正在带入企微图片…（${parts.length - 1} 张）`; if (btn) btn.disabled = true
    const resps = await Promise.all(parts.slice(1).map((_, i) => paths[i] ? uploadLocal(paths[i]) : null))
    chatlogPending--; if (btn && chatlogPending === 0) btn.disabled = false
    const nodes = [], miss = resps.filter(r => !r).length
    parts.forEach((t, i) => {
      if (i > 0) {
        const r = resps[i - 1]
        if (r) {
          const img = document.createElement('img')
          img.src = r.url; img.dataset.path = r.path; img.dataset.name = r.name || ''
          nodes.push(img)
          t = t.replace(/^[ \t]+/, '')   // 图独占一块，吃掉 [图片] 后的空格
        } else nodes.push(document.createTextNode('[图片·未能带入，可手动拖入]'))
      }
      if (t) nodes.push(document.createTextNode(t))
    })
    insertFrag(nodes)
    if (hint) hint.textContent = miss ? `${miss} 张图片没能自动带入（企微可能还没缓存原图，在企微里点开一次再复制，或手动拖入）` : ''
  })
  ed.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault() })
  ed.addEventListener('drop', async e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return
    e.preventDefault()
    const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null
    if (r && ed.contains(r.startContainer)) chatlogRange = r; else saveRange()
    await upload(e.dataTransfer.files)
  })
  $('chatlog-file').addEventListener('change', async e => {
    saveRange()
    await upload(e.target.files)
    e.target.value = ''
  })
})()

/* ---------- 发消息（聊天 / 派工） ---------- */
let dispatchMode = false
function setDispatchMode(on) {
  dispatchMode = on
  $('r-dispatch').classList.toggle('primary', on)
  $('r-dispatch').classList.toggle('secondary', !on)
  $('r-task').classList.toggle('hidden', !on)
  if (!$('reply-text').disabled)
    $('reply-text').placeholder = on ? '写派工指令…（员工将走完整 SOP 并回写任务档案）' : '和员工聊聊…（随意聊；点「派工」发正式任务）'
}
function toggleDispatchMode() { setDispatchMode(!dispatchMode) }

$('reply-form').addEventListener('submit', async e => {
  e.preventDefault()
  let message = $('reply-text').value.trim()
  if (pendingFiles.some(f => f.uploading)) { toast('附件还在上传，稍等一下再发', 'warn'); return }
  const readyFiles = pendingFiles.filter(f => f.path && !f.error)   // 只发上传成功、有路径的；占位/失败态不进消息
  if (!message && !readyFiles.length && !pendingChatlogs.length) return
  if (readyFiles.length) {
    // 每行「- <路径>｜<展示名>」：员工用 Read 工具读路径，前端按扩展名区分图片/文件渲染
    const lines = readyFiles.map(f => `- ${f.path}｜${f.name || ''}`).join('\n')
    message = (message || '请查看附件。') + '\n\n[附件，请用 Read 工具查看]\n' + lines
    pendingFiles = []; renderAttach()
  }
  if (pendingChatlogs.length) {
    // 哨兵包裹原文追加：菲菲拿到完整聊天记录去提炼/登记，前端据哨兵渲染成可读折叠块
    const blocks = pendingChatlogs.map(c => `${CHATLOG_OPEN}\n${c.raw}\n${CHATLOG_CLOSE}`).join('\n\n')
    const hasImg = pendingChatlogs.some(c => (c.raw || '').includes(SHOT_OPEN))
    const lead = message || '帮我看下这段聊天记录，整理成需求。'
    const imgHint = hasImg ? '\n（聊天记录里穿插了截图，标记 〖截图〗 内是图片路径，请逐张用 Read 工具查看）' : ''
    message = lead + imgHint + '\n\n' + blocks
    pendingChatlogs = []; renderAttach()
  }
  const kind = dispatchMode ? 'dispatch' : 'chat'
  const taskFile = dispatchMode ? ($('r-task').value || null) : null
  await sendComposed(message, kind, taskFile)
})

/* 传输一条已组装好的消息：有当前会话→reply 续跑；否则对当前员工→dispatch 起新会话。
   composer 提交与沉浸式编辑器共用；返回是否发出成功。 */
async function sendComposed(message, kind = 'chat', taskFile = null) {
  if (currentRun) {
    const resp = await fetch(`/api/runs/${currentRun}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, kind, taskFile }),
    })
    if (resp.ok) {
      const r = await resp.json().catch(() => ({}))
      $('reply-text').value = ''; autoGrowReply(); setDispatchMode(false); setRunPill('running'); loadRuns()
      const name = EMPLOYEES[curEmployee]?.displayName || '员工'
      if (r.queued) sysChip(`↩ 已排队，${name}忙完手头这步就接（不打断当前动作）`, 'ok')
      else if (r.takeover) sysChip('🔧 会话疑似卡死，已强制接管并投递你的消息', 'ok')
      return true
    }
    const err = (await resp.json().catch(() => ({}))).error || '发送失败'
    sysChip(resp.status === 409 && err === 'still running' ? '⚠ 员工仍在运行中，请稍候；若长时间无响应可点「停止」后重发' : '⚠ ' + err, 'bad')
    return false
  } else if (curEmployee) {
    const resp = await fetch('/api/dispatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employee: curEmployee, instruction: message, kind, taskFile }),
    })
    const r = await resp.json().catch(() => ({}))
    // 并发闸：该员工已有在跑的会话 → 不新派，提示先等收工/停止（保留输入，便于稍后重发）
    if (resp.status === 409 && r.error === 'employee busy') {
      sysChip(`⚠ ${r.displayName || '该员工'} 正在跑另一条会话，先等它收工、或在该会话里「停止」后再派（避免并发改同一工作树）`, 'bad')
      return false
    }
    $('reply-text').value = ''
    autoGrowReply()
    setDispatchMode(false)
    await loadRuns()
    if (r.runId) openRun(r.runId)
    return true
  }
  return false
}
/* Enter 发送，Shift+Enter 换行。输入法三重防护：
   ① isComposing/keyCode 229（Chrome 组词中的 Enter）
   ② 手动跟踪 composition 状态
   ③ compositionend 后 150ms 冷却（Safari 等先发 compositionend 再发 keydown 的时序，
      上屏 Enter 到达时组词标记已清空，靠时间窗兜住） */
let imeComposing = false
let imeEndAt = 0
$('reply-text').addEventListener('compositionstart', () => { imeComposing = true })
$('reply-text').addEventListener('compositionend', () => { imeComposing = false; imeEndAt = Date.now() })
$('reply-text').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey) return
  if (e.isComposing || e.keyCode === 229 || imeComposing || Date.now() - imeEndAt < 150) return
  e.preventDefault()
  $('reply-form').requestSubmit()
})

/* 输入框按内容自动伸长：先归零再取 scrollHeight，交给 CSS 的 min/max-height 兜底。
   超过 max-height 时 textarea 内部滚动（overflow-y:auto），不撑高整个工作台。
   input / 粘贴 / 输入法结束 / 清空后都要重算；导出成全局供 sendComposed 等清空处调用。 */
function autoGrowReply() {
  const ta = $('reply-text'); if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = ta.scrollHeight + 'px'
}
$('reply-text').addEventListener('input', autoGrowReply)
$('reply-text').addEventListener('compositionend', autoGrowReply)
autoGrowReply()   // 初始（含刷新后残留草稿）

/* ---------- 主题 ---------- */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  $('theme-icon-dark').classList.toggle('hidden', theme === 'light')   // 亮色下显示太阳
  $('theme-icon-light').classList.toggle('hidden', theme !== 'light')
  // 状态栏/刘海区跟随主题染色（值对齐 CSS 的 --canvas：深 #010102 / 浅 #ffffff）
  const meta = $('theme-color-meta')
  if (meta) meta.content = theme === 'light' ? '#ffffff' : '#010102'
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
  localStorage.setItem('ol-theme', next)
  applyTheme(next)
}
function initTheme() {
  const q = new URLSearchParams(location.search).get('theme')
  const saved = q || localStorage.getItem('ol-theme')
  applyTheme(saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'))
}

/* ---------- 全局 SSE：状态变更即时推送（轮询降频为兜底） ---------- */
let refreshTimer = null
function refreshSoon() {   // 短防抖：合并突发事件
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(loadRuns, 150)
}
function connectGlobalSSE() {
  const es = new EventSource('/api/events')
  es.onmessage = m => {
    try {
      const ev = JSON.parse(m.data)
      if (ev.type === 'run-status') refreshSoon()
      if (ev.type === 'patrol-detected' || ev.type === 'patrol-resume' || ev.type === 'patrol-escalate') patrolBurst()   // 巡查一开始就放大波涟漪（不依赖轮询抓那短暂窗口）
      if (ev.type === 'patrol-pending' && ev.runId === currentRun) showPatrolBanner(ev.runId, ev.deadline, ev.graceSec)   // 宽限窗开始：本会话上方起倒计时横幅
      if (ev.type === 'patrol-cancelled' && ev.runId === currentRun)   // 撤销：回话→直接滑走；点取消→已取消态微弹
        (ev.reason === 'user-reply') ? finishPatrolBanner('reply', '你已接手，取消接管') : finishPatrolBanner('cancelled', '已取消接管，这条交给你')
      if (ev.type === 'patrol-detected' && ev.runId === currentRun && _patrolBannerRun === currentRun) finishPatrolBanner('taken', `${patrolName()}已接管，正在查看…`)   // 走完窗口真派 → 横幅收尾
      if (ev.type === 'run-deleted') { if (currentRun === ev.runId) closeChat(); refreshSoon() }
      if (ev.type === 'run-pinned') {   // 别处置顶/取消置顶 → 同步本地缓存与选择器（若正开着）
        const r = runsCache.find(x => x.id === ev.runId); if (r) r.pinned = ev.pinned
        if (threadMenuOpen) renderThreadMenu()
        if (currentRun === ev.runId) { const cr = runsCache.find(x => x.id === currentRun); if (cr) { renderRunHead(cr); setRunPill(cr.status, cr) } }
      }
      if (ev.type === 'run-interrupting' && currentRun === ev.runId) setRunPill('interrupting')   // ⚡接管中间态：翻 pill（本机由 enterInterrupting 已翻，此处兼顾其它客户端），resume 起 running 时自然复位
      if (ev.type === 'run-activity') {
        liveActivity[ev.employee] = ev.activity
        const act = $(`emp-act-${ev.employee}`)                          // 侧边栏实时更新，不等轮询
        if (act) { act.textContent = '正在：' + ev.activity; act.className = 'emp-l2 busy' }
        if (currentRun && ev.runId === currentRun) setTyping(true, ev.activity)   // 当前会话打字指示带活动标签
      }
      if (ev.type === 'run-bg') {   // 后台任务集 level 事件：更新缓存 + 侧边栏「后台运行中」 + 当前会话 pill
        const r = runsCache.find(x => x.id === ev.runId)
        if (r) r.bgTasks = (ev.tasks && ev.tasks.length) ? ev.tasks : undefined
        renderEmpStatus()
        if (currentRun === ev.runId) { const cr = runsCache.find(x => x.id === ev.runId); if (cr) setRunPill(cr.status, cr) }
      }
      if (ev.type === 'pending-changed') {   // 某员工待处理队列变化 → 更新缓存 + 侧边栏徽标/文案（若正开着列表也刷新）
        pendingCache[ev.employee] = ev.items || []
        renderEmpStatus()
        if (_pendingPopFor === ev.employee) renderPendingList(ev.employee)
      }
      if (ev.type === 'run-bg-settled') {
        const name = EMPLOYEES[ev.employee]?.displayName || ev.employee
        const word = ev.status === 'completed' ? '完成' : ev.status === 'failed' ? '失败' : '停止'
        toast(`${name} 后台任务${word}${ev.summary ? '：' + ev.summary.slice(0, 40) : ''}`, ev.status === 'completed' ? 'ok' : 'warn')
        refreshSoon()
      }
      if (ev.type === 'run-stalled') {
        toast(`⚠️ ${EMPLOYEES[ev.employee]?.displayName || ev.employee} 疑似卡死（${Math.round((ev.idleMs || 0) / 1000)}s 无输出），正在终止并自动续跑`, 'warn')
        refreshSoon()
      }
      if (ev.type === 'run-retry') {
        toast(`🔁 ${EMPLOYEES[ev.employee]?.displayName || ev.employee} ${ev.reason === 'stalled' ? '卡死' : '连接中断'}，自动续跑 ${ev.attempt}/${ev.maxRetries}`, 'warn')
        refreshSoon()
      }
      if (ev.type === 'tasks-changed') loadTasks()
      if (ev.type === 'handoff') {
        const from = EMPLOYEES[ev.from]?.displayName || ev.from
        const to = EMPLOYEES[ev.to]?.displayName || ev.to
        const verb = ev.kind === 'return' ? '↩️ 回发' : ev.kind === 'cc' ? '📋 抄送（并行）' : ev.kind === 'cc-join' ? '🧩 抄送汇合（全部收工，唤回收口）' : '🔗 自动接棒'
        toast(`${verb}：${from} → ${to}`, 'ok')
        refreshSoon(); refreshChainSoon()
      }
      if (ev.type === 'handoff-blocked') { toast(`⏸ ${ev.text || '自动接棒已停下'}`, 'warn'); refreshChainSoon() }
      if (ev.type === 'conversation') refreshChainSoon()
      if (ev.type === 'permission-request') {
        pendingPerms[ev.reqId] = ev
        if (currentRun === ev.runId) showPermCard(ev)
        else toast(`⏸ ${EMPLOYEES[ev.employee]?.displayName || ev.employee} 请求执行 ${ev.toolName}：${ev.brief || ''} —— 打开会话审批`, 'warn')
      }
      if (ev.type === 'permission-resolved') removePermCard(ev.reqId)
      // ---- 会议室 ----
      if (ev.type === 'meeting-speaking' && currentMeeting === ev.meetingId) setMeetingTyping(ev.speaker)
      if (ev.type === 'meeting-status') { if (currentMeeting === ev.meetingId) setMeetingPill(ev.status); refreshMeetingsSoon() }
      if (ev.type === 'meeting-deleted') { if (currentMeeting === ev.meetingId) currentMeeting = null; refreshMeetingsSoon() }
      if (ev.type === 'meeting-msg') refreshMeetingsSoon()
    } catch { }
  }
  es.onerror = () => { es.close(); setTimeout(connectGlobalSSE, 3000) }   // 断线自动重连
}

/* ---------- 轻量 toast（自动接棒/阻塞提示） ---------- */
function toast(msg, kind) {
  const host = $('toast-host')
  if (!host) return
  const el = document.createElement('div')
  el.className = 'toast' + (kind ? ' ' + kind : '')
  const ic = kind === 'ok' ? bicon('check', 14) : (kind === 'warn' || kind === 'bad') ? bicon('alert', 14) : ''
  el.innerHTML = `${ic}<span>${esc(stripLeadIcon(msg))}</span>`
  host.appendChild(el)
  requestAnimationFrame(() => el.classList.add('show'))
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300) }, 6000)
}

/* ---------- 自动接棒开关（混合扳机：无拍板则自动派下一棒） ---------- */
let chainEnabled = true
function renderChainToggle() {
  const btn = $('chain-toggle')
  if (!btn) return
  btn.classList.toggle('chain-on', chainEnabled)
  btn.classList.toggle('chain-off', !chainEnabled)
  btn.title = chainEnabled ? '自动接棒：开（无拍板则自动派下一棒，点击关闭）' : '自动接棒：关（交接需手动接棒，点击开启）'
  // 同步会话看板顶部的开关（若已渲染）
  const cb = $('cv-chain-enabled')
  if (cb) { cb.checked = chainEnabled; const lbl = cb.nextElementSibling; if (lbl) lbl.textContent = `自动接棒 ${chainEnabled ? '开' : '关'}` }
}
async function loadChainConfig() {
  try { const cfg = await (await fetch('/api/chain-config')).json(); chainEnabled = cfg.enabled !== false } catch { }
  renderChainToggle()
}
async function toggleChain() {
  const next = !chainEnabled
  try {
    const r = await (await fetch('/api/chain-config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }),
    })).json()
    chainEnabled = r.config ? r.config.enabled !== false : next
    renderChainToggle()
    toast(chainEnabled ? '自动接棒已开启' : '自动接棒已关闭', chainEnabled ? 'ok' : 'warn')
  } catch (e) { toast('切换失败：' + (e.message || e), 'warn') }
}
// 小呆呆「巡视设置」弹窗保存：只 POST patrol* 字段（服务端只更新传入字段，不动 autochain 的 enabled）
async function savePatrolConfig(btn) {
  const graceRaw = Number($('pat-grace')?.value)
  const body = {
    patrolEnabled: $('pat-enabled').checked,
    patrolSweepMin: Number($('pat-sweep').value) || 6,
    patrolGraceSec: Number.isFinite(graceRaw) ? graceRaw : 8,   // 允许 0（关闭宽限窗）
    patrolMax: Number($('pat-max').value) || 6,
  }
  if (btn) { btn.disabled = true; btn.textContent = '保存中…' }
  try {
    const r = await (await fetch('/api/chain-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()
    const c = r.config || {}
    toast(c.patrolEnabled === false ? '空停巡查已关闭' : `已保存：定时巡逻每 ${c.patrolSweepMin || 6} 分钟一次`, 'ok')
  } catch (e) { toast('保存失败：' + (e.message || e), 'warn') }
  finally { if (btn) { btn.disabled = false; btn.textContent = '保存' } }
}

/* ---------- 会话看板（员工间 + 用户发起 的消息流，按任务线程分组，实时） ---------- */
let convoCache = []
const KIND_BADGE = {
  dispatch: ['派工', 'k-dispatch'], chat: ['聊天', 'k-chat'],
  call: ['接棒', 'k-call'], return: ['交回', 'k-return'], blocked: ['受阻', 'k-blocked'],
  cc: ['抄送', 'k-cc'], wecom: ['企微', 'k-chat'], meeting: ['会议', 'k-meeting'],
}
async function loadConversations() {
  try { convoCache = await (await fetch('/api/conversations?limit=500')).json() } catch { convoCache = [] }
  renderChain()
}

// 巡检面板（顶部导航「巡检」）：小呆呆的巡检记录 —— 谁被巡查、续跑/升级、时间，点条目开对应巡视 run。
async function loadPatrolLog() {
  let evs = []
  try { const cv = await (await fetch('/api/conversations?limit=600')).json(); evs = (cv || []).filter(e => e && (e.from === 'chaorenq' || e.to === 'chaorenq')) } catch { }
  const crRuns = runsCache.filter(r => r.employee === 'chaorenq')
  const rows = evs.slice().reverse().map(e => {
    const t = String(e.ts || '').slice(0, 16).replace('T', ' ')
    const isResume = e.from === 'chaorenq'
    const emp = isResume ? e.to : e.from
    const nm = (EMPLOYEES[emp] || {}).displayName || emp || '?'
    const sweep = /sweep|定时/.test(e.text || '')
    const label = isResume ? `▶ 续跑 ${nm}` : `🔍 巡查 ${nm} · 疑似空停${sweep ? '（定时）' : '（事件）'}`
    const near = crRuns.reduce((best, r) => { const dt = Math.abs(new Date(r.startedAt || 0) - new Date(e.ts || 0)); return (!best || dt < best.dt) ? { r, dt } : best }, null)
    const rid = near && near.dt < 120000 ? near.r.id : ''
    return `<div class="pl-row ${isResume ? 'pl-resume' : 'pl-detect'}"${rid ? ` onclick="openRun('${rid}')" style="cursor:pointer"` : ''}><span class="pl-time">${esc(t)}</span><span class="pl-txt">${esc(label)}</span></div>`
  }).join('') || '<div class="ed-empty" style="padding:24px 4px">还没有巡检记录。小呆呆会在员工空停时自动巡查——可在他头像弹窗「巡视设置」里调频率/动画。</div>'
  $('view-patrol').innerHTML = `<div class="patrol-view"><div class="section-label">小呆呆 · 巡检记录 <span class="ed-count">${evs.length}</span></div>${rows}</div>`
}
// 发送方小图元：用户 → 文字牌；员工 → 头像
function partyChip(fromKind, key) {
  if (fromKind === 'user' || key === '(user)') return `<span class="cv-user" title="你（用户发起）">你</span>`
  const e = EMPLOYEES[key]
  return e ? `${avatar(key, 22)}` : `<span class="cv-user">${esc(key)}</span>`
}
function renderChain() {
  const host = $('view-chain')
  if (!host) return
  // 顶部开关条
  const switchBar = `
    <div class="cv-toolbar">
      <label class="cv-switch">
        <input type="checkbox" id="cv-chain-enabled" ${chainEnabled ? 'checked' : ''} onchange="toggleChain()" />
        <span>自动接棒 ${chainEnabled ? '开' : '关'}</span>
      </label>
      <span class="cv-hint">员工收工写 <code>【下一棒】</code> 派新活、<code>【交回】</code> 回发委托者；开关关闭时需手动接棒。</span>
      <span class="spacer"></span>
      <button class="btn sm secondary" onclick="loadConversations()">刷新</button>
    </div>`
  // 按 threadRootId 分组
  const groups = new Map()
  for (const c of convoCache) {
    const k = c.threadRootId || c.toRunId || '(?)'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(c)
  }
  // 线程按最新一条时间倒序
  const threads = [...groups.entries()].map(([root, list]) => {
    list.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
    return { root, list, last: list[list.length - 1]?.ts || '' }
  }).sort((a, b) => (b.last).localeCompare(a.last))

  if (!threads.length) {
    host.innerHTML = switchBar + '<div class="empty">还没有交接会话 — 派一次工，或让员工用【下一棒】/【交回】互相交接后，这里就会出现他们的对话</div>'
    return
  }
  const cards = threads.map((t, i) => {
    const rootRun = runsCache.find(r => r.id === t.root)
    const firstMsg = t.list[0]
    const title = (rootRun && rootRun.taskFile) ? rootRun.taskFile.split('/').pop()
      : (clean((firstMsg?.text || '').replace(/【派工】|任务档案：\S+/g, '')).slice(0, 28) || '（无标题）')
    // 参与者去重（发起 + 接收）
    const parts = [...new Set(t.list.flatMap(c => [c.from, c.to]).filter(x => x && x !== '(user)' && EMPLOYEES[x]))]
    const avatars = parts.map(k => avatar(k, 20)).join('')
    const rows = t.list.map(c => {
      const [blabel, bcls] = KIND_BADGE[c.kind] || [c.kind, '']
      const snippet = esc((c.text || '').replace(/\s+/g, ' ').trim().slice(0, 160)) || '（空）'
      const click = c.toRunId ? `onclick="openRun('${c.toRunId}')"` : ''
      return `<div class="cv-msg${c.toRunId ? ' clickable' : ''}" ${click}>
        <div class="cv-flow">${partyChip(c.fromKind, c.from)}<span class="cv-arrow">→</span>${partyChip('employee', c.to)}<span class="cv-badge ${bcls}">${blabel}</span><span class="cv-time">${relTime(c.ts)}</span></div>
        <div class="cv-text">${snippet}</div>
      </div>`
    }).join('')
    return `<details class="cv-thread" ${i < 2 ? 'open' : ''}>
      <summary class="cv-head">
        <span class="cv-avatars">${avatars}</span>
        <span class="cv-title">${esc(title)}</span>
        <span class="cv-count">${t.list.length} 条</span>
        <span class="cv-when">${relTime(t.last)}</span>
      </summary>
      <div class="cv-body">${rows}</div>
    </details>`
  }).join('')
  host.innerHTML = switchBar + cards
}
let chainRefreshTimer = null
function refreshChainSoon() {   // SSE conversation 事件 → 防抖重拉（仅在看板可见时才拉，省流量）
  if ($('view-chain')?.classList.contains('hidden')) return
  clearTimeout(chainRefreshTimer)
  chainRefreshTimer = setTimeout(loadConversations, 200)
}

/* ---------- 会议室（AI 员工复盘 / 吐槽 / 自省，多发言人共处一室，实时直播） ---------- */
let currentMeeting = null      // 正在打开的会议 id（null=列表态）
let meetingES = null           // 当前会议的 SSE
let meetingCache = []
let mtSelected = new Set()     // 发起弹窗里已勾选的参会员工
let meetingRefreshTimer = null
const MT_PILL = {
  running: ['进行中', 'mt-pill-run'], done: ['已结束', 'mt-pill-done'], stopped: ['已结束', 'mt-pill-done'],
  error: ['异常中止', 'mt-pill-err'], interrupted: ['已中断', 'mt-pill-err'],
}
// 会议改进项卡的 inert ctx（复用设置预览口径：会上产的卡是展示/记录用，动作不在这里生效）
const MT_CARD_CTX = {
  runId: 'meeting', employeeName: '会议',
  reply: () => { toast('会议纪要卡，动作不在这里生效', 'warn'); return false },
  focusReply: () => toast('会议纪要卡，动作不在这里生效', 'warn'),
  openUrl: u => { if (/^https?:\/\//i.test(u || '')) window.open(u, '_blank', 'noopener') },
  copy: async t => { try { await navigator.clipboard.writeText(t || ''); toast('已复制', 'ok') } catch { } },
  download: () => toast('会议纪要卡，动作不在这里生效', 'warn'), toast,
}

async function loadMeetings() {
  if (currentMeeting) return   // 房间打开时不重绘列表（避免踩掉直播）
  try { const r = await (await fetch('/api/meetings')).json(); meetingCache = r.meetings || [] } catch { meetingCache = [] }
  renderMeetingsList()
}
function refreshMeetingsSoon() {   // 全局 SSE meeting-* → 防抖重拉列表（仅列表态 + 可见时）
  if ($('view-meeting')?.classList.contains('hidden') || currentMeeting) return
  clearTimeout(meetingRefreshTimer); meetingRefreshTimer = setTimeout(loadMeetings, 250)
}
function mtCode(seq) { return 'No.' + String(seq || 0).padStart(3, '0') }   // 会议唯一编号展示
function renderMeetingsList() {
  const host = $('view-meeting'); if (!host) return
  const bar = `<div class="mt-toolbar"><span class="mt-lead">会议室</span><span class="spacer"></span><button class="btn primary sm" onclick="openMeetingModal()">＋ 发起会议</button></div>`
  if (!meetingCache.length) { host.innerHTML = bar + '<div class="empty">还没有会议 —— 点「发起会议」，给员工一个话题（可聚焦某个版本），让他们坐下来复盘、互评吐槽、说说想怎么改进</div>'; return }
  const cards = meetingCache.map(m => {
    const parts = (m.participants || []).filter(k => EMPLOYEES[k])
    const avs = parts.map(k => avatar(k, 24)).join('')
    const [pl, pc] = MT_PILL[m.status] || [m.status, '']
    const minutes = m.minutesFile ? ` · <a class="mt-ci-minutes" onclick="event.stopPropagation();viewFile('${m.minutesFile}')">📄 纪要</a>` : ''
    return `<div class="mt-card-item" onclick="openMeeting('${m.id}')">
      <div class="mt-ci-top"><span class="mt-code">${mtCode(m.seq)}</span><span class="mt-avatars">${avs}</span><span class="mt-pill ${pc}">${pl}</span></div>
      <div class="mt-ci-topic">${esc(m.topic || '（无题）')}</div>
      <div class="mt-ci-meta">${m.focusVersion ? `聚焦 ${esc(m.focusVersion)} · ` : ''}主持 ${esc(EMPLOYEES[m.chair]?.displayName || m.chair || '-')} · ${m.rounds || '?'} 轮 · ${relTime(m.startedAt)}${minutes}</div>
    </div>`
  }).join('')
  host.innerHTML = bar + `<div class="mt-grid">${cards}</div>`
}

/* ---- 发起会议弹窗 ---- */
function openMeetingModal() {
  mtSelected = new Set(Object.keys(EMPLOYEES))
  const host = $('m-participants')
  if (host) host.innerHTML = Object.entries(EMPLOYEES).map(([k, e]) =>
    `<div class="emp-pick selected" id="mpick-${k}" onclick="mtToggleParticipant('${k}')">${avatar(k, 36)}<span>${esc(e.displayName)}</span></div>`).join('')
  const chair = $('m-chair')
  if (chair) chair.innerHTML = Object.entries(EMPLOYEES).map(([k, e]) => `<option value="${k}" ${k === 'feifei' ? 'selected' : ''}>${esc(e.displayName)}</option>`).join('')
  $('meeting-modal')?.classList.remove('hidden')
}
function closeMeetingModal() { $('meeting-modal')?.classList.add('hidden') }
function mtToggleParticipant(k) { if (mtSelected.has(k)) mtSelected.delete(k); else mtSelected.add(k); $(`mpick-${k}`)?.classList.toggle('selected', mtSelected.has(k)) }
async function submitMeeting() {
  const topic = ($('m-topic')?.value || '').trim()
  if (!topic) { toast('先写个议题', 'warn'); return }
  const participants = [...mtSelected]
  if (!participants.length) { toast('至少选一位参会员工', 'warn'); return }
  const payload = {
    topic, focusVersion: ($('m-version')?.value || '').trim(),
    chair: $('m-chair')?.value || 'feifei', rounds: parseInt($('m-rounds')?.value, 10) || 2, participants,
  }
  const btn = $('m-submit'); if (btn) { btn.disabled = true; btn.textContent = '开会中…' }
  try {
    const r = await (await fetch('/api/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json()
    if (r.error) { toast(r.error, 'warn'); return }
    closeMeetingModal(); showView('meeting')
    try { const list = await (await fetch('/api/meetings')).json(); meetingCache = list.meetings || [] } catch { }
    openMeeting(r.meetingId)
  } catch (e) { toast('发起失败：' + (e.message || e), 'warn') }
  finally { if (btn) { btn.disabled = false; btn.textContent = '开会' } }
}

/* ---- 会议室房间（多发言人直播） ---- */
function openMeeting(id) {
  currentMeeting = id
  const m = meetingCache.find(x => x.id === id) || { id }
  renderMeetingRoomShell(m)
  if (meetingES) meetingES.close()
  meetingES = new EventSource(`/api/meetings/${id}/events`)
  meetingES.onmessage = msg => {
    let ev; try { ev = JSON.parse(msg.data) } catch { return }
    if (ev.type === 'speech') mtAppendSpeech(ev)
    else if (ev.type === 'round') mtAppendDivider(`第 ${ev.round} 轮`)
    else if (ev.type === 'minutes') mtAppendMinutes(ev.file, ev.code)
    else if (ev.type === 'lab') mtAppendSysLab(ev.text || '')
    else if (ev.type === 'meeting-end') { setMeetingPill(ev.status); clearMeetingTyping() }
    else if (ev.type === 'meeting-sync') { setMeetingPill(ev.status); if (ev.speaking) setMeetingTyping(ev.speaking); else clearMeetingTyping() }
  }
  meetingES.onerror = () => { }
}
function renderMeetingRoomShell(m) {
  const host = $('view-meeting'); if (!host) return
  const parts = (m.participants || []).filter(k => EMPLOYEES[k])
  const avs = parts.map(k => avatar(k, 22)).join('')
  host.innerHTML = `
    <div class="mt-room">
      <div class="mt-room-head">
        <button class="btn ghost sm" onclick="backToMeetingList()">← 列表</button>
        <div class="mt-room-title">
          <div class="mt-room-topic"><span class="mt-code">${mtCode(m.seq)}</span>${esc(m.topic || '（无题）')}</div>
          <div class="mt-room-meta"><span class="mt-avatars">${avs}</span>${m.focusVersion ? `<span class="mt-ver">聚焦 ${esc(m.focusVersion)}</span>` : ''}<span id="mt-pill" class="mt-pill"></span></div>
        </div>
        <div class="mt-room-actions">
          <button class="btn secondary sm hidden" id="mt-stop-btn" onclick="stopMeeting()">结束会议</button>
          <button class="btn ghost sm" onclick="deleteMeeting('${m.id}')">删除</button>
        </div>
      </div>
      <div class="mt-stream" id="mt-stream"></div>
      <div class="mt-typing hidden" id="mt-typing"></div>
      <div class="mt-composer hidden" id="mt-composer">
        <input id="mt-reply" type="text" placeholder="以老板身份插句话 / 引导话题…" onkeydown="if(event.key==='Enter')replyMeeting()" />
        <button class="btn primary sm" onclick="replyMeeting()">插话</button>
      </div>
    </div>`
  setMeetingPill(m.status || 'running')
}
// 「贴底」判据：追加前测——用户往上翻看历史时不再被新消息拽回底部（对齐主聊天区 appendNode 的 nearBottom 语义）
function mtNearBottom() { const s = $('mt-stream'); return !s || (s.scrollHeight - s.scrollTop - s.clientHeight < 90) }
// 去掉正文最前面模型自写的「<名字>：」/「<名字>:」前缀（名字已由气泡上方名牌展示，正文再写一遍冗余；成因：喂给模型的会议纪要按「名字：内容」格式，模型会照抄给自己也加一遍）
function mtStripLeadName(name, text) {
  let t = String(text || '')
  if (name) { const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); t = t.replace(new RegExp('^[\\s>]*' + esc + '\\s*[：:]\\s*'), '') }
  return t
}
function mtScrollBottom() { const s = $('mt-stream'); if (s) requestAnimationFrame(() => { s.scrollTop = s.scrollHeight }) }
function mtAppendDivider(txt) { const s = $('mt-stream'); if (!s) return; const stick = mtNearBottom(); const d = document.createElement('div'); d.className = 'mt-round'; d.textContent = '— ' + txt + ' —'; s.appendChild(d); if (stick) mtScrollBottom() }
function mtAppendSysLab(txt) { const s = $('mt-stream'); if (!s || !txt) return; const stick = mtNearBottom(); const d = document.createElement('div'); d.className = 'mt-syslab'; d.textContent = txt; s.appendChild(d); if (stick) mtScrollBottom() }
function mtAppendMinutes(rel, code) {
  const s = $('mt-stream'); if (!s || !rel) return
  const stick = mtNearBottom()
  const d = document.createElement('div'); d.className = 'mt-minutes'
  d.innerHTML = `📄 会议纪要（${esc(code || '')}）已生成 · <a>${esc(rel.split('/').pop())}</a>`
  d.querySelector('a').onclick = () => viewFile(rel)
  s.appendChild(d); if (stick) mtScrollBottom()
}
function mtAppendSpeech(ev) {
  const s = $('mt-stream'); if (!s) return
  const stick = mtNearBottom()   // 追加前先判：只有原本就在底部才跟随，否则保持用户当前阅读位置
  clearMeetingTyping()
  const isBoss = ev.speaker === '(boss)'
  const row = document.createElement('div')
  row.className = 'mt-msg' + (isBoss ? ' boss' : '')
  const roleTag = ev.role === 'open' ? '<span class="mt-roletag">主持 · 开场</span>' : ev.role === 'close' ? '<span class="mt-roletag">主持 · 总结</span>' : ''
  const col = document.createElement('div'); col.className = 'mt-col'
  col.innerHTML = `<div class="mt-name">${esc(ev.displayName || ev.speaker)}${roleTag}</div>`   // 名牌保留：多发言人靠它区分
  const bubble = document.createElement('div'); bubble.className = 'mt-bubble'
  mtRenderContent(bubble, mtStripLeadName(ev.displayName, ev.text))   // 但正文最前面模型自写的「名字：」要去掉（名牌已有，重复冗余）
  col.appendChild(bubble)
  row.innerHTML = isBoss ? '<span class="mt-boss-av">你</span>' : avatar(ev.speaker, 30)
  row.appendChild(col)
  s.appendChild(row)
  if (stick) mtScrollBottom()
}
// 发言正文渲染：复用 OLCards（改进项卡）+ empHtml（markdown），与 renderEmpText 同口径
function mtRenderContent(container, text) {
  const body = String(text || '')
  const addMd = t => { const d = document.createElement('div'); d.className = 'md-mini'; d.innerHTML = empHtml(t); container.appendChild(d) }
  if (window.OLCards && OLCards.hasCard(body)) {
    for (const seg of OLCards.parse(body)) {
      if (seg.kind === 'card') {
        const wrap = document.createElement('div'); wrap.className = 'mt-card'
        try { wrap.appendChild(OLCards.renderCard(seg.data, MT_CARD_CTX)) } catch { wrap.textContent = '（卡片渲染失败）' }
        container.appendChild(wrap)
      } else if (seg.text && seg.text.trim()) addMd(seg.text)
    }
  } else if (body.trim()) addMd(body)
}
function setMeetingTyping(speaker) {
  const el = $('mt-typing'); if (!el) return
  const name = EMPLOYEES[speaker]?.displayName || (speaker === '(boss)' ? '老板' : speaker)
  el.innerHTML = `<span class="mt-typedots"><i></i><i></i><i></i></span> ${esc(name)} 正在发言…`
  const stick = mtNearBottom()   // 只有贴着底才跟随打字指示，别把翻看历史的用户拽回底部
  el.classList.remove('hidden'); if (stick) mtScrollBottom()
}
function clearMeetingTyping() { $('mt-typing')?.classList.add('hidden') }
function setMeetingPill(status) {
  const el = $('mt-pill'); if (el) { const [label, cls] = MT_PILL[status] || [status, '']; el.textContent = label; el.className = 'mt-pill ' + cls }
  const running = status === 'running'
  $('mt-stop-btn')?.classList.toggle('hidden', !running)
  $('mt-composer')?.classList.toggle('hidden', !running)   // 只在进行中才允许老板插话
}
function backToMeetingList() { if (meetingES) { meetingES.close(); meetingES = null } currentMeeting = null; loadMeetings() }
async function stopMeeting() {
  if (!currentMeeting || !confirm('结束这场会议？当前这位说完就收尾。')) return
  try { await fetch(`/api/meetings/${currentMeeting}/stop`, { method: 'POST' }) } catch (e) { toast('结束失败：' + (e.message || e), 'warn') }
}
async function replyMeeting() {
  const input = $('mt-reply'); const text = (input?.value || '').trim()
  if (!text || !currentMeeting) return
  input.value = ''
  try { await fetch(`/api/meetings/${currentMeeting}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) }) }
  catch (e) { toast('插话失败：' + (e.message || e), 'warn') }
}
async function deleteMeeting(id) {
  if (!confirm('删除这场会议？记录不可恢复。')) return
  try { await fetch(`/api/meetings/${id}`, { method: 'DELETE' }) } catch { }
  if (currentMeeting === id) { if (meetingES) { meetingES.close(); meetingES = null } currentMeeting = null }
  loadMeetings()
}

/* ---------- 软键盘避让：只抬输入区，不重塑面板 ----------
   聊天坞高度用 100dvh（稳定），仅把「软键盘高度」写进 --kb，作为额外底部内边距把输入框顶到键盘上方。
   键盘高 = 布局视口 − 可视视口(高 + 偏移)；用 120px 阈值滤掉地址栏显隐造成的小幅抖动（非键盘）。 */
;(function () {
  const vv = window.visualViewport
  if (!vv) return
  const root = document.documentElement
  let raf = 0
  const sync = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => {
      const overlap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop))
      root.style.setProperty('--kb', (overlap > 120 ? Math.round(overlap) : 0) + 'px')
    })
  }
  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)
  sync()
  // 键盘弹出后把会话滚到底，保证最新消息 + 输入框同屏可见
  const ta = $('reply-text')
  if (ta) ta.addEventListener('focus', () => setTimeout(() => {
    const out = $('run-output'); if (out) out.scrollTop = out.scrollHeight
  }, 300))
})()

/* ---------- 启动 ---------- */
;(async () => {
  initTheme()
  syncSidebarToggle()                            // 侧栏折叠钮语义对齐已恢复的折叠态（class 由头脚本首帧前挂好）
  await loadEmployees()                          // 必须最先：avatar/name 映射依赖它
  await Promise.all([loadTasks(), loadRuns(), loadPending()])   // 互不依赖 → 并行，隧道下省 RTT
  renderEmpStatus()              // 队列首屏加载后重渲一次徽标/文案
  loadChainConfig()              // 自动接棒开关初始态
  connectGlobalSSE()             // 实时：全局 SSE 推送状态/档案变更
  setInterval(loadRuns, 15000)   // 兜底轮询（SSE 断线间隙的保险）
  setInterval(loadTasks, 60000)
  const params = new URLSearchParams(location.search)
  if (params.get('file')) viewFile(params.get('file'))
  if (params.get('run')) openRun(params.get('run'))
})()
