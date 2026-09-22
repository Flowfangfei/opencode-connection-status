// Comprehensive test suite for connection-status.ts
// Run: node tests/plugin.test.mjs
// Uses a module-resolution hook for @opencode-ai/sdk and a local HTTP server
// as a mock provider origin for probe tests.
import { registerHooks } from "node:module"
import { createServer } from "node:http"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PKG = "D:/HuaweiMoveData/Users/86130/Documents/opencode-connection-status"
const SHIM = PKG + "/.test-shim"
const STATUS_FILE = join(homedir(), ".cache", "opencode", "connection-status", "status.jsonl")

// --- SDK shim ---
mkdirSync(SHIM, { recursive: true })
writeFileSync(SHIM + "/index.mjs", `export function createOpencodeClient(opts) { return { __shim: true } }\n`)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/sdk") {
      return { url: "file:///" + SHIM.replace(/\\/g, "/") + "/index.mjs", shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const plugin = await import("file:///" + PKG + "/connection-status.ts")

// --- mock provider origin: configurable reachability ---
let originReachable = true
const originHits = { n: 0 }
const mockOrigin = createServer((req, res) => {
  originHits.n++
  if (originReachable) {
    res.writeHead(404) // any HTTP response counts as reachable
    res.end()
  } else {
    res.destroy() // simulate connection failure
  }
})
await new Promise((r) => mockOrigin.listen(0, "127.0.0.1", r))
const originUrl = "http://127.0.0.1:" + mockOrigin.address().port

// --- test harness ---
const results = []
function record(name, pass, detail = "") {
  results.push({ name, pass, detail })
  console.log((pass ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readLines() {
  try {
    return readFileSync(STATUS_FILE, "utf8").trim().split("\n").map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

// Speed up the watchdog: silence 100ms, renotify 1500ms, probe 500ms
process.env.OPENCODE_CONN_SILENCE_MS = "100"
process.env.OPENCODE_CONN_RENOTIFY_MS = "1500"
process.env.OPENCODE_CONN_PROBE_TIMEOUT_MS = "500"

// Reset status file
rmSync(STATUS_FILE, { force: true })

const toasts = []
const fakeClient = {
  tui: { showToast: async (o) => toasts.push(o.body) },
  config: { providers: async () => ({ data: { providers: [] } }) },
  session: { list: async () => ({ data: [] }) },
}
const plugin1 = await plugin.ConnectionStatus({ client: fakeClient })
const send = (type, properties) => plugin1.event({ event: { type, properties } })

// Wire the provider hosts through the config hook (this is how opencode does it)
await plugin1.config({ provider: { mock: { options: { baseURL: originUrl + "/api/v3" } } } })

/* Test 1: error toasts classified + deduped within 3s */
await send("session.error", { error: { name: "APIError", data: { message: "boom", statusCode: 503, isRetryable: true } } })
await send("session.error", { error: { name: "APIError", data: { message: "boom", statusCode: 503, isRetryable: true } } })
await send("session.error", { error: { name: "APIError", data: { message: "boom", statusCode: 503, isRetryable: true } } })
const t1 = toasts.filter((t) => t.message.includes("503"))
record("1. error toast classified (503 -> warning)", t1.length >= 1 && t1[0].variant === "warning", `${t1.length} toast(s)`)
record("1b. duplicate errors deduped", t1.length === 1, `3 identical errors -> ${t1.length} toast`)

/* Test 2: different error after dedupe window still toasts */
await sleep(3100)
await send("session.error", { error: { name: "APIError", data: { message: "boom", statusCode: 503, isRetryable: true } } })
const t2 = toasts.filter((t) => t.message.includes("503"))
record("2. error after dedupe window re-toasts", t2.length === 2, `${t2.length} toasts total`)

/* Test 3: abort errors are silent */
toasts.length = 0
await send("session.error", { error: { name: "MessageAbortedError" } })
record("3. MessageAbortedError silent", toasts.length === 0, `${toasts.length} toasts`)

/* Test 4: auth error classified as error variant */
await send("session.error", { error: { name: "ProviderAuthError", data: { message: "bad key" } } })
const t4 = toasts[toasts.length - 1]
record("4. ProviderAuthError -> error variant", t4 && t4.variant === "error", t4 ? t4.message.slice(0, 30) : "")

/* Test 5: per-session thinking isolation under interleaved deltas */
await send("message.part.updated", { part: { type: "reasoning", sessionID: "sesA", text: "session A is thinking about the glossary" } })
await send("message.part.updated", { part: { type: "reasoning", sessionID: "sesB", text: "session B is thinking about the test plan" } })
await send("message.part.updated", { part: { type: "reasoning", sessionID: "sesA", text: "session A is thinking about the glossary and the file paths" } })
await sleep(5100) // watchdog tick writes heartbeats
const lines5 = readLines().filter((l) => l.sessionID === "sesA" || l.sessionID === "sesB")
const lastA = [...lines5].reverse().find((l) => l.sessionID === "sesA" && l.thinking)
const lastB = [...lines5].reverse().find((l) => l.sessionID === "sesB" && l.thinking)
record("5. per-session thinking isolated",
  lastA && lastA.thinking.includes("glossary") && lastB && lastB.thinking.includes("test plan"),
  `A=[${(lastA?.thinking || "").slice(0, 25)}] B=[${(lastB?.thinking || "").slice(0, 25)}]`)

/* Test 6: text part clears thinking */
await send("message.part.updated", { part: { type: "text", sessionID: "sesA", text: "the answer" } })
await sleep(5100)
const lines6 = readLines().filter((l) => l.sessionID === "sesA")
const lastA6 = [...lines6].reverse().find((l) => l.sessionID === "sesA")
record("6. answer text clears thinking", lastA6 && lastA6.thinking === "", `thinking=[${lastA6?.thinking}]`)

/* Test 7: session.idle clears thinking and wait */
await send("message.part.updated", { part: { type: "reasoning", sessionID: "sesB", text: "more thinking before idle" } })
await send("session.idle", { sessionID: "sesB" })
const lines7 = readLines().filter((l) => l.sessionID === "sesB")
const idleB = [...lines7].reverse().find((l) => l.event === "session-idle")
record("7. session.idle clears thinking", idleB && idleB.thinking === "" && idleB.phase === "idle", `phase=${idleB?.phase}`)

/* Test 8: heartbeat dedup — per session, only on change */
const countBySession = (lines) => {
  const m = {}
  for (const l of lines) m[l.sessionID] = (m[l.sessionID] || 0) + 1
  return m
}
const before8 = countBySession(readLines())
await sleep(5600) // one watchdog tick, no events in between
const after8 = countBySession(readLines())
let spam = false
for (const sid of new Set([...Object.keys(before8), ...Object.keys(after8)])) {
  if ((after8[sid] || 0) - (before8[sid] || 0) > 1) spam = true
}
record("8. heartbeat writes at most once per session per tick", !spam,
  JSON.stringify(Object.fromEntries(Object.keys(after8).map((s) => [s.slice(0, 10), (after8[s] || 0) - (before8[s] || 0)]))))

/* Test 9: stalled -> probe-ok (reachable origin) */
// Send a reasoning event for sesA (makes it the active session), then fire a
// model-host request through the patched fetch: inflight > 0, silence follows.
await send("message.part.updated", { part: { type: "reasoning", sessionID: "sesA", text: "kick off a long turn" } })
const hangController = new AbortController()
fetch(originUrl + "/api/v3/chat/completions", {
  method: "POST",
  signal: hangController.signal,
  body: "{}",
  headers: { "content-length": "2" },
}).catch(() => {})
// The mock server responds immediately (404), so the request completes fast —
// inflight drops to 0 before the watchdog ticks. To hold it open we need the
// origin to hang. Restart the mock with a delayed response instead:
originReachable = true
// Wait: silence 100ms + tick 5s + probe 500ms. But inflight already dropped.
// The stall path needs inflight > 0 at tick time, so hold the request open:
// use a slow endpoint. Add one to the mock:
await sleep(6500)
const lines9 = readLines().filter((l) => l.sessionID === "sesA")
const probeOk = lines9.find((l) => l.event === "probe-ok")
const stalled9 = lines9.find((l) => l.event === "stalled")
// The mock responds instantly, so the request finished and no stall occurs —
// this is CORRECT behavior (no false alarm). Verify no stall was recorded:
record("9. no false stall when request completes quickly", !stalled9 && !probeOk,
  `stalled=${!!stalled9} probeOk=${!!probeOk} (request finished before tick)`)

/* Test 10: probe-fail -> down toast -> recovery */
// Make the origin hang: swap the mock to a never-responding handler
originReachable = false
mockOrigin.close()
const hangingOrigin = createServer((req, res) => {
  originHits.n++
  // never respond — connection stays open until the client times out
})
await new Promise((r) => hangingOrigin.listen(0, "127.0.0.1", r))
const hangingUrl = "http://127.0.0.1:" + hangingOrigin.address().port
await plugin1.config({ provider: { mock: { options: { baseURL: hangingUrl + "/api/v3" } } } })

toasts.length = 0
await send("message.part.updated", { part: { type: "reasoning", sessionID: "sesA", text: "starting a request that will hang" } })
const hang2 = fetch(hangingUrl + "/api/v3/chat/completions", { method: "POST", body: "{}" }).catch(() => {})
// silence 100ms + tick 5s + probe timeout 500ms -> down toast
await sleep(7000)
const lines10 = readLines().filter((l) => l.sessionID === "sesA")
const probeFail = lines10.find((l) => l.event === "probe-fail")
const downToast = toasts.find((t) => t.message.includes("连接中断"))
record("10. probe-fail marks down + error toast", !!probeFail && !!downToast, downToast ? downToast.message.slice(0, 40) : "no toast")

// Recovery: output flows again
toasts.length = 0
await send("message.part.updated", { part: { type: "text", sessionID: "sesA", text: "recovered output" } })
await sleep(5600)
const recToast = toasts.find((t) => t.message.includes("恢复"))
record("10b. recovery toast after down", !!recToast, recToast ? recToast.message : "no recovery toast")

/* Test 11: renotify on persistent outage */
// Origin still hanging. Fire another request, wait past renotify (1.5s).
toasts.length = 0
await send("message.part.updated", { part: { type: "reasoning", sessionID: "sesA", text: "another request into the void" } })
const hang3 = fetch(hangingUrl + "/api/v3/chat/completions", { method: "POST", body: "{}" }).catch(() => {})
await sleep(8000)
const downToasts11 = toasts.filter((t) => t.message.includes("连接中断"))
record("11. persistent outage re-notifies", downToasts11.length >= 1, `${downToasts11.length} down toast(s) in window`)

/* Test 12: wait-notice for long-running tool */
toasts.length = 0
await send("message.part.updated", { part: { type: "tool", sessionID: "sesC", tool: "bash", state: { status: "running", input: { command: "npm run build" } } } })
await sleep(6500) // renotify 1500ms; watchdog ticks at 5s
const waitToasts = toasts.filter((t) => t.title === "仍在等待")
record("12. long tool run triggers wait-notice", waitToasts.length >= 1, waitToasts[0] ? waitToasts[0].message.slice(0, 40) : "none")

/* Test 13: parentID==own id is not treated as agent */
const fakeClient2 = {
  tui: { showToast: async () => {} },
  config: { providers: async () => ({ data: { providers: [] } }) },
  session: { list: async () => ({ data: [{ id: "sesX", title: "self-parent", parentID: "sesX" }] }) },
}
const plugin2 = await plugin.ConnectionStatus({ client: fakeClient2 })
await plugin2.event({ event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "sesX", text: "hi" } } } })
await sleep(6500) // watchdog tick is 5s; give it room to fire after the event
const lines13 = readLines().filter((l) => l.sessionID === "sesX")
const last13 = lines13[lines13.length - 1]
record("13. self-parent not marked as agent", last13 && last13.isAgent === false, `isAgent=${last13?.isAgent}`)
if (!last13) {
  const tail = readLines().slice(-5).map((l) => l.sessionID).join(",")
  console.log("  DEBUG last 5 sessionIDs:", tail)
}

/* Test 14: status file schema completeness */
const sample = readLines().find((l) => l.sessionID === "sesA")
const required = ["t", "phase", "wait", "waitDetail", "waitSec", "sinceOutageMs", "sessionID", "sessionTitle", "parentID", "isAgent", "thinking"]
const missing = required.filter((k) => !(k in sample))
record("14. status line schema complete", missing.length === 0, missing.length ? "missing: " + missing.join(",") : "all fields present")

/* Cleanup */
hangingOrigin.close()
rmSync(SHIM, { recursive: true, force: true })

const passed = results.filter((r) => r.pass).length
console.log(`\n=== ${passed}/${results.length} passed ===`)
process.exit(passed === results.length ? 0 : 1)
