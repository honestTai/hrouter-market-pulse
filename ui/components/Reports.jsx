import React, { useEffect, useState } from "react";
import { Badge, Button, Dialog, IconButton, SegmentedControl, Select, Tabs, TextField } from "@radix-ui/themes";
import { ArrowUpRight, CircleAlert, FileText, Newspaper, Send, X } from "lucide-react";
import { useWorkspace } from "../context.jsx";
import { AgentMark, ReportCard, Signed, SENTIMENT } from "./Arena.jsx";
import { Empty, ErrorNotice } from "./Primitives.jsx";
import { DateRange, Pager, SearchField, useDebounced, usePagedList } from "./Paging.jsx";

const MARKET_LABELS = { A: ["A 股", "China A"], HK: ["港股", "Hong Kong"], US: ["美股", "US"] };
const urlParam = (name) => (typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get(name));
const setUrlParam = (name, value) => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (value) url.searchParams.set(name, value); else url.searchParams.delete(name);
  window.history.replaceState(null, "", url);
};

// Header shared by the report detail views: whose report it is and how to open the account.
function ReportOwner({ report, onOpenAccount }) {
  const { t } = useWorkspace();
  const account = report.account;
  if (!account) return null;
  return <div className="report-owner">
    <AgentMark account={account} size="sm" />
    <div><strong>{account.name}</strong><span className="muted small">{account.agent?.label ?? "Agent"} · {account.model} · {t(...(MARKET_LABELS[account.market] ?? [account.market, account.market]))}</span></div>
    {onOpenAccount && <Button size="1" variant="soft" color="gray" onClick={() => onOpenAccount(account)}>{t("打开账户", "Open account")}<ArrowUpRight size={13} /></Button>}
  </div>;
}

