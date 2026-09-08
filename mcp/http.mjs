import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  buildEmptyHtml,
  buildReportHtml,
  createMarketReport,
  getReportPort,
  loadPreferences,
  loadReport,
  savePreferences,
  sanitizePreferences,
} from "./core.mjs";
import {
  enrichReport,
  listDecisions,
  recordDecision,
  reviewDecision,
  syncOfficialEvidence,
  ingestOfficialRecords,
} from "./workspace.mjs";
import { makeDemoReport, demoPreferences, demoDecisions } from "./demo.mjs";
import { queryEvidence } from "./foundation.mjs";

const assets = new Map([
  ["/assets/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
  ["/assets/dashboard.css", ["dashboard.css", "text/css; charset=utf-8"]],
  [
    "/assets/vendor/lightweight-charts.js",
    ["vendor/lightweight-charts.js", "text/javascript; charset=utf-8"],
  ],
  [
    "/assets/vendor/lucide.js",
    ["vendor/lucide.js", "text/javascript; charset=utf-8"],
  ],
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

export function startDashboard({ port = getReportPort(), demo = false } = {}) {
  let demoReport = demo ? makeDemoReport() : null;
  let preferences = demo ? structuredClone(demoPreferences) : null;
  let decisions = demo ? structuredClone(demoDecisions) : null;
  let refreshPromise = null;
  let refreshedAt = 0;
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
        if (url.pathname === "/api/evidence")
          return respond(
            response,
            200,
            demo
              ? { items: demoReport.evidence ?? [] }
              : await queryEvidence({
                  symbols: url.searchParams.get("symbol")
                    ? [url.searchParams.get("symbol")]
                    : undefined,
                  limit: 500,
                }),
          );
        if (url.pathname === "/health")
          return respond(response, 200, {
            ok: true,
            service: "hrouter-market-pulse",
            version: "1.1.0",
            demo,
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
            demo ? preferences : await loadPreferences(),
          );
        if (url.pathname === "/api/decisions")
          return respond(
            response,
            200,
            demo ? { decisions } : await listDecisions(),
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
            demo ? demoReport : JSON.parse(await loadReport(id, "json")),
          );
        }
        if (
          url.pathname === "/" ||
          /^\/runs\/[A-Za-z0-9_-]+$/.test(url.pathname)
        ) {
          try {
            const report = demo
              ? demoReport
              : JSON.parse(
                  await loadReport(
                    url.pathname === "/"
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
          ];
          const selected = Object.fromEntries(
            fields
              .filter((key) => body[key] !== undefined)
              .map((key) => [key, body[key]]),
          );
          if (demo) {
            preferences = sanitizePreferences(selected, preferences);
            demoReport.language = preferences.language;
            return respond(response, 200, preferences);
          }
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
          if (demo) {
            demoReport = {
              ...makeDemoReport(),
              language: preferences.language,
              phase,
              demo: true,
            };
            return respond(response, 200, demoReport);
          }
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
          if (demo) {
            if (!body.symbol || !body.thesis)
              throw new Error("Symbol and thesis required");
            const entry = {
              ...body,
              id: `demo_${randomUUID()}`,
              createdAt: new Date().toISOString(),
              reviews: [],
              demo: true,
            };
            decisions.unshift(entry);
            demoReport.decisions = decisions;
            return respond(response, 201, entry);
          }
          return respond(response, 201, await recordDecision(body));
        }
        const review = url.pathname.match(
          /^\/api\/decisions\/([A-Za-z0-9_-]+)\/review$/,
        );
        if (review) {
          if (demo) {
            const entry = decisions.find((item) => item.id === review[1]);
            if (!entry)
              return respond(response, 404, { error: "Decision not found" });
            entry.reviews ??= [];
            entry.reviews.push({
              ...body,
              reviewedAt: new Date().toISOString(),
            });
            return respond(response, 200, entry);
          }
          return respond(response, 200, await reviewDecision(review[1], body));
        }
        if (url.pathname === "/api/official/sync")
          return respond(
            response,
            200,
            demo
              ? { demo: true, results: [] }
              : await syncOfficialEvidence(body),
          );
        if (url.pathname === "/api/evidence")
          return respond(
            response,
            201,
            demo
              ? { demo: true, inserted: 0 }
              : await ingestOfficialRecords(body),
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
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(port, "127.0.0.1", () =>
    console.error(
      `Hrouter Market Pulse: http://127.0.0.1:${port}/ ${demo ? "(demo)" : ""}`,
    ),
  );
  return server;
}
