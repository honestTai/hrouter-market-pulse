// Interactive Brokers through a local TWS / IB Gateway: US stocks, DAY limit orders, long only.
//
//   PAPER — the IB paper account (DU…). Agents submit within the owner's allowlist and limits.
//   LIVE  — a real-money account (U…). Agents can only propose: every order waits in a queue until
//           the owner confirms it in the dashboard, and is re-checked against a fresh quote then.
//
// Connection settings, the policy (account, allowlist, limits) and confirmations are owner actions
// over the local HTTP API; none of them is an MCP tool. Every broker write is recorded before it is
// sent; an unclear outcome is marked unknown and blocks new orders until the account is reconciled.

import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStorageDir, getQuote, normalizeSymbol } from "./core.mjs";

export const IBKR_ENVIRONMENTS = Object.freeze(["PAPER", "LIVE"]);
export const LIVE_ACKNOWLEDGEMENT = "我确认使用真实资金";
const ACCOUNT = { PAPER: /^D[UF]\d{1,12}$/, LIVE: /^U\d{4,12}$/ };
const ACTIVE = ["ApiPending", "PendingSubmit", "PreSubmitted", "Submitted", "PendingCancel"];
const MAX_PENDING_CONFIRMATIONS = 10;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (message) => { throw new Error(message); };
const tradingDate = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

export function defaultIbkrPython(env = process.env) {
  const base = env.HROUTER_IBKR_VENV || path.join(env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "hrouter-market-pulse", "ibkr-venv");
  return path.join(base, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
}

export function validateIbkrConfig(input = {}) {
  const port = Number(input.port ?? 7497), clientId = Number(input.clientId ?? 71);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("Invalid TWS / IB Gateway port");
  if (!Number.isInteger(clientId) || clientId < 1 || clientId > 32000) fail("API client ID must be 1–32000");
  const python = String(input.python ?? "").trim();
  if (python && (!path.isAbsolute(python) || python.length > 500)) fail("Python must be an absolute path to the ibkr venv interpreter");
  return { enabled: input.enabled === true, host: "127.0.0.1", port, clientId, python: python || null };
}

function usSymbol(symbol) {
  if (typeof symbol !== "string" || !symbol.trim()) fail("Symbol required");
  const normalized = normalizeSymbol(symbol);
  if (!/^[A-Z][A-Z0-9.\-]{0,14}$/.test(normalized) || /\.(HK|SS|SZ|BJ)$/.test(normalized)) fail("Only US stock symbols are supported through IBKR");
  return normalized;
}

export function validateIbkrPolicy(input) {
  if (!input || typeof input.enabled !== "boolean") fail("Explicit enabled flag required");
  if (!IBKR_ENVIRONMENTS.includes(input.environment)) fail("Environment must be PAPER or LIVE");
  if (!input.enabled) return { enabled: false, environment: input.environment };
  if (typeof input.accountId !== "string" || !ACCOUNT[input.environment].test(input.accountId)) fail(`A ${input.environment} account ID is required (${input.environment === "PAPER" ? "DU…" : "U…"})`);
  if (input.environment === "LIVE" && input.liveAcknowledgement !== LIVE_ACKNOWLEDGEMENT) fail(`Type "${LIVE_ACKNOWLEDGEMENT}" to enable a real-money account`);
  if (!Array.isArray(input.allowedSymbols) || !input.allowedSymbols.length || input.allowedSymbols.length > 50) fail("Allowlist requires 1–50 symbols");
  const allowedSymbols = [...new Set(input.allowedSymbols.map(usSymbol))];
  const limits = {};
  for (const [name, max] of Object.entries({ maxOrderValue: 1e8, maxDailyOrderValue: 1e9, maxPositionValue: 1e9, maxOrdersPerDay: 1000, maxQuoteAgeSeconds: 300, maxLimitDeviationPct: 5 })) {
    const v = input[name];
    if (!finite(v) || v <= 0 || v > max || (["maxOrdersPerDay", "maxQuoteAgeSeconds"].includes(name) && !Number.isInteger(v))) fail(`Explicit valid ${name} required (0 < value <= ${max})`);
    limits[name] = v;
  }
  if (limits.maxOrderValue > limits.maxDailyOrderValue || limits.maxOrderValue > limits.maxPositionValue) fail("Single-order limit must not exceed the daily or position limit");
  const confirmMinutes = input.environment === "LIVE" ? Number(input.confirmMinutes ?? 10) : null;
  if (input.environment === "LIVE" && (!Number.isInteger(confirmMinutes) || confirmMinutes < 1 || confirmMinutes > 30)) fail("Confirmation window must be 1–30 minutes");
  return { enabled: true, environment: input.environment, accountId: input.accountId, currency: "USD", allowedSymbols, ...limits,
    ...(input.environment === "LIVE" ? { confirmMinutes, requiresConfirmation: true } : { requiresConfirmation: false }) };
}

export function validateIbkrOrder(input) {
  if (!input) fail("Order required");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.idempotencyKey || "")) fail("Stable idempotencyKey of 8–80 letters/digits/_/- required");
  if (!["BUY", "SELL"].includes(input.side)) fail("Only BUY and long-position SELL supported");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0 || input.quantity > 1000000 || !finite(input.limitPrice) || input.limitPrice <= 0 || input.limitPrice > 1000000) fail("Positive whole-share quantity and finite limit price required");
  if (typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.length > 2000) fail("Record an explicit rationale (1–2000 characters)");
  return { symbol: usSymbol(input.symbol), side: input.side, quantity: input.quantity, limitPrice: input.limitPrice, rationale: input.rationale.trim(), idempotencyKey: input.idempotencyKey };
}

