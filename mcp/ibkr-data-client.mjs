// Read US market data from TWS / IB Gateway through the workbench service's one data session.
// The service process talks to its session directly; every other process (agents' MCP servers,
// the CLI) asks the service over loopback HTTP. When TWS is not connected these return null and
// callers keep using the public sources. Nothing here may import core.mjs (core imports this file).

import { readFile } from "node:fs/promises";
import path from "node:path";

const UNAVAILABLE_BACKOFF_MS = 30000;
let localSession = null;
let unavailableUntil = 0;
let statusFile = null;

// The service registers its session so its own lookups skip HTTP.
export function setLocalIbkrDataSession(session) { localSession = session; }
export function configureIbkrDataClient({ storageDir }) { statusFile = path.join(storageDir, "arena", "service-status.json"); }

async function servicePort() {
  if (!statusFile) return null;
  try {
    const status = JSON.parse(await readFile(statusFile, "utf8"));
    if (Date.now() - Date.parse(status.heartbeatAt) > 120000 || !Number.isInteger(status.port)) return null;
    return status.port;
  } catch { return null; }
}

async function call(op, payload, { timeoutMs = 20000 } = {}) {
  if (Date.now() < unavailableUntil) return null;
  try {
    if (localSession) {
      if (!localSession.connected()) throw new Error("TWS not connected");
      return await localSession.request(op, payload, { timeoutMs });
    }
    const port = await servicePort();
    if (!port) throw new Error("workbench service not running");
    const query = new URLSearchParams(Object.entries(payload).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]));
    const response = await fetch(`http://127.0.0.1:${port}/api/ibkr/data/${op}?${query}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body;
  } catch {
    unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
    return null;
  }
}

const US = /^[A-Z][A-Z0-9.\-]{0,14}$/;

// { price, bid, ask, previousClose, asOf, delayed, delayMinutes, basis, marketDataType } or null.
export async function ibkrQuote(symbol) {
  if (!US.test(symbol)) return null;
  const result = await call("quotes", { symbols: [symbol] }, { timeoutMs: 25000 });
  return result?.quotes?.find((entry) => entry.symbol === symbol && Number.isFinite(entry.price) && entry.price > 0) ?? null;
}

export async function ibkrQuotes(symbols) {
  const list = [...new Set(symbols)].filter((symbol) => US.test(symbol)).slice(0, 60);
  if (!list.length) return [];
  const result = await call("quotes", { symbols: list }, { timeoutMs: 60000 });
  return (result?.quotes ?? []).filter((entry) => Number.isFinite(entry.price) && entry.price > 0);
}

export async function ibkrBars(symbol, { duration = "1 Y", barSize = "1 day", what = "TRADES", useRTH = true } = {}) {
  if (!US.test(symbol)) return null;
  const result = await call("bars", { symbol, duration, barSize, what, useRTH: useRTH ? 1 : 0 }, { timeoutMs: 40000 });
  return result?.bars?.length ? result : null;
}

export async function ibkrScan({ scanCode, rows = 30, abovePrice, aboveVolume, marketCapAbove } = {}) {
  const result = await call("scan", { scanCode, rows, abovePrice, aboveVolume, marketCapAbove }, { timeoutMs: 90000 });
  return result?.rows?.length ? result : null;
}

export async function ibkrDataStatus() {
  if (localSession) return localSession.status();
  const port = await servicePort();
  if (!port) return { state: "service-not-running" };
  try { return await (await fetch(`http://127.0.0.1:${port}/api/ibkr/data/status`, { signal: AbortSignal.timeout(5000) })).json(); }
  catch (error) { return { state: "unreachable", error: error.message }; }
}

export function resetIbkrDataClient() { unavailableUntil = 0; }
