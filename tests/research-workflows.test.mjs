import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { registerDataProvider, ingestEvidence, queryEvidence } from "../mcp/foundation.mjs";
import { buildEarningsReview, normalizeThesisPillars, projectCatalystCalendar, queryCatalystCalendar, researchAsOf } from "../mcp/research.mjs";
import { appendThesisReview, queryThesisScorecard, listDecisions, reviewDecision, recordDecision } from "../mcp/workspace.mjs";

const asOf = "2024-08-01T00:00:00Z";
async function isolated(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hrouter-research-"));
  const previous = process.env.HROUTER_REPORT_DIR;
  const originalFetch = globalThis.fetch;
  process.env.HROUTER_REPORT_DIR = dir;
  globalThis.fetch = async () => { throw new Error("Network disabled in research tests"); };
  try {
    await registerDataProvider({ id: "research-fixture", name: "Research fixture", sourceTier: "primary", kinds: ["financial", "filing", "macro"] });
    await run(dir);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.HROUTER_REPORT_DIR; else process.env.HROUTER_REPORT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
async function put({ payload = {}, ...overrides } = {}) {
  const result = await ingestEvidence({ items: [{
    providerId: "research-fixture", sourceTier: "primary", kind: "financial",
    entity: { symbol: "AAPL" }, sourceUrl: "https://example.com/filing", title: "Fixture",
    publishedAt: "2024-07-20T20:00:00Z", availableAt: "2024-07-20T20:00:00Z",
    payload: { metric: "Revenue", value: 120, unit: "USD", accountingBasis: "us-gaap", valueType: "actual", periodStart: "2024-04-01", periodEnd: "2024-06-30", ...payload },
    ...overrides,
  }] });
  return result.ids[0];
}
const review = (actualEvidenceId, comparisonEvidenceId, comparisonType = "prior-period") =>
  buildEarningsReview({ symbol: "AAPL", asOf, metrics: [{ actualEvidenceId, comparisonEvidenceId, comparisonType }] });

test("earnings: comparable prior actuals retain citations and deterministic arithmetic", () => isolated(async () => {
  const a = await put();
  const b = await put({ payload: { value: 100, periodStart: "2023-04-01", periodEnd: "2023-06-30" } });
  const r = await review(a, b);
  assert.equal(r.metrics[0].delta, 20);
  assert.equal(r.metrics[0].changePct, 20);
  assert.equal(r.metrics[0].actual.evidenceId, a);
  assert.equal(r.metrics[0].baseline.sourceUrl, "https://example.com/filing");
  assert.equal(r.researchOnly, true);
  assert.equal((await queryEvidence({ ids: [a], limit: 500 })).returned, 1);
}));

test("earnings: missing consensus never becomes a beat/miss or guidance substitution", () => isolated(async () => {
  const a = await put();
  const missing = await review(a, undefined, "consensus");
  assert.equal(missing.metrics[0].delta, null);
  assert.equal(missing.metrics[0].warning, "missing-comparison-evidence");
  const g = await put({ publishedAt: "2024-07-01T00:00:00Z", availableAt: "2024-07-01T00:00:00Z", payload: { value: 100, valueType: "company-guidance" } });
  assert.equal((await review(a, g, "consensus")).metrics[0].warning, "comparison-is-not-requested-estimate-type");
  assert.equal((await review(a, g, "company-guidance")).metrics[0].delta, 20);
}));

test("earnings: consensus must actually be available before disclosure, not just ingestion", () => isolated(async () => {
  const a = await put();
  const b = await put({ publishedAt: "2024-07-01T00:00:00Z", availableAt: "2024-07-01T00:00:00Z", payload: { valueType: "consensus", value: 100 } });
  assert.equal((await review(a, b, "consensus")).metrics[0].direction, "above");
  const late = await put({ publishedAt: "2024-07-01T00:00:00Z", availableAt: "2024-07-21T00:00:00Z", payload: { valueType: "consensus", value: 101 } });
  assert.equal((await review(a, late, "consensus")).metrics[0].warning, "estimate-not-available-before-disclosure");
  const justIngested = await put({ availableAt: undefined, payload: { valueType: "consensus", value: 102 } });
  await assert.rejects(review(a, justIngested, "consensus"), /unavailable/);
}));

test("earnings: incompatible accounting, unit, scale, duration and estimate periods refuse comparison", () => isolated(async () => {
  const a = await put();
  for (const [payload, expected] of [
    [{ unit: "CNY" }, "unit-currency-or-scale-mismatch"],
    [{ scale: 1e6 }, "unit-currency-or-scale-mismatch"],
    [{ currency: "HKD" }, "unit-currency-or-scale-mismatch"],
    [{ accountingBasis: "non-gaap" }, "accounting-basis-missing-or-mismatched"],
    [{ accountingBasis: null }, "accounting-basis-missing-or-mismatched"],
    [{ metric: "NetIncome" }, "metric-mismatch"],
    [{ periodStart: "2023-01-01" }, "period-duration-mismatch"],
    [{ periodStart: null }, "instant-duration-mismatch"],
  ]) {
    const b = await put({ payload: { value: 100, periodStart: "2023-04-01", periodEnd: "2023-06-30", ...payload } });
    const row = (await review(a, b)).metrics[0];
    assert.equal(row.warning, expected);
    assert.equal(row.delta, null);
  }
  const estimate = await put({ publishedAt: "2024-01-01T00:00:00Z", availableAt: "2024-01-01T00:00:00Z", payload: { valueType: "consensus", periodStart: "2024-01-01" } });
  assert.equal((await review(a, estimate, "consensus")).metrics[0].warning, "estimate-period-mismatch");
}));

test("earnings: nonpositive baselines show absolute changes, never misleading growth percentages", () => isolated(async () => {
  const a = await put();
  for (const value of [0, -100]) {
    const b = await put({ payload: { value, periodStart: "2023-04-01", periodEnd: "2023-06-30" } });
    const row = (await review(a, b)).metrics[0];
    assert.equal(row.changePct, null);
    assert.equal(row.delta, 120 - value);
    assert.equal(row.percentageWarning, "nonpositive-baseline-use-absolute-change");
  }
}));

test("earnings: cross-symbol, future and nonnumeric evidence cannot become actuals", () => isolated(async () => {
  for (const bad of [
    { entity: { symbol: "MSFT" } },
    { availableAt: "2099-01-01T00:00:00Z" },
    { payload: { value: "120" } },
    { payload: { valueType: "consensus" } },
    { payload: { valueType: null } },
    { payload: { periodEnd: "2024-02-30" } },
    { payload: { periodEnd: "2024-12-31" } },
  ]) await assert.rejects(review(await put(bad)));
  await assert.rejects(buildEarningsReview({ symbol: "AAPL", metrics: [] }), /1-40/);
  assert.throws(() => researchAsOf("2099-01-01T00:00:00Z"), /future/);
  assert.throws(() => researchAsOf("2024-01-01"), /timezone/);
  assert.throws(() => researchAsOf("2024-02-30T00:00:00Z"), /timestamp/);
}));

const pillar = { id: "growth", expectation: "Revenue growth above 10%", invalidationCondition: "Two consecutive quarters below 5%", reviewBy: "2024-08-01" };
async function seedDecision(dir, { pillars } = {}) {
  const record = { id: "decision_fixture", symbol: "AAPL", state: "watch", thesis: "Fixture thesis", createdAt: "2024-01-01T00:00:00Z", evidenceIds: [], reviews: [], ...(pillars ? { pillars } : {}) };
  record.originalHash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
  await writeFile(path.join(dir, "decisions.json"), JSON.stringify([record]));
  return record;
}
const update = (id, status = "supported") => ({ pillarId: "growth", status, rationale: "Evidence indicates a change; research assessment only.", evidenceIds: [id] });

test("thesis: pillars validate identifiers, falsification conditions and review dates", () => {
  assert.deepEqual(normalizeThesisPillars([pillar]), [pillar]);
  assert.throws(() => normalizeThesisPillars([pillar, pillar]), /unique/);
  assert.throws(() => normalizeThesisPillars([{ ...pillar, invalidationCondition: "" }]), /nonempty/);
  assert.throws(() => normalizeThesisPillars([{ ...pillar, reviewBy: "2024-02-30" }]), /reviewBy/);
});

test("thesis: append-only reviews keep original hash and decision state; historical views omit later judgments", () => isolated(async (dir) => {
  const original = await seedDecision(dir, { pillars: [pillar] });
  const evidenceId = await put();
  const result = await appendThesisReview({ decisionId: original.id, updates: [update(evidenceId, "weakened")] });
  assert.equal(result.stateUnchanged, "watch");
  assert.equal(result.scorecard.pillars[0].status, "weakened");
  assert.equal(result.review.source, "research-assessment");
  assert.equal(result.review.type, "thesis-assessment");
  assert.equal(result.review.outcome, undefined, "A pillar assessment must not reopen an outcome review");
  const [stored] = JSON.parse(await readFile(path.join(dir, "decisions.json")));
  const { originalHash, ...content } = stored;
  content.reviews = [];
  assert.equal(createHash("sha256").update(JSON.stringify(content)).digest("hex"), originalHash);
  assert.equal(originalHash, original.originalHash);
  assert.equal((await queryThesisScorecard({ decisionId: original.id, asOf })).pillars[0].status, "unreviewed");
  assert.equal((await listDecisions()).decisions[0].scorecard.pillars[0].latestAssessment.evidence[0].evidenceId, evidenceId);
}));

test("thesis: legacy decisions initialize pillars in a review, never rewrite the original", () => isolated(async (dir) => {
  const original = await seedDecision(dir);
  const id = await put();
  await appendThesisReview({ decisionId: original.id, pillars: [pillar], updates: [update(id)] });
  const [stored] = JSON.parse(await readFile(path.join(dir, "decisions.json")));
  assert.equal(stored.pillars, undefined);
  assert.deepEqual(stored.reviews[0].pillars, [pillar]);
  assert.equal((await queryThesisScorecard({ decisionId: original.id, asOf })).pillars.length, 0);
  await assert.rejects(appendThesisReview({ decisionId: original.id, pillars: [pillar], updates: [update(id)] }), /cannot be replaced/);
}));

test("thesis: evidence, unknown/duplicate pillars and concurrent reviews are guarded", () => isolated(async (dir) => {
  const original = await seedDecision(dir, { pillars: [pillar] });
  const id = await put();
  const wrong = await put({ entity: { symbol: "MSFT" } });
  const future = await put({ availableAt: "2099-01-01T00:00:00Z", payload: { value: 121 } });
  for (const updates of [[update(wrong)], [update(future)], [{ ...update(id), evidenceIds: [] }], [update(id), update(id)], [{ ...update(id), pillarId: "missing" }]])
    await assert.rejects(appendThesisReview({ decisionId: original.id, updates }));
  const results = await Promise.all([
    appendThesisReview({ decisionId: original.id, updates: [update(id)] }),
    reviewDecision(original.id, { outcome: "open", notes: "Keep observing" }),
    appendThesisReview({ decisionId: original.id, updates: [update(id, "inconclusive")] }),
  ]);
  assert.equal(results.length, 3);
  assert.equal((await listDecisions()).decisions[0].reviews.length, 3);
  assert.equal((await queryThesisScorecard({ decisionId: original.id })).pillars[0].status, "inconclusive");
}));

test("thesis: recordDecision stores initial pillars without weakening candidate gate", () => isolated(async () => {
  const recorded = await recordDecision({ symbol: "AAPL", thesis: "A research watch", pillars: [pillar] });
  assert.deepEqual(recorded.pillars, [pillar]);
  assert.equal(recorded.state, "watch");
  await assert.rejects(recordDecision({ symbol: "AAPL", thesis: "Not a trade", state: "candidate", pillars: [pillar] }), /Candidate requires/);
}));

const event = (id, availableAt, payload = {}, extra = {}) => ({ id, providerId: "fixture", kind: "filing", entity: { symbol: "AAPL" }, title: "Earnings", sourceUrl: "https://example.com/event", sourceTier: "primary", publishedAt: availableAt, availableAt,
  payload: { eventType: "earnings", eventKey: "2024-Q2", scheduledAt: "2024-08-10T20:00:00Z", eventStatus: "confirmed", dateConfidence: "confirmed", timezone: "America/New_York", ...payload }, ...extra });

test("calendar: stable identity deduplicates revisions and preserves point-in-time schedule", () => {
  const original = event("ev_1", "2024-07-01T00:00:00Z");
  const revised = event("ev_2", "2024-07-10T00:00:00Z", { scheduledAt: "2024-08-12T20:00:00Z" });
  const items = [revised, original, original];
  const current = projectCatalystCalendar(items, { asOf });
  assert.equal(current.events.length, 1);
  assert.equal(current.events[0].history.length, 2);
  assert.equal(current.events[0].scheduledAt, "2024-08-12T20:00:00Z");
  assert.equal(projectCatalystCalendar(items, { asOf: "2024-07-05T00:00:00Z" }).events[0].id, "ev_1");
});

test("calendar: cancellation without date retains previous schedule, sources remain separate", () => {
  const original = event("ev_1", "2024-07-01T00:00:00Z");
  const cancelled = event("ev_2", "2024-07-10T00:00:00Z", { eventStatus: "cancelled", scheduledAt: undefined });
  const otherProvider = { ...original, id: "ev_other", providerId: "other" };
  const result = projectCatalystCalendar([original, cancelled, otherProvider], { asOf });
  assert.equal(result.events.length, 2);
  const row = result.events.find((e) => e.id === "ev_2");
  assert.equal(row.eventStatus, "cancelled");
  assert.equal(row.scheduledAt, original.payload.scheduledAt);
  assert.equal(row.dateConfidence, "estimated");
});

test("calendar: explicit timezones, future evidence, conflicts, macro and symbol filters", () => {
  const good = event("ev_a", "2024-07-01T00:00:00Z");
  const conflict = event("ev_b", "2024-07-01T00:00:00Z", { scheduledAt: "2024-08-11T20:00:00Z" });
  const result = projectCatalystCalendar([good, conflict,
    event("bad", "2024-07-01T00:00:00Z", { scheduledAt: "2024-08-11T20:00:00" }),
    event("tz", "2024-07-01T00:00:00Z", { timezone: "NOT_A_ZONE" }),
    event("future", "2099-01-01T00:00:00Z"),
    event("macro", "2024-07-01T00:00:00Z", { eventType: "macro", eventKey: "CPI" }, { kind: "macro", entity: { name: "Economy" } }),
  ], { asOf, symbols: ["AAPL"], includeMacro: false });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].conflict, true);
  assert.equal(result.warnings.length, 2);
  assert.equal(projectCatalystCalendar([good], { asOf, symbols: ["MSFT"] }).events.length, 0);
});

