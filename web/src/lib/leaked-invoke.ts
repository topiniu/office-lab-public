// 「工具调用泄漏成正文」的剥离（2026-09-07 事故 run 20260907053624-d858bf）。
//
// 现象：模型没产出真的 tool_use 块，而是把调用**当文本写了出来**——
//   card <invoke name="mcp__office-lab-collab__set_entry_status"> <parameter name="no">REQ-0334</parameter> … </invoke>
// 于是那一步压根没执行。旧渲染把它当普通 markdown，正文里就多出一墙 XML（老板 09-07 截图）。
// 这里把它从正文剥出来，交给上层显示成一行「⚠ 未执行的工具调用」安静细行；引擎侧的判定
// （判本轮未正常收工、点名工具、不自动续跑）在 `app/stall-guard.js` 的 `leakedInvocations`，
// 两处判据刻意保持一致：**先剥代码块，再要求结构完整**。
//
// 为什么必须先剥代码块：员工写 SOP / 复盘 / 解释这个 bug 时会**引用**这段语法（引用一律走围栏或
// 行内代码）。「谈论一种标记」和「使用这种标记」得在词法层分开——同 §3.116 的教训。

export type InvokePart =
  | { kind: 'text'; text: string }
  | { kind: 'invoke'; tool: string; body: string }

// 围栏代码块 / 未闭合围栏 的字符区间（这些区间里的 <invoke> 是引用，不动）
function fencedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const re = /^[ \t]{0,3}```[\s\S]*?(?:^[ \t]{0,3}```[ \t]*$|$(?![\s\S]))/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length])
  return out
}

// 泄漏块：`<invoke name="X">…</invoke>`（含被截断的尾巴），要求带 <parameter 或 </invoke> 才算
const INVOKE_RE = /<(?:[a-z]+:)?invoke\s+name="([^"\n]{1,120})"\s*>([\s\S]*?)(?:<\/(?:[a-z]+:)?invoke>|$(?![\s\S]))/gi
// 泄漏块前面常挂两个纯粹的残渣：模型自己写的 `card` 字样、以及 `<function_calls>` 包裹标签
const JUNK_TAIL_RE = /(?:<\/?(?:[a-z]+:)?function_calls>|\bcard\b|\s)*$/i

export function splitLeakedInvokes(text: string): InvokePart[] {
  const src = String(text || '')
  if (!/<(?:[a-z]+:)?invoke\s+name="/i.test(src)) return [{ kind: 'text', text: src }]
  const fenced = fencedRanges(src)
  const inFence = (i: number) => fenced.some(([a, b]) => i >= a && i < b)
  const out: InvokePart[] = []
  let last = 0
  let m: RegExpExecArray | null
  INVOKE_RE.lastIndex = 0
  while ((m = INVOKE_RE.exec(src))) {
    if (inFence(m.index)) continue                                  // 围栏里的是引用，原样留在正文
    const body = m[2] || ''
    if (!/<(?:[a-z]+:)?parameter\s+name=/i.test(body) && !body.trim()) continue   // 空壳，不当泄漏
    const pre = src.slice(last, m.index).replace(JUNK_TAIL_RE, '')
    if (pre.trim()) out.push({ kind: 'text', text: pre })
    out.push({ kind: 'invoke', tool: m[1], body: m[0] })
    last = m.index + m[0].length
  }
  if (last === 0) return [{ kind: 'text', text: src }]
  const rest = src.slice(last)
  if (rest.trim()) out.push({ kind: 'text', text: rest })
  return out
}

// 便捷形态：给渲染与复制用的「干净正文」+ 泄漏清单
export function stripLeakedInvokes(text: string): { clean: string; leaks: Array<{ tool: string; body: string }> } {
  const parts = splitLeakedInvokes(text)
  return {
    clean: parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text.trim()).filter(Boolean).join('\n\n'),
    leaks: parts.filter((p) => p.kind === 'invoke') as Array<{ tool: string; body: string }>,
  }
}

// SDK 自己的报错文本（「模型的工具调用解析不了、重试也失败」）会同时以 assistant 文本块 + result 事件
// 两种身份到达。它不是员工说的话，红框已完整展示 → 气泡侧一律不渲染，且整条只有它的事件直接跳过
// （否则留下一个空气泡 + 一个孤零零的头像）。
export function isSdkParseNoise(text: unknown): boolean {
  const t = String(text || '')
  return /tool call could not be parsed/i.test(t) && t.trim().length < 120
}
