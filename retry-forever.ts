/**
 * opencode-retry-forever
 *
 * Keeps long-running opencode sessions alive across transient provider failures.
 *
 * opencode's built-in retry gives up after a handful of exponentially-backed-off
 * attempts, and its matcher misses several real failure shapes (DNS failures, some
 * gateway 5xx). When it gives up, SessionRunner.drain throws and the entire session
 * dies with "Failed to drain Session" — fatal if you leave agents running for hours.
 *
 * This plugin wraps globalThis.fetch, which is what opencode's request executor
 * ultimately calls (effect/http/FetchHttpClient/Fetch defaults to `() => globalThis.fetch`),
 * so retries happen below the session runner and the session never learns it flinched.
 */

const PATCHED = Symbol.for("opencode-retry-forever.patched")
const SUBSCRIBED = Symbol.for("opencode-retry-forever.subscribed")

const RETRYABLE_STATUS = new Set([
  408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 527, 529, 530,
])

/**
 * Network-level failures, where fetch throws instead of returning a response.
 *
 * Two vocabularies matter here. Node/undici reports POSIX errno strings (ENOTFOUND,
 * ECONNRESET); Bun — which is what opencode actually runs on — reports its own codes
 * (ConnectionRefused, FailedToOpenSocket, DNSResolutionFailed) with prose messages like
 * "Unable to connect. Is the computer able to access the url?". Matching only the POSIX
 * set silently misses every connect failure under Bun, which is the same blind spot that
 * makes opencode's own retry give up on an unreachable provider.
 */
const RETRYABLE_ERROR =
  /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EADDRNOTAVAIL|EPIPE|UND_ERR|ConnectionClosed|ConnectionRefused|ConnectionTimeout|DNSResolutionFailed|FailedToOpenSocket|IdleTimeout|LifetimeTimeout|socket hang up|fetch failed|network error|terminated|premature close|other side closed|connection (?:closed|reset|error|timeout)|unable to connect|was there a typo in the url or port|socket connection was closed|handshake|certificate verification/i

type Settings = {
  delayMs: number
  maxAttempts: number
  honorRetryAfter: boolean
  maxRetryAfterMs: number
  verbose: boolean
}

function numberSetting(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`opencode-retry-forever: ${key} must be a non-negative number, got "${raw}"`)
  return parsed
}

function booleanSetting(key: string, fallback: boolean): boolean {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === "") return fallback
  return !/^(0|false|no|off)$/i.test(raw.trim())
}

function readSettings(): Settings {
  return {
    delayMs: numberSetting("OPENCODE_RETRY_DELAY_MS", 250),
    maxAttempts: numberSetting("OPENCODE_RETRY_MAX_ATTEMPTS", 0),
    honorRetryAfter: booleanSetting("OPENCODE_RETRY_HONOR_RETRY_AFTER", true),
    maxRetryAfterMs: numberSetting("OPENCODE_RETRY_MAX_RETRY_AFTER_MS", 60_000),
    verbose: booleanSetting("OPENCODE_RETRY_VERBOSE", true),
  }
}

function isAbort(error: unknown, signal: AbortSignal | null | undefined): boolean {
  if (signal?.aborted) return true
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ""
  const code = (error as NodeJS.ErrnoException).code
  return `${error.name}: ${error.message}${cause}${code ? ` (${code})` : ""}`
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  if (typeof code === "string" && RETRYABLE_ERROR.test(code)) return true
  return RETRYABLE_ERROR.test(describe(error))
}

