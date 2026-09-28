/**
 * opencode-connection-status
 *
 * 会话事件记录真实活动；fetch 跟踪响应正文的完整生命周期。
 * 请求不含会话 ID，发送时关联最近涉及的会话，归属仍有近似性。
 * 同一进程的插件实例共用跟踪器、状态表和定时器。
 * 阶段变化立即记录，连续推理每 5 秒采样；端点探测只验证 HTTP 可达性。
 */

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
  /** Repeat probes during model silence, independently of toast throttling. */
  probeIntervalMs: number
}

const PATCHED = Symbol.for("opencode-connection-status.patched")
const RUNTIME = Symbol.for("opencode-connection-status.runtime")

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
    probeIntervalMs: numberSetting("OPENCODE_CONN_PROBE_INTERVAL_MS", 60_000) || 60_000,
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
  busy: boolean
  requests: number
  activityVersion: number
  providerBaseURL?: string
  client?: any
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
  /** Last session-probe outcome (undefined = not probed yet). */
  lastProbeOk?: boolean
  /** When the last session probe ran (ms epoch). */
  lastProbeAt: number
}

function now(): number {
  return Date.now()
}

function newState(sessionID: string): State {
  return {
    sessionID,
    phase: "idle",
    busy: false,
    requests: 0,
    activityVersion: 0,
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
        const res = await client?.session?.list?.()
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
      processID: process.pid,
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

type StatusKeys = { transition: string; thinking: string; event?: string }

/** Phase/wait changes are durable immediately; continuous reasoning is sampled. */
function recordStatus(
  state: State,
  lastKeys: Map<string, StatusKeys>,
  includeThinking = false,
  extra: Record<string, unknown> = {},
  force = false,
): void {
  const transition = JSON.stringify([
    state.phase, state.wait, state.waitDetail, state.sessionTitle,
    state.parentID, state.isAgent, Boolean(state.thinking),
  ])
  const thinking = state.thinking.slice(-40)
  const previous = lastKeys.get(state.sessionID)
  if (!force && previous?.transition === transition && (!includeThinking || previous.thinking === thinking)) return
  lastKeys.set(state.sessionID, { transition, thinking, event: typeof extra.event === "string" ? extra.event : undefined })
  writeStatus(state, extra)
}

function heartbeat(state: State, lastKeys: Map<string, StatusKeys>): void {
  recordStatus(state, lastKeys, true)
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

type Endpoint = { baseURL: string; host: string; probeURL: string }

/** Keep the API path; probes never carry credentials from the provider config. */
function configuredProviders(config: any): Endpoint[] {
  const endpoints = new Map<string, Endpoint>()
  for (const provider of Object.values(config?.provider ?? {}) as any[]) {
    const baseURL = provider?.options?.baseURL
    if (typeof baseURL !== "string" || !URL.canParse(baseURL)) continue
    const url = new URL(baseURL)
    if (url.protocol !== "https:" && url.protocol !== "http:") continue
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    const base = url.href.replace(/\/+$/, "")
    endpoints.set(base, { baseURL: base, host: url.host, probeURL: `${base}/models` })
  }
  return [...endpoints.values()]
}

/**
 * Wraps globalThis.fetch so model requests can be counted. Idempotent per process:
 * the plugin file may be evaluated more than once (project + global scopes).
 *
 * The global count suppresses idle probes. Each request keeps the session
 * associated at its start, so another session's event cannot steal it later.
 * This association remains approximate because provider bodies lack session IDs.
 */
type Tracker = {
  endpoints: Endpoint[]
  inflight: Map<string, number>
  active: State | undefined
  probeVersion: number
}

/** Forward the original bytes on demand; do not clone or drain a model stream. */
function trackBody(response: Response, finish: (error?: unknown) => void): Response {
  if (!response.body) { finish(); return response }
  const source = response.body
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= source.getReader()
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          finish()
          reader.releaseLock()
          controller.close()
        } else {
          controller.enqueue(chunk.value)
        }
      } catch (error) {
        finish(error)
        reader.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      finish()
      try { await (reader ? reader.cancel(reason) : source.cancel(reason)) }
      finally { reader?.releaseLock() }
    },
  }, { highWaterMark: 0 })
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  })
  return wrapped
}

