import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assessQuoteFreshness, dailyBarMetadata, getInstrumentRules, getMarketSession, localMarketTime, marketLocalToIso, sameTimeVolumeRatio } from "./market-rules.mjs";
import { updateMonitorState } from "./monitor.mjs";
import { buildReportHtml } from "./dashboard.mjs";
import { configureIbkrDataClient, ibkrBars, ibkrQuote, ibkrScan } from "./ibkr-data-client.mjs";
import { rankedPage } from "./market-data.mjs";
export { buildReportHtml, buildEmptyHtml } from "./dashboard.mjs";

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const TENCENT_QUOTE = "https://qt.gtimg.cn/q";
const execFileAsync = promisify(execFile);
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export const OFFICIAL_WEBSITE = "https://hrouter.net/";

export const MARKET_INDICES = {
  A: ["000001.SS", "399001.SZ", "399006.SZ"],
  HK: ["^HSI", "^HSTECH", "^HSCE"],
  US: ["^GSPC", "^IXIC", "^DJI"],
};

const INDEX_NAMES = {
  "000001.SS": "上证指数",
  "399001.SZ": "深证成指",
  "399006.SZ": "创业板指",
  "^HSI": "恒生指数",
  "^HSTECH": "恒生科技",
  "^HSCE": "恒生中国企业指数",
  "^GSPC": "标普 500",
  "^IXIC": "纳斯达克",
  "^DJI": "道琼斯",
};

const TENCENT_INDEX_CODES = {
  "000001.SS": "sh000001",
  "399001.SZ": "sz399001",
  "399006.SZ": "sz399006",
  "^HSI": "hkHSI",
  "^HSTECH": "hkHSTECH",
  "^HSCE": "hkHSCEI",
  "^GSPC": "usINX",
  "^IXIC": "usIXIC",
  "^DJI": "usDJI",
};

const PHASE_LABELS = {
  premarket: "盘前简报",
  intraday: "盘中监控",
  postmarket: "盘后复盘",
  research: "个股研究",
};

function finite(value) {
  if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function standardDeviation(values) {
  const mean = average(values);
  if (mean === null || values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function lastFinite(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(values[index])) return values[index];
  }
  return null;
}

function emaSeries(values, period) {
  const result = Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  result[period - 1] = average(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    result[index] = values[index] * multiplier + result[index - 1] * (1 - multiplier);
  }
  return result;
}

export function normalizeSymbol(input) {
  const raw = String(input ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) throw new Error("股票代码不能为空");

  if (/^[A-Z0-9.^=-]+\.(SS|SZ|BJ|HK)$/.test(raw) || raw.startsWith("^")) return raw;
  if (/^HK\d{1,5}$/.test(raw)) {
    const code = String(Number(raw.slice(2))).padStart(4, "0");
    return `${code}.HK`;
  }
  if (/^\d{5}$/.test(raw)) {
    return `${String(Number(raw)).padStart(4, "0")}.HK`;
  }
  if (/^\d{6}$/.test(raw)) {
    return `${raw}.${/^(92|8|4)/.test(raw) ? "BJ" : /^[569]/.test(raw) ? "SS" : "SZ"}`;
  }
  if (/^[A-Z][A-Z0-9.-]{0,14}$/.test(raw)) return raw;
  throw new Error(`无法识别股票代码: ${input}`);
}

export function marketFromSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (/\.(SS|SZ|BJ)$/.test(normalized)) return "A";
  if (normalized.endsWith(".HK") || ["^HSI", "^HSTECH", "^HSCE"].includes(normalized)) return "HK";
  return "US";
}

