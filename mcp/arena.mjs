// Agent Arena: a local, agent-neutral paper exchange for comparing agents and models.
//
// Every account belongs to one market (A / HK / US) and one currency, so accounts in the
// same market and competition start from the same cash and are directly comparable.
// Orders fill only against real public quotes observed during a regular session, with
// board lots, A-share T+1 and price limits, exchange-style fees and configurable slippage.
// State lives under <storage>/arena and is shared by every MCP process (Codex, Claude Code,
// WorkBuddy, ...) through a cross-process lock, so one dashboard shows every agent.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStorageDir, getTradeQuote, marketFromSymbol, normalizeSymbol } from "./core.mjs";
import { getInstrumentRules, getMarketSession, localMarketTime, marketLocalToIso } from "./market-rules.mjs";

export const ARENA_MARKETS = {
  A: { currency: "CNY", defaultCash: 1000000, benchmark: "000300.SS", benchmarkName: "沪深300 / CSI 300" },
  HK: { currency: "HKD", defaultCash: 1000000, benchmark: "^HSI", benchmarkName: "恒生指数 / Hang Seng" },
  US: { currency: "USD", defaultCash: 100000, benchmark: "^GSPC", benchmarkName: "标普500 / S&P 500" },
};
const LIMITS = { orders: 5000, trades: 5000, journal: 2000, equity: 6000, strategyHistory: 200 };
const SYNC_THROTTLE_MS = 20000;
const QUOTE_CACHE_MS = 10000;
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 20000;

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const shortId = (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`;

export function normalizeTradeSymbol(input) {
  const raw = String(input ?? "").trim().toUpperCase();
  const hk = raw.match(/^(?:HK)?0*(\d{1,5})(?:\.HK)?$/);
  if (hk && (raw.endsWith(".HK") || raw.startsWith("HK") || /^\d{1,4}$/.test(raw) || /^0\d{4}$/.test(raw))) return `${hk[1].padStart(4, "0")}.HK`;
  return normalizeSymbol(raw);
}

function isIndexSymbol(symbol) {
  return symbol.startsWith("^") || /^000\d{3}\.SS$/.test(symbol) || /^399\d{3}\.SZ$/.test(symbol) || getInstrumentRules(symbol).instrumentType === "index";
}

export class ArenaError extends Error {
  constructor(message, code = "invalid_request", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Exchange rules
// ---------------------------------------------------------------------------

// Approximate retail schedules. They are documented presets, not broker quotes.
export function computeFees(market, side, quantity, price) {
  const value = quantity * price;
  const parts = {};
  if (market === "A") {
    parts.commission = Math.max(5, value * 0.00025);
    parts.stampDuty = side === "SELL" ? value * 0.0005 : 0;
    parts.transferFee = value * 0.00001;
  } else if (market === "HK") {
    parts.commission = Math.max(3, value * 0.0003);
    parts.stampDuty = Math.ceil(value * 0.001);
    parts.tradingFee = value * 0.0000565;
    parts.sfcLevy = value * 0.000027;
    parts.frcLevy = value * 0.0000015;
    parts.settlement = clamp(value * 0.00002, 2, 100);
  } else {
    parts.commission = clamp(quantity * 0.005, 1, value * 0.01);
    parts.secFee = side === "SELL" ? value * 0.0000278 : 0;
    parts.taf = side === "SELL" ? Math.min(quantity * 0.000166, 8.3) : 0;
  }
  const breakdown = Object.fromEntries(Object.entries(parts).filter(([, amount]) => amount > 0).map(([key, amount]) => [key, round(amount)]));
  return { total: round(Object.values(breakdown).reduce((sum, amount) => sum + amount, 0)), breakdown };
}

export function tickSize(market, price) {
  if (market === "HK") {
    const table = [[0.25, 0.001], [0.5, 0.005], [10, 0.01], [20, 0.02], [100, 0.05], [200, 0.1], [500, 0.2], [1000, 0.5], [2000, 1], [5000, 2]];
    return table.find(([ceiling]) => price < ceiling)?.[1] ?? 5;
  }
  if (market === "US") return price < 1 ? 0.0001 : 0.01;
  return 0.01;
}

function alignToTick(market, price, direction) {
  const tick = tickSize(market, price);
  const units = price / tick;
  const aligned = (direction === "up" ? Math.ceil(units - 1e-9) : Math.floor(units + 1e-9)) * tick;
  return round(aligned, tick < 0.01 ? 4 : 3);
}

export function lotRules(account, symbol, quote) {
  const rules = getInstrumentRules(symbol);
  if (account.market === "A") {
    const star = rules.board === "STAR";
    return { lotSize: star ? 1 : 100, minimumBuy: star ? 200 : 100, tPlusOne: true, source: "exchange rule" };
  }
  if (account.market === "HK") {
    const lot = account.lotOverrides?.[symbol] ?? quote?.lotSize ?? null;
    return { lotSize: lot, minimumBuy: lot, tPlusOne: false, source: account.lotOverrides?.[symbol] ? "account override" : "Tencent board lot" };
  }
  return { lotSize: 1, minimumBuy: 1, tPlusOne: false, source: "exchange rule" };
}

// Session date of the session an order placed now is eligible to trade in.
function eligibleSession(market, now) {
  const today = getMarketSession(market, now);
  if (["premarket", "open", "break"].includes(today.status)) return today;
  for (let offset = 1; offset <= 20; offset += 1) {
    const date = new Date(Date.parse(`${today.date}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
    const session = getMarketSession(market, marketLocalToIso(date, 720, market));
    if (session.status !== "closed") return session;
  }
  return today;
}

