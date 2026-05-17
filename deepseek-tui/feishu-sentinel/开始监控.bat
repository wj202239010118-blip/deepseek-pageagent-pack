@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
cd /d "%~dp0"

title 飞书截图哨兵 v2.0

REM ── Python 检测 ──────────────────────────────────────────
set "PYEXE="
set "PYARGS="

where py >nul 2>nul
if %errorlevel% equ 0 (
    set "PYEXE=py"
    set "PYARGS=-3"
    goto :check_version
)

where python >nul 2>nul
if %errorlevel% equ 0 (
    set "PYEXE=python"
    goto :check_version
)

where python3 >nul 2>nul
if %errorlevel% equ 0 (
    set "PYEXE=python3"
    goto :check_version
)

echo [错误] 未找到 Python！
echo 请安装 Python 3.9+ https://python.org/downloads/
echo 安装时务必勾选 "Add Python to PATH"
echo.
pause
exit /b 1

:check_version
for /f "tokens=2" %%v in ('"%PYEXE%" %PYARGS% --version 2^>^&1') do set "PYVER=%%v"
echo [信息] 检测到 Python %PYVER%

REM ── 创建虚拟环境（可选） ─────────────────────────────────
set "VENV_DIR=%~dp0.venv"
if exist "%VENV_DIR%\Scripts\python.exe" (
    echo [信息] 使用虚拟环境: %VENV_DIR%
    set "PYEXE=%VENV_DIR%\Scripts\python.exe"
    set "PYARGS="
    goto :install_deps
)

REM 尝试创建虚拟环境
echo [信息] 正在创建虚拟环境...
"%PYEXE%" %PYARGS% -m venv "%VENV_DIR%" >nul 2>nul
if %errorlevel% equ 0 (
    echo [信息] 虚拟环境已创建
    set "PYEXE=%VENV_DIR%\Scripts\python.exe"
    set "PYARGS="
) else (
    echo [信息] 虚拟环境创建失败，使用系统 Python
)

:install_deps
echo [信息] 检查依赖...
"%PYEXE%" %PYARGS% -c "import pynput,PIL,pyperclip" >nul 2>nul
if errorlevel 1 (
    echo [信息] 安装依赖中...
    "%PYEXE%" %PYARGS% -m pip install -r "%~dp0requirements.txt" -q
    if errorlevel 1 (
        echo [错误] 依赖安装失败！请手动执行:
        echo   "%PYEXE%" %PYARGS% -m pip install -r "%~dp0requirements.txt"
        echo.
        pause
        exit /b 1
    )
    echo [信息] 依赖安装完成
)

REM ── 启动哨兵 ────────────────────────────────────────────
echo.
echo ============================================
echo   Feishu Screenshot Sentinel v2.0
echo ============================================
echo   Ctrl+Shift+A  飞书原生截图
echo   Ctrl+Shift+X  AI 截图（剪贴板=路径）
echo   Esc           取消
echo   Ctrl+C        停止
echo ============================================
echo.

"%PYEXE%" %PYARGS% "%~dp0feishu_screenshot_guard.py"

echo.
echo [已退出]
pause
