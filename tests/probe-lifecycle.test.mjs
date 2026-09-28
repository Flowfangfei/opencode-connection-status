// Controlled HTTP streams exercise real fetch/body timing, without model billing.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "opencode-conn-probe-"))
const statusFile = join(dir, "status.jsonl")
Object.assign(process.env, {
  OPENCODE_CONN_STATUS_FILE: statusFile,
  OPENCODE_CONN_SILENCE_MS: "180",
  OPENCODE_CONN_PROBE_INTERVAL_MS: "300",
  OPENCODE_CONN_IDLE_PROBE_MS: "300",
  OPENCODE_CONN_PROBE_TIMEOUT_MS: "150",
  OPENCODE_CONN_RENOTIFY_MS: "900",
})
const { ConnectionStatus } = await import("../connection-status.ts")
const originalFetch = globalThis.fetch
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rows = () => {
  try { return readFileSync(statusFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) }
  catch { return [] }
}
async function until(predicate, label, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (predicate()) return; await sleep(15) }
  throw new Error(`Timed out: ${label}`)
}
const pass = (label) => console.log(`PASS  ${label}`)
const probes = []
const streams = new Map()
const responses = new Set()
let reachable = true
let hangProbe = false
let probeConcurrency = 0
let maxProbeConcurrency = 0
const server = createServer((request, response) => {
  responses.add(response)
  response.on("close", () => responses.delete(response))
  if (request.headers["x-opencode-conn-probe"]) {
    probes.push({ at: Date.now(), path: request.url, auth: request.headers.authorization })
    probeConcurrency++
    maxProbeConcurrency = Math.max(maxProbeConcurrency, probeConcurrency)
    response.on("close", () => probeConcurrency--)
    if (hangProbe) return
    if (!reachable) { response.destroy(); return }
    response.writeHead(401)
    response.end("unauthenticated, but reachable")
  } else if (request.url?.startsWith("/api/v3/stream")) {
    response.writeHead(200, { "content-type": "text/plain", "x-test": "preserved" })
    response.flushHeaders()
    streams.set(request.url, response)
  } else { response.writeHead(204); response.end() }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const config = { provider: { mock: { options: { baseURL: origin + "/api/v3/?private=redacted", apiKey: "not-sent" } } } }
const toasts = []
const client = { session: { list: async () => ({ data: [] }) }, tui: { showToast: async (item) => { toasts.push(item.body) } } }
const monitors = []
const controllers = []
const create = async (customClient = client) => {
  const monitor = await ConnectionStatus({ client: customClient })
  monitors.push(monitor)
  return monitor
}
const event = (monitor, type, properties) => monitor.event({ event: { type, properties } })
const status = (monitor, id, type) => event(monitor, "session.status", { sessionID: id, status: { type } })
const events = (id, name) => rows().filter((row) => row.sessionID === id && (!name || row.event === name))

try {
  const monitor = await create()
  const duplicate = await create()
  await monitor.config(config)
  await duplicate.config(config)
  await until(() => rows().filter((row) => row.event === "idle-probe-ok").length >= 3, "three idle cycles")
  assert.equal(rows().filter((row) => row.event === "connection-configured").length, 1)
  assert.equal(probes.length, rows().filter((row) => row.event === "idle-probe-ok").length)
  assert.ok(probes.slice(1).every((probe, index) => probe.at - probes[index].at >= 250))
  pass("idle probes repeat at the configured interval without conversations or duplicate plugin timers")
  assert.ok(probes.every((probe) => probe.path === "/api/v3/models" && probe.auth === undefined))
  pass("probe URL preserves the API path and drops query credentials; HTTP 401 is reachable")

  duplicate.dispose()
  const beforeDispose = probes.length
  await until(() => probes.length > beforeDispose, "remaining owner continues")
  assert.notEqual(globalThis.fetch, originalFetch)
  pass("disposing one plugin owner keeps the shared tracker and timer running")

  // No busy event here: the body lifetime itself must retain the request.
  await event(monitor, "message.part.updated", { part: { id: "announced", sessionID: "headers-first", type: "text", text: "" } })
  const atFetch = Date.now()
  const response = await fetch(origin + "/api/v3/stream-main")
  assert.ok(Date.now() - atFetch < 180, "headers should resolve before the silence threshold")
  assert.equal(response.status, 200)
  assert.equal(response.url, origin + "/api/v3/stream-main")
  assert.equal(response.headers.get("x-test"), "preserved")
  const text = response.text()
  const idleBefore = rows().filter((row) => row.event?.startsWith("idle-probe-")).length
  await until(() => events("headers-first", "probe-ok").length >= 2, "probes after headers")
  assert.equal(rows().filter((row) => row.event?.startsWith("idle-probe-")).length, idleBefore)
  assert.equal(events("headers-first").at(-1).phase, "stalled")
  pass("headers arriving before body output do not end tracking; silence probes repeat and idle probes pause")

  reachable = false
  await until(() => events("headers-first", "probe-fail").length >= 2, "persistent outage re-probes")
  assert.equal(events("headers-first").at(-1).phase, "down")
  assert.equal(toasts.filter((toast) => toast.message.includes("连接中断")).length, 1)
  pass("a down session keeps probing while outage toasts are throttled separately")
  await until(() => toasts.filter((toast) => toast.message.includes("连接中断")).length >= 2, "outage reminder")
  pass("persistent outage produces a later reminder without a new model request")

  const successBefore = events("headers-first", "probe-ok").length
  reachable = true
  await until(() => events("headers-first", "probe-ok").length > successBefore, "endpoint recovers")
  assert.equal(events("headers-first").at(-1).phase, "stalled")
  assert.equal(toasts.filter((toast) => toast.message.includes("输出正常")).length, 0)
  pass("endpoint recovery alone leaves a silent model stalled")
  await event(monitor, "message.part.updated", { part: { id: "part-text", sessionID: "headers-first", type: "text", text: "first" } })
  streams.get("/api/v3/stream-main").end("first and last")
  assert.equal(await text, "first and last")
  await until(() => events("headers-first", "recovered").length === 1, "model output recovers")
  await status(monitor, "headers-first", "idle")
  const idleAfter = rows().filter((row) => row.event === "idle-probe-ok").length
  await until(() => rows().filter((row) => row.event === "idle-probe-ok").length > idleAfter, "idle after EOF")
  pass("original body bytes survive wrapping; model output recovers and EOF permits idle probing")

  await status(monitor, "tool-wait", "busy")
  await event(monitor, "message.part.updated", { part: { sessionID: "tool-wait", type: "tool", tool: "bash", state: { status: "running" } } })
  const toolStart = probes.length
  await sleep(420)
  assert.equal(probes.length, toolStart)
  await status(monitor, "tool-wait", "idle")
  pass("a known tool wait suppresses both model-silence and idle probes")

  await status(monitor, "event-only", "busy")
  await until(() => events("event-only", "probe-ok").length >= 1, "event-only busy silence")
  await event(monitor, "message.part.updated", { part: { id: "reasoning", sessionID: "event-only", type: "reasoning", text: "start" } })
  const deltaStart = events("event-only", "probe-ok").length
  for (let i = 0; i < 5; i++) {
    await sleep(90)
    await event(monitor, "message.part.delta", { sessionID: "event-only", partID: "reasoning", field: "text", delta: " continued" })
  }
  assert.equal(events("event-only", "probe-ok").length, deltaStart)
  assert.equal(events("event-only").at(-1).phase, "streaming")
  await status(monitor, "event-only", "idle")
  pass("busy events support silence detection without fetch; 1.x text deltas refresh the silence clock")

  await status(monitor, "cancelled", "busy")
  const cancelled = await fetch(origin + "/api/v3/stream-cancel")
  await cancelled.body.cancel()
  await status(monitor, "cancelled", "idle")
  const cancelledCount = events("cancelled", "probe-ok").length
  await sleep(400)
  assert.equal(events("cancelled", "probe-ok").length, cancelledCount)
  pass("body cancellation releases tracking and does not start a later silence probe")

  await status(monitor, "aborted", "busy")
  const controller = new AbortController()
  controllers.push(controller)
  const aborted = await fetch(origin + "/api/v3/stream-abort", { signal: controller.signal })
  const pendingBody = aborted.text()
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pendingBody, (error) => error.name === "AbortError")
  await status(monitor, "aborted", "idle")
  const abortIdle = rows().filter((row) => row.event === "idle-probe-ok").length
  await until(() => rows().filter((row) => row.event === "idle-probe-ok").length > abortIdle, "idle after abort")
  pass("aborting after headers preserves AbortError and releases tracking exactly once")

  await event(monitor, "message.part.updated", { part: { sessionID: "body-error", type: "text", text: "" } })
  const broken = await fetch(origin + "/api/v3/stream-error")
  const brokenBody = broken.text()
  streams.get("/api/v3/stream-error").destroy()
  await assert.rejects(brokenBody)
  assert.equal(events("body-error").at(-1).phase, "down")
  const errorIdle = rows().filter((row) => row.event === "idle-probe-ok").length
  await until(() => rows().filter((row) => row.event === "idle-probe-ok").length > errorIdle, "idle after body error")
  pass("a body read failure remains an error, records down, and releases the process count")

  hangProbe = true
  await status(monitor, "stale-result", "busy")
  const beforeHang = probes.length
  await until(() => probes.length > beforeHang, "pending probe begins")
  await event(monitor, "message.part.updated", { part: { sessionID: "stale-result", type: "text", text: "resumed during probe" } })
  await status(monitor, "stale-result", "idle")
  await sleep(220)
  assert.equal(events("stale-result", "probe-fail").length, 0)
  pass("a timed-out probe cannot overwrite output or idle received while it was pending")
  hangProbe = false

  monitor.dispose()
  assert.equal(globalThis.fetch, originalFetch)
  const stoppedAt = rows().length
  await sleep(380)
  assert.equal(rows().length, stoppedAt)
  pass("last owner disposal restores fetch and stops further status writes")

  Object.assign(process.env, { OPENCODE_CONN_IDLE_PROBE_MS: "60", OPENCODE_CONN_PROBE_TIMEOUT_MS: "240" })
  hangProbe = true
  maxProbeConcurrency = 0
  await until(() => probeConcurrency === 0, "old probes finish")
  const blockingToastClient = { ...client, tui: { showToast: () => new Promise(() => {}) } }
  const slow = await create(blockingToastClient)
  await slow.config(config)
  const failsBefore = rows().filter((row) => row.event === "idle-probe-fail").length
  await until(() => rows().filter((row) => row.event === "idle-probe-fail").length >= failsBefore + 2, "non-overlapping timeout cycles")
  assert.equal(maxProbeConcurrency, 1)
  pass("slow probes do not overlap and an unresolved toast does not block subsequent cycles")
} finally {
  for (const controller of controllers) controller.abort()
  for (const monitor of monitors.reverse()) monitor.dispose()
  for (const response of responses) response.destroy()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  if (!dir.startsWith(tmpdir())) throw new Error("Temporary path outside the temp root")
  rmSync(dir, { recursive: true, force: true })
}
