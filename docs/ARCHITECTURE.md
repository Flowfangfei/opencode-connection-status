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

The cost of this decision: model requests cannot be attributed to a session from the wire (the request body carries no session id), so in-flight counts live in a global tracker and attach to whichever session the event stream last touched. Per-session truth converges as output events flow. The watchdog only probes the session that owns the in-flight count.

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

The thinking tail is the last 160 characters of accumulated reasoning text. It clears when answer text starts (the thinking phase is over) or the turn ends. The viewer renders it only while the session is active, so its presence means "still reasoning" and its disappearance means "answering now".

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

The probe is a GET to the provider origin (discovered from config `provider.<id>.options.baseURL`) with a 5s timeout and a marker header so the fetch patch ignores it. Any HTTP response counts as reachable — 401 and 404 mean the tunnel is up. Ambiguous errors lean reachable; only clear network failures (DNS, refused, timeout) count as down.

Outcomes:

- **Reachable** — write a `probe-ok` line, stay silent. A toast here would be noise on every long reasoning turn.
- **Unreachable** — mark `down`, toast once (`静默 Ns 且探测不通 — 连接中断`), re-toast per `renotifyMs` while the outage persists, and toast `连接已恢复` when output flows again.

The probe carries an `x-opencode-conn-probe` header; the fetch patch checks it to avoid recursion and to keep probes from extending the waiting window.

### 2.5 Fetch patch

`armFetchTracking` wraps `globalThis.fetch` once per process (guarded by a `Symbol.for` key, since the plugin file may be evaluated more than once across project/global scopes). It counts requests whose host matches a configured provider endpoint, increments on dispatch, decrements on settle, and flips the active session's phase to `waiting`.

Two details that mattered:

- Request bodies may be streams, which are consumed by the first attempt — but this patch does not retry, so it never needs to replay. (retry-forever does, and handles that separately.)
- The patch must not count its own probes.

### 2.6 Watchdog and heartbeats

A single 5s interval iterates all sessions. Per tick, per session: heartbeat (write a status line if anything changed), recovery check, wait-notice, stall/probe, idle demotion.

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

retry-forever retries silently below the session layer. A `session.error` toast from connection-status therefore means retries were exhausted or the failure is not retryable — the two plugins compose rather than overlap.

## 4. connmon.ps1

The viewer is a standalone PowerShell script with no dependency on opencode. It tails the last 600 lines of `status.jsonl`, groups samples by `sessionID`, nests agent panels (samples whose `isAgent` is true) under their parent session, and renders:

- **Phase timeline** — one glyph per state change over the session's last 30 samples: `█` streaming, `▒` waiting, `▓` stalled, `X` down, `_` idle. A header shows the time span, because samples are written on change and 40 changes can span minutes or hours.
- **Activity percentages** — time-weighted, computed from the gaps between consecutive samples, capped at 300s per gap so a suspended machine does not drown the window in idle.
- **Notable events** — probe results, recoveries, wait notices, errors; each tagged with the session title.

Two encoding details: the script forces `[Console]::OutputEncoding = UTF8` (block glyphs die in the ANSI codepage) and reads the status file with `Get-Content -Encoding UTF8` (Windows PowerShell 5.1 defaults to GBK on Chinese-locale systems, which mojibake'd every Chinese title until we pinned the encoding).

The implementation carries some scar tissue from PowerShell 5.1: `Seg`/`Line` helpers use PSCustomObject instead of nested arrays (PowerShell's `@()` unrolls nested arrays unpredictably at call sites), `Line` collects arguments via `$args` (a typed parameter silently drops everything after the first), and the glyph map is a hashtable lookup (a `switch` statement flattens nested arrays in its output). Each of these produced a distinct, confusing failure before being pinned down.

## 5. Test report

Both suites run offline: the SDK import is shimmed via module hooks, the provider origin is a local HTTP server whose reachability is configurable per test, and the resumer's sleep is injected. `npm test` runs both.

### 5.1 plugin.test.mjs — 16/16 passed

| # | Case | Result |
|---|---|---|
| 1 | 503 error classified as warning toast | PASS |
| 1b | 3 identical errors within 3s → 1 toast (dedupe) | PASS |
| 2 | same error after the dedupe window re-toasts | PASS |
| 3 | `MessageAbortedError` (user interrupt) stays silent | PASS |
| 4 | `ProviderAuthError` → error variant | PASS |
| 5 | interleaved reasoning from two sessions → each panel keeps its own thinking tail | PASS |
| 6 | answer text clears the thinking tail | PASS |
| 7 | `session.idle` clears thinking and wait, phase → idle | PASS |
| 8 | heartbeat writes at most once per session per tick | PASS |
| 9 | fast-completing request produces no false stall | PASS |
| 10 | hanging request → stalled → probe-fail → down toast | PASS |
| 10b | output after down → recovery toast | PASS |
| 11 | persistent outage re-notifies per renotify interval | PASS |
| 12 | tool running past renotify → wait-notice toast with command | PASS |
| 13 | `parentID === own id` is not treated as a subagent | PASS |
| 14 | status line carries all 11 schema fields | PASS |

Tests 10–11 use a mock origin that accepts connections and never responds, so the probe times out against a genuinely hanging endpoint rather than a refused one.

### 5.2 retry-forever.test.mjs — 15/15 passed

`shouldResume` decision table:

| # | Case | Result |
|---|---|---|
| R1 | `finish: "unknown"` with output → resume | PASS |
| R2 | `finish: "unknown"` with zero tokens → deliberate abort, no resume | PASS |
| R3 | clean `finish: "stop"` → no resume | PASS |
| R4 | user message → no resume | PASS |
| R5 | summary (compaction) message → no resume | PASS |
| R6 | provider filter excludes other providers | PASS |
| R7 | provider filter admits matching provider | PASS |
| R8 | model prefix filter matches | PASS |
| R9 | undefined info → no resume | PASS |

`createExecutionResumer` state machine:

| # | Case | Result |
|---|---|---|
| R10 | one failure → exactly one resume prompt | PASS |
| R11 | duplicate failure events while a resume is in flight → deduped to one prompt | PASS |
| R12 | success clears the failure streak; the next failure starts over | PASS |
| R13 | resumes stop at `maxAttempts`; the cap holds across further failures | PASS |
| R14 | interrupted turns never resume | PASS |
| R15 | events without a sessionID are ignored | PASS |

### 5.3 Live verification

Beyond the offline suites, the plugin was verified against a running opencode 1.18.31 instance with real traffic:

- A translation session with three concurrent subagents produced correct per-session panels: the main session showed `等待: 子代理运行中` with no thinking line while agent panels streamed with their own tool waits and reasoning tails (one agent accumulated 131K reasoning tokens).
- Real reasoning text was captured end-to-end during a multi-file translation task (tails like "Let me start by reading the glossary and the source file"), and cleared when answers began.
- A deliberately wedged provider produced the down toast, and output recovery produced the recovery toast.
- The status file reached ~360K lines over a day of use with no performance degradation in the viewer (tail reads only).

### 5.4 Known gaps in coverage

- The 1.x fetch-patch retry path in retry-forever is not covered by automated tests — it needs a fetch-level mock with streamed bodies, and the 2.x AI SDK hook path would need the `aisdk` runtime. Both are exercised only in live use.
- `connmon.ps1` is verified by rendering checks and manual use, not a scripted suite; PowerShell's console behavior is hard to assert offline.
- Probe behavior under IPv6-only origins and proxies is untested.
- The 2.x `session.next.*.delta` handlers are covered by the shared logic paths but were written against SDK types, not against a live 2.x instance.
