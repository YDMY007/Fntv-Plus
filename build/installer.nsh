; build/installer.nsh — [lc-1055] 安装/卸载开场品牌闪屏动画
; ─────────────────────────────────────────────────────────────────────────────
; 用户要求：安装/更新/卸载不要干巴巴的，要有动画。NSIS 向导页本身是 Win32 对话框
;   做不了富动画，但 electron-builder 自带 NSIS 的 AdvSplash 插件可以：
;   安装器 .onInit 末尾(customInit)/卸载器 un.onInit 末尾(customUnInit) 弹出品牌闪屏，
;   淡入(350ms) → 停留(1s) → 淡出(350ms)，再进向导页 —— 全程约 1.7s。
; · 闪屏图 = scripts/gen-nsis-art.cjs 生成的 build/installerSplash.bmp /
;   uninstallerSplash.bmp（480×300 项目风格画稿）。
; · key color 0x00FF00：画稿里不存在纯绿 → 无透明化，仅作为约定的色键。
; · 静默安装(/S，应用内「立即更新」走的就是静默) 用 ${IfNot} ${Silent} 跳过闪屏，
;   不在无人值守场景弹窗。
; · NSIS 3 会自动为卸载器复制一份插件 DLL，customUnInit 里可直接调 AdvSplash。
; ─────────────────────────────────────────────────────────────────────────────

!macro customInit
  ${IfNot} ${Silent}
    InitPluginsDir
    File /oname=$PLUGINSDIR\fntv-splash.bmp "${BUILD_RESOURCES_DIR}\installerSplash.bmp"
    AdvSplash::show 1000 350 350 0x00FF00 "$PLUGINSDIR\fntv-splash.bmp"
    Pop $0 ; 丢弃返回(窗口句柄/耗时)
  ${EndIf}
!macroend

!macro customUnInit
  ${IfNot} ${Silent}
    InitPluginsDir
    File /oname=$PLUGINSDIR\fntv-un-splash.bmp "${BUILD_RESOURCES_DIR}\uninstallerSplash.bmp"
    AdvSplash::show 1000 350 350 0x00FF00 "$PLUGINSDIR\fntv-un-splash.bmp"
    Pop $0
  ${EndIf}
!macroend
