import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { makeDemoReport } from "../mcp/demo.mjs";
import { buildReportHtml } from "../mcp/dashboard.mjs";
import { startDashboard } from "../mcp/http.mjs";

// The workbench UI helpers are TypeScript; bundle them once for the tests.
async function helpers() {
  const dir = await mkdtemp(path.join(process.cwd(), "node_modules", ".web-ui-test-"));
  const outfile = path.join(dir, "helpers.mjs");
  await build({ stdin: { contents: 'export * from "./web/src/lib/format.ts"; export * from "./web/src/lib/market.ts";', resolveDir: process.cwd(), loader: "ts" }, outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const module = await import(pathToFileURL(outfile));
  return { ...module, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("UI: missing numbers stay unavailable, unsafe links are rejected, signs are explicit", async () => {
  const { num, pct, safeUrl, valueLabel, changeLabel, cleanup } = await helpers();
  try {
    for (const missing of [null, undefined, NaN, Infinity, "12"]) assert.equal(num(missing), "—");
    assert.equal(num(0), "0.00");
    assert.equal(pct(null), "—");
    assert.equal(pct(1.5), "+1.50%");
    assert.equal(pct(-0.2), "−0.20%");
    assert.equal(safeUrl("javascript:alert(1)"), null);
    assert.equal(safeUrl("https://user:pass@example.com"), null);
    assert.equal(safeUrl("https://example.com/filing"), "https://example.com/filing");
    assert.equal(valueLabel("minCashPct", null), "不限制");
    assert.equal(valueLabel("excludeBoards", ["st", "star"]), "ST、科创板");
    assert.equal(changeLabel("lock:minCashPct"), "锁定「保留现金」");
  } finally { await cleanup(); }
});

test("UI: candles never fabricate missing OHLC; samples are sorted and deduplicated", async () => {
  const { chartBars, cleanup } = await helpers();
  try {
    const item = { history: [
      { timestamp: "2026-09-01", close: 100, open: 95, high: 101, low: 94, volume: 100 },
      { timestamp: "2026-09-02", close: 102 },
      { timestamp: "2026-09-03", close: 105, open: 100, high: 103, low: 99 },
      { timestamp: "bad", close: 12 },
    ] };
    assert.equal(chartBars(item, "daily", "candles").length, 1);
    assert.equal(chartBars(item, "daily", "line").length, 3);
    assert.equal(chartBars(item, "intraday").length, 0);
    const rows = chartBars({ history: [{ timestamp: 1700000000, close: 1 }, { timestamp: 1600000000000, close: 2 }, { timestamp: 1700000000000, close: 3 }] });
    assert.deepEqual(rows.map((row) => row.close), [2, 3]);
  } finally { await cleanup(); }
});

test("UI: fresh labels expire with the clock; evidence projection keeps event revisions", async () => {
  const { quoteStatus, crossStatus, collectEvidence, cleanup } = await helpers();
  try {
    const now = Date.parse("2026-09-10T00:00:00Z");
    const item = { freshness: { status: "fresh", maxAgeSeconds: 300 }, asOf: "2026-09-09T23:59:00Z" };
    assert.equal(quoteStatus(item, { now }), "fresh");
    assert.equal(quoteStatus(item, { now: now + 3600000 }), "stale");
    assert.equal(quoteStatus({ freshness: { status: "fresh" } }, { now }), "stale");
    assert.equal(quoteStatus({ ...item, error: "outage" }, { now }), "error");
    assert.equal(crossStatus({ crossCheck: { status: "currency-mismatch" } }), "conflict");
    const raw = { id: "ev_a", entity: { symbol: "AAPL" }, title: "Original", payload: { metric: "Revenue" }, sourceUrl: "https://example.com" };
    const report = { events: [{ id: "ev_a", symbol: "AAPL", title: "Latest", eventStatus: "cancelled", scheduledAt: "2026-10-04T20:00:00Z" }], evidence: [raw], items: [{ symbol: "AAPL", evidence: [raw] }] };
    assert.equal(collectEvidence(report).length, 1);
    assert.equal(collectEvidence(report)[0].eventStatus, "cancelled");
    assert.equal(collectEvidence(report, "MSFT").length, 0);
  } finally { await cleanup(); }
});

test("UI: the HTML shell loads one local bundle and never a CDN; embedded data cannot break out", () => {
  const html = buildReportHtml({ items: [], title: "</script><script>alert(1)</script>" });
  assert.match(html, /<script type="module" src="\/assets\/app\/app.js"><\/script>/);
  assert.match(html, /href="\/assets\/app\/app.css"/);
  assert.doesNotMatch(html, /unpkg|jsdelivr|cdnjs|https:\/\/[^"]*\.js/);
  assert.doesNotMatch(html, /<\/script><script>alert/);
});

test("UI: demo server serves workbench routes, guards bundle paths and keeps the research APIs", async () => {
  const server = startDashboard({ demo: true, port: 0, matcher: false });
  await server.ready;
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  try {
    for (const route of ["/", "/traders", "/traders/acc_0123456789ab", "/arena", "/market", "/research", "/reports", "/strategies", "/skills", "/schedule", "/settings"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.match(await response.text(), /assets\/app\/app\.js/);
    }
    assert.equal((await fetch(base + "/assets/app/../../package.json")).status, 404);
    assert.equal((await fetch(base + "/assets/app/app.exe")).status, 404);
    assert.equal((await fetch(base + "/traders/evil")).status, 404);
    const markets = await (await fetch(base + "/api/markets")).json();
    assert.ok(["A", "HK", "US"].every((market) => typeof markets[market].status === "string"));
    await post("/api/preferences", { watchlist: ["AAPL"], language: "zh-CN", positions: [] });
    const report = await post("/api/refresh", { phase: "research" });
    assert.equal(report.items.length, 1);
    const record = await post("/api/decisions", { symbol: "AAPL", thesis: "Synthetic UI test", state: "watch", pillars: [{ id: "growth", expectation: "Growth", invalidationCondition: "Decline" }] });
    const reviewed = await post(`/api/decisions/${record.id}/review`, { outcome: "open", notes: "UI review" });
    assert.equal(reviewed.reviews.length, 1);
    const evidence = await (await fetch(base + "/api/evidence")).json();
    assert.ok(Array.isArray(evidence.events));
    const library = await (await fetch(base + "/api/library")).json();
    assert.ok(library.templates.some((template) => template.id === "a-share-swing"));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("UI: demo honors saved scope without inventing prices for unknown securities", () => {
  const report = makeDemoReport({ now: "2026-10-04T12:00:00Z", watchlist: ["AAPL", "UNKNOWN"] });
  assert.deepEqual(report.items.map((item) => item.symbol), ["AAPL", "UNKNOWN"]);
  assert.equal(report.items[1].price, undefined);
  assert.match(report.items[1].error, /synthetic fixture/);
});
