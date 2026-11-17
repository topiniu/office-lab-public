# 企微渠道 sidecar（菲菲的企微 I/O）

菲菲这个「人」的家在 office-lab。本目录是她的**企微渠道层**：一个 Python 长连接 worker，用官方
`wecom-aibot-python-sdk` 连企业微信，收到消息后**转给 office-lab 主人格**作答，再流式回企微。

**架构（用户拍板）**：渠道 = 纯 I/O，不是开工信号。sidecar 是一根**哑管道**——不做意图判断、
不查知识库、不派工。要不要查知识库(RAG)、要不要把需求登记为待办、怎么用菲菲口吻回，全由
**office-lab 主人格**（菲菲 Agent）决定。正式开工只在望子成龙看板里由用户发起。

- 身份权威源：`office-lab/roles/feifei.md` §「我是同一个人的两顶帽子」。
- 主人格端点契约：office-lab `POST /api/wecom/persona-reply`（`{userid,text}` → `{reply}`，内部 token 守卫）。
- 迁移自 RAG 项目 `app/wecom_bot`，已切断对 RAG 仓库的依赖（自包含）。

## 链路

```
企业微信  →  office-lab/app/wecom_sidecar（本 worker，长连接，纯 I/O）
          →  office-lab 主人格 POST /api/wecom/persona-reply（127.0.0.1:4700）
                 └─ 菲菲 Agent：闲聊直接答 / 需要事实才调知识库工具(RAG) / 需求→登记待办
          →  菲菲的回复  →  流式回复企微
```

> 知识库(RAG)不再由 sidecar 调用——它是 office-lab 主人格的一个**工具**（`ragApiUrl` 配在
> office-lab 侧，internal 受众）。飞书文档管理等以后以同样方式挂成主人格的新工具。

## 配置来源（不改代码）

全部配置由 **office-lab 引擎**掌管，在「企微渠道」设置卡片里改（落 `runs/wecom-config.json`）：
- **开关 / BotID / BotSecret / wsUrl**：worker 轮询 `GET /api/wecom-bot/runtime`（带内部 token）
  热拉，改配置即重连/断开，无需重启。
- **主人格端点(office-lab 地址) / 内部 token / 欢迎语 / 超时** 等：office-lab 在 spawn 时经
  `WECOM_*` 环境变量注入。

worker 由 office-lab `server.js` 看护：`enabled` 且凭证齐时自动拉起、崩溃退避重启、server
退出即随之关停。**不要手动常驻本 worker**（会与看护打架）。

## 一次性安装依赖

本机需先装 SDK（否则 worker 启动即退出，设置卡片状态行会显示「未安装 …」）：

```
# Windows
app\wecom_sidecar\setup.cmd
# macOS / Linux
app/wecom_sidecar/setup.sh
```

装到本目录 `.venv`。office-lab server 解析 python 的优先级：
`WECOM_PYTHON` 环境变量 > `app/wecom_sidecar/.venv`（本 setup 建的）> PATH 里的 `python`。

## 真机测试前置

需要企业微信「智能机器人」的真实 **BotID / BotSecret**（企微管理后台创建，机器人头像按菲菲对齐）。
填入设置卡片并开启后，向机器人发文字消息即可验证：
- 「你好」→ 菲菲像同事一样直接回，**不**触发知识库检索；
- 业务问题 → 主人格调知识库工具核实后用她的口吻答；
- 转发/提出需求 → 主人格登记为待办并提示「去看板派工」，**不**直接开工。

## 手动单跑（调试）

```
cd office-lab/app
WECOM_OFFICE_LAB_URL=http://127.0.0.1:4700 WECOM_INTERNAL_TOKEN=<token> \
  wecom_sidecar/.venv/bin/python -m wecom_sidecar
```

（token 见 `runs/wecom-config.json` 的 `internalToken`。）

## 文件

| 文件 | 作用 |
|------|------|
| `__main__.py` | 受管轮询 `serve()`：拉运行时配置、凭证/开关变化即重连/断开 |
| `runtime.py` | 从 office-lab `GET /api/wecom-bot/runtime` 拉凭证/开关 |
| `office_client.py` | 异步 `POST /api/wecom/persona-reply`，把消息转给 office-lab 主人格 |
| `report.py` | 连接态回报 office-lab `POST /api/wecom-bot/report`（供状态行/连通测试） |
| `handlers.py` | 长连接事件：5s 秒回开场 → 慢时补进度 → 同 stream_id 收尾（哑管道，只转发） |
| `format.py` | 主人格响应 → 企微纯文本 |
| `config.py` | 自包含配置（全部读 `WECOM_*` 环境变量） |
