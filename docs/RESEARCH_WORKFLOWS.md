# 财报、投资逻辑与事件研究 / Fundamental research

These workflows adapt selected ideas from Anthropic's financial-services reference skills to Hrouter's existing evidence and decision contracts. No Claude runtime or commercial connector is installed. See [attribution](../THIRD_PARTY_NOTICES.md).

## What is implemented

| Tool | Behavior |
| --- | --- |
| `build_earnings_review` | Deterministic comparison of explicitly selected financial evidence; returns sourced structured data for the assistant's change card |
| `query_catalyst_calendar` | Read-only evidence-derived calendar with revision history, cancellations, date confidence and coverage |
| `append_thesis_review` | Append per-pillar assessments and source citations; does not overwrite originals or change decision state |
| `query_thesis_scorecard` | Current or historical pillar scorecard, retaining every assessment available at the requested time |

`record_decision` additionally accepts optional `pillars`. Existing decisions and outcome reviews remain supported. `query_decisions` adds a derived scorecard only when pillars exist; the scorecard is not part of the original hashed record. Dashboard decision cards show the latest pillar assessment; event cards show status, schedule and revision count. Financial comparisons are currently MCP results, not a separate dashboard valuation screen.

## Example requests

```text
同步 AAPL 的官方财务事实，比较指定季度与可比期间；若没有共识数据，不要判断超预期。

为已保存的研究判断补充可证伪的论据，并用新公告复核哪些论据得到支持、削弱或失效。

查看我的自选股未来 30 天已知事件，区分预计、确认与取消，并说明是否覆盖完整。

Show my thesis scorecard as it was known at the requested timestamp. Do not apply later reviews retroactively.
```

The assistant uses `query_evidence` to obtain real IDs before calling financial or thesis tools. The tools do not obtain missing consensus automatically. To import additional facts or events, follow the [payload contracts](../skills/hrouter-fundamental-research/references/evidence-contracts.md).

### Financial review example (replace IDs with existing records)

```json
{
  "symbol": "AAPL",
  "metrics": [{
    "actualEvidenceId": "ev_<existing actual ID>",
    "comparisonEvidenceId": "ev_<existing comparison ID>",
    "comparisonType": "prior-period"
  }]
}
```

Actual/comparison metric, accounting basis, unit and scale must match. Prior actuals must precede the reported period and have comparable durations; estimates must cover exactly the same period and be available strictly before disclosure. Negative/zero baselines suppress percent change. Missing metadata returns an unavailable comparison, not inferred compatibility. Malformed or unavailable source facts reject the request.

### Thesis review

A pillar has a stable ID, expectation, invalidation condition and optional review deadline. Each assessment includes a status (`supported`, `weakened`, `invalidated`, `inconclusive`), rationale and evidence IDs for that security. Initial pillars can be recorded with a new decision, or appended now to a legacy decision. Established pillars cannot be silently replaced. Thesis reviews are tagged `type: thesis-assessment` and do not set an outcome or reopen a closed outcome review. The original hash and existing candidate/risk gates are preserved; even `invalidated` does not authorize a trade.

### Events and historical availability

A revision reuses the same provider/entity/event type/event key. Each revision is separate evidence with its own availability. The calendar defaults to the saved watchlist/positions and includes global macro evidence; explicit `symbols` selects a different scope. `includeCancelled` reveals cancellations. Dates need an explicit timezone; date-only announcements remain ordinary evidence until a time is established. `asOf` selects the information set, while `from`/`to` select occurrence dates.

Only up to 500 available evidence records are scanned, with explicit truncation warnings. This is not a complete market-calendar subscription, and calendar queries do not create reminders. A missing stable event key prevents reliable revision merging. Different providers remain separate for manual source comparison. The tool does not supply broker-real-time data or automatically infer new trading signals.

## Integration / provenance

- Research logic: `mcp/research.mjs`; decision persistence: `mcp/workspace.mjs`; MCP registration: `mcp/server.mjs`.
- SEC facts synchronized after this change include actual/us-gaap metadata. The current SEC adapter still selects recent facts, not a full comparative history or consensus database. Other markets may require sourced extraction/imports.
- `availableAt` stays first ingestion unless the provider can establish historical availability. Historical source claims remain provider-declared, not independently audited. Never backdate today's estimates to validate a past prediction.
- Commercial data subscriptions, authentication and redistribution rights remain separate work. This change enables no paid data source.
- No automatic schedules are added. Financial results are generated on demand; thesis assessments persist only when explicitly appended.

## Verification

Run `npm test`, `npm run build`, `npm run check`, and `npm run smoke`. Tests use isolated temporary stores and synthetic fixtures; smoke invokes all four new tools from the packaged MCP server without fetching live market data. Production source entitlements and extraction accuracy require separate checks against the user's actual providers.
