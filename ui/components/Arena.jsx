import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Callout, Dialog, IconButton, SegmentedControl, Select, Table, Tabs, TextArea, TextField, Tooltip } from "@radix-ui/themes";
import {
  Activity, ArrowLeft, Clock3, Bell, Bot, Check, ChevronRight, CircleAlert, ClipboardCopy, Cpu, Crown, FileText, FlaskConical, History, Layers,
  LineChart, ListChecks, Newspaper, NotebookPen, Plug, Plus, RefreshCw, ScrollText, Send, Settings2, ShieldAlert, Trophy, Users, Wallet, X,
} from "lucide-react";
import { createChart, ColorType, LineSeries, AreaSeries } from "lightweight-charts";
import { useWorkspace } from "../context.jsx";
import { api, isNumber } from "../data.mjs";
import { roundPrompt } from "../../mcp/prompts.mjs";
export { roundPrompt };
import { Empty, ErrorNotice, SectionHeading } from "./Primitives.jsx";
import { AutomationPanel, ServiceChip } from "./Automation.jsx";

// Distinct, colour-blind-friendly series colours for overlaying many agents.
const SERIES = ["#2563eb", "#e8590c", "#0d9488", "#9333ea", "#ca8a04", "#db2777", "#4b5563", "#16a34a", "#0891b2", "#b45309"];
const MARKETS = [
  { id: "A", zh: "A 股", en: "China A", currency: "CNY" },
  { id: "HK", zh: "港股", en: "Hong Kong", currency: "HKD" },
  { id: "US", zh: "美股", en: "US", currency: "USD" },
];

export function agentKind(account) {
  const text = `${account.agent?.label ?? ""} ${account.agent?.client ?? ""}`.toLowerCase();
  if (text.includes("claude")) return { key: "claude", label: "Claude Code", mark: "C" };
  if (text.includes("codex") || text.includes("openai")) return { key: "codex", label: "Codex", mark: "X" };
  if (text.includes("workbuddy") || text.includes("codebuddy")) return { key: "workbuddy", label: "WorkBuddy", mark: "W" };
  if (text.includes("cursor")) return { key: "cursor", label: "Cursor", mark: "Cu" };
  const label = account.agent?.label || account.agent?.client || "Agent";
  return { key: "other", label, mark: label.slice(0, 1).toUpperCase() };
}

export function AgentMark({ account, size = "md" }) {
  const kind = agentKind(account);
  return <span className={`agent-mark agent-${kind.key} ${size}`} aria-hidden="true">{kind.mark}</span>;
}

export function Signed({ value, digits = 2, suffix = "%" }) {
  const { number } = useWorkspace();
  if (!isNumber(value)) return <span className="neutral">—</span>;
  return <span className={`tabular ${value > 0 ? "gain" : value < 0 ? "loss" : "neutral"}`}>{value > 0 ? "+" : ""}{number(value, digits)}{suffix}</span>;
}

