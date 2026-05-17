@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo.
echo ================================================================
echo   DeepSeek TUI + Page Agent — One-Click Setup
echo   After setup your TUI includes: Session Manager, Browser Control,
echo   MCP Servers, AI Skills, WeChat Bridge, Screenshot Sentinel
echo ================================================================
echo.

set "DEEPSEEK_DIR=%USERPROFILE%\.deepseek"
set "SCRIPT_DIR=%~dp0"

:: Prerequisites
echo [1/6] Checking prerequisites...
where node >nul 2>&1
if %ERRORLEVEL% neq 0 ( echo   [FAIL] Node.js not found ^(https://nodejs.org/^) & pause & exit /b 1 )
echo   [OK] Node.js
node --version

where python >nul 2>&1
if %ERRORLEVEL% neq 0 ( echo   [FAIL] Python not found ^(https://python.org/^) & pause & exit /b 1 )
echo   [OK] Python
python --version
echo.

:: Install DeepSeek TUI
echo [2/6] Installing DeepSeek TUI...
where deepseek >nul 2>&1
if %ERRORLEVEL% neq 0 (
    npm install -g deepseek-tui
    if %ERRORLEVEL% neq 0 ( echo   [FAIL] Install failed & pause & exit /b 1 )
)
echo   [OK] deepseek
echo.

:: Python deps
echo [3/6] Installing Python dependencies...
pip install textual pynput pyperclip pillow
echo   [OK]
echo.

:: Configure
echo [4/6] Configuring DeepSeek TUI...
if not exist "%DEEPSEEK_DIR%" mkdir "%DEEPSEEK_DIR%"

copy /Y "%SCRIPT_DIR%deepseek-tui\config.toml" "%DEEPSEEK_DIR%\config.toml" >nul
copy /Y "%SCRIPT_DIR%deepseek-tui\AGENTS.md" "%DEEPSEEK_DIR%\AGENTS.md" >nul
copy /Y "%SCRIPT_DIR%deepseek-tui\session_manager.py" "%DEEPSEEK_DIR%\session_manager.py" >nul
copy /Y "%SCRIPT_DIR%deepseek-tui\mcp.json" "%DEEPSEEK_DIR%\mcp.json" >nul
copy /Y "%SCRIPT_DIR%deepseek-tui\wechat_bridge.py" "%DEEPSEEK_DIR%\wechat_bridge.py" >nul
copy /Y "%SCRIPT_DIR%deepseek-tui\windows-automation.py" "%DEEPSEEK_DIR%\windows-automation.py" >nul
copy /Y "%SCRIPT_DIR%deepseek-tui\pageagent-site-handlers.json" "%DEEPSEEK_DIR%\pageagent-site-handlers.json" >nul

if not exist "%DEEPSEEK_DIR%\feishu-sentinel" mkdir "%DEEPSEEK_DIR%\feishu-sentinel"
xcopy /E /Y "%SCRIPT_DIR%deepseek-tui\feishu-sentinel" "%DEEPSEEK_DIR%\feishu-sentinel\" >nul

if not exist "%DEEPSEEK_DIR%\skills" mkdir "%DEEPSEEK_DIR%\skills"
xcopy /E /Y "%SCRIPT_DIR%skills" "%DEEPSEEK_DIR%\skills\" >nul

:: Patch run.js
set "RUN_JS=%APPDATA%\npm\node_modules\deepseek-tui\scripts\run.js"
if exist "%RUN_JS%" (
    findstr "SESSION_MGR_SCRIPT" "%RUN_JS%" >nul 2>&1
    if !ERRORLEVEL! neq 0 (
        echo Patching run.js...
        powershell -Command "$c=Get-Content '%RUN_JS%' -Raw; $old='async function run(binaryName)'; if($c.Contains($old)){ $e='const SESSION_MGR_SCRIPT=process.platform===\"win32\"?\"%USERPROFILE:\=\\%\\\\.deepseek\\\\session_manager.py\":path.join(process.env.HOME,\".deepseek\",\"session_manager.py\");const RESUME_TARGET=process.platform===\"win32\"?\"%USERPROFILE:\=\\%\\\\.deepseek\\\\.resume_target\":path.join(process.env.HOME,\".deepseek\",\".resume_target\");'+$old; $c=$c.Replace($old,$e); Set-Content '%RUN_JS%' -Value $c -Encoding UTF8; Write-Host '[OK] run.js patched' } else { Write-Host '[WARN] Could not patch run.js' }"
    ) else (
        echo   [OK] Already patched
    )
)
echo.

:: Page Agent
echo [5/6] Installing Page Agent ^(browser control^)...
cd /d "%SCRIPT_DIR%page-agent"
call npm install >nul 2>&1 && echo   [OK] Page Agent || echo   [WARN] npm install failed
call npm run build:libs >nul 2>&1 && echo   [OK] Built || echo   [WARN] Build failed

cd /d "%SCRIPT_DIR%mcp-servers\vision-mcp-server"
if exist "package.json" ( call npm install >nul 2>&1 && echo   [OK] Vision MCP )

echo.
echo ================================================================
echo   [OK] Setup Complete!
echo ================================================================
echo.
echo  First time:
echo   1. Edit %%DEEPSEEK_DIR%%\config.toml -- add API key
echo   2. deepseek
echo.
echo  Features:
echo   • Session Manager - Terminal UI to browse/resume sessions
echo   • Browser Control - Page Agent MCP
echo   • WeChat Bridge - bi-directional chat relay
echo   • Screenshot Sentinel - Feishu auto-capture
echo   • Windows GUI Automation
echo   • 17 AI Skills
echo   • Vision MCP - Image analysis/OCR
echo.
pause