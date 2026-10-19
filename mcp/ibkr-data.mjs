// The workbench service's one long-lived TWS market-data session (bridges/ibkr/data_server.py).
// Read-only, its own API client id (order execution uses another), restarted if it exits. It only
// runs while the IBKR connection is set up under 设置 → 券商连接; the service re-checks that setting.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getIbkrService } from "./ibkr.mjs";
import { setLocalIbkrDataSession } from "./ibkr-data-client.mjs";

const PREFIX = "HROUTER_IBKR_DATA=";
export const IBKR_DATA_CLIENT_OFFSET = 1; // data client id = order client id + 1

export function createIbkrDataSession({ service = getIbkrService(), spawnImpl = spawn, checkEveryMs = 30000 } = {}) {
  let child = null, buffer = "", nextId = 1, lastStatus = null, stopped = false, timer = null, config = null, startedAt = null, exits = 0;
  const pending = new Map();

  function handleLine(line) {
    if (!line.startsWith(PREFIX)) return;
    let message;
    try { message = JSON.parse(line.slice(PREFIX.length)); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    message.ok ? waiter.resolve(message.data) : waiter.reject(new Error(message.error));
  }

  function launch() {
    const script = fileURLToPath(new URL("../bridges/ibkr/data_server.py", import.meta.url));
    child = spawnImpl(config.python, ["-B", script], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...process.env, HROUTER_IBKR_PORT: String(config.port), HROUTER_IBKR_DATA_CLIENT_ID: String(config.clientId + IBKR_DATA_CLIENT_OFFSET) },
    });
    startedAt = new Date().toISOString();
    buffer = "";
    child.stdout.on("data", (bytes) => {
      buffer += bytes.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) { handleLine(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
      if (buffer.length > 8e6) buffer = "";
    });
    child.stderr.on("data", () => {}); // ib_async logs may contain account details
    child.on("error", () => {});
    child.on("exit", () => {
      exits += 1;
      child = null; lastStatus = null;
      for (const [id, waiter] of pending) { clearTimeout(waiter.timer); waiter.reject(new Error("TWS data session exited")); pending.delete(id); }
    });
  }

  // Start, restart or stop the child to match the IBKR settings; refresh the cached status.
  async function check() {
    if (stopped) return;
    try {
      const next = await service.config();
      const wanted = next.enabled && next.python;
      const changed = config && (config.port !== next.port || config.clientId !== next.clientId || config.python !== next.python);
      if (child && (!wanted || changed)) { child.kill(); child = null; }
      config = next;
      if (wanted && !child) launch();
      if (child) lastStatus = await session.request("status", {}, { timeoutMs: 5000 }).catch(() => lastStatus);
    } catch { /* settings unreadable: try again next time */ }
  }

  const session = {
    async start() { await check(); timer = setInterval(check, checkEveryMs); timer.unref?.(); setLocalIbkrDataSession(session); return session; },
    stop() { stopped = true; clearInterval(timer); child?.kill(); child = null; setLocalIbkrDataSession(null); },
    connected: () => Boolean(child && lastStatus?.connected),
    request(op, payload = {}, { timeoutMs = 20000 } = {}) {
      if (!child) return Promise.reject(new Error("TWS data session is not running (set up IBKR under 设置 → 券商连接)"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`TWS data request timed out (${op})`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      });
    },
    status: () => ({ state: child ? (lastStatus?.connected ? "connected" : "connecting") : config?.enabled ? "stopped" : "not-configured", startedAt, restarts: Math.max(0, exits), ...(lastStatus ?? {}) }),
    refresh: check,
  };
  return session;
}
