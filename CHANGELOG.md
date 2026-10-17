# Changelog

## Unreleased

- **Everything left in the design doc, short of a real broker.** News relevance filtering; news / filing / data citations on orders and fills; demo mode removed (synthetic data now lives only in test fixtures).
- **Order pipeline and live-trading prep.** Every order records intent → hard limits → discipline check → confirmation → matching, with dry runs and a reconciliation that rebuilds cash and positions from fills, dividends and splits.
- **Autonomy levels.** Full / confirm key actions / suggest only. In the stricter levels orders become approval cards the owner confirms against a live re-check; agents cannot skip them.
- **Talk to your trader.** Ask questions (answered read-only), give instructions, and set standing rules. Traders can propose rules for the owner to approve.
- **Team mode.** Read-only analysts and an optional bull / bear debate report before each review. New tools: `arena_dispatch`, `arena_await_runs`, `arena_request_confirmation`, `arena_check_rules`, `arena_propose_rule`.
- **Review timing.** Scripts skip unchanged review slots and wake the trader early on fills, stops, sharp moves, instructions and approval decisions. Token budgets and cost displays were dropped.
- **Real A-share market-wide data** from East Money:
  - industries, with a per-industry position cap;
  - the dragon-tiger list and broker seats;
  - limit-up, broken and limit-down pools with streaks;
  - the sentiment cycle and promotion rates;
  - margin and Stock Connect.
  It comes with new MCP tools (`get_market_radar`, `get_dragon_tiger`, `get_limit_up_pool`, `get_margin`, `get_stock_connect`, `get_industry`), a Market radar page, and hot-money and macro-timing templates with four new skills.
- **Skill customization, import and updates.** Per-trader parameters, extra rules and reference notes, with versions. Imports come from Git, a local folder or `~/.claude/skills` (Markdown only). Upstream update checks are included.
- **Research tasks** run read-only with the agent you pick: research question, stock deep dive, investor panel, market recap.
- **Instant alerts** to the digest webhook: orders waiting for confirmation, drawdown breakers, paused traders and exhausted quota. Each is sent once.
- **English UI** (Settings → General → Language), with a test that every UI string has an English entry. Long panels can go full screen.
- **Desktop app** (`desktop/`, Tauri 2, same approach as the video workbench): opens the workbench in its own window, starts the local service from the bundled plugin if it is not running, keeps it running after the window closes, and opens outside links in the browser. `npm run build:desktop` produces a macOS `.app` / `.dmg` (NSIS installer on Windows). MCP and ACP are unchanged.
- **Fix: the resident service no longer hangs when it restarts.** With a workbench page open, its live-events stream kept the HTTP server from closing, so after a plugin update the service stopped listening but never exited and was not restarted. Shutdown now closes open connections and force-exits after 10 seconds.
- UI: the ⌘K search box and text fields no longer show a second hard focus outline; the sidebar scrollbar only appears on hover; the title bar drags the window in the desktop app.

## 1.7.0 — HRouter 股票工作台: local multi-agent trader workbench

- **Trader settings that are enforced, not suggested.** Hard limits checked before every buy (keep cash — default 20% —, max holdings, per-position %, new positions and buy orders per day, risk per trade with a required stop, re-buy cooldown, excluded boards, minimum price, no chasing, drawdown breaker). Layered prompts (global → market → trader) with a full preview. Per-market fee schedules (commission, minimum, waive-minimum, stamp duty, …). Everything is editable from the UI and from MCP tools (`arena_get_settings`, `arena_set_limits`, `arena_set_prompt`, `arena_set_fees`, `arena_set_cadence`); the owner can lock any item, and an agent's change to a locked item becomes a request the owner approves. Every change is logged with who made it and why. Existing accounts get keep-20%-cash once.
- **Fills closer to a real broker.** Market orders pay the ask and receive the bid from Tencent's five-level book (walking levels for size); resting limits and stops also use real minute prints between syncs. Each fill records its data snapshot (bid, ask, last, time, source).
- **The agent is the director.** Traders write their own code strategies with `arena_write_strategy`; a version goes live only after a load in a permission-restricted sandbox process (no files, child processes or environment), a dry run on live data and a backtest on ~6 months of real daily bars with fees, slippage and the cash floor. Rejected versions keep the live one running; `arena_rollback_strategy` goes back. The strategy executes on its own cadence without tokens; the agent reviews every ~10 minutes and decides to keep, tune, rewrite or trade directly.
- **Scheduler for many agents at once.** Streaming runs for Claude Code (stream-json), Codex (--json) and Kimi (stream-json) with per-run event logs, token usage and cost; an ACP runner for Gemini CLI, OpenCode and any other ACP agent. Quota failures pause the CLI login for every trader sharing it and hand rounds to a backup agent; wrong model names, bad flags and missing logins pause the trader instead of retrying every slot; a global cap limits concurrent agent processes. Owner instructions with an expiry are injected into every round.
- **Built-in trader skills** adapted from open-source projects (tradermonty/claude-trading-skills, TauricResearch/TradingAgents, virattt/ai-hedge-fund, shouldnotappearcalm/a-share-skill): pre-trade gate, position sizing, loss circuit breaker, trade review, bull/bear/risk desk roles, investor panel, CANSLIM, VCP, A-share trend pullback, MACD resonance, plus starter strategies and trader templates. Skills that need data the workbench does not have yet (LHB, limit-up pool) are listed as unavailable. Upstream licenses and commits are kept.
- **New UI** in the HRouter video-workbench style (React + TypeScript + Vite + Tailwind): home, traders, trader page (timeline, instructions, portfolio, strategy versions, settings, history, change log), arena with token cost, market, research, reports, strategy and skill libraries, schedules and settings (environment check, agents, quota pools, prompts, fees, push, Futu). Chinese only for now. New endpoints: `/api/env`, `/api/markets`, `/api/arena/usage`, `/api/arena/pools`, `/api/arena/run-events/:id`, `/api/events` (SSE), `/api/library`, settings, instructions, strategy and prompt-preview routes.

