@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ╔══════════════════════════════════════════════════╗
echo ║  DeepSeek TUI + Page Agent — 一键安装脚本       ║
echo ╚══════════════════════════════════════════════════╝
echo.

:: ─── Check Node.js ───
echo [1/5] 检查 Node.js...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ❌ 未找到 Node.js，请先安装：https://nodejs.org/
    pause
    exit /b 1
)
echo   ✅ Node.js: 
node --version

:: ─── Check npm ───
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ❌ 未找到 npm
    pause
    exit /b 1
)
echo   ✅ npm:
npm --version

:: ─── Check DeepSeek TUI ───
echo.
echo [2/5] 检查 DeepSeek TUI...
where deepseek >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo   ⚠️  未找到 DeepSeek TUI
    echo   安装：winget install deepseek-tui
    echo   或从 https://github.com/deepseek-ai/deepseek-tui/releases 下载
) else (
    echo   ✅ DeepSeek TUI:
    deepseek --version
)

:: ─── Configure DeepSeek TUI ───
echo.
echo [3/5] 配置 DeepSeek TUI...
set "DEEPSEEK_DIR=%USERPROFILE%\.deepseek"
if not exist "%DEEPSEEK_DIR%" mkdir "%DEEPSEEK_DIR%"

if not exist "%DEEPSEEK_DIR%\config.toml" (
    echo   → 复制 config.toml 到 %DEEPSEEK_DIR%
    copy /Y "%~dp0deepseek-tui\config.toml" "%DEEPSEEK_DIR%\config.toml" >nul
    echo   ✅ 配置模板已复制
    echo   ⚠️  请编辑 %DEEPSEEK_DIR%\config.toml 填入你的 API Key
) else (
    echo   ⚠️  config.toml 已存在，跳过
    echo   如需覆盖，请手动操作
)

if not exist "%DEEPSEEK_DIR%\AGENTS.md" (
    echo   → 复制 AGENTS.md 到 %DEEPSEEK_DIR%
    copy /Y "%~dp0deepseek-tui\AGENTS.md" "%DEEPSEEK_DIR%\AGENTS.md" >nul
    echo   ✅ Agent 指令已安装
) else (
    echo   ⚠️  AGENTS.md 已存在，跳过
)

:: ─── Install Page Agent ───
echo.
echo [4/5] 安装 Page Agent 依赖...
cd /d "%~dp0page-agent"
call npm install
if %ERRORLEVEL% neq 0 (
    echo   ❌ npm install 失败
    pause
    exit /b 1
)
echo   ✅ 依赖安装完成

echo   → 构建库...
call npm run build:libs
if %ERRORLEVEL% neq 0 (
    echo   ❌ 构建失败
    pause
    exit /b 1
)
echo   ✅ 构建完成

:: ─── Done ───
echo.
echo [5/5] ✅ 安装完成！
echo.
echo ────────────────────────────────────────────────────────
echo   下一步：
echo.
echo   1. 编辑 %DEEPSEEK_DIR%\config.toml
echo      将 YOUR_DEEPSEEK_API_KEY 替换为你的真实 API Key
echo.
echo   2. 加载 Chrome 扩展：
echo      打开 chrome://extensions/ → 开发者模式
echo      → 加载已解压的扩展程序
echo      → 选择 page-agent\packages\extension\dist
echo.
echo   3. 启动 DeepSeek TUI：
echo      deepseek
echo.
echo   4. 在 TUI 中输入任务，例如：
echo      "打开 GitHub 搜索 page-agent issue"
echo ────────────────────────────────────────────────────────
echo.

cd /d "%~dp0"
pause
