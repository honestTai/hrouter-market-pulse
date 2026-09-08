import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getInstrumentRules } from "./market-rules.mjs";
import { adjustedIndicatorRows, executionHistory, fillRestriction, prepareDailyHistory, purgedWalkForwardFolds, qualifyPrediction, researchAsOf, simulatePortfolio } from "./research-validation.mjs";

import {
  computeIndicators,
  getHistoricalQuote,
  getQuote,
  getStorageDir,
  normalizeSymbol,
  OFFICIAL_WEBSITE,
} from "./core.mjs";

export const CONTRACT_VERSION = "1.0.0";

export const EVIDENCE_KINDS = [
  "quote",
  "news",
  "filing",
  "financial",
  "corporate_action",
  "macro",
  "industry",
  "other",
];

export const SOURCE_TIERS = ["official", "primary", "secondary", "unknown"];

export const STRATEGY_FEATURES = [
  "price",
  "changePct",
  "rsi14",
  "volumeRatio20d",
  "annualizedVolatilityPct",
  "maxDrawdown60dPct",
  "priceToSma20Pct",
  "macdHistogram",
  "crossCheckDifferencePct",
];

export const BASELINE_PREDICTION_FEATURES = [
  "changePct",
  "rsi14",
  "priceToSma20Pct",
  "macdHistogram",
  "annualizedVolatilityPct",
];

const BUILTIN_PROVIDERS = [
  {
    id: "yahoo-finance",
    name: "Yahoo Finance",
    sourceTier: "secondary",
    kinds: ["quote", "news"],
    mode: "built-in",
    trustStatus: "built-in",
  },
  {
    id: "tencent-finance",
    name: "Tencent Finance",
    sourceTier: "secondary",
    kinds: ["quote"],
    mode: "built-in-cross-check",
    trustStatus: "built-in",
  },
];

const STRATEGY_OPERATORS = new Set(["gt", "gte", "lt", "lte", "between"]);
const MAX_EVIDENCE_ITEMS = 100_000;
let evidenceWriteQueue = Promise.resolve();
let providerWriteQueue = Promise.resolve();
let predictionWriteQueue = Promise.resolve();

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function standardDeviation(values) {
  const mean = average(values);
  if (mean === null || values.length < 2) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

function percentile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function asIso(value, field, fallback = null) {
  if ((value === undefined || value === null || value === "") && fallback !== null) return fallback;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${field} 必须是有效时间`);
  return timestamp.toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, filePath);
}

function foundationDirectory() {
  return path.join(getStorageDir(), "foundation-v1");
}

function evidencePath() {
  return path.join(foundationDirectory(), "evidence.json");
}

function providersPath() {
  return path.join(foundationDirectory(), "providers.json");
}

function normalizeProviderId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(id)) throw new Error("provider id 必须是 3-64 位小写字母、数字或连字符");
  return id;
}

function normalizeWebUrl(value, field) {
  const url = new URL(String(value ?? ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${field} 只支持 HTTP(S) URL`);
  return url.toString();
}

export async function registerDataProvider(input) {
  const provider = {
    id: normalizeProviderId(input.id),
    name: String(input.name ?? "").trim(),
    sourceTier: SOURCE_TIERS.includes(input.sourceTier) ? input.sourceTier : "unknown",
    kinds: [...new Set((input.kinds ?? []).filter((kind) => EVIDENCE_KINDS.includes(kind)))],
    homepage: input.homepage ? normalizeWebUrl(input.homepage, "homepage") : null,
    mode: "companion-mcp",
    trustStatus: "user-declared",
    notes: String(input.notes ?? "").trim() || null,
    updatedAt: new Date().toISOString(),
  };
  if (!provider.name) throw new Error("provider name 不能为空");
  if (!provider.kinds.length) throw new Error("provider 至少需要声明一种受支持的数据类型");

  const task = providerWriteQueue.then(async () => {
    const current = await loadJson(providersPath(), []);
    const next = current.filter((item) => item.id !== provider.id);
    next.push(provider);
    next.sort((left, right) => left.id.localeCompare(right.id));
    await atomicWriteJson(providersPath(), next);
    return provider;
  });
  providerWriteQueue = task.catch(() => {});
  return task;
}

export async function getFoundationCapabilities() {
  const customProviders = await loadJson(providersPath(), []);
  return {
    foundationVersion: CONTRACT_VERSION,
    officialWebsite: OFFICIAL_WEBSITE,
    providers: [...BUILTIN_PROVIDERS, ...customProviders],
    contracts: {
      Evidence: { schemaVersion: CONTRACT_VERSION, kinds: EVIDENCE_KINDS, sourceTiers: SOURCE_TIERS },
      Event: { schemaVersion: CONTRACT_VERSION, required: ["eventType", "entity", "effectiveAt", "evidenceIds"] },
      Signal: { schemaVersion: CONTRACT_VERSION, required: ["strategy", "symbol", "generatedAt", "score", "reasons"] },
      StrategyResult: { schemaVersion: CONTRACT_VERSION, required: ["strategy", "generatedAt", "signals", "dataCoverage"] },
    },
    schemaFiles: [
      "schemas/evidence.schema.json",
      "schemas/event.schema.json",
      "schemas/signal.schema.json",
      "schemas/strategy-result.schema.json",
      "schemas/strategy.schema.json",
    ],
    strategy: {
      type: "declarative-scoring-v1",
      features: STRATEGY_FEATURES,
      externalFeaturePattern: "external.<name>",
      externalFeatureContract: ["symbol", "availableAt", "evidenceIds", "values"],
      operators: [...STRATEGY_OPERATORS],
    },
    prediction: {
      model: "logistic-walk-forward-v2",
      features: BASELINE_PREDICTION_FEATURES,
      validation: "repeated purged walk-forward folds, baseline comparison, deployment gates, immutable prediction ledger",
      target: "cost-adjusted return from day T+1 open to a later close",
    },
    extensionFlow: [
      "A companion Skill or MCP fetches source data.",
      "It registers provider metadata without credentials or executable code.",
      "It submits normalized evidence through ingest_evidence.",
      "User-defined declarative strategies consume quotes and evidence.",
      "Backtests and monitoring preserve timestamps, versions, and quality warnings.",
    ],
    safetyBoundary: "The foundation accepts data and declarative rules, but never loads arbitrary provider code or places trades.",
  };
}

export function normalizeEvidence(input, now = new Date()) {
  const fetchedAt = now.toISOString();
  const providerFetchedAt = input.fetchedAt ? asIso(input.fetchedAt, "fetchedAt") : null;
  const publishedAt = asIso(input.publishedAt, "publishedAt");
  const effectiveAt = asIso(input.effectiveAt, "effectiveAt", publishedAt);
  const declaredAvailableAt = input.availableAt ? asIso(input.availableAt, "availableAt") : null;
  const availableAt = declaredAvailableAt ?? fetchedAt;
  if (Date.parse(availableAt) < Date.parse(publishedAt)) throw new Error("availableAt 不能早于 publishedAt");
  const providerId = normalizeProviderId(input.providerId);
  const kind = EVIDENCE_KINDS.includes(input.kind) ? input.kind : null;
  if (!kind) throw new Error(`不支持的 evidence kind: ${input.kind}`);
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("evidence title 不能为空");
  const summary = String(input.summary ?? "").trim();
  const sourceUrl = normalizeWebUrl(input.sourceUrl, "sourceUrl");
  let symbol = null;
  if (input.entity?.symbol) symbol = normalizeSymbol(input.entity.symbol);
  const entity = {
    symbol,
    name: String(input.entity?.name ?? "").trim() || null,
    identifiers: input.entity?.identifiers && typeof input.entity.identifiers === "object"
      ? stableValue(input.entity.identifiers)
      : {},
  };
  if (!entity.symbol && !entity.name) throw new Error("evidence entity 至少需要 symbol 或 name");
  const payload = input.payload && typeof input.payload === "object" ? stableValue(input.payload) : null;
  const contentHash = hashValue({ title, summary, payload });
  const id = `ev_${hashValue({ providerId, kind, sourceUrl, publishedAt, entity, contentHash }).slice(0, 32)}`;
  return {
    schemaVersion: CONTRACT_VERSION,
    id,
    externalId: String(input.externalId ?? "").trim() || null,
    providerId,
    sourceTier: SOURCE_TIERS.includes(input.sourceTier) ? input.sourceTier : "unknown",
    kind,
    entity,
    title,
    summary,
    sourceUrl,
    publishedAt,
    effectiveAt,
    availableAt,
    fetchedAt,
    providerFetchedAt,
    pointInTimeStatus: declaredAvailableAt ? "provider-declared" : "first-observed-at-ingestion",
    contentHash,
    payload,
  };
}

