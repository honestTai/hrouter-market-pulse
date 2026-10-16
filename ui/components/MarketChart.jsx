import React, { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Checkbox, Dialog, Flex, IconButton, SegmentedControl, Tabs, Tooltip } from "@radix-ui/themes";
import { Activity, CandlestickChart, ChartNoAxesCombined, Expand, Maximize2, X, Clock3, ShieldCheck } from "lucide-react";
import { createChart, CandlestickSeries, AreaSeries, HistogramSeries, LineSeries, ColorType } from "lightweight-charts";
import { useWorkspace } from "../context.jsx";
import { chartBars, isNumber, quoteStatus, crossStatus, localized } from "../data.mjs";
import { Empty, Change, Status, StockMark, Help, FullscreenButton } from "./Primitives.jsx";
import { EvidenceList } from "./ResearchPanels.jsx";

export function PriceChart({ item, timeframe, type, range, averages, large = false }) {
  const { appearance, colorConvention, language, t, number, compact } = useWorkspace();
  const host = useRef(null);
  const [hover, setHover] = useState(null);
  const [error, setError] = useState("");
  const all = useMemo(() => chartBars(item, timeframe, type), [item, timeframe, type]);
  const rows = useMemo(() => range === "all" ? all : all.slice(-Number(range)), [all, range]);
  const gain = colorConvention === "red-up" ? "#dc555c" : "#159d79";
  const loss = colorConvention === "red-up" ? "#159d79" : "#dc555c";
  const row = hover || rows.at(-1);
  useEffect(() => {
    setHover(null); setError("");
    if (!host.current || !rows.length) return;
    let chart;
    let observer;
    try {
      const dark = appearance === "dark";
      chart = createChart(host.current, {
        width: host.current.clientWidth, height: large ? 490 : 305,
        layout: { background: { type: ColorType.Solid, color: dark ? "#18212d" : "#ffffff" }, textColor: dark ? "#8898ae" : "#8b96a5", fontSize: 11, fontFamily: 'Inter, "Segoe UI", sans-serif', attributionLogo: false },
        grid: { vertLines: { visible: false }, horzLines: { color: dark ? "#24303f" : "#f0f3f6" } },
        crosshair: { mode: 0, vertLine: { color: "#98a9b8", style: 2, labelBackgroundColor: "#263c4d" }, horzLine: { color: "#98a9b8", style: 2, labelBackgroundColor: "#263c4d" } },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.25 } },
        timeScale: { borderVisible: false, timeVisible: timeframe === "intraday", secondsVisible: false, rightOffset: 3, fixLeftEdge: true, tickMarkFormatter: (time) => new Intl.DateTimeFormat(language, timeframe === "intraday" ? { hour: "2-digit", minute: "2-digit", hour12: false } : { month: "short", day: "numeric" }).format(new Date(Number(time) * 1000)) },
        localization: { locale: language, timeFormatter: (time) => new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(Number(time) * 1000)) },
      });
      const direction = (item.changePct ?? 0) >= 0 ? gain : loss;
      const series = chart.addSeries(type === "candles" ? CandlestickSeries : AreaSeries, type === "candles"
        ? { upColor: gain, downColor: loss, borderVisible: false, wickUpColor: gain, wickDownColor: loss, priceLineStyle: 2 }
        : { lineColor: direction, topColor: `${direction}26`, bottomColor: `${direction}00`, lineWidth: 2, priceLineStyle: 2 });
      series.setData(rows.map((r) => type === "candles" ? { time: r.time, open: r.open, high: r.high, low: r.low, close: r.close } : { time: r.time, value: r.close }));
      const volumes = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false });
      volumes.priceScale().applyOptions({ scaleMargins: { top: 0.83, bottom: 0.01 } });
      volumes.setData(rows.filter((r) => isNumber(r.volume) && r.volume >= 0).map((r) => ({ time: r.time, value: r.volume, color: `${r.close >= (r.open ?? r.close) ? gain : loss}40` })));
      if (averages && timeframe === "daily") {
        for (const [period, color] of [[20, "#d8a04b"], [60, "#7b83c7"]]) {
          const moving = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
          const data = [];
          for (let i = period - 1; i < all.length; i++) {
            if (all[i].time < rows[0].time) continue;
            data.push({ time: all[i].time, value: all.slice(i - period + 1, i + 1).reduce((s, r) => s + r.close, 0) / period });
          }
          moving.setData(data);
        }
      }
      const byTime = new Map(rows.map((r) => [r.time, r]));
      chart.subscribeCrosshairMove((param) => setHover(byTime.get(param.time) || null));
      chart.timeScale().fitContent();
      const base = large ? 490 : 305;
      observer = new ResizeObserver(() => { const box = host.current; if (box?.clientWidth) chart.applyOptions({ width: box.clientWidth, height: box.clientHeight > base ? box.clientHeight : base }); });
      observer.observe(host.current);
    } catch (err) { setError(err.message); }
    return () => { observer?.disconnect(); chart?.remove(); };
  }, [rows, all, type, timeframe, averages, appearance, gain, loss, language, large, item.changePct]);
  if (!rows.length) return <Empty compact icon={ChartNoAxesCombined} title={t("暂无可用图表数据", "No usable chart history")} description={t("不会用模拟价格或缺失的 OHLC 补齐图表。", "Missing prices and OHLC values are never fabricated.")} />;
  return <div className="price-chart-wrap">
    <div className="chart-legend"><span>{t("开", "O")} <b>{number(row?.open)}</b></span><span>{t("高", "H")} <b>{number(row?.high)}</b></span><span>{t("低", "L")} <b>{number(row?.low)}</b></span><span>{t("收", "C")} <b>{number(row?.close)}</b></span><span>{t("量", "Vol")} <b>{compact(row?.volume)}</b></span>{averages && timeframe === "daily" && <><span className="ma20">● MA20</span><span className="ma60">● MA60</span></>}</div>
    {error && <p role="alert" className="form-error">{t("图表暂不可用：", "Chart unavailable: ")}{error}</p>}<div ref={host} className="chart-canvas" style={{ "--chart-h": `${large ? 490 : 305}px` }} aria-label={t(`${item.symbol} 价格与成交量图`, `${item.symbol} price and volume chart`)} />
    <div className="chart-foot"><span>{rows.length} {t("个有效样本", "valid bars")} · {timeframe === "daily" ? t("日线", "Daily") : "5 min"} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span><span>{t("可缩放与拖动 · 历史数据非预测", "Scroll to zoom · historical data, not a forecast")}</span></div>
  </div>;
}

