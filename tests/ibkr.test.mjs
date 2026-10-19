import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { IbkrService, LIVE_ACKNOWLEDGEMENT, validateIbkrPolicy } from "../mcp/ibkr.mjs";

function fakeBroker({ cash = 10000, held = 0 } = {}) {
  const calls = [];
  let permId = 1000;
  const bridge = async (request) => {
    calls.push(request);
    if (request.action === "accounts") return { accounts: request.environment === "PAPER" ? [{ accountId: "DU1234567", environment: "PAPER" }] : [{ accountId: "U7654321", environment: "LIVE" }] };
    if (request.action === "snapshot") return { accountId: request.accountId, environment: request.environment, currency: "USD", funds: { cash, netLiquidation: cash }, positions: held ? [{ symbol: "AAPL", secType: "STK", currency: "USD", quantity: held, marketValue: held * 200 }] : [], orders: [] };
    if (request.action === "submit") { if (bridge.fail) throw new Error(bridge.fail); return { orders: [{ orderId: String(++permId), symbol: request.symbol, side: request.side, account: request.accountId, status: "Submitted" }] }; }
    if (request.action === "cancel") return { cancelRequested: true };
    throw new Error(`unexpected ${request.action}`);
  };
  return { bridge, calls, sent: () => calls.filter((c) => c.action === "submit") };
}

async function setup({ broker = fakeBroker(), start = "2026-10-19T15:00:00.000Z" } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "ibkr-"));
  let now = start;
  const quote = async (symbol) => ({ symbol, price: 200, currency: "USD", asOf: now, signalEligible: true, freshness: { status: "fresh" }, crossCheck: { status: "matched" } });
  const service = new IbkrService({ dir, bridge: broker.bridge, quote, now: () => now });
  return { service, broker, dir, advance: (ms) => { now = new Date(Date.parse(now) + ms).toISOString(); }, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

const limits = { allowedSymbols: ["AAPL", "msft"], maxOrderValue: 5000, maxDailyOrderValue: 8000, maxPositionValue: 6000, maxOrdersPerDay: 5, maxQuoteAgeSeconds: 60, maxLimitDeviationPct: 2 };
const paper = { enabled: true, environment: "PAPER", accountId: "DU1234567", ...limits };
const live = { enabled: true, environment: "LIVE", accountId: "U7654321", liveAcknowledgement: LIVE_ACKNOWLEDGEMENT, confirmMinutes: 10, ...limits };
const order = (key, extra = {}) => ({ symbol: "AAPL", side: "BUY", quantity: 10, limitPrice: 200, rationale: "test", idempotencyKey: key, ...extra });

test("ibkr: policy keeps paper and live accounts apart and live needs the typed acknowledgement", () => {
  assert.deepEqual(validateIbkrPolicy(paper).allowedSymbols, ["AAPL", "MSFT"]);
  assert.throws(() => validateIbkrPolicy({ ...paper, accountId: "U7654321" }), /PAPER account/);
  assert.throws(() => validateIbkrPolicy({ ...live, accountId: "DU1234567" }), /LIVE account/);
  assert.throws(() => validateIbkrPolicy({ ...live, liveAcknowledgement: "yes" }), /真实资金/);
  assert.throws(() => validateIbkrPolicy({ ...paper, allowedSymbols: ["0700.HK"] }), /US stock/);
  assert.equal(validateIbkrPolicy(live).requiresConfirmation, true);
  assert.equal(validateIbkrPolicy({ ...paper, accountId: "DU001" }).accountId, "DU001", "IB demo logins use short DU ids");
  assert.throws(() => validateIbkrPolicy({ ...live, accountId: "U001" }), /LIVE account/);
});

test("ibkr: saving a policy checks the account exists in the TWS login", async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.service.savePolicy({ ...paper, accountId: "DU9999999" }), /not a PAPER account/);
    assert.equal((await ctx.service.savePolicy(paper)).accountId, "DU1234567");
  } finally { await ctx.cleanup(); }
});

