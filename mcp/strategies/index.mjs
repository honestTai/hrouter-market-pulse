// Quant strategy runtime. A strategy is a plain ES module:
//
//   export default {
//     id: "my-strategy", name: "…", version: "1.0.0", markets: ["A", "HK", "US"],
//     description: "…",
//     params: { lookback: { type: "integer", default: 20, min: 5, max: 250, label: "…" }, … },
//     async run(ctx) {
//       // ctx.account  – the arena account (cash, positions, metrics) as of now
//       // ctx.universe – symbols to consider (params.universe, else the account's stock pool, else holdings)
//       // ctx.history(symbol, { days }) – COMPLETED daily bars only (no look-ahead), oldest first
//       // ctx.quote(symbol)  – live quote; ctx.params – validated params; ctx.now; ctx.log(message)
//       return {
//         targets: [{ symbol, weight, reason }],        // desired portfolio weights (0–1), or
//         orders:  [{ symbol, side, quantity, reason }], // explicit orders,
//         exits:   { stopLossPct, takeProfitPct },       // optional protection for new buys
//         report:  { title, summary, … },                // optional; one is generated otherwise
//       };
//     },
//   };
//
// Strategies never call a venue themselves: the runner turns their output into lot-sized orders
// and sends them through a broker (paper today; advisory proposals for live markets later).
// Owner strategies live in <storage>/strategies/*.mjs and load next to the built-ins.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getHistoricalQuote, getStorageDir, getTradeQuote } from "../core.mjs";
import { lotRules } from "../arena.mjs";
import maTrend from "./ma-trend.mjs";
import momentumRotation from "./momentum-rotation.mjs";

export const BUILTIN_STRATEGIES = [maTrend, momentumRotation];
const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function validateStrategy(module, origin = "builtin") {
  const strategy = module?.default ?? module;
  if (!strategy || typeof strategy.run !== "function") throw new Error(`Strategy from ${origin} must export default { id, run(ctx) }.`);
  if (!ID.test(strategy.id ?? "")) throw new Error(`Strategy id "${strategy.id}" must be 2–41 lowercase letters, digits or dashes.`);
  return { name: strategy.id, version: "0.0.0", markets: ["A", "HK", "US"], params: {}, description: "", ...strategy, origin };
}

export async function loadStrategies({ dir = path.join(getStorageDir(), "strategies") } = {}) {
  const strategies = new Map(BUILTIN_STRATEGIES.map((strategy) => [strategy.id, validateStrategy(strategy)]));
  const errors = [];
  let names = [];
  try { names = await readdir(dir); } catch (error) { if (error.code !== "ENOENT") errors.push(error.message); }
  for (const name of names.filter((entry) => entry.endsWith(".mjs"))) {
    try {
      const file = path.join(dir, name);
      const strategy = validateStrategy(await import(`${pathToFileURL(file).href}?v=${Date.now()}`), file);
      strategies.set(strategy.id, strategy);
    } catch (error) { errors.push(`${name}: ${error.message}`); }
  }
  return { strategies, errors, dir };
}

export function describeStrategy(strategy) {
  const { id, name, version, markets, params, description, origin } = strategy;
  return { id, name, version, markets, params, description, origin: origin === "builtin" ? "builtin" : "owner" };
}

export function resolveParams(strategy, input = {}) {
  const params = {};
  for (const [key, spec] of Object.entries(strategy.params ?? {})) {
    let value = input[key] ?? spec.default;
    if (spec.type === "integer" || spec.type === "number") {
      value = Number(value);
      if (!Number.isFinite(value) || (spec.type === "integer" && !Number.isInteger(value))) throw new Error(`Parameter ${key} must be ${spec.type === "integer" ? "an integer" : "a number"}.`);
      if (spec.min !== undefined && value < spec.min) throw new Error(`Parameter ${key} must be ≥ ${spec.min}.`);
      if (spec.max !== undefined && value > spec.max) throw new Error(`Parameter ${key} must be ≤ ${spec.max}.`);
    } else if (spec.type === "symbols") {
      value = Array.isArray(value) ? value.slice(0, 100).map(String) : [];
    } else if (spec.type === "boolean") value = Boolean(value);
    params[key] = value;
  }
  if (Array.isArray(input.universe)) params.universe = input.universe.slice(0, 100).map(String);
  return params;
}

