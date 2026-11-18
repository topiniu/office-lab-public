# 望子成龙小学 应用

> 调度器 + 可视化窗口。产物流转永远走仓库文件（任务档案/交接卡），本应用只传路径、拉起员工、观测运行、承接你的拍板回复。删掉本应用不丢任何数据。

## 启动（首次需装依赖）

> **本机 Windows 开发约定**：Lab 的启动统一通过 `D:\Workspace\Projects\office-lab\tray\启动托盘.cmd`，停止、重启使用托盘菜单。开发时复用托盘实例，不从 Codex 终端直接拉起 Lab；下面的前台命令用于其他平台或部署形态，本机不采用。只读体检可运行 `node scripts/bootstrap.mjs --doctor`。

### v0.12.0：基座与模型

「设置 → Agent 基座」可选择 Claude Code 或 Codex，并分别设置默认模型；派工弹窗可覆盖本次基座/模型。配置保存在当前 `RUNS_DIR/engine-config.json`。全局默认只影响新会话；历史记录缺少 engine 时按 Claude 处理，续聊不跨引擎搬用 session ID，自动交接沿用来源基座。默认仍为 Claude。

未完成任务遇到基座不可用，可在会话「… → 更换基座并接手」（旧界面标题栏「⇄」）选择目标基座，预览交接摘要、补充说明后继续。Lab 保留原任务和协作编号，停止旧执行流后创建新的底层会话；不会把 Claude 的 session ID 传给 Codex。摘要无需旧模型响应，取自进度快照与已有记录。交接未能收束时保持暂停并提示重试；已有同事会话及已排队派工不批量切换。

未完成任务遇到基座不可用，可在会话「… → 更换基座并接手」（旧界面标题栏「⇄」）选择目标基座，预览交接摘要、补充说明后继续。Lab 保留原任务和协作编号，停止旧执行流后创建新的底层会话；不会把 Claude 的 session ID 传给 Codex。摘要无需旧模型响应，取自进度快照与已有记录。交接未能收束时保持暂停并提示重试；已有同事会话及已排队派工不批量切换。

Codex 需要宿主机已安装并登录的 CLI，Windows 请配置 `codex.exe`，可填绝对路径（不是 `.cmd`，不接受拼接命令参数）。模型留空使用该 CLI 的默认模型；也可填写该账号/服务商支持的模型 ID。Claude 的模型与凭据沿用 SDK 配置。

连通性检查：`node scripts/check-engine.mjs codex` 只检查协议；加 `--live` 调真实模型，加 `--tools` 验证工具、连续对话和会话恢复。CLI 不在 PATH 时加 `--command <绝对路径>`。测试使用临时目录和无业务副作用的工具。Claude 可用 `node scripts/check-engine.mjs claude --live --tools`。

Codex 不执行 Claude 专属 hooks，也不提供 Claude 原生 Task/Agent 子代理。业务交接仍走 Lab。权限通过 Codex 原生沙箱、审批及宿主工具白名单执行，不能把 Claude 权限 glob 当成 Codex 所有原生命令的完整拦截器。需要依赖 Claude hooks 的生产流程继续选择 Claude；先用独立任务验证 Codex 流程。详细协议、验证证据和扩展方式见 [多引擎说明](../docs/office-lab-v0.12.0-多引擎.md)。

```bash
node scripts/bootstrap.mjs       # 仓根执行。一条命令：装依赖 → 构建新 UI → 起引擎 → 开浏览器
node app/server.js               # 依赖已就位时直起引擎 → http://127.0.0.1:4800（引擎 API + 旧 UI；新 shadcn UI 在 4700）
```

Node 18+。引擎依赖 `zod`，Claude 适配器延迟加载 `@anthropic-ai/claude-agent-sdk`（两者均在 `app/package.json` 声明，`app/node_modules` 不入库）。首次运行 `cd app && npm ci`，或让 bootstrap 代办。新 UI（`web/`）另需 pnpm 装依赖 + 构建，属可选：装不上会回落到免构建的旧 UI（`app/public`），两套界面都有基座配置。

