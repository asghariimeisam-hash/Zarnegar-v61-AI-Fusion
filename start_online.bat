@echo off
setlocal
if "%ZARNEGAR_ALLOW_NO_TOKEN%"=="" set ZARNEGAR_ALLOW_NO_TOKEN=1
if "%ZARNEGAR_PORT%"=="" set ZARNEGAR_PORT=8080
python zarnegar_online.py
pause
