; build/installer.nsh — 清晰字体版 + 自绘整页向导(PLAN-B 落地)
; ⚠ 本文件必须带 UTF-8 BOM(否则中文注释按 ANSI 读编译失败)。
; ─────────────────────────────────────────────────────────────────────────────
; 【字体】字体糊根因: NSIS 默认 UI 字体 = MS Shell Dlg(中文落宋体), ①宋体无粗体
;   字形, MUI2 页眉标题的「合成粗体」= 位图拉伸必糊; ②系统关闭字体平滑时出锯齿。
;   方案: GUIInit 用 CreateFontIndirectW 创建「Microsoft YaHei UI + CLEARTYPE」:
;   ① 字号对齐 NSIS 资源版式(8pt): lfHeight = -round(8*dpi/72), 不撑破控件。
;   ② lfQuality = CLEARTYPE_QUALITY: 不依赖系统字体平滑设置。
;   ③ 页眉标题(ID 1037)单独推雅黑真粗体, 替代 MUI2 的合成粗体。
;   ④ 跳过 ID 1252(BrandingText), 保持原生小字灰条(推大字会被控件矩形截断)。
;   ⑤ 按钮在 ID 1/2/3(不在 1000-1499), 一并覆盖。
;   正文控件(nsDialogs 页面显示时才创建)维持默认字体(默认字号下位图字体清晰)。
;   注意: MUI2 自行生成 Function .onGUIInit(回调 MUI_CUSTOMFUNCTION_GUIINIT),
;   自定义同名函数会撞名编译失败, 必须走回调; 本回调在 MUI2 设完页眉字体后执行。
; ─────────────────────────────────────────────────────────────────────────────
; 【自绘整页向导】全部四页统一「液态玻璃」画稿(gen-nsis-art.cjs 的 1560×1040 2x 位图,
;   逻辑 780×520 比例 3:2):
;   ▍欢迎页/完成页(自绘页): 满铺画稿 + 玻璃药丸即按钮(点击靠同位置叠 SS_NOTIFY
;   热区, 药丸区域在 ArtClick 处理器内按位图比例命中), 原生向导按钮隐藏。
;   ▍[v5] 安装选项页/安装进度页(原生页): 同一画稿语言满铺 ——
;   ① fnosNativeArtShow: 页面 dialog 铺满客户区(盖住页眉区), chrome 隐藏走
;      muiPageLoadFullWindow(与画稿页同一状态), 满铺位图垫到 Z 底;
;   ② 单选钮退场(隐藏, 仅作选中状态载体), 选择卡=画稿玻璃卡 + SS_NOTIFY 热区
;      整卡代理点击(BM_CLICK 隐藏单选钮 → EB InstModeChange 原链路照常), 卡上
;      圆圈选中态由画稿双态裁片(installerModeCardsA/B)贴片呈现;
;   ③ 安装选项页按钮: 本体隐藏, 玻璃药丸 = 画稿 + nsDialogs 热区转发 BM_CLICK
;      (实测结论: 原生按钮改样式/挪位会被 NSIS 复位; 外来控件发 WM_COMMAND 两条
;      挂法 NSIS 均不认; 唯 nsDialogs 自建控件的 OnClick 链路可靠, 勿回退);
;   ④ 进度页(非 nsDialogs, 无可靠脚本点击通道): 取消/下一步用本体按钮自绘隐形,
;      挪进画稿药丸槽位(本体挪位实测不复位); 明细列表置入烘焙玻璃面板(去 sunken
;      边框); customInstall(EB 段尾钩子)时标题条/按钮区换「安装完成」贴片。
;   ⑤ 窗口几何: 首次进欢迎页把页面区调成 780:520(DPI 无关比例), 向导窗口随动
;      并回中; 之后原生页沿用新窗口尺寸。
; ─────────────────────────────────────────────────────────────────────────────

!include LogicLib.nsh
!include WinMessages.nsh
!include nsDialogs.nsh
; 仅安装器遍(安装位置页用); 卸载器遍引入会成为孤儿函数/变量, EB 视警告为错误
!ifndef BUILD_UNINSTALLER
  !include StrContains.nsh
!endif

; DPI 感知: NSIS 进程默认 DPI 未感知, 高缩放屏(125%/150%)被系统位图拉伸渲染,
; 字体/UI 全体发糊(「字体还是发糊」的最底层根因)。声明后按物理像素原生渲染,
; 下面的 DPI 缩放逻辑(GetDpiForWindow)也才能拿到真实缩放系数。
ManifestDPIAware true

Var fnosFont        ; 常规: Microsoft YaHei UI 400, 8pt@DPI
Var fnosFontBold    ; 粗体: 同上 700(页眉标题用)
; 自绘整页向导专用: 卸载器编译遍(BUILD_UNINSTALLER)不展开页面宏,
; 这些变量在那边「从未被引用」, NSIS 警告被 electron-builder 当错误, 故条件声明。
!ifndef BUILD_UNINSTALLER
  Var fnosPW          ; 自绘页宽(像素, = round(780*dpi/96))
  Var fnosPH          ; 自绘页高(像素, = round(520*dpi/96))
  Var fnosSized       ; 窗口几何已按画稿比例调过的标志
  Var fnosWelcomeBmp  ; 欢迎页满铺位图句柄(Show 返回后 NSD_FreeImage)
  Var fnosFinishBmp   ; 完成页满铺位图句柄
  Var fnosFontPage    ; 原生页控件字体(10pt 常规)
  Var fnosWelcomeBmpCtl ; 欢迎页位图控件(ArtClick 命中测试用)
  Var fnosFinishBmpCtl  ; 完成页位图控件
  Var fnosRunArgs     ; 完成页启动参数(--updated); 不能复用 $startAppArgs,
                      ; 它由 installSection.nsh 在本宏之后才 Var 声明(单遍编译)
  Var fnosModeSel       ; 安装选项页当前选中(1=所有用户, 0=仅为我)
  Var fnosModeCardsCtl  ; 选择卡双态贴片控件
  Var fnosDirEdit       ; 安装选项页「安装到」路径输入框
  Var fnosInstDone      ; 进度页安装已完成标志
  Var fnosInstTitleCtl  ; 进度页标题条贴片控件(空图透明, 完成时换片)
  Var fnosInstBarCtl    ; 进度页按钮区条带贴片控件(取消→下一步换片)
