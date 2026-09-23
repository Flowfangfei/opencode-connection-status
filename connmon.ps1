# connection-status TUI viewer
# Usage:  connmon              # live view, refreshes every second
#         connmon -Once        # print one snapshot and exit
#         connmon -IntervalSec 2
# Data:   ~\.cache\opencode\connection-status\status.jsonl (written by the plugin)
param(
  [switch]$Once,
  [int]$IntervalSec = 1,
  [switch]$All,
  [string]$StatusFile
)

$ErrorActionPreference = "Stop"
# Block glyphs (█▒▓) need UTF-8 console output; PS 5.1 defaults to the ANSI
# codepage, which silently replaces them with U+FFFD.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$File = if ($StatusFile) { $StatusFile } else { Join-Path $env:USERPROFILE ".cache\opencode\connection-status\status.jsonl" }

$WaitLabel = @{
  model      = "模型思考/响应"
  tool       = "工具执行"
  subtask    = "子代理"
  compaction = "上下文压缩"
  retry      = "供应商重试"
  none       = "-"
}

# Seg/Line use PSCustomObject because PowerShell's @() unrolls nested arrays
# unpredictably at call sites; objects survive every wrapping combination.
function Seg([string]$text, [string]$color = "White") {
  [pscustomobject]@{ T = $text; C = $color }
}

# Line collects ALL positional Seg args via $args — a typed param would silently
# drop everything after the first. When called with a single array argument
# (Line $segArray), $args = @(array) — unwrap that one level.
function Line {
  if ($args.Count -eq 1 -and $args[0] -is [array]) { return ,@($args[0]) }
  ,@($args)
}

function Format-Span([int]$sec) {
  if ($sec -ge 3600) {
    $h = [int][math]::Floor($sec / 3600)
    $m = [int][math]::Floor(($sec % 3600) / 60)
    return "{0}h{1}m" -f $h, $m
  }
  if ($sec -ge 60) {
    $m = [int][math]::Floor($sec / 60)
    $s = $sec % 60
    return "{0}m{1}s" -f $m, $s
  }
  return "${sec}s"
}

function Shorten([string]$value, [int]$limit) {
  $value = $value -replace '\s+', ' '
  if ($value.Length -le $limit) { return $value }
  return $value.Substring(0, $limit - 1) + '…'
}

function Get-Snapshot {
  if (-not (Test-Path $File)) { return $null }
  # Explicit UTF-8: the plugin writes UTF-8; PS 5.1 (which connmon.cmd invokes)
  # defaults to the ANSI codepage and would mojibake every Chinese title.
  $lines = @(Get-Content $File -Tail 600 -Encoding UTF8 -ErrorAction SilentlyContinue)
  if ($lines.Count -eq 0) { return $null }

  $events = @($lines | ForEach-Object {
    try { $_ | ConvertFrom-Json } catch { $null }
  } | Where-Object { $_ -ne $null })

  if ($events.Count -eq 0) { return $null }

  $connection = @($events | Where-Object { $_.scope -eq 'connection' } | Select-Object -Last 1)
  $sessionEvents = @($events | Where-Object { $_.scope -ne 'connection' })

  # Group samples by session. Subagents (isAgent) are nested under their parent
  # so each conversation renders as one panel with its agents indented below.
  # Plain arrays + foreach statement: generic Lists and ForEach-Object with
  # hashtable lookups throw "Argument types do not match" on PS 5.1.
  $bySession = @{}
  foreach ($e in $sessionEvents) {
    $sid = [string]$e.sessionID
    if (-not $bySession.ContainsKey($sid)) { $bySession[$sid] = @() }
    $bySession[$sid] = $bySession[$sid] + $e
  }

  # Build per-session views, ordered by most recent activity.
  $panels = foreach ($sid in @($bySession.Keys)) {
    $samples = [object[]]$bySession[[string]$sid]
    $last = $samples[-1]
    $parent = if ($last.isAgent -and $last.parentID) { [string]$last.parentID } else { $null }
    [pscustomobject]@{
      SessionID = [string]$sid
      Title     = if ($last.sessionTitle) { [string]$last.sessionTitle } else { "" }
      IsAgent   = [bool]$last.isAgent
      ParentID  = $parent
      Last      = $last
      Samples   = $samples
      LastT     = [datetime]$last.t
    }
  }
  $panels = @($panels | Where-Object { $All -or $_.LastT -ge (Get-Date).AddMinutes(-10) } | Sort-Object LastT -Descending)

  # Attach agent panels to their parent conversation. Plain arrays throughout:
  # generic List + string concat throws "Argument types do not match" on PS 5.1.
  # A session whose parentID equals its own id is a root, not an agent (data
  # quirk observed from session.list()).
  $roots = @()
  foreach ($p in $panels) {
    if ($p.IsAgent -and $p.ParentID -ne $p.SessionID) {
      $root = $panels | Where-Object { $_.SessionID -eq $p.ParentID } | Select-Object -First 1
      if ($root) {
        if (-not $root.PSObject.Properties["Agents"]) {
          $root | Add-Member -NotePropertyName Agents -NotePropertyValue @()
        }
        $root.Agents = @($root.Agents) + $p
        continue
      }
    }
    $roots = @($roots) + $p
  }

  $cutoff = (Get-Date).AddMinutes(-10)
  $notable = @($events | Where-Object {
    $_.event -and $_.event -notin @('stalled', 'idle-probe-ok', 'connection-configured') -and
    ($All -or ([datetime]$_.t) -ge $cutoff)
  } | Select-Object -Last 6)

  [pscustomobject]@{
    Panels  = if ($All) { $roots } else { @($roots | Select-Object -First 5) }
    Events  = $notable
    Connection = if ($connection.Count) { $connection[-1] } else { $null }
    Hidden = if ($All) { 0 } else { [math]::Max(0, $roots.Count - 5) }
    AgeSec  = [int](([DateTime]::Now) - [datetime]$events[-1].t).TotalSeconds
  }
}

