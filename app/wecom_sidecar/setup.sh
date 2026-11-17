#!/usr/bin/env bash
# 一次性：在 app/wecom_sidecar/.venv 建虚拟环境并装依赖。装完 office-lab server 会自动优先用它。
set -euo pipefail
cd "$(dirname "$0")"
echo "[wecom_sidecar] 创建虚拟环境 .venv ..."
python3 -m venv .venv
echo "[wecom_sidecar] 安装依赖 ..."
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements.txt
echo "[wecom_sidecar] 完成。企微渠道设置卡片里开启并填 BotID/Secret 即可由 office-lab 拉起。"