/** `Retry-After` is either delta-seconds or an HTTP-date. */
function retryAfterMs(response: Response, settings: Settings): number | undefined {
  if (!settings.honorRetryAfter) return undefined
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(ms, settings.maxRetryAfterMs)
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * A request may only be sent once — a `Request` object's body is consumed by the first
 * attempt and a `ReadableStream` body cannot be rewound. Materialise both into a plain
 * url + init that can be replayed verbatim on every attempt.
 */
async function replayable(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<{ url: string; init: RequestInit }> {
  if (input instanceof Request) {
    const request = init ? new Request(input, init) : input
    const buffered = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer()
    return {
      url: request.url,
      init: {
        method: request.method,
        headers: request.headers,
        body: buffered?.byteLength ? buffered : undefined,
        signal: request.signal,
        credentials: request.credentials,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        mode: request.mode,
        cache: request.cache,
        integrity: request.integrity,
        keepalive: request.keepalive,
      },
    }
  }

  const url = input instanceof URL ? input.href : input
  if (!(init?.body instanceof ReadableStream)) return { url, init: init ?? {} }
  return { url, init: { ...init, body: await new Response(init.body).arrayBuffer() } }
}

function createRetryingFetch(baseFetch: typeof fetch, settings: Settings): typeof fetch {
  return async function retryingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const { url, init: attemptInit } = await replayable(input, init)
    const signal = attemptInit.signal
    const host = new URL(url).host

    for (let attempt = 1; ; attempt++) {
      const last = settings.maxAttempts > 0 && attempt >= settings.maxAttempts

      let delay: number
      try {
        const response = await baseFetch(url, attemptInit)
        if (!RETRYABLE_STATUS.has(response.status) || last) return response
        delay = retryAfterMs(response, settings) ?? settings.delayMs
        // Drain the body so the connection is released back to the pool.
        await response.body?.cancel()
        if (settings.verbose)
          console.warn(
            `[retry-forever] ${host} HTTP ${response.status} — attempt ${attempt} failed, retrying in ${delay}ms`,
          )
      } catch (error) {
        if (isAbort(error, signal) || !isRetryableError(error) || last) throw error
        delay = settings.delayMs
        if (settings.verbose)
          console.warn(
            `[retry-forever] ${host} ${describe(error)} — attempt ${attempt} failed, retrying in ${delay}ms`,
          )
      }

      await sleep(delay, signal)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Auto-resume: recovering a turn that died with an unknown finish     *
 * ------------------------------------------------------------------ */

/**
 * Transport retries cannot save a turn that the provider ended mid-flight: the request
 * succeeded, the stream opened, and then it stopped with `finish: "unknown"`. opencode
 * schedules a couple of retries and then gives up, which kills the session. Re-sending the
 * user's own text restarts the turn instead.
 */
const RESUME_TTL_MS = 10 * 60 * 1000

type AssistantInfo = {
  role?: string
  providerID?: string
  modelID?: string
  summary?: unknown
  finish?: string
  parentID?: string
  tokens?: { output?: number }
}

type ResumeSettings = {
  provider: string
  model: string
  delayMs: number
  maxAttempts: number
}

function readResumeSettings(): ResumeSettings {
  return {
    provider: process.env.OPENCODE_RESUME_PROVIDER ?? "opencode-go",
    model: process.env.OPENCODE_RESUME_MODEL ?? "ox-alpha-free",
    delayMs: numberSetting("OPENCODE_RESUME_DELAY_MS", 3000),
    maxAttempts: numberSetting("OPENCODE_RESUME_MAX_ATTEMPTS", 0),
  }
}

/**
 * Decides whether a finished assistant message represents a dropped turn worth restarting.
 *
 * A zero-token `unknown` finish is a deliberate abort — a denied permission, a compaction,
 * an interrupt — and resending there would fight the user. Only a turn that produced output
 * and then stopped without a reason is a real drop.
 */
export function shouldResume(info: AssistantInfo | undefined, settings: ResumeSettings): boolean {
  if (!info || info.role !== "assistant") return false
  if (settings.provider !== "*" && info.providerID !== settings.provider) return false
  if (settings.model !== "*" && !(info.modelID ?? "").startsWith(settings.model)) return false
  if (info.summary) return false
  if (info.finish !== "unknown") return false
  return (info.tokens?.output ?? 0) > 0
}

type ResumeState = { attempts: number; scheduled: boolean; lastActivity: number }

/** Keyed by session + prompt text: a resend creates a new message id, so the text is the stable identity. */
function createResumer(client: any, settings: ResumeSettings) {
  const states = new Map<string, ResumeState>()

  const prune = () => {
    const now = Date.now()
    for (const [key, state] of states) {
      if (!state.scheduled && now - state.lastActivity > RESUME_TTL_MS) states.delete(key)
    }
  }

  const send = (sessionID: string, text: string, key: string, state: ResumeState) => {
    if (settings.maxAttempts > 0 && state.attempts > settings.maxAttempts) {
      states.delete(key)
      return
    }
    state.scheduled = true
    state.lastActivity = Date.now()
    setTimeout(async () => {
      console.warn(
        `[retry-forever] turn dropped (finish=unknown) — resend ${state.attempts}${settings.maxAttempts > 0 ? `/${settings.maxAttempts}` : ""} for ${sessionID}`,
      )
      try {
        const res = await client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text }] } })
        if (res?.error) throw new Error(String(res.error))
        state.scheduled = false
        state.lastActivity = Date.now()
      } catch (error) {
        console.warn(`[retry-forever] resend failed for ${sessionID}: ${describe(error)}`)
        state.attempts += 1
        send(sessionID, text, key, state)
      }
    }, settings.delayMs)
  }

  return async (sessionID: string, messageID: string) => {
    prune()

    const message = await client.session.message({ path: { id: sessionID, messageID } })
    const info: AssistantInfo | undefined = message?.data?.info
    if (!shouldResume(info, settings)) return

    const userMessageID = info?.parentID
    if (!userMessageID) return

    const user = await client.session.message({ path: { id: sessionID, messageID: userMessageID } })
    const text = user?.data?.parts?.find((part: { type?: string }) => part.type === "text")?.text
    if (!text) return

    const key = `${sessionID}:${text}`
    const existing = states.get(key)
    if (existing?.scheduled) return

    const state = existing ?? { attempts: 0, scheduled: false, lastActivity: Date.now() }
    state.attempts += 1
    states.set(key, state)
    send(sessionID, text, key, state)
  }
}

