@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ==========================================
echo   Fntv-Plus 统计/反馈服务端 - Cloudflare 部署
echo ==========================================
echo.
echo   本脚本会打开浏览器让你授权 Cloudflare，
echo   中途还会让你输入一次"看数据的口令"。
echo   其余步骤全自动。
echo.
echo   ⚠ 请在普通终端（cmd / PowerShell / Windows Terminal）里跑，
echo    不要在 AI 工具的嵌入式终端里跑。
echo.
pause

node deploy.mjs

echo.
echo 跑完了。按任意键关闭。
pause >nul
