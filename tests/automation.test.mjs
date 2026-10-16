import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArena } from "../mcp/arena.mjs";
import { createAdvisoryBroker, createPaperBroker, normalizeIntent } from "../mcp/brokers.mjs";
import { agentInvocation, createScheduler, dueSlots, inferRunner, sanitizeJob } from "../mcp/scheduler.mjs";
import { ordersFromTargets, resolveParams, runStrategyRound } from "../mcp/strategies/index.mjs";
import maTrend from "../mcp/strategies/ma-trend.mjs";
import momentum from "../mcp/strategies/momentum-rotation.mjs";

// Thursday 2026-10-15, 10:00 Asia/Shanghai (A-share session open).
const OPEN_A = "2026-10-15T02:00:00.000Z";
const prices = { "600519.SS": 1300, "300750.SZ": 260, "601318.SS": 58, "000300.SS": 4000 };

async function setup(clock = { value: OPEN_A }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "automation-"));
  const arena = createArena({
    root, now: () => clock.value, quoteCacheMs: 0,
    quoteProvider: async (symbol) => ({ symbol, name: symbol, price: prices[symbol], asOf: clock.value, provider: "test", volumeShares: 1e9 }),
  });
  return { root, arena, clock, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

// Rising closes for the first two symbols, falling for the third: completed bars only.
function history(symbol) {
  const slope = symbol === "601318.SS" ? -0.4 : symbol === "300750.SZ" ? 0.6 : 0.3;
  const bars = Array.from({ length: 120 }, (_, index) => ({
    close: 100 + slope * index, complete: true, availableAt: new Date(Date.parse("2026-05-01T07:00:00Z") + index * 86400000).toISOString(),
  }));
  bars.push({ close: 1, complete: false, availableAt: "2026-10-15T07:00:00Z" });
  return { history: bars };
}

test("job validation and slots only fire on trading days, once, inside the catch-up window", () => {
  assert.throws(() => sanitizeJob({ times: ["25:00"], runner: { type: "claude" } }), /Invalid time/);
  assert.throws(() => sanitizeJob({ times: ["09:45"], runner: { type: "command", command: "x", args: [] } }), /\{prompt\}/);
  const job = sanitizeJob({ times: ["14:30", "09:45", "09:45"], runner: { type: "strategy", strategyId: "ma-trend" } });
  assert.deepEqual(job.times, ["09:45", "14:30"]);
  assert.deepEqual(dueSlots(job, "A", OPEN_A, []).map((slot) => slot.key), ["2026-10-15T09:45"]);
  assert.deepEqual(dueSlots(job, "A", OPEN_A, ["2026-10-15T09:45"]), []);
  assert.deepEqual(dueSlots(job, "A", "2026-10-17T02:00:00Z", []), [], "Saturday");
  assert.deepEqual(dueSlots(job, "A", "2026-10-15T05:00:00Z", []), [], "13:00 is too late for 09:45 and too early for 14:30");
});

test("repeat mode fires once per interval inside regular sessions, never at lunch, with agent minimums", () => {
  const strategy = sanitizeJob({ intervalMinutes: 5, runner: { type: "strategy", strategyId: "ma-trend" } });
  assert.deepEqual(strategy.times, []);
  assert.throws(() => sanitizeJob({ intervalMinutes: 5, runner: { type: "kimi" } }), /at least 10 minutes/);
  assert.throws(() => sanitizeJob({ runner: { type: "kimi" } }), /run time or a repeat interval/);
  const at = (local) => new Date(Date.parse(`2026-10-15T${local}:00+08:00`)).toISOString();
  assert.deepEqual(dueSlots(strategy, "A", at("09:37"), []).map((slot) => slot.key), ["2026-10-15T09:35"]);
  assert.deepEqual(dueSlots(strategy, "A", at("09:37"), ["2026-10-15T09:35"]), []);
  assert.deepEqual(dueSlots(strategy, "A", at("12:10"), []), [], "lunch break");
  assert.deepEqual(dueSlots(strategy, "A", at("13:02"), []).map((slot) => slot.key), ["2026-10-15T13:00"]);
  assert.deepEqual(dueSlots(strategy, "A", at("15:20"), []), [], "after close");
  const agent = sanitizeJob({ intervalMinutes: 30, times: ["09:45"], runner: { type: "codex" } });
  assert.deepEqual(dueSlots(agent, "A", at("10:05"), ["2026-10-15T09:45"]).map((slot) => slot.key), ["2026-10-15T10:00"]);
});

test("new agent accounts get the default 30-minute schedule with the right CLI; strategies and opt-out do not", async () => {
  const { arena, cleanup } = await setup();
  try {
    assert.deepEqual(inferRunner({ agent: { client: "kimi-code" }, model: "k3-256k" }), { type: "kimi", model: "k3-256k" });
    assert.deepEqual(inferRunner({ agent: { client: "codex-mcp-client" }, model: "gpt-6-astra" }), { type: "codex", model: "gpt-6-astra" });
    assert.equal(inferRunner({ agent: { label: "Quant strategy" }, model: "strategy:ma-trend" }), null);
    const scheduler = createScheduler({ arena });
    const kimi = await arena.createAccount({ name: "Kimi", model: "k3-256k", market: "A" }, { client: "kimi-code" });
    const created = await scheduler.ensureDefaultSchedule(kimi.id, 30);
    assert.equal(created.created, true);
    assert.deepEqual([created.job.intervalMinutes, created.job.times, created.job.runner.type, created.job.runner.model], [30, [], "kimi", "k3-256k"]);
    assert.equal((await scheduler.ensureDefaultSchedule(kimi.id, 30)).reason, "already scheduled");
    const quant = await arena.createAccount({ name: "Q", model: "strategy:ma-trend", market: "A", agentLabel: "Quant strategy" }, { client: "dashboard" });
    assert.equal((await scheduler.ensureDefaultSchedule(quant.id, 30)).created, false);
    const off = await arena.createAccount({ name: "Off", model: "gpt", market: "A" }, { client: "codex-mcp-client" });
    assert.equal((await scheduler.ensureDefaultSchedule(off.id, 0)).created, false);
  } finally { await cleanup(); }
});

test("agent invocations attach only this plugin, pin the data dir and pre-approve only its tools", () => {
  const job = { runner: { type: "codex", model: "gpt-5.5-codex", timeoutMinutes: 5 } };
  const codex = agentInvocation({ job, account: { id: "acc_000000000001" }, prompt: "go", nodePath: "/n", bundlePath: "/b.mjs", skillText: null, workDir: "/w", identity: "codex-x", dataDir: "/data" });
  assert.ok(codex.args.includes('mcp_servers.hrouter_market_pulse.default_tools_approval_mode="approve"'));
  assert.ok(codex.args.some((arg) => arg.includes('HROUTER_REPORT_DIR = "/data"')));
  assert.ok(codex.args.includes("read-only"));
  const claude = agentInvocation({ job: { runner: { type: "claude", maxBudgetUsd: 1, timeoutMinutes: 5 } }, account: { id: "acc_000000000001" }, prompt: "go", nodePath: "/n", bundlePath: "/b.mjs", skillText: "skill", workDir: "/w", identity: "claude-x", dataDir: "/data" });
  const mcp = JSON.parse(claude.args[claude.args.indexOf("--mcp-config") + 1]);
  assert.equal(mcp.mcpServers.hrouter_market_pulse.env.HROUTER_REPORT_DIR, "/data");
  assert.ok(claude.args.includes("--strict-mcp-config"));
  assert.equal(claude.args[claude.args.indexOf("--allowedTools") + 1], "mcp__hrouter_market_pulse");
  const workbuddy = agentInvocation({ job: { runner: { type: "workbuddy", model: "primary-model", maxBudgetUsd: 1, timeoutMinutes: 5 } }, account: { id: "acc_000000000001" }, prompt: "go", nodePath: "/n", bundlePath: "/b.mjs", skillText: null, workDir: "/w", identity: "workbuddy-x", dataDir: "/data" });
  assert.match(workbuddy.command, /codebuddy/);
  assert.ok(workbuddy.args.includes("--strict-mcp-config") && !workbuddy.args.includes("--max-budget-usd"));
  assert.equal(workbuddy.env.CODEBUDDY_FORCE_HEADLESS_BUNDLE, "1");
  const kimi = agentInvocation({ job: { runner: { type: "kimi", model: "k3-256k", timeoutMinutes: 5 } }, account: { id: "acc_000000000001" }, prompt: "go", nodePath: "/n", bundlePath: "/b.mjs", skillText: null, workDir: "/w", identity: "kimi-code", dataDir: "/data" });
  assert.match(kimi.command, /kimi$/);
  assert.deepEqual(kimi.args.slice(2), ["--output-format", "text", "-m", "kimi-code/k3-256k"]);
  assert.equal(kimi.env.HROUTER_AGENT_ID, "kimi-code");
  assert.match(workbuddy.env.WORKBUDDY_CONFIG_DIR, /\.workbuddy$/);
});

test("target weights become lot-sized orders, sells before buys", () => {
  const account = { market: "A", metrics: { equity: 1000000 }, positions: [{ symbol: "601318.SS", quantity: 1000 }], lotOverrides: {} };
  const quotes = new Map(Object.entries(prices).map(([symbol, price]) => [symbol, { price }]));
  const orders = ordersFromTargets(account, [{ symbol: "600519.SS", weight: 0.45 }, { symbol: "300750.SZ", weight: 0.45 }], quotes);
  assert.deepEqual(orders.map((order) => [order.side, order.symbol, order.quantity]), [["SELL", "601318.SS", 1000], ["BUY", "600519.SS", 300], ["BUY", "300750.SZ", 1700]]);
  assert.throws(() => resolveParams(maTrend, { fast: 1 }), /≥ 3/);
});

test("strategy rounds trade through the paper broker, never see unfinished bars, and report", async () => {
  const { arena, cleanup } = await setup();
  try {
    const account = await arena.createAccount({ name: "MA", model: "strategy:ma-trend", market: "A" }, { client: "dashboard" });
    const broker = createPaperBroker({ arena, accountId: account.id, caller: { client: "strategy-ma-trend" } });
    let sawUnfinished = false;
    const round = await runStrategyRound({
      strategy: { ...maTrend, run: async (ctx) => { const bars = await ctx.history("600519.SS"); sawUnfinished = bars.some((bar) => bar.complete === false); return maTrend.run(ctx); } },
      params: { universe: ["600519.SS", "300750.SZ", "601318.SS"], maxPositions: 2 }, broker, runId: "run_test01",
      now: () => OPEN_A, historyProvider: async (symbol) => history(symbol), quoteProvider: async (symbol) => ({ price: prices[symbol] }),
    });
    assert.equal(sawUnfinished, false);
    assert.deepEqual(round.orders.map((order) => [order.symbol, order.status]), [["300750.SZ", "filled"], ["600519.SS", "filled"]]);
    const detail = await arena.getAccount(account.id, { sync: false });
    assert.equal(detail.agent.client, "strategy-ma-trend");
    assert.ok(detail.positions.every((position) => position.exitLevels?.stopLoss > 0), "stop-loss attached from strategy exits");
    assert.match(detail.reports[0].title, /调仓 2 笔/);
    // Re-running the same run id is idempotent: no duplicate orders.
    await runStrategyRound({ strategy: maTrend, params: { universe: ["600519.SS", "300750.SZ"], maxPositions: 2 }, broker, runId: "run_test01", now: () => OPEN_A, historyProvider: async (symbol) => history(symbol), quoteProvider: async (symbol) => ({ price: prices[symbol] }) });
    const afterRepeat = await arena.getAccount(account.id, { sync: false });
    assert.equal(afterRepeat.trades.length, 2);
    assert.equal(afterRepeat.reports.length, 1, "a no-change repeat round does not publish another report the same day");
    assert.ok(Date.parse(afterRepeat.lastRoundAt) >= Date.parse(detail.reports[0].at), "but it still counts as a round");
    const flat = await runStrategyRound({ strategy: momentum, params: { universe: ["601318.SS"] }, broker: createPaperBroker({ arena, accountId: (await arena.createAccount({ name: "M", model: "s", market: "A" }, { client: "dashboard" })).id, caller: { client: "strategy-momentum-rotation" } }), now: () => OPEN_A, historyProvider: async (symbol) => history(symbol), quoteProvider: async (symbol) => ({ price: prices[symbol] }) });
    assert.equal(flat.orders.length, 0, "falling stock has negative momentum");
  } finally { await cleanup(); }
});

test("scheduler runs agent CLIs on time, logs output, prevents double runs and elects one leader", async () => {
  const clock = { value: "2026-10-15T01:46:00.000Z" }; // 09:46 Shanghai
  const { arena, root, cleanup } = await setup(clock);
  try {
    const account = await arena.createAccount({ name: "Agent", model: "m", market: "A" }, { client: "dashboard" });
    const script = path.join(root, "fake-agent.mjs");
    await writeFile(script, `const [,, mode, prompt] = process.argv; console.log("agent saw:", prompt.slice(0, 20)); if (mode === "slow") await new Promise((r) => setTimeout(r, 60000)); process.exit(mode === "fail" ? 3 : 0);\n`);
    await chmod(script, 0o755);
    const scheduler = createScheduler({ arena, now: () => clock.value, leaseMs: 60000 });
    await scheduler.upsertJob(account.id, { times: ["09:45"], runner: { type: "command", command: process.execPath, args: [script, "ok", "{prompt}"], timeoutMinutes: 1 } });
    const tick = await scheduler.tick();
    assert.deepEqual(tick.started, [account.id]);
    assert.deepEqual((await scheduler.tick()).started, [], "same slot never runs twice");
    for (let wait = 0; wait < 50 && !(await scheduler.listRuns({ accountId: account.id })).length; wait += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const [run] = await scheduler.listRuns({ accountId: account.id });
    assert.equal(run.status, "no-round", "exit 0 but the agent never logged a round");
    assert.match(run.stdoutTail, /agent saw: 使用 hrouter-agent/);
    assert.equal(run.slot, "2026-10-15T09:45");
    await scheduler.upsertJob(account.id, { times: ["09:45"], runner: { type: "command", command: process.execPath, args: [script, "fail", "{prompt}"], timeoutMinutes: 1 } });
    const failed = await (await scheduler.runNow(account.id)).wait();
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 3);
    const jobs = await scheduler.listJobs();
    assert.equal(jobs[0].consecutiveFailures, 2);
    const state = JSON.parse(await readFile(path.join(root, "schedules.json"), "utf8"));
    assert.deepEqual(state.done[account.id], ["2026-10-15T09:45"]);
    const second = createScheduler({ arena, now: () => clock.value, leaseMs: 60000 });
    assert.equal((await second.tick()).role, "standby", "one scheduler leader per arena dir");
    await scheduler.stop();
  } finally { await cleanup(); }
});

test("strategy jobs run in-process through the scheduler", async () => {
  const clock = { value: "2026-10-15T01:46:00.000Z" };
  const { arena, cleanup } = await setup(clock);
  try {
    const account = await arena.createAccount({ name: "Quant", model: "strategy:ma-trend", market: "A" }, { client: "dashboard" });
    const scheduler = createScheduler({ arena, now: () => clock.value, strategyDeps: { historyProvider: async (symbol) => history(symbol), quoteProvider: async (symbol) => ({ price: prices[symbol] }) } });
    await assert.rejects(scheduler.upsertJob(account.id, { times: ["09:45"], runner: { type: "strategy", strategyId: "nope" } }), /Unknown strategy/);
    await scheduler.upsertJob(account.id, { times: ["09:45"], runner: { type: "strategy", strategyId: "ma-trend", params: { universe: ["600519.SS", "300750.SZ"] } } });
    const result = await (await scheduler.runNow(account.id)).wait();
    assert.equal(result.status, "ok");
    assert.equal(result.orders.filter((order) => order.status === "filled").length, 2);
    await scheduler.stop();
  } finally { await cleanup(); }
});

test("advisory broker only records proposals for human confirmation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "advisory-"));
  try {
    const broker = createAdvisoryBroker({ root, source: { strategy: "ma-trend" } });
    const result = await broker.placeOrder({ symbol: "AAPL", side: "BUY", quantity: 10, reason: "test" });
    assert.equal(result.executed, false);
    assert.equal(result.proposal.status, "pending-confirmation");
    assert.equal((await broker.listProposals({ status: "pending-confirmation" })).length, 1);
    await assert.rejects(broker.cancelOrder("x"), /confirmed or rejected by the owner/);
    assert.throws(() => normalizeIntent({ symbol: "AAPL", side: "SHORT", quantity: 1 }), /BUY or SELL/);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
