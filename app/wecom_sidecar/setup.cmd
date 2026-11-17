@echo off
REM 一次性：在 app/wecom_sidecar/.venv 建虚拟环境并装依赖。装完 office-lab server 会自动优先用它。
setlocal
cd /d "%~dp0"
echo [wecom_sidecar] 创建虚拟环境 .venv ...
python -m venv .venv || (echo 建 venv 失败，确认 python 在 PATH & exit /b 1)
echo [wecom_sidecar] 安装依赖 ...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt || (echo pip install 失败 & exit /b 1)
echo [wecom_sidecar] 完成。企微渠道设置卡片里开启并填 BotID/Secret 即可由 office-lab 拉起。
endlocal
