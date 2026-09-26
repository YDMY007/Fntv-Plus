@echo off
rem Fntv-Plus 开发测试版打包（v1.11 三段式+数字后缀）：版号 = <正式版基号>-<序号>，包名 Fntv-Plus-v<序号>.fpk（小写 v）。
rem 例：正式版基号 1.0.1 + 序号 224 → version=1.0.1-224 → Fntv-Plus-v224.fpk。
rem 飞牛商店审核要求版本号固定 3 段式 x.y.z（可带数字后缀 -n），4 段式无效。
rem ✓ 数字后缀（预发布号）语义化版本 < 正式版；下一正式版 1.0.2 不被挡；基号随发布 GUI 的版号前移。
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
