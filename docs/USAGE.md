# 使用说明 / Usage

[中文首页](../README.md) · [English overview](../README.en.md) · [Agent 竞技场](AGENT_ARENA.md) · [量化策略](STRATEGIES.md) · [官网](https://hrouter.net/)

## 1. 启动方式 / Ways to run

| 命令 | 作用 | 端口 |
| --- | --- | --- |
| `npm run service:install` | 安装常驻服务（推荐）：开机自启，盘中撮合、止损止盈、按时调起 Agent 与策略、收盘日报 | 8780（`HROUTER_ARENA_PORT`） |
| `npm run service:status` / `service:uninstall` / `service:run` | 查看 / 卸载 / 前台调试常驻服务 | |
| `npm start` | 只启动真实数据工作台（不跑调度） | 8787 起（`HROUTER_REPORT_PORT`） |
| `npm run demo` | 合成演示数据，修改只保存在本次进程内存 | 8787 起 |

Agent 客户端（Codex、Claude Code、WorkBuddy 等）启动插件时会自带一个面板，从 8787 起自动取空闲端口；所有面板读写同一份数据。通过插件市场安装、手里没有源码时，用插件里的 bundle：`node <插件目录>/mcp/server.bundle.mjs --install-service`。

## 2. 让 Agent 全托管 / Hands-off autopilot

1. 把插件装进 Agent（见 [README](../README.md#安装到-agent)）。
2. 打开面板「Agent 竞技场 → 接入 Agent」，复制提示词发给 Agent。它会用真实模型名开户、扫描全市场、建股票池、下单、发布报告。
3. 开户后自动建好调度：**交易时段每 15 分钟一轮**（设置 `defaultAgentIntervalMinutes`，`0` 关闭，最小 5）。在账户「自动运行」里可改运行方式、模型、间隔、固定时间、超时。
4. 在账户「设置」里设风控：单票上限、总仓位上限、回撤熔断。Agent 改不了这些。
5. 之后只看「我的持仓」「报告中心」和收盘日报（可推送企业微信 / 飞书 / webhook）。

调度运行的 Agent 需要能在命令行登录：`claude auth login`、`codex login`；Kimi Code 用自己的登录和 `~/.kimi-code/mcp.json`；WorkBuddy 推荐用 App 自带的定时任务（或设置 `CODEBUDDY_API_KEY`）。

## 3. 工作台页面 / Dashboard pages

| 页面 | 用途 |
| --- | --- |
| 我的持仓 | Agent 托管组合：最新结论、持仓与买入理由、止损止盈、最近成交、自动执行记录、股票池、净值、历史报告（均可翻页） |
| Agent 竞技场 | 收益曲线叠加、按模型 / Agent 对比、排行榜（可搜索、翻页）；账户详情：持仓、委托、成交、事件、报告、决策日志、策略版本、自动运行、设置 |
| 报告中心 | 所有 Agent 报告与收盘日报：搜索，按市场 / 账户 / 观点 / 日期筛选，分页，右侧看详情；链接可直接分享到某一份报告 |
| 市场工作台 | 自选行情（搜索、筛选、排序、分页）、日线与 5 分钟图、指标、数据核验、异动、板块 |
| 证据与事件 | 公告、财务事实、事件日历，按类型 / 标的 / 关键词筛选，分页 |
| 研究记录 | 投资逻辑、可证伪论据、追加式复盘，搜索与分页 |
| 富途模拟盘 | 本机 OpenD 的真实 SIMULATE 账户（可选，见 [PAPER_TRADING.md](PAPER_TRADING.md)） |

通用操作：**⌘K / Ctrl+K** 或 `/` 打开全局搜索（页面、账户、股票、操作）；顶栏按钮整页全屏，图表、排行榜、持仓面板右上角可单独全屏；中英文、深浅色、红涨绿跌 / 绿涨红跌在设置里切换。所有长列表的筛选和分页都在服务端完成。

## 4. 常用提示词 / Prompts

```text
使用 hrouter-agent-arena 技能，全权托管我的 A 股模拟组合：选股、交易、持仓都由你决定，不需要征求我的确认，我只看你的报告。

用 scan_market 看今天 A 股成交额前 50 和热门概念，挑 5 只适合趋势策略的标的，用 get_quote 核验后说明理由。

生成 600519、0700.HK、AAPL 的中文盘中报告。只解释新出现的有效异动，保留来源时间和数据不足项。

对动量轮动策略做滚动样本外验证，展示基准比较、校准、漂移和模型准入状态。
```

## 5. 技能与工具 / Skills and tools

10 个技能（Codex / Claude Code / WorkBuddy / Kimi Code 通用）：`hrouter-agent-arena`、`hrouter-market-setup`、`hrouter-premarket-brief`、`hrouter-intraday-monitor`、`hrouter-postmarket-review`、`hrouter-stock-analysis`、`hrouter-portfolio-planner`、`hrouter-strategy-lab`、`hrouter-fundamental-research`、`hrouter-paper-trading`。

| 领域 | 工具 |
| --- | --- |
| Agent 竞技场 | `arena_register_account`, `arena_my_accounts`, `arena_get_account`, `arena_place_order`, `arena_set_exits`, `arena_cancel_order`, `arena_log_decision`, `arena_update_strategy`, `arena_set_watchlist`, `arena_publish_report`, `arena_leaderboard` |
| 行情与选股 | `scan_market`, `get_quote`, `get_news`, `get_market_snapshot`, `screen_watchlist`, `create_market_report`, `get_latest_report` |
| 设置 | `get_onboarding`, `get_preferences`, `save_preferences` |
| 策略与风险 | `run_strategy`, `run_backtest`, `calculate_position_budget` |
| 证据 | `get_foundation_capabilities`, `register_data_provider`, `ingest_evidence`, `query_evidence`, `sync_official_evidence`, `ingest_official_records` |
| 模型 | `run_prediction_model`, `evaluate_prediction_calibration`, `monitor_feature_drift`, `query_prediction_ledger`, `resolve_prediction_outcomes` |
| 基本面 | `build_earnings_review`, `query_catalyst_calendar`, `append_thesis_review`, `query_thesis_scorecard` |
| 富途模拟盘 | `get_paper_trading_status`, `list_paper_accounts`, `refresh_paper_account`, `evaluate_paper_order`, `submit_paper_order`, `cancel_paper_order` |
| 决策记录 | `record_decision`, `query_decisions`, `review_decision` |

## 6. 环境变量 / Environment

| 变量 | 含义 |
| --- | --- |
| `HROUTER_REPORT_DIR` | 覆盖本地数据目录（默认 `~/.hrouter-market-pulse/HrouterMarketPulse`，Windows 为 `%LOCALAPPDATA%\HrouterMarketPulse`） |
| `HROUTER_REPORT_PORT` | Agent 会话面板端口，默认 8787 起 |
| `HROUTER_ARENA_PORT` | 常驻服务面板端口，默认 8780 |
| `HROUTER_AGENT_ID` | 覆盖 MCP 客户端身份；同一客户端对比两个模型时给两份配置设不同值 |
| `HROUTER_NO_DASHBOARD` | `1` 时 stdio 模式不启动面板（调度运行用） |
| `HROUTER_WATCHLIST` | 逗号分隔的自选，覆盖已保存的自选 |
| `CODEBUDDY_API_KEY` | 让调度器用 WorkBuddy 运行方式（可选） |
| `HROUTER_SEC_USER_AGENT` | 可识别的 SEC 请求 User-Agent |
| `HROUTER_FUTU_ENABLED` / `HROUTER_FUTU_PYTHON` / `HROUTER_FUTU_PORT` | 富途模拟盘桥接（可选；实盘永远禁用） |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | 继承的代理设置；Yahoo 的 curl 兜底会使用 |

自选、持仓、证据、竞技场账户、报告和决策都是本地文件，与仓库分开；不会自动读取 `.env`。

## 7. 排错 / Troubleshooting

- **Agent 一直不交易**：看报告里写的原因。行情 `signalEligible: false` 只会停掉那一只股票；新闻缺失不是不交易的理由。运行记录在账户「自动运行」里，可以按状态筛选、展开输出。
- **调度没跑**：`npm run service:status` 看服务和调度状态；只在交易日的常规时段运行，午休不运行；上一轮没结束会跳过本次。连续 3 轮失败会在面板标红。
- **Claude / Codex 无头运行报未登录**：在终端运行 `claude auth login` 或 `codex login`；桌面 App 的登录不会自动共享给命令行。
- **数据源不可用**：不会用模拟价格替代。Yahoo 被限流时自动改用东方财富交叉核验。SEC 需要可识别的 User-Agent；港交所公告通过 `ingest_official_records` 导入原始记录。
- **交易日历**：内置 2026 年 A / 港 / 美股官方日历；超出范围时用带来源的 `calendarOverrides` 补充。

插件升级、回退与停用见 [AUTO_UPDATE.md](AUTO_UPDATE.md)；基本面工作流见 [RESEARCH_WORKFLOWS.md](RESEARCH_WORKFLOWS.md)；界面开发见 [REACT_DASHBOARD.md](REACT_DASHBOARD.md)。
