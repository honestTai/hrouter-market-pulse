import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEmptyHtml,
  buildReportHtml,
  calculatePositionBudget,
  computeIndicators,
  marketFromSymbol,
  normalizeSymbol,
  parseTencentQuote,
  scoreQuoteForResearch,
} from "../mcp/core.mjs";

test("normalizes A-share, Hong Kong, and US symbols", () => {
  assert.equal(normalizeSymbol("600519"), "600519.SS");
  assert.equal(normalizeSymbol("000001"), "000001.SZ");
  assert.equal(normalizeSymbol("hk00700"), "0700.HK");
  assert.equal(normalizeSymbol("00700"), "0700.HK");
  assert.equal(normalizeSymbol("aapl"), "AAPL");
  assert.equal(marketFromSymbol("600519"), "A");
  assert.equal(marketFromSymbol("0700.HK"), "HK");
  assert.equal(marketFromSymbol("^HSCE"), "HK");
  assert.equal(marketFromSymbol("NVDA"), "US");
});

test("computes deterministic indicators", () => {
  const closes = Array.from({ length: 80 }, (_, index) => 100 + index * 0.5 + Math.sin(index));
  const highs = closes.map((value) => value + 1);
  const lows = closes.map((value) => value - 1);
  const volumes = closes.map((_, index) => 1_000_000 + index * 1_000);
  const indicators = computeIndicators(closes, highs, lows, volumes);
  assert.equal(indicators.trend, "上行");
  assert.ok(indicators.sma20 > indicators.sma60);
  assert.ok(indicators.rsi14 >= 0 && indicators.rsi14 <= 100);
  assert.ok(indicators.support20d < indicators.resistance20d);
});

test("withholds warmup-dependent indicators after an invalid-price gap", () => {
  const closes = [...Array.from({ length: 30 }, (_, index) => 100 + index), 0, 130];
  const highs = closes.map((value) => value && value + 1);
  const lows = closes.map((value) => value && value - 1);
  const indicators = computeIndicators(closes, highs, lows, Array(closes.length).fill(1_000));
  assert.equal(indicators.support20d, null);
  assert.equal(indicators.maxDrawdown60dPct, null);
  assert.equal(indicators.sampleCount, 1);
});

test("parses a Tencent Finance quote and market-local timestamp", () => {
  const fields = Array(35).fill("");
  fields[1] = "腾讯控股";
  fields[2] = "00700";
  fields[3] = "437.600";
  fields[4] = "438.200";
  fields[6] = "7475247";
  fields[30] = "2026/09/03 11:59:59";
  fields[31] = "-0.600";
  fields[32] = "-0.14";
  fields[33] = "445.600";
  fields[34] = "437.200";
  const quote = parseTencentQuote(`v_hk00700="${fields.join("~")}";`, "0700.HK");
  assert.equal(quote.provider, "Tencent Finance");
  assert.equal(quote.market, "HK");
  assert.equal(quote.price, 437.6);
  assert.equal(quote.asOf, "2026-09-03T03:59:59.000Z");
});

test("ranks research priority with transparent positive and risk factors", () => {
  const result = scoreQuoteForResearch({
    changePct: 1.2,
    indicators: {
      trend: "上行",
      macd: 4,
      macdSignal: 3,
      rsi14: 55,
      volumeRatio20d: 1.2,
      sma20: 100,
      support20d: 90,
      resistance20d: 110,
    },
    crossCheck: { status: "matched" },
    dataQuality: { warnings: [] },
  });
  assert.equal(result.priority, "高研究优先级");
  assert.ok(result.positiveFactors.length >= 3);
  assert.equal(result.riskFactors.length, 0);
  assert.match(result.scenarioConditions.constructive, /110/);
});

test("calculates a position ceiling from user-supplied risk constraints", () => {
  const result = calculatePositionBudget({
    capital: 10_000,
    capitalCurrency: "USD",
    maxLossPctPerIdea: 1,
    maxPositionPct: 20,
    ideas: [{ symbol: "AAPL", entryPrice: 100, invalidationPrice: 90, lotSize: 1 }],
  });
  assert.equal(result.ideas[0].riskBudget, 100);
  assert.equal(result.ideas[0].quantityCeiling, 10);
  assert.equal(result.ideas[0].modeledPositionValue, 1_000);
  assert.equal(result.ideas[0].modeledLossAtInvalidation, 100);
});

test("renders a responsive report without unescaped content", () => {
  const report = {
    runId: "test-run",
    generatedAt: "2026-09-03T03:00:00.000Z",
    phase: "premarket",
    phaseLabel: "盘前简报",
    source: "test",
    sourceNotice: "test only",
    summary: { requested: 1, succeeded: 1, failed: 0, advances: 1, declines: 0, unchanged: 0, alertCount: 0, marketCounts: { A: 0, HK: 0, US: 1 } },
    items: [{
      symbol: "AAPL",
      market: "US",
      name: "<Apple>",
      currency: "USD",
      price: 200,
      changePct: 1.2,
      indicators: { trend: "上行", sma20: 190, rsi14: 60, volumeRatio20d: 1.1, support20d: 180, resistance20d: 205 },
      alerts: [],
      news: [],
      history: [{ close: 190 }, { close: 200 }],
      source: "test",
      asOf: "2026-09-03T03:00:00.000Z",
    }],
  };
  const html = buildReportHtml(report);
  assert.match(html, /Hrouter Market Pulse/);
  assert.match(html, /\\u003cApple\\u003e/);
  assert.doesNotMatch(html, /<Apple>/);
  assert.match(html, /\/assets\/dashboard\.css/);
});

test("renders an empty usable dashboard shell", () => {
  const html = buildEmptyHtml();
  assert.match(html, /"empty":true/);
  assert.match(html, /"items":\[\]/);
  assert.match(html, /\/assets\/dashboard\.js/);
});