// A fill needs a real quote observed inside the current regular session.
export function tradability(account, quote, now = new Date().toISOString()) {
  if (!quote) return { ok: false, reason: "no-quote" };
  const session = getMarketSession(account.market, now);
  if (session.status !== "open") return { ok: false, reason: `market-${session.status}`, session };
  const ageSeconds = (Date.parse(now) - Date.parse(quote.asOf)) / 1000;
  const maxAge = account.settings?.maxQuoteAgeSeconds ?? 180;
  if (!Number.isFinite(ageSeconds)) return { ok: false, reason: "quote-time-unknown", session };
  if (ageSeconds > maxAge) return { ok: false, reason: "quote-stale", ageSeconds: round(ageSeconds, 0), session };
  if (ageSeconds < -60) return { ok: false, reason: "quote-in-future", session };
  if (localMarketTime(quote.asOf, account.market)?.date !== session.date) return { ok: false, reason: "quote-other-session", session };
  return { ok: true, ageSeconds: round(Math.max(0, ageSeconds), 0), session, calendarVerified: session.verified };
}

// Execution price for an order against an observed quote, or null when it cannot fill now.
export function executionPrice(account, order, quote) {
  const slip = (account.settings?.slippageBps ?? 5) / 10000;
  const market = account.market;
  if (order.side === "BUY") {
    if (market === "A" && finite(quote.limitUp) && quote.price >= quote.limitUp - 1e-9) return { price: null, blocked: "limit-up" };
    let price = alignToTick(market, quote.price * (1 + slip), "up");
    if (market === "A" && finite(quote.limitUp)) price = Math.min(price, quote.limitUp);
    if (order.type === "limit") {
      if (quote.price > order.limitPrice + 1e-9) return { price: null, blocked: "limit-not-reached" };
      price = Math.min(price, order.limitPrice);
    }
    return { price };
  }
  if (market === "A" && finite(quote.limitDown) && quote.price <= quote.limitDown + 1e-9) return { price: null, blocked: "limit-down" };
  let price = alignToTick(market, quote.price * (1 - slip), "down");
  if (market === "A" && finite(quote.limitDown)) price = Math.max(price, quote.limitDown);
  if (order.type === "limit") {
    if (quote.price < order.limitPrice - 1e-9) return { price: null, blocked: "limit-not-reached" };
    price = Math.max(price, order.limitPrice);
  }
  return { price };
}

// ---------------------------------------------------------------------------
// Portfolio accounting
// ---------------------------------------------------------------------------

function openOrders(account) {
  return account.orders.filter((order) => order.status === "open");
}

export function reservedCash(account, excludeOrderId) {
  return round(openOrders(account).filter((order) => order.side === "BUY" && order.id !== excludeOrderId)
    .reduce((sum, order) => sum + order.reserved, 0));
}

export function sellableQuantity(account, symbol, now = new Date().toISOString(), excludeOrderId) {
  const position = account.positions[symbol];
  if (!position) return 0;
  const today = localMarketTime(now, account.market)?.date;
  const settled = account.market === "A"
    ? position.lots.filter((lot) => lot.date < today).reduce((sum, lot) => sum + lot.quantity, 0)
    : position.quantity;
  const pending = openOrders(account).filter((order) => order.side === "SELL" && order.symbol === symbol && order.id !== excludeOrderId)
    .reduce((sum, order) => sum + order.quantity, 0);
  return Math.max(0, settled - pending);
}

function applyFill(account, order, price, quote, now) {
  const fees = computeFees(account.market, order.side, order.quantity, price);
  const gross = round(order.quantity * price);
  const tradeDate = localMarketTime(now, account.market).date;
  let position = account.positions[order.symbol];
  let realizedPnl = null;
  if (order.side === "BUY") {
    position ??= { symbol: order.symbol, name: quote?.name ?? order.name ?? order.symbol, quantity: 0, costBasis: 0, realizedPnl: 0, lots: [], openedAt: now };
    position.costBasis = round(position.costBasis + gross + fees.total);
    position.quantity += order.quantity;
    const lot = position.lots.find((entry) => entry.date === tradeDate);
    if (lot) lot.quantity += order.quantity;
    else position.lots.push({ date: tradeDate, quantity: order.quantity });
    account.cash = round(account.cash - gross - fees.total);
    account.positions[order.symbol] = position;
  } else {
    const averageCost = position.costBasis / position.quantity;
    const releasedCost = averageCost * order.quantity;
    realizedPnl = round(gross - fees.total - releasedCost);
    position.costBasis = round(position.costBasis - releasedCost);
    position.quantity -= order.quantity;
    position.realizedPnl = round(position.realizedPnl + realizedPnl);
    let remaining = order.quantity;
    for (const lot of position.lots) {
      const used = Math.min(lot.quantity, remaining);
      lot.quantity -= used;
      remaining -= used;
    }
    position.lots = position.lots.filter((lot) => lot.quantity > 0);
    account.cash = round(account.cash + gross - fees.total);
    account.realizedPnl = round((account.realizedPnl ?? 0) + realizedPnl);
    if (position.quantity <= 0) {
      account.closedPositions = [...(account.closedPositions ?? []), { symbol: position.symbol, name: position.name, realizedPnl: position.realizedPnl, openedAt: position.openedAt, closedAt: now }].slice(-500);
      delete account.positions[order.symbol];
    }
  }
  if (account.positions[order.symbol]) {
    account.positions[order.symbol].lastPrice = quote?.price ?? price;
    account.positions[order.symbol].lastPriceAt = quote?.asOf ?? now;
  }
  Object.assign(order, {
    status: "filled", filledAt: now, fillPrice: price, fees: fees.total, reserved: 0,
    fillQuote: quote ? { price: quote.price, asOf: quote.asOf, source: quote.provider ?? quote.source } : null,
  });
  const trade = {
    id: shortId("trd"), orderId: order.id, symbol: order.symbol, name: account.positions[order.symbol]?.name ?? quote?.name ?? order.symbol,
    side: order.side, quantity: order.quantity, price, gross, fees: fees.total, feeBreakdown: fees.breakdown,
    realizedPnl, at: now, reason: order.reason, confidence: order.confidence ?? null, strategyVersion: order.strategyVersion,
  };
  account.trades.push(trade);
  if (account.trades.length > LIMITS.trades) account.trades = account.trades.slice(-LIMITS.trades);
  return trade;
}

