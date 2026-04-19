@echo off
REM LoRA Manager standalone launcher (ASCII-only lines avoid cmd.exe misparsing UTF-8 batch on some locales).
setlocal EnableExtensions
cd /d "%~dp0"

REM ----- Port: edit the number below, OR run: run_lora_manager.bat 8189 -----
REM This line always wins over inherited LORA_MANAGER_PORT (avoids stale env vs. bat mismatch).
set "LORA_MANAGER_PORT=8188"
if not "%~1"=="" set "LORA_MANAGER_PORT=%~1"
set "LORA_MANAGER_STANDALONE_PORT=%LORA_MANAGER_PORT%"

echo [LoRA Manager] port=%LORA_MANAGER_PORT% ^(match settings.json standalone_port; ComfyUI default is also 8188 - use another port if ComfyUI is running^)

REM If something already listens on this port, standalone will exit immediately and the browser will show ERR_CONNECTION_REFUSED.
netstat -an | findstr "LISTENING" | findstr ":%LORA_MANAGER_PORT%" >nul 2>&1
if not errorlevel 1 (
    echo [LoRA Manager] ERROR: port %LORA_MANAGER_PORT% is already in use. Stop ComfyUI/other app on this port, or run: "%~nx0" 8189
    pause
    exit /b 1
)

REM Resolve python.exe: Aki bundle ..\..\..\python, then PATH.
set "PYEXE="
if exist "%~dp0..\..\..\python\python.exe" set "PYEXE=%~dp0..\..\..\python\python.exe"
if not defined PYEXE set "PYEXE=python"

REM Open browser after delay (nested cmd/start quotes break easily; PowerShell is reliable here).
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%LORA_MANAGER_PORT%/loras'"

"%PYEXE%" "%~dp0standalone.py" --port %LORA_MANAGER_PORT%
endlocal
