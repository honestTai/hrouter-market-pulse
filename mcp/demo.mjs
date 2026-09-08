// Deterministic synthetic fixtures are isolated from live reports and user storage.
const securities = [
  [
    "0700.HK",
    "腾讯控股",
    "Tencent Holdings",
    "HK",
    "HKD",
    518.2,
    2.34,
    "互联网服务",
    "Internet services",
  ],
  [
    "AAPL",
    "苹果",
    "Apple Inc.",
    "US",
    "USD",
    237.49,
    1.12,
    "消费电子",
    "Consumer electronics",
  ],
  [
    "600519.SS",
    "贵州茅台",
    "Kweichow Moutai",
    "A",
    "CNY",
    1432.8,
    -0.83,
    "食品饮料",
    "Food & beverage",
  ],
  [
    "NVDA",
    "英伟达",
    "NVIDIA",
    "US",
    "USD",
    142.63,
    3.26,
    "半导体",
    "Semiconductors",
  ],
  [
    "9988.HK",
    "阿里巴巴",
    "Alibaba Group",
    "HK",
    "HKD",
    134.8,
    -1.46,
    "互联网服务",
    "Internet services",
  ],
  [
    "300750.SZ",
    "宁德时代",
    "CATL",
    "A",
    "CNY",
    268.42,
    1.87,
    "电池与新能源",
    "Batteries & energy",
  ],
  [
    "MSFT",
    "微软",
    "Microsoft",
    "US",
    "USD",
    428.76,
    -0.42,
    "软件服务",
    "Software",
  ],
  [
    "1810.HK",
    "小米集团",
    "Xiaomi",
    "HK",
    "HKD",
    51.15,
    2.71,
    "消费电子",
    "Consumer electronics",
  ],
];

export const demoPreferences = {
  watchlist: securities.map((item) => item[0]),
  language: "zh-CN",
  positions: [
    {
      symbol: "0700.HK",
      quantity: 400,
      averageCost: 471.6,
      currency: "HKD",
      stopPrice: 487.0,
    },
    {
      symbol: "AAPL",
      quantity: 50,
      averageCost: 221.4,
      currency: "USD",
      stopPrice: 223.0,
    },
    {
      symbol: "600519.SS",
      quantity: 100,
      averageCost: 1465,
      currency: "CNY",
      stopPrice: 1378,
    },
    {
      symbol: "NVDA",
      quantity: 80,
      averageCost: 129.5,
      currency: "USD",
      stopPrice: 132.0,
    },
  ],
};

export const demoDecisions = [
  {
    id: "demo-decision-tencent",
    symbol: "0700.HK",
    state: "watch",
    createdAt: "2026-09-08T02:15:00.000Z",
    thesis:
      "观察价格能否在 20 日均线上方保持，同时核对公告与板块相对强度。此条为合成演示记录。",
    thesisZh:
      "观察价格能否在 20 日均线上方保持，同时核对公告与板块相对强度。此条为合成演示记录。",
    thesisEn:
      "Observe whether price holds above its 20-day average alongside verified announcements and sector strength. Synthetic demo record.",
    entryCondition: "Daily close above MA20; fresh quotes from two sources.",
    invalidationCondition:
      "Daily close below reference support; pause on stale data.",
    horizon: "5 trading sessions",
    riskBudget: "0.5% of portfolio equity",
    evidenceIds: ["demo-evidence-1"],
    reviews: [],
  },
];

function bars(price, seed, now, intraday = false) {
  const length = intraday ? 68 : 120;
  const dates = [];
  let cursor = new Date(now);
  cursor.setUTCHours(intraday ? 7 : 8, 0, 0, 0);
  while (dates.length < length) {
    if (intraday || ![0, 6].includes(cursor.getUTCDay()))
      dates.unshift(cursor.toISOString());
    cursor = new Date(cursor.getTime() - (intraday ? 5 * 60000 : 86400000));
  }
  let previous = price * (intraday ? 0.978 : 0.795);
  return dates.map((timestamp, index) => {
    const progress = index / (length - 1);
    const wave =
      Math.sin(index * 0.32 + seed) * 0.015 + Math.sin(index * 0.11) * 0.025;
    const close =
      index === length - 1
        ? price
        : price *
          ((intraday ? 0.978 : 0.795) +
            progress * (intraday ? 0.022 : 0.205) +
            wave * (intraday ? 0.22 : 1));
    const open =
      previous *
      (1 + Math.sin(index * 1.7 + seed) * (intraday ? 0.001 : 0.0045));
    previous = close;
    return {
      timestamp,
      open: Math.round(open * 100) / 100,
      high:
        Math.round(
          Math.max(open, close) *
            (1 + 0.004 + Math.abs(Math.sin(index + seed)) * 0.006) *
            100,
        ) / 100,
      low:
        Math.round(
          Math.min(open, close) *
            (1 - 0.004 - Math.abs(Math.cos(index + seed)) * 0.006) *
            100,
        ) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(
        (intraday ? 180000 : 14500000) *
          (0.6 + Math.abs(Math.sin(index * 1.34 + seed)) * 1.6),
      ),
    };
  });
}

