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

test.after(() => rm(dataDir, { recursive: true, force: true }));

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
    const invalid = await call("/api/arena/accounts", { name: "x", model: "", market: "US" });
    assert.equal(invalid.status, 400);
  });
});
