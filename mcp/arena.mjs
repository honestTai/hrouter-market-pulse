// Agent Arena: a local, agent-neutral paper exchange for comparing agents and models.
//
// Every account belongs to one market (A / HK / US) and one currency, so accounts in the
// same market and competition start from the same cash and are directly comparable.
// Orders fill only against real public quotes observed during a regular session, with
// board lots, A-share T+1 and price limits, exchange-style fees and configurable slippage.
// State lives under <storage>/arena and is shared by every MCP process (Codex, Claude Code,
// WorkBuddy, ...) through a cross-process lock, so one dashboard shows every agent.

//
// Unattended operation: a background matcher (one leader per arena dir, elected through a lease
// file) syncs resting orders and protective exits during regular sessions, applies corporate
// actions, enforces the owner's risk policy and writes an end-of-day digest after every close.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getCorporateActions, getStorageDir, getTradeQuote, loadPreferences, marketFromSymbol, normalizeSymbol } from "./core.mjs";
import { getInstrumentRules, getMarketSession, localMarketTime, marketLocalToIso } from "./market-rules.mjs";

export const ARENA_MARKETS = {
  A: { currency: "CNY", defaultCash: 1000000, benchmark: "000300.SS", benchmarkName: "沪深300 / CSI 300" },
  HK: { currency: "HKD", defaultCash: 1000000, benchmark: "^HSI", benchmarkName: "恒生指数 / Hang Seng" },
  US: { currency: "USD", defaultCash: 100000, benchmark: "^GSPC", benchmarkName: "标普500 / S&P 500" },
};
const LIMITS = { orders: 5000, trades: 5000, journal: 2000, equity: 6000, strategyHistory: 200, reports: 500, events: 2000, appliedActions: 1000, digests: 400 };
const SYNC_THROTTLE_MS = 20000;
const QUOTE_CACHE_MS = 10000;
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 20000;
// Quiet minutes after the open before zero volume is read as a suspension rather than a slow start.
const SUSPENSION_GRACE_MINUTES = 5;
const CORPORATE_ACTION_RETRY_MS = 3600000;
export const DEFAULT_MAX_VOLUME_PCT = 5;
export const DEFAULT_RISK_POLICY = Object.freeze({ maxPositionPct: null, maxExposurePct: null, maxDrawdownPct: null, onBreach: "block", reduceToExposurePct: 50 });
export const MATCHER_DEFAULTS = Object.freeze({ intervalMs: 90000, jitterMs: 15000, leaseMs: 300000, digestWindowMs: 18 * 3600000, webhookAttempts: 3 });

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

// The day's traded volume in shares. Tencent reports A-share volume in board lots of 100.
export function dayVolumeShares(quote) {
  const volume = quote?.volumeShares ?? quote?.volume;
  return finite(volume) && volume >= 0 ? volume : null;
}

// A security counts as suspended when the provider says so, or when the regular session has
// been open for a few minutes without a single trade today (zero volume / no print today).
export function suspensionStatus(account, quote, now) {
  if (!quote || quote.error) return null;
  if (quote.suspended === true) return "provider-status";
  const session = getMarketSession(account.market, now);
  if (session.status !== "open") return null;
  const minutesOpen = session.minute - session.sessions[0][0];
  if (minutesOpen < SUSPENSION_GRACE_MINUTES) return null;
  if (dayVolumeShares(quote) === 0) return "zero-volume";
  const quoteDate = localMarketTime(quote.asOf, account.market)?.date;
  if (quoteDate && quoteDate < session.date && minutesOpen >= 15) return "no-trade-today";
  return null;
}

const remainingQuantity = (order) => order.quantity - (order.filledQuantity ?? 0);

// Shares an order may fill now: the account's participation in one security may not exceed
// maxVolumePct of the day's volume. Larger orders fill partially (whole board lots) or rest.
export function fillQuantity(account, order, quote, now) {
  const remaining = remainingQuantity(order);
  const pct = account.settings?.maxVolumePct ?? DEFAULT_MAX_VOLUME_PCT;
  const volume = dayVolumeShares(quote);
  if (volume === null || !finite(pct) || pct >= 100) return { quantity: remaining, capped: false, volume };
  const today = localMarketTime(now, account.market)?.date;
  const used = account.trades.filter((trade) => trade.symbol === order.symbol && localMarketTime(trade.at, account.market)?.date === today)
    .reduce((sum, trade) => sum + trade.quantity, 0);
  const allowed = Math.max(0, Math.floor(volume * pct / 100) - used);
  if (allowed >= remaining) return { quantity: remaining, capped: false, volume, allowed };
  const lot = lotRules(account, order.symbol, quote).lotSize ?? 1;
  return { quantity: Math.floor(allowed / lot) * lot, capped: true, volume, allowed };
}

// Protective exits: { stopLoss, takeProfit }, each { price } or { pct } of the average cost.
export function normalizeExits(input = {}, { allowClear = false } = {}) {
  const exits = {};
  for (const [key, priceKey, pctKey, maxPct] of [["stopLoss", "stopLossPrice", "stopLossPct", 95], ["takeProfit", "takeProfitPrice", "takeProfitPct", 1000]]) {
    const price = input[priceKey];
    const pct = input[pctKey];
    if (allowClear && (price === null || pct === null) && (price ?? pct ?? null) === null) { exits[key] = null; continue; }
    if (price !== undefined && price !== null && pct !== undefined && pct !== null) throw new ArenaError(`Give ${priceKey} or ${pctKey}, not both.`);
    if (price !== undefined && price !== null) {
      if (!finite(price) || price <= 0) throw new ArenaError(`${priceKey} must be a positive price.`);
      exits[key] = { price };
    } else if (pct !== undefined && pct !== null) {
      if (!finite(pct) || pct <= 0 || pct > maxPct) throw new ArenaError(`${pctKey} must be between 0 and ${maxPct} (percent of the average cost).`);
      exits[key] = { pct };
    }
  }
  return Object.keys(exits).length ? exits : null;
}

export function exitLevels(position) {
  const exits = position?.exits;
  if (!exits || !position.quantity) return null;
  const averageCost = position.costBasis / position.quantity;
  const resolve = (spec, direction) => !spec ? null : finite(spec.price) ? spec.price : finite(spec.pct) ? round(averageCost * (1 + direction * spec.pct / 100), 4) : null;
  const levels = { stopLoss: resolve(exits.stopLoss, -1), takeProfit: resolve(exits.takeProfit, 1) };
  return levels.stopLoss === null && levels.takeProfit === null ? null : levels;
}

export function sanitizeRiskPolicy(input = {}, current = {}) {
  const next = { ...DEFAULT_RISK_POLICY, ...current };
  const pct = (key, low, high) => {
    if (input[key] === undefined) return;
    if (input[key] === null || input[key] === "") { next[key] = key === "reduceToExposurePct" ? DEFAULT_RISK_POLICY.reduceToExposurePct : null; return; }
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < low || value > high) throw new ArenaError(`${key} must be between ${low} and ${high}, or empty to disable.`);
    next[key] = round(value, 2);
  };
  pct("maxPositionPct", 1, 100);
  pct("maxExposurePct", 1, 100);
  pct("maxDrawdownPct", 1, 90);
  pct("reduceToExposurePct", 0, 100);
  if (input.onBreach !== undefined) {
    if (!["block", "reduce"].includes(input.onBreach)) throw new ArenaError("onBreach must be block or reduce.");
    next.onBreach = input.onBreach;
  }
  return next;
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

function addEvent(account, at, event, dedupe) {
  account.events ??= [];
  if (dedupe && account.events.slice(-300).some((entry) => entry.dedupe === dedupe)) return null;
  const entry = { id: shortId("evt"), at, ...event, ...(dedupe ? { dedupe } : {}) };
  account.events.push(entry);
  if (account.events.length > LIMITS.events) account.events = account.events.slice(-LIMITS.events);
  return entry;
}

const riskPolicyOf = (account) => ({ ...DEFAULT_RISK_POLICY, ...account.riskPolicy });

