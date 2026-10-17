// Round scheduler: runs each arena account's agent or quant strategy at fixed market-local times
// on trading days, so the owner configures nothing outside the dashboard and every account in a
// competition can run on the same clock.
//
// Agents run headless through their own CLI (Claude Code `claude -p`, Codex `codex exec`, or any
// command template) with only this plugin's MCP server attached. Strategies run in-process through
// the paper broker. One leader per arena dir (lease), one run per account at a time, hard timeouts,
// and a per-account run log.

import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArenaError } from "./arena.mjs";
import { getStorageDir } from "./core.mjs";
import { getMarketSession } from "./market-rules.mjs";
import { buildRoundPrompt } from "./prompts.mjs";
import { classifyFailure, runAcpAgent, runAgent, streamFormat } from "./agent-runner.mjs";
import { limitsText } from "./trader-settings.mjs";
import { createTraderStrategyStore } from "./trader-strategies.mjs";
import { loadLibrary, skillTextFor } from "./skill-library.mjs";
import { createPaperBroker } from "./brokers.mjs";
import { BUDGET_DEFAULTS, GATE_DEFAULTS, GateError, WAKE_DEFAULTS, budgetDecision, gateDecision, sanitizeBudget, sanitizeGate, sanitizeWake, snapshot, wakeDecision } from "./review-gate.mjs";
import { localMarketTime } from "./market-rules.mjs";
import { loadStrategies, resolveParams, runStrategyRound } from "./strategies/index.mjs";

export const RUNNER_TYPES = ["claude", "codex", "kimi", "workbuddy", "acp", "command", "strategy"];
export const AGENT_TYPES = ["claude", "codex", "kimi", "workbuddy", "acp", "command"];
// Agents reachable over the Agent Client Protocol. Owners can add any other ACP command.
export const ACP_PRESETS = [
  { id: "kimi-acp", name: "Kimi Code (ACP)", command: "kimi", args: ["acp"] },
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"] },
  { id: "opencode", name: "OpenCode", command: "opencode", args: ["acp"] },
];
export const SCHEDULER_DEFAULTS = Object.freeze({ minAgentIntervalMinutes: 5, tickMs: 30000, leaseMs: 120000, catchUpMinutes: 90, timeoutMinutes: 20, tailBytes: 6000, runLogLimit: 300, failureThreshold: 3, maxQueueMinutes: 10, defaultReviewMinutes: 10 });
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minuteOf = (time) => { const [, h, m] = time.match(TIME); return Number(h) * 60 + Number(m); };
const tail = (text, bytes) => (text.length > bytes ? `…${text.slice(-bytes)}` : text);

export function sanitizeJob(input, current = {}) {
  const job = { ...current };
  if (input.enabled !== undefined) job.enabled = Boolean(input.enabled);
  if (input.times !== undefined) {
    if (!Array.isArray(input.times) || input.times.length > 12) throw new ArenaError("times must be an array of up to 12 HH:MM market-local times.");
    const times = [...new Set(input.times.map((time) => String(time).trim()))];
    for (const time of times) if (!TIME.test(time)) throw new ArenaError(`Invalid time "${time}"; use 24-hour HH:MM in the market's local time.`);
    job.times = times.sort();
  }
  if (input.intervalMinutes !== undefined) {
    if (input.intervalMinutes === null || input.intervalMinutes === "" || input.intervalMinutes === 0) delete job.intervalMinutes;
    else {
      const interval = Number(input.intervalMinutes);
      if (!Number.isInteger(interval) || interval < 1 || interval > 240) throw new ArenaError("intervalMinutes must be a whole number of minutes between 1 and 240.");
      job.intervalMinutes = interval;
    }
  }
  if (input.runner !== undefined) {
    const runner = input.runner ?? {};
    if (!RUNNER_TYPES.includes(runner.type)) throw new ArenaError(`runner.type must be one of ${RUNNER_TYPES.join(", ")}.`);
    const timeoutMinutes = Number(runner.timeoutMinutes ?? SCHEDULER_DEFAULTS.timeoutMinutes);
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) throw new ArenaError("timeoutMinutes must be between 1 and 60.");
    const next = { type: runner.type, timeoutMinutes, language: runner.language === "en" ? "en" : "zh-CN" };
    if (runner.model) next.model = String(runner.model).slice(0, 80);
    if (runner.webSearch === false) next.webSearch = false;
    if (runner.command) next.command = String(runner.command).slice(0, 500);
    if (Array.isArray(runner.args)) next.args = runner.args.slice(0, 40).map((arg) => String(arg).slice(0, 2000));
    if (runner.maxBudgetUsd !== undefined && runner.maxBudgetUsd !== null && runner.maxBudgetUsd !== "") {
      const budget = Number(runner.maxBudgetUsd);
      if (!Number.isFinite(budget) || budget <= 0 || budget > 100) throw new ArenaError("maxBudgetUsd must be between 0 and 100.");
      next.maxBudgetUsd = budget;
    }
    if (runner.type === "command" && (!next.command || !(next.args ?? []).some((arg) => arg.includes("{prompt}")))) throw new ArenaError("A command runner needs a command and at least one argument containing {prompt}.");
    if (runner.type === "acp" && !next.command) throw new ArenaError("An ACP runner needs the agent's command (e.g. gemini with args [\"--experimental-acp\"]).");
    if (runner.type === "strategy") {
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(runner.strategyId ?? "")) throw new ArenaError("A strategy runner needs a strategyId.");
      next.strategyId = runner.strategyId;
      next.params = runner.params && typeof runner.params === "object" && !Array.isArray(runner.params) ? runner.params : {};
    }
    job.runner = next;
  }
  // Backup agent: runs the round when the primary's CLI is out of quota or fails to start.
  if (input.backup !== undefined) {
    if (input.backup === null || input.backup === "") delete job.backup;
    else {
      if (!AGENT_TYPES.includes(input.backup.type) || input.backup.type === "command") throw new ArenaError(`backup.type must be one of ${AGENT_TYPES.filter((type) => type !== "command").join(", ")}.`);
      if (input.backup.type === "acp" && !input.backup.command) throw new ArenaError("An ACP backup needs its command.");
      job.backup = { type: input.backup.type, ...(input.backup.model ? { model: String(input.backup.model).slice(0, 80) } : {}), ...(input.backup.type === "acp" ? { command: String(input.backup.command).slice(0, 500), args: (input.backup.args ?? []).slice(0, 40).map(String) } : {}) };
    }
  }
  // Director mode: the agent reviews on its own cadence while a code strategy executes in between.
  if (input.strategy !== undefined) {
    if (input.strategy === null) delete job.strategy;
    else {
      const strategy = input.strategy;
      if (!/^[a-z0-9][a-z0-9:-]{1,60}$/.test(strategy.strategyId ?? "")) throw new ArenaError("strategy.strategyId is required.");
      const interval = Number(strategy.intervalMinutes ?? 5);
      if (!Number.isInteger(interval) || interval < 1 || interval > 240) throw new ArenaError("strategy.intervalMinutes must be 1–240.");
      job.strategy = { strategyId: strategy.strategyId, intervalMinutes: interval, params: strategy.params && typeof strategy.params === "object" && !Array.isArray(strategy.params) ? strategy.params : {} };
    }
  }
  // When a review is worth its tokens: skip unchanged slots, wake early on events, a daily budget.
  try {
    if (input.gate !== undefined) job.gate = sanitizeGate(input.gate, job.gate);
    if (input.wake !== undefined) job.wake = sanitizeWake(input.wake, job.wake);
    if (input.budget !== undefined) job.budget = sanitizeBudget(input.budget, job.budget);
  } catch (error) { if (error instanceof GateError) throw new ArenaError(error.message); throw error; }
  if (input.paused === false) delete job.paused;
  // An agent round itself takes minutes, so agents repeat at most every 10 minutes; code strategies every minute.
  if (job.intervalMinutes && job.runner && job.runner.type !== "strategy" && job.intervalMinutes < SCHEDULER_DEFAULTS.minAgentIntervalMinutes)
    throw new ArenaError(`Agent rounds take several minutes; use an interval of at least ${SCHEDULER_DEFAULTS.minAgentIntervalMinutes} minutes (code strategies may run every minute).`);
  job.times ??= [];
  if (!job.times.length && !job.intervalMinutes) throw new ArenaError("Give at least one run time or a repeat interval.");
  if (!job.runner) throw new ArenaError("Give a runner.");
  return job;
}

