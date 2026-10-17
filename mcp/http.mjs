import { inDateRange, matchesText, pageParams, paginate } from "./paging.mjs";
import { getPaperService } from "./paper.mjs";
import { createMatcher, deliverDigest, getArena } from "./arena.mjs";
import { createScheduler } from "./scheduler.mjs";
import { createTraderStrategyStore, rollbackTraderStrategy, traderStrategyId } from "./trader-strategies.mjs";
import { loadLibrary, skillBody, starterStrategyCode, templateDefaults } from "./skill-library.mjs";
import { checkUpdates, importSkill, listClaudeSkills, removeImported, updateImported } from "./skill-import.mjs";
import { dragonTiger, dragonTigerSeats, limitPool, marketRadar, shortlineEmotion } from "./market-data.mjs";
import { checkEnvironment } from "./env-check.mjs";
import { agentModels } from "./agent-models.mjs";
import { getMarketSession } from "./market-rules.mjs";
import { readServiceStatus } from "./service.mjs";
import { describeStrategy, loadStrategies } from "./strategies/index.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildEmptyHtml,
  buildReportHtml,
  createMarketReport,
  getReportPort,
  scanMarket,
  loadPreferences,
  loadReport,
  savePreferences,
} from "./core.mjs";
import {
  enrichReport,
  listDecisions,
  recordDecision,
  reviewDecision,
  syncOfficialEvidence,
  ingestOfficialRecords,
} from "./workspace.mjs";
import { queryEvidence } from "./foundation.mjs";
import { projectCatalystCalendar } from "./research.mjs";

const assets = new Map([
  ["/assets/vendor/LICENSE-lightweight-charts", ["vendor/LICENSE-lightweight-charts", "text/plain; charset=utf-8"]],
]);
const assetRoot = new URL("../assets/", import.meta.url);
const jsonType = "application/json; charset=utf-8";
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function respond(response, status, data, type = jsonType) {
  const body = type === jsonType ? JSON.stringify(data) : data;
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": csp,
    "Referrer-Policy": "no-referrer",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function bodyJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""))
    throw Object.assign(new Error("JSON content type required"), {
      status: 415,
    });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1000000)
      throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("JSON object required");
  return body;
}