export async function ingestEvidence(input) {
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw new Error("至少需要一条 evidence");
  if (items.length > 100) throw new Error("单次最多写入 100 条 evidence");
  const serializedSize = Buffer.byteLength(JSON.stringify(items), "utf8");
  if (serializedSize > 2_000_000) throw new Error("单次 evidence 载荷不能超过 2 MB");
  const normalized = items.map((item) => normalizeEvidence(item));
  const customProviders = await loadJson(providersPath(), []);
  const providerById = new Map([...BUILTIN_PROVIDERS, ...customProviders].map((provider) => [provider.id, provider]));
  const unknownProvider = normalized.find((item) => !providerById.has(item.providerId));
  if (unknownProvider) throw new Error(`provider ${unknownProvider.providerId} 尚未注册，请先调用 register_data_provider`);
  for (const item of normalized) {
    const provider = providerById.get(item.providerId);
    if (item.sourceTier !== provider.sourceTier) throw new Error(`${item.providerId} 的 sourceTier 必须与注册信息 ${provider.sourceTier} 一致`);
    if (!provider.kinds.includes(item.kind)) throw new Error(`${item.providerId} 未声明 ${item.kind} 数据能力`);
    item.providerTrustStatus = provider.trustStatus;
  }

  const task = evidenceWriteQueue.then(async () => {
    const existing = await loadJson(evidencePath(), []);
    const byId = new Map(existing.map((item) => [item.id, item]));
    let inserted = 0;
    for (const item of normalized) {
      if (byId.has(item.id)) continue;
      byId.set(item.id, item);
      inserted += 1;
    }
    if (byId.size > MAX_EVIDENCE_ITEMS) throw new Error(`证据库达到 ${MAX_EVIDENCE_ITEMS} 条上限，请先归档旧数据`);
    const next = [...byId.values()].sort((left, right) => Date.parse(left.publishedAt) - Date.parse(right.publishedAt));
    await atomicWriteJson(evidencePath(), next);
    return {
      received: normalized.length,
      inserted,
      duplicates: normalized.length - inserted,
      total: next.length,
      ids: normalized.map((item) => item.id),
      storage: evidencePath(),
    };
  });
  evidenceWriteQueue = task.catch(() => {});
  return task;
}

export async function queryEvidence(input = {}) {
  const asOf = asIso(input.asOf, "asOf", new Date().toISOString());
  const publishedFrom = input.publishedFrom ? asIso(input.publishedFrom, "publishedFrom") : null;
  const publishedTo = input.publishedTo ? asIso(input.publishedTo, "publishedTo") : null;
  const symbols = new Set((input.symbols ?? []).map(normalizeSymbol));
  const kinds = new Set((input.kinds ?? []).filter((kind) => EVIDENCE_KINDS.includes(kind)));
  const providerIds = new Set((input.providerIds ?? []).map(normalizeProviderId));
  const sourceTiers = new Set((input.sourceTiers ?? []).filter((tier) => SOURCE_TIERS.includes(tier)));
  const limit = Math.max(1, Math.min(500, Number(input.limit) || 100));
  const items = await loadJson(evidencePath(), []);
  const matched = items.filter((item) => {
    if (Date.parse(item.availableAt) > Date.parse(asOf)) return false;
    if (publishedFrom && Date.parse(item.publishedAt) < Date.parse(publishedFrom)) return false;
    if (publishedTo && Date.parse(item.publishedAt) > Date.parse(publishedTo)) return false;
    if (symbols.size && !symbols.has(item.entity?.symbol)) return false;
    if (kinds.size && !kinds.has(item.kind)) return false;
    if (providerIds.size && !providerIds.has(item.providerId)) return false;
    if (sourceTiers.size && !sourceTiers.has(item.sourceTier)) return false;
    return true;
  }).sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  return {
    asOf,
    totalMatched: matched.length,
    returned: Math.min(limit, matched.length),
    items: matched.slice(0, limit),
    pointInTimeRule: "Only evidence with availableAt less than or equal to asOf is returned.",
  };
}

