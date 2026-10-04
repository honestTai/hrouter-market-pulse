import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dialog, DropdownMenu, IconButton, Select, Theme, Tooltip } from "@radix-ui/themes";
import { ArrowUpRight, Bot, BookOpen, BriefcaseBusiness, CandlestickChart, CheckCircle2, ChevronRight, CircleHelp, Cloud, FileCheck2, FlaskConical, Globe2, Menu, Moon, Plus, RefreshCw, Settings2, ShieldCheck, Sun, TriangleAlert, X } from "lucide-react";
import { WorkspaceContext, useWorkspace } from "./context.jsx";
import { api, array, collectEvidence, holdingsFor, readStorage, writeStorage } from "./data.mjs";
import { MarketPage, PortfolioPage } from "./components/MarketBoard.jsx";
import { EvidencePage, JournalPage } from "./components/ResearchPanels.jsx";
import { PaperTradingPage } from "./components/PaperTrading.jsx";
import { Editor } from "./components/Editors.jsx";
import { ErrorNotice } from "./components/Primitives.jsx";

const views = [
  { id: "market", icon: CandlestickChart, labels: ["市场工作台", "Market workspace"], short: ["市场", "Market"] },
  { id: "portfolio", icon: BriefcaseBusiness, labels: ["我的持仓", "My portfolio"], short: ["持仓", "Portfolio"] },
  { id: "evidence", icon: FileCheck2, labels: ["证据与事件", "Evidence & events"], short: ["证据", "Evidence"] },
  { id: "paper", icon: Bot, labels: ["模拟交易", "Paper trading"], short: ["模拟", "Paper"] },
  { id: "journal", icon: BookOpen, labels: ["研究记录", "Research journal"], short: ["记录", "Journal"] },
];
function Navigation({ afterNavigate }) {
  const { view, setView, report, holdings, decisions, t } = useWorkspace();
  const counts = { market: report.items.length, portfolio: holdings.length, evidence: collectEvidence(report).length, journal: decisions.length, paper: "SIM" };
  return <nav className="primary-nav" aria-label={t("工作台导航", "Workspace navigation")}>{views.map(({ id, icon: Icon, labels }) => <button key={id} className={`nav-item ${view === id ? "active" : ""}`} aria-current={view === id ? "page" : undefined} onClick={() => { setView(id); afterNavigate?.(); }}><Icon size={18} strokeWidth={1.7} /><span>{t(...labels)}</span><span className="nav-count">{counts[id]}</span></button>)}</nav>;
}
function Brand() { return <a className="brand" href="https://hrouter.net/" target="_blank" rel="noreferrer"><span className="brand-icon">H<span /></span><span><strong>Hrouter<span className="brand-dot">.</span></strong><small>MARKET PULSE</small></span></a>; }
function Sidebar() {
  const { t, openEditor, report } = useWorkspace();
  return <aside className="sidebar"><Brand /><div className="sidebar-section-label">{t("研究工作空间", "RESEARCH WORKSPACE")}</div><Navigation /><div className="sidebar-create"><Button variant="outline" color="gray" onClick={() => openEditor({ type: "decision" })}><Plus size={15} />{t("新建研究记录", "New decision")}</Button></div><div className="sidebar-bottom"><div className="local-workspace"><span className="local-orbit"><ShieldCheck size={19} /></span><strong>{t("本地研究工作台", "Local research desk")}</strong><p>{t("来源可核验 · 判断可追溯", "Sourced evidence. Auditable decisions.")}</p><Badge color="jade" variant="soft" size="1">{report.demo ? t("隔离演示数据", "Isolated demo data") : t("记录保存在本机", "Records stored locally")}</Badge></div><button className="sidebar-settings" onClick={() => openEditor({ type: "settings" })}><Settings2 size={17} /><span>{t("自选与持仓设置", "Watchlist & settings")}</span><ChevronRight size={13} /></button><div className="sidebar-version">HROUTER MARKET PULSE <span>RESEARCH</span></div></div></aside>;
}
function Header() {
  const { t, view, appearance, setAppearance, language, setLanguage, report, openEditor } = useWorkspace();
  const [menu, setMenu] = useState(false);
  const current = views.find((v) => v.id === view) || views[0];
  return <header className="topbar"><div className="breadcrumb"><Dialog.Root open={menu} onOpenChange={setMenu}><Dialog.Trigger><IconButton variant="ghost" color="gray" className="mobile-menu" aria-label={t("打开导航", "Open navigation")}><Menu size={20} /></IconButton></Dialog.Trigger><Dialog.Content maxWidth="360px"><Dialog.Title>{t("工作台导航", "Workspace navigation")}</Dialog.Title><Dialog.Description size="2" color="gray">Hrouter Market Pulse</Dialog.Description><Navigation afterNavigate={() => setMenu(false)} /><Dialog.Close><Button variant="soft" color="gray" mt="4">{t("关闭", "Close")}</Button></Dialog.Close></Dialog.Content></Dialog.Root><span className="breadcrumb-root">Workspace</span><ChevronRight size={13} /><strong>{t(...current.labels)}</strong></div><div className="topbar-actions"><span className="public-data-label"><Cloud size={14} />{report.demo ? t("合成演示", "Synthetic demo") : t("公开数据 · 可能延迟", "Public data · may be delayed")}</span><div className="topbar-divider" /><Tooltip content={appearance === "light" ? t("切换深色模式", "Switch to dark mode") : t("切换浅色模式", "Switch to light mode")}><IconButton variant="ghost" color="gray" aria-label={t("切换主题", "Toggle theme")} onClick={() => setAppearance(appearance === "light" ? "dark" : "light")}>{appearance === "light" ? <Moon size={17} /> : <Sun size={17} />}</IconButton></Tooltip><DropdownMenu.Root><DropdownMenu.Trigger><Button variant="ghost" color="gray" size="2"><Globe2 size={15} />{language === "en" ? "EN" : "中文"}</Button></DropdownMenu.Trigger><DropdownMenu.Content><DropdownMenu.RadioGroup value={language} onValueChange={setLanguage}><DropdownMenu.RadioItem value="zh-CN">中文</DropdownMenu.RadioItem><DropdownMenu.RadioItem value="en">English</DropdownMenu.RadioItem></DropdownMenu.RadioGroup></DropdownMenu.Content></DropdownMenu.Root><Tooltip content={t("工作台设置", "Workspace settings")}><IconButton variant="soft" color="gray" aria-label={t("工作台设置", "Workspace settings")} onClick={() => openEditor({ type: "settings" })}><Settings2 size={17} /></IconButton></Tooltip></div></header>;
}
function PageHeading() {
  const { t, view, report, date, busy, refresh, interval, setIntervalSeconds, openEditor } = useWorkspace();
  const current = views.find((v) => v.id === view) || views[0];
  const subtitles = {
    market: ["把行情、证据与判断，放在同一个视野。", "A clearer view of prices, evidence and the reasoning behind them."],
    portfolio: ["按币种查看持仓，关注风险与原始投资逻辑。", "Review holdings by currency, with risk and your original thesis in view."],
    evidence: ["从原始资料出发，区分事实、事件和推断。", "Start with original sources. Separate facts, events and interpretation."],
    paper: ["真实行情、真实模拟委托，检验 Agent 和策略。", "Real quotes and actual paper orders to test agents and strategies."],
    journal: ["保存当时的理由，持续检查新的证据。", "Preserve what you believed then. Keep testing it against new evidence."],
  };
  return <div className="page-heading"><div><div className="eyebrow">{t("有据可查的市场研究", "EVIDENCE-LED MARKET RESEARCH")}</div><h1>{t(...current.labels)}</h1><p>{t(...subtitles[view])}</p></div><div className="page-heading-actions"><div className="report-timestamp"><span className="timestamp-dot" />{t("报告", "Report")} {date(report.generatedAt)}<span className="timezone-label">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div><div className="refresh-controls">{view !== "paper" && <><Tooltip content={t("仅此页面可见时自动更新；不会创建后台定时任务。", "Refreshes while this page is visible; does not create background schedules.")}><span><Select.Root value={String(interval)} onValueChange={(v) => setIntervalSeconds(Number(v))}><Select.Trigger variant="surface" aria-label={t("页面自动更新间隔", "Page auto-refresh interval")} /><Select.Content>{[[0, t("自动更新：关", "Auto refresh: off")], [60, t("每 1 分钟", "Every minute")], [300, t("每 5 分钟", "Every 5 min")], [900, t("每 15 分钟", "Every 15 min")]].map(([value, label]) => <Select.Item value={String(value)} key={value}>{label}</Select.Item>)}</Select.Content></Select.Root></span></Tooltip><Button loading={busy === "refresh"} disabled={busy !== null} onClick={refresh}><RefreshCw size={15} />{t("更新行情", "Refresh quotes")}</Button></>}</div></div></div>;
}

