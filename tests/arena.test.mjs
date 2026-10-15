import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callerFromClient, computeFees, computeMetrics, createArena, tickSize } from "../mcp/arena.mjs";

// Thursday 2026-10-15 10:00 Asia/Shanghai: A-share continuous session.
const OPEN_A = "2026-10-15T02:00:00.000Z";
const NEXT_DAY_A = "2026-10-16T02:00:00.000Z";
const CLOSED_A = "2026-10-15T12:00:00.000Z";
const OPEN_HK = "2026-10-15T02:00:00.000Z";

function harness(prices = {}) {
  let clock = OPEN_A;
  const quotes = { ...prices };
  return {
    setNow: (value) => { clock = value; },
    setQuote: (symbol, quote) => { quotes[symbol] = { ...quotes[symbol], ...quote }; },
    async make() {
      const root = await mkdtemp(path.join(os.tmpdir(), "arena-test-"));
      const arena = createArena({
        root,
        quoteCacheMs: 0,
        now: () => clock,
        quoteProvider: async (symbol) => {
          const entry = quotes[symbol];
          if (!entry) throw new Error(`no quote for ${symbol}`);
          return { symbol, name: entry.name ?? symbol, price: entry.price, asOf: entry.asOf ?? clock, provider: "test", lotSize: entry.lotSize ?? null, limitUp: entry.limitUp ?? null, limitDown: entry.limitDown ?? null };
        },
      });
      return { arena, root, cleanup: () => rm(root, { recursive: true, force: true }) };
    },
  };
}

const claude = { client: "claude-code" };
const codex = { client: "codex-mcp-client" };
const reason = "Breakout above 20-day high with volume confirmation.";

test("fee presets follow A, HK and US retail schedules", () => {
  assert.deepEqual(computeFees("A", "BUY", 100, 10), { total: 5.01, breakdown: { commission: 5, transferFee: 0.01 } });
  const sell = computeFees("A", "SELL", 1000, 100);
  assert.equal(sell.breakdown.stampDuty, 50);
  assert.equal(sell.breakdown.commission, 25);
  const hk = computeFees("HK", "BUY", 100, 400);
  assert.equal(hk.breakdown.stampDuty, 40);
  assert.equal(hk.breakdown.commission, 12);
  assert.equal(hk.breakdown.settlement, 2);
  assert.equal(computeFees("US", "BUY", 10, 300).total, 1);
  assert.ok(computeFees("US", "SELL", 100, 300).breakdown.secFee > 0);
  assert.equal(tickSize("HK", 417.8), 0.2);
  assert.equal(tickSize("HK", 3.5), 0.01);
});

