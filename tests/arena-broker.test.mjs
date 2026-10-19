import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createArena } from "../mcp/arena.mjs";
import { brokerLimitPrice } from "../mcp/ibkr.mjs";

const OPEN_US = "2026-10-19T15:00:00.000Z"; // Monday 11:00 New York
const PRE_US = "2026-10-19T12:00:00.000Z"; // 08:00 New York, before the open
const reason = "Breakout above the 20-day high on rising volume.";
const ibkr = { venue: "ibkr", environment: "PAPER", accountId: "DU010" };

function fakeExecutor() {
  const state = { submitted: [], cancels: [], intents: new Map(), cash: 100000, block: null };
  return {
    state,
    async link() { return { funds: { cash: state.cash, netLiquidation: state.cash }, positions: [], orders: [] }; },
    async submit(execution, order, price) {
      if (state.block) return { state: "blocked", error: state.block };
      const id = `int_${state.submitted.length + 1}`;
      const limitPrice = brokerLimitPrice(order, price);
      state.submitted.push({ id, execution, symbol: order.symbol, side: order.side, quantity: order.quantity - (order.filledQuantity ?? 0), limitPrice, trigger: order.trigger ?? null });
      state.intents.set(id, { id, status: "acknowledged", brokerOrderId: String(900 + state.submitted.length), broker: { status: "Submitted" }, fills: null });
      return { intentId: id, state: "acknowledged", limitPrice, brokerOrderId: String(900 + state.submitted.length) };
    },
    async reconcile() { return { snapshot: { funds: { cash: state.cash, netLiquidation: state.cash }, positions: [] }, intents: [...state.intents.values()] }; },
    async cancel(execution, brokerOrderId) { state.cancels.push(brokerOrderId); return { status: "acknowledged" }; },
    fill(id, executions) { const intent = state.intents.get(id); intent.fills = { quantity: executions.reduce((n, e) => n + e.quantity, 0), executions }; },
    setBrokerStatus(id, status) { state.intents.get(id).broker = { status, messages: [] }; },
  };
}

