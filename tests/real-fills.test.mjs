import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bookPrice, createArena, executionPrice, minutePricesBetween } from "../mcp/arena.mjs";
import { parseTencentQuote } from "../mcp/core.mjs";

// Thursday 2026-10-15 10:00 Asia/Shanghai.
const OPEN_A = "2026-10-15T02:00:00.000Z";
const LATER_A = "2026-10-15T02:05:00.000Z";
const reason = "Breakout above 20-day high with volume confirmation.";
const agent = { client: "kimi-code" };

test("Tencent quotes carry a five-level book with A-share sizes in shares", () => {
  const fields = Array(61).fill("");
  Object.assign(fields, { 1: "招商银行", 2: "600036", 3: "42.45", 4: "42.00", 5: "42.10", 6: "100000", 30: "20261015100000" });
  [[9, "42.44", "20"], [11, "42.43", "8"], [19, "42.45", "113"], [21, "42.46", "116"]].forEach(([index, price, size]) => { fields[index] = price; fields[index + 1] = size; });
  const quote = parseTencentQuote(`v_sh600036="${fields.join("~")}";`, "600036");
  assert.equal(quote.bid, 42.44);
  assert.equal(quote.ask, 42.45);
  assert.deepEqual(quote.asks, [{ price: 42.45, size: 11300 }, { price: 42.46, size: 11600 }]);
});

test("market orders pay the ask, receive the bid and walk the book for size", () => {
  const quote = { price: 10.0, bid: 9.99, ask: 10.01, bids: [{ price: 9.99, size: 1000 }], asks: [{ price: 10.01, size: 1000 }, { price: 10.02, size: 1000 }] };
  assert.deepEqual(bookPrice(quote, "BUY", 500), { price: 10.01, basis: "ask" });
  assert.equal(bookPrice(quote, "BUY", 2000).price, 10.015);
  assert.equal(bookPrice(quote, "BUY", 3000).basis, "book");
  assert.deepEqual(bookPrice({ price: 10 }, "BUY", 100), { price: 10, basis: "last" });
  const account = { market: "A", settings: { slippageBps: 0 } };
  assert.equal(executionPrice(account, { side: "BUY", type: "market", quantity: 100 }, quote).price, 10.01);
  assert.equal(executionPrice(account, { side: "SELL", type: "market", quantity: 100 }, quote).price, 9.99);
  // A limit buy at the last price is not marketable while the ask is above it.
  assert.equal(executionPrice(account, { side: "BUY", type: "limit", limitPrice: 10.0, quantity: 100 }, quote).blocked, "limit-not-reached");
  // Limit-up with an empty ask side cannot be bought.
  assert.equal(executionPrice(account, { side: "BUY", type: "market", quantity: 100 }, { price: 11, limitUp: 11, bids: [{ price: 11, size: 100 }], asks: [], bid: 11, ask: null }).blocked, "limit-up");
});

test("minute prices are read only between the last check and the current minute", () => {
  const bars = [{ time: "09:58", price: 10 }, { time: "09:59", price: 9.8 }, { time: "10:00", price: 9.7 }];
  assert.deepEqual(minutePricesBetween(bars, "A", "2026-10-15T01:57:30.000Z", OPEN_A), [10, 9.8]);
  assert.deepEqual(minutePricesBetween(bars, "A", "2026-10-14T06:00:00.000Z", OPEN_A), [10, 9.8]);
});

test("resting limits and stops fill when real minute prices traded through between syncs", async () => {
  let clock = OPEN_A;
  const quotes = { "600036.SS": { price: 40, bid: 39.99, ask: 40.01 }, "000300.SS": { price: 4000 } };
  let bars = [];
  const root = await mkdtemp(path.join(os.tmpdir(), "fills-test-"));
  const arena = createArena({
    root, quoteCacheMs: 0, now: () => clock,
    quoteProvider: async (symbol) => ({ symbol, name: symbol, asOf: clock, provider: "test", ...quotes[symbol] }),
    intradayProvider: async () => ({ bars }),
  });
  try {
    const { id } = await arena.createAccount({ name: "K", model: "k3", market: "A" }, agent);
    const bought = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 1000, stopLossPrice: 39, reason }, agent);
    assert.equal(bought.trade.fillBasis, "ask");
    assert.equal(bought.trade.quote.ask, 40.01);
    const resting = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, orderType: "limit", limitPrice: 39.5, reason }, agent);
    assert.equal(resting.order.status, "open");
    // Between syncs the stock printed 39.40 and recovered; the snapshot now shows 40 again.
    clock = LATER_A;
    bars = [{ time: "10:02", price: 39.8 }, { time: "10:03", price: 39.4 }, { time: "10:04", price: 39.9 }];
    const { events } = await arena.sync([id], { force: true });
    const filled = events.find((event) => event.type === "filled" && event.orderId === resting.order.id);
    assert.equal(filled.price, 39.5);
    const account = await arena.getAccount(id, { sync: false });
    assert.equal(account.trades[0].fillBasis, "minute-trade-through");
    // The 39.40 print was above the 39 stop, so the position stays.
    assert.ok(account.positions.find((position) => position.symbol === "600036.SS"));
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
