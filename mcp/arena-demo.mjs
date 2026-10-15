// Synthetic Agent Arena for `--demo`: isolated temp storage, deterministic fake prices.
// Every account is flagged demo so the UI can label it; nothing touches real arena data.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ARENA_MARKETS, createArena, computeFees } from "./arena.mjs";

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const UNIVERSE = {
  A: [["600519.SS", "贵州茅台", 1310], ["300750.SZ", "宁德时代", 268], ["601318.SS", "中国平安", 58.4], ["000858.SZ", "五粮液", 142], ["688981.SS", "中芯国际", 96.5], ["600036.SS", "招商银行", 41.2]],
  US: [["AAPL", "Apple", 343], ["NVDA", "NVIDIA", 182], ["MSFT", "Microsoft", 512], ["TSLA", "Tesla", 268], ["AMZN", "Amazon", 231]],
};
const AGENTS = [
  { market: "A", name: "Opus 动量轮动", label: "Claude Code", client: "claude-code", model: "claude-opus-5-5", drift: 0.0019, vol: 0.011, strategy: "沪深300成分股，20 日动量前 3 名等权持有，跌破 MA20 离场，单票不超过 30%。" },
  { market: "A", name: "Codex 价值防守", label: "Codex", client: "codex-mcp-client", model: "gpt-5.5-codex", drift: 0.0009, vol: 0.006, strategy: "低估值高股息蓝筹，PE 分位 < 30% 建仓，分 3 批买入，最大回撤 8% 降仓一半。" },
  { market: "A", name: "WorkBuddy 事件驱动", label: "WorkBuddy", client: "workbuddy", model: "hunyuan-t1", drift: 0.0004, vol: 0.014, strategy: "跟踪业绩预告与公告，超预期次日开盘买入，持有 5 个交易日或止损 5%。" },
  { market: "A", name: "Sonnet 均值回归", label: "Claude Code", client: "claude-code", model: "claude-sonnet-5-5", drift: -0.0006, vol: 0.009, strategy: "RSI(14) < 30 且站上 MA60 的标的抄底，RSI > 60 止盈，单次仓位 20%。" },
  { market: "US", name: "Opus Mega-cap trend", label: "Claude Code", client: "claude-code", model: "claude-opus-5-5", drift: 0.0012, vol: 0.012, strategy: "Hold the 3 strongest mega caps by 50-day return, rebalance weekly, exit below the 50-day MA." },
  { market: "US", name: "Codex Earnings drift", label: "Codex", client: "codex-mcp-client", model: "gpt-5.5-codex", drift: 0.0007, vol: 0.010, strategy: "Buy post-earnings beats with positive guidance, hold 10 sessions, 6% stop." },
];

