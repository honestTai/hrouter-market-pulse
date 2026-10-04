---
name: hrouter-paper-trading
description: Test an authorized HK/US strategy using actual Futu SIMULATE accounts and real market quotes. Use for 模拟交易、Agent 自动模拟下单、模拟盘策略验证、模拟委托核对. Allows autonomous paper orders inside the user-authorized policy; never real-money trading.
---

# Hrouter Autonomous Paper Trading

This is **actual Futu paper trading**, not an invented balance sheet or simulated screenshot. Never use a REAL account, unlock trading, collect login passwords, or call a broker through an alternate path to bypass tool gates.

## Before executing

1. Call `get_paper_trading_status`. The bridge and UI-authorized policy must be enabled. Read the exact account/market, symbols, board lots, entry/exit rules, revision and all limits. If disabled, explain setup and ask the user to authorize their own limits in the Paper trading menu. Do not choose/enable risk limits yourself or alter policy files/HTTP settings to grant yourself authority.
2. Call `list_paper_accounts` for the policy market and verify the exact SIMULATE account. Call `refresh_paper_account` for actual funds, holdings, orders and unresolved requests. Do not substitute the manually entered portfolio or demo report.
3. For an explicitly requested experiment, the agent may independently decide orders **within the authorized policy, without per-order confirmation**. Use `get_quote`, existing research/strategy tools and recorded evidence to explain the hypothesis. Experimental technical-rule paper execution is separate from live candidate/model qualification. Do not treat an unqualified model's hidden/rejected probability as an execution signal.
4. No fabricated/currently unavailable inputs: market-closed, stale, missing, conflicting, unverified-calendar or synthetic quotes block new orders. No blind market orders, short selling, leverage, options, or after-hours execution. The first integration supports HK and US stocks; A-share research is not A-share execution support.

## Autonomous order cycle

- Form one limit order with symbol, BUY/SELL, whole-share quantity, limit price and concise rationale. Stay inside the saved strategy and caps. Sells require actual sellable long holdings.
- Generate one stable `idempotencyKey` for this economic intent (8–80 letters/digits/_/-). Keep it unchanged across transport retries; do not assign a new key to an uncertain intent.
- `evaluate_paper_order` is an optional no-order preflight. `submit_paper_order` always rechecks real quotes, the saved entry/exit strategy, account data, cash, lots, per-order/position/daily limits and time again. It records the reason, full strategy version, policy revision, quote and broker response.
- `acknowledged` means the broker responded, **not that the order filled**. Reconcile with `refresh_paper_account`. Report broker status, actual filled quantity/average and account observations separately.
- On `unknown` or `dispatching`, stop new orders. Reconcile by broker order ID and the `hrouter:<intent-id>` remark. Never retry via a new idempotency key. If no order can be found, ask for manual Futu reconciliation; absence from today's order list is not proof no trade occurred.
- `cancel_paper_order` may cancel only plugin-originated SIMULATE orders with a stable cancellation key. A cancellation response is not proof of cancellation. Reconcile partial fills and terminal state. Pausing still permits cancellations; it does not cancel outstanding orders automatically.
- Keep at least 3 seconds between broker writes. Do not poll aggressively. Respect OpenD limits; no automatic mutation retry or synthetic failover.

## Evaluate honestly

Compare strategy/quote snapshots, blocked decisions, submitted orders, filled quantities, failures, open positions and account observations. Broker equity changes are unadjusted for deposits, resets, outside activity and strategy switches. Do not call them strategy alpha, realized profit or annualized return. The current order list is not a complete fill/fee ledger; do not invent win rates or fee-adjusted returns. Paper results are not real-money validation.

The plugin does not install a background trading loop or scheduler. Run a cycle in the current task when requested. Create recurring checks only when the user explicitly requests scheduling and gives scope/cadence; retain all paper-only and policy boundaries.

End with account market/currency, policy revision, quote timestamp/source warnings, strategy result, submitted/blocked/unknown state and next reconciliation step. Keep exact account IDs and detailed traces out of public article screenshots.
