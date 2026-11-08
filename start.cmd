@echo off
cd /d "%~dp0"
set "HOME_CONTROL_NODE=node"
for /d %%D in ("%~dp0runtime\node-*") do set "HOME_CONTROL_NODE=%%D\node.exe"
"%HOME_CONTROL_NODE%" --version >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 or later is required. Install from https://nodejs.org/
  pause
  exit /b 1
)
start "" http://127.0.0.1:3210
"%HOME_CONTROL_NODE%" server.mjs
pause
