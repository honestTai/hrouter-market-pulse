import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dialog, DropdownMenu, IconButton, Select, Theme, Tooltip } from "@radix-ui/themes";
import { ArrowUpRight, Bot, BookOpen, BriefcaseBusiness, CandlestickChart, CheckCircle2, ChevronRight, Cloud, FileCheck2, FlaskConical, Globe2, Maximize2, Menu, Minimize2, Moon, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sun, Trophy, TriangleAlert, X } from "lucide-react";
import { WorkspaceContext, useWorkspace } from "./context.jsx";
import { api, array, collectEvidence, holdingsFor, readStorage, writeStorage } from "./data.mjs";
import { MarketPage } from "./components/MarketBoard.jsx";
import { EvidencePage, JournalPage } from "./components/ResearchPanels.jsx";
import { PaperTradingPage } from "./components/PaperTrading.jsx";
import { ArenaPage } from "./components/Arena.jsx";
import { ManagedPortfolioPage } from "./components/Managed.jsx";
import { Editor } from "./components/Editors.jsx";
import { ErrorNotice } from "./components/Primitives.jsx";
import { CommandPalette } from "./components/CommandPalette.jsx";

const views = [
  { id: "market", group: "research", icon: CandlestickChart, labels: ["市场工作台", "Market workspace"], keywords: "行情 自选 K线 quotes watchlist chart sc" },
  { id: "portfolio", group: "research", icon: BriefcaseBusiness, labels: ["我的持仓", "My portfolio"], keywords: "托管 持仓 收益 managed holdings wdcc" },
  { id: "evidence", group: "research", icon: FileCheck2, labels: ["证据与事件", "Evidence & events"], keywords: "公告 新闻 事件 news filings zj" },
  { id: "journal", group: "research", icon: BookOpen, labels: ["研究记录", "Research journal"], keywords: "决策 复盘 decisions review yj" },
  { id: "arena", group: "trading", icon: Trophy, labels: ["Agent 竞技场", "Agent arena"], keywords: "排行榜 模拟盘 自动运行 日报 leaderboard automation digest jjc" },
  { id: "paper", group: "trading", icon: Bot, labels: ["富途模拟盘", "Futu paper account"], keywords: "futu opend 富途 ft" },
];
const groups = [
  { id: "research", labels: ["研究", "RESEARCH"] },
  { id: "trading", labels: ["模拟交易", "PAPER TRADING"] },
];
const subtitles = {
  market: ["把行情、证据与判断放在同一个视野。", "Prices, evidence and the reasoning behind them, in one view."],
  portfolio: ["由 Agent 全权托管：它负责选股、交易和调仓，你在这里看结论、持仓和收益。", "Fully managed by an agent: it picks, trades and rebalances; you read the conclusions, holdings and returns here."],
  evidence: ["从原始资料出发，区分事实、事件和推断。", "Start from original sources. Separate facts, events and interpretation."],
  journal: ["保存当时的理由，持续用新证据检验。", "Preserve what you believed then, and keep testing it against new evidence."],
  arena: ["让 Claude Code、Codex、WorkBuddy 等 Agent 用各自的模型同场模拟交易，横向比较收益、回撤与交易纪律。", "Claude Code, Codex, WorkBuddy and other agents paper-trade side by side; compare return, drawdown and discipline."],
  paper: ["可选：通过本机富途 OpenD 在真实的富途模拟账户中执行受限额约束的委托。", "Optional: bounded orders in an actual Futu SIMULATE account through local OpenD."],
};

function Navigation({ afterNavigate }) {
  const { view, setView, report, holdings, decisions, t } = useWorkspace();
  const counts = { market: report.items.length, portfolio: holdings.length, evidence: collectEvidence(report).length, journal: decisions.length };
  return <nav className="primary-nav" aria-label={t("工作台导航", "Workspace navigation")}>
    {groups.map((group) => <div className="nav-group" key={group.id}>
      <div className="sidebar-section-label">{t(...group.labels)}</div>
      {views.filter((entry) => entry.group === group.id).map(({ id, icon: Icon, labels }) => (
        <button key={id} className={`nav-item ${view === id ? "active" : ""}`} aria-current={view === id ? "page" : undefined} onClick={() => { setView(id); afterNavigate?.(); }}>
          <Icon size={18} strokeWidth={1.8} />
          <span>{t(...labels)}</span>
          {counts[id] !== undefined && <span className="nav-count">{counts[id]}</span>}
          {id === "arena" && <span className="nav-new">NEW</span>}
        </button>
      ))}
    </div>)}
  </nav>;
}

