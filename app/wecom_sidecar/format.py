"""把 /api/ask 的响应格式化成企微可读文本（仅供菲菲/企微渠道使用）。

菲菲的答案正文由 RAG 服务端 persona prompt 直接产出，已自带口语化的结论与（必要时的）不确定
说明，所以这里不再附「参考来源」清单、也不加信任角标——避免机器味的出处罗列与客套。
纯函数，不依赖 SDK / 网络，便于单测。
"""
from __future__ import annotations

from typing import Any, Dict


def _clip(text: str, max_chars: int) -> str:
    text = text.strip()
    if max_chars > 0 and len(text) > max_chars:
        return text[: max_chars - 1].rstrip() + "…"
    return text


def format_reply(result: Dict[str, Any], max_chars: int = 1800) -> str:
    """result 为 office-lab /api/wecom/persona-reply 的 JSON（{reply}）。
    兼容早期 RAG /api/ask 的 {answer}。返回菲菲要发出的纯文本。"""
    answer = (result.get("reply") or result.get("answer") or "").strip()
    if not answer:
        return "这条我没太看明白，换个说法再发下？"
    return _clip(answer, max_chars)
