@echo off
REM 端口：优先改 settings.json 里的 standalone_port（IDE 直接运行 standalone.py 也会读）
REM 本 bat 内变量与 settings 请保持一致
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "LORA_MANAGER_PORT=8189"
set "LORA_MANAGER_STANDALONE_PORT=!LORA_MANAGER_PORT!"

echo [LoRA Manager] 使用端口 !LORA_MANAGER_PORT! ^(settings.json 中 standalone_port 应与此一致^)
start "" "http://127.0.0.1:!LORA_MANAGER_PORT!/loras"

"D:\ComfyUI-aki-v2\python\python.exe" "D:\ComfyUI-aki-v2\ComfyUI\custom_nodes\ComfyUI-Lora-Manager\standalone.py" --port !LORA_MANAGER_PORT!
endlocal
