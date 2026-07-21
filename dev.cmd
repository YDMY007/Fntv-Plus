@echo off
cd /d "%~dp0"
echo [1/2] Compiling TypeScript...
call npx tsc
if %errorlevel% neq 0 (
  echo Compile FAILED. Check errors above.
  pause
  exit /b %errorlevel%
)
echo [2/2] Starting Electron (F12 for DevTools)...
call npx electron .