export function relativeTime(value, t) {
  if (!value) return "—";
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60000);
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 1) return t("刚刚", "just now");
  if (minutes < 60) return t(`${minutes} 分钟前`, `${minutes}m ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t(`${hours} 小时前`, `${hours}h ago`);
  return t(`${Math.round(hours / 24)} 天前`, `${Math.round(hours / 24)}d ago`);
}

// Run-health and risk flags shown wherever an account appears.
export function HealthBadges({ account }) {
  const { t, date } = useWorkspace();
  const health = account.health;
  return <>
    {health?.status === "missed" && <Tooltip content={t(`最近一轮：${health.lastRoundAt ? date(health.lastRoundAt) : "从未运行"}；漏跑：${health.missedDates?.join("、")}`, `Last round: ${health.lastRoundAt ? date(health.lastRoundAt) : "never"}; missed: ${health.missedDates?.join(", ")}`)}><Badge color="amber" variant="soft" className="health-badge"><CircleAlert size={11} />{t(`漏跑 ${health.missedTradingDays} 天`, `Missed ${health.missedTradingDays}d`)}</Badge></Tooltip>}
    {account.risk?.breaker && <Tooltip content={t(`回撤 ${account.risk.breaker.drawdownPct}% 触发熔断，禁止新买入，需在设置中复位`, `Drawdown ${account.risk.breaker.drawdownPct}% tripped the breaker; buys blocked until reset in Settings`)}><Badge color="red" variant="soft" className="health-badge"><ShieldAlert size={11} />{t("熔断", "Breaker")}</Badge></Tooltip>}
  </>;
}

export function MatcherChip({ matcher }) {
  const { t, date } = useWorkspace();
  if (!matcher) return null;
  const state = matcher.state;
  const color = state === "running" ? "jade" : state === "stale" ? "amber" : "gray";
  const label = state === "running" ? t("自动撮合运行中", "Auto-matching on") : state === "stale" ? t("自动撮合中断", "Matcher stalled") : t("自动撮合未运行", "Matcher off");
  const detail = [
    matcher.lastTickAt ? t(`最近检查 ${date(matcher.lastTickAt)}`, `Last check ${date(matcher.lastTickAt)}`) : null,
    matcher.lastRunAt ? t(`最近撮合 ${date(matcher.lastRunAt)}`, `Last match ${date(matcher.lastRunAt)}`) : null,
    matcher.totals ? t(`累计成交 ${matcher.totals.fills} · 止盈止损 ${matcher.totals.exits} · 日报 ${matcher.totals.digests}`, `Fills ${matcher.totals.fills} · exits ${matcher.totals.exits} · digests ${matcher.totals.digests}`) : null,
    matcher.lastError ? t(`最近错误：${matcher.lastError}`, `Last error: ${matcher.lastError}`) : null,
    t("在任一 MCP 或面板进程运行期间，每 1–2 分钟于交易时段内撮合挂单。", "Runs inside any MCP or dashboard process, matching every 1–2 minutes during sessions."),
  ].filter(Boolean).join(" · ");
  return <Tooltip content={detail}><Badge color={color} variant="soft" size="2" className="matcher-chip"><Cpu size={13} />{label}{matcher.local?.role === "leader" ? ` · ${t("本进程", "this process")}` : ""}</Badge></Tooltip>;
}

const WEBHOOK_FORMATS = [["generic", "通用 JSON", "Generic JSON"], ["wecom", "企业微信机器人", "WeChat Work bot"], ["feishu", "飞书机器人", "Feishu bot"]];

function WebhookDialog({ onClose, onSaved }) {
  const { t, preferences } = useWorkspace();
  const current = preferences?.digestWebhook;
  const [format, setFormat] = useState(current?.format ?? "generic");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    setSaving(true); setError("");
    try { onSaved(await api("/api/preferences", { digestWebhook: form.url.trim() ? { url: form.url.trim(), format, enabled: form.enabled === "on" } : null })); }
    catch (failure) { setError(failure.message); } finally { setSaving(false); }
  };
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <Dialog.Content maxWidth="560px" className="editor-dialog">
      <Dialog.Title>{t("日报推送", "Digest webhook")}</Dialog.Title>
      <Dialog.Description size="2" color="gray">{t("每次收盘后把日报 POST 到这个地址。可接企业微信 / 飞书机器人，或转发到邮件的通用 JSON 网关。留空即关闭。", "After each close the digest is POSTed here: a WeChat Work / Feishu bot, or any generic JSON bridge (e.g. to email). Leave empty to turn off.")}</Dialog.Description>
      <form onSubmit={submit}><div className="form-grid">
        <Field full label={t("Webhook 地址", "Webhook URL")}><TextField.Root name="url" type="url" defaultValue={current?.url ?? ""} placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" /></Field>
        <Field label={t("格式", "Format")}><Select.Root value={format} onValueChange={setFormat}><Select.Trigger variant="surface" /><Select.Content>{WEBHOOK_FORMATS.map(([id, zh, en]) => <Select.Item key={id} value={id}>{t(zh, en)}</Select.Item>)}</Select.Content></Select.Root></Field>
        <Field label={t("状态", "Status")}><label className="checkbox-label"><input type="checkbox" name="enabled" defaultChecked={current?.enabled !== false} />{t("启用推送", "Enabled")}</label></Field>
      </div>
      <ErrorNotice message={error} />
      <div className="dialog-actions"><Button type="button" variant="soft" color="gray" onClick={onClose}>{t("取消", "Cancel")}</Button><Button type="submit" loading={saving}>{t("保存", "Save")}</Button></div></form>
    </Dialog.Content>
  </Dialog.Root>;
}

// The end-of-day digest: one summary of every account, written by the matcher after each close.
export function DigestPanel({ compact = false }) {
  const { t, date, number, notify, reloadWorkspace } = useWorkspace();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");
  const [dialog, setDialog] = useState(false);
  const [index, setIndex] = useState(0);
  const load = useCallback(async (signal) => {
    try { const next = await api("/api/arena/digests?limit=14", undefined, signal); if (!signal?.aborted) setData(next); } catch { /* Optional panel. */ }
  }, []);
  useEffect(() => { const abort = new AbortController(); load(abort.signal); return () => abort.abort(); }, [load]);
  const run = async (send) => {
    setBusy(send ? "send" : "make");
    try {
      const digest = await api("/api/arena/digests", { send });
      setIndex(0); await load();
      notify(send ? (digest.delivery?.status === "delivered" ? t("日报已推送。", "Digest delivered.") : t(`推送失败：${digest.delivery?.error ?? "未知错误"}`, `Delivery failed: ${digest.delivery?.error ?? "unknown"}`)) : t("已生成最新日报。", "Digest generated."), send && digest.delivery?.status !== "delivered");
    } catch (failure) { notify(failure.message, true); } finally { setBusy(""); }
  };
  const digests = data?.digests ?? [];
  const digest = digests[index];
  const delivery = digest?.delivery;
  return <section className="surface digest-panel">
    <SectionHeading icon={Newspaper} title={t("收盘日报", "End-of-day digest")} caption={digest ? `${digest.title} · ${date(digest.at)}` : null} actions={!compact && <div className="digest-actions">
      {digests.length > 1 && <Select.Root value={String(index)} onValueChange={(value) => setIndex(Number(value))}><Select.Trigger variant="surface" aria-label={t("历史日报", "Earlier digests")} /><Select.Content>{digests.map((entry, position) => <Select.Item key={entry.id} value={String(position)}>{entry.date} · {entry.market ?? t("手动", "manual")}</Select.Item>)}</Select.Content></Select.Root>}
      <Button size="1" variant="soft" color="gray" loading={busy === "make"} onClick={() => run(false)}><RefreshCw size={13} />{t("立即生成", "Generate now")}</Button>
      {data?.webhook && !data.demo && <Button size="1" variant="soft" loading={busy === "send"} onClick={() => run(true)}><Send size={13} />{t("生成并推送", "Generate & send")}</Button>}
      <Button size="1" variant="soft" color="gray" onClick={() => setDialog(true)} disabled={data?.demo}><Bell size={13} />{data?.webhook ? t(`推送：${data.webhook.host}`, `Push: ${data.webhook.host}`) : t("设置推送", "Set up push")}</Button>
    </div>} />
    {digest ? <div className="digest-body">
      <p className="digest-headline"><strong>{digest.headline}</strong>{delivery && <Badge variant="soft" color={delivery.status === "delivered" ? "jade" : delivery.status === "failed" ? "red" : "gray"}>{delivery.status === "delivered" ? t("已推送", "Delivered") : delivery.status === "failed" ? t(`推送失败 ×${delivery.attempts ?? 1}`, `Failed ×${delivery.attempts ?? 1}`) : delivery.status}</Badge>}</p>
      <ul className="digest-accounts">{digest.accounts.slice(0, compact ? 3 : 20).map((row) => <li key={row.id}>
        <div className="digest-row-head"><strong>{row.name}</strong><span className="muted small">{row.market} · {row.model}</span><span className="spacer" /><span className="muted small">{t("当日", "Day")}</span> <Signed value={row.dayReturnPct} /><span className="muted small">{t("累计", "Total")}</span> <Signed value={row.totalReturnPct} /></div>
        {row.trades.length > 0 && <p className="muted small">{row.trades.slice(0, 4).map((trade) => `${trade.side === "BUY" ? t("买", "Buy") : t("卖", "Sell")} ${trade.name ?? trade.symbol} ${number(trade.quantity, 0)}@${trade.price}${trade.trigger ? ` (${trade.trigger})` : ""}`).join(" · ")}{row.trades.length > 4 ? " …" : ""}</p>}
        {row.latestReport && <p className="small">{t("报告", "Report")}：{row.latestReport.title}{!row.latestReport.today && <span className="muted">{t("（非当日）", " (earlier)")}</span>}</p>}
        {row.warnings.length > 0 && <ul className="digest-warnings">{row.warnings.slice(0, 4).map((warning, position) => <li key={position}><CircleAlert size={12} />{warning}</li>)}</ul>}
      </li>)}</ul>
    </div> : <Empty compact icon={Newspaper} title={t("还没有日报", "No digest yet")} description={t("每个市场收盘后，后台撮合器会自动汇总所有账户的收益、成交、报告与提醒。", "After each market close the background matcher summarizes every account's returns, fills, reports and warnings.")} />}
    {dialog && <WebhookDialog onClose={() => setDialog(false)} onSaved={async () => { setDialog(false); await load(); reloadWorkspace?.(); notify(t("推送设置已保存。", "Push settings saved.")); }} />}
  </section>;
}

function useCopy() {
  const [copied, setCopied] = useState("");
  const copy = async (key, text) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); window.setTimeout(() => setCopied(""), 1600); } catch { setCopied(""); }
  };
  return [copied, copy];
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function useChart(host, height, build, deps) {
  const { appearance, language } = useWorkspace();
  useEffect(() => {
    if (!host.current) return undefined;
    const dark = appearance === "dark";
    const chart = createChart(host.current, {
      width: host.current.clientWidth, height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: dark ? "#94a3b8" : "#64748b", fontSize: 12, fontFamily: "Inter, -apple-system, 'PingFang SC', sans-serif", attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: dark ? "#1f2a37" : "#eef2f6" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { vertLine: { color: dark ? "#475569" : "#cbd5e1", labelBackgroundColor: "#334155" }, horzLine: { color: dark ? "#475569" : "#cbd5e1", labelBackgroundColor: "#334155" } },
      localization: { locale: language },
      handleScroll: false, handleScale: false,
    });
    build(chart, dark);
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => { if (host.current?.clientWidth) chart.applyOptions({ width: host.current.clientWidth }); });
    observer.observe(host.current);
    return () => { observer.disconnect(); chart.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appearance, language, height, ...deps]);
}

// One point per second at most; lightweight-charts needs strictly increasing time.
function toSeries(points, valueOf) {
  const byTime = new Map();
  for (const point of points) {
    const time = Math.floor(Date.parse(point.at) / 1000);
    if (Number.isFinite(time) && isNumber(valueOf(point))) byTime.set(time, { time, value: valueOf(point) });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function ReturnsChart({ accounts, highlighted, onHover }) {
  const { t } = useWorkspace();
  const host = useRef(null);
  const key = accounts.map((account) => `${account.id}:${account.curve?.length}:${account.metrics.totalReturnPct}`).join("|");
  useChart(host, 300, (chart) => {
    accounts.forEach((account, index) => {
      const series = chart.addSeries(LineSeries, {
        color: SERIES[index % SERIES.length], lineWidth: highlighted && highlighted !== account.id ? 1 : 2.5,
        priceLineVisible: false, lastValueVisible: true, title: account.name.slice(0, 14),
        priceFormat: { type: "custom", formatter: (value) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%` },
      });
      series.applyOptions({ color: highlighted && highlighted !== account.id ? `${SERIES[index % SERIES.length]}55` : SERIES[index % SERIES.length] });
      series.setData(toSeries(account.curve ?? [], (point) => point.returnPct));
    });
  }, [key, highlighted]);
  if (!accounts.some((account) => (account.curve?.length ?? 0) > 1)) return <Empty compact icon={LineChart} title={t("等待第一条收益曲线", "Waiting for the first return curve")} description={t("Agent 下单并经过行情同步后，这里会叠加每个账户自开户以来的收益率。", "After agents trade and quotes sync, each account's return since inception is overlaid here.")} />;
  return <div className="arena-chart">
    <div ref={host} className="arena-chart-canvas" aria-label={t("各账户累计收益率对比", "Cumulative return by account")} />
    <div className="arena-legend">{accounts.map((account, index) => <button key={account.id} className={highlighted === account.id ? "active" : ""} onMouseEnter={() => onHover(account.id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(account.id)} onBlur={() => onHover(null)}><span style={{ background: SERIES[index % SERIES.length] }} />{account.name}<Signed value={account.metrics.totalReturnPct} /></button>)}</div>
  </div>;
}

