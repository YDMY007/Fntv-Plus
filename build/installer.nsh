; build/installer.nsh — v8: stub 启动器 + 自绘 UI 进程(WPF+WebView2) + EB 原生静默安装
; ─────────────────────────────────────────────────────────────────────────────
; 【架构】抖音/B站式双进程配方, NSIS 只当打包内核:
;   ▍交互安装: 用户双击安装包(非静默) → customInit 解压 UI 三件套(FntvSetupUi.exe +
;     WebView2 运行时组件 + www.zip 页面) → 启动 UI 进程 → 本进程 Quit(一个页面都不建)。
;     UI 进程用 HTML/CSS 绘制全部界面(真毛玻璃/动画/任意 DPI 原生文字), 选定模式与路径后
;     以 /S 静默参数重新拉起本安装器本体 → 走 electron-builder 原生安装链路
;     (electron-updater / 卸载器 / 注册表 / 多用户 全部零改动)。
;   ▍静默启动(/S): electron-updater 自动更新、命令行部署 → 不拉 UI, 原生静默安装。
; 【进度协议】UI 以 /_IPC=<dir> 传 IPC 目录(带引号, 兼容带空格 TEMP 路径), 本进程在
;   钩子写 started.flag / extract.flag / done.flag; 百分比由 UI 轮询 INSTDIR 字节数、
;   以 www 内 totalsize.txt 为分母换算 —— EB 缓存的 NSIS 3.04.1 无日志支持(/LOG 实测
;   无输出), 故不走日志尾随。
; 【页面】旧「液态玻璃」自绘 NSIS 向导(874 行热区/换片 hack)整体退役, 其视觉由
;   scripts/setup-ui/www/ 的 HTML 页面继承; 卸载器保留原生页 + uninstallerSidebar
;   品牌图 + AdvSplash 闪屏(单套位图 1:1, 见 gen-nsis-art.cjs)。
; ⚠ 本文件必须带 UTF-8 BOM(否则中文注释按 ANSI 读编译失败)。
; ─────────────────────────────────────────────────────────────────────────────
!include LogicLib.nsh
!include FileFunc.nsh

; ── 安装器图标 ──
; ⚠ 必须先于 MUI2.nsh 定义(其内部有 !ifndef 兜底 NSIS 老图标并据此发 Icon 指令);
;   本文件在 EB 生成的脚本里先于 common.nsh / MUI2.nsh 被 include。
!ifndef MUI_ICON
  !define MUI_ICON "${BUILD_RESOURCES_DIR}\icon.ico"
!endif
!ifndef MUI_UNICON
  !define MUI_UNICON "${BUILD_RESOURCES_DIR}\icon.ico"
!endif

ManifestDPIAware true

Var ipcDir   ; UI 进程传来的 IPC 目录(/_IPC=); electron-updater 静默更新时为空

; ── 交互安装: 解压 UI 三件套并移交, 本进程立即退出 ──
!macro customInit
  ${GetOptions} $CMDLINE "/_IPC=" $ipcDir
  ${IfNot} ${Silent}
    InitPluginsDir
    File /oname=$PLUGINSDIR\FntvSetupUi.exe "${BUILD_RESOURCES_DIR}\setup-ui\FntvSetupUi.exe"
    File /oname=$PLUGINSDIR\WebView2Loader.dll "${BUILD_RESOURCES_DIR}\setup-ui\WebView2Loader.dll"
    File /oname=$PLUGINSDIR\Microsoft.Web.WebView2.Core.dll "${BUILD_RESOURCES_DIR}\setup-ui\Microsoft.Web.WebView2.Core.dll"
    File /oname=$PLUGINSDIR\Microsoft.Web.WebView2.Wpf.dll "${BUILD_RESOURCES_DIR}\setup-ui\Microsoft.Web.WebView2.Wpf.dll"
    File /oname=$PLUGINSDIR\icon.ico "${BUILD_RESOURCES_DIR}\setup-ui\icon.ico"
    File /oname=$PLUGINSDIR\ui.zip "${BUILD_RESOURCES_DIR}\setup-ui\www.zip"
    File /oname=$PLUGINSDIR\app-meta.json "${BUILD_RESOURCES_DIR}\setup-ui\app-meta.json"
    File /oname=$PLUGINSDIR\totalsize.txt "${BUILD_RESOURCES_DIR}\setup-ui\totalsize.txt"
    Exec '"$PLUGINSDIR\FntvSetupUi.exe" --setup "$EXEPATH" --www "$PLUGINSDIR"'
    Quit
  ${EndIf}
  ; 静默遍(被 UI 以 /S 拉起): 记 started 标记(UI 据此把阶段切到解压前)
  ${If} $ipcDir != ""
    FileOpen $0 "$ipcDir\started.flag" w
    FileClose $0
  ${EndIf}
!macroend

; ── 静默安装段内钩子: 应用包开始解压 / 安装收尾标记(UI 换阶段、判成功) ──
!macro fnosIpcFlag NAME
  ${If} $ipcDir != ""
    FileOpen $0 "$ipcDir\${NAME}" w
    FileClose $0
  ${EndIf}
!macroend

!macro customFiles_x64
  !insertmacro fnosIpcFlag "extract.flag"
!macroend
!macro customFiles_arm64
  !insertmacro fnosIpcFlag "extract.flag"
!macroend
!macro customFiles_ia32
  !insertmacro fnosIpcFlag "extract.flag"
!macroend

!macro customInstall
  !insertmacro fnosIpcFlag "done.flag"
!macroend

; ── 卸载器: 原生页 + 品牌侧栏(EB nsis.uninstallerSidebar) + AdvSplash 闪屏 ──
!macro customUnInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\fntv-un-splash.bmp "${BUILD_RESOURCES_DIR}\uninstallerSplash.bmp"
  ${IfNot} ${Silent}
    AdvSplash::show 1000 350 350 0x00FF00 "$PLUGINSDIR\fntv-un-splash.bmp"
    Pop $0
  ${EndIf}
!macroend
