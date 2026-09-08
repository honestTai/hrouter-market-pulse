---
name: hrouter-intraday-monitor
description: Monitor timestamped A-share, Hong Kong, and US stock changes during market hours. Use for 盘中盯盘、异动提醒、关键价位监控, or recurring intraday checks. Do not place orders or claim public quotes are broker-real-time.
---

# Hrouter Intraday Monitor

Monitor a bounded watchlist and surface only decision-relevant changes.

1. Resolve symbols from the request or `get_preferences`. If the saved watchlist is empty, call `get_onboarding` and return the first-run guide. Do not broaden the watchlist without the user's instruction.
2. Call `create_market_report` with `phase: "intraday"` and `includeNews: true`. Use the current Codex task model to interpret material changes while preserving the tool's exact numbers.
3. Use persisted `alertEvents` to identify confirmed crossings and recoveries. The first observation establishes a silent baseline; repeated snapshots do not create new events. Respect confirmation counts, cooldown and hysteresis. Treat alerts as attention signals, not trade signals.
4. Include each material item's sources, cross-check status, data-quality warnings, and `asOf` time. Account for A-share T+1, market holidays, halts, price limits, and different A/H/US sessions when relevant.
5. Never calculate with a price that is absent from tool output. Do not promise execution at a trigger price or describe a stop as guaranteed.
6. For recurring scheduled checks, stay quiet when there are no alerts or material data changes. Report failures that prevent monitoring.
   Quotes must have `freshness.signalEligible: true` and `crossCheck.status: "matched"` before a trading condition can trigger. A stale, future, missing timestamp or unverified trading calendar prevents alerts; acknowledge a newly blocking data failure once rather than repeating unchanged errors every poll.
7. Include `latestDashboardUrl` only when reporting a change or when the user asks for the full view. Open it in the Codex in-app browser for interactive reports and material scheduled alerts; never foreground the browser for a quiet scheduled poll.
8. For each reported change, state `持有观察`, `卖出评估`, `不动`, or `数据不足`, plus the position change and condition for reassessment. Use `买入候选` only when the user's complete entry and risk policy is already present.
9. Keep daily MA/RSI/support/resistance separate from the 5-minute intraday chart. Intraday volume uses completed bars compared with the same local-clock slots from at least five complete prior sessions; show unavailable when that evidence is missing.
10. Use the saved language (`zh-CN` or `en`) and translate the action states for English. The dashboard refresh command fetches new reports; automatic refresh runs only while its page is open and enabled. Persistent background scheduling still requires a Codex scheduled task.

Use Codex reasoning only when a detected change needs interpretation. Quiet monitoring intervals should stop after deterministic checks.
