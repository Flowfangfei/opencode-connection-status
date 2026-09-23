/**
 * opencode-connection-status
 *
 * Live model-connection monitor with PER-SESSION state.
 *
 * Multiple conversations (and their subagents) run concurrently in one
 * opencode process. A single global state object would let them overwrite
 * each other — a subagent's streaming would show up as the main session's
 * "thinking". So every session gets its own State, keyed by sessionID, and
 * the status file records one line per session per change.
 *
 * How each session's state is read, from two independent sources:
 *
 *   1. A patched globalThis.fetch tracks in-flight requests to provider
 *      endpoints. Model requests cannot be attributed to a session from the
 *      wire (the body has no session id), so in-flight counts are GLOBAL and
 *      surface as "waiting" on whichever session is active — the event stream
 *      then corrects ownership as soon as output flows.
 *   2. The event bus carries per-session truth: reasoning/text deltas, tool
 *      runs, subtask dispatches, retries, errors. Everything attributable
 *      lives here.
 *
 * The watchdog iterates ALL sessions each tick: per-session stall detection,
 * probing (only when a session's silence has no known owner), recovery
 * toasts, and heartbeats.
 *
 * session.error handling: toast on exhausted retries, classified by failure
 * kind (auth / rate limit / 5xx / network).
 */

import { createOpencodeClient } from "@opencode-ai/sdk"

type ToastVariant = "info" | "success" | "warning" | "error"

type ErrorData = {
  message?: string
  statusCode?: number
  isRetryable?: boolean
}

type ProviderError = {
  name?: string
  message?: string
  data?: ErrorData
}

type Settings = {
  /** No model output for this long while a request is in flight -> probe. */
  silenceMs: number
  /** Toast again at this interval if the outage persists. */
  renotifyMs: number
  /** Probe timeout. */
  probeTimeoutMs: number
  /** Background probe interval while no model request is in flight. */
  idleProbeMs: number
}

const PATCHED = Symbol.for("opencode-connection-status.patched")

function numberSetting(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return parsed
}

function readSettings(): Settings {
  return {
    silenceMs: numberSetting("OPENCODE_CONN_SILENCE_MS", 45_000),
    renotifyMs: numberSetting("OPENCODE_CONN_RENOTIFY_MS", 120_000),
    probeTimeoutMs: numberSetting("OPENCODE_CONN_PROBE_TIMEOUT_MS", 5_000),
    idleProbeMs: numberSetting("OPENCODE_CONN_IDLE_PROBE_MS", 60_000),
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ""
  const code = (error as NodeJS.ErrnoException).code
  return `${error.message}${cause}${code ? ` (${code})` : ""}`
}

/** True when fetch threw for network reasons (as opposed to an abort). */
function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL|EPIPE|UND_ERR|ConnectionClosed|ConnectionRefused|ConnectionTimeout|DNSResolutionFailed|FailedToOpenSocket|IdleTimeout|LifetimeTimeout|socket hang up|fetch failed|network error|terminated|premature close|other side closed|connection (?:closed|reset|error|timeout)|unable to connect/i.test(
    describe(error),
  )
}

/* ------------------------------------------------------------------ *
 * Per-session state machine
 * ------------------------------------------------------------------ */

type Phase = "idle" | "waiting" | "streaming" | "stalled" | "down"

/**
 * What the session is actually waiting on. The watchdog uses this to decide
 * whether silence is expected (a tool grinding away) or suspicious (a model
 * request with no output), and the status file/toasts report it verbatim.
 */
type WaitKind = "model" | "tool" | "subtask" | "compaction" | "retry" | "none"

