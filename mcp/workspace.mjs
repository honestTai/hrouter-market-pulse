import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getStorageDir,
  getQuote,
  loadPreferences,
  normalizeSymbol,
  marketFromSymbol,
  calculatePositionBudget,
} from "./core.mjs";
import {
  ingestEvidence,
  queryEvidence,
  registerDataProvider,
  queryPredictionLedger,
} from "./foundation.mjs";

let journalQueue = Promise.resolve();
const cache = new Map();
const benchmarkDefaults = { A: "000001.SS", HK: "^HSI", US: "^GSPC" };
const cleanText = (value, limit = 2000) =>
  String(value ?? "")
    .trim()
    .slice(0, limit);
const finite = (value) =>
  value !== null && value !== "" && Number.isFinite(Number(value))
    ? Number(value)
    : null;

async function readStore(name, fallback = []) {
  try {
    return JSON.parse(await readFile(path.join(getStorageDir(), name), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeStore(name, data) {
  const target = path.join(getStorageDir(), name);
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2));
  await rename(temp, target);
}

export async function listDecisions({ symbol, limit = 200 } = {}) {
  const items = await readStore("decisions.json");
  const normalized = symbol ? normalizeSymbol(symbol) : null;
  return {
    decisions: items
      .filter((item) => !normalized || item.symbol === normalized)
      .slice(-Math.min(500, limit))
      .reverse(),
  };
}

export async function recordDecision(input) {
  const symbol = normalizeSymbol(input.symbol);
  const state = input.state ?? "watch";
  if (
    !["watch", "candidate", "hold", "review-exit", "inactive"].includes(state)
  )
    throw new Error("Invalid decision state");
  const thesis = cleanText(input.thesis);
  if (!thesis) throw new Error("A decision thesis is required");
  const evidenceIds = [...new Set(input.evidenceIds ?? [])];
  const evidence = await queryEvidence({ symbols: [symbol], limit: 500 });
  if (evidenceIds.some((id) => !evidence.items.some((item) => item.id === id)))
    throw new Error(
      "Evidence must already exist for this symbol and be available now",
    );
  const preferences = await loadPreferences();
  const position = preferences.positions?.find(
    (item) => normalizeSymbol(item.symbol) === symbol && item.quantity > 0,
  );
  if (["hold", "review-exit"].includes(state) && !position)
    throw new Error("This state requires an existing saved position");
  let quote = null;
  let quoteError = null;
  let verifiedBudget = null;
  try {
    quote = await getQuote(symbol);
  } catch (error) {
    quoteError = error.message;
  }
  if (state === "candidate") {
    const predictions = await queryPredictionLedger({ symbol, limit: 100 });
    const rows = Array.isArray(predictions)
      ? predictions
      : (predictions.predictions ??
        predictions.items ??
        predictions.records ??
        []);
    const prediction = rows.find(
      (item) => item.id === input.validationPredictionId,
    );
    if (
      !cleanText(input.entryCondition) ||
      !cleanText(input.invalidationCondition) ||
      !cleanText(input.riskBudget) ||
      !evidenceIds.length
    )
      throw new Error(
        "Candidate requires entry, invalidation, risk budget, and evidence",
      );
    if (quote?.signalEligible !== true)
      throw new Error(
        "Candidate requires current usable market data without a cross-source conflict",
      );
    if (!prediction || prediction.qualification?.currentlyEligible !== true)
      throw new Error(
        "Candidate requires a current, qualified, unresolved recorded prediction",
      );
    if (!input.budgetRequest)
      throw new Error("Candidate requires a computable position budget");
    verifiedBudget = calculatePositionBudget(input.budgetRequest);
    const idea = verifiedBudget.ideas.find((item) => item.symbol === symbol);
    if (!idea || !(idea.quantityCeiling > 0))
      throw new Error(
        "Candidate has no executable allocation within the supplied risk budget",
      );
  }
  const record = {
    id: `decision_${randomUUID()}`,
    symbol,
    state,
    thesis,
    entryCondition: cleanText(input.entryCondition),
    invalidationCondition: cleanText(input.invalidationCondition),
    horizon: cleanText(input.horizon, 160),
    riskBudget: cleanText(input.riskBudget, 160),
    evidenceIds,
    validationPredictionId: input.validationPredictionId ?? null,
    verifiedBudget,
    createdAt: new Date().toISOString(),
    snapshot: quote
      ? {
          price: quote.price,
          currency: quote.currency,
          asOf: quote.asOf,
          freshness: quote.freshness,
          provider: quote.provider,
          crossCheck: quote.crossCheck,
          dataSources: quote.dataSources,
          dataQuality: quote.dataQuality,
          signalEligible: quote.signalEligible,
          indicators: quote.indicators,
        }
      : null,
    quoteError,
    reviews: [],
  };
  record.originalHash = createHash("sha256")
    .update(JSON.stringify(record))
    .digest("hex");
  const task = journalQueue.then(async () => {
    const records = await readStore("decisions.json");
    records.push(record);
    await writeStore("decisions.json", records);
    return record;
  });
  journalQueue = task.catch(() => {});
  return task;
}

export async function reviewDecision(id, input) {
  if (
    !["open", "invalidated", "target-reached", "expired", "closed"].includes(
      input.outcome,
    )
  )
    throw new Error("Invalid review outcome");
  const task = journalQueue.then(async () => {
    const records = await readStore("decisions.json");
    const record = records.find((item) => item.id === id);
    if (!record) throw new Error("Decision not found");
    record.reviews.push({
      reviewedAt: new Date().toISOString(),
      outcome: input.outcome,
      notes: cleanText(input.notes),
      source: "user-review",
    });
    await writeStore("decisions.json", records);
    return record;
  });
  journalQueue = task.catch(() => {});
  return task;
}

export function deriveMarketContext(items, benchmarks = [], sectorMap = {}) {
  const valid = items.filter(
    (item) => !item.error && Number.isFinite(item.changePct),
  );
  const sectors = new Map();
  const relativeStrength = [];
  for (const item of valid) {
    const sector = sectorMap[item.symbol] || item.sector || "Unclassified";
    const key = `${item.market}:${sector}`;
    const group = sectors.get(key) ?? {
      name: sector,
      market: item.market,
      scope: "watchlist",
      count: 0,
      sum: 0,
      symbols: [],
    };
    group.count++;
    group.sum += item.changePct;
    group.symbols.push(item.symbol);
    sectors.set(key, group);
    const benchmark = benchmarks.find((value) => value.market === item.market);
    const sameSessionDate =
      benchmark?.asOf &&
      item.asOf &&
      new Date(benchmark.asOf).toISOString().slice(0, 10) ===
        new Date(item.asOf).toISOString().slice(0, 10) &&
      Math.abs(Date.parse(benchmark.asOf) - Date.parse(item.asOf)) <= 1200000;
    const complete = (row) =>
      row.complete !== false &&
      row.isComplete !== false &&
      (row.closeAt
        ? Date.parse(row.closeAt) <= Date.now()
        : row.timestamp?.slice(0, 10) < new Date().toISOString().slice(0, 10));
    const byDate = new Map(
      (benchmark?.history ?? [])
        .filter(complete)
        .map((row) => [
          row.sessionDate ?? row.timestamp.slice(0, 10),
          row.close,
        ]),
    );
    const aligned = [
      ...new Map(
        (item.history ?? [])
          .filter(
            (row) =>
              complete(row) &&
              row.close > 0 &&
              byDate.get(row.sessionDate ?? row.timestamp.slice(0, 10)) > 0,
          )
          .map((row) => [row.sessionDate ?? row.timestamp.slice(0, 10), row]),
      ).values(),
    ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const first = aligned.at(-21),
      last = aligned.at(-1);
    const relative20dPct =
      aligned.length >= 21
        ? (last.close / first.close -
            1 -
            (byDate.get(last.sessionDate ?? last.timestamp.slice(0, 10)) /
              byDate.get(first.sessionDate ?? first.timestamp.slice(0, 10)) -
              1)) *
          100
        : null;
    relativeStrength.push({
      symbol: item.symbol,
      benchmark: benchmark?.symbol ?? null,
      relativeDayPct:
        sameSessionDate && Number.isFinite(benchmark?.changePct)
          ? item.changePct - benchmark.changePct
          : null,
      relative20dPct,
      alignedSessions: Math.min(aligned.length, 21),
    });
  }
  return {
    scope: "watchlist",
    universeSize: items.length,
    covered: valid.length,
    breadth: {
      scope: "watchlist",
      advancing: valid.filter((item) => item.changePct > 0).length,
      declining: valid.filter((item) => item.changePct < 0).length,
      unchanged: valid.filter((item) => item.changePct === 0).length,
      total: valid.length,
    },
    indices: benchmarks.map(({ history, ...item }) => item),
    sectors: [...sectors.values()]
      .map(({ sum, ...group }) => {
        const relative = relativeStrength.filter(
          (item) =>
            group.symbols.includes(item.symbol) &&
            Number.isFinite(item.relativeDayPct),
        );
        return {
          ...group,
          changePct: sum / group.count,
          relativeChangePct:
            relative.length === group.count
              ? relative.reduce(
                  (total, item) => total + item.relativeDayPct,
                  0,
                ) / relative.length
              : null,
        };
      })
      .sort((a, b) => b.changePct - a.changePct),
    relativeStrength,
  };
}

export async function getResearchContext(items, preferences = {}) {
  const markets = [
    ...new Set(
      items
        .map((item) => item.market)
        .filter((market) => benchmarkDefaults[market]),
    ),
  ];
  const benchmarks = await Promise.all(
    markets.map(async (market) => {
      const symbol =
        preferences.benchmarkSymbols?.[market] || benchmarkDefaults[market];
      const key = `benchmark:${symbol}`;
      try {
        const entry = cache.get(key);
        const quote =
          entry && Date.now() - entry.at < 120000
            ? entry.data
            : await getQuote(symbol);
        cache.set(key, { at: Date.now(), data: quote });
        return { ...quote, market };
      } catch (error) {
        return { symbol, market, error: error.message };
      }
    }),
  );
  return deriveMarketContext(items, benchmarks, preferences.sectorMap);
}

export function eventsFromEvidence(items) {
  return items
    .filter((item) => item.payload?.eventType && item.payload?.scheduledAt)
    .map((item) => ({
      id: item.id,
      symbol: item.entity.symbol,
      title: item.title,
      eventType: item.payload.eventType,
      scheduledAt: item.payload.scheduledAt,
      effectiveAt: item.payload.scheduledAt,
      availableAt: item.availableAt,
      sourceUrl: item.sourceUrl,
      sourceTier: item.sourceTier,
      evidenceIds: [item.id],
    }))
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
}

export async function enrichReport(report) {
  const preferences = await loadPreferences();
  if (report.phase !== "intraday")
    report.officialSync = await syncOfficialEvidence({
      symbols: report.items.map((item) => item.symbol),
    });
  const evidence = await queryEvidence({
    symbols: report.items.map((item) => item.symbol),
    limit: 500,
  });
  report.context = await getResearchContext(report.items, preferences);
  const industry = await queryEvidence({
    kinds: ["industry", "macro"],
    limit: 100,
  });
  report.context.marketBreadth = industry.items
    .filter((item) => {
      const breadth = item.payload?.breadth;
      return (
        breadth?.scope === "market" &&
        Number.isInteger(breadth.total) &&
        breadth.total > 0 &&
        ["advancing", "declining", "unchanged"].every(
          (key) => Number.isInteger(breadth[key]) && breadth[key] >= 0,
        ) &&
        breadth.advancing + breadth.declining + breadth.unchanged ===
          breadth.total &&
        Number.isFinite(Date.parse(breadth.asOf)) &&
        Date.now() - Date.parse(breadth.asOf) >= 0 &&
        Date.now() - Date.parse(breadth.asOf) < 3600000
      );
    })
    .map((item) => ({
      ...item.payload.breadth,
      sourceUrl: item.sourceUrl,
      evidenceId: item.id,
    }));
  report.evidence = evidence.items;
  report.events = eventsFromEvidence(evidence.items);
  report.decisions = (await listDecisions()).decisions;
  for (const item of report.items) {
    item.evidence = evidence.items.filter(
      (record) => record.entity.symbol === item.symbol,
    );
    item.events = report.events.filter((event) => event.symbol === item.symbol);
    item.financials = item.evidence.filter(
      (record) => record.kind === "financial",
    );
    item.relativeStrength =
      report.context.relativeStrength.find(
        (record) => record.symbol === item.symbol,
      ) ?? null;
  }
  return report;
}

const OFFICIAL_HOSTS = [
  "sec.gov",
  "cninfo.com.cn",
  "sse.com.cn",
  "szse.cn",
  "hkexnews.hk",
  "hkex.com.hk",
  "bse.cn",
];
export function officialUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !OFFICIAL_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw new Error(
      "A public HTTPS regulator or exchange source URL is required",
    );
  return url;
}

async function publicJson(url, init = {}) {
  officialUrl(url);
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Accept: "application/json",
      "User-Agent":
        process.env.HROUTER_SEC_USER_AGENT ||
        "Hrouter Market Pulse/1.1.0 (https://hrouter.net/)",
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new Error(`Official provider HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 16000000)
    throw new Error("Official provider response is too large");
  return JSON.parse(body);
}

export async function ingestOfficialRecords(input) {
  if (
    !Array.isArray(input.items) ||
    !input.items.length ||
    input.items.length > 100
  )
    throw new Error("Provide 1-100 official records");
  const items = input.items.map((item) => {
    const sourceUrl = officialUrl(item.sourceUrl).toString();
    if (
      item.payload?.scheduledAt &&
      !Number.isFinite(Date.parse(item.payload.scheduledAt))
    )
      throw new Error("scheduledAt must be a date");
    return {
      ...item,
      sourceUrl,
      sourceTier: "official",
      providerId: "official-source-import",
      availableAt: undefined,
    };
  });
  await registerDataProvider({
    id: "official-source-import",
    name: "Official source imports",
    sourceTier: "official",
    kinds: [
      "filing",
      "financial",
      "corporate_action",
      "macro",
      "industry",
      "other",
    ],
    homepage: "https://hrouter.net/",
    notes:
      "Source host allowlisted; supplied record contents require original-document verification. Availability is first ingestion.",
  });
  return ingestEvidence({ items });
}

export function secSubmissionRecords(symbol, cik, payload, limit = 8) {
  const recent = payload.filings?.recent ?? {};
  const records = [];
  for (
    let i = 0;
    i < (recent.accessionNumber?.length ?? 0) && records.length < limit;
    i++
  ) {
    const form = recent.form[i];
    if (
      !["10-K", "10-Q", "8-K", "20-F", "6-K", "10-K/A", "10-Q/A"].includes(form)
    )
      continue;
    const accession = recent.accessionNumber[i];
    const primaryDocument = recent.primaryDocument[i];
    if (
      !/^\d{10}-\d{2}-\d{6}$/.test(accession) ||
      !/^[A-Za-z0-9_.-]+$/.test(primaryDocument)
    )
      continue;
    const acceptance = recent.acceptanceDateTime?.[i];
    const exactTime = acceptance && /(?:Z|[+-]\d\d:\d\d)$/.test(acceptance);
    const publishedAt = exactTime
      ? new Date(acceptance).toISOString()
      : `${recent.filingDate[i]}T00:00:00Z`;
    records.push({
      providerId: "sec-edgar",
      sourceTier: "official",
      kind: "filing",
      externalId: accession,
      entity: { symbol, name: payload.name, identifiers: { cik: String(cik) } },
      title: `${payload.name} ${form} (${recent.reportDate?.[i] || recent.filingDate[i]})`,
      sourceUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/${primaryDocument}`,
      publishedAt,
      payload: {
        form,
        accession,
        publicationTimePrecision: exactTime ? "timestamp" : "date",
        periodEnd: recent.reportDate?.[i] ?? null,
        amended: form.endsWith("/A"),
      },
    });
  }
  return records;
}

