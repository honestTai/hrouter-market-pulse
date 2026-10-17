// Instant alerts to the owner's digest webhook: an order waiting for confirmation, a drawdown
// breaker, a paused trader, an exhausted quota pool. The service checks once a minute and remembers
// what it already sent in <arena>/alerts.json, so every alert goes out once.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const ALERT_INTERVAL_MS = 60000;
const KEEP = 500;
const MAX_PER_PASS = 10;

const KIND_TITLE = { approval: "订单等你确认", breaker: "回撤熔断", paused: "交易员已暂停", pool: "额度用尽" };

// What is worth telling the owner right now. Each alert id changes when the situation recurs.
export async function collectAlerts({ arena, scheduler }) {
  const alerts = [];
  const names = new Map();
  for (const summary of await arena.listAccounts({ status: "active" })) {
    names.set(summary.id, summary.name);
    const account = await arena.getAccount(summary.id, { sync: false, limit: 1 });
    for (const approval of account.approvals ?? []) {
      if (approval.status !== "pending") continue;
      const order = approval.preview ?? approval.input ?? {};
      alerts.push({ id: `approval:${approval.id}`, kind: "approval", accountId: account.id, at: approval.createdAt, text: `${account.name}：${order.side === "SELL" ? "卖出" : "买入"} ${order.name ?? order.symbol ?? ""} ${order.quantity ?? ""} 股，等你确认（${approval.reason ?? ""}），${approval.expiresAt} 过期。` });
    }
    const breaker = account.risk?.breaker;
    if (breaker) alerts.push({ id: `breaker:${account.id}:${breaker.trippedAt}`, kind: "breaker", accountId: account.id, at: breaker.trippedAt, text: `${account.name}：回撤 ${breaker.drawdownPct}% 触发熔断，已禁止新买入。` });
  }
  if (scheduler) {
    for (const job of await scheduler.listJobs()) {
      if (!job.paused) continue;
      alerts.push({ id: `paused:${job.accountId}:${job.paused.at ?? ""}`, kind: "paused", accountId: job.accountId, at: job.paused.at, text: `${names.get(job.accountId) ?? job.accountId}：已暂停（${job.paused.message ?? job.paused.kind}），修好后在工作台恢复。` });
    }
    for (const pool of await scheduler.listPools()) {
      if (!pool.paused) continue;
      alerts.push({ id: `pool:${pool.key}:${pool.pausedUntil}`, kind: "pool", at: pool.at ?? null, text: `${pool.key} 额度用尽，${pool.pausedUntil} 恢复；${pool.traders.length} 个交易员受影响，有备用的由备用代班。` });
    }
  }
  return alerts;
}

export function alertPayload(alert, format = "generic") {
  const title = `【HRouter】${KIND_TITLE[alert.kind] ?? alert.kind}`;
  if (format === "wecom") return { msgtype: "markdown", markdown: { content: `**${title}**\n${alert.text}` } };
  if (format === "feishu") return { msg_type: "text", content: { text: `${title}\n${alert.text}` } };
  return { type: "hrouter.arena.alert", version: 1, id: alert.id, kind: alert.kind, title, text: alert.text, accountId: alert.accountId ?? null, at: alert.at ?? null, paperTradingOnly: true };
}

async function readSent(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeSent(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 1), "utf8");
  await rename(temporary, file);
}

// One pass: post alerts that were not sent before. The first pass ever only records what is already
// there, so turning the service on does not flood the owner with old news.
export async function sendAlerts({ arena, scheduler, loadPreferences, fetchImpl = fetch, timeoutMs = 10000, now = () => new Date().toISOString() }) {
  const webhook = (await loadPreferences())?.digestWebhook;
  if (!webhook?.url || webhook.enabled === false) return { sent: [], skipped: "no-webhook" };
  const file = path.join(arena.root, "alerts.json");
  const state = await readSent(file);
  const alerts = await collectAlerts({ arena, scheduler });
  if (!state) { await writeSent(file, { sent: alerts.map((alert) => alert.id), at: now() }); return { sent: [], seeded: alerts.length }; }
  const known = new Set(state.sent);
  const fresh = alerts.filter((alert) => !known.has(alert.id)).slice(0, MAX_PER_PASS);
  const sent = [];
  for (const alert of fresh) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(webhook.url, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": "hrouter-market-pulse-alert" }, body: JSON.stringify(alertPayload(alert, webhook.format)), signal: controller.signal });
      // A failed post is retried on the next pass; a webhook that rejects the shape is not retried forever.
      if (response.ok || response.status < 500) { known.add(alert.id); sent.push(alert.id); }
    } catch { /* retried next pass */ } finally { clearTimeout(timer); }
  }
  if (sent.length) await writeSent(file, { sent: [...known].slice(-KEEP), at: now() });
  return { sent };
}

export function startAlertLoop(options, intervalMs = ALERT_INTERVAL_MS) {
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try { await sendAlerts(options); } catch (error) { console.error(`Arena alerts: ${error.message}`); } finally { busy = false; }
  };
  const timer = setInterval(pass, intervalMs);
  timer.unref?.();
  setTimeout(pass, 5000).unref?.();
  return { stop() { clearInterval(timer); } };
}
