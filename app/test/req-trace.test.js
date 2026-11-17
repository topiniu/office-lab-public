import test from 'node:test'
import assert from 'node:assert/strict'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseSourceMaterials, extractTraceRows, computeTrace, renderTraceSummary,
  scanSourceMaterial, normalizeDisposition, TRACE_GATE_SINCE,
} from '../req-trace.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ol-trace-'))
const traceTable = rows => `
## 源材料 → facet 溯源映射表

| 源单元 | 说的是什么 | 处置 | facet | 理由 |
|--------|-----------|------|-------|------|
${rows.join('\n')}
`

// ---------- ① 源材料清点单 ----------

test('清点单：管道串逐份解析（parseFrontmatter 是浅解析器，list-of-maps 会被静默吞掉，故刻意用一行一份）', () => {
  const r = parseSourceMaterials([
    'd0 | office-lab/app/uploads/demo.html#doc-d0 | prototype | units=185 | read=full',
    'd2 | office-lab/app/uploads/demo.html#doc-d2 | prototype | units=78 | read=degraded | why=只读了注释，正文未逐段读',
  ])
  assert.equal(r.declared, true)
  assert.equal(r.none, false)
  assert.equal(r.materials.length, 2)
  assert.equal(r.materials[0].units, 185)
  assert.equal(r.materials[0].read, 'full')
  assert.equal(r.materials[1].why, '只读了注释，正文未逐段读')
  assert.deepEqual(r.errors, [])
})

test('清点单：units 手估不了——缺 units / 缺 read 直接报错', () => {
  const r = parseSourceMaterials(['d0 | a.html | prototype | read=full'])
  assert.ok(r.errors.some(e => /缺 units/.test(e)))
  const r2 = parseSourceMaterials(['d0 | a.html | prototype | units=10'])
  assert.ok(r2.errors.some(e => /缺 read/.test(e)))
})

test('清点单：降级读法必须写 why（治「四个 subagent 被拦→改用关键词词频→静默交付」）', () => {
  const bad = parseSourceMaterials(['d0 | a.html | prototype | units=185 | read=degraded'])
  assert.ok(bad.errors.some(e => /必须写 why/.test(e)))
  const ok = parseSourceMaterials(['d0 | a.html | prototype | units=185 | read=degraded | why=子代理被 hook 拦下，改用注释提取'])
  assert.deepEqual(ok.errors, [])
})

test('清点单：id 重复报错（映射表按 id 归属单元，重了就算不清）', () => {
  const r = parseSourceMaterials(['d0 | a.html | x | units=1 | read=full', 'D0 | b.html | x | units=1 | read=full'])
  assert.ok(r.errors.some(e => /重复/.test(e)))
})

test('清点单：none 必须带理由，光写 none 等于静默省略', () => {
  const bare = parseSourceMaterials('none')
  assert.equal(bare.none, true)
  assert.ok(bare.errors.some(e => /必须写理由/.test(e)))
  const withReason = parseSourceMaterials('none — 纯缺陷 hotfix，老板口头描述，无可枚举源材料')
  assert.equal(withReason.none, true)
  assert.deepEqual(withReason.errors, [])
})

// ---------- ② 溯源映射表 ----------

test('映射表：表头嗅探认「源单元 + 处置」，处置同义写法归一', () => {
  const rows = extractTraceRows(traceTable([
    '| d0#logic-no=137 | 复制催单话术按钮 | 立需求 | REQ-0339-F45 | |',
    '| d0#logic-no=138 | 拆批撤回栈 | 二期 | — | 依赖批次机制，二期做 |',
    '| d0#logic-no=139 | 供应商乐观锁 | 待拍板 | — | |',
  ]))
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(r => r.disposition), ['立需求', '本版不做', '待老板拍'])
  assert.deepEqual(rows[0].facets, ['REQ-0339-F45'])
  assert.equal(rows[0].material, 'd0')
})

test('映射表：非映射表的表格不误吃（表头没有「源单元/处置」一律跳过）', () => {
  assert.deepEqual(extractTraceRows('| facet ID | 验收标准 |\n|---|---|\n| REQ-1-F1 | x |'), [])
})

test('normalizeDisposition：认不出的措辞返回空串，不猜（宁可报枚举不合，也不静默归档）', () => {
  assert.equal(normalizeDisposition('立需求'), '立需求')
  assert.equal(normalizeDisposition('也许吧'), '')
})

// ---------- ③ 机算 traceComplete ----------

const mats = parseSourceMaterials(['d0 | demo.html#doc-d0 | prototype | units=3 | read=full'])
const base = { materials: mats, traceDocRel: 'docs/x/trace.md', createdOn: '2026-09-10', facetIds: ['REQ-0339-F45', 'REQ-0339-F46'] }

