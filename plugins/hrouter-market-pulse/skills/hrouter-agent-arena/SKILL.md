---
name: hrouter-agent-arena
description: Run one paper-trading round in the local Agent Arena with your own virtual account, so different agents and models can be compared on the same A-share / HK / US market. Use for Agent 模拟盘、模拟炒股、Agent 竞技场、对比不同 Agent/模型的炒股表现、调整交易策略、paper trading round, agent leaderboard.
---

# Hrouter Agent Arena — one disciplined trading round

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
- Check the market session: market orders are rejected outside regular hours. Outside hours you may analyse and place **limit** orders that rest until the session opens, or log a no-trade decision.
- Re-read your strategy (`strategy.summary`, version). Follow it. If you want to change it, call `arena_update_strategy` with a `changeNote` **before** trading on the new rules, so performance is attributed to the right version.

## 3. Research

Use the plugin's research tools as evidence, not decoration: `get_quote` (freshness, cross-check, indicators), `screen_watchlist`, `get_news`, `run_strategy`, `query_evidence`. Prefer fresh, cross-checked quotes. Do not invent prices, news or fundamentals. Respect the data-quality warnings the tools return.

## 4. Act — or deliberately don't

- Trade with `arena_place_order`. Quantities are **shares**, in board-lot multiples (A-share 100; STAR market minimum 200; HK per-stock lot from the quote; US 1). Long-only: you can sell only shares you hold and that are sellable (A-share shares bought today unlock next session).
- Always pass a specific `reason` (signal, thesis, sizing, exit plan) and, where meaningful, `confidence` (0–1) and `horizon`. Use a stable `clientOrderId` so a transport retry never doubles an order.
- A response with `status: rejected` explains why (lot size, cash, T+1, limit-up/down, session). Fix the cause; do not spam variants. Rejections are counted in the leaderboard as a discipline signal.
- `status: open` means a resting limit order, not a fill. Check later with `arena_get_account`; cancel with `arena_cancel_order` if the thesis no longer holds.
- If nothing meets your rules, call `arena_log_decision` with `kind: "no-trade"` and the reason. Skipping a trade is a valid, recorded decision.

## 5. Report

End the round with: account id, market session status, actions taken (filled / open / rejected with reasons), cash and equity after the round, total return vs the benchmark from `metrics`, and what you will watch next round. Mention `sampleWarning` when the track record is still short — a few days or a handful of closed trades cannot show that one agent or model is better.

## Boundaries

- Virtual money only. This skill never touches real broker accounts. For actual Futu SIMULATE accounts use `hrouter-paper-trading` instead.
- Trade only your own account. Do not archive, reset or re-fund accounts; the user does that in the dashboard.
- Run one round per request. Create recurring rounds only when the user explicitly asks for a schedule in their agent app (Codex automations, Claude Code scheduled tasks, WorkBuddy automations).
