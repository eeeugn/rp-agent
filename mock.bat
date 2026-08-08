@echo off
chcp 65001 >nul
cd /d "%~dp0"
title rp-agent Mock 模式

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

echo 正在启动假模型服务（端口 18080）...
start "rp-agent-mock" cmd /k "node --experimental-strip-types scripts/mock-llm.ts"

echo 正在启动 Web 服务（Mock 模式，浏览器将自动打开）...
start "" powershell -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3200'"
set RPA_MOCK=1
node --experimental-strip-types rp-server.ts
echo.
echo 服务已退出。
pause