export function makeDemoReport(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const asOf = new Date(now.getTime() - 35000).toISOString();
  const items = securities.map(
    (
      [
        symbol,
        nameZh,
        nameEn,
        market,
        currency,
        price,
        changePct,
        sectorZh,
        sectorEn,
      ],
      index,
    ) => {
      const history = bars(price, index, now);
      const position = demoPreferences.positions.find(
        (item) => item.symbol === symbol,
      );
      const sma = (period) =>
        Math.round(
          (history.slice(-period).reduce((sum, row) => sum + row.close, 0) /
            period) *
            100,
        ) / 100;
      return {
        symbol,
        name: nameZh,
        nameZh,
        nameEn,
        market,
        currency,
        price,
        changePct,
        change: Math.round((price - price / (1 + changePct / 100)) * 100) / 100,
        previousClose: Math.round((price / (1 + changePct / 100)) * 100) / 100,
        dayHigh: Math.round(price * 1.009 * 100) / 100,
        dayLow: Math.round(price * 0.974 * 100) / 100,
        volume: history.at(-1).volume,
        asOf,
        exchangeTimezone:
          market === "US"
            ? "America/New_York"
            : market === "HK"
              ? "Asia/Hong_Kong"
              : "Asia/Shanghai",
        exchange:
          market === "US"
            ? "NASDAQ"
            : market === "HK"
              ? "HKEX"
              : symbol.endsWith(".SZ")
                ? "SZSE"
                : "SSE",
        sector: sectorZh,
        sectorZh,
        sectorEn,
        marketState: "REGULAR",
        period: "1d",
        history,
        intraday: {
          status: "available",
          period: "5m",
          history: bars(price, index, now, true),
          volumeRatioSameTime: {
            value: 1.38,
            status: "available",
            samples: 20,
          },
        },
        freshness: {
          status: index === 6 ? "stale" : "fresh",
          signalEligible: index !== 6,
          ageSeconds: index === 6 ? 7200 : 35,
          asOf,
          calendarCoverage: "synthetic",
        },
        signalEligible: index !== 6,
        source: "Synthetic demo fixtures",
        dataSources: [
          { provider: "Demo source A" },
          { provider: "Demo source B" },
        ],
        crossCheck: {
          status: "consistent",
          spreadPct: 0.02,
          timeDifferenceSeconds: 8,
        },
        dataQuality: {
          status: index === 6 ? "stale" : "ok",
          warnings:
            index === 6
              ? [
                  {
                    code: "stale",
                    messageZh: "合成行情超过时效阈值，条件触发已暂停。",
                    messageEn:
                      "Synthetic quote exceeds its freshness threshold; triggers are suspended.",
                  },
                ]
              : [],
        },
        indicators: {
          period: "1d",
          sampleCount: history.length,
          sma5: sma(5),
          sma20: sma(20),
          sma60: sma(60),
          rsi14: 58.42 + index,
          macd: Math.round(price * 0.0034 * 1000) / 1000,
          macdSignal: Math.round(price * 0.0029 * 1000) / 1000,
          support20d: Math.round(price * 0.918 * 100) / 100,
          resistance20d: Math.round(price * 1.023 * 100) / 100,
          annualizedVolatilityPct: 24.68 + index * 2.7,
          maxDrawdown60dPct: -8.36 - index * 0.8,
          volumeRatio20d: 1.37,
          trend: "上行",
        },
        position: position
          ? {
              ...position,
              marketValue: price * position.quantity,
              unrealizedPnl: (price - position.averageCost) * position.quantity,
              unrealizedPnlPct: (price / position.averageCost - 1) * 100,
            }
          : null,
        relativeChangePct:
          changePct - (market === "A" ? 0.64 : market === "HK" ? 1.26 : 0.48),
        relativeStrength: { relativeChangePct: changePct - 0.64 },
        alerts: [],
        news: [],
      };
    },
  );
  const indices = [
    {
      symbol: "000001.SS",
      name: "上证指数",
      nameZh: "上证指数",
      nameEn: "SSE Composite",
      market: "A",
      price: 3867.42,
      changePct: 0.64,
      asOf,
    },
    {
      symbol: "^HSI",
      name: "恒生指数",
      nameZh: "恒生指数",
      nameEn: "Hang Seng Index",
      market: "HK",
      price: 25187.36,
      changePct: 1.26,
      asOf,
    },
    {
      symbol: "^GSPC",
      name: "标普 500",
      nameZh: "标普 500",
      nameEn: "S&P 500",
      market: "US",
      price: 6482.75,
      changePct: 0.48,
      asOf,
    },
  ];
  const sectors = [
    {
      name: "互联网服务",
      nameZh: "互联网服务",
      nameEn: "Internet services",
      count: 2,
      changePct: 0.44,
      relativeChangePct: -0.82,
    },
    {
      name: "消费电子",
      nameZh: "消费电子",
      nameEn: "Consumer electronics",
      count: 2,
      changePct: 1.92,
      relativeChangePct: 1.05,
    },
    {
      name: "半导体",
      nameZh: "半导体",
      nameEn: "Semiconductors",
      count: 1,
      changePct: 3.26,
      relativeChangePct: 2.78,
    },
    {
      name: "食品饮料",
      nameZh: "食品饮料",
      nameEn: "Food & beverage",
      count: 1,
      changePct: -0.83,
      relativeChangePct: -1.47,
    },
  ];
  const events = [
    {
      id: "demo-evidence-1",
      symbol: "0700.HK",
      titleZh: "演示事件：季度业绩资料待核对",
      titleEn: "Demo event: quarterly results pending review",
      title: "演示事件：季度业绩资料待核对",
      sourceTier: "official",
      publisher: "HKEX (demo reference)",
      url: "https://www.hkexnews.hk/",
      publishedAt: new Date(now.getTime() - 7200000).toISOString(),
      effectiveAt: new Date(now.getTime() + 86400000).toISOString(),
    },
    {
      id: "demo-evidence-2",
      symbol: "AAPL",
      titleZh: "演示事件：官方投资者关系资料更新",
      titleEn: "Demo event: investor relations material updated",
      title: "演示事件：官方投资者关系资料更新",
      sourceTier: "official",
      publisher: "Apple IR (demo reference)",
      url: "https://investor.apple.com/",
      publishedAt: new Date(now.getTime() - 86400000).toISOString(),
    },
  ];
  const monitor = {
    events: [
      {
        id: "demo-alert-1",
        symbol: "NVDA",
        type: "confirmed",
        titleZh: "涨幅条件持续确认",
        titleEn: "Price-change condition confirmed",
        ruleName: "Change > 3%",
        value: 3.26,
        asOf: new Date(now.getTime() - 1800000).toISOString(),
      },
      {
        id: "demo-alert-2",
        symbol: "300750.SZ",
        type: "recovered",
        titleZh: "价格恢复至观察区间",
        titleEn: "Price returned to its watch range",
        ruleName: "Support recovery",
        asOf: new Date(now.getTime() - 1100000).toISOString(),
      },
      {
        id: "demo-alert-3",
        symbol: "0700.HK",
        type: "triggered",
        titleZh: "同刻成交量超过观察阈值",
        titleEn: "Same-time volume crossed watch threshold",
        ruleName: "Same-time volume > 1.3x",
        value: 1.38,
        asOf: new Date(now.getTime() - 300000).toISOString(),
      },
    ],
  };
  return {
    schemaVersion: 2,
    demo: true,
    language: "zh-CN",
    phase: options.phase || "research",
    generatedAt: now.toISOString(),
    runId: "synthetic-demo",
    source: "Synthetic demo fixtures",
    items,
    context: {
      indices,
      sectors,
      breadth: { scope: "watchlist", advances: 5, declines: 3, unchanged: 0 },
    },
    events,
    evidence: events,
    monitor,
    summary: {
      requested: 8,
      succeeded: 8,
      failed: 0,
      advances: 5,
      declines: 3,
      unchanged: 0,
      alertCount: 3,
      qualityWarningCount: 1,
      signalEligibleCount: 7,
      staleCount: 1,
      marketCounts: { A: 2, HK: 3, US: 3 },
    },
  };
}
