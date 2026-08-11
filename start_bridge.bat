@echo off
setlocal
if "%ZARNEGAR_TOKEN%"=="" (
  set /p ZARNEGAR_TOKEN=Enter a long private bridge token: 
)
if "%ZARNEGAR_PORT%"=="" set ZARNEGAR_PORT=8765
python mt5_bridge.py
pause
