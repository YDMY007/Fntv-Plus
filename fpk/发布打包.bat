@echo off
rem Fntv-Plus 正式发布打包（网页 GUI）：显示名与正式版号可控（飞牛商店真实显示），
rem 产物 Fntv-Plus-V<版号去点>.fpk（大写 V），版号完全由用户填写，不走开发版 commit 数。
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo  Fntv-Plus 正式发布打包 (http://127.0.0.1:8199)
echo ==============================================
echo.
"%~dp0build-fpk.exe" --serve
echo.
pause
