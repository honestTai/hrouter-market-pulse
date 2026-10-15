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
import { roundPrompt } from "./prompts.mjs";
import { createPaperBroker } from "./brokers.mjs";
import { loadStrategies, resolveParams, runStrategyRound } from "./strategies/index.mjs";

export const RUNNER_TYPES = ["claude", "codex", "workbuddy", "command", "strategy"];
export const SCHEDULER_DEFAULTS = Object.freeze({ tickMs: 30000, leaseMs: 120000, catchUpMinutes: 90, timeoutMinutes: 20, tailBytes: 6000, runLogLimit: 300, failureThreshold: 3 });
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
  if (input.runner !== undefined) {
    const runner = input.runner ?? {};
    if (!RUNNER_TYPES.includes(runner.type)) throw new ArenaError(`runner.type must be one of ${RUNNER_TYPES.join(", ")}.`);
    const timeoutMinutes = Number(runner.timeoutMinutes ?? SCHEDULER_DEFAULTS.timeoutMinutes);
    if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) throw new ArenaError("timeoutMinutes must be between 1 and 60.");
    const next = { type: runner.type, timeoutMinutes, language: runner.language === "en" ? "en" : "zh-CN" };
    if (runner.model) next.model = String(runner.model).slice(0, 80);
    if (runner.command) next.command = String(runner.command).slice(0, 500);
    if (Array.isArray(runner.args)) next.args = runner.args.slice(0, 40).map((arg) => String(arg).slice(0, 2000));
    if (runner.maxBudgetUsd !== undefined && runner.maxBudgetUsd !== null && runner.maxBudgetUsd !== "") {
      const budget = Number(runner.maxBudgetUsd);
      if (!Number.isFinite(budget) || budget <= 0 || budget > 100) throw new ArenaError("maxBudgetUsd must be between 0 and 100.");
      next.maxBudgetUsd = budget;
    }
    if (runner.type === "command" && (!next.command || !(next.args ?? []).some((arg) => arg.includes("{prompt}")))) throw new ArenaError("A command runner needs a command and at least one argument containing {prompt}.");
    if (runner.type === "strategy") {
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(runner.strategyId ?? "")) throw new ArenaError("A strategy runner needs a strategyId.");
      next.strategyId = runner.strategyId;
      next.params = runner.params && typeof runner.params === "object" && !Array.isArray(runner.params) ? runner.params : {};
    }
    job.runner = next;
  }
  if (!job.times?.length) throw new ArenaError("Give at least one run time.");
  if (!job.runner) throw new ArenaError("Give a runner.");
  return job;
}

// Resolve an agent CLI: PATH first; for Codex also the binary shipped inside the ChatGPT desktop app.
export function onPath(name, envPath = process.env.PATH ?? "") {
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) for (const candidate of names) if (existsSync(path.join(dir, candidate))) return path.join(dir, candidate);
  return null;
}

export function defaultCommand(type) {
  if (type === "claude") return onPath("claude") ?? "claude";
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
      "--allowedTools", "mcp__hrouter_market_pulse", "--permission-mode", "dontAsk",
      "--output-format", "text", "--no-session-persistence",
      ...(runner.model ? ["--model", runner.model] : []),
      ...(runner.maxBudgetUsd && runner.type === "claude" ? ["--max-budget-usd", String(runner.maxBudgetUsd)] : []),
      ...(skillText ? ["--append-system-prompt", skillText] : []),
    ];
    return { command: runner.command || defaultCommand(runner.type), args, env, cwd: workDir };
  }
  if (runner.type === "codex") {
    const toml = (value) => JSON.stringify(value);
    const args = [
      "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", workDir,
      "-c", `mcp_servers.hrouter_market_pulse.command=${toml(nodePath)}`,
      "-c", `mcp_servers.hrouter_market_pulse.args=${toml([bundlePath, "--stdio"])}`,
      "-c", `mcp_servers.hrouter_market_pulse.env={ HROUTER_AGENT_ID = ${toml(identity)}, HROUTER_NO_DASHBOARD = "1", HROUTER_REPORT_DIR = ${toml(dataDir)} }`,
      // Only this plugin's tools are pre-approved; shell stays read-only and nothing else is granted.
      "-c", 'mcp_servers.hrouter_market_pulse.default_tools_approval_mode="approve"',
      "-c", 'approval_policy="never"',
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
export function dueSlots(job, market, at, done, catchUpMinutes = SCHEDULER_DEFAULTS.catchUpMinutes) {
  const session = getMarketSession(market, at);
  if (session.status === "closed") return [];
  return job.times.filter((time) => {
    const slot = minuteOf(time);
    const key = `${session.date}T${time}`;
    return session.minute >= slot && session.minute - slot <= catchUpMinutes && !done.includes(key);
  }).map((time) => ({ time, key: `${session.date}T${time}`, date: session.date }));
}

function runChild({ command, args, env, cwd, timeoutMs, spawnImpl, tailBytes }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      // Drop the parent agent session's variables (e.g. when started from inside Claude Code) so the
      // child CLI starts as a fresh, independent session with its own login.
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|CLAUDECODE|CODEX_THREAD|CODEX_SESSION|MCP_)/.test(key)));
      child = spawnImpl(command, args, { cwd, env: { ...inherited, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (error) {
      resolve({ exitCode: null, error: error.message, stdout: "", stderr: "", durationMs: 0, timedOut: false });
      return;
    }
    child.stdout?.on("data", (chunk) => { stdout = tail(stdout + chunk, tailBytes * 2); });
    child.stderr?.on("data", (chunk) => { stderr = tail(stderr + chunk, tailBytes * 2); });
    const kill = (signal) => { try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 10000).unref?.(); }, timeoutMs);
    child.on("error", (error) => { clearTimeout(timer); resolve({ exitCode: null, error: error.code === "ENOENT" ? `Command not found: ${command}` : error.message, stdout: tail(stdout, tailBytes), stderr: tail(stderr, tailBytes), durationMs: Date.now() - started, timedOut }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ exitCode: code, signal, stdout: tail(stdout, tailBytes), stderr: tail(stderr, tailBytes), durationMs: Date.now() - started, timedOut }); });
  });
}

