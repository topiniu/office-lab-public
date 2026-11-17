"""企业微信智能机器人（长连接模式）渠道 worker —— office-lab 版。

菲菲这个「人」的家在 office-lab：主人格 + 身份 + 企微渠道都归这里。本 sidecar 是**渠道**那一层
（一根哑管道）：用官方 ``wecom-aibot-python-sdk``（``aibot.WSClient``）主动连
``wss://openws.work.weixin.qq.com``，收到用户消息后 HTTP 转给 office-lab 主人格端点
``POST /api/wecom/persona-reply``，由主人格作答（她自行决定要不要查知识库/登记需求），再流式回企微。

架构要点（用户拍板）：
- **渠道 = 纯 I/O，不是开工信号**。sidecar 不做意图判断、不查知识库、不派工——正式开工只在
  望子成龙看板里由用户发起。
- **主人格在 office-lab**：口吻/判断/能力调度都在 office-lab 的菲菲 Agent；知识库(RAG)、飞书等是
  她按需调用的**工具**，不是每句都检索。sidecar 只负责把消息送进去、把回复发出来。
- **自包含**：不依赖 RAG 仓库；全部配置从环境变量读（见 ``config.py``），由 office-lab 的
  ``server.js`` 在 spawn 时注入。
- **凭证归 office-lab**：BotID/Secret/开关经 ``GET /api/wecom-bot/runtime`` 轮询（见
  ``runtime.py``），后台改配置热重连；连接态经 ``POST /api/wecom-bot/report`` 回报。

入口：``python -m wecom_sidecar``（cwd = office-lab/app）。SDK / aiohttp 均**懒导入**，
使 config/format/office_client/decide 逻辑无需装 SDK 即可单测。
"""
