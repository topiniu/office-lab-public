# 完成说明 · 猪猪(Zhuzhu) E2E —— MCP Server（桌面 App 就地 HTTP 托管）

| 项 | 内容 |
|---|---|
| 回复方 | 猪猪(Zhuzhu) 团队 |
| 对应需求单 | [`猪猪-MCP-Server-对接需求单.md`](./猪猪-MCP-Server-对接需求单.md)（office-lab 提出，2026-08-18） |
| 日期 | 2026-08-18 |
| 状态 | ✅ 已实现并自测通过，随猪猪桌面 App 一起发布（`serverInfo.version` 跟随 App 版本，当前 **1.2.1**） |
| 一句话 | MCP Server 已在**猪猪桌面 App 内就地托管**，挂在现有 `:32147` 上、路径 `/mcp`，**Streamable HTTP / 无状态**；9 个类型化工具覆盖你们全链路，错误口径与可发现性均按需求单落地。 |

---

## 0. TL;DR（office-lab 接入方最少需要知道的）

- **连接地址**：`<猪猪对接 base>/mcp`，例如 `http://<host>:32147/mcp`。`base` 仍走你们侧「猪猪对接设置」单一事实源；**不要 hardcode host/port**。
- **传输**：MCP over **Streamable HTTP**，**无状态**（每次 POST 独立、无需维持 session id）。用任意标准 MCP 客户端（Claude Code / Cursor / `@modelcontextprotocol/sdk` 的 `StreamableHTTPClientTransport`）直接连**网络端点**即可，**不需要 `npx`/spawn 子进程**（明确不采用 stdio 方案，符合 §3）。
- **发现机制**：你们今天已在轮询的 `GET <base>/external-integration-documents`，响应里**新增了 `mcp` 块**（`endpoint` / `transport` / `protocolVersion` / `tools[]`）。连之前先读这块拿到 `mcp.endpoint` 即可，零硬编码。
- **全链路**：`get_integration_doc` → `validate_test_file` → `run_headless`(RED 校准) → `run_app`(终验) → `get_run_summary`，**不再手拼 HTTP**。

---

## 1. §8 待确认项 —— 逐条回填

**1. 执行模型：headless / App-run 同步阻塞还是异步+轮询？**

- **`run_headless`：同步阻塞**。工具调用会一直等到该无头会话跑完，直接返回报告 summary（含 `sessionId`、`reportPath`、逐 case 结果）。适合 RED 校准 / 迭代调试，成本低。若单文件很重，客户端侧设足够的调用超时即可。
- **`run_app`：异步 + 轮询（默认）**。可视终验较贵且依赖单窗口浏览器，故 `run_app` **立即返回 `externalRunId`（入队，202 语义）**，你们用 `get_run_summary({ runId })` 轮询到终态。
  - 需要「一次调用拿到最终结果」时，传 `wait: true`，`run_app` 会阻塞到跑完再返回终态 summary。
- **`get_run_summary` 统一读**：同一个工具既能读 App-run 的 `externalRunId`，也能读 headless 的 `sessionId`——接入方无需区分来源；可重复读（幂等）。

**2. 传输：Streamable HTTP 还是 SSE？端点路径与端口？是否固定端口 / 如何发现？**

- **Streamable HTTP（优先项）**，无状态实现（`sessionIdGenerator: undefined` + `enableJsonResponse: true`）。POST 返回标准 JSON-RPC 响应体（非长连 SSE），最省心、最稳。
- **端点**：`<base>/mcp`。**端口固定 `32147`**（可用 `ZHUZHU_APP_RUN_PORT` 覆盖，与 App-run/validate/test-sessions 同端口，App 一开即在）。
- **发现**：见 §0——`external-integration-documents` 的 `mcp` 块自描述端点+版本+工具目录。App 退出后地址不可访问（与现状一致）。

**3. 鉴权模型：需要 token 吗？本机是否免密？**

