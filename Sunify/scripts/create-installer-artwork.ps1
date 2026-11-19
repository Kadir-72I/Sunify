$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

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

function New-RoundedPath([System.Drawing.RectangleF]$Bounds, [float]$Radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $Radius * 2
  $path.AddArc($Bounds.X, $Bounds.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($Bounds.Right - $diameter, $Bounds.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($Bounds.Right - $diameter, $Bounds.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($Bounds.X, $Bounds.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

# App, shortcut, and setup icon: use the exact artwork supplied for Sunify.
$iconSourcePath = Join-Path $build 'sunify-icon-source.png'
if (-not (Test-Path -LiteralPath $iconSourcePath)) { throw "Sunify icon artwork was not found: $iconSourcePath" }
$iconSource = [System.Drawing.Image]::FromFile($iconSourcePath)
$iconSizes = @(256, 128, 64, 48, 32, 16)
$iconImages = @()
try {
  foreach ($size in $iconSizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $imageGraphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $imageGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $imageGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $imageGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $imageGraphics.DrawImage($iconSource, 0, 0, $size, $size)
    $imageGraphics.Dispose()
    $pngStream = [System.IO.MemoryStream]::new()
    $bitmap.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
    $iconImages += ,@{ Size = $size; Data = $pngStream.ToArray() }
    $pngStream.Dispose()
    $bitmap.Dispose()
  }

  $iconPath = Join-Path $build 'sunify.ico'
  $iconStream = [System.IO.File]::Create($iconPath)
  $writer = [System.IO.BinaryWriter]::new($iconStream)
  try {
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$iconImages.Count)
    $dataOffset = 6 + (16 * $iconImages.Count)
    foreach ($entry in $iconImages) {
      $dimension = if ($entry.Size -eq 256) { [byte]0 } else { [byte]$entry.Size }
      $writer.Write($dimension)
      $writer.Write($dimension)
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([UInt16]1)
      $writer.Write([UInt16]32)
      $writer.Write([UInt32]$entry.Data.Length)
      $writer.Write([UInt32]$dataOffset)
      $dataOffset += $entry.Data.Length
    }
    foreach ($entry in $iconImages) { $writer.Write([byte[]]$entry.Data) }
  } finally {
    $writer.Dispose()
    $iconStream.Dispose()
  }
} finally {
  $iconSource.Dispose()
}

# NSIS wizard sidebar artwork.
$sidebar = New-RgbBitmap 164 314
$graphics = [System.Drawing.Graphics]::FromImage($sidebar)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.Point]::new(0, 0), [System.Drawing.Point]::new(164, 314), [System.Drawing.Color]::FromArgb(21, 20, 29), [System.Drawing.Color]::FromArgb(48, 31, 58))
$graphics.FillRectangle($gradient, 0, 0, 164, 314)
$glow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(35, 161, 119, 255))
$graphics.FillEllipse($glow, 28, 21, 112, 112)
$glassPath = New-RoundedPath ([System.Drawing.RectangleF]::new(5, 5, 154, 304)) 16
$glassFill = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(18, 255, 255, 255))
$glassBorder = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(82, 238, 228, 255), 1)
$graphics.FillPath($glassFill, $glassPath)
$graphics.DrawPath($glassBorder, $glassPath)
Draw-SunMark $graphics 84 76 20 ([System.Drawing.Color]::White) ([System.Drawing.Color]::White) 4
$titleFont = [System.Drawing.Font]::new('Segoe UI', 19, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$centerFormat = [System.Drawing.StringFormat]::new()
$centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
$centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(197, 188, 208))
$graphics.DrawString('Sunify', $titleFont, $white, [System.Drawing.RectangleF]::new(10, 148, 144, 34), $centerFormat)
$bodyFont = [System.Drawing.Font]::new('Segoe UI', 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString(("M{0}zi{1}ini ke{2}fet.`r`nS{3}zlerle e{2}lik et.`r`nKendi ritmini bul." -f [char]0xFC, [char]0x11F, [char]0x15F, [char]0xF6), $bodyFont, $muted, [System.Drawing.RectangleF]::new(12, 190, 140, 70), $centerFormat)
$smallAccent = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(181, 137, 255))
$graphics.FillEllipse($smallAccent, 76, 279, 12, 12)
$sidebarPath = Join-Path $build 'installer-sidebar.bmp'
$sidebar.Save($sidebarPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$glassBorder.Dispose(); $glassFill.Dispose(); $glassPath.Dispose(); $smallAccent.Dispose(); $muted.Dispose(); $white.Dispose(); $bodyFont.Dispose(); $centerFormat.Dispose(); $titleFont.Dispose(); $glow.Dispose(); $gradient.Dispose(); $graphics.Dispose(); $sidebar.Dispose()

# Wizard header, deliberately restrained to keep the step title readable.
$header = New-RgbBitmap 150 57
$graphics = [System.Drawing.Graphics]::FromImage($header)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$headerGradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.Point]::new(0, 0), [System.Drawing.Point]::new(150, 57), [System.Drawing.Color]::FromArgb(24, 22, 32), [System.Drawing.Color]::FromArgb(53, 35, 65))
$graphics.FillRectangle($headerGradient, 0, 0, 150, 57)
$headerBorder = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(74, 238, 228, 255), 1)
$graphics.DrawRectangle($headerBorder, 1, 1, 147, 54)
Draw-SunMark $graphics 31 28 9 ([System.Drawing.Color]::White) ([System.Drawing.Color]::FromArgb(207, 162, 255)) 2
$headerFont = [System.Drawing.Font]::new('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$headerBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$graphics.DrawString('SUNIFY', $headerFont, $headerBrush, 49, 18)
$header.Save((Join-Path $build 'installer-header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$headerBorder.Dispose(); $headerGradient.Dispose(); $headerBrush.Dispose(); $headerFont.Dispose(); $graphics.Dispose(); $header.Dispose()

Write-Host "Sunify installer artwork created in $build"
