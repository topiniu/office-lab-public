import test from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  extractUnits, scanSubstance, extractLedgerRows, normalizeOpenState,
  computeFanIn, computeOrphanFacets, computeThresholdLanding, computeOpenItems, computeSectionQuota,
  computeSubstance, renderSubstanceSummary,
  FANIN_CAP, SUBSTANCE_GATE_SINCE,
} from '../req-substance.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ol-subst-'))

// 一份最小原型：两个区块、四个单元，带阈值与 ⏳。刻意混用老板 4 页原型里的两种写法
// （d0/d3 的对象字面量 + d1 的位置参数助手），因为按 key 切片必须对两种都无损。
const PROTO = `<html><body><div data-logic="a1"></div>
<script>
var LOGIC={

/* ================= 顶栏 ================= */
topTitle:{no:1,type:'field',elem:'顶栏 · 标题',title:'页面标题',
  secs:[['字段定义','固定文案。']],
  src:'PRD §1'},
topCount:{no:2,type:'field',elem:'顶栏 · 计数',title:'计数卡',
  secs:[['取值规则','最多 3 张缩略图；备注 ≤200 字。']],
  deep:[['异常兜底','⏳ 待确认：计数用归组口径还是命中口径。']],
  src:'PRD §2'},

/* ================= 抽屉 ================= */
dtTabs:fld(3,'抽屉 · 页签','抽屉两个页签',
  '只有 2 个页签。',
  '取当前批次。',
  '预计晚多久 1–365 天。',
  '⏳ 待确认：全部项确认完之后是就此推进还是首项即推进。',
  'PRD §3'),
tlConcl:{no:4,type:'status',elem:'抽屉 · 结论列',title:'环节结论',
  secs:[['枚举全集','按时完成 / 超期完成 / 超期未完成 / 进行中。']],
  src:'PRD §4'}

};
</script></body></html>`

const traceRow = (unit, what, disp, facet, reason) => `| ${unit} | ${what} | ${disp} | ${facet} | ${reason} |`
const traceTable = rows => `
| 源单元 | 说的是什么 | 处置 | facet | 理由 |
|--------|-----------|------|-------|------|
${rows.join('\n')}
`

// ---------- 扫描器：单元原文 / 区块 / 阈值 / ⏳ ----------

test('扫描器：按 key 切片对「对象字面量」与「位置参数助手」两种写法都无损，并认出 no 与区块', () => {
  const { units, sections } = extractUnits(PROTO)
  assert.equal(units.length, 4)
  assert.deepEqual(units.map(u => u.key), ['topTitle', 'topCount', 'dtTabs', 'tlConcl'])
  assert.deepEqual(units.map(u => u.no), ['1', '2', '3', '4'])       // 助手写法的 no 取第一个位置参数
  assert.deepEqual(sections, ['顶栏', '抽屉'])
  assert.equal(units[2].section, '抽屉')
})

test('扫描器：阈值只收「数字+量词」「比较符+数字」，光秃秃的序号不算判据', () => {
  const { units } = extractUnits(PROTO)
  const th = units[1].thresholds.map(t => t.id)
  assert.ok(th.includes('3张'), th.join(','))
  assert.ok(th.includes('≤200字'), th.join(','))
  const t3 = units[2].thresholds.map(t => t.id)
  assert.ok(t3.includes('365天'), t3.join(','))
  assert.ok(!t3.includes('1天'), '「1 天」这类无判据含量的数字不该进来')
})

