// OLCards：员工消息里嵌 ```olcard 围栏 JSON，渲染成富卡片。协议见仓库根 消息卡片协议.md。

import { GATE_LINE_RE, isEmptyGateItem } from './markers'

export type CardData = Record<string, any> & { type: string }
export type Segment = { kind: 'md'; text: string } | { kind: 'card'; data: CardData }

// 围栏必须**独占一行**（行首最多 3 空格缩进，对齐 CommonMark），收栏同理 —— 旧写法
// /```olcard[^\n]*\n([\s\S]*?)```/ 不认行首：正文里白话提一句「卡片是正文里的 ```olcard 围栏」，
// 这句话中间的 ```olcard 就开栏，一路吃到**下一张真卡的开栏** ``` 当收尾 → 整段正文被当成卡片
// JSON（解析失败成 __error__ 卡）、真卡的 JSON 反被当 md 裸文本吐出来、落单的 ``` 又把后文关进
// 代码块。一条汇报当场碎成四五块（run 20260907053624-d858bf，老板 09-07 截图）。
// 末尾未闭合的围栏仍按 CommonMark 收到文末（员工漏打收栏时，宁可渲染成卡也别把 JSON 泼在会话里）。
const FENCE = /^[ \t]{0,3}```[ \t]*olcard[^\n]*\n([\s\S]*?)(?:^[ \t]{0,3}```[ \t]*$|$(?![\s\S]))/gm

// 宽松修复员工手写 JSON 的高频破坏：字符串值里未转义的裸 ASCII 直引号（想强调打了 "xx"）、
// 以及裸换行/制表。逐字符走，只在「字符串内部」动手：遇 " 若其后首个非空白字符不是结构符
// (, } ] : 或行尾) 就判为字符串里的强调引号 → 转义成 \"；裸控制字符转义。合法转义原样保留。
// 与旧 UI cards.js repairLenientJson 一致（否则很多带裸引号的卡片会解析失败、变成错误卡）。
function repairJsonString(s: string): string {
  let out = '',
    inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (!inStr) {
      out += ch
      if (ch === '"') inStr = true
      continue
    }
    if (ch === '\\') {
      out += ch + (s[i + 1] ?? '')
      i++
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++
      const nx = s[j]
      if (nx === undefined || nx === ',' || nx === '}' || nx === ']' || nx === ':' || nx === '\n' || nx === '\r') {
        out += ch
        inStr = false
      } else out += '\\"'
      continue
    }
    if (ch === '\n') {
      out += '\\n'
      continue
    }
    if (ch === '\r') {
      out += '\\r'
      continue
    }
    if (ch === '\t') {
      out += '\\t'
      continue
    }
    out += ch
  }
  return out
}

// 解析卡片 JSON：严格失败 → 宽松修复重试 → 仍失败返回错误对象（带原文）
function repairLenientJson(raw: string): CardData {
  try {
    return JSON.parse(raw)
  } catch (e1) {
    try {
      return JSON.parse(repairJsonString(raw))
    } catch {
      return { type: '__error__', __error: String((e1 as Error)?.message || e1), __raw: raw }
    }
  }
}

export function hasCard(text: string): boolean {
  FENCE.lastIndex = 0
  return FENCE.test(text)
}

// 把一段文本拆成 md/card 段（保留混排顺序）。
export function parseSegments(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  FENCE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE.exec(text))) {
    if (m.index > last) {
      const pre = text.slice(last, m.index).trim()
      if (pre) out.push({ kind: 'md', text: pre })
    }
    const data = repairLenientJson(m[1].trim())
    out.push({ kind: 'card', data: data.type ? data : { ...data, type: '__error__' } })
    last = m.index + m[0].length
  }
  if (last < text.length) {
    const rest = text.slice(last).trim()
    if (rest) out.push({ kind: 'md', text: rest })
  }
  return out
}

// 动作规格归一：字符串简写 → {label, reply}
export type Action = { label: string; reply: string }
export function normAction(a: unknown, fallback?: Partial<Action>): Action | null {
  if (a == null) {
    if (fallback?.label) return { label: fallback.label, reply: fallback.reply ?? fallback.label }
    return null
  }
  if (typeof a === 'string') return { label: a, reply: a }
  const o = a as Record<string, any>
  const label = o.label ?? o.reply ?? ''
  const reply = o.reply ?? o.label ?? ''
  if (!label && !reply) return null
  return { label, reply }
}

// 【等你拍板】<事项> marker → 合成 gate 卡 + 从**显示用正文**里剥掉这行 marker
// （run.result 原文不动 → 引擎 parsePendingGate/autoChain 与状态徽标 runStatus 都不受影响）。
//
// 口径对齐旧 UI parseGate（app/public/app.js）与 status.ts runStateKind：
//  1) marker 必须**独占一行**——否则正文里白话提一句「末行要写【等你拍板】无」也会被当成门；
//  2) 取**最后一处**（同引擎 lastMarkerBlock 语义，早前话题里的旧 marker 不作数）；
//  3) 「无」类事项不算门，判定统一走 markers.ts 的 isEmptyGateItem。旧实现只等值比对
//     '无'/'（无）'/'(无)'，员工写「无。」「无，有进展我汇总给你」这类就漏网 → 每条收工汇报
//     都白送一张空 gate 卡（老板 2026-09-09 截图：菲菲徽标已是「已完成」，下面还挂着一张
//     「等你拍板 / 无。」+ 拍板输入框）。
export function parseGateMarker(text: string): { item: string | null; rest: string } {
  const s = String(text || '')
  const ms = [...s.matchAll(GATE_LINE_RE)]
  if (!ms.length) return { item: null, rest: s }
  const m = ms[ms.length - 1]
  const item = (m[1] || '').trim()
  // 「无」门：不合成卡，正文也照旧原样留着那行（与旧 UI 一致，marker 是员工汇报的一部分）
  if (isEmptyGateItem(item)) return { item: null, rest: s }
  const rest = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim()
  return { item, rest }
}

// 员工自己产的交互动作卡：出现任一 → 它本身就是拍板面，不再补合成 gate（免得两张卡问同一件事）。
// 判「有没有动作卡」而不是「有没有卡」：只带 info/table 这类展示卡时，散文收尾的 gate 仍要兜底合成。
const ACTION_CARD_TYPES = new Set(['decision', 'approval', 'toggle', 'gate'])
export function hasActionCard(text: string): boolean {
  if (!hasCard(text)) return false
  return parseSegments(text).some((seg) => seg.kind === 'card' && ACTION_CARD_TYPES.has(seg.data.type))
}
