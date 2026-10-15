import React, { useState } from "react";
import { Badge, Button, Select, Table } from "@radix-ui/themes";
import { ArrowUpRight, Bot, FileText, ListChecks, Plug, Radar, Sparkles, Wallet } from "lucide-react";
import { useWorkspace } from "../context.jsx";
import { isNumber } from "../data.mjs";
import { Empty, SectionHeading } from "./Primitives.jsx";
import { AgentMark, ConnectDialog, EquityChart, ReportCard, Signed, agentKind, relativeTime } from "./Arena.jsx";
import { PortfolioPage as ManualHoldings } from "./MarketBoard.jsx";

// The owner's portfolio as run by an agent: the owner reads conclusions, the agent does everything else.
export function ManagedPortfolioPage() {
  const { t, number, date, managed, setView, preferences } = useWorkspace();
  const [connect, setConnect] = useState(false);
  const { accounts, account, loading, choose } = managed;
  const manual = preferences?.positions?.filter((position) => position.quantity > 0) ?? [];
  const openInArena = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("account", account.id);
    url.searchParams.set("market", account.market);
    window.history.replaceState(null, "", url);
    setView("arena");
  };

  if (!account) return <div className="page-stack">
    <section className="surface arena-onboarding">
      <div className="arena-onboarding-head"><span className="intro-symbol"><Bot size={24} /></span><div>
        <h2>{loading ? t("正在载入 Agent 组合…", "Loading the agent portfolio…") : t("把组合交给 Agent", "Hand your portfolio to an agent")}</h2>
        <p className="muted">{t("选股、下单、调仓都由 Agent 完成。你只需要在这里看它的结论、持仓和收益报表。", "The agent picks stocks, trades and rebalances. You only read its conclusions, holdings and performance here.")}</p>
      </div></div>
      {!loading && <>
        <ol className="arena-steps">
          <li><span className="step-number">1</span><Plug size={20} /><strong>{t("安装插件", "Install the plugin")}</strong><p className="muted">{t("在 Claude Code、Codex 或 WorkBuddy 里安装 Hrouter Market Pulse。", "Install Hrouter Market Pulse in Claude Code, Codex or WorkBuddy.")}</p></li>
          <li><span className="step-number">2</span><Sparkles size={20} /><strong>{t("发送全托管提示词", "Send the autopilot prompt")}</strong><p className="muted">{t("Agent 会自己开户、选股、交易并发布报告。", "The agent opens an account, picks stocks, trades and publishes a report.")}</p></li>
          <li><span className="step-number">3</span><Radar size={20} /><strong>{t("设为定时任务", "Schedule it")}</strong><p className="muted">{t("在 Agent 里把同一提示词设为每个交易日定时运行，之后无需任何操作。", "Schedule the same prompt every trading day in the agent app; nothing else to do.")}</p></li>
        </ol>
        <div className="arena-onboarding-actions"><Button size="3" onClick={() => setConnect(true)}><Plug size={16} />{t("获取全托管提示词", "Get the autopilot prompt")}</Button></div>
      </>}
    </section>
    {manual.length > 0 && <details className="manual-holdings"><summary>{t(`手动登记的持仓（${manual.length}，不参与 Agent 交易）`, `Manually recorded holdings (${manual.length}, not traded by agents)`)}</summary><ManualHoldings /></details>}
    {connect && <ConnectDialog market="A" onClose={() => setConnect(false)} />}
  </div>;

  const m = account.metrics;
  const reports = account.reports ?? [];
  const [latest, ...older] = reports;
  const pool = account.watchlist?.symbols ?? [];
  return <div className="page-stack">
    <section className="surface managed-hero">
      <div className="managed-identity">
        <AgentMark account={account} size="lg" />
        <div>
          <div className="managed-kicker"><Badge color="jade" variant="soft"><Bot size={12} />{t("由 Agent 全权托管", "Fully managed by agent")}</Badge>{account.demo && <Badge color="amber" variant="soft">{t("演示数据", "Demo")}</Badge>}</div>
          <h2>{account.name}</h2>
          <p className="muted small">{agentKind(account).label} · <code className="model-chip">{account.model}</code> · {account.market} · {account.currency} · {t("最近动作", "Last action")} {relativeTime(account.lastActivityAt, t)}</p>
        </div>
      </div>
      <div className="managed-numbers">
        <div><span className="muted small">{t("组合净值", "Equity")}</span><strong className="tabular">{number(m.equity)}</strong></div>
        <div><span className="muted small">{t("累计收益", "Total return")}</span><strong><Signed value={m.totalReturnPct} /></strong></div>
        <div><span className="muted small">{t("今日", "Today")}</span><strong><Signed value={m.todayReturnPct} /></strong></div>
        <div><span className="muted small">{t("跑赢基准", "vs benchmark")}</span><strong><Signed value={m.excessReturnPct} /></strong></div>
      </div>
      <div className="managed-actions">
        {accounts.length > 1 && <Select.Root value={account.id} onValueChange={choose}>
          <Select.Trigger variant="surface" aria-label={t("切换托管账户", "Switch managed account")} />
          <Select.Content>{accounts.map((entry) => <Select.Item key={entry.id} value={entry.id}>{entry.name} · {entry.model}</Select.Item>)}</Select.Content>
        </Select.Root>}
        <Button variant="soft" onClick={openInArena}><ArrowUpRight size={15} />{t("完整账户", "Full account")}</Button>
        <Button variant="soft" color="gray" onClick={() => setConnect(true)}><Plug size={15} />{t("提示词", "Prompt")}</Button>
      </div>
    </section>

    <div className="managed-grid">
      <section className="surface">
        <SectionHeading icon={FileText} title={t("最新结论", "Latest conclusion")} caption={latest ? relativeTime(latest.at, t) : null} />
        {latest ? <div className="managed-report"><ReportCard report={latest} featured /></div> : <Empty compact icon={FileText} title={t("Agent 还没有发布报告", "No report from the agent yet")} description={t("全托管提示词会要求 Agent 每轮结束时发布结论。", "The autopilot prompt asks the agent to publish a conclusion after every round.")} />}
      </section>
      <section className="surface">
        <SectionHeading icon={Wallet} title={t("净值走势", "Equity")} caption={t("虚线为初始资金", "Dashed: starting cash")} />
        <div className="arena-chart"><EquityChart account={account} /></div>
        <dl className="managed-stats">
          <div><dt>{t("现金", "Cash")}</dt><dd className="tabular">{number(m.cash)}</dd></div>
          <div><dt>{t("仓位", "Exposure")}</dt><dd className="tabular">{number(m.exposurePct, 1)}%</dd></div>
          <div><dt>{t("最大回撤", "Max DD")}</dt><dd><Signed value={m.maxDrawdownPct} /></dd></div>
          <div><dt>{t("胜率", "Win rate")}</dt><dd className="tabular">{isNumber(m.winRatePct) ? `${number(m.winRatePct, 0)}%` : "—"}</dd></div>
          <div><dt>{t("成交", "Fills")}</dt><dd className="tabular">{m.trades}</dd></div>
          <div><dt>{t("手续费", "Fees")}</dt><dd className="tabular">{number(m.feesPaid)}</dd></div>
        </dl>
      </section>
    </div>

    <section className="surface">
      <SectionHeading icon={Wallet} title={t("Agent 持仓", "Agent holdings")} caption={`${account.positions.length}`} />
      {account.positions.length ? <div className="table-scroll"><Table.Root size="2">
        <Table.Header><Table.Row>
          <Table.ColumnHeaderCell>{t("标的", "Security")}</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell align="right">{t("数量", "Qty")}</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell align="right">{t("成本 / 现价", "Cost / last")}</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell align="right">{t("市值 / 权重", "Value / weight")}</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell align="right">{t("浮动盈亏", "Unrealized")}</Table.ColumnHeaderCell>
          <Table.ColumnHeaderCell>{t("买入理由", "Why the agent holds it")}</Table.ColumnHeaderCell>
        </Table.Row></Table.Header>
        <Table.Body>{account.positions.map((position) => {
          const why = account.trades.find((trade) => trade.symbol === position.symbol && trade.side === "BUY");
          return <Table.Row key={position.symbol}>
            <Table.RowHeaderCell><strong>{position.name}</strong><small className="cell-subtitle">{position.symbol}</small></Table.RowHeaderCell>
            <Table.Cell align="right" className="tabular">{number(position.quantity, 0)}</Table.Cell>
            <Table.Cell align="right" className="tabular">{number(position.averageCost, 3)}<small className="cell-subtitle">{number(position.lastPrice, 3)}</small></Table.Cell>
            <Table.Cell align="right" className="tabular">{number(position.marketValue)}<small className="cell-subtitle">{number(position.weightPct, 1)}%</small></Table.Cell>
            <Table.Cell align="right"><Signed value={position.unrealizedPnl} suffix="" /><small className="cell-subtitle"><Signed value={position.unrealizedPnlPct} /></small></Table.Cell>
            <Table.Cell className="reason-cell">{why?.reason ?? "—"}</Table.Cell>
          </Table.Row>;
        })}</Table.Body>
      </Table.Root></div> : <Empty compact icon={Wallet} title={t("当前空仓", "No positions")} description={t("Agent 目前全部持有现金。", "The agent is entirely in cash.")} />}
    </section>

    <div className="managed-grid">
      <section className="surface">
        <SectionHeading icon={ListChecks} title={t("最近操作", "Recent trades")} />
        {account.trades.length ? <ul className="trade-feed">{account.trades.slice(0, 8).map((trade) => <li key={trade.id}>
          <span className={trade.side === "BUY" ? "side buy" : "side sell"}>{trade.side === "BUY" ? t("买入", "Buy") : t("卖出", "Sell")}</span>
          <div><strong>{trade.name}</strong> <span className="muted small">{trade.symbol} · {number(trade.quantity, 0)} × {number(trade.price, 3)}</span><p className="muted small">{trade.reason}</p></div>
          <span className="trade-feed-side">{isNumber(trade.realizedPnl) ? <Signed value={trade.realizedPnl} suffix="" /> : null}<small className="muted">{date(trade.at)}</small></span>
        </li>)}</ul> : <Empty compact icon={ListChecks} title={t("还没有成交", "No trades yet")} />}
      </section>
      <section className="surface">
        <SectionHeading icon={Radar} title={t("Agent 股票池", "Agent stock pool")} caption={account.watchlist?.updatedAt ? relativeTime(account.watchlist.updatedAt, t) : null} />
        {pool.length ? <div className="pool"><div className="pool-chips">{pool.map((symbol) => <span key={symbol} className={`pool-chip ${account.positions.some((p) => p.symbol === symbol) ? "held" : ""}`}>{symbol}</span>)}</div>{account.watchlist.reason && <p className="muted small">{account.watchlist.reason}</p>}</div> : <Empty compact icon={Radar} title={t("Agent 尚未设置股票池", "No stock pool yet")} description={t("Agent 用 arena_set_watchlist 维护自己的候选股，市场页的自选会跟随它。", "The agent maintains its candidates with arena_set_watchlist; the market watchlist follows it.")} />}
        {older.length > 0 && <>
          <SectionHeading icon={FileText} title={t("历史报告", "Earlier reports")} caption={`${older.length}`} />
          <ul className="report-history">{older.slice(0, 6).map((report) => <li key={report.id}><strong>{report.title}</strong><span className="muted small">{date(report.at)}</span><p className="muted small">{report.summary}</p></li>)}</ul>
        </>}
      </section>
    </div>

    {manual.length > 0 && <details className="manual-holdings"><summary>{t(`手动登记的持仓（${manual.length}，不参与 Agent 交易）`, `Manually recorded holdings (${manual.length}, not traded by agents)`)}</summary><ManualHoldings /></details>}
    {connect && <ConnectDialog account={account} market={account.market} onClose={() => setConnect(false)} />}
  </div>;
}
