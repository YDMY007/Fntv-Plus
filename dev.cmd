@echo off
cd /d "%~dp0"
REM 强制杀掉残留的 Electron 主进程，避免单实例锁导致「改了 src 却还在跑旧代码」
REM （只关 PotPlayer 窗口不会杀主进程；不杀则新启动会被旧实例接管，弹幕/日志都不更新）
echo Killing any running Electron / packaged instance (avoid single-instance lock / stale code)...
REM 开发版进程名为 electron.exe；已安装的打包版进程名为 Fntv-Plus.exe，
REM 二者现在使用不同的 userData(见 config.ts)，不会再有单实例锁冲突，
REM 但杀掉它可保证 dev.cmd 启动的是「唯一的测试实例」，且不与安装版争抢 22346 代理端口。
taskkill /f /im electron.exe >nul 2>&1
taskkill /f /im Fntv-Plus.exe >nul 2>&1
REM 一并杀掉 proxy.exe 子进程：它作为 electron 的子进程可能未被 taskkill 连带终止，
REM 仍占用 22346 端口，导致新启动的（已含弹幕路由的）proxy.exe 绑定失败、旧代理继续服务。
taskkill /f /im proxy.exe >nul 2>&1
timeout /t 1 >nul
echo [1/3] Rebuilding potctl helper (reports PotPlayer window rect for danmaku overlay)...
call npm run build:potctl:win || echo [dev] potctl 重建跳过（不影响启动）
echo [2/3] Compiling TypeScript...
call npx tsc
if %errorlevel% neq 0 (
  echo Compile FAILED. Check errors above.
  pause
  exit /b %errorlevel%
)
echo [3/3] Starting Electron (F12 for DevTools)...
call npx electron .
