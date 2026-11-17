"""自包含配置：全部从环境变量读取（office-lab server.js 在 spawn 时注入 WECOM_* 变量）。

不依赖任何 RAG 仓库模块。渠道只做企微 I/O：收发消息 + 把消息转给 office-lab 主人格端点。
凭证类（bot_id/secret/ws_url）**优先从 office-lab runtime 端点热拉**（见 runtime.py），env 里的
同名变量只作为无端点/端点失败时的种子兜底。RAG/知识库改由 office-lab 主人格按需调用，sidecar
不再持有 RAG 地址与客户身份配置。
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    # 连接凭证种子（正常由 office-lab runtime 端点提供，这里只兜底）
    bot_id: str = os.getenv("WECOM_BOT_ID", "")
    bot_secret: str = os.getenv("WECOM_BOT_SECRET", "")
    ws_url: str = os.getenv("WECOM_BOT_WS_URL", "")  # 空=用 SDK 默认 wss 地址

    # office-lab 引擎：主人格端点 + 凭证/开关热拉来源 + 连接态回报
    office_lab_url: str = os.getenv("WECOM_OFFICE_LAB_URL", "http://127.0.0.1:4700")
    internal_token: str = os.getenv("WECOM_INTERNAL_TOKEN", "")

    # 行为参数
    request_timeout_seconds: float = float(os.getenv("WECOM_REQUEST_TIMEOUT_SECONDS", "180"))
    reply_max_chars: int = int(os.getenv("WECOM_REPLY_MAX_CHARS", "1800"))
    progress_step_seconds: float = float(os.getenv("WECOM_PROGRESS_STEP_SECONDS", "7"))
    config_poll_seconds: float = float(os.getenv("WECOM_CONFIG_POLL_SECONDS", "30"))
    welcome_message: str = os.getenv(
        "WECOM_WELCOME_MESSAGE",
        "我是菲菲，负责打样、商品、订单这些。有问题或想法直接说就行。",
    )


settings = Settings()