export function EquityChart({ account }) {
  const { t, colorConvention, language } = useWorkspace();
  const host = useRef(null);
  const points = useMemo(() => [{ at: account.createdAt, equity: account.initialCash }, ...(account.equity ?? []), { at: new Date().toISOString(), equity: account.metrics.equity }], [account]);
  useChart(host, 260, (chart, dark) => {
    const up = account.metrics.equity >= account.initialCash;
    const [gain, loss] = colorConvention === "red-up" ? ["#dc2626", "#0d9488"] : ["#0d9488", "#dc2626"];
    const color = up ? gain : loss;
    const formatter = new Intl.NumberFormat(language, { maximumFractionDigits: 0 });
    const series = chart.addSeries(AreaSeries, {
      lineColor: color, topColor: `${color}33`, bottomColor: `${color}00`, lineWidth: 2, priceLineVisible: false,
      priceFormat: { type: "custom", minMove: 1, formatter: (value) => formatter.format(value) },
    });
    series.setData(toSeries(points, (point) => point.equity));
    series.createPriceLine({ price: account.initialCash, color: dark ? "#64748b" : "#94a3b8", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: t("初始资金", "Start") });
  }, [points.length, account.metrics.equity, colorConvention]);
  return <div ref={host} className="arena-chart-canvas" aria-label={t("账户净值曲线", "Account equity curve")} />;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

function SummaryCards({ group }) {
  const { t, number } = useWorkspace();
  const accounts = group?.accounts ?? [];
  const leader = accounts[0];
  const benchmark = accounts.find((account) => isNumber(account.metrics.benchmarkReturnPct));
  const trades = accounts.reduce((sum, account) => sum + account.metrics.trades, 0);
  const active = accounts.filter((account) => account.lastActivityAt && Date.now() - Date.parse(account.lastActivityAt) < 86400000).length;
  const beating = accounts.filter((account) => isNumber(account.metrics.excessReturnPct) && account.metrics.excessReturnPct > 0).length;
  return <div className="arena-kpis">
    <section className="surface arena-kpi"><span className="arena-kpi-label"><Users size={15} />{t("参赛账户", "Accounts")}</span><strong className="tabular">{accounts.length}</strong><p>{t(`${active} 个 24 小时内有动作`, `${active} active in the last 24h`)}</p></section>
    <section className="surface arena-kpi leader"><span className="arena-kpi-label"><Crown size={15} />{t("当前领先", "Leading")}</span>{leader ? <><strong className="arena-kpi-name">{leader.name}</strong><p><Signed value={leader.metrics.totalReturnPct} /> · {leader.model}</p></> : <><strong>—</strong><p>{t("暂无账户", "No accounts yet")}</p></>}</section>
    <section className="surface arena-kpi"><span className="arena-kpi-label"><Activity size={15} />{t("基准", "Benchmark")} · {benchmark?.benchmark?.name?.split(" / ")[0] ?? group?.market ?? "—"}</span><strong><Signed value={benchmark?.metrics.benchmarkReturnPct} /></strong><p>{t(`${beating}/${accounts.length} 个账户跑赢基准`, `${beating}/${accounts.length} beating the benchmark`)}</p></section>
    <section className="surface arena-kpi"><span className="arena-kpi-label"><ListChecks size={15} />{t("成交笔数", "Fills")}</span><strong className="tabular">{number(trades, 0)}</strong><p>{t("拒单", "Rejected")} {number(accounts.reduce((sum, account) => sum + account.metrics.ordersRejected, 0), 0)} · {t("挂单", "Open")} {number(accounts.reduce((sum, account) => sum + account.metrics.openOrders, 0), 0)}</p></section>
  </div>;
}

function Breakdown({ accounts }) {
  const { t, number } = useWorkspace();
  const [by, setBy] = useState("model");
  const rows = useMemo(() => {
    const groups = new Map();
    for (const account of accounts) {
      const key = by === "model" ? account.model : agentKind(account).label;
      const entry = groups.get(key) ?? { key, accounts: [], sample: account };
      entry.accounts.push(account);
      groups.set(key, entry);
    }
    return [...groups.values()].map((entry) => {
      const returns = entry.accounts.map((account) => account.metrics.totalReturnPct);
      return {
        ...entry, count: returns.length, average: returns.reduce((sum, value) => sum + value, 0) / returns.length,
        best: Math.max(...returns), drawdown: entry.accounts.reduce((sum, account) => sum + account.metrics.maxDrawdownPct, 0) / returns.length,
        trades: entry.accounts.reduce((sum, account) => sum + account.metrics.trades, 0),
      };
    }).sort((a, b) => b.average - a.average);
  }, [accounts, by]);
  const extent = Math.max(0.5, ...rows.map((row) => Math.abs(row.average)));
  return <section className="surface arena-breakdown">
    <SectionHeading icon={Layers} title={t("横向对比", "Compare")} actions={<SegmentedControl.Root size="1" value={by} onValueChange={setBy}><SegmentedControl.Item value="model">{t("按模型", "By model")}</SegmentedControl.Item><SegmentedControl.Item value="agent">{t("按 Agent", "By agent")}</SegmentedControl.Item></SegmentedControl.Root>} />
    {rows.length ? <ul className="breakdown-list">{rows.map((row) => <li key={row.key}>
      <div className="breakdown-head">{by === "agent" && <AgentMark account={row.sample} size="sm" />}<strong>{row.key}</strong><span className="muted small">{row.count} {t("个账户", row.count === 1 ? "account" : "accounts")}</span><span className="breakdown-value"><Signed value={row.average} /></span></div>
      <div className="breakdown-bar" aria-hidden="true"><span className="axis" /><span className={row.average >= 0 ? "bar positive" : "bar negative"} style={{ width: `${Math.abs(row.average) / extent * 50}%` }} /></div>
      <div className="breakdown-meta muted small"><span>{t("最佳", "Best")} <Signed value={row.best} /></span><span>{t("平均回撤", "Avg DD")} <Signed value={row.drawdown} /></span><span>{number(row.trades, 0)} {t("笔成交", "fills")}</span></div>
    </li>)}</ul> : <Empty compact icon={Layers} title={t("暂无可对比数据", "Nothing to compare yet")} />}
    <div className="panel-foot">{t("平均收益为各账户简单平均；样本少时差异可能只是运气。", "Simple average across accounts; with few samples, differences may be luck.")}</div>
  </section>;
}

function LeaderboardTable({ accounts, onOpen, highlighted, onHover }) {
  const { t, number } = useWorkspace();
  return <section className="surface">
    <SectionHeading icon={Trophy} title={t("排行榜", "Leaderboard")} caption={t("按累计收益排序 · 同市场同组别", "Ranked by total return · same market & group")} />
    <div className="table-scroll"><Table.Root size="2" className="arena-table">
      <Table.Header><Table.Row>
        <Table.ColumnHeaderCell>#</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>{t("账户 / Agent", "Account / agent")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>{t("模型", "Model")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell align="right">{t("累计收益", "Return")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell align="right">{t("今日", "Today")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell align="right">{t("超额", "vs bench")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell align="right">{t("最大回撤", "Max DD")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell align="right">Sharpe</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell align="right">{t("胜率", "Win rate")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell align="right">{t("成交 / 拒单", "Fills / rej.")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell align="right">{t("仓位", "Exposure")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell>{t("最近一轮", "Last round")}</Table.ColumnHeaderCell>
        <Table.ColumnHeaderCell />
      </Table.Row></Table.Header>
      <Table.Body>{accounts.map((account) => <Table.Row key={account.id} className={`arena-row ${highlighted === account.id ? "highlighted" : ""}`} onMouseEnter={() => onHover(account.id)} onMouseLeave={() => onHover(null)} onClick={() => onOpen(account.id)}>
        <Table.Cell><span className={`rank rank-${account.rank}`}>{account.rank}</span></Table.Cell>
        <Table.RowHeaderCell><button className="arena-identity" onClick={(event) => { event.stopPropagation(); onOpen(account.id); }}><AgentMark account={account} /><span><strong>{account.name}</strong><small>{agentKind(account).label}{account.status === "archived" ? ` · ${t("已归档", "archived")}` : ""}{account.demo ? ` · ${t("演示", "demo")}` : ""}</small><span className="health-badges"><HealthBadges account={account} /></span></span></button></Table.RowHeaderCell>
        <Table.Cell><code className="model-chip">{account.model}</code>{account.strategy.version > 1 && <small className="cell-subtitle">{t("策略", "Strategy")} v{account.strategy.version}</small>}</Table.Cell>
        <Table.Cell align="right"><strong><Signed value={account.metrics.totalReturnPct} /></strong><small className="cell-subtitle tabular">{number(account.metrics.equity, 0)} {account.currency}</small></Table.Cell>
        <Table.Cell align="right"><Signed value={account.metrics.todayReturnPct} /></Table.Cell>
        <Table.Cell align="right"><Signed value={account.metrics.excessReturnPct} /></Table.Cell>
        <Table.Cell align="right"><Signed value={account.metrics.maxDrawdownPct} /></Table.Cell>
        <Table.Cell align="right" className="tabular">{isNumber(account.metrics.sharpe) ? number(account.metrics.sharpe) : <Tooltip content={t("至少需要 5 个交易日", "Needs at least 5 trading days")}><span className="neutral">—</span></Tooltip>}</Table.Cell>
        <Table.Cell align="right" className="tabular">{isNumber(account.metrics.winRatePct) ? `${number(account.metrics.winRatePct, 0)}%` : "—"}<small className="cell-subtitle">{account.metrics.closedTrades} {t("笔平仓", "closed")}</small></Table.Cell>
        <Table.Cell align="right" className="tabular">{account.metrics.trades} / <span className={account.metrics.ordersRejected ? "warn" : ""}>{account.metrics.ordersRejected}</span></Table.Cell>
        <Table.Cell align="right" className="tabular">{number(account.metrics.exposurePct, 0)}%</Table.Cell>
        <Table.Cell className={account.health?.status === "missed" ? "warn" : "muted"}>{relativeTime(account.health?.lastRoundAt ?? account.lastActivityAt, t)}</Table.Cell>
        <Table.Cell><ChevronRight size={16} className="muted" /></Table.Cell>
      </Table.Row>)}</Table.Body>
    </Table.Root></div>
  </section>;
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function Field({ label, hint, children, full }) {
  const id = React.useId();
  return <div className={`form-field ${full ? "full" : ""}`}><label htmlFor={id}>{label}</label>{React.cloneElement(children, { id })}{hint && <small className="muted">{hint}</small>}</div>;
}

function CreateAccountDialog({ market, competition, onClose, onCreated }) {
  const { t } = useWorkspace();
  const [selectedMarket, setMarket] = useState(market === "all" ? "A" : market);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const config = MARKETS.find((entry) => entry.id === selectedMarket);
  const submit = async (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    setSaving(true); setError("");
    try {
      const account = await api("/api/arena/accounts", {
        name: form.name, model: form.model, market: selectedMarket, competition: form.competition || "default",
        agentLabel: form.agentLabel, strategySummary: form.strategySummary,
        ...(form.initialCash ? { initialCash: Number(form.initialCash) } : {}),
      });
      onCreated(account);
    } catch (failure) { setError(failure.message); } finally { setSaving(false); }
  };
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <Dialog.Content maxWidth="640px" className="editor-dialog">
      <Dialog.Title>{t("新建竞技场账户", "New arena account")}</Dialog.Title>
      <Dialog.Description size="2" color="gray">{t("在面板里预建账户后，把账户 ID 告诉 Agent；它第一次下单时会自动绑定到该 Agent。Agent 也可以自己调用 arena_register_account 开户。", "Pre-create an account and give its id to an agent; it binds to that agent on its first order. Agents can also open one themselves with arena_register_account.")}</Dialog.Description>
      <IconButton className="dialog-close" variant="ghost" color="gray" aria-label={t("关闭", "Close")} onClick={onClose}><X size={18} /></IconButton>
      <form onSubmit={submit}><fieldset className="editor-fieldset" disabled={saving}><div className="form-grid">
        <Field label={t("账户名称", "Name")}><TextField.Root name="name" required maxLength={60} placeholder={t("例如：Opus 动量轮动", "e.g. Opus momentum")} /></Field>
        <Field label={t("模型", "Model")} hint={t("填写 Agent 实际运行的模型", "The model the agent actually runs")}><TextField.Root name="model" required maxLength={80} placeholder="claude-opus-5-5" /></Field>
        <Field label={t("市场", "Market")}><select className="native-select" value={selectedMarket} onChange={(event) => setMarket(event.target.value)}>{MARKETS.map((entry) => <option key={entry.id} value={entry.id}>{t(entry.zh, entry.en)} · {entry.currency}</option>)}</select></Field>
        <Field label={t("Agent 名称", "Agent")}><TextField.Root name="agentLabel" maxLength={60} placeholder="Claude Code / Codex / WorkBuddy" /></Field>
        <Field label={t("初始资金", "Starting cash")} hint={t(`留空使用默认值，保证同组可比（${selectedMarket === "US" ? "100,000" : "1,000,000"} ${config.currency}）`, `Leave blank for the default so the group stays comparable (${selectedMarket === "US" ? "100,000" : "1,000,000"} ${config.currency})`)}><TextField.Root name="initialCash" type="number" min="1000" step="1000" /></Field>
        <Field label={t("比赛组别", "Competition")} hint={t("只有同市场、同组别的账户一起排名", "Only accounts in the same market and group are ranked together")}><TextField.Root name="competition" maxLength={40} defaultValue={competition === "all" ? "default" : competition} /></Field>
        <Field full label={t("策略说明", "Strategy")} hint={t("Agent 会读取并遵循；之后可由 Agent 用 arena_update_strategy 升级版本", "The agent reads and follows it; it can publish new versions with arena_update_strategy")}><TextArea name="strategySummary" rows={4} maxLength={2000} placeholder={t("选股范围、入场/离场规则、仓位与风控上限…", "Universe, entry/exit rules, sizing and risk limits…")} /></Field>
      </div>
      <ErrorNotice message={error} />
      <div className="dialog-actions"><Button type="button" variant="soft" color="gray" onClick={onClose}>{t("取消", "Cancel")}</Button><Button type="submit" loading={saving}><Plus size={16} />{t("创建账户", "Create account")}</Button></div>
      </fieldset></form>
    </Dialog.Content>
  </Dialog.Root>;
}


export function ConnectDialog({ account, market, onClose }) {
  const { t, language } = useWorkspace();
  const [copied, copy] = useCopy();
  const prompt = roundPrompt({ account, market, language });
  const agents = [
    { id: "claude", name: "Claude Code", steps: [
      [t("安装插件", "Install the plugin"), "claude plugin marketplace add honestTai/hrouter-market-pulse\nclaude plugin install hrouter-market-pulse@hrouter-market-pulse"],
      [t("定时运行（可选）", "Schedule (optional)"), t("在 Claude Code 中使用 /schedule，或在桌面端的「定时任务」里粘贴下方提示词。", "Use /schedule in Claude Code, or paste the prompt below into a desktop scheduled task.")],
    ] },
    { id: "codex", name: "Codex", steps: [
      [t("安装插件", "Install the plugin"), "git clone https://github.com/honestTai/hrouter-market-pulse\ncd hrouter-market-pulse && node scripts/install.mjs"],
      [t("定时运行（可选）", "Schedule (optional)"), t("在 Codex 的「自动化」中新建任务，选择 Hrouter Market Pulse 并粘贴下方提示词。", "Create a Codex automation with Hrouter Market Pulse and paste the prompt below.")],
    ] },
    { id: "workbuddy", name: "WorkBuddy", steps: [
      [t("添加插件市场", "Add the marketplace"), t("设置 → 插件 → 添加插件市场：", "Settings → Plugins → Add marketplace:") + "\nhttps://github.com/honestTai/hrouter-market-pulse"],
      [t("或仅接入 MCP", "Or MCP only"), "npm run connect -- workbuddy"],
    ] },
    { id: "other", name: t("其他 MCP", "Other MCP"), steps: [
      [t("打印配置", "Print config"), "npm run connect -- cursor"],
      [t("区分同一客户端的多个模型", "Separate models in one client"), t("给每个配置设置不同的 HROUTER_AGENT_ID 环境变量。", "Give each configuration its own HROUTER_AGENT_ID environment variable.")],
    ] },
  ];
  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Content maxWidth="720px" className="editor-dialog">
      <Dialog.Title>{t("让 Agent 加入竞技场", "Bring an agent into the arena")}</Dialog.Title>
      <Dialog.Description size="2" color="gray">{t("同一个插件同时支持 Claude Code、Codex 与 WorkBuddy；所有 Agent 写入同一个本地竞技场，在这里统一排名。", "One plugin serves Claude Code, Codex and WorkBuddy; every agent writes to the same local arena and is ranked here.")}</Dialog.Description>
      <IconButton className="dialog-close" variant="ghost" color="gray" aria-label={t("关闭", "Close")} onClick={onClose}><X size={18} /></IconButton>
      <Tabs.Root defaultValue="claude" className="connect-tabs">
        <Tabs.List>{agents.map((agent) => <Tabs.Trigger key={agent.id} value={agent.id}>{agent.name}</Tabs.Trigger>)}</Tabs.List>
        {agents.map((agent) => <Tabs.Content key={agent.id} value={agent.id}><ol className="connect-steps">{agent.steps.map(([title, body], index) => <li key={title}><span className="step-number">{index + 1}</span><div><strong>{title}</strong>{body.includes("\n") || body.startsWith("npm") || body.startsWith("claude") || body.startsWith("git") ? <pre className="code-block">{body}<button type="button" onClick={() => copy(`${agent.id}${index}`, body.replace(/^.*：\n|^.*:\n/, ""))} aria-label={t("复制", "Copy")}>{copied === `${agent.id}${index}` ? <Check size={14} /> : <ClipboardCopy size={14} />}</button></pre> : <p>{body}</p>}</div></li>)}</ol></Tabs.Content>)}
      </Tabs.Root>
      <div className="prompt-card">
        <div className="prompt-card-head"><strong><NotebookPen size={15} />{t("全托管提示词（每轮 / 定时任务）", "Autopilot prompt (each round / schedule)")}</strong><Button size="1" variant="soft" onClick={() => copy("prompt", prompt)}>{copied === "prompt" ? <Check size={14} /> : <ClipboardCopy size={14} />}{copied === "prompt" ? t("已复制", "Copied") : t("复制", "Copy")}</Button></div>
        <pre>{prompt}</pre>
        <p className="muted small">{t("对比不同模型时，给每个 Agent 相同的提示词、相同的市场和初始资金，只改变模型或策略。", "To compare models fairly, give every agent the same prompt, market and starting cash; change only the model or strategy.")}</p>
      </div>
    </Dialog.Content>
  </Dialog.Root>;
}

// ---------------------------------------------------------------------------
// Account detail
// ---------------------------------------------------------------------------

const SENTIMENT = { bullish: ["看多", "Bullish", "red"], neutral: ["中性", "Neutral", "gray"], bearish: ["看空", "Bearish", "jade"], defensive: ["防守", "Defensive", "amber"] };
const ACTION = { buy: ["买入", "Buy"], sell: ["卖出", "Sell"], hold: ["持有", "Hold"], watch: ["观察", "Watch"], cancel: ["撤单", "Cancel"] };

export function ReportCard({ report, featured = false }) {
  const { t, date } = useWorkspace();
  const sentiment = SENTIMENT[report.sentiment];
  return <article className={`report-card ${featured ? "featured" : ""}`}>
    <header>
      <div><h3>{report.title}</h3><span className="muted small">{date(report.at)}{report.strategyVersion ? ` · v${report.strategyVersion}` : ""}{report.snapshot ? <> · {t("当时收益", "Return then")} <Signed value={report.snapshot.returnPct} /></> : null}</span></div>
      {sentiment && <Badge variant="soft" color={sentiment[2]}>{t(sentiment[0], sentiment[1])}</Badge>}
    </header>
    <p className="report-summary">{report.summary}</p>
    {(report.marketView || report.actions?.length || report.picks?.length || report.risks || report.nextSteps) && <div className="report-sections">
      {report.marketView && <section><h4>{t("市场判断", "Market view")}</h4><p>{report.marketView}</p></section>}
      {report.actions?.length > 0 && <section><h4>{t("本轮操作", "Actions")}</h4><ul>{report.actions.map((entry, index) => <li key={index}><span className={`action-tag action-${entry.action}`}>{t(...(ACTION[entry.action] ?? [entry.action, entry.action]))}</span><strong>{entry.symbol}</strong> {entry.detail}</li>)}</ul></section>}
      {report.picks?.length > 0 && <section><h4>{t("看好标的", "Picks")}</h4><ul>{report.picks.map((entry, index) => <li key={index}><strong>{entry.symbol}</strong> {entry.thesis}</li>)}</ul></section>}
      {report.risks && <section><h4>{t("风险", "Risks")}</h4><p>{report.risks}</p></section>}
      {report.nextSteps && <section><h4>{t("下一步", "Next")}</h4><p>{report.nextSteps}</p></section>}
    </div>}
    {report.body && <details className="report-body"><summary>{t("完整分析", "Full analysis")}</summary><pre>{report.body}</pre></details>}
  </article>;
}

const ORDER_STATUS = {
  filled: ["已成交", "Filled", "jade"], open: ["挂单中", "Open", "blue"], rejected: ["已拒绝", "Rejected", "red"],
  cancelled: ["已撤销", "Cancelled", "gray"], expired: ["已过期", "Expired", "gray"],
};
const JOURNAL_KIND = { analysis: ["分析", "Analysis"], "no-trade": ["不交易", "No trade"], risk: ["风控", "Risk"], review: ["复盘", "Review"], note: ["备注", "Note"] };

function MetricTile({ label, children, hint }) {
  return <div className="metric-tile"><span className="metric-label">{label}</span><strong>{children}</strong>{hint && <small className="muted">{hint}</small>}</div>;
}

const EVENT_KIND = {
  "stop-loss": ["止损", "Stop-loss", "red"], "take-profit": ["止盈", "Take-profit", "jade"], "exit-deferred": ["离场等待", "Exit deferred", "amber"],
  dividend: ["派息", "Dividend", "jade"], split: ["拆股", "Split", "blue"], bonus: ["送转", "Bonus shares", "blue"], suspended: ["停牌", "Suspended", "amber"],
  "risk-breaker": ["熔断", "Breaker", "red"], "risk-reset": ["熔断复位", "Breaker reset", "gray"], "risk-policy": ["风控规则", "Risk policy", "gray"],
  "exits-set": ["止盈止损", "Exits", "gray"], "corporate-action-skipped": ["公司行动", "Corporate action", "amber"],
};

function RiskPolicyForm({ account, onSaved }) {
  const { t, number } = useWorkspace();
  const policy = account.riskPolicy ?? {};
  const [onBreach, setOnBreach] = useState(policy.onBreach ?? "block");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const save = async (body, label) => {
    setBusy(label); setError("");
    try { onSaved(await api(`/api/arena/accounts/${account.id}`, body)); } catch (failure) { setError(failure.message); } finally { setBusy(""); }
  };
  const submit = (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    const value = (key) => (form[key] === "" ? null : Number(form[key]));
    save({ riskPolicy: { maxPositionPct: value("maxPositionPct"), maxExposurePct: value("maxExposurePct"), maxDrawdownPct: value("maxDrawdownPct"), onBreach, reduceToExposurePct: value("reduceToExposurePct") }, maxVolumePct: Number(form.maxVolumePct) }, "policy");
  };
  const risk = account.risk;
  return <form onSubmit={submit} className="risk-policy"><fieldset className="editor-fieldset" disabled={Boolean(busy) || account.demo}>
    <h4><ShieldAlert size={15} />{t("主人风控规则", "Owner risk policy")}</h4>
    <p className="muted small">{t("只能在面板修改；Agent 可以读取但不能更改。触发后拒绝新的买入。", "Editable only here; agents can read but not change it. Breaches reject new buys.")} {t("当前回撤", "Drawdown now")} <Signed value={risk?.drawdownPct} /> · {t("峰值", "peak")} {number(risk?.peakEquity)}</p>
    {risk?.breaker && <Callout.Root color="red" size="1"><Callout.Icon><ShieldAlert size={16} /></Callout.Icon><Callout.Text>{t(`回撤熔断于 ${risk.breaker.trippedAt.slice(0, 16).replace("T", " ")} 触发（${risk.breaker.drawdownPct}%），新的买入全部被拒。`, `Drawdown breaker tripped ${risk.breaker.trippedAt.slice(0, 16).replace("T", " ")} at ${risk.breaker.drawdownPct}%; all new buys are rejected.`)} <Button type="button" size="1" variant="soft" color="red" loading={busy === "reset"} onClick={() => save({ resetBreaker: true }, "reset")}>{t("复位熔断", "Reset breaker")}</Button></Callout.Text></Callout.Root>}
    <div className="form-grid">
      <Field label={t("单票上限 %", "Max single position %")} hint={t("留空不限制", "Empty = no limit")}><TextField.Root name="maxPositionPct" type="number" min="1" max="100" step="0.5" defaultValue={policy.maxPositionPct ?? ""} /></Field>
      <Field label={t("总仓位上限 %", "Max total exposure %")} hint={t("留空不限制", "Empty = no limit")}><TextField.Root name="maxExposurePct" type="number" min="1" max="100" step="0.5" defaultValue={policy.maxExposurePct ?? ""} /></Field>
      <Field label={t("回撤熔断 %", "Drawdown breaker %")} hint={t("从峰值回撤超过该值即触发", "Trips when equity falls this far from its peak")}><TextField.Root name="maxDrawdownPct" type="number" min="1" max="90" step="0.5" defaultValue={policy.maxDrawdownPct ?? ""} /></Field>
      <Field label={t("熔断后", "On breach")}><Select.Root value={onBreach} onValueChange={setOnBreach}><Select.Trigger variant="surface" /><Select.Content><Select.Item value="block">{t("只禁止买入", "Block buys only")}</Select.Item><Select.Item value="reduce">{t("禁止买入并减仓", "Block buys and reduce")}</Select.Item></Select.Content></Select.Root></Field>
      {onBreach === "reduce" && <Field label={t("减仓至仓位 %", "Reduce exposure to %")}><TextField.Root name="reduceToExposurePct" type="number" min="0" max="100" step="1" defaultValue={policy.reduceToExposurePct ?? 50} /></Field>}
      <Field label={t("单笔成交量上限 %", "Max share of day volume %")} hint={t("单个账户在某只股票当日成交量中的占比上限，超出部分分批成交或挂单", "Per-security cap on this account's share of the day's volume; the rest fills later or rests")}><TextField.Root name="maxVolumePct" type="number" min="0.1" max="100" step="0.1" defaultValue={account.settings?.maxVolumePct ?? 5} /></Field>
    </div>
    <ErrorNotice message={error} />
    <div className="dialog-actions start"><Button type="submit" loading={busy === "policy"}><ShieldAlert size={15} />{t("保存风控规则", "Save risk policy")}</Button></div>
  </fieldset></form>;
}

function AccountSettings({ account, onSaved }) {
  const { t, notify } = useWorkspace();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const save = async (body, label) => {
    setBusy(label); setError("");
    try { onSaved(await api(`/api/arena/accounts/${account.id}`, body)); notify(t("账户已更新。", "Account updated.")); }
    catch (failure) { setError(failure.message); } finally { setBusy(""); }
  };
  const submit = (event) => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget));
    let lotOverrides;
    try { lotOverrides = form.lotOverrides.trim() ? JSON.parse(form.lotOverrides) : {}; }
    catch { setError(t("每手股数需要是 JSON，例如 {\"0700.HK\": 100}", "Board lots must be JSON, e.g. {\"0700.HK\": 100}")); return; }
    save({ name: form.name, model: form.model, agentLabel: form.agentLabel, lotOverrides }, "save");
  };
  return <div className="account-settings">
    <RiskPolicyForm account={account} onSaved={(next) => { onSaved(next); notify(t("风控规则已更新。", "Risk policy updated.")); }} />
    <form onSubmit={submit}><fieldset className="editor-fieldset" disabled={Boolean(busy) || account.demo}><div className="form-grid">
      <Field label={t("账户名称", "Name")}><TextField.Root name="name" defaultValue={account.name} maxLength={60} /></Field>
      <Field label={t("模型", "Model")}><TextField.Root name="model" defaultValue={account.model} maxLength={80} /></Field>
      <Field label={t("Agent 名称", "Agent label")}><TextField.Root name="agentLabel" defaultValue={account.agent.label ?? ""} maxLength={60} /></Field>
      <Field label={t("绑定的客户端", "Bound client")} hint={t("只有该 MCP 客户端可以操作此账户", "Only this MCP client may trade this account")}><TextField.Root readOnly value={account.agent.client ?? t("未绑定（首次下单时绑定）", "Unbound (binds on first order)")} /></Field>
      {account.market === "HK" && <Field full label={t("港股每手股数覆盖（JSON）", "HK board-lot overrides (JSON)")} hint={t("默认读取腾讯行情的每手股数；仅在数据缺失时填写", "Lots come from Tencent quotes by default; override only when missing")}><TextArea name="lotOverrides" rows={2} defaultValue={JSON.stringify(account.lotOverrides ?? {})} /></Field>}
    </div>
    <ErrorNotice message={error} />
    <div className="dialog-actions start">
      <Button type="submit" loading={busy === "save"}><Settings2 size={15} />{t("保存", "Save")}</Button>
      {account.agent.client && <Button type="button" variant="soft" color="gray" loading={busy === "unbind"} onClick={() => save({ unbindAgent: true }, "unbind")}>{t("解除客户端绑定", "Unbind client")}</Button>}
      <span className="spacer" />
      {account.status === "active"
        ? <Button type="button" variant="soft" color="red" loading={busy === "archive"} onClick={() => { if (window.confirm(t("归档后将撤销全部挂单，Agent 不能再交易此账户。继续？", "Archiving cancels open orders and stops trading. Continue?"))) save({ status: "archived" }, "archive"); }}>{t("归档账户", "Archive")}</Button>
        : <Button type="button" variant="soft" loading={busy === "restore"} onClick={() => save({ status: "active" }, "restore")}>{t("恢复账户", "Restore")}</Button>}
    </div>
    </fieldset></form>
    {account.demo && <p className="muted small">{t("演示账户不可修改。", "Demo accounts are read-only.")}</p>}
  </div>;
}

