import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createWorkDocument } from '../work-documents.js'

test('work documents stay under the allowed directories and cannot overwrite existing documents', t => {
  const root = mkdtempSync(join(tmpdir(), 'olab-work-docs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(createWorkDocument(root, 'office-lab/tasks/search.md', '# 搜索'), 'office-lab/tasks/search.md')
  assert.equal(createWorkDocument(root, 'docs/search/check.md', '# 验证'), 'office-lab/docs/search/check.md')
  assert.throws(() => createWorkDocument(root, 'tasks/search.md', 'replace'), { code: 'EEXIST' })
  assert.equal(readFileSync(join(root, 'tasks/search.md'), 'utf8'), '# 搜索')
  for (const file of ['docs/../private.md', 'docs/.. /private.md', 'docs/CON.md', 'docs/no.txt', 'app/server.md'])
    assert.throws(() => createWorkDocument(root, file, 'invalid'))
  mkdirSync(join(root, 'other'))
  symlinkSync(join(root, 'other'), join(root, 'docs', 'linked'), 'junction')
  assert.throws(() => createWorkDocument(root, 'docs/linked/private.md', 'invalid'), /链接/)
})
