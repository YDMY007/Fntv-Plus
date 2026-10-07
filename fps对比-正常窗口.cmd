@echo off
chcp 65001 >nul
title FPS 对比 - 正常透明窗口(基线)
echo.
echo  [FPS 对比 - 形态A] 正常透明窗口（桌面版现状基线）
echo  ─────────────────────────────────────────────
echo  热键:  Ctrl+Alt+F = 开/关 FPS 悬浮表
echo         Ctrl+Alt+B = 关/开 玻璃滤镜
echo.
echo  [提示] 若 Fntv-Plus 已在运行, 请先完全退出再运行本脚本(单实例锁)。
echo         窗口右上角绿色数字就是 FPS, 「最差」是窗口内最卡的一帧耗时。
echo.
cd /d "%~dp0"
start "" "release\win-unpacked\Fntv-Plus.exe"
