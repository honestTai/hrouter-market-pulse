import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArena } from "../mcp/arena.mjs";
import { computeFees, limitsText, sanitizeFees, sanitizeLimits } from "../mcp/trader-settings.mjs";

// Thursday 2026-10-15 10:00 Asia/Shanghai: A-share continuous session.
const OPEN_A = "2026-10-15T02:00:00.000Z";
const NEXT_DAY_A = "2026-10-16T02:00:00.000Z";
const reason = "Breakout above 20-day high with volume confirmation.";
const agent = { client: "kimi-code" };
const owner = { client: "dashboard" };

async function setup(prices) {
  let clock = OPEN_A;
  const quotes = { "000300.SS": { price: 4000 }, ...prices };
  const root = await mkdtemp(path.join(os.tmpdir(), "settings-test-"));
  const arena = createArena({
    root, quoteCacheMs: 0, now: () => clock,
    quoteProvider: async (symbol) => {
      const entry = quotes[symbol];
      if (!entry) throw new Error(`no quote for ${symbol}`);
      return { symbol, name: entry.name ?? symbol, price: entry.price, changePct: entry.changePct ?? 0, asOf: clock, provider: "test" };
    },
  });
  return { arena, root, setNow: (value) => { clock = value; }, setQuote: (symbol, quote) => { quotes[symbol] = { ...quotes[symbol], ...quote }; }, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("new accounts keep 20% cash and every other limit is off", async () => {
  const { arena, cleanup } = await setup({ "600036.SS": { price: 40 } });
  try {
    const account = await arena.createAccount({ name: "K", model: "k3", market: "A" }, agent);
    assert.equal(account.limits.minCashPct, 20);
    assert.equal(account.limits.maxPositions, null);
    assert.deepEqual(account.limitStatus.active, ["minCashPct"]);
    assert.equal(account.limitStatus.buyableValue, 800000);
    // 21,000 shares × 40 = 840k would leave 16% cash.
    const tooBig = await arena.placeOrder({ accountId: account.id, symbol: "600036", side: "BUY", quantity: 21000, reason }, agent);
    assert.equal(tooBig.order.status, "rejected");
    assert.match(tooBig.error, /保留现金/);
    const ok = await arena.placeOrder({ accountId: account.id, symbol: "600036", side: "BUY", quantity: 19000, reason }, agent);
    assert.equal(ok.order.status, "filled");
  } finally { await cleanup(); }
});

test("holding count, new-per-day, stop requirement, boards and chasing are enforced before orders", async () => {
  const { arena, setQuote, setNow, cleanup } = await setup({ "600036.SS": { price: 40 }, "600900.SS": { price: 28 }, "601088.SS": { price: 39 }, "300750.SZ": { price: 270 }, "688981.SS": { price: 90 } });
  try {
    const { id } = await arena.createAccount({ name: "K", model: "k3", market: "A", limits: { maxPositions: 2, maxNewPerDay: 2 } }, agent);
    for (const symbol of ["600036", "600900"]) assert.equal((await arena.placeOrder({ accountId: id, symbol, side: "BUY", quantity: 1000, reason }, agent)).order.status, "filled");
    const third = await arena.placeOrder({ accountId: id, symbol: "601088", side: "BUY", quantity: 1000, reason }, agent);
    assert.match(third.error, /最多持有几只/);
    assert.equal((await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 1000, reason }, agent)).order.status, "filled", "adding to a holding is allowed");

    await arena.setLimits({ accountId: id, limits: { maxPositions: null, maxRiskPerTradePct: 1, excludeBoards: ["star"], maxChangePct: 7 } }, owner);
    const newToday = await arena.placeOrder({ accountId: id, symbol: "601088", side: "BUY", quantity: 1000, stopLossPct: 5, reason }, agent);
    assert.match(newToday.error, /每天最多新开几只/);
    setNow(NEXT_DAY_A);
    const noStop = await arena.placeOrder({ accountId: id, symbol: "601088", side: "BUY", quantity: 1000, reason }, agent);
    assert.match(noStop.error, /必须带止损/);
    const risky = await arena.placeOrder({ accountId: id, symbol: "300750", side: "BUY", quantity: 2000, stopLossPct: 10, reason }, agent);
    assert.match(risky.error, /单笔最大风险/);
    const star = await arena.placeOrder({ accountId: id, symbol: "688981", side: "BUY", quantity: 200, stopLossPct: 5, reason }, agent);
    assert.match(star.error, /科创板/);
    setQuote("601088.SS", { changePct: 8.2 });
    const chasing = await arena.placeOrder({ accountId: id, symbol: "601088", side: "BUY", quantity: 100, stopLossPct: 5, reason }, agent);
    assert.match(chasing.error, /不追涨/);
    setQuote("601088.SS", { changePct: 1 });
    assert.equal((await arena.placeOrder({ accountId: id, symbol: "601088", side: "BUY", quantity: 100, stopLossPct: 5, reason }, agent)).order.status, "filled");
  } finally { await cleanup(); }
});

