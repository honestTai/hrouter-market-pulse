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

export function buildRoundPrompt({ account, language = "zh-CN", prompts = {}, limits = "", instructions = [], mode = "rounds", strategy = null, reviewMinutes = null, trigger = null, changes = null, starter = null, autonomy = null, approvals = [] }) {
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
  if (autonomy && AUTONOMY_TEXT[autonomy.level]) push(en ? "Autonomy" : "自主级别", AUTONOMY_TEXT[autonomy.level][en ? "en" : "zh"](autonomy));
  if (approvals.length) push(en ? "Orders the owner decided on" : "主人对订单的确认结果", approvals.map((entry) => `- ${entry.preview?.side === "BUY" ? (en ? "Buy" : "买入") : (en ? "Sell" : "卖出")} ${entry.preview?.name ?? entry.preview?.symbol} ${entry.preview?.quantity}: ${entry.status}${entry.note ? ` (${entry.note})` : ""}${entry.result?.error ? ` — ${entry.result.error}` : ""}`).join("\n"));
  if (changes) push(en ? "What changed since your last review" : "自上次复查以来的变化", changes);
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