function isStrategyFeature(value) {
  return STRATEGY_FEATURES.includes(value) || /^external\.[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

async function normalizeExternalFeatureRows(rows = []) {
  if (!rows.length) return [];
  if (rows.length > 5000) throw new Error("单次最多提供 5000 条外部特征记录");
  const evidence = await loadJson(evidencePath(), []);
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  return rows.map((row, index) => {
    const symbol = normalizeSymbol(row.symbol);
    const availableAt = asIso(row.availableAt, `externalFeatureRows[${index}].availableAt`);
    const evidenceIds = [...new Set(row.evidenceIds ?? [])];
    if (!evidenceIds.length) throw new Error(`${symbol} 的外部特征必须绑定至少一个 evidenceId`);
    for (const evidenceId of evidenceIds) {
      const item = evidenceById.get(evidenceId);
      if (!item) throw new Error(`未找到 evidenceId: ${evidenceId}`);
      if (Date.parse(item.availableAt) > Date.parse(availableAt)) throw new Error(`${evidenceId} 在外部特征 availableAt 时尚不可用`);
      if (item.entity?.symbol && item.entity.symbol !== symbol) throw new Error(`${evidenceId} 的实体与 ${symbol} 不匹配`);
    }
    const values = {};
    for (const [name, rawValue] of Object.entries(row.values ?? {})) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error(`外部特征名称无效: ${name}`);
      const value = finite(rawValue);
      if (value === null) throw new Error(`外部特征 ${name} 必须是有限数值`);
      values[`external.${name}`] = value;
    }
    if (!Object.keys(values).length) throw new Error(`${symbol} 的外部特征 values 不能为空`);
    return { symbol, availableAt, evidenceIds, values };
  }).sort((left, right) => Date.parse(left.availableAt) - Date.parse(right.availableAt));
}

function externalFeatureRowAt(rows, symbol, asOf) {
  const asOfTime = Date.parse(asOf);
  let selected = null;
  for (const row of rows) {
    if (row.symbol !== symbol || Date.parse(row.availableAt) > asOfTime) continue;
    if (!selected || Date.parse(row.availableAt) > Date.parse(selected.availableAt)) selected = row;
  }
  return selected;
}

function attachExternalFeatures(quote, row) {
  if (!row) return quote;
  return {
    ...quote,
    externalFeatures: row.values,
    externalFeatureAvailableAt: row.availableAt,
    evidenceIds: row.evidenceIds,
  };
}

function quoteFeature(quote, feature) {
  const indicators = quote.indicators ?? {};
  if (feature === "price") return finite(quote.price);
  if (feature === "changePct") return finite(quote.changePct);
  if (feature === "rsi14") return finite(indicators.rsi14);
  if (feature === "volumeRatio20d") return finite(indicators.volumeRatio20d);
  if (feature === "annualizedVolatilityPct") return finite(indicators.annualizedVolatilityPct);
  if (feature === "maxDrawdown60dPct") return finite(indicators.maxDrawdown60dPct);
  if (feature === "priceToSma20Pct") {
    return quote.price && indicators.sma20 ? (quote.price / indicators.sma20 - 1) * 100 : null;
  }
  if (feature === "macdHistogram") {
    return Number.isFinite(indicators.macd) && Number.isFinite(indicators.macdSignal)
      ? indicators.macd - indicators.macdSignal
      : null;
  }
  if (feature === "crossCheckDifferencePct") return finite(quote.crossCheck?.priceDifferencePct);
  if (feature.startsWith("external.")) return finite(quote.externalFeatures?.[feature]);
  return null;
}

function ruleMatches(value, rule) {
  if (!Number.isFinite(value)) return false;
  if (rule.operator === "gt") return value > rule.value;
  if (rule.operator === "gte") return value >= rule.value;
  if (rule.operator === "lt") return value < rule.value;
  if (rule.operator === "lte") return value <= rule.value;
  if (rule.operator === "between") return value >= Math.min(rule.value, rule.value2) && value <= Math.max(rule.value, rule.value2);
  return false;
}

function normalizeStrategy(strategy = {}) {
  const name = String(strategy.name ?? "").trim();
  const version = String(strategy.version ?? "").trim();
  if (!name || !version) throw new Error("strategy name 和 version 不能为空");
  const rules = (strategy.rules ?? []).map((rule, index) => {
    if (!isStrategyFeature(rule.feature)) throw new Error(`规则 ${index + 1} 使用了不支持的 feature: ${rule.feature}`);
    if (!STRATEGY_OPERATORS.has(rule.operator)) throw new Error(`规则 ${index + 1} 使用了不支持的 operator: ${rule.operator}`);
    const value = finite(rule.value);
    const value2 = rule.operator === "between" ? finite(rule.value2) : null;
    const points = finite(rule.points);
    if (value === null || (rule.operator === "between" && value2 === null)) throw new Error(`规则 ${index + 1} 的阈值无效`);
    if (points === null || points < -100 || points > 100) throw new Error(`规则 ${index + 1} 的 points 必须在 -100 到 100 之间`);
    return {
      feature: rule.feature,
      operator: rule.operator,
      value,
      value2,
      points,
      label: String(rule.label ?? `${rule.feature} ${rule.operator}`).trim(),
    };
  });
  if (!rules.length || rules.length > 50) throw new Error("strategy rules 必须包含 1-50 条规则");
  return {
    name,
    version,
    baseScore: finite(strategy.baseScore) ?? 0,
    minimumScore: finite(strategy.minimumScore) ?? 1,
    rules,
  };
}

export function evaluateDeclarativeStrategy(quote, inputStrategy) {
  const strategy = normalizeStrategy(inputStrategy);
  let score = strategy.baseScore;
  const reasons = [];
  const missingFeatures = new Set();
  for (const rule of strategy.rules) {
    const value = quoteFeature(quote, rule.feature);
    if (!Number.isFinite(value)) {
      missingFeatures.add(rule.feature);
      continue;
    }
    if (!ruleMatches(value, rule)) continue;
    score += rule.points;
    reasons.push({ label: rule.label, feature: rule.feature, value: round(value), points: rule.points });
  }
  const effectiveTimes = [quote.asOf, quote.externalFeatureAvailableAt].filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  const marketDataEligible = quote.signalEligible !== undefined ? quote.signalEligible === true : !quote.freshness || quote.freshness.signalEligible === true;
  return {
    schemaVersion: CONTRACT_VERSION,
    strategy: { name: strategy.name, version: strategy.version },
    symbol: quote.symbol,
    generatedAt: new Date().toISOString(),
    effectiveAt: effectiveTimes.length ? new Date(Math.max(...effectiveTimes)).toISOString() : null,
    score: round(score),
    minimumScore: strategy.minimumScore,
    selected: score >= strategy.minimumScore && marketDataEligible,
    blockedReasons: marketDataEligible ? [] : [quote.freshness?.reason ?? `Market data is not eligible for new signals (${quote.crossCheck?.status ?? "unverified"})`],
    reasons,
    missingFeatures: [...missingFeatures],
    evidenceIds: quote.evidenceIds ?? [],
    dataQuality: quote.dataQuality ?? null,
  };
}

export async function runDeclarativeStrategy(input) {
  const symbols = [...new Set((input.symbols ?? []).map(normalizeSymbol))].slice(0, 20);
  if (!symbols.length) throw new Error("run_strategy 至少需要一个 symbol");
  const strategy = normalizeStrategy(input.strategy);
  const externalFeatureRows = await normalizeExternalFeatureRows(input.externalFeatureRows ?? []);
  const now = new Date().toISOString();
  const outcomes = await Promise.all(symbols.map(async (symbol) => {
    try {
      const quote = await getQuote(symbol);
      const row = externalFeatureRowAt(externalFeatureRows, symbol, now);
      return evaluateDeclarativeStrategy(attachExternalFeatures(quote, row), strategy);
    } catch (error) {
      return { symbol, error: error.message, selected: false, score: null, reasons: [] };
    }
  }));
  const signals = outcomes.filter((item) => !item.error);
  const errors = outcomes.filter((item) => item.error).map((item) => ({ symbol: item.symbol, error: item.error }));
  signals.sort((left, right) => right.score - left.score);
  return {
    schemaVersion: CONTRACT_VERSION,
    strategy: { name: strategy.name, version: strategy.version },
    generatedAt: new Date().toISOString(),
    signals,
    errors,
    dataCoverage: {
      requested: symbols.length,
      succeeded: signals.length,
      failed: errors.length,
    },
    meaning: "Declarative scores are user-defined research filters, not validated return forecasts or trade instructions.",
  };
}

function historicalQuote(symbol, rows, index) {
  const priorRows = rows.slice(0, index + 1);
  const latestGap = priorRows.findLastIndex((row) => row.gapBefore);
  const history = adjustedIndicatorRows(priorRows.slice(Math.max(0, latestGap)));
  const latest = history.at(-1);
  const previous = history.at(-2);
  return {
    symbol,
    price: latest.close,
    changePct: previous?.close ? (latest.close / previous.close - 1) * 100 : null,
    asOf: latest.availableAt ?? latest.closeAt ?? latest.timestamp,
    indicators: computeIndicators(
      history.map((row) => row.close),
      history.map((row) => row.high),
      history.map((row) => row.low),
      history.map((row) => row.volume),
    ),
    crossCheck: null,
    dataQuality: { status: "historical", warnings: [] },
  };
}

function summarizeTrades(trades) {
  return {
    trades: trades.length,
    hitRatePct: trades.length ? round(trades.filter((trade) => trade.netReturnPct > 0).length / trades.length * 100, 2) : null,
    averageReturnPct: trades.length ? round(average(trades.map((trade) => trade.netReturnPct)), 3) : null,
    compoundedTradeReturnPct: null,
    distributionPct: trades.length ? {
      minimum: round(percentile(trades.map((trade) => trade.netReturnPct), 0), 3),
      p25: round(percentile(trades.map((trade) => trade.netReturnPct), 0.25), 3),
      median: round(percentile(trades.map((trade) => trade.netReturnPct), 0.5), 3),
      p75: round(percentile(trades.map((trade) => trade.netReturnPct), 0.75), 3),
      maximum: round(percentile(trades.map((trade) => trade.netReturnPct), 1), 3),
    } : null,
  };
}

export async function runHistoricalBacktest(input) {
  const symbols = [...new Set((input.symbols ?? []).map(normalizeSymbol))].slice(0, 10);
  if (!symbols.length) throw new Error("run_backtest 至少需要一个 symbol");
  const strategy = normalizeStrategy(input.strategy);
  const range = ["1y", "2y", "5y"].includes(input.range) ? input.range : "2y";
  const warmupDays = Math.max(20, Math.min(252, Number(input.warmupDays) || 60));
  const holdingPeriodDays = Math.max(1, Math.min(20, Number(input.holdingPeriodDays) || 1));
  const transactionCostBps = Math.max(0, Math.min(500, finite(input.transactionCostBps) ?? 10));
  const slippageBps = Math.max(0, Math.min(500, finite(input.slippageBps) ?? 5));
  const asOf = researchAsOf(input.asOf);
  const externalFeatureRows = await normalizeExternalFeatureRows(input.externalFeatureRows ?? []);
  const startDate = input.startDate ? Date.parse(asIso(input.startDate, "startDate")) : null;
  const requestedEnd = input.endDate ? asIso(/^\d{4}-\d{2}-\d{2}$/.test(input.endDate) ? `${input.endDate}T23:59:59.999Z` : input.endDate, "endDate") : asOf;
  const endDate = Math.min(Date.parse(requestedEnd), Date.parse(asOf));
  if (startDate !== null && endDate !== null && startDate > endDate) throw new Error("startDate 不能晚于 endDate");

  const bySymbol = [];
  const candidates = [];
  const histories = {};
  const corporateActions = {};
  const unfilled = [];
  for (const symbol of symbols) {
    try {
      const quote = executionHistory(input.historyBySymbol?.[symbol] ?? await getHistoricalQuote(symbol, { range }));
      const prepared = prepareDailyHistory(symbol, quote.history, new Date(endDate).toISOString());
      if (prepared.rules.instrumentType !== "equity") throw new Error("This instrument requires verified tradability, holding and lot rules before backtesting");
      const allRows = prepared.rows;
      histories[symbol] = allRows;
      corporateActions[symbol] = normalizeResearchActions(quote.corporateActions ?? [], allRows);
      verifyActionCoverage(allRows, corporateActions[symbol]);
      applyCorporateActionReferences(allRows, corporateActions[symbol]);
      const symbolCandidates = [];
      let index = warmupDays - 1;
      while (index < allRows.length - 1) {
        const pointInTimeQuote = historicalQuote(symbol, allRows, index);
        const featureRow = externalFeatureRowAt(externalFeatureRows, symbol, pointInTimeQuote.asOf);
        const signal = evaluateDeclarativeStrategy(attachExternalFeatures(pointInTimeQuote, featureRow), strategy);
        const signalTime = Date.parse(pointInTimeQuote.asOf);
        if ((startDate !== null && signalTime < startDate) || (endDate !== null && signalTime > endDate) || !signal.selected) {
          index += 1;
          continue;
        }
        const entryIndex = index + 1;
        const entry = allRows[entryIndex];
        if (Date.parse(entry.openAt) <= signalTime) { index += 1; continue; }
        const restriction = fillRestriction(symbol, entry, allRows[index], "buy");
        if (restriction) { unfilled.push({ symbol, at: entry.openAt, side: "buy", reason: restriction }); index += 1; continue; }
        const rules = getInstrumentRules(symbol, { asOf: entry.openAt });
        let exitIndex = entryIndex + Math.max(holdingPeriodDays - 1, rules.minimumHoldingSessions ?? 0);
        const plannedExitIndex = exitIndex;
        while (exitIndex < allRows.length && fillRestriction(symbol, allRows[exitIndex], allRows[exitIndex - 1], "sell")) {
          unfilled.push({ symbol, at: allRows[exitIndex].closeAt, side: "sell", reason: fillRestriction(symbol, allRows[exitIndex], allRows[exitIndex - 1], "sell") });
          exitIndex += 1;
        }
        const exit = allRows[exitIndex];
        symbolCandidates.push({
          id: `${symbol}:${entry.openAt}`,
          symbol,
          signalAt: pointInTimeQuote.asOf,
          entryAt: entry.openAt,
          exitAt: exit?.closeAt ?? null,
          entryPrice: entry.open,
          exitPrice: exit?.close ?? null,
          holdingSessions: exit ? exitIndex - entryIndex : null,
          minimumHoldingSessions: rules.minimumHoldingSessions ?? 0,
          exitDeferredSessions: exit ? exitIndex - plannedExitIndex : null,
          score: signal.score,
          reasons: signal.reasons,
        });
        index += 1;
      }
      candidates.push(...symbolCandidates);
      bySymbol.push({
        symbol,
        observations: allRows.length,
        firstObservationAt: allRows[0]?.availableAt ?? null,
        lastObservationAt: allRows.at(-1)?.availableAt ?? null,
        excludedBars: prepared.excluded,
        marketRules: prepared.rules,
      });
    } catch (error) {
      delete histories[symbol];
      delete corporateActions[symbol];
      bySymbol.push({ symbol, error: error.message, metrics: summarizeTrades([]), trades: [] });
    }
  }
  const currencies = [...new Set(Object.keys(histories).map((symbol) => getInstrumentRules(symbol).currency))];
  const currency = String(input.currency ?? (currencies.length === 1 ? currencies[0] : "USD")).toUpperCase();
  const portfolio = simulatePortfolio({ candidates, histories, corporateActions, initialCapital: input.initialCapital ?? 100000, currency, fxRates: input.fxRates ?? {}, maxPositionPct: input.maxPositionPct ?? 20, maxGrossExposurePct: input.maxGrossExposurePct ?? 100, transactionCostBps, slippageBps, lotSizes: input.lotSizes ?? {} });
  for (const result of bySymbol) {
    if (result.error) continue;
    const trades = portfolio.trades.filter((trade) => trade.symbol === result.symbol);
    result.metrics = summarizeTrades(trades);
    result.trades = input.includeTrades === false ? [] : trades.slice(-500);
  }
  return {
    schemaVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    strategy: { name: strategy.name, version: strategy.version },
    assumptions: {
      range,
      warmupDays,
      holdingPeriodDays,
      transactionCostBpsPerSide: transactionCostBps,
      slippageBpsPerSide: slippageBps,
      currency,
      asOf,
      fxRates: input.fxRates ?? {},
      fxModel: "Explicit constant conversion rates into account currency; no historical currency gains or losses are simulated.",
      costs: "All-in proportional commission/levy/tax estimate per side, plus adverse execution slippage. Configure for the market and account; not an exchange fee schedule.",
      allocation: { initialCapital: input.initialCapital ?? 100000, maxPositionPct: input.maxPositionPct ?? 20, maxGrossExposurePct: input.maxGrossExposurePct ?? 100, sameTimePriority: "alphabetical symbol order" },
      signalTiming: "Signal uses data through day T close; entry uses day T+1 open; exit uses a later close.",
      positionModel: "Shared cash, simultaneous long positions, board-lot rounding, completed-bar mark-to-market equity. A-equity exit obeys the later-session restriction.",
      corporateActionModel: "Raw execution prices; explicit splits adjust held units and cash dividends credit eligible positions at ex-date. Withholding and settlement delays are not modeled.",
    },
    metrics: { ...summarizeTrades(portfolio.trades), ...portfolio.metrics },
    equityCurve: portfolio.equityCurve,
    openPositions: portfolio.openPositions,
    unfilled: [...unfilled, ...portfolio.skipped],
    bySymbol,
    leakageChecks: {
      signalBeforeEntry: candidates.every((trade) => Date.parse(trade.signalAt) < Date.parse(trade.entryAt)),
      entryNoLaterThanExit: portfolio.trades.every((trade) => Date.parse(trade.entryAt) < Date.parse(trade.exitAt)),
      marketHoldingMinimumMet: portfolio.trades.every((trade) => trade.holdingSessions >= trade.minimumHoldingSessions),
      completedBarsOnly: true,
      evidenceRule: "News or filings are excluded unless supplied by a point-in-time provider with availableAt timestamps.",
    },
    limitations: [
      "Historical prices currently come from Yahoo Finance and are not a licensed exchange-grade dataset.",
      "Survivorship, delistings, intraday order queues, trade-size participation, settlement cash, historical FX and exact dated fee schedules are not fully modeled.",
      "Price-limit fills use conservative daily-bar rejection; historical ST/IPO and instrument exemptions require verified per-bar rule inputs. HK board lots require explicit lotSizes.",
      "A strategy with few trades or a short history is not statistically validated.",
      "Backtest performance is not a forecast of future returns.",
    ],
  };
}

function normalizeResearchActions(actions, rows) {
  return actions.map((action) => {
    const type = action.type ?? action.kind;
    const date = action.sessionDate ?? action.date ?? String(action.effectiveAt ?? "").slice(0, 10);
    const row = rows.find((item) => item.sessionDate === String(date).slice(0, 10));
    const effectiveAt = row?.openAt ?? action.effectiveAt;
    if (!["split", "dividend"].includes(type) || !Number.isFinite(Date.parse(effectiveAt))) throw new Error("Unsupported or undated corporate action");
    const ratio = finite(action.ratio ?? action.splitRatio);
    const cashPerShare = finite(action.cashPerShare ?? action.amount);
    if (type === "split" && !(ratio > 0) || type === "dividend" && !(cashPerShare >= 0)) throw new Error("Invalid corporate action value");
    return { type, effectiveAt, ratio, cashPerShare };
  }).filter((action) => rows.length && Date.parse(action.effectiveAt) >= Date.parse(rows[0].openAt) && Date.parse(action.effectiveAt) <= Date.parse(rows.at(-1).closeAt));
}

function verifyActionCoverage(rows, actions) {
  for (let index = 1; index < rows.length; index += 1) {
    const current = finite(rows[index].adjustmentFactor) ?? (rows[index].adjustedClose > 0 ? rows[index].adjustedClose / rows[index].close : null);
    const previous = finite(rows[index - 1].adjustmentFactor) ?? (rows[index - 1].adjustedClose > 0 ? rows[index - 1].adjustedClose / rows[index - 1].close : null);
    if (current && previous && Math.abs(current / previous - 1) > 0.0001 && !actions.some((action) => Date.parse(action.effectiveAt) > Date.parse(rows[index - 1].openAt) && Date.parse(action.effectiveAt) <= Date.parse(rows[index].closeAt))) throw new Error(`Unexplained adjustment-factor change at ${rows[index].sessionDate}; corporate-action records required`);
  }
}

function applyCorporateActionReferences(rows, actions) {
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.previousClose > 0) continue;
    let reference = rows[index - 1].close;
    for (const action of actions.filter((item) => Date.parse(item.effectiveAt) > Date.parse(rows[index - 1].openAt) && Date.parse(item.effectiveAt) <= Date.parse(row.openAt)).sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt))) {
      reference = action.type === "split" ? reference / action.ratio : reference - action.cashPerShare;
    }
    row.previousClose = reference;
  }
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

