# 使用 / Usage

[中文首页](../README.md) · [English overview](../README.en.md) · [官网 / Website](https://hrouter.net/)

## 启动 / Start

`npm start` runs the local real-data dashboard. `npm run demo` runs an isolated synthetic showcase. Both default to port 8787; choose another port with `HROUTER_REPORT_PORT` if it is occupied. The Codex plugin starts the same dashboard alongside its MCP server.

首次打开真实数据工作台后，在设置中保存自选股和语言，然后刷新行情。自选股为空时不会偷偷加入默认股票。界面语言可以随时切换；行情颜色约定单独保存。

## 工作台 / Workbench

- **自选行情 / Watchlist**: search by symbol or name, filter by market and holdings, sort by price or change, and select a row to inspect its chart.
- **日线与分时 / Daily and intraday**: daily indicators use completed daily bars; intraday data uses five-minute bars. A missing interval remains unavailable.
- **指标 / Indicators**: MA and RSI labels include their period. Intraday relative volume compares complete historical bars at the same local trading time, and remains unavailable without enough sessions.
- **数据状态 / Data quality**: quote time, report time, exchange timezone, freshness and source agreement are distinct fields. A closed-session reference is not a live signal.
- **公告与事件 / Evidence and events**: original sources, published dates, availability and explicit announced event dates remain attached to records.
- **决策记录 / Decision journal**: save the thesis, conditions, horizon and budget statement before reviewing an outcome. Reviews append to the original record.

## Codex prompts

```text
生成 600519、0700.HK、AAPL 的中文盘中报告。只解释新出现的有效异动，保留来源时间和数据不足项。

Use English. Compare my watchlist with its market benchmarks. Separate watchlist breadth from full-market breadth.

同步 AAPL 的官方公告和财务事实，列出本次成功和失败的数据源。

对这个策略做滚动样本外验证，展示基准比较、校准、漂移和模型准入状态。
```

Risk calculations require your capital, account currency, maximum loss per idea, total risk ceiling, position allocation ceiling, planned entry and invalidation prices, and applicable lot size. Existing holdings require quantity, market price, and invalidation price. Cross-currency calculations require a dated FX rate and its source.

## Tools

The nine skills cover setup, premarket, intraday, postmarket, stock analysis, portfolio planning, strategy validation, fundamental research, and autonomous paper trading. The MCP tools include:

| Area | Tools |
| --- | --- |
| Quotes and reports | `get_quote`, `get_news`, `get_market_snapshot`, `create_market_report`, `get_latest_report` |
| Settings | `get_onboarding`, `get_preferences`, `save_preferences` |
| Research and risk | `screen_watchlist`, `calculate_position_budget`, `run_strategy`, `run_backtest` |
| Evidence | `get_foundation_capabilities`, `register_data_provider`, `ingest_evidence`, `query_evidence`, `sync_official_evidence`, `ingest_official_records` |
| Models | `run_prediction_model`, `evaluate_prediction_calibration`, `monitor_feature_drift`, `query_prediction_ledger`, `resolve_prediction_outcomes` |
| Fundamental research | `build_earnings_review`, `query_catalyst_calendar`, `append_thesis_review`, `query_thesis_scorecard` |
| Actual paper trading | `get_paper_trading_status`, `list_paper_accounts`, `refresh_paper_account`, `evaluate_paper_order`, `submit_paper_order`, `cancel_paper_order` |
| Decisions | `record_decision`, `query_decisions`, `review_decision` |

## Environment

| Variable | Meaning |
| --- | --- |
| `HROUTER_FUTU_ENABLED` | Explicit opt-in (`1`) to the local Futu simulation bridge; REAL is always disabled |
| `HROUTER_FUTU_PYTHON` | Absolute path to Python in the optional SDK venv |
| `HROUTER_FUTU_PORT` | Loopback OpenD port, default 11111 |
| `HROUTER_REPORT_PORT` | Local HTTP port, default 8787 |
| `HROUTER_REPORT_DIR` | Override the local data directory |
| `HROUTER_WATCHLIST` | Optional comma-separated symbols; overrides saved watchlist |
| `HROUTER_SEC_USER_AGENT` | Your identifiable SEC request User-Agent, following SEC fair-access guidance |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | Inherited environment variables; the Yahoo curl fallback honors supported curl proxy settings. Native Node fetch does not guarantee proxy use on every supported Node version. |

On Windows, default storage is under `%LOCALAPPDATA%/HrouterMarketPulse`. Other systems use the user-local Hrouter directory. Preferences, evidence, monitor state, prediction records and decisions are local files, separate from the repository. The app does not automatically read `.env` files.

## Schedules

Codex scheduled tasks can run the premarket, intraday and postmarket skills. Supply markets, timezone, cadence and notification preferences explicitly. Local scheduled runs require the computer and Codex to remain running. A quiet poll should not produce a message or foreground the dashboard; failures that stop monitoring should be reported.

## Troubleshooting

An unavailable data source is not replaced with demo prices. Check the per-source error, network access and provider terms. For SEC, use an identifiable User-Agent and respect fair-access requirements. For HKEXnews, import original records through `ingest_official_records`; automated public scraping is not assumed. If a calendar is outside its covered year, update it with a sourced `calendarOverrides` record before using session-dependent signals.

Official synchronization processes at most five symbols per request, with at most three simultaneous symbol fetches and a 15-minute successful-result cache. Remaining symbols are explicitly returned as `deferred`; submit them in the next batch. Intraday quote refresh reads stored evidence without blocking on a new filings download.

The dashboard is local-only. A static copied HTML report requires its assets and server routes for interactions; use the release package or running dashboard for the full experience.

## 插件升级 / Plugin upgrades

For opt-in background upgrades, migration from older installations, disabling, rollback, and publisher release instructions, see [AUTO_UPDATE.md](AUTO_UPDATE.md). Quote refresh controls in the dashboard refresh market data, not installed application code.

## Fundamental research / 基本面研究

See [财报变化、投资逻辑卡与事件日历](RESEARCH_WORKFLOWS.md) for workflows, source contracts, limitations and examples. New tools consume sourced evidence; they neither subscribe to commercial datasets nor authorize trades.

## React workspace / React 面板

左侧导航切换市场、持仓、证据事件与研究记录；窄屏使用顶部菜单。顶栏切换中英文、深浅色，设置弹窗管理自选、持仓与涨跌配色。保存设置后点击“更新行情”加载新增自选；自动更新默认关闭，仅在页面可见时轮询，不创建后台定时任务。

持仓按 CNY/HKD/USD 分币种汇总，缺失价格或币种不匹配时不估值。证据保留来源、发布时间与可得时间；预计事件明确标注。新建研究记录可添加可证伪论据，复盘只追加，不改写原始判断，也不绕过候选准入门槛。

演示模式全部为合成样本，仅在当前服务进程内存中保存修改。开发入口和验证方法见 [REACT_DASHBOARD.md](REACT_DASHBOARD.md)。

## Actual paper trading / 真实模拟盘

See [PAPER_TRADING.md](PAPER_TRADING.md). Authorize a bounded experiment in the Paper trading menu, then the agent can independently use paper execution tools without per-order confirmation. This is neither synthetic demo mode nor permission to trade real funds.