function Brand() {
  return <a className="brand" href="https://hrouter.net/" target="_blank" rel="noreferrer">
    <span className="brand-icon">H<span /></span>
    <span><strong>Hrouter<span className="brand-dot">.</span></strong><small>MARKET PULSE</small></span>
  </a>;
}

function SearchTrigger({ compact = false }) {
  const { t, openPalette } = useWorkspace();
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return <button type="button" className={`search-trigger ${compact ? "compact" : ""}`} onClick={openPalette} aria-label={t("搜索菜单、账户和股票", "Search menus, accounts and securities")} aria-keyshortcuts="Meta+K Control+K">
    <Search size={15} /><span>{t("搜索…", "Search…")}</span><kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
  </button>;
}

function Sidebar() {
  const { t, openEditor, report } = useWorkspace();
  return <aside className="sidebar">
    <Brand />
    <SearchTrigger />
    <Navigation />
    <div className="sidebar-create">
      <Button variant="outline" color="gray" onClick={() => openEditor({ type: "decision" })}><Plus size={15} />{t("新建研究记录", "New decision")}</Button>
    </div>
    <div className="sidebar-bottom">
      <div className="local-workspace">
        <span className="local-orbit"><ShieldCheck size={18} /></span>
        <strong>{t("本地优先", "Local-first")}</strong>
        <p>{t("数据保存在本机，所有 Agent 共享同一份记录。", "Data stays on this machine and is shared by every agent.")}</p>
        <Badge color="jade" variant="soft" size="1">{report.demo ? t("隔离演示数据", "Isolated demo data") : t("记录保存在本机", "Stored locally")}</Badge>
      </div>
      <button className="sidebar-settings" onClick={() => openEditor({ type: "settings" })}><Settings2 size={17} /><span>{t("自选与持仓设置", "Watchlist & settings")}</span><ChevronRight size={13} /></button>
    </div>
  </aside>;
}

function Header() {
  const { t, view, appearance, setAppearance, language, setLanguage, report, openEditor, fullscreen, toggleFullscreen } = useWorkspace();
  const [menu, setMenu] = useState(false);
  const current = views.find((entry) => entry.id === view) || views[0];
  const group = groups.find((entry) => entry.id === current.group);
  return <header className="topbar">
    <div className="breadcrumb">
      <Dialog.Root open={menu} onOpenChange={setMenu}>
        <Dialog.Trigger><IconButton variant="ghost" color="gray" className="mobile-menu" aria-label={t("打开导航", "Open navigation")}><Menu size={20} /></IconButton></Dialog.Trigger>
        <Dialog.Content maxWidth="360px">
          <Dialog.Title>Hrouter Market Pulse</Dialog.Title>
          <Dialog.Description size="2" color="gray">{t("工作台导航", "Workspace navigation")}</Dialog.Description>
          <Navigation afterNavigate={() => setMenu(false)} />
          <Dialog.Close><Button variant="soft" color="gray" mt="4">{t("关闭", "Close")}</Button></Dialog.Close>
        </Dialog.Content>
      </Dialog.Root>
      <span className="breadcrumb-root">{t(...group.labels)}</span>
      <ChevronRight size={13} />
      <strong>{t(...current.labels)}</strong>
    </div>
    <div className="topbar-actions">
      <SearchTrigger compact />
      <span className="public-data-label"><Cloud size={14} />{report.demo ? t("合成演示数据", "Synthetic demo") : t("公开行情 · 可能延迟", "Public quotes · may be delayed")}</span>
      <div className="topbar-divider" />
      <Tooltip content={fullscreen ? t("退出全屏（Esc）", "Exit fullscreen (Esc)") : t("全屏查看", "Fullscreen")}>
        <IconButton variant="ghost" color="gray" aria-label={fullscreen ? t("退出全屏", "Exit fullscreen") : t("全屏", "Fullscreen")} aria-pressed={fullscreen} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</IconButton>
      </Tooltip>
      <Tooltip content={appearance === "light" ? t("切换深色模式", "Switch to dark mode") : t("切换浅色模式", "Switch to light mode")}>
        <IconButton variant="ghost" color="gray" aria-label={t("切换主题", "Toggle theme")} onClick={() => setAppearance(appearance === "light" ? "dark" : "light")}>{appearance === "light" ? <Moon size={17} /> : <Sun size={17} />}</IconButton>
      </Tooltip>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger><Button variant="ghost" color="gray" size="2"><Globe2 size={15} />{language === "en" ? "EN" : "中文"}</Button></DropdownMenu.Trigger>
        <DropdownMenu.Content><DropdownMenu.RadioGroup value={language} onValueChange={setLanguage}><DropdownMenu.RadioItem value="zh-CN">中文</DropdownMenu.RadioItem><DropdownMenu.RadioItem value="en">English</DropdownMenu.RadioItem></DropdownMenu.RadioGroup></DropdownMenu.Content>
      </DropdownMenu.Root>
      <Tooltip content={t("工作台设置", "Workspace settings")}>
        <IconButton variant="soft" color="gray" aria-label={t("工作台设置", "Workspace settings")} onClick={() => openEditor({ type: "settings" })}><Settings2 size={17} /></IconButton>
      </Tooltip>
    </div>
  </header>;
}

