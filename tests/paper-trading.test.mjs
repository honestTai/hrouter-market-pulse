import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PaperService, validatePaperPolicy, validatePaperOrder, futuCode, paperConfig, invokeFutu } from "../mcp/paper.mjs";
import { startDashboard } from "../mcp/http.mjs";

const rules = { name: "test-only", version: "1", baseScore: 0, minimumScore: 1,
  rules: [{ feature: "price", operator: "gte", value: 1, points: 1 }] };
const POLICY = { enabled: true, environment: "SIMULATE", market: "US", accountId: "123456789012345678",
  allowedSymbols: ["AAPL"], maxOrderValue: 5000, maxDailyOrderValue: 20000, maxPositionValue: 10000,
  maxOrdersPerDay: 10, maxQuoteAgeSeconds: 60, maxLimitDeviationPct: 1, entryStrategy: rules, exitStrategy: rules };
const ORDER = { symbol: "AAPL", side: "BUY", quantity: 10, limitPrice: 100, rationale: "Synthetic unit-test fixture, not a recommendation", idempotencyKey: "test-order-0001" };
const ACCOUNT = { market: "US", accountId: POLICY.accountId };
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "hrouter-paper-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let instant = Date.parse("2026-10-05T14:30:00Z");
  const now = () => new Date(instant).toISOString();
  const calls = [], brokerOrders = [];
  const snap = { ...ACCOUNT, currency: "USD", funds: { cash: 100000, marketValue: 0, totalAssets: 100000 }, positions: [], orders: brokerOrders };
  const quote = { symbol: "AAPL", price: 100, currency: "USD", asOf: now(), source: "Synthetic unit-test fixture",
    signalEligible: true, freshness: { status: "fresh", signalEligible: true }, crossCheck: { status: "matched" }, indicators: {} };
  const bridge = async (request) => {
    calls.push(structuredClone(request));
    if (request.action === "accounts") return { accounts: [{ ...ACCOUNT, environment: "SIMULATE", type: "STOCK" }] };
    if (request.action === "snapshot") return structuredClone(snap);
    if (request.action === "submit") {
      if (options.submitError) throw options.submitError;
      const order = { orderId: String(1000 + brokerOrders.length), code: request.code, side: request.side,
        status: "SUBMITTED", quantity: request.quantity, price: request.limitPrice, filledQuantity: 0, remark: request.remark };
      brokerOrders.push(order); return { orders: [order] };
    }
    if (request.action === "cancel") { if (options.cancelError) throw options.cancelError; return { cancelRequested: true, orders: [] }; }
    throw new Error("Unexpected bridge action");
  };
  const service = new PaperService({ dir, bridge, quote: async () => structuredClone(quote), now, config: { enabled: true, port: 11111 } });
  await service.savePolicy(structuredClone(POLICY));
  return { service, dir, calls, quote, snap, brokerOrders, advance(ms = 4000) { instant += ms; quote.asOf = now(); } };
}

