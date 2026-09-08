import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { calculatePositionBudget, computeIndicators, crossCheckQuotes, getQuote, parseTencentQuote, parseYahooChart, sanitizePreferences, savePreferences } from "../mcp/core.mjs";
import { assessQuoteFreshness, dailyBarMetadata, getInstrumentRules, getMarketSession, marketLocalToIso, sameTimeVolumeRatio } from "../mcp/market-rules.mjs";
import { evaluateAlertTransitions, updateMonitorState } from "../mcp/monitor.mjs";

const now = "2026-09-08T02:00:00Z";
const current = { symbol: "600519.SS", market: "A", currency: "CNY", price: 100, changePct: 1, asOf: "2026-09-08T01:59:00Z" };

test("warmups, flat RSI and Wilder published reference sequence", () => {
  assert.equal(computeIndicators([1, 2, 3]).sma60, null);
  assert.equal(computeIndicators(Array(60).fill(100)).rsi14, 50);
  const rsi = computeIndicators([44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]).rsi14;
  assert.ok(Math.abs(rsi - 70.464135) < 0.00001);
  assert.equal(computeIndicators(Array(14).fill(100)).rsi14, null);
  assert.equal(computeIndicators(Array(25).fill(100)).macd, null);
  assert.equal(computeIndicators(Array(33).fill(100)).macdSignal, null);
  assert.equal(computeIndicators(Array(34).fill(100)).macdSignal, 0);
});

test("missing values preserve aligned rows and do not coerce into zero", () => {
  const closes = Array.from({ length: 60 }, (_, index) => 10 + index / 1000);
  assert.equal(computeIndicators(closes).sma60, 10.0295);
  assert.equal(computeIndicators([...closes, null]).sampleCount, 0);
  const highs = closes.map((price) => price + 1);
  highs[55] = null;
  const result = computeIndicators(closes, highs, closes, closes);
  assert.equal(result.resistance20d, null);
  assert.ok(result.support20d > 0);
  const fields = Array(35).fill("");
  fields[3] = "0.123456";
  const quote = parseTencentQuote(`v_test="${fields.join("~")}";`, "AAPL");
  assert.equal(quote.price, 0.123456);
  assert.equal(quote.previousClose, null);
  assert.equal(quote.dayHigh, null);
  assert.equal(quote.change, null);
});

test("freshness withholds old, future and missing timestamps", () => {
  assert.equal(assessQuoteFreshness(current, { now }).signalEligible, true);
  for (const asOf of ["2020-01-01T00:00:00Z", null, "2026-09-08T03:00:00Z"]) {
    const result = assessQuoteFreshness({ ...current, asOf }, { now });
    assert.equal(result.signalEligible, false);
    assert.notEqual(result.status, "fresh");
    assert.equal(crossCheckQuotes({ ...current, asOf }, { ...current, asOf }, { now }).status, "stale");
  }
  assert.equal(crossCheckQuotes(current, { ...current, asOf: "2026-09-08T01:50:00Z" }, { now }).status, "time-mismatch");
  assert.equal(crossCheckQuotes(current, { ...current, price: 100.5 }, { now }).status, "matched");
  assert.equal(crossCheckQuotes(current, { ...current, currency: "USD" }, { now }).status, "currency-mismatch");
});

test("official calendars handle holidays, lunch, half days, DST and coverage expiry", () => {
  assert.equal(getMarketSession("A", "2026-10-05T02:00:00Z").status, "closed");
  assert.equal(getMarketSession("HK", "2026-04-07T02:00:00Z").status, "closed");
  assert.equal(getMarketSession("A", "2026-09-08T04:00:00Z").status, "break");
  assert.equal(getMarketSession("US", "2026-09-07T15:00:00Z").status, "closed");
  assert.equal(getMarketSession("US", "2026-11-27T18:01:00Z").status, "postmarket");
  assert.equal(getMarketSession("HK", "2026-12-24T04:01:00Z").status, "postmarket");
  assert.equal(marketLocalToIso("2026-07-10", 570, "US"), "2026-07-10T13:30:00.000Z");
  assert.equal(marketLocalToIso("2026-01-09", 570, "US"), "2026-01-09T14:30:00.000Z");
  assert.equal(assessQuoteFreshness({ ...current, asOf: "2027-01-05T01:59:00Z" }, { now: "2027-01-05T02:00:00Z" }).status, "unverified-calendar");
  assert.equal(getInstrumentRules("300750.SZ", { asOf: "2020-08-20" }).priceLimitPct, 10);
  assert.equal(getInstrumentRules("300750.SZ", { asOf: "2020-08-25" }).priceLimitPct, 20);
});

