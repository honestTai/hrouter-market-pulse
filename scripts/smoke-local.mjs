import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const storage = await mkdtemp(path.join(os.tmpdir(), "hrouter-local-smoke-"));
const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const occupiedPort = probe.address().port;
let port;
const pluginRoot = path.resolve("plugins/hrouter-market-pulse");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["mcp/server.bundle.mjs", "--stdio"],
  cwd: pluginRoot,
  env: {
    ...process.env,
    HROUTER_REPORT_DIR: storage,
    HROUTER_REPORT_PORT: String(occupiedPort),
    HROUTER_WATCHLIST: "",
    HROUTER_FUTU_ENABLED: "0",
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
  const initialPreferences = await client.callTool({
    name: "get_preferences",
    arguments: {},
  });
  port = initialPreferences.structuredContent.reportPort;
  assert.notEqual(
    port,
    occupiedPort,
    "Dashboard must select an available port",
  );
  const { tools } = await client.listTools();
  for (const name of [
    "get_quote",
    "calculate_position_budget",
    "run_backtest",
    "query_prediction_ledger",
    "record_decision",
    "sync_official_evidence",
    "ingest_official_records",
    "build_earnings_review",
    "query_catalyst_calendar",
    "append_thesis_review",
    "query_thesis_scorecard",
    "get_paper_trading_status",
    "list_paper_accounts",
    "evaluate_paper_order",
    "submit_paper_order",
    "cancel_paper_order",
    "refresh_paper_account",
    "arena_register_account",
    "arena_my_accounts",
    "arena_get_account",
    "arena_place_order",
    "arena_cancel_order",
    "arena_log_decision",
    "arena_update_strategy",
    "arena_leaderboard",
  ])
    assert.ok(
      tools.some((tool) => tool.name === name),
      name,
    );
  await readFile(`${pluginRoot}/licenses/financial-services-APACHE-2.0.txt`, "utf8");
  await readFile(`${pluginRoot}/skills/hrouter-fundamental-research/SKILL.md`, "utf8");
  await client.callTool({ name: "register_data_provider", arguments: {
    id: "smoke-research", name: "Synthetic smoke evidence", sourceTier: "primary", kinds: ["financial", "filing"],
  } });
  const financialInput = {
    providerId: "smoke-research", sourceTier: "primary", kind: "financial", entity: { symbol: "AAPL" },
    sourceUrl: "https://example.com/synthetic-smoke", title: "Synthetic revenue — not market data",
    publishedAt: "2020-07-20T20:00:00Z", availableAt: "2020-07-20T20:00:00Z",
    payload: { metric: "Revenue", value: 120, unit: "USD", accountingBasis: "us-gaap", valueType: "actual", periodStart: "2020-04-01", periodEnd: "2020-06-30" },
  };
  const imported = await client.callTool({ name: "ingest_evidence", arguments: { items: [
    financialInput,
    { ...financialInput, payload: { ...financialInput.payload, value: 100, periodStart: "2019-04-01", periodEnd: "2019-06-30" } },
    { ...financialInput, kind: "filing", title: "Synthetic event", payload: { eventType: "earnings", eventKey: "smoke-q2", scheduledAt: "2020-08-10T20:00:00Z", eventStatus: "confirmed" } },
  ] } });
  assert.equal(imported.isError, undefined);
  const [actualId, priorId] = imported.structuredContent.ids;
  const earnings = await client.callTool({ name: "build_earnings_review", arguments: {
    symbol: "AAPL", asOf: "2020-08-01T00:00:00Z", metrics: [{ actualEvidenceId: actualId, comparisonEvidenceId: priorId }],
  } });
  assert.equal(earnings.isError, undefined);
  assert.equal(earnings.structuredContent.metrics[0].changePct, 20);
  const calendar = await client.callTool({ name: "query_catalyst_calendar", arguments: { symbols: ["AAPL"], asOf: "2020-08-01T00:00:00Z" } });
  assert.equal(calendar.isError, undefined);
  assert.equal(calendar.structuredContent.events.length, 1);
  await writeFile(path.join(storage, "decisions.json"), JSON.stringify([{
    id: "decision_smoke", symbol: "AAPL", thesis: "Synthetic smoke thesis", state: "watch", createdAt: "2020-01-01T00:00:00Z", reviews: [],
  }]));
  const thesis = await client.callTool({ name: "append_thesis_review", arguments: {
    decisionId: "decision_smoke",
    pillars: [{ id: "growth", expectation: "Growth above 10%", invalidationCondition: "Growth below 5%" }],
    updates: [{ pillarId: "growth", status: "supported", rationale: "Synthetic test only", evidenceIds: [actualId] }],
  } });
  assert.equal(thesis.isError, undefined);
  assert.equal(thesis.structuredContent.stateUnchanged, "watch");
  const scorecard = await client.callTool({ name: "query_thesis_scorecard", arguments: { decisionId: "decision_smoke" } });
  assert.equal(scorecard.isError, undefined);
  assert.equal(scorecard.structuredContent.pillars[0].status, "supported");
  const paperStatus = await client.callTool({ name: "get_paper_trading_status", arguments: {} });
  assert.equal(paperStatus.structuredContent.environment, "SIMULATE");
  assert.equal(paperStatus.structuredContent.bridgeEnabled, false);
  assert.deepEqual(paperStatus.structuredContent.samples, []);
  const blockedPaper = await client.callTool({ name: "submit_paper_order", arguments: {
    symbol: "AAPL", side: "BUY", quantity: 1, limitPrice: 100,
    rationale: "Offline smoke only", idempotencyKey: "smoke-paper-0001",
  } });
  assert.equal(blockedPaper.structuredContent.status, "blocked");
  await readFile(`${pluginRoot}/bridges/futu/bridge.py`, "utf8");
  await readFile(`${pluginRoot}/bridges/futu/requirements.txt`, "utf8");
  await readFile(`${pluginRoot}/skills/hrouter-paper-trading/SKILL.md`, "utf8");
  // One package for every agent host: Codex manifest + Claude/WorkBuddy manifest and portable MCP config.
  await readFile(`${pluginRoot}/skills/hrouter-agent-arena/SKILL.md`, "utf8");
  const claudeManifest = JSON.parse(await readFile(`${pluginRoot}/.claude-plugin/plugin.json`, "utf8"));
  const codexManifest = JSON.parse(await readFile(`${pluginRoot}/.codex-plugin/plugin.json`, "utf8"));
  assert.equal(claudeManifest.version, codexManifest.version.split("+")[0]);
  const portableMcp = JSON.parse(await readFile(`${pluginRoot}/.mcp.json`, "utf8"));
  assert.deepEqual(portableMcp.mcpServers.hrouter_market_pulse.args, ["${CLAUDE_PLUGIN_ROOT}/mcp/server.bundle.mjs", "--stdio"]);
  const codexMcp = JSON.parse(await readFile(`${pluginRoot}/${codexManifest.mcpServers}`, "utf8"));
  assert.equal(codexMcp.mcpServers.hrouter_market_pulse.cwd, ".");
  const marketplace = JSON.parse(await readFile(".claude-plugin/marketplace.json", "utf8"));
  assert.equal(marketplace.plugins[0].version, claudeManifest.version);
  const arenaList = await client.callTool({ name: "arena_leaderboard", arguments: {} });
  assert.ok(Array.isArray(arenaList.structuredContent.groups));
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
    "dashboard.js.LEGAL.txt",
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
        "paper MCP tools, disabled execution, optional bridge and skill",
        "agent arena tools, skill and Codex / Claude Code / WorkBuddy manifests",
        "tool registration",
        "risk calculation",
        "financial evidence comparison",
        "point-in-time event calendar",
        "append-only thesis scorecard",
        "packaged research skill and upstream license",
        "dashboard",
        "React bundle, styles, notices and legacy vendor assets",
        "cross-origin write rejection",
        "isolated preferences",
      ],
    }),
  );
} finally {
  await new Promise((resolve) => probe.close(resolve));
  await client.close();
  await transport.close();
  await rm(storage, { recursive: true, force: true });
}
