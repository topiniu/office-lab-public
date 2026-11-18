@echo off
rem Wangzichenglong tray launcher (robust): launches PowerShell hidden directly.
rem Does NOT depend on Windows Script Host (.vbs), so it still works when WSH is blocked by AV/policy.
rem A console window may flash for a moment; the tray then runs hidden in the background.
start "" powershell -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File "%~dp0office-lab-tray.ps1"
exit
