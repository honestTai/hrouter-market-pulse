// MCP tools for market-wide data: market radar, dragon-tiger list and seats, limit-up pools and
// sentiment, margin, Stock Connect and industry classification. Read-only, public sources.
import { z } from "zod";
import { scanMarket } from "./core.mjs";
import { dragonTiger, dragonTigerSeats, industriesOf, limitPool, limitUpSentiment, marketMargin, marketRadar, shortlineEmotion, stockConnect, stockMargin } from "./market-data.mjs";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Trading date YYYY-MM-DD; default: today once the A-share session opened, else the last session.");
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const yi = (value) => (Number.isFinite(value) ? `${(value / 1e8).toFixed(1)} 亿` : "—");

export function registerMarketDataTools(server, { toolResult, toolError }) {
  const register = (name, config, handler) => server.registerTool(name, { ...config, annotations: readOnly }, async (input) => {
    try {
      const [data, summary] = await handler(input ?? {});
      return toolResult(data, summary);
    } catch (error) {
      return toolError(error);
    }
  });

  register("get_market_radar", {
    title: "Market radar",
    description: "One call for the A-share market mood: index breadth (advancers / decliners), limit-up count, broken-board rate, the consecutive-board ladder and hot industries, top dragon-tiger net buys, margin balance trend, Stock Connect turnover and the strongest sectors and concepts. Use it at the start of a round to judge risk appetite. All public East Money data with dates; missing parts say why.",
    inputSchema: {},
  }, async () => {
    const radar = await marketRadar({ scan: scanMarket });
    const s = radar.sentiment;
    const b = radar.breadth;
    const lines = [
      `数据日 ${radar.date}`,
      b.advancers !== null && b.advancers !== undefined ? `涨 ${b.advancers} / 跌 ${b.decliners} / 平 ${b.unchanged}，两市成交 ${yi(b.turnover)}` : `涨跌家数：${b.error ?? "暂无"}`,
      s.limitUps !== undefined ? `涨停 ${s.limitUps}、炸板 ${s.broken}（炸板率 ${s.brokenRatePct ?? "—"}%）、跌停 ${s.limitDowns}，最高 ${s.highestBoard ?? "—"} 板` : `涨停池：${s.error}`,
      radar.margin.rows?.[0] ? `融资余额 ${yi(radar.margin.rows[0].financingBalance)}（${radar.margin.rows[0].date}，当日净买 ${yi(radar.margin.rows[0].financingNet)}）` : null,
    ].filter(Boolean);
    return [radar, lines.join("\n")];
  });

  register("get_dragon_tiger", {
    title: "Dragon-tiger list (龙虎榜)",
    description: "A-share dragon-tiger list for a trading date: stocks listed for abnormal moves, the listing reason, close, change and the listed seats' net buying. Pass symbol to get that stock's top five buying and selling broker seats (institutions, Stock Connect and well-known hot-money branches show up by name). Published after the close (around 18:00 Beijing).",
    inputSchema: { date, symbol: z.string().max(12).optional().describe("A-share code for its broker seats, e.g. 001696."), limit: z.number().int().min(1).max(200).optional() },
  }, async ({ date: day, symbol, limit }) => {
    if (symbol) {
      const seats = await dragonTigerSeats(symbol, { date: day });
      const top = seats.buyers.slice(0, 3).map((row) => `${row.seat} 净买 ${yi(row.net)}`);
      return [seats, seats.note ?? `${seats.symbol} ${seats.date} 买方前三：${top.join("；")}`];
    }
    const list = await dragonTiger({ date: day, limit });
    return [list, list.note ?? `${list.date} 龙虎榜 ${list.total} 条；净买入前三：${list.rows.slice(0, 3).map((row) => `${row.name} ${yi(row.netBuy)}`).join("、")}`];
  });

  register("get_limit_up_pool", {
    title: "Limit-up pools (涨停池)",
    description: "A-share limit-up pool (kind up: consecutive boards, first / last seal time, seal fund, breaks, industry), broken pool (kind broken: touched limit-up and opened) or limit-down pool (kind down). kind sentiment returns the day's ladder by consecutive boards, broken rate, highest board and hot industries. kind emotion returns promotion rates (一进二, 二进三 …: share of yesterday's n-board stocks that sealed again), money effect (how yesterday's limit-ups trade today) and the emotion cycle over the last trading days (trough, days since, trend). Intraday it reflects the moment you ask.",
    inputSchema: { kind: z.enum(["up", "broken", "down", "sentiment", "emotion"]).default("sentiment"), date, limit: z.number().int().min(1).max(500).optional(), lookback: z.number().int().min(3).max(20).optional().describe("Trading days for the emotion cycle (kind emotion), default 10.") },
  }, async ({ kind = "sentiment", date: day, limit, lookback }) => {
    if (kind === "emotion") {
      const emotion = await shortlineEmotion({ date: day, lookback });
      const promotion = emotion.promotion.map((group) => `${group.boards}进${group.boards + 1} ${group.promoted}/${group.candidates}（${group.ratePct}%）`).join("，");
      const money = emotion.moneyEffect?.avgChangePct !== undefined ? `昨日涨停今日平均 ${emotion.moneyEffect.avgChangePct}%，上涨 ${emotion.moneyEffect.upRatioPct}%，再涨停 ${emotion.moneyEffect.relimitUps} 只` : (emotion.moneyEffect?.note ?? "赚钱效应只对最新交易日计算");
      const cycle = emotion.cycle.current !== undefined ? `情绪分 ${emotion.cycle.current}（窗口最低 ${emotion.cycle.trough.date}，${emotion.cycle.daysFromTrough} 天前），${emotion.cycle.trend}` : emotion.cycle.note;
      return [emotion, `${emotion.date}：晋级 ${promotion || "—"}；${money}；${cycle}`];
    }
    if (kind === "sentiment") {
      const sentiment = await limitUpSentiment({ date: day });
      return [sentiment, `${sentiment.date}：涨停 ${sentiment.limitUps}，炸板 ${sentiment.broken}（${sentiment.brokenRatePct ?? "—"}%），跌停 ${sentiment.limitDowns}，最高 ${sentiment.highestBoard ?? "—"} 板`];
    }
    const pool = await limitPool(kind, { date: day, limit });
    return [pool, pool.note ?? `${pool.date} ${pool.source}：${pool.total} 只`];
  });

  register("get_margin", {
    title: "Margin financing (融资融券)",
    description: "Margin financing and short balances: the whole A-share market (no symbol) or one stock (symbol), newest first. Published the next morning for the previous session.",
    inputSchema: { symbol: z.string().max(12).optional(), days: z.number().int().min(1).max(120).optional() },
  }, async ({ symbol, days }) => {
    const data = symbol ? await stockMargin(symbol, { days }) : await marketMargin({ days });
    const first = data.rows[0];
    return [data, data.note ?? (first ? `${first.date} 融资余额 ${yi(first.financingBalance)}，融资净买 ${yi(first.financingNet)}` : "没有数据")];
  });

  register("get_stock_connect", {
    title: "Stock Connect turnover (沪深港通)",
    description: "Daily Stock Connect turnover: Shanghai / Shenzhen Connect and northbound total (turnover only: the exchanges stopped publishing northbound net buying in August 2024), plus southbound total with net buying.",
    inputSchema: { days: z.number().int().min(1).max(60).optional() },
  }, async ({ days }) => {
    const data = await stockConnect({ days });
    const north = data.rows.find((row) => row.channel === "北向合计");
    const south = data.rows.find((row) => row.channel === "南向合计");
    return [data, `${north?.date ?? "—"} 北向成交 ${yi(north?.turnover)}；南向成交 ${yi(south?.turnover)}，净买 ${yi(south?.netBuy)}。${data.note}`];
  });

  register("get_industry", {
    title: "Industry classification",
    description: "Industry of each symbol (East Money classification for A-shares, sector for HK and US). The arena uses the same data for the per-industry position limit.",
    inputSchema: { symbols: z.array(z.string().min(1).max(20)).min(1).max(100) },
  }, async ({ symbols }) => {
    const industries = await industriesOf(symbols);
    return [{ industries, unknown: symbols.filter((symbol) => !industries[symbol]) }, symbols.map((symbol) => `${symbol} ${industries[symbol] ?? "未知"}`).join("，")];
  });
}
