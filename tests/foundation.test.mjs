import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  evaluateDeclarativeStrategy,
  evaluateProbabilityCalibration,
  fitLogisticBaseline,
  getFoundationCapabilities,
  ingestEvidence,
  monitorFeatureDrift,
  normalizeEvidence,
  queryEvidence,
  registerDataProvider,
} from "../mcp/foundation.mjs";

test("normalizes evidence with deterministic deduplication and conservative availability", () => {
  const input = {
    providerId: "sec",
    sourceTier: "official",
    kind: "filing",
    entity: { symbol: "AAPL", identifiers: { cik: "0000320193" } },
    title: "Example filing",
    summary: "Point-in-time test",
    sourceUrl: "https://www.sec.gov/example",
    publishedAt: "2026-01-02T14:00:00Z",
  };
  const first = normalizeEvidence(input, new Date("2026-01-03T00:00:00Z"));
  const second = normalizeEvidence(input, new Date("2026-01-04T00:00:00Z"));
  assert.equal(first.id, second.id);
  assert.equal(first.availableAt, "2026-01-03T00:00:00.000Z");
  assert.equal(first.pointInTimeStatus, "first-observed-at-ingestion");
});

test("stores evidence once and enforces as-of availability queries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hrouter-foundation-test-"));
  const previousDirectory = process.env.HROUTER_REPORT_DIR;
  process.env.HROUTER_REPORT_DIR = directory;
  try {
    await registerDataProvider({
      id: "sec",
      name: "SEC",
      sourceTier: "official",
      kinds: ["filing"],
      homepage: "https://www.sec.gov/",
    });
    const evidence = {
      providerId: "sec",
      sourceTier: "official",
      kind: "filing",
      entity: { symbol: "AAPL" },
      title: "Example filing",
      sourceUrl: "https://www.sec.gov/example",
      publishedAt: "2026-01-02T14:00:00Z",
      availableAt: "2026-01-02T14:05:00Z",
    };
    const first = await ingestEvidence({ items: [evidence, evidence] });
    assert.equal(first.inserted, 1);
    assert.equal(first.duplicates, 1);
    const before = await queryEvidence({ asOf: "2026-01-02T14:04:59Z" });
    const after = await queryEvidence({ asOf: "2026-01-02T14:05:00Z" });
    assert.equal(before.totalMatched, 0);
    assert.equal(after.totalMatched, 1);
    const capabilities = await getFoundationCapabilities();
    assert.ok(capabilities.providers.some((provider) => provider.id === "sec"));
  } finally {
    if (previousDirectory === undefined) delete process.env.HROUTER_REPORT_DIR;
    else process.env.HROUTER_REPORT_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs an allowlisted declarative strategy with auditable reasons", () => {
  const signal = evaluateDeclarativeStrategy({
    symbol: "AAPL",
    price: 110,
    changePct: 1,
    asOf: "2026-01-02T21:00:00Z",
    indicators: { sma20: 100, rsi14: 55, macd: 3, macdSignal: 2 },
    dataQuality: { status: "ok", warnings: [] },
  }, {
    name: "example-momentum",
    version: "1.0.0",
    baseScore: 0,
    minimumScore: 10,
    rules: [
      { feature: "priceToSma20Pct", operator: "gt", value: 5, points: 10, label: "Above MA20" },
      { feature: "rsi14", operator: "between", value: 45, value2: 65, points: 5, label: "Balanced RSI" },
    ],
  });
  assert.equal(signal.selected, true);
  assert.equal(signal.score, 15);
  assert.deepEqual(signal.reasons.map((reason) => reason.label), ["Above MA20", "Balanced RSI"]);
});

test("accepts evidence-linked external numeric features without executable code", () => {
  const signal = evaluateDeclarativeStrategy({
    symbol: "AAPL",
    price: 110,
    asOf: "2026-01-02T21:00:00Z",
    indicators: {},
    externalFeatures: { "external.catalystScore": 8 },
    externalFeatureAvailableAt: "2026-01-02T20:00:00Z",
    evidenceIds: ["ev_1234567890abcdef1234567890abcdef"],
  }, {
    name: "event-example",
    version: "1.0.0",
    minimumScore: 5,
    rules: [
      { feature: "external.catalystScore", operator: "gte", value: 7, points: 5, label: "Verified catalyst" },
    ],
  });
  assert.equal(signal.selected, true);
  assert.deepEqual(signal.evidenceIds, ["ev_1234567890abcdef1234567890abcdef"]);
  assert.equal(signal.effectiveAt, "2026-01-02T21:00:00.000Z");
});

test("evaluates timestamped probability calibration", () => {
  const result = evaluateProbabilityCalibration({
    bins: 5,
    predictions: [
      { probability: 0.8, outcome: 1, predictedAt: "2026-01-01T00:00:00Z", resolvedAt: "2026-01-02T00:00:00Z" },
      { probability: 0.2, outcome: 0, predictedAt: "2026-01-01T00:00:00Z", resolvedAt: "2026-01-02T00:00:00Z" },
    ],
  });
  assert.equal(result.brierScore, 0.04);
  assert.equal(result.directionalAccuracyPct, 100);
  assert.equal(result.observations, 2);
});

test("fits a deterministic logistic probability baseline", () => {
  const matrix = Array.from({ length: 200 }, (_, index) => [index - 100]);
  const outcomes = matrix.map(([value]) => value > 0 ? 1 : 0);
  const model = fitLogisticBaseline(matrix, outcomes, { iterations: 1000 });
  assert.ok(model.predict([-50]) < 0.2);
  assert.ok(model.predict([50]) > 0.8);
});

test("detects a materially shifted feature distribution", () => {
  const baseline = Array.from({ length: 100 }, (_, index) => index / 10);
  const current = baseline.map((value) => value + 20);
  const result = monitorFeatureDrift({ series: [{ feature: "momentum", baseline, current }] });
  assert.equal(result.status, "drift");
  assert.equal(result.features[0].status, "drift");
  assert.ok(result.features[0].populationStabilityIndex >= 0.25);
});

test("ships parseable public contract schemas", async () => {
  const schemaDirectory = path.resolve("schemas");
  for (const filename of ["evidence.schema.json", "event.schema.json", "signal.schema.json", "strategy-result.schema.json", "strategy.schema.json"]) {
    const schema = JSON.parse(await readFile(path.join(schemaDirectory, filename), "utf8"));
    assert.match(schema.$id, /^https:\/\/hrouter\.net\/schemas\/market-pulse\//);
  }
});
