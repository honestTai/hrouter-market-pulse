import test from "node:test";
import assert from "node:assert/strict";
import { buildReportHtml, buildEmptyHtml } from "../mcp/dashboard.mjs";

test("dashboard serializes untrusted report titles without terminating the data script", () => {
  const title = '</script><script>alert("injected")</script>';
  const html = buildReportHtml({ items: [{ name: title }] });
  assert.ok(!html.includes(title));
  const embedded = html.match(
    /id="report-data" type="application\/json">([\s\S]*?)<\/script>/,
  )[1];
  assert.equal(JSON.parse(embedded).items[0].name, title);
  assert.match(html, /\/assets\/app\/app\.js/);
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

