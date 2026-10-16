import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStorageDir, getQuote, normalizeSymbol } from "./core.mjs";
import { evaluateDeclarativeStrategy, STRATEGY_FEATURES } from "./foundation.mjs";

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (message) => { throw new Error(message); };
const uncertainOrder = (o) => !o?.status || ["TIMEOUT", "N/A"].includes(o.status);
const activeOrder = (o) => !["FILLED_ALL", "CANCELLED_ALL", "CANCELLED_PART", "FAILED", "SUBMIT_FAILED", "DELETED", "DISABLED", "FILL_CANCELLED"].includes(o.status);
export function paperConfig(env = process.env) {
  const port = Number(env.HROUTER_FUTU_PORT || 11111);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("Invalid HROUTER_FUTU_PORT");
  return { enabled: env.HROUTER_FUTU_ENABLED === "1", host: "127.0.0.1", port,
    python: env.HROUTER_FUTU_PYTHON || (process.platform === "win32" ? "python" : "python3"), environment: "SIMULATE" };
}
function paperSymbol(symbol) {
  if (typeof symbol !== "string" || !symbol.trim()) fail("Symbol required");
  const normalized = normalizeSymbol(symbol);
  return /^\d{4,5}\.HK$/.test(normalized) ? `${String(Number(normalized.split(".")[0])).padStart(4, "0")}.HK` : normalized;
}
export function futuCode(symbol, market) {
  const normalized = paperSymbol(symbol);
  if (market === "HK" && /^\d{4,5}\.HK$/.test(normalized)) return `HK.${normalized.split(".")[0].padStart(5, "0")}`;
  if (market === "US" && /^[A-Z][A-Z0-9.\-]{0,14}$/.test(normalized) && !/^US\./.test(normalized) && !/\.(HK|SS|SZ|BJ)$/.test(normalized)) return `US.${normalized}`;
  fail("Only HK/US symbols matching the selected account market are supported / 仅支持对应市场的港美股");
}
function account(input) {
  if (!["HK", "US"].includes(input.market) || typeof input.accountId !== "string" || !/^[1-9]\d{0,19}$/.test(input.accountId || "")) fail("Explicit HK/US simulation account required");
  return { market: input.market, accountId: input.accountId };
}
function strategy(input) {
  if (!input || !Array.isArray(input.rules) || !input.rules.length || input.rules.length > 20) fail("Each paper strategy requires 1–20 rules");
  if (!input.rules.every((r) => STRATEGY_FEATURES.includes(r.feature) && finite(r.value) && finite(r.points) && (r.operator !== "between" || finite(r.value2)))) fail("Paper rules require finite built-in features; external/model probabilities are not execution inputs");
  if (typeof input.name !== "string" || input.name.length > 100 || typeof input.version !== "string" || input.version.length > 40) fail("Strategy name/version invalid");
  if (!finite(input.minimumScore) || !finite(input.baseScore)) fail("Explicit finite strategy scores required");
  evaluateDeclarativeStrategy({ price: 1, signalEligible: false }, input);
  return JSON.parse(JSON.stringify(input));
}
export function validatePaperPolicy(input) {
  if (!input || input.environment !== "SIMULATE" || typeof input.enabled !== "boolean") fail("SIMULATE policy and explicit enabled flag required; REAL is forbidden");
  if (!input.enabled) return { enabled: false, environment: "SIMULATE" };
  const selected = account(input);
  if (!Array.isArray(input.allowedSymbols) || !input.allowedSymbols.length || input.allowedSymbols.length > 20) fail("Allowlist requires 1–20 symbols");
  const allowedSymbols = [...new Set(input.allowedSymbols.map(paperSymbol))];
  for (const symbol of allowedSymbols) futuCode(symbol, selected.market);
  const limits = {};
  for (const [name, max] of Object.entries({ maxOrderValue: 1e9, maxDailyOrderValue: 1e10, maxPositionValue: 1e9, maxOrdersPerDay: 1000, maxQuoteAgeSeconds: 300, maxLimitDeviationPct: 5 })) {
    const v = input[name];
    if (!finite(v) || v <= 0 || v > max || (["maxOrdersPerDay", "maxQuoteAgeSeconds"].includes(name) && !Number.isInteger(v))) fail(`Explicit valid ${name} required (0 < value <= ${max})`);
    limits[name] = v;
  }
  if (limits.maxOrderValue > limits.maxDailyOrderValue || limits.maxOrderValue > limits.maxPositionValue) fail("Single-order limit must not exceed daily or position limit");
  const lotSizes = {};
  for (const symbol of allowedSymbols) {
    const size = selected.market === "US" ? 1 : input.lotSizes?.[symbol];
    if (!Number.isInteger(size) || size <= 0 || size > 1000000) fail(`Verified board lot required for ${symbol}`);
    lotSizes[symbol] = size;
  }
  return { ...selected, enabled: true, environment: "SIMULATE", currency: selected.market === "HK" ? "HKD" : "USD",
    allowedSymbols, lotSizes, ...limits, entryStrategy: strategy(input.entryStrategy), exitStrategy: strategy(input.exitStrategy) };
}
export function validatePaperOrder(input) {
  if (!input || (input.environment && input.environment !== "SIMULATE")) fail("REAL execution is forbidden");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.idempotencyKey || "")) fail("Stable idempotencyKey of 8–80 letters/digits/_/- required");
  if (!["BUY", "SELL"].includes(input.side)) fail("Only BUY and long-position SELL supported");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0 || input.quantity > 1000000 || !finite(input.limitPrice) || input.limitPrice <= 0 || input.limitPrice > 1000000) fail("Positive whole-share quantity and finite limit price required");
  if (typeof input.rationale !== "string" || !input.rationale.trim() || input.rationale.length > 2000) fail("Record an explicit rationale (1–2000 characters)");
  return { symbol: paperSymbol(input.symbol), side: input.side, quantity: input.quantity, limitPrice: input.limitPrice,
    rationale: input.rationale.trim(), idempotencyKey: input.idempotencyKey, environment: "SIMULATE" };
}

