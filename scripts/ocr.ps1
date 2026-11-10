# Windows 自带 OCR（零 token、离线）：批量识别目录里的图片，输出 JSON。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Dir <图片目录> -Out <ocr.json>
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 2000
)
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

function Await($task, $type) {
  $m = $asTask.MakeGenericMethod($type)
  $net = $m.Invoke($null, @($task))
  $net.Wait(-1) | Out-Null
  $net.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw "系统没有可用的 OCR 语言包（设置 → 时间和语言 → 语言 → 中文(简体) 的可选功能里安装“光学字符识别”）" }

$items = @()
$files = Get-ChildItem -LiteralPath $Dir -File | Where-Object { $_.Extension -match "^\.(jpg|jpeg|png|bmp|webp)$" } | Sort-Object Name
foreach ($f in $files) {
  try {
    $sf = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($f.FullName)) ([Windows.Storage.StorageFile])
    $stream = Await ($sf.OpenAsync(0)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @()
    foreach ($line in $result.Lines) { $lines += $line.Text }
    $items += [pscustomobject]@{ file = $f.Name; text = ($lines -join "`n") }
    $stream.Dispose()
  } catch {
    $items += [pscustomobject]@{ file = $f.Name; text = ""; error = "$($_.Exception.Message)" }
  }
}

$json = ConvertTo-Json -InputObject @($items) -Depth 4 -Compress
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("ocr: {0} files, {1} with text" -f $items.Count, (@($items | Where-Object { $_.text }).Count))