/** Installs the retrying fetch. Idempotent: the plugin may be loaded more than once per process. */
function arm(): () => Promise<void> {
  const scope = globalThis as typeof globalThis & { [PATCHED]?: typeof fetch }

  if (!scope[PATCHED]) {
    const baseFetch = globalThis.fetch
    const settings = readSettings()
    scope[PATCHED] = baseFetch
    globalThis.fetch = createRetryingFetch(baseFetch, settings)
    console.warn(
      `[retry-forever] armed — ${settings.maxAttempts > 0 ? `${settings.maxAttempts} attempts max` : "unlimited attempts"}, ${settings.delayMs}ms between tries`,
    )
  }

  return async () => {
    const original = scope[PATCHED]
    if (!original) return
    globalThis.fetch = original
    delete scope[PATCHED]
  }
}

/** opencode 1.x plugin entry: a function returning hooks. */
export const RetryForever = async (input?: { client?: unknown }) => {
  const dispose = arm()
  const client = input?.client
  if (!client) return { dispose }

  const resume = createResumer(client, readResumeSettings())

  return {
    dispose,
    async event({ event }: { event: { type?: string; properties?: any } }) {
      if (event?.type !== "message.part.updated") return
      const part = event.properties?.part
      if (part?.type !== "step-finish" || part?.reason !== "unknown") return
      await resume(part.sessionID, part.messageID)
    },
  }
}

/**
 * opencode 2.x does not route provider traffic through `globalThis.fetch`, so the fetch
 * patch above never sees a 503 there. What it does expose is `aisdk.hook("language", …)`:
 * every provider registers one to assign `input.language`, so a hook registered afterwards
 * receives the built model and can wrap it.
 */
type LanguageModel = {
  doGenerate: (options: unknown) => Promise<unknown>
  doStream: (options: { abortSignal?: AbortSignal }) => Promise<{ stream: ReadableStream<StreamPart> }>
}

type StreamPart = { type?: string; finishReason?: string } & Record<string, unknown>

type AISDKLanguageHookInput = { language?: LanguageModel }

type PluginContextLike = {
  aisdk: {
    hook: (name: string, callback: (input: AISDKLanguageHookInput) => void | Promise<void>) => Promise<unknown>
  }
}

