"""从 office-lab 引擎拉 worker 运行时配置（真实 BotID/Secret/开关）。

渠道归 office-lab 后，凭证与开关的事实源是 office-lab（``runs/wecom-config.json`` +
``GET /api/wecom-bot/runtime``），不再是 RAG API。worker 定时轮询该端点：凭证或开关变化就
重连/断开（决策见 __main__._decide），实现后台改配置热加载。

端点受 ``X-Internal-Token`` 保护（token 由 office-lab 生成、spawn 时经 env 注入 worker）。
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from .config import settings


def runtime_url() -> str:
    return settings.office_lab_url.rstrip("/") + "/api/wecom-bot/runtime"


async def fetch_runtime_config() -> Optional[Dict[str, Any]]:
    """成功返回 effective 配置 dict（含 enabled/bot_id/bot_secret/ws_url）；
    任何失败返回 None（调用方保持当前状态，下轮再试）。"""
    import aiohttp  # 延迟导入：纯逻辑单测无需装 aiohttp

    headers = {"X-Internal-Token": settings.internal_token}
    timeout = aiohttp.ClientTimeout(total=settings.request_timeout_seconds)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(runtime_url(), headers=headers) as resp:
                resp.raise_for_status()
                return await resp.json()
    except Exception:
        return None
