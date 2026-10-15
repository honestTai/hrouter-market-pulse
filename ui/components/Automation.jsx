import React, { useCallback, useEffect, useState } from "react";
import { Badge, Button, Callout, Switch, Table, TextArea, TextField, Tooltip } from "@radix-ui/themes";
import { CircleAlert, Clock3, Play, Power, Save, Server, Trash2 } from "lucide-react";
import { useWorkspace } from "../context.jsx";
import { api } from "../data.mjs";
import { Empty, ErrorNotice } from "./Primitives.jsx";

const RUNNERS = [
  { id: "claude", zh: "Claude Code（claude -p）", en: "Claude Code (claude -p)" },
  { id: "codex", zh: "Codex（codex exec）", en: "Codex (codex exec)" },
  { id: "strategy", zh: "量化策略（代码规则）", en: "Quant strategy (code rules)" },
  { id: "command", zh: "自定义命令", en: "Custom command" },
];
const DEFAULT_TIMES = { A: "09:45, 14:30", HK: "09:45, 15:30", US: "09:45, 15:30" };
const STATUS = { ok: ["完成", "OK", "jade"], "no-round": ["未发布结果", "No round", "amber"], failed: ["失败", "Failed", "red"], timeout: ["超时", "Timeout", "red"], skipped: ["跳过", "Skipped", "gray"] };

export function ServiceChip({ service }) {
  const { t, date } = useWorkspace();
  if (!service) return null;
  const running = service.state === "running";
  const label = service.state === "demo" ? t("演示", "Demo") : running ? t("常驻服务运行中", "Service running") : t("常驻服务未运行", "Service not running");
  const detail = running
    ? t(`版本 ${service.version} · 心跳 ${date(service.heartbeatAt)} · 端口 ${service.port}`, `v${service.version} · heartbeat ${date(service.heartbeatAt)} · port ${service.port}`)
    : t("运行 npm run service:install 安装开机自启服务：盘中撮合、止损、日报与定时运行都靠它。", "Run npm run service:install for the login service: in-session matching, exits, digests and scheduled rounds depend on it.");
  return <Tooltip content={detail}><Badge color={running ? "jade" : service.state === "demo" ? "gray" : "amber"} variant="soft" size="2"><Server size={13} />{label}</Badge></Tooltip>;
}

