// Market-wide public data the trader skills and the market radar need, all from East Money's public
// endpoints with the source and trading date on every result: industry classification, the
// dragon-tiger list (龙虎榜) and its broker seats, the limit-up / broken / limit-down pools, margin
// balances, Stock Connect turnover and market breadth. Nothing is estimated: a field the source does
// not publish (northbound net buying since August 2024) comes back as null with a note.

import { getMarketSession, localMarketTime, marketLocalToIso } from "./market-rules.mjs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const POOLS = "https://push2ex.eastmoney.com";
const POOL_UT = "7eea3edcaed734bea9cbfc24409ed989";
const ULIST = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const SOURCE = "East Money";

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const round = (value, digits = 2) => (finite(value) === null ? null : Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits);

export class MarketDataError extends Error {}

async function getJson(url, timeoutMs = 10000) {
  const response = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://data.eastmoney.com/" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new MarketDataError(`${SOURCE} HTTP ${response.status}`);
  return response.json();
}

// Small in-process cache: market-wide tables change at most once a minute intraday.
const cache = new Map();
async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

// ---------------------------------------------------------------------------
// Trading dates
// ---------------------------------------------------------------------------

const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

// The A-share date an end-of-day table refers to: today once the session has opened, else the last session.
export function aShareDataDate(at = new Date().toISOString()) {
  const today = getMarketSession("A", at);
  if (!["closed", "premarket"].includes(today.status)) return today.date;
  const local = localMarketTime(at, "A")?.date ?? at.slice(0, 10);
  for (let offset = 1; offset <= 14; offset += 1) {
    const date = addDays(local, -offset);
    if (getMarketSession("A", marketLocalToIso(date, 720, "A")).status !== "closed") return date;
  }
  return local;
}

const compactDate = (date) => date.replaceAll("-", "");
const isoDate = (value) => (value ? String(value).slice(0, 10) : null);
function validDate(date) {
  if (date === undefined || date === null || date === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new MarketDataError("date must be YYYY-MM-DD.");
  return String(date);
}

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------

export function symbolFromCode(code, market = "A") {
  const value = String(code).trim();
  if (market === "HK") return `${String(Number(value)).padStart(4, "0")}.HK`;
  if (/^(92|8|4)/.test(value)) return `${value}.BJ`;
  return `${value}.${/^[569]/.test(value) ? "SS" : "SZ"}`;
}

function secidsFor(symbol) {
  const value = String(symbol).toUpperCase();
  if (value.endsWith(".SS")) return [`1.${value.slice(0, -3)}`];
  if (value.endsWith(".SZ") || value.endsWith(".BJ")) return [`0.${value.slice(0, -3)}`];
  if (value.endsWith(".HK")) return [`116.${value.slice(0, -3).padStart(5, "0")}`];
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(value)) return ["105", "106", "107"].map((prefix) => `${prefix}.${value.replace(/-/g, "_")}`);
  return [];
}

// ---------------------------------------------------------------------------
// Industry classification (行业)
// ---------------------------------------------------------------------------

export function parseIndustries(payload, symbols) {
  const byCode = new Map((payload?.data?.diff ?? []).map((row) => [String(row.f12).toUpperCase(), row.f100 && row.f100 !== "-" ? String(row.f100) : null]));
  const result = {};
  for (const symbol of symbols) {
    const code = String(symbol).toUpperCase().replace(/\.(SS|SZ|BJ)$/, "").replace(/\.HK$/, "").replace(/-/g, "_");
    const hk = /\.HK$/i.test(symbol) ? code.padStart(5, "0") : null;
    const industry = byCode.get(hk ?? code) ?? byCode.get(code);
    if (industry) result[symbol] = industry;
  }
  return result;
}

const industryCache = new Map();
const INDUSTRY_TTL_MS = 24 * 3600000;