// Full report in a dialog: used from "My portfolio", the account page and the digest.
export function ReportDialog({ report, onClose }) {
  const { t, openArenaAccount } = useWorkspace();
  return <Dialog.Root open={Boolean(report)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Content maxWidth="860px" className="report-dialog" aria-describedby={undefined}>
      <Dialog.Title className="visually-hidden">{report?.title ?? t("报告详情", "Report")}</Dialog.Title>
      <Dialog.Close><IconButton className="dialog-close" variant="ghost" color="gray" aria-label={t("关闭", "Close")}><X size={18} /></IconButton></Dialog.Close>
      {report && <>
        <ReportOwner report={report} onOpenAccount={report.account ? (account) => { onClose(); openArenaAccount(account.id, account.market); } : null} />
        <ReportCard report={report} full />
      </>}
    </Dialog.Content>
  </Dialog.Root>;
}

const DELIVERY = { delivered: ["已推送", "Delivered", "jade"], failed: ["推送失败", "Failed", "red"], skipped: ["未推送", "Not sent", "gray"] };

// One end-of-day digest in full: totals, a per-account table and each account's fills and warnings.
export function DigestDetail({ digest, onOpenAccount }) {
  const { t, date, number } = useWorkspace();
  const [open, setOpen] = useState(() => new Set());
  if (!digest) return null;
  const delivery = digest.delivery ? DELIVERY[digest.delivery.status] ?? [digest.delivery.status, digest.delivery.status, "gray"] : null;
  const toggle = (id) => setOpen((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const best = [...digest.accounts].sort((a, b) => (b.dayReturnPct ?? -Infinity) - (a.dayReturnPct ?? -Infinity))[0];
  return <div className="digest-detail">
    <header className="digest-detail-head">
      <div><span className="eyebrow">{digest.market ? t(...(MARKET_LABELS[digest.market] ?? [digest.market, digest.market])) : t("全部市场", "All markets")} · {digest.date}</span><h2>{digest.title}</h2><p className="muted">{t("生成于", "Generated")} {date(digest.at)} · {digest.trigger === "market-close" ? t("收盘自动生成", "auto at close") : t("手动生成", "manual")}</p></div>
      {delivery && <Badge size="2" variant="soft" color={delivery[2]}><Send size={12} />{t(delivery[0], delivery[1])}{digest.delivery.attempts > 1 ? ` ×${digest.delivery.attempts}` : ""}</Badge>}
    </header>
    <div className="digest-tiles">
      <div><span className="metric-label">{t("账户", "Accounts")}</span><strong>{digest.totals?.accounts ?? digest.accounts.length}</strong></div>
      <div><span className="metric-label">{t("成交", "Fills")}</span><strong>{digest.totals?.trades ?? 0}</strong></div>
      <div><span className="metric-label">{t("提醒", "Warnings")}</span><strong className={digest.totals?.warnings ? "warning-text" : ""}>{digest.totals?.warnings ?? 0}</strong></div>
      <div><span className="metric-label">{t("当日最佳", "Best today")}</span><strong className="digest-best">{best ? <>{best.name} <Signed value={best.dayReturnPct} /></> : "—"}</strong></div>
    </div>
    <div className="digest-grid" role="table">
      <div className="digest-grid-row head" role="row">
        <span role="columnheader">{t("账户 / 模型", "Account / model")}</span>
        <span role="columnheader">{t("净值", "Equity")}</span>
        <span role="columnheader">{t("当日", "Day")}</span>
        <span role="columnheader">{t("累计 / 超额", "Total / excess")}</span>
        <span role="columnheader">{t("回撤 / 仓位", "Drawdown / exposure")}</span>
        <span role="columnheader">{t("成交", "Fills")}</span>
      </div>
      {digest.accounts.map((row) => <div key={row.id} className={`digest-grid-item ${open.has(row.id) ? "open" : ""}`}>
        <button type="button" className="digest-grid-row" role="row" aria-expanded={open.has(row.id)} onClick={() => toggle(row.id)}>
          <span className="digest-name"><strong>{row.name}</strong><small className="cell-subtitle">{row.agent ?? ""} · {row.model}</small></span>
          <span className="tabular">{number(row.equity, 0)}<small className="cell-subtitle">{row.currency}</small></span>
          <span><Signed value={row.dayReturnPct} /></span>
          <span><Signed value={row.totalReturnPct} /><small className="cell-subtitle">{t("超额", "Excess")} <Signed value={row.excessReturnPct} /></small></span>
          <span><Signed value={row.maxDrawdownPct} /><small className="cell-subtitle">{row.exposurePct === null || row.exposurePct === undefined ? "—" : `${number(row.exposurePct, 1)}%`} · {row.positions ?? 0} {t("只", "pos")}</small></span>
          <span className="tabular">{row.trades.length}{row.warnings.length > 0 && <CircleAlert size={13} className="warning-text" />}</span>
        </button>
        {open.has(row.id) && <div className="digest-expand-grid">
          <section><h4>{t("当日成交", "Fills today")}</h4>{row.trades.length ? <ul className="fill-list">{row.trades.map((trade, index) => <li key={index}><span className={`action-tag action-${trade.side === "BUY" ? "buy" : "sell"}`}>{trade.side === "BUY" ? t("买入", "Buy") : t("卖出", "Sell")}</span><strong>{trade.name ?? trade.symbol}</strong><span className="muted small">{trade.symbol}</span><span className="tabular">{number(trade.quantity, 0)} @ {trade.price}</span>{trade.realizedPnl !== null && trade.realizedPnl !== undefined && <span className={trade.realizedPnl >= 0 ? "gain" : "loss"}>{trade.realizedPnl >= 0 ? "+" : ""}{number(trade.realizedPnl, 2)}</span>}{trade.trigger && <Badge size="1" variant="soft" color="amber">{trade.trigger}</Badge>}</li>)}</ul> : <p className="muted small">{t("当日无成交。", "No fills today.")}</p>}</section>
          <section><h4>{t("最新报告", "Latest report")}</h4>{row.latestReport ? <><p><strong>{row.latestReport.title}</strong>{!row.latestReport.today && <span className="muted small">{t("（非当日）", " (earlier)")}</span>}</p>{row.latestReport.summary && <p className="muted small">{row.latestReport.summary}</p>}</> : <p className="muted small">{t("还没有报告。", "No report yet.")}</p>}
            {row.warnings.length > 0 && <><h4>{t("提醒", "Warnings")}</h4><ul className="digest-warnings">{row.warnings.map((warning, index) => <li key={index}><CircleAlert size={12} />{warning}</li>)}</ul></>}
            {onOpenAccount && <Button size="1" variant="soft" color="gray" mt="2" onClick={() => onOpenAccount({ id: row.id, market: row.market })}>{t("打开账户", "Open account")}<ArrowUpRight size={13} /></Button>}
          </section>
        </div>}
      </div>)}
    </div>
    <p className="muted small">{t("点击账户行展开当日成交、报告与提醒。收益为模拟盘虚拟资金，不代表真实收益。", "Click a row for its fills, report and warnings. Paper results with virtual money; not real returns.")}</p>
  </div>;
}

export function DigestDialog({ digest, onClose }) {
  const { t, openArenaAccount } = useWorkspace();
  return <Dialog.Root open={Boolean(digest)} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Content maxWidth="1080px" className="report-dialog" aria-describedby={undefined}>
      <Dialog.Title className="visually-hidden">{digest?.title ?? t("日报", "Digest")}</Dialog.Title>
      <Dialog.Close><IconButton className="dialog-close" variant="ghost" color="gray" aria-label={t("关闭", "Close")}><X size={18} /></IconButton></Dialog.Close>
      <DigestDetail digest={digest} onOpenAccount={(account) => { onClose(); openArenaAccount(account.id, account.market); }} />
    </Dialog.Content>
  </Dialog.Root>;
}

// Report centre: every agent report and every end-of-day digest, server-side filtered and paged,
// with a detail pane.
export function ReportsPage() {
  const { t, date, openArenaAccount } = useWorkspace();
  const [tab, setTab] = useState(() => urlParam("tab") === "digests" ? "digests" : "reports");
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("all");
  const [account, setAccount] = useState("all");
  const [sentiment, setSentiment] = useState("all");
  const [range, setRange] = useState({ from: "", to: "" });
  const [selected, setSelected] = useState(() => urlParam("report"));
  const [digestId, setDigestId] = useState(() => urlParam("digest"));
  const q = useDebounced(query);
  const reports = usePagedList("/api/arena/reports", { q, market, account, sentiment, from: range.from, to: range.to }, { itemsKey: "reports", refreshMs: 60000 });
  const digests = usePagedList("/api/arena/digests", { market, from: range.from, to: range.to }, { itemsKey: "digests", refreshMs: 60000 });
  useEffect(() => { setUrlParam("tab", tab === "digests" ? "digests" : null); }, [tab]);
  useEffect(() => { setUrlParam("report", selected); }, [selected]);
  useEffect(() => { setUrlParam("digest", digestId); }, [digestId]);
  const accounts = reports.data?.accounts ?? [];
  const current = reports.items.find((report) => report.id === selected) ?? reports.items[0];
  const digest = digests.items.find((entry) => entry.id === digestId) ?? digests.items[0];
  const openAccount = (target) => openArenaAccount(target.id, target.market);
  const filtered = Boolean(q || account !== "all" || sentiment !== "all" || range.from || range.to);
  const clear = () => { setQuery(""); setAccount("all"); setSentiment("all"); setRange({ from: "", to: "" }); };

  return <div className="page-stack">
    <ErrorNotice message={reports.error || digests.error} onRetry={() => { reports.reload(); digests.reload(); }} />
    <section className="surface reports-shell">
      <Tabs.Root value={tab} onValueChange={setTab}>
        <div className="reports-toolbar">
          <Tabs.List size="2"><Tabs.Trigger value="reports"><FileText size={14} />{t("Agent 报告", "Agent reports")}<span className="tab-count">{reports.data?.all ?? 0}</span></Tabs.Trigger><Tabs.Trigger value="digests"><Newspaper size={14} />{t("收盘日报", "Daily digests")}<span className="tab-count">{digests.total}</span></Tabs.Trigger></Tabs.List>
          <span className="spacer" />
          <SegmentedControl.Root size="1" value={market} onValueChange={setMarket}>{[["all", t("全部", "All")], ["A", t("A 股", "CN")], ["HK", t("港股", "HK")], ["US", t("美股", "US")]].map(([key, label]) => <SegmentedControl.Item key={key} value={key}>{label}</SegmentedControl.Item>)}</SegmentedControl.Root>
        </div>
        <div className="reports-filters">
          {tab === "reports" && <SearchField value={query} onChange={setQuery} placeholder={t("搜索标题、结论、股票代码…", "Search title, conclusion, symbol…")} />}
          {tab === "reports" && <Select.Root value={account} onValueChange={setAccount}><Select.Trigger variant="surface" aria-label={t("账户", "Account")} /><Select.Content><Select.Item value="all">{t("全部账户", "All accounts")}</Select.Item>{accounts.map((entry) => <Select.Item key={entry.id} value={entry.id}>{entry.name}</Select.Item>)}</Select.Content></Select.Root>}
          {tab === "reports" && <Select.Root value={sentiment} onValueChange={setSentiment}><Select.Trigger variant="surface" aria-label={t("观点", "Stance")} /><Select.Content><Select.Item value="all">{t("全部观点", "Any stance")}</Select.Item>{Object.entries(SENTIMENT).map(([key, [zh, en]]) => <Select.Item key={key} value={key}>{t(zh, en)}</Select.Item>)}</Select.Content></Select.Root>}
          <DateRange from={range.from} to={range.to} onChange={setRange} />
          {filtered && <Button size="1" variant="ghost" color="gray" onClick={clear}>{t("清除筛选", "Clear filters")}</Button>}
        </div>
        <Tabs.Content value="reports">
          {!reports.data ? <Empty compact icon={FileText} title={t("正在载入报告…", "Loading reports…")} /> : reports.items.length ? <div className={`master-detail ${reports.loading ? "is-loading" : ""}`}>
            <div className="report-index-column">
              <ul className="report-index" role="listbox" aria-label={t("报告列表", "Reports")}>{reports.items.map((report) => {
                const stance = SENTIMENT[report.sentiment];
                return <li key={`${report.account.id}:${report.id}`}><button type="button" role="option" aria-selected={current?.id === report.id} className={`report-index-row ${current?.id === report.id ? "active" : ""}`} onClick={() => setSelected(report.id)}>
                  <span className="report-index-head"><AgentMark account={report.account} size="sm" /><span className="report-index-account">{report.account.name}</span><span className="muted small">{date(report.at)}</span></span>
                  <strong>{report.title}</strong>
                  <span className="report-index-meta">{stance && <Badge size="1" variant="soft" color={stance[2]}>{t(stance[0], stance[1])}</Badge>}{report.actions?.length > 0 && <span className="muted small">{report.actions.length} {t("项操作", "actions")}</span>}{report.snapshot && <Signed value={report.snapshot.returnPct} />}</span>
                </button></li>;
              })}</ul>
              <Pager compact total={reports.total} page={reports.page} pageSize={reports.pageSize} onPage={reports.setPage} loading={reports.loading} />
            </div>
            <div className="report-pane">{current && <><ReportOwner report={current} onOpenAccount={openAccount} /><ReportCard report={current} full /></>}</div>
          </div> : <Empty compact icon={FileText} title={filtered ? t("没有匹配的报告", "No matching reports") : t("还没有报告", "No reports yet")} description={filtered ? t("调整或清除筛选条件。", "Adjust or clear the filters.") : t("Agent 每轮结束会用 arena_publish_report 发布报告。", "Agents publish a report at the end of each round.")} action={filtered ? <Button variant="soft" onClick={clear}>{t("清除筛选", "Clear filters")}</Button> : null} />}
        </Tabs.Content>
        <Tabs.Content value="digests">
          {!digests.data ? <Empty compact icon={Newspaper} title={t("正在载入日报…", "Loading digests…")} /> : digests.items.length ? <div className={`master-detail digests ${digests.loading ? "is-loading" : ""}`}>
            <div className="report-index-column">
              <ul className="report-index" role="listbox" aria-label={t("日报列表", "Digests")}>{digests.items.map((entry) => <li key={entry.id}><button type="button" role="option" aria-selected={digest?.id === entry.id} className={`report-index-row ${digest?.id === entry.id ? "active" : ""}`} onClick={() => setDigestId(entry.id)}>
                <span className="report-index-head"><Badge size="1" variant="surface" color="gray">{entry.market ?? t("全部", "All")}</Badge><span className="report-index-account">{entry.date}</span><span className="muted small">{date(entry.at)}</span></span>
                <strong>{entry.headline}</strong>
                <span className="report-index-meta">{entry.delivery && <Badge size="1" variant="soft" color={(DELIVERY[entry.delivery.status] ?? [0, 0, "gray"])[2]}>{t(...(DELIVERY[entry.delivery.status] ?? [entry.delivery.status, entry.delivery.status]).slice(0, 2))}</Badge>}<span className="muted small">{entry.trigger === "market-close" ? t("收盘自动", "At close") : t("手动", "Manual")}</span></span>
              </button></li>)}</ul>
              <Pager compact total={digests.total} page={digests.page} pageSize={digests.pageSize} onPage={digests.setPage} loading={digests.loading} />
            </div>
            <div className="report-pane"><DigestDetail digest={digest} onOpenAccount={openAccount} /></div>
          </div> : <Empty compact icon={Newspaper} title={t("还没有日报", "No digest yet")} description={t("每个市场收盘后，后台会自动汇总所有账户的收益、成交、报告与提醒。", "After each close the background service summarizes every account.")} />}
        </Tabs.Content>
      </Tabs.Root>
    </section>
  </div>;
}
