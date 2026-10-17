import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArena } from "../mcp/arena.mjs";
import { createScheduler } from "../mcp/scheduler.mjs";
import { prepareStrategyCode } from "../mcp/strategy-sandbox.mjs";
import { backtestCode, createTraderStrategyStore, rollbackTraderStrategy, traderStrategyId, writeTraderStrategy } from "../mcp/trader-strategies.mjs";

const AT = "2026-10-15T01:46:00.000Z"; // 09:46 Shanghai
const agent = { client: "codex-mcp-client" };

// 150 sessions of real-shaped daily bars: one rising stock, one falling, plus the benchmark.
function bars(symbol) {
  const drift = { "600036.SS": 0.004, "601318.SS": -0.003, "000300.SS": 0.001 }[symbol] ?? 0;
  const out = [];
  let price = 40;
  const start = Date.parse("2026-03-02T00:00:00Z");
  for (let day = 0, session = 0; session < 150; day += 1) {
    const date = new Date(start + day * 86400000);
    if ([0, 6].includes(date.getUTCDay())) continue;
    const sessionDate = date.toISOString().slice(0, 10);
    if (sessionDate >= "2026-10-15") break;
    price *= 1 + drift + (session % 5 === 0 ? -0.002 : 0.001);
    out.push({ sessionDate, close: Number(price.toFixed(2)), open: price, high: price, low: price, volume: 1e6, closeAt: `${sessionDate}T07:00:00.000Z`, availableAt: `${sessionDate}T07:00:00.000Z`, complete: true });
    session += 1;
  }
  return out;
}
const historyProvider = async (symbol) => ({ history: bars(symbol) });
const quoteProvider = async (symbol) => ({ symbol, name: symbol, price: bars(symbol).at(-1).close, asOf: AT, provider: "test", signalEligible: true });

