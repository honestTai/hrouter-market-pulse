// Example only — not investment advice. Trend filter: hold names trading above a slow moving
// average whose fast average is above the slow one; equal-weight the strongest few.
export default {
  id: "ma-trend",
  name: "均线趋势 MA Trend",
  version: "1.0.0",
  markets: ["A", "HK", "US"],
  description: "持有收盘价高于慢均线、且快均线在慢均线之上的标的，按动量取前 N 只等权；跌破条件即清仓。示例策略，不构成投资建议。",
  params: {
    fast: { type: "integer", default: 20, min: 3, max: 120, label: "快均线（日）" },
    slow: { type: "integer", default: 60, min: 10, max: 250, label: "慢均线（日）" },
    maxPositions: { type: "integer", default: 3, min: 1, max: 20, label: "最多持仓数" },
    exposure: { type: "number", default: 0.9, min: 0.1, max: 1, label: "目标总仓位（0–1）" },
    stopLossPct: { type: "number", default: 8, min: 1, max: 50, label: "止损（% 低于成本）" },
  },
  async run(ctx) {
    const { fast, slow, maxPositions, exposure, stopLossPct } = ctx.params;
    if (slow <= fast) throw new Error("slow must be longer than fast.");
    const candidates = [];
    for (const symbol of ctx.universe) {
      try {
        const bars = await ctx.history(symbol, { days: slow + 30 });
        const closes = bars.map((bar) => bar.close);
        const fastMa = ctx.indicators.sma(closes, fast);
        const slowMa = ctx.indicators.sma(closes, slow);
        const last = closes.at(-1);
        if (!fastMa || !slowMa || !last) { ctx.log(`${symbol}: not enough history`); continue; }
        if (last > slowMa && fastMa > slowMa) candidates.push({ symbol, strength: last / slowMa - 1, last, fastMa, slowMa });
      } catch (error) { ctx.log(`${symbol}: ${error.message}`); }
    }
    const picks = candidates.sort((a, b) => b.strength - a.strength).slice(0, maxPositions);
    const weight = picks.length ? exposure / picks.length : 0;
    return {
      targets: picks.map((pick) => ({ symbol: pick.symbol, weight, reason: `收盘 ${pick.last.toFixed(2)} 高于 MA${slow} ${pick.slowMa.toFixed(2)}，MA${fast} 在上方，强度 ${(pick.strength * 100).toFixed(1)}%。` })),
      exits: { stopLossPct },
      notes: { scanned: ctx.universe.length, qualified: candidates.length },
    };
  },
};