test("closed markets retain the latest completed session reference without marking it stale", () => {
  const quote = { symbol: "AAPL", market: "US", currency: "USD", price: 100, asOf: "2026-09-04T20:00:00Z" };
  const result = assessQuoteFreshness(quote, { now: "2026-09-07T16:00:00Z" });
  assert.equal(result.status, "market-closed");
  assert.equal(result.referenceSession, "2026-09-04");
  assert.equal(result.signalEligible, false);
  assert.equal(assessQuoteFreshness({ ...quote, asOf: "2026-09-03T20:00:00Z" }, { now: "2026-09-07T16:00:00Z" }).status, "stale");
  assert.equal(assessQuoteFreshness({ ...current, asOf: "2026-09-08T03:30:00Z" }, { now: "2026-09-08T04:30:00Z" }).status, "market-closed");
});

test("daily indicators exclude current incomplete session and retain raw split data", () => {
  const timestamps = Array.from({ length: 40 }, (_, index) => Date.parse("2026-07-01T01:30:00Z") / 1000 + index * 86400);
  timestamps.push(Date.parse("2026-09-08T01:30:00Z") / 1000);
  const values = Array(40).fill(10).concat(1000);
  const payload = { chart: { result: [{ timestamp: timestamps, meta: { regularMarketPrice: 1000, regularMarketTime: Date.parse(now) / 1000, currency: "CNY" }, indicators: { quote: [{ close: values, high: values, low: values, open: values, volume: Array(26).fill(100) }], adjclose: [{ adjclose: values }] }, events: { splits: { one: { date: timestamps[0], numerator: 2, denominator: 1 } } } }] } };
  const quote = parseYahooChart("600519.SS", payload, { now });
  assert.equal(quote.history.at(-1).complete, false);
  assert.equal(quote.indicators.sma20, 10);
  assert.equal(quote.price, 1000);
  assert.equal(quote.corporateActions[0].ratio, 2);
  assert.equal(dailyBarMetadata("2026-11-27T14:30:00Z", "US", { now: "2026-11-27T18:02:00Z" }).complete, true);
});

test("quote fetching separates daily indicators from 5-minute bars and checks both timestamps", async (t) => {
  const requests = [];
  const fields = Array(35).fill("");
  fields[3] = "100"; fields[4] = "99"; fields[30] = "20260908100000";
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    if (String(url).includes("gtimg")) return new Response(`v_test="${fields.join("~")}";`);
    const intraday = String(url).includes("interval=5m");
    const times = intraday ? [Date.parse("2026-09-08T01:30:00Z") / 1000] : Array.from({ length: 60 }, (_, index) => Date.parse("2026-05-01T01:30:00Z") / 1000 + index * 86400);
    const prices = times.map(() => intraday ? 100 : 90);
    return Response.json({ chart: { result: [{ timestamp: times, meta: { regularMarketPrice: 100, regularMarketTime: Date.parse(now) / 1000, currency: "CNY" }, indicators: { quote: [{ close: prices, open: prices, high: prices, low: prices, volume: times.map(() => 100) }] } }] } });
  });
  const quote = await getQuote("600519", { phase: "intraday", now, calendarOverrides: {} });
  assert.equal(quote.crossCheck.status, "matched");
  assert.equal(quote.signalEligible, true);
  assert.equal(quote.period, "1d");
  assert.equal(quote.indicators.sma20, 90);
  assert.equal(quote.intraday.period, "5m");
  assert.equal(quote.intraday.history[0].close, 100);
  assert.equal(quote.intraday.volumeRatioSameTime.value, null);
  assert.ok(requests.some((url) => url.includes("interval=5m")));
});

