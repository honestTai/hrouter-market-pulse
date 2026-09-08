import { getInstrumentRules, getMarketSession, marketLocalToIso } from "./market-rules.mjs";

const number = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export function researchAsOf(value, now = new Date()) {
  const date = value ? new Date(value) : now;
  if (!Number.isFinite(date.getTime()) || date > now) throw new Error("asOf must be a valid timestamp no later than now");
  return date.toISOString();
}

export function prepareDailyHistory(symbol, history, asOf = new Date().toISOString()) {
  const cutoff = Date.parse(researchAsOf(asOf));
  const rules = getInstrumentRules(symbol, { asOf });
  const timeZone = rules.calendar?.timezone ?? (symbol.endsWith(".HK") ? "Asia/Hong_Kong" : /\.(SS|SZ)$/.test(symbol) ? "Asia/Shanghai" : "America/New_York");
  const dates = new Set();
  const rows = [];
  const excluded = { unfinished: 0, invalid: 0, duplicate: 0 };
  let gapBefore = false;
  for (const source of [...(history ?? [])].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))) {
    const timestamp = Date.parse(source.timestamp);
    if (!Number.isFinite(timestamp)) { excluded.invalid += 1; gapBefore = true; continue; }
    const date = source.sessionDate ?? (/^\d{4}-\d{2}-\d{2}$/.test(source.timestamp) ? source.timestamp : new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp)));
    const session = getMarketSession(rules.market, marketLocalToIso(date, 12 * 60, rules.market));
    if (session.status === "closed") { excluded.invalid += 1; continue; }
    const openAt = source.openAt ?? session.openAt;
    const closeAt = source.closeAt ?? session.closeAt;
    const availableAt = new Date(Math.max(Date.parse(closeAt), Date.parse(source.availableAt ?? closeAt))).toISOString();
    if (source.complete === false || source.isComplete === false || Date.parse(availableAt) > cutoff) { excluded.unfinished += 1; continue; }
    const row = { ...source, sessionDate: date, timestamp: openAt, openAt, closeAt, availableAt };
    if (![row.open, row.high, row.low, row.close].every((value) => number(value) > 0) || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close) || Date.parse(openAt) >= Date.parse(closeAt)) { excluded.invalid += 1; gapBefore = true; continue; }
    if (dates.has(date)) { excluded.duplicate += 1; continue; }
    dates.add(date);
    rows.push({ ...row, gapBefore });
    gapBefore = false;
  }
  rows.sort((left, right) => Date.parse(left.openAt) - Date.parse(right.openAt));
  return { rows, excluded, rules };
}

export function adjustedIndicatorRows(rows) {
  const factor = (row) => number(row.adjustmentFactor) ?? (number(row.adjustedClose) > 0 ? row.adjustedClose / row.close : 1);
  const latestFactor = factor(rows.at(-1));
  if (!(latestFactor > 0)) throw new Error("Invalid corporate-action adjustment factor");
  return rows.map((row) => {
    const multiplier = factor(row) / latestFactor;
    if (!(multiplier > 0)) throw new Error("Invalid corporate-action adjustment factor");
    return { ...row, open: row.open * multiplier, high: row.high * multiplier, low: row.low * multiplier, close: row.close * multiplier };
  });
}

export function executionHistory(quote) {
  if (quote.historyPriceBasis !== "split-adjusted") return quote;
  const splits = (quote.corporateActions ?? []).filter((action) => action.type === "split");
  if (splits.some((action) => !(number(action.ratio) > 0) || !Number.isFinite(Date.parse(action.effectiveAt)))) throw new Error("Split reconstruction requires dated positive ratios");
  const factorAfter = (date) => splits.filter((action) => String(action.date ?? action.effectiveAt).slice(0, 10) > String(date).slice(0, 10)).reduce((factor, action) => factor * action.ratio, 1);
  // Yahoo OHLC already includes later splits; undo that basis before simulating historical share counts.
  const history = (quote.history ?? []).map((row) => {
    const factor = factorAfter(row.sessionDate ?? row.openAt ?? row.timestamp);
    const close = row.close * factor;
    return { ...row, open: row.open * factor, high: row.high * factor, low: row.low * factor, close, volume: number(row.volume) === null ? null : row.volume / factor, adjustmentFactor: row.adjustedClose > 0 && close > 0 ? row.adjustedClose / close : (number(row.adjustmentFactor) ?? 1) / factor };
  });
  const corporateActions = (quote.corporateActions ?? []).map((action) => action.type === "dividend" ? { ...action, cashPerShare: action.cashPerShare * factorAfter(action.effectiveAt) } : action);
  return { ...quote, history, corporateActions, historyPriceBasis: "reconstructed-unadjusted", sourceHistoryPriceBasis: "split-adjusted" };
}

