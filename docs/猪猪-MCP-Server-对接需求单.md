# 需求单 · 猪猪(Zhuzhu) E2E 自动化 —— 提供 MCP Server（由桌面 App 就地托管）

| 项 | 内容 |
|---|---|
| 提出方 | office-lab（望子成龙小学 · AI 员工工作台）——猪猪 E2E 的**接入方 / 消费方** |
| 接收方 | 猪猪(Zhuzhu) 团队 |
| 日期 | 2026-08-18 |
| 优先级 | 中高（当前 HTTP 手工对接有稳定的一类复发错误，见 §1） |
| 一句话 | 请在**猪猪项目内**把现有 E2E 能力封装成一个 **MCP Server**，由**猪猪桌面 App 用 HTTP 就地托管**；office-lab（及任何 MCP 客户端）作为消费方接入。 |

---

## 1. 背景与痛点

office-lab 是一个 AI 员工工作台，其中两个 QA Agent 通过 HTTP 调用猪猪做端到端自动化测试，典型链路：

> 生成/校验用例 → 无头执行（RED 校准）→ App-run 可视化终验 → 读取 run 结果（summary）

目前是 Agent **手工拼 HTTP 请求**，并遵守一条纪律「开工前先 `GET <基地址>/external-integration-documents` 拿当前版本协议，绝不 hardcode 端点/主机」。这带来三类**反复发生**的问题：

1. **主机/端口漂移**：`baseUrl`（如 `http://127.0.0.1:32147`）随机器变，写错就全线连不上。
2. **协议漂移**：端点/参数随猪猪版本变，Agent 凭记忆或旧用例调用就报错。
3. **流程遗漏**：如"提交前必须先 validate"这类步骤靠 Agent 自律，偶发漏做。

根因是：**协议归属猪猪，但接入方在用散文纪律 + 手拼 HTTP 去逼近它**。把它换成一个**类型化的 MCP 契约**、且**由协议所有者（猪猪）维护**，上述三类问题可从根上消除。

## 2. 为什么请猪猪团队来做、为什么是 MCP

- **协议所有权对齐**：端点/参数/workspace 语义/版本/鉴权都是猪猪的知识，工具 schema = 当前协议，能跟 API 锁步演进；接入方不再内嵌猪猪内部细节。
- **复用**：出成 MCP 后，任何 MCP 客户端（Claude Code、Cursor、其它团队的 Agent）都能直接用，不只 office-lab。
- **接入方零协议漂移**：Agent 从"读文档拼请求"变成"调类型化工具"，主机之外的东西不用再记。

## 3. 交付形态（硬要求）

- **传输：MCP over HTTP（Streamable HTTP 优先，SSE 次之），由猪猪桌面 App 就地托管**，挂在现有 base 上（如 `http://<host>:<port>/mcp`）。
  - 理由：桌面 App 本就在运行、本就是 HTTP server、本就托管着 `/external-integration-documents` —— 顺带托管 MCP endpoint 落点最省；接入方连的是**网络端点**、不需要拉起子进程。
- **不接受**需要接入方侧 `npx`/spawn 拉起的 **stdio-only** 方案（接入方在别的集成上被子进程启动的脆弱性坑过，明确规避）。
- **版本自描述**：MCP `serverInfo.version` 跟随猪猪对接协议版本；并提供一个返回「当前协议版本 + 能力清单 + workspace 绝对路径」的工具或 MCP resource（见 `get_integration_doc`）。

## 4. 需要暴露的工具（按 office-lab 现用能力映射，**命名/入参可与你们对齐**）

> 下表是**初稿**，请按你们真实 API 回填/修正端点与字段。凡现有 HTTP 端点已具备的能力，优先直接映射。

