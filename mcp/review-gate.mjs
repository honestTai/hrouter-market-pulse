// Decide when an agent review is worth its tokens. Scripts look first: a scheduled review is skipped
// when nothing changed since the last one (and the quiet period has not run out), and a review starts
// early when something the trader must react to happens (a fill, a stop, an owner instruction or
// decision, a sharp move in a holding). A daily token budget slows reviews down, then stops them.

const round = (value, digits = 2) => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

export const GATE_DEFAULTS = Object.freeze({ enabled: true, movePct: 2, maxQuietMinutes: 60 });
export const WAKE_DEFAULTS = Object.freeze({ enabled: true, movePct: 4, minMinutes: 5, maxPerDay: 10 });
export const BUDGET_DEFAULTS = Object.freeze({ dailyTokens: null, slowAtPct: 80 });

const URGENT_EVENTS = {
  "stop-loss": "止损触发", "take-profit": "止盈触发", "risk-breaker": "回撤熔断", "exit-deferred": "止损没能执行",
  "approval-approved": "主人确认了订单", "approval-rejected": "主人拒绝了订单", "suspended": "持仓停牌",
};

export class GateError extends Error {}

function bounded(value, low, high, name, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < low || number > high || (integer && !Number.isInteger(number))) throw new GateError(`${name} must be ${integer ? "a whole number " : ""}between ${low} and ${high}.`);
  return integer ? number : round(number, 2);
}

export function sanitizeGate(input, current = GATE_DEFAULTS) {
  if (input === null) return { ...GATE_DEFAULTS, enabled: false };
  const next = { ...GATE_DEFAULTS, ...current };
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.movePct !== undefined) next.movePct = bounded(input.movePct, 0.5, 20, "gate.movePct");
  if (input.maxQuietMinutes !== undefined) next.maxQuietMinutes = bounded(input.maxQuietMinutes, 10, 480, "gate.maxQuietMinutes", true);
  return next;
}

export function sanitizeWake(input, current = WAKE_DEFAULTS) {
  if (input === null) return { ...WAKE_DEFAULTS, enabled: false };
  const next = { ...WAKE_DEFAULTS, ...current };
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.movePct !== undefined) next.movePct = bounded(input.movePct, 1, 30, "wake.movePct");
  if (input.minMinutes !== undefined) next.minMinutes = bounded(input.minMinutes, 3, 120, "wake.minMinutes", true);
  if (input.maxPerDay !== undefined) next.maxPerDay = bounded(input.maxPerDay, 0, 50, "wake.maxPerDay", true);
  return next;
}

export function sanitizeBudget(input, current = BUDGET_DEFAULTS) {
  if (input === null) return { ...BUDGET_DEFAULTS };
  const next = { ...BUDGET_DEFAULTS, ...current };
  if (input.dailyTokens !== undefined) next.dailyTokens = input.dailyTokens === null || input.dailyTokens === "" ? null : bounded(input.dailyTokens, 10000, 100000000, "budget.dailyTokens", true);
  if (input.slowAtPct !== undefined) next.slowAtPct = bounded(input.slowAtPct, 10, 100, "budget.slowAtPct", true);
  return next;
}

// What the trader last saw: holdings and prices, open orders, the newest trade and event,
// instructions, questions and approval decisions.
export function snapshot(account, at) {
  return {
    at,
    positions: Object.fromEntries((account.positions ?? []).map((position) => [position.symbol, { quantity: position.quantity, price: position.price ?? position.lastPrice ?? null }])),
    openOrders: (account.openOrders ?? []).map((order) => order.id).sort(),
    lastTradeId: account.trades?.[0]?.id ?? null,
    lastEventAt: account.events?.[0]?.at ?? null,
    instructions: (account.instructions ?? []).map((entry) => entry.id).sort(),
    questions: (account.messages ?? []).filter((message) => message.kind === "question" && message.status === "open").map((message) => message.id).sort(),
    approvals: Object.fromEntries((account.approvals ?? []).map((entry) => [entry.id, entry.status])),
    strategyVersion: account.strategy?.version ?? null,
  };
}

