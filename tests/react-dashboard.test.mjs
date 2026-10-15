import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatNumber, formatPercent, safeUrl, chartBars, collectEvidence, quoteStatus, crossStatus, holdingsFor, portfolioGroups, api } from "../ui/data.mjs";
import { makeDemoReport } from "../mcp/demo.mjs";
import { buildReportHtml } from "../mcp/dashboard.mjs";
import { startDashboard } from "../mcp/http.mjs";

test("React UI: missing numbers remain unavailable, unsafe source links are rejected", () => {
  for (const missing of [null, undefined, NaN, Infinity, "12"]) assert.equal(formatNumber(missing), "—");
  assert.equal(formatNumber(0), "0.00");
  assert.equal(formatPercent(null), "—");
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("https://user:pass@example.com"), null);
  assert.equal(safeUrl("https://example.com/filing"), "https://example.com/filing");
});

test("React UI: candle rendering never fabricates missing OHLC or uses invalid ranges", () => {
  const item = { history: [
    { timestamp: "2026-09-01", close: 100, open: 95, high: 101, low: 94, volume: 100 },
    { timestamp: "2026-09-02", close: 102 },
    { timestamp: "2026-09-03", close: 105, open: 100, high: 103, low: 99 },
    { timestamp: "bad", close: 12 },
  ] };
  assert.equal(chartBars(item, "daily", "candles").length, 1);
  assert.equal(chartBars(item, "daily", "line").length, 3);
  assert.equal(chartBars(item, "intraday").length, 0);
});

test("React UI: chart samples are sorted and deduplicated by time", () => {
  const rows = chartBars({ history: [{ timestamp: 1700000000, close: 1 }, { timestamp: 1600000000000, close: 2 }, { timestamp: 1700000000000, close: 3 }] });
  assert.deepEqual(rows.map((r) => r.close), [2, 3]);
});

test("React UI: expired fresh labels downgrade as the clock advances, including absent timestamps", () => {
  const now = Date.parse("2026-09-10T00:00:00Z");
  const item = { freshness: { status: "fresh", maxAgeSeconds: 300 }, asOf: "2026-09-09T23:59:00Z" };
  assert.equal(quoteStatus(item, { now }), "fresh");
  assert.equal(quoteStatus(item, { now: now + 3600000 }), "stale");
  assert.equal(quoteStatus({ freshness: { status: "fresh" } }, { now }), "stale");
  assert.equal(quoteStatus({ ...item, freshness: { status: "market-closed" } }, { now }), "closed");
  assert.equal(quoteStatus({ ...item, error: "outage" }, { now }), "error");
  assert.equal(crossStatus({ crossCheck: { status: "fallback" } }), "single");
  assert.equal(crossStatus({ crossCheck: { status: "currency-mismatch" } }), "conflict");
});

test("React UI: saved empty holdings override stale report positions; currencies never merge", () => {
  const items = [
    { symbol: "AAPL", price: 120, currency: "USD", position: { quantity: 2, averageCost: 100 } },
    { symbol: "0700.HK", price: 500, currency: "HKD" },
  ];
  assert.equal(holdingsFor(items, []).length, 0);
  const holdings = holdingsFor(items, [{ symbol: "AAPL", quantity: 2, averageCost: 100, currency: "USD" }, { symbol: "0700.HK", quantity: 1, averageCost: 450, currency: "HKD" }]);
  const groups = portfolioGroups(holdings);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.currency === "USD").marketValue, 240);
  assert.equal(groups.find((g) => g.currency === "HKD").pnl, 50);
});

test("React UI: missing quotes and mismatched cost currency do not create fake valuation", () => {
  const rows = holdingsFor([{ symbol: "AAPL", price: 120, currency: "USD" }], [
    { symbol: "AAPL", currency: "CNY", quantity: 5, averageCost: 100 },
    { symbol: "MISSING", currency: "USD", quantity: 5, averageCost: 100 },
  ]);
  assert.equal(rows[0].currencyMismatch, true);
  assert.equal(rows[0].marketValue, null);
  assert.equal(rows[1].pnl, null);
  assert.ok(portfolioGroups(rows).every((g) => g.marketValue === null));
});

test("React UI: event projection survives raw-evidence deduplication and scoped filters", () => {
  const raw = { id: "ev_a", entity: { symbol: "AAPL" }, title: "Original", payload: { metric: "Revenue" }, sourceUrl: "https://example.com" };
  const report = { events: [{ id: "ev_a", symbol: "AAPL", title: "Latest", eventStatus: "cancelled", scheduledAt: "2026-10-04T20:00:00Z" }], evidence: [raw], items: [{ symbol: "AAPL", evidence: [raw] }] };
  assert.equal(collectEvidence(report).length, 1);
  assert.equal(collectEvidence(report)[0].eventStatus, "cancelled");
  assert.equal(collectEvidence(report)[0].payload.metric, "Revenue");
  assert.equal(collectEvidence(report, "MSFT").length, 0);
});