| MCP 工具（建议名） | 作用 | 关键入参 | 返回要点 | 对应现有端点 |
|---|---|---|---|---|
| `get_integration_doc` | 取当前版本协议 + workspace 绝对路径 + 能力清单（也可做成 MCP resource） | — | 协议版本、workspace 绝对路径、各能力可用性 | `GET /external-integration-documents` |
| `validate_test_file` | 校验用例 JSON，**提交/执行前必过** | 用例 JSON 或 testFilePath | `errors[]` / `warnings[]`（分离，含定位与可读原因） | `POST /validate-test-file` |
| `run_headless` | 无头执行用例（用于 RED 校准 / 迭代调试，便宜） | testFilePath、可选参数 | runId 或 run 结果指针（见 `get_run_summary`） | 你们的无头执行端点 |
| `run_app` | App-run 可视化执行（用于终验，贵） | testFilePath、可选参数 | runId + 证据/截图产物路径 | 你们的 App-run 端点 |
| `get_run_summary` | 读某次 run 的结果 | runId 或 run 目录 | passed/failed 明细、证据路径、test/summary hash 等 | 现由接入方读 `summary.json` |
| `list_test_files` | 列用例/资产 | 目录（相对 test-workflows/） | 文件清单 | `/test-files*` |
| `read_test_file` | 读用例/资产 | testFilePath（**相对 test-workflows/、不带前缀**） | 文件内容 | `/test-files*` |
| `write_test_file` | 写用例/资产 | testFilePath + 内容 | 落盘结果（含基本冲突处理） | `/test-files*` |
| `get_auth_status`（可选） | 探测登录态/环境可达 | 可选 profile | 是否已登录/可达 | 你们的探活端点（若有） |

**执行模型请你们确认（影响工具设计）**：现有 headless / App-run 是**同步阻塞**返回，还是**异步 + 轮询**？
- 若耗时较长，倾向**异步**：`run_*` 立即返回 `runId`，接入方用 `get_run_summary(runId)` 轮询到终态；
- 若你们有稳定的同步长连接也可，但请给明确超时口径。

## 5. 非功能要求

1. **workspace 绝对路径由工具返回**（`get_integration_doc`），接入方**不 hardcode**；其下约定 `test-workflows/`（用例 JSON）、`test-assets/`（资产）、`output/`（产物）保持不变。
2. **路径约定保持**：`testFilePath` 相对 `test-workflows/`、不带前缀。
3. **错误口径结构化统一**：`{ code, message, retriable }`；`validate` 的 `errors` 与 `warnings` 分离；避免只回一段自由文本。
4. **幂等/并发**：同 run 的 summary 可重复读；文件写有基本的冲突/覆盖处理。
5. **鉴权**：若需要，请说明 token 如何携带；若本机免密请注明。
6. **连接可发现性**：base/host 会随机器漂移——接入方侧用自己的配置项维护连接地址；请你们保证 App 启动后该 MCP 端点**稳定可达**（固定端口，或提供一个发现机制/健康检查）。
7. **向后兼容 & 弃用策略**：协议升级时，工具 schema 自描述新能力；对将废弃的工具/字段给出 deprecation 提示，别静默 break。

## 6. office-lab 侧承诺（我们负责的部分）

- 以 **MCP 客户端**接入，连接地址走我们侧的单一事实源配置（对应今天的「猪猪对接设置」）。
- 与你们对齐工具契约（本单即初稿），提供 office-lab 的真实用法与边界 case。
- **过渡方案**：在你们正式 MCP 就绪前，我们**可能**在接入方侧临时保留一层薄 HTTP facade 顶着；你们的 MCP 上线后我们即切换并**废弃 facade**，不与你们的实现长期并存。

## 7. 验收标准

1. office-lab 的一个 QA Agent **仅凭 MCP 工具**即可跑通全链路：`validate_test_file` → `run_headless`(RED 校准) → `run_app`(终验) → `get_run_summary`，**不再手拼 HTTP、不再 hardcode 主机/端点**。
2. 猪猪协议升级时，接入方**无需改代码**即可拿到新能力（工具 schema 自描述、版本自暴露）。
3. 主机漂移时，接入方只改一处连接配置即恢复，其余零改动。

## 8. 待猪猪团队确认 / 回填

1. 执行模型：headless / App-run 同步阻塞还是异步+轮询？（决定 `run_*` 与 `get_run_summary` 的形态）
2. 传输：Streamable HTTP 还是 SSE？MCP 端点路径与端口？是否固定端口 / 如何发现？
3. 鉴权模型：需要 token 吗？本机是否免密？
4. 现有端点与本单 §4 工具的**映射确认**（哪些直接映射、哪些需新增/改造）。
5. **排期**：预计什么时候能给到可联调的版本？期间是否需要我们先上 facade 过渡？

---

> 联系人 / 联调对接：office-lab 团队（本单起草方）。收到后建议先就 §8 的 5 个问题拉一次对齐，再据此把 §4 工具表定版为正式接口契约。
