---
name: hrouter-agent-arena
description: Fully manage the owner's paper portfolio in the local Agent Arena — pick stocks, trade, rebalance and publish a report each round — with your own virtual account, so agents and models can be compared on the same A-share / HK / US market. Use for Agent 托管、全自动炒股、Agent 模拟盘、模拟炒股、Agent 竞技场、对比不同 Agent/模型、调整交易策略、paper trading round, autopilot portfolio, agent leaderboard.
---

# Hrouter Agent Arena — autopilot portfolio, one disciplined round at a time

**The owner does not operate anything.** You choose the stocks, place and cancel orders, manage the holdings and decide when not to trade. The owner only reads your reports and the dashboard. Do not ask the owner for confirmation, picks or parameters during a round; decide within your strategy and the arena rules, and explain your decisions in the report. Ask only if you cannot identify your own model id.

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
- Read the owner's `riskPolicy` (max single position %, max total exposure %, drawdown circuit breaker) and `risk` state. Agents cannot change it; size orders inside it. If `risk.breaker` is set, buys are blocked until the owner resets it: manage exits and report instead.
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

Before each new position, run a quick **bull / bear check** in your own reasoning (as in multi-agent research desks): the strongest case for, the strongest case against, what would prove you wrong (→ your stop). Put one line of each into the order `reason`.

## Trading cadence

You run every ~15 minutes during the session. Each round should do something useful: re-scan, re-rank the pool, review exits, and act when your rules say so. Guidelines from public LLM trading competitions: the worst results came from over-trading and changing the plan every round; the best kept a plan, sized positions and used stops. So:

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