test('扫描器：⏳ 逐条抽出、带稳定序号，摘要切到句末不把 JS 语法抄进台账', () => {
  const { units } = extractUnits(PROTO)
  assert.equal(units[1].openItems.length, 1)
  assert.equal(units[1].openItems[0].seq, 1)
  assert.match(units[1].openItems[0].text, /归组口径还是命中口径/)
  assert.ok(!/'\]|\[\[/.test(units[1].openItems[0].text), '摘要里不该出现 JS 字符串语法')
  assert.equal(units[2].openItems.length, 1)
  assert.equal(units[0].openItems.length, 0)
})

test('扫描器：没有 LOGIC 注册表的材料不报错，如实说②③④对它不生效', () => {
  const r = extractUnits('<html><body>纯截图页，没有注册表</body></html>')
  assert.deepEqual(r.units, [])
  assert.match(r.note, /没找到/)
})

test('扫描器：支持 `路径#片段`（老板 4 页原型是 base64 内嵌在一个 HTML 里的 script）', () => {
  const dir = tmp()
  const b64 = Buffer.from(PROTO, 'utf8').toString('base64')
  const p = path.join(dir, 'demo.html')
  fs.writeFileSync(p, `<html><script type="application/octet-stream" id="doc-d0">${b64}</script></html>`)
  const r = scanSubstance(p, { fragment: 'doc-d0' })
  assert.equal(r.units.length, 4)
  assert.equal(r.kind, 'prototype-html')
  const bad = scanSubstance(p, { fragment: 'doc-zz' })
  assert.match(bad.note, /找不到/)
})

// ---------- 判据①：扇入 ----------

test('扇入：一条 facet 吸收超过上限就点名（33 个单元挤一条 = 迷糊只能挑一个测）', () => {
  const rows = Array.from({ length: FANIN_CAP + 2 }, (_, i) => ({ unit: `d0#u${i}`, disposition: '立需求', facets: ['REQ-1-F75'] }))
  const r = computeFanIn({ rows, facets: [{ id: 'REQ-1-F75', criterion: '页面基础展示基线：一堆东西原样渲染', kind: 'auto' }] })
  assert.equal(r.over.length, 1)
  assert.equal(r.over[0].facet, 'REQ-1-F75')
  assert.equal(r.over[0].count, FANIN_CAP + 2)
  assert.equal(r.over[0].presence, false)
})

test('扇入：存在性/回归类 facet 另给高额度——「现网 16 列原样保留」天然是一条聚合断言', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ unit: `d3#c${i}`, disposition: '立需求', facets: ['REQ-1-F29'] }))
  const r = computeFanIn({ rows, facets: [{ id: 'REQ-1-F29', criterion: '现网13筛选/16列/6行操作全部保留原样(present)', kind: 'auto·存在性' }] })
  assert.deepEqual(r.over, [])
})

test('扇入：只数「立需求」的行——本版不做/待老板拍不占额度', () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => ({ unit: `d0#x${i}`, disposition: '本版不做', facets: [] })),
    { unit: 'd0#y', disposition: '立需求', facets: ['REQ-1-F1'] },
  ]
  const r = computeFanIn({ rows, facets: [{ id: 'REQ-1-F1', criterion: '判据', kind: 'auto' }] })
  assert.deepEqual(r.over, [])
  assert.equal(r.facetCount, 1)
})

// ---------- 判据①b：孤儿 facet（补了 facet 却没回填映射表）----------

test('孤儿：facet 立了但映射表没有源单元指向它 → 点名（2026-09-09 实测形态：facet 99→129、映射表一行没改）', () => {
  const r = computeOrphanFacets({
    rows: [{ unit: 'd0#a', disposition: '立需求', facets: ['REQ-1-F75'] }],
    facets: [{ id: 'REQ-1-F75' }, { id: 'REQ-1-F76' }, { id: 'REQ-1-F77' }],
  })
  assert.equal(r.facetTotal, 3)
  assert.equal(r.mappedTotal, 1)
  assert.deepEqual(r.orphans.map(o => o.id), ['REQ-1-F76', 'REQ-1-F77'])
})

test('孤儿：缺陷单壳号 facet（REQ-9NNN）豁免——它来自缺陷单、天然不在源材料映射表里', () => {
  const r = computeOrphanFacets({ rows: [], facets: [{ id: 'REQ-9001-F1' }, { id: 'REQ-0339-F80' }] })
  assert.deepEqual(r.orphans.map(o => o.id), ['REQ-0339-F80'])
})

test('孤儿：只数「立需求」那些行指到的——本版不做的行不算把 facet 认领了', () => {
  const r = computeOrphanFacets({
    rows: [{ unit: 'd0#a', disposition: '本版不做', facets: ['REQ-1-F1'] }],
    facets: [{ id: 'REQ-1-F1' }],
  })
  assert.equal(r.orphans.length, 1)
})

test('孤儿：源材料一个单元都没抽到时不报（没有映射表可对账，报了是冤枉）', () => {
  const res = computeSubstance({
    scans: [{ materialId: 'd0', units: [] }], rows: [],
    facets: [{ id: 'REQ-1-F1', criterion: 'x', kind: 'auto' }], facetText: '',
    ledgerRows: [], ledgerRel: '', createdOn: SUBSTANCE_GATE_SINCE,
  })
  assert.equal(res.unitTotal, 0)
  assert.ok(!res.errors.some(e => /没有任何源单元指向它/.test(e)))
})

test('孤儿：抽到了单元 + 有孤儿 → 进 errors（硬挡），文案点明「新 facet 对下游不存在」', () => {
  const units = extractUnits(PROTO).units
  const res = computeSubstance({
    scans: [{ materialId: 'd0', units }],
    rows: [{ unit: 'd0#topTitle', disposition: '立需求', facets: ['REQ-1-F1'] }],
    facets: [{ id: 'REQ-1-F1', criterion: 'x', kind: 'auto' }, { id: 'REQ-1-F2', criterion: '新登的', kind: 'auto' }],
    facetText: '', ledgerRows: [], ledgerRel: '', createdOn: SUBSTANCE_GATE_SINCE,
  })
  assert.ok(res.errors.some(e => /没有任何源单元指向它/.test(e) && /REQ-1-F2/.test(e)), res.errors.join('|'))
})

