# Office Lab · 新 UI（`web/`）

基于 **shadcn UI（Radix 底座）+ Vite + React 19 + Tailwind v4** 的独立人机界面，与旧的纯静态前端（`app/public/`）**并存、互不影响**。本前端不含任何后端逻辑——它复用既有引擎 `app/server.js` 的 HTTP/SSE 契约。

> 设计约束：页面性能优先、移动端适配、暗色模式适配、**尽量少写自定义样式、最大化复用 shadcn 组件**（全站走语义 token，不写死颜色）。

## 运行

前提：引擎 `app/server.js`（API + 旧 UI）在 `4800` 端口运行（工作台托盘正常启动即可）。

```bash
cd web
corepack pnpm install     # 首次
corepack pnpm dev         # 新 UI 开发服务器 → http://<本机IP>:4700（绑 0.0.0.0）
corepack pnpm build       # 生产构建（tsc -b && vite build → dist/）
corepack pnpm preview     # 预览生产包
```

端口约定：**新 UI 4700 / 旧 UI + 引擎 4800**（两者均绑 `0.0.0.0`，可经局域网/Tailscale IP 访问，不只 localhost）。开发期 Vite 把 `/api`、`/avatars`、`/uploads` 代理到 `127.0.0.1:4800`（见 `vite.config.ts`）；生产期与引擎同源部署，故前端一律用相对路径、不写死 host。

## 结构

```
src/
  lib/         api.ts(fetch 封装,GET/POST/DELETE) · types.ts(契约) · status.ts(状态→列/色) ·
               olcards.ts(卡片解析) · format.ts · utils.ts(cn)
  hooks/       use-poll · use-employees(花名册 ctx) · use-run-stream(单 run 流+翻页) · use-mobile
  components/  sse-provider(单 EventSource 扇出) · theme-provider/mode-toggle(暗色) · app-sidebar ·
               health-pill · employee-avatar · dispatch-dialog · markdown · olcard(13 卡型) ·
               transcript · run-detail(+provider) · employee-detail · settings-dialog ·
               file-viewer · ui/*(shadcn) —— 详情/文件/设置/员工详情均为全局 Provider
  views/       Kanban · Runs · Employees · Conversations · Meeting · Patrol（App.tsx 里 lazy 分包）
```

聊天卡是**多开的**：`run-detail-provider` 持有 `cards[]`，每张卡一个 `RunDetail`（层序见 `use-card-stack`）。其中 `newConsult(employee)` 开的是**只读咨询窗**（卡头带「只读」徽标、隐藏任务档案选择器）——员工正忙时也能开，因为它零写能力、不过引擎并发闸；入口有三处（侧栏员工行 hover 放大镜、员工详情「只读咨询」、派工遇 409 的 toast 动作）。忙闲派生（`empRepRun`/`mostRecentRun`/员工卡 busy/履历统计）一律排除只读窗，会话切换器与运行观测保留并标「只读」。能力边界见 `../app/README.md`「只读咨询窗」。

数据流：列表用 `usePoll` 拉首屏 + 兜底轮询，实时增量由 `/api/events`（全局 SSE，`data:`-only，按 `payload.type` 区分）与 `/api/runs/:id/events`（单 run 流，`id:` 行续传）打补丁。富卡片＝员工消息里 ```` ```olcard ```` 围栏 JSON，见 `src/lib/olcards.ts` 与仓库根 `消息卡片协议.md`。契约细节见 `src/lib/types.ts`。

## 迁移基准

对齐旧 UI（`app/public`）的**全量功能/交互/数据拓扑**沉淀在 [`docs/旧UI-功能与UX拓扑.md`](docs/旧UI-功能与UX拓扑.md)——顶层 Shell 拓扑、逐屏功能/UX、OLCards 目录、设置面板、HTTP/SSE 事件字典、状态机（Mermaid），并回指旧代码 `file:line`。新旧差异与已修 bug 见仓库根 `CHANGELOG.md`「新 UI」条目。

## 本机 pnpm 说明（踩坑）

- 本机只有 `corepack`、没有全局 `pnpm`，故命令统一走 `corepack pnpm …`。
- shadcn CLI 会派生子进程直接调 `pnpm`；因 corepack 往 nvm 目录写 shim 报 EPERM，改用 `web/.shim/pnpm(.cmd)`（转发 `corepack pnpm`）挂到 PATH：
  ```bash
  export PATH="/d/Workspace/Projects/office-lab/web/.shim:$PATH"
  corepack pnpm exec shadcn add <component>
  ```
- `web/pnpm-workspace.yaml` 里 `overrides: zod: ^3.25.76` 是**必需**的：shadcn CLI 依赖的 `@modelcontextprotocol/sdk` 需要 `zod/v4` 子路径，缺它 CLI 启动即崩。

## 加组件

```bash
export PATH="/d/Workspace/Projects/office-lab/web/.shim:$PATH"
corepack pnpm exec shadcn add <name>     # 写入 src/components/ui/
```