export function fillRestriction(symbol, row, previous, side) {
  if (!(number(row?.volume) > 0) || row.suspended === true) return "no-volume-or-suspended";
  const rules = getInstrumentRules(symbol, { asOf: row.openAt });
  if (row[side === "buy" ? "buyBlocked" : "sellBlocked"] === true) return "provider-reported-unfillable";
  const limit = number(row.priceLimitPct) ?? number(rules.priceLimitPct);
  if (limit && previous?.close > 0) {
    const reference = number(row.previousClose) ?? previous.close;
    const tolerance = number(rules.tickSize) ?? 0.01;
    const limitPrice = reference * (1 + (side === "buy" ? limit : -limit) / 100);
    const executionPrice = side === "buy" ? row.open : row.close;
    if (side === "buy" ? executionPrice >= limitPrice - tolerance / 2 : executionPrice <= limitPrice + tolerance / 2) return side === "buy" ? "limit-up-no-assumed-fill" : "limit-down-no-assumed-fill";
  }
  return null;
}

export function simulatePortfolio({ candidates, histories, initialCapital = 100000, currency = "USD", fxRates = {}, maxPositionPct = 20, maxGrossExposurePct = 100, transactionCostBps = 10, slippageBps = 5, lotSizes = {}, corporateActions = {} }) {
  if (!(number(initialCapital) > 0)) throw new Error("initialCapital must be positive");
  if (!(maxPositionPct > 0 && maxPositionPct <= 100 && maxGrossExposurePct > 0 && maxGrossExposurePct <= 100)) throw new Error("Position and gross exposure caps must be in (0, 100]");
  if (!(transactionCostBps >= 0 && transactionCostBps <= 500 && slippageBps >= 0 && slippageBps <= 500)) throw new Error("Costs and slippage must be between 0 and 500 basis points");
  currency = String(currency).toUpperCase();
  const events = [];
  const conversion = (symbol) => {
    const native = getInstrumentRules(symbol).currency;
    const rate = native === currency ? 1 : number(fxRates[native]);
    if (!(rate > 0)) throw new Error(`Missing positive ${native}/${currency} FX rate for ${symbol}`);
    return rate;
  };
  for (const [symbol, rows] of Object.entries(histories)) {
    conversion(symbol);
    for (const row of rows) {
      events.push({ time: row.openAt, type: "open-mark", symbol, row });
      events.push({ time: row.closeAt, type: "mark", symbol, row });
    }
    for (const action of corporateActions[symbol] ?? []) events.push({ time: action.effectiveAt, type: "action", symbol, action });
  }
  for (const candidate of candidates) {
    events.push({ time: candidate.entryAt, type: "entry", candidate, symbol: candidate.symbol });
    if (candidate.exitAt) events.push({ time: candidate.exitAt, type: "exit", candidate, symbol: candidate.symbol });
  }
  const priority = { action: 0, "open-mark": 1, exit: 2, mark: 3, entry: 4 };
  events.sort((left, right) => Date.parse(left.time) - Date.parse(right.time) || priority[left.type] - priority[right.type] || left.symbol.localeCompare(right.symbol));
  let cash = Number(initialCapital);
  const active = new Map();
  const marks = new Map();
  const trades = [];
  const skipped = [];
  const equityCurve = [];
  const fee = transactionCostBps / 10000;
  const slippage = slippageBps / 10000;
  const valueOf = (position) => position.units * (marks.get(position.symbol) ?? position.entryPrice) * conversion(position.symbol);
  const grossValue = () => [...active.values()].reduce((sum, position) => sum + valueOf(position), 0);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const position = active.get(event.symbol);
    if (event.type === "action" && position && Date.parse(position.entryAt) < Date.parse(event.time)) {
      if (event.action.type === "split") {
        position.units *= event.action.ratio;
        if (marks.has(event.symbol)) marks.set(event.symbol, marks.get(event.symbol) / event.action.ratio);
      } else if (event.action.type === "dividend") {
        const dividend = position.units * event.action.cashPerShare * conversion(event.symbol);
        cash += dividend;
        position.dividends += dividend;
      }
    } else if (event.type === "mark" || event.type === "open-mark") marks.set(event.symbol, event.type === "mark" ? event.row.close : event.row.open);
    else if (event.type === "exit" && position?.id === event.candidate.id) {
      const exitPrice = event.candidate.exitPrice * (1 - slippage);
      const proceeds = position.units * exitPrice * conversion(event.symbol) * (1 - fee);
      cash += proceeds;
      const pnl = proceeds + position.dividends - position.cost;
      trades.push({ ...event.candidate, units: position.initialUnits, exitUnits: position.units, entryPrice: round(position.entryPrice), exitPrice: round(exitPrice), entryValue: round(position.cost, 2), exitValue: round(proceeds, 2), dividends: round(position.dividends, 2), pnl: round(pnl, 2), grossReturnPct: round(((event.candidate.exitPrice * position.units * conversion(event.symbol) + position.dividends) / (event.candidate.entryPrice * position.initialUnits * conversion(event.symbol)) - 1) * 100, 3), netReturnPct: round(pnl / position.cost * 100, 3), currency });
      active.delete(event.symbol);
    } else if (event.type === "entry") {
      if (position) { skipped.push({ symbol: event.symbol, entryAt: event.time, reason: "existing-position" }); continue; }
      const rules = getInstrumentRules(event.symbol, { asOf: event.time });
      const increment = number(lotSizes[event.symbol]) ?? number(rules.orderIncrement) ?? number(rules.lotSize);
      if (!(increment > 0)) { skipped.push({ symbol: event.symbol, entryAt: event.time, reason: "unverified-board-lot" }); continue; }
      const minimum = number(rules.minimumOrderUnits) ?? increment;
      const equity = cash + grossValue();
      const budget = Math.max(0, Math.min(cash, equity * maxPositionPct / 100, equity * maxGrossExposurePct / 100 - grossValue()));
      const entryPrice = event.candidate.entryPrice * (1 + slippage);
      const unitCost = entryPrice * conversion(event.symbol) * (1 + fee);
      const units = Math.floor(budget / unitCost / increment) * increment;
      if (units < minimum) { skipped.push({ symbol: event.symbol, entryAt: event.time, reason: "insufficient-cash-or-risk-budget" }); continue; }
      const cost = units * unitCost;
      cash -= cost;
      marks.set(event.symbol, event.candidate.entryPrice);
      active.set(event.symbol, { ...event.candidate, units, initialUnits: units, cost, dividends: 0, entryPrice });
    }
    if (index === events.length - 1 || events[index + 1].time !== event.time) equityCurve.push({ at: event.time, equity: round(cash + grossValue(), 2), cash: round(cash, 2), grossExposure: round(grossValue(), 2), openPositions: active.size });
  }
  let peak = Number(initialCapital);
  let maximumDrawdownPct = 0;
  for (const row of equityCurve) {
    peak = Math.max(peak, row.equity);
    maximumDrawdownPct = Math.min(maximumDrawdownPct, (row.equity / peak - 1) * 100);
  }
  const finalEquity = cash + grossValue();
  return { trades, skipped, openPositions: [...active.values()].map((item) => ({ symbol: item.symbol, entryAt: item.entryAt, units: item.units, marketValue: round(valueOf(item), 2), cost: round(item.cost, 2), status: "open-unrealized" })), equityCurve, metrics: { initialCapital: Number(initialCapital), finalEquity: round(finalEquity, 2), cash: round(cash, 2), currency, portfolioReturnPct: round((finalEquity / initialCapital - 1) * 100, 3), maximumDrawdownPct: round(maximumDrawdownPct, 3), realizedPnl: round(trades.reduce((sum, item) => sum + item.pnl, 0), 2) } };
}