- **本机免密**：与现有 `:32147` 一致，不需要额外 token。该端口默认绑定 `0.0.0.0`（可用 `ZHUZHU_APP_RUN_HOST=127.0.0.1` 收紧到本机）；**仅应分享给可信设备或走受保护隧道**（沿用现有对接纪律）。
- MCP 端点已加 **CORS + OPTIONS 预检**（`Access-Control-Allow-*`，暴露 `Mcp-Session-Id`/`Mcp-Protocol-Version`），浏览器内的 MCP 客户端也能直连。

**4. 现有端点与 §4 工具表的映射确认**

全部**直接映射到现有 HTTP route 的同一套底层 helper**（工具是薄封装，schema 与当前协议锁步）：

| MCP 工具 | 现有能力/端点 | 说明 |
|---|---|---|
| `get_integration_doc` | `GET /external-integration-documents` | 附带协议版本 + workspace 绝对路径 + 工具目录 + 原始对接文档 |
| `validate_test_file` | `POST /validate-test-file` | `errors[]`/`warnings[]` 分离原样透传；`mode: gate` 或 `strict:true` 走质量门 |
| `run_headless` | `POST /test-sessions`（无头文件级执行） | 同步阻塞，返回报告 summary |
| `run_app` | `POST /app-runs/run-file`（异步队列） | 默认返回 `runId`；`wait:true` 阻塞 |
| `get_run_summary` | `GET /app-runs/{id}` + `GET /test-sessions/{id}` | 二者统一：先查 App-run 队列，未命中查 headless 会话 |
| `list_test_files` | `GET /test-files` | 列 `test-workflows/` |
| `read_test_file` | `GET /test-files/read` | `testFilePath` 相对 `test-workflows/`、不带前缀 |
| `write_test_file` | `POST /test-files/save`｜`/create` | `mode: save`(默认，覆盖/更新)｜`create`(新建，自动避重名) |
| `get_auth_status` | `GET /auth/status`（`surface:profile`）/ `GET /auth/panel-status`（`surface:panel`） | 探活：存档登录态新鲜度 / 可视面板实时登录态 |

**新增/改造**：新增 `/mcp` 挂载 + `mcp-server.js`（工具封装、无状态收发）+ `external-integration-documents` 的 `mcp` 自描述块；底层执行/校验能力全部复用，无重复实现。

**5. 排期 / 过渡**

- **已随本次猪猪桌面 App 交付**（无需你们等待）。你们可**即刻切换到 MCP**，按 §6 承诺**废弃接入方侧临时 HTTP facade**，不必与 MCP 长期并存。

---

## 2. §7 验收标准 —— 达成情况

1. ✅ **仅凭 MCP 工具跑通全链路**：`validate_test_file` → `run_headless`(RED) → `run_app`(终验) → `get_run_summary`，不再手拼 HTTP、不再 hardcode 主机/端点。
2. ✅ **协议升级接入方无需改代码**：工具 schema 自描述、`serverInfo.version` 随协议版本自暴露；能力增删由 `get_integration_doc` / `external-integration-documents.mcp.tools[]` 反映。
3. ✅ **主机漂移只改一处**：连接地址走你们侧「猪猪对接设置」单一事实源 + `external-integration-documents.mcp.endpoint` 发现，其余零改动。

## 3. §5 非功能要求 —— 对照

| 要求 | 落地 |
|---|---|
| 5.1 workspace 绝对路径由工具返回、不 hardcode | `get_integration_doc.workspace`（`workspaceRoot`/`testWorkflowsRoot`/`testAssetsRoot`/`outputRoot`），`test-workflows/`·`test-assets/`·`output/` 约定不变 |
| 5.2 路径约定保持 | `testFilePath` 相对 `test-workflows/`、不带前缀 |
| 5.3 错误口径结构化统一 | 所有工具失败返回 `{ ok:false, error:{ code, message, retriable } }`；`validate` 的 `errors`/`warnings` 分离；不是自由文本 |
| 5.4 幂等/并发 | `get_run_summary` 可重复读；`write_test_file` 有覆盖(save)/避重名(create)处理 |
| 5.5 鉴权 | 本机免密（见 §1.3）；可用 `ZHUZHU_APP_RUN_HOST` 收紧绑定 |
| 5.6 连接可发现性 | 固定端口 32147 + `external-integration-documents.mcp` 自描述块；App 启动后端点稳定可达 |
| 5.7 向后兼容 & 弃用 | 工具 schema 自描述、版本自暴露；后续废弃字段会给 deprecation 提示，不静默 break |

