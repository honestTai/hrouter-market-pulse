import assert from "node:assert/strict";
import test from "node:test";
import { alertPayload, sendAlerts } from "../mcp/alerts.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createArena } from "../mcp/arena.mjs";

const prices = { "000300.SS": 4000, "600036.SS": 40, "600900.SS": 28 };
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alerts-test-"));
  const clock = "2026-10-15T02:00:00.000Z";
  const arena = createArena({ root, quoteCacheMs: 0, now: () => clock, quoteProvider: async (symbol) => ({ symbol, name: { "600036.SS": "招商银行", "600900.SS": "长江电力" }[symbol] ?? symbol, price: prices[symbol], changePct: 0, asOf: clock, provider: "test", freshness: { status: "fresh" } }), industryProvider: async () => ({}) });
  return { arena, cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

const reason = "Breakout above 20-day high with volume confirmation.";

test("alerts: a new approval is posted once, the first pass only records what was there", async () => {
  const { arena, cleanup } = await setup();
  const posts = [];
  const fetchImpl = async (url, init) => { posts.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  let preferences = { digestWebhook: null };
  const run = () => sendAlerts({ arena, scheduler: null, loadPreferences: async () => preferences, fetchImpl });
  try {
    const { id } = await arena.createAccount({ name: "Kimi A", model: "k3", market: "A" }, { client: "kimi-code" });
    await arena.updateAccount(id, { autonomy: { level: "confirm" } });
    assert.equal((await run()).skipped, "no-webhook");
    preferences = { digestWebhook: { url: "https://example.test/hook", format: "generic", enabled: true } };
    await arena.placeOrder({ accountId: id, symbol: "600036", side: "BUY", quantity: 100, reason }, { client: "kimi-code" });
    assert.equal((await run()).seeded, 1, "first pass seeds without posting");
    assert.equal(posts.length, 0);
    await arena.placeOrder({ accountId: id, symbol: "600900", side: "BUY", quantity: 200, reason }, { client: "kimi-code" });
    assert.equal((await run()).sent.length, 1);
    assert.equal((await run()).sent.length, 0, "never twice");
    assert.equal(posts[0].type, "hrouter.arena.alert");
    assert.match(posts[0].text, /Kimi A：买入 长江电力 200 股，等你确认/);
  } finally { await cleanup(); }
});

test("alerts: bot payload shapes", () => {
  const alert = { id: "pool:codex:x", kind: "pool", text: "codex 额度用尽" };
  assert.match(alertPayload(alert, "wecom").markdown.content, /额度用尽/);
  assert.equal(alertPayload(alert, "feishu").msg_type, "text");
});
