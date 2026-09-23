# opencode-connection-status

A small connection monitor for OpenCode. The desktop app sometimes gives no clear sign when the connection drops, so I built this.

It records the activity of observed conversations, checks configured provider endpoints during long silences and idle periods, and shows a short reasoning excerpt when the provider supplies one. An endpoint response confirms reachability at that moment; it does not test authentication or model availability.

Works alongside [retry-forever](#retry-forever). The two plugins report different parts of a request's life cycle.

![Illustrative connmon panel with two sessions](docs/illustration-panel.svg)

![Illustrative event detail and phase legend](docs/illustration-detail.svg)

## What you get

```
  ══════════════════════════════════════════════════════════════
  opencode 连接监测    20:12:22
  ══════════════════════════════════════════════════════════════
  空闲探测  端点可达 1/1 · 20:12:20

  ▸ 修复登录流程  (ses_demo, 1s 前)
    状态: 空闲  等待: 子代理运行中
    近况: 输出 44% · 空闲 56%
  █______████__________
      ↳ 检查接口日志  接收输出中  等待: -
  ──────────────────────────────────────────────────────────────
  最近事件:
    20:12:18  会话空闲  [修复登录流程]
```

- **Per-session panels** — observed conversations and subagents have separate phases, wait owners, activity percentages, and timelines.
- **Wait-owner detection** — distinguishes "waiting on a tool", "waiting on a subagent", "context compacting", "provider retrying", and "waiting on the model". Long silences get different treatment depending on the owner.
- **Silence watchdog with probing** — after 45s without output on a tracked request, it checks the provider origin. A failed check raises a warning; a successful check leaves the request marked as waiting.
- **Idle probe** — checks configured endpoints once per process at the selected interval, even before any conversation emits an event. The result appears above the session panels.
- **Thinking tail** — displays the last 160 characters of provider-supplied reasoning while available. It clears when answer text starts. The excerpt alone cannot establish whether a queued follow-up has begun processing.
- **Session error toasts** — classified by kind: auth failure, rate limit, 5xx, network.
- **Status file** — `~/.cache/opencode/connection-status/status.jsonl`, one JSON line per state change, for scripting or `Get-Content -Wait`.

## Install

On Windows, run the installer from the repository root. It backs up changed installed copies and verifies SHA-256 hashes after copying:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

You can also copy the plugin files manually into opencode's global plugin directory:

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.config\opencode\plugin" | Out-Null
Copy-Item connection-status.ts "$env:USERPROFILE\.config\opencode\plugin\"
Copy-Item retry-forever.ts "$env:USERPROFILE\.config\opencode\plugin\"   # optional companion
```

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/plugin
cp connection-status.ts retry-forever.ts ~/.config/opencode/plugin/
```

Restart opencode. The plugin auto-loads from the plugin directory; no config changes needed.

### CLI viewer (optional)

`connmon.ps1` is a standalone terminal dashboard reading the status file:

```powershell
.\connmon.ps1              # live view, 1s refresh
.\connmon.ps1 -Once        # single snapshot
.\connmon.ps1 -IntervalSec 2
.\connmon.ps1 -All             # include older sessions and all subagents
```

Optional terminal entry point — one command in any terminal:

```powershell
# 1. create the entry script
New-Item -ItemType Directory -Force "$env:USERPROFILE\bin" | Out-Null
Copy-Item connmon.ps1 "$env:USERPROFILE\.config\opencode\"
@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\.config\opencode\connmon.ps1" %*
"@ | Set-Content "$env:USERPROFILE\bin\connmon.cmd" -Encoding ASCII

# 2. add ~\bin to PATH (once, permanent)
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
[Environment]::SetEnvironmentVariable("PATH", "$userPath;$env:USERPROFILE\bin", "User")
```

Open a **new** terminal, then:

```text
connmon              live dashboard, 1s refresh
connmon -Once        single snapshot, exit
connmon -IntervalSec 2   custom refresh interval
```

> Encoding note: `connmon.cmd` invokes Windows PowerShell 5.1, which reads the
> status file correctly (the script forces UTF-8). If you run `connmon.ps1`
> directly in an old console and see mojibake, run `chcp 65001` first or use
> Windows Terminal.

## Usage guide

### What each panel line means

```
  ▸ 修复登录流程  (ses_demo, 1s 前)         ← session title + short id + data age
    状态: 空闲  等待: 子代理运行中           ← instant phase + what it is waiting on
    思考: …checking the latest tool result… ← reasoning excerpt, when supplied
    近况: 输出 44% · 空闲 56%              ← time-weighted activity over recent samples
  █______████__________                    ← phase timeline, one glyph per state change
      ↳ 检查接口日志                        ← subagent nested under its parent conversation
```

- **状态 (phase)** — the instant of the last sample: `空闲` idle / `等待模型响应` request sent / `接收输出中` streaming / `静默（疑似卡住）` stalled+probing / `连接中断` down.
- **等待 (wait owner)** — the last observed owner: `模型思考/响应`, `工具执行 · bash (npm test)`, `子代理运行中`, `上下文压缩`, `第 N 次重试`. A tracked model request with no other wait owner can trigger a silence probe.
- **思考 (thinking)** — appears when the provider emits reasoning. It clears when answer text starts or the turn ends. Some models emit none.
- **近况 (activity)** — time-weighted shares over the recent window, so an idle snapshot during an active session is not misleading.
- **阶段时间线 (timeline)** — `█` streaming (green) / `▒` waiting (cyan) / `▓` stalled (yellow) / `X` down (red) / `_` idle (gray). Density depends on state-change frequency, so read it together with the time span in its header.

### Typical scenarios

**"The main agent shows thinking but nothing happens"** — check the parent panel's wait owner and the child panels. `等待: 子代理运行中` records a dispatched subtask. New reasoning on the parent means the parent has resumed output; the monitor does not link that output to a particular queued message.

**"Panel shows 静默（疑似卡住）"** — a tracked model request has gone quiet past the threshold and the plugin is checking the provider origin. A reachable origin leaves the request waiting; a failed check raises a toast.

**"A toast says 仍在等待"** — a tool/subagent/compaction has been running longer than the renotify interval. Informational only; the wire is not involved.

**"A toast says 连接中断"** — the origin check failed during a silent request. A green `连接已恢复` toast follows when output flows again.

**"The idle probe warns"** — at least one configured endpoint did not answer. The header shows how many answered, with one warning per transition. It checks reachability without sending a model request.

### Status file

`~/.cache/opencode/connection-status/status.jsonl` — one JSON line per state change:

```json
{"t":"2026-09-22T12:31:27.000Z","phase":"streaming","wait":"tool","waitDetail":"bash (npm test)","waitSec":12,"sinceOutageMs":0,"sessionID":"ses_…","sessionTitle":"…","parentID":"","isAgent":false,"thinking":"…"}
```

Rows with `"scope":"connection"` record the process-wide idle probe. Session rows retain `sessionID` and can be tailed with `Get-Content ... -Wait -Tail 1` in PowerShell or `tail -f` on macOS/Linux.

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_CONN_SILENCE_MS` | `45000` | Model silence before probing |
| `OPENCODE_CONN_RENOTIFY_MS` | `120000` | Re-notify interval for long waits / persistent outages |
| `OPENCODE_CONN_PROBE_TIMEOUT_MS` | `5000` | Probe request timeout |
| `OPENCODE_CONN_IDLE_PROBE_MS` | `60000` | Idle probe interval |
| `OPENCODE_CONN_STATUS_FILE` | user cache directory | Override the status path, useful for isolated tests |

## How it works

Two independent sources, per session:

1. **Event bus** — `message.part.updated` (reasoning snapshots, tool runs, subtask dispatches, retries), `session.next.*.delta` (opencode 2.x reasoning/text streams), `session.error`, `session.idle`. Everything attributable to a session lives here.
2. **Patched `globalThis.fetch`** — counts in-flight requests to provider endpoints (discovered from config `provider.<id>.options.baseURL`). Request bodies carry no session id, so in-flight counts are global and attach to the active session; the event stream corrects ownership as output flows.

The watchdog runs every 5s over all sessions: heartbeats, stall detection, probing, recovery toasts.

### Reading the phases

| Phase | Meaning |
|---|---|
| `idle` | No active turn |
| `waiting` | Request sent; no output observed yet |
| `streaming` | Output flowing |
| `stalled` | Request in flight, silent past the threshold, probing |
| `down` | Origin probe failed during a silent request |

### Interpreting the main agent while subagents run

The parent panel records a dispatched subtask until the parent emits new output or the turn ends. Child panels show their own activity. This indicates which session is active; event data does not identify the exact queued user message behind a reasoning excerpt.

## retry-forever

`retry-forever.ts` keeps long-running sessions alive across transient provider failures. opencode's built-in retry gives up after a few attempts and its matcher misses several real failure shapes (DNS failures, some gateway 5xx); when it gives up, the session dies with "Failed to drain Session". This plugin wraps `globalThis.fetch` (opencode 1.x) and the AI SDK language model hook (opencode 2.x) so retries happen below the session runner.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_RETRY_DELAY_MS` | `250` | Base delay between retries |
| `OPENCODE_RETRY_MAX_ATTEMPTS` | `0` (unlimited) | Max attempts per request |
| `OPENCODE_RETRY_HONOR_RETRY_AFTER` | `true` | Respect `Retry-After` headers |
| `OPENCODE_RETRY_VERBOSE` | `true` | Log each retry to stderr |

## Uninstall

```powershell
# plugin
Remove-Item "$env:USERPROFILE\.config\opencode\plugin\connection-status.ts"
Remove-Item "$env:USERPROFILE\.config\opencode\plugin\retry-forever.ts" -ErrorAction SilentlyContinue

# CLI viewer
Remove-Item "$env:USERPROFILE\.config\opencode\connmon.ps1" -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\bin\connmon.cmd" -ErrorAction SilentlyContinue

```

Then restart opencode. The local status history and deployment backups remain available for inspection.

## Known issues

- **Thinking display still needs reports from more providers.** It depends on reasoning events, which some models do not emit. The excerpt cannot identify the exact user message being processed. OpenCode 1.x and 2.x use different event shapes; the 2.x path has offline tests but has not been verified here against a live 2.x session. Reports and PRs with a version, model, and provider type are welcome.
- Endpoint probes test HTTP reachability. A 401 or 404 response still shows that the endpoint answered. Authentication and model generation require an actual model request.
- The timeline shows state changes. OpenCode's available events do not supply reliable per-session upload and download byte counts, so the panel does not label its activity percentages as network throughput.

## Technical documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture, deployment, verification, and current limits

## Contributing

Issues and PRs are welcome — especially test reports from different models and providers (the reasoning-stream shape varies more than expected). Please include your opencode version, model, and provider type when filing issues.

## License

MIT
