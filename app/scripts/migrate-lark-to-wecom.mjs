// 一次性迁移：飞书需求表 → 企微智能表格（主表反转，2026-08-19）。
//
// 背景：企微企业模式（>10 人）下机器人是独立身份、碰不到成员手动建的表，故需求表必须由机器人
// `smartsheet create` 新建一张，再把飞书那 200+ 行搬过去。见 docs/tech/渠道-企微与飞书.md §3.82。
//
// 用法（先确保 wecom-cli 已装且 `wecom-cli auth show --status` = authorized）：
//   node app/scripts/migrate-lark-to-wecom.mjs --docid s3_xxx [--sheet 需求池] [--dry-run] [--no-images] [--limit N]
//
// 幂等：进度落 app/runs/lark-wecom-migration.json（飞书 record_id → 企微 record_id），中断可重跑、
// 已迁的行跳过（§3.52 教训：远程先写、本地后记之间必有窗口，所以写一条记一条，不等整轮末尾）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(__dirname, '..')
const RUNS_DIR = process.env.OFFICE_LAB_RUNS_DIR ? path.resolve(process.env.OFFICE_LAB_RUNS_DIR) : path.join(APP_DIR, 'runs')
const STATE_FILE = path.join(RUNS_DIR, 'lark-wecom-migration.json')

// ---- 参数 ----
const argv = process.argv.slice(2)
const arg = (name, def = '') => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] || '') : def }
const has = name => argv.includes(name)
const DOCID = arg('--docid')
const SHEET = arg('--sheet', '需求池')
const DRY = has('--dry-run')
const NO_IMAGES = has('--no-images')
const LIMIT = Number(arg('--limit', '0')) || 0
if (!DOCID) { console.error('缺 --docid（企微智能表格 ID，s3_ 开头）'); process.exit(1) }

// ---- wecom-cli 调用（同 server.js：直接用当前 node 跑 bin/wecom.js，不碰 .cmd shim）----
function cliEntry() {
  if (process.env.WECOM_CLI_BIN) return process.env.WECOM_CLI_BIN
  const roots = [
    process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'node_modules'),
    process.platform === 'win32' && process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    '/usr/local/lib/node_modules', '/usr/lib/node_modules',
  ].filter(Boolean)
  for (const r of roots) { const p = path.join(r, '@wecom', 'cli', 'bin', 'wecom.js'); if (fs.existsSync(p)) return p }
  throw new Error('找不到 wecom-cli，先 npm install -g @wecom/cli')
}
const ENTRY = cliEntry()
function cli(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [ENTRY, ...args], { timeout, shell: false, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim(), errOut = String(stderr || '').trim()
      let parsed = null
      for (const raw of [out, errOut]) { if (!raw) continue; try { parsed = JSON.parse(raw); break } catch { } }
      const emsg = parsed?.error?.message || parsed?.errmsg || ''
      if (err && !parsed) return reject(new Error(emsg || errOut.slice(0, 300) || err.message))
      if (parsed?.errcode && parsed.errcode !== 0) return reject(new Error(`errcode=${parsed.errcode} ${parsed.errmsg || ''}`))
      if (parsed?.error) return reject(new Error(`${parsed.error.code} ${parsed.error.message}`))
      resolve(parsed || {})
    })
  })
}
const cliJson = (service, method, body, t) => cli([service, ...method.split(' '), '--json', JSON.stringify(body)], t)