export function Indicators({ item, timeframe }) {
  const { t, number, date } = useWorkspace();
  const ind = item.indicators || {};
  const fields = [
    ["MA20", ind.sma20, item.currency, t("最近 20 个完整交易日收盘价的均值。", "Mean close of 20 completed sessions.")],
    ["MA60", ind.sma60, item.currency, t("最近 60 个完整交易日收盘价的均值。", "Mean close of 60 completed sessions.")],
    ["RSI (14)", ind.rsi14, "/ 100", t("14 期相对强弱指标，不等于上涨概率。", "14-period relative strength; not a probability.")],
    ["MACD", ind.macd, "", t("日线 MACD，缺少样本时不显示数值。", "Daily MACD; unavailable without sufficient history.")],
    [t("支撑 · 20D", "Support · 20D"), ind.support20d, item.currency, t("历史价格观察位，并非保证有效的买入价。", "Historical level, not a guaranteed entry price.")],
    [t("阻力 · 20D", "Resistance · 20D"), ind.resistance20d, item.currency, t("历史价格观察位，并非收益目标。", "Historical level, not a return target.")],
    [t("年化波动率", "Annualized volatility"), ind.annualizedVolatilityPct, "%", t("由历史日收益率计算。", "Calculated from historical daily returns.")],
    [t("最大回撤 · 60D", "Max drawdown · 60D"), ind.maxDrawdown60dPct, "%", t("最近 60 个交易日峰值到低点的最大跌幅。", "Largest peak-to-trough decline over 60 sessions.")],
  ];
  return <div><div className="indicator-grid">{fields.map(([label, value, unit, tip]) => <div className="indicator" key={label}><span className="metric-label">{label}<Help>{tip}</Help></span><strong className="tabular">{number(value)} <small>{unit || ""}</small></strong></div>)}</div><div className="detail-note"><Clock3 size={13} />{t("以上为日线指标", "Daily indicators above")} · {t("样本", "Samples")}: {ind.sampleCount ?? "—"} · {date(ind.asOf || ind.completedSessionAt || item.historyMetadata?.lastCompletedAt)}<span>{timeframe === "intraday" ? t("同刻量比", "Same-time volume ratio") : t("日线量比", "Daily volume ratio")}: {number(timeframe === "intraday" ? item.intraday?.volumeRatioSameTime?.value : ind.volumeRatio20d)}×</span></div></div>;
}
export function QualityDetails({ item }) {
  const { t, number, date, local, report, clock } = useWorkspace();
  const usable = item.signalEligible === true && item.freshness?.signalEligible !== false && item.freshness?.triggersAllowed !== false && item.dataQuality?.triggersAllowed !== false && !["stale", "error", "unverified"].includes(quoteStatus(item, { demo: report.demo, now: clock })) && crossStatus(item) !== "conflict";
  const fields = [
    [t("报价时间", "Quote timestamp"), date(item.asOf)],
    [t("数据来源", "Sources"), item.dataSources?.map((s) => s.provider).join(" + ") || item.provider || item.source || "—"],
    [t("交叉价格偏差", "Price disagreement"), `${number(item.crossCheck?.priceDifferencePct ?? item.crossCheck?.spreadPct)}%`],
    [t("来源时间差", "Source time skew"), `${number(item.crossCheck?.timestampSkewSeconds ?? item.crossCheck?.timeDifferenceSeconds, 0)}s`],
    [t("数据使用状态", "Data eligibility"), usable ? t("符合工具数据门槛，非交易许可", "Meets tool data gates; not trade approval") : t("暂停新增可执行判断", "New actionable conclusions withheld")],
    [t("交易所时区", "Exchange timezone"), item.exchangeTimezone || "—"],
  ];
  return <div className="quality-details"><Flex gap="2" mb="4"><Status item={item} /><Status item={item} cross /></Flex><dl className="definition-grid">{fields.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>{item.error && <p role="alert" className="form-error">{typeof item.error === "string" ? item.error : item.error.message}</p>}{(item.dataQuality?.warnings || []).map((w, i) => <p className="source-warning" key={i}>{local(w)}</p>)}</div>;
}
export function StockDetail({ item }) {
  const { t, local, number, date, timeframe, setTimeframe, openEditor, language } = useWorkspace();
  const [type, setType] = useState("candles");
  const [range, setRange] = useState("90");
  const [averages, setAverages] = useState(true);
  const [expanded, setExpanded] = useState(false);
  if (!item) return <section className="surface chart-surface"><Empty icon={CandlestickChart} title={t("从自选列表开始", "Your research starts here")} description={t("添加标的后，行情、历史图表与来源证据将在这里呈现。", "Add a security to see quotes, historical charts and source evidence.")} action={<Button onClick={() => openEditor({ type: "settings" })}>{t("管理自选股", "Manage watchlist")}</Button>} /></section>;
  const chart = (large) => <PriceChart item={item} timeframe={timeframe} type={type} range={range} averages={averages} large={large} />;
  return <section className="surface chart-surface">
    <div className="stock-heading"><div className="stock-identity"><StockMark symbol={item.symbol} market={item.market} name={item.nameZh || item.name} /><div><h2>{local(item) || item.symbol}</h2><div className="muted small">{item.symbol} <span className="dot-separator">·</span> {item.exchange || item.market} <span className="dot-separator">·</span> {language === "en" ? item.sectorEn || item.sector : item.sectorZh || item.sector}</div></div></div><div className="quote-price"><div><strong className="tabular">{number(item.price)}</strong><span className="muted small">{item.currency}</span></div><Change value={item.changePct} arrows /></div></div>
    <div className="stock-meta"><Status item={item} /><Status item={item} cross /><span className="muted small">{t("报价", "As of")} {date(item.asOf)}</span></div>
    <div className="chart-toolbar"><Flex gap="2" align="center" wrap="wrap"><SegmentedControl.Root size="1" value={timeframe} onValueChange={setTimeframe}><SegmentedControl.Item value="daily">{t("日线", "Daily")}</SegmentedControl.Item><SegmentedControl.Item value="intraday">{t("分时 · 5m", "Intraday · 5m")}</SegmentedControl.Item></SegmentedControl.Root><SegmentedControl.Root size="1" value={range} onValueChange={setRange} aria-label={t("图表样本范围", "Chart bar range")}>{["30", "90", "180", "all"].map((r) => <SegmentedControl.Item key={r} value={r}>{r === "all" ? t("全部", "All") : `${r}${timeframe === "daily" ? "D" : t("根", " bars")}`}</SegmentedControl.Item>)}</SegmentedControl.Root></Flex><Flex gap="2" align="center"><label className="small checkbox-label"><Checkbox size="1" checked={averages} onCheckedChange={(v) => setAverages(v === true)} disabled={timeframe !== "daily"} />MA</label><Tooltip content={type === "candles" ? t("切换面积图", "Switch to area chart") : t("切换 K 线", "Switch to candlesticks")}><IconButton variant="ghost" color="gray" size="1" aria-label={t("切换图表类型", "Toggle chart type")} onClick={() => setType(type === "candles" ? "line" : "candles")}>{type === "candles" ? <ChartNoAxesCombined size={16} /> : <CandlestickChart size={16} />}</IconButton></Tooltip><IconButton variant="ghost" color="gray" size="1" aria-label={t("放大图表", "Expand chart")} onClick={() => setExpanded(true)}><Expand size={16} /></IconButton><FullscreenButton /></Flex></div>
    {chart(false)}
    <Tabs.Root defaultValue="indicators" className="stock-tabs"><Tabs.List><Tabs.Trigger value="indicators"><Activity size={14} />{t("技术指标", "Indicators")}</Tabs.Trigger><Tabs.Trigger value="quality"><ShieldCheck size={14} />{t("数据核验", "Data quality")}</Tabs.Trigger><Tabs.Trigger value="evidence">{t("相关证据", "Evidence")}</Tabs.Trigger></Tabs.List><Tabs.Content value="indicators"><Indicators item={item} timeframe={timeframe} /></Tabs.Content><Tabs.Content value="quality"><QualityDetails item={item} /></Tabs.Content><Tabs.Content value="evidence"><EvidenceList symbol={item.symbol} compact /></Tabs.Content></Tabs.Root>
    <Dialog.Root open={expanded} onOpenChange={setExpanded}><Dialog.Content maxWidth="1200px"><Dialog.Title>{local(item)} · {item.symbol}</Dialog.Title><Dialog.Description size="2" color="gray">{t("历史价格与成交量，非价格预测。", "Historical prices and volume, not a price forecast.")}</Dialog.Description><Dialog.Close><IconButton className="dialog-close" variant="ghost" color="gray" aria-label={t("关闭", "Close")}><X size={18} /></IconButton></Dialog.Close>{expanded && chart(true)}</Dialog.Content></Dialog.Root>
  </section>;
}
