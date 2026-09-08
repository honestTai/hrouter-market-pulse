---
name: hrouter-postmarket-review
description: Produce a postmarket review for A-shares, Hong Kong stocks, and US stocks. Use for 盘后复盘、收盘总结、持仓归因、信号检查, or scheduled closing reports. Do not treat unverified AI conclusions as realized performance.
---

# Hrouter Postmarket Review

Create a concise, auditable close report.

1. Resolve symbols from the request or `get_preferences`. If the saved watchlist is empty, call `get_onboarding` and return the first-run guide.
2. Call `get_market_snapshot` for the markets being reviewed, then call `create_market_report` with `phase: "postmarket"`.
3. Pass positions only when the user provided or saved them for this run. Never infer holdings, cost basis, or executed trades.
4. Separate market performance, position performance, rule alerts, news, provider disagreements, and data-quality warnings. Note missing data explicitly.
5. Compare observations against the user's earlier thesis only when that thesis exists in the current chat. Do not manufacture a prior recommendation.
6. Use the current Codex task model for attribution, thesis comparison, and the next-session observation plan. Keep performance calculations grounded in MCP output.
7. End with the returned dashboard URL and a short next-session watchlist. Open the URL in the Codex in-app browser for interactive runs, or when a scheduled run emits a result. Avoid deterministic price predictions.
8. End each material symbol with `买入候选`, `持有观察`, `卖出评估`, `不动`, or `数据不足`. Tie the state to the supplied position, risk budget, thesis, and invalidation condition; list missing inputs instead of inventing them.

For scheduled reports, state which market close the report covers because A/H/US sessions end at different China-local times.
