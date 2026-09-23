param(
  [string]$ConfigRoot = (Join-Path $env:USERPROFILE '.config\opencode')
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path $PSScriptRoot -Parent
$pluginDir = Join-Path $ConfigRoot 'plugin'
New-Item -ItemType Directory -Path $pluginDir -Force | Out-Null

$files = @(
  @{ Source = (Join-Path $sourceRoot 'connection-status.ts'); Target = (Join-Path $pluginDir 'connection-status.ts') },
  @{ Source = (Join-Path $sourceRoot 'retry-forever.ts'); Target = (Join-Path $pluginDir 'retry-forever.ts') },
  @{ Source = (Join-Path $sourceRoot 'connmon.ps1'); Target = (Join-Path $ConfigRoot 'connmon.ps1') }
)

$backupDir = Join-Path $env:USERPROFILE ('.cache\opencode\connection-status\backup\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$backedUp = $false
foreach ($item in $files) {
  if (-not (Test-Path -LiteralPath $item.Source)) { throw "Missing source: $($item.Source)" }
  $sourceHash = (Get-FileHash -LiteralPath $item.Source -Algorithm SHA256).Hash
  $targetExists = Test-Path -LiteralPath $item.Target
  $targetHash = if ($targetExists) { (Get-FileHash -LiteralPath $item.Target -Algorithm SHA256).Hash } else { '' }
  if ($sourceHash -eq $targetHash) {
    Write-Host "Already current: $($item.Target)"
    continue
  }
  if ($targetExists) {
    if (-not $backedUp) { New-Item -ItemType Directory -Path $backupDir -Force | Out-Null; $backedUp = $true }
    Copy-Item -LiteralPath $item.Target -Destination (Join-Path $backupDir ([IO.Path]::GetFileName($item.Target)))
  }
  Copy-Item -LiteralPath $item.Source -Destination $item.Target -Force
  if ((Get-FileHash -LiteralPath $item.Target -Algorithm SHA256).Hash -ne $sourceHash) {
    throw "Hash mismatch after copy: $($item.Target)"
  }
  Write-Host "Installed: $($item.Target)"
}
if ($backedUp) { Write-Host "Previous copies: $backupDir" }
Write-Host 'Restart OpenCode to load updated plugin code.'
