import React from "react";
import { Badge, Button, Tooltip, IconButton, Callout } from "@radix-ui/themes";
import { ArrowUpRight, ArrowDownRight, CircleHelp, Inbox, Maximize2, Minimize2, TriangleAlert, RefreshCw } from "lucide-react";
import { useWorkspace } from "../context.jsx";
import { isNumber, quoteStatus, crossStatus } from "../data.mjs";

export function Change({ value, className = "", arrows = false, suffix = true }) {
  const { percent, number } = useWorkspace();
  const Icon = value > 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={`change ${isNumber(value) ? value > 0 ? "gain" : value < 0 ? "loss" : "neutral" : "neutral"} ${className}`}>
    {arrows && isNumber(value) && value !== 0 && <Icon size={15} />}{suffix ? percent(value) : number(value)}
  </span>;
}
export function Help({ children }) {
  return <Tooltip content={children}><IconButton variant="ghost" color="gray" size="1" aria-label={children}><CircleHelp size={13} /></IconButton></Tooltip>;
}
export function Empty({ icon: Icon = Inbox, title, description, action, compact = false }) {
  return <div className={`empty-state ${compact ? "compact" : ""}`}><div className="empty-icon"><Icon size={26} strokeWidth={1.5} /></div><h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}
export function Status({ item, cross = false }) {
  const { report, clock, t } = useWorkspace();
  const state = cross ? crossStatus(item) : quoteStatus(item, { demo: report.demo, now: clock });
  const labels = {
    fresh: ["时效通过", "Fresh quote"], closed: ["休市参考", "Closed session"], stale: ["过期 / 时间异常", "Stale / invalid time"],
    error: ["数据不可用", "Unavailable"], unverified: ["待核验", "Unverified"],
    aligned: ["双源一致", "Cross-checked"], conflict: ["来源冲突", "Source conflict"], single: ["单一来源", "Single source"],
  };
  const label = labels[state] || labels.unverified;
  return <Badge variant="soft" color={["fresh", "aligned"].includes(state) ? "jade" : ["error", "conflict"].includes(state) ? "red" : "amber"} size="1"><span className="status-dot" />{t(...label)}</Badge>;
}
export function ErrorNotice({ message, onRetry }) {
  const { t } = useWorkspace();
  if (!message) return null;
  return <Callout.Root color="red" size="1" role="alert"><Callout.Icon><TriangleAlert size={16} /></Callout.Icon><Callout.Text>{message}{onRetry && <Button variant="ghost" color="red" size="1" onClick={onRetry}><RefreshCw size={13} />{t("重试", "Retry")}</Button>}</Callout.Text></Callout.Root>;
}
export function SectionHeading({ icon: Icon, title, caption, actions, expandable = false }) {
  return <div className="section-heading"><div className="section-title">{Icon && <Icon size={17} />}<h2>{title}</h2>{caption && <span className="muted small">{caption}</span>}</div>{(actions || expandable) && <div className="section-actions">{actions}{expandable && <FullscreenButton />}</div>}</div>;
}

// Shows the surrounding panel (.surface) in fullscreen; charts inside grow with it.
export function FullscreenButton() {
  const { t } = useWorkspace();
  const button = React.useRef(null);
  const [active, setActive] = React.useState(false);
  React.useEffect(() => {
    const onChange = () => setActive(Boolean(document.fullscreenElement && button.current && document.fullscreenElement.contains(button.current)));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  if (typeof document !== "undefined" && !document.documentElement.requestFullscreen) return null;
  const toggle = () => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    button.current?.closest(".surface, .fullscreen-target")?.requestFullscreen().catch(() => {});
  };
  return <Tooltip content={active ? t("退出全屏（Esc）", "Exit fullscreen (Esc)") : t("全屏查看", "Fullscreen")}><IconButton ref={button} type="button" size="1" variant="ghost" color="gray" aria-label={active ? t("退出全屏", "Exit fullscreen") : t("全屏查看", "Fullscreen")} onClick={toggle}>{active ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</IconButton></Tooltip>;
}
export function StockMark({ symbol, market, small = false }) {
  return <span className={`stock-mark ${small ? "small" : ""} market-${market || "US"}`}>{symbol?.replace(/\.(HK|SS|SZ|BJ)$/, "").slice(0, 2) || "—"}</span>;
}