function AccountDetail({ id, onBack, onChanged }) {
  const { t, number, date, notify } = useWorkspace();
  const [account, setAccount] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("positions");
  const [connect, setConnect] = useState(false);
  const load = useCallback(async (signal) => {
    try { const next = await api(`/api/arena/accounts/${id}`, undefined, signal); if (!signal?.aborted) { setAccount(next); setError(""); } }
    catch (failure) { if (!signal?.aborted) setError(failure.message); }
  }, [id]);
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal);
    const timer = window.setInterval(() => { if (!document.hidden) load(abort.signal); }, 30000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [load]);
  if (!account) return <div className="page-stack"><Button variant="ghost" color="gray" onClick={onBack} className="back-link"><ArrowLeft size={16} />{t("返回排行榜", "Back to leaderboard")}</Button><ErrorNotice message={error} onRetry={() => load()} />{!error && <section className="surface"><Empty compact icon={Bot} title={t("正在载入账户…", "Loading account…")} /></section>}</div>;
  const m = account.metrics;
  const kind = agentKind(account);
  return <div className="page-stack">
    <Button variant="ghost" color="gray" onClick={onBack} className="back-link"><ArrowLeft size={16} />{t("返回排行榜", "Back to leaderboard")}</Button>
    <section className="surface account-hero">
      <div className="account-identity"><AgentMark account={account} size="lg" /><div>
        <h2>{account.name}</h2>
        <div className="account-tags"><Badge variant="soft" color="gray">{kind.label}</Badge><code className="model-chip">{account.model}</code><Badge variant="soft" color="gray">{account.market} · {account.currency}</Badge><Badge variant="soft" color="gray">{t("组别", "Group")} {account.competition}</Badge>{account.status === "archived" && <Badge color="amber">{t("已归档", "Archived")}</Badge>}{account.demo && <Badge color="amber">{t("演示数据", "Demo")}</Badge>}<HealthBadges account={account} /></div>
        <p className="muted small">{account.id} · {t("开户", "Opened")} {date(account.createdAt)} · {t("已运行", "Running")} {m.tradingDays} {t("个交易日", "trading days")} · {t("最近一轮", "Last round")} {relativeTime(account.health?.lastRoundAt, t)}</p>
      </div></div>
      <div className="account-equity"><span className="muted">{t("账户净值", "Equity")}</span><strong className="tabular">{number(m.equity)}</strong><span><Signed value={m.totalReturnPct} /> · <Signed value={m.totalPnl} suffix={` ${account.currency}`} /></span><Button size="2" variant="soft" onClick={() => setConnect(true)}><Plug size={15} />{t("发给 Agent 的提示词", "Agent prompt")}</Button></div>
    </section>
    {account.alerts?.filter((alert) => alert.severity !== "info").map((alert) => <Callout.Root key={alert.type} color={alert.severity === "critical" ? "red" : "amber"} size="1"><Callout.Icon>{alert.type === "risk-breaker" ? <ShieldAlert size={16} /> : <CircleAlert size={16} />}</Callout.Icon><Callout.Text>{alert.type === "missed-run" ? t(`Agent 已漏跑 ${account.health.missedTradingDays} 个交易日（${account.health.missedDates.join("、")}）。检查 Agent 的定时任务是否仍在运行。`, `The agent missed ${account.health.missedTradingDays} trading day(s) (${account.health.missedDates.join(", ")}). Check its scheduled task is still running.`) : alert.type === "risk-breaker" ? t(`回撤熔断已触发（${account.risk.breaker.drawdownPct}%），新的买入被拒绝。到「设置」复位。`, `Drawdown breaker tripped (${account.risk.breaker.drawdownPct}%); new buys are rejected. Reset it under Settings.`) : alert.message}</Callout.Text></Callout.Root>)}
    {m.sampleWarning && <Callout.Root color="amber" size="1"><Callout.Icon><CircleAlert size={16} /></Callout.Icon><Callout.Text>{m.sampleWarning === "fewer-than-5-trading-days" ? t("运行不足 5 个交易日，夏普、波动率等指标暂不计算，收益排名参考意义有限。", "Under 5 trading days: Sharpe and volatility are withheld and rankings are not yet meaningful.") : t("平仓交易少于 10 笔，胜率与盈亏比的统计意义有限。", "Fewer than 10 closed trades: win rate and profit factor are not yet reliable.")}</Callout.Text></Callout.Root>}
    <div className="metric-grid">
      <MetricTile label={t("可用现金", "Available cash")} hint={m.availableCash !== m.cash ? t(`挂单冻结 ${number(m.cash - m.availableCash)}`, `${number(m.cash - m.availableCash)} reserved`) : null}>{number(m.availableCash)}</MetricTile>
      <MetricTile label={t("持仓市值 / 仓位", "Holdings / exposure")} hint={`${number(m.exposurePct, 1)}%`}>{number(m.marketValue)}</MetricTile>
      <MetricTile label={t("已实现 / 浮动盈亏", "Realized / unrealized")} hint={<Signed value={m.unrealizedPnl} suffix="" />}><Signed value={m.realizedPnl} suffix="" /></MetricTile>
      <MetricTile label={t("超额收益", "Excess return")} hint={`${t("基准", "Bench")} ${isNumber(m.benchmarkReturnPct) ? `${m.benchmarkReturnPct}%` : "—"}`}><Signed value={m.excessReturnPct} /></MetricTile>
      <MetricTile label={t("最大回撤", "Max drawdown")}><Signed value={m.maxDrawdownPct} /></MetricTile>
      <MetricTile label={t("夏普 / 年化波动", "Sharpe / volatility")} hint={isNumber(m.volatilityPct) ? `${m.volatilityPct}%` : t("样本不足", "insufficient")}>{isNumber(m.sharpe) ? number(m.sharpe) : "—"}</MetricTile>
      <MetricTile label={t("胜率 / 盈亏比", "Win rate / profit factor")} hint={`${m.closedTrades} ${t("笔平仓", "closed")}`}>{isNumber(m.winRatePct) ? `${number(m.winRatePct, 0)}%` : "—"} / {isNumber(m.profitFactor) ? number(m.profitFactor) : "—"}</MetricTile>
      <MetricTile label={t("手续费 / 换手", "Fees / turnover")} hint={`${number(m.turnover)}×`}>{number(m.feesPaid)}</MetricTile>
    </div>
    <section className="surface"><SectionHeading icon={LineChart} title={t("净值曲线", "Equity curve")} caption={t("虚线为初始资金", "Dashed line: starting cash")} /><div className="arena-chart"><EquityChart account={account} /></div></section>
    <section className="surface">
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="detail-tabs">
          <Tabs.Trigger value="positions"><Wallet size={14} />{t("持仓", "Positions")} <span className="tab-count">{account.positions.length}</span></Tabs.Trigger>
          <Tabs.Trigger value="orders"><ScrollText size={14} />{t("委托", "Orders")} <span className="tab-count">{m.openOrders || account.orders.length}</span></Tabs.Trigger>
          <Tabs.Trigger value="trades"><ListChecks size={14} />{t("成交", "Fills")} <span className="tab-count">{m.trades}</span></Tabs.Trigger>
          <Tabs.Trigger value="events"><Bell size={14} />{t("事件", "Events")} <span className="tab-count">{account.events?.length ?? 0}</span></Tabs.Trigger>
          <Tabs.Trigger value="reports"><FileText size={14} />{t("报告", "Reports")} <span className="tab-count">{m.reportsPublished ?? 0}</span></Tabs.Trigger>
          <Tabs.Trigger value="journal"><NotebookPen size={14} />{t("决策日志", "Journal")} <span className="tab-count">{m.decisionsLogged}</span></Tabs.Trigger>
          <Tabs.Trigger value="strategy"><History size={14} />{t("策略版本", "Strategy")} <span className="tab-count">v{account.strategy.version}</span></Tabs.Trigger>
          <Tabs.Trigger value="automation"><Clock3 size={14} />{t("自动运行", "Automation")}</Tabs.Trigger>
          <Tabs.Trigger value="settings"><Settings2 size={14} />{t("设置", "Settings")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="positions">{account.positions.length ? <div className="table-scroll"><Table.Root size="2">
          <Table.Header><Table.Row><Table.ColumnHeaderCell>{t("标的", "Security")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("数量", "Qty")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("成本", "Avg cost")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("现价", "Last")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("市值 / 权重", "Value / weight")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("浮动盈亏", "Unrealized")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("止损 / 止盈", "Stop / target")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("报价时间", "Priced at")}</Table.ColumnHeaderCell></Table.Row></Table.Header>
          <Table.Body>{account.positions.map((position) => <Table.Row key={position.symbol}><Table.RowHeaderCell><strong>{position.name}</strong><small className="cell-subtitle">{position.symbol}</small></Table.RowHeaderCell><Table.Cell align="right" className="tabular">{number(position.quantity, 0)}</Table.Cell><Table.Cell align="right" className="tabular">{number(position.averageCost, 3)}</Table.Cell><Table.Cell align="right" className="tabular">{number(position.lastPrice, 3)}</Table.Cell><Table.Cell align="right" className="tabular">{number(position.marketValue)}<small className="cell-subtitle">{number(position.weightPct, 1)}%</small></Table.Cell><Table.Cell align="right"><Signed value={position.unrealizedPnl} suffix="" /><small className="cell-subtitle"><Signed value={position.unrealizedPnlPct} /></small></Table.Cell><Table.Cell align="right" className="tabular">{position.exitLevels ? <><span className="loss">{isNumber(position.exitLevels.stopLoss) ? number(position.exitLevels.stopLoss, 3) : "—"}</span> / <span className="gain">{isNumber(position.exitLevels.takeProfit) ? number(position.exitLevels.takeProfit, 3) : "—"}</span></> : <span className="neutral">—</span>}</Table.Cell><Table.Cell className="muted">{date(position.lastPriceAt)}</Table.Cell></Table.Row>)}</Table.Body>
        </Table.Root></div> : <Empty compact icon={Wallet} title={t("空仓", "No positions")} description={t("当前全部为现金。", "The account is entirely in cash.")} />}</Tabs.Content>
        <Tabs.Content value="orders">{account.orders.length ? <div className="table-scroll"><Table.Root size="2">
          <Table.Header><Table.Row><Table.ColumnHeaderCell>{t("时间", "Time")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("标的", "Security")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("方向 / 类型", "Side / type")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("数量", "Qty")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("限价 / 成交价", "Limit / fill")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("状态", "Status")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("理由 / 拒绝原因", "Reason / rejection")}</Table.ColumnHeaderCell></Table.Row></Table.Header>
          <Table.Body>{account.orders.map((order) => { const [zh, en, color] = ORDER_STATUS[order.status] ?? [order.status, order.status, "gray"]; return <Table.Row key={order.id}><Table.Cell className="muted nowrap">{date(order.createdAt)}</Table.Cell><Table.Cell><strong>{order.name ?? order.symbol}</strong><small className="cell-subtitle">{order.symbol}</small></Table.Cell><Table.Cell><span className={order.side === "BUY" ? "side buy" : "side sell"}>{order.side === "BUY" ? t("买入", "Buy") : t("卖出", "Sell")}</span><small className="cell-subtitle">{order.type === "limit" ? t("限价", "Limit") : t("市价", "Market")} · {order.timeInForce?.toUpperCase()}{order.trigger ? ` · ${t(...(EVENT_KIND[order.trigger] ?? [order.trigger, order.trigger]).slice(0, 2))}` : ""}</small></Table.Cell><Table.Cell align="right" className="tabular">{order.filledQuantity && order.filledQuantity < order.quantity ? `${number(order.filledQuantity, 0)} / ` : ""}{number(order.quantity, 0)}{order.lastBlock && order.status === "open" && <small className="cell-subtitle">{order.lastBlock}</small>}</Table.Cell><Table.Cell align="right" className="tabular">{order.limitPrice ? number(order.limitPrice, 3) : "—"} / {order.fillPrice ? number(order.fillPrice, 3) : "—"}</Table.Cell><Table.Cell><Badge color={color} variant="soft">{t(zh, en)}</Badge></Table.Cell><Table.Cell className="reason-cell">{order.rejectReason ? <span className="loss">{order.rejectReason}</span> : order.reason}</Table.Cell></Table.Row>; })}</Table.Body>
        </Table.Root></div> : <Empty compact icon={ScrollText} title={t("还没有委托", "No orders yet")} />}</Tabs.Content>
        <Tabs.Content value="trades">{account.trades.length ? <div className="table-scroll"><Table.Root size="2">
          <Table.Header><Table.Row><Table.ColumnHeaderCell>{t("时间", "Time")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("标的", "Security")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("方向", "Side")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("数量 × 价格", "Qty × price")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("费用", "Fees")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("已实现盈亏", "Realized")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("理由", "Reason")}</Table.ColumnHeaderCell></Table.Row></Table.Header>
          <Table.Body>{account.trades.map((trade) => <Table.Row key={trade.id}><Table.Cell className="muted nowrap">{date(trade.at)}</Table.Cell><Table.Cell><strong>{trade.name}</strong><small className="cell-subtitle">{trade.symbol}</small></Table.Cell><Table.Cell><span className={trade.side === "BUY" ? "side buy" : "side sell"}>{trade.side === "BUY" ? t("买入", "Buy") : t("卖出", "Sell")}</span>{trade.strategyVersion > 1 && <small className="cell-subtitle">v{trade.strategyVersion}</small>}{trade.trigger && <small className="cell-subtitle">{t(...(EVENT_KIND[trade.trigger] ?? [trade.trigger, trade.trigger]).slice(0, 2))}</small>}</Table.Cell><Table.Cell align="right" className="tabular">{number(trade.quantity, 0)} × {number(trade.price, 3)}<small className="cell-subtitle">{number(trade.gross)}</small></Table.Cell><Table.Cell align="right" className="tabular"><Tooltip content={Object.entries(trade.feeBreakdown ?? {}).map(([key, value]) => `${key} ${value}`).join(" · ") || "—"}><span>{number(trade.fees)}</span></Tooltip></Table.Cell><Table.Cell align="right">{isNumber(trade.realizedPnl) ? <Signed value={trade.realizedPnl} suffix="" /> : <span className="neutral">—</span>}</Table.Cell><Table.Cell className="reason-cell">{trade.reason}{isNumber(trade.confidence) && <small className="cell-subtitle">{t("信心", "Confidence")} {Math.round(trade.confidence * 100)}%</small>}</Table.Cell></Table.Row>)}</Table.Body>
        </Table.Root></div> : <Empty compact icon={ListChecks} title={t("还没有成交", "No fills yet")} />}</Tabs.Content>
        <Tabs.Content value="events">{account.events?.length ? <ol className="journal-timeline">{account.events.map((event) => { const [zh, en, color] = EVENT_KIND[event.type] ?? [event.type, event.type, "gray"]; return <li key={event.id}><Badge variant="soft" color={color} className="event-kind">{t(zh, en)}</Badge><div><p>{event.message}</p><small className="muted">{date(event.at)}{event.symbol ? ` · ${event.symbol}` : ""}</small></div></li>; })}</ol> : <Empty compact icon={Bell} title={t("还没有事件", "No events yet")} description={t("后台撮合成交、止盈止损、派息拆股、停牌与风控熔断会记录在这里。", "Background fills, stops, dividends, splits, suspensions and risk breaches are recorded here.")} />}</Tabs.Content>
        <Tabs.Content value="reports">{account.reports?.length ? <div className="report-list">{account.reports.map((report) => <ReportCard key={report.id} report={report} />)}</div> : <Empty compact icon={FileText} title={t("还没有报告", "No reports yet")} description={t("Agent 每轮结束时用 arena_publish_report 发布结论。", "Agents publish each round's conclusion with arena_publish_report.")} />}</Tabs.Content>
        <Tabs.Content value="journal">{account.journal.length ? <ol className="journal-timeline">{account.journal.map((entry) => <li key={entry.id}><span className={`journal-kind kind-${entry.kind}`}>{t(...(JOURNAL_KIND[entry.kind] ?? [entry.kind, entry.kind]))}</span><div><p>{entry.summary}</p>{entry.details && <details><summary>{t("详细分析", "Details")}</summary><pre>{entry.details}</pre></details>}<small className="muted">{date(entry.at)}{entry.symbols?.length ? ` · ${entry.symbols.join(", ")}` : ""} · v{entry.strategyVersion}</small></div></li>)}</ol> : <Empty compact icon={NotebookPen} title={t("还没有决策日志", "No journal entries")} description={t("Agent 用 arena_log_decision 记录分析与“不交易”的理由，便于复盘策略。", "Agents record analysis and no-trade reasons with arena_log_decision for later review.")} />}</Tabs.Content>
        <Tabs.Content value="strategy"><div className="strategy-panel">
          <div className="strategy-current"><span className="muted small">{t("当前策略", "Current strategy")} · v{account.strategy.version}</span><p>{account.strategy.summary || t("（未填写策略说明）", "(No strategy description)")}</p></div>
          {m.byStrategyVersion.length > 0 && <div className="table-scroll"><Table.Root size="1"><Table.Header><Table.Row><Table.ColumnHeaderCell>{t("版本", "Version")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("成交", "Fills")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("平仓胜率", "Win rate")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("已实现盈亏", "Realized P&L")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("费用", "Fees")}</Table.ColumnHeaderCell></Table.Row></Table.Header><Table.Body>{m.byStrategyVersion.map((row) => <Table.Row key={row.version}><Table.Cell>v{row.version}</Table.Cell><Table.Cell align="right">{row.trades}</Table.Cell><Table.Cell align="right">{isNumber(row.winRatePct) ? `${row.winRatePct}%` : "—"}</Table.Cell><Table.Cell align="right"><Signed value={row.realizedPnl} suffix="" /></Table.Cell><Table.Cell align="right">{number(row.fees)}</Table.Cell></Table.Row>)}</Table.Body></Table.Root></div>}
          <ol className="journal-timeline">{[...(account.strategyHistory ?? [])].reverse().map((entry) => <li key={entry.version}><span className="journal-kind">v{entry.version}</span><div><p>{entry.note && entry.note !== "initial" ? <strong>{entry.note}</strong> : <strong>{t("初始策略", "Initial strategy")}</strong>}</p><p className="muted">{entry.summary}</p><small className="muted">{date(entry.at)}</small></div></li>)}</ol>
        </div></Tabs.Content>
        <Tabs.Content value="automation"><AutomationPanel account={account} /></Tabs.Content>
        <Tabs.Content value="settings"><AccountSettings account={account} onSaved={(next) => { setAccount(next); onChanged(); }} /></Tabs.Content>
      </Tabs.Root>
      <div className="panel-foot">{t("成交按公开行情 + 滑点 + 交易所费率估算，与券商实际撮合会有差异。", "Fills are estimated from public quotes plus slippage and fee presets; real broker execution differs.")} {account.settings.slippageBps} bps · {account.settings.feeModel}{account.demo ? ` · ${t("演示数据", "demo data")}` : ""}</div>
    </section>
    {connect && <ConnectDialog account={account} market={account.market} onClose={() => setConnect(false)} />}
  </div>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function Onboarding({ onConnect, onCreate }) {
  const { t } = useWorkspace();
  const steps = [
    [Plug, t("接入 Agent", "Connect agents"), t("在 Claude Code、Codex、WorkBuddy 中安装同一个插件。", "Install the same plugin in Claude Code, Codex and WorkBuddy.")],
    [Bot, t("各自开户", "Open accounts"), t("每个 Agent 用自己的模型名开一个账户，或由你在这里预建。", "Each agent opens an account under its real model name, or you pre-create one here.")],
    [Trophy, t("同场竞技", "Compete"), t("给它们相同的提示词与资金，按收益、回撤和纪律横向比较。", "Give them the same prompt and cash, then compare return, drawdown and discipline.")],
  ];
  return <section className="surface arena-onboarding">
    <div className="arena-onboarding-head"><span className="intro-symbol"><Trophy size={24} /></span><div><h2>{t("让不同 Agent 与模型同场炒股", "Put agents and models head-to-head")}</h2><p className="muted">{t("真实行情、虚拟资金。每个 Agent 独立账户，A 股 T+1、涨跌停、每手股数和交易费用全部按规则执行。", "Real quotes, virtual money. Every agent has its own account, with T+1, price limits, board lots and fees enforced.")}</p></div></div>
    <ol className="arena-steps">{steps.map(([Icon, title, text], index) => <li key={title}><span className="step-number">{index + 1}</span><Icon size={20} /><strong>{title}</strong><p className="muted">{text}</p></li>)}</ol>
    <div className="arena-onboarding-actions"><Button size="3" onClick={onConnect}><Plug size={16} />{t("接入 Agent", "Connect an agent")}</Button><Button size="3" variant="soft" onClick={onCreate}><Plus size={16} />{t("手动新建账户", "Create an account")}</Button></div>
  </section>;
}

const urlParam = (name) => (typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get(name));

export function ArenaPage() {
  const { t, notify } = useWorkspace();
  const [board, setBoard] = useState(null);
  const [error, setError] = useState("");
  const [market, setMarket] = useState(() => urlParam("market") || "A");
  const [competition, setCompetition] = useState("default");
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState(() => urlParam("account"));
  const [dialog, setDialog] = useState(null);
  const [highlighted, setHighlighted] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const load = useCallback(async (signal) => {
    try {
      const next = await api(`/api/arena/leaderboard${archived ? "?archived=1" : ""}`, undefined, signal);
      if (!signal?.aborted) { setBoard(next); setError(""); }
    } catch (failure) { if (!signal?.aborted) setError(failure.message); }
  }, [archived]);
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal);
    const timer = window.setInterval(() => { if (!document.hidden) load(abort.signal); }, 30000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selected) url.searchParams.set("account", selected); else url.searchParams.delete("account");
    url.searchParams.set("market", market);
    window.history.replaceState(null, "", url);
  }, [selected, market]);
  const groups = board?.groups ?? [];
  const counts = Object.fromEntries(MARKETS.map((entry) => [entry.id, groups.filter((group) => group.market === entry.id).reduce((sum, group) => sum + group.accounts.length, 0)]));
  const competitions = [...new Set(groups.filter((group) => group.market === market).map((group) => group.competition))];
  const activeCompetition = competitions.includes(competition) ? competition : competitions[0] ?? "default";
  const group = groups.find((entry) => entry.market === market && entry.competition === activeCompetition);
  const accounts = group?.accounts ?? [];
  const sync = async () => {
    setSyncing(true);
    try { await api("/api/arena/sync", {}); await load(); notify(t("已用最新行情同步全部账户。", "All accounts synced with the latest quotes.")); }
    catch (failure) { notify(failure.message, true); } finally { setSyncing(false); }
  };
  if (selected) return <AccountDetail id={selected} onBack={() => { setSelected(null); load(); }} onChanged={load} />;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return <div className="page-stack">
    {board?.demo && <div className="demo-banner"><FlaskConical size={15} /><span>{t("演示", "DEMO")}</span>{t("以下 Agent、模型与收益均为合成样本，用于展示界面。", "Agents, models and returns below are synthetic samples for the interface.")}</div>}
    <div className="arena-toolbar">
      <SegmentedControl.Root value={market} onValueChange={(value) => { setMarket(value); setHighlighted(null); }} size="2">
        {MARKETS.map((entry) => <SegmentedControl.Item key={entry.id} value={entry.id}>{t(entry.zh, entry.en)}{counts[entry.id] ? <span className="segment-count">{counts[entry.id]}</span> : null}</SegmentedControl.Item>)}
      </SegmentedControl.Root>
      {competitions.length > 1 && <Select.Root value={activeCompetition} onValueChange={setCompetition}><Select.Trigger variant="surface" aria-label={t("比赛组别", "Competition")} /><Select.Content>{competitions.map((name) => <Select.Item key={name} value={name}>{t("组别", "Group")}: {name}</Select.Item>)}</Select.Content></Select.Root>}
      <label className="checkbox-label muted small"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />{t("含已归档", "Include archived")}</label>
      <span className="spacer" />
      <MatcherChip matcher={board?.matcher} />
      <ServiceChip service={board?.service} />
      <Tooltip content={t("用最新行情撮合挂单并更新净值", "Match resting orders and mark positions with the latest quotes")}><Button variant="soft" color="gray" onClick={sync} loading={syncing}><RefreshCw size={15} />{t("同步行情", "Sync quotes")}</Button></Tooltip>
      <Button variant="soft" onClick={() => setDialog("create")}><Plus size={15} />{t("新建账户", "New account")}</Button>
      <Button onClick={() => setDialog("connect")}><Plug size={15} />{t("接入 Agent", "Connect agent")}</Button>
    </div>
    <ErrorNotice message={error} onRetry={() => load()} />
    {board && total === 0 && <Onboarding onConnect={() => setDialog("connect")} onCreate={() => setDialog("create")} />}
    {board && total > 0 && <>
      <SummaryCards group={group} />
      {accounts.length ? <>
        <div className="arena-grid">
          <section className="surface"><SectionHeading icon={LineChart} title={t("收益曲线", "Return curves")} caption={t("自开户以来累计收益率", "Cumulative return since inception")} /><ReturnsChart accounts={accounts} highlighted={highlighted} onHover={setHighlighted} /></section>
          <Breakdown accounts={accounts} />
        </div>
        <LeaderboardTable accounts={accounts} onOpen={setSelected} highlighted={highlighted} onHover={setHighlighted} />
      </> : <section className="surface"><Empty icon={Trophy} title={t("这个市场还没有账户", "No accounts in this market yet")} description={t("切换市场，或让 Agent 在这个市场开户。", "Switch markets, or have an agent open an account here.")} action={<Button onClick={() => setDialog("create")}><Plus size={16} />{t("新建账户", "New account")}</Button>} /></section>}
      <ul className="arena-notes">
        <li>{t("只在同一市场、同一组别内排名，不同币种不混算。", "Ranks compare accounts in the same market and group only; currencies are never mixed.")}</li>
        <li>{t("成交价 = 后台撮合器（交易时段每 1–2 分钟）或 Agent 同步时观察到的公开行情 ± 滑点，并扣除按交易所规则估算的费用；单笔不超过当日成交量的设定比例，停牌不成交；与券商真实撮合存在差异。", "Fills use public quotes observed by the background matcher (every 1–2 minutes in session) or an agent sync, ± slippage, minus estimated exchange fees; each fill is capped at a share of the day's volume and suspended stocks never fill. Real broker execution differs.")}</li>
        <li>{t("运行时间短、平仓笔数少时，排名主要反映运气；请结合交易日数、回撤与拒单率判断。", "Short track records mostly reflect luck; weigh trading days, drawdown and rejection rate.")}</li>
      </ul>
      <DigestPanel />
    </>}
    {!board && !error && <section className="surface"><Empty compact icon={Trophy} title={t("正在载入竞技场…", "Loading the arena…")} /></section>}
    {dialog === "create" && <CreateAccountDialog market={market} competition={activeCompetition} onClose={() => setDialog(null)} onCreated={(account) => { setDialog(null); setMarket(account.market); load(); notify(t(`已创建账户 ${account.id}`, `Created ${account.id}`)); }} />}
    {dialog === "connect" && <ConnectDialog market={market} onClose={() => setDialog(null)} />}
  </div>;
}
