// Trader settings the owner (or an agent, unless the owner locked the item) can change at any time:
// hard limits checked before every order, per-market fee schedules, layered prompts and cadence.
// Limits are enforced by the arena itself, so an agent cannot trade around them by rewriting its
// strategy text. Every change is recorded with who made it and why.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getInstrumentRules, localMarketTime } from "./market-rules.mjs";

const round = (value, digits = 2) => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const shortId = (prefix) => `${prefix}_${randomBytes(6).toString("hex")}`;

export class SettingsError extends Error {
  constructor(message, code = "invalid_request", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const BOARD_OPTIONS = ["st", "star", "chinext", "bse"];

// type: pct | int | number | boards | enum. Empty (null) means "no limit".
export const LIMIT_SPECS = {
  minCashPct: { type: "pct", min: 0, max: 95, zh: "保留现金", en: "Keep cash", hint: "现金低于总资产这个比例时不能买入" },
  maxPositions: { type: "int", min: 1, max: 200, zh: "最多持有几只", en: "Max holdings", hint: "到上限后只能卖，或在已有持仓上加" },
  maxPositionPct: { type: "pct", min: 1, max: 100, zh: "单只最大仓位", en: "Max per position", hint: "单只市值占总资产的上限" },
  maxExposurePct: { type: "pct", min: 1, max: 100, zh: "总仓位上限", en: "Max exposure", hint: "所有持仓市值合计的上限" },
  maxNewPerDay: { type: "int", min: 1, max: 100, zh: "每天最多新开几只", en: "New positions per day", hint: "防止一天换手过多" },
  maxOrdersPerDay: { type: "int", min: 1, max: 500, zh: "每天最多几笔买单", en: "Buy orders per day", hint: "防止来回折腾；卖出不受限" },
  maxRiskPerTradePct: { type: "pct", min: 0.1, max: 20, zh: "单笔最大风险", en: "Max risk per trade", hint: "（买入价 − 止损价）× 股数 ÷ 总资产；开了之后买单必须带止损" },
  cooldownDays: { type: "int", min: 1, max: 30, zh: "卖出后冷却", en: "Re-buy cooldown", hint: "卖出后多少天内不能再买回同一只" },
  excludeBoards: { type: "boards", zh: "禁止范围", en: "Excluded boards", hint: "ST、科创板、创业板、北交所" },
  minPrice: { type: "number", min: 0.01, max: 100000, zh: "最低股价", en: "Min price", hint: "股价低于这个数不买" },
  maxChangePct: { type: "number", min: 0, max: 30, zh: "不追涨", en: "No chasing", hint: "当日涨幅超过这个比例不买" },
  maxDrawdownPct: { type: "pct", min: 1, max: 90, zh: "回撤熔断", en: "Drawdown breaker", hint: "从最高点回撤超过这个比例，停止新买入" },
};
export const LIMIT_KEYS = Object.keys(LIMIT_SPECS);
// Every key of a stored policy. onBreach / reduceToExposurePct configure the drawdown breaker.
export const DEFAULT_LIMITS = Object.freeze({ ...Object.fromEntries(LIMIT_KEYS.map((key) => [key, null])), onBreach: "block", reduceToExposurePct: 50 });
// New accounts (and accounts upgraded from schema 1) keep 20% cash; everything else is off.
export const NEW_ACCOUNT_LIMITS = Object.freeze({ ...DEFAULT_LIMITS, minCashPct: 20 });

export function sanitizeLimits(input = {}, current = {}) {
  const next = { ...DEFAULT_LIMITS, ...current };
  for (const key of Object.keys(input)) {
    if (!(key in LIMIT_SPECS) && !["onBreach", "reduceToExposurePct", "updatedAt"].includes(key)) throw new SettingsError(`Unknown limit "${key}". Known: ${LIMIT_KEYS.join(", ")}.`);
  }
  for (const [key, spec] of Object.entries(LIMIT_SPECS)) {
    if (input[key] === undefined) continue;
    const raw = input[key];
    if (raw === null || raw === "" || (Array.isArray(raw) && !raw.length)) { next[key] = null; continue; }
    if (spec.type === "boards") {
      if (!Array.isArray(raw) || raw.some((board) => !BOARD_OPTIONS.includes(board))) throw new SettingsError(`${key} must be a list of ${BOARD_OPTIONS.join(", ")}.`);
      next[key] = [...new Set(raw)];
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < spec.min || value > spec.max || (spec.type === "int" && !Number.isInteger(value)))
      throw new SettingsError(`${key} must be ${spec.type === "int" ? "a whole number" : "a number"} between ${spec.min} and ${spec.max}, or empty to disable.`);
    next[key] = spec.type === "int" ? value : round(value, 2);
  }
  if (input.reduceToExposurePct !== undefined) {
    const value = input.reduceToExposurePct === null || input.reduceToExposurePct === "" ? DEFAULT_LIMITS.reduceToExposurePct : Number(input.reduceToExposurePct);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new SettingsError("reduceToExposurePct must be between 0 and 100, or empty to disable.");
    next.reduceToExposurePct = round(value, 2);
  }
  if (input.onBreach !== undefined) {
    if (!["block", "reduce"].includes(input.onBreach)) throw new SettingsError("onBreach must be block or reduce.");
    next.onBreach = input.onBreach;
  }
  return next;
}

const boardOf = (symbol, quote) => {
  if (/ST/i.test(quote?.name ?? "")) return "st";
  const board = getInstrumentRules(symbol).board;
  return { STAR: "star", ChiNext: "chinext", BSE: "bse" }[board] ?? null;
};
const BOARD_LABELS = { st: "ST", star: "科创板", chinext: "创业板", bse: "北交所" };

function dayOf(at, market) { return localMarketTime(at, market)?.date ?? String(at).slice(0, 10); }

// Facts about today's activity that the count-based limits need.
export function todayActivity(account, now) {
  const today = dayOf(now, account.market);
  const ordersToday = account.orders.filter((order) => dayOf(order.createdAt, account.market) === today && order.status !== "rejected" && !order.trigger);
  const opened = new Set(Object.values(account.positions).filter((position) => dayOf(position.openedAt, account.market) === today).map((position) => position.symbol));
  for (const order of account.orders) if (order.status === "open" && order.side === "BUY" && !account.positions[order.symbol]) opened.add(order.symbol);
  return { today, ordersToday: ordersToday.length, newToday: opened };
}

// Why a buy breaks one of the hard limits, or null. `value` is the account valuation; `order`
// carries symbol, quantity, price estimate, stop level and the observed quote.
export function limitViolation(account, limits, value, { symbol, addValue, quantity, price, stopPrice, quote, now, pending }) {
  if (value.equity <= 0) return null;
  const held = Boolean(account.positions[symbol]);
  const pendingBuys = pending.filter((order) => order.side === "BUY");
  const label = (key) => `边界「${LIMIT_SPECS[key].zh}」`;
  if (finite(limits.minCashPct)) {
    const reserved = pendingBuys.reduce((sum, order) => sum + order.reserved, 0);
    const cashAfter = account.cash - reserved - addValue;
    const pct = cashAfter / value.equity * 100;
    if (pct < limits.minCashPct - 1e-9) {
      const room = Math.max(0, account.cash - reserved - value.equity * limits.minCashPct / 100);
      return `${label("minCashPct")}：买入后现金只剩 ${round(pct, 1)}%，低于保留的 ${limits.minCashPct}%（现在最多还能买约 ${round(room)} ${account.currency}）。`;
    }
  }
  if (finite(limits.maxPositions) && !held && !pendingBuys.some((order) => order.symbol === symbol)) {
    const count = new Set([...Object.keys(account.positions), ...pendingBuys.map((order) => order.symbol)]).size;
    if (count >= limits.maxPositions) return `${label("maxPositions")}：已经持有或挂单 ${count} 只，上限 ${limits.maxPositions} 只；先卖出一只再买新的。`;
  }
  const activity = todayActivity(account, now);
  if (finite(limits.maxNewPerDay) && !held && !activity.newToday.has(symbol) && activity.newToday.size >= limits.maxNewPerDay)
    return `${label("maxNewPerDay")}：今天已经新开 ${activity.newToday.size} 只，上限 ${limits.maxNewPerDay} 只。`;
  if (finite(limits.maxOrdersPerDay) && activity.ordersToday >= limits.maxOrdersPerDay)
    return `${label("maxOrdersPerDay")}：今天已经下了 ${activity.ordersToday} 笔，上限 ${limits.maxOrdersPerDay} 笔。`;
  if (finite(limits.maxRiskPerTradePct)) {
    if (!finite(stopPrice)) return `${label("maxRiskPerTradePct")}：开了单笔风险上限，买单必须带止损（stopLossPct 或 stopLossPrice）。`;
    const risk = Math.max(0, (price - stopPrice) * quantity) / value.equity * 100;
    if (risk > limits.maxRiskPerTradePct + 1e-9) return `${label("maxRiskPerTradePct")}：这笔最多亏 ${round(risk, 2)}% 的总资产，上限 ${limits.maxRiskPerTradePct}%。`;
  }
  if (finite(limits.cooldownDays)) {
    const lastSell = [...account.trades].reverse().find((trade) => trade.symbol === symbol && trade.side === "SELL");
    if (lastSell) {
      const days = (Date.parse(`${dayOf(now, account.market)}T00:00:00Z`) - Date.parse(`${dayOf(lastSell.at, account.market)}T00:00:00Z`)) / 86400000;
      if (days < limits.cooldownDays) return `${label("cooldownDays")}：${symbol} 在 ${dayOf(lastSell.at, account.market)} 卖出，${limits.cooldownDays} 天内不能买回。`;
    }
  }
  if (Array.isArray(limits.excludeBoards) && limits.excludeBoards.length) {
    const board = boardOf(symbol, quote);
    if (board && limits.excludeBoards.includes(board)) return `${label("excludeBoards")}：${symbol} 属于${BOARD_LABELS[board]}，在禁止范围里。`;
  }
  if (finite(limits.minPrice) && finite(quote?.price) && quote.price < limits.minPrice)
    return `${label("minPrice")}：${symbol} 现价 ${quote.price}，低于 ${limits.minPrice}。`;
  if (finite(limits.maxChangePct) && finite(quote?.changePct) && quote.changePct > limits.maxChangePct)
    return `${label("maxChangePct")}：${symbol} 今天已经涨了 ${round(quote.changePct, 2)}%，超过 ${limits.maxChangePct}%。`;
  return null;
}

// Room left under each active limit, so agents and the dashboard need not compute it themselves.
export function limitStatus(account, limits, value, now) {
  const pending = account.orders.filter((order) => order.status === "open");
  const reserved = pending.filter((order) => order.side === "BUY").reduce((sum, order) => sum + order.reserved, 0);
  const cashPct = value.equity > 0 ? round((account.cash - reserved) / value.equity * 100, 2) : 0;
  const activity = todayActivity(account, now);
  const holdings = new Set([...Object.keys(account.positions), ...pending.filter((order) => order.side === "BUY").map((order) => order.symbol)]).size;
  const status = { cashPct, holdings, newToday: activity.newToday.size, ordersToday: activity.ordersToday, active: LIMIT_KEYS.filter((key) => limits[key] !== null && limits[key] !== undefined && !(Array.isArray(limits[key]) && !limits[key].length)) };
  if (finite(limits.minCashPct)) status.buyableValue = round(Math.max(0, account.cash - reserved - value.equity * limits.minCashPct / 100));
  else status.buyableValue = round(Math.max(0, account.cash - reserved));
  if (finite(limits.maxPositions)) status.positionsLeft = Math.max(0, limits.maxPositions - holdings);
  if (finite(limits.maxNewPerDay)) status.newLeftToday = Math.max(0, limits.maxNewPerDay - activity.newToday.size);
  if (finite(limits.maxOrdersPerDay)) status.ordersLeftToday = Math.max(0, limits.maxOrdersPerDay - activity.ordersToday);
  return status;
}

export function limitsText(limits, status) {
  const parts = [];
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (value === null || value === undefined || (Array.isArray(value) && !value.length)) continue;
    const spec = LIMIT_SPECS[key];
    const shown = Array.isArray(value) ? value.map((board) => BOARD_LABELS[board]).join("、") : spec.type === "pct" || key === "maxChangePct" ? `${value}%` : key === "cooldownDays" ? `${value} 天` : String(value);
    parts.push(`${spec.zh} ${shown}`);
  }
  const room = status ? [`现金 ${status.cashPct}%`, `还能买约 ${status.buyableValue}`, ...(status.positionsLeft !== undefined ? [`还能再开 ${status.positionsLeft} 只`] : []), ...(status.newLeftToday !== undefined ? [`今天还能新开 ${status.newLeftToday} 只`] : [])] : [];
  return parts.length ? `硬性边界（系统在下单前检查，超了会被拒）：${parts.join("；")}。${room.length ? `当前：${room.join("，")}。` : ""}` : "硬性边界：都没开。";
}

// ---------------------------------------------------------------------------
// Fees
// ---------------------------------------------------------------------------

// Retail presets. The owner sets their own broker's numbers; rates are fractions (0.00025 = 0.025%).
export const DEFAULT_FEES = Object.freeze({
  A: { commissionRate: 0.00025, minCommission: 5, waiveMinimum: false, stampDutyRate: 0.0005, transferFeeRate: 0.00001 },
  HK: { commissionRate: 0.0003, minCommission: 3, waiveMinimum: false, stampDutyRate: 0.001, tradingFeeRate: 0.0000565, sfcLevyRate: 0.000027, frcLevyRate: 0.0000015, settlementRate: 0.00002, settlementMin: 2, settlementMax: 100 },
  US: { perShare: 0.005, minCommission: 1, maxCommissionPct: 1, secFeeRate: 0.0000278, tafPerShare: 0.000166, tafMax: 8.3 },
});
const FEE_RANGES = {
  commissionRate: [0, 0.01], minCommission: [0, 100], stampDutyRate: [0, 0.01], transferFeeRate: [0, 0.001], tradingFeeRate: [0, 0.001],
  sfcLevyRate: [0, 0.001], frcLevyRate: [0, 0.001], settlementRate: [0, 0.001], settlementMin: [0, 100], settlementMax: [0, 1000],
  perShare: [0, 0.1], maxCommissionPct: [0, 5], secFeeRate: [0, 0.001], tafPerShare: [0, 0.01], tafMax: [0, 100],
};

export function sanitizeFees(market, input = {}, current = DEFAULT_FEES[market]) {
  if (!DEFAULT_FEES[market]) throw new SettingsError("market must be A, HK or US.");
  const next = { ...DEFAULT_FEES[market], ...current };
  for (const [key, raw] of Object.entries(input)) {
    if (!(key in DEFAULT_FEES[market])) throw new SettingsError(`Unknown ${market} fee "${key}". Known: ${Object.keys(DEFAULT_FEES[market]).join(", ")}.`);
    if (key === "waiveMinimum") { next[key] = Boolean(raw); continue; }
    const value = Number(raw);
    const [low, high] = FEE_RANGES[key];
    if (!Number.isFinite(value) || value < low || value > high) throw new SettingsError(`${key} must be between ${low} and ${high}.`);
    next[key] = value;
  }
  return next;
}

export function computeFees(market, side, quantity, price, schedule = DEFAULT_FEES[market]) {
  const fee = { ...DEFAULT_FEES[market], ...schedule };
  const value = quantity * price;
  const parts = {};
  const clamp = (amount, low, high) => Math.min(high, Math.max(low, amount));
  if (market === "A") {
    parts.commission = fee.waiveMinimum ? value * fee.commissionRate : Math.max(fee.minCommission, value * fee.commissionRate);
    parts.stampDuty = side === "SELL" ? value * fee.stampDutyRate : 0;
    parts.transferFee = value * fee.transferFeeRate;
  } else if (market === "HK") {
    parts.commission = fee.waiveMinimum ? value * fee.commissionRate : Math.max(fee.minCommission, value * fee.commissionRate);
    parts.stampDuty = Math.ceil(value * fee.stampDutyRate);
    parts.tradingFee = value * fee.tradingFeeRate;
    parts.sfcLevy = value * fee.sfcLevyRate;
    parts.frcLevy = value * fee.frcLevyRate;
    parts.settlement = clamp(value * fee.settlementRate, fee.settlementMin, fee.settlementMax);
  } else {
    parts.commission = clamp(quantity * fee.perShare, fee.minCommission, value * fee.maxCommissionPct / 100);
    parts.secFee = side === "SELL" ? value * fee.secFeeRate : 0;
    parts.taf = side === "SELL" ? Math.min(quantity * fee.tafPerShare, fee.tafMax) : 0;
  }
  const breakdown = Object.fromEntries(Object.entries(parts).filter(([, amount]) => amount > 0).map(([key, amount]) => [key, round(amount)]));
  return { total: round(Object.values(breakdown).reduce((sum, amount) => sum + amount, 0)), breakdown };
}

// ---------------------------------------------------------------------------
// Workbench-wide settings: fees per market, global / market prompts, concurrency.
// Stored in <arena>/settings.json; every process reads the same file.
// ---------------------------------------------------------------------------

export const DEFAULT_WORKBENCH_SETTINGS = Object.freeze({
  schemaVersion: 1,
  fees: DEFAULT_FEES,
  prompts: { global: "", A: "", HK: "", US: "" },
  maxConcurrentAgents: 4,
  defaultReviewMinutes: 10,
  locks: {},
  changeLog: [],
});

export const PROMPT_LIMIT = 4000;
const CHANGE_LOG_LIMIT = 500;

export function changeEntry({ key, from, to, by, reason, at }) {
  return { id: shortId("chg"), at, key, from: from ?? null, to: to ?? null, by, reason: reason ? String(reason).slice(0, 500) : null };
}

export function appendChange(target, entry) {
  target.changeLog = [...(target.changeLog ?? []), entry].slice(-CHANGE_LOG_LIMIT);
  return entry;
}

// Who changed something: the owner in the dashboard, an agent / MCP client, or the system.
export function changedBy(caller) {
  if (!caller?.client || caller.client === "dashboard") return { kind: "owner", via: "ui" };
  if (caller.client === "system") return { kind: "system", via: "system" };
  return { kind: "agent", via: caller.via ?? "mcp", client: caller.client };
}

export const isOwner = (caller) => !caller?.client || caller.client === "dashboard";

export function createWorkbenchSettings(root, now = () => new Date().toISOString()) {
  const file = path.join(root, "settings.json");
  let cache = null;
  async function read() {
    try {
      const info = await stat(file);
      if (cache && cache.mtimeMs === info.mtimeMs) return cache.value;
      const saved = JSON.parse(await readFile(file, "utf8"));
      const value = {
        ...DEFAULT_WORKBENCH_SETTINGS, ...saved,
        fees: Object.fromEntries(Object.keys(DEFAULT_FEES).map((market) => [market, { ...DEFAULT_FEES[market], ...saved.fees?.[market] }])),
        prompts: { ...DEFAULT_WORKBENCH_SETTINGS.prompts, ...saved.prompts },
        locks: saved.locks ?? {},
      };
      cache = { mtimeMs: info.mtimeMs, value };
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(DEFAULT_WORKBENCH_SETTINGS);
      throw error;
    }
  }
  async function write(value) {
    await mkdir(root, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 1), "utf8");
    await rename(temporary, file);
    cache = null;
  }
  return {
    read,
    // Apply a change under the caller's lock (arena.withLock). Locked keys reject non-owners.
    async change(mutate, caller) {
      const current = await read();
      const next = structuredClone(current);
      const result = await mutate(next, { by: changedBy(caller), at: now(), owner: isOwner(caller) });
      await write(next);
      return result ?? next;
    },
  };
}

export function assertUnlocked(locks, key, caller) {
  if (!isOwner(caller) && locks?.[key]) throw new SettingsError(`「${key}」被主人锁定，Agent 不能改。需要改的话，用 reason 说明理由，主人会在工作台里看到申请。`, "locked", 423);
}

export function sanitizePrompt(text) {
  const value = String(text ?? "");
  if (value.length > PROMPT_LIMIT) throw new SettingsError(`Prompt must be at most ${PROMPT_LIMIT} characters.`);
  return value.trim();
}

export { round as roundSetting };
