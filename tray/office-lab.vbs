' Wangzichenglong tray - silent launcher (zero console flash). Requires Windows Script Host enabled.
' If WSH is blocked by antivirus/group policy, use 启动托盘.cmd instead (it does not need WSH).
Dim fso, sh, dir, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Sta -WindowStyle Hidden -File """ & dir & "\office-lab-tray.ps1"""
sh.Run cmd, 0, False
