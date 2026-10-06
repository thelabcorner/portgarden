# Captures the Port Garden window only.
#
# Uses PrintWindow with PW_RENDERFULLCONTENT rather than CopyFromScreen.
# CopyFromScreen grabs whatever is painted at those screen coordinates, so it
# photographs the wrong application whenever another window is on top - and
# Windows restricts SetForegroundWindow, so raising the window first is not
# something this script can rely on. PrintWindow asks the window to render itself
# into a device context, which is independent of z-order and does not steal focus.
# Chromium surfaces need the 0x2 flag or they render as a blank frame.
#
# The P/Invoke class deliberately touches only user32: PowerShell 7 does not
# reference System.Drawing.Common when it compiles inline C#, so the bitmap work
# happens here in PowerShell, where `Add-Type -AssemblyName System.Drawing` has
# already loaded it.

Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WindowProbe {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

# Before anything is measured. A DPI-unaware process gets virtualized coordinates
# from GetWindowRect, so a 1770-physical-pixel window reports as 1194 and the
# capture silently becomes the top-left crop of the real window - which reads
# exactly like a broken layout. Malformed and easy to misdiagnose.
[void][WindowProbe]::SetProcessDPIAware()

$process = Get-Process |
  # A prefix match: the demo page's document title is 'Port Garden - interface preview'.#
  Where-Object { $_.MainWindowTitle -like 'Port Garden*' -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $process) {
  Write-Output 'WINDOW_NOT_FOUND'
  exit 1
}

$handle = $process.MainWindowHandle
$rect = New-Object WindowProbe+RECT
if (-not [WindowProbe]::GetWindowRect($handle, [ref]$rect)) {
  Write-Output 'NO_RECT'
  exit 1
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  Write-Output "BAD_RECT ${width}x${height}"
  exit 1
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$ok = [WindowProbe]::PrintWindow($handle, $hdc, 0x00000002)
$graphics.ReleaseHdc($hdc)

$out = Join-Path $env:TEMP 'openfork\portgarden-window.png'
if ($ok) { $bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }
$graphics.Dispose()
$bitmap.Dispose()

if (-not $ok) {
  Write-Output 'PRINTWINDOW_FAILED'
  exit 1
}
Write-Output "pid=$($process.Id) size=${width}x${height} saved=$out bytes=$((Get-Item $out).Length)"