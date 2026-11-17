// OLCards 围栏正则的回归测试。
//
// 缘起（2026-09-07，run 20260907053624-d858bf，老板截图）：波比一条发测汇报的正文里白话写了一句
// 「卡片是正文里的 ```olcard 围栏，不是工具」——旧正则 /```olcard[^\n]*\n([\s\S]*?)```/ **不认行首**，
// 于是从这句话中间的 ```olcard 就开栏，一路吃到**下一张真卡的开栏** ``` 当收尾：整段 ①② 正文被当成
// 卡片 JSON（碎成 __error__ 卡）、真表格卡的 JSON 反被当 md 裸文本吐进气泡、落单的 ``` 又把后面的
// 「③ 发测 MR」关进代码块。一条消息当场碎成四五块，看着就像"卡片把气泡截断了"。
//
// 这里不 import 解析器（cards.js 是浏览器 IIFE、olcards.ts 是 TS），而是把两份文件里的 FENCE 字面量
// 抠出来直接跑：既验行为，也顺手钉住「两份前端的围栏口径必须一致」——它们是有意重复的两份实现。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCES = {
  'app/public/cards.js': path.join(HERE, '..', 'public', 'cards.js'),
  'web/src/lib/olcards.ts': path.join(HERE, '..', '..', 'web', 'src', 'lib', 'olcards.ts'),
}

// 从源码里抠 `const FENCE = /…/gm` 的字面量，重建成可执行 RegExp
function readFence(file) {
  const src = fs.readFileSync(file, 'utf8')
  const m = src.match(/^\s*const FENCE = (\/.+\/([a-z]*))\s*$/m)
  assert.ok(m, `${file} 里找不到 const FENCE = /…/ 字面量`)
  const lit = m[1]
  const flags = m[2]
  return new RegExp(lit.slice(1, lit.lastIndexOf('/')), flags)
}

// 用给定正则把文本切成 md/card 段（与两份前端的 parseSegments 同口径，只保留切分部分）
function segments(re, text) {
  const out = []
  re.lastIndex = 0
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const pre = text.slice(last, m.index).trim()
      if (pre) out.push({ kind: 'md', text: pre })
    }
    out.push({ kind: 'card', body: m[1].trim() })
    last = m.index + m[0].length
  }
  if (last < text.length) {
    const rest = text.slice(last).trim()
    if (rest) out.push({ kind: 'md', text: rest })
  }
  return out
}

const card = (type) => '```olcard\n{\n  "type": "' + type + '"\n}\n```'

for (const [name, file] of Object.entries(SOURCES)) {
  const FENCE = () => readFence(file)

  test(`${name}：正文里白话提到 \`\`\`olcard 不开栏（本次事故）`, () => {
    const text = [
      '之前的卡片被误当工具调用了——卡片是正文里的 ```olcard 围栏，不是工具。',
      '',
      '**② 仓库枚举结果**',
      '',
      card('table'),
      '',
      '**③ 发测 MR（真实链接）**',
      '',
      card('link'),
    ].join('\n')
    const segs = segments(FENCE(), text)
    assert.deepEqual(
      segs.map((s) => (s.kind === 'card' ? `card:${JSON.parse(s.body).type}` : 'md')),
      ['md', 'card:table', 'md', 'card:link'],
    )
    // 关键：正文那段必须完整留在 md 里（旧正则会把它吞成卡片 JSON）
    assert.match(segs[0].text, /白话提到|不是工具/)
    assert.match(segs[0].text, /② 仓库枚举结果/)
  })

  test(`${name}：单卡 / 多卡 / 前后夹正文都切得对`, () => {
    assert.deepEqual(segments(FENCE(), card('table')).map((s) => s.kind), ['card'])
    assert.deepEqual(
      segments(FENCE(), `前言\n\n${card('table')}\n\n中间\n\n${card('checklist')}\n\n后记`).map((s) => s.kind),
      ['md', 'card', 'md', 'card', 'md'],
    )
  })

  test(`${name}：围栏必须独占一行；缩进 ≤3 空格仍算围栏`, () => {
    // 行内（同一行还有别的字）→ 不是围栏
    assert.deepEqual(segments(FENCE(), '看这个 ```olcard 写法\n{"type":"table"}\n```').map((s) => s.kind), ['md'])
    // ≤3 空格缩进 → 是围栏（对齐 CommonMark）
    assert.deepEqual(segments(FENCE(), '   ```olcard\n{"type":"table"}\n   ```').map((s) => s.kind), ['card'])
  })

  test(`${name}：员工漏打收栏 → 收到文末当一张卡（别把 JSON 泼进会话）`, () => {
    const segs = segments(FENCE(), '汇报如下\n\n```olcard\n{\n  "type": "table"\n}\n')
    assert.deepEqual(segs.map((s) => s.kind), ['md', 'card'])
    assert.equal(JSON.parse(segs[1].body).type, 'table')
  })

  test(`${name}：卡片 JSON 里出现 \`\`\` 不会提前收栏`, () => {
    const text = '```olcard\n{\n  "type": "code",\n  "code": "看 ``` 这种围栏"\n}\n```\n\n尾巴'
    const segs = segments(FENCE(), text)
    assert.deepEqual(segs.map((s) => s.kind), ['card', 'md'])
    assert.equal(JSON.parse(segs[0].body).type, 'code')
  })
}

test('两份前端的围栏正则口径一致（有意重复的两份实现别各自漂移）', () => {
  const [a, b] = Object.values(SOURCES).map(readFence)
  assert.equal(a.source, b.source)
  assert.equal(a.flags, b.flags)
})
