# connection-status TUI viewer
# Usage:  connmon              # live view, refreshes every second
#         connmon -Once        # print one snapshot and exit
#         connmon -IntervalSec 2
# Data:   ~\.cache\opencode\connection-status\status.jsonl (written by the plugin)
param(
  [switch]$Once,
  [int]$IntervalSec = 1
)

$ErrorActionPreference = "Stop"
# Block glyphs (█▒▓) need UTF-8 console output; PS 5.1 defaults to the ANSI
# codepage, which silently replaces them with U+FFFD.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$File = Join-Path $env:USERPROFILE ".cache\opencode\connection-status\status.jsonl"

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

  # Group samples by session. Subagents (isAgent) are nested under their parent
  # so each conversation renders as one panel with its agents indented below.
  # Plain arrays + foreach statement: generic Lists and ForEach-Object with
  # hashtable lookups throw "Argument types do not match" on PS 5.1.
  $bySession = @{}
  foreach ($e in $events) {
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
  $panels = @($panels | Sort-Object LastT -Descending)

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

  $notable = @($events | Where-Object { $_.event -and $_.event -ne "stalled" } | Select-Object -Last 8)

  [pscustomobject]@{
    Panels  = $roots
    Events  = $notable
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
  foreach ($s in @($samples | Select-Object -Last 30)) {
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
  $name = if ($panel.Title) { $panel.Title } else { "会话 $shortID" }
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
  if ($last.waitDetail) { $waitText += " · " + $last.waitDetail }

  [void]$lines.Add((Line (Seg "    状态: " "Gray") (Seg $phaseInfo[0] $phaseInfo[1]) (Seg "  等待: " "Gray") (Seg $waitText "White")))

  # What the model is thinking about right now (tail of its reasoning stream).
  # Only meaningful while phase is waiting/streaming; idle sessions show nothing.
  $thinking = [string]$last.thinking
  if ($thinking -and $phase -ne "idle" -and $phase -ne "down") {
    $thinkLine = @( (Seg "    思考: " "Gray"), (Seg "…" "DarkGray"), (Seg $thinking "DarkCyan") )
    [void]$lines.Add((Line $thinkLine))
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
    foreach ($a in $panel.Agents) {
      $aLast = $a.Last
      $aPhase = switch ([string]$aLast.phase) {
        "streaming" { @("接收输出中", "Green") }
        "waiting"   { @("等待模型响应", "Cyan") }
        "stalled"   { @("静默", "Yellow") }
        "down"      { @("连接中断", "Red") }
        "idle"      { @("空闲", "DarkGray") }
        default     { @("$($aLast.phase)", "Gray") }
      }
      $aName = if ($a.Title) { $a.Title } else { $a.SessionID.Substring(0, [Math]::Min(8, $a.SessionID.Length)) }
      $aWait = $WaitLabel[[string]$aLast.wait]
      if ($aLast.waitDetail) { $aWait += " · " + $aLast.waitDetail }
      $agentLine = @(
        (Seg "      ↳ " "DarkMagenta"),
        (Seg $aName "Magenta"),
        (Seg "  $($aPhase[0])" $aPhase[1]),
        (Seg "  等待: " "DarkGray"),
        (Seg $aWait "DarkGray")
      )
      [void]$lines.Add((Line $agentLine))
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

  [void]$lines.Add((Line))
  foreach ($panel in $snap.Panels) {
    foreach ($l in (Build-SessionPanel $panel $thin)) { [void]$lines.Add($l) }
    [void]$lines.Add((Line (Seg ("  " + $thin) "DarkGray")))
  }

  if ($snap.Events.Count -gt 0) {
    [void]$lines.Add((Line (Seg "  最近事件:" "Gray")))
    foreach ($e in $snap.Events) {
      $t = ([datetime]$e.t).ToString("HH:mm:ss")
      $desc = switch ($e.event) {
        "probe-ok"      { @("探测正常（模型在思考，网络通）", "DarkGreen") }
        "probe-fail"    { @("探测失败 — 连接中断", "Red") }
        "recovered"     { @("连接恢复", "Green") }
        "wait-notice"   { @("长时间等待: " + $e.waitDetail, "Yellow") }
        "session-error" { @("会话错误: " + $e.label, "Red") }
        "session-idle"  { @("会话空闲", "DarkGray") }
        default         { @("$($e.event)", "Gray") }
      }
      $sessShort = if ($e.sessionID) { $e.sessionID.Substring(0, [Math]::Min(8, $e.sessionID.Length)) } else { "?" }
      $sessName = if ($e.sessionTitle) { $e.sessionTitle } else { $sessShort }
      $sessTag = "  [" + $sessName + "]"
      [void]$lines.Add((Line (Seg "    $t  " "DarkGray") (Seg $desc[0] $desc[1]) (Seg $sessTag "Magenta")))
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
