import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { marketFromSymbol, normalizeSymbol, parseEastmoneyList, parseEastmoneySearch, parseTencentMinutes } from "../mcp/core.mjs";
import { getInstrumentRules } from "../mcp/market-rules.mjs";
import { createArena, lotRules } from "../mcp/arena.mjs";
import { createPaperBroker } from "../mcp/brokers.mjs";
import { agentInvocation } from "../mcp/scheduler.mjs";
import { ordersFromTargets, runStrategyRound } from "../mcp/strategies/index.mjs";
import intraday from "../mcp/strategies/intraday-momentum.mjs";
import { roundPrompt } from "../mcp/prompts.mjs";

// Thursday 2026-10-15, 10:30 Asia/Shanghai.
const OPEN_A = "2026-10-15T02:30:00.000Z";

test("Beijing Stock Exchange symbols are A-shares with 30% limits and 1-share steps after 100", () => {
  assert.equal(normalizeSymbol("920690"), "920690.BJ");
  assert.equal(normalizeSymbol("830799"), "830799.BJ");
  assert.equal(normalizeSymbol("600519"), "600519.SS");
  assert.equal(normalizeSymbol("900901"), "900901.SS", "Shanghai B-shares stay on SSE");
  assert.equal(marketFromSymbol("920690.BJ"), "A");
  const rules = getInstrumentRules("920690.BJ");
  assert.deepEqual([rules.board, rules.priceLimitPct, rules.minimumOrderUnits, rules.orderIncrement], ["BSE", 30, 100, 1]);
  assert.deepEqual(lotRules({ market: "A" }, "920690.BJ"), { lotSize: 1, minimumBuy: 100, tPlusOne: true, source: "exchange rule" });
  assert.deepEqual(lotRules({ market: "A" }, "688981.SS").minimumBuy, 200);
});

test("whole-market scan rows carry board, ST flag and exchange-correct symbols", () => {
  const payload = { data: { total: 3, diff: [
    { f2: 19.24, f3: 30, f6: 1.6e8, f8: 15.2, f10: 10.8, f12: "920690", f13: 0, f14: "捷众科技", f22: 0.5, f62: 1e7, f100: "汽车零部件" },
    { f2: 3.1, f3: 5, f6: 5e7, f12: "600234", f13: 1, f14: "*ST科新", f100: "-" },
    { f2: 120, f3: 8.2, f6: 2e9, f12: "688981", f13: 1, f14: "中芯国际" },
    { f2: "-", f3: "-", f12: "000001", f13: 0, f14: "停牌股" },
  ] } };
  const rows = parseEastmoneyList(payload, { market: "A" });
  assert.deepEqual(rows.map((row) => [row.symbol, row.board, row.st]), [["920690.BJ", "bse", false], ["600234.SS", "main", true], ["688981.SS", "star", false]]);
  assert.equal(rows[0].industry, "汽车零部件");
  assert.equal(rows[1].industry, null);
  assert.equal(rows[0].volumeRatio, 10.8);
  const hk = parseEastmoneyList({ data: { diff: [{ f2: 417, f12: "00700", f13: 128, f14: "腾讯控股" }] } }, { market: "HK" });
  assert.equal(hk[0].symbol, "0700.HK");
  const us = parseEastmoneyList({ data: { diff: [{ f2: 50, f12: "BRK_B", f13: 106, f14: "伯克希尔" }] } }, { market: "US" });
  assert.equal(us[0].symbol, "BRK-B");
});

test("East Money keyword news search and Tencent minute bars parse", () => {
  const news = parseEastmoneySearch('cb({"result":{"cmsArticleWebOld":[{"date":"2026-10-14 20:47:00","title":"海康威视<em>发布</em>新品","mediaName":"证券日报","url":"http://x/a.html","content":"摘要"}]}})', 5);
  assert.deepEqual(news[0], { title: "海康威视发布新品", publisher: "证券日报 / 东方财富", publishedAt: "2026-10-14T12:47:00.000Z", url: "http://x/a.html", summary: "摘要" });
  const bars = parseTencentMinutes({ data: { sz300750: { data: { date: "20261015", data: ["0930 281.79 4080 114970320.00", "0931 278.54 14381 403514361.85"] } } } }, "sz300750", "A");
  assert.equal(bars.length, 2);
  assert.deepEqual([bars[0].time, bars[0].date, bars[0].volume, bars[1].volume], ["09:30", "2026-10-15", 408000, 1030100]);
  assert.ok(Math.abs(bars[1].vwap - 403514361.85 / 1438100) < 1e-9);
});