test("ibkr: paper orders are sent within limits, replays are idempotent and limits block", async () => {
  const ctx = await setup();
  try {
    await ctx.service.savePolicy(paper);
    const first = await ctx.service.submit(order("paper-0001"));
    assert.equal(first.status, "acknowledged");
    assert.equal(ctx.broker.sent().length, 1);
    assert.equal(ctx.broker.sent()[0].orderRef, `hrouter:${first.id}`);
    assert.equal((await ctx.service.submit(order("paper-0001"))).replay, true);
    assert.equal(ctx.broker.sent().length, 1, "a replay never sends twice");
    await assert.rejects(ctx.service.submit(order("paper-0001", { quantity: 11 })), /different request/);
    assert.match((await ctx.service.submit(order("paper-0002", { symbol: "TSLA" }))).error, /allowlist/);
    assert.match((await ctx.service.submit(order("paper-0003", { quantity: 30 }))).error, /Single-order/);
    assert.match((await ctx.service.submit(order("paper-0004", { limitPrice: 210 }))).error, /deviates/);
    assert.match((await ctx.service.submit(order("paper-0005", { side: "SELL" }))).error, /long position/);
    assert.equal(ctx.broker.sent().length, 1);
  } finally { await ctx.cleanup(); }
});

test("ibkr: an unclear outcome blocks new orders until the account is reconciled", async () => {
  const ctx = await setup();
  try {
    await ctx.service.savePolicy(paper);
    ctx.broker.bridge.fail = "socket closed";
    assert.equal((await ctx.service.submit(order("unclear-01"))).status, "unknown");
    ctx.broker.bridge.fail = null;
    assert.match((await ctx.service.submit(order("unclear-02"))).error, /unclear outcome/);
    const stuck = (await ctx.service.status()).intents.find((r) => r.status === "unknown");
    assert.equal((await ctx.service.resolve({ id: stuck.id })).status, "blocked", "owner clears it once IB has no trace of it");
    assert.equal((await ctx.service.submit(order("unclear-03"))).status, "acknowledged");
  } finally { await ctx.cleanup(); }
});

test("ibkr: live orders wait for the owner and are re-checked when confirmed", async () => {
  const ctx = await setup();
  try {
    await ctx.service.savePolicy(live);
    const proposed = await ctx.service.submit(order("live-0001"));
    assert.equal(proposed.status, "awaiting-confirmation");
    assert.equal(ctx.broker.sent().length, 0, "nothing is sent before the owner confirms");
    assert.equal((await ctx.service.status()).pendingConfirmations.length, 1);
    ctx.advance(30_000);
    const confirmed = await ctx.service.confirm({ id: proposed.id });
    assert.equal(confirmed.status, "acknowledged");
    assert.equal(ctx.broker.sent().length, 1);
    assert.equal(ctx.broker.sent()[0].environment, "LIVE");
    assert.equal(confirmed.quote.asOf, "2026-10-19T15:00:30.000Z", "re-checked against a fresh quote");
    await assert.rejects(ctx.service.confirm({ id: proposed.id }), /not waiting/);
  } finally { await ctx.cleanup(); }
});

test("ibkr: rejected and expired live proposals are never sent", async () => {
  const ctx = await setup();
  try {
    await ctx.service.savePolicy(live);
    const a = await ctx.service.submit(order("live-0002"));
    assert.equal((await ctx.service.reject({ id: a.id })).status, "rejected");
    const b = await ctx.service.submit(order("live-0003"));
    ctx.advance(11 * 60_000);
    assert.equal((await ctx.service.confirm({ id: b.id })).status, "expired");
    assert.equal(ctx.broker.sent().length, 0);
  } finally { await ctx.cleanup(); }
});

test("ibkr: halt pauses agents and drops pending live proposals", async () => {
  const ctx = await setup();
  try {
    await ctx.service.savePolicy(live);
    const a = await ctx.service.submit(order("live-0004"));
    const { policy } = await ctx.service.halt();
    assert.equal(policy.enabled, false);
    const state = JSON.parse(await readFile(path.join(ctx.dir, "state.json"), "utf8"));
    assert.equal(state.intents.find((r) => r.id === a.id).status, "rejected");
    assert.match((await ctx.service.submit(order("live-0005"))).error, /paused/);
    assert.equal(ctx.broker.sent().length, 0);
  } finally { await ctx.cleanup(); }
});

test("ibkr: agents cannot confirm, change the policy or halt through MCP", async () => {
  const source = await readFile(new URL("../mcp/server.mjs", import.meta.url), "utf8");
  const tools = [...source.matchAll(/\["(ibkr_[a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tools.sort(), ["ibkr_cancel_order", "ibkr_evaluate_order", "ibkr_get_status", "ibkr_refresh_account", "ibkr_submit_order"]);
});

test("ibkr: Python bridge contracts run against a fake ib_async (no connection)", (t) => {
  const python = process.env.HROUTER_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, ["-B", "tests/ibkr_bridge_test.py"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") { t.skip("Optional Python interpreter absent"); return; }
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