export function fitLogisticBaseline(matrix, outcomes, options = {}) {
  if (!Array.isArray(matrix) || !matrix.length || matrix.length !== outcomes.length) throw new Error("训练矩阵与 outcome 数量必须一致且非空");
  const featureCount = matrix[0].length;
  if (!featureCount || matrix.some((row) => row.length !== featureCount || row.some((value) => !Number.isFinite(value)))) throw new Error("训练矩阵必须是完整的有限数值矩阵");
  if (outcomes.some((value) => ![0, 1].includes(value))) throw new Error("outcome 必须是 0 或 1");
  const means = Array.from({ length: featureCount }, (_, index) => average(matrix.map((row) => row[index])));
  const deviations = Array.from({ length: featureCount }, (_, index) => standardDeviation(matrix.map((row) => row[index])) || 1);
  const normalized = matrix.map((row) => row.map((value, index) => (value - means[index]) / deviations[index]));
  const weights = Array(featureCount + 1).fill(0);
  const iterations = Math.max(100, Math.min(2000, Number(options.iterations) || 800));
  const learningRate = Math.max(0.001, Math.min(0.5, finite(options.learningRate) ?? 0.05));
  const l2 = Math.max(0, Math.min(1, finite(options.l2) ?? 0.01));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = Array(featureCount + 1).fill(0);
    for (let rowIndex = 0; rowIndex < normalized.length; rowIndex += 1) {
      const row = normalized[rowIndex];
      const probability = sigmoid(weights[0] + row.reduce((sum, value, index) => sum + value * weights[index + 1], 0));
      const error = probability - outcomes[rowIndex];
      gradient[0] += error;
      row.forEach((value, index) => { gradient[index + 1] += error * value; });
    }
    weights[0] -= learningRate * gradient[0] / normalized.length;
    for (let index = 1; index < weights.length; index += 1) {
      weights[index] -= learningRate * (gradient[index] / normalized.length + l2 * weights[index]);
    }
  }
  return {
    means,
    deviations,
    weights,
    predict(row) {
      if (!Array.isArray(row) || row.length !== featureCount || row.some((value) => !Number.isFinite(value))) return null;
      const normalizedRow = row.map((value, index) => (value - means[index]) / deviations[index]);
      return sigmoid(weights[0] + normalizedRow.reduce((sum, value, index) => sum + value * weights[index + 1], 0));
    },
    contributions(row) {
      if (!Array.isArray(row) || row.length !== featureCount || row.some((value) => !Number.isFinite(value))) return [];
      return row.map((value, index) => weights[index + 1] * ((value - means[index]) / deviations[index]));
    },
  };
}

