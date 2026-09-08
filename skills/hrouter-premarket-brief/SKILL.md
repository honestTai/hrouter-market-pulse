---
name: hrouter-premarket-brief
description: Generate a timestamped premarket brief for A-shares, Hong Kong stocks, and US stocks. Use for 盘前简报、开盘准备、隔夜影响、今日观察清单, or scheduled premarket research. Do not use for live order execution.
---

# Hrouter Premarket Brief

Create an evidence-backed opening plan from Hrouter Market Pulse data.

1. Resolve the requested symbols. When none are present, call `get_preferences` and use the saved watchlist. If the saved watchlist is empty, call `get_onboarding` and return the first-run guide instead of only emitting an error.
2. Call `get_market_snapshot` for relevant markets, then call `create_market_report` with `phase: "premarket"`.
3. Use the current Codex task model to synthesize the structured snapshot, verified news, risks, and observation conditions. Keep numerical indicators grounded in MCP output.
4. Lead with overnight or pre-open changes that could invalidate an existing thesis. Separate verified facts, rule-derived observations, and unknowns.
5. Include every available quote source, cross-check status, and `asOf` time. Public quotes may be delayed; never describe them as broker-real-time data. Surface provider disagreements and data-quality warnings.
6. Provide observation conditions and risk checkpoints, not guaranteed returns or automatic orders. Never invent exact support, resistance, valuation, or position sizes.
7. End with the returned `latestDashboardUrl`. For an interactive run, open it in the Codex in-app browser unless the user explicitly opts out. For a scheduled run, open it only when the task emits a result.
8. End each material symbol with one action state: `买入候选`, `持有观察`, `卖出评估`, `不动`, or `数据不足`. Include the position change and observation trigger; do not infer holdings or risk limits.

For scheduled runs, keep the response concise. If every requested market is closed and no new data is available, report that state without fabricating a premarket move.
