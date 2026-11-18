# office-lab 文档索引

本目录存放 office-lab（望子成龙小学）相关的调研、设计、复盘等各类文档。新增文档后在下方登记一行。

## 文档清单

### 复盘 / Retrospective
- [office-lab 技术演进与复盘底料（总览＋主题索引）](office-lab-技术演进与复盘.md) — 工作台自身技术复盘的总览页：起源与目标、架构总览、与业界差距+升级点、已知短板、维护约定，以及**引擎关键机制的主题索引**。引擎机制（原 §3.1〜§3.66，编号沿用）与方法论时间线（原 §4）已按主题拆到下面 [`tech/`](tech/) 分册；配套根 [`../CHANGELOG.md`](../CHANGELOG.md)（版本流水）。
  - [`tech/`](tech/) 主题分册：引擎-核心与编排 / 引擎-健壮性与接管 / 引擎-权限与安全 / 渠道-企微与飞书 / 性能 / 前端-看板与消息卡片 / QA门禁与角色演进 / 方法论时间线。

### 技术剖析 / 面试准备（学习材料，非事实源）
- [**office-lab 技术剖析与面试准备中心**](interview-preparation/README.md) — 参照 `vision-e2e/docs/interview-preparation/` 的形态，把工作台自身的技术剖析、演进记录、面试与演示材料集中一处。**它是上面复盘底料的结构化提炼 + 讲解版，不复制其正文**（机制取舍的事实源仍在 `office-lab-技术演进与复盘.md` + `tech/**`，避免双份漂移）。含：
  - `technical/` 五份 —— [项目深度剖析](interview-preparation/technical/office-lab-project-deep-dive.md)（背景→架构→模块→选型→亮点→不足→讲解版）· [引擎技术实现剖析](interview-preparation/technical/office-lab-engine-implementation.md)（生命周期/编排/门禁/渠道/性能/部署，每节带残留面）· **[事故案例集](interview-preparation/technical/office-lab-incident-casebook.md)（10 族 47 例，统一「起因·现象·根因·方案·不完美·通用教训」八段式，按病族归类以显出「同一病根复发了几次」）** · [演进记录](interview-preparation/technical/office-lab-evolution-timeline.md)（pre-0.1→0.10.0 十一版 + 方法论 20 次裁定 + 四条演进主线 + 效率复盘十轮）· [路线与差距](interview-preparation/technical/office-lab-roadmap-and-gaps.md)（成熟度评级/P0-P3/技术债按「会不会自己恶化」分类/重构顺序）
  - `interview/` 两份 —— 面试准备稿（背诵稿/简历/高频题/压力追问/**自我交底**）· 综合题库（226 题 / 13 组）
  - `demo/` 一份 —— 团队技术分享大纲（15/30 分钟 + 18 页骨架 + Demo 三段 + 现场兜底）

### 对接 / 猪猪（Zhuzhu）平台
- **[给 office-lab 的守航能力增强方案（角色版）](../../vision-e2e/docs/lab-guarded-run-capability-plan.md)** — 猪猪团队 2026-08-25 交付，**指针不复制**（事实源在 vision-e2e 仓，避免双份漂移）。基于 v5.19/v5.20 两轮真实守航复盘（见 [`tech/全时双态协作-设计.md` §20](tech/全时双态协作-设计.md)），给出：自托管流水线九段与"人只在哪三处出现"、引擎/看板必须先建的六件事（红灯计数 / 晨检包自动装配 / 版本冻结与结算 / 发布链机器对账 / 收工即校验 / 按 risk_class 的门禁矩阵）、飞书需求表「守航就绪」字段组、**六个角色逐一的能力改造**（菲菲需求巡航+窄口径声明 / GG Bond 交接即冻结+影响面雷达 / 迷糊视觉验收+大白话 QA 报告卡片 / 波比发布链对账 / 菲斯拉假绿猎手 / 小呆呆事件拦截）、S1~S5 分阶段出口判据、守航成熟度 L0~L3。**含两项需 lab 侧确认的接口/安全变更预告（§7）。**
- [猪猪平台优化需求单（QA 复盘驱动）](.) — 历轮需求单与完成说明同目录：`猪猪平台优化需求单-QA复盘驱动-<日期>.md`（+ `-完成说明`）、`猪猪-MCP-Server-对接需求单.md`。最新一轮 v4（2026-08-21，REQ-Z15/Z16）已由猪猪 v1.4 交付。

### 调研 / Research
- [生产级员工 Agent 方案调研（2026 年中）](生产级员工Agent方案调研-2026年中.md) — 业界「员工 agent / 数字员工 / 多智能体 AI 软件公司」生产落地格局，及与 office-lab 自动接棒方案的差距与 3 个升级点。

## 约定
- 文件名用中文短标题 + 必要的版本/日期后缀，便于检索。
- 每份文档顶部注明目的、方法、日期；引用外部结论时标注来源与可信度。
- 新增文档务必回到本文件登记一行（分类 + 一句话 hook）。
