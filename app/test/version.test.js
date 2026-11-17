// 版本号维护的回归测试：把「唯一事实源」钉死，防止版本号在三处之间漂。
//
// 缘起 2026-08-28（老板要求版本号展示在侧栏 "Office Lab · v…" 后面）：既然版本号从此长在界面上，
// 它就不能再是「代码改了、版本号没跟上」的摆设（CLAUDE.md 已记过这个旧账）。三处必须一致：
//   app/package.json.version  = 唯一事实源（server.js 读进 VERSION → /api/health → 托盘 + 新 UI 侧栏）
//   package.json.version      = 仓根入口，跟随 app/ 同步（人手改两处容易漏，故用测试兜）
//   CHANGELOG.md              = 该版本必须有落点（开发中 = [Unreleased] 段点名，发版后 = 有 ## [x.y.z] 小节）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(import.meta.dirname, '..')          // …/office-lab/app
const REPO = path.resolve(APP, '..')                          // …/office-lab
const read = (p) => fs.readFileSync(p, 'utf8')
const appVersion = JSON.parse(read(path.join(APP, 'package.json'))).version
const repoVersion = JSON.parse(read(path.join(REPO, 'package.json'))).version
const changelog = read(path.join(REPO, 'CHANGELOG.md'))

test('版本号是 semver 形状（界面上要印成 vX.Y.Z）', () => {
  assert.match(appVersion, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, `app/package.json 版本号异常：${appVersion}`)
})

test('仓根 package.json 与 app/package.json 版本号一致', () => {
  assert.equal(repoVersion, appVersion, '两处 version 漂了：发版时请同步 bump（app/ 是事实源）')
})

test('CHANGELOG 里该版本有落点（[Unreleased] 点名 或 已有该版本小节）', () => {
  const released = new RegExp(`^##\\s*\\[?v?${appVersion.replace(/\./g, '\\.')}\\]?`, 'm').test(changelog)
  const drafting = changelog.includes(`v${appVersion} 开发中`) || changelog.includes(`${appVersion} 开发中`)
  assert.ok(released || drafting, `CHANGELOG 找不到 ${appVersion}：开发中请在 [Unreleased] 注明，发版请归入 ## [${appVersion}]`)
})

test('server.js 的 VERSION 兜底值不是一个像样的版本号（读不到 package.json 时不许造假事实）', () => {
  const src = read(path.join(APP, 'server.js'))
  const m = src.match(/let VERSION = '([^']+)'/)
  assert.ok(m, 'server.js 里找不到 VERSION 兜底声明')
  assert.match(m[1], /unknown/, `兜底值 ${m[1]} 会在界面上冒充真版本号，应为 0.0.0-unknown 之类可辨识的值`)
})