端口默认 `4800`、可用 `OFFICE_LAB_PORT` 覆盖；默认绑 `0.0.0.0`（所有网卡，局域网/Tailscale IP 可访问），`OFFICE_LAB_HOST=127.0.0.1` 可锁回仅本机。

`node scripts/bootstrap.mjs --doctor` 只体检不启动：形态 / Node 版本 / 仓库完整性 / 依赖 / 平台二进制 / 凭据 / 新 UI 逐项过一遍。另有 `--no-web`、`--no-open`、`--start-only`、`--port N`。

### 两种部署形态（引擎自动探测）

| | 嵌在 monorepo 下 | 单独 clone 本仓 |
|---|---|---|
| 判据 | 父目录有 `backend` / `frontend` / `manage-backend.sh` 任一 | 都没有 |
| 员工工作树（agent cwd） | monorepo 顶层（要改前端仓/后端仓，必须是这个） | **本仓根**（不逃出仓库） |
| 兄弟仓能力（后端构建/发布枚举/UI 契约/业务 docs） | 可用 | 自动跳过，不报错 |

启动日志第二行会打出 `mode= workspace= office= prefix=`，排查路径问题先看它。手工指定用 `OFFICE_LAB_WORKSPACE_ROOT`。路径根的唯一事实源是 [`paths.js`](paths.js)（含「L 逻辑前缀 / P 物理路径 / R 解析器」三层语义），**改路径先读它**。

### 常驻后台（Windows）

不想让服务随终端关闭而中断，用系统托盘常驻：双击 `tray/启动托盘.cmd`（或 `tray/office-lab.vbs`）。任务栏出现状态圆点，右键可启停/看状态/看日志/设开机自启，双击打开控制台。详见 [`tray/README.md`](../tray/README.md)。监控端点：`GET /api/health`（等价 `/healthz`）。

> macOS 的常驻（launchd + 菜单栏）**尚未实现**，下一轮做。当前 macOS/Linux 上就用 `node scripts/bootstrap.mjs` 前台跑。

## 设计系统

UI 遵循 **Linear 设计系统**（`docs/design.md`）：
近黑画布 `#010102` + 四级 surface 阶梯 + 发丝线描边（无阴影）、唯一强调色薰衣草蓝 `#5e6ad2`（仅用于主按钮/焦点环/运行中状态）、语义绿 `#27a644`、标题负字距、按钮 8px 圆角 / 卡片 12px 圆角 / 状态 pill 全圆角。员工使用圆形头像（`public/avatars/`），出现在侧边栏、派工选择器、运行列表与会话头。布局为产品式：左侧边栏（导航 + 员工），主区在「任务 / 运行 / 运行详情」三视图间切换，派工是 Linear "New issue" 式弹层。**全站走语义 token（`--canvas/--surface-*/--hairline/--ink*/--primary`），改顶层即全局传导——改样式优先改/复用这些 token、别写死颜色。**

> 2026-07-28 曾试着重皮为 shadcn/ui（Zinc），但因一个 CSS 注释里的 `*/`（把 token 名写成 `--surface-*/…`）**提前闭合注释、连累 `:root` 解析失败 → 整页样式塌陷**（`--primary` 未定义、背景全透明）。当时误判成 oklch 内核不支持兜了大圈，最终定位是注释 bug。老板已**整体退回 Linear**，退回时保留了那几轮的功能改进（交互拍板气泡、消息时间戳/复制、看板 5 态状态色、微动效、附件上传态、头像徽标修复）。教训见复盘 §3.29。**改 CSS 后先自检 `/*↔*/` 注释配对与 `{}` 括号；注释里禁止出现 `*/`；颜色一律 hex/rgba。**

## 界面

