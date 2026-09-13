; scripts/nsis-debug/wizard-test.nsi — 独立向导 UI 测试工程
; 复刻 electron-builder assisted installer(oneClick=false) 的页面装配顺序,
; 引用真实 build/installer.nsh 与 EB 模板, 不打包 Electron 应用即可迭代向导 UI。
; 页面: customWelcomePage → PAGE_INSTALL_MODE(安装选项) → MUI_PAGE_INSTFILES → customFinishPage
; 编译: makensis -INPUTCHARSET UTF8 wizard-test.nsi (见 build-wizard.cmd)
Unicode true

!addincludedir "D:\GitHub\Fntv-Plus\node_modules\app-builder-lib\templates\nsis\include"
!addincludedir "D:\GitHub\Fntv-Plus\node_modules\app-builder-lib\templates\nsis"
!addincludedir "D:\GitHub\Fntv-Plus\build"
!addplugindir /x86-unicode "C:\Users\24305\AppData\Local\electron-builder\Cache\nsis-resources-3.4.1\nsis-resources-3.4.1-2jx2y\plugins\x86-unicode"

!include "StdUtils.nsh"
; EB NsisTarget 生成的 LogicLib 谓词(见 release/builder-debug.yml nsis.script 头部)
!macro _isUpdated _a _b _t _f
  ${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isUpdated `"" isUpdated ""`
!macro _isForceRun _a _b _t _f
  ${StdUtils.TestParameter} $R9 "force-run"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForceRun `"" isForceRun ""`
!macro _isKeepShortcuts _a _b _t _f
  ${StdUtils.TestParameter} $R9 "keep-shortcuts"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isKeepShortcuts `"" isKeepShortcuts ""`
!macro _isNoDesktopShortcut _a _b _t _f
  ${StdUtils.TestParameter} $R9 "no-desktop-shortcut"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isNoDesktopShortcut `"" isNoDesktopShortcut ""`
!macro _isDeleteAppData _a _b _t _f
  ${StdUtils.TestParameter} $R9 "delete-app-data"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isDeleteAppData `"" isDeleteAppData ""`
!macro _isForAllUsers _a _b _t _f
  ${StdUtils.TestParameter} $R9 "allusers"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForAllUsers `"" isForAllUsers ""`
!macro _isForCurrentUser _a _b _t _f
  ${StdUtils.TestParameter} $R9 "currentuser"
  StrCmp "$R9" "true" `${_t}` `${_f}`
!macroend
!define isForCurrentUser `"" isForCurrentUser ""`

; ── 产品 defines(EB NsisTarget 传参子集, oneClick=false 助手安装器) ──
!define PRODUCT_NAME "Fntv-Plus"
!define PRODUCT_FILENAME "Fntv-Plus"
!define VERSION "3.7.0"
!define APP_FILENAME "Fntv-Plus"
!define SHORTCUT_NAME "Fntv-Plus"
!define INSTALL_REGISTRY_KEY "Software\FntvWizardTest"
!define UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FntvWizardTest"
!define BUILD_RESOURCES_DIR "D:\GitHub\Fntv-Plus\build"
!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION
!define INSTALL_MODE_PER_ALL_USERS_REQUIRED
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "D:\GitHub\Fntv-Plus\build\installerHeader.bmp"

OutFile "D:\GitHub\Fntv-Plus\scripts\nsis-debug\wizard-test.exe"
RequestExecutionLevel user

; 顺序对齐 EB 生成脚本: installer.nsh(钩子宏) → common → MUI2 → multiUser → assistedInstaller(页面)
!include "D:\GitHub\Fntv-Plus\build\installer.nsh"
!include "common.nsh"
!include "MUI2.nsh"
Var launchLink

; ── 多用户页文案(EB assistedMessages.yml zh_CN; LANGID 2052 = SimpChinese) ──
!define LANGID_ZHCN 2052
LangString chooseInstallationOptions ${LANGID_ZHCN} "安装选项"
LangString whoShouldThisApplicationBeInstalledFor ${LANGID_ZHCN} "为哪位用户安装该应用？"
LangString selectUserMode ${LANGID_ZHCN} "请选择为当前用户还是所有用户安装该软件"
LangString forAll ${LANGID_ZHCN} "为使用这台电脑的任何人安装 (所有用户)"
LangString onlyForMe ${LANGID_ZHCN} "仅为我安装"
LangString freshInstallForAll ${LANGID_ZHCN} "为所有用户进行全新安装. (需要管理员资格)"
LangString freshInstallForCurrent ${LANGID_ZHCN} "仅为当前用户进行全新安装."
LangString loginWithAdminAccount ${LANGID_ZHCN} "您需要用属于管理员群组的用户账户登录来继续..."
LangString perUserInstallExists ${LANGID_ZHCN} "已经存在一个安装到当前用户的安装."
LangString perMachineInstallExists ${LANGID_ZHCN} "已经存在一个安装到所有用户的安装."
LangString reinstallUpgrade ${LANGID_ZHCN} "即将重新安装/升级."
LangString perUserInstall ${LANGID_ZHCN} "存在一个安装到当前用户的安装."
LangString perMachineInstall ${LANGID_ZHCN} "存在一个安装到所有用户的安装."

; multiUser.nsh 必须全路径: 裸名会大小写不敏感撞上官方 Include\MultiUser.nsh
!include "D:\GitHub\Fntv-Plus\node_modules\app-builder-lib\templates\nsis\multiUser.nsh"
!include "assistedInstaller.nsh"
; MUI_ICON 已由 EB 模板(common.nsh)定义, 这里不要再定义(会 "already defined" 报错)
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  !insertmacro initMultiUser
  ; 测试态: 模拟「已有当前用户安装」走升级文案, 安装目标指向临时目录(不落真实程序)
  StrCpy $perUserInstallationFolder "$LOCALAPPDATA\Programs\Fntv-Plus"
  StrCpy $hasPerUserInstallation "1"
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $INSTDIR "$TEMP\FntvWizardTest"
  !insertmacro customInit
FunctionEnd

Section "install" SEC_ID
  SetOutPath $INSTDIR
  ; 真实 File 解压(NSIS 会写「提取:」明细日志) + 间歇, 模拟可观察的安装进度
  File /oname=$INSTDIR\payload1.dat "D:\GitHub\Fntv-Plus\build\iconfntv.png"
  Sleep 260
  File /oname=$INSTDIR\payload2.dat "D:\GitHub\Fntv-Plus\build\iconfntv.png"
  Sleep 260
  File /oname=$INSTDIR\payload3.dat "D:\GitHub\Fntv-Plus\build\iconfntv.png"
  Sleep 260
  File /oname=$INSTDIR\payload4.dat "D:\GitHub\Fntv-Plus\build\iconfntv.png"
  Sleep 260
  File /oname=$INSTDIR\payload5.dat "D:\GitHub\Fntv-Plus\build\iconfntv.png"
  Sleep 260
  File /oname=$INSTDIR\payload6.dat "D:\GitHub\Fntv-Plus\build\iconfntv.png"
  Sleep 400
  ; 真实 EB 安装段尾部会 !insertmacro customInstall(文件/注册表/快捷方式就绪后),
  ; 测试工程必须同样调用, 页内「安装完成」换片才会发生
  !ifndef BUILD_UNINSTALLER
    !insertmacro customInstall
  !endif
SectionEnd