test("direct quote tools use the saved dated calendar outside bundled coverage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hrouter-calendar-test-"));
  const previousDirectory = process.env.HROUTER_REPORT_DIR;
  const originalFetch = globalThis.fetch;
  const futureNow = "2027-01-05T02:00:00Z";
  process.env.HROUTER_REPORT_DIR = directory;
  globalThis.fetch = async (url) => {
    if (String(url).includes("gtimg")) {
      const fields = Array(35).fill("");
      fields[3] = "100"; fields[4] = "99"; fields[30] = "20270105100000";
      return new Response(`v_test="${fields.join("~")}";`);
    }
    return Response.json({ chart: { result: [{ timestamp: [], meta: { regularMarketPrice: 100, regularMarketTime: Date.parse(futureNow) / 1000, currency: "CNY" }, indicators: { quote: [{}] } }] } });
  };
  try {
    await savePreferences({ calendarOverrides: { A: { coverageStart: "2027-01-01", coverageEnd: "2027-12-31", verifiedAt: "2026-12-31T00:00:00Z", source: "https://www.sse.com.cn/calendar-fixture", closedDates: [] } } });
    const quote = await getQuote("600519", { now: futureNow });
    assert.equal(quote.freshness.calendarCoverage, "dated-override");
    assert.equal(quote.signalEligible, true);
    const withoutSavedCalendar = await getQuote("600519", { now: futureNow, calendarOverrides: {} });
    assert.equal(withoutSavedCalendar.freshness.status, "unverified-calendar");
    assert.equal(withoutSavedCalendar.signalEligible, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDirectory === undefined) delete process.env.HROUTER_REPORT_DIR;
    else process.env.HROUTER_REPORT_DIR = previousDirectory;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("hrouter-calendar-test-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("intraday volume compares identical complete clock slots and excludes partial bars", () => {
  const history = [1, 2, 3, 4, 7, 8].flatMap((day) => [570, 575, 580].map((minute) => ({ timestamp: marketLocalToIso(`2026-09-${String(day).padStart(2, "0")}`, minute, "A"), volume: day === 8 ? minute === 580 ? 99999 : 200 : 100 })));
  const options = { now: "2026-09-08T01:42:00Z" };
  const result = sameTimeVolumeRatio(history, "A", options);
  assert.equal(result.value, 2);
  assert.equal(result.cumulativeVolume, 400);
  assert.equal(result.samples, 5);
  assert.equal(sameTimeVolumeRatio(history.slice(1), "A", options).value, null);
});

const budget = { capital: 10000, capitalCurrency: "CNY", maxLossPctPerIdea: 2, maxAggregateLossPct: 3, maxPositionPct: 70, asOf: "2026-09-08T02:00:00Z" };
test("budget requires dated FX and retains full precision quote price", () => {
  const input = { ...budget, ideas: [{ symbol: "AAPL", entryPrice: 10.12345, invalidationPrice: 9, lotSize: 1 }] };
  assert.throws(() => calculatePositionBudget(input), /FX/);
  assert.throws(() => calculatePositionBudget({ ...input, ideas: [{ ...input.ideas[0], quoteCurrency: "CNY" }] }), /currency/);
  assert.throws(() => calculatePositionBudget({ ...input, fxRates: [{ from: "USD", to: "CNY", rate: 7, asOf: "2020-01-01", source: "fixture" }] }), /FX/);
  const result = calculatePositionBudget({ ...input, fxRates: [{ from: "USD", to: "CNY", rate: 7, asOf: "2026-09-08T01:00:00Z", source: "fixture" }] });
  assert.equal(result.ideas[0].entryPrice, 10.12345);
  assert.equal(result.ideas[0].fxRate, 7);
  assert.equal(result.ideas[0].modeledPositionValue, result.ideas[0].quantityCeiling * 10.12345 * 7);
});

test("portfolio allocation shares remaining cash and aggregate risk after existing holdings", () => {
  const input = { ...budget, capitalCurrency: "USD", availableCash: 1500, existingPositions: [{ symbol: "MSFT", quantity: 50, marketPrice: 100, invalidationPrice: 98 }], ideas: [{ symbol: "AAPL", entryPrice: 100, invalidationPrice: 90 }, { symbol: "NVDA", entryPrice: 100, invalidationPrice: 90 }] };
  const result = calculatePositionBudget(input);
  assert.ok(result.aggregateIfAllUsed.modeledPositionValue <= 1500);
  assert.ok(result.aggregateIfAllUsed.totalRiskIncludingExisting <= 300);
  assert.ok(result.aggregateIfAllUsed.cashRemaining >= 0);
  assert.equal(result.status, "scaled-to-portfolio-limits");
  assert.throws(() => calculatePositionBudget({ ...input, availableCash: 6000 }), /availableCash/);
  assert.throws(() => calculatePositionBudget({ ...input, existingPositions: [{ symbol: "MSFT", quantity: 50, marketPrice: 100 }] }), /unknown existing risk/);
  assert.throws(() => calculatePositionBudget({ ...input, existingPositions: [{ symbol: "MSFT", quantity: null, marketPrice: 100, invalidationPrice: 90 }] }), /unknown existing risk/);
});

