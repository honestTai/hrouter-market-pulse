// A 股主板趋势回踩（起始策略）。规则来自 shouldnotappearcalm/a-share-skill 的
// mainboard-multi-swing-defensive / trend_pullback（MIT）。只用已收盘日线和实时报价，可直接交给
// arena_write_strategy 作为第一版，再按复盘结果改参数。
export default {
  id: "trend-pullback",
  name: "主板趋势回踩",
  version: "1.0.0",
  markets: ["A"],
  description: "快线在慢线上方、回踩快线附近、RSI 在区间内入场；跌破慢线或 RSI 过热离场；参数邻域一致性和往返成本过滤。",
  params: {
    fast: { type: "integer", default: 8, min: 3, max: 30, label: "快线" },
    slow: { type: "integer", default: 20, min: 10, max: 120, label: "慢线" },
    pullbackCeiling: { type: "number", default: 1.008, min: 1, max: 1.05, label: "回踩上限（相对快线）" },
    exitRsi: { type: "number", default: 74, min: 55, max: 95, label: "RSI 离场线" },
    weight: { type: "number", default: 0.15, min: 0.02, max: 0.5, label: "单只目标仓位" },
    maxNew: { type: "integer", default: 5, min: 1, max: 20, label: "每轮最多新候选" },
    consensusMin: { type: "number", default: 0.67, min: 0, max: 1, label: "参数邻域一致性" },
  },
  async run(ctx) {
    const p = ctx.params;
    const sma = (values, n) => (values.length >= n ? values.slice(-n).reduce((a, b) => a + b, 0) / n : null);
    const rsi = (values, n = 14) => {
      if (values.length <= n) return null;
      let gain = 0, loss = 0;
      for (let i = values.length - n; i < values.length; i += 1) {
        const change = values[i] - values[i - 1];
        if (change > 0) gain += change; else loss -= change;
      }
      return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    };
    const entry = (closes, fast, slow, low, high) => {
      const f = sma(closes, fast), s = sma(closes, slow), r = rsi(closes), last = closes.at(-1);
      if (f === null || s === null || r === null) return false;
      const bull = f > s;
      const [lo, hi] = bull ? [low, high] : [30, 60];
      return bull && last > s && last < f * p.pullbackCeiling && r >= lo && r <= hi;
    };
    const held = new Map(ctx.account.positions.map((position) => [position.symbol, position]));
    const candidates = [];
    const keep = [];
    for (const symbol of ctx.universe) {
      let bars;
      try { bars = await ctx.history(symbol, { days: Math.max(p.slow, 30) + 40 }); } catch (error) { ctx.log(`${symbol}: ${error.message}`); continue; }
      const closes = bars.map((bar) => bar.close);
      if (closes.length < p.slow + 15) continue;
      const slowMa = sma(closes, p.slow);
      const strength = sma(closes, p.fast) / slowMa - 1;
      if (held.has(symbol)) {
        // Exit on a close below the slow line or an overheated RSI; otherwise keep the holding.
        if (closes.at(-1) < slowMa || rsi(closes) > p.exitRsi) ctx.log(`${symbol}: 离场信号`);
        else keep.push({ symbol, weight: Math.min(p.weight, held.get(symbol).weightPct / 100 || p.weight), reason: `继续持有：收盘在 ${p.slow} 日线上方，RSI ${rsi(closes).toFixed(0)}` });
        continue;
      }
      // Robustness: the signal must hold across neighbouring parameters, not one lucky setting.
      const grid = [[p.fast, p.slow], [p.fast + 2, p.slow], [p.fast, p.slow + 10], [p.fast + 2, p.slow + 10]].flatMap(([fast, slow]) => [[fast, slow, 42, 72], [fast, slow, 40, 70]]);
      const votes = grid.filter(([fast, slow, low, high]) => entry(closes, fast, slow, low, high)).length / grid.length;
      if (!entry(closes, p.fast, p.slow, 42, 72) || votes < p.consensusMin) continue;
      // Round-trip cost ~45 bp: require the distance to the 20-day high to clear it.
      const high20 = Math.max(...closes.slice(-20));
      if (high20 / closes.at(-1) - 1 < 0.0045) continue;
      candidates.push({ symbol, strength, votes });
    }
    candidates.sort((a, b) => b.strength - a.strength);
    const buys = candidates.slice(0, p.maxNew).map((entryCandidate) => ({ symbol: entryCandidate.symbol, weight: p.weight, reason: `趋势回踩：快线强于慢线 ${(entryCandidate.strength * 100).toFixed(1)}%，参数邻域一致性 ${(entryCandidate.votes * 100).toFixed(0)}%` }));
    return { targets: [...keep, ...buys], exits: { stopLossPct: 7 } };
  },
};
