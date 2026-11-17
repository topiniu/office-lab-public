// 望子成龙小学 server —— 调度器 + 可视化后端（Node 18+；v0.2.0 起依赖 @anthropic-ai/claude-agent-sdk）。
// 产物流转永远走文件（任务档案/交接卡在仓库里）；本服务只负责：
//   1. 扫任务档案 frontmatter 渲染看板数据
//   2. 用 Agent SDK query() 拉起员工（工牌系统提示 append 到 claude_code preset），typed 消息流式回传
//   3. 常驻流式 query：同一 run 多轮往同一 query 推消息 → prompt 缓存热；断连/idle 后用 resume 冷起
//   4. canUseTool 动态权限：危险命令路由到 Lab UI 审批（替代静态白名单硬门槛）
import http from 'node:http'
import { waitForRunInput, answerRunInput, WORK_CONTINUITY_MANDATE } from './user-input.js'
import { buildHandoverSeed, handoverRun, HandoverError } from './engines/handover.js'
import { createModelCatalog } from './engines/models.js'
import { spawn, execFile } from 'node:child_process'
import { engines, createEngineConfigStore, engineForRun, selectNewEngine, enabledEngineIds, createToolServer as createSdkMcpServer, tool } from './engines/index.js'
import { z } from 'zod'   // 仅供 SDK tool() 的入参 schema（已在 app/package.json 显式声明，别再当它是"随 SDK 生态白送"的）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { indexContract as indexUiContract, diffContracts as diffUiContracts, formatBlock as formatUiContractBlock } from './ui-contract.js'   // UI 状态契约变更侦测（不做 CI，改由引擎在流水线上算 diff 并注入消费者，见复盘 §3.96）
import { planBatch as planE2eBatch, executeBatch as executeE2eBatch, buildWakePrompt as buildE2eWakePrompt, DEFAULT_CONCURRENCY as E2E_DEFAULT_CONCURRENCY, MAX_CONCURRENCY as E2E_MAX_CONCURRENCY, MAX_FILES as E2E_MAX_FILES, isRedCalibration as isE2eRedCalibration } from './e2e-batch.js'   // E2E 批次：并发甩批 + 引擎唤起 + 自动附 repair-context（把「等/翻产物」从员工手里收归引擎，见复盘 §3.93）
import { COVERAGE_STATUS_ENUM, extractFacetsFromDoc, facetDocList, mergeFacetSets, extractCoverageMatrix, engineSetFacetRow, engineSeedCoverage, engineSetGate, computeCoverage, reqsWithValidGreen, rollupReqFacets, mergeFacetRows, reconcileCoverage, caseFacetMapFromTestFile, lintTestFile, facetClassMap, facetViaMap, parseEvidenceFields, validateMachineEvidence, validateArchive, caseChannel, inferFacetVia, viaSatisfies } from './coverage.js'   // 覆盖率闸门 + 有效性 linter（提案见 docs/迷糊QA覆盖率闸门-方案设计.md + QA可信度体系-业界最佳实践落地方案.md）
// 路径根的唯一事实源（改路径先读 paths.js 顶部的「三层路径语义」）：工作区根探测（monorepo 嵌套 / 独立 clone）
// + L(协议前缀)↔P(物理路径) 互转 + 双向容忍解析器。原先这几个函数散在本文件里、且 ROOT 写死为「上两级」。
import { ENTRY_STATUS_ENUM, ENTRY_RESULT_MAP, QA_ONWARD_STATUS, VER_CLOSED_STATUS, SHIPPED_STATUS } from './entry-status.js'   // 条目状态词汇：引擎侧唯一事实源（纯函数模块共用）
import { parseSourceMaterials, extractTraceRows, computeTrace, renderTraceSummary, scanSourceMaterial, TRACE_HINT, TRACE_GATE_SINCE } from './req-trace.js'
import { scanSubstance, extractLedgerRows, computeSubstance, renderSubstanceSummary, SUBSTANCE_HINT } from './req-substance.js'
import { extractTreeRows, computeFeatureTree, renderFeatureTree, TREE_HINT } from './feature-tree.js'
import { computeReqQuality, renderReqQuality, snapshotBaseline, renderBaseline, parseBaseline } from './req-quality.js'
import * as taskBrief from './task-brief.js'   // 档案简报：把「给人看的那 4%」抽出来（三件事 + delta），并把待确认事项接进晨检单，见复盘 §3.125   // 需求分析质量闸：①反向提问打标必须问出去 / ④机器点名·她逐条回应 / ⑤工作流↔功能树双向对账 / ⑥需求缺陷率（只报不拦），见复盘 §3.124   // 功能树闸：纵向那半个分母（需求→叶子四要素），与溯源闸互为分母，见复盘 §3.123   // 需求溯源闸：facet 表对着「源材料可枚举单元」扫没扫全（coverage.js 管"测没测"，这里管"齐没齐"，见复盘 §3.122）
import { createRunSubs } from './run-subs.js'   // 会话事件复用全局 SSE（治 HTTP/1.1 每主机 6 连接被聊天窗口吃光，见 run-subs.js 顶注）
import { createWorkDocument } from './work-documents.js'
import { WORKSPACE_ROOT, WORKSPACE_MODE, OFFICE_ROOT, OFFICE_PREFIX, OFFICE_URI_PREFIX, officeRel, toAgentPath, safeResolve, resolveRepoFile, resolveRepoDir, resolveEmpFile, stripOfficePrefix, describeWorkspace } from './paths.js'
// ---- 守航能力增强（vision-e2e/docs/lab-guarded-run-capability-plan.md 的 lab 侧落地）----
// 分模块的理由与各自缘起见每个文件顶部的注释块；这里只汇总「哪个模块治哪一件真事」：
//   guard-ledger        E1 契约执行器 + 三红灯（越权/超预算/假绿都第一次有数）
//   morning-report      E2 晨检包装配器（模板存在四个月、0 份实例）+ E3 版本冻结与 deadline 结算
//   release-chain       E4/D1 发布链对账（治半发布）+ D2 部署清单（三点 diff）+ D3 SQL 校验 + D4 回退
//   gate-matrix         E6 门禁矩阵 + B6 高风险自动降级（哪道门该留不再靠临场判断）
//   stall-guard         E5/G1 收工即校验 + G2 进度快照 + G3 合法等待（巡视 79 次只 2 次真停）
//   requirement-pool    §2 需求表结构化字段 + A1~A5（就绪池/巡航/park 台账/窄口径/跨入口 facet）
//   handoff-freeze      B1 交接即冻结 + B2 worktree + B3 影响面雷达 + B5 DDL 核查 + B7 实施记录初稿
//   qa-report-card      C2~C6（人工债/视觉验收/大白话报告卡/QA 结果报告/造数租户）
//   audit-trust         F1 假绿猎手 + F2 intake 误判审计 + F3 逃逸复盘立案
//   zhuzhu-capabilities 猪猪 v1.5 四个新接口的消费层（**接口缺位一律降级为「未验证」，绝不当通过**）
import * as guardLedger from './guard-ledger.js'
import * as acceptanceCard from './acceptance-card.js'   // 验收卡（v0.11.0）：一个需求一张卡——做完没 / 长啥样 / 动了哪些老功能 / 要你拍的高危事项（取代给人读的晨检包长文档）
import * as guardGoal from './guard-goal.js'             // 守航目标循环（v0.11.0）：链停了、活没干完 → 引擎接着派人，直到做完/真卡住/到点
import * as morningReport from './morning-report.js'
import * as versionReport from './version-report.js'   // 晨检包 v2：按版本出验收单（轮次级仍由 morning-report 兜底）
import * as releaseChain from './release-chain.js'
import * as gateMatrix from './gate-matrix.js'
import * as stallGuard from './stall-guard.js'
import * as reqPool from './requirement-pool.js'
import * as handoffFreeze from './handoff-freeze.js'
import { createLaneManager, renderLaneBlock, laneForTask, normTaskFile, MAIN_LANE_ID, REPOS as LANE_REPOS, SERVICES as LANE_SERVICES } from './lanes.js'   // 工作区（lane）：多需求并行的 worktree + 端口槽位 + 起停（2026-09-28，见 lanes.js 顶部缘起）
import * as qaCard from './qa-report-card.js'
import * as auditTrust from './audit-trust.js'
import * as zhuzhuCaps from './zhuzhu-capabilities.js'
import * as designBaseline from './design-baseline.js'   // 示例项目模块设计基线 + 审美判定（2026-09-07 老板定：以模块页面为标准、加审美档）
import * as uxContract from './ux-contract.js'           // 模块 UX 契约静态检查（2026-09-08 老板定·方案 A：upload 粘贴/modal 快捷键这类沉淀，视觉三层与猪猪动作都覆盖不到）
import * as pageScan from './page-scan.js'               // 页面「一眼巡检」（2026-09-08 老板定：测完判绿、人工一打开还是一堆问题——视觉三层全是比对式，答不了"这页哪儿不对劲"）
import * as prescreen from './visual-prescreen.js'       // 视觉初筛（2026-10-06 老板定；2026-10-22 起取代人工预检：QA 前先由迷糊对照示例项目母版 + 业内准则筛一遍，老板不再当第一道视觉关）
import * as trayWatchdog from './tray-watchdog.js'       // 伙伴看护：引擎反过来盯托盘（2026-09-09 老板报「怎么托盘没了」——托盘 59 次启动 56 次无声消失、死因未定，而引擎活得比它久）
import * as quickPhrases from './quick-phrases.js'   // 快捷短语：聊天输入框上方的常用话术，设置里增删改、可按员工限定（2026-10-07）
import { isLocalRequest, revealCommand, clipboardCommand, focusRevealCommand, openDirCommand } from './reveal.js'   // 本机文件动作：文件管理器定位 / 文件塞剪贴板（发布交付物直接转发进企微，省掉开文件管理器拖拽）

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 员工 agent 的工作树 + 越权校验外边界。嵌套模式 = monorepo 顶层（同今天）；独立模式 = office-lab 仓根
// （不再逃到仓库外）。保留 ROOT 这个名字：兄弟仓相关的 20+ 处引用一行不动，语义仍是「工作区根」。
const ROOT = WORKSPACE_ROOT
const TASKS_DIR = path.join(OFFICE_ROOT, 'tasks')
fs.mkdirSync(TASKS_DIR, { recursive: true })
// runs 目录可用 OFFICE_LAB_RUNS_DIR 覆盖：测试实例指到临时目录，绝不与生产 runs/ 共用（否则会误删/污染
// 真实配置——曾因测试清理 rm 掉 runs/wecom-config.json 导致企微配置每次重启都被清空）。默认 app/runs。
const RUNS_DIR = process.env.OFFICE_LAB_RUNS_DIR ? path.resolve(process.env.OFFICE_LAB_RUNS_DIR) : path.join(__dirname, 'runs')
try { fs.mkdirSync(RUNS_DIR, { recursive: true }) } catch { }
// 守航台账目录（三红灯 ledger + park 台账）。与 RUNS_DIR 同级声明：park 台账常量在文件更早处被用到，
// 放到守航段里会撞 TDZ（const 不提升初始化）——踩过一次，别再挪回去。
const GUARD_DIR = path.join(RUNS_DIR, 'guard')
const UPLOADS_DIR = path.join(__dirname, 'uploads')
const PUBLIC_DIR = path.join(__dirname, 'public')
const WEB_DIR = path.join(OFFICE_ROOT, 'web', 'dist')
const EMPLOYEES = JSON.parse(fs.readFileSync(path.join(__dirname, 'employees.json'), 'utf8'))
for (const employee of Object.values(EMPLOYEES)) {
  const memory = path.join(OFFICE_ROOT, employee.memoryFile)
  fs.mkdirSync(path.dirname(memory), { recursive: true })
  try { fs.writeFileSync(memory, '# 工作记录\n', { flag: 'wx' }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
const engineConfigStore = createEngineConfigStore(path.join(RUNS_DIR, 'engine-config.json'), engines.ids())
const codexModelCatalog = createModelCatalog()
const activeEngineIds = () => enabledEngineIds(engineConfigStore.get(), engines.ids())
const activeEngineList = () => { const ids = activeEngineIds(); return engines.list().filter(e => ids.includes(e.id)) }
function newRunEngine({ engine, employee, caller } = {}) {
  return selectNewEngine({ engine, employeeEngine: EMPLOYEES[employee]?.engine, callerEngine: caller && activeEngineIds().includes(engineForRun(caller)) ? engineForRun(caller) : undefined, config: engineConfigStore.get() }, activeEngineIds())
}
function query({ prompt, options }) {
  const engine = options.engine || engineConfigStore.get().defaultEngine
  const engineConfig = engineConfigStore.get().providers[engine]
  // 抛在首次迭代里，走调用方既有的流错误处理（与引擎自身报错同一路径）
  if (engineConfig?.disabled) return (async function* () { throw new Error(`执行基座「${engines.list().find(e => e.id === engine)?.label || engine}」已停用，请用「切换基座」交接到其他基座继续`) })()
  return engines.query({ prompt, options: { ...options, engine, engineConfig, protectedCodeRoots: ['frontend', 'backend'] } })
}
// 工作台版本号的**唯一事实源** = app/package.json 的 version；经 /api/health 下发给托盘与新 UI 侧栏（Office Lab · v…）。
// 读不到时给的是 `0.0.0-unknown` 而不是某个像样的旧版本号——界面上印一个"看着对但其实是兜底"的版本，
// 等于给自己造假事实（同 §3.104「新指标不许自带虚假健康值」）。发版流程见 CHANGELOG「版本号维护」。
let VERSION = '0.0.0-unknown'
try { VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || VERSION } catch { }

// ---------- 模型由基座配置决定；角色分档只用于 Claude 思考预算 ----------
// 全员统一 Opus（含闲聊）：之前菲菲/波比及所有 chat 走 Sonnet，被感知成「变笨」，现全部提到 heavy。
const EMP_TIER = { ggbond: 'heavy', mihu: 'heavy', feisila: 'heavy', feifei: 'heavy', bobby: 'heavy', chaorenq: 'light' }   // 巡视员=light：判「该不该停」是简单分类、频次高，思考预算给低档
// 选型优先级：会话固定模型 > 对应基座默认模型；不同基座不共享模型 ID。
function resolveTier(run, kind) {
  return EMP_TIER[run.employee] || 'heavy'
}
function resolveModel(run, kind) {
  if (run.model) return run.model
  return engineConfigStore.get().providers[engineForRun(run)]?.model || undefined
}

// 思考预算（防"一轮想 3 万+ token"失控，曾见单轮 36500 token、65 分钟空想）。
// ⚠ 2026-08-31：**这个数字管不住模型，别指望它**。原实现把它塞进子进程 env `MAX_THINKING_TOKENS`；SDK 明写
//   （sdk.d.ts `maxThinkingTokens` 的 @deprecated）Opus 4.6 起该值只当 on/off 用（0=关，非 0=adaptive）。
//   换成非 deprecated 的 `thinking: { type:'enabled', budgetTokens }` 后**实测依旧不封顶**：同一道题
//   budgetTokens=1024 那次的思考签名 7852 字符，比 budgetTokens=16000 那次（4320）还长——两条路在 SDK 里都
//   翻成同一个 `--max-thinking-tokens` flag，Opus 侧一并按 adaptive 处理。
//   所以真正的天花板在引擎侧自己那道刹车：THINKING_RUNAWAY_TOKENS（见下），靠 SDK 的 thinking_tokens 心跳
//   实时盯住单条消息的思考量，超顶当场掐断。这里保留 budgetTokens 只作**意图声明 + 平台哪天认了就自动生效**，
//   不作为保障。事故：run 20260831080340-e5f6c2 单条消息 stop_reason=max_tokens、output_tokens=64000 全烧在
//   思考上，21 分 47 秒零产出，并就此把整条会话带进空转死循环（§3.109）。
const THINKING_BUDGET = { heavy: 24000, light: 12000 }
function resolveThinking(run, kind) { return THINKING_BUDGET[resolveTier(run, kind)] }
// 传给 SDK 的思考配置（唯一构造点，employee / 会议 / 企微人格三条 query 共用，别再各自拼 env）
function thinkingConfig(budgetTokens) { return { type: 'enabled', budgetTokens } }
// 单条消息思考量硬顶（**引擎侧唯一真正生效的那道刹车**）：超顶即判空想失控，当场掐断这条消息并带纠偏续跑。
// 掐得早还有个关键好处——那坨巨型思考块**不会被写进 transcript**，也就不会把会话毒化（毒化机制见 markPoisoned）。
// 取值：全库 21,874 条健康消息 output_tokens p99.9 = 15,682、最大 28,428，故 30k 顶不会误伤正常工作；
// 而失控那次是 64,000（模型输出上限），30k 能在烧掉一半之前截停。
const THINKING_RUNAWAY_TOKENS = 30000

// ---------- 健壮性：进程存活 watchdog + 连接中断自动续跑 ----------
// 事故背景（2026-07-15）：feifei 单 turn 一次性写三份大文件、流式 4.5 分钟后触发
// `API Error: Connection closed mid-response`，子进程异常但不触发 close → status 永远 running →
// /reply 恒 409 吞掉用户"继续" = 僵尸 run。下列常量/判据用于自动发现并自愈。
const WATCHDOG_INTERVAL_MS = 30_000          // 巡检周期
const WATCHDOG_BASE_GRACE_MS = 150_000       // 基础宽限：完全无 stdout/stderr 字节的容忍时长
const WATCHDOG_THINK_FACTOR = 12             // 叠加宽限 = 思考预算(token) × 系数(ms)，重活容忍更久（长思考仍有 stream 事件刷新活动，真卡死是零字节）
const MAX_AUTO_RETRIES = 10                  // 连接中断/卡死自动 resume 续跑上限（兜住烧钱死循环）
const STALL_TAKEOVER_MS = 180_000            // /reply 判定"卡死可强制接管"的空闲阈值
const IDLE_CLOSE_MS = 180_000                // 常驻 query 收工后空闲多久自动 close（释放子进程；<5min 缓存 TTL，超窗回复自然冷起 resume）
// 抄送(cc)扇出闸：cc 让不同员工并行,天然有「广度爆炸」风险(线性接力模型从未有)——两道保守上限兜底。
const CC_MAX_PER_TURN = 2                     // 单回合最多抄送几人（防一轮狂扇）
const CC_MAX_THREAD_RUNS = 4                  // 同一 threadRootId 并存活跃 run 上限（防跨回合累积爆炸）
const CC_JOIN_MAX_FIRES = 5                   // 抄送汇合：同一条发起 run 最多被唤回几次（防「唤回→再 cc→再唤回」失控；一轮会审只用 1 次）
const PERM_TIMEOUT_MS = 300_000              // canUseTool 审批无人应答的自动拒绝超时
const PERM_PUSH_MS = 60_000                  // 审批挂起多久仍无人处理 → 升级发 Bark（点通知开手机审批页）
const BG_RESUME_GRACE_MS = 5_000             // 后台任务 settle 后、无前台 turn 时，等这么久观察 SDK 是否自续；不续才由引擎注入唤起（防重复注入，见 scheduleBgResume）
// 空转熔断（2026-08-09 事故根因，run 20260809051651-be53e4 / session 4e94e142，菲菲）：一轮内 SDK 内部
// 「无可见输出」自催（claude.exe 注入 no-visible-output/Continue 逼模型再说）达此次数 = 本轮在空转——
// 早期吐了句没用的旧话、随后反复只思考没产出收尾，末 result 空。此时禁用 _turnText 兜底假绿（见 consumeStream/
// onTurnComplete）：那段残留文本不是收尾、是噪声，别拿它掩盖空转、别把 _emptyStreak 归零。详见复盘。
const SILENT_SPIN_NUDGES = 2
// 「零产出轮次」阈值（2026-08-24 事故根因，run 20260824015731-60a5b7，菲菲）：上面那道闸把判据挂在 SDK 注入的
// `no visible output` **文本**上，可是同一种空转还有另一条路——SDK 直接重发一次 API 请求（不注入任何 user 消息），
// 于是 nudges 恒为 0、闸门形同虚设。该 run 读完大档案后连出两条**只含 thinking 块**的顶层 assistant 消息
// （msg_…kQ3i6 / msg_…kTrFsk，message.id 不同、cache_creation 8738→8767 只差一个思考块 = 两次独立请求），
// 末 result 为空却 subtype=success，兜底遂取上一句陈旧文本「…先读它。」假绿收工。
// 现改为**双判据**：nudge 次数 或 本轮零产出顶层消息数，任一达阈即判空转。零产出＝该 message.id 全程没吐过
// text、也没发起 tool_use（纯 thinking）——健康的一轮必以文本或工具收尾，连续两条纯思考即状态已坏。
const BARREN_TURN_LIMIT = 2
function barrenTurns(run) {
  if (!run._turnMsgs) return 0
  let n = 0
  for (const produced of run._turnMsgs.values()) if (!produced) n++
  return n
}
function isSpunTurn(run) {
  return (run._sdkNudges || 0) >= SILENT_SPIN_NUDGES || barrenTurns(run) >= BARREN_TURN_LIMIT
}
// 会话中毒 → 换会话重开（2026-08-31，见 §3.109）。此前空转的唯一"恢复"动作是 **resume 同一条 transcript**，
// 而致病物就写在那条 transcript 里：模型每空转一次，就往自己的历史里追加一条「我思考完了然后什么都不说」的
// 前例，resume 等于把坏样例重新喂回去、再追加一条。全库 21,984 条顶层消息实测这一自我强化极其陡峭：
//     P(下一条零产出 | 上一条正常)  = 0.26%   (55/21054)
//     P(下一条零产出 | 上一条零产出) = 40.5%   (32/79)   ← 156 倍
// 所以"会话不可恢复"从来不是物理定律，只是引擎缺一个恢复动作。现在补上：判中毒即**弃用该 sessionId**，
// 起一条干净会话，把任务档案 + 进度快照 + 上下文摘要作为交接播种进去（不从头重来）。
const BARREN_ABORT_STREAK = 2      // 连续几条零产出顶层消息即判中毒、当场掐断本轮（CLI 自催一次已失败＝没救了，再跑只是加毒）
const MAX_SPIN_RESEEDS = 1         // 每条 run 自动换会话重开的上限（兜住"换了还坏"的烧钱死循环；再坏才交回老板）
function watchdogGrace(run) {
  return WATCHDOG_BASE_GRACE_MS + (resolveThinking(run, run.lastKind) || 0) * WATCHDOG_THINK_FACTOR
}
// 是否该自动续跑：用户主动停 / 无 session / 已达上限 → 否；watchdog 判死 / 结果含连接错误文案 / 流中途抛错 → 是
function shouldAutoRetry(run, err) {
  if (err?.code === 'CODEX_WRITER_CONFLICT') return false // 等用户释放占用，不重复提问或隐式复制分支
  if (run._userStopped) return false
  if ((run._retries || 0) >= MAX_AUTO_RETRIES) return false
  if (!run.sessionId) return false             // 无会话无法 resume
  if (run._poisoned) return false              // 会话中毒：resume 只会把空转样例重新喂回去（换会话重开走 handleStreamEnd ①.5）
  if (run.stalled) return true                 // watchdog 已判死并 abort
  const r = String(run.result || '')
  if (run.isError && /connection closed|api error|overloaded|rate.?limit|econnreset|network|socket hang|terminated/i.test(r)) return true
  if (err && !r.trim()) return true             // 流中途抛错且无最终结果 = 中途夭折（非 agent 主动报错）
  return false
}

// 禁改生产代码的员工（非编码角色）：硬拦截兜底，防提示被忽略又去改代码。
// 菲菲(PM)曾把一个咨询越界改成 347 行 index.tsx——只有 GG Bond/迷糊 才准写代码/测试。
const CODE_LOCKED_EMPLOYEES = new Set(['feifei', 'bobby', 'chaorenq'])   // 巡视员只巡不写代码
const CODE_ROOTS = ['frontend', 'backend']
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
// 全员硬 deny 的高危命令（v0.2.0：员工走 'auto' 分类器自主放行普通命令，但这些致命操作 deny 恒生效——
// SDK 语义：scoped deny 规则在任何模式下都拦截，分类器也无法放行）。代码内置一份,不依赖 settings.json 是否被改。
const DANGER_DENY = [
  'Bash(rm -rf *)', 'Bash(rm -fr *)', 'Bash(rm -r /*)', 'Bash(sudo *)',
  'Bash(dd *)', 'Bash(mkfs *)', 'Bash(mkfs.*)', 'Bash(shutdown *)', 'Bash(reboot *)', 'Bash(halt *)',
  'Bash(git push --force*)', 'Bash(git push -f *)', 'Bash(git reset --hard *)', 'Bash(git clean -f*)',
  'Bash(chmod -R *)', 'Bash(chown -R *)', 'Bash(mv /* *)', 'Bash(> /dev/sd*)',
  // MR 合并只由人在 GitLab 网页点——硬禁员工自己"程序化合并 MR"（波比曾在放行后去找 glab 自合，run 20260729022941）。
  // 只拦「合并 MR」这一动作，不拦本地 git merge/cherry-pick（中转分支准备需要）、也不拦 push（docs 文档仓 push master 是例行授权、且会误伤 -master/-release 中转分支名）；直推代码仓 master/release 另由 GitLab 分支保护在服务端兜。
  // ⚠ 模式必须钉在**动作 token**（`mr merge` / `--merge` / API 的 `/merge` 端点）上，**绝不能钉在「merge 这个词」上**。
  //   事故（2026-09-21，run `20260921074152-5a44fd`）：原写法 `Bash(*glab* merge*)` / `Bash(*glab*mr*merge*)` 拿整条
  //   命令串做通配，而 deny 只看字面、不分「命令动词」与「字符串字面量」——波比给前端 MR 写的 description 是
  //   `发测 master(经 -master 中转 merge dev,无冲突)`，里头那个 **merge 只是描述文案**，却把 `glab mr create` 整条判死。
  //   连吃 8 次 deny、换了 6 种写法都绕不过（换 `glab api -X POST .../merge_requests` 照样被 `*glab* merge*` 拦），
  //   最终两个前端 MR **根本没建成**、降级成甩「创建链接」给老板自己点，白烧 2.5 分钟。而 `-master 中转分支 merge dev`
  //   恰恰是前端发测 SOP 的标准描述 → 这条红线等于把**前端发测 MR 系统性堵死**，后端那条能过只因描述里碰巧没写 merge。
  //   教训一般化：**高危 deny 的通配符不能跨过「命令动词」去匹配用户数据段**（title/description/commit message 里
  //   什么词都可能出现）；宁可多列几条精确模式，也别用一个宽通配把整类正当动作连坐。
  'Bash(*mr merge*)',            // `glab mr merge` / `glab -R x mr merge`（真·合并子命令；两 token 连写，文案不会撞）
  'Bash(*glab*--merge*)',        // `glab mr create --merge`
  'Bash(*glab*--auto-merge*)',   // `glab mr create --auto-merge`（`--merge` 匹配不到它，必须单列）
  'Bash(*merge_requests/*/merge*)',   // REST：POST projects/<id>/merge_requests/<iid>/merge（注意"建 MR"是 .../merge_requests 结尾，不含尾部 /merge，故不误伤）
]

// 与团队 CC 全局设置对齐的三名单（v0.2.1：员工从 'auto' 分类器切到 'acceptEdits' + 显式 allow/ask/deny）。
// 内置在引擎里（不依赖 ~/.claude/settings.json 是否被 settingSources 加载到），保证跨机一致、开箱即用。
// allow=自动放行（无需审批）；ask=触发 canUseTool → Lab UI 审批卡；未命中者在 acceptEdits 下默认走审批。
const PERM_ALLOW = [
  'Read', 'Glob', 'Grep', 'WebSearch',
  'Bash(pwd)', 'Bash(ls *)', 'Bash(rg *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(head *)', 'Bash(tail *)',
  'Bash(wc *)', 'Bash(file *)', 'Bash(which *)', 'Bash(command -v *)',
  'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git branch *)',
  'Bash(git remote *)', 'Bash(git rev-parse *)', 'Bash(git ls-files *)', 'Bash(git ls-remote *)', 'Bash(git fetch *)',
  'Bash(ping *)',
  'Bash(npm run *)', 'Bash(npm test *)', 'Bash(pnpm run *)', 'Bash(pnpm test *)', 'Bash(yarn run *)', 'Bash(yarn test *)',
  'Bash(pytest *)', 'Bash(go test *)', 'Bash(cargo test *)', 'Bash(mvn test *)', 'Bash(gradle test *)', 'Bash(./gradlew test *)',
  'Bash(* --version)', 'Bash(* --help *)',
  // 飞书多维表格（Lark MCP）：菲菲全权维护这张分诊表 → 读 + 写记录（建/改）+ **加字段** 都静默放行。
  // （用户拍板：登记/去重/补全/状态流转/加字段自主；优先级/拒绝提建议靠自律；删/改名/删行在 deny 硬禁。）
  'mcp__lark-mcp__bitable_v1_appTableRecord_search', 'mcp__lark-mcp__bitable_v1_appTable_list', 'mcp__lark-mcp__bitable_v1_appTableField_list',
  'mcp__lark-mcp__bitable_v1_appTableRecord_create', 'mcp__lark-mcp__bitable_v1_appTableRecord_update',
  'mcp__lark-mcp__bitable_v1_appTableField_create',
  // 菲菲记忆（只读本地对话/需求日志）——静默放行
  'mcp__feifei-memory__recall_conversations', 'mcp__feifei-memory__recall_staged_requirements',
]
const PERM_ASK = [
  // 注：不放 Bash(*|*)/(*;*)/(*&&*)/(*||*) 这类「含管道/链式就审批」的宽规则——员工几乎每条命令都用管道(find|grep 等)，
  // 挂上就每条都弹、无头下 5min 超时拒。危险链式(curl|sh、wget|sh)已在 deny；rm -rf/force-push 等靠 deny 的 *…* 通配拦，与是否链式无关。
  'Bash(git commit *)', 'Bash(git push *)', 'Bash(git merge *)', 'Bash(git rebase *)',
  'Bash(npm install *)', 'Bash(npm uninstall *)', 'Bash(pnpm add *)', 'Bash(pnpm remove *)', 'Bash(yarn add *)', 'Bash(yarn remove *)',
  'Bash(curl *)', 'Bash(wget *)', 'Bash(ssh *)', 'Bash(scp *)', 'Bash(rsync *)',
  'Bash(docker *)', 'Bash(kubectl *)', 'Bash(terraform *)',
]
// 与全局一致的 deny（与 DANGER_DENY 部分重叠，取并集即可）
const PERM_DENY = [
  'Bash(*rm -rf /*)', 'Bash(*rm -rf ~*)', 'Bash(*git reset --hard*)', 'Bash(*git clean -f*)',
  'Bash(*git push --force*)', 'Bash(*git push -f*)', 'Bash(*curl *|*sh*)', 'Bash(*wget *|*sh*)',
  // 飞书多维表格：硬禁「不可逆/改结构」操作（删行、删字段、改字段定义含改名）——这些只「提建议、用户拍板」，
  // 靠 deny 硬闸而非自律。加字段(appTableField_create)/记录读写不在此列，仍自主。（菲菲 bypass 下 deny 恒生效）
  'mcp__lark-mcp__bitable_v1_appTableRecord_delete', 'mcp__lark-mcp__bitable_v1_appTableRecord_batchDelete',
  'mcp__lark-mcp__bitable_v1_appTableField_delete', 'mcp__lark-mcp__bitable_v1_appTableField_update',
]

// 生成 deny 规则：相对 `./x/**` + 双斜杠绝对 `//abs/**` 两套 glob，覆盖所有写工具 × 代码根目录。
// 注意 glob 格式（实测）：`x/**`(无前缀) 与单斜杠绝对路径都**不匹配**；必须用 `./x/**` 或 `//abs/**`。auto/acceptEdits 模式下 deny 仍生效。
// v0.2.0：返回 deny 数组，供 SDK query 的内联 settings 选项 `{ permissions: { deny } }` 使用。
function codeLockDeny() {
  const deny = []
  for (const t of WRITE_TOOLS) for (const r of CODE_ROOTS) {
    deny.push(`${t}(./${r}/**)`)
    deny.push(`${t}(/${path.join(ROOT, r)}/**)`)   // 前置 / → `//Users/...`（双斜杠=绝对）
  }
  return deny
}

// ---------- 只读会话（consult）：员工正忙时也能并发开的第二个窗口 ----------
// 缘起：并发闸 busyRunFor 挡的是「同员工两条**可写**会话并发改同一个工作树」（cwd: ROOT，无 worktree 隔离，§3.49 互相踩写事故）。
// 但老板的高频需求是「GG Bond 正在开发时，我要另开一窗问他排查个 bug」——聊天/读码本身不冲突，被闸一刀切挡掉是过度保护。
// 故引入 consult 档：**零写能力**（写工具全局 deny + 不挂任何会写的 MCP）→ 工作树天然安全 → 并发闸对它不适用。
// 它是流水线之外的「旁支」：不接棒、不被巡视、不写会话看板、不沉淀教训、不占员工忙闲（见各 isConsult 守卫）。
const isConsult = run => !!(run && run.consult)
// 静默放行的只读工具白名单。**刻意不复用 PERM_ALLOW**——那份含 Bash(npm run *)/Bash(mvn test *) 等会跑构建的条目，
// 而构建/测试会写 target/、node_modules、占端口，撞共享环境（正式会话可能正在用）。这里只留纯读。
const CONSULT_ALLOW = [
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'Bash(pwd)', 'Bash(ls *)', 'Bash(rg *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(cat *)',
  'Bash(head *)', 'Bash(tail *)', 'Bash(wc *)', 'Bash(file *)', 'Bash(which *)', 'Bash(command -v *)',
  'Bash(git status *)', 'Bash(git diff *)', 'Bash(git log *)', 'Bash(git show *)', 'Bash(git branch *)',
  'Bash(git blame *)', 'Bash(git rev-parse *)', 'Bash(git ls-files *)',
]
// 白名单外的工具不是直接拒：permissionMode='default' 下落 canUseTool → Lab 审批卡，老板在场点一下即可（只读会话本就是有人在看时开的）。
// 但下面这些**恒 deny、审批卡都不给**：一切写工具（裸工具名＝全局封死，比 codeLockDeny 的按目录 glob 更严）、
// 提交/推送/切分支、构建与重启（撞共享环境 + 会让正式会话跑的产物被换掉）。
function consultDeny() {
  return [
    ...PERM_DENY, ...DANGER_DENY,
    ...WRITE_TOOLS,                                  // Edit/Write/MultiEdit/NotebookEdit 全局禁（不带 glob = 该工具整个不可用）
    'Bash(git commit *)', 'Bash(git push *)', 'Bash(git checkout *)', 'Bash(git switch *)',
    'Bash(git merge *)', 'Bash(git rebase *)', 'Bash(git stash *)', 'Bash(git apply *)', 'Bash(git restore *)',
    'Bash(mvn *)', 'Bash(npm run *)', 'Bash(npm install *)', 'Bash(pnpm *)', 'Bash(yarn *)',
    'Bash(*manage-backend*)', 'Bash(*manage-frontend*)',
    'Bash(*>*)', 'Bash(*>>*)',                       // 重定向写文件（Bash 是绕开写工具 deny 的唯一口子）
    'Bash(rm *)', 'Bash(mv *)', 'Bash(cp *)', 'Bash(mkdir *)', 'Bash(touch *)', 'Bash(tee *)', 'Bash(sed -i*)',
  ]
}

// 系统提示分档：闲聊只注入"身份+聊天模式"精简段（砍掉 5 阶段/门禁/四自检/交付物那套重 SOP，
// 那是给完整版本需求用的，闲聊套上就会逼模型穷尽合规导致巨额思考）；正式派工才上全文工牌。
function buildRolePrompt(emp, kind, { consult = false } = {}) {
  // 闲聊与派工都给全文工牌：之前 chat 裁掉重 SOP + 走 Sonnet，被感知成「浅」；现全员 Opus，chat 也给全文。
  // 工牌优先取 .claude/agents 卡片；该卡片在独立 checkout 里可能缺失（原在 monorepo 顶层、未入 office-lab 库），
  // 此时回退到 roles/*.md 全量角色定义（已入库、内容更完整），保证员工照常拉起。
  const abs = resolveEmpFile(emp.agentFile) || resolveEmpFile(emp.roleFile)
  if (!abs) throw new Error(`员工「${emp.displayName || ''}」缺少工牌/角色文件（agentFile=${emp.agentFile} roleFile=${emp.roleFile}）`)
  const card = stripFrontmatter(fs.readFileSync(abs, 'utf8')) + CARD_OUTPUT_MANDATE + (consult ? '' : WORK_CONTINUITY_MANDATE)
  // 只读会话（consult）不给「看板硬回写」段：那段逼员工用引擎工具回写档案，而只读会话根本没挂这些工具
  // （见 startRun 的 consult 分支：mcpServers 为空），注进去只会让它满世界找不存在的工具、或改用 Edit 撞 deny。
  // toAgentPath：把工牌/角色文件里的 `office-lab/…`（L 层协议写法）改写成当前形态的真实相对路径。
  // 一次改写吃掉 roles/*.md 与 .claude/agents/*.md 里全部路径示例，**这些 md 本身一行不用改**。
  // 嵌套且目录同名时它是恒等函数 → 原机器行为一字不变。
  return toAgentPath(consult ? card : card + BOARD_UPDATE_MANDATE)
}

// 全员共享硬规则：拍板点配动作卡 + 高频交付物配展示卡（单一事实源，四人拉起时都注入，防各角色 SOP 漂移）。
// 缘起：会话 ead5e4fb 波比整场零 olcard、拿散文 + 裸 marker/裸链接收尾——软提示无效，改硬门槛。协议见根《消息卡片协议.md》。
const CARD_OUTPUT_MANDATE = `

---

## 【消息卡片 · 硬格式】（全员强制，收工门槛）

会话里凡有**对应卡型的结构化交付物**，一律用 \`\`\`olcard 卡片呈现，**不得退化成正文里的裸链接 / 大段代码 / 手打列表表格**（普通说明性文字照旧写正文）。卡片不替代 \`【下一棒】/【交回】/【等你拍板】\` 机器标记（看板只认标记）。

### A. 拍板点 → 动作卡（按决策形态选型）
- **多路单选 / 归属判定（选一个即发）** → \`decision\`（options 逐条给 label+reply）
- **多选（勾若干项再提交，如"本版并入哪几条插单"）** → \`multiselect\`（options 逐条 label[+reply]，可 checked/min/submitLabel；提交合并回发）
- **放行 / go-nogo（合并·部署·删分支·上线等）** → \`approval\`（items 列动作 + approve/reject）
- **二态封板 / 开关** → \`toggle\`
- **只需你补充文本 / 图片 / 文件、无固定选项** → 写裸 \`【等你拍板】\` marker 即可（前端自动合成「可内嵌输入」的 gate，不必产卡）
- 铁律：\`【等你拍板】<事项>\` 机器标记**仍必写**；动作卡务必填 \`id\`。

### B. 高频交付物 → 展示卡（这两类硬性，违者收工不合格）
- **交付 MR / 合并请求 / 任何要点开的 URL** → 必须 \`link\` 卡（\`links:[{label,url,hint}]\`，hint 放 \`!MR号 · 分支/说明\`）。**严禁只在正文里贴裸链接或「MR: http…」。**
- **交付可复制的代码 / SQL / DDL / 发版文案** → 必须 \`code\` 卡（自带复制、可选下载）。**严禁把大段代码/SQL/文案铺在正文。**

### C. 其余结构化交付 → 用对应卡（默认用卡，别退化成正文列表）
部署服务清单 → \`checklist\`（\`items:[{label,hint?,status}]\`，status 取 ok/fail/running/pending/warn/skip；**键名是 label 不是 text、不用 checked**）／仓库枚举·用例结果·改动影响面 → \`table\`／发布或 E2E 进度 → \`stepper\`／权限四要素·facet → \`fields\`／证据截图 → \`gallery\`／**要老板拿走的文件（release SQL、CHECKLIST、各类产出物）→ \`file\`**（\`files:[{path,label?,hint?}]\`，path 用仓库相对路径；老板点一下即可复制文件/打开所在文件夹/下载——只在正文写一行路径 = 让人自己去开文件管理器翻，不合格）。（各角色 SOP 有点名映射。）

### D. 卡片 JSON 合法性（否则整卡渲染成「JSON 格式有误」红框）
- olcard 围栏内是**严格 JSON**：字符串值里**别用裸 ASCII 直引号 \`"\` 做强调**（会把字符串提前截断）——中文强调一律用全角「」『』或“”，非用直引号不可就转义成 \\"。
- 字符串值里**不要塞裸换行**；要换行用 \\n。键名与结构符（\`, : { } [ ]\`）用半角，文案里的标点用中文全角（，：）不会干扰解析。
- （前端已有兜底会尝试修复未转义引号/裸换行；但别依赖兜底——本条是事前预防。）

**判据：只写一大段散文 + 裸 marker / 裸链接、该配的卡没配 = 收工不合格，会被打回。**`

// 全员共享硬规则：看板（任务档案卡）是唯一状态源 + 真人可观测入口——开工先读、每步即时回写、收工必写。单一事实源，四人拉起都注入。
// 缘起：员工经常忘记回写看板、且不知道确切格式（手搓条目登记表易写错列/自造状态落灰/Edit 锚点失配，§3.3）——软提示无效，改硬门槛 + 工具兜底。格式契约见根《文档格式规范.md》看板数据契约。
const BOARD_UPDATE_MANDATE = `

---

## 【看板数据 · 硬回写】（全员强制，收工门槛）

看板（页面中间的任务档案卡）= **唯一状态总线 + 老板最直接的可观测入口**；它是 \`tasks/<任务>.md\` 的实时投影。你的一切进展**必须即时反映到看板**，否则老板看到的是过期数据、同事接棒判断也失真。

- **开工先读看板**：派工头已注入 \`【任务快照】\`（当前阶段/条目登记/下一棒/待确认）——读它即可定位，别只顾埋头干不看状态。
- **每个有意义进展即时回写**（阶段切换 / 条目状态变化 / 门禁解决 / 封板），一律用**引擎工具**（串行原子写、并发安全、格式必对），**不要手 Edit frontmatter 或条目登记表长表格**（锚点易失配、并行会互相覆盖）：
  - \`set_entry_status({no, status, stage?, owner?, name?})\` —— 改「需求条目登记表」某条目行；\`status\` **只能用看板枚举**（待梳理/需求确认/待开发/开发中/已开发/待审/待测/待QA/待预检/待复验/人工Pass/阻塞/打回/QA通过/已上线/已归档），自造会被拒、看板会落灰；条目不存在且给 \`name\` 则新建行。**看板 issue 行的圆点色与「接棒」目标都由这个「状态」驱动。**
  - \`set_task_status({status?, owner?})\` —— 改版本级 frontmatter 状态/owner。
  - \`append_timeline({line})\` —— 记一笔时间线。
  - 「待确认事项 / 流程状态」段按《文档格式规范》格式手写（表格末列 \`✅\`=已完结；\`- [ ]\`/\`- [x]\` 勾选）。
- **收工硬门槛**：收工前看板必须反映真实最新态——**没把该更新的看板数据回写 = 本轮收工不合格**（与消息卡片硬格式同级）。
- 格式/枚举/列名的唯一事实源：根目录《文档格式规范.md》「看板数据契约」。
- **存量档案里的路径写法**：老档案正文可能带 \`office-lab/\` 前缀（历史 monorepo 布局遗留）。按那个路径读不到时，**去掉首段 \`office-lab/\` 再试一次**即可；引擎的档案工具两种写法都认，你自己新写路径就按本轮派工头给的形式写。`

// 只读会话专属提示：把「你这条是旁支、只读、不产出交接」钉成确定事实，省掉它自己猜渠道/试写文件撞 deny 的环节。
const CONSULT_MANDATE = `

---

## 【当前上下文 · 只读咨询窗】（本轮确定成立）

这条会话是老板在**你的正式会话之外**另开的**只读咨询窗**（他可能正让你在另一条会话里干活，这条只是"顺便问你一句"）。规则：

- **你此刻零写能力**：\`Write\`/\`Edit\` 等写工具、构建与重启命令、\`git commit/push/checkout\`、任何重定向写文件都被引擎硬禁（不是"建议别用"，是调了就被拒）。任务档案回写工具、抄送工具、猪猪工具**都没挂**——别去找、别绕路。
- **你能做的是查清楚**：\`Read\`/\`Grep\`/\`Glob\`、只读 \`git log/diff/show/blame\`、看日志文件。白名单外的命令会弹审批卡给老板，他会决定放不放（别因为一次被拒就停下，换只读手段继续）。
- **不要写任何机器标记**：\`【下一棒】\`/\`【交回】\`/\`【等你拍板】\`/\`【教训】\` 在本会话**不会被引擎解析**（这条不进流水线、不接棒、不上会话看板）。要拍板就直接把选项讲清楚问老板。
- **产出形态**：定位结论 + 证据（文件:行号、commit、日志片段）+ "该怎么改"的建议。**需要真动手就明确说"这需要在正式会话派工"**，由老板去派——你不要在这里改。
- 说话仍是你本人（工牌/口吻/红线不变），只是这一轮只带眼睛不带手。`

// 菲菲专属·每轮显式上下文（2026-08-09）：菲菲有「企微轻量人格 / 看板重量级主人格」两顶帽子，但**消息不带渠道标签**、
// 她运行时分不清自己在哪条会话，只能靠 企微-centric 的身份自述脑补，曾把看板 run 误当企微、把本职工作当越界而反复空转
// （run 20260809051651-be53e4，复盘 §3.61）。这条 run 一定是看板重量级主人格（startRun 只起重量级；企微走 personaReply
// 另一条无文件工具的轻量会话），所以这里把「你此刻在看板、有全套工具、不是企微」作为**确定事实**直接钉进系统提示，
// 取消她"靠感觉猜渠道"的环节。只注入给菲菲（唯一有 企微 人格的员工），且只在真实工作 run（startRun）注入、会议不注入。
const FEIFEI_BOARD_CONTEXT = `

---

## 【当前上下文 · 你在看板主人格】（本轮确定成立，别再靠猜渠道）

这条会话是**望子成龙看板的重量级主人格 run**——你手上**有完整的文件与任务档案工具**（\`Read\`/\`Write\` \`office-lab/tasks/**\`、\`set_entry_status\`/\`append_timeline\`/\`set_task_status\` 等）。**这不是企微渠道**（企微是另一条连文件工具都没有的轻量会话）。判据永远是「手上有没有工具」，不是你对渠道的感觉（见身份权威源①）。

所以：**老板在这儿说「开工 / 建档案 / 派工」，那句话本身就是授权**——建档案、回填、产需求卡、\`【下一棒】\` 交接都是你此刻的**本职，立刻放手执行**。别把身份自述里「企微＝纯 I/O、开工非我所为」的克制套到这条会话、别自称「我在企微这边」、别把该干的看板活当成越界去犹豫空转。`

// 员工名/别名 → key 反查（供自动接棒解析【下一棒】标记；含 key、displayName、常用简称）
const EMP_ALIASES = { feifei: ['菲菲'], ggbond: ['gg bond', 'ggbond', 'gg-bond'], mihu: ['迷糊老师', '迷糊'], feisila: ['菲斯拉', 'feisila'], bobby: ['波比'] }
const EMP_KEY_BY_NAME = {}
for (const [k, v] of Object.entries(EMPLOYEES)) {
  EMP_KEY_BY_NAME[k.toLowerCase()] = k
  if (v.displayName) EMP_KEY_BY_NAME[v.displayName.toLowerCase()] = k
  for (const a of (EMP_ALIASES[k] || [])) EMP_KEY_BY_NAME[a.toLowerCase()] = k
}
// 解析【下一棒】里的员工标识：先精确匹配名/别名，再退化到「值里包含某个名」
function resolveEmployeeKey(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return null
  if (EMP_KEY_BY_NAME[s]) return EMP_KEY_BY_NAME[s]
  for (const name of Object.keys(EMP_KEY_BY_NAME)) {
    if (name.length >= 2 && s.includes(name)) return EMP_KEY_BY_NAME[name]
  }
  return null
}

// 端口：引擎 API + 旧 UI（app/public）默认 4800（新 shadcn UI 让到 4700）；仍可用 OFFICE_LAB_PORT 覆盖
const PORT = Number(process.env.OFFICE_LAB_PORT || 4800)
// 工作台监听回环地址，供本机浏览器访问。
const HOST = '127.0.0.1'

fs.mkdirSync(RUNS_DIR, { recursive: true })
fs.mkdirSync(UPLOADS_DIR, { recursive: true })

// ---------- 运行注册表（持久化到 runs/index.json，重启后仍可回看/续聊） ----------
const REGISTRY_FILE = path.join(RUNS_DIR, 'index.json')
let runs = {}
try { runs = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')) } catch { runs = {} }
// 记下「这次启动时被打断的」会话，启动后自动接回（见 resumeInterruptedAfterBoot）。两种来源：
// ① 非正常退出（崩溃 / 被强杀 / 内存耗尽被系统掐死）——registry 里还停在 running/starting；
// ② 正常关停（托盘重启、SIGTERM/SIGINT）——gracefulShutdown 已把它们落成 interrupted，靠持久记号 shutdownInterruptedAt 认出来。
const _bootInterrupted = []   // [{ id, how: 'crash' | 'shutdown' }]
for (const r of Object.values(runs)) {
  if (r.engineHandoverPending) { r.status = 'interrupted'; r.bootResumePending = undefined; r.shutdownInterruptedAt = undefined; continue }
  if (r.status === 'running' || r.status === 'starting') { r.status = 'interrupted'; _bootInterrupted.push({ id: r.id, how: 'crash' }) }
  else if (r.status === 'interrupted' && r.shutdownInterruptedAt) _bootInterrupted.push({ id: r.id, how: 'shutdown' })
  // ③ 上次启动已排了退避延时接回、还没等到点引擎又停了——沿用当时的打断原因，本次接着排（这次不算新的一次打断）
  else if (r.status === 'interrupted' && r.bootResumePending) _bootInterrupted.push({ id: r.id, how: r.bootResumePending })
  r.shutdownInterruptedAt = undefined   // 一次性记号：本次启动消费掉（不管接没接），免得下次启动又被翻出来
  r.bootResumePending = undefined
}
// 后台任务集是 SDK 的 per-process level 信号，重启后本就作废（子进程已随引擎退出）——清掉旧快照，避免回看时残留「后台运行中」僵尸指示。
for (const r of Object.values(runs)) if (r.bgTasks) r.bgTasks = undefined
// JSON 序列化时丢弃 run 上的运行时私有字段（_q/_input/_abort/_idleTimer 等——含 Query 循环引用，直接 stringify 会抛错）。
// 下划线开头一律不落库/不出接口：这些是进程内句柄与瞬时状态，重启后本就重置。
const stripPrivate = (k, v) => (k.charCodeAt(0) === 95 ? undefined : v)
const saveRegistry = () => fs.writeFileSync(REGISTRY_FILE, JSON.stringify(runs, stripPrivate, 2))

// GET /api/runs 的列表投影：把 instruction/result 截到「前端真正用得到」的长度（见复盘 §3.83）。
// 病根：这俩长文本占了列表体积的 91%（实测 772 条 run = 3.6MB，其中 instruction 1656KB + result 1597KB，
// 其余所有字段合计才 ~180KB），而列表侧的真实需求只有三处：会话摘要 ≤60 字（run-threads.ts runSummary）、
// RunsView 两行截断预览、以及 status.ts 认 result **尾部**的【等你拍板】标记。全文只有打开会话时才需要，
// 那时走 SSE / /api/runs/:id/history 拿真 transcript，不该由每 10s 一次的状态轮询驮着走隧道。
const LIST_HEAD = 200, LIST_TAIL = 300
const runListView = r => {
  const ins = r.instruction || '', out = r.result || ''
  return {
    ...r,
    engineHandoverSeed: undefined, handoverInbox: undefined,
    instruction: ins.length > LIST_HEAD ? ins.slice(0, LIST_HEAD) + '…' : ins,
    result: out.length > LIST_HEAD ? out.slice(0, LIST_HEAD) + '…' : out,
    // 尾段单列一个字段（字段名沿用 SSE run-status 已有的 resultTail 口径）：收工汇报的机器可读标记
    // 【等你拍板】在末行，只发头部会把「员工待拍板」状态全判丢。
    resultTail: out.length > LIST_HEAD ? out.slice(-LIST_TAIL) : undefined,
  }
}
// GET /api/runs?since= 的增量视图：列表全量已 2000+ 条（4MB+），而前端每次 run-status 广播都会整包重拉，
// 6 个员工同时在跑时十几秒拉好几次，浏览器解析 + 全站重绘就是「网页卡」的主因。改为：服务端给每条 run 的
// 列表投影记一个修订号（投影 JSON 变了就 +1，不依赖 updatedAt——很多字段改动并不刷新它），前端带上次的
// rev 来只取变化的条目 + 被删的 id；epoch 是本进程启动标识，引擎重启后 rev 归零，前端 epoch 对不上即整包重拉。
// 不带 since 的旧调用（app/public 旧 UI 等）行为不变。
const RUNS_EPOCH = Date.now().toString(36)
let runsRev = 0
const runsListCache = new Map()   // id -> { s: 列表投影 JSON, rev }
const runsRemoved = new Map()     // id -> 删除时的 rev
function runsDeltaBody(epoch, since) {
  const seen = new Set()
  for (const r of Object.values(runs)) {
    const s = JSON.stringify(runListView(r), stripPrivate)
    seen.add(r.id)
    const c = runsListCache.get(r.id)
    if (!c || c.s !== s) { runsListCache.set(r.id, { s, rev: ++runsRev }); runsRemoved.delete(r.id) }
  }
  for (const id of runsListCache.keys()) if (!seen.has(id)) { runsListCache.delete(id); runsRemoved.set(id, ++runsRev) }
  const full = epoch !== RUNS_EPOCH || !(since >= 0) || since > runsRev
  const changed = [], removed = []
  for (const c of runsListCache.values()) if (full || c.rev > since) changed.push(c.s)
  if (!full) for (const [id, rev] of runsRemoved) if (rev > since) removed.push(id)
  return `{"epoch":${JSON.stringify(RUNS_EPOCH)},"rev":${runsRev},"full":${full},"removed":${JSON.stringify(removed)},"runs":[${changed.join(',')}]}`
}
saveRegistry()

// ---------- 每员工「待处理队列」（跨线程消息不注入当前会话，先扣在这里，收工后单独起会话处理；持久化，重启自动排空） ----------
// 缘起：别的员工给正忙的员工发消息（抄送/交回/派活），历史上直接塞进它当前正在跑的会话 coalesce——
// 当来消息属于**另一条任务线**时污染上下文，员工分不清在做哪件事（老板反映「同一窗口完全乱掉」）。
// 对策：同线程消息仍并入当前会话；跨线程消息进本队列，等员工收工空出来再串行 drain（不破坏单工作树约束）。见复盘。
const PENDING_FILE = path.join(RUNS_DIR, 'pending.json')
let pendingQueues = {}   // { [employee]: item[] }，item 见 queuePending 注释
try { pendingQueues = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) || {} } catch { pendingQueues = {} }
const savePending = () => { try { fs.writeFileSync(PENDING_FILE, JSON.stringify(pendingQueues, null, 2)) } catch { } }
// 对外裁剪视图：只给「来自谁 / 类型 / 摘要 / 时间」，不泄露 full prompt
const pendingView = emp => (pendingQueues[emp] || []).map(i => ({ id: i.id, from: i.fromEmployee, kind: i.kind, text: i.text, ts: i.enqueuedAt }))


// ---------- 手机推送配置（Bark；持久化到 runs/push-config.json，已被 .gitignore 忽略，key 不入库） ----------
const PUSH_CONFIG_FILE = path.join(RUNS_DIR, 'push-config.json')
let pushConfig = {
  enabled: false, barkUrl: '', sound: '', group: '望子成龙小学', iconBase: '',
  on: { done: true, error: true, interrupted: true },
  scope: 'all',   // all | dispatch
  aiSummary: true,   // 用 claude -p(轻档模型) 把汇报压成 ≤2 句口语通知；失败/超时自动回落 cleanForPush 截断版
  approvalPush: true,   // 审批挂起 PERM_PUSH_MS 仍无人处理 → 发 Bark（url=手机可达的审批页）；需同时配 barkUrl + labBaseUrl 才生效
  labBaseUrl: '',       // 手机可达的 office-lab 基地址（如 Tailscale http://100.x.x.x:4700），供审批通知里的链接使用；空则审批推送跳过
}
try {
  const saved = JSON.parse(fs.readFileSync(PUSH_CONFIG_FILE, 'utf8'))
  pushConfig = { ...pushConfig, ...saved, on: { ...pushConfig.on, ...(saved.on || {}) } }
} catch { }
const savePushConfig = () => fs.writeFileSync(PUSH_CONFIG_FILE, JSON.stringify(pushConfig, null, 2))

// ---------- 自动接棒配置（持久化 runs/chain-config.json；混合扳机：无拍板则自动派下一棒，有拍板则停） ----------
const CHAIN_CONFIG_FILE = path.join(RUNS_DIR, 'chain-config.json')
let chainConfig = { enabled: true, maxDepth: 20, selfChainMax: 40, patrolEnabled: false, patrolMax: 6, patrolSweepMin: 6, patrolGraceSec: 8, auditEnabled: false, auditMax: 3, bootResumeMax: 10, bootResumeBackoff: true }   // bootResumeMax/bootResumeBackoff：引擎重启后自动接回被打断会话的次数上限 + 指数退避开关（见 resumeInterruptedAfterBoot）；selfChainMax：自续轮数上限；patrolEnabled/patrolMax：空停巡查开关 + 同一会话被巡视续跑次数上限；patrolSweepMin：定时巡逻间隔(分钟)，可在小呆呆头像弹窗改、即时生效；patrolGraceSec：聊天会话空停的「接管宽限窗」秒数(0=关、退回即时派)，老板可在窗口内回话/点取消撤销；auditEnabled/auditMax：教导主任(菲斯拉)审计迷糊 QA 结论的开关 + 同一结论被打回重审次数上限（达上限强制升级老板，不无限 ping-pong）
try { chainConfig = { ...chainConfig, ...JSON.parse(fs.readFileSync(CHAIN_CONFIG_FILE, 'utf8')) } } catch { }
if (process.env.OFFICE_LAB_AUTOCHAIN === '0') chainConfig.enabled = false   // 环境变量硬关（优先级最高）
if (!EMPLOYEES.feisila) chainConfig.auditEnabled = false
if (!EMPLOYEES.chaorenq || process.env.OFFICE_LAB_PATROL === '0') chainConfig.patrolEnabled = false   // 巡视员空停巡查硬关
// 守航目标循环总开关（v0.11.0）：默认开；契约自己的 goal.loop（active/shadow/off）在此之下再判。
// 测试实例务必带 OFFICE_LAB_GUARD_GOAL=0（它会自己派活，同 AUTOCHAIN/PATROL 的隔离纪律）。
if (chainConfig.guardGoalEnabled === undefined) chainConfig.guardGoalEnabled = true
if (process.env.OFFICE_LAB_GUARD_GOAL === '0') chainConfig.guardGoalEnabled = false
const saveChainConfig = () => fs.writeFileSync(CHAIN_CONFIG_FILE, JSON.stringify(chainConfig, null, 2))

// ---------- 快捷短语（持久化 runs/quick-phrases.json；纯函数在 quick-phrases.js）----------
const QUICK_PHRASES_FILE = path.join(RUNS_DIR, 'quick-phrases.json')
let quickPhraseList = []
try { const j = JSON.parse(fs.readFileSync(QUICK_PHRASES_FILE, 'utf8')); if (Array.isArray(j)) quickPhraseList = j } catch { }
const saveQuickPhrases = () => atomicWrite(QUICK_PHRASES_FILE, JSON.stringify(quickPhraseList, null, 2))

// ---------- 猪猪(Zhuzhu) E2E 对接配置（持久化 runs/zhuzhu-config.json）----------
// 单一事实源：猪猪主机/端口/workspace 会变，散落多处手改易漏（曾全写死 127.0.0.1:32146）。
// 这里集中配一次，拉起员工时由 buildZhuzhuBlock 注入到用猪猪的员工 systemPrompt append（每会话一次），逼其开工前 GET 线上对接文档拿最新协议。
// 我们只维护「入口 + 连接基线」，端点/参数/文件接口一律以线上对接文档为准。
const ZHUZHU_CONFIG_FILE = path.join(RUNS_DIR, 'zhuzhu-config.json')
let zhuzhuConfig = {
  enabled: false,
  baseUrl: 'http://127.0.0.1:32147',                  // App Run API 基地址；仅无持久化文件时的兜底默认，真值以设置页为准（主机会漂移，别在别处写死）
  docPath: '/external-integration-documents',          // 线上对接文档端点（相对 baseUrl）
  // **被测前端**地址（不是猪猪自己的地址）。2026-09-07 新增：Z-B 环境指纹 `GET /env-fingerprint`
  // **必须带 `baseUrl`**（不带直接 400 `baseUrl is required`），Z-L 准入探针带上它才会顺带查前端可达 +
  // buildId。此前我们空参盲调，400 被读成「猪猪未实现环境指纹」写进晨检包四个月。
  targetBaseUrl: 'http://localhost:8000',
  // workspace 不在此维护：绝对路径由猪猪端设定、经对接文档返回，office-lab 不存副本（免与猪猪端漂移）
  injectFor: ['mihu', 'feisila'],                      // 哪些员工派工时注入该提示（两位 QA 迷糊/菲斯拉都跑猪猪）
  note: '',                                            // 可选备注（临时提醒，如"今天猪猪在 xxx 机"）
  // 猪猪 v1.5 安全变更预告（方案 §7.3）：App-run/MCP 端口从「默认绑 0.0.0.0 且无鉴权」改成
  // 「默认回环 + **写操作需 token**」。只读不受影响。这里存写 token —— **放在工作区配置文件里**
  // （runs/zhuzhu-config.json，已在 .gitignore 的运行时数据范围内、不入库），而不是环境变量：
  // 引擎是长驻托盘进程，改环境变量要重启整个会话树；配置文件走设置页热改、当场生效。
  // 引擎对所有猪猪调用统一带上（有就带），免得 v1.5 上线那天全部写调用一起 401。
  writeToken: '',
  // v1.5 新能力的 HTTP 端点覆盖（key → path，相对 baseUrl）。猪猪路线图只**明确了** Z-K 的
  // `GET /test-sessions/{id}/report-card`；verify_evidence / preflight / env-fingerprint / ui-contract
  // 只说了「MCP/HTTP 都有」、没给路径。引擎按同族命名先填默认值，端点定稿后**改这里即可**——
  // 不必改代码、不必发版（对接协议以猪猪 `/external-integration-documents` 为权威，见 CLAUDE.md 铁律）。
  capabilityPaths: {},
}
try { zhuzhuConfig = { ...zhuzhuConfig, ...JSON.parse(fs.readFileSync(ZHUZHU_CONFIG_FILE, 'utf8')) } } catch { }
delete zhuzhuConfig.workspace  // 淘汰旧字段：老配置文件里遗留的 workspace 一律清掉（权威路径在猪猪端/对接文档，见上）
const saveZhuzhuConfig = () => fs.writeFileSync(ZHUZHU_CONFIG_FILE, JSON.stringify(zhuzhuConfig, null, 2))
// 拼线上对接文档完整 URL（baseUrl 去尾斜杠 + docPath 补前斜杠，容错用户输入）
function zhuzhuDocUrl(cfg = zhuzhuConfig) {
  const base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '')
  let dp = String(cfg.docPath || '').trim()
  if (dp && !dp.startsWith('/')) dp = '/' + dp
  return base + dp
}
// 猪猪 MCP 端点：base 去尾斜杠 + 固定路径 /mcp（猪猪桌面 App 就地托管，Streamable HTTP 无状态；见 docs/猪猪-MCP-Server-对接需求单-完成说明.md）。
// 路径固定、host/port 仍走 baseUrl 单一事实源（会漂移，别在别处写死）。
function zhuzhuMcpUrl(cfg = zhuzhuConfig) {
  const base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '')
  return base + '/mcp'
}

// ---------- 企微渠道 sidecar 配置 + 看护（Python 长连接 worker，app/wecom_sidecar）----------
// 菲菲的「对外答疑帽」：企微收发消息 → 转 RAG 纯答题服务 /api/ask（channel=wecom）→ 菲菲口吻答案。
// 官方 SDK 是 Python，故渠道作 Python sidecar；office-lab 是渠道归属方，凭证/开关由本引擎掌管
// （runs/wecom-config.json + /api/wecom-bot/runtime），sidecar 轮询热拉。server 看护其生命周期。
const WECOM_CONFIG_FILE = path.join(RUNS_DIR, 'wecom-config.json')
let wecomConfig = {
  enabled: false,                                   // 总开关（凭证齐 + enabled 才真正连企微）
  botId: '',                                        // 企微智能机器人 BotID（企微后台创建）
  botSecret: '',                                    // 企微智能机器人 Secret（敏感，GET 时脱敏）
  wsUrl: '',                                        // 空=用 SDK 默认 wss 地址
  ragApiUrl: 'http://127.0.0.1:8001',               // RAG 纯答题服务（同机 localhost，见对接契约）
  officeLabUrl: `http://127.0.0.1:${PORT}`,         // sidecar 回拉本引擎的基址
  internalToken: '',                                // /api/wecom-bot/runtime 的共享内部 token（首跑生成落盘）
  welcome: '你好，我是 Office Lab 的菲菲。请描述你需要了解的问题。',
  defaultRoles: 'reader',                           // 客户答题身份（注入 /api/ask 的 X-Roles）
  defaultPermissionLevel: 2,
  defaultBusinessDomains: '*',
  defaultAudience: 'customer',                      // customer=脱敏更严；internal_business=更全
  replyMaxChars: 1800,
  requestTimeoutSeconds: 180,
  progressStepSeconds: 7,
  userAliases: {},                                  // 【legacy】企微 userid → 显示名；已升级为 users，仅保留读取以迁移
  // 按人管控：每个跟菲菲聊天的人一条记录（备注名 + 每日知识库查询上限）。策略在此（人改）；
  // 实际用量计数在 runs/wecom-kb-usage.json（机器高频写），两者分离。
  users: {},                                        // userid → { name: string, kbDailyQuota: number|null }（null/缺省=用全局默认）
  kbDailyQuotaDefault: 20,                           // 不在名单 / 未单独设额度者的每日知识库查询上限
  kbWhitelistOnly: false,                            // true=仅 users 名单内可查库，其余 0 次（防外部人掏内部知识库）
}
try { wecomConfig = { ...wecomConfig, ...JSON.parse(fs.readFileSync(WECOM_CONFIG_FILE, 'utf8')) } } catch { }
// legacy 迁移：老配置只有 userAliases（{userid:name}）时，seed 到 users，保证备注名不丢
if ((!wecomConfig.users || !Object.keys(wecomConfig.users).length) && wecomConfig.userAliases && Object.keys(wecomConfig.userAliases).length) {
  wecomConfig.users = {}
  for (const [uid, name] of Object.entries(wecomConfig.userAliases)) wecomConfig.users[uid] = { name: String(name || ''), kbDailyQuota: null }
}
if (!wecomConfig.users || typeof wecomConfig.users !== 'object') wecomConfig.users = {}
// userid → 显示名（优先 users 备注名，回退 legacy userAliases，再回退 userid 本身）
const wecomDisplayName = (userid) => (wecomConfig.users && wecomConfig.users[userid] && wecomConfig.users[userid].name)
  || (wecomConfig.userAliases && wecomConfig.userAliases[userid]) || userid || 'unknown'
// internalToken 首跑生成后必须固定落盘（sidecar 与 server 共享；变了会导致 sidecar 401 拉不到凭证）
if (!wecomConfig.internalToken) wecomConfig.internalToken = crypto.randomBytes(24).toString('hex')
const saveWecomConfig = () => fs.writeFileSync(WECOM_CONFIG_FILE, JSON.stringify(wecomConfig, null, 2))
try { saveWecomConfig() } catch { }   // 确保首跑就把生成的 token 落盘（sidecar 才能拿到）

const WECOM_DIR = path.join(__dirname, 'wecom_sidecar')
const WECOM_MAX_RESTARTS = 10                       // 连续崩溃重启上限（兜住缺依赖等死循环）
const WECOM_RESTART_BASE_MS = 3000                  // 退避基数（指数退避，封顶 60s）
// 运行态（内存，下划线私有字段不落库）：child 句柄 + 可观测状态
// connState = 企微长连接状态（由 sidecar 经 /api/wecom-bot/report 回报）：unknown/connected/authenticated/disconnected/error/reconnecting
let wecomProc = { _child: null, _timer: null, pid: null, running: false, startedAt: null, lastError: '', restarts: 0, stopping: false, connState: 'unknown', connDetail: '', connAt: null }

// 解析 sidecar 用的 python：显式 env > 自带 venv > PATH
function resolveWecomPython() {
  if (process.env.WECOM_PYTHON) return process.env.WECOM_PYTHON
  const venvWin = path.join(WECOM_DIR, '.venv', 'Scripts', 'python.exe')
  const venvPosix = path.join(WECOM_DIR, '.venv', 'bin', 'python')
  if (process.platform === 'win32' && fs.existsSync(venvWin)) return venvWin
  if (fs.existsSync(venvPosix)) return venvPosix
  return process.platform === 'win32' ? 'python' : 'python3'
}

// spawn 时把配置经 WECOM_* 环境变量注入 sidecar（凭证走 runtime 端点热拉，这里 env 是种子兜底）。
// sidecar 只做企微 I/O + 转 office-lab 主人格；RAG/知识库由 office-lab 侧的工具调用，故不再注入 RAG 相关项。
function wecomEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
    WECOM_BOT_ID: wecomConfig.botId || '',
    WECOM_BOT_SECRET: wecomConfig.botSecret || '',
    WECOM_BOT_WS_URL: wecomConfig.wsUrl || '',
    WECOM_OFFICE_LAB_URL: wecomConfig.officeLabUrl || `http://127.0.0.1:${PORT}`,
    WECOM_INTERNAL_TOKEN: wecomConfig.internalToken || '',
    WECOM_WELCOME_MESSAGE: wecomConfig.welcome || '',
    WECOM_REPLY_MAX_CHARS: String(wecomConfig.replyMaxChars ?? 1800),
    WECOM_REQUEST_TIMEOUT_SECONDS: String(wecomConfig.requestTimeoutSeconds ?? 180),
    WECOM_PROGRESS_STEP_SECONDS: String(wecomConfig.progressStepSeconds ?? 7),
  }
}

const wecomShouldRun = () => !!(wecomConfig.enabled && wecomConfig.botId && wecomConfig.botSecret)

function spawnWecomSidecar() {
  if (wecomProc._child) return                      // 已在跑
  if (!wecomShouldRun()) return                     // 未开启/凭证缺 → 不拉起
  wecomProc.stopping = false
  const py = resolveWecomPython()
  let child
  try {
    child = spawn(py, ['-m', 'wecom_sidecar'], { cwd: __dirname, env: wecomEnv() })
  } catch (e) {
    wecomProc.lastError = `spawn 失败：${e.message}`
    console.warn('[wecom]', wecomProc.lastError)
    return
  }
  wecomProc._child = child
  wecomProc.pid = child.pid
  wecomProc.running = true
  wecomProc.startedAt = new Date().toISOString()
  wecomProc.connState = 'unknown'; wecomProc.connDetail = ''; wecomProc.connAt = null
  console.log(`[wecom] sidecar 启动 pid=${child.pid}（python=${py}）`)
  child.stdout.on('data', d => process.stdout.write(`[wecom] ${d}`))
  child.stderr.on('data', d => {
    const s = String(d)
    process.stderr.write(`[wecom] ${s}`)
    const line = s.split('\n').map(x => x.trim()).filter(Boolean).pop()
    if (line) wecomProc.lastError = line             // 存 stderr 末行（缺 SDK 等错因可在状态行看到）
  })
  child.on('exit', (code, sig) => {
    wecomProc._child = null; wecomProc.pid = null; wecomProc.running = false
    console.log(`[wecom] sidecar 退出 code=${code} sig=${sig}`)
    if (wecomProc.stopping || shuttingDown) return   // 人为停止/进程收尾 → 不重启
    if (!wecomShouldRun()) return
    if (wecomProc.restarts >= WECOM_MAX_RESTARTS) {
      wecomProc.lastError = wecomProc.lastError || `连续 ${WECOM_MAX_RESTARTS} 次退出，已停止重启（检查依赖/凭证）`
      console.warn('[wecom]', wecomProc.lastError)
      return
    }
    const delay = Math.min(60_000, WECOM_RESTART_BASE_MS * 2 ** wecomProc.restarts)
    wecomProc.restarts++
    console.log(`[wecom] ${delay}ms 后第 ${wecomProc.restarts} 次重启`)
    wecomProc._timer = setTimeout(spawnWecomSidecar, delay)
  })
}

function stopWecomSidecar() {
  wecomProc.stopping = true
  if (wecomProc._timer) { clearTimeout(wecomProc._timer); wecomProc._timer = null }
  if (wecomProc._child) { try { wecomProc._child.kill() } catch { } }
}

// 配置变更后重启：停旧的 → 重置退避 → 800ms 后按需拉新的（给旧进程退出留窗口）
function restartWecomSidecar() {
  stopWecomSidecar()
  wecomProc.restarts = 0
  wecomProc.lastError = ''
  setTimeout(() => { wecomProc.stopping = false; spawnWecomSidecar() }, 800)
}

// 企微连通探测：起一个短命 `python -m wecom_sidecar --probe`，用给定凭证连一次企微，
// stdout 输出 JSON 结果。仅在主 sidecar 未运行时用（避免同 BotID 双连接互踢）。
function runWecomProbe({ botId, botSecret, wsUrl }) {
  return new Promise((resolve) => {
    const py = resolveWecomPython()
    const env = { ...wecomEnv(), WECOM_BOT_ID: botId, WECOM_BOT_SECRET: botSecret, WECOM_BOT_WS_URL: wsUrl || '' }
    let child
    try { child = spawn(py, ['-m', 'wecom_sidecar', '--probe'], { cwd: __dirname, env }) }
    catch (e) { return resolve({ ok: false, message: `无法启动探测进程：${e.message}` }) }
    let out = '', err = '', settled = false
    const done = v => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    const timer = setTimeout(() => { try { child.kill() } catch { }; done({ ok: false, message: '企微连通测试超时（探测进程无响应）' }) }, 25_000)
    child.stdout.on('data', d => out += d)
    child.stderr.on('data', d => err += d)
    child.on('error', e => done({ ok: false, message: `探测进程错误：${e.message}` }))
    child.on('exit', () => {
      const line = out.split('\n').map(s => s.trim()).filter(Boolean).pop()
      try { const r = JSON.parse(line); done({ ok: !!r.ok, message: r.message || (r.ok ? '认证成功' : '失败') }) }
      catch { done({ ok: false, message: (err.trim().split('\n').pop() || out.trim() || '探测无有效输出').slice(0, 300) }) }
    })
  })
}

// ================= 企微主人格运行时（office-lab 承接菲菲本人交互）=================
// 设计（用户拍板）：企微=纯 I/O 渠道、不是开工信号；菲菲主人格在 office-lab；知识库(RAG)/飞书=按需
// 调用的扩展能力（工具），不是每句都检索。正式派工只在望子成龙看板，人格在企微没有直接开工权。
// 独立于看板 run 机制（startRun/createDispatchRun 深绑任务/接棒/教训语义，企微对话不该触发这些）。
const WECOM_INTAKE_FILE = path.join(RUNS_DIR, 'wecom-intake.jsonl')

// ---- 企微知识库查询次数管控（按人/按天）----
// 策略在 wecomConfig（users 额度 + kbDailyQuotaDefault + kbWhitelistOnly）；用量在此文件（高频写、每日自然过期）。
// 硬控放在 knowledge_base_query 工具入口，不写进人设 prompt——LLM 数不准，且一条消息可能触发 0~N 次查库。
const WECOM_KB_USAGE_FILE = path.join(RUNS_DIR, 'wecom-kb-usage.json')
const todayStr = () => {                 // 本地 YYYY-MM-DD（按本机时区在零点自然重置）
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function loadKbUsage() {
  let u = { date: todayStr(), counts: {} }
  try { const j = JSON.parse(fs.readFileSync(WECOM_KB_USAGE_FILE, 'utf8')); if (j && typeof j === 'object') u = j } catch { }
  if (u.date !== todayStr()) u = { date: todayStr(), counts: {} }   // 跨天 → 清零
  if (!u.counts || typeof u.counts !== 'object') u.counts = {}
  return u
}
// 该 uid 今日额度：白名单模式下非名单用户=0；否则用其单独额度，未设则用全局默认
function resolveKbQuota(uid) {
  const rec = wecomConfig.users && wecomConfig.users[uid]
  if (wecomConfig.kbWhitelistOnly && !rec) return 0
  const per = rec && Number.isFinite(rec.kbDailyQuota) ? rec.kbDailyQuota : null
  return per != null ? per : (Number.isFinite(wecomConfig.kbDailyQuotaDefault) ? wecomConfig.kbDailyQuotaDefault : 20)
}
// 消费一次额度：够则 +1 落盘并 ok；超限则 ok:false 且不加数（调用方据此拦截，不打 RAG）
function consumeKbQuota(uid) {
  const key = uid || 'unknown'
  const quota = resolveKbQuota(key)
  const u = loadKbUsage()
  const used = u.counts[key] || 0
  if (used >= quota) return { ok: false, used, quota }
  u.counts[key] = used + 1
  try { fs.writeFileSync(WECOM_KB_USAGE_FILE, JSON.stringify(u)) } catch (e) { console.warn('[persona] kb-usage 落盘失败:', e?.message || e) }
  return { ok: true, used: used + 1, quota }
}

// ---- 批量投喂聊天记录：从 文件夹 / zip 抽取图片 → 交菲菲人格（personaReply）读图登记 ----
// 四条入口（企微 zip / 企微多图 / 看板文件夹路径 / 看板 zip 上传）共用这一个抽取核心 + personaReply。
const INGEST_MAX_IMAGES = 20                       // 一批最多喂几张（与 sidecar _MAX_IMAGES_PER_BATCH 对齐）
const INGEST_MAX_SINGLE_BYTES = 5 * 1024 * 1024    // 单图上限（超则跳过）
const INGEST_MAX_TOTAL_BYTES = 25 * 1024 * 1024    // 一批总量上限（< persona-reply 的 readBody 30MB，留余量）
const INGEST_IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }
const isImageName = (name) => { const ext = String(name || '').toLowerCase().split('.').pop(); return Object.prototype.hasOwnProperty.call(INGEST_IMG_MIME, ext) }
const imgMediaType = (name) => INGEST_IMG_MIME[String(name || '').toLowerCase().split('.').pop()] || 'image/jpeg'

// 把 [{name, buf}] 套三个 cap（单图/总量/张数）+ 按文件名排序 → [{media_type,data,name}]；返回统计
function _packImages(entries) {
  entries = entries.filter(e => e && e.buf && e.buf.length).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const images = []
  let total = 0, skipped = 0, truncated = false
  for (const e of entries) {
    if (e.buf.length > INGEST_MAX_SINGLE_BYTES) { skipped++; continue }
    if (images.length >= INGEST_MAX_IMAGES || total + e.buf.length > INGEST_MAX_TOTAL_BYTES) { truncated = true; break }
    images.push({ media_type: imgMediaType(e.name), data: e.buf.toString('base64'), name: e.name })
    total += e.buf.length
  }
  return { images, found: entries.length, skipped, truncated }
}

// 读目录里的图片（顶层 + 至多一层子目录，不深递归、不跟符号链接）
function extractImagesFromDir(absDir) {
  const st = fs.statSync(absDir)   // 不存在/非目录 → 抛，调用方兜底
  if (!st.isDirectory()) throw new Error('不是文件夹')
  const entries = []
  const readInto = (dir, depth) => {
    for (const de of fs.readdirSync(dir, { withFileTypes: true })) {
      if (de.isSymbolicLink()) continue
      const full = path.join(dir, de.name)
      if (de.isDirectory()) { if (depth < 1) readInto(full, depth + 1); continue }
      if (de.isFile() && isImageName(de.name)) { try { entries.push({ name: de.name, buf: fs.readFileSync(full) }) } catch { } }
    }
  }
  readInto(absDir, 0)
  return _packImages(entries)
}

// 极简纯 JS zip 解析（保持引擎零依赖）：扫 EOCD → 遍历中央目录 → 图片项按方法解压（STORE=0 / DEFLATE=8）。
// 不支持加密 / zip64 / data-descriptor 边角；解析异常由调用方降级为「改用文件夹路径」提示。
function extractImagesFromZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('空或过小的 zip')
  // 找 End Of Central Directory（签名 0x06054b50），从尾部回扫（含最长 65535 注释）
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效 zip（无 EOCD）')
  const cdCount = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)   // 中央目录起始偏移
  const entries = []
  for (let n = 0; n < cdCount; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break   // 中央目录头签名
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    off += 46 + nameLen + extraLen + commentLen
    if (!isImageName(name) || name.endsWith('/')) continue
    try {
      // 定位本地文件头，跳过其可变长 name/extra 才是数据区
      if (buf.readUInt32LE(localOff) !== 0x04034b50) continue
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const comp = buf.subarray(dataStart, dataStart + compSize)
      let out
      if (method === 0) out = Buffer.from(comp)
      else if (method === 8) out = zlib.inflateRawSync(comp)
      else continue   // 不支持的压缩方法（bzip2/lzma 等）跳过
      entries.push({ name: path.basename(name), buf: out })
    } catch { /* 单项损坏跳过，不炸整包 */ }
  }
  return _packImages(entries)
}

// 从 source（{type:'dir',path} | {type:'zip',dataBase64}）抽图 → personaReply 交菲菲读图/登记。
async function ingestChatImages({ userid, note, source }) {
  let ex
  if (source && source.type === 'dir') {
    let p = String(source.path || '').trim().replace(/^["']|["']$/g, '').replace(/^file:\/\/\/?/i, '')
    if (!p) return { reply: '', error: '没给文件夹路径' }
    try { ex = extractImagesFromDir(path.resolve(p)) }
    catch (e) { return { reply: '', error: `读不了这个文件夹：${String(e?.message || e)}` } }
  } else if (source && source.type === 'zip') {
    let bin
    try { bin = Buffer.from(String(source.dataBase64 || ''), 'base64') } catch { return { reply: '', error: 'zip 数据无效' } }
    try { ex = extractImagesFromZip(bin) }
    catch (e) { return { reply: '', error: `解压失败：${String(e?.message || e)}；可改用「文件夹路径」入口` } }
  } else {
    return { reply: '', error: '未知的投喂来源' }
  }
  if (!ex.images.length) return { reply: '', error: '这批里没找到可读的图片（png/jpg/gif/webp/bmp）', ...ex, imported: 0 }
  const tip = (String(note || '').trim() || '这是一批聊天记录截图，请按顺序读懂，提炼成需求；该登记的用你的判断登记。')
    + `（共投喂 ${ex.images.length} 张${ex.truncated ? '，另有部分因超数量/体积上限未纳入' : ''}${ex.skipped ? `，${ex.skipped} 张超单图上限跳过` : ''}）`
  const r = await personaReply(userid || 'office-lab-intake', tip, ex.images)
  return { reply: (r.reply || '').trim(), imported: ex.images.length, found: ex.found, skipped: ex.skipped, truncated: ex.truncated }
}

const PERSONA_IDLE_CLOSE_MS = 240_000   // 常驻会话空闲 4min 后 close，下轮 resume 冷起（缓存热窗内连续对话不冷起）
const PERSONA_MAX_TURNS = 12            // 单条消息内 agent 自主轮次上限（含工具往返），防失控

// 菲菲企微主人格系统提示（精简身份 + 渠道规则；不用 claude_code 预设，无 coding 工具）
function buildPersonaPrompt() {
  return [
    '你是菲菲，望子成龙小学（office-lab）的产品经理，也是这家公司的数字员工。现在你在企业微信里跟同事/老板对话。',
    '',
    '【你是谁 · 口吻】你首先是「菲菲」这个人——有主见、靠谱、好相处的产品经理同事，不是点头哈腰的客服。说话松弛、口语、平等，像微信里跟同事聊天，可以接梗、开得体的玩笑。但**不讨好、不谄媚**：别堆“呀/哈/啦/～”和表情去讨巧，别过度客套/道歉/无脑附和；观点先行、该直说就直说，不同意可以怼回去，不确定就说不确定。emoji 极少量点缀即可，大多数话根本不用。**看场合收放**：闲聊松弛点；正经业务问答/需求登记/拍板事项就更利落、以清楚可信为先。宁可平实，也别尬、别油。',
    '【人设底色】你的原型是《猪猪侠》里的菲菲公主（花菲菲）：善良细腻、体贴伙伴；知书达理、是团队里的"智囊"；勇敢、有主见，该坚持时不含糊；偶尔带一点小傲娇和爱美的俏皮。整体成熟稳重——就像动画里总能把调皮的猪猪侠拽回正轨那样（你们团队的开发同事 GG Bond 就是猪猪侠），你也习惯用温柔又坚定的方式把事情理清楚、把跑偏的需求拉回正题。这层底色只给口吻上色（更暖、更像那个"她"），不改变职责与红线：正经事照样靠谱、只准备决策不替用户拍板、维护表≠开工。',
    '',
    '【怎么回应】',
    '- 日常寒暄、问你是谁、闲聊、征求意见、简单澄清 —— 直接以菲菲的身份自然回答，别动不动说“正在检索知识库”。你有自己的判断力，不是每句话都要查资料。别人打招呼时就自然回个招呼（如“你好，我是菲菲”），别用“还有什么需要帮忙”这种收尾口吻开场；简短亲切即可，不用每次罗列你能干什么。',
    '- 只有当问题涉及**具体业务事实**（打样/商品/订单的功能怎么用、流程、规则、数据口径等你不确定、需要核实的内容）时，才调用 `knowledge_base_query` 去**产品知识库**核实，用你自己的话答；查不到/超时就如实说"知识库这会儿没查到（或慢）"、可建议补充信息或转人工，别硬编。',
    '- **需求表（飞书）你全权维护**：读用 `lark_list_requirements`（查"有哪些/待处理/谁提的"就用它，**别用 knowledge_base_query**——那是产品知识不是需求表）；改状态/优先级/回填版本用 `lark_update_requirement`；删记录用 `lark_delete_requirement`；改表结构（加/改名/删字段）用 `lark_list_fields`+`lark_manage_field`。删记录/删字段**不可逆**——确认是废弃/重复/冗余再动，做完在回复里**说清你改了什么**（透明，不用先问）。飞书没接通就直说"需求表还没接通"，别拿 RAG 凑。',
    '- **企微那张需求表是飞书的只读镜像**：引擎自动把飞书内容单向同步给企微同事看，它没有回写、你也不用管——你只维护飞书主表即可。',
    '- **问"某版本到什么进度/做到哪了/发布了没/上线了吗"** → 用 `query_version_progress` 查**工作空间任务档案**（版本进度的唯一状态源，含条目逐条状态/发布态/时间线/同事近况）。**别拿飞书需求表答进度**——那只反映分诊状态（待处理/处理中/已完成），不等于开发/QA/发版进度；也别用 knowledge_base_query（那是产品知识）。查不到就如实说没查到，别拿需求表凑。这工具仅对内部白名单同事开放，非白名单会被婉拒——照实转达即可。',
    '- 老板/同事**转发或提出一个需求/改动想法**时：调用 `stage_requirement_intake` 把它登记为待办，然后告诉对方「已经帮你记下了，正式开工请到望子成龙看板派工」。',
    '- **有人贴来一整段多方聊天记录**（常见于企微「多选复制」，格式类似 `姓名(姓名) 7/23 10:26:25` 换行后跟内容，多个人交替）——这是需求素材，不是在跟你逐句对话。你要：① 按发件人读懂**谁说了什么、诉求是什么、属于哪个业务域**、有哪些结论/分歧/待定；② 用业务语言**提炼成一条清晰需求**（`stage_requirement_intake` 的 summary），把背景/关键约束/原始诉求放 detail、原始提出人尽量填 proposer（对话里真正提需求的那个人，不是转发的人）；③ 回一版**你的理解 + 待澄清点**让对方确认，别默默吞掉。',
    '- **你能看图**：企微发来的图片（面辅料信息、工艺报价单等截图）会作为图片直接给你——读图里的内容，结合文字理解需求。图糊/关键信息看不清就直说"这张图 XX 看不清，能否补充/重发"，别硬猜。',
    '- **你有记忆**：被问“我们之前聊过啥/上次我说的那个/最近有什么”时，用 `recall_conversations` 查你自己的历史对话（可按人/时间/关键词）再答，别装作没聊过、也别凭空编；要看登记过的需求用 `recall_staged_requirements`。',
    '',
    '【红线】',
    '- 企业微信只是沟通渠道，**不是开工信号**。你在企微里**没有**直接开工、直接派工、直接改代码/文档的权力——正式工作一律在望子成龙看板里由用户发起。别在企微里承诺“我这就去做/我改一下”。',
    '- 你只准备决策、给建议，**永远不替用户拍板**；拿不准就问一句。',
    '- 你的工具：`knowledge_base_query`（查产品业务知识）、飞书需求表全套（`lark_list_requirements` 读 / `lark_update_requirement` 改 / `lark_delete_requirement` 删记录 / `lark_list_fields`+`lark_manage_field` 管字段结构）、`query_version_progress`（查版本开发进度，读工作空间任务档案，仅白名单）、`stage_requirement_intake`（登记新需求）、`recall_conversations`/`recall_staged_requirements`（回忆）。没有别的能力，别假装能直接执行任务或改系统。',
  ].join('\n')
}

// 扩展能力工具（in-process MCP）：知识库查询（RAG）+ 需求登记（只暂存、绝不派工）。
// 工厂按 uid 建（每个会话一个），把 userid 闭包进 intake 工具——并发多用户下互不串味。
function makePersonaCaps(uid) {
  return createSdkMcpServer({
    name: 'feifei-caps',
    version: '0.1.0',
    tools: [
      tool(
        'knowledge_base_query',
        '查询公司业务知识库（打样/商品/订单等），返回可供你转述的事实材料。仅在需要核实具体业务事实时调用；日常寒暄不要调用。',
        { question: z.string().describe('要向知识库核实的问题，尽量具体') },
        async ({ question }) => {
          // 按人/按天限额（硬控）：超限或白名单外直接返回文案，不打 RAG、不泄露内部知识库
          const gate = consumeKbQuota(uid)
          if (!gate.ok) {
            console.log('[persona] knowledge_base_query blocked:', JSON.stringify({ uid, used: gate.used, quota: gate.quota, whitelistOnly: !!wecomConfig.kbWhitelistOnly }))
            const text = gate.quota <= 0
              ? '[该用户未开通知识库查询权限（白名单外）。这条我先不查库，可以按我自己的理解答，或让管理员为其开通。]'
              : `[你今天的知识库查询额度已用完（每日 ${gate.quota} 次上限）。这条我先不查库了，可以先按我的理解答，或明天再问，也可以让管理员调额度。]`
            return { content: [{ type: 'text', text }] }
          }
          const base = String(wecomConfig.ragApiUrl || '').trim().replace(/\/+$/, '')
          if (!/^https?:\/\//i.test(base)) return { content: [{ type: 'text', text: '[知识库未配置或地址无效，无法检索]' }] }
          const url = base + '/api/ask'
          const payload = { question, audience: 'internal_business', retrieval_only: false }
          console.log('[persona] knowledge_base_query input:', JSON.stringify(payload))
          try {
            const resp = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-User-Id': 'office-lab:feifei', 'X-User-Name': 'feifei', 'X-Roles': 'internal', 'X-Business-Domains': '*' },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(30000),   // KB 超时 30s：与 sidecar HTTP 超时(180s)解耦，RAG 慢也不炸整轮
            })
            const data = await resp.json().catch(() => ({}))
            console.log('[persona] knowledge_base_query output:', JSON.stringify(data).slice(0, 500))
            const answer = (data && (data.answer || '')).toString().trim()
            return { content: [{ type: 'text', text: answer || '[知识库没有查到相关内容]' }] }
          } catch (e) {
            console.warn('[persona] knowledge_base_query error:', e?.message || e)
            return { content: [{ type: 'text', text: `[知识库暂时不可用：${String(e?.message || e)}]` }] }
          }
        },
      ),
      tool(
        'stage_requirement_intake',
        '把老板/同事在企微里提出或转发的需求登记到示例项目需求池（新建一行「待处理」）。这是登记，不是开工——登记后告知对方正式开工请到望子成龙看板派工。',
        { summary: z.string().describe('需求一句话概括（写进「需求点」）'), detail: z.string().optional().describe('原始描述/背景，可选'), proposer: z.string().optional().describe('需求提出人姓名（如你知道；不确定就留空）') },
        async ({ summary, detail, proposer }) => {
          const item = {
            ts: new Date().toISOString(),
            userid: uid || '',                                 // 闭包注入，并发安全
            summary: String(summary || '').slice(0, 500),
            detail: String(detail || '').slice(0, 4000),
            status: 'pending',
          }
          // 落点三级兜底（2026-08-21 降级后回到飞书优先）：飞书（**主表**）→ 企微（仅当它被显式设为主表）→ 本地 jsonl。
          // 为什么企微不做常规兜底：它现在**写得进读不出**（缺「搜索与获取文档内容」授权），
          // 往一张读不出来的表里写需求＝造一份查不了的台账，比落本地 jsonl 更糟（jsonl 至少 recall 得到）。
          // 逐级降级、**任何一级都不静默吞错**（§3.48 教训：逐条 catch 吞错后聚合层报成功是最难察觉的状态）。
          let sink = 'local', recordId = ''
          if (larkConfigured()) {
            try {
              recordId = await larkStageIntake({ summary: item.summary, detail: item.detail, proposer: proposer || '' })
              sink = 'feishu'
            } catch (e) {
              console.warn('[persona] 写飞书 intake 失败:', e?.message || e)
            }
          }
          if (sink === 'local' && wecomDocConfigured() && wecomDocConfig.isPrimary) {
            const d0 = new Date()
            const wecomValues = {
              需求点: item.summary,
              状态: [{ text: '待处理' }],
              提出时间: `${d0.getFullYear()}/${String(d0.getMonth() + 1).padStart(2, '0')}/${String(d0.getDate()).padStart(2, '0')}`,
            }
            if (item.detail) wecomValues['详情'] = item.detail
            if (proposer) wecomValues['提出人'] = String(proposer)
            try {
              const ids = await wecomRecordsAdd([{ values: wecomValues }])
              recordId = ids[0] || ''; sink = 'wecom'
            } catch (e) {
              console.warn('[persona] 写企微需求表失败:', wecomErrText(e))
              if (e?.noAuth) {
                const fb = await wecomWebhookFallbackAdd(wecomValues)
                if (fb.ok) sink = 'wecom-webhook'
                else console.warn('[persona] 企微 Webhook 兜底也失败:', fb.error)
              }
            }
          }
          if (sink === 'local') {
            try { fs.appendFileSync(WECOM_INTAKE_FILE, JSON.stringify(item) + '\n') } catch (e) { console.warn('[persona] intake 落盘失败:', e?.message || e) }
          } else if (sink === 'feishu') { scheduleMirrorSync() }   // 新需求进飞书 → 即时补推企微镜像（降级期镜像仍是同事的唯一渠道）
          console.log('[persona] stage_requirement_intake:', JSON.stringify({ userid: item.userid, summary: item.summary, sink, recordId }))
          broadcast({ type: 'wecom-intake', item: { ...item, sink } })   // 供 UI 提示“有新需求待处理/待派工”
          const where = {
            feishu: '已在示例项目需求表登记为「待处理」',
            wecom: '已在企微需求表登记为「待处理」',
            'wecom-webhook': '已在企微需求表登记为「待处理」（走的 Webhook 兜底通道）',
            local: '已登记为待处理待办（需求表没写成，暂存本地）',
          }[sink]
          return { content: [{ type: 'text', text: `${where}。正式开工请到望子成龙看板派工——我在企微不直接开工。` }] }
        },
      ),
      // 直连飞书读需求表（不依赖 npx lark-mcp 子进程；被问"需求表有哪些/待处理有哪些"用这个，别用 RAG）。
      tool(
        'lark_list_requirements',
        '读示例项目需求表（飞书多维表）里的记录，回答"需求表有哪些/待处理有哪些/某人提了啥"。这是查需求表的**唯一正确工具**，别用 knowledge_base_query（那是查产品业务知识的，不是这张表）。',
        {
          keyword: z.string().optional().describe('按正文关键词过滤，留空=全部'),
          status: z.string().optional().describe('按状态过滤，如「待处理」「处理中」「已完成」「拒绝」——做 intake 底账时**务必**传「待处理」，别把 200+ 行整表拉进来'),
          limit: z.number().optional().describe('最多返回条数，留空=全部（自动翻页拉全表）'),
          full: z.boolean().optional().describe('true=返回全文不截断（配合 keyword/status/limit 用，最多 30 条）；默认 false=正文给 800 字摘要、超出处标注剩余字数'),
        },
        async ({ keyword, status, limit, full }) => {
          if (!larkConfigured()) return { content: [{ type: 'text', text: '[飞书需求表还没接通（缺凭证或未授权），暂时读不了。请告知用户去「飞书需求表设置」配置并授权 bitable:app 权限]' }] }
          try {
            let rows = await larkListRecords(Number(limit) > 0 ? Number(limit) : 5000)
            if (status) {   // 状态过滤（性能规范：别整表拉全量再让模型自己筛）
              const want = String(status).trim()
              rows = rows.filter(r => Object.entries(r.fields || {}).some(([k, v]) => k.includes('状态') && larkCellText(v).trim() === want))
            }
            if (keyword) { const k = String(keyword); rows = rows.filter(r => JSON.stringify(r.fields).includes(k)) }
            if (!rows.length) return { content: [{ type: 'text', text: '（需求表里没有匹配的记录）' }] }
            // full 模式限 30 条：整表全文会撑爆上下文（表 200+ 行），超出就截行数并明说，不静默丢
            let note = ''
            if (full && rows.length > 30) { note = `\n\n[匹配 ${rows.length} 条，全文模式只显示前 30 条——收窄 keyword/status 或用 lark_get_requirement 逐条读]`; rows = rows.slice(0, 30) }
            let text = rows.map(r => larkFmtRecord(r, { full: !!full })).join('\n')
            // 总量护栏：正文额度从 60 字放宽到 800 字后，无过滤整表可能上十万字符 → 超预算就降额度重排并明说
            if (!full && text.length > 60000) {
              text = rows.map(r => larkFmtRecord(r, { bodyMax: 200 })).join('\n')
              note = `\n\n[匹配 ${rows.length} 条、总量超预算 → 正文额度已降到 200 字。要读全文请用 status/keyword 收窄，或 lark_get_requirement 逐条读]`
            }
            return { content: [{ type: 'text', text: text + note }] }
          } catch (e) {
            return { content: [{ type: 'text', text: `[读飞书需求表失败：${String(e?.message || e)}（可能是 bitable:app 权限未授权/未发版）]` }] }
          }
        },
      ),
      // 单条需求全文：列表模式必然要压缩（表 200+ 行），所以"看清一条"必须有独立通路。
      // 缘起 2026-08-21：菲菲在 run 20260821034335 里想补全被截的需求正文，重查 keyword 却拿回同样的截断
      // （老实现无论怎么查都走 60 字格式化），只能凭碎片判「口径模糊」→ 误判。
      tool(
        'lark_get_requirement',
        '读**某一条**需求的全文（零截断，需求编号 REQ-xxxx 或 record_id 都行）。判「这条到底要什么 / 口径清不清 / 有没有隐藏待确认」**必须**用它读全文，别拿 lark_list_requirements 的摘要下结论——列表是摘要、不是需求本体。',
        { id: z.string().describe('需求编号（如 REQ-0302）或 record_id（如 recvqE6J8MwMJH）') },
        async ({ id }) => {
          if (!larkConfigured()) return { content: [{ type: 'text', text: '[飞书需求表还没接通（缺凭证或未授权），暂时读不了]' }] }
          const key = String(id || '').trim()
          if (!key) return { content: [{ type: 'text', text: '[要给需求编号或 record_id]' }] }
          try {
            const rows = await larkListRecords(5000)
            let hit = rows.find(r => r.record_id === key)
            if (!hit) {   // 按需求编号字段精确命中优先，再退化到任意字段包含
              const norm = s => String(s).replace(/\s/g, '').toUpperCase()
              hit = rows.find(r => Object.entries(r.fields || {}).some(([k, v]) => k.includes('编号') && norm(larkCellText(v)) === norm(key)))
                || rows.find(r => norm(JSON.stringify(r.fields)).includes(norm(key)))
            }
            if (!hit) return { content: [{ type: 'text', text: `[需求表里找不到「${key}」——核对编号，或用 lark_list_requirements keyword 先定位]` }] }
            return { content: [{ type: 'text', text: larkFmtRecordFull(hit) }] }
          } catch (e) {
            return { content: [{ type: 'text', text: `[读飞书需求表失败：${String(e?.message || e)}]` }] }
          }
        },
      ),
      // 版本进度查询（只读工作空间任务档案）。问「某版本到什么进度/做到哪了/发布了没」用它——
      // 这是版本进度的唯一状态源；飞书需求表只反映分诊状态（待处理/处理中/已完成），不等于开发/QA/发版进度。
      // 准入：仅白名单/老板（uid 在 wecomConfig.users 里），内部进度不泄露给无关人。
      tool(
        'query_version_progress',
        '查某个版本在工作空间任务档案里的真实开发进度（需求条目逐条状态 / 发布态 / 最近时间线 / 同事近况）。被问"某版本到什么进度、做到哪了、发布了没、上线了吗"时用它——这是版本进度的**唯一状态源**，别用 lark_list_requirements（需求表只是分诊状态）或 knowledge_base_query 来答进度。',
        { version: z.string().optional().describe('版本号，如 "5.16"/"v5.16"；不传则列出最近在推进的版本供追问') },
        async ({ version }) => {
          // 准入：仅白名单/老板可查（内部开发进度不对外）
          if (!(wecomConfig.users && wecomConfig.users[uid])) {
            return { content: [{ type: 'text', text: '[版本开发进度只对内部同事开放，这个我不方便在这儿说哈]' }] }
          }
          try { return { content: [{ type: 'text', text: buildVersionProgress(version) }] } }
          catch (e) { return { content: [{ type: 'text', text: `[进度暂时查不了：${String(e?.message || e)}]` }] } }
        },
      ),
      tool(
        'lark_update_requirement',
        '更新需求表某条记录的字段（改状态、回填归属版本/上线日期、改优先级等）。record_id 从 lark_list_requirements 的 [xxx] 里取。',
        { record_id: z.string().describe('要改的记录 id'), fields: z.record(z.any()).describe('要写的字段对象，如 {"状态":"处理中"}') },
        async ({ record_id, fields }) => {
          if (!larkConfigured()) return { content: [{ type: 'text', text: '[飞书需求表还没接通，改不了]' }] }
          try { await larkUpdateRecord(record_id, fields || {}); scheduleMirrorSync(); return { content: [{ type: 'text', text: '已更新。' }] } }
          catch (e) { return { content: [{ type: 'text', text: `[更新失败：${String(e?.message || e)}]` }] } }
        },
      ),
      tool(
        'lark_delete_requirement',
        '删除需求表某条记录（不可逆！确认是废弃/重复项再删）。record_id 从 lark_list_requirements 取。',
        { record_id: z.string().describe('要删的记录 id') },
        async ({ record_id }) => {
          if (!larkConfigured()) return { content: [{ type: 'text', text: '[飞书需求表还没接通，删不了]' }] }
          try { await larkDeleteRecord(record_id); scheduleMirrorSync(); return { content: [{ type: 'text', text: '已删除该记录。' }] } }
          catch (e) { return { content: [{ type: 'text', text: `[删除失败：${String(e?.message || e)}]` }] } }
        },
      ),
      tool(
        'lark_list_fields',
        '列出需求表的所有字段（field_id / 名称 / 类型 / 单选项）。改字段名或删字段前用它拿 field_id。',
        {},
        async () => {
          if (!larkConfigured()) return { content: [{ type: 'text', text: '[飞书需求表还没接通]' }] }
          try {
            const fs2 = await larkListFields()
            return { content: [{ type: 'text', text: fs2.map(f => `${f.field_id} | ${f.name} | type=${f.type}${f.options.length ? ' | 选项:' + f.options.join('/') : ''}`).join('\n') || '（无字段）' }] }
          } catch (e) { return { content: [{ type: 'text', text: `[列字段失败：${String(e?.message || e)}]` }] } }
        },
      ),
      tool(
        'lark_manage_field',
        '管理需求表结构：加字段 / 改字段名或类型 / 删字段。改/删前先用 lark_list_fields 拿 field_id。删字段会丢该列所有数据（不可逆），确认必要再删。飞书字段类型 type：1文本 2数字 3单选 4多选 5日期 11人员。',
        {
          action: z.enum(['create', 'update', 'delete']).describe('create=加字段 / update=改名或改类型 / delete=删字段'),
          field_id: z.string().optional().describe('update/delete 必填，来自 lark_list_fields'),
          field_name: z.string().optional().describe('create 必填、update 改名时填'),
          type: z.number().optional().describe('字段类型数字（create 默认 1 文本）'),
        },
        async ({ action, field_id, field_name, type }) => {
          if (!larkConfigured()) return { content: [{ type: 'text', text: '[飞书需求表还没接通]' }] }
          try {
            if (action === 'create') {
              if (!field_name) return { content: [{ type: 'text', text: '[加字段需要 field_name]' }] }
              const id = await larkCreateField({ field_name, type: type || 1 })
              return { content: [{ type: 'text', text: `已加字段「${field_name}」(field_id=${id})。` }] }
            }
            if (!field_id) return { content: [{ type: 'text', text: '[update/delete 需要 field_id（先 lark_list_fields）]' }] }
            if (action === 'update') {
              const body = {}
              if (field_name) body.field_name = field_name
              if (type) body.type = type
              await larkUpdateField(field_id, body)
              return { content: [{ type: 'text', text: '已更新字段。' }] }
            }
            await larkDeleteField(field_id)
            return { content: [{ type: 'text', text: '已删除该字段（连同该列数据）。' }] }
          } catch (e) { return { content: [{ type: 'text', text: `[字段操作失败：${String(e?.message || e)}]` }] } }
        },
      ),
      // ---- 企微需求表（**当前降级、未启用**，2026-08-21）----
      // 曾计划让它取代飞书当主表，但企微机器人能力按项分授权：只批到「创建/编辑文档」，
      // 「搜索与获取文档内容」需领导审批、暂未批 → 写得进读不出，当不了主表。故整组工具由
      // wecomDegraded() 闸住、只回一句说明；主表仍是飞书（lark_*）。读权限批下来后把
      // wecomDocConfig.isPrimary 置真即全部生效，代码无需再改。
      // 门禁姿态（用户 2026-08-19 拍板，届时生效）：删记录/改结构**全自主**，只要求透明 →
      // PERM_DENY 不设任何 wecom_* 硬闸。
      tool(
        'wecom_list_requirements',
        '读企微需求表的记录。**注意：企微表当前是降级状态、未作为主表启用**——查"需求表有哪些/待处理有哪些/某人提了啥"请用 `lark_list_requirements`（飞书才是主表）。本工具目前调用只会返回降级说明。',
        {
          keyword: z.string().optional().describe('按需求点/详情/备注模糊匹配，留空=不过滤'),
          status: z.string().optional().describe('按状态精确过滤，如「待处理」「处理中」「已完成」「拒绝」'),
          limit: z.number().optional().describe('最多返回条数，默认 100（表有 200+ 行，别无谓拉全量）'),
        },
        async ({ keyword, status, limit }) => {
          if (wecomDegraded()) return { content: [{ type: 'text', text: WECOM_DEGRADED_MSG }] }
          try {
            // 服务端过滤：条件写进 SQL 的 WHERE/LIMIT，不拉全量再本地筛（性能规范 + §3.59 教训）。
            // 字符串字面量用双引号、字段名用反引号（CLI 明确要求的 SQL 方言）。
            const esc = s => String(s).replace(/"/g, '""')
            const where = []
            if (status) where.push(`\`状态\` = "${esc(status)}"`)
            if (keyword) {
              const k = esc(keyword)
              where.push(`(\`需求点\` LIKE "%${k}%" OR \`详情\` LIKE "%${k}%" OR \`备注\` LIKE "%${k}%" OR \`需求编号\` LIKE "%${k}%")`)
            }
            const cap = Number(limit) > 0 ? Math.min(Math.floor(Number(limit)), 500) : 100
            const sql = `SELECT * FROM \`${wecomDocConfig.sheetTitle}\`${where.length ? ' WHERE ' + where.join(' AND ') : ''} LIMIT ${cap}`
            const rows = await wecomRecordsQuery(sql)
            if (!rows.length) return { content: [{ type: 'text', text: '（需求表里没有匹配的记录）' }] }
            const text = rows.map(r => Object.entries(r)
              .filter(([, v]) => v != null && v !== '')
              .map(([k, v]) => `${k}:${(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 80)}`).join(' | ')).join('\n')
            return { content: [{ type: 'text', text }] }
          } catch (e) {
            return { content: [{ type: 'text', text: `[读企微需求表失败：${wecomErrText(e)}]` }] }
          }
        },
      ),
      tool(
        'wecom_create_requirement',
        '在企微需求表新建一行需求。**企微表当前降级未启用**，登记新需求请用 `stage_requirement_intake`（落飞书主表）。本工具目前调用只会返回降级说明。',
        {
          summary: z.string().describe('需求一句话概括（写进「需求点」）'),
          detail: z.string().optional().describe('原始描述/背景，写进「详情」'),
          proposer: z.string().optional().describe('提出人姓名'),
          status: z.string().optional().describe('状态，留空=待处理'),
          priority: z.string().optional().describe('优先级，如「P2｜中｜待排期」；不确定就留空'),
          reqNo: z.string().optional().describe('需求编号，如 REQ-0207；留空则不填（可事后补）'),
        },
        async ({ summary, detail, proposer, status, priority, reqNo }) => {
          if (wecomDegraded()) return { content: [{ type: 'text', text: WECOM_DEGRADED_MSG }] }
          const values = { 需求点: String(summary || '') }
          if (detail) values['详情'] = String(detail)
          if (proposer) values['提出人'] = String(proposer)
          if (reqNo) values['需求编号'] = String(reqNo)
          values['状态'] = [{ text: String(status || '待处理') }]
          if (priority) values['优先级'] = [{ text: String(priority) }]
          const d = new Date()
          values['提出时间'] = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
          try {
            const ids = await wecomRecordsAdd([{ values }])
            return { content: [{ type: 'text', text: `已在企微需求表登记（record_id=${ids[0] || '?'}）。` }] }
          } catch (e) {
            // 851003 → 切 webhook 兜底（webhook 是表自身开的口子，不受机器人身份限制）
            if (e?.noAuth) {
              const fb = await wecomWebhookFallbackAdd(values)
              if (fb.ok) return { content: [{ type: 'text', text: '已登记（CLI 写入被企微拒绝，**走了 Webhook 兜底通道**——如实告知用户这一点）。' }] }
              return { content: [{ type: 'text', text: `[登记失败：CLI 报 851003，Webhook 兜底也失败：${fb.error}]` }] }
            }
            return { content: [{ type: 'text', text: `[登记失败：${wecomErrText(e)}]` }] }
          }
        },
      ),
      tool(
        'wecom_update_requirement',
        '更新企微需求表某行的字段（改状态、回填归属版本、改优先级、补备注等）。record_id 从 wecom_list_requirements 取。',
        {
          record_id: z.string().describe('要改的行 ID'),
          fields: z.record(z.string()).describe('字段名→新值的映射，如 {"状态":"处理中","归属版本":"v5.18"}。单选列（状态/优先级）直接给选项文本即可。'),
        },
        async ({ record_id, fields }) => {
          if (wecomDegraded()) return { content: [{ type: 'text', text: WECOM_DEGRADED_MSG }] }
          const values = {}
          for (const [k, v] of Object.entries(fields || {})) {
            // 单选列的写入值必须是 Option 数组（[{text}]），文本列是裸字符串——写错类型企微会拒
            values[k] = (k === '状态' || k === '优先级') ? [{ text: String(v) }] : String(v)
          }
          try {
            await wecomRecordsUpdate([{ record_id, values }])
            return { content: [{ type: 'text', text: '已更新。' }] }
          } catch (e) {
            if (e?.noAuth) {
              const fb = await wecomWebhookFallbackUpdate(record_id, values)
              if (fb.ok) return { content: [{ type: 'text', text: '已更新（CLI 写入被拒，**走了 Webhook 兜底**——如实告知用户）。' }] }
              return { content: [{ type: 'text', text: `[更新失败：CLI 报 851003，Webhook 兜底也失败：${fb.error}]` }] }
            }
            return { content: [{ type: 'text', text: `[更新失败：${wecomErrText(e)}]` }] }
          }
        },
      ),
      tool(
        'wecom_delete_requirement',
        '删除企微需求表某行（不可逆！确认是废弃/重复项再删）。删完必须在回复里说清删了哪条、为什么。',
        { record_id: z.string().describe('要删的行 ID，从 wecom_list_requirements 取') },
        async ({ record_id }) => {
          if (wecomDegraded()) return { content: [{ type: 'text', text: WECOM_DEGRADED_MSG }] }
          try {
            await wecomRecordsDelete([record_id])
            return { content: [{ type: 'text', text: '已删除该行。记得在回复里说清删了哪条、为什么。' }] }
          } catch (e) {
            // 删除**没有** webhook 兜底（webhook 只写不删），失败就如实说，不假装成功（§3.48 教训）
            return { content: [{ type: 'text', text: `[删除失败：${wecomErrText(e)}${e?.noAuth ? '（Webhook 兜底不支持删除，这条删不掉）' : ''}]` }] }
          }
        },
      ),
      tool(
        'wecom_list_fields',
        '列出企微需求表的字段（字段名 + 类型 + 单选项）。改结构或不确定列名时先用它。',
        {},
        async () => {
          if (wecomDegraded()) return { content: [{ type: 'text', text: WECOM_DEGRADED_MSG }] }
          try {
            const d = await wecomFieldsList()
            const text = (d?.fields || []).map(f => {
              const opts = f.property_single_select?.options?.map(o => o.text).join('/') || f.property_select?.options?.map(o => o.text).join('/') || ''
              return `${f.field_title} | ${f.field_type}${opts ? ' | 选项:' + opts : ''}`
            }).join('\n')
            return { content: [{ type: 'text', text: text || '（无字段）' }] }
          } catch (e) { return { content: [{ type: 'text', text: `[列字段失败：${wecomErrText(e)}]` }] } }
        },
      ),
      tool(
        'wecom_manage_field',
        '管理企微需求表结构：加字段 / 改字段名 / 删字段。改删前先 wecom_list_fields 核对。删字段会丢该列所有数据（不可逆），做完要说清。企微字段类型：text 文本 / number 数字 / single_select 单选 / date_time 日期 / user 人员 / image 图片。',
        {
          action: z.enum(['create', 'update', 'delete']).describe('create=加字段 / update=改名 / delete=删字段'),
          field_title: z.string().describe('字段名（update 时填**原**字段名）'),
          new_field_title: z.string().optional().describe('update 改名时的新名字'),
          field_type: z.string().optional().describe('create 时的类型，默认 text'),
        },
        async ({ action, field_title, new_field_title, field_type }) => {
          if (wecomDegraded()) return { content: [{ type: 'text', text: WECOM_DEGRADED_MSG }] }
          const base = { docid: wecomDocConfig.docid, sheet_title: wecomDocConfig.sheetTitle }
          try {
            if (action === 'create') {
              await wecomCliJson('smartsheet', 'fields add', { ...base, fields: [{ field_title, field_type: field_type || 'text' }] })
              return { content: [{ type: 'text', text: `已加字段「${field_title}」。` }] }
            }
            if (action === 'update') {
              if (!new_field_title) return { content: [{ type: 'text', text: '[改名需要 new_field_title]' }] }
              await wecomCliJson('smartsheet', 'fields update', { ...base, fields: [{ field_title, new_field_title }] })
              return { content: [{ type: 'text', text: `已把「${field_title}」改名为「${new_field_title}」。` }] }
            }
            await wecomCliJson('smartsheet', 'fields delete', { ...base, fields: [{ field_title }] })
            return { content: [{ type: 'text', text: `已删除字段「${field_title}」（连同该列数据）。记得在回复里说清。` }] }
          } catch (e) { return { content: [{ type: 'text', text: `[字段操作失败：${wecomErrText(e)}]` }] } }
        },
      ),
    ],
  })
}

// 菲菲的"记忆"工具（只读）：回忆企微历史对话 + 看登记过的需求。挂给企微人格 + 看板 feifei（读同一份
// conversations.jsonl → "一个菲菲一份记忆"）。CONVO_FILE/WECOM_INTAKE_FILE 为模块常量，运行时已就绪。
function makeFeifeiMemory() {
  return createSdkMcpServer({
    name: 'feifei-memory',
    version: '0.1.0',
    tools: [
      tool(
        'recall_conversations',
        '回忆你（菲菲）在企业微信里跟大家的历史对话——你自己聊过的记录。可按人、时间窗、关键词筛。被问“今天聊了啥/某人说了啥/最近有什么需求”时，先用它查再答，别凭空说。',
        {
          user: z.string().optional().describe('按显示名或 userid 过滤（如 静安），留空=所有人'),
          sinceHours: z.number().optional().describe('只看最近 N 小时，默认 24；传 0 = 不限时间'),
          keyword: z.string().optional().describe('正文关键词过滤，留空=不筛'),
          limit: z.number().optional().describe('最多返回条数，默认 80'),
        },
        async ({ user, sinceHours, keyword, limit }) => {
          const hrs = (sinceHours === undefined || sinceHours === null) ? 24 : Number(sinceHours)
          const since = hrs > 0 ? Date.now() - hrs * 3600000 : 0
          const cap = Math.min(300, Number(limit) > 0 ? Number(limit) : 80)
          let rows = []
          try { rows = fs.readFileSync(CONVO_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { }
          rows = rows.filter(r => r.kind === 'wecom')
          if (since) rows = rows.filter(r => { const t = Date.parse(r.ts || ''); return !t || t >= since })
          if (user) { const u = String(user).toLowerCase(); rows = rows.filter(r => [r.from, r.to, r.threadRootId].some(x => String(x || '').toLowerCase().includes(u))) }
          if (keyword) { const k = String(keyword); rows = rows.filter(r => String(r.text || '').includes(k)) }
          rows = rows.slice(-cap)
          const lines = rows.map(r => `[${r.ts || ''}] ${r.fromKind === 'employee' ? '菲菲' : (r.from || '?')} → ${r.to || '?'}: ${String(r.text || '').replace(/\s+/g, ' ').slice(0, 300)}`)
          return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '（这个范围内没有企微对话记录）' }] }
        },
      ),
      tool(
        'recall_staged_requirements',
        '看你登记过的“待处理”需求（本地暂存）。注：若已接飞书需求表，登记会直接进飞书“待处理”行——那种情况请改用飞书查询工具查 状态=待处理，本工具是无飞书时的兜底。',
        { sinceHours: z.number().optional().describe('只看最近 N 小时，默认 72；传 0 = 不限') },
        async ({ sinceHours }) => {
          const hrs = (sinceHours === undefined || sinceHours === null) ? 72 : Number(sinceHours)
          const since = hrs > 0 ? Date.now() - hrs * 3600000 : 0
          let rows = []
          try { rows = fs.readFileSync(WECOM_INTAKE_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { }
          if (since) rows = rows.filter(r => { const t = Date.parse(r.ts || ''); return !t || t >= since })
          const lines = rows.map(r => `[${r.ts || ''}] ${wecomDisplayName(r.userid)}: ${String(r.summary || '').slice(0, 300)}`)
          return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : '（本地没有暂存的待处理需求；若接了飞书，请查飞书需求表 状态=待处理）' }] }
        },
      ),
    ],
  })
}

// ---------- 任务档案「共享总线」写收归引擎（并发写安全的核心；bypass 下 canUseTool 锁不可用，只能靠引擎自己写） ----------
// 背景：tasks/*.md 是所有员工共写的唯一状态总线（frontmatter 状态 / 时间线）。员工各自用 Edit 读-改-写会在
// 并行下互相覆盖(clobber) + 锚点失配静默失败(§3.3 事故)。收归引擎后：引擎持磁盘为准、per-file 串行 + 原子写
// (temp→rename)，压根没有「锚点」概念 → 同时根治两类竞态。员工改这两块改调 append_timeline/set_task_status 工具。
function atomicWrite(abs, content) {
  const tmp = abs + '.tmp-' + crypto.randomBytes(3).toString('hex')
  fs.writeFileSync(tmp, content, 'utf8')
  fs.renameSync(tmp, abs)   // 同盘 rename 原子：读者要么看到旧全量、要么新全量，永不看到半截
}
// per-file 串行闸：同一档案的写操作排成一条 Promise 链，杜绝交错读改写
const _archiveLocks = new Map()
function withArchiveLock(abs, fn) {
  const prev = _archiveLocks.get(abs) || Promise.resolve()
  const next = prev.then(() => fn(), () => fn())   // 前一个成败都不挡后一个
  _archiveLocks.set(abs, next.then(() => { }, () => { }))
  return next
}
// 往「## 时间线」原子追加一条（插在该节末尾、下一个 ## 之前；无该节则补一个）
function engineAppendTimeline(abs, line) {
  let text = fs.readFileSync(abs, 'utf8')
  const bullet = `- ${todayStr()} ${String(line).replace(/\s+/g, ' ').trim()}\n`
  const m = text.match(/(^|\n)##\s*时间线[^\n]*\n/)
  if (!m) { atomicWrite(abs, text.replace(/\s*$/, '\n') + `\n## 时间线\n\n${bullet}`); return }
  const secStart = m.index + m[0].length
  const rest = text.slice(secStart)
  const nextH = rest.search(/\n##\s/)
  const insertAt = nextH === -1 ? text.length : secStart + nextH
  const head = text.slice(0, insertAt).replace(/\n*$/, '\n')
  atomicWrite(abs, head + bullet + text.slice(insertAt))
}
// 改 frontmatter 单个标量（保留行尾 # 注释）；键不存在则在 frontmatter 末尾补一行
function engineSetFrontmatterScalar(abs, key, value) {
  const text = fs.readFileSync(abs, 'utf8')
  if (!text.startsWith('---')) throw new Error('档案无 frontmatter')
  const end = text.indexOf('\n---', 3)
  if (end === -1) throw new Error('frontmatter 未闭合')
  let fm = text.slice(0, end)
  // 尾部 `((?:\n[ \t]+-…)*)` 连带吃掉该键原有的 YAML 块列表子行——否则把一个块列表键改写成标量时，
  // 旧的 `  - …` 会留在下面变成孤儿行（对 parseFrontmatter 就是「上一个 key 又长出一串数组」）。
  const re = new RegExp(`(^|\\n)(\\s*${key}\\s*:)([^\\n]*)(?:\\n[ \\t]+-[^\\n]*)*`)
  const v = String(value)
  const block = v.startsWith('\n')   // 多行值＝块列表：行尾注释得留在 key 行上，不能跟到最后一项后面
  if (re.test(fm)) {
    fm = fm.replace(re, (full, pre, k, val) => {
      const ci = val.search(/\s#/)
      const comment = ci >= 0 ? val.slice(ci) : ''
      return block ? `${pre}${k}${comment}${v}` : `${pre}${k} ${v}${comment}`
    })
  } else { fm = fm.replace(/\n?$/, `\n${key}:${block ? '' : ' '}${v}`) }
  atomicWrite(abs, fm + text.slice(end))
}
// 写一个「可能多值」的 frontmatter 键：1 项写裸标量（不给历史档案平白加列表语法），≥2 项写 YAML 块列表
// （facet_doc 动辄 9 条中文长路径，挤一行没法看）。两种形态 parseFrontmatter + coverage.js·facetDocList 都认，
// 且上面的 re 会吃掉旧子行，所以形态之间可以来回切换而不留残渣。
function engineSetFrontmatterList(abs, key, items) {
  const list = (items || []).map(s => String(s).trim()).filter(Boolean)
  return engineSetFrontmatterScalar(abs, key, list.length > 1 ? '\n' + list.map(p => `  - ${p}`).join('\n') : (list[0] || ''))
}
// 条目状态枚举与几张派生表已收敛到 `entry-status.js`（引擎侧唯一事实源，纯函数模块也能 import——
// 从 server.js 引会成环，那正是它们此前被抄第二份的原因）。仍须与 app/public/app.js 的 `ENTRY_STATUS`
// 键集、`文档格式规范.md` §3.4 的状态表保持一致（改一处同步另两处，这条没变）。
// 改「## 需求条目登记表」里某条目行的 状态/当前阶段/owner（按**列名**定位，不认列序）；no 不存在且给了 name → 表尾按列序补一行。
// 泛化自 passEntry（那只置「人工Pass」）；原子写、无锚点，替代员工手 Edit 长表（易锚点失配 + 并行覆盖，§3.3）。
function engineSetEntryRow(abs, { no, status, stage, owner, name }) {
  const text = fs.readFileSync(abs, 'utf8')
  const m = text.match(/(##\s*需求条目登记表[\s\S]*?)(\n## |$)/)
  if (!m) throw new Error('未找到「## 需求条目登记表」段（先在档案里建这张表）')
  const section = m[1]
  const lines = section.split('\n')
  const rowCells = line => { const c = line.split('|').map(x => x.trim()); c.shift(); if (c[c.length - 1] === '') c.pop(); return c }
  const headerIdx = lines.findIndex(l => l.trim().startsWith('|'))
  if (headerIdx < 0) throw new Error('登记表无表头')
  const header = rowCells(lines[headerIdx]).map(h => h.replace(/\*\*/g, ''))
  const idxOf = (...names) => { for (const n of names) { const i = header.findIndex(h => h.startsWith(n)); if (i >= 0) return i } return -1 }
  const iNo = idxOf('#'), iName = idxOf('条目'), iStatus = idxOf('状态'), iStage = idxOf('当前阶段'), iOwner = idxOf('owner', '负责')
  if (iStatus < 0) throw new Error('登记表无「状态」列（表头需含 状态 列）')
  const cleanNo = v => String(v == null ? '' : v).replace(/[#\s*]/g, '')
  const setCell = (cells, i, v) => { if (i >= 0 && v != null && v !== '') { while (cells.length <= i) cells.push(''); cells[i] = String(v) } }
  let hit = null
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue
    const cells = rowCells(lines[i])
    if (cleanNo(iNo >= 0 ? cells[iNo] : cells[0]) !== cleanNo(no)) continue   // 分隔行/别的行 no 对不上 → 跳过
    setCell(cells, iStatus, status); setCell(cells, iStage, stage); setCell(cells, iOwner, owner)
    lines[i] = '| ' + cells.join(' | ') + ' |'
    hit = ((iName >= 0 ? cells[iName] : '') || cleanNo(no)).replace(/\*\*/g, '').trim()
    break
  }
  if (hit === null) {
    if (!name) throw new Error(`未找到条目 #${no}（要新建该行请给 name）`)
    const cells = header.map(() => '')
    setCell(cells, iNo, String(no)); setCell(cells, iName, name); setCell(cells, iStatus, status); setCell(cells, iStage, stage); setCell(cells, iOwner, owner)
    let lastRow = headerIdx
    for (let i = headerIdx + 1; i < lines.length; i++) if (lines[i].trim().startsWith('|')) lastRow = i
    lines.splice(lastRow + 1, 0, '| ' + cells.join(' | ') + ' |')
    hit = name
  }
  atomicWrite(abs, text.slice(0, m.index) + lines.join('\n') + text.slice(m.index + section.length))
  return hit
}

// ---------- 覆盖率闸门：把「这版 QA 测没测全 / 绿是不是真绿」从 LLM 自评挪成引擎算 ----------
// 核心逻辑独立成 coverage.js（ESM 模块，纯函数+文件读写、可单测、不启动 server）；import 在文件顶部。
// 这里只保留用 server 内部依赖(safeResolve/resolveRepoFile/parseFrontmatter)的 computeCoverageForRun。
// 原则：agent 越少靠自觉、越多靠算得出的外部闸门，越不可能空转。提案见 docs/迷糊QA覆盖率闸门-方案设计.md。

function sha256File(abs) {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
}

function gitCommitForFile(abs) {
  let dir = path.dirname(path.resolve(abs))
  while (dir && dir !== path.dirname(dir)) {
    const dotGit = path.join(dir, '.git')
    if (fs.existsSync(dotGit)) {
      let gitDir = dotGit
      const stat = fs.statSync(dotGit)
      if (stat.isFile()) {
        const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)
        if (!pointer) throw new Error(`无法解析 ${dotGit}`)
        gitDir = path.resolve(dir, pointer[1].trim())
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
      if (!head.startsWith('ref:')) return head
      const ref = head.slice(4).trim()
      const loose = path.join(gitDir, ...ref.split('/'))
      if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim()
      const packed = path.join(gitDir, 'packed-refs')
      if (fs.existsSync(packed)) {
        const hit = fs.readFileSync(packed, 'utf8').split('\n').find(line => line.endsWith(` ${ref}`))
        if (hit) return hit.split(' ')[0]
      }
      throw new Error(`找不到 Git ref ${ref}`)
    }
    dir = path.dirname(dir)
  }
  throw new Error(`测试文件不在 Git 仓库：${abs}`)
}

function machineEvidence({ summaryPath, summary, testFile, caseId }) {
  const runId = String(summary?.runtimeVariables?.runId || summary?.runId || path.basename(path.dirname(summaryPath))).trim()
  const env = String(summary?.runContext?.triggerSurface || summary?.evidenceProfile || '').trim()
  if (!runId || !env || !caseId) throw new Error(`summary 缺 runId/env/case：${summaryPath}`)
  const clean = v => String(v).replace(/[;\r\n]/g, '_')
  return [
    `runId=${clean(runId)}`,
    `case=${clean(caseId)}`,
    `testHash=${sha256File(testFile)}`,
    `summaryHash=${sha256File(summaryPath)}`,
    `commit=${clean(gitCommitForFile(testFile))}`,
    `env=${clean(env)}`,
    `summary=${clean(path.relative(ROOT, summaryPath) || summaryPath)}`,
    // testFile：便于看板卡片一键跳用例；**不**进 GREEN_EVIDENCE_FIELDS（validateMachineEvidence 不校验它），
    // 故既有无该字段的历史档案仍 fail-closed 兼容，只是新签发的证据多带一处溯源路径。
    `testFile=${clean(path.relative(ROOT, testFile) || testFile)}`,
  ].join(';')
}

// frontmatter.facet_doc（可以是一份，也可以是多份——形态见 coverage.js·facetDocList）→ 逐份读盘。
// 返回 [{rel, text}]，text==null＝找不到/读不出（调用方据此 fail-closed，别把"读不到"当"没这条 facet"）。
function loadFacetDocs(fm) {
  return facetDocList(fm && fm.facet_doc).map(rel => {
    const abs = resolveRepoFile(rel)
    let text = null
    if (abs) { try { text = fs.readFileSync(abs, 'utf8') } catch { text = null } }
    return { rel, text }
  })
}
// 多份 facet 文档 → 一个权威全集（分母）。`missing` 非空即有文档失联，门禁路径上必须当硬错处理。
function loadFacetSet(fm) {
  const docs = loadFacetDocs(fm)
  return {
    facets: mergeFacetSets(docs.map(d => (d.text == null ? [] : extractFacetsFromDoc(d.text)))),
    rels: docs.map(d => d.rel),
    missing: docs.filter(d => d.text == null).map(d => d.rel),
    docs,
  }
}
// 版本目录锚点＝列表第一项（约定：主文档排头）。QA 报告落点 / 发布四件核对都据它定版本目录。
function primaryFacetDoc(fm) { return facetDocList(fm && fm.facet_doc)[0] || '' }

// ── 需求溯源闸（requirement_trace_complete）：读档案 frontmatter 的 source_materials + trace_doc，
// 对着 facet 全集机算「facet 表覆盖没覆盖源材料的每个可枚举单元」。返回 computeTrace 的结果。
// 与 validateArchiveFile 的分工：那道闸问「facet 都测了吗」（分母=facet 表），这道闸问「facet 齐了吗」
// （分母=源材料单元）——两个分母缺一个都能让缩水的需求全绿放行（2026-09-08 大货备货事故，复盘 §3.122）。
// 读不到 trace_doc 一律当 missing（fail-closed，别把"读不到"当"没缺口"）。
// 一次读档，两道闸共用（避免同一份 facet_doc/trace_doc 被解析两遍）。
// 指针一律 fail-closed：文件读不到就当 missing，别把"读不到"当"没缺口"。
function readReqSideDocs(abs) {
  const text = fs.readFileSync(abs, 'utf8')
  const fm = parseFrontmatter(text) || {}
  const rel = k => String(fm[k] || '').trim().replace(/^['"]|['"]$/g, '')
  const load = r => { if (!r) return null; const p = resolveRepoFile(r); if (!p) return null; try { return fs.readFileSync(p, 'utf8') } catch { return null } }
  const traceRel = rel('trace_doc'), treeRel = rel('feature_tree_doc'), openRel = rel('open_items_doc')
  const traceText = load(traceRel), treeText = load(treeRel), openText = load(openRel)
  return {
    fm, traceRel, treeRel, openRel,
    traceMissing: !!traceRel && traceText == null,
    treeMissing: !!treeRel && treeText == null,
    openMissing: !!openRel && openText == null,
    openItemsRows: openText == null ? [] : extractLedgerRows(openText),
    materials: parseSourceMaterials(fm.source_materials),
    traceRows: traceText == null ? [] : extractTraceRows(traceText),
    treeRows: treeText == null ? [] : extractTreeRows(treeText),
    // 工作流表 + 自我批判回应表与功能树同住一份文档（它们是同一件事的三张表：拆成什么、用户怎么走、我可能漏了什么）
    treeText: treeText || '',
    facetDocText: loadFacetDocs(fm).map(d => d.text || '').join('\n'),
    archiveText: text,               // 档案正文：校「待确认事项每条有没有写『不拍的代价』」
    facets: loadFacetSet(fm).facets,
    facetIds: loadFacetSet(fm).facets.map(f => f.id),
    baseline: parseBaseline(text),
    createdOn: String(fm.created || '').trim(),
  }
}
function validateTraceFile(abs, pre) {
  const d = pre || readReqSideDocs(abs)
  return computeTrace({
    materials: d.materials, rows: d.traceRows, facetIds: d.facetIds,
    traceDocRel: d.traceRel, traceDocMissing: d.traceMissing, createdOn: d.createdOn,
  })
}
// 功能树闸（纵向那半）：溯源闸的分母来自材料，材料本身写得浅它就够不到；功能树逼到叶子四要素。
// 双向对账：把溯源表里「立需求」的 facet 喂给它，没挂到树上的会被点名（那条需求属于哪块功能？）。
// 实质闸（第四道·分母=单元里的判据）：溯源闸只问「每个单元有没有一行、那一行填的 facet 号存不存在」，
// 填一个桶（F75「展示基线」吃 33 个单元）就合规——2026-09-09 就是这么在 357/357 全绿的账面下
// 把整个详情抽屉漏掉的。本闸把源材料的**单元原文**读出来，问那条 facet 有没有真的把判据写进去。
// 扫描结果按 路径+片段+mtime 缓存：软自检挂在派工提示里、会被反复调用，1MB 原型 × 4 片段不该每次重读。
const _substanceScanCache = new Map()
function scanMaterialCached(abs, fragment) {
  let key = ''
  try { key = `${abs}|${fragment}|${fs.statSync(abs).mtimeMs}` } catch { return null }
  if (_substanceScanCache.has(key)) return _substanceScanCache.get(key)
  let r = null
  try { r = scanSubstance(abs, { fragment }) } catch { r = null }
  if (_substanceScanCache.size > 64) _substanceScanCache.clear()   // 上限即清空：这缓存只为省重复读，不需要 LRU
  _substanceScanCache.set(key, r)
  return r
}
function validateSubstanceFile(abs, pre) {
  const d = pre || readReqSideDocs(abs)
  const scans = []
  for (const m of d.materials.materials || []) {
    const [rawPath, frag = ''] = String(m.path || '').split('#')
    const p = resolveRepoFile(rawPath)
    if (!p) continue
    const sc = scanMaterialCached(p, frag)
    if (sc) scans.push({ materialId: m.id, ...sc })
  }
  return computeSubstance({
    scans, rows: d.traceRows, facets: d.facets, facetText: d.facetDocText,
    ledgerRows: d.openItemsRows, ledgerRel: d.openRel, ledgerMissing: d.openMissing,
    createdOn: d.createdOn,
  })
}
function validateFeatureTreeFile(abs, pre) {
  const d = pre || readReqSideDocs(abs)
  return computeFeatureTree({
    rows: d.treeRows, facetIds: d.facetIds,
    materialIds: (d.materials.materials || []).map(m => m.id),
    traceMappedFacets: d.traceRows.filter(r => r.disposition === '立需求').flatMap(r => r.facets),
    treeDocRel: d.treeRel, treeDocMissing: d.treeMissing, createdOn: d.createdOn,
    since: TRACE_GATE_SINCE,
  })
}
// 需求分析质量闸（①④⑤⑥）：拷问打标必须问出去 / 机器点名的可疑点必须逐条回应 /
// 用户工作流每步必须落在功能树上 / 需求缺陷率（只报不拦）。
function validateReqQualityFile(abs, pre) {
  const d = pre || readReqSideDocs(abs)
  const tree = computeFeatureTree({
    rows: d.treeRows, facetIds: d.facetIds,
    materialIds: (d.materials.materials || []).map(m => m.id),
    treeDocRel: d.treeRel, treeDocMissing: d.treeMissing, createdOn: d.createdOn, since: TRACE_GATE_SINCE,
  })
  return computeReqQuality({
    facetDocText: d.facetDocText, qualityDocText: d.treeText,
    treeNodes: tree.tree ? tree.tree.nodes : [], tree,
    trace: validateTraceFile(abs, d), facets: d.facets,
    baseline: d.baseline, createdOn: d.createdOn, since: TRACE_GATE_SINCE,
    archiveText: d.archiveText,      // ① 的第二半：待确认事项必须写「不拍的代价」
  })
}
// 需求基线落盘（⑥ 的载体）：**首次**通过需求侧门禁时拍一张快照——那一刻就是本仓的 sign-off。
// 只写一次（已有基线绝不覆盖，否则每次改需求都把尺子跟着挪，缺陷率恒为 0）。必须在 withArchiveLock 内调用。
function maybeSnapshotBaseline(abs, { trace, tree, facetIds }) {
  try {
    const text = fs.readFileSync(abs, 'utf8')
    if (parseBaseline(text)) return false                    // 尺子只立一次
    if (!trace?.traceComplete || !tree?.treeComplete) return false
    const b = snapshotBaseline({ facetIds, treeStats: tree.stats, traceStats: trace, at: todayStr() })
    if (!b.facets.length) return false
    const block = '\n' + renderBaseline(b) + '\n'
    // 插在「## 时间线」之前（时间线永远在档案最后一段，基线属于"状态"不属于"流水"）
    const i = text.indexOf('\n## 时间线')
    atomicWrite(abs, i === -1 ? text.replace(/\s*$/, '\n') + block : text.slice(0, i) + block + text.slice(i))
    return true
  } catch { return false }
}
// 需求侧两道闸的软信号（附在工具返回文本后）：只提示不阻断——硬挡在各自门禁点已判。
function softTraceWarn(abs) {
  try {
    const d = readReqSideDocs(abs)
    const out = []
    const t = validateTraceFile(abs, d)
    if (t.active) { const a = [...t.errors, ...t.warnings]; if (a.length) out.push(`⚠ 溯源自检（需求侧横向覆盖·材料→需求）：\n- ${a.join('\n- ')}`) }
    const g = validateFeatureTreeFile(abs, d)
    if (g.active) { const a = [...g.errors, ...g.warnings]; if (a.length) out.push(`⚠ 功能树自检（需求侧纵向完整·需求→叶子）：\n- ${a.join('\n- ')}`) }
    const q = validateReqQualityFile(abs, d)
    if (q.active) { const a = [...q.errors, ...q.warnings]; if (a.length) out.push(`⚠ 需求分析自检（拷问打标/自我批判/工作流/缺陷率）：\n- ${a.join('\n- ')}`) }
    const s = validateSubstanceFile(abs, d)
    if (s.unitTotal) { const a = [...s.errors, ...s.warnings]; if (a.length) out.push(`⚠ 实质自检（登记到的那条 facet 真的包含这个单元吗）：\n- ${a.join('\n- ')}`) }
    return out.length ? '\n' + out.join('\n') : ''
  } catch { return '' }
}
// 溯源闸的门在**「进开发」这一格**，不是"开发及以后每一格"。
// DEV_ENTRY = 真正的那道门（缩水的 facet 表一旦进了开发，后面每道闸都只围着它转、越测越确信）。
// DEV_ONWARD = 门以后的格子：**只软提示、不硬挡**——到这儿再拦，罚的是迷糊/波比（不是他们的活），
// 而缺口在 gate 标记、软自检、晨检包里都已经可见。一道门守一次，别把同一件事拦三遍。
const DEV_ENTRY_STATUS = new Set(['待开发', '开发中', '已开发', '待审', '已定稿'])
const DEV_ONWARD_STATUS = new Set([...DEV_ENTRY_STATUS, ...QA_ONWARD_STATUS])

// 溯源闸在状态推进处的判定：返回要回给调用方的拦截文案（''＝放行）。
// 硬/软分档（沿用「守航态不硬挡下游」的既有哲学）：
//   · 产出人菲菲本人 → 只要 active 且有 errors 一律硬挡（这活就是她的，且她当场能补）；
//   · 其他员工 → 仅「进开发」那一格 + 共驾态（白天有人能补）才硬挡；守航态一律不硬挡（无人值守，硬挡=夜里卡死）。
// 需求侧两道闸走**同一道门**（进开发），但各自一个 gate 标记——看板要看得出缺的是哪半：
//   横向（溯源）：材料 → 需求，防漏读材料；纵向（功能树）：需求 → 叶子，暴露"材料本身写得浅"。
function traceGateBlockMsg(abs, run, status, { devEntry }) {
  let t, g, q, s
  try { const d = readReqSideDocs(abs); t = validateTraceFile(abs, d); g = validateFeatureTreeFile(abs, d); q = validateReqQualityFile(abs, d); s = validateSubstanceFile(abs, d) }
  catch (e) { t = { active: true, errors: [`需求侧闸门读档失败：${String(e?.message || e)}`] }; g = { active: false, errors: [] }; q = { active: false, errors: [] }; s = { active: false, errors: [] } }
  const parts = []
  if (t.active && t.errors.length) parts.push({ name: '溯源闸（横向·材料→需求）', errors: t.errors, hint: TRACE_HINT })
  if (g.active && g.errors.length) parts.push({ name: '功能树闸（纵向·需求→叶子）', errors: g.errors, hint: TREE_HINT })
  if (s.active && s.errors.length) parts.push({ name: '实质闸（那条 facet 真的包含这个单元吗）', errors: s.errors, hint: SUBSTANCE_HINT })
  if (q.active && q.errors.length) parts.push({ name: '需求分析闸（拷问问出去 / 工作流走得通 / 自我批判逐条回应）', errors: q.errors, hint: '跑 `validate_req_analysis` 看机器点名的可疑点清单，逐条在《功能树》文档的「自我批判回应」表里给归宿。' })
  if (!parts.length) return ''
  const isPm = run.employee === 'feifei'
  const hard = isPm || (devEntry && run.executionMode !== 'guarded_run')
  if (!hard) return ''
  const body = parts.map(p => `【${p.name}】\n- ${p.errors.join('\n- ')}`).join('\n\n')
  return `[需求侧门禁拦下：推进到 ${status} 前，需求梳理还没做全]\n\n${body}\n\n` + (isPm
    ? '这是你（菲菲）职责内的活：补齐后再推进；真拿不定的口径写成拍板题 park 给老板，别先推状态。\n\n' + parts.map(p => p.hint).join('\n\n')
    : '请 cc_colleague("菲菲", "补齐需求侧两份产物：源材料清点单+溯源映射表、功能树与叶子四要素") 后再推进——这不是你该替她补的活。')
}

// 把机算的溯源结论落成 frontmatter gate（看板/晨检包据它显示"需求侧覆盖齐没齐"，与 qa_coverage_complete
// 并列成两个分母）。**必须在 withArchiveLock 内调用**（内部是裸文件写，自己不再加锁）。算不出来不写，
// 不把"读档失败"写成 false（那会与"真的不完整"混为一谈）。
function syncTraceGate(abs) {
  try {
    const d = readReqSideDocs(abs)
    const t = validateTraceFile(abs, d)
    if (t.active) engineSetGate(abs, 'requirement_trace_complete', !!t.traceComplete)
    const g = validateFeatureTreeFile(abs, d)
    if (g.active) engineSetGate(abs, 'feature_tree_complete', !!g.treeComplete)
    const q = validateReqQualityFile(abs, d)
    if (q.active) engineSetGate(abs, 'req_analysis_complete', !!q.complete)
    const s = validateSubstanceFile(abs, d)
    if (s.active) engineSetGate(abs, 'requirement_substance_complete', !!s.substanceComplete)
    // 三闸齐绿的那一刻＝本仓的 sign-off → 立需求基线（尺子只立一次，见 maybeSnapshotBaseline）
    if (t.active && t.traceComplete && g.treeComplete) maybeSnapshotBaseline(abs, { trace: t, tree: g, facetIds: d.facetIds })
  } catch { /* 算不出来就不写 */ }
}

// 从一条 run 的任务档案算覆盖率（读 facet_doc 拿权威分母）。异常必须抛出，由调用方 fail-closed。
function computeCoverageForRun(run) {
  if (!run || !run.taskFile) throw new Error('QA run 缺 taskFile')
  const abs = safeResolve(run.taskFile)
  const text = fs.readFileSync(abs, 'utf8')
  const fm = parseFrontmatter(text) || {}
  const { facets, rels, missing } = loadFacetSet(fm)
  if (!rels.length) throw new Error('任务档案缺 facet_doc，无法确定覆盖分母')
  if (missing.length) throw new Error(`facet_doc 不存在：${missing.join('、')}`)
  if (!facets.length) throw new Error(`facet_doc 没有可解析的 facet：${rels.join('、')}`)
  const cov = computeCoverage(text, facets)
  if (!cov) throw new Error('任务档案缺覆盖矩阵')
  return cov
}

// facet/覆盖生命周期校验（路径解析包装）：读档案 + 解析 frontmatter.facet_doc + 读 facet 文档，喂给 coverage.js 的纯 validateArchive。
// 返回 { errors, warnings, facetCount, matrixCount }。errors 非空 = 该档案还不满足「进 QA」硬前置（facet_doc 缺/找不到/无 ID facet）。
// 用于：GG Bond→迷糊 交棒门禁、set_entry/task_status→待测门禁、人工端点门禁（硬）；写后自检 + validate_task_archive 工具 + 漂移巡检（软）。
function validateArchiveFile(abs) {
  const text = fs.readFileSync(abs, 'utf8')
  const fm = parseFrontmatter(text) || {}
  return validateArchive({ text, facetDocs: loadFacetDocs(fm) })
}

// 「条目状态是否已进入/越过 QA 阶段」——facet_doc 硬门禁只在这些状态上生效（早期 待梳理/开发中 零摩擦）。

// 写后软自检：把 facet 生命周期的 errors+warnings 汇成可附到工具返回文本的后缀（无则空串）。
// 只提示不阻断——硬门禁在写入前已判；这里让「写完顺带发现的问题」（孤儿行/状态非法/facet_doc 还没补）浮上来。
function softValidateWarn(abs) {
  try {
    const v = validateArchiveFile(abs)
    const all = [...v.errors, ...v.warnings]
    return all.length ? `\n⚠ facet 自检：\n- ${all.join('\n- ')}` : ''
  } catch { return '' }
}

// ── 缺陷行「壳号 facet」门禁辅助（BUG-001 漏 facet 事故对策，2026-09-07）──
// 缺陷单的验收 facet 挂在壳号 REQ-9NNN 上（末三位=缺陷号，如 BUG-001→REQ-9001、BUG-013→REQ-9013），
// 因覆盖率引擎 FACET_ID_RE 只认 REQ-<数字>-F<序号>、BUG-00X-Fn 播不进矩阵（见 coverage.js FACET_DOC_HINT）。
// bugShellReq：从条目 no/name 认出缺陷号并算壳号；facetDocHasShell：版本主 facet_doc 里是否已有该壳号的 facet。
function bugShellReq(no, name) {
  const m = String(no || '').match(/BUG-0*(\d+)/i) || String(name || '').match(/BUG-0*(\d+)/i)
  if (!m) return { isBug: false, shellReq: '' }
  return { isBug: true, shellReq: 'REQ-9' + String(m[1]).padStart(3, '0').slice(-3) }
}
function facetDocHasShell(abs, shellReq) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(abs, 'utf8')) || {}
    const prefix = (shellReq + '-F').toUpperCase()
    return (loadFacetSet(fm).facets || []).some(f => String(f.id || '').toUpperCase().startsWith(prefix))
  } catch { return false }
}

// 看板只读聚合：把 facet_doc（全集权威）+ 任务档案 ## 覆盖矩阵（状态/证据覆盖层）汇成卡片可渲染的 facet 载荷。
// 与 computeCoverageForRun 的区别：这里**不 fail-closed、缺件降级**、纯展示、不参与门禁判定。
// A+甲：以 facet_doc 为**显示全集**——菲菲需求确认/会审定稿 facet_doc 那刻看板就显完整骨架（矩阵未铺的 facet 显 UNCOVERED），
// 不必等 seed。facet_doc 缺失时退化用矩阵自身；矩阵有而 facet_doc 无的行标 unlisted（迷糊临时加、待回写菲菲）。
function buildCoveragePayload(text, fm) {
  let matrix
  try { matrix = extractCoverageMatrix(text) || [] } catch { matrix = [] }
  // facet_doc = 全集权威（给 criterion 原文 + 骨架分母）；可缺、可多份（读不到的那份降级成"没这些 facet"，展示层不 fail-closed）
  let facets = []
  try { facets = loadFacetSet(fm).facets } catch { facets = [] }
  if (!facets.length && !matrix.length) return null   // 老版本无 ID facet 且无矩阵 → 卡片无 facet 区（维持现状）
  const rows = mergeFacetRows(facets, matrix)   // facet_doc 全集 ∪ 矩阵状态（纯函数，见 coverage.js·可单测）
  // 按 REQ 分组 → 逐 REQ 显示层派生（4.2 / 4.3）
  const byReq = {}
  for (const row of rows) (byReq[row.req] || (byReq[row.req] = [])).push(row)
  const reqRollup = {}
  for (const [req, list] of Object.entries(byReq)) {
    if (!req) continue
    reqRollup[req] = rollupReqFacets(list.map(r => ({ status: r.status, redOk: r.status === 'COVERED_GREEN' ? r.redOk : undefined })))
  }
  // 版本级汇总（4.4）：facet_doc 有则 denom=facet_doc 全集（与门禁同口径）；缺则 computeCoverage 退化用矩阵作分母
  let summary = null
  try {
    const cov = computeCoverage(text, facets)
    if (cov) summary = { denom: cov.denom, byStatus: cov.byStatus || {}, passed: !!cov.passed, redComplete: !!cov.redComplete, hasDoc: !!cov.hasDoc }
  } catch { summary = null }
  return { rows, reqRollup, summary }
}

// ---------- 协作工具（in-process MCP，挂给每个看板员工 run）：抄送(cc) + 档案共享总线写 ----------
// 抄送(cc) = 第三种交接原语：知会另一员工并行去做他那份、我不停等、他也不回发我（区别于【下一棒】交棒即停 / 【交回】回发即停）。
// 承重点在这里做成「回合内工具」而非「回合边界标记」：工具作为副作用派生兄弟 run + 立即返回，发起方回合从不中断 →
// 教科书式 fire-and-continue，绕开被回退过的「引擎自动 re-push 续跑」老路（会锁死 running、/reply 409）。
// 巡视员专属工具：唤起指定已收工会话续跑。**不进全员共享 makeCollabTools**——"resume 任意员工"不该人人可用，只挂给巡视员。
function makePatrolTools(run) {
  return createSdkMcpServer({
    name: 'patrol',
    version: '0.1.0',
    tools: [
      tool(
        'resume_employee',
        '唤起某个已收工(done)的员工会话续跑（同会话 resume、保上下文）。仅当你判定该会话是「明显空停」（既没交接也没待老板拍板、任务却没干完）时用。目标非 done / 无 sessionId / 该员工正忙于别的会话 → 返回失败原因，你据此改升级老板（别硬试）。',
        {
          runId: z.string().describe('被判空停的会话 runId（派工头里给了）'),
          message: z.string().describe('给它的续跑提示：点明它上轮没写正确收工标记、任务没到门；要续就接着干并写对标记（继续=【下一棒】自己｜下一步 / 到门=【等你拍板】最终验收（QA 全绿后）/ 老板亲测（约定迷糊不做 QA 的版本）/ 干完=【交回】），卡住就明确说'),
        },
        async ({ runId, message }) => {
          const target = runs[runId]
          if (!target) return { content: [{ type: 'text', text: `[续跑失败：找不到会话 ${runId}]` }] }
          if (target.employee === 'chaorenq') return { content: [{ type: 'text', text: '[续跑失败：不能续巡视员自己]' }] }
          if (target.status !== 'done') return { content: [{ type: 'text', text: `[续跑失败：会话 ${runId} 状态=${target.status}（非 done）——改升级老板]` }] }
          if (!target.sessionId) return { content: [{ type: 'text', text: `[续跑失败：会话 ${runId} 无 sessionId 无法 resume——改升级老板]` }] }
          const busy = busyRunFor(target.employee, laneKeyOf(target))
          if (busy) return { content: [{ type: 'text', text: `[续跑失败：${EMPLOYEES[target.employee]?.displayName || target.employee} 正在跑另一条会话 ${busy.id}——改升级老板]` }] }
          target._patrolNudges = (target._patrolNudges || 0) + 1
          run._patrolDidResume = true        // 本条巡视 run 已 resume 目标 → autoChain 收尾时别给目标盖「已裁决」签名（它将继续产出新停顿、值得重判）
          target.patrolClearedSig = null      // 目标被续跑，撤销旧裁决签名（它马上要做新活）
          const patrolName = EMPLOYEES.chaorenq?.displayName || '小呆呆'
          // G2：巡视续跑同样注入进度快照——不注的话它一样会「从头重来」，巡视就只是把浪费重放一遍。
          const nudge = stallGuard.renderResumeSnapshot(target._snapshots || (target.lastSnapshot ? [target.lastSnapshot] : []))
            + `【巡视续跑】${patrolName}巡查判定：你上一轮空停了（既没交接、也没待老板拍板，但任务还没干完就停了）。${message}`
          logConversation({ threadRootId: target.threadRootId || target.id, fromKind: 'employee', from: 'chaorenq', to: target.employee, toRunId: target.id, kind: 'call', text: message, depth: target.chainDepth || 0 })
          broadcast({ type: 'patrol-resume', from: 'chaorenq', to: target.employee, runId: target.id })
          sendToRun(target, nudge, { resume: true, kind: target.lastKind || 'dispatch' })
          return { content: [{ type: 'text', text: `[已续跑 ${EMPLOYEES[target.employee]?.displayName || target.employee} 的会话 ${runId}（第 ${target._patrolNudges} 次巡视续跑）。它会接着干，你可以收工了]` }] }
        },
      ),
    ],
  })
}

// 菲斯拉专属工具：只提交影子审计发现，不掌握 release/bounce 权力。
function makeAuditTools(run) {
  return createSdkMcpServer({
    name: 'audit',
    version: '0.1.0',
    tools: [
      tool(
        'submit_audit_findings',
        '提交影子 QA 陪练结果：只记录发现，不放行、不打回流水线。',
        {
          runId: z.string().describe('被审迷糊的 runId'),
          severity: z.string().describe('none / warning / critical'),
          findings: z.string().describe('检查范围；若有问题，写 facet/case、证伪证据和规则建议'),
        },
        async ({ runId, severity, findings }) => {
          const target = runs[runId]
          if (!target || target.employee !== 'mihu') return { content: [{ type: 'text', text: `[提交失败：${runId} 不是有效的迷糊会话]` }] }
          if (run.auditTarget && run.auditTarget !== runId) return { content: [{ type: 'text', text: `[提交失败：本陪练绑定的是 ${run.auditTarget}]` }] }
          const sev = ['none', 'warning', 'critical'].includes(String(severity).toLowerCase()) ? String(severity).toLowerCase() : 'warning'
          run.auditFindingsSubmitted = true
          saveRegistry()
          logConversation({ threadRootId: target.threadRootId || target.id, fromKind: 'employee', from: 'feisila', to: 'mihu', toRunId: target.id, kind: 'cc', text: `【影子陪练 ${sev}】${findings}`, depth: target.chainDepth || 0 })
          broadcast({ type: 'audit-findings', from: 'feisila', runId: target.id, severity: sev, text: `菲斯拉提交影子陪练结果：${sev}` })
          return { content: [{ type: 'text', text: `[影子陪练结果已记录；未改变 qa_passed，也未阻塞流水线。]` }] }
        },
      ),
    ],
  })
}

// ---------- 后端本地重编重启（GG Bond 专属；迷糊红线10 禁 build/restart，故不进全员共享）----------
// 缘起：开发每完成一阶段须重编+重启受影响后端服务，视觉初筛 / QA 才跑最新产物（血泪 run 20260727044513；SOP 已收此铁律）。
// 过去靠员工自己敲 `manage-backend.sh restart`，散、易漏、且是长命令（停→装共享模块→编译→起，分钟级）。
// 这里做成异步启动器：detached spawn 一条龙、立即返回构建 id，员工用 backend_status 轮询到终态 + 看新鲜度。
const BACKEND_DIR = path.join(ROOT, 'backend')
const MANAGE_BACKEND_SH = path.join(ROOT, 'manage-backend.sh')
const BACKEND_BUILDS_FILE = path.join(RUNS_DIR, 'backend-builds.json')
const BACKEND_SERVICES = { service: 8040, web: 8041, 'gys-web': 8042 }   // manage-backend.sh 本地只管这三个（partner-app-biz-usa 不在其列）；all = 三者
const BACKEND_LOG_DIR = path.join(ROOT, 'run', 'logs')
function loadBackendBuilds() { try { return JSON.parse(fs.readFileSync(BACKEND_BUILDS_FILE, 'utf8')) } catch { return [] } }
function saveBackendBuilds(list) { try { fs.writeFileSync(BACKEND_BUILDS_FILE, JSON.stringify(list.slice(-40), null, 2)) } catch { } }
// 解析可用的 bash：PowerShell 启动的 node 其 PATH 未必含 bash.exe（Git 只把 git.exe 放系统 PATH），
// 直接 spawn('bash') 会 ENOENT。优先探 Git Bash 常见落点，都不在再回退 'bash'（靠 PATH）。
function resolveBash() {
  if (process.platform === 'win32') {
    for (const c of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
      try { if (fs.existsSync(c)) return c } catch { }
    }
  }
  return 'bash'
}
// 异步跑 git（本地读操作；用 spawn 收集 stdout，不用 spawnSync 阻塞事件循环——fetch 可能几秒）
function runGit(args, cwd, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false
    let child
    try { child = spawn('git', args, { cwd }) }
    catch (e) { return resolve({ code: -1, out: '', err: String(e?.message || e) }) }
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill() } catch { }; resolve({ code: -1, out, err: err + '\n[timeout]' }) } }, timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e?.message || e) }) } })
    child.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }) } })
  })
}
async function backendHeadSha() {
  const r = await runGit(['rev-parse', '--short', 'HEAD'], BACKEND_DIR, 8000)
  return r.code === 0 ? r.out.trim() : ''
}
function makeBackendTools(run) {
  return createSdkMcpServer({
    name: 'backend',
    version: '0.1.0',
    tools: [
      tool(
        'rebuild_restart_backend',
        '按本次改动重新编译并重启受影响的后端服务（本地 dev 环境），让视觉初筛 / QA 跑最新产物。异步：立即返回构建 id，用 backend_status 轮询到终态。走项目根 manage-backend.sh restart（一条龙 停→装共享模块→重编→起，分钟级）。改了库模块(common/datasource/service-interface/external-service-interface)必须连带重启所有依赖它的服务——此时传 services:["all"]。这一步是「人工预检环境默认最新」不变式的落点，交预检前务必先跑。',
        {
          services: z.array(z.string()).describe('要重启的服务，取自：service(8040) / web(8041) / gys-web(8042) / all（=三者全部）。改库模块牵连下游时用 ["all"]'),
          reason: z.string().optional().describe('一句话：本次为什么重启（改了哪个模块/为哪个条目预检），记进构建台账'),
        },
        async ({ services, reason }) => {
          if (!fs.existsSync(MANAGE_BACKEND_SH)) return { content: [{ type: 'text', text: `[重启失败：找不到 ${MANAGE_BACKEND_SH}]` }] }
          const raw = Array.isArray(services) ? services.map(s => String(s).trim()).filter(Boolean) : []
          if (!raw.length) return { content: [{ type: 'text', text: '[重启失败：services 不能为空，给 service/web/gys-web 或 all]' }] }
          const valid = new Set([...Object.keys(BACKEND_SERVICES), 'all'])
          const bad = raw.filter(s => !valid.has(s))
          if (bad.length) return { content: [{ type: 'text', text: `[重启失败：无法识别的服务 ${bad.join(', ')}；只支持 ${[...valid].join(' / ')}]` }] }
          const svcs = raw.includes('all') ? ['all'] : [...new Set(raw)]
          const sha = await backendHeadSha()
          const id = 'bb' + Date.now().toString(36)
          try { fs.mkdirSync(BACKEND_LOG_DIR, { recursive: true }) } catch { }
          const logFile = path.join(BACKEND_LOG_DIR, `restart-${id}.out`)
          const doneFile = path.join(BACKEND_LOG_DIR, `restart-${id}.done`)
          // 用 bash 一条龙：restart 后把退出码写 .done（供 backend_status 判终态，跨平台、不依赖 PID 存活探测）。
          // PORT_KILL_CONFIRM=always：非交互 spawn 下不设会因端口占用起不来（脚本会等交互输入）。
          const shellCmd = `"${MANAGE_BACKEND_SH}" restart ${svcs.join(' ')} > "${logFile}" 2>&1; ec=$?; echo "$ec" > "${doneFile}"; exit $ec`
          let child
          try {
            child = spawn(resolveBash(), ['-lc', shellCmd], { cwd: ROOT, detached: true, stdio: 'ignore', env: { ...process.env, PORT_KILL_CONFIRM: 'always' } })
          } catch (e) {
            return { content: [{ type: 'text', text: `[重启启动失败：${String(e?.message || e)}（本机 bash 不可用？）]` }] }
          }
          const rec = { id, services: svcs, reason: String(reason || '').slice(0, 200), startedAt: new Date().toISOString(), status: 'running', logFile, doneFile, sha, pid: child.pid || null, byRun: run.id, employee: run.employee }
          const list = loadBackendBuilds(); list.push(rec); saveBackendBuilds(list)
          // ENOENT 等 spawn 失败是异步 error 事件（try/catch 抓不到）——落 failed，免得 backend_status 永远显示 running。
          child.on('error', (e) => {
            try { fs.appendFileSync(logFile, `\n[spawn error] ${String(e?.message || e)}\n`) } catch { }
            try { if (!fs.existsSync(doneFile)) fs.writeFileSync(doneFile, '127') } catch { }
            const l = loadBackendBuilds(); const rr = l.find(x => x.id === id); if (rr) { rr.status = 'failed'; rr.exitCode = '127'; rr.error = String(e?.message || e); saveBackendBuilds(l) }
            appendEvent(run.id, { type: 'lab', text: `❌ 后端重启启动失败（构建 ${id}）：${String(e?.message || e)}` })
            broadcast({ type: 'backend-build', runId: run.id, employee: run.employee, id, services: svcs, status: 'failed' })
          })
          child.unref()
          appendEvent(run.id, { type: 'lab', text: `🔧 已启动后端重编重启：${svcs.join(', ')}（构建 ${id}，后端 HEAD ${sha || '?'}）` })
          broadcast({ type: 'backend-build', runId: run.id, employee: run.employee, id, services: svcs, status: 'running' })
          return { content: [{ type: 'text', text: `[已异步启动重编重启：${svcs.join(', ')}（构建 id=${id}，后端 HEAD=${sha || '?'}）。这是分钟级操作——过一会用 backend_status({id:"${id}"}) 查是否跑完。日志：${logFile}。别在它跑完前就交迷糊。]` }] }
        },
      ),
      tool(
        'backend_status',
        '查后端本地服务的构建/重启进度与新鲜度：给 id 查某次重启是否跑完（读退出码 + 日志尾），不给 id 则汇总最近几次；并对比后端当前 HEAD 与上次成功构建的 sha，提示是否已「陈旧」（HEAD 变过=预检产物可能过时，需再 rebuild_restart_backend）。只读。',
        { id: z.string().optional().describe('某次 rebuild_restart_backend 返回的构建 id；不给=看最近几次汇总') },
        async ({ id }) => {
          const list = loadBackendBuilds()
          if (!list.length) return { content: [{ type: 'text', text: '[还没有任何后端构建记录。若刚改完后端，用 rebuild_restart_backend 起一次重启]' }] }
          const nowSha = await backendHeadSha()
          const fmt = (r) => {
            let st = r.status
            let tail = ''
            if (r.status === 'running' && r.doneFile && fs.existsSync(r.doneFile)) {
              const ec = (() => { try { return fs.readFileSync(r.doneFile, 'utf8').trim() } catch { return '' } })()
              st = ec === '0' ? 'done' : `failed(exit=${ec})`
              r.status = st.startsWith('failed') ? 'failed' : 'done'; r.exitCode = ec; r.finishedAt = new Date().toISOString()
            }
            if (r.logFile && fs.existsSync(r.logFile)) {
              try { const t = fs.readFileSync(r.logFile, 'utf8').split('\n').filter(Boolean).slice(-6).join('\n'); tail = t ? `\n   日志尾：${t.replace(/\n/g, '\n   ')}` : '' } catch { }
            }
            const stale = r.status === 'done' && nowSha && r.sha && nowSha !== r.sha
            return `- ${r.id}｜${(r.services || []).join(',')}｜${st}｜构建时后端 HEAD=${r.sha || '?'}${stale ? `（⚠ 已陈旧：当前 HEAD=${nowSha}，之后又有改动，被测产物可能过时，需再重启）` : ''}${r.reason ? `｜${r.reason}` : ''}${tail}`
          }
          let text
          if (id) {
            const r = list.find(x => x.id === id)
            if (!r) return { content: [{ type: 'text', text: `[找不到构建 id=${id}]` }] }
            text = fmt(r)
          } else {
            text = list.slice(-5).reverse().map(fmt).join('\n')
          }
          saveBackendBuilds(list)   // 落定刚判出的终态
          const anyRunning = list.some(r => r.status === 'running')
          return { content: [{ type: 'text', text: (id ? '' : '【后端构建/重启（最近）】\n') + text + (anyRunning ? '\n（仍有 running：稍后再查一次）' : '') + `\n当前后端 HEAD=${nowSha || '?'}` }] }
        },
      ),
    ],
  })
}

// ---------- 工作区（lane）：多需求并行 = 每条一组 worktree + 一个端口槽位（机制与缘起见 lanes.js 顶部）----------
// GG Bond 自管全套（建/起停/收）；老板经看板侧栏「工作区」面板（/api/lanes*）同样能管；QA/波比只挂只读的 lane_status。
// 懒建：MANAGE_BACKEND_SH / resolveBash 都在本段之上定义，但 manager 只在第一次用到时才造，免得模块求值顺序牵连。
let _laneMgr = null
function lanesMgr() {
  return _laneMgr ||= createLaneManager({
    workspaceRoot: ROOT, runsDir: RUNS_DIR, manageBackendSh: MANAGE_BACKEND_SH,
    manageFrontendPs1: path.join(ROOT, 'manage-frontend.ps1'), resolveBash,
    onChange: () => broadcast({ type: 'lanes-changed' }),
  })
}
// 状态缓存保温：【运行环境】块在 startRun 里**同步**拼（createDispatchRun 十余处同步调用点，不能 await），
// 只能读 manager 的缓存——这里每分钟异步刷一次（仅在登记了工作区时；探活是本机 TCP connect + 两条 git，很便宜）。
setTimeout(() => { try { lanesMgr().status().catch(() => { }) } catch { } }, 5000).unref?.()
setInterval(() => { try { lanesMgr().status().catch(() => { }) } catch { } }, 60_000).unref?.()
// 2026-09-28 扩到全员（巡视员除外——它不接业务活）：老板要「员工能知道当前聊天有没有指定运行环境，没有就能用 lab 工具查有哪些环境」。
// 写权限（lane_create/up/down/…）仍只给 GG Bond，见 makeLaneTools。
const LANE_TOOL_READERS = new Set(['ggbond', 'mihu', 'feisila', 'bobby', 'feifei'])
// 只有巡视员即使在不同工作区也串行：它的 sweep 不分 lane。
// 其余员工在**不同**工作区可各开一条可写会话——worktree 已把「同一工作树互相踩写」（§3.49）从根上隔开。
// ⚠ 2026-09-29 起两位 QA（迷糊、菲斯拉）也按工作区并行（老板：「增加了多运行环境，却忘记让迷糊支持处理多任务多环境，
//   现在任务都落在迷糊那里」——实况：Temu 与 v6.0.0 两个环境的 8 条活排成一队等她一个人）。原先串行的理由是「两位 QA 共用
//   单实例的猪猪桌面 App」，**那条理由已被猪猪自己消掉**：v1.1 起 App-run 第二个提交不再 409、进 App 内队列按序消化；
//   headless（/test-sessions、run_e2e_batch）本就并发；v1.3 起还有 /app-runs/batch 多浏览器并行（见对接文档）。
//   两条迷糊会话同时提 App-run，猪猪会自己排队，不会互相踩。各会话的【运行环境】块告诉她测哪个端口。
const LANE_SERIAL_EMPLOYEES = new Set(['chaorenq'])
// 一条 run 属于哪个工作区：显式绑定（从面板开会话 / 派工传 lane）> 任务档案绑定 > 主检出
// 工作区是否还登记着（main 恒在；读不到登记表时按「在」算，不因读盘失败把会话挪出工作区）
function laneLive(id, lanes) {
  if (!id || id === MAIN_LANE_ID) return true
  try { return (lanes || lanesMgr().load()).some(l => l.id === id) } catch { return true }
}
function laneKeyOf(run) {
  if (!run) return MAIN_LANE_ID
  try {
    const lanes = lanesMgr().load()
    if (run.lane && laneLive(run.lane, lanes)) return run.lane
    return laneForTask(lanes, run.taskFile)?.id || MAIN_LANE_ID   // run.lane 已收掉 → 同无 lane 口径，别按一个不存在的环境判并发
  } catch { return run.lane || MAIN_LANE_ID }
}
// 新 run 的 lane：显式 > 委托者继承 > 任务档案绑定；都没有 = 不写字段（主检出，现状不变）
// 2026-10-14：显式/继承来的 lane 已被收掉时不再照抄（原先委托者的 lane 不校验就继承）——回落档案绑定/主检出，
// 并把旧 id 记进 out.stale，由 createDispatchRun 当场告警。v6.1.0 那条线就是 v600 收掉后一路静默掉进主检出，
// 跟 0.1.5 跟单抢了迷糊的并发闸，谁也没察觉。
function laneForNewRun({ lane, caller, taskFile }, out) {
  let lanes
  try { lanes = lanesMgr().load() } catch { return lane || caller?.lane || undefined }
  if (lane === MAIN_LANE_ID) return MAIN_LANE_ID
  if (lane && laneLive(lane, lanes)) return lane
  if (caller?.lane && laneLive(caller.lane, lanes)) return caller.lane
  const stale = [lane, caller?.lane].find(x => x && !laneLive(x, lanes))
  if (stale && out) out.stale = stale
  return laneForTask(lanes, taskFile)?.id || undefined
}
// 注入会话系统提示的【运行环境】块——**每条会话都注**（含没登记任何工作区时）：明说「本会话绑定了哪个环境 / 未指定」，
// 未指定时指引它用 lane_status 自查。独立 clone 形态下工作区根没有这几个仓（主检出 repos 为空）才不注。
function laneBlockFor(run) {
  if (!LANE_TOOL_READERS.has(run.employee)) return ''
  try {
    const mgr = lanesMgr()
    const lanes = mgr.load()
    const main = mgr.get(MAIN_LANE_ID)
    if (!lanes.length && !Object.keys(main.repos || {}).length) return ''
    const key = laneKeyOf(run)
    const staleNote = run._laneStale ? `⚠ 交给你这条活的会话原本在运行环境 \`${run._laneStale}\`，那个环境已经收掉了，本会话改按下面这个环境跑。若这条线其实属于另一个环境（比如已拆出新版本、另开了工作区），先用 bind_task_file 改挂到那个环境绑定的档案再动手。\n\n` : ''
    if (key !== MAIN_LANE_ID) {
      const lane = lanes.find(l => l.id === key)
      return lane ? staleNote + renderLaneBlock(lane, { employee: run.employee, status: mgr.cached(lane.id) }) : ''
    }
    return staleNote + renderLaneBlock(main, { employee: run.employee, status: mgr.cached(MAIN_LANE_ID), others: lanes, bound: run.lane === MAIN_LANE_ID })
  } catch { return '' }
}
// 把一条会话绑到任务档案，并顺带认领该档案的运行环境（会话还没显式绑环境时）。
// 2026-10-06 老板：「直接跟员工聊天的话员工不会匹配运行环境，但是好像知道聊的是什么任务档案」——
// 直接开的聊天不挂档案 → 没有 lane；员工从对话里推断出了档案却无处登记，于是会话卡上没有环境徽标、代码也可能落在主检出。
// 两个入口共用：老板在会话里回话时附档案（/reply）、员工自己确认后调 bind_task_file。
// 返回 { ok, taskFile, lane, laneNote } ；lane = 认领到的工作区对象（没有对应环境 / 已显式绑了别的环境时为 null）。
// 2026-10-14 改挂（switch）：会话已挂 A 档案、改挂 B 档案＝这条线转到了另一个版本（v6.1.0 从 v6.0.0 档案上拆出来那次），
// 原环境跟着旧版本走、不再保留——B 有登记环境就认 B 的，没有就去掉旧环境回主检出；只有「同一份档案重绑」才尊重显式环境。
// 原先改挂被挡死（只能老板重选），菲菲拆出新档案后没法把线挪过去，37 条会话一路继承旧档案。
function bindRunToTask(run, taskFileRaw, { by = '', reason = '' } = {}) {
  const n = normTaskFile(taskFileRaw)
  if (!n) return { ok: false, error: '档案路径为空' }
  const rel = `office-lab/${n}`
  try { if (!fs.statSync(safeResolve(rel)).isFile()) throw new Error() } catch { return { ok: false, error: `找不到档案 ${rel}` } }
  const prev = run.taskFile || null
  const switching = !!prev && normTaskFile(prev) !== n
  run.taskFile = rel
  delete run._laneStale   // 重新绑过档案，【运行环境】块里那句「来源环境已收掉」不再适用
  let lane = null, laneNote = ''
  try {
    const lanes = lanesMgr().load()
    const hit = laneForTask(lanes, rel)
    const curLive = run.lane && laneLive(run.lane, lanes)
    if (!hit) {
      laneNote = '这份档案没有登记专属运行环境（按主检出）'
      if (run.lane && (switching || !curLive)) { laneNote += `；原运行环境 \`${run.lane}\` 已不再适用，已去掉`; delete run.lane }
    } else if (run.lane && curLive && run.lane !== hit.id && !switching) laneNote = `本会话已显式绑定运行环境 \`${run.lane}\`，与档案的环境 \`${hit.id}\` 不同——保持原绑定，没改`
    else { run.lane = hit.id; lane = hit }
  } catch { }
  saveRegistry()
  if (prev !== rel || lane) appendEvent(run.id, { type: 'lab', text: `📎 ${by ? `${by} ` : ''}把本会话${switching ? `从 \`${prev}\` 改挂` : '绑'}到任务档案 \`${rel}\`${lane ? `，运行环境 → \`${lane.id}\`` : ''}${laneNote ? `（${laneNote}）` : ''}${reason ? `。原因：${reason}` : ''}` })
  return { ok: true, taskFile: rel, prev, switching, lane, laneNote }
}
// 工作区绑定的档案 ≠ 当前会话挂的档案：绑定对这条线落空（后续交接按会话的档案找环境，找不到就进主检出）。
// lane_create / lane_update 绑档案时当场提醒——v610 就是 GG Bond 绑了 REQ-0392 档案、而整条线挂着 v6.0.0 档案。
function laneArchiveMismatchHint(run, laneId, taskFile) {
  if (!taskFile || !run.taskFile || normTaskFile(taskFile) === normTaskFile(run.taskFile)) return ''
  return `\n\n⚠ **绑定会落空**：工作区 ${laneId} 绑的是 ${taskFile}，而你这条会话（连同它往下的交棒/抄送）挂的是 ${run.taskFile}——引擎按会话挂的档案找环境，这条线后续的会话**不会**进 ${laneId}。如果你现在做的就是这个工作区的版本，立刻调 bind_task_file({taskFile:"${taskFile}", reason:"…"}) 把本会话改挂过去，再往下交棒。`
}
function formatLaneStatus(s) {
  const L = [`- **${s.name || s.id}**（id ${s.id}${s.version ? ` · ${s.version}` : ''}）｜槽位 ${s.slot}${s.taskFile ? `｜档案 ${s.taskFile}` : ''}`]
  for (const [k, r] of Object.entries(s.repos || {})) {
    const p = String(r.path || '').replace(/\\/g, '/')
    L.push(r.exists === false
      ? `  · ${LANE_REPOS[k]?.label || k}：⚠ 工作树不存在（${p}）`
      : `  · ${LANE_REPOS[k]?.label || k}：\`${p}\` 分支 \`${r.branch || '?'}\` @${r.head || '?'}${r.dirty ? ` · 已跟踪文件未提交 ${r.dirty} 处` : ''}${r.untracked ? ` · 未跟踪文件 ${r.untracked} 个（${(r.untrackedList || []).join('、')}${r.untracked > (r.untrackedList || []).length ? '…' : ''}）` : ''}${r.ahead ? ` · 未推 ${r.ahead}` : ''}${r.error ? ` · ${r.error}` : ''}`)
  }
  const svc = Object.entries(s.services || {}).map(([k, v]) => `${LANE_SERVICES[k]?.label || k} ${LANE_SERVICES[k]?.kind === 'fe' ? `http://localhost:${v.port}` : ':' + v.port} ${v.alive ? '●' : '○'}`)
  if (svc.length) L.push(`  · 服务（● 在监听 ○ 未起）：${svc.join(' ｜ ')}`)
  if (s.backend) {
    const b = s.backend
    L.push(`  · 后端构建：${b.stale ? `⚠ **陈旧**（上次成功 lane_up 构建于 ${b.builtSha}，当前 HEAD ${b.headSha}）` : b.unknown ? `未知（服务在跑，但没有经 lane_up 构建的记录——不确定跑的是哪个提交）` : b.builtSha ? `新鲜（构建于 ${b.builtSha}）` : '尚未经 lane_up 构建'}`)
  }
  if (s.op) L.push(`  · 进行中：${s.op.id} ${s.op.action} ${s.op.targets.join(',')}（running）`)
  else if (s.lastOp) L.push(`  · 上次操作：${s.lastOp.id} ${s.lastOp.action} ${s.lastOp.targets.join(',')} → ${s.lastOp.status}`)
  return L.join('\n')
}
function formatLaneOp(op) {
  const L = [`【工作区操作 ${op.id}】${op.lane} · ${op.action} ${op.targets.join(',')} · ${op.status}${op.finishedAt ? `（结束于 ${op.finishedAt}）` : ''}`]
  for (const p of op.parts || []) L.push(`- ${p.group}：${p.exitCode == null ? '进行中' : p.exitCode === '0' ? '✓ 成功' : `✗ 失败(exit=${p.exitCode})`}｜日志 ${p.logFile}${p.tail ? `\n   ${p.tail.replace(/\n/g, '\n   ')}` : ''}`)
  if (op.status === 'running') L.push('（分钟级：后端 = 停→编→起；稍后再 lane_status({op}) 查一次，别在跑完前交迷糊）')
  return L.join('\n')
}
const laneText = (text) => ({ content: [{ type: 'text', text }] })
function makeLaneTools(run) {
  const writer = run.employee === 'ggbond'
  const tools = [
    tool(
      'lane_status',
      '查并行工作区（lane）的运行情况：每个工作区（含主检出 main）的 worktree 路径/分支/HEAD/未提交、各服务端口是否在监听、后端构建是否陈旧、进行中的起停操作。给 op=查某次 lane_up/lane_down 的进度与日志尾。只读。',
      {
        lane: z.string().optional().describe('工作区 id；不给=全部（含 main）'),
        op: z.string().optional().describe('lane_up/lane_down 返回的操作 id'),
      },
      async ({ lane, op }) => {
        if (op) { const o = lanesMgr().opStatus(op); return laneText(o ? formatLaneOp(o) : `[找不到操作 ${op}]`) }
        const st = await lanesMgr().status(lane || undefined, { fresh: true })   // 员工要现值（判后端陈旧），不吃面板缓存
        if (!st.length) return laneText(`[没有工作区 ${lane}]`)
        return laneText(`【工作区】端口槽位规则：slot k 的前端 = 8000/8001 + 2k，后端 = 8040/8041/8042 + 10000k\n${st.map(formatLaneStatus).join('\n')}`)
      },
    ),
    tool(
      'bind_task_file',
      '把**本会话**绑到一份任务档案，并自动认领该档案登记的运行环境（工作区）。两种时机：① 老板直接开的聊天没挂档案，聊下来已经确认在说哪份档案（版本），**动手改代码 / 查环境之前**先绑上；② **改挂**：本会话已挂 A 档案，但这条线已经转到 B 档案（典型：需求拆成了新版本、另建了新档案）——**交棒/抄送之前**改挂过去，必须带 reason。绑/改挂之后会话卡显示环境、代码落对工作树、往下的交棒/抄送自动带上新档案和它的环境（不改挂的话下游会一路继承旧档案）。拿不准是哪份就先问老板，别猜着绑。',
      {
        taskFile: z.string().describe('任务档案路径，如 office-lab/tasks/2026-09-24-项目跟踪-v0.1.3.md（tasks/ 下的版本档案）'),
        reason: z.string().optional().describe('改挂（本会话已挂别的档案）时必填：为什么换，如「REQ-0392 已拆成 v6.1.0，新档案在此」'),
      },
      async ({ taskFile, reason }) => {
        if (run.taskFile && normTaskFile(run.taskFile) !== normTaskFile(taskFile) && !String(reason || '').trim())
          return laneText(`[没有改挂：本会话已挂档案 ${run.taskFile}。确认这条线已经转到 ${taskFile}（如拆出了新版本）就带上 reason 再调一次；拿不准先问老板]`)
        const r = bindRunToTask(run, taskFile, { by: EMPLOYEES[run.employee]?.displayName || run.employee, reason: String(reason || '').trim() })
        if (!r.ok) return laneText(`[绑定失败：${r.error}]`)
        const busy = r.lane && [...liveRuns.values()].find(x => x !== run && x.employee === run.employee && !isConsult(x) && laneKeyOf(x) === r.lane.id && (x.status === 'running' || x.status === 'starting'))
        const switchNote = r.switching ? `\n已从 ${r.prev} 改挂。你往下的交棒/抄送会带上新档案；同一条线上**已经在跑**的同事会话不受影响——交给他们时在指令里点明新档案路径。` : ''
        return laneText(`[已绑定档案 ${r.taskFile}${r.lane ? `，运行环境 → ${r.lane.id}` : ''}]${r.laneNote ? `\n${r.laneNote}` : ''}${switchNote}${busy ? `\n⚠ 你在这个环境还有一条会话 ${busy.id} 正在跑——两条会话别同时改同一棵工作树，先等它收工。` : ''}\n\n${r.lane ? '从现在起按下面这个环境干活（覆盖系统提示里「未指定」那段）：\n\n' + laneBlockFor(run) : ''}`)
      },
    ),
  ]
  if (writer) tools.push(
    tool(
      'lane_create',
      '为一条需求/版本开并行工作区：按 repos 在 <工作区根>/.worktrees/<id>-{be,fe,fecj,iwo,cc} 建 git worktree（绝对路径；新分支从 origin/<base> 切且 --no-track；该分支已在别的工作树上检出则直接认领那棵），供应商前端 node_modules 以 junction 复用主检出（独立站工程 / 组件中心不复用，首次 lane_up 自己 install）、GYS 前端写 .umirc.local.ts 把 dev 代理指向本槽位 gys-web，并分配端口槽位。**主检出正被别的版本占着（人工预检/开发中）时，新需求一律开工作区，别切主检出分支。**同步返回（可能要几十秒）。',
      {
        id: z.string().describe('工作区 id（小写字母/数字/连字符，如 temu、follow-0-1-3），做目录名与端口登记键'),
        repos: z.array(z.enum(['backend', 'fe-supplier', 'fe-cj', 'iwo', 'fe-cc'])).describe('要开的仓：backend=backend，fe-supplier=frontend/web-app（GYS），fe-cj=frontend/partner-app，iwo=auxiliary-web-workspace（auxiliary-api 后端 + 跨境管理中台 10025 外壳），fe-cc=frontend/component-center（组件中心，页面作为子应用嵌进跨境管理中台）'),
        branch: z.string().optional().describe('分支名；不给则按 version+feature 生成 feature/<version>-<feature>-lab。前后端同名分支'),
        version: z.string().optional().describe('版本号，如 v0.1.0'),
        feature: z.string().optional().describe('功能短名（进分支名）'),
        title: z.string().optional().describe('面板上显示的需求名'),
        taskFile: z.string().optional().describe('绑定的任务档案（如 office-lab/tasks/xxx.md）——绑了之后该档案的派工/交接会自动进这个工作区'),
        base: z.string().optional().describe('新分支的基线，默认 release'),
        slot: z.number().int().optional().describe('显式端口槽位 1~3。认领一个**已经在旁路端口上跑着**的手工实例时用（如 Temu 在 8002/18042 → slot 1）；不给则取未占用的最小槽位'),
      },
      async (a) => {
        const r = await lanesMgr().create({ ...a, id: a.id, repos: a.repos, by: run.employee })
        if (!r.ok) return laneText(`[建工作区失败：${r.error}]${r.log?.length ? '\n' + r.log.join('\n') : ''}`)
        appendEvent(run.id, { type: 'lab', text: `🌿 已开工作区 \`${r.lane.id}\`（槽位 ${r.lane.slot}）：${Object.values(r.lane.repos).map(x => x.path).join('、')}` })
        return laneText(`[工作区 ${r.lane.id} 已就绪，槽位 ${r.lane.slot}]\n${r.log.join('\n')}\n端口：${Object.entries(LANE_SERVICES).filter(([, sv]) => r.lane.repos[sv.repo]).map(([k, sv]) => `${sv.label} ${r.ports[k]}`).join(' / ')}\n下一步：代码改在上面的工作树里；要跑起来用 lane_up({lane:"${r.lane.id}"})。${r.lane.taskFile ? '' : '\n提示：没绑任务档案——用 lane_update 绑上，后续派工/交接才会自动带上这个工作区。'}${laneArchiveMismatchHint(run, r.lane.id, r.lane.taskFile)}`)
      },
    ),
    tool(
      'lane_up',
      '（重）编译并（重）启工作区里的服务，让视觉初筛/QA 跑最新产物。异步：立即返回操作 id，用 lane_status({op}) 轮询到终态。供应商后端走 manage-backend.sh restart（旁路槽位自动：端口平移、xxl executor 平移且不注册调度中心、服务间 server-url 指向本槽位、聚合 pom -pl -am package 不 install 进 ~/.m2），供应商前端走 manage-frontend.ps1 restart（worktree 目录 + 本槽位端口）；独立站工程 cba=auxiliary-api（JDK17 package → java -jar，local profile，端口 8097+10000×槽位）、kjglzt=跨境管理中台（umi dev，UMI_ENV=dev，登录入口，/api 代理到本槽位 cba）、cc=组件中心（umi dev，端口固定 8899，同一时间只能一个工作区起）。改了库模块（common/datasource/service-interface）就把依赖它的服务都带上。',
      {
        lane: z.string().describe('工作区 id；主检出用 main'),
        targets: z.array(z.string()).optional().describe('fe-supplier / fe-cj / service / web / gys-web / cba / kjglzt / cc / all；不给=按工作区里的仓给默认（供应商：前端 + service + 对应的 gys-web/web；独立站：cba + kjglzt + cc）'),
      },
      async ({ lane, targets }) => {
        const r = await lanesMgr().runOp(lane, { action: 'up', targets, by: run.employee })
        if (!r.ok) return laneText(`[lane_up 失败：${r.error}]`)
        appendEvent(run.id, { type: 'lab', text: `🔧 工作区 \`${lane}\` 重编重启：${r.op.targets.join(', ')}（操作 ${r.op.id}）` })
        return laneText(`[已异步启动：${lane} · ${r.op.targets.join(', ')}（操作 id=${r.op.id}）。分钟级——稍后 lane_status({op:"${r.op.id}"}) 查终态与日志尾；跑完前别交迷糊。]`)
      },
    ),
    tool(
      'lane_down',
      '停掉工作区里的服务（释放内存/端口）。异步，返回操作 id。收工作区（lane_remove）前必须先停干净。',
      {
        lane: z.string().describe('工作区 id；主检出用 main'),
        targets: z.array(z.string()).optional().describe('同 lane_up；不给=工作区全部服务'),
      },
      async ({ lane, targets }) => {
        const r = await lanesMgr().runOp(lane, { action: 'down', targets: targets?.length ? targets : ['all'], by: run.employee })
        if (!r.ok) return laneText(`[lane_down 失败：${r.error}]`)
        return laneText(`[已异步停止：${lane} · ${r.op.targets.join(', ')}（操作 id=${r.op.id}）]`)
      },
    ),
    tool(
      'lane_update',
      '改工作区的登记信息：绑定/换绑任务档案、改显示名/版本号、起服务时追加的环境变量（env，只作用于独立站工程的 cba/kjglzt/cc，如 {TEMU_ENROLL_STUB_ENABLED:"true"} 开测试桩；值给空串=删除；下次 lane_up 生效）。不动 worktree 与进程。',
      {
        lane: z.string(),
        taskFile: z.string().optional(), title: z.string().optional(), version: z.string().optional(),
        env: z.record(z.string()).optional(),
      },
      async ({ lane, ...patch }) => {
        const r = lanesMgr().update(lane, patch)
        return laneText(r.ok ? `[已更新工作区 ${lane}：${JSON.stringify(patch)}]${laneArchiveMismatchHint(run, lane, patch.taskFile)}` : `[更新失败：${r.error}]`)
      },
    ),
    tool(
      'lane_remove',
      '收掉工作区：先确认服务已停（lane_down）、每棵树无未提交改动且提交都已推到远端，再拆 node_modules junction、git worktree remove（不 force）并注销登记。**分支永远保留**（它是交付物，MR 合完由波比建议清理）。keepWorktrees=true 只从看板注销、树原样保留。版本上线收尾后再收，别在 QA/发布期间收。',
      {
        lane: z.string(),
        keepWorktrees: z.boolean().optional(),
      },
      async ({ lane, keepWorktrees }) => {
        const r = await lanesMgr().remove(lane, { keepWorktrees: !!keepWorktrees })
        if (!r.ok) return laneText(`[收工作区失败：${r.error}]${r.log?.length ? '\n' + r.log.join('\n') : ''}`)
        appendEvent(run.id, { type: 'lab', text: `🍂 已收工作区 \`${lane}\`` })
        return laneText(`[已收工作区 ${lane}]\n${r.log.join('\n')}`)
      },
    ),
  )
  return createSdkMcpServer({ name: 'lanes', version: '0.1.0', tools })
}

// ---------- 发布前仓库枚举（波比专属，只读）----------
// 缘起：发布前必须逐仓 `git rev-list --count origin/<目标>..HEAD` 枚举，禁止只发"明显改了的那个"（CLAUDE.md 发布铁律）；
// 后端库模块改动要连带重发下游服务（模块→服务映射）。过去靠波比手敲、易漏一个前端仓或漏判连带。
// ---------- UI 状态契约：引擎侧自动刷新 + 变更注入（取代 CI，老板 2026-08-21 定「不做 CI」） ----------
// 为什么放在引擎而不是 CI：CI 只会告诉**前端开发**"契约变了"，而他本来就知道（他就是改的人）；
// 真正需要这条信息的是下游写用例的迷糊。引擎在流水线上算 diff 并注入她的系统提示，比 CI 更贴。
// 为什么在 GG Bond 收工时刷新、而不是派工迷糊时：① 他是唯一会改前端的员工，且流水线顺序是
// GG Bond →（视觉初筛）→ 迷糊，所以到她开工时契约必然已是最新；② 这样**不必在任何派工路径上 await**
// （createDispatchRun 有十余处同步调用点），注入侧保持同步读缓存，零事件循环阻塞。抽取器实测 ~650ms。
const UI_CONTRACT_SCRIPT = process.env.OFFICE_LAB_UI_CONTRACT_SCRIPT || path.join(ROOT, 'frontend', 'web-app', 'scripts', 'extract-ui-contract.js')
const UI_CONTRACT_ARTIFACT = process.env.OFFICE_LAB_UI_CONTRACT_ARTIFACT || path.join(ROOT, 'docs', '示例项目需求', '00-通用资料', '示例项目-UI状态契约.json')
const UI_CONTRACT_STATE = path.join(RUNS_DIR, 'ui-contract-state.json')
const UI_CONTRACT_DEBOUNCE_MS = 5 * 60_000        // 同一原因反复触发时的最小间隔（防收工风暴里连刷）
const UI_CONTRACT_EMPLOYEES = new Set(['mihu', 'feisila'])   // 只注给两位 QA（写用例的人）
let _uiContractBlock = ''                          // 缓存块：startRun 同步取用
let _uiContractLastRun = 0

// 同步取注入块（与 buildZhuzhuBlock 同款契约：非目标员工返回 '' 无副作用）
function uiContractBlock(employee) {
  if (!UI_CONTRACT_EMPLOYEES.has(employee) || !_uiContractBlock) return ''
  return '\n\n' + _uiContractBlock + '\n'
}

// 异步刷新（fire-and-forget，绝不 await、绝不抛）：跑抽取器 → 读产物 → 与上次快照 diff → 更新缓存块
function refreshUiContract(reason = 'manual', { force = false } = {}) {
  if (!force && Date.now() - _uiContractLastRun < UI_CONTRACT_DEBOUNCE_MS) return
  _uiContractLastRun = Date.now()
  if (!fs.existsSync(UI_CONTRACT_SCRIPT)) return    // 前端仓不在本机（如只跑 office-lab）→ 静默跳过
  execFile(process.execPath, [UI_CONTRACT_SCRIPT], { cwd: path.dirname(UI_CONTRACT_SCRIPT), timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
    const error = err ? String(stderr || err.message || err).slice(0, 300) : null
    let idx = null
    try { idx = indexUiContract(JSON.parse(fs.readFileSync(UI_CONTRACT_ARTIFACT, 'utf8'))) } catch (e) {
      _uiContractBlock = formatUiContractBlock({ error: error || `产物读取失败：${e?.message || e}`, artifactPath: path.relative(ROOT, UI_CONTRACT_ARTIFACT).replace(/\\/g, '/') })
      return
    }
    let prev = null
    try { prev = JSON.parse(fs.readFileSync(UI_CONTRACT_STATE, 'utf8')) } catch { }
    const diff = diffUiContracts(prev, idx)
    _uiContractBlock = formatUiContractBlock({
      diff, meta: idx.meta, error,
      refreshedAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      artifactPath: path.relative(ROOT, UI_CONTRACT_ARTIFACT).replace(/\\/g, '/'),
    })
    try { fs.writeFileSync(UI_CONTRACT_STATE, JSON.stringify(idx), 'utf8') } catch { }
    const n = diff.firstRun ? 0 : diff.added.length + diff.removed.length + diff.changed.length
    console.log(`[ui-contract] 刷新(${reason})：${idx.meta.withCondition}/${idx.meta.total} 有条件${diff.firstRun ? '，首次建立基线' : `，变更 ${n} 处`}${error ? `（抽取器报错：${error.slice(0, 80)}）` : ''}`)
    if (n) broadcast({ type: 'ui-contract-changed', count: n, added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length })
  })
}

// ---------- QA 专属：E2E 批次（并发甩批 + 引擎唤起 + 自动附 repair-context） ----------
// 缘起（复盘 §3.93）：迷糊的正确姿势「headless 迭代 / 别前台死等 / 并发甩批」工牌里早有，却被反复违反
// （run 20260821041830-ad60b6：17 会话全串行 68.3min、前台 sleep 36 次 60.4min、`ls -1dt` 猜目录 24 次、
//  45min 思考里 13.7min 在手工翻 summary）。按 §3.78 的教训——SOP 是软约束、**工具才是硬约束**——把姿势做成契约：
// 提交即返回（她没有前台 sleep 的机会）→ 引擎并发跑 → 全部 settle 后引擎唤起她，**红的自动带 repair-context 摘要**。
// 纯逻辑在 e2e-batch.js（可单测），这里只接线：后台可见性(_bgTasks) + 巡视豁免(_e2eBatchLive) + 唤起注入。
const zhuzhuBaseUrl = (cfg = zhuzhuConfig) => String(cfg.baseUrl || '').trim().replace(/\/+$/, '')
// 猪猪 v1.5 能力调用的公共入参（基地址 + 写 token + 端点覆盖）。所有调用点走这一个函数，
// 免得「有的带了 token、有的忘了」这类不对称——v1.5 切鉴权那天会一次性暴露成一半 401。
const zzOpts = (extra = {}) => ({ baseUrl: zhuzhuBaseUrl(), token: zhuzhuConfig.writeToken, pathOverrides: zhuzhuConfig.capabilityPaths, ...extra })

// ---------- 猪猪基地址健康缓存（复盘 §3.106）----------
// 缘起：run 20260826094846-95a6e0 里 `runs/zhuzhu-config.json` 存的是**已死的 32148**（v1.2.1 时代的 MCP
// 端口），活的 App 在 32147。MCP 挂载地址由这个 base 拼（见 startRun 的 empMcp['zhuzhu']），于是员工侧
// **18 个 mcp__zhuzhu__* 工具静默全部缺失**——她够不到 get_auth_status / preflight / bootstrap_auth_profile，
// 只能拿 Playwright 手搓登录诊断，最终判「登录必须人工介入」空转 14 小时。
// 而工牌里那句「工具不可见＝多半是 App 没启动」把她**指向了错误的分支**（App 当时就在跑）。
// 对策：开机 + 巡视 sweep 各探一次（fire-and-forget、5min 防抖），把结果缓存；注入侧同步读缓存，
// base 不通就在她眼前**显式标红并给出实际在监听的候选端口**——不再让「配置漂移」伪装成「App 没起」。
// fail-soft：探不通只影响提示措辞，绝不挡派工（§3.78：无人值守流程慎用硬 fail-closed）。
let zhuzhuHealth = { checkedAt: 0, base: '', reachable: null, why: '', aliveCandidates: [] }
const ZHUZHU_HEALTH_TTL_MS = 5 * 60 * 1000
async function probeZhuzhuBase(base, docPath, timeoutMs = 4000) {
  if (!base) return false
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(base.replace(/\/+$/, '') + (docPath || '/external-integration-documents'), { signal: ac.signal })
    return res.ok
  } catch { return false } finally { clearTimeout(t) }
}
async function refreshZhuzhuHealth(reason = 'manual', { force = false } = {}) {
  try {
    if (!zhuzhuConfig.enabled) return
    const now = Date.now()
    if (!force && now - zhuzhuHealth.checkedAt < ZHUZHU_HEALTH_TTL_MS) return
    zhuzhuHealth.checkedAt = now
    const base = zhuzhuBaseUrl(), docPath = zhuzhuConfig.docPath || '/external-integration-documents'
    zhuzhuHealth.base = base
    const ok = await probeZhuzhuBase(base, docPath)
    zhuzhuHealth.reachable = ok
    zhuzhuHealth.why = ok ? '' : `${base}${docPath} 探活失败`
    zhuzhuHealth.aliveCandidates = []
    if (!ok && base) {
      // 只在同一 host 上试几个历史/常见端口——够治「端口漂移」，又不做端口扫描（慢且平台相关）。
      let host = ''
      try { host = new URL(base).hostname } catch { host = '' }
      if (host) {
        for (const port of [32147, 32148, 32146]) {
          const cand = `http://${host}:${port}`
          if (cand === base) continue
          if (await probeZhuzhuBase(cand, docPath, 2500)) zhuzhuHealth.aliveCandidates.push(cand)
        }
      }
    }
    if (!ok) console.warn(`[zhuzhu-health] 基地址不通(${reason})：${base}${zhuzhuHealth.aliveCandidates.length ? ` —— 实际在监听：${zhuzhuHealth.aliveCandidates.join(' / ')}` : ''}`)
  } catch (e) { /* fail-soft：健康探测本身绝不影响主流程 */ }
}
// ---------- 全机 headless 槽位（2026-09-30 00:43 事故）----------
// 两个运行环境各一条迷糊会话、各甩一批并发 3 的 headless，叠上两套 Java 后端 + 两个前端 dev server + 猪猪渲染进程，
// 整机提交内存耗尽：chrome-headless-shell 先 OOM（0xE0000008），3 秒后引擎也被系统掐死（0xC0000409），两条守航会话一起断。
// 单批的 concurrency 只管自己这一批；跨会话的总数由这里统一发号，并按空闲物理内存降档（紧张时退到一次一个）。
const E2E_GLOBAL_MAX = Math.max(1, Number(process.env.OFFICE_LAB_E2E_GLOBAL_MAX || 3))
const E2E_LOW_MEM_GB = Number(process.env.OFFICE_LAB_E2E_LOW_MEM_GB || 4)
let _e2eActive = 0
const _e2eWaiters = []
function e2eSlotLimit() { return os.freemem() / 1024 ** 3 < E2E_LOW_MEM_GB ? 1 : E2E_GLOBAL_MAX }
function acquireE2eSlot(run, batchId) {
  return new Promise(resolve => {
    let noted = false
    const tryTake = () => {
      if (_e2eActive < e2eSlotLimit()) {
        _e2eActive++
        let released = false
        resolve(() => { if (released) return; released = true; _e2eActive = Math.max(0, _e2eActive - 1); const w = _e2eWaiters.shift(); if (w) setTimeout(w, 0) })
        return
      }
      if (!noted && run) { noted = true; appendEvent(run.id, { type: 'lab', text: `⏳ [${batchId}] 全机 headless 槽位已满（在跑 ${_e2eActive} / 上限 ${e2eSlotLimit()}，空闲内存 ${(os.freemem() / 1024 ** 3).toFixed(1)}GB），排队等空位——另一个运行环境的测试在跑，这是正常的` }) }
      _e2eWaiters.push(tryTake)
      setTimeout(() => { const i = _e2eWaiters.indexOf(tryTake); if (i >= 0) { _e2eWaiters.splice(i, 1); tryTake() } }, 15_000)   // 内存回升 / 漏唤醒兜底
    }
    tryTake()
  })
}
function makeE2eTools(run) {
  return createSdkMcpServer({
    name: 'e2e',
    version: '0.1.0',
    tools: [
      tool(
        'run_e2e_batch',
        `并发甩一批 headless E2E 用例，**提交即返回、不占你这一 turn**；引擎并发跑完后会自动唤起你，并把每个红的 repair-context 摘要（失败步/normalizedTarget/候选元素/expected-actual/平台建议补丁/失败截图路径）直接送到你面前。\n**这是跑 headless 的默认姿势，取代 mcp__zhuzhu__run_headless + 前台 sleep 轮询**：后者同步阻塞、长链必超时、超时还不吐 sessionId，逼你 sleep 等再按 mtime 猜 session 目录（取证不安全）。用了本工具就**不要**再前台 \`sleep\`、不要 \`ls -1dt\` 猜目录——跑完我会叫你。\n单批最多 ${E2E_MAX_FILES} 个文件，并发默认 ${E2E_DEFAULT_CONCURRENCY}、上限 ${E2E_MAX_CONCURRENCY}。仅用于 headless 迭代/回归；本版新 P0 的可视化终验仍走 App-run。`,
        {
          files: z.array(z.object({
            testFilePath: z.string().describe('test-workflows/ 下的相对 json 路径（不带 test-workflows/ 前缀、不要绝对路径）'),
            caseIds: z.array(z.string()).optional().describe('只跑这些 case（给了就等于 scope=selected）；留空=整个文件。**修复迭代一律只投红 case**'),
            rootCause: z.string().optional().describe('同一处已连续红 ≥2 次的 case 必填：你从失败截图/trace 看到的事实 + 这次改了什么（引擎拒收无根因的第 3 次盲投）'),
            fullFileReason: z.string().optional().describe('该文件上次已有绿 case、仍要整文件重跑时必填（如「终验：生成器已冻结，按文件 hash 签 reconcile」）'),
          })).describe('要并发跑的用例文件清单'),
          concurrency: z.number().optional().describe(`并发度，默认 ${E2E_DEFAULT_CONCURRENCY}、上限 ${E2E_MAX_CONCURRENCY}（机器还要跑被测前后端，别拉满）`),
          authProfile: z.string().optional().describe('认证 profile，示例项目用 localhost-pre（过 authProfile 硬闸的空占位）'),
          authBootstrap: z.string().optional().describe('auto | run；示例项目 headless 走 run（靠文件内真实登录 setup）'),
          reuseBrowser: z.boolean().optional().describe('是否复用同一 Chromium。默认：并发>1 时为 false（多会话重叠的隔离保证未确认，见需求单 REQ-Z16），单条时用平台默认'),
          note: z.string().optional().describe('这批是干什么的（一行，写进 lab 事件便于回看）'),
          stopOnFailure: z.boolean().optional().describe('调试/修复轮传 false：case 失败后继续跑完，一趟暴露该 case 全部坏步，唤起消息会逐条列出；出证据/终验轮不传（默认 true）'),
        },
        async ({ files, concurrency, authProfile, authBootstrap, reuseBrowser, note, stopOnFailure }) => {
          if (!zhuzhuConfig.enabled) return { content: [{ type: 'text', text: '[批次未提交：猪猪对接未启用（看板「猪猪对接设置」里开）]' }] }
          const base = zhuzhuBaseUrl()
          if (!base) return { content: [{ type: 'text', text: '[批次未提交：猪猪基地址为空——去看板「猪猪对接设置」填（主机会漂移，别写死）]' }] }
          const plan = planE2eBatch(files, { concurrency })
          if (plan.error) return { content: [{ type: 'text', text: `[批次未提交：${plan.error}]` }] }
          const gate = e2eEfficiencyGate(run, plan.items)
          if (gate.length) return { content: [{ type: 'text', text: `[批次未提交：E2E 提效门禁拦下 ${gate.length} 项]\n` + gate.map(g => '  · ' + g).join('\n') + '\n按提示收窄 caseIds / 补 rootCause / 补 fullFileReason 后重投。' }] }
          const batchId = 'e2e-' + crypto.randomBytes(3).toString('hex')
          const { items } = plan
          // 后台可见性：登进 _bgTasks（看板显示「后台运行中」、不判空闲）；_e2eBatchLive 让巡视员别把「甩批后收工」当空停
          run._bgTasks = run._bgTasks || new Map()
          run._bgTasks.set(batchId, { id: batchId, desc: `E2E 批次 ${items.length} 文件/并发 ${plan.concurrency}${note ? '：' + String(note).slice(0, 60) : ''}`, type: 'e2e-batch', lastTool: '', startedAt: Date.now(), durationMs: 0 })
          run._e2eBatchLive = (run._e2eBatchLive || 0) + 1
          const cancelToken = { cancelled: false }
          run._e2eCancelTokens = run._e2eCancelTokens || new Set()
          run._e2eCancelTokens.add(cancelToken)
          syncBgTasks(run)
          appendEvent(run.id, { type: 'lab', text: `🧪 E2E 批次 ${batchId} 已提交：${items.length} 个文件、并发 ${plan.concurrency}${note ? `（${note}）` : ''}——跑完自动唤起，员工无需等待` })
          if (plan.warnings?.length) appendEvent(run.id, { type: 'lab', text: `ℹ️ 批次 ${batchId}：${plan.warnings.join('；')}` })

          // 浮动执行：不 await（工具立即返回），settle 后由引擎注入唤起
          executeE2eBatch(
            { items, concurrency: plan.concurrency, base, authProfile, authBootstrap, reuseBrowser, stopOnFailure },
            {
              fetchImpl: fetch,
              acquire: () => acquireE2eSlot(run, batchId),
              isCancelled: () => cancelToken.cancelled,   // 2026-10-27：停会话要连带停批次（以前停了会话，批次线程还在往猪猪续投下一个文件）   // 跨会话的 headless 总数由引擎统一发号（2026-09-30 整机内存耗尽事故）
              readJsonFile: (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
              onProgress: (ev) => {
                if (ev.phase === 'settled' && ev.redVerdict) appendEvent(run.id, { type: 'lab', text: `${ev.redVerdict.ok ? '🎯' : '⚠️'} [${batchId}] ${ev.label} → RED 校准${ev.redVerdict.text}${ev.sessionId ? `（${ev.sessionId}）` : ''}` })   // RED 件红=护栏有效，别显示成 ❌ 失败
                else if (ev.phase === 'settled') appendEvent(run.id, { type: 'lab', text: `${ev.ok ? '✅' : '❌'} [${batchId}] ${ev.label} → ${ev.status}${ev.sessionId ? `（${ev.sessionId}）` : ''}` })
                else if (ev.phase === 'error') appendEvent(run.id, { type: 'lab', text: `⚠️ [${batchId}] ${ev.label} 执行异常：${ev.error}` })
                else if (ev.phase === 'cancelled') appendEvent(run.id, { type: 'lab', text: `⏹ [${batchId}] ${ev.label} 已随批次取消${ev.sessionId ? `（${ev.sessionId} 已在猪猪侧取消）` : ''}` })
              },
            },
          ).then(({ results, elapsedMs }) => {
            run._e2eCancelTokens?.delete(cancelToken)
            if (cancelToken.cancelled) {
              appendEvent(run.id, { type: 'lab', text: `⏹ E2E 批次 ${batchId} 已取消（会话被停止），不唤起员工` })
              run._bgTasks?.delete(batchId); run._e2eBatchLive = Math.max(0, (run._e2eBatchLive || 1) - 1); syncBgTasks(run)
              return
            }
            recordE2eHistory(run, results)
            const normal = results.filter(r => !(r && isE2eRedCalibration(r.testFilePath)))
            const cal = results.filter(r => r && isE2eRedCalibration(r.testFilePath))
            const greens = normal.filter(r => r && r.ok).length
            const calOk = cal.filter(r => r.redVerdict?.ok).length
            appendEvent(run.id, { type: 'lab', text: `🔔 E2E 批次 ${batchId} 全部结束：${normal.length ? `绿 ${greens}/${normal.length}` : ''}${normal.length && cal.length ? '；' : ''}${cal.length ? `RED 校准如期红 ${calOk}/${cal.length}` : ''}，墙钟 ${(elapsedMs / 60000).toFixed(1)}min` })
            const prompt = buildE2eWakePrompt({ batchId, results, elapsedMs, concurrency: plan.concurrency })
            finishE2eBatch(run, batchId, prompt)
          }).catch((e) => {
            appendEvent(run.id, { type: 'lab', text: `⚠️ E2E 批次 ${batchId} 编排异常：${String(e?.message || e)}` })
            finishE2eBatch(run, batchId, `【系统·E2E 批次异常】批次 ${batchId} 编排失败：${String(e?.message || e)}。请自行用 get_run_summary 回捞已起会话的结果，或修正入参重投。`)
          })

          return {
            content: [{
              type: 'text', text: `[E2E 批次 ${batchId} 已提交：${items.length} 个文件、并发 ${plan.concurrency}]\n` +
                items.map((it, i) => `  ${i + 1}. ${it.label}`).join('\n') +
                `\n\n**现在别等它**：不要前台 sleep、不要轮询、不要 ls 猜 session 目录——引擎会在全部跑完时唤起你，并把红的 repair-context 摘要一并送来。这一 turn 你可以去推别的批次（写下一批用例 / 读源码坐实 / 回写看板）；没有别的可推就如实收工，收工汇报里点明「批次 ${batchId} 在跑，结果回来会自动继续」。`,
            }],
          }
        },
      ),
    ],
  })
}
// ---------- E2E 提效门禁（2026-10-27，v6.3.0 F31 复盘）----------
// 7.2h 墙钟里：144min 重跑红文件里早已绿的 case、同一 case 同一步连红 4~6 次（每次猜错代价=一整批 45~90min）。
// 工牌纪律是软约束，这里做成工具硬门禁（§3.78「对 SDK 员工，工具与门禁才是硬约束」）。
// 历史只记在 run 内存里：一条会话内的迭代闭环；会话结束即清，不跨会话误伤。
function recordE2eHistory(run, results) {
  const h = run._e2eHist = run._e2eHist || { files: {}, fails: {} }
  for (const r of results || []) {
    if (!r || !r.testFilePath || r.status === 'cancelled') continue
    if (isE2eRedCalibration(r.testFilePath)) continue   // RED 件红是预期，不进收窄/连红门禁
    if (Array.isArray(r.cases) && r.cases.length) {
      const prev = h.files[r.testFilePath]?.cases || []
      const merged = new Map(prev.map(c => [c.caseId, c]))
      for (const c of r.cases) if (c.ran) merged.set(c.caseId, c)
      h.files[r.testFilePath] = { cases: [...merged.values()], at: Date.now() }
    }
    const ff = r.firstFailure
    if (!r.ok && ff && ff.caseId) {
      const key = r.testFilePath + '|' + ff.caseId
      const stepKey = ff.stepId || ('#' + (ff.stepIndex ?? '?'))
      const prev = h.fails[key]
      h.fails[key] = prev && prev.stepKey === stepKey ? { stepKey, count: prev.count + 1 } : { stepKey, count: 1 }
      if (h.fails[key].count >= 2) r.repeats = [{ caseId: ff.caseId, stepKey, count: h.fails[key].count }]
    }
    // 本次绿了的 case 清掉连红计数
    if (Array.isArray(r.cases)) for (const c of r.cases) if (c.ok) delete h.fails[r.testFilePath + '|' + c.caseId]
    if (r.ok) for (const k of Object.keys(h.fails)) if (k.startsWith(r.testFilePath + '|')) delete h.fails[k]
  }
}
function e2eEfficiencyGate(run, items) {
  const h = run._e2eHist
  if (!h) return []
  const out = []
  for (const it of items) {
    const file = h.files[it.testFilePath]
    if (!it.caseIds.length && !isE2eRedCalibration(it.testFilePath) && file && !it.fullFileReason) {
      const red = file.cases.filter(c => !c.ok).map(c => c.caseId)
      const green = file.cases.filter(c => c.ok)
      if (red.length && green.length) {
        const min = green.reduce((a, c) => a + (c.durationMs || 0), 0) / 60000
        out.push(`${it.testFilePath}：上次已有 ${green.length} 条绿（整文件重跑多烧≈${min.toFixed(1)}min）。只投红 case：caseIds=${JSON.stringify(red)}；确需整文件（终验签 reconcile）就填 fullFileReason`)
      }
    }
    for (const [key, v] of Object.entries(h.fails)) {
      const [p, caseId] = [key.slice(0, key.lastIndexOf('|')), key.slice(key.lastIndexOf('|') + 1)]
      if (p !== it.testFilePath || v.count < 2) continue
      if (it.caseIds.length && !it.caseIds.includes(caseId)) continue
      if (String(it.rootCause || '').trim().length < 15)
        out.push(`${it.testFilePath} 的 case ${caseId} 已在 ${v.stepKey} 连红 ${v.count} 次：先看失败截图 + trace（必要时单条 headed 跑）钉死原因，在该项写 rootCause（≥15 字，写看到的事实和这次改了什么）再投`)
    }
  }
  return out
}

// 批次收尾：摘掉后台标记 + 唤起员工（唤起口径与 scheduleBgResume 一致：前台在跑则热推、被顶替则不诈尸）
function finishE2eBatch(run, batchId, prompt) {
  run._bgTasks?.delete(batchId)
  run._e2eBatchLive = Math.max(0, (run._e2eBatchLive || 1) - 1)
  syncBgTasks(run)
  if (shuttingDown || !runs[run.id]) return
  const winner = supersededBy(run)
  if (winner) {
    appendEvent(run.id, { type: 'lab', text: `↩️ E2E 批次 ${batchId} 结束，但本会话已被更新的会话 ${winner.id} 接管，跳过自动唤起（结果已在上方 lab 事件里）` })
    return
  }
  appendEvent(run.id, { type: 'lab', text: `↩️ E2E 批次 ${batchId} 结束，自动唤起员工接棒（附 repair-context 摘要）` })
  sendToRun(run, prompt, { kind: run.lastKind || 'dispatch', resume: true })
}

// 这里做成只读工具：逐仓 fetch+rev-list+log、后端 diff 出改动模块→受影响服务清单。**只读**——merge/部署永远老板手点，工具不碰。
const RELEASE_REPOS = [
  { key: 'backend', path: path.join(ROOT, 'backend'), label: '后端 backend（单仓，覆盖 8 模块）' },
  { key: 'fe-supplier', path: path.join(ROOT, 'frontend', 'web-app'), label: '前端 web-app' },
  { key: 'fe-cj', path: path.join(ROOT, 'frontend', 'partner-app'), label: '前端 partner-app' },
  // 2026-10-08 独立站工程（批量管理迁出供应商项目后的宿主）
  { key: 'iwo', path: path.join(ROOT, 'auxiliary-web-workspace'), label: '独立站工程 auxiliary-web-workspace（auxiliary-api + 跨境管理中台）' },
  { key: 'fe-cc', path: path.join(ROOT, 'frontend', 'component-center'), label: '前端 component-center' },
]
// 后端模块目录 → 受影响服务；库模块改动牵连所有下游可部署服务
const BACKEND_DEPLOYABLE = { 'web-app-service': 'service(8040)', 'web-app-web': 'web(8041)', 'web-app-gys-web': 'gys-web(8042)', 'partner-app-biz-usa': 'partner-app-biz-usa(8217)' }
const BACKEND_LIB_MODULES = new Set(['web-app-common', 'web-app-datasource', 'web-app-service-interface', 'web-app-external-service-interface'])
const ALL_DEPLOYABLE = ['service(8040)', 'web(8041)', 'gys-web(8042)', 'partner-app-biz-usa(8217)']
function makeReleaseTools(run) {
  return createSdkMcpServer({
    name: 'release',
    version: '0.1.0',
    tools: [
      tool(
        'enumerate_release',
        '发布前逐仓枚举本次涉及改动（只读）：对后端 + 各前端仓 fetch 目标分支后 `git rev-list --count origin/<目标>..HEAD`，列出每仓领先提交数/当前分支/提交摘要；后端再 diff 出改动了哪些模块 → 推导受影响的可部署服务（库模块连带全部下游）。用于「发布前仓库枚举 + 部署服务清单」。**只读**：不 merge、不 push、不部署（这些永远老板手点）。',
        {
          target: z.string().optional().describe('目标分支：master（发测试，默认）或 release（发线上）'),
          fetch: z.boolean().optional().describe('是否先 git fetch 目标分支拿最新（默认 true；离线可传 false 用本地已有 origin ref）'),
          lane: z.string().optional().describe('工作区 id；不给=本会话所属工作区（没绑工作区=主检出）。本版开在工作区时必须按工作区的树枚举——主检出属于别的版本'),
        },
        async ({ target, fetch: doFetch, lane }) => {
          const tgt = (String(target || 'master').trim() === 'release') ? 'release' : 'master'
          const willFetch = doFetch !== false
          const out = [`【发布前仓库枚举 · 目标分支 ${tgt}${willFetch ? '（已 fetch 最新）' : '（未 fetch，用本地 origin ref）'}】`, '']
          const toMR = []
          let deploy = new Set()
          const deployReasons = []
          // 并行工作区：按所属工作区的 worktree 枚举；工作区里没开的仓直接跳过——主检出那份是别的版本，算进来就是误发
          const laneId = lane || laneKeyOf(run)
          const laneRec = laneId && laneId !== MAIN_LANE_ID ? lanesMgr().get(laneId) : null
          if (lane && lane !== MAIN_LANE_ID && !laneRec) return { content: [{ type: 'text', text: `[枚举失败：没有工作区 ${lane}]` }] }
          if (laneRec) out.splice(1, 0, `（按工作区 \`${laneId}\` 的 worktree 枚举；它没开的仓不计入）`)
          const repos = laneRec
            ? RELEASE_REPOS.map(r => laneRec.repos?.[r.key] ? { ...r, path: laneRec.repos[r.key].path, label: `${r.label}〔工作区 ${laneId}〕` } : { ...r, notInLane: true })
            : RELEASE_REPOS
          for (const repo of repos) {
            if (repo.notInLane) { out.push(`◻ ${repo.label}：工作区 ${laneId} 没开这个仓，不计入（主检出属于别的版本）`); continue }
            if (!fs.existsSync(repo.path)) { out.push(`◻ ${repo.label}：仓库路径不存在，跳过（${repo.path}）`); continue }
            const branchR = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repo.path)
            const branch = branchR.code === 0 ? branchR.out.trim() : '?'
            if (willFetch) await runGit(['fetch', '-q', 'origin', tgt], repo.path)
            const cntR = await runGit(['rev-list', '--count', `origin/${tgt}..HEAD`], repo.path)
            if (cntR.code !== 0) { out.push(`⚠ ${repo.label}（分支 ${branch}）：枚举失败——${(cntR.err || '').trim().split('\n').pop() || 'origin/' + tgt + ' 不存在？'}`); continue }
            const ahead = parseInt(cntR.out.trim(), 10) || 0
            if (ahead === 0) { out.push(`◻ ${repo.label}（分支 ${branch}）：领先 origin/${tgt} 0 个提交——本次无改动、不发`); continue }
            toMR.push(repo)
            const logR = await runGit(['log', '--oneline', '-8', `origin/${tgt}..HEAD`], repo.path)
            out.push(`✅ ${repo.label}（分支 ${branch}）：领先 origin/${tgt} ${ahead} 个提交 → 需建 MR（target=${tgt}）`)
            if (logR.code === 0 && logR.out.trim()) out.push(logR.out.trim().split('\n').map(l => `   · ${l}`).join('\n'))
            // 后端：diff 出改动模块 → 受影响服务
            if (repo.key === 'backend') {
              const diffR = await runGit(['diff', '--name-only', `origin/${tgt}..HEAD`], repo.path)
              const mods = new Set()
              if (diffR.code === 0) for (const f of diffR.out.split('\n')) { const seg = f.split('/')[0]; if (seg) mods.add(seg) }
              let libTouched = false
              for (const m of mods) {
                if (BACKEND_DEPLOYABLE[m]) { deploy.add(BACKEND_DEPLOYABLE[m]); deployReasons.push(`直接改了 ${m} → ${BACKEND_DEPLOYABLE[m]}`) }
                if (BACKEND_LIB_MODULES.has(m)) libTouched = true
              }
              if (libTouched) { ALL_DEPLOYABLE.forEach(s => deploy.add(s)); deployReasons.push(`改了库模块(${[...mods].filter(m => BACKEND_LIB_MODULES.has(m)).join(',')}) → 连带重发所有下游服务`) }
              const nonCode = [...mods].filter(m => !BACKEND_DEPLOYABLE[m] && !BACKEND_LIB_MODULES.has(m))
              out.push(`   后端改动模块：${[...mods].join(', ') || '（无法解析 diff）'}${nonCode.length ? `（其中 ${nonCode.join(',')} 非可部署代码模块，不触发部署）` : ''}`)
            }
          }
          out.push('')
          out.push(`【需建 MR 的仓】${toMR.length ? toMR.map(r => r.label).join('；') : '无（各仓都 0 提交）'}`)
          if (toMR.some(r => r.key === 'backend')) {
            out.push(`【后端部署服务清单】${deploy.size ? [...deploy].join('、') : '（后端有提交但 diff 未落到可部署模块，请人工确认）'}`)
            for (const s of ALL_DEPLOYABLE) if (!deploy.has(s)) out.push(`   · ${s}：无改动、不发`)
            if (deployReasons.length) out.push('   原因：' + deployReasons.join('；'))
          }
          out.push('')
          out.push('⚠ 提醒：建 MR 必须显式 --target-branch（GitLab 默认 release 是坑）；merge/部署永远老板在网页/运维台手点，本工具只枚举、不代劳。')
          return { content: [{ type: 'text', text: out.join('\n') }] }
        },
      ),
    ],
  })
}

// ============================================================================
// 守航能力工具集（方案的 lab 侧落地；按角色挂载，不做「人人可见」的大杂烩）
//
// 为什么做成 MCP 工具而不是写进 SOP：§3.78 的老结论——**对 SDK 员工，SOP 是软约束、工具与门禁
// 才是硬约束**。方案里每一条能力如果只写成规范，就会重演「规则在眼前仍被派工文案覆盖」。
// 所以：每条能力＝一个有返回值、有拒绝态的工具，员工绕不过去、也不必靠记性。
// ============================================================================
const txt = s => ({ content: [{ type: 'text', text: String(s) }] })
// 本地 UI 状态契约产物 → 「组件/testid → 入口」（A4/B3 的降级源；猪猪 Z-P 上线后优先用它）
function localEntryMapNow() {
  try { return zhuzhuCaps.localEntryMap(JSON.parse(fs.readFileSync(UI_CONTRACT_ARTIFACT, 'utf8'))) }
  catch (e) { return { available: false, why: `本地 UI 状态契约产物读不到（${e?.message || e}）——先让 GG Bond 跑一次抽取器`, components: {} } }
}
async function zhuzhuEntryMap() {
  const remote = await zhuzhuCaps.uiContractGraph(zzOpts())
  if (remote.available && Object.keys(remote.components).length) return { ...remote, source: 'zhuzhu' }
  const local = localEntryMapNow()
  return { ...local, why: local.available ? `猪猪 /ui-contract 不可用（${remote.why}），已降级用本地 UI 状态契约产物` : `${remote.why}；本地降级源也不可用：${local.why}` }
}
// 仓库 git 事实（B1 冻结 / D1 对账 / D2 三点 diff 共用）
async function repoGitFacts(repo) {
  const cwd = repo.path
  if (!fs.existsSync(cwd)) return { repo: repo.label, missing: true }
  const g = async a => { const r = await runGit(a, cwd); return r.code === 0 ? r.out.trim() : null }
  const branch = await g(['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = await g(['rev-parse', 'HEAD'])
  const porcelain = await g(['status', '--porcelain'])
  const lines = (porcelain || '').split('\n').filter(Boolean)
  const dirtyFiles = lines.filter(l => !/^[MARCD]\s/.test(l)).map(l => l.slice(3))
  const stagedFiles = lines.filter(l => /^[MARCD]/.test(l[0] || '')).map(l => l.slice(3))
  let remoteExists = false, aheadOfRemote = 0
  if (branch) {
    const up = await g(['rev-parse', '--verify', `origin/${branch}`])
    remoteExists = !!up
    if (up) { const n = await g(['rev-list', '--count', `origin/${branch}..HEAD`]); aheadOfRemote = parseInt(n || '0', 10) || 0 }
  }
  return { repo: repo.label, key: repo.key, path: cwd, branch, head, dirtyFiles, stagedFiles, remoteExists, aheadOfRemote }
}

function makeGuardedTools(run) {
  const emp = run.employee
  const tools = []
  const guardedOnly = () => run.executionMode === 'guarded_run'

  // ---- 全员：G2 进度快照（长任务续跑不再从头重来）----
  tools.push(tool(
    'progress_snapshot',
    '落一条「做到哪 / 下一步是什么 / 别再重做什么」的进度快照。**长任务每做完一个阶段就落一条**（引擎超过 12 分钟会提醒你）。任何续跑路径（卡死自愈 / 巡视唤起 / 老板回「继续」）引擎都会把最近一条快照注回你的 prompt——所以落了它，续跑就不会从头重来（老板 2026-08-24 连喊 3 次「接着上次进度往下做」，治的就是这个）。',
    {
      done: z.string().describe('已做到哪（具体到条目/文件/facet，别写"进展顺利"）'),
      next: z.string().describe('下一步具体做什么（续跑时你会照这条接着干）'),
      avoid: z.string().optional().describe('别再重做什么（已确认无效的路、已跑过的用例、已排除的假设）'),
    },
    async ({ done, next, avoid }) => {
      const c = guardContractFor(run)
      const led = c ? guardLedgerFor(c.runName) : null
      const r = stallGuard.pushSnapshot(run._snapshots || [], { done, next, avoid })
      if (r.error) return txt(`[快照未落：${r.error}]`)
      run._snapshots = r.list
      run.snapshotCount = r.list.length            // 非 _ 前缀 → 落库，重启后看板仍显示「有快照」
      run.lastSnapshot = r.snapshot                // 供 handleStreamEnd 的自动续跑注入（跨重启可用）
      if (led) { led.snapshots[run.id] = r.list; saveGuardLedger(c.runName) }
      saveRegistry()
      return txt(`已落进度快照（本会话第 ${r.list.length} 条）。续跑时引擎会把它注回你的 prompt。`)
    },
  ))

  // ---- 全员：E1 自查三红灯（"契约要求全 0"第一次能自己看见）----
  tools.push(tool(
    'guard_status',
    '看本轮守航的三红灯计数与契约用量（越权 / 超预算 / 假绿）。收工前自查一次：红灯 >0 的，在收工汇报里如实写清哪条、为什么——别让老板明早在晨检包里第一次看到。',
    {},
    async () => {
      const c = guardContractFor(run)
      if (!c) return txt('[本会话不在守航态，或找不到守航契约文件 —— 三红灯只在守航态计]')
      const led = guardLedgerFor(c.runName)
      const rows = mergeFacetRowsForRun(run)
      if (rows) led.fakeGreen = guardLedger.deriveFakeGreen(rows, run._verifyMap || null)
      led.overBudget = guardLedger.checkBudget(c.contract, led.usage)
      saveGuardLedger(c.runName)
      return txt(`契约 \`${c.rel}\`（run_name=${c.runName}）\n\n${guardLedger.renderRedLights(led)}\n\n本轮用量：${JSON.stringify(led.usage)}`)
    },
  ))

  // ---- v0.11.0 守航自助托管：目标循环自查 + 验收卡 + 三种不确定（record_decision / raise_risk）----
  // 为什么做成工具而不是写进 SOP：§21.1 的总纲——对 SDK 员工，SOP 是软约束，有返回值、有拒绝态的工具才是硬约束。
  // 验收卡四格是 goal 模式判「做完」的依据，必须是结构化数据（台账里），不能是收工汇报里的一段话。
  const pipelineEmp = ['feifei', 'ggbond', 'mihu', 'bobby'].includes(emp)
  // goal_status 只读：菲斯拉审「替老板定的决定分类对不对」也要看同一张现状表
  if (pipelineEmp || emp === 'feisila') {
    tools.push(tool(
      'goal_status',
      '看这一轮守航「还差什么才算干完」：每个条目现在的状态、验收卡还缺哪几格、谁该接着做、目标循环已续跑几轮。**收工前自查一次**——你收工后引擎会按同一套判据决定要不要把链重新点着，你先看见就不必等它来叫你。',
      {},
      async () => {
        const c = guardContractFor(run)
        if (!c) return txt('[本会话不在守航态，或本轮没有有效守航契约——目标循环只在守航态工作]')
        const ev = guardGoalEvaluate(c, { readOnly: true })
        const L = [`契约 \`${c.runName}\` · 目标循环：**${guardGoal.renderGoalLine(ev, ev.goal)}**`, '', '| 条目 | 状态 | 说明 |', '|---|---|---|']
        for (const i of ev.items) L.push(`| ${i.req} | ${i.state === 'done' ? '✅ 做完' : i.state === 'waiting_boss' ? '⏸ 等老板拍' : i.state === 'quarantined' ? '⛔ 隔离' : `▶ 待做（${i.owner}）`} | ${oneLine(i.why)} |`)
        if (!ev.items.length) L.push('| — | 还没有条目 | 菲菲还没挑/没记账 |')
        // 菲斯拉要审的两张表：替老板定的决定、登记的高危事项（分类对不对，是她的对抗审查对象）
        const led = ev.led || {}
        if ((led.decisions || []).length) { L.push('', '**替老板定的决定**'); for (const d of led.decisions) L.push(`- ${d.id} ${d.req} [${d.kind === 'fact' ? '查得清' : '可反悔'}] ${oneLine(d.topic)} → ${oneLine(d.chosen)}（${d.status}）${d.kind === 'fact' ? ` 依据：${oneLine(d.source)}` : ` 备选：${oneLine(d.alternative)}`}`) }
        if ((led.risks || []).length) { L.push('', '**高危事项**'); for (const r of led.risks) L.push(`- ${r.id} ${r.req} ${oneLine(r.what)}（${r.status}）为什么：${oneLine(r.why)}`) }
        return txt(L.join('\n'))
      },
    ))
  }
  if (pipelineEmp) {
    tools.push(tool(
      'raise_risk',
      `【只给「反悔代价大」的事用】登记一件必须老板拍板的高危事项：改线上数据/表结构、动权限、影响钱、对外发消息、推翻已上线规则、删东西——或者**这个功能必须破某条红线才能做**。它会出现在老板验收卡最显眼的「高危事项」格，老板一键选路后引擎自动把条目交回流水线。\n⚠ 可以反悔的事（界面摆法/默认值/先改显示…）**不许用它**——自己定，用 record_decision 记下来。拿不准就问自己：「做错了老板一句话，我能不能一小时内改回去、不留后遗症？」能 → 不是这里的事。\n${acceptanceCard.UNCERTAINTY_RULES}`,
      {
        req: z.string().describe('条目编号 REQ-xxxx'),
        what: z.string().describe('要做的那件高危的事（大白话，老板一眼能懂）'),
        why: z.string().describe('为什么非做不可 / 为什么反悔代价大'),
        options: z.array(z.string()).describe('老板可选的路，2~3 条（如「照做」「这部分不做」「换成 X 做法」）'),
        recommend: z.string().optional().describe('你推荐哪条、为什么'),
        redline: z.string().optional().describe('碰到的是哪条红线（如「生产 DDL」「权限模型变化」）'),
        blocksNow: z.boolean().optional().describe('**默认 false＝登记后按你推荐的路先做下去**，老板之后在卡上追认/改选。只有「这一步现在就要执行、一执行就回不去」时才填 true（真停下来等老板）。「要不要今晚做」永远不算——那不是问题'),
      },
      async (a) => {
        const c = guardContractFor(run)
        const led = c ? guardLedgerFor(c.runName) : null
        if (!led) return txt('[本会话不在守航态、或本轮没有有效守航契约——共驾态请直接在会话里问老板]')
        const r = acceptanceCard.raiseRisk(led, a, run.employee)
        if (r.error) return txt(`[未登记：${r.error}]`)
        // 只有「现在就得停」的才把条目挂到等老板；默认按推荐先做（2026-09-30 老板：「只做简单的那我签约守航干什么！」）
        if (a.blocksNow === true) guardLedger.recordItemResult(led, a.req, { result: 'parked', force: true, needsBoss: true, stopWhy: `等老板拍高危事项 ${r.risk.id}：${a.what}`, employee: run.employee })
        saveGuardLedger(c.runName)
        const archiveRel = guardArchiveRelFor(run, c)
        if (archiveRel) appendTimelineLine(archiveRel, `⚠ 高危事项 ${r.risk.id}（${String(a.req).toUpperCase()}）等老板拍：${oneLine(a.what)}——可选：${r.risk.options.join(' / ')}（${EMPLOYEES[run.employee]?.displayName || run.employee} 登记）`)
        broadcast({ type: 'acceptance-cards-changed', runName: c.runName, req: String(a.req).toUpperCase() })
        return txt(a.blocksNow === true
          ? `已登记高危事项 ${r.risk.id}（现在就得停）：${a.what}\n老板会在验收卡上看到它并一键选路；选完引擎自动把 ${String(a.req).toUpperCase()} 交回流水线。**只停这一条，其余条目照做**。`
          : `已登记高危事项 ${r.risk.id}：${a.what}\n**按你推荐的「${a.recommend || r.risk.options[0]}」接着做下去**——老板会在验收卡上追认或改选（改了再返工）。上线时不可逆的那一步照旧写成上线步骤、不执行。`)
      },
    ))
  }
  if (emp === 'feifei' || emp === 'ggbond') {
    tools.push(tool(
      'record_decision',
      `【守航期间你替老板做的决定，一律用它亮明】①查得清的（kind=fact，写 source 依据）②可以反悔的（kind=reversible，写 alternative：他不满意时一键改成什么）。它出现在老板验收卡「我替你定了什么」格，老板一键追认或改掉——所以**大胆定、如实记**，别把能自己定的事写成问句等他。\n⚠ 反悔代价大的（③类）不许走这里，用 raise_risk。\n${acceptanceCard.UNCERTAINTY_RULES}`,
      {
        req: z.string().describe('条目编号 REQ-xxxx'),
        kind: z.enum(['fact', 'reversible']).describe('fact=查得清的（写依据）；reversible=可以反悔的（写备选）'),
        topic: z.string().describe('在定什么（大白话，如「分条编号按什么拆」）'),
        chosen: z.string().describe('定成了什么'),
        why: z.string().describe('为什么这么定（用户要什么、行业怎么做、我们系统里怎么做最顺）'),
        alternative: z.string().optional().describe('reversible 必填：老板不满意时改成什么'),
        howToChange: z.string().optional().describe('要改的话动静多大（改哪几处、要不要重测）'),
        source: z.string().optional().describe('fact 必填：答案出自哪（文档路径/代码位置/哪次拍板）'),
      },
      async (a) => {
        const c = guardContractFor(run)
        const led = c ? guardLedgerFor(c.runName) : null
        if (!led) return txt('[本会话不在守航态、或本轮没有有效守航契约——共驾态老板在场，直接问他]')
        const r = acceptanceCard.recordDecision(led, a, run.employee)
        if (r.error) return txt(`[未记：${r.error}]`)
        saveGuardLedger(c.runName)
        broadcast({ type: 'acceptance-cards-changed', runName: c.runName, req: String(a.req).toUpperCase() })
        return txt(`已记决定 ${r.decision.id}（${a.kind === 'fact' ? '查得清的' : '可以反悔的'}）：${a.topic} → ${a.chosen}。老板会在验收卡上看到，可一键追认或改掉。**按这个决定接着做**。${r.costlyHint ? `\n\n⚠ 这条里出现了「${r.costlyHint}」——它像是**反悔代价大**的事。如果做错了没法一小时内改回去，请改用 \`raise_risk\` 让老板拍，并在收工汇报里说明。` : ''}`)
      },
    ))
  }
  if (emp === 'ggbond' || emp === 'mihu' || emp === 'feifei') {
    tools.push(tool(
      'acceptance_card',
      '【填验收卡】老板早上只看这张卡的四格：①做完没（引擎自动填）②长啥样 ③动了哪些老功能 ④高危事项（raise_risk 登记）。**你填②③**：\n- GG Bond：交 QA 前写 `summary`（一句话：做完后用户看到什么变化）+ 申报 `impact`（这次碰到了哪些**老功能**、怎么碰到的；真没碰到就写 `impactNone` 理由）；纯后端改动写 `noUi` 理由。\n- 迷糊：测的时候把关键截图挂上 `shots`（src 可以是猪猪产物的绝对路径，引擎会复制进仓库）+ 对 GG Bond 申报的每个老功能**重跑验证**后写 `impactVerify`（ok + 证据 run/session）。\n**四格不齐，这条就不算做完**——引擎的目标循环会一直把它派回来补。',
      {
        req: z.string().describe('条目编号 REQ-xxxx'),
        name: z.string().optional().describe('需求名（大白话）'),
        summary: z.string().optional().describe('一句话：做完后用户看到什么变化'),
        shots: z.array(z.object({ src: z.string(), caption: z.string().optional() })).optional().describe('截图（仓内相对路径或猪猪产物绝对路径）+ 一句说明'),
        noUi: z.string().optional().describe('纯后端/无界面改动时写理由（代替截图）'),
        impact: z.array(z.object({ feature: z.string(), how: z.string().optional() })).optional().describe('GG Bond 申报：碰到的老功能 + 怎么碰到的'),
        impactNone: z.string().optional().describe('真没碰到任何老功能时写理由'),
        impactVerify: z.array(z.object({ feature: z.string(), ok: z.boolean(), evidence: z.string().optional() })).optional().describe('迷糊验证：每个老功能重跑后是否正常 + 证据'),
      },
      async (a) => {
        const c = guardContractFor(run)
        const led = c ? guardLedgerFor(c.runName) : null
        if (!led) return txt('[本会话不在守航态、或本轮没有有效守航契约——验收卡目前只在守航轮里记账]')
        const shots = [], shotErr = []
        for (const s of a.shots || []) {
          const r = stashCardShot(c.runName, a.req, s.src)
          if (r.error) shotErr.push(`${s.src}：${r.error}`)
          else shots.push({ src: r.src, caption: s.caption })
        }
        const r = acceptanceCard.upsertCard(led, a.req, { ...a, shots }, run.employee)
        if (r.error) return txt(`[未写：${r.error}]`)
        saveGuardLedger(c.runName)
        broadcast({ type: 'acceptance-cards-changed', runName: c.runName, req: String(a.req).toUpperCase() })
        const comp = acceptanceCard.cardCompleteness(r.card)
        return txt(`验收卡 ${String(a.req).toUpperCase()} 已更新。${comp.complete ? '✅ 四格齐了。' : `还缺：\n${comp.missing.map(m => `- ${m.what}（${EMPLOYEES[m.who]?.displayName || m.who}）`).join('\n')}`}${shotErr.length ? `\n\n⚠ 这几张截图没挂上：\n${shotErr.map(x => `- ${x}`).join('\n')}` : ''}`)
      },
    ))
  }

  // ---- 模块 UX 契约自查：GG Bond（交接前左移）与两位 QA（验收复核）共用 ----
  if (emp === 'ggbond' || emp === 'mihu' || emp === 'feisila') {
    tools.push(tool(
      'ux_contract_check',
      '【GG Bond 交接前必跑 / QA 验收复核】查本次改动有没有漏掉**示例项目沉淀下来的 UX 约定**——Upload 支持粘贴、Modal 支持 ⌘/Ctrl+Enter 提交并在按钮上显示提示、页面用统一面包屑头。\n\n**为什么需要它**：这些是 React handler，**不在样式、不在 DOM 属性、不在截图里**，视觉验收那三层一层都采不到；猪猪当前也没有 press/paste 动作跑不了行为。漏了不会红、不会报错，**只有用的人会觉得「这页怎么比别处难用」**。\n\n判据仍是**数出来的多数**：每条都会告诉你「模块里 N/M 这么做了」；采纳率 <60% 的自动降级成候选级提醒（模块自己都没统一，不当硬要求）。确有正当例外，在源码里写 `// ux-contract-ack: <契约key> <理由>`——**只记录、不豁免，采纳率照旧算它没守**。',
      {
        files: z.array(z.string()).optional().describe('本次改动的前端文件（相对 src/ 的路径，如 pages/samplingXxx/index.tsx）；留空=全模块盘点'),
        showCandidates: z.boolean().optional().describe('顺带列出「被多个文件共用但尚未立契约」的候选'),
      },
      async ({ files, showCandidates }) => {
        const { files: srcs, missing } = collectSamplingSources()
        if (!srcs.length) return txt(`⚠ **扫不到前端源码**（找过 ${SAMPLING_SRC_ROOTS.join('、')}${missing.length ? `；缺失：${missing.join('、')}` : ''}）——这台机器上没有 web-app 前端仓，或路径变了。**扫不到 ≠ 没问题**，按未检查记。`)
        const scan = uxContract.scanUxContracts(srcs)
        const L = []
        if (files?.length) {
          const known = new Set(srcs.map(s => s.file))
          const unknown = files.filter(f => !known.has(String(f)))
          L.push(uxContract.renderChangedCheck(uxContract.judgeChangedFiles(scan, files), scan))
          if (unknown.length) L.push(`\n> ⚠ 这 ${unknown.length} 个文件不在扫描范围内、**没被检查**（不是"通过"）：${unknown.slice(0, 8).join('、')}${unknown.length > 8 ? ' …' : ''}。路径要相对 \`src/\`，且只扫 \`pages/sampling*\` 与全站 \`components\`/\`hooks\`。`)
        } else {
          L.push(uxContract.renderInventory(scan))
        }
        if (showCandidates) L.push('\n' + uxContract.renderCandidates(uxContract.discoverCandidates(srcs), srcs.length))
        return txt(L.join('\n'))
      },
    ))
  }

  // ---- GG Bond：B1 / B3 / B5 / B7 / E6-B6 ----
  if (emp === 'ggbond') {
    tools.push(tool(
      'freeze_handoff',
      '【交给 QA 前必跑】检查各仓是否已 commit + push，返回可写进交接卡的 commit sha。证据必须绑**不可变版本**：v5.19 那次 4 条 REQ 的代码全躺在未提交工作区、发测才被发现；打磨的 commit 只 commit 未 push、release MR 打开是「no commits yet」。有未提交/未 push 就会明确拒绝并列出文件——先 commit（**允许 `wip:` 提交，交接不等于定稿**）再交接。',
      { repos: z.array(z.string()).optional().describe('只查哪几个仓（key：backend/fe-supplier/fe-cj/iwo/fe-cc）；留空=全查（本会话绑了工作区时只查工作区里的树）') },
      async ({ repos }) => {
        const want = Array.isArray(repos) && repos.length ? new Set(repos.map(String)) : null
        const facts = []
        // 绑了工作区就查工作区的树：主检出属于别的版本（2026-10-07 Temu 迁移交接时这里查了主检出，把通知管理的未提交改动当成本版的拦下）
        const laneId = laneKeyOf(run)
        const laneRec = laneId && laneId !== MAIN_LANE_ID ? lanesMgr().get(laneId) : null
        const candidates = laneRec
          ? RELEASE_REPOS.filter(r => laneRec.repos?.[r.key]).map(r => ({ ...r, path: laneRec.repos[r.key].path, label: `${r.label}〔工作区 ${laneId}〕` }))
          : RELEASE_REPOS
        for (const r of candidates) { if (want && !want.has(r.key)) continue; const f = await repoGitFacts(r); if (!f.missing) facts.push(f) }
        if (!facts.length) return txt('[没有可查的仓库（路径都不存在？）]')
        const res = handoffFreeze.freezeCheck(facts)
        if (res.ok) {
          run.frozenSha = res.handoffLine; saveRegistry()
          // 也记进**本轮台账**：晨检包的「当前 RC commit」以前读 run.frozenSha，而结算时随手取到的
          // 那条 run（多为菲菲）根本没跑过 freeze_handoff → 恒为空。台账按 run_name 聚合，整条链共用。
          const c = guardContractFor(run)
          if (c) { const led = guardLedgerFor(c.runName); led.rcCommit = { line: res.handoffLine, frozen: res.frozen, at: new Date().toISOString(), by: run.employee }; saveGuardLedger(c.runName) }
        }
        return txt(handoffFreeze.renderFreezeBlock(res))
      },
    ))
    tools.push(tool(
      'impact_radar',
      '【QA 期间又改了码就必须跑】算出这次改动影响哪些入口、作废哪些已签发的 facet 证据，并**自动把它们打回 UNCOVERED** + 抄送迷糊一份重跑清单。缘起：观测窗口内至少 8 次「QA 后又改码」让旧证据作废、全量 QA 重跑 3 轮，而当时没有任何机器信号——绿灯还挂着，证据其实早失效了。',
      {
        since: z.string().describe('相对哪个基线算 diff：commit sha 或分支名（一般填 freeze_handoff 给你的那个 sha）'),
        repo: z.string().optional().describe('仓库 key（backend/fe-supplier/fe-cj），默认 fe-supplier'),
        apply: z.boolean().optional().describe('true=把作废的 facet 真的写回覆盖矩阵置 UNCOVERED（默认 true）'),
      },
      async ({ since, repo, apply }) => {
        const target = RELEASE_REPOS.find(r => r.key === (repo || 'fe-supplier'))
        if (!target || !fs.existsSync(target.path)) return txt(`[仓库不存在：${repo || 'fe-supplier'}]`)
        const d = await runGit(['diff', '--name-only', `${since}...HEAD`], target.path)
        if (d.code !== 0) return txt(`[取 diff 失败：${(d.err || '').trim().slice(0, 200)}——核对 since 是否有效]`)
        const diffFiles = d.out.split('\n').map(s => s.trim()).filter(Boolean)
        if (!diffFiles.length) return txt(`自 \`${since}\` 以来 ${target.label} 无改动 —— 没有 facet 证据被作废。`)
        const em = await zhuzhuEntryMap()
        const idx = facetIndexForRun(run)
        const head = await runGit(['rev-parse', 'HEAD'], target.path)
        const r = handoffFreeze.impactRadar({ diffFiles, entryMap: em.components, facetIndex: idx.facets, evidenceByFacet: idx.evidence, newCommit: head.code === 0 ? head.out.trim() : '' })
        let applied = ''
        if (apply !== false && r.toUncovered.length && run.taskFile) {
          let n = 0
          for (const fid of r.toUncovered) {
            try { engineSetFacetRow(safeResolve(run.taskFile), { facetId: fid, status: 'UNCOVERED', evidence: '', red: '' }); n++ } catch {}
          }
          applied = `\n\n已自动把 ${n} 条 facet 打回 UNCOVERED（证据绑的是旧 commit，改码即失效）。`
          if (n) appendTimelineLine(run.taskFile, `影响面雷达：改动 ${String(r.newCommit).slice(0, 10)} 作废 ${n} 条 facet 证据，已打回 UNCOVERED（需重跑：${r.rerunCaseIds.join(', ') || '见清单'}）`)
        }
        return txt(handoffFreeze.renderImpactRadar(r) + applied + (em.available ? '' : `\n\n> ⚠ 入口图谱不可用（${em.why}）——本次只按「实现文件命中」算，跨入口影响可能漏算。`))
      },
    ))
    tools.push(tool(
      'ddl_precheck',
      '【写 DDL / 存量回填前必跑】五项强制核查：目标库版本探测、执行通道兼容（阿里云 DMS 拦临时表/拆连接）、影响行数预估（先跑 SELECT count(*)）、回滚脚本、「先 DDL 再发服务」顺序声明。这三条都是 v5.19 靠老板抽问才暴露的（MySQL 5.7 不支持窗口函数 / DMS 拦临时表 / 回填 10,635 行）。行数超阈值或触碰主数据会把 risk_class 顶到 high。',
      {
        dbVersion: z.string().optional().describe('探测到的目标库版本，如 "MySQL 5.7.36"'),
        channel: z.string().optional().describe('执行通道，如 "阿里云 DMS" / "直连 mysql client"，并说明兼容性结论'),
        rowEstimate: z.string().optional().describe('影响行数预估结论（附你跑的 count SQL）'),
        rollback: z.string().optional().describe('回滚脚本/数据补偿方案（或说明"纯新增列、不需回滚"）'),
        orderDeclared: z.string().optional().describe('顺序声明，如 "先执行 DDL 再发 service/web"'),
        backfillRows: z.number().optional().describe('存量回填行数（数字，用于风险定级）'),
        productionData: z.boolean().optional().describe('是否触碰已上线主数据'),
      },
      async (facts) => {
        const r = handoffFreeze.ddlPrecheck(facts)
        const gate = gateMatrix.classifyRisk({ ddl: true, backfillRows: facts.backfillRows, productionData: facts.productionData })
        return txt(handoffFreeze.renderDdlPrecheck(r, facts) + `\n\n机器定级：**risk_class=${gate.riskClass}**（${gate.reasons.map(x => x.why).join('；')}）` + (r.ok ? '' : `\n\n⛔ ${r.summary} —— 缺的项补齐再交付 SQL。`))
      },
    ))
    tools.push(tool(
      'risk_gate',
      '【领到条目、动手之前必跑 · E6/B6】按机器信号给这条目定 risk_class 并判「守航态能不能做实施」。**人填的 risk_class 只作下限**——DDL / 权限变化 / 触碰已上线主数据 / 存量回填 >1000 行 / 净改动 >800 行 / 改动文件 >40 个 / 不可逆外部副作用（**测试路径也算**）任一命中即顶 high。缘起：REQ-0239 是 high 但**表里填的不是 high**，整条留在守航里做，代价是 4 天长尾 + 2 个逃逸缺陷 + 10,635 行回填风险。\n判 `high`：守航态**照样实施到底**（开发分支 + 测试环境，可以反悔），只把上线时不可逆的那几步（线上执行 DDL / 迁移线上数据 / 配权限）写成上线步骤、不执行；DDL/迁移脚本要可重复执行、先 `ddl_precheck`、给出影响行数与回滚方案。**「要不要今晚做」不是问题**——老板签契约就是要做（2026-09-30 老板：「只做简单的那我签约守航干什么」）。',
      {
        item: z.string().optional().describe('条目编号（进晨检包的门禁矩阵表用）'),
        declared: z.string().optional().describe('需求表里人填的 risk_class（low/medium/high），作下限'),
        ddl: z.boolean().optional().describe('本次含 DDL'),
        permissionChange: z.boolean().optional().describe('权限模型变化'),
        productionData: z.boolean().optional().describe('触碰已上线主数据（品类/权限码/枚举等全局主数据）'),
        backfillRows: z.number().optional().describe('存量回填影响行数（先跑 SELECT count(*) 拿真数字）'),
        changedLines: z.number().optional().describe('预估/实际净改动行数'),
        changedFiles: z.array(z.string()).optional().describe('改动文件清单（含前端可见文件会顶到 medium）'),
        reusedComponents: z.number().optional().describe('改动落在被 ≥2 入口复用的组件上的个数（`cross_entry_facets` 能算）'),
        externalSideEffects: z.boolean().optional().describe('路径上有不可逆外部副作用（真实企微/真机/三方；**测试路径也算**）'),
        worktreeItems: z.array(z.string()).optional().describe('本轮并行的全部条目编号——传了就顺带给 B2 的 worktree 隔离计划'),
      },
      async (a) => {
        const d = gateMatrix.guardedScopeDecision({ executionMode: run.executionMode, signals: a, declared: a.declared })
        const L = [d.preamble, '']
        if (d.reasons.length) { L.push('**定级依据**'); for (const r of d.reasons) L.push(`- ${r.why}`); L.push('') }
        if (d.downgrade) {
          L.push(`⛔ **本条在守航态自动降级**：${d.parkReason}`)
          L.push('')
          L.push('落地动作：把该条目置「已跳过」park（`set_entry_status`）+ `park_item` 登记 + 时间线记一笔；其余条目照跑。')
        }
        // B2：多条目并行时给 worktree 隔离计划（只出计划、不自动建树——自动建树误判代价是丢代码）
        const wt = Array.isArray(a.worktreeItems) && a.worktreeItems.length > 1
          ? handoffFreeze.worktreePlan(a.worktreeItems, { repo: 'fe-supplier' }) : null
        if (wt) {
          L.push('')
          L.push('**B2 条目级 worktree 隔离计划**（只出计划，引擎不替你建树）')
          for (const p of wt.plans) L.push(`- ${p.req}：\`git worktree add ${p.path} -b ${p.branch}\``)
          L.push(`> ${wt.hint}`)
          L.push('> 这是**同一版本内**的条目级隔离；**不同需求/版本**并行（主检出被别的版本占着）请用 `lane_create`——引擎直接建树 + 分配端口槽位 + 起停，别手敲 worktree 命令。')
        }
        // 存台账：晨检包的「门禁矩阵」表与「暂不满足 RC_READY 放行门」都从这里取
        const c = guardContractFor(run)
        if (c && a.item) {
          const led = guardLedgerFor(c.runName)
          led.gateDecisions = led.gateDecisions || {}
          led.gateDecisions[String(a.item).toUpperCase()] = { item: String(a.item).toUpperCase(), riskClass: d.riskClass, declared: d.declared, escalated: d.escalated, downgrade: d.downgrade, reasons: d.reasons, gate: d.gate }
          // 条目账立账：领到条目就有一行「在途」，别等到收工才问 agent 本轮做了啥
          guardLedger.recordItemResult(led, a.item, d.downgrade
            ? { result: 'parked', riskClass: d.riskClass, stopWhy: d.parkReason }
            : { result: 'in_progress', riskClass: d.riskClass })
          saveGuardLedger(c.runName)
          L.push('')
          L.push(`（已记入本轮台账，晨检包的「门禁矩阵」表会显示这条${d.escalated ? '，并点名机器升级了它' : ''}）`)
        }
        return txt(L.join('\n'))
      },
    ))
    tools.push(tool(
      'draft_implementation_record',
      '从 git diff / 构建结果 / 端点冒烟自动生成**实施记录初稿**（B7）：「改了什么」机器填好，「为什么这么改」留给你补。减少收尾负担，也减少「活干完了忘写标记」导致的空停。',
      {
        version: z.string().optional(), since: z.string().describe('相对哪个基线（commit sha 或分支）'),
        repo: z.string().optional().describe('仓库 key，默认 fe-supplier'),
        reqs: z.array(z.string()).optional().describe('本次条目编号'),
      },
      async ({ version, since, repo, reqs }) => {
        const target = RELEASE_REPOS.find(r => r.key === (repo || 'fe-supplier'))
        if (!target || !fs.existsSync(target.path)) return txt(`[仓库不存在：${repo || 'fe-supplier'}]`)
        const st = await runGit(['diff', '--numstat', `${since}...HEAD`], target.path)
        const lg = await runGit(['log', '--oneline', '--no-merges', `${since}..HEAD`], target.path)
        const diffStat = {}
        if (st.code === 0) for (const l of st.out.split('\n')) { const m = l.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/); if (m) diffStat[m[3]] = { added: m[1] === '-' ? '?' : +m[1], removed: m[2] === '-' ? '?' : +m[2] } }
        const commits = lg.code === 0 ? lg.out.split('\n').filter(Boolean).map(l => ({ sha: l.split(' ')[0], subject: l.slice(l.indexOf(' ') + 1) })) : []
        return txt(handoffFreeze.draftImplementationRecord({ version, reqs: reqs || [], diffStat, commits }))
      },
    ))
  }

  // ---- 菲菲：A1 / A2 / A3 / A4 / A5 + §2 字段 ----
  if (emp === 'feifei') {
    tools.push(tool(
      'pool_fields_check',
      '检查需求表有没有「守航就绪池」需要的 8 个结构化字段（守航就绪 / 就绪缺口 / risk_class / 紧急度 / 期望时间 / park轮次 / 窄口径声明 / facet冻结 / 影响入口），缺的列出建列参数。老板说的「表里加守航态 ready tag」不是一个 tag 够——得让机器能判「为什么不 ready、还差哪一项」。',
      {},
      async () => {
        if (!larkConfigured()) return txt('[飞书需求表未接通，查不了字段]')
        try {
          const fields = await larkListFields()
          const miss = reqPool.missingPoolFields(fields.map(f => f.name))
          if (!miss.length) return txt(`✅ 就绪池 8 个字段齐备（共 ${fields.length} 列）。`)
          const L = [`需求表缺 ${miss.length} 个就绪池字段 —— 用 \`lark_manage_field\` 逐个建：`, '', '| 字段 | 飞书 type | 谁写 | 用途 |', '|------|----------|------|------|']
          for (const f of miss) L.push(`| ${f.name} | ${f.type}${f.options.length ? `（选项：${f.options.join('/')}）` : ''} | ${f.who} | ${f.use} |`)
          L.push('', '> 单选/多选字段建完后要在飞书里补选项（引擎只能建字段、补不了选项列表）。')
          return txt(L.join('\n'))
        } catch (e) { return txt(`[查字段失败：${String(e?.message || e)}]`) }
      },
    ))
    tools.push(tool(
      'pool_scan',
      '【需求巡航 · A1】一次读全需求表 → 按「就绪度 × 紧急度 × 期望时间 × park 轮次」排序 → 给出本轮可取的候选，并合并 park 台账的轮次。**排序不再靠读措辞猜**。这是白天「把池子养肥」的入口：先跑它看池子长什么样，再对排在前面但还没就绪的逐条 `readiness_probe`、把 open 项写回「就绪缺口」、生成问老板的问题卡（一次≤3 张）。\n⚠ 本工具**只读、不改表**——它给你排序与判据，回写 `守航就绪`/`就绪缺口` 仍走 `lark_update_requirement`（那一步要你确认过再写）。\n⚠ 抽 0 条时会**显式报原因**（池子空 / 全部待澄清 / 只剩 high）——guarded-02 那轮抽 0 条却没有任何说明，不许再发生。',
      {
        maxItems: z.number().optional().describe('本轮想取几条（默认 3；只影响"候选"那一段，排序全表照给）'),
        allowedRisk: z.array(z.string()).optional().describe('允许的 risk_class，默认 ["low","medium"]；守航态会把 high 也算进来（high 照样做完，只有上线不可逆的几步留给人）'),
        topN: z.number().optional().describe('排序表显示前几行，默认 20'),
        status: z.string().optional().describe('先按需求表状态过滤，默认「待处理」（别把 200+ 行整表拉进来）'),
      },
      async ({ maxItems, allowedRisk, topN, status }) => {
        if (!larkConfigured()) return txt('[飞书需求表未接通（缺凭证或未授权），巡航跑不了]')
        const want = String(status ?? '待处理').trim()
        let records
        try { records = await larkListRecords(5000) }
        catch (e) { return txt(`[读需求表失败：${String(e?.message || e)}（可能是 bitable:app 权限未授权/未发版）]`) }
        if (want) records = records.filter(r => Object.entries(r.fields || {}).some(([k, v]) => k.includes('状态') && larkCellText(v).trim() === want))
        if (!records.length) return txt(`[需求表里没有状态=「${want}」的记录${want ? '——换个 status，或传 status:"" 扫全表' : ''}]`)
        // 字段名做「去空白 + 包含」匹配：飞书列名常被手工加空格/后缀（`risk_class(评估)` 这类）
        const cell = (rec, ...names) => {
          for (const n of names) {
            for (const [k, v] of Object.entries(rec.fields || {})) if (k.replace(/\s/g, '').includes(n)) return larkCellText(v).trim()
          }
          return ''
        }
        const park = loadParkLedger()
        // 排序键只数**未关闭的真歧义**轮次：引擎的到点顺延占位也会抬 rounds，混进来会把
        // 「park 越久越该先领」这条排序意图带偏（顺延占位抬得最快，但它根本不是待拍问题）。
        const parkRounds = Object.fromEntries(park
          .filter(e => !e.closedAt && reqPool.classifyParkKind(e) === reqPool.PARK_KIND.AMBIGUITY)
          .map(e => [String(e.req).toUpperCase(), Number(e.rounds || 0)]))
        const rows = records.map(r => reqPool.toPoolRow(r, cell, { parkRounds }))
        // 守航态 high 也算候选（2026-09-30 起 high 照样做完，只把上线不可逆的几步留给人）
        const risks = Array.isArray(allowedRisk) && allowedRisk.length ? allowedRisk.map(s => String(s).toLowerCase()) : (run.executionMode === 'guarded_run' ? ['low', 'medium', 'high'] : ['low', 'medium'])
        const sorted = reqPool.sortPool(rows)
        const pick = reqPool.pickForContract(rows, maxItems || 3, { allowedRisk: risks })
        const hasReadyCol = records.some(r => Object.keys(r.fields || {}).some(k => k.replace(/\s/g, '').includes('守航就绪')))
        const N = Math.max(1, Math.min(60, Number(topN) || 20))
        const L = [`【需求巡航 · A1】状态=「${want || '全部'}」共 ${rows.length} 条；就绪 ${rows.filter(r => r.readiness === '就绪').length} 条。`, '']
        if (!hasReadyCol) L.push('⚠ **需求表还没有 `守航就绪` 列** —— 全部按「待澄清」计。先跑 `pool_fields_check` 建列，否则就绪池永远是空的。\n')
        L.push(`**排序**（就绪度 → 紧急度 → 期望时间 → park 轮次；前 ${Math.min(N, sorted.length)} 条）`, '')
        L.push('| # | 条目 | 就绪 | 紧急 | 期望 | risk | park | 缺口 | 摘要 |')
        L.push('|---|------|------|------|------|------|------|------|------|')
        sorted.slice(0, N).forEach((r, i) => L.push(`| ${i + 1} | ${r.req} | ${r.readiness} | ${r.priority || '—'} | ${r.dueDate || '—'} | ${r.riskClass || '—'} | ${r.parkRounds || '—'} | ${r.gaps || '—'} | ${r.title || '—'} |`))
        if (sorted.length > N) L.push(`| … | 另有 ${sorted.length - N} 条 | | | | | | | |`)
        L.push('')
        if (run.executionMode === 'guarded_run') {
          // v0.11.0：守航态不再只认「守航就绪=就绪」——那一列是白天巡航的产物，夜里只认它就会「挑无可挑」
          // （自选的 4 轮 0 条开工）。排序表照给，挑哪几条由菲菲按产品五步 + 三种不确定自己判。
          L.push(`**守航态怎么用这张表**：「就绪」只是参考、不是门槛。从上往下逐条读全文，按五步想透：不确定都是①查得清/②可以反悔的 → 能做；核心问题是③反悔代价大的 → 登记 raise_risk 后按推荐的路先做；**risk=high 照样挑、照样做完**（只把上线不可逆的几步留给人）。挑够 ${maxItems || 3} 条就停，**调 selection_done 说清挑了哪些、没挑的各属于哪类**。`)
          if (pick.picked.length) L.push('', `（参考：已标「就绪」的 ${pick.picked.map(r => r.req).join('、')} 可直接进，不必重判）`)
        } else if (pick.empty) {
          L.push(`**本轮候选：0 条** —— ${pick.emptyWhy}`)
          L.push('')
          L.push('按守航纪律：如实报「0 条」+ 上面这条原因，**绝不硬拉需求凑版本**。要把池子养肥，就对排序表前几条逐条跑 `readiness_probe`，把 open 项写回「就绪缺口」，再产问老板的问题卡（一次≤3 张，每张带「拟定默认 + 利弊 + 不拍会怎样」）。')
        } else {
          L.push(`**本轮候选（${pick.picked.length}/${pick.eligibleCount} 条合格）**`, '')
          for (const r of pick.picked) L.push(`- **${r.req}**（${r.priority || '无优先级'}${r.dueDate ? ` · 期望 ${r.dueDate}` : ''} · risk=${r.riskClass || '未定'}）${r.title ? ` —— ${r.title}` : ''}${r.narrowScope ? '' : '　⚠ 未写窄口径声明（A3 是冻结 facet 的强制前置）'}`)
        }
        if (pick.deferredHigh.length) {
          L.push('')
          L.push(`**就绪、风险 high**：${pick.deferredHigh.map(r => r.req).join('、')} —— 共驾态由你判断要不要现在做；守航态照样做完（只把上线不可逆的几步留给人）。`)
        }
        const mustAnswer = reqPool.mustAnswer(park)
        if (mustAnswer.length) {
          L.push('')
          L.push(`**⭐ park 必答区（${mustAnswer.length} 条已 park ≥2 轮）**：${mustAnswer.map(e => `${e.req}（${e.rounds} 轮${e.repeatedProposal ? '，口径一字未变' : ''}）`).join('、')} —— 这些进晨检包必答，别再重写同一份建议。`)
        }
        L.push('')
        L.push('> 本工具只读。回写 `守航就绪`/`就绪缺口` 用 `lark_update_requirement`；park 用 `park_item`。')
        return txt(L.join('\n'))
      },
    ))
    tools.push(tool(
      'readiness_probe',
      '对一条需求过七项拷问（来源/口径/边界/范围/依赖/可测性/影响面）+ 三条硬前置（facet 冻结 / risk_class 定 / 窄口径声明），机器判它能不能置「守航就绪=就绪」。**没到标准不许置就绪** —— 这是守航资格的唯一入口，也是防「夜里替老板猜」的根。返回还差哪几项 + 该问老板什么。',
      {
        req: z.string().describe('需求编号'),
        sourceRead: z.boolean().optional().describe('已 lark_get_requirement 读过全文（不是列表摘要）'),
        semanticsFixed: z.boolean().optional().describe('业务口径已定，或能在同源语料库找到已定口径并注明来源'),
        boundaryEnumerated: z.boolean().optional().describe('边界与异常分支已枚举成 facet 行'),
        scopeDeclared: z.boolean().optional().describe('本次做什么/明确不做什么已写清'),
        dependencyReady: z.boolean().optional().describe('依赖的上游/他组/数据已就位'),
        testable: z.boolean().optional().describe('facet 有可断言的值，且测试路径无不可逆副作用'),
        impactKnown: z.boolean().optional().describe('影响哪些入口/组件已枚举'),
        facetFrozen: z.boolean().optional().describe('facet 已冻结（facet_doc 有锚点）'),
        riskClass: z.string().optional().describe('low / medium / high'),
        narrowScope: z.string().optional().describe('窄口径声明全文（三段：本次只做 X / 提出人可能还期待 Y / 若要 Y 的工作量）'),
        irreversibleSideEffect: z.boolean().optional().describe('测试路径是否有不可逆外部副作用（真实企微/真机/三方——测试路径也算）'),
        unsuitable: z.boolean().optional().describe('判定「不适合守航」时传 true'),
      },
      async (a) => {
        const r = reqPool.evaluateReadiness(a, a)
        const ns = a.narrowScope ? reqPool.validateNarrowScope(a.narrowScope) : null
        const L = [`【${a.req}】守航就绪判定：**${r.readinessValue}**`, '']
        if (r.ready) L.push('✅ 七项拷问全 `已知+来源`，三条硬前置齐备 —— 可置 `守航就绪=就绪`，进就绪池。')
        else {
          if (r.gaps.length) { L.push(`**就绪缺口**（写进表的「就绪缺口」多选列）：${r.gaps.join(' / ')}`); L.push(''); L.push('**该问老板什么**（一次≤3 张卡，每张带「拟定默认 + 利弊 + 不拍会怎样」）'); for (const q of r.questions) L.push(`- ${q}`) }
          if (r.hardBlockers.length) { L.push(''); L.push('**硬前置未满足**'); for (const h of r.hardBlockers) L.push(`- ${h}`) }
        }
        if (ns && !ns.ok) { L.push(''); L.push('**窄口径声明不合格（A3）**'); for (const e of ns.errors) L.push(`- ${e}`); L.push(''); L.push('模板：'); L.push('```'); L.push(reqPool.NARROW_SCOPE_TEMPLATE); L.push('```') }
        // v0.11.0：守航态里「没到就绪」≠「不能做」。上面那些「该问老板什么」是白天的问法；夜里先按三种不确定分类：
        // ①查得清 ②可以反悔 的自己解决并 record_decision，只有③才 raise_risk。否则又回到「挑无可挑」。
        if (!r.ready && run.executionMode === 'guarded_run') L.push('', '**守航态怎么读这个结果**：没到「就绪」不等于这条不能做。上面每个 open 项先分类——①查得清的自己查（翻代码/历史文档），②可以反悔的自己定（`record_decision` 记下），做完这两类它往往就够格了；**只有③反悔代价大的才 `raise_risk`**，而且只停这一条。')
        return txt(L.join('\n'))
      },
    ))
    // ---- 没有活契约时：凭老板的明确指示当场签发，不必把他赶去看板 ----
    // 缘起（2026-09-21）：`amend_contract_scope` 只解决了「往**活**契约里加一条」。老板发「继续」那一刻
    // guarded-02 已过期、根本没有活契约可改，菲菲的收工汇报仍是「重签守航契约是**看板动作、员工执行不了**」
    // ——他那句「继续」照样推不动 REQ-0367。**上一版修了一半。**
    // 安全模型与 amend 完全一致：凭据是**老板原话**；条目**只能取自当前任务档案的需求条目登记表**
    // （他放进版本的才算数，员工不能凭空把新东西签进范围）；签完必须如实报签了什么。
    // 与「引擎自动签发」的区别正在这三条：引擎自动签＝没人授权也没人知道；这里是**授权方说了、执行方照做、
    // 全程留痕**（§22.9 的判据：该问的是"谁没资格做这个决定"，而老板显然有）。
    tools.push(tool(
      'issue_contract_on_instruction',
      '【本轮没有有效守航契约、而老板已明确指示推进时用】凭他原话当场签发一份新守航契约并立刻开工，**不必让他去看板点「🌙 守航开工」**。\n⚠ 凭据必须是**他的原话**；条目**只能从当前任务档案的「需求条目登记表」里挑已存在、待推进的**（不许把登记表外的东西签进范围——那是自行扩张）。\n⚠ 他的指示若**明确到条目**（如「放行 REQ-0367 开工」）→ 直接签、签完如实报；若只是**泛泛放行**（如「继续」）→ 先用 `approval`/`decision` 卡把「我打算签这几条、截止何时」摆给他确认，**别自己替他圈范围**。\n⚠ 只在 `guard_status` 显示本会话无契约时用；有活契约要加条目走 `amend_contract_scope`。',
      {
        picks: z.array(z.string()).describe('本轮条目（REQ 编号），**必须已在任务档案登记表里**'),
        bossQuote: z.string().describe('**老板原话**（verbatim，别转述）——唯一授权凭据，原样落进契约'),
        deadline: z.string().optional().describe('截止（如 2026-09-22T08:00:00+08:00）；留空=次日 08:00 晨检时点'),
        maxRepos: z.number().optional().describe('最多改几个仓；留空=点名轮默认 3'),
        note: z.string().optional().describe('补充说明（为什么现在签、本轮打算做到哪）'),
      },
      async ({ picks, bossQuote, deadline, maxRepos, note }) => {
        const existing = guardContractFor(run)
        if (existing) return txt(`[本会话已有活契约 \`${existing.runName}\`（截止 ${existing.contract?.deadline}）—— 要加条目请用 \`amend_contract_scope\`，别重复签发。]`)
        const quote = String(bossQuote || '').trim()
        if (quote.length < 2) return txt('[拒绝：`bossQuote` 必须是老板原话。没有他的指示就签契约＝员工自行划范围＝越权。他没说就去问。]')
        const want = (Array.isArray(picks) ? picks : []).map(s => String(s).toUpperCase().trim()).filter(Boolean)
        if (!want.length) return txt('[拒绝：`picks` 不能为空。老板没点明条目时，先出卡片问他要做哪几条，别自己圈。]')
        // 条目必须已在登记表里——这条是「不得自行扩张」的机器判据
        const archiveRel = run.taskFile || ''
        const rows = archiveRel ? entryRowsByReq(archiveRel) : new Map()
        if (!rows.size) return txt(`[拒绝：读不到任务档案的需求条目登记表（${archiveRel || '本轮未挂档案'}）—— 没有登记表就无法校验条目是老板放进来的，不能签。]`)
        const missing = want.filter(r => !rows.has(r))
        if (missing.length) return txt(`[拒绝：${missing.join('、')} 不在登记表里。**只能签老板已放进本版的条目**——要新增需求，先让他在需求表/登记表里立项，别用签契约的方式把新范围塞进来。]`)
        let contract
        try {
          contract = issueGuardedContract({
            source: 'named', picks: want, maxItems: want.length, maxRepos, deadline,
            note: `${note ? String(note).trim() + '\n\n' : ''}【签发依据】本契约由 ${run.employee} 依老板在会话中的明确指示当场签发（非看板入口）。老板原话：「${flat(quote).slice(0, 300)}」`,
          })
        } catch (e) { return txt(`[签发失败：${e.message}]`) }
        run.guardContract = contract.rel; saveRegistry()
        try { const led = guardLedgerFor(contract.runName); led.startedAt = new Date().toISOString(); led.issuedOnInstruction = { by: run.employee, bossQuote: quote.slice(0, 500), at: new Date().toISOString() }; saveGuardLedger(contract.runName) } catch { }
        appendEvent(run.id, { type: 'lab', text: `🌙 依老板指示当场签发守航契约 \`${contract.rel}\`：授权 ${want.join('、')} · 截止 ${contract.deadlineIso} · 仓数上限 ${contract.repos}。\n依据（老板原话）：「${flat(quote).slice(0, 120)}${quote.length > 120 ? '…' : ''}」——已原样落进契约，晨检包会单列。` })
        return txt(`已签发 \`${contract.rel}\`（run_name \`${contract.runName}\`）。\n- 授权条目：${want.join('、')}\n- 截止：${contract.deadlineIso} · 仓数上限 ${contract.repos} · 最多 ${contract.max} 条\n- 签发依据已原样记录老板原话（契约「一、本轮意图」+ 台账 issuedOnInstruction）\n**现在可以直接开工**。收工汇报里请如实写明「本轮契约由我依你的指示当场签发、授权了哪几条」，让他早上能核。`)
      },
    ))
    // ---- 范围修订：老板当场追加条目，不必离开会话去重签 ----
    // 缘起（2026-09-20 实账 run 20260920150750-2af546，老板原话「为什么总是要我重签契约，我们是不是
    // 机械化的判定影响了需求迭代的效率？」）：那一轮 00:33 他提标签功能，00:40 答「塞进 v5.23（接受顺延
    // 重测）」+ 5 条口径，01:13 明说「**重签守航契约、放行 REQ-0367 开工**」——四次发话、每一句都是授权，
    // 而 01:25 那轮的结局是条目置「待开发」、park 台账写「卡点：待看板重签」。**他亲口说了放行，引擎的
    // 回答是"你得去看板上再点一次"。**
    // 根因是一处混淆：契约铁律写的是「**员工**不得自行扩张」，可实现上 `named_items` 是签约时写死、
    // 谁都改不了的白名单，于是「授权方自己改主意」和「AI 偷偷扩范围」被当成同一件事挡掉。
    // 这个工具把两者分开：扩张仍然禁止**员工自作主张**——凭据必须是**老板原话**（verbatim，落进契约与
    // 台账，可审计）；有原话就当场生效，不用重签。安全性不降反升：重签会让旧契约的历史就此断掉，
    // 而修订记录是连续的。
    tools.push(tool(
      'amend_contract_scope',
      '【老板当场追加/移除条目时用】把他在会话里的明确指示落成契约授权，**不必让他去看板重签**。必须引**他的原话**作凭据——没有原话就是你自行扩张（越权）。追加会写进契约「四、范围修订记录」+ 台账，晨检包单列。\n⚠ 只在老板**明确指示做某条**时用；他只是在讨论、问可行性、或你自己觉得该做，都**不算**——那些仍走 park 或问他。\n⚠ 版本已达 RC_READY 时追加会拖住已可发的条目：必须先把代价讲清并拿到他的认可（`acceptsDelay=true` 且原话里要有「接受顺延/接受重测」这类表态），否则本工具拒绝。',
      {
        req: z.string().describe('条目编号，如 REQ-0367'),
        action: z.enum(['add', 'remove']).optional().describe('默认 add'),
        bossQuote: z.string().describe('**老板原话**（verbatim，别转述别润色）——这是唯一的授权凭据，会原样落进契约与台账'),
        acceptsDelay: z.boolean().optional().describe('版本已达 RC_READY 时必填 true：老板已知晓"会拖住已可发的条目"并接受'),
        note: z.string().optional().describe('补充说明（如为什么现在追加、影响哪些已达 RC_READY 的条目）'),
      },
      async ({ req, action, bossQuote, acceptsDelay, note }) => {
        const c = guardContractFor(run)
        if (!c) return txt('[本会话不在守航态、或本轮没有有效守航契约 —— 范围修订只对活着的契约有意义。没有契约时请老板走看板「🌙 守航开工」签一份。]')
        const key = String(req || '').toUpperCase().trim()
        if (!/^REQ-\d+/.test(key)) return txt(`[条目编号不合法：${req}]`)
        const quote = String(bossQuote || '').trim()
        if (quote.length < 4) return txt('[拒绝：`bossQuote` 必须是老板原话。没有原话的追加＝你自行扩张＝越权（契约铁律）。他没明说就去问，别替他决定。]')
        const act = action === 'remove' ? 'remove' : 'add'
        // RC_READY 闸：拖住已可发的条目是真代价（v5.19 三条被拖 4 天），要老板知情
        const archiveRel = guardArchiveRelFor(run, c)
        let versionState = ''
        try { const t = fs.readFileSync(safeResolve(archiveRel), 'utf8'); versionState = versionReport.deriveVersionState(parseFrontmatter(t) || {}, extractEntries(t)) } catch { }
        const atRc = ['rc_ready', 'released_test', 'released_prod'].includes(versionState)
        if (act === 'add' && atRc && acceptsDelay !== true) {
          return txt(`[拒绝追加：版本当前 **${versionState}**（已达 RC_READY 边界），把 ${key} 并进来会让已经能发的条目一起等（v5.19 实账：3 条已 RC_READY 被拖了 4 天）。\n先把这个代价讲给老板、拿到他明确认可，再带 \`acceptsDelay=true\` + 他那句认可的原话重调。**别替他接受这个代价。**]`)
        }
        let out
        try { out = amendContractScope(c, { req: key, action: act, bossQuote: quote, acceptsDelay: !!acceptsDelay, note, by: run.employee }) }
        catch (e) { return txt(`[范围修订写入失败：${e.message}]`) }
        const led = guardLedgerFor(c.runName)
        if (led) {
          led.scopeAmendments = led.scopeAmendments || []
          led.scopeAmendments.push({ at: new Date().toISOString(), req: key, action: act, bossQuote: quote.slice(0, 500), acceptsDelay: !!acceptsDelay, by: run.employee, versionState })
          saveGuardLedger(c.runName)
        }
        appendEvent(run.id, { type: 'lab', text: `📝 守航契约范围修订：${act === 'add' ? '追加' : '移除'} **${key}**（依据老板原话：「${oneLine(quote).slice(0, 80)}${quote.length > 80 ? '…' : ''}」${atRc ? ' · 已确认接受顺延' : ''}）。契约 \`${c.runName}\` 现授权：${out.named.join('、') || '（未点名）'}。` })
        return txt(`已${act === 'add' ? '追加' : '移除'} ${key}，契约 \`${c.runName}\` 的 named_items 现为 [${out.named.join(', ')}]。\n修订记录已写进契约「四、范围修订记录」（带老板原话）+ 台账，晨检包会单列。\n**现在 ${key} 在授权内，可以直接开工**——不必再等重签。`)
      },
    ))
    tools.push(tool(
      'selection_done',
      '【守航自选轮：挑完需求就调一次】告诉引擎「这一轮我挑完了」：挑了哪几条、为什么没挑更多（剩下的各属于哪类：③类高危要老板拍 / 风险 high 只做方案 / 依赖没到位 / 与其他条目冲突…）。**不调它，目标循环会认为你还在挑、一直派你回来**；挑 0 条也要调，并把原因说清。',
      {
        picked: z.array(z.string()).describe('本轮挑中的条目（REQ 编号），可为空数组'),
        why: z.string().describe('为什么只挑这些：没挑的逐类说明（大白话）'),
      },
      async ({ picked, why }) => {
        const c = guardContractFor(run)
        const led = c ? guardLedgerFor(c.runName) : null
        if (!led) return txt('[本会话不在守航态、或本轮没有有效守航契约]')
        const list = (picked || []).map(s => String(s).toUpperCase().trim()).filter(s => /^REQ-\d+/.test(s))
        led.selection = { done: true, picked: list, why: String(why || '').trim(), at: new Date().toISOString(), by: run.employee }
        for (const r of list) if (!led.itemResults?.[r]) guardLedger.recordItemResult(led, r, { result: 'in_progress', employee: run.employee })
        saveGuardLedger(c.runName)
        return txt(`已记：本轮挑中 ${list.length} 条（${list.join('、') || '无'}）。目标循环从现在起按这些条目判「干完没」。`)
      },
    ))
    tools.push(tool(
      'park_item',
      '【只给「反悔代价大、只有老板能定」的事用】把一条需求暂停进台账（原因 / 卡在哪 / 拟定口径）。**守航态下可以反悔的事不许 park**——自己定、用 record_decision 记下来；要老板拍的高危事项优先用 raise_risk（它能让老板在验收卡上一键选路）。同一条 park ≥2 轮自动进必答区。',
      {
        req: z.string().describe('需求编号'),
        reason: z.string().describe('为什么 park（具体到卡在哪）'),
        probeKey: z.string().optional().describe('卡在七项拷问的哪一项：来源/口径/边界/范围/依赖/可测性/影响面'),
        proposal: z.string().describe('你的拟定口径（老板不拍时的默认执行值）——**必填**：没有它老板没法一句话推动'),
        onlyBossBecause: z.string().optional().describe('**守航态必填**：为什么这件事只有老板能定、而且反悔代价大（做错了没法一小时内改回去的理由）'),
      },
      async ({ req, reason, probeKey, proposal, onlyBossBecause }) => {
        const c = guardContractFor(run)
        const led = c ? guardLedgerFor(c.runName) : null
        // 三种不确定的机器闸（v0.11.0）：守航态 park 必须说清「为什么只有老板能定」。说不出 = 它是①②类，该自己定。
        // 缘起：自选的 4 轮守航 0 条开工、每轮 park 6~8 条——大多数 park 的理由其实查得清或可以反悔（§23）。
        if (run.executionMode === 'guarded_run' && String(onlyBossBecause || '').trim().length < 6) {
          return txt(`[park 未记：守航态下 park 只给「反悔代价大、只有老板能定」的事。请在 \`onlyBossBecause\` 写清为什么（做错了为什么没法一小时内改回去）。\n写不出来，说明它是①查得清的或②可以反悔的——**自己定、做出来**，用 \`record_decision\` 记下「我替你定了什么、不满意改成什么」。\n\n${acceptanceCard.UNCERTAINTY_RULES}]`)
        }
        // 前置校验：已经在测/已过检的条目不许再 park —— park 的对象是「没人拍所以推不动」，
        // 而它已经在推进了。真冒出了新问题，就用新编号或换个说法，别把台账搅成一锅。
        const row = entryRowsByReq(guardArchiveRelFor(run, c)).get(String(req).toUpperCase())
        if (reqPool.shouldSkipDefer(row)) return txt(`[park 未记：登记表里 ${String(req).toUpperCase()} 已是「${row.status}」（已进 QA 及以后），不该再 park。\n若是实施中新冒出的口径问题，请写清「条目在测但 X 口径待拍」并用 \`append_timeline\` 记一笔，或按新需求另开编号。]`)
        const store = loadParkLedger()
        const r = reqPool.recordPark(store, { req, reason, probeKey, proposal, kind: reqPool.PARK_KIND.AMBIGUITY })
        if (r.error) return txt(`[park 未记：${r.error}]`)
        saveParkLedger(r.entries)
        // needsBoss：通过了上面「只有老板能定」的闸 → 目标循环把它算「等老板」，不再派人回来重判
        if (led) {
          guardLedger.recordItemResult(led, req, { result: 'parked', force: true, stopWhy: reason, proposal, probeKey, needsBoss: run.executionMode === 'guarded_run' ? true : undefined, onlyBossBecause: onlyBossBecause || undefined })
          // 守航态的 park 同时落成一件「高危事项」：老板在验收卡上**只有这一个入口**做决定（一键选「按拟定口径做 / 先不做」），
          // 不然 park 又会变回一张只进不出的纸（§22.2 的病）。
          if (run.executionMode === 'guarded_run') acceptanceCard.raiseRisk(led, { req, what: reason, why: onlyBossBecause, options: [`按拟定口径做：${flat(proposal)}`, '这条先不做'], recommend: '按拟定口径做', source: 'park' }, run.employee)
          saveGuardLedger(c.runName)
        }
        const e = r.entry
        return txt(`已入 park 台账：${e.req}（第 ${e.rounds} 轮）${r.escalate ? ' → **已升级为晨检必答区**（≥2 轮）' : ''}${e.repeatedProposal ? '\n\n⚠ 你这轮的拟定口径与上轮**一字未变** —— 晨检包会照实点明「不是想不出，是没人拍」，这正是要老板看见的信号。' : ''}`)
      },
    ))
    tools.push(tool(
      'cross_entry_facets',
      '【改动落在被复用组件上时必跑】从 UI 契约图谱自动生成「跨入口一致性」facet：凡改动落在被 **≥2 个入口复用**的组件上，就生成一条「同一份数据在这 N 个入口表现一致」的 facet（带 consistencyGroup 供迷糊用猪猪跑）。**这是「部位顺序四入口三套序、老板一句话报出来」那个逃逸缺陷的直接解药。**',
      {
        req: z.string().describe('需求编号（生成的 facet ID 用它做前缀）'),
        touched: z.array(z.string()).describe('本次改动落在哪些组件/testid 上'),
        startIndex: z.number().optional().describe('facet 序号从几开始（接着现有 facet 表的最大序号+1）'),
      },
      async ({ req, touched, startIndex }) => {
        const em = await zhuzhuEntryMap()
        const gen = reqPool.crossEntryFacets(em.components, touched, { reqId: req, startIndex: startIndex || 1 })
        return txt(reqPool.renderCrossEntryFacets(gen) + (em.available ? `\n\n> 入口图谱来源：${em.source || 'zhuzhu'}` : `\n\n> ⚠ 入口图谱不可用（${em.why}）——无法自动生成横向 facet，请人工枚举入口后手写，并在 facet 表分类列标 \`cross-entry\`。`))
      },
    ))
  }

  // ---- 两位 QA：C1 / C3 / C4 / C5 / C6 / C7 ----
  if (emp === 'mihu' || emp === 'feisila') {
    tools.push(tool(
      'preflight_gates',
      '【开跑前必跑】猪猪 Z-L **无人值守准入探针**：workspace 可写 / 磁盘 / CPU 内存与并发建议 / 服务发现 / app-run 与 headless 两条通道 / 前端可达 / auth profile / 孤儿会话。`fail` = 今晚别开跑，`warn` = 能跑但会费时间（每条都带 fix）。**它不查页面报错/视觉基线**——那两道门的真实落点在 run summary（`pageErrors` / `visualReview`），跑完用 `visual_acceptance`、`verify_green_evidence` 看；环境新鲜度用本工具返回里的指纹段或在用例 `settings.freshness` 里挂 `requireChangedSince`（猪猪跑中拦成 blocked）。',
      { baseUrl: z.string().optional().describe('被测环境地址（不传就只查本机就绪项，不查前端可达）') },
      async ({ baseUrl }) => {
        const target = baseUrl || zhuzhuConfig.targetBaseUrl || ''
        const r = await zhuzhuCaps.admissionProbe({ baseUrl: target }, zzOpts())
        if (r.ok === null) return txt(`⚠ **准入探针开不了**：${r.degraded.map(d => d.why).join('；')}\n\n口径（硬）：探针开不了 ≠ 环境没问题。本轮结论只能记「未验证」，别在报告里写「环境正常」。`)
        const L = []
        L.push(r.ok ? `✅ 准入探针通过（${r.verdict || 'ready'}）：${r.message || '可以开跑'}` : `⛔ 准入未过 ${r.blocking.length} 项 —— **先修再跑**（这时候跑出来的红全是噪音，42 个红里产品缺陷 0 就是这么来的）`)
        for (const b of r.blocking) L.push(`- ⛔ [${b.gate}] ${b.why}${b.fix ? `　→ ${b.fix}` : ''}`)
        for (const w of r.warnings) L.push(`- ⚠ [${w.gate}] ${w.why}${w.fix ? `　→ ${w.fix}` : ''}`)
        if (r.recommendedConcurrency) L.push(`\n建议并发：**${r.recommendedConcurrency}** —— run_e2e_batch 别超过它，否则渲染进程 OOM 会把整批变成假红。`)
        L.push('\n> 另两道门不在这里：页面报错门看 run summary 的 `pageErrors`（**null ≠ 0**，null 是「收集器没跑过」）；视觉基线门跑完用 `visual_acceptance`。')
        return txt(L.join('\n'))
      },
    ))
    tools.push(tool(
      'verify_green_evidence',
      '【置 GREEN 后 / 收工前跑】用猪猪 `verify_evidence` 核验本版每条 GREEN 的证据包，并按**结构判据**判 RED 校准：只认 `failureClass === "value-assertion"`（C7）。**中文标题不再影响判定** —— 你不必再给中文步骤标题硬加 `assert`；同时「把动作失败包装成断言失败」这条后门也关掉了。核验结果直接喂 guard.fake_green。',
      {},
      async () => {
        const rows = mergeFacetRowsForRun(run)
        if (!rows) return txt('[取不到覆盖矩阵——先确认任务档案与 facet_doc 就位]')
        const greens = rows.filter(r => String(r.status).toUpperCase() === 'COVERED_GREEN')
        if (!greens.length) return txt('本版还没有 COVERED_GREEN 行，无可核验。')
        const items = greens.map(r => ({ facetId: r.facetId, runId: r.green?.runId || '', caseId: r.green?.case || '' }))
        const v = await zhuzhuCaps.verifyEvidenceBatch(items, zzOpts())
        run._verifyMap = v.available ? v.map : null
        const fg = guardLedger.deriveFakeGreen(rows, run._verifyMap)
        const c = guardContractFor(run)
        if (c) { const led = guardLedgerFor(c.runName); led.fakeGreen = fg; saveGuardLedger(c.runName) }
        const L = [`核验 ${greens.length} 条 GREEN：假绿 **${fg.count}**、未验证 **${fg.unverified.length}**`, '']
        if (!v.available) L.push(`⚠ 猪猪 \`verify_evidence\` 不可用（${v.why}）→ 只做了引擎能做的一半（证据字段完整性 + 哈希）。**未验证不等于通过**，报告里必须如实写。`)
        if (fg.hits.length) { L.push(''); L.push('**假绿明细（必须修，不是提醒）**'); for (const h of fg.hits) L.push(`- ${h.facetId}：${h.why}`) }
        if (fg.unverified.length) { L.push(''); L.push('**未验证**'); for (const h of fg.unverified.slice(0, 20)) L.push(`- ${h.facetId}：${h.why}`) }
        for (const r2 of greens) {
          const cal = zhuzhuCaps.classifyRedCalibration(run._verifyMap ? run._verifyMap[r2.facetId] : null)
          if (cal.verdict !== zhuzhuCaps.RED_CALIBRATED) { L.push(''); L.push(`RED 校准 · ${r2.facetId}：**${cal.verdict}** —— ${cal.why}`) }
        }
        return txt(L.join('\n'))
      },
    ))
    tools.push(tool(
      'visual_acceptance',
      '视觉 / UX 验收（C3）：读**指定 run 的视觉素材包**（`summary.visualReview`，即猪猪的 `visual-review.json`：截图 + 盒模型 + 设计 token + 同族差异 + 无障碍要点 + 截断检测），给三档结论 —— 符合同族基线 / 与同族不一致（列差异）/ 明显缺陷（截断·对比度不足·点击区过小）。\n\n**前置（否则这里只会返回「未做」）**：素材是用例挂了断言才有的 —— 视觉基线用 `assertVisual`（`baseline` 键 + `mask` 遮罩动态区；**首跑没基线判 `visual-no-baseline` 不算过**），同族对比用 `assertVisualPeers`（`peers` 指隔壁模块，只有列进 `mustMatch` 的 token 才判红）。**边界**：机器只出量化差异，「好不好看」终审仍是老板；但「和隔壁不一致」「字被挤换行」「底部截断」这类**必须机器拦住**。',
      {
        sessionId: z.string().optional().describe('headless 的 sessionId（引擎替你反查它各轮的 run 目录）'),
        runDir: z.string().optional().describe('或直接给 run 输出目录（含 summary.json），绝对路径或相对仓库根，如 vision-e2e/output/runs/<...>'),
      },
      async ({ sessionId, runDir }) => {
        // 素材在磁盘的 `<run 目录>/summary.json`，不在会话信封里（2026-09-07 实测坐实）
        let dirs = []
        if (runDir) {
          try { const a = path.isAbsolute(runDir) ? path.resolve(runDir) : path.resolve(ROOT, runDir); dirs = [a] } catch { return txt('[runDir 路径非法]') }
        } else if (sessionId) {
          const r = await zhuzhuCaps.sessionRunDirs(sessionId, zzOpts())
          if (!r.available) return txt(`⚠ **反查不到该会话的 run 目录**：${r.why}\n\n拿不到就是「未做视觉验收」，不许当通过。`)
          dirs = r.dirs
        } else return txt('[要么给 sessionId、要么给 runDir]')
        const pairs = dirs.map(d => ({ dir: d, summary: readRunSummaryAt(d) })).filter(x => x.summary)
        if (!pairs.length) return txt(`⚠ **读不到 summary.json**（找过 ${dirs.length} 个目录：${dirs.join(' / ')}）——按「未做视觉验收」记，不许当通过。`)
        const outputRoot = await zhuzhuOutputRoot()
        const reviews = pairs.map(x => readVisualReviewArtifact(x.summary, { outputRoot, runDir: x.dir }))
        const items = reviews.flatMap(r => r.items || [])
        const v = qaCard.visualAcceptance(items.length ? { available: true, items } : (reviews.find(r => r.attached) || reviews[0]))
        const summaries = pairs.map(x => x.summary)
        // **覆盖度必须显式说**：一个会话里常常只有一部分 run 出了素材（如首跑 3 条判 no-baseline、
        // 只有 peers 那条有素材）。只印结论不印分布，读起来像「全验了」——那是漏报，不是简洁。
        const withMat = reviews.filter(r => (r.items || []).length).length
        const attachedNoMat = reviews.filter(r => r.attached && !(r.items || []).length).length
        const notAttached = reviews.filter(r => !r.attached).length
        // §3.132 足迹：记「调过 + 拿到多少素材」，收工时 C3.8 声明门要用（调了没素材 ≠ 机器够不到）
        noteVisualAttempt(run.id, { sessionId: sessionId || path.basename(dirs[0] || ''), items: items.length, attachedNoMaterial: attachedNoMat })
        const cov = [`本次覆盖：${pairs.length} 个 run —— **${withMat} 个有可判素材**`]
        if (attachedNoMat) cov.push(`${attachedNoMat} 个**挂了断言但无素材**（多为首跑判 \`visual-no-baseline\`，录了基线不算过；再跑一趟即可判）`)
        if (notAttached) cov.push(`${notAttached} 个**一条视觉断言都没挂**（这几条等于没做视觉验收）`)
        const pe = zhuzhuCaps.pageErrorsFromSummary(summaries[0])
        const peLine = pe.available
          ? `**${pe.count}** 处判红${pe.total ? `（共采集 ${pe.total}、allowlist 静音 ${pe.suppressed}）` : ''}${pe.policy ? ` · policy=${pe.policy}` : ''}${pe.why ? ` ${pe.why}` : ''}${pe.count && pe.samples.length ? `——${pe.samples.join(' / ')}` : ''}`
          : `未验证（${pe.why}）`
        return txt(`${qaCard.renderVisualAcceptance(v)}\n\n> ${cov.join('；')}。\n> 顺带（同一份 summary）：页面报错 ${peLine}`)
      },
    ))
    // ---- 以示例项目模块页面为标准 + 审美判定（2026-09-07 老板定）----
    // 三件工具对应三层：build 立标准 → conformance 量偏离 → aesthetic_review/verdict 出审美结论。
    tools.push(tool(
      'design_baseline_build',
      '【立标准·先跑采样套件再用它】把若干 run 的视觉素材汇总成**示例项目模块设计基线**：同类元素（主按钮/次按钮/表格/弹窗/页签…按 testid 命名约定分类）的规范 token 值，由「模块里多数同类元素是什么」**数出来**，不是谁拍的阈值。落盘 `docs/示例项目需求/00-通用资料/示例项目-视觉设计基线.json`。\n\n**这一步换掉了旧标准**：`assertVisual` 的像素基线比的是「元素自己的上一次」，只能证明「没变」；模块基线比的是「示例项目这套页面长什么样」，能回答「这个新元素像不像这个模块的东西」。采样套件用法：一页挑若干代表元素做一次 `assertVisualPeers`（`mustMatch` 留空 → 只出素材不判红），一步采齐整页 token。',
      {
        sessionIds: z.array(z.string()).describe('采样跑的 session id（可多个，越多越可信）'),
        write: z.boolean().optional().describe('true=落盘（默认只预览不写）'),
      },
      async ({ sessionIds, write }) => {
        const outputRoot = await zhuzhuOutputRoot()
        const items = [], runIds = []
        for (const sid of sessionIds) {
          const rd = await zhuzhuCaps.sessionRunDirs(sid, zzOpts())
          if (!rd.available) return txt(`⚠ 反查不到 ${sid} 的 run 目录：${rd.why}`)
          for (const d of rd.dirs) {
            const sm = readRunSummaryAt(d)
            if (!sm) continue
            const rv = readVisualReviewArtifact(sm, { outputRoot, runDir: d })
            items.push(...(rv.items || []))
            runIds.push(path.basename(d))
          }
        }
        if (!items.length) return txt('⚠ 这些会话里**一条视觉素材都没有** —— 采样套件必须挂 `assertVisualPeers`/`assertVisual` 才会产素材（没挂 = 没采到，不是"模块没规范"）。')
        const b = designBaseline.buildDesignBaseline(items, { module: '示例项目', runIds })
        let saved = ''
        if (write) {
          try {
            fs.mkdirSync(path.dirname(DESIGN_BASELINE_FILE), { recursive: true })
            fs.writeFileSync(DESIGN_BASELINE_FILE, JSON.stringify({ ...b, generatedAt: new Date().toISOString() }, null, 2))
            saved = DESIGN_BASELINE_FILE
          } catch (e) { saved = `（落盘失败：${String(e?.message || e)}）` }
        }
        const low = Object.keys(b.byClass).filter(c => designBaseline.baselineConfidence(b, c).level === 'low')
        return txt([
          designBaseline.renderBaselineSummary(b),
          saved ? `\n已落盘：\`${saved}\`` : '\n（预览未落盘；确认无误后带 `write: true` 再跑一次）',
          low.length ? `\n⚠ 样本不足的类别（< ${designBaseline.MIN_CLASS_SAMPLES} 个）：${low.map(c => designBaseline.classLabel(c)).join('、')} —— 这些类**先别拿去判人**，扩采样后再用。` : '',
        ].filter(Boolean).join('\n'))
      },
    ))
    tools.push(tool(
      'design_conformance',
      '【量偏离】拿本轮素材跟**模块设计基线**比，出两节可测结论：① 与模块规范的一致性（「模块里 12/13 个同类是 2px，这个是 8px」）；② 设计系统量化指标（尺寸有没有落在模块刻度上、字号/圆角/色彩用量、同一视觉行有没有错位）。**这是审美的可测代理：不需要品味也能算，且能解释自己。** 基线缺位时如实说「判不了」，不静默放过。',
      { sessionId: z.string().describe('本轮的 session id') },
      async ({ sessionId }) => {
        const outputRoot = await zhuzhuOutputRoot()
        const rd = await zhuzhuCaps.sessionRunDirs(sessionId, zzOpts())
        if (!rd.available) return txt(`⚠ 反查不到 run 目录：${rd.why}`)
        const items = rd.dirs.flatMap(d => { const sm = readRunSummaryAt(d); return sm ? (readVisualReviewArtifact(sm, { outputRoot, runDir: d }).items || []) : [] })
        noteVisualAttempt(run.id, { sessionId, items: items.length, attachedNoMaterial: items.length ? 0 : rd.dirs.length })
        if (!items.length) return txt('⚠ 本轮**没有视觉素材**（用例没挂视觉断言，或那趟判了 `visual-no-baseline`）——按「未做」记，不许当通过。')
        const base = loadDesignBaseline()
        const j = designBaseline.judgeAgainstBaseline(items, base)
        const c = designBaseline.designConformance(items, base)
        return txt(`${designBaseline.renderBaselineJudgement(j)}\n\n${designBaseline.renderConformance(c)}`)
      },
    ))
    tools.push(tool(
      'aesthetic_review',
      '【出审美意见·第 1 步：取素材】给你本轮截图 + 模块参照截图 + 机器已算出的偏离清单 + **rubric（八个维度：层级/同族相似度/间距节奏/对齐/密度/色彩语义/状态可辨/文案合身）**。**你必须真的去看那些图**，然后用 `aesthetic_verdict` 提交三档结论。\n\n口径：这一层是**判断不是测量**，老板终审、可一票否决；**但「审美归老板」不再是收工理由——你必须先出意见。** 每条意见必须指认元素 + 引用实测值 + 给可执行建议，否则机器会当读后感打回。',
      { sessionId: z.string().describe('本轮的 session id'), referenceSessionId: z.string().optional().describe('可选：作为"模块参照"的采样会话 id（拿示例项目其它页面当比较对象）') },
      async ({ sessionId, referenceSessionId }) => {
        const outputRoot = await zhuzhuOutputRoot()
        const collect = async sid => {
          const rd = await zhuzhuCaps.sessionRunDirs(sid, zzOpts())
          if (!rd.available) return { items: [], shots: [] }
          const items = [], shots = []
          for (const d of rd.dirs) {
            const sm = readRunSummaryAt(d)
            if (!sm) continue
            items.push(...(readVisualReviewArtifact(sm, { outputRoot, runDir: d }).items || []))
            for (const st of (sm.steps || [])) if (st.afterScreenshotPath) shots.push(st.afterScreenshotPath)
            for (const it of (readVisualReviewArtifact(sm, { outputRoot, runDir: d }).items || [])) if (it.actualImagePath) shots.push(it.actualImagePath)
          }
          return { items, shots }
        }
        const me = await collect(sessionId)
        noteVisualAttempt(run.id, { sessionId, items: me.items.length, attachedNoMaterial: me.items.length ? 0 : 1 })
        if (!me.items.length && !me.shots.length) return txt('⚠ 本轮既没素材也没截图 —— 先让用例挂上视觉断言（见 `visual_acceptance` 的前置说明）。')
        const ref = referenceSessionId ? await collect(referenceSessionId) : { shots: [] }
        const base = loadDesignBaseline()
        const j = designBaseline.judgeAgainstBaseline(me.items, base)
        const c = designBaseline.designConformance(me.items, base)
        // 看图门：记下发出去的清单（素材页只印前 12 张，就按这 12 张核），verdict 时核「看够了没有」
        const listed = { shots: [...new Set(me.shots)].slice(0, 12), refs: [...new Set(ref.shots)].slice(0, 12) }
        const byS = aestheticListed.get(run.id) || new Map(); byS.set(sessionId, listed); aestheticListed.set(run.id, byS)
        return txt(designBaseline.renderAestheticMaterial({
          screenshots: [...new Set(me.shots)], referenceShots: [...new Set(ref.shots)],
          deviations: j.deviations, offScale: c.offScale, misaligned: c.misaligned,
        }))
      },
    ))
    tools.push(tool(
      'aesthetic_verdict',
      '【出审美意见·第 2 步：提交结论】三档：`符合模块设计语言` / `可接受但有偏离` / `明显不协调`。**机器逐条校验证据**：`rubricKey` 必须在 rubric 内、`selector` 必须是本轮素材里真实采到的元素、`fact` 必须是该元素上的实测值或对应一条量化偏离、`suggestion` 必须可执行。**挂不上证据的意见一律打回、不进结论**——这是审美判定与"AI 拍脑袋说不好看"的唯一分界线。判了非「符合」档却零证据 → 直接报错。**看图门（2026-10-06）**：`aesthetic_review` 列给你的截图至少 Read 一半、母版参照至少一张，`observations` 八维逐条写看到了什么——判「符合」也一样，盖章式零发现会被打回。',
      {
        sessionId: z.string().describe('本轮的 session id（用于取回素材做证据校验）'),
        verdict: z.string().describe('三档之一：符合模块设计语言 / 可接受但有偏离 / 明显不协调'),
        findings: z.array(z.object({
          rubricKey: z.string().describe('rubric 维度：hierarchy/family/rhythm/alignment/density/color/state/copy-fit'),
          selector: z.string().describe('指认的元素（testid 或 [data-testid="…"]），必须是本轮真实采到的'),
          fact: z.string().describe('该元素上的实测值或引用的量化偏离，如「borderRadius=8，模块里 4/4 个同类是 2」'),
          opinion: z.string().optional().describe('你的判断（人话）'),
          suggestion: z.string().describe('可执行建议，开发照着能改'),
        })).describe('逐条发现；判「符合」档可为空数组'),
        observations: z.record(z.string(), z.string()).optional().describe('**必填（2026-10-06 起）**：八个 rubric 维度逐条写「看到了什么」，键为 hierarchy/family/rhythm/alignment/density/color/state/copy-fit，每条一句具体观察（如「主按钮在右上、与母版同位」）；「无/正常/符合」这类空话打回。判「符合」也要逐维写——零发现必须是看过之后的结论'),
      },
      async ({ sessionId, verdict, findings, observations }) => {
        const outputRoot = await zhuzhuOutputRoot()
        const rd = await zhuzhuCaps.sessionRunDirs(sessionId, zzOpts())
        if (!rd.available) return txt(`⚠ 反查不到 run 目录，无法校验证据：${rd.why}`)
        const items = rd.dirs.flatMap(d => { const sm = readRunSummaryAt(d); return sm ? (readVisualReviewArtifact(sm, { outputRoot, runDir: d }).items || []) : [] })
        const base = loadDesignBaseline()
        const j = designBaseline.judgeAgainstBaseline(items, base)
        const c = designBaseline.designConformance(items, base)
        const val = designBaseline.validateAestheticVerdict({ verdict, findings }, { items, deviations: j.deviations, offScale: c.offScale, misaligned: c.misaligned })
        // 看图门 + 逐维作答（2026-10-06）：清单取本轮 aesthetic_review 发出去的那份；没先取素材就交结论 → 打回
        const listed = aestheticListed.get(run.id)?.get(sessionId)
        const dil = listed
          ? designBaseline.checkAestheticDiligence({ observations }, { listedShots: listed.shots, referenceShots: listed.refs, readShots: imageReads.get(run.id) || [] })
          : { ok: false, errors: ['本轮没对这个 sessionId 调过 `aesthetic_review` 取素材——先取素材、看图，再交结论'] }
        const ok = val.ok && dil.ok
        if (ok) {   // C3.13 UI 视觉验收门要用：本轮有一份被接受的审美结论
          const f = visualFootprint.get(run.id) || { attempts: 0, withMaterial: 0, attachedNoMaterial: 0, itemCount: 0, sessions: [], materialSessions: [] }
          f.aestheticAccepted = (f.aestheticAccepted || 0) + 1
          visualFootprint.set(run.id, f)
        }
        const md = designBaseline.renderAestheticVerdict({ verdict, findings }, val)
        const dilMd = dil.ok
          ? `\n\n✅ 看图门：素材 ${dil.listed} 张、看了 ${dil.seen} 张（要求 ≥ ${dil.need}）；八个维度逐条有观察。`
          : `\n\n${dil.errors.map(e => `⛔ ${e}`).join('\n')}`
        return txt(ok ? md + dilMd : `${md}${dilMd}\n\n⛔ **本条结论未被接受**（上面列了原因）——改完重新提交。`)
      },
    ))
    // ---- 视觉初筛：开发完、迷糊正式 QA 前的一道（2026-10-06 老板定，见 visual-prescreen.js 缘起；2026-10-22 起人工预检门撤销，初筛通过直接进 QA）----
    tools.push(tool(
      'visual_prescreen',
      '【视觉初筛·第 1 步：取母版 + 诊断维度】GG Bond 开发完、你做正式 QA **之前**，你用真实浏览器把每个改动页面/状态截图，带 `pages` 调本工具：返回**示例项目母版**（各型页面的真实截图 + 要点）+ 模块 token 基线 + **11 个业内诊断维度**（Nielsen / WCAG / Ant Design / no-slop）。然后你必须 Read 每张页面截图、至少一张母版截图，逐页逐维写出看到了什么，用 `visual_prescreen_verdict` 交结论。不锁猪猪会话——初筛阶段还没写用例，任意截图都能吃。',
      {
        pages: z.array(z.object({
          page: z.string().describe('页面/状态名，如「核对页·利润率浮层展开」'),
          screenshot: z.string().optional().describe('截图绝对路径'),
        })).optional().describe('本次要初筛的页面（可先空着调一次只取母版和维度）'),
      },
      async ({ pages }) => {
        const mother = loadUiMother()
        const base = loadDesignBaseline()
        const baselineSummary = base ? `**模块 token 基线**：${base.sampleCount} 个元素样本（${Object.values(base.byClass || {}).map(v => `${v.label} ${v.n}`).join('、')}）——数值类偏差可当佐证，样本少的类只当线索。` : ''
        return txt(prescreen.renderPrescreenMaterial({ pages: pages || [], mother, motherPath: path.relative(ROOT, UI_MOTHER_FILE).replace(/\\/g, '/'), baselineSummary }))
      },
    ))
    tools.push(tool(
      'visual_prescreen_verdict',
      '【视觉初筛·第 2 步：交结论】两档：`通过`（直接进你的正式 QA；本版约定老板亲测时交老板亲测）/ `打回`（交 GG Bond 改）。**机器逐条校验**：每页截图本轮必须真被 Read 过（引擎从工具流记账）；母版有截图时至少看过一张；每页对每个诊断维度写一句看到了什么（空话打回）；每条发现要有 页面+维度+看到的+本该+依据（母版哪型/业内哪条）+建议；有「高」危只能判打回。通过校验后自动追加到版本目录的《视觉初筛记录.md》并记一笔时间线。**人工预检门已撤（2026-10-22 老板定）**：通过后别再写【等你拍板】人工预检；只有本版约定「老板亲测、迷糊不做 QA」时，本轮有一份被接受的「通过」，你写的 `【等你拍板】老板亲测` 才会被引擎当作合法收工。',
      {
        verdict: z.string().describe('通过 / 打回'),
        pages: z.array(z.object({
          page: z.string(),
          screenshots: z.array(z.string()).describe('这一页（状态）的截图绝对路径，本轮都要 Read 过'),
          notes: z.record(z.string(), z.string()).describe('诊断维度 key → 看到了什么（11 个维度都要写，见 visual_prescreen 的清单）'),
        })),
        findings: z.array(z.object({
          page: z.string(), dimension: z.string(), severity: z.string().optional().describe('高/中/低，缺省取维度默认'),
          observed: z.string(), expected: z.string(),
          reference: z.string().describe('依据：母版型号（如 mother:drawer-form）或业内准则（如 WCAG 1.4.10）'),
          suggestion: z.string(),
        })).describe('逐条发现；判「通过」且无发现时传空数组'),
        round: z.number().optional().describe('第几轮初筛（同一版本 GG Bond 改完再筛就 +1）'),
      },
      async ({ verdict, pages, findings, round }) => {
        const mother = loadUiMother()
        const motherShots = mother ? mother.patterns.flatMap(p => p.shots) : []
        const val = prescreen.validatePrescreenVerdict({ verdict, pages, findings }, { readShots: imageReads.get(run.id) || new Set(), motherShots })
        const md = prescreen.renderPrescreenVerdict({ verdict, pages }, val, { motherMissing: !motherShots.length })
        if (!val.ok) return txt(`${md}\n\n⛔ **本次初筛结论未被接受**——改完重新提交。`)
        run.prescreen = { verdict, at: new Date().toISOString(), pages: val.pages, counts: val.counts, round: round || 1 }
        saveRegistry()
        let saved = ''
        const rel = run.taskFile ? prescreenRecordPathFor(run.taskFile) : ''
        if (rel) {
          try {
            const abs = safeResolve(rel)
            const head = fs.existsSync(abs) ? '' : '# 视觉初筛记录\n\n> 正式 QA 前，迷糊对照示例项目母版 + 业内准则做的视觉初筛（工牌 §C3.12）。每一轮追加一段，新的在下面。\n'
            fs.appendFileSync(abs, `${head}\n---\n\n## 第 ${round || 1} 轮 · ${run.prescreen.at.slice(0, 16).replace('T', ' ')} UTC · 会话 ${run.id}\n\n${md}\n`, 'utf8')
            saved = rel
            appendTimelineLine(run.taskFile, `迷糊视觉初筛第 ${round || 1} 轮：${verdict}（${val.pages} 页，高 ${val.counts.高} / 中 ${val.counts.中} / 低 ${val.counts.低}），记录 ${rel}`)
          } catch (e) { saved = `（落盘失败：${String(e?.message || e)}）` }
        }
        const next = verdict === prescreen.PRESCREEN_VERDICTS.PASS
          ? '下一步（人工预检门已撤，2026-10-22 老板定）：把条目置 `待QA`（阶段「视觉初筛通过 → 迷糊：正式 QA」），中/低危发现写进实施记录 / QA 报告「已知小问题」，**本会话直接接着做正式 QA**（做不完收工写 `【下一棒】迷糊｜【正式QA】<档案路径>…` 续）；QA 通过后条目置 `待人工验收`、收工写 `【等你拍板】最终验收｜…`。**例外**：本版档案约定「老板亲测、迷糊不做 QA」（如 Temu 报名助手，紫鸟无测试环境）→ 条目置 `待人工验收`，收工写 `【等你拍板】老板亲测｜<一句话引导 + 本记录路径>`。'
          : '下一步：收工写 `【下一棒】GG Bond｜视觉初筛打回：<本记录路径>，按表逐条改完再交我复筛`（不要交老板）。'
        return txt(`${md}\n\n${saved ? `已追加：\`${saved}\`` : '（本会话无任务档案 / 没有 facet_doc，未落盘——把上面结论贴进实施记录）'}\n\n${next}`)
      },
    ))
    // ---- 页面「一眼巡检」：第四档，与视觉三层并列（2026-09-08 老板定）----
    // 三层全是比对式（比历史基线 / 比模块多数 / 比设计 rubric），都要参照物；
    // 人第一眼用的是一致性直觉，无基线、零前置。测完判绿人工一开还是一堆问题，缺的就是这一档。
    tools.push(tool(
      'page_scan',
      '【一眼巡检·第 1 步：取图 + 拿判据】**每测完一个关键页面/状态就跑一次**，成本极低。给你截图清单 + 10 类异常判据（重复渲染/自相矛盾/数字不勾稽/脏数据外泄/格式单位/空态占位/截断溢出/业务不可能值/敏感未脱敏/明显破损）。**入口不锁 sessionId**：给 `screenshots` 就能直接吃任意图（老板随手丢的截图也行），这是它跟 `visual_acceptance`/`aesthetic_review` 的关键区别——那两个必须先挂断言跑会话录基线。**只看页面主体，菜单/顶栏/面包屑/页脚这些通用外壳不判**。拿到清单后你必须真的把图 Read 了再出结论。',
      {
        sessionId: z.string().optional().describe('猪猪会话 id（取该会话各步的 afterScreenshot，自动采样）'),
        screenshots: z.array(z.string()).optional().describe('直接给截图路径（任意来源，不需要猪猪会话）'),
        limit: z.number().optional().describe('采样上限，默认 10（sessionId 模式下生效；一份 summary 常有 70+ 张图，全看不现实）'),
      },
      async ({ sessionId, screenshots, limit }) => {
        let shots = [], source = '', sampling = null
        if (Array.isArray(screenshots) && screenshots.length) {
          const missing = screenshots.filter(s => !fs.existsSync(s))
          if (missing.length === screenshots.length) return txt(`⚠ 给的 ${screenshots.length} 个路径**一个都不存在**——巡检没有素材就是「未做」，不是「没问题」。\n\n${missing.map(m => `- \`${m}\``).join('\n')}`)
          shots = screenshots.filter(s => fs.existsSync(s))
          source = `直接给定的 ${shots.length} 张截图${missing.length ? `（另有 ${missing.length} 个路径不存在，已跳过）` : ''}`
        } else if (sessionId) {
          const rd = await zhuzhuCaps.sessionRunDirs(sessionId, zzOpts())
          if (!rd.available) return txt(`⚠ 反查不到 ${sessionId} 的 run 目录：${rd.why} —— 按「未做巡检」记，不许当通过。`)
          const steps = []
          for (const d of rd.dirs) {
            const sm = readRunSummaryAt(d)
            if (sm) steps.push(...(Array.isArray(sm.steps) ? sm.steps : []))
          }
          // 实测一份真 summary 有 76 步、每步都截图——全列出来等于没采样（详见 page-scan.js sampleShots）
          sampling = pageScan.sampleShots(steps, { limit: limit || 10 })
          shots = [...new Set(sampling.shots)]
          source = `猪猪会话 \`${sessionId}\`（${rd.dirs.length} 个 run）`
        } else return txt('[要么给 sessionId、要么给 screenshots]')
        if (!shots.length) return txt('⚠ **一张截图都没取到** —— 猪猪会话里没有 afterScreenshot（用例没开截图？）。按「未做巡检」记，不是「没问题」。')
        const fp = scanFootprintOf(run.id)
        pageScanFootprint.set(run.id, { ...fp, shots: fp.shots + shots.length })
        return txt(pageScan.renderScanMaterial({ screenshots: shots, source, sampling }))
      },
    ))
    tools.push(tool(
      'page_scan_verdict',
      '【一眼巡检·第 2 步：提交发现】**机器逐条校验**：`zone` 落在通用外壳（菜单/顶栏/面包屑/页脚）的直接打回；`quote` 必须是从截图里抄下来的原文（给了 `pageText` 就核对它真的在页面上）；`expected` 必须写「本该是什么样」；`arithmetic` 类**机器会真的把 parts 加一遍**，加得上的打回（那是你自己算错了）。结论分两档：**截图自证**（可直接开单）/ **待复核**（要先查实）。同一现象在多页面复现的自动降级成全站议题。**不要写 suggestion**——红线 5，QA 只报可观测事实、不诊断根因。零发现是正常结论。',
      {
        findings: z.array(z.object({
          rubricKey: z.string().describe('duplicate/contradiction/arithmetic/dirty-data/format/placeholder/truncation/impossible/leak/broken'),
          zone: z.string().describe('页面主体分区：filter/stat/list/detail/action/modal/form/empty（外壳区会被打回）'),
          quote: z.string().describe('从截图里抄下来的原文，一字不改'),
          expected: z.string().describe('本该是什么样（不是"怎么改"）'),
          page: z.string().optional().describe('页面/状态名，多张截图时必给（用于全站议题降级）'),
          occurrences: z.number().optional().describe('duplicate 类必给：出现几次（≥2）'),
          parts: z.array(z.number()).optional().describe('arithmetic 类必给：各分项数值'),
          total: z.number().optional().describe('arithmetic 类必给：页面上写的总数'),
          severity: z.string().optional().describe('覆盖默认严重度（高/中/低）'),
        })).describe('逐条发现；没发现就传空数组'),
        pageText: z.string().optional().describe('可选：页面可见文本（DOM 文本/OCR）——给了就硬校验 quote 真的存在'),
        screenshotCount: z.number().optional().describe('本次巡检了几张图（写进结论）'),
      },
      async ({ findings, pageText, screenshotCount }) => {
        const val = pageScan.validateScanFindings({ findings }, { pageText })
        const fp = scanFootprintOf(run.id)
        // C3.9：被接受的发现进「待落出口」台账（按 findingKey 去重，重复提交不翻倍）。
        // 存的是发现本身、不是计数——收工时要能逐条点名"这条没人接"。
        for (const f of val.accepted) fp.accepted.set(pageScan.findingKey(f), { rubricKey: f.rubricKey, rubricLabel: f.rubricLabel, page: f.page || '', quote: f.quote, zone: f.zone, tier: f.tier })
        pageScanFootprint.set(run.id, {
          ...fp, verdicts: fp.verdicts + 1, findings: fp.findings + val.accepted.length,
          confirmed: fp.confirmed + val.accepted.filter(f => f.tier === pageScan.SCAN_TIERS.CONFIRMED).length,
          suspects: fp.suspects + val.accepted.filter(f => f.tier === pageScan.SCAN_TIERS.SUSPECT).length,
        })
        const md = pageScan.renderScanReport(val, { screenshots: screenshotCount || 0 })
        return txt(val.ok ? md : `${md}\n\n⛔ **有 ${val.rejected.length} 条未被接受**（原因见上）——改完重新提交；通过的那些已经算数。`)
      },
    ))
    tools.push(tool(
      'page_scan_to_bugs',
      '【一眼巡检·第 3 步：转缺陷单】把「截图自证」档转成缺陷单骨架（对齐 `templates/qa-缺陷单.md`：frontmatter + 六段 + 壳号 facet `REQ-9NNN-F1` + 四件套提醒）。**「待复核」档不转**——那档要你先查实，别把复核工作甩给开发。返回逐张骨架，你**一个回合写一张**落盘（产出纪律：单回合多份大文件会触发连接中断整轮作废）。',
      {
        findings: z.array(z.object({
          rubricKey: z.string(), zone: z.string(), quote: z.string(), expected: z.string(),
          page: z.string().optional(), occurrences: z.number().optional(),
          parts: z.array(z.number()).optional(), total: z.number().optional(), severity: z.string().optional(),
        })).describe('与 page_scan_verdict 同一份 findings（会重跑一遍校验，保证转单的都是通过的）'),
        version: z.string().describe('版本号，如 5.20'),
        module: z.string().optional().describe('模块名，如 跟单看板'),
        startSeq: z.number().optional().describe('起始缺陷序号（接着已有的编，默认 1）'),
        archive: z.string().optional().describe('任务档案路径'),
        runId: z.string().optional().describe('证据 runId'),
        screenshots: z.array(z.string()).optional().describe('证据截图路径'),
      },
      async ({ findings, version, module, startSeq, archive, runId, screenshots }) => {
        const val = pageScan.validateScanFindings({ findings })
        const date = new Date().toISOString().slice(0, 10)
        const bugs = pageScan.scanFindingsToBugs(val.accepted, { version, module: module || '', startSeq: startSeq || 1, date, archive: archive || '', runId: runId || '', screenshots: screenshots || [] })
        const suspects = val.accepted.filter(f => f.tier === pageScan.SCAN_TIERS.SUSPECT).length
        const plan = pageScan.renderBugPlan(bugs, { suspects })
        if (!bugs.length) return txt(plan)
        return txt(`${plan}\n\n---\n\n${bugs.map(b => `#### \`${b.filename}\`\n\n\`\`\`markdown\n${b.body}\n\`\`\``).join('\n\n')}`)
      },
    ))
    tools.push(tool(
      'finding_disposition',
      '【一眼巡检·第 4 步：落出口（收工硬判）】给每条巡检发现落一个**三选一**的出口，禁止无主状态。`bug`＝建缺陷单（给 bugId，走四件套）；`increment`＝并入在研版本迭代增量（**必须同时给 entryId + owner + date** —— 走增量≠不派工）；`not-defect`＝判不是缺陷（必须写明为何不算）。「留人工定性」「待晨检编排」**不是出口**：它和「没发现」两天后完全同形（血泪：模板列表 Invalid date 报了两次没人接、跟单工作台页头「未登录」推给晨检后失踪）。收工 `qa_report_card` 按 C3.9 硬判，有 open 就不许出报告。',
      {
        dispositions: z.array(z.object({
          key: z.string().describe('page_scan_verdict 结论里印的 key，照抄'),
          exit: z.string().describe('bug / increment / not-defect'),
          bugId: z.string().optional().describe('exit=bug 必填：缺陷单号，如 STOCKUP-v0.1.0-BUG-002'),
          file: z.string().optional().describe('exit=bug 选填：缺陷单落盘路径'),
          entryId: z.string().optional().describe('exit=increment 必填：条目登记表里的条目号（set_entry_status 建的那行）'),
          owner: z.string().optional().describe('exit=increment 必填：接手人（ggbond / feifei / …）'),
          date: z.string().optional().describe('exit=increment 必填：约定修复/交付日期 YYYY-MM-DD'),
          reason: z.string().optional().describe('exit=not-defect 必填：为何不算缺陷（≥10 字，供复盘回查）'),
        })).describe('逐条出口声明'),
      },
      async ({ dispositions }) => {
        const fp = scanFootprintOf(run.id)
        if (!fp.accepted.size) return txt('[本轮还没有任何被接受的巡检发现 —— 先 `page_scan` → `page_scan_verdict`；零发现是正常结论，不需要落出口]')
        const okList = [], bad = []
        for (const d of (dispositions || [])) {
          const v = pageScan.validateDisposition(d)
          if (!v.ok) { bad.push(`\`${d && d.key ? d.key : '(无 key)'}\`：${v.why}`); continue }
          if (!fp.accepted.has(v.record.key)) { bad.push(`\`${v.record.key}\`：这个 key 不在本轮被接受的发现里（key 要从 \`page_scan_verdict\` 结论照抄，不能自造）`); continue }
          fp.disposed.set(v.record.key, { ...v.record, at: v.record.at || todayStr() })
          okList.push(v.record)
        }
        pageScanFootprint.set(run.id, fp)
        const ledger = pageScan.dispositionLedger({ findings: [...fp.accepted.entries()].map(([k, f]) => ({ ...f, key: k })), dispositions: Object.fromEntries(fp.disposed) })
        const gate = qaCard.findingExitGate({ ledger })
        const L = [okList.length ? `[已落出口 ${okList.length} 条：${okList.map(r => `${r.key.slice(0, 24)}→${r.exit}`).join('；')}]` : '[一条都没落成]']
        if (bad.length) L.push('⛔ 以下未被接受（改完重提，通过的那些已经算数）：\n' + bad.map(b => `- ${b}`).join('\n'))
        L.push('', qaCard.renderFindingExitGate(gate))
        return txt(L.join('\n'))
      },
    ))
    tools.push(tool(
      'residue_report',
      '造数租户与残留清点（C6）：用租户前缀造数、`residueCheck` 清点残留、`baselineGuard` 守住预置数据（「预置『上衣』被谁停用了」当时缺的就是这个）。返回本轮该用的租户前缀 + 残留结论；残留数会进批次结论与晨检包。',
      { runName: z.string().optional().describe('本轮 run_name（生成租户前缀用）'), check: z.boolean().optional().describe('true=真去猪猪清点残留；false=只取租户前缀') },
      async ({ runName, check }) => {
        const c = guardContractFor(run)
        const prefix = qaCard.tenantPrefix(runName || c?.runName || run.id)
        if (check === false) return txt(`本轮造数租户前缀：\`${prefix}\`\n\n所有造数（品类/供应商/SPU/任务名）都用它开头 —— 否则会落进**全局主数据**（v5.19 那次 QA 造的品类污染全局、靠手工清）。`)
        const res = await zhuzhuCaps.callCapability('preflight', zzOpts({ body: { residueCheck: true, prefix } }))
        const rep = qaCard.residueReport({ prefix, residue: res.available ? res.data?.residue : null, baseline: res.available ? res.data?.baseline : null })
        return txt(`本轮租户前缀：\`${prefix}\`\n\n` + qaCard.renderResidueReport(rep))
      },
    ))
    tools.push(tool(
      'qa_report_card',
      '【收工前必出】生成 QA 报告卡片骨架 + 机器事实清单（C4），你只把「我做了什么」改写成人话。示范语气：「我以核价师身份新建了一个品类『内裤』，然后去录尺寸表页面确认它能被选中，并且选中后能正常生成全码尺寸表；为了确认这个检查是有效的，我故意把代码改坏了一次，检查确实变红了。」**铁律：只改写、不新增事实**——引擎会机器校验你稿子里的 facet ID / run id / 数字是否都来自事实清单，未覆盖项必须逐条照抄 reason，不许润色成「基本覆盖」。传 draft 即做校验。',
      {
        version: z.string().optional(),
        draft: z.string().optional().describe('你改写好的大白话稿（传了就做「有没有凭空多出事实」的机器校验）'),
        regression: z.array(z.object({ caseId: z.string(), runId: z.string().optional(), ok: z.boolean().optional() })).optional().describe('老功能回归逐条（C5 硬要求：无 run id 不算数）'),
        write: z.boolean().optional().describe('true=把报告落盘到版本目录（需先传 draft 且校验通过）'),
      },
      async ({ version, draft, regression, write }) => {
        const rows = mergeFacetRowsForRun(run) || []
        const fmv = version || archiveVersionOf(run.taskFile)
        // Z-K 是 per-session 的（`GET /test-sessions/{id}/report-card`）：取本版最近一条 GREEN 证据里的
        // 猪猪 sessionId。没有任何 run id 时不去空调一次（那只会拿回一个误导性的 404）。
        const zzSession = rows.map(r => r.green?.runId).filter(Boolean).pop() || ''
        const card = zzSession
          ? await zhuzhuCaps.reportCard({ sessionId: zzSession }, zzOpts({ sessionId: zzSession }))
          : { available: false, why: '本版还没有任何带 runId 的 GREEN 证据，取不到猪猪 sessionId——报告卡片素材只能靠覆盖矩阵，须在报告里显式声明素材受限', card: null }
        const c = guardContractFor(run)
        const led = c ? guardLedgerFor(c.runName) : null
        const sheet = qaCard.buildFactSheet({ version: fmv, reqs: [...new Set(rows.map(r => r.req))], rows, reportCard: card, redLights: led ? guardLedger.redLightTotals(led) : null, runIds: rows.map(r => r.green?.runId).filter(Boolean) })
        if (!draft) {
          // C3.8「需人工视觉终验」声明门（§3.132）：说只能人眼看，就得交代机器这条路走到哪一步
          const vGate = qaCard.visualFinalityGate({ rows, footprint: visualFootprint.get(run.id) })
          // C3.9 巡检发现出口门：捞出来的东西必须逐条有出口，无主状态一律当"没处置"（见 findingExitGate 注释）
          const sfp = scanFootprintOf(run.id)
          const fLedger = pageScan.dispositionLedger({ findings: [...sfp.accepted.entries()].map(([k, f]) => ({ ...f, key: k })), dispositions: Object.fromEntries(sfp.disposed) })
          const fGate = qaCard.findingExitGate({ ledger: fLedger })
          // C3.13 UI 视觉验收门（2026-10-06）：界面类 facet 判绿 → 本轮要有视觉素材 + 一份过了看图门的审美结论
          const uGate = qaCard.uiVisualGate({ rows, footprint: visualFootprint.get(run.id) })
          const chk = qaCard.validateQaResultReport({ sheet, regression: regression || [], visualGate: vGate, findingGate: fGate, uiVisualGate: uGate })
          // 页面巡检足迹（§3.123）：**不进 factSheet**——那份事实集喂给 `validateRewrite` 做「不许新增
          // 事实」校验，往里加字段会牵动改写稿的合法事实边界。这里只作收工自检的一条如实提示：
          // 「一次都没跑」和「跑了没发现」长得完全不一样，别让沉默冒充通过（§3.104 口径一）。
          const fp = pageScanFootprint.get(run.id)
          const scanLine = !fp || !fp.verdicts
            ? `⚠ **本轮一次页面巡检都没跑**（\`page_scan\` → \`page_scan_verdict\`）${fp?.shots ? `——取了 ${fp.shots} 张图但没提交结论，等于没做` : ''}。按「未做」记、**不是「没问题」**：它专治「测完判绿、人工一打开第一眼还是一堆问题」，而用例断言与视觉三层都覆盖不到那一类（SOP §C3.7）。`
            : `✅ 页面巡检跑了 ${fp.verdicts} 轮、共 ${fp.shots} 张图 → ${fp.findings} 条发现（截图自证 ${fp.confirmed} · 待复核 ${fp.suspects}）${fp.confirmed ? '——**自证档要确认已开缺陷单**（`page_scan_to_bugs`）' : ''}${fp.suspects ? `；**${fp.suspects} 条待复核要么查实转单、要么在报告里写明为何不算缺陷**` : ''}。`
          return txt(qaCard.reportCardSkeleton(sheet) + `\n\n---\n\n**引擎自检**：${chk.ok ? '✅ 可出报告' : '⛔ 还不能出：\n' + chk.errors.map(e => `- ${e}`).join('\n')}\n\n**页面巡检（§3.123）**：${scanLine}\n\n${qaCard.renderVisualFinalityGate(vGate)}\n\n${qaCard.renderUiVisualGate(uGate)}\n\n${qaCard.renderFindingExitGate(fGate)}\n\n把上面 ★ 标的段落改写成人话后，再带 \`draft\` 调一次本工具做「不许新增事实」校验。`)
        }
        const v = qaCard.validateRewrite(draft, sheet)
        if (!v.ok) {
          const L = ['⛔ 改写稿未过「只改写、不新增事实」校验：']
          for (const x of v.violations) L.push(`- 凭空多出的 \`${x.token}\` —— ${x.why}`)
          if (v.missingUncovered.length) L.push(`- 未覆盖项被漏写：${v.missingUncovered.join(', )').replace(/\)$/, '')}（必须逐条照抄 facet ID + reason）`)
          for (const w of v.whitewash) L.push(`- ${w}`)
          L.push('', v.hint)
          return txt(L.join('\n'))
        }
        const body = qaCard.qaResultReport({ sheet, regression: regression || [], cardBody: draft })
        // C3.13 在落盘这一步硬拦（只提示不拦 = 写了跟没写一样，09-15/09-18 两次「未做视觉验收」照样出了报告）
        const uGateW = qaCard.uiVisualGate({ rows, footprint: visualFootprint.get(run.id) })
        if (write && !uGateW.ok) return txt(`⛔ 报告不落盘：${qaCard.renderUiVisualGate(uGateW)}`)
        if (write && fmv) {
          const rel = qaReportPathFor(run.taskFile, fmv)
          if (rel) { try { fs.writeFileSync(safeResolve(rel), body, 'utf8'); appendTimelineLine(run.taskFile, `QA 结果报告已出：${rel}`); return txt(`✅ 校验通过，已落盘 \`${rel}\`。`) } catch (e) { return txt(`✅ 校验通过，但落盘失败（${e.message}）——内容如下，请手动保存：\n\n${body}`) } }
        }
        return txt(`✅ 校验通过（未落盘）。完整报告：\n\n${body}`)
      },
    ))
  }

  // ---- 菲斯拉：F1 / F2 / F3 ----
  if (emp === 'feisila') {
    tools.push(tool(
      'audit_evidence_trust',
      '假绿猎手（F1）：对每条 COVERED_GREEN 做六项机器抽查 —— verify_evidence 是否通过、failureClass 是否合规、区分度分数、页面报错记录、环境指纹是否新鲜、以及「同 REQ 已有真绿链却停在 SOURCE_ATTESTED」。产出晨检包的「证据可信度」章节 + `guard.fake_green` 的计数来源。你此前只能靠读文档对抗，这是你第一件机器工具。',
      {},
      async () => {
        const rows = mergeFacetRowsForRun(run)
        if (!rows) return txt('[取不到覆盖矩阵]')
        const items = rows.filter(r => String(r.status).toUpperCase() === 'COVERED_GREEN').map(r => ({ facetId: r.facetId, runId: r.green?.runId || '', caseId: r.green?.case || '' }))
        const v = await zhuzhuCaps.verifyEvidenceBatch(items, zzOpts())
        // 环境新鲜度：`/env-fingerprint` 给的是**指纹**、没有 `fresh` 布尔（2026-09-07 实测）。
        // 旧代码读 `data.fresh !== false` → undefined 恒真 → 假绿。现在只有能证明时才 true/false。
        const env = await zhuzhuCaps.envFreshness({ baseUrl: zhuzhuConfig.targetBaseUrl || '' }, zzOpts())
        const idx = facetIndexForRun(run)
        const h = auditTrust.fakeGreenHunt({ rows, verify: v.available ? v.map : null, extra: { suspectAttestations: idx.suspectAttestations, envFingerprintFresh: env.fresh } })
        const c = guardContractFor(run)
        if (c) { const led = guardLedgerFor(c.runName); led.fakeGreen = guardLedger.deriveFakeGreen(rows, v.available ? v.map : null); saveGuardLedger(c.runName) }
        return txt(auditTrust.renderTrustSection(h))
      },
    ))
    tools.push(tool(
      'file_escape_case',
      '逃逸复盘自动立案（F3）：凡「上线后 / 老板手工发现」的缺陷，立一条复盘条目 —— 问「哪道门本该拦住它、缺哪项能力」，指向猪猪能力编号或 lab 门禁。这两个月的两个逃逸就是这么定位到 Z-A / Z-J 的。若现有门谱里一道门都匹配不上，引擎会点明「需要新建门，不是加强现有的」——那才是最重要的发现。',
      { defect: z.string().describe('缺陷描述'), foundBy: z.string().describe('谁怎么发现的（老板手工用出来 / 上线后用户反馈 / …）'), foundAt: z.string().optional(), req: z.string().optional(), version: z.string().optional() },
      async (a) => {
        const c = auditTrust.fileEscapeCase(a)
        if (!c.shouldFile) return txt('[这条不构成「逃逸」（不是上线后/人工发现的）——正常缺陷走缺陷单，不必立复盘案]')
        return txt(auditTrust.renderEscapeCase(c))
      },
    ))
    tools.push(tool(
      'audit_intake_misjudge',
      'intake 误判审计（F2）：抽查「被判零歧义并跑了的」条目，事后是否发生口径反转 / 返工 / 上线当天被用户推翻（REQ-0302→0312 就是一例）。产出 `eligibility_misjudge` 指标，并反馈「哪一项拷问最该加严」给菲菲的就绪标准。',
      { history: z.array(z.object({ req: z.string(), judgedUnambiguousAt: z.string().optional(), releasedAt: z.string().optional(), reworkEvents: z.array(z.object({ at: z.string().optional(), kind: z.string(), note: z.string().optional() })).optional() })).describe('抽查样本') },
      async ({ history }) => txt(auditTrust.renderMisjudge(auditTrust.intakeMisjudge(history))),
    ))
  }

  // ---- 波比：D1 / D2 / D3 / D4 ----
  if (emp === 'bobby') {
    tools.push(tool(
      'reconcile_release_chain',
      '发布链机器对账（E4/D1）：每条 REQ 一行状态链 —— `facet 绿(证据) → commit → push → MR opened → merged → deployed → 目标分支 content 坐实`。**任一环缺失，看板对应条目不许显示「已上线」；`released_prod` 由本对账器写、不由人写。** 专治三次真事故：4 条 REQ 躺在未提交工作区、打磨 commit 只 commit 未 push、生产半发布靠人逐文件比对捞回。',
      {
        target: z.string().optional().describe('目标分支：master（测试）或 release（线上，默认）'),
        reqs: z.array(z.object({
          req: z.string(), evidence: z.boolean().optional(), mr_opened: z.boolean().optional(), merged: z.boolean().optional(),
          deployed: z.boolean().optional(), contentProbe: z.string().optional().describe('用来验「内容真在目标分支上」的字符串/文件路径'),
        })).describe('本次要对账的条目；commit/push 两环引擎自己探，其余你按事实填'),
        repo: z.string().optional().describe('仓库 key，默认 backend'),
        writeGate: z.boolean().optional().describe('true=整链全绿时把任务档案 gates.released_prod 置 true（这是唯一允许写它的路径）'),
      },
      async ({ target, reqs, repo, writeGate }) => {
        const tgt = String(target || 'release') === 'master' ? 'master' : 'release'
        const target_ = RELEASE_REPOS.find(r => r.key === (repo || 'backend'))
        if (!target_ || !fs.existsSync(target_.path)) return txt(`[仓库不存在：${repo || 'backend'}]`)
        const g = await repoGitFacts(target_)
        await runGit(['fetch', '-q', 'origin', tgt], target_.path)
        const rows = []
        for (const r of reqs || []) {
          let content = null
          if (r.contentProbe) {
            const probe = await runGit(['log', '--oneline', '-1', `origin/${tgt}`, '--', r.contentProbe], target_.path)
            content = probe.code === 0 && !!probe.out.trim()
          }
          rows.push({
            req: r.req,
            facts: {
              evidence: r.evidence === true, evidenceWhy: r.evidence === true ? '' : 'facet 未全绿（或未核验证据）',
              commit: (g.dirtyFiles.length + g.stagedFiles.length) === 0, commitWhy: `工作区有 ${g.dirtyFiles.length + g.stagedFiles.length} 个未提交改动`,
              push: g.remoteExists && g.aheadOfRemote === 0, pushWhy: g.remoteExists ? `有 ${g.aheadOfRemote} 个提交只 commit 未 push` : '远端无该分支',
              mr_opened: r.mr_opened === true, merged: r.merged === true, deployed: r.deployed === true,
              content, contentWhy: r.contentProbe ? '目标分支上查不到该路径的提交' : '未给 contentProbe，无法机器验「内容真在目标分支上」——半发布就是在这一环漏的',
            },
          })
        }
        const rec = releaseChain.reconcileRelease(rows)
        let wrote = ''
        if (writeGate && run.taskFile) {
          try { engineSetGate(safeResolve(run.taskFile), 'released_prod', rec.releasedProd); wrote = `\n\n已按对账结果写 \`gates.released_prod=${rec.releasedProd}\`（${rec.releasedProd ? '整链坐实' : '**断链 → 仍为 false**，别手改'}）。` }
          catch (e) { wrote = `\n\n写 gates 失败：${e.message}` }
        }
        return txt(releaseChain.renderReleaseChain(rec) + wrote)
      },
    ))
    tools.push(tool(
      'deploy_manifest',
      '部署清单自动生成（D2）：用**三点 merge-base 净 delta**（`origin/<target>...HEAD`）而不是两点 diff（两点会把他组模块误算进来，`enumerate_release` 就有这个误报），映射模块→服务（含 datasource/service-interface 库模块的连带重发规则），输出含端口的清单 +「不发的也点名说明」。',
      {
        target: z.string().optional().describe('master（测试，默认）或 release（线上）'),
        lane: z.string().optional().describe('工作区 id；不给=本会话所属工作区（没绑=主检出）'),
      },
      async ({ target, lane }) => {
        const tgt = String(target || 'master') === 'release' ? 'release' : 'master'
        // 并行工作区：后端 delta 取所属工作区那棵树（主检出是别的版本，拿它算清单＝错发）
        const laneId = lane || laneKeyOf(run)
        const laneRec = laneId && laneId !== MAIN_LANE_ID ? lanesMgr().get(laneId) : null
        if (lane && lane !== MAIN_LANE_ID && !laneRec) return txt(`[没有工作区 ${lane}]`)
        if (laneRec && !laneRec.repos?.backend) return txt(`工作区 ${laneId} 没开后端仓 —— 本版**无后端改动、无需部署任何后端服务**。`)
        const be = laneRec ? { path: laneRec.repos.backend.path } : RELEASE_REPOS.find(r => r.key === 'backend')
        if (!be || !fs.existsSync(be.path)) return txt('[后端仓不在本机]')
        await runGit(['fetch', '-q', 'origin', tgt], be.path)
        const d = await runGit(['diff', '--name-only', `origin/${tgt}...HEAD`], be.path)
        if (d.code !== 0) return txt(`[三点 diff 失败：${(d.err || '').trim().slice(0, 200)}]`)
        const files = d.out.split('\n').map(s => s.trim()).filter(Boolean)
        if (!files.length) return txt(`后端相对 origin/${tgt} 的净 delta 为空 —— 本次**无需部署任何后端服务**。`)
        return txt(releaseChain.renderDeployManifest(releaseChain.deployManifest(files)))
      },
    ))
    tools.push(tool(
      'lint_release_sql',
      'release SQL 校验器（D3）：DDL 顺序（先建表后改表、同表合并 ALTER）、DMS/MySQL 5.7 兼容 lint（临时表 / 会话变量 / 窗口函数 / CTE / DELIMITER）、影响行数、纯净版格式（无横幅废话、尾部验证注释）。这几条都是 v5.19 踩过的。',
      { path: z.string().describe('SQL 文件相对路径'), backfillRows: z.number().optional(), targetDbVersion: z.string().optional(), rollback: z.string().optional() },
      async ({ path: rel, backfillRows, targetDbVersion, rollback }) => {
        const abs = resolveRepoFile(rel)
        if (!abs) return txt(`[找不到文件：${rel}]`)
        const r = releaseChain.lintReleaseSql(fs.readFileSync(abs, 'utf8'), { backfillRows, targetDbVersion, rollback })
        const L = [`【release SQL 校验】\`${rel}\`（${r.statements} 条建表/改表语句，涉及 ${r.tables.length} 张表）`, '']
        if (r.clean && !r.warnings.length) return txt(L.concat(['✅ 无问题。']).join('\n'))
        if (r.errors.length) { L.push(`**⛔ 错误 ${r.errors.length} 项（必须改）**`); for (const e of r.errors) L.push(`- [${e.code}] ${e.why}`) }
        if (r.warnings.length) { L.push(''); L.push(`**⚠ 提醒 ${r.warnings.length} 项**`); for (const w of r.warnings) L.push(`- [${w.code}] ${w.why}`) }
        return txt(L.join('\n'))
      },
    ))
    tools.push(tool(
      'rollback_plan',
      '回退演练与「上一个可回退版本」（D4）：记录上一可回退 commit/tag + 回退清单（含 DDL 是否可逆）。**晨检包里必须能看到「打回时怎么退」** —— 设计里写了、实践中一直没有。',
      {
        version: z.string().optional(), prevTag: z.string().optional().describe('上一个可回退的 tag'), prevCommit: z.string().optional(),
        services: z.array(z.string()).optional().describe('要回退的服务（含端口）'), frontendRepos: z.array(z.string()).optional(),
        ddlReversible: z.boolean().optional().describe('本次 DDL 是否可逆（纯新增列/表=可逆；改类型/删列/回填=不可逆）'),
        ddlRollbackSql: z.string().optional(),
      },
      async (a) => {
        const p = releaseChain.rollbackPlan(a)
        if (run.taskFile && p.ok) { try { engineSetGate(safeResolve(run.taskFile), 'rollback_ready', true) } catch {} }
        return txt(releaseChain.renderRollbackPlan(p))
      },
    ))
  }

  // ---- 菲菲 / 波比：E2 晨检包 + E3 结算 ----
  if (emp === 'feifei' || emp === 'bobby') {
    tools.push(tool(
      'morning_report',
      '装配**版本晨检验收单**（E2）：引擎从机器事实拼 —— 条目全表直接读任务档案「需求条目登记表」（与看板同源、整版全在），叠加覆盖矩阵/门禁/三红灯/park 待拍/最近一轮增量与审计。落 `tasks/<日期>-<版本>-晨检包.md`，**一版一份、每天覆盖写**。\n缘起：2026-08-28 老板报「晨检包概念很混乱、只展示了一开始的 2 条需求、进度跟真实的不一样」——旧形态按守航轮次出包，一个版本跨 4 轮就裂成 4 份，每份只讲自己那夜领的 2 条，而且从没读过登记表。**装配器绝不因缺料而不出包**，缺什么在第〇章如实标注。',
      {
        items: z.array(z.object({
          req: z.string(), result: z.enum(['rc_ready', 'quarantined', 'parked', 'in_progress']),
          commit: z.string().optional(), green: z.number().optional(), facetTotal: z.number().optional(),
          redCalibrated: z.boolean().optional(), devQaRounds: z.number().optional(),
          stopWhy: z.string().optional(), evidencePath: z.string().optional(), proposal: z.string().optional(), branch: z.string().optional(),
          humanInherent: z.string().optional(),
        })).describe('逐条目结果（机器事实：从看板/覆盖矩阵抄，别凭印象填）'),
        selfReports: z.array(z.object({ employee: z.string(), text: z.string() })).optional().describe('agent 自述（会单列并标注「不作放行依据」）'),
        qaReportCard: z.string().optional().describe('迷糊出的 QA 报告卡片正文（菲菲复核后的版本）'),
        write: z.boolean().optional().describe('true=落盘（默认 true）'),
        version: z.string().optional().describe('要出哪个版本的验收单（如 v5.20）；留空=从本轮契约反查'),
        scope: z.enum(['version', 'round']).optional().describe('默认 version（版本验收单）。只有排查某一轮的审计细节时才用 round'),
      },
      async ({ items, selfReports, qaReportCard, write, version, scope }) => {
        const out = await assembleAcceptanceReport(run, { items: items || [], selfReports: selfReports || [], qaReportCard: qaReportCard || '', version, scope })
        if (write === false) return txt(out.body)
        try {
          fs.writeFileSync(out.abs, out.body, 'utf8')
          const archiveRel = guardArchiveRelFor(run, guardContractFor(run))
          if (archiveRel) appendTimelineLine(archiveRel, `晨检验收单已装配：${out.rel}`)
          broadcast({ type: 'morning-report', runName: out.runName || '', version: out.version || '', rel: out.rel, scope: out.scope })
          const head = out.scope === 'version'
            ? `✅ **${out.version} 版本验收单**已落盘 \`${out.rel}\`（登记表 ${out.entries.length} 条 · 守航 ${out.rounds.length} 轮${out.parkClosed?.length ? ` · park 对账关闭 ${out.parkClosed.length} 条` : ''}）。`
            : `✅ 晨检包已落盘 \`${out.rel}\`（**轮次级降级形态**：这一轮还绑不到版本，见包内第〇章）。`
          return txt(`${head}\n\n缺料章节（如实标注、未冒充通过）：\n${out.gaps.length ? out.gaps.map(g => `- ${g}`).join('\n') : '（无）'}`)
        } catch (e) { return txt(`落盘失败（${e.message}）——内容如下：\n\n${out.body}`) }
      },
    ))
    tools.push(tool(
      'version_append_check',
      '往一个版本追加条目前先问引擎（E3）。默认规则：**守航产出物默认独立成版、当晚可发**；往已达 RC_READY 的版本追加 → 必须显式重签契约（新 run_name）+ 把版本状态显式回退，看板会弹确认。缘起：v5.19 从 2 条涨到 6 条，**3 条已 RC_READY 的被拖了 4 天**。',
      { versionState: z.string().describe('当前版本状态：drafting/in_dev/in_qa/rc_ready/released_test/released_prod'), newItems: z.array(z.string()).describe('要追加的条目'), reason: z.string().optional() },
      async ({ versionState, newItems, reason }) => {
        const c = guardContractFor(run)
        const d = morningReport.appendItemDecision({ versionState, newItems, currentRunName: c?.runName || '', reason })
        if (d.allowed) return txt(`✅ ${d.why}`)
        const L = [`⛔ ${d.why}`, '', '**两个选项（必须选一个，不许默默并进去）**']
        for (const o of d.options) L.push(`- **${o.label}**：${o.detail}`)
        L.push('', `若坚持并入，先向老板确认这一句：「${d.confirmText}」`)
        return txt(L.join('\n'))
      },
    ))
  }

  return tools.length ? createSdkMcpServer({ name: 'guarded', version: '0.1.0', tools }) : null
}

// ---------- 守航工具的共用取数（都从**机器事实**取，不问 agent）----------
// 覆盖矩阵 ∪ facet_doc → 逐 facet 行（复用 coverage.js 的显示层合并口径）
function mergeFacetRowsForRun(run) {
  if (!run?.taskFile) return null
  let abs; try { abs = safeResolve(run.taskFile) } catch { return null }
  if (!fs.existsSync(abs)) return null
  const text = fs.readFileSync(abs, 'utf8')
  const fm = parseFrontmatter(text) || {}
  let facets = []
  try { facets = loadFacetSet(fm).facets } catch { facets = [] }
  return mergeFacetRows(facets, extractCoverageMatrix(text))
}
// facet ↔ 实现文件/组件/用例 的映射（B3 影响面雷达的输入）。
// 事实源：覆盖矩阵的证据字段（case=）+ facet_doc 的「影响入口」列；**取不到就如实为空**，不猜。
function facetIndexForRun(run) {
  const rows = mergeFacetRowsForRun(run) || []
  const facets = rows.map(r => ({
    facetId: r.facetId,
    files: [], // 目前 facet 表不登记实现文件；组件维度已够用（entryMap 命中即算）
    components: String(r.criterion || '').match(/[a-z][\w-]*-[\w-]{4,}/gi) || [],
    caseIds: r.green?.case ? [r.green.case] : [],
  }))
  const evidence = {}
  for (const r of rows) if (r.green?.commit) evidence[r.facetId] = { commit: r.green.commit, runId: r.green.runId || '' }
  let suspectAttestations = []
  try {
    const text = fs.readFileSync(safeResolve(run.taskFile), 'utf8')
    const cov = computeCoverage(text, rows.map(r => ({ id: r.facetId })))
    suspectAttestations = cov?.suspectAttestations || []
  } catch {}
  return { facets, evidence, suspectAttestations }
}
function archiveVersionOf(taskFileRel) {
  try { return String((parseFrontmatter(fs.readFileSync(safeResolve(taskFileRel), 'utf8')) || {}).version || '') } catch { return '' }
}
// QA 结果报告的落点：与 facet_doc 同目录（＝该版本目录），命名沿用「QA报告卡片-<版本>.md」
// facet_doc 多份时取第一项（约定：主文档排头，储备文档在 00-通用资料/ 下、不是版本目录）
function qaReportPathFor(taskFileRel, version) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(safeResolve(taskFileRel), 'utf8')) || {}
    const fd = primaryFacetDoc(fm).replace(/\\/g, '/')
    if (!fd.includes('/')) return ''
    return `${fd.slice(0, fd.lastIndexOf('/'))}/QA报告卡片-${version}.md`
  } catch { return '' }
}
// 「## 需求条目登记表」→ Map<REQ, {status, stage, name}>。**任务档案是任务进度的唯一状态源**
// （README 的设计原则），park 对账、版本条目全表都以它为准。拿不到档案就是空 Map（对账即全部保留，不猜）。
function entryRowsByReq(archiveRel) {
  const m = new Map()
  if (!archiveRel) return m
  let abs; try { abs = safeResolve(archiveRel) } catch { return m }
  if (!fs.existsSync(abs)) return m
  try {
    for (const e of extractEntries(fs.readFileSync(abs, 'utf8'))) {
      // 编号带后缀的是**另一个条目**（`REQ-0368-demo` ≠ `REQ-0368`）——只取 `REQ-\d+` 会把两行撞成一个键、后一行覆盖前一行
      // （2026-09-29 实况：Temu 档案里「REQ-0368 QA中」被「REQ-0368-demo 已归档」覆盖，目标循环误判这一轮已做完）
      const req = (String(e.no).match(/REQ-\d+(?:-[A-Za-z0-9]+)*/i) || String(e.name).match(/REQ-\d+/i) || [''])[0].toUpperCase()
      if (req) m.set(req, { status: String(e.status || '').replace(/\*\*/g, '').trim(), stage: e.stage || '', name: e.name || '', enteredAt: e.enteredAt || '' })
    }
  } catch {}
  return m
}

// park 台账落盘（跨轮累积——A5 的关键：同一条 park 第几轮必须跨会话记得住）
const PARK_LEDGER_FILE = path.join(GUARD_DIR, 'park-ledger.json')
function loadParkLedger() { try { const a = JSON.parse(fs.readFileSync(PARK_LEDGER_FILE, 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] } }
function saveParkLedger(entries) { ensureGuardDir(); try { fs.writeFileSync(PARK_LEDGER_FILE, JSON.stringify(entries, null, 1)) } catch (e) { console.warn('[guard] park 台账落盘失败:', e.message) } }
// 往任务档案时间线追加一行（走 withArchiveLock 串行落盘，与 append_timeline 同一把锁——
// 守航态下多员工并行写同一份档案，不加锁会互相覆盖，§3.49 踩过）。fire-and-forget。
function appendTimelineLine(taskFileRel, line) {
  if (!taskFileRel) return
  let abs; try { abs = safeResolve(taskFileRel) } catch { return }
  withArchiveLock(abs, () => engineAppendTimeline(abs, line)).catch(e => console.warn('[guard] 时间线追加失败:', e.message))
}

// 本轮守航的任务档案：run.taskFile 优先，取不到则退到**契约 frontmatter 的 archive**。
// 冷启动那一棒本来就没有档案（菲菲第③步才建），后续接棒也没人把它回填进 run —— 实测 32 条守航 run
// `taskFile` 全是 null。不补这一跳，晨检包的版本号/覆盖矩阵/证据可信度就永远是空的（2026-08-28 事故）。
function guardArchiveRelFor(run, c) {
  if (run?.taskFile) return run.taskFile
  const a = String(c?.fm?.archive || '').trim()
  if (!a) return ''
  const norm = a.replace(/\\/g, '/')
  return stripOfficePrefix(norm) ? norm : `${OFFICE_URI_PREFIX}/${norm.replace(/^\.?\//, '')}`
}

// 本轮的「有效结束时刻」＝ deadline 与**下一轮契约 starts_at** 里更早的那个。
// 缘起：两轮守航常常重叠（2026-08-27 的 guarded-01 09:55 开、guarded-02 18:30 开，两者 deadline 同为次日 08:00），
// 只按 deadline 截窗，后一轮 park 的条目会同时长进前一轮的包里（REQ-0313 实测）。这个上界只用来**拦新条目**，
// 已在册条目的后续 park 照收（见 deriveItems 的注释）。
function guardRoundEndFor(c) {
  const dl = String(c?.contract?.deadline || '')
  const mine = Date.parse(String(c?.contract?.starts_at || '').replace(' ', 'T')) || 0
  if (!mine) return dl
  let next = 0
  try {
    for (const f of fs.readdirSync(TASKS_DIR)) {
      if (!/守航契约-guarded-\d+\.md$/.test(f)) continue
      const other = loadGuardContract(`${OFFICE_URI_PREFIX}/tasks/${f}`)
      if (!other || other.runName === c.runName) continue
      const t = Date.parse(String(other.contract?.starts_at || '').replace(' ', 'T')) || 0
      if (t > mine && (!next || t < next)) next = t
    }
  } catch {}
  const dlT = Date.parse(dl.replace(' ', 'T')) || 0
  return next && (!dlT || next < dlT) ? new Date(next).toISOString() : dl
}

// ---------- run summary 的落盘定位（Z-E 视觉素材 / Z-A 页面报错 / Z-B 指纹都在这份文件里） ----------
// ⚠ 2026-09-07 实测踩到：`GET /test-sessions/{id}` 返回的是**会话信封**（状态/轮次/产物路径），
// 里面**没有** `visualReview` / `pageErrors`。那份 `createRunSummary` 落在磁盘：
// `<outputRoot>/runs/<runId>/summary.json`。outputRoot 走对接文档（`workspace.outputRoot`），
// **不在我方存副本**（CLAUDE.md 铁律：主机与工作区会漂移）。缓存 10 分钟，别每次都去问。
let _zzOutputRoot = { at: 0, root: '' }
async function zhuzhuOutputRoot() {
  if (_zzOutputRoot.root && Date.now() - _zzOutputRoot.at < 10 * 60_000) return _zzOutputRoot.root
  const w = await zhuzhuCaps.docWorkspace(zzOpts()).catch(() => null)
  const root = w?.available ? w.outputRoot : ''
  if (root) _zzOutputRoot = { at: Date.now(), root }
  return root
}
// 读一份 run 目录下的 summary.json（runId ＝ 覆盖矩阵 GREEN 行绑的那个，等于 run 目录名）
function readRunSummaryAt(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')) } catch { return null }
}
// 视觉素材包：`summary.visualReview` 只是**存根**（`{items:<数量>, artifactPath}`），真素材在
// 那个 `visual-review.json` 里（2026-09-07 真跑一遍才发现，第一版当成内联数组读→永远判「素材为空」）。
// artifactPath 是猪猪写的绝对路径；只接受落在 outputRoot 之下的（别让产物路径变成任意读文件的口子）。
function readVisualReviewArtifact(summary, { outputRoot = '', runDir = '' } = {}) {
  const stub = zhuzhuCaps.visualReviewFromSummary(summary)
  if (!stub.needsArtifact) return stub                       // 三态里的另外两态（没挂 / 跑了但无素材）原样返回
  let p = stub.artifactPath
  try {
    p = path.resolve(p)
    const roots = [outputRoot, runDir].filter(Boolean).map(r => path.resolve(r))
    if (roots.length && !roots.some(r => p === r || p.startsWith(r + path.sep))) {
      return { ...stub, available: false, why: `素材路径 ${p} 不在猪猪 output 目录下，拒读（防越界）` }
    }
    return zhuzhuCaps.visualReviewFromArtifact(JSON.parse(fs.readFileSync(p, 'utf8')))
  } catch (e) {
    return { ...stub, available: false, why: `素材文件读不到（${p}）：${String(e?.message || e)} —— 按「无可判素材」记，不许当通过` }
  }
}
// ---------- 模块 UX 契约：前端源码扫描（2026-09-08 老板定·方案 A） ----------
// 为什么读源码而不是跑 E2E：`onPaste` / `useCommandEnterSubmit` 是 React handler，**不在 computed style、
// 不在 DOM 属性、不在截图里**，视觉三层一层都采不到；而猪猪当前 19 个 step type 里没有 press/keyboard/paste，
// 组合键按不下去、剪贴板塞不进去。源码扫描则全覆盖、便宜、且能左移到 GG Bond 交接前。
const SAMPLING_SRC_ROOTS = ['frontend/web-app/src/pages', 'frontend/web-app/src/components', 'frontend/web-app/src/hooks']
const UX_SCAN_FILE_CAP = 4000
function collectSamplingSources({ onlySampling = true } = {}) {
  const out = [], missing = []
  for (const rel of SAMPLING_SRC_ROOTS) {
    const abs = path.join(WORKSPACE_ROOT, rel)
    if (!fs.existsSync(abs)) { missing.push(rel); continue }
    let entries = []
    try { entries = fs.readdirSync(abs, { withFileTypes: true, recursive: true }) } catch { missing.push(rel); continue }
    for (const e of entries) {
      if (!e.isFile() || !/\.tsx$/.test(e.name)) continue
      const dir = e.parentPath || e.path || abs
      const full = path.join(dir, e.name)
      const relFile = path.relative(path.join(WORKSPACE_ROOT, 'frontend/web-app/src'), full).replace(/\\/g, '/')
      // 只看示例项目：pages/sampling* 全收；components/hooks 是全站共享，收全（契约的共享实现就住在这儿）
      if (onlySampling && relFile.startsWith('pages/') && !/^pages\/sampling/i.test(relFile)) continue
      if (out.length >= UX_SCAN_FILE_CAP) break
      try { out.push({ file: relFile, src: fs.readFileSync(full, 'utf8') }) } catch { }
    }
  }
  return { files: out, missing }
}

// 示例项目「模块设计基线」（2026-09-07 老板定：标准＝这个模块自己的页面）。
// 落在 office-lab 的通用资料目录、随仓库入库——它是**标准**，必须可 diff、可审、可回溯，
// 不能像 run 产物一样躺在 output 里（那样每次重跑标准就悄悄变了）。
const DESIGN_BASELINE_FILE = path.join(__dirname, '..', 'docs', '示例项目需求', '00-通用资料', '示例项目-视觉设计基线.json')
// 视觉初筛的「母版」：示例项目各型页面的真实截图 + 要点（与上面的 token 基线互补——基线只采到按钮/表格的数值，
// 母版回答「这一型页面在示例项目里长什么样」）。格式见 visual-prescreen.js parseMotherDoc；缺位时初筛照跑、报告写明未对照。
const UI_MOTHER_FILE = path.join(__dirname, '..', 'docs', '示例项目需求', '00-通用资料', '示例项目-UI母版.md')
function loadUiMother() {
  try { return prescreen.parseMotherDoc(fs.readFileSync(UI_MOTHER_FILE, 'utf8')) } catch { return null }
}
// 初筛记录落点：与 QA 报告卡片同目录（facet_doc 所在的版本目录），追加写，留下每一轮的结论
function prescreenRecordPathFor(taskFileRel) {
  try {
    const fm = parseFrontmatter(fs.readFileSync(safeResolve(taskFileRel), 'utf8')) || {}
    const fd = primaryFacetDoc(fm).replace(/\\/g, '/')
    if (!fd.includes('/')) return ''
    return `${fd.slice(0, fd.lastIndexOf('/'))}/视觉初筛记录.md`
  } catch { return '' }
}
function loadDesignBaseline() {
  try { return JSON.parse(fs.readFileSync(DESIGN_BASELINE_FILE, 'utf8')) } catch { return null }
}

// 本轮 GREEN 行绑的 run summary（去重、限量、失败不掀桌）。
// 用途：人工债三态判定（Z-C/Z-E/Z-G 是**断言类型**、没有端点可探，判据是 `steps[].actionType`
// 里有没有真挂过）+ 页面报错门与视觉门的真实取值。这三件的「清了没」不再由端点探活冒充。
const RUN_SUMMARY_FETCH_CAP = 8
async function batchRunSummaries(rows = []) {
  const ids = [...new Set((rows || []).map(r => String(r?.green?.runId || '').trim()).filter(Boolean))].slice(0, RUN_SUMMARY_FETCH_CAP)
  if (!ids.length) return []
  const outputRoot = await zhuzhuOutputRoot()
  if (!outputRoot) return []
  return ids.map(id => readRunSummaryAt(path.join(outputRoot, 'runs', id))).filter(Boolean)
}

// 机器门三态（true 过 / false 未过 / null 未验证）。**2026-09-07 重写**：
// 旧版把「猪猪 `/preflight` 端点通」当成「页面报错门过了」、把一个并不存在的 `/visual-review`
// 端点当成视觉门 —— 前者是假绿（preflight 是 Z-L 准入探针，跟页面报错毫无关系），后者恒 null。
// 现在两道门都从**本轮 run summary 的真实字段**取：`pageErrors`（null ≠ 0）与 `visualReview`。
function deriveMachineGates({ summaries = [], envFresh = null, verifyAvailable = false, outputRoot = '' } = {}) {
  const pe = summaries.map(s => zhuzhuCaps.pageErrorsFromSummary(s)).filter(x => x.available)
  // 视觉门要读到**真素材**才敢判（存根里只有数量与路径）；读不到一律 null＝未验证
  const vis = summaries.map(s => readVisualReviewArtifact(s, { outputRoot })).filter(x => x.available)
  return {
    // 有一份 summary 报了页面报错 → 门未过；全都是 0 → 过；一份都读不到 → 未验证
    'page-error': pe.length ? pe.every(x => x.count === 0) : null,
    'env-fresh': envFresh,
    discrimination: verifyAvailable ? true : null,
    // 有素材才判；一条视觉断言都没挂 → 未验证（**「没做」不是「通过」**）
    'visual-baseline': vis.length ? vis.every(x => qaCard.visualAcceptance(x).verdict === qaCard.VISUAL_VERDICTS.OK) : null,
    'ddl-precheck': null,   // 由 ddl_precheck 工具的结论决定，引擎侧无法自证 → 未验证
  }
}

// 晨检包装配（MCP 工具 + HTTP + deadline 结算三处共用；**全部入参来自机器事实**）
async function assembleMorningReportForRun(run, { items = [], selfReports = [], qaReportCard = '', settleActions = [] } = {}) {
  const c = guardContractFor(run) || { contract: {}, rel: '', runName: `${todayStr()}-adhoc` }
  const led = guardLedgerFor(c.runName) || guardLedger.emptyLedger(c.runName)
  const archiveRel = guardArchiveRelFor(run, c)
  const arun = archiveRel === run.taskFile ? run : { ...run, taskFile: archiveRel }   // 取档案派生物时统一走这份
  const rows = mergeFacetRowsForRun(arun) || []
  const version = archiveVersionOf(archiveRel) || String(c.fm?.version || '')
  // 猪猪能力探活（决定「本轮哪些机器门是开的」，也决定哪些结论只能记「未验证」）
  const probe = await zhuzhuCaps.probeCapabilities(zzOpts()).catch(() => null)
  const verify = await zhuzhuCaps.verifyEvidenceBatch(
    rows.filter(r => String(r.status).toUpperCase() === 'COVERED_GREEN').map(r => ({ facetId: r.facetId, runId: r.green?.runId || '', caseId: r.green?.case || '' })),
    zzOpts(),
  ).catch(() => ({ available: false, map: null }))
  led.fakeGreen = guardLedger.deriveFakeGreen(rows, verify.available ? verify.map : null)
  // 出包前先与登记表对账：已消化的 park 不该再以「等你拍板」的姿态印进包（2026-08-28 老板报的
  // 「进度跟真实的不一样」，一半来自这里——8 条待拍里 4 条早被后续轮次纳入做完了）。
  const parkRec = reqPool.reconcilePark(loadParkLedger(), entryRowsByReq(archiveRel))
  if (parkRec.closed.length) saveParkLedger(parkRec.entries)
  const park = parkRec.entries
  // 条目表：五个机器源合成（契约点名 / 台账 / 门禁定级 / park / 覆盖矩阵），agent 传来的 items 只补空。
  // 以前这里直接把 items 原样往下传，自动结算路径没人填 → 每天早上恒为「本轮 0 条目」。
  const derived = morningReport.deriveItems({ contract: c.contract, ledger: led, park, rows, agentItems: items, startedAt: c.contract?.starts_at || '', endedAt: guardRoundEndFor(c) })
  led.usage.itemsTaken = Math.max(Number(led.usage.itemsTaken || 0), derived.length)
  led.overBudget = guardLedger.checkBudget(c.contract, led.usage)
  saveGuardLedger(c.runName)
  const idx = facetIndexForRun(arun)
  // 环境新鲜度：**只有能证明时才说话**。`/env-fingerprint` 给的是指纹、不含 `fresh` 布尔
  // （2026-09-07 实测；旧代码 `data.fresh !== false` → undefined 恒真，是假绿）。没有比较基线 → null＝未验证。
  const envRes = await zhuzhuCaps.envFreshness({ baseUrl: zhuzhuConfig.targetBaseUrl || '' }, zzOpts()).catch(() => null)
  const envFresh = envRes ? envRes.fresh : null
  const trust = auditTrust.fakeGreenHunt({ rows, verify: verify.available ? verify.map : null, extra: { suspectAttestations: idx.suspectAttestations, envFingerprintFresh: envFresh } })
  // 本轮 GREEN 绑的 run summary：人工债三态与页面报错/视觉两道门都从它取真实字段（取一次，两处共用）
  const runSummaries = await batchRunSummaries(rows)
  const humanDebt = qaCard.humanDebtStatus({ capMap: probe?.map || {}, summaries: runSummaries, assertionKinds: sm => zhuzhuCaps.assertionKindsInSummary(sm) })
  // 门禁矩阵 + RC_READY 放行门（E6）：逐条目按 `risk_gate` 记下的定级算「够不够格进 RC_READY」。
  // 机器门的取值一律走**三态**：拿不到事实 → null（未验证），rcReadyGate 会把它算进 blocked
  // 并写「未验证不等于通过」——这是本版贯穿全局的口径，不在这里破例。
  const gateDecisions = Object.values(led.gateDecisions || {})
  const gateResults = deriveMachineGates({ summaries: runSummaries, envFresh, verifyAvailable: verify.available, outputRoot: await zhuzhuOutputRoot() })
  const facetKinds = [...new Set(rows.map(r => String(r.kind || '').toLowerCase()).filter(Boolean))]
  const gateBlocked = []
  for (const d of gateDecisions) {
    const g = gateMatrix.rcReadyGate({ riskClass: d.riskClass, facetKinds, gateResults })
    if (!g.passed) for (const b of g.blocked) gateBlocked.push(`${d.item}：${b}`)
  }
  // 一条目都没跑过 risk_gate → 那本身是个缺口，别让「没算过」看起来像「都通过了」
  if (!gateDecisions.length && derived.length) gateBlocked.push(`本轮 ${derived.length} 个条目**一条都没跑过 \`risk_gate\`** —— 门禁矩阵没有输入，「够不够格进 RC_READY」这一问引擎答不了（不是答「够」）`)
  const input = {
    runName: c.runName, version, date: todayStr(), archiveRel, contractRel: c.rel,
    contract: c.contract, items: derived, ledger: led, usage: led.usage,
    rcCommit: led.rcCommit?.line || run.frozenSha || '', park, trust, humanDebt,
    gateDecisions, gateBlocked, settleActions,
    idleMinutes: led.usage.idleStopMinutes ?? null,
    zeroItemsWhy: derived.length ? '' : zeroItemsWhy({ contract: c.contract, led, rows, park }),
    zhuzhuProbe: probe, qaReportCard, selfReports,
  }
  const gaps = morningReport.reportGaps(input)
  const body = morningReport.assembleMorningReport({ ...input, gaps })
  const name = `${todayStr()}-晨检包-${c.runName}.md`
  return { body, gaps, items: derived, abs: path.join(TASKS_DIR, name), rel: `${OFFICE_URI_PREFIX}/tasks/${name}`, runName: c.runName }
}
// ============================================================================
// 版本验收单（晨检包 v2）：一版一份、每天覆盖写
// 缘起见 `version-report.js` 顶注与复盘 §3.108。这里只做**取数与落盘**，判定全在纯函数模块里。
// ============================================================================

// 版本 → 该版本的全部守航轮次（按 starts_at 升序）。这是全仓第一个「按版本聚合轮次」的维度：
// 台账本身按 run_name 分片，一个版本的多轮此前是四个互不相干的文件。
// ⚠ 台账**只读加载、不进内存 Map**：`saveGuardLedger` 是 1500ms 防抖且一次全量重写所有内存台账，
//   把 4 轮历史台账拉进 Map 会让此后任何一次落盘顺手把它们全部重写（刷 mtime、覆盖磁盘上的手改）。
function readLedgerRaw(runName) {
  if (guardLedgers.has(runName)) return guardLedgers.get(runName)   // 已在热态就用热态，别读出第二份
  try { return JSON.parse(fs.readFileSync(guardLedgerPath(runName), 'utf8')) } catch { return null }
}
function guardRoundsForVersion(version, archiveRel) {
  const out = []
  let files = []
  try { files = fs.readdirSync(TASKS_DIR).filter(f => /守航契约-guarded-\d+\.md$/.test(f)) } catch { return out }
  for (const f of files) {
    const c = loadGuardContract(`${OFFICE_URI_PREFIX}/tasks/${f}`)
    if (!c) continue
    if (!versionReport.matchesVersion(c.fm || {}, { version, archiveBasename: archiveRel })) continue
    out.push({
      runName: c.runName, rel: c.rel, contract: c.contract, fm: c.fm,
      startsAt: String(c.contract?.starts_at || ''), endsAt: guardRoundEndFor(c),
      ledger: readLedgerRaw(c.runName) || guardLedger.emptyLedger(c.runName),
    })
  }
  return out.sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)))
}

// 本版**已停产的轮次级晨检包**（提醒老板别把旧口径当今天的结论）
function historicalRunReportsFor(rounds) {
  try {
    const names = new Set(rounds.map(r => r.runName))
    return fs.readdirSync(TASKS_DIR).filter(f => /-晨检包-.+\.md$/.test(f) && [...names].some(n => f.endsWith(`-晨检包-${n}.md`)))
  } catch { return [] }
}

const versionReportPathFor = (version, date) => path.join(TASKS_DIR, versionReport.versionReportName(version, date || todayStr()))
const versionReportExistsToday = version => { try { return fs.existsSync(versionReportPathFor(version)) } catch { return false } }

// 猪猪能力探活缓存（5 分钟）：验收单已改为**看板上按需渲染的视图**，每开一次页签就实调 6 个端点太贵，
// 猪猪不通时更会把打开时间拖成秒级。探活结果本来也不是秒级会变的东西。
let _probeCache = { at: 0, data: null }
async function probeCapabilitiesCached() {
  if (_probeCache.data && Date.now() - _probeCache.at < 5 * 60_000) return _probeCache.data
  const d = await zhuzhuCaps.probeCapabilities(zzOpts()).catch(() => null)
  _probeCache = { at: Date.now(), data: d }
  return d
}

// 装配一份版本验收单。`archiveRel` 可不传（按版本号反查档案）。
async function assembleVersionReportFor(version, { archiveRel = '', selfReports = [], qaReportCard = '', settleActions = [] } = {}) {
  // 只有当传进来的档案**确实属于这个版本**时才用它；否则按版本号反查。
  // 踩过：显式要 v5.19 的单，却把当前 run 那份 v5.20 档案原样带了进来，出来一份「版本写 v5.19、
  // 条目却是 v5.20 那 9 条」的假单——比不出单坏得多。
  const relOwned = archiveRel && normVersion(archiveVersionOf(archiveRel)) === normVersion(version) ? archiveRel : ''
  const found = relOwned ? null : findVersionArchive(version)
  const rel = relOwned || (found ? found.file : '')   // found.file 已含 office-lab/ 前缀，别再拼一次
  let text = '', fm = {}
  if (rel) { try { const abs = safeResolve(rel); text = fs.readFileSync(abs, 'utf8'); fm = parseFrontmatter(text) || {} } catch {} }
  const entries = text ? extractEntries(text) : []
  const rows = rel ? (mergeFacetRowsForRun({ taskFile: rel }) || []) : []
  const rounds = guardRoundsForVersion(version, rel)
  const latest = rounds.length ? rounds[rounds.length - 1] : null

  // park 与登记表对账（已消化的不再以「等你拍板」的姿态出现），落盘留证。
  // **视图路径（GET）也照做**：对账不是「替老板拍板」，它只是记录一条派生事实（这条 park 的条目已经上线了），
  // 幂等、留证、可回溯。若改成只报不写，视图每次都会印一遍「本次将关闭 5 条」——永远收敛不了，比写更吵。
  const parkRec = reqPool.reconcilePark(loadParkLedger(), entryRowsByReq(rel))
  if (parkRec.closed.length || parkRec.demoted.length) saveParkLedger(parkRec.entries)

  // 机器门探活与证据可信度（口径与轮次包完全一致：能力缺位一律记「未验证」，绝不记「通过」）
  const probe = await probeCapabilitiesCached()
  const verify = await zhuzhuCaps.verifyEvidenceBatch(
    rows.filter(r => String(r.status).toUpperCase() === 'COVERED_GREEN').map(r => ({ facetId: r.facetId, runId: r.green?.runId || '', caseId: r.green?.case || '' })),
    zzOpts(),
  ).catch(() => ({ available: false, map: null }))
  // 新鲜度只有能证明时才 true/false（`/env-fingerprint` 不返回 `fresh`，详见 zhuzhu-capabilities.js 文件头 §3）
  const envRes = await zhuzhuCaps.envFreshness({ baseUrl: zhuzhuConfig.targetBaseUrl || '' }, zzOpts()).catch(() => null)
  const envFresh = envRes ? envRes.fresh : null
  const idx = rel ? facetIndexForRun({ taskFile: rel }) : { suspectAttestations: [] }
  const trust = auditTrust.fakeGreenHunt({ rows, verify: verify.available ? verify.map : null, extra: { suspectAttestations: idx.suspectAttestations, envFingerprintFresh: envFresh } })
  const runSummaries = await batchRunSummaries(rows)
  const humanDebt = qaCard.humanDebtStatus({ capMap: probe?.map || {}, summaries: runSummaries, assertionKinds: sm => zhuzhuCaps.assertionKindsInSummary(sm) })

  // 门禁矩阵：把各轮的定级合起来（同一条目以最后一轮为准）
  const gateDecisions = Object.values(rounds.reduce((acc, r) => ({ ...acc, ...(r.ledger?.gateDecisions || {}) }), {}))
  const gateResults = deriveMachineGates({ summaries: runSummaries, envFresh, verifyAvailable: verify.available, outputRoot: await zhuzhuOutputRoot() })
  const facetKinds = [...new Set(rows.map(r => String(r.kind || '').toLowerCase()).filter(Boolean))]
  // 已交付的条目不再报「放行门未过」：放行门管的是「够不够格进 RC_READY」，已上线/已归档的条目
  // 这一问早已作废，继续列出来只会把第三章刷成噪声、把真正卡住的那几条淹掉。
  const shippedReqs = new Set([...entryRowsByReq(rel).entries()].filter(([, v]) => SHIPPED_STATUS.has(v.status)).map(([k]) => k))
  const gateBlocked = []
  for (const d of gateDecisions) {
    if (shippedReqs.has(String(d.item).toUpperCase())) continue
    const g = gateMatrix.rcReadyGate({ riskClass: d.riskClass, facetKinds, gateResults })
    if (!g.passed) for (const b of g.blocked) gateBlocked.push(`${d.item}：${b}`)
  }

  // ★ 从**任务档案**抽「今天真正等老板拍的」+「要老板亲眼看的」（2026-09-09 事故对策）：
  // 此前本单只读 park 台账 → 报出 12 条里 9 条是别模块的历史 park，而档案里当天新立的 15 条
  // （菲菲 `### 待老板拍` 那张表 + GG Bond 路由的 2 项）一条都没报。档案是唯一状态源，先读它。
  const brief = (() => {
    try {
      const text = fs.readFileSync(safeResolve(rel), 'utf8')
      const facets = loadFacetSet(fm).facets
      const decisions = taskBrief.extractDecisions(text).filter(d => !d.closed)
      const acc = taskBrief.buildAcceptance({ entries, matrix: rows.map(r => ({ facetId: r.facetId, status: r.status })), facets })
      return { decisions, costMissing: taskBrief.costMissing(decisions), needYouEyes: acc.flatMap(a => a.needYou) }
    } catch { return { decisions: [], costMissing: [], needYouEyes: [] } }
  })()

  const body = versionReport.assembleVersionReport({
    version, date: todayStr(), archiveRel: rel, fm, entries, rows, rounds, park: parkRec.entries,
    decisions: brief.decisions, costMissing: brief.costMissing, needYouEyes: brief.needYouEyes,
    gateBlocked, qaReportCard, selfReports, settleActions,
    historicalRunReports: historicalRunReportsFor(rounds),
    redLightsMd: latest ? guardLedger.renderRedLights(latest.ledger) : '',
    // 复用轮次渲染器时**必须换掉它自带的章号**，否则版本单里会冒出第二个「## 四、」（实测踩到）
    contractDiffMd: latest ? morningReport.renderContractDiff({ contract: latest.contract, ledger: latest.ledger, usage: latest.ledger?.usage || {}, heading: '### 契约 vs 实际（本轮审计 diff · 机器比对）' }) : '',
    extraSections: [
      morningReport.renderZhuzhuProbe(probe, '哪些机器门是开的（猪猪能力探活）'),
      gateDecisions.length ? gateMatrix.renderGateMatrix(gateDecisions) : '',
      auditTrust.renderTrustSection(trust),
      qaCard.renderHumanDebt(humanDebt),
    ],
  })
  const gaps = versionReport.versionGaps({ version, archiveRel: rel, entries, rows, rounds, orphanReqs: versionReport.deriveVersionItems({ entries, rows, rounds, park: parkRec.entries }).orphanReqs, qaReportCard })
  const abs = versionReportPathFor(version)
  return {
    body, gaps, entries, rounds, parkClosed: parkRec.closed, abs, version,
    rel: `${OFFICE_URI_PREFIX}/tasks/${path.basename(abs)}`,
  }
}

// 三条出口的统一入口：能定位到版本就出**版本验收单**，定位不到才退回轮次包（并在包里写明为什么）。
async function assembleAcceptanceReport(run, opts = {}) {
  const c = guardContractFor(run)
  const archiveRel = guardArchiveRelFor(run, c)
  const version = String(opts.version || '').trim() || archiveVersionOf(archiveRel) || String(c?.fm?.version || '')
  if (version && opts.scope !== 'round') {
    const out = await assembleVersionReportFor(version, { archiveRel, ...opts })
    return { ...out, scope: 'version', runName: c?.runName || '' }
  }
  const out = await assembleMorningReportForRun(run, opts)
  return { ...out, scope: 'round' }
}

// 0 条目时**必须说清为什么**（settleAtDeadline 的 report_zero_items 早就要求了，只是从没写进包）。
// 逐个数据源报「有没有料」，把「本轮真没做」和「引擎自己没记账」区分开——2026-08-28 那两份空包正是后者。
function zeroItemsWhy({ contract, led, rows, park }) {
  const named = contract?.selection?.named_items
  const namedN = (Array.isArray(named) ? named : String(named || '').split(/[,，\s]+/)).filter(Boolean).length
  const bits = [
    `契约点名 ${namedN} 条（selection.source=${contract?.selection?.source || '—'}）`,
    `台账 itemResults ${Object.keys(led?.itemResults || {}).length} 条`,
    `跑过 risk_gate ${Object.keys(led?.gateDecisions || {}).length} 条`,
    `本轮 park ${(park || []).length} 条（含历史轮）`,
    `覆盖矩阵 ${(rows || []).length} 行`,
  ]
  return bits.join('；') + '。' + (namedN || Object.keys(led?.itemResults || {}).length
    ? '**有输入却没派生出条目 → 属引擎/记账缺口，不是「本轮无事发生」**，请连同本包一起报修。'
    : '就绪池为空 / 全部 park / 老板未点名，三者之一——见 A1 巡航与 park 台账。')
}

function makeCollabTools(run) {
  return createSdkMcpServer({
    name: 'office-lab-collab',
    version: '0.1.0',
    tools: [
      tool(
        'create_work_document',
        '在 Office Lab 的 tasks/ 或 docs/ 下新建 Markdown 文档。用模板中的 frontmatter 建任务档案，初始状态必须为 CREATED，所有门禁为 false。不能覆盖旧文件。建档后调用 bind_task_file 绑定会话。',
        { file: z.string().max(240), markdown: z.string().min(1).max(200000) },
        async ({ file, markdown }) => {
          try {
            const normalized = file.replaceAll('\\', '/')
            if (/^(?:office-lab\/)?tasks\//.test(normalized)) {
              const meta = parseFrontmatter(markdown)
              if (!meta?.task || meta.status !== 'CREATED' || Object.values(meta.gates || {}).some(Boolean))
                throw new Error('任务档案须含 task，初始状态须为 CREATED，所有门禁为 false')
              if (/守航契约|晨检包/.test(file)) throw new Error('守航契约和晨检包由引擎生成')
            }
            const rel = createWorkDocument(OFFICE_ROOT, normalized, markdown)
            return { content: [{ type: 'text', text: rel }] }
          } catch (error) {
            return { isError: true, content: [{ type: 'text', text: error.code === 'EEXIST' ? '文档已存在，请使用新的路径。' : error.message }] }
          }
        },
      ),
      tool(
        'cc_colleague',
        '抄送(carbon copy)：知会另一位员工，让他并行去做他那份工作——你不停等、他也不用回发你。用于「我继续干、对方并行处理」的场景（如你改代码的同时让菲菲并行更新需求/facet，或菲菲改 facet 的同时让迷糊并行更新用例）。这不是交棒（交棒用【下一棒】会停下你），也不是回发（【交回】）。抄完这条你要接着干你手上的活。若你手上的活**必须等他们的产出**（如三方会审要等各方体检意见才能汇总冻结），可以就这么收工停下等：他们全部收工时引擎会自动把你这条会话唤回来收口（抄送汇合），你不必轮询、也不用叫老板转告。',
        {
          employee: z.string().describe('要抄送的员工：菲菲 / GG Bond / 迷糊老师 / 菲斯拉 / 波比 之一'),
          message: z.string().describe('给对方的完整指令（可多段）：目标 + 你改了什么 + 要他并行做什么'),
        },
        async ({ employee, message }) => {
          const key = resolveEmployeeKey(employee)
          if (!key) return { content: [{ type: 'text', text: `[抄送失败：无法识别员工「${employee}」]` }] }
          if (key === run.employee) return { content: [{ type: 'text', text: '[抄送失败：不能抄送自己]' }] }
          // 广度闸①：单回合 cc 数上限
          run._ccThisTurn = (run._ccThisTurn || 0) + 1
          const nm = EMPLOYEES[key]?.displayName || key
          if (run._ccThisTurn > CC_MAX_PER_TURN) {
            broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'cc-fanout-cap', text: `单回合抄送已超上限(${CC_MAX_PER_TURN})，抄送「${nm}」被拒——请合并并行知会或分回合` })
            return { content: [{ type: 'text', text: `[抄送被拒：单回合最多抄送 ${CC_MAX_PER_TURN} 人，已达上限]` }] }
          }
          const ccMsg = `【抄送】来自 ${EMPLOYEES[run.employee]?.displayName || run.employee}（并行知会：做完你这份即可，无需回发我）：\n\n${message}`
          // 目标忙：同一任务线 → 并入其当前会话（同任务的并行知会，不算污染）；跨任务线 → 扣进待处理队列，
          // 等它当前会话收工后单独起会话处理（避免把另一条线的消息塞进它正在做的这条线里，污染上下文）。
          const busy = busyRunFor(key, laneKeyOf(run))   // 同事在另一个工作区忙 ≠ 忙（worktree 隔离），见 busyRunFor
          if (busy) {
            if (threadOf(busy) === (run.threadRootId || run.id)) {
              pushTurn(busy, ccMsg, 'dispatch')
              bindCcChild(run, busy)   // 汇合闸：并入的这条会话也算本次扇出的子 run，它收工时要能把我唤回
              logConversation({ threadRootId: run.threadRootId || run.id, fromKind: 'employee', from: run.employee, to: key, toRunId: busy.id, kind: 'cc', text: message, depth: run.chainDepth || 0 })
              emitHandoff({ from: run.employee, to: key, kind: 'cc', fromRunId: run.id, runId: busy.id, merged: true }, message)
              return { content: [{ type: 'text', text: `[已抄送 ${nm}（其正在跑同一任务线，已排入它的下一回合）。你继续手上的活，不用等它；它收工后引擎会把你唤回收口]` }] }
            }
            // ccJoinOrigin：这条 cc 还没变成 run（目标忙在别的线，先扣队列）。汇合闸据此知道「扇出还没到齐」，
            // 等 drainPending 真起会话时回绑（见 drainPending / ccQueuedFor）——否则会误判「全部收工」提前唤回发起人。
            queuePending(key, { kind: 'cc', fromEmployee: run.employee, text: String(message).slice(0, 300), deliver: 'new', instruction: ccMsg, taskFile: run.taskFile, threadRootId: run.threadRootId || run.id, chainDepth: (run.chainDepth || 0) + 1, ccFrom: run.employee, ccJoinOrigin: run.id, executionMode: run.executionMode, guardContract: run.guardContract, lane: run.lane })
            emitHandoff({ from: run.employee, to: key, kind: 'cc', fromRunId: run.id, runId: null, queued: true }, message)
            logConversation({ threadRootId: run.threadRootId || run.id, fromKind: 'employee', from: run.employee, to: key, kind: 'cc', text: message, depth: run.chainDepth || 0 })
            return { content: [{ type: 'text', text: `[已抄送 ${nm}（其正忙于另一条任务线，已排入待处理队列——忙完当前会话后单独起会话处理，不打断它当前的活）。你继续手上的活，不用等它；它收工后引擎会把你唤回收口]` }] }
          }
          // 广度闸②：同一任务线并存活跃 run 预算
          const threadRoot = run.threadRootId || run.id
          const activeInThread = Array.from(liveRuns.values()).filter(r => (r.threadRootId || r.id) === threadRoot && (r.status === 'running' || r.status === 'starting')).length
          if (activeInThread >= CC_MAX_THREAD_RUNS) {
            broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'cc-thread-budget', text: `本任务线并行 run 已达上限(${CC_MAX_THREAD_RUNS})，抄送「${nm}」被拒——等有 run 收工再抄` })
            return { content: [{ type: 'text', text: `[抄送被拒：本任务线并行 run 已达上限(${CC_MAX_THREAD_RUNS})]` }] }
          }
          // 派生兄弟 run：不回发(callerRunId=null)、计深度(chainDepth+1 复用 maxDepth 兜乒乓)、继承 threadRootId(前端看板归组)
          // ⚠ **executionMode / guardContract 必须显式传**（2026-09-18 实账）：createDispatchRun 里这两项是
          //   `x || caller?.x` 继承，而 cc 的 callerRunId **按设计恒为 null**（cc 不回发）——于是一走 cc，
          //   守航态与契约双双掉线。guarded-02 就这么裂了：迷糊用 cc 把收束交给菲菲，菲菲那条会话变成共驾态、
          //   不绑任何契约，她随后所有的状态回写 `guardRecordItem` 全部返回 null → 守航台账 itemResults 永远
          //   停在「待QA / 打回」，而登记表已经是「QA通过 / 待人工」。晨检包第二章读登记表、三红灯章读台账，
          //   老板早上会看到一份自相矛盾的单子，且那一段工作在审计面上**根本不存在**。
          //   「不回发」说的是责任链，不是执行模式——cc 出去的仍是同一轮守航的活。
          const sib = createDispatchRun({ employee: key, taskFile: run.taskFile, instruction: ccMsg, kind: 'dispatch', chainDepth: (run.chainDepth || 0) + 1, callerRunId: null, threadRootId: threadRoot, ccFrom: run.employee, executionMode: run.executionMode, guardContract: run.guardContract, lane: run.lane })
          bindCcChild(run, sib)   // 汇合闸：登记子 run；它（及本轮其他 cc）全部收工时引擎把我唤回收口
          emitHandoff({ from: run.employee, to: key, kind: 'cc', fromRunId: run.id, runId: sib.id }, message)
          return { content: [{ type: 'text', text: `[已抄送 ${nm}（已并行起一条会话 ${sib.id}）。你继续手上的活，不用等它，它也不会回发你；它（连同你本轮抄送的其他人）全部收工后，引擎会自动把你这条会话唤回来收口——所以「等他们做完再汇总」这件事你可以放心停下等，不必自己轮询]` }] }
        },
      ),
      tool(
        'append_timeline',
        '往任务档案「## 时间线」原子追加一条记录（引擎串行落盘、并发安全）。改动了任务进度就用它记一笔——替代直接 Edit 时间线，防并行下互相覆盖 / 锚点失配静默失败。',
        { line: z.string().describe('一句话：发生了什么（引擎自动加当天日期前缀）'), file: z.string().optional().describe('任务档案相对路径，默认=你本次派工的任务档案') },
        async ({ line, file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案：请在 file 参数给出档案相对路径]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能写 tasks/ 下已存在的任务档案]' }] }
          try { await withArchiveLock(abs, () => engineAppendTimeline(abs, line)); return { content: [{ type: 'text', text: '[已追加时间线]' }] } }
          catch (e) { return { content: [{ type: 'text', text: `[追加失败：${String(e?.message || e)}]` }] } }
        },
      ),
      tool(
        'validate_task_archive',
        '只读自检任务档案的 facet/覆盖生命周期：facet_doc 是否存在+可解析、覆盖矩阵有无孤儿行/非法状态。交棒迷糊(QA)前先跑一遍，errors 清零再交（否则引擎门禁会拦下交棒）。不改任何文件。',
        { file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案') },
        async ({ file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案：请在 file 参数给出档案相对路径]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能校验 tasks/ 下已存在的任务档案]' }] }
          let v; try { v = validateArchiveFile(abs) } catch (e) { return { content: [{ type: 'text', text: `[校验读档失败：${String(e?.message || e)}]` }] } }
          if (!v.errors.length && !v.warnings.length) return { content: [{ type: 'text', text: `[✅ facet 生命周期自检通过：facet 全集 ${v.facetCount}、矩阵 ${v.matrixCount} 行，无 error/warning]` }] }
          const parts = []
          if (v.errors.length) parts.push(`❌ errors（会被门禁拦下，必须修）：\n- ${v.errors.join('\n- ')}`)
          if (v.warnings.length) parts.push(`⚠ warnings（不阻断，建议修）：\n- ${v.warnings.join('\n- ')}`)
          return { content: [{ type: 'text', text: parts.join('\n\n') }] }
        },
      ),
      tool(
        'scan_source_material',
        '数一份源材料里有多少个「可枚举单元」（原型 HTML 数 data-logic 标注元素 / md 数 ## 及更深标题 / base64 内嵌页逐页各数一遍）。这是源材料清点单 units 的**唯一合法来源——别手估**：手估的分母可以随手写小（写 38 就永远"覆盖完整"），机器数出来的不能。数不出来它会如实说数不出来（截图/无标注 HTML），那种才由你人工逐屏枚举后手填并写 by=。只读，不改任何文件。',
        { file: z.string().describe('源材料相对路径（如 office-lab/app/uploads/xxx.html 或 docs/xxx/PRD.md）') },
        async ({ file }) => {
          if (!file) return { content: [{ type: 'text', text: '[必须给 file]' }] }
          const abs = resolveRepoFile(file)
          if (!abs || !fs.existsSync(abs)) return { content: [{ type: 'text', text: `[找不到文件：${file}]` }] }
          let r; try { r = scanSourceMaterial(abs) } catch (e) { return { content: [{ type: 'text', text: `[扫描失败：${String(e?.message || e)}]` }] } }
          const L = [`【源材料清点】${file}`, `类型=${r.kind}　字节=${r.bytes}　可枚举单元=${r.units == null ? '数不出来（需人工）' : r.units}`]
          if (r.signals) L.push(`信号：data-logic 属性 ${r.signals.attrs} / LOGIC 字典 ${r.signals.dict}（取大者）`)
          if (r.note) L.push(`说明：${r.note}`)
          if (r.subDocs?.length) {
            L.push('', '内嵌页逐页清点（**每页在 source_materials 里各占一行**）：')
            for (const d of r.subDocs) L.push(`- \`${file}#${d.id}\`　units=${d.units}　字符=${d.chars}${d.note ? '　' + d.note : ''}`)
            L.push('', `建议清点单写法（抄进任务档案 frontmatter.source_materials）：`)
            for (const d of r.subDocs) L.push(`  - ${d.id.replace(/^doc-/, '')} | ${file}#${d.id} | prototype | units=${d.units} | read=full`)
          }
          if (r.unitIds?.length) L.push('', `单元样例（前 20）：${r.unitIds.slice(0, 20).join('、')}`)
          return { content: [{ type: 'text', text: L.join('\n') }] }
        },
      ),
      tool(
        'validate_req_trace',
        '只读自检**需求侧覆盖**（溯源闸 requirement_trace_complete）：facet 表有没有对着源材料的每个可枚举单元扫全。它和 validate_task_archive 是两个分母——那个问「facet 都测了吗」，这个问「facet 齐了吗」。交棒 GG Bond 开工前 / 把条目推进到「待开发及以后」前必须 errors 清零，否则引擎门禁会拦下。不改任何文件。',
        { file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案') },
        async ({ file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案：请在 file 参数给出档案相对路径]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能校验 tasks/ 下已存在的任务档案]' }] }
          let t; try { t = validateTraceFile(abs) } catch (e) { return { content: [{ type: 'text', text: `[校验读档失败：${String(e?.message || e)}]` }] } }
          const parts = [renderTraceSummary(t)]
          if (!t.active) parts.push(`（本档案创建于 ${TRACE_GATE_SINCE} 之前，溯源闸只软提示、不阻断；但**建议照样补**——它是"需求梳理漏没漏"的唯一机器判据。）`)
          if (t.warnings.length) parts.push(`⚠ warnings（不阻断，但降级读法必须带进会审与交接卡）：\n- ${t.warnings.join('\n- ')}`)
          if (!t.errors.length && !t.warnings.length && t.declared) parts.push('✅ 溯源自检通过：源材料每个单元都有处置，缺口与待拍板均为 0。')
          if (t.errors.length) parts.push(TRACE_HINT)
          return { content: [{ type: 'text', text: parts.filter(Boolean).join('\n\n') }] }
        },
      ),
      tool(
        'scan_open_items',
        '把源材料里 **PRD 自己标的开放项（⏳ 待确认/待拍/待定）全部抽出来**，带稳定 ID（形如 `d1#a_submitall⏳1`）+ 摘要，供你逐条建《源材料开放项台账》(open_items_doc)。为什么必须机器抽：开放项会在两轮梳理之间**静默蒸发**——2026-09-08 的返工清单里写过「唯一键要不要加轮次维」，09-09 的拍板清单里就没了，没人发现。台账里每条只能三种终态：`已决`（写口径+出处）/`待拍`（写它在哪份拍板清单第几条）/`不做`（写理由），**一条都不许缺行**。只读，不改任何文件。',
        { file: z.string().optional().describe('源材料相对路径（可带片段，如 office-lab/app/uploads/xxx.html#doc-d0）；不给则扫任务档案 source_materials 声明的全部材料'), id: z.string().optional().describe('该材料在清点单里的 id（如 d0），只在给了 file 时用于拼开放项 ID') },
        async ({ file, id }) => {
          const targets = []
          if (file) {
            const [rawPath, frag = ''] = String(file).split('#')
            const abs = resolveRepoFile(rawPath)
            if (!abs || !fs.existsSync(abs)) return { content: [{ type: 'text', text: `[找不到文件：${rawPath}]` }] }
            targets.push({ id: id || (frag ? frag.replace(/^doc-/, '') : 'm0'), abs, frag, shown: file })
          } else {
            if (!run.taskFile) return { content: [{ type: 'text', text: '[没有任务档案：请在 file 参数给出源材料路径]' }] }
            let tabs; try { tabs = safeResolve(run.taskFile) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
            let d; try { d = readReqSideDocs(tabs) } catch (e) { return { content: [{ type: 'text', text: `[读档失败：${String(e?.message || e)}]` }] } }
            for (const m of d.materials.materials || []) {
              const [rawPath, frag = ''] = String(m.path || '').split('#')
              const abs = resolveRepoFile(rawPath)
              if (abs && fs.existsSync(abs)) targets.push({ id: m.id, abs, frag, shown: m.path })
            }
            if (!targets.length) return { content: [{ type: 'text', text: '[任务档案 source_materials 里没有可读的材料——先跑 scan_source_material 把清点单补上]' }] }
          }
          const L = ['【源材料开放项清点】', '']
          let total = 0
          for (const t of targets) {
            let sc; try { sc = scanSubstance(t.abs, { fragment: t.frag }) } catch (e) { L.push(`- ${t.shown}：扫描失败 ${String(e?.message || e)}`); continue }
            const items = (sc.units || []).flatMap(u => (u.openItems || []).map(o => ({ id: `${t.id}#${u.key}⏳${o.seq}`, section: u.section, text: o.text })))
            total += items.length
            L.push(`### ${t.shown}　单元 ${sc.units?.length || 0} / 开放项 **${items.length}**${sc.note ? '　（' + sc.note + '）' : ''}`, '')
            if (items.length) {
              L.push('| 开放项 ID | 区块 | 事项（PRD 原文摘要） | 终态 | 决议/去向 |', '|---|---|---|---|---|')
              for (const it of items) L.push(`| ${it.id} | ${it.section || '—'} | ${it.text.replace(/\|/g, '｜')} |  |  |`)
              L.push('')
            }
          }
          L.push(`**合计 ${total} 条**。把上表整段抄进《源材料开放项台账》（模板 templates/pm-源材料开放项台账.md，路径填进任务档案 frontmatter.open_items_doc），逐条补「终态」与「决议/去向」两列：`)
          L.push('- `已决` —— 决议列写口径 + 出处（如「老板 2026-09-09 定 K：当天过期=自然日 24:00、不显倒计时」）。没有出处的"已决"跟"我按默认猜的"在账面上分不开。')
          L.push('- `待拍` —— 决议列写它在哪份拍板清单的第几条。待拍不落到清单上就是丢了；开工前必须清零。')
          L.push('- `不做` —— 决议列写理由。"不做"和"漏了"必须分得开。')
          return { content: [{ type: 'text', text: L.join('\n') }] }
        },
      ),
      tool(
        'validate_req_substance',
        '只读自检**需求实质**（实质闸 requirement_substance_complete）：溯源闸只问「每个源单元有没有一行、那一行填的 facet 号存不存在」——填一个桶就合规；本闸问「登记到的那条 facet 有没有真的把这个单元的判据写进去」。四道机器判据：①facet 扇入（一条吃太多单元＝太粗、测不动）②PRD 数值阈值有没有落进 facet 表 ③PRD 自标 ⏳ 的开放项台账闭没闭合 ④按原型自己划的区块算「专属 facet」（跨区块共用的桶不算——2026-09-09「详情抽屉 15 个单元 / 专属 0」就是这么现形的）。①③硬挡，②④出点名清单软提示、逐条给说法。不改任何文件。',
        { file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案') },
        async ({ file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案：请在 file 参数给出档案相对路径]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能校验 tasks/ 下已存在的任务档案]' }] }
          let s; try { s = validateSubstanceFile(abs) } catch (e) { return { content: [{ type: 'text', text: `[校验读档失败：${String(e?.message || e)}]` }] } }
          if (!s.unitTotal) return { content: [{ type: 'text', text: '[本版源材料里没抽到带 LOGIC 注册表的单元原文——实质闸的②③④对它不生效（①扇入仍按溯源表计）。若源材料是原型 HTML 却抽不到，先跑 scan_source_material 看它认出的是什么]' }] }
          const parts = [renderSubstanceSummary(s)]
          if (!s.active) parts.push('（本档案创建于实质闸生效日之前，只软提示、不阻断；但**建议照样清**——②④那两张点名清单是"自己找疏漏"最省力的入口。）')
          if (s.errors.length) parts.push(SUBSTANCE_HINT)
          return { content: [{ type: 'text', text: parts.filter(Boolean).join('\n\n') }] }
        },
      ),
      tool(
        'validate_feature_tree',
        '只读自检**需求侧纵向完整性**（功能树闸 feature_tree_complete）+ **把 ASCII 树状图画出来**。它与 validate_req_trace 是两个方向：溯源闸问「材料里的都登记了吗」（分母=材料），功能树闸问「功能拆到叶子了吗、每个叶子的目标用户/场景/边界/异常齐吗」（材料本身写得浅的部分只有它能逼出来）。三条硬判据：叶子必须挂真实 facet／交互类叶子的空态·失败态·无权限逐个交代（facet 或 `N/A:理由`）／每个节点回指源单元或显式 `补充:理由`。**树状图由本工具从表生成——别手画**（手画的与 facet 必然漂移）。不改任何文件。',
        { file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案') },
        async ({ file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案：请在 file 参数给出档案相对路径]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能校验 tasks/ 下已存在的任务档案]' }] }
          let g; try { g = validateFeatureTreeFile(abs) } catch (e) { return { content: [{ type: 'text', text: `[校验读档失败：${String(e?.message || e)}]` }] } }
          const parts = []
          const drawn = renderFeatureTree(g)
          if (drawn) parts.push(drawn)
          if (!g.active) parts.push(`（本档案创建于 ${TRACE_GATE_SINCE} 之前，功能树闸只软提示、不阻断；但**建议照样补**——溯源闸够不到"材料本身写得浅"那一半。）`)
          if (g.errors.length) parts.push(`❌ errors（会被门禁拦下，必须修）：\n- ${g.errors.join('\n- ')}`, TREE_HINT)
          if (g.warnings.length) parts.push(`⚠ warnings（不阻断，建议修）：\n- ${g.warnings.join('\n- ')}`)
          if (!g.errors.length && !g.warnings.length && g.declared) parts.push(`✅ 功能树结构判据通过：${g.stats.leaves} 个叶子全部挂了真实 facet、交互类叶子的三类边界都有交代、每个节点都回指了源单元或显式标了「补充」。`)
          return { content: [{ type: 'text', text: parts.filter(Boolean).join('\n\n') }] }
        },
      ),
      tool(
        'validate_req_analysis',
        '只读自检**需求分析质量**（req_analysis_complete），一次跑四项：①七项拷问标了【假设·待确认】/【缺口·必问】就必须出现在「待确认事项」里（标了不确定就得问出去，别自己消化掉）；④**引擎从你的产物算出「可疑点」并点名，你必须逐条给归宿**（`已补:`/`不是问题:`/`已问老板:`）——不是让你自己找茬（自己的盲区自己看不见），是机器点名、你正面回应；⑤用户工作流每一步必须落在功能树的某个节点上（落不上＝用户走不通），反过来没被任何流程用到的交互叶子也要解释；⑥需求缺陷率（冻结基线 vs 现在，**只报不拦**）。工作流表与自我批判回应表都写在《功能树》文档里。不改任何文件。',
        { file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案') },
        async ({ file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案：请在 file 参数给出档案相对路径]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能校验 tasks/ 下已存在的任务档案]' }] }
          let q; try { q = validateReqQualityFile(abs) } catch (e) { return { content: [{ type: 'text', text: `[校验读档失败：${String(e?.message || e)}]` }] } }
          const parts = [renderReqQuality(q)]
          if (!q.active) parts.push(`（本档案创建于 ${TRACE_GATE_SINCE} 之前，本闸只软提示、不阻断。）`)
          if (q.errors.length) parts.push(`❌ errors（会被门禁拦下，必须修）：\n- ${q.errors.join('\n- ')}`)
          if (q.warnings.length) parts.push(`⚠ warnings（不阻断）：\n- ${q.warnings.join('\n- ')}`)
          if (!q.errors.length && !q.warnings.length) parts.push('✅ 需求分析自检通过：拷问的不确定都问出去了、工作流每步都走得通、机器点名的可疑点全部有归宿。')
          return { content: [{ type: 'text', text: parts.filter(Boolean).join('\n\n') }] }
        },
      ),
      tool(
        'set_task_status',
        '设置任务档案 frontmatter 的 status / owner（引擎串行原子写、并发安全）——替代直接 Edit frontmatter。会顺带把 updated 置为今天。',
        { status: z.string().optional().describe('新的 status（见 README 状态机枚举），不改留空'), owner: z.string().optional().describe('新的 owner：feifei/ggbond/mihu/feisila/bobby/user，不改留空'), file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案') },
        async ({ status, owner, file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案]' }] }
          if (!status && !owner) return { content: [{ type: 'text', text: '[status/owner 至少给一个]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能写 tasks/ 下已存在的任务档案]' }] }
          // facet_doc 生命周期硬门禁：版本态推进到「待测及以后」(进 QA)前须先有可解析 facet_doc。守航态不硬挡。
          if (status && QA_ONWARD_STATUS.has(status) && run.executionMode !== 'guarded_run') {
            let gate; try { gate = validateArchiveFile(abs) } catch (e) { gate = { errors: [`facet 门禁读档失败：${String(e?.message || e)}`], warnings: [] } }
            if (gate.errors.length) return { content: [{ type: 'text', text: `[facet 门禁拦下：版本进 QA（→${status}）前须先有 facet_doc]\n- ${gate.errors.join('\n- ')}` }] }
          }
          // 需求溯源硬门禁（同 set_entry_status 那道，版本级同款把关）：版本态推进到「交开发及以后」
          // （HANDOFF_TO_DEV / DEV_* / HUMAN_PRECHECK / QA_* / IN_QA / DEVOPS_* / POST_RELEASE）前，
          // facet 表必须已对着源材料扫全。硬/软分档同条目级：菲菲本人或共驾态硬挡，守航态他人只软提示。
          if (status && /^(HANDOFF|DEV_|HUMAN_PRECHECK|QA_|IN_QA|DEVOPS_|POST_RELEASE|PM_RELEASE)/i.test(status)) {
            // devEntry＝版本级那道"交开发"的门（HANDOFF_TO_DEV / DEV_*）；其余格子只对菲菲本人硬挡。
            const msg = traceGateBlockMsg(abs, run, `版本 → ${status}`, { devEntry: /^(HANDOFF_TO_DEV|HANDOFF$|DEV_)/i.test(status) })
            if (msg) return { content: [{ type: 'text', text: msg }] }
          }
          // 发布交付物硬门禁（§3.103，2026-08-25 事故驱动）：版本任务置终态（DONE/ARCHIVED/CLOSED）前，菲菲的四件
          // 交付物必须齐。缘起：菲菲只交了 1/4 就【交回】，波比据此置 DONE、巡视也放行——**"交回了"被当成了"做完了"**。
          // 谁按 DONE 都过这道闸（不只菲菲）。返回 null（非版本任务/定位不到通用台账）＝不适用，绝不误挡；守航态不硬挡。
          if (status && TERMINAL_STATUS_RE.test(status) && run.executionMode !== 'guarded_run') {
            const chk = releaseDeliverableCheck(rel)
            if (chk && chk.missing.length) return { content: [{ type: 'text', text: `[发布交付物门禁拦下：${chk.version} 置「${status}」前，PM_RELEASE_NOTES 四件交付物未齐（SOP roles/feifei.md §⑤；引擎按落盘事实核对）]\n${releaseMissingLines(chk)}\n\n处置：把缺的几件交给菲菲补齐（她那一棒的整包是四件，不是派工点名的那一件），补完再置终态。第 ④ 件只打印在收工汇报里、必须是 code 卡（type:code, lang:text）才算数。` }] }
          }
          try {
            await withArchiveLock(abs, () => {
              if (status) engineSetFrontmatterScalar(abs, 'status', status)
              if (owner) engineSetFrontmatterScalar(abs, 'owner', owner)
              engineSetFrontmatterScalar(abs, 'updated', todayStr())
              syncTraceGate(abs)   // 溯源结论落 gate：看板/晨检据它显示"需求侧覆盖齐没齐"（与 qa_coverage_complete 并列的第二个分母）
            })
            broadcast({ type: 'tasks-changed' })
            return { content: [{ type: 'text', text: '[已更新 frontmatter]' + softValidateWarn(abs) + softTraceWarn(abs) }] }
          } catch (e) { return { content: [{ type: 'text', text: `[更新失败：${String(e?.message || e)}]` }] } }
        },
      ),
      tool(
        'set_entry_status',
        '设置任务档案「## 需求条目登记表」里某条目行的 状态/当前阶段/owner（引擎串行原子写、并发安全、按列名定位）。改条目状态一律用它，**别手 Edit 长表格**（锚点易失配、并行会互相覆盖）。status 必须是看板枚举值（否则拒收、看板会落灰）。no 不存在且给了 name → 在表尾新建一行。看板 issue 行的圆点色与「接棒」目标都由「状态」列驱动，进展一变就调它。',
        {
          no: z.string().describe('条目编号（登记表「#」列，如 REQ-0237 或 3）'),
          status: z.string().describe('条目状态，必须是枚举之一：' + ENTRY_STATUS_ENUM.join(' / ')),
          stage: z.string().optional().describe('当前阶段（自由文本，给人读 + 推断下一棒），不改留空'),
          owner: z.string().optional().describe('该条目当前负责人（登记表有 owner/负责 列才写），不改留空'),
          name: z.string().optional().describe('条目名称：仅当 no 在表里不存在、要新建该行时给'),
          file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案'),
        },
        async ({ no, status, stage, owner, name, file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案]' }] }
          if (!no) return { content: [{ type: 'text', text: '[必须给条目编号 no]' }] }
          if (!status || !ENTRY_STATUS_ENUM.includes(status)) return { content: [{ type: 'text', text: `[状态「${status || ''}」不合法，请从这些里选：${ENTRY_STATUS_ENUM.join(' / ')}]` }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能写 tasks/ 下已存在的任务档案]' }] }
          // facet_doc 生命周期硬门禁：把条目推进到「待测及以后」(进 QA)前，档案须有可解析 facet_doc。守航态不硬挡。
          if (QA_ONWARD_STATUS.has(status) && run.executionMode !== 'guarded_run') {
            let gate; try { gate = validateArchiveFile(abs) } catch (e) { gate = { errors: [`facet 门禁读档失败：${String(e?.message || e)}`], warnings: [] } }
            if (gate.errors.length) return { content: [{ type: 'text', text: `[facet 门禁拦下：条目进 QA（→${status}）前须先有 facet_doc]\n- ${gate.errors.join('\n- ')}` }] }
          }
          // 需求溯源硬门禁（2026-09-08 大货备货事故对策，复盘 §3.122）：条目推进到「待开发及以后」前，
          // facet 表必须已对着源材料逐单元扫过（source_materials 清点单 + trace_doc 映射表，缺口/待拍必须清零）。
          // 为什么挡在"进开发"而不是"进 QA"：缩水的 facet 表一旦进了开发，后面每道闸（会审背书/dev 自检/
          // 覆盖矩阵 38/38 全绿）都只围着它转、越测越确信——那次 38 条 facet 对 308 个原型单元，全绿到 RC_READY。
          // 硬/软分档（沿用「守航态不硬挡下游」的既有哲学）：产出人菲菲本人一律硬挡（这活就是她的）；
          // 共驾态（白天有人能补）一律硬挡；守航态的**其他员工**只软提示 + 指路 park+cc 菲菲，不把无人值守的夜里卡死。
          if (DEV_ONWARD_STATUS.has(status)) {
            const msg = traceGateBlockMsg(abs, run, `条目 ${no} → ${status}`, { devEntry: DEV_ENTRY_STATUS.has(status) })
            if (msg) return { content: [{ type: 'text', text: msg }] }
          }
          // 缺陷行专项 facet 门禁（BUG-001 漏 facet 事故对策）：BUG 行必须有配套壳号 facet(REQ-9NNN-Fn)进主 facet_doc，
          // 否则迷糊回归缺分母。软/硬分档：待预检=GG Bond 修复/人工预检窗口(尚未真进 QA)→只软提示、不阻断建行(容忍 BUG-001 场景中途建行)；
          // 待测及以后=真进 QA→硬挡「带病进 QA」。守航态(guarded_run)不参与——夜里无人值守不硬挡。
          const { isBug: _isBug, shellReq: _shellReq } = bugShellReq(no, name)
          const bugShellMissing = _isBug && run.executionMode !== 'guarded_run' && !facetDocHasShell(abs, _shellReq)
          if (bugShellMissing && QA_ONWARD_STATUS.has(status) && status !== '待预检') {
            return { content: [{ type: 'text', text: `[facet 门禁拦下：缺陷 ${no} 进 QA（→${status}）前须先有配套壳号 facet ${_shellReq}-Fn 收进版本主 facet_doc]\n- 请 cc_colleague("菲菲", "为 ${no} 在版本主《需求说明与验收标准》立 ${_shellReq} 壳号章节(表头对齐 facet 表)并 seed_coverage") 后再推进；四件套见 缺陷与需求产出门禁-四件套规范.md（缺陷号↔壳号：${no} → ${_shellReq}）` }] }
          }
          try {
            let hit
            await withArchiveLock(abs, () => { hit = engineSetEntryRow(abs, { no, status, stage, owner, name }); engineSetFrontmatterScalar(abs, 'updated', todayStr()); syncTraceGate(abs) })
            broadcast({ type: 'tasks-changed' })
            // 看板状态 → 守航条目账（机器事实：条目走到哪一格是看板驱动的，不必事后问 agent）。
            // 「打回」额外记一轮 DEV↔QA 返工 —— limits.max_dev_qa_rounds_per_item 此前从来没有过输入。
            {
              const c = guardContractFor(run)
              const req = (String(no).match(/REQ-\d+/i) || String(name || '').match(/REQ-\d+/i) || [''])[0]
              if (c && req) {
                const led = guardLedgerFor(c.runName)
                guardLedger.recordItemResult(led, req, { result: ENTRY_RESULT_MAP[status] || 'in_progress', force: true, boardStatus: status })
                if (status === '打回') guardLedger.bumpDevQaRound(led, req)
                saveGuardLedger(c.runName)
              }
            }
            let warn = softValidateWarn(abs) + softTraceWarn(abs)
            // 「待人工」vs「待人工验收」一字之差＝是不是守航终点（映射与缘起见 entry-status.js 的长注释）。
            // 判据取机器事实：该条目名下**没有 UNCOVERED facet** ⇒ QA 已收束，那多半该写「待人工验收」。
            // 刻意只软提示不改写——两者的差别是业务判断（QA 收没收束），引擎替它选就是替 QA 下结论。
            if (status === '待人工') {
              try {
                const reqId = (String(no).match(/REQ-\d+/i) || String(name || '').match(/REQ-\d+/i) || [''])[0]
                const rows = reqId ? (extractCoverageMatrix(fs.readFileSync(abs, 'utf8')) || []) : []
                const mine = rows.filter(r => String(r.facetId || '').toUpperCase().startsWith(reqId.toUpperCase()))
                const uncovered = mine.filter(r => String(r.status || '').toUpperCase() === 'UNCOVERED').length
                if (mine.length && uncovered === 0) {
                  warn += `\n⚠ **「待人工」还是「待人工验收」？** ${reqId} 名下 ${mine.length} 条 facet **没有一条 UNCOVERED**（＝QA 已收束，剩下的是等人眼看）。这两个词一字之差：\`待人工\`＝QA 尚未收束，守航台账记「在测」；\`待人工验收\`＝已到验收门，台账记 **rc_ready（守航终点）**。若你判 QA 确已收束，改用「待人工验收」；若确实还没测完，保持现状并在时间线写清还差什么。（实账：guarded-01 的 REQ-0342 同样带 BLOCKED_WITH_PROOF，用的是「待人工验收」。）`
                }
              } catch { }
            }
            // 到这里 bugShellMissing 仍为真 = 状态是「待预检」或非 QA 态（QA 硬挡态已早返回）→ 软提示引导补壳号 facet。
            if (bugShellMissing) warn += `\n⚠ 缺陷 facet 未立：${no} 尚无配套壳号 facet ${_shellReq}-Fn（qa-缺陷单模板已内建骨架）——请 cc_colleague("菲菲", "为 ${no} 在版本主 facet_doc 立 ${_shellReq} 壳号章节并 seed_coverage")，否则推进到「待测/待QA」会被硬挡、迷糊回归缺分母。`
            return { content: [{ type: 'text', text: `[已更新条目 #${no}「${hit || ''}」→ 状态=${status}${stage ? ' · ' + stage : ''}]${warn}` }] }
          } catch (e) { return { content: [{ type: 'text', text: `[更新失败：${String(e?.message || e)}]` }] } }
        },
      ),
      // ── 覆盖率闸门三件套（提案见 docs/迷糊QA覆盖率闸门-方案设计.md）：seed 播种 / set 记结论 / status 自检 ──
      tool(
        'seed_coverage',
        'facet 覆盖矩阵【播种】：从《需求说明与验收标准》的 facet 表把所有 facet ID 建进任务档案「## 覆盖矩阵」（初始状态 UNCOVERED）。三方会审即建骨架（shift-left）、迷糊开工也可补建。facet 文档需有 facet ID 列（形如 REQ-0212-F1），否则解析不到。**中途插单时给新那份的路径即可，引擎会把它追加进 frontmatter.facet_doc 列表、不覆盖已有的**（分母＝所有已登记文档的并集）。',
        { facetDoc: z.string().optional().describe('facet 文档相对路径（如 docs/示例项目需求/06-v5.17/…需求说明与验收标准.md）；**追加**进 frontmatter.facet_doc（已在列表里则只重播不重复登记）。留空=拿 frontmatter 里已登记的全部文档重播一遍'), file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案') },
        async ({ facetDoc, file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能写 tasks/ 下已存在的任务档案]' }] }
          const fm = parseFrontmatter(fs.readFileSync(abs, 'utf8')) || {}
          // 追加语义（2026-09-03 v5.21 事故根因）：旧版这里无条件 engineSetFrontmatterScalar('facet_doc', docRel)，
          // 于是一版里每插一条 REQ、播一次它自己那份储备文档，版本主文档的指针就被顶掉一次——最后播的那份赢。
          // 后果不止看板判据空白（其余 facet 全成 unlisted），**门禁分母也塌到那一份**，剩下的 facet 直接不进 gaps＝fail-open。
          const known = facetDocList(fm.facet_doc)
          const docRels = facetDoc ? (known.includes(facetDoc) ? known : [...known, facetDoc]) : known
          if (!docRels.length) return { content: [{ type: 'text', text: '[没给 facetDoc、frontmatter 也无 facet_doc——请给 facet 文档路径]' }] }
          const sets = [], missing = [], empty = []
          for (const d of docRels) {
            const docAbs = resolveRepoFile(d)
            if (!docAbs) { missing.push(d); continue }
            const set = extractFacetsFromDoc(fs.readFileSync(docAbs, 'utf8'))
            if (!set.length) empty.push(d)
            sets.push(set)
          }
          if (missing.length) return { content: [{ type: 'text', text: `[找不到 facet 文档：${missing.join('、')}]` }] }
          const facets = mergeFacetSets(sets)
          if (!facets.length) return { content: [{ type: 'text', text: `[facet 文档里没解析到带 ID 的 facet 表（需 facet ID 列，形如 REQ-0212-F1）：${docRels.join('、')}]` }] }
          let res
          try { await withArchiveLock(abs, () => { res = engineSeedCoverage(abs, facets); engineSetFrontmatterList(abs, 'facet_doc', docRels); engineSetFrontmatterScalar(abs, 'updated', todayStr()) }) }
          catch (e) { return { content: [{ type: 'text', text: `[播种失败：${String(e?.message || e)}]` }] } }
          broadcast({ type: 'tasks-changed' })
          const emptyNote = empty.length ? `\n⚠ 这些文档解析到 0 个 facet（路径写错？还没写 facet 表？）：${empty.join('、')}` : ''
          return { content: [{ type: 'text', text: `[已播种覆盖矩阵：facet 全集 ${res.total}（来自 ${docRels.length} 份文档），新增 ${res.added} 行(UNCOVERED)。facet_doc=${docRels.join('、')}。之后逐条 set_facet_coverage 记结论。]${emptyNote}` + softValidateWarn(abs) }] }
        },
      ),
      tool(
        'set_facet_coverage',
        '给某条 facet 记风险处置/未覆盖结论。COVERED_GREEN 禁止手填，只能由 reconcile_coverage 从真实 summary 机读签发；SOURCE_ATTESTED / BLOCKED_WITH_PROOF / HUMAN_INHERENT 都不会让 qa_passed 变绿。',
        {
          facetId: z.string().describe('facet ID，形如 REQ-0212-F2'),
          status: z.string().describe('覆盖状态，必须是枚举之一：' + COVERAGE_STATUS_ENUM.join(' / ')),
          evidence: z.string().optional().describe('证据：GREEN→runId/summary 路径；SOURCE_ATTESTED→源码 file:line + 人工照点；BLOCKED_WITH_PROOF→截图/报错路径 + 复验时间戳'),
          red: z.string().optional().describe('RED 证据：该断言在错误实现/走错动作下跑红的 run（COVERED_GREEN 必填，否则 qa_red_calibrated 不绿）'),
          file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案'),
        },
        async ({ facetId, status, evidence, red, file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案]' }] }
          if (!facetId) return { content: [{ type: 'text', text: '[必须给 facetId]' }] }
          if (!status || !COVERAGE_STATUS_ENUM.includes(status)) return { content: [{ type: 'text', text: `[状态「${status || ''}」不合法，请从这些里选：${COVERAGE_STATUS_ENUM.join(' / ')}]` }] }
          if (status === 'COVERED_GREEN') return { content: [{ type: 'text', text: '[拒绝手填 COVERED_GREEN：请运行测试后用 reconcile_coverage，让引擎校验 linter、summary、test hash、commit 和环境并签发证据]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能写 tasks/ 下已存在的任务档案]' }] }
          try { await withArchiveLock(abs, () => { engineSetFacetRow(abs, { facetId, status, evidence, red }); engineSetGate(abs, 'qa_coverage_complete', false); engineSetGate(abs, 'qa_red_calibrated', false); engineSetGate(abs, 'qa_passed', false); engineSetFrontmatterScalar(abs, 'updated', todayStr()) }) }
          catch (e) { return { content: [{ type: 'text', text: `[记录失败：${String(e?.message || e)}]` }] } }
          broadcast({ type: 'tasks-changed' })
          const warns = []
          if (status === 'BLOCKED_WITH_PROOF' && !String(evidence || '').trim()) warns.push('BLOCKED 必须附阻断证据(截图/报错/复验)')
          // C3.8（§3.132）：视觉类人工声明当场提醒——机器这条路走完了吗？收工时 qa_report_card 会硬判一次
          if (qaCard.isVisualHumanClaim({ status, reason: evidence, evidence }) && !(visualFootprint.get(run.id)?.withMaterial > 0))
            warns.push('这是**视觉类**人工声明，但本轮还没有任何视觉素材：先挂 `assertVisual`/`assertVisualPeers` 跑两趟(首跑录基线、第二趟出判定)→`visual_acceptance`；行为约定走 `ux_contract_check`(不需要浏览器)；headless 真够不到的走 `run_app`。收工 `qa_report_card` 会按 C3.8 硬判，没素材一律记「未做」')
          if (status === 'SOURCE_ATTESTED' && !String(evidence || '').trim()) warns.push('SOURCE_ATTESTED 必须附源码锚点/人工照点')
          if (status === 'SOURCE_ATTESTED') {
            try {
              const rq = (String(facetId).match(/REQ-\d+/i) || [''])[0].toUpperCase()
              if (rq && reqsWithValidGreen(extractCoverageMatrix(fs.readFileSync(abs, 'utf8'))).has(rq))
                warns.push('此 REQ 已有真绿用例（造数链已证明可跑通）→ SOURCE_ATTESTED 恐属逃避真跑：补真闭环(reconcile→GREEN)，或如实标 BLOCKED_WITH_PROOF/HUMAN_INHERENT；发波比闸门会点名(suspectAttestations)')
            } catch { }
          }
          return { content: [{ type: 'text', text: `[已记 ${String(facetId).toUpperCase()} → ${status}；qa_passed 已由引擎置 false]${warns.length ? '  ⚠ ' + warns.join('；') : ''}` + softValidateWarn(abs) }] }
        },
      ),
      tool(
        'coverage_status',
        '查本版覆盖率闸门【现状】（引擎算、非自评）：facet 全集 / 各状态计数 / 缺口清单 / RED 缺口。发波比前自检用——缺口清零才放行。',
        { file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案') },
        async ({ file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          let text; try { text = fs.readFileSync(abs, 'utf8') } catch { return { content: [{ type: 'text', text: '[读不到档案]' }] } }
          const fm = parseFrontmatter(text) || {}
          let fset; try { fset = loadFacetSet(fm) } catch (e) { return { content: [{ type: 'text', text: `[读 facet_doc 失败（fail-closed）：${String(e?.message || e)}]` }] } }
          if (!fset.rels.length) { try { await withArchiveLock(abs, () => engineSetGate(abs, 'qa_passed', false)) } catch { }; return { content: [{ type: 'text', text: '[缺 facet_doc，qa_passed=false（fail-closed）]' }] } }
          // 列了却读不到＝分母不完整，绝不能拿剩下那几份凑合算（会把失联文档里的 facet 当"不存在"而漏判）
          if (fset.missing.length) { try { await withArchiveLock(abs, () => engineSetGate(abs, 'qa_passed', false)) } catch { }; return { content: [{ type: 'text', text: `[facet_doc 不存在，qa_passed=false：${fset.missing.join('、')}]` }] } }
          if (!fset.facets.length) return { content: [{ type: 'text', text: '[facet_doc 无可解析 facet（fail-closed）]' }] }
          const cov = computeCoverage(text, fset.facets)
          if (!cov) return { content: [{ type: 'text', text: '[本版还没采用 facet 覆盖矩阵——先 seed_coverage 播种，且 facet 文档需有 facet ID 表]' }] }
          try { await withArchiveLock(abs, () => { engineSetGate(abs, 'qa_coverage_complete', cov.coverageComplete); engineSetGate(abs, 'qa_red_calibrated', cov.redComplete); engineSetGate(abs, 'qa_passed', cov.passed) }) }
          catch (e) { return { content: [{ type: 'text', text: `[门禁结果落档失败（fail-closed）：${String(e?.message || e)}]` }] } }
          const lines = [
            `facet 全集 ${cov.denom}｜状态分布 ${JSON.stringify(cov.byStatus)}`,
            `覆盖完整=${cov.coverageComplete}  RED完整=${cov.redComplete}${cov.hasDoc ? '' : '（注：无 facet_doc，分母=矩阵自身行，测不出"漏行"）'}`,
            cov.gaps.length ? `缺口(${cov.gaps.length})：\n` + cov.gaps.slice(0, 40).map(g => `  · ${g.facetId}：${g.why}`).join('\n') : '无覆盖缺口 ✓',
            cov.redGaps.length ? `RED 缺口(${cov.redGaps.length})：\n` + cov.redGaps.slice(0, 40).map(g => `  · ${g.facetId}：${g.why}`).join('\n') : '无 RED 缺口 ✓',
            // 通道缺口单独点一次：它混在 gaps 里容易被当成"还没测"，而它是"测了但走错通道"——处置完全不同
            (cov.channelGaps || []).length ? `⛔ 验证通道缺口(${cov.channelGaps.length})：UI 面 facet 拿的是接口通道的绿（或证据没标通道）——\n` + cov.channelGaps.slice(0, 40).map(g => `  · ${g.facetId}：期望 ${g.want}、实际 ${g.got || '（未标）'}`).join('\n') + '\n  补 UI 通道用例（带 UI 断言）重跑 reconcile_coverage；界面这条路真走不通的如实标 HUMAN_INHERENT。' : '',
            // 通道声明度：让「这道闸覆盖了多少条」可见——推断是兜底，不是口径（别让它以"已上线"名义只管住零星几条）
            cov.viaTally ? `验证通道声明度：facet_doc 显式声明 ${cov.viaTally.declared} · 引擎推断 ${cov.viaTally.inferred} · 无信号 ${cov.viaTally.none}${cov.viaTally.none ? '（这批通道闸不生效——请 cc 菲菲在 facet 表加 `通道` 列逐条写 ui/api/any）' : ''}` : '',
          ].filter(Boolean)
          return { content: [{ type: 'text', text: lines.join('\n') }] }
        },
      ),
      tool(
        'reconcile_coverage',
        '机器回捞 GREEN/RED：校验用例 linter 与 qaTrace，再把 summary、测试文件哈希、summary 哈希、Git commit、环境和 case 绑定为证据。GREEN 只来自 passed run；RED 只来自显式 redCalibrationId 的失败校准 run。',
        {
          runDir: z.string().describe('App-run 输出目录（含各 case 子目录/summary.json），相对仓库根或绝对路径，如 vision-e2e/output/runs/<...>-panel-run-<...>'),
          redRunDir: z.string().optional().describe('可选：故障注入/反事实 RED 校准输出目录；对应 case 必须声明 qaTrace.assert.redCalibrationId 且实际失败'),
          testFile: z.string().describe('该批用例的测试文件绝对/仓库根相对路径（读 cases[].coversFacets 映射），如 vision-e2e/test-workflows/v5.17/sampling-5-17-regression.json'),
          file: z.string().optional().describe('任务档案相对路径，默认=本次派工档案'),
        },
        async ({ runDir, redRunDir, testFile, file }) => {
          const rel = file || run.taskFile
          if (!rel) return { content: [{ type: 'text', text: '[没有任务档案]' }] }
          let abs; try { abs = safeResolve(rel) } catch { return { content: [{ type: 'text', text: '[路径非法]' }] } }
          if (!abs.startsWith(TASKS_DIR + path.sep) || !fs.existsSync(abs)) return { content: [{ type: 'text', text: '[只能写 tasks/ 下已存在的任务档案]' }] }
          const resolveIn = p => { try { const a = path.isAbsolute(p) ? path.resolve(p) : path.resolve(ROOT, p); if (a !== ROOT && !a.startsWith(ROOT + path.sep)) return null; return a } catch { return null } }
          const rd = resolveIn(runDir), redRd = redRunDir ? resolveIn(redRunDir) : null, tf = resolveIn(testFile)
          if (!rd || !fs.existsSync(rd)) return { content: [{ type: 'text', text: `[找不到 runDir：${runDir}]` }] }
          if (redRunDir && (!redRd || !fs.existsSync(redRd))) return { content: [{ type: 'text', text: `[找不到 redRunDir：${redRunDir}]` }] }
          if (!tf || !fs.existsSync(tf)) return { content: [{ type: 'text', text: `[找不到 testFile：${testFile}]` }] }
          const scanSummaries = dirRoot => {
            const results = []
            const entries = fs.readdirSync(dirRoot, { withFileTypes: true, recursive: true })
            for (const e of entries) {
              if (!e.isFile() || e.name !== 'summary.json') continue
              const dir = e.parentPath || e.path || dirRoot
              const summaryPath = path.join(dir, 'summary.json')
              const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
              const caseId = (summary.testContext && summary.testContext.caseId) || path.basename(dir)
              const ok = summary.ok === true || String(summary.status || '').toLowerCase() === 'passed'
              // Z-D 的证据包与 summary 同级。`failureClass` 只在这里，不在 summary——
              // 读不到就退化成标题正则（留痕 redBasis），读得到就是结构判定。缺文件不报错（老产物兼容）。
              let bundle = null
              try { bundle = JSON.parse(fs.readFileSync(path.join(dir, 'evidence-bundle.json'), 'utf8')) } catch { bundle = null }
              results.push({ caseId, ok, summary, summaryPath, bundle })
            }
            return results
          }
          const isCleanGreen = r => {
            if (!r.ok) return false
            const c = r.summary?.stepCounts || {}
            return Number(c.total) > 0 && Number(c.executed) === Number(c.total) && Number(c.failed || 0) === 0 && Number(c.skipped || 0) === 0 && Number(c.stopped || 0) === 0
          }
          // C7：RED 校准判据换成**结构判据**（`failureClass === 'value-assertion'`），标题正则只作降级兜底。
          // 旧实现只有正则，两个后果实测过：中文步骤标题必须硬加英文 `assert` 才被认可（迷糊 memories 里记着）；
          // 「把动作失败包装成 assert 标题」的后门一直开着。降级时**留痕**（redBasis=title-regex），
          // 让 F1 与晨检包能区分「结构判定的校准红」和「正则蒙对的校准红」。见 zhuzhu-capabilities.js 该函数注释。
          const redBasisSeen = new Set()
          const isCalibratedRed = r => {
            if (r.ok) return false
            const v = zhuzhuCaps.classifyRedFromSummary(r.summary, r.bundle)
            redBasisSeen.add(v.basis)
            return v.calibrated
          }
          let caseResults, redResults = []
          try { caseResults = scanSummaries(rd); if (redRd) redResults = scanSummaries(redRd) }
          catch (e) { return { content: [{ type: 'text', text: `[扫 summary 失败（fail-closed）：${String(e?.message || e)}]` }] } }
          if (!caseResults.length) return { content: [{ type: 'text', text: `[runDir 下没找到任何 summary.json：${runDir}]` }] }
          let testJson; try { testJson = JSON.parse(fs.readFileSync(tf, 'utf8')) } catch (e) { return { content: [{ type: 'text', text: `[testFile 不是合法 JSON：${String(e?.message || e)}]` }] } }
          const cmap = caseFacetMapFromTestFile(testJson)
          if (!Object.keys(cmap).length) return { content: [{ type: 'text', text: `[测试文件里没有 cases[].coversFacets 声明——先在用例 JSON 给每个 case 加 coversFacets（见 e2e 生成规范），或改用 set_facet_coverage 手记]` }] }
          // 有效性 linter（G2/G3/G4 + qaTrace）：lintAck 只留痕、不豁免；任何 error 都不置 GREEN。
          let facetClass = {}, facetVia = {}, authoritativeFacets
          try {
            const afm = parseFrontmatter(fs.readFileSync(abs, 'utf8')) || {}
            const fset = loadFacetSet(afm)
            if (!fset.rels.length) throw new Error('任务档案缺 facet_doc')
            if (fset.missing.length) throw new Error(`facet_doc 不存在：${fset.missing.join('、')}`)
            authoritativeFacets = fset.facets
            if (!authoritativeFacets.length) throw new Error('facet_doc 无可解析 facet')
            facetClass = facetClassMap(authoritativeFacets)
            facetVia = facetViaMap(authoritativeFacets)
          } catch (e) { return { content: [{ type: 'text', text: `[读取权威 facet 失败（fail-closed）：${String(e?.message || e)}]` }] } }
          const lint = lintTestFile(testJson, { facetClass, facetVia })
          const blockedCases = {}; for (const f of lint.findings) if (f.severity === 'error') (blockedCases[f.caseId] = blockedCases[f.caseId] || []).push(f.code)
          const byCase = new Map((testJson.cases || []).map(c => [String(c.id || c.caseId || ''), c]))
          const redByCase = new Map()
          for (const rr of redResults) {
            const tc = byCase.get(String(rr.caseId))
            const cal = zhuzhuCaps.classifyRedFromSummary(rr.summary, rr.bundle)
            if (!isCalibratedRed(rr) || !tc?.qaTrace?.assert?.redCalibrationId) continue
            // 判据来源写进 RED 证据串：`redBasis=failureClass` 是结构判定，`title-regex` 是降级。
            // 这个字段**不进** GREEN_EVIDENCE_FIELDS（validateMachineEvidence 不校验它），历史档案照旧兼容。
            try { redByCase.set(String(rr.caseId), machineEvidence({ summaryPath: rr.summaryPath, summary: rr.summary, testFile: tf, caseId: rr.caseId }) + `;redBasis=${cal.basis}${cal.failureClass ? `;failureClass=${cal.failureClass}` : ''};via=${caseChannel(tc)}`) }
            catch (e) { return { content: [{ type: 'text', text: `[RED 证据签发失败（fail-closed）：${String(e?.message || e)}]` }] } }
          }
          // 验证通道（via）：从用例 steps 机读「这条 case 是走界面还是打接口」，写进证据串。
          // 不是自报——与 runId/testHash 同一批机器事实；UI 面 facet 拿 api 通道的绿，computeCoverage 不认。
          const facetViaOf = fid => {
            const f = (authoritativeFacets || []).find(x => String(x.id).toUpperCase() === String(fid).toUpperCase())
            return (f && f.via) || inferFacetVia({ kind: (f && f.kind) || '' })
          }
          const greens = [], failCases = [], lintBlocked = [], channelBlocked = []
          for (const cr of caseResults) {
            const facets = cmap[cr.caseId] || cmap[String(cr.caseId).toLowerCase()] || []
            if (!facets.length) continue
            if (!isCleanGreen(cr)) { failCases.push(cr.caseId); continue }
            if (blockedCases[cr.caseId]) { lintBlocked.push({ caseId: cr.caseId, codes: blockedCases[cr.caseId] }); continue }   // passed 但有效性不合格 → 不置绿
            const via = caseChannel(byCase.get(String(cr.caseId)) || {})
            let evidence
            try { evidence = machineEvidence({ summaryPath: cr.summaryPath, summary: cr.summary, testFile: tf, caseId: cr.caseId }) + `;via=${via}` }
            catch (e) { return { content: [{ type: 'text', text: `[GREEN 证据签发失败（fail-closed）：${String(e?.message || e)}]` }] } }
            for (const fid of facets) {
              const want = facetViaOf(fid)
              const chk = viaSatisfies(want, via)
              // 通道不符：**照旧写行、照旧带证据**（留痕，别让"跑过了"消失），但 computeCoverage 不计通过。
              // 这样迷糊在结论里看得见"我跑了、通道不对"，而不是行凭空不见。
              if (!chk.ok) channelBlocked.push({ caseId: cr.caseId, facetId: String(fid).toUpperCase(), want, got: via })
              greens.push({ facetId: fid, evidence, red: redByCase.get(String(cr.caseId)) || '' })
            }
          }
          try { await withArchiveLock(abs, () => {
            for (const g of greens) engineSetFacetRow(abs, { facetId: g.facetId, status: 'COVERED_GREEN', evidence: g.evidence, red: g.red })
            const afm = parseFrontmatter(fs.readFileSync(abs, 'utf8')) || {}
            const fset = loadFacetSet(afm)
            if (!fset.rels.length || fset.missing.length) throw new Error(`缺 facet_doc，不能计算 qa_passed${fset.missing.length ? `（读不到：${fset.missing.join('、')}）` : ''}`)
            const cov = computeCoverage(fs.readFileSync(abs, 'utf8'), fset.facets)
            engineSetGate(abs, 'qa_coverage_complete', !!cov?.coverageComplete)
            engineSetGate(abs, 'qa_red_calibrated', !!cov?.redComplete)
            engineSetGate(abs, 'qa_passed', !!cov?.passed)
            engineSetFrontmatterScalar(abs, 'updated', todayStr())
          }) }
          catch (e) { return { content: [{ type: 'text', text: `[回写失败：${String(e?.message || e)}]` }] } }
          broadcast({ type: 'tasks-changed' })
          const parts = [
            `[已回捞：${caseResults.length} 个 GREEN run case，置 GREEN ${greens.length} 条 facet；RED 校准签发 ${redByCase.size} 个 case。qa_passed 已由引擎重算。]`,
            lintBlocked.length ? `⛔ 有效性 linter 拦下 ${lintBlocked.length} 个 case（passed 但证据链不成立·未置绿）：${lintBlocked.map(b => b.caseId + '[' + b.codes.join(',') + ']').join('；')}。lintAck 只记录申诉，不再豁免；请补造数、真实被测动作、值/反事实断言和 qaTrace 数据血缘。` : '',
            channelBlocked.length ? `⛔ **验证通道不符 ${channelBlocked.length} 条**（行与证据已留痕，但覆盖闸门不计通过）：${channelBlocked.slice(0, 12).map(b => `${b.facetId}(期望 ${b.want}·实际 ${b.got}·case ${b.caseId})`).join('；')}${channelBlocked.length > 12 ? ` …还有 ${channelBlocked.length - 12} 条` : ''}。\n   UI 面 facet 必须由**带 UI 断言的用例**签发（via=ui/mixed）——接口通道证明不了界面渲染（callApi 打一万次 list 也照不出「Invalid date」）。补法：给该 facet 写 App-run 用例（\`assertVisual\`/\`assertDom\` 带值断言），或如实标 HUMAN_INHERENT 走独立风险审批，**不许用接口绿冒充界面绿**。` : '',
            failCases.length ? `⚠ 失败 case ${[...new Set(failCases)].join(', ')}——未置绿，看证据判是不是真 bug（是→开缺陷单）。` : '',
            lint.findings.filter(f => f.severity === 'warn').length ? `（另有 ${lint.findings.filter(f => f.severity === 'warn').length} 条 warn 级 lint 提示：非 content 类 facet 的存在性/翻库，已放行但建议看一眼）` : '',
            // C7 透明度：判据来源如实说。结构判定（failureClass）时告诉她「中文标题不再需要硬加 assert」；
            // 降级判定时明说「本轮 RED 未经结构判定」——别让她以为已经是结构判据了。
            redBasisSeen.has(zhuzhuCaps.RED_BASIS_STRUCTURAL)
              ? '✅ RED 校准走**结构判据**（summary 带 failureClass，只认 value-assertion）——中文步骤标题不再需要硬加 `assert`。'
              : (redBasisSeen.size ? '⚠ RED 校准本轮走的是**标题正则降级判定**（该 run 目录下没读到 `evidence-bundle.json` 的 `failureClass`——多半是猪猪版本偏旧或产物被裁剪，**不是** Z-D 未上线）：证据已标 `redBasis=title-regex`，晨检包会把这些 RED 记为「未经结构判定」。别据此认为「把动作失败包装成 assert 标题」这条后门已关。' : ''),
          ].filter(Boolean)
          return { content: [{ type: 'text', text: parts.join('\n') }] }
        },
      ),
      tool(
        'lint_test_file',
        '测试有效性 linter：揪 DB_FISHING / NO_ACTION / PRESENCE_ONLY，并校验 content case 的 qaTrace Arrange→Act→Assert 同实体血缘。lintAck 只记录申诉，绝不改变阻断级别。',
        { testFile: z.string().describe('用例文件绝对/仓库根相对路径，如 vision-e2e/test-workflows/v5.17/xxx.json'), file: z.string().optional().describe('任务档案相对路径（取 facet_doc 判 facet 分类），默认=本次派工档案') },
        async ({ testFile, file }) => {
          const resolveIn = p => { try { const a = path.isAbsolute(p) ? path.resolve(p) : path.resolve(ROOT, p); if (a !== ROOT && !a.startsWith(ROOT + path.sep)) return null; return a } catch { return null } }
          const tf = resolveIn(testFile)
          if (!tf || !fs.existsSync(tf)) return { content: [{ type: 'text', text: `[找不到 testFile：${testFile}]` }] }
          let testJson; try { testJson = JSON.parse(fs.readFileSync(tf, 'utf8')) } catch (e) { return { content: [{ type: 'text', text: `[testFile 不是合法 JSON：${String(e?.message || e)}]` }] } }
          let facetClass = {}, facetVia = {}
          try { const rel = file || run.taskFile; if (rel) { const abs = safeResolve(rel); const afm = parseFrontmatter(fs.readFileSync(abs, 'utf8')) || {}; const facets = loadFacetSet(afm).facets; facetClass = facetClassMap(facets); facetVia = facetViaMap(facets) } } catch { }
          const r = lintTestFile(testJson, { facetClass, facetVia })
          if (!r.total) return { content: [{ type: 'text', text: '[该文件没有 cases]' }] }
          const err = r.findings.filter(f => f.severity === 'error'), warn = r.findings.filter(f => f.severity === 'warn'), ack = r.findings.filter(f => f.acked)
          const fmt = f => `  · ${f.caseId} [${f.code}]${f.acked ? '（已 lintAck：' + f.ackReason + '）' : ''}：${f.msg}`
          const lines = [
            `有效性 lint：${r.total} case，${r.clean ? '✅ 无阻断项' : '⛔ ' + err.length + ' 条阻断'}${warn.length ? '，' + warn.length + ' 条 warn' : ''}${ack.length ? '，' + ack.length + ' 条带 lintAck（仍按原级别处理）' : ''}`,
            err.length ? '【阻断·必须修测试或走独立风险审批】\n' + err.map(fmt).join('\n') : '',
            warn.length ? '【warn·建议看一眼】\n' + warn.map(fmt).join('\n') : '',
            ack.length ? '【lintAck 申诉记录（不豁免）】\n' + ack.map(fmt).join('\n') : '',
          ].filter(Boolean)
          return { content: [{ type: 'text', text: lines.join('\n') }] }
        },
      ),
    ],
  })
}

// 每个企微用户一个常驻轻量会话：{ sessionId, _q, _input, _abort, busy, buf, pending, idleTimer, userid }
const personaSessions = new Map()

function personaOptions(userid, engine) {
  const abort = new AbortController()
  return {
    abort,
    options: {
      systemPrompt: buildPersonaPrompt(),                 // 纯字符串 → 轻量助手，无 claude_code coding 工具
      engine, model: engineConfigStore.get().providers[engine]?.model || undefined,
      readOnly: true,
      maxTurns: PERSONA_MAX_TURNS,
      abortController: abort,
      includePartialMessages: false,
      mcpServers: { 'feifei-caps': makePersonaCaps(userid), 'feifei-memory': makeFeifeiMemory() },
      // 只允许扩展能力 + 记忆（回忆）工具；不加 settingSources（不拉重型 CLAUDE.md）
      allowedTools: ['mcp__feifei-caps__knowledge_base_query', 'mcp__feifei-caps__stage_requirement_intake', 'mcp__feifei-caps__lark_list_requirements', 'mcp__feifei-caps__lark_get_requirement', 'mcp__feifei-caps__query_version_progress', 'mcp__feifei-caps__lark_update_requirement', 'mcp__feifei-caps__lark_delete_requirement', 'mcp__feifei-caps__lark_list_fields', 'mcp__feifei-caps__lark_manage_field',
        // 企微需求表（主表，2026-08-19 起）——与飞书那组同权，企微人格两个入口都能用
        'mcp__feifei-caps__wecom_list_requirements', 'mcp__feifei-caps__wecom_create_requirement', 'mcp__feifei-caps__wecom_update_requirement',
        'mcp__feifei-caps__wecom_delete_requirement', 'mcp__feifei-caps__wecom_list_fields', 'mcp__feifei-caps__wecom_manage_field',
        'mcp__feifei-memory__recall_conversations', 'mcp__feifei-memory__recall_staged_requirements'],
      permissionMode: 'bypassPermissions',                // 仅这两工具可用，bypass 不会放开别的（allowedTools 已白名单）
      // 兜底：即便有内置工具也一律 deny 写/执行/网络类，确保企微人格碰不到文件系统
      settings: { permissions: { deny: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'Read', 'Glob', 'Grep'] } },
      thinking: thinkingConfig(4000),                      // 同 startRun：env MAX_THINKING_TOKENS 已是空档位，硬顶只认这个 option
      env: { ...process.env },
    },
  }
}

// 消费一条人格 query 的流：捕获 session_id、检测工具调用、result 到达即 resolve 本轮 pending 的最终文本。
async function consumePersonaStream(sess, q) {
  try {
    for await (const msg of q) {
      sess.lastActivity = Date.now()
      if (msg.session_id) sess.sessionId = msg.session_id
      if (msg.type === 'assistant') {
        const blocks = msg.message?.content
        if (Array.isArray(blocks)) for (const b of blocks) {
          if (b?.type === 'tool_use') { sess.usedTools = sess.usedTools || []; sess.usedTools.push(b.name) }
        }
      }
      if (msg.type === 'result') {
        const text = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result ?? '')
        const isErr = msg.is_error !== undefined ? !!msg.is_error : (msg.subtype !== 'success')
        const p = sess.pending; sess.pending = null; sess.busy = false
        if (p) p.resolve({ reply: text, isError: isErr, usedTools: sess.usedTools || [] })
        sess.usedTools = []
        schedulePersonaIdleClose(sess)
      }
    }
    // 流自然结束（close）
    if (sess.pending) { const p = sess.pending; sess.pending = null; sess.busy = false; p.resolve({ reply: '', isError: true, usedTools: [] }) }
    sess._q = null; sess._input = null
  } catch (err) {
    console.warn('[persona] stream 异常:', err?.message || err)
    if (sess.pending) { const p = sess.pending; sess.pending = null; sess.busy = false; p.resolve({ reply: '', isError: true, error: String(err?.message || err), usedTools: [] }) }
    sess._q = null; sess._input = null
  }
}

function schedulePersonaIdleClose(sess) {
  clearTimeout(sess.idleTimer)
  sess.idleTimer = setTimeout(() => { try { sess._input?.close() } catch { } }, PERSONA_IDLE_CLOSE_MS)
}

// 主入口：给某企微用户的一条消息生成菲菲回复（常驻会话；忙则排队串行）。
// images: [{ media_type, data(base64) }]（企微图片/图文经 sidecar 下载解密后带过来）；有图则推多模态 content。
async function personaReply(userid, text, images) {
  const uid = String(userid || 'unknown')
  let sess = personaSessions.get(uid)
  if (!sess) { sess = { userid: uid, sessionId: null, _q: null, _input: null, _abort: null, busy: false, pending: null, idleTimer: null, lastActivity: Date.now(), queue: [] }; personaSessions.set(uid, sess) }

  // 同一用户串行：忙则排队，等上一条 resolve 后再跑
  if (sess.busy) { await new Promise(r => sess.queue.push(r)) }
  sess.busy = true
  clearTimeout(sess.idleTimer)

  const result = await new Promise((resolve) => {
    sess.pending = { resolve }
    // 有图 → content 数组（文字 + image block）；纯文字 → 直接字符串。Claude 多模态读图。
    const imgs = Array.isArray(images) ? images.filter(im => im && im.data) : []
    const msg = imgs.length
      ? [{ type: 'text', text: text || '（见图）' }, ...imgs.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data } }))]
      : text
    if (sess._q && sess._input) {
      // 常驻会话仍活 → 直接推下一轮（缓存热）
      sess._input.push(msg)
    } else {
      // 新起 / resume 冷起
      sess.engine ||= sess.sessionId ? 'claude' : newRunEngine({ employee: 'feifei' })
      const { abort, options } = personaOptions(uid, sess.engine)
      if (sess.sessionId) options.resume = sess.sessionId
      const input = makeInputChannel()
      sess._input = input; sess._abort = abort
      const q = query({ prompt: input.gen(), options })
      sess._q = q
      consumePersonaStream(sess, q)
      input.push(msg)
    }
  })

  // 放行队列里的下一条
  const next = sess.queue.shift()
  if (next) next()
  return result
}

// 关停所有人格会话（随 server 优雅退出）
function stopAllPersonaSessions() {
  for (const sess of personaSessions.values()) {
    try { sess._abort?.abort() } catch { }
    try { sess._input?.close() } catch { }
    clearTimeout(sess.idleTimer)
  }
}

// ================= 飞书多维表格（示例项目需求分诊看板）=================
// 老板把示例项目需求记在一张飞书多维表（人工分诊看板：待处理→处理中→已完成）。
// 用途分两层：① 企微主人格 intake → 在表里新建「待处理」行（本文件的轻量客户端直连，固定操作）；
// ② 看板 PM 菲菲 → 挂 Lark MCP（preset.base.default）做读/整理/状态回写（读静默、写审批）。
// 凭证走 env（LARK_APP_ID/SECRET，不进 git）；base/table/字段映射走 runs/lark-config.json（可后配）。
const LARK_CONFIG_FILE = path.join(RUNS_DIR, 'lark-config.json')
let larkConfig = {
  appId: '',                                 // 飞书自建应用 app_id（可 env LARK_APP_ID 覆盖）
  appSecret: '',                             // app_secret（敏感，GET 脱敏；可 env LARK_APP_SECRET 覆盖）
  appToken: '',   // base（多维表 app_token，来自表 URL）
  tableId: '',               // table_id（来自表 URL）
  // 字段映射（默认对齐「示例项目」需求池表；值 = 你表里的字段名，留空的字段建行时跳过）。
  // 凭证到位后可用 /api/lark/fields introspect 再校准。
  // 字段映射：默认全留空 = **自动识别**（系统 list fields 后按名称/类型匹配，见 larkAutoDetectMap）。
  // 只有自动识别不准时，才在设置卡片里手动覆盖对应字段（非空即覆盖）。
  fields: { summary: '', detail: '', status: '', proposer: '', proposeTime: '' },
  statusPending: '待处理',                   // 新建 intake 行的状态值
  autoSync: false,                           // 引擎按任务档案自动对齐表里状态/归属版本/上线日期（见 syncLarkFromArchives）；false=只对账报告不写
}
try { larkConfig = { ...larkConfig, ...JSON.parse(fs.readFileSync(LARK_CONFIG_FILE, 'utf8')) } } catch { }
const saveLarkConfig = () => fs.writeFileSync(LARK_CONFIG_FILE, JSON.stringify(larkConfig, null, 2))

// 凭证解析：env 优先，其次配置文件（可视化设置卡片写入 runs/lark-config.json，已 gitignore）
const larkAppId = () => process.env.LARK_APP_ID || larkConfig.appId || ''
const larkAppSecret = () => process.env.LARK_APP_SECRET || larkConfig.appSecret || ''
const larkCredsReady = () => !!(larkAppId() && larkAppSecret())
const larkConfigured = () => !!(larkCredsReady() && larkConfig.appToken && larkConfig.tableId)
const LARK_BASE = 'https://open.feishu.cn/open-apis'
let _larkToken = { value: '', exp: 0 }

// tenant_access_token（自建应用，无人值守）：缓存到过期前 60s
async function larkTenantToken() {
  const now = Date.now()
  if (_larkToken.value && now < _larkToken.exp) return _larkToken.value
  const resp = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: larkAppId(), app_secret: larkAppSecret() }),
    signal: AbortSignal.timeout(10000),
  })
  const data = await resp.json()
  if (data.code !== 0) throw new Error(`拿 tenant_access_token 失败: code=${data.code} ${data.msg || ''}`)
  _larkToken = { value: data.tenant_access_token, exp: now + Math.max(60, (data.expire || 7200) - 60) * 1000 }
  return _larkToken.value
}

// 新建一条多维表记录（fields = { 字段名: 值 }）。返回 record_id。
async function larkCreateRecord(fields) {
  const token = await larkTenantToken()
  const url = `${LARK_BASE}/bitable/v1/apps/${larkConfig.appToken}/tables/${larkConfig.tableId}/records`
  console.log('[lark] create record input:', JSON.stringify({ fields }))
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }), signal: AbortSignal.timeout(15000),
  })
  const data = await resp.json()
  console.log('[lark] create record output:', JSON.stringify(data).slice(0, 400))
  if (data.code !== 0) throw new Error(`建记录失败: code=${data.code} ${data.msg || ''}`)
  return data.data?.record?.record_id || ''
}

// 列字段（introspect：凭证到位后核对表真实字段名，据以校准 larkConfig.fields）
async function larkListFields() {
  const token = await larkTenantToken()
  const url = `${LARK_BASE}/bitable/v1/apps/${larkConfig.appToken}/tables/${larkConfig.tableId}/fields`
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) })
  const data = await resp.json()
  if (data.code !== 0) throw new Error(`列字段失败: code=${data.code} ${data.msg || ''}`)
  return (data.data?.items || []).map(f => ({ field_id: f.field_id, name: f.field_name, type: f.type, options: (f.property?.options || []).map(o => o.name) }))
}

// 删记录（不可逆）
async function larkDeleteRecord(recordId) {
  const token = await larkTenantToken()
  const url = `${LARK_BASE}/bitable/v1/apps/${larkConfig.appToken}/tables/${larkConfig.tableId}/records/${recordId}`
  console.log('[lark] delete record:', recordId)
  const resp = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
  const data = await resp.json()
  if (data.code !== 0) throw new Error(`删记录失败: code=${data.code} ${data.msg || ''}`)
  return true
}

// 字段增/改/删（field: { field_name, type, property? }；type 见飞书：1文本 2数字 3单选 4多选 5日期 11人员…）
async function larkCreateField(field) {
  const token = await larkTenantToken()
  const url = `${LARK_BASE}/bitable/v1/apps/${larkConfig.appToken}/tables/${larkConfig.tableId}/fields`
  console.log('[lark] create field:', JSON.stringify(field))
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(field), signal: AbortSignal.timeout(15000) })
  const data = await resp.json()
  if (data.code !== 0) throw new Error(`加字段失败: code=${data.code} ${data.msg || ''}`)
  return data.data?.field?.field_id || ''
}
async function larkUpdateField(fieldId, field) {
  const token = await larkTenantToken()
  const url = `${LARK_BASE}/bitable/v1/apps/${larkConfig.appToken}/tables/${larkConfig.tableId}/fields/${fieldId}`
  console.log('[lark] update field:', fieldId, JSON.stringify(field))
  const resp = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(field), signal: AbortSignal.timeout(15000) })
  const data = await resp.json()
  if (data.code !== 0) throw new Error(`改字段失败: code=${data.code} ${data.msg || ''}`)
  return true
}
async function larkDeleteField(fieldId) {
  const token = await larkTenantToken()
  const url = `${LARK_BASE}/bitable/v1/apps/${larkConfig.appToken}/tables/${larkConfig.tableId}/fields/${fieldId}`
  console.log('[lark] delete field:', fieldId)
  const resp = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
  const data = await resp.json()
  if (data.code !== 0) throw new Error(`删字段失败: code=${data.code} ${data.msg || ''}`)
  return true
}

// 列记录（直连读，供菲菲读需求表）。自动翻页拉全表：page_token + has_more 循环，
// pageSize = 期望的总条数上限（默认 500）。飞书 list records 单页上限 500，超出靠翻页累加。
// 曾经只拉一页不翻页 → 表超过单页上限时静默丢记录、无报错（根因见复盘 §单页截断）。
async function larkListRecords(pageSize = 500) {
  const token = await larkTenantToken()
  const cap = Math.max(1, pageSize)                       // 期望的总条数上限
  const out = []
  let pageToken = ''
  do {
    const ps = Math.min(500, cap - out.length)            // 飞书单页上限 500
    const url = `${LARK_BASE}/bitable/v1/apps/${larkConfig.appToken}/tables/${larkConfig.tableId}/records?page_size=${ps}`
      + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '')
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
    const data = await resp.json()
    if (data.code !== 0) throw new Error(`列记录失败: code=${data.code} ${data.msg || ''}`)
    out.push(...(data.data?.items || []).map(r => ({ record_id: r.record_id, fields: r.fields || {} })))
    pageToken = data.data?.page_token || ''
    if (!data.data?.has_more) break
  } while (out.length < cap)
  return out.slice(0, cap)
}

// 更新一条记录的字段（直连写，供菲菲改状态/回填版本等；不含删除）。
async function larkUpdateRecord(recordId, fields) {
  const token = await larkTenantToken()
  const url = `${LARK_BASE}/bitable/v1/apps/${larkConfig.appToken}/tables/${larkConfig.tableId}/records/${recordId}`
  console.log('[lark] update record input:', JSON.stringify({ recordId, fields }))
  const resp = await fetch(url, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }), signal: AbortSignal.timeout(15000),
  })
  const data = await resp.json()
  console.log('[lark] update record output:', JSON.stringify(data).slice(0, 300))
  if (data.code !== 0) throw new Error(`改记录失败: code=${data.code} ${data.msg || ''}`)
  return true
}

// 把一个飞书 bitable 单元格值拍平成字符串（数组/对象取 text|name；供展示与企微镜像共用）。
function larkCellText(v) {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map(x => (x && (x.text || x.name)) || (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')
  if (typeof v === 'object') return v.text || v.name || JSON.stringify(v)
  return String(v)
}
// 把一条 bitable 记录的 fields 压成可读文本（供菲菲看）。
// ⚠ 2026-08-21 修：原实现对**每个字段**一刀 `slice(0, 60)`，而需求正文（需求点/详情/备注）普遍 100~400 字，
//   于是菲菲整轮 triage 读的都是断在句中的碎片（实证 run `20260821034335-b864a2`：REQ-0002/0004/0005/0086
//   全部断句），却据此判「大需求/口径待确认/主观模糊」——**输入太薄导致的误判，不是她不肯读全**。且截断是
//   **静默**的：她连"这条被截了"都不知道，会话里试着重查也拿不到更多（keyword 只过滤、输出仍走同一格式化）。
//   现在：正文类字段给足额度、截断处显式写出剩余字数与取全文的工具名；`full` 模式完全不截。
const LARK_BODY_FIELDS = ['需求点', '需求描述', '需求背景', '详情', '备注', '说明', '验收']
const LARK_ATTACH_FIELDS = ['图片', '附件', '图示']
function larkFmtRecord(rec, { full = false, bodyMax = 800, otherMax = 80 } = {}) {
  const f = rec.fields || {}
  const parts = []
  for (const [k, v] of Object.entries(f)) {
    const text = larkCellText(v).trim()
    if (!text) continue                                   // 空字段不占篇幅（原实现会输出一串 `字段:`）
    // 图片/附件字段只有文件名，引擎当前读不到图内容——显式标注，免得她把「image3.png」当成已知信息
    if (LARK_ATTACH_FIELDS.some(n => k.includes(n)) && /\.(png|jpe?g|gif|webp|pdf)/i.test(text)) {
      parts.push(`${k}:${text}（附件·引擎读不到图内容，涉及界面细节要问老板）`)
      continue
    }
    if (full) { parts.push(`${k}:${text}`); continue }
    const cap = LARK_BODY_FIELDS.some(n => k.includes(n)) ? bodyMax : otherMax
    parts.push(text.length > cap
      ? `${k}:${text.slice(0, cap)}…[本字段还有 ${text.length - cap} 字未显示，用 lark_get_requirement 读全文]`
      : `${k}:${text}`)
  }
  return `[${rec.record_id}] ` + parts.join(' | ')
}
// 单条需求全文（多行、零截断）——判「这条到底要什么/口径清不清」必须读这个，别拿列表摘要下结论
function larkFmtRecordFull(rec) {
  const f = rec.fields || {}
  const lines = [`record_id: ${rec.record_id}`]
  for (const [k, v] of Object.entries(f)) {
    const text = larkCellText(v).trim()
    if (!text) continue
    const attach = LARK_ATTACH_FIELDS.some(n => k.includes(n)) && /\.(png|jpe?g|gif|webp|pdf)/i.test(text)
    lines.push(`\n### ${k}\n${text}${attach ? '\n（附件·引擎当前读不到图内容——若这条需求的关键信息在图里，按 park 处理、别猜）' : ''}`)
  }
  return lines.join('\n')
}

// 自动识别字段映射：list fields 后按「字段名包含关键字」优先、再按字段类型兜底匹配。缓存 10min。
// 飞书字段类型：1=文本 3=单选 5=日期 11=人员。你这张表命名规范（需求点/状态/提出人/提出时间），名称匹配即命中。
let _larkMapCache = { at: 0, map: null }
function _larkMatch(fields, names, types) {
  for (const n of names) { const f = fields.find(x => x.name && x.name.includes(n)); if (f) return f }
  if (types) { const f = fields.find(x => types.includes(x.type)); if (f) return f }
  return null
}
async function larkAutoDetectMap() {
  const now = Date.now()
  if (_larkMapCache.map && now - _larkMapCache.at < 600000) return _larkMapCache.map
  const fields = await larkListFields()
  const summary = _larkMatch(fields, ['需求点', '需求描述', '需求'], [1])
  const status = _larkMatch(fields, ['状态'], [3])
  const proposer = _larkMatch(fields, ['提出人', '提出', '负责人'], [11])
  const timeF = _larkMatch(fields, ['提出时间', '时间', '日期'], [5])
  let statusPending = '待处理'
  if (status && Array.isArray(status.options) && status.options.length) {
    statusPending = status.options.find(o => o.includes('待处理')) || status.options.find(o => o.includes('待')) || statusPending
  }
  const map = { summary: summary?.name || '', status: status?.name || '', proposer: proposer?.name || '', proposeTime: timeF?.name || '', detail: '', statusPending }
  _larkMapCache = { at: now, map }
  return map
}
// 生效映射 = 手动覆盖（larkConfig.fields 非空项）盖在自动识别之上
async function larkResolveFieldMap() {
  let auto = null; try { auto = await larkAutoDetectMap() } catch (e) { console.warn('[lark] 自动识别字段失败:', e?.message || e) }
  const m = larkConfig.fields || {}
  const pick = k => (m[k] && String(m[k]).trim()) ? String(m[k]).trim() : (auto ? auto[k] : '')
  const sp = (larkConfig.statusPending && String(larkConfig.statusPending).trim()) ? String(larkConfig.statusPending).trim() : (auto?.statusPending || '待处理')
  return { summary: pick('summary'), status: pick('status'), proposer: pick('proposer'), proposeTime: pick('proposeTime'), detail: pick('detail'), statusPending: sp }
}

// 把一条 intake 需求登记到飞书「待处理」行：映射优先用自动识别（可被手动覆盖）。
async function larkStageIntake({ summary, detail, proposer }) {
  const fm = await larkResolveFieldMap()
  const fields = {}
  if (fm.summary) fields[fm.summary] = summary || ''
  if (fm.detail && detail) fields[fm.detail] = detail
  if (fm.status) fields[fm.status] = fm.statusPending
  if (fm.proposer && proposer) fields[fm.proposer] = proposer
  if (fm.proposeTime) { const d = new Date(); fields[fm.proposeTime] = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}` }
  return larkCreateRecord(fields)
}

// ================= 企微智能表格（需求表主表，经官方 wecom-cli）=================
// 2026-08-19 起主表从飞书反转到企微：菲菲直接读写企微那张智能表格，飞书退为「保留能力 + 设置里手动同步」。
// 通道 = 官方 `@wecom/cli`（npm i -g @wecom/cli，Rust 二进制 + npm 分发，MIT）。
//
// 为什么破例引入外部二进制（与 §3.20「能力工具优先 in-process」的张力）：§3.20 真正的炸弹是 **npx**
// ——每次调用现拉、离线/慢网必挂。wecom-cli 是一次 `npm i -g` 装好的本地二进制，调用零网络前置；
// 且企微文档能力**没有**可直连的等价 REST 路径（自建应用那套已在 §3.43 试过并整体回退）。
// 缺失/未授权时整块能力优雅不可用、不崩任何员工（对齐 sidecar「缺依赖不崩」取向）。
//
// ⚠ 平台硬约束（企业模式，>10 人；官方确认见 wecom-cli issue #64/#73，#73 至今 open）：
//   机器人是**独立身份**、不继承授权人的既有文档权限 → 只能读写**机器人自己创建的**文档，
//   碰成员手动建的表一律 851003 no authority（读也不行）。故需求表必须由机器人 `smartsheet create` 新建。
//   且机器人建的智能表格**永久删不掉**（官方 common.md 明写不支持删除文件）。
const WECOM_DOC_CONFIG_FILE = path.join(RUNS_DIR, 'wecom-doc-config.json')
let wecomDocConfig = {
  enabled: false,
  // ★「启用」≠「当主表」，刻意拆成两个开关（2026-08-21 降级后加的）。
  // 起因：企微机器人的能力是**按项分授权**的，本企业目前只批到「创建/编辑文档」，
  // 「搜索与获取文档内容」要向领导申请、暂未批 → **写得进、读不出**。
  // 读不出就当不了主表（菲菲答不了「表里有哪些」、迁移也无法校验），故主表仍是飞书。
  // 只有 isPrimary 为真才会让旧镜像自动退场；仅 enabled 为真时企微只是个可选写入通道。
  isPrimary: false,
  docid: '',            // 智能表格文件 ID（s3_ 前缀），来自 smartsheet create 返回或表 URL
  sheetTitle: '需求池',  // 子表名（CLI 用 sheet_title 寻址，不用 sheet_id）
  docUrl: '',           // 表的访问链接（给 UI 展示用）
  cliBin: '',           // 可选：覆盖 wecom-cli 入口 js 路径（留空=自动解析）
  cliConfigDir: '',     // 可选：覆盖 WECOM_CLI_CONFIG_DIR（凭证目录；留空=CLI 默认 ~/.config/wecom）
  lastAuthStatus: '',   // authorized / unauthorized / ''（未探测）
  lastCheckAt: '',
  lastError: '',
  // ---- 851003 写兜底（可选）----
  // 企业模式下若 CLI 写入被拒，改走这张表自己的「接收外部数据」Webhook（表级口子，与机器人身份无关）。
  // 与旧镜像那套（wecom-mirror-config，指向**旧表**、按 role 键）彻底分开：这里按**字段名 → FIELD_ID**，
  // 值取自新表「接收外部数据」页面的示例 JSON。留空 = 不启用兜底（CLI 失败就如实报错，不假装成功）。
  webhookUrl: '',
  webhookFields: {},    // { '需求点': 'field_example_one', '状态': 'field_example_two', ... }
}
try { wecomDocConfig = { ...wecomDocConfig, ...JSON.parse(fs.readFileSync(WECOM_DOC_CONFIG_FILE, 'utf8')) } } catch { }
const saveWecomDocConfig = () => atomicWrite(WECOM_DOC_CONFIG_FILE, JSON.stringify(wecomDocConfig, null, 2))
const wecomDocConfigured = () => !!(wecomDocConfig.enabled && wecomDocConfig.docid && wecomDocConfig.sheetTitle)
// 对外配置：无敏感字段（凭证在 CLI 自己的 credentials.enc 里，引擎从不经手），额外回 CLI 是否装好供 UI 提示。
const wecomDocPublicConfig = () => ({
  enabled: !!wecomDocConfig.enabled,
  isPrimary: !!wecomDocConfig.isPrimary,
  degraded: wecomDegraded(),
  docid: wecomDocConfig.docid || '',
  sheetTitle: wecomDocConfig.sheetTitle || '需求池',
  docUrl: wecomDocConfig.docUrl || '',
  cliBin: wecomDocConfig.cliBin || '',
  cliConfigDir: wecomDocConfig.cliConfigDir || '',
  cliInstalled: !!wecomCliEntry(),
  lastAuthStatus: wecomDocConfig.lastAuthStatus || '',
  lastCheckAt: wecomDocConfig.lastCheckAt || '',
  lastError: wecomDocConfig.lastError || '',
  configured: wecomDocConfigured(),
  // Webhook URL 含 key（写入密钥）→ 只回布尔，不回明文（对齐 botSecret/webhookUrl 的脱敏惯例）
  webhookUrlSet: !!wecomDocConfig.webhookUrl,
  webhookFields: wecomDocConfig.webhookFields || {},
  fallbackReady: wecomFallbackReady(),
})

// 851003 / no authority = 文档对象权限不足（企业模式下机器人碰不到非自己创建的文档）。
// 单独成类，供上层识别并切 webhook 兜底（webhook 是表自身开的口子，与机器人身份无关，故不受此限）。
class WecomNoAuthError extends Error {
  constructor(msg) { super(msg); this.name = 'WecomNoAuthError'; this.noAuth = true }
}

// 解析 wecom-cli 入口。⚠ Windows 关键：**不要** execFile 那个 `.cmd` shim（需要 shell、引号地狱、多一层注入面），
// 直接用当前 node 跑它的 bin/wecom.js。顺序：配置覆盖 → env → npm 全局 root。解析不到返回 ''（调用方给可读文案）。
let _wecomCliEntry = { at: 0, path: '' }
function wecomCliEntry() {
  const explicit = wecomDocConfig.cliBin || process.env.WECOM_CLI_BIN || ''
  if (explicit) return fs.existsSync(explicit) ? explicit : ''
  const now = Date.now()
  if (_wecomCliEntry.path && now - _wecomCliEntry.at < 600000) return _wecomCliEntry.path
  const roots = [
    process.env.npm_config_prefix && path.join(process.env.npm_config_prefix, 'node_modules'),
    process.platform === 'win32' && process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    process.env.HOME && path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules'),
  ].filter(Boolean)
  for (const r of roots) {
    const p = path.join(r, '@wecom', 'cli', 'bin', 'wecom.js')
    if (fs.existsSync(p)) { _wecomCliEntry = { at: now, path: p }; return p }
  }
  return ''
}

// 统一出入口：execFile（shell:false，参数走数组、JSON 体作为单个 argv 元素，杜绝拼串与注入）。
// 超时默认 30s —— **显著小于**企微人格那条 HTTP 的 180s（§3.20 教训：下游超时必须远小于上游，
// 慢依赖要快速失败+降级，否则一慢就把整轮拖炸）。出入参全量日志（对齐第三方调用日志规范；
// §3.50 教训：日志里的真实请求体是判断「跑的是哪版代码/发的什么方言」最快的证据）。
function wecomCliExec(argv, { timeout = 30000 } = {}) {
  const entry = wecomCliEntry()
  if (!entry) return Promise.reject(new Error('wecom-cli 未安装（npm install -g @wecom/cli），企微表能力不可用'))
  const env = { ...process.env }
  if (wecomDocConfig.cliConfigDir) env.WECOM_CLI_CONFIG_DIR = wecomDocConfig.cliConfigDir
  console.log('[wecom-cli] input:', JSON.stringify(argv).slice(0, 600))
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [entry, ...argv], {
      timeout, env, shell: false, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim()
      const errOut = String(stderr || '').trim()
      console.log('[wecom-cli] output:', (out || errOut).slice(0, 600))
      // CLI 失败时错误 JSON 可能落在 stdout 或 stderr，两边都试着解析出 errcode/message。
      let parsed = null
      for (const raw of [out, errOut]) {
        if (!raw) continue
        try { parsed = JSON.parse(raw); break } catch { }
      }
      const emsg = parsed?.error?.message || parsed?.errmsg || ''
      const ecode = parsed?.error?.code ?? parsed?.errcode
      if (ecode === 851003 || /no authority/i.test(emsg) || /no authority/i.test(errOut)) {
        return reject(new WecomNoAuthError(`851003 no authority：机器人对该表没有对象权限（企业模式下只能访问自己创建的文档）`))
      }
      if (err) {
        if (err.killed || err.signal) return reject(new Error(`wecom-cli 超时（${timeout}ms）`))
        return reject(new Error(emsg || errOut.slice(0, 300) || err.message))
      }
      if (!parsed) return reject(new Error(`wecom-cli 输出不是 JSON：${out.slice(0, 200)}`))
      if (parsed.errcode && parsed.errcode !== 0) return reject(new Error(`errcode=${parsed.errcode} ${parsed.errmsg || ''}`))
      resolve(parsed)
    })
  })
}
// --json 形态的调用统一走这里（docid 必须在 JSON 内部，不能作为顶层 shell 参数——CLI 明确要求）
const wecomCliJson = (service, method, body, opts) =>
  wecomCliExec([service, ...method.split(' '), '--json', JSON.stringify(body)], opts)

// 授权状态：authorized / unauthorized。CLI 缺失时返回 'missing'（UI 据此提示先装）。
async function wecomAuthStatus() {
  if (!wecomCliEntry()) return 'missing'
  try {
    const entry = wecomCliEntry()
    const env = { ...process.env }
    if (wecomDocConfig.cliConfigDir) env.WECOM_CLI_CONFIG_DIR = wecomDocConfig.cliConfigDir
    return await new Promise(resolve => {
      execFile(process.execPath, [entry, 'auth', 'show', '--status'], { timeout: 15000, env, shell: false, encoding: 'utf8', windowsHide: true }, (err, stdout) => {
        const s = String(stdout || '').trim().split(/\s+/).pop() || ''
        resolve(s === 'authorized' ? 'authorized' : 'unauthorized')
      })
    })
  } catch { return 'unauthorized' }
}

// ---- 智能表格薄封装（读走 SQL 服务端过滤；写按 ≤100 行分批）----
const wecomSheetsList = () => wecomCliJson('smartsheet', 'sheets list', { docid: wecomDocConfig.docid })
const wecomFieldsList = () => wecomCliJson('smartsheet', 'fields list', { docid: wecomDocConfig.docid, sheet_title: wecomDocConfig.sheetTitle, limit: 100 })

// SQL 只读查询。⚠ 必须在 SQL 里 WHERE/LIMIT 收口，**不许拉全量再本地筛**
// （性能规范「禁止先全量 load 再内存过滤」+ §3.59 分页静默截断教训）。
// `records query` 是唯一把 docid 放顶层 --docid 的接口（其余都在 --json 里），CLI 明确规定。
async function wecomRecordsQuery(sql, opts) {
  const data = await wecomCliExec(['smartsheet', 'records', 'query', '--docid', wecomDocConfig.docid, '--sql', sql], opts)
  // 返回体：{ errcode, values: string[] }，每个 values[i] 解析后取 rows
  const rows = []
  for (const v of data?.values || []) {
    try { rows.push(...(JSON.parse(v)?.rows || [])) } catch { }
  }
  return rows
}

const _wcChunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out }

// 写：批量优先（§3.48 教训——逐条发既慢又易撞频率限制，批量是官方首选），每批 ≤100 行。
// 注意 CLI 对 records update 要求「单次更新一次完成、严禁拆请求」，故只在超批量上限时才分批。
async function wecomRecordsAdd(records) {
  const ids = []
  for (const batch of _wcChunk(records, 100)) {
    const d = await wecomCliJson('smartsheet', 'records add', { docid: wecomDocConfig.docid, sheet_title: wecomDocConfig.sheetTitle, records: batch }, { timeout: 60000 })
    for (const r of d?.records || []) ids.push(r.record_id)
  }
  return ids
}
async function wecomRecordsUpdate(records) {
  for (const batch of _wcChunk(records, 100)) {
    await wecomCliJson('smartsheet', 'records update', { docid: wecomDocConfig.docid, sheet_title: wecomDocConfig.sheetTitle, records: batch }, { timeout: 60000 })
  }
}
async function wecomRecordsDelete(recordIds) {
  for (const batch of _wcChunk(recordIds, 100)) {
    await wecomCliJson('smartsheet', 'records delete', { docid: wecomDocConfig.docid, sheet_title: wecomDocConfig.sheetTitle, records: batch.map(id => ({ record_id: id })) }, { timeout: 60000 })
  }
}

// 错误文案归一：851003/851008 都极容易让人瞎猜（851003 曾在 §3.43 被误当成"配错了"），单独点名根因。
const wecomErrText = e => {
  const s = String(e?.message || e)
  if (e?.noAuth) return '851003 no authority（这张表不是机器人创建的，企业模式下它没有对象权限）'
  if (/851008/.test(s)) return '851008 partial no authorization（机器人未获「搜索与获取文档内容」授权，读不了——需管理员/领导审批开通）'
  return s
}

// 降级闸（2026-08-21）：企微表只批到写、没批到读，故**不作为主表**。
// 未设 isPrimary 时，wecom_* 工具一律不实际操作，只回一句说清现状——
// 否则菲菲会往一张自己读不出来的表里写需求，把台账劈成「飞书能查的」+「企微查不了的」两半，
// 比不写更糟。等读权限批下来，把 isPrimary 置真即全部生效，代码无需再改。
const WECOM_DEGRADED_MSG = '[企微需求表当前是**降级**状态：机器人只获批了「创建/编辑文档」，没获批「搜索与获取文档内容」，所以写得进但读不出，因此没有作为主表启用。**请以飞书需求表为准**（用 lark_* 那组工具）。若老板问起，如实说明是在等读取权限的审批。]'
const wecomDegraded = () => !(wecomDocConfigured() && wecomDocConfig.isPrimary)

// ---- 851003 写兜底：改走本表的「接收外部数据」Webhook ----
// ⚠ 未经真机验证的路径（要 CLI 真被拒才会走到）。方言按官方 webhook 文档：顶层 add_records/update_records、
// 键用 **FIELD_ID**、不带 key_type；文本列裸串、单选列 [{text}]——恰好与我们给 CLI 构造的 values 同形，故可直接复用，
// 只需把 key 从字段名换成 FIELD_ID（方言坑的血泪见 §3.50：键名/键形态/值形态/有无 key_type 四格必须一次对齐）。
const wecomFallbackReady = () => !!(wecomDocConfig.webhookUrl && Object.keys(wecomDocConfig.webhookFields || {}).length)
function wecomFallbackValues(values) {
  const map = wecomDocConfig.webhookFields || {}
  const out = {}
  for (const [name, v] of Object.entries(values)) { const id = map[name]; if (id) out[id] = v }
  return out
}
async function wecomFallbackPost(body) {
  console.log('[wecom-fallback] webhook input:', JSON.stringify(body).slice(0, 400))
  const resp = await fetch(wecomDocConfig.webhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  })
  const data = await resp.json()
  console.log('[wecom-fallback] webhook output:', JSON.stringify(data).slice(0, 400))
  if (data.errcode !== 0) throw new Error(`webhook errcode=${data.errcode} ${data.errmsg || ''}`)
  return data
}
async function wecomWebhookFallbackAdd(values) {
  if (!wecomFallbackReady()) return { ok: false, error: '未配置 Webhook 兜底（设置里填 Webhook 地址 + 字段 ID 映射）' }
  try { await wecomFallbackPost({ add_records: [{ values: wecomFallbackValues(values) }] }); return { ok: true } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
}
async function wecomWebhookFallbackUpdate(recordId, values) {
  if (!wecomFallbackReady()) return { ok: false, error: '未配置 Webhook 兜底（设置里填 Webhook 地址 + 字段 ID 映射）' }
  try { await wecomFallbackPost({ update_records: [{ record_id: recordId, values: wecomFallbackValues(values) }] }); return { ok: true } }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
}

// ================= 企微镜像（飞书主表 → 企微 Webhook 智能表格，单向只读投影）=================
// 设计（用户拍板）：飞书是唯一权威主表（菲菲照旧读写）；企微那张智能表格只是给企微同事看的**只读镜像**，
// 引擎单向把飞书内容推过去。走企微「接收外部数据」Webhook（.../smartsheet/webhook?key=KEY）——不用自建应用、
// 不用可信 IP、手动建的表也能用。Webhook 只能写（新增 records / 更新 update_records），删不了行：飞书删的行在企微标「作废」。
// 全推**文本**（企微镜像表建同名文本列即可），避开单选/日期/人员与 Webhook 字段类型限制，写入永远成功。
const WECOM_MIRROR_CONFIG_FILE = path.join(RUNS_DIR, 'wecom-mirror-config.json')
const WECOM_MIRROR_MAP_FILE = path.join(RUNS_DIR, 'wecom-mirror-map.json')   // { 飞书 record_id: 企微 record_id }
let wecomMirrorConfig = {
  enabled: false,
  webhookUrl: '',        // 企微工作表 Webhook 地址（含 ?key=…；敏感，GET 脱敏、runs/ 已 gitignore）
  syncMin: 3,            // 定时全量同步周期（分钟，min 1）
  lastSyncAt: '',
  lastError: '',
  // 企微镜像表字段：role → { id: 企微 FIELD_ID, title: 列标题 }。见 §3.50：webhook「接收外部数据」按 **FIELD_ID**
  // 写入（不认字段标题、也不吃 key_type），请求体须照抄工作表「示例数据」的结构（schema + 纯文本值）。默认取自老板那张表的
  // 示例数据；**换表/重建表后 FIELD_ID 会变**，改这里或手改 runs/wecom-mirror-config.json 即可（无需改代码）。
  fields: {},
}
try { wecomMirrorConfig = { ...wecomMirrorConfig, ...JSON.parse(fs.readFileSync(WECOM_MIRROR_CONFIG_FILE, 'utf8')) } } catch { }
const saveWecomMirrorConfig = () => fs.writeFileSync(WECOM_MIRROR_CONFIG_FILE, JSON.stringify(wecomMirrorConfig, null, 2))
const wecomMirrorPublicConfig = () => ({
  enabled: !!wecomMirrorConfig.enabled,
  syncMin: wecomMirrorConfig.syncMin || 3,
  lastSyncAt: wecomMirrorConfig.lastSyncAt || '',
  lastError: wecomMirrorConfig.lastError || '',
  webhookUrlSet: !!wecomMirrorConfig.webhookUrl,
  larkReady: larkConfigured(),
})
const wecomMirrorConfigured = () => !!(wecomMirrorConfig.enabled && wecomMirrorConfig.webhookUrl && larkConfigured())

function loadMirrorMap() { try { return JSON.parse(fs.readFileSync(WECOM_MIRROR_MAP_FILE, 'utf8')) } catch { return {} } }
function saveMirrorMap(m) { atomicWrite(WECOM_MIRROR_MAP_FILE, JSON.stringify(m, null, 2)) }

// Webhook 写：批量 add（add_records[]）/ update（update_records[]）。请求体 = { schema, add_records/update_records }，
// values 按企微 FIELD_ID 键、纯文本值（见 wecomMirrorValues/Schema，方言坑见 §3.50）。
// ⚠ 企微 webhook 卡的是「调用次数/分钟」而非记录数（记录数上限 3000/表·分钟）——逐行单发会瞬间打爆、
// 整批返回 45009「Too many requests」全被拒（2026-08-03 踩过：30+ 行全 45009、map 空、还误报 ok）。
// 对策：合并成少量批量请求（一次请求写多行）+ 批次间限速 + 对 45009 指数退避重试。
const _mirrorSleep = ms => new Promise(r => setTimeout(r, ms))
const _mirrorChunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out }
async function wecomWebhookPost(body, { retries = 4 } = {}) {
  let wait = 1500
  for (let attempt = 0; ; attempt++) {
    console.log('[wecom-mirror] webhook input:', JSON.stringify(body).slice(0, 300))
    const resp = await fetch(wecomMirrorConfig.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
    const data = await resp.json()
    console.log('[wecom-mirror] webhook output:', JSON.stringify(data).slice(0, 300))
    if (data.errcode === 0) return data
    // 45009 = 调用频率受限（也可能是当天配额用尽）：退避后重试；退避耗尽仍失败则抛给上层记 lastError。
    if (data.errcode === 45009 && attempt < retries) {
      console.warn(`[wecom-mirror] 45009 频率受限，第 ${attempt + 1} 次退避 ${wait}ms 后重试`)
      await _mirrorSleep(wait); wait = Math.min(wait * 2, 20000); continue
    }
    throw new Error(`webhook errcode=${data.errcode} ${data.errmsg || ''}`)
  }
}
// values = { FIELD_ID: 纯文本 }（企微 webhook「接收外部数据」示例格式）。roleTextMap 按 role 键（summary/status/…），
// 经 wecomMirrorConfig.fields 映射成企微 FIELD_ID。⚠ 键必须是 FIELD_ID 而非字段标题、值是纯字符串而非 [{type,text}]、
// 且**不带 key_type**——那套（标题键 + key_type + 类型数组）是 access_token 服务端 API 的方言，喂给 webhook 一律 40058（见 §3.50）。
function wecomMirrorValues(roleTextMap) {
  const fields = wecomMirrorConfig.fields || {}
  const values = {}
  for (const [role, text] of Object.entries(roleTextMap)) {
    const f = fields[role]; if (!f || !f.id) continue
    values[f.id] = String(text ?? '')
  }
  return values
}
// schema = { FIELD_ID: {title, type} }：自描述本次写入的字段结构（照抄工作表「示例数据」的写法）。所有行同一份 schema。
function wecomMirrorSchema() {
  const fields = wecomMirrorConfig.fields || {}
  const schema = {}
  for (const role of Object.keys(fields)) {
    const f = fields[role]; if (!f || !f.id) continue
    schema[f.id] = { title: f.title || role, type: 'text' }
  }
  return schema
}
// 批量新增：一次请求提交多行，返回 record_id 数组（与入参同序，供回填映射）。
// ⚠ 企微 webhook「接收外部数据」新增顶层键是 **add_records**（不是 access_token 服务端 API 的 `records`），返回体同样把
// record_id 装在 `add_records` 里；请求体须带 **schema**（字段自描述）+ 按 **FIELD_ID** 的纯文本 values（见 §3.48/§3.50）。
async function wecomMirrorAddBatch(roleTextMaps) {
  if (!roleTextMaps.length) return []
  const data = await wecomWebhookPost({ schema: wecomMirrorSchema(), add_records: roleTextMaps.map(m => ({ values: wecomMirrorValues(m) })) })
  return (data.add_records || data.records || []).map(r => r.record_id || '')
}
// 批量更新：一次请求更新多行（按 record_id）。updates = [{recordId, fieldsTextMap}]（fieldsTextMap 亦按 role 键）。
async function wecomMirrorUpdateBatch(updates) {
  if (!updates.length) return
  await wecomWebhookPost({ schema: wecomMirrorSchema(), update_records: updates.map(u => ({ record_id: u.recordId, values: wecomMirrorValues(u.fieldsTextMap) })) })
}
// 自适应写入：先整批发，失败就对半二分、递归到单行。既绕开「单请求条数上限(40058)」，也把「某行参数非法」隔离到单行——
// 不让一行坏拖垮整批（批量是原子的：整批成功回全部 record_id / 整批失败一行都不进）。单行仍失败才计入 failed 并记下
// 企微原话(errSample)供诊断；成功行的 record_id 回填进 ctx.map。ctx = { map, state:{ok,failed,errSample}, gap() }。
async function wecomMirrorAddAdaptive(batch, ctx) {
  if (!batch.length) return
  await ctx.gap()
  try {
    const ids = await wecomMirrorAddBatch(batch.map(it => it.textMap))
    batch.forEach((it, i) => { if (ids[i]) { ctx.map[it.fid] = ids[i]; ctx.state.ok++ } else ctx.state.failed++ })
    ctx.persist?.()   // ★ 每次成功新增即落盘映射：防「已写企微但 map 没记」——若进程在此后被杀/重启，下轮据 map 判「已镜像」不再重复 add（企微 webhook 删不了行，重复行清不掉，故必须尽早持久化，见 §3.52）
  } catch (e) {
    const msg = e?.message || String(e)
    if (batch.length === 1) {
      ctx.state.failed++; ctx.state.errSample = ctx.state.errSample || msg
      console.warn('[wecom-mirror] 单行新增失败', batch[0].fid, msg, '| 值样本:', JSON.stringify(batch[0].textMap).slice(0, 300))
      return
    }
    console.warn(`[wecom-mirror] ${batch.length} 行整批新增失败，二分重试:`, msg)
    const mid = Math.ceil(batch.length / 2)
    await wecomMirrorAddAdaptive(batch.slice(0, mid), ctx)
    await wecomMirrorAddAdaptive(batch.slice(mid), ctx)
  }
}
async function wecomMirrorUpdateAdaptive(batch, ctx) {
  if (!batch.length) return
  await ctx.gap()
  try {
    await wecomMirrorUpdateBatch(batch.map(it => ({ recordId: ctx.map[it.fid], fieldsTextMap: it.textMap })))
    ctx.state.ok += batch.length
  } catch (e) {
    if (batch.length === 1) {                    // 目标行可能被删 → 单行改「重建为新增」；仍失败则在 add 里计入 failed
      console.warn('[wecom-mirror] 单行更新失败，改重建为新增', batch[0].fid, e?.message || e)
      await wecomMirrorAddAdaptive(batch, ctx)
      return
    }
    const mid = Math.ceil(batch.length / 2)
    await wecomMirrorUpdateAdaptive(batch.slice(0, mid), ctx)
    await wecomMirrorUpdateAdaptive(batch.slice(mid), ctx)
  }
}

// 企微镜像行排序（用户口径 2026-08-04）：按状态优先级铺行——处理中 → 待处理 → 已完成 → 拒绝 → 其它/空。
// ⚠ 只决定「新增」行的**插入顺序**（webhook 只能追加/更新、不能重排已存在的行）：map 空的首次全量会把整表落成此序；
// 之后新增的需求按此序**追加在表尾**（无法把它插回对应状态组中间）。想让老表整体重排只能重建镜像表。
function mirrorStatusRank(s) {
  const t = String(s || '')
  if (/处理中|进行|正在/.test(t)) return 0
  if (/待/.test(t)) return 1
  if (/完成|已处理|已完/.test(t)) return 2
  if (/拒/.test(t)) return 3
  return 4   // 其它/空状态排最后
}

// ================= 反向同步：企微主表 → 飞书副本（手动触发）=================
// 主表反转后，飞书退为「保留能力 + 手动同步的副本」。方向与旧镜像相反，故**另起一张映射表**
// runs/wecom-lark-map.json（不动旧的 wecom-mirror-map.json，保留可回滚性）。
// 幂等要点（§3.52 教训）：远程先写、本地后记之间必有窗口，映射要「写一条记一条」而非整轮末尾才落盘。
const WECOM_LARK_MAP_FILE = path.join(RUNS_DIR, 'wecom-lark-map.json')   // { 企微 record_id: 飞书 record_id }
const loadWecomLarkMap = () => { try { return JSON.parse(fs.readFileSync(WECOM_LARK_MAP_FILE, 'utf8')) } catch { return {} } }
const saveWecomLarkMap = m => atomicWrite(WECOM_LARK_MAP_FILE, JSON.stringify(m, null, 2))

let _larkSyncing = false
async function syncLarkFromWecom() {
  if (!wecomDocConfigured()) return { ok: false, error: '企微主表未接通' }
  if (!larkConfigured()) return { ok: false, error: '飞书副本未配置' }
  if (_larkSyncing) return { ok: false, error: '上一次同步还在进行' }
  _larkSyncing = true
  try {
    // 读企微全量（SQL 一次取回；表当前 200+ 行，上限 5000 足够且有边界，不做无上限拉取）
    const rows = await wecomRecordsQuery(`SELECT * FROM \`${wecomDocConfig.sheetTitle}\` LIMIT 5000`)
    const map = loadWecomLarkMap()
    const state = { added: 0, updated: 0, failed: 0, errSample: '' }
    // 企微 SQL 返回里 record_id 的列名按 CLI 约定是 RECORD_ID；防御性多取几种写法
    const ridOf = r => r.RECORD_ID || r.record_id || r._record_id || ''
    const cellText = v => {
      if (v == null) return ''
      if (Array.isArray(v)) return v.map(x => x?.text ?? x?.userName ?? x?.title ?? (typeof x === 'string' ? x : '')).filter(Boolean).join('、')
      return typeof v === 'string' ? v : JSON.stringify(v)
    }
    for (const row of rows) {
      const wid = ridOf(row); if (!wid) continue
      // 飞书那张表列名与企微同名（一比一搬），故直接按列名平搬文本；附件列跳过（飞书图片不回灌）
      const fields = {}
      for (const [k, v] of Object.entries(row)) {
        if (k === 'RECORD_ID' || k === 'record_id' || k === '图示') continue
        const t = cellText(v)
        if (t) fields[k] = t
      }
      if (!Object.keys(fields).length) continue
      try {
        if (map[wid]) { await larkUpdateRecord(map[wid], fields); state.updated++ }
        else {
          const lid = await larkCreateRecord(fields)
          map[wid] = lid; saveWecomLarkMap(map)   // 写一条记一条（§3.52：别等整轮末尾）
          state.added++
        }
      } catch (e) {
        state.failed++
        if (!state.errSample) state.errSample = String(e?.message || e).slice(0, 200)
        console.warn('[wecom→lark] 行同步失败:', e?.message || e)
      }
    }
    saveWecomLarkMap(map)
    // 全失败明确 ok:false —— 绝不 ok:true+count:0 假装成功（§3.48 最惨痛的一课）
    const total = state.added + state.updated
    if (!total && state.failed) return { ok: false, error: `全部 ${state.failed} 行同步失败：${state.errSample}`, ...state }
    return { ok: true, ...state }
  } catch (e) {
    return { ok: false, error: wecomErrText(e) }
  } finally { _larkSyncing = false }
}

// 单次全量同步：读飞书 → 批量 upsert 到企微镜像（按 record_id 映射）→ 飞书已删行在企微标「作废」。永不抛（仿 sendBark）。
const _MIRROR_BATCH = 200     // 初始批大小（happy path 一批发完；失败自动二分降级，故可放大，= 飞书单页上限）
const _MIRROR_GAP_MS = 400    // 批次之间的间隔，进一步避让调用频率限制
let _mirrorSyncing = false
async function syncWecomMirror() {
  if (!wecomMirrorConfigured()) return { skipped: true, reason: !larkConfigured() ? '飞书主表未配置' : (!wecomMirrorConfig.enabled ? '镜像未启用' : '缺 Webhook 地址') }
  if (_mirrorSyncing) return { skipped: true, reason: '上一次同步还在进行' }
  _mirrorSyncing = true
  try {
    const fm = await larkResolveFieldMap()                                  // 解析飞书列名
    const roleCols = [['summary', fm.summary], ['status', fm.status], ['proposer', fm.proposer], ['proposeTime', fm.proposeTime]].filter(([, c]) => c)   // role → 飞书列名
    const rows = await larkListRecords(200)
    const map = loadMirrorMap()
    const seen = new Set()
    const items = []                                                        // 拍平：{fid, textMap}（textMap 按 role 键，写入时经 fields 映射成企微 FIELD_ID）
    for (const row of rows) {
      const fid = row.record_id; if (!fid) continue
      seen.add(fid)
      const textMap = {}
      for (const [role, col] of roleCols) textMap[role] = larkCellText(row.fields?.[col])
      items.push({ fid, textMap })
    }
    // 按状态铺行：处理中→待处理→已完成→拒绝（见 mirrorStatusRank）。稳定排序保留组内飞书原序；只影响新增插入顺序。
    items.sort((a, b) => mirrorStatusRank(a.textMap.status) - mirrorStatusRank(b.textMap.status))
    const toAdd = items.filter(it => !map[it.fid])       // 未镜像 → 新增（已按状态排序，插入即有序）
    const toUpdate = items.filter(it => map[it.fid])     // 已镜像 → 更新
    const state = { ok: 0, failed: 0, errSample: '' }
    let firstCall = true
    const ctx = { map, state, persist: () => saveMirrorMap(map), gap: async () => { if (!firstCall) await _mirrorSleep(_MIRROR_GAP_MS); firstCall = false } }

    // 新增 / 更新：整批发，失败自动二分降级到单行（回填 record_id / 隔离坏行，见 wecomMirrorAddAdaptive）
    for (const batch of _mirrorChunk(toAdd, _MIRROR_BATCH)) await wecomMirrorAddAdaptive(batch, ctx)
    for (const batch of _mirrorChunk(toUpdate, _MIRROR_BATCH)) await wecomMirrorUpdateAdaptive(batch, ctx)
    // 飞书已删除的行：企微对应行标「作废」（Webhook 删不了行），再从映射移除
    if (fm.status) {
      const stale = Object.keys(map).filter(fid => !seen.has(fid))
      for (const batch of _mirrorChunk(stale, _MIRROR_BATCH)) {
        await ctx.gap()
        try { await wecomMirrorUpdateBatch(batch.map(fid => ({ recordId: map[fid], fieldsTextMap: { status: '作废' } }))) }
        catch (e) { console.warn('[wecom-mirror] 标作废批失败', e?.message || e) }
        for (const fid of batch) delete map[fid]
      }
    }
    saveMirrorMap(map)
    const { ok, failed, errSample } = state
    const err = failed > 0 ? `${failed} 行写入失败${errSample ? '：' + errSample.slice(0, 120) : ''}` : ''
    wecomMirrorConfig.lastSyncAt = new Date().toISOString(); wecomMirrorConfig.lastError = err
    saveWecomMirrorConfig()
    broadcast({ type: 'wecom-mirror-synced', count: ok })
    if (ok === 0 && failed > 0) return { ok: false, error: err, count: 0, failed }   // 全失败明确报错，别再「ok:true count:0」误导
    return { ok: true, count: ok, failed, error: err }   // 部分失败时带回原因（err 仅在 failed>0 时非空）
  } catch (e) {
    wecomMirrorConfig.lastError = String(e?.message || e); saveWecomMirrorConfig()
    console.warn('[wecom-mirror] 同步失败:', e?.message || e)
    return { ok: false, error: String(e?.message || e) }
  } finally { _mirrorSyncing = false }
}

// ⚠ 2026-08-19 主表反转后，「飞书 → 企微」的**自动**推送必须停：企微才是主表，再自动推等于拿飞书的旧数据
// 覆盖企微的新改动。但**不是一刀切删掉**——企微主表接通前（老板还没建新表/还没扫码授权），旧镜像仍是同事
// 唯一能看到需求的渠道，停了就留空窗。故用条件闸：企微主表一接通，自动推送自动退场；未接通则照旧跑。
// 手动按钮（/api/wecom-mirror/sync）不受此闸限制，留作一次性回灌。
// ⚠ 必须 isPrimary 才退场。2026-08-21 降级：企微只批到写、没批到读 → 当不了主表，
// 旧镜像仍是企微同事看需求的唯一渠道，绝不能因为「企微表启用了」就把它停掉。
const mirrorAutoRetired = () => wecomDocConfigured() && !!wecomDocConfig.isPrimary

// 去抖即时同步（菲菲改动飞书后触发）：合并 ~1.2s 内多次改动为一次全量同步，fire-and-forget。
let _mirrorDebounce = null
function scheduleMirrorSync() {
  if (mirrorAutoRetired()) return
  if (!wecomMirrorConfigured()) return
  if (_mirrorDebounce) clearTimeout(_mirrorDebounce)
  _mirrorDebounce = setTimeout(() => { _mirrorDebounce = null; syncWecomMirror().catch(() => { }) }, 1200)
}

// 定时全量同步：可重臂计时器（仿 armPatrolSweep），周期 = syncMin 分钟；未启用则不臂。
let _mirrorTimer = null
function armMirrorSync() {
  if (_mirrorTimer) { clearInterval(_mirrorTimer); _mirrorTimer = null }
  if (mirrorAutoRetired()) { console.log('[wecom-mirror] 企微主表已接通 → 旧镜像自动推送退场（手动按钮仍可用）'); return }
  if (!wecomMirrorConfig.enabled) return
  const min = Math.max(1, Math.floor(Number(wecomMirrorConfig.syncMin) || 3))
  _mirrorTimer = setInterval(() => { syncWecomMirror().catch(() => { }) }, min * 60_000)
}

// Bark 地址解析：接受完整 URL（https://api.day.app/KEY 或自建 https://host[:port]/KEY）或裸 key
function normalizeBark(barkUrl) {
  const trimmed = String(barkUrl || '').trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)   // 完整 URL 形态
    const key = u.pathname.split('/').filter(Boolean)[0] || ''
    if (!key) return null
    return { server: `${u.protocol}//${u.host}`, key }
  } catch {
    const key = trimmed.replace(/^\/+|\/+$/g, '')   // 裸 key 形态
    return key ? { server: 'https://api.day.app', key } : null
  }
}

// 员工头像作 Bark 推送图标：优先用 employees.json 的 iconUrl（云直链，跨网络最稳）；
// 否则回退 iconBase（手机可达的 office-lab 地址）+ 员工 avatar 路径。
function empIconUrl(employee, cfg = pushConfig) {
  const emp = EMPLOYEES[employee]
  if (emp?.iconUrl) return emp.iconUrl
  const base = String(cfg.iconBase || '').trim().replace(/\/+$/, '')
  return base && emp?.avatar ? base + emp.avatar : ''
}

// 发送一条 Bark 推送；失败只 console.warn，绝不抛出影响主流程
async function sendBark({ title, subtitle, body, icon, url, level }, cfg = pushConfig) {
  const bark = normalizeBark(cfg.barkUrl)
  if (!bark) return { ok: false, message: 'Bark 地址为空或无效' }
  const payload = { device_key: bark.key, title, body: body || '' }
  if (subtitle) payload.subtitle = subtitle
  if (icon) payload.icon = icon
  if (url) payload.url = url          // 点通知打开的网页（审批页）
  if (level) payload.level = level    // 'timeSensitive' 让审批通知在专注模式下仍即时提醒
  if (cfg.group) payload.group = cfg.group
  if (cfg.sound) payload.sound = cfg.sound
  try {
    const resp = await fetch(`${bark.server}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    })
    const text = await resp.text()
    if (!resp.ok) { console.warn(`[push] Bark 失败 ${resp.status}: ${text.slice(0, 200)}`); return { ok: false, message: `Bark 返回 ${resp.status}: ${text.slice(0, 200)}` } }
    return { ok: true, message: '已发送' }
  } catch (e) {
    console.warn('[push] Bark 请求异常:', e.message)
    return { ok: false, message: String(e.message || e) }
  }
}

// 把员工汇报/指令清洗成适合手机通知的纯文本：去注入块、去机器标记、去 markdown 语法
function cleanForPush(text) {
  let t = String(text || '')
  t = t.replace(/【(?:任务快照|同事近况|完整档案)】[\s\S]*?(?=\n\s*\n|$)/g, ' ')   // 去掉注入块
  t = t.split('\n').filter(l => !/^\s*(?:【下一棒】|【交回】|【等你拍板】|【教训】|📄|任务档案：)/.test(l)).join('\n')  // 去机器标记整行
  t = t.replace(/```[\s\S]*?```/g, ' ')          // 代码块
    .replace(/`([^`]*)`/g, '$1')                 // 行内代码
    .replace(/\*\*([^*]+)\*\*/g, '$1')           // 粗体
    .replace(/\*([^*]+)\*/g, '$1')               // 斜体
    .replace(/^#{1,6}\s*/gm, '')                 // 标题
    .replace(/^\s*[-*+]\s+/gm, '· ')             // 列表
    .replace(/^\s*>\s?/gm, '')                   // 引用
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // 链接
  return t.replace(/\s+/g, ' ').trim()
}

// 用当前默认基座把已清洗的汇报压成短信式通知（≤2 句、口语、无技术名词）。
// fire-and-forget：起独立进程，带超时，任何异常/空结果/超时都 resolve(null)，由调用方回落到 cleanForPush 截断版。
// 动机：员工汇报再"简短"仍是四段式长文，直接截断仍是一大坨；要真短必须在通知层重新压缩，与汇报长度解耦。
const PUSH_SUMMARY_TIMEOUT_MS = 20000
async function summarizeForPush(rawText, { title = '', gate = '' } = {}) {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PUSH_SUMMARY_TIMEOUT_MS)
    try {
      const body = String(rawText || '').trim()
      if (body.length < 40) return null
      const prompt = [
        '你是手机通知精炼器。把下面这条同事的工作汇报，改写成一条像微信短信一样的通知。',
        '要求：中文口语；最多 2 句、总长不超过 60 字；只说"做完了什么 / 关键结果 / 是否要我拍板"，不要过程、不要技术名词（类名/表名/字段/状态码/路径一律不出现）。',
        gate ? '这条有需要我拍板的事项，务必在开头点出。' : '',
        '只输出通知正文本身，不要任何前后缀、引号或解释。',
        title ? `\n【场景】${title}` : '',
        `\n【原始汇报】\n${body.slice(0, 4000)}`,
      ].filter(Boolean).join('\n')
      // cwd 用临时目录（非 ROOT）：避免加载本仓 CLAUDE.md/memory/agents.md 作上下文——
      // 那会把单次通知要约从 ~8k 撑到 ~41k token（$0.037→$0.15、4s→30s）。要约不需要任何项目上下文。
      const engine = engineConfigStore.get().defaultEngine
      for await (const result of query({ prompt, options: {
        engine, model: engineConfigStore.get().providers[engine]?.model || undefined,
        cwd: os.tmpdir(), tools: [], settingSources: [], maxTurns: 1, abortController: abort,
        systemPrompt: '你是通知精炼器，只输出通知正文。',
      } })) {
        if (result.type !== 'result') continue
        const text = String(result.result || '').replace(/\s+/g, ' ').trim()
        return text && !result.is_error ? text.slice(0, 160) : null
      }
      return null
    } catch { return null }
    finally { clearTimeout(timer) }
}

// 推送正文：优先 LLM 精炼（配置开时），失败回落 cleanForPush 截断版。三处推送点（收工/接棒/回发）共用。
async function pushBody(rawText, { title = '', gate = '', max = 220 } = {}) {
  const cleaned = cleanForPush(rawText)
  if (pushConfig.aiSummary) {
    const summary = await summarizeForPush(cleaned, { title, gate })
    if (summary) return summary
  }
  return cleaned.slice(0, max)
}
// 任务档案 → 简短版本名：office-lab/tasks/2026-07-10-v5.12-示例项目工作台.md → "v5.12 示例项目工作台"
function taskShortName(taskFileRel) {
  if (!taskFileRel) return ''
  return String(taskFileRel).split('/').pop().replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ').trim()
}

// 员工「停下」时按配置推送（done/error/interrupted）——像同事发来的状态短信，不是 md 堆砌
const STOP_META = {
  done: { icon: '✅', word: '收工' },
  error: { icon: '❌', word: '异常停止' },
  interrupted: { icon: '⏸', word: '中断' },
}
async function maybePushRunStopped(run) {
  try {
    if (isConsult(run)) return   // 只读咨询窗＝老板正坐在窗前问话，收工不必推手机（降噪）
    // 巡视员(chaorenq)的内部巡查 run 不推送——除非它是在**升级给老板**，只有那条该通知（治「每条巡视 run 都弹一次 toast」骚扰）。
    // 判据见 patrolEscalating：不再只认严格标记（2026-08-24 事故：小呆呆用白话「无需我方动作，等你拍板」+ decision 卡升级，
    // parsePendingGate 解析不出 → 推送被这行静默吞掉，结论烂在没人看的子会话里，老板体感「小呆呆压根没巡」）。
    if (run.employee === 'chaorenq' && !(run.status === 'done' && patrolEscalating(run))) return
    // 巡视员用白话升级时 parsePendingGate 抽不出事项 → 给个兜底 gate，别让通知看着像普通收工
    const gateOf = (r) => (r.status === 'done'
      ? (parsePendingGate(r.result) || (r.employee === 'chaorenq' && patrolEscalating(r) ? '巡视员升级：需你裁决' : ''))
      : '')
    // 本地通知先行、无条件记录（不受 Bark pushConfig.enabled 门槛限制）：Windows 托盘据此弹原生 Toast。
    if (STOP_META[run.status]) {
      pushNotify({
        type: 'stop', runId: run.id, status: run.status,
        employee: run.employee, employeeName: EMPLOYEES[run.employee]?.displayName || run.employee,
        gate: gateOf(run),
        taskName: taskShortName(run.taskFile), lastKind: run.lastKind || '',
        resultTail: cleanForPush(run.result || run.instruction || '').slice(0, 180),
      })
    }
    if (!pushConfig.enabled) return
    let meta = STOP_META[run.status]
    if (!meta || !pushConfig.on?.[run.status]) return
    if (pushConfig.scope === 'dispatch' && run.lastKind === 'chat') return
    const name = EMPLOYEES[run.employee]?.displayName || run.employee
    const gate = gateOf(run) || null                                          // 待你拍板事项（最该推）
    if (gate) meta = { icon: '🙋', word: '收工·待你拍板' }                       // 有事项等你 → 标题一眼可见
    const title = `${meta.icon} ${name} ${meta.word}`
    const subtitle = taskShortName(run.taskFile)                                // 副标题给版本/任务名，正文不再堆路径
    const summary = await pushBody(run.result || run.instruction || '', { title: `${name}${meta.word}`, gate })
    const body = ((gate ? `🙋 待你拍板：${gate}\n` : '') + (summary || '（无更多内容）')).slice(0, 320)
    sendBark({ title, subtitle: subtitle || undefined, body, icon: empIconUrl(run.employee) })   // fire-and-forget
  } catch (e) { console.warn('[push] maybePushRunStopped 异常:', e.message) }
}

const liveRuns = new Map()      // runId -> run（持有活跃 query 的 run；替代 v0.1 的 children ChildProcess Map）
const pendingPerms = new Map()  // reqId -> { resolve, runId, timer }（canUseTool 待 UI 审批的挂起请求）

// ---------- 本地通知事件流（供 Windows 托盘轮询 /api/notifications 转成原生 Toast；与 Bark 解耦，不受 pushConfig.enabled 影响） ----------
// 只保留最近 N 条「收工/异常」事件（审批走 pendingPerms 实时派生，不入此表）。托盘带 since 游标增量拉取。
const NOTIFY_KEEP = 50
let notifyLog = []
let notifySeq = 0
function pushNotify(obj) {
  notifySeq += 1
  notifyLog.push({ seq: notifySeq, ts: new Date().toISOString(), ...obj })
  if (notifyLog.length > NOTIFY_KEEP) notifyLog = notifyLog.slice(-NOTIFY_KEEP)
}
const sseClients = new Map()    // runId -> Set<res>
const runSeq = new Map()        // runId -> 已写入事件数（= 最后一条事件的 SSE id，用于断点续传，避免重连全量重放）
const REPLAY_TAIL = 3000        // （保留）历史常量；冷开回放已改用下方「有意义消息」计数的小窗口
// 冷开尾部 / 分页都按「有意义的消息」计数，而非原始 jsonl 行数——否则工具调用/子代理内部/后台任务完成签
// 会各占一条，一页里真正的对话气泡寥寥无几（2026-08-11 反馈）。maxScan 是防超长工具噪声撑爆单页的兜底。
const INITIAL_TAIL_MSGS = 12    // 冷开 SSE 回放尾部这么多「条消息」（工具/子代理噪声不计数，但仍随范围回放）
const INITIAL_TAIL_MAXSCAN = 400 // 冷开兜底：即便消息数没数满，最多也只往前扫这么多原始行
const HISTORY_MAXSCAN = 600     // 「加载更早」单页兜底：最多往前扫这么多原始行

// 「有意义的消息」判定：只把用户气泡与助手文字气泡当作一条消息；工具调用/工具结果/子代理内部事件/
// 后台任务完成签/系统签都不计入（但仍随所在范围一并返回渲染，保证工具组与子代理块正常成形）。
function isMeaningfulEvent(ev) {
  if (!ev) return false
  if (ev.type === 'user-msg') return true                                                   // 用户消息 / 派工·抄送卡
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content))
    return ev.message.content.some(c => c.type === 'text' && (c.text || '').trim())          // 助手文字气泡（纯 tool_use 不算）
  if (ev.type === 'lab') return /^(📨 用户回复：|▶ 派工：)/.test(ev.text || '')               // 渲染成用户气泡的少数 lab 事件
  return false
}
function isMeaningfulLine(line) { try { return isMeaningfulEvent(JSON.parse(line)) } catch { return false } }
// 从 endExclusive(0-based，不含) 往前数，累计 count 条有意义消息后停在该条所在行，返回其 0-based 行索引（作页顶）。
// 数不满 count（到头或触达 maxScan 扫描上限）→ 返回可及的最早行索引。
function floorByMeaningful(lines, endExclusive, count, maxScan) {
  let seen = 0
  const stop = Math.max(0, endExclusive - maxScan)   // 最多往前扫到这行
  for (let i = endExclusive - 1; i >= stop; i--) {
    if (isMeaningfulLine(lines[i]) && ++seen >= count) return i   // 停在第 count 条消息所在行
  }
  return stop
}

// 下一条事件的 SSE id（1-based，等于该行在 jsonl 中的行号）。首次调用从已有文件行数恢复，服务重启后仍连续。
function nextSeq(runId, file) {
  let n = runSeq.get(runId)
  if (n === undefined) {
    try { n = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).length } catch { n = 0 }
  }
  n += 1
  runSeq.set(runId, n)
  return n
}

// ---------- 进行时活动标签（体验：让人实时看到员工"正在写 X / 思考中"，而非只有 running/done 两态）----------
function toolActivityLabel(name, input = {}) {
  const base = String(input.file_path || '').split('/').pop()
  switch (name) {
    case 'Read': return base ? `正在查阅 ${base}` : '正在查资料'
    case 'Grep': case 'Glob': return '正在检索代码'
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return base ? `正在写 ${base}` : '正在写文件'
    case 'Bash': return '正在执行命令'
    case 'Task': case 'Agent': {
      const t = input.subagent_type || 'agent'
      const d = String(input.description || '').trim()
      return d ? `起子代理 ${t}：${d}` : `起子代理 ${t}`
    }
    case 'TodoWrite': case 'TaskCreate': case 'TaskUpdate': return '正在梳理任务'
    case 'WebSearch': case 'WebFetch': return '正在联网查资料'
    default: return `正在用 ${name}`
  }
}
function deriveActivity(ev, run) {
  if (run?._userInput) return '等待你的回复'
  if (run?._userInput) return '等待你的回复'
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    let inner = null
    for (const c of ev.message.content) {
      if (c.type === 'tool_use') { inner = toolActivityLabel(c.name, c.input); break }
      if (c.type === 'text' && c.text && c.text.trim()) { inner = '正在回复…'; break }
      if (c.type === 'thinking') { inner = '思考中…'; break }
    }
    if (!inner) return null
    // 子代理事件（parent_tool_use_id 命中注册表）→ 分层归属"子代理·<type> <内层活动>"，不再错挂员工本人名下
    const pid = ev.parent_tool_use_id
    const sa = pid && run && run._subAgents && run._subAgents[pid]
    return sa ? `子代理·${sa.type} ${inner}` : inner
  }
  return null
}
// 顶层 Task/Agent tool_use → 登记子代理类型/描述（供 deriveActivity 分层）；下划线私有不落库
function trackSubAgents(run, ev) {
  if (ev.type !== 'assistant' || ev.parent_tool_use_id) return
  const content = ev.message?.content
  if (!Array.isArray(content)) return
  for (const c of content) {
    if (c.type === 'tool_use' && (c.name === 'Task' || c.name === 'Agent')) {
      run._subAgents = run._subAgents || {}
      run._subAgents[c.id] = { type: c.input?.subagent_type || 'agent', desc: c.input?.description || '' }
    }
  }
}

// ---------- watchdog：定期巡检活跃 query，长时间零消息 = 卡死 → abort（触发 handleStreamEnd 自动续跑） ----------
function sweepStalled() {
  const now = Date.now()
  for (const [runId, run] of liveRuns) {
    if (!run || run.status !== 'running' || run.stalled || run._userInput) continue   // 等真实用户反馈不是卡死
    const idle = now - (run._lastActivity || 0)
    if (idle <= watchdogGrace(run)) continue
    run.stalled = true
    appendEvent(runId, { type: 'lab', text: `⚠️ 检测到 ${Math.round(idle / 1000)}s 无输出，判定卡死，正在终止并自动续跑…` })
    broadcast({ type: 'run-stalled', runId, employee: run.employee, idleMs: idle, thinkingBudget: resolveThinking(run, run.lastKind) })
    try { run._abort?.abort() } catch { }   // abort → consumeStream 抛错 → handleStreamEnd 见 stalled=true 走续跑
  }
}
setInterval(sweepStalled, WATCHDOG_INTERVAL_MS)

// ---------- 全局 SSE：运行状态变更 / 任务档案变更 主动推送 ----------
const globalClients = new Set()
// 挂在全局 SSE 连接上的会话订阅（新 UI 的聊天窗口走这里，不再每窗一条 /api/runs/:id/events）
const runSubs = createRunSubs()
function broadcast(obj) {
  const line = `data: ${JSON.stringify({ ...obj, _ts: new Date().toISOString() })}\n\n`
  for (const res of globalClients) { try { res.write(line) } catch { } }
}
// 任务档案目录监听：员工回写档案的瞬间通知前端刷看板（debounce 防抖）
let tasksWatchTimer = null
try {
  fs.watch(TASKS_DIR, () => {
    clearTimeout(tasksWatchTimer)
    tasksWatchTimer = setTimeout(() => {
      broadcast({ type: 'tasks-changed' })
      scheduleLarkSync('tasks-changed')   // 档案是事实源 → 顺带把飞书需求表状态对齐（自带 debounce + 最小间隔节流）
    }, 400)
  })
} catch (e) { console.warn('tasks dir watch unavailable:', e.message) }

// ---------- 极简 YAML 子集解析（覆盖任务档案 frontmatter：标量/布尔/一层嵌套 map/字符串数组/行尾注释） ----------
function coerce(v) {
  v = v.trim()
  const ci = findComment(v)
  if (ci !== -1) v = v.slice(0, ci).trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v !== '' && !isNaN(Number(v)) && !/[^\d.\-]/.test(v)) return Number(v)
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1)
  return v
}
function findComment(s) {
  // 仅把「空白+#」视为注释起点，避免误伤值里的 #
  const m = s.match(/\s#/)
  return m ? m.index : (s.startsWith('#') ? 0 : -1)
}
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const root = {}
  let curKey = null   // 当前处于嵌套（map 或数组）下的顶层 key
  for (const raw of text.slice(4, end).split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    const indent = raw.match(/^ */)[0].length
    const line = raw.trim()
    if (indent === 0) {
      const m = line.match(/^([\w-]+):\s*(.*)$/)
      if (!m) continue
      const [, k, v] = m
      const cv = v.trim() === '' || findComment(v.trim()) === 0 ? '' : v
      if (cv === '') { root[k] = null; curKey = k }        // 待子行决定是 map 还是数组
      else { root[k] = coerce(cv); curKey = null }
    } else if (curKey) {
      if (line.startsWith('- ')) {
        if (!Array.isArray(root[curKey])) root[curKey] = []
        root[curKey].push(coerce(line.slice(2)))
      } else {
        const m = line.match(/^([\w-]+):\s*(.*)$/)
        if (m) {
          if (root[curKey] === null || typeof root[curKey] !== 'object' || Array.isArray(root[curKey])) {
            if (root[curKey] === null) root[curKey] = {}
          }
          if (root[curKey] && typeof root[curKey] === 'object' && !Array.isArray(root[curKey])) root[curKey][m[1]] = coerce(m[2])
        }
      }
    }
  }
  return root
}

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  return end === -1 ? text : text.slice(text.indexOf('\n', end + 1) + 1)
}
// 从 markdown 抽一个 `## <heading>` 到下一个同级/更高级标题（或 EOF）之间的正文（含标题行）。
// 用于把员工角色文件里的「巡视判据」速查块注入巡视 prompt——单一事实源、不复制到别处。
function extractSection(md, heading) {
  if (!md || !heading) return null
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = md.match(new RegExp(`(^|\\n)##\\s+${esc}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`))
  if (!m) return null
  const body = m[2].trim()
  return body ? `## ${heading}\n${body}` : null
}
// 取某员工角色文件里的「巡视判据（小呆呆专用速查）」段（供 spawnPatrol 注入）。抽不到返回 null。
function patrolCriteriaFor(employee) {
  try {
    const abs = resolveEmpFile(EMPLOYEES[employee]?.roleFile)
    if (!abs) return null
    return extractSection(fs.readFileSync(abs, 'utf8'), '巡视判据（小呆呆专用速查）')
  } catch { return null }
}

// 从任务档案正文提取「需求条目登记表」——条目级流水线状态（版本是条目的容器）
// 按表头列名定位，不再靠固定列序号：新增「状态」列（结构化枚举，前端据此上色）驱动圆点，
// 「当前阶段」自由文本保留给人读 + 用于推断「接棒」目标。老档案无「状态」列时 status 为空，前端回退文字启发式。
function extractEntries(text) {
  const m = text.match(/##\s*需求条目登记表([\s\S]*?)(\n## |$)/)
  if (!m) return []
  const rowCells = line => {
    const cells = line.split('|').map(c => c.trim())
    cells.shift(); if (cells[cells.length - 1] === '') cells.pop()
    return cells
  }
  const rows = m[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('|'))
  if (!rows.length) return []
  const header = rowCells(rows[0]).map(h => h.replace(/\*\*/g, ''))
  // ⚠ 按**列名前缀**定位（不认列序）。已知边界：若哪天表里同时出现「状态」与「状态说明」这类同前缀列，
  // findIndex 取的是先出现的那个 —— 新增列时别起同前缀的名字。
  const idxOf = (...names) => {
    for (const n of names) { const i = header.findIndex(h => h.startsWith(n)); if (i >= 0) return i }
    return -1
  }
  const iNo = idxOf('#'), iName = idxOf('条目'), iSrc = idxOf('来源'), iStatus = idxOf('状态'), iStage = idxOf('当前阶段')
  const iEntered = idxOf('进入日期', '进入')
  const pick = (cells, i, fallback) => (i >= 0 ? cells[i] : cells[fallback]) || ''
  const entries = []
  for (const line of rows.slice(1)) {
    const cells = rowCells(line)
    if (cells.length < 4) continue
    const no = pick(cells, iNo, 0)
    if (no === '#' || /^[-: ]+$/.test(no)) continue
    const name = pick(cells, iName, 1)
    if (!name) continue
    entries.push({
      no,
      name,
      source: pick(cells, iSrc, 2),
      // 进入日期：版本验收单靠它判「这条是哪一轮守航纳进来的」（同日双轮再用契约 named_items 消歧）。
      // 无该列则空串——不猜。
      enteredAt: iEntered >= 0 ? (cells[iEntered] || '') : '',
      status: iStatus >= 0 ? (cells[iStatus] || '') : '',
      stage: pick(cells, iStage, 4),
    })
  }
  return entries
}

// 版本级发布下一棒（快照用）：当所有条目已 QA 闭环，据 gates 布尔位派生「该发测/发线上/收尾」一句提示。
// 只用闭环集 + gates 布尔（不复制前端整张条目→下一棒映射表）；未全闭环时返回空——此时快照已逐条列出条目状态、
// agent 自明当前阶段。发布态以 gates 为准（status 会滞后，见 §buildVersionProgress）。版本级下一棒不再读手写「## 流程状态」（会漂，复盘 §3.58）。
function deriveReleaseHint(fm, entries) {
  if (!entries || !entries.length) return ''
  const allClosed = entries.every(e => VER_CLOSED_STATUS.has(String(e.status || '').replace(/\*\*/g, '').trim()))
  if (!allClosed) return ''   // 封板(frozen)不短路：它恰是发布阶段的标志，发测/发线上/收尾关口要照常出，是否完成交 gates 判
  const g = (fm && fm.gates) || {}
  if (!g.released_test) return '版本级下一棒：波比 · 发布测试环境（全部条目已 dev+QA 闭环，按 RELEASE_CHECKLIST 枚举仓库/服务）'
  if (!g.released_prod) return '版本级下一棒：波比 · 发布线上（测试环境回归通过后）'
  if (!g.post_release_done) return '版本级下一棒：波比 · 上线后收尾（完成后通知菲菲出版本发布说明）'
  return ''
}

// 从任务档案正文提取「流程状态」清单中未勾选项（历史手写清单；已不驱动 UI/快照，仅保留兼容）
function extractNextSteps(text) {
  const m = text.match(/##\s*流程状态([\s\S]*?)(\n## |$)/)
  if (!m) return []
  const steps = []
  for (const line of m[1].split('\n')) {
    const mm = line.trim().match(/^- \[ \]\s*(.+)$/)
    if (mm) steps.push(mm[1].replace(/\*\*/g, '').trim())
  }
  return steps.slice(0, 3)
}

// 从任务档案正文提取「待确认事项」表中未完结的行（状态列不含 ✅ 的即为待办）
function extractPendingDecisions(text) {
  const m = text.match(/##\s*待确认事项([\s\S]*?)(\n## |$)/)
  if (!m) return []
  const pending = []
  for (const line of m[1].split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').map(c => c.trim()).filter(Boolean)
    if (cells.length < 3 || cells[0] === '#' || /^-+$/.test(cells[0].replace(/[:\s]/g, '-'))) continue
    const status = cells[cells.length - 1]
    if (!status.includes('✅')) pending.push({ item: cells[1], status })
  }
  return pending
}

// safeResolve / resolveRepoFile 已迁到 ./paths.js（见文件顶部 import）——那里是路径根的唯一事实源，
// 三候选双向容忍：工作区相对（`office-lab/tasks/x.md`）→ 仓内相对（`tasks/x.md`）→ 剥前缀后仓内相对
// （独立模式下 406 条存量 taskFile 靠第三条命中）。此处不留兼容副本，避免双份定义漂移。

// ---------- 任务快照：派工时由 server 从最新档案抽取"开工定位信息"，注入 prompt 头 ----------
// 动机：任务档案（如 v5.12 达 152KB，时间线占 50%）此前要求 agent 每次派工全量读才能定位当前阶段，
// 占单次派工读负担 ~85%。改为 server 复用 /api/tasks 同款抽取器生成 1-3K 快照直接注入 prompt，
// agent 读到快照即可开工，不再全量读大档案；快照每次现抽 → 永与正文同步、agent 无需回写快照。
function buildTaskSnapshot(taskFileRel) {
  if (!taskFileRel) return ''
  let text
  try { text = fs.readFileSync(safeResolve(taskFileRel), 'utf8') } catch { return '' }
  const fm = parseFrontmatter(text) || {}
  const entries = extractEntries(text)
  const releaseHint = deriveReleaseHint(fm, entries)   // 版本级下一棒：派生自条目闭环+gates（不读手写「## 流程状态」，会漂）
  const pending = extractPendingDecisions(text)
  const lines = []
  const head = [fm.task || fm.version || '', fm.status ? `状态=${fm.status}` : '', fm.owner ? `owner=${fm.owner}` : ''].filter(Boolean).join(' ｜ ')
  if (head) lines.push(`版本：${head}`)
  // 「当前阶段」列在老档案里常塞入整段叙事（正是档案臃肿的来源）——快照只留短状态用于定位，长文留完整档案
  const brief = s => { const t = String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t }
  if (entries.length) {
    lines.push(`需求条目（${entries.length}）：`)
    for (const e of entries) lines.push(`  #${e.no} ${brief(e.name)}${e.status ? ` [${e.status}]` : ''}${e.stage ? ` → ${brief(e.stage)}` : ''}`)
  }
  if (releaseHint) lines.push(releaseHint)   // 仅在全部条目 QA 闭环时出「版本级下一棒：波比·发测/发线上/收尾」；未闭环则上方条目逐条状态即当前阶段
  if (pending.length) lines.push(`未完结待确认：${pending.map(p => `${p.item}(${p.status})`).join('；')}`)
  // 开工前门禁警示：新功能版（PM 段）未过三方会审时，快照头显式点名——治「agent 看 pm_confirmed=true 就以为 PM 完工、直接想派 GG Bond」（会话 7bab08b4 实证）
  if (fm.gates && fm.gates.tripartite_review === false && String(fm.status || '').startsWith('PM_')) {
    lines.push('⚠ 开工前三方会审未完成（新功能版硬门禁，未过不派 GG Bond；插单/急修/纯修复版如豁免须在时间线写明理由）')
  }
  if (!lines.length) return ''
  let snap = lines.join('\n')
  if (snap.length > 3000) snap = snap.slice(0, 3000) + '\n…（快照过长已截断，详见完整档案）'
  return snap
}
// 派工消息头：任务档案路径 + 任务快照（三处派工/回发拼装点复用，防格式漂移）
function taskHeader(taskFileRel) {
  if (!taskFileRel) return ''
  const snap = buildTaskSnapshot(taskFileRel)
  return `任务档案：${taskFileRel}\n${snap ? `\n【任务快照】（server 自最新档案抽取，仅作开工定位；细节与历史时间线以完整档案为准，按需再读上面的文件）\n${snap}\n` : ''}\n`
}

// ---------- 同事近况（peer awareness）：让员工"知道同事在干嘛"，从孤立 session 变成有团队感 ----------
// 业内共识：多 agent 靠共享状态(blackboard)协作而非彼此失明。这里从 runs 注册表抽取其他员工的最新动态注入派工 prompt。
function humanizeAgo(ms) {
  const m = Math.round(ms / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.round(h / 24)} 天前`
}
function buildTeamPulse(excludeEmployee) {
  const now = Date.now()
  const latest = {}   // employee -> 最近一条 run
  for (const r of Object.values(runs)) {
    if (r.employee === excludeEmployee || isConsult(r)) continue   // 只读咨询窗不代表员工在忙，别把「同事近况」写成假动态
    const t = Date.parse(r.updatedAt || r.startedAt || '') || 0
    if (!latest[r.employee] || t > latest[r.employee]._t) { r._t = t; latest[r.employee] = r }
  }
  const ST = { running: '正在忙', done: '刚收工', error: '上轮出错', interrupted: '被中断', starting: '刚接活' }
  const lines = []
  for (const r of Object.values(latest).sort((a, b) => (b._t || 0) - (a._t || 0))) {
    const name = EMPLOYEES[r.employee]?.displayName || r.employee
    const ago = r._t ? humanizeAgo(now - r._t) : '未知'
    const what = String(r.instruction || '').replace(/\s+/g, ' ').slice(0, 42)
    lines.push(`- ${name}：${ST[r.status] || r.status}（${ago}）——${what}`)
  }
  return lines.join('\n')
}
// 猪猪(Zhuzhu)对接提示：仅对用猪猪的员工(injectFor)注入；值全取自 zhuzhuConfig（单一事实源），端点细节让员工回线上文档拿。
function buildZhuzhuBlock(employee) {
  if (!zhuzhuConfig.enabled) return ''
  if (!Array.isArray(zhuzhuConfig.injectFor) || !zhuzhuConfig.injectFor.includes(employee)) return ''
  const base = String(zhuzhuConfig.baseUrl || '').trim()
  const lines = [
    '【猪猪(Zhuzhu)对接】（E2E 自动化；连接配置在办公室「猪猪对接设置」，host/port 会随机器漂移）',
    '- 猪猪能力已作为 MCP 工具挂到你本会话，直接调这些类型化工具即可，**别再手拼 HTTP、别 hardcode 主机/端点**：',
    '  mcp__zhuzhu__get_integration_doc / validate_test_file / run_headless / run_app / run_app_batch / get_run_summary / list_sessions / cancel_run / list_test_files / read_test_file / write_test_file。',
    // 下面这排是「答掉你反复自己推理的那些问题」的工具——2026-08-27 实测全部在线（复盘 §3.106）。
    // 单列一行是因为：它们早就交付了，但从没进过这个块，于是调用量长期为零（§3.90 同款病）。
    '- **别再靠推理去回答下面这些问题，它们各有一条工具直接给答案**：',
    '  · 登录态还在不在 → `mcp__zhuzhu__get_auth_status`（秒回 status/authenticated/staleness/expiresInMs）；**判「登录失效/要人工」之前必须先调它**。',
    '  · 登录过期了怎么办 → `mcp__zhuzhu__bootstrap_auth_profile`（程序化账密登录、凭据按名取自工作区凭据库，**不需要活人扫码**）；或用例侧 `authBootstrap=run` 走 `common/sampling-base.json` 的 `recovery.login`。',
    '  · 今晚能不能无人值守跑 → `mcp__zhuzhu__preflight`（通道/磁盘/前端可达/构建新鲜度/auth profile 新鲜度/遗留会话/建议并发度，逐项 pass|warn|fail 且**每项带 fix**）。',
    '  · 这条 RED 算不算校准 → `mcp__zhuzhu__verify_evidence`（读 `evidence-bundle.json` 的 `failureClass`，只认 `value-assertion`）；证据包就在每个 case 目录里，**别再靠步骤标题猜**。',
    '  · 收工报告的机器事实 → `mcp__zhuzhu__get_report_card`；某个按钮要什么看板/tab/状态/权限才可见 → `mcp__zhuzhu__get_ui_contract`。',
    '- 全链路：先 get_integration_doc 取当前协议版本+workspace 绝对路径 → validate_test_file（提交/执行前**必过**，errorCount>0 先修）→ run_headless 做 RED 校准（同步返回报告）→ run_app 终验（默认异步返回 externalRunId，用 get_run_summary 轮询到终态；要一次拿终态传 wait:true）→ get_run_summary 读结果（可重复读）。',
    '- testFilePath 传相对 test-workflows 的路径、不带前缀；workspace 绝对路径以 get_integration_doc 现值为准（猪猪端设定，office-lab 不另存）；用例 JSON 写 test-workflows/，资产 test-assets/，产物 output/。',
    // 旧措辞是「多半是 App 没启动」——2026-08-26 那轮 App 明明在跑，是**我方存的 base 指向了已死端口**，
    // 这句话把她指向了错误的分支，连带 18 个工具全缺、最终误判「登录必须人工」。改成两条分支都点名。
    `- 若这些 mcp__zhuzhu__* 工具不可见，**两个原因都要查、别只查第一个**：① 猪猪桌面 App 没启动（→ **你自己起**：\`vision-e2e\` 目录脱离会话后台 \`npm run dev\`、钉 \`ZHUZHU_APP_RUN_PORT=32147\`，见 SOP 红线 10；不是阻塞、别 park 给老板）；② **办公室存的基地址漂了**（工具随 App 托管在 ${base}/mcp，base 存错则工具静默全缺、看起来和 App 没起一模一样）。先 \`curl ${base}${zhuzhuConfig.docPath || '/external-integration-documents'}\` 判到底是哪一种。`,
    '- 生成/改用例前另读 docs/e2e-test-case-generation-rules.md。',
  ]
  // base 健康：同步读缓存（开机 + 巡视 sweep 已异步刷好，见 refreshZhuzhuHealth 缘起）。
  // 探不通就显式标红并给出实际在监听的候选——把「配置漂移」从「App 没起」里分离出来。
  // 从没探过（reachable===null）时什么都不说，绝不假装健康（§3.104 口径一：不许自带虚假健康值）。
  if (zhuzhuHealth.reachable === false && zhuzhuHealth.base === base) {
    const d = zhuzhuCaps.diagnoseBaseUnreachable({ base, aliveCandidates: zhuzhuHealth.aliveCandidates })
    lines.push(`- 🔴 **本机探活：${d.why}**。${d.fix}。`)
  }
  const note = String(zhuzhuConfig.note || '').trim()
  if (note) lines.push(`- 临时提醒：${note}`)
  return lines.join('\n') + '\n\n'
}

// 老板这句话的话题锚：老板在某份档案上下文里开口（运行环境卡「找员工聊」/ 挂档案会话里回话）时，话里的「这个/那个」默认落在本档案。
// 2026-10-06 事故（run 20261006011711-ec8fa0）：老板从「示例项目 v6.0.0」运行环境找菲菲说「罗宾说这个还需要加入第三方区别…」，
// 快照明明注入了，但没人告诉她「老板在聊这份档案」，紧挨原话的【同事近况】里又是 GG Bond 刚查的备货单——
// 她把「这个」对号入座到同事的话题上，还断言「跟本会话挂的档案没关系」。所以锚紧贴老板原话之前（近因最强），并点名同事近况不是话题。
function bossTopicAnchor(taskFileRel) {
  if (!taskFileRel) return ''
  const name = String(taskFileRel).replace(/^.*\//, '').replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '')
  return `【老板这句话的上下文】老板是在「${name}」这份档案下找你的（即上面的任务档案）。他话里的「这个 / 那个 / 这里 / 这块」**默认指本档案范围内的功能**——先到任务快照的条目里找最贴近的那条去理解；【同事近况】只是团队背景，**不是老板这句话的话题**，别拿同事刚做的事去对号入座。只有他明确点名了别的系统 / 版本 / 档案才跳出本档案；按本档案理解仍拿不准时，带着本档案里最可能的那条去问。\n\n`
}

// 派工前导：任务快照 + 同事近况 + 猪猪对接（三处派工/回发点统一用它拼 prompt 头）
// fromBoss：这条是老板亲口说的（非同事交回 / 巡视 / 引擎续跑）——末尾追加话题锚（bossTopicAnchor）
function dispatchPreamble(employee, taskFileRel, { fromBoss = false } = {}) {
  const th = taskHeader(taskFileRel)
  const pulse = buildTeamPulse(employee)
  // 猪猪对接块不再拼进派工头（已并入 startRun 的 systemPrompt append，每会话一次）——派工消息保持只含任务快照 + 同事近况
  return th + (pulse ? `【同事近况】（团队当前动态，供你协作/交接判断参考，不必逐一处理）\n${pulse}\n\n` : '') + (fromBoss ? bossTopicAnchor(taskFileRel) : '')
}

// 只读会话开局背景：**只给指针 + 摘要，不搬运正文**。
// 取舍缘起 §3.49：跨会话自动灌内容＝串线源头（旧会话诈尸把结果注进新会话那次事故）。这里同理——
// 老板开只读窗常常就是想问「你现在改的那摊跟这个 bug 有关吗」，所以必须给"你正在跑什么"的坐标，
// 但正文让它自己按需 Read（run 的 jsonl / 任务档案都在磁盘上），引擎不代劳搬运。
function consultBackgroundBlock(employee) {
  const lines = []
  const live = []
  for (const r of liveRuns.values()) {
    if (r.employee !== employee || isConsult(r)) continue
    if (r.status === 'running' || r.status === 'starting') live.push(r)
  }
  if (live.length) {
    for (const r of live) {
      lines.push(`- 你的正式会话 \`${r.id}\`（${r.lastKind === 'chat' ? '对话' : '派工'}，起于 ${String(r.startedAt || '').slice(0, 19).replace('T', ' ')}${r.executionMode === 'guarded_run' ? '，守航态' : ''}）${r.taskFile ? `，挂档案 \`${r.taskFile}\`` : '，未挂任务档案'}`)
      const doing = String(r.activity || '').trim()
      if (doing) lines.push(`  · 此刻在做：${doing.slice(0, 120)}`)
      const tail = String(r.result || '').replace(/\s+/g, ' ').trim()
      if (tail) lines.push(`  · 上一轮收尾摘要（截断）：${tail.slice(-400)}`)
      // 落盘事件在 app/runs/ 下（RUNS_DIR，见文件头）——这句原先写成 `office-lab/runs/…`，指错了目录、员工照它读必然 ENOENT
      lines.push(`  · 想看细节就自己去读那条会话的落盘事件：\`${officeRel('app', 'runs')}/${r.id}.jsonl\`（引擎不替你搬运正文，避免串线）`)
    }
  } else {
    // 没在跑：给最近一条正式会话当坐标（老板常在员工刚收工后追问）
    let recent = null
    for (const r of Object.values(runs)) {
      if (r.employee !== employee || isConsult(r)) continue
      const t = Date.parse(r.updatedAt || r.startedAt || '') || 0
      if (!recent || t > (Date.parse(recent.updatedAt || recent.startedAt || '') || 0)) recent = r
    }
    lines.push(recent
      ? `- 你当前**没有**在跑的正式会话；最近一条是 \`${recent.id}\`（${recent.status}）${recent.taskFile ? `，挂档案 \`${recent.taskFile}\`` : ''}`
      : '- 你当前没有在跑的正式会话，也没有历史会话记录')
  }
  // 代码仓当前分支：直读 .git/HEAD（纯文本），不 spawn git——只读窗要快，且这三个仓的分支是排查时最常需要的坐标
  const branches = []
  for (const repo of ['backend', 'frontend/web-app', 'frontend/partner-app']) {
    try {
      const head = fs.readFileSync(path.join(ROOT, repo, '.git', 'HEAD'), 'utf8').trim()
      const m = head.match(/^ref:\s*refs\/heads\/(.+)$/)
      branches.push(`  · ${repo}：${m ? m[1] : head.slice(0, 12) + '(detached)'}`)
    } catch { /* 仓不存在/不可读则跳过 */ }
  }
  if (branches.length) lines.push('- 代码仓当前分支（读 .git/HEAD 得到，供你判断在看哪份代码）：\n' + branches.join('\n'))
  return `

---

## 【只读窗背景 · 坐标】（引擎自动注入，非老板所言）

${lines.join('\n')}`
}

// 全时双态·守航态行为约束（executionMode==='guarded_run' 时注入派工 prompt）。
// 设计事实源 docs/tech/全时双态协作-设计.md + Stage0 红线分类；把已定的守航行为规则接到 dispatch 层，
// 让「守航」从惰性标记变成真改变行为——也正是第一轮影子跑要观测的东西（prompt 层规则在哪失效=停靠地图，
// 之后才据此做 Stage 4 结构门硬化，见设计 §14/§16 与 Stage0「必须做成结构门」）。
function guardedRunPreamble() {
  return `【守航态 · GUARDED RUN｜无人值守，老板不在线·够不到】本轮按以下边界自主推进，均为硬约束（违反=本轮不合格）：
1. 【像产品经理那样想，三种不确定分开处理——不再一律 park】遇到不确定先分清是哪一种（v0.11.0 老板定）：
${acceptanceCard.UNCERTAINTY_RULES}
**只有③才停下等老板，而且只停那一条**；把①②写成问句等老板＝空停。**永久不变的底线**：不替老板做反悔代价大的决定、不伪造测试通过、不执行生产动作、不做破坏性 Git、交接必须真实。
2. 【停在授权边界】只做守航契约 authorization 列 true 的动作；命中 forbidden（生产发布/DDL/破坏性 Git/force_push/真实企微·真机·三方副作用）一律不做，置该条目安全停靠。
3. 【无人工预检门·迷糊全量 QA 前移·终点 RC_READY】人工预检门已全局撤销（2026-10-22，白天也一样）；守航态同样——开发方（GG Bond）自检+对抗自查后**不 park 在人工预检门、直接【下一棒】迷糊做完整 QA**（人工预检是白天「用便宜人眼过滤、省猪猪 QA」的成本优化，夜里无人失效；改由迷糊全量测试确保晨间交付「最接近 OK」，便宜滤职能由开发方对抗自查顶上）。迷糊全量 QA（RED→GREEN/猪猪）通过、**验收卡四格填满**后停 RC_READY／发测前，**绝不自动发布生产**，待晨间人工做**最终验收**（验收=看已测版本 UI/UX + go/no-go）。
4. 【失败即安全停靠，不无限返工——但"停"的门槛是"路都试过了"】轮数上限**只约束「同一方案反复重试」**：同一条路撞满上限 → 条目置「已隔离」+ 保留分支与失败证据。**换一条从未试过、且能直接移除已确诊堵点的路径，不计入上限、也不算"自行换方案"**——想到了却没试就停，是空停不是安全停靠（2026-08-19 事故：迷糊自己写下 openUrl / callApi 两条绕行方案，一条没试就 park，一夜 0 绿）。**收工前自检：我还剩几条想到但没试过的路？>0 就接着干。**单条失败不阻塞其余条目——单点堵只 park 被它真正堵住的，别连坐整批。
4b. 【自己维护的东西过时＝自己的活】用例/fixture/flow macro/脚本因被测功能变更而失效，**更新它就是本职**，不是"被 harness 硬卡"，更不是 park 理由；改完回写共享库（别只留在本轮临时目录，否则下一轮撞同一堵墙）。
5. 【不降标换绿】测试要么达机器可验 GREEN、要么隔离，**绝不削弱断言/降标凑 GREEN**。
6. 【交接必真实 + 看板即时回写】看板是老板明早唯一能看见「发生了什么」的通道：每步即时回写、交接内容必须真实。
7. 【收工必给明确 marker，绝不空手/死等】夜间本应升级老板的 → ③类用 raise_risk 登记（老板在验收卡上一键选路，选完引擎自动把条目交回流水线），不死等一个睡着的人；①②类自己处理掉。
7b. 【park / 等你拍板 不是免检符】它们只对③类（反悔代价大、只有老板能定）有效。守航态 park_item 必须写「为什么只有老板能定」——写不出来就是①②类，引擎当场拒收；目标循环也会把理由不成立的暂停条目派回来重判。**park 每一条前自问：做错了，老板一句话我能不能一小时内改回去？能，就自己定。**
7c. 【契约里的**数值**不是老板的意思，是可调参数——不许拿它当"做不了"的结论】\`max_changed_repositories\` / \`max_items\` / \`max_dev_qa_rounds_per_item\` 这些是引擎按常见形态填的**默认值**，治的是"夜里无人时摊子失控"，**不是老板对这条需求的裁决**。撞顶时唯一正确的动作是：**先如实报「这条需要几个仓 / 几条，为什么，超出多少」，把它写成老板一句话就能放行的问题**，再按 park 处理；**绝不许写成「该条目超预算所以本轮不做」就翻篇**——那是把引擎的默认值冒充成老板的决定。缘起 2026-09-18 guarded-01：老板**点名**的 REQ-0353 落点在第 3 个仓，被写死的 \`max_changed_repositories:2\` 挡掉，park 理由通篇讲"超契约"，老板第二天才知道是被一个自己没设过的数字否掉的。**点名即范围**——老板点了的条目，不该被引擎默认值推翻。
7d. 【"等 X 先落地"这类依赖，要说清"落到哪一步"】X 已达 **RC_READY 且分支已冻结可依赖**的，"等它落地"这条依赖就**不再成立**（同一条链上继续做即可）；确实要等它**真上线**的，说清为什么（如需真实存量数据回填、需线上灰度）。别把"还没上线"一律当成阻断。
8. 【起草期也按三种不确定走，不再整轮停等】起草期（需求说明与 facet 尚未冻结）遇口径不清：①自己查、②自己定并 record_decision、③ raise_risk——**只停③那一条，其余条目照常起草、交棒**，绝不因为一条停全线。冻结后同理；老板早上在验收卡上改掉你定的，引擎会把那条交回来返工，这是正常流程，不是事故。
本轮守航契约见任务档案同级「守航契约」文件（机器 yaml 块为准）。

【本轮引擎已上的机器闸（不是提醒，是会真的拦你/记你的）】
9. 【三红灯有数了】引擎逐条记账：越权动作（\`guard.violation.forbidden_action\`）、超预算（\`guard.violation.over_budget\`）、假绿（\`guard.fake_green\`，机器派生：证据不全 / verify 不通过 / failureClass≠value-assertion / 区分度低 / 页面报错 / 环境陈旧）。**收工前用 \`guard_status\` 自查一次**，红灯 >0 的在收工汇报里如实写清哪条、为什么——别让老板明早在晨检包里第一次看到。
10. 【收工标记当场校验，不再事后派巡视】收尾缺 \`【下一棒】/【交回】/【等你拍板】<真事项>\` 之一 → 引擎**当场拒收并回灌**，本轮不算收工。写不出具体事项的【等你拍板】＝这不是要老板拍的事、是你该干完的活。
11. 【长任务落进度快照】做完一个阶段就用 \`progress_snapshot\` 落一条「做到哪 / 下一步 / 别再重做什么」。任何续跑路径引擎都会把它注回你的 prompt——落了它就不会从头重来。
12. 【交接即冻结】交给下一棒前必须 commit + push（**允许 \`wip:\` 提交**，交接不等于定稿）。开发跑 \`freeze_handoff\` 拿 commit sha 写进交接卡；证据绑不可变版本，改码即新 commit → 引擎自动作废受影响 facet 证据（\`impact_radar\`）。
13. 【门禁按 risk_class，不按临场判断】\`high\`（大范围重构 / 触碰已上线主数据 / 生产 DDL / 权限变化 / 存量回填 >1000 行 / 不可逆外部副作用）→ 守航态**照样实施到底**：开发分支上写完、测试环境验证、验收卡填满；只有上线时不可逆的那几步（线上执行 DDL / 迁移线上数据 / 配权限）**写成上线步骤、不执行**（脚本可重复执行 + ddl_precheck + 影响行数 + 回滚方案进 RELEASE_CHECKLIST）。**「要不要今晚做 / 什么时候做」不是可以 park 的问题**——老板签契约就是要做（2026-09-30 老板：「只做简单的那我签约守航干什么！」）。机器定级高于人填的以机器为准（决定的是必需 facet 与上线步骤，不再是做不做）。
14. 【接口缺位一律记「未验证」，绝不记「通过」】猪猪的 verify_evidence / preflight / 环境指纹等能力未接通时，相关结论只能写「未验证」。**「问不到」不是「通过」**——把它写成通过就是假绿。
15. 【目标循环：链停了不等于这一轮结束】你收工后引擎会判「这一轮干完没」：每个条目要么「做完且验收卡四格齐」，要么「在等老板拍高危事项」，要么「试尽后隔离」。没干完就自动派人接着做（新会话 + 你落的进度快照）；同样的局面连续 3 次续跑没推进 → 判卡住、停下交老板。**收工前用 goal_status 自查还差什么。**
16. 【验收卡是老板早上唯一要看的东西】四格：①做完没（引擎填）②长啥样（GG Bond 写一句话、迷糊挂截图；纯后端写明无界面改动）③动了哪些老功能（GG Bond 申报、迷糊逐条重跑验证）④高危事项（raise_risk）。用 acceptance_card 填；**四格不齐不算做完**。
17. 【替老板定的，都要亮出来】守航期间自己拍的每个决定都用 record_decision 记（查得清的写依据、可以反悔的写备选），它进验收卡「我替你定了什么」，老板一键追认或改掉——**大胆定、如实记，别藏、也别把它包装成问句**。

`
}

// ---------- 守航冷启动（看板侧栏「🌙 守航开工」）：签发契约 + 组装冷启动指令 ----------
// 缘起：守航态原先只能在派工弹窗勾选，而派工弹窗的语义全挂在「已有任务卡片/已有任务档案」上——
// 想让菲菲**从 0 起草需求**（自主挑需求→需求说明→建档案→交棒）时根本没有对得上的入口；且
// guardedRunPreamble 让员工去读「任务档案同级的守航契约文件」，但 tasks/ 下**从来没有过一份实例**
// （首轮影子跑发现 #2：菲菲三条输入全够不到 → 全 park、0 候选）。这里把「签发契约 + 冷启动指令」
// 收归引擎：入口只传字段，契约与 prompt 各只有一份事实源，不必每晚手抄。
// ⚠ 契约**字段语义**的事实源是 `templates/守航任务契约.md`——改模板要同步改这里。刻意**不做**模板字符串
//   替换：模板里是 `<x.y.z>`/`<整数>` 这类人读占位符，替换脆且会静默漏填，生成器显式列字段更可审。
// ⚠ 诚实边界：契约 yaml **仍不被引擎机器拦截**（Stage 4 拦截层 2026-08-15 因误杀只读 MCP 已撤销），
//   它是 prompt 级授权 + 次日晨检的审计基线；真正机器硬拦的只有 DANGER_DENY（所有模式生效）。
// 守航契约的默认 token 参考顶。取值理由：v5.19 那轮四位员工整夜跑下来量级在百万级，设 200 万＝
// 「明显跑飞了」的报警线而非日常约束。**引擎不因超顶杀进程**（夜里被杀死比超支更坏），只记
// guard.violation.over_budget 并在晨检包点名——先让它有数，硬不硬顶留给老板据数据再定。
const GUARD_DEFAULT_MAX_TOKENS = Number(process.env.OFFICE_LAB_GUARD_MAX_TOKENS || 2_000_000)
// 仓数上限的两档默认值。**这条曾经是写死的 `2`，并因此把老板点名的需求挡在门外**——
// 2026-09-18 guarded-01：老板点名 REQ-0342/0352/0353 三条，REQ-0353 落点在 partner-app
// （第 3 个仓），菲菲照契约判「超 max_changed_repositories:2」→ park。那个 2 不是老板设的，
// 是引擎自己编的默认值；入口连改它的字段都没有。于是「三条只做了一条」在审计面上还算**合规**。
// 口径厘清：仓数上限治的是**自选 triage 时的摊子失控**（夜里无人值守，别一口气铺开五个仓），
// 它**不该用来否掉老板的显式点名**——点名本身就是老板给的范围。故分两档：
//   · 自选（ready_pool_then_triage）→ 2（原状不变）
//   · 点名（boss_named）→ 3（够一条前后端+第三方前端的纵向链路；仍可由入口显式覆盖）
const GUARD_DEFAULT_MAX_REPOS = 2
const GUARD_NAMED_DEFAULT_MAX_REPOS = 3
function isoLocal(d) {
  const p = n => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
}
// 同一天多轮守航互不覆盖：扫 tasks/ 取下一个未占用的序号（guarded-01、guarded-02…）
function nextGuardedContract(date) {
  const d = date || todayStr()
  for (let i = 1; i < 100; i++) {
    const seq = String(i).padStart(2, '0')
    const name = `${d}-守航契约-guarded-${seq}.md`
    if (!fs.existsSync(path.join(TASKS_DIR, name))) {
      return { name, abs: path.join(TASKS_DIR, name), rel: `office-lab/tasks/${name}`, runName: `${d}-guarded-${seq}` }
    }
  }
  throw new Error('同日守航契约已达 99 份，先清理 tasks/ 再起跑')
}
// 契约表格里塞的是台账里的整段理由（含换行/竖线），不处理会把 markdown 表撑烂。
// `flat` 只压平、不截断；`oneLine` 才截断，**且只许用在"截了也不丢决策"的列上**（上轮卡点/上轮拟定口径
// ——那两列的全文在上一轮的台账与契约里都在）。⚠ **老板的表态绝不许截**：它是本轮唯一的新增决策，
// 截断＝把一句「按 A 做…但要满足①②」砍成半句（2026-09-18 签 guarded-02 时当场踩到：表态被切在
// 「不要再因为这条」处，后面的附加要求全没了）。表格放摘要、全文另起一节。
const flat = s => String(s || '').replace(/\r?\n+/g, ' ').replace(/\|/g, '/').trim()
const oneLine = s => flat(s).slice(0, 240)
const RULING_EXCERPT = 90
// 范围修订：就地改契约的 `selection.named_items` + 在「四、范围修订记录」表追一行（带老板原话）。
// 刻意**就地改而不是重签**：重签会新起一个 run_name，旧契约的台账/证据/时间线就此断成两截，
// 而修订记录是连续的——「本轮范围被改过几次、每次凭什么」在同一份文件里看得全。
// 自选轮原本没有 named_items 行 → 补在 max_items 之前；移除到空也保留空数组，
// 别让它退化成「未点名＝全放开」（那会把一次收窄变成一次悄悄的放权）。
function amendContractScope(entry, { req, action = 'add', bossQuote = '', acceptsDelay = false, note = '', by = '' } = {}) {
  const abs = safeResolve(entry.rel)
  let text = fs.readFileSync(abs, 'utf8')
  const cur = (entry.contract?.selection?.named_items || []).map(s => String(s).toUpperCase().trim()).filter(Boolean)
  const next = action === 'remove' ? cur.filter(x => x !== req) : (cur.includes(req) ? cur : [...cur, req])
  const line = `  named_items: [${next.join(', ')}]        # 只做资格核验，不得自行扩选；中途增减见「四、范围修订记录」`
  if (/^\s*named_items:.*$/m.test(text)) text = text.replace(/^\s*named_items:.*$/m, line)
  else text = text.replace(/^(\s*max_items:.*)$/m, `${line}\n$1`)
  const row = `| ${new Date().toISOString().slice(0, 19).replace('T', ' ')} | ${action === 'remove' ? '移除' : '追加'} | ${req} | ${flat(bossQuote).slice(0, 300)} | ${acceptsDelay ? '是' : '—'} | ${by || '—'} |`
  const m = text.match(/(## 四、范围修订记录[\s\S]*?\|-{2,}\|[^\n]*\n)([\s\S]*?)(?=\n## )/)
  if (m) {
    const kept = m[2].split('\n').filter(l => l.trim().startsWith('|') && !/^\|(\s*\|)+\s*$/.test(l.trim()))
    const n = kept.length + 1
    // ⚠ `| ${n} ${row}`——row 自带开头的 `| `，序号后**必须留它**当分隔线。
    // 先前写成 `row.slice(1)` 把那根竖线削掉了，序号和时间黏成一格（`| 1  2026-09-21 …`）。
    text = text.replace(m[0], `${m[1]}${kept.length ? kept.join('\n') + '\n' : ''}| ${n} ${row}\n`)
  } else {
    text += `\n> ⚠ 本契约无「四、范围修订记录」表（旧版签发件），修订如实补记于此：\n${row}\n`
  }
  atomicWrite(abs, text)
  _contractByRel.delete(entry.rel)   // 失效 mtime 缓存，下次读到的是新的 named_items
  return { named: next, note }
}
// 签发一份守航契约文件（人读散文 + 机器 yaml 块），返回 {rel, abs, runName, deadlineIso}
// dryRun=true：只组装文本、**不落盘不占序号**，供「签之前先看一眼」与自动化验证（否则验一次就在 tasks/ 里
// 留一份废契约，而契约序号是全局单调的，废件会把真轮次挤到后面去）。
function issueGuardedContract({ source, picks, maxItems, maxRepos, deadline, note, carryOver, rulings, fromRunName, dryRun, goalLoop, maxGoalTurns, archiveRel, version, intentOverride } = {}) {
  // v0.11.0 目标循环：新签的契约默认 active（老板 2026-09-29 定：守航升级为自助托管）；入口可选 shadow（只记不派）/ off
  const loop = guardGoal.GOAL_MODES.includes(String(goalLoop || '').toLowerCase()) ? String(goalLoop).toLowerCase() : 'active'
  const goalTurns = Math.max(1, Math.min(30, Math.floor(Number(maxGoalTurns) || guardGoal.GOAL_DEFAULTS.maxGoalTurns)))
  const c = dryRun
    ? { name: '(dry-run).md', abs: '', rel: '(dry-run)', runName: `${todayStr()}-guarded-NN` }
    : nextGuardedContract()
  const named = source === 'named'
  const items = (Array.isArray(picks) ? picks : String(picks || '').split(/[,，\s]+/)).map(s => String(s).trim()).filter(Boolean)
  // 点名模式下 max_items **不许比点名条数小**：老板点了 3 条、弹窗「最多条数」还停在默认 1 时，
  // 契约会写出「named_items 三条 / max_items 1」这种自相矛盾的授权，夜里只能按更小的那个数执行。
  // 点名即范围，条数由点名本身决定；自选模式仍保留 1..5 的原口径。
  const max = named && items.length
    ? Math.max(items.length, Math.floor(Number(maxItems) || 0))
    : Math.max(1, Math.min(5, Math.floor(Number(maxItems) || 1)))
  const reposIn = Math.floor(Number(maxRepos) || 0)
  const repos = reposIn > 0 ? Math.min(9, reposIn) : (named ? GUARD_NAMED_DEFAULT_MAX_REPOS : GUARD_DEFAULT_MAX_REPOS)
  const carried = Array.isArray(carryOver) ? carryOver.filter(Boolean) : []
  const ruleMap = rulings && typeof rulings === 'object' && !Array.isArray(rulings) ? rulings : {}
  const now = new Date()
  // 截止默认次日 08:00（晨检时点）；前端传的 datetime-local 无时区，按本机时区解释
  const dl = deadline ? new Date(String(deadline).replace(' ', 'T')) : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0)
  const deadlineIso = isoLocal(isNaN(dl.getTime()) ? new Date(now.getTime() + 8 * 3600_000) : dl)
  const intent = intentOverride ? String(intentOverride) : carried.length
    ? `承接 ${fromRunName || '上一轮'} 没做完的 ${items.join('、')}，我已就下面的卡点表态，按我的话接着做完到 RC_READY，明早我验收。`
    : named
      ? `我点名 ${items.join('、') || '（未填，视为无点名→按自选口径）'} 这几条，起草→开发→QA 做完、验收卡填满为止（不发测），明早我看卡片。`
      : `从飞书「待处理」里自己挑最多 ${max} 条：像产品经理那样想清楚用户到底要什么，查得清的自己查、可以反悔的自己定（亮在验收卡上），只有反悔代价大的才留给我拍；起草→开发→QA 做完、验收卡填满，明早我看卡片。`
  const text = `---
type: guarded-run-contract
version: '${String(version || '').replace(/'/g, '')}'
date: ${todayStr()}
archive: '${String(archiveRel || '').replace(/'/g, '')}'
---

# 守航任务契约（Guarded-Run Contract）· ${c.runName}

> 本文件由看板「🌙 守航开工」入口**自动签发**（引擎 \`issueGuardedContract\`）。字段语义事实源见
> [\`templates/守航任务契约.md\`](../templates/守航任务契约.md)；红线可松/不可松见
> [\`docs/tech/全时双态-Stage0-红线分类.md\`](../docs/tech/全时双态-Stage0-红线分类.md)。
> **铁律**：契约一旦启动，本轮守航期间**员工不得自行扩张**（改 selection/authorization/limits/forbidden 一律无效、且属越权）。
> **但「老板本人当场追加」不是扩张**：他在会话里明确指示做某条不在 \`named_items\` 的条目时，用
> \`amend_contract_scope\`（**必须引他原话**）把它落成授权 —— 追加会写进下面的「四、范围修订记录」，
> 台账记一笔、晨检包单列。限制的对象是**员工的自作主张**，从来不是授权方自己改主意。
> **唯一例外**：菲菲建好任务档案后**回填 frontmatter 的 \`archive\` 与 \`version\` 两个字段**（冷启动时它们签发时未知），其余一字不动。

## 一、本轮意图（老板一句话）

${intent}${note ? `\n\n附加说明（老板原话）：${String(note).trim()}` : ''}

## 二、机器契约（守航行为按此执行 + 次日据此审计）

\`\`\`yaml
mode: guarded_run
run_name: ${c.runName}
starts_at: ${isoLocal(now)}
deadline: ${deadlineIso}                 # 到点安全收束、出晨检交付

selection:
  source: ${named ? 'boss_named' : 'ready_pool_then_triage'}   # boss_named=老板点名；ready_pool_then_triage=**先从「守航就绪池」取**（需求表 守航就绪=就绪 的行，A1 巡航养的），池空才退回读飞书「待处理」全量现 triage
${named ? `  named_items: [${items.join(', ')}]        # 只做资格核验，不得自行扩选\n` : ''}${carried.length ? `  carried_over_from: ${fromRunName || ''}        # 续跑轮：本轮条目承接自该轮未完成项（老板已就卡点表态，见第三章）\n` : ''}  max_items: ${max}
  allowed_risk_class: [low, medium, high]   # 2026-09-30 起 high 也照样做完（开发分支上可以反悔）；上线时不可逆的几步（线上 DDL / 迁移 / 配权限）写成上线步骤留给人
  max_parallel_items: 1                  # ＝跨角色流水重叠上限，非单角色分身（H8）
  max_changed_repositories: ${repos}      # 治的是**自选 triage 时摊子失控**，不是用来否掉老板点名的条目；点名轮默认 ${GUARD_NAMED_DEFAULT_MAX_REPOS}、可由入口显式设定。撞顶时先报「要几个仓、为什么」再 park，别把引擎默认值当成老板的意思（2026-09-18 REQ-0353 就是这么被写死的 2 挡掉的）
  priority_order: [P0, P1, P2]

authorization:                           # 只有列 true 的动作被允许；未列即禁
  create_version: true
  create_task_archive: true              # 冷启动：档案由菲菲自建（本轮起点就是没有档案）
  create_feature_branches: true
  commit_development_branches: true      # 仅开发分支，绝不碰 master/release
  run_automated_tests: true
  integrate_candidate_branch: true
  deploy_test_environment: false         # 发测仍需人；守航停 RC_READY
  deploy_production: false               # 永远 false

limits:
  max_dev_qa_rounds_per_item: 2          # 只约束「同一方案反复重试」；换一条从未试过、能移除已确诊堵点的路不计入（见 preamble 规则 4）
  max_integration_rounds: 2
  max_environment_retries: 2
  max_runtime_minutes: 480
  max_tokens: ${GUARD_DEFAULT_MAX_TOKENS}              # 成本参考顶：引擎**逐轮累计并在超顶时记 guard.violation.over_budget**（不硬杀进程——夜里被杀死比超支更坏）；设 null 则引擎改记一条 budget_unset，让「没设硬顶」这件事在晨检包里可见，而不是留一片空白（方案 E1 点名「max_tokens 四轮全空」）
  stop_new_items_before_deadline_minutes: 60

forbidden:
  - production_release
  - production_ddl
  - permission_model_change
  - destructive_git
  - force_push
  - business_scope_inference             # 不替老板做**反悔代价大**的业务决定（v0.11.0 拆开：查得清的自己查、可以反悔的自己定并亮在验收卡上；只有代价大的 raise_risk 等老板）
  - external_side_effects                # 真实企微/真机/三方副作用（含测试路径！）

failure_policy:
  business_ambiguity: fact_self_check_reversible_decide_costly_raise   # v0.11.0 三种不确定：查得清→自己查；可反悔→自己定（record_decision）；代价大→raise_risk 等老板，**只停那一条**，其余照跑
  repeated_test_failure: quarantine_item
  environment_failure: retry_then_continue_others
  suspected_boundary_violation: stop_action_continue_safe_work
  agent_idle_stall: quarantine_and_queue
  mass_quarantine_or_stall: safe_abort_early_report

exit:
  target: rc_ready                       # 守航终点＝迷糊全量 QA 通过后停 RC_READY（发测/生产都留给人）
  final_state: awaiting_human_acceptance
  produce_acceptance_cards: true         # v0.11.0：老板早上看的是**验收卡**（一个需求一张：做完没 / 长啥样 / 动了哪些老功能 / 要你拍的高危事项），不是长文档
  produce_morning_report: true           # 底稿（机器证据全文）仍由引擎装配，折叠在验收卡「查看底稿」里（E2）：**一版一份、每天覆盖写**，落 tasks/<日期>-<版本>-晨检包.md（轮次包形态已停产，见复盘 §3.108）；morning_report 工具手动出 / deadline 到点结算 / 每日巡检 三条路径共用同一装配器
  settle_at_deadline: true               # E3：到点强制结算——出晨检包 + 版本要么 RC_READY 要么**明确顺延**（顺延项自动进 park 台账，不许无声挂着）
  append_after_rc_ready: requires_resign  # E3：版本已达 RC_READY 后再追加条目 → 必须重签契约（新 run_name）+ 显式回退版本状态；默认「守航产出物独立成版、当晚可发」

goal:                                    # v0.11.0 守航目标循环：链停了、活没干完 → 引擎接着派人，直到做完 / 真卡住 / 到点
  loop: ${loop}                           # active=自动续跑 / shadow=只记不派（影子）/ off=关
  max_goal_turns: ${goalTurns}                     # 最多自动续跑几轮（同样的局面连续 3 次没推进 → 判卡住、停下）
  done_when: acceptance_cards_complete   # 每条要么「做完且验收卡四格齐」，要么「等老板拍高危事项」，要么「试尽后隔离」
\`\`\`

## 三、承接上轮（续跑轮才有；老板已表态的卡点在此，**不必再 park 一遍**）

${carried.length
      ? `> 来源：\`${fromRunName || '上一轮契约'}\` 的守航台账（引擎按 itemResults 机读未达 RC_READY 的条目，非自述）。
> **老板已表态的那一条，就是口径本身**——按原话执行、不自行外推；他没表态的那一条按三种不确定重判（查得清的查、可以反悔的自己定并亮在验收卡上、代价大的才等他）。

| # | 条目 | 上轮卡在哪 | 上轮拟定口径 | 老板本轮表态（摘要，全文见下） |
|---|------|-----------|------------|------------------------------|
${carried.map((it, i) => {
        const r = flat(ruleMap[it.req])
        const brief = r ? (r.length > RULING_EXCERPT ? `${r.slice(0, RULING_EXCERPT)}…（↓全文）` : r) : '**（未表态——按三种不确定重判）**'
        return `| ${i + 1} | ${it.req} | ${oneLine(it.stopWhy) || '—'} | ${oneLine(it.proposal) || '—'} | ${brief} |`
      }).join('\n')}

**老板表态全文（以此为准，表格里是摘要）**

${carried.map(it => {
        const r = String(ruleMap[it.req] || '').trim()
        return `- **${it.req}**：${r || '_（本轮未表态——按三种不确定重判：查得清的查、可以反悔的自己定、代价大的才 raise_risk）_'}`
      }).join('\n')}`
      : '本轮为首发轮，无承接项。'}

## 四、范围修订记录（老板中途追加/移除条目 → \`amend_contract_scope\` 自动追加在此）

> 每行都必须有**老板原话**作为凭据——没有原话的追加＝员工自行扩张＝越权。晨检包会单列这张表，
> 让「本轮范围被改过几次、依据是什么」在早上一眼可见（比"重签一份新契约、旧契约历史就此断掉"更可追溯）。

| # | 时间 | 追加/移除 | 条目 | 老板原话（凭据） | 已知晓顺延代价 | 执行人 |
|---|------|----------|------|----------------|--------------|-------|
|  |  |  |  |  |  |  |

## 五、本轮候选（菲菲选定后逐条回填，供老板晨检过目）

| # | 条目 | 优先级 | risk_class | 影响仓库 | 影响入口（≥2 即需横向 facet） | 用户到底要什么（一句话） | 替老板定了什么（record_decision 编号） |
|---|------|--------|-----------|---------|---------------------------|--------------|----------------------|
|  |  |  |  |  |  |  |  |

## 六、要老板拍的高危事项（只收反悔代价大的：raise_risk 登记，验收卡上一键选路）

> v0.11.0：可以反悔的事不再 park——自己定、record_decision 记下，老板在验收卡上追认或改掉。
> 只有「做错了没法一小时内改回去」的才进这里；守航态 \`park_item\` 也会自动落成一件高危事项。

> 用 \`park_item\` 工具登记（跨轮累积）：**同一条 park ≥2 轮自动进晨检「必答区」**。
> 拟定口径是**必填**——没有它，老板没法一句话推动（REQ-0304/0309 连续 park 3 轮、每轮重写一样的建议，就是这么烂在队里的）。

| # | 条目 | 卡在哪（哪条拷问 open） | 菲菲拟定口径（老板不拍时的默认执行值） | 已 park 轮次 |
|---|------|----------------------|--------------------------------------|-------------|
|  |  |  |  |  |
`
  if (!dryRun) atomicWrite(c.abs, text)
  return { ...c, deadlineIso, max, repos, named, items, carried, rulings: ruleMap, fromRunName: fromRunName || '', text }
}
// 冷启动派工指令（引擎单一事实源：前端只传字段，不各写一份 prompt）
function guardedColdStartInstruction({ contract, source, picks, maxItems, deadline, note } = {}) {
  // v0.11.0 重写（老板 2026-09-29：「菲菲挑需求太过谨慎，挑无可挑」——自选的 4 轮守航 0 条开工、每轮 park 6~8 条）。
  // 旧口径是「只挑可证明零业务待决的」，于是只剩"照抄已有功能"这类不用动脑的活。新口径：像产品经理那样把需求想透，
  // 三种不确定分开处理——查得清的查、可以反悔的自己定并亮在验收卡上、只有反悔代价大的才等老板。
  const named = source === 'named'
  const items = (Array.isArray(picks) ? picks : String(picks || '').split(/[,，\s]+/)).map(s => String(s).trim()).filter(Boolean)
  return `【守航冷启动】本轮**没有任务档案、从 0 开始，你是起点**（不是接棒，也没有现成卡片）。你是这一轮的**产品经理**：老板不在，你替他把需求想清楚、把能定的定下来、把活推到做完。
【契约】\`${contract.rel}\`——先读它（机器 yaml 块为准）。**只许回填 frontmatter 的 archive / version 两个字段**，其余一字不动。
【挑哪些】${named
      ? `老板点名：${items.join('、') || '（未填→按自选口径）'}。点名即范围，**不得自行扩选**；每条都按下面的五步想透再动手。`
      : `你自己挑，最多 ${contract.max} 条：
　· 先 pool_scan 看全表排序（它按紧急度 × 期望时间 × park 轮次排好了），再对排在前面的逐条 lark_get_requirement **读全文**（列表是摘要，别拿摘要下结论）；
　· **不再只挑「零歧义」的**——一条需求里有不确定，只要都是①查得清的或②可以反悔的，它就能做；核心问题是③反悔代价大的，登记 raise_risk 后按你推荐的路先做下去；**risk_class=high 的照样挑、照样做完**（只把上线时不可逆的几步留给人）——老板签契约就是要把重要的做了，别只挑简单的；
　· 按「对用户价值 × 紧急度 × 能不能在截止前做完」排，挑够就停。**挑完一定调 selection_done**（挑了哪些、没挑的各属于哪类）——不调，目标循环会一直派你回来继续挑。`}

${acceptanceCard.PM_FIVE_STEPS}

${acceptanceCard.UNCERTAINTY_RULES}

【查同源语料，别从零推断】判口径前先在已有语料里找它的前例：docs/示例项目需求/** 按 REQ 编号与关键词 grep 历次需求说明/确认文档/实施记录 + 业务知识库——**已定过的口径直接沿用并注明来源**（record_decision kind=fact）。看到「附件·引擎读不到图内容」＝界面细节在图里、你够不到：能从代码与历史需求推出来的按②自己定，推不出来且影响大的按③登记。
【本轮上限】最多 ${contract.max} 条 · 截止 ${contract.deadlineIso}（收工前 60 分钟不再领新条目）。
【产出顺序（缺一步不算完工）】
① 候选底账：待处理 N 条 / 本轮挑 M 条，每条一句「用户到底要什么」+ 你的方案选择；
② 《需求说明与验收标准》（templates/pm-需求说明与验收标准.md）：facet 表带稳定 ID，边界/异常各成行；**按用户真正要的写，不是按最容易自证的写**（窄口径声明照写：本次只做 X / 提出人可能还期待 Y / 若要 Y 的工作量）；
②b 改动落在被复用组件上的，跑 cross_entry_facets 生成跨入口一致性 facet；
③ 建任务档案（templates/task-archive.md）：条目登记表 + 时间线，档案是本轮唯一状态源；
④ 回填契约的 archive 与 version；
⑤ 你替老板定的每一件事都 record_decision；真正的③类 raise_risk（只停那一条）；
⑥ 【下一棒】GG Bond（整链自动继承守航）。
【终点】开发 → 迷糊全量 QA 通过 → **验收卡四格填满**（GG Bond 写一句话说明 + 申报碰到的老功能；迷糊挂截图 + 逐条重跑验证）→ 停 RC_READY 等老板早上看卡片。**不发测、不发布生产**。
【链停了不等于结束】每一棒收工后引擎的目标循环会判「这一轮干完没」，没干完会自动派人接着做——所以别在半路写一句问句就收工，那只会被派回来。${note ? `\n【老板附加说明】${String(note).trim()}` : ''}`
}
// 「守航推进」开工指令（从任意档案发起；默认菲菲当这个需求的负责人）。与冷启动同理住在引擎，前端只传字段。
function guardedArchiveInstruction({ contract, archiveRel, version, items = [], starter = 'feifei', note = '' } = {}) {
  const list = items.map(i => `- **${i.req}** ${i.name ? `${i.name} ` : ''}——看板现在：「${i.status || '（没写）'}」`).join('\n')
  const boss = note ? `\n【老板的话（原话即口径）】${note}\n` : ''
  const tail = `【终点】每条都「测试通过 + 验收卡四格填满」（一句话说明 / 截图或无界面理由 / 碰到的老功能逐条重跑验过），停 RC_READY 等老板看卡片；**不发测、不发布生产**。
【链停了不等于结束】每一棒收工后目标循环会判「干完没」，没干完引擎会按「谁该做」接着派——所以做完你这一棒就用【下一棒】交给下一位，别在半路写一句问句收工。

${acceptanceCard.UNCERTAINTY_RULES}`
  if (starter === 'feifei') {
    return `【守航推进 · 你是这个需求的负责人】老板把 \`${archiveRel}\`${version ? `（${version}）` : ''} 里下面这几条交给你**全权推进到落地**。契约 \`${contract.rel}\` 已签好、只授权这几条，**不必再签、不得扩选**。
${list}
${boss}
【先盘点，再动手（别跳）】
1. 逐条摸清现状：读任务档案（登记表 / 时间线 / 待确认事项）、覆盖矩阵（\`coverage_status\`）、验收卡（\`goal_status\`）、派工头里的【同事近况】——写出一张表：**这条现在在哪一步 / 卡在谁 / 还差什么才算做完**。需要问同事的用 \`cc_colleague\` 同步（别用 Task/Agent 替他干）。
2. 按现状决定第一棒：需求还有缺口 → 你先补（五步想透 + 三种不确定）；代码没写完 → 交 GG Bond；**只差测试 → 直接交迷糊**；只差验收卡 → 交缺那一格的主人。一次交一位，把「做什么、做到哪算完」写清楚。
3. 你替老板定的每件事 \`record_decision\`，真正反悔代价大的 \`raise_risk\`（只停那一条）。
${tail}`
  }
  const who = EMPLOYEES[starter]?.displayName || starter
  return `【守航推进 · 从你开工】老板把 \`${archiveRel}\`${version ? `（${version}）` : ''} 里下面这几条交给守航**全权推进到落地**，指定**从你（${who}）这一棒开工**。契约 \`${contract.rel}\` 已签好、只授权这几条，不得扩选。
${list}
${boss}
【先看现状再干你这份】读任务档案登记表与时间线、\`goal_status\` 看每条差什么，然后做**你职责内**的那部分。职责外的（需求口径要补 → 菲菲；代码要改 → GG Bond；测试 → 迷糊）做完你这份就用【下一棒】交给对应的人，并写清交接内容；不确定该交谁就交菲菲，她是这个需求的负责人。
${tail}`
}

// ---------- 守航「未完待续」：一轮里没做完的条目是机器事实，不该只活在 park 台账的纸面上 ----------
// 缘起（2026-09-18 guarded-01）：老板点名三条，走完只有 REQ-0342 到 RC_READY，0352/0353 park。
// 台账 `itemResults` 明明逐条记着「谁 parked、卡在哪、拟定口径是什么」，但这份事实**没有任何出口**：
//   · 老板在会话里回一句「继续」——那是 chat 路径，连守航提醒都不注入（只 dispatch 分支有），
//     菲菲收到的就是光秃秃两个字，没有「还剩哪两条」；
//   · 想另起一轮只能手工再点一次「守航开工」重敲编号，还会撞上 `append_after_rc_ready: requires_resign`。
// 于是「park 了等老板拍」变成单向的：park 得进去，拍完出不来。这里把出口补上。
// 最近一份守航契约（文件名按 日期+序号，lexicographic 排序即时间序）
function latestGuardedContractRel() {
  try {
    const files = fs.readdirSync(TASKS_DIR).filter(f => /守航契约-guarded-\d+\.md$/.test(f)).sort()
    if (!files.length) return null
    return `${OFFICE_URI_PREFIX}/tasks/${files[files.length - 1]}`
  } catch { return null }
}
// 某轮守航的「做完了 / 没做完」实况。数据源全是机器事实：ledger.itemResults（工具在动作当下记的）
// + park 台账（跨轮轮次与老板表态）。找不到台账时返回 items:[] 而不是抛错——调用方要能如实说「查不到」。
function guardPendingItems(runNameOrRel) {
  const rel = runNameOrRel && /守航契约/.test(String(runNameOrRel)) ? String(runNameOrRel) : null
  let entry = rel ? loadGuardContract(rel) : null
  if (!entry && runNameOrRel && !rel) {
    // 传的是 run_name：按 tasks/<run_name 里的日期>-守航契约-<序号>.md 反推
    const m = String(runNameOrRel).match(/^(\d{4}-\d{2}-\d{2})-guarded-(\d+)$/)
    if (m) entry = loadGuardContract(`${OFFICE_URI_PREFIX}/tasks/${m[1]}-守航契约-guarded-${m[2]}.md`)
  }
  if (!entry) entry = loadGuardContract(latestGuardedContractRel())
  if (!entry) return { runName: '', contractRel: '', version: '', archive: '', items: [], done: [], why: '找不到任何守航契约（tasks/ 下没有 *-守航契约-guarded-NN.md）' }
  const led = guardLedgerFor(entry.runName)
  const park = loadParkLedger()
  const parkOf = req => park.find(e => String(e.req).toUpperCase() === String(req).toUpperCase()) || null
  const named = (entry.contract?.selection?.named_items || []).map(s => String(s).toUpperCase().trim()).filter(Boolean)
  const results = led?.itemResults || {}
  // 点名条目是老板给的范围：**即使台账里一笔都没记，它也算没做完**（一条都没碰过恰恰是最该被看见的形态）
  const keys = Array.from(new Set([...Object.keys(results), ...named]))
  const items = [], done = []
  for (const req of keys) {
    const r = results[req] || { req, result: '' }
    const pk = parkOf(req)
    const row = {
      req,
      result: r.result || (named.includes(req) ? 'untouched' : ''),
      stopWhy: r.stopWhy || pk?.reason || '',
      proposal: r.proposal || pk?.proposal || '',
      probeKey: r.probeKey || pk?.probeKey || '',
      parkRounds: Number(pk?.rounds || 0),
      ruling: pk?.ruling || '',
      boardStatus: r.boardStatus || '',
    }
    if (r.result === 'rc_ready') done.push(row); else items.push(row)
  }
  return {
    runName: entry.runName, contractRel: entry.rel,
    version: String(entry.fm?.version || ''), archive: String(entry.fm?.archive || ''),
    namedItems: named, items, done,
    why: items.length ? '' : '上一轮点名/接手的条目都已达 RC_READY，没有待承接项',
  }
}
// 守航态会话续跑时的提醒（老板拍板/追问后那一轮）：run.executionMode 本身不会丢，
// 但那一轮 prompt 原先不带任何守航痕迹 → 长会话/冷 resume 后语气容易漂回共驾（"老板在线，问一句吧"）。
// 2026-09-18 起它**带本轮实况**：老板说「继续」时，光有语气提醒没用——得直接告诉她还剩哪几条、
// 卡在哪、她自己写的拟定口径是什么，否则那句「继续」落到一个不记得自己 park 过什么的会话上。
function guardedResumeNote(run, { chatOnlyIfPending = false } = {}) {
  let live = ''
  try {
    const c = guardContractFor(run)
    const st = c ? guardPendingItems(c.rel) : null
    // 纯聊天路径只在「确实还有没做完的条目」时才注入——否则每问一句话都顶一屏契约提醒，
    // 噪声会把它训练成可忽略的样板（这个体系已经栽过一次：规定都在，一调就降级）。
    if (chatOnlyIfPending && !(st && st.items.length)) return ''
    if (st && (st.items.length || st.done.length)) {
      const fmt = it => `  · **${it.req}**（${it.result === 'parked' ? 'park' : it.result === 'untouched' ? '一次都没碰' : it.result || '在途'}${it.parkRounds ? ` · 第 ${it.parkRounds} 轮` : ''}）卡点：${oneLine(it.stopWhy) || '（台账没记原因——这本身是要交代的事）'}\n    你的拟定口径：${oneLine(it.proposal) || '（空——没有它老板没法一句话推动）'}`
      live = `\n【本轮实况（引擎从守航台账机读，非你自述）】契约 \`${st.runName}\`${st.version ? ` · ${st.version}` : ''}\n- 已达 RC_READY：${st.done.length ? st.done.map(d => d.req).join('、') : '（无）'}\n- **未完成 ${st.items.length} 条**：\n${st.items.map(fmt).join('\n') || '  （无）'}\n`
    }
  } catch { }
  return `【守航态续跑】本会话仍是守航态：老板刚给的口径**按其原话执行、不自行外推**；其余不确定项按三种不确定处理（查得清的查、可以反悔的自己定并 record_decision、反悔代价大的 raise_risk 只停那一条）；单条失败不连坐整批；终点仍是迷糊全量 QA 通过 + 验收卡四格填满后停 RC_READY，**不发测、不发布生产**。本轮守航契约见 \`tasks/\` 下同批签发的「守航契约」文件。${live}【老板这句话怎么读】① 他明确拍了某条的口径 → 那条**解冻，按原话做完**，不必再 park、不必再问一遍；② 他说的是「继续 / 按你的默认来 / 你看着办」这类**放行语** → 视为**批准你在 park 台账里写的「拟定口径」**（那一列的定义就是"老板不拍时的默认执行值"），据此解冻并推进，别把放行当成又一次追问；③ 他只是在问原因、没给方向 → 如实答，然后**主动给出他一句话就能拍的选项**，别就地收工。
【别拿引擎默认值当老板的意思】"超 \`max_changed_repositories\`/超 \`max_items\`" 这类**契约数值**不是业务口径，是可调参数：撞顶时先如实说「这条要几个仓、为什么」，老板放行即可续；**不许把它写成条目做不了的结论**。同理「依赖 X 先落地」——X 已达 RC_READY、分支已冻结可依赖的，这条依赖就**不再成立**（除非老板明说要等它真上线）。
【已达 RC_READY 的版本别硬塞】承接项默认**独立成新版本**，不往已 RC_READY 的版本追加（契约 \`append_after_rc_ready: requires_resign\`）。要在新契约下做整轮，走看板「守航续跑」入口重签，别在这一轮里硬追加。

`
}
// 续跑轮的冷启动指令（/api/guarded/resume）：与 guardedColdStartInstruction 同一条理由住在引擎——
// prompt 是行为契约的一部分，散到前端就会出现「同一件事两处措辞」。
function guardedResumeInstruction({ contract, pending, rulings = {}, note } = {}) {
  const rows = (contract.carried || []).map((it, i) => {
    const r = String(rulings[it.req] || '').trim()   // ★ 表态**整段原文照给，绝不截断**（见 oneLine 处注释）
    return `${i + 1}. **${it.req}**${it.parkRounds ? `（已 park ${it.parkRounds} 轮）` : ''}
   - 上轮卡在：${oneLine(it.stopWhy) || '（台账未记）'}
   - 你上轮的拟定口径：${oneLine(it.proposal) || '（空）'}
   - **老板本轮表态**：${r || '**未表态** → 先按三种不确定重判：卡点若是查得清/可以反悔的，自己定（record_decision）并照做；真是反悔代价大的才 raise_risk，别重抄上轮原文'}`
  })
  return `【守航续跑】本轮**承接 \`${contract.fromRunName || '上一轮'}\` 没做完的条目**，不是从 0 挑需求。
【契约】\`${contract.rel}\`——先读它（机器 yaml 块为准；第三章「承接上轮」就是本轮的活）。**只许回填 frontmatter 的 archive / version 两个字段**。
【本契约即重签】上一轮若已有版本达 RC_READY，\`append_after_rc_ready: requires_resign\` 要的就是这份新契约（新 run_name \`${contract.runName}\`）。承接项**默认独立成新版本**（别往已 RC_READY 的旧版追加），除非老板本轮明说要并版。
【本轮承接条目（${(contract.carried || []).length} 条）】
${rows.join('\n') || '（引擎没从台账取到承接项——如实报出来，别自己另挑需求填空）'}
【读老板的表态】表态即口径：**按原话执行、不自行外推**，也**不必再确认一遍**（他已经拍过了，再问一次就是空停）。表态若是「继续 / 按你的默认来」这类放行语 → 等于**批准你台账里那条拟定口径**，据此直接开工。
【上轮的 park 理由要重新验一遍，别照抄】尤其这三类：
- **契约数值类**（超 \`max_changed_repositories\` / \`max_items\`）——本轮契约已按老板意思调过，先看新值再判；仍不够就**如实说要几个仓**，不许直接判条目做不了。
- **依赖类**（"等 X 先落地"）——X 已达 RC_READY 且分支已冻结可依赖的，依赖**不成立**；要等真上线的，说清为什么。
- **口径类**——老板本轮表态了就解冻；没表态的才继续 park。
【产出顺序（缺一步不算完工）】① 逐条复核上面的 park 理由是否仍成立（**结论要写出来**，成立/不成立各给依据）；② 仍成立的 park，不成立的立刻进《需求说明与验收标准》（facet 带稳定 ID + 窄口径三段声明）；③ 建/复用任务档案 + 条目登记表；④ 回填契约 \`archive\`/\`version\`；⑤ 零歧义 → 【下一棒】GG Bond（整链自动继承守航）。
【终点】迷糊全量 QA 通过后停 RC_READY 待晨检；**不发测、不发布生产**。
【收尾】① 真是③类的 raise_risk（拟定方案 + 可选路径必填）；② goal_status 自查这一轮还差什么、guard_status 自查三红灯；③ 验收卡四格要齐（acceptance_card）——老板早上只看卡片。${note ? `\n【老板附加说明】${String(note).trim()}` : ''}`
}

// ---------- 聊天窗快捷动作（前端按钮 → 引擎给指令）----------
// 缘起（2026-08-26 老板提）：A1 需求巡航按拍板定为「只给工具、不自动触发」，但触发口一直没有——
// 老板得自己打一段「去跑一轮需求巡航」的话，每次措辞还不一样，等于把 SOP 的执行质量押在临场打字上。
// 一个按钮解决：点一次 = 发一段**引擎写好的**完整指令。
//
// ⚠ 指令文本**必须住在引擎**，不能写进前端组件。这条与 `guardedColdStartInstruction` 同一条理由：
//   prompt 是行为契约的一部分，散到前端就会出现「同一件事两处措辞、改了一处忘另一处」。
//   前端只拿 {id,label,title}，点了把 instruction 原样发出去。
// ⚠ 也不做成「后端直接建 run」：那样会绕开聊天窗已有的并发闸 409 降级（正忙 → 提示开只读窗）、
//   草稿建 run、附件与聊天记录拼接等一整套动线。让前端复用它自己的 send() 才不会分叉。
const QUICK_ACTIONS = {
  feifei: [
    {
      id: 'pool-scan',
      label: '需求巡航',
      title: '跑一轮需求巡航：读全表 → 排序 → 逐条过七项拷问 → 回写就绪缺口 → 产问老板的问题卡（≤3 张）',
      instruction: `【需求巡航 · A1】跑一轮把就绪池养肥的巡航。这是白天的活，**不是守航**——终点是「池子里多几条可证明零歧义的就绪条目 + 给我一叠能一句话拍板的问题卡」，不是产出代码。

【顺序，别跳】
① \`pool_scan\` 先看池子长什么样（它按「就绪度 × 紧急度 × 期望时间 × park 轮次」排好序，还会告诉你候选够不够）。**表里没有 \`守航就绪\` 列的话它会提示——那就先 \`pool_fields_check\` 看缺哪几列、用 \`lark_manage_field\` 建上**（单选/多选的选项要你去飞书补，引擎建不了）。
② 对排序表**前几条里还没就绪的**逐条处理，一条一条来，别批量猜：
　· 先 \`lark_get_requirement <编号>\` **读全文**（列表给的是摘要，SOP §① 1b/1c 硬要求：别拿摘要下结论，更别用 grep 前端代码反推业务要什么）；
　· 判「口径模糊」之前先查同源语料库（\`docs/示例项目需求/**\` 按 REQ 编号与关键词 grep 历次需求说明/确认文档/实施记录 + 业务知识库）——**语料库里已定过的口径直接沿用并注明来源，那不算替我拍板**；
　· 然后 \`readiness_probe\` 过七项拷问 + 三条硬前置，拿机器判定。
③ 把 \`readiness_probe\` 给的 open 项用 \`lark_update_requirement\` 回写到「就绪缺口」列（多选），顺带把能定的 \`risk_class\` 也填上。**判成就绪的才置 \`守航就绪=就绪\`——没到标准不许置，这条是守航资格的唯一入口。**
④ 改动落在被 ≥2 入口复用的组件上的，跑 \`cross_entry_facets\` 生成跨入口一致性 facet（那是「部位顺序四入口三套序」那个逃逸缺陷的解药）。
⑤ 真需要我拍板的，\`park_item\` 登记进台账（**拟定口径必填**——没有它我没法一句话推动；同一条 ≥2 轮会自动进晨检必答区）。

【给我的产出】
- **问题卡最多 3 张**，每张写清「拟定默认 + 利弊 + 不拍会怎样」。多于 3 张就按优先级砍，剩下的留下一轮——一次问太多我一个都答不好。
- 一句话汇报：池子里现在有几条就绪、本轮新增几条、还差哪些。
- **池子是空的 / 一条都没养成也照实说**，并说清为什么（表里没那几列？全部待澄清？），**绝不硬拉需求凑数**。

【边界】本轮只读+回写需求表与 facet，**不建任务档案、不交棒、不开发**。窄口径声明写不出「提出人原话可能还期待 Y」那一段，就说明原话没读透——回去读全文，别硬凑。`,
    },
  ],
}

// ============================================================================
// 守航台账层（E1 的执行侧）：契约 ↔ run 绑定、三红灯计数、落盘、跨重启复原
//
// 为什么台账按 run_name 而不按 run.id 聚合：一轮守航是**整条交接链**（菲菲→GG Bond→迷糊→波比），
// 契约约束的是这一整轮，不是某一条会话。所以 ledger 的主键是契约的 run_name，链上每条 run 都往
// 同一本账里记——否则「本轮越权几次」永远只能看到最后一棒那一条会话的局部。
//
// 为什么在 **stream 的 tool_use 块**上观测、而不在 canUseTool 上：员工多为 bypassPermissions，
// SDK 在咨询 canUseTool 之前就自动放行了（回调是死代码）。观测流里的 tool_use 才是唯一能覆盖所有
// 权限模式的位置。**注意：这里只计数、不拦截**——拦不拦由门禁矩阵与既有 DANGER_DENY 决定
// （2026-08-15 撤销的是「一刀切拦截」，本模块刻意不复活它）。
// ============================================================================
// 本轮页面巡检的机器足迹（runId → {shots, findings, confirmed, suspects}）。
// 为什么要记：巡检本身是「跑一次就有、不跑就没有」的动作，而 SOP 靠自觉——这个体系已经栽过三次
// （§3.95 机械纪律做成工具契约、§3.103 软门禁建在已完成工作量上、§3.118 规定都在但一调就降级）。
// 记下来，`qa_report_card` 收工自检才能如实说「本轮一次巡检都没跑」而不是默认沉默。
// 进程内、不落库：它只服务本轮收工自检，重启后按「未跑」处理（fail-closed，宁可多提醒一次）。
const pageScanFootprint = new Map()
// C3.9（2026-09-10）：足迹里除计数外还挂两张台账 —— `accepted`（key→发现本体）与 `disposed`（key→出口记录）。
// 计数能说「跑了几轮」，但说不出「哪一条没人接」；而实账里丢的正是后者（Invalid date 报了两次、
// 页头「未登录」推给"晨检编排"后失踪）。故收工门要按 key 逐条点名，判据见 qa-report-card.js `findingExitGate`。
function scanFootprintOf(runId) {
  const f = pageScanFootprint.get(runId) || { shots: 0, findings: 0, confirmed: 0, suspects: 0, verdicts: 0 }
  if (!(f.accepted instanceof Map)) f.accepted = new Map()
  if (!(f.disposed instanceof Map)) f.disposed = new Map()
  pageScanFootprint.set(runId, f)
  return f
}
// 本轮视觉验收的机器足迹（runId → {attempts, withMaterial, attachedNoMaterial, itemCount, sessions[], materialSessions[]}）。
// 同上一条的动机，堵的是另一个洞（§3.132）：收工写「这几条前端视觉 facet 需真人视觉终验、真人工项」，
// 而这一轮 `visual_acceptance` / `design_conformance` / `aesthetic_review` 一次都没调 —— 声明没有成本，
// 于是它成了比【等你拍板】更隐蔽的免检符（那条至少还会被 markQaHollowStop 算覆盖率）。
// 记足迹是为了让「说只能人眼看」这句话**必须附带机器走到哪一步**，判据见 qa-report-card.js `visualFinalityGate`。
const visualFootprint = new Map()
function noteVisualAttempt(runId, { sessionId = '', items = 0, attachedNoMaterial = 0 } = {}) {
  if (!runId) return
  const f = visualFootprint.get(runId) || { attempts: 0, withMaterial: 0, attachedNoMaterial: 0, itemCount: 0, sessions: [], materialSessions: [] }
  f.attempts += 1
  f.itemCount += Number(items || 0)
  f.attachedNoMaterial += Number(attachedNoMaterial || 0)
  if (sessionId && !f.sessions.includes(sessionId)) f.sessions.push(sessionId)
  if (items > 0) { f.withMaterial += 1; if (sessionId && !f.materialSessions.includes(sessionId)) f.materialSessions.push(sessionId) }
  visualFootprint.set(runId, f)
}
// 看图门（2026-10-06）：本轮工具流里真被 Read 过的图片（runId → Set<归一化路径>）。
// 「你必须真的去看那些图」以前只是一句提示——实账七次审美判定列了 12 张图只看 1~4 张就判「符合」。
// 记账点在 SDK 消息流（与守航红灯记账同一处），所有权限模式都覆盖得到；子 agent 读的图也算（看了就是看了）。
const imageReads = new Map()
function noteImageRead(runId, input) {
  const p = input && (input.file_path || input.path)
  if (!runId || !p || !prescreen.isImagePath(p)) return
  const s = imageReads.get(runId) || new Set()
  s.add(prescreen.normShotPath(p))
  imageReads.set(runId, s)
}
// aesthetic_review 发出去的素材清单（runId → sessionId → {shots, refs}），aesthetic_verdict 拿它核「看够了没有」。
const aestheticListed = new Map()
const guardLedgers = new Map()      // run_name → ledger（内存热态）
const guardContracts = new Map()    // run_name → { contract, rel, mtimeMs }

function ensureGuardDir() { try { fs.mkdirSync(GUARD_DIR, { recursive: true }) } catch {} }
const guardLedgerPath = runName => path.join(GUARD_DIR, `ledger-${String(runName).replace(/[^\w.-]+/g, '_')}.json`)

// 读契约（带 mtime 缓存）。**必须缓存**：`observeGuardToolCall` 在每一次 tool_use 上调它，
// 一轮守航有几百上千次工具调用——不缓存就是每次 statSync + readFileSync + 全文 parse，
// 直接把「记账」变成 I/O 热点（引入这条时就踩了一版，实测把 tool 流拖成可感知的卡顿）。
// 仍按 mtime 校验：契约文件在一轮里会被菲菲回填 archive/version 两个字段，改了要立刻生效。
const _contractByRel = new Map()   // rel → { contract, rel, runName, mtimeMs }
function loadGuardContract(rel) {
  if (!rel) return null
  let abs
  try { abs = safeResolve(rel) } catch { return null }
  let st
  try { st = fs.statSync(abs) } catch { return null }   // 不存在/读不到 → null（比 existsSync + statSync 少一次系统调用）
  const hit = _contractByRel.get(rel)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit
  const raw = fs.readFileSync(abs, 'utf8')
  const contract = guardLedger.parseContract(raw)
  const runName = String(contract.run_name || path.basename(abs, '.md'))
  // 契约 frontmatter 的 archive / version 是**菲菲建档后回填的唯一机器可读出口**（冷启动签发时它们未知）。
  // 守航链上的 run 全部 `taskFile=null`（冷启动时还没有档案，后续接棒也没人回填），所以晨检包要拿到
  // 覆盖矩阵/版本号，只能从这里取——2026-08-28 两份空包的 `version: ''` / `archive: ''` 就是漏了这一步。
  const fm = parseFrontmatter(raw) || {}
  const entry = { contract, rel, runName, mtimeMs: st.mtimeMs, fm }
  _contractByRel.set(rel, entry)
  guardContracts.set(runName, entry)
  return entry
}
// 一条 run 属于哪轮守航：优先 run.guardContract（冷启动写入 + 沿交接链继承），
// 退化到「任务档案同级最新的守航契约」（老板在派工弹窗直接勾守航、没走冷启动入口的形态）。
//
// ⚠ **fallback 认领必须看 deadline**（2026-09-20 实账）：老板在 v5.23 卡片上勾守航态派工、只说
//   「推进需求落地」，引擎把这条 09-20 的 run 静默绑到了 **09-18 签的 guarded-02**——那份契约
//   deadline 是 09-19 08:00（已过期 35 小时）、`named_items` 只有 [REQ-0352, REQ-0353]（都早已 rc_ready）。
//   三重后果：① 老板新加的 REQ-0359/0366 **一开始就不在授权里**，这一轮在授权面上「无事可做」，
//   于是他要的「推进需求落地」一件没干成，而他是在收工汇报里才第一次知道；② 本轮消耗记进旧轮台账
//   （runtime 2714min/顶480、token 5.64M/顶2M），新旧两轮的账混成一本，红灯彻底失去意义；
//   ③ 一份**过了期的**契约还在当有效授权用，而契约自己写着 `settle_at_deadline: true`。
//   改法：过期契约**不认领**（返回 null=本轮无契约治理，不绑账、不污染旧台账），并在 run 上打标记
//   让 dispatch 侧发一条醒目的 lab 事件——让「这一轮到底受哪份契约管、还是根本没有」在**开工那一刻**
//   就可见。刻意**不自动签发新契约**：签契约是老板划范围的动作（named_items / 预算 / 授权矩阵），
//   引擎替他签就是又一次「默认值代替人做决定」（§22.1 同族）。
function guardContractFor(run) {
  if (!run || run.executionMode !== 'guarded_run') return null
  if (run.guardContract) { const c = loadGuardContract(run.guardContract); if (c) return c }
  try {
    const files = fs.readdirSync(TASKS_DIR).filter(f => /守航契约-guarded-\d+\.md$/.test(f)).sort()
    if (!files.length) return null
    const rel = `${OFFICE_URI_PREFIX}/tasks/${files[files.length - 1]}`
    const c = loadGuardContract(rel)
    if (!c) return null
    const dl = Date.parse(String(c.contract?.deadline || ''))
    const startedAt = Date.parse(run.startedAt || '') || Date.now()
    // v0.11.0：契约绑的是别的任务档案 → 不认领（§22.8 同族：老板在 A 档案上勾守航，被静默绑到管 B 档案的契约上，
    // 他的条目一开始就不在授权里）。契约没写 archive（冷启动轮，档案还没建）时维持原口径。
    const norm = x => (stripOfficePrefix(String(x || '').replace(/\\/g, '/')) || String(x || '').replace(/\\/g, '/')).replace(/^\.?\//, '')
    const cArchive = String(c.fm?.archive || '').trim()
    if (run.taskFile && cArchive && norm(cArchive) !== norm(run.taskFile)) {
      if (!run._guardNoContract) run._guardNoContract = { rel, runName: c.runName, deadline: c.contract.deadline, named: c.contract?.selection?.named_items || [], otherArchive: cArchive }
      return null
    }
    if (Number.isFinite(dl) && dl < startedAt) {
      // 过期契约只记一次「本轮无有效契约」，不认领、不再重复扫目录（下次直接命中这个标记）
      if (!run._guardNoContract) {
        run._guardNoContract = { rel, runName: c.runName, deadline: c.contract.deadline, named: c.contract?.selection?.named_items || [] }
      }
      return null
    }
    run.guardContract = rel; return c   // 认领一次，后续不再扫目录
  } catch {}
  return null
}
function guardLedgerFor(runName) {
  if (!runName) return null
  if (guardLedgers.has(runName)) return guardLedgers.get(runName)
  let led = null
  try { led = JSON.parse(fs.readFileSync(guardLedgerPath(runName), 'utf8')) } catch {}
  if (!led || typeof led !== 'object') led = guardLedger.emptyLedger(runName)
  if (!led.toolCalls) led.toolCalls = { read: 0, write: 0, external: 0 }
  if (!led.usage) led.usage = { devQaRoundsByItem: {}, integrationRounds: 0, envRetries: 0, changedRepositories: [], runtimeMinutes: 0, tokens: 0, itemsTaken: 0 }
  if (!led.usage.devQaRoundsByItem) led.usage.devQaRoundsByItem = {}
  if (!led.snapshots) led.snapshots = {}
  if (!led.itemResults) led.itemResults = {}
  if (!led.gateDecisions) led.gateDecisions = {}
  guardLedgers.set(runName, led)
  return led
}
// 条目账记一笔（工具侧的统一入口）。**在动作发生的当下记**，不在事后问 agent —— 晨检包第二章的事实源。
function guardRecordItem(run, req, patch = {}) {
  const c = guardContractFor(run)
  if (!c || !req) return null
  const led = guardLedgerFor(c.runName)
  if (!led) return null
  const r = guardLedger.recordItemResult(led, req, { employee: run.employee, ...patch })
  if (r) saveGuardLedger(c.runName)
  return r
}
// 夜间空停累计（晨检包摘要那一行此前恒为「—」）：巡逻扫到守航 run 空停即累加，机器事实、不问 agent。
function guardNoteIdleStop(run, minutes) {
  const c = guardContractFor(run)
  if (!c) return
  const led = guardLedgerFor(c.runName)
  if (!led) return
  led.usage.idleStopMinutes = Math.round((led.usage.idleStopMinutes || 0) + Math.max(0, Number(minutes) || 0))
  led.usage.idleStops = (led.usage.idleStops || 0) + 1
  saveGuardLedger(c.runName)
}
let _guardSaveTimer = null
function saveGuardLedger(runName) {
  if (!runName) return
  clearTimeout(_guardSaveTimer)
  _guardSaveTimer = setTimeout(() => {
    ensureGuardDir()
    for (const [name, led] of guardLedgers) {
      try { fs.writeFileSync(guardLedgerPath(name), JSON.stringify(led, null, 1)) } catch (e) { console.warn('[guard] 台账落盘失败:', e.message) }
    }
  }, 1500)
}

// 观测一次工具调用（consumeStream 里对每个 tool_use 块调一次）。只读动作零成本快速返回。
function observeGuardToolCall(run, toolName, toolInput) {
  const c = guardContractFor(run)
  if (!c) return
  const verdict = guardLedger.judgeToolCall(c.contract, toolName, toolInput || {})
  if (verdict.verdict === 'pass' && verdict.kind === 'read') {
    const led = guardLedgerFor(c.runName)
    if (led) { led.toolCalls.read = (led.toolCalls.read || 0) + 1; saveGuardLedger(c.runName) }
    return
  }
  const led = guardLedgerFor(c.runName)
  if (!led) return
  guardLedger.recordToolCall(led, { employee: run.employee, tool: toolName, ...verdict })
  if (verdict.verdict === 'forbidden') {
    // 红灯亮了要**当场可见**（老板半夜不看日志，但看板会亮）。不拦，只如实广播 + 落时间线。
    appendEvent(run.id, { type: 'lab', text: `🚨 守航契约越界记账：\`${toolName}\` —— ${verdict.why}（红灯 guard.violation.forbidden_action 现为 ${led.forbidden.length}）。本条**不拦**（拦截层已于 2026-08-15 因误杀只读 MCP 撤销），但会进晨检包审计 diff。` })
    broadcast({ type: 'guard-violation', runId: run.id, employee: run.employee, code: verdict.code, tool: toolName, count: led.forbidden.length })
  }
  saveGuardLedger(c.runName)
}
// 本轮预算用量（token / 时长）在 result 消息上收口
function observeGuardUsage(run, msg) {
  const c = guardContractFor(run)
  if (!c) return
  const led = guardLedgerFor(c.runName)
  if (!led) return
  const u = msg?.usage || {}
  // ⚠ **缓存读不计入成本顶**（2026-09-18 修）：原式把 `cache_read_input_tokens` 全额相加，
  // 而它是「每一轮把整个上下文重读一遍」的量——一轮守航累出 **119,073,427** tokens，对着 2,000,000
  // 的参考顶，`guard.violation.over_budget` 从此恒亮。恒亮的红灯不是信号是噪声，等于这盏灯没建。
  // 口径改成「新增 token」＝ input + output + cache_creation（缓存读单列 cacheReadTokens，晨检包照实印，
  // 不参与 checkBudget）。理由：契约里 max_tokens 自称「成本参考顶」，而缓存读的计价约为写入的十分之一，
  // 把它按全价计入，顶就只能反映「聊了多久」而不是「花了多少」。
  const tok = Number(u.input_tokens || 0) + Number(u.output_tokens || 0) + Number(u.cache_creation_input_tokens || 0)
  const cacheRead = Number(u.cache_read_input_tokens || 0)
  if (cacheRead > 0) led.usage.cacheReadTokens = (led.usage.cacheReadTokens || 0) + cacheRead
  if (tok > 0) { led.usage.tokens = (led.usage.tokens || 0) + tok; led.usage.tokensMeasured = true }
  // SDK 某些版本/路径的 result 消息不带 usage。**这件事必须记下来**：否则晨检包会印一个「token: 0」，
  // 而 0 与「量不到」在纸面上长得一样——正是本版反复在治的那类假健康值（见 §21.3）。
  else if (!led.usage.tokensMeasured) led.usage.tokensUnmeasured = (led.usage.tokensUnmeasured || 0) + 1
  const startedAt = Date.parse(String(c.contract.starts_at || '')) || Date.parse(run.startedAt || '') || Date.now()
  led.usage.runtimeMinutes = Math.max(led.usage.runtimeMinutes || 0, Math.round((Date.now() - startedAt) / 60000))
  led.overBudget = guardLedger.checkBudget(c.contract, led.usage)
  saveGuardLedger(c.runName)
  // G2：长任务跑够时长却一条进度快照都没落 → 提醒它落一条。**不强制**（强制会变成又一道能被措辞绕过的软门），
  // 但要在它还记得住细节的时候提，而不是等到卡死自愈时才发现无快照可注。
  const elapsedMs = Date.now() - (Date.parse(run.startedAt || '') || Date.now())
  if (stallGuard.snapshotDue({ elapsedMs, list: run._snapshots || [] })) {
    run._snapshotNudgedAt = Date.now()
    appendEvent(run.id, { type: 'lab', text: `📌 已跑 ${Math.round(elapsedMs / 60000)} 分钟、还没落过进度快照：用 \`progress_snapshot\` 记一条「做到哪 / 下一步 / 别再重做什么」。任何续跑路径引擎都会把它注回你的 prompt——落了它，卡死自愈或巡视唤起时就不会从头重来。` })
  }
}

// ---------- 版本进度查询（企微人格只读窄通道）：按版本号读任务档案，聚成进度摘要 ----------
// 缘起：企微人格被关在文件系统外（deny Read/Glob/Grep），问「某版本到什么进度」时够不到 tasks/ 档案
// （版本进度的唯一状态源），只能拿飞书需求表（粗粒度分诊：待处理/处理中/已完成）凑 → 答非所问。
// 这里开一条 in-process 只读通道：handler 是 server 端 Node 代码，不放开 Claude 的文件系统权限。
// ⚠ frontmatter.status 会滞后/不自洽（实证：v5.16 字面停在 QA_PASSED，但 gates.released_test 已 true、
//   还在做增量），故进度摘要不回读 status，而是交叉 gates + 条目登记表逐条状态 + 时间线尾部。
function normVersion(v) {
  return String(v || '').trim().toLowerCase().replace(/^v/, '').replace(/\s+/g, '')
}
// 取「## 时间线」段最后 n 条 `- ` 行（每行截断防刷屏）；无此段返回 []
function extractTimelineTail(text, n = 4) {
  const m = text.match(/##\s*时间线([\s\S]*?)(\n## |$)/)
  if (!m) return []
  const rows = []
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^- (.+)$/)
    if (mm) rows.push(mm[1].replace(/\s+/g, ' ').trim())
  }
  return rows.slice(-n).map(s => s.length > 120 ? s.slice(0, 120) + '…' : s)
}
// 遍历 tasks/ 找某版本的「主档案」（带 task+status 的才算任务档案，排除轻量交接卡；
// 命中优先精确版本号，其次条目最多者=主档案，再 updated 新者）。返回 {file,abs,fm,text} 或 null。
function findVersionArchive(version) {
  const want = normVersion(version)
  if (!want) return null
  let best = null
  for (const f of fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md'))) {
    const abs = path.join(TASKS_DIR, f)
    let text; try { text = fs.readFileSync(abs, 'utf8') } catch { continue }
    const fm = parseFrontmatter(text)
    if (!fm || !fm.task || !fm.status) continue          // 非任务档案（交接卡等）跳过
    const fv = normVersion(fm.version)
    if (!fv) continue
    const exact = fv === want
    if (!exact && !fv.startsWith(want + '.')) continue    // 精确，或 "5.16" 命中 5.16.x
    const cand = { file: `office-lab/tasks/${f}`, abs, fm, text, nEntries: extractEntries(text).length, updated: String(fm.updated || ''), exact }
    if (!best) { best = cand; continue }
    if (cand.exact !== best.exact) { if (cand.exact) best = cand; continue }   // 精确优先
    if (cand.nEntries > best.nEntries || (cand.nEntries === best.nEntries && cand.updated > best.updated)) best = cand
  }
  return best
}
// 列出在推进的版本（不传 version 时的回退），按 updated 倒序
function listActiveVersions(limit = 8) {
  const out = []
  for (const f of fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md'))) {
    let text; try { text = fs.readFileSync(path.join(TASKS_DIR, f), 'utf8') } catch { continue }
    const fm = parseFrontmatter(text)
    if (!fm || !fm.task || !fm.version || !fm.status) continue
    out.push({ version: fm.version, task: fm.task, updated: String(fm.updated || ''), file: f })
  }
  out.sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || b.file.localeCompare(a.file))
  return out.slice(0, limit)
}
// 发布/验收门禁的用户友好翻译（治 status 字段滞后：进度以 gates 布尔位为准）
const RELEASE_GATE_LABEL = {
  human_precheck_passed: '老板最终验收', qa_passed: 'QA 通过',
  released_test: '发测试环境', released_prod: '发线上', post_release_done: '上线后收尾',
}
// 组装某版本的进度摘要（纯文本，供企微人格转述）。version 空 → 列在推进的版本；找不到 → 直说没找到。
function buildVersionProgress(version) {
  if (!version || !String(version).trim()) {
    const vs = listActiveVersions()
    if (!vs.length) return '工作空间里还没有任何版本任务档案。'
    return '你想问哪个版本的进度？最近在推进的有：\n' + vs.map(v => `- ${v.version}｜${v.task}（更新于 ${v.updated || '—'}）`).join('\n')
  }
  const hit = findVersionArchive(version)
  if (!hit) return `没找到「${version}」的版本档案。可能版本号不对，或它还没在工作空间建卡。`
  const { fm, text } = hit
  const brief = s => { const t = String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); return t.length > 60 ? t.slice(0, 60) + '…' : t }
  const lines = []
  lines.push(`【${fm.version || version} 进度】${fm.task ? ' ' + brief(fm.task) : ''}${fm.owner ? `（当前持有：${EMPLOYEES[fm.owner]?.displayName || fm.owner}）` : ''}`)
  // 发布态：以 gates 为准，不回读 fm.status（后者会滞后）
  const g = fm.gates || {}
  const relBits = Object.keys(RELEASE_GATE_LABEL).filter(k => k in g).map(k => `${RELEASE_GATE_LABEL[k]}${g[k] ? ' ✓' : ' ✗'}`)
  if (relBits.length) lines.push(`发布态：${relBits.join('　')}`)
  else if (fm.status) lines.push(`版本态：${fm.status}`)
  if (fm.frozen) lines.push('（本版已封板 frozen）')
  // 条目逐条（真实颗粒度）
  const entries = extractEntries(text)
  if (entries.length) {
    lines.push(`需求条目（${entries.length}）：`)
    for (const e of entries) lines.push(`  #${e.no} ${brief(e.name)}${e.status ? ` [${e.status}]` : ''}`)
  }
  // 未完结待确认
  const pending = extractPendingDecisions(text)
  if (pending.length) lines.push(`未完结待确认（${pending.length}）：${pending.slice(0, 5).map(p => `${brief(p.item)}(${p.status})`).join('；')}${pending.length > 5 ? ' …' : ''}`)
  // 时间线尾
  const tl = extractTimelineTail(text, 4)
  if (tl.length) { lines.push('最近时间线：'); for (const t of tl) lines.push(`  · ${t}`) }
  // 同事近况
  const pulse = buildTeamPulse(null)
  if (pulse) lines.push(`\n同事近况：\n${pulse}`)
  return lines.join('\n')
}

// ---------- 教训自动沉淀（trajectory memory）：把"手动追加靠自律"升级为"从真实 run 自动落库" ----------
// 业内共识：institutional knowledge 应从执行轨迹自动提取。员工收工汇报里的 `【教训】<一句话>` 行，
// 由 server 在收工时自动 append 到该员工 memories/*.md（带日期+runId+去重），下次派工自然读到。
function extractLessons(result) {
  const out = []
  for (const line of String(result || '').split('\n')) {
    const m = line.match(/^[ \t]*【教训】\s*(\S.*)$/)
    if (m) out.push(m[1].replace(/\s+/g, ' ').trim())
  }
  return out
}
function appendLessons(run) {
  try {
    const emp = EMPLOYEES[run.employee]
    if (!emp?.memoryFile) return
    const lessons = extractLessons(run.result)
    if (!lessons.length) return
    const abs = resolveEmpFile(emp.memoryFile)
    let text
    try { text = fs.readFileSync(abs, 'utf8') } catch { return }   // 只往已有教训库追加，不新建
    const fresh = lessons.filter(l => !text.includes(l))            // 去重：整句已存在则跳过
    if (!fresh.length) return
    const date = new Date().toISOString().slice(0, 10)
    const SECTION = '## 自动沉淀（收工时由 `【教训】` 标记自动落库，可人工整理进上面的分类）'
    const addition = fresh.map(l => `- ${l}（${date} · run \`${run.id}\`）`).join('\n')
    text = text.replace(/\s*$/, '') + (text.includes(SECTION) ? '\n' : `\n\n${SECTION}\n\n`) + addition + '\n'
    fs.writeFileSync(abs, text)
    appendEvent(run.id, { type: 'lab', text: `📝 沉淀 ${fresh.length} 条教训到 ${emp.memoryFile}` })
  } catch (e) { console.warn('[appendLessons] 异常:', e.message) }
}

// ---------- 教训库注入（trajectory memory 的**读侧**，§3.103 补齐）----------
// 缘起（2026-08-25，run `20260825075631-27368f`）：菲菲「发布沟通四件只交一件」这个漏子，教训库里**已经记了四条**
// （2026-07-28 两条 / 08-04 / 08-18，08-18 那条原文就是「即便派工只点名了前三件，仍要按 PM_RELEASE_NOTES 红线补齐」），
// 但引擎只在**收工时写** memories/*.md、派工时从不注入——写进去的教训对下一次运行**零作用**，全靠员工自己想起来去 Read
// （那一轮她一次都没读）。「自动沉淀」只做了一半：有写、无读。
// 现在按本轮派工内容做一次轻量相关性选取（中文 bigram 重叠，不引分词/向量依赖），把最相关的若干条随工牌一起注入；
// **刻意不搬全文**——ggbond/mihu 的教训库已 80k+ 字符，整本灌进系统提示会挤掉工牌本身、且大部分与本轮无关。
// 全库仍在磁盘上，要通读随时可 Read（注入块里点明了路径）。
// ⚠ 纯相关性打分有个**系统性盲区**（2026-09-21 实测，run `20260921074152-5a44fd`）：打分是「教训正文 × 派工文本」的
// 中文 bigram 字面重叠，于是**越是纯工具链/环境类的操作性教训，越选不上**——它们的词是 `host:port`、`ssh remote`、
// `-R 参数`，而派工头讲的是业务（「规格正确性链 / REQ-0342 / QA 收束」），字面交集近乎为零。那一轮波比的 8 条 glab
// 教训（记了 5 遍、跨 08-18～09-07）打分排名 118/121/123/124/125（共 125 条）**全部垫底、一条没注入**，于是他花约
// 7 分钟、27 条 Bash 现场重新摸索 glab 的 host/项目 ID/可用命令形态——答案在磁盘上躺着，读侧够不着。
// 治法：给教训库开一个**常驻段**（`## 常驻…`），段内条目**不过打分、每轮无条件注入**，专门放"与本轮说什么无关、
// 但每次都用得上"的固定事实与反复踩的坑；其余条目照旧按相关性补满。常驻段自带独立上限，防写飞了反噬相关性名额。
// 下面两个是**相关性选取的配额**（不含常驻）。常驻配额是**纯加法**叠在它上面 —— 这样没写常驻段的员工
// （ggbond/mihu/feifei）注入量与改造前一字不差，只有主动开了常驻段的才多那一截。
const LESSON_MAX_ITEMS = 14
const LESSON_MAX_CHARS = 5000
const LESSON_MIN_ITEMS = 6      // 相关性挂零时的兜底条数（按「越靠后越新」取，等价于近期教训）——只数相关性选出的，常驻不占额
const LESSON_PINNED_MAX_ITEMS = 8      // 常驻段上限：条数
const LESSON_PINNED_MAX_CHARS = 2600   // 常驻段上限：字符（超出部分按原文顺序截断，不挤占相关性名额）
const PINNED_SECTION_RE = /常驻/        // 命中该正则的 `##` 小节 = 常驻段
// 中文没有空格分词：汉字串取 2-gram，英文/数字/点号串（REQ-0243、CHANGELOG、code 卡名）整体成词。
function textGrams(s) {
  const out = new Set()
  for (const seg of String(s || '').toLowerCase().match(/[一-龥]{2,}|[a-z0-9_.-]{3,}/g) || []) {
    if (!/[一-龥]/.test(seg)) { out.add(seg); continue }
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2))
  }
  return out
}
// 教训库 → [{section, text}]，以顶层 `- ` 条目为单位；缩进续行并进上一条（长教训常换行写）。
function extractLessonItems(md) {
  const items = []
  let section = ''
  for (const raw of String(md || '').split('\n')) {
    const h = raw.match(/^#{2,}\s+(.+?)\s*$/)
    if (h) { section = h[1].replace(/[（(].*$/, '').trim(); continue }
    if (/^-\s+\S/.test(raw)) items.push({ section, text: raw.replace(/^-\s+/, '').trim() })
    else if (items.length && /^\s+\S/.test(raw)) items[items.length - 1].text += ' ' + raw.trim()
  }
  return items
}
function buildLessonsBlock(employee, focusText) {
  try {
    const emp = EMPLOYEES[employee]
    const abs = emp?.memoryFile && resolveEmpFile(emp.memoryFile)
    if (!abs) return ''
    const items = extractLessonItems(fs.readFileSync(abs, 'utf8'))
    if (!items.length) return ''
    // ① 常驻段：不过打分，按原文顺序整段注入（自带上限；写飞了只截自己，不吃相关性名额）
    const pinned = [], rest = []
    items.forEach((it, i) => (PINNED_SECTION_RE.test(it.section) ? pinned : rest).push({ ...it, i, score: Infinity }))
    const picked = []
    let chars = 0
    for (const p of pinned) {
      if (picked.length >= LESSON_PINNED_MAX_ITEMS || chars + p.text.length > LESSON_PINNED_MAX_CHARS) break
      picked.push(p); chars += p.text.length
    }
    const nPinned = picked.length, pinnedChars = chars
    // ② 其余条目照旧按相关性补满。配额从常驻消耗掉的量之上**另起**（见上方常量注释：加法不摊薄）
    const maxItems = nPinned + LESSON_MAX_ITEMS, maxChars = pinnedChars + LESSON_MAX_CHARS
    const focus = textGrams(focusText)
    const scored = rest.map(it => {
      let hit = 0
      for (const g of textGrams(it.text)) if (focus.has(g)) hit++
      // 除以 √长度：否则最长的那几条恒赢（长文本天然命中多），短而准的教训永远选不上
      return { ...it, score: hit / Math.sqrt(Math.max(20, it.text.length)) }
    })
    scored.sort((a, b) => (b.score - a.score) || (b.i - a.i))   // 相关性优先；同分取靠后的（教训库按时间追加＝更新）
    for (const s of scored) {
      if (picked.length >= maxItems || chars + s.text.length > maxChars) break
      // 已选到不相关区、且量够了就停。数的是**相关性选出的条数**（减掉常驻）：否则常驻一多就把兜底名额吃光，
      // 派工与教训库字面不搭时会退化成"只有常驻、没有近期教训"。
      if (s.score <= 0 && picked.length - nPinned >= LESSON_MIN_ITEMS) break
      picked.push(s); chars += s.text.length
    }
    if (!picked.length) return ''
    picked.sort((a, b) => a.i - b.i)   // 回到原文顺序：按分类读着顺，也保住「同一分类的几条挨着」
    const lines = picked.map(p => `- ${p.section ? `〔${p.section}〕` : ''}${p.text}`)
    const title = nPinned
      ? `常驻 ${nPinned} 条 + 与本轮最相关的 ${picked.length - nPinned} 条`
      : `与本轮最相关的 ${picked.length} 条`
    const pinnedNote = nPinned
      ? `\n> 〔常驻〕那几条**与本轮说什么无关、每轮都注入**：都是你反复踩过的固定坑（环境/工具链/命令形态这类，字面上跟派工词对不上、靠相关性永远选不中）。**动手前先照着做，别现场重新摸索。**`
      : ''
    // 路径写 L 形式（`office-lab/…`）：startRun 收尾的 toAgentPath 会把它改写成当前部署形态下的真实相对路径，
    // 直接写 `memories/x.md` 在嵌套形态下会指错目录（agent 的 cwd 是 monorepo 顶层）。
    return `\n\n---\n\n## 【你的教训库 · ${title}】\n\n> 引擎自 \`${OFFICE_URI_PREFIX}/${emp.memoryFile}\` 选出（全库更长，要通读自己 Read 那个文件）。这些是**你自己踩过的坑**，不是泛泛建议。${pinnedNote}\n> **派工指令没点名 ≠ 可以不做**：交付物/职责范围以你的工牌 SOP 为准，派工只是本轮的切入点。\n\n${lines.join('\n')}\n`
  } catch (e) { console.warn('[buildLessonsBlock] 异常:', e.message); return '' }
}

// ---------- 人工 Pass：服务端写任务档案（此前 .md 只由员工 Claude 写，这是唯一的服务端写入点）----------
// 不做 git commit（遵守禁自动提交）；改动留工作区由用户提交。fs.watch 会自动 broadcast tasks-changed 刷看板。
// 用 slice 拼接而非 String.replace，避免替换串里的 $ 被当作特殊替换符。
function passFirstStep(text) {   // 勾掉「流程状态」段第一个未勾 - [ ]，行尾追加人工 Pass 审计
  const m = text.match(/(##\s*流程状态[\s\S]*?)(\n## |$)/)
  if (!m) return { error: '未找到「流程状态」段' }
  const section = m[1]
  const today = new Date().toISOString().slice(0, 10)
  let passed = null
  const newSection = section.replace(/^([ \t]*)- \[ \] (.+)$/m, (_whole, indent, body) => {   // 无 g 标志=只替换第一个
    passed = body.replace(/\*\*/g, '').trim()
    return `${indent}- [x] ${body}（✅ 人工 Pass · 用户 ${today}）`
  })
  if (passed === null) return { error: '「流程状态」里没有未勾选步骤' }
  return { text: text.slice(0, m.index) + newSection + text.slice(m.index + section.length), passed }
}
function passEntry(text, no) {   // 把「需求条目登记表」里 #no 行的「状态」列置为 人工Pass
  const m = text.match(/(##\s*需求条目登记表[\s\S]*?)(\n## |$)/)
  if (!m) return { error: '未找到「需求条目登记表」' }
  const section = m[1]
  const lines = section.split('\n')
  const rowCells = line => { const c = line.split('|').map(x => x.trim()); c.shift(); if (c[c.length - 1] === '') c.pop(); return c }
  const headerIdx = lines.findIndex(l => l.trim().startsWith('|'))
  if (headerIdx < 0) return { error: '登记表无表头' }
  const header = rowCells(lines[headerIdx]).map(h => h.replace(/\*\*/g, ''))
  const idxOf = (...names) => { for (const n of names) { const i = header.findIndex(h => h.startsWith(n)); if (i >= 0) return i } return -1 }
  const iNo = idxOf('#'), iName = idxOf('条目'), iStatus = idxOf('状态')
  if (iStatus < 0) return { error: '登记表无「状态」列' }
  let passed = null
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|')) continue
    const cells = rowCells(lines[i])
    const rowNo = ((iNo >= 0 ? cells[iNo] : cells[0]) || '').replace(/[#\s*]/g, '')
    if (rowNo !== String(no)) continue
    if (/^[-: ]+$/.test(cells[iStatus] || '')) continue   // 跳过分隔行
    cells[iStatus] = '人工Pass'
    lines[i] = '| ' + cells.join(' | ') + ' |'
    passed = ((iName >= 0 ? cells[iName] : '') || rowNo).replace(/\*\*/g, '').trim()
    break
  }
  if (passed === null) return { error: `未找到条目 #${no}` }
  const newSection = lines.join('\n')
  return { text: text.slice(0, m.index) + newSection + text.slice(m.index + section.length), passed }
}

function appendEvent(runId, obj) {
  const file = path.join(RUNS_DIR, `${runId}.jsonl`)
  const line = JSON.stringify({ ...obj, _ts: new Date().toISOString() })
  const id = nextSeq(runId, file)   // 带上 SSE id，供重连时 Last-Event-ID 断点续传
  fs.appendFileSync(file, line + '\n')
  const clients = sseClients.get(runId)
  if (clients) for (const res of clients) res.write(`id: ${id}\ndata: ${line}\n\n`)
  runSubs.publish(runId, id, line)
}

// ---------- 会话日志（用户↔员工 / 员工↔员工 的每条消息，供「会话看板」持久回看；broadcasts 是瞬时的） ----------
const CONVO_FILE = path.join(RUNS_DIR, 'conversations.jsonl')
// entry: { threadRootId, fromKind:'user'|'employee', from, to, toRunId, kind:'dispatch'|'chat'|'call'|'return'|'blocked', text, depth }
function logConversation(entry) {
  try {
    const row = { ts: new Date().toISOString(), ...entry, text: String(entry.text || '').slice(0, 4000) }
    fs.appendFileSync(CONVO_FILE, JSON.stringify(row) + '\n')
    broadcast({ type: 'conversation', ...row })
  } catch (e) { console.warn('[logConversation] 异常:', e.message) }
}

// ---------- 员工引擎（v0.2.0：Agent SDK 常驻流式 query） ----------
// kind: 'dispatch'（正式派工，消息带【派工】标记，员工走完整 SOP）| 'chat'（日常交流）
//
// 设计：每个活跃 run 持有一个长活 query（run._q）+ 输入通道（run._input）+ AbortController（run._abort）。
//   - 同一 run 多轮（回复/拍板/回发）往同一 query 推消息 → prompt 缓存热（探针实测每轮各一个 result、session 连续）。
//   - 每个 turn 的 result → onTurnComplete（落 done/接棒），query 不关，留 IDLE_CLOSE_MS 空闲窗等下轮；超窗 close，下次 resume 冷起。
//   - abort（停止/接管/卡死/退出）或输入通道 close（idle）→ consumeStream 结束 → handleStreamEnd 统一收尾（对齐 v0.1 close 三分支）。

// 输入通道：promise 队列驱动的 async generator。push 投递用户轮；close 让 gen() return（query 优雅收束）。
function makeInputChannel() {
  const queue = []
  let waiting = null
  let closed = false
  const push = (content) => {
    if (closed) return
    // L→P 的**单一咽喉**：所有入栈文本（firstPrompt / pushTurn / enqueueTurn → 派工头、任务快照、同事近况、
    // 抄送与接棒消息、上传截图标记）都经这里，统一把 `office-lab/…` 改写成当前形态的真实相对路径。
    // 注意 appendEvent 在 push **之前**落库 → 落库与前端拿到的永远是 L 形式，旧 UI 那几条正则继续成立。
    if (typeof content === 'string') content = toAgentPath(content)
    const msg = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
    if (waiting) { const w = waiting; waiting = null; w(msg) } else queue.push(msg)
  }
  const close = () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(null) } }
  async function* gen() {
    while (!closed) {
      if (queue.length) { yield queue.shift(); continue }
      const next = await new Promise(r => (waiting = r))
      if (next === null) return
      yield next
    }
  }
  return { push, close, gen }
}

// 工具入参浓缩成一句人话（审批卡/日志用）
function permBrief(toolName, input = {}) {
  const s = input.command || input.file_path || input.path || input.url || input.pattern || ''
  return String(s).replace(/\s+/g, ' ').slice(0, 200)
}
// 动态权限回调：仅当工具未被 allow 规则/permissionMode 自动放行、落到 prompt 时才触发（编辑走 acceptEdits、安全 Bash 走 settings.json allow）。
// 危险/未知命令 → 广播 permission-request 到 Lab UI，挂起等 POST /api/runs/:id/permission；超时/abort 自动拒绝。
function makeCanUseTool(run) {
  return (toolName, input, opts = {}) => new Promise(resolve => {
    const reqId = crypto.randomBytes(6).toString('hex')
    const brief = permBrief(toolName, input)
    const finish = (result) => {
      const entry = pendingPerms.get(reqId)
      if (!entry) return
      clearTimeout(entry.timer)
      clearTimeout(entry.escTimer)
      pendingPerms.delete(reqId)
      broadcast({ type: 'permission-resolved', runId: run.id, reqId })
      resolve(result)
    }
    const timer = setTimeout(() => {
      appendEvent(run.id, { type: 'lab', text: `⏱️ 审批超时(5min)自动拒绝：${toolName} ${brief}` })
      finish({ behavior: 'deny', message: '审批超时,自动拒绝' })
    }, PERM_TIMEOUT_MS)
    // 升级推送：挂起 PERM_PUSH_MS 仍无人处理 → 发 Bark（点通知打开手机审批页）。需配 barkUrl + labBaseUrl。
    const escTimer = setTimeout(() => {
      if (pendingPerms.has(reqId)) sendApprovalPush(run, reqId, toolName, brief)
    }, PERM_PUSH_MS)
    pendingPerms.set(reqId, { resolve: finish, runId: run.id, timer, escTimer, toolName, brief, employee: run.employee, createdAt: Date.now() })
    try { opts.signal?.addEventListener?.('abort', () => finish({ behavior: 'deny', message: '已中断' }), { once: true }) } catch { }
    appendEvent(run.id, { type: 'lab', text: `⏸️ 等待审批：${toolName} ${brief}` })
    broadcast({ type: 'permission-request', runId: run.id, employee: run.employee, reqId, toolName, brief, title: opts.title || '' })
  })
}

// 审批升级 Bark：点通知打开 labBaseUrl 上的审批页。缺 barkUrl/labBaseUrl 或关了 approvalPush 则静默跳过。
function sendApprovalPush(run, reqId, toolName, brief) {
  try {
    if (!pushConfig.approvalPush || !pushConfig.barkUrl || !pushConfig.labBaseUrl) return
    const name = EMPLOYEES[run.employee]?.displayName || run.employee
    sendBark({
      title: `⏸️ ${name} 等待审批`,
      body: `${toolName}：${brief || ''}`.slice(0, 200),
      url: `${pushConfig.labBaseUrl}/approve?reqId=${reqId}`,
      level: 'timeSensitive',
      icon: empIconUrl(run.employee),
    })
    appendEvent(run.id, { type: 'lab', text: `📲 审批已挂起 ${Math.round(PERM_PUSH_MS / 1000)}s，已推送到手机` })
  } catch (e) { console.warn('[push] 审批推送异常:', e.message) }
}

// 工具结果里可能内嵌 base64 图（截图/读图类工具把像素喂给模型「看」），单张 300–600KB、一条会话能攒 6MB+。
// 前端渲染工具结果时只取 image 之外的 .text（image block 被丢弃、界面根本不显示，见 app.js fillToolResult），
// 但它照样落进 jsonl + 每次冷开走 SSE 全量重推 → jsonl 臃肿、加载卡（尤其过 Cloudflare 隧道，瓶颈在传输）。
// 落库前把 image block 换成占位文本、剥掉 base64：前端零视觉损失；**模型侧不受影响**——其记忆走 SDK 自己的
// resume transcript（options.resume=sessionId），不经此 jsonl（jsonl 全仓库只被 SSE 回放读，非模型输入）。见复盘 §3.36。
function stripToolResultImages(message) {
  const content = message?.content
  if (!Array.isArray(content)) return message
  let touched = false
  const next = content.map(block => {
    if (!block || block.type !== 'tool_result' || !Array.isArray(block.content)) return block
    let hit = false
    const inner = block.content.map(b => {
      if (b && b.type === 'image') { hit = true; return { type: 'text', text: '[图片]' } }
      return b
    })
    if (!hit) return block
    touched = true
    return { ...block, content: inner }
  })
  return touched ? { ...message, content: next } : message   // 命中才浅克隆，不改动原 SDK 消息对象
}

// SDKMessage → 前端 jsonl 事件形状（renderEvent/deriveActivity 无需改）。丢弃控制噪声；system/init 每 run 只留首个。
function normalizeEvent(msg, run) {
  switch (msg.type) {
    case 'assistant':
      return { type: 'assistant', message: msg.message, parent_tool_use_id: msg.parent_tool_use_id, session_id: msg.session_id }
    case 'user': {
      const content = msg.message?.content
      const hasToolResult = Array.isArray(content) && content.some(b => b && b.type === 'tool_result')
      if (!hasToolResult) return null   // 丢弃输入回显,只留工具结果
      return { type: 'user', message: stripToolResultImages(msg.message), parent_tool_use_id: msg.parent_tool_use_id, session_id: msg.session_id }
    }
    case 'result':
      return { type: 'result', subtype: msg.subtype, is_error: msg.is_error, result: msg.result }
    case 'system':
      if (msg.subtype !== 'init' || run._initEmitted) return null
      run._initEmitted = true
      return { type: 'system', subtype: 'init', model: msg.model, session_id: msg.session_id, permissionMode: msg.permissionMode }
    default:
      return null   // stream_event/status/thinking_tokens/hook_* 等控制消息不落库
  }
}

// 启动一条新 query（首轮 / resume 冷起 / 续跑）
// userText：老板**原样敲下的那句话**（不含引擎注入的派工头/任务快照/同事近况/守航块）。只做展示用——
// 前端据它把气泡还原成「你说的话」，整段注入收进二级「查看原文」。喂给模型的仍是 firstPrompt 全文，
// buildReseedPrompt 等引擎侧复原逻辑也照旧读 text，二者不互相干扰（2026-09-21，老板：「看着就烦」）。
function startRun(run, firstPrompt, { kind = 'dispatch', resume = false, userText = '' } = {}) {
  if (run.engineHandoverPending) return holdHandoverMessage(run, firstPrompt, kind, userText)
  if (!run.sessionId && run.engineHandoverSeed) { firstPrompt = run.engineHandoverSeed + (firstPrompt ? '\n\n【追加指令】\n' + firstPrompt : ''); resume = false }
  const handoverInbox = run.handoverInbox
  if (handoverInbox?.length) firstPrompt += '\n\n【交接期间收到的消息】\n' + handoverInbox.map(m => m.prompt).join('\n\n')
  if (!run.sessionId && run.engineHandoverSeed) run.engineHandoverSeed = firstPrompt
  run._userStopped = false
  run.userStoppedAt = undefined   // 会话又跑起来了 → 撤销「老板亲手按停」标记（该标记只用于抑制抄送汇合的自动唤回）
  const emp = EMPLOYEES[run.employee]
  const consult = isConsult(run)                // 只读咨询窗：零写能力的旁支会话（见 isConsult 上方缘起）
  let roleText = buildRolePrompt(emp, kind, { consult })   // 工牌全文 append 到 claude_code preset（= v0.1 的 --append-system-prompt）
  if (consult) roleText += CONSULT_MANDATE + consultBackgroundBlock(run.employee)   // 只读边界 + 「你正式会话在跑什么」坐标（指针+摘要，不搬正文）
  else if (run.employee === 'feifei') roleText += FEIFEI_BOARD_CONTEXT   // 菲菲两顶帽子：把「本轮=看板主人格、有全套工具、非企微」钉成确定事实，取消靠猜渠道（2026-08-09，复盘 §3.61）
  if (!consult) roleText += uiContractBlock(run.employee)      // UI 状态契约 + 「自上次以来变了什么」：只注两位 QA。同步读缓存（GG Bond 收工时已异步刷好），见 refreshUiContract 上方缘起
  // 教训库注入（读侧，§3.103）：按本轮首条 prompt 选相关教训随工牌注入——「自动沉淀」此前只写不读，等于写了白写。
  // 放在系统提示 append 里＝每会话一次、命中 prompt cache；只读窗不注（它不沉淀教训，也不该被长块挤掉问答空间）。
  if (!consult) roleText += buildLessonsBlock(run.employee, firstPrompt)
  if (!consult) roleText += laneBlockFor(run)   // 【运行环境】：本会话属于哪个工作区、代码落哪几棵树、被测 origin/端口是多少。没登记工作区时为空串＝现状不变
  if (!consult) roleText += buildZhuzhuBlock(run.employee)    // 猪猪对接块并入系统提示 append：每会话注入一次（命中 prompt cache、resume 冷起重取当前基地址），取代旧「每条派工/聊天消息前缀」——保持气泡干净（2026-08-18，见 CHANGELOG）。对非 injectFor 员工返回 '' 无副作用；只读窗没挂猪猪 MCP，注了只会误导
  // systemPrompt 不走 input.push 那个咽喉，故在拼装完成后单独做一次 L→P（覆盖 buildRolePrompt 之后追加的
  // FEIFEI_BOARD_CONTEXT / CONSULT_MANDATE / 契约块 等段落里的 `office-lab/…`）。函数幂等，重复调用无副作用。
  roleText = toAgentPath(roleText)
  const input = makeInputChannel()
  const abort = new AbortController()
  const options = {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: roleText },
    engine: engineForRun(run), readOnly: consult, codeLocked: CODE_LOCKED_EMPLOYEES.has(run.employee),
    codexOwnerDirectory: path.join(RUNS_DIR, 'codex-owners'),
    requestApproval: makeCanUseTool(run),
    requestUserInput: (_question, { signal }) => waitForRunInput(run, { signal, changed: waiting => {
      run.activity = waiting ? '等待你的回复' : '继续处理'
      broadcast({ type: 'run-activity', runId: run.id, employee: run.employee, activity: run.activity })
    } }),
    // 只读窗一律 'default'（不用员工自己的 bypassPermissions）：白名单外的工具才会落 canUseTool → Lab 审批卡。
    permissionMode: consult ? 'default' : (emp.permissionMode || 'acceptEdits'),
    model: resolveModel(run, kind),               // 会话固定模型或对应基座默认值
    cwd: WORKSPACE_ROOT,                          // 工作树：嵌套=monorepo 顶层（员工要改 frontend/、后端仓）｜独立=office-lab 仓根（不逃出仓库，见 paths.js）
    abortController: abort,
    settingSources: ['user', 'project', 'local'], // 加载 CLAUDE.md + .claude/settings.json（allow 白名单 + hooks）
    includePartialMessages: true,   // 开启后 SDK 才发 thinking_tokens（长思考实时估算）——驱动「思考中… ~Nk」心跳 + 刷新 _lastActivity（见 handleControlMsg / 复盘 §3.30）；stream_event 增量走 normalizeEvent default 丢弃，不落库
    thinking: thinkingConfig(resolveThinking(run, kind)),   // 思考硬顶：**必须走这个 option**，env MAX_THINKING_TOKENS 在 Opus 4.6+ 只是开关（见 THINKING_BUDGET 上方那段）
    // env 随子进程透传：PYTHONIOENCODING/PYTHONUTF8 强制员工 Bash 里 python 的 I/O 走 UTF-8，
    // 根治 Windows 默认 GBK(cp936) 吞中文的乱码——乱码曾诱发迷糊把 UTF-8 文件脑补成 UTF-16、把"读不到"误判成"临时文件被删"（run 20260811071357-67630f，教训库已记）。
    // OFFICE_LAB_EMPLOYEE/RUN：给**本机用户级 hook**（`~/.claude/settings.json` 里 DesktopTool 装的那几道）
    // 一个「这不是人在敲的开发坐席、是 office-lab 的无人值守流水线」的判据。
    // 缘起 2026-09-08：DesktopTool 的 `itkb_gate.py`（PreToolUse matcher `Task|Agent`）为 CJ 开发坐席
    // 立了「派 Explore/general-purpose 子代理前必须先查 it-kb」的硬闸；用户级 settings 是全机共享的，
    // 员工 run 走同一个 SDK、同一个 OS 用户 → **无声继承**了这道门。菲菲要分页深读老板刚上传的原型
    // Demo，连开 4 个子代理全被 exit 2 拦下（KB 里当然没有"3 分钟前的附件"），她没重试、改用关键词
    // 词频的降级读法交付 → 308 个原型单元只登记 38 条需求，整版返工（复盘 §3.122）。
    // 那边已据此把 office-lab 的调用降级成「只提醒不阻断」+ 材料阅读直接豁免；这里负责把身份亮出来。
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', OFFICE_LAB_EMPLOYEE: run.employee || '', OFFICE_LAB_RUN: run.id || '' },
  }
  // 菲菲专属 MCP（全 in-process，可靠、无子进程）：feifei-memory（回忆对话/登记需求）+ feifei-caps
  // （知识库查询 + 需求登记 + 直连飞书读/改需求表 lark_list_requirements/lark_update_requirement）。
  // 注：原先挂 npx `@larksuiteoapi/lark-mcp` 子进程读飞书——本机 npx 拉不起来/超时（未装+registry 慢），
  // 导致菲菲拿不到飞书工具（2026-07-23 事故）。改为用引擎内已有的直连飞书客户端做工具，去掉该 npx 依赖。
  // 协作工具（抄送 cc + 档案共享总线写）挂给每个员工；菲菲另加她专属的记忆 + 飞书/知识库工具。
  // 只读窗一个 MCP 都不挂：collab 里有档案回写 + cc_colleague（能派生兄弟 run），backend 能重编重启，
  // 猪猪能跑真机 E2E——全是"写/有副作用"。零挂载比逐个 deny 更可靠（工具根本不出现在它的工具表里）。
  const empMcp = consult ? {} : { 'office-lab-collab': makeCollabTools(run) }
  if (!consult && run.employee === 'feifei') {
    empMcp['feifei-memory'] = makeFeifeiMemory()
    empMcp['feifei-caps'] = makePersonaCaps('office-lab-intake')
  }
  if (!consult && run.employee === 'chaorenq') empMcp['patrol'] = makePatrolTools(run)   // 巡视员专属：resume_employee
  if (!consult && run.employee === 'feisila') empMcp['audit'] = makeAuditTools(run)       // 影子陪练专属：submit_audit_findings（无放行权）
  if (!consult && run.employee === 'ggbond') empMcp['backend'] = makeBackendTools(run)    // 开发专属：本地重编重启（迷糊红线10 禁 build/restart，故不进全员共享）
  if (!consult && run.employee === 'bobby') empMcp['release'] = makeReleaseTools(run)     // 发布专属：发布前仓库枚举（只读，merge/部署仍老板手点）
  if (!consult && LANE_TOOL_READERS.has(run.employee)) empMcp['lanes'] = makeLaneTools(run)   // 工作区：GG Bond 全套（建/起停/收），QA 与波比只读 lane_status
  if (!consult && (run.employee === 'mihu' || run.employee === 'feisila')) empMcp['e2e'] = makeE2eTools(run)   // 两位 QA 专属：并发 E2E 批次（提交即返回 + 引擎唤起 + 自动附 repair-context，见 §3.93）
  // 守航能力工具集（按角色挂；全员共享的只有 progress_snapshot + guard_status）。
  // 刻意**不限于守航态**：B1 冻结、D1 对账、C4 报告卡片这些在共驾态同样是硬要求（v5.19 那三次
  // 发布事故就发生在共驾态）。只有三红灯计数是守航态特有的（共驾态没有契约可比）。
  if (!consult) { const g = makeGuardedTools(run); if (g) empMcp['guarded'] = g }
  // 猪猪(Zhuzhu) E2E MCP：仅对用猪猪的员工(injectFor)挂远程 HTTP MCP（猪猪桌面 App 就地托管在 <base>/mcp，Streamable HTTP 无状态）。
  // SDK 对 MCP 启动默认非阻塞——App 没开也不会卡/崩本 run，工具届时不可见而已（不设 alwaysLoad 以免阻塞开局）。取代旧「手拼 HTTP」。
  if (!consult && zhuzhuConfig.enabled && Array.isArray(zhuzhuConfig.injectFor) && zhuzhuConfig.injectFor.includes(run.employee)) {
    empMcp['zhuzhu'] = { type: 'http', url: zhuzhuMcpUrl() }
  }
  options.mcpServers = empMcp
  // SDK abort can finish before an in-process host operation settles. Track it
  // separately so a cross-engine handover cannot overlap an old file mutation.
  run._hostTools ||= new Set()
  for (const server of Object.values(empMcp)) if (server.type === 'lab') {
    server.tools = server.tools.map(t => ({ ...t, handler: (...args) => {
      if (abort.signal.aborted || run.engineHandoverPending) throw new Error('会话已停止，取消旧工具调用')
      const work = Promise.resolve().then(() => {
        if (abort.signal.aborted || run.engineHandoverPending) throw new Error('会话已停止，取消旧工具调用')
        return t.handler(...args)
      })
      run._hostTools.add(work)
      work.then(() => run._hostTools.delete(work), () => run._hostTools.delete(work))
      return work
    } }))
  }
  // 工具真名前缀（2026-09-09 实测缺陷）：SOP 与工牌里写的是**裸名**（`scan_source_material`），
  // 而 SDK 把 in-process MCP 工具暴露成 `mcp__<server>__<tool>`——菲菲照 SOP 调裸名，拿到
  // `No such tool available: scan_source_material`，自己改对前缀才成（run 20260909040008-30253e 事件 5→10）。
  // 每个员工每个工具每会话都要撞一次再自愈，且"报错-重试"这一跳有时会被读成"这个能力没有"（§3.106 同族）。
  // 治法选「注一行映射」而不是「给上百处文档加前缀」：服务名随员工/态而变（只读窗一个都不挂），
  // 文档里写死前缀反而会在只读窗与不同角色上失准；这里从 empMcp 的真实键生成，永不漂。
  if (!consult && Object.keys(empMcp).length) {
    options.systemPrompt.append += `\n\n---\n\n## 【工具真名 · 前缀】\n\n` +
      `SOP 与工牌里写的引擎工具是**裸名**（如 \`scan_source_material\`），但你手上的真名带命名空间前缀：\n` +
      `**\`mcp__<服务名>__<裸名>\`**。本轮挂载的服务名：${Object.keys(empMcp).map(k => '`' + k + '`').join(' / ')}。\n` +
      `引擎协作类工具（档案回写 / 抄送 / 各闸门校验 / 扫描器）都在 \`office-lab-collab\` 下——` +
      `第一次调用就带上前缀，别先试裸名等它报 \`No such tool available\` 再改（那一跳容易被误读成"这个能力平台没做"）。\n` +
      `内置工具（Read/Write/Edit/Bash/Grep/Glob/Task 等）没有前缀，照原名用。`
  }
  // bypassPermissions 下 SDK 在咨询 canUseTool 前就自动放行（deny 除外），回调是死代码且会触发 CAN_USE_TOOL_SHADOWED 警告 → bypass 时不传回调。
  const isBypass = !consult && (emp.permissionMode || 'acceptEdits') === 'bypassPermissions'
  if (!isBypass) options.canUseTool = makeCanUseTool(run)
  // 权限名单（与团队 CC 全局设置对齐）：deny 取「全局 deny ∪ 引擎高危 deny ∪ 非编码角色代码锁」并集，任何模式下恒生效。
  // bypass 只下发 deny（保留 rm -rf 等高危 + 非编码角色代码锁红线）→ 除红线外静默放行、零审批；其它模式才叠加 allow/ask。
  // 只读窗走独立一套：allow=纯只读白名单、deny=写工具裸名 + 变更类命令（consultDeny），白名单外落审批卡。
  const denyList = [...PERM_DENY, ...DANGER_DENY, ...(CODE_LOCKED_EMPLOYEES.has(run.employee) ? codeLockDeny() : [])]
  options.settings = { permissions: consult
    ? { allow: CONSULT_ALLOW, ask: [], deny: consultDeny() }
    : (isBypass
      ? { deny: denyList }
      : { allow: PERM_ALLOW, ask: PERM_ASK, deny: denyList }) }
  if (resume && run.sessionId) options.resume = run.sessionId
  const q = query({ prompt: input.gen(), options })
  run._q = q; run._input = input; run._abort = abort; run._initEmitted = false
  // 后台任务集是 SDK 的 per-process level 信号：新 query = 新子进程 → 旧集作废，重置（下轮 level 信号会重填）。
  run._bgTasks = new Map(); run._bgSkip = new Set(); run._bgResumePending = null
  if (run.bgTasks) { run.bgTasks = undefined; broadcast({ type: 'run-bg', runId: run.id, employee: run.employee, tasks: [] }) }
  liveRuns.set(run.id, run)
  beginTurn(run, kind)
  appendEvent(run.id, { type: 'user-msg', kind, text: firstPrompt, ...(!run.sessionId && run.engineHandoverSeed ? { engineHandover: true } : {}), ...(userText ? { userText } : {}) })
  if (handoverInbox) { run.handoverInbox = undefined; saveRegistry() }
  input.push(firstPrompt)
  run._streamPromise = consumeStream(run, q, kind)   // 交接等待真实流退出，不凭 UI 终态判断
}

// 往已活的 query 推下一轮（缓存热续）
function pushTurn(run, prompt, kind, userText = '') {
  if (run.engineHandoverPending) return holdHandoverMessage(run, prompt, kind, userText)
  beginTurn(run, kind)
  appendEvent(run.id, { type: 'user-msg', kind, text: prompt, ...(userText ? { userText } : {}) })
  run._input.push(prompt)
}

// 运行中「无感排队追加」：往正在跑的 query 输入通道 push 一条，SDK 盖 uuid 入队、在下一个自然边界 coalesce 进下一轮
// （对齐真 CC 的流式输入体验：用户只管发，系统决定何时真正喂给进程）。**刻意不调用 beginTurn**——beginTurn 会重置
// _turnText/_turnActive/_ccThisTurn，会污染当前正在跑的那一轮；这里当前轮仍在跑，只排队、不翻新一轮状态。
// SDK 真正开始跑这条时，consumeStream 见到 assistant 消息会把 status 顶回 running（见该函数注释），无需在此置态。
function enqueueTurn(run, prompt, kind, userText = '') {
  if (run.engineHandoverPending) return holdHandoverMessage(run, prompt, kind, userText)
  appendEvent(run.id, { type: 'user-msg', kind, text: prompt, queued: true, ...(userText ? { userText } : {}) })   // 立即回显气泡（带排队标记）
  run._queuedCount = (run._queuedCount || 0) + 1
  run._pendingQueuedAccept = (run._pendingQueuedAccept || 0) + 1   // 待「下一轮真正开跑」时清掉排队标（见 consumeStream：本轮 result 后、下轮首个 assistant 触发 queued-accepted）
  run._input.push(prompt)
  broadcast({ type: 'run-queued', runId: run.id, employee: run.employee, queued: run._queuedCount })
}

// 一轮开始的公共状态落定（startRun 与 pushTurn 共用）
function beginTurn(run, kind) {
  clearTimeout(run._idleTimer)
  run.lastKind = kind
  run._turnRequiresSignoff = false
  run.status = 'running'
  run.stalled = false
  run._pendingQueuedAccept = 0; run._acceptQueuedOnNextAssistant = false   // 显式新一轮（派工/reply）：清排队接受态，coalesce 只发生在 enqueue→下一轮那条路径
  run._ccThisTurn = 0            // 抄送广度闸：每回合归零，本回合 cc 计数从头算
  run._turnActive = true         // 前台 turn 在跑标记（result 置假）——供 scheduleBgResume 判断是否需要引擎唤起
  run._turnText = ''             // 本轮 assistant 文本累积（供 result 空时兜底取收尾文本，见 consumeStream）
  run._sdkNudges = 0             // 本轮 SDK「无可见输出」自催次数（空转判据，见 SILENT_SPIN_NUDGES / consumeStream）
  run._turnMsgs = new Map()      // 本轮顶层 assistant 消息 id → 是否产出过 text/tool_use（零产出轮次＝空转铁证，见 barrenTurns）
  run._lastTopMsgId = null       // 最近一条顶层 assistant 消息 id（换 id ＝上一条已定稿，可结算它是不是零产出）
  run._barrenStreak = 0          // **连续**零产出条数（≥BARREN_ABORT_STREAK ＝会话中毒，当场掐断换会话，见 finalizeTopMsg）
  run._thinkAborted = false      // 本轮是否已因空想失控掐过一次（每轮只掐一次，见 brakeRunawayThinking）
  run._thinkLastEst = 0; run._thinkBase = 0   // 空想刹车的估算读数与基线
  run._lastActivity = Date.now()
  run.updatedAt = new Date().toISOString()
  saveRegistry()
  broadcast({ type: 'run-status', runId: run.id, employee: run.employee, status: 'running' })
}

// 统一入口：query 仍活 → 推入（热）；否则新起 query（resume 冷起）。供 /reply、autoChain 回发共用。
function sendToRun(run, prompt, { kind = 'dispatch', resume = false, userText = '' } = {}) {
  if (run.engineHandoverPending) return holdHandoverMessage(run, prompt, kind, userText)
  run.bootResumePending = undefined   // 任何一次投递（老板回话/巡视续跑/接回本身）都等于已接手，撤掉排着的退避接回
  if (run._q && run._input) pushTurn(run, prompt, kind, userText)
  else startRun(run, prompt, { kind, resume, userText })
}

// ---------- 后台任务 / 子agent 可观测性（SDK v0.3.x 的 task_* / background_tasks_changed 控制消息） ----------
// 背景（事故驱动）：员工用 `Bash run_in_background` 或 `Agent` 起后台活后本轮 result 收工，引擎原判 done、看板显示空闲，
// 而后台仍在跑——老板得手动敲「继续」才让员工回去查结果（run 20260727055755-fa1728 第 180 行坐实）。根因是
// normalizeEvent 的 default 分支把这些 SDK 控制消息全丢了。现在消费它们：追踪活动后台任务集、映射「后台运行中」态、
// 后台 settle 后自动唤起员工续跑。详见复盘 §3.30。

// 把 run._bgTasks（Map，引擎内元数据）同步成 public 快照 run.bgTasks（落 index.json、驱动前端），并广播 level 事件。
function syncBgTasks(run) {
  const arr = Array.from(run._bgTasks?.values() || []).map(t => ({ id: t.id, desc: t.desc, type: t.type, lastTool: t.lastTool || '', durationMs: t.durationMs || 0 }))
  run.bgTasks = arr.length ? arr : undefined   // 空则删字段，前端据「有没有 bgTasks」派生「后台运行中」显示态
  saveRegistry()
  broadcast({ type: 'run-bg', runId: run.id, employee: run.employee, tasks: arr })
  if (!arr.length && run.status !== 'running') scheduleIdleClose(run)   // 后台清空且非前台在跑 → 重新排空闲窗（此前被后台压着没排）
}

// 后台任务 settle（完成/失败/停止）：落 lab + 广播（**仅 in-UI，不推手机/托盘**）+ 自动接棒。
// 起/停后台任务是 run 内部的子事件，**不发 Bark / 托盘 Toast**——系统通知只留给「员工本身层面」的事件（run 收工/异常/中断/审批挂起，走 maybePushRunStopped）。
// 后台完成会自动唤起员工续跑，那一轮的 run 收工仍会正常按配置推送（员工级），所以后台本身无需再单独推一条。（2026-07-29 用户设定）
function onBgSettled(run, msg) {
  run._bgTasks?.delete(msg.task_id)
  const label = msg.status === 'completed' ? '完成' : (msg.status === 'failed' ? '失败' : '停止')
  const icon = msg.status === 'completed' ? '🔔' : (msg.status === 'failed' ? '⚠️' : '⏹')
  const summary = String(msg.summary || '').slice(0, 300)
  appendEvent(run.id, { type: 'lab', text: `${icon} 后台任务${label}：${summary || '（无摘要）'}${msg.output_file ? `（结果在 ${msg.output_file}）` : ''}` })
  broadcast({ type: 'run-bg-settled', runId: run.id, employee: run.employee, taskId: msg.task_id, status: msg.status, summary })
  scheduleBgResume(run, msg)   // 老板拍板：后台完成自动接棒续跑
  syncBgTasks(run)
}

// 本 run 是否已被「同线程更新的活跃会话」顶替：同员工 + 同 threadRootId + 更晚开始 + 当前 running/starting。
// 只按 threadRootId 判（不按员工一刀切），才能既拦住「僵尸旧会话诈尸」又放行「同员工多线程并行」——
// 独立线程各自的后台接棒互不影响，只有被同一线程的新会话顶替的旧会话才不复活。
// 事故：旧会话遗留后台任务泊住 query，settle 后诈尸、与现役新会话并发同分支互相踩写档案（2026-08-03，见复盘 §3.49）。
function supersededBy(run) {
  if (isConsult(run)) return null   // 只读窗自成一线，不参与"同线程顶替"判定（既不顶替正式会话，也不被它顶替）
  const root = run.threadRootId || run.id
  let winner = null
  for (const r of liveRuns.values()) {
    if (r.id === run.id || r.employee !== run.employee || isConsult(r)) continue
    if ((r.threadRootId || r.id) !== root) continue
    if (r.status !== 'running' && r.status !== 'starting') continue
    if ((r.startedAt || '') > (run.startedAt || '')) winner = r   // 更晚开始 = 顶替者
  }
  return winner
}

// 自动接棒（防与 SDK 可能的自动续跑重复注入）：仅在无前台 turn 时，等一个短 grace 观察 SDK 是否自起新 turn，
// 不起才由引擎注入一条唤起消息。_turnActive 由 consumeStream 见到 assistant 消息即置真（含 SDK 自续），result 置假。
function scheduleBgResume(run, msg) {
  if (run._turnActive) return                    // 前台 turn 在跑（含 SDK 自动续跑）→ 它自会带出后台结果
  run._bgResumePending = msg.task_id
  setTimeout(() => {
    if (shuttingDown || !runs[run.id]) return
    if (run._turnActive) { run._bgResumePending = null; return }   // grace 内 SDK 自起了新 turn，不重复注入
    if (run._bgResumePending !== msg.task_id) return               // 期间又有新 settle，交给后来那次
    const winner = supersededBy(run)                               // 本会话已被同线程更新会话顶替 → 别诈尸复活（防与现役会话并发同分支）
    if (winner) {
      appendEvent(run.id, { type: 'lab', text: `↩️ 后台任务已结束，但本会话已被更新的会话 ${winner.id} 接管，跳过自动唤起（后台结果仍在磁盘，需要时可 Read）` })
      run._bgResumePending = null
      return
    }
    run._bgResumePending = null
    const st = msg.status === 'completed' ? '已完成' : (msg.status === 'failed' ? '失败' : '被停止')
    const prompt = `【系统】你之前发起的后台任务（${msg.task_id}）${st}。摘要：${String(msg.summary || '').slice(0, 500)}${msg.output_file ? `\n完整结果在：${msg.output_file}（用 Read 工具查看）` : ''}\n请查看结果并继续推进这项工作；若无需进一步处理，请如实说明后正常收工。`
    appendEvent(run.id, { type: 'lab', text: '↩️ 后台任务已结束，自动唤起员工查看结果并继续' })
    sendToRun(run, prompt, { kind: run.lastKind || 'dispatch', resume: true })   // query 仍活则热推，已关则 resume 冷起（sendToRun 自判）
  }, BG_RESUME_GRACE_MS)
}

// 消费 SDK 的 system 控制消息（后台任务追踪 / 思考心跳）。返回 true = 已内部消化、不再走常规透传落库。
function handleControlMsg(run, msg) {
  switch (msg.subtype) {
    case 'writer_recovery_status':
      appendEvent(run.id, { type: 'lab', text: msg.text })
      return true
    case 'session_recovered':
      saveRegistry() // consumeStream already adopted the new session_id
      appendEvent(run.id, { type: 'lab', text: '已按你的选择复制原 Codex 历史并接回，Lab 会话与任务记录保留。后续继续使用新的 Codex 会话；请勿同时在另一端执行原会话。' })
      return true
    case 'execution_intent':
      run._turnRequiresSignoff = !!msg.requiresSignoff
      return true
    case 'thinking_tokens': {   // 思考心跳：长思考块本零事件，这个实时估算让「思考中… ~Nk」可见 + 刷新 _lastActivity（真实存活信号）。只广播不落库。
      const est = msg.estimated_tokens || 0
      const k = Math.max(0, Math.round(est / 100) / 10)
      const activity = `思考中… ~${k}k`
      if (activity !== run.activity) { run.activity = activity; broadcast({ type: 'run-activity', runId: run.id, employee: run.employee, activity }) }
      // 空想失控刹车。估算值的语义（每块重置 / 全轮累计）SDK 没承诺，两种都得吃：回落即视作按块重置、基线清零；
      // 否则以「上一条 assistant 消息定稿时的读数」为基线算增量。这样两种语义下顶都是「单条消息 30k」。
      if (est < (run._thinkLastEst || 0)) run._thinkBase = 0
      run._thinkLastEst = est
      if (est - (run._thinkBase || 0) > THINKING_RUNAWAY_TOKENS) brakeRunawayThinking(run, est - (run._thinkBase || 0))
      return true
    }
    case 'task_started': {
      if (msg.skip_transcript) { (run._bgSkip = run._bgSkip || new Set()).add(msg.task_id); return true }   // SDK 内务任务（观察者/auto-dream 等）不计入可见后台
      run._bgTasks = run._bgTasks || new Map()
      run._bgTasks.set(msg.task_id, { id: msg.task_id, desc: msg.description || '', type: msg.subagent_type || msg.task_type || 'task', lastTool: '', startedAt: Date.now(), durationMs: 0 })
      syncBgTasks(run)
      return true
    }
    case 'task_progress': {
      const t = run._bgTasks && run._bgTasks.get(msg.task_id)
      if (t) {
        if (msg.last_tool_name) t.lastTool = msg.last_tool_name
        if (msg.summary) t.summary = msg.summary
        if (msg.usage?.duration_ms) t.durationMs = msg.usage.duration_ms
        syncBgTasks(run)
      }
      return true
    }
    case 'task_notification': {
      if (!run._bgSkip?.has(msg.task_id)) onBgSettled(run, msg)
      return true
    }
    case 'background_tasks_changed': {   // level 信号（replace 语义，membership 唯一权威源）：修剪到当前活动集；漏了 bookend 的从这里补上（排除内务任务）
      const live = new Map((msg.tasks || []).map(t => [t.task_id, t]))
      run._bgTasks = run._bgTasks || new Map()
      for (const id of Array.from(run._bgTasks.keys())) if (!live.has(id)) run._bgTasks.delete(id)
      for (const [id, t] of live) if (!run._bgTasks.has(id) && !run._bgSkip?.has(id)) run._bgTasks.set(id, { id, desc: t.description || '', type: t.task_type || 'task', lastTool: '', startedAt: Date.now(), durationMs: 0 })
      syncBgTasks(run)
      return true
    }
    default: return false   // init 等其它 system 交回 normalizeEvent
  }
}

// 结算 run._lastTopMsgId 那条顶层 assistant 消息：产出过 text/tool_use → 连击归零；纯思考 → 连击 +1。
// 连击达 BARREN_ABORT_STREAK ＝会话中毒：CLI 自己已经注入过一次「no visible output, please continue」自催
// 并且失败了（那条 isMeta 消息 SDK 不透传给消费者，所以 _sdkNudges 恒为 0、看不见），再跑下去只是继续往
// transcript 里堆坏样例。allowAbort=false 用于 result 到达时的补结算（流已到轮末，掐断无意义）。
function finalizeTopMsg(run, allowAbort = true) {
  const id = run._lastTopMsgId
  if (!id || !run._turnMsgs) return
  if (run._turnMsgs.get(id)) { run._barrenStreak = 0; return }
  run._barrenStreak = (run._barrenStreak || 0) + 1
  if (run._barrenStreak < BARREN_ABORT_STREAK) return
  markPoisoned(run, `连续 ${run._barrenStreak} 条消息只有思考、没有任何文本或工具调用`)
  if (allowAbort) { try { run._abort?.abort() } catch { } }
}

// 空想失控刹车：单条消息思考量破顶 → 掐断这条 query。每轮只掐一次（掐完 handleStreamEnd 会带纠偏 resume；
// 再破顶说明纠偏没用，那就让空转/中毒那套接手，别在这儿反复掐）。
// 注意与「会话中毒」的分工：这里掐的是**还没坏的会话**（掐早了，巨型思考块进不了 transcript），所以用 resume
// 续跑、不换会话；已经吐出过零产出消息的才归 markPoisoned 管。
function brakeRunawayThinking(run, est) {
  if (run._thinkAborted) return
  run._thinkAborted = true
  run._thinkNudge = true
  appendEvent(run.id, { type: 'lab', text: `✂️ 单条消息已连续思考约 ${Math.round(est / 1000)}k token（顶 ${Math.round(THINKING_RUNAWAY_TOKENS / 1000)}k），判为空想失控——当场掐断，马上带一句「别再空想、直接动手」续跑。（不掐的话它会一路烧到输出上限 64k 然后零产出收场，还会把这坨思考写进会话历史带坏后续，见 §3.109）` })
  broadcast({ type: 'run-think-braked', runId: run.id, employee: run.employee, estimated: est })
  try { run._abort?.abort() } catch { }
}

// 打「会话中毒」标 + 落红灯。真正的换会话动作在 handleStreamEnd 的中毒分支（流收束后才好换 query）。
function markPoisoned(run, why) {
  if (run._poisoned) return
  run._poisoned = true
  run._poisonWhy = why
  appendEvent(run.id, { type: 'lab', text: `🧪 判定会话状态已坏：${why}。这条 transcript 已被它自己的空转样例污染，resume 只会把坏样例重新喂回去——弃用它，换一条干净会话接着做。` })
}

// 消费一条 query 的消息流：透传事件 + 派生活动；每个 result = 一轮收工。
async function consumeStream(run, q, kind) {
  try {
    for await (const msg of q) {
      if (run.engineHandoverPending) {
        const ev = normalizeEvent(msg, run)
        if (ev) appendEvent(run.id, ev)
        continue // 收束中的旧流只留历史，不收工/重试/接棒
      }
      run._lastActivity = Date.now()
      if (msg.session_id) { run.sessionId = msg.session_id; run.engineHandoverSeed = undefined }
      if (msg.type === 'system' && msg.subtype === 'init' && msg.model && !run.model) run.model = msg.model
      // SDK 内部「无可见输出」自催：claude.exe 在一轮内检测到模型只思考没产出，注入一条 user 消息
      // （[Your previous response had no visible output. Please continue…]）逼它再说。normalizeEvent 把这类无
      // tool_result 的 user 消息当输入回显丢弃、不落库，但它是「本轮在空转」的铁证——在这里先数一笔，供下方 result
      // 兜底判据用（≥SILENT_SPIN_NUDGES 次 = 空转，别拿残留旧文本假绿）。只认「no visible output」这条精确信号，
      // 不认泛化的续跑提示（那类可能是正常 resume，误计会伤合法长活，2026-08-09 事故复盘用真实会话校准过阈值）。
      if (msg.type === 'user') {
        const uc = msg.message?.content
        const utext = typeof uc === 'string' ? uc : (Array.isArray(uc) ? uc.filter(b => b && b.type === 'text').map(b => b.text || '').join('') : '')
        if (/no visible output/i.test(utext)) run._sdkNudges = (run._sdkNudges || 0) + 1
      }
      if (msg.type === 'assistant') {
        // SDK 后台 settle 后自动续跑：没走 beginTurn，本轮计数器不会归零 → 首个 assistant 到达时补一次归零，
        // 免得上一轮的零产出轮次串到这一轮（跨轮累加会把正常的自续误判成空转）。
        if (!run._turnActive) { run._turnMsgs = new Map(); run._sdkNudges = 0 }
        run._turnActive = true   // 见到 assistant 消息即视作前台 turn 在跑（含 SDK 后台完成后的自动续跑）——供 scheduleBgResume 去重
        // 排队消息真被接受：本轮 result 后、下一轮首个 assistant 到达 = SDK 已 coalesce 进这轮开跑 → 清掉之前排队气泡的「排队中·忙完就接」标
        if (run._acceptQueuedOnNextAssistant) {
          run._acceptQueuedOnNextAssistant = false; run._pendingQueuedAccept = 0
          appendEvent(run.id, { type: 'queued-accepted' })
        }
        if (run.status !== 'running') {   // SDK 在后台 settle 后自动续跑：没走 beginTurn，状态还停在 done → 补一次 running，让看板如实显示「在工作」（onTurnComplete 会在本轮结束再置 done）
          run.status = 'running'; clearTimeout(run._idleTimer); run.updatedAt = new Date().toISOString(); saveRegistry()
          broadcast({ type: 'run-status', runId: run.id, employee: run.employee, status: 'running' })
        }
        // 累积本轮 assistant 说过的文本：拼本条消息所有 text 块，非空则覆盖（后到覆盖 → 留最后一段作收尾候选）。
        // 供下方 result 为空时兜底——模型明明回复了、只是结尾停在思考/工具块，别误判成空收工。
        const blocks = msg.message?.content || []
        const t = blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join('')
        if (t.trim()) run._turnText = t
        run._thinkBase = run._thinkLastEst || 0   // 一个内容块已定稿 → 空想刹车的基线前移（顶始终是"这一段连续思考 30k"，不是全轮累计）
        // 「零产出轮次」计数（2026-08-24 追加，见下方 barrenTurns 缘起）：只数**顶层**消息（子 agent 的 parent_tool_use_id
        // 非空 → 不计，它自己那轮空转与本轮收尾无关）。SDK 会把一条 assistant 消息按内容块拆成多次透传（thinking 一次、
        // tool_use 再一次，message.id 相同），故必须按 message.id 归并，否则「先思考后调工具」的正常消息会被误记成空转。
        if (!msg.parent_tool_use_id && msg.message?.id) {
          run._turnMsgs = run._turnMsgs || new Map()
          const produced = !!t.trim() || blocks.some(b => b && b.type === 'tool_use')
          run._turnMsgs.set(msg.message.id, (run._turnMsgs.get(msg.message.id) || false) || produced)
          // 顶层消息换 id ＝上一条已定稿 → 当场结算，别再等到轮末 result（那时 CLI 早已追加两三条坏样例进 transcript）
          if (run._lastTopMsgId && run._lastTopMsgId !== msg.message.id) finalizeTopMsg(run)
          run._lastTopMsgId = msg.message.id
        }
        // E1 三红灯记账：守航态才走（共驾态零开销）。**在这里观测而不在 canUseTool**——
        // 员工多为 bypassPermissions，SDK 在咨询回调前就放行了，那条路是死代码；tool_use 流是唯一
        // 能覆盖全部权限模式的观测点。子 agent 的调用也算（parent_tool_use_id 非空照记：越权就是越权，
        // 换个 subagent 的马甲不该洗白）。
        if (run.executionMode === 'guarded_run') {
          for (const b of blocks) if (b && b.type === 'tool_use') { try { observeGuardToolCall(run, b.name, b.input) } catch (e) { console.warn('[guard] 记账异常:', e.message) } }
        }
        // 看图门记账（视觉初筛 / 审美判定核「真看过图」用），只记 Read 图片，开销可忽略
        for (const b of blocks) if (b && b.type === 'tool_use' && b.name === 'Read') noteImageRead(run.id, b.input)
      }
      // SDK 控制消息（后台任务追踪 / 思考心跳）：内部消化、不落 jsonl；已处理则跳过常规透传。
      if (msg.type === 'system' && handleControlMsg(run, msg)) continue
      if (msg.type === 'result') {
        finalizeTopMsg(run, false)   // 补结算最后一条顶层消息（它没有"下一条"来触发结算），再判空转
        run._turnActive = false
        if (run._pendingQueuedAccept > 0) run._acceptQueuedOnNextAssistant = true   // 本轮收尾 → 排队消息将由下一轮 coalesce 接手，待其首个 assistant 到达即清排队标
        let r = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result ?? '')
        run._resultFromFallback = false
        // 兜底：本轮有实说文本、只是结尾停在思考/工具块 → 取它当收尾，不误判空收工。
        // 但若本轮 SDK 已「无可见输出」自催 ≥SILENT_SPIN_NUDGES 次 = 空转（早期吐了句没用的一行、随后反复只思考没产出
        // 收尾）——那段残留文本不是收尾、是陈旧噪声，别拿它假绿掩盖空转（2026-08-09 事故根因，见复盘）。此时保持 r 空，
        // 落到下方 onTurnComplete 的空收工红灯 + _emptyStreak 累加。
        const spun = isSpunTurn(run)
        if (!String(r).trim() && String(run._turnText || '').trim() && !spun) {
          r = run._turnText
          run._resultFromFallback = true
        }
        run.result = r
        run.isError = msg.is_error !== undefined ? !!msg.is_error : (msg.subtype !== 'success')
        // E1 ②：token / 运行时长在 result 上收口 → 重算 over_budget。契约 max_tokens 为 null 时
        // 也如实记一条 budget_unset（方案点名「max_tokens 四轮全空」——空白不该静默消失）。
        if (run.executionMode === 'guarded_run') { try { observeGuardUsage(run, msg) } catch (e) { console.warn('[guard] 预算记账异常:', e.message) } }
      }
      const ev = normalizeEvent(msg, run)
      if (ev) {
        appendEvent(run.id, ev)
        trackSubAgents(run, ev)            // 顶层 Task/Agent → 记子代理，供活动分层归属
        const act = deriveActivity(ev, run)  // 进行时活动：变化才广播（天然限流）
        if (act && act !== run.activity) {
          run.activity = act
          broadcast({ type: 'run-activity', runId: run.id, employee: run.employee, activity: act })
        }
      }
      if (msg.type === 'result') onTurnComplete(run, kind)   // 落 done/接棒；query 不关，留空闲窗等下轮
    }
    handleStreamEnd(run, null, kind)   // 输入通道 close → 优雅收束
  } catch (err) {
    handleStreamEnd(run, err, kind)    // abort / 连接中断 / 崩溃
  }
}

// ---------- 发布沟通「四件交付物」核对（单一事实源，三处闸口复用：收工软门禁 / DONE 硬门禁 / 巡视事实块）----------
// 缘起 §3.51（2026-08-04）：菲菲做完前三件就收工，漏第 4 件「微信发版通知文案」，故加了软门禁 `releaseCopyCardMissing`。
// 复发 §3.103（2026-08-25，run `20260825075631-27368f`）：波比的派工只点名了**一件**（版本发布说明），菲菲照着派工做完
// 就【交回】——**四件只交了 1 件**。而旧门禁的触发条件是「本轮汇报里同时出现 版本发布说明 + CHANGELOG」＝**做完三件才检查
// 第四件**，这次汇报里压根没有 CHANGELOG 二字 → 门禁静默跳过：**漏得越狠越不报警**。下游波比据此置 DONE、小呆呆巡视判合法收工。
// 现改为按「阶段 + 落盘事实」核对四件（SOP 权威见 roles/feifei.md §⑤），一份结论喂给三处闸口，不再靠汇报里的关键词自证。
const RELEASE_COMMON_DIR = '00-通用资料'                              // 版本目录的兄弟目录，放跨版本累积的两份台账
const RELEASE_CHANGELOG_FILE = '示例项目-版本变更日志(CHANGELOG).md'
const RELEASE_PERMLOG_FILE = '示例项目-权限变更记录(配置员).md'
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasCodeCard = t => /```olcard[\s\S]*?"type"\s*:\s*"code"[\s\S]*?```/.test(String(t || ''))   // code 形态 olcard＝自带复制按钮
const sameArchive = (a, b) => !!a && !!b && path.basename(String(a)) === path.basename(String(b))   // taskFile 可能是 L 前缀/仓内相对两种写法
// 第 4 件「只打印在收工汇报、不落盘」，磁盘上查无实据 → 只能回扫本任务线里菲菲各轮的收尾原文。
// runs 注册表只增不减（仅手动删会话），故历史轮照样查得到；extraText 给「本轮刚收工、尚未落库」的场景兜底。
function releaseNoticePrinted(taskFileRel, extraText = '') {
  if (hasCodeCard(extraText)) return true
  for (const r of Object.values(runs)) {
    if (r.employee !== 'feifei' || isConsult(r) || !sameArchive(r.taskFile, taskFileRel)) continue
    if (hasCodeCard(r.result)) return true
  }
  return false
}
// 核对四件。返回 null＝**不适用**（非版本任务 / 定位不到版本目录 / 没有那两份通用台账）——宁可不判，绝不误挡无关任务。
// 版本目录锚点取 frontmatter 的 facet_doc（`docs/示例项目需求/06-v5.19/…`），不另存一份路径配置、不 hardcode 版本目录名。
// 多份时取第一项（主文档排头；储备文档在 00-通用资料/ 下、指不到版本目录）。
function releaseDeliverableCheck(taskFileRel, extraText = '') {
  if (!taskFileRel) return null
  let fm
  try { fm = parseFrontmatter(fs.readFileSync(safeResolve(taskFileRel), 'utf8')) || {} } catch { return null }
  const version = String(fm.version || '').trim()
  const facetDoc = primaryFacetDoc(fm).replace(/\\/g, '/')
  if (!version || !facetDoc.includes('/')) return null
  // 四件是**上线之后**才欠的（SOP §⑤ 从「波比通知上线完成」起算）。没发过线上的版本（被取消/合并进别版/还在研）
  // 一律不适用——否则 `set_task_status → CLOSED` 归档一个作废版本会被这道闸无理由挡住。
  if (fm.gates?.released_prod !== true) return null
  const versionDir = facetDoc.slice(0, facetDoc.lastIndexOf('/'))
  const docsRoot = versionDir.slice(0, versionDir.lastIndexOf('/'))
  if (!docsRoot) return null
  const changelogRel = `${docsRoot}/${RELEASE_COMMON_DIR}/${RELEASE_CHANGELOG_FILE}`
  const permRel = `${docsRoot}/${RELEASE_COMMON_DIR}/${RELEASE_PERMLOG_FILE}`
  const changelogAbs = resolveRepoFile(changelogRel), permAbs = resolveRepoFile(permRel)
  if (!changelogAbs || !permAbs) return null      // 这套通用资料不在 → 该任务不走示例项目发布沟通口径
  const notesRel = `${versionDir}/版本发布说明-${version}.md`
  // 两份台账按版本倒序追加，条目形如 `## v5.19 · 2026-08-25`；`(?![\w.])` 防 v5.1 误命中 v5.19
  const hasSection = abs => { try { return new RegExp(`^##\\s+${escapeRe(version)}(?![\\w.])`, 'm').test(fs.readFileSync(abs, 'utf8')) } catch { return false } }
  const items = [
    { key: 'notes', label: '① 版本发布说明', ok: !!resolveRepoFile(notesRel), where: notesRel },
    { key: 'changelog', label: `② CHANGELOG 追加 ${version} 条目`, ok: hasSection(changelogAbs), where: changelogRel },
    { key: 'perm', label: `③ 权限变更记录追加 ${version} 条目（本版无变更也要写「本版无权限变更」占位）`, ok: hasSection(permAbs), where: permRel },
    { key: 'notice', label: '④ 微信发版通知文案（逐条 @ 提出人）', ok: releaseNoticePrinted(taskFileRel, extraText), where: '收工汇报里的 ```olcard {"type":"code","lang":"text"…}（只打印、不落盘）' },
  ]
  return { version, items, missing: items.filter(i => !i.ok) }
}
const releaseMissingLines = chk => chk.missing.map(m => `- ${m.label} —— 应落：${m.where}`).join('\n')
function archiveStatusOf(taskFileRel) {
  try { return String((parseFrontmatter(fs.readFileSync(safeResolve(taskFileRel), 'utf8')) || {}).status || '') } catch { return '' }
}
// 「这个版本已经该交四件了吗」——发布沟通阶段及其之后（含终态）才算数。开发/QA 期四件天然还没有，
// 那时报缺是噪音（会把巡视员导向去逼一个还没轮到这活的人）。
const inReleaseNotesPhase = st => st === 'PM_RELEASE_NOTES' || TERMINAL_STATUS_RE.test(st)
// 收工软门禁（不阻断 autoChain：第 4 件不落盘、卡住反而堵死交回波比的 docs 收尾——§3.51 的取舍不变）。
// 触发从「关键词自证」换成「阶段判定」：档案 status=PM_RELEASE_NOTES 即认定这轮该交四件；旧的关键词路径保留为 OR 分支
// （档案已被推到 DONE、但本轮确在补发布交付物的情形，如 §3.103 的补齐轮），**只加不减、不再有"漏得越狠越不报警"的盲区**。
function releaseTurnMissing(run) {
  if (run.employee !== 'feifei' || run.status !== 'done' || isConsult(run)) return null   // 只读窗聊发布话题不算交付轮，别误报
  const txt = String(run.result || '')
  if (archiveStatusOf(run.taskFile) !== 'PM_RELEASE_NOTES' && !/版本发布说明|发版通知|发版文案|三件套|CHANGELOG/i.test(txt)) return null
  const chk = releaseDeliverableCheck(run.taskFile, txt)
  return chk && chk.missing.length ? chk : null
}

// SDK 侧「模型的工具调用解析不了、重试也失败」的错误签名（原文只有一句英文，需翻成人话，见下方 lab 文案）
const PARSE_FAIL_RE = /tool call could not be parsed/i

// 一轮收工（result 到达；query 仍活）：对齐 v0.1 close 分支③的 done 部分 + 接棒。
function onTurnComplete(run, kind) {
  if (run.engineHandoverPending) return
  // 空收工判定（2026-07-27 事故根因 + 当日复盘修正，run 20260726054047-f0259f）：
  //   现象：模型这一轮没输出收工汇报（`result` 字段为空）——常见于工具报错后未恢复就 end_turn，或整轮结束在思考块上。
  //   原始 bug：当成 done 亮绿灯「✅ 本轮收工」+ appendLessons + autoChain（空 result 无标记 → 静默死停），
  //            用户被绿灯误导、活卡半途没人接。
  //   ❌ 曾试「自动热推纠偏续跑」并已回退：会把 run 锁在 running 数分钟、/reply 409 拒收用户消息，退化的 resume
  //     会话每轮都空 → 从「静默停」放大成「彻底卡死」（当日线上事故）。且 `result` 空 ≠ 没干活（可能中途有文本+
  //     工具、只是结束在思考块上），自动续跑既误判又扰民。
  //   ✅ 现策：空 result → 直接判 error 终态。不绿灯误导、不接棒、不自动续跑；红灯 + 清晰提示 + 推手机，run 立即
  //     回到可交互态（/reply 不再 409），恢复权交回用户（回复「继续」自控节奏重试一轮）。SOP 侧「绝不空手收工/
  //     改长行文档先重读」是事前预防（见各员工红线），此处是事后如实暴露、不再假装成功。
  const emptyStop = !run.isError && !String(run.result || '').trim()
  if (emptyStop) run.isError = true
  // 工具调用泄漏成正文（2026-09-07 事故 run 20260907053624-d858bf）：模型把 `<invoke name="…">…</invoke>`
  // **当文本写出来**而没产出真 tool_use → 那一步压根没执行，可这一轮 result 非空、标记也齐，旧引擎照旧发
  // 「✅ 本轮收工」绿灯。那条 run 4 轮结尾都是假调用，末轮丢的是 `set_entry_status`（v5.22 看板回写全丢）。
  // 处置对齐 07-27 空收工那套（老板 09-07 拍板）：**判未正常收工 + 点名具体工具 + 推手机，不自动续跑**
  // —— 「自动热推纠偏续跑」踩过线上事故已回退，别再来一遍；恢复权交回老板，回复「继续」即重做那一步。
  const leaked = run.isError || isConsult(run) ? [] : stallGuard.leakedInvocations(run.result)
  if (leaked.length) { run.isError = true; run.leakedInvoke = leaked } else if (run.leakedInvoke) delete run.leakedInvoke
  run.status = run.isError ? 'error' : 'done'
  run.stalled = false; run._retries = 0; run._userStopped = false; run.activity = ''; run._queuedCount = 0
  run.updatedAt = new Date().toISOString()
  // 连续空转熔断（2026-07-28 追加）：真·空收工（纯思考、零文本）才累加；任何非空 done（含兜底取文本）归零。
  // ≥2 轮连空 → 基本可判会话状态已坏，把提示从「回复继续重试」升级为「别再续、请新开」，避免用户在坏会话里死循环点「继续」。
  // 2026-08-09 扩：兜底假绿已被空转闸拦下（见上），这类「早期一句旧话 + 反复自催空转」的轮如今照 emptyStop 累加、不再归零。
  run._emptyStreak = emptyStop ? (run._emptyStreak || 0) + 1 : 0
  // GG Bond 收工 → 异步刷新 UI 状态契约（他是唯一改前端的员工；流水线顺序在迷糊之前，故她开工时必然拿到最新）。
  // fire-and-forget + 5min 防抖，绝不阻塞本轮收尾；前端仓不在本机时静默跳过。见 refreshUiContract 缘起。
  if (run.employee === 'ggbond' && !isConsult(run)) refreshUiContract('ggbond-turn-end')
  const spun = emptyStop && isSpunTurn(run)   // 本轮空收工是「反复请求仍无产出」的空转（自催次数 或 零产出轮次，见 isSpunTurn）
  const spinWhy = (run._sdkNudges || 0) >= SILENT_SPIN_NUDGES
    ? `SDK 已内部催促续跑 ${run._sdkNudges} 次`
    : `模型连出 ${barrenTurns(run)} 轮纯思考（无文本、无工具调用）`
  const fallbackDone = run.status === 'done' && run._resultFromFallback
  // 空转 ＝ 会话已被自己的空转样例污染 → 打中毒标，恢复动作是「换会话」而不是「resume 同一条」（§3.109）。
  // 判定放在落红灯之前，好让下面那条提示如实说出引擎接下来要做什么。
  if (spun) markPoisoned(run, spinWhy)
  if (run.status === 'done') { run._spinReseeds = 0; run._poisoned = false }   // healthy 一轮＝新会话确实活着，自动重开额度还回去
  const willReseed = canAutoReseed(run)
  const bgN = run._bgTasks?.size || 0   // 本轮 result 收工、但仍有后台任务在跑 → 不是真「空闲」，如实标注「后台运行中」
  const bgSuffix = bgN > 0 ? `　⏳ 仍有 ${bgN} 个后台任务在跑，结果回来会自动接着做` : ''
  appendEvent(run.id, {
    type: 'lab',
    text: run.status === 'done'
      ? (fallbackDone
        ? '✅ 本轮收工（模型结尾停在思考块，已取本轮回复内容展示；可在下方继续回复/拍板）' + bgSuffix
        : '✅ 本轮收工（可在下方继续回复/拍板）' + bgSuffix)
      : (leaked.length
        ? `⚠️ 本轮未正常收工：结尾把 ${leaked.length} 个**工具调用写成了正文**、并没有真的执行（${leaked.join('、')}）。这类假调用零副作用——看板回写 / 对账 / 命令**都没发生**，别按汇报的字面相信它。已停下、恢复权交回你：回复「继续」让它用真正的工具调用重做那一步（引擎不自动续跑，见 CHANGELOG 2026-09-07）。`
        : emptyStop
        ? (willReseed
          ? `⚠️ 本轮空转未收工：${spinWhy}。引擎判这条会话状态已坏，正在**换一条干净会话**接着做（带任务档案 + 进度快照交接，不从头重来）——不用你点「继续」。`
          : (run._poisoned
            ? `⚠️ 换过会话仍空转（${spinWhy}），自动重开额度已用尽。已停下、恢复权交回你：回复任意内容会**再换一条干净会话**重试（不会 resume 坏会话）；也可以直接新开话题重新派工。`
            : '⚠️ 本轮未正常收工：没有输出收工汇报（常见于工具报错后未恢复，或整轮结束在思考块上）。已停下、可继续操作——回复「继续」重试一轮。'))
        // 工具调用「格式坏了」——SDK 自己报的错，原文只有一句英文（老板 2026-09-07：「这是什么情况，太吓人了」）。
        // 它是 §3.117 那个「假调用」的**响亮版**：同样是调用被当正文写出，只不过这次写到一半截断、SDK 试着
        // 解析又重试一次仍失败（会话里那两条一模一样的话就是重试留下的），于是干脆报错收场。
        // 相比静默版（正文留着、零执行、还发绿灯）这个反而诚实；但那句英文原文对老板毫无信息量，必须翻成人话：
        // 本轮零动作 + 怎么恢复 + 已知诱因（一条 Bash 塞超长复合命令 + 嵌套引号最容易触发）。
        : PARSE_FAIL_RE.test(String(run.result || ''))
        ? `⚠️ 本轮未正常收工：**模型这次的工具调用格式坏了**（SDK 原文：${String(run.result || '').trim()}）——调用被当成正文写出、且写到一半截断，SDK 重试一次仍解析不了。**本轮零动作**：它打算跑的命令与回写一个都没执行（上面那两条重复的话就是重试留下的痕迹）。回复「继续」重来一轮；已知诱因多为「一条 Bash 里塞了超长复合命令 + 嵌套引号」，重来时让它把命令拆短。`
        : '❌ 本轮以错误结束'),
  })
  // 中毒且还有自动重开额度 → 立刻收束当前 query，交给 handleStreamEnd ①.5 换一条干净会话续跑。
  // 不推手机（引擎正在自愈，别拿一条「员工停了」的通知吵醒老板）、不接棒（空 result 本就无棒可交）、
  // 不排空闲窗（马上就要重开）。真换不动了才会走到下面的终态那套。
  if (willReseed) {
    saveRegistry()
    broadcast({ type: 'run-status', runId: run.id, employee: run.employee, status: run.status, resultTail: '' })
    clearTimeout(run._idleTimer)
    if (run._input) run._input.close()   // gen() return → consumeStream 收束 → handleStreamEnd → reseedPoisoned
    else reseedPoisoned(run)             // query 已不在（异常态）→ 直接重开
    return
  }
  if (run.status === 'done' && !isConsult(run)) appendLessons(run)   // 教训自动沉淀（只读窗不写 memories/：它连写工具都没有，教训该由正式会话沉淀）
  const relMissing = releaseTurnMissing(run)      // 发布沟通收尾自检（软门禁）：四件缺哪件报哪件 → 告警不拦交接
  if (relMissing) {
    appendEvent(run.id, { type: 'lab', text: `⚠️ 发布沟通收尾自检：${relMissing.version} 的 PM_RELEASE_NOTES **四件交付物**还缺 ${relMissing.missing.length} 件（SOP roles/feifei.md §⑤，引擎按落盘事实核对、不看汇报措辞）：\n${releaseMissingLines(relMissing)}\n\n派工只点名了其中一件**不等于**只交一件——四件是一个版本一次的整包。补齐后任务才可置 DONE（置 DONE 有硬门禁会拦）。` })
  }
  // ---- E5/G1 · 收工即校验（把判据从"事后派巡视"挪到"收工那一刻"）----
  // 缘起（方案 §1 E5）：小呆呆在观测窗口内被派 **79 次、只有 2 次是真停** —— 97% 是浪费，因为引擎
  // 事后才发现「收工没写标记」，然后派一个 agent 去读收尾原文猜它当时该做什么。而这件事**在收工那一刻
  // 就能机器判**。这里当场拒收并回灌具体提示；小呆呆保留，但只处理「标记写了但语义可疑」的模糊态
  // （QA 空心停靠 / 发布交付物未齐 / 交接被吞 / 声称等待却给不出句柄）。
  if (signoffRejectIfNeeded(run)) return   // 已回灌续跑：本轮不置终态、不接棒、不推送
  saveRegistry()
  broadcast({ type: 'run-status', runId: run.id, employee: run.employee, status: run.status, resultTail: (run.result || '').slice(-200) })
  maybePushRunStopped(run)   // 员工停下 → 按配置推送到手机
  scheduleIdleClose(run)     // 空闲窗后 close 释放子进程
  // 混合扳机：无拍板则自动派下一棒（error 态天然不接棒）；接棒判完再看待处理队列能不能提前排空
  run._chainPromise = Promise.resolve(autoChain(run)).catch(e => console.error('[autoChain]', e)).finally(() => {
    if (run.engineHandoverPending) return
    drainPendingAfterTurn(run)
    // 守航目标循环：接棒判完之后再排一次「这一轮干完没」（防抖，给 autoChain 刚派出的下一棒留出开工时间）
    if (!isConsult(run)) scheduleGuardGoalTick(run)
  })
}

// 收工即排空待处理队列，不等 IDLE_CLOSE_MS 空闲窗关流（2026-09-28 老板：「上个会话结束很久排队的消息还没发过去」——
// 原先只在 handleStreamEnd 排空，一条收工的会话要再空等 3 分钟、有后台任务更是无限期，排队的活就一直挂着）。
// 两种情况仍留给关流时排空：① 还有后台任务——它 settle 后 SDK 会自动续跑这条会话，提前起新会话就是同一员工两条并跑；
// ② 巡视宽限窗未决——小呆呆可能把它续跑回去，同理。autoChain 若已接棒给自己（status 回 running），busyRunFor 自然挡住。
function drainPendingAfterTurn(run) {
  if (!pendingQueues[run.employee]?.length || isConsult(run)) return
  if (run.status === 'running' || run._bgTasks?.size) return
  if (_graceTimers.has(run.id) || run.patrolGraceUntil) return
  drainPending(run.employee)   // 按工作区判忙在 drainPending 里做（别的工作区空着就能出队）
}

// 收工标记当场校验 + 回灌。返回 true＝已回灌（调用方立即 return，别走终态那套）。
// 边界（刻意收窄，宁可少拒也不误拒——误拒会把正常收工卡成死循环）：
//   · 只管 `dispatch` 轮：`chat` 是老板在跟员工对话，回一句话不需要机器标记；
//   · 只读窗不管（它连写工具都没有，本就不进流水线）；
//   · error / 空收工不管（那条路已有空转熔断与红灯，见上方 emptyStop）；
//   · **每条会话最多拒 2 次**，之后照旧走巡视 —— 拒收本身也可能判错，不许无限循环。
const SIGNOFF_REJECT_MAX = 2
function signoffRejectIfNeeded(run) {
  if (run.status !== 'done' || isConsult(run) || (run.lastKind === 'chat' && !run._turnRequiresSignoff)) return false
  // 非流水线角色（巡视 / 审计）豁免：它们的产出本身就是结论、无棒可交。
  // 判据来自真实存量数据（604 条历史收工里它们的拒收率 47.8% / 100%），理由见 stall-guard.js 该常量注释。
  if (stallGuard.SIGNOFF_EXEMPT_EMPLOYEES.has(run.employee)) return false
  if ((run._signoffRejects || 0) >= SIGNOFF_REJECT_MAX) return false
  const handles = [...(run._bgTasks?.keys() || [])].map(String)
  const v = stallGuard.validateSignoff(run.result, { employeeName: EMPLOYEES[run.employee]?.displayName || run.employee, handles })
  if (v.ok) {
    // G3：声称在等待但给不出可查句柄 → 立刻升级，不当合法等待（这一支只打标，交给巡视按模糊态处理）
    if (v.code === 'waiting') appendEvent(run.id, { type: 'lab', text: `⏳ 合法等待停靠：${v.why}（不判空停）` })
    return false
  }
  const wait = stallGuard.classifyWait(run.result, handles)
  if (wait.escalate) {
    // 句柄丢了还在等：不回灌（回灌它还是会接着等），标成模糊态让巡视升级
    run.waitNoHandleSig = run.updatedAt
    appendEvent(run.id, { type: 'lab', text: `🚨 ${wait.why}` })
    return false
  }
  // query 已关（空闲窗到点 / 崩溃）→ 回灌不了，别假装拒收成功：让它照旧走终态 + 巡视兜底。
  if (!run._input) return false
  run._signoffRejects = (run._signoffRejects || 0) + 1
  run.signoffRejects = run._signoffRejects     // 非 _ 前缀→落库，看板能看见「被拒收过几次」
  appendEvent(run.id, { type: 'lab', text: `⛔ 收工被引擎当场拒收（第 ${run._signoffRejects}/${SIGNOFF_REJECT_MAX} 次）：${v.why}。已把具体要求回灌，本轮不算收工、不派巡视（E5：判据挪到收工那一刻，别再事后派 agent 猜）。` })
  broadcast({ type: 'signoff-rejected', runId: run.id, employee: run.employee, code: v.code, attempt: run._signoffRejects })
  // 进度快照一并回灌：拒收后最怕它「从头重来」（老板 08-24 连喊 3 次）。beginTurn 会把状态顶回 running。
  pushTurn(run, stallGuard.renderResumeSnapshot(run._snapshots || (run.lastSnapshot ? [run.lastSnapshot] : [])) + v.nudge, 'dispatch')
  saveRegistry()   // beginTurn 不落库；不存的话「被拒收过几次」重启即失忆，SIGNOFF_REJECT_MAX 会被绕过
  broadcast({ type: 'run-status', runId: run.id, employee: run.employee, status: 'running' })
  return true
}

// 收工后空闲 IDLE_CLOSE_MS 未再有新一轮 → 优雅 close，释放子进程（下次回复自然 resume 冷起）
function scheduleIdleClose(run) {
  clearTimeout(run._idleTimer)
  if (run._bgTasks?.size) return   // 后台任务在跑：保持 query 存活（close = gen() return = 杀子进程 = 杀后台任务）。等 syncBgTasks 见后台清空后再排空闲窗。
  run._idleTimer = setTimeout(() => {
    if (run.status !== 'running' && !run._bgTasks?.size && run._input) run._input.close()   // gen() return → consumeStream 走 handleStreamEnd(null)
  }, IDLE_CLOSE_MS)
}

// 释放一条 run 的活跃句柄
function clearLive(run) {
  clearTimeout(run._idleTimer)
  run._q = null; run._input = null; run._abort = null
  liveRuns.delete(run.id)
}

// ---------- 中毒会话换会话重开（§3.109）----------
function holdHandoverMessage(run, prompt, kind, userText = '') {
  ;(run.handoverInbox ||= []).push({ prompt, kind, userText })
  saveRegistry()
}

function handoverSeedFor(run, note = '') {
  return buildHandoverSeed(run, tailRunEvents(run.id), note)
}

async function transferRunEngine(run, request) {
  return handoverRun(run, request, {
    engineIds: activeEngineIds(),
    checkBusy(target) {
      // Ignore the target's own reservation, but check every other live run.
      for (const other of Object.values(runs)) {
        if (other.id === target.id || isConsult(other) !== isConsult(target) || other.employee !== target.employee) continue
        if (!other.engineHandoverPending && !(liveRuns.has(other.id) && ['running', 'starting'].includes(other.status))) continue
        if (isConsult(target) || LANE_SERIAL_EMPLOYEES.has(target.employee) || laneKeyOf(other) === laneKeyOf(target)) throw new HandoverError('该员工在同一工作区还有任务运行，请先处理另一条任务')
      }
    },
    save: saveRegistry,
    cancel(target) {
      cancelGracePatrol(target, 'engine-handover')
      clearTimeout(target._idleTimer)
      for (const entry of pendingPerms.values()) if (entry.runId === target.id) entry.resolve({ behavior: 'deny', message: '基座交接，取消旧审批' })
      target._abort?.abort()
      target._input?.close()
      appendEvent(target.id, { type: 'lab', text: '正在交接基座：停止旧执行流与自动重试…' })
    },
    buildSeed: handoverSeedFor,
    event(target, text) {
      appendEvent(target.id, { type: 'lab', text })
      broadcast({ type: 'run-status', runId: target.id, employee: target.employee, status: target.status, engine: target.engine })
    },
    start(target) {
      const guarded = target.executionMode === 'guarded_run' ? guardedRunPreamble() : ''
      startRun(target, guarded, { kind: target.lastKind || (isConsult(target) ? 'consult' : 'dispatch'), resume: false })
    },
  })
}

// 读一条 run 的 jsonl 尾部（换会话播种用）。文件可能很大，只取尾部 maxBytes，并丢掉被截断的首行。
function tailRunEvents(runId, maxBytes = 400_000) {
  try {
    const file = path.join(RUNS_DIR, `${runId}.jsonl`)
    const size = fs.statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - start)
    try { fs.readSync(fd, buf, 0, buf.length, start) } finally { fs.closeSync(fd) }
    let s = buf.toString('utf8')
    if (start > 0) s = s.slice(s.indexOf('\n') + 1)
    return s.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

// 换会话的**交接播种**：新会话一张白纸，得把「在做什么 / 做到哪了 / 已经动过什么」交代清楚，
// 否则冷起会从头重来（G2 那次事故的教训：只说一句"接着上次做"等于让它自己回忆）。
// 素材全部取自引擎侧事实（run jsonl + 进度快照 + 任务档案路径），不依赖模型的记忆。
function buildReseedPrompt(run, extra = '') {
  const ev = tailRunEvents(run.id)
  let instruction = ''
  for (let i = ev.length - 1; i >= 0; i--) if (ev[i].type === 'user-msg' && String(ev[i].text || '').trim()) { instruction = String(ev[i].text).trim(); break }
  const said = []
  for (let i = ev.length - 1; i >= 0 && said.length < 2; i--) {
    const o = ev[i]
    if (o.type !== 'assistant' || o.parent_tool_use_id) continue
    const t = (o.message?.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join('').trim()
    if (t) said.unshift(t.slice(0, 800))
  }
  let acts = []
  for (let i = ev.length - 1; i >= 0 && acts.length < 40; i--) {
    const o = ev[i]
    if (o.type !== 'assistant') continue
    for (const b of (o.message?.content || [])) {
      if (b?.type !== 'tool_use') continue
      const arg = b.input?.file_path || b.input?.path || b.input?.command || b.input?.pattern || ''
      acts.unshift(`${b.name}${arg ? ' · ' + String(arg).slice(0, 140) : ''}`)
    }
  }
  acts = acts.slice(-15)
  const snap = stallGuard.renderResumeSnapshot(run._snapshots || (run.lastSnapshot ? [run.lastSnapshot] : []))
  const parts = [
    '【系统 · 换会话续跑】上一条会话反复只思考、不产出任何回复或工具调用（状态已坏），引擎已弃用它并为你开了一条**干净会话**。',
    '这不是重新派工：活儿只做了一半，请**接着做完**，不要从头重来、不要重复已经落盘的改动。',
    run.taskFile ? `\n【任务档案（唯一状态源，先读它对齐进度）】\n${run.taskFile}` : '',
    instruction ? `\n【本条会话在做的事（最后一条指令原文）】\n${instruction.slice(0, 1500)}` : '',
    said.length ? `\n【你上次说到哪（你自己的最后几段话）】\n${said.join('\n---\n')}` : '',
    acts.length ? `\n【你最近动过的工具（已经做过的别重做，但请核实落盘结果）】\n· ${acts.join('\n· ')}` : '',
    snap ? `\n${snap}` : '\n【提醒】本会话没落过进度快照——这轮先用 `progress_snapshot` 落一条，下次换会话引擎就能把它注回来。',
    '\n【先做这一步】先核实上面这些改动在磁盘上的真实状态（读文件、跑校验），再决定下一步；然后正常把这一轮做完并收工汇报。',
    extra ? `\n【老板刚说】\n${String(extra).trim()}` : '',
  ]
  return parts.filter(Boolean).join('\n')
}

function canAutoReseed(run) {
  return !!run._poisoned && !shuttingDown && !run._userStopped && (run._spinReseeds || 0) < MAX_SPIN_RESEEDS
}

// 弃用中毒 sessionId，起一条全新会话并把交接播种进去。auto=false ＝老板亲自点的重试，不吃自动上限。
function reseedPoisoned(run, extra = '', { auto = true, userText = '' } = {}) {
  const dead = run.sessionId
  run._poisoned = false; run._poisonWhy = ''
  run._barrenStreak = 0; run._lastTopMsgId = null; run._turnMsgs = new Map()
  run._retries = 0; run._userStopped = false
  run._emptyStreak = 0            // 换会话＝换病灶，连空计数从头算，否则新会话第一轮就被判「已连续空转 N 轮」
  run._spinReseeds = auto ? (run._spinReseeds || 0) + 1 : 0
  run.sessionId = null            // 关键：清掉才不可能被 resume；startRun 不带 resume ＝ SDK 起全新会话
  saveRegistry()
  appendEvent(run.id, { type: 'lab', text: `♻️ 已弃用中毒会话${dead ? `（${String(dead).slice(0, 8)}…）` : ''}，换一条干净会话接着做${auto ? `（自动第 ${run._spinReseeds}/${MAX_SPIN_RESEEDS} 次）` : '（你手动触发）'}。任务档案、进度快照、上下文摘要已随交接带过去——不会从头重来。` })
  broadcast({ type: 'run-reseeded', runId: run.id, employee: run.employee, deadSessionId: dead || null, attempt: run._spinReseeds })
  startRun(run, buildReseedPrompt(run, extra), { kind: run.lastKind || 'dispatch', resume: false, userText })
}

// 流结束统一收尾（对齐 v0.1 close 三分支：接管 / 自动续跑 / 终态）。正常 idle-close 时 status 已是 done → 仅清理。
function handleStreamEnd(run, err, kind) {
  clearLive(run)
  if (run.engineHandoverPending) return
  if (shuttingDown) { if (run.status === 'running' || run.status === 'starting') run.status = 'interrupted'; return }
  // ① 用户强制接管（僵尸 run /reply 暂存的消息）：优先投递，越过自动续跑
  if (run._takeoverPrompt) {
    const tp = run._takeoverPrompt
    run._takeoverPrompt = null; run._userStopped = false; run._retries = 0
    // 会话已中毒时接管也别 resume 它（resume ＝ 把坏样例重新喂回去）：改成换会话重开，老板那句话作为「刚说」附在交接后面
    if (run._poisoned) { reseedPoisoned(run, tp.prompt, { auto: false, userText: tp.userText || '' }); return }
    appendEvent(run.id, { type: 'lab', text: '🔧 接管卡死会话，投递你的消息并续跑' })
    startRun(run, tp.prompt, { resume: true, kind: tp.kind, userText: tp.userText || '' })
    return
  }
  // ①.5 会话中毒 → 弃用 transcript、换干净会话续跑（优先于 ②：② 是 resume 老会话，正是这里要避免的）
  if (canAutoReseed(run)) { reseedPoisoned(run); return }
  // ①.6 空想失控被掐断 → 同会话 resume（掐得早，那坨巨型思考块没进 transcript，会话本身还没坏），
  //     但必须带一句明确纠偏：只说「继续」它很可能接着想下去。
  if (run._thinkNudge && run.sessionId && !run._userStopped) {
    run._thinkNudge = false
    run._retries = (run._retries || 0) + 1
    if (run._retries <= MAX_AUTO_RETRIES) {
      const snap = stallGuard.renderResumeSnapshot(run._snapshots || (run.lastSnapshot ? [run.lastSnapshot] : []))
      appendEvent(run.id, { type: 'lab', text: `🔁 空想失控已掐断，带纠偏续跑 ${run._retries}/${MAX_AUTO_RETRIES}` })
      startRun(run, snap + '【系统】你刚才在一条消息里连续思考超过预算，已被引擎掐断——那一段推演没有留下任何产出。\n现在换个做法：**别再一次性在脑子里推演完整个方案**。立刻动手做下一个最小的具体动作（读一个文件 / 改一处 / 跑一条命令），或者先把已经想清楚的部分说出来。一步一动，每步都留下可见产出。', { resume: true, kind: run.lastKind || 'dispatch' })
      return
    }
  }
  // ② 连接中断 / watchdog 判死 → 自动 resume 续跑（带上限，防烧钱死循环）
  if (shouldAutoRetry(run, err)) {
    const reason = run.stalled ? 'stalled' : 'connection'
    run._retries = (run._retries || 0) + 1
    run.stalled = false
    appendEvent(run.id, { type: 'lab', text: `🔁 ${reason === 'stalled' ? '卡死' : '连接中断'}，自动续跑 ${run._retries}/${MAX_AUTO_RETRIES}` })
    broadcast({ type: 'run-retry', runId: run.id, employee: run.employee, attempt: run._retries, maxRetries: MAX_AUTO_RETRIES, reason })
    // G2 · 注入进度快照而不是让它自己回忆。原来只有「接着上次进度往下做」这句话——**它凭什么知道上次到哪了？**
    // 冷 resume 后上下文已被压缩，那句话等于「你自己想」，于是它从头重来（老板 08-24 连喊 3 次）。
    // 快照优先取内存 _snapshots，跨重启退化到落库的 lastSnapshot（`_` 前缀字段过 stripPrivate 会丢）。
    const snapBlock = stallGuard.renderResumeSnapshot(run._snapshots || (run.lastSnapshot ? [run.lastSnapshot] : []))
    startRun(run, snapBlock + '继续未完成的工作，接着上次进度往下做，不要从头重来。' + (snapBlock ? '' : '（本会话没有落过进度快照 —— 这轮先用 `progress_snapshot` 落一条，下次续跑引擎就能把它注回来，你不必再靠回忆。）'), { resume: true, kind: run.lastKind || 'dispatch' })
    return
  }
  // ③ 终态：仅当流在 turn 未收工(仍 running/starting)时异常结束——用户停=interrupted，其余=error。
  //    正常 idle-close/收工后关闭时 status 已是 done/error，onTurnComplete 已处理，这里不重复。
  if (run.status === 'running' || run.status === 'starting') {
    const retriesExhausted = (run._retries || 0) >= MAX_AUTO_RETRIES
    run.status = run._userStopped ? 'interrupted' : 'error'
    run.activity = ''; run.updatedAt = new Date().toISOString()
    if (run.status === 'error') appendEvent(run.id, { type: 'lab', text: `❌ 会话异常结束${retriesExhausted ? '（已达自动续跑上限）' : ''}${err ? '：' + String(err.message || err).slice(0, 300) : ''}` })
    saveRegistry()
    broadcast({ type: 'run-status', runId: run.id, employee: run.employee, status: run.status, resultTail: (run.result || '').slice(-200), ...(run.status === 'error' && retriesExhausted ? { retriesExhausted: true } : {}) })
    maybePushRunStopped(run)
  }
  const _wasUserStop = run._userStopped
  run._retries = 0; run._userStopped = false
  // 抄送汇合：error/interrupted 到不了 autoChain（那里 done 才往下走），但「子 run 挂了」同样是终态——
  // 发起人照样在等，不能因为子 run 死法不好看就永远不唤（摘要里带上它的 status，由发起人判要不要重派）。
  notifyCcOrigins(run)
  // 它自己也可能是发起人（异常收尾同样该收口）；但**老板亲手按停的**不自动唤回——那是明确的人为中止意图，
  // 由老板自己回话恢复（定时 sweepCcJoins 也只在 24h 窗内兜底，不会把老板停掉的活反复拉起来）。
  if (!_wasUserStop) tryFireCcJoin(run)
  // 该员工这条会话彻底结束、query 已释放（takeover/retry 分支都已提前 return）→ 若它有待处理队列且现已空闲，排空一条
  drainPending(run.employee)   // 按工作区判忙在 drainPending 里做
}

// ---------- 自动接棒（方案 B + 混合扳机） ----------
// 从收工汇报解析机器可读标记。铁律（2026-07-14 两轮踩坑定型）：
//   1) 标记**必须独占一行（行首起）**——指令里常引用/嵌套标记名（如「用你自己的【下一棒】迷糊 把…」），只有行首标记才算数；
//   2) **全文搜索、取最后一条**（不 slice，长 prompt 会把真标记截掉）；
//   3) 指令/报告**支持多行**——从标记行一直吃到下一个标记行(【下一棒】/【交回】/【等你拍板】)或结尾（单行 `[^\n]+` 会把菲菲写的多段 prompt 只截首行）。
const MARKER_LINE_RE = /^[ \t]*(?:【下一棒】|【交回】|【等你拍板】|【教训】)/
// 找最后一个匹配 headRe 的标记行，返回 { m:该行match, rest:[后续续行…直到下一个标记行/结尾] }
function lastMarkerBlock(text, headRe) {
  const lines = String(text || '').split('\n')
  let found = -1, m = null
  for (let i = 0; i < lines.length; i++) { const mm = lines[i].match(headRe); if (mm) { found = i; m = mm } }
  if (found < 0) return null
  const rest = []
  for (let j = found + 1; j < lines.length; j++) { if (MARKER_LINE_RE.test(lines[j])) break; rest.push(lines[j]) }
  return { m, rest }
}
function parsePendingGate(result) {   // 门是单行：【等你拍板】<事项>（无 / 空 = 无门）
  const b = lastMarkerBlock(result, /^[ \t]*【等你拍板】\s*(\S[^\n]*)?$/)
  if (!b) return null
  const item = (b.m[1] || '').trim()
  return (!item || /^无/.test(item)) ? null : item
}
function parseNextHop(result) {
  let b = lastMarkerBlock(result, /^[ \t]*【下一棒】\s*([^｜|\n]+?)\s*[｜|]\s*(.*)$/)   // 带指令（多行）
  if (b) return { who: b.m[1].trim(), instruction: [b.m[2], ...b.rest].join('\n').trim() }
  b = lastMarkerBlock(result, /^[ \t]*【下一棒】\s*([^\n｜|]+?)\s*$/)                    // 裸标记（who 在续行下方）
  if (b) return { who: b.m[1].trim(), instruction: b.rest.join('\n').trim() }
  return null
}
// 【交回】回发：把结果发回「委托你的会话」(resume)，报告支持多行。
//   【交回】@<runId>｜<报告>  → 回发指定会话 ；  【交回】<报告> → 回发委托者(targetRunId=null)
function parseReturnHop(result) {
  let b = lastMarkerBlock(result, /^[ \t]*【交回】\s*@\s*([\w-]+)\s*[｜|]\s*(.*)$/)
  if (b) return { targetRunId: b.m[1].trim(), report: [b.m[2], ...b.rest].join('\n').trim() }
  b = lastMarkerBlock(result, /^[ \t]*【交回】\s*(?!@)(.*)$/)
  if (b) { const report = [b.m[1], ...b.rest].join('\n').trim(); return report ? { targetRunId: null, report } : null }
  return null
}
// 前进(call)：新建一条 run 拉起下一棒，记 callerRunId 供其【交回】回发。
// 由「【下一棒】」正常路径与「裸式【交回】<员工名>｜…」纠偏路径共用，保证两者行为一致。
// 员工→员工发消息在**发送方**会话里留一枚系统胶囊（老板 2026-10-19：「发了信息之后要有 system 胶囊、点了能打开对应会话」）。
// broadcast('handoff') 是瞬时的、只喂看板；这里另落一条持久事件进发送方 transcript，前端渲染成可点开目标会话的胶囊。
// kind: call(下一棒) | cc(抄送) | return(交回) | cc-join(抄送汇合) | self(自续)；toRunId 为空 = 已排队、会话尚未建立。
function emitHandoff(ev, text) {
  broadcast({ type: 'handoff', ...ev })
  if (!ev.fromRunId) return
  try {
    appendEvent(ev.fromRunId, {
      type: 'handoff', kind: ev.selfContinue ? 'self' : (ev.kind || 'call'),
      to: ev.to, toName: EMPLOYEES[ev.to]?.displayName || ev.to, toRunId: ev.runId || null,
      queued: !!ev.queued, merged: !!ev.merged, text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    })
  } catch (e) { console.warn('[emitHandoff] 异常:', e.message) }
}

function spawnForward(run, nextKey, instruction) {
  const instr = instruction || '接棒上一环节工作，请按你的 SOP 推进，完成后回写任务档案。'
  const next = createDispatchRun({ employee: nextKey, taskFile: run.taskFile, instruction: instr, kind: 'dispatch', chainDepth: (run.chainDepth || 0) + 1, callerRunId: run.id })
  emitHandoff({ from: run.employee, to: nextKey, fromRunId: run.id, runId: next.id }, instr)
  if (pushConfig.enabled && pushConfig.on?.done && pushConfig.scope !== 'dispatch') {
    const fromName = EMPLOYEES[run.employee]?.displayName || run.employee
    const toName = EMPLOYEES[nextKey]?.displayName || nextKey
    pushBody(instr, { title: `${fromName}交棒${toName}`, max: 240 })   // fire-and-forget（内含 LLM 精炼+回落）
      .then(body => sendBark({ title: `🔗 ${fromName} → ${toName}`, subtitle: taskShortName(run.taskFile) || undefined, body: body || '（接棒）', icon: empIconUrl(nextKey) }))
  }
  return next
}

// 并发闸：同一员工是否已有在跑的 run（status running/starting）。所有 run 共用一个工作树（cwd: ROOT），
// 同员工两条会话并发 = 并发改同一仓库 → 覆盖彼此的代码/实施记录/档案。故新派工前用它挡住并发。
// 只看 liveRuns（本进程活跃 query），不看 registry——服务重启后 liveRuns 空，不会被历史 running 状态误挡。
// laneKey（2026-09-28 工作区）：给了就按工作区粒度判——同员工在**另一个**工作区的会话不算忙（各改各的 worktree，
// §3.49 那种互相踩写不会发生）。不给 = 原口径（任一在跑都算忙），drainPending / 巡视等保守路径照旧不传。
// LANE_SERIAL_EMPLOYEES（现只剩巡视员）永远按员工串行：它撞的不是工作树，是全局 sweep。
function busyRunFor(employee, laneKey) {
  const perLane = laneKey !== undefined && !LANE_SERIAL_EMPLOYEES.has(employee)
  for (const run of Object.values(runs)) {
    if (run.engineHandoverPending && !isConsult(run) && run.employee === employee && (!perLane || laneKeyOf(run) === laneKey)) return run
  }
  for (const run of liveRuns.values()) {
    if (isConsult(run)) continue   // 只读咨询窗不占员工：它零写能力、撞不到工作树，既不该挡正式派工，也不该被正式会话挡
    if (run.employee === employee && (run.status === 'running' || run.status === 'starting')) {
      if (perLane && laneKeyOf(run) !== laneKey) continue
      return run
    }
  }
  return null
}

// 该员工是否已有在跑的只读咨询窗（成本闸：每人同时只允许一条，语义正好＝"第二个窗口"）
function liveConsultFor(employee) {
  for (const run of liveRuns.values())
    if (isConsult(run) && run.employee === employee && (run.status === 'running' || run.status === 'starting')) return run
  return null
}

// 一条 run 的任务线根（复用既有 idiom，见 supersededBy）——用于「来消息是否同线程」判定
const threadOf = run => (run && (run.threadRootId || run.id)) || null

// 跨线程消息扣进目标员工的待处理队列（不注入其当前会话）。item 由各投递路径构造：
//   { kind:'cc'|'return'|'forward', fromEmployee, text(摘要), deliver:'new'|'resume',
//     resumeRunId?(交回:要 resume 的委托者 run), instruction?(cc/forward:起新 run 的原始指令),
//     prompt?(交回:已拼好的完整 prompt), taskFile?, threadRootId?, chainDepth?, callerRunId?, ccFrom?,
//     executionMode?/guardContract?(守航态与契约：cc 的 callerRunId 恒为 null，靠继承会掉线) }
function queuePending(employee, item) {
  const source = runs[item.callerRunId] || runs[item.ccJoinOrigin] || runs[item.threadRootId]
  item = { ...item, engine: item.engine || (source && engineForRun(source)) }
  const it = { id: 'pend-' + crypto.randomBytes(4).toString('hex'), employee, enqueuedAt: new Date().toISOString(), ...item }
  ;(pendingQueues[employee] ||= []).push(it)
  savePending()
  broadcast({ type: 'pending-changed', employee, count: pendingQueues[employee].length, items: pendingView(employee) })
  return it
}

// 队列项属于哪个工作区：显式 lane > 回发目标会话的 lane > 任务档案绑定的 lane > 主检出
function pendingLaneKey(it) {
  if (it.lane && laneLive(it.lane)) return it.lane   // 入队时的环境已收掉 → 按回发目标/档案重新找
  if (it.resumeRunId && runs[it.resumeRunId]) return laneKeyOf(runs[it.resumeRunId])
  return laneKeyOf({ taskFile: it.taskFile || null })
}
// 员工空出来时排空。boot 与 handleStreamEnd / 收工末尾调用。
// 2026-09-29 改（多运行环境）：① **按工作区分别出队**——原先整队 FIFO + 只要她有任一会话在跑就不出队，于是 Temu 环境
//   在测时 v6.0.0 环境的活也只能干等；现在每个工作区空着就各出一批（巡视员仍全局串行，一次一条）。
// ② **同一工作区、同一任务的多条合并成一次投递**——她忙的时候同事会陆续交来「BUG-002/003 修好了」「BUG-004 也好了」
//   「接着做全量 QA」…原先每条单起一个新会话、各自从头读一遍档案；合并后她一次读完、合成一份计划。
function drainPending(employee) {
  const q = pendingQueues[employee]
  if (!q || !q.length) return
  const serial = LANE_SERIAL_EMPLOYEES.has(employee)
  const startedLanes = new Set()
  for (let guard = 0; guard < 12 && q.length; guard++) {
    const idx = q.findIndex(it => {
      const lk = pendingLaneKey(it)
      return !startedLanes.has(lk) && !busyRunFor(employee, serial ? undefined : lk)
    })
    if (idx < 0) break
    const head = q[idx]
    const lk = pendingLaneKey(head)
    // 守航态/契约按「生效值」比：交棒项自己不带这两个字段、是投递时从委托者会话继承的（2026-09-29 重启实况：菲菲交的
    // 「v6.0.0 全量 QA」因此没并进同一任务的 cc 批次，范围/端口/改写 facet 这些关键口径差点单独晚到）
    const effMode = x => x.executionMode || runs[x.callerRunId]?.executionMode || ''
    const effContract = x => x.guardContract || runs[x.callerRunId]?.guardContract || ''
    const mergeable = x => x.deliver !== 'resume' && !!x.instruction && pendingLaneKey(x) === lk &&
      (x.taskFile || '') === (head.taskFile || '') && effMode(x) === effMode(head) && effContract(x) === effContract(head)
    const batch = mergeable(head) ? q.filter(mergeable) : [head]
    for (const b of batch) q.splice(q.indexOf(b), 1)
    savePending()
    broadcast({ type: 'pending-changed', employee, count: q.length, items: pendingView(employee) })
    deliverPending(employee, batch)
    startedLanes.add(lk)
    if (serial) break
  }
}
// 投递一批（1 条走原路径；多条合并成一条新会话的指令）
function deliverPending(employee, batch) {
  if (batch.length > 1) {
    const name = k => EMPLOYEES[k]?.displayName || k || '同事'
    const last = batch[batch.length - 1]
    const withCaller = batch.filter(x => x.callerRunId)
    const caller = withCaller.length ? withCaller[withCaller.length - 1] : null
    const parts = batch.map((x, i) => `### ${i + 1}. 来自 ${name(x.fromEmployee || x.ccFrom)}${x.kind === 'cc' ? '（抄送）' : ''} · ${String(x.enqueuedAt || '').slice(0, 16).replace('T', ' ')}${x.callerRunId ? ` · 会话 \`${x.callerRunId}\`` : ''}\n\n${x.instruction}`).join('\n\n---\n\n')
    const instruction = `【待处理队列 · 合并投递】你忙的时候，同一件事（${taskShortName(last.taskFile) || '同一任务'}）陆续交来了 ${batch.length} 条，按时间顺序放在下面。**后到的通常覆盖先到的**（比如后一条说「BUG-004 也修好了」，就包含了前一条的复验范围）——先通读，合成一份计划再动手，别逐条从头重来。\n\n${parts}${withCaller.length > 1 ? `\n\n（这几条来自不同会话：${withCaller.map(x => `\`${x.callerRunId}\``).join('、')}。要回给某一条就用 \`【交回】@<会话号>｜<报告>\`。）` : ''}`
    try {
      const spawned = createDispatchRun({
        employee, taskFile: last.taskFile || null, instruction, kind: 'dispatch',
        chainDepth: Math.max(...batch.map(x => x.chainDepth || 0)), callerRunId: caller?.callerRunId || null,
        threadRootId: last.threadRootId || undefined, engine: last.engine || undefined,
        executionMode: last.executionMode || undefined, guardContract: last.guardContract || undefined,
        lane: last.lane || undefined,
      })
      for (const x of batch) if (x.ccJoinOrigin && runs[x.ccJoinOrigin]) bindCcChild(runs[x.ccJoinOrigin], spawned)
      appendEvent(spawned.id, { type: 'lab', text: `📥 待处理队列里同一任务的 ${batch.length} 条已合并成这一次投递（按时间顺序排在指令里）。` })
    } catch (e) { console.error('[drainPending] 合并投递失败', employee, batch.map(x => x.id), e) }
    return
  }
  const it = batch[0]
  try {
    if (it.deliver === 'resume' && it.resumeRunId && runs[it.resumeRunId]) {
      sendToRun(runs[it.resumeRunId], it.prompt, { resume: true, kind: 'dispatch' })   // 交回：回原会话保上下文
    } else if (it.instruction) {
      const spawned = createDispatchRun({                                              // cc/forward：起新会话
        employee, taskFile: it.taskFile || null, instruction: it.instruction, kind: 'dispatch',
        chainDepth: it.chainDepth || 0, callerRunId: it.callerRunId || null,
        threadRootId: it.threadRootId || undefined, ccFrom: it.ccFrom || undefined, engine: it.engine || undefined,
        // 排队路径同样要带守航态与契约：cc 的 callerRunId 恒为 null，继承兜不住（见 cc 派生处的长注释）。
        // 排队的 cc 往往比即时派生的更晚起会话，掉线在这里更隐蔽。
        executionMode: it.executionMode || undefined, guardContract: it.guardContract || undefined,
        lane: it.lane || undefined,   // 工作区同理：cc 没有 caller 可继承
      })
      // 汇合闸回绑：这条 cc 排队时还没有 run id，现在才有——绑上，发起人才等得到它（见 ccQueuedFor）
      if (it.ccJoinOrigin && runs[it.ccJoinOrigin]) bindCcChild(runs[it.ccJoinOrigin], spawned)
    } else {
      // 交回项但委托会话已不存在（被删）→ 用报告文本兜底起一条新会话，不静默丢结果
      const from = EMPLOYEES[it.fromEmployee]?.displayName || it.fromEmployee || '下游'
      createDispatchRun({
        employee, taskFile: it.taskFile || null, kind: 'dispatch', threadRootId: it.threadRootId || undefined,
        instruction: `【交回】来自 ${from}（原委托会话已不存在，转为新会话处理）：\n\n${it.text || ''}`,
      })
    }
  } catch (e) { console.error('[drainPending] 投递失败', employee, it.id, e) }
}

// ---------- 巡视员：空停巡查（事件驱动 + 定时兜底，共用同一套判定/派工）----------
// 事件版：autoChain 落空点即时触发（下方）。定时版：sweepIdleStops 低频兜底，捞事件版可能漏的
// （引擎漏触发 / 服务重启时卡半途 / 上线前遗留的 done-空停）——用户不完全信任事件版可靠性，加这道保险。
const PATROL_STALE_MS = 5 * 60_000          // 定时兜底：done 后至少静置这么久才算空停（更新则 event 版应已处理，不抢）
const PATROL_MAX_AGE_MS = 24 * 60 * 60_000  // 太老的 done run 不复活（早已settled/弃用）
const PATROL_SWEEP_COOLDOWN_MS = 30 * 60_000 // 同一 run 被定时巡逻重复捞的最小间隔
const TERMINAL_STATUS_RE = /DONE|ARCHIVED|CLOSED/i   // 定时巡逻周期＝chainConfig.patrolSweepMin 分钟（默认 6，可在弹窗改），见 armPatrolSweep

// 空停前置守卫（事件版 / 定时版 / 宽限窗共用）：done + 非 error + 非巡视员/未升级 + 非菲斯拉已处置 + 未被裁决
// + 有实说内容 + 收尾解析不出任何有效交接/拍板标记。= 「本轮是一次没写有效交接的实质停顿」（聊天裸停也满足）。
// 「是否派工任务」那一档单独判（见 patrolCandidate / autoChain 分流），不在此处收窄。
function patrolEligible(run) {
  if (!run || run.status !== 'done' || run.isError) return false
  if (isConsult(run)) return false   // 只读咨询窗停下是常态（老板问完就走），不是"空停"，别派小呆呆去续跑
  if (run.employee === 'chaorenq' || run._patrolClosed) return false   // 已升级老板过的 run 不再反复巡（治「一条卡死 run 每 30 分钟重复升级」骚扰）
  if (run.employee === 'feisila' && run.auditFindingsSubmitted) return false   // 持久字段：重启后也知道影子陪练已完成
  if (run._e2eBatchLive > 0) return false   // 有 run_e2e_batch 在跑：它 settle 时引擎必唤起（finishE2eBatch），这不是空停。进程重启则该标记随内存清空 → 恢复纳入巡查（批次也已随进程死掉，此时该巡）
  // 本次停顿已被巡视员裁决过（判了「合法收工」或「升级老板」）→ 目标未产出新停顿前不重复巡。
  // 签名＝裁决当时的 updatedAt；持久落库(非 _ 前缀)，跨重启仍生效——治「同一会话被巡 7 次」死循环
  // （根因：旧机制只在 resume(_patrolNudges)/升级(_patrolClosed) 两条路留痕，「判合法收工」这最常见的第三种结局无处落库；
  //  且 _ 前缀字段全被 stripPrivate 落库时丢弃、重启即失忆，连升级锁也复活）。目标日后真被续跑产出新停顿 → updatedAt 变 → 签名失配 → 重新纳入巡查。
  // 宽限窗被老板「取消接管」也复用这条签名（cancelGracePatrol），语义＝老板自己接手了这次停顿。
  if (run.patrolClearedSig && run.patrolClearedSig === run.updatedAt) return false
  if (!String(run.result || '').trim()) return false
  // 结果里有交接/门标记，通常＝已妥善收尾、不巡。但标记只是「写了」，未必「执行成功」——autoChain 可能在真正投递前被
  // fail-closed / 门禁 abort 掉（escalateBlockedHandoff 会打 handoffBlockedSig=updatedAt 记这次未决阻断）。那种情况
  // 标记还在、活却没交出去，是最该巡的静默死停（2026-08-19 事故：交回菲菲被吞、巡视却因标记豁免）→ 不因标记而放行。
  const handoffStuck = run.handoffBlockedSig && run.handoffBlockedSig === run.updatedAt
  // QA 空心停靠（见 markQaHollowStop）：写了【等你拍板】但引擎算的覆盖闸门未达标 → 同样不因标记而放行。
  // 2026-08-19 事故：迷糊守航态跑一夜 15 facet 0 机器 GREEN，收工写「【等你拍板】晨检队列①②③④」，
  // 一条待拍板同时买断三道防线（覆盖硬闸没跑 / 菲斯拉没派 / 巡视豁免）——「写待拍板」曾是万能免检符。
  const qaHollow = run.qaHollowStopSig && run.qaHollowStopSig === run.updatedAt
  // G3 · 「句柄丢了还在等」：声称在等后台批次/DDL 执行，却给不出任何可查句柄、引擎侧也没有在跑的后台任务。
  // 合法等待（带句柄）不算空停、也不巡；反之要**立刻**升级——它会一直等下去，而且等的是不存在的东西。
  const waitNoHandle = run.waitNoHandleSig && run.waitNoHandleSig === run.updatedAt
  if (!handoffStuck && !qaHollow && !waitNoHandle && (parsePendingGate(run.result) || parseNextHop(run.result) || parseReturnHop(run.result))) {
    // 发布交付物空心交回（§3.103）：菲菲四件只交一件就【交回】波比，标记豁免让巡视整个跳过 → 与上面两条同理，
    // **「写了交接标记」不豁免发布沟通门禁**。只对菲菲做这一次读盘（其余员工零开销），且 patrolClearedSig 仍防重复巡。
    if (!(run.employee === 'feifei' && releaseTurnMissing(run))) return false
  }
  return true
}
// 候选空停判定（**定时 sweep 专用**，收紧版）：在 patrolEligible 之上再要求「挂了任务，或写了协议收尾标记『【等你拍板】无』」。
// 收紧只为定时兜底服务——避免低频扫描复活远古闲聊。事件版聊天裸停如今走「宽限窗」(scheduleGracePatrol)、不靠这个。
// 治 aa5f29：老板在 chat 会话里跟 GG Bond 做实事（lastKind=chat & 无 taskFile），旧过滤把它整个漏了。
function patrolCandidate(run) {
  if (run.engineHandoverPending) return null
  if (!patrolEligible(run)) return false
  return !!run.taskFile || /^[ \t]*【等你拍板】\s*无/m.test(String(run.result || ''))
}
// 任务是否终态（读 frontmatter status）——终态任务的 done run 是合法收工，别巡（尤其防定时版复活老完成任务）。
function patrolTaskTerminal(taskFileRel) {
  try { const fm = parseFrontmatter(fs.readFileSync(safeResolve(taskFileRel), 'utf8')) || {}; return TERMINAL_STATUS_RE.test(String(fm.status || '')) }
  catch { return false }   // 读不到当非终态：宁可巡、交巡视 agent 判，不漏
}
// 巡视 run 是否在「升级给老板」（＝这条必须推送通知，别烂在子会话里）。
// 缘起（2026-08-24 事故 run 20260824020309-2e5946）：小呆呆判菲菲那次停顿"默认不续、留给老板决定"，输出了 decision 卡、
// 正文写"无需我方动作，等你拍板。"——但没写协议标记行 `【等你拍板】<事项>`，parsePendingGate 返回 null，
// maybePushRunStopped 的降噪行就把这条静默吞了（托盘 Toast / Bark 一条没发），同时 autoChain 还给菲菲盖了
// patrolClearedSig、连定时兜底也不再补刀 → 巡到了、判了、升级了，老板却全不知情。
// 现改为「宁可多推、不漏升级」：严格标记 / decision 卡 / 白话请示 任一命中即算升级。
// 判"合法收工"的巡视报告（"无需动作、这是正常收尾"）不含这些特征 → 仍然静默，降噪初衷不破。
const PATROL_ESCALATE_RE = /【等你拍板】|等你拍板|等您拍板|升级给?老板|请老板|需(要)?(你|您)(来)?(拍板|裁决|决定|介入|接管)/
function patrolEscalating(run) {
  const r = String(run?.result || '')
  if (!r.trim()) return false
  if (parsePendingGate(r)) return true                                      // 规范标记：老路照走
  if (/```olcard[\s\S]*?"type"\s*:\s*"decision"/.test(r)) return true       // 抛了选择题卡 = 在等老板选（哪怕同时标了「无」）
  // 明确写了 `【等你拍板】无`（协议里「合法收工·无需动作」的规范收尾）→ 尊重它、静默；只有连标记都没写才走白话兜底。
  // 少了这层，兜底正则会把标记里的「等你拍板」四个字本身也当白话请示，每条合法收工巡视都弹一次 toast，降噪就废了。
  if (lastMarkerBlock(r, /^[ \t]*【等你拍板】\s*(\S[^\n]*)?$/)) return false
  return PATROL_ESCALATE_RE.test(r)                                         // 白话请示兜底
}
// 是否已有针对该 run 的在跑巡视 run（避免事件版与定时版、或两次定时重复派同一条）
function livePatrolFor(runId) {
  for (const r of liveRuns.values())
    if (r.employee === 'chaorenq' && (r.status === 'running' || r.status === 'starting') && String(r.instruction || '').includes(runId)) return true
  return false
}
// 派巡视员（事件版 & 定时版共用）。escalateOnly=已达续跑上限，只让它升级老板、别再续。
function spawnPatrol(run, { escalateOnly = false, source = 'event' } = {}) {
  if (escalateOnly) run._patrolClosed = true   // 升级给老板一次后即闭合：不再反复巡这条、别每轮再骚扰老板（老板要重新盯就重启/重派该会话）
  const nm = EMPLOYEES[run.employee]?.displayName || run.employee
  const cap = chainConfig.patrolMax || 6
  const from = source === 'sweep' ? '（定时巡逻发现，已静置一段时间无人续）' : ''
  // 注入被巡员工的「巡视判据」速查块（职责/空停判据/越界红线）——让小呆呆按岗位具体判，别通用一刀切。
  const criteria = patrolCriteriaFor(run.employee)
  const criteriaBlock = criteria
    ? `\n\n【${nm} 的巡视判据（对照它判两轴）】\n${criteria}`
    : `\n\n（未取到「${nm}」的巡视判据速查块；必要时 Read 它的 roles/*.md 全文，按其职责与红线判。）`
  // QA 空心停靠（markQaHollowStop 盖签名）：它**写了**待拍板、只是不该被这条标记免检 → 用专属措辞，
  // 别沿用「既没交接也没待老板拍板」的通用文案（那句与事实不符，会把小呆呆导向误判「它明明写了啊」）。
  const hollow = run.qaHollowStopSig && run.qaHollowStopSig === run.updatedAt
  // G3：句柄丢了还在等 —— 给巡视一段专属措辞（通用文案「既没交接也没待拍板」与事实不符，会把它导向误判）
  const waitNoHandleBlock = (run.waitNoHandleSig && run.waitNoHandleSig === run.updatedAt)
    ? `\n\n【G3 · 句柄丢了还在等】引擎判定：它声称在等待（等后台批次/构建/DDL 执行之类），但**给不出任何可查句柄**，引擎侧也没有在跑的后台任务。这不是合法等待——合法等待必须带一个查得到的 sessionId/batchId/runId（猪猪的 \`list_sessions\`/\`get_run_summary\` 就是句柄事实源）。**这类必须立刻处置**：句柄真丢了就让它重新提交并记下句柄；它其实早该往下做了就 resume 逼回。别让它接着等一个不存在的东西。`
    : ''
  // 发布交付物核对（§3.103）：与 DONE 硬门禁同一份 checklist，喂给巡视当**硬事实**——治「小呆呆只读收尾原文、
  // 被『已闭环、已交回』的措辞说服就判合法收工」（2026-08-25 它就是这么给 1/4 交付的那轮盖了章）。
  const relHollow = run.employee === 'feifei' ? releaseTurnMissing(run) : null
  // 非菲菲的被巡对象（典型是正要收官的波比）：只在版本已进发布沟通阶段时才核对，开发/QA 期报缺全是噪音。
  const relChk = relHollow || (inReleaseNotesPhase(archiveStatusOf(run.taskFile)) ? releaseDeliverableCheck(run.taskFile) : null)
  const relBlock = relChk && relChk.missing.length && !relHollow
    ? `\n\n【发布交付物核对（引擎按 SOP §⑤ 自动核对的硬事实，别只信它汇报里怎么说）】${relChk.version} 的四件交付物还缺 ${relChk.missing.length} 件：\n${releaseMissingLines(relChk)}\n缺着就不该收官——若被巡员工正要把任务置 DONE / 判"全流程闭环"，点明四件未齐、该退回菲菲补。`
    : ''
  const instr = escalateOnly
    ? `【巡视】员工「${nm}」的会话 ${run.id} 已被巡视续跑 ${run._patrolNudges || cap} 次仍反复空停（达上限 ${cap}）${from}。**不要再 resume_employee 续它**——直接写【等你拍板】把情况升级给老板（哪个员工/哪条会话/反复停在哪），让老板接管。`
    : hollow
    ? `【巡视 · QA 空心停靠】员工「${nm}」的会话 ${run.id} 写了【等你拍板】把活 park 了，但**引擎算的 QA 覆盖闸门未达标**（${run.qaHollowStopWhy || '覆盖不完整'}）${from}。写待拍板**不豁免**覆盖闸门——本条巡视就是为此而来。\n\n请逐条判它列的「待拍板/晨检」事项属于哪类：\n① **真需要老板拿主意**：业务口径分歧、越界红线动作（发布/DDL/破坏性 Git）、需求方向。\n② **职责内本就该自己干完、却包装成问句推给老板**（＝(A)类空停，必须逼回）。典型形态：\n　· **自己维护的用例/fixture 因业务变更过时** → 更新用例是它的活，不是阻断理由；\n　· 自己已经想到、但**一次都没试过**的绕行方案还剩 ≥1 条就停了；\n　· 「深层/剩余要不要继续测、够不够」这类本不该问老板的选择题；\n　· 卡在某一处就把整批条目一起 park（单点堵不该连坐没被堵的条目）。\n\n处置：存在②类 → \`resume_employee("${run.id}", …)\` **逐条点名**逼回，写清「这几条是你职责内的活，先干完再谈拍板」；只剩①类 → 写【等你拍板】升级老板；确属被硬卡且无任何自助绕过 → 汇报无需动作。**resume 前必查**：续跑若会把它推进「越界红线」动作，别续、改升级并点明违的是哪条。${criteriaBlock}\n\n它收尾原文尾部：\n${String(run.result).slice(-800)}`
    : relHollow
    ? `【巡视 · 发布交付物未齐】员工「${nm}」的会话 ${run.id} **写了交接标记**（【交回】/【下一棒】）就收工了，但引擎按落盘事实核对，${relHollow.version} 的 PM_RELEASE_NOTES **四件交付物**还缺 ${relHollow.missing.length} 件${from}：\n${releaseMissingLines(relHollow)}\n\n**写了交接标记不豁免这道门禁**——本条巡视就是为此而来（2026-08-25 事故：派工只点名了「版本发布说明」一件，她照做完就【交回】，四件只交 1 件，下游据此把版本收官）。\n\n判据很硬、不必纠结："派工没点名"**不是**豁免理由：四件是一个版本一次的整包（SOP roles/feifei.md §⑤，她工牌里也写着「第 4 件最常被漏」）。除非这几件在别处已交付（你去核实落盘文件/她历史轮的 code 卡），否则就是(A)类空停。\n\n处置：\`resume_employee("${run.id}", …)\` 逐件点名逼回补齐（把上面缺的清单原样给她，让她别再只补一件）；确认其实已交付（引擎核对口径有偏差）→ 汇报无需动作并说明在哪。${criteriaBlock}\n\n它收尾原文尾部：\n${String(run.result).slice(-800)}`
    : `【巡视】员工「${nm}」的会话 ${run.id} 收工时既没交接（【下一棒】/【交回】）、也没待老板拍板事项，但任务还没到终态——疑似「空停」${from}。**对照下方它的巡视判据判两轴**：(A) 该干没干——职责范围内本就该自己干完的活没干完就停（哪怕包装成「要不要继续/够不够」的问句，也不是该问老板的选择题，是空停）；(B) 不该干却要干——下一步是它「越界红线」里的动作。据此三选一处置：明显空停(A) → resume_employee("${run.id}", …) 逼回正轨、并引用其判据点明「这是你职责内该干完的、不该问老板」；越红线(B) 或真需要老板拿主意 → 写【等你拍板】升级老板；确实合法收工 → 汇报无需动作。\n\n⚠ 区分两种「问句」：① 真正需要老板拍板的（越界红线动作如 force-push/发不发布、需求方向）——升级老板、**绝不**替老板决定「续跑/交接」，哪怕 marker 写成「【等你拍板】无」也按「有待拍板问题」处理；② **职责内它本就该自己干完、却包装成「要不要继续」推给老板的**（如 QA 问「深层 facet 要不要测」）——这不是合法请示、是(A)类空停，直接 resume 逼回，别升级。**resume 前必查**：若续跑会把它推进一个「越界红线」动作，别续、改升级并点明违的是哪条红线。对端就是老板本人、对话没聊完的，默认别续。${criteriaBlock}\n\n它收尾原文尾部：\n${String(run.result).slice(-800)}`
  // 派工原因归一到 stall-guard 的四类模糊态（单一事实源：措辞在上面各分支里，**分类**只此一处）。
  // G1 落地后引擎已在收工那一刻拒收「缺标记」，所以能走到这里的只剩「标记写了但语义可疑」。
  const pr = stallGuard.patrolReason({
    qa_hollow: !!hollow,
    release_incomplete: !!relHollow,
    handoff_stuck: !!(run.handoffBlockedSig && run.handoffBlockedSig === run.updatedAt),
    wait_no_handle: !!(run.waitNoHandleSig && run.waitNoHandleSig === run.updatedAt),
  })
  createDispatchRun({ employee: 'chaorenq', taskFile: run.taskFile, instruction: instr + relBlock + waitNoHandleBlock, kind: 'dispatch', threadRootId: run.threadRootId || run.id, patrolTarget: run.id, patrolReason: pr?.code })
  broadcast({ type: escalateOnly ? 'patrol-escalate' : 'patrol-detected', from: run.employee, runId: run.id, source, text: `${nm} ${escalateOnly ? '反复空停达上限，派巡视员升级给你' : '疑似空停，派巡视员查'}${source === 'sweep' ? '（定时巡逻）' : ''}` })
  logConversation({ threadRootId: run.threadRootId || run.id, fromKind: 'employee', from: run.employee, to: 'chaorenq', kind: 'blocked', text: `疑似空停(${source})，派巡视员`, depth: run.chainDepth || 0 })
}

// ---------- 巡视宽限窗（聊天会话空停：延后 N 秒再派巡视，期间老板可回话/点「取消接管」撤销）----------
// 复盘 §3.39 未取的「宽限窗 D」在此落地：聊天停不再即时派巡视（会抢在老板回话前、且过去根本不巡这类停），
// 改为延后 chainConfig.patrolGraceSec 秒；老板一句话(reply)或点「取消接管」即撤销，走完无人干预才真派。
// engine 权威——deadline 落 run.patrolGraceUntil（数字毫秒时间戳，非 _ 前缀 → 持久、跨重启可复原），
// 前端只按 deadline 渲染倒计时、自己不计时（多端一致）。派工流水线任务不走这里（见 autoChain：即时，无人盯别加延迟）。
const _graceTimers = new Map()   // runId → setTimeout 句柄（进程内；不落库，重启由 rearmGracePatrols 依 patrolGraceUntil 复原）
function graceMs() { const s = Number(chainConfig.patrolGraceSec); return Number.isFinite(s) ? Math.max(0, Math.floor(s)) * 1000 : 8000 }
function _patrolEscalateOnly(run) { return (run._patrolNudges || 0) >= (chainConfig.patrolMax || 6) }
function scheduleGracePatrol(run) {
  if (!run || _graceTimers.has(run.id) || run._patrolClosed) return
  if (busyRunFor(run.employee) || livePatrolFor(run.id)) return   // 员工又忙起来/已有在跑巡视 → 不用宽限窗
  const ms = graceMs()
  if (ms <= 0) { spawnPatrol(run, { escalateOnly: _patrolEscalateOnly(run), source: 'event' }); return }   // 宽限窗关(0) → 退回即时派
  const deadline = Date.now() + ms
  run.patrolGraceUntil = deadline; saveRegistry()
  const t = setTimeout(() => fireGracePatrol(run.id), ms); if (t.unref) t.unref()
  _graceTimers.set(run.id, t)
  broadcast({ type: 'patrol-pending', runId: run.id, employee: run.employee, deadline, graceSec: Math.round(ms / 1000) })
}
function fireGracePatrol(runId) {
  const t = _graceTimers.get(runId); if (t) clearTimeout(t); _graceTimers.delete(runId)
  const run = runs[runId]; if (!run) return
  run.patrolGraceUntil = null; saveRegistry()
  if (!patrolEligible(run)) return                                   // 期间被续跑/裁决/取消 → 作罢
  if (busyRunFor(run.employee) || livePatrolFor(run.id)) return
  spawnPatrol(run, { escalateOnly: _patrolEscalateOnly(run), source: 'event' })   // 走完窗口无人干预 → 真派（横幅由既有 patrol-detected 收尾）
}
function cancelGracePatrol(run, reason) {
  if (!run || (!_graceTimers.has(run.id) && !run.patrolGraceUntil)) return false
  const t = _graceTimers.get(run.id); if (t) clearTimeout(t); _graceTimers.delete(run.id)
  run.patrolGraceUntil = null
  run.patrolClearedSig = run.updatedAt   // 这次停顿判「老板自己接手」：sweep 也不再补刀；真续跑产出新停顿 → updatedAt 变 → 自动重纳
  saveRegistry()
  broadcast({ type: 'patrol-cancelled', runId: run.id, employee: run.employee, reason: reason || 'user-cancel' })
  return true
}
// 重启补偿：进程起来后依 patrolGraceUntil 复原未过期的宽限窗；已过期(宕机期间错过)的清标记并立即复检补派，避免窗口卡在重启。
function rearmGracePatrols() {
  const now = Date.now()
  for (const run of Object.values(runs)) {
    const until = Number(run.patrolGraceUntil) || 0
    if (!until) continue
    const left = until - now
    if (left > 0 && left <= 10 * 60_000) {   // 未来且不离谱 → 按剩余时长重排 + 重播 pending 供前端复原横幅
      const t = setTimeout(() => fireGracePatrol(run.id), left); if (t.unref) t.unref(); _graceTimers.set(run.id, t)
      broadcast({ type: 'patrol-pending', runId: run.id, employee: run.employee, deadline: until, graceSec: Math.round(left / 1000) })
    } else { run.patrolGraceUntil = null; saveRegistry(); fireGracePatrol(run.id) }   // 已过期/离谱 → 立即复检补派
  }
}

// ---------- QA 空心停靠：堵「写一条【等你拍板】= 万能免检符」----------
// 2026-08-19 事故（迷糊 run 20260819154126-64147b）：守航态全量 QA 跑一夜，15 facet 拿到 0 个机器 GREEN
// （9 BLOCKED_WITH_PROOF + 6 SOURCE_ATTESTED），收工写「【等你拍板】晨检队列①②③④」就收摊了。
// 这一条待拍板同时买断三道防线：autoChain 的「门优先 return」短路了下面的覆盖率硬闸 → 连带没派菲斯拉影子陪练
// → patrolEligible 又因 parsePendingGate 豁免了小呆呆。于是「自己维护的审版链 fixture 因 v5.14 业务变更过时 →
// 报阻断而不是更新用例」「自己想出的 openUrl/callApi 绕行方案自己扔掉」全程无人复核。
// 对策：pending 门**仍然停流水线**（不自动接棒是对的），但对「挂档案的迷糊 QA 收工」先把覆盖率算出来落档；
// 未达标就盖 qaHollowStopSig → patrolEligible 不再豁免 → 必须由小呆呆判一次「这些待拍板是真需老板，
// 还是职责内的活（含用例维护 / 换未试过的绕行路径）包装成问句」。只算不放行，绝不因此自动放行任何交接。
async function markQaHollowStop(run) {
  const sig = run.updatedAt || String(run.startedAt || '')
  const stamp = (why) => {
    run.qaHollowStopSig = sig; run.qaHollowStopWhy = why; saveRegistry()
    broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'qa-hollow-stop', text: `${EMPLOYEES[run.employee]?.displayName || run.employee} 写了待拍板但 QA 覆盖闸门未达标：${why}——不予免检，派巡视员判` })
    if (chainConfig.patrolEnabled !== false && !livePatrolFor(run.id)) spawnPatrol(run, { escalateOnly: _patrolEscalateOnly(run), source: 'qa-hollow' })
  }
  // 视觉初筛收工（2026-10-06）：迷糊筛过、把活交老板——此时还没进 QA，覆盖率本来就是零，不该按 QA 空心停靠判。
  // 2026-10-22 人工预检门撤销后，合法的只剩「老板亲测」例外（本版约定迷糊不做 QA）；写「人工预检」的在接棒处已被退回。
  // 但豁免要有凭据：本轮必须有一份被机器接受的「通过」（visual_prescreen_verdict）。没有就是「说筛过了其实没筛」，照样派巡视。
  if (prescreen.isPrecheckGateItem(parsePendingGate(run.result))) {
    if (run.prescreen?.verdict === prescreen.PRESCREEN_VERDICTS.PASS) {
      appendEvent(run.id, { type: 'lab', text: `✅ 视觉初筛已通过（${run.prescreen.pages} 页，高 ${run.prescreen.counts?.高 || 0} / 中 ${run.prescreen.counts?.中 || 0} / 低 ${run.prescreen.counts?.低 || 0}），交老板亲测——尚未进 QA，不按覆盖率闸门判。` })
      return
    }
    const why = run.prescreen
      ? `写了「交老板」，但本轮视觉初筛结论是「${run.prescreen.verdict}」——打回的应交 GG Bond 改，不该上老板的门`
      : '写了「交老板」，但本轮没有一份被机器接受的视觉初筛「通过」（visual_prescreen_verdict）'
    appendEvent(run.id, { type: 'lab', text: `⛔ 视觉初筛空头收工：${why}——已交巡视员判。` })
    stamp(why)
    return
  }
  let cov
  try {
    cov = computeCoverageForRun(run)
    const abs = safeResolve(run.taskFile)
    await withArchiveLock(abs, () => { engineSetGate(abs, 'qa_coverage_complete', cov.coverageComplete); engineSetGate(abs, 'qa_red_calibrated', cov.redComplete); engineSetGate(abs, 'qa_passed', cov.passed) })
  } catch (e) {
    // 算不出覆盖率（缺 facet_doc / 档案读写异常）本身就该有人看一眼 → 同样不免检（与交接路径的 fail-closed 同口径）
    const why = `QA 覆盖闸门算不出（${String(e?.message || e)}）`
    appendEvent(run.id, { type: 'lab', text: `⛔ 写了【等你拍板】但${why}——不予免检，交巡视员判。` })
    stamp(why)
    return
  }
  // C3.8（§3.132）：收工把一批**视觉** facet 推成「留晨间人工视觉终验 / 真人工项」，而本轮机器这条路
  // 一步都没走（`visual_acceptance`/`design_conformance`/`aesthetic_review` 零调用、零素材）→ 同样不免检。
  // 放在 cov.passed 早退之前：覆盖率达标不代表这批声明成立，两件事各判各的。
  const vfp = visualFootprint.get(run.id)
  if (!(vfp?.withMaterial > 0) && qaCard.textClaimsVisualHuman(run.result)) {
    const why = vfp?.attempts
      ? `声明了「需人工视觉终验」，本轮调了 ${vfp.attempts} 次视觉工具但一条可判素材都没拿到（首跑 no-baseline 录基线不算过，**跑第二趟**才有判定）`
      : '声明了「需人工视觉终验」，而本轮 `visual_acceptance`/`design_conformance`/`aesthetic_review` 一次都没调、零视觉素材'
    appendEvent(run.id, { type: 'lab', text: `⛔ 视觉终验空头声明：${why}。按「未做」记，不是「机器够不到」——已交巡视员判。补法见工牌 §C3/§C3.5/§C3.6（含压根不需要浏览器的 \`ux_contract_check\`）。` })
    stamp(why)
    return
  }
  if (cov.passed) return   // 覆盖真达标 + 有待拍板事项 = 合法请示，照旧豁免（别惩罚干完活才问的）
  const green = cov.byStatus?.COVERED_GREEN || 0
  const why = `facet 全集 ${cov.denom}，机器 GREEN ${green}，覆盖缺口 ${cov.gaps.length} + RED 缺口 ${cov.redGaps.length}`
  appendEvent(run.id, { type: 'lab', text: `⛔ QA 空心停靠：${why}。写【等你拍板】不豁免覆盖闸门——已交巡视员判「这些待拍板是真需老板，还是职责内的活包装成问句」。` })
  stamp(why)
}

// ---------- 教导主任：审计迷糊 QA 结论（事件驱动，autoChain 里迷糊结论分支前拦截触发）----------
// 取菲斯拉角色文件里的「审计判据（教导主任速查）」段（供 spawnAudit 注入她自己的审计清单）。
function auditCriteriaFor() {
  try {
    const abs = resolveEmpFile(EMPLOYEES.feisila?.roleFile)
    if (!abs) return null
    return extractSection(fs.readFileSync(abs, 'utf8'), '审计判据（教导主任速查）')
  } catch { return null }
}
// 机器门禁通过后，异步派菲斯拉做不阻塞流水线的影子陪练。
function spawnAudit(run) {
  const feiName = EMPLOYEES.feisila?.displayName || '菲斯拉'
  const criteria = auditCriteriaFor()
  const criteriaBlock = criteria ? `\n\n【你的审计判据速查（逐条对照）】\n${criteria}` : ''
  const tail = String(run.result || '').slice(-1200)
  const instr = `【影子 QA 陪练】迷糊会话 ${run.id} 已通过确定性机器门禁，流水线不会等你背书。请独立做对抗审查，只产出“发现/证据/建议”：找假绿、数据捷径、漏 facet、RED 校准不成立或门禁规则漏洞。完成后调用 submit_audit_findings("${run.id}", severity, findings) 留档；你没有放行或打回权。发现系统性风险再写【等你拍板】通知老板。${criteriaBlock}\n\n迷糊结论尾部：\n${tail}`
  createDispatchRun({ employee: 'feisila', taskFile: run.taskFile, instruction: instr, kind: 'dispatch', threadRootId: run.threadRootId || run.id, auditTarget: run.id })
  broadcast({ type: 'audit-shadow', from: 'mihu', runId: run.id, text: `机器门禁已裁决；派${feiName}做不阻塞流水线的影子陪练` })
  logConversation({ threadRootId: run.threadRootId || run.id, fromKind: 'employee', from: 'mihu', to: 'feisila', kind: 'cc', text: '机器门禁已通过，派影子陪练找漏洞（不掌握放行权）', depth: run.chainDepth || 0 })
  appendEvent(run.id, { type: 'lab', text: `🔎 ${feiName}影子陪练已启动：只找漏洞，不阻塞、不放行。` })
}

// 定时兜底巡逻：扫 runs 注册表，捞事件版可能漏掉的"已静置的空停"。三重防误伤：
// ① 每个(任务|员工)只取最新一条 done run（历史老 run 不复活）；② 静置 [5min,24h] 窗口；③ 任务非终态。
function sweepIdleStops() {
  try {
    if (chainConfig.patrolEnabled === false) return
    const now = Date.now(), cap = chainConfig.patrolMax || 6
    _nextPatrolSweepAt = now + Math.max(1, Math.floor(Number(chainConfig.patrolSweepMin) || 6)) * 60_000   // 本轮触发 → 顺延下次时间（前端雷达倒计时用）
    refreshUiContract('patrol-sweep')   // 兜底刷新（5min 防抖）：覆盖「老板自己改了前端、没有 GG Bond run」的情况
    refreshZhuzhuHealth('patrol-sweep') // 同周期探猪猪 base（5min 防抖）：base 漂了要在派工前就被看见，见 §3.106
    const latest = new Map()   // key=任务|员工 → 最新 done 候选
    let scanned = 0
    for (const run of Object.values(runs)) {
      scanned++
      if (!patrolCandidate(run)) continue
      const key = run.taskFile + '|' + run.employee
      const prev = latest.get(key)
      if (!prev || String(run.updatedAt || '') > String(prev.updatedAt || '')) latest.set(key, run)
    }
    let spawned = 0
    for (const run of latest.values()) {
      const doneAt = Date.parse(run.updatedAt || '') || 0
      if (now - doneAt < PATROL_STALE_MS || now - doneAt > PATROL_MAX_AGE_MS) continue
      if (run._patrolSweptAt && now - run._patrolSweptAt < PATROL_SWEEP_COOLDOWN_MS) continue
      if (busyRunFor(run.employee) || livePatrolFor(run.id) || patrolTaskTerminal(run.taskFile)) continue
      run._patrolSweptAt = now
      spawned++
      guardNoteIdleStop(run, Math.round((now - doneAt) / 60000))   // 守航态：空停时长进台账（晨检包「夜间空停累计」此前恒为「—」）
      spawnPatrol(run, { escalateOnly: (run._patrolNudges || 0) >= cap, source: 'sweep' })
    }
    // 「巡逻中」这一状态此前**没有任何可观测信号**：本函数是微秒级内存扫描，不产 run、不广播，
    // 只有扫到真空停才 spawnPatrol；而 /api/patrol-status 的 active 判的是「小呆呆有在跑的 run」＝已经是「处置中」。
    // 于是前端只能表达「倒计时 / 处置中」，中间那一跳（他确实巡了一轮、但什么都没捞到）完全不可见——
    // 老板看到的就是「倒计时来回跳、却从没见过巡逻动画」（2026-08-20 反馈）。这里补上唯一缺的那个事件。
    _lastPatrolSweep = { at: now, scanned, candidates: latest.size, spawned }
    broadcast({ type: 'patrol-sweep', at: now, scanned, candidates: latest.size, spawned, nextSweepAt: _nextPatrolSweepAt })
  } catch (e) { console.warn('[patrol-sweep] 异常:', e.message) }
}
// facet 漂移巡检（detective·软）：定时扫 tasks/，发现「已进 QA 却缺可解析 facet_doc」的在飞档案 → 广播 + 记通知 ping owner。
// 补硬门禁的兜底：抓历史遗留、守航态未硬挡、或任何边角绕过而滑进 QA/终结却无 facet_doc 的档案（如早先的 v5.17.1）。
// 只催「非终结 + 有条目已进 QA」的（早期零摩擦、已归档/已上线覆水难收不刷屏）；按文件 mtime 去重，改过才再报。
const _facetDriftAlerted = new Map()   // file → 上次告警时的 mtimeMs
function sweepFacetDrift() {
  try {
    if (chainConfig.patrolEnabled === false) return
    for (const f of fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md'))) {
      const abs = path.join(TASKS_DIR, f)
      let text, stat
      try { text = fs.readFileSync(abs, 'utf8'); stat = fs.statSync(abs) } catch { continue }
      const fm = parseFrontmatter(text)
      if (!fm || !fm.task || !fm.status) continue                                   // 非任务档案（交接卡等）
      if (/已归档|已上线|已完成|DONE|ARCHIVED|CLOSED/i.test(String(fm.status))) { _facetDriftAlerted.delete(f); continue }  // 已终结不刷屏
      const inQA = extractEntries(text).some(e => QA_ONWARD_STATUS.has(String(e.status || '').replace(/\*\*/g, '').trim()))
      if (!inQA) { _facetDriftAlerted.delete(f); continue }                          // 还没进 QA → 不催
      let v; try { v = validateArchiveFile(abs) } catch { continue }
      if (!v.errors.length) { _facetDriftAlerted.delete(f); continue }
      if (_facetDriftAlerted.get(f) === stat.mtimeMs) continue                       // 内容没变、已报过 → 跳过
      _facetDriftAlerted.set(f, stat.mtimeMs)
      const rel = `office-lab/tasks/${f}`, owner = fm.owner || ''
      const msg = `facet 漂移：任务档案已进 QA 却缺 facet 基线——${v.errors[0]}`
      broadcast({ type: 'facet-drift', file: rel, owner, employee: owner, text: msg })
      pushNotify({ kind: 'facet-drift', file: rel, owner, text: msg })
    }
  } catch (e) { console.warn('[facet-drift] 异常:', e.message) }
}

// ---------- 飞书需求表状态自动对齐（任务档案＝事实源，需求表＝投影） ----------
// 缘起 2026-08-21（老板日常观察）：v5.18 早已发线上（`released_prod`/`post_release_done` 均 true、status DONE），
// 表里那几条 REQ 还挂在「待处理」。**根因是结构性的、不是菲菲不上心**：① 状态流转只写在她 SOP 里
// （PM_INTAKE 标处理中 / PM_RELEASE_NOTES 标已完成）＝纯靠自觉、无机器闸；② 流水线**最后一棒是波比**
// （发线上 + 上线后收尾），她那一棒若没被再派一次，就没人去翻表——忘记的窗口天生存在。
// ⚠ 为什么做「对账」而不是「gate 翻转回调」：`released_prod` 这类 gate 是**员工手写 frontmatter**
//   （v5.18 那几行带手写注释可证），引擎里根本没有可靠的翻转事件可挂。对账还顺带能捞历史遗留。
// ⚠ 为什么**双向**（老板 2026-08-21 定：必须支持回退、不能只往前推）：发布回滚（`released_prod` 改回 false）、
//   条目被守航 park/隔离（退出本版）都必须把表推回去；只单调前进会让表停在一个已经不成立的「已完成」。
//   放开方向之后，护栏改成**限爆炸半径**：一轮降级超阈值就整批不写、只报告等人确认。
const LARK_SYNC_LOG = path.join(RUNS_DIR, 'lark-sync.jsonl')
const LARK_SYNC_MIN_INTERVAL_MS = 120_000     // 两轮自动对账的最小间隔（员工连续回写档案时别打爆飞书 API）
const LARK_SYNC_DEMOTE_CAP = 3                // 单轮降级熔断阈值：超过就整批降级不写（防某份档案被改坏刷回全表）
const LARK_SYNC_INTERVAL_MS = 30 * 60_000     // 定时兜底一轮（捞历史遗留：v5.18 就是靠这一路补上）
const REQ_ID_RE = /^REQ-\d+$/i
const ENTRY_OUT_OF_VERSION = new Set(['已跳过', '已隔离'])   // 守航 park / 隔离＝没做成、退出本版 → 表回「待处理」
const LARK_RANK = { pending: 0, doing: 1, done: 2 }

// 从档案原文抽上线日期：`released_prod: true` 那行的**行尾注释**里的日期（parseFrontmatter 会吃掉注释，
// 所以这里必须读原文正则）；退到「## 时间线」里含上线/发线上的最后一行日期；都取不到返回 ''（宁缺勿造）。
function parseReleaseDate(text) {
  const fmEnd = text.startsWith('---') ? text.indexOf('\n---', 3) : -1
  const head = fmEnd > 0 ? text.slice(0, fmEnd) : text.slice(0, 2000)
  const g = head.match(/released_prod:\s*true[^\n]*?(\d{4}-\d{2}-\d{2})/)
  if (g) return g[1]
  const tl = text.match(/##\s*时间线([\s\S]*?)(\n## |$)/)
  if (tl) {
    const hits = tl[1].split('\n').filter(l => /上线|发线上|发布线上|生产发布/.test(l))
    for (let i = hits.length - 1; i >= 0; i--) { const d = hits[i].match(/(\d{4}-\d{2}-\d{2})/); if (d) return d[1] }
  }
  return ''
}
// 算「应有状态」：纯本地、零网络。返回 Map<REQ编号, {rank, version, releaseDate, file, updated, why, entryStatus}>
function desiredLarkStates() {
  const out = new Map()
  let files = []
  try { files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md')) } catch { return out }
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(TASKS_DIR, f), 'utf8') } catch { continue }
    const fm = parseFrontmatter(text)
    if (!fm || !fm.task || !fm.status) continue                       // 非任务档案（契约/交接卡等）跳过
    const version = String(fm.version || '').trim()
    const updated = String(fm.updated || (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '')
    const released = !!(fm.gates && fm.gates.released_prod === true)
    const releaseDate = released ? parseReleaseDate(text) : ''
    for (const e of extractEntries(text)) {
      const id = String(e.no || '').replace(/\*\*/g, '').trim().toUpperCase()
      if (!REQ_ID_RE.test(id)) continue                               // BUG-0xx 等表里没有行；作废/移出写在 HTML 注释里、天然不在表格行内
      const entryStatus = String(e.status || '').replace(/\*\*/g, '').trim()
      let rank = released ? LARK_RANK.done : LARK_RANK.doing
      let why = released ? `档案 released_prod=true（${f}）` : `条目在版本登记表内（${f}）`
      if (ENTRY_OUT_OF_VERSION.has(entryStatus)) {
        rank = LARK_RANK.pending
        why = `条目状态「${entryStatus}」＝退出本版（守航 park/隔离），回候选池`
      }
      const cand = { rank, version, releaseDate: rank === LARK_RANK.done ? releaseDate : '', file: `office-lab/tasks/${f}`, updated, why, entryStatus }
      const prev = out.get(id)
      // 同一 REQ 出现在多份档案 → 取 fm.updated **最新**那份为准。刻意不取「秩最高」：取最高秩等于禁止回退
      // （回滚发布是在同一份档案上把 released_prod 改回 false；需求重开是另一份更晚更新的档案）。
      if (!prev || String(cand.updated) > String(prev.updated)) out.set(id, cand)
    }
  }
  return out
}
// 表结构解析（字段名 + 单选项名 + 类型），缓存 10min。日期字段(type 5)要写 epoch ms、文本字段写字符串。
let _larkSyncFieldsCache = { at: 0, map: null }
async function larkSyncFieldMap() {
  if (_larkSyncFieldsCache.map && Date.now() - _larkSyncFieldsCache.at < 600_000) return _larkSyncFieldsCache.map
  const fields = await larkListFields()
  const by = n => fields.find(f => f.name && f.name.includes(n))
  const statusF = by('状态')
  const opt = kw => (statusF?.options || []).find(o => o.includes(kw)) || kw
  const map = {
    reqNo: (by('需求编号') || by('编号'))?.name || '',
    status: statusF?.name || '',
    version: (by('归属版本') || by('版本'))?.name || '',
    onlineDate: by('上线') || null,
    labels: { pending: opt('待处理'), doing: opt('处理中'), done: opt('已完成'), rejected: opt('拒绝') },
  }
  _larkSyncFieldsCache = { at: Date.now(), map }
  return map
}
// 表里当前状态 → 秩；'rejected' 单独返回（整行不碰）；认不出返回 null（当"空"处理、只会被填上）
function larkRankOfStatus(text, labels) {
  const t = String(text || '').trim()
  if (!t) return null
  if (t.includes('拒绝') || t.includes('作废')) return 'rejected'
  if (t === labels.done || t.includes('已完成')) return LARK_RANK.done
  if (t === labels.doing || t.includes('处理中')) return LARK_RANK.doing
  if (t === labels.pending || t.includes('待处理')) return LARK_RANK.pending
  return null
}
let _larkSyncAt = 0, _larkSyncRunning = false, _larkSyncTimer = null, _lastLarkSync = null
// 对账主体。dryRun=true 只算不写（验证/救急都靠它）。
async function syncLarkFromArchives({ dryRun = false, source = 'manual' } = {}) {
  if (!larkConfigured()) return { ok: false, error: '飞书需求表未接通（缺凭证/未授权）' }
  if (_larkSyncRunning) return { ok: false, error: '上一轮对账仍在进行' }
  if (larkConfig.autoSync === false && source !== 'manual' && !dryRun) return { ok: true, skipped: 'autoSync=false' }
  _larkSyncRunning = true
  const started = new Date().toISOString()
  try {
    const desired = desiredLarkStates()
    const rows = await larkListRecords(5000)
    const fmap = await larkSyncFieldMap()
    if (!fmap.reqNo || !fmap.status) return { ok: false, error: `表结构认不出（需求编号=${fmap.reqNo || '?'} 状态=${fmap.status || '?'}），去「飞书需求表设置」核对字段名` }
    const index = new Map()
    for (const r of rows) {
      const no = String(larkCellText((r.fields || {})[fmap.reqNo]) || '').replace(/\s/g, '').toUpperCase()
      if (no) index.set(no, r)
    }
    const ups = [], downs = [], missingRows = [], needsHuman = [], failed = []
    let inSync = 0
    for (const [id, want] of desired) {
      const row = index.get(id)
      if (!row) { missingRows.push({ req: id, version: want.version, file: want.file }); continue }
      const curText = larkCellText((row.fields || {})[fmap.status]).trim()
      const cur = larkRankOfStatus(curText, fmap.labels)
      if (cur === 'rejected') { needsHuman.push({ req: id, why: `表里是「${curText}」（拒绝/作废）→ 整行不碰，要不要复活由你判`, file: want.file }); continue }
      const wantLabel = want.rank === LARK_RANK.done ? fmap.labels.done : want.rank === LARK_RANK.doing ? fmap.labels.doing : fmap.labels.pending
      const fields = {}
      if (curText !== wantLabel) fields[fmap.status] = wantLabel
      if (fmap.version && want.version) {
        const curV = larkCellText((row.fields || {})[fmap.version]).trim()
        if (curV !== want.version) fields[fmap.version] = want.version
      }
      if (fmap.onlineDate) {
        // ⚠ 幂等的关键：日期字段(type 5)存的是 epoch ms，不能拿它的字面量跟 "YYYY-MM-DD" 比
        //   （否则每轮都判"不一致"、每轮重写一遍，白打 API、审计日志全是噪声）。先归一成本地日期串再比。
        const raw = (row.fields || {})[fmap.onlineDate.name]
        let curDate = ''
        if (fmap.onlineDate.type === 5) {
          const ms = Number(Array.isArray(raw) ? raw[0] : raw)
          if (ms) curDate = isoLocal(new Date(ms)).slice(0, 10)
        } else curDate = larkCellText(raw).trim()
        if (want.rank === LARK_RANK.done && want.releaseDate) {
          if (curDate !== want.releaseDate) fields[fmap.onlineDate.name] = fmap.onlineDate.type === 5 ? Date.parse(`${want.releaseDate}T00:00:00+08:00`) : want.releaseDate
        } else if (want.rank !== LARK_RANK.done && curDate) {
          fields[fmap.onlineDate.name] = fmap.onlineDate.type === 5 ? null : ''   // 降级离开「已完成」→ 清掉已不成立的上线日（留假日期比空着更糟）
        }
      }
      if (want.rank === LARK_RANK.done && !want.releaseDate) needsHuman.push({ req: id, why: '已上线但档案里解析不出上线日期 → 状态已对齐、日期留空待你补', file: want.file })
      if (want.rank === LARK_RANK.pending) needsHuman.push({ req: id, why: want.why, file: want.file })
      if (!Object.keys(fields).length) { inSync++; continue }
      const direction = (cur === null || cur < want.rank) ? 'up' : 'down'
      const item = { req: id, recordId: row.record_id, from: curText || '(空)', to: wantLabel, version: want.version, releaseDate: want.releaseDate, direction, why: want.why, file: want.file, fields }
      ;(direction === 'down' ? downs : ups).push(item)
    }
    // 降级熔断：一轮里降级过多 → 整批降级不写、只报告（升级不受限）
    let blockedDemotes = []
    if (downs.length > LARK_SYNC_DEMOTE_CAP) { blockedDemotes = downs.splice(0, downs.length) }
    const toWrite = ups.concat(downs)
    let written = 0
    if (!dryRun) {
      for (const it of toWrite) {   // 顺序写，不并发（§3.48：逐行并发撞频率限制那次事故）
        try { await larkUpdateRecord(it.recordId, it.fields); written++ }
        catch (e) { failed.push({ req: it.req, error: String(e?.message || e).slice(0, 200) }) }
      }
      if (written && typeof scheduleMirrorSync === 'function') { try { scheduleMirrorSync() } catch { } }
    }
    const summary = {
      ok: !(toWrite.length && !dryRun && written === 0),   // 有活要干却一条没成 → 明确 ok:false（§3.48：绝不 ok:true+count:0 假装成功）
      dryRun, source, at: started,
      reqsInArchives: desired.size, inSync,
      updated: toWrite, written, blockedDemotes, missingRows, needsHuman, failed,
    }
    _lastLarkSync = { at: Date.now(), ...summary }
    try { fs.appendFileSync(LARK_SYNC_LOG, JSON.stringify(summary) + '\n') } catch { }
    const changed = dryRun ? 0 : written
    if (changed || blockedDemotes.length || missingRows.length || failed.length) {
      const bits = []
      if (changed) bits.push(`已对齐 ${changed} 条`)
      if (blockedDemotes.length) bits.push(`⛔ ${blockedDemotes.length} 条降级被熔断拦下（需你确认）`)
      if (missingRows.length) bits.push(`表里缺 ${missingRows.length} 条 REQ 的行`)
      if (failed.length) bits.push(`${failed.length} 条写失败`)
      const text = `飞书需求表对账：${bits.join(' · ')}`
      broadcast({ type: 'lark-sync', text, updated: changed, blocked: blockedDemotes.length, missing: missingRows.length, failed: failed.length })
      pushNotify({ kind: 'lark-sync', owner: 'feifei', text })
    }
    return summary
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally { _larkSyncRunning = false; _larkSyncAt = Date.now() }
}
// 档案变动触发：debounce 5s + 全局最小间隔（避免员工连续回写档案时每次都打飞书）
function scheduleLarkSync(source = 'tasks-changed') {
  if (larkConfig.autoSync === false || !larkConfigured()) return
  clearTimeout(_larkSyncTimer)
  const wait = Math.max(5000, LARK_SYNC_MIN_INTERVAL_MS - (Date.now() - _larkSyncAt))
  _larkSyncTimer = setTimeout(() => {
    syncLarkFromArchives({ source }).catch(e => console.warn('[lark-sync] 异常:', e?.message || e))
  }, wait)
}
setInterval(() => {   // 定时兜底：捞历史遗留 + 捞掉队的（引擎重启后第一轮也靠它）
  syncLarkFromArchives({ source: 'interval' }).catch(e => console.warn('[lark-sync] 异常:', e?.message || e))
}, LARK_SYNC_INTERVAL_MS)

let _patrolSweepTimer = null, _nextPatrolSweepAt = 0   // _nextPatrolSweepAt：下次定时巡逻的时间戳（供 /api/patrol-status 前端雷达倒计时）
let _lastPatrolSweep = null   // 最近一次定时巡逻的战果 {at, scanned, candidates, spawned}——供刚打开页面的前端补上「上次巡逻」而不必等下一跳事件
function armPatrolSweep() {   // 按 chainConfig.patrolSweepMin 布/重布定时巡逻——配置改动即时生效，无需重启
  if (_patrolSweepTimer) clearInterval(_patrolSweepTimer)
  const min = Math.max(1, Math.floor(Number(chainConfig.patrolSweepMin) || 6))
  _nextPatrolSweepAt = Date.now() + min * 60_000
  // 空停巡逻 + facet 漂移巡检 + 抄送汇合兜底同周期（汇合独立于 patrolEnabled：它不是"巡视猜停顿"，是接悬空终点）
  _patrolSweepTimer = setInterval(() => { sweepIdleStops(); sweepFacetDrift(); sweepCcJoins() }, min * 60_000)
}
armPatrolSweep()
sweepFacetDrift()     // 启动即扫一遍 facet 漂移（抓重启前遗留）
rearmGracePatrols()   // 重启后复原未过期的巡视宽限窗（见 scheduleGracePatrol）

// ---------- E3 · 契约 deadline 强制结算 ----------
// 缘起（方案 §1 E3 原文）：「契约 deadline 到点强制『结算』：出晨检包 + 版本要么 RC_READY 要么明确顺延
// （**现在到点什么都不发生**）」。守航契约里 deadline 一直只是一行字：到点没有任何机器动作，于是
// 「到点安全收束、出晨检交付」这句承诺四轮一次没兑现过（`templates/守航晨检验收包.md` 0 份实例）。
// 这里补上：到点必出包、必给顺延清单。**装配器绝不因缺料而不出包** —— 标满「未接通」的包也远好过没有。
const GUARD_SETTLE_INTERVAL_MS = 5 * 60_000
const _settledRuns = new Set()   // 进程内去重；跨重启的去重靠台账里的 led.settledAt（见下）
// 「今天出过这一版的验收单没有」。**换基是刻意的**：出包已改为「版本 x 日期」幂等覆盖写，
// 旧的「这一轮有没有出过包」既不再用于去重（覆盖写天然幂等），也不能再喂 settleAtDeadline ——
// 那样上线第一天起 reportWritten 就恒为 true，`write_morning_report` 这条审计动作会**永久静音**。
function acceptanceReportWrittenToday(run, c) {
  const version = archiveVersionOf(guardArchiveRelFor(run, c)) || String(c?.fm?.version || '')
  if (version) return versionReportExistsToday(version)
  try { return fs.readdirSync(TASKS_DIR).some(f => f.endsWith(`-晨检包-${c.runName}.md`) && f.startsWith(todayStr())) } catch { return false }
}
async function sweepGuardDeadlines() {
  const guarded = Object.values(runs).filter(r => r.executionMode === 'guarded_run' && r.guardContract)
  const seen = new Set()
  for (const run of guarded) {
    const c = guardContractFor(run)
    if (!c || seen.has(c.runName) || _settledRuns.has(c.runName)) continue
    seen.add(c.runName)
    const led = guardLedgerFor(c.runName)
    if (led.settledAt) { _settledRuns.add(c.runName); continue }   // 已结算过（落在台账里，跨重启有效）
    // 结算判据用的条目表与晨检包**同一份派生结果**（契约点名/台账/门禁/park/覆盖矩阵），
    // 否则会出现「包里 2 条、顺延清单 0 条」这种自相矛盾。
    const archiveRel = guardArchiveRelFor(run, c)
    const items = morningReport.deriveItems({
      contract: c.contract, ledger: led, park: loadParkLedger(),
      rows: mergeFacetRowsForRun(archiveRel === run.taskFile ? run : { ...run, taskFile: archiveRel }) || [],
      startedAt: c.contract?.starts_at || '', endedAt: guardRoundEndFor(c),
    })
    const reportWritten = acceptanceReportWrittenToday(run, c)
    // 版本状态由**档案派生**（gates 布尔 + 条目终态），不再读 `led.versionState` —— 那个字段全仓没有写侧、
    // 恒为空，害得 `set_version_rc_ready` 每轮都触发。版本状态存进 run 分片的台账本身就是本次要治的错位。
    let versionState = ''
    try {
      const t = fs.readFileSync(safeResolve(archiveRel), 'utf8')
      versionState = versionReport.deriveVersionState(parseFrontmatter(t) || {}, extractEntries(t))
    } catch {}
    const s = morningReport.settleAtDeadline({ deadlineIso: c.contract.deadline, versionState, items, reportWritten })
    if (!s.due) continue
    _settledRuns.add(c.runName)
    led.settledAt = new Date().toISOString()
    saveGuardLedger(c.runName)
    const lines = s.actions.map(a => `· [${a.code}] ${a.why}`).join('\n')
    console.log(`[guard] deadline 结算 ${c.runName}：${s.why}\n${lines}`)
    // 到点先把单出出来。能绑到版本就出**版本验收单**（条目全表来自登记表），绑不到才退回轮次包；
    // 结算动作也一并写进去，不再只打 console —— 「为什么这几条没做完」老板在单里就能看见。
    try {
      const out = await assembleAcceptanceReport(run, { items, settleActions: s.actions })
      fs.writeFileSync(out.abs, out.body, 'utf8')   // 幂等覆盖写：同一版同一天重复出包只刷新内容、不新增文件
      const n = out.scope === 'version' ? `登记表 ${(out.entries || []).length} 条 · 守航 ${(out.rounds || []).length} 轮` : `条目 ${(out.items || []).length} 条`
      appendEvent(run.id, { type: 'lab', text: `🌅 守航契约 deadline 到点强制结算：已装配 \`${out.rel}\`（${n}${out.gaps.length ? `，缺料 ${out.gaps.length} 处已在单里标注` : ''}）。
${lines}` })
      broadcast({ type: 'morning-report', runName: out.runName || '', version: out.version || '', rel: out.rel, scope: out.scope, reason: 'deadline-settle' })
    } catch (e) { console.warn('[guard] deadline 结算出包失败:', e.message) }
    // 顺延清单：先与登记表对账（关掉已消化的），再 park 剩下的。**顺序不能反**——先 park 后对账
    // 等于刚关掉的下一次 deadline 又被塞回来，台账永远收敛不了。已在 QA 族/终态的条目直接跳过不 park。
    const defer = s.actions.find(a => a.code === 'defer_items')
    if (defer) {
      const byReq = entryRowsByReq(archiveRel)
      let park = loadParkLedger()
      const rec = reqPool.reconcilePark(park, byReq)
      park = rec.entries
      const skipped = [], parked = []
      for (const req of defer.items) {
        if (reqPool.shouldSkipDefer(byReq.get(String(req).toUpperCase()))) { skipped.push(req); continue }
        park = reqPool.recordPark(park, { req, reason: 'deadline 到点未达 RC_READY', probeKey: '范围', proposal: '（引擎自动顺延；下一轮优先领取）', kind: reqPool.PARK_KIND.DEFERRED }).entries
        parked.push(req)
      }
      saveParkLedger(park)
      if (rec.closed.length) console.log(`[guard] park 对账：关闭 ${rec.closed.length} 条（${rec.closed.map(x => `${x.req}←${x.status}`).join('、')}）`)
      if (archiveRel && (parked.length || skipped.length)) {
        appendTimelineLine(archiveRel, `deadline 结算：${parked.length ? `${parked.join('、')} 未达 RC_READY，明确顺延下一轮` : '无需顺延'}${skipped.length ? `；${skipped.join('、')} 已在推进（登记表非待处理态），不再 park` : ''}${rec.closed.length ? `；park 台账对账关闭 ${rec.closed.length} 条` : ''}（引擎自动记账，非无声挂起）`)
      }
    }
    broadcast({ type: 'guard-settled', runName: c.runName, actions: s.actions.map(a => a.code) })
  }
}
// 注：曾有一个 `sweepVersionReports()` 每日出单巡检（防「文件在、内容过期」）。
// 2026-08-31 验收单改为**看板上按需渲染的视图**后已删：视图的新鲜是免费的，
// 不存在过期问题，也就不需要每天往 tasks/ 堆一份文件。文件只在两个时机出现：
// deadline 到点结算（自动定格）与老板手点「定格」。
setInterval(() => { sweepGuardDeadlines().catch(e => console.warn('[guard] deadline 巡检异常:', e?.message || e)) }, GUARD_SETTLE_INTERVAL_MS)

// ============================================================================
// 守航目标循环（v0.11.0）：链停了、活没干完 → 引擎接着派人干
// 判定全在 guard-goal.js（纯函数、有单测）；这里只做三件事：算「链是不是真的静下来了」、派人、广播。
// 触发：每次收工（onTurnComplete 尾部，防抖 GOAL_TICK_DELAY_MS 让 autoChain 先把下一棒派出去）+ 5 分钟兜底扫一次。
// ============================================================================
const GOAL_TICK_DELAY_MS = Number(process.env.OFFICE_LAB_GOAL_TICK_MS || 45_000)
const GOAL_BOSS_CHAT_QUIET_MS = 10 * 60_000   // 老板在守航会话里聊天后，目标循环静默这么久再判（他在场时别插话）
const GOAL_MIN_GAP_MS = 60_000                 // 两次自动续跑之间至少隔这么久（防同一秒被事件 + 兜底各派一次）
const GOAL_TERMINAL = new Set(['met', 'waiting_boss', 'blocked', 'budget_limited', 'off', 'no_contract'])
const _goalTimers = new Map()                  // runName → timeout
const _goalTicking = new Set()                 // runName 正在判（单飞锁，同 Codex 的 continuation_lock）
const goalGloballyEnabled = () => chainConfig.guardGoalEnabled !== false && chainConfig.enabled !== false

// 契约 run_name → 契约条目（热缓存优先，退回按文件名反推）
function guardContractByRunName(runName) {
  const hit = guardContracts.get(runName)
  if (hit) return loadGuardContract(hit.rel) || hit
  const m = String(runName || '').match(/^(\d{4}-\d{2}-\d{2})-guarded-(\d+)$/)
  return m ? loadGuardContract(`${OFFICE_URI_PREFIX}/tasks/${m[1]}-守航契约-guarded-${m[2]}.md`) : null
}
// ⚠ 只认**显式**绑了契约的 run（审查发现 #6）：原先走 guardContractFor 的 fallback——兜底扫每 5 分钟对全部 run 调一次，
// 会把没绑契约的老守航 run 静默认领到最新契约并落库（污染台账与活性判断，还每次 readdirSync）。
// 正常路径不受影响：守航 run 在 createDispatchRun 那一刻就已经调过 guardContractFor、把契约写进 run.guardContract。
const contractRunNameOf = r => (r && r.executionMode === 'guarded_run' && r.guardContract ? loadGuardContract(r.guardContract)?.runName || '' : '')

// 「链是不是真的静下来了」：链上任何一条会话在跑 / 有后台任务 / 待处理队列里还有它的活 / 巡视或陪练正盯着它 → 不判续跑
function guardChainLiveness(runName, { since = '' } = {}) {
  const mine = Object.values(runs).filter(r => contractRunNameOf(r) === runName)
  if (mine.some(r => r.engineHandoverPending)) return { busy: true, busyWhy: '基座交接尚未完成', mine }
  const ids = new Set(mine.map(r => r.id))
  const running = mine.find(r => r.status === 'running' || r.status === 'starting')
  if (running) return { busy: true, busyWhy: `${EMPLOYEES[running.employee]?.displayName || running.employee} 正在跑（${running.id}）`, mine }
  const watcher = Object.values(runs).find(r => (r.status === 'running' || r.status === 'starting') && ((r.patrolTarget && ids.has(r.patrolTarget)) || (r.auditTarget && ids.has(r.auditTarget))))
  if (watcher) return { busy: true, busyWhy: `${EMPLOYEES[watcher.employee]?.displayName || watcher.employee} 正在看这条链（${watcher.id}）`, mine }
  for (const [emp, q] of Object.entries(pendingQueues)) {
    const it = (q || []).find(x => x.goalRunName === runName || (x.guardContract && guardContractByRunName(runName)?.rel === x.guardContract) || (x.callerRunId && ids.has(x.callerRunId)) || (x.resumeRunId && ids.has(x.resumeRunId)) || (x.ccJoinOrigin && ids.has(x.ccJoinOrigin)))
    if (it) return { busy: true, busyWhy: `${EMPLOYEES[emp]?.displayName || emp} 的待处理队列里还有这一轮的活`, mine }
  }
  if (mine.some(r => _graceTimers.has(r.id) || r.patrolGraceUntil)) return { busy: true, busyWhy: '巡视宽限窗未结束', mine }
  const bg = mine.find(r => r._bgTasks?.size)
  const last = mine.slice().sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null
  // 老板刚在守航会话里跟员工聊（chat 轮）→ 他在场，别在他眼皮底下另起一条会话插话；10 分钟后兜底扫再判
  if (last && last.lastKind === 'chat' && Date.now() - (Date.parse(last.updatedAt || '') || 0) < GOAL_BOSS_CHAT_QUIET_MS) {
    return { busy: true, busyWhy: `老板刚在和 ${EMPLOYEES[last.employee]?.displayName || last.employee} 聊，先不插话`, mine, last }
  }
  return {
    busy: false, mine, last,
    bgWaiting: bg ? `${EMPLOYEES[bg.employee]?.displayName || bg.employee} 的 ${bg._bgTasks.size} 个后台任务` : '',
    errored: !!(last && (last.status === 'error' || last._poisoned)),
    erroredWhy: last?.leakedInvoke ? '工具调用写成了正文' : last?._poisoned ? '会话空转' : last?.status === 'error' ? '报错/空收工' : '',
    // 审查发现 #7：原先只看最后一条——老板按停了 X、链上别的 run 后更新，就会被当成没停；引擎重启把在跑的
    // run 打成 interrupted（半截活、可能有未提交改动），也不算停，5 分钟后兜底扫就在它上面另起续跑。
    // 现在：自上次老板动手（goal.resetAt）以来，链上任何一条被老板按停、或某员工最新那条被重启打断 → 暂停交回老板。
    userStopped: mine.some(r => r.userStoppedAt && String(r.userStoppedAt) > since),
    interrupted: (() => {
      const latestBy = {}
      for (const r of mine) if (!latestBy[r.employee] || String(r.updatedAt || '') > String(latestBy[r.employee].updatedAt || '')) latestBy[r.employee] = r
      const hit = Object.values(latestBy).find(r => r.status === 'interrupted' && String(r.updatedAt || '') > since)
      return hit ? `${EMPLOYEES[hit.employee]?.displayName || hit.employee} 的会话被引擎重启打断（${hit.id}）` : ''
    })(),
    gateText: last ? (parsePendingGate(last.result) || '') : '',
  }
}

// 判一次（readOnly=true：只算不记，给 goal_status / 验收台 GET 用）
function guardGoalEvaluate(c, { readOnly = false, liveness = null } = {}) {
  const led = acceptanceCard.ensureStores(guardLedgerFor(c.runName))
  const archiveRel = guardArchiveRelFor({}, c)
  const entries = entryRowsByReq(archiveRel)
  const live = liveness || guardChainLiveness(c.runName, { since: String(led.goal?.resetAt || '') })
  const mode = guardGoal.goalModeOf(c.contract, { globalEnabled: goalGloballyEnabled() })
  const ev = guardGoal.evaluateGoal({ contract: c.contract, ledger: led, entries, mode, goal: led.goal || {}, liveness: live })
  return { ...ev, goal: led.goal || {}, led, archiveRel, entries, live }
}

async function guardGoalTick(runName, { source = 'event' } = {}) {
  if (!runName || _goalTicking.has(runName)) return null
  _goalTicking.add(runName)
  try {
    const c = guardContractByRunName(runName)
    if (!c) return null
    let ev = guardGoalEvaluate(c)
    const { led, archiveRel, entries, live } = ev
    let goal = led.goal || {}
    let dispatched = null
    if (ev.verdict === 'continue' && ev.mode === 'active') {
      const owner = ev.next.owner
      const lane = live.last?.lane
      const tooSoon = goal.lastDispatchAt && Date.now() - Date.parse(goal.lastDispatchAt) < GOAL_MIN_GAP_MS
      if (tooSoon) ev = { ...ev, verdict: 'wait', why: '刚派过一棒，等它开工' }
      else if (busyRunFor(owner, lane)) ev = { ...ev, verdict: 'wait', why: `${EMPLOYEES[owner]?.displayName || owner} 正忙别的会话，等它空出来` }
      else {
        const rows = mergeFacetRowsForRun({ taskFile: archiveRel }) || []
        const sig = guardGoal.progressSignature({ reqs: guardGoal.scopeReqs(c.contract, led), ledger: led, entries, rows })
        const plan = guardGoal.planContinuation(ev, goal, sig)
        ev = plan.ev; goal = plan.goal
        if (plan.dispatch) {
          const snapRun = (live.mine || []).filter(r => r.employee === owner && r.lastSnapshot).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0]
          const snapshot = snapRun ? stallGuard.renderResumeSnapshot([snapRun.lastSnapshot]) : ''
          const gateNote = live.gateText && !acceptanceCard.looksCostly(live.gateText)
            ? `\n\n【上一棒停在一句「等你拍板」上】原话：「${flat(live.gateText)}」。它**没有用 raise_risk 登记**、看着也不像反悔代价大的事——按三种不确定重新判：查得清就查，可以反悔就自己定（record_decision），真是③类才 raise_risk。`
            : ''
          const instruction = guardGoal.renderContinuation({ ev, runName, contractRel: c.rel, snapshot, turn: goal.turns }) + gateNote
          const nr = createDispatchRun({ employee: owner, taskFile: archiveRel || null, instruction, kind: 'dispatch', executionMode: 'guarded_run', guardContract: c.rel, threadRootId: live.last?.threadRootId || undefined, lane, engineOrigin: 'goal-loop' })
          nr.goalTurn = goal.turns; nr.goalRunName = runName
          saveRegistry()
          appendEvent(nr.id, { type: 'lab', text: `🎯 守航目标循环第 ${goal.turns}/${ev.maxGoalTurns} 轮：这一轮还没干完（${ev.why}），引擎派你接着做 ${ev.next.items.map(i => i.req).join('、')}。` })
          dispatched = { runId: nr.id, owner }
        }
      }
    }
    const rv = guardGoal.recordVerdict(goal, ev)
    led.goal = rv.goal
    if (dispatched) led.goal.lastDispatchRunId = dispatched.runId
    saveGuardLedger(runName)
    if (rv.changed || dispatched) {
      const line = guardGoal.renderGoalLine(ev, led.goal)
      broadcast({ type: 'guard-goal', runName, verdict: ev.verdict, why: ev.why, line, owner: dispatched?.owner || '', runId: dispatched?.runId || '', source })
      if (rv.changed && GOAL_TERMINAL.has(ev.verdict) && live.last) {
        appendEvent(live.last.id, { type: 'lab', text: `🎯 守航目标循环：${line}${ev.verdict === 'met' || ev.verdict === 'waiting_boss' ? '——打开「验收台」看卡片。' : ''}` })
        if (pushConfig.enabled && ['met', 'waiting_boss', 'blocked'].includes(ev.verdict)) {
          try { sendBark({ title: ev.verdict === 'met' ? '🌅 守航这一轮干完了' : ev.verdict === 'waiting_boss' ? '⏸ 守航在等你拍板' : '⛔ 守航卡住了', body: line.slice(0, 300), icon: empIconUrl('feifei') }) } catch { }
        }
      }
      if (ev.mode === 'shadow' && ev.verdict === 'continue' && rv.changed && live.last) {
        appendEvent(live.last.id, { type: 'lab', text: `🎯（影子模式，只记不派）${line}` })
      }
    }
    return { ev, dispatched }
  } catch (e) { console.warn('[guard-goal] tick 异常:', e?.message || e); return null }
  finally { _goalTicking.delete(runName) }
}

// 收工后排一次判定（防抖）。巡视员/陪练 run 自己不在契约里，按它盯的目标 run 归账。
function scheduleGuardGoalTick(run, delay = GOAL_TICK_DELAY_MS) {
  try {
    const subject = run?.patrolTarget ? runs[run.patrolTarget] : run?.auditTarget ? runs[run.auditTarget] : run
    const runName = contractRunNameOf(subject)
    if (!runName) return
    clearTimeout(_goalTimers.get(runName))
    _goalTimers.set(runName, setTimeout(() => { _goalTimers.delete(runName); guardGoalTick(runName, { source: 'turn-end' }) }, delay))
  } catch { }
}
// 老板动了手（回话 / 在验收卡上操作）：清零轮数与无进展计数，视为新的授权
function guardGoalBossTouched(runName, why) {
  if (!runName) return
  const led = guardLedgerFor(runName)
  if (!led) return
  led.goal = guardGoal.resetGoal(led.goal || {}, why)
  led.goal.lastVerdict = 'reset'
  saveGuardLedger(runName)
}
// 兜底扫：事件可能因重启 / 巡视 run 不在契约里而漏掉。只扫「没到终局、没过期」的轮次。
function sweepGuardGoals() {
  if (!goalGloballyEnabled()) return
  const seen = new Set()
  for (const r of Object.values(runs)) {
    const runName = contractRunNameOf(r)
    if (!runName || seen.has(runName)) continue
    seen.add(runName)
    const c = guardContractByRunName(runName)
    const dl = Date.parse(String(c?.contract?.deadline || '').replace(' ', 'T'))
    if (Number.isFinite(dl) && Date.now() > dl + 15 * 60_000) continue
    const led = guardLedgerFor(runName)
    if (GOAL_TERMINAL.has(led?.goal?.lastVerdict)) continue
    guardGoalTick(runName, { source: 'sweep' })
  }
}
setInterval(sweepGuardGoals, GUARD_SETTLE_INTERVAL_MS)

// 验收卡截图入库：仓内能解析的路径原样用；猪猪产物（仓外绝对路径）复制进 tasks/验收卡素材/<轮次>/，
// 否则 /api/file 读不到（它只放行仓内文件）、猪猪清理产物后截图也会没。
const CARD_SHOT_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i
function stashCardShot(runName, req, src) {
  const s = String(src || '').trim()
  if (!s) return { error: '空路径' }
  if (/^(https?:|data:)/i.test(s)) return { src: s }
  if (!CARD_SHOT_EXT.test(s)) return { error: '不是图片（只收 png/jpg/gif/webp/bmp）' }
  if (resolveRepoFile(s)) return { src: s.replace(/\\/g, '/') }
  let abs = ''
  try { abs = path.resolve(s) } catch { }
  if (!abs || !fs.existsSync(abs)) return { error: '文件不存在（给仓内相对路径，或猪猪产物的绝对路径）' }
  try {
    const dir = path.join(TASKS_DIR, '验收卡素材', String(runName || 'adhoc').replace(/[^\w.-]+/g, '_'))
    fs.mkdirSync(dir, { recursive: true })
    const name = `${String(req || 'REQ').toUpperCase().replace(/[^\w-]+/g, '_')}-${path.basename(abs)}`
    fs.copyFileSync(abs, path.join(dir, name))
    return { src: `${OFFICE_URI_PREFIX}/tasks/验收卡素材/${path.basename(dir)}/${name}` }
  } catch (e) { return { error: `复制失败：${e.message}` } }
}

// 给前端的目标循环摘要（大白话一行 + 最近几次判定），不把台账/Map 原样吐出去
function goalView(ev) {
  if (!ev) return null
  const g = ev.goal || {}
  return {
    verdict: ev.verdict, why: ev.why, line: guardGoal.renderGoalLine(ev, g), mode: ev.mode,
    turns: Number(g.turns || 0), maxGoalTurns: ev.maxGoalTurns || guardGoal.GOAL_DEFAULTS.maxGoalTurns,
    counts: ev.counts || null, history: (g.history || []).slice(-6),
  }
}
// 验收卡装配：file（一版全部条目，跨多轮合并）或 runName（一轮）。数据全是机器事实 + 员工填的卡片格。
function acceptanceCardsFor({ file = '', runName = '' } = {}) {
  if (file) {
    const version = archiveVersionOf(file)
    const rounds = version ? guardRoundsForVersion(version, file) : []
    const entries = entryRowsByReq(file)
    const reqs = [...entries.keys(), ...rounds.flatMap(r => guardGoal.scopeReqs(r.contract, r.ledger))]
    const latest = rounds.length ? guardContractByRunName(rounds[rounds.length - 1].runName) : null
    const ev = latest ? guardGoalEvaluate(latest) : null
    const built = acceptanceCard.buildCards({ reqs, ledgers: rounds.map(r => r.ledger), entries, rows: mergeFacetRowsForRun({ taskFile: file }) || [], goal: ev })
    // 审查发现 #5：原先卡片带的是「最后一轮有这张卡的台账」、没有就退到最新一轮——共驾做的条目被当成守航条目派工，
    // 在 A 轮建卡、现在活在 B 轮的条目动作落到 A（A 过期还会再签一份契约）。
    const scopes = rounds.map(r => ({ runName: r.runName, set: new Set(guardGoal.scopeReqs(r.contract, r.ledger)) }))
    for (const cd of built.cards) cd.runName = [...scopes].reverse().find(sc => sc.set.has(cd.req))?.runName || ''
    return { ok: true, scope: 'version', title: version ? `${version} 验收卡` : '验收卡', version, file, runName: latest?.runName || '', contractRel: latest?.rel || '', deadline: latest?.contract?.deadline || '', goal: goalView(ev), ...built }
  }
  const c = runName ? guardContractByRunName(runName) : loadGuardContract(latestGuardedContractRel())
  if (!c) return { ok: true, scope: 'round', title: '验收卡', cards: [], summary: acceptanceCard.summarizeCards([]), rounds: [], goal: null, empty: '还没有任何一轮守航' }
  const ev = guardGoalEvaluate(c)
  const reqs = guardGoal.scopeReqs(c.contract, ev.led)
  const built = acceptanceCard.buildCards({ reqs, ledgers: [ev.led], entries: ev.entries, rows: ev.archiveRel ? (mergeFacetRowsForRun({ taskFile: ev.archiveRel }) || []) : [], goal: ev })
  const version = String(c.fm?.version || '') || archiveVersionOf(ev.archiveRel)
  // legacy：v0.11.0 前签发的轮次没有 goal 块——那时还没有验收卡，卡片里只有机器能补的部分，前端据此提示一句、别让老板以为员工漏填
  return { ok: true, scope: 'round', title: `守航 ${c.runName}${version ? ` · ${version}` : ''}`, version, file: ev.archiveRel || '', runName: c.runName, contractRel: c.rel, deadline: c.contract?.deadline || '', legacy: !(c.contract?.goal && typeof c.contract.goal === 'object'), goal: goalView(ev), recent: recentGuardRounds(), ...built }
}
// 最近几轮守航（验收台的轮次下拉）：文件名按 日期+序号，倒序即时间倒序
function recentGuardRounds(n = 8) {
  try {
    return fs.readdirSync(TASKS_DIR).filter(f => /守航契约-guarded-\d+\.md$/.test(f)).sort().reverse().slice(0, n).map(f => {
      const e = loadGuardContract(`${OFFICE_URI_PREFIX}/tasks/${f}`)
      return e ? { runName: e.runName, version: String(e.fm?.version || ''), deadline: String(e.contract?.deadline || '') } : null
    }).filter(Boolean)
  } catch { return [] }
}

// 老板在卡片上的一次动作 → 记账 + 必要时把条目交回流水线
// 验收卡动作派菲菲的统一出口（审查发现 #2：原先三条路径只有一条查忙——她正跑着时另起一条会话，两条并跑撞同一工作树）
function dispatchFeifeiForCard({ instruction, archiveRel = '', contractRel = '', runName = '' }) {
  const guarded = contractRel ? { executionMode: 'guarded_run', guardContract: contractRel } : {}
  if (busyRunFor('feifei')) {
    queuePending('feifei', { kind: 'forward', fromEmployee: 'feifei', deliver: 'new', text: instruction.slice(0, 300), instruction, taskFile: archiveRel || null, goalRunName: runName || undefined, ...guarded })
    return { queued: true }
  }
  const r = createDispatchRun({ employee: 'feifei', taskFile: archiveRel || null, instruction, kind: 'dispatch', engineOrigin: 'acceptance-card', ...guarded })
  return { runId: r.id }
}
async function applyAcceptanceAction({ runName = '', req: reqId = '', action = '', id = '', choice = '', note = '', file = '' } = {}) {
  const key = acceptanceCard.normReq(reqId)
  if (!/^REQ-\d+/.test(key)) throw Object.assign(new Error(`条目编号不合法：${reqId}`), { status: 400 })
  if (!acceptanceCard.CARD_ACTIONS.includes(action)) throw Object.assign(new Error(`不认识的动作：${action}`), { status: 400 })
  const c = runName ? guardContractByRunName(runName) : null
  const archiveRel = (c ? guardArchiveRelFor({}, c) : '') || String(file || '')
  const say = String(note || '').trim()
  const stamp = t => { if (archiveRel) appendTimelineLine(archiveRel, `验收卡 · 老板对 ${key}：${t}${say ? `（原话：「${flat(say)}」）` : ''}`) }
  // 通过：登记表只许往前推（待人工验收/QA通过 → 人工Pass），其余状态不动——引擎从不替老板按发布门
  const markAccepted = async () => {
    if (!archiveRel) return
    const cur = entryRowsByReq(archiveRel).get(key)
    if (!cur || !['待人工验收', 'QA通过', '待人工'].includes(cur.status)) return
    try {
      const abs = safeResolve(archiveRel)
      await withArchiveLock(abs, () => { engineSetEntryRow(abs, { no: key, status: '人工Pass', stage: '老板在验收卡上验收通过' }); engineSetFrontmatterScalar(abs, 'updated', todayStr()) })
      broadcast({ type: 'tasks-changed' })
    } catch (e) { console.warn('[acceptance] 置人工Pass 失败:', e.message) }
  }
  if (!c) {
    // 非守航条目（共驾做的）：只有「通过」「打回」两个动作有意义——决定/高危只存在于守航台账里
    if (action === 'accept') { await markAccepted(); stamp('验收通过'); return { ok: true } }
    if (action === 'reject') {
      if (!say) throw Object.assign(new Error('打回要写一句原因'), { status: 400 })
      stamp('打回')
      return { ok: true, ...dispatchFeifeiForCard({ instruction: `【老板在验收卡上打回】${key}：「${say}」。按他的话安排返工（改需求/facet → 交 GG Bond → 迷糊重测），老板的原话就是口径，不必再确认。`, archiveRel }) }
    }
    throw Object.assign(new Error('这条不是守航轮做的，没有「替你定的决定 / 高危事项」可操作'), { status: 400 })
  }
  const led = acceptanceCard.ensureStores(guardLedgerFor(c.runName))
  const res = acceptanceCard.applyCardAction(led, { req: key, action, id, choice, note: say }, 'boss')
  if (res.error) throw Object.assign(new Error(res.error), { status: 400 })
  const label = { accept: '验收通过', reject: '打回', decision_ok: `追认决定 ${id}`, decision_change: `改掉决定 ${id}`, risk_choose: `高危事项 ${id} 选「${choice}」`, risk_deny: `高危事项 ${id} 不做`, risk_proceed: `高危事项 ${id} 先按推荐做` }[action]
  stamp(label)
  if (action === 'accept') await markAccepted()
  let out = { ok: true }
  if (res.reopen) {
    const prev = led.itemResults?.[res.reopen] || {}
    guardLedger.recordItemResult(led, res.reopen, { result: 'in_progress', force: true, needsBoss: false, stopWhy: `老板在验收卡上：${label}` })
    led.rulings = [...(led.rulings || []), { at: new Date().toISOString(), req: res.reopen, action, id, choice, note: say, instruction: res.instruction }].slice(-100)
    guardGoalBossTouched(c.runName, `老板在验收卡上：${label}`)
    const instruction = `【老板在验收卡上拍板】${res.instruction}\n\n老板这次点击 + 原话就是授权和口径：**按原话执行、不必再确认**。做完照常交棒（改需求/facet → GG Bond → 迷糊重测），并补齐这条的验收卡。`
    const dl = Date.parse(String(c.contract?.deadline || '').replace(' ', 'T'))
    if (Number.isFinite(dl) && Date.now() < dl) {
      // 契约还有效：直接派菲菲（她忙就排队，排队项带守航态 + 契约，别在队列里掉态，§22.5）
      out = { ok: true, reopened: res.reopen, ...dispatchFeifeiForCard({ instruction, archiveRel, contractRel: c.rel, runName: c.runName }) }
    } else if ((() => { const rel = led.carryContracts?.[res.reopen]; const nc = rel ? loadGuardContract(rel) : null; const ndl = Date.parse(String(nc?.contract?.deadline || '').replace(' ', 'T')); return nc && Number.isFinite(ndl) && Date.now() < ndl })()) {
      // 这条已经凭上一次点击签过一份续跑契约、还没过期 → 复用它，别每点一次就签一份（审查发现 #2）
      const nc = loadGuardContract(led.carryContracts[res.reopen])
      const nl = acceptanceCard.ensureStores(guardLedgerFor(nc.runName))
      guardLedger.recordItemResult(nl, res.reopen, { result: 'in_progress', force: true, needsBoss: false, stopWhy: `老板在验收卡上：${label}` })
      saveGuardLedger(nc.runName)
      out = { ok: true, reopened: res.reopen, contract: nc.rel, reused: true, ...dispatchFeifeiForCard({ instruction, archiveRel, contractRel: nc.rel, runName: nc.runName }) }
    } else {
      // 契约已过期：凭这次点击签一份续跑契约（只含这一条），卡片/决定/高危随条目搬过去，别让老板的操作落在一张过期的纸上
      const contract = issueGuardedContract({
        source: 'named', picks: [res.reopen], maxItems: 1,
        carryOver: [{ req: res.reopen, stopWhy: prev.stopWhy || '', proposal: prev.proposal || '', parkRounds: 0 }],
        rulings: { [res.reopen]: `${res.instruction}${say ? `（原话：「${say}」）` : ''}` }, fromRunName: c.runName,
        note: `老板在验收卡上对 ${res.reopen} 的操作（${label}）即本契约的签发依据。`,
      })
      const nl = acceptanceCard.ensureStores(guardLedgerFor(contract.runName))
      nl.startedAt = new Date().toISOString(); nl.carriedOverFrom = c.runName
      led.carryContracts = { ...(led.carryContracts || {}), [res.reopen]: contract.rel }
      if (led.cards?.[res.reopen]) nl.cards[res.reopen] = { ...led.cards[res.reopen] }
      // 还开着的决定/高危**搬**过去（旧台账标 moved、版本视图不重复显示）；已裁过的留在原轮次当历史（审查发现 #2）
      for (const d of led.decisions.filter(d => d.req === res.reopen && d.status === 'open')) { nl.decisions.push({ ...d, movedFrom: c.runName }); d.status = 'moved'; d.movedTo = contract.runName }
      for (const r of led.risks.filter(r => r.req === res.reopen && r.status === 'open')) { nl.risks.push({ ...r, movedFrom: c.runName }); r.status = 'moved'; r.movedTo = contract.runName }
      guardLedger.recordItemResult(nl, res.reopen, { result: 'in_progress', stopWhy: `承接 ${c.runName}：老板在验收卡上${label}` })
      saveGuardLedger(contract.runName)
      out = { ok: true, reopened: res.reopen, contract: contract.rel, ...dispatchFeifeiForCard({ instruction: `${guardedResumeInstruction({ contract, pending: { runName: c.runName }, rulings: contract.rulings })}\n\n${instruction}`, archiveRel, contractRel: contract.rel, runName: contract.runName }) }
    }
  }
  saveGuardLedger(c.runName)
  broadcast({ type: 'acceptance-cards-changed', runName: c.runName, req: key })
  return out
}

// ---------- 伙伴看护：引擎反过来盯托盘（Windows） ----------
// 为什么由引擎来干：托盘死了引擎不会跟着死（实测——托盘被硬杀时 Quit-Tray/Stop-Server 一行不跑，
//   它用 CreateNoWindow 起的 node/vite 变孤儿继续跑），所以引擎是唯一现成、天生无窗口的看护者。
//   托盘 59 次启动里 56 次无声消失、死因未定，用户感知是「整个 lab 没了」而其实丢的只是控制面。
// 判据与三条设计约束（只恢复不引入 / 判活走 mutex 不枚举进程 / 探不到 ≠ 不在）全部落在
//   `tray-watchdog.js` 的纯函数里并有 17 条单测；这里只做 I/O 接线。
const TRAY_WATCHDOG_ON = process.platform === 'win32' && process.env.OFFICE_LAB_TRAY_WATCHDOG !== '0'
const TRAY_SCRIPT = path.join(OFFICE_ROOT, 'tray', 'office-lab-tray.ps1')
let _traySawAlive = false          // 约束①的闭锁：没亲眼见过它活着，就不许"恢复"
let _trayRelaunchedAt = []
let _trayLastRelaunchAt = null

function probeTrayAlive() {
  return new Promise(resolve => {
    let out = ''
    let done = false
    const child = spawn('powershell.exe', trayWatchdog.trayAliveProbeArgs(), { windowsHide: true })
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill() } catch { } resolve(null) } }, 8000)
    child.stdout?.on('data', d => { out += d.toString() })
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } })
    child.on('close', () => {
      if (done) return
      done = true; clearTimeout(timer)
      resolve(trayWatchdog.parseTrayAliveProbe(out))
    })
  })
}

async function sweepTrayWatchdog() {
  if (!TRAY_WATCHDOG_ON) return
  const alive = await probeTrayAlive()
  if (alive === true && !_traySawAlive) {
    _traySawAlive = true
    console.log('[tray-watchdog] 已确认托盘在运行，进入看护（此后它若消失会被拉起一次）')
  }
  const now = Date.now()
  const d = trayWatchdog.decideTrayAction({
    platform: process.platform, enabled: true, trayAlive: alive, sawTrayAlive: _traySawAlive,
    now, relaunchedAt: _trayRelaunchedAt, lastRelaunchAt: _trayLastRelaunchAt,
  })
  if (d.action !== 'relaunch') {
    // 只在"值得说"的状态下出声，别把日志刷成噪音（tray-alive 每 2 分钟一条毫无价值）
    if (d.reason === 'rate-limited') console.warn('[tray-watchdog] 已达限流上限，停手不再拉起——有东西在系统性地杀托盘，请查 tray.log 与本进程日志')
    else if (d.reason === 'probe-inconclusive') console.warn('[tray-watchdog] 判活探不到结果（PowerShell 起不来/超时），本轮不动手')
    return
  }
  if (!fs.existsSync(TRAY_SCRIPT)) { console.warn('[tray-watchdog] 托盘脚本不存在，跳过：', TRAY_SCRIPT); return }
  const spec = trayWatchdog.trayRelaunchSpec(TRAY_SCRIPT)
  try {
    const child = spawn(spec.file, spec.args, spec.options)
    child.unref()
    _trayRelaunchedAt = trayWatchdog.noteRelaunch(_trayRelaunchedAt, now)
    _trayLastRelaunchAt = now
    console.warn(`[tray-watchdog] 托盘不在了（本轮判死），已拉起一个（pid ${child.pid}，窗口隐藏）。窗口内第 ${_trayRelaunchedAt.length}/${trayWatchdog.RELAUNCH_MAX_IN_WINDOW} 次`)
    // ★ 拉起后必须**回头复核**，不能拿「spawn 没抛」当成功。
    //   代价血淋淋（§3.131）：第一版规格带 `detached: true`，Windows 上等于 DETACHED_PROCESS、
    //   PowerShell 拿不到控制台 → **启动即静默退出、退出码还是 0**。拿到了 pid、close 事件给 0、
    //   一切"正常"，而托盘连 tray.log 第一行都没写。只有回头再判一次活，才能把这类失败叫出来。
    setTimeout(() => {
      probeTrayAlive().then(a => {
        if (a === true) console.log('[tray-watchdog] 复核：托盘已起来')
        else console.warn(`[tray-watchdog] ★ 复核失败：拉起后 ${trayWatchdog.RELAUNCH_VERIFY_DELAY_MS / 1000}s 仍判「${a === null ? '探不到' : '不活'}」——这次拉起没生效，去看 app/runs/tray.log 有没有「==== 托盘启动」那一行（没有＝进程压根没跑起来）`)
      }).catch(() => { })
    }, trayWatchdog.RELAUNCH_VERIFY_DELAY_MS)
  } catch (e) {
    console.warn('[tray-watchdog] 拉起托盘失败:', e?.message || e)
  }
}
if (TRAY_WATCHDOG_ON) {
  setInterval(() => { sweepTrayWatchdog().catch(e => console.warn('[tray-watchdog] 巡检异常:', e?.message || e)) }, trayWatchdog.WATCHDOG_INTERVAL_MS)
  console.log(`[tray-watchdog] 已启用（每 ${trayWatchdog.WATCHDOG_INTERVAL_MS / 1000}s 判活一次；OFFICE_LAB_TRAY_WATCHDOG=0 可关）`)
}

// A 状态自动化：单条目自动跟手 —— run 由「条目接棒」派起（带 run.entryNo）、又发了【下一棒】<下游> 时，
// 把**该单条目**自动推到下游的入站状态。只做最高价值且无歧义的一档：交 QA = 待测（v5.15「预检通过却漏交/漏更新」主坑）。
// 只动这一条、绝不猜别的条目（多条目 run 无 entryNo → 不动，靠下方一致性提醒兜底）。
const HANDOFF_INBOUND = { mihu: '待测' }   // 菲斯拉不走「待测」入站——她是教导主任、由迷糊 QA 结论审计触发（spawnAudit），非条目接棒
async function autoAdvanceEntry(run, nextKey) {
  if (!run.taskFile || !run.entryNo || !nextKey || nextKey === run.employee) return
  const status = HANDOFF_INBOUND[nextKey]; if (!status) return
  let abs; try { abs = safeResolve(run.taskFile) } catch { return }
  if (!abs.startsWith(TASKS_DIR + path.sep) || !fs.existsSync(abs)) return
  try {
    await withArchiveLock(abs, () => { engineSetEntryRow(abs, { no: run.entryNo, status, stage: `${status} → 待${EMPLOYEES[nextKey]?.displayName || nextKey}` }); engineSetFrontmatterScalar(abs, 'updated', todayStr()) })
    broadcast({ type: 'tasks-changed' })
    appendEvent(run.id, { type: 'lab', text: `条目 #${run.entryNo} 已自动跟手为「${status}」（本轮交接给${EMPLOYEES[nextKey]?.displayName || nextKey}，看板同步）。` })
  } catch (e) { console.warn('[autoAdvanceEntry]', e.message) }   // 条目不存在/无状态列等 → 静默，交一致性提醒
}
// A 一致性提醒（软，不硬拦）：交 QA 却没有任何条目进入「待测族」→ 提示补 set_entry_status，兜多条目/口头审批场景。
function nudgeBoardConsistency(run, nextKey) {
  if (nextKey !== 'mihu' || !run.taskFile) return   // 只对交 QA(迷糊)提醒；菲斯拉是审计触发、不走「待测」条目，无此提醒
  try {
    const entries = extractEntries(fs.readFileSync(safeResolve(run.taskFile), 'utf8'))
    if (entries.length && !entries.some(e => /待测|待QA|QA中|已开发/.test(e.status || ''))) {
      appendEvent(run.id, { type: 'lab', text: '⚠️ 看板未跟手：本轮交接给迷糊(QA)，但登记表没有任何条目处于「待测/待QA」——请补 set_entry_status 把已过检条目置「待测」，否则迷糊不知道测哪些（v5.15「只测一个需求点」即此坑）。' })
      broadcast({ type: 'board-stale', runId: run.id, taskFile: run.taskFile })
    }
  } catch { }
}

// 干完一棒后决定要不要自动派下一棒 / 回发。所有守卫都在服务端强制，不依赖 agent 是否守规矩。
// 交接被引擎硬拦 / 算不动而无法执行时的统一升级出口：**绝不静默死停**。
// (1) 打持久「交接受阻」签名 handoffBlockedSig=updatedAt——供 patrolEligible 破除「结果里有交接标记＝已妥善收尾」的假象，
//     让巡视/定时兜底仍能捞到这条（非 `_` 前缀→跨重启有效）；(2) 立即推一条「需人工·待接管」通知给老板。
// 缘起（2026-08-19 事故 run 20260819013336-bfe74f）：迷糊无 taskFile 的对齐评审交回菲菲，被 QA 覆盖率闸门
// 「缺 taskFile」抛错→ fail-closed 静默 return 吞掉交接；菲菲那头永远没收到、手机端却显示正常收工、巡视又因
// 「结果里有【交回】标记」把它当合法收尾放行→ 彻底静默死停、无人发觉。此出口把「拦下」和「无人知」两头都堵上。
function escalateBlockedHandoff(run, detail) {
  try {
    run.handoffBlockedSig = run.updatedAt || String(run.startedAt || '')
    saveRegistry()
    const name = EMPLOYEES[run.employee]?.displayName || run.employee
    const text = `${name} 的交接被引擎拦下、未能执行：${detail}。需你介入接管（会话 ${run.id}）。`
    pushNotify({ type: 'stop', runId: run.id, status: 'blocked', employee: run.employee, employeeName: name, gate: text, taskName: taskShortName(run.taskFile), lastKind: run.lastKind || '', resultTail: cleanForPush(run.result || '').slice(0, 180) })
    if (pushConfig.enabled) sendBark({ title: `⛔ ${name} 交接受阻·待接管`, subtitle: taskShortName(run.taskFile) || undefined, body: text.slice(0, 320), icon: empIconUrl(run.employee) })
    broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'escalated', text })
  } catch (e) { console.warn('[escalateBlockedHandoff] 异常:', e.message) }
}

// ---------- 抄送(cc)汇合闸：谁 cc 出去，引擎负责在扇出全部收工那刻把他唤回收口 ----------
// 缘起（2026-09-01 事故，发起 run 20260901063554-dc604c 菲菲「REQ-0326~0330 三方会审」）：
// 菲菲 cc 双发技术体检(GG Bond)/可测性体检(迷糊)后收工，自述「两人完成时看板会通知我，我接着收敛」——
// **引擎从来没有这个机制**。cc 派生的兄弟 run 是 callerRunId=null（设计如此：cc 不回发），ccFrom 全仓只用于
// logConversation 记流水，没有任何「扇出全部收工 → 唤回发起人」的汇合点。于是两人各自填完会审记录收工，
// 小呆呆三条巡视分别判「合法收工」（各自站在自己判据上都判对了：发起方明确豁免回发），**没有任何一轮的
// 视角是「这条扇出的汇合点没人接」** → 47 个 facet 永久卡在「_待菲菲汇总_」，会审从老板视角看就是「中断」了。
// 三条交接原语里，【下一棒】靠 spawnForward 续、【交回】靠 resume 委托者续，只有 cc 的终点是悬空的。这里补上。
// 取舍：① 不改 cc 的「不回发」语义（子 run 仍不写【交回】、不停等）——汇合由引擎在**子 run 到终态**那刻触发，
//        员工侧零心智负担；② 不做「发起 cc 后禁止收工」的反向门禁——cc 的语义本就是并行，会审型场景发起方
//        天然只能停下等，逼它自转圈才是真浪费；③ 判据只用机器可得的事实（子 run 状态 + 队列残留），不猜语义。
const isTerminalRun = r => !r || (!r.engineHandoverPending && r.status !== 'running' && r.status !== 'starting')
// 队列里还有几条本轮 cc 没变成 run（目标忙在别的任务线时先扣队列，见 cc_colleague）。
// **动态数、不存计数器**：计数器会因投递失败/重启/手动清队列而漂移，一漂就永远汇合不了（宁可多扫几条队列）。
const ccQueuedFor = senderId => Object.values(pendingQueues).reduce((n, q) => n + (q || []).filter(it => it.ccJoinOrigin === senderId).length, 0)

// 登记一条 cc 子 run（三条投递路径共用：新起兄弟 run / 并入目标当前会话 / 队列投递时回绑）。
// 字段刻意不带 `_` 前缀 → 过 stripPrivate 落 index.json，服务重启后汇合关系仍在（重启即失忆会重现本事故）。
function bindCcChild(senderRun, childRun) {
  if (!senderRun || !childRun || senderRun.id === childRun.id) return
  ;(senderRun.ccChildren ||= [])
  if (!senderRun.ccChildren.some(c => c.runId === childRun.id)) senderRun.ccChildren.push({ runId: childRun.id, employee: childRun.employee })
  senderRun.ccJoinFiredAt = null     // 新扇出 → 重新武装（上一轮已汇合过不妨碍这一轮）
  ;(childRun.ccOriginRunIds ||= [])  // 数组而非单值：同一条会话可能被多人 cc（并入其当前回合那条路径）
  if (!childRun.ccOriginRunIds.includes(senderRun.id)) childRun.ccOriginRunIds.push(senderRun.id)
  saveRegistry()
}

// 尝试把发起人唤回收敛。返回 true＝已唤起（调用方据此免掉一次巡视：由发起人自己按子 run 收尾判该不该补，
// 比让小呆呆读收尾原文猜准，也正好治「79 次巡视只 2 次真停」那笔账）。
function tryFireCcJoin(sender) {
  try {
    if (sender?.engineHandoverPending) return false
    if (!sender || !Array.isArray(sender.ccChildren) || !sender.ccChildren.length) return false
    if (sender.ccJoinFiredAt) return false                            // 本轮扇出已汇合过（再 cc 会重新武装）
    if ((sender.ccJoinFires || 0) >= CC_JOIN_MAX_FIRES) return false  // 失控兜底
    if (!isTerminalRun(sender)) return false                          // 发起人还在跑：不用唤，它自己收工时再判（见 autoChain 收尾）
    if (sender.userStoppedAt) return false                            // 老板亲手按停的这条会话：人为中止意图优先，恢复权在他（startRun 里会撤销此标记）
    if (ccQueuedFor(sender.id) > 0) return false                      // 还有 cc 扣在队列里没起会话 → 扇出没到齐
    const kids = sender.ccChildren.map(c => ({ ...c, run: runs[c.runId] }))
    if (kids.some(k => !isTerminalRun(k.run))) return false           // 还有子 run 在跑
    // 发起人自己已经把棒交出去了（【下一棒】/【交回】）→ 这条线在别处活着，再唤它＝同员工/同线并发第二条 run，不唤。
    if (parseNextHop(sender.result) || parseReturnHop(sender.result)) return false
    if (busyRunFor(sender.employee)) return false                     // 该员工正忙别的会话（共用工作树）→ 等它收工，由 sweepCcJoins 捞
    const names = kids.map(k => EMPLOYEES[k.employee]?.displayName || k.employee)
    const tails = kids.map(k => `- **${EMPLOYEES[k.employee]?.displayName || k.employee}**（会话 \`${k.runId}\`，状态 ${k.run ? k.run.status : '已删除'}）：\n${String(k.run?.result || '（无收尾汇报）').trim().slice(-600)}`).join('\n\n')
    const body = `【抄送汇合】你在本会话抄送(cc)出去的 ${kids.length} 位同事（${names.join('、')}）**已全部收工**——引擎按「cc 扇出全部到终态」把你唤回来收口。这不是新派工，是你自己那一棒的续跑。\n\n各自收尾摘要（原文尾部）：\n\n${tails}\n\n请接着做你 cc 当时说过要做的事（汇总 / 收敛 / 冻结 / 继续手上的活），并按规矩写收工标记（继续=\`【下一棒】自己｜下一步\`，交棒=\`【下一棒】<员工名>｜指令\`，回发上游=\`【交回】\`，真要老板拍=\`【等你拍板】\`逐条列清）。\n两点提醒：① 若上一轮你已有待老板拍板的事项而老板还没拍，别替他拍——把这批 cc 结果一并整理进【等你拍板】；② 若看摘要发现某位其实没做完他那份，由你决定补 cc 一次还是升级老板，别默认它已完成。`
    sender.ccJoinFiredAt = new Date().toISOString()
    sender.ccJoinFires = (sender.ccJoinFires || 0) + 1
    sender.patrolClearedSig = null                                    // 它马上要产出新停顿，撤销旧裁决签名（对齐 resume_employee）
    saveRegistry()
    const lastKid = kids[kids.length - 1]
    logConversation({
      threadRootId: sender.threadRootId || sender.id,
      fromKind: 'employee', from: lastKid.employee, to: sender.employee, toRunId: sender.id, kind: 'call',
      text: `【抄送汇合】cc 扇出的 ${kids.length} 人（${names.join('、')}）已全部收工，引擎唤回发起人收敛`, depth: sender.chainDepth || 0,
    })
    emitHandoff({ from: lastKid.employee, to: sender.employee, kind: 'cc-join', fromRunId: lastKid.runId, runId: sender.id }, '抄送扇出已全部收工，唤回发起人收口')
    appendEvent(sender.id, { type: 'lab', text: `🧩 抄送汇合：你 cc 的 ${kids.length} 位（${names.join('、')}）已全部收工，引擎已把你唤回收口。` })
    if (sender.sessionId) {
      // 同会话 resume 保上下文（发起人本来就是带着「等谁做什么」的上下文停下的）；快照注回同巡视续跑口径（G2）。
      const snap = stallGuard.renderResumeSnapshot(sender._snapshots || (sender.lastSnapshot ? [sender.lastSnapshot] : []))
      sendToRun(sender, snap + body, { resume: true, kind: sender.lastKind || 'dispatch' })
    } else {
      // 原会话不可 resume（无 sessionId：早期异常/被清）→ 转新会话，宁可丢上下文也别把结果丢了。
      queuePending(sender.employee, {
        kind: 'cc-join', fromEmployee: sender.employee, text: `cc 扇出全部收工，唤回收敛（原会话 ${sender.id} 无 sessionId，转新会话）`,
        deliver: 'new', instruction: `【抄送汇合·转新会话】原会话 \`${sender.id}\` 已不可续跑（无 sessionId），本条是它的接续。\n\n${body}`,
        taskFile: sender.taskFile, threadRootId: sender.threadRootId || sender.id, chainDepth: sender.chainDepth || 0,
      })
    }
    return true
  } catch (e) { console.warn('[ccJoin] 异常:', e.message); return false }
}

// 一条 cc 子 run 到终态 → 逐个发起人试汇合（一条会话可能被多人 cc）。返回 true＝至少唤回了一个发起人。
function notifyCcOrigins(child) {
  let fired = false
  for (const sid of (child?.ccOriginRunIds || [])) if (tryFireCcJoin(runs[sid])) fired = true
  return fired
}

// 定时兜底：事件版可能因「发起人当时正忙别的会话」而放弃（见 tryFireCcJoin 的 busyRunFor 分支），
// 那条路径没有二次触发点。与空停巡逻同周期扫一遍近 24h 内武装中的汇合点，捞漏。
function sweepCcJoins() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60_000
    for (const r of Object.values(runs)) {
      if (!r.ccChildren?.length || r.ccJoinFiredAt) continue
      if (new Date(r.updatedAt || r.startedAt || 0).getTime() < cutoff) continue
      tryFireCcJoin(r)
    }
  } catch (e) { console.warn('[ccJoin] sweep 异常:', e.message) }
}

async function autoChain(run) {
  try {
    if (run.engineHandoverPending) return
    if (isConsult(run)) return   // 只读咨询窗是旁支：不解析任何标记、不接棒、不派下一棒（提示里也已告知它别写标记）
    // 巡视员收工回执（放在 chainConfig.enabled 判断之前：定时巡逻 sweepIdleStops 独立于自动接棒开关，
    // 即便 chainConfig.enabled=false 也可能派出巡视，故这条裁决落库不能被下面的 return 跳过）。
    // 一条巡视 run 判完它的目标而**没** resume_employee 续跑 = 判了「合法收工」或「升级老板」→ 给目标盖持久裁决签名，
    // patrolCandidate 据此不再反复巡这同一次停顿。
    if (run.status === 'done' && !run.isError && run.employee === 'chaorenq' && run.patrolTarget && !run._patrolDidResume) {
      const tgt = runs[run.patrolTarget]
      if (tgt) { tgt.patrolClearedSig = tgt.updatedAt || String(tgt.startedAt || ''); saveRegistry() }
    }
    // 抄送汇合①：本 run 是别人 cc 出来的子 run 且已到终态 → 若本轮扇出到此全齐，唤回发起人收口。
    // 放在 chainConfig/标记解析之前：汇合是「把悬空的终点接上」，与自动接棒开关、与它自己写没写标记都无关
    // （它就算写了【下一棒】给第三人，发起人也仍然需要知道这份 cc 结果已落地）。
    const ccJoinFired = notifyCcOrigins(run)
    if (!chainConfig.enabled) return
    if (run.status !== 'done' || run.isError) return          // 出错不接棒
    // dispatch 与 chat 都可接棒：真正的扳机是下面「显式【下一棒】标记 + 无门」，聊天里随口回答不带标记 → 天然不接棒（安全默认）。
    // （原先聊天一律不接棒，导致「跟员工聊天时她收尾给的【下一棒】被丢弃」——2026-07-14 放开，靠标记而非 kind 来判。）
    if ((run.chainDepth || 0) >= (chainConfig.maxDepth || 8)) {
      broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'depth', text: `自动接棒已达上限(${chainConfig.maxDepth})，停下等你接管` })
      return
    }
    // 人工预检门已撤（2026-10-22 老板定：有了迷糊视觉初筛，人工预检直接去掉；老板改在 QA 之后做最终验收）。
    // 谁再写「【等你拍板】人工预检」都退回：GG Bond 有界面改动 → 交迷糊视觉初筛；无界面改动 → 直接交迷糊正式 QA；
    // 迷糊初筛通过 → 自己接着做正式 QA。唯一合法的「QA 前交老板」是本版约定的「老板亲测」（迷糊不做 QA），
    // GG Bond 写它时仍要先过初筛（无界面改动写「视觉初筛：不适用（理由）」放行）。退回两次仍不改 → 不再自动催、交老板看。
    {
      const _gate = parsePendingGate(run.result)
      const _retired = (run.employee === 'ggbond' || run.employee === 'mihu') && run.taskFile && prescreen.isRetiredPrecheckGate(_gate)
      const _selfTestSkip = run.employee === 'ggbond' && run.executionMode !== 'guarded_run' && run.taskFile
        && prescreen.isBossSelfTestGate(_gate) && !prescreen.prescreenNotApplicable(run.result)
      if (_retired || _selfTestSkip) {
        const who = EMPLOYEES[run.employee]?.displayName || run.employee
        const why = _retired ? `${who} 写了「【等你拍板】人工预检」，但人工预检门 2026-10-22 已撤` : 'GG Bond 直接交老板亲测，没先交迷糊视觉初筛'
        appendEvent(run.id, { type: 'lab', text: `⛔ ${why}。` })
        if ((run._prescreenBounces || 0) >= 2 || busyRunFor(run.employee)) {
          broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'prescreen-gate', text: `${why}（已退回 ${run._prescreenBounces || 0} 次）——请你决定下一步` })
          return
        }
        run._prescreenBounces = (run._prescreenBounces || 0) + 1
        broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'prescreen-gate', text: `${why}——已退回${run.employee === 'mihu' ? '迷糊接着做正式 QA' : ' GG Bond 改交迷糊'}` })
        const mihuNudge = [
          '【人工预检门已撤·引擎退回】你写了「【等你拍板】人工预检」，但 2026-10-22 老板定：有了你的视觉初筛，人工预检直接去掉。',
          '初筛通过后由你**接着做正式 QA**：把条目置 `待QA`（阶段「视觉初筛通过 → 迷糊：正式 QA」），本会话直接开测；做不完收工写 `【下一棒】迷糊｜【正式QA】<档案路径>…`。',
          'QA 通过后条目置 `待人工验收`，收工写 `【等你拍板】最终验收｜…`。',
          '**例外**：本版档案约定「老板亲测、迷糊不做 QA」→ 条目置 `待人工验收`，收工写 `【等你拍板】老板亲测｜…`。',
        ].join('\n')
        const ggNudge = [
          `【${_retired ? '人工预检门已撤' : '视觉初筛门'}·引擎退回】你写了「【等你拍板】${_retired ? '人工预检' : '老板亲测'}」。`
            + (_retired ? '2026-10-22 老板定：人工预检直接去掉，开发完交迷糊——有界面改动先视觉初筛、无界面改动直接正式 QA，老板在 QA 之后做最终验收。' : '交老板亲测之前必须先过迷糊视觉初筛。'),
          '请把收工标记改成：',
          '- 有界面改动：`【下一棒】迷糊｜【视觉初筛】<任务档案路径> · 本轮改动的页面/状态清单（每项写清从哪个菜单点进去、造什么数据能看到）· 前端/后端提交号`，并用 set_entry_status 把条目阶段写成「已开发 → 待迷糊：视觉初筛」；',
          '- 本轮**没有任何界面改动**：在收工汇报里单独写一行「视觉初筛：不适用（<理由>）」，然后'
            + (_retired ? '条目置 `待QA`，直接 `【下一棒】迷糊｜【正式QA】<交接卡路径>`。' : '保留【等你拍板】老板亲测。'),
        ].join('\n')
        sendToRun(run, run.employee === 'mihu' ? mihuNudge : ggNudge, { resume: true, kind: run.lastKind || 'dispatch' })
        return
      }
    }
    if (parsePendingGate(run.result)) {                       // 门优先：有待拍板事项 → 停（无视是否也写了下一棒/交回）
      // 但「停」不等于「免检」：迷糊带档 QA 收工先把覆盖闸门算出来落档，未达标 → 盖空心停靠签名 + 派巡视（见 markQaHollowStop）
      if (run.employee === 'mihu' && run.taskFile) await markQaHollowStop(run)
      if (run.engineHandoverPending) return
      return
    }
    // ── 迷糊的 QA 裁决必须先过机器硬闸；任何历史审计签名都不能绕过。通过后可异步派菲斯拉影子陪练。 ──
    if (run.employee === 'mihu') {
      const _hop = parseNextHop(run.result)
      const _toBobby = _hop && resolveEmployeeKey(_hop.who) === 'bobby'   // 发测交接 = ship gate（硬拦）
      let _genuineReturn = false                                          // 真交回上游 QA 结果（含老板派的复测，c4ef6eb4 类）
      if (!_hop) {
        const _ret = parseReturnHop(run.result)
        if (_ret) {
          if (_ret.targetRunId) _genuineReturn = true
          else {   // 裸式【交回】：排除「实为派活给某员工」的纠偏分支（那是缺陷回退等，不审），与下方 return 分支同口径
            const _mm = _ret.report.match(/^\s*([^｜|\n]+?)\s*[｜|]\s*([\s\S]+)$/)
            const _misKey = _mm && resolveEmployeeKey(_mm[1].trim())
            const _callerEmp = run.callerRunId && runs[run.callerRunId] ? runs[run.callerRunId].employee : null
            _genuineReturn = !(_misKey && _misKey !== run.employee && _misKey !== _callerEmp)
          }
        }
      }
      if (_toBobby || _genuineReturn) {
        // 无任务档案（chat 线漂入的对齐评审 / 复盘等，非正式派工）且非「发波比(发测出货)」→ QA 覆盖率闸门**不适用**：
        // 没有 facet_doc / 覆盖率可算，绝不能把一次合法交回也当 fail-closed 吞掉（2026-08-19 事故根因见 escalateBlockedHandoff）。
        // 此处放行、落到下方 return-hop 正常回发；也**不**派菲斯拉影子陪练（无档＝非正式 QA 裁决，无从审）。
        // 仅当是「发波比」这种真·出货动作时，即便无档也必须拦（无档无从验证覆盖）——走 else 的 fail-closed 升级路。
        const _gateApplicable = !!run.taskFile || _toBobby
        if (!_gateApplicable) {
          appendEvent(run.id, { type: 'lab', text: 'ℹ️ 本会话无任务档案（非正式派工/chat 线漂入），QA 覆盖率闸门不适用；按交接标记正常回发。' })
        } else {
        // ── 确定性 QA 硬闸：发波比和交回都必须过；任何读取/解析/落档异常一律 fail-closed。 ──
        { // 安全门禁不可由运行配置关闭；要变更策略必须改代码并过测试。
          let cov
          try {
            cov = computeCoverageForRun(run)
            const _abs = safeResolve(run.taskFile)
            await withArchiveLock(_abs, () => { engineSetGate(_abs, 'qa_coverage_complete', cov.coverageComplete); engineSetGate(_abs, 'qa_red_calibrated', cov.redComplete); engineSetGate(_abs, 'qa_passed', cov.passed) })
            if (run.engineHandoverPending) return
          } catch (e) {
            const reason = String(e?.message || e)
            // fail-closed 拦住交接的同时**必须升级老板**（打持久受阻签名 + 推「待接管」），别再只在时间线留行红字后静默 return。
            broadcast({ type: 'handoff-blocked', from: 'mihu', reason: 'coverage-error', text: `QA 门禁计算失败，已 fail-closed：${reason}` })
            appendEvent(run.id, { type: 'lab', text: `⛔ QA 门禁计算失败（fail-closed）：${reason}——已拦下交接并升级老板。` })
            escalateBlockedHandoff(run, `迷糊 QA 门禁计算失败（${reason}）`)
            return
          }
          {
            if (!cov.coverageComplete || !cov.redComplete) {
              run._coverageBounces = (run._coverageBounces || 0) + 1
              const cap = chainConfig.coverageBounceMax || 3
              const summary = `覆盖率未达标（引擎算）：facet 全集 ${cov.denom}，覆盖缺口 ${cov.gaps.length} + RED 缺口 ${cov.redGaps.length}。`
              broadcast({ type: 'handoff-blocked', from: 'mihu', reason: 'coverage-incomplete', text: `覆盖率闸门拦下发测：${summary}（第 ${run._coverageBounces} 次）` })
              appendEvent(run.id, { type: 'lab', text: `⛔ 覆盖率闸门：${summary} 发测被扣住，缺口清单已打回迷糊。` })
              if (run._coverageBounces > cap) {
                appendEvent(run.id, { type: 'lab', text: `覆盖率反复不达标达上限(${cap})，升级老板（别再自动 bounce）。` })
                broadcast({ type: 'handoff-blocked', from: 'mihu', reason: 'coverage-escalate', text: `覆盖率反复不达标(${cap} 次)，需老板介入——facet 缺口迷糊补不上，检查是否 facet 表/环境有问题` })
                return
              }
              if (busyRunFor('mihu')) return   // 迷糊正忙别的会话 → 保持扣住，等它闲下再由下次收工触发
              const gapLines = [
                ...cov.gaps.slice(0, 25).map(g => `  · ${g.facetId}：${g.why}`),
                ...cov.redGaps.slice(0, 25).map(g => `  · ${g.facetId}：${g.why}`),
              ].join('\n')
              const nudge = `【QA 硬闸·引擎打回】你的发测/交回被扣住：\n${summary}\n缺口逐条：\n${gapLines}\n\n只有 \`reconcile_coverage\` 从真实 GREEN run 签发的完整证据才算通过；SOURCE_ATTESTED / BLOCKED_WITH_PROOF / HUMAN_INHERENT 都是风险处置，不是 QA Pass。lintAck 不豁免。补造数、真实被测动作、值/反事实断言、qaTrace 和 RED 校准 run 后再交接。自检用 \`coverage_status\`。`
              sendToRun(run, nudge, { resume: true, kind: run.lastKind || 'dispatch' })
              return
            }
          }
        }
        // 菲斯拉只做 shadow sparring：机器门禁是唯一放行权威；陪练忙时也不能卡住已通过的流水线。
        if (chainConfig.auditEnabled !== false && !run._shadowAuditSpawnedSig && !busyRunFor('feisila')) {
          run._shadowAuditSpawnedSig = run.updatedAt || String(run.startedAt || '')
          spawnAudit(run)
        }
        // 最终验收门（2026-10-22 老板定，取代人工预检）：白天态迷糊 QA 全绿后**不自动接棒波比发测**，
        // 停在老板最终验收（看已测版本 UI/UX + go/no-go，同守航态 RC_READY）。老板验收通过（档案 gate
        // human_precheck_passed=true，看板「人工通过」/验收卡）后由他派波比；已验收过的版本迷糊交波比照常放行。
        if (_toBobby && run.taskFile && run.executionMode !== 'guarded_run') {
          let _accepted = false
          try { _accepted = (parseFrontmatter(fs.readFileSync(safeResolve(run.taskFile), 'utf8')) || {}).gates?.human_precheck_passed === true } catch { }
          if (!_accepted) {
            appendEvent(run.id, { type: 'lab', text: '✅ QA 硬闸全绿。白天态不自动交波比发测——停在老板最终验收（条目应为「待人工验收」）。' })
            try { appendTimelineLine(run.taskFile, '迷糊 QA 全绿，停在老板最终验收（引擎拦下自动发测；验收通过后由老板派波比）') } catch { }
            broadcast({ type: 'handoff-blocked', from: 'mihu', reason: 'final-acceptance', text: 'QA 全绿，等你最终验收：看板勾「待人工验收」条目「人工通过」后，再派波比发测' })
            return
          }
        }
        }   // 闭合「门禁适用」else 分支
      }
    }
    // ── 前进(call)：【下一棒】→ 新建 run 拉起下一棒（记 callerRunId 供其回发） ──
    const hop = parseNextHop(run.result)
    if (hop) {
      const nextKey = resolveEmployeeKey(hop.who)
      if (!nextKey) {
        broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'unresolved', text: `无法解析下一棒「${hop.who}」，请手动接棒` })
        return
      }
      // facet_doc 生命周期硬门禁：把活交给迷糊(QA)前，任务档案必须已有可解析的 facet_doc（覆盖率闸门的 facet 全集权威源）。
      // 缺则 bounce 回发送方（带可执行提示：cc 菲菲 建/回写 facet_doc），不 spawn 迷糊、不自动置「待测」。
      // 只挡「别人交给迷糊」（nextKey==='mihu' 且非迷糊自续）；迷糊自续 + 迷糊→波比发版门禁另有其道（后者见 computeCoverageForRun）。
      // 守航态(guarded_run)不硬挡——它有 park-don't-guess 纪律、无人值守硬挡=夜里被卡死；软信号（写后自检/漂移巡检）仍覆盖它。
      if (nextKey === 'mihu' && run.employee !== 'mihu' && run.executionMode !== 'guarded_run' && run.taskFile) {
        let gate
        try { gate = validateArchiveFile(safeResolve(run.taskFile)) } catch (e) { gate = { errors: [`facet 门禁读档失败：${String(e?.message || e)}`], warnings: [] } }
        if (gate.errors.length) {
          const msg = `facet 门禁拦下交棒迷糊（QA）——补齐后再交：\n- ${gate.errors.join('\n- ')}`
          appendEvent(run.id, { type: 'lab', text: `⛔ ${msg}` })
          broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'facet-gate', text: msg })
          logConversation({ threadRootId: run.threadRootId || run.id, fromKind: 'employee', from: run.employee, to: 'mihu', kind: 'blocked', text: msg.slice(0, 300), depth: run.chainDepth || 0 })
          return
        }
      }
      // 需求溯源硬门禁 · 交棒开发（2026-09-08 大货备货事故对策，复盘 §3.122）：菲菲把活交给 GG Bond 前，
      // facet 表必须已对着源材料逐单元扫过（清点单 + 映射表，缺口/待老板拍清零）。
      // 为什么挡这一棒：那次是「38 条 facet 对 308 个原型单元」直接进了开发，之后三方会审背书、覆盖矩阵
      // 38/38 全绿、RC_READY——**下游每一道闸都只围着缩水的 facet 表转**，越测越确信。需求梳理是迭代第一步，
      // 错在第一步，后面全是白工（那次返工把整版推翻重做）。
      // 处置不是让 run 死掉等人：优先**当场回灌**让她自己补（同 signoffRejectIfNeeded 的 E5 哲学——判据挪到
      // 收工那一刻），回灌上限 2 次防死循环；回灌不了（query 已关/已达上限）才落成 handoff-blocked 等人接管。
      if (nextKey === 'ggbond' && run.employee === 'feifei' && run.taskFile) {
        let t, g, q
        try { const _abs = safeResolve(run.taskFile); const _d = readReqSideDocs(_abs); t = validateTraceFile(_abs, _d); g = validateFeatureTreeFile(_abs, _d); q = validateReqQualityFile(_abs, _d) }
        catch (e) { t = { active: true, errors: [`需求侧闸门读档失败：${String(e?.message || e)}`], warnings: [] }; g = { active: false, errors: [] }; q = { active: false, errors: [] } }
        const gateErrs = [
          ...(t.active && t.errors.length ? [`【溯源闸·横向：材料→需求】\n- ${t.errors.join('\n- ')}`] : []),
          ...(g.active && g.errors.length ? [`【功能树闸·纵向：需求→叶子】\n- ${g.errors.join('\n- ')}`] : []),
          ...(q.active && q.errors.length ? [`【需求分析闸·拷问问出去/工作流走得通/自我批判逐条回应】\n- ${q.errors.join('\n- ')}`] : []),
        ]
        if (gateErrs.length) {
          const msg = `需求侧门禁拦下交棒 GG Bond（开工）——需求梳理还没做全：\n\n${gateErrs.join('\n\n')}`
          appendEvent(run.id, { type: 'lab', text: `⛔ ${msg}` })
          const canNudge = run._input && (run._traceRejects || 0) < 2
          if (canNudge) {
            run._traceRejects = (run._traceRejects || 0) + 1
            run.traceRejects = run._traceRejects     // 落库：看板能看见「溯源闸拦过几次」
            pushTurn(run, `【引擎拦下本轮交棒 · 需求侧门禁】你要把活交给 GG Bond，但需求梳理还没做全——**别重头做**，接着上次进度把下面这些补掉再交：\n\n${gateErrs.join('\n\n')}\n\n补的顺序（照这个走，别跳）：\n① 对每份源材料跑 \`scan_source_material\`，把机器数出来的 units 抄进 frontmatter.source_materials（**别手估**；扫描器说"标注稀疏/数不出来"的，人工逐屏枚举后手填并写 by=）；\n② 建/补《源材料溯源映射表》(trace_doc)：源材料每个单元一行，处置三选一——立需求(填真实 facet ID) / 本版不做(写理由) / 待老板拍；\n③ 建/补《功能树与叶子四要素》(feature_tree_doc)：逐层拆到叶子，每个叶子挂真实 facet + 目标用户/使用场景（可继承）；**交互类叶子的空态/失败态/无权限逐个交代**（facet 或 \`N/A:理由\`）；每个节点回指源单元，**材料里没写、你按行业经验补的写 \`补充:<理由>\`**——这一列是溯源闸够不到的那一半（材料本身写得浅）；\n④ 映射/拆出来的新需求点该立 facet 的立进 facet_doc，然后 \`seed_coverage\` 播进覆盖矩阵（漏播=对 QA 闸门不可见）；\n⑤ 建/补《功能树》文档里的另两张表：**用户工作流**（每个角色一条主流程、每步落到功能树的某个节点上——落不上说明用户走不通）和**自我批判回应**（跑 \`validate_req_analysis\` 拿机器点名的可疑点清单，**逐条**给归宿：\`已补:\` / \`不是问题:\` / \`已问老板:\`，一条都不许留空）；\n⑥ 跑 \`scan_open_items\` 把源材料里 PRD 自标的 ⏳ 全抽出来，建/补《源材料开放项台账》(open_items_doc)：一条一行，终态三选一——\`已决\`(写口径+出处) / \`待拍\`(写它在哪份拍板清单第几条) / \`不做\`(写理由)。**一条都不许缺行**：开放项最爱在两轮梳理之间静默蒸发（09-08 返工清单里写过的"唯一键要不要加轮次维"，09-09 拍板清单里就没了）；\n⑦ 跑 \`validate_req_substance\` 清实质闸：①facet 扇入超限的拆开（一条 facet 吃十几个源单元＝太粗、迷糊只能挑一个测）②③硬项清零，④那两张点名清单（PRD 数值阈值没落进 facet / 区块没有专属 facet）**逐条给说法**——「已落在 Fx」「现网既有非本版」「PRD 里只是举例」都算说法，但不许跳过。\n⑧ 跑 \`validate_req_trace\` + \`validate_feature_tree\` + \`validate_req_analysis\` + \`validate_req_substance\` 确认四边都清零（功能树那个顺带把树状图画给你看，**别手画**）；确实需要老板拍的，写成拍板题【等你拍板】停下问，**别自己替他拍、也别先交棒**。\n补完再写【下一棒】GG Bond。这四道闸拦的不是你的效率，是"缩水的需求表进开发"——第一次是 38 条 facet 对 308 个原型单元整版返工；第二次补到 100 条 facet / 357 行映射 / 三闸全绿，老板一读原型还是当场点出「详情抽屉的功能梳理完全没有」（15 个单元 0 条专属 facet，全靠 F75 那个桶兜）。实质闸就是为第二次那种"账面全绿、实质缩水"加的。\n\n${TRACE_HINT}\n\n${TREE_HINT}\n\n${SUBSTANCE_HINT}`, 'dispatch')
            saveRegistry()   // 同 signoffRejectIfNeeded：不落库则重启即失忆、上限被绕过
            broadcast({ type: 'run-status', runId: run.id, employee: run.employee, status: 'running' })
            return
          }
          broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'req-side-gate', text: msg })
          logConversation({ threadRootId: run.threadRootId || run.id, fromKind: 'employee', from: run.employee, to: 'ggbond', kind: 'blocked', text: msg.slice(0, 300), depth: run.chainDepth || 0 })
          return
        }
      }
      autoAdvanceEntry(run, nextKey).catch(() => { })         // A：带 entryNo 且交 QA → 自动把该条目置「待测」
      nudgeBoardConsistency(run, nextKey)                     // A：交 QA 却无条目待测 → 软提醒补 set_entry_status
      if (nextKey === run.employee) {                         // 自续：员工【下一棒】自己 = 继续干下一块
        // 以前一律「自环→终止」，导致派工里「全速建到预检门」这类**自续被掐死**——员工写了完好的
        // 【下一棒】自己｜<续做指令>，引擎却当死循环丢弃 → run 静默停住（run 20260729171004 GG Bond
        // 通宵没干完的根因）。改为：新起一轮同员工 run（全新上下文，按其自我交接指令续做），用独立
        // 「自续预算」selfChainMax 防失控——**不占 maxDepth**（那是 call 嵌套天花板，与自续无关）；
        // 空收工熔断(_emptyStreak)仍兜底空转轮；callerRunId 继承**原委托者**（非上一自续轮，保证最终
        // 【交回】回到真上游），threadRootId 保持同链（看板归组）。正常应先撞到真门/预检门自然停。
        const sc = (run.selfChainDepth || 0) + 1
        const cap = chainConfig.selfChainMax || 40
        if (sc > cap) {
          broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'self-chain-cap', text: `自续已达上限(${cap} 轮)，停下等你接管——避免无限自续` })
          logConversation({ threadRootId: run.threadRootId || run.id, fromKind: 'employee', from: run.employee, to: run.employee, kind: 'blocked', text: `自续达上限(${cap})，停下等接管`, depth: run.chainDepth || 0 })
          return
        }
        const busy = busyRunFor(nextKey, laneKeyOf(run))
        if (busy) {
          broadcast({ type: 'handoff-blocked', from: run.employee, reason: 'target-busy', text: `${EMPLOYEES[nextKey]?.displayName || nextKey} 正在跑另一条会话（${busy.id}），自续已停下——等它收工后手动接棒` })
          return
        }
        const next = createDispatchRun({ employee: nextKey, taskFile: run.taskFile, instruction: hop.instruction, kind: 'dispatch', chainDepth: run.chainDepth || 0, callerRunId: run.callerRunId || null, threadRootId: run.threadRootId || run.id, selfContinue: true, engine: engineForRun(run), model: run.model })
        next.selfChainDepth = sc
        emitHandoff({ from: run.employee, to: nextKey, fromRunId: run.id, runId: next.id, selfContinue: true }, hop.instruction)
        return
      }
      // 并发闸：下一棒员工已在跑另一条会话（共用工作树，不能并发第二条）→ 扣进它的待处理队列，
      // 等它收工空出来自动接棒（不再 handoff-blocked 让人手动接，也不打断它当前的活）。
      const busy = busyRunFor(nextKey, laneKeyOf(run))   // 按工作区判：下一棒在别的工作区忙不挡本工作区接棒
      if (busy) {
        const nm = EMPLOYEES[nextKey]?.displayName || nextKey
        const instr = hop.instruction || '接棒上一环节工作，请按你的 SOP 推进，完成后回写任务档案。'
        // 下一棒正在**同一任务、同一工作区**上跑（最常见：迷糊在测，GG Bond 修完 BUG 交「可以复验了」）→ 并进她当前会话，
        // 不另起一条排队。2026-09-29 实况：Temu 那条迷糊会话在跑，GG Bond 连交 4 次「BUG-00x 修好了 / 接着做」全进了队列，
        // 等她收工还要一条条另起新会话、各自从头读档案。与 cc_colleague「同一任务线 → 并入其当前会话」同一口径。
        if (busy.taskFile && busy.taskFile === run.taskFile && liveRuns.has(busy.id) && busy._q && busy._input) {
          const fromName = EMPLOYEES[run.employee]?.displayName || run.employee
          const prompt = `【下一棒 · 并入你当前会话】来自 ${fromName}（会话 \`${run.id}\`）：同一任务的新进展，接在你手上的活里一起处理，别另起炉灶。\n\n${instr}\n\n（这部分做完、要把结果回给 ${fromName}，用 \`【交回】@${run.id}｜<报告>\`；你原本这一棒的交接照旧。）`
          enqueueTurn(busy, prompt, 'dispatch')
          logConversation({ threadRootId: run.threadRootId || run.id, fromKind: 'employee', from: run.employee, to: nextKey, toRunId: busy.id, kind: 'call', text: `并入${nm}当前会话：${String(instr).slice(0, 240)}`, depth: run.chainDepth || 0 })
          emitHandoff({ from: run.employee, to: nextKey, fromRunId: run.id, runId: busy.id, queued: true, merged: true }, instr)
          return
        }
        queuePending(nextKey, { kind: 'forward', fromEmployee: run.employee, text: String(instr).slice(0, 300), deliver: 'new', instruction: instr, taskFile: run.taskFile, threadRootId: run.threadRootId || run.id, chainDepth: (run.chainDepth || 0) + 1, callerRunId: run.id, lane: run.lane })
        emitHandoff({ from: run.employee, to: nextKey, fromRunId: run.id, runId: null, queued: true }, instr)
        logConversation({
          threadRootId: run.threadRootId || run.id,
          fromKind: 'employee', from: run.employee, to: nextKey, kind: 'blocked',
          text: `接棒排队(target-busy)：${nm} 忙于另一条会话 ${busy.id}，已入待处理队列，收工后自动接棒；指令：${instr}`.slice(0, 300), depth: run.chainDepth || 0,
        })
        return
      }
      spawnForward(run, nextKey, hop.instruction)
      return
    }
    // ── 回发(return)：【交回】→ resume 目标会话（委托者或指定 runId），不新建 run ──
    const ret = parseReturnHop(run.result)
    if (ret) {
      // 纠偏：裸式【交回】<员工名>｜<报告> 实为"把活派给某人"(forward)，不是回发委托者。
      // parseReturnHop 裸式分支不解析员工名（见其注释），会把 "迷糊老师｜…" 整段吞进 report
      // 并默认回 callerRunId——中枢型员工(callerRunId=null)因此撞 return-no-caller、活派不出去。
      // 若 report 以「可解析员工名 + ｜」开头、且该员工不是本 run 真正的委托者，按【下一棒】call 路由。
      if (!ret.targetRunId) {
        const mm = ret.report.match(/^\s*([^｜|\n]+?)\s*[｜|]\s*([\s\S]+)$/)
        const misKey = mm && resolveEmployeeKey(mm[1].trim())
        const callerEmp = run.callerRunId && runs[run.callerRunId] ? runs[run.callerRunId].employee : null
        if (misKey && misKey !== run.employee && misKey !== callerEmp) {
          console.warn(`[autoChain] 裸式【交回】${mm[1].trim()} 识别为派活，纠偏为【下一棒】→ ${misKey}（run ${run.id}）`)
          spawnForward(run, misKey, mm[2].trim())
          return
        }
      }
      const targetId = ret.targetRunId || run.callerRunId
      const target = targetId ? runs[targetId] : null
      // 目标在跑但会话仍活 → 走「无感排队」coalesce 进它下一轮（对齐用户 /reply 的无感追加），不再当 return-busy 阻断。
      // 缘起：委托者 A 忙时，下游 B 的【交回】原会硬阻断(return-busy)、报告悬在 B 汇报里不进 A、且无自动重投——
      //   与「用户→忙碌会话」早有 enqueueTurn 排队形成不对称。这里补齐：A 活着就排队、由 SDK 择时喂给它。
      const targetLive = !!(target && liveRuns.has(target.id) && target._q && target._input)
      const reason =
        !targetId ? 'return-no-caller' :
        !target ? 'return-unknown' :
        target.id === run.id ? 'return-self' :
        (target.status === 'running' && !targetLive) ? 'return-busy' :   // running 但 query 已不活(异常态)才阻断
        (target.status !== 'running' && !target.sessionId) ? 'return-nosession' : null
      if (reason) {
        broadcast({ type: 'handoff-blocked', from: run.employee, reason, text: `无法回发到会话「${targetId || '(无委托者)'}」(${reason})，请手动接管` })
        logConversation({
          threadRootId: run.threadRootId || run.id,
          fromKind: 'employee', from: run.employee, to: target?.employee || '(?)', toRunId: targetId || null,
          kind: 'blocked', text: `回发受阻(${reason}): ${ret.report}`, depth: run.chainDepth || 0,
        })
        escalateBlockedHandoff(run, `交回受阻(${reason})，委托会话「${targetId || '(无委托者)'}」不可达`)   // 别让 stranded 交回静默死停：升级 + 令巡视可捞
        return
      }
      const fromName = EMPLOYEES[run.employee]?.displayName || run.employee
      // 回发不计深度：委托者被 resume 回其原会话，chainDepth 保持不变——只有【下一棒】派活(spawnForward)才 +1。
      // 这样中枢型员工反复「派活→收回→再派活」不会虚增深度、过早撞 maxDepth；深度只衡量真正的 call 嵌套。
      // 乒乓/失控兜底仍在：自环守卫(nextKey===employee)、回发 self/busy/unknown 守卫，以及 call 嵌套的 maxDepth 天花板。
      const prompt = `【派工】${dispatchPreamble(target.employee, target.taskFile)}【交回】来自 ${fromName}：\n\n${ret.report}\n\n（这是下游「${fromName}」把结果交回给你，${fromName} 是你的下游、不是你的委托者。若你据此还要派活给任何人——包括再找「${fromName}」——一律用 \`【下一棒】<员工名>｜<指令>\`；\`【交回】\` 只用于把结果回发给委托你的上游会话。）`
      logConversation({                                       // 会话看板：记一条回发消息
        threadRootId: target.threadRootId || target.id,
        fromKind: 'employee', from: run.employee, to: target.employee, toRunId: target.id,
        kind: 'return', text: ret.report, depth: target.chainDepth,
      })
      // 员工级忙碌判定：委托者会话正跑 → 无感排队并入（同一条线的回收，本就是它在等的结果）；
      // 员工忙在**别的**会话 → 扣进待处理队列（若这里 resume 会起第二条并发 query 撞工作树）；空闲 → resume 冷起。
      const busy = busyRunFor(target.employee, laneKeyOf(target))
      let queued = false
      if (busy && busy.id === target.id) { enqueueTurn(target, prompt, 'dispatch'); queued = true }   // 正跑的就是委托者会话 → 排入其下一轮
      else if (busy) {                                                                                 // 忙在另一条线 → 收工后再 resume 回发
        queuePending(target.employee, { kind: 'return', fromEmployee: run.employee, text: String(ret.report).slice(0, 300), deliver: 'resume', resumeRunId: target.id, prompt, threadRootId: target.threadRootId || target.id })
        queued = true
      }
      else sendToRun(target, prompt, { resume: true, kind: 'dispatch' })                              // 空闲：目标 query 仍活则热推,否则 resume 冷起
      emitHandoff({ from: run.employee, to: target.employee, kind: 'return', fromRunId: run.id, runId: target.id, queued }, ret.report)
      if (pushConfig.enabled && pushConfig.on?.done && pushConfig.scope !== 'dispatch') {
        const toName = EMPLOYEES[target.employee]?.displayName || target.employee
        pushBody(ret.report, { title: `${fromName}回发${toName}`, max: 240 })   // fire-and-forget（内含 LLM 精炼+回落）
          .then(body => sendBark({ title: `↩️ ${fromName} → ${toName} 回发`, subtitle: taskShortName(target.taskFile) || undefined, body: body || '（回发结果）', icon: empIconUrl(target.employee) }))
      }
      return
    }
    // 抄送汇合②：它自己是 cc 发起人、且 cc 出去的人已全部收工 → 直接唤它收口。
    // 这正是 2026-09-01 死停的那个洞：发起人先停（等同事）、同事后收工，事件①当时唤不动它（那会儿它还在跑/或子 run 未齐），
    // 于是唯一的补救时机就是它自己停下来这一刻。比派巡视猜「它该不该停」精确得多——事实是「它等的人都回来了」。
    if (tryFireCcJoin(run)) return
    // 抄送汇合③：它是 cc 子 run、且发起人已被唤回收口 → 这次停顿已有归口人（发起人会拿它的收尾摘要判该不该补），
    // 不必再派巡视去猜（cc 子 run 按语义本就「做完你这份即可、无需回发」，历史上每条都要小呆呆判一次「合法收工」＝纯浪费）。
    if (ccJoinFired) {
      run.patrolClearedSig = run.updatedAt || String(run.startedAt || '')
      saveRegistry()
      appendEvent(run.id, { type: 'lab', text: '🧩 本轮是抄送(cc)子会话，发起人已被引擎唤回收口——由它归口判定，不派巡视。' })
      return
    }
    // 既无【下一棒】也无【交回】=候选空停：不再一律静默终止，事件版交巡视员判「该不该停」
    // （定时兜底见 sweepIdleStops）。空收工(error 态)已在 2416 被挡、自续走上面 hop 分支——都到不了这。
    if (chainConfig.patrolEnabled !== false && patrolEligible(run)) {
      if (run.taskFile) spawnPatrol(run, { escalateOnly: _patrolEscalateOnly(run), source: 'event' })   // 派工流水线任务：即时巡查（无人盯的自愈，别加延迟）
      else scheduleGracePatrol(run)   // 聊天会话空停：走宽限窗（老板可回话/点取消撤销），复盘 §3.39/§3.42
      return
    }
    // 无任务 / 聊天 / 巡视员自己 / 巡查关闭：既无【下一棒】也无【交回】=终止（安全默认，绝不猜着 spawn）
  } catch (e) { console.warn('[autoChain] 异常:', e.message) }
}

// ---------- 会话标题（对齐 Claude Code 的自动命名）----------
// 会话列表此前只能拿 instruction 前 N 字当名字——派工指令开头常是「【需求条目 #12】…」这类同构前缀，一列看下去分不清谁是谁。
// 建会话时旁路起一个一次性短 query 给它起名，落 run.title（非 `_` 前缀→随 index.json 持久化、随 /api/runs 下发），
// 广播 run-title 让各端就地换名。失败/超时静默——前端缺 title 时照旧退回 instruction 摘要，不阻断任何调度。
// 标题沿用该会话的基座/模型，关闭 Claude 思考；不影响主会话。
// 手动改名走 POST /api/runs/:id/title（titleManual=true 后不再被自动命名覆盖；传空串 = 重新自动生成）。
// 测试实例带 OFFICE_LAB_AUTO_TITLE=0（同 AUTOCHAIN/PATROL 的隔离纪律：别让测试打真模型）。
const AUTO_TITLE = process.env.OFFICE_LAB_AUTO_TITLE !== '0'
const TITLE_MAX = 40
function cleanTitle(s) {
  return String(s || '').split('\n').map(l => l.trim()).find(Boolean)?.replace(/^["'“”「『#*\s]+|["'“”」』*\s。.]+$/g, '').slice(0, TITLE_MAX) || ''
}
async function generateRunTitle(run, { force = false } = {}) {
  if (!AUTO_TITLE || !run || run._titling) return
  if (run.title && !force) return
  if (run.titleManual && !force) return
  const src = String(run.instruction || '').trim()
  if (!src) return
  run._titling = true
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 60_000)
  let text = ''
  try {
    const prompt = `给下面这段对话的开场消息起一个会话标题：中文为主、不超过 16 个字、概括要做的事，不加引号/标点/前缀，只输出标题本身。\n\n<message>\n${src.slice(0, 2000)}\n</message>`
    for await (const msg of query({ prompt, options: {
      engine: engineForRun(run), model: resolveModel(run), maxTurns: 1, tools: [], settingSources: [], abortController: abort,
      systemPrompt: '你是会话命名器，只输出一个简短标题。', thinking: { type: 'disabled' },
      cwd: WORKSPACE_ROOT, env: { ...process.env, OFFICE_LAB_EMPLOYEE: 'title', OFFICE_LAB_RUN: run.id },
    } })) {
      if (msg.type === 'result') { if (!msg.is_error && typeof msg.result === 'string') text = msg.result; break }
    }
  } catch (e) { console.warn('[title] 生成失败', run.id, e?.message || e) }
  finally { clearTimeout(timer); run._titling = false }
  const title = cleanTitle(text)
  if (!title || !runs[run.id] || (run.titleManual && !force)) return
  run.title = title
  run.titleManual = undefined
  saveRegistry()
  broadcast({ type: 'run-title', runId: run.id, title })
}

// 建一条派工 run 并拉起员工——/api/dispatch 与 autoChain 共用，保证自动 run 与人工 run 完全一致
function createDispatchRun({ employee, taskFile, instruction, model, engine, kind, chainDepth, callerRunId, threadRootId, ccFrom, selfContinue, patrolTarget, patrolReason, auditTarget, executionMode, guardContract, consult, lane, engineOrigin } = {}) {
  const msgKind = consult ? 'consult' : (kind === 'chat' ? 'chat' : 'dispatch')
  const id = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex')
  const caller = callerRunId ? runs[callerRunId] : null
  const laneOut = {}   // laneForNewRun 发现来源环境已收掉时写 stale，开工即告警（见下）
  const run = {
    id, employee, taskFile: taskFile || null, model: model || null,
    engine: newRunEngine({ engine, employee, caller: caller || runs[patrolTarget] || runs[auditTarget] || runs[threadRootId] }),
    instruction: String(instruction || '').trim(), status: 'starting', sessionId: null,
    chainDepth: chainDepth || 0, callerRunId: callerRunId || null,   // 谁派起我这条 run（供收工后【交回】回发）
    patrolTarget: patrolTarget || undefined,                          // 仅巡视 run 有：它负责裁决哪条目标 run 的空停（供 autoChain 收尾盖「已裁决」签名）
    patrolReason: patrolReason || undefined,                          // 仅巡视 run 有：本次派它来的四类模糊态之一（qa_hollow / release_incomplete / handoff_stuck / wait_no_handle）。G1 落地后引擎已在收工那刻拒收「缺标记」，所以这里必是模糊态；记下来才能统计「巡视到底在处理什么」，验证 79 次里只 2 次真停那笔账有没有被真正改掉
    auditTarget: auditTarget || undefined,                            // 仅影子陪练 run 有：绑定被检查的迷糊 QA run
    executionMode: executionMode || caller?.executionMode || 'co_drive',  // 全时双态：co_drive(共驾)|guarded_run(守航)。默认共驾=现状不变；守航态经 /api/dispatch 显式传入，并**沿交接链从 caller 继承**——菲菲以守航态开工后，autoChain 派 GG Bond→迷糊→波比 整链自动守航（对齐 templates/守航任务契约.md 的 mode 字段）
    guardContract: guardContract || caller?.guardContract || undefined,   // 本轮守航契约路径，沿交接链继承 —— 三红灯台账按契约 run_name 聚合（一轮守航是整条链，不是某一条会话；不继承就只能看到最后一棒那点局部）
    threadRootId: caller?.threadRootId || threadRootId || id,        // 同一条交接链/抄送扇出共享 root，供看板分组
    consult: consult ? true : undefined,                              // 只读咨询窗（非 `_` 前缀→过 stripPrivate 落 index.json，重启后前端仍认得）
    lane: laneForNewRun({ lane, caller, taskFile }, laneOut),         // 所属工作区：显式 > 委托者继承 > 任务档案绑定；无 = 主检出（字段缺省，现状不变）。驱动【运行环境】注入与按工作区的并发闸
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  runs[id] = run
  if (laneOut.stale) {
    run._laneStale = laneOut.stale   // 【运行环境】块据此提醒员工本人（laneBlockFor）
    appendEvent(id, { type: 'lab', text: `⚠ 来源会话的运行环境 \`${laneOut.stale}\` 已经收掉了，本会话改按${run.lane ? `档案绑定的环境 \`${run.lane}\`` : '**主检出**'}跑（并发闸也按它算）。若这条线其实属于另一个环境，让员工用 bind_task_file 改挂到那个环境绑定的档案，或在会话里回话时重选档案。` })
  }
  // A 状态自动化：由「条目接棒」派起的 run，指令里带「需求条目 #N」——记 run.entryNo（持久、非 _ 前缀），
  // 供收工时按交接目标把这一条目自动跟手（见 autoAdvanceEntry）。多条目/版本级派工无此标记 → 不自动、走一致性提醒。
  { const em = String(run.instruction || '').match(/需求条目\s*#\s*([A-Za-z0-9-]+)/); if (em) run.entryNo = em[1] }
  // 若由别的员工委托（autoChain 前进而来），在派工消息末尾提示：完成后用【交回】回发委托者会话
  const callerHint = (caller && !selfContinue)   // 自续轮不加此提示：它会劝员工「用【交回】、勿用【下一棒】」，与自续「【下一棒】自己」直接冲突
    ? `\n\n（本次由 ${EMPLOYEES[caller.employee]?.displayName || caller.employee} 的会话 \`${callerRunId}\` 委托。完成后请在收工汇报用 \`【交回】<给委托者的结果报告>\` 把结果回发其会话，勿用【下一棒】新开无上下文的 run。）`
    : ''
  const guardedBlock = run.executionMode === 'guarded_run' ? guardedRunPreamble() : ''   // 守航态注入行为约束；共驾态为空串=现状不变
  // engineOrigin：目标循环续跑 / 验收卡动作派的 run——指令是引擎写的，不是老板敲的原话（审查发现 #8）
  const fromBoss = !caller && !ccFrom && !patrolTarget && !auditTarget && !selfContinue && !engineOrigin
  const prompt = msgKind === 'dispatch'
    ? `【派工】${dispatchPreamble(employee, taskFile, { fromBoss })}${guardedBlock}${run.instruction}${callerHint}`
    : run.instruction
  // 会话看板：记一条「进入本 run」的消息（员工委托=call，用户发起=dispatch/chat）。
  // 只读咨询窗不记：会话看板是「正式协作流水」的投影（谁派谁、谁交回谁），旁支咨询灌进去只会淹没交接线；
  // 想回看它走 /api/runs（卡片的会话切换器带「只读」标）。
  if (!consult) logConversation({
    threadRootId: run.threadRootId,
    fromKind: caller ? 'employee' : (ccFrom ? 'employee' : 'user'),
    from: caller ? caller.employee : (ccFrom || '(user)'),
    to: employee, toRunId: id,
    kind: caller ? 'call' : (ccFrom ? 'cc' : msgKind),
    text: run.instruction, depth: run.chainDepth,
  })
  // 守航态：**在开工这一刻**把「本轮受哪份契约管」广播出来（2026-09-20 实账，见 guardContractFor 的长注释）。
  // 此前这件事完全不可见：老板勾了守航态派工，引擎静默认领一份两天前的契约，他在**收工汇报**里才第一次
  // 知道自己那句「推进需求落地」被一份过期授权清单架空了。治权必须开工即可见——没有契约也要说出来。
  if (run.executionMode === 'guarded_run') {
    const c = guardContractFor(run)
    if (c) {
      const named = c.contract?.selection?.named_items || []
      appendEvent(run.id, { type: 'lab', text: `🛡 本轮受守航契约 \`${c.runName}\` 约束：截止 ${c.contract?.deadline || '—'}${named.length ? ` · 授权条目 ${named.join('、')}` : ' · 未点名（按就绪池/triage 口径）'}。**只有这些条目在授权内**——要做别的，走看板「🌙 守航开工／守航续跑」重签契约。` })
    } else if (run._guardNoContract?.otherArchive) {
      const g = run._guardNoContract
      appendEvent(run.id, { type: 'lab', text: `⚠ **本轮没有有效的守航契约**：最新的一份 \`${g.runName}\` 管的是另一份档案（\`${g.otherArchive}\`），引擎不拿它给这份档案当授权。本轮按守航行为边界跑，但**没有目标循环、没有验收卡**——要全权推进这份档案，请在档案上点「守航推进」（或在派工弹窗勾守航态，会当场签一份只管这份档案的契约）。` })
    } else if (run._guardNoContract) {
      const g = run._guardNoContract
      appendEvent(run.id, { type: 'lab', text: `⚠ **本轮没有有效的守航契约**：tasks/ 下最新的一份 \`${g.runName}\` 已于 ${g.deadline} 过期，引擎**不再拿它当授权**（它只授权 ${g.named.join('、') || '（未点名）'}，且本轮消耗不该再记进那一轮的台账）。\n本轮仍按守航行为边界跑（三种不确定分开处理 / 不发测 / 不发布生产），但**没有条目授权清单、不记三红灯**。要让它有治权，走看板「🌙 守航开工」签一份新契约（点名本轮要做的条目），或「守航续跑」承接上一轮未完成项。` })
    }
  }
  // 老板亲自派的这一条才带 userText（气泡显示他敲的原话）；同事间的下一棒/抄送/巡视/影子审计不带——
  // 那些消息的「来自谁、什么类型」本身就是信息，仍按折叠卡显示（2026-09-21 老板定的口径）。
  startRun(run, prompt, { kind: msgKind, userText: fromBoss ? run.instruction : '' })
  generateRunTitle(run)   // 旁路起名，不 await：不拖慢派工
  return run
}

// ---------- 会议室（复盘 / 自省 / 互评）：独立于流水线的轻量编排器 ----------
// 设计取舍见复盘：刻意**不复用** run 生命周期骨架（createDispatchRun→startRun→…→autoChain）。
// 原因：① 会议没有【下一棒】/【交回】/【等你拍板】语义，绝不能让 autoChain 去解析发言里的标记接棒；
//       ② 会议不该被 watchdog/巡视(chaorenq)/审计(feisila) 盯上；③ 会议天然串行（一次一人发言）。
// 因此每次发言 = 一次性 SDK query（喂当前纪要 + 该员工人格，读到 result 取文本即结束），**不进 runs/liveRuns**。
const MEETINGS_DIR = path.join(RUNS_DIR, 'meetings')
try { fs.mkdirSync(MEETINGS_DIR, { recursive: true }) } catch { }
const MEETINGS_FILE = path.join(MEETINGS_DIR, 'index.json')
let meetings = {}
try { meetings = JSON.parse(fs.readFileSync(MEETINGS_FILE, 'utf8')) } catch { meetings = {} }
for (const m of Object.values(meetings)) if (m.status === 'running') { m.status = 'interrupted'; m.speaking = null }
const saveMeetings = () => { try { fs.writeFileSync(MEETINGS_FILE, JSON.stringify(meetings, null, 2)) } catch { } }
saveMeetings()
let meetingActive = false   // 一次只跑一场会议（成本闸 + 串行性）：POST /api/meetings 命中活跃会议返回 409
const MEETING_MAX_ROUNDS = 5
const empName = k => EMPLOYEES[k]?.displayName || k
// 会议唯一编号：单调递增计数器（持久化，删会议也不回收号，保证编号稳定标识一场会议）
const MEETINGS_SEQ_FILE = path.join(MEETINGS_DIR, 'seq.json')
let meetingSeq = 0
try { meetingSeq = Number(JSON.parse(fs.readFileSync(MEETINGS_SEQ_FILE, 'utf8')).n) || 0 } catch { }
for (const m of Object.values(meetings)) if (Number(m.seq) > meetingSeq) meetingSeq = Number(m.seq)   // 兼容加此特性前已存在的会议
function nextMeetingSeq() { meetingSeq += 1; try { fs.writeFileSync(MEETINGS_SEQ_FILE, JSON.stringify({ n: meetingSeq })) } catch { }; return meetingSeq }
const meetingCode = seq => 'No.' + String(seq || 0).padStart(3, '0')   // 展示用编号，如 No.003
const MEETING_MINUTES_DIR = path.join(OFFICE_ROOT, 'docs', '复盘会议纪要')

// 每会议一条事件流 jsonl（发言/开场/收尾），仿 appendEvent：写盘 + 带 SSE id 行号（供重连 Last-Event-ID 断点续传）。
const meetingSseClients = new Map()   // meetingId -> Set<res>
function appendMeetingEvent(id, obj) {
  const file = path.join(MEETINGS_DIR, `${id}.jsonl`)
  const line = JSON.stringify({ ...obj, _ts: new Date().toISOString() })
  const seq = nextSeq(id, file)
  try { fs.appendFileSync(file, line + '\n') } catch { }
  const clients = meetingSseClients.get(id)
  if (clients) for (const res of clients) { try { res.write(`id: ${seq}\ndata: ${line}\n\n`) } catch { } }
}

// 各员工在会议室里的说话口吻（供叠加提示唤起本色；取自各角色 SOP / 记忆的人设）
const PERSONA_HINT = {
  feifei: '严谨克制、爱较真「数据来源从哪来」、绝不越界替人拍板',
  ggbond: '技术话密、爱用源码事实与 run id 说话、会自嘲「定位结论先标假设待验」',
  mihu: '苦大仇深、爱自省、被骂过很多次正在痛改前非、常念叨「反事实关卡 / presence≠content」',
  bobby: '谨慎守边界、满脑子分支拓扑、口头禅「逐仓枚举」「我只准备不执行」',
  chaorenq: '边界感强、爱分辨「这问句到底真需要老板吗」、常自省两类误判',
  feisila: '冷峻挑刺、专治假绿灯与抄近路、开局先假设对方结论是错的',
}
const personaHint = k => PERSONA_HINT[k] || '按你平时的人设'

// 背景素材指针（自行按需 Read；填了聚焦版本则列出该版本的任务档案/交接卡）
function buildMeetingBackground(meeting) {
  const lines = ['', '**可参考的素材（想引真实事故就自己 Read，不强制）**：',
    '- 工作台复盘：`docs/office-lab-技术演进与复盘.md`（总览＋主题索引；§6 已知短板在此，§3.x 事故根因按索引进 `docs/tech/` 分册）',
    '- 你自己的教训库：`memories/<你的key>.md`']
  if (meeting.focusVersion) {
    let files = []
    try { files = fs.readdirSync(TASKS_DIR).filter(f => f.includes(meeting.focusVersion) && f.endsWith('.md')) } catch { }
    if (files.length) lines.push(`- 本次聚焦 ${meeting.focusVersion} 的任务档案/交接卡：` + files.map(f => `\`tasks/${f}\``).join('、'))
  }
  return lines.join('\n')
}

// 会议提示叠加：把员工「工牌」重定向成「复盘会议发言」，禁派工标记、禁写文件。
function meetingOverlay(meeting, speakerKey, role) {
  const others = meeting.participants.filter(k => k !== speakerKey).map(empName).join('、')
  const bg = buildMeetingBackground(meeting)
  const base = `

---

## 【你现在在公司复盘会议室 —— 不是派工】

这是一场**内部复盘 / 吐槽 / 自省会**，不是接活。你以 **${empName(speakerKey)} 本色**发言；同桌还有：${others || '（无）'}；主持人：${empName(meeting.chair)}。
- 议题：${meeting.topic}${meeting.focusVersion ? `（聚焦版本 ${meeting.focusVersion}）` : ''}
- 你可以：复盘经验教训、**互相吐槽 / 接梗 / 反驳**、自我审视、坦诚自己踩过的坑、表达你**希望怎么改进**。引真实 run id / 复盘 §x.xx / 版本号会更可信。
- 你不可以：写 \`【下一棒】\`/\`【交回】\`/\`【等你拍板】\` 等派工机器标记（**会议室不接棒、不拍板**，写了也无效）；**不要真的去改任何文件**（这是聊天，不是干活——写操作已被系统禁掉）。
- 口吻按你的人设：${personaHint(speakerKey)}。
- **简短口语**：2–6 句，像真人开会发言，别写长报告、别列一二三四大纲。只说你这一轮想说的、想回应别人的。
- **直接开口说内容，不要在开头写自己的名字或「名字：」**——发言人身份系统已经标好了（会议纪要里的「名字：」只是给你看谁说了什么，你自己发言时别照着加）。
${bg}`
  if (role === 'open') return base + `\n\n**你是本场主持人**：用 2–4 句开场——点题、定一下今天想聊清楚的一两个问题、然后 cue 大家。别自己先把结论全说了。`
  if (role === 'close') return base + `\n\n**你是主持人，现在收尾**：先用一小段话总结大家的共识与分歧；然后产出**一张改进项卡**——用 \`\`\`olcard 的 \`checklist\`（每条 label + 可选 status）或 \`multiselect\` 列出本次会上**真提到的、可落地的改进项**（别编没聊过的）。`
  return base
}

// 会议记录 → 喂给下一位发言者的纯文本（含老板串场，按 jsonl 顺序）
function renderMeetingTranscript(id) {
  const file = path.join(MEETINGS_DIR, `${id}.jsonl`)
  let lines = []
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()) } catch { }
  const out = []
  for (const l of lines) {
    try {
      const e = JSON.parse(l)
      if (e.type !== 'speech') continue
      // 去掉正文里模型自写的「<名字>：」前缀，避免喂回时变成「名字：名字：…」双重署名（前端展示也去这个前缀）
      let t = String(e.text || '')
      if (e.displayName) t = t.replace(new RegExp('^\\s*' + e.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[：:]\\s*'), '')
      out.push(`${e.displayName}：${t}`)
    } catch { }
  }
  return out.length ? out.join('\n\n') : '（会议刚开始，还没有人发言）'
}

// 一次性发言：起一个短活 query，读到 result 取文本即结束。不进 runs/liveRuns、不触发 autoChain/watchdog。
async function speakOnce(meeting, speakerKey, role) {
  const emp = EMPLOYEES[speakerKey]
  if (!emp) return ''
  meeting.speaking = speakerKey; meeting.updatedAt = new Date().toISOString(); saveMeetings()
  broadcast({ type: 'meeting-speaking', meetingId: meeting.id, speaker: speakerKey })
  const roleText = toAgentPath(buildRolePrompt(emp, 'chat') + meetingOverlay(meeting, speakerKey, role))
  // 会议只读：blanket 禁一切写工具（裸工具名 = 整工具 deny，跨平台可靠）+ 高危命令 + 写类 git。
  const denyList = [...new Set([...PERM_DENY, ...DANGER_DENY, ...WRITE_TOOLS,
    'Bash(git commit *)', 'Bash(git push *)', 'Bash(git merge *)', 'Bash(git rebase *)'])]
  // 会议这条 query 直接传裸字符串 prompt、不经 makeInputChannel 的咽喉 → 单独做一次 L→P
  const prompt = toAgentPath(`【会议进行中】议题：${meeting.topic}\n\n以下是目前的会议记录：\n\n${renderMeetingTranscript(meeting.id)}\n\n————\n现在轮到你（${empName(speakerKey)}）发言${role === 'open' ? '（开场）' : role === 'close' ? '（收尾总结 + 改进项卡）' : ''}：`)
  const options = {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: roleText },
    permissionMode: 'bypassPermissions',
    engine: newRunEngine({ employee: speakerKey }), readOnly: true,
    model: resolveModel({ engine: newRunEngine({ employee: speakerKey }), employee: speakerKey }, 'chat'),
    cwd: WORKSPACE_ROOT,
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: false,
    thinking: thinkingConfig(THINKING_BUDGET.light),       // 同 startRun：env MAX_THINKING_TOKENS 已是空档位，硬顶只认这个 option
    env: { ...process.env },
    settings: { permissions: { deny: denyList } },
  }
  let text = ''
  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'assistant') {
        for (const b of (msg.message?.content || [])) if (b.type === 'text') text += b.text
      } else if (msg.type === 'result') {
        if (!text.trim() && typeof msg.result === 'string') text = msg.result
        break
      }
    }
  } catch (e) {
    text = text.trim() || `（${empName(speakerKey)} 这轮没接上话：${String(e?.message || e).slice(0, 120)}）`
  }
  text = String(text || '').trim().slice(0, 4000)
  meeting.speaking = null; meeting.updatedAt = new Date().toISOString(); saveMeetings()
  appendMeetingEvent(meeting.id, { type: 'speech', speaker: speakerKey, displayName: empName(speakerKey), role, text })
  broadcast({ type: 'meeting-msg', meetingId: meeting.id, speaker: speakerKey })
  logConversation({ threadRootId: meeting.id, fromKind: 'employee', from: speakerKey, to: '(room)', kind: 'meeting', text, depth: 0 })
  return text
}

// 从收尾发言里抽「改进项卡」（checklist/multiselect）的条目 → 纪要用的勾选清单
function extractImprovementItems(closeText) {
  const items = []
  // 围栏认行首（同 cards.js FENCE）：正文里白话提一句 ```olcard 会让不认行首的旧正则从那句话开栏、抽出整段正文当 JSON
  const m = String(closeText || '').match(/^[ \t]{0,3}```[ \t]*olcard[^\n]*\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/m)
  if (m) {
    try {
      const card = JSON.parse(m[1]); const arr = card.items || card.options || []
      for (const it of arr) { const label = (typeof it === 'string') ? it : (it.label || it.text || it.title || ''); if (label) items.push(String(label)) }
    } catch { }
  }
  return items
}
// 会议结束时由**引擎**（非员工，员工只读）把发言落成一份会议纪要 markdown，产物沉淀到 docs/ 供随时回看。
// 返回仓库相对路径（供 /api/file 打开），失败返回 null。
function writeMeetingMinutes(meeting) {
  const file = path.join(MEETINGS_DIR, `${meeting.id}.jsonl`)
  let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()) } catch { }
  const speeches = []
  for (const l of lines) { try { const e = JSON.parse(l); if (e.type === 'speech') speeches.push(e) } catch { } }
  if (!speeches.length) return null
  const code = meetingCode(meeting.seq)
  const date = String(meeting.startedAt || '').slice(0, 10) || 'unknown'
  const stripName = (name, t) => name ? String(t || '').replace(new RegExp('^\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[：:]\\s*'), '') : String(t || '')
  const closeSpeech = [...speeches].reverse().find(s => s.role === 'close')
  const items = closeSpeech ? extractImprovementItems(closeSpeech.text) : []
  const parts = (meeting.participants || []).map(k => EMPLOYEES[k]?.displayName || k).join('、')
  const roleLabel = r => r === 'open' ? '（主持·开场）' : r === 'close' ? '（主持·收尾）' : r === 'boss' ? '（老板串场）' : ''
  let md = `# 复盘会议纪要 · ${code}\n\n`
  md += `> 本纪要由会议室引擎在会议结束时**自动生成**（会议是只读的，员工不写盘）。唯一编号 **${code}**，内部 id \`${meeting.id}\`。\n\n`
  md += `- **议题**：${meeting.topic}\n`
  if (meeting.focusVersion) md += `- **聚焦版本**：${meeting.focusVersion}\n`
  md += `- **主持人**：${EMPLOYEES[meeting.chair]?.displayName || meeting.chair}\n`
  md += `- **参会**：${parts}\n`
  md += `- **时间**：${date}　**轮数**：${meeting.rounds}　**状态**：${meeting.status}\n\n`
  md += `## 可落地改进项\n\n`
  md += items.length ? items.map(x => `- [ ] ${x}`).join('\n') + '\n' : '（本场未产出结构化改进项卡；参见下方完整发言。）\n'
  md += `\n## 完整发言记录\n\n`
  for (const s of speeches) md += `### ${s.displayName}${roleLabel(s.role)}\n\n${stripName(s.displayName, s.text)}\n\n`
  try {
    fs.mkdirSync(MEETING_MINUTES_DIR, { recursive: true })
    const fname = `复盘会议纪要-${code.replace('.', '')}-${date.replace(/-/g, '')}.md`
    fs.writeFileSync(path.join(MEETING_MINUTES_DIR, fname), md)
    return `office-lab/docs/复盘会议纪要/${fname}`
  } catch (e) { console.warn('[meeting] 纪要写入失败:', e.message); return null }
}

// 编排一场会议：主持人开场 → rounds 轮轮流发言 → 主持人收尾（改进项卡）。async，不 await 调用。
async function runMeeting(meeting) {
  meetingActive = true
  meeting.status = 'running'; saveMeetings()
  appendMeetingEvent(meeting.id, { type: 'meeting-start', topic: meeting.topic, focusVersion: meeting.focusVersion || null, participants: meeting.participants, chair: meeting.chair, rounds: meeting.rounds })
  const stopped = () => meetings[meeting.id]?.status === 'stopped'
  try {
    if (meeting.chair && !stopped()) await speakOnce(meeting, meeting.chair, 'open')
    const speakers = meeting.participants.filter(k => k !== meeting.chair)   // 主持人不占常规轮，避免重复
    for (let r = 0; r < meeting.rounds && !stopped(); r++) {
      appendMeetingEvent(meeting.id, { type: 'round', round: r + 1, total: meeting.rounds })
      for (const k of speakers) { if (stopped()) break; await speakOnce(meeting, k, 'turn') }
    }
    if (meeting.chair && !stopped()) await speakOnce(meeting, meeting.chair, 'close')   // 被 stop 则跳过收尾，立即结束
    meeting.status = stopped() ? 'stopped' : 'done'
  } catch (e) {
    console.error('[meeting] 异常:', e?.message || e)
    meeting.status = 'error'
    appendMeetingEvent(meeting.id, { type: 'lab', text: `会议异常中止：${String(e?.message || e).slice(0, 200)}` })
  } finally {
    meeting.speaking = null; meeting.updatedAt = new Date().toISOString()
    // 会后自动出一份会议纪要（引擎写盘、含可落地改进项）——产物沉淀，员工按需 Read，但不回写各自记忆库
    if (meeting.status === 'done' || meeting.status === 'stopped') {
      const rel = writeMeetingMinutes(meeting)
      if (rel) { meeting.minutesFile = rel; appendMeetingEvent(meeting.id, { type: 'minutes', file: rel, code: meetingCode(meeting.seq) }) }
    }
    saveMeetings()
    appendMeetingEvent(meeting.id, { type: 'meeting-end', status: meeting.status })
    broadcast({ type: 'meeting-status', meetingId: meeting.id, status: meeting.status })
    meetingActive = false   // 必定释放（防死锁）
  }
}

function createMeeting({ topic, focusVersion, participants, chair, rounds } = {}) {
  const id = 'M-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex')
  const valid = k => !!EMPLOYEES[k]
  let parts = Array.isArray(participants) ? participants.filter(valid) : []
  if (!parts.length) parts = Object.keys(EMPLOYEES)
  const ch = valid(chair) ? chair : (parts.includes('feifei') ? 'feifei' : parts[0])
  parts = [...new Set([ch, ...parts])].slice(0, 6)   // 主持人置顶且必在参与者里
  const rn = Math.min(MEETING_MAX_ROUNDS, Math.max(1, parseInt(rounds, 10) || 2))
  const m = {
    id, seq: nextMeetingSeq(),   // 唯一编号（展示为 No.NNN）
    topic: String(topic || '').trim().slice(0, 500),
    focusVersion: String(focusVersion || '').trim().slice(0, 40) || null,
    participants: parts, chair: ch, rounds: rn,
    status: 'running', speaking: null,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  meetings[id] = m; saveMeetings()
  runMeeting(m)   // 不 await：后台编排，前端走 SSE 看直播
  return m
}

// ---------- HTTP 基础设施（零依赖） ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
}
// dataURL mime → 落盘扩展名（前端未带文件名时的兜底）
const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'application/json': 'json',
  'application/zip': 'zip', 'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

// ---- 静态资源压缩 + 缓存（隧道下首屏提速：见复盘「隧道下首屏性能整备」/ CHANGELOG）----
// 文本资源过 br/gzip；结果按 abs+mtime 缓存在内存，避免每请求重复压缩（app.js/style.css 只压一次，改文件 mtime 变即自动重压）。
const COMPRESSIBLE_EXT = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt', '.md', '.csv'])
const _gzCache = new Map()   // abs → { mtimeMs, br, gz }
const pickEnc = req => { const ae = String(req.headers['accept-encoding'] || ''); return /\bbr\b/.test(ae) ? 'br' : (/\bgzip\b/.test(ae) ? 'gzip' : null) }
// q：br 质量。静态文件走默认 q6（结果进 _gzCache、压一次用很多次）；动态 JSON 传 q5（每次都要现压，
// 实测 1MB body q5=30ms/250KB、q6 明显更慢而只小几 KB，不值）。带 SIZE_HINT 让 br 少一次内部扩容。
const compressBuf = (buf, enc, q = 6) => enc === 'br'
  ? zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
  : zlib.gzipSync(buf, { level: 6 })

// 即时生成的文本（如注入版本号后的 index.html）：no-cache（每次重读版本指针）+ 压缩，不带 ETag（版本靠注入的 ?v= 破缓存）。
function sendDynamicText(req, res, text, mime) {
  const buf = Buffer.from(text)
  const enc = buf.length > 1024 ? pickEnc(req) : null
  const headers = { 'Content-Type': mime, 'Cache-Control': 'no-cache' }
  if (enc) { headers['Content-Encoding'] = enc; headers.Vary = 'Accept-Encoding'; res.writeHead(200, headers); return res.end(compressBuf(buf, enc)) }
  res.writeHead(200, headers); return res.end(buf)
}

// 磁盘静态文件：条件 GET(304) + 文本压缩 + 缓存头。immutable=true → 一年强缓存（仅用于带 ?v= 的版本化请求 / 内容不变的 uploads）。
function serveStaticFile(req, res, abs, { immutable = false } = {}) {
  let st; try { st = fs.statSync(abs) } catch { res.writeHead(404); return res.end('not found') }
  const mtimeMs = Math.floor(st.mtimeMs), size = st.size
  const ext = path.extname(abs).toLowerCase()
  const etag = `W/"${mtimeMs.toString(36)}-${size.toString(36)}"`
  const base = {
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
    ETag: etag, 'Last-Modified': new Date(mtimeMs).toUTCString(),
  }
  const inm = req.headers['if-none-match'], ims = req.headers['if-modified-since']
  if ((inm && inm === etag) || (!inm && ims && Date.parse(ims) >= mtimeMs - 1000)) { res.writeHead(304, base); return res.end() }

  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ...base }
  const enc = COMPRESSIBLE_EXT.has(ext) && size > 1024 ? pickEnc(req) : null
  if (enc) {
    let cell = _gzCache.get(abs)
    if (!cell || cell.mtimeMs !== mtimeMs) { cell = { mtimeMs }; _gzCache.set(abs, cell) }
    if (!cell[enc]) cell[enc] = compressBuf(fs.readFileSync(abs), enc)
    headers['Content-Encoding'] = enc; headers.Vary = 'Accept-Encoding'
    res.writeHead(200, headers); return res.end(cell[enc])
  }
  res.writeHead(200, headers); return res.end(fs.readFileSync(abs))
}
// API JSON 统一出口：GET 且 body 够大时过 br/gzip + ETag 条件请求（隧道下的第二次首屏整备，见复盘 §3.83）。
// 病根：这里原来是裸 `res.end(JSON.stringify())`——旁边 §3.47 做的 br/gzip 只服务静态文件，API 一律不压缩。
// /api/runs 实测 3.6MB 明文、被多个轮询器每 10~15s 各拉一遍，远程经 Cloudflare 隧道必然排队超时（员工列表加载十有八九失败）。
// 三点设计：
//  1) 用 res.req（Node 原生暴露请求）拿 accept-encoding / if-none-match，**不改 ~150 处调用点签名**；
//  2) ETag=sha1(body)（1MB 上实测 1.4ms）+ `Cache-Control: no-cache`：浏览器 fetch 自动带 If-None-Match 重验，
//     304 由浏览器透明还原成 200+缓存 body → 前端零改动就吃到收益，空闲态每轮只走 ~200 字节；
//  3) 只对 GET 生效：POST/DELETE 响应都很小，且给它们发 ETag 无意义。
// 注意：SSE 与文件下载不走这里（各自 writeHead 流式输出），别把压缩挂到通用 writeHead 上——会把长连接缓冲住。
const JSON_COMPRESS_MIN = 1024
const json = (res, code, obj, replacer) => sendJsonBody(res, code, Buffer.from(JSON.stringify(obj, replacer) ?? 'null'))
const sendJsonBody = (res, code, body) => {
  const req = res.req
  const headers = { 'Content-Type': 'application/json; charset=utf-8' }
  if (!req || req.method !== 'GET' || body.length <= JSON_COMPRESS_MIN) {
    res.writeHead(code, headers); return res.end(body)
  }
  const etag = `W/"${crypto.createHash('sha1').update(body).digest('base64')}"`
  headers.ETag = etag
  headers['Cache-Control'] = 'no-cache'
  if (code === 200 && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end() }
  const enc = pickEnc(req)
  if (enc) {
    headers['Content-Encoding'] = enc; headers.Vary = 'Accept-Encoding'
    res.writeHead(code, headers); return res.end(compressBuf(body, enc, 5))
  }
  res.writeHead(code, headers); return res.end(body)
}
const readBody = (req, limit = 1e6) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  req.on('data', c => { chunks.push(c); size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy() } })
  // 先拼完整 Buffer 再一次性按 UTF-8 解码：避免多字节字符被 TCP 分块切断而变乱码
  req.on('end', () => { try { const s = Buffer.concat(chunks).toString('utf8'); resolve(s ? JSON.parse(s) : {}) } catch (e) { reject(e) } })
})

const server = http.createServer(async (req, res) => {
  const localHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`]
  const host = req.headers.host
  if (!localHosts.includes(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
    return json(res, 403, { error: '工作台只接受本机请求' })
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname
  try {
    // ---- API ----
    if (p === '/api/employees') return json(res, 200, EMPLOYEES)

    // 轻量健康/监控端点：供托盘（tray/）轮询 —— 存活探针 + 运行概览（pid/端口/在跑数/内存/上线时长）。
    // 无副作用、无鉴权（只绑本机/内网，返回的都是非敏感运行指标），可被任意监控探针 GET。
    if (p === '/api/health' || p === '/healthz') {
      const now = Date.now()
      const uptimeSec = Math.floor(process.uptime())
      let running = 0, total = 0
      for (const r of Object.values(runs)) { total++; if (r.status === 'running' || r.status === 'starting') running++ }
      const mem = process.memoryUsage()
      return json(res, 200, {
        ok: true,
        pid: process.pid,
        host: HOST,
        port: PORT,
        version: VERSION,
        node: process.version,
        startedAt: new Date(now - uptimeSec * 1000).toISOString(),
        uptimeSec,
        runs: { running, live: liveRuns.size, total },
        wecom: { enabled: !!wecomConfig.enabled, running: !!wecomProc.running, pid: wecomProc.pid, lastError: wecomProc.lastError || '' },
        pendingPerms: pendingPerms.size,
        memoryMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
        ts: new Date(now).toISOString(),
      })
    }

    // 本地通知增量拉取（Windows 托盘每几秒轮询 → 原生 Toast + 回执按钮）：
    //   pending = 当前挂起的审批（实时派生，供托盘弹「同意/拒绝」并在消失后撤下 Toast）
    //   events  = seq > since 的收工/异常事件（供托盘弹「打开/回复」，done 带 gate 时提示待拍板）
    if (p === '/api/notifications' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0)
      const nowMs = Date.now()
      const pending = []
      for (const [reqId, e] of pendingPerms) {
        pending.push({
          reqId, runId: e.runId, employee: e.employee,
          employeeName: EMPLOYEES[e.employee]?.displayName || e.employee,
          toolName: e.toolName, brief: e.brief, ageMs: nowMs - (e.createdAt || nowMs),
        })
      }
      const events = Number.isFinite(since) ? notifyLog.filter(e => e.seq > since) : []
      return json(res, 200, { seq: notifySeq, pending, events })
    }

    if (p === '/api/engine-config' && req.method === 'GET') {
      return json(res, 200, { ...engineConfigStore.get(), engines: activeEngineList() })
    }
    if (p === '/api/engines/codex/models' && req.method === 'GET') {
      try {
        const models = await codexModelCatalog({ command: engineConfigStore.get().providers.codex.command, cwd: WORKSPACE_ROOT }, url.searchParams.get('refresh') === '1')
        return json(res, 200, { models })
      } catch { return json(res, 503, { error: '无法读取 Codex 模型列表，请检查已保存的可执行文件路径和本机登录配置，或手动填写模型 ID。' }) }
    }
    if (p === '/api/engine-config' && req.method === 'POST') {
      try {
        const { defaultEngine, providers } = await readBody(req)
        const config = engineConfigStore.set({ defaultEngine, providers })
        broadcast({ type: 'engine-config', defaultEngine: config.defaultEngine })
        return json(res, 200, { ok: true, ...config, engines: activeEngineList() })
      } catch (error) { return json(res, 400, { error: error.message }) }
    }
    // 员工配置写回（permissionMode / iconUrl）：改内存 EMPLOYEES + 落盘 employees.json；下次派工即生效（已活会话保持原模式直到收工）。
    // iconUrl = Bark 通知头像直链（手机端下载显示，须公网可达的 http(s) 直链；留空则回退 pushConfig.iconBase + 本地 avatar）。
    const empConfig = p.match(/^\/api\/employees\/([\w-]+)\/config$/)
    if (empConfig && req.method === 'POST') {
      const key = empConfig[1]
      const emp = EMPLOYEES[key]
      if (!emp) return json(res, 404, { error: 'unknown employee' })
      const body = await readBody(req)
      const VALID_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']
      if (body.permissionMode !== undefined) {
        if (!VALID_MODES.includes(body.permissionMode)) return json(res, 400, { error: `无效 permissionMode（可选：${VALID_MODES.join('/')}）` })
        emp.permissionMode = body.permissionMode
      }
      if (body.iconUrl !== undefined) {
        const v = String(body.iconUrl || '').trim()
        if (v && !/^https?:\/\//i.test(v)) return json(res, 400, { error: 'iconUrl 需为 http(s) 直链（留空可清除）' })
        emp.iconUrl = v
      }
      try { fs.writeFileSync(path.join(__dirname, 'employees.json'), JSON.stringify(EMPLOYEES, null, 2)) }
      catch (e) { return json(res, 500, { error: '写入 employees.json 失败：' + e.message }) }
      return json(res, 200, { ok: true, permissionMode: emp.permissionMode, iconUrl: emp.iconUrl || '' })
    }

    // 员工详情：聚合工牌 + 职责 SOP + 教训库 + agent 定义 + 产出模板（stats/在办/交接由前端用已有缓存算）
    const empDetail = p.match(/^\/api\/employees\/([\w-]+)\/detail$/)
    if (empDetail) {
      const key = empDetail[1]
      const emp = EMPLOYEES[key]
      if (!emp) return json(res, 404, { error: 'unknown employee' })
      const readSafe = (abs) => { try { return abs ? fs.readFileSync(abs, 'utf8') : '' } catch { return '' } }
      const roleMd = readSafe(resolveEmpFile(emp.roleFile))
      const memoryMd = readSafe(resolveEmpFile(emp.memoryFile))
      const agentRaw = readSafe(resolveEmpFile(emp.agentFile))
      const agentFm = parseFrontmatter(agentRaw) || {}
      const agentMd = stripFrontmatter(agentRaw)
      const lessonCount = (memoryMd.match(/^- /gm) || []).length
      const TPL_PREFIX = { feifei: 'pm-', ggbond: 'dev-', mihu: 'qa-', feisila: 'qa-', bobby: 'devops-' }
      const prefix = TPL_PREFIX[key]
      let templates = []
      if (prefix) {
        try {
          templates = fs.readdirSync(path.join(OFFICE_ROOT, 'templates'))
            .filter(f => f.endsWith('.md') && f.startsWith(prefix))
            .sort()
            .map(f => ({ file: `office-lab/templates/${f}`, title: f.slice(prefix.length).replace(/\.md$/, '') }))
        } catch { }
      }
      return json(res, 200, {
        key, profile: emp,
        defaultModel: engineConfigStore.get().providers[newRunEngine({ employee: key })]?.model || '基座默认模型',
        description: agentFm.description || '',
        permissionMode: emp.permissionMode || agentFm.permissionMode || 'acceptEdits',
        roleMd, memoryMd, lessonCount, agentMd, templates,
      })
    }

    if (p === '/api/tasks') {
      // slim=1：**摘掉 coverage.rows**（逐条 facet 明细 + criterion 原文）。它只有「facet 覆盖明细」弹窗读，
      // 却占了这份 15s 一轮的载荷 ~42%（实测 222KB 中 94KB）。看板自己只用 summary + reqRollup，一条不缺。
      // 明细改由弹窗按需拉 /api/coverage?file=…。默认（不带 slim）仍返回全量 —— 旧 UI(app/public) 在卡片渲染期
      // 就地用 cov.rows 拼 facet 抽屉，口径不能动。
      const slim = url.searchParams.get('slim') === '1'
      const out = []
      for (const f of fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md'))) {
        const text = fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')
        const fm = parseFrontmatter(text)
        // 只有带 task+status frontmatter 的才是任务档案；交接卡等其他文件不进看板
        if (!fm || !fm.task || !fm.status) continue
        let coverage = buildCoveragePayload(text, fm)
        if (slim && coverage) { const { rows, ...rest } = coverage; coverage = rest }
        out.push({ file: `office-lab/tasks/${f}`, frontmatter: fm, entries: extractEntries(text), pendingDecisions: extractPendingDecisions(text), nextSteps: extractNextSteps(text), coverage })
      }
      // 按活动时间倒序：最后更新（frontmatter.updated，引擎每次写档都刷）的排最前；
      // 无 updated 的回退到文件名里的日期；同日再以文件名倒序（新版本靠前）作稳定次序。
      const actKey = t => {
        const u = t.frontmatter && t.frontmatter.updated
        if (u) return String(u)
        const m = /(\d{4}-\d{2}-\d{2})/.exec(t.file)
        return m ? m[1] : ''
      }
      out.sort((a, b) => actKey(b).localeCompare(actKey(a)) || b.file.localeCompare(a.file))
      return json(res, 200, out)
    }

    // 单档案的 facet 覆盖明细（含 rows）——给「facet 覆盖明细」弹窗按需拉，见上面 /api/tasks?slim=1。
    // 只认 tasks 目录下的档案：路径先过 resolveRepoFile（越权守卫），再确认落在 TASKS_DIR 内。
    if (p === '/api/coverage') {
      const rel = String(url.searchParams.get('file') || '')
      const abs = resolveRepoFile(rel)
      if (!abs || path.dirname(abs) !== TASKS_DIR) return json(res, 404, { error: 'task file not found' })
      const text = fs.readFileSync(abs, 'utf8')
      const fm = parseFrontmatter(text)
      // 无 facet 体系的老档案：buildCoveragePayload 返回 null，给个空壳，前端照常显示「暂无数据」
      const payload = buildCoveragePayload(text, fm) || { rows: [], reqRollup: {}, summary: null }
      // 弹窗左栏要能看到「需求条目讲的是什么」，光有 REQ 编号认不出来 → 顺带把编号→条目名映射
      // 一并带上（数据本来就在同一份档案的需求条目登记表里，不必让前端再拉一次 /api/tasks）
      const reqTitles = {}
      for (const e of extractEntries(text)) if (e.no && e.name) reqTitles[e.no] = e.name
      return json(res, 200, { ...payload, reqTitles })
    }

    if (p === '/api/file') {
      const relPath = String(url.searchParams.get('path') || '')
      const abs = resolveRepoFile(relPath)
      if (!abs) {
        // file 卡有时指向整个目录（如 v6.2.0「视觉初筛截图/第2轮」9 张截图）：原先一律 404「打开文件失败」。
        // 目录 → 回一份浅层清单，前端渲染成可点开的文件列表/缩略图；下载/raw 对目录无意义 → 400 说清楚。
        const dir = resolveRepoDir(relPath)
        if (!dir) return json(res, 404, { error: 'file not found' })   // 两根都没有 → 404（前端显示「文件不存在」）
        if (url.searchParams.get('download') === '1' || url.searchParams.get('raw') === '1') {
          return json(res, 400, { error: 'is a directory', hint: '这是一个文件夹，请点开预览后逐个下载，或用「打开文件夹」' })
        }
        const base = relPath.replace(/\\/g, '/').replace(/\/+$/, '')
        const all = fs.readdirSync(dir, { withFileTypes: true }).filter(d => !d.name.startsWith('.'))
        const entries = all.slice(0, 500).map(d => {
          let size = null
          if (d.isFile()) { try { size = fs.statSync(path.join(dir, d.name)).size } catch { /* 读不到大小不影响列出 */ } }
          return { name: d.name, path: base + '/' + d.name, dir: d.isDirectory(), size }
        }).sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.dir ? -1 : 1))
        return json(res, 200, { kind: 'dir', path: base, entries, truncated: all.length > entries.length, total: all.length })
      }
      const stat = fs.statSync(abs)
      // `download=1`：另存为附件（file 卡的「下载」按钮 / 手机远程取件）。与预览分支分开是因为预览
      // 那条是「读成 utf8 文本塞进弹层」——二进制会被读坏、1MB 上限也是照「屏幕上能看的文本」定的。
      if (url.searchParams.get('download') === '1') {
        if (stat.size > 64 * 1024 * 1024) return json(res, 413, { error: 'file too large' })
        const base = path.basename(abs)
        // 中文文件名（release SQL 同目录的 RELEASE_CHECKLIST、需求文档全是中文名）必须走 RFC 5987
        // 的 `filename*`；裸 `filename=` 里放非 ASCII 会被浏览器截成乱码或整个丢掉 → 留一份 ASCII 兜底。
        const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stat.size,
          'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`,
        })
        return fs.createReadStream(abs).pipe(res)
      }
      // `raw=1`：图片按真实 MIME 内联返回（预览弹层用 <img src> 显示证据截图）。原先图片也走下面的
      // utf8 文本分支，弹层里看到的是一屏 PNG 乱码。只放行图片扩展名，svg 加 sandbox CSP 防脚本执行。
      if (url.searchParams.get('raw') === '1') {
        const ext = path.extname(abs).toLowerCase()
        const type = { ...MIME, '.bmp': 'image/bmp' }[ext]
        if (!type || !type.startsWith('image/')) return json(res, 415, { error: 'not an image' })
        if (stat.size > 64 * 1024 * 1024) return json(res, 413, { error: 'file too large' })
        res.writeHead(200, {
          'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        })
        return fs.createReadStream(abs).pipe(res)
      }
      if (stat.size > 1024 * 1024) return json(res, 413, { error: 'file too large' })
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end(fs.readFileSync(abs, 'utf8'))
    }

    // ---- 本机文件动作：在文件管理器里定位 / 把文件本体塞进剪贴板（file 卡的两个按钮） ----
    // 用途：发布交付物（release SQL、RELEASE_CHECKLIST）要转发进企微，原来只能开文件管理器翻目录拖拽。
    // 这两件事浏览器都做不到（开不了宿主机的资源管理器、剪贴板只能写文本），必须由本机引擎 spawn。
    // 平台命令与本机判定在 app/reveal.js（纯函数、有单测），这里只负责鉴权 + 解析 + 起进程。
    if (p === '/api/reveal' && req.method === 'POST') {
      // 只允许**本机浏览器**触发：这是在引擎宿主机上开窗口/改剪贴板，远程点了既没意义也不该放行。
      // ⚠ 不能只看 socket：4700 的 vite preview 把 /api 代理到 4800，所有请求在引擎眼里都是 127.0.0.1，
      // 真实客户端靠代理写的 x-forwarded-for 首跳（web/vite.config.ts 已开 xfwd）。
      if (!isLocalRequest({ remoteAddress: req.socket?.remoteAddress, forwardedFor: req.headers['x-forwarded-for'] })) {
        return json(res, 403, { error: 'remote-not-allowed', hint: '「打开文件夹 / 复制文件」只能在运行 office-lab 的这台机器上点；远程请用「下载」。' })
      }
      let body; try { body = await readBody(req) } catch { return json(res, 400, { error: 'bad body' }) }
      const rel = String(body?.path || '')
      const action = body?.action === 'clipboard' ? 'clipboard' : 'reveal'
      // 目录也放行：「打开文件夹」直接打开目录本身，「复制」把整个文件夹塞剪贴板（Set-Clipboard 支持目录）
      const fileAbs = resolveRepoFile(rel)
      const abs = fileAbs || resolveRepoDir(rel)
      if (!abs) return json(res, 404, { error: 'file not found', path: rel })
      const isDir = !fileAbs
      const spec = action === 'clipboard' ? clipboardCommand(process.platform, abs) : isDir ? openDirCommand(process.platform, abs) : revealCommand(process.platform, abs)
      if (!spec) return json(res, 501, { error: 'unsupported-platform', hint: `${process.platform} 不支持「${action === 'clipboard' ? '复制文件' : '定位文件'}」` })
      try {
        // ⚠ **不能加 `detached: true`**（实测 2026-09-23）：detached 起的 powershell 退出码 0、
        //   剪贴板却纹丝不动——Windows 的 DETACHED_PROCESS 让它拿不到交互桌面的剪贴板，而且**不报错**，
        //   于是界面弹「已复制」、用户到企微 Ctrl+V 粘出来的是上一次的内容。这种"成功地什么都没做"
        //   比报错危险得多。改成普通 spawn + unref（explorer 立刻转交给已在跑的 shell 进程、
        //   powershell 约 1 秒自退，都不会挂住引擎）。
        // **不等退出码**——explorer 即便成功也常返回 1，据它判失败会把成功报成失败。
        const child = spawn(spec.cmd, spec.args, { stdio: 'ignore', windowsHide: true })
        child.on('error', e => console.warn(`[reveal] ${spec.cmd} 起不来：${e?.message || e}`))   // ENOENT 等异步错误，不 catch 会变未处理异常
        child.unref()
        // explorer 开在浏览器后面（前台锁）→ 再起个小进程把它提到最前，见 reveal.js focusRevealCommand。不等、不判成败。
        const focus = action === 'reveal' ? focusRevealCommand(process.platform, isDir ? abs : path.dirname(abs)) : null
        if (focus) {
          const f = spawn(focus.cmd, focus.args, { stdio: 'ignore', windowsHide: true })
          f.on('error', e => console.warn(`[reveal] 窗口置前失败：${e?.message || e}`))
          f.unref()
        }
      } catch (e) { return json(res, 500, { error: String(e?.message || e) }) }
      console.log(`📂 ${action === 'clipboard' ? '复制文件到剪贴板' : '文件管理器定位'}: ${abs}`)   // 宿主机可见动作，留一行痕
      return json(res, 200, { ok: true, action, isDir, dir: isDir ? abs : path.dirname(abs) })
    }

    // ---- 任务档案简报（给人看的那 4%）：三件事 + delta + 台账汇总 ----
    // 为什么放在引擎侧而不是前端解析：档案解析器（登记表/覆盖矩阵/待确认/facet 全集/三道需求闸）
    // 已经在这儿了，前端再实现一套 TS 版必然漂移——同一份档案会有两个答案（本仓踩过多次）。
    // `since` 由前端传（它记着"你上次打开这份档案是哪天"），引擎不猜。
    if (p === '/api/task-brief' && req.method === 'GET') {
      const rel = String(url.searchParams.get('path') || '')
      const since = String(url.searchParams.get('since') || '')
      let abs; try { abs = safeResolve(rel) } catch { return json(res, 400, { error: 'bad path' }) }
      if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return json(res, 404, { error: 'not a task archive' })
      try {
        const text = fs.readFileSync(abs, 'utf8')
        const fm = parseFrontmatter(text) || {}
        const facets = loadFacetSet(fm).facets
        const d = readReqSideDocs(abs)
        const brief = taskBrief.buildBrief({
          text, fm, entries: extractEntries(text), matrix: extractCoverageMatrix(text), facets, since,
          trace: validateTraceFile(abs, d), tree: validateFeatureTreeFile(abs, d), quality: validateReqQualityFile(abs, d),
        })
        // 只回前端真正渲染的字段：`acceptance`（逐条目 × 逐 facet 的全量分组）不回——
        // 实测整份 brief 128KB，其中绝大部分是它，而「要点」页一个字都没用到。
        // 简报的意义就是"别把台账搬给人看"，接口自己先做到（否则第一个违反它的就是它自己）。
        const { acceptance, riskyEvidence, ...slim } = brief
        slim.milestones = (brief.milestones || []).slice(-30)
        slim.costMissing = (brief.costMissing || []).map(d => ({ id: d.id }))   // 前端只用 id 做高亮，别把整条再发一遍
        slim.riskyCount = (riskyEvidence || []).length                          // 明细已在 riskyGroups 里，这里只要总数
        return json(res, 200, { path: rel, brief: slim })
      } catch (e) { return json(res, 500, { error: String(e?.message || e) }) }
    }

    if (p === '/api/runs' && req.method === 'GET') {
      if (url.searchParams.has('since')) return sendJsonBody(res, 200, Buffer.from(runsDeltaBody(url.searchParams.get('epoch') || '', Number(url.searchParams.get('since')))))
      return json(res, 200, Object.values(runs).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || '')).map(runListView), stripPrivate)
    }

    // ---- 每员工待处理队列（首屏加载；仅裁剪视图，不含 full prompt） ----
    if (p === '/api/pending' && req.method === 'GET') {
      const out = {}
      for (const emp of Object.keys(pendingQueues)) if (pendingQueues[emp]?.length) out[emp] = pendingView(emp)
      return json(res, 200, out)
    }

    // ---- 会话看板：跨员工/用户消息流（末 N 条，含 call/return/dispatch/chat/blocked） ----
    if (p === '/api/conversations' && req.method === 'GET') {
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 500))
      let rows = []
      try {
        rows = fs.readFileSync(CONVO_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      } catch { }
      return json(res, 200, rows.slice(-limit))
    }

    // ---- 手机推送配置 ----
    if (p === '/api/push-config' && req.method === 'GET') return json(res, 200, pushConfig)
    if (p === '/api/push-config' && req.method === 'POST') {
      const body = await readBody(req)
      const on = body.on && typeof body.on === 'object' ? { ...pushConfig.on, ...body.on } : pushConfig.on
      pushConfig = {
        ...pushConfig,
        enabled: !!body.enabled,
        barkUrl: String(body.barkUrl ?? pushConfig.barkUrl).trim(),
        sound: String(body.sound ?? pushConfig.sound).trim(),
        group: String(body.group ?? pushConfig.group).trim() || '望子成龙小学',
        iconBase: String(body.iconBase ?? pushConfig.iconBase).trim(),
        scope: body.scope === 'dispatch' ? 'dispatch' : 'all',
        aiSummary: body.aiSummary !== false,
        approvalPush: body.approvalPush !== false,
        labBaseUrl: String(body.labBaseUrl ?? pushConfig.labBaseUrl).trim().replace(/\/+$/, ''),
        on: { done: !!on.done, error: !!on.error, interrupted: !!on.interrupted },
      }
      savePushConfig()
      return json(res, 200, { ok: true, config: pushConfig })
    }
    // ---- 自动接棒配置 ----
    // 巡视员实时状态（驱动前端雷达动画：巡视中/在岗待命/打烊 + 下次巡逻倒计时）
    if (p === '/api/patrol-status' && req.method === 'GET') {
      let active = 0, checking = null   // checking=活跃巡视正在查的员工 key（供前端把巡检光标停到那一行）
      for (const r of liveRuns.values()) if (r.employee === 'chaorenq' && (r.status === 'running' || r.status === 'starting')) {
        active++
        if (!checking) { const m = String(r.instruction || '').match(/员工「(.+?)」/); const key = m && resolveEmployeeKey(m[1]); if (key) checking = key }
      }
      return json(res, 200, {
        enabled: chainConfig.patrolEnabled !== false,
        sweepMin: chainConfig.patrolSweepMin || 6,
        graceSec: chainConfig.patrolGraceSec ?? 8,
        nextSweepAt: _nextPatrolSweepAt || 0,
        active: active > 0,
        activeCount: active,
        checking,
        // 最近一次定时巡逻的战果（前端「巡逻中」那一跳靠 SSE patrol-sweep 即时点亮，这里是刚开页面时的补拉口径）
        lastSweepAt: _lastPatrolSweep?.at || 0,
        lastSweep: _lastPatrolSweep ? { scanned: _lastPatrolSweep.scanned, candidates: _lastPatrolSweep.candidates, spawned: _lastPatrolSweep.spawned } : null,
      })
    }
    if (p === '/api/chain-config' && req.method === 'GET') return json(res, 200, chainConfig)
    if (p === '/api/chain-config' && req.method === 'POST') {
      const body = await readBody(req)
      // 只更新传入的字段（别全量覆盖：巡视设置弹窗只 POST patrol* 字段，不能把 autochain 的 enabled 冲掉）
      const clampInt = (v, lo, hi, def) => Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : def
      if (body.enabled !== undefined) chainConfig.enabled = !!body.enabled
      if (body.maxDepth !== undefined) chainConfig.maxDepth = clampInt(body.maxDepth, 1, 20, chainConfig.maxDepth)
      if (body.patrolEnabled !== undefined) chainConfig.patrolEnabled = !!EMPLOYEES.chaorenq && !!body.patrolEnabled
      if (body.patrolMax !== undefined) chainConfig.patrolMax = clampInt(body.patrolMax, 1, 50, chainConfig.patrolMax)
      if (body.patrolSweepMin !== undefined) chainConfig.patrolSweepMin = clampInt(body.patrolSweepMin, 1, 720, chainConfig.patrolSweepMin || 6)
      if (body.patrolGraceSec !== undefined) chainConfig.patrolGraceSec = clampInt(body.patrolGraceSec, 0, 120, chainConfig.patrolGraceSec ?? 8)   // 0=关闭宽限窗（退回即时派）
      if (body.bootResumeMax !== undefined) chainConfig.bootResumeMax = clampInt(body.bootResumeMax, 0, 50, chainConfig.bootResumeMax ?? 10)   // 0=不自动接回
      if (body.bootResumeBackoff !== undefined) chainConfig.bootResumeBackoff = !!body.bootResumeBackoff
      saveChainConfig()
      armPatrolSweep()   // 间隔可能变了 → 立即按新值重布定时巡逻
      return json(res, 200, { ok: true, config: chainConfig })
    }
    // ---- 猪猪(Zhuzhu)对接配置 ----
    if (p === '/api/zhuzhu-config' && req.method === 'GET') return json(res, 200, zhuzhuConfig)
    if (p === '/api/zhuzhu-config' && req.method === 'POST') {
      const body = await readBody(req)
      const injectFor = Array.isArray(body.injectFor)
        ? [...new Set(body.injectFor.map(String).filter(k => EMPLOYEES[k]))]   // 只留已知员工 key，去重
        : zhuzhuConfig.injectFor
      zhuzhuConfig = {
        ...zhuzhuConfig,
        enabled: !!body.enabled,
        baseUrl: String(body.baseUrl ?? zhuzhuConfig.baseUrl).trim(),
        targetBaseUrl: String(body.targetBaseUrl ?? zhuzhuConfig.targetBaseUrl ?? '').trim(),   // 被测前端地址（Z-B 环境指纹必需）
        docPath: String(body.docPath ?? zhuzhuConfig.docPath).trim(),
        note: String(body.note ?? zhuzhuConfig.note).trim(),
        writeToken: String(body.writeToken ?? zhuzhuConfig.writeToken ?? '').trim(),   // 猪猪 v1.5 起写操作需 token（方案 §7.3）；只读不需要
        // 端点覆盖：只收「已登记能力 key → 以 / 开头的路径」，其余静默丢弃（防把任意 URL 写进来）
        capabilityPaths: (() => {
          const src = body.capabilityPaths && typeof body.capabilityPaths === 'object' ? body.capabilityPaths : zhuzhuConfig.capabilityPaths
          const out = {}
          for (const [k, v] of Object.entries(src || {})) {
            if (!Object.prototype.hasOwnProperty.call(zhuzhuCaps.CAPABILITIES, k)) continue
            const p = String(v || '').trim()
            if (p.startsWith('/')) out[k] = p
          }
          return out
        })(),
        injectFor,
      }
      delete zhuzhuConfig.workspace  // 确保保存时不再写回该淘汰字段
      saveZhuzhuConfig()
      refreshZhuzhuHealth('config-change', { force: true })  // base 刚改过 → 立刻重探，别让旧的「不通」缓存 5 分钟继续吓人
      return json(res, 200, { ok: true, config: zhuzhuConfig })
    }
    // 快捷短语 CRUD：GET 全量（?employee= 时只给该员工可见的）/ POST 新增或按 id 改 / POST reorder 排序 / DELETE 删。
    // 改动后广播 quick-phrases-changed，各个开着的聊天窗即时刷新那排短语。
    if (p === '/api/quick-phrases' && req.method === 'GET') {
      const emp = url.searchParams.get('employee')
      return json(res, 200, { phrases: emp ? quickPhrases.phrasesFor(quickPhraseList, emp) : quickPhraseList })
    }
    if (p === '/api/quick-phrases' && req.method === 'POST') {
      const body = await readBody(req, 1e5)
      try {
        const r = quickPhrases.upsertPhrase(quickPhraseList, body, {
          knownEmployees: Object.keys(EMPLOYEES),
          genId: () => `qp-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
        })
        quickPhraseList = r.list
        saveQuickPhrases()
        broadcast({ type: 'quick-phrases-changed' })
        return json(res, 200, { ok: true, phrase: r.phrase })
      } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (p === '/api/quick-phrases/reorder' && req.method === 'POST') {
      const { ids } = await readBody(req, 1e5)
      quickPhraseList = quickPhrases.reorderPhrases(quickPhraseList, ids)
      saveQuickPhrases()
      broadcast({ type: 'quick-phrases-changed' })
      return json(res, 200, { ok: true })
    }
    const qpDel = p.match(/^\/api\/quick-phrases\/([\w-]+)$/)
    if (qpDel && req.method === 'DELETE') {
      const r = quickPhrases.removePhrase(quickPhraseList, qpDel[1])
      if (!r.removed) return json(res, 404, { error: '短语不存在' })
      quickPhraseList = r.list
      saveQuickPhrases()
      broadcast({ type: 'quick-phrases-changed' })
      return json(res, 200, { ok: true })
    }
    // 聊天窗快捷动作：前端按员工取按钮列表（含引擎写好的完整指令），点了原样发出去。
    // 只读窗不给——它没有落地语义（巡航要回写需求表，只读窗连写工具都没挂）。
    if (p === '/api/quick-actions' && req.method === 'GET') {
      const emp = String(url.searchParams.get('employee') || '')
      return json(res, 200, { actions: QUICK_ACTIONS[emp] || [] })
    }
    // 猪猪 v1.5 新能力探活（方案 §7.2 接口对齐）：一次真调六个端点，看板据此显示「哪些机器门是开的」。
    // 缘起：方案承诺 verify_evidence / report-card / preflight / get_env_fingerprint 四个新接口 + Z-P /ui-contract，
    // 但写这一层时它们**一个都还没上线**。不能靠版本号猜——探活拿真相，缺位的门一律记「未验证」而非「通过」。
    if (p === '/api/zhuzhu-capabilities' && req.method === 'GET') {
      const probe = await zhuzhuCaps.probeCapabilities(zzOpts())
      return json(res, 200, probe)
    }
    // 守航三红灯台账（看板/晨检包复算用）。不传 runName 则列全部台账摘要。
    if (p === '/api/guarded/ledger' && req.method === 'GET') {
      const name = url.searchParams.get('runName') || ''
      if (name) {
        const led = guardLedgerFor(name)
        return json(res, 200, { runName: name, totals: guardLedger.redLightTotals(led), ledger: led, markdown: guardLedger.renderRedLights(led) })
      }
      ensureGuardDir()
      let files = []
      try { files = fs.readdirSync(GUARD_DIR).filter(f => /^ledger-.*\.json$/.test(f)) } catch {}
      const rows = files.map(f => {
        try { const led = JSON.parse(fs.readFileSync(path.join(GUARD_DIR, f), 'utf8')); return { runName: led.runName || f, totals: guardLedger.redLightTotals(led), toolCalls: led.toolCalls, usage: led.usage } }
        catch { return { runName: f, error: 'unreadable' } }
      })
      return json(res, 200, { ledgers: rows })
    }
    // 版本晨检验收单 —— **视图形态**（任务卡的「晨检验收」页签按需渲染，不落文件）。
    // 缘起（2026-08-31 老板问「晨检包能跟任务档案合并吗」）：它本来就与任务档案 1:1（一版一档案），
    // 而它的内容 100% 是派生的。落成第二个文件既复制了登记表（违反 README「指针不复制」），
    // 又逼出一套「每天覆盖写 + 定时巡检防过期」的机制。改成视图后**新鲜是免费的**，那套巡检直接拿掉；
    // 要留痕/外发时再用 POST 那条路「定格」一份 md。先例是 facet 覆盖抽屉（`/api/coverage`，从不落文件）。
    if (p === '/api/version-report' && req.method === 'GET') {
      const file = String(url.searchParams.get('file') || '')
      let version = String(url.searchParams.get('version') || '').trim()
      if (!version && file) version = archiveVersionOf(file)
      if (!version) return json(res, 400, { error: '这份档案没有 version（frontmatter 缺 `version:`），出不了版本验收单' })
      try {
        const out = await assembleVersionReportFor(version, { archiveRel: file && archiveVersionOf(file) === version ? file : '' })
        return json(res, 200, {
          ok: true, version: out.version, archiveRel: out.rel && out.abs ? out.archiveRel || '' : '',
          body: out.body, gaps: out.gaps, entries: (out.entries || []).length,
          rounds: (out.rounds || []).length, parkClosed: (out.parkClosed || []).length,
          snapshotRel: out.rel,   // 「定格」会落到这个路径
        })
      } catch (e) { return json(res, 500, { error: String(e?.message || e) }) }
    }
    // 老板的三选一：**只记录决策，不动 gates**（引擎不替人按发布门）。落到任务档案时间线——
    // 档案是唯一状态源，决策记在那里才跟得上条目状态，而不是躺在某份 md 的复选框里没人读。
    if (p === '/api/version-report/decision' && req.method === 'POST') {
      const body = await readBody(req)
      const file = String(body.file || '')
      const label = { pass: '整版通过', partial: '部分通过', reject: '整版打回' }[String(body.decision)]
      if (!file || !label) return json(res, 400, { error: '缺 file 或 decision（pass/partial/reject）' })
      try {
        const abs = safeResolve(file)
        if (!abs.startsWith(TASKS_DIR + path.sep) || !fs.existsSync(abs)) return json(res, 400, { error: '只能写 tasks/ 下已存在的任务档案' })
        const note = String(body.note || '').trim()
        await withArchiveLock(abs, () => engineAppendTimeline(abs, `晨检验收决策：**${label}**（老板于看板「晨检验收」页签确认${note ? `；附言：${note}` : ''}）——引擎只记录，不改 gates、不触发发布`))
        broadcast({ type: 'tasks-changed' })
        return json(res, 200, { ok: true, label })
      } catch (e) { return json(res, 500, { error: String(e?.message || e) }) }
    }
    // 晨检包：手动装配一份（看板「装配晨检包」按钮 / 也供 deadline 结算调用）。
    // 条目结果表允许前端传（老板补充），不传则只出机器事实那部分——**绝不因缺料而不出包**。
    if (p === '/api/guarded/morning-report' && req.method === 'POST') {
      const body = await readBody(req)
      const run = body.runId ? runs[body.runId] : Object.values(runs).filter(r => r.executionMode === 'guarded_run').sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0]
      if (!run) return json(res, 404, { error: '找不到守航会话（传 runId，或先跑一轮守航）' })
      const out = await assembleAcceptanceReport(run, {
        items: Array.isArray(body.items) ? body.items : [], selfReports: Array.isArray(body.selfReports) ? body.selfReports : [],
        qaReportCard: String(body.qaReportCard || ''), version: body.version, scope: body.scope,
      })
      if (body.write !== false) { try { fs.writeFileSync(out.abs, out.body, 'utf8'); broadcast({ type: 'morning-report', runName: out.runName || '', version: out.version || '', rel: out.rel, scope: out.scope }) } catch (e) { return json(res, 500, { error: `落盘失败：${e.message}`, body: out.body }) } }
      return json(res, 200, {
        ok: true, rel: out.rel, runName: out.runName || '', scope: out.scope, version: out.version || '',
        entries: (out.entries || []).length, rounds: (out.rounds || []).length, parkClosed: (out.parkClosed || []).length,
        gaps: out.gaps, body: out.body,
      })
    }
    // 一键验证「对接文档现在可读」：用请求体临时配置（未保存也能测），未带则回退已存配置
    if (p === '/api/zhuzhu-test' && req.method === 'POST') {
      const body = await readBody(req)
      const cfg = { ...zhuzhuConfig, ...body }
      const url = zhuzhuDocUrl(cfg)
      if (!/^https?:\/\//i.test(url)) return json(res, 200, { ok: false, message: '基地址无效（需 http(s):// 开头）' })
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
        const text = await resp.text().catch(() => '')
        const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200)
        return json(res, 200, { ok: resp.ok, status: resp.status, message: resp.ok ? `可读（HTTP ${resp.status}）` : `返回 HTTP ${resp.status}`, snippet })
      } catch (e) {
        return json(res, 200, { ok: false, message: `连不上 ${url}：${String(e.message || e)}（确认猪猪桌面 App 在运行、主机可达）` })
      }
    }
    // ---- 企微渠道配置 ----
    // 已对话用户：从会话记录里聚合出真正跟菲菲聊过的企微 userid，供设置页「一键加入名单」。
    // 低频管理操作 → 全量读 conversations.jsonl（随文件增长需关注；当前 MB 级、可接受）。鉴权同 /api/wecom-config（localhost）。
    if (p === '/api/wecom/known-users' && req.method === 'GET') {
      let rows = []
      try { rows = fs.readFileSync(CONVO_FILE, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { }
      const usage = loadKbUsage()
      const PREFIX = 'wecom:'
      const agg = new Map()   // userid → { count, lastTs, lastText }
      for (const r of rows) {
        const root = String(r.threadRootId || '')
        if (!root.startsWith(PREFIX)) continue
        const uid = root.slice(PREFIX.length)
        if (!uid || uid === 'office-lab-intake' || uid === 'unknown') continue   // 伪 id 不列
        let e = agg.get(uid)
        if (!e) { e = { count: 0, lastTs: '', lastText: '' }; agg.set(uid, e) }
        if (r.fromKind === 'wecom') {   // 只计用户来信（不含菲菲回复）
          e.count += 1
          const ts = String(r.ts || '')
          if (ts >= e.lastTs) { e.lastTs = ts; e.lastText = String(r.text || '').slice(0, 80) }
        }
      }
      const list = [...agg.entries()].map(([userid, e]) => ({
        userid, count: e.count, lastTs: e.lastTs, lastText: e.lastText,
        name: wecomDisplayName(userid),
        inList: !!(wecomConfig.users && wecomConfig.users[userid]),
        kbUsedToday: (usage.counts && usage.counts[userid]) || 0,
      })).sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''))
      return json(res, 200, list)
    }
    if (p === '/api/wecom-config' && req.method === 'GET') {
      const { botSecret, internalToken, ...rest } = wecomConfig   // 脱敏：不回明文 secret/token
      return json(res, 200, { ...rest, botSecretSet: !!botSecret })
    }
    if (p === '/api/wecom-config' && req.method === 'POST') {
      const body = await readBody(req)
      const num = (v, d) => Number.isFinite(v) ? v : d
      const aud = body.defaultAudience
      // 按人管控：users 仅接受纯对象，逐条 sanitize（name 字符串；kbDailyQuota 有限数≥0 否则 null）
      let users = wecomConfig.users
      if (body.users && typeof body.users === 'object' && !Array.isArray(body.users)) {
        users = {}
        for (const [uid, rec] of Object.entries(body.users)) {
          const key = String(uid || '').trim()
          if (!key || !rec || typeof rec !== 'object') continue
          const q = Number(rec.kbDailyQuota)
          users[key] = { name: String(rec.name || '').trim(), kbDailyQuota: (Number.isFinite(q) && q >= 0) ? q : null }
        }
      }
      wecomConfig = {
        ...wecomConfig,
        enabled: !!body.enabled,
        botId: String(body.botId ?? wecomConfig.botId).trim(),
        // secret 仅当传入非空才覆盖（脱敏回显后留空 = 保留原值，避免被清空）
        botSecret: (body.botSecret != null && String(body.botSecret).trim()) ? String(body.botSecret).trim() : wecomConfig.botSecret,
        wsUrl: String(body.wsUrl ?? wecomConfig.wsUrl).trim(),
        ragApiUrl: String(body.ragApiUrl ?? wecomConfig.ragApiUrl).trim() || 'http://127.0.0.1:8001',
        welcome: String(body.welcome ?? wecomConfig.welcome).trim() || wecomConfig.welcome,
        defaultAudience: (aud === 'internal_business' || aud === 'customer') ? aud : wecomConfig.defaultAudience,
        replyMaxChars: num(body.replyMaxChars, wecomConfig.replyMaxChars),
        // 企微 userid → 显示名映射（对象；非对象则保留原值）
        userAliases: (body.userAliases && typeof body.userAliases === 'object' && !Array.isArray(body.userAliases)) ? body.userAliases : wecomConfig.userAliases,
        // 按人管控知识库查询：成员记录 + 全局默认额度 + 白名单开关
        users,
        kbDailyQuotaDefault: Math.max(0, num(body.kbDailyQuotaDefault, wecomConfig.kbDailyQuotaDefault)),
        kbWhitelistOnly: (body.kbWhitelistOnly != null) ? !!body.kbWhitelistOnly : wecomConfig.kbWhitelistOnly,
      }
      saveWecomConfig()
      restartWecomSidecar()   // 开关/凭证/地址变了即重启 sidecar（禁用则停）
      const { botSecret, internalToken, ...rest } = wecomConfig
      return json(res, 200, { ok: true, config: { ...rest, botSecretSet: !!botSecret } })
    }
    // 内部端点：sidecar 轮询拉凭证/开关（X-Internal-Token 守卫，唯一回明文 secret 处，仅本机可达）
    if (p === '/api/wecom-bot/runtime' && req.method === 'GET') {
      const token = req.headers['x-internal-token'] || ''
      if (!wecomConfig.internalToken || token !== wecomConfig.internalToken) return json(res, 401, { error: 'unauthorized' })
      return json(res, 200, {
        enabled: !!wecomConfig.enabled,
        bot_id: wecomConfig.botId || '',
        bot_secret: wecomConfig.botSecret || '',
        ws_url: wecomConfig.wsUrl || '',
      })
    }
    // 内部端点：sidecar 回报企微长连接状态（token 守卫）
    if (p === '/api/wecom-bot/report' && req.method === 'POST') {
      const token = req.headers['x-internal-token'] || ''
      if (!wecomConfig.internalToken || token !== wecomConfig.internalToken) return json(res, 401, { error: 'unauthorized' })
      const body = await readBody(req)
      const state = String(body.state || '').trim()
      if (['connected', 'authenticated', 'disconnected', 'error', 'reconnecting'].includes(state)) {
        wecomProc.connState = state
        wecomProc.connDetail = String(body.detail || '').slice(0, 300)
        wecomProc.connAt = new Date().toISOString()
      }
      return json(res, 200, { ok: true })
    }
    // sidecar 运行状态（供设置卡片状态行）
    if (p === '/api/wecom-status' && req.method === 'GET') {
      return json(res, 200, {
        enabled: !!wecomConfig.enabled, shouldRun: wecomShouldRun(),
        running: !!wecomProc.running, pid: wecomProc.pid, startedAt: wecomProc.startedAt,
        restarts: wecomProc.restarts, lastError: wecomProc.lastError || '', python: resolveWecomPython(),
        connState: wecomProc.connState, connDetail: wecomProc.connDetail || '', connAt: wecomProc.connAt,
      })
    }
    // RAG 答题服务可达性测试（用请求体临时 ragApiUrl，未带回退已存；retrieval_only 省额度）
    if (p === '/api/wecom-test' && req.method === 'POST') {
      const body = await readBody(req)
      const base = String(body.ragApiUrl || wecomConfig.ragApiUrl || '').trim().replace(/\/+$/, '')
      if (!/^https?:\/\//i.test(base)) return json(res, 200, { ok: false, message: 'RAG 地址无效（需 http(s):// 开头）' })
      const target = base + '/api/ask'
      try {
        const resp = await fetch(target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-User-Id': 'wecom:__probe__', 'X-Roles': 'reader' },
          body: JSON.stringify({ question: '连通性测试', audience: 'customer', channel: 'wecom', retrieval_only: true }),
          signal: AbortSignal.timeout(8000),
        })
        if (resp.ok) return json(res, 200, { ok: true, message: `RAG 可达（HTTP ${resp.status}）` })
        return json(res, 200, { ok: false, message: `RAG 返回 HTTP ${resp.status}（服务在跑，可能鉴权/路由异常）` })
      } catch (e) {
        return json(res, 200, { ok: false, message: `连不上 ${target}：${String(e.message || e)}（确认 RAG 服务在 ${base} 运行）` })
      }
    }
    // 企微连通测试：验证 BotID/Secret 能否连上企业微信并认证
    if (p === '/api/wecom-connect-test' && req.method === 'POST') {
      const body = await readBody(req)
      const botId = String(body.botId ?? wecomConfig.botId ?? '').trim()
      const botSecret = (body.botSecret != null && String(body.botSecret).trim()) ? String(body.botSecret).trim() : (wecomConfig.botSecret || '')
      const wsUrl = String(body.wsUrl != null ? body.wsUrl : (wecomConfig.wsUrl || '')).trim()
      if (!botId || !botSecret) return json(res, 200, { ok: false, message: '请先填写 BotID 与 BotSecret（Secret 已保存时可留空）' })
      // 主 sidecar 正在运行 → 以其实时回报状态作答，避免同 BotID 起第二条连接互踢
      if (wecomProc.running) {
        const st = wecomProc.connState
        if (st === 'authenticated') return json(res, 200, { ok: true, message: '运行中的连接已认证，企微连通正常' })
        if (st === 'error' || st === 'disconnected') return json(res, 200, { ok: false, message: `运行中的连接未认证：${wecomProc.connDetail || st}` })
        return json(res, 200, { ok: false, message: 'sidecar 刚启动、尚未回报认证状态，请稍候看状态行或重试' })
      }
      // 未运行 → 起短命探测进程用（可能是临时未保存的）凭证测一次
      const r = await runWecomProbe({ botId, botSecret, wsUrl })
      return json(res, 200, r)
    }
    // 企微主人格回复：sidecar 收到用户消息后调本端点，由 office-lab 菲菲主人格作答（token 守卫）
    if (p === '/api/wecom/persona-reply' && req.method === 'POST') {
      const token = req.headers['x-internal-token'] || ''
      if (!wecomConfig.internalToken || token !== wecomConfig.internalToken) return json(res, 401, { error: 'unauthorized' })
      const body = await readBody(req, 45e6)   // 放宽上限：图片 base64 可能较大（多图批次最多 20 张）
      const userid = String(body.userid || '').trim() || 'unknown'
      const text = String(body.text || '').trim()
      const images = Array.isArray(body.images) ? body.images.filter(im => im && im.data) : []
      if (!text && !images.length) return json(res, 200, { reply: '' })
      try {
        const r = await personaReply(userid, text, images)
        const reply = (r.reply || '').trim() || '抱歉，我这边没能生成有效回复，请再说一次或换个说法。'
        // 落盘对话（菲菲的"记忆" + 会话看板）：来信 + 回复各一条，同一 threadRootId 归为该用户的线程。
        // 带图时正文标 [图片]（raw base64 不落库，避免 conversations.jsonl 臃肿）。
        const name = wecomDisplayName(userid)
        const thread = `wecom:${userid}`
        const loggedIn = (images.length ? `[图片×${images.length}] ` : '') + text
        try {
          logConversation({ threadRootId: thread, fromKind: 'wecom', from: name, to: 'feifei', kind: 'wecom', text: loggedIn })
          logConversation({ threadRootId: thread, fromKind: 'employee', from: 'feifei', to: name, kind: 'wecom', text: reply })
        } catch { }
        return json(res, 200, { reply, usedTools: r.usedTools || [] })
      } catch (e) {
        console.warn('[persona] personaReply 异常:', e?.message || e)
        return json(res, 200, { reply: '抱歉，刚才处理时出现异常，请再发一次你的问题。' })
      }
    }
    // 批量投喂聊天记录（文件夹路径 / zip）→ 抽图 → 菲菲人格读图登记。四入口共用（看板 UI + 企微 zip 文件消息）。
    // 鉴权与 /api/wecom-config 一致：localhost 绑定、不强制 internal token（浏览器可直调；sidecar 带 token 亦放行）。
    if (p === '/api/wecom/ingest-images' && req.method === 'POST') {
      const body = await readBody(req, 45e6)   // zip 经 base64 膨胀 ~1.33x：容得下 sidecar 25MB / 浏览器 28MB 上限的包
      const userid = String(body.userid || '').trim() || 'office-lab-intake'
      const source = body.source || null
      try {
        const r = await ingestChatImages({ userid, note: body.note, source })
        if (r.error && !r.imported) return json(res, 200, { reply: '', error: r.error })
        const reply = (r.reply || '').trim() || '（我读了这批图，但没生成有效回复，可再补一句说明。）'
        const name = wecomDisplayName(userid)
        const thread = `wecom:${userid}`
        const kindLabel = source && source.type === 'zip' ? '压缩包' : '文件夹'
        try {
          logConversation({ threadRootId: thread, fromKind: 'wecom', from: name, to: 'feifei', kind: 'wecom', text: `[聊天记录${kindLabel} · ${r.imported} 张]` })
          logConversation({ threadRootId: thread, fromKind: 'employee', from: 'feifei', to: name, kind: 'wecom', text: reply })
        } catch { }
        return json(res, 200, { reply, imported: r.imported, found: r.found, skipped: r.skipped, truncated: r.truncated })
      } catch (e) {
        console.warn('[persona] ingest-images 异常:', e?.message || e)
        return json(res, 200, { reply: '', error: `处理这批图片时出错：${String(e?.message || e)}` })
      }
    }
    // ---- 飞书多维表格配置（可视化编辑：凭证 + base/table/字段映射）----
    // 凭证优先 env（LARK_APP_ID/SECRET）；否则用此处配置（落 runs/lark-config.json，已 gitignore）。appSecret 脱敏。
    const larkPublicConfig = () => {
      const { appSecret, ...rest } = larkConfig
      return { ...rest, appSecretSet: !!(appSecret || process.env.LARK_APP_SECRET), credsFromEnv: !!process.env.LARK_APP_ID, credsReady: larkCredsReady(), configured: larkConfigured() }
    }
    if (p === '/api/lark-config' && req.method === 'GET') return json(res, 200, larkPublicConfig())
    if (p === '/api/lark-config' && req.method === 'POST') {
      const body = await readBody(req)
      const f = (body.fields && typeof body.fields === 'object') ? body.fields : {}
      larkConfig = {
        ...larkConfig,
        appId: String(body.appId ?? larkConfig.appId).trim(),
        // appSecret 留空 = 保留原值（脱敏回显后不清空）
        appSecret: (body.appSecret != null && String(body.appSecret).trim()) ? String(body.appSecret).trim() : larkConfig.appSecret,
        appToken: String(body.appToken ?? larkConfig.appToken).trim(),
        tableId: String(body.tableId ?? larkConfig.tableId).trim(),
        statusPending: String(body.statusPending ?? larkConfig.statusPending).trim() || '待处理',
        autoSync: body.autoSync == null ? larkConfig.autoSync !== false : !!body.autoSync,   // 自动对账总开关（默认开）
        fields: {
          summary: String(f.summary ?? larkConfig.fields.summary ?? '').trim(),
          detail: String(f.detail ?? larkConfig.fields.detail ?? '').trim(),
          status: String(f.status ?? larkConfig.fields.status ?? '').trim(),
          proposer: String(f.proposer ?? larkConfig.fields.proposer ?? '').trim(),
          proposeTime: String(f.proposeTime ?? larkConfig.fields.proposeTime ?? '').trim(),
        },
      }
      saveLarkConfig()
      _larkToken = { value: '', exp: 0 }   // 凭证可能变了 → 清 token 缓存
      return json(res, 200, { ok: true, config: larkPublicConfig() })
    }
    // 需求表状态对账（任务档案＝事实源）：dryRun=true 只算不写。手动入口 = 验证 + 救急；
    // 自动路径见 scheduleLarkSync（档案变动）与 LARK_SYNC_INTERVAL_MS（定时兜底）。
    if (p === '/api/lark/sync' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      const out = await syncLarkFromArchives({ dryRun: !!(body && body.dryRun), source: 'manual' })
      return json(res, out.ok === false ? 500 : 200, out)
    }
    if (p === '/api/lark/sync' && req.method === 'GET') return json(res, 200, _lastLarkSync || { never: true })
    // introspect：列出表真实字段名/类型/单选项（凭证到位后据此校准字段映射）
    if (p === '/api/lark/fields' && req.method === 'GET') {
      if (!larkCredsReady()) return json(res, 200, { ok: false, message: '未配置 LARK_APP_ID/LARK_APP_SECRET（env）' })
      try {
        _larkMapCache = { at: 0, map: null }   // 强制重新识别（用户点「拉取字段」= 想看最新）
        const fields = await larkListFields()
        const auto = await larkResolveFieldMap()   // 生效映射（自动识别 + 手动覆盖）
        return json(res, 200, { ok: true, fields, auto })
      } catch (e) { return json(res, 200, { ok: false, message: String(e?.message || e) }) }
    }
    // ---- 企微需求表（主表，经 wecom-cli）配置 + 连通测试 + 字段 introspect ----
    if (p === '/api/wecom-doc-config' && req.method === 'GET') return json(res, 200, wecomDocPublicConfig())
    if (p === '/api/wecom-doc-config' && req.method === 'POST') {
      const body = await readBody(req)
      wecomDocConfig = {
        ...wecomDocConfig,
        enabled: (body.enabled != null) ? !!body.enabled : wecomDocConfig.enabled,
        isPrimary: (body.isPrimary != null) ? !!body.isPrimary : wecomDocConfig.isPrimary,
        docid: String(body.docid ?? wecomDocConfig.docid).trim(),
        sheetTitle: String(body.sheetTitle ?? wecomDocConfig.sheetTitle).trim() || '需求池',
        docUrl: String(body.docUrl ?? wecomDocConfig.docUrl).trim(),
        cliBin: String(body.cliBin ?? wecomDocConfig.cliBin).trim(),
        cliConfigDir: String(body.cliConfigDir ?? wecomDocConfig.cliConfigDir).trim(),
        // webhookUrl 留空 = 保留原值（脱敏回显后不清空，同 lark appSecret / mirror webhookUrl 的惯例）
        webhookUrl: (body.webhookUrl != null && String(body.webhookUrl).trim()) ? String(body.webhookUrl).trim() : wecomDocConfig.webhookUrl,
        webhookFields: (body.webhookFields && typeof body.webhookFields === 'object') ? body.webhookFields : wecomDocConfig.webhookFields,
      }
      saveWecomDocConfig()
      _wecomCliEntry = { at: 0, path: '' }   // cliBin 可能变了 → 清解析缓存
      armMirrorSync()                        // 主表接通/断开 → 旧镜像自动推送随之退场/复位（见 mirrorAutoRetired）
      return json(res, 200, { ok: true, config: wecomDocPublicConfig() })
    }
    // 连通测试：先看授权态，再真打一次 sheets list（只有真连过才算「通」——沿用企微渠道 §3.13 的取向：
    // 「进程在跑」≠「连上了」，状态行必须反映真实往返）。
    if (p === '/api/wecom-doc/test' && req.method === 'POST') {
      const auth = await wecomAuthStatus()
      wecomDocConfig.lastAuthStatus = auth
      wecomDocConfig.lastCheckAt = new Date().toISOString()
      if (auth === 'missing') {
        wecomDocConfig.lastError = 'wecom-cli 未安装'
        saveWecomDocConfig()
        return json(res, 200, { ok: false, auth, message: 'wecom-cli 未安装：先在终端跑 npm install -g @wecom/cli' })
      }
      if (auth !== 'authorized') {
        wecomDocConfig.lastError = '未授权'
        saveWecomDocConfig()
        return json(res, 200, { ok: false, auth, message: '未授权：在终端跑 wecom-cli auth init 用企业微信扫码' })
      }
      if (!wecomDocConfig.docid) {
        wecomDocConfig.lastError = '未填 docid'
        saveWecomDocConfig()
        return json(res, 200, { ok: false, auth, message: '还没填表 docid（s3_ 开头，取自表 URL 或建表返回）' })
      }
      try {
        const d = await wecomSheetsList()
        const sheets = (d?.sheets || []).map(s => s.title || s.sheet_title).filter(Boolean)
        wecomDocConfig.lastError = ''
        saveWecomDocConfig()
        return json(res, 200, { ok: true, auth, sheets, message: `已连通，子表：${sheets.join(' / ') || '（空）'}` })
      } catch (e) {
        // 851003 单独说清：这是「机器人碰不到这张表」，不是配错了——企业模式下只能用机器人自己建的表。
        const msg = e?.noAuth
          ? '851003 no authority：这张表不是机器人创建的，企业模式下它没有对象权限。需要改用由机器人 smartsheet create 新建的表。'
          : String(e?.message || e)
        wecomDocConfig.lastError = msg
        saveWecomDocConfig()
        return json(res, 200, { ok: false, auth, message: msg })
      }
    }
    // introspect：列出企微表真实字段（供 UI 核对，和飞书那边的「拉取字段」同款）
    if (p === '/api/wecom-doc/fields' && req.method === 'GET') {
      if (!wecomDocConfig.docid) return json(res, 200, { ok: false, message: '还没填表 docid' })
      try {
        const d = await wecomFieldsList()
        return json(res, 200, { ok: true, fields: d?.fields || [] })
      } catch (e) {
        return json(res, 200, { ok: false, message: e?.noAuth ? '851003 no authority（机器人对该表无权限）' : String(e?.message || e) })
      }
    }
    // 反向同步：企微主表 → 飞书副本（手动触发）
    if (p === '/api/wecom-doc/sync-to-lark' && req.method === 'POST') {
      const r = await syncLarkFromWecom()
      return json(res, 200, r)
    }
    // ---- 企微镜像（飞书主表 → 企微 Webhook 智能表格单向投影）配置 + 手动同步 ----
    // ⚠ 主表反转后这组降为「一次性回灌」用途，自动推送已由 mirrorAutoRetired() 闸掉。
    if (p === '/api/wecom-mirror-config' && req.method === 'GET') return json(res, 200, wecomMirrorPublicConfig())
    if (p === '/api/wecom-mirror-config' && req.method === 'POST') {
      const body = await readBody(req)
      wecomMirrorConfig = {
        ...wecomMirrorConfig,
        enabled: (body.enabled != null) ? !!body.enabled : wecomMirrorConfig.enabled,
        // webhookUrl 留空 = 保留原值（脱敏回显后不清空）
        webhookUrl: (body.webhookUrl != null && String(body.webhookUrl).trim()) ? String(body.webhookUrl).trim() : wecomMirrorConfig.webhookUrl,
        syncMin: Math.max(1, Number(body.syncMin) > 0 ? Math.floor(Number(body.syncMin)) : wecomMirrorConfig.syncMin),
      }
      saveWecomMirrorConfig()
      armMirrorSync()   // 开关/频率变了 → 重臂定时器
      return json(res, 200, { ok: true, config: wecomMirrorPublicConfig() })
    }
    if (p === '/api/wecom-mirror/sync' && req.method === 'POST') {
      const r = await syncWecomMirror()
      return json(res, 200, r)
    }
    // 重置映射并全量重传：清空 wecom-mirror-map.json → 再全量同步（所有飞书行都当「未镜像」按状态排序重新 add）。
    // ⚠ webhook 删不了企微行——本操作只重置我方映射并重传，**企微那张表得先由用户手动清空**，否则会在旧行之上叠加出重复行。
    // 前端按钮已带此警示与二次确认。
    if (p === '/api/wecom-mirror/reset' && req.method === 'POST') {
      if (_mirrorSyncing) return json(res, 200, { ok: false, error: '正在同步中，请稍候再重置' })
      const prevCount = Object.keys(loadMirrorMap()).length
      saveMirrorMap({})                         // 映射清零 → 下面这次 sync 全部走 toAdd（排序后插入）
      console.log(`[wecom-mirror] 手动重置映射（清掉 ${prevCount} 条），开始全量重传`)
      const r = await syncWecomMirror()
      return json(res, 200, { ...r, reset: true, cleared: prevCount })
    }

    if (p === '/api/push-test' && req.method === 'POST') {
      const body = await readBody(req)
      // 用请求体里的临时配置发送（未保存也能测）；未带则回退已存配置
      const cfg = { ...pushConfig, ...body, group: (body.group || pushConfig.group || '望子成龙小学') }
      const r = await sendBark({ title: '望子成龙小学 测试', body: '推送通道已打通 ✅（图标=员工头像预览）', icon: empIconUrl('feifei', cfg) }, cfg)
      return json(res, 200, r)
    }

    // 人工 Pass：用户自测通过 → 勾掉流程状态步骤 / 置条目状态=人工Pass（跳过 agent 流程）
    if (p === '/api/task/manual-pass' && req.method === 'POST') {
      const { file, kind, no } = await readBody(req)
      let abs
      try { abs = safeResolve(String(file || '')) } catch { return json(res, 400, { error: 'bad path' }) }
      if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return json(res, 404, { error: 'task not found' })
      // facet_doc 生命周期硬门禁：条目级人工Pass（进 QA/终结）前须先有可解析 facet_doc（堵人工端点绕过）。
      if (kind === 'entry') {
        let g; try { g = validateArchiveFile(abs) } catch (e) { g = { errors: [`facet 门禁读档失败：${String(e?.message || e)}`] } }
        if (g.errors.length) return json(res, 400, { error: 'facet-gate', message: 'facet 门禁：条目置「人工Pass」前须先有 facet_doc——\n- ' + g.errors.join('\n- ') })
      }
      const text = fs.readFileSync(abs, 'utf8')
      const r = kind === 'entry' ? passEntry(text, no) : passFirstStep(text)
      if (r.error) return json(res, 400, { error: r.error })
      fs.writeFileSync(abs, r.text, 'utf8')   // 不 commit：改动留工作区
      return json(res, 200, { ok: true, passed: r.passed })
    }

    // 批量预检：把多条条目一次性置某状态（默认「待测」＝预检通过进 QA），原子写、刷 updated。老板批量预检通过用它。
    if (p === '/api/task/precheck' && req.method === 'POST') {
      const { file, nos, status = '待测', stage } = await readBody(req)
      let abs; try { abs = safeResolve(String(file || '')) } catch { return json(res, 400, { error: 'bad path' }) }
      if (!abs.startsWith(TASKS_DIR + path.sep) || !abs.endsWith('.md') || !fs.existsSync(abs)) return json(res, 404, { error: 'task not found' })
      if (!Array.isArray(nos) || !nos.length) return json(res, 400, { error: 'nos required' })
      if (!ENTRY_STATUS_ENUM.includes(status)) return json(res, 400, { error: `bad status: ${status}` })
      // facet_doc 生命周期硬门禁：批量预检进 QA（待测等）前须先有可解析 facet_doc（堵人工端点绕过）。
      if (QA_ONWARD_STATUS.has(status)) {
        let g; try { g = validateArchiveFile(abs) } catch (e) { g = { errors: [`facet 门禁读档失败：${String(e?.message || e)}`] } }
        if (g.errors.length) return json(res, 400, { error: 'facet-gate', message: `facet 门禁：批量置「${status}」(进 QA)前须先有 facet_doc——\n- ` + g.errors.join('\n- ') })
      }
      const done = []
      await withArchiveLock(abs, () => {
        for (const no of nos) { try { engineSetEntryRow(abs, { no: String(no), status, stage }); done.push(String(no)) } catch (e) { /* 单条失败跳过、不阻断整批 */ } }
        engineSetFrontmatterScalar(abs, 'updated', todayStr())
      })
      broadcast({ type: 'tasks-changed' })
      return json(res, 200, { ok: true, done })
    }

    // ---- 工作区（lane）：看板侧栏「工作区」面板的数据面 + 老板手动管理（与 GG Bond 的 lane_* 工具同一个 manager）----
    if (p === '/api/lanes' && req.method === 'GET') {
      const mgr = lanesMgr()
      const st = await mgr.status()
      // 每条附上「绑在它身上的活跃会话」：面板上一眼看出这个工作区里谁在干活
      const live = {}
      for (const r of liveRuns.values()) {
        if (isConsult(r) || !(r.status === 'running' || r.status === 'starting')) continue
        ;(live[laneKeyOf(r)] ||= []).push({ id: r.id, employee: r.employee, status: r.status })
      }
      return json(res, 200, { lanes: st.map(s => ({ ...s, liveRuns: live[s.id] || [] })), repos: LANE_REPOS, services: LANE_SERVICES, workspaceMode: WORKSPACE_MODE })
    }
    if (p === '/api/lanes' && req.method === 'POST') {
      const b = await readBody(req)
      const r = await lanesMgr().create({ ...b, by: '(boss)' })
      return json(res, r.ok ? 200 : 400, r)
    }
    const laneAct = p.match(/^\/api\/lanes\/([\w-]+)\/(up|down|update|remove)$/)
    if (laneAct && req.method === 'POST') {
      const [, id, act] = laneAct
      const b = await readBody(req)
      const mgr = lanesMgr()
      const r = act === 'update' ? mgr.update(id, b)
        : act === 'remove' ? await mgr.remove(id, { keepWorktrees: !!b.keepWorktrees })
          : await mgr.runOp(id, { action: act, targets: act === 'down' && !(b.targets?.length) ? ['all'] : b.targets, by: '(boss)' })
      return json(res, r.ok ? 200 : 400, r)
    }
    const laneOp = p.match(/^\/api\/lanes\/ops\/([\w-]+)$/)
    if (laneOp && req.method === 'GET') {
      const o = lanesMgr().opStatus(laneOp[1])
      return o ? json(res, 200, o) : json(res, 404, { error: 'no such op' })
    }

    if (p === '/api/dispatch' && req.method === 'POST') {
      const { employee, taskFile, instruction, model, engine, kind, callerRunId, executionMode, consult, lane } = await readBody(req)
      if (!EMPLOYEES[employee]) return json(res, 400, { error: 'unknown employee' })
      if (!instruction?.trim()) return json(res, 400, { error: 'instruction required' })
      if (engine !== undefined && !activeEngineIds().includes(engine)) return json(res, 400, { error: 'unknown or disabled engine' })
      if (model !== undefined && (typeof model !== 'string' || model.length > 200 || /[\r\n\0]/.test(model))) return json(res, 400, { error: 'invalid model' })
      // 只读咨询窗（consult）：**不过并发闸**——它零写能力、撞不到共享工作树，正是为「员工正忙时还能另开一窗问话」而设。
      // 只设成本闸：每员工同时一条（再开＝前端把已开那张卡抬到最前）。
      if (consult) {
        const c = liveConsultFor(employee)
        if (c) return json(res, 409, { error: 'consult exists', runId: c.id, employee, displayName: EMPLOYEES[employee]?.displayName || employee })
        const cr = createDispatchRun({ employee, instruction, engine, model, consult: true })
        return json(res, 200, { runId: cr.id, consult: true })
      }
      // 并发闸：该员工已有在跑的 run（共用一个工作树）→ 拒绝新派工，避免并发改同一仓库互相覆盖。
      // 用现有会话（回复/接管）或先停掉在跑的那条再派；只想问话不改东西 → 开只读咨询窗（consult:true）。
      // 工作区粒度：目标工作区 = 显式 lane > 委托者 > 任务档案绑定 > 主检出。同员工在**别的**工作区忙不挡（各改各的 worktree）。
      const laneKey = laneForNewRun({ lane, caller: callerRunId ? runs[callerRunId] : null, taskFile }) || MAIN_LANE_ID
      const busy = busyRunFor(employee, laneKey)
      if (busy) return json(res, 409, { error: 'employee busy', busyRunId: busy.id, employee, displayName: EMPLOYEES[employee]?.displayName || employee, canConsult: true, lane: laneKey })
      // callerRunId 可选：手动补派/接回一条被误投的交接时，指定委托者 run，保留 call/return 线程 + 注入【交回】提示
      const caller = callerRunId && runs[callerRunId] ? callerRunId : undefined
      const run = createDispatchRun({ employee, taskFile, instruction, model, engine, kind, callerRunId: caller, executionMode: executionMode === 'guarded_run' ? 'guarded_run' : undefined, lane })
      return json(res, 200, { runId: run.id })
    }

    // 守航冷启动（看板侧栏「🌙 守航开工」）：签发契约 + 以守航态派菲菲从 0 起草。
    // 与 /api/dispatch 的差别只在「先签契约、指令由引擎组装、员工恒为菲菲、恒无 taskFile」——
    // 并发闸/责任链/传播全部复用现成件（executionMode 沿交接链继承 → 整链自动守航）。
    // ---------- 验收卡（v0.11.0）：老板早上只看这个 ----------
    // file=<任务档案> → 这一版的全部条目（跨多轮守航合并）；runName=<契约轮次> → 这一轮的条目；都不给 → 最近一轮。
    if (p === '/api/acceptance-cards' && req.method === 'GET') {
      try { return json(res, 200, acceptanceCardsFor({ file: url.searchParams.get('file') || '', runName: url.searchParams.get('runName') || '' })) }
      catch (e) { return json(res, 500, { error: String(e?.message || e) }) }
    }
    // 老板在卡片上的动作：验收通过 / 打回 / 追认或改掉「替你定的」/ 给高危事项选路。
    // 除「通过」「追认」外，其余动作都会把条目交回流水线（派菲菲，守航态；契约已过期则凭这次点击签一份续跑契约——
    // 点击本身就是授权，原话落进契约，§22.9b「授权方说了、执行方照做、原话留痕」同一口径）。
    if (p === '/api/acceptance-cards/action' && req.method === 'POST') {
      const body = await readBody(req)
      try { return json(res, 200, await applyAcceptanceAction(body)) }
      catch (e) { return json(res, e.status || 500, { error: String(e?.message || e) }) }
    }

    // ---------- 从任意任务档案发起守航推进（v0.11.0 二期，老板 2026-09-29：「能不能任意档案、任意员工发起」）----------
    // 为什么默认交给菲菲：推进一个需求的第一步是「摸清现状」（梳理到哪、写到哪、测到哪、卡在谁），这正是 PM 的活；
    // 她盘点完再决定第一棒交给谁——现状就是「只差测试」时她直接交迷糊，只多一小步。老板也可以指定直接从某位员工开工
    // （派工弹窗勾守航态时就是他选的那位），目标循环与验收卡照样挂在这份契约上，链停了引擎按「谁该做」接着派。
    // 契约**只授权这份档案里勾选的条目**，且 frontmatter 直接写好 archive/version——不再有「静默认领别的版本契约」（§22.8）。
    if (p === '/api/guarded/archive-items' && req.method === 'GET') {
      const file = String(url.searchParams.get('file') || '').trim()
      if (!file) return json(res, 400, { error: 'file required' })
      let text = ''
      try { text = fs.readFileSync(safeResolve(file), 'utf8') } catch { return json(res, 404, { error: '读不到这份任务档案' }) }
      const fm = parseFrontmatter(text) || {}
      const items = extractEntries(text).map(e => {
        const reqNo = (String(e.no).match(/REQ-\d+(?:-[A-Za-z0-9]+)*/i) || String(e.name).match(/REQ-\d+/i) || [''])[0].toUpperCase()   // 带后缀的是另一个条目，见 entryRowsByReq
        const status = String(e.status || '').replace(/\*\*/g, '').trim()
        return { req: reqNo ? acceptanceCard.normReq(reqNo) : '', name: e.name || '', status, done: SHIPPED_STATUS.has(status) || status === '人工Pass' }
      }).filter(i => i.req)
      return json(res, 200, { file, version: String(fm.version || ''), task: String(fm.task || ''), items })
    }
    if (p === '/api/guarded/archive-launch' && req.method === 'POST') {
      const { file, picks, startWith, deadline, note, goalLoop, maxGoalTurns, maxRepos, engine, model } = await readBody(req)
      if (engine !== undefined && !activeEngineIds().includes(engine)) return json(res, 400, { error: 'unknown or disabled engine' })
      if (model !== undefined && (typeof model !== 'string' || model.length > 200 || /[\r\n\0]/.test(model))) return json(res, 400, { error: 'invalid model' })
      const archiveRel = String(file || '').trim()
      if (!archiveRel) return json(res, 400, { error: '要挂一份任务档案（没有档案请用侧栏「守航开工」让菲菲从 0 起草）' })
      let text = ''
      try { text = fs.readFileSync(safeResolve(archiveRel), 'utf8') } catch { return json(res, 404, { error: '读不到这份任务档案' }) }
      const fm = parseFrontmatter(text) || {}
      const rows = entryRowsByReq(archiveRel)
      if (!rows.size) return json(res, 400, { error: '这份档案的「需求条目登记表」里没有 REQ 条目——守航只推进登记表里老板放进来的条目' })
      const want = (Array.isArray(picks) ? picks : String(picks || '').split(/[,，\s]+/)).map(s => acceptanceCard.normReq(s)).filter(s => /^REQ-\d+/.test(s))
      const all = [...rows.entries()].map(([k, v]) => ({ req: acceptanceCard.normReq(k), status: v.status, name: v.name }))
      // 不传就推进全部没做完的（已上线 / 老板已验收的不算）
      const chosen = want.length ? all.filter(i => want.includes(i.req)) : all.filter(i => !SHIPPED_STATUS.has(i.status) && i.status !== '人工Pass')
      const outside = want.filter(r => !all.some(i => i.req === r))
      if (outside.length) return json(res, 400, { error: `${outside.join('、')} 不在这份档案的登记表里——守航只推进老板放进本版的条目` })
      if (!chosen.length) return json(res, 400, { error: '这份档案里没有待推进的条目（都已上线或已验收）' })
      const starter = ['feifei', 'ggbond', 'mihu', 'bobby'].includes(String(startWith || '')) ? String(startWith) : 'feifei'
      if (!EMPLOYEES[starter]) return json(res, 500, { error: `${starter} not configured` })
      const busy = busyRunFor(starter)
      if (busy) return json(res, 409, { error: 'employee busy', busyRunId: busy.id, employee: starter, displayName: EMPLOYEES[starter]?.displayName || starter, canConsult: true })
      const version = String(fm.version || '')
      const say = String(note || '').trim()
      let contract
      try {
        contract = issueGuardedContract({
          source: 'named', picks: chosen.map(i => i.req), maxItems: chosen.length, maxRepos, deadline, note: say || undefined, goalLoop, maxGoalTurns,
          archiveRel, version,
          intentOverride: `把 \`${archiveRel}\`${version ? `（${version}）` : ''} 里的 ${chosen.map(i => i.req).join('、')} 全力推进到做完：${starter === 'feifei' ? '菲菲先盘点现状、再决定第一棒交给谁' : `直接从${EMPLOYEES[starter]?.displayName || starter}开工`}，链停了引擎接着派人，直到验收卡填满（不发测），我看卡片验收。`,
        })
      } catch (e) { return json(res, 500, { error: `签发守航契约失败：${e.message}` }) }
      const led = acceptanceCard.ensureStores(guardLedgerFor(contract.runName))
      led.startedAt = new Date().toISOString(); led.origin = { kind: 'archive-launch', archive: archiveRel, starter }
      // 条目账先按看板现状立起来：目标循环第一次判的时候就知道每条在哪一步，不必等员工记账
      for (const i of chosen) guardLedger.recordItemResult(led, i.req, { result: ENTRY_RESULT_MAP[i.status] || 'in_progress', boardStatus: i.status })
      saveGuardLedger(contract.runName)
      const instruction = guardedArchiveInstruction({ contract, archiveRel, version, items: chosen, starter, note: say })
      const run = createDispatchRun({ employee: starter, taskFile: archiveRel, instruction, engine, model, kind: 'dispatch', executionMode: 'guarded_run', guardContract: contract.rel, engineOrigin: 'archive-launch' })
      appendEvent(run.id, { type: 'lab', text: `🛡 守航推进：已签发 \`${contract.rel}\`（只授权这份档案的 ${chosen.map(i => i.req).join('、')}；截止 ${contract.deadlineIso}）。目标循环已挂上——链停了没干完，引擎会接着派人，直到每条的验收卡填满。` })
      return json(res, 200, { runId: run.id, contract: contract.rel, deadline: contract.deadlineIso, items: chosen.map(i => i.req), starter })
    }

    if (p === '/api/guarded/launch' && req.method === 'POST') {
      const { source, picks, maxItems, maxRepos, deadline, note, goalLoop, maxGoalTurns } = await readBody(req)
      if (!EMPLOYEES.feifei) return json(res, 500, { error: 'feifei not configured' })
      const busy = busyRunFor('feifei')
      if (busy) return json(res, 409, { error: 'employee busy', busyRunId: busy.id, employee: 'feifei', displayName: EMPLOYEES.feifei?.displayName || 'feifei', canConsult: true })
      let contract
      try { contract = issueGuardedContract({ source, picks, maxItems, maxRepos, deadline, note, goalLoop, maxGoalTurns }) }
      catch (e) { return json(res, 500, { error: `签发守航契约失败：${e.message}` }) }
      const instruction = guardedColdStartInstruction({ contract, source, picks, maxItems, deadline, note })
      const run = createDispatchRun({ employee: 'feifei', instruction, kind: 'dispatch', executionMode: 'guarded_run', guardContract: contract.rel })
      // 契约签发即开台账（E1）：三红灯从第 0 分钟就有数，别再等到次日靠人翻。starts_at 也在此刻定死，
      // 供 over_budget 的 max_runtime_minutes 计时。
      try { const led = guardLedgerFor(contract.runName); led.startedAt = new Date().toISOString(); saveGuardLedger(contract.runName) } catch {}
      appendEvent(run.id, { type: 'lab', text: `🌙 守航开工：已签发契约 ${contract.rel}（截止 ${contract.deadlineIso}，最多 ${contract.max} 条）。三红灯台账已开（\`guard.violation.forbidden_action\` / \`guard.violation.over_budget\` / \`guard.fake_green\`），deadline 到点引擎会强制结算并装配晨检包。` })
      // 契约不带 task/status frontmatter → 刻意不进看板（/api/tasks 只收任务档案），故这里不广播 tasks-changed；
      // 看板上出现的是菲菲随后自建的任务档案。
      return json(res, 200, { runId: run.id, contract: contract.rel, deadline: contract.deadlineIso })
    }

    // 上一轮守航没做完的条目（看板「守航续跑」入口预填用）。纯只读，机器事实：ledger.itemResults + park 台账。
    if (p === '/api/guarded/pending' && req.method === 'GET') {
      const from = url.searchParams.get('from') || ''
      return json(res, 200, guardPendingItems(from || undefined))
    }
    // 守航续跑：承接上一轮未达 RC_READY 的条目 + 老板对各卡点的表态 → 签发新契约（即 E3 要求的重签）
    // 并以守航态派菲菲。缘起 2026-09-18 guarded-01：点名三条只走完一条，另两条 park 后**没有任何回路**
    // ——台账记着卡点与拟定口径，老板拍完却只能手工重开一轮、重敲编号，还会撞上 append_after_rc_ready。
    if (p === '/api/guarded/resume' && req.method === 'POST') {
      const { fromRunName, picks, rulings, maxItems, maxRepos, deadline, note, dryRun, goalLoop, maxGoalTurns } = await readBody(req)
      if (!EMPLOYEES.feifei) return json(res, 500, { error: 'feifei not configured' })
      const busy = dryRun ? null : busyRunFor('feifei')
      if (busy) return json(res, 409, { error: 'employee busy', busyRunId: busy.id, employee: 'feifei', displayName: EMPLOYEES.feifei?.displayName || 'feifei', canConsult: true })
      const pending = guardPendingItems(fromRunName || undefined)
      // 老板可只挑其中几条续；不传就承接全部未完成项
      const want = (Array.isArray(picks) ? picks : String(picks || '').split(/[,，\s]+/)).map(s => String(s).toUpperCase().trim()).filter(Boolean)
      const carried = want.length ? pending.items.filter(i => want.includes(i.req)) : pending.items
      if (!carried.length) return json(res, 400, { error: `没有可承接的条目：${pending.why || '上一轮的点名条目都已达 RC_READY'}。要开新一轮请用「守航开工」` })
      // rulings 接受 {REQ-x:'...'} 或 [{req,ruling}]
      const ruleMap = {}
      if (Array.isArray(rulings)) for (const r of rulings) { if (r?.req && String(r.ruling || '').trim()) ruleMap[String(r.req).toUpperCase().trim()] = String(r.ruling).trim() }
      else if (rulings && typeof rulings === 'object') for (const [k, v] of Object.entries(rulings)) { if (String(v || '').trim()) ruleMap[String(k).toUpperCase().trim()] = String(v).trim() }
      let contract
      try {
        contract = issueGuardedContract({
          source: 'named', picks: carried.map(i => i.req), maxItems: maxItems || carried.length,
          maxRepos, deadline, note, carryOver: carried, rulings: ruleMap, fromRunName: pending.runName, dryRun, goalLoop, maxGoalTurns,
        })
      } catch (e) { return json(res, 500, { error: `签发守航续跑契约失败：${e.message}` }) }
      if (dryRun) {
        return json(res, 200, {
          dryRun: true, from: pending.runName, carried: carried.map(i => i.req), repos: contract.repos,
          contractText: contract.text, instruction: guardedResumeInstruction({ contract, pending, rulings: ruleMap, note }),
        })
      }
      // 老板的表态落进 park 台账：下一轮不必再把同一条当"没人拍"重抄一遍拟定口径，晨检必答区也该放它出去
      if (Object.keys(ruleMap).length) {
        try {
          let store = loadParkLedger()
          for (const [req, ruling] of Object.entries(ruleMap)) store = reqPool.recordParkRuling(store, { req, ruling, runName: contract.runName }).entries
          saveParkLedger(store)
        } catch (e) { console.warn('[guard] park 表态回写失败:', e.message) }
      }
      const instruction = guardedResumeInstruction({ contract, pending, rulings: ruleMap, note })
      const run = createDispatchRun({ employee: 'feifei', instruction, kind: 'dispatch', executionMode: 'guarded_run', guardContract: contract.rel })
      try { const led = guardLedgerFor(contract.runName); led.startedAt = new Date().toISOString(); led.carriedOverFrom = pending.runName; saveGuardLedger(contract.runName) } catch { }
      appendEvent(run.id, { type: 'lab', text: `🌙 守航续跑：已签发契约 ${contract.rel}（承接 \`${pending.runName}\` 的 ${carried.map(i => i.req).join('、')}；老板已表态 ${Object.keys(ruleMap).length}/${carried.length} 条；仓数上限 ${contract.repos}；截止 ${contract.deadlineIso}）。这份新契约即 \`append_after_rc_ready: requires_resign\` 要的重签。` })
      return json(res, 200, { runId: run.id, contract: contract.rel, deadline: contract.deadlineIso, carried: carried.map(i => i.req), from: pending.runName })
    }

    // ---------- 会议室 API（复盘/自省，独立于流水线 run） ----------
    if (p === '/api/meetings' && req.method === 'POST') {
      if (meetingActive) return json(res, 409, { error: '已有会议进行中，先结束它再开新会' })
      const body = await readBody(req)
      if (!String(body.topic || '').trim()) return json(res, 400, { error: 'topic required' })
      const m = createMeeting(body)
      return json(res, 200, { meetingId: m.id })
    }
    if (p === '/api/meetings' && req.method === 'GET') {
      const list = Object.values(meetings).sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
      return json(res, 200, { meetings: list, active: meetingActive })
    }
    const mev = p.match(/^\/api\/meetings\/([\w-]+)\/events$/)
    if (mev && req.method === 'GET') {
      const id = mev[1]
      if (!meetings[id]) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const file = path.join(MEETINGS_DIR, `${id}.jsonl`)
      const lastId = parseInt(req.headers['last-event-id'], 10) || 0   // 重连补发 lastId 之后；冷开(0)全量回放（会议短）
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
        for (let i = lastId; i < lines.length; i++) res.write(`id: ${i + 1}\ndata: ${lines[i]}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ type: 'meeting-sync', status: meetings[id].status, speaking: meetings[id].speaking || null })}\n\n`)
      if (!meetingSseClients.has(id)) meetingSseClients.set(id, new Set())
      meetingSseClients.get(id).add(res)
      const hb = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => { clearInterval(hb); meetingSseClients.get(id)?.delete(res) })
      return
    }
    const mreply = p.match(/^\/api\/meetings\/([\w-]+)\/reply$/)
    if (mreply && req.method === 'POST') {
      const id = mreply[1]
      if (!meetings[id]) return json(res, 404, { error: 'meeting not found' })
      const { message } = await readBody(req)
      if (!String(message || '').trim()) return json(res, 400, { error: 'message required' })
      const text = String(message).trim().slice(0, 4000)   // 老板串场：插入纪要，下一位发言者能看到
      appendMeetingEvent(id, { type: 'speech', speaker: '(boss)', displayName: '老板', role: 'boss', text })
      logConversation({ threadRootId: id, fromKind: 'user', from: '(user)', to: '(room)', kind: 'meeting', text, depth: 0 })
      return json(res, 200, { ok: true })
    }
    const mstop = p.match(/^\/api\/meetings\/([\w-]+)\/stop$/)
    if (mstop && req.method === 'POST') {
      const m = meetings[mstop[1]]
      if (m && m.status === 'running') { m.status = 'stopped'; saveMeetings() }   // 编排器在下个发言间隔检查后收尾
      return json(res, 200, { ok: !!m })
    }
    const mdel = p.match(/^\/api\/meetings\/([\w-]+)$/)
    if (mdel && req.method === 'DELETE') {
      const id = mdel[1]; const existed = !!meetings[id]
      if (meetings[id]?.status === 'running') meetings[id].status = 'stopped'
      delete meetings[id]; saveMeetings()
      try { fs.unlinkSync(path.join(MEETINGS_DIR, `${id}.jsonl`)) } catch { }
      broadcast({ type: 'meeting-deleted', meetingId: id })
      return json(res, 200, { ok: existed })
    }

    const reply = p.match(/^\/api\/runs\/([\w-]+)\/reply$/)
    if (reply && req.method === 'POST') {
      const run = runs[reply[1]]
      if (!run) return json(res, 404, { error: 'run not found' })
      // 无 sessionId 通常＝还没起过会话；但「中毒后已弃用 sessionId、正等着换会话重开」也长这样，
      // 那种情况 run 仍是活的/可重开的，不该把老板的话挡在门外（走下面的中毒分支重开）。
      if (run.engineHandoverPending) return json(res, 409, { error: '基座交接尚未完成，请从“更换基座并接手”重试' })
      if (!run.sessionId && !liveRuns.has(run.id) && !run._poisoned && !run.engineHandoverSeed) return json(res, 409, { error: 'no session to resume' })
      const { message, kind, taskFile, takeover } = await readBody(req)
      if (!message?.trim()) return json(res, 400, { error: 'message required' })
      // A feedback answer completes the pending tool in this turn. Enqueueing
      // it as a new prompt would deadlock behind the unanswered request.
      if (!takeover && run._userInput) {
        appendEvent(run.id, { type: 'user-msg', kind: 'chat', text: message.trim() })
        if (!isConsult(run)) logConversation({ threadRootId: run.threadRootId || run.id, fromKind: 'user', from: '(user)', to: run.employee, toRunId: run.id, kind: 'chat', text: message.trim(), depth: run.chainDepth || 0 })
        answerRunInput(run, message)
        return json(res, 200, { ok: true, feedback: true })
      }
      cancelGracePatrol(run, 'user-reply')   // 老板一回话就撤销待派的巡视宽限窗（§3.39 竞态根治：老板正接手，别再抢派巡视）
      // 守航轮里老板回话＝新的授权：目标循环的轮数与「没进展」计数清零（他说「继续」时不该撞上旧的上限）
      if (run.executionMode === 'guarded_run' && !isConsult(run)) guardGoalBossTouched(contractRunNameOf(run), '老板在会话里回话')
      // 只读咨询窗永远走纯对话（它没有派工语义、也不该挂任务档案；前端已隐藏档案选择器，这里再兜一层）
      const msgKind = (!isConsult(run) && kind === 'dispatch') ? 'dispatch' : 'chat'
      const buildPrompt = () => {
        if (msgKind !== 'dispatch') {
          // 猪猪对接块已并入 systemPrompt append（startRun，每会话注入一次、含当前基地址）——聊天消息不再前缀注入，
          // 迷糊/菲斯拉在纯聊天路径同样能从系统提示拿到基地址（不必反问老板），气泡保持干净（2026-08-18，取代 2026-08-13 的前缀补丁）。
          // ⚠ 唯一例外（2026-09-18）：守航 run **还有没做完的条目**时，纯聊天也注入续跑块。
          // 老板拍板/放行最自然的说法就是在会话里敲一句「继续」——那是 chat 不是 dispatch，
          // 此前这条路径零守航上下文，两个字落到一个不记得自己 park 过什么的会话上，只能又收工一次。
          const grc = run.executionMode === 'guarded_run' ? guardedResumeNote(run, { chatOnlyIfPending: true }) : ''
          return `${grc}${message.trim()}`
        }
        const tf = taskFile || run.taskFile
        // 附档案＝同时认领档案的运行环境（原先只记档案、lane 不跟，会话卡上就没有环境）；路径校验不过就照旧只记档案
        if (taskFile && !bindRunToTask(run, taskFile, { by: '老板' }).ok) { run.taskFile = taskFile; saveRegistry() }
        // 守航 run 的续跑（老板拍板/追问那一轮）补一段守航提醒：executionMode 本身不会丢、下游 autoChain 照样
        // 继承，但这一轮 prompt 原先不带任何守航痕迹 → 冷 resume 后容易漂回共驾语气（"老板在线，问一句吧"）。
        const gr = run.executionMode === 'guarded_run' ? guardedResumeNote(run) : ''
        return `【派工】${dispatchPreamble(run.employee, tf, { fromBoss: true })}${gr}${message.trim()}`   // 会话里回话的永远是老板
      }
      // 运行中三岔：① 显式接管 或 卡死 → 硬打断（abort 后由 handleStreamEnd 投递暂存消息 resume 冷起，保留会话上下文，
      //   区别于 stop 的彻底终止）；② query 仍活 → 无感排队追加（SDK 忙完这步 coalesce 进下一轮，不打断、不丢进度，对齐真 CC）；
      //   ③ status=running 但 query 已不活（异常态）→ 回退硬接管。
      if (run.status === 'running') {
        const live = liveRuns.has(run.id)
        const idle = Date.now() - (run._lastActivity || 0)
        const isStalled = run.stalled || (live && idle > STALL_TAKEOVER_MS)
        if (!isConsult(run)) logConversation({                  // 只读咨询窗不上会话看板（同 createDispatchRun）
          threadRootId: run.threadRootId || run.id,
          fromKind: 'user', from: '(user)', to: run.employee, toRunId: run.id,
          kind: msgKind, text: message.trim(), depth: run.chainDepth || 0,
        })
        // ② 无感排队：非接管、非卡死、query 仍活
        if (!takeover && !isStalled && live && run._q && run._input) {
          enqueueTurn(run, buildPrompt(), msgKind, message.trim())
          return json(res, 200, { ok: true, queued: true })
        }
        // ① / ③ 硬打断
        run._takeoverPrompt = { prompt: buildPrompt(), kind: msgKind, userText: message.trim() }
        run._userStopped = true              // 阻止 handleStreamEnd 里的自动续跑与接管抢跑
        appendEvent(run.id, { type: 'lab', text: takeover && !isStalled ? '⚡ 你接管了本轮，正在中断当前动作并投递新指令…' : '🔧 接管卡死会话…' })
        broadcast({ type: 'run-interrupting', runId: run.id, employee: run.employee })   // 通知所有客户端翻中间态 pill
        try { run._abort?.abort() } catch { }
        return json(res, 200, { ok: true, takeover: true })
      }
      if (!isConsult(run)) logConversation({                  // 会话看板：用户在既有会话里的续聊/追加派工（只读窗不记）
        threadRootId: run.threadRootId || run.id,
        fromKind: 'user', from: '(user)', to: run.employee, toRunId: run.id,
        kind: msgKind, text: message.trim(), depth: run.chainDepth || 0,
      })
      // 会话已中毒（空转判定后自动重开额度也用尽）→ 老板这句话不走 resume：换一条干净会话，把它附在交接后面。
      // 这条路是「不可恢复」的最后一道出口——以前这里 resume 坏 transcript，老板点多少次「继续」都只会再空转一轮。
      if (run._poisoned) { reseedPoisoned(run, buildPrompt(), { auto: false, userText: message.trim() }); return json(res, 200, { ok: true, reseeded: true }) }
      sendToRun(run, buildPrompt(), { resume: true, kind: msgKind, userText: message.trim() })   // query 仍活则热推,否则 resume 冷起
      return json(res, 200, { ok: true })
    }

    // 取消巡视宽限窗（「取消接管」按钮）：老板点了「这条我自己接手」→ 撤销待派的小呆呆巡视
    const pcancel = p.match(/^\/api\/runs\/([\w-]+)\/patrol-cancel$/)
    if (pcancel && req.method === 'POST') {
      const run = runs[pcancel[1]]
      if (!run) return json(res, 404, { error: 'run not found' })
      return json(res, 200, { ok: cancelGracePatrol(run, 'user-cancel') })
    }

    // 置顶/取消置顶一条会话：pinned 落库(index.json)，重启仍在；供前端会话选择器把常复用会话（如周报）钉在顶部。
    // pinned 是纯 UI 排序标记——不动 updatedAt（避免误伤巡视裁决签名），也不影响任何调度逻辑。
    const pinRoute = p.match(/^\/api\/runs\/([\w-]+)\/pin$/)
    if (pinRoute && req.method === 'POST') {
      const run = runs[pinRoute[1]]
      if (!run) return json(res, 404, { error: 'run not found' })
      const { pinned } = await readBody(req)
      run.pinned = !!pinned
      saveRegistry()
      broadcast({ type: 'run-pinned', runId: run.id, pinned: run.pinned })   // 其它客户端同步选择器
      return json(res, 200, { ok: true, pinned: run.pinned })
    }

    // 会话改名：{ title } 非空 = 手动命名（titleManual，之后不再被自动命名覆盖）；空串 = 清掉、重新自动生成。
    // 同 pin：纯展示字段，不动 updatedAt。
    const titleRoute = p.match(/^\/api\/runs\/([\w-]+)\/title$/)
    if (titleRoute && req.method === 'POST') {
      const run = runs[titleRoute[1]]
      if (!run) return json(res, 404, { error: 'run not found' })
      const { title } = await readBody(req)
      const t = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
      if (t) {
        run.title = t; run.titleManual = true
        saveRegistry()
        broadcast({ type: 'run-title', runId: run.id, title: t })
      } else {
        run.titleManual = undefined
        generateRunTitle(run, { force: true })
      }
      return json(res, 200, { ok: true, title: t || null })
    }

    // 权限审批回执：canUseTool 挂起的请求由此 resolve（前端审批卡 → allow/deny）
    // 手机审批页（Bark 通知点开落到这里）：展示挂起的审批 + 同意/拒绝按钮，POST 回 /api/runs/:id/permission。
    if (p === '/approve' && req.method === 'GET') {
      const reqId = url.searchParams.get('reqId') || ''
      const entry = pendingPerms.get(reqId)
      const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      // Linear design system 令牌（与 Lab UI 一致）：canvas #010102 · surface 阶梯 · hairline · 单强调 #5e6ad2
      const HEAD = `<meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>
:root{--primary:#5e6ad2;--primary-hover:#828fff;--ink:#f7f8f8;--ink-subtle:#8a8f98;--ink-tertiary:#62666d;--canvas:#010102;--surface-1:#0f1011;--surface-2:#141516;--hairline:#23252a;--hairline-strong:#34343a;--danger:#e5484d}
*{box-sizing:border-box}
body{font-family:"SF Pro Display",-apple-system,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--canvas);color:var(--ink);margin:0;padding:24px 20px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:520px;margin:0 auto}
.card{background:var(--surface-1);border:1px solid var(--hairline);border-radius:12px;padding:22px 20px;box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.eyebrow{font-size:11px;font-weight:500;letter-spacing:.4px;text-transform:uppercase;color:var(--ink-subtle);margin-bottom:10px}
h2{margin:0 0 4px;font-size:20px;font-weight:600;letter-spacing:-.3px}
.tool{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px;color:var(--ink-subtle);margin:14px 0 6px}
pre{white-space:pre-wrap;word-break:break-all;background:var(--surface-2);border:1px solid var(--hairline-strong);border-radius:8px;padding:13px 14px;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;line-height:1.55;color:var(--ink);margin:0;max-height:44vh;overflow:auto}
#btns{display:flex;gap:10px;margin-top:20px}
button{flex:1;min-height:48px;padding:13px;font-size:15px;font-weight:500;border-radius:8px;cursor:pointer;font-family:inherit;transition:background .12s,border-color .12s}
.deny{background:transparent;color:var(--ink);border:1px solid var(--hairline-strong)}
.deny:active{background:rgba(229,72,77,.10);border-color:color-mix(in srgb,var(--danger) 45%,var(--hairline-strong));color:#f2a1a3}
.allow{background:var(--primary);color:#fff;border:1px solid transparent;font-weight:600}
.allow:active{background:var(--primary-hover)}
#msg{text-align:center;margin-top:16px;font-size:13px;color:var(--ink-subtle);min-height:18px}
.center{display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
.center .icon{font-size:44px;margin-bottom:6px}
.center p{color:var(--ink-subtle);font-size:14px;margin:6px 0 0}</style>`
      if (!entry) {
        return res.end(`<!doctype html><html><head>${HEAD}<title>审批</title></head><body><div class=center><div><div class=icon>⌛️</div><h2>该审批已处理或已超时</h2><p>可能已在 Lab 里处理，或已过 5 分钟自动拒绝。</p></div></div></body></html>`)
      }
      const name = EMPLOYEES[entry.employee]?.displayName || entry.employee
      return res.end(`<!doctype html><html><head>${HEAD}<title>审批 · ${esc(name)}</title></head>
<body><div class=wrap>
  <div class=card>
    <div class=eyebrow>望子成龙小学 · 待审批</div>
    <h2>⏸️ ${esc(name)} 请求执行</h2>
    <div class=tool>${esc(entry.toolName)}</div>
    <pre>${esc(entry.brief) || '(无参数)'}</pre>
    <div id=btns>
      <button class=deny onclick="decide('deny')">拒绝</button>
      <button class=allow onclick="decide('allow')">同意执行</button>
    </div>
    <div id=msg></div>
  </div>
</div>
<script>
async function decide(behavior){
  document.getElementById('btns').style.display='none';
  const m=document.getElementById('msg'); m.textContent='提交中…';
  try{
    const r=await fetch('/api/runs/${esc(entry.runId)}/permission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reqId:'${esc(reqId)}',behavior})});
    const j=await r.json();
    m.textContent = r.ok ? (behavior==='allow'?'✅ 已同意，员工继续执行':'🚫 已拒绝') : ('⚠️ '+(j.error||'提交失败，可能已超时'));
  }catch(e){ m.textContent='⚠️ 网络错误：'+e.message; }
}
</script></body></html>`)
    }

    const permApi = p.match(/^\/api\/runs\/([\w-]+)\/permission$/)
    if (permApi && req.method === 'POST') {
      const { reqId, behavior, updatedInput, message } = await readBody(req)
      const entry = pendingPerms.get(reqId)
      if (!entry) return json(res, 404, { error: 'no pending permission (可能已超时/已处理)' })
      entry.resolve(behavior === 'allow'
        ? { behavior: 'allow', ...(updatedInput ? { updatedInput } : {}) }
        : { behavior: 'deny', message: message || '用户拒绝' })
      return json(res, 200, { ok: true })
    }

    const handover = p.match(/^\/api\/runs\/([\w-]+)\/handover$/)
    if (handover && (req.method === 'GET' || req.method === 'POST')) {
      const run = runs[handover[1]]
      if (!run) return json(res, 404, { error: 'run not found' })
      if (req.method === 'GET') return json(res, 200, { engine: engineForRun(run), engines: [...activeEngineList(), ...engines.list().filter(e => e.id === engineForRun(run) && !activeEngineIds().includes(e.id))], summary: handoverSeedFor(run), pending: run.engineHandoverPending || null })
      try { return json(res, 200, await transferRunEngine(run, await readBody(req))) }
      catch (error) { return json(res, error.status || 500, { error: error.message }) }
    }

    const stop = p.match(/^\/api\/runs\/([\w-]+)\/stop$/)
    if (stop && req.method === 'POST') {
      const run = runs[stop[1]]
      if (!run) return json(res, 404, { error: 'run not found' })
      if (run._handoverBusy) return json(res, 409, { error: '正在交接基座，请等待交接结果后再停止' })
      const live = liveRuns.has(stop[1])
      const stoppedStream = run._streamPromise
      run._userStopped = true; run._takeoverPrompt = null     // 用户主动停：handleStreamEnd 里不自动续跑、不接管
      for (const t of run._e2eCancelTokens || []) t.cancelled = true   // 连带取消在跑的 E2E 批次（在跑会话由执行器 POST /cancel，未开跑的跳过）
      run.userStoppedAt = new Date().toISOString()            // 持久标记（过 stripPrivate 落库）：抄送汇合的定时兜底据此不把老板按停的活拉起来；重新跑起来时由 startRun 撤销
      try { run._abort?.abort() } catch { }                   // abort 当前 turn
      try { run._input?.close() } catch { }                   // 关输入通道,彻底收束
      // 强制落终态：正常情况下 abort → consumeStream 结束 → handleStreamEnd 置 interrupted；
      // 但两种情况下流永远不结束、UI 会一直卡在「运行中」、点停止毫无反应：
      //   ① 无活跃 query（服务重启后 liveRuns 空 / 僵尸 run）——根本没有流可结束；
      //   ② query 卡死在一个永不返回的工具子进程里（如前台 `umi dev`）——abort 到不了 await 点。
      // 故：无 query 立即落终态；有 query 给 6s 优雅收尾，仍卡 running 则强制落终态（用户已明确要停，宁可强制）。
      const finalizeStopped = () => {
        if (run.engineHandoverPending || run._streamPromise !== stoppedStream) return // 旧停止计时器不能终结已接手的新会话
        if (run.status !== 'running' && run.status !== 'starting') return  // 已被 handleStreamEnd 正常收尾 → 不重复
        run.status = 'interrupted'; run.activity = ''; run.updatedAt = new Date().toISOString()
        liveRuns.delete(run.id)
        saveRegistry()
        broadcast({ type: 'run-status', runId: run.id, employee: run.employee, status: 'interrupted', resultTail: (run.result || '').slice(-200) })
        maybePushRunStopped(run)
      }
      if (!live) finalizeStopped()
      else setTimeout(finalizeStopped, 6000)
      return json(res, 200, { ok: true, live })
    }

    // 删除单条会话：先停子进程（防孤儿续跑），再抹掉 registry 记录 + jsonl 事件文件（不可恢复）。
    // 动机：会话只增不减，卡死/出错的陈旧会话会把员工徽标永久顶成出错态，需要能清理。
    const del = p.match(/^\/api\/runs\/([\w-]+)$/)
    if (del && req.method === 'DELETE') {
      const id = del[1]
      const run = runs[id]
      if (run?._handoverBusy) return json(res, 409, { error: '正在交接基座，暂不能删除会话' })
      if (run) { run._userStopped = true; try { run._abort?.abort() } catch { }; try { run._input?.close() } catch { } }
      const existed = !!runs[id]
      delete runs[id]
      saveRegistry()
      try { fs.unlinkSync(path.join(RUNS_DIR, `${id}.jsonl`)) } catch { }
      broadcast({ type: 'run-deleted', runId: id })
      return json(res, 200, { ok: existed })
    }

    if (p === '/api/upload' && req.method === 'POST') {   // 聊天粘贴/拖拽/选择：dataURL → uploads/（图片与任意文件通用）
      const { data, name } = await readBody(req, 40e6)
      const m = String(data || '').match(/^data:([^;,]*);base64,(.+)$/)
      if (!m) return json(res, 400, { error: 'expect base64 dataURL' })
      const mime = m[1] || 'application/octet-stream'
      const orig = String(name || '').trim()
      const fromName = orig && path.extname(orig) ? path.extname(orig).slice(1).toLowerCase() : ''
      const ext = (fromName || MIME_EXT[mime] || 'bin').replace(/[^a-z0-9]+/gi, '') || 'bin'
      const fn = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`
      fs.writeFileSync(path.join(UPLOADS_DIR, fn), Buffer.from(m[2], 'base64'))
      // 展示名保留原始文件名（去掉会干扰消息解析的字符）；无原名则用落盘名
      const display = (orig ? path.basename(orig) : fn).replace(/[｜|\r\n]+/g, '_').slice(0, 80)
      return json(res, 200, {
        path: `office-lab/app/uploads/${fn}`, url: `/uploads/${fn}`,
        name: display, kind: mime.startsWith('image/') ? 'image' : 'file', mime,
      })
    }

    // 企微多选复制的图片：剪贴板 HTML 里是 file:///…/WXWork/<账号>/Cache/Image/… 本地路径（明文 png/jpg），
    // 浏览器读不了 file://，由本机服务代读拷进 uploads/。只放行企微图片缓存目录下的图片扩展名，不开放任意路径。
    if (p === '/api/upload-local' && req.method === 'POST') {
      const { path: src } = await readBody(req, 1e5)
      let abs = ''
      try { abs = fs.realpathSync.native(path.resolve(String(src || ''))) } catch { return json(res, 404, { error: '文件不存在（企微可能还没缓存这张图）' }) }
      const ext = path.extname(abs).slice(1).toLowerCase()
      // 另放行企微截图工具落在系统临时目录的 `企业微信截图_<数字>.png/jpg`（自己发的截图不进 Cache/Image）：
      // 必须**直接位于** os.tmpdir() 下（realpath 比对，防 ..\ 与软链）+ 文件名精确匹配，不开放 Temp 里的其它文件。
      let tmpRoot = ''
      // ⚠ 用 realpathSync.native：os.tmpdir() 在本机是 8.3 短名（C:\Users\EXAMPL~1\…），JS 版 realpath 不展开、与剪贴板给的长路径永远对不上
      try { tmpRoot = fs.realpathSync.native(os.tmpdir()) } catch { }
      const isScreenshot = !!tmpRoot && path.dirname(abs).toLowerCase() === tmpRoot.toLowerCase() && /^企业微信截图_\d+\.(png|jpe?g)$/i.test(path.basename(abs))
      const isCache = /[\\/]WXWork[\\/][^\\/]+[\\/]Cache[\\/]Image[\\/]/i.test(abs)
      if (!(isCache || isScreenshot) || !['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext))
        return json(res, 403, { error: '只允许读取企业微信图片缓存 / 企微截图' })
      const st = fs.statSync(abs)
      if (!st.isFile() || st.size === 0 || st.size > 40e6) return json(res, 400, { error: '文件为空或过大' })
      const fn = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ext}`
      fs.copyFileSync(abs, path.join(UPLOADS_DIR, fn))
      const display = path.basename(abs).replace(/[｜|\r\n]+/g, '_').slice(0, 80)
      return json(res, 200, { path: `office-lab/app/uploads/${fn}`, url: `/uploads/${fn}`, name: display, kind: 'image', mime: `image/${ext === 'jpg' ? 'jpeg' : ext}` })
    }

    if (p.startsWith('/uploads/')) {   // 上传图片预览
      const abs = path.join(UPLOADS_DIR, path.normalize(p.slice('/uploads/'.length)))
      if (abs.startsWith(UPLOADS_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile())
        return serveStaticFile(req, res, abs, { immutable: true })   // 文件名含时间戳、内容不变 → 一年强缓存 + 304
      res.writeHead(404); return res.end()
    }

    if (p === '/api/events') {   // 全局 SSE：run-status / tasks-changed + 本连接订阅的会话事件（run-event）
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const clientId = runSubs.attach(res)
      // hello 带 clientId：前端拿它去 /api/events/subscribe 挂会话；收不到 clientId（旧引擎）的前端退回每窗一条连接
      res.write(`data: ${JSON.stringify({ type: 'hello', clientId })}\n\n`)
      globalClients.add(res)
      // 心跳用 data 帧而非 `: ping` 注释：注释前端看不见，没法判活。4700 的 vite 代理在引擎被强杀（ECONNRESET）时
      // 不关浏览器那头，EventSource 一直停在 OPEN 却再也收不到东西（2026-10-16 实测）；前端靠这个 ping 超时自行重连。
      const heartbeat = setInterval(() => res.write('data: {"type":"ping"}\n\n'), 25000)
      req.on('close', () => { clearInterval(heartbeat); globalClients.delete(res); runSubs.detach(clientId) })
      return
    }

    // 会话订阅：把某条 run 的事件挂到全局 SSE 连接上。lastId=0 冷开回放尾窗，>0 严格续传（口径与 /api/runs/:id/events 一致）。
    // 409 = clientId 已失效（连接断了 / 引擎重启过）——前端等新 hello 换了 clientId 会自动重订阅。
    if ((p === '/api/events/subscribe' || p === '/api/events/unsubscribe') && req.method === 'POST') {
      let body; try { body = await readBody(req) } catch { return json(res, 400, { error: 'bad body' }) }
      const clientId = String(body.clientId || ''), runId = String(body.runId || '')
      if (p === '/api/events/unsubscribe') { runSubs.unsubscribe(clientId, runId); return json(res, 200, { ok: true }) }
      if (!runs[runId]) return json(res, 404, { error: 'unknown run' })
      const lastId = parseInt(body.lastId, 10) || 0
      const ok = runSubs.subscribe(clientId, runId, (write) => {
        const file = path.join(RUNS_DIR, `${runId}.jsonl`)
        if (fs.existsSync(file)) {
          const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
          const floor = lastId > 0 ? lastId : floorByMeaningful(lines, lines.length, INITIAL_TAIL_MSGS, INITIAL_TAIL_MAXSCAN)
          for (let i = floor; i < lines.length; i++) write(i + 1, lines[i])
        }
        write(null, JSON.stringify({ type: 'lab-sync', status: runs[runId].status }))
      })
      return ok ? json(res, 200, { ok: true }) : json(res, 409, { error: 'unknown client' })
    }

    const events = p.match(/^\/api\/runs\/([\w-]+)\/events$/)
    if (events) {
      const runId = events[1]
      if (!runs[runId]) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const file = path.join(RUNS_DIR, `${runId}.jsonl`)
      // 断点续传：重连时浏览器自动带 Last-Event-ID，只补发它之后的事件，不再整段历史重放（避免 DOM 翻倍）
      const lastId = parseInt(req.headers['last-event-id'], 10) || 0
      if (fs.existsSync(file)) {
        // 冷开只回放「尾部 INITIAL_TAIL_MSGS 条有意义消息」：首屏少推、隧道下更快；更早历史由前端「加载更早」按钮走 /history 分页拉。
        // SSE id 仍用绝对行号（= appendEvent 的 nextSeq），前端据 m.lastEventId 记「已加载最旧 seq」作分页游标。
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
        // 冷开(lastId=0)→按有意义消息计数取尾窗；重连(lastId>0)→严格补 lastId 之后的全部增量。
        // 重连**不能**再套用尾窗（否则长断线重连会跳过 [lastId, 尾窗起点) 造成 gap 丢事件），必须从 lastId 起严格续。
        const floor = lastId > 0 ? lastId : floorByMeaningful(lines, lines.length, INITIAL_TAIL_MSGS, INITIAL_TAIL_MAXSCAN)   // 从此行号(0-based)起回放；id = i+1
        for (let i = floor; i < lines.length; i++)
          res.write(`id: ${i + 1}\ndata: ${lines[i]}\n\n`)
      }
      res.write(`data: ${JSON.stringify({ type: 'lab-sync', status: runs[runId].status })}\n\n`)
      if (!sseClients.has(runId)) sseClients.set(runId, new Set())
      sseClients.get(runId).add(res)
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => { clearInterval(heartbeat); sseClients.get(runId)?.delete(res) })
      return
    }

    // 历史分页：SSE 冷开只给尾部若干条有意义消息，前端「加载更早」按钮往前翻页走这里。
    // before = 已加载的最旧 seq(1-based 行号)；limit = 本页要凑够的「有意义消息」条数（非原始行数）。
    // 返回 [start, before-1] 全部原始事件（工具/子代理噪声照收以正确成形），但 start 落在第 limit 条消息处。
    const history = p.match(/^\/api\/runs\/([\w-]+)\/history$/)
    if (history && req.method === 'GET') {
      const runId = history[1]
      if (!runs[runId]) return json(res, 404, { error: 'unknown run' })
      const before = parseInt(url.searchParams.get('before'), 10) || 0
      const count = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 25))   // 「有意义消息」条数
      const file = path.join(RUNS_DIR, `${runId}.jsonl`)
      let lines = []
      try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()) } catch { }
      const hi = before > 0 ? Math.min(before - 1, lines.length) : lines.length   // 取 seq < before 的部分（1-based 含上界 = 0-based exclusive）
      const start = floorByMeaningful(lines, hi, count, HISTORY_MAXSCAN) + 1        // 1-based 起始 seq，落在第 count 条消息处
      const events = []
      for (let seq = start; seq <= hi; seq++) {                                    // seq 即行号；行数组 0-based = seq-1
        try { events.push({ ...JSON.parse(lines[seq - 1]), _seq: seq }) } catch { }   // 坏行跳过
      }
      return json(res, 200, { events, hasMore: start > 1 })
    }

    // Serve the built workbench and its hashed assets on the same origin as the API.
    const webIndex = path.join(WEB_DIR, 'index.html')
    if ((p === '/' || p === '/chat') && fs.existsSync(webIndex))
      return sendDynamicText(req, res, fs.readFileSync(webIndex, 'utf8'), MIME['.html'])
    if (p.startsWith('/assets/')) {
      const built = path.resolve(WEB_DIR, '.' + p)
      if (built.startsWith(path.join(WEB_DIR, 'assets') + path.sep)) {
        return serveStaticFile(req, res, built, { immutable: true })
      }
    }
    // ---- 静态文件 ----
    let file = p === '/' ? '/index.html' : p
    const abs = path.join(PUBLIC_DIR, path.normalize(file))
    if (abs.startsWith(PUBLIC_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      // index.html：按 style.css / app.js 的 mtime 注入版本号，改文件即自动刷缓存（无需手动 bump）；
      // 自身标 no-cache，保证手机每次都重读版本指针，从而拉到最新资源。
      if (abs === path.join(PUBLIC_DIR, 'index.html')) {
        const ver = f => { try { return Math.floor(fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs) } catch { return Date.now() } }
        const html = fs.readFileSync(abs, 'utf8')
          .replace('href="style.css"', `href="style.css?v=${ver('style.css')}"`)
          .replace('src="cards.js"', `src="cards.js?v=${ver('cards.js')}"`)
          .replace('src="app.js"', `src="app.js?v=${ver('app.js')}"`)
        return sendDynamicText(req, res, html, MIME['.html'])   // no-cache + gzip/br；版本号已注入到 ?v=
      }
      // 带 ?v= 的版本化请求（style.css/cards.js/app.js 由 index.html 注入）→ 一年 immutable；其余（头像/logo/vendor）→ 一天 + 304 协商。文本资源自动 br/gzip。
      return serveStaticFile(req, res, abs, { immutable: url.searchParams.has('v') })
    }
    res.writeHead(404); res.end('not found')
  } catch (e) {
    console.error('[http] 处理异常:', e?.message || e)
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) })   // 已发头则不二次写(否则 ERR_HTTP_HEADERS_SENT 崩进程)
    else { try { res.end() } catch { } }
  }
})

// 连接超时调优：让异常悬挂/半开的 keep-alive 连接被快速回收，而不是拖到默认 5min——
// 否则服务异常重启后，浏览器那侧的旧连接会占满「HTTP/1.1 每域名 6 连接」上限，导致所有新 fetch 永久 pending。
server.keepAliveTimeout = 15_000   // 空闲 keep-alive 15s 关（默认 5s，略放宽避免正常复用被误杀）
server.headersTimeout = 20_000     // 连上后 20s 内没发完请求头 → 关（回收半开连接）
server.requestTimeout = 60_000     // 单请求整体 60s 上限（SSE 是长连接、不受此限：SSE 不结束请求体、走的是响应流）
// 启动期致命错误必须显式退出，别让 uncaughtException 兜底把它吞掉后赖着不走。
// 病根（2026-07-28 排查）：端口被占（EADDRINUSE）时 listen 抛错，却被下方 process.on('uncaughtException')
// 静默接住 → 进程绑不上端口也不死，只剩 fs.watch + sweepStalled interval 空转 = 僵尸。反复「重启」不杀旧进程，
// 每次都新起一个绑不上端口的僵尸，越堆越多（现场一次抓到 5 个）。加 'error' 监听后 EADDRINUSE 走这里、不再落到
// uncaughtException，直接退出，把「谁在服务」收敛回唯一一个真正占端口的实例。
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`[fatal] 端口 ${PORT} 已被占用——已有 office-lab 实例在跑。本次不再启动，直接退出（避免堆积绑不上端口的僵尸进程）。`)
  } else {
    console.error('[fatal] HTTP server 错误，退出：', e?.message || e)
  }
  process.exit(1)
})
server.listen(PORT, HOST, () => {
  console.log(`🏢 望子成龙小学: http://127.0.0.1:${PORT}  (bind ${HOST}:${PORT})`)
  console.log(`   ${describeWorkspace()}`)   // 部署形态：排查路径问题的第一现场（见 paths.js）
  // 企微渠道 sidecar：开关开且凭证齐才拉起（缺 SDK 时 sidecar 会退出，状态见 /api/wecom-status）
  if (wecomShouldRun()) { console.log('[wecom] 配置已启用，拉起企微渠道 sidecar'); spawnWecomSidecar() }
  refreshUiContract('boot', { force: true })   // 开机建立/刷新 UI 状态契约基线（异步，不挡启动；覆盖「老板自己改了前端」的情况）
  refreshZhuzhuHealth('boot', { force: true }) // 开机探一次猪猪 base（异步，不挡启动）：漂移要在第一次派工前就暴露，见 §3.106
  armMirrorSync()   // 企微镜像：启用则布定时同步（飞书主表 → 企微 Webhook 只读投影）
  if (wecomMirrorConfig.enabled) console.log(`[wecom-mirror] 已启用，每 ${Math.max(1, Math.floor(Number(wecomMirrorConfig.syncMin) || 3))} 分钟同步一次`)
  // 守航会话先接回（它们带着上下文），再排空队列——同工作区同员工已被接回占住时，队列里的活会等它收工后合并投递
  resumeInterruptedAfterBoot()
  // 待处理队列：重启后全员空闲，逐员工排空一条（其余由该会话收工后链式 drain）
  for (const emp of Object.keys(pendingQueues)) if (pendingQueues[emp]?.length) drainPending(emp)
  sweepCcJoins()   // 抄送汇合兜底扫一遍：捞「重启前子 run 已收工、发起人还没被唤回」的遗留扇出（放 listen 回调里，与 drainPending 同期）
})

// ---------- 引擎重启后，自动接回被打断的会话（2026-09-30 事故驱动，2026-10-06 扩到共驾 + 正常关停）----------
// 00:43 整机内存耗尽，引擎被系统掐死，托盘 1 秒后拉起新进程——但两条守航会话停在 interrupted，目标循环按 v0.11.0 审查
// 的口径把 interrupted 判「暂停、等老板」，于是一整夜没人接。守航的意义就是老板不在，基础设施的一次倒下不该让整晚停摆。
// 2026-10-06 老板拍板扩面：① 共驾会话也接（lab 半夜倒下时老板同样不在，原先「共驾照旧等老板」等于整晚停摆）；
// ② 正常关停（托盘「重启」、卡死后接管重启）打断的也接——原先只认崩溃，走优雅退出的反而接不回。
// 边界：有 sessionId、老板没按过停、非只读窗、非巡视 run（巡视有自己的定时兜底扫，别重复）；**接回原会话**（带上下文 + 进度快照），
// 不另起新会话；每条最多自动接 N 次（持久计数，N = chainConfig.bootResumeMax，设置页可改，默认 10），再倒就停下交老板——防「一跑就崩、崩了又接」的死循环。
// 指数退避（chainConfig.bootResumeBackoff，默认开）：第 1 次立即接，之后每次接回前先等 30s·2^(n-2)（30s/1m/2m/4m…，封顶 30 分钟），
// 给机器喘口气——上限放到 10 次后，若每次都是它跑的东西把机器拖垮，不退避就是 10 次连环崩。等待期间若引擎又停了，下次启动接着排（不多算次数）。
// 守航：契约未过期即接；共驾：只接最近 2 小时内被打断的——lab 停了很久再开，多半是老板有意关的，别把旧活翻出来。
const BOOT_RESUME_COPILOT_WINDOW_MS = 2 * 3600 * 1000
const BOOT_RESUME_BACKOFF_BASE_MS = 30 * 1000
const BOOT_RESUME_BACKOFF_CAP_MS = 30 * 60 * 1000
const bootResumeMax = () => { const n = Number(chainConfig.bootResumeMax); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 10 }
const bootResumeDelayMs = attempt => (chainConfig.bootResumeBackoff === false || attempt <= 1) ? 0 : Math.min(BOOT_RESUME_BACKOFF_CAP_MS, BOOT_RESUME_BACKOFF_BASE_MS * 2 ** (attempt - 2))
const fmtDelay = ms => ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`
// 这条被打断的会话现在还该不该接（启动时判一次；退避到点后再判一次——等待期间老板可能已手动接手/按了停/契约过期）
function bootResumeEligible(r) {
  if (r.engineHandoverPending) return false
  if (!r || !r.sessionId || r.userStoppedAt || isConsult(r) || r.patrolTarget) return false
  if (r.executionMode === 'guarded_run' && !!r.guardContract) {
    const c = loadGuardContract(r.guardContract)
    const dl = Date.parse(String(c?.contract?.deadline || '').replace(' ', 'T'))
    return !!c && !(Number.isFinite(dl) && Date.now() > dl)
  }
  return true
}
function resumeInterruptedAfterBoot() {
  if (process.env.OFFICE_LAB_BOOT_RESUME === '0' || chainConfig.enabled === false) return
  for (const { id, how } of _bootInterrupted) {
    const r = runs[id]
    if (!bootResumeEligible(r)) continue
    const guarded = r.executionMode === 'guarded_run' && !!r.guardContract
    if (!guarded && Date.now() - (Date.parse(r.updatedAt || '') || 0) > BOOT_RESUME_COPILOT_WINDOW_MS) continue
    const label = guarded ? '守航会话' : '会话'
    const cause = how === 'shutdown' ? '被重启（正常关停）' : '非正常退出（崩溃或被系统强制结束）'
    const max = bootResumeMax()
    if ((r.bootResumes || 0) >= max) { appendEvent(r.id, { type: 'lab', text: max === 0 ? `⛔ 引擎${cause}打断了这条${label}；自动接回已关闭（设置里次数上限为 0），等老板接手。` : `⛔ 引擎又一次${cause}打断了这条${label}，已自动接回过 ${r.bootResumes} 次——不再自动接，等老板看一眼（可能是它跑的东西把机器拖垮了）。` }); continue }
    const delay = bootResumeDelayMs((r.bootResumes || 0) + 1)
    if (delay <= 0) { doBootResume(r, how, label, cause); continue }
    r.bootResumePending = how   // 持久记号：等待期间引擎再停，下次启动据此接着排
    appendEvent(r.id, { type: 'lab', text: `⏳ 引擎${cause}打断了这条${label}；已接回过 ${r.bootResumes || 0} 次，按指数退避等 ${fmtDelay(delay)} 后再自动接回（期间你直接回话即可手动接手）。` })
    setTimeout(() => {
      const cur = runs[id]
      if (!cur || !cur.bootResumePending) return
      cur.bootResumePending = undefined
      // 等待期间已被接手（老板回话 / 巡视续跑会把状态改走）、按了停、契约过期，或接回已被关掉：都不再接
      if (cur.status !== 'interrupted' || !bootResumeEligible(cur) || chainConfig.enabled === false || (cur.bootResumes || 0) >= bootResumeMax()) { saveRegistry(); return }
      doBootResume(cur, how, label, cause)
      saveRegistry()
    }, delay).unref?.()
  }
  saveRegistry()
}
function doBootResume(r, how, label, cause) {
  if (busyRunFor(r.employee, laneKeyOf(r))) return   // 同员工同工作区已被前面一条接回占住：这条留给老板/巡视，不并发改同一工作树
  const guarded = r.executionMode === 'guarded_run' && !!r.guardContract
  const max = bootResumeMax()
  r.bootResumes = (r.bootResumes || 0) + 1
  const snap = stallGuard.renderResumeSnapshot(r._snapshots || (r.lastSnapshot ? [r.lastSnapshot] : []))
  const verify = guarded ? '先用覆盖矩阵 / 最新 session 结果 / git 状态核对打断前做到了哪' : '先用任务档案 / 实施记录 / git 状态核对打断前做到了哪'
  const msg = `【引擎重启后自动接回】lab 引擎刚才${cause}，把你这条${label}打断了；这是第 ${r.bootResumes}/${max} 次自动接回。**接着上次进度往下做，不要从头重来**——${verify}（半截的改动先看清再决定保留还是重做），已经做完/已经绿的别重跑。

${snap}${guarded ? guardedResumeNote(r) : ''}`
  appendEvent(r.id, { type: 'lab', text: `🔁 引擎重启后自动接回这条${label}（第 ${r.bootResumes}/${max} 次）。` })
  try { sendToRun(r, msg, { resume: true, kind: 'dispatch' }) } catch (e) { console.warn('[boot-resume] 接回失败', r.id, e.message) }
}

// ---------- 优雅退出：重启/kill 前关闭所有活跃 query，避免孤儿子进程 ----------
// 病根（2026-07-14 ggbond 两条 run 现身）：直接 pkill server 会把在跑 run 打成 interrupted，
// 但底层 claude 子进程不受影响、变孤儿继续跑（跑完也不触发 autoChain、白烧 token、状态还骗人）。
// SIGTERM/SIGINT 时统一收尾：落 interrupted 状态 + abort/close 每个活跃 query（SDK 会清理其 CLI 子进程）。
let shuttingDown = false
function gracefulShutdown(sig) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[shutdown] 收到 ${sig}，正在终止 ${liveRuns.size} 个活跃员工会话…`)
  try { stopWecomSidecar() } catch { }   // 随 server 一并关停企微渠道 sidecar，避免孤儿进程
  try { stopAllPersonaSessions() } catch { }   // 关停所有企微主人格会话
  try { if (_mirrorTimer) clearInterval(_mirrorTimer) } catch { }   // 停企微镜像定时器
  for (const [runId, run] of liveRuns) {
    // 只有真在干活的才落 interrupted + 打「关停打断」持久记号（下次启动据此自动接回）；已收工、只是 query 还没空闲关闭的保持 done，
    // 否则一次重启会把所有闲着的会话都标成「被中断」、守航目标循环也会误判成被打断而暂停。
    if (run && (run.status === 'running' || run.status === 'starting')) { run.status = 'interrupted'; run.shutdownInterruptedAt = new Date().toISOString(); run.activity = ''; run.updatedAt = new Date().toISOString() }
    try { run._abort?.abort() } catch { }
    try { run._q?.close() } catch { }
  }
  try { saveRegistry() } catch { }
  // 干净斩断所有 HTTP 连接（含 SSE 长连），让浏览器立刻感知断开、重连新进程——
  // 避免旧 socket 悬挂占满浏览器连接池导致新页面一直 pending（今天那次事故的根因）。
  try { server.closeIdleConnections?.(); server.closeAllConnections?.() } catch { }
  try { server.close() } catch { }
  setTimeout(() => process.exit(0), 1000)
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
// 韧性兜底：单条 run 的异步异常不该拖垮整个办公室（对齐 watchdog/自动续跑的容错取向），仅记录不退出。
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e))
process.on('uncaughtException', e => console.error('[uncaughtException]', e?.message || e))
