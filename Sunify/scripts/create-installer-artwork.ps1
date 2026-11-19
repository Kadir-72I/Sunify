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

# NSIS wizard sidebar artwork (Modern Liquid Glass Amethyst).
$sidebar = New-RgbBitmap 164 314
$graphics = [System.Drawing.Graphics]::FromImage($sidebar)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$gradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Point]::new(0, 0),
  [System.Drawing.Point]::new(164, 314),
  [System.Drawing.Color]::FromArgb(14, 12, 23),
  [System.Drawing.Color]::FromArgb(34, 21, 56)
)
$graphics.FillRectangle($gradient, 0, 0, 164, 314)

# Ambient radial glows
$glow1 = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(52, 167, 139, 250))
$graphics.FillEllipse($glow1, 18, 18, 128, 128)
$glow2 = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(26, 236, 72, 153))
$graphics.FillEllipse($glow2, -20, 200, 140, 140)

# Outer glass card
$glassPath = New-RoundedPath ([System.Drawing.RectangleF]::new(7, 7, 150, 300)) 18
$glassFill = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(16, 255, 255, 255))
$glassBorder = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(68, 224, 212, 255), 1.2)
$graphics.FillPath($glassFill, $glassPath)
$graphics.DrawPath($glassBorder, $glassPath)

# Icon badge circle + Sunify app icon
$badgeFill = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(34, 167, 139, 250))
$badgeBorder = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(120, 196, 181, 253), 1.2)
$graphics.FillEllipse($badgeFill, 46, 34, 72, 72)
$graphics.DrawEllipse($badgeBorder, 46, 34, 72, 72)
$iconForSidebar = [System.Drawing.Image]::FromFile($iconSourcePath)
$graphics.DrawImage($iconForSidebar, 56, 44, 52, 52)
$iconForSidebar.Dispose()

$titleFont = [System.Drawing.Font]::new('Segoe UI', 21, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$centerFormat = [System.Drawing.StringFormat]::new()
$centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
$centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(208, 199, 226))
$graphics.DrawString('Sunify', $titleFont, $white, [System.Drawing.RectangleF]::new(10, 120, 144, 32), $centerFormat)

# Version pill
$pillPath = New-RoundedPath ([System.Drawing.RectangleF]::new(44, 156, 76, 20)) 10
$pillFill = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(46, 167, 139, 250))
$pillBorder = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(110, 196, 181, 253), 1)
$graphics.FillPath($pillFill, $pillPath)
$graphics.DrawPath($pillBorder, $pillPath)
$pillFont = [System.Drawing.Font]::new('Segoe UI', 10, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString('DESKTOP', $pillFont, $white, [System.Drawing.RectangleF]::new(44, 156, 76, 20), $centerFormat)

$bodyFont = [System.Drawing.Font]::new('Segoe UI', 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$graphics.DrawString(("M{0}zi{1}ini ke{2}fet.`r`nS{3}zlerle e{2}lik et.`r`nKendi ritmini bul." -f [char]0xFC, [char]0x11F, [char]0x15F, [char]0xF6), $bodyFont, $muted, [System.Drawing.RectangleF]::new(12, 188, 140, 66), $centerFormat)

# Mini equalizer bars at bottom
$eqBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(190, 167, 139, 250))
$eqHeights = @(10, 18, 24, 14, 22, 16, 11)
for ($i = 0; $i -lt $eqHeights.Count; $i++) {
  $bx = 53 + ($i * 9)
  $bh = $eqHeights[$i]
  $by = 286 - $bh
  $eqPath = New-RoundedPath ([System.Drawing.RectangleF]::new($bx, $by, 4.5, $bh)) 2
  $graphics.FillPath($eqBrush, $eqPath)
  $eqPath.Dispose()
}

$sidebarPath = Join-Path $build 'installer-sidebar.bmp'
$sidebar.Save($sidebarPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
$eqBrush.Dispose(); $pillFont.Dispose(); $pillBorder.Dispose(); $pillFill.Dispose(); $pillPath.Dispose()
$badgeBorder.Dispose(); $badgeFill.Dispose(); $glassBorder.Dispose(); $glassFill.Dispose(); $glassPath.Dispose()
$muted.Dispose(); $white.Dispose(); $bodyFont.Dispose(); $centerFormat.Dispose(); $titleFont.Dispose()
$glow2.Dispose(); $glow1.Dispose(); $gradient.Dispose(); $graphics.Dispose(); $sidebar.Dispose()

# Wizard header (150x57) matching Liquid Glass Dark theme
$header = New-RgbBitmap 150 57
$graphics = [System.Drawing.Graphics]::FromImage($header)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$headerGradient = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Point]::new(0, 0),
  [System.Drawing.Point]::new(150, 57),
  [System.Drawing.Color]::FromArgb(18, 15, 29),
  [System.Drawing.Color]::FromArgb(40, 26, 62)
)
$graphics.FillRectangle($headerGradient, 0, 0, 150, 57)
$headerGlow = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(38, 167, 139, 250))
$graphics.FillEllipse($headerGlow, 10, 6, 44, 44)
$iconForHeader = [System.Drawing.Image]::FromFile($iconSourcePath)
$graphics.DrawImage($iconForHeader, 18, 14, 28, 28)
$iconForHeader.Dispose()

$headerFont = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$headerBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$graphics.DrawString('SUNIFY', $headerFont, $headerBrush, 52, 19)
$accentLine = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(140, 167, 139, 250), 2)
$graphics.DrawLine($accentLine, 0, 56, 150, 56)

$header.Save((Join-Path $build 'installer-header.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$accentLine.Dispose(); $headerGlow.Dispose(); $headerGradient.Dispose(); $headerBrush.Dispose(); $headerFont.Dispose(); $graphics.Dispose(); $header.Dispose()

Write-Host "Sunify installer artwork created in $build"
