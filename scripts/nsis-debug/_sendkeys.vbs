' _sendkeys.vbs — 激活窗口并发送按键(仅供 NSIS 向导调试)
' 用法: cscript //nologo _sendkeys.vbs "<窗口标题>" "<按键>"
Set ws = CreateObject("WScript.Shell")
If WScript.Arguments.Count >= 1 Then
  WScript.Sleep 300
  ws.AppActivate WScript.Arguments(0)
End If
WScript.Sleep 600
If WScript.Arguments.Count >= 2 Then
  ws.SendKeys WScript.Arguments(1)
End If
WScript.Sleep 300