export function purgedWalkForwardFolds(samples, { folds = 3, minimumTraining = 100, minimumEvaluation = 30, holdoutPct = 30 } = {}) {
  const ordered = [...samples].sort((left, right) => Date.parse(left.featureAt) - Date.parse(right.featureAt));
  const evaluationCount = Math.max(minimumEvaluation * folds, Math.floor(ordered.length * holdoutPct / 100));
  const first = ordered.length - evaluationCount;
  if (first < minimumTraining) return [];
  const foldSize = Math.floor(evaluationCount / folds);
  const results = [];
  for (let fold = 0; fold < folds; fold += 1) {
    const start = first + fold * foldSize;
    const evaluation = ordered.slice(start, fold === folds - 1 ? ordered.length : start + foldSize);
    const boundary = Date.parse(evaluation[0]?.featureAt);
    const training = ordered.slice(0, start).filter((sample) => Date.parse(sample.resolvedAt) < boundary);
    if (training.length < minimumTraining || evaluation.length < minimumEvaluation) continue;
    results.push({ fold: fold + 1, training, evaluation, purged: start - training.length });
  }
  return results;
}

export function qualifyPrediction({ folds, calibration, baselineCalibration, auc, latestFeaturesComplete, stale, drift = false }) {
  const reasons = [];
  if (folds.length < 3) reasons.push("at-least-three-walk-forward-folds-required");
  if ((calibration?.observations ?? 0) < 90) reasons.push("at-least-90-out-of-sample-observations-required");
  if (!latestFeaturesComplete) reasons.push("latest-features-incomplete");
  if (stale) reasons.push("historical-data-stale");
  if (drift) reasons.push("feature-drift-detected");
  if (!(auc >= 0.55)) reasons.push("auc-below-0.55");
  if (!(calibration?.brierScore < baselineCalibration?.brierScore && calibration?.logLoss < baselineCalibration?.logLoss)) reasons.push("does-not-beat-training-prevalence-baseline");
  if (!(calibration?.expectedCalibrationError <= 0.1)) reasons.push("calibration-error-above-0.10");
  if (folds.some((fold) => !(fold.brierSkill > 0))) reasons.push("not-consistently-better-than-baseline-across-folds");
  const rejected = !latestFeaturesComplete || drift || (Number.isFinite(auc) && auc < 0.5);
  return { status: reasons.length ? rejected ? "rejected" : "observe" : "qualified", qualified: reasons.length === 0, reasons, newExposureAllowed: reasons.length === 0, recommendedNewExposure: reasons.length ? 0 : null, qualificationMeaning: "Research review eligibility only; not a trade recommendation or proof of expected profit." };
}
