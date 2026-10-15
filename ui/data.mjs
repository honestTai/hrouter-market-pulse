// Presentation-only helpers. Market facts and research assessments remain server-owned.
export const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
export const array = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];
export function formatNumber(value, digits = 2, language = "zh-CN") {
  return isNumber(value) ? new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : "—";
}
export function formatCompact(value, language = "zh-CN") {
  return isNumber(value) ? new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 2 }).format(value) : "—";
}
export function formatPercent(value, language = "zh-CN") {
  return isNumber(value) ? `${value > 0 ? "+" : ""}${formatNumber(value, 2, language)}%` : "—";
}
export function formatDate(value, language = "zh-CN", timeOnly = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(language, { ...(timeOnly ? {} : { month: "short", day: "2-digit" }), hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
export function safeUrl(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function localized(value, language = "zh-CN") {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const suffix = language === "en" ? "En" : "Zh";
  return value[`title${suffix}`] || value[`name${suffix}`] || value[`message${suffix}`] || value.title || value.name || value.message || value.summary || value.code || "";
}
export function quoteStatus(item, { demo = false, now = Date.now() } = {}) {
  if (item.error) return "error";
  const freshness = item.freshness || item.dataQuality?.freshness || {};
  const status = freshness.status || item.dataQuality?.status;
  if (["stale", "future", "expired", "invalid", "missing_timestamp", "unknown-timestamp"].includes(status) || item.dataQuality?.stale) return "stale";
  if (["closed", "closed_fresh", "session_closed", "fresh_closed", "market-closed"].includes(status)) return "closed";
  if (["fresh", "ok"].includes(status)) {
    if (!demo) {
      const age = now - Date.parse(item.asOf);
      if (!Number.isFinite(age) || age < 0 || age > (freshness.maxAgeSeconds || 300) * 1000) return "stale";
    }
    return "fresh";
  }
  return "unverified";
}
export function crossStatus(item) {
  const status = item.crossCheck?.status;
  if (["matched", "consistent", "aligned"].includes(status)) return "aligned";
  if (["divergent", "currency-mismatch"].includes(status)) return "conflict";
  if (["single_source", "single-source", "fallback", "unavailable"].includes(status) || !status) return "single";
  return "unverified";
}
export function marketIndices(report) {
  const c = report.context || {};
  const rows = c.indices || c.benchmarks || c.marketSnapshot?.indices || [];
  return Array.isArray(rows) ? rows : Object.values(rows).flatMap((v) => array(v, "indices"));
}
export function chartBars(item, timeframe = "daily", type = "line") {
  const interval = item?.period || item?.interval || "1d";
  const raw = timeframe === "daily"
    ? item?.dailyHistory || (interval === "1d" ? item?.history : [])
    : item?.intraday?.history || item?.intradayHistory || (interval !== "1d" ? item?.history : []);
  const result = new Map();
  for (const row of array(raw)) {
    const stamp = row.timestamp ?? row.date ?? row.time;
    const time = typeof stamp === "number" ? Math.floor(stamp > 1e12 ? stamp / 1000 : stamp) : Math.floor(Date.parse(stamp) / 1000);
    if (!Number.isFinite(time) || !isNumber(row.close) || row.close <= 0) continue;
    if (type === "candles" && (!['open', 'high', 'low'].every((k) => isNumber(row[k]) && row[k] > 0) ||
      row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close))) continue;
    result.set(time, { ...row, time });
  }
  return [...result.values()].sort((a, b) => a.time - b.time);
}
export function collectEvidence(report, symbol) {
  const merged = new Map();
  const rows = [...array(report.events), ...array(report.evidence, "items"), ...array(report.items).flatMap((item) =>
    [...array(item.events), ...array(item.evidence), ...array(item.news)].map((e) => ({ ...e, symbol: e.symbol || e.entity?.symbol || item.symbol })))];
  for (const row of rows) {
    const stock = row.symbol || row.entity?.symbol;
    if (symbol && stock !== symbol && !row.affectedSymbols?.includes(symbol)) continue;
    const key = row.id || `${row.sourceUrl || row.url}:${row.title}:${row.publishedAt}`;
    merged.set(key, { ...row, symbol: stock, ...merged.get(key) });
  }
  return [...merged.values()].sort((a, b) => (Date.parse(b.publishedAt || b.availableAt) || 0) - (Date.parse(a.publishedAt || a.availableAt) || 0));
}
export function holdingsFor(items, positions) {
  const source = positions ?? items.filter((i) => i.position).map((i) => ({ ...i.position, symbol: i.symbol }));
  return source.filter((p) => isNumber(p.quantity) && p.quantity > 0).map((p) => {
    const item = items.find((i) => i.symbol === p.symbol);
    const currency = p.currency || item?.currency || "UNKNOWN";
    const compatible = !p.currency || !item?.currency || p.currency === item.currency;
    const price = compatible && isNumber(item?.price) ? item.price : null;
    const product = price !== null ? price * p.quantity : null;
    const marketValue = isNumber(product) ? product : null;
    const costProduct = isNumber(p.averageCost) ? p.averageCost * p.quantity : null;
    const cost = isNumber(costProduct) ? costProduct : null;
    return { ...p, item, currency, price, marketValue, currencyMismatch: !compatible,
      pnl: marketValue !== null && cost !== null ? marketValue - cost : null,
      pnlPct: marketValue !== null && cost > 0 ? (marketValue / cost - 1) * 100 : null };
  });
}
export function portfolioGroups(holdings) {
  const groups = new Map();
  for (const position of holdings) {
    const group = groups.get(position.currency) || { currency: position.currency, count: 0, priced: 0, costed: 0, marketValue: 0, pnl: 0 };
    group.count++;
    if (isNumber(position.marketValue)) { group.priced++; group.marketValue += position.marketValue; }
    if (isNumber(position.pnl)) { group.costed++; group.pnl += position.pnl; }
    groups.set(group.currency, group);
  }
  return [...groups.values()].map((g) => ({ ...g, marketValue: g.priced ? g.marketValue : null, pnl: g.costed ? g.pnl : null }));
}
export function readStorage(key, fallback) {
  try { return localStorage.getItem(`hrouter.${key}`) ?? fallback; } catch { return fallback; }
}
export function writeStorage(key, value) {
  try { localStorage.setItem(`hrouter.${key}`, value); } catch { /* Private browsing can disable storage. */ }
}
export async function api(url, body, signal) {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", signal,
    headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
  return result;
}
