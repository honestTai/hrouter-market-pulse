<div align="center">

# HRouter Market Pulse

**Let your AI agents run a paper portfolio end to end — stock picking, trading and holdings — while you read the reports.**

[中文](README.md) · [English](README.en.md) · [Releases](https://github.com/honestTai/hrouter-market-pulse/releases/latest) · [Changelog](CHANGELOG.md) · [HRouter](https://hrouter.net/home)

</div>

A stock-research and paper-trading plugin for **Codex, Claude Code, Kimi Code, WorkBuddy** and any MCP client. China A-shares, Hong Kong and US equities. Everything is stored on your machine, and every agent shares the same records.

- **Agent Arena**: one virtual account per agent and model, trading side by side on real quotes under real exchange rules; compare return, drawdown and discipline.
- **Hands-off**: agents scan the whole market, pick stocks, place orders, set stops and write reports; a resident service runs agents and quant strategies on schedule and publishes an end-of-day digest.
- **Research workspace**: cross-checked quotes, market scanner, filings evidence, backtests and decision reviews.

![Agent Arena: overlaid return curves and comparison (synthetic demo data)](docs/images/arena-zh.png)

> Screenshots use labelled **synthetic test data**; the workbench itself only uses live quotes and real records. Paper trading uses virtual money; results are not real returns and not investment advice.

## Features

### Agent Arena (paper trading)

| Area | What you get |
| --- | --- |
| Many agents, one exchange | Codex, Claude Code, Kimi Code, WorkBuddy and quant strategies each open accounts; ranked per market and group; compare by model or by agent |
| Real rules | A-share T+1, price limits and board lots (STAR 200 then 1-share steps, Beijing 100 then 1-share steps), HK board lots, US single shares; tick sizes, retail fees, slippage, volume caps, suspensions, dividends and splits |
| Whole-market picking | `scan_market` ranks the main board, ChiNext, STAR, the Beijing Stock Exchange and ST names (plus HK and US) by turnover, 5-minute speed, main-fund inflow, change, volume ratio and more, and lists hot industry / concept boards and their members |
| Limits | Enforced before every buy: keep cash (20% by default), max holdings, per-position cap, new positions / buy orders per day, risk per trade, cooldown, excluded boards, minimum price, no chasing, drawdown breaker; editable in the UI and over MCP, lockable by the owner (an agent's change to a locked item becomes a request); stops and targets watched in the background |
| Fills | At Tencent's five-level bid / ask (walking the book for size); limits and stops checked against 1-minute bars; per-market fee schedules; every fill keeps its data snapshot |
| Metrics | Total / day / annualized return, excess vs CSI 300 / HSI / S&P 500, max drawdown, Sharpe, win rate, profit factor, turnover, rejections, attribution by strategy version, small-sample warnings |
| Reports | A mandatory report every round (conclusion, actions, picks, risks, next steps); end-of-day digests pushed to WeChat Work, Feishu or any webhook |

### Unattended operation

| Area | What you get |
| --- | --- |
| Resident service | `npm run service:install` (macOS LaunchAgent, Linux systemd user service, Windows logon task); restarts on crash and on plugin updates; keeps running when you quit your agent app |
| Scheduler | Per account: every N minutes in session plus fixed times; **the agent is the director**: it writes its own code strategy (sandboxed, dry-run and backtested before going live) and reviews every 10 minutes by default (minimum 5), code strategies down to 1 minute; 90-minute catch-up, no overlapping runs, hard timeouts |
| Runners | Claude Code, Codex, Kimi Code (streamed, with per-round process and token usage), WorkBuddy, ACP agents (Gemini CLI, OpenCode, …), built-in strategies, custom commands; quota failures pause the login and hand over to a backup agent; global concurrency cap; only this plugin's tools are attached |
| Self-serve news | When the plugin's feeds come up empty, scheduled agents search the web themselves (Claude WebSearch, Codex web search, Kimi's built-in search) instead of stalling |

### Quant strategies

- A strategy is an ES module that receives the account, its universe, **completed** daily bars only, today's minute bars with VWAP and a market scan, and returns target weights or orders. The runtime turns them into whole-lot orders, sells before buying, never sells T+1-locked shares and is idempotent per run.
- Built-in examples: `ma-trend`, `momentum-rotation` and `intraday-momentum` (whole-market intraday momentum for 1–5-minute runs). Drop your own into `<data dir>/strategies/*.mjs`. See [STRATEGIES.md](docs/STRATEGIES.md).
- Execution goes through a broker: `paper` (the arena) or `advisory` (live-market proposals that need human confirmation — **no real order is ever sent**).

### Workbench UI

Same design system as the HRouter video workbench. Each agent is a "trader": its account, agent and backup agent, prompts, limits, fees, strategy and cadence are managed on the trader page.

| Page | Contents |
| --- | --- |
| Home | Today's leader, beat-benchmark count, fills / blocked orders, token usage; things that need you (locked-item requests, config pauses, exhausted quotas); running now |
| Traders | New trader (market, style template, agent, prompts and limits, cadence); trader page with timeline, instructions, portfolio and limit usage, strategy versions and rollback, settings, reports, orders and fills, change log |
| Arena | Overlaid curves, leaderboard with token cost, comparison by model / agent / style |
| Market · Research · Reports | Watchlist and charts, data checks; evidence and journal; trader reports and daily digests |
| Strategies · Skills | Agent-written code strategies and built-ins; built-in trader skills and templates (sources and licenses) |
| Schedule · Settings | Schedules and quota pools; environment check, agents (CLI / ACP, concurrency cap), global and market prompts, fees and locks, push, Futu paper |

- **⌘K / Ctrl+K** search; long lists are filtered and paged on the server; runs stream live over SSE.
- The UI is Chinese-only for now; light / dark and red-up / green-up are switchable. See [WORKBENCH_UI.md](docs/WORKBENCH_UI.md).

> Screenshots below show the previous UI and will be refreshed.

![Report centre (synthetic demo data)](docs/images/reports-zh.png)

<details><summary>More screenshots</summary>

![English market workspace](docs/images/dashboard-en.png)
![Agent-managed portfolio](docs/images/portfolio-zh.png)
![Filtered, paged fills](docs/images/account-zh.png)
![⌘K search](docs/images/palette-zh.png)
![Dark mode](docs/images/arena-dark.png)

</details>

### Data

- Quotes: Tencent realtime cross-checked with Yahoo Finance, East Money when Yahoo is unavailable; the fresher source wins for A-shares (Yahoo's A-share quotes lag ~15 minutes). Each quote carries freshness, session and cross-check status; `signalEligible` is the single data gate for trading.
- News: East Money full-text search first for A-share / HK (companies, themes, policy keywords), Yahoo first for US.
- Filings: SEC and CNINFO adapters plus raw exchange-announcement import, with sources and first-seen times.

## Quick start

Node.js 20+.

```bash
git clone https://github.com/honestTai/hrouter-market-pulse.git
cd hrouter-market-pulse
npm ci && npm run build
npm run service:install
```

Open <http://127.0.0.1:8780/>, then:

1. Install the plugin into your agent (below) and create a trader under "Traders" (or send your agent the connect prompt). It opens an account, writes a strategy, picks stocks, trades and reports; by default it reviews every 10 minutes in session.
2. Tune prompts, limits and fees under the trader's Settings and, optionally, a push webhook under Settings → Push.
3. From then on, read Home and Reports.

Desktop app for macOS / Windows: `npm --prefix desktop ci && npm run build:desktop`, see [WORKBENCH_UI.md](docs/WORKBENCH_UI.md#桌面客户端--desktop-app).

The UI is in Chinese by default; switch to English in Settings → General → Language.

## Install into your agent

| Agent | Install |
| --- | --- |
| Codex | Download the ZIP from [Releases](https://github.com/honestTai/hrouter-market-pulse/releases/latest), unzip and run `node scripts/install.mjs --auto-update` ([details](docs/AUTO_UPDATE.md)); or `codex plugin marketplace add honestTai/hrouter-market-pulse` |
| Claude Code | `claude plugin marketplace add honestTai/hrouter-market-pulse`, then `claude plugin install hrouter-market-pulse@hrouter-market-pulse` |
| WorkBuddy | Settings → Plugins → add marketplace `https://github.com/honestTai/hrouter-market-pulse`, install and enable |
| Kimi Code | Register `node <plugin dir>/mcp/server.bundle.mjs --stdio` in `~/.kimi-code/mcp.json` and copy `skills/` to `~/.kimi-code/skills/` |
| Other MCP clients | `npm run connect -- cursor` (etc.) prints a config to paste |

All clients share one data directory (`~/.hrouter-market-pulse/HrouterMarketPulse` by default, `%LOCALAPPDATA%\HrouterMarketPulse` on Windows). See [AGENT_ARENA.md](docs/AGENT_ARENA.md).

## Command line: `market-pulse`

For you and for any agent working for you (Claude Code, Codex, Kimi…): everything the dashboard does, from the shell. It is installed with the background service, or run `npm run cli:install` (puts it in `~/.local/bin`).

```bash
market-pulse status
market-pulse new --market A --agent codex --autonomy confirm
market-pulse ask "Kimi K3" "Why did you buy China Merchants Bank yesterday?"
market-pulse approvals          # then approve / reject <apr_id>
market-pulse research new --kind deep-dive --symbols 600519
market-pulse radar
```

Add `--json` for machine-readable output; `market-pulse help` lists every command. Called from inside a trader's own round it is read-only. The `hrouter-workbench-cli` skill teaches agents how to use it.

## Boundaries

- **Only paper accounts trade automatically.** Live markets get advisory proposals that a human confirms; there is no real-money execution path. Futu SIMULATE accounts need separate authorization ([PAPER_TRADING.md](docs/PAPER_TRADING.md)).
- Public quotes can be delayed or rate-limited; missing data is shown as missing, never filled with simulated prices. Simulated fills differ from a broker's.
- A few days of returns mostly reflect luck; the leaderboard flags small samples. Method and assumptions: [METHODOLOGY.md](docs/METHODOLOGY.md).

## Development

```bash
npm ci
npm run build
npm test
npm run check && npm run smoke
```

UI: React 19 + TypeScript + Vite + Tailwind CSS in `web/` (`npm run build:ui`, see [WORKBENCH_UI.md](docs/WORKBENCH_UI.md)); TradingView Lightweight Charts; built-in trader skills in `library/`; everything is bundled locally, no CDN. MIT licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Built by **honestTai**, who also runs [HRouter](https://hrouter.net/home), a model-access service for AI coding and apps. The plugin uses the model of the agent you run it in. **Star the project if it helps, and share ideas in [Issues](https://github.com/honestTai/hrouter-market-pulse/issues).**
