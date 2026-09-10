import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ingestEvidence,
  queryEvidence,
  registerDataProvider,
  recordPrediction,
} from "../mcp/foundation.mjs";
import {
  ingestOfficialRecords,
  listDecisions,
  recordDecision,
  reviewDecision,
  secFinancialRecords,
  secSubmissionRecords,
} from "../mcp/workspace.mjs";

const frozenAt = "2026-09-08T14:00:00.000Z";

async function isolatedWorkspace(run) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "hrouter-workspace-integration-"),
  );
  const previousDirectory = process.env.HROUTER_REPORT_DIR;
  const previousWatchlist = process.env.HROUTER_WATCHLIST;
  const originalFetch = globalThis.fetch;
  const OriginalDate = globalThis.Date;
  const fixed = OriginalDate.parse(frozenAt);
  let requests = 0;
  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [fixed]));
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate;
  process.env.HROUTER_REPORT_DIR = directory;
  delete process.env.HROUTER_WATCHLIST;
  globalThis.fetch = async (url) => {
    requests += 1;
    if (String(url).startsWith("https://qt.gtimg.cn/")) {
      const fields = Array(35).fill("");
      fields[1] = "Fixture";
      fields[3] = "100";
      fields[4] = "99";
      fields[30] = "20260908100000";
      fields[31] = "1";
      fields[32] = "1";
      return new Response(`v_fixture="${fields.join("~")}";`);
    }
    if (
      String(url).startsWith(
        "https://query1.finance.yahoo.com/v8/finance/chart/",
      )
    ) {
      const timestamps = Array.from(
        { length: 80 },
        (_, index) => fixed / 1000 - (80 - index) * 86400,
      );
      const values = Array(80).fill(100);
      return Response.json({
        chart: {
          result: [
            {
              timestamp: timestamps,
              meta: {
                regularMarketPrice: 100,
                regularMarketTime: fixed / 1000,
                currency: "USD",
              },
              indicators: {
                quote: [
                  {
                    open: values,
                    high: values,
                    low: values,
                    close: values,
                    volume: Array(80).fill(1000),
                  },
                ],
              },
            },
          ],
        },
      });
    }
    throw new Error(`Unexpected network endpoint in isolated test: ${url}`);
  };
  try {
    return await run({ directory, requestCount: () => requests });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Date = OriginalDate;
    if (previousDirectory === undefined) delete process.env.HROUTER_REPORT_DIR;
    else process.env.HROUTER_REPORT_DIR = previousDirectory;
    if (previousWatchlist === undefined) delete process.env.HROUTER_WATCHLIST;
    else process.env.HROUTER_WATCHLIST = previousWatchlist;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(
      path.basename(directory).startsWith("hrouter-workspace-integration-"),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

function filing(symbol, suffix = symbol) {
  return {
    kind: "filing",
    entity: { symbol },
    title: `${symbol} original filing`,
    sourceUrl: `https://www.sec.gov/Archives/${suffix}.htm`,
    publishedAt: "2026-09-07T20:00:00Z",
  };
}

test("decision originals stay immutable while multiple reviews append atomically", async () => {
  await isolatedWorkspace(async ({ directory, requestCount }) => {
    const original = await recordDecision({
      symbol: "aapl",
      state: "watch",
      thesis: "Review confirmed revenue growth",
      entryCondition: "Close above the observed range",
      invalidationCondition: "Growth thesis fails",
      horizon: "One quarter",
    });
    assert.equal(original.symbol, "AAPL");
    assert.equal(original.snapshot.price, 100);
    assert.equal(original.snapshot.freshness.signalEligible, true);
    const { originalHash, ...hashInput } = original;
    assert.equal(
      createHash("sha256").update(JSON.stringify(hashInput)).digest("hex"),
      originalHash,
    );
    await Promise.all([
      reviewDecision(original.id, {
        outcome: "open",
        notes: "First review",
        thesis: "Attempted overwrite",
      }),
      reviewDecision(original.id, {
        outcome: "closed",
        notes: "Second review",
      }),
    ]);
    const saved = (await listDecisions({ symbol: "AAPL" })).decisions[0];
    assert.deepEqual({ ...saved, reviews: [] }, original);
    assert.deepEqual(
      saved.reviews.map((review) => review.outcome),
      ["open", "closed"],
    );
    assert.ok(saved.reviews.every((review) => review.source === "user-review"));
    const disk = JSON.parse(
      await readFile(path.join(directory, "decisions.json"), "utf8"),
    );
    assert.equal(disk.length, 1);
    assert.equal(disk[0].originalHash, original.originalHash);
    assert.equal(requestCount(), 2);
  });
});

test("blank theses and unqualified entry candidates cannot enter the journal", async () => {
  await isolatedWorkspace(async ({ requestCount }) => {
    await assert.rejects(
      recordDecision({ symbol: "AAPL", thesis: " \n\t " }),
      /thesis/,
    );
    assert.equal(requestCount(), 0);
    await assert.rejects(
      recordDecision({
        symbol: "AAPL",
        state: "candidate",
        thesis: "A possible setup",
        entryCondition: " ",
        invalidationCondition: " ",
        riskBudget: " ",
      }),
      /Candidate requires entry/,
    );
    const evidence = await ingestOfficialRecords({ items: [filing("AAPL")] });
    await assert.rejects(
      recordDecision({
        symbol: "AAPL",
        state: "candidate",
        thesis: "A possible setup",
        entryCondition: "Price confirms",
        invalidationCondition: "Below support",
        riskBudget: "At most one percent",
        evidenceIds: evidence.ids,
        validationPredictionId: "prediction_unknown",
      }),
      /qualified.*prediction/,
    );
    assert.deepEqual((await listDecisions()).decisions, []);
  });
});

test("same-day date-only SEC filings and financial facts ingest at first observation", async () => {
  await isolatedWorkspace(async () => {
    const filings = secSubmissionRecords("AAPL", "0000320193", {
      name: "Apple",
      filings: {
        recent: {
          accessionNumber: ["0000320193-26-000001"],
          form: ["10-Q"],
          primaryDocument: ["report.htm"],
          filingDate: ["2026-09-08"],
          reportDate: ["2026-06-30"],
        },
      },
    });
    const financials = secFinancialRecords("AAPL", "0000320193", {
      entityName: "Apple",
      facts: {
        "us-gaap": {
          NetIncomeLoss: {
            units: {
              USD: [
                {
                  val: 1000,
                  filed: "2026-09-08",
                  form: "10-Q",
                  end: "2026-06-30",
                  start: "2026-04-01",
                  accn: "0000320193-26-000001",
                },
              ],
            },
          },
        },
      },
    });
    const result = await ingestOfficialRecords({
      items: [...filings, ...financials],
    });
    assert.equal(result.inserted, 2);
    const before = await queryEvidence({
      symbols: ["AAPL"],
      asOf: "2026-09-08T13:59:59Z",
    });
    const after = await queryEvidence({ symbols: ["AAPL"], asOf: frozenAt });
    assert.equal(before.totalMatched, 0);
    assert.equal(after.totalMatched, 2);
    assert.ok(after.items.every((item) => item.availableAt === frozenAt));
    assert.ok(
      after.items.every(
        (item) => item.payload.publicationTimePrecision === "date",
      ),
    );
  });
});

test("qualified candidates reject quote conflicts and require an executable risk budget", async () => {
  await isolatedWorkspace(async () => {
    const evidence = await ingestOfficialRecords({ items: [filing("AAPL")] });
    const prediction = await recordPrediction({
      symbol: "AAPL",
      modelVersion: "candidate-fixture",
      featureAt: "2026-09-04T20:00:00Z",
      recordedAt: frozenAt,
      probability: 0.6,
      horizonDays: 5,
      qualification: { qualified: true, status: "qualified" },
    });
    const request = {
      symbol: "AAPL",
      state: "candidate",
      thesis: "Explicit candidate fixture",
      entryCondition: "A defined trigger",
      invalidationCondition: "A defined invalidation",
      riskBudget: "One percent maximum",
      evidenceIds: evidence.ids,
      validationPredictionId: prediction.id,
    };
    await assert.rejects(recordDecision(request), /computable position budget/);
    const budgetRequest = {
      capital: 10000,
      capitalCurrency: "USD",
      maxLossPctPerIdea: 1,
      maxPositionPct: 20,
      availableCash: 0,
      ideas: [
        { symbol: "AAPL", entryPrice: 100, invalidationPrice: 90, lotSize: 1 },
      ],
    };
    await assert.rejects(
      recordDecision({ ...request, budgetRequest }),
      /no executable allocation/,
    );
    const validFetch = globalThis.fetch;
    globalThis.fetch = async (url, ...args) => {
      const response = await validFetch(url, ...args);
      if (String(url).startsWith("https://qt.gtimg.cn/"))
        return new Response(
          (await response.text()).replace("~100~99~", "~105~99~"),
        );
      return response;
    };
    await assert.rejects(
      recordDecision({
        ...request,
        budgetRequest: { ...budgetRequest, availableCash: 10000 },
      }),
      /cross-source conflict/,
    );
    globalThis.fetch = validFetch;
    const accepted = await recordDecision({
      ...request,
      budgetRequest: { ...budgetRequest, availableCash: 10000 },
    });
    assert.equal(accepted.verifiedBudget.ideas[0].quantityCeiling, 10);
    assert.equal((await listDecisions()).decisions.length, 1);
    globalThis.fetch = async (url, ...args) => String(url).startsWith("https://qt.gtimg.cn/")
      ? new Response("Unavailable", { status: 503 }) : validFetch(url, ...args);
    const singleSource = await recordDecision({
      ...request,
      budgetRequest: { ...budgetRequest, availableCash: 10000 },
    });
    assert.equal(singleSource.snapshot.crossCheck.status, "unavailable");
    assert.equal(singleSource.verifiedBudget.ideas[0].quantityCeiling, 10);
  });
});

test("journal evidence references must match the security and current availability", async () => {
  await isolatedWorkspace(async ({ requestCount }) => {
    const wrongSymbol = await ingestOfficialRecords({
      items: [filing("MSFT")],
    });
    await assert.rejects(
      recordDecision({
        symbol: "AAPL",
        thesis: "Wrong-symbol reference",
        evidenceIds: wrongSymbol.ids,
      }),
      /Evidence must already exist for this symbol/,
    );
    await registerDataProvider({
      id: "future-fixture",
      name: "Future fixture",
      sourceTier: "official",
      kinds: ["filing"],
      homepage: "https://www.sec.gov/",
    });
    const future = await ingestEvidence({
      items: [
        {
          ...filing("AAPL", "future"),
          providerId: "future-fixture",
          sourceTier: "official",
          publishedAt: "2026-09-09T12:00:00Z",
          availableAt: "2026-09-09T14:00:00Z",
        },
      ],
    });
    await assert.rejects(
      recordDecision({
        symbol: "AAPL",
        thesis: "Future evidence reference",
        evidenceIds: future.ids,
      }),
      /available now/,
    );
    assert.equal(requestCount(), 0);
    const currentEvidence = await ingestOfficialRecords({
      items: [filing("AAPL", "current")],
    });
    const accepted = await recordDecision({
      symbol: "AAPL",
      thesis: "Contemporaneous observation",
      evidenceIds: currentEvidence.ids,
    });
    assert.deepEqual(accepted.evidenceIds, currentEvidence.ids);
    assert.equal((await listDecisions()).decisions.length, 1);
  });
});
