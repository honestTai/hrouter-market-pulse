import { startDashboard } from "./http.mjs";
import {
  enrichReport,
  listDecisions,
  recordDecision,
  reviewDecision,
  syncOfficialEvidence,
  ingestOfficialRecords,
} from "./workspace.mjs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  buildEmptyHtml,
  calculatePositionBudget,
  createMarketReport,
  getMarketSnapshot,
  getNews,
  getOnboardingGuide,
  getQuote,
  getReportPort,
  getReportUrl,
  loadPreferences,
  loadReport,
  savePreferences,
  screenWatchlist,
} from "./core.mjs";
import {
  BASELINE_PREDICTION_FEATURES,
  EVIDENCE_KINDS,
  SOURCE_TIERS,
  STRATEGY_FEATURES,
  evaluateProbabilityCalibration,
  getFoundationCapabilities,
  ingestEvidence,
  monitorFeatureDrift,
  queryEvidence,
  registerDataProvider,
  runDeclarativeStrategy,
  runBaselinePrediction,
  runHistoricalBacktest,
  queryPredictionLedger,
  resolvePredictionOutcomes,
} from "./foundation.mjs";

const server = new McpServer({
  name: "hrouter-market-pulse",
  version: "1.1.1",
});

function toolResult(data, summary) {
  return {
    content: [
      { type: "text", text: `${summary}\n\n${JSON.stringify(data, null, 2)}` },
    ],
    structuredContent: data,
  };
}

function toolError(error) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

const providerIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/);
const evidenceIdSchema = z.string().regex(/^ev_[a-f0-9]{32}$/);
const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
const sourceTierSchema = z.enum(SOURCE_TIERS);
const strategyFeatureSchema = z.union([
  z.enum(STRATEGY_FEATURES),
  z.string().regex(/^external\.[A-Za-z][A-Za-z0-9_-]{0,63}$/),
]);
const strategyRuleSchema = z.object({
  feature: strategyFeatureSchema,
  operator: z.enum(["gt", "gte", "lt", "lte", "between"]),
  value: z.number(),
  value2: z.number().optional(),
  points: z.number().min(-100).max(100),
  label: z.string().min(1).max(160),
});
const declarativeStrategySchema = z.object({
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(40),
  baseScore: z.number().optional().default(0),
  minimumScore: z.number().optional().default(1),
  rules: z.array(strategyRuleSchema).min(1).max(50),
});
const externalFeatureRowSchema = z.object({
  symbol: z.string().min(1),
  availableAt: z.string().min(1),
  evidenceIds: z.array(evidenceIdSchema).min(1).max(100),
  values: z.record(z.number()),
});
const calendarSchema = z.record(
  z.object({
    coverageStart: z.string(),
    coverageEnd: z.string(),
    verifiedAt: z.string(),
    source: z.string().url(),
    closedDates: z.array(z.string()).optional(),
    openDates: z.array(z.string()).optional(),
    sessions: z
      .record(
        z.object({
          closed: z.boolean().optional(),
          sessions: z
            .array(
              z.tuple([
                z.number().int().min(0).max(1440),
                z.number().int().min(0).max(1440),
              ]),
            )
            .optional(),
        }),
      )
      .optional(),
  }),
);

