import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArena } from "../mcp/arena.mjs";
import { classifyFailure, parseLine, resetTime } from "../mcp/agent-runner.mjs";
import { createScheduler, poolKey } from "../mcp/scheduler.mjs";

const AT = "2026-10-15T01:46:00.000Z"; // 09:46 Shanghai, A-share open

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pools-test-"));
  const arena = createArena({ root, quoteCacheMs: 0, now: () => AT, quoteProvider: async (symbol) => ({ symbol, price: 10, asOf: AT, provider: "test" }) });
  // Every CLI is replaced by a fake script whose behaviour depends on which CLI was asked for.
  const script = path.join(root, "fake.mjs");
  await writeFile(script, `const cli = process.argv[2];
if (cli.endsWith("kimi")) { console.error("error: failed to run prompt: provider.auth_error: 403 You've reached your 5-hour usage limit."); process.exit(1); }
if (cli.endsWith("claude")) { console.error('"k3-256k" isn\\'t described by this version\\'s model catalog'); process.exit(1); }
console.log(JSON.stringify({ type: "thread.started", thread_id: "t1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "复查完毕，保持现状" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80 } }));
`);
  const spawnImpl = (command, args, options) => spawn(process.execPath, [script, command], { ...options, detached: false });
  return { arena, root, spawnImpl, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("a quota failure pauses that CLI for every trader and the backup agent takes the round", async () => {
  const { arena, spawnImpl, cleanup } = await setup();
  try {
    const one = await arena.createAccount({ name: "K1", model: "k3", market: "A" }, { client: "kimi-code" });
    const two = await arena.createAccount({ name: "K2", model: "k3", market: "A" }, { client: "kimi-code-2" });
    const scheduler = createScheduler({ arena, now: () => AT, spawnImpl, leaseMs: 60000 });
    await scheduler.upsertJob(one.id, { intervalMinutes: 10, times: [], runner: { type: "kimi", model: "k3", timeoutMinutes: 1 }, backup: { type: "codex" } });
    await scheduler.upsertJob(two.id, { intervalMinutes: 10, times: [], runner: { type: "kimi", model: "k3", timeoutMinutes: 1 } });
    const first = await (await scheduler.runNow(one.id)).wait();
    assert.equal(first.runner, "codex");
    assert.equal(first.backupFor, "kimi quota");
    assert.deepEqual(first.usage, { inputTokens: 1500, outputTokens: 80, costUsd: null });
    const runs = await scheduler.listRuns({ accountId: one.id });
    assert.equal(runs.find((run) => run.runner === "kimi").failure.kind, "quota");
    const pools = await scheduler.listPools();
    assert.equal(pools.find((pool) => pool.key === "kimi").paused, true);
    // The second Kimi trader shares the login: skipped without spawning, no backup configured.
    const second = await (await scheduler.runNow(two.id)).wait();
    assert.equal(second.status, "skipped");
    assert.match(second.error, /额度用尽/);
    // Primary still paused: the next round of the first trader goes straight to the backup.
    const third = await (await scheduler.runNow(one.id)).wait();
    assert.equal(third.runner, "codex");
    const events = await scheduler.runEvents(third.id);
    assert.ok(events.events.some((event) => event.t === "text" && /保持现状/.test(event.text)));
    await scheduler.clearPool("kimi");
    assert.equal((await scheduler.listPools()).find((pool) => pool.key === "kimi").paused, false);
  } finally { await cleanup(); }
});

test("a configuration failure pauses the trader instead of retrying every slot", async () => {
  const { arena, spawnImpl, cleanup } = await setup();
  try {
    const account = await arena.createAccount({ name: "C", model: "k3-256k", market: "A" }, { client: "claude-code" });
    const scheduler = createScheduler({ arena, now: () => AT, spawnImpl, leaseMs: 60000 });
    await scheduler.upsertJob(account.id, { intervalMinutes: 10, times: [], runner: { type: "claude", model: "k3-256k", timeoutMinutes: 1 } });
    const run = await (await scheduler.runNow(account.id)).wait();
    assert.equal(run.failure.kind, "config");
    const [job] = await scheduler.listJobs();
    assert.equal(job.paused.kind, "config");
    assert.equal(job.unhealthy, true);
    assert.deepEqual((await scheduler.tick()).started, [], "paused jobs do not start");
    await scheduler.resumeJob(account.id);
    assert.equal((await scheduler.listJobs())[0].paused, undefined);
    await scheduler.stop();
  } finally { await cleanup(); }
});

test("agent rounds respect the concurrency cap", async () => {
  const { arena, spawnImpl, cleanup } = await setup();
  try {
    await arena.updateWorkbench({ maxConcurrentAgents: 1 }, { client: "dashboard" });
    const ids = [];
    for (const name of ["A1", "A2"]) ids.push((await arena.createAccount({ name, model: "gpt", market: "A" }, { client: `codex-${name}` })).id);
    const slow = (command, args, options) => spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 400)"], { ...options, detached: false });
    const scheduler = createScheduler({ arena, now: () => AT, spawnImpl: slow, leaseMs: 60000 });
    for (const id of ids) await scheduler.upsertJob(id, { intervalMinutes: 10, times: [], runner: { type: "codex", timeoutMinutes: 1 } });
    const tick = await scheduler.tick();
    assert.equal(tick.started.length, 1);
    assert.equal(tick.waiting.length, 1);
    await scheduler.stop();
  } finally { await cleanup(); }
});

