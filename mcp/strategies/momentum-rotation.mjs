// Example only — not investment advice. Cross-sectional momentum: rank the universe by N-day
// return (skipping the most recent days), hold the top K with positive momentum, equal weight.
export default {
  id: "momentum-rotation",
  name: "动量轮动 Momentum Rotation",
  version: "1.0.0",
  markets: ["A", "HK", "US"],
  description: "按过去 N 日收益率（跳过最近 skip 日）排序，持有前 K 只正动量标的并等权；不在前 K 的卖出。示例策略，不构成投资建议。",
  params: {
    lookback: { type: "integer", default: 60, min: 5, max: 250, label: "动量回看（日）" },
    skip: { type: "integer", default: 5, min: 0, max: 40, label: "跳过最近（日）" },
    top: { type: "integer", default: 3, min: 1, max: 20, label: "持有数量" },
    exposure: { type: "number", default: 0.95, min: 0.1, max: 1, label: "目标总仓位（0–1）" },
  },
  async run(ctx) {
    const { lookback, skip, top, exposure } = ctx.params;
    const ranked = [];
    for (const symbol of ctx.universe) {
      try {
        const bars = await ctx.history(symbol, { days: lookback + skip + 5 });
        if (bars.length < lookback + skip + 1) { ctx.log(`${symbol}: not enough history`); continue; }
        const end = bars.at(-1 - skip).close;
        const start = bars.at(-1 - skip - lookback).close;
        ranked.push({ symbol, momentum: end / start - 1 });
      } catch (error) { ctx.log(`${symbol}: ${error.message}`); }
    }
    const picks = ranked.filter((row) => row.momentum > 0).sort((a, b) => b.momentum - a.momentum).slice(0, top);
    return {
      targets: picks.map((pick, index) => ({ symbol: pick.symbol, weight: exposure / picks.length, reason: `${lookback} 日动量 ${(pick.momentum * 100).toFixed(1)}%，排名第 ${index + 1}。` })),
      notes: { ranked: ranked.length },
    };
  },
};
