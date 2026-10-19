import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { applyIbkrQuote, historyFromIbkrBars } from "../mcp/core.mjs";
import { createIbkrDataSession } from "../mcp/ibkr-data.mjs";

const NOW = "2026-10-19T15:00:00.000Z"; // Monday 11:00 New York, regular session
const options = { now: NOW, calendarOverrides: {} };

function publicQuote() {
  return {
    symbol: "AAPL", market: "US", currency: "USD", provider: "Yahoo Finance", source: "Yahoo Finance + Tencent Finance", price: 200, previousClose: 198, changePct: 1.01,
    asOf: "2026-10-19T14:59:50.000Z", freshness: { status: "fresh", signalEligible: true }, crossCheck: { status: "matched" }, signalEligible: true,
    dataSources: [{ provider: "Yahoo Finance", role: "primary", price: 200 }, { provider: "Tencent Finance", role: "cross-check", price: 200.05 }],
    dataQuality: { status: "ok", warnings: [] },
  };
}

test("a live TWS quote becomes the price and the public quote its cross-check", () => {
  const quote = applyIbkrQuote(publicQuote(), { price: 200.4, bid: 200.39, ask: 200.41, asOf: "2026-10-19T14:59:58.000Z", delayed: false, basis: "stream" }, options);
  assert.equal(quote.provider, "IBKR TWS");
  assert.equal(quote.price, 200.4);
  assert.equal(quote.bid, 200.39);
  assert.equal(quote.crossCheck.status, "matched");
  assert.equal(quote.signalEligible, true);
  assert.deepEqual(quote.dataSources.map((entry) => [entry.provider, entry.role]), [["IBKR TWS", "primary"], ["Yahoo Finance", "cross-check"], ["Tencent Finance", "cross-check"]]);
});

test("a delayed TWS quote is only a labelled reference, never the price", () => {
  const quote = applyIbkrQuote(publicQuote(), { price: 199.1, asOf: "2026-10-19T14:45:00.000Z", delayed: true, delayMinutes: 15, basis: "1-minute bar" }, options);
  assert.equal(quote.provider, "Yahoo Finance");
  assert.equal(quote.price, 200);
  assert.equal(quote.signalEligible, true);
  const reference = quote.dataSources.find((entry) => entry.provider === "IBKR TWS");
  assert.equal(reference.role, "reference");
  assert.equal(reference.delayed, true);
  assert.match(reference.note, /15 minutes delayed/);
  assert.equal(quote.ibkr.delayMinutes, 15);
});

test("a live TWS quote far from the public price is flagged, not trusted", () => {
  const quote = applyIbkrQuote(publicQuote(), { price: 230, asOf: "2026-10-19T14:59:58.000Z", delayed: false }, options);
  assert.equal(quote.crossCheck.status, "divergent");
  assert.equal(quote.signalEligible, false);
});

test("TWS adjusted daily bars come out in the shape of the other history providers", () => {
  // IB returns trading days only.
  const days = Array.from({ length: 45 }, (_, i) => new Date(Date.UTC(2026, 8, 1) + i * 86400000)).filter((day) => day.getUTCDay() % 6 !== 0).slice(0, 30);
  const bars = days.map((day, i) => ({ date: day.toISOString().slice(0, 10), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 1e6 }));
  const history = historyFromIbkrBars("AAPL", bars, options);
  assert.equal(history.provider, "IBKR TWS");
  assert.equal(history.price, 130);
  assert.equal(history.historyPriceBasis, "adjusted");
  assert.ok(history.history.filter((row) => !row.complete).length <= 1, "only a holiday at most is incomplete");
  assert.ok(Number.isFinite(history.indicators.sma20));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit("exit", 0);
  child.stdin.on("data", (bytes) => {
    for (const line of bytes.toString().trim().split("\n")) {
      const request = JSON.parse(line);
      const data = request.op === "status" ? { connected: true, clientId: 72 } : { quotes: [{ symbol: "AAPL", price: 201, delayed: false }], errors: {} };
      child.stdout.write(`noise from a library\nHROUTER_IBKR_DATA=${JSON.stringify({ id: request.id, ok: true, data })}\n`);
    }
  });
  return child;
}

test("the service's TWS data session runs only when IBKR is set up, answers requests and restarts after an exit", async () => {
  let config = { enabled: false, port: 7497, clientId: 71, python: null };
  const spawned = [];
  const session = createIbkrDataSession({ service: { config: async () => config }, checkEveryMs: 3600000, spawnImpl: (python, args, opts) => { spawned.push({ python, env: opts.env }); return fakeChild(); } });
  try {
    await session.start();
    assert.equal(spawned.length, 0, "not set up: nothing started");
    assert.equal(session.status().state, "not-configured");
    config = { enabled: true, port: 7497, clientId: 71, python: "/venv/bin/python" };
    await session.refresh();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].env.HROUTER_IBKR_DATA_CLIENT_ID, "72", "its own client id, next to the order client");
    assert.equal(session.status().state, "connected");
    assert.deepEqual((await session.request("quotes", { symbols: ["AAPL"] })).quotes[0].price, 201);
    await session.refresh();
    assert.equal(spawned.length, 1, "a running child is not restarted");
  } finally { session.stop(); }
});

test("TWS data server: offline contract tests (delayed marking, bar fallback)", (t) => {
  const python = process.env.HROUTER_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, ["-B", "tests/ibkr_data_server_test.py"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") { t.skip("Optional Python interpreter absent"); return; }
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
