---
name: hrouter-fundamental-research
description: Compare sourced financial results, review recorded investment thesis pillars, and query announced event calendars for A-share, Hong Kong and US research. Use for 财报变化、业绩对比、投资逻辑复核、反证追踪、事件日历. Does not purchase data, schedule reminders, or authorize trades.
---

# Evidence-backed fundamental research

Use the existing Hrouter evidence store and deterministic tools. Workflow concepts are adapted from anthropics/financial-services; see the packaged THIRD_PARTY_NOTICES.md. Do not install its Claude runtime, connectors, or commercial subscriptions as part of this skill.

## Financial results

1. Query existing financial evidence with `query_evidence`. If necessary, use `sync_official_evidence` for the user's symbols or import original authorized sources. SEC coverage does not guarantee complete historical comparatives; A/HK announcements may require extraction. Never invent missing fields or dates.
2. Read [evidence-contracts.md](references/evidence-contracts.md) before importing extracted financial facts or event revisions. Keep source documents and distinguish actuals, consensus and company guidance. Extracted facts must be supported by the cited original and reviewed for period, unit, scale and accounting basis.
3. Select explicit actual/comparison evidence IDs and call `build_earnings_review`. Respect all unavailable comparisons. Missing consensus is not a reason to substitute guidance, and estimates recorded after disclosure cannot become pre-release expectations.
4. Default to a concise change card: reported metrics, comparable changes, explanation supported by sources, thesis implications and missing inputs. Separate actual facts from interpretation. Above/below estimates is a numeric direction, not necessarily good/bad performance. Cite document dates and URLs next to claims. Do not force the most recent quarter when the user requests a historical period.

## Thesis review

- Use `query_decisions` to locate the relevant saved decision; do not guess a decision ID or position.
- Use `query_thesis_scorecard` for a read-only current or historical view. Treat statuses as research judgments, never calibrated probabilities.
- When the user requests recording a thesis review, call `append_thesis_review` with a rationale and available symbol-specific evidence for each assessment. Consider disconfirming evidence as carefully as supporting evidence. Use `inconclusive` when evidence is insufficient; do not fabricate support to fill a card.
- A new `record_decision` can include up to 12 falsifiable `pillars`. A legacy decision can initialize pillars on its first thesis review; this is recorded now, not backdated into the original decision. Existing pillars cannot be replaced. A changed thesis requires a new decision.
- An invalidated pillar does not by itself change the decision's state or authorize an exit. Preserve existing quote, model-qualification and user-supplied risk-budget gates.

## Catalyst calendar

Call `query_catalyst_calendar` for explicit symbols or the saved watchlist/positions. `asOf` is what was known then; `from`/`to` delimit event occurrence times. Report tentative/confirmed dates, cancellations, conflicting versions, source timestamps and coverage warnings. The calendar covers ingested evidence only, not every event in the market.

Event imports require an explicit announced schedule with timezone. Revisions reuse a stable event key and append new evidence; never overwrite historical announcements. The query does not schedule notifications or change automation settings. Do not claim a reminder exists unless a separate user-authorized scheduling action has succeeded.
