// Research workflows inspired by anthropics/financial-services; see THIRD_PARTY_NOTICES.md.
// These functions consume evidence, never authorize exposure or place orders.
import { normalizeSymbol, loadPreferences } from "./core.mjs";
import { queryEvidence } from "./foundation.mjs";

export function researchAsOf(value = new Date().toISOString()) {
  if (!validTimestamp(value))
    throw new Error("asOf must be an ISO timestamp with timezone");
  if (Date.parse(value) > Date.now()) throw new Error("Research asOf cannot be in the future");
  return new Date(value).toISOString();
}
const text = (value, field, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${field} must be nonempty text (max ${max})`);
  return value.trim();
};
const citation = (item) => ({
  evidenceId: item.id, sourceUrl: item.sourceUrl, providerId: item.providerId,
  sourceTier: item.sourceTier, publishedAt: item.publishedAt, availableAt: item.availableAt,
  pointInTimeStatus: item.pointInTimeStatus,
});
const dateOnly = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

const validTimestamp = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  dateOnly(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

function financialFact(item) {
  const p = item.payload ?? {};
  if (item.kind !== "financial" || typeof p.value !== "number" || !Number.isFinite(p.value))
    throw new Error(`${item.id}: financial evidence requires a finite numeric value`);
  if (!dateOnly(p.periodEnd) || (p.periodStart != null && (!dateOnly(p.periodStart) || p.periodStart > p.periodEnd)))
    throw new Error(`${item.id}: invalid financial period`);
  if (p.valueType === "actual" && p.periodEnd > item.publishedAt.slice(0, 10))
    throw new Error(`${item.id}: actual period cannot end after disclosure`);
  const scale = p.scale ?? 1;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0)
    throw new Error(`${item.id}: invalid scale`);
  return {
    metric: text(p.metric, "metric", 160), value: p.value,
    unit: text(p.unit, "unit", 80), scale, currency: p.currency ?? null,
    periodStart: p.periodStart ?? null, periodEnd: p.periodEnd,
    accountingBasis: p.accountingBasis ?? null,
    publicationTimePrecision: p.publicationTimePrecision ?? "unspecified",
    valueType: p.valueType ?? null, ...citation(item),
  };
}

function comparisonIssue(actual, baseline, type) {
  if (actual.metric !== baseline.metric) return "metric-mismatch";
  if (actual.unit !== baseline.unit || actual.scale !== baseline.scale || actual.currency !== baseline.currency)
    return "unit-currency-or-scale-mismatch";
  if (!actual.accountingBasis || !baseline.accountingBasis || actual.accountingBasis !== baseline.accountingBasis)
    return "accounting-basis-missing-or-mismatched";
  if (type === "prior-period") {
    if (baseline.valueType !== "actual") return "prior-period-must-be-actual";
    if (baseline.periodEnd >= (actual.periodStart ?? actual.periodEnd)) return "periods-overlap-or-not-earlier";
    if ((actual.periodStart === null) !== (baseline.periodStart === null)) return "instant-duration-mismatch";
    if (actual.periodStart) {
      const days = (f) => (Date.parse(f.periodEnd) - Date.parse(f.periodStart)) / 86400000;
      if (Math.abs(days(actual) - days(baseline)) > 7) return "period-duration-mismatch";
    }
  } else {
    if (baseline.valueType !== type) return "comparison-is-not-requested-estimate-type";
    if (actual.periodStart !== baseline.periodStart || actual.periodEnd !== baseline.periodEnd)
      return "estimate-period-mismatch";
    // Disclosure time, not ingestion time: later estimates cannot become pre-release consensus.
    if (Date.parse(baseline.availableAt) >= Date.parse(actual.publishedAt) ||
        Date.parse(baseline.publishedAt) >= Date.parse(actual.publishedAt)) return "estimate-not-available-before-disclosure";
  }
  return null;
}

export async function buildEarningsReview(input) {
  const symbol = normalizeSymbol(input.symbol);
  const asOf = researchAsOf(input.asOf);
  if (!Array.isArray(input.metrics) || !input.metrics.length || input.metrics.length > 40)
    throw new Error("Provide 1-40 explicit metric evidence pairs");
  const ids = [...new Set(input.metrics.flatMap((m) => [m.actualEvidenceId, m.comparisonEvidenceId].filter(Boolean)))];
  const evidence = await queryEvidence({ symbols: [symbol], ids, asOf, limit: 500 });
  const byId = new Map(evidence.items.map((item) => [item.id, item]));
  const get = (id) => {
    if (!byId.has(id)) throw new Error(`Evidence ${id} is missing, unavailable at asOf, or belongs to another symbol`);
    return financialFact(byId.get(id));
  };
  const metrics = input.metrics.map((pair) => {
    const actual = get(pair.actualEvidenceId);
    if (actual.valueType !== "actual") throw new Error("Actual evidence must be a reported actual, not an estimate");
    const type = pair.comparisonType ?? "prior-period";
    if (!["prior-period", "consensus", "company-guidance"].includes(type)) throw new Error("Invalid comparisonType");
    const baseline = pair.comparisonEvidenceId ? get(pair.comparisonEvidenceId) : null;
    const issue = baseline ? comparisonIssue(actual, baseline, type) : "missing-comparison-evidence";
    const delta = issue ? null : actual.value - baseline.value;
    if (delta !== null && !Number.isFinite(delta)) throw new Error("Financial difference overflow");
    const percentage = delta !== null && baseline.value > 0 ? delta / baseline.value * 100 : null;
    return {
      metric: actual.metric, actual, baseline, comparisonType: type,
      comparisonStatus: issue ? "unavailable" : "comparable", warning: issue,
      delta, changePct: Number.isFinite(percentage) ? percentage : null,
      percentageWarning: !issue && baseline.value <= 0 ? "nonpositive-baseline-use-absolute-change" :
        percentage !== null && !Number.isFinite(percentage) ? "percentage-overflow" : null,
      // Higher expenses or liabilities are not necessarily good; no beat/miss investment judgment.
      direction: delta === null ? null : delta > 0 ? "above" : delta < 0 ? "below" : "in-line",
    };
  });
  return {
    symbol, asOf, generatedAt: new Date().toISOString(), researchOnly: true, metrics,
    limitations: ["Evidence-derived arithmetic, not a forecast or investment recommendation.",
      "Evidence provenance is retained; provider-declared historical availability is not independently verified.",
      "Missing consensus is not replaced with guidance. No automatic currency, scale, or accounting-basis conversion."],
  };
}

export function normalizeThesisPillars(pillars = []) {
  if (!Array.isArray(pillars) || pillars.length > 12) throw new Error("Use at most 12 thesis pillars");
  const seen = new Set();
  return pillars.map((p) => {
    const id = text(p.id, "pillar id", 64);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || seen.has(id)) throw new Error("Pillar IDs must be unique safe identifiers");
    seen.add(id);
    if (p.reviewBy != null && !dateOnly(p.reviewBy)) throw new Error("reviewBy must be YYYY-MM-DD");
    return { id, expectation: text(p.expectation, "expectation"),
      invalidationCondition: text(p.invalidationCondition, "invalidationCondition"), reviewBy: p.reviewBy ?? null };
  });
}

export function buildThesisScorecard(record, asOf = new Date().toISOString()) {
  const reviews = (record.reviews ?? []).filter((r) => Date.parse(r.reviewedAt) <= Date.parse(asOf));
  const pillars = record.pillars?.length ? record.pillars : (reviews.find((r) => r.pillars?.length)?.pillars ?? []);
  return {
    decisionId: record.id, symbol: record.symbol, asOf, researchOnly: true,
    pillars: pillars.map((pillar) => {
      const updates = reviews.flatMap((r) => (r.pillarUpdates ?? [])
        .filter((u) => u.pillarId === pillar.id).map((u) => ({ ...u, reviewedAt: r.reviewedAt })));
      const latest = updates.at(-1);
      return { ...pillar, status: latest?.status ?? "unreviewed", latestAssessment: latest ?? null,
        overdue: Boolean(pillar.reviewBy && pillar.reviewBy < asOf.slice(0, 10)), history: updates };
    }),
    limitation: "Pillar assessments are attributed research judgments, not calibrated probabilities or position changes.",
  };
}

export function projectCatalystCalendar(items, { asOf = new Date().toISOString(), symbols, includeMacro = true } = {}) {
  const wanted = symbols ? new Set(symbols.map(normalizeSymbol)) : null;
  const groups = new Map();
  const warnings = [];
  for (const item of items) {
    const p = item.payload ?? {};
    if (!p.eventType || !validTimestamp(item.publishedAt) || !validTimestamp(item.availableAt) ||
        Date.parse(item.availableAt) > Date.parse(asOf) || Date.parse(item.publishedAt) > Date.parse(asOf)) continue;
    const macro = item.kind === "macro" && !item.entity?.symbol;
    let affectedSymbols;
    try {
      affectedSymbols = [...new Set([item.entity?.symbol, ...(Array.isArray(p.affectedSymbols) ? p.affectedSymbols : [])]
        .filter((s) => typeof s === "string" && s.trim()).map(normalizeSymbol))];
    } catch { warnings.push(`${item.id}: invalid affected symbol`); continue; }
    if (macro ? !includeMacro : wanted && !affectedSymbols.some((s) => wanted.has(s))) continue;
    const status = p.eventStatus ?? "tentative";
    if (!["tentative", "confirmed", "cancelled", "completed"].includes(status)) {
      warnings.push(`${item.id}: invalid eventStatus`); continue;
    }
    if ((!p.scheduledAt && status !== "cancelled") || (p.scheduledAt &&
        !validTimestamp(p.scheduledAt))) {
      warnings.push(`${item.id}: invalid or timezone-less scheduledAt`); continue;
    }
    if (p.timezone) {
      try { new Intl.DateTimeFormat("en", { timeZone: p.timezone }); }
      catch { warnings.push(`${item.id}: invalid timezone`); continue; }
    }
    // Scope identity to provider + entity. Never silently merge distinct sources' claims.
    const key = JSON.stringify([item.providerId, item.entity?.symbol ?? item.entity?.name, p.eventType, p.eventKey || item.externalId || item.id]);
    const entries = groups.get(key) ?? [];
    if (!entries.some((e) => e.id === item.id)) entries.push({ ...item, affectedSymbols, status });
    groups.set(key, entries);
  }
  const events = [];
  for (const [eventKey, versions] of groups) {
    versions.sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt) ||
      Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.id.localeCompare(b.id));
    const latest = versions.at(-1);
    const p = latest.payload;
    const scheduledAt = p.scheduledAt ?? [...versions].reverse().find((e) => e.payload.scheduledAt)?.payload.scheduledAt;
    if (!scheduledAt) { warnings.push(`${latest.id}: cancelled event has no known schedule`); continue; }
    const conflict = versions.some((e) => e.id !== latest.id && e.availableAt === latest.availableAt && e.publishedAt === latest.publishedAt &&
      ((e.payload.scheduledAt ? Date.parse(e.payload.scheduledAt) : null) !== (p.scheduledAt ? Date.parse(p.scheduledAt) : null) || e.status !== latest.status));
    events.push({
      id: latest.id, eventKey, symbol: latest.entity?.symbol ?? null, affectedSymbols: latest.affectedSymbols,
      title: latest.title, eventType: p.eventType, scheduledAt, effectiveAt: scheduledAt,
      timezone: p.timezone ?? null, eventStatus: latest.status,
      dateConfidence: !conflict && p.dateConfidence === "confirmed" && latest.status === "confirmed" ? "confirmed" : "estimated",
      conflict, ...citation(latest), evidenceIds: versions.map((e) => e.id),
      history: versions.map((e) => ({ ...citation(e), scheduledAt: e.payload.scheduledAt ?? null, eventStatus: e.status })),
      missingStableIdentity: !p.eventKey && !latest.externalId,
    });
  }
  events.sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt) || a.id.localeCompare(b.id));
  return { asOf, events, warnings, researchOnly: true };
}

export async function queryCatalystCalendar(input = {}) {
  const asOf = researchAsOf(input.asOf);
  const preferences = input.symbols ? null : await loadPreferences();
  const symbols = input.symbols ?? [...new Set([...(preferences.watchlist ?? []), ...(preferences.positions ?? []).map((p) => p.symbol)])];
  const from = input.from ?? asOf;
  if (!validTimestamp(from)) throw new Error("Calendar from must be a valid timezone-aware timestamp");
  const to = input.to ?? new Date(Date.parse(from) + 30 * 86400000).toISOString();
  if (![from, to].every(validTimestamp) || Date.parse(from) > Date.parse(to))
    throw new Error("Calendar requires a valid timezone-aware from <= to interval");
  const evidence = await queryEvidence({ asOf, limit: 500 });
  const calendar = projectCatalystCalendar(evidence.items, { asOf, symbols, includeMacro: input.includeMacro ?? true });
  calendar.events = calendar.events.filter((e) => Date.parse(e.scheduledAt) >= Date.parse(from) && Date.parse(e.scheduledAt) <= Date.parse(to) &&
    (input.includeCancelled || e.eventStatus !== "cancelled"));
  return { ...calendar, from, to, symbols,
    coverage: { scanned: evidence.returned, totalAvailable: evidence.totalMatched, truncated: evidence.totalMatched > evidence.returned },
    warnings: [...calendar.warnings, ...(evidence.totalMatched > evidence.returned ? ["Evidence scan truncated; calendar may omit events or revisions."] : [])],
    limitation: "Calendar of ingested evidence only, not a complete market calendar. Revisions require a stable eventKey per provider/entity/type. No notifications are scheduled by this query." };
}