test("calendar query: ingested cancellations suppress active events; history query restores prior state", () => isolated(async () => {
  const payload = { eventType: "earnings", eventKey: "q2", eventStatus: "confirmed", scheduledAt: "2024-08-10T20:00:00Z" };
  await put({ kind: "filing", payload, publishedAt: "2024-07-01T00:00:00Z", availableAt: "2024-07-01T00:00:00Z" });
  await put({ kind: "filing", payload: { ...payload, eventStatus: "cancelled" } });
  const r = await queryCatalystCalendar({ symbols: ["AAPL"], asOf });
  assert.equal(r.events.length, 0);
  assert.equal(r.coverage.truncated, false);
  assert.equal((await queryCatalystCalendar({ symbols: ["AAPL"], asOf, includeCancelled: true })).events[0].eventStatus, "cancelled");
  assert.equal((await queryCatalystCalendar({ symbols: ["AAPL"], asOf: "2024-07-10T00:00:00Z", to: "2024-08-31T00:00:00Z" })).events.length, 1);
  await assert.rejects(queryCatalystCalendar({ asOf, from: "bad" }));
}));


test("calendar: malformed affected symbols and impossible dates are isolated as source warnings", () => {
  const result = projectCatalystCalendar([
    event("good", "2024-07-01T00:00:00Z"),
    event("symbol", "2024-07-01T00:00:00Z", { affectedSymbols: ["not a valid symbol !!!"] }),
    event("date", "2024-07-01T00:00:00Z", { scheduledAt: "2024-02-30T00:00:00Z" }),
  ], { asOf });
  assert.equal(result.events.length, 1);
  assert.equal(result.warnings.length, 2);
});

test("calendar: bounded evidence scans explicitly disclose incomplete coverage", () => isolated(async () => {
  const row = { providerId: "research-fixture", sourceTier: "primary", kind: "filing", entity: { symbol: "AAPL" },
    sourceUrl: "https://example.com/large-store", publishedAt: "2024-07-01T00:00:00Z", availableAt: "2024-07-01T00:00:00Z" };
  for (let start = 0; start < 501; start += 100) {
    await ingestEvidence({ items: Array.from({ length: Math.min(100, 501 - start) }, (_, i) => ({ ...row, title: `Non-event fixture ${start + i}` })) });
  }
  const result = await queryCatalystCalendar({ symbols: ["AAPL"], asOf });
  assert.equal(result.coverage.scanned, 500);
  assert.equal(result.coverage.totalAvailable, 501);
  assert.equal(result.coverage.truncated, true);
  assert.match(result.warnings.at(-1), /truncated/);
}));