// `arena` lets tests serve a seeded arena; the workbench always serves the real one (no demo mode).
export function startDashboard({ port = getReportPort(), arena: arenaOption = null, matcher: runMatcher = true, scheduler: runScheduler = false } = {}) {
  let refreshPromise = null;
  const arenaReady = Promise.resolve(arenaOption ?? getArena());
  const dashboardCaller = { client: "dashboard" };
  const readPreferences = () => loadPreferences();
  // Unattended matching: every dashboard / MCP process runs a matcher; the lease elects one leader.
  const matcherReady = runMatcher ? arenaReady.then((arena) => createMatcher({
    arena, getPreferences: readPreferences,
    onError: (error) => console.error(`Arena matcher: ${error.message}`),
  }).start()).catch(() => null) : Promise.resolve(null);
  const matcherStatus = async (arena) => ({ ...(await arena.matcherStatus()), local: (await matcherReady)?.status() ?? null });
  // The background matcher re-marks every active account each tick during sessions. While it is
  // ticking, dashboard reads serve the stored state at once instead of fetching quotes per request.
  const needsSync = async (arena) => {
    const status = await arena.matcherStatus().catch(() => null);
    return !(status?.lastTickAt && Date.now() - Date.parse(status.lastTickAt) < 180000);
  };
  // Schedules are files, so any dashboard can edit them; only the service (runScheduler) runs them on time.
  const schedulerReady = arenaReady.then((arena) => {
    const scheduler = createScheduler({ arena, onError: (error) => console.error(`Arena scheduler: ${error.message}`) });
    return runScheduler ? scheduler.start() : scheduler;
  });
  let refreshedAt = 0;
  let envCache = null;
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(host))
        return respond(response, 403, { error: "Invalid local host" });
      const origin = request.headers.origin;
      if (origin && !allowedHosts.some((value) => origin === `http://${value}`))
        return respond(response, 403, { error: "Cross-origin access denied" });
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET") {
        if (url.pathname === "/api/arena/leaderboard") {
          const arena = await arenaReady;
          return respond(response, 200, { ...(await arena.leaderboard({
            market: url.searchParams.get("market") || undefined,
            competition: url.searchParams.get("competition") || undefined,
            includeArchived: url.searchParams.get("archived") === "1",
            sync: url.searchParams.get("sync") === "1" || await needsSync(arena),
          })), matcher: await matcherStatus(arena), service: await readServiceStatus(arena.root) });
        }
        if (url.pathname === "/api/arena/matcher") return respond(response, 200, await matcherStatus(await arenaReady));
        // Every account's round reports, newest first, paged and filtered for the report centre.
        if (url.pathname === "/api/arena/reports") {
          const arena = await arenaReady;
          const paging = pageParams(url.searchParams);
          const market = url.searchParams.get("market"), accountId = url.searchParams.get("account"), sentiment = url.searchParams.get("sentiment");
          const summaries = await arena.listAccounts({ status: url.searchParams.get("archived") === "1" ? "all" : "active" });
          const rows = [];
          for (const summary of summaries) {
            const account = await arena.getAccount(summary.id, { sync: false, limit: 500 });
            const owner = { id: account.id, name: account.name, model: account.model, market: account.market, currency: account.currency, agent: account.agent };
            for (const report of account.reports ?? []) rows.push({ ...report, account: owner });
          }
          rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
          const filtered = rows.filter((report) => (!market || market === "all" || report.account.market === market)
            && (!accountId || accountId === "all" || report.account.id === accountId)
            && (!sentiment || sentiment === "all" || report.sentiment === sentiment)
            && inDateRange(report.at, paging)
            && matchesText(paging.q, report.title, report.summary, report.marketView, report.account.name, report.account.model, ...(report.actions ?? []).map((entry) => entry.symbol), ...(report.picks ?? []).map((entry) => entry.symbol)));
          const page = paginate(filtered, paging);
          const accounts = [...new Map(rows.map((report) => [report.account.id, report.account])).values()];
          return respond(response, 200, { reports: page.items, total: page.total, offset: page.offset, limit: page.limit, all: rows.length, accounts });
        }
        if (url.pathname === "/api/arena/schedules") {
          const arena = await arenaReady;
          const scheduler = await schedulerReady;
          const { strategies, errors, dir } = await loadStrategies();
          return respond(response, 200, {
            jobs: await scheduler.listJobs(), strategies: [...strategies.values()].map(describeStrategy), strategyErrors: errors, strategyDir: dir,
            service: await readServiceStatus(arena.root), scheduler: scheduler.status(),
          });
        }
        const runs = url.pathname.match(/^\/api\/arena\/runs\/(acc_[a-f0-9]{12})$/);
        if (runs) {
          const paging = pageParams(url.searchParams);
          const status = url.searchParams.get("status");
          const rows = (await (await schedulerReady).listRuns({ accountId: runs[1], limit: 300 })).filter((run) => (!status || run.status === status) && inDateRange(run.startedAt ?? run.at, paging));
          const page = paginate(rows, paging);
          return respond(response, 200, { runs: page.items, total: page.total, offset: page.offset, limit: page.limit });
        }
        if (url.pathname === "/api/arena/digests") {
          const paging = pageParams(url.searchParams);
          const market = url.searchParams.get("market");
          const webhook = (await readPreferences())?.digestWebhook ?? null;
          const rows = (await (await arenaReady).listDigests({ limit: 400 })).filter((digest) => (!market || market === "all" || !digest.market || digest.market === market)
            && inDateRange(digest.at, paging) && matchesText(paging.q, digest.title, digest.headline, ...(digest.accounts ?? []).map((row) => row.name)));
          const page = paginate(rows, paging);
          return respond(response, 200, { digests: page.items, total: page.total, offset: page.offset, limit: page.limit, webhook: webhook ? { format: webhook.format, enabled: webhook.enabled, host: new URL(webhook.url).host } : null });
        }
        const history = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/history$/);
        if (history) {
          const paging = pageParams(url.searchParams);
          const side = ["BUY", "SELL"].includes(url.searchParams.get("side")) ? url.searchParams.get("side") : undefined;
          return respond(response, 200, await (await arenaReady).history(history[1], url.searchParams.get("kind"), { ...paging, side, type: url.searchParams.get("type") || undefined, symbol: url.searchParams.get("symbol") || undefined }));
        }
        if (url.pathname === "/api/arena/pools") return respond(response, 200, { pools: await (await schedulerReady).listPools() });
        if (url.pathname === "/api/arena/usage") return respond(response, 200, await (await schedulerReady).usage({ since: url.searchParams.get("since") || undefined }));
        const runEvents = url.pathname.match(/^\/api\/arena\/run-events\/(run_[a-f0-9]{12})$/);
        if (runEvents) return respond(response, 200, await (await schedulerReady).runEvents(runEvents[1]));
        // Live run events for this process's scheduler (the service); other views poll run-events.
        if (url.pathname === "/api/events") {
          const scheduler = await schedulerReady;
          response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "keep-alive" });
          response.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString(), scheduler: scheduler.status().role })}\n\n`);
          const unsubscribe = scheduler.subscribe((message) => response.write(`event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`));
          const heartbeat = setInterval(() => response.write(": ping\n\n"), 20000);
          request.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
          return;
        }
        if (url.pathname === "/api/markets") {
          const at = new Date().toISOString();
          // Next regular open for markets that are not trading now (scan forward minute-by-hour).
          const nextOpen = (market) => { for (let hour = 0; hour <= 24 * 10; hour += 0.25) { const probe = new Date(Date.now() + hour * 3600000).toISOString(); if (getMarketSession(market, probe).status === "open") return probe; } return null; };
          return respond(response, 200, Object.fromEntries(["A", "HK", "US"].map((market) => { const session = getMarketSession(market, at); return [market, { status: session.status, date: session.date, minute: session.minute, verified: session.verified, nextOpenAt: session.status === "open" ? null : nextOpen(market) }]; })));
        }
        if (url.pathname === "/api/library") return respond(response, 200, await loadLibrary());
        if (url.pathname === "/api/library/updates") return respond(response, 200, await checkUpdates({ force: url.searchParams.get("force") === "1" }));
        if (url.pathname === "/api/library/claude-skills") return respond(response, 200, { skills: await listClaudeSkills() });
        // Market-wide real data for the radar page.
        if (url.pathname === "/api/radar") return respond(response, 200, await marketRadar({ scan: scanMarket }));
        if (url.pathname === "/api/market-data/emotion") return respond(response, 200, await shortlineEmotion({ date: url.searchParams.get("date") || undefined }));
        if (url.pathname === "/api/market-data/dragon-tiger") {
          const symbol = url.searchParams.get("symbol");
          return respond(response, 200, symbol ? await dragonTigerSeats(symbol, { date: url.searchParams.get("date") || undefined }) : await dragonTiger({ date: url.searchParams.get("date") || undefined, limit: 100 }));
        }
        if (url.pathname === "/api/market-data/limit-pool") return respond(response, 200, await limitPool(url.searchParams.get("kind") || "up", { date: url.searchParams.get("date") || undefined }));
        // Orders waiting for the owner across every trader, for the home page.
        if (url.pathname === "/api/approvals") {
          const arena = await arenaReady;
          const rows = [];
          for (const summary of await arena.listAccounts({ status: "active" })) {
            const account = await arena.getAccount(summary.id, { sync: false, limit: 1 });
            for (const approval of account.approvals ?? []) if (approval.status === "pending") rows.push({ ...approval, account: { id: account.id, name: account.name, market: account.market, currency: account.currency, agent: account.agent, model: account.model } });
          }
          return respond(response, 200, { approvals: rows.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)) });
        }
        if (url.pathname === "/api/research") return respond(response, 200, { tasks: await (await schedulerReady).listResearch({ limit: Number(url.searchParams.get("limit")) || 50 }) });
        const reconcileRead = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/reconcile$/);
        if (reconcileRead) return respond(response, 200, await (await arenaReady).reconcile(reconcileRead[1]));
        if (url.pathname === "/api/agent-models") return respond(response, 200, await agentModels());
        if (url.pathname === "/api/env") {
          const language = url.searchParams.get("lang") === "en" ? "en" : "zh";
          if (!envCache || envCache.language !== language || Date.now() - envCache.at > 60000 || url.searchParams.get("fresh") === "1") envCache = { at: Date.now(), language, value: await checkEnvironment({ arena: await arenaReady, scheduler: await schedulerReady, language }) };
          return respond(response, 200, { ...envCache.value });
        }
        const librarySkill = url.pathname.match(/^\/api\/library\/(skills|strategies)\/([a-z0-9-]{2,60})$/);
        if (librarySkill) return respond(response, 200, librarySkill[1] === "skills" ? { id: librarySkill[2], body: await skillBody(librarySkill[2]) } : { id: librarySkill[2], code: await starterStrategyCode(librarySkill[2]) });
        const strategyRead = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/strategy$/);
        if (strategyRead) {
          const store = createTraderStrategyStore((await arenaReady).root);
          const version = Number(url.searchParams.get("version")) || undefined;
          const [meta, current] = await Promise.all([store.meta(strategyRead[1]), store.code(strategyRead[1], version).catch(() => null)]);
          return respond(response, 200, { strategyId: traderStrategyId(strategyRead[1]), ...meta, code: current?.code ?? null, version: current?.version ?? null });
        }
        const promptPreview = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/prompt-preview$/);
        if (promptPreview) return respond(response, 200, await (await schedulerReady).previewPrompt(promptPreview[1]));
        const settingsRead = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/settings$/);
        if (settingsRead) return respond(response, 200, { ...(await (await arenaReady).getSettings(settingsRead[1])) });
        if (url.pathname === "/api/workbench/settings") return respond(response, 200, { ...(await (await arenaReady).workbenchSettings()) });
        const arenaAccount = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})$/);
        if (arenaAccount) {
          const arena = await arenaReady;
          return respond(response, 200, { ...(await arena.getAccount(arenaAccount[1], { limit: 200, sync: url.searchParams.get("sync") === "1" || await needsSync(arena) })) });
        }
        if (url.pathname === "/api/paper/status") return respond(response, 200, await getPaperService().status());
        if (url.pathname === "/api/evidence") {
          const evidence = await queryEvidence({
            symbols: url.searchParams.get("symbol") ? [url.searchParams.get("symbol")] : undefined,
            limit: 500,
          });
          const calendar = projectCatalystCalendar(evidence.items);
          const warnings = [...calendar.warnings];
          if (evidence.totalMatched > evidence.returned) warnings.push("Evidence scan truncated; calendar may omit events or revisions.");
          return respond(response, 200, { ...evidence, events: calendar.events, eventWarnings: warnings });
        }
        if (url.pathname === "/health")
          return respond(response, 200, {
            ok: true,
            service: "hrouter-market-pulse",
            version: typeof __HROUTER_VERSION__ === "string" ? __HROUTER_VERSION__ : "development",
          });
        if (assets.has(url.pathname)) {
          const [name, type] = assets.get(url.pathname);
          return respond(
            response,
            200,
            await readFile(fileURLToPath(new URL(name, assetRoot))),
            type,
          );
        }
        if (url.pathname === "/api/preferences")
          return respond(
            response,
            200,
            await loadPreferences(),
          );
        if (url.pathname === "/api/decisions")
          return respond(
            response,
            200,
            await listDecisions(),
          );
        if (
          url.pathname === "/api/latest" ||
          /^\/api\/runs\/[A-Za-z0-9_-]+$/.test(url.pathname)
        ) {
          const id =
            url.pathname === "/api/latest"
              ? "latest"
              : url.pathname.split("/").at(-1);
          return respond(
            response,
            200,
            JSON.parse(await loadReport(id, "json")),
          );
        }
        // Workbench UI bundle (Vite build): only known file types under /assets/app/, no traversal.
        if (url.pathname.startsWith("/assets/app/")) {
          const rest = url.pathname.slice("/assets/app/".length);
          const types = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", woff2: "font/woff2", woff: "font/woff", svg: "image/svg+xml", png: "image/png", txt: "text/plain; charset=utf-8" };
          const extension = rest.split(".").at(-1);
          if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\.[a-z0-9]+$/.test(rest) || rest.includes("..") || !types[extension]) return respond(response, 404, { error: "Not found" });
          try {
            const body = await readFile(fileURLToPath(new URL(`app/${rest}`, assetRoot)));
            response.writeHead(200, { "Content-Type": types[extension], "Cache-Control": rest.startsWith("files/") ? "public, max-age=31536000, immutable" : "no-cache", "X-Content-Type-Options": "nosniff", "Content-Length": body.length });
            return response.end(body);
          } catch { return respond(response, 404, { error: "Not found" }); }
        }
        // Client-side routes of the workbench all get the same HTML shell.
        const workbenchRoute = /^\/(traders(\/acc_[a-f0-9]{12})?|arena|market|radar|research|reports|strategies|skills|schedule|settings)\/?$/.test(url.pathname);
        if (
          url.pathname === "/" || workbenchRoute ||
          /^\/runs\/[A-Za-z0-9_-]+$/.test(url.pathname)
        ) {
          try {
            const report = JSON.parse(
                  await loadReport(
                    url.pathname === "/" || workbenchRoute
                      ? "latest"
                      : url.pathname.split("/").at(-1),
                    "json",
                  ),
                );
            return respond(
              response,
              200,
              buildReportHtml(report),
              "text/html; charset=utf-8",
            );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            return respond(
              response,
              200,
              buildEmptyHtml(),
              "text/html; charset=utf-8",
            );
          }
        }
      }
      if (request.method === "POST") {
        const body = await bodyJson(request);
        if (url.pathname.startsWith("/api/arena/")) {
          const arena = await arenaReady;
          if (url.pathname === "/api/arena/accounts") {
            const defaults = await templateDefaults(body.template, body);
            const account = await arena.createAccount({ ...body, ...defaults, agentLabel: body.agentLabel || undefined }, dashboardCaller);
            {
              const scheduler = await schedulerReady;
              const interval = Number(body.reviewMinutes) || defaults.cadence?.reviewMinutes || (await readPreferences())?.defaultAgentIntervalMinutes || 10;
              let schedule = { created: false };
              if (body.runner && body.runner.type !== "strategy") {
                // The owner chose the agent (and backup) in the new-trader flow.
                schedule = { created: true, job: await scheduler.upsertJob(account.id, { intervalMinutes: interval, times: [], mode: "director", runner: { timeoutMinutes: 20, ...body.runner }, ...(body.backup ? { backup: body.backup } : {}) }) };
              } else if (defaults.builtinStrategy || body.runner?.type === "strategy") {
                const strategyId = body.runner?.strategyId ?? defaults.starterStrategy;
                schedule = { created: true, job: await scheduler.upsertJob(account.id, { intervalMinutes: defaults.cadence?.strategyMinutes ?? 5, times: [], runner: { type: "strategy", strategyId, params: body.runner?.params ?? {}, timeoutMinutes: 5 } }) };
              } else schedule = await scheduler.ensureDefaultSchedule(account.id, interval).catch((error) => ({ created: false, reason: error.message }));
              account.schedule = schedule.created ? { intervalMinutes: schedule.job.intervalMinutes, runner: schedule.job.runner.type, mode: schedule.job.mode ?? null } : null;
            }
            return respond(response, 201, account);
          }
          if (url.pathname === "/api/arena/sync")
            return respond(response, 200, await arena.sync(Array.isArray(body.accountIds) ? body.accountIds : undefined, { force: true }));
          if (url.pathname === "/api/arena/digests") {
            const market = ["A", "HK", "US"].includes(body.market) ? body.market : null;
            const prefs = await readPreferences();
            let digest = await arena.generateDigest({ market, trigger: "manual", language: prefs?.language });
            if (body.send) {
              if (!prefs?.digestWebhook?.url) return respond(response, 409, { error: "No digest webhook configured in preferences." });
              digest = await arena.recordDigestDelivery(digest.id, await deliverDigest(digest, { ...prefs.digestWebhook, enabled: true }, { now: arena.now }));
            }
            return respond(response, 201, digest);
          }
          const rollback = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/strategy\/rollback$/);
          if (rollback) return respond(response, 200, await rollbackTraderStrategy({ arena, scheduler: await schedulerReady, store: createTraderStrategyStore(arena.root), accountId: rollback[1], version: body.version, caller: dashboardCaller }));
          const pool = url.pathname.match(/^\/api\/arena\/pools\/([a-z0-9:._/-]{1,200})\/clear$/);
          if (pool) return respond(response, 200, await (await schedulerReady).clearPool(decodeURIComponent(pool[1])));
          const instruction = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/instructions(?:\/(ins_[a-f0-9]{12})\/revoke)?$/);
          if (instruction) return respond(response, 200, instruction[2]
            ? await arena.revokeInstruction(instruction[1], instruction[2], dashboardCaller)
            : await arena.addInstruction(instruction[1], { text: body.text, days: body.days ?? 3 }, dashboardCaller));
          const schedule = url.pathname.match(/^\/api\/arena\/schedules\/(acc_[a-f0-9]{12})(\/delete|\/run|\/resume|\/cadence)?$/);
          if (schedule) {
            const scheduler = await schedulerReady;
            if (schedule[2] === "/delete") return respond(response, 200, await scheduler.deleteJob(schedule[1]));
            if (schedule[2] === "/resume") return respond(response, 200, await scheduler.resumeJob(schedule[1]));
            if (schedule[2] === "/cadence") return respond(response, 200, await scheduler.setCadence(schedule[1], body, dashboardCaller));
            if (schedule[2] === "/run") {
              const started = await scheduler.runNow(schedule[1], { lane: body.lane === "strategy" ? "strategy" : "primary" });
              started.wait?.().catch((error) => console.error(`Arena run: ${error.message}`));
              return respond(response, 202, { status: started.status, reason: started.reason ?? null });
            }
            return respond(response, 200, await scheduler.upsertJob(schedule[1], body));
          }
          const approval = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/approvals\/(apr_[a-f0-9]{12})$/);
          if (approval) return respond(response, 200, await arena.resolveApproval(approval[1], approval[2], { approve: body.approve === true, note: body.note }, dashboardCaller));
          const message = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/messages$/);
          if (message) {
            const question = await arena.askTrader(message[1], { text: body.text }, dashboardCaller);
            // Answer right away when the trader is free; otherwise the scheduler picks it up when it is.
            const started = await (await schedulerReady).runNow(message[1], { lane: "ask", messageId: question.id }).catch((error) => ({ status: "queued", reason: error.message }));
            started.wait?.().catch((error) => console.error(`Arena question: ${error.message}`));
            return respond(response, 201, { message: question, status: started.status, reason: started.reason ?? null });
          }
          const rule = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/rules(?:\/(rul_[a-f0-9]{12})\/revoke)?$/);
          if (rule) return respond(response, 200, rule[2] ? await arena.revokeRule(rule[1], rule[2], dashboardCaller) : await arena.addRule(rule[1], { text: body.text }, dashboardCaller));
          const skillOverride = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/skills\/([a-z0-9-]{2,60})$/);
          if (skillOverride) return respond(response, 200, await arena.setSkillOverride(skillOverride[1], skillOverride[2], body, dashboardCaller));
          const settings = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})\/(limits|prompt|locks|requests\/(req_[a-f0-9]{12}))$/);
          if (settings) {
            const [, id, action, requestId] = settings;
            if (action === "limits") return respond(response, 200, await arena.setLimits({ accountId: id, limits: body.limits, reason: body.reason }, dashboardCaller));
            if (action === "prompt") return respond(response, 200, await arena.setPrompt({ accountId: id, prompt: body.prompt, reason: body.reason }, dashboardCaller));
            if (action === "locks") return respond(response, 200, await arena.setLocks(id, body.locks, dashboardCaller));
            return respond(response, 200, await arena.resolveRequest(id, requestId, body, dashboardCaller));
          }
          const update = url.pathname.match(/^\/api\/arena\/accounts\/(acc_[a-f0-9]{12})(\/delete)?$/);
          if (update) return respond(response, 200, update[2] ? await arena.deleteAccount(update[1]) : await arena.updateAccount(update[1], body));
          return respond(response, 404, { error: "Unknown arena action" });
        }
        if (url.pathname === "/api/research") {
          const scheduler = await schedulerReady;
          const task = await scheduler.createResearch(body);
          const started = await scheduler.startResearch(task.id);
          started.wait?.().catch((error) => console.error(`Research: ${error.message}`));
          return respond(response, 201, task);
        }
        const research = url.pathname.match(/^\/api\/research\/(res_[a-f0-9]{12})\/(retry|delete)$/);
        if (research) {
          const scheduler = await schedulerReady;
          if (research[2] === "delete") return respond(response, 200, await scheduler.deleteResearch(research[1]));
          const task = await scheduler.retryResearch(research[1]);
          (await scheduler.startResearch(task.id)).wait?.().catch((error) => console.error(`Research: ${error.message}`));
          return respond(response, 200, task);
        }
        if (url.pathname === "/api/library/import") return respond(response, 201, await importSkill({ kind: body.kind, path: body.path, url: body.url, name: body.name, subdir: body.subdir || undefined, markets: body.markets }));
        const imported = url.pathname.match(/^\/api\/library\/imported\/(imp-[a-z0-9-]{2,56})\/(update|delete)$/);
        if (imported) return respond(response, 200, imported[2] === "delete" ? await removeImported(imported[1]) : await updateImported(imported[1]));
        if (url.pathname.startsWith("/api/workbench")) {
          const arena = await arenaReady;
          if (url.pathname === "/api/workbench/fees") return respond(response, 200, await arena.setFees({ market: body.market, fees: body.fees, reason: body.reason }, dashboardCaller));
          if (url.pathname === "/api/workbench/prompts") return respond(response, 200, await arena.setWorkbenchPrompt({ scope: body.scope, prompt: body.prompt, reason: body.reason }, dashboardCaller));
          if (url.pathname === "/api/workbench/settings") return respond(response, 200, await arena.updateWorkbench(body, dashboardCaller));
          return respond(response, 404, { error: "Unknown workbench action" });
        }
        if (url.pathname.startsWith("/api/paper/")) {
          const actions = { connect: "accounts", refresh: "refresh", policy: "savePolicy", evaluate: "evaluate", submit: "submit", cancel: "cancel" };
          const action = actions[url.pathname.slice("/api/paper/".length)];
          if (!action) return respond(response, 404, { error: "Unknown paper action" });
          return respond(response, 200, await getPaperService()[action](action === "accounts" ? body.market : body));
        }
        if (url.pathname === "/api/preferences") {
          if (body.language && !["zh-CN", "en"].includes(body.language))
            throw new Error("Invalid language");
          if (
            body.watchlist &&
            (!Array.isArray(body.watchlist) || body.watchlist.length > 50)
          )
            throw new Error("Watchlist must contain at most 50 symbols");
          const fields = [
            "language",
            "watchlist",
            "positions",
            "benchmarkSymbols",
            "sectorMap",
            "alertRules",
            "monitorIntervalSeconds",
            "calendarOverrides",
            "managedAccountId",
            "defaultAgentIntervalMinutes",
            "digestWebhook",
          ];
          const selected = Object.fromEntries(
            fields
              .filter((key) => body[key] !== undefined)
              .map((key) => [key, body[key]]),
          );
          return respond(response, 200, await savePreferences(selected));
        }
        if (url.pathname === "/api/refresh") {
          const phase = [
            "premarket",
            "intraday",
            "postmarket",
            "research",
          ].includes(body.phase)
            ? body.phase
            : "intraday";
          if (refreshPromise)
            return respond(response, 200, await refreshPromise);
          if (Date.now() - refreshedAt < 15000)
            return respond(response, 429, {
              error: "Refresh cooldown: 15 seconds",
              retryAfter: 15,
            });
          if (
            body.symbols &&
            (!Array.isArray(body.symbols) || body.symbols.length > 20)
          )
            throw new Error("At most 20 symbols per report");
          refreshPromise = createMarketReport({
            phase,
            symbols: body.symbols,
            includeNews: body.includeNews !== false,
            enrichReport,
          });
          try {
            const report = await refreshPromise;
            refreshedAt = Date.now();
            return respond(response, 200, report);
          } finally {
            refreshPromise = null;
          }
        }
        if (url.pathname === "/api/decisions") {
          return respond(response, 201, await recordDecision(body));
        }
        const review = url.pathname.match(
          /^\/api\/decisions\/([A-Za-z0-9_-]+)\/review$/,
        );
        if (review) {
          return respond(response, 200, await reviewDecision(review[1], body));
        }
        if (url.pathname === "/api/official/sync")
          return respond(
            response,
            200,
            await syncOfficialEvidence(body),
          );
        if (url.pathname === "/api/evidence")
          return respond(
            response,
            201,
            await ingestOfficialRecords(body),
          );
      }
      return respond(response, 404, { error: "Not found" });
    } catch (error) {
      return respond(
        response,
        error.code === "ENOENT" ? 404 : (error.status ?? 400),
        { error: error.code === "ENOENT" ? "No report yet" : error.message },
      );
    }
  });
  server.on("close", () => {
    matcherReady.then((matcher) => matcher?.stop()).catch(() => {});
    schedulerReady.then((scheduler) => scheduler?.stop()).catch(() => {});
  });
  server.arena = arenaReady;
  server.scheduler = schedulerReady;
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.ready = new Promise((resolve, reject) => {
    let attempts = 0;
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE" && attempts++ < 10) {
        port = port >= 65535 ? 8787 : port + 1;
        process.env.HROUTER_REPORT_PORT = String(port);
        server.listen(port, "127.0.0.1");
      } else reject(error);
    });
    server.once("listening", () => {
      port = server.address().port;
      process.env.HROUTER_REPORT_PORT = String(port);
      console.error(
        `Hrouter Market Pulse: http://127.0.0.1:${port}/`,
      );
      resolve(server);
    });
    server.listen(port, "127.0.0.1");
  });
  return server;
}
