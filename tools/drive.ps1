<#
  Drives the running Agamiz Code window for manual verification.

  Two design rules:
   * Capture is window-only (PrintWindow on the app's HWND), never a full
     screen grab. A screen grab sweeps in whatever else the user has open,
     which is neither useful nor ours to photograph.
   * Input goes through raw virtual-key codes and a real pointer stream,
     because SendKeys cannot express the backquote and a teleporting cursor
     produces no pointermove events for a drag to react to.
#>
param(
  [string]$Action = 'shot',
  [int]$X = 0, [int]$Y = 0, [int]$X2 = 0, [int]$Y2 = 0,
  [string]$Keys = '',
  [string]$Chord = '',
  [string]$Out = 'shot.png',
  [int]$CropX = -1, [int]$CropY = -1, [int]$CropW = 0, [int]$CropH = 0,
  [int]$PreDelay = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('Win32Api' -as [type])) {
  # No System.Drawing in here: Add-Type does not reference that assembly by
  # default, and the bitmap work is easier to do from PowerShell anyway.
  Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct WinRect { public int Left, Top, Right, Bottom; }

public class Win32Api {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out WinRect r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);

  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public const uint KEYUP = 0x0002;
  public const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;
  // WebView2 renders through DirectComposition, so a plain BitBlt of the
  // window returns an empty rectangle. This flag asks for a real repaint.
  public const uint RENDERFULLCONTENT = 0x00000002;

  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);

  /// <summary>
  /// Actually put the window on top and give it the keyboard.
  /// SetForegroundWindow alone is refused whenever the caller does not own the
  /// current foreground window (Windows' foreground lock), so a click would be
  /// delivered to whatever happens to be physically above us. Attaching this
  /// thread to the foreground window's input queue lifts that restriction --
  /// SetForegroundWindow and SetFocus are then honoured. The ALT tap and the
  /// TOPMOST hop are belt and braces: the first releases the lock on the older
  /// path, the second pins z-order regardless of what anyone does afterwards.
  /// </summary>
  public static void ForceForeground(IntPtr h) {
    const byte VK_MENU = 0x12;
    IntPtr fg = GetForegroundWindow();
    uint fgThread = (fg != IntPtr.Zero) ? GetWindowThreadProcessId(fg, IntPtr.Zero) : 0;
    uint myThread = GetCurrentThreadId();
    bool attached = (fgThread != 0 && fgThread != myThread) && AttachThreadInput(myThread, fgThread, true);

    keybd_event(VK_MENU, 0, 0, IntPtr.Zero);
    ShowWindow(h, 9);                 // SW_RESTORE
    BringWindowToTop(h);
    SetForegroundWindow(h);
    SetFocus(h);
    SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    keybd_event(VK_MENU, 0, KEYUP, IntPtr.Zero);

    if (attached) AttachThreadInput(myThread, fgThread, false);
  }

  /// <summary>Drop back out of always-on-top once the interaction is done.</summary>
  public static void ReleaseTopmost(IntPtr h) {
    SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
  }
}
"@
}

$VKMAP = @{
  'CTRL' = 0x11; 'SHIFT' = 0x10; 'ALT' = 0x12; 'WIN' = 0x5B
  'BACKQUOTE' = 0xC0; '1' = 0x31; '5' = 0x35
  'A' = 0x41; 'C' = 0x43; 'K' = 0x4B; 'V' = 0x56; 'L' = 0x4C
  'PAGEUP' = 0x21; 'PAGEDOWN' = 0x22; 'ESC' = 0x1B; 'ENTER' = 0x0D
  'HOME' = 0x24; 'END' = 0x23; 'LEFT' = 0x25; 'RIGHT' = 0x26
  'UP' = 0x26; 'DOWN' = 0x28
}

