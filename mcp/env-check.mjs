// Environment check for the settings page: which agent CLIs are installed (and their version),
// whether the service, matcher and scheduler run, and whether each market data source answers.
// Login state is not probed directly (that would spend quota); it is inferred from the last run.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getIntradayBars, getNews, getStorageDir, getTradeQuote, scanMarket } from "./core.mjs";
import { readServiceStatus } from "./service.mjs";
import { ACP_PRESETS, defaultCommand, onPath } from "./scheduler.mjs";

const AGENTS = [
  { id: "claude", name: "Claude Code", kind: "claude-cli" },
  { id: "codex", name: "Codex", kind: "codex-cli" },
  { id: "kimi", name: "Kimi Code", kind: "kimi-cli" },
  { id: "workbuddy", name: "WorkBuddy", kind: "claude-cli" },
  ...ACP_PRESETS.filter((preset) => preset.id !== "kimi-acp").map((preset) => ({ id: preset.id, name: preset.name, kind: "acp", command: preset.command, args: preset.args })),
];

function version(command, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try { child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, NO_COLOR: "1" } }); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(null); }, timeoutMs);
    child.stdout?.on("data", (chunk) => { out += chunk; });
    child.stderr?.on("data", (chunk) => { out += chunk; });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => { clearTimeout(timer); resolve(out.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? (out.trim().split("\n")[0]?.slice(0, 40) || null)); });
  });
}

async function timed(task) {
  const started = Date.now();
  try { const value = await task(); return { ok: true, ms: Date.now() - started, value }; }
  catch (error) { return { ok: false, ms: Date.now() - started, error: error.message.slice(0, 200) }; }
}

async function dirSize(dir, depth = 0) {
  if (depth > 4) return 0;
  let total = 0;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full, depth + 1);
    else { try { total += (await stat(full)).size; } catch { /* gone */ } }
  }
  return total;
}

export async function checkEnvironment({ arena, scheduler }) {
  const jobs = scheduler ? await scheduler.listJobs().catch(() => []) : [];
  const pools = scheduler ? await scheduler.listPools().catch(() => []) : [];
  const agents = await Promise.all(AGENTS.map(async (agent) => {
    const command = agent.kind === "acp" ? onPath(agent.command) : defaultCommand(agent.id);
    const installed = Boolean(command && (path.isAbsolute(command) ? existsSync(command) : onPath(command)));
    const ver = installed ? await version(command) : null;
    const used = jobs.filter((job) => job.runner?.type === agent.id || (agent.kind === "acp" && job.runner?.command === agent.command));
    const authFailure = used.find((job) => job.paused?.kind === "auth");
    const pool = pools.find((entry) => entry.key === agent.id || entry.key === `acp:${agent.command}`);
    const status = !installed ? "missing" : authFailure ? "auth" : pool?.paused ? "quota" : "ok";
    return {
      ...agent, command: installed ? command : null, version: ver, installed, status, traders: used.length,
      detail: !installed ? "没找到命令" : authFailure ? `没有登录：${authFailure.paused.message ?? ""}` : pool?.paused ? `额度用尽，${pool.pausedUntil} 恢复` : used.length ? `${used.length} 个交易员在用` : "已安装",
    };
  }));
  const [service, matcher, tencent, eastmoney, minutes, news] = await Promise.all([
    readServiceStatus(arena.root).catch(() => ({ state: "unknown" })),
    arena.matcherStatus().catch(() => ({ state: "unknown" })),
    timed(() => getTradeQuote("000300.SS", { timeoutMs: 6000 })),
    timed(() => scanMarket({ market: "A", sort: "amount", limit: 1 })),
    timed(() => getIntradayBars("600036.SS")),
    timed(() => getNews("招商银行", 1, { symbol: "600036.SS" })),
  ]);
  const sources = [
    { id: "tencent", name: "行情 · 腾讯", ok: tencent.ok, ms: tencent.ms, detail: tencent.ok ? `实时 · 五档${tencent.value.bids?.length ? "" : "（本次没有返回盘口）"}` : tencent.error },
    { id: "eastmoney", name: "全市场扫描 · 东方财富", ok: eastmoney.ok, ms: eastmoney.ms, detail: eastmoney.ok ? "排行与板块" : eastmoney.error },
    { id: "minutes", name: "分钟线 · 腾讯", ok: minutes.ok, ms: minutes.ms, detail: minutes.ok ? `${minutes.value.bars?.length ?? 0} 根` : minutes.error },
    { id: "news", name: "新闻与公告", ok: news.ok, ms: news.ms, detail: news.ok ? "东方财富 / Yahoo" : news.error },
  ];
  const storage = getStorageDir();
  const items = [
    ...agents.filter((agent) => agent.installed || agent.kind !== "acp").map((agent) => ({ id: `agent:${agent.id}`, group: "agent", name: agent.name, status: agent.status === "ok" ? "ok" : agent.status === "missing" ? "missing" : agent.status === "quota" ? "temporary" : "action", detail: [agent.version, agent.detail].filter(Boolean).join(" · ") })),
    { id: "service", group: "service", name: "常驻服务", status: service.state === "running" ? "ok" : "action", detail: service.state === "running" ? `端口 ${service.port ?? 8780} · ${service.version ?? ""}` : "没有运行：npm run service:install" },
    { id: "matcher", group: "service", name: "撮合器", status: matcher.state === "running" ? "ok" : matcher.state === "stale" ? "action" : "action", detail: matcher.state === "running" ? `最近 ${matcher.lastTickAt ?? "—"}` : matcher.state },
    { id: "scheduler", group: "service", name: "调度器", status: service.scheduler || scheduler?.status().role === "leader" ? "ok" : "action", detail: service.scheduler ? `${service.scheduler.role ?? ""} · 运行中 ${service.scheduler.running?.length ?? 0}` : "跟随常驻服务" },
    ...sources.map((source) => ({ id: `source:${source.id}`, group: "data", name: source.name, status: source.ok ? "ok" : "action", detail: source.ok ? `${source.detail} · ${source.ms} ms` : source.detail })),
    { id: "storage", group: "service", name: "数据目录", status: "ok", detail: `${storage} · ${(await dirSize(storage) / 1048576).toFixed(0)} MB` },
  ];
  return {
    at: new Date().toISOString(), items, agents, sources, pools,
    summary: { ok: items.filter((item) => item.status === "ok").length, action: items.filter((item) => item.status === "action").length, temporary: items.filter((item) => item.status === "temporary").length, missing: items.filter((item) => item.status === "missing").length },
    acpPresets: ACP_PRESETS,
  };
}