// Industry of each symbol (East Money's classification: 申万-style for A-shares, sector for HK / US).
// Unknown symbols are left out rather than guessed.
export async function industriesOf(symbols, { fetchImpl = getJson } = {}) {
  const wanted = [...new Set(symbols.filter(Boolean).map(String))];
  const result = {};
  const missing = [];
  for (const symbol of wanted) {
    const hit = industryCache.get(symbol);
    if (hit && Date.now() - hit.at < INDUSTRY_TTL_MS) { if (hit.industry) result[symbol] = hit.industry; }
    else missing.push(symbol);
  }
  for (let index = 0; index < missing.length; index += 40) {
    const batch = missing.slice(index, index + 40);
    const secids = batch.flatMap(secidsFor);
    if (!secids.length) continue;
    const payload = await fetchImpl(`${ULIST}?fltt=2&secids=${secids.join(",")}&fields=f12,f14,f100`);
    const found = parseIndustries(payload, batch);
    for (const symbol of batch) {
      industryCache.set(symbol, { at: Date.now(), industry: found[symbol] ?? null });
      if (found[symbol]) result[symbol] = found[symbol];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dragon-tiger list (龙虎榜)
// ---------------------------------------------------------------------------

export function parseDragonTiger(payload) {
  const rows = payload?.result?.data ?? [];
  // A stock appears once per listing reason; keep each (symbol, reason) pair.
  return rows.map((row) => ({
    symbol: symbolFromCode(row.SECURITY_CODE), name: row.SECURITY_NAME_ABBR, date: isoDate(row.TRADE_DATE), reason: row.EXPLANATION ?? null,
    close: finite(row.CLOSE_PRICE), changePct: round(finite(row.CHANGE_RATE)), netBuy: round(finite(row.BILLBOARD_NET_AMT), 0),
    buy: round(finite(row.BILLBOARD_BUY_AMT), 0), sell: round(finite(row.BILLBOARD_SELL_AMT), 0), shareOfTurnoverPct: round(finite(row.DEAL_AMOUNT_RATIO)),
  }));
}

export async function dragonTiger({ date, limit = 50, at } = {}) {
  const day = validDate(date) ?? aShareDataDate(at);
  const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
  return cached(`lhb:${day}:${bounded}`, 300000, async () => {
    const columns = "SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,EXPLANATION,CLOSE_PRICE,CHANGE_RATE,BILLBOARD_NET_AMT,BILLBOARD_BUY_AMT,BILLBOARD_SELL_AMT,DEAL_AMOUNT_RATIO";
    const payload = await getJson(`${DATACENTER}?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=${columns}&sortColumns=BILLBOARD_NET_AMT&sortTypes=-1&pageSize=${bounded}&pageNumber=1&filter=${encodeURIComponent(`(TRADE_DATE='${day}')`)}`);
    const rows = parseDragonTiger(payload);
    return { date: day, source: `${SOURCE} 龙虎榜`, total: payload?.result?.count ?? rows.length, rows, note: rows.length ? null : `${day} 没有龙虎榜数据（非交易日，或收盘后约 18:00 才公布）。` };
  });
}

export function parseSeats(payload, side) {
  return (payload?.result?.data ?? []).map((row) => ({
    side, seat: row.OPERATEDEPT_NAME, buy: round(finite(row.BUY), 0), sell: round(finite(row.SELL), 0), net: round(finite(row.NET), 0),
    rise3dPct: round(finite(row.RISE_PROBABILITY_3DAY), 1), seatTimes3d: finite(row.TOTAL_BUYER_SALESTIMES_3DAY),
    institution: /机构专用/.test(row.OPERATEDEPT_NAME ?? ""), connect: /沪股通|深股通/.test(row.OPERATEDEPT_NAME ?? ""),
  }));
}

// Broker seats behind one stock's dragon-tiger listing: the top five buyers and sellers.
export async function dragonTigerSeats(symbol, { date, at } = {}) {
  const code = String(symbol).replace(/\.(SS|SZ|BJ)$/i, "");
  if (!/^\d{6}$/.test(code)) throw new MarketDataError("Dragon-tiger seats exist for A-shares only (6-digit code).");
  const day = validDate(date) ?? aShareDataDate(at);
  return cached(`seats:${code}:${day}`, 300000, async () => {
    const query = (report, sort) => getJson(`${DATACENTER}?reportName=${report}&columns=ALL&filter=${encodeURIComponent(`(TRADE_DATE='${day}')(SECURITY_CODE="${code}")`)}&pageNumber=1&pageSize=10&sortTypes=-1&sortColumns=${sort}`);
    const [buys, sells] = await Promise.all([query("RPT_BILLBOARD_DAILYDETAILSBUY", "BUY"), query("RPT_BILLBOARD_DAILYDETAILSSELL", "SELL")]);
    const buyers = parseSeats(buys, "buy");
    const sellers = parseSeats(sells, "sell");
    return { symbol: symbolFromCode(code), date: day, source: `${SOURCE} 龙虎榜营业部`, buyers, sellers, note: buyers.length || sellers.length ? null : `${symbolFromCode(code)} 在 ${day} 没有上龙虎榜。` };
  });
}

// ---------------------------------------------------------------------------
// Limit-up / broken / limit-down pools (涨停池、炸板池、跌停池)
// ---------------------------------------------------------------------------

const poolTime = (value) => {
  const text = String(value ?? "").padStart(6, "0");
  return /^\d{6}$/.test(text) && value ? `${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4, 6)}` : null;
};

export function parsePool(payload, kind) {
  const data = payload?.data;
  const rows = (data?.pool ?? []).map((row) => ({
    symbol: symbolFromCode(row.c), name: row.n, price: finite(row.p) === null ? null : row.p / 1000, changePct: round(finite(row.zdp)),
    amount: round(finite(row.amount), 0), floatCap: round(finite(row.ltsz), 0), turnoverPct: round(finite(row.hs)), industry: row.hybk ?? null,
    ...(kind === "up" ? {
      boards: finite(row.lbc), firstSealAt: poolTime(row.fbt), lastSealAt: poolTime(row.lbt), sealFund: round(finite(row.fund), 0), breaks: finite(row.zbc),
      streak: row.zttj ? { days: finite(row.zttj.days), limitUps: finite(row.zttj.ct) } : null,
    } : {}),
    ...(kind === "broken" ? { limitUpPrice: finite(row.ztp) === null ? null : row.ztp / 1000, firstSealAt: poolTime(row.fbt), breaks: finite(row.zbc), amplitudePct: round(finite(row.zf)) } : {}),
    ...(kind === "down" ? { sealFund: round(finite(row.fund), 0), lastSealAt: poolTime(row.lbt), boards: finite(row.days) } : {}),
  }));
  return { total: finite(data?.tc) ?? rows.length, date: data?.qdate ? `${String(data.qdate).slice(0, 4)}-${String(data.qdate).slice(4, 6)}-${String(data.qdate).slice(6, 8)}` : null, rows };
}

const POOL_PATHS = { up: ["getTopicZTPool", "fbt:asc"], broken: ["getTopicZBPool", "fbt:asc"], down: ["getTopicDTPool", "fund:asc"] };

export async function limitPool(kind = "up", { date, at, limit = 200 } = {}) {
  if (!POOL_PATHS[kind]) throw new MarketDataError("kind must be up, broken or down.");
  const day = validDate(date) ?? aShareDataDate(at);
  const [pathName, sort] = POOL_PATHS[kind];
  const bounded = Math.max(1, Math.min(500, Number(limit) || 200));
  return cached(`pool:${kind}:${day}:${bounded}`, 60000, async () => {
    const payload = await getJson(`${POOLS}/${pathName}?ut=${POOL_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=${bounded}&sort=${encodeURIComponent(sort)}&date=${compactDate(day)}`);
    const parsed = parsePool(payload, kind);
    return { kind, date: parsed.date ?? day, source: `${SOURCE} ${{ up: "涨停板行情", broken: "炸板池", down: "跌停池" }[kind]}`, total: parsed.total, rows: parsed.rows, note: parsed.rows.length ? null : `${day} 没有数据（非交易日或还没开盘）。` };
  });
}

// The limit-up ladder and the day's sentiment: counts by consecutive boards, broken rate, highest board.
export function sentimentFrom(up, broken, down) {
  const ladder = new Map();
  for (const row of up.rows) {
    const boards = row.boards ?? 1;
    ladder.set(boards, [...(ladder.get(boards) ?? []), { symbol: row.symbol, name: row.name, industry: row.industry, firstSealAt: row.firstSealAt }]);
  }
  const attempts = up.total + broken.total;
  const industries = new Map();
  for (const row of up.rows) if (row.industry) industries.set(row.industry, (industries.get(row.industry) ?? 0) + 1);
  return {
    limitUps: up.total, broken: broken.total, limitDowns: down.total,
    brokenRatePct: attempts ? round(broken.total / attempts * 100, 1) : null,
    highestBoard: up.rows.reduce((max, row) => Math.max(max, row.boards ?? 1), 0) || null,
    ladder: [...ladder.entries()].sort((a, b) => b[0] - a[0]).map(([boards, stocks]) => ({ boards, count: stocks.length, stocks })),
    hotIndustries: [...industries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([industry, count]) => ({ industry, limitUps: count })),
  };
}

export async function limitUpSentiment({ date, at } = {}) {
  const [up, broken, down] = await Promise.all([limitPool("up", { date, at }), limitPool("broken", { date, at }), limitPool("down", { date, at })]);
  return { date: up.date, source: `${SOURCE} 涨停板行情`, ...sentimentFrom(up, broken, down) };
}

// ---------------------------------------------------------------------------
// Margin (融资融券)
// ---------------------------------------------------------------------------

export function parseMarketMargin(payload) {
  return (payload?.result?.data ?? []).map((row) => ({
    date: isoDate(row.DIM_DATE), financingBalance: round(finite(row.RZYE), 0), financingBuy: round(finite(row.RZMRE), 0), financingNet: round(finite(row.RZJME), 0),
    shortBalance: round(finite(row.RQYE), 0), financingShareOfFloatPct: round(finite(row.RZYEZB)),
  }));
}

export function parseStockMargin(payload) {
  return (payload?.result?.data ?? []).map((row) => ({
    date: isoDate(row.DATE), symbol: symbolFromCode(row.SCODE), name: row.SECNAME, financingBalance: round(finite(row.RZYE), 0), financingBuy: round(finite(row.RZMRE), 0),
    financingNet: round(finite(row.RZJME), 0), shortBalance: round(finite(row.RQYE), 0), total: round(finite(row.RZRQYE), 0),
  }));
}

// Whole-market margin balances, newest first (published the next morning for the previous session).
export async function marketMargin({ days = 20 } = {}) {
  const bounded = Math.max(1, Math.min(120, Number(days) || 20));
  return cached(`margin:${bounded}`, 600000, async () => {
    const rows = parseMarketMargin(await getJson(`${DATACENTER}?reportName=RPTA_RZRQ_LSHJ&columns=ALL&sortColumns=DIM_DATE&sortTypes=-1&pageSize=${bounded}&pageNumber=1`));
    return { source: `${SOURCE} 融资融券`, unit: "CNY", rows };
  });
}

export async function stockMargin(symbol, { days = 20 } = {}) {
  const code = String(symbol).replace(/\.(SS|SZ|BJ)$/i, "");
  if (!/^\d{6}$/.test(code)) throw new MarketDataError("Margin data exists for A-shares only (6-digit code).");
  const bounded = Math.max(1, Math.min(120, Number(days) || 20));
  return cached(`margin:${code}:${bounded}`, 600000, async () => {
    const rows = parseStockMargin(await getJson(`${DATACENTER}?reportName=RPTA_WEB_RZRQ_GGMX&columns=DATE,SCODE,SECNAME,RZYE,RZMRE,RZJME,RQYE,RZRQYE&filter=${encodeURIComponent(`(SCODE="${code}")`)}&sortColumns=DATE&sortTypes=-1&pageSize=${bounded}&pageNumber=1`));
    return { symbol: symbolFromCode(code), source: `${SOURCE} 融资融券`, unit: "CNY", rows, note: rows.length ? null : `${symbolFromCode(code)} 不是融资融券标的，或没有数据。` };
  });
}

// ---------------------------------------------------------------------------
// Stock Connect (沪深港通)
// ---------------------------------------------------------------------------

// MUTUAL_TYPE: 001 Shanghai Connect, 003 Shenzhen Connect, 005 northbound total, 006 southbound total.
const CONNECT_TYPES = { "001": "沪股通", "003": "深股通", "005": "北向合计", "006": "南向合计" };

export function parseConnect(payload) {
  return (payload?.result?.data ?? []).map((row) => ({
    channel: CONNECT_TYPES[row.MUTUAL_TYPE] ?? row.MUTUAL_TYPE, date: isoDate(row.TRADE_DATE),
    // Amounts are published in millions of CNY.
    turnover: finite(row.DEAL_AMT) === null ? null : round(row.DEAL_AMT * 1e6, 0),
    netBuy: finite(row.NET_DEAL_AMT) === null ? null : round(row.NET_DEAL_AMT * 1e6, 0),
    trades: finite(row.DEAL_NUM), leader: row.LEAD_STOCKS_NAME ?? null, leaderChangePct: round(finite(row.LS_CHANGE_RATE)),
  }));
}

export async function stockConnect({ days = 10 } = {}) {
  const bounded = Math.max(1, Math.min(60, Number(days) || 10));
  return cached(`connect:${bounded}`, 600000, async () => {
    const channels = await Promise.all(Object.keys(CONNECT_TYPES).map((type) => getJson(`${DATACENTER}?reportName=RPT_MUTUAL_DEAL_HISTORY&columns=ALL&sortColumns=TRADE_DATE&sortTypes=-1&pageSize=${bounded}&pageNumber=1&filter=${encodeURIComponent(`(MUTUAL_TYPE="${type}")`)}`).then(parseConnect)));
    return {
      source: `${SOURCE} 沪深港通`, unit: "CNY", rows: channels.flat(),
      note: "北向资金自 2024 年 8 月起不再公布当日净买入，这里只有成交额（净买入为空）；南向资金仍公布净买入。",
    };
  });
}

// ---------------------------------------------------------------------------
// Breadth and indices
// ---------------------------------------------------------------------------

const BREADTH_INDICES = [["1.000001", "000001.SS", "上证指数"], ["0.399001", "399001.SZ", "深证成指"], ["0.399006", "399006.SZ", "创业板指"], ["1.000688", "000688.SS", "科创50"], ["0.899050", "899050.BJ", "北证50"]];

export function parseBreadth(payload) {
  const rows = (payload?.data?.diff ?? []).map((row) => {
    const known = BREADTH_INDICES.find(([, symbol]) => symbol.startsWith(String(row.f12)));
    return { symbol: known?.[1] ?? row.f12, name: row.f14, price: finite(row.f2), changePct: round(finite(row.f3)), amount: round(finite(row.f6), 0), advancers: finite(row.f104), decliners: finite(row.f105), unchanged: finite(row.f106) };
  });
  const sum = (key, list) => list.reduce((total, row) => total + (row[key] ?? 0), 0);
  // Shanghai + Shenzhen component counts cover the whole A-share market without double counting.
  const whole = rows.filter((row) => ["000001.SS", "399001.SZ"].includes(row.symbol));
  return { indices: rows, advancers: whole.length === 2 ? sum("advancers", whole) : null, decliners: whole.length === 2 ? sum("decliners", whole) : null, unchanged: whole.length === 2 ? sum("unchanged", whole) : null, turnover: whole.length === 2 ? sum("amount", whole) : null };
}

export async function marketBreadth() {
  return cached("breadth", 60000, async () => ({ asOf: new Date().toISOString(), source: `${SOURCE} 指数行情`, ...parseBreadth(await getJson(`${ULIST}?fltt=2&secids=${BREADTH_INDICES.map(([secid]) => secid).join(",")}&fields=f2,f3,f6,f12,f14,f104,f105,f106`)) }));
}

// ---------------------------------------------------------------------------
// Market radar: one call for the dashboard and for agents.
// ---------------------------------------------------------------------------

export async function marketRadar({ at, scan } = {}) {
  const settle = async (promise) => { try { return { ok: true, value: await promise }; } catch (error) { return { ok: false, error: error.message }; } };
  const [breadth, sentiment, lhb, margin, connect, sectors, concepts] = await Promise.all([
    settle(marketBreadth()), settle(limitUpSentiment({ at })), settle(dragonTiger({ at, limit: 20 })), settle(marketMargin({ days: 10 })), settle(stockConnect({ days: 5 })),
    scan ? settle(scan({ market: "A", view: "sectors", sort: "change", limit: 10 })) : Promise.resolve({ ok: false, error: "no scanner" }),
    scan ? settle(scan({ market: "A", view: "concepts", sort: "change", limit: 10 })) : Promise.resolve({ ok: false, error: "no scanner" }),
  ]);
  const part = (result) => (result.ok ? result.value : { error: result.error });
  return { generatedAt: new Date().toISOString(), date: aShareDataDate(at), breadth: part(breadth), sentiment: part(sentiment), dragonTiger: part(lhb), margin: part(margin), connect: part(connect), sectors: part(sectors), concepts: part(concepts) };
}

// ---------------------------------------------------------------------------
// Short-term emotion (adapted from vibe-astock's shortline_emotion: promotion rates, money effect,
// emotion cycle). Built only from the real pools; a reading that cannot be measured is null.
// ---------------------------------------------------------------------------

export function previousTradingDate(date) {
  for (let offset = 1; offset <= 14; offset += 1) {
    const day = addDays(date, -offset);
    if (getMarketSession("A", marketLocalToIso(day, 720, "A")).status !== "closed") return day;
  }
  return null;
}

// Share of yesterday's n-board stocks that sealed board n+1 today, per n (一进二 is n = 1).
export function promotionRates(today, yesterday) {
  const boardsToday = new Map(today.rows.map((row) => [row.symbol, row.boards ?? 1]));
  const groups = new Map();
  for (const row of yesterday.rows) {
    const boards = row.boards ?? 1;
    const group = groups.get(boards) ?? { boards, candidates: 0, promoted: 0, names: [] };
    group.candidates += 1;
    if ((boardsToday.get(row.symbol) ?? 0) > boards) { group.promoted += 1; group.names.push(row.name); }
    groups.set(boards, group);
  }
  return [...groups.values()].sort((a, b) => a.boards - b.boards).map((group) => ({ ...group, ratePct: round(group.promoted / group.candidates * 100, 1) }));
}

const CYCLE_WEIGHTS = ["limitUps", "highestBoard", "brokenRatePct"];
const minmax = (values) => {
  const low = Math.min(...values), high = Math.max(...values);
  return values.map((value) => (high > low ? (value - low) / (high - low) : 0.5));
};

// Emotion score per day over a window: limit-up count and highest board up, broken rate down,
// each scaled within the window; where today sits relative to the window's trough.
export function emotionCycle(days) {
  const usable = days.filter((day) => CYCLE_WEIGHTS.every((key) => finite(day[key]) !== null));
  if (usable.length < 3) return { days: usable, score: null, note: "可用交易日不足 3 天，算不出周期位置。" };
  const [zt, top, broken] = CYCLE_WEIGHTS.map((key) => minmax(usable.map((day) => day[key])));
  const series = usable.map((day, index) => ({ ...day, score: round((zt[index] + top[index] + (1 - broken[index])) / 3, 3) }));
  const trough = series.reduce((low, day) => (day.score < low.score ? day : low), series[0]);
  const peak = Math.max(...series.map((day) => day.score));
  const current = series.at(-1);
  const [a, b, c] = series.slice(-3).map((day) => day.score);
  const trend = c - b > 0.03 && b - a > -0.03 ? "回暖" : c - b < -0.03 && b - a < 0.03 ? "转弱" : "震荡";
  const daysFromTrough = series.length - 1 - series.indexOf(trough);
  return {
    days: series, current: current.score, trough: { date: trough.date, score: trough.score }, daysFromTrough, trend,
    positionPct: peak > trough.score ? round((current.score - trough.score) / (peak - trough.score) * 100, 0) : null,
    note: "分数只在这个窗口内比较（0 = 窗口最冷，1 = 最热），不同窗口之间不可直接比较。",
  };
}

async function lastTradingDates(end, count) {
  const dates = [end];
  while (dates.length < count) { const previous = previousTradingDate(dates.at(-1)); if (!previous) break; dates.push(previous); }
  return dates.reverse();
}

export async function shortlineEmotion({ date, at, lookback = 10, quotesImpl = getJson } = {}) {
  const day = validDate(date) ?? aShareDataDate(at);
  const window = Math.max(3, Math.min(20, Number(lookback) || 10));
  return cached(`emotion:${day}:${window}`, 120000, async () => {
    const dates = await lastTradingDates(day, window);
    const daily = await Promise.all(dates.map(async (entry) => {
      try {
        const [up, broken, down] = await Promise.all([limitPool("up", { date: entry }), limitPool("broken", { date: entry }), limitPool("down", { date: entry })]);
        const sentiment = sentimentFrom(up, broken, down);
        return { date: entry, up, limitUps: sentiment.limitUps, broken: sentiment.broken, limitDowns: sentiment.limitDowns, brokenRatePct: sentiment.brokenRatePct, highestBoard: sentiment.highestBoard };
      } catch (error) { return { date: entry, error: error.message }; }
    }));
    const today = daily.at(-1);
    const yesterday = daily.at(-2);
    const promotion = today?.up && yesterday?.up ? promotionRates(today.up, yesterday.up) : [];
    // Money effect: how yesterday's limit-up stocks trade today. Only the latest session can use live quotes.
    let moneyEffect = null;
    if (yesterday?.up?.rows.length && day === aShareDataDate(at)) {
      try {
        const symbols = yesterday.up.rows.map((row) => row.symbol);
        const payload = await quotesImpl(`${ULIST}?fltt=2&secids=${symbols.flatMap(secidsFor).join(",")}&fields=f12,f3`);
        const changes = (payload?.data?.diff ?? []).map((row) => finite(row.f3)).filter((value) => value !== null);
        const covered = changes.length / symbols.length;
        moneyEffect = covered < 0.5 ? { note: `只取到 ${changes.length}/${symbols.length} 只的行情，不足以代表全体，不给结论。` } : {
          samples: changes.length, of: symbols.length, avgChangePct: round(changes.reduce((sum, value) => sum + value, 0) / changes.length), upRatioPct: round(changes.filter((value) => value > 0).length / changes.length * 100, 1),
          relimitUps: yesterday.up.rows.filter((row) => today.up?.rows.some((entry) => entry.symbol === row.symbol)).length, partial: covered < 0.9,
        };
      } catch (error) { moneyEffect = { note: `行情取不到：${error.message}` }; }
    }
    const cycle = emotionCycle(daily.filter((entry) => !entry.error).map(({ up: _, ...entry }) => entry));
    return { date: day, previousDate: yesterday?.date ?? null, source: `${SOURCE} 涨停板行情`, promotion, moneyEffect, cycle, failedDates: daily.filter((entry) => entry.error).map((entry) => entry.date) };
  });
}
