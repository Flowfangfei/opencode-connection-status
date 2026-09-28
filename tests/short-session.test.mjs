import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { registerHooks } from "node:module"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const dir = mkdtempSync(join(tmpdir(), "opencode-conn-short-"))
const statusFile = join(dir, "status.jsonl")
const shim = join(dir, "sdk.mjs")
writeFileSync(shim, "export const createOpencodeClient = () => ({})\n")
process.env.OPENCODE_CONN_STATUS_FILE = statusFile
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "@opencode-ai/sdk"
      ? { url: pathToFileURL(shim).href, shortCircuit: true }
      : nextResolve(specifier, context)
  },
})

const { ConnectionStatus } = await import("../connection-status.ts")
const monitor = await ConnectionStatus({ client: {
  session: { list: async () => ({ data: [] }) },
  tui: { showToast: async () => {} },
} })
const send = (type, properties) => monitor.event({ event: { type, properties } })
const monitors = [monitor]
const rows = () => {
  try { return readFileSync(statusFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) }
  catch { return [] }
}

try {
  await send("message.part.updated", { part: { type: "text", sessionID: "short-turn", text: "quick answer" } })
  await new Promise((resolve) => setTimeout(resolve, 40))
  await send("session.idle", { sessionID: "short-turn" })
  assert.deepEqual(rows().filter((row) => row.sessionID === "short-turn").map((row) => row.phase), ["streaming", "idle"],
    "A turn ending before the first watchdog tick must retain its output phase")
  console.log("PASS  sub-second first turn keeps output before idle")

  const firstTurn = rows().filter((row) => row.sessionID === "short-turn")
  await send("session.status", { sessionID: "first-busy", status: { type: "busy" } })
  assert.equal(rows().filter((row) => row.sessionID === "first-busy").at(-1)?.phase, "waiting")
  await send("message.part.updated", { part: { type: "text", sessionID: "first-busy", text: "done" } })
  await send("session.status", { sessionID: "first-busy", status: { type: "idle" } })
  const busyRows = rows().filter((row) => row.sessionID === "first-busy")
  assert.deepEqual(busyRows.map((row) => row.phase), ["waiting", "streaming", "idle"])
  assert.equal(busyRows[1].wait, "none")
  console.log("PASS  first activation records waiting, output and idle immediately")

  const beforeIdle = rows().length
  await send("session.idle", { sessionID: "first-busy" })
  assert.equal(rows().length, beforeIdle)
  console.log("PASS  duplicate idle events do not add duplicate samples")

  await send("message.part.updated", { part: { type: "text", sessionID: "fast-tool", text: "prepare tool" } })
  await send("message.part.updated", { part: { type: "tool", sessionID: "fast-tool", tool: "bash", state: { status: "running", input: { command: "echo ok" } } } })
  await send("message.part.updated", { part: { type: "tool", sessionID: "fast-tool", tool: "bash", state: { status: "completed" } } })
  assert.deepEqual(rows().filter((row) => row.sessionID === "fast-tool").map((row) => row.wait), ["none", "tool", "none"])
  console.log("PASS  short tool waits keep both start and completion")

  await send("session.status", { sessionID: "tokens", status: { type: "busy" } })
  for (let i = 0; i < 100; i++) {
    await send("session.next.reasoning.delta", { sessionID: "tokens", delta: `thought ${i} ` })
  }
  await send("session.next.text.delta", { sessionID: "tokens", delta: "answer" })
  await send("session.idle", { sessionID: "tokens" })
  const tokenRows = rows().filter((row) => row.sessionID === "tokens")
  assert.equal(tokenRows.length, 4)
  assert.equal(tokenRows[2].thinking, "")
  console.log("PASS  100 reasoning deltas keep transitions without 100 file writes")

  let resolveTitle
  const delayed = await ConnectionStatus({ client: {
    session: { list: () => new Promise((resolve) => { resolveTitle = resolve }) },
    tui: { showToast: async () => {} },
  } })
  monitors.push(delayed)
  let deadline
  try {
    await Promise.race([
      delayed.event({ event: { type: "session.status", properties: { sessionID: "title-pending", status: { type: "busy" } } } }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Activity waited for title lookup")), 500) }),
    ])
  } finally { clearTimeout(deadline) }
  await delayed.event({ event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "title-pending", text: "fast" } } } })
  await delayed.event({ event: { type: "session.idle", properties: { sessionID: "title-pending" } } })
  resolveTitle({ data: [{ id: "title-pending", title: "late title" }] })
  await new Promise((resolve) => setImmediate(resolve))
  const delayedRows = rows().filter((row) => row.sessionID === "title-pending")
  assert.deepEqual(delayedRows.slice(0, 3).map((row) => row.phase), ["waiting", "streaming", "idle"])
  assert.equal(delayedRows.at(-1).sessionTitle, "late title")
  assert.equal(delayedRows.at(-1).phase, "idle")
  console.log("PASS  delayed title lookup does not block or reorder first-turn activity")

  await send("message.updated", { info: { id: "user-message", sessionID: "user-input", role: "user" } })
  await send("message.part.updated", { part: { id: "user-text", messageID: "user-message", sessionID: "user-input", type: "text", text: "user input" } })
  await send("message.part.delta", { messageID: "user-message", sessionID: "user-input", partID: "user-text", field: "text", delta: "more input" })
  assert.equal(rows().filter((row) => row.sessionID === "user-input").length, 0)
  await send("session.status", { sessionID: "user-input", status: { type: "busy" } })
  await send("message.updated", { info: { id: "assistant-message", sessionID: "user-input", role: "assistant" } })
  await send("message.part.updated", { part: { messageID: "assistant-message", sessionID: "user-input", type: "text", text: "model output" } })
  await send("session.idle", { sessionID: "user-input" })
  assert.deepEqual(rows().filter((row) => row.sessionID === "user-input").map((row) => row.phase), ["waiting", "streaming", "idle"])
  console.log("PASS  user text does not masquerade as model output before activation")

  if (process.platform === "win32") {
    const viewFile = join(dir, "short-view.jsonl")
    writeFileSync(viewFile, firstTurn.map((row) => JSON.stringify(row)).join("\n") + "\n")
    const rendered = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      fileURLToPath(new URL("../connmon.ps1", import.meta.url)), "-Once", "-StatusFile", viewFile], { encoding: "utf8", timeout: 10000 })
    assert.equal(rendered.status, 0, rendered.stderr)
    assert.match(rendered.stdout, /状态: 空闲/)
    assert.match(rendered.stdout, /近况: 输出/)
    assert.match(rendered.stdout, /█/)
    console.log("PASS  Windows viewer retains a short first-turn activity glyph after idle")
  }
} finally {
  for (const instance of monitors.reverse()) instance.dispose()
  if (!dir.startsWith(tmpdir())) throw new Error("Temporary test path is outside the temp root")
  rmSync(dir, { recursive: true, force: true })
}
