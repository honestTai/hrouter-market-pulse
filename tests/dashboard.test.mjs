import test from "node:test";
import assert from "node:assert/strict";
import { buildReportHtml, buildEmptyHtml } from "../mcp/dashboard.mjs";
import { makeDemoReport, demoPreferences } from "../mcp/demo.mjs";

test("dashboard serializes untrusted report titles without terminating the data script", () => {
  const title = '</script><script>alert("injected")</script>';
  const html = buildReportHtml({ items: [{ name: title }] });
  assert.ok(!html.includes(title));
  const embedded = html.match(
    /id="report-data" type="application\/json">([\s\S]*?)<\/script>/,
  )[1];
  assert.equal(JSON.parse(embedded).items[0].name, title);
  assert.match(html, /\/assets\/dashboard\.js/);
  assert.doesNotMatch(html, /http-equiv="refresh"/);
});

test("empty dashboard has no fabricated securities and remains a usable shell", () => {
  const html = buildEmptyHtml();
  const embedded = html.match(
    /id="report-data" type="application\/json">([\s\S]*?)<\/script>/,
  )[1];
  const report = JSON.parse(embedded);
  assert.deepEqual(report.items, []);
  assert.equal(report.empty, true);
});

test("showcase data is explicitly synthetic with valid deterministic daily and intraday candles", () => {
  const options = { now: "2026-09-08T07:00:00.000Z" };
  const report = makeDemoReport(options);
  assert.equal(report.demo, true);
  assert.deepEqual(makeDemoReport(options), report);
  assert.equal(report.items.length, demoPreferences.watchlist.length);
  for (const item of report.items) {
    assert.ok(item.nameEn && item.nameZh);
    assert.ok(item.history.length >= 60);
    for (const rows of [item.history, item.intraday.history]) {
      let timestamp = 0;
      for (const row of rows) {
        assert.ok(Date.parse(row.timestamp) > timestamp);
        assert.ok(row.high >= Math.max(row.open, row.close));
        assert.ok(row.low <= Math.min(row.open, row.close));
        assert.ok(row.low > 0 && row.volume >= 0);
        timestamp = Date.parse(row.timestamp);
      }
    }
  }
});
