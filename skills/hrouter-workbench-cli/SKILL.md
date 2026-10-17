---
name: hrouter-workbench-cli
description: Operate the owner's local stock workbench from the shell with the `market-pulse` command — list and create traders, read holdings and reports, ask a trader a question or give it an instruction or standing rule, confirm or reject orders waiting for approval, change limits and autonomy, start research tasks (deep dive, investor panel, market recap), read the market radar, dragon-tiger list and sentiment, manage skills and schedules. Use for 股票工作台、管理交易员、新建交易员、审批订单、确认订单、问交易员、给交易员下指令、研究任务、个股深度、投资人评审、市场雷达、龙虎榜、workbench CLI, manage my traders.
---

# Workbench CLI — do things in the stock workbench for the owner

`market-pulse` talks to the local workbench service (default `http://127.0.0.1:8780`). Everything the dashboard can do, the CLI can do. It is paper trading on real quotes; never present results as real returns.

## Find the command

1. Try `market-pulse status`.
2. If the command is missing, run the copy inside the plugin, `node <plugin>/cli/market-pulse.mjs status` (the plugin directory holds `mcp/server.bundle.mjs`). `node <plugin>/cli/market-pulse.mjs install` puts it on PATH.
3. If the workbench is not reachable, tell the owner to open the desktop app or run `npm run service:install`. Do not start a second service yourself.

Add `--json` whenever you need to parse the output. `market-pulse help` lists every command; `market-pulse api GET /api/...` reaches any endpoint the commands do not cover.

## Common tasks

| Owner asks | Run |
|---|---|
| How are my traders doing? | `market-pulse status`, `market-pulse traders`, `market-pulse trader "<name>"` |
| What did it buy and why? | `market-pulse orders "<name>" --kind trades`, `market-pulse reports --trader "<name>"`, `market-pulse report <rpt_id>` |
| Create a trader | `market-pulse new --market A --agent codex [--template a-share-swing] [--autonomy confirm]` (newest model and high effort by default; `market-pulse models` lists choices) |
| Ask it something | `market-pulse ask "<name>" "为什么昨天卖了招商银行？"` then read `market-pulse trader "<name>" --json` → `messages` |
| Tell it what to do | `market-pulse tell "<name>" "这周不碰半导体" --days 5` (expires) or `market-pulse rule "<name>" "单日涨幅超过 5% 不追"` (standing) |
| Orders waiting for confirmation | `market-pulse approvals`, then `approve <apr_id>` / `reject <apr_id> --note "…"` |
| Tighten risk | `market-pulse limits "<name>" maxPositionPct=15 maxIndustryPct=30`, `market-pulse autonomy "<name>" confirm` |
| Research | `market-pulse research new --kind deep-dive --symbols 600519`, `--kind investor-panel`, `--kind market-recap`, `--kind question --prompt "…"`; read with `research show <id>` |
| Market overview | `market-pulse radar`, `market-pulse emotion`, `market-pulse lhb [--symbol 600519]` |
| Something is stuck | `market-pulse schedules`, `market-pulse pools`, `market-pulse env`, `market-pulse resume "<name>"` |

Traders can be named by id (`acc_…`) or by part of their name; an ambiguous name lists the matches.

## Act for the owner, carefully

- Reading is always fine. For changes, do what the owner asked; confirm first when the request is vague and the change is hard to undo: approving or rejecting an order, archiving a trader, loosening limits, raising autonomy to `full`, deleting research or imported skills.
- Approving an order places it at the live price after every limit is re-checked; say what was placed (or why it was blocked) afterwards.
- Report back in the owner's language with the trader names and numbers you read, not guesses.

## Inside a trader's own round

If you are an arena trader in a scheduled round (`HROUTER_AGENT_ID` is set), this CLI is read-only: the service refuses every change from it. Trade and report through the MCP tools (`arena_place_order`, `arena_publish_report`, …) as the `hrouter-agent-arena` skill describes; you can never approve your own orders.
