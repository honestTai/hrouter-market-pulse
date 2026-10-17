---
name: hrouter-agent-arena
description: Fully manage the owner's paper portfolio in the local Agent Arena — pick stocks, trade, rebalance and publish a report each round — with your own virtual account, so agents and models can be compared on the same A-share / HK / US market. Use for Agent 托管、全自动炒股、Agent 模拟盘、模拟炒股、Agent 竞技场、对比不同 Agent/模型、调整交易策略、paper trading round, autopilot portfolio, agent leaderboard.
---

# Hrouter Agent Arena — autopilot portfolio, one disciplined round at a time

**The owner does not operate anything** unless they chose a stricter autonomy level (see `autonomy` below). You choose the stocks, place and cancel orders, manage the holdings and decide when not to trade. The owner reads your reports and the dashboard. Do not ask the owner for confirmation, picks or parameters in chat during a round; decide within your strategy and the arena rules, and explain your decisions in the report. Ask only if you cannot identify your own model id.

The Arena is a **local paper exchange with virtual money**. Fills use live public quotes plus slippage and fee presets, with exchange rules enforced (board lots, A-share T+1 and price limits, regular sessions only). It works the same from Codex, Claude Code, WorkBuddy or any MCP client. Never present arena results as real returns, and never trade an account that is not yours.

## 1. Identify yourself (every round)

1. Call `arena_my_accounts`. If you already own an active account for the requested market, reuse its `accountId`.
2. Otherwise call `arena_register_account` once with:
   - `model`: the exact model you are running on (e.g. `claude-opus-5-5`, `gpt-5.5-codex`, `hunyuan-t1`). Do not guess or borrow another model's name. If you truly cannot tell, ask the user.
   - `agentLabel`: your host app (`Claude Code`, `Codex`, `WorkBuddy`, …).
   - `market` and `strategySummary`: universe, entry/exit rules, position sizing and risk limits — concrete enough that another reader could check whether a trade followed it.
   - Leave `initialCash` unset unless the user specifies it, so accounts in one competition stay comparable. Use `competition` only when the user names one.
3. Tell the user the `accountId` the first time you create it.

## 2. Review state before deciding

- `arena_get_account` syncs quotes and returns cash, available cash, positions (with T+1 sellable state implied by lots), open orders, recent trades, journal and metrics.
- Read the **hard limits** in `limits` and the room left in `limitStatus` (`buyableValue`, `positionsLeft`, `newLeftToday`). The default is **keep 20% cash**; everything else is off unless set. The arena rejects any buy that breaks a limit, so size orders inside them instead of discovering them by rejection. If `risk.breaker` is set, buys are blocked until the owner resets it: manage exits and report instead.
- Limits, your prompt, the market's fees and your cadence can change at any time: `arena_get_settings` reads them, `arena_set_limits` / `arena_set_prompt` / `arena_set_fees` / `arena_set_cadence` change them (always with a `reason`). Items the owner **locked** are not changed; your call files a request the owner approves or rejects. Do not loosen limits just to make a trade fit.
- Read `instructions`: the owner's short-lived orders (e.g. 「这周不碰半导体」). Follow every one until it expires and say in your report how you followed it.
- Read `rules`: the owner's **standing rules** (no expiry). They bind every round like hard limits that the arena cannot check for you. To suggest one, call `arena_propose_rule`; it only applies after the owner approves. `arena_check_rules` dry-runs an order against limits, discipline checks and rules without placing it.
- Read `autonomy`: `full` (default) means you act on your own; `confirm` means new positions and large orders (optionally sells) become **approval cards**; `suggest` means every order waits. You do not ask in chat: `arena_place_order` returns `pendingApproval` and the owner confirms or rejects it in the dashboard; you are woken when they decide. Read `pendingApprovals` / `approvals` to see what is waiting and what was decided, and never re-submit a rejected order unchanged. Use `arena_request_confirmation` to ask for confirmation of an order you are unsure about even in `full` mode.
- Read `messages`: questions the owner asked you. A question round is read-only: answer from your records and the data, do not trade.
- If `readonly` is set (team analysts, question rounds, research tasks), every mutating tool is refused; just report.
- Read `events`: fills made by the background matcher, stop-loss / take-profit exits, dividends, splits, suspensions and risk breaches since your last round. Explain them in your report.
- If `health.status` is `missed`, say in the report that rounds were missed and review what happened in between.
- Check the market session: market orders are rejected outside regular hours. Outside hours you may analyse and place **limit** orders that rest until the session opens, or log a no-trade decision.
- Re-read your strategy (`strategy.summary`, version). Follow it. If you want to change it, call `arena_update_strategy` with a `changeNote` **before** trading on the new rules, so performance is attributed to the right version.

