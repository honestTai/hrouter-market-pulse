import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const storage = await mkdtemp(path.join(os.tmpdir(), "hrouter-local-smoke-"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const pluginRoot = path.resolve("plugins/hrouter-market-pulse");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["mcp/server.bundle.mjs", "--stdio"],
  cwd: pluginRoot,
  env: {
    ...process.env,
    HROUTER_REPORT_DIR: storage,
    HROUTER_REPORT_PORT: String(port),
    HROUTER_WATCHLIST: "",
  },
  stderr: "pipe",
});
const client = new Client({
  name: "market-pulse-release-check",
  version: "1.1.0",
});
try {
  const packagedManifest = JSON.parse(
    await readFile(
      "plugins/hrouter-market-pulse/.codex-plugin/plugin.json",
      "utf8",
    ),
  );
  assert.equal(packagedManifest.name, "hrouter-market-pulse");
  for (const name of [
    "event",
    "evidence",
    "signal",
    "strategy",
    "strategy-result",
  ])
    JSON.parse(
      await readFile(
        `plugins/hrouter-market-pulse/schemas/${name}.schema.json`,
        "utf8",
      ),
    );
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of [
    "get_quote",
    "calculate_position_budget",
    "run_backtest",
    "query_prediction_ledger",
    "record_decision",
    "sync_official_evidence",
    "ingest_official_records",
  ])
    assert.ok(
      tools.some((tool) => tool.name === name),
      name,
    );
  const result = await client.callTool({
    name: "calculate_position_budget",
    arguments: {
      capital: 10000,
      capitalCurrency: "USD",
      maxLossPctPerIdea: 1,
      maxPositionPct: 20,
      ideas: [
        { symbol: "AAPL", entryPrice: 100, invalidationPrice: 90, lotSize: 1 },
      ],
    },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.ideas[0].quantityCeiling, 10);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(await home.text(), /Hrouter Market Pulse/i);
  const denied = await fetch(`http://127.0.0.1:${port}/api/preferences`, {
    method: "POST",
    headers: {
      Origin: "https://example.com",
      "Content-Type": "application/json",
    },
    body: '{"watchlist":["AAPL"]}',
  });
  assert.equal(denied.status, 403);
  for (const name of [
    "dashboard.css",
    "dashboard.js",
    "vendor/lightweight-charts.js",
    "vendor/lucide.js",
  ])
    assert.equal(
      (await fetch(`http://127.0.0.1:${port}/assets/${name}`)).status,
      200,
    );
  const prefs = await client.callTool({
    name: "get_preferences",
    arguments: {},
  });
  assert.deepEqual(prefs.structuredContent.watchlist, []);
  console.log(
    JSON.stringify({
      status: "passed",
      tools: tools.length,
      checks: [
        "MCP initialization",
        "tool registration",
        "risk calculation",
        "dashboard",
        "vendor assets",
        "cross-origin write rejection",
        "isolated preferences",
      ],
    }),
  );
} finally {
  await client.close();
  await transport.close();
  await rm(storage, { recursive: true, force: true });
}
