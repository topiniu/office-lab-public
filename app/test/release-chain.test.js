import test from 'node:test'
import assert from 'node:assert/strict'
import { CHAIN_LINKS, reconcileReq, reconcileRelease, renderReleaseChain, deployManifest, renderDeployManifest, lintReleaseSql, rollbackPlan, renderRollbackPlan, ALL_DEPLOYABLE } from '../release-chain.js'

const full = over => Object.fromEntries(CHAIN_LINKS.map(k => [k, true])).constructor === Object
  ? { ...Object.fromEntries(CHAIN_LINKS.map(k => [k, true])), ...over } : {}

// ---------- E4/D1 发布链 ----------
test('整链坐实才算「已上线」', () => {
  const r = reconcileReq('REQ-1', full({}))
  assert.equal(r.released, true)
  assert.equal(r.displayStatus, '已上线')
})
test('断在哪就显示断在哪——绝不显示「已上线」（专治半发布）', () => {
  const r = reconcileReq('REQ-1', full({ content: false }))
  assert.equal(r.released, false)
  assert.equal(r.firstMissing, 'content')
  assert.match(r.displayStatus, /未上线（断在「目标分支 content 坐实/)
})
test('探测不到（undefined）按缺失算，且原因写「未探测」而不是「缺失」', () => {
  const f = full({}); delete f.deployed
  const r = reconcileReq('REQ-1', f)
  assert.equal(r.released, false)
  assert.match(r.links.deployed.why, /未探测到/)
  assert.match(r.links.deployed.why, /按缺失算，不按通过算/)
})
test('firstMissing 取链上最早缺的那一环（便于定位「先补哪一步」）', () => {
  const r = reconcileReq('REQ-1', full({ push: false, merged: false }))
  assert.equal(r.firstMissing, 'push')
})
test('releasedProd 由对账器派生：任一条断链即 false', () => {
  const rec = reconcileRelease([{ req: 'A', facts: full({}) }, { req: 'B', facts: full({ deployed: false }) }])
  assert.equal(rec.releasedProd, false)
  assert.equal(rec.allReleased, false)
  assert.equal(rec.broken.length, 1)
})
test('全部坐实 → releasedProd=true', () => {
  const rec = reconcileRelease([{ req: 'A', facts: full({}) }, { req: 'B', facts: full({}) }])
  assert.equal(rec.releasedProd, true)
})
test('空列表不算已发布（0 条不该被当成"全部通过"）', () => {
  const rec = reconcileRelease([])
  assert.equal(rec.releasedProd, false)
})
test('半发布形态被显式识别并点名', () => {
  const rec = reconcileRelease([{ req: 'A', facts: full({}) }, { req: 'B', facts: full({ content: false }) }])
  assert.equal(rec.halfReleased, true)
  assert.match(renderReleaseChain(rec), /半发布形态/)
})
test('全部断在早期环节（都没 commit）不算半发布——那是整版没发', () => {
  const rec = reconcileRelease([{ req: 'A', facts: full({ commit: false }) }, { req: 'B', facts: full({ commit: false }) }])
  assert.equal(rec.halfReleased, false)
})
test('renderReleaseChain 逐条列出断链明细', () => {
  const rec = reconcileRelease([{ req: 'REQ-9', facts: full({ push: false }) }])
  const md = renderReleaseChain(rec)
  assert.match(md, /REQ-9 断链明细/)
  assert.match(md, /已 push 到远端/)
})

// ---------- D2 部署清单 ----------
test('直接改可部署模块 → 只发那个服务，其余点名「无改动、不发」', () => {
  const m = deployManifest(['web-app-web/src/A.java'])
  assert.deepEqual(m.deploy.map(d => d.service), ['web(8041)'])
  assert.equal(m.skipped.length, ALL_DEPLOYABLE.length - 1)
  assert.match(renderDeployManifest(m), /无改动、不发/)
})
test('库模块改动 → 连带重发所有下游服务（jar 库不单独部署）', () => {
  const m = deployManifest(['web-app-datasource/src/E.java'])
  assert.equal(m.deploy.length, ALL_DEPLOYABLE.length)
  assert.deepEqual(m.libTouched, ['web-app-datasource'])
  assert.match(m.deploy[0].reasons.join(), /连带重新部署/)
})
test('同一服务被两条理由命中时理由合并、不重复上清单', () => {
  const m = deployManifest(['web-app-web/A.java', 'web-app-common/B.java'])
  const web = m.deploy.filter(d => d.service === 'web(8041)')
  assert.equal(web.length, 1)
  assert.equal(web[0].reasons.length, 2)
})
test('非代码目录不触发部署但会被点名', () => {
  const m = deployManifest(['docs/a.md', 'README.md'])
  assert.equal(m.deploy.length, 0)
  assert.ok(m.nonDeployable.includes('docs'))
  assert.match(renderDeployManifest(m), /无需部署任何后端服务/)
})
test('渲染里写明用三点 diff（两点会把他组模块误算进来）', () => {
  assert.match(renderDeployManifest(deployManifest([])), /三点 merge-base 净 delta/)
})