function Format-Activity($samples) {
  # Time-weighted phase shares over this session's own samples, in Chinese.
  if ($samples.Count -lt 2) { return $null }
  $spans = @{}
  for ($i = 1; $i -lt $samples.Count; $i++) {
    $dt = ([datetime]$samples[$i].t - [datetime]$samples[$i-1].t).TotalSeconds
    if ($dt -lt 0) { $dt = 0 }
    if ($dt -gt 300) { $dt = 300 }
    $p = [string]$samples[$i-1].phase
    $prev = 0
    if ($spans.ContainsKey($p)) { $prev = $spans[$p] }
    $spans[$p] = $prev + $dt
  }
  $total = ($spans.Values | Measure-Object -Sum).Sum
  if ($total -le 0) { return $null }
  $zh = @{ streaming = "输出"; waiting = "等待"; stalled = "静默"; down = "中断"; idle = "空闲" }
  $parts = @()
  $order = @("streaming", "waiting", "stalled", "down", "idle")
  foreach ($p in $order) {
    if (-not $spans.ContainsKey($p) -or $spans[$p] -lt 1) { continue }
    $parts += "$($zh[$p]) $([int][math]::Round(100 * $spans[$p] / $total))%"
  }
  return ($parts -join " · ")
}

function Format-Timeline($samples) {
  # Phase glyphs over this session's last 30 samples.
  $glyphMap = @{
    streaming = @([string][char]0x2588, "Green")
    waiting   = @([string][char]0x2592, "Cyan")
    stalled   = @([string][char]0x2593, "Yellow")
    down      = @("X", "Red")
    idle      = @("_", "DarkGray")
  }
  $segs = New-Object System.Collections.Generic.List[object]
  [void]$segs.Add((Seg "  " "Gray"))
  foreach ($s in @($samples | Select-Object -Last 24)) {
    $g = $glyphMap[[string]$s.phase]
    if (-not $g) { $g = @("?", "DarkGray") }
    [void]$segs.Add((Seg $g[0] $g[1]))
  }
  return $segs.ToArray()
}