export function invokeIbkr(request, config, { timeoutMs = 60000 } = {}) {
  if (!config.enabled || !config.python) return Promise.reject(Object.assign(new Error("IBKR is not connected. Set it up under 设置 → 券商连接 → Interactive Brokers."), { definitelyNotDispatched: true }));
  const payload = { ...request, host: "127.0.0.1", port: config.port, clientId: config.clientId };
  const script = fileURLToPath(new URL("../bridges/ibkr/bridge.py", import.meta.url));
  return new Promise((resolve, reject) => {
    let output = "", finished = false;
    const child = spawn(config.python, ["-B", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const finish = (error, data) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(["submit", "cancel"].includes(request.action) ? "IBKR bridge timed out; if the order was sent its outcome is UNKNOWN. Reconcile, never auto-retry." : "TWS / IB Gateway did not answer in time; nothing was sent.")); }, timeoutMs);
    child.on("error", (e) => finish(Object.assign(new Error(`IBKR Python bridge unavailable: ${e.message}`), { definitelyNotDispatched: true })));
    child.stdout.on("data", (bytes) => { output += bytes.toString(); if (output.length > 4e6) { child.kill("SIGKILL"); finish(new Error("Bridge output limit exceeded; reconcile any dispatched request")); } });
    child.stderr.on("data", () => {}); // ib_async logs can contain account details; never return them.
    child.stdin.on("error", (e) => finish(e));
    child.on("close", () => {
      if (finished) return;
      try {
        const line = output.split(/\r?\n/).filter((l) => l.startsWith("HROUTER_IBKR_RESULT=")).at(-1);
        if (!line) fail("No bridge response. Run npm run setup:ibkr and check TWS; reconcile any dispatched request.");
        const result = JSON.parse(line.slice("HROUTER_IBKR_RESULT=".length));
        if (!result.ok) throw Object.assign(new Error(result.error || "IBKR bridge failed"), { definitelyNotDispatched: result.dispatched === false });
        finish(null, result.data);
      } catch (e) { finish(e); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return structuredClone(fallback); throw e; }
}
async function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}

const limitation = "PAPER orders go to your IB paper account; LIVE orders use real money and are only sent after you confirm each one. Order acknowledgements are not fills; positions and cash come from IB.";

export class IbkrService {
  constructor({ dir, bridge, quote, now, env = process.env } = {}) {
    this.dir = dir || path.join(getStorageDir(), "broker-ibkr");
    this.env = env;
    this.customBridge = bridge;
    this.quote = quote || ((symbol) => getQuote(symbol));
    this.now = now || (() => new Date().toISOString());
  }
  file(name) { return path.join(this.dir, name); }
  async config() {
    const stored = await readJson(this.file("config.json"), { enabled: false });
    return validateIbkrConfig({ ...stored, python: stored.python || (stored.enabled ? defaultIbkrPython(this.env) : null) });
  }
  async bridge(request) { return this.customBridge ? this.customBridge(request) : invokeIbkr(request, await this.config()); }
  async state() { return readJson(this.file("state.json"), { intents: [], samples: [], snapshots: [] }); }
  async policy() { return readJson(this.file("policy.json"), { enabled: false, environment: "PAPER" }); }
  async exclusive(fn) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = this.file("operation.lock");
    try { await mkdir(lock); } catch (e) { if (e.code === "EEXIST") fail("Another IBKR operation is running or was interrupted. Check TWS before removing broker-ibkr/operation.lock; never replay orders."); throw e; }
    try { return await fn(); } finally { await rm(lock, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
  }

  // Owner actions (dashboard only) ------------------------------------------------------------
  async saveConfig(input) {
    return this.exclusive(async () => {
      const config = validateIbkrConfig({ ...input, enabled: true, python: input.python || defaultIbkrPython(this.env) });
      await writeJson(this.file("config.json"), { ...config, updatedAt: this.now() });
      return config;
    });
  }
  async accounts(environment) {
    if (!IBKR_ENVIRONMENTS.includes(environment)) fail("Environment must be PAPER or LIVE");
    const data = await this.bridge({ action: "accounts", environment });
    if (!Array.isArray(data.accounts) || data.accounts.some((a) => a.environment !== environment || !ACCOUNT[environment].test(a.accountId))) fail("Unsafe account response rejected");
    return { ...data, environment, observedAt: this.now() };
  }
  async savePolicy(input) {
    return this.exclusive(async () => {
      const next = validateIbkrPolicy(input);
      if (next.enabled) {
        const { accounts } = await this.accounts(next.environment);
        if (!accounts.some((a) => a.accountId === next.accountId)) fail(`Account ${next.accountId} is not a ${next.environment} account of the TWS / IB Gateway login`);
      }
      const policy = { ...(!next.enabled ? { ...(await this.policy()), environment: next.environment } : {}), ...next, revision: randomUUID(), updatedAt: this.now() };
      await writeJson(this.file("policy.json"), policy);
      return policy;
    });
  }
  // Pause agents and request cancellation of every open order this workbench placed.
  async halt() {
    const policy = await this.exclusive(async () => {
      const current = await this.policy();
      const paused = { ...current, enabled: false, revision: randomUUID(), updatedAt: this.now(), haltedAt: this.now() };
      await writeJson(this.file("policy.json"), paused);
      const state = await this.state();
      for (const intent of state.intents.filter((r) => r.status === "awaiting-confirmation")) {
        Object.assign(intent, { status: "rejected", error: "Halted by owner" });
        intent.events.push({ at: this.now(), type: "rejected", error: "Halted by owner" });
      }
      await writeJson(this.file("state.json"), state);
      return paused;
    });
    const cancellations = [];
    if (policy.accountId) {
      const { snapshot } = await this.refresh();
      const state = await this.state();
      for (const order of snapshot.orders.filter((o) => ACTIVE.includes(o.status) && o.orderId && state.intents.some((r) => r.kind === "order" && r.brokerOrderId === o.orderId))) {
        try { cancellations.push(await this.cancel({ orderId: order.orderId, idempotencyKey: `halt_${randomUUID()}` }, { owner: true })); }
        catch (error) { cancellations.push({ orderId: order.orderId, status: "failed", error: error.message }); }
      }
    }
    return { policy, cancellations };
  }
  // Clear an "unknown" order after the owner checked TWS: only when IB has no order and no
  // execution carrying its trace ID. If IB has it, refresh() reconciles it instead.
  async resolve({ id } = {}) {
    if (typeof id !== "string" || !id) fail("Order ID required");
    await this.refresh();
    return this.exclusive(async () => {
      const state = await this.state();
      const intent = state.intents.find((r) => r.id === id);
      if (!intent) fail("Order not found");
      if (!["unknown", "dispatching"].includes(intent.status)) fail(`This order is ${intent.status}; nothing to resolve`);
      const snap = state.snapshots.find((s) => s.accountId === intent.accountId);
      const seen = (snap?.orders ?? []).some((o) => o.orderRef === `hrouter:${intent.id}`) || (snap?.executions ?? []).some((f) => f.orderRef === `hrouter:${intent.id}`);
      if (!snap || seen) fail("IB still reports this order, or the account could not be read; refresh instead");
      Object.assign(intent, { status: "blocked", error: `${intent.error ?? ""} — owner checked TWS: not placed`.trim(), resolvedAt: this.now() });
      intent.events.push({ at: this.now(), type: "resolved-not-placed" });
      await writeJson(this.file("state.json"), state);
      return intent;
    });
  }
  async confirm({ id } = {}) { return this.decide(id, true); }
  async reject({ id } = {}) { return this.decide(id, false); }
  async decide(id, approve) {
    if (typeof id !== "string" || !id) fail("Order ID required");
    return this.exclusive(async () => {
      const state = await this.state();
      const intent = state.intents.find((r) => r.id === id);
      if (!intent) fail("Order not found");
      if (intent.status !== "awaiting-confirmation") fail(`This order is ${intent.status}, not waiting for confirmation`);
      if (!approve) {
        Object.assign(intent, { status: "rejected", decidedAt: this.now() });
        intent.events.push({ at: this.now(), type: "rejected" });
        await writeJson(this.file("state.json"), state);
        return intent;
      }
      if (Date.parse(this.now()) > Date.parse(intent.expiresAt)) {
        Object.assign(intent, { status: "expired", error: "Confirmation window passed" });
        intent.events.push({ at: this.now(), type: "expired" });
        await writeJson(this.file("state.json"), state);
        return intent;
      }
      intent.confirmedAt = this.now();
      intent.events.push({ at: intent.confirmedAt, type: "confirmed" });
      return this.dispatch(intent, state, await this.policy(), { confirmed: true });
    });
  }

  // Agent actions (MCP) -----------------------------------------------------------------------
  async status() {
    const [config, policy, state] = await Promise.all([this.config(), this.policy(), this.state()]);
    const pending = state.intents.filter((r) => r.status === "awaiting-confirmation" && Date.parse(r.expiresAt) > Date.parse(this.now()));
    return { provider: "ibkr-tws", config: { connected: config.enabled, port: config.port, clientId: config.clientId, python: config.python }, policy, limitation,
      pendingConfirmations: pending, intents: state.intents.slice(-100).reverse(), samples: state.samples.slice(-300), snapshot: state.snapshots.at(-1) ?? null,
      ports: { tws: { PAPER: 7497, LIVE: 7496 }, gateway: { PAPER: 4002, LIVE: 4001 } } };
  }
  async snapshot(policy) {
    const data = await this.bridge({ action: "snapshot", environment: policy.environment, accountId: policy.accountId });
    if (data.accountId !== policy.accountId || data.environment !== policy.environment || data.currency !== "USD" || !Array.isArray(data.orders) || !Array.isArray(data.positions)) fail("Broker snapshot identity mismatch");
    return { ...data, observedAt: this.now() };
  }
  async refresh() {
    return this.exclusive(async () => {
      const policy = await this.policy();
      if (!policy.accountId) fail("Pick an IB account in the dashboard first");
      const snap = await this.snapshot(policy); const state = await this.state();
      for (const intent of state.intents.filter((r) => r.accountId === snap.accountId && r.kind === "order")) {
        const fills = (snap.executions ?? []).filter((f) => (intent.brokerOrderId && f.orderId === intent.brokerOrderId) || f.orderRef === `hrouter:${intent.id}`);
        if (fills.length) {
          const quantity = fills.reduce((n, f) => n + (f.quantity ?? 0), 0);
          intent.fills = { quantity, averagePrice: quantity ? fills.reduce((n, f) => n + (f.quantity ?? 0) * (f.price ?? 0), 0) / quantity : null, executions: fills, observedAt: snap.observedAt };
        }
        const order = snap.orders.find((o) => (intent.brokerOrderId && o.orderId === intent.brokerOrderId) || o.orderRef === `hrouter:${intent.id}`);
        if (!order) continue;
        if (hash(intent.broker || {}) !== hash(order)) (intent.events ||= []).push({ at: snap.observedAt, type: "broker-observed", broker: order });
        Object.assign(intent, { brokerOrderId: order.orderId, broker: order, reconciledAt: snap.observedAt });
        if (["dispatching", "unknown"].includes(intent.status)) Object.assign(intent, { status: "acknowledged", error: null });
      }
      state.samples.push({ accountId: snap.accountId, environment: snap.environment, observedAt: snap.observedAt, policyRevision: policy.revision || null, ...snap.funds });
      state.samples = state.samples.slice(-2000);
      state.snapshots = [...state.snapshots.filter((s) => s.accountId !== snap.accountId), snap].slice(-5);
      await writeJson(this.file("state.json"), state);
      return { snapshot: snap, intents: state.intents.filter((r) => r.accountId === snap.accountId).slice(-100).reverse() };
    });
  }
  async assess(order, policy, state, { counting = true } = {}) {
    if (!policy.enabled) fail("IBKR execution is paused. The owner enables it in the dashboard.");
    if (!policy.allowedSymbols.includes(order.symbol)) fail("Symbol is outside the owner's allowlist");
    const notional = order.quantity * order.limitPrice;
    if (!finite(notional) || notional > policy.maxOrderValue) fail("Single-order notional limit exceeded");
    const relevant = state.intents.filter((r) => r.accountId === policy.accountId && r.kind === "order");
    if (relevant.some((r) => ["dispatching", "unknown"].includes(r.status))) fail("An earlier order has an unclear outcome. Refresh/reconcile before new orders; do not retry with a new key.");
    if (counting) {
      const today = relevant.filter((r) => (r.dispatchedAt || (r.status === "awaiting-confirmation" && Date.parse(r.expiresAt) > Date.parse(this.now()))) && tradingDate(r.dispatchedAt || r.createdAt) === tradingDate(this.now()));
      if (today.length >= policy.maxOrdersPerDay || today.reduce((n, r) => n + r.notional, 0) + notional > policy.maxDailyOrderValue) fail("Daily order count / notional budget exceeded (pending confirmations and cancellations count)");
    }
    const quote = await this.quote(order.symbol);
    const age = Date.parse(this.now()) - Date.parse(quote.asOf);
    if (quote.demo || quote.synthetic || quote.symbol !== order.symbol || quote.currency !== "USD" || !finite(quote.price) || quote.price <= 0 || !Number.isFinite(age) || age < -5000 || age > policy.maxQuoteAgeSeconds * 1000 || quote.signalEligible !== true || quote.freshness?.status !== "fresh" || !["matched", "fallback", "unavailable"].includes(quote.crossCheck?.status)) fail("Real quote is missing, stale, market-closed or in conflict; no order");
    if (Math.abs(order.limitPrice / quote.price - 1) * 100 > policy.maxLimitDeviationPct) fail("Limit price deviates too far from the current verified quote");
    const snapshot = await this.snapshot(policy);
    const held = snapshot.positions.filter((p) => p.symbol === order.symbol && p.secType === "STK" && p.currency === "USD");
    if (order.side === "SELL") {
      const quantity = held.reduce((n, p) => n + (finite(p.quantity) ? p.quantity : 0), 0);
      const openSells = snapshot.orders.filter((o) => o.side === "SELL" && o.symbol === order.symbol && ACTIVE.includes(o.status)).reduce((n, o) => n + (o.remaining ?? o.quantity ?? 0), 0);
      if (quantity - openSells < order.quantity) fail("Insufficient long position after open sell orders; shorts are disabled");
    } else {
      const openBuys = snapshot.orders.filter((o) => o.side === "BUY" && ACTIVE.includes(o.status));
      if (openBuys.some((o) => !finite(o.price) || !finite(o.quantity))) fail("Unverifiable open buy orders; no new buys");
      const commitments = openBuys.reduce((n, o) => n + (o.remaining ?? o.quantity) * o.price, 0);
      const currentValue = held.reduce((n, p) => n + Math.abs(p.marketValue ?? (p.quantity ?? 0) * quote.price), 0);
      const symbolPending = openBuys.filter((o) => o.symbol === order.symbol).reduce((n, o) => n + (o.remaining ?? o.quantity) * o.price, 0);
      if (!finite(snapshot.funds?.cash) || snapshot.funds.cash < commitments + notional) fail("Settled cash does not cover this buy plus open buy orders; margin is not used");
      if (currentValue + symbolPending + notional > policy.maxPositionValue) fail("Position limit including open buys exceeded");
    }
    if (Date.parse(this.now()) - Date.parse(quote.asOf) > policy.maxQuoteAgeSeconds * 1000) fail("Quote expired while checking the IB account");
    return { notional, quote: { symbol: quote.symbol, price: quote.price, currency: quote.currency, asOf: quote.asOf, source: quote.source, freshness: quote.freshness, crossCheck: quote.crossCheck },
      account: { accountId: policy.accountId, environment: policy.environment, observedAt: snapshot.observedAt, funds: snapshot.funds }, checkedAt: this.now() };
  }
  async evaluate(input) {
    const order = validateIbkrOrder(input);
    return this.exclusive(async () => {
      const policy = await this.policy();
      try { return { eligible: true, environment: policy.environment, requiresConfirmation: policy.requiresConfirmation === true, ...(await this.assess(order, policy, await this.state())), meaning: "Preflight only; submitting re-checks everything." }; }
      catch (e) { return { eligible: false, reason: e.message, environment: policy.environment, checkedAt: this.now() }; }
    });
  }
  async submit(input) {
    const order = validateIbkrOrder(input);
    return this.exclusive(async () => {
      const state = await this.state(); const requestHash = hash(order);
      const prior = state.intents.find((r) => r.idempotencyKey === order.idempotencyKey);
      if (prior) { if (prior.requestHash !== requestHash) fail("Idempotency key already used for a different request"); return { ...prior, replay: true }; }
      if (state.intents.length >= 10000) fail("IBKR ledger full; archive broker-ibkr/state.json first");
      const policy = await this.policy();
      const intent = { id: randomUUID(), kind: "order", ...order, requestHash, environment: policy.environment, accountId: policy.accountId, currency: "USD",
        policyRevision: policy.revision, createdAt: this.now(), status: "checking", events: [] };
      try { Object.assign(intent, await this.assess(order, policy, state)); }
      catch (e) { Object.assign(intent, { status: "blocked", error: e.message }); intent.events.push({ at: this.now(), type: "blocked", error: e.message }); state.intents.push(intent); await writeJson(this.file("state.json"), state); return intent; }
      if (policy.requiresConfirmation) {
        const waiting = state.intents.filter((r) => r.status === "awaiting-confirmation" && Date.parse(r.expiresAt) > Date.parse(this.now()));
        if (waiting.length >= MAX_PENDING_CONFIRMATIONS) fail(`${MAX_PENDING_CONFIRMATIONS} orders are already waiting for the owner; wait for decisions`);
        Object.assign(intent, { status: "awaiting-confirmation", expiresAt: new Date(Date.parse(this.now()) + policy.confirmMinutes * 60000).toISOString(),
          meaning: "Real-money order proposed. Nothing was sent: the owner must confirm it in the dashboard before it expires." });
        intent.events.push({ at: this.now(), type: "awaiting-confirmation" });
        state.intents.push(intent);
        await writeJson(this.file("state.json"), state);
        return intent;
      }
      state.intents.push(intent);
      return this.dispatch(intent, state, policy, { confirmed: false });
    });
  }
  // Callers hold the lock. LIVE orders reach here only from decide() after the owner confirmed.
  async dispatch(intent, state, policy, { confirmed }) {
    if (policy.environment === "LIVE" && !confirmed) fail("LIVE orders need the owner's confirmation");
    if (policy.accountId !== intent.accountId || policy.environment !== intent.environment) fail("The account or environment changed since this order was proposed; propose it again");
    try {
      if (confirmed) Object.assign(intent, await this.assess(intent, policy, state, { counting: false }));
    } catch (e) {
      Object.assign(intent, { status: "blocked", error: `Re-check at confirmation failed: ${e.message}` });
      intent.events.push({ at: this.now(), type: "blocked", error: intent.error });
      await writeJson(this.file("state.json"), state);
      return intent;
    }
    Object.assign(intent, { status: "dispatching", dispatchedAt: this.now() });
    intent.events.push({ at: intent.dispatchedAt, type: "dispatching" });
    await writeJson(this.file("state.json"), state); // Durable intent before the side effect.
    try {
      const result = await this.bridge({ action: "submit", environment: intent.environment, accountId: intent.accountId, symbol: intent.symbol, side: intent.side,
        quantity: intent.quantity, limitPrice: intent.limitPrice, orderRef: `hrouter:${intent.id}`, quoteValidUntil: Date.parse(intent.quote.asOf) + policy.maxQuoteAgeSeconds * 1000 });
      const broker = result.orders?.[0];
      if (!broker?.orderId || broker.symbol !== intent.symbol || broker.side !== intent.side || broker.account !== intent.accountId) fail("Missing or mismatched IB acknowledgement");
      Object.assign(intent, { status: "acknowledged", brokerOrderId: broker.orderId, broker, acknowledgedAt: this.now(), error: null });
    } catch (e) { Object.assign(intent, { status: e.definitelyNotDispatched ? "blocked" : "unknown", error: e.message }); }
    intent.events.push({ at: this.now(), type: intent.status, broker: intent.broker || null, error: intent.error || null });
    await writeJson(this.file("state.json"), state);
    return intent;
  }
  async cancel(input, { owner = false } = {}) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(input?.idempotencyKey || "") || !/^\d{1,20}$/.test(input?.orderId || "")) fail("Valid IB order ID and idempotencyKey required");
    return this.exclusive(async () => {
      const policy = await this.policy(); const state = await this.state();
      const requestHash = hash({ kind: "cancel", orderId: input.orderId });
      const previous = state.intents.find((r) => r.idempotencyKey === input.idempotencyKey);
      if (previous) { if (previous.requestHash !== requestHash) fail("Idempotency key conflict"); return { ...previous, replay: true }; }
      const original = state.intents.find((r) => r.kind === "order" && r.brokerOrderId === input.orderId);
      if (!original && !owner) fail("Agents may only cancel orders this workbench placed");
      const target = original ?? policy;
      const intent = { id: randomUUID(), kind: "cancel", idempotencyKey: input.idempotencyKey, requestHash, environment: target.environment, accountId: target.accountId,
        brokerOrderId: input.orderId, createdAt: this.now(), dispatchedAt: this.now(), status: "dispatching", events: [{ at: this.now(), type: "dispatching" }] };
      state.intents.push(intent); await writeJson(this.file("state.json"), state);
      try {
        await this.bridge({ action: "cancel", environment: target.environment, accountId: target.accountId, orderId: input.orderId });
        Object.assign(intent, { status: "acknowledged", acknowledgedAt: this.now(), meaning: "Cancellation requested, not confirmed; refresh to see IB's status." });
      } catch (e) { Object.assign(intent, { status: e.definitelyNotDispatched ? "blocked" : "unknown", error: e.message }); }
      intent.events.push({ at: this.now(), type: intent.status, error: intent.error || null });
      await writeJson(this.file("state.json"), state);
      return intent;
    });
  }
}

let service;
export function getIbkrService() { return service ||= new IbkrService(); }
