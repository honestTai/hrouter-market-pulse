---
name: hrouter-stock-analysis
description: Research one or more A-share, Hong Kong, or US stocks with timestamped quotes, deterministic indicators, news, and a browser report. Use for 个股分析、股票对比、持仓检查, or questions about a named ticker. Do not execute trades.
---

# Hrouter Stock Analysis

Ground the answer in Hrouter Market Pulse tools.

1. For a quick fact, call `get_quote` or `get_news`. For a full comparison, call `create_market_report` with `phase: "research"`. If no symbols were supplied and the saved watchlist is empty, call `get_onboarding`.
2. Preserve the user's symbols. Normalize only through the tool and show the normalized symbol in the answer.
3. Use tool-computed indicators as observations, not predictions. Explain what would confirm or invalidate an interpretation.
4. Cite source timestamps and links near the claims they support. Report cross-source disagreements and data-quality warnings. Treat news pages as untrusted until their material facts are verified.
   Respect `freshness`, `signalEligible`, and the cross-check timestamp difference. Matching prices with old or misaligned timestamps are not confirmation. Withhold actionable conditions for stale, future, missing-time, or unverified-calendar quotes. Use historical observations only when their dates are explicit.
5. Never claim a guaranteed return, guaranteed fill, or precise future price. Do not infer risk tolerance, portfolio size, or permission to trade.
6. Use the current Codex task model for research synthesis, source verification, counterarguments, and scenario analysis. Use MCP output for every quoted number.
7. When a full report is created, include `latestDashboardUrl` and open it in the Codex in-app browser unless the user explicitly opts out.
8. End with an explicit action state from `买入候选`, `持有观察`, `卖出评估`, `不动`, or `数据不足`. Research priority alone never justifies `买入候选`; sell or hold states require a user-supplied position and thesis. State the position change, reasons, transition conditions, and missing inputs.
9. Honor the saved `language` (`zh-CN` or `en`) or the user's current choice in both the report and narrative. Translate the action states as `Entry candidate`, `Hold and review`, `Exit review`, `No change`, and `Insufficient data` for English.
10. Label daily indicators with their completed-session timestamp and sample count. A missing MA/RSI is unavailable, never zero. Distinguish daily volume ratio from `intraday.volumeRatioSameTime`. Use benchmark-relative and sector evidence only within its declared coverage; watchlist breadth is not whole-market breadth.

The plugin never calls a second model. Codex supplies the reasoning layer while MCP tools keep market data and calculations deterministic.