function Build-SessionPanel($panel, $thin) {
  $lines = New-Object System.Collections.Generic.List[object]
  $last = $panel.Last

  # Panel header: title + short id + agent marker
  $shortID = if ($panel.SessionID) { $panel.SessionID.Substring(0, [Math]::Min(8, $panel.SessionID.Length)) } else { "legacy" }
  $name = if ($panel.Title) { Shorten $panel.Title 24 } else { "会话 $shortID" }
  $tag = if ($panel.IsAgent) { " [agent]" } else { "" }
  $age = [int](([DateTime]::Now) - $panel.LastT).TotalSeconds
  $ageC = if ($age -gt 60) { "DarkGray" } else { "DarkCyan" }

  [void]$lines.Add((Line (Seg "  ▸ " "DarkGray") (Seg $name "White") (Seg $tag "Magenta") (Seg "  ($shortID" "DarkGray") (Seg ", ${age}s 前)" "DarkGray")))

  $phase = [string]$last.phase
  $phaseInfo = switch ($phase) {
    "streaming" { @("接收输出中", "Green") }
    "waiting"   { @("等待模型响应", "Cyan") }
    "stalled"   { @("静默（疑似卡住）", "Yellow") }
    "down"      { @("连接中断", "Red") }
    "idle"      { @("空闲", "Gray") }
    default     { @("$phase", "Gray") }
  }
  $waitKey = if ($last.wait) { $last.wait } else { "none" }
  $waitText = $WaitLabel[$waitKey]
  if ($last.waitDetail) { $waitText += " · " + (Shorten ([string]$last.waitDetail) 30) }

  [void]$lines.Add((Line (Seg "    状态: " "Gray") (Seg $phaseInfo[0] $phaseInfo[1]) (Seg "  等待: " "Gray") (Seg $waitText "White")))

  # What the model is thinking about right now (tail of its reasoning stream).
  # Only meaningful while phase is waiting/streaming; idle sessions show nothing.
  $thinking = [string]$last.thinking
  if ($thinking -and $phase -ne "idle" -and $phase -ne "down") {
    $thinkLine = @( (Seg "    思考: " "Gray"), (Seg "…" "DarkGray"), (Seg (Shorten $thinking 45) "DarkCyan") )
    [void]$lines.Add((Line $thinkLine))
  }

  # Last idle-probe result: the background check that runs while no model
  # request is in flight, so you know the wire's state before sending anything.
  if ($last.PSObject.Properties["lastProbeOk"] -and $null -ne $last.lastProbeOk) {
    $probeTime = ""
    if ($last.lastProbeAt) {
      try { $probeTime = ([datetime]$last.lastProbeAt).ToString("HH:mm:ss") } catch { $probeTime = "" }
    }
    if ($last.lastProbeOk) {
      $probeLine = @( (Seg "    探测: " "Gray"), (Seg "正常" "Green"), (Seg "  ($probeTime)" "DarkGray") )
    } else {
      $probeLine = @( (Seg "    探测: " "Gray"), (Seg "不通" "Red"), (Seg "  ($probeTime)" "DarkGray") )
    }
    [void]$lines.Add((Line $probeLine))
  }

  $act = Format-Activity $panel.Samples
  if ($act) {
    $actSegs = New-Object System.Collections.Generic.List[object]
    [void]$actSegs.Add((Seg "    近况: " "Gray"))
    $col = @{ streaming = "Green"; waiting = "Cyan"; stalled = "Yellow"; down = "Red"; idle = "DarkGray" }
    $keyByZh = @{ "输出" = "streaming"; "等待" = "waiting"; "静默" = "stalled"; "中断" = "down"; "空闲" = "idle" }
    $first = $true
    foreach ($pair in $act -split " · ") {
      $key = $keyByZh[($pair -split " ")[0]]
      if (-not $first) { [void]$actSegs.Add((Seg " · " "DarkGray")) }
      [void]$actSegs.Add((Seg $pair $col[$key]))
      $first = $false
    }
    [void]$lines.Add((Line $actSegs.ToArray()))
  }

  [void]$lines.Add((Line (Format-Timeline $panel.Samples)))

  # Nested agents under this conversation.
  if ($panel.PSObject.Properties["Agents"] -and $panel.Agents.Count -gt 0) {
    $agents = if ($All) { @($panel.Agents) } else { @($panel.Agents | Select-Object -First 3) }
    foreach ($a in $agents) {
      $aLast = $a.Last
      $aPhase = switch ([string]$aLast.phase) {
        "streaming" { @("接收输出中", "Green") }
        "waiting"   { @("等待模型响应", "Cyan") }
        "stalled"   { @("静默", "Yellow") }
        "down"      { @("连接中断", "Red") }
        "idle"      { @("空闲", "DarkGray") }
        default     { @("$($aLast.phase)", "Gray") }
      }
      $aName = if ($a.Title) { Shorten $a.Title 21 } else { $a.SessionID.Substring(0, [Math]::Min(8, $a.SessionID.Length)) }
      $aWait = $WaitLabel[[string]$aLast.wait]
      if ($aLast.waitDetail) { $aWait += " · " + (Shorten ([string]$aLast.waitDetail) 20) }
      $agentLine = @(
        (Seg "      ↳ " "DarkMagenta"),
        (Seg $aName "Magenta"),
        (Seg "  $($aPhase[0])" $aPhase[1]),
        (Seg "  等待: " "DarkGray"),
        (Seg $aWait "DarkGray")
      )
      [void]$lines.Add((Line $agentLine))
    }
    if (-not $All -and $panel.Agents.Count -gt 3) {
      [void]$lines.Add((Line (Seg "      还有 $($panel.Agents.Count - 3) 个子代理，使用 -All 查看" "DarkGray")))
    }
  }

  return $lines
}