function PageHeading() {
  const { t, view, report, date, busy, refresh, interval, setIntervalSeconds } = useWorkspace();
  const current = views.find((entry) => entry.id === view) || views[0];
  const research = current.group === "research";
  return <div className="page-heading">
    <div>
      <div className="eyebrow">{research ? t("有据可查的市场研究", "EVIDENCE-LED MARKET RESEARCH") : t("虚拟资金 · 真实行情", "VIRTUAL MONEY · REAL QUOTES")}</div>
      <h1>{t(...current.labels)}</h1>
      <p>{t(...subtitles[view])}</p>
    </div>
    {research && <div className="page-heading-actions">
      <div className="report-timestamp"><span className="timestamp-dot" />{t("报告", "Report")} {date(report.generatedAt)}<span className="timezone-label">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>
      <div className="refresh-controls">
        <Tooltip content={t("仅此页面可见时自动更新；不会创建后台定时任务。", "Refreshes while this page is visible; does not create background schedules.")}>
          <span><Select.Root value={String(interval)} onValueChange={(value) => setIntervalSeconds(Number(value))}>
            <Select.Trigger variant="surface" aria-label={t("页面自动更新间隔", "Page auto-refresh interval")} />
            <Select.Content>{[[0, t("自动更新：关", "Auto refresh: off")], [60, t("每 1 分钟", "Every minute")], [300, t("每 5 分钟", "Every 5 min")], [900, t("每 15 分钟", "Every 15 min")]].map(([value, label]) => <Select.Item value={String(value)} key={value}>{label}</Select.Item>)}</Select.Content>
          </Select.Root></span>
        </Tooltip>
        <Button loading={busy === "refresh"} disabled={busy !== null} onClick={refresh}><RefreshCw size={15} />{t("更新行情", "Refresh quotes")}</Button>
      </div>
    </div>}
  </div>;
}

