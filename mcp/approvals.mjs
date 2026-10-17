// Autonomy levels, the owner's approval cards, the order pipeline and reconciliation. The same
// pipeline will sit in front of a real broker later: intent → hard limits → discipline checks →
// confirmation → broker, with every step recorded on the order. Only the last step changes.

const round = (value, digits = 2) => Math.round((value + Number.EPSILON) * 10 ** digits) / 10 ** digits;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

// full: the agent trades on its own. confirm: new positions, large orders (and optionally sells)
// wait for the owner. suggest: every order is a proposal the owner approves.
export const AUTONOMY_LEVELS = {
  full: { zh: "全托管", hint: "选股、下单都不停下来问你" },
  confirm: { zh: "关键操作确认", hint: "新开仓、大额订单（和可选的卖出）要你点确认" },
  suggest: { zh: "只给建议", hint: "每笔订单都是提议，你确认才下单" },
};
export const DEFAULT_AUTONOMY = Object.freeze({ level: "full", minValuePct: 10, sells: false, expiryMinutes: 120 });

export class AutonomyError extends Error {}

export function sanitizeAutonomy(input = {}, current = DEFAULT_AUTONOMY) {
  const next = { ...DEFAULT_AUTONOMY, ...current };
  if (input.level !== undefined) {
    if (!AUTONOMY_LEVELS[input.level]) throw new AutonomyError(`autonomy.level must be ${Object.keys(AUTONOMY_LEVELS).join(", ")}.`);
    next.level = input.level;
  }
  if (input.minValuePct !== undefined) {
    const value = Number(input.minValuePct);
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new AutonomyError("autonomy.minValuePct must be between 0 and 100.");
    next.minValuePct = round(value, 2);
  }
  if (input.sells !== undefined) next.sells = Boolean(input.sells);
  if (input.expiryMinutes !== undefined) {
    const value = Number(input.expiryMinutes);
    if (!Number.isInteger(value) || value < 5 || value > 1440) throw new AutonomyError("autonomy.expiryMinutes must be 5–1440.");
    next.expiryMinutes = value;
  }
  return next;
}

// Why this order must wait for the owner, or null. The owner's own orders never wait.
export function approvalReason({ autonomy = DEFAULT_AUTONOMY, owner, held, side, value, equity, requested }) {
  if (owner) return null;
  if (requested) return "交易员主动请你确认";
  if (autonomy.level === "suggest") return "只给建议：每笔订单都要你确认";
  if (autonomy.level !== "confirm") return null;
  if (side === "BUY" && !held) return "新开仓";
  if (finite(value) && equity > 0 && autonomy.minValuePct > 0 && value / equity * 100 >= autonomy.minValuePct) return `金额占总资产 ${round(value / equity * 100, 1)}%，超过 ${autonomy.minValuePct}%`;
  if (side === "SELL" && autonomy.sells) return "卖出要确认";
  return null;
}

// Soft checks from the pre-trade discipline gate. They never block an order; they are recorded on
// it and shown to the owner, so a pattern of skipped steps is visible in review.
export function disciplineWarnings({ side, exits, citations = [], origin, reason = "", recentTrades = [], now }) {
  const warnings = [];
  if (side === "BUY" && !exits?.stopLoss) warnings.push("买单没有止损");
  if (origin !== "strategy" && !citations.length) warnings.push("没有引用新闻、公告或数据来源");
  if (origin !== "strategy" && side === "BUY" && !/(风险|止损|失效|空头|看空|下行|risk|stop|invalid|bear)/i.test(reason)) warnings.push("理由里没写风险或失效条件");
  const today = String(now ?? "").slice(0, 10);
  const losses = [...recentTrades].reverse().filter((trade) => trade.side === "SELL" && trade.realizedPnl !== null && trade.realizedPnl !== undefined);
  let streak = 0;
  for (const trade of losses) { if (trade.realizedPnl < 0) streak += 1; else break; }
  if (side === "BUY" && streak >= 2) warnings.push(`刚连续亏损 ${streak} 笔，注意报复性交易`);
  if (side === "BUY" && recentTrades.filter((trade) => String(trade.at).slice(0, 10) === today && trade.side === "SELL" && trade.realizedPnl < 0).length >= 3) warnings.push("今天已经止损 3 次以上");
  return warnings;
}

// The recorded path of an order through the pipeline.
export function pipelineFor({ at, by, failure, warnings, approval, broker = "paper", status }) {
  return [
    { stage: "intent", at, by },
    { stage: "limits", ok: failure?.code !== "risk", detail: failure?.code === "risk" ? failure.message : null },
    { stage: "discipline", warnings },
    { stage: "confirmation", status: approval ? "approved" : "not-required", ...(approval ? { approvalId: approval.id, decidedAt: approval.decidedAt ?? at } : {}) },
    { stage: "broker", broker, status },
  ];
}

export function approvalStatus(approval, at) {
  if (approval.status === "pending" && Date.parse(approval.expiresAt) <= Date.parse(at)) return "expired";
  return approval.status;
}

// Rebuild cash and positions from the trade and corporate-action records and compare with the
// stored account. Used before trusting a paper (and later a real) account's numbers.
export function reconcile(account, { tolerance = 0.05, tradeCap = 5000 } = {}) {
  const timeline = [
    ...account.trades.map((trade) => ({ at: trade.at, kind: "trade", trade })),
    ...(account.events ?? []).filter((event) => ["dividend", "split", "bonus"].includes(event.type)).map((event) => ({ at: event.at, kind: event.type, event })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let cash = account.initialCash;
  const quantities = new Map();
  for (const item of timeline) {
    if (item.kind === "trade") {
      const { trade } = item;
      const signed = trade.side === "BUY" ? -(trade.gross + trade.fees) : trade.gross - trade.fees;
      cash += signed;
      quantities.set(trade.symbol, (quantities.get(trade.symbol) ?? 0) + (trade.side === "BUY" ? trade.quantity : -trade.quantity));
    } else if (item.kind === "dividend") cash += item.event.amount ?? 0;
    else quantities.set(item.event.symbol, (quantities.get(item.event.symbol) ?? 0) + ((item.event.quantityAfter ?? 0) - (item.event.quantityBefore ?? 0)));
  }
  cash = round(cash);
  const symbols = new Set([...quantities.keys(), ...Object.keys(account.positions)]);
  const positions = [...symbols].map((symbol) => {
    const ledger = quantities.get(symbol) ?? 0;
    const stored = account.positions[symbol]?.quantity ?? 0;
    return { symbol, ledger, stored, diff: stored - ledger };
  }).filter((row) => row.ledger !== 0 || row.stored !== 0);
  const open = account.orders.filter((order) => order.status === "open");
  const reservedOk = open.every((order) => order.side === "SELL" || order.reserved >= 0);
  const partial = account.trades.length >= tradeCap || (account.events?.length ?? 0) >= 2000;
  const cashDiff = round(account.cash - cash);
  const mismatched = positions.filter((row) => row.diff !== 0);
  return {
    checkedAt: null,
    ok: !partial ? Math.abs(cashDiff) <= tolerance && !mismatched.length && reservedOk : null,
    partial,
    note: partial ? "成交或事件记录超过保留上限，最早的部分已经裁掉，只能核对最近的部分。" : null,
    cash: { ledger: cash, stored: account.cash, diff: cashDiff },
    positions, mismatched: mismatched.length, trades: account.trades.length, openOrders: open.length,
  };
}
