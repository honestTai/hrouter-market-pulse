// MCP surface of the Agent Arena. Tool names and arguments are client-neutral so the same
// workflow runs in Codex, Claude Code, WorkBuddy or any other MCP host.
import { z } from "zod";
import { ARENA_MARKETS, callerFromClient, getArena } from "./arena.mjs";
import { createScheduler } from "./scheduler.mjs";
import { loadPreferences, marketFromSymbol, savePreferences } from "./core.mjs";
import { BOARD_OPTIONS, DEFAULT_FEES, LIMIT_SPECS, limitsText } from "./trader-settings.mjs";
import { createTraderStrategyStore, rollbackTraderStrategy, traderStrategyId, writeTraderStrategy } from "./trader-strategies.mjs";
import { loadLibrary, starterStrategyCode, templateDefaults } from "./skill-library.mjs";

const STRATEGY_API = [
  "Write an ES module: export default { id, name, version, markets, description, params: { key: { type: 'integer'|'number'|'boolean'|'enum'|'symbols', default, min, max, label } }, async run(ctx) { … } }.",
  "ctx: now, market, account (cash, positions with lots, metrics.equity), params (validated), universe (your stock pool),",
  "await ctx.history(symbol, { days }) → completed daily bars oldest first ({ sessionDate, open, high, low, close, volume }); await ctx.quote(symbol) → live quote (price, bid, ask, changePct, signalEligible);",
  "await ctx.intraday(symbol) → today's completed minute bars ({ time, price, volume, vwap }); await ctx.scan({ sort, boards, minAmount, limit }) → whole-market ranking; ctx.sellable(symbol); ctx.log(text); ctx.indicators.sma(values, n).",
  "Return { targets: [{ symbol, weight 0–1, reason }] } or { orders: [{ symbol, side, quantity, reason }] }, optionally exits: { stopLossPct, takeProfitPct } for new buys and report: { title, summary }.",
  "No imports, require, process, fetch or eval: the code runs in a sandbox with only ctx for data. Hard limits are enforced by the arena, not by your code.",
].join(" ");

const accountId = z.string().regex(/^acc_[a-f0-9]{12}$/).describe("Arena account id (acc_…) returned by arena_register_account or arena_my_accounts.");
const market = z.enum(["A", "HK", "US"]);

const exitFields = {
  stopLossPrice: z.number().positive().optional().describe("Protective stop: sell everything sellable at market when a fresh quote trades at or below this price."),
  stopLossPct: z.number().positive().max(95).optional().describe("Protective stop as % below the average cost (e.g. 8 = cost × 0.92). Use price or pct, not both."),
  takeProfitPrice: z.number().positive().optional().describe("Take profit: sell at market when a fresh quote trades at or above this price."),
  takeProfitPct: z.number().positive().max(1000).optional().describe("Take profit as % above the average cost (e.g. 20 = cost × 1.2)."),
};

function compactAccount(account) {
  const { metrics } = account;
  const flags = [
    account.health?.status === "missed" ? `MISSED ${account.health.missedTradingDays} trading day(s)` : null,
    account.risk?.breaker ? `RISK BREAKER TRIPPED (${account.risk.breaker.drawdownPct}%): buys blocked` : null,
  ].filter(Boolean);
  return `${account.name} [${account.id}] ${account.market} ${account.currency} · model ${account.model} · equity ${metrics.equity} (${metrics.totalReturnPct >= 0 ? "+" : ""}${metrics.totalReturnPct}%) · cash ${metrics.availableCash} · ${metrics.positions} positions · ${metrics.openOrders} open orders${flags.length ? ` · ${flags.join(" · ")}` : ""}`;
}

function policyText(policy) {
  if (!policy) return "";
  const parts = [
    policy.maxPositionPct ? `max ${policy.maxPositionPct}% per position` : null,
    policy.maxExposurePct ? `max ${policy.maxExposurePct}% total exposure` : null,
    policy.maxDrawdownPct ? `drawdown breaker at -${policy.maxDrawdownPct}% (${policy.onBreach === "reduce" ? `then reduce to ${policy.reduceToExposurePct}% exposure` : "then block buys"})` : null,
  ].filter(Boolean);
  return parts.length ? `Owner risk policy: ${parts.join(", ")}.` : "Owner risk policy: no limits set.";
}

