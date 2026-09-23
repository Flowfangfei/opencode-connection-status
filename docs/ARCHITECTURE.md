# Architecture and Implementation Notes

This document describes how `connection-status.ts`, `retry-forever.ts`, and `connmon.ps1` work internally, and reports the test evidence behind them. It assumes you have read the README's usage guide.

## 1. Overall architecture

Three components, one data flow:

```
opencode process                          external viewer
┌─────────────────────────────┐
│  event bus ──┐              │
│              ▼              │   status.jsonl    ┌──────────────┐
│  connection-status.ts ──────┼──────────────────▶│ connmon.ps1  │
│  (per-session state,        │   (append-only)   │ (tail+render)│
│   watchdog, probing)        │                   └──────────────┘
│                             │
│  retry-forever.ts           │
│  (fetch patch, AI SDK hook, │
│   auto-resume)              │
└─────────────────────────────┘
```

The plugin and retry-forever live inside the opencode process and observe it from two angles: the event bus (what opencode reports) and the patched `globalThis.fetch` (what actually goes over the wire). They write observations to an append-only JSONL file; the CLI viewer tails that file and renders. The viewer never talks to opencode, so it keeps working even when opencode is wedged — which is precisely when you want it.

## 2. connection-status.ts

### 2.1 Per-session state

The central design decision: state is a `Map<sessionID, State>`, not a single object. Each `State` carries phase, wait owner, thinking tail, outage tracking, and metadata (title, parentID, isAgent).

The reason is empirical. The first version used one global state, and under concurrent sessions the panels lied: a subagent's streaming showed up as the main session's activity, and a main agent waiting on a Task tool looked like it was thinking. A session's events arrive interleaved with every other session's; only per-session state keeps attribution honest.

Model requests cannot be attributed to a session from the wire (the request body carries no session id), so in-flight counts live in a global tracker and attach to whichever session the event stream last touched. Event data refines the attribution as output arrives. The idle probe is process-wide and writes separate `scope: "connection"` rows.

### 2.2 Event mapping

The plugin handles two opencode generations with different event vocabularies:

| Concern | opencode 1.x | opencode 2.x |
|---|---|---|
| Reasoning | `message.part.updated` with `part.type === "reasoning"` (full snapshot, can be 100KB+) | `session.next.reasoning.delta` (increments) |
| Answer text | same event, `part.type === "text"` | `session.next.text.delta` |
| Tool runs | `part.type === "tool"` with `state.status` | same |
| Subtask dispatch | `part.type === "subtask"` | same |
| Retry | `part.type === "retry"` with `attempt` | same |
| Turn end | `part.type === "step-finish"` / `session.idle` | same |

We found this by instrumenting the plugin to log every event type observed on the bus during real sessions: 1.18.31 emitted 183 `message.part.delta` events and 12 `message.part.updated` snapshots in one turn, and reasoning arrived only in the snapshots — the dedicated delta events of the 2.x SDK do not exist there.

The thinking tail is the last 160 characters of observed reasoning text. It clears when answer text starts or the turn ends. The event stream does not link a reasoning excerpt to an exact queued follow-up, so the viewer reports the excerpt without inferring that link.

### 2.3 Wait-owner classification

Silence is not one condition. The plugin distinguishes five owners, in priority order:

1. `retry` — opencode logged a retry part; it is already re-sending
2. `compaction` — the summarizer model is working
3. `subtask` — a Task tool dispatched a child agent
4. `tool` — a tool call is in `state.status === "running"`
5. `model` — a request is in flight with no other owner

The first four make silence expected: the wire is not the thing on trial, so the watchdog never probes them. It reports a `wait-notice` toast once per renotify interval (default 2 minutes) so a 10-minute bash run stays visible without spamming.

Only ownerless silence — a model request in flight, no output for `silenceMs` (default 45s) — earns a probe.

### 2.4 Probing

The probe is a GET to `/models` on the provider origin (discovered from config `provider.<id>.options.baseURL`) with a 5s timeout and a marker header so the fetch patch ignores it. Any HTTP response counts as reachable, including 401 and 404. It measures endpoint reachability at that moment; authentication and model generation are outside this check. Ambiguous errors lean reachable. Clear network failures and timeouts count as a failed probe.

