import React, { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, VisuallyHidden } from "@radix-ui/themes";
import { CornerDownLeft, Maximize2, Moon, Plus, RefreshCw, Search, Settings2, Sun } from "lucide-react";
import { useWorkspace } from "../context.jsx";

// ⌘K / Ctrl+K palette: jump to any page, arena account or security, or run a workspace action.
// Matching is a case-insensitive substring over Chinese and English labels, ids, models and symbols.
export function CommandPalette({ open, onOpenChange, views, onFullscreen }) {
  const { t, setView, managed, report, setSelected, openEditor, refresh, appearance, setAppearance, openArenaAccount } = useWorkspace();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const list = useRef(null);
  useEffect(() => { if (open) { setQuery(""); setCursor(0); } }, [open]);

  const entries = useMemo(() => {
    const pages = views.map(({ id, icon, labels, keywords = "" }) => ({ key: `view:${id}`, group: t("页面", "Pages"), icon, label: t(...labels), text: `${labels.join(" ")} ${id} ${keywords}`, run: () => setView(id) }));
    const accounts = (managed?.accounts ?? []).map((account) => ({
      key: `account:${account.id}`, group: t("竞技场账户", "Arena accounts"), label: account.name,
      hint: `${account.market} · ${account.model}`, text: `${account.name} ${account.model} ${account.agent?.label ?? ""} ${account.id} ${account.market}`,
      run: () => openArenaAccount(account.id, account.market),
    }));
    const seen = new Set();
    const securities = [...(report?.items ?? []), ...(managed?.account?.positions ?? [])].filter((item) => item.symbol && !seen.has(item.symbol) && seen.add(item.symbol)).map((item) => ({
      key: `symbol:${item.symbol}`, group: t("股票", "Securities"), label: item.nameZh || item.name || item.symbol, hint: item.symbol,
      text: `${item.symbol} ${item.name ?? ""} ${item.nameZh ?? ""} ${item.nameEn ?? ""}`,
      run: () => { setView("market"); setSelected?.(item.symbol); },
    }));
    const actions = [
      { key: "act:refresh", icon: RefreshCw, label: t("更新行情", "Refresh quotes"), text: "refresh 更新 行情 刷新", run: () => { setView("market"); refresh(); } },
      { key: "act:fullscreen", icon: Maximize2, label: t("全屏 / 退出全屏", "Toggle fullscreen"), text: "fullscreen 全屏 专注", run: onFullscreen },
      { key: "act:theme", icon: appearance === "light" ? Moon : Sun, label: appearance === "light" ? t("切换深色模式", "Dark mode") : t("切换浅色模式", "Light mode"), text: "theme dark light 深色 浅色 主题", run: () => setAppearance(appearance === "light" ? "dark" : "light") },
      { key: "act:settings", icon: Settings2, label: t("自选与持仓设置", "Watchlist & settings"), text: "settings 设置 自选 偏好", run: () => openEditor({ type: "settings" }) },
      { key: "act:decision", icon: Plus, label: t("新建研究记录", "New decision"), text: "new decision 新建 研究 记录", run: () => openEditor({ type: "decision" }) },
    ].map((entry) => ({ ...entry, group: t("操作", "Actions") }));
    return [...pages, ...accounts, ...securities, ...actions];
  }, [views, managed, report, appearance, t, setView, setSelected, openEditor, refresh, setAppearance, onFullscreen, openArenaAccount]);

  const needle = query.trim().toLowerCase();
  const matches = (needle ? entries.filter((entry) => `${entry.label} ${entry.text}`.toLowerCase().includes(needle)) : entries).slice(0, 60);
  const active = Math.min(cursor, Math.max(0, matches.length - 1));
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const choose = (entry) => { if (!entry) return; onOpenChange(false); entry.run?.(); };
  const onKeyDown = (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((value) => Math.min(matches.length - 1, value + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((value) => Math.max(0, value - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(matches[active]); }
  };
  let lastGroup = null;
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Content className="command-palette" maxWidth="620px" aria-describedby={undefined}>
      <VisuallyHidden><Dialog.Title>{t("搜索", "Search")}</Dialog.Title></VisuallyHidden>
      <div className="command-input"><Search size={17} /><input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setCursor(0); }} onKeyDown={onKeyDown} placeholder={t("搜索页面、Agent 账户、股票或操作…", "Search pages, agent accounts, securities or actions…")} aria-label={t("搜索", "Search")} /><kbd>Esc</kbd></div>
      <div className="command-list" ref={list} role="listbox">
        {matches.map((entry, index) => {
          const heading = entry.group !== lastGroup ? <div className="command-group" key={`g:${entry.group}`}>{entry.group}</div> : null;
          lastGroup = entry.group;
          const Icon = entry.icon;
          return <React.Fragment key={entry.key}>{heading}<button type="button" role="option" aria-selected={index === active} data-index={index} className={`command-item ${index === active ? "active" : ""}`} onMouseMove={() => setCursor(index)} onClick={() => choose(entry)}>
            <span className="command-icon">{Icon ? <Icon size={15} /> : <span className="command-dot" />}</span>
            <span className="command-label">{entry.label}</span>
            {entry.hint && entry.hint !== entry.label && <span className="command-hint">{entry.hint}</span>}
            {index === active && <CornerDownLeft size={13} className="command-enter" />}
          </button></React.Fragment>;
        })}
        {!matches.length && <div className="command-empty">{t("没有匹配的结果", "No results")}</div>}
      </div>
    </Dialog.Content>
  </Dialog.Root>;
}
