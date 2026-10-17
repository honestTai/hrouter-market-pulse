import test from "node:test";
import assert from "node:assert/strict";
import { filterRelevantNews, newsKeys } from "../mcp/core.mjs";
import {
  aShareDataDate, industriesOf, parseBreadth, parseConnect, parseDragonTiger, parseIndustries, parseMarketMargin, parsePool, parseSeats, sentimentFrom, symbolFromCode,
} from "../mcp/market-data.mjs";

test("news for one security keeps only items that name it; theme searches are not filtered", () => {
  assert.deepEqual(newsKeys({ symbol: "300750.SZ", name: "宁德时代" }), ["300750", "宁德时代"]);
  assert.deepEqual(newsKeys({ symbol: "0700.HK", name: "腾讯控股" }), ["0700", "00700", "腾讯控股", "腾讯"]);
  assert.deepEqual(newsKeys({ symbol: "AAPL", name: "Apple Inc." }), ["AAPL", "Apple Inc.", "Apple"]);
  const items = [
    { title: "宁德时代发布新电池", summary: "" },
    { title: "锂电板块午后走强", summary: "多只个股上涨，300750 成交放大" },
    { title: "白酒股集体回调", summary: "茅台、五粮液下跌" },
    { title: "公司公告", tagged: true },
  ];
  const kept = filterRelevantNews(items, newsKeys({ symbol: "300750.SZ", name: "宁德时代" }));
  assert.deepEqual(kept.items.map((item) => item.title), ["宁德时代发布新电池", "锂电板块午后走强", "公司公告"]);
  assert.equal(kept.dropped, 1);
  assert.equal(filterRelevantNews(items, []).items.length, 4, "no keys: theme search");
});

test("A-share data date is today once the session opened, else the previous session", () => {
  assert.equal(aShareDataDate("2026-10-16T03:00:00Z"), "2026-10-16"); // Friday 11:00 Beijing
  assert.equal(aShareDataDate("2026-10-17T03:00:00Z"), "2026-10-16"); // Saturday
  assert.equal(aShareDataDate("2026-10-19T00:30:00Z"), "2026-10-16"); // Monday 08:30, before the open
  assert.equal(symbolFromCode("600519"), "600519.SS");
  assert.equal(symbolFromCode("920162"), "920162.BJ");
  assert.equal(symbolFromCode("700", "HK"), "0700.HK");
});

test("industries come from the quote list and unknown symbols are left out", async () => {
  const payload = { data: { diff: [{ f12: "300750", f14: "宁德时代", f100: "电池" }, { f12: "00700", f14: "腾讯控股", f100: "软件服务" }, { f12: "AAPL", f100: "信息技术" }, { f12: "BRK_B", f100: "金融" }, { f12: "000001", f100: "-" }] } };
  assert.deepEqual(parseIndustries(payload, ["300750.SZ", "0700.HK", "AAPL", "BRK-B", "000001.SZ", "999999.SS"]), { "300750.SZ": "电池", "0700.HK": "软件服务", AAPL: "信息技术", "BRK-B": "金融" });
  let calls = 0;
  const fetchImpl = async (url) => { calls += 1; assert.match(url, /secids=0\.300751/); return { data: { diff: [{ f12: "300751", f100: "电池" }] } }; };
  assert.deepEqual(await industriesOf(["300751.SZ"], { fetchImpl }), { "300751.SZ": "电池" });
  assert.deepEqual(await industriesOf(["300751.SZ"], { fetchImpl }), { "300751.SZ": "电池" });
  assert.equal(calls, 1, "cached for a day");
});

test("dragon-tiger rows and seats keep amounts, reasons and seat types", () => {
  const [row] = parseDragonTiger({ result: { data: [{ SECURITY_CODE: "001696", SECURITY_NAME_ABBR: "宗申动力", TRADE_DATE: "2026-10-16 00:00:00", EXPLANATION: "日涨幅偏离值达到7%", CLOSE_PRICE: 15.87, CHANGE_RATE: 9.9792, BILLBOARD_NET_AMT: 154858711.81, BILLBOARD_BUY_AMT: 198458358.2, BILLBOARD_SELL_AMT: 43599646.4, DEAL_AMOUNT_RATIO: 22.4 }] } });
  assert.deepEqual(row, { symbol: "001696.SZ", name: "宗申动力", date: "2026-10-16", reason: "日涨幅偏离值达到7%", close: 15.87, changePct: 9.98, netBuy: 154858712, buy: 198458358, sell: 43599646, shareOfTurnoverPct: 22.4 });
  const seats = parseSeats({ result: { data: [{ OPERATEDEPT_NAME: "机构专用", BUY: 1e7, SELL: 0, NET: 1e7 }, { OPERATEDEPT_NAME: "深股通专用", BUY: 5e6, SELL: 1e6, NET: 4e6 }] } }, "buy");
  assert.deepEqual(seats.map((seat) => [seat.institution, seat.connect]), [[true, false], [false, true]]);
});