test("market buy fills with slippage, fees and exact cash accounting", async () => {
  const h = harness({ "600519.SS": { price: 1300, name: "贵州茅台" }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const account = await arena.createAccount({ name: "Opus", model: "claude-opus-5-5", market: "A", strategySummary: "Momentum rotation" }, claude);
    assert.equal(account.cash ?? account.metrics.cash, 1000000);
    assert.equal(account.agent.client, "claude-code");
    assert.equal(account.benchmark.startPrice, 4000);
    const result = await arena.placeOrder({ accountId: account.id, symbol: "600519", side: "BUY", quantity: 100, reason }, claude);
    assert.equal(result.order.status, "filled");
    assert.equal(result.trade.price, 1300.65);
    assert.equal(result.trade.fees, 33.82);
    const detail = await arena.getAccount(account.id, { sync: false });
    assert.equal(detail.metrics.cash, 1000000 - 130065 - 33.82);
    assert.equal(detail.positions[0].quantity, 100);
    assert.equal(detail.positions[0].averageCost, 1300.9882);
  } finally { await cleanup(); }
});

test("A-share T+1, board lots and price limits are enforced", async () => {
  const h = harness({ "600519.SS": { price: 1300 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "Rules", model: "m", market: "A" }, claude);
    const odd = await arena.placeOrder({ accountId: id, symbol: "600519.SS", side: "BUY", quantity: 50, reason }, claude);
    assert.equal(odd.order.status, "rejected");
    assert.match(odd.error, /Minimum buy/);
    const notLot = await arena.placeOrder({ accountId: id, symbol: "600519.SS", side: "BUY", quantity: 150, reason }, claude);
    assert.match(notLot.error, /board lot/);
    await arena.placeOrder({ accountId: id, symbol: "600519.SS", side: "BUY", quantity: 200, reason }, claude);
    const sameDay = await arena.placeOrder({ accountId: id, symbol: "600519.SS", side: "SELL", quantity: 100, reason }, claude);
    assert.equal(sameDay.order.status, "rejected");
    assert.match(sameDay.error, /T\+1/);
    h.setNow(NEXT_DAY_A);
    h.setQuote("600519.SS", { price: 1350 });
    const sold = await arena.placeOrder({ accountId: id, symbol: "600519.SS", side: "SELL", quantity: 100, reason }, claude);
    assert.equal(sold.order.status, "filled");
    assert.ok(sold.trade.realizedPnl > 4000);
    h.setQuote("600519.SS", { price: 1430, limitUp: 1430, limitDown: 1170 });
    const limitUp = await arena.placeOrder({ accountId: id, symbol: "600519.SS", side: "BUY", quantity: 100, reason }, claude);
    assert.equal(limitUp.order.status, "rejected");
    assert.match(limitUp.error, /limit-up/);
    const outside = await arena.placeOrder({ accountId: id, symbol: "600519.SS", side: "BUY", quantity: 100, orderType: "limit", limitPrice: 1500, reason }, claude);
    assert.match(outside.error, /price band/);
    const metrics = (await arena.getAccount(id, { sync: false })).metrics;
    assert.equal(metrics.ordersRejected, 5);
    assert.equal(metrics.closedTrades, 1);
    assert.equal(metrics.winRatePct, 100);
  } finally { await cleanup(); }
});

test("limit orders rest, fill on a later marketable sync and day orders expire", async () => {
  const h = harness({ "601318.SS": { price: 60 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "Limits", model: "m", market: "A" }, claude);
    const resting = await arena.placeOrder({ accountId: id, symbol: "601318", side: "BUY", quantity: 1000, orderType: "limit", limitPrice: 58, reason }, claude);
    assert.equal(resting.order.status, "open");
    assert.equal(resting.order.reserved, 58000 + computeFees("A", "BUY", 1000, 58).total);
    assert.equal((await arena.getAccount(id, { sync: false })).metrics.availableCash, 1000000 - resting.order.reserved);
    h.setQuote("601318.SS", { price: 57.5 });
    const { events } = await arena.sync([id], { force: true });
    assert.equal(events.filter((event) => event.type === "filled").length, 1);
    const filled = await arena.getAccount(id, { sync: false });
    assert.equal(filled.trades[0].price, 57.53);
    const expiring = await arena.placeOrder({ accountId: id, symbol: "601318", side: "BUY", quantity: 100, orderType: "limit", limitPrice: 50, reason }, claude);
    assert.equal(expiring.order.status, "open");
    h.setNow(CLOSED_A);
    await arena.sync([id], { force: true });
    const after = await arena.getAccount(id, { sync: false });
    assert.equal(after.orders.find((order) => order.id === expiring.order.id).status, "expired");
    assert.equal(after.metrics.openOrders, 0);
  } finally { await cleanup(); }
});

test("closed markets reject market orders and insufficient cash is refused", async () => {
  const h = harness({ "601318.SS": { price: 60 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "Cash", model: "m", market: "A", initialCash: 10000 }, claude);
    h.setNow(CLOSED_A);
    const closed = await arena.placeOrder({ accountId: id, symbol: "601318", side: "BUY", quantity: 100, reason }, claude);
    assert.match(closed.error, /Market is (postmarket|closed)/);
    h.setNow(OPEN_A);
    const tooBig = await arena.placeOrder({ accountId: id, symbol: "601318", side: "BUY", quantity: 200, reason }, claude);
    assert.match(tooBig.error, /Insufficient available cash/);
    const index = await arena.placeOrder({ accountId: id, symbol: "000300.SS", side: "BUY", quantity: 100, reason }, claude).catch((error) => error);
    assert.match(index.message, /index/);
    const wrongMarket = await arena.placeOrder({ accountId: id, symbol: "AAPL", side: "BUY", quantity: 1, reason }, claude).catch((error) => error);
    assert.match(wrongMarket.message, /not a A security/);
  } finally { await cleanup(); }
});

test("accounts are bound to their agent and idempotency keys replay the original order", async () => {
  const h = harness({ "600036.SS": { price: 40 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "Bound", model: "m", market: "A" }, claude);
    await assert.rejects(arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, reason }, codex), /belongs to agent "claude-code"/);
    const first = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, reason, clientOrderId: "retry-001" }, claude);
    const again = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, reason, clientOrderId: "retry-001" }, claude);
    assert.equal(again.duplicate, true);
    assert.equal(again.order.id, first.order.id);
    assert.equal((await arena.getAccount(id, { sync: false })).trades.length, 1);
    const dashboard = await arena.createAccount({ name: "UI made", model: "gpt-5.5-codex", market: "A" }, { client: "dashboard" });
    assert.equal(dashboard.agent.client, null);
    await arena.placeOrder({ accountId: dashboard.id, symbol: "600036", side: "BUY", quantity: 100, reason }, codex);
    assert.equal((await arena.getAccount(dashboard.id, { sync: false })).agent.client, "codex-mcp-client");
  } finally { await cleanup(); }
});