export function valuation(account) {
  const positions = Object.values(account.positions).map((position) => {
    const price = finite(position.lastPrice) ? position.lastPrice : position.costBasis / position.quantity;
    const marketValue = round(price * position.quantity);
    const averageCost = position.quantity ? position.costBasis / position.quantity : 0;
    return {
      ...position, averageCost: round(averageCost, 4), marketValue,
      unrealizedPnl: round(marketValue - position.costBasis),
      unrealizedPnlPct: position.costBasis > 0 ? round((marketValue / position.costBasis - 1) * 100, 2) : null,
    };
  });
  const marketValue = round(positions.reduce((sum, position) => sum + position.marketValue, 0));
  const equity = round(account.cash + marketValue);
  return {
    equity, cash: account.cash, marketValue, reservedCash: reservedCash(account),
    availableCash: round(account.cash - reservedCash(account)),
    positions: positions.map((position) => ({ ...position, weightPct: equity > 0 ? round(position.marketValue / equity * 100, 2) : 0 }))
      .sort((a, b) => b.marketValue - a.marketValue),
  };
}

function recordEquity(account, now, force = false) {
  const { equity, cash, marketValue } = valuation(account);
  const last = account.equity.at(-1);
  const elapsed = last ? Date.parse(now) - Date.parse(last.at) : Infinity;
  if (!force && last && (elapsed < 60000 || (elapsed < 300000 && Math.abs(last.equity - equity) < 0.005))) return;
  account.equity.push({ at: now, equity, cash, marketValue });
  if (account.equity.length > LIMITS.equity) {
    // Keep the first point and thin the oldest half to preserve the whole history at lower resolution.
    const [first, ...rest] = account.equity;
    const half = Math.floor(rest.length / 2);
    account.equity = [first, ...rest.slice(0, half).filter((_, index) => index % 2 === 0), ...rest.slice(half)];
  }
}

// ---------------------------------------------------------------------------
// Performance metrics
// ---------------------------------------------------------------------------