Outcomes:

- **Reachable** — write a `probe-ok` line and leave the model request waiting.
- **Unreachable** — mark `down`, toast once (`静默 Ns 且探测不通 — 连接中断`), and toast `连接已恢复` when output flows again. A failed origin check is evidence of a connection problem, not a diagnosis of the model service.

The probe carries an `x-opencode-conn-probe` header; the fetch patch checks it to avoid recursion and to keep probes from extending the waiting window.

### 2.5 Fetch patch

`armFetchTracking` wraps `globalThis.fetch` once per process (guarded by a `Symbol.for` key, since the plugin file may be evaluated more than once across project/global scopes). It counts requests whose host matches a configured provider endpoint, increments on dispatch, decrements on settle, and flips the active session's phase to `waiting`.

Two details that mattered:

- Request bodies may be streams, which are consumed by the first attempt — but this patch does not retry, so it never needs to replay. (retry-forever does, and handles that separately.)
- The patch must not count its own probes.

### 2.6 Watchdog and heartbeats

A single 5s interval iterates all sessions for heartbeat, recovery, wait reminders, stall checks, and idle demotion. Afterward, one process-wide idle probe checks each configured origin if no model request is in flight. The probe runs even when no session has emitted an event. It records an endpoint count and toasts only on transitions.

Heartbeats are deduplicated per session by a key of `phase|wait|waitDetail|thinking-tail`. Without this the file grows a line per token; with it, an idle session costs nothing and an active session writes only when something observable changed. The thinking tail participates in the key, so reasoning progress is visible without per-token writes.

## 3. retry-forever.ts

### 3.1 The problem

opencode's built-in retry gives up after a few attempts, and its matcher misses real failure shapes — DNS failures, some gateway 5xx. When it gives up, `SessionRunner.drain` throws and the session dies with "Failed to drain Session". For sessions left running for hours this is fatal.

### 3.2 Two generations, two injection points

**opencode 1.x** routes provider traffic through `globalThis.fetch`, so a patch (shared with connection-status via the same Symbol guard, but with retry logic) sees every request. Retryable HTTP statuses (408/409/425/429/5xx family) and network-level throw shapes are retried with backoff, honoring `Retry-After` headers.

**opencode 2.x** does not route provider traffic through the plugin's fetch. The injection point is `aisdk.hook("language", ...)`: every provider registers one to assign `input.language`, so a hook registered afterwards receives the built model and can wrap `doStream`/`doGenerate` with retries. A stream that already emitted content cannot be restarted without duplicating it downstream, so only failures before the first emitted part are retried there; later failures propagate to opencode's own retry.

The module ships both entry shapes (`server` for 1.x, `setup` for 2.x) behind one default export, because the two major versions validate the plugin schema differently and reject the wrong shape at load.

### 3.3 Auto-resume

Transport retries cannot save a turn the provider ended mid-flight (`finish: "unknown"`). 1.x recovers by re-sending the user's own text (keyed by session + prompt text, since a resend creates a new message id); 2.x exposes `session.execution.failed` as the terminal event after built-in retries are exhausted, and the resumer sends a synthetic "continue".

The resume decision excludes deliberate aborts: a zero-token `unknown` finish means a denied permission, compaction, or interrupt — resuming there would fight the user. Only a turn that produced output and then stopped without a reason is a real drop. Interrupted turns never resume. The failure streak per session is capped (`maxAttempts`), and a success or interrupt clears it.

### 3.4 Interaction with connection-status

retry-forever handles selected retryable failures below the session layer. `session.error` reports errors OpenCode still surfaces to the session; the event alone does not establish which retry path ran.

## 4. connmon.ps1

The viewer is a standalone PowerShell script with no dependency on opencode. It tails the last 600 lines of `status.jsonl`, separates process-wide probe rows, groups session samples by `sessionID`, and nests agents under their parent. By default it shows up to five recent root sessions and three agents per root; `-All` expands the view. It renders:

