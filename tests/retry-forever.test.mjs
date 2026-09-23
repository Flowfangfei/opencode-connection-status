// Test suite for retry-forever.ts — pure-function units that don't need the
// opencode runtime: shouldResume decision logic and createExecutionResumer
// state machine (with injected sleep).
import { registerHooks } from "node:module"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const PKG = fileURLToPath(new URL("..", import.meta.url))
const TEST_DIR = mkdtempSync(join(tmpdir(), "opencode-retry-test-"))
const SHIM = join(TEST_DIR, "shim")
mkdirSync(SHIM, { recursive: true })
writeFileSync(join(SHIM, "index.mjs"), "export function createOpencodeClient(o){ return { __shim: true } }\n")
registerHooks({
  resolve(s, c, next) {
    if (s === "@opencode-ai/sdk") return { url: pathToFileURL(join(SHIM, "index.mjs")).href, shortCircuit: true }
    return next(s, c)
  },
})

const rf = await import(pathToFileURL(join(PKG, "retry-forever.ts")).href)

const results = []
function record(name, pass, detail = "") {
  results.push({ name, pass, detail })
  console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const baseSettings = { provider: "*", model: "*", delayMs: 10, maxAttempts: 3 }

/* shouldResume: decides whether a dead turn is worth restarting */

record("R1. assistant message with unknown finish + output -> resume",
  rf.shouldResume({ role: "assistant", finish: "unknown", tokens: { output: 100 } }, baseSettings) === true)

record("R2. zero-token unknown finish is a deliberate abort -> no resume",
  rf.shouldResume({ role: "assistant", finish: "unknown", tokens: { output: 0 } }, baseSettings) === false)

record("R3. clean finish (stop) -> no resume",
  rf.shouldResume({ role: "assistant", finish: "stop", tokens: { output: 100 } }, baseSettings) === false)

record("R4. user message -> no resume",
  rf.shouldResume({ role: "user" }, baseSettings) === false)

record("R5. summary message (compaction) -> no resume",
  rf.shouldResume({ role: "assistant", finish: "unknown", tokens: { output: 5 }, summary: {} }, baseSettings) === false)

record("R6. provider filter: other provider -> no resume",
  rf.shouldResume({ role: "assistant", finish: "unknown", tokens: { output: 10 }, providerID: "other" },
    { ...baseSettings, provider: "myapi" }) === false)

record("R7. provider filter: matching provider -> resume",
  rf.shouldResume({ role: "assistant", finish: "unknown", tokens: { output: 10 }, providerID: "myapi" },
    { ...baseSettings, provider: "myapi" }) === true)

record("R8. model prefix filter matches",
  rf.shouldResume({ role: "assistant", finish: "unknown", tokens: { output: 10 }, modelID: "glm-5-3-flash-260828" },
    { ...baseSettings, model: "glm-5-3-flash" }) === true)

record("R9. undefined info -> no resume",
  rf.shouldResume(undefined, baseSettings) === false)

/* createExecutionResumer: 2.x state machine over session.execution.* events */

function makeResumer(maxAttempts) {
  const prompts = []
  const sleeps = []
  const session = {
    prompt: async (input) => { prompts.push(input.sessionID) },
  }
  const resumer = rf.createExecutionResumer(
    session,
    { ...baseSettings, maxAttempts },
    (ms) => { sleeps.push(ms); return Promise.resolve() },
  )
  return { prompts, sleeps, resumer }
}

// T1: a failed session triggers exactly one resume
{
  const { prompts, resumer } = makeResumer(3)
  await resumer({ type: "session.execution.failed", data: { sessionID: "s1" } })
  record("R10. failure triggers one resume", prompts.length === 1 && prompts[0] === "s1", `${prompts.length} prompt(s)`)
}

// T2: duplicate failure events for the same dead turn don't double-resume.
// The in-flight guard spans the sleep + prompt window, so hold the prompt open
// until the second event has had its chance.
{
  let releasePrompt
  const gate = new Promise((r) => { releasePrompt = r })
  const prompts = []
  const session = {
    prompt: async (input) => {
      prompts.push(input.sessionID)
      await gate
    },
  }
  const resumer = rf.createExecutionResumer(
    session,
    { ...baseSettings, maxAttempts: 3 },
    () => Promise.resolve(),
  )
  const first = resumer({ type: "session.execution.failed", data: { sessionID: "s1" } }) // enters prompt, holds
  await sleep(10) // let it reach the prompt
  await resumer({ type: "session.execution.failed", data: { sessionID: "s1" } }) // should be deduped
  releasePrompt()
  await first
  record("R11. duplicate failures deduped while in flight", prompts.length === 1, `${prompts.length} prompt(s)`)
}

// T3: succeeded/interrupted clears the failure streak
{
  const { prompts, resumer } = makeResumer(1)
  await resumer({ type: "session.execution.failed", data: { sessionID: "s1" } }) // attempt 1 (max 1) -> resume
  await resumer({ type: "session.execution.succeeded", data: { sessionID: "s1" } }) // clears streak
  await resumer({ type: "session.execution.failed", data: { sessionID: "s1" } }) // attempt 1 again -> resume
  record("R12. success clears the failure streak", prompts.length === 2, `${prompts.length} prompt(s)`)
}

// T4: max attempts cap — after N resumes, stop
{
  const { prompts, resumer } = makeResumer(2)
  // 1: resume. 2: resume. 3: capped (no resume). 4: still capped.
  await resumer({ type: "session.execution.failed", data: { sessionID: "s1" } })
  await resumer({ type: "session.execution.failed", data: { sessionID: "s1" } })
  await resumer({ type: "session.execution.failed", data: { sessionID: "s1" } })
  await resumer({ type: "session.execution.failed", data: { sessionID: "s1" } })
  record("R13. resume stops at max attempts", prompts.length === 2, `${prompts.length} prompt(s) after 4 failures (cap 2)`)
}

// T5: interrupted turns never resume (user pressed stop)
{
  const { prompts, resumer } = makeResumer(3)
  await resumer({ type: "session.execution.interrupted", data: { sessionID: "s1" } })
  record("R14. interrupted turn never resumes", prompts.length === 0, `${prompts.length} prompt(s)`)
}

// T6: events without a sessionID are ignored
{
  const { prompts, resumer } = makeResumer(3)
  await resumer({ type: "session.execution.failed", data: {} })
  record("R15. missing sessionID ignored", prompts.length === 0, `${prompts.length} prompt(s)`)
}

/* 1.x fetch integration: replay a Request body and stop at the attempt cap. */
process.env.OPENCODE_RETRY_DELAY_MS = "1"
process.env.OPENCODE_RETRY_MAX_ATTEMPTS = "3"
process.env.OPENCODE_RETRY_VERBOSE = "false"
const originalFetch = globalThis.fetch
{
  const bodies = []
  globalThis.fetch = async (url, init) => {
    bodies.push(await new Request(url, init).text())
    return new Response("", { status: bodies.length === 1 ? 503 : 200 })
  }
  const hooks = await rf.RetryForever()
  const response = await fetch(new Request("https://example.test/chat", { method: "POST", body: "replay me" }))
  record("R16. 1.x fetch retries 503 with intact request body",
    response.status === 200 && bodies.length === 2 && bodies.every((body) => body === "replay me"),
    `statuses=503,${response.status} bodies=${bodies.length}`)
  await hooks.dispose()
}
{
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new TypeError("fetch failed") }
  const hooks = await rf.RetryForever()
  let failed = false
  try { await fetch("https://example.test/chat") } catch { failed = true }
  record("R17. 1.x network retries stop at attempt cap", failed && calls === 3, `${calls} attempt(s)`)
  await hooks.dispose()
}
globalThis.fetch = originalFetch

/* 2.x language hook: retry only before the first stream part. */
let languageHook
const setupContext = {
  aisdk: { hook: async (kind, callback) => { if (kind === "language") languageHook = callback } },
  event: { subscribe: async function* () {} },
  session: { prompt: async () => {} },
}
await rf.setup(setupContext)
let streamCalls = 0
const language = {
  doStream: async () => {
    streamCalls++
    if (streamCalls === 1) throw new TypeError("fetch failed")
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: "text-delta", text: "ok" })
      controller.close()
    } }) }
  },
}
const hookInput = { language }
languageHook(hookInput)
const result = await hookInput.language.doStream({})
const first = await result.stream.getReader().read()
record("R18. 2.x language hook retries before stream output",
  streamCalls === 2 && first.value?.text === "ok", `${streamCalls} attempt(s)`)
const teardown = await rf.RetryForever()
await teardown.dispose()

rmSync(TEST_DIR, { recursive: true, force: true })

const passed = results.filter((r) => r.pass).length
console.log(`\n=== ${passed}/${results.length} passed ===`)
process.exit(passed === results.length ? 0 : 1)
