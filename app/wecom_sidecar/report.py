"""把长连接的连接状态回报给 office-lab（供设置卡片状态行 + 企微连通测试判定）。

fire-and-forget：任何失败静默吞掉，绝不影响长连接主流程。受 X-Internal-Token 保护。
"""
from __future__ import annotations

import logging

from .config import settings

logger = logging.getLogger("wecom_sidecar")


async def report_state(state: str, detail: str = "") -> None:
    """POST office-lab /api/wecom-bot/report，上报 connected/authenticated/disconnected/error 等。"""
    import aiohttp  # 延迟导入：纯逻辑单测无需装 aiohttp

    url = settings.office_lab_url.rstrip("/") + "/api/wecom-bot/report"
    headers = {"X-Internal-Token": settings.internal_token, "Content-Type": "application/json"}
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
            async with session.post(url, json={"state": state, "detail": detail}, headers=headers) as resp:
                await resp.read()
    except Exception:  # noqa: BLE001 - 上报失败不影响长连接
        pass
