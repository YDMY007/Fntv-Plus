# shot-setup-ui.ps1 — 依次截取安装器 UI 的四页画面(窗口按 780x520 居中)
param(
  [string]$OutDir = "D:\GitHub\Fntv-Plus\scripts\setup-ui\shots"
)
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$left = [int]($screen.Width / 2 - 390)
$top = [int]($screen.Height / 2 - 300)

function Shot([string]$name, [int]$delayMs) {
  Start-Sleep -Milliseconds $delayMs
  $bmp = New-Object System.Drawing.Bitmap 780, 520
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size 780, 520))
  $bmp.Save((Join-Path $OutDir ($name + ".png")), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Host "shot $name"
}

Shot "p1-welcome" 500
Shot "p2-options" 2000
Shot "p3-progress" 2800
Shot "p4-finish" 4500
Write-Host "done"
