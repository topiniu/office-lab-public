/* 望子成龙小学 — 消息卡片系统（OLCards）
   员工在收工/汇报里嵌入一段 ```olcard 围栏 JSON，前端渲染成 Linear 风格的富卡片。
   - 展示卡：link / code / checklist / table / stepper / fields / gallery —— 富渲染 + 复制/打开/下载
   - 动作卡：approval / decision / defect / toggle —— 带按钮，点了通过 ctx.reply 回发给员工（续跑其会话）
   协议见 仓库根《消息卡片协议.md》；可视化预览见 /cards-demo.html。
   本模块无第三方依赖，纯 DOM，esc 自带（不信任员工文本，一律转义）。 */
(function () {
  'use strict'

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  /* ---------- 图标（Lucide 形状，viewBox 24，stroke=currentColor，口径同 app.js/index.html） ---------- */
  const ICON = {
    link: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    checklist: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/>',
    stepper: '<circle cx="5" cy="6" r="3"/><path d="M5 9v6a3 3 0 0 0 3 3h8"/><path d="m14 15 3 3-3 3"/>',
    fields: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    gallery: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    approval: '<path d="M20 13c0 5-3.5 7.5-7.7 8.95a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1 1 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    decision: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    defect: '<path d="m8 2 1.88 1.88"/><path d="M14.12 3.88 16 2"/><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"/><path d="M12 20v-9"/><path d="M6.53 9C4.6 8.8 3 7.1 3 5"/><path d="M6 13H2"/><path d="M3 21c0-2.1 1.7-3.9 3.8-4"/><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"/><path d="M22 13h-4"/><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"/>',
    toggle: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    spin: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
  }
  const svg = (paths, extraCls) =>
    `<svg class="olc-svg${extraCls ? ' ' + extraCls : ''}" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`

  /* 卡片类型 → 默认强调色 + 图标 + 眉标兜底 */
  const TYPE_META = {
    link:      { accent: 'accent',  icon: 'link',      eyebrow: '链接' },
    code:      { accent: 'neutral', icon: 'code',      eyebrow: '代码' },
    checklist: { accent: 'neutral', icon: 'checklist', eyebrow: '清单' },
    table:     { accent: 'neutral', icon: 'table',     eyebrow: '明细' },
    stepper:   { accent: 'accent',  icon: 'stepper',   eyebrow: '进度' },
    fields:    { accent: 'neutral', icon: 'fields',    eyebrow: '字段' },
    gallery:   { accent: 'neutral', icon: 'gallery',   eyebrow: '证据' },
    approval:  { accent: 'warn',    icon: 'approval',  eyebrow: '待放行' },
    decision:  { accent: 'warn',    icon: 'decision',  eyebrow: '待拍板' },
    multiselect: { accent: 'warn',  icon: 'checklist', eyebrow: '多选' },
    defect:    { accent: 'danger',  icon: 'defect',    eyebrow: '缺陷单' },
    toggle:    { accent: 'warn',    icon: 'toggle',    eyebrow: '开关' },
    gate:      { accent: 'warn',    icon: 'decision',  eyebrow: '等你拍板' },
  }

  /* ---------- 已处理动作卡的本地持久化（history 重放时保留「已选」态） ---------- */
  const ACTED_KEY = 'ol-card-acted'
  const getActed = () => { try { return JSON.parse(localStorage.getItem(ACTED_KEY) || '{}') } catch { return {} } }
  const markActed = (id, val) => { const a = getActed(); a[id] = val; try { localStorage.setItem(ACTED_KEY, JSON.stringify(a)) } catch {} }
  const hashId = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return 'c' + (h >>> 0).toString(36) }
  const cardId = (data, ctx) => data.id ? String(data.id) : ((ctx && ctx.runId ? ctx.runId + ':' : '') + hashId(JSON.stringify(data)))

  /* ---------- DOM 小工具 ---------- */
  function el(tag, cls, html) {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (html != null) n.innerHTML = html
    return n
  }
  function toneCls(t) { return ({ ok: 'ok', done: 'ok', success: 'ok', pending: 'pending', wait: 'pending', running: 'running', active: 'running', fail: 'fail', error: 'fail', danger: 'fail', warn: 'warn', skip: 'skip', neutral: '' })[t] || (t || '') }

  /* ---------- 解析：把一段文本切成 md 段 与 卡片段 ---------- */
  /* 围栏必须**独占一行**（行首最多 3 空格，对齐 CommonMark），收栏同理。旧写法
     /```olcard[^\n]*\n([\s\S]*?)```/ 不认行首：正文里白话提一句「卡片是正文里的 ```olcard 围栏」，
     这句话中间的 ```olcard 就开栏、一路吃到下一张真卡的**开栏** ``` 当收尾 —— 整段正文被当卡片
     JSON（碎成 __error__ 卡）、真卡 JSON 反被当 md 裸文本吐出、落单的 ``` 再把后文关进代码块。
     一条汇报当场碎成四五块（run 20260907053624-d858bf，老板 09-07 截图）。
     末尾未闭合围栏仍收到文末（员工漏打收栏时宁可渲染成卡，别把 JSON 泼在会话里）。 */
  const FENCE = /^[ \t]{0,3}```[ \t]*olcard[^\n]*\n([\s\S]*?)(?:^[ \t]{0,3}```[ \t]*$|$(?![\s\S]))/gm
  function hasCard(text) { FENCE.lastIndex = 0; return FENCE.test(String(text || '')) }

  /* 宽松修复员工手写 JSON 的高频破坏：字符串值里未转义的裸 ASCII 直引号（想强调打了 "xx"）、
     以及裸换行/制表。策略——逐字符走，只在「字符串内部」动手：遇 " 若其后首个非空白字符不是结构符
     (, } ] : 或行尾/换行) 就判为字符串里的强调引号 → 转义成 \"；裸控制字符转义。合法转义原样保留。
     只在严格 JSON.parse 失败后兜底调用，绝不碰本就合法的 JSON。（出处：菲菲 v5.15 decision 卡
     question 里写「需定"未改老空行"怎么放行」整卡报「JSON 格式有误」，run 20260729152403）*/
  function repairLenientJson(s) {
    let out = '', inStr = false
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (!inStr) { out += ch; if (ch === '"') inStr = true; continue }
      if (ch === '\\') { out += ch + (s[i + 1] ?? ''); i++; continue }   // 保留合法转义
      if (ch === '"') {
        let j = i + 1
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++
        const nx = s[j]
        if (nx === undefined || nx === ',' || nx === '}' || nx === ']' || nx === ':' || nx === '\n' || nx === '\r') { out += ch; inStr = false }
        else out += '\\"'                                                // 字符串内强调引号 → 转义
        continue
      }
      if (ch === '\n') { out += '\\n'; continue }
      if (ch === '\r') { out += '\\r'; continue }
      if (ch === '\t') { out += '\\t'; continue }
      out += ch
    }
    return out
  }
  function parseCardJson(raw) {
    try { return JSON.parse(raw) } catch (e1) {
      try { return JSON.parse(repairLenientJson(raw)) } catch { return { __error: String((e1 && e1.message) || e1), __raw: raw } }
    }
  }
  function parse(text) {
    text = String(text || '')
    const segs = []
    let last = 0, m
    FENCE.lastIndex = 0
    while ((m = FENCE.exec(text))) {
      if (m.index > last) segs.push({ kind: 'md', text: text.slice(last, m.index) })
      const data = parseCardJson(m[1])
      segs.push({ kind: 'card', data })
      last = m.index + m[0].length
    }
    if (last < text.length) segs.push({ kind: 'md', text: text.slice(last) })
    return segs
  }

  /* ---------- 卡片头部 ---------- */
  function head(data, meta, tagHtml) {
    const eyebrow = data.eyebrow || meta.eyebrow
    const spin = (data.type === 'stepper' || data.type === 'checklist') ? '' : ''
    return `<div class="olc-head">
      <span class="olc-ic">${svg(ICON[meta.icon] || ICON.link)}</span>
      <div class="olc-hgroup">
        ${eyebrow ? `<div class="olc-eyebrow">${esc(eyebrow)}</div>` : ''}
        <div class="olc-title">${esc(data.title || '')}</div>
        ${data.subtitle ? `<div class="olc-sub">${esc(data.subtitle)}</div>` : ''}
      </div>
      ${tagHtml || ''}
    </div>`
  }

  /* ---------- 各类型渲染器：返回 innerHTML 字符串（+ 可选 wire(node,ctx) 绑定交互） ---------- */
  const R = {}

  // 链接卡（MR / 文档）——一键新 tab 打开
  R.link = (d) => {
    const links = Array.isArray(d.links) && d.links.length ? d.links
      : (d.url ? [{ label: d.buttonText || '打开', url: d.url, hint: d.subtitle }] : [])
    const meta = (d.meta || []).map(x => `<div class="olc-kv"><span class="olc-k">${esc(x.k)}</span><span class="olc-v">${esc(x.v)}</span></div>`).join('')
    const rows = links.map((l, i) =>
      `<button class="olc-linkbtn" data-url="${esc(l.url)}" data-i="${i}">
        <span class="olc-linkbtn-main">
          <span class="olc-linkbtn-label">${esc(l.label || l.url)}</span>
          ${l.hint ? `<span class="olc-linkbtn-hint">${esc(l.hint)}</span>` : ''}
        </span>
        ${svg(ICON.link, 'olc-linkbtn-ic')}
      </button>`).join('')
    return {
      html: `${meta ? `<div class="olc-metagrid">${meta}</div>` : ''}<div class="olc-links">${rows}</div>`,
      wire: (node, ctx) => node.querySelectorAll('.olc-linkbtn').forEach(b =>
        b.addEventListener('click', () => ctx.openUrl(b.dataset.url))),
    }
  }

  // 代码 / SQL / 文案卡 —— 复制 + 可选下载
  R.code = (d) => {
    // 内容字段容错：协议是 content，但员工常按卡名写成 code / 或用 sql/text/body（菲菲发版文案写进 code → 原来只读 content 就空了）。取第一个非空别名。
    const content = String([d.content, d.code, d.sql, d.text, d.body].find(v => typeof v === 'string' && v !== '') ?? '')
    const empty = !content.trim()
    const lang = d.lang || (d.filename ? (d.filename.split('.').pop() || '') : '')
    const foot = []
    if (!empty && d.copy !== false) foot.push(`<button class="olc-btn ghost" data-act="copy">${svg(ICON.copy)}复制</button>`)   // 空内容没得复制/下载
    if (!empty && d.download && d.filename) foot.push(`<button class="olc-btn ghost" data-act="download">${svg(ICON.download)}下载</button>`)
    const body = empty
      ? `<div class="olc-empty">${esc(d.emptyHint || '（无内容）')}</div>`   // 别渲染空 <pre>（看着像坏掉的空输入框）
      : `<pre class="olc-code" data-content>${esc(content)}</pre>`
    const footHtml = (lang || d.filename || foot.length)
      ? `<div class="olc-foot">
          ${lang ? `<span class="olc-lang">${esc(lang)}</span>` : ''}
          ${d.filename ? `<span class="olc-file">${esc(d.filename)}</span>` : ''}
          <span class="olc-spacer"></span>${foot.join('')}
        </div>` : ''
    return {
      html: `${body}${footHtml}`,
      wire: (node, ctx) => {
        const cp = node.querySelector('[data-act="copy"]')
        if (cp) cp.addEventListener('click', () => ctx.copy(content))
        const dl = node.querySelector('[data-act="download"]')
        if (dl) dl.addEventListener('click', () => ctx.download(d.filename, content))
      },
    }
  }

  // 清单卡（部署清单 / 性能自检 / 门禁项）
  const STATUS_MARK = {
    ok: svg(ICON.check), fail: svg(ICON.x), running: svg(ICON.spin, 'olc-spin'),
    pending: '', skip: '', warn: '',
  }
  const STATUS_LABEL = { ok: '', fail: '', running: '进行中', pending: '待处理', skip: '跳过', warn: '注意' }
  R.checklist = (d) => {
    const items = (d.items || []).map(raw => {
      // 容错：{text,checked} / 纯字符串 → {label,status}，别静默渲染成空圆点
      const o = (raw && typeof raw === 'object') ? raw : { label: raw == null ? '' : String(raw) }
      const ck = o.checked != null ? o.checked : o.done
      const it = Object.assign({}, o, {
        label: o.label || o.text || o.title || o.name || o.content || '',
        status: o.status || (ck === true ? 'ok' : ck === false ? 'pending' : undefined),
        hint: o.hint || o.desc || o.note,
      })
      const t = toneCls(it.status)
      const mark = STATUS_MARK[t] != null ? STATUS_MARK[t] : ''
      const badge = it.badge || STATUS_LABEL[t] || ''
      return `<div class="olc-ci ${t}">
        <span class="olc-ci-dot">${mark}</span>
        <div class="olc-ci-main">
          <div class="olc-ci-label">${esc(it.label || '')}</div>
          ${it.hint ? `<div class="olc-ci-hint">${esc(it.hint)}</div>` : ''}
        </div>
        ${badge ? `<span class="olc-ci-badge ${t}">${esc(badge)}</span>` : ''}
      </div>`
    }).join('')
    return { html: `<div class="olc-checklist">${items}</div>${d.note ? `<div class="olc-note">${esc(d.note)}</div>` : ''}` }
  }

  // 表格卡（仓库枚举 / 用例覆盖）—— 单元格支持 {v,tone} 上色
  R.table = (d) => {
    const cols = d.columns || []
    const cell = c => (c && typeof c === 'object')
      ? `<td class="${toneCls(c.tone)}">${esc(c.v)}</td>` : `<td>${esc(c)}</td>`
    const thead = cols.length ? `<thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>` : ''
    const tbody = (d.rows || []).map(r => `<tr>${(r || []).map(cell).join('')}</tr>`).join('')
    return { html: `<div class="olc-tablewrap"><table class="olc-table">${thead}<tbody>${tbody}</tbody></table></div>${d.note ? `<div class="olc-note">${esc(d.note)}</div>` : ''}` }
  }

  // 阶段进度卡（两段式发布 / 猪猪 E2E / 需求推进）——竖排时间线：节点在左、标题+说明在右，
  // 连接线连成一条竖轴。任意步数 + 任意长度说明都稳，横排换行错乱的老坑彻底消除（见复盘 §3.69）。
  R.stepper = (d) => {
    const steps = d.steps || []
    const rows = steps.map((s, i) => {
      const t = toneCls(s.status)
      const inner = t === 'ok' ? svg(ICON.check) : t === 'fail' ? svg(ICON.x) : t === 'running' ? svg(ICON.spin, 'olc-spin') : `${i + 1}`
      return `<div class="olc-step ${t}">
        <span class="olc-step-rail"><span class="olc-step-node">${inner}</span></span>
        <span class="olc-step-main">
          <span class="olc-step-label">${esc(s.label || '')}</span>
          ${s.hint ? `<span class="olc-step-hint">${esc(s.hint)}</span>` : ''}
        </span>
      </div>`
    }).join('')
    return { html: `<div class="olc-stepper">${rows}</div>` }
  }

  // 字段卡（权限变更四要素 / facet 验收）
  R.fields = (d) => {
    const groups = d.groups || (d.fields ? [d.fields] : [])
    const html = groups.map(g => {
      const rows = Object.entries(g).map(([k, v]) =>
        `<div class="olc-fkv"><span class="olc-fk">${esc(k)}</span><span class="olc-fv">${esc(v)}</span></div>`).join('')
      return `<div class="olc-fgroup">${rows}</div>`
    }).join('')
    return { html: `<div class="olc-fields">${html}</div>${d.note ? `<div class="olc-note">${esc(d.note)}</div>` : ''}` }
  }

  // 证据画廊（截图）
  R.gallery = (d) => {
    const imgs = (d.images || []).map(im => {
      const src = typeof im === 'string' ? im : im.src
      const cap = typeof im === 'object' ? (im.caption || '') : ''
      return `<figure class="olc-shot"><img src="${esc(src)}" alt="${esc(cap)}" data-src="${esc(src)}" />${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>`
    }).join('')
    return {
      html: `<div class="olc-gallery">${imgs}</div>`,
      wire: (node, ctx) => node.querySelectorAll('.olc-shot img').forEach(img =>
        img.addEventListener('click', () => ctx.openUrl(img.dataset.src))),
    }
  }

  /* ---------- 动作卡：统一「已处理」渲染 + 按钮回发 ---------- */
  // 动作规格归一：接受 {label,reply} 对象 / 字符串简写 / 缺省，一律产出 {label,reply,...}。
  //   字符串简写（如 approve:"全部放行"）＝ 既当按钮文字又当回发内容——员工常这么写，别再让 `{...string}`
  //   把字符串展开成 {0:'全',1:'部'…} 导致 label/reply 双 undefined（→ 空按钮 + 点了 reply(undefined) 静默无效，
  //   甚至假装已处理却没回发给员工，坐实过一次数据静默丢失，2026-07-29）。缺 reply 回落 label，缺 label 回落默认。
  function normAction(spec, dflt) {
    dflt = dflt || {}
    if (spec == null) return { label: dflt.label || '', reply: dflt.reply || dflt.label || '' }
    if (typeof spec === 'string') return { label: spec, reply: spec }
    const label = spec.label != null ? spec.label : dflt.label
    const reply = spec.reply != null ? spec.reply : (spec.label != null ? spec.label : dflt.reply)
    return { ...spec, label, reply }
  }
  function resolvedFootHtml(choiceLabel, employeeName) {
    return `<div class="olc-resolved">${svg(ICON.check)}<span>已选择：<b>${esc(choiceLabel)}</b>${employeeName ? ` · 已回发给 ${esc(employeeName)}` : ''}</span></div>`
  }
  function resolvedFoot(choiceLabel, ctx) { return resolvedFootHtml(choiceLabel, ctx && ctx.employeeName) }
  // 攒批中的暂存态（多张动作卡一轮里一起发，见 app.js cardBatch）：点了先暂存、不立即回发
  function stagedFootHtml(label) {
    return `<div class="olc-staged-foot">${svg(ICON.check)}<span>已选：<b>${esc(label)}</b> · 待一起发送（点下方「发送」）</span></div>`
  }
  // 动作卡点击的统一出口：优先走 ctx.act（支持攒批：返回 'sent'|'staged'|'failed'），无则回落 ctx.reply（立即回发）
  async function cardAct(ctx, id, label, reply, node) {
    if (typeof ctx.act === 'function') return ctx.act(id, label, reply, node)
    return (await ctx.reply(reply)) === false ? 'failed' : 'sent'
  }
  // 暂存卡在批量发送成功后，由 app.js 逐一回调这里翻成「已处理」
  function finalizeStaged(node, id, label, ctx) {
    markActed(id, label)
    const foot = node.querySelector('.olc-staged-foot')
    if (foot) foot.outerHTML = resolvedFootHtml(label, ctx && ctx.employeeName)
    node.classList.remove('olc-staged'); node.classList.add('olc-done')
  }
  // 把一组 {label, reply, cls} 按钮 wire 成：点了 → ctx.reply(reply) → 成功才标记 acted、置为已处理。
  //   关键：① reply 为空则拦下并提示（不静默无效）；② ctx.reply 返回 false（回发失败/409）则**恢复可点、不假装已处理**。
  function wireActions(node, ctx, id, buttons) {
    const acts = node.querySelector('.olc-actions')
    if (!acts) return
    buttons.forEach((b, i) => {
      const btn = acts.querySelector(`[data-i="${i}"]`)
      if (!btn) return
      btn.addEventListener('click', async () => {
        const msg = b.reply || b.label
        if (!msg) { if (typeof ctx.toast === 'function') ctx.toast('这张卡片缺少可回发内容（approve/reject 需填 reply，或用字符串简写）', 'warn'); return }
        const lbl = b.label || msg
        acts.querySelectorAll('button').forEach(x => (x.disabled = true))
        btn.classList.add('chosen')
        const res = await cardAct(ctx, id, lbl, msg, node)
        if (res === 'failed') { acts.querySelectorAll('button').forEach(x => (x.disabled = false)); btn.classList.remove('chosen'); return }
        if (res === 'staged') { node.classList.add('olc-staged'); acts.outerHTML = stagedFootHtml(lbl); ctx.onSend && ctx.onSend(id, () => finalizeStaged(node, id, lbl, ctx)); return }
        markActed(id, lbl); acts.outerHTML = resolvedFoot(lbl, ctx); node.classList.add('olc-done')
      })
    })
  }
  function actionButtons(buttons) {
    return `<div class="olc-actions">${buttons.map((b, i) =>
      `<button class="olc-btn ${b.cls || 'secondary'}" data-i="${i}">${b.icon ? svg(ICON[b.icon]) : ''}${esc(b.label)}</button>`).join('')}</div>`
  }

  // 放行卡（合并 / 部署 / 删分支放行）
  R.approval = (d, ctx) => {
    const id = cardId(d, ctx)
    const items = (d.items || []).map(it =>
      `<div class="olc-ai"><span class="olc-ai-dot"></span><div class="olc-ai-main"><div class="olc-ai-label">${esc(it.label || it)}</div>${it.hint ? `<div class="olc-ai-hint">${esc(it.hint)}</div>` : ''}</div></div>`).join('')
    const approve = normAction(d.approve, { label: '批准执行', reply: '✅ 已批准，请执行上述动作' })
    const reject = normAction(d.reject, { label: '暂缓', reply: '⛔ 暂缓，先不要执行' })
    const buttons = [{ ...reject, cls: 'ghost' }, { ...approve, cls: 'primary', icon: 'check' }]
    const acted = getActed()[id]
    return {
      html: `${items ? `<div class="olc-alist">${items}</div>` : ''}${acted ? resolvedFoot(acted, ctx) : actionButtons(buttons)}`,
      wire: (node, c) => { if (!acted) wireActions(node, c, id, buttons) },
      done: !!acted,
    }
  }

  // 拍板卡 / 归属判定（多选项）
  R.decision = (d, ctx) => {
    const id = cardId(d, ctx)
    // 选项支持字符串简写 / 对象；缺 reply 回落 label（别把 label 也丢了导致空回发）
    const opts = (d.options || []).map(o => {
      const src = (o && typeof o === 'object') ? o : { label: String(o == null ? '' : o) }
      return { label: src.label || '', reply: src.reply || src.label || `决定：${src.label || ''}`, desc: src.desc, recommended: src.recommended }
    })
    const acted = getActed()[id]
    const allowOther = d.other !== false   // 默认给「以上都不是→直接补充」的输入兜底（可 "other":false 关掉）
    const optsHtml = opts.map((o, i) =>
      `<button class="olc-opt${o.recommended ? ' rec' : ''}" data-i="${i}">
        <span class="olc-opt-radio"></span>
        <span class="olc-opt-main">
          <span class="olc-opt-label">${esc(o.label)}${o.recommended ? '<span class="olc-rec">建议</span>' : ''}</span>
          ${o.desc ? `<span class="olc-opt-desc">${esc(o.desc)}</span>` : ''}
        </span>
      </button>`).join('')
    const otherHtml = allowOther
      ? `<div class="olc-dec-other">
          <div class="olc-dec-other-sep"><span>以上都不是？直接补充</span></div>
          <div class="olc-dec-other-row">
            <textarea class="olc-dec-other-ta" rows="1" placeholder="${esc(d.otherPlaceholder || '写下你想要的方案 / 补充意见…（Enter 发送）')}"></textarea>
            <button type="button" class="olc-btn primary olc-dec-other-send" title="发送（Enter）">${svg(ICON.stepper)}</button>
          </div>
        </div>` : ''
    return {
      html: `${d.question ? `<div class="olc-question">${esc(d.question)}</div>` : ''}${acted ? resolvedFoot(acted, ctx) : `<div class="olc-opts">${optsHtml}</div>${otherHtml}`}`,
      wire: (node, c) => {
        if (acted) return
        // 落定（选项 or 自定义补充都汇到这里）：removeOpts+other → 放暂存/已处理脚注
        const place = (footHtml) => {
          const t = node.querySelector('.olc-dec-other'), o = node.querySelector('.olc-opts')
          if (t) { if (o) o.remove(); t.outerHTML = footHtml } else if (o) { o.outerHTML = footHtml }
        }
        const answer = async (lbl, msg, disable, reenable) => {
          disable()
          const res = await cardAct(c, id, lbl, msg, node)
          if (res === 'failed') { reenable(); return }
          if (res === 'staged') { node.classList.add('olc-staged'); place(stagedFootHtml(lbl)); c.onSend && c.onSend(id, () => finalizeStaged(node, id, lbl, c)); return }
          markActed(id, lbl); place(resolvedFoot(lbl, c)); node.classList.add('olc-done')
        }
        const allBtns = () => node.querySelectorAll('.olc-opt, .olc-dec-other-ta, .olc-dec-other-send')
        // 选项：单选即答
        node.querySelectorAll('.olc-opt').forEach((btn, i) => btn.addEventListener('click', () => {
          const msg = opts[i].reply
          if (!msg) { if (typeof c.toast === 'function') c.toast('这个选项缺少可回发内容', 'warn'); return }
          answer(opts[i].label || msg, msg,
            () => { allBtns().forEach(x => (x.disabled = true)); btn.classList.add('chosen') },
            () => { allBtns().forEach(x => (x.disabled = false)); btn.classList.remove('chosen') })
        }))
        // 自定义补充：输入 + 发送（Enter）
        const ta = node.querySelector('.olc-dec-other-ta')
        const doCustom = () => {
          const text = (ta && ta.value || '').trim()
          if (!text) { if (typeof c.toast === 'function') c.toast('写点补充内容再发，或点上面的选项', 'warn'); return }
          const lbl = text.length > 18 ? text.slice(0, 18) + '…' : text
          answer(lbl, text, () => allBtns().forEach(x => (x.disabled = true)), () => allBtns().forEach(x => (x.disabled = false)))
        }
        if (ta) {
          ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px' })
          ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doCustom() } })
        }
        const sendBtn = node.querySelector('.olc-dec-other-send')
        if (sendBtn) sendBtn.addEventListener('click', doCustom)
      },
      done: !!acted,
    }
  }

  // 多选卡（勾多项 → 提交合并回发）——区别于 decision 的单选即发
  R.multiselect = (d, ctx) => {
    const id = cardId(d, ctx)
    const opts = (d.options || []).map(o => {
      const src = (o && typeof o === 'object') ? o : { label: String(o == null ? '' : o) }
      return { label: src.label || '', reply: src.reply, desc: src.desc, checked: !!src.checked }
    })
    const acted = getActed()[id]
    const min = Number.isFinite(d.min) ? d.min : 1
    const submitLabel = d.submitLabel || '确认所选'
    const optsHtml = opts.map((o, i) =>
      `<button type="button" class="olc-ms-opt${o.checked ? ' checked' : ''}" data-i="${i}">
        <span class="olc-ms-box">${svg(ICON.check, 'olc-ms-tick')}</span>
        <span class="olc-opt-main">
          <span class="olc-opt-label">${esc(o.label)}</span>
          ${o.desc ? `<span class="olc-opt-desc">${esc(o.desc)}</span>` : ''}
        </span>
      </button>`).join('')
    return {
      html: `${d.question ? `<div class="olc-question">${esc(d.question)}</div>` : ''}`
        + (acted ? resolvedFoot(acted, ctx)
          : `<div class="olc-ms-opts">${optsHtml}</div><div class="olc-ms-foot"><span class="olc-ms-count"></span><button type="button" class="olc-btn primary olc-ms-submit">${esc(submitLabel)}</button></div>`),
      wire: (node, c) => {
        if (acted) return
        const boxes = [...node.querySelectorAll('.olc-ms-opt')]
        const submit = node.querySelector('.olc-ms-submit')
        const countEl = node.querySelector('.olc-ms-count')
        const picked = () => boxes.map((b, i) => ({ b, o: opts[i] })).filter(x => x.b.classList.contains('checked'))
        const refresh = () => {
          const n = picked().length
          if (countEl) countEl.textContent = n ? `已选 ${n} 项` : (min > 1 ? `至少选 ${min} 项` : '未选')
          if (submit) submit.disabled = n < min
        }
        boxes.forEach(b => b.addEventListener('click', () => { b.classList.toggle('checked'); refresh() }))
        refresh()
        if (submit) submit.addEventListener('click', async () => {
          const sel = picked(); if (sel.length < min) return
          const joined = sel.map(x => x.o.label).join('、')
          const msg = (d.replyPrefix || (d.question ? d.question + '\n' : '已选择：\n')) + sel.map(x => `- ${x.o.reply || x.o.label}`).join('\n')
          boxes.forEach(b => (b.disabled = true)); submit.disabled = true
          const res = await cardAct(c, id, joined, msg, node)
          const wrap = node.querySelector('.olc-ms-opts'), foot = node.querySelector('.olc-ms-foot')
          if (res === 'failed') { boxes.forEach(b => (b.disabled = false)); refresh(); return }
          if (res === 'staged') { node.classList.add('olc-staged'); if (wrap) wrap.remove(); if (foot) foot.outerHTML = stagedFootHtml(joined); c.onSend && c.onSend(id, () => finalizeStaged(node, id, joined, c)); return }
          markActed(id, joined); if (wrap) wrap.remove(); if (foot) foot.outerHTML = resolvedFoot(joined, c); node.classList.add('olc-done')
        })
      },
      done: !!acted,
    }
  }

  // 缺陷单卡
  R.defect = (d, ctx) => {
    const id = cardId(d, ctx)
    const sev = (d.severity || '').toUpperCase()
    const sevCls = sev === 'P0' ? 'fail' : sev === 'P1' ? 'warn' : ''
    const stTone = toneCls(d.status === 'closed' || d.status === 'green' || d.status === 'GREEN' ? 'ok' : d.status === 'red' || d.status === 'RED' ? 'fail' : 'pending')
    const buttons = (d.actions || []).map(a => ({ ...normAction(a, {}), cls: 'secondary' }))
    const acted = getActed()[id]
    return {
      html: `<div class="olc-defect-meta">
          ${sev ? `<span class="olc-sev ${sevCls}">${esc(sev)}</span>` : ''}
          ${d.status ? `<span class="olc-defect-st ${stTone}">${esc(d.status)}</span>` : ''}
          ${d.id ? `<span class="olc-defect-id">#${esc(d.id)}</span>` : ''}
        </div>
        ${d.desc ? `<div class="olc-defect-desc">${esc(d.desc)}</div>` : ''}
        ${buttons.length ? (acted ? resolvedFoot(acted, ctx) : actionButtons(buttons)) : ''}`,
      wire: (node, c) => { if (buttons.length && !acted) wireActions(node, c, id, buttons) },
      done: !!acted,
    }
  }

  // 封板 / 二态开关
  R.toggle = (d, ctx) => {
    const id = cardId(d, ctx)
    const on = normAction(d.on, { label: '确认', reply: '确认' })
    const off = normAction(d.off, { label: '暂不', reply: '暂不' })
    const buttons = [{ ...off, cls: 'ghost' }, { ...on, cls: 'primary', icon: 'toggle' }]
    const acted = getActed()[id]
    return {
      html: `${d.question ? `<div class="olc-question">${esc(d.question)}</div>` : ''}${acted ? resolvedFoot(acted, ctx) : actionButtons(buttons)}`,
      wire: (node, c) => { if (!acted) wireActions(node, c, id, buttons) },
      done: !!acted,
    }
  }

  // 等你拍板门（前端从员工消息里的 `【等你拍板】<事项>` marker 自动合成；也可由员工显式写 {"type":"gate",...}）。
  //   marker 仍是引擎唯一事实源（autoChain 门优先 / 状态徽标都认它），本卡是显示层增强，无 acted 持久化。
  //   交互二合一：可选快捷选项按钮（d.options）+ 恒有的内联输入（文本 + 图片/文件），就地把拍板回发给员工续跑。
  R.gate = (d, ctx) => {
    const opts = (Array.isArray(d.options) ? d.options : []).map(o => {
      const src = (o && typeof o === 'object') ? o : { label: String(o == null ? '' : o) }
      return { label: src.label || '', reply: src.reply || src.label || `决定：${src.label || ''}` }
    })
    const accept = Array.isArray(d.accept) ? d.accept : ['text', 'image']
    const canFile = accept.includes('image') || accept.includes('file')
    const placeholder = d.placeholder || '输入你的拍板意见…（可贴图/附件，Enter 发送）'
    const optsHtml = opts.length
      ? `<div class="olc-gate-quick">${opts.map((o, i) =>
          `<button class="olc-btn secondary olc-gate-opt" data-i="${i}">${esc(o.label)}</button>`).join('')}</div>`
      : ''
    const sep = opts.length ? `<div class="olc-gate-sep"><span>或补充说明</span></div>` : ''
    const attachBtn = canFile
      ? `<button type="button" class="olc-gate-clip" title="添加图片/附件">${svg(ICON.gallery)}</button>` : ''
    return {
      html: `${d.question ? `<div class="olc-question">${esc(d.question)}</div>` : ''}
        <div class="olc-gate-live">
          ${optsHtml}${sep}
          <div class="olc-gate-input">
            <div class="olc-gate-thumbs"></div>
            <div class="olc-gate-row">
              ${attachBtn}
              <textarea class="olc-gate-ta" rows="1" placeholder="${esc(placeholder)}"></textarea>
              <button type="button" class="olc-btn primary olc-gate-send" title="发送（Enter）">${svg(ICON.stepper)}</button>
            </div>
          </div>
          <button type="button" class="olc-gate-expand">在底部输入框展开回复 ↗</button>
        </div>`,
      wire: (node, c) => {
        const live = node.querySelector('.olc-gate-live')
        const done = (label) => {
          if (live) live.outerHTML = resolvedFoot(label, c)
          node.classList.add('olc-done')
        }
        // 快捷选项：点了直接回发
        node.querySelectorAll('.olc-gate-opt').forEach((btn, i) => btn.addEventListener('click', async () => {
          node.querySelectorAll('button, textarea').forEach(x => (x.disabled = true))
          btn.classList.add('chosen')
          const ok = await c.reply(opts[i].reply)
          if (ok === false) { node.querySelectorAll('button, textarea').forEach(x => (x.disabled = false)); btn.classList.remove('chosen'); return }
          done(opts[i].label || opts[i].reply)
        }))
        // 内联输入：文本 + 待发附件（点回形图标选文件；上传后落缩略图）
        const ta = node.querySelector('.olc-gate-ta')
        const thumbs = node.querySelector('.olc-gate-thumbs')
        const pend = []   // {path, name, url, kind}
        const paintThumbs = () => {
          thumbs.innerHTML = pend.map((f, i) => f.kind === 'image'
            ? `<span class="olc-gate-thumb" title="${esc(f.name || '')}"><img src="${esc(f.url)}"/><button type="button" data-x="${i}">✕</button></span>`
            : `<span class="olc-gate-thumb file" title="${esc(f.name || '')}">${svg(ICON.code)}<span>${esc(f.name || '文件')}</span><button type="button" data-x="${i}">✕</button></span>`).join('')
          thumbs.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => { pend.splice(+b.dataset.x, 1); paintThumbs() }))
        }
        const addFiles = async (files) => {
          for (const file of [...(files || [])]) {
            if (typeof c.uploadFile !== 'function') break
            const r = await c.uploadFile(file)
            if (r && r.path) pend.push(r)
          }
          paintThumbs()
        }
        const clip = node.querySelector('.olc-gate-clip')
        if (clip) clip.addEventListener('click', () => {
          const inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true
          inp.accept = accept.includes('image') && !accept.includes('file') ? 'image/*' : ''
          inp.addEventListener('change', () => addFiles(inp.files))
          inp.click()
        })
        if (ta) {
          ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px' })
          ta.addEventListener('paste', e => {
            const imgs = [...(e.clipboardData?.files || [])].filter(f => (f.type || '').startsWith('image/'))
            if (imgs.length) { e.preventDefault(); addFiles(imgs) }
          })
          ta.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
          })
        }
        const submit = async () => {
          const text = (ta?.value || '').trim()
          if (!text && !pend.length) { if (typeof c.toast === 'function') c.toast('写点内容或加个附件再发', 'warn'); return }
          let msg = text || '（见附件）'
          if (pend.length) msg += '\n\n[附件，请用 Read 工具查看]\n' + pend.map(f => `- ${f.path}｜${f.name || ''}`).join('\n')
          node.querySelectorAll('button, textarea').forEach(x => (x.disabled = true))
          const ok = await c.reply(msg)
          if (ok === false) { node.querySelectorAll('button, textarea').forEach(x => (x.disabled = false)); return }
          done(text ? (text.length > 20 ? text.slice(0, 20) + '…' : text) : '已发送附件')
        }
        const sendBtn = node.querySelector('.olc-gate-send')
        if (sendBtn) sendBtn.addEventListener('click', submit)
        const exp = node.querySelector('.olc-gate-expand')
        if (exp) exp.addEventListener('click', () => { if (typeof c.focusReply === 'function') c.focusReply() })
      },
    }
  }

  /* ---------- 主入口：渲染一张卡片为 DOM 元素 ---------- */
  function renderCard(data, ctx) {
    ctx = ctx || {}
    if (!data || data.__error) {
      const box = el('div', 'ol-card olc-accent-danger')
      box.innerHTML = `<div class="olc-head"><span class="olc-ic">${svg(ICON.defect)}</span><div class="olc-hgroup"><div class="olc-eyebrow">卡片解析失败</div><div class="olc-title">JSON 格式有误</div></div></div><pre class="olc-code">${esc((data && data.__error) || '未知错误')}\n\n${esc((data && data.__raw) || '')}</pre>`
      return box
    }
    const meta = TYPE_META[data.type]
    const render = R[data.type]
    if (!meta || !render) {
      const box = el('div', 'ol-card olc-accent-neutral')
      box.innerHTML = `<div class="olc-head"><span class="olc-ic">${svg(ICON.decision)}</span><div class="olc-hgroup"><div class="olc-eyebrow">未知卡片</div><div class="olc-title">${esc(data.type || '（无 type）')}</div></div></div>`
      return box
    }
    const accent = data.accent || meta.accent
    const box = el('div', `ol-card olc-accent-${accent} olc-type-${data.type}`)
    let tag = ''
    if (data.type === 'approval' || data.type === 'decision' || data.type === 'toggle' || data.type === 'multiselect') {
      const acted = getActed()[cardId(data, ctx)]
      tag = `<span class="olc-tag ${acted ? 'ok' : 'live'}">${acted ? '已处理' : '待你处理'}${acted ? '' : `<span class="olc-tag-dot"></span>`}</span>`
    }
    const out = render(data, ctx)
    box.innerHTML = head(data, meta, tag) + `<div class="olc-body">${out.html}</div>`
    if (out.done) box.classList.add('olc-done')
    // 需回发的动作卡（未处理）打标，供 app.js 统计「本轮还有几张待操作」以决定攒批（gate 的内联输入自带发送、不入攒批）
    else if (box.querySelector('.olc-actions') || box.querySelector('.olc-opts') || box.querySelector('.olc-ms-submit')) {
      box.dataset.olcActionId = cardId(data, ctx)
      box.dataset.olcTitle = data.title || data.eyebrow || meta.eyebrow || ''
    }
    if (out.wire) { try { out.wire(box, ctx) } catch (e) { /* 交互绑定失败不影响展示 */ } }
    return box
  }

  /* ---------- 演示样例（供 cards-demo.html + 文档） ---------- */
  const DEMO = [
    { type: 'link', eyebrow: '合并请求 · 波比', title: 'v5.13.1 前端 → master', subtitle: '测试发布', meta: [{ k: '目标分支', v: 'master' }, { k: '仓库', v: 'web-app' }], links: [{ label: '前端 web-app MR', url: 'https://example.com/mr/1', hint: '!123 · feature/v5.13.1-…' }, { label: '后端 service MR', url: 'https://example.com/mr/2', hint: '!456 · 依赖 datasource 连带发' }] },
    { type: 'checklist', eyebrow: '部署服务清单 · 波比', title: '本次需部署（含端口）', items: [{ label: 'web-app-service', hint: '8040 · 直接改动业务逻辑', status: 'pending' }, { label: 'web-app-gys-web', hint: '8042 · datasource 改字段，连带重发', status: 'pending' }, { label: 'web-app-web', hint: '8041 · 无改动', status: 'skip' }, { label: 'partner-app-biz-usa', hint: '8217 · 无改动', status: 'skip' }] },
    { type: 'table', eyebrow: '仓库枚举 · 波比', title: '领先 release 的提交数', columns: ['仓库', '领先数', '进范围'], rows: [['service', '4', '✅'], ['datasource', '2', '✅'], ['gys-web', '3', '✅'], [{ v: 'service（污染?）', tone: 'danger' }, { v: '3402', tone: 'danger' }, { v: '⚠ 疑似 master 反向污染，停下排查', tone: 'danger' }]], note: '正常本版应为个位数；成百上千 → 停下不发，回查合并点。' },
    { type: 'stepper', eyebrow: '两段式发布 · 波比', title: '发布进度', steps: [{ label: '开发分支', status: 'ok' }, { label: 'master（测试）', status: 'ok' }, { label: 'release（线上）', status: 'active', hint: '待你合并' }] },
    { type: 'code', eyebrow: 'Release SQL · 波比', title: 'v5.13.1 建表 + 改表（纯净版）', lang: 'sql', filename: 'V20260721__sampling_v5131.sql', download: true, content: "ALTER TABLE t_sampling_task\n  ADD COLUMN pattern_review_status TINYINT DEFAULT 0 COMMENT '版型审核状态';\n-- 验证：SELECT COUNT(*) FROM information_schema.columns WHERE ..." },
    { type: 'approval', eyebrow: '发布放行 · 波比', title: '请确认执行以下动作', items: [{ label: '合并前端 MR → master', hint: 'web-app !123' }, { label: '合并后端 service MR → master', hint: '!456' }, { label: '部署 service:8040 / gys-web:8042', hint: '库模块先合再发依赖服务' }], approve: { label: '批准执行', reply: '✅ 已批准：按清单合并 + 部署，完成回写 RELEASE_CHECKLIST' }, reject: { label: '暂缓', reply: '⛔ 暂缓，我先自查一下' } },
    { type: 'checklist', eyebrow: '性能自检 · GG Bond', title: 'v5.13.1 性能验收', items: [{ label: '数据量级', hint: '打样任务表约 12w 行，按状态+时间分页', status: 'ok' }, { label: '是否走索引', hint: 'WHERE pattern_review_status + create_time 复合索引命中', status: 'ok' }, { label: '是否分页', hint: '列表 20/页，统计走同过滤聚合 SQL', status: 'ok' }, { label: '有无全量查询', hint: '已评估，无全量/内存聚合', status: 'ok' }] },
    { type: 'code', eyebrow: 'DDL · GG Bond', title: '新增版型审核字段', lang: 'sql', content: "ALTER TABLE t_sampling_task ADD COLUMN pattern_review_status TINYINT DEFAULT 0;" },
    { type: 'gate', eyebrow: '等你拍板 · GG Bond', title: '人工预检：第三批变更是否通过', question: '开发 + 对抗性自查已完成、预检单已出。请你过一眼 UI/UX + 明显 bug——通过我就交迷糊回归；或直接在下面补充意见/贴图。', options: [{ label: '通过，交迷糊回归', reply: '预检通过，交迷糊老师回归' }, { label: '打回重改', reply: '预检打回，见下方说明' }], accept: ['text', 'image'] },
    { type: 'stepper', eyebrow: '猪猪 E2E · 迷糊老师', title: '自动化执行进度', steps: [{ label: 'validate', status: 'ok' }, { label: 'headless', status: 'ok' }, { label: 'RED 校准', status: 'ok' }, { label: 'App-run 终验', status: 'running' }] },
    { type: 'checklist', eyebrow: '上线门禁 · 迷糊老师', title: '门禁判定', items: [{ label: 'P0 用例全绿', hint: '12/12 通过', status: 'ok' }, { label: '缺陷闭合', hint: 'BUG-001/002 已 GREEN 关单', status: 'ok' }, { label: '上线前置技术债', hint: '无遗留', status: 'ok' }], note: '判定：可上线 ✅' },
    { type: 'defect', eyebrow: '缺陷单 · 迷糊老师', title: '版型审核通过后状态未刷新', id: 'BUG-003', severity: 'P0', status: 'RED', desc: '审核通过后列表状态仍显示「待审核」，需刷新才更新。复现：审核通过 → 不刷新 → 状态未变。', actions: [{ label: '指派 GG Bond', reply: '指派 #BUG-003 给 GG Bond 修复' }, { label: '标记复测', reply: '#BUG-003 已修复，进入复测' }] },
    { type: 'decision', eyebrow: '待拍板 · 菲菲', title: 'REQ0109 归属判定', question: '版本已发测试，REQ0109（导出增加版型列）中途插入，如何归属？', options: [{ label: '并入本版 v5.13.1', desc: '需再发一轮测试 + 重新枚举仓库', reply: '决定：REQ0109 并入 v5.13.1（接受再发一轮测试）' }, { label: '排队下一版本 v5.13.2', desc: '不影响已测内容，节奏最稳', recommended: true, reply: '决定：REQ0109 排 v5.13.2' }, { label: '独立 hotfix', desc: '仅线上急修才用', reply: '决定：REQ0109 走独立 hotfix' }] },
    { type: 'multiselect', eyebrow: '多选 · 菲菲', title: '本版并入哪些插单？（可多选）', id: 'demo-ms', question: '勾选要并入本版的插单，其余顺延下一版：', submitLabel: '确认并入', options: [{ label: 'REQ-0216 缺陷打回重审', desc: 'bugfix，改动小', checked: true }, { label: 'REQ-0217 主看板新增两列', desc: '需再发一轮测试' }, { label: 'REQ-0218 筛选维度调整', desc: '纯前端' }] },
    { type: 'fields', eyebrow: '权限变更 · 菲菲', title: '本版新增权限（配置员照此配）', groups: [{ '权限码': 'sampling:pattern:review', '业务名称': '打样版型审核', '面向菜单': '打样工作台 / 版型审核', '建议角色': '版型审核员、打样主管' }] },
    { type: 'code', eyebrow: '微信发版通知 · 菲菲', title: 'v5.13.1 发版文案（复制即发群）', lang: 'text', content: '【示例项目 v5.13.1 已上线】\n1. 新增版型审核环节，审核通过后自动流转 @张三(张三)\n2. 导出优化：修复导出偶发缺列 @李四(李四)\n有问题群里反馈~' },
    { type: 'toggle', eyebrow: '封板 · 波比', title: '进入发布阶段，是否封板？', question: '封板后新插单默认排下一版本（用户特批除外）。', on: { label: '确认封板', reply: '确认封板：frozen=true，记时间线' }, off: { label: '暂不封板', reply: '暂不封板，继续收口' } },
  ].filter(x => !x.__alias)

  window.OLCards = { hasCard, parse, renderCard, DEMO, ICON, svg, esc, markActed, resolvedFootHtml }
})()
