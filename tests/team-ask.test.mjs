import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArena } from "../mcp/arena.mjs";
import { createScheduler } from "../mcp/scheduler.mjs";

const AT = "2026-10-15T01:46:00.000Z"; // 09:46 Shanghai, A-share open

// A fake Codex CLI: logs its environment and prompt, reads the account file to prove it can see
// the arena, and answers with a role-specific line.
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "team-ask-"));
  const log = path.join(root, "calls.jsonl");
  const script = path.join(root, "fake.mjs");
  await writeFile(script, `import { appendFileSync } from "node:fs";
const args = process.argv.slice(3);
const prompt = args.at(-1);
const env = args.find((arg) => arg.startsWith("mcp_servers.hrouter_market_pulse.env=")) ?? "";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ prompt, readonly: env.includes("HROUTER_READONLY"), identity: (env.match(/HROUTER_AGENT_ID = "([^"]+)"/) ?? [])[1] }) + "\\n");
const role = (prompt.match(/交易团队里的(\\S+?)。/) ?? [])[1];
const text = role ? role + "：看多，依据是放量突破。" : prompt.includes("主人向你提问") ? "昨天买 600036 是因为放量突破 20 日高点，止损 38.5。" : "复查完毕，保持现状";
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } }));
`);
  const spawnImpl = (command, args, options) => spawn(process.execPath, [script, command, ...args], { ...options, detached: false });
  const arena = createArena({ root, quoteCacheMs: 0, now: () => AT, quoteProvider: async (symbol) => ({ symbol, price: 10, asOf: AT, provider: "test" }) });
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { root, arena, spawnImpl, calls, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test("the owner asks, the trader answers read-only from its records, and the answer is stored", async () => {
  const { arena, spawnImpl, calls, cleanup } = await setup();
  try {
    const account = await arena.createAccount({ name: "C", model: "gpt", market: "A" }, { client: "codex-a" });
    const scheduler = createScheduler({ arena, now: () => AT, spawnImpl, leaseMs: 60000 });
    await scheduler.upsertJob(account.id, { intervalMinutes: 10, times: [], runner: { type: "codex", timeoutMinutes: 1 } });
    await assert.rejects(arena.askTrader(account.id, { text: "为什么买？" }, { client: "codex-a" }), /Only the owner/);
    const question = await arena.askTrader(account.id, { text: "为什么昨天买了招商银行？" }, { client: "dashboard" });
    const run = await (await scheduler.runNow(account.id, { lane: "ask", messageId: question.id })).wait();
    assert.equal(run.lane, "ask");
    assert.equal(run.status, "ok");
    const [call] = await calls();
    assert.equal(call.readonly, true);
    assert.match(call.prompt, /为什么昨天买了招商银行/);
    const after = await arena.getAccount(account.id, { sync: false });
    assert.equal(after.messages.find((message) => message.id === question.id).status, "answered");
    assert.match(after.messages.find((message) => message.replyTo === question.id).text, /放量突破/);
    assert.equal(after.readonly, null, "read-only marker cleared after the answer");
    await scheduler.stop();
  } finally { await cleanup(); }
});

test("a proposed rule waits for the owner, then goes into every round's prompt", async () => {
  const { arena, cleanup } = await setup();
  try {
    const account = await arena.createAccount({ name: "C", model: "gpt", market: "A" }, { client: "codex-a" });
    const scheduler = createScheduler({ arena, now: () => AT, leaseMs: 60000 });
    await scheduler.upsertJob(account.id, { intervalMinutes: 10, times: [], runner: { type: "codex", timeoutMinutes: 1 } });
    const first = await arena.proposeRule(account.id, { rule: "当日涨幅超过 5% 的不追", reason: "主人说以后都这样" }, { client: "codex-a" });
    const second = await arena.proposeRule(account.id, { rule: "周五下午不开新仓", reason: "主人说以后都这样" }, { client: "codex-a" });
    assert.equal((await arena.getSettings(account.id)).requests.filter((request) => request.status === "pending").length, 2, "rule proposals do not supersede each other");
    await arena.resolveRequest(account.id, first.id, { approve: true }, { client: "dashboard" });
    await arena.resolveRequest(account.id, second.id, { approve: false }, { client: "dashboard" });
    const owner = await arena.addRule(account.id, { text: "不碰 ST" }, { client: "dashboard" });
    await assert.rejects(arena.addRule(account.id, { text: "随便买" }, { client: "codex-a" }), /propose/);
    const { prompt } = await scheduler.previewPrompt(account.id);
    assert.match(prompt, /长期规则[\s\S]*当日涨幅超过 5% 的不追[\s\S]*不碰 ST/);
    assert.doesNotMatch(prompt, /周五下午/);
    await arena.revokeRule(account.id, owner.id, { client: "dashboard" });
    assert.doesNotMatch((await scheduler.previewPrompt(account.id)).prompt, /不碰 ST/);
  } finally { await cleanup(); }
});

test("team mode: read-only analysts and a bull / bear debate report before the trader decides", async () => {
  const { arena, spawnImpl, calls, cleanup } = await setup();
  try {
    const account = await arena.createAccount({ name: "C", model: "gpt", market: "A" }, { client: "codex-a" });
    const scheduler = createScheduler({ arena, now: () => AT, spawnImpl, leaseMs: 60000 });
    await assert.rejects(scheduler.upsertJob(account.id, { intervalMinutes: 10, times: [], runner: { type: "kimi", timeoutMinutes: 1 }, team: { roles: ["technical"] } }), /Kimi Code/);
    await scheduler.upsertJob(account.id, { intervalMinutes: 10, times: [], runner: { type: "codex", timeoutMinutes: 1 }, team: { roles: ["technical", "news"], debate: true } });
    const run = await (await scheduler.runNow(account.id)).wait();
    assert.deepEqual(run.team.map((entry) => [entry.role, entry.status]), [["technical", "ok"], ["news", "ok"], ["bull", "ok"], ["bear", "ok"]]);
    const all = await calls();
    const team = all.slice(0, 4);
    assert.ok(team.every((call) => call.readonly && call.identity === "codex-a-team"), "analysts run read-only under their own identity");
    assert.match(team[2].prompt, /技术分析师\] 技术分析师：看多/, "the debate reads the analysts' reports");
    const director = all.at(-1);
    assert.equal(director.readonly, false);
    assert.match(director.prompt, /团队报告[\s\S]*### 技术分析师[\s\S]*### 空头研究员/);
    const runs = await scheduler.listRuns({ accountId: account.id });
    assert.equal(runs.filter((entry) => entry.lane === "team").length, 4);
    await scheduler.stop();
  } finally { await cleanup(); }
});

test("MCP tools refuse trades and settings in read-only runs but allow reading and rule proposals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "readonly-tools-"));
  const previous = { dir: process.env.HROUTER_REPORT_DIR, readonly: process.env.HROUTER_READONLY, id: process.env.HROUTER_AGENT_ID };
  process.env.HROUTER_REPORT_DIR = root;
  process.env.HROUTER_AGENT_ID = "codex-a";
  try {
    const { registerArenaTools } = await import("../mcp/arena-tools.mjs");
    const { getArena } = await import("../mcp/arena.mjs");
    const handlers = new Map();
    const server = { server: { getClientVersion: () => ({ name: "codex" }) }, registerTool: (name, config, handler) => handlers.set(name, handler) };
    registerArenaTools(server, { toolResult: (data, summary) => ({ data, summary }), toolError: (error) => ({ isError: true, message: error.message }) });
    const account = await getArena().createAccount({ name: "C", model: "gpt", market: "A" }, { client: "codex-a" });
    process.env.HROUTER_READONLY = "1";
    const refused = await handlers.get("arena_set_limits")({ accountId: account.id, maxPositions: 3, reason: "test only" });
    assert.equal(refused.isError, true);
    assert.match(refused.message, /read-only/);
    assert.ok(!(await handlers.get("arena_get_settings")({ accountId: account.id })).isError);
    assert.ok(!(await handlers.get("arena_propose_rule")({ accountId: account.id, rule: "不追涨停板", reason: "主人要求" })).isError);
    delete process.env.HROUTER_READONLY;
    await getArena().setReadonly(account.id, { until: new Date(Date.now() + 60000).toISOString(), runId: "run_000000000000", reason: "answering-question" });
    const marked = await handlers.get("arena_set_watchlist")({ accountId: account.id, symbols: ["600036"], reason: "test only" });
    assert.match(marked.message, /answering-question/, "the account marker covers runners without a per-run environment (Kimi)");
  } finally {
    for (const [key, value] of [["HROUTER_REPORT_DIR", previous.dir], ["HROUTER_READONLY", previous.readonly], ["HROUTER_AGENT_ID", previous.id]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
