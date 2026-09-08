const MARKETS = {
  A: { timezone: "Asia/Shanghai", currency: "CNY", sessions: [[570, 690], [780, 900]] },
  HK: { timezone: "Asia/Hong_Kong", currency: "HKD", sessions: [[570, 720], [780, 960]] },
  US: { timezone: "America/New_York", currency: "USD", sessions: [[570, 960]] },
};

export const CALENDARS_2026 = {
  A: {
    coverageStart: "2026-01-01", coverageEnd: "2026-12-31", verifiedAt: "2025-12-22T00:00:00Z", reviewedOn: "2026-09-08",
    source: "https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml",
    closedDates: ["01-01", "01-02", "02-16", "02-17", "02-18", "02-19", "02-20", "02-23", "04-06", "05-01", "05-04", "05-05", "06-19", "09-25", "10-01", "10-02", "10-05", "10-06", "10-07"].map((day) => `2026-${day}`),
  },
  HK: {
    coverageStart: "2026-01-01", coverageEnd: "2026-12-31", verifiedAt: "2025-06-02T00:00:00Z", reviewedOn: "2026-09-08",
    source: "https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf",
    closedDates: ["01-01", "02-17", "02-18", "02-19", "04-03", "04-06", "04-07", "05-01", "05-25", "06-19", "07-01", "10-01", "10-19", "12-25"].map((day) => `2026-${day}`),
    sessions: Object.fromEntries(["2026-02-16", "2026-12-24", "2026-12-31"].map((date) => [date, { sessions: [[570, 720]] }])),
  },
  US: {
    coverageStart: "2026-01-01", coverageEnd: "2026-12-31", verifiedAt: "2026-01-01T00:00:00Z", reviewedOn: "2026-09-08",
    source: "https://www.nyse.com/trade/hours-calendars",
    closedDates: ["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"].map((day) => `2026-${day}`),
    sessions: Object.fromEntries(["2026-11-27", "2026-12-24"].map((date) => [date, { sessions: [[570, 780]] }])),
  },
};

export function getInstrumentRules(input, { asOf = new Date().toISOString() } = {}) {
  const symbol = String(input).toUpperCase();
  const market = /\.(SS|SZ)$/.test(symbol) ? "A" : /\.HK$/.test(symbol) || ["^HSI", "^HSTECH", "^HSCE"].includes(symbol) ? "HK" : "US";
  const index = symbol.startsWith("^") || ["000001.SS", "399001.SZ", "399006.SZ"].includes(symbol);
  const fund = market === "A" && /^[15]\d{5}\./.test(symbol);
  const ordinary = market === "A" && !index && !fund && /^(60|68|00|30)\d{4}\./.test(symbol);
  const board = ordinary ? symbol.startsWith("68") ? "STAR" : symbol.startsWith("30") ? "ChiNext" : "main" : null;
  return {
    symbol, market, asOf, currency: market === "A" && symbol.startsWith("900") ? "USD" : market === "A" && symbol.startsWith("200") ? "HKD" : MARKETS[market].currency,
    instrumentType: index ? "index" : fund ? "fund-unclassified" : ordinary || market !== "A" ? "equity" : "unclassified",
    board, minimumHoldingSessions: ordinary ? 1 : market === "A" && !index ? null : 0,
    lotSize: ordinary && board !== "STAR" ? 100 : market === "US" && !index ? 1 : null,
    minimumOrderUnits: ordinary ? board === "STAR" ? 200 : 100 : null,
    orderIncrement: ordinary ? board === "STAR" ? 1 : 100 : null,
    priceLimitPct: ordinary ? board === "main" || board === "ChiNext" && String(asOf).slice(0, 10) < "2020-08-24" ? 10 : 20 : null,
    priceLimitRequiresVerification: market === "A",
    calendar: { timezone: MARKETS[market].timezone, coverage: String(asOf).startsWith("2026-") ? "official-2026" : "weekday-only", holidayCoverage: String(asOf).startsWith("2026-"), ...CALENDARS_2026[market] },
    limitations: ["Board defaults require dated verification for ST, IPO, delisting, funds and exceptional sessions.", "Holiday and half-day schedules must be supplied with dated calendar evidence."],
  };
}

