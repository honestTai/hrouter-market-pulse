import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startDashboard } from "../mcp/http.mjs";
import { createClient, parseArgs, run } from "../cli/market-pulse.mjs";

const { createSeededArena } = await import("./fixtures/arena-seed.mjs");

async function withCli(fn) {
  const server = startDashboard({ port: 0, matcher: false, arena: await createSeededArena() });
  await server.ready;
  const url = `http://127.0.0.1:${server.address().port}`;
  const cli = async (args, { agentId } = {}) => {
    const lines = [];
    await run([...args, "--json"], { client: createClient({ url, agentId: agentId ?? null }), print: (text) => lines.push(text) });
    return JSON.parse(lines.join("\n"));
  };
  try { await fn(cli, url); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("cli: argument parsing", () => {
  assert.deepEqual(parseArgs(["limits", "K3", "minCashPct=20", "--reason", "tighter", "--json"]), { positional: ["limits", "K3", "minCashPct=20"], flags: { reason: "tighter", json: true } });
  assert.deepEqual(parseArgs(["ask", "K3", "why?", "--note=a=b"]).flags, { note: "a=b" });
});

test("cli: reads traders by name, talks to them and changes their settings as the owner", async () => {
  await withCli(async (cli) => {
    const traders = await cli(["traders"]);
    assert.ok(traders.length >= 2);
    const target = traders.find((entry) => entry.market === "A");
    const word = target.name.split(/\s+/)[0];
    const detail = await cli(["trader", target.id]);
    assert.equal(detail.id, target.id);
    await cli(["tell", target.id, "这周不碰半导体", "--days", "2"]);
    await cli(["rule", target.id, "单日涨幅超过 5% 不追"]);
    await cli(["limits", target.id, "maxPositions=4", "minCashPct=off"]);
    await cli(["autonomy", target.id, "confirm"]);
    const after = await cli(["trader", target.id]);
    assert.equal(after.autonomy.level, "confirm");
    assert.equal(after.limits.maxPositions, 4);
    assert.ok(after.rules.some((rule) => rule.text.includes("不追")));
    assert.ok(after.instructions.some((entry) => entry.text.includes("半导体")));
    const status = await cli(["status"]);
    assert.equal(status.traders, traders.length);
    assert.ok(word.length > 0);
  });
});

test("cli: inside a trader's round it can read but every change is refused", async () => {
  await withCli(async (cli) => {
    const [first] = await cli(["traders"], { agentId: "kimi-code" });
    await assert.rejects(cli(["autonomy", first.id, "full"], { agentId: "kimi-code" }), /read-only/);
    await assert.rejects(cli(["limits", first.id, "minCashPct=off"], { agentId: "kimi-code" }), /read-only/);
  });
});

test("cli: unknown trader names and commands explain themselves", async () => {
  await withCli(async (cli) => {
    await assert.rejects(cli(["trader", "no-such-trader-xyz"]), /No trader matches/);
    await assert.rejects(cli(["frobnicate"]), /Unknown command/);
  });
  await assert.rejects(run(["status"], { client: createClient({ url: "http://127.0.0.1:9" }), print: () => {} }), /Cannot reach the workbench/);
});

test("cli: install writes a market-pulse wrapper", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cli-install-"));
  try {
    const lines = [];
    await run(["install", "--dir", dir, "--json"], { print: (text) => lines.push(text) });
    const result = JSON.parse(lines.join("\n"));
    assert.match(await readFile(result.path, "utf8"), /market-pulse\.mjs/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("report port: 0 means any free port, junk falls back to 8787", async () => {
  const { getReportPort } = await import("../mcp/core.mjs");
  const saved = process.env.HROUTER_REPORT_PORT;
  try {
    process.env.HROUTER_REPORT_PORT = "0";
    assert.equal(getReportPort(), 0);
    process.env.HROUTER_REPORT_PORT = "abc";
    assert.equal(getReportPort(), 8787);
  } finally { if (saved === undefined) delete process.env.HROUTER_REPORT_PORT; else process.env.HROUTER_REPORT_PORT = saved; }
});
