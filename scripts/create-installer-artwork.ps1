$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SunifyNativeIcon {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr hIcon);
}
'@

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null

function New-RgbBitmap([int]$Width, [int]$Height) {
  return [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
}

function Draw-SunMark($Graphics, [float]$CenterX, [float]$CenterY, [float]$Radius, $CoreColor, $RayColor, [float]$RayWidth) {
  $pen = [System.Drawing.Pen]::new($RayColor, $RayWidth)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  for ($index = 0; $index -lt 8; $index++) {
    $angle = [Math]::PI * $index / 4
    $inner = $Radius * 1.38
    $outer = $Radius * 1.78
    $Graphics.DrawLine($pen,
      [single]($CenterX + [Math]::Cos($angle) * $inner), [single]($CenterY + [Math]::Sin($angle) * $inner),
      [single]($CenterX + [Math]::Cos($angle) * $outer), [single]($CenterY + [Math]::Sin($angle) * $outer))
  }
  $pen.Dispose()
  $brush = [System.Drawing.SolidBrush]::new($CoreColor)
  $Graphics.FillEllipse($brush, $CenterX - $Radius, $CenterY - $Radius, $Radius * 2, $Radius * 2)
  $brush.Dispose()
}

# App and installer icon: warm violet/magenta sunmark on a rounded dark-violet tile.
$iconBitmap = New-RgbBitmap 256 256
$graphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(16, 14, 25))
$tile = [System.Drawing.Drawing2D.GraphicsPath]::new()
$diameter = 224.0; $left = 16.0; $top = 16.0; $corner = 48.0
$tile.AddArc($left, $top, $corner, $corner, 180, 90)
$tile.AddArc($left + $diameter - $corner, $top, $corner, $corner, 270, 90)
$tile.AddArc($left + $diameter - $corner, $top + $diameter - $corner, $corner, $corner, 0, 90)
$tile.AddArc($left, $top + $diameter - $corner, $corner, $corner, 90, 90)
$tile.CloseFigure()
$tileBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.Point]::new(18, 20), [System.Drawing.Point]::new(236, 238), [System.Drawing.Color]::FromArgb(196, 65, 206), [System.Drawing.Color]::FromArgb(97, 74, 232))
$graphics.FillPath($tileBrush, $tile)
Draw-SunMark $graphics 128 128 39 ([System.Drawing.Color]::White) ([System.Drawing.Color]::White) 8
$iconPath = Join-Path $build 'sunify.ico'
$iconHandle = $iconBitmap.GetHicon()
try {
  $icon = [System.Drawing.Icon]::FromHandle($iconHandle)
  $stream = [System.IO.File]::Create($iconPath)
  try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose() }
} finally {
  [SunifyNativeIcon]::DestroyIcon($iconHandle) | Out-Null
  $tileBrush.Dispose(); $tile.Dispose(); $graphics.Dispose(); $iconBitmap.Dispose()
}

# NSIS wizard sidebar artwork.
$sidebar = New-RgbBitmap 164 314
$graphics = [System.Drawing.Graphics]::FromImage($sidebar)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.Point]::new(0, 0), [System.Drawing.Point]::new(164, 314), [System.Drawing.Color]::FromArgb(18, 16, 28), [System.Drawing.Color]::FromArgb(44, 23, 53))
$graphics.FillRectangle($gradient, 0, 0, 164, 314)
$glow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(28, 177, 74, 228))
$graphics.FillEllipse($glow, 28, 21, 112, 112)
Draw-SunMark $graphics 84 76 20 ([System.Drawing.Color]::White) ([System.Drawing.Color]::White) 4
$titleFont = [System.Drawing.Font]::new('Segoe UI', 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$centerFormat = [System.Drawing.StringFormat]::new()
$centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
$centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(197, 188, 208))
$graphics.DrawString('Sunify', $titleFont, $white, [System.Drawing.RectangleF]::new(10, 148, 144, 34), $centerFormat)
$bodyFont = [System.Drawing.Font]::new('Segoe UI', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString("Müziğini keşfet.`r`nSözlerle eşlik et.`r`nKendi ritmini bul.", $bodyFont, $muted, [System.Drawing.RectangleF]::new(12, 190, 140, 70), $centerFormat)
$smallAccent = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(191, 94, 226))
$graphics.FillEllipse($smallAccent, 76, 279, 12, 12)
$sidebarPath = Join-Path $build 'installer-sidebar.bmp'
$sidebar.Save($sidebarPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$smallAccent.Dispose(); $muted.Dispose(); $white.Dispose(); $bodyFont.Dispose(); $centerFormat.Dispose(); $titleFont.Dispose(); $glow.Dispose(); $gradient.Dispose(); $graphics.Dispose(); $sidebar.Dispose()

# Wizard header, deliberately restrained to keep the step title readable.
$header = New-RgbBitmap 150 57
$graphics = [System.Drawing.Graphics]::FromImage($header)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(18, 16, 28))
Draw-SunMark $graphics 31 28 9 ([System.Drawing.Color]::White) ([System.Drawing.Color]::FromArgb(207, 162, 255)) 2
$headerFont = [System.Drawing.Font]::new('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$headerBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$graphics.DrawString('SUNIFY', $headerFont, $headerBrush, 49, 18)
$header.Save((Join-Path $build 'installer-header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$headerBrush.Dispose(); $headerFont.Dispose(); $graphics.Dispose(); $header.Dispose()

Write-Host "Sunify installer artwork created in $build"
