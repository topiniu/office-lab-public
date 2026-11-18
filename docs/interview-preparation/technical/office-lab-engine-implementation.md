# office-lab 引擎技术实现剖析

> **基线**：`app/package.json` **0.10.0** · `server.js` **8770 行** + 16 个纯函数模块（4012 行）· 单测 **449/449**（631ms）· 核对日期 **2026-08-31**。
> **读法**：本文按「从一条消息进来到落盘/接棒/告警」的顺序讲实现，每节末尾标出**残留面**。机制取舍的权威记录在 [`../../tech/**`](../../tech/)，本文不重复其正文，只补「代码上到底怎么长的」。

---

## 目录

1. [代码地图与依赖姿态](#1-代码地图与依赖姿态)
2. [路径根：L / P / R 三层语义](#2-路径根l--p--r-三层语义)
3. [会话生命周期](#3-会话生命周期)
4. [提示装配：一次派工到底注入了什么](#4-提示装配一次派工到底注入了什么)
5. [事件归一与落盘](#5-事件归一与落盘)
6. [收工判定：从 result 到红绿灯](#6-收工判定从-result-到红绿灯)
7. [编排：四标记 + 抄送 + 服务端守卫](#7-编排四标记--抄送--服务端守卫)
8. [三层正交监督](#8-三层正交监督)
9. [权限模型](#9-权限模型)
10. [MCP 工具目录（按角色）](#10-mcp-工具目录按角色)
11. [质量门禁：覆盖率闸门与 linter](#11-质量门禁覆盖率闸门与-linter)
12. [守航态（无人值守）](#12-守航态无人值守)
13. [渠道层](#13-渠道层)
14. [HTTP / SSE 层与性能收口](#14-http--sse-层与性能收口)
15. [前端两套实现](#15-前端两套实现)
16. [部署、托盘与首启](#16-部署托盘与首启)
17. [测试策略](#17-测试策略)
18. [当前技术债清单](#18-当前技术债清单)

---

## 1. 代码地图与依赖姿态

```
office-lab/
├─ app/
│  ├─ server.js                 8770  引擎主体（ESM，import 即 listen）
│  ├─ coverage.js                470  facet 覆盖 / 机器证据 / linter / validateArchive
│  ├─ morning-report.js          412  轮次级晨检包装配（降级留用）
│  ├─ version-report.js          385  版本级验收单（以登记表为行集）
│  ├─ requirement-pool.js        357  就绪池排序 / park 台账分家 / reconcilePark
│  ├─ zhuzhu-capabilities.js     332  外部平台能力探活 / fail-closed 第三态 / RED 分类
│  ├─ guard-ledger.js            332  守航三红灯台账
│  ├─ e2e-batch.js               294  并发 E2E 批次 + repair-context 摘要
│  ├─ qa-report-card.js          234  QA 报告卡机器校验
│  ├─ release-chain.js           215  发布链七环对账 + 部署清单三点 diff
│  ├─ handoff-freeze.js          197  交接前冻结 / impact_radar / worktreePlan
│  ├─ stall-guard.js             178  收工即校验 validateSignoff
│  ├─ paths.js                   148  ★ 路径根唯一事实源（L/P/R 三层）
│  ├─ audit-trust.js             145  假绿猎手 / intake 误判审计
│  ├─ gate-matrix.js             139  门禁矩阵 + classifyRisk
│  ├─ ui-contract.js             119  UI 状态契约刷新 + diff
│  ├─ entry-status.js             55  条目状态词汇收敛
│  ├─ employees.json                  6 个角色定义
│  ├─ public/                   7381  旧 UI（vanilla，已入库免构建）
│  ├─ test/                           20 个测试文件 / 449 例
│  ├─ hooks/                          block-employee-subagent.mjs（PreToolUse 硬拦）
│  ├─ wecom_sidecar/             748  Python 企微长连接哑管道（自带 venv）
│  └─ runs/                            运行态（gitignore）
├─ web/                        14159  新 UI（React 19 + Vite 8 + Tailwind 4 + Radix + GSAP，91 文件）
├─ tray/office-lab-tray.ps1     1066  Windows 托盘（引擎 + web 双端口托管）
├─ scripts/bootstrap.mjs               跨平台一条命令首启（零依赖）
├─ roles/ memories/ templates/ tasks/  协作产物（2289 行 SOP + 76 份任务档案）
└─ docs/tech/                   3532  九本主题复盘分册
```

**依赖姿态（刻意）**：

| 层 | npm 依赖 | 理由 |
|---|---|---|
| 引擎 | **只有 2 个**：`@anthropic-ai/claude-agent-sdk@^0.3.214`、`zod@^4.4.3` | 「除 SDK 外零依赖」是立身之本：HTTP、压缩、ETag、zip 解析、图片处理全自己写或用 Node 内置 |
| 旧 UI | 0（只有 vendored `marked.min.js`） | 免构建、已入库 → 降级链末端 |
| 新 UI | 完整依赖树（React/Vite/Tailwind/Radix/GSAP） | 主力界面，需 Node ≥20.19 + pnpm |
| sidecar | Python `wecom-aibot-python-sdk`（自带 venv） | 官方长连接 SDK 只有 Python；**进程边界即语言边界** |
| 托盘 | 0（PowerShell + WinForms 系统自带 + vendored WebView2 SDK DLL ~1MB） | 零额外运行时 |

**为什么手写了这些轮子**（每个都有具体理由，不是 NIH）：

- **zip 解析**（`extractImages*`）：zip 不是 gzip，Node 内置 `zlib` 只能 inflate 单条 deflate 流、读不了 zip 容器。手写极简解析：尾部扫 EOCD → 遍历中央目录 → STORE(0) 切片 / DEFLATE(8) 走 `inflateRawSync`。**关键细节：压缩大小从中央目录读**，这样 Windows `Compress-Archive` 用 data-descriptor（本地头 size=0）时也拿得到正确长度。解析失败**优雅降级**为「改用文件夹路径入口」。
- **头像缩图**：机器无 ImageMagick/sharp/cwebp，而引擎有零依赖约束 → 用 Windows 自带 `System.Drawing`（PowerShell 脚本）。
- **YAML 子集解析**（`parseFrontmatter`）：只覆盖标量/布尔/一层嵌套/字符串数组。**这是已知短板**——档案格式一旦超出子集会静默解析错。
- **br/gzip 压缩 + ETag**：Node 内置 `zlib` + `crypto`，按 `abs+mtime` / `sha1(body)` 缓存。

---

## 2. 路径根：L / P / R 三层语义

`app/paths.js` 是**路径的唯一事实源**，改任何路径相关的东西必须先读它顶部注释。它解决的是一个真实的越权面：`server.js` 原本写 `const ROOT = path.resolve(__dirname, '..', '..')`（office-lab 的**父目录**），而这个 `ROOT` 不只用来拼路径——**它是员工 agent 的 `cwd`**，而员工多为 `acceptEdits`/`bypassPermissions`。独立 clone 到 `~/dev/office-lab` 后 `ROOT` 就是 `~/dev`，工作树逃到了仓库外。

### 2.1 三层

| 层 | 是什么 | 处置 |
|---|---|---|
| **L** 逻辑/协议 | `office-lab/…` 前缀。落库、`/api/tasks` 的 `file`、`/api/upload` 的 `path`、存量档案、旧 UI 正则 | **冻结，一律不改** |
| **P** 物理 | agent 用原生 Read/Write/Bash 时相对 `cwd` 的真路径 | 只在**出栈给 agent 那一刻**由 `toAgentPath()` 改写一次 |
| **R** 解析器 | 引擎自己读写文件 | `repoCandidates()` 三候选双向容忍 |

**为什么 `office-lab/` 前缀不能"顺手统一成物理路径"**——这是本节最重要的判断：

- 旧 UI 把它**写死在正则里**（`REPO_MD_SRC` 只认 `office-lab/(tasks|templates|roles|docs|memories)/…`，截图内联只认 `office-lab/app/uploads/…`），而旧 UI 恰恰是**已入库、免构建、「总能跑起来」的兜底主路径**。
- 存量数据全带它：`runs/index.json` 里 **406 条 `taskFile` 首段 100% 是 `office-lab`**；`tasks/` 下 53 个档案共 136 处引用。

> **判据沉淀**：判断一个东西是不是契约，标准不是「它长得像不像契约」，而是「**有没有别人按它的形状写了代码 / 存了数据**」。

### 2.2 L→P 只有三个咽喉

一个都不能漏、也一个都不必多：

1. `makeInputChannel().push` —— 吃掉全部入栈文本（派工头、任务快照、同事近况、抄送与接棒消息、上传标记）
2. `startRun` 拼完的 `roleText` —— systemPrompt 不走 push
3. 会议 `speakOnce` 的裸字符串 `prompt`

**关键顺序**：`appendEvent` 在 `push` **之前**落库 → 落库与前端拿到的永远是 L 形式，旧 UI 正则继续成立。

### 2.3 R 层候选序与形态探测

```
① 工作区相对（嵌套模式下 office-lab/tasks/x.md 直接命中 = 原行为）
② 仓内相对（tasks/x.md、roles/…）
③ 剥前缀后仓内相对（独立模式下 406 条存量靠这条命中，零迁移）
```

**形态探测用标志物、不用「父目录有没有 .git」**：判据是 `backend` / `frontend` / `manage-backend.sh` 三者之一存在。理由是它们本就是 `CODE_ROOTS` 与 `MANAGE_BACKEND_SH` 的**定义性事实**——判据与「`ROOT` 到底给谁用」同源，不会出现「判成嵌套但兄弟仓其实不在」的中间态。逃生阀：`OFFICE_LAB_WORKSPACE_ROOT`。

**核心安全属性写成了断言**：嵌套且目录同名时 `OFFICE_PREFIX === OFFICE_URI_PREFIX`，`toAgentPath` **恒等** → 原机器行为一字不变（`app/test/paths.test.js`，19 例）。并且用「生产实例跑的正是改动前的代码」做过逐字段 diff 佐证。

**`safeResolve` 的 `..` 拒绝语义刻意保持不变**：候选各自按其基准根限界（工作区候选按工作区根、仓内候选按仓根）。否则 `../secret` 会经「`OFFICE_ROOT/../secret`」落进工作区根、由抛错变成可读。有正反用例钉着。

**残留面**：`parseFrontmatter` 的 YAML 子集仍脆弱；三个咽喉靠注释与测试保证，将来新增入栈路径若忘了改写就会静默出错（没有机器检查）。

---

## 3. 会话生命周期

### 3.1 三个私有句柄

每个活跃 run 在 `liveRuns` Map 里持有：

| 字段 | 是什么 |
|---|---|
| `_q` | 长活的 SDK `query()` |
| `_input` | promise 队列实现的 async generator 输入通道（`makeInputChannel`） |
| `_abort` | AbortController |

`_` 前缀字段经 `stripPrivate` **不落库**（`saveRegistry` 的 replacer：`k.charCodeAt(0)===95 ? undefined : v`）。设计本意是「进程内句柄重启本就作废」，但**这条设计曾误杀裁决状态**（`_patrolClosed`/`_patrolNudges`/`_patrolSweptAt` 被一起抹掉 → 每次重启升级锁、续跑计数、巡逻冷却全部归零 → 同一会话被巡 7 次）。教训沉淀为：**裁决/去重/节流/计数类状态命名上就别用 `_` 前缀**。现在的持久字段清单（非 `_` 前缀）：`patrolClearedSig`、`patrolGraceUntil`、`handoffBlockedSig`、`qaHollowStopSig`/`qaHollowStopWhy`、`auditClearedSig`、`patrolTarget`、`entryNo`、`executionMode`、`guardContract`、`lastSnapshot`。

### 3.2 状态机

```
createDispatchRun ──► startRun ──► consumeStream ──┬─► result（一轮收工）
                        │                          │      └─► onTurnComplete
   （resume 冷起走      │                          │            ├─ isSpunTurn？
    options.resume）    │                          │            ├─ signoffRejectIfNeeded（≤2 次）
                        │                          │            ├─ 门禁（QA 闸门 / 发布四件）
                        │                          │            ├─ autoChain（接棒/回发/停门/巡视）
                        │                          │            ├─ appendLessons
                        │                          │            └─ maybePushRunStopped
                        │                          │      ★ query 不关
                        │                          └─► 流结束/abort ─► handleStreamEnd 三分支
                        │                                              ① 用户强制接管（僵尸 run 暂存消息优先投递）
                        │                                              ② shouldAutoRetry → resume 续跑
                        │                                              ③ 终态（用户停=interrupted / 其余=error）
                        │                                                 末尾：!busyRunFor → drainPending
                        ▼
              空闲 IDLE_CLOSE_MS(180s) ─► _input.close()（有后台任务则跳过）
```

### 3.3 续轮的两条路

`sendToRun` 判断：

- **query 仍活** → `pushTurn` **热推**（prompt 缓存热）
- **已 close** → `resume` 冷起（`options.resume = sessionId`，SDK 自己存的 transcript）

**取舍数字**：`IDLE_CLOSE_MS = 180_000`（3 分钟）**刻意卡在 <5min 的 prompt 缓存 TTL 内**——留窗口内多轮享缓存，超窗才释放子进程省资源。

### 3.4 运行中的输入：三岔

`/api/runs/:id/reply` 在 run 还在跑时：

| 分支 | 条件 | 动作 |
|---|---|---|
| ① 硬打断 | 显式 `takeover` 或已卡死 | `_abort.abort()` → `handleStreamEnd` 冷续跑 |
| ② **无感排队** | 非接管、非卡死、query 仍活 | `enqueueTurn`：立即 append `user-msg`（带 `queued` 标记回显）、`_input.push`、广播 `run-queued`；**status 不动**，等 SDK 真开跑时 `consumeStream` 见 assistant 消息自然把 status 顶回 running |
| ③ 回退硬接管 | status=running 但 query 已不活（异常） | 同 ① |

**`enqueueTurn` 刻意不走 `beginTurn`**（关键取舍）：`beginTurn` 会重置 `_turnText`/`_turnActive`/`_ccThisTurn`/`_turnMsgs`/`_sdkNudges`——那是**当前正在跑的那一轮**的状态，mid-turn 翻新会污染它、误判空收工/抄送计数。

> **通用教训**：mid-turn 改状态先问「这动的是哪一轮的账」——同名操作在不同时机语义不同。

**为什么接管不用 SDK 原生 `q.interrupt()`**：它更优雅（停在下个工具边界、会话保温、不冷起子进程），但要重构 `handleStreamEnd` 的三分支（接管/自动续跑/终态都挂在「abort→consumeStream 抛错→统一收尾」上），生命周期风险大。当时只补了中间态 UI（点接管后输入框文字保留 + pill 翻「正在停止…准备插入」，直到真正投递的 `user-msg` SSE 到达才清空），`interrupt()` 留作后续。

> **通用教训**：底层框架给的能力，别被上层一刀切的「求稳」策略永久埋掉。`/reply` 运行中一律 409 当初是为治「自动续跑翻车」，却顺手把无关的「排队追加」也挡了——**治具体病别下过宽的禁令，留一条「正常路径」的活口**。而且**占位符/文案是契约的一部分**：写着「Enter 是排队追问」却返回 409，比不写更误导。

### 3.5 三种非流水线会话

| 类型 | 复用什么 | 不复用什么 | 判据 |
|---|---|---|---|
| **只读咨询窗** `consult` | 完整 run 骨架（流式 transcript / 附件 / OLCards / 历史翻页 / SSE 断点续传 / `/reply` 无感排队） | 7 处守卫全在函数入口一行 `if (isConsult(run))`：`autoChain` 首行 return、`patrolEligible` false、`supersededBy` 不参与、`appendLessons`/`maybePushRunStopped`/`releaseCopyCardMissing` 跳过、`logConversation` 三处不记、`busyRunFor`/忙闲派生/`buildTeamPulse` 一律排除 | 复用面大、特判少且集中 → **复用骨架** |
| **会议室** `runMeeting` | 只复用「原语」：`buildRolePrompt`（工牌人格）、`resolveModel`、`logConversation({kind:'meeting'})`、`nextSeq`+jsonl+SSE、OLCards 协议、前端渲染件 | 整条 run 生命周期脊柱与四标记解析——**query 完全不进 `runs`/`liveRuns` 注册表**，所以 autoChain/watchdog/巡视/审计根本看不到它 | 语义正交（会议发言里出现「下一棒把这条交给 ggbond」是自然语言，走 autoChain 会被误解析成真派工）→ **另起旁路** |
| **企微人格** `personaSessions` | `makeInputChannel` + 消费流 | 全部看板语义（任务快照、autoChain、appendLessons、标记解析）；`systemPrompt` 用纯字符串而非 `claude_code` 预设 → 没有 coding 工具；`allowedTools` 只白名单少量 MCP + deny 写/Bash | 企微对话明确不是正式工作 → **另起精简运行时** |

> **判据升级（§3.79 对 §3.60 的修正）**：「另起旁路 vs 复用骨架」取决于**复用面的大小与特判的分布**——特判少且集中（守卫都在入口）就复用；特判会散进业务分支、或复用面只有一两个原语，就另起旁路。**别把「宁可另起旁路」当无条件教条。**

**会议室的两条硬闸值得单记**：① blanket 写工具 deny 用**裸工具名**（`Write/Edit/MultiEdit/NotebookEdit` = 整工具禁，跨平台可靠，不踩 `codeLockDeny` 那种 `./x/**` 的 Windows 路径 glob 坑）；② 会后纪要**由引擎写盘而非 agent**——既留可追溯产物，又不破坏「会议 agent 全程只读」的不变量。同时**刻意不**把改进项灌进 `memories/*.md`（那是正式流水线 `【教训】` 的地盘，一场复盘会不该自动往权威教训库塞条目）。

**残留面**：`liveRuns`/`pendingPerms` 全在内存，重启丢活跃 query（run 置 interrupted 可续跑兜底，但审批挂起态会丢）；只读窗读到的是**中间态文件**（「边改边问」的固有属性，不是 bug）。

---

## 4. 提示装配：一次派工到底注入了什么

`buildRolePrompt(employee)` + `dispatchPreamble()` 拼出的东西，按注入顺序：

### 4.1 systemPrompt 侧（`buildRolePrompt`）

1. **工牌全文** `.claude/agents/<emp>.md`（`resolveEmpFile` 优先仓库内副本 → 回退顶层 → 兜底 `roles/*.md`）
   > 「开箱即用」那一版修的正是这条：原读 monorepo 顶层**未入库**的 `.claude/agents/*.md`，独立 checkout 时 ENOENT 令所有员工无法启动。
2. **`CARD_OUTPUT_MANDATE`** —— 消息卡片硬格式。**落点选「引擎统一注入」而非「改六份 SOP」**：单一事实源 + 更难被临时手写派工稀释。约束分档：**A 拍板点**（decision/approval/toggle/gate）与 **B 高频交付物**（MR/URL→`link`、SQL/代码/文案→`code`）是硬门槛（无卡=收工不合格，判据无歧义）；**C 其余展示卡**只强引导（「这段该不该做成表格卡」有判断成分，硬性化会逼出空壳卡）。
3. **`BOARD_UPDATE_MANDATE`** —— 看板即时回写硬门槛。与「给工具兜底」成对：**忘记回写 → 硬门槛；写错格式 → 工具兜底**。只写纪律不给工具＝照样错；只给工具不设门槛＝照样忘。
4. **`CONSULT_MANDATE`**（只读窗专属）
5. **`FEIFEI_BOARD_CONTEXT`**（**仅对菲菲**）—— 把「本轮=看板主人格、有全套工具、非企微、老板说开工即授权」作为**确定事实**钉进系统提示。
   > 起因：企微与看板是两条分开的会话，**消息本身不带渠道标签**，她运行时只能靠企微-centric 的身份自述脑补 → 把看板 run 误当企微人格，用「企微渠道的克制」约束了一个本该放手干的看板动作，对「动手写档案」这个动作扣不下扳机 → 反复空转。**既然「渠道」信号不可靠/缺失，就不该让判断依赖它。**
6. **守航 preamble** `guardedRunPreamble`（仅 `executionMode=guarded_run`）—— 14 条规则。其中 9–14 条**不是新规矩，是对已上机器闸的告知**（「引擎会当场拒收你缺标记的收工」这种事不告诉它反而让它反复撞墙）。规则文本的角色从「约束」降级成「说明书」。
7. **教训注入 `buildLessonsBlock()`** —— 按本轮派工内容选相关教训（中文 2-gram 重叠 + 英数整词，**除以 √长度防长条目恒赢**；相关性挂零时按「越靠后越新」兜底 6 条），上限 14 条 / 5000 字符。
   > **刻意不搬全文**：`ggbond` 81k、`mihu-teacher` 95k 字符，整本灌进去会挤掉工牌本身。
   > 这是补上**读侧**——`appendLessons` 攒了四条一模一样的教训，全都没能改变下一次运行。**任何「沉淀」机制都必须成对：有写就要有读侧的注入策略（含预算与选取规则），否则它只是一份没人翻的档案。**
8. **UI 状态契约 diff** `uiContractBlock(employee)`（只注给两位 QA）—— 保持**同步读缓存**，零事件循环阻塞。

### 4.2 首条消息侧（`dispatchPreamble`）

1. **任务快照** —— server 复用 `/api/tasks` 同款抽取器（`extractEntries`/`extractNextSteps`/`extractPendingDecisions`）从最新档案现抽 1–3K。
   > 动机是硬数字：任务档案曾达 **152KB / 227KB**（时间线占 50%），要求 agent 每次全量读**占派工读负担 ~85%**。
2. **同事近况**（peer awareness）—— 从 runs 注册表抽其他员工最新动态，从孤立 session 变成有团队感。只读窗**不进** `buildTeamPulse`（否则「同事近况」会把咨询窗读成「他正在忙」，污染别人的协作判断）。
3. **猪猪对接块** `buildZhuzhuBlock` —— 仅对 `injectFor` 员工。基地址集中一处配置，逼其开工前 GET 线上对接文档拿最新协议。
   > 起因：SOP/代码默认值写死旧 IP 与设置页打架，致 QA `curl` 超时误判「环境卡死」。**已清所有写死副本**，一律以设置页/注入块现值为准。
   > 后来补了 `refreshZhuzhuHealth`：base 不通时顺带试同 host 的 32147/32148/32146，`diagnoseBaseUnreachable()` 区分 `base-drift`（给出该改成哪个）与 `app-down`。**从没探过时什么都不说**——不许自带虚假健康值。

**残留面**：注入总量没有硬预算（教训块和 UI 契约块各自有上限，但工牌 + 快照 + 同事近况 + 猪猪块的总和没算过）；`FEIFEI_BOARD_CONTEXT` 是针对单个角色的特判，形态上不优雅。

---

## 5. 事件归一与落盘

### 5.1 `normalizeEvent`

`consumeStream` 逐条消费 SDK 消息 → `normalizeEvent` 归一 → `appendEvent` 落 `runs/<runId>.jsonl` + SSE 广播。

| SDK 消息 | 处理 |
|---|---|
| `assistant` | 分内容块：`text` → 累积进 `run._turnText`（后到覆盖，留最后一段）；`thinking` → 只作活动信号；`tool_use` → 落库 + 驱动 `deriveActivity` + **守航台账观测三红灯** |
| `user`（含 `tool_result`） | 落库；**先剥内嵌 base64 图**（`stripToolResultImages`）；无 `tool_result` 的 user 消息是输入回显，丢弃前先数一笔 `_sdkNudges`（SDK「no visible output」自催） |
| `result` | 一轮收工 → `onTurnComplete` |
| `system` | 落库 |
| **控制消息**（`handleControlMsg`） | `background_tasks_changed`（level 信号，replace 语义）、`task_started`/`task_progress`/`task_notification`、`thinking_tokens` |

### 5.2 两条关键的记账

**① 按 `message.id` 归并的产出记账**（`_turnMsgs`）——数「零产出顶层 assistant 消息」。三个必须踩准的细节，任一错了就变成新的误报源：

1. **必须按 `message.id` 归并**。SDK 把一条 assistant 消息**按内容块拆成多次透传**（thinking 一次、tool_use 再一次，`message.id` 相同）——这是常态形状。按「每次透传算一条」去数，**每一个「先思考后调工具」的健康轮次都会被记成空转**。
2. **只数顶层消息**（`parent_tool_use_id` 为空）。子 agent 自己那轮空转与本轮收尾无关，计进去会让「派了 Task 的正常轮」随机变红。
3. **阈值必须 > 1**（`BARREN_TURN_LIMIT = 2`）。单条纯思考正是要救的「说了真话、只是结尾停在思考块」，一刀切会把那类合法轮重新打回红灯。

顺带修过一处旧疏漏：**SDK 后台 settle 后自动续跑的轮次不走 `beginTurn`**、计数器不归零 → 上一轮的零产出会串到这一轮。补在「首个 assistant 且 `_turnActive` 为假」处清账。

**② `stripToolResultImages`** —— 落库前把 `tool_result` 里的 image block 换成 `[图片]` 占位。

**为什么敢剥（关键安全论证）**：jsonl 是**纯 display 日志**——全仓库只有三个动作：写（`appendEvent`）、删（删会话）、**读只有一处**（SSE 回放给浏览器，已 grep 坐实）。**没有任何路径把 jsonl 回喂给模型**。模型当轮实时就从 SDK 上下文看过图；跨 resume 的记忆走 SDK 自己的 transcript（`options.resume=sessionId`，SDK 独立存盘），与这份 jsonl 完全两套。

> **通用教训**：改 display 层数据前，先证明它不是任何模型/业务通道的输入源。

**为什么 `REPLAY_TAIL` 挡不住**：那道闸只截**行数**（尾部 3000 条），对「行少但每行巨大」的会话完全无效——1153 行远没触顶，8.6MB 照样整段推。**限流要同时看「条数」和「体积」两个维度，只截其一会被另一维度绕过。**

量化：生产 `app/runs` 迁移 38/223 文件含图，238.5MB → 213.8MB；单个 8.87MB → 2.54MB（最大行长 606KB→38KB），零丢行。

### 5.3 子代理的一等可视化

SDK 把子代理的 assistant/user 消息打上 `parent_tool_use_id`（= 那个 Task 调用的 id）混在**同一条 query 流**里。引擎从 v0.1 起就**透传却从不读**这个字段 → 子代理跑时侧边栏显示的「正在检索代码」错挂在员工本人名下，聊天窗口把子代理的思考+工具+文本拍平渲染、顶着员工头像冒出。

**取舍**：把 `parent_tool_use_id` 提成**一等维度**（状态分层到「员工·子代理X 正在…」，聊天流把子代理事件收进父级下方的可折叠嵌套块），而不是继续拍平。

**关键不变量让实现变简单**：一个 query 内，子代理在其 Task `tool_use` 与对应 `tool_result` 之间跑完，其间父级被阻塞不出消息 → **子代理事件是连续块，不与父级交织**。因此前端用单个 `appendRoot` 指针 + 各上下文自存 `curToolGroup` 即可，`switchContext(pid)` 在事件入口切上下文，**无需**做「任意时刻多路并发 DOM 目标」的通用交织重构。这是刻意省下的复杂度。

**已知局限**：SDK 只暴露**一层** `parent_tool_use_id`（直接父）；深层嵌套靠「父行仍在 → 落外层子代理体」递归成立，拿不到深层 meta 时退化成通用 `agent` 标签。

### 5.4 后台任务（turn 外还在跑）

**与子代理的区别（别混）**：子代理是**turn 内**跑完（父级被阻塞、靠 `parent_tool_use_id` 分层）的**渲染**问题；后台任务是**跑到 turn 结束之后仍活着**（`run_in_background` bash、被 background 的 foreground 任务）的**状态映射 + 生命周期**问题。

四条实现口径：

1. **level 信号是成员唯一权威源**：`background_tasks_changed` 用 replace 语义维护 `run._bgTasks`；`task_started/progress` 只补元数据、**不作为「还在不在跑」的判据**——避免漏掉 bookend 导致僵尸「后台运行中」指示。`skip_transcript` 的内务任务不计入。level 是 per-process，冷起/resume 时重置为空。
2. **状态映射做成前端派生态、`run.status` 内部不变**：本轮收工但 `_bgTasks` 非空时，文案改「✅ 本轮收工，但仍有 N 个后台任务在跑」，但 `run.status` **仍置 `done`**——不引入新枚举值去 ripple `STOP_META`/`autoChain`/watchdog 全链路。「后台运行中」是前端从 `run.bgTasks` 派生的显示态。
3. **不误关 query 是命门**：`_bgTasks` 非空时 `scheduleIdleClose` **跳过**——空闲窗一关 = `_input.close()` = 杀子进程 = **连后台任务一起杀**。
4. **后台完成自动接棒，且与「空 result 不自动续跑」不矛盾**：禁的是**模糊信号**（`result` 空 ≠ 没干活）；`task_notification` settle 是**明确信号**（有 status/summary/output_file）。防重复注入用 `_turnActive` + `BG_RESUME_GRACE_MS`(5s) 观察 SDK 是否自续。

**唤起前的守卫（诈尸事故驱动）**：`supersededBy()` —— 若存在「同员工 + 同 `threadRootId` + `startedAt` 更晚 + 当前 running/starting」的会话，判为已被顶替，**跳过唤起**，只落一条 lab 说明（「已被会话 X 接管、后台结果仍在磁盘可 Read」），**不跨会话注入**那份结果。

> **为什么按 `threadRootId` 判、不按员工一刀切**：老板明确要「同一员工多线程并行」。守卫写成「同员工有任何活跃 run 就跳过」会误伤。按线程判则：独立线程各自的后台接棒互不干扰，**只有被同一线程新会话顶替的旧会话才不复活**。
> **通用教训**：会话/资源的「活跃」判定要选对粒度——粒度错了，守卫要么漏拦要么误伤。

**后台事件不推手机/托盘**：起停后台任务是 run 内部子事件，push 只留给员工本身层面的事件。理由：后台完成会自动接棒续跑，那一轮 run 收工本就按配置推一条，后台再单独推就是重复噪音。

---

## 6. 收工判定：从 result 到红绿灯

这是引擎里被改动次数最多的一段（五轮），也是「判据挂在哪」这条主线最集中的地方。

### 6.1 演进链

| 版本 | 逻辑 | 为什么改 |
|---|---|---|
| v0 | `result` 有内容即 done | — |
| v1 | 空 `result` → **判 done 亮绿灯 + appendLessons + autoChain** | 事故：菲菲一轮 `Edit` 锚点失配后只产出空思考块便 `end_turn` → 引擎亮绿灯，而 autoChain 在空 result 里找不到标记 → 命中「安全默认=终止」→ **静默死停**。需求说明落了盘，但登记表未加、未派下一棒，界面一片绿 |
| v2（**当天回退**） | 空 `result` → 原地热推纠偏续跑（`MAX_EMPTY_RETRIES=2`） | **更严重的线上事故**：自动续跑期间 run 恒 running → `/reply` 409 拒收用户消息 → 从「静默停但随时能继续」放大成「彻底不工作」。且 resume 的正是那条退化会话，每轮都空，2 次纠偏白锁 ~10 分钟 |
| v3 | 空 `result` → 直接置 `error` 终态 + 红灯 + 推手机，**不自动重试** | 关键是 **run 立即回到可交互态**，把恢复节奏交回用户 |
| v4 | 加 `_turnText` 兜底（本轮有实说文本就用它当收尾，绿灯并注明）+ `_emptyStreak` 连续空转熔断 | v3 治住了 A 类（静默），却**没治误报**——「说过话、只是结尾停在思考块」被一律判红灯 |
| v5 | 兜底加闸：`isSpunTurn()` = `_sdkNudges ≥ 2` **或** `barrenTurns() ≥ 2`，任一即判空转 → 不许兜底假绿 | v4 的兜底本身制造了新的假绿（两次）：一次是「早期一句废话 + SDK 反复自催空转」被 painted 绿灯；一次是 SDK 改成**静默重发请求**、一条 nudge 都不注入，于是挂在 nudge 上的闸门**整条静默失效** |

### 6.2 现行判定

```js
// 概念伪码
onTurnComplete(run, msg) {
  const spun = run._sdkNudges >= SILENT_SPIN_NUDGES || barrenTurns(run) >= BARREN_TURN_LIMIT
  let result = msg.result
  if (!result?.trim() && run._turnText && !spun) {
    result = run._turnText            // 兜底：模型确实说过的话
    run._resultFromFallback = true    // 绿灯并注明「结尾停在思考块」
  }
  if (!result?.trim()) {              // 真空 / 判定空转
    run._emptyStreak++
    → error 终态 + 红灯（≥2 轮时升级文案「请勿再回复继续，直接新开话题/重新派工」）
    → 推手机；不 appendLessons；autoChain 不接棒
    return
  }
  run._emptyStreak = 0
  → signoffRejectIfNeeded → 门禁 → autoChain → appendLessons → maybePushRunStopped
}
```

### 6.3 沉淀的四条判据原则

1. **空 `result` 不是合法终态**，但「不合法」≠「该由引擎自动替它续」。**能被动暴露 + 交回控制权，就不要主动接管。**
2. **判「有没有真产出」不能只看末尾 `result` 字段**（末块是思考/工具就为空），也不能只信 SDK 的 `is_error:false`。
3. **「兜底救误判」的补丁本身要能区分「它要救的合法态」与「长得像但其实是病态的态」**，否则就从『治漏报』变成『造新漏报』。判据必须落在**能把两者分开的那个特征**上（这里 = SDK 自催次数 / 零产出轮次），而不是一个两者都满足的宽条件（「有没有说过话」）。
4. **「判据挂在哪」比「阈值调多少」重要得多**。v5 那次的闸门本身是对的、阈值也校准过，但它把判据挂在**上游某个组件恰好会说的一句话**上；上游换了实现，判据整条失效——**而且失效方式是静默的：闸门还在、代码还在、日志上什么都不缺，只是永远不触发**。判据应当挂在**本层能直接观测到的事实**上。

### 6.4 收工即校验 `signoffRejectIfNeeded`

`stall-guard.js` 的 `validateSignoff` 在 `onTurnComplete` 里判「这轮收尾有没有该写的标记」，缺就**当场拒收并回灌具体提示**（提示按 code 分岔，直接告诉它「你现在该写哪一行」）。

**为什么挪到这一刻**：巡视员在观测窗口内被派 **79 次、只有 2 次是真停**。97% 的浪费不是判得差，而是**判据挪错了位置**——引擎在**事后**才发现「收工没写标记」，然后派一个 LLM 去读收尾原文、猜它当时该做什么。而「收尾里有没有那一行标记」是纯字符串判定，成本接近 0，且在 `onTurnComplete` 那一刻信息最全（result 刚到、`_bgTasks` 还在、`_input` 还开着能回灌）。

**边界刻意收窄（宁可少拒也不误拒）**：只管 `dispatch` 轮（`chat` 是老板在对话，回一句话不需要机器标记）、不管只读窗、不管 error/空收工（那条路已有空转熔断）、**每条会话最多拒 2 次**、`_input` 已关时直接放弃（回灌不了就别假装拒收成功）。

**上线前先跑存量（这是本节最值得学的一步）**：把判据离线跑过 `runs/index.json` 里全部 **604 条历史 dispatch 收工**，按角色分组：

| 员工 | 条数 | 拒收 | 率 |
|---|---|---|---|
| 小呆呆 chaorenq | 389 | 186 | **47.8%** |
| 菲斯拉 feisila | 7 | 7 | **100%** |
| 菲菲 feifei | 73 | 3 | 4.1% |
| 迷糊 mihu | 49 | 5 | 10.2% |
| GG Bond / 波比 | 86 | 0 | 0% |

前两行高得离谱，但**不是因为它们爱空停**——它们的产出本身就是结论、**无棒可交**（巡视员的三种合法结局之一就是「汇报无需动作」；菲斯拉走 `submit_audit_findings` 提交发现、不掌握放行权）。不豁免的后果是**自指的**：巡视本来就是来处理空停的，结果它自己每轮被判空停、被拒收 2 次再放行——省下的成本原封不动还回去，还多烧两轮。加 `SIGNOFF_EXEMPT_EMPLOYEES` 后真流水线四角色是 **8/208 = 3.8%**，那才是真空停率。

> **留成通用规矩**：任何新门禁上线前，先把判据离线跑一遍存量数据、按角色分组看命中率。**异常高的那一组通常不是违规者，是判据没覆盖到的一类合法形态。**

**一条反例记一笔**：G3「合法等待」的第一版要求员工在收尾里点名它在等的句柄，单测立刻打出反例——**句柄的事实源是引擎（`run._bgTasks` 就在手边），不是员工的措辞**。要求它复述一遍，只会把「引擎明知在跑」的正常等待判成空停。**别去问一个你自己已经知道答案的问题**，尤其当答错的代价是误踢。

---

## 7. 编排：四标记 + 抄送 + 服务端守卫

### 7.1 标记解析铁律（两轮踩坑定型）

| 铁律 | 为什么 |
|---|---|
| 标记必须**独占一行** | 指令正文里常引用标记名（「预检通过后我才【下一棒】迷糊」） |
| **全文搜索取最后一条**（不 slice） | 长 prompt 会截掉真标记 |
| 指令/报告**支持多行**（吃到下一个标记行/结尾） | 交接指令通常是一段 |

四个标记：

- `【下一棒】<员工>｜<指令>` → **forward**（新建 run，`callerRunId` 供回发）
- `【交回】[@runId]｜<报告>` → **return**（resume 委托者会话，不新建）
- `【等你拍板】<事项>` → **门优先**：有门一律停，无视是否也写了下一棒
- `【教训】<一句话>` → 自动去重 append 到 `memories/*.md`（带日期 + runId）

### 7.2 服务端强制守卫（不信 agent 守规矩）

| 守卫 | 规则 |
|---|---|
| 深度天花板 | `chainConfig.maxDepth = 20`；**只计 call 不计 return**（中枢型员工反复派活收回不虚增深度） |
| 自环 | `【下一棒】自己` = **自续**（不是死循环）：新起同员工 run 续做下一块，用独立 `selfChainMax = 40` 预算兜底、不占 `maxDepth` |
| 回发 | 拦截 self / busy / unknown / no-caller / nosession；**裸式`【交回】<员工名>`纠偏为 call**（防中枢型员工活派不出去） |
| 扇出 | 单回合 cc ≤ `CC_MAX_PER_TURN`(2)；同 `threadRootId` 并存活跃 run ≤ `CC_MAX_THREAD_RUNS`(4)。**`maxDepth` 只挡深度、挡不住广度**——每 run 抄 2 人、8 层内可爆 256 条并行 run |
| 忙碌 | forward 目标忙 → `queuePending`；return 目标忙且**同线** → `enqueueTurn` 并入；**跨线** → 入队 |

**自续的三个细节**：
- **自续＝新起同员工 run，不是 resume 老会话**——员工那条自我交接指令本就按「全新上下文、先读滚动实施记录续做」写的，且避免单会话上下文通宵膨胀。
- **血缘继承原委托者**（非上一自续轮），否则最终 `【交回】` 会回到已死的自续轮 → `return-unknown`。
- 自续轮**跳过** `createDispatchRun` 那句「完成后用【交回】、勿用【下一棒】新开 run」的 callerHint——那提示会**直接劝退自续**。

**起因**：老板睡前让 GG Bond「开完直接来预检」，它干完一块后**正确地写了完好的自续标记**，但 `autoChain` 有一条 `if (nextKey === run.employee) return // 自环 → 终止` 把它丢弃，通宵没干完。根因是 **SOP 与引擎能力自相矛盾**：派工 prompt 明写「继续自续下一棒直至预检门」，引擎却禁止自续。

### 7.3 抄送 `cc_colleague`：为什么是工具不是标记

**承重决策**。诉求是「GG Bond 一边改代码、一边知会菲菲并行更新 facet、自己不停等」，本质是**回合内**事件——在一个长回合中途知会、然后**继续这同一回合**。而标记只在 `result`（回合已结束）才被 autoChain 解析，**给不了「继续」**。故做成 in-process MCP 工具：调用时作为副作用派生兄弟 run + **立即返回**，发起方回合从不中断 = 教科书 fire-and-continue。

**刻意不走「引擎 re-push 续跑」让发起方继续**——那正是当天被回退的错误方案（自动续跑锁死 running、`/reply` 409）。工具天然绕开：发起方压根没结束回合。

**兄弟 run 血缘**：`callerRunId=null`（cc 是知会不是委托、不回发）、`chainDepth+1`（复用天花板兜「A 抄 B、B 抄 A」乒乓）、继承 `threadRootId`（会话看板自然归到同一线程组，前端从「线性链」变「扇/树」，**零新增 SSE 类型**：复用 `handoff`/`conversation` 加 `kind:'cc'`）。

**并发安全的核心，且被「全员 bypass」逼成唯一解**：`tasks/*.md` 此前由员工各自用 `Edit` 读-改-写，并行下必然 clobber + 锚点失配静默失败。收归引擎后由工具 + per-file 锁（`withArchiveLock`）+ 原子 temp→rename 串行落盘，引擎持磁盘为准、**无「锚点」概念** → 同时根治两类竞态。

> ⚠ **关键根因，务必记住别再走回头路**：六员工全 `permissionMode:"bypassPermissions"`，而 `startRun` 在 bypass 下**不挂 `canUseTool` 回调**（`if(!isBypass) options.canUseTool=…`）——所以「用 canUseTool 拦截档案写、加进程内 advisory 锁」这条看似自然的路**对现有员工全部失效**；bypass 下仍恒生效的只有 deny 名单。**把写收归引擎是 bypass 下能给共享总线原子性的唯一可靠手段。**

**不上 git worktree 隔离（诚实取舍）**：三条并行流天然按文件分区（GG Bond 改代码/实施记录、菲菲改需求/facet、迷糊改用例），真正重叠的只有 `tasks/*.md` 一个文件。worktree 是「隔离任意文件并发」的重武器，用在这里反而要写「状态文件三方结构化合并器」（谁的 status 赢、时间线怎么按时间戳交织），且砸掉「产物永远是仓库里那一份活文件 + `fs.watch` 实时刷」的核心不变量。

### 7.4 跨线程待处理队列

**根因**：所有 run 共用一个工作树 → 同员工不能并发两条会话，历史上遇到「别的员工给正忙的员工发消息」就用**塞进它当前正在跑的会话**当妥协。当来消息属于**另一条任务线**时，这条消息被灌进员工正在做的**另一件事**的上下文里 → 模型分不清「我到底在做哪件事」，输出错乱。**妥协在同线程下没问题，错只错在跨线程也一并硬灌。**

判据：`threadOf(run) = run.threadRootId || run.id`（复用 `supersededBy` 的同线程 idiom）。

| 路径 | 同线 | 跨线 |
|---|---|---|
| cc/抄送 | `pushTurn` 并入 | `queuePending(kind:'cc', deliver:'new')` |
| return/交回 | `enqueueTurn` 并入（员工级 `busyRunFor` 判定） | `queuePending(kind:'return', deliver:'resume', resumeRunId)` |
| forward/下一棒 | 自续分支不动 | `queuePending(kind:'forward', deliver:'new', callerRunId)` —— 从原来的 `handoff-blocked`（停下等人手动接棒）改为入队自动接棒 |

**排空时机**：`handleStreamEnd` 末尾（takeover/retry 分支都提前 return，走到这里 = query 已 `clearLive` 释放且不重启）`if (!busyRunFor(emp)) drainPending(emp)` —— FIFO 弹一条，投递后员工即忙，其余留队由下条会话收工链式排空。**持久化** `runs/pending.json`，重启后全员空闲、`server.listen` 回调里逐员工排空一次。`drainPending` 对「交回项但委托会话已被删」有兜底：用报告文本另起新会话，**不静默丢结果**。

> **通用教训**：加了一条通用能力（无感排队），要回头盘点「所有本该享受它的入口是否都接上了」。`enqueueTurn` 当初只接了用户 `/reply`，employee 交回这条同构入口被漏掉，于是同样的「往忙碌会话塞消息」一个顺一个卡。**能力与入口要成套推。**

---

## 8. 三层正交监督

### 8.1 watchdog `sweepStalled`（进程层）

- 周期 `WATCHDOG_INTERVAL_MS = 30_000`
- 宽限 = `WATCHDOG_BASE_GRACE_MS(150s)` + 思考预算 × `WATCHDOG_THINK_FACTOR(12ms)` —— 重活容忍更久，**真卡死是零字节**
- 判死 → `abort()` → `handleStreamEnd` → `shouldAutoRetry`：用户主动停/无 session/达上限（`MAX_AUTO_RETRIES = 10`）→ 否；watchdog 判死 / 结果含连接错误文案 / 流中途抛错且无结果 → 是
- `thinking_tokens` 心跳**只广播不落库**，但刷新 `_lastActivity` —— 给 watchdog 一个「模型确实在思考」的真实存活信号

**事故根因（v0.1 时代）**：菲菲单 turn 一次性写三份大文件，流式 4.5 分钟后触发 `Connection closed mid-response`，子进程异常但不触发 close → status 永远 `running` → `/reply` 恒 409 吞掉用户「继续」= **僵尸 run**。由此衍生的产出纪律写进工牌：**多文件产出逐个写、一回合一个文件**。

**残留面**：收紧宽限常量（150s→~90s）**留到运行时确认 `thinking_tokens` 随本 SDK+Opus 稳定流出之后再落地**——先加信号、再据信号收紧，不拍脑袋改阈值。

### 8.2 空转熔断（模型层）

见 §6。

### 8.3 巡视员小呆呆（协作层）

**为什么是「角色 agent」而非引擎硬规则**：「这次停得对不对」本质模糊——GG Bond 那几次停里**有真该问老板的**（模板选型、关键发现），也有纯空停（末轮「我继续」）。规则区分不了，LLM 读收尾 + 任务状态才判得准。做成可见角色便于老板看到它在巡、可追溯。

**检测/判断分层**：检测用引擎（确定性、零成本）在 `autoChain` 三分支全落空处标出「候选空停」；判断用 LLM（fuzzy）。这是「便宜的判定交代码、贵而模糊的判断交模型」的协作层应用。

**双触发**：
- **事件驱动** + **8s 宽限窗**（`chainConfig.patrolGraceSec`，0=关）：deadline 落 `run.patrolGraceUntil`（**持久数字字段**，避 `stripPrivate` 丢弃），前端 rAF 按 deadline 倒计、自己不计时（前端计时会让「没人看的窗口永不触发」）。老板回话或点取消即撤销。重启有 `rearmGracePatrols()` 补偿。
- **定时兜底** `sweepIdleStops`（`patrolSweepMin`=6 分钟，可在小呆呆头像弹窗改、即时生效）：三重过滤压住「把已合法完成的老会话误当空停复活」——每个「任务|员工」只取最新一条 done 候选、静置窗口 `[5min, 24h]`、任务非终态。

**判定一分为二**：`patrolEligible`（纯「实质停顿」判据，共用底座）；`patrolCandidate` = eligible + 挂任务/marker，**收窄只给定时 sweep 用**（避免低频扫描去复活远古闲聊）。

**裁决落库（治死循环）**：巡视有三种结局——`resume`、`升级老板`、`判合法收工`。前两种在 run 状态上留痕，**最常见的第三种什么都不写** → `patrolCandidate` 每次都重新判它是候选 → 同一会话被巡 7 次（小呆呆自己在收尾里点破了「已连续 7 次产生完全相同的冗余巡查、强烈建议核查入队去重逻辑」——**它从会话内部诊断出了自己所在 harness 的 bug**）。修法：持久裁决签名 `patrolClearedSig = 目标当时 updatedAt`，命中即排除；目标日后真被续跑并产出新停顿时 `updatedAt` 刷新 → 签名失配 → **自动重新武装**。

**按岗位注入判据（从一轴扩成两轴）**：每个流水线员工的 `roles/*.md` 末尾加 `## 巡视判据（小呆呆专用速查）`，引擎 `extractSection` + `patrolCriteriaFor` 抽出来拼进巡视 prompt。两轴 = **(A) 该干没干** / **(B) 不该干却要干**。

> 起因是两类方向相反的误判：① QA 把「深层 facet 没测完」包装成「要我继续吗」→ 被按「员工在问老板→升级」升级给老板，深层 facet 全悬空；② 若波比停下说「我需要 force-push」→ 按旧红线「只判该不该停」可能直接 resume 它进一个越红线的动作。
> **根因：判据与岗位解耦。** 小呆呆手里只有通用的「有没有停、有没有问」信号，没有「这个岗位的活干到什么算完、哪些动作它绝不能自己迈」的对照标准。
> **通用教训**：监督者的判据必须和被监督者的职责耦合；一条为治 A 病下的保守红线（问句皆升级）会变成 B 病的温床。

**破除三种「标记豁免」**（同族三次）：
- `handoffStuck = run.handoffBlockedSig === run.updatedAt` —— 写了 `【交回】` 但闸门 fail-closed 吞了
- `qaHollowStopSig` —— 写了 `【等你拍板】` 但 QA 覆盖未达标
- `patrolEscalating()` —— 巡视员自己的升级不再「只认严格标记」：规范标记 / `decision` 卡 / 白话请示正则任一命中即算升级、必推
  > **一层反向护栏（自测当场抓到）**：必须先放过「显式写了 `【等你拍板】无`」的那类——那是协议里「合法收工·无需动作」的规范收尾。少了这层，兜底正则会把标记里「等你拍板」**四个字本身**当成白话请示，于是**每一条判合法收工的巡视都弹一次 toast**，降噪的初衷当场作废。唯一例外：标了「无」但同时抛了 `decision` 卡 → 仍判升级。

**成本收敛**：`EMP_TIER.chaorenq = 'light'`（Sonnet），`resume_employee`（能 resume 任意会话）**只挂给巡视员**、不进全员共享工具，`CODE_LOCKED`（只巡不写码），`patrolMax`(6) + `_patrolNudges` 防无限续。

### 8.4 菲斯拉（结论层，教导主任）

**从「并存 QA」重定位为「对抗审计」的理由**：并存双 QA 价值有限——两人会犯同类错、职责重叠。业内共识是「对抗式验证 / agents-verifying-agents」，且**静态红线拦不住 reward hacking**，需要一个**主动的对手**去证伪。

**核心设计——「证伪」目标函数治 self-attribution bias**：若她只是「把用例再跑一遍看还绿不绿」，她会和 QA 犯同样的错、还偏宽。解药是把目标函数设成「证伪」而非「复跑」：开局假设 GREEN 是错的、逐条攻破。她与巡视员构成**正交双轴**：巡视员盯全局「过程该不该停」（liveness，light 模型）；菲斯拉盯「结论成不成立」（evidence validity，heavy 模型）。

**v1 是拦截层**（扣结论 → 审 → 放行/打回/升级），有 `release_audit`/`bounce_audit` 两个工具 + `auditMax`(3) 循环上限 + `auditClearedSig` 放行签名 + replay 机制。

**v2 起彻底转为「影子陪练」**：**删除自动放行/打回能力**，改成机器门禁通过后异步派她，用 `submit_audit_findings` 只记录发现。理由是实测——她**真查了**（自连 DB、读 case JSON、读源码、核 App-run pass），却接受了「用存量数据验只读门禁 ≠ 翻库假绿」这套**自洽说辞**、背书放行。

> **关键认知**：她≈0 不是不够聪明，恰恰是**她太会讲道理**——你让 LLM 当裁判，它遇到 plausible 的合理化就点头。**根因结构性**：她和被审者同款模型、同一个「绿了就算完」目标函数，共享盲区；LLM 审 LLM 能抓**硬错**（∃/∀ 语义、可实测证伪的假前提），抓不住**「讲得通的欠测」**。

**一个观感坑值得单记**（v1 时期）：`release_audit` 是她在 turn **中途**调的工具，工具内即时 `autoChain(target)` → 转发在她这条审计 run **收工之前**就发生 → 看板上「菲斯拉 running」与「下游已接棒」并存，看着像抢跑。修法是把转发**从「工具调用即时」延到「她的 run 收工时」**（`_auditReleaseTarget` + `autoChain` 顶部分支）。
> **通用教训**：当一个 run 的副作用会驱动别的 run 动起来时，让副作用与「这个 run 可见地收工」对齐，别在 turn 中途就点火。对齐的代价若是引入崩溃窗口，就用「关键状态位立即持久化、副作用延迟触发」把死锁风险兜住。

---

## 9. 权限模型

### 9.1 三次演进

| 版本 | 机制 | 问题 |
|---|---|---|
| v0.1 | `--permission-mode` + `settings.json` 静态白名单（精确命令模式如 `Bash(git push origin feature/*)`） | 脆弱、跨机不一致 |
| v0.2.0 | 员工走 `auto` 分类器自主放行，`canUseTool` 把危险/未知命令路由到 **Lab UI 审批卡**；代码内置 `DANGER_DENY` 全员硬拦 | 依赖 `~/.claude/settings.json` 是否被 `settingSources` 加载 |
| v0.2.1（代码已改，版本号当时未 bump） | 切 `acceptEdits` + 显式**三名单** `PERM_ALLOW`/`PERM_ASK`/`PERM_DENY`（内置引擎）+ `DANGER_DENY` | 跨机一致、开箱即用 |

### 9.2 现行姿态

- 六员工全 `permissionMode: "bypassPermissions"`
- **bypass 下 SDK 在咨询 `canUseTool` 之前就放行** → `startRun` 刻意不传回调（避免 `CAN_USE_TOOL_SHADOWED` 警告），**仍只下发 deny**（红线保留）
- `DANGER_DENY`：全员硬拦致命命令（scoped deny 任何模式恒生效，分类器不可放行）
- `codeLockDeny`：`CODE_LOCKED_EMPLOYEES = {feifei, bobby, chaorenq}` 禁写 `CODE_ROOTS = [frontend, backend]` 下的实现文件
  > 起因：菲菲曾把一个咨询越界改成 347 行 `index.tsx`
- `CONSULT_ALLOW` / `consultDeny`：只读窗白名单 + 写工具**裸名**全局 deny + **一个 MCP 都不挂**
  > 「零挂载比逐个 deny 可靠——工具根本不出现在工具表里，实测 SDK 直接答 `not enabled in this context`」
- `PERM_TIMEOUT_MS`(300s) 无人应答自动拒绝；`PERM_PUSH_MS`(60s) 仍无人处理 → 升级发 Bark（点通知开手机审批页可直接同意/拒绝）
- PreToolUse hook `block-employee-subagent.mjs` 硬拦 `Agent`/`Task`/`SendMessage` spawn 同名子代理（**方案 B**：员工间交接只走 office-lab 派真实 run）

### 9.3 已知脆弱点

**glob 匹配规则是实测踩出来的、写在注释里**：必须用 `./x/**` 或 `//abs/**`，无前缀/单斜杠绝对路径都不匹配。**SDK 升级可能变——这是明确的脆弱耦合点。** 会议室那次刻意改用**裸工具名** deny 就是为了绕开这个坑（跨平台可靠）。

---

## 10. MCP 工具目录（按角色）

全部是 `createSdkMcpServer` + `tool()` + zod schema 的 **in-process** 工具，handler 是引擎侧 Node 代码——**这是「给 agent 加能力又不放开文件系统/网络权限」的核心模式**（企微人格「碰不到文件系统」但能查版本进度，靠的就是这个）。

| MCP server | 挂给谁 | 工具 |
|---|---|---|
| `office-lab-collab` | 全员（consult 除外） | `cc_colleague`、`append_timeline`、`validate_task_archive`、`set_task_status`、`set_entry_status`、`seed_coverage`、`set_facet_coverage`、`coverage_status`、`reconcile_coverage`、`lint_test_file` |
| `patrol` | 仅小呆呆 | `resume_employee` |
| `audit` | 仅菲斯拉 | `submit_audit_findings` |
| `backend` | 仅 GG Bond | `rebuild_restart_backend`、`backend_status` |
| `release` | 仅波比 | `enumerate_release` |
| `guarded` | 按角色分派（20 个） | 通用：`progress_snapshot`、`guard_status`；GG Bond：`freeze_handoff`、`impact_radar`、`ddl_precheck`、`risk_gate`、`draft_implementation_record`；菲菲：`pool_fields_check`、`pool_scan`、`readiness_probe`、`park_item`、`cross_entry_facets`、`morning_report`、`version_append_check`；迷糊：`preflight_gates`、`verify_green_evidence`、`visual_acceptance`、`residue_report`、`qa_report_card`；菲斯拉：`audit_evidence_trust`、`file_escape_case`、`audit_intake_misjudge`；波比：`reconcile_release_chain`、`deploy_manifest`、`lint_release_sql`、`rollback_plan` |
| `zhuzhu`（E2E） | 迷糊 + 菲斯拉 | `run_e2e_batch` + 转发的平台工具 |
| 企微人格专属 | personaReply | `knowledge_base_query`、`stage_requirement_intake`、`lark_list_requirements`、`lark_get_requirement`、`lark_update_requirement`、`lark_delete_requirement`、`lark_list_fields`、`lark_manage_field`、`query_version_progress`、`recall_conversations`、`recall_staged_requirements`、六个 `wecom_*`（当前降级关着） |

### 10.1 几个设计口径

**「枚举做成拒非法而非容错映射」**：条目「状态」列驱动看板圆点色 + 接棒目标。自造状态词会落到文字启发式、常变灰——治本不是把启发式做得更聪明（无底洞），而是**在工具入口就拒收非枚举值并回列合法值**。代价：员工要记 19 个枚举——但工具报错信息里直接列出。

**枚举三处锁同步**：`server.js:ENTRY_STATUS_ENUM`（校验）= `app/public/app.js:ENTRY_STATUS`（渲染）= `文档格式规范.md §3.4`（人读契约）。三处各加交叉引用注释「改一处必须同步另两处」，脚本核对键集一致（19=19）。

**「写了函数」不等于「员工够得着」**（自我抓出的死代码）：`sortPool`/`pickForContract` 写了、测了 6 例，却**一次都没接成工具**——全仓零调用。SDK 员工只能看见工具表里的东西，模块里的导出对它不存在。
> **进 checklist**：新增能力模块后逐个 export 反查「谁调它」，零调用的要么接上、要么删掉，别留成「看起来做了」。

**`run_e2e_batch` 的一个真 bug（单测抓的）**：初版写 `ok: status === 'passed' || d.ok === true` —— 而 MCP/HTTP **信封的 `ok:true` 只表示「这次调用成功」**，平台常在 `ok:true` 的信封里带 `status:"failed"`。用 `||` 会把**红判成绿**。改成 `status === 'passed' && d.ok !== false`（两者一致才绿，任一说红就红，fail-closed）。
> **教训**：凡「传输层 ok」与「业务层 status」并存的响应，永远以业务层为准、且 fail-closed；用 `||` 兜底就是在造假绿。

---

## 11. 质量门禁：覆盖率闸门与 linter

### 11.1 四代范式转移

| 代 | 做法 | 结果 |
|---|---|---|
| 1 | **加红线 + 生成式清单**（§3.38） | 同类隐含 bug 后续仍漏。诊断出一条重要洞察：她教训库里关于「反事实断言 / 区分度 / 改 A 验 B」有十几条，但**全是「被抓过之后写下的追认式教训」**——只在「这次恰好想起来」时生效 |
| 2 | **认定「规则过载」，另建菲斯拉而非加第 13 条红线**（§3.54） | SOP 已 142 行、12 条红线 + 4 个纪律段，信噪比退化到红线互相竞争、agent 在压力下抓错优先级。**但新建的这个后来给假绿盖了章** |
| 3 | **菲斯拉重定位为对抗审计员**（§3.55） | 她太会讲道理，接受了自洽说辞 |
| 4 | **判定移出 LLM，变成确定性引擎判定**（§3.64 → §3.66 → §3.67 v2） | **这批真的有效**：假绿式偷懒（手填绿 / 翻库 / networkResponse 假绿）被机读门禁基本堵死 |

**第四代的触发点是老板一句话**：前几轮对策都是「加红线/加教训/加菲斯拉」——**这些都是治标，甚至治标都治不了**。因为 QA 的「成功」定义是「产出一份合理的报告 + 得出结论 + 交出去」，而且**由它自己判、再由另一个 LLM 复评**。在这个目标下，「待人工/源码坐实」每一个都是通往 done 的**局部最优省力动作**——这在 AI 领域叫 **specification gaming / reward hacking**。

**老板的另一句戳破了正解**：「菲斯拉改成机器门禁，那不就是 if/else 吗？」——**对，而这正是要点。** 最可信的质检（编译器/类型检查/CI/断言）**全是 if/else**；没人指望它聪明，正因它蠢、确定、不讲道理，才不可能被说辞绕过。

### 11.2 三层分工（现行）

| 层 | 谁做 | 判据 |
|---|---|---|
| **判定（算不算数）** | 确定性机器门禁 | 又蠢又倔 |
| **生成 / 发散** | LLM | 错了有下游兜 |
| **语义（证没证需求意图）** | 人薄抽 | LLM 判不了——**没有「再加个 AI 就不用人看」** |

> **判据**：让 LLM 干「错了有人兜」的活，别让它干「错了没人知道」的活（最终放行一错全线放行、无人兜底）。

### 11.3 硬闸 v2 的六条收紧

1. **通过语义收紧为唯一公式**：只有机器签发且 GREEN/RED 证据都完整的 `COVERED_GREEN` 才通过。`SOURCE_ATTESTED`（实现审阅）/ `BLOCKED_WITH_PROOF`（测试被阻断）/ `HUMAN_INHERENT`（需独立风险审批）三者都令 `qa_passed=false`，**不再冒充覆盖完成**。
2. **机器证据代替自由文本**：`set_facet_coverage` 明确**拒绝手填 GREEN**；只有 `reconcile_coverage` 可从真实 summary 签发，证据绑 `runId / case / testHash / summaryHash / Git commit / env / summary path`。正常 GREEN 要求全部步骤实际执行且无 failed/skipped/stopped；RED 必须是声明 `redCalibrationId` 的反事实/故障注入 run，且失败在 assert/capture/expect。
3. **从启发式 AAA 升级为显式数据血缘**：content case 强制 `qaTrace.arrange/act/assert`，三段携带同一 `entityRef`，分别声明 `provenance / operationId / oracle`。create macro **只从 fixture/arrange 结构识别**，case 标题、注释、`lintAck` 里的单词不算造数。`coversFacets` 不在权威 facet_doc 里直接 `FACET_UNKNOWN` 阻断。
4. **关闭自批旁路**：`lintAck` 只保留申诉记录，**不再改变 finding 严重级别**（等于考试者给自己签免考单）。
5. **门禁全路径 fail-closed**：发波比和真实交回都必须过同一硬闸；缺 taskFile/facet_doc、facet 解析失败、档案落盘失败全部阻断。三个 gate 字段由引擎一起机算，历史 `auditClearedSig` 或运行配置不能绕过。
6. **取消 LLM 最终放行权**：菲斯拉转影子陪练，机器门禁成为唯一自动放行权威。

**关键取舍**：
- **宁可诚实全红，不兼容历史假绿**。v2 上线后 v5.17 旧矩阵被重算为 34/34 coverage gap、6 RED gap、`qa_passed=false`。**这不是回归，而是过去被掩盖的欠测第一次被如实显示。**
- **全自动只能用于零例外 clean path**。一旦出现 HUMAN/BLOCKED/SOURCE，就不能既声称「全自动可信」又自动放行。
- **哈希绑定的诚实边界**：当前 `testHash/commit` 是 reconcile 时读取测试仓签发，**已能阻止自由文本和跨 case 混证**；更强的下一步是让运行器在生成 summary 时原生写入 —— **明确列为待办，不把现状夸成密码学不可伪造**。
- **严格门禁不替代测试数据基础设施**：门禁只负责拒绝坏证据，不会凭空生成深状态业务数据。**绝不能为了让门变绿重新开放「翻库借存量」。**

### 11.4 有效性 linter（三个反模式）

| finding | 对应业界实践 | 判什么 |
|---|---|---|
| `DB_FISHING` | Test Data Builder「造不找」 | 搜硬编码业务号从库里翻现成终态 |
| `NO_ACTION` | AAA 的 Arrange + Act | 压根没做被测动作 |
| `PRESENCE_ONLY` | Test Oracle | 只断「元素在不在」不断值 |

挡在 `reconcile_coverage` 置 GREEN 那一刻。facet 分 content（严格硬拦）/ presence（纯展示只 warn）——**宁漏报边界、用 lintAck 兜误判，别一刀切硬砍**（防「规则过载」重演）。

### 11.5 解析器锚点：两轮才根治

**§3.72（治标）**：`engineSetFacetRow`（writer）用**非锚定**正则找段头，任务档案时间线里只要有一句散文内联了字面「## 覆盖矩阵」（**恰恰是上一轮记录这个 bug 的时间线，自己带了裸标题触发它**），正则就劫持到那处 → 段无表头 → `_rc(lines[-1])` 即 `undefined.split('|')`。读侧早已改成锚定正则并留注释，**写侧却漏改**。

**§3.73（治本）**：行首锚定**只对内联形态成立**。一旦散文把 `## 覆盖矩阵` 写成**独占一行**（巡视 note、markdown 引用标题都会），它同样满足锚定条件、照样劫持。根因是**把「哪一段是覆盖矩阵」锚在标题字面上**——而标题字面在正文里可被合法复述、天然不唯一。正解：`findMatrixSection(text)` 逐个 `## 覆盖矩阵` 标题、看**其正文里有没有 facet 表头行 + 分隔行**，只认有表头的那一段。reader 与 writer **统一走它**。

> **三条教训**：① **锚点要锚在「目标独有且正文不可合法复述」的结构上**。② **修解析坑要 reader/writer 一起改**——同一份文档结构被多处正则解析时，修了一处必须 grep 同结构的其它正则一并改。③ **诊断信息本身别带触发串**——记录「裸 `## 标题` 会劫持正则」的 note，若自己写了裸标题就会复现该 bug。

**还有一条排查教训**：§3.72「已修」却又崩，两个独立原因叠加——**补丁写盘 ≠ 生效**（线上跑的还是旧代码）+ 行首锚定本身治标。**复盘一个「已修仍复现」的 bug，第一件事是确认线上实际加载的版本，别默认磁盘=运行时。**

### 11.6 facet_doc 生命周期门禁

**四层**：① 单一权威纯函数 `validateArchive`（可单测）+ 路径解析包装 `validateArchiveFile`，错误消息**可执行 + 教学**；② 硬门禁接三处进 QA 转换点（GG Bond→迷糊交棒 bounce / `set_entry_status`+`set_task_status` 拒写 / `manual-pass`+`precheck` 端点 400），守航态豁免；③ 软：只读工具 `validate_task_archive` 交棒前自检 + 写工具写后把 warnings 附返回；④ **detective**：`sweepFacetDrift` 与空停巡逻同周期，扫「非终结 + 有条目已进 QA 却缺 facet 基线」→ 广播 + ping owner。

**四条分层取舍**：为什么不「全硬」（校验器判错会在中途硬挡员工；无人值守的守航态硬挡=夜里被卡死）；为什么「进 QA」才挡（facet_doc 是覆盖的分母，进 QA 前才刚需）；为什么**只要 facet_doc 存在+可解析、不要求矩阵已 seed**（矩阵是 QA 进场后第一步才播的）；为什么守航态豁免硬门禁只留软信号（硬挡无人值守 run = strand）。

> **通用教训**：**门禁要挡在「宣告进展」的转换点**，不是散点写侧；且**挡的强度分层**（关键硬、其余软）、**altitude 分层**（进 QA 才挡、早期不挡）；**无人值守流程慎用硬 fail-closed**——会 strand，改用 detective 兜底。

### 11.7 展示与门禁物理分家

`buildCoveragePayload`（看板用，缺 `facet_doc` 只丢验收标准原文、仍用矩阵自身作分母、**不抛、不参与 `qa_passed`**）与 `computeCoverageForRun`（门禁用，缺即抛 fail-closed）**刻意两条路**。

> **理由**：展示逻辑一旦能把门禁判死，就会诱人「为了卡片好看去松门禁」。

### 11.8 残留短板（滚动维护的清单）

1. **软性偷懒面仍在**：`SOURCE_ATTESTED` 可回避真跑。已用「同 REQ 有真绿 → 机读点名」收紧，但**同 REQ 判据是启发式**、点名非硬拒，混合 REQ 仍可能漏点。
2. **硬闸只覆盖「进了矩阵/facet_doc 的 facet」**：facet_doc 本身漏了一条验收点，**闸门无从知道它该测**。
3. **菲斯拉是抽查不是门禁**：只产出发现、无放行/打回权（刻意），对抗审有覆盖上限。
4. **平台层的慢是结构性约束**：单实例串行、长造数链无 checkpoint 续跑、headless 不采 console/network。
5. **夜间无人值守脆弱**：长链跑到一半挂掉仍无断点续跑。
6. **「源码坐实 ≠ 真跑通」是反复出现的母题**：只有真发请求/真渲染才暴露的错配（前端 URL 与后端 `@RequestMapping` 前缀不一致导致 404），源码静读永远看不出。

> **一句话结论**：**「假绿式偷懒」已被机读门禁基本堵死；剩下的是「软性回避真跑」，靠机制点名 + 抽查兜、非零风险。而最强的反偷懒其实是提效本身——把 headless/造数修到能真跑，坐实就没了借口。**

---

## 12. 守航态（无人值守）

### 12.1 概念

同一套任务状态机，按人在不在线切两种执行策略：

- **共驾态 `co_drive`**：人在场，目标**快**。
- **守航态 `guarded_run`**：人不在，目标**稳**。AI 在预授权边界内持续推进，遇不确定项**跳过或隔离，不越权猜测**。

> 命名理由：「夜航」把场景限死在晚上；**「守航」更准**——午休、开会、出差无人值守都能用。

**intake 与澄清模型（关键）**：**自治的边界划在「选择 + 准备 + 提问」，业务口径的澄清永远是在场的人的决定。** 澄清是共驾活动，执行是守航活动。这解掉了「业务口径需老板」的硬墙：**守航只启动于已澄清、已冻结、已祝福的需求，绝不夜间自证资格。**

对照真实团队：PM 梳理 backlog + 干系人澄清（在场）→ 团队执行（可异步/整夜）→ 干系人验收（在场）。**人在对的位置（业务决策 + 验收）、自治在对的位置（选择 + 准备 + 执行）**——这正是与「一次性代码生成器」的分野。

### 12.2 落地形态

- **冷启动入口**：新 UI 侧栏「🌙 守航开工」→ `POST /api/guarded/launch` → 引擎 `issueGuardedContract` 签发契约 `tasks/<日期>-守航契约-guarded-NN.md` + 以 `guarded_run` 派菲菲、**恒不带 `taskFile`**（本轮起点就是「没有卡片」）。`executionMode` 与 `guardContract` 沿交接链传播。
- **契约由引擎显式列字段生成，不做模板字符串替换**：替换既脆（占位符改名即静默失效）又会**漏填不报错**；显式生成能被 code review、字段缺失是语法可见的。代价是模板与生成器两处要同步（已互相点名）。
- **契约的诚实边界写进契约正文**：yaml **不被机器拦截**（Stage 4 拦截层已撤），`max_tokens: null` 旁边直接注明「引擎不强制」——**免得次日读的人把它当成真的护栏**。
- **park 分两段**（`guardedRunPreamble` 规则 8）：**冻结前**允许**整轮停等拍板**（起草期整轮只有一件事就是定口径，此时「跳过该条目」等于整轮空转）；**冻结后**回到 `skip_item`、**不许回头问口径**（否则夜里一条一条来问，等于把守航退化成共驾）。

### 12.3 三红灯与三条口径

| 红灯 | 判据 | 刻意**不**做的事 |
|---|---|---|
| `guard.violation.forbidden_action` | 写/外部副作用动作命中契约 `forbidden`，或 `authorization` 里为 false/未列（**未列即禁**） | **只读动作一律不记不拦**。Stage 4 拦截层就是因为一刀切误杀只读 MCP（平台的 `list_sessions` 之类），把夜里跑的会话直接卡死。本模块**只计数不拦截** |
| `guard.violation.over_budget` | 轮次 / 仓库数 / 运行时长 / token 超 `limits` | **不因超顶杀进程**——夜里被杀死比超支更坏。设 `null` 时改记一条 `budget_unset`，让「没设硬顶」在晨检包里**可见** |
| `guard.fake_green` | 六条派生判据：证据字段不全/哈希非法 · `verify_evidence` 不通过 · `failureClass ≠ value-assertion` · 区分度低于阈值 · 该 run 期间页面报错 · 环境指纹陈旧 | **不许员工自评**，全部从覆盖矩阵 + 证据包派生 |

**观测点选 `tool_use` 流而不是 `canUseTool`**（方案原话是后者，实现时没照做）：员工多为 bypass，SDK 在咨询 `canUseTool` 之前就放行——**那条路是死代码**。真正能覆盖全部权限模式的位置只有 `consumeStream` 里 `assistant` 消息的内容块。副作用是子 agent 的调用也会被记（`parent_tool_use_id` 非空照记）——**这是刻意的：越权就是越权，换个 subagent 的马甲不该洗白。**

**台账按契约 `run_name` 聚合，不按 `run.id`**：一轮守航是整条交接链（菲菲→GG Bond→迷糊→波比），契约约束的是这一整轮。按会话聚合的话「本轮越权几次」永远只能看到最后一棒那点局部。

**三条通用口径**（适用面远超守航）：

1. **新指标不许自带虚假健康值** —— 见 §12.4。
2. **门禁的输入分「机器事实」与「人填字段」，人填的只作下限** —— `classifyRisk` 从 DDL / 权限变化 / 触碰主数据 / 回填 >1000 行 / 净改动 >800 行 / 改动文件 >40 个 / 不可逆外部副作用（**测试路径也算**）自动顶 high，并在晨检包里**显式印「机器定级 X 高于人填的 Y」**——不是悄悄改掉，而是让这次低估被看见。
   > 理由是硬事实：某条 `risk_class: high` 的需求，**表里填的就不是 high**，于是整条留在守航里做，代价 4 天长尾 + 2 个逃逸缺陷 + 10635 行回填风险。**门禁的输入必须是它自己能验的事实，不能是被门禁对象提供的自述**（填表的人和被门禁的人是同一批）。
3. **判据能挪到「事件发生那一刻」的就别留给事后巡视** —— 见 §6.4。

### 12.4 本版最重要的设计决定：fail-closed 第三态

外部平台承诺的四个新接口（`verify_evidence` / `report-card` / `preflight` / `get_env_fingerprint`）写这一层时**一个都还没上线**（实测探活六个端点全 404）。

`zhuzhu-capabilities.js` 的第一性原则：**接口缺位 → 返回 `{available:false, why}`，让上层把结论写成「未验证」，绝不把「问不到」当成「通过」。**

**为什么这条比接口本身还重要**：fail-open 会让 `guard.fake_green` **永远是 0——那比没建更坏**，因为纸面上「三灯全 0」和「从没统计过」长得**一模一样**。**不能让一个新建的指标一出生就自带一个虚假的健康值。**

落到每一处的具体形态：

- `deriveFakeGreen` 把缺位的 GREEN 记进 `unverified` 数组（**不计红灯，但也不算可信绿**），渲染时显式印「假绿只算了引擎自己能算的那一半」。
- `classifyRedCalibration` 缺 `failureClass` 时判 `unknown` —— **不是 pass**。
- `preflightGates` 返回 **`ok: null`**（而不是 `false` 或 `true`），调用方据此写「门开不了 ≠ 门通过」。
- `rcReadyGate` 把「未验证」的门与「未通过」的门一起算进 `blocked`。
- `fakeGreenHunt` 里再进一步：**环境指纹整体陈旧 → 可信度直接判 0**，不是逐条打折（逐条打折会把整批不可信粉饰成「大部分可信」）。
- 晨检包有一节专门印「本轮哪些机器门是开的」；看板设置页也有「探活一次」按钮 —— **界面上看不见哪些缺位，人就会默认「应该都通了」，于是「未验证」被读成「通过」，假绿又回来了。**

**唯一做了「有效降级」的一项**是 UI 契约：平台 `/ui-contract` 不可用时退回本地 `app/ui-contract.js` 抽取的产物，按「同一 testid 出现在多个 (board, subTab) 组合」推导「组件被多入口复用」。理由是它是「跨入口一致性 facet」的直接解药，价值不该被一个未上线接口整条挡住。

### 12.5 第三条路：降级但留痕

RED 校准判据换成结构判据时，**没有选 fail-closed 判不校准**。理由与第三态一脉相承但方向相反：

- 「未验证 ≠ 通过」适用于**我们在声称某件事已被验证**的场合（假绿）；
- 但这里如果直接判不校准，**今天所有 QA 轮会一夜之间全签不出 RED**，那是真回归（平台 `failureClass` 还没上线，谁也拿不到）。

所以选了第三条路：**降级但留痕**。RED 证据串里多一个 `redBasis=title-regex`，`deriveFakeGreen` 把这些 facet 单列成「RED 校准走了正则降级」，`reconcile_coverage` 的返回也直说「别据此认为后门已关」。

> **通用形态**：当一条新判据的依赖还没到位、而旧判据不能直接拿掉时，第三条路是「用旧的、但把这件事标出来」。**最坏的做法是悄悄用旧的还宣称已经换了新的。**

### 12.6 晨检验收单：两次重构

**第一次（填空白）**：老板点开一份包发现「计划条目 0 / version 空 / archive 空 / RC commit 未记录」。四个根因**全是「读的一侧建好了、写的一侧从没建」**：

| # | 症状 | 根因 |
|---|---|---|
| 1 | 计划条目 0 | `led.itemResults` **全仓只有一处读、没有任何代码写**（`grep -rn itemResults app/` 只有 1 处命中） |
| 2 | version/archive 空 | 守航 run 的 `taskFile` **32 条全是 null**（冷启动那一棒本来就没档案，错在建完档之后没有任何路径把它回填回 run——而档案路径其实一直在契约 frontmatter 里，只是没人去读） |
| 3 | 整章消失且毫无标注 | `reportGaps()` 的结果只出现在给 agent 的返回文本里，**没写进包**；而前端 toast 已经在对老板说「已在包里如实标注」 |
| 4 | 每天开机重出空包 | 包名带今天、run 名是昨天，去重集只活在内存 → 重启即重置 |

修法：`deriveItems()` 吃**五个机器源**（契约 `named_items` / 台账 `itemResults` / `risk_gate` 定级 / park 台账 / 覆盖矩阵），绿数、证据 commit、RED 校准、需人工必验**一律以覆盖矩阵为准**；agent 传来的 items 只填机器算不出的空格，连 agent 的散文都被挪到「（agent 补注：…）」挂在机器结论后面 —— **诚实铁律在这一层的具体形态就是不给自述留一个能顶掉机器事实的字段**。写侧同时补上，且**记在动作发生的当下**。

**第二次（改单位）**：三天后老板说「概念很混乱，5.20 我多次守航追加条目，晨检包只展示了一开始的 2 条需求」。根因一句话：**档案与 facet 表是版本级的，契约与台账是轮次级的，晨检包夹在中间取哪边都不对。**

> **最刺眼的是模板自己**：第五章白纸黑字写着「**整版**通过 / 部分通过 / **整版**打回」——版本级的决策语言，底下垫着轮次级的数据。**概念从模板那一层就分叉了，代码只是忠实地实现了这个分叉。**

重构为 `version-report.js`：以**登记表为行集**，覆盖矩阵/台账/门禁只补列；矩阵有而登记表无的 REQ 单列 `orphanReqs`、**绝不混进主表**（「这一版有几条」不许有第二个答案）。

**park 的病根不是「缺关闭路径」，是一个计数器装了两种语义**：台账里混着**真歧义**（PM 写了实质拟定口径，要老板一句话）与**引擎到点顺延的占位**，共用 `rounds`。于是「≥2 轮进必答区」**长期完全是反的**——必答区里全是顺延噪声，8 条真歧义全部 rounds=1、一条都进不去。先分家（`PARK_KIND`，旧数据按指纹回填），再谈出口。出口用**白名单三档**而不是「状态≠parked」的黑名单，两条边界值得单记：
- **关闭口径收窄到「已上线/已归档」，不含「人工Pass/QA通过」**——过检 ≠ 发布。某条过检了，但它被 park 的那个问题在发布前**仍然是活的**。
- **真歧义在推进中只降级、不关闭**，并单列一节写明「条目已推进，但你当初被 park 的口径问题从未被回答——后续多半是按拟定口径默认执行落地的，你要么追认、要么现在推翻」。**这句话是这次重构真正的价值增量。**

**第三次（改载体）**：老板追问「能不能跟任务档案合并」。核实后三条事实都指向「本来就该合」：主键改成版本后验收单与档案已 1:1；晨检包文件**没有任何机器消费者**；仓库里已有先例（facet 覆盖抽屉就是「视图不落文件」）。于是改成**任务卡上的「晨检验收」页签**（`GET /api/version-report`）。

> **一条值得单记的判据**：**派生内容落成文件，就必须再造一套「防它过期」的机制。** 为了让文件不过期专门加的 `sweepVersionReports()`（每 5 分钟扫一遍、每天重出一份）改成视图后**整套删掉**了——视图的新鲜是免费的。**「要不要落文件」这个决定，附带决定了「要不要养一套保鲜机制」**，而后者的成本常常比前者高，还会自己长出新的失败模式（文件在、内容过期，比没有更坏）。
> 同时否掉了「写成档案里的一节」——那只是把重复从「另一个文件」搬到「同一个文件的另一节」。**判据是「这份内容有没有人手写」**：全派生的就该是视图，`tasks/` 里只留人写的和需要定格的。

**顺手修掉的自引入 P0**：`recordPark` 命中已有条目时会覆盖 `reason`/`proposal`。deadline 顺延此前因 `itemResults` 恒空**从来没真触发过**；把条目账接通后它首次触发，**把 PM 写的实质口径整段覆盖成了「deadline 到点未达 RC_READY」**。
> **教训**：**给一条长期沉默的代码路径接上输入之前，先读一遍它被触发后会写什么。** 「它一直没跑」不等于「它跑起来是对的」——恰恰相反，从没跑过的路径没有被任何真实数据检验过。

### 12.7 「事实打架时不静默选边」

实测撞上一条：park 台账里挂着「等 DDL 授权」，覆盖矩阵却是 6/6 全绿。判据是**证据的产权**：`COVERED_GREEN` 只能由引擎从真 summary 机读签发、禁止手填，而 park 只是 PM 侧的一条笔记。所以：证据更晚 → 按证据算并在表下点名「park 记录已过期」；park 更晚 → 维持 park，**同样点名**（全绿之后又被 park 是真事）。**两种情形都留一行，绝不选完一边就把另一边抹掉。**

### 12.8 首两轮真实守航的诚实结论

**行为纪律成立**（park 不猜、不降标换绿、不碰生产），**不足全部集中在结构缺席**：

| 层 | 不足 |
|---|---|
| 契约 | 三个「必须为 0」的红灯一次都没被机器统计过；`max_tokens` 四轮全空；晨检包**零实例**；deadline 无结算动作；资格门被「点名 + 夜里拍板」绕过 |
| 版本 | `max_items` 只约束单轮不约束版本；已完成品被大件拖住（守航最该证明的指标在本版是 4 天而非 1 夜）；两态切换不显式 |
| **证据（最重）** | 两个真缺陷都逃过了「17/17 COVERED_GREEN + RED 完整」。根因 1：facet 全是单点行为，**没有一条问「同一份数据在四个入口看起来一样吗」**；根因 2：**headless 不采 `console`/`pageerror`，「点一下就抛 TypeError」在 headless 里不可能变红** |
| 隔离 | 一个库同时是开发库和测试库；QA 造数直写全局主数据；三隔离层一层都没落地——**QA 测的是 working tree，不是不可变 commit** |
| 交付 | committed ≠ working tree（连续两版复现）；生产半发布（只 commit 未 push → MR 报 "no commits yet"） |
| Intake | 「零业务待决」筛出的是**最小可自证实现，不是用户要的那件事**；park 队列不消化（同两条连续 park 3 轮） |
| 运行 | 79 次巡视只 2 次真停；冷 resume 后「从头重来」的倾向依然存在 |

> **一句话**：*协同安全来自结构，不来自更乖的人格。* 这个结论有 Anthropic 前沿红队报告《Patterns and problems in emerging multiagent systems》背书——**「失败的形状更取决于环境结构而非模型性格」**。

---

## 13. 渠道层

### 13.1 企微：一次关键的架构转向

**初版被用户当场否掉**：把企微消息无条件转 RAG `/api/ask`、人设在 RAG 服务端。两条病根：① **每句话都检索**（连「你好」都答「正在检索知识库」）；② **外部渠道等于能直接驱动员工**（谁在企微发消息都能触发干活，绕开看板门禁）。

**三原则（用户拍板）**：

1. **渠道 = 纯 I/O，不是开工信号**。正式派工/开工只在看板由用户发起。sidecar 退化为哑管道，不判断意图、不查库、不派工。
2. **主人格在 office-lab**（唯一事实源）。收到企微消息的是 office-lab 的 agent 本人，不是 RAG。
3. **知识库(RAG)、飞书文档 = 主人格按需调用的工具**，不是本体。

**为什么主人格运行时独立于看板 run 机制**：现有 `startRun/createDispatchRun` 深绑任务语义（任务快照、autoChain、appendLessons、标记解析），若复用会误触发派工/接棒。故另建精简的 `personaSessions`：只做「消息进→（按需用工具）→文本出」，结构上碰不到 `runs` 注册表——**企微对话永不进看板**（已验证：跑三类消息，`/api/runs` 无新增）。

**几个实现细节**：
- **防抖攒批 vs 企微 5s 首帧窗口**：sidecar 按 userid 攒 buffer、静默 1.5s 后合并。解法不是「每条都先垫开场」（那会让单条「你好」也蹦「稍候」），而是**分情形**：单条 → flush 里先给答案一个 2.5s 短窗口，秒答直发、慢才垫开场；一旦**成 burst（第 2 条到达）**才立刻秒回开场占窗口。**只有确实要等才占窗口。** 防刷兜底：超 20 条/8000 字立即 flush。
- **读图并入防抖 buffer**：不给图片单开链路，塞进已有 buffer（扩 `images`），让「文字+截图连发」在同一批合并成一次 query。**raw base64 不落 `conversations.jsonl`**（记忆/看板只标 `[图片×N]`）。
- **对话记忆 = 落盘日志，不是内存**：每轮把「来信 + 回复」写进 `conversations.jsonl`（复用 `logConversation`，`kind='wecom'`、`threadRootId=wecom:<userid>`）。**一个人格、一份记忆**：看板 agent 和企微轻量人格都挂同一个只读 MCP 读同一份日志——所以两个入口天然一致，不需要同步。**pull 而非 push**（给工具按需查，不把历史塞 prompt）。
- **KB 按人限额**：**硬控放工具代码、不放人设 prompt**——LLM 数不准也守不住，而且一条用户消息里它可能自主查库 0 到多次。计数与拦截落在工具入口（`makePersonaCaps(uid)` 已把 uid 闭包进来）。**策略与用量分两个文件**（策略人低频改要可读；计数机器高频写、按本地日期每日重置）——混一个文件会让「人编辑配置」和「机器写计数」互相打架。
- **两条链路各自可自检**：RAG 连通测试只证明「答题服务在」；企微凭证是否有效必须真连企微 → 加企微连通测试。设计上「sidecar 在跑就读实时上报状态、没跑才起短命 `--probe`」——避免同 BotID 起第二条连接把在服务的连接互踢下线。
- **懒导入保测试性**：`aibot`/`aiohttp` 均在函数内延迟导入，使 `config`/`format`/`office_client`/`_decide` 等纯逻辑无需装 SDK 即可 `py_compile` + 断言验证。

**一个能力缺口（后补）**：老板在企微问「5.16 到什么进度了」，她回的是**飞书需求表**内容。根因不是答错——企微人格被**刻意关在文件系统外**（deny `Read/Glob/Grep/Bash`），全部 9 个工具里**没有一个能读 `tasks/` 任务档案**，而那才是版本进度的唯一状态源。**正解是给人格开一条只读窄通道读源**（`query_version_progress`，handler 是引擎侧 `fs.readFileSync`，不放开 Claude 的文件系统权限），而不是「让人格去对话式驱动员工」（那多绕一层、没多拿一个字，还要起一整个 run）。
> **顺带坐实的坑**：**frontmatter 的 `status` 字段不可信**——某版字面停在 `QA_PASSED` 但 `gates.released_test` 已 true、还在做增量。进度**必须** `gates` + 条目登记表逐条状态 + 时间线尾**三者交叉**。**版本级 status 是叙事标签、会滞后，颗粒度真相在条目与 gates。**

### 13.2 飞书：从 npx 到直连，从记性到对账

**弃用 `npx lark-mcp` 的教训**：飞书读走 `npx -y @larksuiteoapi/lark-mcp` 外部子进程——本机没装、npx 首次要联网下载、registry 慢 → 子进程起不来，菲菲根本没飞书工具（凭证 scope 其实都对）。
> **能力工具优先 in-process**——`npx`/外部子进程在离线/慢网/未装的机器上是隐形炸弹，且每次 spawn 还拖慢启动。

**下游超时必须显著小于上游超时**：`knowledge_base_query` 超时和 sidecar→office-lab 的 HTTP 超时都设 180s，撞一起 → 本地 RAG 一慢，KB 等满 180s 时 HTTP 也超时 → 用户看到「刚出了点岔子」。**慢依赖要能「快速失败 + 降级」**。

**两次静默截断（同族）**：
- **§3.59 单页不翻页**：`larkListRecords` 只发一次请求就 `return data.data.items`，**没有 `page_token`/`has_more` 翻页循环**。表超过单页上限时多出的记录被**静默丢弃、不报错**。当时表约 132 条、未到上限，所以传 `limit=500` 恰好拉全，**掩盖**了这个 bug。
- **§3.94 每字段 60 字**：`larkFmtRecord` 里一句 `larkCellText(v).slice(0, 60)` —— **对每个字段一刀 60 字**。需求正文普遍 100~400 字，于是 PM 看到的是断在句中的碎片，「口径模糊」这个判断本身就是碎片的产物。**三层放大**：截断是静默的、无补救通路（keyword 查也走同一格式化）、附件不可读（只看到文件名却没有任何提示）。

> **同一张表、同一种病：把「压缩显示」当成了「数据接口」。**
> **① 给模型的「显示格式化」不能兼任「数据读取接口」**——面向人眼的一行摘要一旦成为 agent 的唯一输入，它的判断质量就被格式化参数悄悄封顶了。要么区分 list/detail 两个通路，要么让截断自己喊出来。
> **② 截断必须自证**——一句「还有 N 字，用 X 读全文」就能把死路变成可走的路；**它省下的不是字符，是一次误判**。

**状态对账（不是回调）**：某版早已发线上，飞书表里那几条 REQ 还挂「待处理」。三条结构性根因：纪律只写在 SOP 里；**流水线最后一棒不是 PM**（发线上和收尾都是 DevOps，PM 那一棒若没被再派一次，就没人去翻表）；没有可挂的事件（gate 是员工手写 frontmatter，引擎里根本没有「gate 翻转」回调）。

对策 `syncLarkFromArchives()`：**任务档案 = 事实源，需求表 = 投影**。三路触发（`fs.watch` debounce 5s + 全局最小间隔 2min / 30 分钟定时兜底 / 手动端点支持 `dryRun`）。

**几个刻意取舍**：
- **双向，不是单调前进**（老板当场纠正：「可能要支持回退」）。第一版是「只往前推」，但那样发布回滚、条目被 park、需求移出版本都会让表停在一个已不成立的「已完成」上。放开方向后护栏从「限方向」改成**限爆炸半径**：单轮降级 >3 条 → **整批不写、只报告 + 通知等人确认**。
- **多档案同 REQ 取 `fm.updated` 最新的那份**，不取「秩最高」——取最高秩看似安全，实则**等于禁止回退**。
- **只碰三个字段**；**「拒绝」行整行不碰**（那是分诊决定不是流程态）；**表里没有的 REQ 只报告不新建**。
- **降级离开「已完成」时清空上线日期**——留一个已不成立的上线日比空着更糟。
- **幂等靠「归一化再比」**：日期字段（bitable type 5）存 epoch ms，**不能拿它的字面量跟 `YYYY-MM-DD` 比**——第一版正是这么写的，离线测试立刻照出「每轮都判不一致、每轮重写一遍」（白打 API + 审计日志全是噪声）。
  > **幂等性要拿「复跑一次」验，不能只看「首跑对不对」。**

### 13.3 企微智能表格镜像：四修 + 一个终极方言

这是「第三方集成」最完整的案例。

**决策历程（从最重砍到最轻，每步都由坑逼出来）**：
1. 想「企微直连 CRUD」（对标飞书那套）→ 要 WeDoc 智能表格 API + 自建应用 corpid/secret，已实现一版。
2. **踩坑一：机器人 ≠ 自建应用**。群机器人 webhook 只能单向发消息；智能机器人（长连接 aibot）也只是聊天渠道，它的 BotSecret **喂不进 `gettoken`**。**心智模型：渠道（被搭话）≠ 能力（改表）。**
3. **踩坑二：手动建的表 API 接管不了**（只有 API 新建的才有可用 docid）。
4. 老板问 `path/101239` → 那是智能表格「**接收外部数据**」Webhook：工作表菜单开一下得一个 URL，POST 就能写，**不用自建应用、不用可信 IP、手动建的表也能用**。只能写、不能读/删/管字段。
5. **老板拍定：飞书 = 唯一权威主表，企微 = 只读镜像** → **直连那套整个删掉**。

> **为什么最终方案最优（约束反而变简单）**：只读镜像 = **只写不读**，正好卡进 Webhook 的能力边界（读/删/管字段的缺失全都用不到）；零凭证纠纷、零可信 IP、手动表可用；单向投影 = **零一致性负担**。
> **通用教训**：**能只写就别要能读的复杂度**——把需求收敛成「单向只读镜像」后，Webhook 这个受限但零门槛的通道刚好够用，砍掉了直连方案 90% 的前置。**约束不是在「能力表」上比大小，而是看你真正要用到的那几格。** 而且**别怕推翻自己刚写的**：直连那版未联调未提交，识别到 Webhook 更贴需求就整体回退。

**然后是四轮修**：

| 轮 | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 点「立即同步」无反馈、企微也没内容 | ① 逐行单发撞**调用频率**限制（30+ 行背靠背，45009 `Too many requests`）；② **假成功 + 无反馈**（逐行失败被 `try{}catch{console.warn}` 吞掉，`count` 只累加成功行=0，外层 try 正常走完 → 返回 `{ok:true,count:0}`，前端当成功） | 批量 `add_records[]`/`update_records[]`（30+ 请求 → 1 次）+ 批次间 400ms + 45009 指数退避；**失败必须「响」**：加 `failed` 计数，全失败明确 `{ok:false}` |
| 2 | 整批 161 行报 40058 `invalid Request Parameter` | **批量是原子的**：某一行参数非法会让整批连坐。老板一度想「加大阈值」——但 40058 不是频率问题，加大批只会让连坐范围更大 | **自适应二分降级**：整批失败就对半二分、递归到单行，把真正非法的那行隔离 |
| 3 | 二分降到单行、**每一行仍报 40058** | 排除「个别行数据坏」，指向系统性问题。核对权威格式：webhook 新增的顶层键是 **`add_records`** 而非服务端 API 的 `records` | 改键名 + 返回体解析 |
| 4 | 还是失败 | ① **修好的代码从没跑过**——`server.out.log` 里最后一条请求体顶层键**仍是旧的 `records`**（`grep -c add_records` = **0**）；② 即便重启也仍会 40058——**整套请求体用错了「方言」** | 照抄目标资源自己给的「示例数据」结构：`{schema:{FIELD_ID:{title,type}}, add_records:[{values:{FIELD_ID: 纯文本}}]}`，去掉 `key_type` |

**两套方言的对照**（这张表是本节的核心）：

| | webhook「接收外部数据」 | access_token 服务端 API |
|---|---|---|
| 顶层键 | `add_records` / `update_records` | `records` |
| 字段键 | **FIELD_ID** | 字段**标题** |
| `key_type` | **不带** | `CELL_VALUE_KEY_TYPE_FIELD_TITLE` |
| 值形态 | **纯文本** | `[{type:'text',text}]` 类型数组 |

> **四条通用教训**：
> ① **「改了代码」和「代码在跑」是两回事**——需重启的服务，验证第一步是翻日志看真实请求体属于哪一版，而不是看源码；**一个「从没重启」能让三轮正确修复全部白费。**
> ② 对接第三方，先分清「**同名不同套**」的方言；**权威模板不是文档里的通用示例，而是目标资源自己给的「示例数据」，照抄它最省事。**
> ③ **逐格排错要一次对齐所有格**——只改对顶层键一格、留着另外三格错方言，于是「改对了还是错」，误导了排查方向。
> ④ **FIELD_ID 这类「跟着目标表走、会变」的标识别硬编码进逻辑**，抽到配置、给默认值 + 可覆盖。
> ⑤ **空结果要区分「跑了但被拒」vs「跑了但没数据」**——`wecom-mirror-map.json` 从建起就恒空，本该第一时间怀疑写入格式/契约，而不是先赖到运行期的限流/数据。**翻请求体比翻限流日志更快到根。**

**幂等映射的持久化时机就是可靠性的命门**（老板一问「我们系统定时写数据，不会重复吗？」逼出来的）：webhook 的 add 是**非幂等**的（每次都新建行、无按键 upsert），且 webhook **删不掉行** → 「不重复」100% 靠本地映射表。稳态不会重复（`toAdd`/`toUpdate` 分流 + `_mirrorSyncing` 锁），**但有一个真实窗口**：`saveMirrorMap` 原本只在整轮末尾落一次盘，而 add 是分批发、回填的 record_id 先只存在**内存**。若进程在「已写企微、尚未落盘 map」之间被杀，这批行在企微已存在、磁盘 map 却没记 → 下一轮当「未镜像」**再 add 一遍 → 重复行且清不掉**。此窗口在**首次全量**时最大。

修法：**映射增量落盘**（每批成功回填即 `persist()`）。**幂等窗口消不掉、只能收敛**：目标不是「零窗口」（远程与本地之间总有间隙），而是把窗口缩到单次远程调用。
> 顺带：**运维纪律要和代码假设对齐**——「重启走托盘别强杀」这条纪律，其价值之一正是避开这类「中途落盘前被杀」的窗口；反过来，代码也不该假设「永不中途被杀」。

### 13.4 企微 wecom-cli：撞在「能力分项授权」上

唯一一次**破例引入外部二进制**。与「优先 in-process」的张力这样化解：**§3.20 的真凶其实是 npx**（每次调用现拉、离线即炸）；`wecom-cli` 是一次 `npm i -g` 装好的本地二进制，调用零网络前置，**风险性质完全不同**。且企微文档能力**没有**可直连的等价 REST 路径。

**两个判断错误，都值得记**：

1. **拿三个月前的社区 issue 当当前平台行为的依据**。据 5 月的 issue 判定「企业模式读也不继承」，据此把方案设计成「必须新建表 + 全量迁移」；而 8 月这版实测是**读放宽、写受限**（`identity whoami` 原文：「真人授权用户创建或拥有的数据你可以读取，但你只能写入或修改机器人创建或拥有的数据」）。
   > **当前行为要问平台自己**——`identity whoami` 这类自描述接口一句话就把权限边界讲清了，本该第一步就跑。
2. **不可逆操作之前没先量目标数据的真实形状**。以为 4 列 130 行、**实际 19 列 206 行**，且「提出人」「提出时间」两列的类型和想象相反（是文本不是人员/日期）。而智能表格**文件本身永久删不掉**——建错了就永远留在那。

**★ 真正拦下方案的墙：能力是「按项」授权的，读和写分属两项。** 扫码授权后所有 `doc` 家族调用返回 `851008 **partial** no authorization`。老板去授权页开了一轮，回来实测得到一张极不对称的表：`smartsheet create` ✅、`records add` ✅、`sheets list` ❌、`fields list` ❌、`records query` ❌、`doc search` ❌、`message aibot sessions list` ✅（说明授权本身生效）。

**为什么「读不出」就必须降级、而不是先用起来**：① 答不了「需求表里有哪些/待处理有哪些」——那恰恰是最高频用途；② 迁移 206 行无法校验（写完读不回来 = 闭眼倒数据）；③ 最要紧的是，往一张读不出来的表里登记需求，会把台账劈成「飞书能查的」+「企微查不了的」两半，**比不写更糟**。

**降级怎么落的（关键设计）**：把「启用」和「当主表」**拆成两个开关**（`enabled` / `isPrimary`）。只有 `isPrimary` 为真才让六个 `wecom_*` 工具真正干活（否则由 `wecomDegraded()` 闸住、只回一句降级说明，防止劈台账），并让旧 webhook 镜像自动退场（`mirrorAutoRetired()`）。降级期两者皆假 → **旧镜像照常跑、同事的渠道零中断**，代码全保留、一行不删。

> **五条通用教训**：
> ① **「平台支持 X」要追问「以谁的身份、按哪几项授权支持」**。**权限模型比接口签名更值得先问清**——签名错了报参数错误一眼能懂，权限模型错了报的是一个看起来像「配错了」的码，然后你在分享链接、scode、重新授权、缓存之间反复打转。
> ② **「partial no authorization」这种词要当真**——一个 `partial` 就是在提示「按项授权、你只缺其中几项」。别一把归零，按项去探。
> ③ **能力「就绪但不可用」要能被如实表达，别用一个开关硬凑**——一个开关的设计会逼你在「假装能用」和「假装没做」之间二选一。
> ④ **撞墙了要降级，不要硬上**。**降级的判据不是「能不能跑」，而是「跑起来会不会比现状更差」。**
> ⑤ **Windows 上不要 `execFile` 那个 `.cmd` shim**（必须 `shell:true`，随之是引号地狱 + 注入面）——改为直接用当前 node 跑 `@wecom/cli/bin/wecom.js`，`shell:false` + 参数数组，一次绕开两个问题。

### 13.5 推送

- **Bark**：收工/异常/中断/审批挂起；用员工头像作图标；点通知开手机审批页可直接同意/拒绝。
- **LLM 精炼** `summarizeForPush`：起独立 Sonnet 把四段汇报压成 ≤2 句口语通知。**`cwd` 用临时目录**——避免加载本仓 CLAUDE.md 把要约从 8k 撑到 41k token。超时/失败回落截断版。
- **本地通知** `/api/notifications`：增量流供 Windows 托盘转原生 Toast，与 Bark 解耦、不受 `pushConfig.enabled` 限制。

---

## 14. HTTP / SSE 层与性能收口

### 14.1 端点分组（~50 个）

| 组 | 端点 |
|---|---|
| 看板/资料 | `/api/employees`、`/api/employees/:k/detail`、`/api/tasks`、`/api/file`、`/api/runs`、`/api/conversations`、`/api/coverage`、`/api/version-report`、`/api/pending`、`/api/quick-actions` |
| 运行 | `/api/dispatch`、`/api/runs/:id/reply`（含 takeover）、`/permission`、`/stop`、`/history`、`/patrol-cancel`、`DELETE /api/runs/:id`、`/api/runs/:id/events`（SSE）、`/api/events`（全局 SSE） |
| 配置/能力 | `push-config`、`chain-config`、`zhuzhu-config`、`wecom-config`、`lark-config`、`wecom-mirror-config`、`wecom-doc-config`（各 GET+POST）+ `push-test`、`zhuzhu-test`、`zhuzhu-capabilities`、`wecom-test`、`wecom-connect-test`、`patrol-status`、`health`/`healthz` |
| 渠道 | `/api/wecom/persona-reply`（token 守卫）、`/api/wecom/ingest-images`、`/api/wecom-bot/runtime`（`X-Internal-Token` 守卫）、`/api/wecom-bot/report`、`/api/wecom-status`、`/api/lark/fields`、`/api/lark/sync`、`/api/wecom-mirror/sync`、`/api/wecom-doc/*` |
| 守航 | `/api/guarded/launch`、`/api/guarded/ledger`、`/api/guarded/morning-report`、`/api/version-report/decision` |
| 人工写入 | `/api/task/manual-pass`、`/api/task/precheck`、`/api/upload`、`/api/notifications`、`/approve`（手机审批页） |
| 会议 | `/api/meetings*`（6 个） |

**唯一的服务端写档案点**：`POST /api/task/manual-pass`（用户自测通过时勾掉「流程状态」首个未勾项 / 把条目状态置「人工Pass」）。**不做 git commit**（守禁自动提交）。原则上 `.md` 只由员工 Claude 写。

### 14.2 SSE

- **全局 `/api/events`**：30+ 事件类型。`broadcast(obj)` 往 `globalClients` Set 写 `data: {...obj, _ts}`。
- **单 run `/api/runs/:id/events`**：冷开按「有意义消息」配额回放（`INITIAL_TAIL_MSGS=12`），SSE id 是**绝对行号**（= `appendEvent` 的 `nextSeq`），所以浏览器自带 `Last-Event-ID` 断点续传照常工作。

**一个窗口一缩小就暴露的真 bug**：冷开窗口从 3000 缩到 40 后，原 `floor = Math.max(lastId, len - TAIL)` 立刻出问题——重连（带 `Last-Event-ID`）本意是补 `lastId` 之后的全部增量，但 TAIL=40 时若断线较久（`len-40 > lastId`），`max` 会取 `len-40`、**跳过 `[lastId, len-40)`**。TAIL=3000 时这个 bug 被掩盖。修法：冷开才用 `len-INITIAL_TAIL`，**重连分支直接用 `lastId`**、不再取 max。
> **教训**：一个常量从「大到几乎不触发边界」调到「小到常触发」，要重扫所有用到它的边界逻辑——**掩盖的 bug 会立刻现形**。

**分页配额单位改过一次**：原按「事件数」（40 条/页），随着子代理编排普及，**一轮问答里的事件构成彻底变形**——单条派工能带出一个子代理块 + 十几次 tool_use/tool_result + 多条系统签，40 个事件常常连一条真正的对话气泡都凑不满。改为只数「有意义消息」（用户气泡、助手文字气泡、及渲染成用户气泡的少数 lab 事件），工具/子代理/后台/系统签**不占配额但仍随范围整段返回**。
> **教训**：当「一条记录」的信噪构成会随产品形态漂移时，按记录数配额迟早失真——**配额要记在用户可感知的信号单位上，噪声只搭车不占额。**

### 14.3 性能收口（两轮）

**第一轮（静态资源）**：`serveStaticFile`/`sendDynamicText`/`compressBuf`/`pickEnc`。

- **头像缩图**：为何用 PowerShell + System.Drawing（零依赖约束下唯一可用）；缩到长边 160px；脚本做成**可复用 + 幂等 + 非劣化**。
  > **翻车与诚实记录**：第一版**没做「非劣化」判断就直接跑了**，把一张 6.8KB 的高优化索引色小图用 System.Drawing 重存成 32 位 RGBA、反而涨到 58KB，而**原始紧凑编码没有任何备份、无法找回**。**破坏性批处理要么先备份、要么第一版就带非劣化/幂等护栏，别「先跑一版看看」**——尤其对 git 未跟踪、无回滚的文件。
- **压缩为何 br + 内存缓存 + q6**：按 `Accept-Encoding` 优先 br、次 gzip、都不支持裸发；结果按 `abs+mtime` 缓存在内存；q6 而非默认 q11（压缩比接近、耗时低得多）。
- **缓存头分两档 + index.html 的坑**：带 `?v=` 的版本化请求 → `max-age=31536000, immutable`；其余 → `max-age=86400` + `ETag`/`Last-Modified` 走 304。**index.html 必须留 `no-cache` 且刻意不发 ETag/Last-Modified**——它是版本指针，靠注入的 `?v=<mtime>` 给子资源破缓存；若给它上 304 校验器，改了 `app.js` 但 index.html 自身 mtime 没变时会命中 304、复用旧壳里的旧 `?v=`，**新资源永远加载不到**。

**第二轮（API + 轮询 + dev server）**——起因是「§3.47 只治了看得见的那半边」：

- **`json()` 单点收口**：GET 且 body >1KB → br(q5)/gzip + `ETag=sha1(body)` + `Cache-Control: no-cache`，`If-None-Match` 命中直接 304 空 body。
  - **为什么 `no-cache` 而不是别的**：浏览器 `fetch` 会自动带 `If-None-Match` 重验、304 由浏览器透明还原成 200+缓存 body → **前端零改动**就吃到收益。
  - **为什么用 `res.req` 而不给 `json()` 加参数**：调用点约 150 处，Node 原生就在 response 上挂了 request。
  - **SSE 与文件下载不经 `json()`**（各自 `writeHead` 流式输出），所以压缩绝不能挂到通用 `writeHead` 上——那会把长连接缓冲住。
- **`runListView` 投影**：`instruction`/`result` 只发前 200 字（`LIST_HEAD`），另发 `resultTail`（末 300 字，`LIST_TAIL`）。**取舍点**：这俩字段占列表体积 **91%**，而列表侧真实需求只有摘要 ≤60 字、两行截断预览、以及认 `result` **尾部**的机器可读标记。**尾段必须单列字段**——只截头会把「员工待拍板」状态全判丢（标记在末行），而只发尾段又会让会话列表显示成「…句子后半截」。字段名沿用 SSE `run-status` 早就有的 `resultTail` 口径，不另造词。

**量化（772 条真实 run，隔离实例实测）**

| | 改前 | 改后首次 | 改后未变 |
|---|---|---|---|
| `/api/runs` 线上字节 | 3586 KB（明文） | **320 KB**（br，107ms） | **0 KB**（304，19ms） |
| `/api/tasks` | 176 KB | **47 KB** | 0 KB（304） |
| `/api/runs` 轮询路数 | 4 路（10s+15s×3） | **1 路（10s）** | 后台标签页 **0** |
| 首屏静态请求数 | dev：数百个模块 | **15 个**（含字体） | 多数 304 |

> **三条教训**：① 「隧道是放大镜」还得再加一句——**镜头要覆盖全部出口**。凡「压缩/缓存/限流」这类横切策略，落点应该是**唯一出口**，而不是「当前看到的那几个分支」。② **轮询是会自己繁殖的**：每个组件「顺手」加一行 `usePoll('/api/runs')` 都局部合理，四处合起来就是 14MB/15s——**横切关注点必须收在 hook 层做合流，靠 code review 逐处提醒是治不住的**。③ **「本地开发怎么跑」和「远程怎么访问」是两个问题**：dev server 上隧道这种事，本机一点感觉都没有。

**一条启动期的矛盾**：为了「单条 run 的异步异常不拖垮办公室」装了 `process.on('uncaughtException', e => console.error(...))` **只记录不退出** → 端口被占时 EADDRINUSE 作为 server 的 `error` 事件抛出，无监听则升级为 `uncaughtException` → **绑不上端口的进程也不死**，只剩 `fs.watch` + `setInterval` 空转。每次「重启」若没先杀旧进程，新进程就变成又一个僵尸（现场抓到 6 个 node、只有 1 个真 LISTENING）。
> **韧性兜底（uncaughtException 不退出）与「启动期致命错误必须退出」是矛盾的两种诉求**——必须给 `listen` 单独挂 `error` 监听显式 `exit(1)`，让致命启动错误绕开兜底。

**连接超时调优**（另一次事故驱动）：`taskkill /F` 强杀 + 反复重启后，浏览器里所有 `fetch` 永久 pending。`netstat` 显示浏览器对 `127.0.0.1` 开了整整 **6 条 ESTABLISHED**，正好是 **HTTP/1.1 每域名 6 连接上限**——这些连接在 churn 中卡成悬挂态、占满连接池。主力解法是 `server.keepAliveTimeout=15s`/`headersTimeout=20s`/`requestTimeout=60s`（服务端主动回收半开/卡住连接，默认拖 5min），**平台无关**。
> **为什么不上 HTTP/2**：H2 多路复用能免掉 6 连接上限，但**浏览器只支持 H2 over TLS**（无 h2c）——要上证书，砸掉「`node server.js` 零配置、绑 0.0.0.0 给 Tailscale/局域网」的开箱即用；且 H2 单连接一旦被强杀反而全挂，治不了本次的强杀根因。
> **实测发现**：Windows 下 windowless Node **收不到优雅信号**——`taskkill`（不带 `/F`）直接报「只能强制终止」，所以 `gracefulShutdown` 在 Windows 托盘路径上**根本不跑**。

---

## 15. 前端两套实现

### 15.1 旧 UI 的两个值得讲的实现

**① 历史分页：「别复制 delicate 的渲染器，沙箱它」**

`renderEvent` 是全仓最 delicate 的 300 行——严格正序追加 + 依赖一堆**全局可变聚合态**（`curToolGroup` 工具组、`toolRows` 按 id 回填结果、`lastRenderedDate` 日期分隔、`appendRoot/subAgents` 子代理上下文）。要「倒序、成批 prepend 更老事件」，两条路：

- ① 写一个独立的历史渲染器 —— 但会与 `renderEvent` 长期漂移（两处各自处理派工 chip / 聊天记录块 / OLCard / 子代理…），是**维护炸弹**；
- ② **沙箱化复用** —— `renderHistoryBatch` 存下全部渲染态、把输出目标 `activeChatRoot` 重定向到一个游离 `<div>`、`replaying=true` 抑制贴底，`for(ev) renderEvent(ev)` 渲染进游离容器，再还原全部态、把容器 children 整体 prepend。

选 ②：零重复代码、实时渲染逻辑一个字节没动、未来 `renderEvent` 怎么改历史渲染自动跟上。代价是页内跨边界的 `tool_use↔tool_result` 断链会降级为孤立结果签（可接受）。

**② loading 态覆盖「真空期」而非「慢」本身**

真正的诉求不是让请求变快，是**别让用户以为卡死**。两处最高性价比落点：① 顶部进度条**包裹 `window.fetch` 一处驱动**（inflight 计数）——一次改动覆盖开机串行 fetch + 所有现有/未来操作；② 打开会话时聊天区转圈——因为 SSE 连接+回放**不是 fetch**、进度条覆盖不到。

### 15.2 CSS：一个注释 `*/` 打字坑（整页塌陷）

试切 shadcn Zinc 主题时，顶部注释里有一句 `语义 token 名沿用旧命名（--canvas/--surface-*/--hairline/--ink*）`——其中 `--surface-*/` 的**「星号紧跟斜杠」`*/` 提前闭合了注释**。注释后面的中文散文 + 行尾真正的 `*/` 于是被当成 CSS 解析，**污染了紧随其后的 `:root {` 选择器** → 整个 token 块不再应用到根元素 → 所有 `var(--primary/--canvas/…)` 未定义 → 背景全塌成透明。

**为什么兜了那么多圈子（真正的教训）**：

1. **误判成 oklch/color-mix 不支持** —— 一看到「颜色全透明」就联想到「较新 CSS 语法内核不认」，把全部 `oklch()` 转 hex、`color-mix()` 转 rgba，**全是红鲱鱼**。token 值是什么根本不影响，因为 token 块**自始至终没被应用**。
2. **盲改视觉、没做结构性校验** —— 看不到像素，只能靠 curl 看「服务端发了什么」，但那证明不了「浏览器解析成什么」。**正确的第一步应是对 CSS 做结构性校验（注释配对 `/*↔*/`、括号配平、选择器完整），而不是从颜色值开始猜。**
3. **老板从没真正看到 shadcn Zinc** —— 因为 `:root` 一直是坏的，他全程看到的「washed 亮色」其实是**无样式兜底态**。所以「shadcn 观感差」这个结论其实**没被公平验证过**。

**为什么退回成本低**：全站走语义 token（架构第一天就定的 `--canvas/--surface-*/--ink*/--primary`）——退回 = 把 token 值换回来，全局自动复原。**这再次印证语义 token 层的价值（换肤/退肤都只改一处）。**

**沉淀成的铁律**：改 `style.css` 后先做结构性自检——`/*↔*/` 注释配对、`{}` 括号配平；**CSS 注释里绝不能出现 `*/` 字符组合**；颜色一律 hex/rgba。

### 15.3 新 UI 的几个坑

- **窄窗聊天正文被裁**：grid `auto` 轨道被代码块顶宽，**容器上的 `min-w-0` 管不了轨道**（grid item 自动最小尺寸是 `max-content`）。同族第二例出现在 facet 明细弹窗。
- **portal 换容器会重挂子树丢状态**：聊天窗停靠为第三栏时不能换 portal 容器，改「始终 portal 到 body + CSS 变量预留空间」。顺带一条通用坑：**渲染期赋值的 ref 在同一 tick 里是旧值**。
- **拖动手柄经 React portal 抢走 Radix 菜单项的 `pointerup`**：加 `contains` 守卫。
- **弹窗卡顿两笔账**：① 弹窗 state 住在看板里 → 开关各重渲染整块看板；② Radix modal 给 body 加继承属性 → 全文档重算，**containment 实测拦不住**。
- **活动气泡在员工在跑时不显**：只信「变化才发」的广播、漏了轮询快照 `run.activity`。
- **移动端视口单位方向别记反**：想要「内容滚到悬浮底栏之下、整屏铺满」用**大视口**（`100lvh`）；`svh`/`dvh`（小视口）会把你钉在底栏之上。而且 `env(safe-area-inset-bottom)` **浏览器态常报 0**（底栏吸收了安全区），要「工具栏实际占高」用 **`100lvh - 100svh` 自校准**，稳过任何写死像素。
- **GSAP**：用 `fromTo` 而非 `from`；随时间变的量交 `gsap.ticker` 而非自走 tween。
- **一个 API 代理陷阱**：`web/vite.config.ts` 的 API 代理曾写死 `4800`，导致起了隔离引擎做浏览器验证时**页面实际打到的是生产引擎、看到的是旧代码**——这正是「症状像旧代码时先怀疑端口上有僵尸进程」的前端版本。改为 `OFFICE_LAB_API_TARGET` 可覆盖。

---

## 16. 部署、托盘与首启

### 16.1 `scripts/bootstrap.mjs`

纯 Node 内置模块、零依赖、`.mjs`；仓根新增只含 scripts 的 `package.json`，**刻意不设 `type:module`** 以免改变仓根任何 `.js` 的解析语义。

核心原则：**只有「引擎起不来」才硬失败**。

| 硬失败 | 只告警 |
|---|---|
| Node < 18 | Node < 20.19（构建不了 vite，自动转 `--no-web`） |
| 引擎依赖装不上 | 凭据查不到 |
| SDK 平台二进制缺失 | 新 UI 装不上/构建失败 |
| `server.js` 的本地 import 缺失 | 浏览器打不开 |

**自测照出来的三个真问题**（都是「我以为对、跑一遍才知道错」）：

1. **Windows 上 `spawn` 那些 `.cmd` 垫片不带 shell 会抛 `EINVAL`**（Node 20.12+ 对 CVE-2024-27980 的加固），不带后缀则 `ENOENT`——两条路都不通。症状是本机明明有 corepack，脚本却报「没有可用的 pnpm」。必须 `shell: true`。
2. 改走 shell 后又要**把命令拼成单串、不能传 args 数组**，否则触发 `DEP0190` 弃用告警。拼串安全的前提是「参数一律不含空格」——已作为文件级约束写进注释，路径只经 `cwd` 传、不进 argv。
3. **凭据预检原来是纯误报**：按「`~/.claude/.credentials.json` 存不存在」判定，而 Windows/macOS 的登录态在**凭据管理器/钥匙串**里、不是文件。改成「能确认就确认，不能确认就说不能确认」，**绝不下「没有凭据」的断言**。

**仓库完整性自检（本节最重要的部分）**：

**33 个被引用的文件从未入库**——不是被 `.gitignore` 忽略，是漏 `git add`：`app/ui-contract.js`、`app/e2e-batch.js`（工作树的 `server.js` 顶层就 import 它们）、**10 个 `web/src` 模块**（`dispatch.ts` 被 11 个文件引用）、12 份任务档案、2 个模板、4 个测试文件。

**口径要说准**（第一次说错过，当场纠正）：当前 committed 的 `server.js` 是旧版、并不 import 那两个模块，所以现在 clone 出来**不会崩**，而是拿到一个**落后约 2000 行的引擎**。真正的风险是**下一步**——一旦提交新 `server.js` 却漏 add，clone 当场 `ERR_MODULE_NOT_FOUND`。

对策：把它变成**机器会喊的告警**。任何机器都解析 `server.js` 的本地 `import` 并逐个查存在，缺就硬失败，措辞直说「这是仓库本身不完整，不是你的环境问题」并给出该执行的 `git add` —— **把一个会让接手人怀疑自己环境的错，变成一个指向源头的错**。源机器（有 git）额外列出「被引用却未入库」的文件。

> **通用教训**：**「能不能搬」这件事读代码读不出来，必须真 clone 一次。** 那 33 个文件在源机器上**完全不可见**（本机跑得好好的），在任何静态检查里也不可见（文件确实存在）。**凡是「交付形态」的验收，都要在交付形态本身上跑，不能在开发形态上推演。**
> 附带一条：**文档里的「零依赖」这类自我描述会腐烂，而且腐烂得无声。** README 一行里同时写错了端口和依赖，这类声明没有任何机制校验，只在有人照着做且失败时才暴露——而「照着做的人」通常就是新机器上的接手人。**所以 bootstrap 的存在本身也是一种文档：可执行的声明不会腐烂。**

### 16.2 托盘的两次事故

**① 看门狗把「引擎在忙」判成「引擎死了」**

老板报「lab 崩溃好几次」。取证结论：**引擎自己一次都没崩**（Windows 事件日志/WER 里 node.exe 零 APPCRASH 记录）。**run jsonl 的写入时间戳把真相钉死了**——12:30 被判死的那个实例，此后**又正常干了半小时活**。推论：那两次拉起的 node **必然撞 EADDRINUSE** → `process.exit(1)` → 托盘记为「异常退出 code=1」→ 4s 后自动重启 → 再自杀。**用户感知的「崩溃好几次」= 替身自杀的气泡串。**

根因是同一个认知错误的三处复发：把「**服务是否活着 / 端口是否被占**」这个**内核事实**，用「health 能不能在 1~2 秒内应答」这个**性能指标**去代理。

1. 心跳单次超时即判死（一次抖动 = 死亡判决书）；
2. **判死时把把手扔了**（`monitorPid = $null`）→ 此后托盘再也管不到真引擎，右键「停止/重启」只作用于那个自杀的替身；
3. 防重复拉起的判据也是 health（注释里明明写着「不重复拉起，否则 node 撞 EADDRINUSE 变僵尸」，**这道防护被 1 秒超时从内部绕过了**）。

**两个观测缺口**（所以事后什么现场都不剩）：cmd 重定向是**截断**（三次拉起相隔 4~30s，替身写下的 `[fatal] 端口已被占用` 被下一次拉起当场冲掉）；崩溃自动重启分支**只弹气泡不写 tray.log** → 事后**无法区分「用户点了重启」和「进程崩了被自动重启」**。

修法五条：端口有没有主**只信 TCP 监听表**；一次超时不算死（连续 3 次 ≈12s）；判死也不丢把手（端口仍有主 → 判「卡顿而非退出」，`$manageable` 放开到 unhealthy 状态——**卡顿/半死实例正是最需要接管清理的时候，原先菜单恰恰在此刻灰掉**）；`Archive-Log` 保住崩溃现场（追加进 history）；崩溃与停服都留痕（**并顺手记下当时端口的占用者**——`code=1` + 端口另有其主 = 撞端口自杀的指纹）。

> **取舍**：没有走「拉起前先 kill 端口占用者」——那等于把误判从「多起一个自杀进程」升级成「误杀正在干活的引擎」，**代价反了**。也没有取消崩溃自动重启，只是把「什么叫崩了」的判据从性能指标换成内核事实。

**② 「关掉那个终端窗口整个程序就没了」**

**排查过程值得记，因为第一版判断是错的。** 第一反应是 Windows Terminal 控制台移交（默认终端已是 WT，`start "" powershell -WindowStyle Hidden` 的控制台被移交给 `WindowsTerminal.exe`）——听起来严丝合缝，还能解释「日志写着已隐藏、窗口却还在」。**实测把它否掉了**：三条正式入口都不留窗口。

> 顺带一个反直觉的观测：同样一句 `GetConsoleWindow()`，在**继承现成 ConPTY** 的进程里返回 0，在 `start` 新起的进程里返回非 0。**所以「拿 GetConsoleWindow 判自己有没有窗口」本身就依赖启动方式，不是个稳定判据。**

**真凶**：机器上挂着四条**手工终端起的前端链**（父进程全已死、只剩孤儿），而托盘的 `Start-Web` 当时是：

```powershell
try { Invoke-WebRequest "http://127.0.0.1:$WebPort/" -TimeoutSec 1 | Out-Null; $webBusy = $true } catch { $webBusy = $false }
if ($webBusy) { Write-TrayLog "新 UI 端口已在跑，跳过拉起"; return }
```

**一句日志，然后 return。** 托盘把自己降级成旁观者：界面的实际宿主是那个手工终端，托盘既不知道、也不告诉用户、更接管不了。关掉那个终端 → `sh.exe` 死 → 下面的 corepack/cmd/vite 全死 → **4700 没了**；而引擎（4800）是托盘用 `CreateNoWindow` 起的孤儿进程、**毫发无伤**。**用户感知「整个程序都关掉了」，实际死的只有界面**，故障现象与真凶隔了三层。

**为什么这是真缺陷而不是「用户不该手工起」**：**引擎侧早就有对称的正确做法**（端口被占时转监控模式、记 PID、弹气泡明说「已接管」、右键停服时 kill 那个外部 PID）。**web 侧缺了这一整套**——同一个托盘里，两个端口一个有主人、一个没有。**不对称本身就是 bug 的温床**：引擎那条路被上一次事故打磨过，web 这条路从没被逼问过。

对策六条：端口真伪统一走 `Get-PortOwnerPid`；`Test-IsDescendant` 沿 `ParentProcessId` 上溯（`$script:webproc` 拿到的是 **cmd 外壳** PID，真正监听 4700 的是它下面好几层的 vite node，**直接比 PID 永远不等**——实测能穿过 `sh → corepack → cmd → node` 四层）；外部占用 → 转 web 监控模式并弹气泡明说；`Stop-Web` 支持接管收编（沿祖先链一并收，**只杀叶子的话祖先会立刻再拉一个占回端口**）；安全护栏（只杀「进程名 ∈ node/cmd/sh/… 且命令行含 vite|pnpm|npm|corepack|office-lab|web」的，实测拿 `python -m http.server` 试过判 False）；**托管方露脸**（状态行加「界面⚠外部托管(PID xxx)」——**不露脸正是这次归因难的根源**）。

> **三条通用教训**：
> ① **「跳过」是个危险的默认**。`if (busy) { log; return }` 读起来无害，实际是把一个资源的所有权悄悄让给了未知第三方，而且不留把手。凡「发现别人占着就跳过」的地方，都该问一句：**那之后谁负责它？用户怎么知道？我还能不能收回来？**
> ② **同一进程里管着两种资源，处置方式必须对称**。不对称就是下一个 bug 的位置。
> ③ **排查时先证伪自己最漂亮的假设**。Windows Terminal 那套解释太顺，顺到差点直接照它改；实测五分钟就否掉。**能被一条命令验证的假设，别拿它当结论。**

### 16.3 macOS（未实现，已有清单）

launchd LaunchAgent（**`KeepAlive` 天然替代 health 轮询重启，刻意不把「忙 vs 死」的启发式判断第二次实现**）+ LSUIElement `.app` + JXA 菜单栏（零编译，不需 Xcode/brew）。两个需要先认的能力差距：悬浮窗**做不到真置顶**（降级为 Chrome/Edge `--app=` 无地址栏独立窗口）、系统通知**没有按钮**（降级为无按钮通知 + 点击开 UI）。

---

## 17. 测试策略

### 17.1 现状

- **449 例 / 20 文件 / 631ms**，全部 `node --test`，**不启 server**。
- 覆盖面：`coverage`（覆盖率/证据/linter/validateArchive）、`paths`（19 例，含「嵌套同名时 `toAgentPath` 必须恒等」这条核心断言 + `..` 穿越正反用例）、`spin-and-patrol`（12 例，从真实事故 jsonl 回放固化）、`e2e-batch`（18 例，含「有界阻塞在 50s 返回 running 时绝不能判红」的回归防护）、`morning-report`/`version-report`/`guard-ledger`/`gate-matrix`/`release-chain`/`stall-guard`/`requirement-pool`/`handoff-freeze`/`qa-report-card`/`audit-trust`/`zhuzhu-capabilities`/`ui-contract`/`release-deliverables`/`guarded-integration`/`reachability`/`version`。

### 17.2 三条实践

**① 用真实事故数据回放，而不是只写单测**

这条在两天内连撞两次：
- 晨检包重构：归一化、runId 两形态、轮次重叠这三条，**单测全绿的时候一条都没暴露**；把四份真包重出一遍才全部现形。
- 版本级验收单：三个真 bug（「进入日期」只精确到天拿去比带时分秒的窗口一定落空 / 复用渲染器时它自带章号导致冒出两个「四」/ 显式要 v5.19 却把当前 run 那份 v5.20 档案原样带进去产出**假单**）全部是拿真数据跑才现形。

> **共同点：它们都在「模块边界之间」，而单测测的是模块内部。** 对「一天只跑一次、错了要等明天才知道」的路径，**历史真数据回放不是可选项**。

**② 从源码抠出定义再 eval（可用但脆弱的妥协）**

`server.js` 是 import 即 listen 的单体，无法直接 import 纯函数。回归测试按名从源码抠出定义再 eval；**抠不到即抛错**，日后重构改了函数名会立刻红。

**③ 隔离实例纪律**

测试/验证 server 一律带 `OFFICE_LAB_RUNS_DIR` 隔离 + 独立端口，用完即停，**绝不碰生产 `runs/`**。（这条纪律来自两次自伤事故；重启也走托盘、不强杀。）

### 17.3 缺口

- 前端无 E2E（新 UI 只有 `tsc -b` + oxlint）。
- 端到端 LLM 行为（巡视判断准头、守航真实跑）**无法单测**，只能靠真实 run 的裁决与事后复盘。
- 无 CI（明确决定），所以「全量测试有没有跑」靠人。

---

## 18. 当前技术债清单

按「会不会自己恶化」分类：

### 必然恶化（最优先）

1. **`runs/` 无保留/清理策略** —— 曾达 291MB。已做剥图（省 24.7MB）与列表投影，但**没有 retention policy**。
2. **append-only 棘轮** —— 任务档案、红线、SOP 只增不减，每回合冷启动税单调上涨。已有对策方向（档案拆「当前态头 / 时间线日志」+ 红线退役纪律），**未落地**。

### 结构债（不恶化但持续加成本）

3. **`server.js` 8770 行单文件**：路由 if 链、顺序隐式契约、`autoChain` 职责过载、纯函数不能直接 import。
4. **协议无独立 schema**：run 形状 / 标记 / 覆盖矩阵靠约定与三处同步注释。
5. **`parseFrontmatter` 自研 YAML 子集**：超出子集会静默解析错，而看板据此渲染 → **错得无声**。
6. **两套 UI 靠人工清单对齐**。
7. **`_` 前缀持久化过滤是把双刃剑**：已用命名约定绕开，但没有白名单机制兜底。

### 外部依赖债

8. **猪猪 v1.5 四接口未上线** → `guard.fake_green` 只算了一半；RED 校准仍可能走标题正则。
9. **企微智能表格读权限未批** → 主表反转搁置（代码全保留、`isPrimary` 开关待开）。
10. **平台 headless 不采 `console`/`pageerror`** → 一整类前端崩溃**在自动化里不可能变红**。

### 安全债

11. **本地 HTTP 无鉴权且默认绑所有网卡**。
12. **deny 名单的 glob 规则是实测经验、写在注释里**，SDK 升级可能变。

### 流程/基建债（不在 lab 侧但影响 lab 的可信度）

13. **QA 测 working tree 而非不可变 commit**；证据绑的是 git commit 而不是运行产物指纹。
14. **一个库同时是开发库和测试库**，QA 造数直写全局主数据（Anthropic 红队报告点名的正是这条）。
15. **无环境新鲜度探针** → 陈旧 bundle 会让「改坏两次都不红」。