!endif

; ── [v3] 淡蓝液态玻璃主题 token(与画稿同源; SetCtlColors 用 RRGGBB 无前缀格式) ──
!define FNOS_BG     "eef4fe"   ; 标题栏/页眉/品牌条: 淡蓝
!define FNOS_BG2    "f3f7fe"   ; 页面底: 更浅一层
!define FNOS_TEXT   "1b2540"   ; 主文字: 深藏青(浅底上对比度最高)
!define FNOS_SUB    "44506b"   ; 次文字
!define FNOS_MUTED  "8b96ad"   ; 弱文字
!define FNOS_ACCENT "3d6df5"   ; 进度条靛蓝

; ── [v5] 进度页钩子注入: 本宏在多用户页(含其内嵌的安装位置区)之后、进度页之前展开,
; 此处定义的 MUI_PAGE_CUSTOMFUNCTION_SHOW 恰好被 MUI_PAGE_INSTFILES 消费(其 SHOW
; 回调里控件句柄已就绪)。函数体 fnosInstFilesShow 定义在 customFinishPage 宏内
; (编译顺序在 $mui.InstFiles* 变量声明之后, 提前引用会报 unknown variable)。
; 注意: 不要在这里定义 MUI_PAGE_CUSTOMFUNCTION_PRE —— PRE 时进度页控件尚未创建。
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW fnosInstFilesShow
!macroend

; ── 创建字体(微软雅黑 UI, CLEARTYPE, 高度随 DPI) ──
!macro fnosMakeFont PT WEIGHT DEST
  StrCpy $0 96
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.r0'
  ${If} $0 < 96
    StrCpy $0 96
  ${EndIf}
  IntOp $1 $0 * ${PT}   ; pt → 像素 em 高, +36 实现四舍五入
  IntOp $1 $1 + 36
  IntOp $1 $1 / 72
  IntOp $1 $1 * -1      ; 负值 = em 高度
  System::Call '*(i r1, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 0, i 0, i 0, i 5, i 0, t "Microsoft YaHei UI") p.r9'
  System::Call 'gdi32::CreateFontIndirectW(pr9) p.r1'
  StrCpy ${DEST} $1
  System::Free $9
!macroend

; ── 自定义 Init: 画稿预载 + 闪屏 ──
!macro customInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\fntv-splash.bmp      "${BUILD_RESOURCES_DIR}\installerSplash.bmp"
  File /oname=$PLUGINSDIR\fnos-welcome.bmp     "${BUILD_RESOURCES_DIR}\installerWelcome.bmp"
  File /oname=$PLUGINSDIR\fnos-welcome-cta.bmp "${BUILD_RESOURCES_DIR}\installerWelcomeCta.bmp"
  File /oname=$PLUGINSDIR\fnos-finish.bmp      "${BUILD_RESOURCES_DIR}\installerFinish.bmp"
  File /oname=$PLUGINSDIR\fnos-finish-p1.bmp   "${BUILD_RESOURCES_DIR}\installerFinishPrimary.bmp"
  File /oname=$PLUGINSDIR\fnos-finish-p2.bmp   "${BUILD_RESOURCES_DIR}\installerFinishSecondary.bmp"
  File /oname=$PLUGINSDIR\fnos-mode.bmp        "${BUILD_RESOURCES_DIR}\installerMode.bmp"
  File /oname=$PLUGINSDIR\fnos-mode-a.bmp      "${BUILD_RESOURCES_DIR}\installerModeCardsA.bmp"
  File /oname=$PLUGINSDIR\fnos-mode-b.bmp      "${BUILD_RESOURCES_DIR}\installerModeCardsB.bmp"
  File /oname=$PLUGINSDIR\fnos-inst.bmp        "${BUILD_RESOURCES_DIR}\installerInst.bmp"
  File /oname=$PLUGINSDIR\fnos-inst-done.bmp   "${BUILD_RESOURCES_DIR}\installerInstDoneTitle.bmp"
  File /oname=$PLUGINSDIR\fnos-inst-bar.bmp      "${BUILD_RESOURCES_DIR}\installerInstBar.bmp"
  File /oname=$PLUGINSDIR\fnos-inst-bar-done.bmp "${BUILD_RESOURCES_DIR}\installerInstBarDone.bmp"
  ${IfNot} ${Silent}
    AdvSplash::show 1000 350 350 0x00FF00 "$PLUGINSDIR\fntv-splash.bmp"
    Pop $0
  ${EndIf}
!macroend

!macro customUnInit
  InitPluginsDir
  File /oname=$PLUGINSDIR\fntv-un-splash.bmp "${BUILD_RESOURCES_DIR}\uninstallerSplash.bmp"
  ${IfNot} ${Silent}
    AdvSplash::show 1000 350 350 0x00FF00 "$PLUGINSDIR\fntv-un-splash.bmp"
    Pop $0
  ${EndIf}
!macroend