test("HK board lots come from the quote and US trades single shares", async () => {
  const h = harness({ "0700.HK": { price: 417.8, lotSize: 100 }, "^HSI": { price: 25000 } });
  h.setNow(OPEN_HK);
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "HK", model: "m", market: "HK" }, claude);
    const odd = await arena.placeOrder({ accountId: id, symbol: "700", side: "BUY", quantity: 50, reason }, claude);
    assert.match(odd.error, /Minimum buy/);
    const ok = await arena.placeOrder({ accountId: id, symbol: "00700", side: "BUY", quantity: 200, reason }, claude);
    assert.equal(ok.order.status, "filled");
    assert.equal(ok.trade.price, 418.2);
  } finally { await cleanup(); }
});

test("concurrent agents on separate processes never lose each other's writes", async () => {
  const h = harness({ "600036.SS": { price: 40 }, "000300.SS": { price: 4000 } });
  const first = await h.make();
  const second = createArena({ root: first.root, now: () => OPEN_A, quoteProvider: async () => ({ price: 40, asOf: OPEN_A, provider: "test" }) });
  try {
    const { id } = await first.arena.createAccount({ name: "Race", model: "m", market: "A" }, claude);
    await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? second : first.arena)
      .placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, reason, clientOrderId: `race-${index}` }, claude)));
    const detail = await first.arena.getAccount(id, { sync: false });
    assert.equal(detail.trades.length, 12);
    assert.equal(detail.positions[0].quantity, 1200);
  } finally { await first.cleanup(); }
});

test("leaderboard ranks accounts within a market and competition", async () => {
  const h = harness({ "600036.SS": { price: 40 }, "000300.SS": { price: 4000 }, "AAPL": { price: 300 }, "^GSPC": { price: 6000 } });
  const { arena, cleanup } = await h.make();
  try {
    const winner = await arena.createAccount({ name: "Winner", model: "a", market: "A" }, claude);
    const loser = await arena.createAccount({ name: "Loser", model: "b", market: "A" }, codex);
    await arena.createAccount({ name: "US", model: "c", market: "US" }, codex);
    await arena.placeOrder({ accountId: winner.id, symbol: "600036", side: "BUY", quantity: 10000, reason }, claude);
    await arena.placeOrder({ accountId: loser.id, symbol: "600036", side: "BUY", quantity: 10000, reason }, codex);
    h.setNow(NEXT_DAY_A);
    h.setQuote("600036.SS", { price: 44 });
    await arena.placeOrder({ accountId: winner.id, symbol: "600036", side: "SELL", quantity: 10000, reason }, claude);
    h.setQuote("600036.SS", { price: 36 });
    await arena.placeOrder({ accountId: loser.id, symbol: "600036", side: "SELL", quantity: 10000, reason }, codex);
    const board = await arena.leaderboard({ sync: false });
    const group = board.groups.find((entry) => entry.market === "A");
    assert.deepEqual(group.accounts.map((account) => account.name), ["Winner", "Loser"]);
    assert.equal(group.accounts[0].rank, 1);
    assert.ok(group.accounts[1].metrics.totalReturnPct < 0);
    assert.equal(board.groups.length, 2);
  } finally { await cleanup(); }
});

test("metrics compute drawdown, Sharpe and per-strategy attribution", () => {
  const start = Date.parse("2026-09-01T07:00:00Z");
  const equity = [100, 104, 102, 108, 99, 103, 110].map((value, day) => ({ at: new Date(start + day * 86400000).toISOString(), equity: value * 1000 }));
  const account = {
    market: "A", initialCash: 100000, cash: 110000, createdAt: new Date(start - 1000).toISOString(), positions: {}, equity, journal: [], orders: [],
    benchmark: { symbol: "000300.SS", startPrice: 4000 },
    trades: [
      { side: "SELL", realizedPnl: 500, fees: 5, gross: 10000, strategyVersion: 1 },
      { side: "SELL", realizedPnl: -200, fees: 5, gross: 10000, strategyVersion: 2 },
      { side: "BUY", realizedPnl: null, fees: 5, gross: 10000, strategyVersion: 2 },
    ],
  };
  const metrics = computeMetrics(account, { benchmarkPrice: 4200 });
  assert.equal(metrics.totalReturnPct, 10);
  assert.equal(metrics.maxDrawdownPct, -8.33);
  assert.equal(metrics.benchmarkReturnPct, 5);
  assert.equal(metrics.excessReturnPct, 5);
  assert.equal(metrics.winRatePct, 50);
  assert.equal(metrics.profitFactor, 2.5);
  assert.ok(metrics.sharpe > 0);
  assert.deepEqual(metrics.byStrategyVersion.map((entry) => [entry.version, entry.trades, entry.realizedPnl]), [[1, 1, 500], [2, 2, -200]]);
});

test("caller identity normalizes MCP client info and honours HROUTER_AGENT_ID", () => {
  assert.equal(callerFromClient({ name: "Claude Code", version: "2.1" }).client, "claude-code");
  process.env.HROUTER_AGENT_ID = "workbuddy-hunyuan";
  try { assert.equal(callerFromClient({ name: "WorkBuddy" }).client, "workbuddy-hunyuan"); }
  finally { delete process.env.HROUTER_AGENT_ID; }
});
