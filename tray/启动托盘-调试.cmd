@echo off
rem Debug launcher: runs the tray in a VISIBLE window so you can see any error.
rem Use this when the normal launcher shows no tray icon. Keep this window open; closing it stops the tray.
chcp 65001 >nul
echo Starting Wangzichenglong tray (debug/visible mode)...
echo If it errors, copy the red text below. Log is also at ..\app\runs\tray.log
echo.
rem Tell the tray script NOT to hide its console — debug mode must stay visible to show errors.
set OFFICE_LAB_TRAY_DEBUG=1
powershell -NoProfile -ExecutionPolicy Bypass -Sta -File "%~dp0office-lab-tray.ps1"
echo.
echo ---- tray exited (errorlevel %errorlevel%) ----
pause