| 视图 | 内容 |
|------|------|
| 任务 | 扫 `office-lab/tasks/*.md`（仅含 task+status frontmatter 的档案）：状态 pill、负责人头像、门禁圆点、封板标记；**需求条目**以 issue 行呈现（琥珀点=在途，行悬停出「接棒」按钮，按阶段文字猜下一棒员工并预填派工）；「待确认事项」未完结项作为**等你拍板**待办；可查看档案原文 |
| 派工 | 弹层：头像选员工 + 挂任务档案 + 选模型 + 写指令；侧边栏点员工、条目点「接棒」都会预填打开 |
| 运行 | 每次派工一个 run：SSE 流式显示员工思路文本与工具调用（会话流样式）；收工后底部输入框**直接回复/拍板**（`--resume` 续同一会话，⌘Enter 发送）；可停止；侧边栏「运行」带进行中计数徽标 |

## 工作机制

- 派工 = 用 Agent SDK 的 `query()` 拉起员工（工牌正文 append 到 `claude_code` preset，`permissionMode` 按员工配置），typed 消息流式回传；`cwd` = 工作区根（见上「两种部署形态」），CLAUDE.md / `.claude/settings.json` 自动生效。
  > v0.1 时代是 spawn `claude -p … --append-system-prompt … --output-format stream-json`；v0.2.0 起改为 Agent SDK，这段旧写法已不成立。
- 会话 ID 持久化在 `runs/index.json`，服务重启后历史运行仍可回看与续聊。
- 员工收工事件会自动刷新任务看板（员工按 SOP 回写了任务档案）。

### 任务档案维护门禁（facet/覆盖生命周期，2026-08-17）

任务档案不是自由 markdown——引擎在「宣告进展」的转换点对它做 fail-closed 校验，防止靠 SOP 记忆的维护漏项（详见复盘 §3.78）：

- **结构化写工具**：员工改档案走 MCP 工具而非手 Edit：`set_task_status`/`set_entry_status`（状态按枚举校验、原子写）、`seed_coverage`/`set_facet_coverage`/`reconcile_coverage`（覆盖矩阵；`COVERED_GREEN` 禁手填、只能机器签发）、`append_timeline`。
- **facet_doc 硬门禁（关键项硬）**：把条目/版本推进到「待测及以后」（进 QA）——含 GG Bond→迷糊交棒、`set_entry_status`/`set_task_status`、人工端点 `/api/task/manual-pass`·`/api/task/precheck`——引擎先跑 `validateArchive`：**`facet_doc` 缺/找不到/无 ID facet ⇒ 拦下**（交棒 bounce、写入拒绝、端点 400）。守航态（guarded_run）豁免硬挡，早期状态零摩擦。
- **软反馈（其余软）**：只读工具 `validate_task_archive`（交棒前自检）；写工具写后把 warnings（孤儿行/状态非法等）附返回；`facet-drift` 漂移巡检与空停巡逻同周期扫描、把「已进 QA 却缺 facet 基线」的在飞档案 ping owner。
- 校验器：纯函数在 `coverage.js:validateArchive`（可单测，`test/coverage.test.js`），路径解析包装 `server.js:validateArchiveFile`。

### 飞书需求表状态自动对账（2026-08-21）

**任务档案＝事实源，需求表＝投影。** 引擎按档案算出每条 REQ 的应有分诊态并写回表（`syncLarkFromArchives`）——不再依赖菲菲记得翻表（她那一棒常常没被再派：流水线最后一棒是波比，v5.18 上线后表里还挂「待处理」就是这么来的）。

- **口径**：`gates.released_prod=true` → 已完成 + 上线日期（从该 gate 行尾注释解析真实日期，解析不出就留空并提醒）；在登记表、未上线 → 处理中；条目 `已跳过/已隔离`（守航 park/隔离）→ 回待处理。只碰**状态/归属版本/上线日期**三个字段。
- **双向**：支持回退（发布回滚、条目退出版本都会把表推回去）。护栏是**降级熔断**——单轮降级 >3 条就整批不写、只报告 + 通知等人确认；「拒绝」行整行不碰；表里没有的 REQ 只报告不新建。
- **触发**：档案变动（`fs.watch` debounce 5s + 最小间隔 2min）/ 30 分钟定时兜底 / 手动 `POST /api/lark/sync`（`{"dryRun":true}` 只算不写，`GET` 看上轮结果）。总开关 `larkConfig.autoSync`。审计落 `runs/lark-sync.jsonl`。
- **菲菲的活变成**：补建表里缺的 REQ 行、处理 `needsHuman`（日期解析不出 / 条目被 park / 该行是拒绝）；**别在表里改流程状态**（会被下一轮推回，要改去改档案）。