export function secFinancialRecords(symbol, cik, payload) {
  const tags = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "NetIncomeLoss",
    "NetCashProvidedByUsedInOperatingActivities",
    "Assets",
    "Liabilities",
  ];
  return tags.flatMap((tag) => {
    const concept = payload.facts?.["us-gaap"]?.[tag];
    const units = concept?.units ?? {};
    return Object.entries(units).flatMap(([unit, rows]) => {
      const entries = rows
        .filter(
          (row) =>
            finite(row.val) !== null &&
            row.filed &&
            ["10-K", "10-Q"].includes(row.form),
        )
        .sort(
          (a, b) =>
            b.filed.localeCompare(a.filed) || b.end.localeCompare(a.end),
        );
      const row = entries[0];
      if (!row) return [];
      return [
        {
          providerId: "sec-edgar",
          sourceTier: "official",
          kind: "financial",
          entity: { symbol, name: payload.entityName },
          title: `${tag} | ${row.end} | ${unit}`,
          summary: concept.description ?? "",
          sourceUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`,
          publishedAt: `${row.filed}T00:00:00Z`,
          payload: {
            publicationTimePrecision: "date",
            metric: tag,
            value: row.val,
            unit,
            periodStart: row.start ?? null,
            periodEnd: row.end,
            accession: row.accn,
            form: row.form,
          },
        },
      ];
    });
  });
}

async function syncSec(symbol, limit) {
  let tickers = cache.get("sec-tickers");
  if (!tickers || Date.now() - tickers.at > 86400000) {
    tickers = {
      at: Date.now(),
      data: await publicJson("https://www.sec.gov/files/company_tickers.json"),
    };
    cache.set("sec-tickers", tickers);
  }
  const company = Object.values(tickers.data).find(
    (item) => item.ticker === symbol.replace(".", "-"),
  );
  if (!company) throw new Error(`SEC CIK not found for ${symbol}`);
  const cik = String(company.cik_str).padStart(10, "0");
  const submissions = await publicJson(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
  );
  const filings = secSubmissionRecords(symbol, cik, submissions, limit);
  let financials = [],
    financialError = null;
  try {
    financials = secFinancialRecords(
      symbol,
      cik,
      await publicJson(
        `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
      ),
    );
  } catch (error) {
    financialError = error.message;
  }
  await registerDataProvider({
    id: "sec-edgar",
    name: "SEC EDGAR",
    sourceTier: "official",
    kinds: ["filing", "financial"],
    homepage: "https://www.sec.gov/",
  });
  const result =
    filings.length || financials.length
      ? await ingestEvidence({
          items: [...filings, ...financials].slice(0, 100),
        })
      : { inserted: 0 };
  return { ...result, financialError };
}

async function syncCninfo(symbol, limit) {
  const code = symbol.split(".")[0];
  const body = new URLSearchParams({
    pageNum: "1",
    pageSize: String(limit),
    column: symbol.endsWith(".SS") ? "sse" : "szse",
    tabName: "fulltext",
    searchkey: code,
    secid: "",
    stock: "",
    category: "",
    trade: "",
    seDate: "",
    sortName: "time",
    sortType: "desc",
    isHLtitle: "false",
  });
  const payload = await publicJson(
    "https://www.cninfo.com.cn/new/hisAnnouncement/query",
    {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://www.cninfo.com.cn/",
      },
    },
  );
  const records = (payload.announcements ?? [])
    .filter((item) => item.secCode === code)
    .map((item) => ({
      providerId: "cninfo-disclosures",
      sourceTier: "official",
      kind: "filing",
      entity: { symbol, name: item.secName },
      title: cleanText(item.announcementTitle, 1000),
      sourceUrl: officialUrl(
        new URL(item.adjunctUrl, "https://static.cninfo.com.cn/").toString(),
      ).toString(),
      publishedAt: new Date(item.announcementTime).toISOString(),
      externalId: String(item.announcementId),
      payload: { category: item.announcementType ?? null },
    }));
  await registerDataProvider({
    id: "cninfo-disclosures",
    name: "CNINFO disclosures",
    sourceTier: "official",
    kinds: ["filing"],
    homepage: "https://www.cninfo.com.cn/",
  });
  return records.length
    ? ingestEvidence({ items: records })
    : { inserted: 0, warning: "No matching announcements returned" };
}

export async function syncOfficialEvidence({ symbols, limit = 8 } = {}) {
  const preferences = await loadPreferences();
  const list = [
    ...new Set((symbols ?? preferences.watchlist).map(normalizeSymbol)),
  ].slice(0, 20);
  const results = [];
  const deferred = list.slice(5).map((symbol) => ({
    symbol,
    status: "deferred",
    message:
      "Sync at most five symbols per request; submit this symbol in the next batch.",
  }));
  for (let offset = 0; offset < Math.min(list.length, 5); offset += 3) {
    const batch = await Promise.all(
      list.slice(offset, Math.min(offset + 3, 5)).map(async (symbol) => {
        const market = marketFromSymbol(symbol);
        const key = `official-sync:${symbol}`;
        const cached = cache.get(key);
        if (cached && Date.now() - cached.at < 900000) {
          return { symbol, status: "synced", ...cached.data, cached: true };
        }
        try {
          if (market === "HK") {
            return {
              symbol,
              status: "source-required",
              sourceUrl:
                "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en",
              message:
                "Import original HKEXnews records with ingest_official_records; no unsupported public API is assumed.",
            };
          }
          const data =
            market === "A"
              ? await syncCninfo(symbol, Math.min(limit, 20))
              : await syncSec(symbol, Math.min(limit, 20));
          cache.set(key, { at: Date.now(), data });
          return { symbol, status: "synced", ...data };
        } catch (error) {
          return { symbol, status: "unavailable", error: error.message };
        }
      }),
    );
    results.push(...batch);
  }
  return {
    generatedAt: new Date().toISOString(),
    results: [...results, ...deferred],
  };
}
