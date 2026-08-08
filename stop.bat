@echo off
chcp 65001 >nul
echo 正在停止占用 3200 / 18080 端口的 node 进程...
powershell -NoProfile -Command "$ports=3200,18080; Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; Write-Host ('已停止 PID ' + $_) }"
echo 完成。
pause