test("stream parsers turn CLI output into text, tool and usage events", () => {
  const state = { text: [], usage: null, sessionId: null };
  parseLine("claude", JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }), state);
  const tool = parseLine("claude", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "看一下持仓" }, { type: "tool_use", id: "t1", name: "mcp__hrouter_market_pulse__arena_get_account", input: { accountId: "acc_x" } }] } }), state);
  assert.deepEqual(tool.map((event) => event.t), ["text", "tool"]);
  parseLine("claude", JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "done", total_cost_usd: 0.12, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }), state);
  assert.deepEqual(state.usage, { inputTokens: 100, outputTokens: 5, costUsd: 0.12 });
  assert.equal(state.sessionId, "s1");
  const kimi = { text: [], usage: null };
  assert.equal(parseLine("kimi", JSON.stringify({ role: "assistant", content: "ok" }), kimi)[0].text, "ok");
  parseLine("kimi", JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_1" }), kimi);
  assert.equal(kimi.sessionId, "session_1");
});

test("failures are classified from what the CLIs actually print", () => {
  const kimi = classifyFailure({ exitCode: 1, stderr: "error: failed to run prompt: provider.auth_error: 403 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends." }, AT);
  assert.equal(kimi.kind, "quota");
  assert.ok(Date.parse(kimi.resetAt) > Date.parse(AT));
  assert.equal(classifyFailure({ exitCode: 1, stderr: '"k3-256k" isn\'t described by this version\'s model catalog; update Claude Code' }).kind, "config");
  assert.equal(classifyFailure({ exitCode: 1, stderr: "error: Cannot combine --prompt with --auto." }).kind, "config");
  assert.equal(classifyFailure({ exitCode: 1, stderr: "Not logged in · Please run /login" }).kind, "auth");
  assert.equal(classifyFailure({ exitCode: null, error: "Command not found: kimi" }).kind, "missing");
  assert.equal(classifyFailure({ timedOut: true }).kind, "timeout");
  assert.equal(resetTime("Claude AI usage limit reached|1760600000", AT), new Date(1760600000 * 1000).toISOString());
  assert.equal(resetTime("try again in 2 hours", AT), new Date(Date.parse(AT) + 2 * 3600000).toISOString());
  assert.equal(poolKey({ type: "kimi" }), "kimi");
});