### 守航冷启动入口「🌙 守航开工」（2026-08-21）

新 UI 侧栏的全局入口，**不依赖任何任务卡片**：菲菲以守航态（`guarded_run`）从 0 起草——挑需求 → 需求说明与验收标准 → 建任务档案 → 交棒 GG Bond，`executionMode` 沿交接链传播，整链自动守航，终点停 RC_READY 待次日晨检。

- 填三四个字段（候选来源：菲菲自选飞书「待处理」/ 老板点名条目；最多条数；晨检截止，默认次日 08:00；附加说明）→ `POST /api/guarded/launch`。
- 引擎**自动签发**守航契约 `tasks/<日期>-守航契约-guarded-NN.md`（字段语义事实源 `templates/守航任务契约.md`），并把契约路径 + 冷启动指令一起交给菲菲；她只被授权回填契约的 `archive`/`version` 两个字段。
- ~~park 两段口径~~ → **v0.11.0 起改为三种不确定**：查得清的自己查、可以反悔的自己定并亮在验收卡上、反悔代价大的才 `raise_risk` 等老板（只停那一条），起草期也不再整轮停等。
- 边界（别当护栏）：契约 yaml **不被机器拦截**（Stage 4 拦截层已撤），`max_tokens`/`deadline` 无硬顶，越权仍靠恒生效的 `DANGER_DENY` + 次日人工审计；晨检包不自动装配。切回共驾要显式重新派工。机制取舍见 `docs/tech/全时双态协作-设计.md` §19。

### 守航自助托管：目标循环 + 验收卡（v0.11.0，2026-09-29）

- **目标循环**：守航轮里链停了、活没干完，引擎自己判、自己派人接着做（新会话 + 进度快照），直到每条都「做完且验收卡四格齐 / 等老板拍高危事项 / 试尽后隔离」。有人在跑 / 后台任务 / 老板刚在聊 → 等；上一棒报错或老板按停 → 暂停交回老板；续跑轮数（默认 8）、截止、token 顶任一到了就收手；同样局面连续 3 次没推进判卡住。判定在 `app/guard-goal.js`（纯函数），接线 `guardGoalTick`。开工弹窗可选「只记录，不自动续」（影子）；旧契约无 `goal:` 块按影子；总开关 `OFFICE_LAB_GUARD_GOAL=0`（**测试实例必须带上**，同 AUTOCHAIN/PATROL）。
- **验收卡**（侧栏「验收台」 / 任务档案「验收卡」页签）：一个需求一张卡——做完没 / 长啥样 / 动了哪些老功能 / 要你拍板的高危事项 + 「我替你定了什么」。卡上的按钮真的推动流水线（打回 / 改决定 / 高危选路 → 交回菲菲；契约过期凭点击签续跑契约）；「验收通过」只置「人工Pass」、不触发发布。接口 `GET /api/acceptance-cards?file=|runName=`、`POST /api/acceptance-cards/action`；判定在 `app/acceptance-card.js`。
- **从任意档案发起**：档案查看器「🛡 守航推进」/ 派工弹窗勾守航态 → `POST /api/guarded/archive-launch`（签只授权勾选条目的契约，默认派菲菲当负责人先盘点再派第一棒，也可直接从迷糊/GG Bond 开工）；`GET /api/guarded/archive-items?file=` 列登记表条目。
- 员工新工具：`goal_status` / `acceptance_card` / `record_decision` / `raise_risk` / `selection_done`；守航态 `park_item` 必须写 `onlyBossBecause`。机制与取舍见 `docs/tech/全时双态协作-设计.md` §23。

### 并行工作区（lane）与侧栏「运行环境」（2026-09-28）

