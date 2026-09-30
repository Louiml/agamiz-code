param([string]$OutPath = 'D:\AgamizCode\ide-repo\src-tauri\shot.png')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Capture the whole virtual desktop.
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$w = $b.Width
$h = $b.Height
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $OutPath ($w x $h)"