type State = {
  sessionID: string
  phase: Phase
  /** Last model output seen on the event bus (ms epoch). */
  lastOutputAt: number
  /** When the current outage was first detected, if any. */
  outageSince: number
  /** Last toast we showed for the current outage. */
  lastNotifyAt: number
  /** True while a probe request is in flight. */
  probing: boolean
  /** True after we announced "connection down"; cleared when output flows again. */
  announcedDown: boolean
  /** What we are waiting on right now. */
  wait: WaitKind
  /** Human-readable detail for the wait (tool name, retry attempt, ...). */
  waitDetail: string
  /** When the current wait began. */
  waitSince: number
  /** Cached title for that session (resolved via the SDK, may lag one event). */
  sessionTitle: string
  /** Set when the session is a subagent (Task tool child); points at the parent. */
  parentID: string
  /** True when the current session is a subagent. */
  isAgent: boolean
  /** Tail of the model's current reasoning text (what it is thinking about). */
  thinking: string
  /** Last idle-probe outcome (undefined = not probed yet). */
  lastProbeOk?: boolean
  /** When the last idle probe ran (ms epoch). */
  lastProbeAt: number
}

function now(): number {
  return Date.now()
}

function newState(sessionID: string): State {
  return {
    sessionID,
    phase: "idle",
    lastOutputAt: now(),
    outageSince: 0,
    lastNotifyAt: 0,
    probing: false,
    announcedDown: false,
    wait: "none",
    waitDetail: "",
    waitSince: now(),
    sessionTitle: "",
    parentID: "",
    isAgent: false,
    thinking: "",
    lastProbeAt: 0,
  }
}

/**
 * Multiple opencode windows share one process and one status file; every event
 * carries a sessionID. Titles are resolved lazily via session.list() and cached —
 * a lookup per event would hammer the server.
 *
 * Subagents (Task tool) are child sessions: they carry a parentID. The resolver
 * records that too, so the viewer can nest agents under their parent conversation.
 */
type SessionMeta = {
  title: string
  parentID?: string
}

function createTitleResolver(client: any) {
  const cache = new Map<string, SessionMeta>()
  let lastFetch = 0

  return async (sessionID: string | undefined): Promise<SessionMeta | undefined> => {
    if (!sessionID) return undefined
    if (cache.has(sessionID)) return cache.get(sessionID)

    // At most one list() per 5s across all unknown sessions.
    if (Date.now() - lastFetch > 5_000) {
      lastFetch = Date.now()
      try {
        const res = await client.session.list()
        const sessions = res?.data ?? res ?? []
        for (const s of sessions) {
          if (!s?.id) continue
          cache.set(s.id, {
            title: typeof s.title === "string" ? s.title : "",
            parentID: s.parentID,
          })
        }
      } catch {
        // Listing failed; keep the short ID.
      }
    }
    return cache.get(sessionID)
  }
}

/* ------------------------------------------------------------------ *
 * Status file (for `watch`-style external viewing)
 * ------------------------------------------------------------------ */

import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const STATUS_DIR = join(homedir(), ".cache", "opencode", "connection-status")
const STATUS_FILE = process.env.OPENCODE_CONN_STATUS_FILE || join(STATUS_DIR, "status.jsonl")

function writeStatus(state: State, extra: Record<string, unknown> = {}): void {
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true })
    const line = JSON.stringify({
      t: new Date().toISOString(),
      phase: state.phase,
      wait: state.wait,
      waitDetail: state.waitDetail,
      waitSec: state.waitSince ? Math.round((now() - state.waitSince) / 1000) : 0,
      sinceOutageMs: state.outageSince ? now() - state.outageSince : 0,
      sessionID: state.sessionID,
      sessionTitle: state.sessionTitle,
      parentID: state.parentID,
      isAgent: state.isAgent,
      thinking: state.thinking,
      lastProbeOk: state.lastProbeOk,
      lastProbeAt: state.lastProbeAt ? new Date(state.lastProbeAt).toISOString() : undefined,
      ...extra,
    })
    appendFileSync(STATUS_FILE, line + "\n")
  } catch {
    // Status file is best-effort; never let it break the plugin.
  }
}