多需求同时开发时，每条需求 = 一个工作区：一组 git worktree（`<工作区根>/.worktrees/<id>-{be,fe,fecj}`）+ 一个端口槽位（slot k：前端 8000/8001+2k、后端 8040/8041/8042+10000k）+ 绑定的任务档案。主检出是固定的 `main`（slot 0）。

- **注册表** `runs/lanes.json`；逻辑在 `app/lanes.js`，起停复用仓根 `manage-backend.sh` / `manage-frontend.ps1`（环境覆盖 `PORT_OFFSET/RUN_TAG/SHARED_BUILD`、`FRONTEND_APP_DIR/APP_PORT/RUN_TAG`，日志 `run/lanes/<id>/`）。
- **员工工具**：GG Bond `lane_create/up/down/update/remove`；迷糊/菲斯拉/波比只读 `lane_status`。绑定工作区的会话系统提示里有【运行环境】块；并发闸按工作区粒度（两位 QA + 巡视员仍按员工串行）。
- **HTTP**：`GET /api/lanes`（含运行态）、`POST /api/lanes`（建）、`POST /api/lanes/<id>/{up,down,update,remove}`、`GET /api/lanes/ops/<opId>`。
- **界面**：侧栏「运行环境」——各工作区分支/未提交/服务端口在监听与否/后端陈旧，「…」菜单里一键开会话（带工作区绑定）、打开前端、重编重启/停止、编辑/收掉；「+」新建（分支已在别处检出则认领）。机制与取舍见 `docs/tech/引擎-健壮性与接管.md` §3.139。

## 权限模型（headless 的关键差异）

员工权限以 `employees.json` 的 `permissionMode` 为准，当前正式员工配置为 `bypassPermissions`。按2026-10-22用户要求，Codex正常员工会话对应 `approvalPolicy=never` 与 `sandbox=danger-full-access`，读取文件、维护文档不再因非编码角色被整类拒绝。只读咨询和无原生工具的辅助会话不继承完整访问。

非bypass模式仍按原权限配置审批。Claude的allow/ask/deny与Codex原生执行并非完全等价：完整访问模式下不能承诺Claude deny或非编码角色代码锁的原生硬隔离。角色职责指令、Lab宿主工具白名单和业务门禁继续生效。免审批不等于新增任务/外部动作授权。

修改适配器代码需要重启Lab，新会话及冷恢复加载新策略；已在执行的会话不会被就地改权限。

### 只读咨询窗（consult）

员工正忙时也能并发开的第二个窗口——**专为「他在开发，我要另问一个 bug 怎么定位」**而设（新 UI：侧栏员工行 hover 放大镜 / 员工详情「只读咨询」/ 派工被 409 挡下时 toast 里一键开）。它与正式会话的差别只有一条：**零写能力**。

- 放行（静默）：`Read`/`Glob`/`Grep` + 只读 Bash（`ls`/`rg`/`git log|diff|show|blame`/`tail` 日志…）。
- 硬禁（连审批卡都不给）：一切写工具（裸工具名全局 deny）、`git commit/push/checkout`、`mvn`/`npm run`/`manage-backend|frontend`、重定向与 `rm/mv/sed -i`；且**不挂任何 MCP**（档案回写 / 抄送派生 / 重编重启 / 猪猪真机全都没有）。
- 白名单外：落审批卡由你决定（只读窗本就是你在场时才开的）。
- 因为不写，所以**不过并发闸**（不占员工忙闲、不挡正式派工），也**不进流水线**（不接棒、不被巡视、不上会话看板、不沉淀教训）。每员工同时一条。
- 已知代价：正式会话改到一半时，只读窗读到的是中间态文件。要真动手，回正式会话派工。

机制取舍见复盘 `docs/tech/引擎-核心与编排.md` §3.79。

## 已知边界（v0.1）

- 员工间仍不直接通信：A 收工 → 你（或你看完汇报后）在 Lab 里派下一棒。全自动接力（监视 frontmatter 自动派工）留待下一版，先让人在环里跑稳。
- 运行中无法插话（headless 单轮），要中断用「停止」，收工后再回复。
- 档案查看是纯文本渲染，未做 markdown 美化。