; ── 字体清晰化: 见文件头【字体】说明 ──
!define MUI_CUSTOMFUNCTION_GUIINIT fnosOnInitGUI
Function fnosOnInitGUI
  !insertmacro fnosMakeFont 8 400 $fnosFont
  !insertmacro fnosMakeFont 8 700 $fnosFontBold
  ; ID 1 起步: 覆盖按钮(1=下一步/安装, 2=取消, 3=上一步) + MUI2 chrome(1000-1499)
  ; (不存在的 ID GetDlgItem 返回 0, SendMessage 安全跳过)
  StrCpy $R9 1
  ${While} $R9 <= 1499
    ${If} $R9 != 1252
      GetDlgItem $R8 $HWNDPARENT $R9
      ${If} $R8 != 0
        ${If} $R9 == 1037        ; 页眉标题 → 雅黑真粗体
          SendMessage $R8 0x0030 $fnosFontBold 1   ; WM_SETFONT, fRedraw=TRUE
        ${Else}
          SendMessage $R8 0x0030 $fnosFont 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
    IntOp $R9 $R9 + 1
  ${EndWhile}
  ; 自绘整页几何: 780×520 逻辑(画稿比例) → 本机像素(仅安装器遍, 变量条件声明)
  !ifndef BUILD_UNINSTALLER
    StrCpy $fnosSized 0
    !insertmacro fnosMakeFont 10 400 $fnosFontPage        ; 原生页(多用户/进度)控件字体
    System::Call 'user32::GetDpiForWindow(p $HWNDPARENT) i.r0'
    ${If} $0 < 96
      StrCpy $0 96
    ${EndIf}
    IntOp $1 $0 * 780
    IntOp $1 $1 + 48
    IntOp $1 $1 / 96
    StrCpy $fnosPW $1
    IntOp $1 $0 * 520
    IntOp $1 $1 + 48
    IntOp $1 $1 / 96
    StrCpy $fnosPH $1
  !endif
  ; ── [v3] DWM 标题栏染色: 白条 → 画稿淡蓝(Win11 22000+; 低版本调用失败维持原生) ──
  ; COLORREF = 0x00BBGGRR: #eef4fe → 0xfef4ee, 深藏青文字 #1b2540 → 0x40251b
  System::Call '*(i 0xfef4ee) p.r9'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, p r9, i 4)'   ; DWMWA_CAPTION_COLOR
  System::Free $9
  System::Call '*(i 0x40251b) p.r9'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, p r9, i 4)'   ; DWMWA_TEXT_COLOR
  System::Free $9
  System::Call '*(i 0xf4e1d5) p.r9'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 34, p r9, i 4)'   ; DWMWA_BORDER_COLOR #d5e1f4
  System::Free $9
  ; ── [v3] 向导 chrome 深色化(页眉/分隔线/品牌条; 页面由画稿覆盖) ──
  SetCtlColors $HWNDPARENT "" ${FNOS_BG}                 ; 主对话框底(按钮条区域)
  GetDlgItem $1 $HWNDPARENT 1034                         ; 页眉底色
  ${If} $1 != 0
    SetCtlColors $1 "" ${FNOS_BG}
  ${EndIf}
  GetDlgItem $1 $HWNDPARENT 1037                         ; 页眉标题
  ${If} $1 != 0
    SetCtlColors $1 ${FNOS_TEXT} ${FNOS_BG}              ; 不透明底: 换文字时才会擦旧字(transparent 会叠影)
  ${EndIf}
  GetDlgItem $1 $HWNDPARENT 1038                         ; 页眉副标题
  ${If} $1 != 0
    SetCtlColors $1 ${FNOS_SUB} ${FNOS_BG}
  ${EndIf}
  ; 分隔线 1035/1036/1045 是 SS_ETCHEDHORZ 蚀刻线, 不吃 SetCtlColors, 深色主题下直接隐藏
  GetDlgItem $1 $HWNDPARENT 1035
  ${If} $1 != 0
    ShowWindow $1 ${SW_HIDE}
  ${EndIf}
  GetDlgItem $1 $HWNDPARENT 1036
  ${If} $1 != 0
    ShowWindow $1 ${SW_HIDE}
  ${EndIf}
  GetDlgItem $1 $HWNDPARENT 1045
  ${If} $1 != 0
    ShowWindow $1 ${SW_HIDE}
  ${EndIf}
  GetDlgItem $1 $HWNDPARENT 1028                         ; 品牌条底
  ${If} $1 != 0
    SetCtlColors $1 "" ${FNOS_BG}
  ${EndIf}
  GetDlgItem $1 $HWNDPARENT 1256                         ; 品牌文字
  ${If} $1 != 0
    SetCtlColors $1 ${FNOS_MUTED} ${FNOS_BG}
  ${EndIf}
FunctionEnd

; ── 自绘页窗口几何: 页面区调成 780:520(仅窗口一次), 页面 dialog 每次摆正 ──
; 用法: !insertmacro fnosFitWindow <dlg hwnd>; 内部占用 $1-$9/$R3-$R9。
!macro fnosFitWindow DLG
  System::Call 'user32::GetClientRect(p $HWNDPARENT, @r9)'
  System::Call '*$9(i, i, i.r1, i.r2)'                ; $1=客户区宽 $2=高
  System::Call 'user32::GetWindowRect(p $HWNDPARENT, @r9)'
  System::Call '*$9(i.r3, i.r4, i.r5, i.r6)'          ; $3=x $4=y
  IntOp $5 $5 - $3                                    ; 窗口宽
  IntOp $6 $6 - $4                                    ; 窗口高
  System::Call 'user32::GetWindowRect(p ${DLG}, @r9)'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r9, i 2)'
  System::Call '*$9(i.R3, i.R4, i.R5)'                ; R3=左 R4=顶 R5=右(客户坐标)
  IntOp $R5 $R5 - $R3                                 ; 页面区当前宽
  ${If} $fnosSized == 0
    IntOp $8 $fnosPW - $R5                            ; 客户区宽增量
    IntOp $9 $R4 + $fnosPH
    IntOp $9 $9 - $2                                  ; 客户区高增量 = 顶距 + 画稿高 - 客户区高
    IntOp $5 $5 + $8
    IntOp $6 $6 + $9
    IntOp $8 $8 / 2
    IntOp $3 $3 - $8                                  ; 回中
    IntOp $9 $9 / 2
    IntOp $4 $4 - $9
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i $3, i $4, i $5, i $6, i 0x14)'
    StrCpy $fnosSized 1
  ${EndIf}
  System::Call 'user32::SetWindowPos(p ${DLG}, p 0, i $R3, i $R4, i $fnosPW, i $fnosPH, i 0x14)'
