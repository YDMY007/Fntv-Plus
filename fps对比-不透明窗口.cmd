@echo off
chcp 65001 >nul
title FPS 对比 - 不透明窗口(无透明合成)
set FNTV_NO_TRANSPARENT=1
echo.
echo  [FPS 对比 - 形态C] 不透明窗口（排除透明合成开销）
echo  ─────────────────────────────────────────────
echo  热键:  Ctrl+Alt+F = 开/关 FPS 悬浮表
echo         Ctrl+Alt+B = 关/开 玻璃滤镜
echo.
echo  [提示] 若 Fntv-Plus 已在运行, 请先完全退出再运行本脚本(单实例锁)。
echo         本形态窗口四角变直角、不再透出桌面, 属预期现象(诊断用)。
echo.
cd /d "%~dp0"
start "" "release\win-unpacked\Fntv-Plus.exe"