function seedAccount(agent, index, start) {
  const random = generator(9001 + index * 97);
  const config = ARENA_MARKETS[agent.market];
  const universe = UNIVERSE[agent.market];
  const days = 34;
  const equity = [];
  let value = config.defaultCash;
  for (let day = 0; day <= days; day += 1) {
    const shock = (random() - 0.5) * 2 * agent.vol * 1.7;
    if (day > 0) value *= 1 + agent.drift + shock;
    const at = new Date(start + day * 86400000 + 7 * 3600000).toISOString();
    equity.push({ at, equity: Math.round(value * 100) / 100, cash: 0, marketValue: 0 });
  }
  const trades = [];
  const orders = [];
  const journal = [];
  for (let n = 0; n < 9 + Math.floor(random() * 10); n += 1) {
    const [symbol, name, base] = universe[Math.floor(random() * universe.length)];
    const day = Math.floor(random() * days);
    const at = new Date(start + day * 86400000 + 2 * 3600000 + n * 60000).toISOString();
    const price = Math.round(base * (0.92 + random() * 0.14) * 100) / 100;
    const lot = agent.market === "A" ? 100 : 1;
    const quantity = Math.max(lot, Math.floor(config.defaultCash * (0.05 + random() * 0.12) / price / lot) * lot);
    const side = random() > 0.45 ? "SELL" : "BUY";
    const fees = computeFees(agent.market, side, quantity, price);
    const realizedPnl = side === "SELL" ? Math.round((random() - 0.42 + agent.drift * 60) * quantity * price * 0.08) : null;
    const id = `ord_demo${String(index).padStart(2, "0")}${String(n).padStart(4, "0")}`;
    const reason = side === "BUY"
      ? (agent.market === "A" ? `${name} 放量突破 20 日高点，动量排名前列，按计划建仓。` : `${name} broke out above its 20-day high on rising volume; sizing per plan.`)
      : (agent.market === "A" ? `${name} 触发止盈/止损条件，按纪律减仓。` : `${name} hit the exit rule; trimming per plan.`);
    orders.push({ id, clientOrderId: null, symbol, name, side, type: "market", quantity, limitPrice: null, timeInForce: "day", status: "filled", reserved: 0, reason, confidence: Math.round((0.45 + random() * 0.4) * 100) / 100, strategyVersion: 1, createdAt: at, expiresAt: at, filledAt: at, fillPrice: price, fees: fees.total, placedBy: agent.client });
    trades.push({ id: `trd_demo${String(index).padStart(2, "0")}${String(n).padStart(4, "0")}`, orderId: id, symbol, name, side, quantity, price, gross: Math.round(quantity * price * 100) / 100, fees: fees.total, feeBreakdown: fees.breakdown, realizedPnl, at, reason, confidence: null, strategyVersion: 1 });
  }
  orders.push({ id: `ord_demo${String(index).padStart(2, "0")}rej1`, symbol: universe[0][0], name: universe[0][1], side: "BUY", type: "market", quantity: agent.market === "A" ? 50 : 10, status: "rejected", rejectReason: agent.market === "A" ? "Buy quantity must be a multiple of the board lot (100)." : "Market is closed now. Market orders need an open session.", reason: "Demo rejection example", strategyVersion: 1, createdAt: equity[12].at, expiresAt: equity[12].at, reserved: 0 });
  trades.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  orders.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (let n = 0; n < 4; n += 1) {
    journal.push({ id: `dec_demo${index}${n}`, at: equity[5 + n * 7].at, kind: n % 2 ? "no-trade" : "analysis", summary: agent.market === "A"
      ? (n % 2 ? "大盘缩量震荡，候选标的未满足入场条件，本轮不交易。" : "复盘持仓：动量仍在，维持仓位；关注下周宏观数据。")
      : (n % 2 ? "No setup met the entry rules today; staying flat." : "Reviewed holdings: trend intact, keep exposure."), symbols: [universe[n % universe.length][0]], details: null, strategyVersion: 1 });
  }
  const reports = [0, 1, 2].map((n) => {
    const point = equity[equity.length - 1 - n * 5];
    const cn = agent.market === "A";
    return {
      id: `rpt_demo${index}${n}`, at: point.at, strategyVersion: 1,
      title: cn ? ["维持进攻仓位，新能源龙头继续领涨", "大盘缩量震荡，本轮不交易", "止盈部分白酒，转入金融防守"][n] : ["Trend intact, staying long mega caps", "No setup today; flat", "Trimmed winners into strength"][n],
      summary: cn ? `${agent.name}：动量信号仍然有效，持仓集中在 2–3 只龙头，现金保留约三成以应对回撤。本轮${n === 1 ? "没有满足入场条件的标的" : "按纪律调整了仓位"}，组合累计收益 ${((point.equity / config.defaultCash - 1) * 100).toFixed(2)}%。` : `${agent.name}: momentum still positive; ${n === 1 ? "no candidate met the entry rules" : "rebalanced per plan"}. Total return ${((point.equity / config.defaultCash - 1) * 100).toFixed(2)}%.`,
      sentiment: ["bullish", "neutral", "defensive"][n],
      marketView: cn ? "指数在 20 日均线附近震荡，成交额回落，风格偏向大盘蓝筹。" : "Index holding its 50-day average; breadth narrowing.",
      actions: n === 1 ? [] : [{ symbol: universe[1][0], action: n ? "sell" : "buy", detail: cn ? "按信号调整" : "per signal" }],
      picks: universe.slice(0, 3).map(([symbol, name]) => ({ symbol, thesis: cn ? `${name}：趋势向上，回撤可控` : `${name}: uptrend, contained drawdowns` })),
      risks: cn ? "若沪深300 跌破 60 日均线，降仓至五成以下。" : "Cut exposure below 50% if the index loses its 100-day average.",
      nextSteps: cn ? "下一交易日开盘后复核量能，触发条件再加仓。" : "Recheck volume after the next open.",
      snapshot: { equity: point.equity, cash: 0, positions: 2, returnPct: Math.round((point.equity / config.defaultCash - 1) * 10000) / 100 },
    };
  }).reverse();
  const finalEquity = equity.at(-1).equity;
  const positions = {};
  let marketValue = 0;
  for (const [symbol, name, base] of universe.slice(0, 2 + (index % 2))) {
    const lot = agent.market === "A" ? 100 : 1;
    const price = Math.round(base * (0.97 + random() * 0.06) * 100) / 100;
    const quantity = Math.floor(finalEquity * 0.22 / price / lot) * lot;
    const cost = Math.round(quantity * price * (0.93 + random() * 0.1) * 100) / 100;
    positions[symbol] = { symbol, name, quantity, costBasis: cost, realizedPnl: 0, lots: [{ date: "2026-01-01", quantity }], openedAt: equity[3].at, lastPrice: price, lastPriceAt: equity.at(-1).at,
      ...(index % 2 === 0 ? { exits: { stopLoss: { pct: 8 }, takeProfit: { pct: 25 } } } : {}) };
    marketValue += quantity * price;
  }
  for (const point of equity) Object.assign(point, { marketValue: Math.round(marketValue * 100) / 100, cash: Math.round((point.equity - marketValue) * 100) / 100 });
  const createdAt = new Date(start - 3600000).toISOString();
  return {
    schemaVersion: 1, demo: true, id: `acc_${(0xdeadbeef0000 + index).toString(16).slice(-12)}`, name: agent.name, competition: "default", market: agent.market, currency: config.currency, status: "active",
    agent: { client: agent.client, clientVersion: "demo", label: agent.label }, model: agent.model,
    strategy: { version: index === 0 ? 2 : 1, summary: agent.strategy, updatedAt: createdAt, history: [{ version: 1, summary: agent.strategy, note: "initial", at: createdAt }, ...(index === 0 ? [{ version: 2, summary: agent.strategy, note: "收紧止损：MA20 → MA10", at: equity[20].at }] : [])] },
    initialCash: config.defaultCash, cash: Math.round((finalEquity - marketValue) * 100) / 100,
    realizedPnl: trades.reduce((sum, trade) => sum + (trade.realizedPnl ?? 0), 0),
    settings: { slippageBps: 5, maxQuoteAgeSeconds: 180, feeModel: `${agent.market}-retail-v1` },
    benchmark: { symbol: config.benchmark, name: config.benchmarkName, startPrice: 100, startAt: createdAt, lastPrice: agent.market === "A" ? 103.1 : 102.4, lastPriceAt: equity.at(-1).at },
    positions, orders, trades, journal, equity, reports, createdAt,
    watchlist: { symbols: universe.map(([symbol]) => symbol), reason: "demo", updatedAt: equity.at(-1).at }, updatedAt: equity.at(-1).at, createdBy: agent.client,
    // The event-driven agent "stopped running" three days ago so the missed-run warning is visible.
    lastRoundAt: agent.client === "workbuddy" ? equity.at(-4).at : reports.at(-1).at, lastRoundKind: "report",
    riskPolicy: { maxPositionPct: 35, maxExposurePct: 90, maxDrawdownPct: 15, onBreach: "block", reduceToExposurePct: 50 },
    events: index === 0 ? [
      { id: "evt_demo0001", at: equity.at(-6).at, type: "dividend", symbol: universe[0][0], amount: 1850, message: `${universe[0][0]} 派息到账 +1850 ${config.currency}` },
      { id: "evt_demo0002", at: equity.at(-2).at, type: "stop-loss", symbol: universe[2][0], level: 55.1, price: 55.02, message: `止损 ${universe[2][0]}：现价 55.02 跌破 55.1，市价卖出` },
    ] : [],
  };
}

