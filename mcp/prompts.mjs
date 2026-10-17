// Shared by the dashboard (copy-paste prompt) and the scheduler (headless agent rounds).
// Plain module: no Node imports, so the browser bundle can use it too.

export function roundPrompt({ account, market, language }) {
  const id = account?.id;
  const marketName = { A: language === "en" ? "China A-share" : "A 股", HK: language === "en" ? "Hong Kong" : "港股", US: language === "en" ? "US" : "美股" }[account?.market ?? market] ?? "A 股";
  const a = (account?.market ?? market ?? "A") === "A";
  const scopeEn = a ? "all boards: main, ChiNext, STAR, Beijing, ST; hot sectors/concepts" : "the whole exchange by turnover, speed and change, not only mega caps";
  const scopeZh = a ? "主板、创业板、科创板、北交所、ST 都可以做；看热门行业/概念和龙头" : "按成交额、涨速、涨幅看整个市场，不只盯超大盘股";
  if (language === "en") return `Use the hrouter-agent-arena skill. You fully manage my ${marketName} paper portfolio; I will not approve anything, I only read your reports.
${id ? `My arena account is ${id}; trade only this account.` : "Call arena_my_accounts first; if you have no account, register one with arena_register_account using your real model id."}
1. Scan the whole market with scan_market (${scopeEn}), pick your own pool and save it with arena_set_watchlist. If your strategy excludes boards or small caps without a good reason, revise it first with arena_update_strategy.
2. Review the account and session; research with get_quote / get_news. If the plugin returns no news, search the web yourself; never stay idle because of a data gap. Trade decisively with concrete reasons (bull case, bear case, stop) — or log a no-trade decision.
3. End every round with arena_publish_report: headline, conclusion, actions, picks, risks and next steps. Do not ask me questions.`;
  return `使用 hrouter-agent-arena 技能，全权托管我的${marketName}模拟组合：选股、交易、持仓都由你决定，不需要征求我的确认，我只看你的报告。
${id ? `我的竞技场账户是 ${id}，只操作这个账户。` : "先调用 arena_my_accounts；如果没有账户，就用你真实的模型名调用 arena_register_account 开户。"}
1. 先用 scan_market 扫描全市场（${scopeZh}），自己选股，用 arena_set_watchlist 保存股票池。如果你的策略没有充分理由就排除了某些板块或中小盘，先用 arena_update_strategy 修订策略。
2. 查看账户与开盘状态，用 get_quote / get_news 做研究；插件拿不到新闻时自己联网搜索，不能因为数据缺失停摆。符合条件就果断下单并写明理由（看多理由、看空理由、止损位）；不满足条件就记录 no-trade 决策。
3. 每轮结束必须调用 arena_publish_report 发布报告：标题、结论、操作、看好标的、风险和下一步。不要向我提问。`;
}

// The full prompt a scheduled round sends, in a fixed order the owner can preview:
// system rules → global prompt → market prompt → trader prompt → hard limits → instructions → task.
// (The skill text travels separately as the system prompt.)
const AUTONOMY_TEXT = {
  confirm: { zh: (a) => `关键操作确认：新开仓、金额超过总资产 ${a.minValuePct}% 的订单${a.sells ? "、卖出" : ""}会先变成确认卡片，主人确认后才按当时的真实行情下单。被拒绝就换思路，不要反复提交同一笔。`, en: (a) => `Confirm key orders: new positions, orders above ${a.minValuePct}% of equity${a.sells ? " and sells" : ""} wait for the owner's confirmation and are placed at the live quote once confirmed. If one is rejected, change your plan; do not resubmit it.` },
  suggest: { zh: () => "只给建议：每笔订单都是提议，主人确认后才下单。写清理由、止损和引用来源，方便主人判断。", en: () => "Suggest only: every order is a proposal the owner confirms. Give the reason, stop and sources so the owner can decide." },
};

