"""异步回连 office-lab 主人格端点（/api/wecom/persona-reply），由菲菲主人格作答。

架构（用户拍板）：企微=纯 I/O 渠道；菲菲主人格在 office-lab；知识库(RAG)/飞书等是主人格按需
调用的扩展能力（工具）。所以 sidecar **不再直接调 RAG**，而是把用户消息转给 office-lab，由主人格
决定要不要查知识库、怎么用自己的口吻回。契约见 office-lab 的 /api/wecom/persona-reply。

用 aiohttp（SDK 已依赖）异步调用，不阻塞 worker 的 asyncio 事件循环。
"""
from __future__ import annotations

from typing import Any, Dict

from .config import settings


def persona_url() -> str:
    return settings.office_lab_url.rstrip("/") + "/api/wecom/persona-reply"


async def ask_office_lab(question: str, userid: str, images=None) -> Dict[str, Any]:
    """POST /api/wecom/persona-reply，返回 {reply, ...}。失败抛异常由调用方兜底话术。

    images: 可选，[{"media_type": "image/jpeg", "data": "<base64>"}]（企微图片经 sidecar 下载解密后带上）。"""
    import aiohttp  # 延迟导入：纯逻辑单测无需装 aiohttp/SDK

    payload = {"userid": userid or "unknown", "text": question}
    if images:
        payload["images"] = images
    headers = {"Content-Type": "application/json", "X-Internal-Token": settings.internal_token}
    timeout = aiohttp.ClientTimeout(total=settings.request_timeout_seconds)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(persona_url(), json=payload, headers=headers) as resp:
            resp.raise_for_status()
            return await resp.json()


def ingest_url() -> str:
    return settings.office_lab_url.rstrip("/") + "/api/wecom/ingest-images"


async def ingest_zip(userid: str, filename: str, data_b64: str) -> Dict[str, Any]:
    """把企微发来的 zip（聊天记录截图打包）转给 office-lab：解压取图 → 菲菲读图登记。返回 {reply,...}。"""
    import aiohttp  # 延迟导入

    payload = {"userid": userid or "unknown", "source": {"type": "zip", "dataBase64": data_b64, "filename": filename or "chat.zip"}}
    headers = {"Content-Type": "application/json", "X-Internal-Token": settings.internal_token}
    timeout = aiohttp.ClientTimeout(total=settings.request_timeout_seconds)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(ingest_url(), json=payload, headers=headers) as resp:
            resp.raise_for_status()
            return await resp.json()
