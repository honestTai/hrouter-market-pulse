// Runs one headless agent CLI and turns its output stream into uniform events: text, tool calls,
// tool results, usage and the final message. Claude Code / WorkBuddy emit stream-json, Codex emits
// --json, Kimi Code emits its own stream-json; command runners are plain text.
//
// classifyFailure() reads a failed run's output and tells the scheduler what to do: wait for a quota
// window, pause until the owner fixes the configuration, or simply retry next time.

import readline from "node:readline";

const tail = (text, bytes) => (text.length > bytes ? `…${text.slice(-bytes)}` : text);
const preview = (value, length = 400) => {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : Array.isArray(value) ? value.map((entry) => entry?.text ?? entry?.content?.text ?? (typeof entry === "string" ? entry : "")).join("") : JSON.stringify(value);
  return text.length > length ? `${text.slice(0, length)}…` : text;
};

export function streamFormat(type) {
  if (type === "claude" || type === "workbuddy") return "claude";
  if (type === "codex") return "codex";
  if (type === "kimi") return "kimi";
  return "text";
}

// Parse one output line into zero or more events. `state` keeps the session id, usage and text.
export function parseLine(format, line, state) {
  if (format === "text") { state.text.push(line); return []; }
  let message;
  try { message = JSON.parse(line); } catch { return line.trim() ? [{ t: "log", text: line.slice(0, 500) }] : []; }
  const events = [];
  if (format === "claude") {
    if (message.type === "system" && message.subtype === "init") { state.sessionId = message.session_id ?? state.sessionId; if (message.model) state.model = message.model; }
    if (message.type === "assistant") {
      for (const part of message.message?.content ?? []) {
        if (part.type === "text" && part.text?.trim()) { state.text.push(part.text); events.push({ t: "text", text: part.text }); }
        if (part.type === "tool_use") events.push({ t: "tool", id: part.id, name: part.name, input: part.input ?? {} });
      }
    }
    if (message.type === "user") {
      for (const part of message.message?.content ?? []) {
        if (part.type === "tool_result") events.push({ t: "tool_result", id: part.tool_use_id, ok: !part.is_error, preview: preview(part.content) });
      }
    }
    if (message.type === "result") {
      state.sessionId = message.session_id ?? state.sessionId;
      const usage = message.usage ?? {};
      state.usage = {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0, costUsd: Number.isFinite(message.total_cost_usd) ? message.total_cost_usd : null,
      };
      events.push({ t: "usage", ...state.usage });
      state.done = true;
      if (message.is_error || message.subtype !== "success") state.error = String(message.result ?? message.subtype ?? "error");
      else state.final = String(message.result ?? "");
    }
  } else if (format === "codex") {
    const item = message.item;
    if (message.type === "thread.started") state.sessionId = message.thread_id ?? state.sessionId;
    if (message.type === "item.started" && item?.type === "mcp_tool_call") events.push({ t: "tool", id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} });
    if (message.type === "item.started" && item?.type === "command_execution") events.push({ t: "tool", id: item.id, name: "shell", input: { command: item.command } });
    if (message.type === "item.started" && item?.type === "web_search") events.push({ t: "tool", id: item.id, name: "web_search", input: { query: item.query } });
    if (message.type === "item.completed") {
      if (item?.type === "agent_message" && item.text?.trim()) { state.text.push(item.text); events.push({ t: "text", text: item.text }); }
      if (item?.type === "mcp_tool_call") events.push({ t: "tool_result", id: item.id, ok: item.status !== "failed", preview: preview(item.result?.content ?? item.result ?? item.error) });
      if (item?.type === "command_execution") events.push({ t: "tool_result", id: item.id, ok: item.exit_code === 0, preview: preview(item.aggregated_output) });
      if (item?.type === "web_search") events.push({ t: "tool_result", id: item.id, ok: true, preview: preview(item.query) });
    }
    if (message.type === "turn.completed") {
      const usage = message.usage ?? {};
      const previous = state.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: null };
      state.usage = { inputTokens: previous.inputTokens + (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0), outputTokens: previous.outputTokens + (usage.output_tokens ?? 0), costUsd: null };
      events.push({ t: "usage", ...state.usage });
      state.done = true;
      state.final = state.text.at(-1) ?? "";
    }
    if (message.type === "turn.failed" || message.type === "error") state.error = String(message.error?.message ?? message.message ?? "turn failed");
  } else if (format === "kimi") {
    if (message.role === "meta" && message.session_id) state.sessionId = message.session_id;
    if (message.role === "assistant") {
      const text = typeof message.content === "string" ? message.content : preview(message.content, 4000);
      if (text.trim()) { state.text.push(text); events.push({ t: "text", text }); }
      for (const call of message.tool_calls ?? []) events.push({ t: "tool", id: call.id, name: call.function?.name ?? call.name ?? "tool", input: (() => { try { return JSON.parse(call.function?.arguments ?? "{}"); } catch { return {}; } })() });
    }
    if (message.role === "tool") events.push({ t: "tool_result", id: message.tool_call_id, ok: !/error/i.test(String(message.content ?? "").slice(0, 40)), preview: preview(message.content) });
    if (message.usage) {
      state.usage = { inputTokens: message.usage.input_tokens ?? message.usage.prompt_tokens ?? 0, outputTokens: message.usage.output_tokens ?? message.usage.completion_tokens ?? 0, costUsd: null };
      events.push({ t: "usage", ...state.usage });
    }
  }
  return events;
}

