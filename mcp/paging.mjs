// Server-side paging and filtering for dashboard lists (reports, digests, account history), so the
// browser never has to load thousands of rows to show twenty.

export const PAGE_DEFAULTS = Object.freeze({ limit: 20, maxLimit: 200 });

export function pageParams(searchParams) {
  const number = (name, fallback) => { const value = Number(searchParams.get(name)); return Number.isFinite(value) ? value : fallback; };
  return {
    offset: Math.max(0, Math.floor(number("offset", 0))),
    limit: Math.min(PAGE_DEFAULTS.maxLimit, Math.max(1, Math.floor(number("limit", PAGE_DEFAULTS.limit)))),
    q: (searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100),
    from: /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get("from") ?? "") ? searchParams.get("from") : null,
    to: /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get("to") ?? "") ? searchParams.get("to") : null,
  };
}

// `from` / `to` are calendar dates (inclusive) compared in the given time zone.
export function inDateRange(at, { from, to }, timeZone = "Asia/Shanghai") {
  if (!from && !to) return true;
  const day = new Date(at).toLocaleDateString("en-CA", { timeZone });
  return (!from || day >= from) && (!to || day <= to);
}

export function paginate(rows, { offset = 0, limit = PAGE_DEFAULTS.limit } = {}) {
  return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
}

export const matchesText = (q, ...values) => !q || values.some((value) => String(value ?? "").toLowerCase().includes(q));
