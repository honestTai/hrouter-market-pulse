// Code strategies that a trader agent writes for itself. Every version is kept; a version goes live
// only after it loads in the sandbox, survives a dry run against live data (orders are computed, not
// placed) and completes a backtest on real daily bars. Owners and agents can roll back to any
// earlier version. The scheduler executes the live version through the sandbox.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getHistoricalQuote, getIntradayBars, getTradeQuote, scanMarket } from "./core.mjs";
import { lotRules } from "./arena.mjs";
import { localMarketTime } from "./market-rules.mjs";
import { openSandbox, prepareStrategyCode, sandboxedStrategy } from "./strategy-sandbox.mjs";
import { ordersFromTargets, resolveParams, runStrategyRound } from "./strategies/index.mjs";
import { computeFees, DEFAULT_FEES } from "./trader-settings.mjs";

const round = (value, digits = 2) => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const BENCHMARKS = { A: "000300.SS", HK: "^HSI", US: "^GSPC" };

export const traderStrategyId = (accountId) => `trader-${String(accountId).replace(/^acc_/, "")}`;
export const accountOfStrategy = (strategyId) => (/^trader-[a-f0-9]{12}$/.test(strategyId ?? "") ? `acc_${strategyId.slice(7)}` : null);

export function createTraderStrategyStore(root, now = () => new Date().toISOString()) {
  const dirOf = (accountId) => {
    if (!/^acc_[a-f0-9]{12}$/.test(accountId ?? "")) throw new Error(`Invalid account id: ${accountId}`);
    return path.join(root, "trader-strategies", accountId);
  };
  async function meta(accountId) {
    try { return JSON.parse(await readFile(path.join(dirOf(accountId), "meta.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return { accountId, live: null, versions: [] }; throw error; }
  }
  async function saveMeta(accountId, value) {
    await mkdir(dirOf(accountId), { recursive: true });
    const file = path.join(dirOf(accountId), "meta.json");
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 1), "utf8");
    await rename(temporary, file);
  }
  return {
    meta,
    async code(accountId, version) {
      const info = await meta(accountId);
      const target = version ?? info.live;
      if (!target) return null;
      return { version: target, code: await readFile(path.join(dirOf(accountId), `v${target}.mjs`), "utf8"), entry: info.versions.find((entry) => entry.version === target) ?? null };
    },
    async addVersion(accountId, { code, changeNote, by, params = {}, intervalMinutes = null, universe = null }) {
      const info = await meta(accountId);
      const version = (info.versions.at(-1)?.version ?? 0) + 1;
      await mkdir(dirOf(accountId), { recursive: true });
      await writeFile(path.join(dirOf(accountId), `v${version}.mjs`), code, "utf8");
      const entry = { version, at: now(), by, changeNote: changeNote ? String(changeNote).slice(0, 500) : null, params, intervalMinutes, universe, status: "checking", lines: String(code).split("\n").length };
      info.versions.push(entry);
      await saveMeta(accountId, info);
      return entry;
    },
    async updateVersion(accountId, version, patch) {
      const info = await meta(accountId);
      const entry = info.versions.find((item) => item.version === version);
      if (!entry) throw new Error(`Version ${version} not found.`);
      Object.assign(entry, patch);
      if (patch.status === "live") {
        for (const other of info.versions) if (other.version !== version && other.status === "live") other.status = "retired";
        info.live = version;
      }
      await saveMeta(accountId, info);
      return entry;
    },
    // The live version as a strategy the runtime can execute (sandboxed), or null.
    async resolve(strategyId, market) {
      const accountId = accountOfStrategy(strategyId);
      if (!accountId) return null;
      const current = await this.code(accountId);
      if (!current) return null;
      return { ...sandboxedStrategy({ id: strategyId, code: current.code, meta: current.entry?.meta ?? {}, market }), version: String(current.version), codeVersion: current.version };
    },
  };
}

// ---------------------------------------------------------------------------
// Backtest: replay the strategy on real completed daily bars. Each session the strategy decides near
// the close with history up to the previous session and the session's close as the price, and orders
// fill at that close with slippage and the market's fee schedule. Minute bars and scans are not
// available in a daily backtest, so strategies that depend on them are reported as such.
// ---------------------------------------------------------------------------

export async function backtestCode({ code, market, universe, params = {}, sessions = 120, initialCash, minCashPct = null, fees = DEFAULT_FEES[market], slippageBps = 5, historyProvider = getHistoricalQuote }) {
  if (!universe?.length) return { ok: false, error: "回测需要股票池：在 universe 里给出股票，或者先用 arena_set_watchlist 设好股票池。" };
  const symbols = [...new Set(universe)].slice(0, 40);
  const histories = new Map();
  const missing = [];
  await Promise.all([...symbols, BENCHMARKS[market]].map(async (symbol) => {
    try { histories.set(symbol, ((await historyProvider(symbol, { range: "1y" })).history ?? []).filter((bar) => bar.complete !== false && finite(bar.close))); }
    catch { missing.push(symbol); }
  }));
  const calendar = [...new Set([...histories.values()].flatMap((bars) => bars.map((bar) => bar.sessionDate)).filter(Boolean))].sort().slice(-sessions);
  if (calendar.length < 20) return { ok: false, error: "真实日线不足 20 个交易日，没法回测。", missing };
  const byDate = new Map([...histories].map(([symbol, bars]) => [symbol, new Map(bars.map((bar) => [bar.sessionDate, bar]))]));
  let cash = initialCash;
  const positions = new Map();
  const trades = [];
  const curve = [];
  const notes = new Set();
  const slip = slippageBps / 10000;
  const sandbox = await openSandbox(code);
  try {
    for (const date of calendar) {
      const decideAt = new Date(Date.parse(byDate.get(symbols.find((symbol) => byDate.get(symbol)?.has(date)) ?? BENCHMARKS[market])?.get(date)?.closeAt ?? `${date}T07:00:00Z`) - 60000).toISOString();
      const closes = new Map(symbols.map((symbol) => [symbol, byDate.get(symbol)?.get(date)?.close]).filter(([, close]) => finite(close)));
      const value = () => [...positions].reduce((sum, [symbol, position]) => sum + position.quantity * (closes.get(symbol) ?? position.lastPrice), 0);
      const equity = cash + value();
      const account = {
        market, cash: round(cash), metrics: { equity: round(equity), cash: round(cash) }, watchlist: { symbols }, reports: [],
        positions: [...positions].map(([symbol, position]) => ({ symbol, quantity: position.quantity, averageCost: position.cost / position.quantity, lots: position.lots, marketValue: position.quantity * (closes.get(symbol) ?? position.lastPrice), weightPct: equity > 0 ? position.quantity * (closes.get(symbol) ?? position.lastPrice) / equity * 100 : 0 })),
      };
      const today = localMarketTime(decideAt, market)?.date ?? date;
      const sellable = Object.fromEntries([...positions].map(([symbol, position]) => [symbol, market === "A" ? position.lots.filter((lot) => lot.date < today).reduce((sum, lot) => sum + lot.quantity, 0) : position.quantity]));
      let output;
      try {
        output = await sandbox.run({ now: decideAt, market, account, params, universe: symbols }, {
          history: async (symbol, options = {}) => (histories.get(symbol) ?? []).filter((bar) => bar.sessionDate < date).slice(-(options?.days ?? 260)),
          quote: async (symbol) => { const bar = byDate.get(symbol)?.get(date); if (!bar) throw new Error(`${symbol} ${date} 没有行情`); const previous = (histories.get(symbol) ?? []).filter((entry) => entry.sessionDate < date).at(-1); return { symbol, price: bar.close, changePct: previous ? (bar.close / previous.close - 1) * 100 : null, asOf: decideAt, signalEligible: true }; },
          intraday: async () => { notes.add("策略用到了分钟线，日线回测里拿不到，这部分信号没有被回测。"); return []; },
          scan: async () => { notes.add("策略用到了全市场扫描，回测里没有历史扫描数据，只在股票池里回测。"); return { rows: [] }; },
        }, { sellable, timeoutMs: 20000 });
      } catch (error) { return { ok: false, error: `${date} 运行出错：${error.message}`, sessions: curve.length }; }
      let orders = Array.isArray(output?.orders) ? output.orders : [];
      if (Array.isArray(output?.targets)) {
        const quotes = new Map([...closes].map(([symbol, close]) => [symbol, { price: close }]));
        orders = [...orders, ...ordersFromTargets({ ...account, lotOverrides: {} }, output.targets, quotes, { now: decideAt, minTradeValuePct: output.minTradeValuePct ?? 0.5 })];
      }
      for (const order of [...orders.filter((entry) => entry.side === "SELL"), ...orders.filter((entry) => entry.side === "BUY")]) {
        const close = closes.get(order.symbol);
        if (!finite(close) || !Number.isInteger(order.quantity) || order.quantity <= 0) continue;
        const position = positions.get(order.symbol);
        if (order.side === "SELL") {
          const quantity = Math.min(order.quantity, sellable[order.symbol] ?? 0);
          if (!quantity || !position) continue;
          const price = close * (1 - slip);
          const fee = computeFees(market, "SELL", quantity, price, fees).total;
          const released = position.cost / position.quantity * quantity;
          cash += quantity * price - fee;
          trades.push({ date, symbol: order.symbol, side: "SELL", quantity, price: round(price, 4), pnl: round(quantity * price - fee - released) });
          position.cost -= released;
          position.quantity -= quantity;
          let left = quantity;
          for (const lot of position.lots) { const used = Math.min(left, lot.quantity); lot.quantity -= used; left -= used; }
          position.lots = position.lots.filter((lot) => lot.quantity > 0);
          sellable[order.symbol] -= quantity;
          if (position.quantity <= 0) positions.delete(order.symbol);
        } else {
          const lot = lotRules({ market, lotOverrides: {} }, order.symbol, { lotSize: 100 }).lotSize ?? 1;
          const price = close * (1 + slip);
          let quantity = Math.floor(order.quantity / lot) * lot;
          const floor = finite(minCashPct) ? (cash + value()) * minCashPct / 100 : 0;
          while (quantity > 0 && cash - quantity * price - computeFees(market, "BUY", quantity, price, fees).total < floor) quantity -= lot;
          if (quantity <= 0) { notes.add("有买单因为保留现金的边界被缩小或跳过。"); continue; }
          const fee = computeFees(market, "BUY", quantity, price, fees).total;
          cash -= quantity * price + fee;
          const next = position ?? { quantity: 0, cost: 0, lots: [], lastPrice: close };
          next.quantity += quantity;
          next.cost += quantity * price + fee;
          next.lots.push({ date, quantity });
          positions.set(order.symbol, next);
          trades.push({ date, symbol: order.symbol, side: "BUY", quantity, price: round(price, 4) });
        }
      }
      for (const [symbol, position] of positions) if (finite(closes.get(symbol))) position.lastPrice = closes.get(symbol);
      curve.push({ date, equity: round(cash + value()) });
    }
  } finally { await sandbox.close(); }
  let peak = -Infinity, maxDrawdownPct = 0;
  for (const point of curve) { peak = Math.max(peak, point.equity); maxDrawdownPct = Math.min(maxDrawdownPct, (point.equity / peak - 1) * 100); }
  const bench = byDate.get(BENCHMARKS[market]);
  const benchFirst = bench?.get(calendar[0])?.close, benchLast = bench?.get(calendar.at(-1))?.close;
  const sells = trades.filter((trade) => trade.side === "SELL");
  return {
    ok: true, from: calendar[0], to: calendar.at(-1), sessions: curve.length,
    totalReturnPct: round((curve.at(-1).equity / initialCash - 1) * 100), maxDrawdownPct: round(maxDrawdownPct),
    benchmarkReturnPct: finite(benchFirst) && finite(benchLast) ? round((benchLast / benchFirst - 1) * 100) : null,
    trades: trades.length, closedTrades: sells.length, winRatePct: sells.length ? round(sells.filter((trade) => trade.pnl > 0).length / sells.length * 100, 1) : null,
    curve: curve.filter((_, index) => index % Math.max(1, Math.floor(curve.length / 60)) === 0 || index === curve.length - 1),
    notes: [...notes, ...(missing.length ? [`这些股票拿不到真实日线，没有参与回测：${missing.join("、")}`] : []), ...(sells.length < 10 ? ["平仓不到 10 笔，回测结果参考意义有限。"] : [])],
    basis: "真实日线（Yahoo / 腾讯），收盘价成交，加滑点和当前费率",
  };
}

// Dry run: one live round through the regular runtime with a broker that records instead of trading.
export async function dryRunCode({ code, meta = {}, account, params = {}, strategyId, now = () => new Date().toISOString(), deps = {} }) {
  const intents = [];
  const broker = {
    mode: "dry-run",
    account: async () => account,
    async placeOrder(intent) { intents.push(intent); return { order: { status: "dry-run" } }; },
  };
  const strategy = sandboxedStrategy({ id: strategyId, code, meta, market: account.market });
  try {
    const round = await runStrategyRound({ strategy, params, broker, now, runId: null, historyProvider: deps.historyProvider ?? getHistoricalQuote, quoteProvider: deps.quoteProvider ?? getTradeQuote, intradayProvider: deps.intradayProvider ?? getIntradayBars, scanProvider: deps.scanProvider ?? scanMarket });
    return { ok: true, orders: intents.map(({ symbol, side, quantity, reason }) => ({ symbol, side, quantity, reason })), logs: round.logs.slice(-20) };
  } catch (error) {
    return { ok: false, error: error.message, orders: intents };
  }
}

// Check a candidate without running it: static rules plus loading it in a sandbox.
export async function inspectCode(code) {
  prepareStrategyCode(code);
  const sandbox = await openSandbox(code);
  try { return sandbox.meta; } finally { await sandbox.close(); }
}

// Write, check and (if it passes) activate a new version of a trader's code strategy.
//   1. static rules and a sandbox load   2. dry run on live data   3. backtest on real daily bars
// A version that fails any step is kept as "rejected" with the reason; the live version stays.
export async function writeTraderStrategy({ arena, scheduler, store, accountId, code, changeNote, params = {}, intervalMinutes, universe, caller = {}, backtestSessions = 120, deps = {} }) {
  const account = await arena.getAccount(accountId, { sync: false, limit: 5 });
  arena.assertTrader?.(account, caller);
  const strategyId = traderStrategyId(accountId);
  const by = caller?.client && caller.client !== "dashboard" ? { kind: "agent", client: caller.client } : { kind: "owner" };
  const pool = universe?.length ? universe : params.universe?.length ? params.universe : account.watchlist?.symbols?.length ? account.watchlist.symbols : account.positions.map((position) => position.symbol);
  const entry = await store.addVersion(accountId, { code, changeNote, by, params, intervalMinutes: intervalMinutes ?? null, universe: universe ?? null });
  const reject = async (stage, error) => ({ ...(await store.updateVersion(accountId, entry.version, { status: "rejected", rejectedAt: stage, error })), live: (await store.meta(accountId)).live });
  let meta;
  try { meta = await inspectCode(code); } catch (error) { return reject("load", error.message); }
  let resolved;
  try { resolved = resolveParams({ params: meta.params ?? {} }, params); } catch (error) { return reject("params", error.message); }
  const dryRun = await dryRunCode({ code, meta, account, params: { ...resolved, ...(universe?.length ? { universe } : {}) }, strategyId, deps });
  if (!dryRun.ok) { await store.updateVersion(accountId, entry.version, { dryRun }); return reject("dry-run", dryRun.error); }
  const settings = await arena.workbenchSettings?.().catch(() => null);
  const backtest = await backtestCode({ code, market: account.market, universe: pool, params: resolved, sessions: backtestSessions, initialCash: account.initialCash, minCashPct: account.limits?.minCashPct ?? null, fees: settings?.fees?.[account.market], historyProvider: deps.historyProvider });
  if (!backtest.ok) { await store.updateVersion(accountId, entry.version, { dryRun, backtest }); return reject("backtest", backtest.error); }
  const previous = (await store.meta(accountId)).versions.find((item) => item.status === "live");
  const live = await store.updateVersion(accountId, entry.version, { status: "live", liveAt: new Date().toISOString(), meta, dryRun, backtest });
  // Trades from now on are attributed to this version.
  await arena.updateStrategy({ accountId, summary: account.strategy?.summary?.trim() || `代码策略 ${strategyId}`, changeNote: `代码策略 v${entry.version}${changeNote ? `：${changeNote}` : ""}` }, caller.client === "dashboard" ? {} : caller).catch(() => {});
  const jobs = await scheduler.listJobs();
  const job = jobs.find((item) => item.accountId === accountId);
  const every = intervalMinutes ?? job?.strategy?.intervalMinutes ?? 5;
  if (job && job.runner.type !== "strategy") await scheduler.upsertJob(accountId, { strategy: { strategyId, intervalMinutes: every, params: resolved }, mode: "director" });
  else await scheduler.upsertJob(accountId, { intervalMinutes: every, times: [], runner: { type: "strategy", strategyId, params: resolved, timeoutMinutes: 5 } });
  return { ...live, live: entry.version, previous: previous ? { version: previous.version, backtest: previous.backtest ?? null } : null, intervalMinutes: every };
}

export async function rollbackTraderStrategy({ arena, scheduler, store, accountId, version, caller = {} }) {
  const account = await arena.getAccount(accountId, { sync: false, limit: 1 });
  arena.assertTrader?.(account, caller);
  const info = await store.meta(accountId);
  const target = info.versions.find((item) => item.version === Number(version));
  if (!target) throw new Error(`Version ${version} not found.`);
  if (!target.meta) throw new Error(`Version ${version} never passed its checks; it cannot go live.`);
  const entry = await store.updateVersion(accountId, target.version, { status: "live", liveAt: new Date().toISOString(), rolledBackBy: caller.client ?? "dashboard" });
  await arena.updateStrategy({ accountId, summary: account.strategy?.summary?.trim() || `代码策略 ${traderStrategyId(accountId)}`, changeNote: `回退到代码策略 v${target.version}` }, caller.client === "dashboard" ? {} : caller).catch(() => {});
  const job = (await scheduler.listJobs()).find((item) => item.accountId === accountId);
  if (job?.strategy) await scheduler.upsertJob(accountId, { strategy: { ...job.strategy, params: target.params && Object.keys(target.params).length ? resolveParams({ params: target.meta.params ?? {} }, target.params) : job.strategy.params } });
  return entry;
}

export { resolveParams };
