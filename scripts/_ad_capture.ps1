# lc-1158 弹窗实测: 重启中文路径打包版 → 找弹窗窗 → 前台截图
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;using System.Runtime.InteropServices;using System.Text;
public class EW9 {
  public delegate bool CB(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(CB cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int L,T,R,B; }
}
'@
Start-Process 'D:\贴图测试\Fntv-Plus\Fntv-Plus.exe'
Start-Sleep -Seconds 9
$pids = @((Get-Process Fntv-Plus -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }))
Write-Output ("pids: " + ($pids -join ','))
$out = New-Object System.Text.StringBuilder
$cb = [EW9+CB]{ param($h, $l)
  [uint32]$wpid = 0; [EW9]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
  if ($pids -contains [int]$wpid -and [EW9]::IsWindowVisible($h)) {
    $r = New-Object EW9+RECT
    [EW9]::GetWindowRect($h, [ref]$r) | Out-Null
    if (($r.R - $r.L) -gt 200) { [void]$out.AppendLine($h.ToString() + '|' + $r.L + ',' + $r.T + ',' + $r.R + ',' + $r.B) }
  }
  return $true
}
[EW9]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$info = $out.ToString().Trim()
Write-Output $info
if ($info) {
  $first = ($info -split "`n")[0]
  $parts = $first.Split('|')
  $h = [IntPtr][long]$parts[0]; $rc = $parts[1].Split(',')
  [EW9]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 600
  $w = [int]$rc[2] - [int]$rc[0]; $ht = [int]$rc[3] - [int]$rc[1]
  $b = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen([int]$rc[0], [int]$rc[1], 0, 0, $b.Size)
  $b.Save($env:TEMP + '\ad-real3.png')
  Write-Output ("captured " + $w + "x" + $ht)
} else {
  Write-Output 'no-window'
}
