// Example only — not investment advice. Intraday momentum on a whole-market universe:
// each round scans the most active names, buys strength that holds above the day's VWAP and exits
// when price loses VWAP or gives back too much from the high. T+1 aware: A-share shares bought today
// are held until they unlock; new entries stop late in the session to limit overnight risk.
const minuteOf = (time) => { const [h, m] = String(time).split(":").map(Number); return h * 60 + m; };

export default {
  id: "intraday-momentum",
  name: "日内动量 Intraday Momentum",
  version: "1.0.0",
  markets: ["A", "HK", "US"],
  description: "每轮扫描全市场成交最活跃的股票（可含创业板、科创板、北交所、ST），挑选站稳当日均价线（VWAP）、近 N 分钟继续上攻、量比放大的强势股等权持有；跌破 VWAP 或从日内高点回撤过大时卖出（A 股遵守 T+1）。适合每 1–5 分钟运行。示例策略，不构成投资建议。",
  params: {
    top: { type: "integer", default: 4, min: 1, max: 10, label: "最多持有数量" },
    exposure: { type: "number", default: 0.9, min: 0.1, max: 1, label: "目标总仓位（0–1）" },
    scanSort: { type: "enum", options: ["amount", "speed", "change", "volumeRatio", "mainInflow"], default: "amount", label: "扫描排序" },
    scanLimit: { type: "integer", default: 60, min: 10, max: 100, label: "扫描数量" },
    boards: { type: "enum", options: ["main", "chinext", "star", "bse"], default: ["main", "chinext", "star", "bse"], label: "板块（A 股）" },
    includeST: { type: "boolean", default: false, label: "包含 ST" },
    minAmount: { type: "number", default: 300000000, min: 0, max: 1e11, label: "最低成交额" },
    minChangePct: { type: "number", default: 2, min: -10, max: 20, label: "最低涨幅 %" },
    maxChangePct: { type: "number", default: 8, min: 0, max: 30, label: "最高涨幅 %（避开涨停附近）" },
    momentumMinutes: { type: "integer", default: 15, min: 3, max: 60, label: "短期动量窗口（分钟）" },
    minVolumeRatio: { type: "number", default: 1.2, min: 0, max: 20, label: "最低量比" },
    exitBelowVwapPct: { type: "number", default: 0.5, min: 0, max: 5, label: "跌破 VWAP 多少 % 卖出" },
    maxGivebackPct: { type: "number", default: 4, min: 0.5, max: 20, label: "距日内高点回撤 % 卖出" },
    noEntryAfter: { type: "string", default: "14:30", label: "此时间后不再开新仓（当地时间）" },
    stopLossPct: { type: "number", default: 5, min: 0.5, max: 30, label: "止损 %" },
    takeProfitPct: { type: "number", default: 12, min: 1, max: 100, label: "止盈 %" },
  },
  async run(ctx) {
    const p = ctx.params;
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: { A: "Asia/Shanghai", HK: "Asia/Hong_Kong", US: "America/New_York" }[ctx.market], hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ctx.now));
    const entriesOpen = minuteOf(local) < minuteOf(p.noEntryAfter || "23:59");
    const held = new Map(ctx.account.positions.map((position) => [position.symbol, position]));
    const equity = ctx.account.metrics.equity;

    // 1. Exit check for every holding.
    const keep = [];
    for (const [symbol, position] of held) {
      const weight = position.marketValue / equity;
      let reason = null;
      try {
        const bars = await ctx.intraday(symbol);
        const last = bars.at(-1);
        if (last) {
          const high = Math.max(...bars.map((bar) => bar.price));
          if (last.price < last.vwap * (1 - p.exitBelowVwapPct / 100)) reason = `跌破当日均价线 ${last.vwap.toFixed(2)}（现价 ${last.price}）`;
          else if (high > 0 && (high - last.price) / high * 100 > p.maxGivebackPct) reason = `距日内高点 ${high} 回撤 ${((high - last.price) / high * 100).toFixed(1)}%`;
        }
      } catch (error) { ctx.log(`${symbol} intraday: ${error.message}`); }
      if (reason && ctx.sellable(symbol) > 0) ctx.log(`exit ${symbol}: ${reason}`);
      else keep.push({ symbol, weight, reason: reason ? `${reason}，但 T+1 今日不可卖，继续持有` : `继续持有：仍在均价线上方` });
    }

    // 2. New entries from the whole-market scan.
    const picks = [];
    if (entriesOpen && keep.length < p.top) {
      let rows = [];
      try {
        const scan = await ctx.scan({ sort: p.scanSort, limit: p.scanLimit, boards: Array.isArray(p.boards) ? p.boards : [p.boards], includeST: p.includeST, minAmount: p.minAmount });
        rows = scan.rows;
      } catch (error) { ctx.log(`scan: ${error.message}`); }
      const candidates = rows
        .filter((row) => !held.has(row.symbol))
        .filter((row) => row.changePct >= p.minChangePct && row.changePct <= p.maxChangePct)
        .filter((row) => row.volumeRatio === null || row.volumeRatio >= p.minVolumeRatio);
      for (const row of candidates) {
        if (keep.length + picks.length >= p.top) break;
        try {
          const bars = await ctx.intraday(row.symbol);
          if (bars.length < p.momentumMinutes + 1) continue;
          const last = bars.at(-1), past = bars.at(-1 - p.momentumMinutes);
          const momentum = (last.price / past.price - 1) * 100;
          if (last.price > last.vwap && momentum > 0) {
            picks.push({ symbol: row.symbol, reason: `${row.name}：涨 ${row.changePct}%，站上均价线 ${last.vwap.toFixed(2)}，近 ${p.momentumMinutes} 分钟 +${momentum.toFixed(2)}%，量比 ${row.volumeRatio ?? "—"}，成交额 ${(row.amount / 1e8).toFixed(1)} 亿` });
          }
        } catch (error) { ctx.log(`${row.symbol} intraday: ${error.message}`); }
      }
    }

    // 3. Equal-weight the new picks in the room left after holdings we keep.
    const kept = keep.reduce((sum, row) => sum + row.weight, 0);
    const room = Math.max(0, p.exposure - kept);
    const each = picks.length ? Math.min(p.exposure / p.top, room / picks.length) : 0;
    return {
      targets: [...keep, ...picks.map((pick) => ({ ...pick, weight: each }))],
      exits: { stopLossPct: p.stopLossPct, takeProfitPct: p.takeProfitPct },
      // Holdings drift with price; only trade when a change is meaningful.
      minTradeValuePct: 2,
      notes: { entriesOpen, kept: keep.length, picks: picks.length },
    };
  },
};