const sma = (values, length) => values.length >= length ? values.slice(-length).reduce((sum, value) => sum + value, 0) / length : null;
export const indicators = { sma };

// Turn target weights into lot-sized buy/sell orders against current holdings. Sells come first.
export function ordersFromTargets(account, targets, quotes, { minTradeValuePct = 0.5 } = {}) {
  const equity = account.metrics.equity;
  const held = new Map(account.positions.map((position) => [position.symbol, position]));
  const wanted = new Map(targets.map((target) => [target.symbol, target]));
  const sells = [];
  const buys = [];
  for (const symbol of new Set([...held.keys(), ...wanted.keys()])) {
    const quote = quotes.get(symbol);
    if (!quote?.price) continue;
    const target = wanted.get(symbol);
    const weight = Math.max(0, Math.min(1, target?.weight ?? 0));
    const lot = lotRules(account, symbol, quote).lotSize ?? 1;
    const currentQuantity = held.get(symbol)?.quantity ?? 0;
    const targetQuantity = Math.floor(equity * weight / quote.price / lot) * lot;
    const delta = targetQuantity - currentQuantity;
    if (Math.abs(delta) * quote.price < equity * minTradeValuePct / 100) continue;
    if (delta < 0) {
      // Selling everything is always allowed as an odd lot; partial sells stay in whole lots.
      const quantity = targetQuantity === 0 ? currentQuantity : Math.floor(-delta / lot) * lot;
      if (quantity > 0) sells.push({ symbol, side: "SELL", quantity, reason: target?.reason ?? `Target weight 0: exit ${symbol}.` });
    } else if (delta > 0) {
      const quantity = Math.floor(delta / lot) * lot;
      if (quantity > 0) buys.push({ symbol, side: "BUY", quantity, reason: target?.reason ?? `Rebalance ${symbol} toward ${(weight * 100).toFixed(1)}%.` });
    }
  }
  return [...sells, ...buys];
}

// Completed daily bars do not change during a session, so frequent rounds reuse them for up to an
// hour instead of re-downloading every symbol every few minutes.
const HISTORY_TTL_MS = 3600000;
const historyMemo = new Map();
async function cachedHistory(historyProvider, symbol, range) {
  const key = `${symbol}:${range}`;
  const hit = historyMemo.get(key);
  if (hit && hit.provider === historyProvider && Date.now() - hit.fetchedAt < HISTORY_TTL_MS) return hit.quote;
  const quote = await historyProvider(symbol, { range });
  historyMemo.set(key, { quote, provider: historyProvider, fetchedAt: Date.now() });
  return quote;
}