// Tokens some CLIs only print at the end ("tokens used\n81,496").
function usageFromText(text) {
  const match = String(text).match(/tokens used\s*\n?\s*([\d,]+)/i);
  return match ? { inputTokens: Number(match[1].replace(/,/g, "")), outputTokens: 0, costUsd: null, estimated: true } : null;
}

export function runAgent({ command, args, env, cwd, timeoutMs, spawnImpl, format = "text", tailBytes = 6000, onEvent = () => {}, inheritedEnv = process.env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const state = { text: [], usage: null, sessionId: null, done: false, final: "", error: null, model: null };
    const events = [];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    const push = (event) => {
      const entry = { ...event, at: new Date().toISOString(), seq: events.length };
      events.push(entry);
      if (events.length > 400) events.splice(0, events.length - 400);
      try { onEvent(entry); } catch { /* a broken listener never stops the run */ }
    };
    try {
      // Drop the parent agent session's variables (e.g. when started from inside Claude Code) so the
      // child CLI starts as a fresh, independent session with its own login.
      const inherited = Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => !/^(CLAUDE|CLAUDECODE|CODEX_THREAD|CODEX_SESSION|MCP_)/.test(key)));
      child = spawnImpl(command, args, { cwd, env: { ...inherited, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    } catch (error) {
      resolve({ exitCode: null, error: error.message, stdout: "", stderr: "", durationMs: 0, timedOut: false, events, usage: null, text: "", sessionId: null });
      return;
    }
    push({ t: "start", command });
    if (child.stdout) {
      const lines = readline.createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        stdout = tail(`${stdout}${line}\n`, tailBytes * 2);
        for (const event of parseLine(format, line, state)) push(event);
      });
    }
    child.stderr?.on("data", (chunk) => { stderr = tail(stderr + chunk, tailBytes * 2); });
    const kill = (signal) => { try { process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 10000).unref?.(); }, timeoutMs);
    const finish = (extra) => {
      clearTimeout(timer);
      const text = state.final || state.text.join("\n");
      const usage = state.usage ?? usageFromText(stdout);
      if (state.error) push({ t: "error", message: state.error.slice(0, 500) });
      push({ t: "end", ok: !timedOut && extra.exitCode === 0 && !state.error });
      resolve({ ...extra, stdout: tail(stdout, tailBytes), stderr: tail(stderr, tailBytes), durationMs: Date.now() - started, timedOut, events, usage, text: tail(text, 4000), sessionId: state.sessionId, streamError: state.error, model: state.model });
    };
    child.on("error", (error) => finish({ exitCode: null, error: error.code === "ENOENT" ? `Command not found: ${command}` : error.message }));
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
  });
}

// What a failed run means for scheduling.
//   quota   – the CLI login is out of quota: pause that CLI (all traders using it) until resetAt
//   auth    – not logged in: pause the trader until the owner fixes it
//   config  – wrong model name, conflicting flags: pause the trader until the owner fixes it
//   missing – the CLI is not installed
//   timeout / other – transient: retry at the next slot
export function classifyFailure(result, at = new Date().toISOString()) {
  if (result.timedOut) return { kind: "timeout" };
  const text = `${result.error ?? ""}\n${result.streamError ?? ""}\n${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  if (/Command not found|ENOENT|command not found/i.test(result.error ?? "")) return { kind: "missing", message: result.error };
  if (/usage limit|rate[ _-]?limit|quota|exceeded your|too many requests|\b429\b|额度|limit reached|hit your .*limit|insufficient_quota|credit balance/i.test(text)) {
    return { kind: "quota", resetAt: resetTime(text, at), message: firstLine(text, /usage limit|rate[ _-]?limit|quota|429|额度|limit reached|credit balance/i) };
  }
  if (/not logged in|please (run )?.*login|log in|unauthori[sz]ed|\b401\b|invalid api key|authentication|auth_error|OAuth/i.test(text)) return { kind: "auth", message: firstLine(text, /login|log in|unauthori|401|api key|authentication|auth/i) };
  if (/model.{0,80}(not found|isn't described|does not exist|unknown|unsupported|invalid|not available)|model catalog|unknown model|invalid model|cannot combine|unknown option|unexpected argument|unrecognized (option|argument)|invalid (value|argument)/i.test(text))
    return { kind: "config", message: firstLine(text, /model|combine|option|argument|invalid/i) };
  return { kind: "other", message: firstLine(text, /error|failed/i) };
}

function firstLine(text, pattern) {
  return String(text).split("\n").map((line) => line.trim()).find((line) => pattern.test(line))?.slice(0, 300) ?? String(text).trim().split("\n").at(-1)?.slice(0, 300) ?? null;
}

// Reset time from the error text: an epoch, an ISO time, or "in N hours / minutes". Defaults to one hour.
export function resetTime(text, at = new Date().toISOString()) {
  const base = Date.parse(at);
  const epoch = String(text).match(/\|(\d{10})\b/) ?? String(text).match(/reset[^\d]{0,20}(\d{10})\b/i);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const iso = String(text).match(/(20\d\d-\d\d-\d\dT\d\d:\d\d(:\d\d)?(\.\d+)?(Z|[+-]\d\d:?\d\d))/);
  if (iso && Date.parse(iso[1]) > base) return new Date(Date.parse(iso[1])).toISOString();
  const relative = String(text).match(/(?:in|after)\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (relative) return new Date(base + Number(relative[1]) * (/^h/i.test(relative[2]) ? 3600000 : 60000)).toISOString();
  if (/5-hour/i.test(text)) return new Date(base + 60 * 60000).toISOString();
  return new Date(base + 60 * 60000).toISOString();
}