test('全覆盖 → traceComplete', () => {
  const rows = extractTraceRows(traceTable([
    '| d0#1 | a | 立需求 | REQ-0339-F45 | |',
    '| d0#2 | b | 立需求 | REQ-0339-F46 | |',
    '| d0#3 | c | 本版不做 | — | 二期做，不影响主流程 |',
  ]))
  const r = computeTrace({ ...base, rows })
  assert.equal(r.traceComplete, true, r.errors.join(' / '))
  assert.equal(r.unmapped, 0)
  assert.equal(r.mappedTotal, 2)
  assert.equal(r.outTotal, 1)
})

test('★本次事故重放：清点 185 单元、只映射 38 条 → 缺口 147，硬拦（旧闸门只会说 38/38 全绿）', () => {
  const m = parseSourceMaterials(['d0 | demo.html#doc-d0 | prototype | units=185 | read=full'])
  const rows = extractTraceRows(traceTable(
    Array.from({ length: 38 }, (_, i) => `| d0#${i + 1} | e${i} | 立需求 | REQ-0339-F${i + 1} | |`)
  ))
  const facetIds = Array.from({ length: 38 }, (_, i) => `REQ-0339-F${i + 1}`)
  const r = computeTrace({ materials: m, rows, facetIds, traceDocRel: 'docs/x/trace.md', createdOn: '2026-09-10' })
  assert.equal(r.traceComplete, false)
  assert.equal(r.unmapped, 147)
  assert.ok(r.errors.some(e => /还有 147 个单元没进映射表/.test(e)))
})

test('立需求指向不存在的 facet → 拦（写了号但 facet 没真立进 facet_doc）', () => {
  const rows = extractTraceRows(traceTable([
    '| d0#1 | a | 立需求 | REQ-0339-F99 | |',
    '| d0#2 | b | 立需求 | REQ-0339-F46 | |',
    '| d0#3 | c | 本版不做 | — | 二期 |',
  ]))
  const r = computeTrace({ ...base, rows })
  assert.equal(r.traceComplete, false)
  assert.ok(r.errors.some(e => /指向不存在的 facet REQ-0339-F99/.test(e)))
})

test('「本版不做」没写理由 → 拦（不做与漏了在账面上必须分得开）', () => {
  const rows = extractTraceRows(traceTable([
    '| d0#1 | a | 立需求 | REQ-0339-F45 | |',
    '| d0#2 | b | 立需求 | REQ-0339-F46 | |',
    '| d0#3 | c | 本版不做 | — | |',
  ]))
  const r = computeTrace({ ...base, rows })
  assert.ok(r.errors.some(e => /处置=本版不做 但理由列为空/.test(e)))
})

test('还有「待老板拍」→ 拦（带着未决口径开工＝让 GG Bond 猜）', () => {
  const rows = extractTraceRows(traceTable([
    '| d0#1 | a | 立需求 | REQ-0339-F45 | |',
    '| d0#2 | b | 立需求 | REQ-0339-F46 | |',
    '| d0#3 | c | 待老板拍 | — | 撤销后能否再发链接 |',
  ]))
  const r = computeTrace({ ...base, rows })
  assert.equal(r.pending, 1)
  assert.equal(r.traceComplete, false)
  assert.ok(r.errors.some(e => /停在「待老板拍」/.test(e)))
})

test('缺 trace_doc 指针 / 文件读不到 → 拦', () => {
  const rows = extractTraceRows(traceTable(['| d0#1 | a | 立需求 | REQ-0339-F45 | |']))
  assert.ok(computeTrace({ ...base, rows, traceDocRel: '' }).errors.some(e => /缺 frontmatter.trace_doc/.test(e)))
  assert.ok(computeTrace({ ...base, rows, traceDocMissing: true }).errors.some(e => /找不到\/读不到/.test(e)))
})

test('降级读法进 warnings（要带进会审与交接卡），read=none 也点名', () => {
  const m = parseSourceMaterials([
    'd0 | a.html | prototype | units=1 | read=degraded | why=只读注释',
    'd1 | b.html | prototype | units=0 | read=none | why=时间不够没看',
  ])
  const rows = extractTraceRows(traceTable(['| d0#1 | a | 立需求 | REQ-0339-F45 | |']))
  const r = computeTrace({ ...base, materials: m, rows })
  assert.ok(r.warnings.some(w => /降级读法/.test(w)))
  assert.ok(r.warnings.some(w => /read=none/.test(w)))
})

test('映射表行归属到未清点的材料 → warning（别静默丢弃这些行）', () => {
  const rows = extractTraceRows(traceTable([
    '| d0#1 | a | 立需求 | REQ-0339-F45 | |',
    '| d0#2 | b | 立需求 | REQ-0339-F46 | |',
    '| d0#3 | c | 本版不做 | — | 二期 |',
    '| dX#1 | 野行 | 立需求 | REQ-0339-F45 | |',
  ]))
  const r = computeTrace({ ...base, rows })
  assert.ok(r.warnings.some(w => /未清点的源材料「dX」/.test(w)))
})

