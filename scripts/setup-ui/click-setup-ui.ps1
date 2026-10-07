Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public struct RECT { public int L, T, R, B; }
    public static void Click(int x, int y) {
        SetCursorPos(x, y);
        System.Threading.Thread.Sleep(120);
        mouse_event(2, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
    }
}
"@

$p = Get-Process FntvSetupUi -ErrorAction Stop
$h = $p.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Host "NO MAIN WINDOW"; exit 1 }
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$fg = [W]::GetForegroundWindow()
Write-Host ("foreground==target: {0}" -f ($fg -eq $h))
$r = New-Object W+RECT
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.R - $r.L
$scale = $w / 780.0
Write-Host ("rect {0},{1} {2}x{3} scale={4}" -f $r.L, $r.T, $w, ($r.B - $r.T), $scale)

function ClickDip([double]$ox, [double]$oy, [int]$waitMs) {
    $px = [int]($r.L + $ox * $scale)
    $py = [int]($r.T + $oy * $scale)
    [W]::Click($px, $py)
    Start-Sleep -Milliseconds $waitMs
    Write-Host ("click dip({0},{1}) -> px({2},{3})" -f $ox, $oy, $px, $py)
}

Start-Sleep -Milliseconds 1500
ClickDip 68 468 600
ClickDip 662 464 1000
ClickDip 585 460 800
Start-Sleep -Milliseconds 5600
ClickDip 409 461 900
Write-Host "click-tour done"