// Resolve an agent CLI: PATH first; for Codex also the binary shipped inside the ChatGPT desktop app.
export function onPath(name, envPath = process.env.PATH ?? "") {
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) for (const candidate of names) if (existsSync(path.join(dir, candidate))) return path.join(dir, candidate);
  return null;
}

export function workbuddyConfigDir(env = process.env) {
  return (env.WORKBUDDY_CONFIG_DIR || env.CODEBUDDY_CONFIG_DIR || "").trim() || path.join(os.homedir(), ".workbuddy");
}

export function defaultCommand(type) {
  if (type === "claude") return onPath("claude") ?? "claude";
  if (type === "kimi") return onPath("kimi") ?? path.join(os.homedir(), ".local", "bin", "kimi");
  if (type === "workbuddy") {
    // WorkBuddy ships the CodeBuddy CLI inside its app bundle; its flags mirror Claude Code's.
    const bundled = "/Applications/WorkBuddy AI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";
    return onPath("codebuddy") ?? (process.platform === "darwin" && existsSync(bundled) ? bundled : "codebuddy");
  }
  if (type === "codex") {
    const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
    return onPath("codex") ?? (process.platform === "darwin" && existsSync(bundled) ? bundled : "codex");
  }
  return null;
}

// Build the headless command for an agent round. Only this plugin's MCP server is attached.
export function agentInvocation({ job, account, prompt, nodePath, bundlePath, skillText, workDir, identity, dataDir = getStorageDir() }) {
  const runner = job.runner;
  // Pin the data directory: agent CLIs start MCP servers with a minimal environment, and a server
  // that resolved a different directory would not see this arena at all.
  const env = { HROUTER_AGENT_ID: identity, HROUTER_NO_DASHBOARD: "1", HROUTER_REPORT_DIR: dataDir };
  if (runner.type === "claude" || runner.type === "workbuddy") {
    const mcp = { mcpServers: { hrouter_market_pulse: { command: nodePath, args: [bundlePath, "--stdio"], env } } };
    const args = [
      "-p", prompt, "--mcp-config", JSON.stringify(mcp), "--strict-mcp-config",
      // Web search/fetch let the agent research news itself when the plugin's feeds come up empty.
      "--allowedTools", runner.webSearch === false ? "mcp__hrouter_market_pulse" : "mcp__hrouter_market_pulse,WebSearch,WebFetch", "--permission-mode", "dontAsk",
      "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      ...(runner.model ? ["--model", runner.model] : []),
      ...(runner.maxBudgetUsd && runner.type === "claude" ? ["--max-budget-usd", String(runner.maxBudgetUsd)] : []),
      ...(skillText ? ["--append-system-prompt", skillText] : []),
    ];
    // WorkBuddy runs its CLI with the app's config dir and the headless bundle; do the same so a
    // CLI login and the app share one configuration.
    const workbuddyEnv = runner.type === "workbuddy" ? { CODEBUDDY_CONFIG_DIR: workbuddyConfigDir(), WORKBUDDY_CONFIG_DIR: workbuddyConfigDir(), CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1" } : {};
    return { command: runner.command || defaultCommand(runner.type), args, env: { ...env, ...workbuddyEnv }, cwd: workDir };
  }
  if (runner.type === "kimi") {
    // Kimi Code reads MCP servers and its OAuth login from ~/.kimi-code; it has no per-run MCP flag,
    // so the plugin must be registered there. Prompt mode runs tools without asking (and rejects --auto).
    const model = runner.model ? (runner.model.includes("/") ? runner.model : `kimi-code/${runner.model}`) : null;
    const args = ["-p", skillText ? `${skillText}\n\n---\n\n${prompt}` : prompt, "--output-format", "stream-json", ...(model ? ["-m", model] : [])];
    return { command: runner.command || defaultCommand("kimi"), args, env, cwd: workDir };
  }
  if (runner.type === "codex") {
    const toml = (value) => JSON.stringify(value);
    const args = [
      "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", workDir,
      "-c", `mcp_servers.hrouter_market_pulse.command=${toml(nodePath)}`,
      "-c", `mcp_servers.hrouter_market_pulse.args=${toml([bundlePath, "--stdio"])}`,
      "-c", `mcp_servers.hrouter_market_pulse.env={ HROUTER_AGENT_ID = ${toml(identity)}, HROUTER_NO_DASHBOARD = "1", HROUTER_REPORT_DIR = ${toml(dataDir)} }`,
      // Only this plugin's tools are pre-approved; shell stays read-only and nothing else is granted.
      "-c", 'mcp_servers.hrouter_market_pulse.default_tools_approval_mode="approve"',
      "-c", 'approval_policy="never"',
      // Live web search for news and events the plugin's feeds miss (read-only, no shell access).
      "-c", `web_search=${runner.webSearch === false ? '"disabled"' : '"live"'}`,
      // An installed copy of this plugin would add a second same-named server; keep only ours.
      "-c", 'plugins."hrouter-market-pulse@hrouter-market-pulse".enabled=false',
      ...(runner.model ? ["-m", runner.model] : []),
      skillText ? `${skillText}\n\n---\n\n${prompt}` : prompt,
    ];
    return { command: runner.command || defaultCommand("codex"), args, env, cwd: workDir };
  }
  if (runner.type === "command") {
    const fill = (arg) => arg.replaceAll("{prompt}", prompt).replaceAll("{accountId}", account.id).replaceAll("{model}", runner.model ?? "").replaceAll("{node}", nodePath).replaceAll("{bundle}", bundlePath);
    return { command: runner.command, args: (runner.args ?? []).map(fill), env, cwd: workDir };
  }
  throw new ArenaError(`Runner ${runner.type} is not an agent CLI.`);
}

// Slots of a job that are due now: a trading day, the slot time has passed, within the catch-up window, not yet run.
const hhmm = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export function dueSlots(job, market, at, done, catchUpMinutes = SCHEDULER_DEFAULTS.catchUpMinutes) {
  const session = getMarketSession(market, at);
  if (session.status === "closed") return [];
  const fixed = (job.times ?? []).filter((time) => {
    const slot = minuteOf(time);
    const key = `${session.date}T${time}`;
    return session.minute >= slot && session.minute - slot <= catchUpMinutes && !done.includes(key);
  }).map((time) => ({ time, key: `${session.date}T${time}`, date: session.date }));
  // Repeat mode: one slot per interval inside each regular-session segment (never during lunch breaks).
  if (job.intervalMinutes && session.status === "open") {
    const segment = session.sessions.find(([start, end]) => session.minute >= start && session.minute < end);
    if (segment) {
      const slotStart = segment[0] + Math.floor((session.minute - segment[0]) / job.intervalMinutes) * job.intervalMinutes;
      const key = `${session.date}T${hhmm(slotStart)}`;
      if (!done.includes(key) && !fixed.some((slot) => slot.key === key)) fixed.push({ time: hhmm(slotStart), key, date: session.date, repeat: true });
    }
  }
  return fixed;
}

// Which CLI runs an account's rounds, inferred from the agent that owns it. Null for strategies or unknown hosts.
export function inferRunner(account) {
  const text = `${account.agent?.client ?? ""} ${account.agent?.label ?? ""}`.toLowerCase();
  if (account.model?.startsWith("strategy:") || text.includes("strategy")) return null;
  const model = account.model && !account.model.startsWith("strategy:") ? account.model : undefined;
  if (text.includes("codex") || text.includes("openai")) return { type: "codex", model };
  if (text.includes("kimi")) return { type: "kimi", model };
  if (text.includes("workbuddy") || text.includes("codebuddy")) return { type: "workbuddy", model };
  if (text.includes("claude")) return { type: "claude", model };
  return null;
}

// Quota pools: one CLI login is one quota window, shared by every trader that runs on it.
export const poolKey = (runner) => (runner.type === "command" || runner.type === "acp" ? `${runner.type}:${runner.command ?? ""}` : runner.type);
const agentLane = (job) => job.runner?.type !== "strategy";
const PAUSING_FAILURES = new Set(["auth", "config", "missing"]);

export function createScheduler({
  arena, now = arena.now, spawnImpl = spawn, strategyLoader = loadStrategies, nodePath = process.execPath,
  bundlePath = fileURLToPath(import.meta.url).endsWith("server.bundle.mjs") ? fileURLToPath(import.meta.url) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "server.bundle.mjs"),
  skillPath, tickMs = SCHEDULER_DEFAULTS.tickMs, leaseMs = SCHEDULER_DEFAULTS.leaseMs, catchUpMinutes = SCHEDULER_DEFAULTS.catchUpMinutes,
  strategyDeps = {}, resolveStrategy = null, onError = () => {},
} = {}) {
  const file = path.join(arena.root, "schedules.json");
  const runDir = path.join(arena.root, "runs");
  const eventDir = path.join(runDir, "events");
  const ownerId = `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
  const running = new Map(); // accountId → agent / primary lane, `${accountId}:S` → strategy lane
  const agentRuns = new Set();
  const live = new Map(); // runId → { record, events }
  const queued = new Map();
  const listeners = new Set();
  let timer = null;
  let ticking = null;
  let role = "idle";
  let last = null;

  const traderStore = createTraderStrategyStore(arena.root, now);
  // Agent-written strategies (trader-<id>) come from the trader's version store and run sandboxed.
  const resolver = resolveStrategy ?? ((strategyId) => (strategyId.startsWith("trader-") ? traderStore.resolve(strategyId) : null));
  const emit = (message) => { for (const listener of listeners) { try { listener(message); } catch { /* ignore */ } } };

  async function readState() {
    try { const state = JSON.parse(await readFile(file, "utf8")); return { jobs: state.jobs ?? [], done: state.done ?? {}, pools: state.pools ?? {}, reviews: state.reviews ?? {}, gate: state.gate ?? {} }; }
    catch (error) { if (error.code === "ENOENT") return { jobs: [], done: {}, pools: {}, reviews: {}, gate: {} }; throw error; }
  }
  async function writeState(state) {
    await mkdir(arena.root, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 1), "utf8");
    await rename(temporary, file);
  }
  const update = (mutate) => arena.withLock(async () => { const state = await readState(); const result = await mutate(state); await writeState(state); return result; });
  const poolPaused = (state, runner) => {
    const pool = state.pools[poolKey(runner)];
    return pool && Date.parse(pool.pausedUntil) > Date.parse(now()) ? pool : null;
  };
  const workbench = async () => (arena.workbenchSettings ? arena.workbenchSettings().catch(() => ({})) : {});

  async function appendRun(accountId, record) {
    await mkdir(runDir, { recursive: true });
    await appendFile(path.join(runDir, `${accountId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  }

  // Events are appended as they stream, so any process (another dashboard) can follow a live run.
  function eventWriter(runId) {
    let chain = mkdir(eventDir, { recursive: true }).catch(() => {});
    return {
      push(event) { chain = chain.then(() => appendFile(path.join(eventDir, `${runId}.jsonl`), `${JSON.stringify(event)}\n`, "utf8")).catch(() => {}); },
      flush: () => chain,
    };
  }

  async function listRuns({ accountId, limit = 50 } = {}) {
    if (!/^acc_[a-f0-9]{12}$/.test(accountId ?? "")) throw new ArenaError("accountId required.");
    let text = "";
    try { text = await readFile(path.join(runDir, `${accountId}.jsonl`), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    // Records written before lanes existed: a strategy runner is the strategy lane, anything else an agent round.
    const rows = text.split("\n").filter(Boolean).slice(-SCHEDULER_DEFAULTS.runLogLimit).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
      .map((row) => (row.lane ? row : { ...row, lane: row.runner === "strategy" ? "strategy" : "agent" }));
    const inFlight = [...live.values()].filter((entry) => entry.record.accountId === accountId && !rows.some((row) => row.id === entry.record.id)).map((entry) => ({ ...entry.record, status: "running", events: entry.events.length }));
    return [...rows.slice(-limit).reverse(), ...inFlight].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, limit);
  }

  async function runEvents(runId) {
    if (!/^run_[a-f0-9]{12}$/.test(runId ?? "")) throw new ArenaError("Invalid run id.");
    if (live.has(runId)) return { runId, running: true, run: live.get(runId).record, events: live.get(runId).events };
    try {
      const text = await readFile(path.join(eventDir, `${runId}.jsonl`), "utf8");
      return { runId, running: false, events: text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
    } catch (error) { if (error.code === "ENOENT") return { runId, running: false, events: [] }; throw error; }
  }

  // The arena skill plus the trader's bound library skills (its template's, or its own list).
  async function skillText(account) {
    let base = null;
    const candidates = [skillPath, path.resolve(path.dirname(bundlePath), "..", "skills", "hrouter-agent-arena", "SKILL.md")].filter(Boolean);
    for (const candidate of candidates) { try { base = (await readFile(candidate, "utf8")).replace(/^---[\s\S]*?---\s*/, ""); break; } catch { /* next */ } }
    const library = account ? await skillTextFor(account).catch(() => "") : "";
    return [base, library].filter(Boolean).join("\n\n---\n\n") || null;
  }

  async function findStrategy(strategyId, accountId) {
    const found = await resolver(strategyId, accountId);
    if (found) return { strategy: found, errors: [] };
    if (strategyId.startsWith("trader-")) return { strategy: null, errors: ["这个交易员还没有通过检查的代码策略"] };
    const { strategies, errors } = await strategyLoader();
    return { strategy: strategies.get(strategyId) ?? null, errors };
  }

  // The prompt for one agent round, with every layer the owner configured.
  async function promptFor(account, job, trigger, changes = null) {
    const settings = await workbench();
    const strategy = job.strategy ? await findStrategy(job.strategy.strategyId, account.id).then(({ strategy: found }) => found ? { id: found.id, version: found.version, intervalMinutes: job.strategy.intervalMinutes } : null).catch(() => null) : null;
    return buildRoundPrompt({
      account, language: job.runner.language, prompts: { global: settings.prompts?.global, market: settings.prompts?.[account.market] },
      limits: account.limits ? limitsText(account.limits, account.limitStatus) : "", instructions: account.instructions ?? [],
      mode: job.mode === "director" || job.strategy ? "director" : "rounds", strategy, reviewMinutes: job.intervalMinutes ?? null, trigger: trigger === "wake" ? changes : null, changes: trigger === "wake" ? null : changes,
      autonomy: account.autonomy ?? null, approvals: (account.approvals ?? []).filter((entry) => ["pending", "approved", "rejected", "failed", "expired"].includes(entry.status)).slice(0, 5),
      starter: account.template ? await loadLibrary().then((library) => { const template = library.templates.find((entry) => entry.id === account.template); return template && !template.builtinStrategy ? template.starterStrategy : null; }).catch(() => null) : null,
    });
  }

  async function runStrategyLane(job, account, { strategyId, params }, record) {
    const { strategy, errors } = await findStrategy(strategyId, account.id);
    if (!strategy) return { ...record, status: "failed", finishedAt: now(), error: `Strategy ${strategyId} not found${errors.length ? ` (${errors.join("; ")})` : ""}.` };
    const caller = { client: account.agent.client ?? `strategy-${strategy.id}` };
    const broker = createPaperBroker({ arena, accountId: job.accountId, caller });
    try {
      const round = await runStrategyRound({ strategy, params, broker, now, runId: record.id, ...strategyDeps });
      return { ...record, status: "ok", finishedAt: now(), orders: round.orders, logs: round.logs.slice(-20), strategyVersion: strategy.version };
    } catch (error) {
      return { ...record, status: "failed", finishedAt: now(), error: error.message, strategyVersion: strategy.version };
    }
  }

  async function runAgentRound(job, account, { record, runner }) {
    const entry = { record, events: [] };
    const writer = eventWriter(record.id);
    live.set(record.id, entry);
    emit({ type: "run-start", run: record });
    const workDir = await mkdtemp(path.join(os.tmpdir(), "hrouter-round-"));
    try {
      const effective = { ...job, runner };
      const identity = account.agent.client ?? `${job.runner.type}-${(job.runner.model ?? "default").replace(/[^a-z0-9.-]+/gi, "-").toLowerCase()}`;
      const prompt = await promptFor(account, job, record.trigger, record.changes ?? null);
      const skills = await skillText(account);
      const onEvent = (event) => { entry.events.push(event); if (entry.events.length > 400) entry.events.shift(); writer.push(event); emit({ type: "run-event", runId: record.id, accountId: record.accountId, event }); };
      let invocation;
      let result;
      if (runner.type === "acp") {
        // ACP agents get this plugin's MCP server through session/new and the skill text in the prompt.
        const env = { HROUTER_AGENT_ID: identity, HROUTER_NO_DASHBOARD: "1", HROUTER_REPORT_DIR: getStorageDir() };
        invocation = { command: runner.command, args: runner.args ?? [] };
        result = await runAcpAgent({
          ...invocation, env, cwd: workDir, prompt: skills ? `${skills}\n\n---\n\n${prompt}` : prompt, timeoutMs: runner.timeoutMinutes * 60000, spawnImpl, onEvent,
          mcpServers: [{ name: "hrouter_market_pulse", command: nodePath, args: [bundlePath, "--stdio"], env: Object.entries(env).map(([name, value]) => ({ name, value })) }],
        });
      } else {
        invocation = agentInvocation({ job: effective, account, prompt, nodePath, bundlePath, skillText: skills, workDir, identity });
        result = await runAgent({ ...invocation, timeoutMs: runner.timeoutMinutes * 60000, spawnImpl, format: streamFormat(runner.type), tailBytes: SCHEDULER_DEFAULTS.tailBytes, onEvent });
      }
      const after = await arena.getAccount(job.accountId, { sync: false, limit: 1 });
      const reported = Boolean(after.lastRoundAt && Date.parse(after.lastRoundAt) >= Date.parse(record.startedAt));
      const status = result.timedOut ? "timeout" : result.exitCode === 0 && !result.streamError ? (reported ? "ok" : "no-round") : "failed";
      const failure = status === "failed" || status === "timeout" ? classifyFailure(result, now()) : null;
      await writer.flush();
      return {
        ...record, status, finishedAt: now(), command: invocation.command, exitCode: result.exitCode, durationMs: result.durationMs, error: result.error ?? result.streamError ?? null,
        stdoutTail: result.text || result.stdout, stderrTail: result.stderr, reported, usage: result.usage, sessionId: result.sessionId, events: result.events.length, failure,
      };
    } finally {
      live.delete(record.id);
      // A lingering agent process can keep the directory busy on Windows; a leftover temp dir must not fail the round.
      await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
  }

  const backupRunner = (job) => job.backup ? { timeoutMinutes: job.runner.timeoutMinutes, language: job.runner.language, ...(job.runner.webSearch === false ? { webSearch: false } : {}), type: job.backup.type, ...(job.backup.model ? { model: job.backup.model } : {}), ...(job.backup.command ? { command: job.backup.command, args: job.backup.args ?? [] } : {}) } : null;

  async function pausePool(runner, failure, runId) {
    await update((state) => { state.pools[poolKey(runner)] = { pausedUntil: failure.resetAt, kind: failure.kind, message: failure.message ?? null, at: now(), runId }; });
    emit({ type: "pool", key: poolKey(runner), pausedUntil: failure.resetAt });
  }

  async function finishJob(job, outcome, lane) {
    await appendRun(job.accountId, outcome);
    tokenCache.delete(job.accountId);
    await update((state) => {
      const stored = state.jobs.find((entry) => entry.accountId === job.accountId);
      if (!stored) return;
      if (lane === "strategy") { stored.strategyLastRun = { id: outcome.id, status: outcome.status, at: outcome.finishedAt }; return; }
      stored.lastRun = { id: outcome.id, status: outcome.status, at: outcome.finishedAt };
      if (outcome.status === "skipped") return;
      stored.consecutiveFailures = outcome.status === "ok" ? 0 : (stored.consecutiveFailures ?? 0) + 1;
      if (outcome.failure && PAUSING_FAILURES.has(outcome.failure.kind)) stored.paused = { kind: outcome.failure.kind, message: outcome.failure.message ?? outcome.error ?? null, at: outcome.finishedAt, runId: outcome.id };
    });
    emit({ type: "run-end", run: outcome });
  }

  // Execute one round for a job now. Never two at once for the same account and lane.
  async function execute(job, { slot = null, trigger = "schedule", lane = "primary", changes = null } = {}) {
    const key = lane === "strategy" ? `${job.accountId}:S` : job.accountId;
    if (running.has(key)) return { status: "skipped", reason: "already-running" };
    const isAgent = lane !== "strategy" && agentLane(job);
    // Claim the slot before the first await: a tick launches jobs without waiting, so a late claim
    // would let the next job in the same tick slip past the concurrency cap.
    let release;
    running.set(key, new Promise((resolve) => { release = resolve; }));
    if (isAgent) agentRuns.add(key);
    try {
      const account = await arena.getAccount(job.accountId, { sync: false, limit: 1 });
      if (account.status !== "active") return { status: "skipped", reason: "inactive" };
      const record = (runner, extra = {}) => ({ id: `run_${randomBytes(6).toString("hex")}`, accountId: job.accountId, lane: lane === "strategy" ? "strategy" : runner.type === "strategy" ? "strategy" : "agent", runner: runner.type, model: runner.model ?? null, strategyId: lane === "strategy" ? job.strategy.strategyId : runner.strategyId ?? null, slot, trigger, ...(changes ? { changes } : {}), startedAt: now(), ...extra });
      const work = (async () => {
        if (lane === "strategy") return [await runStrategyLane(job, account, job.strategy, record({ type: "strategy" }))];
        if (job.runner.type === "strategy") return [await runStrategyLane(job, account, { strategyId: job.runner.strategyId, params: job.runner.params }, record(job.runner))];
        const state = await readState();
        let runner = job.runner;
        let backupFor = null;
        const blocked = poolPaused(state, job.runner);
        if (blocked) {
          const backup = backupRunner(job);
          if (backup && !poolPaused(state, backup)) { runner = backup; backupFor = `${job.runner.type} ${blocked.kind}`; }
          else return [{ ...record(job.runner), status: "skipped", reason: "quota", finishedAt: now(), error: `${job.runner.type} 额度用尽，${blocked.pausedUntil} 恢复${job.backup ? "；备用 Agent 也不可用" : "；没有设置备用 Agent"}` }];
        }
        const outcomes = [await runAgentRound(job, account, { record: record(runner, backupFor ? { backupFor } : {}), runner })];
        const first = outcomes[0];
        if (first.failure?.kind === "quota") {
          await pausePool(runner, first.failure, first.id);
          const backup = backupRunner(job);
          if (!backupFor && backup && !poolPaused(await readState(), backup)) outcomes.push(await runAgentRound(job, account, { record: record(backup, { backupFor: `${runner.type} quota`, trigger: "backup" }), runner: backup }));
        }
        return outcomes;
      })();
      running.set(key, work);
      const outcomes = await work;
      for (const outcome of outcomes) await finishJob(job, outcome, lane === "strategy" ? "strategy" : "primary");
      // What the trader saw at the end of a review, for the next change check.
      if (isAgent && outcomes.some((outcome) => ["ok", "no-round"].includes(outcome.status))) await rememberReview(job.accountId).catch((error) => onError(error));
      return outcomes.at(-1);
    } finally { release(); running.delete(key); agentRuns.delete(key); }
  }

  async function reviewAccount(accountId) {
    return arena.getAccount(accountId, { sync: false, limit: 30 });
  }
  async function rememberReview(accountId) {
    const account = await reviewAccount(accountId);
    await update((state) => { state.reviews = { ...state.reviews, [accountId]: snapshot(account, now()) }; });
  }
  const dayOf = (at, market) => localMarketTime(at, market)?.date ?? String(at).slice(0, 10);
  // Count a skipped or woken review per trader and day, shown in the dashboard instead of run rows.
  async function countGate(accountId, market, field, reason) {
    const at = now();
    await update((state) => {
      const today = dayOf(at, market);
      const current = state.gate?.[accountId]?.date === today ? state.gate[accountId] : { date: today, skipped: 0, wakes: 0, budgetSkips: 0 };
      current[field] = (current[field] ?? 0) + 1;
      current[`last_${field}`] = { at, reason };
      state.gate = { ...state.gate, [accountId]: current };
    });
  }
  const tokenCache = new Map();
  async function tokensToday(accountId, market) {
    const hit = tokenCache.get(accountId);
    if (hit && Date.now() - hit.at < 60000) return hit.tokens;
    const today = dayOf(now(), market);
    const runs = (await listRuns({ accountId, limit: SCHEDULER_DEFAULTS.runLogLimit })).filter((run) => run.lane === "agent" && dayOf(run.startedAt, market) === today);
    const tokens = runs.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0), 0);
    tokenCache.set(accountId, { at: Date.now(), tokens });
    return tokens;
  }

  async function markDone(key, slots) {
    await update((state) => { state.done[key] = [...(state.done[key] ?? []), ...slots.map((slot) => slot.key)].slice(-600); });
  }

  async function tickOnce() {
    const at = now();
    const lease = await arena.acquireLease("scheduler", ownerId, leaseMs);
    if (!lease.owner) { role = "standby"; last = { at, role }; return last; }
    role = "leader";
    const { jobs, done, reviews, gate: gateState } = await readState();
    const cap = (await workbench()).maxConcurrentAgents ?? 4;
    const started = [];
    const waiting = [];
    for (const job of jobs.filter((entry) => entry.enabled !== false && !entry.paused)) {
      let account;
      try { account = await arena.getAccount(job.accountId, { sync: false, limit: 1 }); } catch { continue; }
      if (account.status !== "active") continue;
      // Strategy lane of a director job: code executes on its own cadence, no tokens.
      if (job.strategy && agentLane(job)) {
        const strategyKey = `${job.accountId}:S`;
        const slots = dueSlots({ intervalMinutes: job.strategy.intervalMinutes, times: [] }, account.market, at, done[strategyKey] ?? [], catchUpMinutes);
        if (slots.length) {
          await markDone(strategyKey, slots);
          if (!running.has(strategyKey)) { started.push(strategyKey); execute(job, { slot: slots.at(-1).key, lane: "strategy" }).catch((error) => onError(error)); }
        }
      }
      const slots = dueSlots(job, account.market, at, done[job.accountId] ?? [], catchUpMinutes);
      const previous = reviews[job.accountId] ?? null;
      const today = dayOf(at, account.market);
      if (!slots.length) {
        queued.delete(job.accountId);
        // Between slots: wake the trader early when something it must react to happened.
        if (agentLane(job) && !running.has(job.accountId) && agentRuns.size < cap && getMarketSession(account.market, at).status === "open") {
          const wake = { ...WAKE_DEFAULTS, ...job.wake };
          const budget = budgetDecision({ budget: { ...BUDGET_DEFAULTS, ...job.budget }, tokensToday: await tokensToday(job.accountId, account.market), previous, at, intervalMinutes: job.intervalMinutes });
          const wakesToday = gateState?.[job.accountId]?.date === today ? gateState[job.accountId].wakes ?? 0 : 0;
          const reason = budget.mode === "normal" ? wakeDecision({ wake, gate: { ...GATE_DEFAULTS, ...job.gate }, previous, account: await reviewAccount(job.accountId), at, wakesToday }) : null;
          if (reason) {
            await countGate(job.accountId, account.market, "wakes", reason);
            started.push(job.accountId);
            execute(job, { trigger: "wake", changes: reason }).catch((error) => onError(error));
          }
        }
        continue;
      }
      if (running.has(job.accountId)) {
        // A repeat slot that arrives while the previous round is still going is skipped, not queued,
        // so slow rounds never chain back-to-back.
        const skipped = slots.filter((slot) => slot.repeat);
        if (skipped.length) await markDone(job.accountId, skipped);
        continue;
      }
      if (agentLane(job) && agentRuns.size >= cap) {
        // At the concurrency cap: wait a few ticks, then give the slot up instead of piling up.
        const since = queued.get(job.accountId) ?? Date.parse(at);
        queued.set(job.accountId, since);
        if (Date.parse(at) - since > SCHEDULER_DEFAULTS.maxQueueMinutes * 60000) {
          queued.delete(job.accountId);
          await markDone(job.accountId, slots);
          await appendRun(job.accountId, { id: `run_${randomBytes(6).toString("hex")}`, accountId: job.accountId, lane: "agent", runner: job.runner.type, model: job.runner.model ?? null, slot: slots.at(-1).key, trigger: "schedule", startedAt: at, finishedAt: at, status: "skipped", reason: "queue-full", error: `同时运行的 Agent 已达上限 ${cap} 个，排队超过 ${SCHEDULER_DEFAULTS.maxQueueMinutes} 分钟，跳过这一轮。` });
        } else waiting.push(job.accountId);
        continue;
      }
      queued.delete(job.accountId);
      // Mark every due slot before launching so a crash or a second leader never double-runs it.
      await markDone(job.accountId, slots);
      let changes = null;
      if (agentLane(job)) {
        // Scripts look first: an agent review only runs when something changed or the budget allows.
        const budget = budgetDecision({ budget: { ...BUDGET_DEFAULTS, ...job.budget }, tokensToday: await tokensToday(job.accountId, account.market), previous, at, intervalMinutes: job.intervalMinutes });
        if (budget.mode === "stop" || (budget.mode === "slow" && !budget.run)) { await countGate(job.accountId, account.market, "budgetSkips", budget.reason); continue; }
        const decision = gateDecision({ gate: { ...GATE_DEFAULTS, ...job.gate }, previous, account: await reviewAccount(job.accountId), at, sameDay: previous ? dayOf(previous.at, account.market) === today : false });
        if (!decision.run) { await countGate(job.accountId, account.market, "skipped", decision.reason); continue; }
        if (decision.changes?.length) changes = decision.reason;
      }
      started.push(job.accountId);
      execute(job, { slot: slots.at(-1).key, changes }).catch((error) => onError(error));
    }
    last = { at, role, started, waiting, running: [...running.keys()] };
    return last;
  }

  async function tick() {
    if (ticking) return ticking;
    ticking = tickOnce().catch((error) => { onError(error); return { at: now(), error: error.message }; }).finally(() => { ticking = null; });
    return ticking;
  }

  return {
    ownerId,
    tick,
    async listJobs() {
      const { jobs, pools, reviews, gate } = await readState();
      const at = Date.parse(now());
      return jobs.map((job) => {
        const pool = agentLane(job) ? pools[poolKey(job.runner)] : null;
        return {
          ...job, running: running.has(job.accountId), strategyRunning: running.has(`${job.accountId}:S`), queued: queued.has(job.accountId),
          unhealthy: (job.consecutiveFailures ?? 0) >= SCHEDULER_DEFAULTS.failureThreshold || Boolean(job.paused),
          pool: pool && Date.parse(pool.pausedUntil) > at ? pool : null,
          ...(agentLane(job) ? { gate: { ...GATE_DEFAULTS, ...job.gate }, wake: { ...WAKE_DEFAULTS, ...job.wake }, budget: { ...BUDGET_DEFAULTS, ...job.budget }, gateToday: gate?.[job.accountId] ?? null, lastReviewAt: reviews?.[job.accountId]?.at ?? null } : {}),
        };
      });
    },
    async listPools() {
      const { jobs, pools } = await readState();
      const at = Date.parse(now());
      const keys = new Set([...Object.keys(pools), ...jobs.filter(agentLane).flatMap((job) => [poolKey(job.runner), ...(job.backup ? [poolKey(job.backup)] : [])])]);
      return [...keys].map((key) => ({
        key, paused: Boolean(pools[key] && Date.parse(pools[key].pausedUntil) > at), ...(pools[key] ?? {}),
        traders: jobs.filter((job) => agentLane(job) && poolKey(job.runner) === key).map((job) => job.accountId),
        backups: jobs.filter((job) => job.backup && poolKey(job.backup) === key).map((job) => job.accountId),
      }));
    },
    async clearPool(key) {
      return update((state) => { delete state.pools[key]; return { cleared: key }; });
    },
    async resumeJob(accountId) {
      return update((state) => {
        const job = state.jobs.find((entry) => entry.accountId === accountId);
        if (!job) throw new ArenaError("No schedule for this account.", "not_found", 404);
        delete job.paused;
        job.consecutiveFailures = 0;
        return job;
      });
    },
    async upsertJob(accountId, input) {
      const account = await arena.getAccount(accountId, { sync: false, limit: 1 });
      for (const strategyInput of [input.runner?.type === "strategy" ? input.runner : null, input.strategy ?? null].filter(Boolean)) {
        const { strategy } = await findStrategy(strategyInput.strategyId, accountId);
        if (!strategy) throw new ArenaError(`Unknown strategy ${strategyInput.strategyId}.`);
        if (!strategy.markets.includes(account.market)) throw new ArenaError(`${strategy.id} does not support the ${account.market} market.`);
        resolveParams(strategy, strategyInput.params);
      }
      return update((state) => {
        const index = state.jobs.findIndex((job) => job.accountId === accountId);
        const job = { ...sanitizeJob(input, index >= 0 ? state.jobs[index] : { enabled: true }), accountId, updatedAt: now() };
        if (input.mode !== undefined) { if (!["director", "rounds"].includes(input.mode)) throw new ArenaError("mode must be director or rounds."); job.mode = input.mode; }
        // Any edit by the owner clears a configuration pause: they have looked at it.
        delete job.paused;
        if (index >= 0) state.jobs[index] = job; else state.jobs.push(job);
        return job;
      });
    },
    // Review cadence and strategy frequency, changeable by the owner or (unless locked) the trader itself.
    async setCadence(accountId, { reviewMinutes, strategyMinutes, reason } = {}, caller = {}) {
      const requested = [];
      const changes = {};
      for (const [key, value] of [["reviewMinutes", reviewMinutes], ["strategyMinutes", strategyMinutes]]) {
        if (value === undefined) continue;
        if (await arena.checkLock?.(accountId, key, caller)) { requested.push(await arena.requestChange(accountId, { key, to: value, reason }, caller)); continue; }
        changes[key] = value;
      }
      const job = await update((state) => {
        const stored = state.jobs.find((entry) => entry.accountId === accountId);
        if (!stored) throw new ArenaError("This trader has no schedule yet; configure it in the dashboard first.", "not_found", 404);
        if (changes.reviewMinutes !== undefined) {
          const value = Number(changes.reviewMinutes);
          if (!Number.isInteger(value) || value < SCHEDULER_DEFAULTS.minAgentIntervalMinutes || value > 240) throw new ArenaError(`reviewMinutes must be ${SCHEDULER_DEFAULTS.minAgentIntervalMinutes}–240.`);
          stored.intervalMinutes = value;
        }
        if (changes.strategyMinutes !== undefined) {
          if (!stored.strategy) throw new ArenaError("No code strategy yet; write one with arena_write_strategy first.");
          const value = Number(changes.strategyMinutes);
          if (!Number.isInteger(value) || value < 1 || value > 240) throw new ArenaError("strategyMinutes must be 1–240.");
          stored.strategy.intervalMinutes = value;
        }
        stored.updatedAt = now();
        return stored;
      });
      if (Object.keys(changes).length && arena.logCadenceChange) await arena.logCadenceChange(accountId, changes, caller, reason);
      return { job, applied: changes, requested };
    },
    // Give a new agent account the owner's default schedule, unless it already has one: the agent
    // reviews every N minutes as the director and writes its own code strategy.
    async ensureDefaultSchedule(accountId, intervalMinutes = SCHEDULER_DEFAULTS.defaultReviewMinutes) {
      if (!intervalMinutes) return { created: false, reason: "default schedule disabled" };
      const { jobs } = await readState();
      if (jobs.some((job) => job.accountId === accountId)) return { created: false, reason: "already scheduled" };
      const account = await arena.getAccount(accountId, { sync: false, limit: 1 });
      const runner = inferRunner(account);
      if (!runner) return { created: false, reason: "no CLI runner for this agent" };
      const job = await this.upsertJob(accountId, { intervalMinutes, times: [], mode: "director", runner: { ...runner, timeoutMinutes: SCHEDULER_DEFAULTS.timeoutMinutes } });
      return { created: true, job };
    },
    async deleteJob(accountId) {
      return update((state) => { state.jobs = state.jobs.filter((job) => job.accountId !== accountId); delete state.done[accountId]; delete state.done[`${accountId}:S`]; return { deleted: accountId }; });
    },
    async runNow(accountId, { lane = "primary", trigger = "manual" } = {}) {
      const { jobs } = await readState();
      const job = jobs.find((entry) => entry.accountId === accountId);
      if (!job) throw new ArenaError("Configure a schedule for this account first.", "not_found", 404);
      if (lane === "strategy" && !job.strategy) throw new ArenaError("This trader has no code strategy yet.");
      if (running.has(lane === "strategy" ? `${accountId}:S` : accountId)) return { status: "skipped", reason: "already-running" };
      const promise = execute(job, { trigger, lane });
      return { status: "started", wait: () => promise };
    },
    listRuns,
    runEvents,
    // Exactly what the next agent round would send: the prompt and the skill text.
    async previewPrompt(accountId) {
      const { jobs } = await readState();
      const job = jobs.find((entry) => entry.accountId === accountId) ?? { runner: { type: "claude" }, intervalMinutes: SCHEDULER_DEFAULTS.defaultReviewMinutes, mode: "director" };
      const account = await arena.getAccount(accountId, { sync: false, limit: 1 });
      const skills = await skillText(account);
      return { prompt: await promptFor(account, job, "schedule"), skills, chars: (skills?.length ?? 0) + (await promptFor(account, job, "schedule")).length };
    },
    // Tokens, cost and run counts per trader since a time (default: start of today, local).
    async usage({ since } = {}) {
      const from = Date.parse(since ?? new Date(new Date(now()).setHours(0, 0, 0, 0)).toISOString());
      const { jobs } = await readState();
      const rows = [];
      for (const job of jobs) {
        const runs = (await listRuns({ accountId: job.accountId, limit: SCHEDULER_DEFAULTS.runLogLimit })).filter((run) => Date.parse(run.startedAt) >= from);
        const agentRuns = runs.filter((run) => run.lane === "agent" && run.status !== "skipped");
        rows.push({
          accountId: job.accountId, reviews: agentRuns.length, strategyRuns: runs.filter((run) => run.lane === "strategy").length,
          inputTokens: agentRuns.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0), 0), outputTokens: agentRuns.reduce((sum, run) => sum + (run.usage?.outputTokens ?? 0), 0),
          costUsd: agentRuns.reduce((sum, run) => sum + (run.usage?.costUsd ?? 0), 0), failed: runs.filter((run) => ["failed", "timeout"].includes(run.status)).length,
          byRunner: Object.entries(agentRuns.reduce((map, run) => ({ ...map, [run.runner]: (map[run.runner] ?? 0) + (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0) }), {})).map(([runner, tokens]) => ({ runner, tokens })),
        });
      }
      const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
      return { since: new Date(from).toISOString(), traders: rows, totals: { reviews: sum("reviews"), strategyRuns: sum("strategyRuns"), tokens: sum("inputTokens") + sum("outputTokens"), costUsd: Math.round(sum("costUsd") * 100) / 100, failed: sum("failed") } };
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start({ initialDelayMs = 3000 } = {}) {
      if (timer) return this;
      const loop = async () => { await tick(); if (timer) timer = setTimeout(loop, tickMs); };
      timer = setTimeout(loop, initialDelayMs);
      timer.unref?.();
      return this;
    },
    async stop() {
      clearTimeout(timer);
      timer = null;
      await ticking;
      await Promise.allSettled([...running.values()]);
      await arena.releaseLease("scheduler", ownerId).catch(() => {});
    },
    status: () => ({ ownerId, role, last, running: [...running.keys()], agentRuns: agentRuns.size, queued: [...queued.keys()] }),
  };
}