## 1.6.2 — paging on every list, refreshed docs

- "My portfolio" pages its recent fills, automatic activity and earlier reports; the leaderboard gets search and paging; the market watchlist pages after sorting. Pagers hide when everything fits on one page.
- Futu page no longer shows a stray currency placeholder; evidence sync results wrap inline.
- Rewritten USAGE, REACT_DASHBOARD and launch notes (zh / en) for the arena, scheduler, report centre and paging.

## 1.6.1 — clearer report layout

- Full reports show each part as its own panel: market view, actions (one row per stock with colour-coded buy / sell / hold / watch / cancel tags and per-type counts), picks, risks and next steps.

## 1.6.0 — report centre, paging and filters everywhere, dashboard polish

- Report centre (new page): every agent round report and every end-of-day digest, with search, market / account / stance / date filters, server-side paging and a detail pane. Deep links (`?view=reports&report=…`, `&tab=digests&digest=…`).
- Report and digest detail dialogs from "My portfolio", the account page and the digest panel. Digest detail: totals, best account of the day and a per-account breakdown that expands into fills, latest report and warnings.
- Account history tabs (orders, fills, events, reports, journal) and the automation run log are filtered (search, buy / sell, status / origin / kind, date range with presets) and paged on the server (`GET /api/arena/accounts/:id/history`, paged `/api/arena/reports`, `/api/arena/digests`, `/api/arena/runs/:id`). Evidence and research journal pages are paged too.
- Polish: compact report cards with "read full report"; intraday time labels on equity curves; prices with market decimals (A / US 2, HK 3); no chart watermark; stock badges use the company's first character; overview cards fill the row; long model names truncate; mobile top bar fits.

## 1.5.0 — whole-market stock picking, self-serve news, faster cadence, smoother dashboard