test("agents change unlocked limits, locked ones become requests the owner resolves", async () => {
  const { arena, cleanup } = await setup({});
  try {
    const { id } = await arena.createAccount({ name: "K", model: "k3", market: "A" }, agent);
    const changed = await arena.setLimits({ accountId: id, limits: { maxPositions: 8 }, reason: "分散持仓" }, agent);
    assert.deepEqual(changed.applied, [{ key: "maxPositions", from: null, to: 8 }]);
    await assert.rejects(arena.setLocks(id, { minCashPct: true }, agent), /owner/);
    await arena.setLocks(id, { minCashPct: true }, owner);
    const asked = await arena.setLimits({ accountId: id, limits: { minCashPct: 10 }, reason: "估值低位加仓" }, agent);
    assert.equal(asked.applied.length, 0);
    assert.equal(asked.requested[0].to, 10);
    assert.equal(asked.limits.minCashPct, 20);
    const settings = await arena.getSettings(id);
    assert.equal(settings.requests.length, 1);
    const resolved = await arena.resolveRequest(id, asked.requested[0].id, { approve: true, value: 15 }, owner);
    assert.equal(resolved.request.status, "approved");
    assert.equal(resolved.limits.minCashPct, 15);
    const log = (await arena.getAccount(id, { sync: false })).changeLog;
    assert.deepEqual(log.map((entry) => [entry.key, entry.by.kind]), [["minCashPct", "owner"], ["lock:minCashPct", "owner"], ["maxPositions", "agent"]]);
    assert.equal(log[2].by.client, "kimi-code");
    assert.equal(log[2].reason, "分散持仓");
  } finally { await cleanup(); }
});

test("prompts and fee schedules change at any time and apply to the next fill", async () => {
  const { arena, cleanup } = await setup({ "600036.SS": { price: 40 } });
  try {
    const { id } = await arena.createAccount({ name: "K", model: "k3", market: "A" }, agent);
    await arena.setPrompt({ accountId: id, prompt: "只做主板和创业板" }, agent);
    await arena.setWorkbenchPrompt({ scope: "A", prompt: "周五尾盘不新开仓" }, owner);
    const settings = await arena.getSettings(id);
    assert.equal(settings.prompt, "只做主板和创业板");
    assert.equal(settings.prompts.market, "周五尾盘不新开仓");
    await arena.setFees({ market: "A", fees: { waiveMinimum: true, commissionRate: 0.0001 } }, agent);
    const filled = await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, reason }, agent);
    assert.equal(filled.trade.fees, computeFees("A", "BUY", 100, filled.trade.price, { commissionRate: 0.0001, waiveMinimum: true }).total);
    assert.ok(filled.trade.fees < 1);
    await arena.updateWorkbench({ locks: { "fees.A": true } }, owner);
    await assert.rejects(arena.setFees({ market: "A", fees: { commissionRate: 0.0002 } }, agent), /锁定/);
    await assert.rejects(arena.setFees({ market: "A", fees: { stampDutyRate: 0.5 } }, owner), /between/);
  } finally { await cleanup(); }
});

test("accounts from before trader settings get keep-20%-cash once, recorded as a system change", async () => {
  const { arena, root, cleanup } = await setup({});
  try {
    await mkdir(path.join(root, "accounts"), { recursive: true });
    const legacy = {
      id: "acc_0123456789ab", name: "Old", competition: "default", market: "A", currency: "CNY", status: "active",
      agent: { client: "kimi-code" }, model: "k3", strategy: { version: 1, summary: "", history: [] }, initialCash: 1000000, cash: 1000000, realizedPnl: 0,
      settings: {}, riskPolicy: { maxPositionPct: null, maxExposurePct: null, maxDrawdownPct: null, onBreach: "block", reduceToExposurePct: 50 },
      benchmark: { symbol: "000300.SS" }, positions: {}, orders: [], trades: [], journal: [], equity: [], createdAt: OPEN_A, updatedAt: OPEN_A,
    };
    await writeFile(path.join(root, "accounts", `${legacy.id}.json`), JSON.stringify(legacy));
    const account = await arena.getAccount(legacy.id, { sync: false });
    assert.equal(account.limits.minCashPct, 20);
    assert.equal(account.changeLog[0].by.kind, "system");
  } finally { await cleanup(); }
});

test("limit and fee validation, and the limits summary agents read", () => {
  assert.throws(() => sanitizeLimits({ minCashPct: 120 }), /between/);
  assert.throws(() => sanitizeLimits({ maxPositions: 2.5 }), /whole number/);
  assert.throws(() => sanitizeLimits({ excludeBoards: ["moon"] }), /list of/);
  assert.throws(() => sanitizeLimits({ wat: 1 }), /Unknown limit/);
  assert.equal(sanitizeLimits({ maxPositions: "" }, { maxPositions: 5 }).maxPositions, null);
  assert.throws(() => sanitizeFees("A", { perShare: 1 }), /Unknown A fee/);
  assert.match(limitsText({ minCashPct: 20, maxPositions: 6 }, { cashPct: 46, buyableValue: 260000, positionsLeft: 3 }), /保留现金 20%；最多持有几只 6/);
});