// ---------- 判据②：阈值回落 ----------

test('阈值回落：facet 表里搜不到的阈值点名；中文数字与 h/小时 同义归一后不误报', () => {
  const { units } = extractUnits(PROTO)
  const flat = units.map(u => ({ ...u, ref: `d0#${u.key}` }))
  const r = computeThresholdLanding({ units: flat, facetText: '备注 ≤200 字；抽屉只有两个页签' })
  const miss = r.missing.map(t => t.id)
  assert.ok(!miss.includes('≤200字'), 'facet 写了 ≤200 字，不该点名')
  assert.ok(!miss.includes('2个'), '「两个页签」应与「2 个」归一')
  assert.ok(miss.includes('365天'), '预告风险上界没落进 facet，该点名')
  assert.ok(miss.includes('3张'))
})

test('阈值回落：全部来源单元都「本版不做」或只落存在性 facet 的阈值不点名（现网 maxLength=100 字那类）', () => {
  const { units } = extractUnits(PROTO)
  const flat = units.map(u => ({ ...u, ref: `d0#${u.key}` }))
  const scope = new Map([['d0#topcount', 'presenceOnly'], ['d0#dttabs', 'outOfScope']])
  const r = computeThresholdLanding({ units: flat, facetText: '', unitScope: scope })
  const miss = r.missing.map(t => t.id)
  assert.ok(!miss.includes('3张'), '来源单元只落存在性 facet ⇒ 不点名')
  assert.ok(!miss.includes('365天'), '来源单元本版不做 ⇒ 不点名')
})

// ---------- 判据③：开放项台账 ----------

test('台账：终态枚举归一（已决/待拍/不做）', () => {
  assert.equal(normalizeOpenState('已决'), '已决')
  assert.equal(normalizeOpenState('**已定**'), '已决')
  assert.equal(normalizeOpenState('待确认'), '待拍')
  assert.equal(normalizeOpenState('二期'), '不做')
  assert.equal(normalizeOpenState('随便写'), '')
})

test('台账：缺 open_items_doc 时按「⏳ 会在两轮之间静默蒸发」硬拦', () => {
  const { units } = extractUnits(PROTO)
  const flat = units.map(u => ({ ...u, ref: `d0#${u.key}` }))
  const r = computeOpenItems({ units: flat, ledgerRows: [], ledgerRel: '' })
  assert.equal(r.total, 2)
  assert.equal(r.active, true)
  assert.ok(r.errors.some(e => /缺 frontmatter.open_items_doc/.test(e)))
})

test('台账：逐条要终态——缺行/终态不合枚举/已决没写出处 各自点名', () => {
  const { units } = extractUnits(PROTO)
  const flat = units.map(u => ({ ...u, ref: `d0#${u.key}` }))
  const rows = extractLedgerRows(`
| 开放项 ID | 事项 | 终态 | 决议 |
|---|---|---|---|
| d0#topCount⏳1 | 计数口径 | 已决 |  |
`)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, '已决')
  const r = computeOpenItems({ units: flat, ledgerRows: rows, ledgerRel: 'x.md' })
  assert.ok(r.errors.some(e => /终态=已决 但决议列没写口径与出处/.test(e)))
  assert.ok(r.errors.some(e => /缺 1 条行/.test(e)), r.errors.join('|'))
  assert.ok(r.missing.some(m => m.id === 'd0#dtTabs⏳1'))
})

test('台账：三种终态都写全了就通过，待拍数照实回报（开工前要清零）', () => {
  const { units } = extractUnits(PROTO)
  const flat = units.map(u => ({ ...u, ref: `d0#${u.key}` }))
  const rows = extractLedgerRows(`
| 开放项 ID | 事项 | 终态 | 决议 |
|---|---|---|---|
| d0#topCount⏳1 | 计数口径 | 已决 | 老板 2026-09-09 定：归组口径，见 README 台账 #18 |
| d0#dtTabs⏳1 | 闸门推进时机 | 待拍 | 任务档案「待老板拍」第 3 条 |
`)
  const r = computeOpenItems({ units: flat, ledgerRows: rows, ledgerRel: 'x.md' })
  assert.deepEqual(r.errors, [])
  assert.equal(r.resolved, 1)
  assert.equal(r.open, 1)
  assert.equal(r.missing.length, 0)
})