/**
 * Heartbeat: the viewer needs a steady stream of samples to show phase and the
 * timeline, not just notable events. Append one line per session per tick when
 * anything changed since that session's last write.
 */
function heartbeat(state: State, lastKeys: Map<string, string>): void {
  const thinkKey = state.thinking.slice(-40)
  const key = `${state.phase}|${state.wait}|${state.waitDetail}|${thinkKey}`
  if (key === lastKeys.get(state.sessionID)) return
  lastKeys.set(state.sessionID, key)
  writeStatus(state)
}

/* ------------------------------------------------------------------ *
 * Wait tracking
 * ------------------------------------------------------------------ */

/**
 * Records what the session is waiting on. Priority order matters: a retry or a
 * compaction explains silence better than an in-flight model request, and a
 * running tool explains it better than both (the model is done; the tool isn't).
 */
function setWait(state: State, wait: WaitKind, detail: string): void {
  if (state.wait === wait && state.waitDetail === detail) return
  state.wait = wait
  state.waitDetail = detail
  state.waitSince = now()
  state.lastNotifyAt = 0
}

function clearWaitIf(state: State, ...kinds: WaitKind[]): void {
  if (kinds.includes(state.wait)) {
    state.wait = "none"
    state.waitDetail = ""
    state.waitSince = now()
  }
}

/** Short label for a tool part, e.g. "bash" or "read src/foo.ts". */
function toolLabel(tool: string, input: Record<string, unknown> | undefined): string {
  if (tool === "bash" && typeof input?.command === "string") {
    const cmd = input.command.replace(/\s+/g, " ").trim().slice(0, 40)
    return `bash (${cmd})`
  }
  if ((tool === "read" || tool === "edit" || tool === "write") && typeof input?.filePath === "string") {
    return `${tool} ${input.filePath.split(/[\\/]/).pop()}`
  }
  return tool
}

/* ------------------------------------------------------------------ *
 * Toast
 * ------------------------------------------------------------------ */

async function toast(
  client: any,
  title: string,
  message: string,
  variant: ToastVariant,
  duration = 6_000,
): Promise<void> {
  if (!client?.tui?.showToast) {
    console.warn(`[connection-status] ${title}: ${message}`)
    return
  }
  try {
    await client.tui.showToast({ body: { title, message, variant, duration } })
  } catch {
    console.warn(`[connection-status] ${title}: ${message}`)
  }
}

/* ------------------------------------------------------------------ *
 * Provider discovery + fetch patch
 * ------------------------------------------------------------------ */

/** Read provider origins from the config hook; never call the server during plugin initialization. */
function configuredProviders(config: any): { hosts: Set<string>; origins: string[] } {
  const hosts = new Set<string>()
  const origins: string[] = []
  for (const provider of Object.values(config?.provider ?? {}) as any[]) {
    const baseURL = provider?.options?.baseURL
    if (typeof baseURL !== "string" || !URL.canParse(baseURL)) continue
    const url = new URL(baseURL)
    hosts.add(url.host)
    if (!origins.includes(url.origin)) origins.push(url.origin)
  }
  return { hosts, origins }
}

/**
 * Wraps globalThis.fetch so model requests can be counted. Idempotent per process:
 * the plugin file may be evaluated more than once (project + global scopes).
 *
 * In-flight counts are GLOBAL (a request body carries no session id), so the
 * count is stored on the tracker, not on any one session's State. The active
 * session — whichever the event stream last touched — gets the "waiting" phase;
 * per-session truth converges as soon as output events flow.
 */
type Tracker = {
  providerHosts: Set<string>
  inflight: Map<string, number>
  active: State | undefined
  activeOrigin: string | undefined
  probeOrigins: string[]
  probeVersion: number
}

