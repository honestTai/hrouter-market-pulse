import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function evaluateAlertTransitions(quotes, previous = {}, { now = new Date().toISOString(), rules = [], cooldownSeconds = 900, confirmations = 2, hysteresisPct = 0.2 } = {}) {
  const state = structuredClone(previous);
  const events = [];
  const timestamp = Date.parse(now);
  for (const quote of quotes) {
    if (quote.error || quote.freshness?.signalEligible !== true || quote.crossCheck?.status !== "matched") {
      for (const key of Object.keys(state).filter((key) => key.startsWith(`${quote.symbol}:`))) state[key].candidateCount = 0;
      continue;
    }
    const definitions = rules.filter((rule) => rule.symbol === quote.symbol);
    if (!definitions.length) {
      definitions.push({ id: "move-up", field: "changePct", direction: "above", threshold: 3, recoveryDelta: 0.2 });
      definitions.push({ id: "move-down", field: "changePct", direction: "below", threshold: -3, recoveryDelta: 0.2 });
    }
    for (const rule of definitions) {
      const value = rule.field === "changePct" ? quote.changePct : rule.field === "volumeRatioSameTime" ? quote.intraday?.volumeRatioSameTime?.value : quote.price;
      if (!Number.isFinite(value) || !Number.isFinite(rule.threshold)) continue;
      const key = `${quote.symbol}:${rule.id ?? `${rule.field ?? "price"}:${rule.direction}:${rule.threshold}`}`;
      const old = state[key];
      const above = rule.direction !== "below";
      const triggered = above ? value >= rule.threshold : value <= rule.threshold;
      const margin = rule.recoveryDelta ?? Math.abs(rule.threshold) * (rule.hysteresisPct ?? hysteresisPct) / 100;
      const recovered = above ? value < rule.threshold - margin : value > rule.threshold + margin;
      if (!old) {
        state[key] = { active: triggered, candidateCount: 0, lastValue: value, observedAt: quote.asOf, updatedAt: now, lastEventAt: null };
        continue;
      }
      if (Date.parse(quote.asOf) <= Date.parse(old.observedAt)) continue;
      const next = { ...old, lastValue: value, observedAt: quote.asOf, updatedAt: now };
      const required = Math.max(1, rule.confirmations ?? confirmations);
      if (!old.active && triggered) {
        next.candidateCount = (Date.parse(quote.asOf) - Date.parse(old.observedAt) > 1800000 ? 0 : old.candidateCount ?? 0) + 1;
        if (next.candidateCount >= required) {
          next.active = true;
          next.candidateCount = 0;
          if (!old.lastEventAt || timestamp - Date.parse(old.lastEventAt) >= (rule.cooldownSeconds ?? cooldownSeconds) * 1000) {
            events.push({ id: `${key}:${quote.asOf}:triggered`, key, symbol: quote.symbol, code: "threshold-crossed", state: "triggered", field: rule.field ?? "price", direction: above ? "above" : "below", threshold: rule.threshold, value, asOf: quote.asOf, generatedAt: now });
            next.lastEventAt = now;
          }
        }
      } else if (old.active && recovered) {
        next.active = false;
        next.candidateCount = 0;
        events.push({ id: `${key}:${quote.asOf}:recovered`, key, symbol: quote.symbol, code: "threshold-recovered", state: "recovered", field: rule.field ?? "price", direction: above ? "above" : "below", threshold: rule.threshold, value, asOf: quote.asOf, generatedAt: now });
      } else if (!triggered) next.candidateCount = 0;
      state[key] = next;
    }
  }
  return { state, events, generatedAt: now, initializedWithoutNotification: true };
}

let writeQueue = Promise.resolve();
export function updateMonitorState(storageDir, quotes, options = {}) {
  const run = writeQueue.then(async () => {
    await mkdir(storageDir, { recursive: true });
    const file = path.join(storageDir, "monitor-state.json");
    let previous = {};
    try { previous = JSON.parse(await readFile(file, "utf8")).state ?? {}; } catch (error) { if (error.code !== "ENOENT") throw error; }
    const result = evaluateAlertTransitions(quotes, previous, options);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(result, null, 2), "utf8");
    await rename(temporary, file);
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}
