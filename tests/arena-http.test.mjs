import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "arena-http-"));
process.env.HROUTER_REPORT_DIR = dataDir;
const { startDashboard } = await import("../mcp/http.mjs");

async function withServer(options, run) {
  const server = startDashboard({ port: 0, ...options });
  await server.ready;
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body) => {
    const response = await fetch(base + route, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  try { await run(call); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test.after(() => rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

test("demo dashboard serves a labelled synthetic arena without touching real data", async () => {
  await withServer({ demo: true }, async (call) => {
    const board = await call("/api/arena/leaderboard");
    assert.equal(board.status, 200);
    assert.equal(board.body.demo, true);
    const china = board.body.groups.find((group) => group.market === "A");
    assert.equal(china.accounts.length, 4);
    assert.ok(china.accounts.every((account) => account.demo && account.curve.length > 10));
    assert.deepEqual(china.accounts.map((account) => account.rank), [1, 2, 3, 4]);
    const detail = await call(`/api/arena/accounts/${china.accounts[0].id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.trades.length > 0);
    assert.ok(detail.body.journal.length > 0);
  });
});

test("real dashboard creates, lists, edits, archives and deletes accounts", async () => {
  await withServer({}, async (call) => {
    const created = await call("/api/arena/accounts", { name: "Sonnet swing", model: "claude-sonnet-5-5", market: "US", agentLabel: "Claude Code", strategySummary: "Swing trades on mega caps." });
    assert.equal(created.status, 201);
    assert.equal(created.body.agent.client, null);
    assert.equal(created.body.initialCash, 100000);
    const id = created.body.id;
    const board = await call("/api/arena/leaderboard");
    assert.equal(board.body.demo, false);
    assert.equal(board.body.groups[0].accounts[0].id, id);
    const renamed = await call(`/api/arena/accounts/${id}`, { name: "Sonnet swing v2" });
    assert.equal(renamed.body.name, "Sonnet swing v2");
    assert.equal((await call(`/api/arena/accounts/${id}/delete`, {})).status, 409);
    assert.equal((await call(`/api/arena/accounts/${id}`, { status: "archived" })).body.status, "archived");
    assert.equal((await call("/api/arena/leaderboard")).body.groups.length, 0);
    assert.equal((await call("/api/arena/leaderboard?archived=1")).body.groups[0].accounts.length, 1);
    assert.equal((await call(`/api/arena/accounts/${id}/delete`, {})).body.deleted, id);
    assert.equal((await call(`/api/arena/accounts/${id}`)).status, 404);
    const managed = await call("/api/preferences", { managedAccountId: id });
    assert.equal(managed.body.managedAccountId, id);
    assert.equal((await call("/api/preferences", { managedAccountId: "nope" })).status, 400);
    assert.equal((await call("/api/preferences", { managedAccountId: null })).body.managedAccountId, null);
    assert.equal(created.body.schedule?.intervalMinutes, 15, "agentLabel Claude Code → claude runner gets the default schedule");
    assert.equal((await call("/api/preferences", { defaultAgentIntervalMinutes: 3 })).status, 400);
    assert.equal((await call("/api/preferences", { defaultAgentIntervalMinutes: 0 })).body.defaultAgentIntervalMinutes, 0);
    const invalid = await call("/api/arena/accounts", { name: "x", model: "", market: "US" });
    assert.equal(invalid.status, 400);
  });
});

test("dashboard exposes matcher status, owner-only risk policy, digests and the digest webhook", async () => {
  await withServer({}, async (call) => {
    const matcher = await call("/api/arena/matcher");
    assert.equal(matcher.status, 200);
    assert.ok(["running", "stopped", "stale"].includes(matcher.body.state));
    assert.ok("local" in matcher.body);
    const created = await call("/api/arena/accounts", { name: "Policy", model: "claude-opus-5-5", market: "US" });
    const id = created.body.id;
    assert.equal(created.body.riskPolicy.maxPositionPct, null);
    const policy = await call(`/api/arena/accounts/${id}`, { riskPolicy: { maxPositionPct: 25, maxDrawdownPct: 12, onBreach: "block" }, maxVolumePct: 2 });
    assert.equal(policy.status, 200);
    assert.equal(policy.body.riskPolicy.maxPositionPct, 25);
    assert.equal(policy.body.settings.maxVolumePct, 2);
    assert.equal((await call(`/api/arena/accounts/${id}`, { riskPolicy: { onBreach: "yolo" } })).status, 400);
    assert.equal((await call(`/api/arena/accounts/${id}`)).body.health.status, "waiting");
    const board = await call("/api/arena/leaderboard");
    assert.ok(board.body.matcher);
    assert.ok(board.body.groups[0].accounts[0].health);
    const digest = await call("/api/arena/digests", {});
    assert.equal(digest.status, 201);
    assert.equal(digest.body.accounts.length, 1);
    assert.equal((await call("/api/arena/digests", { send: true })).status, 409);
    const listed = await call("/api/arena/digests");
    assert.equal(listed.body.digests[0].id, digest.body.id);
    assert.equal(listed.body.webhook, null);
    assert.equal((await call("/api/preferences", { digestWebhook: { url: "ftp://nope" } })).status, 400);
    assert.equal((await call("/api/preferences", { digestWebhook: { url: "https://hooks.example.test/x", format: "pager" } })).status, 400);
    const saved = await call("/api/preferences", { digestWebhook: { url: "https://hooks.example.test/x", format: "wecom" } });
    assert.deepEqual(saved.body.digestWebhook, { url: "https://hooks.example.test/x", format: "wecom", enabled: true });
    assert.deepEqual((await call("/api/arena/digests")).body.webhook, { format: "wecom", enabled: true, host: "hooks.example.test" });
    assert.equal((await call("/api/preferences", { digestWebhook: null })).body.digestWebhook, null);
  });
});

test("demo dashboard shows run health, risk policy and a seeded digest", async () => {
  await withServer({ demo: true }, async (call) => {
    const board = await call("/api/arena/leaderboard");
    const china = board.body.groups.find((group) => group.market === "A");
    assert.ok(china.accounts.some((account) => account.health.status === "missed"));
    assert.ok(china.accounts.every((account) => account.riskPolicy.maxDrawdownPct === 15));
    const digests = await call("/api/arena/digests");
    assert.equal(digests.body.demo, true);
    assert.ok(digests.body.digests.length >= 1);
    assert.equal((await call("/api/arena/digests", { send: true })).status, 409);
  });
});

test("dashboard lists are paged and filtered on the server", async () => {
  await withServer({ demo: true }, async (call) => {
    const board = await call("/api/arena/leaderboard");
    const account = board.body.groups.find((group) => group.market === "A").accounts[0];
    const detail = (await call(`/api/arena/accounts/${account.id}`)).body;
    const history = (kind, query = "") => call(`/api/arena/accounts/${account.id}/history?kind=${kind}${query}`);
    const first = await history("trades", "&limit=2");
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, Math.min(2, detail.trades.length));
    assert.equal(first.body.total, detail.trades.length);
    assert.equal(first.body.items[0].id, detail.trades[0].id, "newest first");
    const second = await history("trades", "&limit=2&offset=2");
    assert.notEqual(second.body.items[0]?.id, first.body.items[0].id);
    const buys = await history("trades", "&side=BUY&limit=200");
    assert.ok(buys.body.items.every((trade) => trade.side === "BUY"));
    assert.equal(buys.body.total, detail.trades.filter((trade) => trade.side === "BUY").length);
    const symbol = detail.trades[0].symbol;
    const searched = await history("trades", `&q=${encodeURIComponent(symbol.toLowerCase())}&limit=200`);
    assert.ok(searched.body.total > 0 && searched.body.items.every((trade) => `${trade.symbol} ${trade.name} ${trade.reason}`.toLowerCase().includes(symbol.toLowerCase())));
    const kinds = await history("journal", "&limit=200");
    const kind = kinds.body.facets.types[0];
    assert.ok((await history("journal", `&type=${kind}&limit=200`)).body.items.every((entry) => entry.kind === kind));
    assert.equal((await history("trades", "&from=2099-01-01")).body.total, 0, "date range filters");
    assert.equal((await history("nope")).status, 400);
    const reports = await call("/api/arena/reports?limit=1");
    assert.equal(reports.status, 200);
    assert.ok(reports.body.reports.length <= 1);
    assert.ok(reports.body.total >= reports.body.reports.length);
    assert.ok(Array.isArray(reports.body.accounts));
    const digests = await call("/api/arena/digests?limit=5&offset=0");
    assert.equal(digests.status, 200);
    assert.equal(typeof digests.body.total, "number");
  });
});
