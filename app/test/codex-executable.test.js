import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveCodexExecutable } from '../engines/executable.js'

test('desktop update recovers removed managed CLI but preserves custom paths and pins', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-executable-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'OpenAI', 'Codex', 'bin')
  const old = path.join(bin, '1111111111111111', 'codex.exe')
  const latest = path.join(bin, '2222222222222222', 'codex.exe')
  fs.mkdirSync(path.dirname(latest), { recursive: true }); fs.writeFileSync(latest, 'fixture')
  fs.mkdirSync(path.join(bin, '3333333333333333')) // Incomplete desktop update.
  const opts = { platform: 'win32', env: { LOCALAPPDATA: root, PATH: '' } }
  assert.equal(resolveCodexExecutable(old, opts), latest)
  assert.equal(resolveCodexExecutable('codex', opts), latest)
  assert.equal(resolveCodexExecutable(latest, opts), latest)
  const custom = path.join(root, 'custom', 'codex.exe')
  assert.equal(resolveCodexExecutable(custom, opts), custom)
  assert.equal(resolveCodexExecutable(old, { ...opts, platform: 'linux' }), old)
  fs.mkdirSync(path.dirname(old)); fs.writeFileSync(old, 'pinned')
  assert.equal(resolveCodexExecutable(old, opts), old)
  fs.unlinkSync(old); fs.unlinkSync(latest)
  assert.equal(resolveCodexExecutable(old, opts), old)
})

test('bare Codex prefers PATH executable over desktop fallback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-executable-path-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const exe = path.join(root, 'codex.exe'); fs.writeFileSync(exe, 'fixture')
  assert.equal(resolveCodexExecutable('codex', { platform: 'win32', env: { LOCALAPPDATA: root, PATH: root } }), exe)
})
