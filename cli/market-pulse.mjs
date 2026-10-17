#!/usr/bin/env node
// market-pulse: drive the whole stock workbench from a shell, for you or for any agent working for
// you (Claude Code, Codex, Kimi, scripts …). It talks to the local service (http://127.0.0.1:8780 by
// default) and has no dependencies. `--json` prints machine-readable output for agents.
//
// Inside a trader's own round (HROUTER_AGENT_ID is set) the service only answers reads: a trader can
// look things up here but cannot approve its own orders or loosen its own limits.

import { existsSync } from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `market-pulse — control the local stock workbench (paper trading, real quotes)

Usage: market-pulse <command> [args] [--json] [--url http://127.0.0.1:8780]

Overview
  status                               service, traders, things waiting for you
  traders                              list traders with returns and state
  trader <name|id>                     one trader: account, holdings, limits, rules
  leaderboard                          arena ranking

Traders
  new --market A|HK|US --agent claude|codex|kimi|workbuddy [--model M] [--effort high]
      [--name N] [--template ID] [--cash N] [--autonomy full|confirm|suggest] [--review 10]
  pause <trader> | resume <trader>      stop / restart its schedule
  review <trader>                      run a review now
  archive <trader>                     stop trading and hide it (records kept)
  autonomy <trader> full|confirm|suggest
  limits <trader> key=value …          e.g. minCashPct=20 maxPositions=6 maxIndustryPct=30 (value "off" clears)
  prompt <trader> "text"               the trader's own prompt layer
  agent <trader> --agent codex [--model M] [--effort high]

Talk to a trader
  ask <trader> "question"              answered read-only, never trades
  tell <trader> "instruction" [--days 3]
  rule <trader> "standing rule"        | rules <trader> | unrule <trader> <rul_id>

Orders and approvals
  approvals                            orders waiting for your confirmation
  approve <apr_id> [--note …]          | reject <apr_id> [--note …]
  orders <trader> [--kind trades|orders|journal|events] [--limit 20]
  reconcile <trader>                   rebuild cash and positions from the records
  requests <trader>                    agent requests to change locked settings
  grant <trader> <req_id> | deny <trader> <req_id>

Research and market
  research                             list research tasks
  research new --kind question|deep-dive|investor-panel|market-recap [--symbols 600519,0700.HK]
      [--prompt "…"] [--agent codex] [--model M] [--effort high]
  research show <res_id> | research retry <res_id> | research delete <res_id>
  reports [--trader T] [--limit 10]    | report <rpt_id>
  digest [--market A] [--send]         generate the close digest (and push it)
  radar                                A-share breadth, sentiment, limit-ups, dragon-tiger, flows
  lhb [--symbol 600519]                dragon-tiger list or one stock's seats
  emotion                              sentiment cycle and promotion rates

System
  schedules | pools | env | models     schedules, quota pools, environment check, agent models
  skills | skills updates | skills import --git URL [--subdir D] | --folder PATH | --claude NAME
  settings                             workbench settings
  api GET|POST /path ['{json}']        any HTTP endpoint (escape hatch)
  install [--dir ~/.local/bin]         put "market-pulse" on your PATH

Traders can be named by id (acc_…) or by (part of) their name.`;

// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s);
      if (inline !== undefined) flags[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(arg);
  }
  return { positional, flags };
}

class CliError extends Error {}