function Build-Display($snap) {
  $w = 62
  $bar = [string][char]0x2550 * $w
  $thin = [string][char]0x2500 * $w
  $lines = New-Object System.Collections.Generic.List[object]

  [void]$lines.Add((Line (Seg ("  " + $bar) "DarkGray")))
  [void]$lines.Add((Line (Seg "  opencode 连接监测    " "White") (Seg (Get-Date -Format "HH:mm:ss") "Cyan")))
  [void]$lines.Add((Line (Seg ("  " + $bar) "DarkGray")))

  if (-not $snap) {
    [void]$lines.Add((Line))
    [void]$lines.Add((Line (Seg "  暂无数据 — 插件尚未写入状态文件" "Yellow")))
    [void]$lines.Add((Line (Seg "  等待路径: " "Gray") (Seg $File "DarkGray")))
    [void]$lines.Add((Line))
    [void]$lines.Add((Line (Seg ("  " + $thin) "DarkGray")))
    return $lines
  }

  $conn = $snap.Connection
  if ($conn -and ($conn.event -ne 'connection-configured' -or ([datetime]$conn.t) -ge (Get-Date).AddMinutes(-2))) {
    if ($conn.event -eq 'connection-configured') {
      $connText = if ($conn.total -gt 0) { "已配置 $($conn.total) 个端点，等待探测" } else { "未配置可探测端点" }
      $connColor = "DarkGray"
    } else {
      $connText = "端点可达 $($conn.reachable)/$($conn.total)"
      $connColor = if ($conn.reachable -eq $conn.total) { "Green" } elseif ($conn.reachable -gt 0) { "Yellow" } else { "Red" }
      if ($conn.lastProbeAt) { $connText += " · " + ([datetime]$conn.lastProbeAt).ToString("HH:mm:ss") }
    }
    [void]$lines.Add((Line (Seg "  空闲探测  " "DarkGray") (Seg $connText $connColor)))
  }

  [void]$lines.Add((Line))
  foreach ($panel in $snap.Panels) {
    foreach ($l in (Build-SessionPanel $panel $thin)) { [void]$lines.Add($l) }
    [void]$lines.Add((Line (Seg ("  " + $thin) "DarkGray")))
  }
  if ($snap.Hidden -gt 0) {
    [void]$lines.Add((Line (Seg "  还有 $($snap.Hidden) 个会话，使用 -All 查看" "DarkGray")))
  }
  if ($snap.Panels.Count -eq 0) {
    [void]$lines.Add((Line (Seg "  最近 10 分钟没有会话活动" "DarkGray")))
  }

  if ($snap.Events.Count -gt 0) {
    [void]$lines.Add((Line (Seg "  最近事件:" "Gray")))
    foreach ($e in $snap.Events) {
      $t = ([datetime]$e.t).ToString("HH:mm:ss")
      $descText = [string]$e.event
      $descColor = 'Gray'
      switch ($e.event) {
        'probe-ok'       { $descText = '端点可达，模型请求仍未输出'; $descColor = 'DarkGreen' }
        'probe-fail'     { $descText = '探测失败，连接可能中断'; $descColor = 'Red' }
        'recovered'      { $descText = '输出恢复'; $descColor = 'Green' }
        'wait-notice'    { $descText = '长时间等待: ' + $e.waitDetail; $descColor = 'Yellow' }
        'session-error'  { $descText = '会话错误: ' + $e.label; $descColor = 'Red' }
        'session-idle'   { $descText = '会话空闲'; $descColor = 'DarkGray' }
        'idle-probe-fail'{ $descText = "空闲探测: $($e.reachable)/$($e.total) 可达"; $descColor = 'Yellow' }
        'idle-recovered' { $descText = '空闲探测恢复'; $descColor = 'Green' }
      }
      $sessShort = if ($e.sessionID) { $e.sessionID.Substring(0, [Math]::Min(8, $e.sessionID.Length)) } else { "?" }
      $sessName = if ($e.sessionTitle) { $e.sessionTitle } else { $sessShort }
      $sessTag = if ($e.scope -eq 'connection') { '' } else { '  [' + (Shorten $sessName 18) + ']' }
      [void]$lines.Add((Line (Seg "    $t  " "DarkGray") (Seg (Shorten $descText 34) $descColor) (Seg $sessTag "Magenta")))
    }
    [void]$lines.Add((Line (Seg ("  " + $thin) "DarkGray")))
  }

  return $lines
}

function Render($lines) {
  $validColors = [Enum]::GetNames([System.ConsoleColor])
  foreach ($line in $lines) {
    foreach ($seg in @($line)) {
      if ($seg -is [pscustomobject] -and $seg.PSObject.Properties["T"]) {
        $color = [string]$seg.C
        if ($color -notin $validColors) { $color = "White" }
        Write-Host -NoNewline $seg.T -ForegroundColor $color
      } else {
        Write-Host -NoNewline ([string]$seg)
      }
    }
    Write-Host ""
  }
}

if ($Once) {
  Render (Build-Display (Get-Snapshot))
  exit 0
}

[Console]::CursorVisible = $false
try {
  while ($true) {
    [Console]::Clear()
    Render (Build-Display (Get-Snapshot))
    Start-Sleep -Seconds $IntervalSec
  }
} finally {
  [Console]::CursorVisible = $true
}
