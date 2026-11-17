// 任务档案等 .md 顶部的 YAML frontmatter（--- … ---）拆分与轻量解析。
// 目的：把元数据从正文里剥出来单独渲染，避免 react-markdown 把逐行 YAML 折成一大坨。

export function splitFrontmatter(text: string): { meta: string | null; body: string } {
  if (!text.startsWith('---')) return { meta: null, body: text }
  // 匹配开头到第一处独占一行的闭合 ---（非贪婪）
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: null, body: text }
  return { meta: m[1], body: text.slice(m[0].length) }
}

export type MetaRow = {
  indent: number
  key: string
  value: string
  comment: string
  isGroup: boolean // key 后无值（如 gates:），作为分组标题
}

// 逐行解析简单 YAML（这些 frontmatter 都是 key: value + 一层缩进的 map，够用）
export function parseMetaRows(meta: string): MetaRow[] {
  const rows: MetaRow[] = []
  for (const line of meta.split('\n')) {
    if (!line.trim()) continue
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    const rest = line.trim().replace(/^-\s+/, '') // 列表项前缀
    const ci = rest.indexOf(':')
    if (ci < 0) {
      rows.push({ indent, key: '', value: rest, comment: '', isGroup: false })
      continue
    }
    const key = rest.slice(0, ci).trim()
    let value = rest.slice(ci + 1).trim()
    let comment = ''
    const hi = value.indexOf(' # ') // 行内注释：空格#空格 起
    if (hi >= 0) {
      comment = value.slice(hi + 3).trim()
      value = value.slice(0, hi).trim()
    }
    value = value.replace(/^['"]|['"]$/g, '') // 去成对引号
    rows.push({ indent, key, value, comment, isGroup: value === '' })
  }
  return rows
}