function rocAuc(predictions) {
  const positives = predictions.filter((item) => item.outcome === 1).length;
  const negatives = predictions.length - positives;
  if (!positives || !negatives) return null;
  const sorted = [...predictions].sort((left, right) => left.probability - right.probability);
  let rankSum = 0;
  let index = 0;
  while (index < sorted.length) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].probability === sorted[index].probability) end += 1;
    const averageRank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor += 1) {
      if (sorted[cursor].outcome === 1) rankSum += averageRank;
    }
    index = end;
  }
  return (rankSum - positives * (positives + 1) / 2) / (positives * negatives);
}

function predictionSamples(symbol, rows, features, horizonDays, transactionCostBps, slippageBps, actions = []) {
  const samples = [];
  const warmupDays = 60;
  for (let index = warmupDays - 1; index < rows.length - horizonDays; index += 1) {
    const quote = historicalQuote(symbol, rows, index);
    const vector = features.map((feature) => quoteFeature(quote, feature));
    if (vector.some((value) => !Number.isFinite(value))) continue;
    const entryIndex = index + 1;
    const entry = rows[entryIndex];
    const minimum = getInstrumentRules(symbol, { asOf: entry.openAt }).minimumHoldingSessions ?? 0;
    let exitIndex = entryIndex + Math.max(horizonDays - 1, minimum);
    while (exitIndex < rows.length && fillRestriction(symbol, rows[exitIndex], rows[exitIndex - 1], "sell")) exitIndex += 1;
    const exit = rows[exitIndex];
    if (!(entry?.open > 0) || !(exit?.close > 0)) continue;
    if (Date.parse(quote.asOf) >= Date.parse(entry.openAt) || fillRestriction(symbol, entry, rows[index], "buy")) continue;
    let units = 1;
    let dividends = 0;
    for (const action of actions.filter((item) => Date.parse(item.effectiveAt) > Date.parse(entry.openAt) && Date.parse(item.effectiveAt) <= Date.parse(exit.closeAt)).sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt))) {
      if (action.type === "split") units *= action.ratio;
      else dividends += units * action.cashPerShare;
    }
    const cost = entry.open * (1 + slippageBps / 10000) * (1 + transactionCostBps / 10000);
    const proceeds = units * exit.close * (1 - slippageBps / 10000) * (1 - transactionCostBps / 10000) + dividends;
    const netReturn = proceeds / cost - 1;
    samples.push({
      symbol,
      featureAt: quote.asOf,
      entryAt: entry.openAt,
      resolvedAt: exit.availableAt,
      vector,
      outcome: netReturn > 0 ? 1 : 0,
      netReturnPct: round(netReturn * 100, 3),
    });
  }
  return samples;
}

