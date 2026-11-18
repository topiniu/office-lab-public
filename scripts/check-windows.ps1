# Validate the shipped Windows scripts and migration without touching the user's profile.
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ('ol-windows-' + [Guid]::NewGuid().ToString('N'))
$TestProfile = Join-Path $TestRoot 'isolated-profile'
New-Item -ItemType Directory -Path $TestProfile -Force | Out-Null

function Invoke-Migration([string]$Script, [string[]]$Parameters) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $PowerShell
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Script) + $Parameters
  $start.Arguments = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.EnvironmentVariables['USERPROFILE'] = $TestProfile
  $process = [Diagnostics.Process]::Start($start)
  $output = $process.StandardOutput.ReadToEndAsync()
  $errors = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(120000)) { $process.Kill(); throw "Migration timed out: $Script" }
  if ($process.ExitCode -ne 0) { throw ($output.Result + $errors.Result) }
  Write-Host $output.Result
}

function Assert-Restored([string]$Office) {
  foreach ($relative in @('tasks\migration-smoke.md', 'memories\feifei.md', 'app\uploads\migration-smoke.txt')) {
    $content = Get-Content (Join-Path $Office $relative) -Raw -Encoding UTF8
    if ($content.Trim() -ne 'OFFICE_LAB_MIGRATION_OK') { throw "Missing migrated data: $relative" }
  }
  $registry = Get-Content (Join-Path $Office 'app\runs\index.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($registry.smoke -ne 'OFFICE_LAB_MIGRATION_OK') { throw 'Registry was not restored' }
}

try {
  $scripts = @(Get-ChildItem (Join-Path $Repo 'tray') -Filter '*.ps1' -Recurse)
  $scripts += Get-ChildItem (Join-Path $Repo 'scripts') -Filter '*.ps1'
  foreach ($script in $scripts) {
    $tokens = $null; $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
    if ($script.Name -ne 'check-windows.ps1') {
      $bytes = [IO.File]::ReadAllBytes($script.FullName)
      if ($bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
        throw "Windows PowerShell 5.1 requires the original UTF-8 BOM: $($script.Name)"
      }
    }
  }
  & $PowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Repo 'tray\test\tray-logic.tests.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'Tray decision tests failed' }

  $source = Join-Path $TestRoot 'source workspace\office-lab'
  & git clone --quiet --no-hardlinks $Repo $source
  if ($LASTEXITCODE -ne 0) { throw 'Fixture clone failed' }
  foreach ($relative in @('tasks\migration-smoke.md', 'memories\feifei.md', 'app\uploads\migration-smoke.txt')) {
    $file = Join-Path $source $relative
    New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force | Out-Null
    Set-Content $file 'OFFICE_LAB_MIGRATION_OK' -Encoding UTF8
  }
  New-Item -ItemType Directory -Path (Join-Path $source 'app\runs') -Force | Out-Null
  Set-Content (Join-Path $source 'app\runs\index.json') '{"smoke":"OFFICE_LAB_MIGRATION_OK"}' -Encoding UTF8

  $pack = Join-Path $source 'scripts\迁移打包.ps1'
  $dataPack = Join-Path $TestRoot 'data package'
  Invoke-Migration $pack @('-Dest', $dataPack, '-DataOnly', '-Force')
  $dataWorkspace = Join-Path $TestRoot 'restored data'
  $dataOffice = Join-Path $dataWorkspace 'office-lab'
  & git clone --quiet --no-hardlinks $source $dataOffice
  if ($LASTEXITCODE -ne 0) { throw 'Target clone failed' }
  Invoke-Migration (Join-Path $dataPack '迁移恢复.ps1') @('-WorkspaceRoot', $dataWorkspace, '-SkipWecom')
  Assert-Restored $dataOffice

  $fullPack = Join-Path $TestRoot 'full package'
  Invoke-Migration $pack @('-Dest', $fullPack, '-SkipNodeModules', '-Force')
  $fullWorkspace = Join-Path $TestRoot 'restored full'
  Invoke-Migration (Join-Path $fullPack '迁移恢复.ps1') @('-WorkspaceRoot', $fullWorkspace, '-SkipWecom')
  Assert-Restored (Join-Path $fullWorkspace 'office-lab')
  Write-Host 'Windows scripts, tray decisions and both migration round trips passed.'
} finally {
  Remove-Item $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
}
