@echo off
rem Fntv-Plus 开发测试版打包（v1.6.3 四段式）：版号 = <正式版基号>.<git commit 数>，包名 Fntv-Plus-v<commit数>.fpk（小写 v）。
rem 例：正式版基号 1.0.0 + 195 个提交 → version=1.0.0.195 → Fntv-Plus-v195.fpk。
rem ✓ 大于已装正式版 1.0.0（可覆盖安装）；✓ 小于下一正式版 1.0.1（不挡正式版上架）；基号随发布 GUI 的版号前移。
rem 正式发布请用「发布打包.bat」（网页 GUI，大写 V 产物）。
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo  Fntv-Plus 开发版打包（版号=commit 数）
echo ==============================================
echo.
"%~dp0build-fpk.exe" build
echo.
pause
