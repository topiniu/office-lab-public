"""企微长连接事件处理：把文本消息转给 office-lab 主人格，流式回复。

`handle_text` 与网络/SDK 解耦（依赖通过参数注入），便于单测；`register_handlers` 负责把
各事件绑到 SDK 的 WSClient 上。

架构（用户拍板）：sidecar 只做企微 I/O，是一根「哑管道」——不做意图判断、不查知识库、不派工。
收到消息就转给 office-lab 主人格（`ask_office_lab`），由主人格自行决定要不要用知识库工具、
要不要把需求登记为待办、怎么用菲菲的口吻回。正式开工只在望子成龙看板，企微不是开工信号。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import random
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .config import settings
from .format import format_reply
from .office_client import ask_office_lab, ingest_zip
from .report import report_state

logger = logging.getLogger("wecom_sidecar")

# sidecar 的"状态提示语"口吻：口语、平实、不讨好（无"呀/哈/～"和表情堆砌；真正的答复由主人格生成）。
# 这些只在答复较慢时才露脸（秒答直接发答案、不垫开场），像同事随口回一句即可。
# 仍不预设“检索/查资料”（是否动用知识库由主人格判断）。
_OPENERS = [
    "收到，我看下。",
    "稍等，我想想。",
    "在看了，马上。",
    "收到，这就处理。",
]
# 生成较慢时的进度（按顺序递进）——同样平实、中性，不假设在“检索资料”。
_PROGRESS = [
    "还在看，稍等。",
    "内容有点多，我理一下。",
    "快好了。",
]
_ERROR_REPLY = "刚出了点岔子，你再发一次试试；还不行我找人来看。"
_UNSUPPORTED_REPLY = "我这边先只处理文字，麻烦发文字给我。"
# 防抖攒批：同一 userid 短时间内连发的多条，静默 _DEBOUNCE_SECONDS 后合并成一次处理、回一次——
# 解决逐条转发/连打多条被"每条各触发一次 LLM"的碎片化与浪费。超上限则立即 flush（防刷/防超长）。
_DEBOUNCE_SECONDS = 1.5
# 单条消息不预先垫开场：flush 里先给答案这个短窗口，秒答直发、慢才垫"稍候"（避免"你好"也被垫开场）。
_FIRST_WAIT_SECONDS = 2.5
_MAX_BATCH_MSGS = 30
_MAX_BATCH_CHARS = 8000
_MAX_IMAGE_BYTES = 5 * 1024 * 1024    # 单图上限（防超大 base64）
_MAX_IMAGES_PER_BATCH = 20            # 一批最多几张图（与 office-lab INGEST_MAX_IMAGES 对齐，支持批量聊天记录截图）
_MAX_ZIP_BYTES = 25 * 1024 * 1024     # 企微 zip 文件上限（< persona 端 30MB HTTP 上限）
_ZIP_UNSUPPORTED_REPLY = "这个文件我先只认 .zip（聊天记录截图打包）。语音/其它文件暂不支持。"
_buffers: Dict[str, Dict[str, Any]] = {}   # userid -> {texts, images, last_frame, opened, task, ask, gen}

# 图片扩展名 → media_type（Claude 图片 block 需要）
_IMG_MIME = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp"}


def _img_media_type(filename: Optional[str]) -> str:
    if filename and "." in filename:
        return _IMG_MIME.get(filename.rsplit(".", 1)[-1].lower(), "image/jpeg")
    return "image/jpeg"


async def _download_image(ws_client: Any, img: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """从图片对象取 url+aeskey（防御性兼容字段名），经 SDK 下载解密 → {media_type, data(base64)}；失败/超限返回 None。"""
    if not isinstance(img, dict):
        return None
    url = img.get("url") or img.get("download_url") or img.get("cdn_url") or ""
    aeskey = img.get("aeskey") or img.get("aes_key") or img.get("key") or None
    if not url:
        return None
    try:
        data, filename = await ws_client.download_file(url, aeskey)
    except Exception as exc:  # noqa: BLE001
        logger.warning("下载企微图片失败: %s", exc)
        return None
    if not data or len(data) > _MAX_IMAGE_BYTES:
        logger.warning("图片为空或超限（%s 字节）", len(data or b""))
        return None
    return {"media_type": _img_media_type(filename), "data": base64.b64encode(data).decode("ascii")}


def _opener() -> str:
    return random.choice(_OPENERS)


def _new_stream_id() -> str:
    from aibot import generate_req_id  # 延迟导入：纯逻辑单测无需装 SDK

    return generate_req_id("stream")


async def _enqueue(
    ws_client: Any,
    userid: str,
    frame: Dict[str, Any],
    *,
    texts: Optional[List[str]] = None,
    images: Optional[List[Dict[str, str]]] = None,
    ask: Callable[..., Awaitable[Dict[str, Any]]],
    gen_stream_id: Optional[Callable[[], str]],
) -> None:
    """把文本/图片攒进该 userid 的防抖 buffer；成 burst（≥2 项）才垫开场；超上限立即 flush，否则顺延计时。"""
    buf = _buffers.get(userid)
    if buf is None:
        buf = {"texts": [], "images": [], "last_frame": frame, "opened": False, "task": None, "ask": ask, "gen": gen_stream_id}
        _buffers[userid] = buf
    if texts:
        buf["texts"].extend(texts)
    if images:
        buf["images"].extend(images)
    buf["last_frame"] = frame
    buf["ask"] = ask
    buf["gen"] = gen_stream_id

    count = len(buf["texts"]) + len(buf["images"])
    # 成 burst（第 2 项起）才秒回开场占窗口；单条留给 flush 的"秒答直发"判断，不预先垫"稍候"。
    if count >= 2 and not buf["opened"]:
        buf["opened"] = True
        try:
            await ws_client.reply_stream(frame, (gen_stream_id or _new_stream_id)(), _opener(), False)
        except Exception:  # noqa: BLE001
            pass

    over = (count >= _MAX_BATCH_MSGS
            or sum(len(t) for t in buf["texts"]) >= _MAX_BATCH_CHARS
            or len(buf["images"]) >= _MAX_IMAGES_PER_BATCH)
    if buf["task"]:
        buf["task"].cancel()
    buf["task"] = asyncio.ensure_future(_debounced_flush(ws_client, userid, 0 if over else _DEBOUNCE_SECONDS))


async def handle_text(
    ws_client: Any,
    frame: Dict[str, Any],
    *,
    ask: Callable[..., Awaitable[Dict[str, Any]]] = ask_office_lab,
    gen_stream_id: Optional[Callable[[], str]] = None,
) -> None:
    """收到文本：按 userid **防抖攒批**（合并连发/逐条转发/图文），静默后合并成一次交 office-lab 主人格作答。"""
    body = frame.get("body", {}) or {}
    content = ((body.get("text") or {}).get("content") or "").strip()
    userid = ((body.get("from") or {}).get("userid") or "").strip() or "unknown"
    if not content:
        return
    await _enqueue(ws_client, userid, frame, texts=[content], ask=ask, gen_stream_id=gen_stream_id)


async def handle_image(
    ws_client: Any,
    frame: Dict[str, Any],
    *,
    ask: Callable[..., Awaitable[Dict[str, Any]]] = ask_office_lab,
    gen_stream_id: Optional[Callable[[], str]] = None,
) -> None:
    """收到图片：下载解密 → 攒进 buffer（与文字一起合并交主人格看图）。下载失败给体面兜底。"""
    body = frame.get("body", {}) or {}
    userid = ((body.get("from") or {}).get("userid") or "").strip() or "unknown"
    dl = await _download_image(ws_client, body.get("image") or {})
    if dl is None:
        try:
            await ws_client.reply_stream(frame, (gen_stream_id or _new_stream_id)(), "这张图我没取到，麻烦补个文字说明或重发一下。", True)
        except Exception:  # noqa: BLE001
            pass
        return
    await _enqueue(ws_client, userid, frame, images=[dl], ask=ask, gen_stream_id=gen_stream_id)


async def handle_mixed(
    ws_client: Any,
    frame: Dict[str, Any],
    *,
    ask: Callable[..., Awaitable[Dict[str, Any]]] = ask_office_lab,
    gen_stream_id: Optional[Callable[[], str]] = None,
) -> None:
    """收到图文混排：提取文字 + 逐张下载图片，一起攒进 buffer。"""
    body = frame.get("body", {}) or {}
    userid = ((body.get("from") or {}).get("userid") or "").strip() or "unknown"
    mixed = body.get("mixed") or {}
    items = mixed.get("msg_item") or mixed.get("items") or mixed.get("item") or []
    texts: List[str] = []
    images: List[Dict[str, str]] = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        t = it.get("msgtype") or it.get("type") or ""
        if t == "text" or "text" in it:
            c = ((it.get("text") or {}).get("content")) or it.get("content") or ""
            if c:
                texts.append(str(c))
        if t == "image" or "image" in it:
            dl = await _download_image(ws_client, it.get("image") or it)
            if dl:
                images.append(dl)
    if not texts and not images:
        return
    await _enqueue(ws_client, userid, frame, texts=texts or None, images=images or None, ask=ask, gen_stream_id=gen_stream_id)


async def handle_file(
    ws_client: Any,
    frame: Dict[str, Any],
    *,
    gen_stream_id: Optional[Callable[[], str]] = None,
) -> None:
    """收到文件：只处理 .zip（聊天记录截图打包）——下载 → 转 office-lab 解压取图 → 菲菲读图登记 → 回复。其余文件走不支持话术。"""
    body = frame.get("body", {}) or {}
    userid = ((body.get("from") or {}).get("userid") or "").strip() or "unknown"
    fobj = body.get("file") or body.get("media") or {}
    url = (fobj.get("url") or fobj.get("download_url") or fobj.get("cdn_url") or "") if isinstance(fobj, dict) else ""
    aeskey = (fobj.get("aeskey") or fobj.get("aes_key") or fobj.get("key") or None) if isinstance(fobj, dict) else None
    name_hint = (fobj.get("filename") or fobj.get("name") or "") if isinstance(fobj, dict) else ""
    stream_id = (gen_stream_id or _new_stream_id)()

    if not url:
        await _safe_reply(ws_client, frame, stream_id, _ZIP_UNSUPPORTED_REPLY, True)
        return
    try:
        data, filename = await ws_client.download_file(url, aeskey)
    except Exception as exc:  # noqa: BLE001
        logger.warning("下载企微文件失败: %s", exc)
        await _safe_reply(ws_client, frame, stream_id, "这个文件我没取到，麻烦重发一下，或把截图直接发我。", True)
        return
    fname = (filename or name_hint or "").strip()
    if not fname.lower().endswith(".zip"):
        await _safe_reply(ws_client, frame, stream_id, _ZIP_UNSUPPORTED_REPLY, True)
        return
    if not data or len(data) > _MAX_ZIP_BYTES:
        await _safe_reply(ws_client, frame, stream_id, f"这个压缩包太大了（上限 {_MAX_ZIP_BYTES // (1024*1024)}MB），麻烦拆小一点再发。", True)
        return

    await _safe_reply(ws_client, frame, stream_id, "收到压缩包，我看下里面的聊天记录。", False)
    try:
        r = await ingest_zip(userid, fname, base64.b64encode(data).decode("ascii"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("ingest_zip 失败 (user=%s): %s", userid, exc)
        await _safe_reply(ws_client, frame, stream_id, _ERROR_REPLY, True)
        return
    reply = (r.get("reply") or "").strip() or (r.get("error") or "这个压缩包里我没找到能读的聊天记录截图。")
    cap = settings.reply_max_chars
    if cap and cap > 0 and len(reply) > cap:
        reply = reply[: cap - 1].rstrip() + "…"
    await _safe_reply(ws_client, frame, stream_id, reply, True)


async def _safe_reply(ws_client: Any, frame: Dict[str, Any], stream_id: str, text: str, finished: bool) -> None:
    try:
        await ws_client.reply_stream(frame, stream_id, text, finished)
    except Exception:  # noqa: BLE001
        pass


async def _debounced_flush(ws_client: Any, userid: str, delay: float) -> None:
    """静默 delay 秒后（其间无新消息、未被 cancel），把该 userid 攒的消息合并成一次处理并回复。"""
    try:
        if delay:
            await asyncio.sleep(delay)
    except asyncio.CancelledError:
        return   # 期间来了新消息 → 本次作废，交给新计时器
    buf = _buffers.pop(userid, None)
    if not buf or (not buf["texts"] and not buf.get("images")):
        return
    combined = "\n".join(buf["texts"])
    images = buf.get("images") or None
    frame = buf["last_frame"]
    ask = buf["ask"]
    stream_id = (buf["gen"] or _new_stream_id)()
    opened = buf["opened"]

    ask_task = asyncio.ensure_future(ask(combined, userid, images))
    # 单条未开场：先给答案一个短窗口，秒答直发、慢才垫开场（避免"你好"也被垫"稍候"）。
    if not opened:
        done, _pending = await asyncio.wait({ask_task}, timeout=_FIRST_WAIT_SECONDS)
        if ask_task not in done:
            try:
                await ws_client.reply_stream(frame, stream_id, _opener(), False)
            except Exception:  # noqa: BLE001
                pass
            opened = True
    # 仍在生成 → 补进度。
    if not ask_task.done():
        step = max(1.0, float(settings.progress_step_seconds or 7))
        idx = 0
        while True:
            done, _pending = await asyncio.wait({ask_task}, timeout=step)
            if ask_task in done:
                break
            if idx < len(_PROGRESS):
                try:
                    await ws_client.reply_stream(frame, stream_id, _PROGRESS[idx], False)
                except Exception:  # noqa: BLE001
                    pass
                idx += 1

    try:
        reply = format_reply(ask_task.result(), settings.reply_max_chars)
    except Exception as exc:  # noqa: BLE001 - 兜底：任何失败都给体面回复
        logger.warning("wecom_sidecar ask_office_lab failed (user=%s): %s", userid, exc)
        reply = _ERROR_REPLY
    try:
        await ws_client.reply_stream(frame, stream_id, reply, True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("reply_stream final failed (user=%s): %s", userid, exc)


async def handle_unsupported(
    ws_client: Any, frame: Dict[str, Any], *, gen_stream_id: Optional[Callable[[], str]] = None
) -> None:
    stream_id = (gen_stream_id or _new_stream_id)()
    await ws_client.reply_stream(frame, stream_id, _UNSUPPORTED_REPLY, True)


async def handle_enter_chat(ws_client: Any, frame: Dict[str, Any]) -> None:
    await ws_client.reply_welcome(
        frame, {"msgtype": "text", "text": {"content": settings.welcome_message}}
    )


def register_handlers(ws_client: Any) -> None:
    """把所有事件绑到 SDK 客户端（pyee 事件）。"""

    @ws_client.on("connected")
    def _on_connected() -> None:  # pragma: no cover - 纯日志
        logger.info("WebSocket 已连接")
        asyncio.ensure_future(report_state("connected"))

    @ws_client.on("authenticated")
    def _on_authenticated() -> None:  # pragma: no cover
        logger.info("认证成功，菲菲已就绪")
        asyncio.ensure_future(report_state("authenticated"))

    @ws_client.on("disconnected")
    def _on_disconnected(reason: Any = None) -> None:  # pragma: no cover
        logger.warning("连接断开: %s（SDK 将自动重连）", reason)
        asyncio.ensure_future(report_state("disconnected", str(reason or "")))

    @ws_client.on("reconnecting")
    def _on_reconnecting(attempt: Any = None) -> None:  # pragma: no cover
        logger.info("正在第 %s 次重连…", attempt)

    @ws_client.on("error")
    def _on_error(error: Any = None) -> None:  # pragma: no cover
        logger.error("SDK 错误: %s", error)
        asyncio.ensure_future(report_state("error", str(error or "")))

    @ws_client.on("message.text")
    async def _on_text(frame: Dict[str, Any]) -> None:  # pragma: no cover - 逻辑在 handle_text
        await handle_text(ws_client, frame)

    @ws_client.on("message.image")
    async def _on_image(frame: Dict[str, Any]) -> None:  # pragma: no cover - 逻辑在 handle_image
        await handle_image(ws_client, frame)

    @ws_client.on("message.mixed")
    async def _on_mixed(frame: Dict[str, Any]) -> None:  # pragma: no cover - 逻辑在 handle_mixed
        await handle_mixed(ws_client, frame)

    @ws_client.on("event.enter_chat")
    async def _on_enter(frame: Dict[str, Any]) -> None:  # pragma: no cover
        await handle_enter_chat(ws_client, frame)

    @ws_client.on("message.file")
    async def _on_file(frame: Dict[str, Any]) -> None:  # pragma: no cover - 逻辑在 handle_file
        await handle_file(ws_client, frame)

    async def _on_unsupported(frame: Dict[str, Any]) -> None:  # pragma: no cover
        await handle_unsupported(ws_client, frame)

    # 语音仍暂不支持；图片/图文由 handle_image/handle_mixed，文件(.zip)由 handle_file 处理。
    ws_client.on("message.voice")(_on_unsupported)
