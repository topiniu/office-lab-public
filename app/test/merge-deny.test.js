// 「程序化合并 MR」硬 deny 的回归（DANGER_DENY 里那几条 merge 模式）。
//
// 红线本身很老（2026-07-29，run `20260729022941`：波比在放行后跑去 `glab` 自合）——合并只由老板在 GitLab 网页点。
// 本测试钉的是 2026-09-21 那次**误伤**（run `20260921074152-5a44fd`）：原模式 `Bash(*glab* merge*)` /
// `Bash(*glab*mr*merge*)` 拿整条命令串做通配，而 deny 只看字面、不分「命令动词」与「字符串字面量」。波比给前端 MR
// 写的 description 是「发测 master(经 -master 中转 merge dev,无冲突)」，那个 merge **只是描述文案**，却把
// `glab mr create` 整条判死；他换了 6 种写法、连吃 8 次 deny 都绕不过，最终两个前端 MR **根本没建成**、降级成甩
// 「创建链接」给老板自己点。而「-master 中转分支 merge dev」恰恰是前端发测 SOP 的标准描述 → 这条红线等于把
// **前端发测 MR 系统性堵死**（后端那条能过，只因描述里碰巧没写 merge）。
//
// 一般化的教训（这才是本测试真正想守住的）：**高危 deny 的通配符不能跨过「命令动词」去匹配用户数据段**——
// title / description / commit message 里什么词都可能出现。宁可多列几条精确模式，也别用一个宽通配连坐整类正当动作。
//
// 下面 MUST_ALLOW 里的前三条是那一轮**真实被误杀**的原始命令（照抄自 run 日志），它们必须放行；
// MUST_DENY 则钉住红线本体不许被这次放宽带塌。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const APP = path.resolve(import.meta.dirname, '..')
const src = fs.readFileSync(path.join(APP, 'server.js'), 'utf8')

const m = src.match(/^const DANGER_DENY = \[[\s\S]*?^\]/m)
if (!m) throw new Error('抠不到 DANGER_DENY：server.js 结构变了，请同步更新 test/merge-deny.test.js')
// 只取 Bash(...) 字面量（跳过注释行）
const RULES = [...m[0].matchAll(/'(Bash\([^']*\))'/g)].map(x => x[1])

// 把 `Bash(pattern)` 的通配语义翻成正则：`*` 匹配任意串，其余字面量。整条命令串做全匹配。
function toRe(rule) {
  const inner = rule.slice(5, -1)
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + inner.split('*').map(esc).join('[\\s\\S]*') + '$')
}
const RES = RULES.map(r => ({ rule: r, re: toRe(r) }))
const matched = cmd => RES.filter(r => r.re.test(cmd)).map(r => r.rule)

const MUST_DENY = [
  ['glab mr merge 387', '合并子命令'],
  ['cd /d/x && GITLAB_HOST=h glab mr merge !387', '前面挂了 cd/env 也要拦'],
  ['glab -R 192.0.2.143:1180/web/x mr merge 12', '中间插了 -R 也要拦'],
  ['glab mr create --merge --source-branch a --target-branch master', '建 MR 时顺手自合'],
  ['glab mr create --auto-merge --source-branch a', '--merge 匹配不到 --auto-merge，必须单列'],
  ['GITLAB_HOST=h glab api -X POST "projects/1372/merge_requests/387/merge"', 'REST 合并端点'],
  ['curl -X PUT "http://h/api/v4/projects/1372/merge_requests/387/merge"', '绕开 glab 用 curl 合'],
]

const MUST_ALLOW = [
  // ↓ 这三条是 run 20260921074152-5a44fd 里真实被误杀的原始命令
  ['GITLAB_HOST=192.0.2.143:1180 glab api -X POST "projects/897/merge_requests" -f source_branch="feature/v5.23-sampling-spec-downstream-lab-master" -f target_branch="master" -f title="v5.23 示例项目 前端 发测" -f description="发测 master(经 -master 中转分支 merge dev,无冲突)。"', 'REST 建 MR，description 里有 merge 字样'],
  ['glab mr create --source-branch f-master --target-branch master --title "v5.23 前端发测" --description "发测master(-master中转merge dev无冲突)。" --yes', 'glab mr create，description 里有 merge 字样'],
  ['cd /d/x && glab mr create -R h/web/partner-app --source-branch a --target-branch master --description "发测master(-master中转merge dev,已排除本地代理)" --yes', '同上，带 -R'],
  ['GITLAB_HOST=h glab api "projects/1372/merge_requests/387"', '回读 MR 详情（无尾部 /merge）'],
  ['GITLAB_HOST=h glab api "projects/1372/merge_requests"', '列 MR'],
  ['git merge origin/master', '本地 merge：中转分支准备要用，从来不在红线内'],
  ['git checkout -b x-master origin/master && git merge dev', '-master 中转分支的标准做法'],
  ['glab mr list --source-branch feature/x', '查 MR'],
]

test('红线仍在：一切「程序化合并 MR」的形态都被 deny', () => {
  for (const [cmd, why] of MUST_DENY) {
    assert.ok(matched(cmd).length > 0, `应 deny 但放行了（${why}）：${cmd}`)
  }
})

test('事故回归：MR 文案里出现「merge」不再被误杀——建 MR / 查 MR / 本地 merge 全部放行', () => {
  for (const [cmd, why] of MUST_ALLOW) {
    const hits = matched(cmd)
    assert.equal(hits.length, 0, `应放行却被 ${hits.join(' + ')} 拦下（${why}）：${cmd.slice(0, 90)}`)
  }
})

test('deny 模式不得跨过命令动词去匹配用户数据段（把关新增模式别再退回宽通配）', () => {
  // 纯文案串（没有任何命令动词）无论怎么写 merge 都不该命中任何一条 merge 规则
  const proseOnly = [
    'echo "本轮走 -master 中转分支 merge dev，解冲突后 push"',
    'git commit -m "chore: merge dev into v5.23-master 中转分支"',
  ]
  for (const cmd of proseOnly) {
    const hits = matched(cmd).filter(r => /merge/.test(r))
    assert.equal(hits.length, 0, `文案里的 merge 被当成动作拦了：${hits.join(' + ')} ← ${cmd}`)
  }
})
