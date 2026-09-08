import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveMarketContext,
  eventsFromEvidence,
  officialUrl,
  secSubmissionRecords,
  secFinancialRecords,
} from "../mcp/workspace.mjs";

test("relative strength uses matching sessions and labels watchlist breadth", () => {
  const items = [
    {
      symbol: "AAPL",
      market: "US",
      changePct: 2,
      asOf: "2026-09-08T14:00:00Z",
    },
    {
      symbol: "MSFT",
      market: "US",
      changePct: -1,
      asOf: "2026-09-08T14:00:00Z",
    },
  ];
  const context = deriveMarketContext(
    items,
    [
      {
        symbol: "^GSPC",
        market: "US",
        changePct: 1,
        asOf: "2026-09-08T14:00:00Z",
      },
    ],
    { AAPL: "Technology", MSFT: "Technology" },
  );
  assert.equal(context.breadth.scope, "watchlist");
  assert.equal(context.breadth.advancing, 1);
  assert.equal(context.sectors[0].changePct, 0.5);
  assert.equal(context.relativeStrength[0].relativeDayPct, 1);
  assert.equal(context.relativeStrength[0].relative20dPct, null);
  assert.equal(
    deriveMarketContext(items, [
      { market: "US", changePct: 1, asOf: "2026-09-07T14:00:00Z" },
    ]).relativeStrength[0].relativeDayPct,
    null,
  );
});

test("official source imports reject impersonated domains and private network URLs", () => {
  assert.equal(
    officialUrl("https://www.hkexnews.hk/listedco/a.pdf").hostname,
    "www.hkexnews.hk",
  );
  for (const value of [
    "http://www.sec.gov/a",
    "https://sec.gov.evil.example/a",
    "https://127.0.0.1/a",
    "https://user@www.sec.gov/a",
    "https://www.sec.gov:444/a",
  ])
    assert.throws(() => officialUrl(value));
});

test("SEC filings retain original acceptance and amendment metadata", () => {
  const records = secSubmissionRecords("AAPL", "0000320193", {
    name: "Apple",
    filings: {
      recent: {
        accessionNumber: ["0000320193-26-000001"],
        form: ["10-Q/A"],
        primaryDocument: ["report.htm"],
        filingDate: ["2026-08-01"],
        reportDate: ["2026-06-30"],
        acceptanceDateTime: ["2026-08-01T20:00:00Z"],
      },
    },
  });
  assert.equal(records[0].payload.amended, true);
  assert.equal(records[0].publishedAt, "2026-08-01T20:00:00.000Z");
  assert.equal(records[0].availableAt, undefined);
  assert.match(
    records[0].sourceUrl,
    /\/320193\/000032019326000001\/report.htm$/,
  );
});

test("financial concepts retain units and reporting period instead of mixing totals", () => {
  const records = secFinancialRecords("AAPL", "320193", {
    entityName: "Apple",
    facts: {
      "us-gaap": {
        NetIncomeLoss: {
          units: {
            USD: [
              {
                val: 10,
                start: "2026-01-01",
                end: "2026-03-31",
                filed: "2026-05-01",
                form: "10-Q",
                accn: "example",
              },
            ],
          },
        },
      },
    },
  });
  assert.equal(records[0].payload.unit, "USD");
  assert.equal(records[0].payload.periodStart, "2026-01-01");
  assert.equal(records[0].availableAt, undefined);
});

test("event calendar requires explicit announced event date, not inferred earnings dates", () => {
  const events = eventsFromEvidence([
    {
      id: "ev_1",
      entity: { symbol: "AAPL" },
      title: "Earnings",
      payload: { eventType: "earnings", scheduledAt: "2026-10-01T20:00:00Z" },
      sourceUrl: "https://www.sec.gov/a",
      availableAt: "2026-09-01T00:00:00Z",
    },
    { id: "ev_2", payload: {}, entity: { symbol: "AAPL" } },
  ]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].evidenceIds, ["ev_1"]);
});