// Everything that changed since `previous`, each with whether it is urgent enough to wake the trader early.
export function changesSince(previous, account, { movePct = GATE_DEFAULTS.movePct, wakeMovePct = WAKE_DEFAULTS.movePct } = {}) {
  if (!previous) return [{ text: "第一次复查", urgent: false }];
  const changes = [];
  const since = Date.parse(previous.at);
  const newTrades = (account.trades ?? []).filter((trade) => Date.parse(trade.at) > since);
  if (newTrades.length) changes.push({ text: `新成交 ${newTrades.length} 笔：${newTrades.slice(0, 3).map((trade) => `${trade.side === "BUY" ? "买" : "卖"} ${trade.name ?? trade.symbol} ${trade.quantity}`).join("、")}`, urgent: true });
  for (const event of (account.events ?? []).filter((entry) => Date.parse(entry.at) > since && URGENT_EVENTS[entry.type]).slice(0, 3)) changes.push({ text: `${URGENT_EVENTS[event.type]}：${event.message ?? event.symbol ?? ""}`.slice(0, 160), urgent: true });
  const instructions = (account.instructions ?? []).filter((entry) => !previous.instructions.includes(entry.id));
  if (instructions.length) changes.push({ text: `主人的新指令：${instructions.map((entry) => entry.text).join("；")}`.slice(0, 200), urgent: true });
  const questions = (account.messages ?? []).filter((message) => message.kind === "question" && message.status === "open" && !(previous.questions ?? []).includes(message.id));
  if (questions.length) changes.push({ text: `主人提问：${questions.map((message) => message.text).join("；")}`.slice(0, 200), urgent: true });
  const held = new Set();
  for (const position of account.positions ?? []) {
    held.add(position.symbol);
    const before = previous.positions[position.symbol];
    if (!before) { changes.push({ text: `新持仓 ${position.name ?? position.symbol}`, urgent: false }); continue; }
    if (before.quantity !== position.quantity) changes.push({ text: `${position.name ?? position.symbol} 持仓 ${before.quantity} → ${position.quantity}`, urgent: false });
    const price = position.price ?? position.lastPrice;
    if (finite(price) && finite(before.price) && before.price > 0) {
      const move = (price / before.price - 1) * 100;
      if (Math.abs(move) >= movePct) changes.push({ text: `${position.name ?? position.symbol} 自上次复查${move > 0 ? "涨" : "跌"} ${round(Math.abs(move), 1)}%`, urgent: Math.abs(move) >= wakeMovePct });
    }
  }
  for (const symbol of Object.keys(previous.positions)) if (!held.has(symbol)) changes.push({ text: `${symbol} 已清仓`, urgent: false });
  const orders = (account.openOrders ?? []).map((order) => order.id).sort();
  if (orders.join() !== previous.openOrders.join()) changes.push({ text: "挂单有变化（成交、撤单或过期）", urgent: false });
  for (const entry of account.approvals ?? []) if (previous.approvals[entry.id] && previous.approvals[entry.id] !== entry.status && ["approved", "rejected", "failed", "expired"].includes(entry.status)) changes.push({ text: `订单确认 ${entry.preview?.name ?? ""}：${{ approved: "已确认", rejected: "被拒绝", failed: "确认后被拦下", expired: "已过期" }[entry.status]}`, urgent: entry.status !== "expired" });
  if ((account.strategy?.version ?? null) !== previous.strategyVersion) changes.push({ text: "策略版本变了", urgent: false });
  return changes;
}

const minutesBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 60000;

// Run a scheduled review? `day` is the market-local date of now and of the last review.
export function gateDecision({ gate = GATE_DEFAULTS, previous, account, at, sameDay }) {
  if (!gate.enabled) return { run: true, reason: "gate off" };
  if (!previous || !sameDay) return { run: true, reason: previous ? "今天第一次复查" : "第一次复查" };
  const changes = changesSince(previous, account, { movePct: gate.movePct });
  if (changes.length) return { run: true, reason: changes.map((change) => change.text).join("；"), changes };
  if (minutesBetween(previous.at, at) >= gate.maxQuietMinutes) return { run: true, reason: `已经 ${Math.round(minutesBetween(previous.at, at))} 分钟没复查` };
  return { run: false, reason: "没有变化" };
}

// Wake the trader before its next slot?
export function wakeDecision({ wake = WAKE_DEFAULTS, gate = GATE_DEFAULTS, previous, account, at, wakesToday = 0 }) {
  if (!wake.enabled || !previous) return null;
  if (wakesToday >= wake.maxPerDay) return null;
  if (minutesBetween(previous.at, at) < wake.minMinutes) return null;
  const urgent = changesSince(previous, account, { movePct: gate.movePct, wakeMovePct: wake.movePct }).filter((change) => change.urgent);
  return urgent.length ? urgent.map((change) => change.text).join("；") : null;
}

// Budget state for today: run normally, slow (every other slot) or stop.
export function budgetDecision({ budget = BUDGET_DEFAULTS, tokensToday = 0, previous, at, intervalMinutes }) {
  if (!finite(budget.dailyTokens)) return { mode: "normal" };
  const usedPct = round(tokensToday / budget.dailyTokens * 100, 1);
  if (tokensToday >= budget.dailyTokens) return { mode: "stop", usedPct, reason: `今天已用 ${tokensToday} tokens，达到预算 ${budget.dailyTokens}` };
  if (usedPct >= budget.slowAtPct) {
    const slow = !previous || !intervalMinutes || minutesBetween(previous.at, at) >= intervalMinutes * 2;
    return { mode: "slow", usedPct, run: slow, reason: `今天已用预算的 ${usedPct}%，降频：每两个时段复查一次` };
  }
  return { mode: "normal", usedPct };
}
