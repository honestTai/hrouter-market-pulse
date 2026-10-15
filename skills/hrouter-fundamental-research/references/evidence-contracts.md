# Research evidence payloads

Use `ingest_evidence` after registering the companion provider, or `ingest_official_records` only for supported original official sources. Keep entity.symbol, sourceUrl, publishedAt and the provenance of any extraction. A provider's sourceTier must match its registration; commercial MCP transport does not itself imply official status.

Leave availableAt absent unless historical availability can be established. It then defaults to first ingestion. Do not set it to an old publication date merely to make a historical comparison pass. No credentials or remote executable code belong in the registry or payload.

## Financial fact (`kind: financial`)

Each record represents one metric and period. Example schema values below are illustrative, not market data:

```json
{
  "metric": "Revenue",
  "value": 120,
  "unit": "USD",
  "scale": 1000000,
  "currency": "USD",
  "periodStart": "2026-04-01",
  "periodEnd": "2026-06-30",
  "accountingBasis": "us-gaap",
  "valueType": "actual"
}
```

- `value` must be a finite number, not numeric text. `scale` defaults to 1; 120 with scale 1000000 means 120 million units. The tool does not silently convert scales or currencies.
- `periodStart` is null/absent for balance-sheet instant facts; both dates otherwise use YYYY-MM-DD. Do not relabel year-to-date totals as standalone quarters.
- `accountingBasis` must be explicit and identical for comparisons (e.g. us-gaap, ifrs, or a clearly defined adjusted basis). Legacy facts lacking this metadata must be supplemented from the source, not guessed.
- `valueType` is `actual`, `consensus`, or `company-guidance`. Actuals cannot be estimates. Baselines use the requested type.
- `comparisonType: prior-period` requires earlier nonoverlapping actuals with equal period character and duration within seven days; no automatic YoY/QoQ label is inferred. Consensus/guidance require exactly matching periods and availability strictly before the actual's disclosure time.
- Exact metric names must match. Do not equate differently defined measures merely because both are called revenue/EPS.
- Percent changes are suppressed for zero/negative baselines; use the reported absolute difference. Arithmetic is in the declared unit/scale. No investment rating or price target is produced.
- The current SEC adapter provides explicit actual/us-gaap metadata for newly synchronized facts. It does not promise historical consensus or all comparative periods.

## Event (`kind: filing`, `corporate_action`, `macro`, or another supported kind)

```json
{
  "eventType": "earnings",
  "eventKey": "issuer-fy2026-q2-release",
  "scheduledAt": "2026-08-10T20:00:00Z",
  "timezone": "America/New_York",
  "eventStatus": "confirmed",
  "dateConfidence": "confirmed",
  "affectedSymbols": ["AAPL"]
}
```

- Entity/type/provider and eventKey jointly identify revisions. `externalId` is the fallback stable identity. Without either, each evidence record stays separate; similar titles do not prove event identity.
- `scheduledAt` must include Z or a numeric UTC offset. `timezone`, if supplied, is an IANA zone. Do not create precise intraday times from date-only announcements; keep those as ordinary evidence until time is known.
- `eventStatus`: tentative (default), confirmed, cancelled, completed. Date confidence is estimated unless explicitly confirmed on a confirmed event.
- A cancellation may omit scheduledAt only when earlier evidence with the same identity supplies it. Revisions/cancellations are appended with their own publication and availability times.
- Calendar ordering uses availability, then publication, with a conflict flag for contradictory simultaneous versions. Sources remain separate; disagreements require review.
- The query scans up to 500 available evidence records and reports truncation. It is not a complete market event feed. Default occurrence window is the next 30 days from asOf. includeCancelled reveals cancellations; includeMacro includes global macro evidence.

## Thesis records

Pillars have stable `id`, original `expectation`, explicit `invalidationCondition`, and optional date-only `reviewBy`. Review updates have `pillarId`, `status` (supported/weakened/invalidated/inconclusive), `rationale` and nonempty `evidenceIds` for the decision symbol. Append calls preserve their recording time and the original hash, and share the existing decision-journal write queue. They neither revise the original pillars nor change decision state. New pillars on a legacy decision become visible only from that initialization review onward.