---

## 4. 工具契约（定版初稿，字段可继续对齐）

> 错误统一：任一工具失败 → 工具结果 `isError:true`，`structuredContent = { ok:false, error:{ code, message, retriable } }`。成功 → `structuredContent` 为对应业务对象，`content[0].text` 为其 JSON 文本镜像。

- **`get_integration_doc`** — 入参无。返回 `{ ok, workspace{...绝对路径}, mcp{...}, endpoints[], documents[] }`。
- **`validate_test_file`** — `{ testFile? | testFilePath?, mode?("advisory"|"gate"), strict? }`。返回 `{ ok, data:{ summary{errorCount,warningCount}, errors[], warnings[] } }`。**提交/执行前必过**。
- **`run_headless`** — `{ testFilePath? | testFile?, caseIds?[], scope?("all"|"selected"), authProfile?, qualityGate?, allowBlocked?, reuseBrowser?(默认 true), checkpoint?, resume? }`。同步返回报告 summary（含 `sessionId`、`reportPath`）。
- **`run_app`** — `{ testFilePath(必填), caseId?, scope?, wait?(默认 false) }`。默认返回 `{ externalRunId, status:"queued", ... }`；`wait:true` 返回终态 summary。需桌面面板已就绪（否则 `error.code="app-not-ready"`，`retriable:true`）。
- **`get_run_summary`** — `{ runId }`。返回 `{ ok, kind:"app-run"|"headless", ...run/session 结果 }`。可轮询。
- **`list_test_files`** — 入参无。返回 `{ success, files:[{path,id,name,group,caseCount,...}] }`。
- **`read_test_file`** — `{ testFilePath }`。返回 `{ success, path, testFile }`。
- **`write_test_file`** — `{ testFilePath?, testFile, mode?("save"|"create") }`。返回 `{ success, path, ... }`。
- **`get_auth_status`** — `{ surface?("profile"|"panel"), profile? }`。返回登录态/可达性（含新鲜度字段）。

---

## 5. 快速接入示例（`@modelcontextprotocol/sdk` 客户端）

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// 1) 从你们侧「猪猪对接设置」拿 base；再从 external-integration-documents 拿 mcp.endpoint
const base = "http://<host>:32147";              // 单一事实源，勿 hardcode
const disco = await (await fetch(`${base}/external-integration-documents`)).json();
const mcpEndpoint = disco.mcp.endpoint;          // => http://<host>:32147/mcp

// 2) 连接（无状态 Streamable HTTP）
const client = new Client({ name: "office-lab-qa", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpEndpoint)));

// 3) 全链路
const doc = await client.callTool({ name: "get_integration_doc", arguments: {} });
const workspaceRoot = doc.structuredContent.workspace.workspaceRoot;

const v = await client.callTool({ name: "validate_test_file", arguments: { testFilePath: "sampling/x.json" } });
if (v.structuredContent.data.summary.errorCount > 0) throw new Error("fix errors first");

const red = await client.callTool({ name: "run_headless", arguments: { testFilePath: "sampling/x.json" } });