const MOMENTUM = `export default {
  id: "my-momentum", name: "动量", version: "1.0.0", markets: ["A"],
  params: { lookback: { type: "integer", default: 20, min: 5, max: 120 }, weight: { type: "number", default: 0.3, min: 0.05, max: 0.5 } },
  async run(ctx) {
    const targets = [];
    for (const symbol of ctx.universe) {
      const history = await ctx.history(symbol, { days: ctx.params.lookback + 1 });
      if (history.length <= ctx.params.lookback) continue;
      const change = history.at(-1).close / history.at(-1 - ctx.params.lookback).close - 1;
      targets.push({ symbol, weight: change > 0 ? ctx.params.weight : 0, reason: "动量 " + (change * 100).toFixed(1) + "%" });
    }
    return { targets, exits: { stopLossPct: 7 } };
  },
};`;

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trader-strategy-test-"));
  const arena = createArena({ root, quoteCacheMs: 0, now: () => AT, quoteProvider });
  const scheduler = createScheduler({ arena, now: () => AT, leaseMs: 60000, strategyDeps: { historyProvider, quoteProvider } });
  const store = createTraderStrategyStore(root, () => AT);
  return { arena, scheduler, store, root, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("static rules reject imports, process access and dynamic code before anything runs", () => {
  assert.throws(() => prepareStrategyCode('import fs from "node:fs"; export default { run() {} }'), /import/);
  assert.throws(() => prepareStrategyCode("export default { run() { return process.env } }"), /process/);
  assert.throws(() => prepareStrategyCode("export default { run() { return fetch('x') } }"), /联网/);
  assert.throws(() => prepareStrategyCode("const a = 1;"), /export default/);
  assert.match(prepareStrategyCode("export default { run() {} }"), /^var __strategy__ =/);
});

test("an agent writes a strategy: it is dry-run, backtested on daily bars, goes live and executes sandboxed", async () => {
  const { arena, scheduler, store, cleanup } = await setup();
  try {
    const account = await arena.createAccount({ name: "Codex", model: "gpt", market: "A" }, agent);
    await arena.setWatchlist({ accountId: account.id, symbols: ["600036", "601318"] }, agent);
    await scheduler.upsertJob(account.id, { intervalMinutes: 10, times: [], mode: "director", runner: { type: "codex", timeoutMinutes: 5 } });
    const written = await writeTraderStrategy({ arena, scheduler, store, accountId: account.id, code: MOMENTUM, changeNote: "第一版动量", intervalMinutes: 2, caller: agent, deps: { historyProvider, quoteProvider } });
    assert.equal(written.status, "live", written.error);
    assert.equal(written.live, 1);
    assert.ok(written.backtest.sessions >= 100);
    assert.ok(written.backtest.totalReturnPct > 0, "the rising stock was held");
    assert.deepEqual(written.dryRun.orders.map((order) => [order.symbol, order.side]), [["600036.SS", "BUY"]]);
    const [job] = await scheduler.listJobs();
    assert.deepEqual([job.mode, job.strategy.strategyId, job.strategy.intervalMinutes], ["director", traderStrategyId(account.id), 2]);
    assert.equal(job.strategy.params.lookback, 20);

    const run = await (await scheduler.runNow(account.id, { lane: "strategy" })).wait();
    assert.equal(run.status, "ok", run.error);
    assert.equal(run.lane, "strategy");
    const after = await arena.getAccount(account.id, { sync: false });
    assert.equal(after.positions[0].symbol, "600036.SS");
    assert.ok(after.positions[0].exitLevels.stopLoss > 0);

    const broken = await writeTraderStrategy({ arena, scheduler, store, accountId: account.id, code: "export default { id: 'x', async run(ctx) { return require('fs') } };", changeNote: "试试 require", caller: agent, deps: { historyProvider, quoteProvider } });
    assert.equal(broken.status, "rejected");
    assert.equal(broken.rejectedAt, "load");
    assert.equal(broken.live, 1);
    const crashing = await writeTraderStrategy({ arena, scheduler, store, accountId: account.id, code: "export default { id: 'x', async run(ctx) { throw new Error('数据不够') } };", changeNote: "会报错", caller: agent, deps: { historyProvider, quoteProvider } });
    assert.equal(crashing.rejectedAt, "dry-run");
    assert.match(crashing.error, /数据不够/);
    const second = await writeTraderStrategy({ arena, scheduler, store, accountId: account.id, code: MOMENTUM, params: { lookback: 10 }, changeNote: "窗口 20→10", caller: agent, deps: { historyProvider, quoteProvider } });
    assert.equal(second.live, 4);
    assert.equal(second.previous.version, 1);
    const back = await rollbackTraderStrategy({ arena, scheduler, store, accountId: account.id, version: 1, caller: agent });
    assert.equal(back.status, "live");
    assert.deepEqual((await store.meta(account.id)).versions.map((entry) => entry.status), ["live", "rejected", "rejected", "retired"]);
    await assert.rejects(writeTraderStrategy({ arena, scheduler, store, accountId: account.id, code: MOMENTUM, changeNote: "别人的账户", caller: { client: "kimi-code" }, deps: { historyProvider, quoteProvider } }), /belongs to agent/);
  } finally { await cleanup(); }
});

test("backtests respect the keep-cash limit and say what they could not test", async () => {
  const code = `export default { id: "all-in", async run(ctx) { await ctx.intraday(ctx.universe[0]); return { targets: ctx.universe.map((symbol) => ({ symbol, weight: 0.6 })) }; } };`;
  const result = await backtestCode({ code, market: "A", universe: ["600036.SS", "601318.SS"], sessions: 60, initialCash: 1000000, minCashPct: 20, historyProvider });
  assert.equal(result.ok, true, result.error);
  assert.ok(result.notes.some((note) => /分钟线/.test(note)));
  assert.ok(result.notes.some((note) => /保留现金/.test(note)));
  assert.equal((await backtestCode({ code, market: "A", universe: [], initialCash: 1000000, historyProvider })).ok, false);
});