// Drawdown from the peak equity since the account opened or the owner last reset the breaker.
export function drawdownState(account, equityNow = valuation(account).equity) {
  const since = account.risk?.resetAt ? Date.parse(account.risk.resetAt) : -Infinity;
  const points = account.equity.filter((point) => Date.parse(point.at) >= since).map((point) => point.equity);
  const peak = Math.max(equityNow, ...points, ...(account.risk?.resetAt ? [account.risk.resetEquity ?? equityNow] : [account.initialCash]));
  return { peakEquity: round(peak), equity: equityNow, drawdownPct: peak > 0 ? round((equityNow / peak - 1) * 100, 2) : 0 };
}

// Why a buy adding `addValue` of exposure in `symbol` breaches the owner's policy, or null.
export function riskViolation(account, symbol, addValue, excludeOrderId) {
  const policy = riskPolicyOf(account);
  if (account.risk?.breaker) return `Owner risk policy: drawdown circuit breaker tripped at ${account.risk.breaker.drawdownPct}% on ${account.risk.breaker.trippedAt}; new buys are blocked until the owner resets it in the dashboard.`;
  const value = valuation(account);
  if (value.equity <= 0) return null;
  if (finite(policy.maxDrawdownPct)) {
    const { drawdownPct } = drawdownState(account, value.equity);
    if (drawdownPct <= -policy.maxDrawdownPct) return `Owner risk policy: drawdown ${drawdownPct}% breaches the ${policy.maxDrawdownPct}% circuit breaker; new buys are blocked.`;
  }
  const pending = openOrders(account).filter((order) => order.side === "BUY" && order.id !== excludeOrderId);
  if (finite(policy.maxPositionPct)) {
    const held = value.positions.find((position) => position.symbol === symbol)?.marketValue ?? 0;
    const resting = pending.filter((order) => order.symbol === symbol).reduce((sum, order) => sum + order.reserved, 0);
    const pct = (held + resting + addValue) / value.equity * 100;
    if (pct > policy.maxPositionPct + 1e-9) return `Owner risk policy: ${symbol} would be ${round(pct, 1)}% of equity, above the ${policy.maxPositionPct}% single-position limit.`;
  }
  if (finite(policy.maxExposurePct)) {
    const resting = pending.reduce((sum, order) => sum + order.reserved, 0);
    const pct = (value.marketValue + resting + addValue) / value.equity * 100;
    if (pct > policy.maxExposurePct + 1e-9) return `Owner risk policy: total exposure would be ${round(pct, 1)}% of equity, above the ${policy.maxExposurePct}% limit.`;
  }
  return null;
}

export function sellableQuantity(account, symbol, now = new Date().toISOString(), excludeOrderId) {
  const position = account.positions[symbol];
  if (!position) return 0;
  const today = localMarketTime(now, account.market)?.date;
  const settled = account.market === "A"
    ? position.lots.filter((lot) => lot.date < today).reduce((sum, lot) => sum + lot.quantity, 0)
    : position.quantity;
  const pending = openOrders(account).filter((order) => order.side === "SELL" && order.symbol === symbol && order.id !== excludeOrderId)
    .reduce((sum, order) => sum + remainingQuantity(order), 0);
  return Math.max(0, settled - pending);
}