test("React UI: write failures are surfaced without retrying or losing the original request", async () => {
  const original = globalThis.fetch; let count = 0;
  globalThis.fetch = async (_, options) => { count++; assert.equal(options.method, "POST"); return Response.json({ error: "Candidate requires validation" }, { status: 400 }); };
  try { await assert.rejects(api("/api/decisions", { state: "candidate" }), /requires validation/); assert.equal(count, 1); }
  finally { globalThis.fetch = original; }
});

test("React UI: all routes server-render safely, including empty and malicious source content", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), "node_modules", ".react-render-test-"));
  try {
    const outfile = path.join(dir, "app.mjs");
    await build({ entryPoints: ["ui/App.jsx"], outfile, bundle: true, packages: "external", platform: "node", format: "esm", jsx: "automatic", logLevel: "silent" });
    const { default: App } = await import(pathToFileURL(outfile));
    const demo = makeDemoReport({ now: "2026-10-04T12:00:00Z" });
    for (const initialView of ["market", "portfolio", "evidence", "journal", "paper"]) {
      const html = renderToStaticMarkup(React.createElement(App, { initialReport: demo, initialView }));
      assert.match(html, /workspace-shell/);
      assert.match(html, /演示模式/);
      assert.doesNotMatch(html, /NaN|undefined/);
    }
    const arena = renderToStaticMarkup(React.createElement(App, { initialReport: demo, initialView: "arena" }));
    assert.match(arena, /Agent 竞技场/);
    assert.match(arena, /富途模拟盘/);
    assert.doesNotMatch(arena, /NaN|undefined/);
    const empty = renderToStaticMarkup(React.createElement(App, { initialReport: { items: [] } }));
    assert.match(empty, /从自选列表开始/);
    assert.doesNotMatch(empty, /3,867|518\.20/);
    const malicious = renderToStaticMarkup(React.createElement(App, { initialReport: { items: [], evidence: [{ id: "evil", title: '<img src=x onerror="alert(1)">', sourceUrl: "javascript:alert(1)" }] }, initialView: "evidence" }));
    assert.match(malicious, /&lt;img/);
    assert.doesNotMatch(malicious, /href="javascript:|<img src=x/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("React UI: HTML uses a single local application bundle, not runtime CDNs or duplicate chart globals", () => {
  const html = buildReportHtml({ items: [] });
  assert.match(html, /src="\/assets\/dashboard.js"/);
  assert.doesNotMatch(html, /vendor\/lightweight-charts|vendor\/lucide|unpkg|jsdelivr|https:\/\/.*\.js/);
  assert.match(html, /content="light dark"/);
});

test("React UI: demo honors saved scope without inventing prices for unknown securities", () => {
  const report = makeDemoReport({ now: "2026-10-04T12:00:00Z", watchlist: ["AAPL", "UNKNOWN"] });
  assert.deepEqual(report.items.map((i) => i.symbol), ["AAPL", "UNKNOWN"]);
  assert.equal(report.items[1].price, undefined);
  assert.match(report.items[1].error, /synthetic fixture/);
  assert.equal(report.summary.succeeded, 1);
  assert.equal(report.summary.failed, 1);
  assert.ok(report.events.every((e) => e.symbol === "AAPL"));
  assert.equal(makeDemoReport({ watchlist: [] }).items.length, 0);
});

test("React UI: demo HTTP settings, refresh, decisions and evidence remain integrated", async () => {
  const server = startDashboard({ demo: true, port: 0 });
  await server.ready;
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  try {
    await post("/api/preferences", { watchlist: ["AAPL"], language: "en", positions: [] });
    const report = await post("/api/refresh", { phase: "research" });
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].position, null);
    const record = await post("/api/decisions", { symbol: "AAPL", thesis: "Synthetic UI test", state: "watch", pillars: [{ id: "growth", expectation: "Growth", invalidationCondition: "Decline" }] });
    const reviewed = await post(`/api/decisions/${record.id}/review`, { outcome: "open", notes: "UI review" });
    assert.equal(reviewed.reviews.length, 1);
    const decisions = await (await fetch(base + "/api/decisions")).json();
    assert.equal(decisions.decisions.find((r) => r.id === record.id).scorecard.pillars[0].status, "unreviewed");
    const evidence = await (await fetch(base + "/api/evidence")).json();
    assert.ok(Array.isArray(evidence.events));
    assert.ok(Array.isArray(evidence.eventWarnings));
    assert.equal((await fetch(base + "/assets/dashboard.js.LEGAL.txt")).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