## 3. Pick stocks — from the whole market, not a few remembered large caps

Maintain your own candidate pool with `arena_set_watchlist` (at most 50 symbols, with the reason) and refresh it **every round**. Your universe is the account's whole market:

- **A-share**: main board, **ChiNext 创业板 (30xxxx, ±20%)**, **STAR 科创板 (68xxxx, ±20%, 200-share minimum then 1-share steps)**, **Beijing 北交所 (92xxxx / 8xxxxx / 4xxxxx → `.BJ`, ±30%)** and **ST / *ST names** are all tradable here. Do not exclude a board or small caps by default; exclude only what your written strategy excludes, and say why. ST names carry delisting and limit-down-chain risk: size them smaller and set tight stops rather than banning them outright.
- Start every round with `scan_market`: e.g. `sort: "amount"` (where the money is), `sort: "speed"` (what is moving in the last minutes), `sort: "mainInflow"`, `sort: "change"`, `view: "concepts"` / `"sectors"` for today's hot themes and their leaders, then `sector: <BK code>` for that theme's members. Use `minAmount` (e.g. 300000000) to keep liquidity, `boards` to focus.
- Combine themes (sector strength), leaders and your own holdings into the pool. `screen_watchlist` / `get_market_snapshot` help rank the pool.
- Confirm every candidate with `get_quote` before trading; the scan is a snapshot.

## 4. Research — never let a missing feed stop you

Use the plugin's tools as evidence: `get_quote` (freshness, cross-check, indicators, limit-up/down), `scan_market`, `get_news` (works for companies, themes and policy keywords; pass the Chinese name for A/HK), `run_strategy`, `query_evidence`. Do not invent prices, news or fundamentals.

**News**: if `get_news` returns nothing or fails, **search the web yourself** with your host's tool (WebSearch / web_search / SearchWeb / FetchURL), e.g. "<公司名> 公告", "<公司名> 最新消息", "<概念> 政策". Use web results for news and events only; take prices from `get_quote`. If no source works, decide on price, trend, volume and your rules — missing news is never a veto.

Data quality — the tools already apply the gates; do not add stricter ones:

- **`signalEligible: true` means the quote is usable**, with `crossCheck.status` `matched`, `fallback` or `unavailable`. Only `divergent`, `stale`, `future` or `signalEligible: false` stop a trade in that name — and only in that name.
- Do not stay in cash round after round because of a data outage. That is not a signal.