export async function createDemoArena() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hrouter-arena-demo-"));
  await mkdir(path.join(root, "accounts"), { recursive: true });
  // Last seeded point lands about an hour ago, never in the future.
  const start = Date.now() - 34 * 86400000 - 8 * 3600000;
  const accounts = AGENTS.map((agent, index) => seedAccount(agent, index, start));
  const prices = new Map(accounts.flatMap((account) => Object.values(account.positions).map((position) => [position.symbol, position])));
  for (const account of accounts) await writeFile(path.join(root, "accounts", `${account.id}.json`), JSON.stringify(account));
  const arena = createArena({
    root,
    // Synthetic quotes: hold the seeded marks so the demo stays stable while it is open.
    quoteProvider: async (symbol) => {
      const position = prices.get(symbol);
      const market = /\.(SS|SZ)$/.test(symbol) ? "A" : /\.HK$/.test(symbol) ? "HK" : "US";
      const base = position?.lastPrice ?? ({ "000300.SS": 103.1, "^GSPC": 102.4, "^HSI": 101.2 }[symbol] ?? 50);
      return { symbol, name: position?.name ?? symbol, market, price: base, asOf: new Date().toISOString(), provider: "Synthetic demo", lotSize: market === "HK" ? 100 : null, limitUp: null, limitDown: null };
    },
  });
  await arena.generateDigest({ market: "A", trigger: "demo" });
  return arena;
}