async function setup({ start = OPEN_US } = {}) {
  let clock = start;
  const prices = { AAPL: 200, "^GSPC": 7600 };
  const executor = fakeExecutor();
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-broker-"));
  const arena = createArena({
    root, quoteCacheMs: 0, now: () => clock, executor, corporateActionProvider: async () => [],
    quoteProvider: async (symbol) => ({ symbol, name: symbol, price: prices[symbol] ?? 100, asOf: clock, provider: "test", lotSize: 1 }),
  });
  const account = await arena.createAccount({ name: "IB 测试", market: "US", model: "test-model" }, { client: "dashboard" });
  return { arena, executor, account, prices, setNow: (at) => { clock = at; }, sync: () => arena.sync([account.id], { force: true }), cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("broker venue: linking takes the IB account's cash and needs a fresh US trader", async () => {
  const ctx = await setup();
  try {
    ctx.executor.state.cash = 98765.43;
    const linked = await ctx.arena.updateAccount(ctx.account.id, { execution: ibkr });
    assert.equal(linked.execution.accountId, "DU010");
    assert.equal(linked.initialCash, 98765.43);
    assert.equal(linked.metrics.equity, 98765.43);
    const a = await ctx.arena.createAccount({ name: "A 股", market: "A", model: "m" }, { client: "dashboard" });
    await assert.rejects(ctx.arena.updateAccount(a.id, { execution: ibkr }), /US traders only/);
  } finally { await ctx.cleanup(); }
});

test("broker venue: orders go to IB and the ledger moves only on IB executions", async () => {
  const ctx = await setup();
  try {
    await ctx.arena.updateAccount(ctx.account.id, { execution: ibkr });
    const placed = await ctx.arena.placeOrder({ accountId: ctx.account.id, symbol: "AAPL", side: "BUY", quantity: 10, reason }, { client: "claude-code" });
    assert.equal(placed.trade, null, "no simulated fill");
    assert.equal(placed.order.status, "open");
    assert.equal(placed.order.broker.state, "acknowledged");
    assert.deepEqual(ctx.executor.state.submitted.map((s) => [s.side, s.quantity, s.limitPrice]), [["BUY", 10, 200.6]], "market order sent as a limit 0.3% through");
    let account = await ctx.arena.getAccount(ctx.account.id, { sync: false });
    assert.equal(account.positions.length, 0);
    ctx.executor.fill("int_1", [{ execId: "e1", quantity: 4, price: 200.1 }]);
    await ctx.sync();
    ctx.executor.fill("int_1", [{ execId: "e1", quantity: 4, price: 200.1 }, { execId: "e2", quantity: 6, price: 200.2 }]);
    await ctx.sync();
    await ctx.sync(); // a repeat never applies an execution twice
    account = await ctx.arena.getAccount(ctx.account.id, { sync: false });
    assert.equal(account.positions[0].quantity, 10);
    const order = account.orders.find((entry) => entry.id === placed.order.id);
    assert.equal(order.status, "filled");
    assert.equal(order.fillPrice, 200.16);
    assert.deepEqual(account.trades.map((t) => [t.quantity, t.price, t.fillBasis]), [[6, 200.2, "ibkr-execution"], [4, 200.1, "ibkr-execution"]]);
  } finally { await ctx.cleanup(); }
});

test("broker venue: IB cancellations and guard-rail blocks close the order", async () => {
  const ctx = await setup();
  try {
    await ctx.arena.updateAccount(ctx.account.id, { execution: ibkr });
    const resting = await ctx.arena.placeOrder({ accountId: ctx.account.id, symbol: "AAPL", side: "BUY", quantity: 5, orderType: "limit", limitPrice: 195, reason }, { client: "claude-code" });
    const cancel = await ctx.arena.cancelOrder({ accountId: ctx.account.id, orderId: resting.order.id }, { client: "claude-code" });
    assert.deepEqual(ctx.executor.state.cancels, ["901"]);
    assert.equal(cancel.order.status, "open", "stays open until IB confirms");
    ctx.executor.setBrokerStatus("int_1", "Cancelled");
    await ctx.sync();
    let account = await ctx.arena.getAccount(ctx.account.id, { sync: false });
    assert.equal(account.orders.find((entry) => entry.id === resting.order.id).status, "cancelled");
    ctx.executor.state.block = "Symbol is outside the owner's allowlist";
    const blocked = await ctx.arena.placeOrder({ accountId: ctx.account.id, symbol: "AAPL", side: "BUY", quantity: 5, reason }, { client: "claude-code" });
    assert.equal(blocked.order.status, "rejected");
    assert.match(blocked.error, /IBKR: Symbol is outside/);
  } finally { await ctx.cleanup(); }
});

test("broker venue: limit orders placed before the open wait and are sent once the session opens", async () => {
  const ctx = await setup({ start: PRE_US });
  try {
    await ctx.arena.updateAccount(ctx.account.id, { execution: ibkr });
    const placed = await ctx.arena.placeOrder({ accountId: ctx.account.id, symbol: "AAPL", side: "BUY", quantity: 5, orderType: "limit", limitPrice: 199, reason }, { client: "claude-code" });
    assert.equal(placed.order.broker.state, "queued");
    assert.equal(ctx.executor.state.submitted.length, 0);
    ctx.setNow(OPEN_US);
    await ctx.sync();
    assert.deepEqual(ctx.executor.state.submitted.map((s) => [s.quantity, s.limitPrice]), [[5, 199]]);
  } finally { await ctx.cleanup(); }
});

test("broker venue: a stop-loss sends a protective sell to IB", async () => {
  const ctx = await setup();
  try {
    await ctx.arena.updateAccount(ctx.account.id, { execution: ibkr });
    await ctx.arena.placeOrder({ accountId: ctx.account.id, symbol: "AAPL", side: "BUY", quantity: 10, reason, stopLossPct: 5 }, { client: "claude-code" });
    ctx.executor.fill("int_1", [{ execId: "e1", quantity: 10, price: 200 }]);
    await ctx.sync();
    ctx.prices.AAPL = 188;
    await ctx.sync();
    const sell = ctx.executor.state.submitted.at(-1);
    assert.deepEqual([sell.side, sell.quantity, sell.trigger, sell.limitPrice], ["SELL", 10, "stop-loss", 187.44]);
  } finally { await ctx.cleanup(); }
});

test("broker limit price: market orders cross the quote by 0.3%, limits keep their price", () => {
  assert.equal(brokerLimitPrice({ type: "market", side: "BUY" }, 100), 100.3);
  assert.equal(brokerLimitPrice({ type: "market", side: "SELL" }, 100), 99.7);
  assert.equal(brokerLimitPrice({ type: "limit", side: "BUY", limitPrice: 98.456 }, 100), 98.46);
});