test("limit pools parse prices in thousandths and build the board ladder", () => {
  const up = parsePool({ data: { tc: 3, qdate: 20261016, pool: [
    { c: "000573", n: "粤宏远Ａ", p: 4470, zdp: 10.09, amount: 35396531, ltsz: 2.8e9, hs: 1.25, lbc: 1, fbt: 92500, lbt: 92500, fund: 158637171, zbc: 0, hybk: "房地产开", zttj: { days: 3, ct: 2 } },
    { c: "600825", n: "新华传媒", p: 7100, zdp: 10.01, lbc: 4, fbt: 93102, lbt: 93102, fund: 1e8, zbc: 1, hybk: "出版" },
    { c: "002889", n: "东方嘉盛", p: 14310, zdp: 9.99, lbc: 1, fbt: 101500, lbt: 140010, fund: 2e7, zbc: 2, hybk: "物流" },
  ] } }, "up");
  assert.equal(up.date, "2026-10-16");
  assert.equal(up.rows[0].price, 4.47);
  assert.equal(up.rows[0].firstSealAt, "09:25:00");
  assert.deepEqual(up.rows[0].streak, { days: 3, limitUps: 2 });
  const broken = parsePool({ data: { tc: 1, qdate: 20261016, pool: [{ c: "002815", n: "崇达技术", p: 23470, ztp: 25580, zbc: 3, fbt: 92500, zf: 10.5 }] } }, "broken");
  assert.equal(broken.rows[0].limitUpPrice, 25.58);
  const down = parsePool({ data: { tc: 0, qdate: 20261016, pool: [] } }, "down");
  const sentiment = sentimentFrom(up, broken, down);
  assert.equal(sentiment.brokenRatePct, 25);
  assert.equal(sentiment.highestBoard, 4);
  assert.deepEqual(sentiment.ladder.map((step) => [step.boards, step.count]), [[4, 1], [1, 2]]);
});

test("margin, Stock Connect and breadth keep source units and leave unpublished fields empty", () => {
  const [margin] = parseMarketMargin({ result: { data: [{ DIM_DATE: "2026-10-15 00:00:00", RZYE: 2474195587769, RZMRE: 124282324291, RZJME: -31349854886, RQYE: 28996128605, RZYEZB: 2.685 }] } });
  assert.equal(margin.financingNet, -31349854886);
  const connect = parseConnect({ result: { data: [{ MUTUAL_TYPE: "005", TRADE_DATE: "2026-10-16 00:00:00", DEAL_AMT: 225272.7, NET_DEAL_AMT: null }, { MUTUAL_TYPE: "006", TRADE_DATE: "2026-10-16 00:00:00", DEAL_AMT: 65402.11, NET_DEAL_AMT: -3568.43 }] } });
  assert.deepEqual(connect.map((row) => [row.channel, row.turnover, row.netBuy]), [["北向合计", 225272700000, null], ["南向合计", 65402110000, -3568430000]]);
  const breadth = parseBreadth({ data: { diff: [{ f12: "000001", f14: "上证指数", f2: 3716.28, f3: 0.24, f6: 7.3e11, f104: 1398, f105: 902, f106: 57 }, { f12: "399001", f14: "深证成指", f2: 11802.46, f3: -0.12, f6: 8.2e11, f104: 1713, f105: 1136, f106: 87 }, { f12: "399006", f14: "创业板指", f104: 758, f105: 621, f106: 30 }] } });
  assert.deepEqual([breadth.advancers, breadth.decliners, breadth.unchanged], [3111, 2038, 144], "Shanghai + Shenzhen, ChiNext not double counted");
});

test("promotion rates follow yesterday's board counts and the emotion cycle scales within its window", async () => {
  const { promotionRates, emotionCycle, previousTradingDate } = await import("../mcp/market-data.mjs");
  const yesterday = { rows: [{ symbol: "A", name: "A", boards: 1 }, { symbol: "B", name: "B", boards: 1 }, { symbol: "C", name: "C", boards: 2 }] };
  const today = { rows: [{ symbol: "A", boards: 2 }, { symbol: "C", boards: 1 }, { symbol: "D", boards: 1 }] };
  assert.deepEqual(promotionRates(today, yesterday).map((group) => [group.boards, group.candidates, group.promoted, group.ratePct]), [[1, 2, 1, 50], [2, 1, 0, 0]], "C re-sealed as a first board is not a promotion");
  const cycle = emotionCycle([
    { date: "d1", limitUps: 60, highestBoard: 8, brokenRatePct: 15 },
    { date: "d2", limitUps: 30, highestBoard: 3, brokenRatePct: 45 },
    { date: "d3", limitUps: 40, highestBoard: 4, brokenRatePct: 30 },
    { date: "d4", limitUps: 55, highestBoard: 6, brokenRatePct: 20 },
  ]);
  assert.equal(cycle.trough.date, "d2");
  assert.equal(cycle.daysFromTrough, 2);
  assert.equal(cycle.trend, "回暖");
  assert.equal(emotionCycle([{ date: "d1", limitUps: 1, highestBoard: 1, brokenRatePct: 1 }]).score, null);
  assert.equal(previousTradingDate("2026-10-08"), "2026-09-30", "National Day holiday skipped");
});

test("radar boards: drop duplicate industry levels and one-stock boards", async () => {
  const { boardsWorthShowing } = await import("../mcp/market-data.mjs");
  const rows = [
    { name: "燃料电池", changePct: 6.5, amount: 1, advancers: 1, decliners: 0 },
    { name: "航空装备Ⅲ", changePct: 5.9, amount: 2, advancers: 48, decliners: 1 },
    { name: "航空装备Ⅱ", changePct: 5.9, amount: 2, advancers: 48, decliners: 1 },
    { name: "国防军工", changePct: 4.4, amount: 3, advancers: 90, decliners: 10 },
  ];
  assert.deepEqual(boardsWorthShowing({ rows }).rows.map((row) => row.name), ["航空装备Ⅲ", "国防军工"]);
});
