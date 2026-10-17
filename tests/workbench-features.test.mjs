import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArena } from "../mcp/arena.mjs";

// Thursday 2026-10-15 10:00 Asia/Shanghai: A-share continuous session.
const OPEN_A = "2026-10-15T02:00:00.000Z";
const reason = "Breakout above 20-day high with volume confirmation.";
const agent = { client: "kimi-code" };
const owner = { client: "dashboard" };

export async function setup(prices, { industries = {}, ...options } = {}) {
  let clock = OPEN_A;
  const quotes = { "000300.SS": { price: 4000 }, ...prices };
  const root = await mkdtemp(path.join(os.tmpdir(), "features-test-"));
  const lookups = [];
  const arena = createArena({
    root, quoteCacheMs: 0, now: () => clock,
    quoteProvider: async (symbol) => {
      const entry = quotes[symbol];
      if (!entry) throw new Error(`no quote for ${symbol}`);
      return { symbol, name: entry.name ?? symbol, price: entry.price, bid: entry.bid, ask: entry.ask, changePct: entry.changePct ?? 0, asOf: clock, provider: "test", freshness: { status: "fresh" } };
    },
    industryProvider: async (symbols) => { lookups.push(symbols); return Object.fromEntries(symbols.filter((symbol) => industries[symbol]).map((symbol) => [symbol, industries[symbol]])); },
    ...options,
  });
  return { arena, root, lookups, setNow: (value) => { clock = value; }, now: () => clock, setQuote: (symbol, quote) => { quotes[symbol] = { ...quotes[symbol], ...quote }; }, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("the per-industry limit counts held and resting buys by industry; unknown industries are not counted", async () => {
  const { arena, cleanup } = await setup(
    { "600036.SS": { price: 40 }, "601166.SS": { price: 20 }, "600900.SS": { price: 28 }, "601988.SS": { price: 5 } },
    { industries: { "600036.SS": "银行", "601166.SS": "银行", "600900.SS": "电力" } },
  );
  try {
    const { id } = await arena.createAccount({ name: "K", model: "k3", market: "A", limits: { minCashPct: null, maxIndustryPct: 30 } }, agent);
    const bank = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 5000, reason }, agent);
    assert.equal(bank.order.status, "filled");
    assert.equal(bank.order.industry, "银行");
    assert.equal((await arena.getAccount(id, { sync: false })).positions.find((position) => position.symbol === "600036.SS").industry, "银行");
    // 200k bank already; another 120k bank stock would make banks 32% of 1M equity.
    const second = await arena.placeOrder({ accountId: id, symbol: "601166", side: "BUY", quantity: 6000, reason }, agent);
    assert.equal(second.order.status, "rejected");
    assert.match(second.error, /单行业上限.*银行.*32/);
    assert.equal((await arena.placeOrder({ accountId: id, symbol: "601166", side: "BUY", quantity: 4000, reason }, agent)).order.status, "filled", "28% fits");
    assert.equal((await arena.placeOrder({ accountId: id, symbol: "600900", side: "BUY", quantity: 10000, reason }, agent)).order.status, "filled", "another industry");
    assert.equal((await arena.placeOrder({ accountId: id, symbol: "601988", side: "BUY", quantity: 80000, reason }, agent)).order.status, "filled", "unknown industry is not counted");
    const status = (await arena.getAccount(id, { sync: false })).limitStatus;
    assert.deepEqual(status.industries.map((entry) => entry.industry), ["电力", "银行"]);
  } finally { await cleanup(); }
});

test("orders and fills keep the cited sources and the quote they saw", async () => {
  const { arena, cleanup } = await setup({ "600036.SS": { price: 40, bid: 39.99, ask: 40.01 } });
  try {
    const { id } = await arena.createAccount({ name: "K", model: "k3", market: "A" }, agent);
    const citations = [
      { kind: "news", title: "招商银行三季报预增", url: "https://finance.eastmoney.com/a/1.html", source: "东方财富", publishedAt: "2026-10-14T09:00:00+08:00" },
      { kind: "filing", title: "2026 年第三季度业绩快报" },
    ];
    const result = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 1000, reason, citations }, agent);
    assert.equal(result.order.citations.length, 2);
    assert.equal(result.order.citations[0].publishedAt, "2026-10-14T01:00:00.000Z");
    assert.deepEqual(result.trade.citations, result.order.citations);
    assert.deepEqual(result.trade.quote, { price: 40, bid: 39.99, ask: 40.01, asOf: OPEN_A, source: "test", changePct: 0, freshness: "fresh" });
    await assert.rejects(arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, reason, citations: [{ title: "x", url: "javascript:alert(1)" }] }, agent), /invalid url/);
  } finally { await cleanup(); }
});