export function localMarketTime(value, market) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKETS[market]?.timezone ?? MARKETS.US.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute), second: Number(parts.second), weekday: parts.weekday };
}

export function marketLocalToIso(date, minute, market) {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day, Math.floor(minute / 60), minute % 60);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = localMarketTime(instant, market);
    const [y, m, d] = local.date.split("-").map(Number);
    instant += target - Date.UTC(y, m - 1, d, Math.floor(local.minute / 60), local.minute % 60, local.second);
  }
  return new Date(instant).toISOString();
}

function calendarFor(market, overrides) {
  if (overrides?.[market]) return overrides[market];
  if (overrides?.coverageStart || overrides?.closedDates || overrides?.sessions) return overrides;
  return CALENDARS_2026[market] ?? {};
}

export function getMarketSession(market, value = new Date().toISOString(), calendarOverrides = {}) {
  const local = localMarketTime(value, market);
  if (!local) return { status: "unknown", calendarCoverage: "unknown", verified: false };
  const calendar = calendarFor(market, calendarOverrides);
  const datedCoverage = calendar.source && calendar.verifiedAt && calendar.coverageStart <= local.date && calendar.coverageEnd >= local.date
    && Number.isFinite(Date.parse(calendar.verifiedAt)) && Date.parse(calendar.verifiedAt) <= Date.parse(value);
  const override = calendar.sessions?.[local.date];
  const verified = Boolean(datedCoverage);
  const closed = calendar.closedDates?.includes(local.date) || override?.closed === true || (!calendar.openDates?.includes(local.date) && ["Sat", "Sun"].includes(local.weekday));
  const sessions = override?.sessions ?? MARKETS[market]?.sessions ?? MARKETS.US.sessions;
  const [open, close] = [sessions[0][0], sessions.at(-1)[1]];
  const status = closed ? "closed" : local.minute < open ? "premarket" : local.minute >= close ? "postmarket" : sessions.some(([start, end]) => local.minute >= start && local.minute < end) ? "open" : "break";
  return { ...local, market, status, sessions, verified, calendarCoverage: verified ? calendar === CALENDARS_2026[market] ? "official-2026" : "dated-override" : "weekday-only", source: verified ? calendar.source : null,
    openAt: marketLocalToIso(local.date, open, market), closeAt: marketLocalToIso(local.date, close, market) };
}

export function assessQuoteFreshness(quote, { now = new Date().toISOString(), maxAgeSeconds = 1200, maxFutureSeconds = 30, calendarOverrides = {} } = {}) {
  const current = Date.parse(now);
  const timestamp = typeof quote.asOf === "string" && quote.asOf.trim() ? Date.parse(quote.asOf) : NaN;
  const session = getMarketSession(quote.market, now, calendarOverrides);
  const ageSeconds = Number.isFinite(timestamp) ? (current - timestamp) / 1000 : null;
  const base = { evaluatedAt: new Date(current).toISOString(), asOf: quote.asOf ?? null, ageSeconds, maxAgeSeconds, session: session.status, calendarCoverage: session.calendarCoverage, signalEligible: false };
  if (ageSeconds === null) return { ...base, status: "unknown-timestamp", reason: "Quote timestamp is missing or invalid." };
  if (ageSeconds < -maxFutureSeconds) return { ...base, status: "future", reason: "Quote timestamp is in the future." };
  if (session.verified && session.status !== "open") {
    // Match the last scheduled trading segment, including lunch breaks and long holidays.
    for (let dayOffset = 0; dayOffset < 30; dayOffset += 1) {
      const date = new Date(Date.parse(`${session.date}T12:00:00Z`) - dayOffset * 86400000).toISOString().slice(0, 10);
      const previous = getMarketSession(quote.market, marketLocalToIso(date, 720, quote.market), calendarOverrides);
      if (!previous.verified || previous.status === "closed") continue;
      const ending = previous.sessions.map(([, end]) => Date.parse(marketLocalToIso(date, end, quote.market))).filter((value) => value <= current).at(-1);
      if (ending === undefined) continue;
      if (timestamp >= ending - maxAgeSeconds * 1000 && timestamp <= ending + maxFutureSeconds * 1000) {
        return { ...base, status: "market-closed", referenceSession: date, expectedCloseAt: new Date(ending).toISOString(), reason: "Latest completed regular-session reference; trading alerts are paused while the market is closed." };
      }
      break;
    }
  }
  if (ageSeconds > maxAgeSeconds) return { ...base, status: "stale", reason: "Quote exceeds the configured maximum age; retained for reference only." };
  if (!session.verified) return { ...base, status: "unverified-calendar", reason: "Recent quote; holiday or special-session calendar has not been verified." };
  if (session.status !== "open") return { ...base, status: "market-closed", reason: "Quote is outside a verified regular trading session." };
  if (localMarketTime(quote.asOf, quote.market)?.date !== session.date) return { ...base, status: "stale", reason: "Quote belongs to another local session." };
  return { ...base, status: "fresh", signalEligible: true, reason: null };
}

