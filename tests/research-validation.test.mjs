import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adjustedIndicatorRows, executionHistory, fillRestriction, prepareDailyHistory, purgedWalkForwardFolds, qualifyPrediction, simulatePortfolio } from "../mcp/research-validation.mjs";
import { evaluateDeclarativeStrategy, evaluateProbabilityCalibration, queryPredictionLedger, recordPrediction, resolvePredictionOutcomes, runBaselinePrediction, runHistoricalBacktest } from "../mcp/foundation.mjs";

function history(count, start = "2024-01-02", price = () => 100) {
  const rows = [];
  const date = new Date(`${start}T00:00:00Z`);
  while (rows.length < count) {
    if (![0, 6].includes(date.getUTCDay())) {
      const close = price(rows.length);
      rows.push({ timestamp: date.toISOString().slice(0, 10), open: close, close, high: close * 1.01, low: close * 0.99, volume: 100000 });
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return rows;
}

const strategy = { name: "always", version: "1", minimumScore: 1, rules: [{ feature: "price", operator: "gt", value: 0, points: 1 }] };

test("daily features are available at local session close and unfinished bars are excluded", () => {
  const rows = history(3, "2026-01-05");
  const prepared = prepareDailyHistory("AAPL", rows, "2026-01-06T17:00:00Z");
  assert.equal(prepared.rows.length, 1);
  assert.equal(prepared.rows[0].openAt, "2026-01-05T14:30:00.000Z");
  assert.equal(prepared.rows[0].availableAt, "2026-01-05T21:00:00.000Z");
  assert.equal(prepared.excluded.unfinished, 2);
  const summer = prepareDailyHistory("AAPL", history(1, "2026-06-01"), "2026-06-02T00:00:00Z");
  assert.equal(summer.rows[0].closeAt, "2026-06-01T20:00:00.000Z");
});

test("adjusted indicator OHLC shares a common basis while execution data stays raw", () => {
  const original = [{ open: 100, high: 110, low: 90, close: 100, adjustmentFactor: 0.5 }, { open: 50, high: 55, low: 45, close: 50, adjustmentFactor: 1 }];
  const rows = adjustedIndicatorRows(original);
  assert.deepEqual([rows[0].open, rows[0].high, rows[0].low, rows[0].close], [50, 55, 45, 50]);
  assert.equal(original[0].open, 100);
});

test("Yahoo split-adjusted prices are reconstructed without double-counting a split", async () => {
  const rows = history(24).map((row) => ({ ...row, open: 50, high: 51, low: 49, close: 50, adjustedClose: 50, adjustmentFactor: 1 }));
  const quote = { historyPriceBasis: "split-adjusted", history: rows, corporateActions: [{ type: "split", effectiveAt: `${rows[21].timestamp}T14:30:00Z`, date: rows[21].timestamp, ratio: 2 }] };
  const restored = executionHistory(quote);
  assert.equal(restored.history[20].close, 100);
  assert.equal(restored.history[21].close, 50);
  const result = await runHistoricalBacktest({ symbols: ["AAPL"], strategy, holdingPeriodDays: 2, warmupDays: 20, transactionCostBps: 0, slippageBps: 0, historyBySymbol: { AAPL: quote } });
  assert.equal(result.bySymbol[0].error, undefined);
  assert.equal(result.bySymbol[0].trades[0].netReturnPct, 0);
  assert.equal(result.bySymbol[0].trades[0].exitUnits, result.bySymbol[0].trades[0].units * 2);
});

test("corrupt daily bars break indicator continuity instead of compressing the gap", () => {
  const rows = history(5);
  rows[2].close = null;
  const prepared = prepareDailyHistory("AAPL", rows);
  assert.equal(prepared.excluded.invalid, 1);
  assert.equal(prepared.rows[2].gapBefore, true);
});

test("A ordinary equity minimum holding period prevents same-session round trips", async () => {
  const result = await runHistoricalBacktest({ symbols: ["600000.SS"], strategy, warmupDays: 20, holdingPeriodDays: 1, transactionCostBps: 0, slippageBps: 0, historyBySymbol: { "600000.SS": { history: history(25) } } });
  assert.ok(result.bySymbol[0].trades.length > 0);
  for (const trade of result.bySymbol[0].trades) {
    assert.ok(trade.holdingSessions >= 1);
    assert.notEqual(trade.entryAt.slice(0, 10), trade.exitAt.slice(0, 10));
    assert.ok(Date.parse(trade.signalAt) < Date.parse(trade.entryAt));
  }
  assert.equal(result.leakageChecks.marketHoldingMinimumMet, true);
  assert.equal(result.metrics.compoundedTradeReturnPct, null);
});

test("backtest enforces cash across simultaneous symbols and marks portfolio equity", async () => {
  const rows = history(21);
  rows[20] = { ...rows[20], open: 100, close: 110, high: 112, low: 99 };
  const result = await runHistoricalBacktest({ symbols: ["AAPL", "MSFT"], strategy, warmupDays: 20, initialCapital: 1000, maxPositionPct: 100, transactionCostBps: 0, slippageBps: 0, historyBySymbol: { AAPL: { history: rows }, MSFT: { history: rows } } });
  assert.equal(result.metrics.trades, 1);
  assert.equal(result.metrics.finalEquity, 1100);
  assert.equal(result.metrics.portfolioReturnPct, 10);
  assert.ok(result.unfilled.some((item) => item.reason === "insufficient-cash-or-risk-budget"));
  assert.ok(result.equityCurve.every((item) => item.cash >= 0));
});

test("a skipped allocation can enter on the next signal after another position releases cash", async () => {
  const aapl = history(27, "2024-01-02", (index) => index < 20 ? 100 : 90);
  const msft = history(27, "2024-01-02", (index) => index < 21 ? 90 : 100);
  const result = await runHistoricalBacktest({ symbols: ["AAPL", "MSFT"], strategy: { ...strategy, rules: [{ feature: "price", operator: "gt", value: 95, points: 1 }] }, holdingPeriodDays: 3, warmupDays: 20, initialCapital: 1000, maxPositionPct: 100, transactionCostBps: 0, slippageBps: 0, historyBySymbol: { AAPL: { history: aapl }, MSFT: { history: msft } } });
  const msftTrade = result.bySymbol.find((item) => item.symbol === "MSFT").trades[0];
  assert.equal(msftTrade.entryAt.slice(0, 10), msft[23].timestamp);
});

test("corporate actions beyond the as-of cutoff cannot change an open portfolio", async () => {
  const rows = history(21);
  const result = await runHistoricalBacktest({ symbols: ["AAPL"], strategy, warmupDays: 20, holdingPeriodDays: 5, initialCapital: 1000, maxPositionPct: 100, transactionCostBps: 0, slippageBps: 0, endDate: rows.at(-1).timestamp, historyBySymbol: { AAPL: { history: rows, corporateActions: [{ type: "dividend", effectiveAt: "2025-01-02T14:30:00Z", date: "2025-01-02", cashPerShare: 1000 }] } } });
  assert.equal(result.openPositions.length, 1);
  assert.equal(result.metrics.finalEquity, 1000);
  assert.ok(result.equityCurve.every((row) => row.at.slice(0, 10) <= rows.at(-1).timestamp));
});

test("live strategy selection is disabled on stale quotes even when its score passes", () => {
  const signal = evaluateDeclarativeStrategy({ symbol: "AAPL", price: 100, asOf: "2020-01-01T00:00:00Z", freshness: { signalEligible: false, reason: "stale" } }, strategy);
  assert.equal(signal.score, 1);
  assert.equal(signal.selected, false);
  assert.deepEqual(signal.blockedReasons, ["stale"]);
  const divergent = evaluateDeclarativeStrategy({ symbol: "AAPL", price: 100, signalEligible: false, freshness: { signalEligible: true }, crossCheck: { status: "divergent" } }, strategy);
  assert.equal(divergent.selected, false);
});

test("backtest rejects missing currency conversion rather than mixing money units", async () => {
  await assert.rejects(runHistoricalBacktest({ symbols: ["AAPL"], currency: "CNY", strategy, warmupDays: 20, historyBySymbol: { AAPL: { history: history(21) } } }), /FX rate/);
});

test("limit prices and halted sessions cannot assume fills, and sell orders defer", async () => {
  const row = { openAt: "2026-01-05T01:30:00Z", open: 110, close: 90, volume: 1000 };
  assert.equal(fillRestriction("600000.SS", row, { close: 100 }, "buy"), "limit-up-no-assumed-fill");
  assert.equal(fillRestriction("600000.SS", row, { close: 100 }, "sell"), "limit-down-no-assumed-fill");
  assert.equal(fillRestriction("AAPL", { ...row, volume: 0 }, { close: 100 }, "buy"), "no-volume-or-suspended");
  const rows = history(24);
  rows[21] = { ...rows[21], open: 90, close: 90, high: 90, low: 90 };
  rows[22] = { ...rows[22], open: 90, close: 91, high: 92, low: 89 };
  const result = await runHistoricalBacktest({ symbols: ["600000.SS"], strategy, warmupDays: 20, historyBySymbol: { "600000.SS": { history: rows } } });
  assert.equal(result.bySymbol[0].trades[0].exitDeferredSessions, 1);
  assert.equal(result.bySymbol[0].trades[0].holdingSessions, 2);
});

test("split and dividend events preserve position economics in the portfolio", () => {
  const rows = prepareDailyHistory("AAPL", history(3, "2026-01-05", (index) => index === 0 ? 100 : 50), "2026-01-10T00:00:00Z").rows;
  const result = simulatePortfolio({ initialCapital: 1000, maxPositionPct: 100, transactionCostBps: 0, slippageBps: 0, histories: { AAPL: rows }, corporateActions: { AAPL: [{ type: "split", effectiveAt: rows[1].openAt, ratio: 2 }, { type: "dividend", effectiveAt: rows[2].openAt, cashPerShare: 1 }] }, candidates: [{ id: "one", symbol: "AAPL", entryAt: rows[0].openAt, exitAt: rows[2].closeAt, entryPrice: 100, exitPrice: 50 }] });
  assert.equal(result.trades[0].exitUnits, 20);
  assert.equal(result.trades[0].dividends, 20);
  assert.equal(result.metrics.finalEquity, 1020);
  assert.equal(result.trades[0].netReturnPct, 2);
});

test("unexplained adjustment changes reject the affected history instead of fabricating returns", async () => {
  const rows = history(24).map((row, index) => ({ ...row, adjustmentFactor: index < 21 ? 0.5 : 1 }));
  const result = await runHistoricalBacktest({ symbols: ["AAPL"], strategy, warmupDays: 20, historyBySymbol: { AAPL: { history: rows } } });
  assert.match(result.bySymbol[0].error, /corporate-action records required/);
  assert.equal(result.metrics.trades, 0);
});

test("walk-forward purges unresolved labels and never overlaps evaluation windows", () => {
  const samples = Array.from({ length: 360 }, (_, index) => ({ featureAt: new Date(Date.UTC(2024, 0, 1 + index)).toISOString(), resolvedAt: new Date(Date.UTC(2024, 0, 11 + index)).toISOString(), vector: [index], outcome: index % 2 }));
  const folds = purgedWalkForwardFolds(samples);
  assert.equal(folds.length, 3);
  assert.ok(folds.every((fold) => fold.purged >= 10));
  const evaluationDates = folds.flatMap((fold) => fold.evaluation.map((sample) => sample.featureAt));
  assert.equal(new Set(evaluationDates).size, evaluationDates.length);
  for (const fold of folds) assert.ok(fold.training.every((sample) => Date.parse(sample.resolvedAt) < Date.parse(fold.evaluation[0].featureAt)));
});

test("prediction gates suppress exposure when validation, calibration or drift fails", () => {
  const good = { folds: Array.from({ length: 3 }, () => ({ brierSkill: 0.02 })), calibration: { observations: 100, brierScore: 0.18, logLoss: 0.5, expectedCalibrationError: 0.04 }, baselineCalibration: { brierScore: 0.24, logLoss: 0.7 }, auc: 0.7, latestFeaturesComplete: true, stale: false };
  assert.equal(qualifyPrediction(good).status, "qualified");
  assert.equal(qualifyPrediction({ ...good, drift: true }).recommendedNewExposure, 0);
  assert.equal(qualifyPrediction({ ...good, auc: 0.45 }).status, "rejected");
  assert.equal(qualifyPrediction({ ...good, stale: true }).status, "observe");
});

test("future outcomes are rejected by calibration", () => {
  assert.throws(() => evaluateProbabilityCalibration({ predictions: [{ probability: 0.5, outcome: 1, predictedAt: new Date(Date.now() - 1000).toISOString(), resolvedAt: new Date(Date.now() + 86400000).toISOString() }] }), /future/);
});

test("prediction ledger is immutable and resolves only future completed bars", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hrouter-ledger-test-"));
  const previousDirectory = process.env.HROUTER_REPORT_DIR;
  process.env.HROUTER_REPORT_DIR = directory;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-05T22:00:00Z") });
  try {
    const record = { symbol: "AAPL", modelVersion: "test-v1", probability: 0.7, featureAt: "2026-01-05T21:00:00Z", recordedAt: new Date().toISOString(), horizonDays: 2, transactionCostBps: 0, slippageBps: 0, qualification: { qualified: true } };
    const first = await recordPrediction(record);
    assert.equal((await queryPredictionLedger()).records[0].qualification.currentlyEligible, true);
    const duplicate = await recordPrediction({ ...record, probability: 0.2 });
    assert.equal(first.id, duplicate.id);
    assert.equal(duplicate.probability, 0.7);
    await assert.rejects(recordPrediction({ ...record, recordedAt: "2025-01-01T00:00:00Z" }), /backdated/);
    const initial = await resolvePredictionOutcomes({ historyBySymbol: { AAPL: { history: history(5, "2026-01-05") } } });
    assert.equal(initial.updated, 0);
    t.mock.timers.setTime(Date.parse("2026-01-06T23:00:00Z"));
    assert.equal((await queryPredictionLedger()).records[0].qualification.currentlyEligible, false);
    t.mock.timers.setTime(Date.parse("2026-01-10T00:00:00Z"));
    const resolved = await resolvePredictionOutcomes({ historyBySymbol: { AAPL: { history: history(5, "2026-01-05", (index) => 100 + index) } } });
    assert.equal(resolved.updated, 1);
    assert.equal(resolved.updates[0].outcome, 1);
    assert.equal(resolved.updates[0].entryAt, "2026-01-06T14:30:00.000Z");
    const saved = await queryPredictionLedger({ status: "resolved" });
    assert.equal(saved.totalMatched, 1);
    assert.equal(saved.records[0].probability, 0.7);
    assert.equal(saved.records[0].qualification.currentlyEligible, false);
  } finally {
    t.mock.timers.reset();
    if (previousDirectory === undefined) delete process.env.HROUTER_REPORT_DIR;
    else process.env.HROUTER_REPORT_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed latest evaluation revokes the previous model's research eligibility", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hrouter-eligibility-test-"));
  const previousDirectory = process.env.HROUTER_REPORT_DIR;
  process.env.HROUTER_REPORT_DIR = directory;
  try {
    await recordPrediction({ symbol: "AAPL", modelVersion: "old-qualified", probability: 0.7, featureAt: new Date(Date.now() - 3600000).toISOString(), recordedAt: new Date().toISOString(), horizonDays: 2, transactionCostBps: 0, slippageBps: 0, qualification: { qualified: true, status: "qualified" } });
    assert.equal((await queryPredictionLedger()).records[0].qualification.currentlyEligible, true);
    await runBaselinePrediction({ symbols: ["AAPL"], historyBySymbol: { AAPL: { history: history(10) } } });
    const previous = (await queryPredictionLedger()).records[0];
    assert.equal(previous.qualification.currentlyEligible, false);
    assert.equal(previous.qualification.latestAssessment.status, "observe");
  } finally {
    if (previousDirectory === undefined) delete process.env.HROUTER_REPORT_DIR;
    else process.env.HROUTER_REPORT_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("full model evaluation returns walk-forward evidence and persists its forecast", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hrouter-model-test-"));
  const previousDirectory = process.env.HROUTER_REPORT_DIR;
  process.env.HROUTER_REPORT_DIR = directory;
  try {
    const result = await runBaselinePrediction({ symbols: ["AAPL"], features: ["changePct", "rsi14"], historyBySymbol: { AAPL: { history: history(360, "2024-01-02", (index) => 100 + Math.sin(index / 4) * 5 + index * 0.01) } } });
    const model = result.results[0];
    assert.equal(model.error, undefined);
    assert.equal(model.validation.folds.length, 3);
    assert.equal(model.validation.leakageChecks.allLabelsResolvedBeforeFold, true);
    assert.equal(model.qualification.recommendedNewExposure, 0);
    assert.equal(model.probabilityPositive, null);
    assert.ok(model.predictionId);
    assert.equal((await queryPredictionLedger()).totalMatched, 1);
  } finally {
    if (previousDirectory === undefined) delete process.env.HROUTER_REPORT_DIR;
    else process.env.HROUTER_REPORT_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
