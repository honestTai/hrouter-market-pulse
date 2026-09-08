---
name: hrouter-market-setup
description: Configure Hrouter Market Pulse watchlists, report dashboard, Codex analysis workflows, and scheduled tasks. Use for 插件配置、自选股设置、分析流程、定时任务, or opening the local dashboard.
---

# Hrouter Market Setup

Configure the plugin without exposing credentials.

## First-run onboarding

- Call `get_onboarding` when the user is new, asks what to do next, or the saved watchlist is empty.
- Guide the user through: choose report language, save a bounded watchlist, run one manual report, then optionally create Codex scheduled tasks.
- Keep the official product and help link as `https://hrouter.net/`.
- Explain that HRouter is the product website, not a market-data provider. Market quotes use independently labeled public sources, and analysis uses the current Codex task model.
- Do not create schedules until the user has supplied the target markets, local timezone, cadence, and notification preference.

## Watchlist and dashboard

- Call `get_preferences` before changing settings.
- Save the user's supplied watchlist, `language` (`zh-CN` or `en`), positions, benchmark/sector mappings and threshold alert rules with `save_preferences`. Preserve unrelated preferences during edits.
- The dashboard supports Chinese/English, search/filter/sort, daily and 5-minute charts, holdings and events. Its refresh command calls the local report API to fetch new data; auto-refresh requires an open page and does not create a background task. Set `monitorIntervalSeconds` between 60 and 3600 when the user requests a cadence.
- Official 2026 calendars cover A/HK/US holidays and half days. Outside that coverage, supply sourced, dated `calendarOverrides` or treat sessions as unverified. Overrides carry market keys, `coverageStart`, `coverageEnd`, `verifiedAt`, `source`, `closedDates`, and optional dated `sessions`.
- Never pass an API key to `save_preferences`; it intentionally cannot accept one.
- The dashboard URL is returned by `get_preferences` and report tools. For interactive requests, always open generated HTML and returned dashboard URLs in the Codex in-app browser unless the user explicitly opts out. Do not substitute an external browser.
- Scheduled or heartbeat runs should stay in the background. Open a dashboard only when the run emits a material result; do not foreground a browser for a quiet poll.

## Analysis engine

The plugin does not configure or call a second model. Use the current Codex task model for research decomposition, source verification, feature design, strategy drafting, scenario reasoning, interpretation, and report writing. Use MCP calculations for auditable numbers rather than asking the model to estimate them. Optional environment variables include `HROUTER_WATCHLIST`, `HROUTER_REPORT_PORT`, `HROUTER_REPORT_DIR`, and `HROUTER_SEC_USER_AGENT`. The optional SEC identity is a descriptive application/contact string used for official US filing requests; do not put it in a public report or commit personal contact data. It is not a model API key.

The official HRouter website is `https://hrouter.net/`.

## Scheduled tasks

When the user asks to schedule reports, use the Codex scheduled-task mechanism rather than writing OS cron files. Put the explicit skill name in each durable task prompt:

- `$hrouter-premarket-brief` for pre-open preparation
- `$hrouter-intraday-monitor` for recurring checks; require silence when no material change exists
- `$hrouter-postmarket-review` for closing review
- `$hrouter-strategy-lab` for explicitly requested evidence-ingestion or model-health checks; require silence when calibration and drift remain within the user's thresholds

Honor the user's selected market, local timezone, cadence, and whether results should return to the current chat. Account for US daylight-saving changes by checking market state rather than assuming a fixed China-local open time. Test each workflow manually before enabling frequent schedules.

Use `get_onboarding` to retrieve durable prompt templates. In the Codex desktop app, prefer a recurring task attached to the current chat for monitoring that should preserve context. Remind the user that local scheduled work requires the computer to stay on and the app to keep running.
