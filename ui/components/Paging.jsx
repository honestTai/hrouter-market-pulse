import React, { useCallback, useEffect, useRef, useState } from "react";
import { IconButton, Select, TextField } from "@radix-ui/themes";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Search, X } from "lucide-react";
import { useWorkspace } from "../context.jsx";
import { api } from "../data.mjs";

export const PAGE_SIZES = [20, 50, 100];

// Debounce a fast-changing value (search text) so typing does not fire a request per keystroke.
export function useDebounced(value, delay = 250) {
  const [current, setCurrent] = useState(value);
  useEffect(() => { const timer = window.setTimeout(() => setCurrent(value), delay); return () => window.clearTimeout(timer); }, [value, delay]);
  return current;
}

// Server-side paged list. `params` are filters (empty values are dropped); changing any filter goes
// back to page 1. The previous page stays on screen while the next one loads, so nothing jumps.
export function usePagedList(path, params, { pageSize: initialSize = 20, refreshMs = 0, itemsKey = "items" } = {}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const key = JSON.stringify(params);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setPage(1); }, [key, pageSize]);
  const load = useCallback(async (signal) => {
    if (!path) return;
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(JSON.parse(key))) if (value !== undefined && value !== null && value !== "" && value !== "all") query.set(name, value);
    query.set("offset", String((page - 1) * pageSize));
    query.set("limit", String(pageSize));
    setLoading(true);
    try {
      const next = await api(`${path}${path.includes("?") ? "&" : "?"}${query}`, undefined, signal);
      if (!signal?.aborted) { setData(next); setError(""); }
    } catch (failure) { if (!signal?.aborted) setError(failure.message); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [path, key, page, pageSize]);
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal);
    const timer = refreshMs ? window.setInterval(() => { if (!document.hidden) load(abort.signal); }, refreshMs) : null;
    return () => { abort.abort(); if (timer) window.clearInterval(timer); };
  }, [load, refreshMs]);
  return { data, items: data?.[itemsKey] ?? [], total: data?.total ?? 0, page, setPage, pageSize, setPageSize, loading, error, reload: () => load() };
}

// Client-side paging for lists that are already in memory.
export function useLocalPage(rows, initialSize = 20, resetKey = "") {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialSize);
  useEffect(() => { setPage(1); }, [resetKey, pageSize]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages);
  return { items: rows.slice((current - 1) * pageSize, current * pageSize), total: rows.length, page: current, setPage, pageSize, setPageSize };
}

function pageList(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const set = new Set([1, pages, page, page - 1, page + 1].filter((value) => value >= 1 && value <= pages));
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  sorted.forEach((value, index) => { if (index && value - sorted[index - 1] > 1) out.push("…"); out.push(value); });
  return out;
}

export function Pager({ total, page, pageSize, onPage, onPageSize, loading = false, compact = false }) {
  const { t } = useWorkspace();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (!total) return null;
  const start = (page - 1) * pageSize + 1, end = Math.min(total, page * pageSize);
  return <nav className={`pager ${compact ? "compact" : ""} ${loading ? "loading" : ""}`} aria-label={t("分页", "Pagination")}>
    <span className="pager-range muted small">{t(`第 ${start}–${end} 条，共 ${total} 条`, `${start}–${end} of ${total}`)}</span>
    <span className="pager-buttons">
      <IconButton size="1" variant="ghost" color="gray" disabled={page <= 1} onClick={() => onPage(1)} aria-label={t("第一页", "First page")}><ChevronsLeft size={14} /></IconButton>
      <IconButton size="1" variant="ghost" color="gray" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t("上一页", "Previous page")}><ChevronLeft size={14} /></IconButton>
      {!compact && pageList(page, pages).map((value, index) => value === "…" ? <span key={`gap${index}`} className="pager-gap">…</span> : <button key={value} type="button" className={`pager-page ${value === page ? "active" : ""}`} aria-current={value === page ? "page" : undefined} onClick={() => onPage(value)}>{value}</button>)}
      {compact && <span className="small tabular">{page} / {pages}</span>}
      <IconButton size="1" variant="ghost" color="gray" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t("下一页", "Next page")}><ChevronRight size={14} /></IconButton>
      <IconButton size="1" variant="ghost" color="gray" disabled={page >= pages} onClick={() => onPage(pages)} aria-label={t("最后一页", "Last page")}><ChevronsRight size={14} /></IconButton>
    </span>
    {onPageSize && !compact && <Select.Root size="1" value={String(pageSize)} onValueChange={(value) => onPageSize(Number(value))}><Select.Trigger variant="ghost" aria-label={t("每页条数", "Rows per page")} /><Select.Content>{PAGE_SIZES.map((size) => <Select.Item key={size} value={String(size)}>{t(`${size} 条/页`, `${size} / page`)}</Select.Item>)}</Select.Content></Select.Root>}
  </nav>;
}

export function SearchField({ value, onChange, placeholder, width }) {
  const { t } = useWorkspace();
  return <TextField.Root size="2" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} style={width ? { width } : undefined} aria-label={placeholder}>
    <TextField.Slot><Search size={15} /></TextField.Slot>
    {value && <TextField.Slot><IconButton size="1" variant="ghost" color="gray" onClick={() => onChange("")} aria-label={t("清空", "Clear")}><X size={13} /></IconButton></TextField.Slot>}
  </TextField.Root>;
}

// Date range filter: two native date inputs (inclusive), plus quick presets.
export function DateRange({ from, to, onChange }) {
  const { t } = useWorkspace();
  const iso = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toLocaleDateString("en-CA");
  const preset = from === iso(0) && !to ? "today" : from === iso(6) && !to ? "7d" : from === iso(29) && !to ? "30d" : !from && !to ? "all" : "custom";
  return <div className="date-range">
    <Select.Root size="2" value={preset} onValueChange={(value) => { if (value === "all") onChange({ from: "", to: "" }); else if (value === "today") onChange({ from: iso(0), to: "" }); else if (value === "7d") onChange({ from: iso(6), to: "" }); else if (value === "30d") onChange({ from: iso(29), to: "" }); }}>
      <Select.Trigger variant="surface" aria-label={t("时间范围", "Date range")} />
      <Select.Content><Select.Item value="all">{t("全部时间", "All time")}</Select.Item><Select.Item value="today">{t("今天", "Today")}</Select.Item><Select.Item value="7d">{t("近 7 天", "Last 7 days")}</Select.Item><Select.Item value="30d">{t("近 30 天", "Last 30 days")}</Select.Item>{preset === "custom" && <Select.Item value="custom">{t("自定义", "Custom")}</Select.Item>}</Select.Content>
    </Select.Root>
    <input type="date" className="native-date" value={from} max={to || undefined} onChange={(event) => onChange({ from: event.target.value, to })} aria-label={t("开始日期", "From")} />
    <span className="muted small">–</span>
    <input type="date" className="native-date" value={to} min={from || undefined} onChange={(event) => onChange({ from, to: event.target.value })} aria-label={t("结束日期", "To")} />
  </div>;
}