test("target weights never sell T+1-locked A-share shares", () => {
  const quotes = new Map([["600519.SS", { price: 1300 }], ["300750.SZ", { price: 260 }]]);
  const account = { market: "A", metrics: { equity: 1000000 }, lotOverrides: {}, positions: [
    { symbol: "600519.SS", quantity: 300, lots: [{ date: "2026-10-15", quantity: 300 }] },
    { symbol: "300750.SZ", quantity: 1000, lots: [{ date: "2026-10-14", quantity: 600 }, { date: "2026-10-15", quantity: 400 }] },
  ] };
  const orders = ordersFromTargets(account, [], quotes, { now: OPEN_A });
  assert.deepEqual(orders.map((order) => [order.side, order.symbol, order.quantity]), [["SELL", "300750.SZ", 600]]);
});

test("intraday momentum buys strength above VWAP from the scan and exits weak sellable holdings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "intraday-"));
  const prices = { "300001.SZ": 20, "600002.SS": 10, "000003.SZ": 30, "601004.SS": 8 };
  const arena = createArena({ root, now: () => OPEN_A, quoteCacheMs: 0, quoteProvider: async (symbol) => ({ symbol, name: symbol, price: prices[symbol], asOf: OPEN_A, provider: "test", volumeShares: 1e9 }) });
  try {
    const account = await arena.createAccount({ name: "Intraday", model: "strategy:intraday-momentum", market: "A" }, { client: "dashboard" });
    const broker = createPaperBroker({ arena, accountId: account.id, caller: { client: "strategy-intraday-momentum" } });
    const rising = (from, to) => Array.from({ length: 30 }, (_, index) => ({ time: `09:${String(30 + index).padStart(2, "0")}`, price: from + (to - from) * index / 29, vwap: from + (to - from) * 0.4 }));
    const intradayBars = { "300001.SZ": rising(19, 20), "600002.SS": rising(10.5, 10), "000003.SZ": rising(29, 30) };
    const scan = { rows: [
      { symbol: "300001.SZ", name: "强势A", changePct: 4, volumeRatio: 2, amount: 9e8 },
      { symbol: "600002.SS", name: "弱势B", changePct: 3, volumeRatio: 2, amount: 9e8 },
      { symbol: "000003.SZ", name: "涨停C", changePct: 9.9, volumeRatio: 3, amount: 9e8 },
    ] };
    const round = await runStrategyRound({
      strategy: intraday, params: { top: 2, exposure: 0.8 }, broker, runId: "run_intraday1", now: () => OPEN_A,
      quoteProvider: async (symbol) => ({ price: prices[symbol] }),
      intradayProvider: async (symbol) => ({ bars: intradayBars[symbol] ?? [] }),
      scanProvider: async () => scan,
    });
    assert.deepEqual(round.orders.map((order) => [order.side, order.symbol, order.status]), [["BUY", "300001.SZ", "filled"]], "only the name above VWAP and below the limit-up band is bought");
    const detail = await arena.getAccount(account.id, { sync: false });
    assert.ok(detail.positions[0].exitLevels.stopLoss > 0, "stop-loss attached");
    // Same day: the holding drops below VWAP, but T+1 keeps it; no rejected sell is sent.
    intradayBars["300001.SZ"] = rising(20, 18);
    const locked = await runStrategyRound({ strategy: intraday, params: { top: 2, exposure: 0.8 }, broker, runId: "run_intraday2", now: () => OPEN_A, quoteProvider: async (symbol) => ({ price: prices[symbol] }), intradayProvider: async (symbol) => ({ bars: intradayBars[symbol] ?? [] }), scanProvider: async () => ({ rows: [] }) });
    assert.equal(locked.orders.filter((order) => order.side === "SELL").length, 0);
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("headless agents may search the web unless a job turns it off; prompts cover the whole market", () => {
  const base = { account: { id: "acc_000000000001" }, prompt: "go", nodePath: "/n", bundlePath: "/b.mjs", skillText: null, workDir: "/w", identity: "x", dataDir: "/d" };
  const codex = agentInvocation({ ...base, job: { runner: { type: "codex", timeoutMinutes: 5 } } });
  assert.ok(codex.args.includes('web_search="live"'));
  const off = agentInvocation({ ...base, job: { runner: { type: "codex", timeoutMinutes: 5, webSearch: false } } });
  assert.ok(off.args.includes('web_search="disabled"'));
  const claude = agentInvocation({ ...base, job: { runner: { type: "claude", timeoutMinutes: 5, webSearch: false } } });
  assert.equal(claude.args[claude.args.indexOf("--allowedTools") + 1], "mcp__hrouter_market_pulse");
  const zh = roundPrompt({ account: { id: "acc_1", market: "A" }, language: "zh-CN" });
  assert.match(zh, /scan_market/);
  assert.match(zh, /科创板/);
  assert.match(zh, /联网搜索/);
  assert.doesNotMatch(roundPrompt({ account: { id: "acc_1", market: "US" }, language: "en" }), /STAR/);
});