export function invokeFutu(request, config = paperConfig(), { timeoutMs = 45000 } = {}) {
  if (!config.enabled) return Promise.reject(new Error("Futu is disabled. Set HROUTER_FUTU_ENABLED=1 after configuring local OpenD / 尚未启用富途连接"));
  const payload = { ...request, host: "127.0.0.1", port: config.port, environment: "SIMULATE" };
  const script = fileURLToPath(new URL("../bridges/futu/bridge.py", import.meta.url));
  return new Promise((resolve, reject) => {
    let output = "", finished = false;
    const child = spawn(config.python, ["-B", script], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const finish = (error, data) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(data); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(["submit", "cancel"].includes(request.action) ? "OpenD bridge timed out; if dispatched, outcome is UNKNOWN. Reconcile, never auto-retry." : "OpenD connection timed out. Start/sign in to OpenD and verify its loopback port; no order request was made.")); }, timeoutMs);
    child.on("error", (e) => finish(new Error(`Python bridge unavailable: ${e.message}`)));
    child.stdout.on("data", (bytes) => { output += bytes.toString(); if (output.length > 4e6) { child.kill("SIGKILL"); finish(new Error("Bridge output limit exceeded; reconcile any dispatched request")); } });
    child.stderr.on("data", () => {}); // Do not return SDK logs containing account/session details.
    child.stdin.on("error", (e) => finish(e));
    child.on("close", () => {
      if (finished) return;
      try {
        const line = output.split(/\r?\n/).filter((l) => l.startsWith("HROUTER_FUTU_RESULT=")).at(-1);
        if (!line) fail("No bridge response. Install optional SDK and start OpenD; reconcile any dispatched request.");
        const result = JSON.parse(line.slice("HROUTER_FUTU_RESULT=".length));
        if (!result.ok) { const error = new Error(result.error || "Futu bridge failed"); error.definitelyNotDispatched = result.dispatched === false; throw error; }
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
  if (process.platform !== "win32") {
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
function tradingDate(now, market) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: market === "HK" ? "Asia/Hong_Kong" : "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
const limitation = "Actual Futu SIMULATE orders only, not real-money trades. Broker simulation is not live execution. Equity changes are unadjusted for deposits/resets; order status is not a complete fill/fee ledger. Experimental paper results do not qualify a strategy for real trading.";

export class PaperService {
  constructor({ dir, bridge, quote, config, now } = {}) {
    this.dir = dir || path.join(getStorageDir(), "paper-futu");
    this.config = config || paperConfig(); this.bridge = bridge || ((r) => invokeFutu(r, this.config));
    this.quote = quote || ((symbol) => getQuote(symbol)); this.now = now || (() => new Date().toISOString());
  }
  async state() { return readJson(path.join(this.dir, "state.json"), { intents: [], samples: [] }); }
  async policy() { return readJson(path.join(this.dir, "policy.json"), { enabled: false, environment: "SIMULATE" }); }
  async exclusive(fn) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = path.join(this.dir, "operation.lock");
    try { await mkdir(lock); } catch (e) { if (e.code === "EEXIST") fail("Paper operation busy or interrupted. Do not replay orders; inspect broker before recovering operation.lock."); throw e; }
    try { return await fn(); } finally { await rm(lock, { recursive: true }); }
  }
  async savePolicy(input) {
    return this.exclusive(async () => {
      const next = validatePaperPolicy(input);
      if (next.enabled) {
        this.requireEnabled();
        const { accounts } = await this.bridge({ action: "accounts", market: next.market });
        if (!accounts.some((a) => a.accountId === next.accountId && a.environment === "SIMULATE" && a.market === next.market)) fail("Select a verified SIMULATE account first");
      }
      const policy = { ...(!next.enabled ? await this.policy() : {}), ...next, revision: randomUUID(), updatedAt: this.now() };
      await writeJson(path.join(this.dir, "policy.json"), policy);
      return policy;
    });
  }
  requireEnabled() { if (!this.config.enabled) fail("Futu bridge is disabled; set HROUTER_FUTU_ENABLED=1. No synthetic fallback."); }
  async status() {
    const policy = await this.policy(); const state = await this.state();
    return { provider: "futu-opend", environment: "SIMULATE", bridgeEnabled: this.config.enabled,
      gateway: `127.0.0.1:${this.config.port}`, policy, limitation, connected: null,
      intents: state.intents.slice(-100).reverse(), samples: state.samples.slice(-300), snapshots: state.snapshots || [],
      setup: ["Install / sign in to official Futu OpenD on this computer (port 11111 by default).",
        "Create a user-owned Python venv and install bridges/futu/requirements.txt.",
        "Set HROUTER_FUTU_ENABLED=1 and HROUTER_FUTU_PYTHON to the venv Python; restart plugin.",
        "Connect here, select SIMULATE account and explicitly configure strategy limits. No real-account unlock required."],
      automation: "Agent MCP calls can evaluate, submit and cancel within the UI-authorized policy. No background scheduler is installed automatically." };
  }
  async accounts(market) {
    this.requireEnabled(); if (!["HK", "US"].includes(market)) fail("HK or US market required");
    const data = await this.bridge({ action: "accounts", market });
    if (!Array.isArray(data.accounts) || data.accounts.some((a) => a.environment !== "SIMULATE" || a.market !== market)) fail("Unsafe account response rejected");
    return { ...data, observedAt: this.now(), environment: "SIMULATE" };
  }
  async snapshot(input) {
    this.requireEnabled(); const selected = account(input);
    const data = await this.bridge({ action: "snapshot", ...selected });
    if (data.accountId !== selected.accountId || data.market !== selected.market || data.currency !== (selected.market === "HK" ? "HKD" : "USD") || !Array.isArray(data.orders) || !Array.isArray(data.positions)) fail("Broker snapshot identity mismatch");
    return { ...data, observedAt: this.now(), environment: "SIMULATE", limitation };
  }
  async refresh(input) {
    return this.exclusive(async () => {
      const snap = await this.snapshot(input); const state = await this.state();
      const matches = (r) => r.accountId === snap.accountId && r.market === snap.market;
      for (const intent of state.intents.filter(matches)) {
        const order = snap.orders.find((o) => o.orderId === intent.brokerOrderId || (intent.kind === "order" && o.remark === `hrouter:${intent.id}`));
        if (!order) continue;
        if (hash(intent.broker || {}) !== hash(order)) {
          (intent.events ||= []).push({ at: snap.observedAt, type: "broker-observed", broker: order });
        }
        intent.brokerOrderId = order.orderId; intent.broker = order; intent.reconciledAt = snap.observedAt;
        if (uncertainOrder(order)) { intent.status = "unknown"; intent.error = "Broker still reports an uncertain order status; do not retry."; }
        else if (intent.kind === "order" || ["CANCELLED_ALL", "CANCELLED_PART", "FILLED_ALL", "FAILED", "SUBMIT_FAILED", "DELETED", "DISABLED", "FILL_CANCELLED"].includes(order.status)) { intent.status = "acknowledged"; intent.error = null; }
      }
      const policy = await this.policy();
      state.samples.push({ accountId: snap.accountId, market: snap.market, currency: snap.currency, observedAt: snap.observedAt,
        policyRevision: policy.revision || null, ...snap.funds });
      state.samples = state.samples.slice(-2000);
      state.snapshots = [...(state.snapshots || []).filter((s) => s.accountId !== snap.accountId || s.market !== snap.market), snap].slice(-20);
      await writeJson(path.join(this.dir, "state.json"), state);
      return { snapshot: snap, intents: state.intents.filter(matches).slice(-100).reverse(), samples: state.samples.filter(matches).slice(-300) };
    });
  }
  async assess(input, policy, state) {
    this.requireEnabled();
    if (!policy.enabled) fail("Agent execution is paused. Enable a bounded SIMULATE policy in the dashboard first.");
    if (!policy.allowedSymbols.includes(input.symbol)) fail("Symbol is outside authorized allowlist");
    const code = futuCode(input.symbol, policy.market);
    if (input.quantity % policy.lotSizes[input.symbol] !== 0) fail("Quantity does not match authorized board lot");
    const notional = input.quantity * input.limitPrice;
    if (!finite(notional) || notional > policy.maxOrderValue) fail("Single-order notional limit exceeded");
    const relevant = state.intents.filter((r) => r.accountId === policy.accountId && r.market === policy.market);
    if (relevant.some((r) => ["dispatching", "unknown"].includes(r.status))) fail("Unresolved broker request exists. Refresh/reconcile before new orders; do not retry with a new key.");
    const today = relevant.filter((r) => r.kind === "order" && r.dispatchedAt && tradingDate(r.dispatchedAt, policy.market) === tradingDate(this.now(), policy.market));
    if (today.length >= policy.maxOrdersPerDay || today.reduce((n, r) => n + r.notional, 0) + notional > policy.maxDailyOrderValue) fail("Daily order count/notional budget exceeded (cancellations do not reset budget)");
    const last = relevant.filter((r) => r.dispatchedAt).at(-1);
    if (last && Date.parse(this.now()) - Date.parse(last.dispatchedAt) < 3000) fail("Wait at least 3 seconds between broker writes");
    const quote = await this.quote(input.symbol);
    const age = Date.parse(this.now()) - Date.parse(quote.asOf);
    if (quote.demo || quote.synthetic || quote.symbol !== input.symbol || quote.currency !== policy.currency || !finite(quote.price) || quote.price <= 0 || !Number.isFinite(age) || age < -5000 || age > policy.maxQuoteAgeSeconds * 1000 || quote.signalEligible !== true || quote.freshness?.status !== "fresh" || quote.freshness?.signalEligible !== true || !["matched", "fallback", "unavailable"].includes(quote.crossCheck?.status)) fail("Real quote is missing, stale, market-closed or in conflict; simulation execution paused");
    if (Math.abs(input.limitPrice / quote.price - 1) * 100 > policy.maxLimitDeviationPct) fail("Limit price deviates too far from current verified quote");
    const selectedStrategy = input.side === "BUY" ? policy.entryStrategy : policy.exitStrategy;
    const evaluation = evaluateDeclarativeStrategy(quote, selectedStrategy);
    if (!evaluation.selected || evaluation.missingFeatures.length) fail(`Configured ${input.side} strategy did not pass, or features are missing: ${JSON.stringify(evaluation)}`);
    const snapshot = await this.snapshot(policy);
    const holdings = snapshot.positions.filter((p) => p.code === code);
    if (holdings.some((p) => p.currency !== policy.currency)) fail("Position currency is missing or mismatched");
    if (input.side === "SELL") {
      const available = holdings.reduce((n, p) => n + (finite(p.canSellQuantity) ? p.canSellQuantity : 0), 0);
      if (available < input.quantity) fail("Insufficient sellable long position; shorts are disabled");
    } else {
      const openBuys = snapshot.orders.filter((o) => o.side === "BUY" && activeOrder(o));
      if (openBuys.some((o) => !finite(o.price) || !finite(o.quantity) || !finite(o.filledQuantity) || o.quantity < o.filledQuantity || o.price <= 0)) fail("Unverifiable open-order commitments; no new buys");
      if (holdings.some((p) => !finite(p.quantity) || p.quantity < 0 || !finite(p.marketValue) || p.marketValue < 0)) fail("Unverifiable/short position; no new buys");
      const commitments = openBuys.reduce((n, o) => n + (o.quantity - o.filledQuantity) * o.price, 0);
      const currentValue = holdings.reduce((n, p) => n + Math.max(p.marketValue, p.quantity * quote.price), 0);
      const symbolPending = openBuys.filter((o) => o.code === code).reduce((n, o) => n + (o.quantity - o.filledQuantity) * o.price, 0);
      if (!finite(snapshot.funds?.cash) || snapshot.funds.cash < commitments + notional) fail("Insufficient verified cash after open buy commitments; margin is not used");
      if (currentValue + symbolPending + notional > policy.maxPositionValue) fail("Position notional limit including pending buys exceeded");
    }
    // Recheck after potentially slow broker reads; never dispatch an expired quote.
    if (Date.parse(this.now()) - Date.parse(quote.asOf) > policy.maxQuoteAgeSeconds * 1000) fail("Quote expired while checking broker account");
    return { code, notional, evaluation, strategy: selectedStrategy,
      quote: { symbol: quote.symbol, price: quote.price, currency: quote.currency, asOf: quote.asOf, source: quote.source, dataSources: quote.dataSources, freshness: quote.freshness, crossCheck: quote.crossCheck, indicators: quote.indicators },
      account: { accountId: policy.accountId, market: policy.market, observedAt: snapshot.observedAt, funds: snapshot.funds }, checkedAt: this.now() };
  }
  async evaluate(input) {
    const order = validatePaperOrder(input);
    return this.exclusive(async () => {
      try { const check = await this.assess(order, await this.policy(), await this.state()); return { eligible: true, ...check, environment: "SIMULATE", meaning: "Point-in-time preflight only; submit rechecks all gates and records the order." }; }
      catch (e) { return { eligible: false, reason: e.message, environment: "SIMULATE", checkedAt: this.now() }; }
    });
  }
  async submit(input) {
    const order = validatePaperOrder(input);
    return this.exclusive(async () => {
      const state = await this.state(); const requestHash = hash(order);
      const prior = state.intents.find((r) => r.idempotencyKey === order.idempotencyKey);
      if (prior) { if (prior.requestHash !== requestHash) fail("Idempotency key already used for a different request"); return { ...prior, replay: true }; }
      if (state.intents.length >= 10000) fail("Paper ledger full; archive for a new experiment before proceeding");
      const policy = await this.policy();
      const intent = { id: randomUUID(), kind: "order", ...order, requestHash, accountId: policy.accountId,
        market: policy.market, currency: policy.currency, policyRevision: policy.revision, authorization: structuredClone(policy),
        createdAt: this.now(), status: "checking", events: [] };
      try { Object.assign(intent, await this.assess(order, policy, state)); }
      catch (e) { Object.assign(intent, { status: "blocked", error: e.message }); intent.events.push({ at: this.now(), type: "blocked", error: e.message }); state.intents.push(intent); await writeJson(path.join(this.dir, "state.json"), state); return intent; }
      Object.assign(intent, { status: "dispatching", dispatchedAt: this.now() });
      intent.events.push({ at: intent.dispatchedAt, type: "dispatching" }); state.intents.push(intent);
      // Durable intent before side effect. A crash leaves dispatching, which blocks replay.
      await writeJson(path.join(this.dir, "state.json"), state);
      try {
        const result = await this.bridge({ action: "submit", ...account(policy), code: intent.code, side: order.side,
          quantity: order.quantity, limitPrice: order.limitPrice, quoteValidUntil: Date.parse(intent.quote.asOf) + policy.maxQuoteAgeSeconds * 1000, remark: `hrouter:${intent.id}` });
        const broker = result.orders?.[0];
        if (!broker?.orderId || uncertainOrder(broker) || broker.code !== intent.code || broker.side !== intent.side) fail("Missing or mismatched broker order acknowledgement");
        Object.assign(intent, { status: "acknowledged", brokerOrderId: broker.orderId, broker, acknowledgedAt: this.now() });
      } catch (e) { Object.assign(intent, { status: e.definitelyNotDispatched ? "blocked" : "unknown", error: e.message }); }
      intent.events.push({ at: this.now(), type: intent.status, broker: intent.broker || null, error: intent.error || null });
      await writeJson(path.join(this.dir, "state.json"), state);
      return intent;
    });
  }
  async cancel(input) {
    if ((input.environment && input.environment !== "SIMULATE") || !/^[A-Za-z0-9_-]{8,80}$/.test(input.idempotencyKey || "") || !/^[A-Za-z0-9_-]{1,80}$/.test(input.orderId || "")) fail("Valid cancel identity and SIMULATE environment required");
    return this.exclusive(async () => {
      this.requireEnabled(); const policy = await this.policy(); const state = await this.state();
      const requestHash = hash({ kind: "cancel", orderId: input.orderId });
      const previous = state.intents.find((r) => r.idempotencyKey === input.idempotencyKey);
      if (previous) { if (previous.requestHash !== requestHash) fail("Idempotency key conflict"); return { ...previous, replay: true }; }
      // Agent can only cancel plugin-originated, recorded SIMULATE orders, even after pausing.
      const original = state.intents.find((r) => r.kind === "order" && r.brokerOrderId === input.orderId);
      if (!original) fail("Only this plugin's acknowledged simulation orders may be cancelled");
      if (state.intents.length >= 10000) fail("Paper ledger full");
      if (state.intents.some((r) => r.brokerOrderId === input.orderId && ["dispatching", "unknown"].includes(r.status))) fail("Unresolved request for this order; reconcile before cancellation");
      const existingCancel = state.intents.find((r) => r.kind === "cancel" && r.brokerOrderId === input.orderId && r.status === "acknowledged");
      if (existingCancel) return { ...existingCancel, replay: true, meaning: "Cancellation was already requested; refresh broker state rather than send another request." };
      const snapshot = await this.snapshot(original);
      const broker = snapshot.orders.find((o) => o.orderId === input.orderId);
      if (!broker || !["SUBMITTED", "FILLED_PART"].includes(broker.status)) fail("Order is not currently cancellable");
      const last = state.intents.filter((r) => r.dispatchedAt).at(-1);
      if (last && Date.parse(this.now()) - Date.parse(last.dispatchedAt) < 3000) fail("Wait 3 seconds between broker writes");
      const intent = { id: randomUUID(), kind: "cancel", idempotencyKey: input.idempotencyKey, requestHash,
        ...account(original), environment: "SIMULATE", brokerOrderId: input.orderId, policyRevision: policy.revision,
        createdAt: this.now(), dispatchedAt: this.now(), status: "dispatching", events: [{ at: this.now(), type: "dispatching" }] };
      state.intents.push(intent); await writeJson(path.join(this.dir, "state.json"), state);
      try {
        await this.bridge({ action: "cancel", ...account(original), orderId: input.orderId });
        intent.status = "acknowledged"; intent.acknowledgedAt = this.now(); intent.meaning = "Cancellation request acknowledged, not confirmation of cancellation; refresh broker state.";
      } catch (e) { intent.status = e.definitelyNotDispatched ? "blocked" : "unknown"; intent.error = e.message; }
      intent.events.push({ at: this.now(), type: intent.status, error: intent.error || null });
      await writeJson(path.join(this.dir, "state.json"), state); return intent;
    });
  }
}
let service;
export function getPaperService() { return service ||= new PaperService(); }