server.registerTool(
  "get_foundation_capabilities",
  {
    title: "Get research foundation capabilities",
    description:
      "List versioned data contracts, built-in and companion providers, declarative strategy features, and the safe extension flow.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await getFoundationCapabilities();
      return toolResult(
        result,
        `Hrouter Market Pulse research foundation ${result.foundationVersion}.`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "register_data_provider",
  {
    title: "Register companion data provider",
    description:
      "Register metadata for a companion Skill or MCP data provider. It stores no credentials, endpoints, or executable code.",
    inputSchema: {
      id: providerIdSchema,
      name: z.string().min(1).max(120),
      sourceTier: sourceTierSchema,
      kinds: z.array(evidenceKindSchema).min(1).max(EVIDENCE_KINDS.length),
      homepage: z.string().url().optional(),
      notes: z.string().max(1000).optional(),
    },
  },
  async (input) => {
    try {
      const result = await registerDataProvider(input);
      return toolResult(
        result,
        `数据提供方 ${result.name} (${result.id}) 已注册。`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

const evidenceInputSchema = z.object({
  externalId: z.string().max(300).optional(),
  providerId: providerIdSchema,
  sourceTier: sourceTierSchema.optional().default("unknown"),
  kind: evidenceKindSchema,
  entity: z.object({
    symbol: z.string().min(1).optional(),
    name: z.string().min(1).max(300).optional(),
    identifiers: z.record(z.unknown()).optional(),
  }),
  title: z.string().min(1).max(1000),
  summary: z.string().max(20_000).optional(),
  sourceUrl: z.string().url(),
  publishedAt: z.string().min(1),
  effectiveAt: z.string().min(1).optional(),
  availableAt: z.string().min(1).optional(),
  fetchedAt: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional(),
});

server.registerTool(
  "ingest_evidence",
  {
    title: "Ingest point-in-time evidence",
    description:
      "Normalize and deduplicate quote, news, filing, financial, corporate-action, macro, or industry evidence. Undeclared historical availability defaults to first ingestion time.",
    inputSchema: {
      items: z.array(evidenceInputSchema).min(1).max(100),
    },
  },
  async (input) => {
    try {
      const result = await ingestEvidence(input);
      return toolResult(
        result,
        `证据写入完成：新增 ${result.inserted} 条，重复 ${result.duplicates} 条。`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "query_evidence",
  {
    title: "Query point-in-time evidence",
    description:
      "Query local normalized evidence as it was available at a requested time. Future-available evidence is excluded.",
    inputSchema: {
      asOf: z.string().optional(),
      publishedFrom: z.string().optional(),
      publishedTo: z.string().optional(),
      symbols: z.array(z.string().min(1)).max(50).optional(),
      kinds: z.array(evidenceKindSchema).max(EVIDENCE_KINDS.length).optional(),
      providerIds: z.array(providerIdSchema).max(50).optional(),
      sourceTiers: z
        .array(sourceTierSchema)
        .max(SOURCE_TIERS.length)
        .optional(),
      limit: z.number().int().min(1).max(500).optional().default(100),
    },
  },
  async (input) => {
    try {
      const result = await queryEvidence(input);
      return toolResult(
        result,
        `找到 ${result.totalMatched} 条在 ${result.asOf} 时已可用的证据。`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "run_strategy",
  {
    title: "Run declarative research strategy",
    description:
      "Run user-defined scoring rules over allowlisted market features. The result is a research filter, not a buy rating or order.",
    inputSchema: {
      symbols: z.array(z.string().min(1)).min(1).max(20),
      strategy: declarativeStrategySchema,
      externalFeatureRows: z
        .array(externalFeatureRowSchema)
        .max(5000)
        .optional(),
    },
  },
  async (input) => {
    try {
      const result = await runDeclarativeStrategy(input);
      return toolResult(
        result,
        `策略 ${result.strategy.name}@${result.strategy.version} 已运行。`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "run_backtest",
  {
    title: "Run leakage-aware historical backtest",
    description:
      "Backtest a declarative technical strategy with signals formed at day T close and entries at day T+1 open. Returns hit rate, return distribution, drawdown, assumptions, and limitations.",
    inputSchema: {
      symbols: z.array(z.string().min(1)).min(1).max(10),
      strategy: declarativeStrategySchema,
      range: z.enum(["1y", "2y", "5y"]).optional().default("2y"),
      warmupDays: z.number().int().min(20).max(252).optional().default(60),
      holdingPeriodDays: z.number().int().min(1).max(20).optional().default(1),
      transactionCostBps: z.number().min(0).max(500).optional().default(10),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      includeTrades: z.boolean().optional().default(true),
      externalFeatureRows: z
        .array(externalFeatureRowSchema)
        .max(5000)
        .optional(),
      initialCapital: z.number().positive().optional(),
      currency: z.string().length(3).optional(),
      maxPositionPct: z.number().positive().max(100).optional(),
      maxGrossExposurePct: z.number().positive().max(100).optional(),
      slippageBps: z.number().nonnegative().max(500).optional(),
      fxRates: z.record(z.number().positive()).optional(),
      lotSizes: z.record(z.number().positive()).optional(),
      asOf: z.string().optional(),
    },
  },
  async (input) => {
    try {
      const result = await runHistoricalBacktest(input);
      return toolResult(
        result,
        `回测完成：${result.metrics.trades} 笔独立交易样本。`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "run_prediction_model",
  {
    title: "Run experimental probability baseline",
    description:
      "Train a per-symbol logistic baseline on chronological price features, evaluate a purged holdout set, and return a current positive-return probability with calibration metrics. It is not a trade signal.",
    inputSchema: {
      symbols: z.array(z.string().min(1)).min(1).max(5),
      range: z.enum(["2y", "5y"]).optional().default("2y"),
      horizonDays: z.number().int().min(1).max(20).optional().default(5),
      holdoutPct: z.number().min(20).max(40).optional().default(30),
      transactionCostBps: z.number().min(0).max(500).optional().default(10),
      features: z
        .array(z.enum(BASELINE_PREDICTION_FEATURES))
        .min(1)
        .max(BASELINE_PREDICTION_FEATURES.length)
        .optional(),
      folds: z.number().int().min(3).max(5).optional(),
      slippageBps: z.number().nonnegative().max(500).optional(),
      asOf: z.string().optional(),
    },
  },
  async (input) => {
    try {
      const result = await runBaselinePrediction(input);
      const succeeded = result.results.filter(
        (item) => item.status !== "rejected" && !item.error,
      ).length;
      return toolResult(
        result,
        `实验性概率基线完成：${succeeded}/${result.results.length} 个标的可评估。`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "evaluate_prediction_calibration",
  {
    title: "Evaluate probability calibration",
    description:
      "Evaluate timestamped binary probability predictions using Brier score, log loss, directional accuracy, and calibration bins.",
    inputSchema: {
      bins: z.number().int().min(5).max(20).optional().default(10),
      predictions: z
        .array(
          z.object({
            probability: z.number().min(0).max(1),
            outcome: z.union([z.literal(0), z.literal(1), z.boolean()]),
            predictedAt: z.string().min(1),
            resolvedAt: z.string().min(1),
          }),
        )
        .min(1)
        .max(10_000),
    },
  },
  async (input) => {
    try {
      const result = evaluateProbabilityCalibration(input);
      return toolResult(result, `已评估 ${result.observations} 条概率预测。`);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "monitor_feature_drift",
  {
    title: "Monitor numeric feature drift",
    description:
      "Compare baseline and current numeric feature distributions using PSI, standardized mean shift, and missing-rate changes.",
    inputSchema: {
      series: z
        .array(
          z.object({
            feature: z.string().min(1).max(160),
            baseline: z.array(z.number().nullable()).min(20).max(10_000),
            current: z.array(z.number().nullable()).min(20).max(10_000),
          }),
        )
        .min(1)
        .max(100),
    },
  },
  async (input) => {
    try {
      const result = monitorFeatureDrift(input);
      return toolResult(result, `漂移检查完成：总体状态 ${result.status}。`);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_quote",
  {
    title: "Get stock quote",
    description:
      "Get a timestamped quote, recent price history, deterministic indicators, rule alerts, and cross-source verification for an A-share, Hong Kong, or US symbol. Public data can be delayed.",
    inputSchema: {
      symbol: z.string().min(1).describe("Examples: 600519, 0700.HK, AAPL"),
      phase: z.enum(["research", "intraday"]).optional(),
      includeIntraday: z.boolean().optional(),
    },
  },
  async ({ symbol, ...options }) => {
    try {
      const quote = await getQuote(symbol, options);
      return toolResult(
        quote,
        `${quote.name} (${quote.symbol}) ${quote.price ?? "--"} ${quote.currency ?? ""}, ${quote.changePct ?? "--"}%`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "screen_watchlist",
  {
    title: "Rank watchlist for research",
    description:
      "Rank up to 20 A-share, Hong Kong, or US symbols by transparent deterministic research-priority factors. Scores are not buy ratings or return forecasts.",
    inputSchema: {
      symbols: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .optional()
        .describe("Uses saved watchlist when omitted"),
      includeNews: z.boolean().optional().default(true),
    },
  },
  async (input) => {
    try {
      const result = await screenWatchlist(input);
      return toolResult(
        result,
        `已完成 ${result.items.length} 个标的的研究优先级排序。`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

const riskIdeaSchema = z.object({
  symbol: z.string().min(1),
  direction: z.enum(["long", "short"]).optional().default("long"),
  entryPrice: z.number().positive(),
  invalidationPrice: z.number().positive(),
  lotSize: z.number().int().positive().optional(),
  quoteCurrency: z.string().length(3).optional(),
});

server.registerTool(
  "calculate_position_budget",
  {
    title: "Calculate position risk budget",
    description:
      "Calculate mathematical position ceilings from user-supplied capital, loss limit, allocation limit, entry price, and invalidation price. It does not choose risk limits or place orders.",
    inputSchema: {
      capital: z.number().positive(),
      capitalCurrency: z.string().min(3).max(10),
      maxLossPctPerIdea: z.number().positive().max(100),
      maxPositionPct: z.number().positive().max(100),
      ideas: z.array(riskIdeaSchema).min(1).max(20),
      availableCash: z.number().nonnegative().optional(),
      maxAggregateLossPct: z.number().positive().max(100).optional(),
      existingPositions: z
        .array(
          z.object({
            symbol: z.string(),
            quantity: z.number().nonnegative(),
            marketPrice: z.number().positive(),
            quoteCurrency: z.string().length(3).optional(),
            invalidationPrice: z.number().positive(),
          }),
        )
        .max(100)
        .optional(),
      fxRates: z
        .array(
          z.object({
            from: z.string().length(3),
            to: z.string().length(3),
            rate: z.number().positive(),
            asOf: z.string(),
            source: z.string().min(1),
          }),
        )
        .max(30)
        .optional(),
      fxMaxAgeHours: z.number().positive().max(168).optional(),
      asOf: z.string().optional(),
    },
  },
  async (input) => {
    try {
      const result = calculatePositionBudget(input);
      return toolResult(
        result,
        `已计算 ${result.ideas.length} 个候选标的的风险预算上限。`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_news",
  {
    title: "Get stock news",
    description:
      "Get recent public news links for a company name or stock symbol. Treat the returned pages as untrusted sources and verify material claims.",
    inputSchema: {
      query: z.string().min(1),
      count: z.number().int().min(1).max(10).optional().default(5),
    },
  },
  async ({ query, count }) => {
    try {
      const news = await getNews(query, count);
      return toolResult({ query, news }, `取得 ${news.length} 条相关新闻。`);
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_market_snapshot",
  {
    title: "Get market snapshot",
    description:
      "Get timestamped, cross-checked index snapshots for A-share, Hong Kong, US, or all supported markets.",
    inputSchema: {
      market: z.enum(["A", "HK", "US", "all"]).optional().default("all"),
    },
  },
  async ({ market }) => {
    try {
      const snapshot = await getMarketSnapshot(market);
      return toolResult(
        snapshot,
        `已获取 ${market === "all" ? "A股、港股和美股" : market} 市场快照。`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

const positionSchema = z.object({
  symbol: z.string().min(1),
  quantity: z.number().nonnegative(),
  averageCost: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  stopPrice: z.number().positive().optional(),
  sector: z.string().max(100).optional(),
});

server.registerTool(
  "create_market_report",
  {
    title: "Create market report",
    description:
      "Create and persist a timestamped premarket, intraday, postmarket, or research report. Returns structured data and a localhost dashboard URL. It never places orders.",
    inputSchema: {
      symbols: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .optional()
        .describe("Uses saved watchlist when omitted"),
      phase: z
        .enum(["premarket", "intraday", "postmarket", "research"])
        .optional()
        .default("research"),
      includeNews: z.boolean().optional().default(true),
      positions: z.array(positionSchema).max(50).optional(),
    },
  },
  async (input) => {
    try {
      const report = await createMarketReport({ ...input, enrichReport });
      const compact = {
        runId: report.runId,
        generatedAt: report.generatedAt,
        phase: report.phase,
        summary: report.summary,
        items: report.items.map(({ history, news, ...item }) => ({
          ...item,
          news: news?.slice(0, 3),
          historyPoints: history?.length ?? 0,
        })),
        dashboardUrl: report.dashboardUrl,
        latestDashboardUrl: report.latestDashboardUrl,
        sourceNotice: report.sourceNotice,
      };
      return toolResult(
        compact,
        `${report.phaseLabel}已生成：${report.latestDashboardUrl}`,
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_latest_report",
  {
    title: "Get latest report",
    description:
      "Read the most recently generated Hrouter Market Pulse report and return its local dashboard URL.",
    inputSchema: {},
  },
  async () => {
    try {
      const report = JSON.parse(await loadReport("latest", "json"));
      const data = {
        ...report,
        items: report.items.map(({ history, ...item }) => ({
          ...item,
          historyPoints: history?.length ?? 0,
        })),
        dashboardUrl: getReportUrl(),
      };
      return toolResult(
        data,
        `最新报告：${report.phaseLabel}，生成于 ${report.generatedAt}。`,
      );
    } catch (error) {
      if (error.code === "ENOENT")
        return toolError(
          new Error("尚未生成报告。请先调用 create_market_report。"),
        );
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_onboarding",
  {
    title: "Get first-run guide",
    description:
      "Show first-run setup steps, watchlist status, HRouter website, and Codex scheduled-task templates without exposing credentials.",
    inputSchema: {},
  },
  async () => {
    try {
      const guide = await getOnboardingGuide();
      return toolResult(
        guide,
        guide.firstRun
          ? "欢迎使用 Hrouter Market Pulse，请先完成首次配置。"
          : "Hrouter Market Pulse 已完成基础配置。",
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_preferences",
  {
    title: "Get plugin preferences",
    description:
      "Show the saved watchlist, report location, dashboard URL, market-data providers, and current Codex analysis engine.",
    inputSchema: {},
  },
  async () => {
    try {
      const preferences = await loadPreferences();
      return toolResult(
        { ...preferences, dashboardUrl: getReportUrl() },
        "Hrouter Market Pulse 当前配置。API Key 不会返回。",
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "save_preferences",
  {
    title: "Save plugin preferences",
    description:
      "Save the user's explicitly requested watchlist and report language. Never accepts or stores an API key.",
    inputSchema: {
      watchlist: z.array(z.string().min(1)).max(50).optional(),
      language: z.enum(["zh-CN", "en"]).optional(),
      positions: z.array(positionSchema).max(100).optional(),
      benchmarkSymbols: z.record(z.string()).optional(),
      sectorMap: z.record(z.string()).optional(),
      alertRules: z
        .array(
          z.object({
            symbol: z.string(),
            id: z.string().optional(),
            field: z
              .enum(["price", "changePct", "volumeRatioSameTime"])
              .optional(),
            direction: z.enum(["above", "below"]),
            threshold: z.number(),
            confirmations: z.number().int().min(1).max(20).optional(),
            cooldownSeconds: z.number().nonnegative().max(86400).optional(),
            hysteresisPct: z.number().nonnegative().max(100).optional(),
            recoveryDelta: z.number().nonnegative().optional(),
          }),
        )
        .max(100)
        .optional(),
      calendarOverrides: calendarSchema.optional(),
      monitorIntervalSeconds: z.number().int().min(60).max(3600).optional(),
    },
  },
  async (input) => {
    try {
      const preferences = await savePreferences(input);
      return toolResult(
        { ...preferences, dashboardUrl: getReportUrl() },
        "偏好已保存。",
      );
    } catch (error) {
      return toolError(error);
    }
  },
);

function registerWorkspaceTool(name, description, inputSchema, action) {
  server.registerTool(
    name,
    { title: name.replaceAll("_", " "), description, inputSchema },
    async (input) => {
      try {
        return toolResult(await action(input), description);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

registerWorkspaceTool(
  "sync_official_evidence",
  "Fetch supported official filings and financial facts into the point-in-time evidence store.",
  {
    symbols: z.array(z.string()).max(20).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  },
  syncOfficialEvidence,
);
registerWorkspaceTool(
  "ingest_official_records",
  "Import original exchange or regulator records, preserving first-observed availability.",
  {
    items: z
      .array(evidenceInputSchema.omit({ providerId: true, sourceTier: true }))
      .min(1)
      .max(100),
  },
  ingestOfficialRecords,
);
registerWorkspaceTool(
  "record_decision",
  "Record an immutable decision thesis and its current evidence before reviewing an outcome.",
  {
    symbol: z.string(),
    state: z
      .enum(["watch", "candidate", "hold", "review-exit", "inactive"])
      .optional(),
    thesis: z.string().min(1).max(2000),
    entryCondition: z.string().max(2000).optional(),
    invalidationCondition: z.string().max(2000).optional(),
    horizon: z.string().max(160).optional(),
    riskBudget: z.string().max(160).optional(),
    evidenceIds: z.array(evidenceIdSchema).max(100).optional(),
    validationPredictionId: z.string().optional(),
    budgetRequest: z
      .object({
        capital: z.number().positive(),
        capitalCurrency: z.string(),
        maxLossPctPerIdea: z.number().positive().max(100),
        maxPositionPct: z.number().positive().max(100),
        ideas: z.array(riskIdeaSchema),
        availableCash: z.number().nonnegative().optional(),
        maxAggregateLossPct: z.number().positive().max(100).optional(),
        existingPositions: z
          .array(
            z.object({
              symbol: z.string(),
              quantity: z.number(),
              marketPrice: z.number(),
              quoteCurrency: z.string().optional(),
              invalidationPrice: z.number(),
            }),
          )
          .optional(),
        fxRates: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              rate: z.number(),
              asOf: z.string(),
              source: z.string(),
            }),
          )
          .optional(),
      })
      .optional(),
  },
  recordDecision,
);
registerWorkspaceTool(
  "query_decisions",
  "Read recorded decision theses and appended reviews.",
  {
    symbol: z.string().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  listDecisions,
);
registerWorkspaceTool(
  "review_decision",
  "Append an outcome review without rewriting the original thesis.",
  {
    id: z.string(),
    outcome: z.enum([
      "open",
      "invalidated",
      "target-reached",
      "expired",
      "closed",
    ]),
    notes: z.string().max(2000).optional(),
  },
  ({ id, ...input }) => reviewDecision(id, input),
);
registerWorkspaceTool(
  "query_prediction_ledger",
  "Read timestamped model predictions recorded before outcomes.",
  {
    symbol: z.string().optional(),
    status: z.enum(["pending", "resolved", "unfilled"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  queryPredictionLedger,
);
registerWorkspaceTool(
  "resolve_prediction_outcomes",
  "Resolve recorded predictions from completed historical bars without rewriting forecasts.",
  {
    ids: z.array(z.string()).max(500).optional(),
    asOf: z.string().optional(),
  },
  resolvePredictionOutcomes,
);

const demo = process.argv.includes("--demo");
const dashboard = startDashboard({ demo });
dashboard.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
if (!demo && !process.argv.includes("--dashboard"))
  await server.connect(new StdioServerTransport());

async function shutdown() {
  dashboard.close();
  await server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