test("preferences validation is reusable for HTTP and MCP without dropping existing holdings", () => {
  const currentPreferences = { watchlist: ["AAPL"], positions: [{ symbol: "AAPL", quantity: 5, averageCost: 100 }], language: "en" };
  const result = sanitizePreferences({ sectorMap: { aapl: "Technology" }, monitorIntervalSeconds: 60 }, currentPreferences);
  assert.deepEqual(result.positions, currentPreferences.positions);
  assert.equal(result.language, "en");
  assert.equal(result.sectorMap.AAPL, "Technology");
  assert.throws(() => sanitizePreferences({ positions: "bad" }, currentPreferences), /array/);
  assert.throws(() => sanitizePreferences({ positions: [{ symbol: "AAPL", quantity: null, averageCost: 100 }] }), /quantity/);
  assert.throws(() => sanitizePreferences({ monitorIntervalSeconds: 2 }), /60/);
  assert.throws(() => sanitizePreferences({ alertRules: [{ symbol: "AAPL", above: 100 }] }), /threshold/);
  assert.throws(() => sanitizePreferences({ calendarOverrides: { US: { coverageStart: "2027-01-01", coverageEnd: "2027-12-31", verifiedAt: now, source: "https://example.com", sessions: { "2027-01-05": { sessions: [[800, 570]] } } } } }), /segments/);
});

test("alert state requires a crossing and persistence, deduplicates timestamps and recovers", () => {
  const quote = (value, minute, eligible = true) => ({ ...current, changePct: value, asOf: `2026-09-08T02:${String(minute).padStart(2, "0")}:00Z`, freshness: { signalEligible: eligible }, crossCheck: { status: "matched" } });
  let result = evaluateAlertTransitions([quote(1, 0)], {}, { now });
  assert.equal(result.events.length, 0);
  result = evaluateAlertTransitions([quote(3.5, 1)], result.state, { now: "2026-09-08T02:01:00Z" });
  assert.equal(result.events.length, 0);
  result = evaluateAlertTransitions([quote(3.6, 2)], result.state, { now: "2026-09-08T02:02:00Z" });
  assert.equal(result.events[0].code, "threshold-crossed");
  assert.equal(evaluateAlertTransitions([quote(3.6, 2)], result.state, { now }).events.length, 0);
  assert.equal(evaluateAlertTransitions([quote(1, 3, false)], result.state, { now }).events.length, 0);
  result = evaluateAlertTransitions([quote(2.9, 3)], result.state, { now });
  assert.equal(result.events.length, 0);
  result = evaluateAlertTransitions([quote(2.7, 4)], result.state, { now: "2026-09-08T02:04:00Z" });
  assert.equal(result.events[0].code, "threshold-recovered");
  assert.equal(evaluateAlertTransitions([quote(4, 0)], {}, { now }).events.length, 0);
});

test("monitor persistence survives calls and cooldown prevents repeat trigger notifications", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hrouter-monitor-test-"));
  const quote = (price, minute) => ({ ...current, price, asOf: `2026-09-08T02:${String(minute).padStart(2, "0")}:00Z`, freshness: { signalEligible: true }, crossCheck: { status: "matched" } });
  const options = (minute) => ({ now: quote(0, minute).asOf, rules: [{ symbol: current.symbol, field: "price", direction: "above", threshold: 110, confirmations: 1, cooldownSeconds: 900 }] });
  try {
    assert.equal((await updateMonitorState(directory, [quote(100, 0)], options(0))).events.length, 0);
    assert.equal((await updateMonitorState(directory, [quote(111, 1)], options(1))).events[0].code, "threshold-crossed");
    assert.equal((await updateMonitorState(directory, [quote(100, 2)], options(2))).events[0].code, "threshold-recovered");
    assert.equal((await updateMonitorState(directory, [quote(112, 3)], options(3))).events.length, 0);
    const persisted = JSON.parse(await readFile(path.join(directory, "monitor-state.json"), "utf8"));
    assert.equal(Object.values(persisted.state)[0].active, true);
    await updateMonitorState(directory, [quote(100, 20)], options(20));
    assert.equal((await updateMonitorState(directory, [quote(112, 21)], options(21))).events[0].code, "threshold-crossed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