- **Phase timeline** — one glyph per state change over the session's last 24 samples: `█` streaming, `▒` waiting, `▓` stalled, `X` down, `_` idle. It represents state changes rather than evenly spaced time or upload/download bytes.
- **Activity percentages** — time-weighted, computed from the gaps between consecutive samples, capped at 300s per gap so a suspended machine does not drown the window in idle.
- **Notable events** — failures, recoveries, wait notices, and errors; session events carry their title. Routine successful idle probes appear in the header instead of filling the event list.

Two encoding details: the script forces `[Console]::OutputEncoding = UTF8` (block glyphs die in the ANSI codepage) and reads the status file with `Get-Content -Encoding UTF8` (Windows PowerShell 5.1 defaults to GBK on Chinese-locale systems, which mojibake'd every Chinese title until we pinned the encoding).

The implementation carries some scar tissue from PowerShell 5.1: `Seg`/`Line` helpers use PSCustomObject instead of nested arrays (PowerShell's `@()` unrolls nested arrays unpredictably at call sites), `Line` collects arguments via `$args` (a typed parameter silently drops everything after the first), and the glyph map is a hashtable lookup (a `switch` statement flattens nested arrays in its output). Each of these produced a distinct, confusing failure before being pinned down.

## 5. Verification

Run `npm test` from the repository root. The suites use temporary directories for the SDK shim and status file, so they do not modify an installed OpenCode status log. Local HTTP servers simulate reachable, reset, and hanging connections.

| Suite | Current result | Main coverage |
|---|---:|---|
| `tests/plugin.test.mjs` | 25/25 | Startup without provider RPC, session separation, reasoning, errors, wait owners, stall and idle probes, fetch disposal and reload |
| `tests/retry-forever.test.mjs` | 18/18 | Resume decisions, attempt caps, 1.x fetch retries and body replay, 2.x language hook before stream output |
| `tests/connmon.test.ps1` | 1/1 | Windows PowerShell 5.1 global probe header and complete wait-event rendering |

The plugin suite verifies that an idle probe runs with no sessions and that two sessions cause one request per probe interval. It checks the warning and recovery transitions. A hanging model request produces a failed probe and a recovery toast after output resumes. The retry suite uses a 503 response followed by 200 to check request-body replay, a network error to check the attempt cap, and a mocked 2.x language hook to check retry before the first streamed part.

On 2026-09-24, a fresh locally installed OpenCode 1.x server process was started with a one-second idle-probe interval and no conversation activity. Its configuration endpoint returned HTTP 200; the plugin wrote `connection-configured` followed by `idle-probe-ok` rows with `reachable: 1` and `total: 1`. The installed `connmon` command displayed the global result. The temporary server was then stopped. This confirms the installed idle path on this machine, while the running desktop processes still carry their previously loaded code.

Run `npm run test:viewer` on Windows for the CLI rendering regression. Manual viewer check: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\connmon.ps1 -Once`. A sample status file can be passed with `-StatusFile`. These checks establish that the script parses and renders a snapshot; they do not establish that a running OpenCode process has reloaded a newly deployed plugin.

### Current limits

- The 1.x fetch patch counts requests until response headers arrive. Long pauses later in a streamed response may be underdetected if OpenCode emits no event and no in-flight request remains.
- Endpoint probing checks HTTP reachability. It does not verify authentication, model generation, or every route behind the origin.
- The 2.x language-hook path is covered with a mock model; a live 2.x provider session has not been verified in this audit.
- Session events cannot reliably assign a network request to one of several concurrent sessions or identify which queued user message a reasoning excerpt concerns.
- The status file is append-only. The viewer reads only its tail; rotation is not yet implemented. Large diagnostic logs from older debugging sessions are outside this repository and require separate local housekeeping.

### Deployment

Copy `connection-status.ts` and `retry-forever.ts` into the OpenCode global plugin directory, and copy `connmon.ps1` to the chosen CLI location. Compare SHA-256 hashes between source and installed copies. A running OpenCode process retains its loaded plugin code until it is restarted. Keep local configuration and status data outside the public repository.
