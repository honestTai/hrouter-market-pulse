import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callerFromClient, computeFees, computeMetrics, createArena, createMatcher, deliverDigest, runHealth, tickSize } from "../mcp/arena.mjs";

// Thursday 2026-10-15 10:00 Asia/Shanghai: A-share continuous session.
const OPEN_A = "2026-10-15T02:00:00.000Z";
const NEXT_DAY_A = "2026-10-16T02:00:00.000Z";
const CLOSED_A = "2026-10-15T12:00:00.000Z";
const OPEN_HK = "2026-10-15T02:00:00.000Z";

function harness(prices = {}, { actions = {} } = {}) {
  let clock = OPEN_A;
  const quotes = { ...prices };
  const corporate = { ...actions };
  return {
    setNow: (value) => { clock = value; },
    setQuote: (symbol, quote) => { quotes[symbol] = { ...quotes[symbol], ...quote }; },
    setActions: (symbol, list) => { corporate[symbol] = list; },
    async make(root) {
      root ??= await mkdtemp(path.join(os.tmpdir(), "arena-test-"));
      const arena = createArena({
        root,
        quoteCacheMs: 0,
        now: () => clock,
        corporateActionProvider: async (symbol) => corporate[symbol] ?? [],
        quoteProvider: async (symbol) => {
          const entry = quotes[symbol];
          if (!entry) throw new Error(`no quote for ${symbol}`);
          return { symbol, name: entry.name ?? symbol, price: entry.price, asOf: entry.asOf ?? clock, provider: "test", lotSize: entry.lotSize ?? null, limitUp: entry.limitUp ?? null, limitDown: entry.limitDown ?? null, volumeShares: entry.volumeShares ?? null, suspended: entry.suspended };
        },
      });
      return { arena, root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
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

test("agents publish round reports and maintain their own stock pool", async () => {
  const h = harness({ "600519.SS": { price: 1300 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "Autopilot", model: "m", market: "A" }, claude);
    await arena.placeOrder({ accountId: id, symbol: "600519", side: "BUY", quantity: 100, reason }, claude);
    const { report } = await arena.publishReport({ accountId: id, title: "加仓茅台", summary: "动量延续，建仓一成。", sentiment: "bullish", actions: [{ symbol: "600519", action: "buy", detail: "100 股" }], picks: [{ symbol: "600519", thesis: "龙头" }] }, claude);
    assert.equal(report.actions[0].symbol, "600519.SS");
    assert.ok(report.snapshot.equity > 0);
    await assert.rejects(arena.publishReport({ accountId: id, title: "x", summary: "" }, claude), /required/);
    await assert.rejects(arena.publishReport({ accountId: id, title: "t", summary: "s" }, codex), /belongs to agent/);
    const pool = await arena.setWatchlist({ accountId: id, symbols: ["600519", "300750", "300750.SZ"], reason: "动量前列" }, claude);
    assert.deepEqual(pool.watchlist.symbols, ["600519.SS", "300750.SZ"]);
    assert.deepEqual(pool.holdings, ["600519.SS"]);
    await assert.rejects(arena.setWatchlist({ accountId: id, symbols: ["AAPL"] }, claude), /not in this account's A market/);
    const detail = await arena.getAccount(id, { sync: false });
    assert.equal(detail.latestReport.title, "加仓茅台");
    assert.equal(detail.reports.length, 1);
    assert.equal(detail.metrics.reportsPublished, 1);
    assert.equal(detail.watchlist.symbols.length, 2);
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Unattended operation
// ---------------------------------------------------------------------------

const MONDAY_A = "2026-10-19T02:00:00.000Z";
const AFTER_CLOSE_A = "2026-10-15T07:30:00.000Z"; // 15:30 Shanghai, after the A-share close
const noPreferences = async () => ({ language: "en", digestWebhook: null });

test("one matcher leads per arena dir, fills resting orders only during sessions and fails over", async () => {
  const h = harness({ "601318.SS": { price: 60 }, "000300.SS": { price: 4000 } });
  const { arena, root, cleanup } = await h.make();
  const other = (await h.make(root)).arena;
  try {
    const { id } = await arena.createAccount({ name: "Matcher", model: "m", market: "A" }, claude);
    const resting = await arena.placeOrder({ accountId: id, symbol: "601318", side: "BUY", quantity: 1000, orderType: "limit", limitPrice: 58, timeInForce: "gtc", reason }, claude);
    assert.equal(resting.order.status, "open");
    const first = createMatcher({ arena, getPreferences: noPreferences, leaseMs: 300000 });
    const second = createMatcher({ arena: other, getPreferences: noPreferences, leaseMs: 300000 });
    assert.equal((await first.tick()).role, "leader");
    assert.equal((await second.tick()).role, "standby");
    // Price becomes marketable after the close: nothing fills outside the session.
    h.setNow("2026-10-15T08:00:00.000Z");
    h.setQuote("601318.SS", { price: 57.5 });
    await first.tick();
    assert.equal((await arena.getAccount(id, { sync: false })).trades.length, 0);
    // Next session: the leader fills it unattended.
    h.setNow(NEXT_DAY_A);
    const run = await first.tick();
    assert.equal(run.fills, 1);
    assert.equal((await arena.getAccount(id, { sync: false })).positions[0].quantity, 1000);
    const status = await arena.matcherStatus();
    assert.equal(status.state, "running");
    assert.equal(status.ownerId, first.ownerId);
    assert.ok(status.lastRunAt);
    // The leader dies without releasing; once the lease expires the standby takes over.
    h.setNow("2026-10-16T02:06:00.000Z");
    assert.equal((await second.tick()).role, "leader");
    assert.equal((await first.tick()).role, "standby");
    await second.stop();
    assert.equal((await arena.matcherStatus()).state, "stopped");
  } finally { await cleanup(); }
});

test("stop-loss and take-profit execute as market sells, respecting T+1 and limit-down", async () => {
  const h = harness({ "600036.SS": { price: 40 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "Exits", model: "m", market: "A" }, claude);
    const bought = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 1000, stopLossPct: 5, takeProfitPrice: 46, reason }, claude);
    assert.equal(bought.order.status, "filled");
    let detail = await arena.getAccount(id, { sync: false });
    const stop = detail.positions[0].exitLevels.stopLoss;
    assert.ok(stop > 37.9 && stop < 38.1);
    assert.equal(detail.positions[0].exitLevels.takeProfit, 46);
    await assert.rejects(arena.placeOrder({ accountId: id, symbol: "600036", side: "SELL", quantity: 100, stopLossPct: 5, reason }, claude), /attach to BUY/);
    // Same day: the stop is crossed but T+1 locks the shares, so the exit is deferred and logged once.
    h.setQuote("600036.SS", { price: 37 });
    await arena.sync([id], { force: true });
    await arena.sync([id], { force: true });
    detail = await arena.getAccount(id, { sync: false });
    assert.equal(detail.positions[0].quantity, 1000);
    assert.equal(detail.events.filter((event) => event.type === "exit-deferred" && event.why === "t-plus-one").length, 1);
    // Next day at limit-down: still no fill.
    h.setNow(NEXT_DAY_A);
    h.setQuote("600036.SS", { price: 33.3, limitDown: 33.3, limitUp: 40.7 });
    await arena.sync([id], { force: true });
    detail = await arena.getAccount(id, { sync: false });
    assert.equal(detail.positions[0].quantity, 1000);
    assert.ok(detail.events.some((event) => event.why === "limit-down"));
    // Limit opens: the matcher sells everything at market.
    h.setQuote("600036.SS", { price: 34 });
    const { events } = await arena.sync([id], { force: true });
    assert.ok(events.some((event) => event.type === "stop-loss"));
    assert.ok(events.some((event) => event.type === "filled" && event.trigger === "stop-loss"));
    detail = await arena.getAccount(id, { sync: false });
    assert.equal(detail.positions.length, 0);
    assert.equal(detail.trades[0].trigger, "stop-loss");
    // Take-profit set later on a new position through arena_set_exits.
    await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 500, reason }, claude);
    await assert.rejects(arena.setExits({ accountId: id, symbol: "600036", takeProfitPrice: 30 }, claude), /trigger immediately/);
    await assert.rejects(arena.setExits({ accountId: id, symbol: "600036", takeProfitPct: 10 }, codex), /belongs to agent/);
    const set = await arena.setExits({ accountId: id, symbol: "600036", takeProfitPct: 10 }, claude);
    assert.ok(set.levels.takeProfit > 37);
    h.setNow(MONDAY_A);
    h.setQuote("600036.SS", { price: 40, limitDown: null, limitUp: null });
    await arena.sync([id], { force: true });
    detail = await arena.getAccount(id, { sync: false });
    assert.equal(detail.positions.length, 0);
    assert.equal(detail.trades[0].trigger, "take-profit");
  } finally { await cleanup(); }
});

test("dividends, splits and bonus shares adjust held positions once", async () => {
  const h = harness({ "600519.SS": { price: 1300 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "Corporate", model: "m", market: "A" }, claude);
    await arena.placeOrder({ accountId: id, symbol: "600519", side: "BUY", quantity: 200, stopLossPrice: 1200, reason }, claude);
    const resting = await arena.placeOrder({ accountId: id, symbol: "600519", side: "BUY", quantity: 100, orderType: "limit", limitPrice: 1250, timeInForce: "gtc", reason }, claude);
    const before = await arena.getAccount(id, { sync: false });
    h.setActions("600519.SS", [
      { type: "dividend", date: "2026-10-16", cashPerShare: 25.5, currency: "CNY" },
      { type: "split", date: "2026-10-19", ratio: 1.5 },
      { type: "dividend", date: "2026-09-01", cashPerShare: 30 }, // before the account opened: ignored
    ]);
    h.setNow(NEXT_DAY_A);
    await arena.sync([id], { force: true });
    await arena.sync([id], { force: true });
    let detail = await arena.getAccount(id, { sync: false });
    assert.equal(detail.metrics.cash, before.metrics.cash + 5100);
    assert.equal(detail.metrics.dividendIncome, 5100);
    assert.equal(detail.events.filter((event) => event.type === "dividend").length, 1);
    h.setNow(MONDAY_A);
    h.setQuote("600519.SS", { price: 880 });
    await arena.sync([id], { force: true });
    detail = await arena.getAccount(id, { sync: false });
    const position = detail.positions[0];
    assert.equal(position.quantity, 300);
    assert.equal(position.costBasis, before.positions[0].costBasis);
    assert.ok(Math.abs(position.averageCost - before.positions[0].averageCost / 1.5) < 0.01);
    assert.equal(position.exitLevels.stopLoss, 800);
    assert.equal(detail.orders.find((order) => order.id === resting.order.id).status, "cancelled");
    assert.equal(detail.events.filter((event) => event.type === "split").length, 1);
  } finally { await cleanup(); }
});

test("suspended stocks refuse fills and one fill takes at most 5% of the day's volume", async () => {
  const h = harness({ "601318.SS": { price: 60, volumeShares: 0 }, "600036.SS": { price: 40, volumeShares: 10000 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "Liquidity", model: "m", market: "A" }, claude);
    const halted = await arena.placeOrder({ accountId: id, symbol: "601318", side: "BUY", quantity: 100, reason }, claude);
    assert.match(halted.error, /suspended/);
    const waiting = await arena.placeOrder({ accountId: id, symbol: "601318", side: "BUY", quantity: 100, orderType: "limit", limitPrice: 61, reason }, claude);
    assert.equal(waiting.order.status, "open");
    assert.match(waiting.note, /suspended/);
    h.setQuote("601318.SS", { suspended: true, volumeShares: 500 });
    await arena.sync([id], { force: true });
    let detail = await arena.getAccount(id, { sync: false });
    assert.equal(detail.trades.length, 0);
    assert.equal(detail.events.filter((event) => event.type === "suspended").length, 1);
    // 5% of 10,000 shares = 500: a 1,200-share buy fills 500 now and rests the rest.
    const big = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 1200, reason }, claude);
    assert.equal(big.order.status, "open");
    assert.equal(big.trade.quantity, 500);
    assert.equal(big.order.filledQuantity, 500);
    assert.match(big.note, /Partially filled 500 of 1200/);
    h.setQuote("600036.SS", { volumeShares: 18000 });
    await arena.sync([id], { force: true });
    detail = await arena.getAccount(id, { sync: false });
    assert.equal(detail.positions.find((position) => position.symbol === "600036.SS").quantity, 900);
    h.setQuote("600036.SS", { volumeShares: 100000 });
    await arena.sync([id], { force: true });
    detail = await arena.getAccount(id, { sync: false });
    const order = detail.orders.find((entry) => entry.id === big.order.id);
    assert.equal(order.status, "filled");
    assert.equal(order.filledQuantity, 1200);
    assert.equal(detail.trades.filter((trade) => trade.orderId === big.order.id).length, 3);
    assert.equal(detail.metrics.availableCash, detail.metrics.cash - detail.openOrders.reduce((sum, entry) => sum + entry.reserved, 0));
    // The owner can raise the cap from the dashboard.
    await arena.updateAccount(id, { maxVolumePct: 50 });
    assert.equal((await arena.getAccount(id, { sync: false })).settings.maxVolumePct, 50);
  } finally { await cleanup(); }
});

test("owner risk policy caps positions and exposure and trips a drawdown breaker", async () => {
  const h = harness({ "600036.SS": { price: 40 }, "601318.SS": { price: 50 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  try {
    const { id } = await arena.createAccount({ name: "Risk", model: "m", market: "A" }, claude);
    await assert.rejects(arena.updateAccount(id, { riskPolicy: { maxPositionPct: 0 } }), /between/);
    await arena.updateAccount(id, { riskPolicy: { maxPositionPct: 30, maxExposurePct: 50, maxDrawdownPct: 10, onBreach: "reduce", reduceToExposurePct: 20 } });
    const tooBig = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 10000, reason }, claude);
    assert.match(tooBig.error, /single-position limit/);
    assert.equal((await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 7000, reason }, claude)).order.status, "filled");
    const exposure = await arena.placeOrder({ accountId: id, symbol: "601318", side: "BUY", quantity: 5000, reason }, claude);
    assert.match(exposure.error, /total exposure/);
    assert.equal((await arena.placeOrder({ accountId: id, symbol: "601318", side: "BUY", quantity: 4000, reason }, claude)).order.status, "filled");
    const visible = await arena.getAccount(id, { sync: false });
    assert.equal(visible.riskPolicy.maxPositionPct, 30);
    // A 25% slide in both names is a >10% portfolio drawdown: the breaker trips and sells down.
    h.setNow(NEXT_DAY_A);
    h.setQuote("600036.SS", { price: 30 });
    h.setQuote("601318.SS", { price: 37.5 });
    const { events } = await arena.sync([id], { force: true });
    assert.ok(events.some((event) => event.type === "risk-breaker"));
    assert.ok(events.filter((event) => event.type === "filled" && event.trigger === "risk-reduce").length >= 2);
    const detail = await arena.getAccount(id, { sync: false });
    assert.ok(detail.risk.breaker);
    assert.ok(detail.metrics.exposurePct <= 21);
    assert.equal(detail.alerts[0].type, "risk-breaker");
    const blocked = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, reason }, claude);
    assert.match(blocked.error, /circuit breaker/);
    await arena.updateAccount(id, { resetBreaker: true });
    const after = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, reason }, claude);
    assert.equal(after.order.status, "filled");
  } finally { await cleanup(); }
});

