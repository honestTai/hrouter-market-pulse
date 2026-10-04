import React, { useEffect, useRef, useState } from "react";
import { Badge, Button, Callout, Checkbox, Dialog, IconButton, Table, Tabs, TextArea, TextField } from "@radix-ui/themes";
import { Bot, Cable, CircleDollarSign, ClipboardList, FlaskConical, LockKeyhole, Pause, RefreshCw, Settings2, ShieldCheck, TrendingUp, X } from "lucide-react";
import { useWorkspace } from "../context.jsx";
import { api, isNumber } from "../data.mjs";
import { Empty, ErrorNotice, SectionHeading } from "./Primitives.jsx";

// Illustrative rules only. Nothing is enabled or funded by these examples.
const example = (side) => ({ name: side === "BUY" ? "paper-entry-example" : "paper-exit-example", version: "1", baseScore: 0, minimumScore: 1,
  rules: [{ feature: "priceToSma20Pct", operator: side === "BUY" ? "gt" : "lt", value: 0, points: 1, label: side === "BUY" ? "Price above MA20 — example, not advice" : "Price below MA20 — example, not advice" }] });
const accountLabel = (id) => id ? `••••${id.slice(-4)}` : "—";
const states = {
  blocked: ["门槛拦截", "Blocked"], dispatching: ["发送中 / 待核对", "Dispatching / reconcile"],
  unknown: ["结果未知 · 禁止重试", "Unknown · do not retry"], acknowledged: ["券商已响应", "Broker acknowledged"],
};
function Field({ title, children, wide }) {
  const id = React.useId();
  return <label className={`paper-field ${wide ? "wide" : ""}`} htmlFor={id}><span>{title}</span>{React.cloneElement(children, { id })}</label>;
}
function PolicyEditor({ policy, market, accountId, onSave, onClose }) {
  const { t } = useWorkspace(); const [error, setError] = useState(""); const [saving, setSaving] = useState(false);
  const [approved, setApproved] = useState(false);
  const current = policy?.market === market && policy?.accountId === accountId ? policy : {};
  const submit = async (event) => {
    event.preventDefault(); if (saving) return;
    try {
      const form = Object.fromEntries(new FormData(event.currentTarget));
      const input = { enabled: true, environment: "SIMULATE", market, accountId,
        allowedSymbols: form.allowedSymbols.split(/[\s,，]+/).filter(Boolean), lotSizes: JSON.parse(form.lotSizes || "{}"),
        entryStrategy: JSON.parse(form.entryStrategy), exitStrategy: JSON.parse(form.exitStrategy) };
      for (const name of ["maxOrderValue", "maxDailyOrderValue", "maxPositionValue", "maxOrdersPerDay", "maxQuoteAgeSeconds", "maxLimitDeviationPct"]) input[name] = Number(form[name]);
      if (!approved) throw new Error(t("请确认授权范围。", "Confirm the authorization scope."));
      setSaving(true); setError(""); await onSave(input); onClose();
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}><Dialog.Content maxWidth="760px" onInteractOutside={(e) => e.preventDefault()}><Dialog.Title>{t("授权 Agent 模拟执行", "Authorize agent paper execution")}</Dialog.Title><Dialog.Description size="2">{market} · {accountLabel(accountId)} · SIMULATE ONLY</Dialog.Description><IconButton className="dialog-close" variant="ghost" color="gray" aria-label={t("关闭授权", "Close authorization")} onClick={onClose} disabled={saving}><X size={18} /></IconButton><form onSubmit={submit}><fieldset disabled={saving} className="editor-fieldset"><div className="paper-form-grid">
    <Field wide title={t("允许的证券代码（逗号分隔）", "Allowed symbols (comma separated)")}><TextField.Root name="allowedSymbols" required defaultValue={current.allowedSymbols?.join(", ") || ""} placeholder={market === "HK" ? "0700.HK" : "AAPL, MSFT"} /></Field>
    {[["maxOrderValue", t("单笔名义金额上限", "Per-order notional cap"), "0.01"], ["maxDailyOrderValue", t("单日委托金额上限", "Daily submitted notional cap"), "0.01"], ["maxPositionValue", t("单标的持仓上限（含待成交）", "Per-symbol exposure cap (incl. pending)"), "0.01"], ["maxOrdersPerDay", t("单日最多委托数", "Daily order count cap"), "1"], ["maxQuoteAgeSeconds", t("行情最大年龄（秒，≤300）", "Max quote age (seconds, ≤300)"), "1"], ["maxLimitDeviationPct", t("限价偏离现价上限（%，≤5）", "Max limit deviation (%, ≤5)"), "0.01"]].map(([name, title, step]) => <Field key={name} title={title}><TextField.Root name={name} type="number" required min={step} step={step} defaultValue={current[name] ?? ""} /></Field>)}
    <Field wide title={t("每手股数 JSON（港股须核实；美股固定 1）", "Verified board lots JSON (US is fixed at 1)")}><TextArea name="lotSizes" rows={2} defaultValue={JSON.stringify(current.lotSizes || {}, null, 2)} placeholder={'{"0700.HK": 100}'} /></Field>
    <Field wide title={t("买入规则 JSON（示例须自行评估修改）", "Entry rules JSON (review and edit example)")}><TextArea className="paper-code" name="entryStrategy" required rows={7} defaultValue={JSON.stringify(current.entryStrategy || example("BUY"), null, 2)} /></Field>
    <Field wide title={t("卖出规则 JSON（仅卖出已有可卖持仓）", "Exit rules JSON (sellable long positions only)")}><TextArea className="paper-code" name="exitStrategy" required rows={7} defaultValue={JSON.stringify(current.exitStrategy || example("SELL"), null, 2)} /></Field>
  </div><p className="small muted">{t(`金额单位：${market === "HK" ? "HKD" : "USD"}。撤单不返还当日委托预算；没有自动换汇或融资。策略表现不构成实盘准入。`, `Amounts in ${market === "HK" ? "HKD" : "USD"}. Cancels do not restore daily budgets. No FX conversion or margin. Paper performance does not authorize real trading.`)}</p><label className="paper-consent"><Checkbox checked={approved} onCheckedChange={(v) => setApproved(v === true)} /><span>{t("我授权 Agent 按以上规则和限额自主提交模拟委托，无需逐笔确认；不授权实盘。", "I authorize autonomous SIMULATE orders within these rules and limits, without per-order confirmation. No real-money authorization.")}</span></label><ErrorNotice message={error} /><div className="dialog-actions"><Button type="button" variant="soft" color="gray" onClick={onClose}>{t("取消", "Cancel")}</Button><Button type="submit" disabled={!approved || saving} loading={saving}><Bot size={16} />{t("保存并启用模拟执行", "Enable bounded paper execution")}</Button></div></fieldset></form></Dialog.Content></Dialog.Root>;
}
function Equity({ samples }) {
  const { t, number, date } = useWorkspace();
  const valid = samples.filter((s) => isNumber(s.totalAssets) && Number.isFinite(Date.parse(s.observedAt))).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (valid.length < 2) return <Empty compact icon={TrendingUp} title={t("等待真实账户净值采样", "Awaiting actual account observations")} description={t("每次核对账户记录一份富途返回的净值，不生成虚构收益曲线。", "Each reconciliation records broker-reported equity. No fabricated return curve.")} />;
  const values = valid.map((s) => s.totalAssets), low = Math.min(...values), high = Math.max(...values), spread = high - low || 1;
  const firstTime = Date.parse(valid[0].observedAt), duration = Date.parse(valid.at(-1).observedAt) - firstTime || 1;
  const points = values.map((v, i) => `${(Date.parse(valid[i].observedAt) - firstTime) / duration * 800},${145 - (v - low) / spread * 125}`).join(" ");
  return <div className="paper-equity"><div><strong>{number(values.at(-1))} <small>{valid.at(-1).currency}</small></strong><span className="muted small">{valid.length} {t("次真实采样", "actual observations")}</span></div><svg viewBox="0 0 800 170" role="img" aria-label={t("券商模拟账户净值采样，不是策略收益率", "Broker paper equity observations, not strategy return")}><path d="M0 145H800 M0 20H800" stroke="var(--border)" fill="none" /><polyline points={points} fill="none" stroke="var(--jade-9)" strokeWidth="3" vectorEffect="non-scaling-stroke" /></svg><div className="small muted"><span>{date(valid[0].observedAt)}</span><span>{date(valid.at(-1).observedAt)}</span></div><p className="small muted">{t("未剔除充值、重置、其他操作及策略切换影响；不可直接当作策略收益或年化收益。", "Unadjusted for deposits, resets, outside activity or strategy changes. Not a strategy or annualized return.")}</p></div>;
}
export function PaperTradingPage() {
  const { t, number, date } = useWorkspace();
  const [status, setStatus] = useState(null), [market, setMarket] = useState("HK"), [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState([]), [snapshot, setSnapshot] = useState(null), [observations, setObservations] = useState([]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(""); const lock = useRef(false);
  const [editing, setEditing] = useState(false); const [tab, setTab] = useState("orders");
  const load = async (signal) => {
    const result = await api("/api/paper/status", undefined, signal); if (!signal?.aborted) setStatus(result);
    return result;
  };
  useEffect(() => {
    const abort = new AbortController();
    load(abort.signal).then((result) => { if (abort.signal.aborted) return; if (result.policy?.market) setMarket(result.policy.market); if (result.policy?.accountId) setAccountId(result.policy.accountId); }).catch((e) => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const timer = window.setInterval(async () => {
      if (document.hidden || lock.current) return;
      try {
        // Local journal read only: this never polls OpenD or submits orders.
        const result = await load(abort.signal);
        if (abort.signal.aborted || !accountId) return;
        const latest = result.snapshots?.find((s) => s.accountId === accountId && s.market === market);
        if (latest) setSnapshot(latest);
        setObservations((result.samples || []).filter((s) => s.accountId === accountId && s.market === market));
      } catch (e) { if (!abort.signal.aborted) setError(e.message); }
    }, 15000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [accountId, market]);
  const act = async (name, fn) => {
    if (lock.current) return; lock.current = true; setBusy(name); setError("");
    try { await fn(); } catch (e) { setError(e.message); } finally { lock.current = false; setBusy(""); }
  };
  const connect = () => act("connect", async () => {
    setAccounts([]); setSnapshot(null); setObservations([]);
    const result = await api("/api/paper/connect", { market }); setAccounts(result.accounts);
    setAccountId((old) => result.accounts.some((a) => a.accountId === old) ? old : result.accounts[0]?.accountId || "");
    if (!result.accounts.length) throw new Error(t("该市场没有可用的股票模拟账户；请在富途检查账户和权限。", "No supported equity simulation account for this market. Check Futu account access."));
  });
  const reconcile = () => act("refresh", async () => {
    const result = await api("/api/paper/refresh", { market, accountId });
    setSnapshot(result.snapshot); setObservations(result.samples); await load();
  });
  const policy = status?.policy || {}; const intents = (status?.intents || []).filter((r) => !accountId || (r.accountId === accountId && r.market === market));
  const selectedVerified = accounts.some((a) => a.accountId === accountId && a.market === market && a.environment === "SIMULATE");
  const paused = !policy.enabled;
  const setup = !status?.bridgeEnabled || status?.demoDisabled;
  return <div className="paper-page"><section className="paper-hero surface"><div className="paper-hero-icon"><Bot size={31} strokeWidth={1.5} /></div><div><div className="paper-kicker">FUTU OPEND · SIMULATE ONLY</div><h2>{t("让策略在真实市场中接受检验", "Put your strategy to a real-market test")}</h2><p>{t("真实行情 → Agent 判断 → 富途模拟委托 → 账户核对。没有假成交，没有自动实盘切换。", "Real quotes → agent decisions → actual Futu paper orders → reconciliation. No invented fills. No real-money switch.")}</p><div className="paper-badges"><Badge color="jade"><ShieldCheck size={12} />{(snapshot ? t("已读取富途模拟账户", "Actual paper account loaded") : t("真实接口 · 待读取", "Actual API · awaiting data"))}</Badge><Badge color={paused ? "amber" : "jade"}><Bot size={12} />{paused ? t("Agent 执行已暂停", "Agent execution paused") : t("已授权 · 等待 Agent 调用", "Authorized · agent may execute")}</Badge><Badge color="gray"><LockKeyhole size={12} />{t("实盘永久禁用", "REAL permanently disabled")}</Badge></div></div></section>
    <ErrorNotice message={error} />
    {setup && <section className="surface paper-setup"><SectionHeading icon={Cable} title={t("先连接本机 OpenD", "Connect local OpenD first")} caption={t("真实接入 · 不用合成数据兜底", "Actual connection · no synthetic fallback")} /><div className="paper-steps">{[["01", t("登录富途 OpenD", "Sign in to Futu OpenD"), t("在本机启动官方网关；仅接受 127.0.0.1，不读取你的登录密码。", "Start the official gateway locally. Loopback only; we do not collect your login password.")], ["02", t("安装可选 Python 桥接", "Install optional Python bridge"), t("在独立 venv 安装 bridges/futu/requirements.txt，不影响插件其他功能。", "Install bridges/futu/requirements.txt in an isolated venv; other plugin features remain independent.")], ["03", t("配置并启用实验", "Authorize your experiment"), t("设置连接环境变量并重启插件，在此选择账户、策略、代码白名单与限额。", "Set connection variables, restart, then choose account, rules, allowlist and limits here.")]].map(([n, title, text]) => <div key={n}><span>{n}</span><h3>{title}</h3><p>{text}</p></div>)}</div><div className="paper-env"><code>HROUTER_FUTU_ENABLED=1</code><code>HROUTER_FUTU_PYTHON=/absolute/path/to/venv/bin/python</code><code>HROUTER_FUTU_PORT=11111</code></div>{status?.demoDisabled && <Callout.Root color="amber" size="1"><Callout.Text>{t("当前是合成行情演示服务，模拟交易明确关闭。用 npm start 启动真实数据面板后连接；不会伪造模拟资金或收益。", "This server is a synthetic demo. Paper trading is disabled. Start the real-data dashboard with npm start; no simulated funds or profits are fabricated here.")}</Callout.Text></Callout.Root>}</section>}
    <section className="surface paper-connection"><div className="paper-connection-fields"><Field title={t("交易市场", "Market")}><select className="native-select" value={market} disabled={!!busy} onChange={(e) => { setMarket(e.target.value); setAccountId(""); setAccounts([]); setSnapshot(null); setObservations([]); }}><option value="HK">{t("港股 · HKD", "Hong Kong · HKD")}</option><option value="US">{t("美股 · USD", "US · USD")}</option></select></Field><Field title={t("富途模拟账户", "Futu simulation account")}><select className="native-select" disabled={!!busy || !accounts.length} value={accountId} onChange={(e) => { setAccountId(e.target.value); setSnapshot(null); setObservations([]); }}><option value="">{t("连接后选择账户", "Connect to select account")}</option>{accounts.map((a) => <option key={a.accountId} value={a.accountId}>{accountLabel(a.accountId)} · SIMULATE</option>)}</select></Field></div><div className="paper-controls"><Button variant="soft" onClick={connect} disabled={setup || !!busy} loading={busy === "connect"}><Cable size={15} />{t("连接 OpenD", "Connect OpenD")}</Button><Button variant="soft" onClick={reconcile} disabled={!selectedVerified || !!busy} loading={busy === "refresh"}><RefreshCw size={15} />{t("核对账户", "Reconcile")}</Button><Button onClick={() => setEditing(true)} disabled={!selectedVerified || !!busy}><Settings2 size={15} />{t("策略与授权", "Rules & authorization")}</Button>{policy.enabled && <Button color="red" variant="soft" disabled={!!busy} onClick={() => act("pause", async () => { await api("/api/paper/policy", { environment: "SIMULATE", enabled: false }); await load(); })}><Pause size={15} />{t("暂停新委托", "Pause new orders")}</Button>}</div></section>
    <div className="paper-metrics">{[[t("账户总资产", "Account equity"), snapshot?.funds?.totalAssets, snapshot?.currency || "—"], [t("现金余额（非可用保证金）", "Cash balance (not margin power)"), snapshot?.funds?.cash, snapshot?.currency || "—"], [t("持仓市值", "Position market value"), snapshot?.funds?.marketValue, snapshot?.currency || "—"], [t("Agent 当日委托上限", "Agent daily notional cap"), policy.maxDailyOrderValue, policy.currency || "—"]].map(([title, value, unit]) => <section className="surface paper-metric" key={title}><span>{title}</span><strong className="tabular">{number(value)} <small>{unit}</small></strong><p>{snapshot ? t(`账户采样 ${date(snapshot.observedAt)}`, `Account observed ${date(snapshot.observedAt)}`) : t("尚未读取账户，不展示虚拟数字", "Not fetched; no invented figures")}</p></section>)}</div>
    <div className="paper-detail-grid"><section className="surface"><SectionHeading icon={TrendingUp} title={t("模拟账户净值观察", "Paper account equity observations")} /><Equity samples={observations} /></section><section className="surface paper-policy-summary"><SectionHeading icon={ShieldCheck} title={t("Agent 执行边界", "Agent execution boundaries")} /><dl><div><dt>{t("授权账户", "Authorized account")}</dt><dd>{policy.market || "—"} · {accountLabel(policy.accountId)}</dd></div><div><dt>{t("状态", "State")}</dt><dd>{paused ? t("暂停", "Paused") : t("已授权，逐单复核", "Authorized; rechecked per order")}</dd></div><div><dt>{t("买入策略", "Entry strategy")}</dt><dd>{policy.entryStrategy ? `${policy.entryStrategy.name} · v${policy.entryStrategy.version}` : "—"}</dd></div><div><dt>{t("卖出策略", "Exit strategy")}</dt><dd>{policy.exitStrategy ? `${policy.exitStrategy.name} · v${policy.exitStrategy.version}` : "—"}</dd></div><div><dt>{t("代码白名单", "Allowlist")}</dt><dd>{policy.allowedSymbols?.join(", ") || "—"}</dd></div><div><dt>{t("单笔 / 单标的上限", "Order / position caps")}</dt><dd>{number(policy.maxOrderValue)} / {number(policy.maxPositionValue)} {policy.currency}</dd></div><div><dt>{t("每日委托数 / 行情年龄", "Daily orders / quote age")}</dt><dd>{policy.maxOrdersPerDay ?? "—"} / {policy.maxQuoteAgeSeconds ?? "—"}s</dd></div></dl><p className="small muted">{t("无需逐笔确认；Agent 通过 MCP 自主执行。不会自动创建定时任务。暂停不撤销已提交委托，仍可核对及撤单。", "No per-order approval; agent executes through MCP. No scheduler is created automatically. Pausing does not cancel existing orders; reconciliation and cancellations remain available.")}</p></section></div>
    <section className="surface paper-records"><Tabs.Root value={tab} onValueChange={setTab}><Tabs.List><Tabs.Trigger value="orders">{t("券商委托", "Broker orders")}</Tabs.Trigger><Tabs.Trigger value="positions">{t("真实模拟持仓", "Actual paper positions")}</Tabs.Trigger><Tabs.Trigger value="journal">{t("Agent 执行记录", "Agent execution journal")}</Tabs.Trigger></Tabs.List><Tabs.Content value="orders">{snapshot?.orders?.length ? <div className="paper-table"><Table.Root><Table.Header><Table.Row>{[t("代码 / 委托号", "Code / order ID"), t("方向", "Side"), t("委托 / 成交数量", "Ordered / filled qty"), t("限价 / 成交均价", "Limit / fill avg"), t("券商状态", "Broker status"), t("操作", "Action")].map((h) => <Table.ColumnHeaderCell key={h}>{h}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header><Table.Body>{snapshot.orders.map((o) => <Table.Row key={o.orderId}><Table.Cell><strong>{o.code}</strong><small className="paper-cell-note">{o.orderId}</small></Table.Cell><Table.Cell>{o.side}</Table.Cell><Table.Cell>{number(o.quantity, 0)} / {number(o.filledQuantity, 0)}</Table.Cell><Table.Cell>{number(o.price)} / {number(o.filledAveragePrice)}</Table.Cell><Table.Cell><Badge color="gray">{o.status}</Badge></Table.Cell><Table.Cell>{["SUBMITTED", "FILLED_PART"].includes(o.status) && intents.some((i) => i.kind === "order" && i.brokerOrderId === o.orderId) && <Button size="1" variant="soft" color="red" disabled={!!busy} onClick={() => act("cancel", async () => { const r = await api("/api/paper/cancel", { orderId: o.orderId, idempotencyKey: `cancel_${crypto.randomUUID()}`, environment: "SIMULATE" }); await load(); if (r.status === "unknown") throw new Error(r.error); })}>{t("请求撤单", "Request cancel")}</Button>}</Table.Cell></Table.Row>)}</Table.Body></Table.Root></div> : <Empty icon={ClipboardList} title={t("没有已读取的券商委托", "No broker orders loaded")} description={t("必须读取富途返回的真实委托；不会把信号或下单响应当成成交。", "Only actual broker orders appear here. Signals and acknowledgements are not fills.")} />}</Tabs.Content><Tabs.Content value="positions">{snapshot?.positions?.length ? <div className="paper-table"><Table.Root><Table.Header><Table.Row>{[t("代码", "Code"), t("数量 / 可卖", "Qty / sellable"), t("成本", "Cost"), t("市值", "Market value"), t("未实现盈亏", "Unrealized P&L")].map((h) => <Table.ColumnHeaderCell key={h}>{h}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header><Table.Body>{snapshot.positions.map((p, i) => <Table.Row key={`${p.code}:${i}`}><Table.Cell>{p.code}</Table.Cell><Table.Cell>{number(p.quantity, 0)} / {number(p.canSellQuantity, 0)}</Table.Cell><Table.Cell>{number(p.costPrice)}</Table.Cell><Table.Cell>{number(p.marketValue)}</Table.Cell><Table.Cell>{number(p.unrealizedPnl)}</Table.Cell></Table.Row>)}</Table.Body></Table.Root></div> : <Empty icon={CircleDollarSign} title={t("没有已读取的模拟持仓", "No paper positions loaded")} description={t("这里与研究面板里手动填写的持仓分开，不混算。", "Kept separate from manually entered research positions.")} />}</Tabs.Content><Tabs.Content value="journal">{intents.length ? <div className="paper-journal">{intents.map((r) => <article key={r.id}><div><strong>{r.symbol || r.brokerOrderId} · {r.side || t("撤单", "Cancel")}</strong><Badge color={r.status === "unknown" ? "red" : r.status === "blocked" ? "amber" : "gray"}>{t(...(states[r.status] || [r.status, r.status]))}</Badge><time>{date(r.createdAt)}</time></div><p>{r.rationale || r.meaning}</p>{r.error && <p className="form-error">{r.error}</p>}<details><summary>{t("核对策略、行情与委托链路", "Inspect strategy, quote and broker trace")}</summary><pre>{JSON.stringify(r, null, 2)}</pre></details></article>)}</div> : <Empty icon={Bot} title={t("等待 Agent 的第一条执行记录", "Awaiting the first agent execution record")} description={t("执行和拦截都会留下记录。没有连接或未授权时，不会编造策略战绩。", "Both submitted and blocked attempts are recorded. No fabricated strategy track record.")} />}</Tabs.Content></Tabs.Root><div className="panel-foot">{t("可见页面每 15 秒更新本地记录，不自动请求券商或交易。当前委托不是完整历史成交/费用明细，不计算虚构胜率。", "Local records refresh every 15s while visible; no broker calls or orders. Current orders are not a complete fill/fee ledger; no fabricated win rate.")}{snapshot?.sourceTimezone && ` · ${snapshot.sourceTimezone}`}</div></section>
    {editing && <PolicyEditor policy={policy} market={market} accountId={accountId} onClose={() => setEditing(false)} onSave={async (input) => { const saved = await api("/api/paper/policy", input); setStatus((s) => ({ ...s, policy: saved })); }} />}
  </div>;
}