export function createClient({ url, agentId = process.env.HROUTER_AGENT_ID, fetchImpl = fetch } = {}) {
  const base = (url ?? process.env.HROUTER_WORKBENCH_URL ?? `http://127.0.0.1:${process.env.HROUTER_ARENA_PORT || 8780}`).replace(/\/$/, "");
  async function call(method, route, body) {
    let response;
    try {
      response = await fetchImpl(base + route, {
        method, headers: { "Content-Type": "application/json", ...(agentId ? { "X-Hrouter-Agent": agentId } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new CliError(`Cannot reach the workbench at ${base} (${error.cause?.code ?? error.message}). Start it with "npm run service:install" or open the desktop app.`);
    }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) throw new CliError(data.error ?? `HTTP ${response.status}`);
    return data;
  }
  return { base, get: (route) => call("GET", route), post: (route, body = {}) => call("POST", route, body) };
}

const pct = (value) => (typeof value === "number" && Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(2)}%` : "—");
const num = (value, digits = 2) => (typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—");
const short = (text, length = 80) => { const value = String(text ?? "").replace(/\s+/g, " ").trim(); return value.length > length ? `${value.slice(0, length - 1)}…` : value; };

function table(rows, columns) {
  if (!rows.length) return "(none)";
  const width = (text) => [...String(text)].reduce((sum, char) => sum + (/[ᄀ-￿]/.test(char) ? 2 : 1), 0);
  const cells = rows.map((row) => columns.map(([, get]) => String(get(row) ?? "—")));
  const widths = columns.map(([title], index) => Math.max(width(title), ...cells.map((row) => width(row[index]))));
  const pad = (text, size) => text + " ".repeat(Math.max(0, size - width(text)));
  return [columns.map(([title], index) => pad(title, widths[index])).join("  "), ...cells.map((row) => row.map((cell, index) => pad(cell, widths[index])).join("  "))].join("\n");
}

async function traderList(client) {
  const board = await client.get("/api/arena/leaderboard");
  return board.groups.flatMap((group) => group.accounts);
}

export async function resolveTrader(client, query) {
  if (!query) throw new CliError("Name a trader (id or part of its name). See: market-pulse traders");
  if (/^acc_[a-f0-9]{12}$/.test(query)) return query;
  const accounts = await traderList(client);
  const lower = query.toLowerCase();
  const exact = accounts.filter((account) => account.name.toLowerCase() === lower);
  const matches = exact.length ? exact : accounts.filter((account) => account.name.toLowerCase().includes(lower) || account.model?.toLowerCase() === lower);
  if (matches.length === 1) return matches[0].id;
  if (!matches.length) throw new CliError(`No trader matches "${query}". See: market-pulse traders`);
  throw new CliError(`"${query}" matches several traders:\n${matches.map((account) => `  ${account.id}  ${account.name}`).join("\n")}`);
}

async function findApproval(client, approvalId) {
  const { approvals } = await client.get("/api/approvals");
  const approval = approvals.find((entry) => entry.id === approvalId);
  if (!approval) throw new CliError(`No pending approval ${approvalId}. See: market-pulse approvals`);
  return approval;
}

async function defaultAgent(client, wanted, { readonly = false } = {}) {
  const env = await client.get("/api/env");
  const installed = env.agents.filter((agent) => agent.installed && agent.kind !== "acp" && !(readonly && agent.id === "kimi"));
  const agent = wanted ? installed.find((entry) => entry.id === wanted) : installed[0];
  if (!agent) throw new CliError(wanted ? `Agent "${wanted}" is not installed${readonly && wanted === "kimi" ? " or cannot run read-only" : ""}. Installed: ${installed.map((entry) => entry.id).join(", ") || "none"}` : "No agent CLI installed.");
  return agent.id;
}

async function runnerFor(client, flags, options) {
  const type = await defaultAgent(client, flags.agent, options);
  const models = await client.get("/api/agent-models");
  const latest = models.agents[type]?.models.find((model) => model.latest)?.id;
  const model = typeof flags.model === "string" ? flags.model : latest;
  return { type, ...(model ? { model } : {}), effort: typeof flags.effort === "string" ? flags.effort : models.defaultEffort };
}

function parseLimits(pairs) {
  const limits = {};
  for (const pair of pairs) {
    const [key, value] = pair.split("=");
    if (!key || value === undefined) throw new CliError(`Limits are key=value pairs, got "${pair}".`);
    limits[key] = value === "off" || value === "" ? null : key === "excludeBoards" ? value.split(",") : Number(value);
  }
  return limits;
}

// ---------------------------------------------------------------------------

export async function run(argv, { client: injected, print = (text) => process.stdout.write(`${text}\n`) } = {}) {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  if (!command || command === "help" || flags.help) { print(HELP); return; }
  const client = injected ?? createClient({ url: typeof flags.url === "string" ? flags.url : undefined });
  const out = (data, human) => print(flags.json ? JSON.stringify(data, null, 2) : typeof human === "function" ? human(data) : human ?? JSON.stringify(data, null, 2));
  const trader = async (index = 0) => resolveTrader(client, rest[index]);

  switch (command) {
    case "status": {
      const [health, board, approvals, schedules] = await Promise.all([client.get("/health"), client.get("/api/arena/leaderboard"), client.get("/api/approvals"), client.get("/api/arena/schedules")]);
      const accounts = board.groups.flatMap((group) => group.accounts);
      const paused = schedules.jobs.filter((job) => job.paused);
      const requests = accounts.reduce((sum, account) => sum + (account.pendingRequests ?? 0), 0);
      return out({ health, service: schedules.service, traders: accounts.length, approvals: approvals.approvals.length, requests, paused: paused.map((job) => job.accountId) }, () => [
        `Workbench ${health.version} at ${client.base} · service ${schedules.service?.state ?? "unknown"}`,
        `${accounts.length} traders · ${approvals.approvals.length} orders waiting for you · ${requests} change requests · ${paused.length} paused`,
        ...approvals.approvals.map((entry) => `  approval ${entry.id}  ${entry.account?.name}: ${entry.preview?.side} ${entry.preview?.name ?? entry.preview?.symbol} ×${entry.preview?.quantity} (${entry.reason})`),
      ].join("\n"));
    }
    case "traders": {
      const accounts = await traderList(client);
      return out(accounts.map(({ id, name, market, model, agent, metrics, autonomy, status, pendingApprovals }) => ({ id, name, market, model, agent, status, autonomy: autonomy?.level, totalReturnPct: metrics.totalReturnPct, todayReturnPct: metrics.todayReturnPct, positions: metrics.positions, pendingApprovals })), () => table(accounts, [
        ["ID", (a) => a.id], ["NAME", (a) => short(a.name, 28)], ["MKT", (a) => a.market], ["MODEL", (a) => short(a.model, 22)], ["TODAY", (a) => pct(a.metrics.todayReturnPct)], ["TOTAL", (a) => pct(a.metrics.totalReturnPct)], ["POS", (a) => a.metrics.positions], ["AUTONOMY", (a) => a.autonomy?.level ?? "full"], ["WAITING", (a) => a.pendingApprovals || ""],
      ]));
    }
    case "trader": {
      const account = await client.get(`/api/arena/accounts/${await trader()}`);
      return out(account, (a) => [
        `${a.name} (${a.id}) · ${a.market} · ${a.model} · autonomy ${a.autonomy?.level ?? "full"}`,
        `Equity ${num(a.metrics.equity)} ${a.currency} · total ${pct(a.metrics.totalReturnPct)} · today ${pct(a.metrics.todayReturnPct)} · cash ${num(a.limitStatus?.cashPct, 1)}%`,
        `Limits: ${Object.entries(a.limits ?? {}).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`).join(" ") || "none"}`,
        ...(a.rules ?? []).filter((rule) => rule.status === "active").map((rule) => `Rule ${rule.id}: ${rule.text}`),
        ...(a.instructions ?? []).filter((entry) => entry.status === "active").map((entry) => `Instruction until ${entry.expiresAt}: ${entry.text}`),
        "Holdings:",
        table(a.positions ?? [], [["SYMBOL", (p) => p.symbol], ["NAME", (p) => p.name], ["QTY", (p) => num(p.quantity, 0)], ["WEIGHT", (p) => `${num(p.weightPct, 1)}%`], ["P&L", (p) => pct(p.unrealizedPnlPct)], ["STOP", (p) => num(p.exitLevels?.stopLoss)]]),
        ...(a.latestReport ? [`Latest report: ${a.latestReport.title}`] : []),
      ].join("\n"));
    }
    case "leaderboard": {
      const board = await client.get("/api/arena/leaderboard");
      return out(board, (b) => b.groups.map((group) => `${group.market} · ${group.competition}\n${table(group.accounts, [["#", (a) => a.rank], ["NAME", (a) => short(a.name, 28)], ["TOTAL", (a) => pct(a.metrics.totalReturnPct)], ["EXCESS", (a) => pct(a.metrics.excessReturnPct)], ["MAX DD", (a) => `${num(a.metrics.maxDrawdownPct, 1)}%`], ["TRADES", (a) => a.metrics.trades]])}`).join("\n\n"));
    }
    case "new": {
      if (!["A", "HK", "US"].includes(flags.market)) throw new CliError("--market A|HK|US is required.");
      const runner = await runnerFor(client, flags);
      const account = await client.post("/api/arena/accounts", {
        name: typeof flags.name === "string" ? flags.name : undefined, market: flags.market, model: runner.model ?? runner.type, agentLabel: runner.type,
        ...(flags.template ? { template: flags.template } : {}), ...(flags.cash ? { initialCash: Number(flags.cash) } : {}),
        limits: { minCashPct: 20 }, reviewMinutes: Number(flags.review) || undefined, runner: { ...runner, timeoutMinutes: 20 },
      });
      if (flags.autonomy && flags.autonomy !== "full") await client.post(`/api/arena/accounts/${account.id}`, { autonomy: { level: flags.autonomy }, reason: "set when created (CLI)" });
      return out(account, (a) => `Created ${a.name} (${a.id}) · ${runner.type} ${runner.model ?? ""} · effort ${runner.effort}`);
    }
    case "pause": return out(await client.post(`/api/arena/schedules/${await trader()}`, { enabled: false }), "Paused; its schedule no longer runs.");
    case "resume": {
      const id = await trader();
      await client.post(`/api/arena/schedules/${id}`, { enabled: true });
      return out(await client.post(`/api/arena/schedules/${id}/resume`), "Resumed.");
    }
    case "review": return out(await client.post(`/api/arena/schedules/${await trader()}/run`), (r) => `Review ${r.status}${r.reason ? `: ${r.reason}` : ""}.`);
    case "archive": return out(await client.post(`/api/arena/accounts/${await trader()}/delete`), "Archived; open orders cancelled.");
    case "autonomy": {
      if (!["full", "confirm", "suggest"].includes(rest[1])) throw new CliError("autonomy <trader> full|confirm|suggest");
      return out(await client.post(`/api/arena/accounts/${await trader()}`, { autonomy: { level: rest[1] }, reason: flags.reason ?? "CLI" }), `Autonomy set to ${rest[1]}.`);
    }
    case "limits": return out(await client.post(`/api/arena/accounts/${await trader()}/limits`, { limits: parseLimits(rest.slice(1)), reason: flags.reason ?? "CLI" }), "Limits saved.");
    case "prompt": return out(await client.post(`/api/arena/accounts/${await trader()}/prompt`, { prompt: rest[1] ?? "", reason: flags.reason ?? "CLI" }), "Prompt saved; applies from the next review.");
    case "agent": {
      const id = await trader();
      const runner = await runnerFor(client, flags);
      return out(await client.post(`/api/arena/schedules/${id}`, { runner: { ...runner, timeoutMinutes: 20 } }), `Now runs on ${runner.type} ${runner.model ?? ""} · effort ${runner.effort}.`);
    }
    case "ask": {
      if (!rest[1]) throw new CliError('ask <trader> "question"');
      const result = await client.post(`/api/arena/accounts/${await trader()}/messages`, { text: rest[1] });
      return out(result, (r) => `Asked (${r.message.id}); ${r.status === "started" ? "the trader is answering now" : "it answers when free"}. Read the answer with: market-pulse trader ${rest[0]} --json (messages).`);
    }
    case "tell": {
      if (!rest[1]) throw new CliError('tell <trader> "instruction"');
      return out(await client.post(`/api/arena/accounts/${await trader()}/instructions`, { text: rest[1], days: Number(flags.days) || 3 }), "Instruction saved; every review includes it until it expires.");
    }
    case "rule": {
      if (!rest[1]) throw new CliError('rule <trader> "standing rule"');
      return out(await client.post(`/api/arena/accounts/${await trader()}/rules`, { text: rest[1] }), "Standing rule added.");
    }
    case "rules": {
      const account = await client.get(`/api/arena/accounts/${await trader()}`);
      return out(account.rules ?? [], (rules) => table(rules, [["ID", (r) => r.id], ["STATUS", (r) => r.status], ["BY", (r) => r.proposedBy ?? r.by ?? "owner"], ["RULE", (r) => short(r.text, 70)]]));
    }
    case "unrule": return out(await client.post(`/api/arena/accounts/${await trader()}/rules/${rest[1]}/revoke`), "Rule revoked.");
    case "approvals": {
      const { approvals } = await client.get("/api/approvals");
      return out(approvals, (rows) => table(rows, [["ID", (a) => a.id], ["TRADER", (a) => short(a.account?.name, 24)], ["ORDER", (a) => `${a.preview?.side} ${a.preview?.name ?? a.preview?.symbol} ×${a.preview?.quantity}${a.preview?.limitPrice ? ` @${a.preview.limitPrice}` : ""}`], ["WHY", (a) => a.reason], ["EXPIRES", (a) => a.expiresAt]]));
    }
    case "approve":
    case "reject": {
      const approval = await findApproval(client, rest[0]);
      const result = await client.post(`/api/arena/accounts/${approval.account.id}/approvals/${approval.id}`, { approve: command === "approve", note: typeof flags.note === "string" ? flags.note : undefined });
      return out(result, (r) => command === "reject" ? "Rejected; the trader sees it next round." : `Approved: ${r.order?.status ?? r.approval?.status}${r.order?.rejectReason ? ` (${r.order.rejectReason})` : ""}.`);
    }
    case "orders": {
      const kind = flags.kind ?? "trades";
      const page = await client.get(`/api/arena/accounts/${await trader()}/history?kind=${encodeURIComponent(kind)}&limit=${Number(flags.limit) || 20}`);
      return out(page, (p) => table(p.items, kind === "trades"
        ? [["TIME", (r) => r.at], ["SIDE", (r) => r.side], ["STOCK", (r) => `${r.name} ${r.symbol}`], ["QTY", (r) => num(r.quantity, 0)], ["PRICE", (r) => num(r.price, 3)], ["FEES", (r) => num(r.fees)], ["REASON", (r) => short(r.reason, 50)]]
        : kind === "orders" ? [["TIME", (r) => r.createdAt], ["SIDE", (r) => r.side], ["STOCK", (r) => `${r.name} ${r.symbol}`], ["QTY", (r) => num(r.quantity, 0)], ["STATUS", (r) => r.status], ["NOTE", (r) => short(r.rejectReason ?? r.reason, 50)]]
          : [["TIME", (r) => r.at], ["TYPE", (r) => r.type ?? r.kind], ["TEXT", (r) => short(r.message ?? r.text ?? r.reason, 80)]]));
    }
    case "reconcile": return out(await client.get(`/api/arena/accounts/${await trader()}/reconcile`), (r) => `${r.ok ? "Books match" : "Books do NOT match"} · cash from records ${num(r.cash?.ledger)} vs account ${num(r.cash?.stored)} · ${r.positions?.filter((p) => Math.abs(p.diff) > 0).length ?? 0} positions differ`);
    case "requests": {
      const account = await client.get(`/api/arena/accounts/${await trader()}`);
      const requests = (account.requests ?? []).filter((request) => request.status === "pending");
      return out(requests, (rows) => table(rows, [["ID", (r) => r.id], ["KEY", (r) => r.key], ["FROM", (r) => JSON.stringify(r.from)], ["TO", (r) => JSON.stringify(r.to)], ["REASON", (r) => short(r.reason, 50)]]));
    }
    case "grant":
    case "deny": return out(await client.post(`/api/arena/accounts/${await trader()}/requests/${rest[1]}`, { approve: command === "grant" }), command === "grant" ? "Granted." : "Denied.");
    case "research": {
      const [sub, id] = rest;
      if (!sub) {
        const { tasks } = await client.get("/api/research");
        return out(tasks, (rows) => table(rows, [["ID", (r) => r.id], ["KIND", (r) => r.kind], ["STATUS", (r) => r.status], ["TITLE", (r) => short(r.title, 50)], ["CREATED", (r) => r.createdAt]]));
      }
      if (sub === "new") {
        const kind = flags.kind ?? "question";
        const symbols = typeof flags.symbols === "string" ? flags.symbols.split(/[,\s]+/).filter(Boolean) : [];
        const task = await client.post("/api/research", { kind, title: typeof flags.title === "string" ? flags.title : undefined, symbols, prompt: typeof flags.prompt === "string" ? flags.prompt : rest[1] ?? "", runner: await runnerFor(client, flags, { readonly: true }) });
        return out(task, (t) => `Started ${t.id} (${t.kind}) on ${t.runner.type}. Read it with: market-pulse research show ${t.id}`);
      }
      if (sub === "show") {
        const { tasks } = await client.get("/api/research?limit=200");
        const task = tasks.find((entry) => entry.id === id);
        if (!task) throw new CliError(`No research task ${id}.`);
        return out(task, (t) => `${t.title} · ${t.status}\n\n${t.result?.text ?? t.result?.error ?? "(no report yet)"}`);
      }
      if (sub === "retry" || sub === "delete") return out(await client.post(`/api/research/${id}/${sub}`), sub === "retry" ? "Restarted." : "Deleted.");
      throw new CliError("research [new|show|retry|delete]");
    }
    case "reports": {
      const account = flags.trader ? await resolveTrader(client, flags.trader) : "all";
      const page = await client.get(`/api/arena/reports?account=${account}&limit=${Number(flags.limit) || 10}`);
      return out(page, (p) => table(p.reports, [["ID", (r) => r.id], ["TIME", (r) => r.at], ["TRADER", (r) => short(r.account?.name, 22)], ["VIEW", (r) => r.sentiment ?? ""], ["TITLE", (r) => short(r.title, 50)]]));
    }
    case "report": {
      const page = await client.get(`/api/arena/reports?q=${encodeURIComponent(rest[0] ?? "")}&limit=50`);
      const report = page.reports.find((entry) => entry.id === rest[0]) ?? page.reports[0];
      if (!report) throw new CliError(`No report ${rest[0]}.`);
      return out(report, (r) => [`${r.title} (${r.account?.name} · ${r.at})`, "", r.summary, r.marketView ? `\nMarket: ${r.marketView}` : "", ...(r.actions ?? []).map((action) => `- ${action.action} ${action.symbol}: ${action.detail}`), r.risks ? `\nRisks: ${r.risks}` : "", r.nextSteps ? `Next: ${r.nextSteps}` : "", r.body ? `\n${r.body}` : ""].filter((line) => line !== "").join("\n"));
    }
    case "digest": return out(await client.post("/api/arena/digests", { market: flags.market, send: Boolean(flags.send) }), (d) => d.text);
    case "radar": {
      const radar = await client.get("/api/radar");
      return out(radar, (r) => {
        const b = r.breadth ?? {};
        const s = r.sentiment ?? {};
        return [
          `A-shares · data date ${r.date}`,
          `Up ${b.advancers ?? "—"} / down ${b.decliners ?? "—"} / flat ${b.flat ?? "—"} · turnover ${num((b.turnover ?? 0) / 1e8, 0)} 亿`,
          `Limit-up ${s.limitUp ?? "—"} · broken ${s.broken ?? "—"} · limit-down ${s.limitDown ?? "—"} · highest streak ${s.highestBoard ?? "—"}`,
          `Top sectors: ${(r.sectors?.rows ?? []).slice(0, 5).map((row) => `${row.name} ${pct(row.changePct)}`).join(", ")}`,
          `Top concepts: ${(r.concepts?.rows ?? []).slice(0, 5).map((row) => `${row.name} ${pct(row.changePct)}`).join(", ")}`,
          `Dragon-tiger: ${(r.dragonTiger?.rows ?? []).slice(0, 5).map((row) => `${row.name} ${num((row.netBuy ?? 0) / 1e8)}亿`).join(", ")}`,
        ].join("\n");
      });
    }
    case "lhb": return out(await client.get(`/api/market-data/dragon-tiger${flags.symbol ? `?symbol=${encodeURIComponent(flags.symbol)}` : ""}`));
    case "emotion": return out(await client.get("/api/market-data/emotion"));
    case "schedules": {
      const { jobs } = await client.get("/api/arena/schedules");
      return out(jobs, (rows) => table(rows, [["TRADER", (j) => j.accountId], ["RUNNER", (j) => `${j.runner.type} ${j.runner.model ?? j.runner.strategyId ?? ""}`], ["EFFORT", (j) => j.runner.effort ?? ""], ["EVERY", (j) => j.intervalMinutes ? `${j.intervalMinutes}m` : ""], ["STATE", (j) => j.paused ? `paused: ${j.paused.kind}` : j.enabled === false ? "disabled" : j.running ? "running" : "ok"], ["LAST", (j) => j.lastRun ? `${j.lastRun.at} ${j.lastRun.status}` : ""]]));
    }
    case "pools": return out(await client.get("/api/arena/pools"), (r) => table(r.pools, [["POOL", (p) => p.key], ["STATE", (p) => p.paused ? `exhausted until ${p.pausedUntil}` : "ok"], ["TRADERS", (p) => p.traders.length]]));
    case "env": return out(await client.get("/api/env?lang=en"), (r) => table(r.items, [["CHECK", (i) => i.name], ["STATUS", (i) => i.status], ["DETAIL", (i) => short(i.detail, 70)]]));
    case "models": return out(await client.get("/api/agent-models"), (r) => Object.entries(r.agents).filter(([, entry]) => entry.models.length).map(([agent, entry]) => `${agent}: ${entry.models.map((model) => `${model.id}${model.latest ? " (latest)" : ""}`).join(", ")}`).join("\n") + `\ndefault effort: ${r.defaultEffort}`);
    case "skills": {
      const [sub] = rest;
      if (!sub) {
        const library = await client.get("/api/library");
        return out(library.skills, (rows) => table(rows, [["ID", (s) => s.id], ["NAME", (s) => s.name], ["SOURCE", (s) => s.source], ["STATUS", (s) => s.status]]));
      }
      if (sub === "updates") return out(await client.get(`/api/library/updates${flags.force ? "?force=1" : ""}`), (r) => table(r.results ?? [], [["SKILL", (u) => u.skillId], ["CHANGED", (u) => (u.changed ? "yes" : "no")], ["LATEST", (u) => short(u.latest?.message ?? u.latest?.sha, 60)]]));
      if (sub === "import") {
        const body = flags.git ? { kind: "git", url: flags.git, subdir: flags.subdir } : flags.folder ? { kind: "folder", path: path.resolve(flags.folder) } : flags.claude ? { kind: "claude", name: flags.claude } : null;
        if (!body) throw new CliError("skills import --git URL [--subdir D] | --folder PATH | --claude NAME");
        return out(await client.post("/api/library/import", { ...body, markets: typeof flags.markets === "string" ? flags.markets.split(",") : ["A", "HK", "US"] }), (r) => `Imported ${r.name} (${r.id}).`);
      }
      throw new CliError("skills [updates|import]");
    }
    case "settings": return out(await client.get("/api/workbench/settings"));
    case "api": {
      const [method, route, json] = rest;
      if (!route?.startsWith("/")) throw new CliError("api GET|POST /path ['{json}']");
      return out(method?.toUpperCase() === "POST" ? await client.post(route, json ? JSON.parse(json) : {}) : await client.get(route));
    }
    case "install": return out(await install(typeof flags.dir === "string" ? flags.dir : undefined), (r) => `Installed ${r.path}${r.onPath ? "" : `\n${r.dir} is not on your PATH; add it, e.g. export PATH="${r.dir}:$PATH"`}`);
    default: throw new CliError(`Unknown command "${command}". Run: market-pulse help`);
  }
}

async function install(dir) {
  const self = fileURLToPath(import.meta.url);
  const windows = process.platform === "win32";
  const target = dir ?? (windows ? path.join(os.homedir(), "AppData", "Local", "Microsoft", "WindowsApps") : path.join(os.homedir(), ".local", "bin"));
  await mkdir(target, { recursive: true });
  const file = path.join(target, windows ? "market-pulse.cmd" : "market-pulse");
  if (windows) await writeFile(file, `@echo off\r\n"${process.execPath}" "${self}" %*\r\n`, "utf8");
  else {
    if (existsSync(file)) await unlink(file);
    // A small wrapper (not a symlink) pins the node that installed it, so it works without node on PATH.
    await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${self}" "$@"\n`, "utf8");
    await chmod(file, 0o755);
  }
  const onPath = (process.env.PATH ?? "").split(path.delimiter).includes(target);
  return { path: file, dir: target, onPath };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`market-pulse: ${error instanceof CliError ? error.message : error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
