@echo off
rem Fntv-Plus fpk 打包 GUI（优先 PowerShell 7.0，未安装则回退 5.1；脚本带 UTF-8 BOM 双版本兼容）。
rem 开发测试版与正式发布版都在同一个界面里选；产物输出到 <仓库根>\release。
chcp 65001 >nul
cd /d "%~dp0"
where pwsh >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\buildfpk\buildfpk-gui.ps1"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\buildfpk\buildfpk-gui.ps1"
)