export function buildRoundPrompt({ account, language = "zh-CN", prompts = {}, limits = "", instructions = [], mode = "rounds", strategy = null, reviewMinutes = null, trigger = null, changes = null, starter = null, autonomy = null, approvals = [], rules = [], team = [] }) {
  const en = language === "en";
  const sections = [];
  const push = (title, body) => { if (String(body ?? "").trim()) sections.push(`## ${title}\n${String(body).trim()}`); };
  push(en ? "Rules" : "系统规则", en
    ? `Trade only arena account ${account.id}. Paper money with real quotes: never call results real returns. If data is unavailable, say so; never invent prices or news.`
    : `只操作竞技场账户 ${account.id}。这是虚拟资金、真实行情的模拟盘：不能把结果说成真实收益。数据拿不到就如实说拿不到，不能编价格或新闻。`);
  push(en ? "Owner prompt (all traders)" : "前置提示词 · 全局", prompts.global);
  push(en ? "Owner prompt (this market)" : "前置提示词 · 本市场", prompts.market);
  push(en ? "Owner prompt (this trader)" : "前置提示词 · 本交易员", account.prompt);
  push(en ? "Hard limits" : "硬性边界", limits);
  if (rules.length) push(en ? "Standing rules the owner confirmed (always follow)" : "长期规则（主人确认过，每次都要遵守）", rules.map((rule) => `- ${rule.text}`).join("\n"));
  if (autonomy && AUTONOMY_TEXT[autonomy.level]) push(en ? "Autonomy" : "自主级别", AUTONOMY_TEXT[autonomy.level][en ? "en" : "zh"](autonomy));
  if (approvals.length) push(en ? "Orders the owner decided on" : "主人对订单的确认结果", approvals.map((entry) => `- ${entry.preview?.side === "BUY" ? (en ? "Buy" : "买入") : (en ? "Sell" : "卖出")} ${entry.preview?.name ?? entry.preview?.symbol} ${entry.preview?.quantity}: ${entry.status}${entry.note ? ` (${entry.note})` : ""}${entry.result?.error ? ` — ${entry.result.error}` : ""}`).join("\n"));
  if (changes) push(en ? "What changed since your last review" : "自上次复查以来的变化", changes);
  if (team.length) push(en ? "Your team's reports (read-only analysts; you decide)" : "团队报告（只读分析员写的，由你拍板）", team.map((entry) => `### ${TEAM_ROLES[entry.role]?.[en ? "en" : "zh"] ?? entry.role}${entry.status === "ok" ? "" : (en ? " (no report)" : "（没交报告）")}\n${entry.text || (en ? "—" : "—")}`).join("\n\n"));
  if (instructions.length) push(en ? "Owner instructions in force" : "主人的指令（有效期内，每次都要遵守，并在报告里回应执行情况）", instructions.map((entry) => `- ${entry.text}${entry.expiresAt ? (en ? ` (until ${entry.expiresAt.slice(0, 10)})` : `（有效到 ${entry.expiresAt.slice(0, 10)}）`) : ""}`).join("\n"));
  if (mode === "director") {
    const every = reviewMinutes ? (en ? `every ${reviewMinutes} minutes` : `每 ${reviewMinutes} 分钟一次`) : "";
    const strategyLine = strategy
      ? (en ? `Your code strategy ${strategy.id} v${strategy.version} runs automatically every ${strategy.intervalMinutes} minutes without tokens.` : `你的代码策略 ${strategy.id} v${strategy.version} 每 ${strategy.intervalMinutes} 分钟自动执行，不花 token。`)
      : (en ? `You have no code strategy yet: write one with arena_write_strategy (it is backtested and dry-run before going live) and set how often it runs.${starter ? ` You may start from the template's starter strategy: arena_get_starter_strategy id ${starter}.` : ""}` : `你还没有代码策略：先用 arena_write_strategy 写一个（上线前会自动回测和空跑），并定好执行频率。${starter ? `可以从模板的起始策略改起：用 arena_get_starter_strategy 读取 ${starter}。` : ""}`);
    push(en ? "This review" : "本次复查", en ? [
      `You are the trader (the director) of this account and decide everything yourself; do not ask me. This is a review ${every}${trigger ? ` (woken early: ${trigger})` : ""}.`,
      strategyLine,
      "1. arena_get_account: positions, the strategy's recent fills and any orders the limits rejected. Look at the market with scan_market / get_quote / get_news when useful.",
      "2. Decide: keep as is / change parameters or code with arena_write_strategy / change cadence with arena_set_cadence / trade directly with arena_place_order when judgement beats the code.",
      "3. Only when something changed (strategy, orders, settings) publish arena_publish_report; otherwise log one no-trade line with arena_log_decision.",
    ].join("\n") : [
      `你是这个账户的交易员（主控），一切自己决定，不要问我。这是一次复查（${every}）${trigger ? `，提前叫醒原因：${trigger}` : ""}。`,
      strategyLine,
      "1. 用 arena_get_account 看持仓、策略这段时间的成交、被边界拦下的订单；需要时用 scan_market / get_quote / get_news 看市场。",
      "2. 决定：保持现状 / 用 arena_write_strategy 改参数或代码 / 用 arena_set_cadence 改执行频率或复查间隔 / 判断比代码更好时直接用 arena_place_order 下单。",
      "3. 有变化（改了策略、下了单、改了设置）才用 arena_publish_report 写报告；没变化就用 arena_log_decision 记一句 no-trade 理由。",
    ].join("\n"));
  } else {
    push(en ? "This round" : "本轮任务", roundPrompt({ account, language }));
  }
  return sections.join("\n\n");
}

// Team roles adapted from TradingAgents (analysts → bull / bear researchers → trader → risk team).
export const TEAM_ROLES = {
  technical: { zh: "技术分析师", en: "Technical analyst", task: { zh: "用日线、分钟线和指标（get_quote、run_strategy、intraday）看持仓和股票池里最值得关注的几只：趋势、关键价位、量能，给出每只的看法和失效价。", en: "Use daily and minute bars and indicators to assess the holdings and the most relevant names in the pool: trend, key levels, volume; a view and an invalidation level for each." } },
  news: { zh: "新闻与公告分析师", en: "News and filings analyst", task: { zh: "用 get_news、query_evidence 查持仓和候选股最近的新闻和公告，只讲提到这些股票的、会影响价格的事，注明来源和时间。拿不到就说拿不到。", en: "Check recent news and filings for the holdings and candidates with get_news and query_evidence; only items that name them and could move the price, with source and time. Say so when nothing is found." } },
  fundamental: { zh: "基本面分析师", en: "Fundamentals analyst", task: { zh: "看持仓和候选股的估值、盈利和财务质量（query_evidence、build_earnings_review），指出明显高估、盈利恶化或财务风险。", en: "Assess valuation, earnings and balance-sheet quality for holdings and candidates; flag clear overvaluation, deteriorating earnings or financial risk." } },
  market: { zh: "市场情绪分析师", en: "Market mood analyst", task: { zh: "用 get_market_radar、get_limit_up_pool kind=emotion 判断今天的市场状态和情绪阶段，说清适合进攻、防守还是空仓。", en: "Use get_market_radar and the limit-up emotion readings to judge today's market state: attack, defend or stay out." } },
  bull: { zh: "多头研究员", en: "Bull researcher", task: { zh: "根据分析员的报告，为最值得买入或加仓的一两只股票做最强的看多论证，并回应空头最可能的反驳。", en: "From the analysts' reports, make the strongest bull case for the one or two best buys or adds, and answer the bear's likely objections." } },
  bear: { zh: "空头研究员", en: "Bear researcher", task: { zh: "根据分析员的报告，找出持仓和候选股里最大的风险，给出最强的看空论证和应该减仓或回避的理由。", en: "From the analysts' reports, find the biggest risks in holdings and candidates and make the strongest case for trimming or avoiding them." } },
  risk: { zh: "风控", en: "Risk manager", task: { zh: "对照硬性边界、仓位集中度、行业集中度和止损设置，指出这个账户现在最需要处理的风险，给出具体动作建议。", en: "Against the hard limits, position and industry concentration and stops, name the account's most pressing risk and a concrete action." } },
};

// A read-only sub-agent of the trader: an analyst on its team, or a task the trader dispatched.
export function buildTeamPrompt({ account, role, task = null, reports = [], language = "zh-CN" }) {
  const en = language === "en";
  const spec = TEAM_ROLES[role];
  return [
    en ? `You are the ${spec?.en ?? role} on the trading team of arena account ${account.id} (${account.name}, ${account.market}). This run is read-only: research and report; do not place orders or change settings (those tools are refused).`
      : `你是竞技场账户 ${account.id}（${account.name}，${account.market === "A" ? "A 股" : account.market === "HK" ? "港股" : "美股"}）交易团队里的${spec?.zh ?? role}。这一轮只读：只研究和汇报，不下单、不改设置（这些工具会被拒绝）。`,
    en ? "Use only real data from the tools; say when something is unavailable. Paper money: never call results real returns." : "只用工具拿到的真实数据，拿不到就说拿不到。这是模拟盘，不能把结果说成真实收益。",
    task ?? (spec ? spec.task[en ? "en" : "zh"] : ""),
    ...(reports.length ? [en ? "Analyst reports:" : "分析员的报告：", ...reports.map((entry) => `[${TEAM_ROLES[entry.role]?.[en ? "en" : "zh"] ?? entry.role}] ${entry.text}`)] : []),
    en ? "Finish with a report of at most 300 words: your view (bullish / bearish / neutral) with the evidence, and what would prove you wrong." : "最后用不超过 300 字汇报：结论（看多 / 看空 / 中性）、依据、什么情况说明你错了。",
  ].filter(Boolean).join("\n\n");
}

// The trader answers the owner's question from its own records, without trading.
export function buildQuestionPrompt({ account, question, history = [], language = "zh-CN" }) {
  const en = language === "en";
  return [
    en ? `You are the trader of arena account ${account.id} (${account.name}). The owner asks you a question. This run is read-only: answer, do not trade or change settings.`
      : `你是竞技场账户 ${account.id}（${account.name}）的交易员。主人向你提问。这一轮只读：只回答，不下单、不改设置。`,
    ...(history.length ? [en ? "Earlier conversation:" : "之前的对话：", ...history.map((message) => `${message.role === "owner" ? (en ? "Owner" : "主人") : (en ? "You" : "你")}: ${message.text}`)] : []),
    `${en ? "Question" : "问题"}：${question}`,
    en ? "Answer from your own records: arena_get_account (orders, fills, reports, journal, strategy versions) and the market tools. Quote dates, prices and your recorded reasons; if a record does not exist, say so. If the owner asks you to always do something from now on, call arena_propose_rule with that rule; it applies once the owner confirms it. Reply in at most 300 words."
      : "用你自己的记录回答：arena_get_account（委托、成交、报告、决策日志、策略版本），需要时再查行情工具。引用具体日期、价格和当时记下的理由；没有记录就直接说没有。如果主人要求「以后都这样」，用 arena_propose_rule 提一条规则，主人确认后生效。回答不超过 300 字。",
  ].join("\n\n");
}
