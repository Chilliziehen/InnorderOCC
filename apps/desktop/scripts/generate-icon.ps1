$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$mark = @(
  ".......##.......",
  "......###.......",
  "...##########...",
  "...##...........",
  "..###..######...",
  "..##.....##.....",
  ".###....##......",
  ".##...########..",
  ".##......##.....",
  ".##......##.....",
  ".##......##.....",
  ".##......##.....",
  ".##..######.....",
  ".##....###......",
  ".......##.......",
  "................"
)

function New-IconLayer([int]$size) {
  $stream = [System.IO.MemoryStream]::new()
  $writer = [System.IO.BinaryWriter]::new($stream)
  $maskStride = [int]([Math]::Ceiling($size / 32.0) * 4)

  $writer.Write([uint32]40)
  $writer.Write([int32]$size)
  $writer.Write([int32]($size * 2))
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]0)
  $writer.Write([uint32]($size * $size * 4))
  $writer.Write([int32]0)
  $writer.Write([int32]0)
  $writer.Write([uint32]0)
  $writer.Write([uint32]0)

  for ($y = $size - 1; $y -ge 0; $y--) {
    $sourceY = [Math]::Min(15, [int][Math]::Floor($y * 16 / $size))
    for ($x = 0; $x -lt $size; $x++) {
      $sourceX = [Math]::Min(15, [int][Math]::Floor($x * 16 / $size))
      if ($mark[$sourceY][$sourceX] -eq "#") {
        $red, $green, $blue = 255, 255, 255
      } elseif ($sourceX -eq 0 -or $sourceX -eq 15 -or $sourceY -eq 0 -or $sourceY -eq 15) {
        $red, $green, $blue = 32, 40, 42
      } else {
        $red, $green, $blue = 0, 143, 131
      }
      $writer.Write([byte]$blue)
      $writer.Write([byte]$green)
      $writer.Write([byte]$red)
      $writer.Write([byte]255)
    }
  }

  $writer.Write([byte[]]::new($maskStride * $size))
  $writer.Flush()
  $bytes = $stream.ToArray()
  $writer.Dispose()
  $stream.Dispose()
  return $bytes
}

$layers = @($sizes | ForEach-Object { , (New-IconLayer $_) })
$outputDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../assets"))
[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$outputPath = Join-Path $outputDirectory "occ.ico"
$file = [System.IO.File]::Create($outputPath)
$icon = [System.IO.BinaryWriter]::new($file)

$icon.Write([uint16]0)
$icon.Write([uint16]1)
$icon.Write([uint16]$layers.Count)
$imageOffset = 6 + 16 * $layers.Count
for ($index = 0; $index -lt $layers.Count; $index++) {
  $size = $sizes[$index]
  $icon.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
  $icon.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
  $icon.Write([byte]0)
  $icon.Write([byte]0)
  $icon.Write([uint16]1)
  $icon.Write([uint16]32)
  $icon.Write([uint32]$layers[$index].Length)
  $icon.Write([uint32]$imageOffset)
  $imageOffset += $layers[$index].Length
}
foreach ($layer in $layers) {
  $icon.Write([byte[]]$layer)
}

$icon.Dispose()
$file.Dispose()
