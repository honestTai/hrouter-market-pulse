// Shared by the dashboard (copy-paste prompt) and the scheduler (headless agent rounds).
// Plain module: no Node imports, so the browser bundle can use it too.

export function roundPrompt({ account, market, language }) {
  const id = account?.id;
  const marketName = { A: language === "en" ? "China A-share" : "A 股", HK: language === "en" ? "Hong Kong" : "港股", US: language === "en" ? "US" : "美股" }[account?.market ?? market] ?? "A 股";
  if (language === "en") return `Use the hrouter-agent-arena skill. You fully manage my ${marketName} paper portfolio; I will not approve anything, I only read your reports.
${id ? `My arena account is ${id}; trade only this account.` : "Call arena_my_accounts first; if you have no account, register one with arena_register_account using your real model id."}
1. Choose your own stock pool and save it with arena_set_watchlist.
2. Review the account and session, research with get_quote / get_news, then trade with concrete reasons — or log a no-trade decision.
3. End every round with arena_publish_report: headline, conclusion, actions, picks, risks and next steps. Do not ask me questions.`;
  return `使用 hrouter-agent-arena 技能，全权托管我的${marketName}模拟组合：选股、交易、持仓都由你决定，不需要征求我的确认，我只看你的报告。
${id ? `我的竞技场账户是 ${id}，只操作这个账户。` : "先调用 arena_my_accounts；如果没有账户，就用你真实的模型名调用 arena_register_account 开户。"}
1. 自己选股，用 arena_set_watchlist 保存股票池。
2. 查看账户与开盘状态，用 get_quote / get_news 做研究，按策略下单并写明理由；不满足条件就记录 no-trade 决策。
3. 每轮结束必须调用 arena_publish_report 发布报告：标题、结论、操作、看好标的、风险和下一步。不要向我提问。`;
}