export async function runBaselinePrediction(input) {
  const symbols = [...new Set((input.symbols ?? []).map(normalizeSymbol))].slice(0, 5);
  if (!symbols.length) throw new Error("run_prediction_model 至少需要一个 symbol");
  const range = ["2y", "5y"].includes(input.range) ? input.range : "2y";
  const horizonDays = Math.max(1, Math.min(20, Number(input.horizonDays) || 5));
  const holdoutPct = Math.max(20, Math.min(40, finite(input.holdoutPct) ?? 30));
  const transactionCostBps = Math.max(0, Math.min(500, finite(input.transactionCostBps) ?? 10));
  const slippageBps = Math.max(0, Math.min(500, finite(input.slippageBps) ?? 5));
  const foldsRequested = Math.max(3, Math.min(5, Math.trunc(input.folds ?? 3)));
  const asOf = researchAsOf(input.asOf);
  const features = [...new Set(input.features?.length ? input.features : BASELINE_PREDICTION_FEATURES)];
  if (features.some((feature) => !BASELINE_PREDICTION_FEATURES.includes(feature))) throw new Error("预测基线仅支持声明的 point-in-time 技术特征");
  const results = [];

  for (const symbol of symbols) {
    try {
      const historical = executionHistory(input.historyBySymbol?.[symbol] ?? await getHistoricalQuote(symbol, { range }));
      const prepared = prepareDailyHistory(symbol, historical.history, asOf);
      if (prepared.rules.instrumentType !== "equity") throw new Error("This instrument requires verified tradability, holding and lot rules before prediction");
      const rows = prepared.rows;
      const actions = normalizeResearchActions(historical.corporateActions ?? [], rows);
      verifyActionCoverage(rows, actions);
      applyCorporateActionReferences(rows, actions);
      const samples = predictionSamples(symbol, rows, features, horizonDays, transactionCostBps, slippageBps, actions);
      const walkForward = purgedWalkForwardFolds(samples, { folds: foldsRequested, holdoutPct });
      if (walkForward.length < 3) {
        results.push({ symbol, status: "observe", qualification: { qualified: false, status: "observe", reasons: ["insufficient-samples-for-three-purged-folds"], newExposureAllowed: false, recommendedNewExposure: 0 }, probabilityPositive: null, probabilityNegative: null, observations: samples.length, excludedBars: prepared.excluded, model: "logistic-walk-forward-v2" });
        continue;
      }
      const holdoutPredictions = [];
      const baselinePredictions = [];
      const folds = [];
      for (const fold of walkForward) {
        const fitted = fitLogisticBaseline(fold.training.map((sample) => sample.vector), fold.training.map((sample) => sample.outcome));
        const prevalence = average(fold.training.map((sample) => sample.outcome));
        const predictions = fold.evaluation.map((sample) => ({ probability: fitted.predict(sample.vector), outcome: sample.outcome, predictedAt: sample.featureAt, resolvedAt: sample.resolvedAt }));
        const baseline = predictions.map((item) => ({ ...item, probability: prevalence }));
        const quality = evaluateProbabilityCalibration({ predictions });
        const baselineQuality = evaluateProbabilityCalibration({ predictions: baseline });
        holdoutPredictions.push(...predictions);
        baselinePredictions.push(...baseline);
        folds.push({ fold: fold.fold, trainingObservations: fold.training.length, evaluationObservations: fold.evaluation.length, trainingEndAt: fold.training.at(-1).resolvedAt, evaluationStartAt: fold.evaluation[0].featureAt, evaluationEndAt: fold.evaluation.at(-1).resolvedAt, purgedObservations: fold.purged, brierScore: quality.brierScore, baselineBrierScore: baselineQuality.brierScore, brierSkill: round(baselineQuality.brierScore - quality.brierScore, 6), rocAuc: round(rocAuc(predictions), 4), purged: fold.training.every((sample) => Date.parse(sample.resolvedAt) < Date.parse(fold.evaluation[0].featureAt)) });
      }
      const calibration = evaluateProbabilityCalibration({ predictions: holdoutPredictions, bins: 10 });
      const baselineCalibration = evaluateProbabilityCalibration({ predictions: baselinePredictions, bins: 10 });
      const latestQuote = historicalQuote(symbol, rows, rows.length - 1);
      const training = samples.filter((sample) => Date.parse(sample.resolvedAt) < Date.parse(latestQuote.asOf));
      const model = fitLogisticBaseline(training.map((sample) => sample.vector), training.map((sample) => sample.outcome));
      const latestVector = features.map((feature) => quoteFeature(latestQuote, feature));
      const currentProbability = model.predict(latestVector);
      const drift = monitorFeatureDrift({ series: features.map((feature, index) => ({ feature, baseline: training.slice(0, -30).map((sample) => sample.vector[index]), current: training.slice(-30).map((sample) => sample.vector[index]) })) });
      const qualification = qualifyPrediction({ folds, calibration, baselineCalibration, auc: rocAuc(holdoutPredictions), latestFeaturesComplete: currentProbability !== null, stale: Date.parse(asOf) - Date.parse(latestQuote.asOf) > 4 * 86400000, drift: drift.status === "drift" });
      const modelVersion = `logistic-walk-forward-v2:${hashValue({ features, horizonDays, transactionCostBps, slippageBps, trainingEndAt: training.at(-1).resolvedAt, weights: model.weights }).slice(0, 16)}`;
      const generatedAt = new Date().toISOString();
      const ledger = await recordPrediction({ symbol, model: "logistic-walk-forward-v2", modelVersion, featureAt: latestQuote.asOf, recordedAt: generatedAt, probability: currentProbability, qualification, horizonDays: Math.max(horizonDays, (getInstrumentRules(symbol).minimumHoldingSessions ?? 0) + 1), transactionCostBps, slippageBps, features, featureValues: latestVector, weights: model.weights, means: model.means, deviations: model.deviations, validation: { folds, calibration, baselineCalibration, driftStatus: drift.status }, researchAsOf: asOf });
      const contributions = model.contributions(latestVector)
        .map((impact, index) => ({ feature: features[index], value: round(latestVector[index]), logOddsImpact: round(impact) }))
        .sort((left, right) => Math.abs(right.logOddsImpact) - Math.abs(left.logOddsImpact));
      results.push({
        symbol,
        status: qualification.status,
        qualification: { ...qualification, validUntil: ledger.qualification.validUntil },
        model: "logistic-walk-forward-v2",
        modelVersion,
        target: `从下一交易日开盘到第 ${horizonDays} 个交易日收盘的成本后收益是否为正`,
        predictedAt: ledger.recordedAt,
        featureAt: latestQuote.asOf,
        predictionId: ledger.id,
        ledgerStatus: ledger.status,
        probabilityPositive: qualification.qualified ? round(currentProbability, 4) : null,
        probabilityNegative: qualification.qualified ? round(1 - currentProbability, 4) : null,
        features: contributions,
        drift,
        excludedBars: prepared.excluded,
        validation: { method: "purged-expanding-walk-forward", folds, baseline: { name: "training-positive-rate", ...baselineCalibration }, leakageChecks: { allLabelsResolvedBeforeFold: folds.every((fold) => fold.purged), noEvaluationOverlap: new Set(holdoutPredictions.map((item) => item.predictedAt)).size === holdoutPredictions.length, completedBarsOnly: true }, caveat: "Evaluation observations can have overlapping forward horizons; no independent-sample significance claim is made. Earlier folds may become training data only after their outcomes are historically available." },
        training: {
          observations: training.length,
          startAt: training[0].featureAt,
          endAt: training.at(-1).resolvedAt,
          positiveRate: round(average(training.map((sample) => sample.outcome)), 4),
        },
        holdout: {
          observations: holdoutPredictions.length,
          startAt: holdoutPredictions[0].predictedAt,
          endAt: holdoutPredictions.at(-1).resolvedAt,
          positiveRate: round(average(holdoutPredictions.map((sample) => sample.outcome)), 4),
          rocAuc: round(rocAuc(holdoutPredictions), 4),
          brierScore: calibration.brierScore,
          logLoss: calibration.logLoss,
          expectedCalibrationError: calibration.expectedCalibrationError,
          directionalAccuracyPct: calibration.directionalAccuracyPct,
          calibration: calibration.calibration,
        },
      });
    } catch (error) {
      results.push({ symbol, status: "rejected", probabilityPositive: null, probabilityNegative: null, qualification: { qualified: false, status: "rejected", newExposureAllowed: false, recommendedNewExposure: 0, reasons: [error.message] }, error: error.message });
    }
  }

  const assessmentTask = predictionWriteQueue.then(async () => {
    const target = path.join(foundationDirectory(), "model-assessments.json");
    const assessments = await loadJson(target, {});
    for (const result of results) assessments[result.symbol] = { evaluatedAt: new Date().toISOString(), status: result.status, predictionId: result.predictionId ?? null };
    await atomicWriteJson(target, assessments);
  });
  predictionWriteQueue = assessmentTask.catch(() => {});
  await assessmentTask;
  for (const result of results) {
    if (!result.predictionId) continue;
    const ledger = await queryPredictionLedger({ symbol: result.symbol, limit: 1000 });
    const recorded = ledger.records.find((record) => record.id === result.predictionId);
    const currentlyEligible = recorded?.qualification.currentlyEligible === true && result.qualification.qualified;
    result.qualification.currentlyEligible = currentlyEligible;
    if (result.qualification.qualified && !currentlyEligible) {
      result.status = "observe";
      result.qualification = { ...result.qualification, status: "observe", qualified: false, newExposureAllowed: false, recommendedNewExposure: 0, reasons: [...result.qualification.reasons, "recorded-forecast-expired-resolved-or-superseded"] };
      result.probabilityPositive = null;
      result.probabilityNegative = null;
    }
  }

  return {
    schemaVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    model: "logistic-walk-forward-v2",
    assumptions: { range, horizonDays, holdoutPct, folds: foldsRequested, asOf, transactionCostBpsPerSide: transactionCostBps, slippageBpsPerSide: slippageBps, features },
    results,
    meaning: "Probabilities are released only when every programmed research gate passes. Unqualified models allow zero new exposure. Predictions are recorded before future outcomes and remain experimental research, never trade instructions.",
    limitations: [
      "The baseline excludes news, filings, fundamentals, survivorship, historical FX and exact taxes; explicit splits/dividends and proportional cost assumptions are supported.",
      "Each symbol is trained independently on Yahoo Finance daily history.",
      "Repeated walk-forward validation reduces leakage but does not prove stability under future regimes. Model and gate choices still require independent evaluation.",
      "No trade should be placed from this probability alone.",
    ],
  };
}