const app = await client.callTool({ name: "run_app", arguments: { testFilePath: "sampling/x.json" } });
const runId = app.structuredContent.externalRunId;
let s;
do {
  await new Promise(r => setTimeout(r, 1500));
  s = await client.callTool({ name: "get_run_summary", arguments: { runId } });
} while (!["passed","failed","stopped","completed","not-found"].includes(s.structuredContent.status));
```

---

## 6. 自测与稳定性

- **单元/集成测试**：新增 `test/runtime/mcp-server.test.js`，用**真实 http.Server + 真实 Streamable HTTP transport**（无状态、JSON 响应）覆盖：`tools/list` 全 9 工具、`tools/call` 结构化返回、入参透传、`run_app`+`get_run_summary` 往返、抛错→`{code,message,retriable}` 归一（网络类置 `retriable:true`）、缺能力优雅降级、OPTIONS 204+CORS、GET 405、错误 shaping。**11/11 通过**；与相关既有路由/会话测试合跑 **29/29 通过**。
- **真实客户端握手**：用官方 `@modelcontextprotocol/sdk` 的 `Client`+`StreamableHTTPClientTransport` 完整 `initialize → listTools → callTool` 走通（stateless 下每请求独立、无 session 泄漏）。
- **稳定性设计**：无状态每请求新建 server+transport（无跨请求状态、无会话簿记）；工具执行全程 try/catch → 任何底层异常都转成结构化错误而非崩连；`res.on("close")` 释放 transport/server；缺失能力返回 `capability-unavailable` 而非抛错。对既有 `:32147` 其它端点零侵入（`/mcp` 分支置于 dispatch 首位、独立返回）。

---

## 7. 备注 / 后续可对齐项

- **进度流**：当前 `run_app` 为「入队 + 轮询」；若你们要实时逐条进度，猪猪侧已有 `GET /app-runs/{id}/events`（SSE）可并用；后续如需可把它也做成 MCP resource/工具。
- **字段对齐**：§4 契约为定版初稿，`run_headless`/`run_app` 的可选项（`qualityGate`/`checkpoint`/`authProfile` 等）如需在你们侧固化用法，可再拉一次对齐把边界 case 补进工具描述。
- **过渡 facade**：按 §6 承诺，你们切到 MCP 后即可下线临时 HTTP facade，无需长期并存。

> 有问题直接回本说明或约一次联调，我们据你们的真实用法把工具描述与默认值再收敛。

---

## 8. office-lab 侧接入完成回执（2026-08-18）

- **已切到 MCP 客户端**：引擎 `app/server.js` 在拉起用猪猪的员工（`injectFor`＝迷糊/菲斯拉）时，把猪猪 MCP 作为**远程 HTTP MCP** 挂进其会话——`empMcp['zhuzhu'] = { type:'http', url: <base>/mcp }`，`url` 由 `zhuzhuMcpUrl()` 取「猪猪对接设置」的 `baseUrl` 单一事实源 + 固定 `/mcp` 拼成，**不 hardcode host/port**。
- **提示词改口径**：`buildZhuzhuBlock` 从「开工前 GET 对接文档 + 手拼 HTTP 端点」改写为「直接调 `mcp__zhuzhu__get_integration_doc / validate_test_file / run_headless / run_app / get_run_summary / list_test_files / read_test_file / write_test_file / get_auth_status` 类型化工具」，并写明全链路顺序（get_integration_doc → validate（必过）→ run_headless（RED）→ run_app（终验，异步 externalRunId 轮询 / `wait:true` 取终态）→ get_run_summary）。
- **健壮性**：采用 SDK 的 MCP **非阻塞启动**（未设 `alwaysLoad`）——猪猪桌面 App 未启动时本 run 不卡不崩，`mcp__zhuzhu__*` 工具届时不可见；提示块已留「工具不可见 = 先确认 App 在运行（工具随 App 托管在 `<base>/mcp`）」的兜底。
- **过渡 facade**：office-lab 侧此前并无常驻 HTTP facade（一直是员工手拼 HTTP），故无需下线额外组件，直接切 MCP 即完成，不与你们实现并存。
- **待联调**：`run_headless`/`run_app` 的可选项（`qualityGate`/`checkpoint`/`authProfile` 等）待真实用例跑起来后按 §7「字段对齐」再收敛；如需实时逐条进度会评估接你们的 `GET /app-runs/{id}/events`(SSE)。