export function dailyBarMetadata(timestamp, market, { now = new Date().toISOString(), calendarOverrides = {} } = {}) {
  const session = getMarketSession(market, timestamp, calendarOverrides);
  const close = Date.parse(session.closeAt);
  return { sessionDate: session.date, openAt: session.openAt, closeAt: session.closeAt, availableAt: session.closeAt,
    complete: session.status !== "closed" && Number.isFinite(close) && close < Date.parse(now) - 60000,
    calendarCoverage: session.calendarCoverage };
}

export function sameTimeVolumeRatio(history, market, { now = new Date().toISOString(), intervalMinutes = 5, minSessions = 5 } = {}) {
  const current = localMarketTime(now, market);
  if (!current) return { status: "unavailable", value: null, reason: "Invalid clock.", period: `${intervalMinutes}m` };
  const groups = new Map();
  for (const row of history ?? []) {
    const local = localMarketTime(row.timestamp, market);
    if (!local || local.date > current.date || local.minute + intervalMinutes > current.minute || !Number.isFinite(row.volume) || row.volume < 0) continue;
    const sessions = MARKETS[market]?.sessions ?? MARKETS.US.sessions;
    if (!sessions.some(([start, end]) => local.minute >= start && local.minute < end)) continue;
    if (!groups.has(local.date)) groups.set(local.date, new Map());
    groups.get(local.date).set(local.minute, row.volume);
  }
  const today = groups.get(current.date);
  const expected = (MARKETS[market]?.sessions ?? MARKETS.US.sessions).flatMap(([start, end]) => Array.from({ length: Math.max(0, Math.floor((Math.min(end, current.minute) - start) / intervalMinutes)) }, (_, index) => start + index * intervalMinutes));
  const unavailable = (reason, count = 0) => ({ status: "unavailable", value: null, reason, period: `${intervalMinutes}m`, samples: count, cutoffMinute: current.minute });
  if (!expected.length || !today || expected.some((minute) => !today.has(minute))) return unavailable("Current-session intraday bars are incomplete.");
  const comparable = [...groups].filter(([date, rows]) => date < current.date && expected.every((minute) => rows.has(minute))).slice(-20);
  if (comparable.length < minSessions) return unavailable("Insufficient complete historical sessions at the same local time.", comparable.length);
  const cumulativeVolume = expected.reduce((sum, minute) => sum + today.get(minute), 0);
  const historicalAverage = comparable.reduce((sum, [, rows]) => sum + expected.reduce((total, minute) => total + rows.get(minute), 0), 0) / comparable.length;
  if (historicalAverage <= 0) return unavailable("Historical comparison volume is zero.", comparable.length);
  return { status: "available", value: cumulativeVolume / historicalAverage, cumulativeVolume, historicalAverage, samples: comparable.length, cutoffMinute: current.minute, period: `${intervalMinutes}m` };
}