export async function recordPrediction(record) {
  const recordedAt = asIso(record.recordedAt, "recordedAt");
  if (Date.parse(recordedAt) > Date.now() || Date.now() - Date.parse(recordedAt) > 60_000) throw new Error("Predictions must be recorded now; backdated and future records are forbidden");
  const featureAt = asIso(record.featureAt, "featureAt");
  if (Date.parse(featureAt) > Date.parse(recordedAt)) throw new Error("Prediction features cannot become available after recording");
  if (!Number.isFinite(record.probability) || !(record.probability >= 0 && record.probability <= 1)) throw new Error("Prediction probability must be finite and within [0, 1]");
  const id = `prediction_${hashValue({ symbol: record.symbol, modelVersion: record.modelVersion, featureAt, horizonDays: record.horizonDays }).slice(0, 32)}`;
  const task = predictionWriteQueue.then(async () => {
    const target = path.join(foundationDirectory(), "predictions.json");
    const current = await loadJson(target, []);
    const existing = current.find((item) => item.id === id);
    if (existing) return existing;
    const validUntil = new Date(Date.parse(recordedAt) + 24 * 60 * 60 * 1000).toISOString();
    const saved = { ...record, id, featureAt, recordedAt, status: "pending", qualification: { ...record.qualification, validUntil }, outcome: null, resolvedAt: null };
    current.push(saved);
    await atomicWriteJson(target, current);
    return saved;
  });
  predictionWriteQueue = task.catch(() => {});
  return task;
}

export async function queryPredictionLedger(input = {}) {
  const symbol = input.symbol ? normalizeSymbol(input.symbol) : null;
  const limit = Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 100)));
  const records = await loadJson(path.join(foundationDirectory(), "predictions.json"), []);
  const assessments = await loadJson(path.join(foundationDirectory(), "model-assessments.json"), {});
  const matched = records.filter((record) => (!symbol || record.symbol === symbol) && (!input.status || record.status === input.status)).sort((left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt));
  const latestBySymbol = new Map([...records].sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt)).map((record) => [record.symbol, record.id]));
  return {
    totalMatched: matched.length,
    records: matched.slice(0, limit).map(({ weights, means, deviations, featureValues, probability, ...record }) => {
      const assessment = assessments[record.symbol];
      const latestAssessmentAllows = !assessment || Date.parse(assessment.evaluatedAt) < Date.parse(record.recordedAt) || assessment.status === "qualified" && assessment.predictionId === record.id;
      return { ...record, qualification: { ...record.qualification, currentlyEligible: record.qualification?.qualified === true && record.status === "pending" && Date.parse(record.qualification.validUntil) > Date.now() && latestBySymbol.get(record.symbol) === record.id && latestAssessmentAllows, supersededBy: latestBySymbol.get(record.symbol) === record.id ? null : latestBySymbol.get(record.symbol), latestAssessment: assessment ?? null }, probability: record.qualification?.qualified ? round(probability, 4) : null };
    }),
    recordingPolicy: "Immutable forecast fields, server timestamp at first insertion, outcomes appended only from completed history after recording. Research eligibility expires after 24 hours, resolution, or a newer model/evaluation for the symbol.",
  };
}

export async function resolvePredictionOutcomes(input = {}) {
  const asOf = researchAsOf(input.asOf);
  const records = await loadJson(path.join(foundationDirectory(), "predictions.json"), []);
  const pending = records.filter((item) => item.status === "pending" && (!input.ids?.length || input.ids.includes(item.id)));
  const histories = new Map();
  const updates = [];
  const errors = [];
  for (const record of pending) {
    try {
      if (!histories.has(record.symbol)) {
        const historical = executionHistory(input.historyBySymbol?.[record.symbol] ?? await getHistoricalQuote(record.symbol, { range: "2y" }));
        const prepared = prepareDailyHistory(record.symbol, historical.history, asOf);
        const actions = normalizeResearchActions(historical.corporateActions ?? [], prepared.rows);
        verifyActionCoverage(prepared.rows, actions);
        applyCorporateActionReferences(prepared.rows, actions);
        histories.set(record.symbol, { rows: prepared.rows, actions });
      }
      const { rows, actions } = histories.get(record.symbol);
      const entryIndex = rows.findIndex((row) => Date.parse(row.openAt) > Date.parse(record.recordedAt));
      if (entryIndex === -1) continue;
      const entry = rows[entryIndex];
      const restriction = fillRestriction(record.symbol, entry, rows[entryIndex - 1], "buy");
      if (restriction) { updates.push({ id: record.id, status: "unfilled", outcome: null, resolutionReason: restriction, resolvedAt: entry.availableAt, checkedAt: new Date().toISOString() }); continue; }
      let exitIndex = entryIndex + Math.max(record.horizonDays - 1, getInstrumentRules(record.symbol, { asOf: entry.openAt }).minimumHoldingSessions ?? 0);
      while (exitIndex < rows.length && fillRestriction(record.symbol, rows[exitIndex], rows[exitIndex - 1], "sell")) exitIndex += 1;
      if (exitIndex >= rows.length) continue;
      const exit = rows[exitIndex];
      if (Date.parse(record.recordedAt) >= Date.parse(entry.openAt) || Date.parse(exit.availableAt) > Date.parse(asOf)) throw new Error("Outcome timing failed point-in-time verification");
      let units = 1;
      let dividends = 0;
      for (const action of actions.filter((item) => Date.parse(item.effectiveAt) > Date.parse(entry.openAt) && Date.parse(item.effectiveAt) <= Date.parse(exit.closeAt)).sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt))) {
        if (action.type === "split") units *= action.ratio;
        else dividends += units * action.cashPerShare;
      }
      const entryCost = entry.open * (1 + record.slippageBps / 10000) * (1 + record.transactionCostBps / 10000);
      const proceeds = units * exit.close * (1 - record.slippageBps / 10000) * (1 - record.transactionCostBps / 10000) + dividends;
      const netReturnPct = (proceeds / entryCost - 1) * 100;
      updates.push({ id: record.id, status: "resolved", outcome: netReturnPct > 0 ? 1 : 0, netReturnPct: round(netReturnPct, 4), entryAt: entry.openAt, entryPrice: entry.open, exitAt: exit.closeAt, exitPrice: exit.close, resolvedAt: exit.availableAt, checkedAt: new Date().toISOString(), resolutionSource: "completed-daily-OHLC-with-corporate-actions" });
    } catch (error) { errors.push({ id: record.id, error: error.message }); }
  }
  const task = predictionWriteQueue.then(async () => {
    const target = path.join(foundationDirectory(), "predictions.json");
    const current = await loadJson(target, []);
    const byId = new Map(updates.map((update) => [update.id, update]));
    const next = current.map((record) => record.status === "pending" && byId.has(record.id) ? { ...record, ...byId.get(record.id) } : record);
    if (updates.length) await atomicWriteJson(target, next);
    const resolved = next.filter((item) => item.status === "resolved");
    const calibration = resolved.length ? evaluateProbabilityCalibration({ predictions: resolved.slice(-10000).map((item) => ({ probability: item.probability, outcome: item.outcome, predictedAt: item.recordedAt, resolvedAt: item.resolvedAt })) }) : null;
    return { asOf, checked: pending.length, updated: updates.length, updates, errors, liveCalibration: calibration };
  });
  predictionWriteQueue = task.catch(() => {});
  return task;
}