export function computeMetrics(account, { benchmarkPrice = null } = {}) {
  const value = valuation(account);
  const initial = account.initialCash;
  const points = [{ at: account.createdAt, equity: initial }, ...account.equity, { at: new Date().toISOString(), equity: value.equity }];
  let peak = -Infinity;
  let maxDrawdownPct = 0;
  for (const point of points) {
    peak = Math.max(peak, point.equity);
    if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, (point.equity / peak - 1) * 100);
  }
  const daily = new Map();
  for (const point of points) daily.set(localMarketTime(point.at, account.market)?.date ?? point.at.slice(0, 10), point.equity);
  const closes = [...daily.values()];
  const returns = closes.slice(1).map((close, index) => close / closes[index] - 1).filter(Number.isFinite);
  let volatilityPct = null;
  let sharpe = null;
  if (returns.length >= 5) {
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const deviation = Math.sqrt(variance);
    volatilityPct = round(deviation * Math.sqrt(252) * 100, 2);
    sharpe = deviation > 0 ? round(mean / deviation * Math.sqrt(252), 2) : null;
  }
  const sells = account.trades.filter((trade) => trade.side === "SELL" && finite(trade.realizedPnl));
  const wins = sells.filter((trade) => trade.realizedPnl > 0);
  const losses = sells.filter((trade) => trade.realizedPnl < 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.realizedPnl, 0));
  const totalReturnPct = round((value.equity / initial - 1) * 100, 2);
  const benchmarkReturnPct = finite(benchmarkPrice) && finite(account.benchmark?.startPrice) && account.benchmark.startPrice > 0
    ? round((benchmarkPrice / account.benchmark.startPrice - 1) * 100, 2) : null;
  const days = Math.max(0, (Date.now() - Date.parse(account.createdAt)) / 86400000);
  const today = localMarketTime(new Date().toISOString(), account.market)?.date;
  const previousClose = [...daily.entries()].filter(([date]) => date < today).at(-1)?.[1] ?? initial;
  const byVersion = new Map();
  for (const trade of account.trades) {
    const key = trade.strategyVersion ?? 1;
    const entry = byVersion.get(key) ?? { version: key, trades: 0, closedTrades: 0, wins: 0, realizedPnl: 0, fees: 0 };
    entry.trades += 1;
    entry.fees = round(entry.fees + trade.fees);
    if (finite(trade.realizedPnl)) {
      entry.closedTrades += 1;
      entry.realizedPnl = round(entry.realizedPnl + trade.realizedPnl);
      if (trade.realizedPnl > 0) entry.wins += 1;
    }
    byVersion.set(key, entry);
  }
  return {
    equity: value.equity, cash: value.cash, marketValue: value.marketValue, availableCash: value.availableCash,
    totalPnl: round(value.equity - initial), totalReturnPct,
    todayReturnPct: previousClose > 0 ? round((value.equity / previousClose - 1) * 100, 2) : null,
    annualizedReturnPct: days >= 30 ? round(((value.equity / initial) ** (365 / days) - 1) * 100, 2) : null,
    maxDrawdownPct: round(maxDrawdownPct, 2), volatilityPct, sharpe,
    benchmarkSymbol: account.benchmark?.symbol ?? null, benchmarkReturnPct,
    excessReturnPct: benchmarkReturnPct === null ? null : round(totalReturnPct - benchmarkReturnPct, 2),
    realizedPnl: round(account.realizedPnl ?? 0), unrealizedPnl: round(value.positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)),
    exposurePct: value.equity > 0 ? round(value.marketValue / value.equity * 100, 2) : 0,
    positions: value.positions.length,
    trades: account.trades.length, closedTrades: sells.length,
    winRatePct: sells.length ? round(wins.length / sells.length * 100, 1) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 2) : null,
    averageWin: wins.length ? round(grossWin / wins.length) : null,
    averageLoss: losses.length ? round(-grossLoss / losses.length) : null,
    feesPaid: round(account.trades.reduce((sum, trade) => sum + trade.fees, 0)),
    turnover: initial > 0 ? round(account.trades.reduce((sum, trade) => sum + trade.gross, 0) / initial, 2) : 0,
    ordersPlaced: account.orders.length,
    ordersRejected: account.orders.filter((order) => order.status === "rejected").length,
    openOrders: openOrders(account).length,
    decisionsLogged: account.journal.length,
    daysActive: round(days, 1), tradingDays: closes.length - 1,
    sampleWarning: closes.length < 6 ? "fewer-than-5-trading-days" : sells.length < 10 ? "fewer-than-10-closed-trades" : null,
    byStrategyVersion: [...byVersion.values()].map((entry) => ({ ...entry, winRatePct: entry.closedTrades ? round(entry.wins / entry.closedTrades * 100, 1) : null })),
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function createArena({ root = path.join(getStorageDir(), "arena"), quoteProvider = getTradeQuote, now = () => new Date().toISOString(), quoteCacheMs = QUOTE_CACHE_MS } = {}) {
  const accountDir = path.join(root, "accounts");
  const lockDir = path.join(root, ".lock");
  const quoteCache = new Map();
  const lastSync = new Map();

  async function withLock(task) {
    await mkdir(root, { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        await mkdir(lockDir);
        await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let stale = false;
        try {
          const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
          stale = Date.now() - owner.at > LOCK_STALE_MS || !processAlive(owner.pid);
        } catch {
          // Owner file not written yet, or a crashed writer: rely on the directory age.
          try { stale = Date.now() - (await stat(lockDir)).mtimeMs > LOCK_STALE_MS; } catch { stale = false; }
        }
        if (stale) { await rm(lockDir, { recursive: true, force: true }); continue; }
        if (Date.now() - started > LOCK_WAIT_MS) throw new ArenaError("Arena is busy; another agent is writing. Retry shortly.", "busy", 503);
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 40));
      }
    }
    try { return await task(); } finally { await rm(lockDir, { recursive: true, force: true }); }
  }

  const accountPath = (id) => {
    if (!/^acc_[a-f0-9]{12}$/.test(id ?? "")) throw new ArenaError(`Invalid account id: ${id}`, "invalid_account");
    return path.join(accountDir, `${id}.json`);
  };

  async function load(id) {
    try { return JSON.parse(await readFile(accountPath(id), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw new ArenaError(`Account ${id} not found. Call arena_my_accounts or arena_register_account.`, "not_found", 404);
      throw error;
    }
  }

  async function save(account) {
    await mkdir(accountDir, { recursive: true });
    account.updatedAt = now();
    const file = accountPath(account.id);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(account, null, 1), "utf8");
    await rename(temporary, file);
  }

  async function loadAll() {
    let names = [];
    try { names = await readdir(accountDir); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const accounts = [];
    for (const name of names.filter((entry) => /^acc_[a-f0-9]{12}\.json$/.test(entry))) {
      try { accounts.push(JSON.parse(await readFile(path.join(accountDir, name), "utf8"))); } catch { /* Skip a file mid-write; the next read sees it. */ }
    }
    return accounts.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async function quote(symbol, { fresh = false } = {}) {
    const cached = quoteCache.get(symbol);
    if (!fresh && cached && Date.now() - cached.fetchedAt < quoteCacheMs) return cached.value;
    const value = await quoteProvider(symbol);
    quoteCache.set(symbol, { value, fetchedAt: Date.now() });
    return value;
  }

  async function quotes(symbols, options) {
    const result = new Map();
    const queue = [...new Set(symbols)];
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) {
        const symbol = queue.shift();
        try { result.set(symbol, await quote(symbol, options)); } catch (error) { result.set(symbol, { error: error.message }); }
      }
    }));
    return result;
  }

  function assertCaller(account, caller) {
    if (!caller?.client || caller.client === "dashboard") return;
    if (!account.agent.client || account.agent.client === "dashboard") {
      account.agent.client = caller.client;
      account.agent.clientVersion = caller.clientVersion ?? null;
      return;
    }
    if (account.agent.client !== caller.client)
      throw new ArenaError(`Account ${account.id} belongs to agent "${account.agent.client}", not "${caller.client}". Each agent must trade only its own account.`, "forbidden", 403);
  }

  function assertActive(account) {
    if (account.status !== "active") throw new ArenaError(`Account ${account.id} is ${account.status}.`, "inactive", 409);
  }

  // Apply observed quotes: expire day orders, fill marketable open orders, mark positions.
  function settle(account, quoteMap, at) {
    const events = [];
    for (const order of openOrders(account)) {
      if (Date.parse(order.expiresAt) <= Date.parse(at)) {
        Object.assign(order, { status: "expired", closedAt: at, reserved: 0 });
        events.push({ type: "expired", orderId: order.id, symbol: order.symbol });
      }
    }
    for (const order of openOrders(account)) {
      const observed = quoteMap.get(order.symbol);
      if (!observed || observed.error || !tradability(account, observed, at).ok) continue;
      const execution = executionPrice(account, order, observed);
      if (execution.price === null) continue;
      if (order.side === "SELL" && (account.positions[order.symbol]?.quantity ?? 0) < order.quantity) {
        Object.assign(order, { status: "rejected", closedAt: at, reserved: 0, rejectReason: "Position no longer covers this sell order." });
        continue;
      }
      if (order.side === "BUY") {
        const cost = order.quantity * execution.price + computeFees(account.market, "BUY", order.quantity, execution.price).total;
        if (cost > account.cash - reservedCash(account, order.id) + 1e-6) {
          Object.assign(order, { status: "rejected", closedAt: at, reserved: 0, rejectReason: "Insufficient cash at fill time." });
          continue;
        }
      }
      const trade = applyFill(account, order, execution.price, observed, at);
      events.push({ type: "filled", orderId: order.id, tradeId: trade.id, symbol: order.symbol, side: order.side, quantity: order.quantity, price: execution.price });
    }
    for (const position of Object.values(account.positions)) {
      const observed = quoteMap.get(position.symbol);
      if (observed && !observed.error && finite(observed.price)) {
        position.lastPrice = observed.price;
        position.lastPriceAt = observed.asOf ?? at;
        position.name = position.name === position.symbol ? observed.name ?? position.name : position.name;
      }
    }
    const benchmark = quoteMap.get(account.benchmark?.symbol);
    if (benchmark && !benchmark.error && finite(benchmark.price)) {
      account.benchmark.lastPrice = benchmark.price;
      account.benchmark.lastPriceAt = benchmark.asOf ?? at;
      if (!finite(account.benchmark.startPrice)) { account.benchmark.startPrice = benchmark.price; account.benchmark.startAt = at; }
    }
    if (account.status === "active") recordEquity(account, at);
    return events;
  }

  async function sync(ids, { force = false } = {}) {
    const all = await loadAll();
    const targets = all.filter((account) => account.status === "active" && (!ids || ids.includes(account.id))
      && (force || Date.now() - (lastSync.get(account.id) ?? 0) > SYNC_THROTTLE_MS));
    if (!targets.length) return { synced: 0, events: [] };
    const symbols = targets.flatMap((account) => [...Object.keys(account.positions), ...openOrders(account).map((order) => order.symbol), account.benchmark?.symbol].filter(Boolean));
    const quoteMap = await quotes(symbols);
    const events = [];
    await withLock(async () => {
      for (const target of targets) {
        const account = await load(target.id);
        const at = now();
        events.push(...settle(account, quoteMap, at).map((event) => ({ ...event, accountId: account.id })));
        await save(account);
        lastSync.set(account.id, Date.now());
      }
    });
    return { synced: targets.length, events };
  }

  // Daily closing return curve (plus the live point) for overlaying many accounts in one chart.
  function returnCurve(account, equityNow) {
    const daily = new Map();
    for (const point of [{ at: account.createdAt, equity: account.initialCash }, ...account.equity]) {
      daily.set(localMarketTime(point.at, account.market)?.date ?? point.at.slice(0, 10), point);
    }
    const points = [...daily.values()].slice(-180).map((point) => ({ at: point.at, returnPct: round((point.equity / account.initialCash - 1) * 100, 3) }));
    points.push({ at: now(), returnPct: round((equityNow / account.initialCash - 1) * 100, 3) });
    return points;
  }

  function publicAccount(account, { detail = false, limit = 50 } = {}) {
    const metrics = computeMetrics(account, { benchmarkPrice: account.benchmark?.lastPrice ?? null });
    const value = valuation(account);
    const summary = {
      id: account.id, name: account.name, competition: account.competition, market: account.market, currency: account.currency,
      agent: account.agent, model: account.model, strategy: { version: account.strategy.version, summary: account.strategy.summary, updatedAt: account.strategy.updatedAt },
      status: account.status, createdAt: account.createdAt, updatedAt: account.updatedAt, createdBy: account.createdBy,
      initialCash: account.initialCash, settings: account.settings, benchmark: account.benchmark, metrics, demo: account.demo === true,
      curve: returnCurve(account, metrics.equity),
      lastTradeAt: account.trades.at(-1)?.at ?? null, lastActivityAt: [account.trades.at(-1)?.at, account.journal.at(-1)?.at, account.orders.at(-1)?.createdAt].filter(Boolean).sort().at(-1) ?? null,
    };
    if (!detail) return summary;
    return {
      ...summary, positions: value.positions, openOrders: openOrders(account),
      orders: account.orders.slice(-limit).reverse(), trades: account.trades.slice(-limit).reverse(),
      journal: account.journal.slice(-limit).reverse(), equity: account.equity,
      strategyHistory: account.strategy.history, closedPositions: (account.closedPositions ?? []).slice(-limit).reverse(),
      lotOverrides: account.lotOverrides ?? {},
    };
  }

  return {
    root,

    async createAccount(input, caller = {}) {
      const market = String(input.market ?? "").toUpperCase();
      const config = ARENA_MARKETS[market];
      if (!config) throw new ArenaError("market must be A, HK or US.");
      const name = String(input.name ?? "").trim();
      const model = String(input.model ?? "").trim();
      if (!name || name.length > 60) throw new ArenaError("name is required (at most 60 characters).");
      if (!model || model.length > 80) throw new ArenaError("model is required (e.g. claude-opus-5-5, gpt-5.5-codex). Report the model you are actually running on.");
      const initialCash = input.initialCash ?? config.defaultCash;
      if (!finite(initialCash) || initialCash < 1000 || initialCash > 1e10) throw new ArenaError("initialCash must be between 1,000 and 10,000,000,000.");
      const competition = String(input.competition ?? "default").trim().slice(0, 40) || "default";
      const at = now();
      const account = {
        schemaVersion: 1, id: shortId("acc"), name, competition, market, currency: config.currency, status: "active",
        agent: { client: caller.client && caller.client !== "dashboard" ? caller.client : (input.agentClient ?? null), clientVersion: caller.clientVersion ?? null, label: String(input.agentLabel ?? input.agentClient ?? caller.client ?? "").slice(0, 60) || null },
        model,
        strategy: { version: 1, summary: String(input.strategySummary ?? "").slice(0, 2000), updatedAt: at, history: [{ version: 1, summary: String(input.strategySummary ?? "").slice(0, 2000), note: "initial", at }] },
        initialCash: round(initialCash), cash: round(initialCash), realizedPnl: 0,
        settings: { slippageBps: clamp(input.slippageBps ?? 5, 0, 100), maxQuoteAgeSeconds: clamp(input.maxQuoteAgeSeconds ?? 180, 30, 900), feeModel: `${market}-retail-v1` },
        benchmark: { symbol: config.benchmark, name: config.benchmarkName, startPrice: null, startAt: null },
        positions: {}, orders: [], trades: [], journal: [], equity: [{ at, equity: round(initialCash), cash: round(initialCash), marketValue: 0 }],
        createdAt: at, updatedAt: at, createdBy: caller.client ?? "dashboard",
      };
      try {
        const benchmark = await quote(config.benchmark);
        if (finite(benchmark.price)) Object.assign(account.benchmark, { startPrice: benchmark.price, startAt: at, lastPrice: benchmark.price, lastPriceAt: benchmark.asOf });
      } catch { /* The benchmark start is captured on the first successful sync instead. */ }
      await withLock(() => save(account));
      return publicAccount(account, { detail: true });
    },

    async listAccounts({ market, competition, status = "active", client } = {}) {
      const accounts = (await loadAll()).filter((account) => (!market || account.market === market)
        && (!competition || account.competition === competition) && (status === "all" || account.status === status)
        && (!client || account.agent.client === client));
      return accounts.map((account) => publicAccount(account));
    },

    async leaderboard({ market, competition, includeArchived = false, sync: shouldSync = true } = {}) {
      if (shouldSync) await sync().catch(() => {});
      const accounts = await this.listAccounts({ market, competition, status: includeArchived ? "all" : "active" });
      const groups = new Map();
      for (const account of accounts) {
        const key = `${account.market}:${account.competition}`;
        const group = groups.get(key) ?? { market: account.market, competition: account.competition, currency: account.currency, accounts: [] };
        group.accounts.push(account);
        groups.set(key, group);
      }
      return {
        generatedAt: now(),
        groups: [...groups.values()].map((group) => ({
          ...group,
          accounts: group.accounts.sort((a, b) => b.metrics.totalReturnPct - a.metrics.totalReturnPct || a.metrics.maxDrawdownPct - b.metrics.maxDrawdownPct)
            .map((account, index) => ({ ...account, rank: index + 1 })),
        })),
        notes: [
          "Ranks compare accounts in the same market and competition only; currencies are never mixed.",
          "Fills use public quotes observed when an agent or the dashboard syncs, plus slippage and fee presets. They approximate, not reproduce, broker execution.",
          "Short track records are noisy: check tradingDays, closedTrades and sampleWarning before concluding one agent is better.",
        ],
      };
    },

    async getAccount(id, { sync: shouldSync = true, limit = 50 } = {}) {
      if (shouldSync) await sync([id]).catch(() => {});
      return publicAccount(await load(id), { detail: true, limit });
    },

    async placeOrder(input, caller = {}) {
      const account = await load(input.accountId);
      assertActive(account);
      assertCaller(account, caller);
      const symbol = normalizeTradeSymbol(input.symbol);
      if (marketFromSymbol(symbol) !== account.market) throw new ArenaError(`${symbol} is not a ${account.market} security; this account trades ${account.market} only.`);
      if (isIndexSymbol(symbol)) throw new ArenaError(`${symbol} is an index and cannot be traded.`);
      const side = String(input.side ?? "").toUpperCase();
      if (!["BUY", "SELL"].includes(side)) throw new ArenaError("side must be BUY or SELL (long-only; no short selling).");
      const type = input.orderType === "limit" ? "limit" : "market";
      const quantity = Number(input.quantity);
      if (!Number.isInteger(quantity) || quantity <= 0) throw new ArenaError("quantity must be a positive integer number of shares.");
      if (type === "limit" && !(finite(input.limitPrice) && input.limitPrice > 0)) throw new ArenaError("limitPrice is required for limit orders.");
      const reason = String(input.reason ?? "").trim();
      if (reason.length < 10) throw new ArenaError("reason is required (at least 10 characters): explain the thesis so the decision can be reviewed.");
      if (input.clientOrderId) {
        const existing = account.orders.find((order) => order.clientOrderId === input.clientOrderId);
        if (existing) return { duplicate: true, order: existing, account: publicAccount(account) };
      }

      const observed = await quote(symbol, { fresh: true });
      const at = now();
      const rules = lotRules(account, symbol, observed);
      const session = eligibleSession(account.market, at);
      const order = {
        id: shortId("ord"), clientOrderId: input.clientOrderId ?? null, symbol, name: observed?.name ?? symbol, side, type, quantity,
        limitPrice: type === "limit" ? input.limitPrice : null, timeInForce: input.timeInForce === "gtc" ? "gtc" : "day",
        status: "open", reserved: 0, reason: reason.slice(0, 2000), confidence: finite(input.confidence) ? clamp(input.confidence, 0, 1) : null,
        horizon: input.horizon ?? null, strategyVersion: account.strategy.version, createdAt: at,
        expiresAt: input.timeInForce === "gtc" ? new Date(Date.parse(at) + 30 * 86400000).toISOString() : session.closeAt,
        quoteAtSubmit: observed ? { price: observed.price, asOf: observed.asOf, source: observed.provider ?? observed.source } : null,
        placedBy: caller.client ?? "unknown",
      };
      const reject = (message, code = "rejected") => { Object.assign(order, { status: "rejected", rejectReason: message, closedAt: at }); return { code, message }; };

      let failure = null;
      const tradable = tradability(account, observed, at);
      if (!rules.lotSize) failure = reject(`Board lot for ${symbol} is unknown; set a lot override in the dashboard before trading it.`);
      else if (side === "BUY" && quantity < rules.minimumBuy) failure = reject(`Minimum buy for ${symbol} is ${rules.minimumBuy} shares.`);
      else if (side === "BUY" && quantity % rules.lotSize !== 0) failure = reject(`Buy quantity must be a multiple of the board lot (${rules.lotSize}).`);
      if (!failure && side === "SELL") {
        const sellable = sellableQuantity(account, symbol, at);
        const held = account.positions[symbol]?.quantity ?? 0;
        if (!held) failure = reject(`No ${symbol} position to sell (long-only account).`);
        else if (quantity > sellable) failure = reject(rules.tPlusOne && sellable < held
          ? `Only ${sellable} shares are sellable: A-share T+1 locks shares bought today, and open sell orders reserve the rest.`
          : `Only ${sellable} shares are sellable (open sell orders reserve the rest).`);
        else if (quantity % rules.lotSize !== 0 && quantity !== sellable) failure = reject(`Sell quantity must be a multiple of ${rules.lotSize}, or the entire sellable odd lot (${sellable}).`);
      }
      if (!failure && type === "market" && !tradable.ok) {
        failure = reject(tradable.reason.startsWith("market-")
          ? `Market is ${tradable.session.status} now (${account.market} local ${tradable.session.date}). Market orders need an open session; use a limit order to rest until the session opens.`
          : `Quote not usable for a fill (${tradable.reason}). Retry when a fresh quote is available.`);
      }
      let execution = null;
      if (!failure && tradable.ok) {
        execution = executionPrice(account, order, observed);
        if (type === "market" && execution.price === null)
          failure = reject(execution.blocked === "limit-up" ? `${symbol} is at its daily limit-up; buy orders cannot fill.` : `${symbol} is at its daily limit-down; sell orders cannot fill.`);
      }
      if (!failure && side === "BUY") {
        const reference = execution?.price ?? (type === "limit" ? order.limitPrice : observed.price);
        const estimate = quantity * reference + computeFees(account.market, "BUY", quantity, reference).total;
        const available = account.cash - reservedCash(account);
        if (estimate > available + 1e-6) failure = reject(`Insufficient available cash: need about ${round(estimate)} ${account.currency}, available ${round(available)}.`);
        else order.reserved = round(type === "limit" ? quantity * order.limitPrice + computeFees(account.market, "BUY", quantity, order.limitPrice).total : estimate);
      }
      if (!failure && type === "limit" && finite(observed?.price)) {
        const deviation = Math.abs(order.limitPrice / observed.price - 1) * 100;
        if (account.market === "A" && ((finite(observed.limitUp) && order.limitPrice > observed.limitUp) || (finite(observed.limitDown) && order.limitPrice < observed.limitDown)))
          failure = reject(`Limit price is outside today's A-share price band (${observed.limitDown}–${observed.limitUp}).`);
        else if (deviation > 30) failure = reject(`Limit price is ${round(deviation, 1)}% away from the last price ${observed.price}; check units and price.`);
      }

      return withLock(async () => {
        // Re-read under the lock: another process may have traded this account since our checks.
        const current = await load(account.id);
        assertActive(current);
        assertCaller(current, caller);
        if (!failure && side === "BUY") {
          const available = current.cash - reservedCash(current);
          if (order.reserved > available + 1e-6) failure = reject(`Insufficient available cash: need about ${order.reserved} ${current.currency}, available ${round(available)}.`);
        }
        if (!failure && side === "SELL" && quantity > sellableQuantity(current, symbol, at)) failure = reject("Sellable quantity changed while the order was being placed.");
        current.orders.push(order);
        if (current.orders.length > LIMITS.orders) {
          const open = current.orders.filter((entry) => entry.status === "open");
          current.orders = [...current.orders.filter((entry) => entry.status !== "open").slice(-(LIMITS.orders - open.length)), ...open]
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        }
        let trade = null;
        if (!failure && execution?.price !== null && execution?.price !== undefined) trade = applyFill(current, order, execution.price, observed, at);
        recordEquity(current, at, Boolean(trade));
        await save(current);
        const result = {
          order, trade, account: publicAccount(current),
          quote: observed ? { symbol, name: observed.name, price: observed.price, asOf: observed.asOf, source: observed.provider ?? observed.source, limitUp: observed.limitUp ?? null, limitDown: observed.limitDown ?? null, lotSize: rules.lotSize } : null,
          session: tradable.session ? { status: tradable.session.status, date: tradable.session.date, calendarVerified: tradable.session.verified } : null,
        };
        if (failure) result.error = failure.message;
        else if (!trade) result.note = tradable.ok ? "Limit order resting: price not reached yet. It fills when a later sync observes a marketable quote." : `Order resting until the ${account.market} session opens (expires ${order.expiresAt}).`;
        return result;
      });
    },

    async cancelOrder({ accountId, orderId, reason }, caller = {}) {
      return withLock(async () => {
        const account = await load(accountId);
        assertCaller(account, caller);
        const order = account.orders.find((entry) => entry.id === orderId || entry.clientOrderId === orderId);
        if (!order) throw new ArenaError(`Order ${orderId} not found.`, "not_found", 404);
        if (order.status !== "open") return { order, note: `Order is already ${order.status}.` };
        Object.assign(order, { status: "cancelled", closedAt: now(), reserved: 0, cancelReason: String(reason ?? "").slice(0, 500) || null });
        await save(account);
        return { order, account: publicAccount(account) };
      });
    },

    async logDecision({ accountId, kind = "analysis", summary, symbols = [], details }, caller = {}) {
      if (!String(summary ?? "").trim()) throw new ArenaError("summary is required.");
      return withLock(async () => {
        const account = await load(accountId);
        assertActive(account);
        assertCaller(account, caller);
        const entry = {
          id: shortId("dec"), at: now(), kind: ["analysis", "no-trade", "risk", "review", "note"].includes(kind) ? kind : "note",
          summary: String(summary).slice(0, 2000), symbols: symbols.slice(0, 20).map((symbol) => { try { return normalizeTradeSymbol(symbol); } catch { return String(symbol); } }),
          details: details ? String(details).slice(0, 8000) : null, strategyVersion: account.strategy.version,
        };
        account.journal.push(entry);
        if (account.journal.length > LIMITS.journal) account.journal = account.journal.slice(-LIMITS.journal);
        await save(account);
        return { entry };
      });
    },

    async updateStrategy({ accountId, summary, changeNote }, caller = {}) {
      if (!String(summary ?? "").trim()) throw new ArenaError("summary is required.");
      return withLock(async () => {
        const account = await load(accountId);
        assertActive(account);
        assertCaller(account, caller);
        const at = now();
        account.strategy.version += 1;
        account.strategy.summary = String(summary).slice(0, 2000);
        account.strategy.updatedAt = at;
        account.strategy.history.push({ version: account.strategy.version, summary: account.strategy.summary, note: String(changeNote ?? "").slice(0, 500) || null, at });
        account.strategy.history = account.strategy.history.slice(-LIMITS.strategyHistory);
        await save(account);
        return { strategy: account.strategy };
      });
    },

    // Dashboard-only administration. Agents cannot archive, reset or re-fund accounts.
    async updateAccount(id, input) {
      return withLock(async () => {
        const account = await load(id);
        if (input.name !== undefined) account.name = String(input.name).trim().slice(0, 60) || account.name;
        if (input.model !== undefined) account.model = String(input.model).trim().slice(0, 80) || account.model;
        if (input.agentLabel !== undefined) account.agent.label = String(input.agentLabel).trim().slice(0, 60) || null;
        if (input.status && ["active", "archived"].includes(input.status)) {
          account.status = input.status;
          if (input.status === "archived") {
            for (const order of openOrders(account)) Object.assign(order, { status: "cancelled", closedAt: now(), reserved: 0, cancelReason: "account archived" });
            account.archivedAt = now();
          }
        }
        if (input.unbindAgent) account.agent.client = null;
        if (input.lotOverrides && typeof input.lotOverrides === "object") {
          account.lotOverrides = Object.fromEntries(Object.entries(input.lotOverrides)
            .filter(([, lot]) => Number.isInteger(lot) && lot > 0).map(([symbol, lot]) => [normalizeTradeSymbol(symbol), lot]));
        }
        await save(account);
        return publicAccount(account, { detail: true });
      });
    },

    async deleteAccount(id) {
      return withLock(async () => {
        const account = await load(id);
        if (account.status !== "archived") throw new ArenaError("Archive the account before deleting it.", "inactive", 409);
        await rm(accountPath(id), { force: true });
        return { deleted: id };
      });
    },

    sync,
  };
}

let defaultArena;
export function getArena() {
  defaultArena ??= createArena();
  return defaultArena;
}

// Identity of the MCP client so accounts can be attributed and protected.
export function callerFromClient(clientInfo) {
  const override = process.env.HROUTER_AGENT_ID?.trim();
  const name = override || clientInfo?.name || "unknown-agent";
  return { client: name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 60), clientVersion: clientInfo?.version ?? null, clientName: clientInfo?.name ?? null };
}