// ---------- 判据④：区块专属 facet ----------

test('区块专属：跨区块共用的桶不算专属——抽屉那种「6 条共用 facet / 专属 0」要被顶到最前', () => {
  const { units } = extractUnits(PROTO)
  const unitIndex = new Map()
  for (const u of units) unitIndex.set(`d0#${u.key}`.toLowerCase(), { ...u, material: 'd0', ref: `d0#${u.key}` })
  // F75 横跨顶栏与抽屉（桶）；F9 专属顶栏
  const rows = [
    { unit: 'd0#topTitle', disposition: '立需求', facets: ['REQ-1-F75'] },
    { unit: 'd0#topCount', disposition: '立需求', facets: ['REQ-1-F75', 'REQ-1-F9'] },
    { unit: 'd0#dtTabs', disposition: '立需求', facets: ['REQ-1-F75'] },
    { unit: 'd0#tlConcl', disposition: '立需求', facets: ['REQ-1-F75'] },
  ]
  const r = computeSectionQuota({ rows, unitIndex })
  const drawer = r.sections.find(s => s.section === '抽屉')
  assert.equal(drawer.units, 2)
  assert.equal(drawer.facets, 1)
  assert.equal(drawer.own, 0, '抽屉的 2 个单元全靠跨区块的 F75 兜 ⇒ 专属 0')
  const top = r.sections.find(s => s.section === '顶栏')
  assert.equal(top.own, 1, 'F9 只出现在顶栏 ⇒ 顶栏专属')
  assert.equal(r.sections[0].section, '抽屉', '无专属的块必须排在最前（它是本判据的头条）')
})

// ---------- 汇总 / 向后兼容 ----------

test('汇总：SUBSTANCE_GATE_SINCE 之前创建的档案只软提示，不硬挡在研版本', () => {
  const scans = [{ materialId: 'd0', ...({ units: extractUnits(PROTO).units }) }]
  const rows = extractUnits(PROTO).units.map(u => ({ unit: `d0#${u.key}`, disposition: '立需求', facets: ['REQ-1-F1'] }))
  const old = computeSubstance({ scans, rows, facets: [{ id: 'REQ-1-F1', criterion: 'x', kind: 'auto' }], facetText: '', createdOn: '2026-09-01' })
  assert.equal(old.active, false)
  assert.equal(old.hard, false)
  const now = computeSubstance({ scans, rows, facets: [{ id: 'REQ-1-F1', criterion: 'x', kind: 'auto' }], facetText: '', createdOn: SUBSTANCE_GATE_SINCE })
  assert.equal(now.hard, true)
})

test('汇总：四道判据各自出账，渲染成看板可贴的一段', () => {
  const units = extractUnits(PROTO).units
  const scans = [{ materialId: 'd0', units }]
  const rows = units.map(u => ({ unit: `d0#${u.key}`, disposition: '立需求', facets: ['REQ-1-F75'] }))
  const res = computeSubstance({
    scans, rows,
    facets: [{ id: 'REQ-1-F75', criterion: '展示基线：一堆东西原样渲染', kind: 'auto' }],
    facetText: '展示基线：一堆东西原样渲染', ledgerRows: [], ledgerRel: '', createdOn: SUBSTANCE_GATE_SINCE,
  })
  assert.equal(res.substanceComplete, false)
  assert.equal(res.unitTotal, 4)
  assert.ok(res.errors.some(e => /一条吃掉 4 个源单元/.test(e)) || res.fanIn.over.length === 0)
  assert.ok(res.errors.some(e => /open_items_doc/.test(e)))
  const md = renderSubstanceSummary(res)
  assert.match(md, /需求实质闸/)
  assert.match(md, /开放项台账/)
  assert.match(md, /区块专属 facet/)
})

test('汇总：源单元两种写法都能寻址（`d0#key` 与 `d0#no`）', () => {
  const units = extractUnits(PROTO).units
  const scans = [{ materialId: 'd0', units }]
  const rows = [
    { unit: 'd0#4', disposition: '立需求', facets: ['REQ-1-F1'] },        // 按 no 寻址（d1/d3 那种写法）
    { unit: 'd0#tlConcl', disposition: '立需求', facets: ['REQ-1-F1'] },  // 按 key 寻址
  ]
  const res = computeSubstance({ scans, rows, facets: [{ id: 'REQ-1-F1', criterion: 'x', kind: 'auto' }], facetText: '', createdOn: '2026-09-01' })
  const secs = res.quota.sections.filter(s => s.section === '抽屉')
  assert.equal(secs.length, 1)
  assert.equal(secs[0].units, 2, '两种写法都寻到了同一区块')
})
