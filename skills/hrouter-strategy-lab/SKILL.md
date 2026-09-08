---
name: hrouter-strategy-lab
description: Extend Hrouter Market Pulse with evidence providers, declarative strategies, point-in-time queries, leakage-aware backtests, probability calibration, and drift checks. Use for 接官方公告、数据源扩展、自定义策略、历史回测、概率校准、模型漂移, or strategy validation. Do not use backtests as return guarantees.
---

# Hrouter Strategy Lab

Build on the stable research contracts without injecting arbitrary code into the core MCP process.

## Start with capabilities

Call `get_foundation_capabilities` before designing an extension. Preserve its contract version, evidence kinds, source tiers, feature allowlist, and safety boundary.

## Add evidence providers

1. Use a companion Skill or MCP server to fetch source data. Register only provider metadata with `register_data_provider`; never store credentials, executable code, or authenticated endpoints in the registry.
2. Normalize source records through `ingest_evidence`. Keep the original URL, provider id, source tier, entity, publication time, effective time, and fetch time.
3. Set `availableAt` only when the provider can establish when the record was actually available historically. Otherwise omit it so the foundation conservatively uses first ingestion time.
4. Treat exchange, regulator, issuer, and government publications as `official`; use `primary` only for direct originators and `secondary` for media or aggregators.
5. Query historical evidence with `query_evidence` and an explicit `asOf`. Never pass evidence with a later `availableAt` into an earlier decision.
6. A companion provider's source tier is user-declared metadata. Do not describe it as independently verified unless its connector and origin have actually been audited.

## Define and test strategies

1. Express scoring through `run_strategy` using allowlisted numeric features and versioned declarative rules. Explain each matched rule and missing feature.
   Evidence-derived features use the `external.<name>` namespace and must include `availableAt` plus supporting evidence IDs.
2. Use `run_backtest` before describing historical behavior. Signals use completed bars available after day T close and enter at a later session open. Ordinary A-share positions cannot exit before the next session after entry. Limit-price and suspended-session orders can remain unfilled or have deferred exits.
3. Separate strategy development and evaluation periods. Do not tune thresholds on a period and present the same period as out-of-sample evidence. Prefer chronological holdouts or repeated walk-forward windows.
4. Supply `initialCapital`, account `currency`, `maxPositionPct`, `maxGrossExposurePct`, `transactionCostBps`, and `slippageBps` for a portfolio evaluation. Mixed-currency symbols require explicit `fxRates` into the account currency; Hong Kong stocks require verified `lotSizes`. Rates remain constant throughout the simulation, so the result excludes historical currency gains and losses.
5. Report portfolio return and equity drawdown beside realized trade count, hit rate, return distribution, open positions, unfilled orders, costs, and data exclusions. Shared cash constrains simultaneous positions; per-symbol trade averages are not independent full-capital returns. Small samples remain inconclusive.
6. Explicit splits adjust held shares and dividends credit eligible positions at ex-date. Yahoo split-adjusted history is reconstructed before execution. Unexplained adjustment changes invalidate the affected history. Exact taxes, settlement delays, historical rule exceptions, delisting/survivorship, and intraday liquidity still require more complete data; an all-in cost estimate is not a verified fee schedule.

## Evaluate predictions and drift

- Use `run_prediction_model` as an experimental technical baseline. It runs 3-5 expanding walk-forward folds; training labels must resolve before each evaluation window. Evaluation windows do not repeat observations. Earlier evaluation data can enter a later training window only after its outcomes are historically available.
- Respect the returned `qualification`: at least 3 folds and 90 evaluation observations, ROC AUC >= 0.55, Brier score and log loss better than the training-prevalence baseline, calibration error <= 0.10, positive Brier improvement in every fold, complete recent features, and no detected drift. These are research gates, not evidence of guaranteed profitability. Overlapping forecast horizons do not provide independent samples.
- `observe` and `rejected` results suppress public probability values and require zero new exposure. For `qualified` results show the probability with fold counts, baseline comparison, ROC AUC, Brier score, log loss, calibration error, feature dates, target, and limitations. Qualification permits decision review only.
- Usable forecasts are automatically persisted with an immutable recording time, model version, training parameters, features, and validation evidence. Use `query_prediction_ledger` to retrieve them and `resolve_prediction_outcomes` to append outcomes from completed bars after recording. Failed entry fills are recorded separately from return outcomes. Research eligibility expires after 24 hours or resolution and is superseded by newer evaluations; check `qualification.currentlyEligible` before creating a candidate decision.
- Call `evaluate_prediction_calibration` only for predictions recorded before their outcomes; future outcomes are rejected. Prefer the persisted ledger's live calibration to hand-entered samples. Report Brier score, log loss, calibration error, and observation count together.
- Call `monitor_feature_drift` with comparable baseline and current samples. Drift is a reason to investigate data and behavior, not automatic proof that a strategy is worse.
- Never convert forecast probabilities into guaranteed price targets, override a failed qualification gate in prose, or describe a replayed historical experiment as a prediction made before the outcome.

Use the current Codex task model for source mapping, feature proposals, declarative rule design, counterfactuals, and interpretation. Deterministic MCP tools remain authoritative for timestamps, calculations, backtests, calibration, and drift. Model prose does not replace point-in-time evidence or validation.

When a strategy, backtest, calibration, drift, or evidence workflow produces an HTML artifact or dashboard URL, open it in the Codex in-app browser for interactive requests unless the user explicitly opts out. Keep quiet scheduled checks in the background.

End an interactive model evaluation with a deployment state: `可进入决策评审`, `继续观察`, or `模型不合格`. If the model is not qualified, downstream portfolio conclusions must default to `不动` and zero new exposure. Explain which validation evidence blocks deployment and what new evidence would change the state.