/** AI SDK errors carry the HTTP status directly; only fall back to message matching without one. */
function isRetryableModelError(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode
  if (typeof status === "number") return RETRYABLE_STATUS.has(status)
  if ((error as { isRetryable?: unknown })?.isRetryable === true) return true
  return isRetryableError(error)
}

/**
 * A stream that has already emitted content cannot be restarted without duplicating it
 * downstream, so only failures before the first emitted part are retried here. Later
 * failures propagate to opencode's own retry, which restarts the whole request.
 */
function retryingStream(
  model: LanguageModel,
  options: { abortSignal?: AbortSignal },
  settings: Settings,
): Promise<{ stream: ReadableStream<StreamPart> }> {
  const signal = options.abortSignal

  const attempt = async (n: number): Promise<{ stream: ReadableStream<StreamPart> }> => {
    const last = settings.maxAttempts > 0 && n >= settings.maxAttempts

    const retry = async (reason: string): Promise<{ stream: ReadableStream<StreamPart> }> => {
      if (settings.verbose)
        console.warn(`[retry-forever] model ${reason} — attempt ${n} failed, retrying in ${settings.delayMs}ms`)
      await sleep(settings.delayMs, signal)
      return attempt(n + 1)
    }

    let result: { stream: ReadableStream<StreamPart> }
    try {
      result = await model.doStream(options)
    } catch (error) {
      if (isAbort(error, signal) || !isRetryableModelError(error) || last) throw error
      return retry(describe(error))
    }

    const reader = result.stream.getReader()
    let first: ReadableStreamReadResult<StreamPart>
    try {
      first = await reader.read()
    } catch (error) {
      reader.releaseLock()
      if (isAbort(error, signal) || !isRetryableModelError(error) || last) throw error
      return retry(describe(error))
    }

    // A stream whose very first part is an error or an unknown finish never produced
    // anything downstream, so restarting it is safe.
    const part = first.value
    if (!last && part && !isAbort(undefined, signal)) {
      if (part.type === "error" && isRetryableModelError((part as { error?: unknown }).error))
        return retry(describe((part as { error?: unknown }).error))
      if (part.type === "finish" && (part.finishReason === "unknown" || part.finishReason === "error"))
        return retry(`stream ended with finishReason=${part.finishReason}`)
    }

    // Replay the part we consumed, then hand back the rest of the stream untouched.
    return {
      ...result,
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          if (first.done) {
            controller.close()
            return
          }
          if (first.value !== undefined) controller.enqueue(first.value)
        },
        async pull(controller) {
          const next = await reader.read()
          if (next.done) {
            controller.close()
            return
          }
          controller.enqueue(next.value)
        },
        cancel(reason) {
          return reader.cancel(reason)
        },
      }),
    }
  }

  return attempt(1)
}

function withModelRetries(model: LanguageModel, settings: Settings): LanguageModel {
  return new Proxy(model, {
    get(target, property, receiver) {
      if (property === "doStream")
        return (options: { abortSignal?: AbortSignal }) => retryingStream(target, options, settings)

      if (property === "doGenerate")
        return async (options: { abortSignal?: AbortSignal }) => {
          for (let n = 1; ; n++) {
            const last = settings.maxAttempts > 0 && n >= settings.maxAttempts
            try {
              return await target.doGenerate(options)
            } catch (error) {
              if (isAbort(error, options?.abortSignal) || !isRetryableModelError(error) || last) throw error
              if (settings.verbose)
                console.warn(
                  `[retry-forever] model ${describe(error)} — attempt ${n} failed, retrying in ${settings.delayMs}ms`,
                )
              await sleep(settings.delayMs, options?.abortSignal)
            }
          }
        }

      return Reflect.get(target, property, receiver)
    },
  })
}

/* ------------------------------------------------------------------ *
 * opencode 2.x auto-resume                                            *
 * ------------------------------------------------------------------ */

/**
 * opencode 2.x never invokes a plugin's `server` entry — only `setup` — so none of the 1.x
 * hooks above run there. It also keeps provider traffic away from the plugin's
 * `globalThis.fetch`, and `session.hook("http.request")` can only mutate a request, never
 * see its response. That leaves exactly one place to recover a dead turn: the event stream.
 *
 * `session.execution.failed` is the terminal event, emitted after opencode's own retries are
 * exhausted. A turn the user stopped raises `session.execution.interrupted` instead, so
 * resuming here cannot fight an interrupt.
 */
