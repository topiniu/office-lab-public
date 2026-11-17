// 快捷短语（2026-10-07 老板提）：聊天输入框上方一排常用话术，点一下贴进输入框，可按员工限定出现范围。
//
// 与 quick-actions（引擎内置、点了直接发一段写死的完整指令）是两回事：
//   - quick-actions 是**行为契约**的一部分（prompt 由引擎维护，前端只渲染按钮）；
//   - 快捷短语是**老板自己的常用话**，在设置里增删改，点了只是贴进输入框、发不发由人定。
//
// 持久化 runs/quick-phrases.json（与 chain-config 等运行时配置同处）。本模块只放纯函数，读写盘由 server.js 管。

export const MAX_PHRASES = 200
export const MAX_LABEL = 24
export const MAX_TEXT = 4000

const clean = (s) => String(s ?? '').replace(/\r\n/g, '\n')

// 一条短语的归一：label 缺省取正文首行；employees 空数组 = 所有员工可见。
export function normalizePhrase(input, { knownEmployees, now = new Date().toISOString(), genId } = {}) {
  const text = clean(input?.text).trim()
  if (!text) throw new Error('短语内容不能为空')
  if (text.length > MAX_TEXT) throw new Error(`短语内容过长（上限 ${MAX_TEXT} 字）`)
  let label = clean(input?.label).replace(/\s+/g, ' ').trim()
  if (!label) label = text.split('\n')[0].trim()
  if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL)
  let employees = Array.isArray(input?.employees) ? input.employees.map((e) => String(e).trim()).filter(Boolean) : []
  employees = [...new Set(employees)]
  if (knownEmployees) {
    const unknown = employees.filter((e) => !knownEmployees.includes(e))
    if (unknown.length) throw new Error(`未知员工：${unknown.join('、')}`)
  }
  const id = String(input?.id || '').trim() || (genId ? genId() : `qp-${Date.now().toString(36)}`)
  return { id, label, text, employees, updatedAt: now }
}

// 新增或按 id 覆盖。返回新数组（不改入参）；新增的排在最后。
export function upsertPhrase(list, input, opts = {}) {
  const arr = Array.isArray(list) ? list : []
  const p = normalizePhrase(input, opts)
  const i = arr.findIndex((x) => x.id === p.id)
  if (i >= 0) {
    const next = arr.slice()
    next[i] = { ...arr[i], ...p, createdAt: arr[i].createdAt || p.updatedAt }
    return { list: next, phrase: next[i] }
  }
  if (arr.length >= MAX_PHRASES) throw new Error(`快捷短语已达上限 ${MAX_PHRASES} 条`)
  const phrase = { ...p, createdAt: p.updatedAt }
  return { list: [...arr, phrase], phrase }
}

export function removePhrase(list, id) {
  const arr = Array.isArray(list) ? list : []
  const next = arr.filter((x) => x.id !== id)
  return { list: next, removed: next.length !== arr.length }
}

// 按 id 顺序重排（未列到的保持原相对顺序追加在后，防前端少传丢数据）
export function reorderPhrases(list, ids) {
  const arr = Array.isArray(list) ? list : []
  const want = Array.isArray(ids) ? ids.map(String) : []
  const byId = new Map(arr.map((x) => [x.id, x]))
  const head = want.map((id) => byId.get(id)).filter(Boolean)
  const seen = new Set(head.map((x) => x.id))
  return [...head, ...arr.filter((x) => !seen.has(x.id))]
}

// 某员工聊天窗里该出现的短语
export function phrasesFor(list, employee) {
  const arr = Array.isArray(list) ? list : []
  return arr.filter((p) => !p.employees?.length || p.employees.includes(employee))
}
