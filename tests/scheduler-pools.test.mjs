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

test("ACP agents get the plugin's MCP server and stream text and tool calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acp-test-"));
  try {
    const arena = createArena({ root, quoteCacheMs: 0, now: () => AT, quoteProvider: async (symbol) => ({ symbol, price: 10, asOf: AT, provider: "test" }) });
    const script = path.join(root, "acp-agent.mjs");
    await writeFile(script, `import readline from "node:readline";
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: 1 } });
  if (m.method === "session/new") { process.stderr.write("mcp:" + m.params.mcpServers[0].name + "\\n"); out({ id: m.id, result: { sessionId: "acp_1" } }); }
  if (m.method === "session/prompt") {
    out({ method: "session/update", params: { sessionId: "acp_1", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "arena_get_account", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] } } });
    out({ method: "session/update", params: { sessionId: "acp_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "复查完毕" } } } });
    out({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
`);
    const account = await arena.createAccount({ name: "G", model: "gemini-3", market: "A" }, { client: "gemini-cli" });
    const scheduler = createScheduler({ arena, now: () => AT, leaseMs: 60000 });
    await scheduler.upsertJob(account.id, { intervalMinutes: 10, times: [], runner: { type: "acp", command: process.execPath, args: [script], timeoutMinutes: 1 } });
    const run = await (await scheduler.runNow(account.id)).wait();
    assert.equal(run.runner, "acp");
    assert.equal(run.status, "no-round", run.error);
    assert.equal(run.sessionId, "acp_1");
    assert.match(run.stderrTail, /mcp:hrouter_market_pulse/);
    const { events } = await scheduler.runEvents(run.id);
    assert.deepEqual(events.filter((event) => ["tool", "tool_result", "text"].includes(event.t)).map((event) => event.t), ["tool", "tool_result", "text"]);
    assert.equal(poolKey({ type: "acp", command: "gemini" }), "acp:gemini");
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("review gate: unchanged slots are skipped, a fill wakes the trader early", async () => {
  const { arena: _unused, root, spawnImpl, cleanup } = await setup();
  let clock = "2026-10-15T01:46:00.000Z"; // 09:46 Shanghai
  const arena = createArena({ root: path.join(root, "gate"), quoteCacheMs: 0, now: () => clock, quoteProvider: async (symbol) => ({ symbol, price: 10, asOf: clock, provider: "test" }) });
  const idle = async (scheduler) => { for (let i = 0; i < 200 && scheduler.status().running.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };
  try {
    const account = await arena.createAccount({ name: "C", model: "gpt", market: "A" }, { client: "codex-gate" });
    const scheduler = createScheduler({ arena, now: () => clock, spawnImpl, leaseMs: 60000 });
    await scheduler.upsertJob(account.id, { intervalMinutes: 10, times: [], runner: { type: "codex", timeoutMinutes: 1 } });
    assert.deepEqual((await scheduler.tick()).started, [account.id], "first review of the day always runs");
    await idle(scheduler);
    const [job] = await scheduler.listJobs();
    assert.equal(job.lastReviewAt, clock);

    clock = "2026-10-15T01:56:00.000Z";
    assert.deepEqual((await scheduler.tick()).started, [], "nothing changed: the agent is not woken");
    assert.equal((await scheduler.listJobs())[0].gateToday.skipped, 1);

    clock = "2026-10-15T01:58:00.000Z";
    await arena.placeOrder({ accountId: account.id, symbol: "600036", side: "BUY", quantity: 100, reason: "Owner test buy for the gate." }, { client: "dashboard" });
    assert.deepEqual((await scheduler.tick()).started, [account.id], "a fill wakes the trader before its next slot");
    await idle(scheduler);
    const woken = (await scheduler.listRuns({ accountId: account.id })).find((run) => run.trigger === "wake");
    assert.match(woken.changes, /新成交 1 笔/);
    assert.equal((await scheduler.listJobs())[0].gateToday.wakes, 1);

    await scheduler.stop();
  } finally { await cleanup(); }
});

test("gate and wake decisions", async () => {
  const { changesSince, gateDecision, wakeDecision, snapshot, sanitizeGate } = await import("../mcp/review-gate.mjs");
  const base = { positions: [{ symbol: "A", name: "甲", quantity: 100, lastPrice: 10 }], openOrders: [], trades: [], events: [], instructions: [], approvals: [] };
  const previous = snapshot(base, "2026-10-15T02:00:00.000Z");
  assert.deepEqual(changesSince(previous, base), []);
  const moved = { ...base, positions: [{ ...base.positions[0], lastPrice: 10.25 }] };
  assert.deepEqual(changesSince(previous, moved).map((change) => [change.text, change.urgent]), [["甲 自上次复查涨 2.5%", false]]);
  const crashed = { ...base, positions: [{ ...base.positions[0], lastPrice: 9.5 }], instructions: [{ id: "ins_1", text: "今天不碰半导体" }] };
  assert.equal(wakeDecision({ previous, account: crashed, at: "2026-10-15T02:10:00.000Z" }), "主人的新指令：今天不碰半导体；甲 自上次复查跌 5%");
  assert.equal(wakeDecision({ previous, account: crashed, at: "2026-10-15T02:03:00.000Z" }), null, "too soon after the last review");
  assert.equal(wakeDecision({ previous, account: crashed, at: "2026-10-15T02:10:00.000Z", wakesToday: 10 }), null, "daily wake cap");
  assert.equal(gateDecision({ previous, account: base, at: "2026-10-15T03:05:00.000Z", sameDay: true }).run, true, "quiet for over an hour");
  assert.equal(gateDecision({ gate: sanitizeGate({ enabled: false }), previous, account: base, at: "2026-10-15T02:10:00.000Z", sameDay: true }).run, true);
});