!macroend

; ══════ [v5] 原生页画稿化公共设施(安装选项页/安装进度页共用) ══════

; ── 画稿逻辑坐标(780×520 空间) → 页面像素: $3=x $4=y $5=w $6=h(覆写 $3-$6) ──
!macro fnosArtRect L T W H
  IntOp $3 $fnosPW * ${L}
  IntOp $3 $3 / 780
  IntOp $4 $fnosPH * ${T}
  IntOp $4 $4 / 520
  IntOp $5 $fnosPW * ${W}
  IntOp $5 $5 / 780
  IntOp $6 $fnosPH * ${H}
  IntOp $6 $6 / 520
!macroend

; ── 本体按钮药丸化: BS_OWNERDRAW 无人应答 = 隐形(画稿药丸透出), 挪到画稿槽位。
; 仅用于非 nsDialogs 原生页(进度页/安装位置页) —— 本体按钮 WM_COMMAND NSIS 必认;
; nsDialogs 页(安装选项/欢迎)一律用 fnosHot 热区链路。挪位在进度/位置页实测不复位。
; 入参 HWND L T W H; 覆写 $1-$6; 可见性由调用方 SW_SHOW 控制(隐藏控件不参与命中)。──
!macro fnosSkinButton HWND L T W H
  System::Call 'user32::GetWindowLongW(p ${HWND}, i -16) i.r1'
  IntOp $1 $1 & 0xFFFFFFF0                                              ; 清 BS_TYPEMASK
  IntOp $1 $1 | 0x0000000B                                              ; BS_OWNERDRAW
  System::Call 'user32::SetWindowLongW(p ${HWND}, i -16, i r1)'
  !insertmacro fnosArtRect ${L} ${T} ${W} ${H}
  System::Call 'user32::SetWindowPos(p ${HWND}, p 0, i $3, i $4, i $5, i $6, i 0x14)'
!macroend

; ── 拉伸换片: 往 $R7(STATIC)载入 $R8 位图并替换(旧句柄 DeleteObject)。覆写 $0-$3。
; 调用方全部在安装器遍的页面函数/回调内, 卸载器遍条件编译(孤儿函数警告=EB 错误)。 ──
!ifndef BUILD_UNINSTALLER
Function fnosSwapBmp
  System::Call 'user32::GetClientRect(p $R7, @r9)'
  System::Call '*$9(i, i, i.r0, i.r1)'
  System::Call 'user32::LoadImage(p 0, t "$R8", i 0, i $0, i $1, i 0x10) p.r2'   ; LR_LOADFROMFILE, 按客户区拉伸
  System::Call 'user32::SendMessageW(p $R7, i 0x0172, i 0, p r2) p.r3'           ; STM_SETIMAGE → 旧句柄
  ${If} $3 P<> 0
    System::Call 'gdi32::DeleteObject(p r3)'
  ${EndIf}
FunctionEnd
!endif