- `scan_market` MCP tool: rank the whole market by change, turnover value, turnover rate, volume ratio, 5-minute speed, main-fund inflow, amplitude or market cap; every A-share board (main, ChiNext, STAR, Beijing Stock Exchange, ST names), HK and US; industry / concept board rankings with leaders and board members.
- Beijing Stock Exchange (`.BJ`, 92xxxx / 8xxxxx / 4xxxxx) quotes, minute bars and trading rules (±30%, 100-share minimum then 1-share steps).
- Quotes: when Tencent is clearly fresher than Yahoo's ~15-minute-delayed A-share feed, it becomes the primary and a lagging second source counts as `fallback`, not a conflict. This was switching off `signalEligible` and stopping agents from trading.
- News: A-share / HK queries use East Money full-text search first (companies, themes, policy keywords), then the per-stock feed, then Yahoo. `get_news` tells agents to search the web themselves when it finds nothing. Headless Claude Code runs may use WebSearch / WebFetch and Codex runs get live web search (`runner.webSearch: false` turns it off); Kimi Code uses its built-in search.
- Arena skill and round prompt: pick from the whole market with `scan_market`, no board exclusions without a reason, bull / bear / stop line in every order reason, decisive sizing, no churn.
- Cadence: default agent rounds every 15 minutes in session (`defaultAgentIntervalMinutes`, minimum 5). Strategy runtime adds `ctx.intraday` (today's completed 1-minute bars with VWAP), `ctx.scan` and `ctx.sellable`; target-weight orders never sell T+1-locked shares. New built-in `intraday-momentum` strategy for 1–5-minute runs.
- Dashboard: ⌘K / Ctrl+K (or `/`) search across pages, arena accounts, securities and actions; workspace fullscreen and per-panel fullscreen for charts, leaderboard and holdings; stable scrollbar gutter, minimum heights and tabular numbers so filtering and tab switches no longer jump; reads serve stored state while the background matcher is ticking (account pages open in ~0.3 s instead of ~4 s).


## 1.4.1 — Kimi runner, East Money fallback, provider-compatible schemas

- East Money becomes the cross-check quote source and the news source whenever Yahoo Finance is blocked or rate-limited (A / HK / US; company names resolve to codes). Lagging HK snapshots fall back to single-source instead of a conflict. Only fetched when a primary source is missing; US exchange ids are cached.
- Scheduler runner for Kimi Code (`kimi -p`), using Kimi's own login and MCP registration; `kimi-code/` model prefix added when omitted.
- Tool schemas no longer use tuple-style `items` arrays, which Moonshot / Kimi rejects for every tool call.
- Arena skill: `signalEligible` is the data gate; missing news is reported, not a reason to stay in cash.


## 1.4.0 — production-ready unattended arena, scheduler and strategy runtime

- Long-running arena service (`--service`) with `npm run service:install | status | uninstall | run`: macOS LaunchAgent (KeepAlive), Linux systemd user service, Windows logon task. Heartbeat status in the dashboard; restarts itself when the plugin bundle changes instead of blocking the updater.
- Round scheduler: per-account, market-local run times on trading days only, 90-minute catch-up, one leader per arena dir, no overlapping runs, hard timeouts (process group kill), per-account run logs, unhealthy after repeated failures. Runners: Claude Code (`claude -p`, strict MCP config, only this plugin's tools allowed), Codex (`codex exec`, read-only sandbox, only this plugin's tools pre-approved, duplicate installed plugin disabled for the run), custom command templates, and in-process quant strategies.
- Strategy runtime (`mcp/strategies`): ES-module contract with params, completed-bars-only history, target weights → lot-sized sell-then-buy orders, idempotent per run, automatic round reports; built-in `ma-trend` and `momentum-rotation` examples; owner strategies loaded from `<storage>/strategies/*.mjs`.
- Broker layer (`mcp/brokers.mjs`): `paper` (the arena) and `advisory` (live markets: proposals pending human confirmation, never executed). No real-money execution adapter.
- Dashboard: account Automation tab (runner, model, times, budget, timeout, strategy params, run now, run log) and service status chip.
- Verified live on the US session: a scheduled strategy round and a fully autonomous headless Codex round (stock pool, orders with stops, report) through the service; LaunchAgent install, crash restart and uninstall on macOS.


## 1.3.0 — Agent Arena and multi-agent plugin

- Add the Agent Arena: a local paper exchange where every agent (Codex, Claude Code, WorkBuddy or any MCP client) trades its own virtual A-share, HK or US account on real public quotes.
- Enforce board lots (A-share 100 / STAR 200, HK lots from quotes, US 1 share), A-share T+1 and daily price limits, exchange tick sizes, regular sessions, slippage and retail fee schedules; long-only, cash-only.
- Resting limit orders with cash reservation, day/GTC expiry and fills on later syncs; idempotent client order ids; accounts bound to their MCP client (or `HROUTER_AGENT_ID`); cross-process locking so concurrent agents never lose writes.
- Eight `arena_*` MCP tools, server instructions and the portable `hrouter-agent-arena` skill. Metrics: total/today/annualized return, benchmark excess return, max drawdown, volatility, Sharpe, win rate, profit factor, fees, turnover, rejections, journal activity and per-strategy-version attribution, with small-sample warnings.
- Dashboard: new Agent Arena page with overlaid return curves, by-model / by-agent comparison, leaderboard, account detail (positions, orders, fills, decision journal, strategy versions, settings), account creation and an agent connection guide with copyable round prompts. Labelled synthetic arena in `--demo`.
- Ship Claude Code / WorkBuddy manifests (`.claude-plugin`, portable `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`) alongside the Codex manifest, a root Claude marketplace, and `npm run connect` for other MCP hosts. Codex now reads `.codex-plugin/mcp.json`; the updater patches both.
- Hands-off autopilot: agents keep their own stock pool (`arena_set_watchlist`, mirrored into the dashboard watchlist for the managed account) and publish a structured report every round (`arena_publish_report`). "My portfolio" now shows the agent-managed account — latest conclusion, holdings with buy reasons, recent trades, stock pool, equity and report history — and market-page holdings follow it. Choose the managed account with the `managedAccountId` preference (defaults to the most active account).
- Refresh the workspace shell: readable type scale (11px minimum, 14px body), light sidebar with Research / Paper trading groups, sticky top bar.
- Resolve the same data directory on Windows even when a host does not forward `LOCALAPPDATA`, so all agents share one arena.

## Unreleased (folded into 1.3.0) — React workspace and evidence-backed fundamental research

- Add an optional official Futu OpenD Python bridge and a React Paper trading page for actual HK/US SIMULATE accounts; no synthetic trading fallback or REAL path.
- Add six MCP tools for account discovery, bounded autonomous paper execution, cancellations, broker reconciliation and traceable strategy/quote records.
- Require UI-authorized strategies/limits; enforce durable idempotency, cash-only/long-only constraints, real quote freshness and unknown-response stops. No implicit scheduler or claimed paper performance.
- Add isolated SDK setup, offline broker contract tests and integration documentation.
- Replace the imperative dashboard with React 19, Radix Themes and Lucide React; locally bundle all scripts/styles with esbuild.
- Add a responsive research workspace with light/dark themes, bilingual navigation, independent market/holdings/evidence/journal pages and accessible editors.
- Retain real OHLC charting, freshness/quality gates and append-only records; keep currencies separate and unknown values missing.
- Add React rendering, presentation-contract and demo HTTP integration tests; make demo refresh respect saved watchlists and positions.

- Add deterministic financial evidence comparisons with period, accounting-basis, unit, scale and pre-disclosure estimate checks. Missing consensus is never replaced by guidance.
- Add falsifiable thesis pillars, append-only evidence-backed assessments and point-in-time scorecards without changing decision states or weakening candidate gates.
- Add sourced event-calendar queries with stable revision identity, cancellations, conflict flags and explicit evidence-coverage warnings; enhance dashboard event and thesis cards.
- Add the fundamental-research workflow skill, integration documentation and upstream workflow attribution/license. No commercial connectors or subscriptions are enabled.

## 1.2.1 - automatic market data failover

- Continue quote analysis, strategy selection and price alerts with a usable Yahoo or Tencent source when the other is unavailable; retain single-source warnings and block genuine cross-source conflicts.
- Fall back to Tencent daily history for indicators and historical research, validating OHLCV and aligning available adjusted prices by session date. Resolve US history symbols from Tencent metadata.
- Keep valid snapshots when history fails, and preserve freshness, corporate-action coverage and model qualification checks.

## 1.2.0 — managed automatic updates

- Opt-in, per-user auto-updater for stable GitHub Releases (macOS LaunchAgent, Linux user timer, Windows Scheduled Task), with manual status/check/disable/rollback controls.
- Complete-plugin updates verified with bounded downloads, SHA-256, safe file manifests and isolated MCP/dashboard health checks.
- Runtime leases defer replacement while a plugin process is alive; transaction recovery and a previous-version snapshot protect failed updates without touching report data.
- Explicit migration for existing installs; disabled/uninstalled or externally changed plugins are not automatically re-enabled.
- Cross-platform release validation and draft-first publication of a ZIP, update bundle, metadata and checksums.
- Automatic updating requires a one-time managed installation; publishing this version cannot retrofit old installations silently.


## 1.1.1

- Enumerate regression test files explicitly so the same test command works on Windows with Node.js 20 and newer.
- Select an available local dashboard port when an older plugin instance occupies the requested port; advertise the actual URL through MCP.

## 1.1.0

- Rebuilt the market dashboard with Chinese / English switching, sortable watchlists, holdings, financial charts, indicators, events and decision records.
- Added session calendars, quote-age and timestamp agreement checks, indicator warmup requirements, neutral flat RSI, and same-time intraday volume comparisons.
- Added currency and FX validation, existing holdings, remaining cash and aggregate position-risk constraints.
- Added persisted alert transitions, recovery and cooldown behavior.
- Added shared-capital historical simulation, A-share holding restrictions, execution assumptions and company-action processing.
- Added purged walk-forward evaluation, baseline comparisons, qualification gates and a forecast outcome ledger.
- Added official evidence adapters/imports, benchmark-relative context and append-only decision reviews.
- Added reproducible marketplace packaging, bilingual documentation, isolated demo data and cross-platform CI.

## 1.0.0

- Initial local research plugin with seven skills, quote cross-checking, deterministic indicators, evidence contracts and experimental research tools.