test("paper: disabled by default, loopback-only config and explicit REAL rejection", async () => {
  assert.equal(paperConfig({}).enabled, false);
  assert.equal(paperConfig({ HROUTER_FUTU_HOST: "remote.example" }).host, "127.0.0.1");
  assert.throws(() => paperConfig({ HROUTER_FUTU_PORT: "0" }));
  assert.throws(() => validatePaperPolicy({ ...POLICY, environment: "REAL" }), /REAL/);
  assert.throws(() => validatePaperOrder({ ...ORDER, environment: "REAL" }), /REAL/);
  await assert.rejects(invokeFutu({ action: "submit" }, { enabled: false }), /disabled/);
});
test("paper: explicit limits, allowlist and per-market symbol and lot validation", () => {
  assert.equal(futuCode("0700.HK", "HK"), "HK.00700");
  assert.equal(futuCode("AAPL", "US"), "US.AAPL");
  for (const symbol of ["0700.HK", "600519.SS", "300750.SZ"]) assert.throws(() => futuCode(symbol, "US"));
  for (const key of ["maxOrderValue", "maxDailyOrderValue", "maxPositionValue", "maxOrdersPerDay", "maxQuoteAgeSeconds", "maxLimitDeviationPct"]) {
    for (const invalid of [undefined, 0, -1, Infinity, "100"]) assert.throws(() => validatePaperPolicy({ ...POLICY, [key]: invalid }), key);
  }
  assert.throws(() => validatePaperPolicy({ ...POLICY, allowedSymbols: [] }));
  assert.throws(() => validatePaperPolicy({ ...POLICY, market: "HK", allowedSymbols: ["0700.HK"] }), /lot/);
  assert.throws(() => validatePaperOrder({ ...ORDER, quantity: 1.1 }));
  assert.throws(() => validatePaperOrder({ ...ORDER, idempotencyKey: "../bad-key" }));
  assert.throws(() => validatePaperPolicy({ ...POLICY, entryStrategy: { ...rules, rules: [{ feature: "external.probability", points: 1, value: .9 }] } }));
});
test("paper: no fabricated accounts or performance while bridge is disabled", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "hrouter-paper-disabled-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const s = new PaperService({ dir, config: { enabled: false, port: 11111 }, bridge: () => assert.fail("bridge must not be called") });
  const result = await s.status(); assert.equal(result.bridgeEnabled, false); assert.deepEqual(result.samples, []);
  await assert.rejects(s.accounts("HK"), /disabled/);
});
test("paper: authorization verifies actual simulation account, not an arbitrary ID", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(service.savePolicy({ ...POLICY, accountId: "999" }), /verified/);
  assert.equal((await service.policy()).accountId, POLICY.accountId);
});
test("paper: autonomous submission persists strategy/quote and broker acknowledgement, not a fill", async (t) => {
  const { service, calls } = await fixture(t);
  const result = await service.submit(ORDER);
  assert.equal(result.status, "acknowledged"); assert.equal(result.broker.status, "SUBMITTED");
  assert.equal(result.broker.filledQuantity, 0); assert.equal(result.evaluation.selected, true);
  assert.equal(result.quote.price, 100); assert.deepEqual(result.strategy, rules);
  assert.equal(result.authorization.maxOrderValue, POLICY.maxOrderValue);
  assert.deepEqual(result.events.map((e) => e.type), ["dispatching", "acknowledged"]);
  const writes = calls.filter((r) => r.action === "submit"); assert.equal(writes.length, 1);
  assert.equal(writes[0].accountId, POLICY.accountId); assert.match(writes[0].remark, /^hrouter:/);
  const repeated = await service.submit(ORDER); assert.equal(repeated.replay, true); assert.equal(calls.filter((r) => r.action === "submit").length, 1);
  await assert.rejects(service.submit({ ...ORDER, quantity: 20 }), /Idempotency/);
});
test("paper: stable idempotency survives process restart and disabled policy", async (t) => {
  const { service, dir, calls } = await fixture(t); await service.submit(ORDER);
  await service.savePolicy({ enabled: false, environment: "SIMULATE" });
  const restarted = new PaperService({ dir, config: { enabled: false, port: 11111 }, bridge: () => assert.fail("never replay") });
  assert.equal((await restarted.submit(ORDER)).replay, true);
  assert.equal(calls.filter((r) => r.action === "submit").length, 1);
});
test("paper: paused policy blocks agent, retains authorized limits for inspection", async (t) => {
  const { service, calls } = await fixture(t);
  await service.savePolicy({ enabled: false, environment: "SIMULATE" });
  assert.equal((await service.policy()).maxOrderValue, POLICY.maxOrderValue);
  const result = await service.submit(ORDER); assert.equal(result.status, "blocked"); assert.match(result.error, /paused/);
  assert.equal(calls.filter((r) => r.action === "submit").length, 0);
});
test("paper: quote authenticity, freshness, currency and conflict gates fail closed", async (t) => {
  const f = await fixture(t); const original = structuredClone(f.quote);
  const bad = [{ demo: true }, { synthetic: true }, { signalEligible: false }, { asOf: "bad" }, { asOf: "2026-10-01T00:00:00Z" },
    { asOf: "2026-10-06T14:30:00Z" }, { currency: "HKD" }, { symbol: "MSFT" }, { price: null },
    { crossCheck: { status: "divergent" } }, { freshness: { status: "market-closed", signalEligible: false } }];
  for (let i = 0; i < bad.length; i++) {
    Object.assign(f.quote, original, { demo: false, synthetic: false }, bad[i]);
    const r = await f.service.submit({ ...ORDER, idempotencyKey: `bad-quote-${i}` });
    assert.equal(r.status, "blocked", JSON.stringify(bad[i]));
  }
  assert.equal(f.calls.filter((r) => r.action === "submit").length, 0);
});
test("paper: no entry for failed or incomplete declarative rules", async (t) => {
  const { service } = await fixture(t);
  for (const r of [{ feature: "price", operator: "gt", value: 200, points: 1 }, { feature: "rsi14", operator: "gt", value: 20, points: 1 }]) {
    await service.savePolicy({ ...POLICY, entryStrategy: { ...rules, baseScore: 1, minimumScore: 2, rules: [r] } });
    const result = await service.evaluate(ORDER); assert.equal(result.eligible, false); assert.match(result.reason, /strategy/);
  }
});
test("paper: notional, deviation, allowlist, sellable and cash constraints are enforced", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ quantity: 100 }, { limitPrice: 102 }, { symbol: "MSFT" }, { side: "SELL" }]) {
    assert.equal((await f.service.evaluate({ ...ORDER, ...patch })).eligible, false);
  }
  f.snap.funds.cash = 999;
  assert.match((await f.service.evaluate(ORDER)).reason, /cash/);
  f.snap.funds.cash = 100000;
  f.snap.positions.push({ code: "US.AAPL", quantity: 95, marketValue: 9500, currency: "USD", canSellQuantity: 95 });
  assert.match((await f.service.evaluate(ORDER)).reason, /Position notional/);
  assert.equal((await f.service.evaluate({ ...ORDER, side: "SELL" })).eligible, true);
});
test("paper: pending buy commitments count toward cash and exposure; malformed data is blocked", async (t) => {
  const f = await fixture(t);
  f.snap.orders.push({ orderId: "external", code: "US.AAPL", side: "BUY", status: "SUBMITTED", price: 100, quantity: 95, filledQuantity: 0 });
  assert.match((await f.service.evaluate(ORDER)).reason, /Position notional/);
  f.snap.orders[0].quantity = null;
  assert.match((await f.service.evaluate(ORDER)).reason, /Unverifiable/);
  f.snap.orders.length = 0; f.snap.positions.push({ code: "US.AAPL", quantity: 1, marketValue: 100, currency: "HKD" });
  assert.match((await f.service.evaluate(ORDER)).reason, /currency/);
});
test("paper: daily budgets apply across strategy revisions and cancelled orders", async (t) => {
  const f = await fixture(t);
  await f.service.savePolicy({ ...POLICY, maxOrdersPerDay: 1 });
  await f.service.submit(ORDER); f.advance(); f.brokerOrders[0].status = "CANCELLED_ALL";
  await f.service.savePolicy({ ...POLICY, maxOrdersPerDay: 1, entryStrategy: { ...rules, version: "2" } });
  const r = await f.service.submit({ ...ORDER, idempotencyKey: "second-order-key" });
  assert.equal(r.status, "blocked"); assert.match(r.error, /Daily/);
});
test("paper: uncertain dispatch blocks retries and new orders until broker reconciliation", async (t) => {
  const f = await fixture(t, { submitError: new Error("connection lost after send") });
  const r = await f.service.submit(ORDER); assert.equal(r.status, "unknown"); f.advance();
  assert.equal((await f.service.submit(ORDER)).replay, true);
  assert.match((await f.service.evaluate({ ...ORDER, idempotencyKey: "another-key-00" })).reason, /Unresolved/);
  assert.equal(f.calls.filter((r) => r.action === "submit").length, 1);
  f.brokerOrders.push({ orderId: "late-order", code: "US.AAPL", remark: `hrouter:${r.id}`, status: "FILLED_ALL", quantity: 10, price: 100, filledQuantity: 10, side: "BUY" });
  const refreshed = await f.service.refresh(ACCOUNT);
  assert.equal(refreshed.intents[0].status, "acknowledged"); assert.equal(refreshed.intents[0].brokerOrderId, "late-order");
  assert.equal(refreshed.samples[0].totalAssets, 100000);
});
test("paper: broker TIMEOUT remains uncertain after reconciliation until a known status arrives", async (t) => {
  const f = await fixture(t); await f.service.submit(ORDER); f.advance();
  f.brokerOrders[0].status = "TIMEOUT";
  assert.equal((await f.service.refresh(ACCOUNT)).intents[0].status, "unknown");
  assert.match((await f.service.evaluate({ ...ORDER, idempotencyKey: "fresh-key-00" })).reason, /Unresolved/);
  f.brokerOrders[0].status = "SUBMITTED";
  const refreshed = await f.service.refresh(ACCOUNT);
  assert.equal(refreshed.intents[0].status, "acknowledged");
  assert.equal(refreshed.intents[0].error, null);
  assert.equal(refreshed.intents[0].events.filter((e) => e.type === "broker-observed").length, 2);
});
test("paper: explicit bridge pre-dispatch refusal is blocked, not an uncertain send", async (t) => {
  const e = Object.assign(new Error("cash-only capacity unavailable"), { definitelyNotDispatched: true });
  const f = await fixture(t, { submitError: e }); assert.equal((await f.service.submit(ORDER)).status, "blocked");
});
test("paper: cancellation requires plugin order, stays available when paused, and is idempotent", async (t) => {
  const f = await fixture(t); const r = await f.service.submit(ORDER); f.advance();
  await f.service.savePolicy({ enabled: false, environment: "SIMULATE" });
  await assert.rejects(f.service.cancel({ orderId: "outside-order", idempotencyKey: "cancel-external" }), /plugin/);
  const req = { orderId: r.brokerOrderId, idempotencyKey: "cancel-valid-01" };
  const c = await f.service.cancel(req); assert.equal(c.status, "acknowledged"); assert.match(c.meaning, /not confirmation/);
  assert.equal((await f.service.cancel(req)).replay, true);
  assert.equal((await f.service.cancel({ ...req, idempotencyKey: "new-cancel-key-01" })).replay, true);
  assert.equal(f.calls.filter((r) => r.action === "cancel").length, 1);
});
test("paper: stale operation lock fails closed; no automatic unsafe lock recovery", async (t) => {
  const f = await fixture(t); await mkdir(path.join(f.dir, "operation.lock"));
  await assert.rejects(f.service.submit(ORDER), /interrupted/);
  assert.equal(f.calls.filter((r) => r.action === "submit").length, 0);
});
test("paper: serialized cross-instance operations prevent duplicate side effects", async (t) => {
  const f = await fixture(t);
  const second = new PaperService({ dir: f.dir, config: { enabled: true }, bridge: () => assert.fail("other instance must not dispatch") });
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const checking = new Promise((resolve) => { entered = resolve; });
  f.service.quote = async () => { entered(); await gate; return structuredClone(f.quote); };
  const first = f.service.submit(ORDER); await checking;
  await assert.rejects(second.submit(ORDER), /busy/); release();
  assert.equal((await first).status, "acknowledged");
  assert.equal(f.calls.filter((r) => r.action === "submit").length, 1);
});
test("paper: dashboard keeps the bridge off until enabled and rejects cross-origin writes", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "paper-http-"));
  const previous = process.env.HROUTER_REPORT_DIR;
  process.env.HROUTER_REPORT_DIR = dataDir;
  const server = startDashboard({ port: 0, matcher: false }); await server.ready;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await (await fetch(base + "/api/paper/status")).json();
    assert.equal(status.bridgeEnabled, false);
    const cross = await fetch(`${base}/api/paper/submit`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: JSON.stringify(ORDER) });
    assert.equal(cross.status, 403);
  } finally {
    await new Promise((r) => server.close(r));
    if (previous === undefined) delete process.env.HROUTER_REPORT_DIR; else process.env.HROUTER_REPORT_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
});
test("paper: optional Python bridge contracts run against mocked official SDK (no connection)", (t) => {
  const python = process.env.HROUTER_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, ["-B", "tests/futu_bridge_test.py"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") { t.skip("Optional Python interpreter absent; bridge deployment requires Python tests"); return; }
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
