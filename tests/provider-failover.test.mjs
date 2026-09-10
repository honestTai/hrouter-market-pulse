import test from "node:test";
import assert from "node:assert/strict";
import { getQuote, getHistoricalQuote, parseTencentHistory } from "../mcp/core.mjs";
import { evaluateAlertTransitions } from "../mcp/monitor.mjs";
import { evaluateDeclarativeStrategy } from "../mcp/foundation.mjs";

const now = "2026-09-08T02:00:00Z";
const dates = Array.from({ length: 90 }, (_, i) => new Date(Date.parse("2026-06-01") + i * 86400000).toISOString().slice(0, 10));
const daily = dates.map((date) => [date, "100", "100", "101", "99", "1000"]);
const options = { now, calendarOverrides: {} };
function snapshot(price = 100, timestamp = "20260908100000", providerSymbol = "688800") {
  const fields = Array(35).fill("");
  fields[2] = providerSymbol; fields[3] = String(price); fields[4] = "99"; fields[30] = timestamp;
  return new Response(`v_test="${fields.join("~")}";`);
}
function yahoo(time = now) {
  return Response.json({ chart: { result: [{ timestamp: dates.map((date) => Date.parse(`${date}T01:30:00Z`) / 1000), meta: { regularMarketPrice: 100, regularMarketTime: Date.parse(time) / 1000, currency: "CNY" }, indicators: { quote: [{ open: dates.map(() => 100), close: dates.map(() => 100), high: dates.map(() => 101), low: dates.map(() => 99), volume: dates.map(() => 1000) }] } }] } });
}
function historyResponse(url) {
  const [code, , , , , adjustment] = new URL(url).searchParams.get("param").split(",");
  return Response.json({ data: { [code]: { [adjustment ? "qfqday" : "day"]: daily } } });
}

test("Yahoo 403 falls back to Tencent snapshot and daily indicators without blocking strategy", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes("yahoo") ? new Response("Forbidden", { status: 403 }) : String(url).includes("fqkline") ? historyResponse(url) : snapshot());
  const quote = await getQuote("688800", options);
  assert.equal(quote.provider, "Tencent Finance");
  assert.equal(quote.crossCheck.status, "fallback");
  assert.equal(quote.signalEligible, true);
  assert.equal(quote.indicators.sma20, 100);
  assert.ok(quote.history.length > 20);
  assert.equal(quote.period, "1d");
  assert.ok(quote.dataQuality.warnings.some((message) => message.includes("fallback")));
  const signal = evaluateDeclarativeStrategy(quote, { name: "price", version: "1", rules: [{ feature: "price", operator: "gt", value: 90, points: 1 }] });
  assert.equal(signal.selected, true);
  const historical = await getHistoricalQuote("688800", options);
  assert.equal(historical.provider, "Tencent Finance");
  assert.equal(historical.historyPriceBasis, "unadjusted");
});

test("Tencent failure leaves Yahoo eligible; a price conflict still blocks", async (t) => {
  let fail = true;
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes("yahoo") ? yahoo() : fail ? new Response("Unavailable", { status: 503 }) : snapshot(110));
  const quote = await getQuote("688800", options);
  assert.equal(quote.crossCheck.status, "unavailable");
  assert.equal(quote.signalEligible, true);
  fail = false;
  const conflict = await getQuote("688800", options);
  assert.equal(conflict.crossCheck.status, "divergent");
  assert.equal(conflict.signalEligible, false);
});

test("stale Yahoo switches to fresh Tencent; stale fallback cannot generate signals", async (t) => {
  let stale = false;
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes("yahoo") ? yahoo("2020-01-01T02:00:00Z") : String(url).includes("fqkline") ? historyResponse(url) : snapshot(100, stale ? "20200101100000" : "20260908100000"));
  const quote = await getQuote("688800", options);
  assert.equal(quote.provider, "Tencent Finance");
  assert.equal(quote.signalEligible, true);
  assert.equal(quote.dataSources[1].role, "rejected");
  stale = true;
  assert.equal((await getQuote("688800", options)).signalEligible, false);
});

test("history outage retains snapshot and both quote failures remain explicit", async (t) => {
  let both = false;
  t.mock.method(globalThis, "fetch", async (url) => !both && String(url).includes("qt.gtimg") ? snapshot() : new Response("Forbidden", { status: 403 }));
  const quote = await getQuote("688800", options);
  assert.equal(quote.price, 100);
  assert.equal(quote.indicators.sma20, null);
  assert.equal(quote.signalEligible, true);
  both = true;
  await assert.rejects(getQuote("688800", options), /Yahoo Finance.*403.*Tencent Finance.*403/);
  await assert.rejects(getHistoricalQuote("688800", options), /Daily history unavailable/);
});

test("Tencent history validates rows, aligns adjustment dates and excludes unfinished session", () => {
  const raw = { data: { sh688800: { day: [...structuredClone(daily), ["2026-09-08", "1000", "1000", "1000", "1000", "1000"]] } } };
  const adjusted = structuredClone(raw);
  adjusted.data.sh688800.qfqday = adjusted.data.sh688800.day.map((row) => [row[0], "50", "50", "50", "50", row[5]]);
  adjusted.data.sh688800.qfqday.at(-1)[2] = "1000";
  const quote = parseTencentHistory("688800", raw, adjusted, options);
  assert.equal(quote.indicators.sma20, 50);
  assert.equal(quote.history.at(-1).complete, false);
  assert.equal(quote.history[0].close, 100);
  assert.equal(quote.history[0].adjustedClose, 50);
  raw.data.sh688800.day[0][4] = "200";
  assert.throws(() => parseTencentHistory("688800", raw, adjusted, options), /Invalid Tencent OHLCV/);
});

test("US history uses the provider exchange suffix instead of ambiguous bare ticker", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(String(url));
    return String(url).includes("yahoo") ? new Response("Forbidden", { status: 403 }) : String(url).includes("fqkline") ? historyResponse(url) : snapshot(100, "20260908100000", "AAPL.OQ");
  });
  await getHistoricalQuote("AAPL", options);
  assert.ok(requests.some((url) => decodeURIComponent(url).includes("usAAPL.OQ,day")));
});

test("single-source price transitions notify with provenance; conflicts suppress", () => {
  for (const status of ["fallback", "unavailable", "divergent"]) {
    const quote = (price, minute) => ({ symbol: "688800.SS", price, provider: "Tencent Finance", asOf: `2026-09-08T02:0${minute}:00Z`, freshness: { signalEligible: true }, crossCheck: { status } });
    const settings = { now, confirmations: 1, rules: [{ symbol: "688800.SS", field: "price", direction: "above", threshold: 100 }] };
    const first = evaluateAlertTransitions([quote(99, 0)], {}, settings);
    const second = evaluateAlertTransitions([quote(101, 1)], first.state, settings);
    assert.equal(second.events.length, status === "divergent" ? 0 : 1);
    if (second.events.length) assert.equal(second.events[0].crossCheck.status, status);
  }
});
