// Execution adapters. Agents (through MCP), quant strategies and the scheduler place orders only
// through a broker, so moving a strategy from paper to live later means swapping the adapter, not
// rewriting the strategy.
//
//   paper     — the local Agent Arena: real quotes, simulated fills, virtual money.
//   advisory  — live markets, human in the loop: every order becomes a proposal that the owner must
//               confirm in the dashboard and execute at their own broker. Nothing is ever sent.
//
// A real-money execution adapter is deliberately NOT implemented. If one is added, it must take an
// order only after an explicit, per-order human confirmation recorded against an advisory proposal.

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStorageDir, getTradeQuote } from "./core.mjs";
import { normalizeTradeSymbol } from "./arena.mjs";

export const BROKER_MODES = Object.freeze(["paper", "advisory"]);

// The order intent every strategy and agent produces; adapters map it onto their venue.
export function normalizeIntent(intent) {
  const side = String(intent.side ?? "").toUpperCase();
  if (!["BUY", "SELL"].includes(side)) throw new Error("Order intent side must be BUY or SELL.");
  const quantity = Number(intent.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Order intent quantity must be a positive integer number of shares.");
  const orderType = intent.orderType === "limit" ? "limit" : "market";
  if (orderType === "limit" && !(Number(intent.limitPrice) > 0)) throw new Error("Limit intents need a positive limitPrice.");
  return {
    symbol: normalizeTradeSymbol(intent.symbol), side, quantity, orderType,
    limitPrice: orderType === "limit" ? Number(intent.limitPrice) : undefined,
    timeInForce: intent.timeInForce === "gtc" ? "gtc" : "day",
    reason: String(intent.reason ?? "").slice(0, 2000),
    confidence: Number.isFinite(intent.confidence) ? intent.confidence : undefined,
    horizon: intent.horizon,
    clientOrderId: intent.clientOrderId,
    ...(["stopLossPct", "stopLossPrice", "takeProfitPct", "takeProfitPrice"].reduce((exits, key) => (Number.isFinite(intent[key]) ? { ...exits, [key]: intent[key] } : exits), {})),
  };
}

export function createPaperBroker({ arena, accountId, caller }) {
  return {
    mode: "paper",
    accountId,
    account: (options) => arena.getAccount(accountId, options),
    quote: (symbol) => getTradeQuote(symbol),
    async placeOrder(intent) {
      const order = normalizeIntent(intent);
      return arena.placeOrder({ accountId, ...order }, caller);
    },
    cancelOrder: (orderId, reason) => arena.cancelOrder({ accountId, orderId, reason }, caller),
    logDecision: (entry) => arena.logDecision({ accountId, ...entry }, caller),
    publishReport: (report) => arena.publishReport({ accountId, ...report }, caller),
    setExits: (input) => arena.setExits({ accountId, ...input }, caller),
    touchRound: (kind) => arena.touchRound(accountId, kind, caller),
  };
}

// Live-market advice with human confirmation. Proposals are stored for the owner; no order is sent.
export function createAdvisoryBroker({ root = path.join(getStorageDir(), "advisory"), source, now = () => new Date().toISOString() } = {}) {
  const dir = path.join(root, "proposals");
  return {
    mode: "advisory",
    quote: (symbol) => getTradeQuote(symbol),
    async placeOrder(intent) {
      const order = normalizeIntent(intent);
      const quote = await getTradeQuote(order.symbol).catch(() => null);
      const proposal = {
        id: `prp_${randomBytes(6).toString("hex")}`, createdAt: now(), status: "pending-confirmation", source: source ?? null,
        order, quoteAtProposal: quote ? { price: quote.price, asOf: quote.asOf, source: quote.provider } : null,
        expiresAt: intent.expiresAt ?? new Date(Date.parse(now()) + 24 * 3600000).toISOString(),
        note: "Advisory only: the owner must confirm and place this order at their own broker. Nothing was executed.",
      };
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${proposal.id}.json`);
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(proposal, null, 1), "utf8");
      await rename(temporary, file);
      return { proposal, executed: false };
    },
    async listProposals({ status } = {}) {
      let names = [];
      try { names = await readdir(dir); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const rows = [];
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        try { rows.push(JSON.parse(await readFile(path.join(dir, name), "utf8"))); } catch { /* skip partial writes */ }
      }
      return rows.filter((row) => !status || row.status === status).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
    cancelOrder: async () => { throw new Error("Advisory proposals are confirmed or rejected by the owner in the dashboard."); },
  };
}

export function createBroker(mode, options) {
  if (mode === "paper") return createPaperBroker(options);
  if (mode === "advisory") return createAdvisoryBroker(options);
  throw new Error(`Unknown broker mode "${mode}". Real-money execution is not available.`);
}