; ── 原生页画稿化: 页面 dialog(最近创建的 #32770 子窗口)铺满客户区(盖住页眉区),
; chrome 隐藏走 muiPageLoadFullWindow(与画稿页同一状态), 满铺位图垫到 Z 底。
; 入参 $R8 = 位图文件; 出参 $R5 = 页面 dialog, $R7 = 位图控件。覆写 $0-$9/$R6-$R9。
; 仅安装器遍: muiPageLoadFullWindow 由欢迎页宏(MUI_PAGE_FUNCTION_FULLWINDOW)定义,
; 卸载器遍不存在该函数, 整个函数条件编译。 ──
!ifndef BUILD_UNINSTALLER
Function fnosNativeArtShow
  LockWindow on
  FindWindow $0 "#32770" "" $HWNDPARENT
  StrCpy $R5 $0
  SetCtlColors $0 "" f8fbff                ; 画稿底色兜边缘 1px 缝隙
  System::Call 'user32::GetClientRect(p $HWNDPARENT, @r9)'
  System::Call '*$9(i, i, i.r1, i.r2)'
  System::Call 'user32::SetWindowPos(p $0, p 0, i 0, i 0, i $1, i $2, i 0x14)'
  ; 满铺位图垫底(SS_BITMAP STATIC → HWND_BOTTOM, 原生控件全部浮在其上)
  System::Call 'kernel32::GetModuleHandle(p 0) p.r3'
  System::Call 'user32::CreateWindowEx(i 0, w "STATIC", w "", i 0x5000000E, i 0, i 0, i $1, i $2, p $0, p 0x2203, p r3, p 0) p.r7'
  StrCpy $R7 $7
  System::Call 'user32::GetClientRect(p $R7, @r9)'
  System::Call '*$9(i, i, i.r1, i.r2)'
  System::Call 'user32::LoadImage(p 0, t "$R8", i 0, i $1, i $2, i 0x10) p.r8'
  System::Call 'user32::SendMessageW(p $R7, i 0x0172, i 0, p r8)'                ; STM_SETIMAGE
  System::Call 'user32::SetWindowPos(p $R7, p 1, i 0, i 0, i 0, i 0, i 0x13)'    ; HWND_BOTTOM
  Call muiPageLoadFullWindow               ; 页眉文字/页眉图/品牌条隐藏 = 画稿页同款
  LockWindow off
FunctionEnd
!endif

; ── 画稿药丸点击热区: 原生 SS_NOTIFY 静态热区。不要用 nsDialogs label 叠加 ——
; label 自带 WS_EX_TRANSPARENT 扩展样式, 真实鼠标点击会穿透到下层位图(点击无反应);
; 本热区无该扩展样式, 真实点击必命中。坐标 = 画稿逻辑坐标(= CSS/2, 位图 780×520 逻辑),
; 运行时按 fnosPW/PH 比例换算像素。用法: !insertmacro fnosHot <dlg句柄> L T W H <回调> ──
; ── 画稿点击热区: nsDialogs 自建控件(经 nsDialogs 子类化, 点击必达)。
; 仅限 nsDialogs 页面(安装选项页)使用; 进度页非 nsDialogs, 用原生按钮本体。──
!macro fnosHot L T W H FUNC
  !insertmacro fnosArtRect ${L} ${T} ${W} ${H}
  ${NSD_CreateLabel} $3 $4 $5 $6 ""
  Pop $1
  SetCtlColors $1 "" transparent
  ${NSD_OnClick} $1 ${FUNC}
!macroend

; ══════ 自绘欢迎页 ══════
!macro customWelcomePage
  !insertmacro MUI_PAGE_INIT
  !insertmacro MUI_PAGE_FUNCTION_FULLWINDOW
  PageEx custom
    PageCallbacks fnosWelcomePre fnosWelcomeLeave
    Caption " "
  PageExEnd

  Function fnosWelcomePre
    LockWindow on
    nsDialogs::Create 1044
    Pop $0
    SetCtlColors $0 "" f8fbff                ; 边缘 1px 缝隙用画稿底色兜底(RRGGBB)
    !insertmacro fnosFitWindow $0
    ${NSD_CreateBitmap} 0 0 $fnosPW $fnosPH ""
    Pop $fnosWelcomeBmpCtl
    ${NSD_SetStretchedImage} $fnosWelcomeBmpCtl "$PLUGINSDIR\fnos-welcome.bmp" $fnosWelcomeBmp
    ${NSD_OnClick} $fnosWelcomeBmpCtl fnosWelcomeArtClick   ; 位图带 SS_NOTIFY, 真实点击必达; 处理器按药丸区域分发
    Call muiPageLoadFullWindow
    ; 药丸即主按钮, 隐藏原生向导按钮(✕/Esc 仍可退出)
    GetDlgItem $1 $HWNDPARENT 1
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $HWNDPARENT 2
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $HWNDPARENT 3
    ShowWindow $1 ${SW_HIDE}
    LockWindow off
    nsDialogs::Show
    ${NSD_FreeImage} $fnosWelcomeBmp
    Call muiPageUnloadFullWindow
  FunctionEnd

  Function fnosWelcomeArtClick
    ; 光标(=点击点) → 位图客户坐标, 命中「开始安装」药丸区域(逻辑 500,422,220,48 / 780×520)才前进
    System::Call 'user32::GetCursorPos(@r9)'
    System::Call 'user32::ScreenToClient(p $fnosWelcomeBmpCtl, p r9)'
    System::Call '*$9(i.r1, i.r2)'
    IntOp $3 $fnosPW * 500
    IntOp $3 $3 / 780
    IntOp $4 $fnosPH * 422
    IntOp $4 $4 / 520
    IntOp $5 $fnosPW * 220
    IntOp $5 $5 / 780
    IntOp $6 $fnosPH * 48
    IntOp $6 $6 / 520
    IntOp $7 $3 + $5
    IntOp $8 $4 + $6
    ${If} $1 >= $3
    ${AndIf} $1 <= $7
    ${AndIf} $2 >= $4
    ${AndIf} $2 <= $8
      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 0x00F5 0 0              ; BM_CLICK → 下一步
    ${EndIf}
  FunctionEnd

  Function fnosWelcomeLeave
    ; 按钮本体保持隐藏(欢迎页 Pre 已藏), 后续页用画稿药丸 + NSIS 按钮代理
  FunctionEnd

  ; ── [v5] 安装选项页画稿化: 本宏(欢迎页)比 PAGE_INSTALL_MODE 先编译, 在此定义的
  ; MUI_PAGE_CUSTOMFUNCTION_SHOW 恰好被下一个页面(多用户页)消费(MUI_PAGE_FUNCTION_CUSTOM
  ; SHOW 在其控件创建之后、显示之前调用, 一次性 undef)。
  ; 函数体不能放这里: $MultiUser.* 变量由 PAGE_INSTALL_MODE 声明(晚于本宏编译),
  ; 提前引用会报 unknown variable(warning 当错误), 故挪到 customFinishPage 里定义。
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW fnosInstModeShow
!macroend

; ══════ 自绘完成页 ══════
!macro customFinishPage
  !insertmacro MUI_PAGE_INIT
  !insertmacro MUI_PAGE_FUNCTION_FULLWINDOW
  PageEx custom
    PageCallbacks fnosFinishPre fnosFinishLeave
    Caption " "
  PageExEnd

  ; ── [v5] 安装选项页画稿化: 页面 dialog 铺满客户区 + 满铺画稿垫底; 原生说明文字与
  ; 单选钮退场(选择卡=画稿玻璃卡, 热区整卡代理点击隐藏单选钮, EB InstModeChange
  ; 原链路照常更新说明文字/UAC 盾牌), 选中态用画稿双态贴片呈现; 向导按钮铺成
  ; 玻璃药丸隐形皮肤。仅安装器遍会到达此页(卸载器遍未挂 SHOW 钩子)。 ──
  Function fnosInstModeShow
    StrCpy $R8 "$PLUGINSDIR\fnos-mode.bmp"
    Call fnosNativeArtShow                              ; $R5 = 页面 dialog
    ; 原生控件退场: 说明文字与单选钮隐藏(单选钮仅作选中状态载体, 热区代点)
    ShowWindow $MultiUser.InstallModePage.Text ${SW_HIDE}
    ShowWindow $MultiUser.InstallModePage.AllUsers ${SW_HIDE}
    ShowWindow $MultiUser.InstallModePage.CurrentUser ${SW_HIDE}
    ; 动态说明标签坐进右上卡信息底 infoplate(60,312,580,66)@2x; 卡原点(410,145)
    !insertmacro fnosArtRect 440 302 290 33
    System::Call 'user32::SetWindowPos(p $RadioButtonLabel1, p 0, i $3, i $4, i $5, i $6, i 0x14)'
    SetCtlColors $RadioButtonLabel1 ${FNOS_SUB} ${FNOS_BG2}
    SendMessage $RadioButtonLabel1 0x0030 $fnosFontPage 1
    ; 选择卡双态贴片(初态跟随 EB Pre 的默认点选)
    !insertmacro fnosArtRect 40 140 362 215
    System::Call 'kernel32::GetModuleHandle(p 0) p.r7'
    System::Call 'user32::CreateWindowEx(i 0, w "STATIC", w "", i 0x5000000E, i $3, i $4, i $5, i $6, p $R5, p 0x2204, p r7, p 0) p.r1'
    StrCpy $fnosModeCardsCtl $1
    SetCtlColors $1 "" transparent
    SendMessage $MultiUser.InstallModePage.AllUsers 0x00F2 0 0 $fnosModeSel    ; BM_GETCHECK
    ${If} $fnosModeSel != 1
      StrCpy $fnosModeSel 0
    ${EndIf}
    Call fnosModeSwapCards
    ; 卡片点击热区(SS_NOTIFY, 置顶): 整张卡 = 单选钮的代理点击面
    !insertmacro fnosHot 46 145 350 95 fnosModePickAll
    !insertmacro fnosHot 46 255 350 95 fnosModePickCurrent
    ; 安装位置区(右上卡): 路径容器框 pathplate — 画稿像素(881,401,580x270) →
    ; 逻辑(440,200,290x135)。路径显示 = EDIT 本体坐入框内标签以下整行:
    ; 框内(24,52,532,72)@2x → 页面逻辑(452,226,266,36)
    !insertmacro fnosArtRect 452 226 266 36
    ${NSD_CreateText} $3 $4 $5 $6 "$INSTDIR"
    Pop $fnosDirEdit
    ; EDIT 融框: 清 WS_EX_CLIENTEDGE 边框 → FRAMECHANGED 重算非客户区
    ; → SetCtlColors(深藏青字 / 底=容器框同色 f3f7fe; EDIT 不支持透明)
    System::Call 'user32::GetWindowLongW(p $fnosDirEdit, i -20) i.r1'
    IntOp $1 $1 & 0xFFFFFDFF
    System::Call 'user32::SetWindowLongW(p $fnosDirEdit, i -20, i r1)'
    System::Call 'user32::SetWindowPos(p $fnosDirEdit, p 0, i 0, i 0, i 0, i 0, i 0x37)'
    SetCtlColors $fnosDirEdit ${FNOS_SUB} f3f7fe
    SendMessage $fnosDirEdit 0x0030 $fnosFontPage 1
    System::Call 'user32::InvalidateRect(p $fnosDirEdit, p 0, i 1)'
    Call fnosModeDefaultPath
    ${NSD_SetText} $fnosDirEdit $0
    ; browse(60,314,180,64)@2x → 页面(440,302,90,32)
    !insertmacro fnosHot 440 302 90 32 fnosDirBrowse
    ; 向导按钮本体退场(隐藏稳定; Enter/Esc 仍路由到本体), 药丸 = 画稿 + nsDialogs
    ; 热区转发 BM_CLICK(与欢迎页 CTA 同款已验证链路; 原生按钮/外来控件发
    ; WM_COMMAND 的路子 NSIS 不认, 实测两轮均死, 勿回退)
    GetDlgItem $1 $HWNDPARENT 1
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $HWNDPARENT 2
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $HWNDPARENT 3
    ShowWindow $1 ${SW_HIDE}
    !insertmacro fnosHot 210 412 170 48 fnosPillBackClick
    !insertmacro fnosHot 400 412 170 48 fnosPillInstallClick
  FunctionEnd

  ; 药丸热区: 转发点击到隐藏的本体按钮(上一步=3 / 开始安装=1)
  Function fnosPillBackClick
    Pop $0
    GetDlgItem $1 $HWNDPARENT 3
    SendMessage $1 0x00F5 0 0              ; BM_CLICK
  FunctionEnd

  Function fnosPillInstallClick
    Pop $0
    GetDlgItem $1 $HWNDPARENT 1
    SendMessage $1 0x00F5 0 0              ; BM_CLICK → EB InstModeLeave 定模式/提权/置默认 INSTDIR
    ; 用户自定义安装位置优先于模式默认值(留空 = 沿用默认), 并按 EB 规则补应用目录名
    ${NSD_GetText} $fnosDirEdit $0
    ${If} $0 != ""
      StrCpy $INSTDIR $0
      ${StrContains} $1 "${APP_FILENAME}" $INSTDIR
      ${If} $1 == ""
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}
      ${NSD_SetText} $fnosDirEdit $INSTDIR
    ${EndIf}
  FunctionEnd

  ; 选择卡贴片: $fnosModeSel(1=所有用户卡选中) → 对应画稿裁片
  Function fnosModeSwapCards
    ${If} $fnosModeSel == 1
      StrCpy $R8 "$PLUGINSDIR\fnos-mode-a.bmp"
    ${Else}
      StrCpy $R8 "$PLUGINSDIR\fnos-mode-b.bmp"
    ${EndIf}
    StrCpy $R7 $fnosModeCardsCtl
    Call fnosSwapBmp
  FunctionEnd

  ; 卡片热区回调: 代理点击隐藏单选钮(BN_CLICKED → EB InstModeChange 更新说明/盾牌)
  Function fnosModePickAll
    Pop $0
    StrCpy $fnosModeSel 1
    Call fnosModeSwapCards
    SendMessage $MultiUser.InstallModePage.AllUsers 0x00F5 0 0    ; BM_CLICK
    Call fnosModeDefaultPath
    ${NSD_SetText} $fnosDirEdit $0                                ; 输入框随模式带出默认路径
  FunctionEnd

  Function fnosModePickCurrent
    Pop $0
    StrCpy $fnosModeSel 0
    Call fnosModeSwapCards
    SendMessage $MultiUser.InstallModePage.CurrentUser 0x00F5 0 0 ; BM_CLICK
    Call fnosModeDefaultPath
    ${NSD_SetText} $fnosDirEdit $0                                ; 输入框随模式带出默认路径
  FunctionEnd

  ; ── [v5] 安装位置区(集成在安装选项页右侧面板, 替代独立目录页):
  ; 路径输入框(本体 Text)坐进画稿输入槽, 浏览热区弹系统文件夹对话框;
  ; 默认路径随选中模式联动(注册表已有安装则带出, 否则按模式给推荐位置),
  ; 点「下一步」时自定义路径覆盖模式默认 INSTDIR 并按 EB 规则补应用目录名。 ──
  Function fnosModeDefaultPath
    ; 入参 $fnosModeSel(1=所有用户) → 出参 $0 = 该模式默认路径
    ${If} $fnosModeSel == 1
      ${If} $perMachineInstallationFolder != ""
        StrCpy $0 $perMachineInstallationFolder
      ${Else}
        StrCpy $0 "$PROGRAMFILES64\Fntv-Plus"
      ${EndIf}
    ${Else}
      ${If} $perUserInstallationFolder != ""
        StrCpy $0 $perUserInstallationFolder
      ${Else}
        StrCpy $0 "$LOCALAPPDATA\Programs\Fntv-Plus"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function fnosDirBrowse
    Pop $0
    ${NSD_GetText} $fnosDirEdit $1
    nsDialogs::SelectFolderDialog "选择安装文件夹" "$1"
    Pop $0
    ${If} $0 != "cancel"
    ${AndIf} $0 != "error"
    ${AndIf} $0 != ""
      ${NSD_SetText} $fnosDirEdit $0
    ${EndIf}
  FunctionEnd

  Function fnosFinishPre
    LockWindow on
    nsDialogs::Create 1044
    Pop $0
    SetCtlColors $0 "" f8fbff
    !insertmacro fnosFitWindow $0
    ${NSD_CreateBitmap} 0 0 $fnosPW $fnosPH ""
    Pop $fnosFinishBmpCtl
    ${NSD_SetStretchedImage} $fnosFinishBmpCtl "$PLUGINSDIR\fnos-finish.bmp" $fnosFinishBmp
    ${NSD_OnClick} $fnosFinishBmpCtl fnosFinishArtClick      ; 两个药丸区域在处理器内分发
    Call muiPageLoadFullWindow
    GetDlgItem $1 $HWNDPARENT 1
    ShowWindow $1 ${SW_HIDE}
    SendMessage $1 ${WM_SETTEXT} 0 "STR:完成"            ; Enter/关闭键语义对齐
    GetDlgItem $1 $HWNDPARENT 2
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $HWNDPARENT 3
    ShowWindow $1 ${SW_HIDE}
    ; 恢复标题栏 ✕(NSIS 安装期间禁用系统菜单; 原生完成页由 MUI2 恢复, 自绘页自己来)
    System::Call 'user32::GetSystemMenu(p $HWNDPARENT, i 0) p.r1'
    System::Call 'user32::EnableMenuItem(p r1, i 0xF060, i 0)'   ; SC_CLOSE, MF_ENABLED
    LockWindow off
    nsDialogs::Show
    ${NSD_FreeImage} $fnosFinishBmp
    Call muiPageUnloadFullWindow
  FunctionEnd

  Function fnosFinishArtClick
    ; 光标 → 位图客户坐标: 命中「立即体验」先启动应用; 两个药丸都关闭向导
    System::Call 'user32::GetCursorPos(@r9)'
    System::Call 'user32::ScreenToClient(p $fnosFinishBmpCtl, p r9)'
    System::Call '*$9(i.r1, i.r2)'
    IntOp $3 $fnosPW * 210
    IntOp $3 $3 / 780
    IntOp $4 $fnosPH * 412
    IntOp $4 $4 / 520
    IntOp $5 $fnosPW * 170
    IntOp $5 $5 / 780
    IntOp $6 $fnosPH * 48
    IntOp $6 $6 / 520
    IntOp $7 $3 + $5
    IntOp $8 $4 + $6
    ${If} $1 >= $3
    ${AndIf} $1 <= $7
    ${AndIf} $2 >= $4
    ${AndIf} $2 <= $8
      ; 启动应用(--updated 语义对齐 EB 的 StartApp; 该宏含 Var 声明且在
      ; installSection.nsh 才展开, 不可在此重复 !insertmacro, 故内联)
      ${if} ${isUpdated}
        StrCpy $fnosRunArgs "--updated"
      ${else}
        StrCpy $fnosRunArgs ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$fnosRunArgs"
    ${EndIf}
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 0x00F5 0 0                            ; 关闭向导
  FunctionEnd

  Function fnosFinishLeave
  FunctionEnd

  ; ── [v5] 进度页画稿化: SHOW 时控件已存在(MUI2 自己也在此取句柄), 从第一帧生效。
  ; 状态文字/进度条/显示细节按钮退场(标题与玻璃轨道已烘焙, 进度反馈由明细列表承担),
  ; 明细列表置入烘焙玻璃面板(去 sunken 边框); 本页非 nsDialogs, 没有可靠的脚本点击
  ; 通道, 取消/下一步用本体按钮自绘隐形挪进药丸槽位(实测挪位不复位), 仅藏上一步;
  ; 段尾钩子(customInstall)把标题条/按钮区换成「安装完成」贴片。 ──
  Function fnosInstFilesShow
    StrCpy $fnosInstDone 0
    StrCpy $fnosInstTitleCtl 0
    StrCpy $R8 "$PLUGINSDIR\fnos-inst.bmp"
    Call fnosNativeArtShow                              ; $R5 = 页面 dialog
    ; 完成态标题条控件(空图透明, customInstall 时换「安装完成」贴片)
    !insertmacro fnosArtRect 0 50 780 100
    System::Call 'kernel32::GetModuleHandle(p 0) p.r7'
    System::Call 'user32::CreateWindowEx(i 0, w "STATIC", w "", i 0x5000000E, i $3, i $4, i $5, i $6, p $R5, p 0x2205, p r7, p 0) p.r1'
    StrCpy $fnosInstTitleCtl $1
    SetCtlColors $1 "" transparent
    ; 原生状态文字/进度条/显示细节按钮退场; 明细列表强制展开(NSIS 默认隐藏)
    ShowWindow $mui.InstFilesPage.Text ${SW_HIDE}
    ShowWindow $mui.InstFilesPage.ProgressBar ${SW_HIDE}
    ShowWindow $mui.InstFilesPage.ShowLogButton ${SW_HIDE}
    ShowWindow $mui.InstFilesPage.Log ${SW_SHOW}
    ; 明细列表置入烘焙玻璃面板: 去 sunken 边框(面板自带描边), 白底深藏青字
    !insertmacro fnosArtRect 51 132 678 243
    System::Call 'user32::SetWindowPos(p $mui.InstFilesPage.Log, p 0, i $3, i $4, i $5, i $6, i 0x14)'
    System::Call 'user32::GetWindowLongW(p $mui.InstFilesPage.Log, i -20) i.r1'      ; GWL_EXSTYLE
    IntOp $1 $1 & 0xFFFFFDFF                                                         ; 清 WS_EX_CLIENTEDGE
    System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.Log, i -20, i r1)'
    System::Call 'user32::SetWindowPos(p $mui.InstFilesPage.Log, p 0, i 0, i 0, i 0, i 0, i 0x37)'   ; SWP_FRAMECHANGED 重绘非客户区
    SetCtlColors $mui.InstFilesPage.Log ${FNOS_TEXT} ffffff
    SendMessage $mui.InstFilesPage.Log 0x0030 $fnosFont 1
    ; ShowInstDetails nevershow 会让 NSIS 不写逐文件日志: 模拟点一下「显示细节」
    ; 翻开内部明细开关(列表已被显式 SW_SHOW, 视觉无跳变), 之后 NSIS 实时写明细
    SendMessage $mui.InstFilesPage.ShowLogButton 0x00F5 0 0                          ; BM_CLICK
    ; 取消/下一步 = 本体按钮改自绘(无人应答 = 隐形, 画稿药丸透出) + 挪进药丸槽位;
    ; 本体按钮的 WM_COMMAND NSIS 必认, 点击/禁用态/UAC/Enter/Esc 全原生;
    ; 进度页挪位已实测不复位(取消按钮挪后停留原位)。
    ; 本体按钮自第二步起一直处于隐藏态, 必须显式 SW_SHOW —— 隐藏控件不参与鼠标命中。
    GetDlgItem $1 $HWNDPARENT 2
    ShowWindow $1 ${SW_SHOW}
    !insertmacro fnosSkinButton $1 230 412 170 48
    GetDlgItem $1 $HWNDPARENT 1
    ShowWindow $1 ${SW_SHOW}
    !insertmacro fnosSkinButton $1 420 412 170 48
    GetDlgItem $1 $HWNDPARENT 3
    ShowWindow $1 ${SW_HIDE}
    ; 按钮区条带控件(初始: 取消药丸; .onInstSuccess 换成下一步药丸, 隐藏已消失的取消)
    !insertmacro fnosArtRect 200 405 390 65
    System::Call 'kernel32::GetModuleHandle(p 0) p.r7'
    System::Call 'user32::CreateWindowEx(i 0, w "STATIC", w "", i 0x5000000E, i $3, i $4, i $5, i $6, p $R5, p 0x2206, p r7, p 0) p.r1'
    StrCpy $fnosInstBarCtl $1
    SetCtlColors $1 "" transparent
    StrCpy $R7 $1
    StrCpy $R8 "$PLUGINSDIR\fnos-inst-bar.bmp"
    Call fnosSwapBmp
  FunctionEnd
!macroend

; ── [v5] EB installSection 尾部钩子: 全部文件解压/注册表/快捷方式就绪后 —— 视觉上
; 即「安装完成」瞬间, 页内换片(标题条 + 按钮区条带换成下一步单药丸)走这里。
; 注意 .onInstSuccess 是安装器收尾退出前才触发(实测页内不触发), 不能用它。
; 卸载器遍 fnosSwapBmp 未编译, 整个宏条件声明。 ──
!ifndef BUILD_UNINSTALLER
!macro customInstall
  StrCpy $fnosInstDone 1
  ${If} $fnosInstTitleCtl P<> 0
    StrCpy $R7 $fnosInstTitleCtl
    StrCpy $R8 "$PLUGINSDIR\fnos-inst-done.bmp"
    Call fnosSwapBmp
  ${EndIf}
  ${If} $fnosInstBarCtl P<> 0
    StrCpy $R7 $fnosInstBarCtl
    StrCpy $R8 "$PLUGINSDIR\fnos-inst-bar-done.bmp"
    Call fnosSwapBmp
  ${EndIf}
!macroend
!endif