test("run health flags accounts that missed a trading day", () => {
  const account = { status: "active", market: "A", createdAt: "2026-10-12T01:00:00.000Z", journal: [], reports: [], orders: [], lastRoundAt: "2026-10-13T06:00:00.000Z" };
  assert.equal(runHealth(account, "2026-10-14T05:00:00.000Z").status, "ok"); // Wednesday before the close
  const missed = runHealth(account, "2026-10-15T08:00:00.000Z"); // Thursday after the close
  assert.equal(missed.status, "missed");
  assert.deepEqual(missed.missedDates, ["2026-10-14", "2026-10-15"]);
  // The weekend is not a trading day; National Day holidays are skipped too.
  assert.equal(runHealth({ ...account, lastRoundAt: "2026-10-16T06:00:00.000Z" }, "2026-10-18T12:00:00.000Z").status, "ok");
  assert.equal(runHealth({ ...account, lastRoundAt: "2026-09-30T06:00:00.000Z" }, "2026-10-08T05:00:00.000Z").missedTradingDays, 0);
  const fresh = { ...account, lastRoundAt: undefined, createdAt: "2026-10-15T01:00:00.000Z" };
  assert.equal(runHealth(fresh, "2026-10-15T05:00:00.000Z").status, "waiting");
  assert.deepEqual(runHealth(fresh, "2026-10-15T08:00:00.000Z").missedDates, ["2026-10-15"]);
  assert.equal(runHealth({ ...fresh, createdAt: "2026-10-15T08:00:00.000Z" }, "2026-10-15T09:00:00.000Z").status, "waiting");
});

