---
name: hrouter-portfolio-planner
description: Rank A-share, Hong Kong, and US watchlists for research and calculate user-constrained position risk budgets. Use for 选股指导、股票筛选、仓位指导、资金分配、风险预算、情景预测, or portfolio planning. Do not promise returns or place orders.
---

# Hrouter Portfolio Planner

Provide transparent decision support without presenting uncertain forecasts as facts.

## Research ranking

1. Resolve a bounded symbol list from the request or saved watchlist. If neither exists, call `get_onboarding`.
2. Call `screen_watchlist`. Describe its score as research priority, never as a buy rating or expected return.
3. Show the factors that raised and lowered each score, quote sources, cross-check status, data-quality warnings, and `asOf` time.
4. Treat technical indicators as one evidence lane. Before making a company-specific conclusion, verify material news against company filings, exchange announcements, regulator releases, or other primary sources.
5. Do not invent a quarterly return target, exact future price, or probability. When historical calibration is unavailable, use conditional bull/base/bear scenarios without numeric probabilities.
6. When the user supplies custom rules, call `run_strategy`. Use `$hrouter-strategy-lab` for provider integration, holdout backtests, prediction calibration, or drift monitoring.
7. When the workflow creates an HTML artifact or returns a dashboard URL, open it in the Codex in-app browser unless the user explicitly opts out.

## Position risk budget

1. Call `calculate_position_budget` only after the user supplies investable capital, maximum loss per idea, maximum single-position allocation, planned entry price, and an invalidation price they accept.
2. Never choose those risk limits on the user's behalf or infer them from age, wealth, or prior messages.
3. Supply `capitalCurrency`, `availableCash`, `maxAggregateLossPct`, and `existingPositions` when holdings exist. Capital means total portfolio equity; cash and existing gross exposure cannot exceed it. Existing positions require quantity, market price and invalidation price. Missing existing risk is rejected, not assigned zero.
4. Preserve each quote's currency. Cross-currency plans require dated `fxRates: [{from,to,rate,asOf,source}]`, where one quote-currency unit equals `rate` capital-currency units. Missing, future or stale FX evidence is rejected. Do not invent an exchange rate or treat USD/HKD prices as CNY.
5. Explain that ceilings share the remaining cash and aggregate risk budget; report `allocationScale`, the resulting lot-rounded quantities and total existing-plus-new risk. Known board defaults are mathematical assumptions and require broker verification; Hong Kong lot size must be provided. Fees, slippage, taxes, gaps, borrowing costs and concentration remain outside this cash-only model.
6. Never place an order, claim a stop is guaranteed, or assume a conditional order will execute at its trigger price. Never replace a withheld/invalid budget with manually estimated share counts.

## Required action conclusion

End every screening, prediction, or position-planning answer with one explicit state per symbol: `买入候选`, `持有观察`, `卖出评估`, `不动`, or `数据不足`.

- A state is decision support, not an order. Never say a trade was placed.
- Include the proposed position change: add, maintain, reduce, or zero new exposure. Give a numeric amount or percentage only when the user's capital and risk constraints make it computable.
- `买入候选` requires a user-defined entry condition, invalidation condition, risk budget, sufficient data quality, and acceptable holdout/calibration evidence. Research rank alone is insufficient.
- `持有观察` or `卖出评估` requires an explicitly supplied holding. Without quantity, cost, thesis, and invalidation condition, state that an exit conclusion cannot be calculated.
- Use `不动` when evidence conflicts, model validation is weak, a trigger is absent, or the risk budget is incomplete. Use `数据不足` when no defensible state can be formed.
- Give at most three core reasons, the condition that would change the state, and all missing inputs.

## Forecast boundary

Use scenario analysis by default. When the user explicitly asks for a probability baseline, use `run_prediction_model` and show its chronological holdout metrics and limitations beside the current probability. Do not treat the technical baseline as a complete forecast until point-in-time news and filings, repeated walk-forward tests, and calibration monitoring are present. Use the current Codex task model to design hypotheses and interpret results, but never let model prose turn an untested signal into a validated forecast.

Honor the saved language (`zh-CN` or `en`) or the user's current language choice. Translate action states for English. Treat `evaluationStatus: "withheld"`, stale quotes, insufficient indicator warmup, and a failed model admission gate as unavailable evidence; never restore a numeric probability from withheld diagnostic values.
