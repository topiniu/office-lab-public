# Office Lab · 公开版

Office Lab 用任务看板组织产品、开发、QA 和发布之间的协作。公开演示提供一组虚构任务，可展开查看各阶段的交接记录和下一步。

这份仓库包含演示源码，以及 Claude / Codex 适配器、会话交接、事件订阅和用户输入等模块。引擎模块供阅读和测试，当前版本未附带可启动的工作台服务端。

## 本地查看演示

安装 Node.js 22 和 pnpm 10 后，在仓库根目录执行：

```bash
pnpm --dir web install --frozen-lockfile
pnpm --dir web build
python3 -m http.server 4173 --bind 127.0.0.1 --directory web/dist-demo
```

打开 [本地演示](http://127.0.0.1:4173/)。演示数据随页面构建，浏览器不需要 API、登录或模型账号。

## 测试引擎模块

```bash
npm ci --prefix app
npm test --prefix app
```

测试使用本地夹具，不需要模型账号。接入实际执行时，由宿主单独安装和配置 Claude Agent SDK 或 Codex CLI。

## 托管演示

在仓库 **Settings → Pages** 中选择 **GitHub Actions**。默认分支的构建会运行引擎测试，再发布 `web/dist-demo/`。
