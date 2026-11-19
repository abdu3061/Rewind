$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDirectory = Join-Path $PSScriptRoot '../apps/desktop/assets'
New-Item -ItemType Directory -Force -Path $assetDirectory | Out-Null
$images = @()
foreach ($size in @(16, 32, 48, 256)) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.ScaleTransform($size / 256.0, $size / 256.0)
  $background = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#315f9c'))
  $foreground = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $graphics.FillEllipse($background, 4, 4, 248, 248)
  foreach ($offset in @(0, 84)) {
    $points = [System.Drawing.PointF[]]@(
      (New-Object System.Drawing.PointF((42 + $offset), 128)),
      (New-Object System.Drawing.PointF((126 + $offset), 72)),
      (New-Object System.Drawing.PointF((126 + $offset), 184))
    )
    $graphics.FillPolygon($foreground, $points)
  }
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $images += ,$stream.ToArray()
  if ($size -eq 256) { $bitmap.Save((Join-Path $assetDirectory 'rewind.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $stream.Dispose()
  $graphics.Dispose()
  $background.Dispose()
  $foreground.Dispose()
  $bitmap.Dispose()
}
$file = [System.IO.File]::Create((Join-Path $assetDirectory 'rewind.ico'))
$writer = New-Object System.IO.BinaryWriter($file)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$images.Count)
  $offset = 6 + (16 * $images.Count)
  $sizes = @(16, 32, 48, 0)
  for ($index = 0; $index -lt $images.Count; $index++) {
    $writer.Write([byte]$sizes[$index]); $writer.Write([byte]$sizes[$index])
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$index].Length); $writer.Write([uint32]$offset)
    $offset += $images[$index].Length
  }
  foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
} finally { $writer.Dispose(); $file.Dispose() }