export function AutomationPanel({ account }) {
  const { t, date, notify, language } = useWorkspace();
  const [state, setState] = useState(null);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState(null);
  const load = useCallback(async () => {
    try {
      const [schedules, history] = await Promise.all([api("/api/arena/schedules"), api(`/api/arena/runs/${account.id}`)]);
      setState(schedules);
      setRuns(history.runs ?? []);
      const job = schedules.jobs.find((entry) => entry.accountId === account.id);
      setForm((current) => current ?? {
        enabled: job?.enabled ?? true,
        times: (job?.times ?? DEFAULT_TIMES[account.market].split(", ")).join(", "),
        type: job?.runner.type ?? (account.agent?.client?.startsWith("strategy") ? "strategy" : /codex/i.test(account.agent?.label ?? "") ? "codex" : "claude"),
        model: job?.runner.model ?? (account.model?.startsWith("strategy:") ? "" : account.model ?? ""),
        timeoutMinutes: job?.runner.timeoutMinutes ?? 20, maxBudgetUsd: job?.runner.maxBudgetUsd ?? "",
        strategyId: job?.runner.strategyId ?? schedules.strategies[0]?.id ?? "",
        params: JSON.stringify(job?.runner.params ?? {}, null, 2),
        command: job?.runner.command ?? "", args: (job?.runner.args ?? []).join("\n"),
      });
      setError("");
    } catch (failure) { setError(failure.message); }
  }, [account.id, account.market, account.agent, account.model]);
  useEffect(() => { load(); const timer = window.setInterval(() => { if (!document.hidden) load(); }, 15000); return () => window.clearInterval(timer); }, [load]);
  if (!state || !form) return <div className="automation"><ErrorNotice message={error} onRetry={load} />{!error && <Empty compact icon={Clock3} title={t("载入中…", "Loading…")} />}</div>;
  const job = state.jobs.find((entry) => entry.accountId === account.id);
  const strategy = state.strategies.find((entry) => entry.id === form.strategyId);
  const set = (key) => (event) => setForm({ ...form, [key]: event?.target ? event.target.value : event });
  const save = async () => {
    setBusy("save"); setError("");
    try {
      let params = {};
      if (form.type === "strategy") { try { params = form.params.trim() ? JSON.parse(form.params) : {}; } catch { throw new Error(t("策略参数需要是 JSON。", "Strategy parameters must be JSON.")); } }
      const runner = { type: form.type, timeoutMinutes: Number(form.timeoutMinutes), language,
        ...(form.model ? { model: form.model } : {}), ...(form.maxBudgetUsd !== "" ? { maxBudgetUsd: Number(form.maxBudgetUsd) } : {}),
        ...(form.type === "strategy" ? { strategyId: form.strategyId, params } : {}),
        ...(form.type === "command" ? { command: form.command, args: form.args.split("\n").map((line) => line.trim()).filter(Boolean) } : {}) };
      await api(`/api/arena/schedules/${account.id}`, { enabled: form.enabled, times: form.times.split(/[,，\s]+/).filter(Boolean), runner });
      notify(t("自动运行已保存。", "Automation saved.")); await load();
    } catch (failure) { setError(failure.message); } finally { setBusy(""); }
  };
  const runNow = async () => {
    setBusy("run"); setError("");
    try { const result = await api(`/api/arena/schedules/${account.id}/run`, {}); notify(result.status === "started" ? t("已开始运行一轮，完成后出现在运行记录里。", "Round started; it appears in the run log when finished.") : t("已有一轮在运行。", "A round is already running.")); }
    catch (failure) { setError(failure.message); } finally { setBusy(""); setTimeout(load, 3000); }
  };
  const remove = async () => { setBusy("delete"); try { await api(`/api/arena/schedules/${account.id}/delete`, {}); setForm(null); await load(); } catch (failure) { setError(failure.message); } finally { setBusy(""); } };
  const serviceDown = state.service?.state !== "running" && !state.demo;
  return <div className="automation">
    {serviceDown && <Callout.Root color="amber" size="1"><Callout.Icon><CircleAlert size={16} /></Callout.Icon><Callout.Text>{t("常驻服务未运行：定时任务不会按时执行。在插件目录运行 ", "The service is not running, so schedules will not fire on time. Run ")}<code>npm run service:install</code>{t(" 安装开机自启服务。", " in the plugin folder to install the login service.")}</Callout.Text></Callout.Root>}
    {job?.unhealthy && <Callout.Root color="red" size="1"><Callout.Icon><CircleAlert size={16} /></Callout.Icon><Callout.Text>{t(`已连续 ${job.consecutiveFailures} 轮失败，请查看下方运行记录。`, `${job.consecutiveFailures} consecutive failed rounds; see the run log below.`)}</Callout.Text></Callout.Root>}
    <div className="form-grid">
      <div className="form-field"><label>{t("运行方式", "Runner")}</label><select className="native-select" value={form.type} onChange={set("type")}>{RUNNERS.map((runner) => <option key={runner.id} value={runner.id}>{t(runner.zh, runner.en)}</option>)}</select></div>
      <div className="form-field"><label>{t(`运行时间（${account.market} 当地时间，逗号分隔）`, `Run times (${account.market} local, comma-separated)`)}</label><TextField.Root value={form.times} onChange={set("times")} placeholder="09:45, 14:30" /><small className="muted">{t("只在交易日运行；同组账户建议用相同时间，对比才公平。", "Trading days only; use the same times across a group for a fair comparison.")}</small></div>
      {form.type !== "strategy" && <div className="form-field"><label>{t("模型（可选）", "Model (optional)")}</label><TextField.Root value={form.model} onChange={set("model")} placeholder={form.type === "codex" ? "gpt-5.5-codex" : "claude-opus-5-5"} /></div>}
      {form.type === "claude" && <div className="form-field"><label>{t("单轮费用上限（美元，可选）", "Max cost per round (USD, optional)")}</label><TextField.Root type="number" min="0.1" step="0.1" value={form.maxBudgetUsd} onChange={set("maxBudgetUsd")} /></div>}
      {form.type === "strategy" && <>
        <div className="form-field"><label>{t("策略", "Strategy")}</label><select className="native-select" value={form.strategyId} onChange={(event) => setForm({ ...form, strategyId: event.target.value, params: "{}" })}>{state.strategies.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · v{entry.version}{entry.origin === "owner" ? t("（自定义）", " (yours)") : ""}</option>)}</select>{strategy && <small className="muted">{strategy.description}</small>}</div>
        <div className="form-field full"><label>{t("参数（JSON，留空用默认值；universe 指定股票池）", "Parameters (JSON; empty uses defaults; universe sets the pool)")}</label><TextArea rows={4} value={form.params} onChange={set("params")} className="paper-code" />{strategy && <small className="muted">{Object.entries(strategy.params).map(([key, spec]) => `${key}: ${spec.label ?? ""} = ${spec.default}`).join(" · ")}</small>}</div>
      </>}
      {form.type === "command" && <>
        <div className="form-field"><label>{t("命令", "Command")}</label><TextField.Root value={form.command} onChange={set("command")} placeholder="/usr/local/bin/my-agent" /></div>
        <div className="form-field full"><label>{t("参数（每行一个；{prompt} {accountId} {model} {node} {bundle} 会被替换）", "Arguments (one per line; {prompt} {accountId} {model} {node} {bundle} are substituted)")}</label><TextArea rows={3} value={form.args} onChange={set("args")} /></div>
      </>}
      <div className="form-field"><label>{t("单轮超时（分钟）", "Timeout per round (min)")}</label><TextField.Root type="number" min="1" max="60" value={form.timeoutMinutes} onChange={set("timeoutMinutes")} /></div>
      <div className="form-field"><label>{t("启用", "Enabled")}</label><label className="checkbox-label"><Switch checked={form.enabled} onCheckedChange={(value) => setForm({ ...form, enabled: value })} />{form.enabled ? t("按时运行", "Runs on schedule") : t("已暂停", "Paused")}</label></div>
    </div>
    {state.strategyErrors?.length > 0 && <p className="form-error">{t("自定义策略加载失败：", "Owner strategy errors: ")}{state.strategyErrors.join("; ")}</p>}
    <ErrorNotice message={error} />
    <div className="dialog-actions start">
      <Button onClick={save} loading={busy === "save"} disabled={account.demo}><Save size={15} />{t("保存", "Save")}</Button>
      <Button variant="soft" onClick={runNow} loading={busy === "run"} disabled={!job || account.demo || state.demo}><Play size={15} />{t("立即运行一轮", "Run a round now")}</Button>
      <span className="spacer" />
      {job && <Button variant="soft" color="red" onClick={remove} loading={busy === "delete"}><Trash2 size={15} />{t("删除定时", "Remove schedule")}</Button>}
    </div>
    <p className="muted small"><Power size={12} /> {t("自定义策略：把 .mjs 文件放进 ", "Custom strategies: put .mjs files in ")}<code>{state.strategyDir}</code>{t("，格式见 docs/STRATEGIES.md。", "; see docs/STRATEGIES.md.")}</p>
    <h4 className="automation-heading">{t("运行记录", "Run log")}</h4>
    {runs.length ? <div className="table-scroll"><Table.Root size="1">
      <Table.Header><Table.Row><Table.ColumnHeaderCell>{t("开始", "Started")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("方式", "Runner")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("状态", "Status")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell align="right">{t("耗时", "Duration")}</Table.ColumnHeaderCell><Table.ColumnHeaderCell>{t("结果", "Result")}</Table.ColumnHeaderCell></Table.Row></Table.Header>
      <Table.Body>{runs.map((run) => { const [zh, en, color] = STATUS[run.status] ?? [run.status, run.status, "gray"]; const seconds = run.durationMs ? Math.round(run.durationMs / 1000) : run.finishedAt ? Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000) : null; return <Table.Row key={run.id}>
        <Table.Cell className="nowrap">{date(run.startedAt)}<small className="cell-subtitle">{run.trigger === "manual" ? t("手动", "manual") : run.slot}</small></Table.Cell>
        <Table.Cell>{run.runner}{run.model ? ` · ${run.model}` : ""}{run.strategyId ? ` · ${run.strategyId}` : ""}</Table.Cell>
        <Table.Cell><Badge color={color} variant="soft">{t(zh, en)}</Badge></Table.Cell>
        <Table.Cell align="right" className="tabular">{seconds !== null ? `${seconds}s` : "—"}</Table.Cell>
        <Table.Cell className="reason-cell">{run.error ? <span className="loss">{run.error}</span> : run.orders ? run.orders.map((order) => `${order.side} ${order.symbol} ${order.quantity} ${order.status}`).join(" · ") || t("无订单", "no orders") : null}
          {(run.stdoutTail || run.stderrTail) && <details><summary>{t("输出", "Output")}</summary><pre className="run-output">{[run.stdoutTail, run.stderrTail].filter(Boolean).join("\n---\n")}</pre></details>}</Table.Cell>
      </Table.Row>; })}</Table.Body>
    </Table.Root></div> : <Empty compact icon={Clock3} title={t("还没有运行记录", "No runs yet")} />}
  </div>;
}