test("after each close the leader writes one digest and posts it to the owner's webhook", async () => {
  const h = harness({ "600036.SS": { price: 40 }, "000300.SS": { price: 4000 } });
  const { arena, cleanup } = await h.make();
  const posts = [];
  let fail = true;
  const fetchImpl = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: !fail, status: fail ? 502 : 200 };
  };
  const preferences = async () => ({ language: "zh-CN", digestWebhook: { url: "https://hooks.example.test/digest", format: "generic", enabled: true } });
  try {
    const { id } = await arena.createAccount({ name: "Digest", model: "claude-opus-5-5", market: "A" }, claude);
    const stale = await arena.createAccount({ name: "Quiet", model: "m", market: "A", initialCash: 100000 }, codex);
    await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 1000, reason }, claude);
    await arena.publishReport({ accountId: id, title: "建仓招行", summary: "估值修复，先建一成仓位。" }, claude);
    const matcher = createMatcher({ arena, getPreferences: preferences, fetchImpl });
    assert.equal((await matcher.tick()).digests.length, 0); // Market open: no digest yet.
    h.setNow(AFTER_CLOSE_A);
    const run = await matcher.tick();
    assert.deepEqual(run.digests, ["dig_2026-10-15_A"]);
    assert.equal((await matcher.tick()).digests.length, 0); // Once per close.
    const [digest] = await arena.listDigests();
    assert.equal(digest.accounts.length, 2);
    const row = digest.accounts.find((entry) => entry.id === id);
    assert.equal(row.trades.length, 1);
    assert.equal(row.latestReport.title, "建仓招行");
    const quiet = digest.accounts.find((entry) => entry.id === stale.id);
    assert.ok(quiet.warnings.some((warning) => /没有发布报告/.test(warning)));
    assert.match(digest.text, /非真实收益/);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].body.type, "hrouter.arena.digest");
    assert.equal(posts[0].body.paperTradingOnly, true);
    assert.equal(digest.delivery.status, "failed");
    // A failed delivery is retried on a later tick, at most three attempts in total.
    fail = false;
    h.setNow("2026-10-15T07:45:00.000Z");
    await matcher.tick();
    assert.equal(posts.length, 2);
    assert.equal((await arena.getDigest("dig_2026-10-15_A")).delivery.status, "delivered");
    h.setNow("2026-10-15T08:30:00.000Z");
    await matcher.tick();
    assert.equal(posts.length, 2);
    // Next morning the quiet account is flagged as having missed a trading day.
    h.setNow(NEXT_DAY_A);
    const board = await arena.leaderboard({ sync: false });
    const flagged = board.groups[0].accounts.find((account) => account.id === stale.id);
    assert.equal(flagged.health.status, "missed");
    assert.equal(flagged.alerts[0].type, "missed-run");
  } finally { await cleanup(); }
});

test("digest webhooks support WeChat Work and Feishu bot payloads", async () => {
  const digest = { id: "dig_2026-10-15_A", title: "t", headline: "h", text: "**日报**", at: OPEN_A };
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  assert.equal((await deliverDigest(digest, { url: "https://qyapi.example.test", format: "wecom" }, { fetchImpl })).status, "delivered");
  assert.deepEqual(seen[0], { msgtype: "markdown", markdown: { content: "**日报**" } });
  await deliverDigest(digest, { url: "https://open.feishu.example.test", format: "feishu" }, { fetchImpl });
  assert.deepEqual(seen[1], { msg_type: "text", content: { text: "**日报**" } });
  assert.equal((await deliverDigest(digest, { url: "https://x.test", enabled: false }, { fetchImpl })).status, "skipped");
  const timeout = await deliverDigest(digest, { url: "https://x.test" }, { fetchImpl: () => Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" })) });
  assert.equal(timeout.error, "timeout");
});