function CurrentPage() {
  const { view } = useWorkspace();
  if (view === "portfolio") return <ManagedPortfolioPage />;
  if (view === "evidence") return <EvidencePage />;
  if (view === "journal") return <JournalPage />;
  if (view === "arena") return <ArenaPage />;
  if (view === "paper") return <PaperTradingPage />;
  return <MarketPage />;
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
  const [palette, setPalette] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // A request from the palette to open one arena account; the arena page consumes it.
  const [arenaFocus, setArenaFocus] = useState(null);
  const openArenaAccount = useCallback((id, market) => { setArenaFocus({ id, market, at: Date.now() }); setView("arena"); }, []);
  // Fullscreen = the browser's fullscreen plus a wide layout without the sidebar (navigate with ⌘K).
  // Without the Fullscreen API (embedded webviews) the wide layout alone still applies.
  const toggleFullscreen = useCallback(async () => {
    const root = document.documentElement;
    if (document.fullscreenElement) { await document.exitFullscreen().catch(() => {}); setFullscreen(false); return; }
    if (fullscreen) { setFullscreen(false); return; }
    setFullscreen(true);
    if (root.requestFullscreen) await root.requestFullscreen().catch(() => {});
  }, [fullscreen]);
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFullscreen(false); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    const onKey = (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName) || event.target?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setPalette((value) => !value); }
      else if (event.key === "/" && !typing) { event.preventDefault(); setPalette(true); }
      else if (event.key === "Escape" && fullscreen && !document.fullscreenElement && !palette) setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, palette]);
  const t = (zh, en) => language === "en" ? en : zh;
  const notify = useCallback((message, error = false) => setToast({ message, error, id: Date.now() }), []);
  // The agent-managed arena account is the owner's portfolio; manual positions are only a fallback.
  const [arenaAccounts, setArenaAccounts] = useState([]);
  const [managedAccount, setManagedAccount] = useState(null);
  const [managedLoading, setManagedLoading] = useState(true);
  const managedPreference = preferences?.managedAccountId;
  const loadManaged = useCallback(async (signal) => {
    try {
      const board = await api("/api/arena/leaderboard", undefined, signal);
      const accounts = array(board.groups).flatMap((group) => array(group.accounts));
      if (signal?.aborted) return;
      setArenaAccounts(accounts);
      const latest = [...accounts].sort((a, b) => (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0))[0];
      const pick = accounts.find((account) => account.id === managedPreference) ?? latest;
      const detail = pick ? await api(`/api/arena/accounts/${pick.id}`, undefined, signal) : null;
      if (!signal?.aborted) setManagedAccount(detail);
    } catch { /* The arena is optional; the portfolio page shows its onboarding instead. */ }
    finally { if (!signal?.aborted) setManagedLoading(false); }
  }, [managedPreference]);
  useEffect(() => {
    if (loading) return undefined;
    const abort = new AbortController();
    loadManaged(abort.signal);
    const timer = window.setInterval(() => { if (!document.hidden) loadManaged(abort.signal); }, 60000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [loading, loadManaged]);
  const chooseManaged = async (id) => {
    try { const result = await api("/api/preferences", { managedAccountId: id }); setPreferences(result.preferences || result); }
    catch (error) { notify(error.message, true); }
  };
  const managedPositions = useMemo(() => managedAccount?.positions?.map((position) => ({ symbol: position.symbol, quantity: position.quantity, averageCost: position.averageCost, currency: managedAccount.currency })), [managedAccount]);
  const holdings = useMemo(() => holdingsFor(report.items, managedPositions ?? preferences?.positions), [report.items, preferences, managedPositions]);
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
  const managed = { accounts: arenaAccounts, account: managedAccount, loading: managedLoading || loading, choose: chooseManaged, reload: () => loadManaged() };
  const context = { managed, report, view, setView, language, setLanguage, appearance, setAppearance, colorConvention, preferences, decisions, selected, setSelected, timeframe, setTimeframe, clock, busy, loading, holdings, interval, setIntervalSeconds, refresh, syncSources, savePreferences, saveDecision, saveReview, openEditor: setEditor, reloadWorkspace: () => loadWorkspace(), notify,
    openPalette: () => setPalette(true), fullscreen, toggleFullscreen, arenaFocus, openArenaAccount };
  return <Theme appearance={appearance} accentColor="jade" grayColor="slate" radius="large" scaling="100%" panelBackground="solid" className={`workspace-theme ${colorConvention === "red-up" ? "red-up" : "green-up"}`}><WorkspaceContext.Provider value={context}><div className={`workspace-shell ${fullscreen ? "is-fullscreen" : ""}`}><Sidebar /><div className="workspace-main"><Header /><main className="main-content"><PageHeading />{report.demo && view !== "arena" && <div className="demo-banner"><FlaskConical size={15} /><span>{t("演示模式", "DEMO MODE")}</span>{t("全部价格、持仓与事件均为合成样本，不用于真实决策。", "All prices, positions and events are synthetic. Not for real investment decisions.")}</div>}<ErrorNotice message={loadError} onRetry={() => loadWorkspace()} /><CurrentPage /><footer className="workspace-footer"><span><ShieldCheck size={13} />{t("公开行情可能延迟 · 研究不等于交易建议", "Public quotes may be delayed · Research is not a trade recommendation")}</span><a href="https://hrouter.net/" target="_blank" rel="noreferrer">HRouter <ArrowUpRight size={12} /></a></footer></main></div></div><CommandPalette open={palette} onOpenChange={setPalette} views={views} onFullscreen={toggleFullscreen} />{editor && <Editor key={`${editor.type}:${editor.record?.id || ""}`} editor={editor} onClose={() => setEditor(null)} />}<div className="toast-region" aria-live="polite">{toast && <div className={`app-toast ${toast.error ? "error" : ""}`} role={toast.error ? "alert" : "status"}>{toast.error ? <TriangleAlert size={18} /> : <CheckCircle2 size={18} />}<span>{toast.message}</span><IconButton variant="ghost" color="gray" size="1" aria-label={t("关闭通知", "Dismiss notification")} onClick={() => setToast(null)}><X size={14} /></IconButton></div>}</div></WorkspaceContext.Provider></Theme>;
}
