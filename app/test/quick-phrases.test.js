import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePhrase, upsertPhrase, removePhrase, reorderPhrases, phrasesFor, MAX_LABEL, MAX_TEXT } from '../quick-phrases.js'

const known = ['ggbond', 'feifei', 'mihu-teacher']
let n = 0
const opts = { knownEmployees: known, genId: () => `id${++n}`, now: '2026-10-07T00:00:00.000Z' }

test('label 缺省取正文首行、超长截断；CRLF 归一', () => {
  const p = normalizePhrase({ text: '继续推进\r\n第二行' }, opts)
  assert.equal(p.label, '继续推进')
  assert.equal(p.text, '继续推进\n第二行')
  const long = normalizePhrase({ text: 'x'.repeat(100) }, opts)
  assert.equal(long.label.length, MAX_LABEL)
})

test('空内容 / 超长 / 未知员工 拒绝', () => {
  assert.throws(() => normalizePhrase({ text: '   ' }, opts), /不能为空/)
  assert.throws(() => normalizePhrase({ text: 'a'.repeat(MAX_TEXT + 1) }, opts), /过长/)
  assert.throws(() => normalizePhrase({ text: 'a', employees: ['nobody'] }, opts), /未知员工/)
})

test('员工去重去空', () => {
  const p = normalizePhrase({ text: 'a', employees: ['ggbond', 'ggbond', ' ', 'feifei'] }, opts)
  assert.deepEqual(p.employees, ['ggbond', 'feifei'])
})

test('upsert：新增追加、按 id 覆盖并保留 createdAt', () => {
  let { list, phrase } = upsertPhrase([], { text: '一' }, opts)
  ;({ list } = upsertPhrase(list, { text: '二' }, opts))
  assert.equal(list.length, 2)
  const created = phrase.createdAt
  ;({ list } = upsertPhrase(list, { id: phrase.id, text: '一改' }, { ...opts, now: '2026-10-08T00:00:00.000Z' }))
  assert.equal(list.length, 2)
  assert.equal(list[0].text, '一改')
  assert.equal(list[0].createdAt, created)
  assert.equal(list[0].updatedAt, '2026-10-08T00:00:00.000Z')
})

test('remove / reorder（漏传的 id 不丢）', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(removePhrase(list, 'b').list.map((x) => x.id), ['a', 'c'])
  assert.equal(removePhrase(list, 'zz').removed, false)
  assert.deepEqual(reorderPhrases(list, ['c', 'a']).map((x) => x.id), ['c', 'a', 'b'])
})

test('phrasesFor：空 employees = 全员可见', () => {
  const list = [
    { id: 'all', employees: [] },
    { id: 'gg', employees: ['ggbond'] },
    { id: 'ff', employees: ['feifei'] },
  ]
  assert.deepEqual(phrasesFor(list, 'ggbond').map((x) => x.id), ['all', 'gg'])
  assert.deepEqual(phrasesFor(list, 'mihu-teacher').map((x) => x.id), ['all'])
})
