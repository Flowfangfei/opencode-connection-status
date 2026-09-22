# opencode-connection-status

Live model-connection monitor for [opencode](https://opencode.ai) — knows whether each conversation is waiting, streaming, or silently stalled, probes the network before claiming an outage, and shows what the model is actually thinking about.

Works alongside [retry-forever](#retry-forever): retries happen silently below the session layer, so a toast from this plugin means retries were exhausted or the failure is not retryable.

## What you get

```
  ══════════════════════════════════════════════════════════════
  opencode 连接监测    20:12:22
  ══════════════════════════════════════════════════════════════

  ▸ 读取技能目录  (ses_f3bb, 1s 前)
    状态: 空闲  等待: 子代理运行中
    近况: 输出 44% · 空闲 56%
  █______████__________
      ↳ 补译Srednicki ch35-36 [agent]  接收输出中  等待: -
      思考: …Let me start by reading the glossary and the source file…
  ──────────────────────────────────────────────────────────────
  最近事件:
    17:47:04  会话空闲  [读取技能目录]
    17:39:30  探测正常（模型在思考，网络通）  [Connect command]
```

- **Per-session panels** — every conversation (and its subagents) gets its own panel with phase, wait owner, activity percentages, and an independent timeline. Concurrent sessions never overwrite each other.
- **Wait-owner detection** — distinguishes "waiting on a tool", "waiting on a subagent", "context compacting", "provider retrying", and "waiting on the model". Long silences get different treatment depending on the owner.
- **Silence watchdog with probing** — when a model request goes quiet for 45s with no known owner, the plugin probes the provider origin. Reachable = model is thinking (stay silent). Unreachable = real outage (error toast, recovery confirmation later).
- **Thinking tail** — shows the last 160 chars of the model's reasoning stream while it works, so you can tell whether it is digesting the previous step's results or your latest question. Clears when the answer starts.
- **Session error toasts** — classified by kind: auth failure, rate limit, 5xx, network.
- **Status file** — `~/.cache/opencode/connection-status/status.jsonl`, one JSON line per state change, for scripting or `Get-Content -Wait`.

## Install

Copy the plugin into opencode's global plugin directory:

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
  ▸ 读取技能目录  (ses_f3bb, 1s 前)         ← session title + short id + data age
    状态: 空闲  等待: 子代理运行中           ← instant phase + what it is waiting on
    思考: …Let me start by reading…        ← tail of the model's reasoning (when thinking)
    近况: 输出 44% · 空闲 56%              ← time-weighted activity over recent samples
  █______████__________                    ← phase timeline, one glyph per state change
      ↳ 补译Srednicki ch35-36 [agent]      ← subagent nested under its parent conversation
```

- **状态 (phase)** — the instant of the last sample: `空闲` idle / `等待模型响应` request sent / `接收输出中` streaming / `静默（疑似卡住）` stalled+probing / `连接中断` down.
- **等待 (wait owner)** — what the session is waiting on: `模型思考/响应`, `工具执行 · bash (npm test)`, `子代理运行中`, `上下文压缩`, `第 N 次重试`. Long silences with a known owner are normal; silence with **no** owner triggers probing.
- **思考 (thinking)** — appears only while the model is actually reasoning (complex tasks; simple questions skip reasoning entirely). Disappears the moment the answer starts — its presence means "still thinking", its disappearance means "answering now".
- **近况 (activity)** — time-weighted shares over the recent window, so an idle snapshot during an active session is not misleading.
- **阶段时间线 (timeline)** — `█` streaming (green) / `▒` waiting (cyan) / `▓` stalled (yellow) / `X` down (red) / `_` idle (gray). Density depends on state-change frequency, so read it together with the time span in its header.

### Typical scenarios

**"The main agent shows thinking but nothing happens"** — you sent a follow-up while subagents were running. The follow-up is queued: the main panel shows `等待: 子代理运行中` with no thinking line. It will process your message after the agents finish. A thinking line appearing on the main panel means it is genuinely working on your follow-up now.

**"Panel shows 静默（疑似卡住）"** — a model request went silent past the threshold and the plugin is probing the provider. If the network is reachable it stays quiet (model is thinking); if not, you get a `连接中断` error toast.

**"A toast says 仍在等待"** — a tool/subagent/compaction has been running longer than the renotify interval. Informational only; the wire is not involved.

**"A toast says 连接中断"** — silence plus a failed probe. Real outage. A green `连接已恢复` toast follows when output flows again.

### Status file

`~/.cache/opencode/connection-status/status.jsonl` — one JSON line per state change:

```json
{"t":"2026-09-22T12:31:27.000Z","phase":"streaming","wait":"tool","waitDetail":"bash (npm test)","waitSec":12,"sinceOutageMs":0,"sessionID":"ses_…","sessionTitle":"…","parentID":"","isAgent":false,"thinking":"…"}
```

Script it directly: `Get-Content ... -Wait -Tail 1` in PowerShell, or `tail -f` on macOS/Linux.

## Configuration

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `OPENCODE_CONN_SILENCE_MS` | `45000` | Model silence before probing |
| `OPENCODE_CONN_RENOTIFY_MS` | `120000` | Re-notify interval for long waits / persistent outages |
| `OPENCODE_CONN_PROBE_TIMEOUT_MS` | `5000` | Probe request timeout |

## How it works

Two independent sources, per session:

1. **Event bus** — `message.part.updated` (reasoning snapshots, tool runs, subtask dispatches, retries), `session.next.*.delta` (opencode 2.x reasoning/text streams), `session.error`, `session.idle`. Everything attributable to a session lives here.
2. **Patched `globalThis.fetch`** — counts in-flight requests to provider endpoints (discovered from config `provider.<id>.options.baseURL`). Request bodies carry no session id, so in-flight counts are global and attach to the active session; the event stream corrects ownership as output flows.

The watchdog runs every 5s over all sessions: heartbeats, stall detection, probing, recovery toasts.

### Reading the phases

| Phase | Meaning |
|---|---|
| `idle` | No active turn |
| `waiting` | Request sent, no output yet (model thinking) |
| `streaming` | Output flowing |
| `stalled` | Request in flight, silent past the threshold, probing |
| `down` | Probe failed — connection interrupted |

### Interpreting the main agent while subagents run

When a main agent dispatches subagents (Task tool) and you send a follow-up message, the follow-up is queued — the main agent is not thinking about it yet. The panel shows this honestly: main session reads `等待: 子代理运行中` with no thinking line, while the agent panels carry their own streaming state and reasoning tails. A thinking line appearing on the main session means it is genuinely working on your follow-up.

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

# status data
Remove-Item "$env:USERPROFILE\.cache\opencode\connection-status" -Recurse -Force -ErrorAction SilentlyContinue
```

Then restart opencode.

## Known issues

- **思考状况的显示（thinking display）仍有未解决的问题**：思考内容依赖模型输出 reasoning 部分——简单问题模型不思考，面板自然没有 `思考` 行；部分模型/供应商组合可能根本不返回 reasoning（此时该功能静默失效）。另外 opencode 1.x 与 2.x 的事件名不同（`message.part.updated` vs `session.next.*.delta`），两套都已处理，但未来版本若再改事件结构需要跟进。欢迎在 issue 里报告你的模型/供应商组合下的表现。

## Contributing

Issues and PRs are welcome — especially test reports from different models and providers (the reasoning-stream shape varies more than expected). Please include your opencode version, model, and provider type when filing issues.

## License

MIT
