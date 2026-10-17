// Agent-written strategies run outside the service process. Each sandbox is a separate Node process
// started with the permission model (no file reads or writes, no child processes, no workers) and an
// empty environment; inside it the code runs in a fresh vm context that only sees plain JavaScript
// built-ins and the ctx functions. Every data request (history, quotes, minute bars, scans) goes back
// to the parent over IPC, so the strategy sees exactly the verified market data the arena uses.
//
// The vm context is not a security boundary on its own; the OS-level process permissions are. The
// sandbox still has network access in Node 24, but no files, no secrets and no tools to use it with.

import { spawn } from "node:child_process";

export const STRATEGY_CODE_LIMIT = 60000;
const FORBIDDEN = [
  [/\bimport\s*[\s({*"']/, "不能 import 模块：策略只能用 ctx 提供的数据"],
  [/\brequire\s*\(/, "不能 require 模块"],
  [/\bprocess\b/, "不能访问 process"],
  [/\bglobalThis\b|\bwindow\b|\bself\b/, "不能访问全局对象"],
  [/\beval\s*\(|\bFunction\s*\(|\bconstructor\b/, "不能动态执行代码"],
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, "不能自己联网：用 ctx.history / ctx.quote / ctx.scan 拿数据"],
];

// Static checks before anything runs. Returns the transformed script or throws with a readable reason.
export function prepareStrategyCode(code) {
  const source = String(code ?? "");
  if (!source.trim()) throw new Error("策略代码是空的。");
  if (source.length > STRATEGY_CODE_LIMIT) throw new Error(`策略代码太长（最多 ${STRATEGY_CODE_LIMIT} 字符）。`);
  const exports = source.match(/\bexport\s+default\b/g) ?? [];
  if (exports.length !== 1) throw new Error("策略代码必须有且只有一个 export default { id, version, params, run(ctx) }。");
  for (const [pattern, reason] of FORBIDDEN) if (pattern.test(source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))) throw new Error(reason);
  return source.replace(/\bexport\s+default\b/, "var __strategy__ =");
}

// Child program: CommonJS so it runs from -e without reading any file.
const CHILD = String.raw`
const vm = require("node:vm");
let strategy = null;
let seq = 0;
const pending = new Map();
const send = (message) => process.send(message);
const call = (fn, args) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); send({ type: "call", id, fn, args }); });
const sma = (values, length) => values.length >= length ? values.slice(-length).reduce((sum, value) => sum + value, 0) / length : null;
process.on("message", async (message) => {
  if (message.type === "result") {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.value); else waiter.reject(new Error(message.error));
    return;
  }
  if (message.type === "load") {
    try {
      const context = vm.createContext({
        Math, Date, JSON, Number, String, Boolean, Array, Object, Map, Set, Promise, Error, RangeError, TypeError, isFinite, isNaN, parseFloat, parseInt,
        console: { log: (...parts) => send({ type: "log", message: parts.map(String).join(" ").slice(0, 500) }) },
      }, { codeGeneration: { strings: false, wasm: false } });
      vm.runInContext(message.code + "\n;this.__strategy__ = __strategy__;", context, { timeout: 2000, filename: "strategy.mjs" });
      strategy = context.__strategy__;
      if (!strategy || typeof strategy.run !== "function") throw new Error("策略必须 export default { id, run(ctx) }。");
      send({ type: "loaded", meta: JSON.parse(JSON.stringify({ id: strategy.id, name: strategy.name, version: strategy.version, description: strategy.description, markets: strategy.markets, params: strategy.params })) });
    } catch (error) { send({ type: "loaded", error: String(error && error.message || error) }); }
    return;
  }
  if (message.type === "run") {
    const spec = message.ctx;
    const ctx = {
      ...spec,
      history: (symbol, options) => call("history", [symbol, options]),
      quote: (symbol) => call("quote", [symbol]),
      intraday: (symbol) => call("intraday", [symbol]),
      scan: (options) => call("scan", [options]),
      sellable: (symbol) => (message.sellable || {})[symbol] || 0,
      log: (text) => send({ type: "log", message: String(text).slice(0, 500) }),
      indicators: { sma },
    };
    try {
      const output = await strategy.run(ctx);
      send({ type: "done", id: message.id, value: JSON.parse(JSON.stringify(output == null ? {} : output)) });
    } catch (error) { send({ type: "done", id: message.id, error: String(error && error.message || error) }); }
  }
});
`;

function permissionFlag() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13) ? "--permission" : "--experimental-permission";
}

// Start a sandbox for one piece of code. run() may be called many times (a backtest does).
export async function openSandbox(code, { loadTimeoutMs = 10000, onLog = () => {} } = {}) {
  const script = prepareStrategyCode(code);
  const child = spawn(process.execPath, [permissionFlag(), "--max-old-space-size=256", "-e", CHILD], { env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  let handlers = null;
  let finish = null;
  let closed = false;
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => { closed = true; resolve({ code, signal }); finish?.({ error: `策略进程退出了（${signal ?? code}）${stderr ? `：${stderr.trim().split("\n").at(-1)}` : ""}` }); }));
  child.on("message", async (message) => {
    if (message.type === "log") { onLog(message.message); return; }
    if (message.type === "done") { finish?.(message); return; }
    if (message.type === "call") {
      try {
        const fn = handlers?.[message.fn];
        if (typeof fn !== "function") throw new Error(`ctx.${message.fn} 不可用`);
        const value = await fn(...(message.args ?? []));
        if (!closed) child.send({ type: "result", id: message.id, ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
      } catch (error) { if (!closed) child.send({ type: "result", id: message.id, ok: false, error: error.message }); }
    }
  });
  const meta = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("加载策略超时。")); }, loadTimeoutMs);
    child.once("message", function first(message) {
      if (message.type !== "loaded") { child.once("message", first); return; }
      clearTimeout(timer);
      if (message.error) { child.kill("SIGKILL"); reject(new Error(`策略加载失败：${message.error}`)); } else resolve(message.meta);
    });
    child.send({ type: "load", code: script });
  });
  let runs = 0;
  return {
    meta,
    // ctxSpec: plain data (now, market, account, params, universe); calls: history / quote / intraday / scan.
    run(ctxSpec, calls, { timeoutMs = 60000, sellable = {} } = {}) {
      if (closed) return Promise.reject(new Error("策略进程已经关闭。"));
      handlers = calls;
      return new Promise((resolve, reject) => {
        const id = ++runs;
        const timer = setTimeout(() => { finish = null; child.kill("SIGKILL"); reject(new Error(`策略运行超过 ${Math.round(timeoutMs / 1000)} 秒，已强制结束。`)); }, timeoutMs);
        finish = (message) => {
          if (message.id !== undefined && message.id !== id) return;
          clearTimeout(timer);
          finish = null;
          if (message.error) reject(new Error(message.error)); else resolve(message.value);
        };
        child.send({ type: "run", id, ctx: JSON.parse(JSON.stringify(ctxSpec)), sellable });
      });
    },
    async close() { if (!closed) child.kill("SIGKILL"); await exited; },
  };
}

// A strategy object the regular runtime (runStrategyRound) can execute: one sandbox per round.
export function sandboxedStrategy({ id, code, meta = {}, market }) {
  return {
    id, name: meta.name ?? id, version: meta.version ?? "1.0.0", markets: market ? [market] : meta.markets ?? ["A", "HK", "US"],
    params: meta.params ?? {}, description: meta.description ?? "", origin: "agent",
    async run(ctx) {
      const logs = [];
      const sandbox = await openSandbox(code, { onLog: (message) => { logs.push(message); ctx.log(message); } });
      try {
        const sellable = Object.fromEntries((ctx.account.positions ?? []).map((position) => [position.symbol, ctx.sellable(position.symbol)]));
        return await sandbox.run({ now: ctx.now, market: ctx.market, account: ctx.account, params: ctx.params, universe: ctx.universe },
          { history: ctx.history, quote: ctx.quote, intraday: ctx.intraday, scan: ctx.scan }, { sellable });
      } finally { await sandbox.close(); }
    },
  };
}
