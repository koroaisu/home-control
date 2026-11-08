@echo off
cd /d "%~dp0"
set "HOME_CONTROL_NODE=node"
for /d %%D in ("%~dp0runtime\node-*") do set "HOME_CONTROL_NODE=%%D\node.exe"
"%HOME_CONTROL_NODE%" install-plugin.mjs
pause