// ---- 飞书只读客户端 ----
const larkCfg = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, 'lark-config.json'), 'utf8'))
const LARK = 'https://open.feishu.cn/open-apis'
let _tok = ''
async function larkToken() {
  if (_tok) return _tok
  const d = await (await fetch(`${LARK}/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: larkCfg.appId, app_secret: larkCfg.appSecret }),
  })).json()
  if (!d.tenant_access_token) throw new Error('飞书取 token 失败: ' + JSON.stringify(d))
  _tok = d.tenant_access_token
  return _tok
}
async function larkAllRows() {
  const token = await larkToken()
  const rows = []
  let pageToken = ''
  // 必须翻页（§3.59：单页不翻页会静默截断，小数据量下看着正常）
  for (let guard = 0; guard < 100; guard++) {
    const url = `${LARK}/bitable/v1/apps/${larkCfg.appToken}/tables/${larkCfg.tableId}/records?page_size=500${pageToken ? '&page_token=' + encodeURIComponent(pageToken) : ''}`
    const d = await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json()
    rows.push(...(d?.data?.items || []))
    if (!d?.data?.has_more) break
    pageToken = d.data.page_token
  }
  return rows
}

// ---- 字段映射：飞书列名 → 企微列名（一比一搬；5 个附件列合并进「图示」）----
const TEXT_COLS = ['需求编号', '需求点', '提出人', '提出时间', '归属版本', '备注', '详情']
const SELECT_COLS = ['状态', '优先级']
const ATTACH_COLS = ['需求点图片', '图示案例（1）图片', '图示案例图片', '图示案例（2）图片', '列5图片']
const BAD_OPTIONS = new Set(['JY2026A06247'])   // 误入现表的脏选项，不迁

const cellText = v => {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(x => x?.text ?? x?.name ?? (typeof x === 'string' ? x : '')).filter(Boolean).join('、')
  if (typeof v === 'object') return v.text || v.name || ''
  return String(v)
}

// ---- 图片：飞书下载 → media upload → smartsheet images upload → 拿 url ----
const TMP = path.join(os.tmpdir(), 'lark2wecom')
fs.mkdirSync(TMP, { recursive: true })
async function migrateImage(att) {
  const token = await larkToken()
  const resp = await fetch(`${LARK}/drive/v1/medias/${att.file_token}/download`, { headers: { Authorization: `Bearer ${token}` } })
  if (!resp.ok) throw new Error(`飞书下载失败 ${resp.status}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  const safe = (att.name || 'image.png').replace(/[^\w.\-]/g, '_')
  const local = path.join(TMP, `${att.file_token}_${safe}`)
  fs.writeFileSync(local, buf)
  // media upload 只吃 file_path（多传字段可能被拒）；类型由文件后缀推断，故上面落盘时保留原扩展名
  const up = await cliJson('media', 'upload', { file_path: local }, 180000)
  const mediaId = up?.media_id
  if (!mediaId) throw new Error('media upload 没拿到 media_id: ' + JSON.stringify(up).slice(0, 200))
  const img = await cliJson('smartsheet', 'images upload', { media_id: mediaId, docid: DOCID }, 180000)
  const url = img?.url
  if (!url) throw new Error('images upload 没拿到 url: ' + JSON.stringify(img).slice(0, 200))
  try { fs.unlinkSync(local) } catch { }
  return { id: att.file_token, title: att.name || '图片', imageUrl: url }
}

// ---- 主流程 ----
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return { done: {}, failed: {} } } })()
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

const rows = await larkAllRows()
console.log(`飞书读到 ${rows.length} 行；已迁 ${Object.keys(state.done).length} 行`)
const todo = rows.filter(r => !state.done[r.record_id]).slice(0, LIMIT || undefined)
console.log(`本次待迁 ${todo.length} 行${DRY ? '（dry-run，不实际写入）' : ''}`)

let ok = 0, fail = 0, imgOk = 0, imgFail = 0
for (const [i, row] of todo.entries()) {
  const f = row.fields || {}
  const values = {}
  for (const c of TEXT_COLS) { const t = cellText(f[c]); if (t) values[c] = t }
  for (const c of SELECT_COLS) {
    const t = cellText(f[c])
    if (t && !BAD_OPTIONS.has(t)) values[c] = [{ text: t }]
  }
  if (!values['需求点']) { console.warn(`[${i + 1}/${todo.length}] 跳过（无需求点）: ${row.record_id}`); continue }

  // 图片：5 个附件列合并进「图示」
  if (!NO_IMAGES && !DRY) {
    const atts = []
    for (const c of ATTACH_COLS) for (const a of (Array.isArray(f[c]) ? f[c] : [])) if (a?.file_token) atts.push(a)
    const cells = []
    for (const a of atts) {
      try { cells.push(await migrateImage(a)); imgOk++ }
      catch (e) { imgFail++; console.warn(`  图片失败 ${a.name}: ${e.message}`) }
    }
    if (cells.length) values['图示'] = cells
  }

  if (DRY) { console.log(`[${i + 1}/${todo.length}] DRY ${values['需求编号'] || ''} ${String(values['需求点']).slice(0, 40)}`); ok++; continue }
  try {
    const d = await cliJson('smartsheet', 'records add', { docid: DOCID, sheet_title: SHEET, records: [{ values }] }, 120000)
    const rid = d?.records?.[0]?.record_id || ''
    state.done[row.record_id] = rid
    delete state.failed[row.record_id]
    saveState()                                   // 写一条记一条（§3.52）
    ok++
    console.log(`[${i + 1}/${todo.length}] ✓ ${values['需求编号'] || ''} → ${rid}`)
  } catch (e) {
    fail++
    state.failed[row.record_id] = String(e.message).slice(0, 300)
    saveState()
    console.error(`[${i + 1}/${todo.length}] ✗ ${values['需求编号'] || ''}: ${e.message}`)
  }
}

console.log(`\n完成：成功 ${ok} / 失败 ${fail}；图片 成功 ${imgOk} / 失败 ${imgFail}`)
console.log(`进度文件：${STATE_FILE}（可重跑，已迁的自动跳过）`)
if (fail) process.exitCode = 1
