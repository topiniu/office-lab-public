# Office Lab

Office Lab 是一个可在自己电脑上运行的多 Agent 研发工作台。产品、开发、QA 和发布各有职责和交付物。看板显示每项工作的进度、验证结果和待你决定的事项。你可以打开员工会话、派工、跟进交接并做最终验收。

![首次启动 Office Lab 后打开派工窗口，选择产品经理和执行引擎](docs/dispatch.png)

## 安装并启动

准备 Git、[Node.js](https://nodejs.org/) 22.12 或更新版本。在终端执行以下命令。

```sh
git clone https://github.com/topiniu/office-lab-public.git
cd office-lab-public
npm start
```

首次启动会安装依赖并构建前端。浏览器打开 [http://127.0.0.1:4800/](http://127.0.0.1:4800/)；停止时在终端按 Ctrl+C。

## 配置模型，开始第一项工作

1. 任选一个执行引擎并在运行 Office Lab 的电脑上完成认证。
   - **Claude Code**：按 [Claude Code 设置说明](https://code.claude.com/docs/en/setup) 安装并登录，或在启动 Office Lab 的终端设置自己的 `ANTHROPIC_API_KEY`。
   - **Codex**：安装 [Codex CLI](https://developers.openai.com/codex/cli/)，执行 `codex login`。
2. 打开 **设置 → Agent 基座**，选择默认引擎及模型。模型留空时使用该引擎的默认模型。Codex 找不到时，在设置中填写可执行文件路径。
3. 点击 **派工**，选择员工并说明目标。例如，给菲菲发一条「为项目的搜索功能整理需求和验收标准，建一份任务档案」。可在会话中查看结果、继续补充要求或拍板。

如果会话提示模型服务返回 401，请检查所选引擎的登录状态和账号可用性，再重新派工。两个引擎分别认证。

首次启动时，任务和会话为空。内置员工包括菲菲（产品）、GG Bond（开发）、迷糊老师（QA）和波比（发布）。任务档案写入 `tasks/`，会话及配置写入 `app/runs/`，附件写入 `app/uploads/`。

## 连接自己的项目

直接启动时，员工在 Office Lab 仓库中工作。要让员工访问其他项目，可把 Office Lab 克隆到项目目录下，并在启动时显式将该目录设为工作区根。

```sh
cd /path/to/your/project
git clone https://github.com/topiniu/office-lab-public.git office-lab
cd office-lab
OFFICE_LAB_WORKSPACE_ROOT=.. npm start
```

Windows PowerShell 中用 `$env:OFFICE_LAB_WORKSPACE_ROOT = '..'`，再执行 `npm start`。任务档案和配置仍保存在 Office Lab 目录内。发布和部署按目标项目的规则执行。

## 工作台功能

- **任务看板**显示 Markdown 任务档案、需求条目、负责人、覆盖情况及下一步。
- **员工会话**提供实时输出、继续对话、工具审批和跨引擎会话交接。
- **守航与验收台**用于安排一轮工作，查看验收证据及待人工决策事项。
- **可选集成**可在自己的环境配置企微、飞书、手机推送和兼容的 E2E 执行器。初始配置为空，需要时到设置中启用。

工作台默认只监听本机。命令和工具以本机用户权限执行，首次使用可先在独立项目上派工。

```sh
npm test
node scripts/bootstrap.mjs --doctor
```

问题可在 [GitHub Issues](https://github.com/topiniu/office-lab-public/issues) 反馈。
