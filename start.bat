@echo off
chcp 65001 >nul
cd /d "%~dp0"
title rp-agent 启动器

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未找到 Node.js，请先安装 Node 22+：https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo 首次运行，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

echo 正在启动 rp-agent 服务（浏览器将自动打开）...
start "" powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:3200'"
node --experimental-strip-types rp-server.ts
echo.
echo [提示] API 配置请在网页「设置 → API 与模型」里填写并保存，无需修改 .env。
echo 服务已退出。
pause