// ---------- 向后兼容（opt-in，同 coverage.js 传统）----------

test(`${TRACE_GATE_SINCE} 之前创建的档案：缺清点单只软提示，不硬挡（不卡死在研版本）`, () => {
  const old = computeTrace({ materials: parseSourceMaterials(null), createdOn: '2026-08-01' })
  assert.equal(old.active, false)
  assert.equal(old.errors.length, 0)
  assert.ok(old.warnings.some(w => /缺 frontmatter.source_materials/.test(w)))
  const fresh = computeTrace({ materials: parseSourceMaterials(null), createdOn: '2026-09-20' })
  assert.equal(fresh.active, true)
  assert.ok(fresh.errors.some(e => /缺 frontmatter.source_materials/.test(e)))
})

test('老档案一旦自愿声明了清点单 → 立即按硬闸走（声明即入闸，不靠日期）', () => {
  const r = computeTrace({ materials: mats, rows: [], traceDocRel: 'docs/x/trace.md', createdOn: '2026-01-01' })
  assert.equal(r.active, true)
  assert.equal(r.hard, true)
  assert.ok(r.errors.some(e => /还有 3 个单元没进映射表/.test(e)))
})

test('none + 无材料 → 放行但留痕（纯缺陷 hotfix / 口头需求走这条）', () => {
  const r = computeTrace({ materials: parseSourceMaterials('none — 纯缺陷 hotfix，无原型无 PRD'), createdOn: '2026-09-20' })
  assert.equal(r.traceComplete, true)
  assert.equal(r.errors.length, 0)
  assert.ok(r.warnings.some(w => /无可枚举源材料/.test(w)))
})

// ---------- 扫描器 ----------

test('scanSourceMaterial：HTML 数 data-logic 元素', () => {
  const dir = tmp(), f = path.join(dir, 'p.html')
  fs.writeFileSync(f, '<div data-logic="a" data-logic-no="1">x</div><span data-logic="b">y</span><span data-logic="a">dup</span>')
  const r = scanSourceMaterial(f)
  assert.equal(r.kind, 'prototype-html')
  assert.equal(r.units, 2)                      // 去重：同名元素算一条规格
  fs.rmSync(dir, { recursive: true, force: true })
})

test('scanSourceMaterial：base64 内嵌页逐页各数一遍（老板 Demo 就是这形态：4 页 doc-d0..d3）', () => {
  const dir = tmp(), f = path.join(dir, 'demo.html')
  const page = n => Buffer.from(`<html><body>${Array.from({ length: n }, (_, i) => `<div data-logic="u${i}"></div>`).join('')}${'<!-- pad -->'.repeat(300)}</body></html>`).toString('base64')
  fs.writeFileSync(f, `<html><script type="application/octet-stream" id="doc-d0">${page(5)}</script><script type="application/octet-stream" id="doc-d1">${page(3)}</script></html>`)
  const r = scanSourceMaterial(f)
  assert.equal(r.subDocs.length, 2)
  assert.deepEqual(r.subDocs.map(d => [d.id, d.units]), [['doc-d0', 5], ['doc-d1', 3]])
  assert.ok(/逐页各清点一行/.test(r.note))     // 别把四页合成一行报一个总数
  fs.rmSync(dir, { recursive: true, force: true })
})

test('scanSourceMaterial：数不出来就说数不出来，绝不猜一个数（截图/无标注 HTML）', () => {
  const dir = tmp()
  const png = path.join(dir, 'a.png'); fs.writeFileSync(png, 'x')
  const r1 = scanSourceMaterial(png)
  assert.equal(r1.units, null)
  assert.ok(/人工逐控件/.test(r1.note))
  const plain = path.join(dir, 'b.html'); fs.writeFileSync(plain, '<div>no annotations</div>')
  const r2 = scanSourceMaterial(plain)
  assert.equal(r2.units, null)
  assert.ok(/人工逐屏枚举/.test(r2.note))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('scanSourceMaterial：md 按 ## 及更深标题计数', () => {
  const dir = tmp(), f = path.join(dir, 'prd.md')
  fs.writeFileSync(f, '# 标题\n\n## 一\n\n### 一.1\n\n正文\n\n## 二\n')
  const r = scanSourceMaterial(f)
  assert.equal(r.kind, 'doc')
  assert.equal(r.units, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('renderTraceSummary：缺口加粗、结论明确（贴进晨检包/交接卡）', () => {
  const m = parseSourceMaterials(['d0 | a.html | prototype | units=5 | read=full'])
  const rows = extractTraceRows(traceTable(['| d0#1 | a | 立需求 | REQ-0339-F45 | |']))
  const out = renderTraceSummary(computeTrace({ ...base, materials: m, rows }))
  assert.ok(out.includes('**4**'))
  assert.ok(out.includes('不许进开发'))
})
