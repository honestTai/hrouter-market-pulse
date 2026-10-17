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

export async function checkEnvironment({ arena, scheduler, language = "zh" }) {
  const L = (zh, en) => (language === "en" ? en : zh);
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
      detail: !installed ? L("没找到命令", "Command not found") : authFailure ? `${L("没有登录：", "Not signed in: ")}${authFailure.paused.message ?? ""}` : pool?.paused ? L(`额度用尽，${pool.pausedUntil} 恢复`, `Out of quota, back ${pool.pausedUntil}`) : used.length ? L(`${used.length} 个交易员在用`, `Used by ${used.length} traders`) : L("已安装", "Installed"),
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
    { id: "tencent", name: L("行情 · 腾讯", "Quotes · Tencent"), ok: tencent.ok, ms: tencent.ms, detail: tencent.ok ? `${L("实时 · 五档", "Live · 5-level book")}${tencent.value.bids?.length ? "" : L("（本次没有返回盘口）", " (no book this time)")}` : tencent.error },
    { id: "eastmoney", name: L("全市场扫描 · 东方财富", "Market scan · East Money"), ok: eastmoney.ok, ms: eastmoney.ms, detail: eastmoney.ok ? L("排行与板块", "Rankings and sectors") : eastmoney.error },
    { id: "minutes", name: L("分钟线 · 腾讯", "Minute bars · Tencent"), ok: minutes.ok, ms: minutes.ms, detail: minutes.ok ? L(`${minutes.value.bars?.length ?? 0} 根`, `${minutes.value.bars?.length ?? 0} bars`) : minutes.error },
    { id: "news", name: L("新闻与公告", "News and filings"), ok: news.ok, ms: news.ms, detail: news.ok ? L("东方财富 / Yahoo", "East Money / Yahoo") : news.error },
  ];
  const storage = getStorageDir();
  const items = [
    ...agents.filter((agent) => agent.installed || agent.kind !== "acp").map((agent) => ({ id: `agent:${agent.id}`, group: "agent", name: agent.name, status: agent.status === "ok" ? "ok" : agent.status === "missing" ? "missing" : agent.status === "quota" ? "temporary" : "action", detail: [agent.version, agent.detail].filter(Boolean).join(" · ") })),
    { id: "service", group: "service", name: L("常驻服务", "Background service"), status: service.state === "running" ? "ok" : "action", detail: service.state === "running" ? `${L("端口", "port")} ${service.port ?? 8780} · ${service.version ?? ""}` : L("没有运行：npm run service:install", "Not running: npm run service:install") },
    { id: "matcher", group: "service", name: L("撮合器", "Matcher"), status: matcher.state === "running" ? "ok" : "action", detail: matcher.state === "running" ? `${L("最近", "last")} ${matcher.lastTickAt ?? "—"}` : matcher.state },
    { id: "scheduler", group: "service", name: L("调度器", "Scheduler"), status: service.scheduler || scheduler?.status().role === "leader" ? "ok" : "action", detail: service.scheduler ? `${service.scheduler.role ?? ""} · ${L("运行中", "running")} ${service.scheduler.running?.length ?? 0}` : L("跟随常驻服务", "Runs with the background service") },
    ...sources.map((source) => ({ id: `source:${source.id}`, group: "data", name: source.name, status: source.ok ? "ok" : "action", detail: source.ok ? `${source.detail} · ${source.ms} ms` : source.detail })),
    { id: "storage", group: "service", name: L("数据目录", "Data folder"), status: "ok", detail: `${storage} · ${(await dirSize(storage) / 1048576).toFixed(0)} MB` },
  ];
  return {
    at: new Date().toISOString(), items, agents, sources, pools,
    summary: { ok: items.filter((item) => item.status === "ok").length, action: items.filter((item) => item.status === "action").length, temporary: items.filter((item) => item.status === "temporary").length, missing: items.filter((item) => item.status === "missing").length },
    acpPresets: ACP_PRESETS,
  };
}
