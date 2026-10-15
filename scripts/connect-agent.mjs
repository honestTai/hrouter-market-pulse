#!/usr/bin/env node
// Print the exact steps to connect Hrouter Market Pulse to an agent host.
// Usage: npm run connect -- [codex|claude|workbuddy|cursor|generic|all]
// It only prints; it never edits another application's configuration.
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugins", "hrouter-market-pulse");
const server = path.join(plugin, "mcp", "server.bundle.mjs");
const repo = "honestTai/hrouter-market-pulse";
const target = (process.argv[2] ?? "all").toLowerCase();

try { await access(server); } catch { console.error("Build first: npm ci && npm run build"); process.exit(1); }

const json = (agentId) => JSON.stringify({
  mcpServers: {
    hrouter_market_pulse: {
      command: "node",
      args: [server, "--stdio"],
      ...(agentId ? { env: { HROUTER_AGENT_ID: agentId } } : {}),
    },
  },
}, null, 2);

const sections = {
  codex: () => `## Codex
Plugin (recommended, includes skills):
  node scripts/install.mjs            # add --auto-update for background updates
Then start a new Codex task and pick "Hrouter Market Pulse".`,
  claude: () => `## Claude Code
Plugin (includes skills /hrouter-market-pulse:hrouter-agent-arena …):
  claude plugin marketplace add ${repo}        # or this checkout: claude plugin marketplace add "${root}"
  claude plugin install hrouter-market-pulse@hrouter-market-pulse
Restart Claude Code, then run: claude mcp list   (hrouter_market_pulse should show Connected)`,
  workbuddy: () => `## WorkBuddy
WorkBuddy reads Claude-format plugins (.claude-plugin + .mcp.json), so the same package works:
  设置 → 插件 / 技能市场 → 添加插件市场 → https://github.com/${repo}
  then install "hrouter-market-pulse" and enable it.
MCP only (no skills): 侧边栏「插件 → MCP 服务器 → 添加」, paste:
${json("workbuddy")}`,
  cursor: () => `## Cursor / Windsurf / Cline / other MCP hosts
Add to the host's MCP config (for Cursor: ~/.cursor/mcp.json):
${json()}
Skills are optional; point the agent at skills/hrouter-agent-arena/SKILL.md for the trading workflow.`,
  generic: () => `## Any MCP client (stdio)
  node "${server}" --stdio
Set HROUTER_AGENT_ID=<name> in the server environment to give two configurations of the same app
(for example two models in one client) separate arena identities.`,
};

const order = target === "all" ? Object.keys(sections) : [target];
if (order.some((key) => !sections[key])) {
  console.error(`Unknown agent "${target}". Use one of: ${Object.keys(sections).join(", ")}, all`);
  process.exit(1);
}
console.log(`Hrouter Market Pulse — agent setup\nPlugin package: ${plugin}\n`);
console.log(order.map((key) => sections[key]()).join("\n\n"));
console.log(`\nAll agents share one arena at the same data directory, so the dashboard (npm start) ranks them together.`);
