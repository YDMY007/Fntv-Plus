@echo off
rem Fntv-Plus fpk 打包 GUI（PowerShell WinForms 界面，替代旧版网页 GUI）。
rem 开发测试版与正式发布版都在同一个界面里选；产物输出到 <仓库根>\release。
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\buildfpk-gui.ps1"