export function computeIndicators(closes, highs = [], lows = [], volumes = []) {
  const aligned = closes.map((value, index) => ({ close: finite(value), high: finite(highs[index]), low: finite(lows[index]), volume: finite(volumes[index]) }));
  const lastGap = aligned.findLastIndex((row) => row.close === null || row.close <= 0);
  const rows = aligned.slice(lastGap + 1);
  const cleanCloses = rows.map((row) => row.close);
  if (!cleanCloses.length) return { ...emptyIndicators(), sampleCount: 0, period: "1d", method: "wilder-rsi14-sma-seeded-ema" };

  const sma = (period) => cleanCloses.length >= period ? average(cleanCloses.slice(-period)) : null;
  const deltas = cleanCloses.slice(1).map((value, index) => value - cleanCloses[index]);
  let rsi14 = null;
  if (deltas.length >= 14) {
    let avgGain = average(deltas.slice(0, 14).map((value) => Math.max(value, 0)));
    let avgLoss = average(deltas.slice(0, 14).map((value) => Math.max(-value, 0)));
    for (const delta of deltas.slice(14)) {
      avgGain = (avgGain * 13 + Math.max(delta, 0)) / 14;
      avgLoss = (avgLoss * 13 + Math.max(-delta, 0)) / 14;
    }
    rsi14 = avgGain === 0 && avgLoss === 0 ? 50 : avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  const ema12 = emaSeries(cleanCloses, 12);
  const ema26 = emaSeries(cleanCloses, 26);
  const macdSeries = cleanCloses.map((_, index) => ema12[index] !== null && ema26[index] !== null ? ema12[index] - ema26[index] : null).filter(Number.isFinite);
  const signalSeries = emaSeries(macdSeries, 9);
  const macd = lastFinite(macdSeries);
  const macdSignal = lastFinite(signalSeries);

  const returns = cleanCloses.slice(1).map((value, index) => Math.log(value / cleanCloses[index]));
  const volatility = returns.length >= 60 ? standardDeviation(returns.slice(-60)) : null;

  let peak = cleanCloses[Math.max(0, cleanCloses.length - 60)];
  let maxDrawdown = 0;
  for (const value of cleanCloses.slice(-60)) {
    peak = Math.max(peak, value);
    maxDrawdown = Math.min(maxDrawdown, value / peak - 1);
  }

  const cleanHighs = rows.slice(-20).map((row) => row.high);
  const cleanLows = rows.slice(-20).map((row) => row.low);
  const cleanVolumes = rows.slice(-21).map((row) => row.volume);
  const hasVolumeWindow = cleanVolumes.length === 21 && cleanVolumes.every((value) => Number.isFinite(value) && value >= 0);
  const recentVolumeAverage = hasVolumeWindow ? average(cleanVolumes.slice(0, -1)) : null;
  const latestVolume = hasVolumeWindow ? cleanVolumes.at(-1) : null;
  const latest = lastFinite(cleanCloses);
  const sma20 = sma(20);
  const sma60 = sma(60);

  let trend = "数据不足";
  if (latest !== null && sma20 !== null) {
    if (latest > sma20 && (sma60 === null || sma20 > sma60)) trend = "上行";
    else if (latest < sma20 && (sma60 === null || sma20 < sma60)) trend = "下行";
    else trend = "震荡";
  }

  return {
    sma5: sma(5),
    sma20,
    sma60,
    rsi14,
    macd,
    macdSignal,
    annualizedVolatilityPct: volatility === null ? null : volatility * Math.sqrt(252) * 100,
    maxDrawdown60dPct: cleanCloses.length >= 60 ? maxDrawdown * 100 : null,
    support20d: cleanLows.length === 20 && cleanLows.every((value) => value !== null && value > 0) ? Math.min(...cleanLows) : null,
    resistance20d: cleanHighs.length === 20 && cleanHighs.every((value) => value !== null && value > 0) ? Math.max(...cleanHighs) : null,
    volumeRatio20d: recentVolumeAverage > 0 && latestVolume !== null ? latestVolume / recentVolumeAverage : null,
    trend, sampleCount: cleanCloses.length, period: "1d", method: "wilder-rsi14-sma-seeded-ema", volumeRatioBasis: "completed-day-vs-previous-20-completed-days",
  };
}

async function fetchJson(url, timeoutMs = 15000, allowCurlRetry = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        "User-Agent": BROWSER_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`);
      error.httpStatus = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (!allowCurlRetry || ![403, 429].includes(error.httpStatus)) throw error;
    const curl = process.platform === "win32" ? "curl.exe" : "curl";
    try {
      const { stdout } = await execFileAsync(curl, [
        "-fsSL",
        "--max-time",
        String(Math.ceil(timeoutMs / 1000)),
        "-A",
        BROWSER_USER_AGENT,
        "-H",
        "Accept: application/json",
        url,
      ], {
        encoding: "utf8",
        maxBuffer: 25 * 1024 * 1024,
        timeout: timeoutMs + 2000,
        windowsHide: true,
      });
      return JSON.parse(stdout);
    } catch (curlError) {
      throw new Error(`行情请求失败: ${error.message}; curl fallback: ${curlError.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function getYahooQuote(input, options = {}) {
  const symbol = normalizeSymbol(input);
  const interval = options.interval ?? "1d";
  const range = options.range ?? "6mo";
  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&events=div%2Csplits`;
  const payload = await fetchJson(url, options.timeoutMs ?? 15000, false);
  return parseYahooChart(input, payload, options);
}

/**
 * Dividends and splits (incl. bonus-share issues, which Yahoo reports as splits) for paper-account
 * corporate actions. Dates are local ex-dates; dividends are cash per share in the quote currency.
 */
export async function getCorporateActions(input, { range = "3mo", timeoutMs = 10000 } = {}) {
  const quote = await getYahooQuote(input, { interval: "1d", range, timeoutMs });
  return quote.corporateActions ?? [];
}

export function parseYahooChart(input, payload, options = {}) {
  const symbol = normalizeSymbol(input);
  const market = marketFromSymbol(symbol);
  const interval = options.interval ?? "1d";
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description ?? `未取得 ${symbol} 行情`);

  const quote = result.indicators?.quote?.[0] ?? {};
  const timestamps = result.timestamp ?? [];
  const rawRows = timestamps.map((timestamp, index) => ({
    timestamp: new Date(timestamp * 1000).toISOString(),
    open: finite(quote.open?.[index]),
    high: finite(quote.high?.[index]),
    low: finite(quote.low?.[index]),
    close: finite(quote.close?.[index]),
    volume: finite(quote.volume?.[index]),
    adjustedClose: finite(result.indicators?.adjclose?.[0]?.adjclose?.[index]),
    ...(interval === "1d" ? dailyBarMetadata(new Date(timestamp * 1000).toISOString(), market, options) : {}),
  }));
  const invalidPriceRows = rawRows.filter((row) => row.close === null || row.close <= 0).length;
  const rows = rawRows.map((row) => ({ ...row, close: row.close > 0 ? row.close : null,
    adjustmentFactor: row.adjustedClose > 0 && row.close > 0 ? row.adjustedClose / row.close : null }));

  const meta = result.meta ?? {};
  const closes = rows.map((row) => row.close);
  const currentPrice = finite(meta.regularMarketPrice) ?? lastFinite(closes);
  if (!(currentPrice > 0)) throw new Error(`Yahoo returned an invalid price for ${symbol}`);
  const latestTimestamp = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null;
  const quoteDate = latestTimestamp ? localMarketTime(latestTimestamp, market)?.date : null;
  const priorDailyClose = interval === "1d" && quoteDate ? rows.filter((row) => row.sessionDate < quoteDate).at(-1)?.close : null;
  const reportedChange = finite(meta.regularMarketChange);
  const previousClose = reportedChange !== null && currentPrice !== null
    ? currentPrice - reportedChange
    : finite(meta.previousClose) ?? priorDailyClose ?? null;
  const change = reportedChange ?? (currentPrice !== null && previousClose ? currentPrice - previousClose : null);
  const changePct = finite(meta.regularMarketChangePercent) ?? (change !== null && previousClose ? change / previousClose * 100 : null);
  const name = INDEX_NAMES[symbol] ?? meta.longName ?? meta.shortName ?? symbol;
  const completedRows = rows.filter((row) => row.complete === true);
  const adjustmentAnchor = rows.findLast((row) => row.adjustmentFactor > 0)?.adjustmentFactor ?? 1;
  const indicatorRows = completedRows.map((row) => {
    const factor = row.adjustmentFactor > 0 ? row.adjustmentFactor / adjustmentAnchor : 1;
    return { ...row, close: row.close === null ? null : row.close * factor, high: row.high === null ? null : row.high * factor, low: row.low === null ? null : row.low * factor };
  });
  const indicators = computeIndicators(
    indicatorRows.map((row) => row.close),
    indicatorRows.map((row) => row.high),
    indicatorRows.map((row) => row.low),
    indicatorRows.map((row) => row.volume),
  );
  indicators.asOf = completedRows.at(-1)?.availableAt ?? null;
  indicators.priceBasis = "adjusted-to-latest-raw-price";
  const qualityWarnings = [];
  if (invalidPriceRows) qualityWarnings.push(`已忽略 ${invalidPriceRows} 条零值或负值历史行情`);
  if ((indicators.volumeRatio20d ?? 0) > 100) {
    indicators.volumeRatio20d = null;
    qualityWarnings.push("当前成交量与历史口径差异过大，量比已停用");
  }

  const corporateActions = [
    ...Object.values(result.events?.splits ?? {}).map((event) => ({ type: "split", effectiveAt: new Date(event.date * 1000).toISOString(), date: localMarketTime(event.date * 1000, market)?.date, ratio: event.numerator / event.denominator })),
    ...Object.values(result.events?.dividends ?? {}).map((event) => ({ type: "dividend", effectiveAt: new Date(event.date * 1000).toISOString(), date: localMarketTime(event.date * 1000, market)?.date, cashPerShare: event.amount, currency: meta.currency ?? null })),
  ];
  if (corporateActions.some((event) => event.type === "split" && event.date >= completedRows.at(-21)?.sessionDate)) {
    indicators.volumeRatio20d = null;
    qualityWarnings.push("Recent split affects historical volume comparability; daily volume ratio withheld.");
  }

  return {
    input: String(input),
    symbol,
    market,
    name,
    currency: meta.currency ?? null,
    exchange: meta.exchangeName ?? meta.fullExchangeName ?? null,
    exchangeTimezone: meta.exchangeTimezoneName ?? null,
    marketState: meta.marketState ?? null,
    price: currentPrice,
    previousClose,
    change,
    changePct,
    dayHigh: finite(meta.regularMarketDayHigh) ?? rows.at(-1)?.high,
    dayLow: finite(meta.regularMarketDayLow) ?? rows.at(-1)?.low,
    volume: finite(meta.regularMarketVolume) ?? rows.at(-1)?.volume ?? null,
    asOf: latestTimestamp,
    source: "Yahoo Finance chart API",
    provider: "Yahoo Finance",
    freshnessNotice: "公开行情可能延迟；下单前必须以券商行情复核。",
    dataQuality: {
      status: qualityWarnings.length ? "warning" : "ok",
      warnings: qualityWarnings,
    },
    indicators,
    alerts: [],
    period: interval,
    historyPriceBasis: "split-adjusted",
    corporateActions,
    history: rows.slice(-(options.historyLimit ?? 60)),
  };
}

// ---------------------------------------------------------------------------
// TWS first for US stocks. The workbench service keeps one read-only TWS data session; when it is
// connected, US quotes, bars and scans come from Interactive Brokers and the public sources below
// become the cross-check and fallback. Delayed TWS data (a login without a real-time subscription)
// is only attached as a labelled reference; it never becomes the price a decision or order uses.
// ---------------------------------------------------------------------------

let ibkrClientConfigured = false;
function tws() {
  if (!ibkrClientConfigured) { configureIbkrDataClient({ storageDir: getStorageDir() }); ibkrClientConfigured = true; }
  return { ibkrQuote, ibkrBars, ibkrScan };
}
const usStock = (symbol) => marketFromSymbol(symbol) === "US" && !symbol.startsWith("^");
const twsReference = (quote) => ({ provider: "IBKR TWS", price: quote.price, bid: quote.bid ?? null, ask: quote.ask ?? null, asOf: quote.asOf, delayed: Boolean(quote.delayed), delayMinutes: quote.delayMinutes ?? 0, basis: quote.basis ?? "stream" });

// Make a live TWS quote the primary of an already cross-checked public quote; keep delayed ones as a reference.
export function applyIbkrQuote(quote, twsQuote, options = {}) {
  const reference = twsReference(twsQuote);
  quote.ibkr = reference;
  const candidate = { ...quote, provider: "IBKR TWS", price: twsQuote.price, asOf: twsQuote.asOf };
  const freshness = assessQuoteFreshness(candidate, options);
  if (twsQuote.delayed || freshness.status !== "fresh") {
    quote.dataSources.push({ ...reference, role: "reference", note: twsQuote.delayed ? `IBKR TWS is ${twsQuote.delayMinutes} minutes delayed on this login (no real-time subscription); not used as the price.` : `IBKR TWS quote is ${freshness.status}; not used as the price.` });
    return quote;
  }
  const publicQuote = { ...quote };
  const compared = crossCheckQuotes(candidate, publicQuote, options);
  Object.assign(quote, {
    provider: "IBKR TWS", source: `IBKR TWS + ${publicQuote.provider}`, price: twsQuote.price, asOf: twsQuote.asOf, bid: twsQuote.bid ?? null, ask: twsQuote.ask ?? null, freshness,
    changePct: quote.previousClose > 0 ? (twsQuote.price / quote.previousClose - 1) * 100 : quote.changePct,
  });
  quote.crossCheck = compared.status === "time-mismatch" && compared.primaryFreshness.signalEligible
    ? { ...compared, status: "fallback", error: `${publicQuote.provider} lags IBKR TWS by ${Math.round(compared.timestampSkewSeconds ?? 0)}s` } : compared;
  quote.dataSources = [{ ...reference, role: "primary", freshness }, ...(publicQuote.dataSources ?? []).map((entry) => ({ ...entry, role: ["primary", "fallback"].includes(entry.role) ? "cross-check" : entry.role }))];
  quote.dataQuality.warnings = quote.dataQuality.warnings.filter((warning) => !String(warning).startsWith("Cross-check"));
  if (quote.crossCheck.status !== "matched") quote.dataQuality.warnings.push(`Cross-check: ${quote.crossCheck.status}`);
  quote.dataQuality.status = quote.dataQuality.warnings.length ? "warning" : "ok";
  quote.signalEligible = freshness.signalEligible && ["matched", "unavailable", "fallback"].includes(quote.crossCheck.status);
  return quote;
}

// TWS daily bars (dividend- and split-adjusted) in the shape of the other history providers.
export function historyFromIbkrBars(symbol, bars, options = {}) {
  const rows = bars.map((bar) => {
    const timestamp = marketLocalToIso(String(bar.date).slice(0, 10), 12 * 60, "US");
    return { timestamp, open: bar.open, close: bar.close, high: bar.high, low: bar.low, volume: bar.volume ?? 0, adjustedClose: bar.close, adjustmentFactor: 1, ...dailyBarMetadata(timestamp, "US", options) };
  }).filter((row) => [row.open, row.close, row.high, row.low].every((value) => value > 0));
  if (!rows.length) throw new Error("TWS returned no usable daily bars");
  const completed = rows.filter((row) => row.complete);
  const indicators = computeIndicators(completed.map((row) => row.close), completed.map((row) => row.high), completed.map((row) => row.low), completed.map((row) => row.volume));
  indicators.asOf = completed.at(-1)?.availableAt ?? null;
  indicators.priceBasis = "adjusted (IB ADJUSTED_LAST)";
  const latest = rows.at(-1), previous = rows.at(-2);
  return {
    symbol, market: "US", name: symbol, currency: "USD", provider: "IBKR TWS", source: "Interactive Brokers TWS historical bars (ADJUSTED_LAST)", period: "1d",
    price: latest.close, previousClose: previous?.close ?? null, changePct: previous ? (latest.close / previous.close - 1) * 100 : null,
    asOf: latest.availableAt, indicators, history: rows.slice(-(options.historyLimit ?? 60)), historyPriceBasis: "adjusted", corporateActions: [],
    dataQuality: { status: "warning", warnings: ["IBKR adjusted daily bars; corporate-action records are not supplied."] },
  };
}

export async function getHistoricalQuote(input, options = {}) {
  const twsSymbol = normalizeSymbol(input);
  if (usStock(twsSymbol) && options.ibkr !== false) {
    const duration = { "1y": "1 Y", "2y": "2 Y", "5y": "5 Y" }[options.range] ?? "2 Y";
    const bars = await tws().ibkrBars(twsSymbol, { duration, barSize: "1 day", what: "ADJUSTED_LAST", useRTH: true }).catch(() => null);
    if (bars) {
      try { return historyFromIbkrBars(twsSymbol, bars.bars, { ...options, historyLimit: 2000 }); } catch { /* fall through to public history */ }
    }
  }
  const allowedRanges = new Set(["1y", "2y", "5y"]);
  const range = allowedRanges.has(options.range) ? options.range : "2y";
  const historyOptions = { ...options, range, interval: "1d", historyLimit: 2000 };
  try {
    const quote = await getYahooQuote(input, historyOptions);
    if (!quote.history.length) throw new Error("Yahoo daily history is empty");
    return quote;
  } catch (error) {
    try {
      const quote = await getTencentHistory(input, historyOptions);
      quote.dataQuality.warnings.push(`Yahoo history unavailable: ${error.message}`);
      return quote;
    } catch (fallbackError) {
      throw new Error(`Daily history unavailable: Yahoo: ${error.message}; Tencent: ${fallbackError.message}`);
    }
  }
}

function tencentCodeForSymbol(input) {
  const symbol = normalizeSymbol(input);
  if (TENCENT_INDEX_CODES[symbol]) return TENCENT_INDEX_CODES[symbol];
  if (symbol.endsWith(".SS")) return `sh${symbol.slice(0, -3)}`;
  if (symbol.endsWith(".SZ")) return `sz${symbol.slice(0, -3)}`;
  if (symbol.endsWith(".BJ")) return `bj${symbol.slice(0, -3)}`;
  if (symbol.endsWith(".HK")) return `hk${symbol.slice(0, -3).padStart(5, "0")}`;
  if (symbol.startsWith("^")) throw new Error(`腾讯财经暂不支持指数代码 ${symbol}`);
  return `us${symbol}`;
}

function zonedLocalToIso(parts, timeZone) {
  const targetUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let instant = targetUtc;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = Object.fromEntries(formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const observedUtc = Date.UTC(
      Number(observed.year),
      Number(observed.month) - 1,
      Number(observed.day),
      Number(observed.hour),
      Number(observed.minute),
      Number(observed.second),
    );
    instant += targetUtc - observedUtc;
  }
  return new Date(instant).toISOString();
}

function parseTencentTimestamp(value, market) {
  const digits = String(value ?? "").match(/^(\d{4})[/-]?(\d{2})[/-]?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})$/);
  if (!digits) return null;
  const [, year, month, day, hour, minute, second] = digits;
  return zonedLocalToIso({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  }, market === "US" ? "America/New_York" : "Asia/Shanghai");
}

function emptyIndicators() {
  return {
    sma5: null,
    sma20: null,
    sma60: null,
    rsi14: null,
    macd: null,
    macdSignal: null,
    annualizedVolatilityPct: null,
    maxDrawdown60dPct: null,
    support20d: null,
    resistance20d: null,
    volumeRatio20d: null,
    trend: "数据不足",
  };
}

export function parseTencentQuote(payload, input) {
  const symbol = normalizeSymbol(input);
  const market = marketFromSymbol(symbol);
  const match = String(payload).match(/^[^=]+="([\s\S]*)";?\s*$/);
  if (!match?.[1]) throw new Error(`腾讯财经未取得 ${symbol} 行情`);
  const fields = match[1].split("~");
  const price = finite(fields[3]);
  if (price === null || price <= 0) throw new Error(`腾讯财经返回的 ${symbol} 价格无效`);
  const previousClose = finite(fields[4]);
  const change = finite(fields[31]) ?? (previousClose ? price - previousClose : null);
  const changePct = finite(fields[32]) ?? (change !== null && previousClose ? change / previousClose * 100 : null);
  const alerts = [];
  if (Math.abs(changePct ?? 0) >= 3) alerts.push(`日内涨跌幅 ${round(changePct)}%`);
  const exchangeTimezone = market === "US" ? "America/New_York" : market === "HK" ? "Asia/Hong_Kong" : "Asia/Shanghai";

  return {
    input: String(input),
    symbol,
    market,
    name: INDEX_NAMES[symbol] ?? fields[1] ?? symbol,
    currency: market === "US" ? "USD" : market === "HK" ? "HKD" : "CNY",
    exchange: "Tencent Finance",
    exchangeTimezone,
    marketState: null,
    price,
    previousClose,
    change,
    changePct,
    dayHigh: finite(fields[33]),
    dayLow: finite(fields[34]),
    open: finite(fields[5]),
    volume: finite(fields[6]),
    // Tencent reports A-share volume in board lots of 100 shares; HK and US in shares.
    volumeShares: finite(fields[6]) === null ? null : market === "A" ? finite(fields[6]) * 100 : finite(fields[6]),
    // No opening print and no volume: Tencent's signature of a suspended (or not yet opened) security.
    noTradesToday: finite(fields[5]) === 0 && finite(fields[6]) === 0,
    asOf: parseTencentTimestamp(fields[30], market),
    source: "Tencent Finance quote API",
    provider: "Tencent Finance",
    providerSymbol: fields[2] || null,
    freshnessNotice: "公开行情可能延迟；下单前必须以券商行情复核。",
    dataQuality: {
      status: "warning",
      warnings: ["当前仅有腾讯财经快照，历史指标不可用"],
    },
    indicators: emptyIndicators(),
    alerts: [],
    period: "snapshot",
    history: [],
    // Exchange microstructure published by Tencent: HK board lot (field 60) and A-share daily price limits (47/48).
    lotSize: market === "HK" && Number.isInteger(finite(fields[60])) && finite(fields[60]) > 0 ? finite(fields[60]) : null,
    limitUp: market === "A" && finite(fields[47]) > 0 ? finite(fields[47]) : null,
    limitDown: market === "A" && finite(fields[48]) > 0 ? finite(fields[48]) : null,
    // Five-level order book (fields 9–18 bids, 19–28 asks: price, size). A-share sizes are in lots of 100.
    ...orderBook(fields, market),
  };
}

function orderBook(fields, market) {
  const unit = market === "A" ? 100 : 1;
  const side = (start) => Array.from({ length: 5 }, (_, level) => ({ price: finite(fields[start + level * 2]), size: finite(fields[start + level * 2 + 1]) }))
    .filter((entry) => entry.price > 0).map((entry) => ({ price: entry.price, size: entry.size > 0 ? entry.size * unit : null }));
  const bids = side(9);
  const asks = side(19);
  return { bid: bids[0]?.price ?? null, ask: asks[0]?.price ?? null, bids, asks };
}

async function getTencentQuote(input, timeoutMs = 15000) {
  const symbol = normalizeSymbol(input);
  const code = tencentCodeForSymbol(symbol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${TENCENT_QUOTE}=${encodeURIComponent(code)}`, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const payload = new TextDecoder("gb18030").decode(await response.arrayBuffer());
    return parseTencentQuote(payload, symbol);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fast execution quote for paper fills: one realtime Tencent snapshot (HK uses the realtime `r_` feed),
 * falling back to a Yahoo daily snapshot. No history or indicators are fetched.
 */
export async function getTradeQuote(input, options = {}) {
  const symbol = normalizeSymbol(input);
  if (usStock(symbol) && options.ibkr !== false) {
    const [twsQuote, publicQuote] = await Promise.all([tws().ibkrQuote(symbol).catch(() => null), publicTradeQuote(symbol, options).catch((error) => error)]);
    if (twsQuote && !twsQuote.delayed) {
      const base = publicQuote instanceof Error ? { symbol, name: symbol, market: "US", currency: "USD", previousClose: twsQuote.previousClose ?? null, history: [], dataQuality: { status: "warning", warnings: [`Public quote unavailable: ${publicQuote.message}`] } } : publicQuote;
      const quote = { ...base, provider: "IBKR TWS", source: "IBKR TWS", price: twsQuote.price, bid: twsQuote.bid ?? null, ask: twsQuote.ask ?? null, asOf: twsQuote.asOf, ibkr: twsReference(twsQuote) };
      return { ...quote, freshness: assessQuoteFreshness(quote, { maxAgeSeconds: options.maxAgeSeconds ?? 300 }) };
    }
    if (publicQuote instanceof Error) throw publicQuote;
    return twsQuote ? { ...publicQuote, ibkr: twsReference(twsQuote) } : publicQuote;
  }
  return publicTradeQuote(symbol, options);
}

async function publicTradeQuote(input, options = {}) {
  const symbol = normalizeSymbol(input);
  const timeoutMs = options.timeoutMs ?? 8000;
  const code = tencentCodeForSymbol(symbol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${TENCENT_QUOTE}=${encodeURIComponent(code.startsWith("hk") ? `r_${code}` : code)}`, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const quote = parseTencentQuote(new TextDecoder("gb18030").decode(await response.arrayBuffer()), symbol);
    return { ...quote, freshness: assessQuoteFreshness(quote, { maxAgeSeconds: options.maxAgeSeconds ?? 300 }) };
  } catch (tencentError) {
    try {
      const quote = await getYahooQuote(symbol, { interval: "1d", range: "5d", timeoutMs });
      return { ...quote, history: [], freshness: assessQuoteFreshness(quote, { maxAgeSeconds: options.maxAgeSeconds ?? 300 }) };
    } catch (yahooError) {
      throw new Error(`${symbol} 行情不可用 / quote unavailable: Tencent ${tencentError.message}; Yahoo ${yahooError.message}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function parseTencentHistory(input, rawPayload, adjustedPayload, options = {}) {
  const symbol = normalizeSymbol(input), market = marketFromSymbol(symbol);
  const code = options.tencentCode ?? tencentCodeForSymbol(symbol);
  const raw = rawPayload?.data?.[code]?.day;
  const adjusted = adjustedPayload?.data?.[code]?.qfqday;
  if (!Array.isArray(raw) || !raw.length) throw new Error(`Tencent daily history missing for ${symbol}`);
  const adjustedByDate = new Map((adjusted ?? []).map((row) => [row[0], row]));
  let previousDate = "";
  const history = raw.map((row) => {
    const [date, o, c, h, l, v] = row;
    const open = finite(o), close = finite(c), high = finite(h), low = finite(l), volume = finite(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date <= previousDate) throw new Error("Invalid or unordered Tencent session dates");
    if (![open, close, high, low].every((value) => value > 0) || high < Math.max(open, close) || low > Math.min(open, close) || volume === null || volume < 0) throw new Error(`Invalid Tencent OHLCV at ${date}`);
    previousDate = date;
    const adjustedClose = adjusted ? finite(adjustedByDate.get(date)?.[2]) : null;
    if (adjusted && !(adjustedClose > 0)) throw new Error(`Tencent adjustment missing at ${date}`);
    const timestamp = marketLocalToIso(date, 12 * 60, market);
    return { timestamp, open, close, high, low, volume, adjustedClose, adjustmentFactor: adjustedClose === null ? null : adjustedClose / close, ...dailyBarMetadata(timestamp, market, options) };
  });
  const completed = history.filter((row) => row.complete);
  const anchor = history.at(-1).adjustmentFactor ?? 1;
  const rows = completed.map((row) => { const factor = (row.adjustmentFactor ?? 1) / anchor; return { ...row, close: row.close * factor, high: row.high * factor, low: row.low * factor }; });
  const indicators = computeIndicators(rows.map((row) => row.close), rows.map((row) => row.high), rows.map((row) => row.low), rows.map((row) => row.volume));
  indicators.asOf = completed.at(-1)?.availableAt ?? null;
  indicators.priceBasis = adjusted ? "adjusted-to-latest-raw-price" : "unadjusted";
  const latest = history.at(-1), previous = history.at(-2);
  return {
    symbol, market, name: symbol, currency: market === "A" ? "CNY" : market === "HK" ? "HKD" : "USD",
    provider: "Tencent Finance", source: "Tencent Finance daily kline API", period: "1d",
    price: latest.close, previousClose: previous?.close ?? null,
    changePct: previous ? (latest.close / previous.close - 1) * 100 : null,
    asOf: latest.availableAt, indicators, history: history.slice(-(options.historyLimit ?? 60)),
    historyPriceBasis: "unadjusted", corporateActions: [],
    dataQuality: { status: "warning", warnings: ["Tencent daily history fallback; corporate-action records are not supplied.", ...(!adjusted ? ["Adjusted history unavailable; indicators use unadjusted prices."] : [])] },
  };
}

async function getTencentHistory(input, options = {}) {
  const symbol = normalizeSymbol(input);
  let code = tencentCodeForSymbol(symbol);
  if (marketFromSymbol(symbol) === "US" && !TENCENT_INDEX_CODES[symbol]) {
    const snapshot = options.snapshot ?? await getTencentQuote(symbol, options.timeoutMs ?? 15000);
    if (!/^[A-Za-z0-9.^_-]+$/.test(snapshot.providerSymbol ?? "")) throw new Error("Tencent US history symbol unavailable");
    code = `us${snapshot.providerSymbol}`;
  }
  const count = ({ "6mo": 180, "1y": 320, "2y": 640, "5y": 2000 })[options.range ?? "6mo"] ?? 180;
  const endpoint = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
  const [raw, adjusted] = await Promise.all([
    fetchJson(`${endpoint}?param=${encodeURIComponent(`${code},day,,,${count},`)}`, options.timeoutMs ?? 15000, false),
    fetchJson(`${endpoint}?param=${encodeURIComponent(`${code},day,,,${count},qfq`)}`, options.timeoutMs ?? 15000, false),
  ]);
  // Providers can return slightly different window boundaries; align by date, never by row index.
  const rawRows = raw?.data?.[code]?.day, adjustedRows = adjusted?.data?.[code]?.qfqday;
  if (Array.isArray(rawRows) && Array.isArray(adjustedRows) && adjustedRows.length) {
    const start = adjustedRows[0][0], end = adjustedRows.at(-1)[0];
    raw.data[code].day = rawRows.filter((row) => row[0] >= start && row[0] <= end);
  }
  return parseTencentHistory(symbol, raw, adjusted, { ...options, tencentCode: code });
}

export function crossCheckQuotes(quote, check, options = {}) {
  const primaryFreshness = assessQuoteFreshness(quote, options);
  const secondaryFreshness = assessQuoteFreshness(check, options);
  const priceDifferencePct = quote.price > 0 && check.price > 0 ? Math.abs(check.price - quote.price) / quote.price * 100 : null;
  const timestampSkewSeconds = quote.asOf && check.asOf ? Math.abs(Date.parse(check.asOf) - Date.parse(quote.asOf)) / 1000 : null;
  const sameSession = localMarketTime(quote.asOf, quote.market)?.date === localMarketTime(check.asOf, check.market)?.date;
  let status = "unverified";
  if ([primaryFreshness.status, secondaryFreshness.status].some((value) => ["stale", "future", "unknown-timestamp"].includes(value))) status = "stale";
  else if (!Number.isFinite(timestampSkewSeconds) || timestampSkewSeconds > (options.maxTimestampSkewSeconds ?? 120) || !sameSession) status = "time-mismatch";
  else if (quote.currency !== check.currency) status = "currency-mismatch";
  else if (primaryFreshness.status === "unverified-calendar" || secondaryFreshness.status === "unverified-calendar") status = "unverified-calendar";
  else if (priceDifferencePct !== null) status = priceDifferencePct <= (options.maxPriceDifferencePct ?? 1) ? "matched" : "divergent";
  return { status, priceDifferencePct, timestampSkewSeconds, primaryFreshness, secondaryFreshness };
}

// East Money: a second independent quote source and a per-stock news feed that stay reachable
// from mainland networks when Yahoo Finance is blocked or rate-limited.
const EASTMONEY_QUOTE = "https://push2.eastmoney.com/api/qt/stock/get";
const EASTMONEY_NEWS = "https://np-listapi.eastmoney.com/comm/web/getListInfo";
const EASTMONEY_SUGGEST = "https://searchapi.eastmoney.com/api/suggest/get";

export function eastmoneyIds(input) {
  const symbol = normalizeSymbol(input);
  if (symbol.startsWith("^")) return [];
  if (symbol.endsWith(".SS")) return [`1.${symbol.slice(0, -3)}`];
  if (symbol.endsWith(".SZ") || symbol.endsWith(".BJ")) return [`0.${symbol.slice(0, -3)}`];
  if (symbol.endsWith(".HK")) return [`116.${symbol.slice(0, -3).padStart(5, "0")}`];
  const ticker = symbol.replace(/-/g, "_");
  return ["105", "106", "107"].map((market) => `${market}.${ticker}`); // NASDAQ, NYSE, NYSE American
}

export function parseEastmoneyQuote(payload, input) {
  const symbol = normalizeSymbol(input);
  const market = marketFromSymbol(symbol);
  const data = payload?.data;
  const scale = 10 ** (finite(data?.f59) ?? 2);
  const price = finite(data?.f43) === null ? null : finite(data.f43) / scale;
  if (!data || !(price > 0)) throw new Error(`东方财富未取得 ${symbol} 行情`);
  const previousClose = finite(data.f60) === null ? null : finite(data.f60) / scale;
  return {
    input: String(input), symbol, market, name: data.f58 ?? symbol,
    currency: market === "US" ? "USD" : market === "HK" ? "HKD" : "CNY",
    exchange: "East Money", provider: "East Money", source: "East Money quote API",
    price, previousClose,
    change: previousClose ? price - previousClose : null,
    changePct: previousClose ? (price / previousClose - 1) * 100 : null,
    asOf: finite(data.f86) ? new Date(finite(data.f86) * 1000).toISOString() : null,
    dataQuality: { status: "warning", warnings: [] }, indicators: emptyIndicators(), alerts: [], period: "snapshot", history: [],
  };
}

const eastmoneyIdCache = new Map();

async function getEastmoneyQuote(input, timeoutMs = 8000) {
  const symbol = normalizeSymbol(input);
  let lastError = new Error("no East Money id");
  // US tickers may list on NASDAQ, NYSE or NYSE American; remember the one that answered.
  const ids = eastmoneyIdCache.has(symbol) ? [eastmoneyIdCache.get(symbol)] : eastmoneyIds(symbol);
  for (const secid of ids) {
    try {
      const payload = await fetchJson(`${EASTMONEY_QUOTE}?secid=${encodeURIComponent(secid)}&fields=f43,f57,f58,f59,f60,f86`, timeoutMs, false);
      const quote = parseEastmoneyQuote(payload, symbol);
      eastmoneyIdCache.set(symbol, secid);
      return quote;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

// Resolve a company name to an East Money security id (e.g. 贵州茅台 → 1.600519).
async function eastmoneyResolve(query) {
  try { return eastmoneyIds(query)[0] ?? null; } catch { /* not a symbol; search by name */ }
  const payload = await fetchJson(`${EASTMONEY_SUGGEST}?input=${encodeURIComponent(query)}&type=14&count=1`, 8000, false);
  return payload?.QuotationCodeTable?.Data?.[0]?.QuoteID ?? null;
}

export function parseEastmoneyNews(payload, count) {
  const rows = payload?.data?.list ?? [];
  return rows.slice(0, count).map((item) => ({
    title: item.Art_Title ?? "",
    publisher: "东方财富 / East Money",
    publishedAt: item.Art_ShowTime ? zonedLocalToIso((([d, t]) => { const [year, month, day] = d.split("-").map(Number); const [hour, minute, second = 0] = t.split(":").map(Number); return { year, month, day, hour, minute, second }; })(String(item.Art_ShowTime).split(" ")), "Asia/Shanghai") : null,
    url: item.Art_Url ?? item.Art_OriginUrl ?? null,
  })).filter((item) => item.title);
}

async function getEastmoneyNews(query, count) {
  const secid = await eastmoneyResolve(query);
  if (!secid) throw new Error(`东方财富未找到 ${query}`);
  const payload = await fetchJson(`${EASTMONEY_NEWS}?client=web&type=1&mTypeAndCode=${encodeURIComponent(secid)}&pageSize=${count}&pageIndex=1`, 8000, false);
  return parseEastmoneyNews(payload, count);
}

export async function getQuote(input, options = {}) {
  const symbol = normalizeSymbol(input);
  const calendarOverrides = options.calendarOverrides ?? (await loadPreferences()).calendarOverrides;
  const normalizedOptions = { ...options, calendarOverrides, now: options.now ?? new Date().toISOString() };
  const wantsIntraday = options.phase === "intraday" || options.includeIntraday === true;
  const twsPromise = usStock(symbol) && options.ibkr !== false ? tws().ibkrQuote(symbol).catch(() => null) : Promise.resolve(null);
  const [yahooResult, tencentResult, intradayResult] = await Promise.allSettled([
    getYahooQuote(symbol, { ...normalizedOptions, interval: "1d" }),
    getTencentQuote(symbol, options.timeoutMs ?? 15000),
    wantsIntraday ? getYahooQuote(symbol, { ...normalizedOptions, interval: "5m", range: "1mo", historyLimit: 4000 }) : Promise.resolve(null),
  ]);
  if (!options.now) normalizedOptions.now = new Date().toISOString();
  const sourceUsable = (result) => result.status === "fulfilled" && !["stale", "future", "unknown-timestamp"].includes(assessQuoteFreshness(result.value, normalizedOptions).status);
  const yahooUsable = sourceUsable(yahooResult), tencentUsable = sourceUsable(tencentResult);
  // Only when one primary source is missing: ask East Money for an independent cross-check.
  const [eastmoneyResult] = yahooUsable && tencentUsable || options.eastmoney === false
    ? [{ status: "rejected", reason: new Error("not needed") }]
    : await Promise.allSettled([getEastmoneyQuote(symbol)]);
  // Yahoo delays A-share and some HK quotes by ~15 minutes. When Tencent is clearly fresher, it
  // becomes the primary and the lagging Yahoo quote only serves as the cross-check.
  const tencentFresher = yahooUsable && tencentUsable && Date.parse(tencentResult.value.asOf) - Date.parse(yahooResult.value.asOf) > (options.maxTimestampSkewSeconds ?? 120) * 1000;
  const quote = tencentFresher ? tencentResult.value : yahooUsable ? yahooResult.value : tencentUsable ? tencentResult.value : yahooResult.status === "fulfilled" ? yahooResult.value : tencentResult.status === "fulfilled" ? tencentResult.value : null;
  if (!quote) throw new Error(`行情请求失败：Yahoo Finance: ${yahooResult.reason?.message}; Tencent Finance: ${tencentResult.reason?.message}`);
  if (!quote.history.length) {
    try {
      const history = await getTencentHistory(symbol, { ...normalizedOptions, snapshot: tencentResult.status === "fulfilled" ? tencentResult.value : undefined });
      Object.assign(quote, { history: history.history, indicators: history.indicators, historyPriceBasis: history.historyPriceBasis, corporateActions: history.corporateActions, period: "1d", historySource: history.source });
      quote.dataQuality.warnings = [...quote.dataQuality.warnings.filter((warning) => warning !== "当前仅有腾讯财经快照，历史指标不可用"), ...history.dataQuality.warnings];
    } catch (error) {
      quote.dataQuality.warnings.push(`Daily history unavailable: ${error.message}`);
    }
  }
  if (!options.now) normalizedOptions.now = new Date().toISOString();
  quote.freshness = assessQuoteFreshness(quote, normalizedOptions);
  const selectedYahoo = quote === yahooResult.value;
  quote.dataSources = [{ provider: quote.provider, role: selectedYahoo || tencentFresher ? "primary" : "fallback", price: quote.price, asOf: quote.asOf, freshness: quote.freshness }];
  if (yahooUsable && tencentUsable) {
    const check = selectedYahoo ? tencentResult.value : yahooResult.value;
    const compared = crossCheckQuotes(quote, check, normalizedOptions);
    // A fresh primary with a lagging second source is single-source data, not a conflict.
    quote.crossCheck = compared.status === "time-mismatch" && compared.primaryFreshness.signalEligible
      ? { ...compared, status: "fallback", error: `${check.provider} lags the primary by ${Math.round(compared.timestampSkewSeconds ?? 0)}s` }
      : compared;
    quote.source = selectedYahoo ? "Yahoo Finance + Tencent Finance" : "Tencent Finance + Yahoo Finance";
    quote.dataSources.push({ provider: check.provider, role: "cross-check", price: check.price, asOf: check.asOf, freshness: quote.crossCheck.secondaryFreshness });
  } else if (sourceUsable(eastmoneyResult) && (selectedYahoo || quote === tencentResult.value)) {
    // Yahoo or Tencent is missing: cross-check the remaining one against East Money instead.
    const check = eastmoneyResult.value;
    const missing = selectedYahoo ? tencentResult : yahooResult;
    const compared = crossCheckQuotes(quote, check, normalizedOptions);
    // East Money's free HK/US snapshots can lag the realtime primary; a lagging check is not a conflict.
    quote.crossCheck = compared.status === "time-mismatch"
      ? { status: "fallback", via: "East Money", error: `East Money quote lags the primary by ${Math.round(compared.timestampSkewSeconds ?? 0)}s`, priceDifferencePct: compared.priceDifferencePct }
      : { ...compared, via: "East Money" };
    quote.crossCheck.unavailableSource = { provider: selectedYahoo ? "Tencent Finance" : "Yahoo Finance", error: missing.reason?.message ?? "stale or missing quote time" };
    quote.source = `${quote.provider} + East Money`;
    quote.dataSources.push({ provider: check.provider, role: "cross-check", price: check.price, asOf: check.asOf, freshness: quote.crossCheck.secondaryFreshness });
  } else {
    const other = selectedYahoo ? tencentResult : yahooResult;
    quote.crossCheck = { status: selectedYahoo ? "unavailable" : "fallback", error: other.reason?.message ?? "Other source has stale, future or missing quote time" };
    if (other.status === "fulfilled") quote.dataSources.push({ provider: other.value.provider, role: "rejected", price: other.value.price, asOf: other.value.asOf, freshness: assessQuoteFreshness(other.value, normalizedOptions) });
  }
  if (quote.freshness.status !== "fresh") quote.dataQuality.warnings.push(quote.freshness.reason);
  if (quote.crossCheck.status !== "matched") quote.dataQuality.warnings.push(`Cross-check: ${quote.crossCheck.status}`);
  quote.dataQuality.status = quote.freshness.status === "stale" || quote.freshness.status === "future" ? "stale" : quote.dataQuality.warnings.length ? "warning" : "ok";
  quote.signalEligible = quote.freshness.signalEligible && ["matched", "unavailable", "fallback"].includes(quote.crossCheck.status);
  const twsQuote = await twsPromise;
  if (twsQuote) applyIbkrQuote(quote, twsQuote, normalizedOptions);
  if (wantsIntraday) {
    quote.intraday = intradayResult.status === "fulfilled" && intradayResult.value ? {
      status: "available", period: "5m", history: intradayResult.value.history,
      asOf: intradayResult.value.history.at(-1)?.timestamp ?? null,
      volumeRatioSameTime: sameTimeVolumeRatio(intradayResult.value.history, quote.market, normalizedOptions),
    } : { status: "unavailable", period: "5m", history: [], volumeRatioSameTime: { status: "unavailable", value: null }, error: intradayResult.reason?.message ?? "Intraday data unavailable." };
  }
  quote.instrumentRules = getInstrumentRules(symbol, { asOf: normalizedOptions.now });
  return quote;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function scoreQuoteForResearch(quote) {
  if (quote.error || ["stale", "future", "unknown-timestamp"].includes(quote.freshness?.status)) {
    return {
      score: 0,
      priority: "不可评估",
      positiveFactors: [],
      riskFactors: [quote.error ?? quote.freshness.reason ?? "Quote freshness could not be verified."],
      scenarioConditions: null,
      evaluationStatus: "withheld",
    };
  }

  let score = 50;
  const positiveFactors = [];
  const riskFactors = [];
  const add = (delta, message) => {
    score += delta;
    (delta > 0 ? positiveFactors : riskFactors).push(message);
  };
  const indicators = quote.indicators ?? {};

  if (indicators.trend === "上行") add(15, "价格与中期均线结构偏强");
  else if (indicators.trend === "下行") add(-15, "价格与中期均线结构偏弱");
  if (Number.isFinite(indicators.macd) && Number.isFinite(indicators.macdSignal)) {
    add(indicators.macd > indicators.macdSignal ? 10 : -10, indicators.macd > indicators.macdSignal ? "MACD 位于信号线上方" : "MACD 位于信号线下方");
  }
  if (Number.isFinite(indicators.rsi14)) {
    if (indicators.rsi14 >= 45 && indicators.rsi14 <= 65) add(5, "RSI 位于中性偏强区间");
    else if (indicators.rsi14 >= 75) add(-10, "RSI 处于高位，追涨风险增加");
    else if (indicators.rsi14 <= 30) add(-5, "RSI 处于低位，但超跌不等于反转");
  }
  if (Number.isFinite(indicators.volumeRatio20d)) {
    if (indicators.volumeRatio20d >= 1 && indicators.volumeRatio20d <= 3) add(5, "成交活跃度高于20日均值且未出现极端放量");
    else if (indicators.volumeRatio20d > 3) add(-5, "成交量显著放大，需要核验事件与口径");
  }
  if (Math.abs(quote.changePct ?? 0) >= 8) add(-10, "单日波动过大，价格跳空与回撤风险较高");
  if (quote.crossCheck?.status === "divergent") add(-15, "公开行情源之间存在明显差异");
  if (quote.dataQuality?.warnings?.length) add(-10, "存在数据质量警告");
  if (!Number.isFinite(indicators.sma20)) add(-10, "历史数据不足，技术结构无法完整评估");

  score = clamp(Math.round(score), 0, 100);
  const priority = score >= 70 ? "高研究优先级" : score >= 45 ? "中研究优先级" : "低研究优先级";
  const upper = indicators.resistance20d;
  const lower = indicators.support20d;
  const scenarioConditions = {
    constructive: Number.isFinite(upper)
      ? `价格有效站上20日区间上沿 ${upper}，且双源报价一致、量价没有质量警告`
      : "补齐历史数据后，再定义向上确认条件",
    neutral: Number.isFinite(indicators.sma20)
      ? `价格围绕20日均线 ${indicators.sma20} 震荡，等待基本面或事件信息确认`
      : "数据不足时保持观察，不建立方向结论",
    adverse: Number.isFinite(lower)
      ? `价格跌破20日区间下沿 ${lower}，或出现来源分歧、重大负面公告`
      : "行情失真、公告无法核验或风险信息缺失",
  };

  const conditionsAllowed = !quote.freshness || quote.signalEligible === true;
  return { score, priority, positiveFactors, riskFactors, scenarioConditions: conditionsAllowed ? scenarioConditions : null, evaluationStatus: conditionsAllowed ? "research-only" : "historical-only" };
}

export async function screenWatchlist(input = {}) {
  const preferences = await loadPreferences();
  const requested = Array.isArray(input.symbols) && input.symbols.length ? input.symbols : preferences.watchlist;
  if (!requested.length) throw new Error("首次使用尚未设置自选股。请先调用 get_onboarding，再保存自选股或直接传入 symbols。");
  const symbols = [...new Set(requested.map(normalizeSymbol))].slice(0, 20);
  const items = await Promise.all(symbols.map(async (symbol) => {
    try {
      const quote = await getQuote(symbol);
      const news = input.includeNews === false ? [] : await getNews(quote.name || symbol, 3, { symbol }).catch(() => []);
      const { history, ...facts } = quote;
      return {
        ...facts,
        historyPoints: history?.length ?? 0,
        news,
        research: scoreQuoteForResearch(quote),
      };
    } catch (error) {
      return {
        symbol,
        market: marketFromSymbol(symbol),
        error: error.message,
        research: scoreQuoteForResearch({ error: error.message }),
      };
    }
  }));
  items.sort((left, right) => right.research.score - left.research.score);
  return {
    generatedAt: new Date().toISOString(),
    methodVersion: "research-priority-v1",
    meaning: "分数只表示需要进一步研究的优先级，不是买入评级、收益预测或自动交易信号。",
    sourceNotice: "行情使用 Yahoo Finance 与腾讯财经交叉校验；新闻链接必须进一步核验重要事实。",
    items,
  };
}

export function calculatePositionBudget(input) {
  const capital = finite(input.capital);
  const maxLossPctPerIdea = finite(input.maxLossPctPerIdea);
  const maxPositionPct = finite(input.maxPositionPct);
  const capitalCurrency = String(input.capitalCurrency ?? "").trim().toUpperCase();
  const ideas = Array.isArray(input.ideas) ? input.ideas : [];
  const asOf = input.asOf ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("asOf must be a valid dated timestamp.");
  const maxAggregateLossPct = finite(input.maxAggregateLossPct) ?? maxLossPctPerIdea;
  if (!capital || capital <= 0) throw new Error("可投资资金 capital 必须大于 0");
  if (!capitalCurrency) throw new Error("必须提供资金币种 capitalCurrency");
  if (!maxLossPctPerIdea || maxLossPctPerIdea <= 0 || maxLossPctPerIdea > 100) throw new Error("maxLossPctPerIdea 必须在 0 到 100 之间");
  if (!maxPositionPct || maxPositionPct <= 0 || maxPositionPct > 100) throw new Error("maxPositionPct 必须在 0 到 100 之间");
  if (!ideas.length) throw new Error("至少需要一个包含入场价和失效价的候选标的");
  if (!(maxAggregateLossPct > 0 && maxAggregateLossPct <= 100)) throw new Error("maxAggregateLossPct must be in (0, 100].");
  const seen = new Set();
  const fxEvidence = [];
  const convert = (currency) => {
    if (currency === capitalCurrency) return 1;
    const fx = (input.fxRates ?? []).find((entry) => entry.from === currency && entry.to === capitalCurrency);
    const age = fx?.asOf ? Date.parse(asOf) - Date.parse(fx.asOf) : NaN;
    if (!(finite(fx?.rate) > 0) || !fx?.source || !Number.isFinite(age) || age < 0 || age > (finite(input.fxMaxAgeHours) ?? 72) * 3600000) {
      throw new Error(`Missing or stale dated FX evidence: ${currency} -> ${capitalCurrency}. Provide fxRates [{from,to,rate,asOf,source}].`);
    }
    if (!fxEvidence.includes(fx)) fxEvidence.push(fx);
    return Number(fx.rate);
  };
  const existing = (input.existingPositions ?? []).map((position) => {
    const symbol = normalizeSymbol(position.symbol);
    const currency = String(position.quoteCurrency ?? getInstrumentRules(symbol).currency).toUpperCase();
    if (currency !== getInstrumentRules(symbol).currency) throw new Error(`${symbol}: quoteCurrency conflicts with the instrument trading currency.`);
    const rate = convert(currency);
    const quantity = finite(position.quantity);
    const price = finite(position.marketPrice);
    const invalidationPrice = finite(position.invalidationPrice);
    if (!Number.isFinite(quantity) || quantity < 0 || !(price > 0) || !(invalidationPrice > 0)) throw new Error(`${symbol}: existing positions require quantity, marketPrice and invalidationPrice; unknown existing risk cannot be treated as zero.`);
    return { symbol, marketValue: quantity * price * rate, risk: quantity * Math.abs(price - invalidationPrice) * rate };
  });
  const existingValue = existing.reduce((sum, position) => sum + position.marketValue, 0);
  const existingRisk = existing.reduce((sum, position) => sum + position.risk, 0);
  if (existingValue > capital) throw new Error("Existing gross exposure exceeds capital; this cash-only model does not support leverage.");
  const availableCash = finite(input.availableCash) ?? capital - existingValue;
  if (availableCash < 0 || availableCash > capital - existingValue + 0.000001) throw new Error("availableCash must be nonnegative and cannot exceed capital minus existing exposure.");

  const riskBudgetPerIdea = capital * maxLossPctPerIdea / 100;
  const positionValueCap = capital * maxPositionPct / 100;
  const remainingRiskBudget = Math.max(0, capital * maxAggregateLossPct / 100 - existingRisk);
  const results = ideas.map((idea) => {
    const symbol = normalizeSymbol(idea.symbol);
    if (seen.has(symbol)) throw new Error(`Duplicate idea: ${symbol}`);
    seen.add(symbol);
    const rules = getInstrumentRules(symbol, { asOf });
    const quoteCurrency = String(idea.quoteCurrency ?? rules.currency).toUpperCase();
    if (quoteCurrency !== rules.currency) throw new Error(`${symbol}: quoteCurrency conflicts with the instrument trading currency.`);
    const fxRate = convert(quoteCurrency);
    const direction = idea.direction === "short" ? "short" : "long";
    const entryPrice = finite(idea.entryPrice);
    const invalidationPrice = finite(idea.invalidationPrice);
    const lotSize = idea.lotSize === undefined ? rules.orderIncrement ?? rules.lotSize : finite(idea.lotSize);
    const minimumOrderUnits = finite(idea.minimumOrderUnits ?? rules.minimumOrderUnits ?? lotSize);
    if (!entryPrice || entryPrice <= 0 || !invalidationPrice || invalidationPrice <= 0) throw new Error(`${symbol} 的入场价和失效价必须大于 0`);
    if (direction === "long" && invalidationPrice >= entryPrice) throw new Error(`${symbol} 多头方案的失效价必须低于入场价`);
    if (direction === "short" && invalidationPrice <= entryPrice) throw new Error(`${symbol} 空头方案的失效价必须高于入场价`);
    if (!Number.isInteger(lotSize) || lotSize <= 0) throw new Error(`${symbol} requires a verified positive integer lotSize.`);
    if (!Number.isInteger(minimumOrderUnits) || minimumOrderUnits <= 0) throw new Error(`${symbol} requires positive integer minimumOrderUnits.`);

    const lossPerUnit = Math.abs(entryPrice - invalidationPrice) * fxRate;
    const entryValuePerUnit = entryPrice * fxRate;
    const sameSymbol = existing.filter((position) => position.symbol === symbol);
    const remainingIdeaRisk = Math.max(0, riskBudgetPerIdea - sameSymbol.reduce((sum, position) => sum + position.risk, 0));
    const remainingIdeaValue = Math.max(0, positionValueCap - sameSymbol.reduce((sum, position) => sum + position.marketValue, 0));
    const rawUnitsByRisk = remainingIdeaRisk / lossPerUnit;
    const rawUnitsByAllocation = remainingIdeaValue / entryValuePerUnit;
    const rawUnitCeiling = Math.min(rawUnitsByRisk, rawUnitsByAllocation);
    const quantityCeiling = Math.floor(rawUnitCeiling / lotSize) * lotSize;
    const modeledUnits = quantityCeiling ?? rawUnitCeiling;
    const modeledPositionValue = modeledUnits * entryValuePerUnit;
    const modeledLossAtInvalidation = modeledUnits * lossPerUnit;
    return {
      symbol,
      direction,
      entryPrice,
      invalidationPrice,
      quoteCurrency,
      fxRate,
      riskDistancePct: Math.abs(entryPrice - invalidationPrice) / entryPrice * 100,
      riskBudget: round(riskBudgetPerIdea),
      positionValueCap: round(positionValueCap),
      maxPositionValue: Math.min(rawUnitCeiling * entryValuePerUnit, remainingIdeaValue),
      rawUnitCeiling,
      lotSize,
      minimumOrderUnits,
      quantityCeiling,
      modeledPositionValue,
      modeledLossAtInvalidation,
      modeledPortfolioPct: round(modeledPositionValue / capital * 100),
    };
  });
  const proposedValue = results.reduce((sum, idea) => sum + idea.modeledPositionValue, 0);
  const proposedRisk = results.reduce((sum, idea) => sum + idea.modeledLossAtInvalidation, 0);
  const allocationScale = Math.min(1, proposedValue > 0 ? availableCash / proposedValue : 1, proposedRisk > 0 ? remainingRiskBudget / proposedRisk : 1);
  for (const idea of results) {
    const quantity = Math.floor(idea.quantityCeiling * allocationScale / idea.lotSize) * idea.lotSize;
    idea.quantityCeiling = quantity >= idea.minimumOrderUnits ? quantity : 0;
    idea.modeledPositionValue = idea.quantityCeiling * idea.entryPrice * idea.fxRate;
    idea.modeledLossAtInvalidation = idea.quantityCeiling * Math.abs(idea.entryPrice - idea.invalidationPrice) * idea.fxRate;
    idea.modeledPortfolioPct = idea.modeledPositionValue / capital * 100;
    idea.allocationScale = allocationScale;
  }

  return {
    generatedAt: asOf,
    capital: round(capital),
    capitalCurrency,
    constraints: { maxLossPctPerIdea, maxPositionPct, maxAggregateLossPct },
    availableCash,
    existingExposure: { marketValue: existingValue, modeledRisk: existingRisk },
    remainingRiskBudget,
    allocationScale,
    status: existingRisk > capital * maxAggregateLossPct / 100 ? "existing-risk-exceeds-limit" : allocationScale < 1 ? "scaled-to-portfolio-limits" : "within-limits",
    fxEvidence,
    meaning: "结果是用户约束下的数学仓位上限，不是买卖建议或成交保证。",
    ideas: results,
    aggregateIfAllUsed: {
      modeledPositionValue: round(results.reduce((sum, idea) => sum + idea.modeledPositionValue, 0)),
      modeledLossAtInvalidation: round(results.reduce((sum, idea) => sum + idea.modeledLossAtInvalidation, 0)),
      totalExposureIncludingExisting: existingValue + results.reduce((sum, idea) => sum + idea.modeledPositionValue, 0),
      totalRiskIncludingExisting: existingRisk + results.reduce((sum, idea) => sum + idea.modeledLossAtInvalidation, 0),
      cashRemaining: availableCash - results.reduce((sum, idea) => sum + idea.modeledPositionValue, 0),
    },
    limitations: [
      "未计入手续费、滑点、税费和隔夜跳空；跨币种按所附汇率证据换算。",
      "条件单和止损单可能无法按触发价成交。",
      "组合按总敞口和失效价风险约束计算，不支持杠杆、保证金抵扣或相关性抵销。",
      "A股、港股和美股的最小交易单位与交易规则需在券商端复核。",
    ],
  };
}

// News for A-share / HK names comes from East Money first (per-stock feed plus full-text search);
// Yahoo's search mostly returns unrelated English headlines for them. US names try Yahoo first.
// Words that identify one security in a headline: its code, ticker, name and short name.
export function newsKeys({ symbol, name } = {}) {
  const keys = new Set();
  if (symbol) {
    const plain = String(symbol).toUpperCase().replace(/\.(SS|SZ|BJ|HK)$/, "");
    if (/^\d{4,6}$/.test(plain)) { keys.add(plain); if (/\.HK$/i.test(symbol)) keys.add(plain.padStart(5, "0")); }
    else if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(plain) && plain.length >= 2) keys.add(plain);
  }
  const value = String(name ?? "").trim();
  if (value && !/^[\d.A-Z^-]+$/.test(value)) {
    keys.add(value);
    const short = value.replace(/(股份有限公司|有限公司|股份|控股|集团|-SW|-W|-S|Ａ|Ａ股|\s*(Inc\.?|Corp\.?|Corporation|Ltd\.?|Limited|Holdings?|Group|plc|N\.V\.|S\.A\.))$/i, "").trim();
    if (short.length >= 2 && short !== value) keys.add(short);
  }
  return [...keys];
}

// Keep items that name the security; feeds already tagged to the stock pass as they are.
export function filterRelevantNews(items, keys) {
  if (!keys.length) return { items, dropped: 0 };
  const lowered = keys.map((key) => key.toLowerCase());
  const kept = items.filter((item) => item.tagged || lowered.some((key) => `${item.title ?? ""} ${item.summary ?? ""}`.toLowerCase().includes(key)));
  return { items: kept, dropped: items.length - kept.length };
}

const securityNames = new Map();
async function securityName(symbol) {
  if (securityNames.has(symbol)) return securityNames.get(symbol);
  let name = null;
  try {
    const code = String(symbol).replace(/\.(SS|SZ|BJ|HK)$/i, "");
    const payload = await fetchJson(`${EASTMONEY_SUGGEST}?input=${encodeURIComponent(code)}&type=14&count=1`, 6000, false);
    name = payload?.QuotationCodeTable?.Data?.[0]?.Name ?? null;
  } catch { /* the code alone still identifies it */ }
  securityNames.set(symbol, name);
  return name;
}

// News for a company, symbol or theme. For one security, results that do not mention it are
// dropped (a full-text search returns loosely related pages); theme searches are not filtered.
export async function getNewsDetailed(query, count = 5, { symbol } = {}) {
  const boundedCount = Math.max(0, Math.min(10, Number(count) || 5));
  // Only an explicit symbol, or a query typed as a code / ticker, names one security; anything
  // else ("固态电池", "AI chips") is a theme search.
  const typedSymbol = /^(\d{4,6}(\.(SS|SZ|BJ|HK))?|HK\d{1,5}|[A-Z]{1,5}([.-][A-Z])?)$/.test(String(query).trim());
  let resolved = null;
  try { resolved = symbol ? normalizeSymbol(symbol) : typedSymbol ? normalizeSymbol(query) : null; } catch { /* not a symbol */ }
  let market = null;
  try { market = resolved ? marketFromSymbol(resolved) : null; } catch { /* unknown market */ }
  const chinese = /[\u4e00-\u9fff]/u.test(String(query)) || (market && market !== "US");
  const name = resolved ? (typedSymbol ? await securityName(resolved) : String(query)) : null;
  const keys = resolved ? newsKeys({ symbol: resolved, name }) : [];
  // Ask for a few more so filtering still leaves enough.
  const fetchCount = keys.length ? Math.min(20, boundedCount * 2) : boundedCount;
  const tagged = (items) => items.map((item) => ({ ...item, tagged: true }));
  const sources = chinese
    ? [() => searchEastmoneyNews(query, fetchCount), () => getEastmoneyNews(symbol ?? query, fetchCount).then(tagged), () => getYahooNews(query, fetchCount)]
    : [() => getYahooNews(query, fetchCount), () => getEastmoneyNews(symbol ?? query, fetchCount).then(tagged), () => searchEastmoneyNews(query, fetchCount)];
  const errors = [];
  let dropped = 0;
  for (const source of sources) {
    try {
      const filtered = filterRelevantNews(await source(), keys);
      dropped += filtered.dropped;
      if (filtered.items.length) return { items: filtered.items.slice(0, boundedCount).map(({ tagged: _, ...item }) => item), dropped, keys };
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length === sources.length) throw new Error(`新闻源均不可用 / news unavailable: ${errors.join("; ")}`);
  return { items: [], dropped, keys };
}

export async function getNews(query, count = 5, options = {}) {
  return (await getNewsDetailed(query, count, options)).items;
}

// East Money full-text news search: works for any keyword (company, theme, sector, policy).
const EASTMONEY_SEARCH = "https://search-api-web.eastmoney.com/search/jsonp";
export function parseEastmoneySearch(text, count = 5) {
  const json = JSON.parse(String(text).replace(/^[^(]*\(/, "").replace(/\);?\s*$/, ""));
  return (json?.result?.cmsArticleWebOld ?? []).slice(0, count).map((item) => ({
    title: String(item.title ?? "").replace(/<[^>]+>/g, ""),
    publisher: item.mediaName ? `${item.mediaName} / 东方财富` : "东方财富 / East Money",
    publishedAt: item.date ? new Date(`${item.date.replace(" ", "T")}+08:00`).toISOString() : null,
    url: item.url ?? "",
    summary: String(item.content ?? "").replace(/<[^>]+>/g, "").slice(0, 300),
  }));
}

export async function searchEastmoneyNews(keyword, count = 5) {
  const param = { uid: "", keyword: String(keyword).slice(0, 60), type: ["cmsArticleWebOld"], client: "web", clientType: "web", clientVersion: "curr",
    param: { cmsArticleWebOld: { searchScope: "default", sort: "default", pageIndex: 1, pageSize: Math.max(1, Math.min(20, count)), preTag: "", postTag: "" } } };
  const response = await fetch(`${EASTMONEY_SEARCH}?cb=cb&param=${encodeURIComponent(JSON.stringify(param))}`, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://so.eastmoney.com/" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`East Money search HTTP ${response.status}`);
  return parseEastmoneySearch(await response.text(), count);
}

async function getYahooNews(query, boundedCount) {
  const url = `${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=1&newsCount=${boundedCount}`;
  const payload = await fetchJson(url);
  const ignoredTokens = new Set(["company", "corporation", "corp", "holdings", "holding", "limited", "ltd", "inc"]);
  const tokens = String(query).toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .filter((token) => token.length >= 3 && !ignoredTokens.has(token));
  const candidates = (payload.news ?? []).filter((item) => {
    if (!tokens.length) return true;
    const title = String(item.title ?? "").toLowerCase();
    return tokens.some((token) => title.includes(token));
  });
  return candidates.slice(0, boundedCount).map((item) => ({
    title: item.title ?? "",
    publisher: item.publisher ?? "",
    publishedAt: item.providerPublishTime ? new Date(item.providerPublishTime * 1000).toISOString() : null,
    url: item.link ?? null,
  }));
}

export async function getMarketSnapshot(market = "all") {
  const requested = String(market).toUpperCase();
  const groups = requested === "ALL" ? Object.keys(MARKET_INDICES) : [requested];
  const invalid = groups.find((group) => !MARKET_INDICES[group]);
  if (invalid) throw new Error(`不支持的市场: ${market}`);

  const result = {};
  for (const group of groups) {
    result[group] = await Promise.all(MARKET_INDICES[group].map(async (symbol) => {
      try {
        return await getQuote(symbol, { range: "3mo" });
      } catch (error) {
        return { symbol, market: group, name: INDEX_NAMES[symbol] ?? symbol, error: error.message };
      }
    }));
  }
  return {
    generatedAt: new Date().toISOString(),
    source: "Yahoo Finance + Tencent Finance cross-check",
    markets: result,
  };
}

export function getStorageDir() {
  if (process.env.HROUTER_REPORT_DIR) return path.resolve(process.env.HROUTER_REPORT_DIR);
  // Every agent host must resolve the same directory, or each would see a separate arena.
  // Some hosts do not forward LOCALAPPDATA to MCP servers, so derive the Windows default from the profile.
  const root = process.env.LOCALAPPDATA
    || (process.platform === "win32" ? path.join(os.homedir(), "AppData", "Local") : path.join(os.homedir(), ".hrouter-market-pulse"));
  return path.join(root, "HrouterMarketPulse");
}

function preferencesPath() {
  return path.join(getStorageDir(), "config.json");
}

export async function loadPreferences() {
  const envWatchlist = (process.env.HROUTER_WATCHLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  let saved = {};
  try {
    saved = JSON.parse(await readFile(preferencesPath(), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const watchlist = envWatchlist.length ? envWatchlist : Array.isArray(saved.watchlist) ? saved.watchlist : [];
  return {
    watchlist,
    language: saved.language === "en" ? "en" : "zh-CN",
    positions: Array.isArray(saved.positions) ? saved.positions : [],
    benchmarkSymbols: saved.benchmarkSymbols ?? {},
    sectorMap: saved.sectorMap ?? {},
    alertRules: Array.isArray(saved.alertRules) ? saved.alertRules : [],
    calendarOverrides: saved.calendarOverrides ?? {},
    monitorIntervalSeconds: Math.max(60, Math.min(3600, finite(saved.monitorIntervalSeconds) ?? 300)),
    managedAccountId: typeof saved.managedAccountId === "string" ? saved.managedAccountId : null,
    // New agent accounts get a repeat-every-N-minutes schedule automatically (0 = off).
    defaultAgentIntervalMinutes: Number.isInteger(saved.defaultAgentIntervalMinutes) ? saved.defaultAgentIntervalMinutes : 15,
    digestWebhook: saved.digestWebhook && typeof saved.digestWebhook.url === "string" ? saved.digestWebhook : null,
    reportPort: getReportPort(),
    reportDirectory: getStorageDir(),
    officialWebsite: OFFICIAL_WEBSITE,
    marketDataProviders: ["Yahoo Finance", "Tencent Finance"],
    onboarding: {
      completed: watchlist.length > 0,
      needsWatchlist: watchlist.length === 0,
    },
    analysisEngine: "Current agent task model (Codex, Claude Code, WorkBuddy or other MCP host)",
  };
}

export async function getOnboardingGuide() {
  const preferences = await loadPreferences();
  return {
    firstRun: !preferences.onboarding.completed,
    officialWebsite: OFFICIAL_WEBSITE,
    current: {
      language: preferences.language,
      watchlist: preferences.watchlist,
      analysisEngine: preferences.analysisEngine,
    },
    steps: [
      {
        id: "watchlist",
        required: true,
        completed: preferences.watchlist.length > 0,
        title: "设置自选股",
        prompt: "把 600519、0700.HK、AAPL 保存为我的自选股。",
      },
      {
        id: "manual_test",
        required: true,
        completed: false,
        title: "先手动运行一次",
        prompt: "基于我的自选股生成三市场盘前简报。",
      },
      {
        id: "automation",
        required: false,
        completed: false,
        title: "启用 Agent 定时任务（Codex 自动化 / Claude Code 定时任务 / WorkBuddy 自动化）",
        prompt: "为我的自选股配置盘前、盘中和盘后定时任务。",
      },
      {
        id: "agent_arena",
        required: false,
        completed: false,
        title: "可选：Agent 模拟盘竞技场",
        prompt: "使用 hrouter-agent-arena 技能：先调用 arena_my_accounts，没有账户就用你真实的模型名注册一个 A 股账户，然后按你的策略完成一轮交易决策。",
      },
      {
        id: "paper_trading",
        required: false,
        completed: false,
        title: "可选：富途真实模拟盘",
        prompt: "使用 $hrouter-paper-trading 检查 OpenD 连接，并说明如何授权我的模拟策略和限额。不要操作实盘。",
      },
      {
        id: "strategy_lab",
        required: false,
        completed: false,
        title: "可选：扩展数据与策略",
        prompt: "使用 $hrouter-strategy-lab 接入一个公告数据源，并为自定义规则运行样本外回测。",
      },
    ],
    scheduleTemplates: [
      {
        id: "premarket",
        skill: "$hrouter-premarket-brief",
        cadence: "每个所选市场交易日开盘前运行",
        prompt: "使用 $hrouter-premarket-brief 生成带时间戳的盘前简报；按市场状态判断是否开市，不把公开行情描述为券商实时行情。",
      },
      {
        id: "intraday",
        skill: "$hrouter-intraday-monitor",
        cadence: "所选市场交易时段内按用户选择的间隔运行",
        prompt: "使用 $hrouter-intraday-monitor 检查保存的自选股；没有实质变化时保持安静，仅在重要异动、失败或需要用户处理时通知。",
      },
      {
        id: "postmarket",
        skill: "$hrouter-postmarket-review",
        cadence: "每个所选市场收盘后运行",
        prompt: "使用 $hrouter-postmarket-review 生成盘后复盘，明确覆盖的市场收盘时段，并给出下一交易日观察清单。",
      },
      {
        id: "model_health",
        skill: "$hrouter-strategy-lab",
        cadence: "按用户选择的周度或月度频率运行",
        prompt: "使用 $hrouter-strategy-lab 检查已记录预测的概率校准和数值特征漂移；状态稳定时保持安静，仅在阈值越界、数据失败或需要重新验证时通知。",
      },
    ],
    notes: [
      "Agent 客户端（Codex / Claude Code / WorkBuddy）需要保持运行，涉及本地文件的定时任务还需要电脑保持开机。",
      "技能名前缀因客户端而异：Codex 用 $skill，Claude Code 用 /hrouter-market-pulse:skill，WorkBuddy 直接写技能名。",
      "启用高频盘中任务前，应先手动测试一次并确认自选股、时区和通知条件。",
      "美国市场应依据市场状态处理夏令时，不固定写死北京时间开盘时刻。",
    ],
  };
}

export function sanitizePreferences(input, current = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Preferences must be an object.");
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  for (const field of ["watchlist", "positions", "alertRules"]) {
    if (input[field] !== undefined && (!Array.isArray(input[field]) || input[field].length > (field === "watchlist" ? 50 : 100))) throw new Error(`${field} must be a bounded array.`);
  }
  for (const field of ["benchmarkSymbols", "sectorMap", "calendarOverrides"]) {
    if (input[field] !== undefined && !isRecord(input[field])) throw new Error(`${field} must be an object.`);
  }
  if (input.language !== undefined && !["zh-CN", "en"].includes(input.language)) throw new Error("Invalid language.");
  if (input.monitorIntervalSeconds !== undefined && (!Number.isInteger(input.monitorIntervalSeconds) || input.monitorIntervalSeconds < 60 || input.monitorIntervalSeconds > 3600)) throw new Error("monitorIntervalSeconds must be an integer from 60 to 3600.");
  for (const [market, symbol] of Object.entries(input.benchmarkSymbols ?? {})) {
    if (!["A", "HK", "US"].includes(market) || marketFromSymbol(symbol) !== market) throw new Error("Benchmark market and symbol must match A, HK or US.");
  }
  for (const [symbol, sector] of Object.entries(input.sectorMap ?? {})) {
    normalizeSymbol(symbol);
    if (typeof sector !== "string" || !sector.trim() || sector.length > 160) throw new Error("Sector names must be nonempty text up to 160 characters.");
  }
  const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  for (const [market, calendar] of Object.entries(input.calendarOverrides ?? {})) {
    if (!["A", "HK", "US"].includes(market) || !isRecord(calendar) || !validDate(calendar.coverageStart) || !validDate(calendar.coverageEnd) || calendar.coverageStart > calendar.coverageEnd || !Number.isFinite(Date.parse(calendar.verifiedAt)) || typeof calendar.source !== "string" || !/^https?:\/\//.test(calendar.source)) throw new Error("Calendar overrides require market, valid coverage dates, verifiedAt and a source URL.");
    for (const field of ["closedDates", "openDates"]) {
      if (calendar[field] !== undefined && (!Array.isArray(calendar[field]) || calendar[field].some((value) => !validDate(value) || value < calendar.coverageStart || value > calendar.coverageEnd))) throw new Error(`Invalid calendar ${field}.`);
    }
    if (calendar.sessions !== undefined && !isRecord(calendar.sessions)) throw new Error("Calendar sessions must be dated objects.");
    for (const [date, override] of Object.entries(calendar.sessions ?? {})) {
      if (!validDate(date) || date < calendar.coverageStart || date > calendar.coverageEnd || !isRecord(override)) throw new Error("Invalid session override date.");
      if (override.closed !== undefined && typeof override.closed !== "boolean") throw new Error("Session closed must be boolean.");
      if (override.sessions !== undefined && (!Array.isArray(override.sessions) || !override.sessions.length || override.sessions.some((segment, index, all) => !Array.isArray(segment) || segment.length !== 2 || !segment.every(Number.isInteger) || segment[0] < 0 || segment[1] > 1440 || segment[0] >= segment[1] || index > 0 && segment[0] < all[index - 1][1]))) throw new Error("Session segments must be ordered [openMinute, closeMinute] pairs.");
    }
  }
  const next = {
    watchlist: Array.isArray(input.watchlist)
      ? [...new Set(input.watchlist.map(normalizeSymbol))].slice(0, 50)
      : current.watchlist ?? [],
    language: input.language ?? current.language ?? "zh-CN",
    positions: Array.isArray(input.positions) ? input.positions.map((position) => {
      const quantity = finite(position.quantity);
      const averageCost = finite(position.averageCost);
      if (!Number.isFinite(quantity) || quantity < 0 || !(averageCost > 0)) throw new Error("Positions require nonnegative quantity and positive averageCost.");
      for (const field of ["currency", "quoteCurrency"]) if (position[field] !== undefined && !/^[A-Z]{3}$/.test(position[field])) throw new Error("Position currency must be an uppercase three-letter code.");
      if ((position.currency ?? position.quoteCurrency ?? getInstrumentRules(normalizeSymbol(position.symbol)).currency) !== getInstrumentRules(normalizeSymbol(position.symbol)).currency) throw new Error("Position cost currency must match the instrument trading currency.");
      if (position.invalidationPrice !== undefined && !(finite(position.invalidationPrice) > 0)) throw new Error("Position invalidationPrice must be positive.");
      const symbol = normalizeSymbol(position.symbol);
      const existing = (current.positions ?? []).find((entry) => normalizeSymbol(entry.symbol) === symbol);
      return { ...existing, ...position, symbol, quantity, averageCost };
    }) : current.positions ?? [],
    benchmarkSymbols: input.benchmarkSymbols ? Object.fromEntries(Object.entries(input.benchmarkSymbols).map(([market, symbol]) => [market, normalizeSymbol(symbol)])) : current.benchmarkSymbols ?? {},
    sectorMap: input.sectorMap ? Object.fromEntries(Object.entries(input.sectorMap).map(([symbol, sector]) => [normalizeSymbol(symbol), sector.trim()])) : current.sectorMap ?? {},
    alertRules: Array.isArray(input.alertRules) ? input.alertRules.map((rule) => {
      if (!Number.isFinite(rule.threshold) || !["above", "below"].includes(rule.direction)) throw new Error("Alert rules require numeric threshold and above/below direction.");
      if (rule.field !== undefined && !["price", "changePct", "volumeRatioSameTime"].includes(rule.field)) throw new Error("Invalid alert field.");
      if (rule.field !== "changePct" && rule.threshold <= 0) throw new Error("Price and volume thresholds must be positive.");
      if (rule.confirmations !== undefined && (!Number.isInteger(rule.confirmations) || rule.confirmations < 1 || rule.confirmations > 20)) throw new Error("Alert confirmations must be from 1 to 20.");
      for (const field of ["cooldownSeconds", "hysteresisPct", "recoveryDelta"]) if (rule[field] !== undefined && (!Number.isFinite(rule[field]) || rule[field] < 0)) throw new Error(`Invalid alert ${field}.`);
      return { ...rule, symbol: normalizeSymbol(rule.symbol) };
    }) : current.alertRules ?? [],
    calendarOverrides: input.calendarOverrides ?? current.calendarOverrides ?? {},
    monitorIntervalSeconds: input.monitorIntervalSeconds ?? current.monitorIntervalSeconds ?? 300,
    // Arena account whose agent manages the owner's portfolio (null = follow the most active account).
    managedAccountId: input.managedAccountId === undefined ? current.managedAccountId ?? null : input.managedAccountId,
    defaultAgentIntervalMinutes: input.defaultAgentIntervalMinutes === undefined ? current.defaultAgentIntervalMinutes ?? 15 : input.defaultAgentIntervalMinutes,
    // Optional end-of-day arena digest push: generic JSON POST, or WeChat Work / Feishu bot payloads.
    digestWebhook: input.digestWebhook === undefined ? current.digestWebhook ?? null : sanitizeDigestWebhook(input.digestWebhook),
  };
  if (next.managedAccountId !== null && !/^acc_[a-f0-9]{12}$/.test(next.managedAccountId)) throw new Error("managedAccountId must be an arena account id or null.");
  if (!Number.isInteger(next.defaultAgentIntervalMinutes) || next.defaultAgentIntervalMinutes < 0 || next.defaultAgentIntervalMinutes > 240 || (next.defaultAgentIntervalMinutes > 0 && next.defaultAgentIntervalMinutes < 5))
    throw new Error("defaultAgentIntervalMinutes must be 0 (off) or a whole number of minutes from 5 to 240.");
  return next;
}

function sanitizeDigestWebhook(input) {
  if (input === null || input === "" || (isPlainObject(input) && !String(input.url ?? "").trim())) return null;
  if (!isPlainObject(input)) throw new Error("digestWebhook must be an object with a url, or null.");
  const url = String(input.url).trim();
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("digestWebhook.url must be a valid http(s) URL."); }
  if (!["https:", "http:"].includes(parsed.protocol) || url.length > 2000) throw new Error("digestWebhook.url must be an http(s) URL up to 2000 characters.");
  const format = input.format ?? "generic";
  if (!["generic", "wecom", "feishu"].includes(format)) throw new Error("digestWebhook.format must be generic, wecom or feishu.");
  return { url, format, enabled: input.enabled !== false };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function savePreferences(input) {
  const next = sanitizePreferences(input, await loadPreferences());
  await mkdir(getStorageDir(), { recursive: true });
  await atomicWrite(preferencesPath(), JSON.stringify(next, null, 2));
  return loadPreferences();
}

export function getReportPort() {
  const value = Number(process.env.HROUTER_REPORT_PORT ?? 8787);
  // 0 asks the OS for any free port (health checks, tests).
  if (value === 0 && process.env.HROUTER_REPORT_PORT?.trim() === "0") return 0;
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : 8787;
}

export function getReportUrl(runId = "latest") {
  return `http://127.0.0.1:${getReportPort()}/runs/${encodeURIComponent(runId)}`;
}

function portfolioForQuote(positions, quote) {
  const position = positions.find((candidate) => {
    try {
      return normalizeSymbol(candidate.symbol) === quote.symbol;
    } catch {
      return false;
    }
  });
  if (!position) return null;
  const quantity = finite(position.quantity);
  const averageCost = finite(position.averageCost);
  const marketValue = quantity !== null && quote.price !== null ? quantity * quote.price : null;
  const unrealizedPnl = quantity !== null && averageCost !== null && quote.price !== null
    ? quantity * (quote.price - averageCost)
    : null;
  return {
    quantity,
    averageCost,
    currency: quote.currency,
    invalidationPrice: finite(position.invalidationPrice),
    riskAtInvalidation: quantity !== null && finite(position.invalidationPrice) !== null && quote.price !== null ? quantity * Math.abs(quote.price - Number(position.invalidationPrice)) : null,
    marketValue: round(marketValue),
    unrealizedPnl: round(unrealizedPnl),
    unrealizedPnlPct: averageCost && quote.price !== null ? round((quote.price / averageCost - 1) * 100) : null,
  };
}

export async function createMarketReport(input = {}) {
  const preferences = await loadPreferences();
  const requestedSymbols = Array.isArray(input.symbols) && input.symbols.length ? input.symbols : preferences.watchlist;
  if (!requestedSymbols.length) {
    throw new Error("首次使用尚未设置自选股。请先调用 get_onboarding 查看引导，再使用 save_preferences 保存自选股；也可以为本次报告直接传入 symbols。");
  }
  const symbols = [...new Set(requestedSymbols.map(normalizeSymbol))].slice(0, 20);
  const positions = Array.isArray(input.positions) ? input.positions : preferences.positions;
  const phase = Object.hasOwn(PHASE_LABELS, input.phase) ? input.phase : "research";
  const generatedAt = new Date().toISOString();

  const items = await Promise.all(symbols.map(async (symbol) => {
    try {
      const quote = await getQuote(symbol, { phase, calendarOverrides: input.calendarOverrides ?? preferences.calendarOverrides });
      const news = input.includeNews === false ? [] : await getNews(quote.name || symbol, 5, { symbol }).catch(() => []);
      return {
        ...quote,
        position: portfolioForQuote(positions, quote),
        news,
      };
    } catch (error) {
      return {
        symbol,
        market: marketFromSymbol(symbol),
        error: error.message,
        source: "Yahoo Finance + Tencent Finance",
      };
    }
  }));

  const successful = items.filter((item) => !item.error);
  const monitoring = phase === "intraday" ? await updateMonitorState(getStorageDir(), successful, { rules: input.alertRules ?? preferences.alertRules, now: new Date().toISOString() }) : { events: [], generatedAt };
  for (const item of successful) {
    item.alertEvents = monitoring.events.filter((event) => event.symbol === item.symbol);
    item.alerts = item.alertEvents.map((event) => event.code);
  }
  const marketCounts = successful.reduce((counts, item) => {
    counts[item.market] = (counts[item.market] ?? 0) + 1;
    return counts;
  }, { A: 0, HK: 0, US: 0 });
  const advances = successful.filter((item) => (item.changePct ?? 0) > 0).length;
  const declines = successful.filter((item) => (item.changePct ?? 0) < 0).length;
  const report = {
    schemaVersion: 2,
    runId: generatedAt.replace(/[:.]/g, "-") + `-${phase}-${randomUUID().slice(0, 8)}`,
    generatedAt,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    language: input.language === "en" || input.language === "zh-CN" ? input.language : preferences.language,
    monitorIntervalSeconds: preferences.monitorIntervalSeconds,
    alertEvents: monitoring.events,
    coverage: { scope: "watchlist", symbols, wholeMarketBreadth: false },
    source: "Yahoo Finance + Tencent Finance cross-check",
    sourceNotice: "公开行情可能延迟、缺失或在不同来源间存在差异。任何交易动作都应先以券商行情、交易规则和可用余额复核。",
    summary: {
      requested: symbols.length,
      succeeded: successful.length,
      failed: items.length - successful.length,
      advances,
      declines,
      unchanged: successful.length - advances - declines,
      staleCount: successful.filter((item) => item.freshness?.status !== "fresh").length,
      signalEligibleCount: successful.filter((item) => item.signalEligible).length,
      marketCounts,
      alertCount: successful.reduce((sum, item) => sum + item.alerts.length, 0),
      qualityWarningCount: successful.reduce((sum, item) => sum + (item.dataQuality?.warnings?.length ?? 0), 0),
      crossCheckDisagreementCount: successful.filter((item) => item.crossCheck?.status === "divergent").length,
    },
    items,
  };

  if (typeof input.enrichReport === "function") await input.enrichReport(report);
  await saveReport(report);
  return {
    ...report,
    dashboardUrl: getReportUrl(report.runId),
    latestDashboardUrl: getReportUrl(),
  };
}

async function atomicWrite(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

export async function saveReport(report) {
  const reportDir = path.join(getStorageDir(), "reports");
  await mkdir(reportDir, { recursive: true });
  const json = JSON.stringify(report, null, 2);
  const html = buildReportHtml(report);
  await Promise.all([
    atomicWrite(path.join(reportDir, `${report.runId}.json`), json),
    atomicWrite(path.join(reportDir, `${report.runId}.html`), html),
    atomicWrite(path.join(reportDir, "latest.json"), json),
    atomicWrite(path.join(reportDir, "latest.html"), html),
  ]);
}

export async function loadReport(runId = "latest", format = "json") {
  const safeRunId = String(runId).replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeRunId) throw new Error("无效的报告编号");
  return readFile(path.join(getStorageDir(), "reports", `${safeRunId}.${format}`), "utf8");
}

// Whole-market scanner (East Money ranking lists). Lets agents and strategies pick from every board —
// main board, ChiNext, STAR, the Beijing Stock Exchange, ST names, HK and US — instead of a few
// remembered large caps. Values are a delayed-to-realtime public snapshot; confirm with get_quote
// before trading.
const EASTMONEY_LIST = "https://push2.eastmoney.com/api/qt/clist/get";
export const SCAN_SORTS = Object.freeze({ change: "f3", amount: "f6", turnover: "f8", volumeRatio: "f10", speed: "f22", mainInflow: "f62", amplitude: "f7", marketCap: "f20" });
export const A_BOARDS = Object.freeze({ main: ["m:1+t:2", "m:0+t:6"], chinext: ["m:0+t:80"], star: ["m:1+t:23"], bse: ["m:0+t:81+s:2048"] });
const SCAN_FIELDS = "f2,f3,f5,f6,f7,f8,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f22,f62,f100";

function scanSymbol(code, marketId, market) {
  if (market === "HK") return `${String(Number(code)).padStart(4, "0")}.HK`;
  if (market === "US") return String(code).replace(/_/g, "-");
  if (/^(92|8|4)/.test(code)) return `${code}.BJ`;
  return `${code}.${marketId === 1 ? "SS" : "SZ"}`;
}

function boardOf(symbol, name) {
  const st = /ST/i.test(name ?? "");
  const board = symbol.endsWith(".BJ") ? "bse" : /^68/.test(symbol) ? "star" : /^30/.test(symbol) ? "chinext" : "main";
  return { board, st };
}

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function parseEastmoneyList(payload, { market = "A" } = {}) {
  return (payload?.data?.diff ?? []).map((row) => {
    const symbol = scanSymbol(row.f12, row.f13, market);
    const { board, st } = market === "A" ? boardOf(symbol, row.f14) : { board: null, st: false };
    return {
      symbol, name: row.f14, market, board, st, industry: row.f100 && row.f100 !== "-" ? row.f100 : null,
      price: number(row.f2), changePct: number(row.f3), amount: number(row.f6), turnoverPct: number(row.f8),
      volumeRatio: number(row.f10), speedPct: number(row.f22), mainNetInflow: number(row.f62), amplitudePct: number(row.f7),
      open: number(row.f17), high: number(row.f15), low: number(row.f16), previousClose: number(row.f18),
      marketCap: number(row.f20), floatMarketCap: number(row.f21),
    };
  }).filter((row) => row.price !== null);
}

// IB scanner codes for the scanMarket sorts TWS can rank by; other sorts use the public lists.
const IBKR_SCANS = { "change:desc": "TOP_PERC_GAIN", "change:asc": "TOP_PERC_LOSE", "amount:desc": "MOST_ACTIVE_USD", "turnover:desc": "HOT_BY_VOLUME", "volumeRatio:desc": "HOT_BY_VOLUME", "speed:desc": "TOP_TRADE_RATE" };

export async function scanMarket(input = {}) {
  const { market = "A", view = "stocks", sort = "change", order = "desc", sector, minAmount = 0, limit = 30 } = input;
  const scanCode = market === "US" && view === "stocks" && !sector && input.ibkr !== false ? IBKR_SCANS[`${sort}:${order === "asc" ? "asc" : "desc"}`] : null;
  if (scanCode) {
    const bounded = Math.max(1, Math.min(50, Number(limit) || 30));
    const result = await tws().ibkrScan({ scanCode, rows: Math.min(50, bounded * (minAmount > 0 ? 2 : 1)), abovePrice: 1 }).catch(() => null);
    if (result) {
      const rows = result.rows.map((row) => {
        const price = Number.isFinite(row.price) ? row.price : null;
        return { symbol: row.symbol, name: row.name, market: "US", board: null, st: false, industry: null, price,
          changePct: price && row.previousClose > 0 ? (price / row.previousClose - 1) * 100 : null, amount: price && row.volume ? price * row.volume : null,
          turnoverPct: null, volumeRatio: null, speedPct: null, mainNetInflow: null, amplitudePct: null, open: row.open ?? null, high: row.high ?? null, low: row.low ?? null,
          previousClose: row.previousClose ?? null, marketCap: null, floatMarketCap: null, rank: row.rank, delayed: Boolean(row.delayed), delayMinutes: row.delayMinutes ?? 0 };
      }).filter((row) => !(minAmount > 0) || row.amount === null || row.amount >= minAmount).slice(0, bounded);
      const delayed = rows.some((row) => row.delayed);
      return { market, view, sort, order, boards: null, includeST: true, sector: null, total: null, asOf: new Date().toISOString(), source: `IBKR TWS scanner (${scanCode})`, rows,
        ...(delayed ? { note: "IB ranks the list live; prices on this login are delayed about 15 minutes (no real-time subscription). Confirm with get_quote before trading." } : {}) };
    }
  }
  try { return await publicScan(input); }
  catch (error) {
    if (market !== "US" && market !== "HK" || view !== "stocks" || sector) throw error;
    // East Money refuses connections at times (it rate-limits by IP); rank from Sina instead.
    const fallback = await rankedPage(market, { sort: sort === "amount" ? "amount" : "change", asc: order === "asc", size: Math.max(1, Math.min(100, Number(limit) || 30)) });
    return { market, view, sort, order, boards: null, includeST: true, sector: null, total: fallback.total ?? null, asOf: new Date().toISOString(), source: fallback.source, rows: fallback.rows.filter((row) => row.price).map((row) => ({ ...row, market })), note: `East Money unavailable (${error.message}); ranked by ${fallback.source}.` };
  }
}

async function publicScan({ market = "A", view = "stocks", sort = "change", order = "desc", boards, includeST = true, sector, minAmount = 0, limit = 30 } = {}) {
  const bounded = Math.max(1, Math.min(100, Number(limit) || 30));
  const fid = SCAN_SORTS[sort] ?? "f3";
  if (view === "sectors" || view === "concepts") {
    const payload = await fetchJson(`${EASTMONEY_LIST}?pn=1&pz=${bounded}&po=${order === "asc" ? 0 : 1}&np=1&fltt=2&invt=2&fid=${fid}&fs=${view === "concepts" ? "m:90+t:3" : "m:90+t:2"}&fields=f2,f3,f6,f8,f12,f14,f62,f104,f105,f128,f140,f141`, 10000, false);
    return {
      market: "A", view, sort, asOf: new Date().toISOString(), source: "East Money",
      rows: (payload?.data?.diff ?? []).map((row) => ({ code: row.f12, name: row.f14, changePct: number(row.f3), amount: number(row.f6), turnoverPct: number(row.f8), mainNetInflow: number(row.f62), advancers: row.f104 ?? null, decliners: row.f105 ?? null, leader: row.f128 ? { name: row.f128, symbol: scanSymbol(row.f140, Number(row.f141), "A") } : null })),
    };
  }
  let fs;
  if (sector) fs = `b:${String(sector).toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
  else if (market === "HK") fs = "m:128+t:3,m:128+t:4,m:128+t:1,m:128+t:2";
  else if (market === "US") fs = "m:105,m:106,m:107";
  else fs = (boards?.length ? boards : Object.keys(A_BOARDS)).flatMap((board) => A_BOARDS[board] ?? []).join(",");
  if (!fs) throw new Error("No board selected. Use main, chinext, star or bse.");
  // Over-fetch so ST / turnover filters still leave enough rows.
  const filtered = !includeST || minAmount > 0;
  const payload = await fetchJson(`${EASTMONEY_LIST}?pn=1&pz=${filtered ? Math.min(300, bounded * 4) : bounded}&po=${order === "asc" ? 0 : 1}&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${SCAN_FIELDS}`, 10000, false);
  const rows = parseEastmoneyList(payload, { market: sector ? "A" : market })
    .filter((row) => includeST || !row.st)
    .filter((row) => !(minAmount > 0) || (row.amount ?? 0) >= minAmount)
    .slice(0, bounded);
  return { market, view: "stocks", sort, order, boards: boards ?? (market === "A" ? Object.keys(A_BOARDS) : null), includeST, sector: sector ?? null, total: payload?.data?.total ?? null, asOf: new Date().toISOString(), source: "East Money", rows };
}

// Today's 1-minute bars (A-share incl. Beijing, HK) from Tencent: price, volume and running VWAP.
// US names use Yahoo 5-minute bars. Bars are only the minutes that have already completed.
export function parseTencentMinutes(payload, code, market) {
  const node = payload?.data?.[code]?.data;
  const rows = node?.data ?? [];
  const date = String(node?.date ?? "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  // Volume is in 100-share lots for most A-shares but in shares for STAR / some boards: infer the
  // unit from the last row (turnover ÷ raw volume is ~100× the price when volume is in lots).
  const [, lastPrice, lastVolume, lastAmount] = String(rows.at(-1) ?? "").split(" ").map(Number);
  const volumeUnit = market !== "A" ? 1 : lastAmount > 0 && lastVolume > 0 ? (lastAmount / lastVolume > lastPrice * 20 ? 100 : 1) : 100;
  let previousVolume = 0, estimatedAmount = 0;
  return rows.map((line) => {
    const [time, price, cumVolume, cumAmount] = String(line).split(" ");
    const volume = Number(cumVolume) * volumeUnit;
    const delta = Math.max(0, volume - previousVolume);
    // Some feeds (Beijing) omit turnover: estimate it from each minute's price × volume.
    estimatedAmount += delta * Number(price);
    const amount = Number(cumAmount) > 0 ? Number(cumAmount) : estimatedAmount;
    const bar = { time: `${time.slice(0, 2)}:${time.slice(2, 4)}`, date: date || null, price: Number(price), volume: delta, cumVolume: volume, vwap: volume > 0 && amount > 0 ? amount / volume : Number(price) };
    previousVolume = volume;
    return bar;
  }).filter((bar) => Number.isFinite(bar.price) && bar.price > 0);
}

export async function getIntradayBars(input) {
  const symbol = normalizeSymbol(input);
  const market = marketFromSymbol(symbol);
  if (market === "US" && input?.ibkr !== false) {
    const bars = await tws().ibkrBars(symbol, { duration: "1 D", barSize: "5 mins", what: "TRADES", useRTH: true }).catch(() => null);
    if (bars) {
      const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
      let cumVolume = 0, cumAmount = 0;
      const rows = bars.bars.map((bar) => {
        const at = new Date(bar.date);
        cumVolume += bar.volume ?? 0; cumAmount += (bar.volume ?? 0) * (bar.average ?? bar.close);
        return { time: clock.format(at), date: day.format(at), price: bar.close, volume: bar.volume ?? 0, cumVolume, vwap: cumVolume ? cumAmount / cumVolume : bar.close };
      });
      const lastEnd = bars.bars.length ? Date.parse(bars.bars.at(-1).date) + 5 * 60000 : null;
      const lagMinutes = lastEnd ? Math.max(0, Math.round((Date.now() - lastEnd) / 60000)) : null;
      const open = getMarketSession("US").status === "open";
      return { symbol, market, period: "5m", source: "IBKR TWS", bars: rows, ...(open && lagMinutes > 6 ? { delayed: true, delayMinutes: lagMinutes } : { delayed: false }) };
    }
  }
  if (market === "US") {
    const quote = await getYahooQuote(symbol, { interval: "5m", range: "1d", historyLimit: 200 });
    let cumVolume = 0, cumAmount = 0;
    return { symbol, market, period: "5m", source: "Yahoo Finance", bars: (quote.history ?? []).map((bar) => {
      cumVolume += bar.volume ?? 0; cumAmount += (bar.volume ?? 0) * bar.close;
      return { time: String(bar.timestamp ?? bar.date).slice(11, 16), date: String(bar.timestamp ?? bar.date).slice(0, 10), price: bar.close, volume: bar.volume ?? 0, cumVolume, vwap: cumVolume ? cumAmount / cumVolume : bar.close };
    }) };
  }
  const code = tencentCodeForSymbol(symbol);
  const payload = await fetchJson(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`, 10000, false);
  return { symbol, market, period: "1m", source: "Tencent Finance", bars: parseTencentMinutes(payload, code, market) };
}