export function evaluateProbabilityCalibration(input) {
  const predictions = Array.isArray(input.predictions) ? input.predictions : [];
  if (!predictions.length) throw new Error("至少需要一条概率预测记录");
  if (predictions.length > 10_000) throw new Error("单次最多评估 10000 条概率预测");
  const bins = Math.max(5, Math.min(20, Number(input.bins) || 10));
  const normalized = predictions.map((item, index) => {
    const probability = finite(item.probability);
    const outcome = item.outcome === true ? 1 : item.outcome === false ? 0 : finite(item.outcome);
    if (probability === null || probability < 0 || probability > 1) throw new Error(`prediction ${index + 1} 的 probability 必须在 0 到 1 之间`);
    if (![0, 1].includes(outcome)) throw new Error(`prediction ${index + 1} 的 outcome 必须是 0 或 1`);
    const predictedAt = asIso(item.predictedAt, "predictedAt");
    const resolvedAt = asIso(item.resolvedAt, "resolvedAt");
    if (Date.parse(resolvedAt) <= Date.parse(predictedAt)) throw new Error(`prediction ${index + 1} 的 resolvedAt 必须晚于 predictedAt`);
    if (Date.parse(resolvedAt) > Date.now()) throw new Error(`prediction ${index + 1} outcome cannot be resolved in the future`);
    return { probability, outcome, predictedAt, resolvedAt };
  });
  const bucketRows = Array.from({ length: bins }, (_, index) => ({
    lower: index / bins,
    upper: (index + 1) / bins,
    rows: [],
  }));
  for (const item of normalized) bucketRows[Math.min(bins - 1, Math.floor(item.probability * bins))].rows.push(item);
  const calibration = bucketRows.map((bucket) => ({
    lower: round(bucket.lower, 3),
    upper: round(bucket.upper, 3),
    count: bucket.rows.length,
    meanProbability: bucket.rows.length ? round(average(bucket.rows.map((item) => item.probability)), 4) : null,
    observedFrequency: bucket.rows.length ? round(average(bucket.rows.map((item) => item.outcome)), 4) : null,
  }));
  const brierScore = average(normalized.map((item) => (item.probability - item.outcome) ** 2));
  const logLoss = average(normalized.map((item) => {
    const probability = Math.min(1 - 1e-12, Math.max(1e-12, item.probability));
    return -(item.outcome * Math.log(probability) + (1 - item.outcome) * Math.log(1 - probability));
  }));
  const expectedCalibrationError = calibration.reduce((sum, bucket) => {
    if (!bucket.count) return sum;
    return sum + bucket.count / normalized.length * Math.abs(bucket.meanProbability - bucket.observedFrequency);
  }, 0);
  return {
    schemaVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    observations: normalized.length,
    brierScore: round(brierScore, 6),
    logLoss: round(logLoss, 6),
    expectedCalibrationError: round(expectedCalibrationError, 6),
    directionalAccuracyPct: round(normalized.filter((item) => (item.probability >= 0.5 ? 1 : 0) === item.outcome).length / normalized.length * 100, 2),
    calibration,
    interpretation: "Lower Brier score, log loss, and calibration error are better. These metrics require outcomes resolved strictly after prediction time.",
  };
}

function populationStabilityIndex(baseline, current, bucketCount = 10) {
  const base = baseline.filter(Number.isFinite).sort((left, right) => left - right);
  const now = current.filter(Number.isFinite);
  if (base.length < 20 || now.length < 20) return null;
  const boundaries = Array.from({ length: bucketCount - 1 }, (_, index) => percentile(base, (index + 1) / bucketCount));
  const bucket = (value) => boundaries.findIndex((boundary) => value <= boundary);
  const indexFor = (value) => {
    const index = bucket(value);
    return index === -1 ? bucketCount - 1 : index;
  };
  const baseCounts = Array(bucketCount).fill(0);
  const currentCounts = Array(bucketCount).fill(0);
  base.forEach((value) => { baseCounts[indexFor(value)] += 1; });
  now.forEach((value) => { currentCounts[indexFor(value)] += 1; });
  const epsilon = 0.0001;
  return baseCounts.reduce((sum, count, index) => {
    const expected = Math.max(epsilon, count / base.length);
    const actual = Math.max(epsilon, currentCounts[index] / now.length);
    return sum + (actual - expected) * Math.log(actual / expected);
  }, 0);
}

export function monitorFeatureDrift(input) {
  const series = Array.isArray(input.series) ? input.series : [];
  if (!series.length) throw new Error("至少需要一个 feature series");
  const results = series.map((item) => {
    const name = String(item.feature ?? "").trim();
    const baselineRaw = Array.isArray(item.baseline) ? item.baseline : [];
    const currentRaw = Array.isArray(item.current) ? item.current : [];
    const baseline = baselineRaw.map(finite).filter(Number.isFinite);
    const current = currentRaw.map(finite).filter(Number.isFinite);
    if (!name || baseline.length < 20 || current.length < 20) throw new Error(`${name || "feature"} 的 baseline 和 current 各至少需要 20 个有效值`);
    const baselineMean = average(baseline);
    const currentMean = average(current);
    const baselineStd = standardDeviation(baseline);
    const standardizedMeanShift = baselineStd ? Math.abs(currentMean - baselineMean) / baselineStd : null;
    const psi = populationStabilityIndex(baseline, current);
    const missingRateDelta = currentRaw.length && baselineRaw.length
      ? currentRaw.filter((value) => finite(value) === null).length / currentRaw.length
        - baselineRaw.filter((value) => finite(value) === null).length / baselineRaw.length
      : null;
    const status = (psi ?? 0) >= 0.25 || (standardizedMeanShift ?? 0) >= 1 || Math.abs(missingRateDelta ?? 0) >= 0.2
      ? "drift"
      : (psi ?? 0) >= 0.1 || (standardizedMeanShift ?? 0) >= 0.5 || Math.abs(missingRateDelta ?? 0) >= 0.1
        ? "watch"
        : "stable";
    return {
      feature: name,
      status,
      baselineCount: baseline.length,
      currentCount: current.length,
      baselineMean: round(baselineMean),
      currentMean: round(currentMean),
      standardizedMeanShift: round(standardizedMeanShift),
      populationStabilityIndex: round(psi),
      missingRateDelta: round(missingRateDelta),
    };
  });
  return {
    schemaVersion: CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    status: results.some((item) => item.status === "drift") ? "drift" : results.some((item) => item.status === "watch") ? "watch" : "stable",
    features: results,
    thresholds: {
      psiWatch: 0.1,
      psiDrift: 0.25,
      standardizedMeanShiftWatch: 0.5,
      standardizedMeanShiftDrift: 1,
    },
    interpretation: "Drift indicates changed input distributions, not automatically lower investment performance. Investigate data and model behavior before retraining.",
  };
}
