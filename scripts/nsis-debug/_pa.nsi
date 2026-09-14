; scripts/nsis-debug/_pa.nsi — 单独验证 fnosPathNonAscii 的判定法
; (Unicode 串按 UTF-8 编码后 字节数 > 字符数 ⇒ 含非 ASCII)
; 编译: makensis -INPUTCHARSET UTF8 _pa.nsi  然后直接运行 _pa.exe(静默)
Unicode true
SilentInstall silent
OutFile "D:\GitHub\Fntv-Plus\scripts\nsis-debug\_pa.exe"
RequestExecutionLevel user
!include LogicLib.nsh

Section
  FileOpen $9 "D:\GitHub\Fntv-Plus\scripts\nsis-debug\_pa.txt" w
  FileWrite $9 "case | len | utf8 | nonascii | expect$\r$\n"

  StrCpy $0 "D:\Fntv-Plus"
  Call chk
  FileWrite $9 "pure-ascii   | $2 | $3 | $1 | 0$\r$\n"

  StrCpy $0 "D:\贴图测试\Fntv-Plus"
  Call chk
  FileWrite $9 "chinese-dir  | $2 | $3 | $1 | 1$\r$\n"

  StrCpy $0 "C:\Program Files\Fntv-Plus"
  Call chk
  FileWrite $9 "with-space   | $2 | $3 | $1 | 0$\r$\n"

  StrCpy $0 "D:\Fntv-Plus（测试）"
  Call chk
  FileWrite $9 "fullwidth-tag| $2 | $3 | $1 | 1$\r$\n"

  FileClose $9
SectionEnd

Function chk
  StrCpy $1 0
  StrLen $2 $0
  System::Call 'kernel32::WideCharToMultiByte(i 65001, i 0, w "$0", i -1, p 0, i 0, p 0, p 0) i.r3'
  IntOp $3 $3 - 1
  ${If} $3 > $2
    StrCpy $1 1
  ${EndIf}
FunctionEnd