export function createScheduler({
  arena, now = arena.now, spawnImpl = spawn, strategyLoader = loadStrategies, nodePath = process.execPath,
  bundlePath = fileURLToPath(import.meta.url).endsWith("server.bundle.mjs") ? fileURLToPath(import.meta.url) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "server.bundle.mjs"),
  skillPath, tickMs = SCHEDULER_DEFAULTS.tickMs, leaseMs = SCHEDULER_DEFAULTS.leaseMs, catchUpMinutes = SCHEDULER_DEFAULTS.catchUpMinutes,
  strategyDeps = {}, onError = () => {},
} = {}) {
  const file = path.join(arena.root, "schedules.json");
  const runDir = path.join(arena.root, "runs");
  const ownerId = `${os.hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
  const running = new Map();
  let timer = null;
  let ticking = null;
  let role = "idle";
  let last = null;

  async function readState() {
    try { const state = JSON.parse(await readFile(file, "utf8")); return { jobs: state.jobs ?? [], done: state.done ?? {} }; }
    catch (error) { if (error.code === "ENOENT") return { jobs: [], done: {} }; throw error; }
  }
  async function writeState(state) {
    await mkdir(arena.root, { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 1), "utf8");
    await rename(temporary, file);
  }
  const update = (mutate) => arena.withLock(async () => { const state = await readState(); const result = await mutate(state); await writeState(state); return result; });

  async function appendRun(accountId, record) {
    await mkdir(runDir, { recursive: true });
    await appendFile(path.join(runDir, `${accountId}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  }

  async function listRuns({ accountId, limit = 50 } = {}) {
    if (!/^acc_[a-f0-9]{12}$/.test(accountId ?? "")) throw new ArenaError("accountId required.");
    let text = "";
    try { text = await readFile(path.join(runDir, `${accountId}.jsonl`), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const rows = text.split("\n").filter(Boolean).slice(-SCHEDULER_DEFAULTS.runLogLimit).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return rows.slice(-limit).reverse();
  }

  async function skillText() {
    const candidates = [skillPath, path.resolve(path.dirname(bundlePath), "..", "skills", "hrouter-agent-arena", "SKILL.md")].filter(Boolean);
    for (const candidate of candidates) { try { return (await readFile(candidate, "utf8")).replace(/^---[\s\S]*?---\s*/, ""); } catch { /* next */ } }
    return null;
  }

  // Execute one round for a job now. Never two at once for the same account.
  async function execute(job, { slot = null, trigger = "schedule" } = {}) {
    if (running.has(job.accountId)) return { status: "skipped", reason: "already-running" };
    const account = await arena.getAccount(job.accountId, { sync: false, limit: 1 });
    if (account.status !== "active") return { status: "skipped", reason: "inactive" };
    const runId = `run_${randomBytes(6).toString("hex")}`;
    const startedAt = now();
    const record = { id: runId, accountId: job.accountId, runner: job.runner.type, model: job.runner.model ?? null, strategyId: job.runner.strategyId ?? null, slot, trigger, startedAt };
    const work = (async () => {
      if (job.runner.type === "strategy") {
        const { strategies, errors } = await strategyLoader();
        const strategy = strategies.get(job.runner.strategyId);
        if (!strategy) return { ...record, status: "failed", finishedAt: now(), error: `Strategy ${job.runner.strategyId} not found${errors.length ? ` (${errors.join("; ")})` : ""}.` };
        const caller = { client: account.agent.client ?? `strategy-${strategy.id}` };
        const broker = createPaperBroker({ arena, accountId: job.accountId, caller });
        try {
          const round = await runStrategyRound({ strategy, params: job.runner.params, broker, now, runId, ...strategyDeps });
          return { ...record, status: "ok", finishedAt: now(), orders: round.orders, logs: round.logs.slice(-20), strategyVersion: strategy.version };
        } catch (error) {
          return { ...record, status: "failed", finishedAt: now(), error: error.message };
        }
      }
      const workDir = await mkdtemp(path.join(os.tmpdir(), "hrouter-round-"));
      try {
        const identity = account.agent.client ?? `${job.runner.type}-${(job.runner.model ?? "default").replace(/[^a-z0-9.-]+/gi, "-").toLowerCase()}`;
        const prompt = roundPrompt({ account, language: job.runner.language });
        const invocation = agentInvocation({ job, account, prompt, nodePath, bundlePath, skillText: await skillText(), workDir, identity });
        const result = await runChild({ ...invocation, timeoutMs: job.runner.timeoutMinutes * 60000, spawnImpl, tailBytes: SCHEDULER_DEFAULTS.tailBytes });
        const after = await arena.getAccount(job.accountId, { sync: false, limit: 1 });
        const reported = Boolean(after.lastRoundAt && Date.parse(after.lastRoundAt) >= Date.parse(startedAt));
        const status = result.timedOut ? "timeout" : result.exitCode === 0 ? (reported ? "ok" : "no-round") : "failed";
        return { ...record, status, finishedAt: now(), command: invocation.command, exitCode: result.exitCode, durationMs: result.durationMs, error: result.error ?? null, stdoutTail: result.stdout, stderrTail: result.stderr, reported };
      } finally { await rm(workDir, { recursive: true, force: true }); }
    })();
    running.set(job.accountId, work);
    try {
      const outcome = await work;
      await appendRun(job.accountId, outcome);
      await update((state) => {
        const stored = state.jobs.find((entry) => entry.accountId === job.accountId);
        if (stored) {
          stored.lastRun = { id: outcome.id, status: outcome.status, at: outcome.finishedAt };
          stored.consecutiveFailures = outcome.status === "ok" ? 0 : (stored.consecutiveFailures ?? 0) + 1;
        }
      });
      return outcome;
    } finally { running.delete(job.accountId); }
  }

  async function tickOnce() {
    const at = now();
    const lease = await arena.acquireLease("scheduler", ownerId, leaseMs);
    if (!lease.owner) { role = "standby"; last = { at, role }; return last; }
    role = "leader";
    const { jobs, done } = await readState();
    const started = [];
    for (const job of jobs.filter((entry) => entry.enabled !== false)) {
      let account;
      try { account = await arena.getAccount(job.accountId, { sync: false, limit: 1 }); } catch { continue; }
      if (account.status !== "active") continue;
      const slots = dueSlots(job, account.market, at, done[job.accountId] ?? [], catchUpMinutes);
      if (!slots.length || running.has(job.accountId)) continue;
      // Mark every due slot before launching so a crash or a second leader never double-runs it.
      await update((state) => {
        state.done[job.accountId] = [...(state.done[job.accountId] ?? []), ...slots.map((slot) => slot.key)].slice(-100);
      });
      started.push(job.accountId);
      execute(job, { slot: slots.at(-1).key }).catch((error) => onError(error));
    }
    last = { at, role, started, running: [...running.keys()] };
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
      const { jobs } = await readState();
      return jobs.map((job) => ({ ...job, running: running.has(job.accountId), unhealthy: (job.consecutiveFailures ?? 0) >= SCHEDULER_DEFAULTS.failureThreshold }));
    },
    async upsertJob(accountId, input) {
      const account = await arena.getAccount(accountId, { sync: false, limit: 1 });
      if (input.runner?.type === "strategy") {
        const { strategies } = await strategyLoader();
        const strategy = strategies.get(input.runner.strategyId);
        if (!strategy) throw new ArenaError(`Unknown strategy ${input.runner.strategyId}.`);
        if (!strategy.markets.includes(account.market)) throw new ArenaError(`${strategy.id} does not support the ${account.market} market.`);
        resolveParams(strategy, input.runner.params);
      }
      return update((state) => {
        const index = state.jobs.findIndex((job) => job.accountId === accountId);
        const job = { ...sanitizeJob(input, index >= 0 ? state.jobs[index] : { enabled: true }), accountId, updatedAt: now() };
        if (index >= 0) state.jobs[index] = job; else state.jobs.push(job);
        return job;
      });
    },
    async deleteJob(accountId) {
      return update((state) => { state.jobs = state.jobs.filter((job) => job.accountId !== accountId); delete state.done[accountId]; return { deleted: accountId }; });
    },
    async runNow(accountId) {
      const { jobs } = await readState();
      const job = jobs.find((entry) => entry.accountId === accountId);
      if (!job) throw new ArenaError("Configure a schedule for this account first.", "not_found", 404);
      if (running.has(accountId)) return { status: "skipped", reason: "already-running" };
      const promise = execute(job, { trigger: "manual" });
      return { status: "started", wait: () => promise };
    },
    listRuns,
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
    status: () => ({ ownerId, role, last, running: [...running.keys()] }),
  };
}
