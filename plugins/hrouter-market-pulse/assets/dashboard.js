/* The server owns market facts. UI state only controls presentation and persisted preferences. */
(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const initial = JSON.parse($("#report-data").textContent);
  const stored = (key) => {
    try {
      return localStorage.getItem(`hrouter.${key}`);
    } catch {
      return null;
    }
  };
  const persist = (key, value) => {
    try {
      localStorage.setItem(`hrouter.${key}`, value);
    } catch {}
  };
  const state = {
    report: initial,
    lang: stored("language") || initial.language || "zh-CN",
    colorConvention:
      stored("colorConvention") ||
      ((stored("language") || initial.language) === "en"
        ? "green-up"
        : "red-up"),
    nav: "market",
    market: "all",
    holdings: false,
    search: "",
    sort: "default",
    descending: false,
    selected:
      initial.items?.find((item) => item.position)?.symbol ||
      initial.items?.[0]?.symbol,
    tab: "indicators",
    timeframe: initial.phase === "intraday" ? "intraday" : "daily",
    range: 90,
    chartType: "candles",
    preferences: {
      watchlist: initial.items?.map((item) => item.symbol) || [],
      positions: [],
      language: "zh-CN",
    },
    decisions: [],
    busy: false,
    interval: 0,
    largeChart: false,
    chart: null,
    chartObserver: null,
  };
  persist("colorConvention", state.colorConvention);
  const translations = {
    "zh-CN": {
      market: "市场工作台",
      syncOfficial: "同步官方资料",
      providerState: "官方来源状态",
      synced: "已同步",
      unavailable: "暂不可用",
      deferred: "待同步",
      "source-required": "需导入原始资料",
      reportingPeriod: "财务期间",
      sourceMetric: "财务指标",
      colorConvention: "涨跌颜色",
      redUp: "红涨绿跌",
      greenUp: "绿涨红跌",
      journal: "决策记录",
      evidence: "公告与事件",
      watchlist: "自选行情",
      holdings: "仅持仓",
      all: "全部",
      A: "A 股",
      HK: "港股",
      US: "美股",
      workspace: "市场总览",
      today: "交易日观察",
      generated: "报告时间",
      refresh: "更新行情",
      updating: "正在获取行情",
      refreshed: "行情已更新",
      autoOff: "自动更新：关",
      minute1: "每 1 分钟",
      minute5: "每 5 分钟",
      minute15: "每 15 分钟",
      settings: "自选与持仓",
      search: "搜索代码或名称",
      security: "标的",
      lastPrice: "最新价",
      changePct: "涨跌幅",
      noMatches: "无匹配标的",
      noWatchlist: "暂无自选股",
      addWatchlist: "添加自选股",
      manage: "管理自选股",
      allMarkets: "A 股 / 港股 / 美股",
      symbols: "只标的",
      coverage: "成功覆盖",
      advances: "上涨",
      declines: "下跌",
      unchanged: "平盘",
      watchBreadth: "自选涨跌分布",
      watchScope: "统计范围：当前自选股",
      benchmark: "基准指数",
      contextScope: "基准与覆盖样本",
      absent: "暂无数据",
      noHistory: "暂无该周期行情",
      chartUnavailable: "图表组件加载失败",
      demo: "演示数据",
      demoBanner: "演示模式 · 全部价格、持仓与事件均为合成样本",
      publicQuotes: "公开来源行情",
      delayed: "可能延迟",
      source: "数据源",
      quoteTime: "报价时间",
      freshness: "行情时效",
      stale: "已过期",
      fresh: "时效通过",
      closed: "已收盘",
      open: "交易中",
      unknown: "状态未知",
      warning: "待核验",
      error: "获取失败",
      dataQuality: "数据质量",
      sources: "来源核验",
      aligned: "双源一致",
      divergent: "来源有分歧",
      singleSource: "单一来源",
      blocked: "条件触发已暂停",
      tradable: "时效条件通过",
      daily: "日 K",
      intraday: "分时",
      days30: "30 日",
      days90: "90 日",
      max: "全部",
      candles: "蜡烛图",
      line: "收盘线",
      expand: "扩大图表",
      fit: "重置缩放",
      indicators: "技术指标",
      position: "持仓",
      quality: "数据核验",
      noPosition: "暂无该标的持仓",
      editPosition: "编辑持仓",
      quantity: "股数",
      averageCost: "成本价",
      marketValue: "市值",
      unrealized: "浮动盈亏",
      profitPct: "浮动收益率",
      currency: "币种",
      prevClose: "前收",
      high: "日高",
      low: "日低",
      volume: "成交量",
      shares: "股",
      lots: "手",
      priceUnit: "价格单位",
      samples: "根 K 线",
      dailyBasis: "日线口径",
      minuteBasis: "分钟线口径",
      insufficient: "样本不足",
      ma20: "MA20 · 20 日均价",
      ma60: "MA60 · 60 日均价",
      rsi: "RSI14 · 相对强弱",
      macd: "MACD · DIF",
      support: "20 日支撑",
      resistance: "20 日压力",
      volatility: "60 日年化波动",
      drawdown: "60 日最大回撤",
      volumeRatio: "成交量 / 20 日均量",
      sameTimeRatio: "同刻量比",
      volumeRatioTip:
        "完整交易日成交量除以前 20 个交易日均量。分钟线不可与全天成交量直接比较。",
      ma20Tip: "最近 20 个完整交易日收盘价的算术平均；不足 20 个样本不输出。",
      ma60Tip: "最近 60 个完整交易日收盘价的算术平均；不足 60 个样本不输出。",
      rsiTip:
        "14 期涨跌动量，范围 0 至 100；持续横盘为 50。30 与 70 仅为常用观察阈值。",
      macdTip:
        "12 期 EMA 减 26 期 EMA；价格单位与标的一致。信号线为 DIF 的 9 期 EMA。",
      supportTip: "最近 20 个交易日最低价，不代表未来价格一定受到支撑。",
      resistanceTip: "最近 20 个交易日最高价，不代表未来价格一定遇到阻力。",
      volatilityTip: "最近 60 个日收益率标准差乘以 √252，表示历史年化波动。",
      drawdownTip: "最近 60 个交易日从局部高点至随后低点的最大跌幅。",
      neutral: "中性区间",
      overbought: "高位动量",
      oversold: "低位动量",
      trendUp: "上行",
      trendDown: "下行",
      trendSideways: "震荡",
      activity: "异动动态",
      noAlerts: "暂无新异动",
      alert: "条件触发",
      confirmed: "持续确认",
      recovered: "恢复区间",
      trigger: "首次触发",
      suppressed: "已抑制",
      sectorTitle: "板块与相对表现",
      sector: "板块 / 样本",
      members: "覆盖数",
      return: "平均涨跌",
      relative: "相对基准",
      noContext: "暂无市场背景数据",
      noEvidence: "暂无可核验的公告或事件",
      official: "官方",
      primary: "一手来源",
      secondary: "媒体",
      published: "发布时间",
      effective: "生效时间",
      recorded: "记录时间",
      upcoming: "未来事件",
      news: "资讯",
      evidenceTitle: "公告、财报与事件",
      evidenceCount: "条来源",
      noDecisions: "暂无决策记录",
      newDecision: "新增记录",
      decisionTitle: "观察与决策记录",
      entry: "入场条件",
      invalidation: "失效条件",
      thesis: "判断依据",
      horizon: "观察周期",
      riskBudget: "风险预算",
      state: "状态",
      watch: "观察",
      candidate: "候选",
      hold: "持有",
      "review-exit": "评估退出",
      inactive: "归档",
      save: "保存",
      cancel: "取消",
      close: "关闭",
      saved: "已保存",
      symbolInput: "股票代码",
      watchlistInput: "自选代码（以逗号或换行分隔）",
      addPosition: "添加持仓",
      remove: "移除",
      language: "显示语言",
      nameInput: "例如 AAPL、0700.HK、600519.SS",
      riskInput: "例如：组合净值的 0.5%",
      horizonInput: "例如：未来 5 个交易日",
      required: "请填写必填项",
      requestFailed: "请求失败",
      preferencesFailed: "配置读取失败",
      decisionsFailed: "决策记录读取失败",
      demoSaved: "演示更改已保存在本次会话",
      quoteAge: "报价年龄",
      seconds: "秒",
      minutes: "分钟",
      hours: "小时",
      days: "天",
      notRealtime: "公开行情可能延迟；数据时间以来源标记为准。",
      website: "HRouter 官网",
      tradingview: "图表由 TradingView 提供",
      sampleScope: "覆盖样本；不代表全市场",
      crossTime: "双源时间差",
      crossSpread: "双源价格差",
      review: "复盘",
      reviewDecision: "复盘决策",
      outcome: "结果",
      notes: "复盘说明",
      reviewSaved: "复盘已保存",
      reviewOutcome: "复盘结果",
      quoteMissing: "报价缺失",
      historical: "历史收盘",
      warnings: "核验提示",
      history: "历史数据",
      price: "价格",
      risk: "风险",
      relativeLabel: "较基准",
      eventFallback: "市场事件",
      highPriority: "重点关注",
      healthyCount: "时效可用",
      sourceCount: "行情来源",
      noReport: "尚未生成行情报告",
      marketContext: "市场背景",
      actual: "来源原文",
      listCount: "已显示",
      updatedPreferences: "自选与持仓已保存",
      refreshRequired: "更新行情后应用最新持仓",
      allSectors: "自选板块",
      stopPrice: "止损参考",
      returnValue: "收益",
      bilingual: "中 / EN",
    },
    en: {
      market: "Market desk",
      syncOfficial: "Sync official sources",
      providerState: "Official source status",
      synced: "Synced",
      unavailable: "Unavailable",
      deferred: "Deferred",
      "source-required": "Original source required",
      reportingPeriod: "Reporting period",
      sourceMetric: "Financial metric",
      colorConvention: "Price colors",
      redUp: "Red up / green down",
      greenUp: "Green up / red down",
      journal: "Decisions",
      evidence: "Evidence",
      watchlist: "Watchlist",
      holdings: "Held only",
      all: "All",
      A: "A-share",
      HK: "HK",
      US: "US",
      workspace: "Market overview",
      today: "Trading-day watch",
      generated: "Report",
      refresh: "Refresh quotes",
      updating: "Fetching quotes",
      refreshed: "Quotes updated",
      autoOff: "Auto: off",
      minute1: "Every 1 min",
      minute5: "Every 5 min",
      minute15: "Every 15 min",
      settings: "Watchlist & positions",
      search: "Search symbol or company",
      security: "Security",
      lastPrice: "Last price",
      changePct: "Change",
      noMatches: "No matching securities",
      noWatchlist: "Your watchlist is empty",
      addWatchlist: "Add securities",
      manage: "Manage watchlist",
      allMarkets: "A-share / Hong Kong / US",
      symbols: "securities",
      coverage: "Coverage",
      advances: "Advancers",
      declines: "Decliners",
      unchanged: "Unchanged",
      watchBreadth: "Watchlist breadth",
      watchScope: "Scope: current watchlist",
      benchmark: "Benchmark",
      contextScope: "Benchmarks and covered sample",
      absent: "Unavailable",
      noHistory: "No history for this interval",
      chartUnavailable: "Chart library unavailable",
      demo: "Demo data",
      demoBanner: "Demo mode · All prices, positions and events are synthetic",
      publicQuotes: "Public-source quotes",
      delayed: "May be delayed",
      source: "Source",
      quoteTime: "Quote time",
      freshness: "Quote freshness",
      stale: "Stale",
      fresh: "Freshness passed",
      closed: "Closed",
      open: "Trading",
      unknown: "State unknown",
      warning: "Needs verification",
      error: "Fetch failed",
      dataQuality: "Data quality",
      sources: "Source checks",
      aligned: "Sources aligned",
      divergent: "Sources differ",
      singleSource: "Single source",
      blocked: "Triggers suspended",
      tradable: "Freshness gate passed",
      daily: "Daily",
      intraday: "Intraday",
      days30: "30D",
      days90: "90D",
      max: "Max",
      candles: "Candlesticks",
      line: "Close line",
      expand: "Expand chart",
      fit: "Reset zoom",
      indicators: "Indicators",
      position: "Position",
      quality: "Data checks",
      noPosition: "No position in this security",
      editPosition: "Edit position",
      quantity: "Shares",
      averageCost: "Average cost",
      marketValue: "Market value",
      unrealized: "Unrealized P&L",
      profitPct: "Unrealized return",
      currency: "Currency",
      prevClose: "Prev. close",
      high: "Day high",
      low: "Day low",
      volume: "Volume",
      shares: "shares",
      lots: "lots",
      priceUnit: "Price unit",
      samples: "bars",
      dailyBasis: "Daily bars",
      minuteBasis: "Intraday bars",
      insufficient: "Insufficient samples",
      ma20: "MA20 · 20-day average",
      ma60: "MA60 · 60-day average",
      rsi: "RSI14 · Momentum",
      macd: "MACD · DIF",
      support: "20-day support",
      resistance: "20-day resistance",
      volatility: "60-day annualized vol.",
      drawdown: "60-day max drawdown",
      volumeRatio: "Volume / 20-day avg.",
      sameTimeRatio: "Same-time volume ratio",
      volumeRatioTip:
        "Completed session volume divided by the previous 20-session average. Intraday volume is not comparable with full-session volume.",
      ma20Tip:
        "Arithmetic mean of the last 20 complete daily closes. Unavailable with fewer than 20 samples.",
      ma60Tip:
        "Arithmetic mean of the last 60 complete daily closes. Unavailable with fewer than 60 samples.",
      rsiTip:
        "14-period momentum from 0 to 100; a flat series equals 50. 30 and 70 are conventional observation levels.",
      macdTip:
        "12-period EMA minus 26-period EMA in the security's price currency. The signal line is a 9-period EMA of DIF.",
      supportTip:
        "Lowest low over 20 trading days. It does not guarantee future support.",
      resistanceTip:
        "Highest high over 20 trading days. It does not guarantee future resistance.",
      volatilityTip:
        "Standard deviation of the last 60 daily returns multiplied by √252, expressed as annualized historical volatility.",
      drawdownTip:
        "Largest peak-to-trough decline over the last 60 trading days.",
      neutral: "Neutral range",
      overbought: "High momentum",
      oversold: "Low momentum",
      trendUp: "Uptrend",
      trendDown: "Downtrend",
      trendSideways: "Sideways",
      activity: "Market activity",
      noAlerts: "No new activity",
      alert: "Condition met",
      confirmed: "Confirmed",
      recovered: "Back in range",
      trigger: "First trigger",
      suppressed: "Suppressed",
      sectorTitle: "Sectors & relative strength",
      sector: "Sector / sample",
      members: "Covered",
      return: "Avg. change",
      relative: "vs. benchmark",
      noContext: "Market context unavailable",
      noEvidence: "No verified announcements or events",
      official: "Official",
      primary: "Primary",
      secondary: "Media",
      published: "Published",
      effective: "Effective",
      recorded: "Recorded",
      upcoming: "Upcoming",
      news: "News",
      evidenceTitle: "Announcements, results & events",
      evidenceCount: "sources",
      noDecisions: "No decision records yet",
      newDecision: "New decision",
      decisionTitle: "Research & decision journal",
      entry: "Entry condition",
      invalidation: "Invalidation condition",
      thesis: "Rationale",
      horizon: "Time horizon",
      riskBudget: "Risk budget",
      state: "State",
      watch: "Watch",
      candidate: "Candidate",
      hold: "Hold",
      "review-exit": "Review exit",
      inactive: "Archived",
      save: "Save",
      cancel: "Cancel",
      close: "Close",
      saved: "Saved",
      symbolInput: "Symbol",
      watchlistInput: "Symbols (comma or newline separated)",
      addPosition: "Add position",
      remove: "Remove",
      language: "Interface language",
      nameInput: "e.g. AAPL, 0700.HK, 600519.SS",
      riskInput: "e.g. 0.5% of portfolio equity",
      horizonInput: "e.g. Next 5 trading days",
      required: "Complete the required fields",
      requestFailed: "Request failed",
      preferencesFailed: "Could not load preferences",
      decisionsFailed: "Could not load decisions",
      demoSaved: "Demo changes saved for this session",
      quoteAge: "Quote age",
      seconds: "sec",
      minutes: "min",
      hours: "hr",
      days: "days",
      notRealtime:
        "Public quotes may be delayed; timestamps are supplied by each source.",
      website: "HRouter website",
      tradingview: "Charts by TradingView",
      sampleScope: "Covered sample; not market-wide",
      crossTime: "Source time gap",
      crossSpread: "Source price spread",
      review: "Review",
      reviewDecision: "Review decision",
      outcome: "Outcome",
      notes: "Review notes",
      reviewSaved: "Review saved",
      reviewOutcome: "Review outcome",
      quoteMissing: "Quote unavailable",
      historical: "Historical close",
      warnings: "Verification notes",
      history: "Historical data",
      price: "Price",
      risk: "Risk",
      relativeLabel: "vs. benchmark",
      eventFallback: "Market event",
      highPriority: "Priority watch",
      healthyCount: "Freshness available",
      sourceCount: "Quote sources",
      noReport: "No quote report yet",
      marketContext: "Market context",
      actual: "Original source",
      listCount: "Showing",
      updatedPreferences: "Watchlist and positions saved",
      refreshRequired: "Refresh quotes to apply positions",
      allSectors: "Watchlist sectors",
      stopPrice: "Reference stop",
      returnValue: "Return",
      bilingual: "中 / EN",
    },
  };
  const t = (key) => (translations[state.lang] || translations.en)[key] || key;
  const locale = () => (state.lang === "en" ? "en-US" : "zh-CN");
  const num = (value, digits = 2) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Intl.NumberFormat(locale(), {
          maximumFractionDigits: digits,
          minimumFractionDigits: digits,
        }).format(value)
      : "—";
  const compact = (value) =>
    typeof value === "number" && Number.isFinite(value)
      ? new Intl.NumberFormat(locale(), {
          notation: "compact",
          maximumFractionDigits: 2,
        }).format(value)
      : "—";
  const signed = (value, suffix = "%") =>
    typeof value === "number" && Number.isFinite(value)
      ? `${value > 0 ? "+" : ""}${num(value)}${suffix}`
      : "—";
  const direction = (value) =>
    value < 0 ? "negative" : value > 0 ? "positive" : "";
  const icon = (name) =>
    `<i data-lucide="${esc(name)}" aria-hidden="true"></i>`;
  const date = (value, timeOnly = false, zone) => {
    if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
    return new Intl.DateTimeFormat(locale(), {
      ...(timeOnly ? {} : { month: "short", day: "2-digit" }),
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: zone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).format(new Date(value));
  };
  const age = (value) => {
    if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - new Date(value).getTime()) / 1000),
    );
    return seconds < 60
      ? `${seconds} ${t("seconds")}`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} ${t("minutes")}`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)} ${t("hours")}`
          : `${Math.floor(seconds / 86400)} ${t("days")}`;
  };
  const selected = () =>
    (state.report.items || []).find((item) => item.symbol === state.selected);
  const name = (item) =>
    state.lang === "en"
      ? item.nameEn || item.shortName || item.name || item.symbol
      : item.nameZh || item.name || item.symbol;
  const safeUrl = (value) => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  const freshState = (item) => {
    if (item.error) return "error";
    const freshness = item.freshness || item.dataQuality?.freshness || {};
    const status = freshness.status || item.dataQuality?.status;
    if (
      !state.report.demo &&
      status === "fresh" &&
      Date.now() - Date.parse(item.asOf) >
        (freshness.maxAgeSeconds || 300) * 1000
    )
      return "stale";
    if (
      [
        "stale",
        "expired",
        "future",
        "invalid",
        "missing_timestamp",
        "unknown-timestamp",
      ].includes(status) ||
      item.dataQuality?.stale === true
    )
      return "stale";
    if (
      [
        "closed",
        "closed_fresh",
        "session_closed",
        "fresh_closed",
        "market-closed",
      ].includes(status)
    )
      return "closed";
    if (["fresh", "ok"].includes(status)) return "fresh";
    return "warning";
  };
  const crossState = (item) =>
    ({
      matched: "aligned",
      consistent: "aligned",
      aligned: "aligned",
      divergent: "divergent",
      stale: "stale",
      single_source: "singleSource",
      "single-source": "singleSource",
      unavailable: "warning",
      "timestamp-skew": "warning",
      "time-skew": "warning",
      "time-mismatch": "warning",
      "currency-mismatch": "warning",
      "unverified-calendar": "warning",
      unverified: "warning",
    })[item.crossCheck?.status] || "singleSource";
  const trend = (value) =>
    ({
      上行: "trendUp",
      下行: "trendDown",
      震荡: "trendSideways",
      数据不足: "insufficient",
      up: "trendUp",
      down: "trendDown",
      sideways: "trendSideways",
    })[value] || "absent";
  const statusBadge = (item) => {
    const status = freshState(item);
    return `<span class="badge ${status === "fresh" ? "good" : status === "error" ? "bad" : "warn"}"><span class="status-dot ${status === "fresh" ? "" : "warning"}"></span>${t(status)}</span>`;
  };
  const button = (
    action,
    label,
    symbol,
    classes = "icon-button",
    attributes = "",
  ) =>
    `<button class="${classes}" data-action="${action}" title="${esc(label)}" aria-label="${esc(label)}" ${attributes}>${icon(symbol)}${classes.includes("primary-button") || classes.includes("secondary-button") ? `<span>${esc(label)}</span>` : ""}</button>`;
  function icons() {
    window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
  }
  function notify(message, error = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("error", error);
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 5000);
  }
  async function api(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        payload.error?.message ||
          payload.error ||
          `${t("requestFailed")} (${response.status})`,
      );
    return payload;
  }
  function readArray(value, key) {
    return Array.isArray(value)
      ? value
      : Array.isArray(value?.[key])
        ? value[key]
        : [];
  }
  function contextIndices() {
    const context = state.report.context || {};
    const indices =
      context.indices ||
      context.benchmarks ||
      context.marketSnapshot?.indices ||
      [];
    return Array.isArray(indices)
      ? indices
      : Object.values(indices).flatMap((item) =>
          Array.isArray(item) ? item : [item],
        );
  }
  function benchmark(market) {
    return contextIndices().find((item) => item.market === market) || null;
  }
  function tape() {
    const summary = state.report.summary || {};
    const total =
      (summary.advances || 0) +
        (summary.declines || 0) +
        (summary.unchanged || 0) || 1;
    return `<section class="market-tape" aria-label="${t("marketContext")}">${[
      "A",
      "HK",
      "US",
    ]
      .map((market) => {
        const item = benchmark(market);
        return `<div class="market-cell"><div class="market-cell-label"><strong>${item ? esc(name(item)) : t(market)}</strong><span class="badge">${t("benchmark")}</span></div><div class="market-cell-value"><span class="num">${num(item?.price)}</span><span class="num change ${direction(item?.changePct)}">${signed(item?.changePct)}</span></div><div class="market-cell-bottom"><span>${esc(item?.symbol || t("absent"))}</span><span>${item ? date(item.asOf, true, item.exchangeTimezone) : t("noContext")}</span></div></div>`;
      })
      .join(
        "",
      )}<div class="market-cell"><div class="market-cell-label"><strong>${t("watchBreadth")}</strong><span class="small">${num(state.report.items?.length || 0, 0)} ${t("symbols")}</span></div><div class="market-cell-value"><span class="num positive">${num(summary.advances || 0, 0)}</span><span class="small muted">${t("advances")}</span><span class="num negative">${num(summary.declines || 0, 0)}</span><span class="small muted">${t("declines")}</span></div><div class="breadth-track" aria-label="${t("watchScope")}"><span class="up" style="flex:${(summary.advances || 0) / total}"></span><span style="flex:${(summary.unchanged || 0) / total}"></span><span class="down" style="flex:${(summary.declines || 0) / total}"></span></div><div class="market-cell-bottom"><span>${t("watchScope")}</span></div></div></section>`;
  }
  function filteredItems() {
    const list = (state.report.items || []).filter(
      (item) =>
        (state.market === "all" || item.market === state.market) &&
        (!state.holdings || item.position?.quantity > 0) &&
        `${item.symbol} ${name(item)} ${item.nameEn || ""} ${item.nameZh || ""}`
          .toLowerCase()
          .includes(state.search.toLowerCase()),
    );
    if (state.sort !== "default")
      list.sort((a, b) => {
        const av = state.sort === "symbol" ? a.symbol : a[state.sort];
        const bv = state.sort === "symbol" ? b.symbol : b[state.sort];
        if (av == null) return 1;
        if (bv == null) return -1;
        return (
          (typeof av === "string" ? av.localeCompare(bv) : av - bv) *
          (state.descending ? -1 : 1)
        );
      });
    return list;
  }
  function watchRows() {
    const items = filteredItems();
    return items.length
      ? items
          .map(
            (item) =>
              `<tr data-symbol="${esc(item.symbol)}" tabindex="0" aria-selected="${item.symbol === state.selected}" class="${item.symbol === state.selected ? "selected" : ""}"><td><span class="ticker-name">${esc(name(item))}</span><span class="ticker-code"><span class="num">${esc(item.symbol)}</span><span class="market-tag">${esc(item.market)}</span>${item.position?.quantity ? `<span class="holding-dot" title="${t("position")}">${icon("briefcase-business")}</span>` : ""}</span></td><td><span class="watch-price num">${num(item.price)}</span><span class="watch-age">${item.currency || t("absent")} · ${t(freshState(item))}</span></td><td><span class="change-chip num ${direction(item.changePct)}">${signed(item.changePct)}</span></td></tr>`,
          )
          .join("")
      : `<tr><td colspan="3" class="table-empty">${t(state.report.items?.length ? "noMatches" : "noWatchlist")}</td></tr>`;
  }
  function watchlist() {
    const summary = state.report.summary || {};
    return `<aside class="watchlist"><div class="panel-heading"><h2>${t("watchlist")}<span class="counter num">${state.report.items?.length || 0}</span></h2>${button("preferences", t("manage"), "plus")}</div><label class="search-wrap">${icon("search")}<input id="watch-search" type="search" placeholder="${t("search")}" aria-label="${t("search")}" value="${esc(state.search)}"></label><div class="list-filters"><div class="segment" aria-label="${t("market")}">${["all", "A", "HK", "US"].map((market) => `<button data-market="${market}" class="${state.market === market ? "active" : ""}" aria-pressed="${state.market === market}">${t(market)}</button>`).join("")}</div><label class="check-label"><input type="checkbox" id="holdings-filter" ${state.holdings ? "checked" : ""}>${t("holdings")}</label></div><div class="watch-table-wrap"><table class="watch-table"><thead><tr>${[
      ["symbol", "security"],
      ["price", "lastPrice"],
      ["changePct", "changePct"],
    ]
      .map(
        ([key, label]) =>
          `<th scope="col"><button data-sort="${key}">${t(label)}${icon(state.sort === key ? (state.descending ? "arrow-down" : "arrow-up") : "chevrons-up-down")}</button></th>`,
      )
      .join(
        "",
      )}</tr></thead><tbody id="watch-rows">${watchRows()}</tbody></table></div><div class="watchlist-foot"><span>${t("allMarkets")}</span><span id="list-count" class="num">${filteredItems().length} / ${state.report.items?.length || 0}</span></div><div class="watch-summary"><h3>${t("dataQuality")}</h3><dl><div><dt>${t("coverage")}</dt><dd class="num">${summary.succeeded || 0}<span class="muted small"> / ${summary.requested || 0}</span></dd></div><div><dt>${t("healthyCount")}</dt><dd class="num">${(state.report.items || []).filter((item) => ["fresh", "closed"].includes(freshState(item))).length}</dd></div><div><dt>${t("highPriority")}</dt><dd class="num">${summary.alertCount || 0}</dd></div></dl><div class="list-note">${icon("clock-3")}${t("publicQuotes")} · ${t("delayed")}</div></div></aside>`;
  }
  function detail() {
    const item = selected();
    if (!item)
      return `<section class="detail"><div class="empty-state">${icon("chart-no-axes-combined")}<p>${t("noReport")}</p>${button("preferences", t("addWatchlist"), "plus", "primary-button")}</div></section>`;
    const ind = item.indicators || {};
    const history = chartRows(item);
    return `<section class="detail"><div class="detail-header"><div><div class="security-identity"><div class="security-monogram">${esc(item.symbol.replace(/[^A-Z0-9]/g, "").slice(0, 2))}</div><div><h2>${esc(name(item))}</h2><p><span class="num">${esc(item.symbol)}</span><span>·</span><span>${esc(item.exchange || t(item.market))}</span>${item.sector ? `<span>·</span><span>${esc(state.lang === "en" ? item.sectorEn || item.sector : item.sectorZh || item.sector)}</span>` : ""}</p></div></div><div class="security-tags">${statusBadge(item)}<span class="badge">${t(crossState(item))}</span>${item.position?.quantity ? `<span class="badge good">${t("hold")}</span>` : ""}</div></div><div class="quote-block"><div class="main-price num">${num(item.price)}<small>${esc(item.currency || "")}</small></div><div class="quote-change num ${direction(item.changePct)}"><span>${signed(item.change, "")}</span><span>${signed(item.changePct)}</span></div><div class="quote-asof"><span class="status-dot ${freshState(item) === "fresh" ? "" : "warning"}"></span>${date(item.asOf, false, item.exchangeTimezone)} · ${esc(item.exchangeTimezone || "UTC")}</div></div></div><dl class="quote-strip">${[
      ["prevClose", item.previousClose, false],
      ["high", item.dayHigh, false],
      ["low", item.dayLow, false],
      ["volume", item.volume, true],
      [
        "relative",
        item.relativeStrength?.relativeDayPct ??
          item.relativeChangePct ??
          item.relativePerformancePct,
        false,
      ],
    ]
      .map(
        ([label, value, short]) =>
          `<div class="quote-stat"><dt>${t(label)}</dt><dd class="num ${label === "relative" ? direction(value) : ""}">${label === "relative" ? signed(value) : short ? compact(value) : num(value)}${short ? `<span class="small muted"> ${t("shares")}</span>` : ""}</dd></div>`,
      )
      .join(
        "",
      )}</dl><div class="chart-toolbar"><div class="segment" aria-label="${t("history")}">${["daily", "intraday"].map((mode) => `<button data-timeframe="${mode}" class="${state.timeframe === mode ? "active" : ""}" aria-pressed="${state.timeframe === mode}">${t(mode)}</button>`).join("")}<span class="meta-separator"></span>${(state.timeframe === "daily" ? [30, 90, 0] : []).map((range) => `<button data-range="${range}" class="${state.range === range ? "active" : ""}" aria-pressed="${state.range === range}">${t(range === 30 ? "days30" : range === 90 ? "days90" : "max")}</button>`).join("")}</div><div class="chart-tools">${button("candles", t("candles"), "chart-candlestick", `icon-button ${state.chartType === "candles" ? "active" : ""}`, `aria-pressed="${state.chartType === "candles"}"`)}${button("line", t("line"), "chart-no-axes-combined", `icon-button ${state.chartType === "line" ? "active" : ""}`, `aria-pressed="${state.chartType === "line"}"`)}${button("fit", t("fit"), "scan")}${button("expand", t("expand"), "maximize-2")}</div></div><div class="chart-legend">${state.timeframe === "daily" ? `<span><i class="legend-line"></i>MA20 <b class="num">${num(ind.sma20)}</b></span><span><i class="legend-line ma60"></i>MA60 <b class="num">${num(ind.sma60)}</b></span>` : `<span>${esc(item.intraday?.period || "5m")} · ${t("minuteBasis")}</span>`}<span id="chart-crosshair" class="num"></span></div><div class="chart-frame ${state.largeChart ? "tall" : ""}"><div id="price-chart" class="chart-area" role="img" aria-label="${esc(name(item))} ${t(state.timeframe)} ${t(state.chartType === "candles" ? "candles" : "line")}"></div><div id="chart-status" class="chart-status" ${history.length ? "hidden" : ""}>${icon("chart-no-axes-combined")}${t("noHistory")}</div><span class="chart-label">${t("volume")} (${t("shares")})</span></div><div class="chart-attribution"><span>${history.length} ${t("samples")} · ${t(state.timeframe === "daily" ? "dailyBasis" : "minuteBasis")}</span><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">${t("tradingview")}</a></div><div class="detail-tabs" role="tablist">${[
      ["indicators", "sliders-horizontal"],
      ["position", "briefcase-business"],
      ["evidence", "newspaper"],
      ["quality", "shield-check"],
    ]
      .map(
        ([tab, symbol]) =>
          `<button role="tab" data-tab="${tab}" aria-selected="${state.tab === tab}" class="${state.tab === tab ? "active" : ""}">${icon(symbol)}${t(tab)}</button>`,
      )
      .join(
        "",
      )}</div><div class="tab-panel" role="tabpanel">${detailPanel(item)}</div></section>`;
  }
  function metric(key, value, unit, tip, hint = "") {
    return `<div class="indicator"><dt>${t(key)}<button type="button" title="${esc(t(tip))}" aria-label="${esc(t(tip))}">${icon("info")}</button></dt><dd class="num ${key === "drawdown" ? "negative" : ""}">${num(value, key === "macd" ? 3 : 2)}<small>${unit}</small></dd>${key === "rsi" && Number.isFinite(value) ? `<div class="rsi-bar"><span class="rsi-point" style="left:${Math.max(0, Math.min(100, value))}%"></span></div>` : `<div class="indicator-hint">${value == null ? t("insufficient") : hint}</div>`}</div>`;
  }
  function detailPanel(item) {
    if (state.tab === "position") return positionPanel(item);
    if (state.tab === "evidence") return evidencePanel(item.symbol);
    if (state.tab === "quality") return qualityPanel(item);
    const ind = item.indicators || {};
    const currency = esc(item.currency || "");
    const ratio =
      state.timeframe === "intraday"
        ? item.intraday?.volumeRatioSameTime?.value
        : ind.volumeRatio20d;
    return `<div class="section-heading"><h3>${t("indicators")} <span class="muted small">· ${t("dailyBasis")}</span></h3><small>${t("priceUnit")}: ${currency || "—"}</small></div><dl class="indicator-grid">${metric("ma20", ind.sma20, currency, "ma20Tip", t(trend(ind.trend)))}${metric("ma60", ind.sma60, currency, "ma60Tip")}${metric("rsi", ind.rsi14, "/ 100", "rsiTip")}${metric("macd", ind.macd, currency, "macdTip")}${metric("support", ind.support20d, currency, "supportTip")}${metric("resistance", ind.resistance20d, currency, "resistanceTip")}${metric("volatility", ind.annualizedVolatilityPct, "%", "volatilityTip")}${metric("drawdown", ind.maxDrawdown60dPct, "%", "drawdownTip")}</dl><div class="quality-line">${icon("shield-check")}<span>${t(crossState(item))}</span><span class="meta-separator"></span><span>${t("quoteAge")}: ${age(item.asOf)}</span><span class="meta-separator"></span><span>${t(state.timeframe === "intraday" ? "sameTimeRatio" : "volumeRatio")}: <b class="num">${num(ratio)}×</b></span><button class="muted" title="${esc(t("volumeRatioTip"))}" aria-label="${esc(t("volumeRatioTip"))}" style="padding:0;display:flex">${icon("info")}</button></div>`;
  }
  function positionPanel(item) {
    if (!item.position?.quantity)
      return `<div class="empty-state compact">${icon("briefcase-business")}${t("noPosition")}<div>${button("preferences", t("editPosition"), "pencil", "secondary-button")}</div></div>`;
    const position = item.position;
    return `<div class="section-heading"><h3>${t("position")} · ${esc(item.symbol)}</h3>${button("preferences", t("editPosition"), "pencil", "secondary-button")}</div><dl class="position-grid">${[
      ["quantity", position.quantity, t("shares")],
      ["averageCost", position.averageCost, item.currency],
      ["marketValue", position.marketValue, item.currency],
      ["unrealized", position.unrealizedPnl, item.currency],
      ["profitPct", position.unrealizedPnlPct, "%"],
      [
        "stopPrice",
        position.invalidationPrice ?? position.stopPrice,
        item.currency,
      ],
    ]
      .map(
        ([label, value, unit]) =>
          `<div><dt>${t(label)}</dt><dd class="num ${["unrealized", "profitPct"].includes(label) ? direction(value) : ""}">${num(value, label === "quantity" ? 0 : 2)} <span class="muted small">${esc(unit || "")}</span></dd></div>`,
      )
      .join("")}</dl>`;
  }
  function qualityPanel(item) {
    const freshness = item.freshness || item.dataQuality?.freshness || {};
    const warnings = item.dataQuality?.warnings || [];
    const sources =
      item.dataSources?.map((source) => source.provider).join(" + ") ||
      item.source ||
      t("absent");
    return `<div class="section-heading"><h3>${t("quality")}</h3>${statusBadge(item)}</div><dl class="quality-grid">${[
      ["source", sources],
      ["quoteTime", `${date(item.asOf)} · ${age(item.asOf)}`],
      ["sources", t(crossState(item))],
      [
        "crossSpread",
        signed(
          item.crossCheck?.priceDifferencePct ??
            item.crossCheck?.spreadPct ??
            item.crossCheck?.deviationPct,
        ),
      ],
      [
        "crossTime",
        `${num(item.crossCheck?.timestampSkewSeconds ?? item.crossCheck?.timeDifferenceSeconds ?? item.crossCheck?.timestampGapSeconds, 0)} ${t("seconds")}`,
      ],
      [
        "state",
        t(
          item.signalEligible !== true ||
            freshness.signalEligible !== true ||
            freshness.triggersAllowed === false ||
            item.dataQuality?.triggersAllowed === false ||
            ["stale", "error"].includes(freshState(item))
            ? "blocked"
            : "tradable",
        ),
      ],
    ]
      .map(
        ([label, value]) =>
          `<div class="quality-item"><dt>${t(label)}</dt><dd>${esc(value)}</dd></div>`,
      )
      .join(
        "",
      )}</dl>${warnings.length ? `<ul class="quality-warnings">${warnings.map((warning) => `<li>${esc(localized(warning))}</li>`).join("")}</ul>` : ""}`;
  }
  function localized(value) {
    if (typeof value !== "string")
      return state.lang === "en"
        ? value?.messageEn ||
            value?.titleEn ||
            value?.message ||
            value?.title ||
            (value?.code ? localized(value.code) : "") ||
            ""
        : value?.messageZh ||
            value?.titleZh ||
            value?.message ||
            value?.title ||
            (value?.code ? localized(value.code) : "") ||
            "";
    const known = {
      "Quote timestamp is missing or invalid.": [
        "报价时间缺失或无效。",
        "Quote timestamp is missing or invalid.",
      ],
      "Quote timestamp is in the future.": [
        "报价时间晚于当前时间。",
        "Quote timestamp is in the future.",
      ],
      "Quote exceeds the configured maximum age; retained for reference only.":
        [
          "报价已超过时效阈值，仅用于历史参考。",
          "Quote exceeds the configured maximum age; retained for reference only.",
        ],
      "Recent quote; holiday or special-session calendar has not been verified.":
        [
          "报价较新，但休市或特殊交易日历尚未核验。",
          "Recent quote; holiday or special-session calendar has not been verified.",
        ],
      "Quote is outside a verified regular trading session.": [
        "报价不在已核验的常规交易时段内。",
        "Quote is outside a verified regular trading session.",
      ],
      "Quote belongs to another local session.": [
        "报价属于另一交易日。",
        "Quote belongs to another local session.",
      ],
      "threshold-crossed": ["首次突破观察阈值", "Watch threshold crossed"],
      "threshold-recovered": ["恢复至观察区间", "Back in the watch range"],
      Unclassified: ["未分类", "Unclassified"],
      "Demo source A": ["演示来源 A", "Demo source A"],
      "Demo source B": ["演示来源 B", "Demo source B"],
      "Change > 3%": ["涨幅 > 3%", "Change > 3%"],
      "Support recovery": ["价格恢复支撑", "Support recovery"],
      "Same-time volume > 1.3x": [
        "同刻量比 > 1.3 倍",
        "Same-time volume > 1.3x",
      ],
      open: ["继续观察", "Still open"],
      invalidated: ["条件失效", "Invalidated"],
      "target-reached": ["目标达到", "Target reached"],
      expired: ["观察到期", "Expired"],
      closed: ["已结束", "Closed"],
    };
    if (known[value]) return known[value][state.lang === "en" ? 1 : 0];
    if (value.startsWith("Cross-check: "))
      return `${t("sources")}: ${t(crossState({ crossCheck: { status: value.slice(13) } }))}`;
    return value;
  }
  function evidenceItems(symbol) {
    const top = readArray(state.report.events, "events").concat(
      readArray(state.report.evidence, "items"),
    );
    const itemNews = (state.report.items || [])
      .filter((item) => !symbol || item.symbol === symbol)
      .flatMap((item) =>
        [
          ...(item.events || []),
          ...(item.evidence || []),
          ...(item.news || []),
        ].map((event) => ({ ...event, symbol: event.symbol || item.symbol })),
      );
    const seen = new Set();
    return [...top, ...itemNews]
      .filter(
        (event) =>
          !symbol ||
          event.symbol === symbol ||
          event.entity === symbol ||
          event.entity?.symbol === symbol ||
          event.symbols?.includes(symbol),
      )
      .filter((event) => {
        const key =
          event.id || `${event.url}:${event.title}:${event.publishedAt}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(
        (a, b) =>
          new Date(b.publishedAt || b.effectiveAt || 0) -
          new Date(a.publishedAt || a.effectiveAt || 0),
      );
  }
  function evidencePanel(symbol) {
    const events = evidenceItems(symbol);
    const syncResults = (state.report.officialSync?.results || []).filter(
      (result) => !symbol || result.symbol === symbol,
    );
    const syncStatus = syncResults.length
      ? `<div class="provider-status"><span>${t("providerState")}</span>${syncResults.map((result) => `<span class="badge ${result.status === "synced" ? "good" : "warn"}" title="${esc(result.error || result.financialError || "")}"><span class="num">${esc(result.symbol)}</span>${t(result.status)}</span>`).join("")}</div>`
      : "";
    return `<div class="section-heading"><h3>${t("evidenceTitle")}</h3>${button("sync-official", t("syncOfficial"), "refresh-cw", "secondary-button", state.busy ? "disabled" : "")}</div>${syncStatus}${
      events.length
        ? `<ul class="evidence-list">${events
            .map((event) => {
              const url = safeUrl(event.url || event.sourceUrl);
              const title =
                localized(event) || event.summary || t("eventFallback");
              const tier =
                event.sourceTier ||
                event.tier ||
                (event.official ? "official" : "secondary");
              return `<li>${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(title)}</a>` : `<span>${esc(title)}</span>`}${financialValue(event)}<div class="evidence-meta"><span class="badge ${tier === "official" ? "good" : ""}">${t(tier)}</span><span class="num">${esc(event.symbol || event.entity?.symbol || "")}</span><span>${esc(event.publisher || event.provider || event.source || "")}</span><span>${t("published")}: ${date(event.publishedAt || event.availableAt)}</span>${event.effectiveAt ? `<span>${t("effective")}: ${date(event.effectiveAt)}</span>` : ""}</div></li>`;
            })
            .join("")}</ul>`
        : `<div class="empty-state compact">${icon("newspaper")}${t("noEvidence")}</div>`
    }`;
  }
  function financialValue(event) {
    const data = event.payload;
    if (!data || !Number.isFinite(data.value)) return "";
    const labels = {
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        "营业收入",
        "Revenue",
      ],
      Revenues: ["营业收入", "Revenue"],
      SalesRevenueNet: ["营业收入净额", "Net revenue"],
      NetIncomeLoss: ["净利润 / 亏损", "Net income / loss"],
      NetCashProvidedByUsedInOperatingActivities: [
        "经营现金流",
        "Operating cash flow",
      ],
      Assets: ["总资产", "Total assets"],
      Liabilities: ["总负债", "Total liabilities"],
    };
    const label =
      labels[data.metric]?.[state.lang === "en" ? 1 : 0] ||
      data.metric ||
      t("sourceMetric");
    return `<div class="financial-value"><span>${esc(label)}</span><strong class="num">${compact(data.value)} <small>${esc(data.unit || "")}</small></strong><span class="small muted">${t("reportingPeriod")}: ${esc(data.periodStart || "")} ${data.periodStart ? "→" : ""} ${esc(data.periodEnd || "—")}${data.form ? ` · ${esc(data.form)}` : ""}</span></div>`;
  }
  function activityEvents() {
    const monitor = state.report.monitor || {};
    const events = readArray(
      monitor.events || state.report.alertEvents,
      "events",
    );
    if (events.length) return events;
    return (state.report.items || []).flatMap((item) =>
      (item.alerts || []).map((alert) => ({
        symbol: item.symbol,
        type: "alert",
        title: localized(alert),
        asOf: item.asOf,
      })),
    );
  }
  function activity() {
    const events = activityEvents().slice(-5).reverse();
    return `<section class="lower-panel"><div class="panel-heading"><h2>${icon("radio")}${t("activity")}<span class="counter num">${activityEvents().length}</span></h2><span class="small muted">${t("today")}</span></div>${
      events.length
        ? `<ul class="events-list">${events
            .map((event) => {
              const type =
                event.type || event.transition || event.eventType || event.code;
              return `<li class="event-row"><time class="event-time num">${date(event.triggeredAt || event.createdAt || event.asOf || event.timestamp, true)}</time><span class="event-dot ${["recovered", "recovery", "threshold-recovered"].includes(type) ? "positive" : "negative"}"></span><div class="event-main"><button data-symbol="${esc(event.symbol || "")}"><strong class="num">${esc(event.symbol || "")}</strong> ${esc(localized(event) || t({ triggered: "trigger", first_trigger: "trigger", confirmed: "confirmed", recovery: "recovered", recovered: "recovered" }[type] || "alert"))}</button><p>${esc(localized(event.conditionLabel ? localized(event.conditionLabel) : state.lang === "en" ? event.ruleNameEn || event.ruleName || event.ruleId || "" : event.ruleNameZh || event.ruleName || event.ruleId || ""))}${event.value != null ? ` · ${num(event.value)}` : ""}</p></div></li>`;
            })
            .join("")}</ul>`
        : `<div class="empty-state compact">${icon("radio")}${t("noAlerts")}</div>`
    }</section>`;
  }
  function sectorPanel() {
    const context = state.report.context || {};
    const sectors = readArray(
      context.sectors || context.sectorPerformance,
      "items",
    );
    return `<section class="lower-panel"><div class="panel-heading"><h2>${icon("chart-no-axes-column-increasing")}${t("sectorTitle")}</h2><span class="small muted">${t("allSectors")}</span></div>${
      sectors.length
        ? `<table class="context-table"><thead><tr><th>${t("sector")}</th><th>${t("members")}</th><th>${t("return")}</th><th>${t("relative")}</th></tr></thead><tbody>${sectors
            .slice(0, 5)
            .map((sector) => {
              const value =
                sector.changePct ??
                sector.averageChangePct ??
                sector.avgChangePct;
              return `<tr><td>${esc(state.lang === "en" ? sector.nameEn || sector.name || sector.sector : sector.nameZh || sector.name || sector.sector)}</td><td class="num muted">${num(sector.count ?? sector.members?.length ?? sector.covered, 0)}</td><td class="num ${direction(value)}">${signed(value)}</td><td class="num ${direction(sector.relativeChangePct ?? sector.relativePerformancePct)}">${signed(sector.relativeChangePct ?? sector.relativePerformancePct)}</td></tr>`;
            })
            .join("")}</tbody></table>`
        : `<div class="empty-state compact">${icon("chart-no-axes-column-increasing")}${t("noContext")}</div>`
    }<div class="context-foot">${t("sampleScope")}</div></section>`;
  }
  function journalPanel() {
    const records = state.decisions;
    return `<div class="section-heading"><h3>${t("decisionTitle")} <span class="counter num">${records.length}</span></h3>${button("new-decision", t("newDecision"), "plus", "primary-button")}</div>${
      records.length
        ? `<ul class="decision-list">${[...records]
            .reverse()
            .map(
              (record) =>
                `<li><div class="decision-title"><span><span class="num">${esc(record.symbol)}</span> <span class="badge">${t(record.state || "watch")}</span></span><span class="muted small">${date(record.createdAt || record.recordedAt)}</span></div><p>${esc(state.lang === "en" ? record.thesisEn || record.thesis : record.thesisZh || record.thesis)}</p><dl>${[
                  ["entry", record.entryCondition],
                  ["invalidation", record.invalidationCondition],
                  ["horizon", record.horizon],
                  ["riskBudget", record.riskBudget],
                ]
                  .map(
                    ([key, value]) =>
                      `<div><dt>${t(key)}</dt><dd>${esc(typeof value === "object" ? JSON.stringify(value) : value || "—")}</dd></div>`,
                  )
                  .join(
                    "",
                  )}</dl><div class="evidence-meta"><span>${t("recorded")}: ${date(record.createdAt || record.recordedAt)}</span>${button("review-decision", t("review"), "clipboard-check", "secondary-button", `data-id="${esc(record.id)}"`)}</div>${(record.reviews || []).map((review) => `<p><span class="badge">${t("reviewOutcome")}</span> ${esc(localized(review.outcome))} · ${esc(review.notes || "")}</p>`).join("")}</li>`,
            )
            .join("")}</ul>`
        : `<div class="empty-state">${icon("notebook-pen")}${t("noDecisions")}</div>`
    }`;
  }
  function render() {
    destroyChart();
    document.documentElement.lang = state.lang;
    document.documentElement.dataset.colorConvention = state.colorConvention;
    const title =
      state.nav === "market"
        ? "workspace"
        : state.nav === "journal"
          ? "decisionTitle"
          : "evidenceTitle";
    $("#app").innerHTML =
      `<header class="app-header"><a class="brand" href="https://hrouter.net/" target="_blank" rel="noreferrer"><span class="brand-mark">H</span><span class="brand-text"><strong>Hrouter</strong><span>Market Pulse</span></span></a><nav class="header-nav" aria-label="${t("market")}">${[
        ["market", "panels-top-left"],
        ["journal", "notebook-pen"],
        ["evidence", "newspaper"],
      ]
        .map(
          ([key, symbol]) =>
            `<button data-nav="${key}" class="${state.nav === key ? "active" : ""}" aria-label="${t(key)}" aria-current="${state.nav === key ? "page" : "false"}" title="${t(key)}">${icon(symbol)}<span>${t(key)}</span></button>`,
        )
        .join(
          "",
        )}</nav><div class="header-tools"><span class="connection"><span class="status-dot"></span>${t(state.report.demo ? "demo" : "publicQuotes")}</span><div class="locale-control" aria-label="${t("language")}"><button data-lang="zh-CN" class="${state.lang === "zh-CN" ? "active" : ""}" aria-pressed="${state.lang === "zh-CN"}">中文</button><button data-lang="en" class="${state.lang === "en" ? "active" : ""}" aria-pressed="${state.lang === "en"}">English</button></div>${button("preferences", t("settings"), "settings-2")}</div></header>${state.report.demo ? `<div class="demo-banner">${icon("flask-conical")}${t("demoBanner")}</div>` : ""}<main class="page"><div class="page-heading"><div><h1>${t(title)}${state.nav === "market" ? `<small>${t("today")}</small>` : ""}</h1><div class="heading-meta"><span>${t("generated")}: <span class="num">${date(state.report.generatedAt)}</span></span><span class="meta-separator"></span><span>${Intl.DateTimeFormat().resolvedOptions().timeZone}</span>${state.report.demo ? `<span class="badge demo">${t("demo")}</span>` : ""}</div></div><div class="heading-tools"><select id="auto-refresh" aria-label="${t("refresh")}">${[
        [0, "autoOff"],
        [60, "minute1"],
        [300, "minute5"],
        [900, "minute15"],
      ]
        .map(
          ([seconds, label]) =>
            `<option value="${seconds}" ${state.interval === seconds ? "selected" : ""}>${t(label)}</option>`,
        )
        .join(
          "",
        )}</select>${button("refresh", t(state.busy ? "updating" : "refresh"), "refresh-cw", `primary-button ${state.busy ? "busy" : ""}`, state.busy ? "disabled" : "")}</div></div>${state.nav === "market" ? `${tape()}<div class="workspace">${watchlist()}${detail()}</div><div class="lower-workspace">${activity()}${sectorPanel()}</div>` : `<section class="full-workspace"><div class="tab-panel">${state.nav === "journal" ? journalPanel() : evidencePanel()}</div></section>`}<footer class="footer"><div class="footer-left">${icon("shield-check")}<span>${t("notRealtime")}</span></div><div class="footer-right"><span>Hrouter Market Pulse</span><a href="https://hrouter.net/" target="_blank" rel="noreferrer">${t("website")} ↗</a></div></footer></main>`;
    icons();
    if (state.nav === "market") drawChart();
  }
  function chartRows(item) {
    const interval =
      item.period || item.interval || item.historyInterval || "1d";
    const daily = item.dailyHistory || (interval === "1d" ? item.history : []);
    const minute =
      item.intraday?.history ||
      item.intradayHistory ||
      (interval !== "1d" ? item.history : []);
    const raw = (state.timeframe === "daily" ? daily : minute) || [];
    const deduped = new Map();
    raw.forEach((row) => {
      const stamp = row.timestamp || row.date || row.time;
      const time =
        typeof stamp === "number"
          ? Math.floor(stamp > 1e12 ? stamp / 1000 : stamp)
          : Math.floor(new Date(stamp).getTime() / 1000);
      if (
        !Number.isFinite(time) ||
        !Number.isFinite(row.close) ||
        row.close <= 0
      )
        return;
      deduped.set(time, {
        ...row,
        time,
        open: Number.isFinite(row.open) && row.open > 0 ? row.open : row.close,
        high: Math.max(row.high || row.close, row.open || row.close, row.close),
        low: Math.min(
          row.low > 0 ? row.low : row.close,
          row.open > 0 ? row.open : row.close,
          row.close,
        ),
      });
    });
    return [...deduped.values()].sort((a, b) => a.time - b.time);
  }
  function destroyChart() {
    state.chartObserver?.disconnect();
    state.chartObserver = null;
    state.chart?.remove();
    state.chart = null;
  }
  function drawChart() {
    const item = selected();
    const target = $("#price-chart");
    if (!item || !target) return;
    const rows = chartRows(item);
    if (!rows.length) return;
    const lib = window.LightweightCharts;
    if (!lib) {
      $("#chart-status").hidden = false;
      $("#chart-status").textContent = t("chartUnavailable");
      return;
    }
    const redUp = state.colorConvention === "red-up";
    const gain = redUp ? "#d65359" : "#258663";
    const loss = redUp ? "#258663" : "#d65359";
    const chart = lib.createChart(target, {
      width: target.clientWidth,
      height: target.clientHeight,
      layout: {
        background: { type: "solid", color: "#ffffff" },
        textColor: "#84968a",
        fontFamily: '"Bahnschrift", "Segoe UI", sans-serif',
        fontSize: 10,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "#f2f5f3" },
        horzLines: { color: "#edf2ef" },
      },
      crosshair: {
        mode: lib.CrosshairMode.Normal,
        vertLine: { color: "#9db8a8", width: 1, style: 2 },
        horzLine: { color: "#9db8a8", width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: "#e7eee9",
        scaleMargins: { top: 0.12, bottom: 0.28 },
      },
      timeScale: {
        borderColor: "#e7eee9",
        timeVisible: state.timeframe === "intraday",
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 7,
        minBarSpacing: 2,
      },
      localization: { locale: locale(), priceFormatter: (value) => num(value) },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });
    state.chart = chart;
    const series = chart.addSeries(
      state.chartType === "candles" ? lib.CandlestickSeries : lib.LineSeries,
      state.chartType === "candles"
        ? {
            upColor: gain,
            downColor: loss,
            borderVisible: false,
            wickUpColor: gain,
            wickDownColor: loss,
            priceLineColor: item.changePct >= 0 ? gain : loss,
            priceLineStyle: 2,
          }
        : { color: gain, lineWidth: 2 },
    );
    series.setData(
      rows.map((row) =>
        state.chartType === "candles"
          ? {
              time: row.time,
              open: row.open,
              high: row.high,
              low: row.low,
              close: row.close,
            }
          : { time: row.time, value: row.close },
      ),
    );
    const volume = chart.addSeries(lib.HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0.025 },
      visible: false,
    });
    volume.setData(
      rows
        .filter((row) => Number.isFinite(row.volume))
        .map((row) => ({
          time: row.time,
          value: row.volume,
          color: row.close >= row.open !== redUp ? "#c3ddd0" : "#f1cccc",
        })),
    );
    if (state.timeframe === "daily")
      [20, 60].forEach((period) => {
        if (rows.length < period) return;
        const line = chart.addSeries(lib.LineSeries, {
          color: period === 20 ? "#c99c40" : "#9384a8",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        let sum = 0;
        line.setData(
          rows.flatMap((row, index) => {
            sum += row.close;
            if (index >= period) sum -= rows[index - period].close;
            return index >= period - 1
              ? [{ time: row.time, value: sum / period }]
              : [];
          }),
        );
      });
    if (state.range && state.timeframe === "daily" && rows.length > state.range)
      chart.timeScale().setVisibleLogicalRange({
        from: rows.length - state.range,
        to: rows.length + 2,
      });
    else chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((event) => {
      const label = $("#chart-crosshair");
      if (!label) return;
      const data = event.seriesData.get(series);
      label.textContent = data
        ? state.chartType === "candles"
          ? `O ${num(data.open)}  H ${num(data.high)}  L ${num(data.low)}  C ${num(data.close)}`
          : `${t("price")} ${num(data.value)}`
        : "";
    });
    state.chartObserver = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      chart.applyOptions({
        width: Math.floor(box.width),
        height: Math.floor(box.height),
      });
    });
    state.chartObserver.observe(target);
  }
  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      const response = await api("/api/refresh", {
        method: "POST",
        body: JSON.stringify({
          phase: state.timeframe === "intraday" ? "intraday" : "research",
        }),
      });
      const latest = response.items
        ? response
        : response.report?.items
          ? response.report
          : await api("/api/latest");
      state.report = latest.report || latest;
      if (!state.report.items?.some((item) => item.symbol === state.selected))
        state.selected =
          state.report.items?.find((item) => item.position)?.symbol ||
          state.report.items?.[0]?.symbol;
      notify(t("refreshed"));
    } catch (error) {
      notify(error.message, true);
    } finally {
      state.busy = false;
      render();
    }
  }
  async function syncOfficial() {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      const symbols =
        state.nav === "market" && state.selected
          ? [state.selected]
          : state.preferences.watchlist;
      const sync = await api("/api/official/sync", {
        method: "POST",
        body: JSON.stringify({ symbols }),
      });
      const evidence = await api("/api/evidence");
      if (!state.report.demo) {
        state.report.evidence = readArray(evidence, "items");
        for (const item of state.report.items || [])
          item.evidence = state.report.evidence.filter(record => record.entity?.symbol === item.symbol);
      }
      state.report.officialSync = sync;
      notify(t("synced"));
    } catch (error) {
      notify(error.message, true);
    } finally {
      state.busy = false;
      render();
    }
  }
  function setAutoRefresh(value) {
    clearInterval(state.refreshTimer);
    state.interval = Number(value) || 0;
    if (state.interval)
      state.refreshTimer = setInterval(() => {
        if (!document.hidden) refresh();
      }, state.interval * 1000);
  }
  function closeDialog() {
    $("#editor-dialog").close();
  }
  function openDialog(title, body, actions, formId) {
    const dialog = $("#editor-dialog");
    dialog.innerHTML = `<form id="${formId}"><div class="dialog-heading"><h2>${title}</h2>${button("close-dialog", t("close"), "x", "icon-button", 'type="button"')}</div><div class="dialog-body">${body}<div id="form-error" class="form-error" role="alert"></div></div><div class="dialog-actions">${button("close-dialog", t("cancel"), "x", "secondary-button", 'type="button"')}<button class="primary-button" type="submit">${icon("check")}${actions}</button></div></form>`;
    icons();
    if (!dialog.open) dialog.showModal();
  }
  function positionEditor(position = {}) {
    return `<div class="position-editor"><input name="position-symbol" aria-label="${t("symbolInput")}" value="${esc(position.symbol || "")}" placeholder="AAPL" maxlength="20"><input name="position-quantity" aria-label="${t("quantity")}" type="number" min="0" step="any" value="${esc(position.quantity ?? "")}"><input name="position-cost" aria-label="${t("averageCost")}" type="number" min="0" step="any" value="${esc(position.averageCost ?? "")}"><input name="position-stop" aria-label="${t("stopPrice")}" type="number" min="0" step="any" value="${esc(position.invalidationPrice ?? position.stopPrice ?? "")}"><select name="position-currency" aria-label="${t("currency")}">${["CNY", "HKD", "USD"].map((currency) => `<option ${position.currency === currency ? "selected" : ""}>${currency}</option>`).join("")}</select>${button("remove-position", t("remove"), "trash-2", "icon-button", 'type="button"')}</div>`;
  }
  function preferencesDialog() {
    const preferences = state.preferences;
    const colors = `<fieldset class="color-options"><legend>${t("colorConvention")}</legend>${[
      ["red-up", "redUp"],
      ["green-up", "greenUp"],
    ]
      .map(
        ([value, label]) =>
          `<label><input type="radio" name="colorConvention" value="${value}" ${state.colorConvention === value ? "checked" : ""}><span class="color-swatch" style="background:${value === "red-up" ? "#d65359" : "#258663"}">${icon("arrow-up")}</span><span>${t(label)}</span></label>`,
      )
      .join("")}</fieldset>`;
    openDialog(
      t("settings"),
      `<div class="form-grid"><div class="form-field full"><label for="watchlist-input">${t("watchlistInput")}</label><textarea id="watchlist-input" name="watchlist" placeholder="${t("nameInput")}">${esc(preferences.watchlist?.join(", ") || "")}</textarea></div><div class="form-field"><label for="language-input">${t("language")}</label><select id="language-input" name="language"><option value="zh-CN" ${state.lang === "zh-CN" ? "selected" : ""}>中文</option><option value="en" ${state.lang === "en" ? "selected" : ""}>English</option></select></div></div>${colors}<div class="form-section-heading"><h3>${t("position")}</h3>${button("add-position", t("addPosition"), "plus", "secondary-button", 'type="button"')}</div><div class="position-editor position-labels"><span>${t("security")}</span><span>${t("quantity")}</span><span>${t("averageCost")}</span><span>${t("stopPrice")}</span><span>${t("currency")}</span><span></span></div><div id="position-editors">${(preferences.positions || []).map(positionEditor).join("")}</div>`,
      t("save"),
      "preferences-form",
    );
  }
  function decisionDialog() {
    const states = ["watch", "hold", "review-exit", "inactive"];
    openDialog(
      t("newDecision"),
      `<div class="form-grid"><div class="form-field"><label for="decision-symbol">${t("symbolInput")} <span class="required">*</span></label><input id="decision-symbol" name="symbol" required value="${esc(state.selected || "")}" maxlength="20"></div><div class="form-field"><label for="decision-state">${t("state")}</label><select id="decision-state" name="state">${states.map((value) => `<option value="${value}">${t(value)}</option>`).join("")}</select></div><div class="form-field full"><label for="decision-thesis">${t("thesis")} <span class="required">*</span></label><textarea id="decision-thesis" name="thesis" required maxlength="2000"></textarea></div><div class="form-field"><label for="decision-entry">${t("entry")} <span class="required">*</span></label><textarea id="decision-entry" name="entryCondition" required maxlength="2000"></textarea></div><div class="form-field"><label for="decision-invalidation">${t("invalidation")} <span class="required">*</span></label><textarea id="decision-invalidation" name="invalidationCondition" required maxlength="2000"></textarea></div><div class="form-field"><label for="decision-horizon">${t("horizon")}</label><input id="decision-horizon" name="horizon" placeholder="${t("horizonInput")}" maxlength="160"></div><div class="form-field"><label for="decision-risk">${t("riskBudget")}</label><input id="decision-risk" name="riskBudget" placeholder="${t("riskInput")}" maxlength="160"></div></div>`,
      t("save"),
      "decision-form",
    );
  }
  function reviewDialog(id) {
    const outcomes = [
      "open",
      "invalidated",
      "target-reached",
      "expired",
      "closed",
    ];
    const labels =
      state.lang === "en"
        ? ["Still open", "Invalidated", "Target reached", "Expired", "Closed"]
        : ["继续观察", "条件失效", "目标达到", "观察到期", "已结束"];
    openDialog(
      t("reviewDecision"),
      `<input type="hidden" name="id" value="${esc(id)}"><div class="form-grid"><div class="form-field full"><label for="review-outcome">${t("outcome")} <span class="required">*</span></label><select id="review-outcome" name="outcome">${outcomes.map((value, index) => `<option value="${value}">${labels[index]}</option>`).join("")}</select></div><div class="form-field full"><label for="review-notes">${t("notes")}</label><textarea id="review-notes" name="notes" maxlength="2000"></textarea></div></div>`,
      t("save"),
      "review-form",
    );
  }
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button,[data-symbol]");
    if (!target) return;
    if (target.dataset.lang) {
      state.lang = target.dataset.lang;
      persist("language", state.lang);
      render();
      try {
        await api("/api/preferences", {
          method: "POST",
          body: JSON.stringify({ language: state.lang }),
        });
      } catch (error) {
        notify(error.message, true);
      }
      return;
    }
    if (target.dataset.nav) {
      state.nav = target.dataset.nav;
      render();
      return;
    }
    if (target.dataset.market) {
      state.market = target.dataset.market;
      render();
      return;
    }
    if (target.dataset.sort) {
      state.descending =
        state.sort === target.dataset.sort
          ? !state.descending
          : target.dataset.sort !== "symbol";
      state.sort = target.dataset.sort;
      render();
      return;
    }
    if (
      target.dataset.symbol &&
      state.report.items?.some((item) => item.symbol === target.dataset.symbol)
    ) {
      state.selected = target.dataset.symbol;
      render();
      return;
    }
    if (target.dataset.tab) {
      state.tab = target.dataset.tab;
      render();
      return;
    }
    if (target.dataset.range != null) {
      state.range = Number(target.dataset.range);
      render();
      return;
    }
    if (target.dataset.timeframe) {
      state.timeframe = target.dataset.timeframe;
      render();
      if (selected() && !chartRows(selected()).length) await refresh();
      return;
    }
    const action = target.dataset.action;
    if (action === "refresh") await refresh();
    else if (action === "sync-official") await syncOfficial();
    else if (action === "preferences") preferencesDialog();
    else if (action === "new-decision") decisionDialog();
    else if (action === "review-decision") reviewDialog(target.dataset.id);
    else if (action === "close-dialog") closeDialog();
    else if (action === "add-position") {
      $("#position-editors").insertAdjacentHTML("beforeend", positionEditor());
      icons();
    } else if (action === "remove-position")
      target.closest(".position-editor").remove();
    else if (action === "line" || action === "candles") {
      state.chartType = action;
      render();
    } else if (action === "fit") state.chart?.timeScale().fitContent();
    else if (action === "expand") {
      state.largeChart = !state.largeChart;
      render();
    }
  });
  document.addEventListener("keydown", (event) => {
    const row = event.target.closest("tr[data-symbol]");
    if (row && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      state.selected = row.dataset.symbol;
      render();
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.id === "watch-search") {
      state.search = event.target.value;
      $("#watch-rows").innerHTML = watchRows();
      $("#list-count").textContent =
        `${filteredItems().length} / ${state.report.items?.length || 0}`;
      icons();
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target.name === "position-symbol") {
      const symbol = event.target.value.trim().toUpperCase();
      const currency = /\.HK$|^HK\d+$|^\d{5}$/.test(symbol)
        ? "HKD"
        : /\.(SS|SZ)$|^\d{6}$/.test(symbol)
          ? "CNY"
          : "USD";
      $(
        '[name="position-currency"]',
        event.target.closest(".position-editor"),
      ).value = currency;
    }
    if (event.target.id === "holdings-filter") {
      state.holdings = event.target.checked;
      render();
    } else if (event.target.id === "auto-refresh")
      setAutoRefresh(event.target.value);
  });
  document.addEventListener("submit", async (event) => {
    if (
      !["preferences-form", "decision-form", "review-form"].includes(
        event.target.getAttribute("id"),
      )
    )
      return;
    event.preventDefault();
    const form = event.target;
    const fields = Object.fromEntries(new FormData(form));
    const submit = $("button[type=submit]", form);
    submit.disabled = true;
    try {
      if (form.getAttribute("id") === "preferences-form") {
        const positions = [
          ...form.querySelectorAll("#position-editors .position-editor"),
        ]
          .map((row) => ({
            symbol: $('[name="position-symbol"]', row).value.trim(),
            quantity: Number($('[name="position-quantity"]', row).value),
            averageCost: Number($('[name="position-cost"]', row).value),
            invalidationPrice: $('[name="position-stop"]', row).value
              ? Number($('[name="position-stop"]', row).value)
              : null,
            currency: $('[name="position-currency"]', row).value,
          }))
          .filter((position) => position.symbol);
        const payload = {
          watchlist: fields.watchlist
            .split(/[,，\n]+/)
            .map((value) => value.trim())
            .filter(Boolean),
          language: fields.language,
          positions,
        };
        const result = await api("/api/preferences", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        state.preferences = result.preferences || result;
        state.lang = fields.language;
        state.colorConvention = fields.colorConvention || state.colorConvention;
        persist("colorConvention", state.colorConvention);
        persist("language", state.lang);
        closeDialog();
        notify(t("updatedPreferences"));
        await refresh();
      } else if (form.getAttribute("id") === "decision-form") {
        await api("/api/decisions", {
          method: "POST",
          body: JSON.stringify({
            ...fields,
            evidenceIds: evidenceItems(fields.symbol)
              .map((item) => item.id)
              .filter(Boolean),
          }),
        });
        state.decisions = readArray(await api("/api/decisions"), "decisions");
        closeDialog();
        notify(t("saved"));
        render();
      } else {
        await api(`/api/decisions/${encodeURIComponent(fields.id)}/review`, {
          method: "POST",
          body: JSON.stringify({
            outcome: fields.outcome,
            notes: fields.notes,
          }),
        });
        state.decisions = readArray(await api("/api/decisions"), "decisions");
        closeDialog();
        notify(t("reviewSaved"));
        render();
      }
    } catch (error) {
      $("#form-error").textContent = error.message;
      submit.disabled = false;
    }
  });
  render();
  Promise.allSettled([api("/api/preferences"), api("/api/decisions")]).then(
    (results) => {
      if (results[0].status === "fulfilled") {
        state.preferences = results[0].value.preferences || results[0].value;
        if (!stored("language") && state.preferences.language)
          state.lang = state.preferences.language;
      } else notify(t("preferencesFailed"), true);
      if (results[1].status === "fulfilled")
        state.decisions = readArray(results[1].value, "decisions");
      else notify(t("decisionsFailed"), true);
      render();
    },
  );
})();