function armFetchTracking(tracker: Tracker): () => void {
  const scope = globalThis as typeof globalThis & { [PATCHED]?: typeof fetch }
  if (scope[PATCHED]) return () => {}
  scope[PATCHED] = globalThis.fetch

  const baseFetch = scope[PATCHED]
  let enabled = true
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
    let host = "", origin = ""
    try {
      const parsed = new URL(url)
      host = parsed.host
      origin = parsed.origin
    } catch {
      host = ""
    }

    const isModelRequest = enabled && host !== "" && tracker.providerHosts.has(host)
    // Probes must not recurse through the tracker, nor extend the waiting window.
    const isProbe = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).has("x-opencode-conn-probe")
    const active = tracker.active

    if (isModelRequest && !isProbe && active) {
      tracker.inflight.set(host, (tracker.inflight.get(host) ?? 0) + 1)
      tracker.activeOrigin = origin
      active.phase = active.phase === "idle" || active.phase === "down" ? "waiting" : active.phase
      active.lastOutputAt = now() // grace: a fresh request resets the silence clock
      // A fresh request supersedes a stale retry claim (opencode re-sends after
      // logging the retry part) and is the fallback owner otherwise.
      if (active.wait === "none" || active.wait === "retry") setWait(active, "model", "等待模型响应")
    }

    const release = () => {
      if (!isModelRequest || isProbe) return
      const count = (tracker.inflight.get(host) ?? 1) - 1
      if (count <= 0) tracker.inflight.delete(host)
      else tracker.inflight.set(host, count)
      if (tracker.inflight.size === 0 && active && (active.phase === "waiting" || active.phase === "stalled")) {
        active.phase = "idle"
        clearWaitIf(active, "model")
      }
    }

    try {
      const response = await baseFetch(input, init)
      release()
      return response
    } catch (error) {
      release()
      // A network-level failure on the model request itself is the strongest signal.
      if (isModelRequest && !isProbe && active && isNetworkFailure(error) && active.outageSince === 0) {
        active.outageSince = now()
        active.phase = "down"
      }
      throw error
    }
  }
  const wrapper = globalThis.fetch
  return () => {
    enabled = false
    if (globalThis.fetch === wrapper) globalThis.fetch = baseFetch
    delete scope[PATCHED]
  }
}

/* ------------------------------------------------------------------ *
 * Probe
 * ------------------------------------------------------------------ */