// Run one strategy round for an account through a broker. Returns a structured round record.
export async function runStrategyRound({ strategy, params: rawParams, broker, now = () => new Date().toISOString(), runId, historyProvider = getHistoricalQuote, quoteProvider = getTradeQuote }) {
  const startedAt = now();
  const logs = [];
  const log = (message) => logs.push({ at: now(), message: String(message).slice(0, 500) });
  const params = resolveParams(strategy, rawParams);
  const account = await broker.account({ limit: 20 });
  const universe = (params.universe?.length ? params.universe : account.watchlist?.symbols?.length ? account.watchlist.symbols : account.positions.map((position) => position.symbol));
  const historyCache = new Map();
  const quoteCache = new Map();
  const ctx = {
    now: startedAt, market: account.market, account, params, universe, log,
    async history(symbol, { days = 260 } = {}) {
      if (!historyCache.has(symbol)) {
        const quote = await cachedHistory(historyProvider, symbol, days > 250 ? "2y" : "1y");
        // Completed bars only: never let a strategy see today's unfinished candle.
        historyCache.set(symbol, (quote.history ?? []).filter((bar) => bar.complete !== false && (!bar.availableAt || Date.parse(bar.availableAt) <= Date.parse(startedAt))));
      }
      return historyCache.get(symbol).slice(-days);
    },
    async quote(symbol) {
      if (!quoteCache.has(symbol)) quoteCache.set(symbol, await quoteProvider(symbol));
      return quoteCache.get(symbol);
    },
    indicators,
  };
  const output = (await strategy.run(ctx)) ?? {};
  let orders = Array.isArray(output.orders) ? output.orders : [];
  if (Array.isArray(output.targets)) {
    const symbols = new Set([...output.targets.map((target) => target.symbol), ...account.positions.map((position) => position.symbol)]);
    const quotes = new Map();
    for (const symbol of symbols) { try { quotes.set(symbol, await ctx.quote(symbol)); } catch (error) { log(`quote ${symbol}: ${error.message}`); } }
    orders = [...orders, ...ordersFromTargets(account, output.targets, quotes)];
  }
  const results = [];
  for (const [index, order] of orders.slice(0, 50).entries()) {
    try {
      const response = await broker.placeOrder({
        ...order, ...(order.side === "BUY" ? output.exits ?? {} : {}),
        reason: order.reason || `${strategy.id} v${strategy.version}`,
        clientOrderId: runId ? `${runId}-${index}`.slice(0, 64) : undefined,
      });
      const placed = response.order ?? response.proposal;
      results.push({ symbol: order.symbol, side: order.side, quantity: order.quantity, status: placed?.status ?? "proposed", fillPrice: response.trade?.price ?? null, error: response.error ?? null });
    } catch (error) {
      results.push({ symbol: order.symbol, side: order.side, quantity: order.quantity, status: "error", error: error.message });
    }
  }
  const filled = results.filter((result) => result.status === "filled" || result.fillPrice);
  const report = output.report ?? {
    title: orders.length ? `${strategy.name}：调仓 ${orders.length} 笔` : `${strategy.name}：本轮无信号`,
    summary: orders.length
      ? `${strategy.name} v${strategy.version} 本轮生成 ${orders.length} 笔订单，成交 ${filled.length} 笔，其余挂单或被拒（见操作明细）。`
      : `${strategy.name} v${strategy.version} 本轮没有满足条件的调仓信号，维持现有仓位。`,
    sentiment: "neutral",
    actions: results.map((result) => ({ symbol: result.symbol, action: result.side === "BUY" ? "buy" : "sell", detail: `${result.quantity} 股 · ${result.status}${result.fillPrice ? ` @ ${result.fillPrice}` : ""}${result.error ? ` · ${result.error}` : ""}` })),
    picks: (output.targets ?? []).filter((target) => target.weight > 0).map((target) => ({ symbol: target.symbol, thesis: target.reason ?? `目标权重 ${(target.weight * 100).toFixed(1)}%` })),
    nextSteps: "按调度时间运行下一轮。",
  };
  // Frequent strategies would otherwise publish a "no signal" report every few minutes. Publish when
  // something was traded, when the strategy supplies its own report, or once per day as a heartbeat.
  const today = new Date(startedAt).toLocaleDateString("en-CA", { timeZone: { A: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" }[account.market] ?? "UTC" });
  const reportedToday = (account.reports ?? []).some((entry) => new Date(entry.at).toLocaleDateString("en-CA", { timeZone: { A: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" }[account.market] ?? "UTC" }) === today);
  const publish = orders.length > 0 || Boolean(output.report) || !reportedToday;
  if (publish && broker.publishReport) await broker.publishReport(report);
  else if (!publish && broker.touchRound) await broker.touchRound("strategy-no-change");
  else if (!orders.length && broker.logDecision) await broker.logDecision({ kind: "no-trade", summary: report.summary });
  return { strategyId: strategy.id, version: strategy.version, params, startedAt, finishedAt: now(), orders: results, logs, notes: output.notes ?? null };
}
