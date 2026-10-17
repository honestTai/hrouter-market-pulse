// 均线定方向 · MACD 定节奏（起始策略）。规则来自 shouldnotappearcalm/a-share-skill 的
// macd-trend-resonance-stock-picker（MIT）。只用已收盘日线；A 档买入，C / D 档离场。
export default {
  id: "macd-resonance",
  name: "MACD 趋势共振",
  version: "1.0.0",
  markets: ["A", "HK", "US"],
  description: "60 日线向上且收盘在其上方才做；MACD 零轴上方金叉或红柱二次放大买入；趋势破坏或死叉走弱离场。",
  params: {
    trend: { type: "integer", default: 60, min: 20, max: 250, label: "方向均线" },
    weight: { type: "number", default: 0.12, min: 0.02, max: 0.5, label: "单只目标仓位" },
    maxNew: { type: "integer", default: 4, min: 1, max: 20, label: "每轮最多新买" },
  },
  async run(ctx) {
    const p = ctx.params;
    const ema = (values, n) => { const k = 2 / (n + 1); let out = null; const series = []; for (const value of values) { out = out === null ? value : value * k + out * (1 - k); series.push(out); } return series; };
    const macd = (closes) => {
      const fast = ema(closes, 12), slow = ema(closes, 26);
      const dif = closes.map((_, i) => fast[i] - slow[i]);
      const dea = ema(dif, 9);
      return { dif, dea, hist: dif.map((value, i) => (value - dea[i]) * 2) };
    };
    const sma = (values, n) => (values.length >= n ? values.slice(-n).reduce((a, b) => a + b, 0) / n : null);
    const held = new Set(ctx.account.positions.map((position) => position.symbol));
    const targets = [];
    const buys = [];
    for (const symbol of ctx.universe) {
      let bars;
      try { bars = await ctx.history(symbol, { days: p.trend + 60 }); } catch (error) { ctx.log(`${symbol}: ${error.message}`); continue; }
      const closes = bars.map((bar) => bar.close);
      if (closes.length < p.trend + 10) continue;
      const ma = sma(closes, p.trend), maBefore = sma(closes.slice(0, -10), p.trend);
      const trendOk = ma > maBefore && closes.at(-1) > ma;
      const { dif, dea, hist } = macd(closes);
      const n = closes.length - 1;
      const cross = dif[n] > dea[n] && dif[n - 1] <= dea[n - 1];
      const reexpand = hist[n] > 0 && hist[n] > hist[n - 1] && hist[n - 1] < hist[n - 2];
      const gradeA = trendOk && dif[n] > 0 && dea[n] > 0 && (cross || reexpand);
      const weakening = dif[n] < dea[n] && hist[n] < hist[n - 1];
      if (held.has(symbol)) {
        if (trendOk && !weakening) targets.push({ symbol, weight: p.weight, reason: `趋势仍在 ${p.trend} 日线上方，MACD 未走弱` });
        else ctx.log(`${symbol}: 趋势破坏或死叉走弱，离场`);
      } else if (gradeA) buys.push({ symbol, weight: p.weight, strength: closes.at(-1) / ma - 1, reason: `A 档：${p.trend} 日线向上，MACD 零轴上方${cross ? "金叉" : "红柱二次放大"}` });
    }
    buys.sort((a, b) => a.strength - b.strength);
    return { targets: [...targets, ...buys.slice(0, p.maxNew).map(({ strength, ...rest }) => rest)], exits: { stopLossPct: 8 } };
  },
};