// Tools a read-only run (answering the owner's question, a team analyst) may not use.
const MUTATING = new Set([
  "arena_register_account", "arena_place_order", "arena_set_exits", "arena_cancel_order", "arena_log_decision", "arena_update_strategy", "arena_publish_report",
  "arena_set_watchlist", "arena_set_limits", "arena_set_prompt", "arena_set_fees", "arena_set_cadence", "arena_write_strategy", "arena_rollback_strategy",
  "arena_request_confirmation", "arena_dispatch",
]);

export function registerArenaTools(server, { toolResult, toolError }) {
  const caller = () => callerFromClient(server.server.getClientVersion?.());
  // One scheduler per MCP process, so tasks a trader dispatches can be collected in the same session.
  let toolScheduler = null;
  const scheduler = () => (toolScheduler ??= createScheduler({ arena: getArena() }));
  const register = (name, config, handler) => server.registerTool(name, config, async (input) => {
    try {
      if (MUTATING.has(name) && !(name === "arena_place_order" && input?.dryRun)) {
        const readonly = caller().readonly ? "read-only sub-agent" : input?.accountId ? (await getArena().readonlyState(input.accountId).catch(() => null))?.reason : null;
        if (readonly) throw new Error(`This run is read-only (${readonly}): answer or report, do not trade or change settings. Use arena_propose_rule to suggest a standing rule.`);
      }
      const [data, summary] = await handler(input ?? {});
      return toolResult(data, summary);
    } catch (error) {
      return toolError(error);
    }
  });

  register("arena_register_account", {
    title: "Register arena paper account",
    description: [
      "Create this agent's own paper-trading account in the local Agent Arena, so its performance can be compared with other agents and models.",
      "Call once per experiment and remember the returned accountId. First call arena_my_accounts: reuse an active account you already own instead of creating duplicates.",
      `Each account trades one market with virtual cash in its currency (defaults: ${Object.entries(ARENA_MARKETS).map(([key, value]) => `${key} ${value.defaultCash.toLocaleString("en-US")} ${value.currency}`).join(", ")}).`,
      "Report the model you are actually running on; do not guess another model's name.",
    ].join(" "),
    inputSchema: {
      name: z.string().min(1).max(60).describe("Display name, e.g. 'Opus momentum A-share'."),
      model: z.string().min(1).max(80).describe("Exact model id you are running on, e.g. claude-opus-5-5, gpt-5.5-codex, hunyuan-t1."),
      market,
      strategySummary: z.string().min(10).max(2000).describe("The strategy you will follow: universe, entry/exit rules, sizing, risk limits."),
      initialCash: z.number().min(1000).max(1e10).optional().describe("Leave unset to use the competition default so accounts stay comparable."),
      competition: z.string().min(1).max(40).optional().describe("Group name; only accounts in the same market and competition are ranked together. Default 'default'."),
      agentLabel: z.string().max(60).optional().describe("Human-friendly agent name, e.g. 'Claude Code', 'Codex', 'WorkBuddy'."),
      template: z.string().max(40).optional().describe("Trader template (see arena_skill_library): a-share-swing, value, growth-momentum, quant-rotation. Binds its skills and starting prompt."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    const defaults = await templateDefaults(input.template, input);
    const account = await getArena().createAccount({ ...input, ...defaults }, caller());
    // The owner's default: every agent account repeats a round every N minutes in session.
    const schedule = await createScheduler({ arena: getArena() }).ensureDefaultSchedule(account.id, (await loadPreferences()).defaultAgentIntervalMinutes).catch((error) => ({ created: false, reason: error.message }));
    account.schedule = schedule.created ? { intervalMinutes: schedule.job.intervalMinutes, runner: schedule.job.runner.type } : null;
    return [account, `Created arena account ${account.id}. Save this id and pass it as accountId to every arena tool. ${compactAccount(account)}`];
  });

  register("arena_my_accounts", {
    title: "List my arena accounts",
    description: "List active arena accounts registered by this agent client (and, with all=true, every agent's accounts). Use it at the start of each session to recover your accountId.",
    inputSchema: { all: z.boolean().optional(), market: market.optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ all = false, market: selected }) => {
    const me = caller();
    const accounts = await getArena().listAccounts({ market: selected, client: all ? undefined : me.client });
    const unowned = all ? [] : (await getArena().listAccounts({ market: selected })).filter((account) => !account.agent.client);
    const rows = [...accounts, ...unowned];
    return [{ caller: me, accounts: rows }, rows.length
      ? `${rows.length} account(s) for ${me.client}${unowned.length ? " (unclaimed dashboard accounts are claimed on your first order)" : ""}:\n${rows.map(compactAccount).join("\n")}`
      : `No arena account for ${me.client} yet. Create one with arena_register_account.`];
  });

  register("arena_get_account", {
    title: "Get arena account",
    description: [
      "Sync with live quotes (fills resting orders that became marketable, expires day orders, marks positions) and return cash, positions (with stop-loss / take-profit levels), open orders, recent trades, journal, account events (fills by the background matcher, stops, dividends, splits, suspensions) and performance metrics.",
      "Also returns the hard limits (limits: keep-cash %, max holdings, per-position %, new positions per day, risk per trade, boards, …) with limitStatus (room left: buyableValue, positionsLeft, newLeftToday), the drawdown/breaker state and run health (missed trading days).",
    ].join(" "),
    inputSchema: { accountId, limit: z.number().int().min(1).max(200).optional().describe("Number of recent orders/trades/journal entries (default 30).") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ accountId: id, limit = 30 }) => {
    const account = await getArena().getAccount(id, { limit });
    const { equity, ...rest } = account;
    return [{ ...rest, equityPoints: equity.length, equityRecent: equity.slice(-20) }, `${compactAccount(account)}\n${limitsText(account.limits, account.limitStatus)}\n${policyText(account.riskPolicy)}`];
  });

  register("arena_place_order", {
    title: "Place arena paper order",
    description: [
      "Place a long-only paper order in your own arena account. Fills use the live public quote plus slippage and exchange-style fees, during regular sessions only.",
      "Rules enforced: board lots (A-share 100, STAR 200 min; HK per-stock lot; US 1), A-share T+1 and daily price limits, available cash incl. fees and open-order reservations.",
      "Market orders need an open session. Limit orders rest and a background matcher fills them every 1-2 minutes during the session when the price is marketable; 'day' orders expire at the session close, 'gtc' after 30 days.",
      "One account may take at most a configured share of the day's volume (default 5%); larger orders fill partially and the rest keeps resting. Suspended stocks (no trades today) do not fill.",
      "BUY orders may carry stopLoss / takeProfit (price or % of average cost); the matcher sells at market when a fresh quote crosses the level, subject to T+1 and limit-down.",
      "Hard limits (see arena_get_account limits / limitStatus; default: keep 20% cash) reject buys that break them. Change unlocked limits with arena_set_limits.", "If the owner set autonomy to confirm or suggest (arena_get_account autonomy), qualifying orders are filed as approvals and placed only when the owner confirms; use dryRun to check first.",
      "Always give the reason (thesis, signal, risk) and cite the news / filings you relied on, so the decision can be reviewed later. Every order also stores the quote it saw (source, bid / ask, time, freshness). Rejections are recorded and count against discipline metrics.",
    ].join(" "),
    inputSchema: {
      accountId,
      symbol: z.string().min(1).max(20).describe("600519 / 600519.SS, 0700.HK, AAPL …"),
      side: z.enum(["BUY", "SELL"]),
      quantity: z.number().int().positive().max(10000000).describe("Number of shares (not lots)."),
      orderType: z.enum(["market", "limit"]).default("market"),
      limitPrice: z.number().positive().optional(),
      timeInForce: z.enum(["day", "gtc"]).optional(),
      reason: z.string().min(10).max(2000).describe("Why: thesis, signal, sizing and exit plan."),
      confidence: z.number().min(0).max(1).optional().describe("Your subjective probability the trade works (0–1); used for calibration review."),
      horizon: z.string().max(40).optional().describe("Intended holding period, e.g. '3d', '2w'."),
      clientOrderId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/).optional().describe("Idempotency key: retries with the same id return the original order."),
      requireApproval: z.boolean().optional().describe("Ask the owner to confirm this order before it is placed, even when your autonomy would not require it (for unusual or large decisions)."),
      dryRun: z.boolean().optional().describe("Check the order against every rule and hard limit (and whether the owner must confirm it) without placing anything."),
      citations: z.array(z.object({
        kind: z.enum(["news", "filing", "data", "report"]).optional(),
        title: z.string().min(1).max(200),
        url: z.string().max(500).optional(),
        source: z.string().max(80).optional(),
        publishedAt: z.string().max(40).optional(),
      })).max(8).optional().describe("The news, filings or data this decision relies on (from get_news, query_evidence, scan_market …). Stored with the order and its fills so the owner can check them; never cite something you did not read."),
      ...exitFields,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    const result = await getArena().placeOrder(input, caller());
    if (result.dryRun) return [result, result.ok
      ? `DRY RUN OK: ${input.side} ${input.quantity} ${input.symbol} ≈ ${result.estimate?.value ?? "?"}${result.needsApproval ? ` — would wait for the owner (${result.needsApproval})` : ""}${result.warnings.length ? `. Warnings: ${result.warnings.join("; ")}` : ""}`
      : `DRY RUN REJECTED: ${result.error}`];
    if (result.pendingApproval) return [result, `WAITING FOR OWNER: ${result.pendingApproval.reason}. ${input.side} ${input.quantity} ${input.symbol} [${result.pendingApproval.id}] expires ${result.pendingApproval.expiresAt}. ${result.note} Check its status later with arena_get_account (approvals).`];
    const { order, trade } = result;
    const summary = order.status === "rejected"
      ? `REJECTED: ${order.rejectReason}`
      : trade
        ? `FILLED ${trade.side} ${trade.quantity} ${trade.symbol} @ ${trade.price} (fees ${trade.fees}). ${compactAccount(result.account)}`
        : `OPEN ${order.type} ${order.side} ${order.quantity} ${order.symbol}${order.limitPrice ? ` @ ${order.limitPrice}` : ""} [${order.id}] — ${result.note}`;
    if (trade && order.status === "open") return [result, `PARTIAL ${trade.side} ${trade.quantity}/${order.quantity} ${trade.symbol} @ ${trade.price}. ${result.note}`];
    return [result, summary];
  });

  register("arena_set_exits", {
    title: "Set stop-loss / take-profit",
    description: [
      "Attach or change protective exits on one of your existing positions. Levels are a price or a percent of the average cost.",
      "The background matcher sells all sellable shares at market when a fresh quote crosses a level during a regular session; A-share T+1 and limit-down still apply (the exit waits and is logged as deferred).",
      "Pass null for a level to clear it, or clear=true to remove both.",
    ].join(" "),
    inputSchema: {
      accountId,
      symbol: z.string().min(1).max(20),
      stopLossPrice: exitFields.stopLossPrice.unwrap().nullable().optional(),
      stopLossPct: exitFields.stopLossPct.unwrap().nullable().optional(),
      takeProfitPrice: exitFields.takeProfitPrice.unwrap().nullable().optional(),
      takeProfitPct: exitFields.takeProfitPct.unwrap().nullable().optional(),
      clear: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    const result = await getArena().setExits(input, caller());
    return [result, result.exits ? `Exits for ${result.symbol}: stop ${result.levels?.stopLoss ?? "—"}, take-profit ${result.levels?.takeProfit ?? "—"} (last ${result.lastPrice ?? "?"}).` : `Exits for ${result.symbol} cleared.`];
  });

  register("arena_cancel_order", {
    title: "Cancel arena order",
    description: "Cancel one of your open arena orders by order id or clientOrderId.",
    inputSchema: { accountId, orderId: z.string().min(1).max(80), reason: z.string().max(500).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    const result = await getArena().cancelOrder(input, caller());
    return [result, result.note ?? `Cancelled ${result.order.id}.`];
  });

  register("arena_log_decision", {
    title: "Log arena decision",
    description: "Record analysis, a deliberate no-trade decision, a risk check or a post-trade review in your account journal. Logging why you did NOT trade is as valuable as logging trades when comparing agents.",
    inputSchema: {
      accountId,
      kind: z.enum(["analysis", "no-trade", "risk", "review", "note"]).default("analysis"),
      summary: z.string().min(1).max(2000),
      symbols: z.array(z.string().max(20)).max(20).optional(),
      details: z.string().max(8000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const result = await getArena().logDecision(input, caller());
    return [result, `Logged ${result.entry.kind} decision ${result.entry.id}.`];
  });

  register("arena_update_strategy", {
    title: "Update arena strategy",
    description: "Publish a new version of your strategy description. Later trades are tagged with the new version so performance can be compared per strategy version.",
    inputSchema: { accountId, summary: z.string().min(10).max(2000), changeNote: z.string().max(500).optional().describe("What changed and why.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const result = await getArena().updateStrategy(input, caller());
    return [result, `Strategy is now version ${result.strategy.version}.`];
  });

  register("arena_publish_report", {
    title: "Publish arena round report",
    description: [
      "Publish the conclusion of this round for the owner, who does not operate anything and only reads your reports.",
      "Call it at the end of every round, including rounds with no trades: headline, plain-language summary, market view, actions taken, current picks with thesis, risks and what you will do next.",
      "Write in the owner's language (Chinese unless told otherwise). Do not claim paper results are real returns.",
    ].join(" "),
    inputSchema: {
      accountId,
      title: z.string().min(1).max(120).describe("One-line headline, e.g. '减仓白酒，加仓新能源龙头'."),
      summary: z.string().min(10).max(2000).describe("The conclusion in 2–5 sentences."),
      sentiment: z.enum(["bullish", "neutral", "bearish", "defensive"]).optional(),
      marketView: z.string().max(2000).optional(),
      actions: z.array(z.object({ symbol: z.string().max(20), action: z.string().max(20).describe("buy / sell / hold / watch / cancel"), detail: z.string().max(500) })).max(30).optional(),
      picks: z.array(z.object({ symbol: z.string().max(20), thesis: z.string().max(500) })).max(20).optional(),
      risks: z.string().max(2000).optional(),
      nextSteps: z.string().max(2000).optional(),
      body: z.string().max(20000).optional().describe("Optional longer Markdown analysis."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    const result = await getArena().publishReport(input, caller());
    return [result, `Published report ${result.report.id}: ${result.report.title}`];
  });

  register("arena_set_watchlist", {
    title: "Set agent stock pool",
    description: [
      "Replace your account's candidate stock pool (your own selection, at most 50, same market as the account).",
      "If your account is the owner's managed account (or no managed account is chosen), the shared dashboard watchlist for that market is replaced with your pool plus your holdings, so the owner's market page follows your selection.",
    ].join(" "),
    inputSchema: { accountId, symbols: z.array(z.string().min(1).max(20)).max(50), reason: z.string().max(1000).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    const result = await getArena().setWatchlist(input, caller());
    const preferences = await loadPreferences();
    const managed = !preferences.managedAccountId || preferences.managedAccountId === input.accountId;
    let mirrored = false;
    if (managed) {
      const market = result.watchlist.symbols[0] ? marketFromSymbol(result.watchlist.symbols[0]) : null;
      const pool = [...new Set([...result.holdings, ...result.watchlist.symbols])];
      const others = preferences.watchlist.filter((symbol) => { try { return market ? marketFromSymbol(symbol) !== market : true; } catch { return false; } });
      await savePreferences({ watchlist: [...others, ...pool].slice(0, 50) });
      mirrored = true;
    }
    return [{ ...result, mirroredToDashboard: mirrored }, `Stock pool set to ${result.watchlist.symbols.length} symbols${mirrored ? "; dashboard watchlist updated" : ""}.`];
  });

  const limitShape = Object.fromEntries(Object.entries(LIMIT_SPECS).map(([key, spec]) => [key,
    (spec.type === "boards" ? z.array(z.enum(BOARD_OPTIONS)) : spec.type === "int" ? z.number().int().min(spec.min).max(spec.max) : z.number().min(spec.min).max(spec.max))
      .nullable().optional().describe(`${spec.zh} / ${spec.en}: ${spec.hint}. null turns it off.`)]));

  register("arena_get_settings", {
    title: "Get trader settings",
    description: "Read a trader's hard limits (with room left), lock state, prompt, pending change requests, the market's fee schedule and the global / market prompts. Settings change at any time from the dashboard or these MCP tools.",
    inputSchema: { accountId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ accountId: id }) => {
    const settings = await getArena().getSettings(id);
    const locked = Object.keys(settings.locks ?? {});
    return [settings, `${limitsText(settings.limits, settings.limitStatus)}${locked.length ? `\nLocked by the owner: ${locked.join(", ")}.` : ""}${settings.requests.length ? `\n${settings.requests.length} change request(s) waiting for the owner.` : ""}`];
  });

  register("arena_set_limits", {
    title: "Set trader limits",
    description: [
      "Change a trader's hard limits (checked by the arena before every buy). Only the keys you pass change; null turns a limit off.",
      "Items the owner locked are not changed: they become a change request the owner approves or rejects in the dashboard. Every change is logged with who made it and the reason.",
    ].join(" "),
    inputSchema: { accountId, ...limitShape, reason: z.string().min(4).max(500).describe("Why you change it; shown to the owner and in the change log.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ accountId: id, reason, ...limits }) => {
    const result = await getArena().setLimits({ accountId: id, limits, reason }, caller());
    const lines = [
      result.applied.length ? `Changed: ${result.applied.map((entry) => `${entry.key} ${JSON.stringify(entry.from)} → ${JSON.stringify(entry.to)}`).join(", ")}.` : "Nothing changed.",
      result.requested.length ? `Locked by the owner, filed as request(s): ${result.requested.map((entry) => entry.key).join(", ")}.` : null,
      limitsText(result.limits, result.limitStatus),
    ].filter(Boolean);
    return [result, lines.join("\n")];
  });

  register("arena_set_prompt", {
    title: "Set trader prompt",
    description: "Replace a trader's own prompt (added after the global and market prompts in every round). If the owner locked it, the change becomes a request.",
    inputSchema: { accountId, prompt: z.string().max(4000), reason: z.string().max(500).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    const result = await getArena().setPrompt(input, caller());
    return [result, result.requested.length ? "The prompt is locked by the owner; filed a change request." : "Trader prompt updated."];
  });

  register("arena_set_fees", {
    title: "Set market fee schedule",
    description: [
      "Change the fee schedule for one market (shared by every trader in it); later fills use it. Rates are fractions: 0.00025 = 0.025%.",
      `Fields: A ${Object.keys(DEFAULT_FEES.A).join(", ")}; HK ${Object.keys(DEFAULT_FEES.HK).join(", ")}; US ${Object.keys(DEFAULT_FEES.US).join(", ")}. Rejected when the owner locked the market's fees.`,
    ].join(" "),
    inputSchema: { market, fees: z.record(z.number()).describe("Numeric fields to change, e.g. { commissionRate: 0.0002, minCommission: 5 }."), waiveMinimum: z.boolean().optional().describe("A / HK: true = no minimum commission (免五)."), reason: z.string().max(500).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ market: selected, fees, waiveMinimum, reason }) => {
    const result = await getArena().setFees({ market: selected, fees: { ...fees, ...(waiveMinimum === undefined ? {} : { waiveMinimum }) }, reason }, caller());
    return [result, `${result.market} fees: ${Object.entries(result.fees).map(([key, value]) => `${key} ${value}`).join(", ")}.`];
  });

  register("arena_set_cadence", {
    title: "Set review and strategy cadence",
    description: [
      "Change how often you (the agent) are woken for a review, and how often your code strategy executes. Reviews cost tokens; strategy executions do not.",
      "reviewMinutes 5–240, strategyMinutes 1–240. Items the owner locked become a change request instead.",
    ].join(" "),
    inputSchema: { accountId, reviewMinutes: z.number().int().min(5).max(240).optional(), strategyMinutes: z.number().int().min(1).max(240).optional(), reason: z.string().min(4).max(500) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ accountId: id, reviewMinutes, strategyMinutes, reason }) => {
    const result = await createScheduler({ arena: getArena() }).setCadence(id, { reviewMinutes, strategyMinutes, reason }, caller());
    const parts = [
      result.applied.reviewMinutes !== undefined ? `review every ${result.applied.reviewMinutes} min` : null,
      result.applied.strategyMinutes !== undefined ? `strategy every ${result.applied.strategyMinutes} min` : null,
    ].filter(Boolean);
    return [result, `${parts.length ? `Now: ${parts.join(", ")}.` : "Nothing changed."}${result.requested.length ? ` Locked by the owner, filed as request(s): ${result.requested.map((entry) => entry.key).join(", ")}.` : ""}`];
  });

  register("arena_write_strategy", {
    title: "Write your code strategy",
    description: [
      "Publish a new version of your own code strategy. It runs automatically at the frequency you set (no tokens), while you review every few minutes as the director.",
      "Before going live the version is loaded in a sandbox, dry-run on live data (orders computed, not placed) and backtested on real daily bars (about 6 months, closes, fees and slippage). A failing version is kept as rejected with the reason and the current live version keeps running.",
      STRATEGY_API,
    ].join(" "),
    inputSchema: {
      accountId,
      code: z.string().min(40).max(60000).describe("The whole ES module source."),
      changeNote: z.string().min(4).max(500).describe("What changed and why."),
      params: z.record(z.any()).optional().describe("Parameter values for this version (defaults come from the module's params)."),
      universe: z.array(z.string().max(20)).max(40).optional().describe("Symbols to run and backtest on; default your stock pool, then holdings."),
      intervalMinutes: z.number().int().min(1).max(240).optional().describe("How often the strategy executes during the session (default: current, else 5)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    const arena = getArena();
    const result = await writeTraderStrategy({ arena, scheduler: createScheduler({ arena }), store: createTraderStrategyStore(arena.root), ...input, caller: caller() });
    if (result.status !== "live") return [result, `v${result.version} REJECTED at ${result.rejectedAt}: ${result.error}${result.live ? ` · v${result.live} keeps running.` : " · no live version yet."}`];
    const bt = result.backtest;
    return [result, `v${result.version} is LIVE, executing every ${result.intervalMinutes} min. Dry run: ${result.dryRun.orders.length} order(s). Backtest ${bt.from}–${bt.to}: ${bt.totalReturnPct}% (max DD ${bt.maxDrawdownPct}%, benchmark ${bt.benchmarkReturnPct ?? "—"}%, ${bt.trades} trades).${result.previous?.backtest ? ` Previous v${result.previous.version}: ${result.previous.backtest.totalReturnPct}% / ${result.previous.backtest.maxDrawdownPct}%.` : ""}${bt.notes.length ? ` Notes: ${bt.notes.join(" ")}` : ""}`];
  });

  register("arena_get_strategy", {
    title: "Get your code strategy",
    description: "Read your live code strategy (source), its parameters, schedule and every earlier version with its checks, backtest and status.",
    inputSchema: { accountId, version: z.number().int().positive().optional().describe("A specific version's source; default the live one.") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ accountId: id, version }) => {
    const store = createTraderStrategyStore(getArena().root);
    const [meta, current] = await Promise.all([store.meta(id), store.code(id, version)]);
    const job = (await createScheduler({ arena: getArena() }).listJobs()).find((entry) => entry.accountId === id);
    return [{ strategyId: traderStrategyId(id), live: meta.live, versions: meta.versions, code: current?.code ?? null, schedule: job ? { reviewMinutes: job.intervalMinutes ?? null, strategy: job.strategy ?? (job.runner?.type === "strategy" ? { strategyId: job.runner.strategyId, intervalMinutes: job.intervalMinutes } : null), mode: job.mode ?? null } : null },
      meta.live ? `Live: v${meta.live} of ${meta.versions.length} version(s).` : "No live code strategy yet. Write one with arena_write_strategy."];
  });

  register("arena_rollback_strategy", {
    title: "Roll back your code strategy",
    description: "Make an earlier version that passed its checks live again.",
    inputSchema: { accountId, version: z.number().int().positive(), reason: z.string().max(500).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ accountId: id, version }) => {
    const arena = getArena();
    const entry = await rollbackTraderStrategy({ arena, scheduler: createScheduler({ arena }), store: createTraderStrategyStore(arena.root), accountId: id, version, caller: caller() });
    return [entry, `v${entry.version} is live again.`];
  });

  register("arena_skill_library", {
    title: "Trader skill library",
    description: "List the built-in trader templates and skills (discipline, team roles, investor panel, CANSLIM, VCP, A-share trend pullback, MACD resonance, …) with their source repository, license, markets and whether the data they need is available.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const library = await loadLibrary();
    const text = [
      "Templates:", ...library.templates.map((template) => `- ${template.id} · ${template.name} [${template.markets.join("/")}] ${template.status === "available" ? "" : `(needs ${template.requires?.join(", ")})`}`),
      "Skills:", ...library.skills.map((skill) => `- ${skill.id} · ${skill.name} [${skill.markets.join("/")}] ${skill.sourceInfo?.repo ?? ""} ${skill.sourceInfo?.license ?? ""}${skill.status === "available" ? "" : ` (needs ${skill.requires?.join(", ")})`}`),
    ].join("\n");
    return [library, text];
  });

  register("arena_get_starter_strategy", {
    title: "Get a starter strategy",
    description: "Read the source of a built-in starter strategy (trend-pullback, macd-resonance) to adapt and publish with arena_write_strategy.",
    inputSchema: { id: z.enum(["trend-pullback", "macd-resonance"]) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const code = await starterStrategyCode(id);
    return [{ id, code }, code];
  });

  register("arena_propose_rule", {
    title: "Propose a standing rule",
    description: "Suggest a standing rule for this trader (e.g. when the owner says \"from now on, never chase stocks up more than 5%\"). The owner confirms or rejects it in the workbench; confirmed rules are added to every round's prompt. Allowed in read-only runs.",
    inputSchema: { accountId, rule: z.string().min(4).max(300).describe("One sentence the trader will follow every round."), reason: z.string().min(4).max(500) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ accountId: id, rule, reason }) => {
    const request = await getArena().proposeRule(id, { rule, reason }, caller());
    return [request, `Proposed rule [${request.id}] — waiting for the owner: ${rule}`];
  });

  register("arena_check_rules", {
    title: "Check an order against the rules",
    description: "Dry-run an order: lot size, T+1, price band, cash, every hard limit (cash floor, holdings, per-position, per-industry, risk per trade, boards, chasing …), whether the owner must confirm it, and discipline warnings (no stop, no sources). Nothing is placed or recorded.",
    inputSchema: {
      accountId, symbol: z.string().min(1).max(20), side: z.enum(["BUY", "SELL"]), quantity: z.number().int().positive().max(10000000),
      orderType: z.enum(["market", "limit"]).default("market"), limitPrice: z.number().positive().optional(), ...exitFields,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    const result = await getArena().placeOrder({ ...input, reason: "Rule check (dry run), nothing placed.", dryRun: true }, caller());
    return [result, result.ok ? `OK${result.needsApproval ? `, the owner must confirm (${result.needsApproval})` : ""}${result.warnings.length ? `. Warnings: ${result.warnings.join("; ")}` : ""}` : `Would be rejected: ${result.error}`];
  });

  register("arena_request_confirmation", {
    title: "Ask the owner to confirm orders",
    description: "File one or more orders as approval cards for the owner, whatever your autonomy level: use it for unusual, large or high-risk decisions. Each order is placed at the live quote, with every limit re-checked, only when the owner confirms it. Check the outcome later in arena_get_account (approvals).",
    inputSchema: {
      accountId, summary: z.string().min(10).max(1000).describe("What you propose and why, for the owner."),
      orders: z.array(z.object({
        symbol: z.string().min(1).max(20), side: z.enum(["BUY", "SELL"]), quantity: z.number().int().positive().max(10000000),
        orderType: z.enum(["market", "limit"]).default("market"), limitPrice: z.number().positive().optional(), reason: z.string().min(10).max(2000), ...exitFields,
      })).min(1).max(5),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ accountId: id, summary, orders }) => {
    const results = [];
    for (const order of orders) results.push(await getArena().placeOrder({ accountId: id, ...order, reason: `${order.reason}\n\n${summary}`.slice(0, 2000), requireApproval: true }, caller()));
    return [{ results }, results.map((result, index) => result.pendingApproval ? `${orders[index].side} ${orders[index].symbol}: waiting for the owner [${result.pendingApproval.id}]` : `${orders[index].side} ${orders[index].symbol}: ${result.error ?? result.order?.status}`).join("\n")];
  });

  register("arena_dispatch", {
    title: "Dispatch a task to a team analyst",
    description: "Hand a research task to a read-only sub-agent on your team (roles: technical, news, fundamental, market, risk, bull, bear). It runs with the analyst agent configured for your team (it cannot trade) and reports in text; collect the result with arena_await_runs. At most 6 at a time.",
    inputSchema: { accountId, role: z.enum(["technical", "news", "fundamental", "market", "risk", "bull", "bear"]), task: z.string().min(10).max(2000).describe("What to research and report, e.g. which symbols and what question.") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ accountId: id, role, task }) => {
    const started = await scheduler().dispatch(id, { role, task });
    return [started, `Dispatched ${role} [${started.runId}]; collect it with arena_await_runs.`];
  });

  register("arena_await_runs", {
    title: "Collect dispatched tasks",
    description: "Wait (up to timeoutSeconds, max 600) for tasks started with arena_dispatch in this session and return their reports. Tasks still running come back as running; call again later.",
    inputSchema: { runIds: z.array(z.string().regex(/^run_[a-f0-9]{12}$/)).min(1).max(6), timeoutSeconds: z.number().int().min(5).max(600).default(300) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ runIds, timeoutSeconds = 300 }) => {
    const results = await scheduler().awaitRuns(runIds, { timeoutMs: timeoutSeconds * 1000 });
    return [{ results }, results.map((entry) => `[${entry.role ?? entry.runId}] ${entry.status}${entry.text ? `: ${entry.text.slice(0, 400)}` : ""}`).join("\n\n")];
  });

  register("arena_leaderboard", {
    title: "Arena leaderboard",
    description: "Rank all agents' accounts by total return within each market and competition, with drawdown, Sharpe, win rate, fees, turnover, benchmark and excess return.",
    inputSchema: { market: market.optional(), competition: z.string().max(40).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    const board = await getArena().leaderboard(input);
    const text = board.groups.map((group) => [`${group.market} · ${group.competition} (${group.currency})`,
      ...group.accounts.map((account) => `#${account.rank} ${account.name} — ${account.model} via ${account.agent.label ?? account.agent.client ?? "?"}: ${account.metrics.totalReturnPct}% (max DD ${account.metrics.maxDrawdownPct}%, ${account.metrics.trades} trades)`)].join("\n")).join("\n\n");
    return [board, text || "No arena accounts yet."];
  });
}