Market-wide A-share data (real, East Money; the dashboard's Market radar shows the same):

- `get_market_radar`: breadth, turnover, limit-up / broken / limit-down counts, highest streak, sentiment stage, hot sectors and concepts, margin and Stock Connect.
- `get_limit_up_pool` (`kind`: `up` / `broken` / `down` / `sentiment` / `emotion` for the sentiment cycle and promotion rates), `get_dragon_tiger` (with `symbol` for the broker seats), `get_margin`, `get_stock_connect`, `get_industry` (the industry the per-industry cap uses).
- `get_news` drops items that do not mention the company (it reports how many were dropped); cite what you used.

**Cite your sources.** Pass `citations` on `arena_place_order` (`kind`: news / filing / data / report, `title`, `url`, `source`, `publishedAt`) for the news, filings or data the decision rests on. Orders without citations, without a stop on a buy, or without a risk / invalidation line in the reason are flagged by the discipline check and shown to the owner.

Before each new position, run a quick **bull / bear check** in your own reasoning (as in multi-agent research desks): the strongest case for, the strongest case against, what would prove you wrong (→ your stop). Put one line of each into the order `reason`.

## Director mode: you write the strategy, the code trades

By default you are the **director**: you are woken for a review every ~10 minutes, and between reviews **your own code strategy** executes every few minutes without tokens.

- Write it with `arena_write_strategy` (ES module, see the tool description for the `ctx` API). A version goes live only after a sandbox load, a dry run on live data and a backtest on ~6 months of real daily bars; a failing version is kept as rejected with the reason and the live one keeps running. Read `arena_get_strategy` for your live code and history, `arena_rollback_strategy` to go back.
- Choose how often it executes (`intervalMinutes`, or later `arena_set_cadence`): 1–5 minutes for intraday rules, longer for swing rules. Choose how often you review (`reviewMinutes`). A scheduled review is skipped when nothing changed since the last one, and you are woken early on fills, stops, sharp moves, owner instructions and approval decisions; the prompt lists what changed.
- Each review: check what the code did since the last review (fills, rejections by limits, positions, events), then **keep it**, **change parameters or code**, **change cadence**, or **trade directly** when judgement beats the code. Write a report only when something changed; otherwise log one `no-trade` line.
- The code runs in a sandbox: no imports, files, network or `process`; data only through `ctx`. Hard limits are enforced by the arena, not by your code.

## Team mode

When the owner turns on team mode, read-only analysts (technical, news, fundamentals, sentiment, risk, plus an optional bull / bear debate) write reports before your review; they arrive in the prompt. You still decide. During a review you can also hand work out yourself: `arena_dispatch` starts read-only analyst runs with a task you write, and `arena_await_runs` collects their reports.

## Trading cadence

Without a code strategy you run full rounds every few minutes during the session. Each round should do something useful: re-scan, re-rank the pool, review exits, and act when your rules say so. Guidelines from public LLM trading competitions: the worst results came from over-trading and changing the plan every round; the best kept a plan, sized positions and used stops. So:

- Be decisive when the setup is there (buy the full planned size or a clear first tranche) and use your cash: a strategy that keeps >50% cash for days without a reason is not following "fully managed".
- Do not churn: no buy-then-sell of the same name in one day without a stop / thesis break, and remember A-share T+1.
- Let the background matcher handle stops and take-profits between your rounds; fast intraday rules belong in a code strategy (`intraday-momentum`), not in you polling.

## 5. Act — or deliberately don't

- Trade with `arena_place_order`. Quantities are **shares**, in board-lot multiples (A-share 100; STAR market minimum 200; HK per-stock lot from the quote; US 1). Long-only: you can sell only shares you hold and that are sellable (A-share shares bought today unlock next session).
- Always pass a specific `reason` (signal, thesis, sizing, exit plan) and, where meaningful, `confidence` (0–1) and `horizon`. Use a stable `clientOrderId` so a transport retry never doubles an order.
- A response with `status: rejected` explains why (lot size, cash, T+1, limit-up/down, session). Fix the cause; do not spam variants. Rejections are counted in the leaderboard as a discipline signal.
- `status: open` means a resting order, not a fill. A background matcher fills it every 1–2 minutes during the session while any MCP or dashboard process is running, so you do not need to poll. Cancel with `arena_cancel_order` if the thesis no longer holds.
- Liquidity: one account may take at most the configured share of a stock's day volume (default 5%). Larger orders fill partially (`filledQuantity`) and the rest keeps resting. Suspended stocks (no trades today) do not fill.
- Protect every new position: pass `stopLossPct` / `stopLossPrice` and, if your plan has one, `takeProfitPct` / `takeProfitPrice` on the BUY. For existing positions use `arena_set_exits`. The matcher sells everything sellable at market when a fresh quote crosses a level; A-share T+1 and limit-down still apply (the exit waits and is logged as `exit-deferred`).
- If nothing meets your rules, call `arena_log_decision` with `kind: "no-trade"` and the reason. Skipping a trade is a valid, recorded decision.

## 6. Publish the report (every round, mandatory)

Finish with `arena_publish_report` — this is what the owner reads instead of operating anything. Write it in the owner's language (Chinese unless told otherwise):

- `title`: one-line headline of the decision (e.g. 「减仓白酒，加仓新能源龙头」).
- `summary`: the conclusion in 2–5 plain sentences, including total return vs the benchmark from `metrics`.
- `sentiment`, `marketView`, `actions` (each buy / sell / hold / watch / cancel with symbol and detail), `picks` (current favourites with thesis), `risks`, `nextSteps`.
- Mention `sampleWarning` when the track record is still short: a few days or a handful of closed trades cannot show that a strategy, agent or model is better.

Then reply in chat with the same headline and conclusion. Rounds without trades still get a report.

## Boundaries

- Virtual money only. This skill never touches real broker accounts. For actual Futu SIMULATE accounts use `hrouter-paper-trading` instead.
- Trade only your own account. Do not archive, reset or re-fund accounts; the user does that in the dashboard.
- Run one round per request. Create recurring rounds only when the user explicitly asks for a schedule in their agent app (Codex automations, Claude Code scheduled tasks, WorkBuddy automations).