function armFetchTracking(tracker: Tracker, record: (state: State) => void): () => void {
  const scope = globalThis as typeof globalThis & { [PATCHED]?: typeof fetch }
  if (scope[PATCHED]) return () => {}
  scope[PATCHED] = globalThis.fetch

  const baseFetch = scope[PATCHED]
  let enabled = true
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
    const endpoint = enabled ? tracker.endpoints
      .filter((item) => url === item.baseURL || url.startsWith(`${item.baseURL}/`))
      .sort((a, b) => b.baseURL.length - a.baseURL.length)[0] : undefined
    // Probes must not recurse through the tracker, nor extend the waiting window.
    const isProbe = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).has("x-opencode-conn-probe")
    const tracked = Boolean(endpoint && !isProbe)
    const active = tracked ? tracker.active : undefined
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    let released = false

    if (tracked) tracker.inflight.set(endpoint!.host, (tracker.inflight.get(endpoint!.host) ?? 0) + 1)
    if (active) {
      active.requests++
      active.activityVersion++
      active.providerBaseURL = endpoint!.baseURL
      active.lastProbeAt = 0
      active.phase = active.phase === "idle" || active.phase === "down" ? "waiting" : active.phase
      active.lastOutputAt = now() // grace: a fresh request resets the silence clock
      // A fresh request supersedes a stale retry claim (opencode re-sends after
      // logging the retry part) and is the fallback owner otherwise.
      if (active.wait === "none" || active.wait === "retry") setWait(active, "model", "等待模型响应")
      record(active)
    }

    const release = (error?: unknown) => {
      if (!tracked || released) return
      released = true
      signal?.removeEventListener("abort", aborted)
      const host = endpoint!.host
      const count = (tracker.inflight.get(host) ?? 1) - 1
      if (count <= 0) tracker.inflight.delete(host)
      else tracker.inflight.set(host, count)
      if (!active) return
      active.requests = Math.max(0, active.requests - 1)
      active.activityVersion++
      if (isNetworkFailure(error)) {
        if (active.outageSince === 0) active.outageSince = now()
        active.phase = "down"
      } else if (active.requests === 0 && !active.busy && (active.phase === "waiting" || active.phase === "stalled")) {
        active.phase = "idle"
        clearWaitIf(active, "model")
      }
      record(active)
    }
    const aborted = () => release()
    if (tracked) signal?.addEventListener("abort", aborted, { once: true })

    try {
      const response = await baseFetch(input, init)
      return tracked ? trackBody(response, release) : response
    } catch (error) {
      release(error)
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

async function probeEndpoint(endpoint: Endpoint, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(endpoint.probeURL, {
      method: "GET",
      signal: controller.signal,
      headers: { "x-opencode-conn-probe": "1" },
    })
    // Any HTTP response means the tunnel and origin are alive; 401/404 still count.
    // Headers are enough for reachability. Cancel the unused body promptly.
    void response.body?.cancel().catch(() => {})
    return true
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
  getClient: () => any,
  lastKeys: Map<string, StatusKeys>,
): () => void {
  const connection = newState("__connection__")
  let idleProbeAt = 0
  let idleProbeOk: boolean | undefined
  let seenProbeVersion = tracker.probeVersion
  let idleProbing = false
  let stopped = false
  let heartbeatAt = 0
  const pendingProbes = new Map<string, Promise<boolean>>()
  const probe = (endpoint: Endpoint) => {
    let pending = pendingProbes.get(endpoint.baseURL)
    if (!pending) {
      pending = probeEndpoint(endpoint, settings.probeTimeoutMs)
        .finally(() => pendingProbes.delete(endpoint.baseURL))
      pendingProbes.set(endpoint.baseURL, pending)
    }
    return pending
  }

  const probeSession = async (state: State, t: number) => {
    state.probing = true
    state.lastProbeAt = t
    const version = state.activityVersion
    const configVersion = tracker.probeVersion
    try {
      const endpoints = state.providerBaseURL
        ? tracker.endpoints.filter((item) => item.baseURL === state.providerBaseURL)
        : tracker.endpoints
      const results = await Promise.all(endpoints.map(probe))
      // Output, cancellation or a configuration change makes this result stale.
      if (stopped || version !== state.activityVersion || configVersion !== tracker.probeVersion) return
      const reachable = results.some(Boolean)
      state.lastProbeOk = reachable
      const secs = Math.round((now() - state.lastOutputAt) / 1000)
      if (reachable) {
        state.phase = "stalled"
        recordStatus(state, lastKeys, false, { event: "probe-ok", silentSecs: secs }, true)
      } else {
        if (state.outageSince === 0) state.outageSince = t
        state.phase = "down"
        const notify = !state.announcedDown || (settings.renotifyMs > 0 && t - state.lastNotifyAt >= settings.renotifyMs)
        state.announcedDown = true
        recordStatus(state, lastKeys, false, { event: "probe-fail", silentSecs: secs }, true)
        if (notify) {
          state.lastNotifyAt = t
          void toast(state.client ?? getClient(), "模型连接", `静默 ${secs}s 且探测不通 — 连接中断`, "error", 8_000)
        }
      }
    } finally {
      if (version === state.activityVersion) state.lastProbeAt = now()
      state.probing = false
    }
  }

  const probeIdle = async (t: number) => {
    idleProbing = true
    idleProbeAt = t
    const version = tracker.probeVersion
    try {
      const results = await Promise.all(tracker.endpoints.map(probe))
      if (stopped || version !== tracker.probeVersion) return
      const reachable = results.filter(Boolean).length
      const total = results.length
      const allOk = reachable === total
      const previous = idleProbeOk
      idleProbeOk = allOk
      connection.lastProbeOk = allOk
      connection.lastProbeAt = now()
      writeStatus(connection, { scope: "connection", event: allOk ? "idle-probe-ok" : "idle-probe-fail", reachable, total })
      if (!allOk && previous !== false) void toast(getClient(), "模型连接", `空闲探测：${reachable}/${total} 个端点可达`, "warning", 6_000)
      if (allOk && previous === false) {
        void toast(getClient(), "模型连接", "端点连接已恢复（空闲探测）", "success", 4_000)
        writeStatus(connection, { scope: "connection", event: "idle-recovered", reachable, total })
      }
    } finally { idleProbeAt = version === tracker.probeVersion ? now() : 0; idleProbing = false }
  }

  // Up to 1s scheduling precision; shorter configured intervals work as well.
  const tickMs = Math.max(50, Math.min(1_000, ...[
    settings.silenceMs, settings.probeIntervalMs, settings.idleProbeMs, settings.renotifyMs,
  ].filter((value) => value > 0).map((value) => value / 4)))
  const timer = setInterval(() => {
    const t = now()
    if (seenProbeVersion !== tracker.probeVersion) {
      seenProbeVersion = tracker.probeVersion
      idleProbeAt = 0
      idleProbeOk = undefined
    }
    const sampleThinking = t - heartbeatAt >= 5_000
    if (sampleThinking) heartbeatAt = t
    for (const state of sessions.values()) {
      if (sampleThinking) heartbeat(state, lastKeys)
      if (state.announcedDown && state.phase === "streaming") {
        state.announcedDown = false
        state.outageSince = 0
        void toast(state.client ?? getClient(), "模型连接", "连接已恢复，输出正常", "success", 4_000)
        recordStatus(state, lastKeys, false, { event: "recovered" }, true)
      }
      const waitOwned = ["tool", "subtask", "compaction", "retry"].includes(state.wait)
      if (waitOwned) {
        if (settings.renotifyMs > 0 && t - state.waitSince >= settings.renotifyMs && t - state.lastNotifyAt >= settings.renotifyMs) {
          state.lastNotifyAt = t
          const secs = Math.round((t - state.waitSince) / 1000)
          recordStatus(state, lastKeys, false, { event: "wait-notice" }, true)
          void toast(state.client ?? getClient(), "仍在等待", `${state.waitDetail} — 已运行 ${secs}s`, "info", 5_000)
        }
        continue
      }
      if ((state.busy || state.requests > 0) && tracker.endpoints.length > 0 && settings.silenceMs > 0 && t - state.lastOutputAt >= settings.silenceMs) {
        if (state.phase !== "stalled" && state.phase !== "down") {
          state.phase = "stalled"
          recordStatus(state, lastKeys, false, { event: "stalled" }, true)
        }
        if (!state.probing && (state.lastProbeAt === 0 || t - state.lastProbeAt >= settings.probeIntervalMs)) {
          void probeSession(state, t)
        }
      }
    }
    const busy = tracker.inflight.size > 0 || [...sessions.values()].some((state) => state.busy || ["tool", "subtask", "compaction", "retry"].includes(state.wait))
    if (!busy && !idleProbing && tracker.endpoints.length > 0 && settings.idleProbeMs > 0 && t - idleProbeAt >= settings.idleProbeMs) {
      void probeIdle(t)
    }
  }, tickMs)

  return () => { stopped = true; clearInterval(timer) }
}

type Runtime = {
  sessions: Map<string, State>
  lastKeys: Map<string, StatusKeys>
  tracker: Tracker
  owners: Map<object, { client: any; endpoints: Endpoint[] }>
  stop: () => void
}

function createRuntime(settings: Settings): Runtime {
  const sessions = new Map<string, State>()
  const lastKeys = new Map<string, StatusKeys>()
  const tracker: Tracker = { endpoints: [], inflight: new Map(), active: undefined, probeVersion: 0 }
  const owners: Runtime["owners"] = new Map()
  let stopped = false
  const stopFetch = armFetchTracking(tracker, (state) => { if (!stopped) recordStatus(state, lastKeys) })
  const stopWatchdog = startWatchdog(sessions, tracker, settings, () => owners.values().next().value?.client, lastKeys)
  return { sessions, lastKeys, tracker, owners, stop: () => { stopped = true; stopWatchdog(); stopFetch() } }
}

function refreshEndpoints(runtime: Runtime): void {
  const unique = new Map<string, Endpoint>()
  for (const owner of runtime.owners.values()) {
    for (const endpoint of owner.endpoints) unique.set(endpoint.baseURL, endpoint)
  }
  const endpoints = [...unique.values()].sort((a, b) => a.baseURL.localeCompare(b.baseURL))
  if (runtime.tracker.probeVersion > 0 && endpoints.map((item) => item.baseURL).join("\n") === runtime.tracker.endpoints.map((item) => item.baseURL).join("\n")) return
  runtime.tracker.endpoints = endpoints
  runtime.tracker.probeVersion++
  for (const state of runtime.sessions.values()) {
    if (state.providerBaseURL && !unique.has(state.providerBaseURL)) state.providerBaseURL = undefined
    state.lastProbeAt = 0
    state.activityVersion++
  }
  writeStatus(newState("__connection__"), {
    scope: "connection", event: "connection-configured", total: endpoints.length,
    probeURLs: endpoints.map((endpoint) => endpoint.probeURL),
  })
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
  // OpenCode supplies its correctly scoped client. No guessed localhost address.
  const client = input?.client
  const scope = globalThis as typeof globalThis & { [RUNTIME]?: Runtime }
  const runtime = scope[RUNTIME] ??= createRuntime(readSettings())
  const { sessions, lastKeys, tracker } = runtime
  const owner = { client, endpoints: [] as Endpoint[] }
  runtime.owners.set(owner, owner)
  let disposed = false
  const record = (state: State) => { if (!disposed) recordStatus(state, lastKeys) }
  // Only part kinds are retained, never the full message snapshots.
  const partKinds = new Map<string, "text" | "reasoning">()
  const messageRoles = new Map<string, string>()
  const isUserMessage = (sessionID: string, messageID: string) => messageRoles.get(`${sessionID}:${messageID}`) === "user"

  const resolveTitle = createTitleResolver(client)

  /** Get-or-create the state for a session, refreshing cached metadata. */
  const touchSession = (sessionID: string | undefined): State | undefined => {
    if (!sessionID) return undefined
    let state = sessions.get(sessionID)
    if (!state) {
      state = newState(sessionID)
      sessions.set(sessionID, state)
    }
    tracker.active = state
    state.client = client

    // Refresh the title occasionally: opencode renames sessions after the
    // first exchange ("New session" -> generated summary).
    // Metadata must not delay activity: a fast turn may finish while list() is
    // pending. Resolve titles in the background and enrich the current state.
    const current = state
    void resolveTitle(sessionID).then((meta) => {
      if (disposed || !meta) return
      if (meta.title && meta.title !== current.sessionTitle) current.sessionTitle = meta.title
      // Guard: some rows report parentID === own id; that is not a subagent.
      if (meta.parentID && meta.parentID !== sessionID) {
        current.parentID = meta.parentID
        current.isAgent = true
      }
      record(current)
    })
    return state
  }

  const markIdle = (state: State) => {
    state.phase = "idle"
    state.busy = false
    state.activityVersion++
    state.wait = "none"
    state.waitDetail = ""
    state.waitSince = now()
    state.thinking = ""
    recordStatus(state, lastKeys, true, { event: "session-idle" }, lastKeys.get(state.sessionID)?.event !== "session-idle")
  }

  const markOutput = (state: State) => {
    state.busy = true
    state.activityVersion++
    state.lastOutputAt = now()
    state.lastProbeAt = 0
    state.phase = "streaming"
    clearWaitIf(state, "subtask", "tool", "retry", "compaction", "model")
  }

  let lastErrorKey = ""
  let lastErrorAt = 0

  return {
    async config(config: any) {
      if (disposed) return
      owner.endpoints = configuredProviders(config)
      refreshEndpoints(runtime)
    },
    async event({ event }: { event: { type?: string; properties?: any } }) {
      if (disposed) return
      if (event?.type === "message.updated") {
        const info = event.properties?.info
        if (info?.id && info.sessionID && info.role) {
          messageRoles.set(`${info.sessionID}:${info.id}`, info.role)
          if (messageRoles.size > 1_000) messageRoles.delete(messageRoles.keys().next().value!)
        }
        return
      }
      if (event?.type === "session.status") {
        const props = event.properties ?? event.data ?? {}
        const state = touchSession(props.sessionID)
        if (!state) return
        if (props.status?.type === "idle") {
          markIdle(state)
        } else if (props.status?.type === "busy") {
          state.busy = true
          state.activityVersion++
          if (state.phase === "idle") {
            state.phase = "waiting"
            state.lastOutputAt = now()
            if (state.wait === "none") setWait(state, "model", "等待模型响应")
          }
          record(state)
        } else if (props.status?.type === "retry") {
          state.busy = true
          state.activityVersion++
          if (state.phase !== "down") state.phase = "waiting"
          setWait(state, "retry", `第 ${props.status.attempt} 次重试`)
          state.lastOutputAt = now()
          record(state)
        }
        return
      }
      if (event?.type === "message.part.delta") {
        const props = event.properties ?? {}
        if (isUserMessage(props.sessionID, props.messageID)) return
        const state = touchSession(props.sessionID)
        if (!state || props.field !== "text" || typeof props.delta !== "string" || !props.delta) return
        markOutput(state)
        const kind = partKinds.get(`${props.sessionID}:${props.partID}`)
        if (kind === "reasoning") state.thinking = (state.thinking + props.delta).replace(/\s+/g, " ").trim().slice(-160)
        else if (kind === "text") state.thinking = ""
        record(state)
        return
      }
      // opencode 1.18 streams reasoning through message.part.updated snapshots
      // (part.type === "reasoning"); 2.x uses dedicated delta events. Handle both.

      if (event?.type === "session.next.reasoning.delta") {
        const props = event.properties ?? event.data ?? {}
        const state = touchSession(props.sessionID)
        const delta = typeof props.delta === "string" ? props.delta : ""
        if (state && delta.trim()) {
          markOutput(state)
          const merged = (state.thinking + delta).replace(/\s+/g, " ").trim()
          state.thinking = merged.slice(-160)
          record(state)
        }
        return
      }

      // Reasoning ended: keep the tail until the answer starts or the turn ends,
      // so the viewer can show what was just thought through.
      if (event?.type === "session.next.reasoning.ended") {
        touchSession(event.properties?.sessionID)
        return
      }

      // Answer text streaming: the thinking phase is over.
      if (event?.type === "session.next.text.delta") {
        const props = event.properties ?? event.data ?? {}
        const state = touchSession(props.sessionID)
        if (state && typeof props.delta === "string" && props.delta.trim()) {
          markOutput(state)
          state.thinking = ""
          record(state)
        }
        return
      }

      if (event?.type === "message.part.updated") {
        const part = event.properties?.part
        if ((part?.type === "text" || part?.type === "reasoning") && isUserMessage(part.sessionID, part.messageID)) return
        const state = touchSession(part?.sessionID ?? event.properties?.sessionID)
        if (!state) return

        if (part?.type === "text" || part?.type === "reasoning") {
          if (part.id) {
            partKinds.set(`${state.sessionID}:${part.id}`, part.type)
            if (partKinds.size > 1_000) partKinds.delete(partKinds.keys().next().value!)
          }
          // An empty part announces its kind, but is not model output yet.
          if (typeof part.text !== "string" || !part.text) return
          markOutput(state)
          // Reasoning text IS the model's thinking — keep a short tail so the
          // viewer can show what the thinking is about. Text parts clear it:
          // once the answer starts, the thinking phase is over.
          if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
            state.thinking = part.text.replace(/\s+/g, " ").trim().slice(-160)
          } else if (part.type === "text") {
            state.thinking = ""
          }
          record(state)
          return
        }

        if (part?.type === "step-finish") {
          state.activityVersion++
          state.lastOutputAt = now()
          state.thinking = ""
          state.phase = state.busy ? "waiting" : "idle"
          clearWaitIf(state, "subtask", "tool", "retry", "compaction", "model")
          record(state)
          return
        }

        // A tool call: pending -> running -> completed/error. The running phase
        // is the "waiting on a program" window.
        if (part?.type === "tool") {
          const status = part.state?.status
          if (status === "running") {
            state.activityVersion++
            setWait(state, "tool", toolLabel(part.tool, part.state?.input))
            state.lastOutputAt = now()
          } else if (status === "completed" || status === "error") {
            state.activityVersion++
            clearWaitIf(state, "tool")
            state.lastOutputAt = now()
          }
          record(state)
          return
        }

        // A subtask (Task tool): waiting on another agent.
        if (part?.type === "subtask") {
          state.activityVersion++
          setWait(state, "subtask", "子代理运行中")
          state.lastOutputAt = now()
          record(state)
          return
        }

        // Context compaction: the summarizer model is working.
        if (part?.type === "compaction") {
          state.activityVersion++
          setWait(state, "compaction", part.auto ? "自动压缩上下文" : "手动压缩上下文")
          state.lastOutputAt = now()
          record(state)
          return
        }

        // Provider retry: opencode is re-sending the request itself.
        if (part?.type === "retry") {
          state.activityVersion++
          setWait(state, "retry", `第 ${part.attempt} 次重试`)
          state.lastOutputAt = now()
          record(state)
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
        const state = touchSession(event.properties?.sessionID)
        if (state) recordStatus(state, lastKeys, false, { event: "session-error", label: verdict.label }, true)
        return
      }

      if (event?.type === "session.idle") {
        const state = touchSession(event.properties?.sessionID)
        if (!state) return
        markIdle(state)
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      partKinds.clear()
      messageRoles.clear()
      runtime.owners.delete(owner)
      if (runtime.owners.size > 0) refreshEndpoints(runtime)
      else {
        runtime.stop()
        if (scope[RUNTIME] === runtime) delete scope[RUNTIME]
      }
    },
  }
}

export default { id: "opencode-connection-status", server: ConnectionStatus }