const RESUME_TEXT = process.env.OPENCODE_RESUME_TEXT ?? "continue"

/** Events arrive as `{ id, created, type, durable, data }` — the session id lives in `data`. */
type ExecutionEvent = { type?: string; data?: { sessionID?: string } }

type V2Context = {
  event: { subscribe: () => AsyncIterable<ExecutionEvent> }
  session: { prompt: (input: { sessionID: string; text: string }) => Promise<unknown> }
}

export function createExecutionResumer(
  session: V2Context["session"],
  settings: ResumeSettings,
  sleepFor: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  const failures = new Map<string, number>()
  const inFlight = new Set<string>()

  return async (event: ExecutionEvent): Promise<boolean> => {
    const sessionID = event?.data?.sessionID
    if (!sessionID) return false

    // A completed or deliberately stopped turn clears the streak; only consecutive
    // failures count, so an unlucky session does not carry a stale attempt number.
    if (event.type === "session.execution.succeeded" || event.type === "session.execution.interrupted") {
      failures.delete(sessionID)
      return false
    }
    if (event.type !== "session.execution.failed") return false

    // One resume in flight per session. Several failure events can describe the same dead
    // turn, and each would otherwise send its own "continue".
    if (inFlight.has(sessionID)) return false

    const attempt = (failures.get(sessionID) ?? 0) + 1
    if (settings.maxAttempts > 0 && attempt > settings.maxAttempts) {
      // Keep the count. Clearing it here would restart the streak at 1 on the next
      // failure, quietly turning the cap into "resume forever, one warning per attempt".
      failures.set(sessionID, attempt)
      if (attempt === settings.maxAttempts + 1)
        console.warn(`[retry-forever] session ${sessionID} failed ${attempt} times — giving up`)
      return false
    }
    failures.set(sessionID, attempt)

    console.warn(
      `[retry-forever] session ${sessionID} died — resuming (attempt ${attempt}${settings.maxAttempts > 0 ? `/${settings.maxAttempts}` : ""})`,
    )
    inFlight.add(sessionID)
    try {
      await sleepFor(settings.delayMs)
      await session.prompt({ sessionID, text: RESUME_TEXT })
    } finally {
      inFlight.delete(sessionID)
    }
    return true
  }
}

/** opencode 2.x plugin entry: `setup` is called with the plugin context. */
export const setup = async (context: PluginContextLike & V2Context): Promise<void> => {
  const settings = readSettings()
  arm()

  await context.aisdk.hook("language", (input) => {
    if (!input.language) return
    input.language = withModelRetries(input.language, settings)
  })

  // opencode calls `setup` once per loaded project/worktree — six times in one server start
  // is normal. Without this guard each call opens its own event subscription and every
  // dropped turn gets one "continue" per subscriber.
  const scope = globalThis as typeof globalThis & { [SUBSCRIBED]?: true }
  if (scope[SUBSCRIBED]) return
  scope[SUBSCRIBED] = true

  const resume = createExecutionResumer(context.session, readResumeSettings())
  void (async () => {
    for await (const event of context.event.subscribe()) {
      await resume(event).catch((error: unknown) =>
        console.warn(`[retry-forever] resume failed: ${describe(error)}`),
      )
    }
  })()
}

/**
 * opencode validates the module's default export against its plugin schema before the
 * plugin can arm, and the two major versions want different shapes:
 *
 *   1.x  { id, server }   — a function under "server"
 *   2.x  { id, setup }    — a function under "setup", called with the plugin context
 *
 * Getting it wrong fails the load outright, with a schema error naming the offending key:
 *   bare function under "default"  -> SchemaError: Expected object at ["default"]
 *   no default export at all       -> SchemaError: Missing key at ["default"]
 *   object without an id           -> Path plugin <file> must export id
 *
 * Carrying both keys means one file loads on either version.
 */
export default { id: "opencode-retry-forever", server: RetryForever, setup }