// Fill `quantity` shares of an order (all that remains by default); partial fills keep it open.
function applyFill(account, order, price, quote, now, quantity = remainingQuantity(order)) {
  const fees = computeFees(account.market, order.side, quantity, price);
  const gross = round(quantity * price);
  const tradeDate = localMarketTime(now, account.market).date;
  let position = account.positions[order.symbol];
  let realizedPnl = null;
  if (order.side === "BUY") {
    position ??= { symbol: order.symbol, name: quote?.name ?? order.name ?? order.symbol, quantity: 0, costBasis: 0, realizedPnl: 0, lots: [], openedAt: now };
    position.costBasis = round(position.costBasis + gross + fees.total);
    position.quantity += quantity;
    const lot = position.lots.find((entry) => entry.date === tradeDate);
    if (lot) lot.quantity += quantity;
    else position.lots.push({ date: tradeDate, quantity });
    if (order.exits) position.exits = { ...position.exits, ...order.exits };
    account.cash = round(account.cash - gross - fees.total);
    account.positions[order.symbol] = position;
  } else {
    const averageCost = position.costBasis / position.quantity;
    const releasedCost = averageCost * quantity;
    realizedPnl = round(gross - fees.total - releasedCost);
    position.costBasis = round(position.costBasis - releasedCost);
    position.quantity -= quantity;
    position.realizedPnl = round(position.realizedPnl + realizedPnl);
    let remaining = quantity;
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
  const remainingBefore = remainingQuantity(order);
  const filledBefore = order.filledQuantity ?? 0;
  order.filledQuantity = filledBefore + quantity;
  order.fillPrice = round(((order.fillPrice ?? 0) * filledBefore + price * quantity) / order.filledQuantity, 4);
  order.fees = round((order.fees ?? 0) + fees.total);
  order.fills = (order.fills ?? 0) + 1;
  order.fillQuote = quote ? { price: quote.price, asOf: quote.asOf, source: quote.provider ?? quote.source } : null;
  if (order.filledQuantity >= order.quantity) Object.assign(order, { status: "filled", filledAt: now, reserved: 0 });
  else Object.assign(order, { partiallyFilledAt: now, reserved: round(order.reserved * (remainingBefore - quantity) / remainingBefore) });
  const trade = {
    id: shortId("trd"), orderId: order.id, symbol: order.symbol, name: account.positions[order.symbol]?.name ?? quote?.name ?? order.symbol,
    side: order.side, quantity, price, gross, fees: fees.total, feeBreakdown: fees.breakdown,
    realizedPnl, at: now, reason: order.reason, confidence: order.confidence ?? null, strategyVersion: order.strategyVersion,
    ...(order.trigger ? { trigger: order.trigger } : {}), ...(order.fills > 1 || order.status === "open" ? { partial: true } : {}),
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
      ...position, averageCost: round(averageCost, 4), marketValue, exitLevels: exitLevels(position),
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

export function computeMetrics(account, { benchmarkPrice = null, now = new Date().toISOString() } = {}) {
  const value = valuation(account);
  const initial = account.initialCash;
  const points = [{ at: account.createdAt, equity: initial }, ...account.equity, { at: now, equity: value.equity }];
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
  const days = Math.max(0, (Date.parse(now) - Date.parse(account.createdAt)) / 86400000);
  const today = localMarketTime(now, account.market)?.date;
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
    dividendIncome: round(account.dividendIncome ?? 0),
    turnover: initial > 0 ? round(account.trades.reduce((sum, trade) => sum + trade.gross, 0) / initial, 2) : 0,
    ordersPlaced: account.orders.length,
    ordersRejected: account.orders.filter((order) => order.status === "rejected").length,
    openOrders: openOrders(account).length,
    decisionsLogged: account.journal.length,
    reportsPublished: (account.reports ?? []).length,
    daysActive: round(days, 1), tradingDays: closes.length - 1,
    sampleWarning: closes.length < 6 ? "fewer-than-5-trading-days" : sells.length < 10 ? "fewer-than-10-closed-trades" : null,
    byStrategyVersion: [...byVersion.values()].map((entry) => ({ ...entry, winRatePct: entry.closedTrades ? round(entry.wins / entry.closedTrades * 100, 1) : null })),
  };
}

// ---------------------------------------------------------------------------
// Run health and session dates
// ---------------------------------------------------------------------------

const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const sessionOn = (market, date) => getMarketSession(market, marketLocalToIso(date, 720, market));

// The most recent regular session of `market` whose close is at or before `at`.
export function lastCompletedSession(market, at) {
  const today = localMarketTime(at, market)?.date;
  for (let offset = 0; offset <= 14; offset += 1) {
    const session = sessionOn(market, addDays(today, -offset));
    if (session.status !== "closed" && Date.parse(session.closeAt) <= Date.parse(at)) return session;
  }
  return null;
}

// Trading date an end-of-day view of `market` refers to: today once the session has opened, else the previous session.
function reportingDate(market, at) {
  const today = getMarketSession(market, at);
  if (today.status !== "closed" && today.status !== "premarket") return today.date;
  return lastCompletedSession(market, at)?.date ?? today.date;
}

function lastAgentActivity(account) {
  return [account.journal.at(-1)?.at, account.reports?.at(-1)?.at, account.orders.filter((order) => !order.trigger).at(-1)?.createdAt].filter(Boolean).sort().at(-1) ?? null;
}

// Whether the account's agent ran a round on every completed trading day since its last round.
export function runHealth(account, at = new Date().toISOString()) {
  const lastRoundAt = account.lastRoundAt ?? lastAgentActivity(account);
  if (account.status !== "active") return { status: "inactive", lastRoundAt, missedTradingDays: 0, missedDates: [] };
  const baseline = localMarketTime(lastRoundAt ?? account.createdAt, account.market)?.date;
  const missed = [];
  // A never-run account also misses the day it was opened, if it existed before that day's close.
  const first = !lastRoundAt && baseline && Date.parse(account.createdAt) < Date.parse(sessionOn(account.market, baseline).closeAt) ? 0 : 1;
  for (let offset = first; offset <= 60 && baseline; offset += 1) {
    const session = sessionOn(account.market, addDays(baseline, offset));
    if (Date.parse(session.closeAt) > Date.parse(at)) break;
    if (session.status !== "closed") missed.push(session.date);
  }
  return {
    status: missed.length ? "missed" : lastRoundAt ? "ok" : "waiting", lastRoundAt, lastRoundKind: account.lastRoundKind ?? null,
    missedTradingDays: missed.length, missedDates: missed.slice(-10),
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function createArena({ root = path.join(getStorageDir(), "arena"), quoteProvider = getTradeQuote, corporateActionProvider = null, now = () => new Date().toISOString(), quoteCacheMs = QUOTE_CACHE_MS } = {}) {
  const accountDir = path.join(root, "accounts");
  const digestDir = path.join(root, "digests");
  const lockDir = path.join(root, ".lock");
  const leaseFile = path.join(root, "matcher-lease.json");
  const statusFile = path.join(root, "matcher-status.json");
  const quoteCache = new Map();
  const actionCache = new Map();
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

  // Shares held at the close before an ex-date, reconstructed from today's quantity and later trades.
  function entitledQuantity(account, position, exDate) {
    let quantity = position.quantity;
    for (const trade of account.trades) {
      if (trade.symbol !== position.symbol || (localMarketTime(trade.at, account.market)?.date ?? "") < exDate) continue;
      quantity += trade.side === "BUY" ? -trade.quantity : trade.quantity;
    }
    return Math.max(0, quantity);
  }

  // Dividends credit cash on the ex-date (gross, before any withholding); splits and bonus shares
  // scale the share count while the total cost stays, so the average cost adjusts.
  function applyCorporateActions(account, actionMap, at, events) {
    if (!actionMap?.size) return;
    const today = localMarketTime(at, account.market)?.date;
    const opened = localMarketTime(account.createdAt, account.market)?.date ?? "";
    account.appliedCorporateActions ??= [];
    for (const [symbol, actions] of actionMap) {
      for (const action of [...(actions ?? [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
        const position = account.positions[symbol];
        if (!position || !action?.date || action.date > today || action.date < opened) continue;
        const key = `${symbol}:${action.type}:${action.date}`;
        if (account.appliedCorporateActions.includes(key)) continue;
        account.appliedCorporateActions = [...account.appliedCorporateActions, key].slice(-LIMITS.appliedActions);
        const entitled = entitledQuantity(account, position, action.date);
        if (entitled <= 0) continue;
        if (action.type === "dividend" && finite(action.cashPerShare) && action.cashPerShare > 0) {
          if (action.currency && action.currency !== account.currency) {
            addEvent(account, at, { type: "corporate-action-skipped", symbol, exDate: action.date, message: `${symbol} dividend paid in ${action.currency}, not ${account.currency}; not credited.` });
            continue;
          }
          const amount = round(entitled * action.cashPerShare);
          account.cash = round(account.cash + amount);
          account.dividendIncome = round((account.dividendIncome ?? 0) + amount);
          position.dividends = round((position.dividends ?? 0) + amount);
          const event = addEvent(account, at, { type: "dividend", symbol, exDate: action.date, quantity: entitled, cashPerShare: action.cashPerShare, amount, message: `${symbol} dividend ${action.cashPerShare}/share on ${entitled} shares: +${amount} ${account.currency}.` });
          events.push({ type: "dividend", symbol, amount, eventId: event.id });
        } else if (["split", "bonus"].includes(action.type) && finite(action.ratio) && action.ratio > 0 && Math.abs(action.ratio - 1) > 1e-9) {
          const before = position.quantity;
          let extra = Math.floor(entitled * action.ratio) - entitled;
          if (before + extra <= 0) extra = -before + 1;
          position.quantity = before + extra;
          // Scale the lots held before the ex-date; rounding goes to the oldest lot.
          const eligible = position.lots.filter((lot) => lot.date < action.date);
          let assigned = 0;
          for (const lot of eligible) {
            const share = Math.floor(extra * lot.quantity / Math.max(1, eligible.reduce((sum, entry) => sum + entry.quantity, 0)));
            lot.quantity += share;
            assigned += share;
          }
          if (eligible[0]) eligible[0].quantity += extra - assigned;
          else position.lots.push({ date: action.date, quantity: extra });
          position.lots = position.lots.filter((lot) => lot.quantity > 0);
          if (position.lastPrice && (localMarketTime(position.lastPriceAt, account.market)?.date ?? "") < action.date) position.lastPrice = round(position.lastPrice / action.ratio, 4);
          for (const exit of ["stopLoss", "takeProfit"]) if (finite(position.exits?.[exit]?.price)) position.exits[exit].price = round(position.exits[exit].price / action.ratio, 4);
          for (const order of openOrders(account).filter((entry) => entry.symbol === symbol))
            Object.assign(order, { status: "cancelled", closedAt: at, reserved: 0, cancelReason: `${action.type} ${action.ratio}:1 on ${action.date} changed the share basis; re-enter the order.` });
          const event = addEvent(account, at, { type: action.type, symbol, exDate: action.date, ratio: action.ratio, quantityBefore: before, quantityAfter: position.quantity, message: `${symbol} ${action.type === "split" ? "split" : "bonus shares"} ×${action.ratio}: ${before} → ${position.quantity} shares; average cost ${round(position.costBasis / position.quantity, 4)}.` });
          events.push({ type: action.type, symbol, ratio: action.ratio, eventId: event.id });
        }
      }
    }
  }

  function protectiveOrder(account, { symbol, quantity, trigger, reason, at, extra = {} }) {
    const session = getMarketSession(account.market, at);
    const order = {
      id: shortId("ord"), clientOrderId: null, symbol, name: account.positions[symbol]?.name ?? symbol, side: "SELL", type: "market", quantity,
      limitPrice: null, timeInForce: "day", status: "open", reserved: 0, reason, confidence: null, horizon: null,
      strategyVersion: account.strategy.version, createdAt: at, expiresAt: session.closeAt, quoteAtSubmit: null, placedBy: "matcher", trigger, ...extra,
    };
    account.orders.push(order);
    return order;
  }

  // Trip the drawdown circuit breaker; with onBreach=reduce, cancel buys and sell down to the target exposure.
  function evaluateBreaker(account, quoteMap, at, events) {
    const policy = riskPolicyOf(account);
    if (!finite(policy.maxDrawdownPct) || account.risk?.breaker) return;
    const state = drawdownState(account);
    if (state.drawdownPct > -policy.maxDrawdownPct) return;
    account.risk = { ...account.risk, breaker: { trippedAt: at, drawdownPct: state.drawdownPct, peakEquity: state.peakEquity, equity: state.equity, action: policy.onBreach } };
    addEvent(account, at, { type: "risk-breaker", drawdownPct: state.drawdownPct, limitPct: policy.maxDrawdownPct, message: `Drawdown ${state.drawdownPct}% breached the owner's ${policy.maxDrawdownPct}% limit; new buys are blocked${policy.onBreach === "reduce" ? ` and exposure is being reduced to ${policy.reduceToExposurePct}%` : ""}.` });
    events.push({ type: "risk-breaker", drawdownPct: state.drawdownPct });
    if (policy.onBreach !== "reduce") return;
    for (const order of openOrders(account).filter((entry) => entry.side === "BUY"))
      Object.assign(order, { status: "cancelled", closedAt: at, reserved: 0, cancelReason: "Owner risk policy: drawdown circuit breaker" });
    const value = valuation(account);
    const target = value.equity * policy.reduceToExposurePct / 100;
    if (value.marketValue <= target) return;
    const fraction = 1 - target / value.marketValue;
    for (const position of value.positions) {
      const sellable = sellableQuantity(account, position.symbol, at);
      if (!sellable) continue;
      const lot = lotRules(account, position.symbol, quoteMap.get(position.symbol)).lotSize ?? 1;
      let quantity = Math.ceil(position.quantity * fraction / lot) * lot;
      if (quantity >= sellable) quantity = sellable;
      if (quantity <= 0) continue;
      const order = protectiveOrder(account, { symbol: position.symbol, quantity, trigger: "risk-reduce", at, reason: `Owner risk policy: drawdown breaker, reducing exposure to ${policy.reduceToExposurePct}%.` });
      events.push({ type: "risk-reduce", orderId: order.id, symbol: position.symbol, quantity });
    }
  }

  // Stop-loss / take-profit: when a fresh quote crosses a level, sell the sellable shares at market.
  function triggerExits(account, quoteMap, at, events) {
    const today = localMarketTime(at, account.market)?.date;
    for (const position of Object.values(account.positions)) {
      const levels = exitLevels(position);
      const observed = quoteMap.get(position.symbol);
      if (!levels || !observed || observed.error || !tradability(account, observed, at).ok) continue;
      if (openOrders(account).some((order) => order.symbol === position.symbol && order.trigger)) continue;
      const trigger = levels.stopLoss !== null && observed.price <= levels.stopLoss + 1e-9 ? "stop-loss"
        : levels.takeProfit !== null && observed.price >= levels.takeProfit - 1e-9 ? "take-profit" : null;
      if (!trigger) continue;
      const level = trigger === "stop-loss" ? levels.stopLoss : levels.takeProfit;
      const defer = (why, message) => {
        const event = addEvent(account, at, { type: "exit-deferred", symbol: position.symbol, trigger, level, price: observed.price, why, message }, `exit-deferred:${position.symbol}:${why}:${today}`);
        if (event) events.push({ type: "exit-deferred", symbol: position.symbol, trigger, why });
      };
      const suspended = suspensionStatus(account, observed, at);
      if (suspended) { defer("suspended", `${trigger} for ${position.symbol} at ${level} waits: trading looks suspended (${suspended}).`); continue; }
      if (account.market === "A" && finite(observed.limitDown) && observed.price <= observed.limitDown + 1e-9) { defer("limit-down", `${trigger} for ${position.symbol} at ${level} waits: the stock is locked limit-down.`); continue; }
      const competing = openOrders(account).filter((order) => order.symbol === position.symbol && order.side === "SELL");
      const sellable = sellableQuantity(account, position.symbol, at) + competing.reduce((sum, order) => sum + remainingQuantity(order), 0);
      if (!sellable) { defer("t-plus-one", `${trigger} for ${position.symbol} at ${level} waits: shares bought today unlock next session (T+1).`); continue; }
      for (const order of competing) Object.assign(order, { status: "cancelled", closedAt: at, reserved: 0, cancelReason: `Replaced by ${trigger}` });
      const order = protectiveOrder(account, {
        symbol: position.symbol, quantity: sellable, trigger, at, extra: { triggerLevel: level, triggerPrice: observed.price },
        reason: `Protective ${trigger}: last ${observed.price} crossed ${level}.`,
      });
      addEvent(account, at, { type: trigger, symbol: position.symbol, level, price: observed.price, quantity: sellable, orderId: order.id, message: `${trigger === "stop-loss" ? "Stop-loss" : "Take-profit"} ${position.symbol}: last ${observed.price} crossed ${level}; selling ${sellable} shares at market.` });
      events.push({ type: trigger, orderId: order.id, symbol: position.symbol, quantity: sellable, level });
    }
  }

  // Apply observed quotes: corporate actions, expiries, marks, risk, protective exits, then fills.
  function settle(account, quoteMap, at, actionMap) {
    const events = [];
    applyCorporateActions(account, actionMap, at, events);
    for (const order of openOrders(account)) {
      if (Date.parse(order.expiresAt) <= Date.parse(at)) {
        Object.assign(order, { status: "expired", closedAt: at, reserved: 0 });
        events.push({ type: "expired", orderId: order.id, symbol: order.symbol, filledQuantity: order.filledQuantity ?? 0 });
      }
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
    evaluateBreaker(account, quoteMap, at, events);
    triggerExits(account, quoteMap, at, events);
    const today = localMarketTime(at, account.market)?.date;
    for (const order of openOrders(account)) {
      const observed = quoteMap.get(order.symbol);
      if (!observed || observed.error || !tradability(account, observed, at).ok) continue;
      const suspended = suspensionStatus(account, observed, at);
      if (suspended) {
        order.lastBlock = "suspended";
        const event = addEvent(account, at, { type: "suspended", symbol: order.symbol, why: suspended, message: `${order.symbol} looks suspended (${suspended}); no fills today.` }, `suspended:${order.symbol}:${today}`);
        if (event) events.push({ type: "suspended", symbol: order.symbol, why: suspended });
        continue;
      }
      const execution = executionPrice(account, order, observed);
      if (execution.price === null) { order.lastBlock = execution.blocked; continue; }
      if (order.side === "SELL" && (account.positions[order.symbol]?.quantity ?? 0) < remainingQuantity(order)) {
        Object.assign(order, { status: "rejected", closedAt: at, reserved: 0, rejectReason: "Position no longer covers this sell order." });
        continue;
      }
      const liquidity = fillQuantity(account, order, observed, at);
      if (!liquidity.quantity) { order.lastBlock = "liquidity"; continue; }
      if (order.side === "BUY") {
        const cost = liquidity.quantity * execution.price + computeFees(account.market, "BUY", liquidity.quantity, execution.price).total;
        if (cost > account.cash - reservedCash(account, order.id) + 1e-6) {
          Object.assign(order, { status: "rejected", closedAt: at, reserved: 0, rejectReason: "Insufficient cash at fill time." });
          continue;
        }
        const violation = riskViolation(account, order.symbol, cost, order.id);
        if (violation) {
          Object.assign(order, { status: "rejected", closedAt: at, reserved: 0, rejectReason: violation });
          events.push({ type: "risk-rejected", orderId: order.id, symbol: order.symbol });
          continue;
        }
      }
      delete order.lastBlock;
      const trade = applyFill(account, order, execution.price, observed, at, liquidity.quantity);
      events.push({ type: order.status === "open" ? "partial" : "filled", orderId: order.id, tradeId: trade.id, symbol: order.symbol, side: order.side, quantity: liquidity.quantity, price: execution.price, ...(order.trigger ? { trigger: order.trigger } : {}) });
    }
    if (account.status === "active") recordEquity(account, at);
    return events;
  }

  async function corporateActionsFor(symbols) {
    const result = new Map();
    if (!corporateActionProvider) return result;
    await Promise.all([...new Set(symbols)].map(async (symbol) => {
      const day = localMarketTime(now(), marketFromSymbol(symbol))?.date;
      const cached = actionCache.get(symbol);
      if (cached && cached.day === day && (cached.ok || Date.now() - cached.fetchedAt < CORPORATE_ACTION_RETRY_MS)) { result.set(symbol, cached.actions); return; }
      try {
        const actions = await corporateActionProvider(symbol);
        actionCache.set(symbol, { day, actions: Array.isArray(actions) ? actions : [], ok: true, fetchedAt: Date.now() });
      } catch {
        actionCache.set(symbol, { day, actions: cached?.actions ?? [], ok: false, fetchedAt: Date.now() });
      }
      result.set(symbol, actionCache.get(symbol).actions);
    }));
    return result;
  }

  async function sync(ids, { force = false } = {}) {
    const all = await loadAll();
    const targets = all.filter((account) => account.status === "active" && (!ids || ids.includes(account.id))
      && (force || Date.now() - (lastSync.get(account.id) ?? 0) > SYNC_THROTTLE_MS));
    if (!targets.length) return { synced: 0, events: [] };
    const symbols = targets.flatMap((account) => [...Object.keys(account.positions), ...openOrders(account).map((order) => order.symbol), account.benchmark?.symbol].filter(Boolean));
    const quoteMap = await quotes(symbols, { fresh: force });
    const actionMap = await corporateActionsFor(targets.flatMap((account) => Object.keys(account.positions)));
    const events = [];
    await withLock(async () => {
      for (const target of targets) {
        const account = await load(target.id);
        if (account.status !== "active") continue;
        const at = now();
        events.push(...settle(account, quoteMap, at, actionMap).map((event) => ({ ...event, accountId: account.id })));
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
    const at = now();
    const metrics = computeMetrics(account, { benchmarkPrice: account.benchmark?.lastPrice ?? null, now: at });
    const value = valuation(account);
    const health = runHealth(account, at);
    const risk = { ...drawdownState(account, value.equity), breaker: account.risk?.breaker ?? null, resetAt: account.risk?.resetAt ?? null };
    const today = localMarketTime(at, account.market)?.date;
    const alerts = [
      ...(health.status === "missed" ? [{ type: "missed-run", severity: "warning", message: `Missed ${health.missedTradingDays} trading day(s) since the last round.` }] : []),
      ...(risk.breaker ? [{ type: "risk-breaker", severity: "critical", message: `Drawdown breaker tripped at ${risk.breaker.drawdownPct}%; buys blocked.` }] : []),
      ...(account.events ?? []).filter((event) => ["stop-loss", "take-profit", "exit-deferred", "suspended", "corporate-action-skipped"].includes(event.type)
        && localMarketTime(event.at, account.market)?.date === today).slice(-5).map((event) => ({ type: event.type, severity: "info", message: event.message, at: event.at })),
    ];
    const summary = {
      id: account.id, name: account.name, competition: account.competition, market: account.market, currency: account.currency,
      agent: account.agent, model: account.model, strategy: { version: account.strategy.version, summary: account.strategy.summary, updatedAt: account.strategy.updatedAt },
      status: account.status, createdAt: account.createdAt, updatedAt: account.updatedAt, createdBy: account.createdBy,
      initialCash: account.initialCash, settings: account.settings, benchmark: account.benchmark, metrics, demo: account.demo === true,
      curve: returnCurve(account, metrics.equity),
      lastTradeAt: account.trades.at(-1)?.at ?? null,
      lastActivityAt: [account.trades.at(-1)?.at, account.journal.at(-1)?.at, account.orders.at(-1)?.createdAt, account.reports?.at(-1)?.at].filter(Boolean).sort().at(-1) ?? null,
      latestReport: account.reports?.length ? (({ id, at, title, summary, sentiment }) => ({ id, at, title, summary, sentiment }))(account.reports.at(-1)) : null,
      watchlist: account.watchlist ?? null,
      riskPolicy: riskPolicyOf(account), risk, health, lastRoundAt: health.lastRoundAt, alerts,
    };
    if (!detail) return summary;
    return {
      ...summary, positions: value.positions, openOrders: openOrders(account),
      orders: account.orders.slice(-limit).reverse(), trades: account.trades.slice(-limit).reverse(),
      journal: account.journal.slice(-limit).reverse(), equity: account.equity,
      strategyHistory: account.strategy.history, closedPositions: (account.closedPositions ?? []).slice(-limit).reverse(),
      lotOverrides: account.lotOverrides ?? {},
      reports: (account.reports ?? []).slice(-limit).reverse(),
      events: (account.events ?? []).slice(-limit).reverse().map(({ dedupe, ...event }) => event),
    };
  }

  function markRound(account, kind, at = now()) {
    account.lastRoundAt = at;
    account.lastRoundKind = kind;
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
        settings: { slippageBps: clamp(input.slippageBps ?? 5, 0, 100), maxQuoteAgeSeconds: clamp(input.maxQuoteAgeSeconds ?? 180, 30, 900), maxVolumePct: clamp(input.maxVolumePct ?? DEFAULT_MAX_VOLUME_PCT, 0.1, 100), feeModel: `${market}-retail-v1` },
        riskPolicy: { ...DEFAULT_RISK_POLICY },
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
      const exits = normalizeExits(input);
      if (exits && side !== "BUY") throw new ArenaError("stopLoss / takeProfit attach to BUY orders; use arena_set_exits for an existing position.");
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
        placedBy: caller.client ?? "unknown", ...(exits ? { exits } : {}),
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
      const suspended = tradable.ok ? suspensionStatus(account, observed, at) : null;
      if (!failure && suspended && type === "market") failure = reject(`${symbol} looks suspended (${suspended}): no trades today, so market orders cannot fill. Limit orders may rest until trading resumes.`);
      let execution = null;
      if (!failure && tradable.ok && !suspended) {
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
      if (!failure && exits && finite(observed?.price)) {
        const reference = execution?.price ?? (type === "limit" ? order.limitPrice : observed.price);
        if (finite(exits.stopLoss?.price) && exits.stopLoss.price >= reference) failure = reject(`stopLossPrice ${exits.stopLoss.price} must be below the entry price (~${reference}).`);
        else if (finite(exits.takeProfit?.price) && exits.takeProfit.price <= reference) failure = reject(`takeProfitPrice ${exits.takeProfit.price} must be above the entry price (~${reference}).`);
      }
      if (!failure && side === "BUY") {
        const violation = riskViolation(account, symbol, order.reserved);
        if (violation) failure = reject(violation, "risk");
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
        if (!failure && side === "BUY") {
          const violation = riskViolation(current, symbol, order.reserved);
          if (violation) failure = reject(violation, "risk");
        }
        markRound(current, "order", at);
        current.orders.push(order);
        if (current.orders.length > LIMITS.orders) {
          const open = current.orders.filter((entry) => entry.status === "open");
          current.orders = [...current.orders.filter((entry) => entry.status !== "open").slice(-(LIMITS.orders - open.length)), ...open]
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        }
        let trade = null;
        let liquidity = null;
        if (!failure && execution?.price !== null && execution?.price !== undefined) {
          liquidity = fillQuantity(current, order, observed, at);
          if (liquidity.quantity > 0) trade = applyFill(current, order, execution.price, observed, at, liquidity.quantity);
        }
        recordEquity(current, at, Boolean(trade));
        await save(current);
        const result = {
          order, trade, account: publicAccount(current),
          quote: observed ? { symbol, name: observed.name, price: observed.price, asOf: observed.asOf, source: observed.provider ?? observed.source, limitUp: observed.limitUp ?? null, limitDown: observed.limitDown ?? null, lotSize: rules.lotSize } : null,
          session: tradable.session ? { status: tradable.session.status, date: tradable.session.date, calendarVerified: tradable.session.verified } : null,
        };
        if (failure) result.error = failure.message;
        else if (order.status === "open" && liquidity?.capped) result.note = `${trade ? `Partially filled ${order.filledQuantity} of ${quantity}` : "Not filled yet"}: one account may take at most ${current.settings?.maxVolumePct ?? DEFAULT_MAX_VOLUME_PCT}% of the day's volume (${liquidity.volume} shares so far). The remainder rests and the background matcher fills it as volume builds, until ${order.expiresAt}.`;
        else if (!trade) result.note = suspended ? `${symbol} looks suspended (${suspended}); the limit order rests until trading resumes.` : tradable.ok ? "Limit order resting: price not reached yet. The background matcher fills it when a later quote is marketable." : `Order resting until the ${account.market} session opens (expires ${order.expiresAt}).`;
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
        markRound(account, `decision:${entry.kind}`, entry.at);
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

    // The agent's round report: the conclusion a hands-off owner reads instead of operating anything.
    async publishReport(input, caller = {}) {
      const title = String(input.title ?? "").trim();
      const summary = String(input.summary ?? "").trim();
      if (!title || !summary) throw new ArenaError("title and summary are required.");
      const list = (value, limit, map) => (Array.isArray(value) ? value.slice(0, limit).map(map).filter(Boolean) : []);
      const symbolOf = (value) => { try { return normalizeTradeSymbol(value); } catch { return String(value ?? "").slice(0, 20) || null; } };
      return withLock(async () => {
        const account = await load(input.accountId);
        assertActive(account);
        assertCaller(account, caller);
        const value = valuation(account);
        const report = {
          id: shortId("rpt"), at: now(), title: title.slice(0, 120), summary: summary.slice(0, 2000),
          sentiment: ["bullish", "neutral", "bearish", "defensive"].includes(input.sentiment) ? input.sentiment : null,
          marketView: input.marketView ? String(input.marketView).slice(0, 2000) : null,
          actions: list(input.actions, 30, (entry) => entry && ({ symbol: symbolOf(entry.symbol), action: String(entry.action ?? "").slice(0, 20), detail: String(entry.detail ?? "").slice(0, 500) })),
          picks: list(input.picks, 20, (entry) => entry && ({ symbol: symbolOf(entry.symbol), thesis: String(entry.thesis ?? "").slice(0, 500) })),
          risks: input.risks ? String(input.risks).slice(0, 2000) : null,
          nextSteps: input.nextSteps ? String(input.nextSteps).slice(0, 2000) : null,
          body: input.body ? String(input.body).slice(0, 20000) : null,
          snapshot: { equity: value.equity, cash: value.cash, positions: value.positions.length, returnPct: round((value.equity / account.initialCash - 1) * 100, 2) },
          strategyVersion: account.strategy.version,
        };
        account.reports = [...(account.reports ?? []), report].slice(-LIMITS.reports);
        markRound(account, "report", report.at);
        await save(account);
        return { report };
      });
    },

    // The agent's own stock-selection universe; mirrored into the shared watchlist by the caller when managed.
    async setWatchlist({ accountId, symbols, reason }, caller = {}) {
      if (!Array.isArray(symbols) || symbols.length > 50) throw new ArenaError("symbols must be an array of at most 50 securities.");
      return withLock(async () => {
        const account = await load(accountId);
        assertActive(account);
        assertCaller(account, caller);
        const normalized = [...new Set(symbols.map((symbol) => normalizeTradeSymbol(symbol)))];
        const wrongMarket = normalized.filter((symbol) => marketFromSymbol(symbol) !== account.market);
        if (wrongMarket.length) throw new ArenaError(`${wrongMarket.join(", ")} not in this account's ${account.market} market.`);
        account.watchlist = { symbols: normalized, reason: String(reason ?? "").slice(0, 1000) || null, updatedAt: now() };
        await save(account);
        return { watchlist: account.watchlist, holdings: Object.keys(account.positions) };
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
        // The owner's risk policy and liquidity cap are dashboard-only: no MCP tool reaches this method.
        if (input.riskPolicy !== undefined) {
          if (!input.riskPolicy || typeof input.riskPolicy !== "object" || Array.isArray(input.riskPolicy)) throw new ArenaError("riskPolicy must be an object.");
          account.riskPolicy = { ...sanitizeRiskPolicy(input.riskPolicy, account.riskPolicy), updatedAt: now() };
          addEvent(account, now(), { type: "risk-policy", message: "Owner updated the risk policy.", policy: account.riskPolicy });
        }
        if (input.resetBreaker) {
          const equity = valuation(account).equity;
          account.risk = { ...account.risk, breaker: null, resetAt: now(), resetEquity: equity };
          addEvent(account, now(), { type: "risk-reset", message: `Owner reset the drawdown breaker at equity ${equity}.` });
        }
        if (input.maxVolumePct !== undefined) {
          const pct = Number(input.maxVolumePct);
          if (!Number.isFinite(pct) || pct < 0.1 || pct > 100) throw new ArenaError("maxVolumePct must be between 0.1 and 100.");
          account.settings = { ...account.settings, maxVolumePct: round(pct, 2) };
        }
        if (input.lotOverrides && typeof input.lotOverrides === "object") {
          account.lotOverrides = Object.fromEntries(Object.entries(input.lotOverrides)
            .filter(([, lot]) => Number.isInteger(lot) && lot > 0).map(([symbol, lot]) => [normalizeTradeSymbol(symbol), lot]));
        }
        await save(account);
        return publicAccount(account, { detail: true });
      });
    },

    // Protective exits on an existing position; null clears a level.
    async setExits(input, caller = {}) {
      const symbol = normalizeTradeSymbol(input.symbol);
      const exits = normalizeExits(input, { allowClear: true });
      if (!exits && !input.clear) throw new ArenaError("Give stopLossPrice / stopLossPct and/or takeProfitPrice / takeProfitPct (null clears one), or clear=true.");
      return withLock(async () => {
        const account = await load(input.accountId);
        assertActive(account);
        assertCaller(account, caller);
        const position = account.positions[symbol];
        if (!position) throw new ArenaError(`No ${symbol} position in this account.`, "not_found", 404);
        const next = input.clear ? {} : { ...position.exits, ...exits };
        for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
        const candidate = { ...position, exits: next };
        const levels = exitLevels(candidate);
        const last = position.lastPrice;
        if (finite(last) && levels?.stopLoss !== null && levels?.stopLoss !== undefined && levels.stopLoss >= last) throw new ArenaError(`Stop-loss ${levels.stopLoss} is at or above the last price ${last}; it would trigger immediately. Sell directly instead.`);
        if (finite(last) && levels?.takeProfit !== null && levels?.takeProfit !== undefined && levels.takeProfit <= last) throw new ArenaError(`Take-profit ${levels.takeProfit} is at or below the last price ${last}; it would trigger immediately. Sell directly instead.`);
        if (Object.keys(next).length) position.exits = next; else delete position.exits;
        const at = now();
        addEvent(account, at, { type: "exits-set", symbol, exits: position.exits ?? null, levels: exitLevels(position), message: position.exits ? `Exits for ${symbol}: stop ${levels?.stopLoss ?? "—"}, take-profit ${levels?.takeProfit ?? "—"}.` : `Exits for ${symbol} cleared.` });
        markRound(account, "exits", at);
        await save(account);
        return { symbol, exits: position.exits ?? null, levels: exitLevels(position), lastPrice: last ?? null };
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
    now,

    // Active account ids grouped by market, for the matcher.
    async activeByMarket() {
      const groups = new Map();
      for (const account of await loadAll()) {
        if (account.status !== "active") continue;
        const entry = groups.get(account.market) ?? { ids: [], firstCreatedAt: account.createdAt };
        entry.ids.push(account.id);
        if (account.createdAt < entry.firstCreatedAt) entry.firstCreatedAt = account.createdAt;
        groups.set(account.market, entry);
      }
      return groups;
    },

    withLock,

    // Generic single-leader lease per arena dir (matcher, scheduler, …): taken when absent, expired,
    // held by a dead local process, or already ours.
    async acquireLease(name, ownerId, leaseMs) {
      if (!/^[a-z-]+$/.test(name)) throw new ArenaError(`Invalid lease name ${name}`);
      const file = path.join(root, `${name}-lease.json`);
      return withLock(async () => {
        const at = now();
        let lease = null;
        try { lease = JSON.parse(await readFile(file, "utf8")); } catch { lease = null; }
        const free = !lease || lease.ownerId === ownerId || Date.parse(lease.expiresAt) <= Date.parse(at)
          || (lease.host === os.hostname() && !processAlive(lease.pid));
        if (!free) return { owner: false, lease };
        const next = { ownerId, pid: process.pid, host: os.hostname(), acquiredAt: lease?.ownerId === ownerId ? lease.acquiredAt : at, renewedAt: at, expiresAt: new Date(Date.parse(at) + leaseMs).toISOString() };
        await writeFile(file, JSON.stringify(next, null, 1), "utf8");
        return { owner: true, lease: next };
      });
    },

    async releaseLease(name, ownerId) {
      const file = path.join(root, `${name}-lease.json`);
      return withLock(async () => {
        try { const lease = JSON.parse(await readFile(file, "utf8")); if (lease.ownerId === ownerId) await rm(file, { force: true }); } catch { /* none */ }
      });
    },

    // One matcher per arena dir: the lease is taken when absent, expired, held by a dead local process, or already ours.
    async acquireMatcherLease(ownerId, leaseMs = MATCHER_DEFAULTS.leaseMs) {
      return withLock(async () => {
        const at = now();
        let lease = null;
        try { lease = JSON.parse(await readFile(leaseFile, "utf8")); } catch { lease = null; }
        const free = !lease || lease.ownerId === ownerId || Date.parse(lease.expiresAt) <= Date.parse(at)
          || (lease.host === os.hostname() && !processAlive(lease.pid));
        if (!free) return { owner: false, lease };
        const next = {
          ownerId, pid: process.pid, host: os.hostname(), acquiredAt: lease?.ownerId === ownerId ? lease.acquiredAt : at,
          renewedAt: at, expiresAt: new Date(Date.parse(at) + leaseMs).toISOString(),
        };
        await writeFile(leaseFile, JSON.stringify(next, null, 1), "utf8");
        return { owner: true, lease: next, takeover: Boolean(lease && lease.ownerId !== ownerId) };
      });
    },

    async releaseMatcherLease(ownerId) {
      return withLock(async () => {
        try {
          const lease = JSON.parse(await readFile(leaseFile, "utf8"));
          if (lease.ownerId === ownerId) await rm(leaseFile, { force: true });
        } catch { /* No lease to release. */ }
      });
    },

    async writeMatcherStatus(status) {
      await mkdir(root, { recursive: true });
      const temporary = `${statusFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(status, null, 1), "utf8");
      await rename(temporary, statusFile);
    },

    // Status visible from any process: who leads, when it last ran and whether the lease is live.
    async matcherStatus() {
      const read = async (file) => { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } };
      const [lease, status] = await Promise.all([read(leaseFile), read(statusFile)]);
      const at = now();
      const live = Boolean(lease && Date.parse(lease.expiresAt) > Date.parse(at));
      return {
        state: live ? "running" : lease ? "stale" : "stopped", lease, ...status,
        notes: ["The matcher runs inside any open MCP or dashboard process; only one leader matches at a time.", "It syncs only during regular sessions and writes one digest after each market close."],
      };
    },

    async generateDigest({ market = null, date, trigger = "manual", language = "zh-CN" } = {}) {
      const at = now();
      const accounts = (await loadAll()).filter((account) => account.status === "active");
      const digestDate = date ?? (market ? reportingDate(market, at) : localMarketTime(at, "A").date);
      const zh = language !== "en";
      const rows = accounts.map((account) => {
        const sessionDate = market === account.market ? digestDate : reportingDate(account.market, at);
        const onDate = (value) => localMarketTime(value, account.market)?.date === sessionDate;
        const metrics = computeMetrics(account, { benchmarkPrice: account.benchmark?.lastPrice ?? null, now: at });
        const health = runHealth(account, at);
        const trades = account.trades.filter((trade) => onDate(trade.at)).map((trade) => ({ side: trade.side, symbol: trade.symbol, name: trade.name, quantity: trade.quantity, price: trade.price, realizedPnl: trade.realizedPnl, trigger: trade.trigger ?? null }));
        const events = (account.events ?? []).filter((event) => onDate(event.at) && !["risk-policy", "exits-set"].includes(event.type));
        const rejected = account.orders.filter((order) => order.status === "rejected" && onDate(order.closedAt ?? order.createdAt)).length;
        const latest = account.reports?.at(-1) ?? null;
        const warnings = [
          ...(health.status === "missed" ? [zh ? `漏跑 ${health.missedTradingDays} 个交易日（最近一轮 ${health.lastRoundAt ?? "从未"}）` : `Missed ${health.missedTradingDays} trading day(s) (last round ${health.lastRoundAt ?? "never"})`] : []),
          ...(account.risk?.breaker ? [zh ? `回撤熔断已触发（${account.risk.breaker.drawdownPct}%），禁止新买入` : `Drawdown breaker tripped (${account.risk.breaker.drawdownPct}%); buys blocked`] : []),
          ...(latest && onDate(latest.at) ? [] : [zh ? "本交易日没有发布报告" : "No report published this session"]),
          ...(rejected ? [zh ? `${rejected} 笔委托被拒` : `${rejected} order(s) rejected`] : []),
          ...events.filter((event) => ["stop-loss", "take-profit", "exit-deferred", "suspended", "risk-reduce", "corporate-action-skipped"].includes(event.type)).map((event) => event.message),
        ];
        return {
          id: account.id, name: account.name, model: account.model, agent: account.agent.label ?? account.agent.client ?? null, market: account.market, currency: account.currency,
          sessionDate, equity: metrics.equity, dayReturnPct: metrics.todayReturnPct, totalReturnPct: metrics.totalReturnPct, excessReturnPct: metrics.excessReturnPct,
          maxDrawdownPct: metrics.maxDrawdownPct, exposurePct: metrics.exposurePct, positions: metrics.positions, trades,
          corporateActions: events.filter((event) => ["dividend", "split", "bonus"].includes(event.type)).map((event) => event.message),
          latestReport: latest ? { title: latest.title, summary: latest.summary, at: latest.at, sentiment: latest.sentiment, today: onDate(latest.at) } : null,
          health: { status: health.status, missedTradingDays: health.missedTradingDays, lastRoundAt: health.lastRoundAt }, warnings,
        };
      }).sort((a, b) => a.market.localeCompare(b.market) || b.totalReturnPct - a.totalReturnPct);
      const marketLabel = market ? `${market} ` : "";
      const title = zh ? `Agent 模拟盘日报 · ${marketLabel}${digestDate}` : `Agent arena digest · ${marketLabel}${digestDate}`;
      const pct = (value) => (finite(value) ? `${value >= 0 ? "+" : ""}${value}%` : "—");
      const lines = [`**${title}**`, zh ? "（虚拟资金模拟盘，非真实收益）" : "(Virtual-money paper trading, not real returns)", ""];
      for (const row of rows) {
        lines.push(`• ${row.name} [${row.market}·${row.model}] ${zh ? "净值" : "equity"} ${row.equity} ${row.currency} | ${zh ? "当日" : "day"} ${pct(row.dayReturnPct)} | ${zh ? "累计" : "total"} ${pct(row.totalReturnPct)} | ${zh ? "成交" : "fills"} ${row.trades.length}`);
        for (const trade of row.trades.slice(0, 6)) lines.push(`  - ${trade.side === "BUY" ? (zh ? "买" : "BUY") : (zh ? "卖" : "SELL")} ${trade.name ?? trade.symbol} ${trade.quantity} @ ${trade.price}${trade.trigger ? ` (${trade.trigger})` : ""}`);
        if (row.latestReport) lines.push(`  ${zh ? "报告" : "Report"}: ${row.latestReport.title}${row.latestReport.today ? "" : zh ? "（旧）" : " (earlier)"}`);
        for (const action of row.corporateActions) lines.push(`  ${zh ? "公司行动" : "Corporate action"}: ${action}`);
        for (const warning of row.warnings) lines.push(`  ⚠ ${warning}`);
      }
      if (!rows.length) lines.push(zh ? "没有活跃账户。" : "No active accounts.");
      const digest = {
        id: `dig_${digestDate}_${market ?? "manual"}`, at, date: digestDate, market, trigger, language, title,
        headline: rows.length ? `${rows.length} ${zh ? "个账户" : "accounts"} · ${rows.reduce((sum, row) => sum + row.trades.length, 0)} ${zh ? "笔成交" : "fills"} · ${rows.reduce((sum, row) => sum + row.warnings.length, 0)} ${zh ? "条提醒" : "warnings"}` : (zh ? "没有活跃账户" : "No active accounts"),
        totals: { accounts: rows.length, trades: rows.reduce((sum, row) => sum + row.trades.length, 0), warnings: rows.reduce((sum, row) => sum + row.warnings.length, 0) },
        accounts: rows, text: lines.join("\n"), delivery: null,
      };
      await withLock(async () => {
        await mkdir(digestDir, { recursive: true });
        await writeFile(path.join(digestDir, `${digest.id}.json`), JSON.stringify(digest, null, 1), "utf8");
        const names = (await readdir(digestDir)).filter((name) => name.endsWith(".json")).sort();
        for (const name of names.slice(0, Math.max(0, names.length - LIMITS.digests))) await rm(path.join(digestDir, name), { force: true });
      });
      return digest;
    },

    async getDigest(id) {
      if (!/^dig_\d{4}-\d{2}-\d{2}_[A-Za-z]+$/.test(id ?? "")) throw new ArenaError(`Invalid digest id: ${id}`);
      try { return JSON.parse(await readFile(path.join(digestDir, `${id}.json`), "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    },

    async listDigests({ limit = 30 } = {}) {
      let names = [];
      try { names = await readdir(digestDir); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const digests = [];
      for (const name of names.filter((entry) => /^dig_.+\.json$/.test(entry))) {
        try { digests.push(JSON.parse(await readFile(path.join(digestDir, name), "utf8"))); } catch { /* Skip a file mid-write. */ }
      }
      return digests.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
    },

    async recordDigestDelivery(id, delivery) {
      return withLock(async () => {
        const file = path.join(digestDir, `${id}.json`);
        const digest = JSON.parse(await readFile(file, "utf8"));
        digest.delivery = { ...delivery, attempts: (digest.delivery?.attempts ?? 0) + 1 };
        await writeFile(file, JSON.stringify(digest, null, 1), "utf8");
        return digest;
      });
    },
  };
}

let defaultArena;
export function getArena() {
  defaultArena ??= createArena({ corporateActionProvider: getCorporateActions });
  return defaultArena;
}

// ---------------------------------------------------------------------------
// End-of-day digest delivery
// ---------------------------------------------------------------------------

export function digestPayload(digest, format = "generic") {
  if (format === "wecom") return { msgtype: "markdown", markdown: { content: digest.text.slice(0, 4000) } };
  if (format === "feishu") return { msg_type: "text", content: { text: digest.text.slice(0, 30000) } };
  return { type: "hrouter.arena.digest", version: 1, id: digest.id, title: digest.title, headline: digest.headline, text: digest.text, generatedAt: digest.at, paperTradingOnly: true, digest };
}

// POST the digest to the owner's webhook (generic JSON, or WeChat Work / Feishu bot shapes).
export async function deliverDigest(digest, webhook, { fetchImpl = fetch, timeoutMs = 10000, now = () => new Date().toISOString() } = {}) {
  if (!webhook?.url || webhook.enabled === false) return { status: "skipped", at: now() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(webhook.url, {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": "hrouter-market-pulse-digest" },
      body: JSON.stringify(digestPayload(digest, webhook.format)), signal: controller.signal,
    });
    return response.ok ? { status: "delivered", httpStatus: response.status, at: now() } : { status: "failed", httpStatus: response.status, error: `HTTP ${response.status}`, at: now() };
  } catch (error) {
    return { status: "failed", error: error.name === "AbortError" ? "timeout" : error.message, at: now() };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Background matcher
// ---------------------------------------------------------------------------

// Runs inside every MCP / dashboard process; the lease file elects one leader per arena dir. The
// leader syncs accounts whose market is in a regular session every 1-2 minutes, and after each close
// syncs once more (expiring day orders), writes the digest and posts it to the owner's webhook.
export function createMatcher({
  arena, intervalMs = MATCHER_DEFAULTS.intervalMs, jitterMs = MATCHER_DEFAULTS.jitterMs, leaseMs = MATCHER_DEFAULTS.leaseMs,
  getPreferences = loadPreferences, fetchImpl = fetch, digestWindowMs = MATCHER_DEFAULTS.digestWindowMs, onError = () => {},
} = {}) {
  const ownerId = `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
  let timer = null;
  let running = null;
  let role = "idle";
  let last = null;

  async function deliver(digest, preferences) {
    const webhook = preferences?.digestWebhook;
    if (!webhook?.url || webhook.enabled === false) return digest;
    const delivery = await deliverDigest(digest, webhook, { fetchImpl, now: arena.now });
    return arena.recordDigestDelivery(digest.id, delivery);
  }

  async function runTick() {
    const at = arena.now();
    const lease = await arena.acquireMatcherLease(ownerId, leaseMs);
    if (!lease.owner) {
      role = "standby";
      last = { at, role, leader: lease.lease?.ownerId ?? null };
      return last;
    }
    role = "leader";
    const result = { at, role, ownerId, synced: 0, fills: 0, exits: 0, events: 0, markets: {}, digests: [], deliveries: [], errors: [] };
    const groups = await arena.activeByMarket();
    let preferences = null;
    const prefs = async () => (preferences ??= await getPreferences().catch(() => ({})));
    for (const [market, group] of groups) {
      const session = getMarketSession(market, at);
      result.markets[market] = session.status;
      try {
        if (session.status === "open") {
          const synced = await arena.sync(group.ids, { force: true });
          result.synced += synced.synced;
          result.events += synced.events.length;
          result.fills += synced.events.filter((event) => event.type === "filled" || event.type === "partial").length;
          result.exits += synced.events.filter((event) => event.type === "stop-loss" || event.type === "take-profit").length;
          continue;
        }
        const closed = lastCompletedSession(market, at);
        if (!closed || Date.parse(at) - Date.parse(closed.closeAt) > digestWindowMs || group.firstCreatedAt > closed.closeAt) continue;
        if (await arena.getDigest(`dig_${closed.date}_${market}`)) continue;
        await arena.sync(group.ids, { force: true });
        const digest = await arena.generateDigest({ market, date: closed.date, trigger: "market-close", language: (await prefs()).language });
        result.digests.push(digest.id);
        const delivered = await deliver(digest, await prefs());
        if (delivered.delivery) result.deliveries.push({ id: digest.id, status: delivered.delivery.status });
      } catch (error) {
        result.errors.push(`${market}: ${error.message}`);
        onError(error);
      }
    }
    // Retry failed webhook deliveries from the last day.
    try {
      const webhook = (await prefs()).digestWebhook;
      if (webhook?.url && webhook.enabled !== false) {
        for (const digest of await arena.listDigests({ limit: 10 })) {
          if (result.digests.includes(digest.id) || digest.trigger === "manual" || Date.parse(at) - Date.parse(digest.at) > 86400000) continue;
          if (digest.delivery?.status === "delivered" || (digest.delivery?.attempts ?? 0) >= MATCHER_DEFAULTS.webhookAttempts) continue;
          if (digest.delivery && Date.parse(at) - Date.parse(digest.delivery.at) < 10 * 60000) continue;
          const delivered = await deliver(digest, { digestWebhook: webhook });
          result.deliveries.push({ id: digest.id, status: delivered.delivery?.status, retry: true });
        }
      }
    } catch (error) { result.errors.push(`webhook: ${error.message}`); }
    last = result;
    const previous = await arena.matcherStatus().catch(() => ({}));
    const hasWork = result.synced || result.digests.length;
    await arena.writeMatcherStatus({
      ownerId, pid: process.pid, host: os.hostname(), intervalMs, lastTickAt: at,
      lastRunAt: hasWork ? at : previous.lastRunAt ?? null, lastResult: { ...result, events: result.events },
      lastError: result.errors.at(-1) ?? null, lastErrorAt: result.errors.length ? at : previous.lastErrorAt ?? null,
      nextTickAt: new Date(Date.parse(at) + intervalMs).toISOString(), markets: result.markets,
      totals: { ticks: (previous.totals?.ticks ?? 0) + 1, fills: (previous.totals?.fills ?? 0) + result.fills, exits: (previous.totals?.exits ?? 0) + result.exits, digests: (previous.totals?.digests ?? 0) + result.digests.length },
    });
    return result;
  }

  // Ticks never overlap within one process; the lease prevents overlap across processes.
  async function tick() {
    if (running) return running;
    running = runTick().catch((error) => { onError(error); last = { at: arena.now(), role, error: error.message }; return last; })
      .finally(() => { running = null; });
    return running;
  }

  function schedule(delay) {
    timer = setTimeout(async () => {
      await tick();
      if (timer) schedule(intervalMs + Math.round((Math.random() * 2 - 1) * jitterMs));
    }, delay);
    timer.unref?.();
  }

  return {
    ownerId,
    tick,
    start({ initialDelayMs = 5000 } = {}) { if (!timer) schedule(initialDelayMs); return this; },
    async stop() {
      const wasRunning = Boolean(timer);
      clearTimeout(timer);
      timer = null;
      await running;
      if (wasRunning || role === "leader") await arena.releaseMatcherLease(ownerId).catch(() => {});
      role = "stopped";
    },
    status: () => ({ ownerId, role, last }),
  };
}

// Identity of the MCP client so accounts can be attributed and protected.
export function callerFromClient(clientInfo) {
  const override = process.env.HROUTER_AGENT_ID?.trim();
  const name = override || clientInfo?.name || "unknown-agent";
  return { client: name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 60), clientVersion: clientInfo?.version ?? null, clientName: clientInfo?.name ?? null };
}