export default function App({ initialReport = {}, initialView = "market" }) {
  const [report, setReport] = useState(() => ({ ...initialReport, items: array(initialReport.items) }));
  const [view, setView] = useState(views.some((v) => v.id === initialView) ? initialView : "market");
  const [language, setLanguage] = useState(() => readStorage("language", initialReport.language || "zh-CN") === "en" ? "en" : "zh-CN");
  const [appearance, setAppearance] = useState(() => readStorage("appearance", "light") === "dark" ? "dark" : "light");
  const [colorConvention, setColorConvention] = useState(() => readStorage("colorConvention", language === "en" ? "green-up" : "red-up"));
  const [preferences, setPreferences] = useState(null);
  const [decisions, setDecisions] = useState(array(initialReport.decisions));
  const [selected, setSelected] = useState(initialReport.items?.find((i) => i.position)?.symbol || initialReport.items?.[0]?.symbol || "");
  const [timeframe, setTimeframe] = useState(initialReport.phase === "intraday" ? "intraday" : "daily");
  const [clock, setClock] = useState(Date.now());
  const [busy, setBusy] = useState(null);
  const lock = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [toast, setToast] = useState(null);
  const [editor, setEditor] = useState(null);
  const [interval, setIntervalSeconds] = useState(0);
  const t = (zh, en) => language === "en" ? en : zh;
  const notify = useCallback((message, error = false) => setToast({ message, error, id: Date.now() }), []);
  const holdings = useMemo(() => holdingsFor(report.items, preferences?.positions), [report.items, preferences]);
  useEffect(() => { document.documentElement.lang = language; writeStorage("language", language); }, [language]);
  useEffect(() => { document.documentElement.style.colorScheme = appearance; writeStorage("appearance", appearance); }, [appearance]);
  useEffect(() => { writeStorage("colorConvention", colorConvention); }, [colorConvention]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 6500); return () => window.clearTimeout(timer); }, [toast]);
  const loadWorkspace = useCallback(async (signal) => {
    setLoading(true); setLoadError("");
    const results = await Promise.allSettled([api("/api/preferences", undefined, signal), api("/api/decisions", undefined, signal)]);
    if (signal?.aborted) return;
    if (results[0].status === "fulfilled") setPreferences(results[0].value.preferences || results[0].value);
    if (results[1].status === "fulfilled") setDecisions(array(results[1].value, "decisions"));
    const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
    if (failures.length) setLoadError(failures.join(" · "));
    setLoading(false);
  }, []);
  useEffect(() => { const abort = new AbortController(); loadWorkspace(abort.signal); return () => abort.abort(); }, [loadWorkspace]);
  const runAction = async (name, action) => {
    if (lock.current) throw new Error(t("另一个操作正在执行，请稍后再试。", "Another action is in progress. Please wait."));
    lock.current = true; setBusy(name);
    try { return await action(); } finally { lock.current = false; setBusy(null); }
  };
  const applyReport = (next) => {
    const normalized = { ...next, items: array(next.items) };
    setReport(normalized);
    setSelected((current) => normalized.items.some((i) => i.symbol === current) ? current : normalized.items[0]?.symbol || "");
    setClock(Date.now());
  };
  const refresh = async () => {
    if (lock.current) return;
    try { await runAction("refresh", async () => {
      const response = await api("/api/refresh", { phase: timeframe === "intraday" ? "intraday" : "research" });
      const next = response.items ? response : response.report?.items ? response.report : await api("/api/latest");
      applyReport(next); notify(t("行情报告已更新。", "Market report updated."));
    }); } catch (error) { notify(error.message, true); }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => { if (!interval) return; const timer = window.setInterval(() => { if (!document.hidden && !lock.current) refreshRef.current(); }, interval * 1000); return () => window.clearInterval(timer); }, [interval]);
  const syncSources = async (symbols) => {
    if (lock.current) return;
    try { await runAction("sync", async () => {
      const sync = await api("/api/official/sync", { symbols: symbols || preferences?.watchlist || report.items.map((i) => i.symbol) });
      const evidence = await api("/api/evidence");
      setReport((current) => ({ ...current, officialSync: sync,
        evidence: array(evidence, "items"), events: evidence.events ?? current.events, eventWarnings: evidence.eventWarnings ?? current.eventWarnings,
        items: current.items.map((item) => ({ ...item, evidence: array(evidence, "items").filter((r) => (r.entity?.symbol || r.symbol) === item.symbol), events: (evidence.events ?? current.events ?? []).filter((e) => e.symbol === item.symbol) })) }));
      notify(t("来源同步已完成，请核对各数据源的状态。", "Source sync finished. Review each provider's status."));
    }); } catch (error) { notify(error.message, true); }
  };
  const savePreferences = async (input, colors) => runAction("settings", async () => {
    const result = await api("/api/preferences", input);
    setPreferences(result.preferences || result); setLanguage(input.language); setColorConvention(colors);
    // Saving settings and fetching remote prices are separate actions; don't report a failed refresh as a failed save.
    notify(t("设置已保存。更新行情后可载入新的自选标的。", "Settings saved. Refresh quotes to load the updated watchlist."));
  });
  const saveDecision = async (input) => runAction("decision", async () => {
    const record = await api("/api/decisions", input);
    setDecisions((rows) => [record, ...rows.filter((r) => r.id !== record.id)]);
    // Fetch derived scorecards separately; a read failure must not retry the saved mutation.
    try { const result = await api("/api/decisions"); setDecisions(array(result, "decisions")); } catch { /* Keep the successfully saved record. */ }
    notify(t("原始研究判断已保存。", "Original research decision saved."));
  });
  const saveReview = async (id, input) => runAction("review", async () => {
    const record = await api(`/api/decisions/${encodeURIComponent(id)}/review`, input);
    setDecisions((rows) => rows.map((r) => r.id === record.id ? { ...r, ...record } : r));
    // Scorecards may be derived by the read endpoint; don't lose them after an outcome review.
    try { const result = await api("/api/decisions"); setDecisions(array(result, "decisions")); } catch { /* The saved record remains visible. */ }
    notify(t("复盘已追加，原始判断保持不变。", "Review appended. The original decision is unchanged."));
  });
  const context = { report, view, setView, language, setLanguage, appearance, setAppearance, colorConvention, preferences, decisions, selected, setSelected, timeframe, setTimeframe, clock, busy, loading, holdings, interval, setIntervalSeconds, refresh, syncSources, savePreferences, saveDecision, saveReview, openEditor: setEditor, reloadWorkspace: () => loadWorkspace(), notify };
  return <Theme appearance={appearance} accentColor="jade" grayColor="slate" radius="large" scaling="100%" panelBackground="solid" className={`workspace-theme ${colorConvention === "red-up" ? "red-up" : "green-up"}`}><WorkspaceContext.Provider value={context}><div className="workspace-shell"><Sidebar /><div className="workspace-main"><Header /><main className="main-content"><PageHeading />{report.demo && <div className="demo-banner"><FlaskConical size={15} /><span>{t("演示模式", "DEMO MODE")}</span>{t("全部价格、持仓与事件均为合成样本，不用于真实决策。", "All prices, positions and events are synthetic. Not for real investment decisions.")}</div>}<ErrorNotice message={loadError} onRetry={() => loadWorkspace()} />{view === "market" ? <MarketPage /> : view === "portfolio" ? <PortfolioPage /> : view === "evidence" ? <EvidencePage /> : view === "paper" ? <PaperTradingPage /> : <JournalPage />}<footer className="workspace-footer"><span><ShieldCheck size={13} />{t("公开行情可能延迟 · 研究不等于交易建议", "Public quotes may be delayed · Research is not a trade recommendation")}</span><a href="https://hrouter.net/" target="_blank" rel="noreferrer">HRouter <ArrowUpRight size={12} /></a></footer></main></div></div>{editor && <Editor key={`${editor.type}:${editor.record?.id || ""}`} editor={editor} onClose={() => setEditor(null)} />}<div className="toast-region" aria-live="polite">{toast && <div className={`app-toast ${toast.error ? "error" : ""}`} role={toast.error ? "alert" : "status"}>{toast.error ? <TriangleAlert size={18} /> : <CheckCircle2 size={18} />}<span>{toast.message}</span><IconButton variant="ghost" color="gray" size="1" aria-label={t("关闭通知", "Dismiss notification")} onClick={() => setToast(null)}><X size={14} /></IconButton></div>}</div></WorkspaceContext.Provider></Theme>;
}
