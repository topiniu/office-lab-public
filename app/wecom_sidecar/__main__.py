"""企微渠道 worker 入口：``python -m wecom_sidecar``（cwd = office-lab/app）。

不用 SDK 的全阻塞 run()，改为受管轮询循环 serve()：定时从 office-lab 拉运行时配置
（BotID/Secret/开关），凭证或开关变化就重连/断开，实现后台改配置的热加载。

分工：office-lab server.js 决定是否 spawn 本进程（enabled + 凭证齐时）；office-lab 的
``runs/wecom-config.json`` 的 ``enabled`` 决定是否真正建立长连接（后台设置卡片控制）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any, Dict, Optional, Tuple

from .config import settings
from .handlers import register_handlers
from .office_client import persona_url
from .runtime import fetch_runtime_config, runtime_url

logger = logging.getLogger("wecom_sidecar")

# 连接凭据指纹：(bot_id, secret, ws_url)
ConnKey = Tuple[str, str, str]


def _effective_key(cfg: Optional[Dict[str, Any]]) -> Optional[ConnKey]:
    """从配置算出连接指纹；None 表示「不该连接」（禁用或凭证缺失）。"""
    if not cfg or not cfg.get("enabled"):
        return None
    bot_id = str(cfg.get("bot_id") or "").strip()
    secret = str(cfg.get("bot_secret") or "").strip()
    if not bot_id or not secret:
        return None
    return (bot_id, secret, str(cfg.get("ws_url") or "").strip())


def _decide(applied: Optional[ConnKey], cfg: Optional[Dict[str, Any]]) -> Tuple[str, Optional[ConnKey]]:
    """纯决策：返回 (action, key)，action ∈ connect/reconnect/disconnect/noop。"""
    want = _effective_key(cfg)
    if want is None:
        return ("disconnect", None) if applied is not None else ("noop", None)
    if applied is None:
        return ("connect", want)
    if want != applied:
        return ("reconnect", want)
    return ("noop", applied)


def _seed_config() -> Optional[Dict[str, Any]]:
    """runtime 端点不可达时的兜底：用 env 种子凭证（若齐全）尝试连接，避免完全瘫痪。"""
    if not settings.bot_id or not settings.bot_secret:
        return None
    return {
        "enabled": True,
        "bot_id": settings.bot_id,
        "bot_secret": settings.bot_secret,
        "ws_url": settings.ws_url,
    }


async def serve() -> None:
    from aibot import WSClient, WSClientOptions

    poll = settings.config_poll_seconds
    logger.info(
        "worker 启动，主人格端点=%s，office-lab runtime=%s，配置轮询=%ss",
        persona_url(), runtime_url(), poll,
    )
    ws = None
    applied: Optional[ConnKey] = None

    while True:
        cfg = await fetch_runtime_config()
        if cfg is None:  # 拉取失败 → 用 env 种子兜底（首轮尤其有用），仍失败则保持现状
            cfg = _seed_config()
        if cfg is not None:
            action, key = _decide(applied, cfg)
            if action in ("disconnect", "reconnect") and ws is not None:
                logger.info("配置变更 → 断开旧连接")
                try:
                    ws.disconnect()
                except Exception:  # noqa: BLE001
                    pass
                ws = None
            if action in ("connect", "reconnect"):
                bot_id, secret, ws_url = key  # type: ignore[misc]
                opts: Dict[str, Any] = {"bot_id": bot_id, "secret": secret}
                if ws_url:
                    opts["ws_url"] = ws_url
                ws = WSClient(WSClientOptions(**opts))
                register_handlers(ws)
                await ws.connect()
                applied = key
                logger.info("已%s，bot_id=%s…", "重连" if action == "reconnect" else "连接", bot_id[:6])
            elif action == "disconnect":
                applied = None
                logger.info("配置已禁用/凭证缺失 → 保持断开")
        await asyncio.sleep(poll)


async def _probe_async(timeout: float = 15.0) -> Dict[str, Any]:
    """用 env 里的 BotID/Secret 尝试连一次企微，等 authenticated / error / 超时，返回判定 dict。

    仅供「企微连通测试」短命探测用（连上即断开，不进 serve 循环）。"""
    from aibot import WSClient, WSClientOptions

    if not settings.bot_id or not settings.bot_secret:
        return {"ok": False, "message": "缺少 BotID / Secret"}

    ev = asyncio.Event()
    result: Dict[str, Any] = {"ok": False, "message": f"连接超时（{int(timeout)}s 内未完成认证，请检查 BotID/Secret 与网络）"}

    opts: Dict[str, Any] = {"bot_id": settings.bot_id, "secret": settings.bot_secret}
    if settings.ws_url:
        opts["ws_url"] = settings.ws_url
    ws = WSClient(WSClientOptions(**opts))

    @ws.on("authenticated")
    def _a() -> None:
        result["ok"] = True
        result["message"] = "认证成功，企微连通正常"
        ev.set()

    @ws.on("error")
    def _e(error: Any = None) -> None:
        if not result["ok"]:
            result["message"] = f"连接错误：{error}"
        ev.set()

    try:
        await ws.connect()
        await asyncio.wait_for(ev.wait(), timeout)
    except asyncio.TimeoutError:
        pass
    except Exception as exc:  # noqa: BLE001
        result["ok"] = False
        result["message"] = f"连接失败：{exc}"
    finally:
        try:
            ws.disconnect()
        except Exception:  # noqa: BLE001
            pass
    return result


def _run_probe() -> int:
    """--probe：把连通结果以 JSON 打到 stdout 供 office-lab 解析。SDK 未装也返回 JSON（不裸崩）。"""
    try:
        import aibot  # noqa: F401
    except ImportError:
        print(json.dumps({"ok": False, "message": "未安装 wecom-aibot-python-sdk，无法测企微连通（先跑 setup.cmd）"}, ensure_ascii=False))
        return 0
    try:
        res = asyncio.run(_probe_async())
    except Exception as exc:  # noqa: BLE001
        res = {"ok": False, "message": f"探测异常：{exc}"}
    print(json.dumps(res, ensure_ascii=False))
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [wecom_sidecar] %(message)s")

    if "--probe" in sys.argv[1:]:
        return _run_probe()

    try:
        import aibot  # noqa: F401
    except ImportError:
        logger.error(
            "未安装 wecom-aibot-python-sdk，请先在 app/wecom_sidecar 下 `setup.cmd`（或 "
            "`pip install -r requirements.txt`）。"
        )
        return 1

    logger.info("BotID/Secret 从 office-lab 后台设置卡片读取（GET /api/wecom-bot/runtime）；端点不可达时回退 env 种子。")
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        logger.info("收到中断，退出。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