function Send-Chord([string]$chordText) {
  $codes = @($chordText -split '\+' | ForEach-Object { $VKMAP[$_.ToUpper()] } | Where-Object { $_ })
  if ($codes.Count -eq 0) { return }
  foreach ($c in $codes) { [Win32Api]::keybd_event([byte]$c, 0, 0, [IntPtr]::Zero) }
  Start-Sleep -Milliseconds 40
  foreach ($c in ($codes | Sort-Object -Descending)) {
    [Win32Api]::keybd_event([byte]$c, 0, [Win32Api]::KEYUP, [IntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 300
}

# The Tauri binary is `app.exe`; it owns the real top-level window.
$p = Get-Process -Name 'app' -ErrorAction SilentlyContinue |
     Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'APP_WINDOW_NOT_FOUND'; exit 1 }
$h = $p.MainWindowHandle

[void][Win32Api]::ForceForeground($h)
Start-Sleep -Milliseconds 700
$fg = [Win32Api]::GetForegroundWindow()
if ($fg -ne $h) { Write-Output "WARNING_NOT_FOREGROUND (fg=$fg want=$h)"; }

# Input coordinates are WINDOW-relative. The window can move between calls
# (a restore, a maximise, the user's own dragging), and absolute coordinates
# captured from an earlier screenshot would then land somewhere else entirely.
$rect = New-Object WinRect
[void][Win32Api]::GetWindowRect($h, [ref]$rect)
$SX = $rect.Left + $X
$SY = $rect.Top + $Y
$SX2 = $rect.Left + $X2
$SY2 = $rect.Top + $Y2

if ($PreDelay -gt 0) { Start-Sleep -Seconds $PreDelay }
if ($Chord) { Send-Chord $Chord }
if ($Keys) {
  foreach ($k in $Keys -split ';') {
    if (-not $k) { continue }
    if ($k.StartsWith('^')) { Send-Chord $k.Substring(1) }
    else { [System.Windows.Forms.SendKeys]::SendWait($k); Start-Sleep -Milliseconds 300 }
  }
  Start-Sleep -Milliseconds 400
}

switch ($Action) {
  'click' {
    [void][Win32Api]::SetCursorPos($SX, $SY); Start-Sleep -Milliseconds 250
    [Win32Api]::mouse_event([Win32Api]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 70
    [Win32Api]::mouse_event([Win32Api]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 600
    Write-Output "CLICKED win($X,$Y) -> screen($SX,$SY)"
  }
  'rclick' {
    [void][Win32Api]::SetCursorPos($SX, $SY); Start-Sleep -Milliseconds 300
    [Win32Api]::mouse_event([Win32Api]::RIGHTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    [Win32Api]::mouse_event([Win32Api]::RIGHTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 700
    Write-Output "RCLICKED win($X,$Y) -> screen($SX,$SY)"
  }
  'move' {
    [void][Win32Api]::SetCursorPos($SX, $SY); Start-Sleep -Milliseconds 400
    Write-Output "MOVED win($X,$Y) -> screen($SX,$SY)"
  }
  'dblclick' {
    [void][Win32Api]::SetCursorPos($SX, $SY); Start-Sleep -Milliseconds 300
    for ($i = 0; $i -lt 2; $i++) {
      [Win32Api]::mouse_event([Win32Api]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 30
      [Win32Api]::mouse_event([Win32Api]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 40
    }
    Start-Sleep -Milliseconds 700
    Write-Output "DBLCLICKED win($X,$Y)"
  }
  'drag' {
    [void][Win32Api]::SetCursorPos($SX, $SY); Start-Sleep -Milliseconds 350
    [Win32Api]::mouse_event([Win32Api]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 250
    $steps = 24
    for ($i = 1; $i -le $steps; $i++) {
      $t = $i / $steps
      # Ease in and out, the way a hand-driven drag accelerates.
      $e = $t * $t * (3 - 2 * $t)
      [void][Win32Api]::SetCursorPos(
        [int][Math]::Round($X + ($X2 - $X) * $e),
        [int][Math]::Round($Y + ($Y2 - $Y) * $e))
      Start-Sleep -Milliseconds 22
    }
    Start-Sleep -Milliseconds 250
    [Win32Api]::mouse_event([Win32Api]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 700
    Write-Output "DRAGGED win($X,$Y)->($X2,$Y2) screen($SX,$SY)->($SX2,$SY2)"
  }
  'shot' {
    $r = $rect
    $w = $r.Right - $r.Left
    $ht = $r.Bottom - $r.Top
    if ($w -le 0 -or $ht -le 0) { Write-Output 'BAD_WINDOW_RECT'; exit 1 }

    $bmp = New-Object System.Drawing.Bitmap $w, $ht, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [Win32Api]::PrintWindow($h, $hdc, [Win32Api]::RENDERFULLCONTENT)
    $g.ReleaseHdc($hdc)
    $g.Dispose()
    $method = 'PrintWindow'

    if (-not $ok) {
      # WebView2's DirectComposition surface refuses PrintWindow. Fall back to
      # a screen grab *clipped to this window's rect* — still bounded to the
      # app, unlike a full-screen capture.
      $method = 'ScreenClip'
      $g2 = [System.Drawing.Graphics]::FromImage($bmp)
      $g2.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $ht))
      $g2.Dispose()
    }

    $target = $bmp
    if ($CropW -gt 0 -and $CropH -gt 0) {
      $cx = [Math]::Max(0, [Math]::Min($CropX, $bmp.Width - 1))
      $cy = [Math]::Max(0, [Math]::Min($CropY, $bmp.Height - 1))
      $rect = New-Object System.Drawing.Rectangle $cx, $cy,
        ([Math]::Min($CropW, $bmp.Width - $cx)), ([Math]::Min($CropH, $bmp.Height - $cy))
      $target = $bmp.Clone($rect, $bmp.PixelFormat)
    }
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $path = if ([System.IO.Path]::IsPathRooted($Out)) { $Out } else { Join-Path $PSScriptRoot $Out }
    $target.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "SAVED $path ($($target.Width)x$($target.Height), via $method)"
    $bmp.Dispose()
    if ($target -ne $bmp) { $target.Dispose() }
  }
  'focus' { Write-Output "FOCUSED hwnd=$h (foreground=$([Win32Api]::GetForegroundWindow()))" }
  'release' { [void][Win32Api]::ReleaseTopmost($h); Write-Output 'RELEASED_TOPMOST' }
}
