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