// ---------- D3 SQL 校验 ----------
const CLEAN_SQL = `-- 执行库：supplier_center；顺序：先 DDL 再发服务
CREATE TABLE t_a (id BIGINT PRIMARY KEY COMMENT '主键');
ALTER TABLE t_b ADD COLUMN loss_rate DECIMAL(10,4) COMMENT '损耗率', ADD COLUMN memo VARCHAR(64) COMMENT '备注';
-- 验证：SELECT COUNT(*) FROM t_b WHERE loss_rate IS NOT NULL;
`
test('干净的纯净版 SQL 无 error', () => {
  const r = lintReleaseSql(CLEAN_SQL, { backfillRows: 0, targetDbVersion: 'MySQL 5.7', rollback: '纯新增列，不需回滚' })
  assert.equal(r.clean, true, JSON.stringify(r.errors))
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings))
})
test('ALTER 在 CREATE 之前 → 顺序违规', () => {
  const r = lintReleaseSql('ALTER TABLE a ADD COLUMN x INT;\nCREATE TABLE b (id INT);', { backfillRows: 0, targetDbVersion: '8.0', rollback: 'x' })
  assert.ok(r.errors.some(e => e.code === 'SQL_ORDER'))
})
test('同一张表被 ALTER 两次 → 必须合并', () => {
  const r = lintReleaseSql('ALTER TABLE a ADD COLUMN x INT;\nALTER TABLE a ADD COLUMN y INT;', { backfillRows: 0, targetDbVersion: '8.0', rollback: 'x' })
  assert.ok(r.errors.some(e => e.code === 'SQL_MULTI_ALTER'))
})
test('DMS / MySQL 5.7 不兼容语法逐条抓（临时表 / 窗口函数 / CTE / 会话变量 / DELIMITER）', () => {
  const codes = s => lintReleaseSql(s, { backfillRows: 0, targetDbVersion: '5.7', rollback: 'x' }).errors.map(e => e.code)
  assert.ok(codes('CREATE TEMPORARY TABLE tmp AS SELECT 1;').includes('DMS_TEMP_TABLE'))
  assert.ok(codes('SELECT ROW_NUMBER() OVER (PARTITION BY a) FROM t;').includes('MYSQL57_WINDOW_FN'))
  assert.ok(codes('WITH x AS (SELECT 1) SELECT * FROM x;').includes('MYSQL57_CTE'))
  assert.ok(codes('SET @i = 0;').includes('DMS_SESSION_VAR'))
  assert.ok(codes('DELIMITER $$').includes('DMS_DELIMITER'))
})
test('注释里的 CREATE TABLE 不参与顺序判定（剥注释后再判）', () => {
  const r = lintReleaseSql('ALTER TABLE a ADD COLUMN x INT;\n-- CREATE TABLE b (id INT);', { backfillRows: 0, targetDbVersion: '8.0', rollback: 'x' })
  assert.ok(!r.errors.some(e => e.code === 'SQL_ORDER'))
})
test('含 UPDATE/INSERT 但没给影响行数预估 → error（REQ-0239 回填 10,635 行没人预估过）', () => {
  const r = lintReleaseSql('UPDATE t SET a=1;', { targetDbVersion: '8.0', rollback: 'x' })
  assert.ok(r.errors.some(e => e.code === 'SQL_NO_ROW_ESTIMATE'))
})
test('横幅装饰 / 长头注 / 缺尾部验证 各自被抓', () => {
  const banner = lintReleaseSql('████ 上线说明 ████\nCREATE TABLE a (id INT);', { backfillRows: 0, targetDbVersion: '8', rollback: 'x' })
  assert.ok(banner.errors.some(e => e.code === 'SQL_BANNER'))
  const verbose = lintReleaseSql('-- a\n-- b\n-- c\n-- d\nCREATE TABLE a (id INT);', { backfillRows: 0, targetDbVersion: '8', rollback: 'x' })
  assert.ok(verbose.warnings.some(w => w.code === 'SQL_VERBOSE_HEAD'))
  const noVerify = lintReleaseSql('CREATE TABLE a (id INT);', { backfillRows: 0, targetDbVersion: '8', rollback: 'x' })
  assert.ok(noVerify.warnings.some(w => w.code === 'SQL_NO_VERIFY'))
})
test('未声明库版本 / 回滚口径 → warning（B5 的强制清单项）', () => {
  const r = lintReleaseSql(CLEAN_SQL, { backfillRows: 0 })
  assert.ok(r.warnings.some(w => w.code === 'SQL_NO_DB_VERSION'))
  assert.ok(r.warnings.some(w => w.code === 'SQL_NO_ROLLBACK'))
})

// ---------- D4 回退 ----------
test('回退方案缺锚点/缺 DDL 可逆性声明 → 不 ok 并逐条列出', () => {
  const p = rollbackPlan({ version: 'v5.20' })
  assert.equal(p.ok, false)
  assert.ok(p.missing.some(m => /可回退版本/.test(m)))
  assert.ok(p.missing.some(m => /DDL 是否可逆/.test(m)))
  assert.match(renderRollbackPlan(p), /未记录/)
})
test('DDL 不可逆但没给补偿方案 → 报缺', () => {
  const p = rollbackPlan({ prevTag: 'v5.19', services: ['service(8040)'], ddlReversible: false })
  assert.ok(p.missing.some(m => /没给数据补偿/.test(m)))
})
test('完整回退方案 ok，且步骤里含「回退也要验证」', () => {
  const p = rollbackPlan({ prevTag: 'v5.19', services: ['service(8040)'], ddlReversible: true })
  assert.equal(p.ok, true)
  assert.match(p.steps.join('\n'), /回退后立刻在测试环境跑本版 facet 的冒烟/)
})
