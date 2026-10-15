// MCP surface of the Agent Arena. Tool names and arguments are client-neutral so the same
// workflow runs in Codex, Claude Code, WorkBuddy or any other MCP host.
import { z } from "zod";
import { ARENA_MARKETS, callerFromClient, getArena } from "./arena.mjs";

const accountId = z.string().regex(/^acc_[a-f0-9]{12}$/).describe("Arena account id (acc_…) returned by arena_register_account or arena_my_accounts.");
const market = z.enum(["A", "HK", "US"]);

function compactAccount(account) {
  const { metrics } = account;
  return `${account.name} [${account.id}] ${account.market} ${account.currency} · model ${account.model} · equity ${metrics.equity} (${metrics.totalReturnPct >= 0 ? "+" : ""}${metrics.totalReturnPct}%) · cash ${metrics.availableCash} · ${metrics.positions} positions · ${metrics.openOrders} open orders`;
}

export function registerArenaTools(server, { toolResult, toolError }) {
  const caller = () => callerFromClient(server.server.getClientVersion?.());
  const register = (name, config, handler) => server.registerTool(name, config, async (input) => {
    try {
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
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input) => {
    const account = await getArena().createAccount(input, caller());
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
    description: "Sync with live quotes (fills resting orders that became marketable, expires day orders, marks positions) and return cash, positions, open orders, recent trades, journal and performance metrics.",
    inputSchema: { accountId, limit: z.number().int().min(1).max(200).optional().describe("Number of recent orders/trades/journal entries (default 30).") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ accountId: id, limit = 30 }) => {
    const account = await getArena().getAccount(id, { limit });
    const { equity, ...rest } = account;
    return [{ ...rest, equityPoints: equity.length, equityRecent: equity.slice(-20) }, compactAccount(account)];
  });

  register("arena_place_order", {
    title: "Place arena paper order",
    description: [
      "Place a long-only paper order in your own arena account. Fills use the live public quote plus slippage and exchange-style fees, during regular sessions only.",
      "Rules enforced: board lots (A-share 100, STAR 200 min; HK per-stock lot; US 1), A-share T+1 and daily price limits, available cash incl. fees and open-order reservations.",
      "Market orders need an open session. Limit orders rest and fill when a later sync observes a marketable price; 'day' orders expire at the session close, 'gtc' after 30 days.",
      "Always give the reason (thesis, signal, risk) so the decision can be reviewed later. Rejections are recorded and count against discipline metrics.",
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
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    const result = await getArena().placeOrder(input, caller());
    const { order, trade } = result;
    const summary = order.status === "rejected"
      ? `REJECTED: ${order.rejectReason}`
      : trade
        ? `FILLED ${trade.side} ${trade.quantity} ${trade.symbol} @ ${trade.price} (fees ${trade.fees}). ${compactAccount(result.account)}`
        : `OPEN ${order.type} ${order.side} ${order.quantity} ${order.symbol}${order.limitPrice ? ` @ ${order.limitPrice}` : ""} [${order.id}] — ${result.note}`;
    return [result, summary];
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
