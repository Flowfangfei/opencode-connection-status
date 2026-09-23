$ErrorActionPreference = 'Stop'
$viewer = Join-Path (Split-Path $PSScriptRoot -Parent) 'connmon.ps1'
$dir = Join-Path ([IO.Path]::GetTempPath()) ('connmon-test-' + [guid]::NewGuid().ToString('N'))
$file = Join-Path $dir 'status.jsonl'
New-Item -ItemType Directory -Path $dir | Out-Null
try {
  $time = [DateTime]::UtcNow.ToString('o')
  $oldTime = [DateTime]::UtcNow.AddHours(-1).ToString('o')
  $rows = @(
    [ordered]@{ t=$oldTime; sessionID='ses_old'; sessionTitle='old'; phase='idle'; wait='none'; event='session-error'; label='ancient'; parentID=''; isAgent=$false; thinking='' },
    [ordered]@{ t=$time; scope='connection'; sessionID='__connection__'; event='idle-probe-ok'; reachable=1; total=1; lastProbeAt=$time },
    [ordered]@{ t=$time; sessionID='ses_demo'; sessionTitle='演示会话'; phase='idle'; wait='none'; parentID=''; isAgent=$false; thinking='' },
    [ordered]@{ t=$time; sessionID='ses_demo'; sessionTitle='演示会话'; phase='idle'; wait='tool'; waitDetail='bash (npm test)'; event='wait-notice'; parentID=''; isAgent=$false; thinking='' }
  )
  $rows | ForEach-Object { $_ | ConvertTo-Json -Compress } | Set-Content -LiteralPath $file -Encoding UTF8
  $output = (& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $viewer -Once -StatusFile $file | Out-String)
  if ($LASTEXITCODE -ne 0) { throw 'Viewer exited with an error.' }
  if ($output -notmatch '端点可达 1/1') { throw 'Global probe header missing.' }
  if ($output -notmatch '长时间等待: bash \(npm test\)') { throw 'Wait event label was truncated.' }
  if ($output -match '会话 __connection__') { throw 'Global probe was rendered as a conversation.' }
  if ($output -match 'ancient') { throw 'Stale event was shown in the recent list.' }
  Write-Host 'PASS  connmon renders global probe and complete wait event'
} finally {
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $dir -Force -ErrorAction SilentlyContinue
}
