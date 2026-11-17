# 一次性/可复用：把 public/avatars/*.png 与 public/logo.png 等比缩到长边 160px，重存 PNG。
# 缘起：头像原图严重超规格（mihu.png 曾 1440x1080 / 1.44MB），实际最大只显示 56px 圆形头像；
#       一屏头像 ~2.1MB，手机走 Cloudflare tunnel 首屏被拖慢——"员工头像要好一会才出来"。见 CHANGELOG / 复盘「隧道下首屏性能整备」。
# 零依赖：用 Windows 自带 System.Drawing（无需 ImageMagick/sharp/npm）。
# 幂等：长边 <= 目标值的图直接跳过——只缩不放大，重复跑不劣化已压过的图。
#
# 用法（在 office-lab/app 目录）：  powershell -NoProfile -File scripts/optimize-avatars.ps1 [-Max 160] [-WhatIf]
#   -WhatIf  只报告将如何缩、不写盘

param(
  [int]$Max = 160,
  [switch]$WhatIf
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

# 脚本目录：PS 5.1 用相对 -File 路径时 $PSScriptRoot 会为空，回退到 $MyInvocation 并转绝对路径
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent ([System.IO.Path]::GetFullPath($MyInvocation.MyCommand.Path)) }

# 目标文件：public/avatars/*.png + public/logo.png（相对本脚本 → ../public）
$pub = Join-Path $scriptDir '..\public'
$targets = @()
$targets += Get-ChildItem -Path (Join-Path $pub 'avatars') -Filter *.png -File
$logo = Join-Path $pub 'logo.png'
if (Test-Path $logo) { $targets += Get-Item $logo }

function Format-KB([long]$bytes) { '{0:N0}KB' -f [math]::Round($bytes / 1024) }

$totBefore = 0L; $totAfter = 0L; $touched = 0
Write-Host ("{0}缩图目标：长边 <= {1}px；共 {2} 个文件`n" -f $(if ($WhatIf) { '[WhatIf] ' } else { '' }), $Max, $targets.Count)

foreach ($f in $targets) {
  $before = $f.Length
  $totBefore += $before
  $img = [System.Drawing.Image]::FromFile($f.FullName)
  try {
    $w = $img.Width; $h = $img.Height
    $long = [math]::Max($w, $h)
    if ($long -le $Max) {
      Write-Host ("  skip  {0}  {1}x{2}  {3}  (已达标)" -f $f.Name, $w, $h, (Format-KB $before))
      $totAfter += $before
      continue
    }
    $scale = $Max / $long
    $nw = [math]::Max(1, [int][math]::Round($w * $scale))
    $nh = [math]::Max(1, [int][math]::Round($h * $scale))

    $bmp = New-Object System.Drawing.Bitmap $nw, $nh
    try {
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.DrawImage($img, 0, 0, $nw, $nh)
      } finally { $g.Dispose() }

      if ($WhatIf) {
        Write-Host ("  would  {0}  {1}x{2} -> {3}x{4}  ({5} → ~缩)" -f $f.Name, $w, $h, $nw, $nh, (Format-KB $before))
        $totAfter += $before
      } else {
        # 先写临时文件（System.Drawing 无法就地覆盖正打开的源），Dispose 源后再定夺
        $img.Dispose(); $img = $null
        $tmp = $f.FullName + '.tmp'
        $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        $newSize = (Get-Item $tmp).Length
        # 非劣化：System.Drawing 重存 32 位 RGBA PNG，对已高度优化的小图（如索引色）可能反而更大——那就保留原图
        if ($newSize -ge $before) {
          Remove-Item -Force $tmp
          Write-Host ("  keep  {0}  {1}x{2}  {3}  (缩后 {4} 更大，保留原图)" -f $f.Name, $w, $h, (Format-KB $before), (Format-KB $newSize))
          $totAfter += $before
        } else {
          Move-Item -Force $tmp $f.FullName
          $totAfter += $newSize
          $touched++
          Write-Host ("  done  {0}  {1}x{2} -> {3}x{4}  {5} → {6}  (省 {7})" -f $f.Name, $w, $h, $nw, $nh, (Format-KB $before), (Format-KB $newSize), (Format-KB ($before - $newSize)))
        }
      }
    } finally { $bmp.Dispose() }
  } finally { if ($img) { $img.Dispose() } }
}

Write-Host ("`n{0}：{1}/{2} 个已缩；总计 {3} → {4}，省 {5}" -f $(if ($WhatIf) { '[WhatIf] 预计' } else { '完成' }), $touched, $targets.Count, (Format-KB $totBefore), (Format-KB $totAfter), (Format-KB ($totBefore - $totAfter)))
