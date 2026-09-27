import { registerHooks } from "node:module"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const dir = mkdtempSync(join(tmpdir(), "opencode-conn-interaction-"))
const statusFile = join(dir, "status.jsonl")
const shim = join(dir, "sdk-shim.mjs")
writeFileSync(shim, "export const createOpencodeClient = () => ({})\n")

process.env.OPENCODE_CONN_STATUS_FILE = statusFile
process.env.OPENCODE_CONN_IDLE_PROBE_MS = "1000"
process.env.OPENCODE_CONN_PROBE_TIMEOUT_MS = "500"
process.env.OPENCODE_RETRY_DELAY_MS = "1"
process.env.OPENCODE_RETRY_MAX_ATTEMPTS = "3"
process.env.OPENCODE_RETRY_VERBOSE = "false"

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/sdk") {
      return { url: pathToFileURL(shim).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { ConnectionStatus } = await import("../connection-status.ts")
const { RetryForever } = await import("../retry-forever.ts")
const originalFetch = globalThis.fetch
let hits = 0
const server = createServer((_request, response) => {
  hits++
  response.writeHead(503)
  response.end("temporary server error")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const client = {
  tui: { showToast: async () => {} },
  session: { list: async () => ({ data: [] }) },
}

function events() {
  try {
    return readFileSync(statusFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  } catch { return [] }
}

async function waitForProbe() {
  const deadline = Date.now() + 7000
  while (Date.now() < deadline) {
    const row = events().find((event) => event.scope === "connection" && event.event?.startsWith("idle-probe"))
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Idle probe did not write a result within 7 seconds")
}

async function checkOrder(retryFirst) {
  writeFileSync(statusFile, "")
  hits = 0
  let retry, monitor
  try {
    if (retryFirst) retry = await RetryForever()
    monitor = await ConnectionStatus({ client })
    if (!retryFirst) retry = await RetryForever()
    await monitor.config({ provider: { mock: { options: { baseURL: origin + "/v1" } } } })
    const row = await waitForProbe()
    if (row.event !== "idle-probe-ok" || row.reachable !== 1 || row.total !== 1 || hits !== 1) {
      throw new Error(`Unexpected probe result: ${JSON.stringify({ row, hits })}`)
    }
    console.log(`PASS  HTTP 503 proves reachability with one request (retry ${retryFirst ? "first" : "second"})`)
  } finally {
    if (retryFirst) {
      monitor?.dispose()
      await retry?.dispose()
    } else {
      await retry?.dispose()
      monitor?.dispose()
    }
    if (globalThis.fetch !== originalFetch) throw new Error("Fetch wrapper was not restored")
  }
}

try {
  await checkOrder(true)
  await checkOrder(false)
} finally {
  server.close()
  if (!dir.startsWith(tmpdir())) throw new Error("Refusing to remove a directory outside the temp root")
  rmSync(dir, { recursive: true, force: true })
}