async function probeOrigin(origin: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${origin}/models`, {
      method: "GET",
      signal: controller.signal,
      headers: { "x-opencode-conn-probe": "1" },
    })
    // Any HTTP response means the tunnel and origin are alive; 401/404 still count.
    return !!response
  } catch (error) {
    if (controller.signal.aborted) return false
    return !isNetworkFailure(error) // ambiguous errors lean reachable
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * Watchdog — iterates every session's state each tick
 * ------------------------------------------------------------------ */

function startWatchdog(
  sessions: Map<string, State>,
  tracker: Tracker,
  settings: Settings,
  client: any,
  lastKeys: Map<string, string>,
): () => void {
  const connection = newState("__connection__")
  let idleProbeAt = 0
  let idleProbeOk: boolean | undefined
  let seenProbeVersion = tracker.probeVersion
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
    const t = now()
    if (seenProbeVersion !== tracker.probeVersion) {
      seenProbeVersion = tracker.probeVersion
      idleProbeAt = 0
      idleProbeOk = undefined
    }

    for (const state of sessions.values()) {
      // Heartbeat first: keep the status file current on every state change so
      // the CLI viewer always has fresh samples, even when nothing notable happens.
      heartbeat(state, lastKeys)

      // Recovery: output flowing again after an announced outage.
      if (state.announcedDown && state.phase !== "down") {
        state.announcedDown = false
        state.outageSince = 0
        await toast(client, "模型连接", "连接已恢复，输出正常", "success", 4_000)
        writeStatus(state, { event: "recovered" })
        continue
      }

      // Long-running known work (tool / subtask / compaction / retry): the wait
      // has a known owner, so report progress once per renotify interval and
      // probe nothing — the wire is not the thing on trial.
      const waitOwned = state.wait === "tool" || state.wait === "subtask" || state.wait === "compaction" || state.wait === "retry"
      if (waitOwned && t - state.waitSince >= settings.renotifyMs && t - state.lastNotifyAt >= settings.renotifyMs) {
        state.lastNotifyAt = t
        const secs = Math.round((t - state.waitSince) / 1000)
        await toast(client, "仍在等待", `${state.waitDetail} — 已运行 ${secs}s`, "info", 5_000)
        writeStatus(state, { event: "wait-notice" })
        continue
      }

      // Stalled: model request in flight, no output for a while, and no known
      // owner for the silence — this is where probing earns its keep. The
      // inflight count is global; only probe on the session that owns it.
      const ownsInflight = tracker.active === state && tracker.inflight.size > 0
      if (ownsInflight && !waitOwned && state.phase !== "down" && t - state.lastOutputAt >= settings.silenceMs) {
        if (state.phase !== "stalled") {
          state.phase = "stalled"
          writeStatus(state, { event: "stalled" })
        }

        if (state.probing || (state.lastProbeAt > 0 && t - state.lastProbeAt < settings.renotifyMs)) continue

        state.probing = true
        state.lastProbeAt = t
        try {
          let reachable = false
          for (const origin of tracker.activeOrigin ? [tracker.activeOrigin] : tracker.probeOrigins) {
            if (await probeOrigin(origin, settings.probeTimeoutMs)) {
              reachable = true
              break
            }
          }

          const secs = Math.round((t - state.lastOutputAt) / 1000)
          if (reachable) {
            // The origin answered; this does not prove the model request works.
            // a toast here would be noise on every long reasoning turn.
            writeStatus(state, { event: "probe-ok", silentSecs: secs })
          } else {
            if (state.outageSince === 0) state.outageSince = t
            state.phase = "down"
            state.announcedDown = true
            state.lastNotifyAt = t
            await toast(
              client,
              "模型连接",
              `静默 ${secs}s 且探测不通 — 连接中断`,
              "error",
              8_000,
            )
            writeStatus(state, { event: "probe-fail" })
          }
        } finally {
          state.probing = false
        }
        continue
      }

      // Waiting with no inflight and no output: nothing to do, idle.
      if (!ownsInflight && state.phase !== "down") {
        if (state.phase === "waiting" || state.phase === "stalled") {
          state.phase = "idle"
          clearWaitIf(state, "model")
        }
      }

    }
    // Probe once per process, including before the first conversation event.
    if (tracker.inflight.size === 0 && tracker.probeOrigins.length > 0 && t - idleProbeAt >= settings.idleProbeMs) {
      idleProbeAt = t
      const results = await Promise.all(tracker.probeOrigins.map((origin) => probeOrigin(origin, settings.probeTimeoutMs)))
      const reachable = results.filter(Boolean).length
      const total = results.length
      const allOk = reachable === total
      const previous = idleProbeOk
      idleProbeOk = allOk
      connection.lastProbeOk = allOk
      connection.lastProbeAt = now()
      writeStatus(connection, { scope: "connection", event: allOk ? "idle-probe-ok" : "idle-probe-fail", reachable, total })
      if (!allOk && previous !== false) await toast(client, "模型连接", `空闲探测：${reachable}/${total} 个端点可达`, "warning", 6_000)
      if (allOk && previous === false) {
        await toast(client, "模型连接", "端点连接已恢复（空闲探测）", "success", 4_000)
        writeStatus(connection, { scope: "connection", event: "idle-recovered", reachable, total })
      }
    }
    } finally { running = false }
  }, 5_000)

  return () => clearInterval(timer)
}

/* ------------------------------------------------------------------ *
 * session.error classification
 * ------------------------------------------------------------------ */

function classify(error: ProviderError | undefined): { variant: ToastVariant; label: string } | undefined {
  const name = error?.name ?? "UnknownError"
  if (name === "MessageAbortedError") return undefined
  if (name === "ProviderAuthError") return { variant: "error", label: "认证失败" }
  if (name === "MessageOutputLengthError") return { variant: "warning", label: "输出达到长度上限" }

  const status = error?.data?.statusCode
  if (typeof status === "number") {
    if (status === 401 || status === 403) return { variant: "error", label: `认证失败 (HTTP ${status})` }
    if (status === 429) return { variant: "warning", label: "请求被限流 (HTTP 429)" }
    if (status >= 500) return { variant: "warning", label: `服务端错误 (HTTP ${status})` }
    return { variant: "error", label: `请求失败 (HTTP ${status})` }
  }
  if (error?.data?.isRetryable) return { variant: "warning", label: "网络连接异常" }
  return { variant: "error", label: "请求失败" }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export const ConnectionStatus = async (input: { client?: any } = {}) => {
  const settings = readSettings()
  const client = input?.client ?? createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" })

  // Per-session states, created on first sight.
  const sessions = new Map<string, State>()
  const lastKeys = new Map<string, string>()

  const tracker: Tracker = {
    providerHosts: new Set(),
    inflight: new Map(),
    active: undefined,
    activeOrigin: undefined,
    probeOrigins: [],
    probeVersion: 0,
  }

  const resolveTitle = createTitleResolver(client)

  /** Get-or-create the state for a session, refreshing cached metadata. */
  const touchSession = async (sessionID: string | undefined): Promise<State | undefined> => {
    if (!sessionID) return undefined
    let state = sessions.get(sessionID)
    if (!state) {
      state = newState(sessionID)
      sessions.set(sessionID, state)
    }
    tracker.active = state

    // Refresh the title occasionally: opencode renames sessions after the
    // first exchange ("New session" -> generated summary).
    const meta = await resolveTitle(sessionID)
    if (meta) {
      if (meta.title && meta.title !== state.sessionTitle) state.sessionTitle = meta.title
      // Guard: some rows report parentID === own id; that is not a subagent.
      if (meta.parentID && meta.parentID !== sessionID) {
        state.parentID = meta.parentID
        state.isAgent = true
      }
    }
    return state
  }

  const stopFetchTracking = armFetchTracking(tracker)
  const stopWatchdog = startWatchdog(sessions, tracker, settings, client, lastKeys)

  let lastErrorKey = ""
  let lastErrorAt = 0

  return {
    async config(config: any) {
      const { hosts, origins } = configuredProviders(config)
      tracker.providerHosts = hosts
      tracker.probeOrigins = origins
      if (tracker.activeOrigin && !origins.includes(tracker.activeOrigin)) tracker.activeOrigin = undefined
      tracker.probeVersion++
      writeStatus(newState("__connection__"), { scope: "connection", event: "connection-configured", total: origins.length })
    },
    async event({ event }: { event: { type?: string; properties?: any } }) {
      // opencode 1.18 streams reasoning through message.part.updated snapshots
      // (part.type === "reasoning"); 2.x uses dedicated delta events. Handle both.

      if (event?.type === "session.next.reasoning.delta") {
        const props = event.properties ?? event.data ?? {}
        const state = await touchSession(props.sessionID)
        const delta = typeof props.delta === "string" ? props.delta : ""
        if (state && delta.trim()) {
          state.lastOutputAt = now()
          state.phase = "streaming"
          clearWaitIf(state, "subtask", "tool", "retry", "compaction")
          const merged = (state.thinking + delta).replace(/\s+/g, " ").trim()
          state.thinking = merged.slice(-160)
        }
        return
      }

      // Reasoning ended: keep the tail until the answer starts or the turn ends,
      // so the viewer can show what was just thought through.
      if (event?.type === "session.next.reasoning.ended") {
        await touchSession(event.properties?.sessionID)
        return
      }

      // Answer text streaming: the thinking phase is over.
      if (event?.type === "session.next.text.delta") {
        const props = event.properties ?? event.data ?? {}
        const state = await touchSession(props.sessionID)
        if (state && typeof props.delta === "string" && props.delta.trim()) {
          state.lastOutputAt = now()
          state.phase = "streaming"
          clearWaitIf(state, "subtask", "tool", "retry", "compaction")
          state.thinking = ""
        }
        return
      }

      if (event?.type === "message.part.updated") {
        const part = event.properties?.part
        const state = await touchSession(part?.sessionID ?? event.properties?.sessionID)
        if (!state) return

        if (part?.type === "text" || part?.type === "reasoning") {
          state.lastOutputAt = now()
          // Output flowing is proof the wire is back, even if we never saw the
          // request complete: flip phase so the watchdog can announce recovery.
          state.phase = "streaming"
          clearWaitIf(state, "subtask", "tool", "retry", "compaction")
          // Reasoning text IS the model's thinking — keep a short tail so the
          // viewer can show what the thinking is about. Text parts clear it:
          // once the answer starts, the thinking phase is over.
          if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
            state.thinking = part.text.replace(/\s+/g, " ").trim().slice(-160)
          } else if (part.type === "text") {
            state.thinking = ""
          }
          return
        }

        if (part?.type === "step-finish") {
          state.lastOutputAt = now()
          state.thinking = ""
          if (state.phase !== "down") state.phase = "idle"
          clearWaitIf(state, "subtask", "tool", "retry", "compaction", "model")
          return
        }

        // A tool call: pending -> running -> completed/error. The running phase
        // is the "waiting on a program" window.
        if (part?.type === "tool") {
          const status = part.state?.status
          if (status === "running") {
            setWait(state, "tool", toolLabel(part.tool, part.state?.input))
            state.lastOutputAt = now()
          } else if (status === "completed" || status === "error") {
            clearWaitIf(state, "tool")
            state.lastOutputAt = now()
          }
          return
        }

        // A subtask (Task tool): waiting on another agent.
        if (part?.type === "subtask") {
          setWait(state, "subtask", "子代理运行中")
          state.lastOutputAt = now()
          return
        }

        // Context compaction: the summarizer model is working.
        if (part?.type === "compaction") {
          setWait(state, "compaction", part.auto ? "自动压缩上下文" : "手动压缩上下文")
          state.lastOutputAt = now()
          return
        }

        // Provider retry: opencode is re-sending the request itself.
        if (part?.type === "retry") {
          setWait(state, "retry", `第 ${part.attempt} 次重试`)
          state.lastOutputAt = now()
          return
        }

        return
      }

      if (event?.type === "session.error") {
        const error: ProviderError | undefined = event.properties?.error
        const verdict = classify(error)
        if (!verdict) return

        const message = (error?.data?.message ?? error?.message ?? "未知错误").replace(/\s+/g, " ").trim().slice(0, 300)
        const key = `${verdict.label}:${message}`
        const t = now()
        if (key === lastErrorKey && t - lastErrorAt < 3_000) return
        lastErrorKey = key
        lastErrorAt = t

        await toast(client, "模型连接", `${verdict.label} — ${message}`, verdict.variant, 8_000)
        const state = await touchSession(event.properties?.sessionID)
        if (state) writeStatus(state, { event: "session-error", label: verdict.label })
        return
      }

      if (event?.type === "session.idle") {
        const state = await touchSession(event.properties?.sessionID)
        if (!state) return
        if (state.phase !== "down") state.phase = "idle"
        state.lastOutputAt = now()
        state.wait = "none"
        state.waitDetail = ""
        state.waitSince = now()
        state.thinking = ""
        writeStatus(state, { event: "session-idle" })
      }
    },
    dispose: () => {
      stopWatchdog()
      stopFetchTracking()
    },
  }
}

export default { id: "opencode-connection-status", server: ConnectionStatus }
