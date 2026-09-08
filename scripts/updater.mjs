#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rename, rm, stat, access, mkdtemp, appendFile } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateHome, readJson, atomicJson, acquireLock, activeRuntimeLeases } from "../mcp/update-coordination.mjs";
import { PROJECT, REPOSITORY, MARKETPLACE, PLUGIN_ID, MAX_DOWNLOAD, stableVersion, compareVersions, collectReleaseFiles, validateBundle, decodeBundle, extractFiles, sha256 } from "./release-format.mjs";
import { configureScheduler } from "./update-scheduler.mjs";

const exec = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

export function canonicalPath(input) {
  let parent = path.resolve(input); const suffix = [];
  for (;;) {
    try {
      const resolved = path.join(realpathSync.native(parent), ...suffix);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if (error.code !== "ENOENT" || path.dirname(parent) === parent) throw error;
      suffix.unshift(path.basename(parent)); parent = path.dirname(parent);
    }
  }
}

// Codex's marketplace-list JSON omits pinned refs. Read only the CLI-generated
// table before migration; never rewrite config.toml or guess an unsupported form.
export async function captureGitSource(marketplace, codexHome) {
  if (marketplace?.marketplaceSource?.sourceType !== "git") return marketplace;
  const text = await readFile(path.join(codexHome, "config.toml"), "utf8");
  const lines = text.split(/\r?\n/), header = /^\[marketplaces\.(?:hrouter-market-pulse|"hrouter-market-pulse"|'hrouter-market-pulse')\]\s*(?:#.*)?$/;
  const start = lines.findIndex(line => header.test(line.trim()));
  const unsupported = () => new Error("Cannot safely preserve this Git marketplace configuration. Keep a copy of its source/ref, remove the marketplace explicitly with Codex, then run the installer again.");
  if (start < 0) throw unsupported();
  const values = {};
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim(); if (trimmed.startsWith("[")) break;
    if (!trimmed || trimmed.startsWith("#")) continue;
    const entry = /^(source_type|source|ref)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/.exec(trimmed);
    if (!entry) throw unsupported();
    const raw = entry[2]; values[entry[1]] = raw.startsWith("'") ? raw.slice(1, -1) : JSON.parse(raw);
  }
  if (values.source_type !== "git" || values.source !== marketplace.marketplaceSource.source) throw unsupported();
  return { ...marketplace, marketplaceSource: { ...marketplace.marketplaceSource, ...(values.ref ? { ref: values.ref } : {}) } };
}

export async function runCommand(command, args, options = {}) {
  try {
    const result = await exec(command, args, { timeout: 90_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options });
    return result.stdout.trim();
  } catch (error) {
    if (options.allowFailure) return "";
    throw new Error(`${path.basename(command)} failed: ${String(error.stderr || error.message).slice(0, 4000)}`, { cause: error });
  }
}

export async function resolveCodex(explicit, env = process.env, platform = process.platform) {
  const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex.ps1", "codex"] : ["codex"];
  const candidates = explicit ? [path.resolve(explicit)] : (env.PATH || "").split(path.delimiter).filter(Boolean).flatMap(dir => names.map(name => path.join(dir, name)));
  if (!explicit && platform === "darwin") candidates.push("/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex");
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (/\.(cmd|ps1)$/i.test(candidate)) {
        // Invoke the official npm JS entry, never pass a shell shim through cmd /c.
        const entry = path.join(path.dirname(candidate), "node_modules", "@openai", "codex", "bin", "codex.js");
        await access(entry, constants.R_OK);
        return { command: process.execPath, args: [entry] };
      }
      return platform === "win32" && /\.m?js$/i.test(candidate) ? { command: process.execPath, args: [candidate] } : { command: candidate, args: [] };
    } catch { /* Try the next PATH entry. */ }
  }
  throw new Error("Codex CLI with plugin support was not found. Add codex to PATH or pass --codex /absolute/path/to/codex.");
}

export async function requestBytes(input, limit = MAX_DOWNLOAD) {
  let url = new URL(input);
  const allowed = new Set(["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
  const signal = AbortSignal.timeout(30_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !allowed.has(url.hostname)) throw new Error("Refusing an untrusted update URL");
    const response = await fetch(url, { redirect: "manual", signal, headers: { "User-Agent": "Hrouter-Market-Pulse-Updater", Accept: url.hostname === "api.github.com" ? "application/vnd.github+json" : "application/octet-stream" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Update redirect has no destination");
      url = new URL(location, url); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub update request failed (HTTP ${response.status}); the installed version is unchanged.`); }
    if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Update response is too large"); }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error("Update response is too large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Too many update redirects");
}

export async function latestUpdate(currentVersion, request = requestBytes) {
  const release = JSON.parse((await request(API, 2 * 1024 * 1024)).toString("utf8"));
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== "string" || !release.tag_name.startsWith("v")) throw new Error("The release is not a published stable version");
  const version = stableVersion(release.tag_name.slice(1));
  if (compareVersions(version, currentVersion) <= 0) return null;
  const prefix = `https://github.com/${REPOSITORY}/releases/download/v${version}/`;
  const metadataName = `${PROJECT}-${version}.update.json`, bundleName = `${PROJECT}-${version}.bundle.json.gz`;
  const asset = name => {
    const matches = release.assets?.filter(a => a.name === name);
    if (matches?.length !== 1 || matches[0].browser_download_url !== prefix + name || matches[0].state !== "uploaded") throw new Error(`Release v${version} is missing a complete, trusted ${name} asset`);
    return matches[0];
  };
  const metadataAsset = asset(metadataName), bundleAsset = asset(bundleName);
  const bytes = await request(metadataAsset.browser_download_url, 64 * 1024);
  if (metadataAsset.digest && metadataAsset.digest !== `sha256:${sha256(bytes)}`) throw new Error("Release metadata digest mismatch");
  const metadata = JSON.parse(bytes.toString("utf8"));
  if (metadata.schemaVersion !== 1 || metadata.repository !== REPOSITORY || metadata.version !== version || metadata.bundle?.name !== bundleName || !/^[a-f0-9]{64}$/.test(metadata.bundle.sha256) || !Number.isSafeInteger(metadata.bundle.size) || metadata.bundle.size < 1 || metadata.bundle.size > MAX_DOWNLOAD || metadata.bundle.size !== bundleAsset.size)
    throw new Error("Invalid update metadata");
  if (bundleAsset.digest && bundleAsset.digest !== `sha256:${metadata.bundle.sha256}`) throw new Error("GitHub asset digest and update metadata disagree");
  return { version, ...metadata.bundle, url: bundleAsset.browser_download_url };
}

export async function verifyHealth(root, run = runCommand) {
  const expectedVersion = (await readJson(path.join(root, "package.json"))).version;
  for (const file of ["scripts/updater.mjs", "scripts/release-format.mjs", "scripts/update-scheduler.mjs", "mcp/update-coordination.mjs", `plugins/${PROJECT}/mcp/server.bundle.mjs`]) await run(process.execPath, ["--check", path.join(root, file)]);
  const isolated = await mkdtemp(path.join(os.tmpdir(), "hrouter-update-health-"));
  const child = spawn(process.execPath, ["mcp/server.bundle.mjs", "--stdio"], { cwd: path.join(root, "plugins", PROJECT), env: { ...process.env, HROUTER_REPORT_DIR: path.join(isolated, "reports"), HROUTER_UPDATE_HOME: path.join(isolated, "updater"), HROUTER_REPORT_PORT: "0", HROUTER_WATCHLIST: "" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let timer, stderr = "", buffer = "", settled = false;
  const exited = new Promise(resolve => child.once("close", resolve));
  try {
    await new Promise((resolve, reject) => {
      const fail = error => { if (!settled) { settled = true; reject(error); } };
      timer = setTimeout(() => fail(new Error("New plugin failed its MCP startup check")), 20_000);
      child.once("error", fail);
      child.once("exit", code => fail(new Error(`New plugin exited during health check (${code}): ${stderr}`)));
      child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString()).slice(-2000); });
      const send = object => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...object }) + "\n");
      child.stdin.on("error", fail);
      child.stdout.on("data", async chunk => {
        buffer += chunk.toString();
        if (buffer.length > 2 * 1024 * 1024) return fail(new Error("Excessive MCP health-check output"));
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.error) throw new Error("MCP health check returned an error");
            if (msg.id === 1) {
              if (msg.result?.serverInfo?.name !== PROJECT || msg.result.serverInfo.version !== expectedVersion) throw new Error("MCP identity/version does not match the release");
              send({ method: "notifications/initialized" }); send({ id: 2, method: "tools/list", params: {} });
            } else if (msg.id === 2) {
              if (!["get_quote", "get_preferences", "calculate_position_budget"].every(name => msg.result?.tools?.some(t => t.name === name))) throw new Error("Required MCP tools are missing");
              send({ id: 3, method: "tools/call", params: { name: "get_preferences", arguments: {} } });
            } else if (msg.id === 3) {
              const port = msg.result?.structuredContent?.reportPort;
              if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid dashboard port");
              for (const route of ["/health", "/", "/assets/dashboard.js", "/assets/vendor/lightweight-charts.js"]) {
                const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(5000) });
                await response.body?.cancel();
                if (!response.ok) throw new Error(`Dashboard health check failed: ${route}`);
              }
              if (!settled) { settled = true; resolve(); }
            }
          } catch (error) { fail(error); }
        }
      });
      send({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "market-pulse-updater", version: "1.0.0" } } });
    });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited; clearTimeout(force);
    await rm(isolated, { recursive: true, force: true });
  }
}

export function createUpdater(options = {}) {
  const env = options.env || process.env, home = path.resolve(options.home || updateHome(env));
  const run = options.run || runCommand, request = options.request || requestBytes;
  const health = options.health || (root => verifyHealth(root, run));
  const scheduler = options.scheduler || ((enabled, state) => configureScheduler({ updateDir: home, codexHome: state.codexHome }, enabled, run));
  const stateFile = path.join(home, "state.json"), currentDir = path.join(home, "marketplace"), previousDir = path.join(home, "previous-marketplace"), backupDir = path.join(home, "transaction-backup"), journalFile = path.join(home, "transaction.json");
  const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
  const load = async () => {
    const state = await readJson(stateFile);
    if (state && state.schemaVersion !== 1) throw new Error("Unsupported updater state schema; refusing to change this installation");
    return state;
  };
  const save = state => atomicJson(stateFile, state);
  const codex = async (state, args) => JSON.parse(await run(state.codex.command, [...state.codex.args, ...args, "--json"], { env: { ...env, CODEX_HOME: state.codexHome }, cwd: home }));
  const native = async (state, args) => run(state.codex.command, [...state.codex.args, ...args], { env: { ...env, CODEX_HOME: state.codexHome }, cwd: home });
  const installed = async state => (await codex(state, ["plugin", "list"])).installed?.find(p => p.pluginId === PLUGIN_ID);
  const source = async state => (await codex(state, ["plugin", "marketplace", "list"])).marketplaces?.find(m => m.name === MARKETPLACE);
  const isManaged = item => item?.marketplaceSource?.sourceType === "local" && canonicalPath(item.marketplaceSource.source) === canonicalPath(currentDir);
  const addSource = async (state, old) => {
    const info = old.marketplaceSource;
    if (!info?.source) throw new Error("Cannot restore the previous marketplace source automatically");
    const args = ["plugin", "marketplace", "add", info.source];
    if (info.ref) args.push("--ref", info.ref);
    if (info.sparsePaths?.length) for (const sparse of info.sparsePaths) args.push("--sparse", sparse);
    await codex(state, args);
  };

  async function finishCommit(journal) {
    if (await exists(backupDir)) {
      await rm(previousDir, { recursive: true, force: true });
      await rename(backupDir, previousDir);
    }
    await rm(journalFile, { force: true });
  }
  async function recoverLocked(journal) {
    if (journal.committed) { await finishCommit(journal); return; }
    const state = journal.nextState;
    if (await exists(backupDir)) {
      await rm(currentDir, { recursive: true, force: true }); await rename(backupDir, currentDir);
    } else if (!journal.hadCurrent) await rm(currentDir, { recursive: true, force: true });
    if (journal.hadCurrent) {
      await codex(state, ["plugin", "marketplace", "add", currentDir]);
      await codex(state, ["plugin", "add", PLUGIN_ID]);
    } else {
      const configured = await source(state);
      if (isManaged(configured)) {
        if (isManaged(await installed(state))) await native(state, ["plugin", "remove", PLUGIN_ID]);
        await native(state, ["plugin", "marketplace", "remove", MARKETPLACE]);
      }
      if (journal.oldSource && !(await source(state))) {
        await addSource(state, journal.oldSource);
        if (journal.oldInstalled) await codex(state, ["plugin", "add", PLUGIN_ID]);
      }
    }
    if (journal.previousState) await save(journal.previousState);
    else await rm(stateFile, { force: true });
    await rm(journalFile, { force: true });
  }
  async function recover() {
    const journal = await readJson(journalFile);
    if (!journal) return;
    const unlock = await acquireLock(home, "activation");
    if (!unlock) throw new Error("An interrupted update is waiting for the activation lock");
    try {
      if ((await activeRuntimeLeases(home)).length) throw new Error("Close Market Pulse tasks to recover an interrupted update");
      await recoverLocked(journal);
    } finally { await unlock(); }
  }
  async function activate(stage, version, state, { oldSource = null, oldInstalled = false, explicit = false } = {}) {
    const unlock = await acquireLock(home, "activation");
    if (!unlock) return false;
    try {
      if ((await activeRuntimeLeases(home)).length) return false;
      if (!explicit) {
        const plugin = await installed(state);
        if (!plugin?.enabled || !isManaged(plugin)) return false;
      }
      const previousState = await load(), hadCurrent = await exists(currentDir);
      const nextState = { ...state, version, previousVersion: previousState?.version || null, pending: null, lastError: null, updatedAt: new Date().toISOString() };
      const journal = { schemaVersion: 1, hadCurrent, previousState, nextState, oldSource, oldInstalled, committed: false };
      await atomicJson(journalFile, journal);
      try {
        if (hadCurrent) await rename(currentDir, backupDir);
        await rename(stage, currentDir);
        // A newly started runtime sees state and waits on our activation lock.
        await save(nextState);
        if (oldSource && !isManaged(oldSource)) await native(state, ["plugin", "marketplace", "remove", MARKETPLACE]);
        await codex(nextState, ["plugin", "marketplace", "add", currentDir]);
        const result = await codex(nextState, ["plugin", "add", PLUGIN_ID]);
        if (result.pluginId !== PLUGIN_ID || result.version?.split("+")[0] !== version) throw new Error("Codex did not install the expected plugin version");
        journal.committed = true; await atomicJson(journalFile, journal);
      } catch (error) {
        try { await recoverLocked(journal); }
        catch (recoveryError) { throw new Error(`${error.message}; rollback needs attention: ${recoveryError.message}`, { cause: error }); }
        throw error;
      }
      await finishCommit(journal);
      return true;
    } finally { await unlock(); }
  }
  async function stageFiles(files) {
    const stage = path.join(home, `stage-${randomUUID()}`);
    try {
      await extractFiles(files, stage);
      // Bind runtime leases to this managed installation, including custom update homes.
      for (const relative of [".mcp.json", `plugins/${PROJECT}/.mcp.json`]) {
        const file = path.join(stage, relative), mcp = await readJson(file);
        const server = mcp?.mcpServers?.hrouter_market_pulse;
        if (!server) throw new Error("Missing Market Pulse MCP server configuration");
        server.env = { ...server.env, HROUTER_UPDATE_HOME: home };
        server.env_vars = (server.env_vars || []).filter(name => name !== "HROUTER_UPDATE_HOME");
        await atomicJson(file, mcp);
      }
      await health(stage); return stage;
    }
    catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
  }
  const safeStage = stage => typeof stage === "string" && path.dirname(stage) === home && /^stage-[a-f0-9-]{36}$/.test(path.basename(stage));
  async function bootstrap() {
    const contents = `// Stable recovery entry point; never stored inside the switched marketplace.\nimport { access } from 'node:fs/promises';\nimport path from 'node:path';\nimport { fileURLToPath, pathToFileURL } from 'node:url';\nconst home=path.dirname(fileURLToPath(import.meta.url));\nlet entry;\nfor(const name of ['marketplace','transaction-backup','previous-marketplace']){const candidate=path.join(home,name,'scripts','updater.mjs');try{await access(candidate);entry=candidate;break;}catch{}}\nif(!entry)throw new Error('No updater package remains. Re-run the release installer.');\nconst { main }=await import(pathToFileURL(entry).href);\nawait main([...process.argv.slice(2),'--update-home',home]);\n`;
    const temp = path.join(home, `runner-${randomUUID()}.tmp`);
    await writeFile(temp, contents, { mode: 0o600 }); await rename(temp, path.join(home, "runner.mjs"));
  }
  async function setAutomatic(enabled) {
    const state = await load(); if (!state) throw new Error("Install the managed plugin first");
    state.automatic = false; await save(state);
    if (enabled) await bootstrap();
    try { if (enabled || state.scheduler) state.scheduler = await scheduler(enabled, state); state.automatic = enabled; state.lastError = null; }
    catch (error) { state.lastError = error.message; await save(state); throw error; }
    await save(state);
    return { status: enabled ? "automatic-updates-enabled" : "automatic-updates-disabled", version: state.version, intervalHours: 6 };
  }

  async function install({ root = sourceRoot, automatic = false, migrate = false, codexPath } = {}) {
    let state = await load();
    const command = state?.codex || options.codex || await resolveCodex(codexPath, env);
    const initial = state || { schemaVersion: 1, automatic: false, codex: command, codexHome: path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex")) };
    await mkdir(initial.codexHome, { recursive: true, mode: 0o700 });
    let oldSource = await source(initial);
    const oldInstalled = await installed(initial);
    if (oldSource && !isManaged(oldSource) && !migrate) throw new Error("An existing non-managed marketplace was found. Close its Market Pulse tasks, then re-run with --migrate to explicitly switch installation methods.");
    if (oldSource && !isManaged(oldSource) && !oldSource.marketplaceSource?.source) throw new Error("This marketplace source cannot be migrated safely. Remove it explicitly with Codex first.");
    oldSource = await captureGitSource(oldSource, initial.codexHome);
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const version = stableVersion(pkg.version);
    if (state && compareVersions(version, state.version) < 0) throw new Error("Installer refuses a downgrade; use rollback explicitly");
    const files = validateBundle({ schemaVersion: 1, name: PROJECT, repository: REPOSITORY, version, files: await collectReleaseFiles(root) }, version);
    const stage = await stageFiles(files);
    try {
      if (!(await activate(stage, version, initial, { oldSource, oldInstalled: Boolean(oldInstalled?.installed), explicit: true }))) throw new Error("Close running Market Pulse tasks before installing; no existing version was changed");
    } finally { await rm(stage, { recursive: true, force: true }); }
    await bootstrap();
    await setAutomatic(automatic);
    return { status: "installed", version, automatic, nextStep: "Start a new Codex task and select Hrouter Market Pulse." };
  }

  async function check({ scheduled = false } = {}) {
    let state = await load(); if (!state) throw new Error("No managed installation. Run scripts/install.mjs first.");
    if (scheduled && !state.automatic) return { status: "disabled", version: state.version };
    const plugin = await installed(state);
    if (!plugin?.installed || !plugin.enabled || !isManaged(plugin) || plugin.version?.split("+")[0] !== state.version) return { status: "skipped-disabled-uninstalled-or-source-changed", version: state.version };
    state.lastCheck = new Date().toISOString(); await save(state);
    const update = await latestUpdate(state.version, request);
    if (!update) {
      if (state.pending && safeStage(state.pending.directory)) await rm(state.pending.directory, { recursive: true, force: true });
      await rm(path.join(home, "pending.bundle.json.gz"), { force: true });
      state.pending = null; state.lastError = null; await save(state);
      return { status: "up-to-date", version: state.version };
    }
    const cachedBundle = path.join(home, "pending.bundle.json.gz");
    let bytes;
    if (state.pending?.version === update.version && state.pending.sha256 === update.sha256 && await exists(cachedBundle)) {
      bytes = await readFile(cachedBundle);
    } else {
      bytes = await request(update.url, MAX_DOWNLOAD);
    }
    // Revalidate cached bytes before executing any candidate code on every retry.
    let verified;
    try { verified = decodeBundle(bytes, update); }
    catch (error) { await rm(cachedBundle, { force: true }); throw error; }
    const stage = await stageFiles(verified);
    const bundleTemp = `${cachedBundle}.${randomUUID()}.tmp`;
    try { await writeFile(bundleTemp, bytes, { mode: 0o600 }); await rename(bundleTemp, cachedBundle); }
    finally { await rm(bundleTemp, { force: true }); }
    if (state.pending && safeStage(state.pending.directory)) await rm(state.pending.directory, { recursive: true, force: true });
    state.pending = { version: update.version, sha256: update.sha256, directory: stage };
    state.lastError = null; await save(state);
    if (!(await activate(stage, update.version, state))) return { status: "staged-waiting-for-idle", version: state.version, pendingVersion: update.version };
    await rm(cachedBundle, { force: true });
    return { status: "updated", previousVersion: state.version, version: update.version, nextStep: "New Codex tasks will load the update." };
  }

  async function rollback() {
    let state = await load(); if (!state?.previousVersion || !(await exists(previousDir))) throw new Error("No previous managed version is available");
    // Explicit rollback pauses automatic upgrades so the next timer cannot undo it.
    await setAutomatic(false); state = await load();
    const pkg = JSON.parse(await readFile(path.join(previousDir, "package.json"), "utf8"));
    const files = validateBundle({ schemaVersion: 1, name: PROJECT, repository: REPOSITORY, version: pkg.version, files: await collectReleaseFiles(previousDir) }, pkg.version);
    const stage = await stageFiles(files);
    try { if (!(await activate(stage, pkg.version, state, { explicit: true }))) throw new Error("Close running Market Pulse tasks before rollback"); }
    finally { await rm(stage, { recursive: true, force: true }); }
    return { status: "rolled-back", version: pkg.version, automatic: false };
  }

  async function execute(command, args = {}) {
    if (command === "status") {
      const state = await load();
      return { status: state ? "installed" : "not-installed", home, ...state, activeRuntimes: (await activeRuntimeLeases(home)).length, recoveryPending: await exists(journalFile) };
    }
    const unlock = await acquireLock(home, "job");
    if (!unlock) return { status: "busy" };
    try {
      await recover();
      if (command === "install") return await install(args);
      if (command === "check") return await check(args);
      if (command === "enable" || command === "disable") return await setAutomatic(command === "enable");
      if (command === "rollback") return await rollback();
      throw new Error(`Unknown updater command: ${command}`);
    } catch (error) {
      const state = await load();
      if (state) { state.lastError = error.message; await save(state); }
      throw error;
    } finally { await unlock(); }
  }
  return { execute, home };
}

export async function main(argv = process.argv.slice(2)) {
  const [command = "help", ...args] = argv;
  if (["help", "--help", "-h"].includes(command)) {
    console.log(`Hrouter Market Pulse managed installer/updater\n\nnode scripts/install.mjs [--auto-update] [--migrate] [--codex /path/to/codex]\nnode scripts/updater.mjs status|check|enable|disable|rollback\n\nAuto-updates are opt-in, check stable GitHub Releases every six hours, and wait for running Market Pulse processes to exit before replacing Codex's cache. No sudo or system-wide installs. Use a new Codex task after an update.\n`);
    return;
  }
  let home, codexPath, automatic = false, scheduled = false, migrate = false;
  try {
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === "--auto-update" && command === "install") automatic = true;
      else if (flag === "--migrate" && command === "install") migrate = true;
      else if (flag === "--scheduled" && command === "check") scheduled = true;
      else if (["--update-home", "--codex"].includes(flag)) {
        const value = args[++i]; if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
        if (flag === "--update-home") home = value; else codexPath = value;
      } else throw new Error(`Unknown option: ${flag}`);
    }
    if (!['install', 'check', 'status', 'enable', 'disable', 'rollback'].includes(command)) throw new Error(`Unknown updater command: ${command}`);
    const updater = createUpdater({ home });
    if (codexPath) codexPath = path.resolve(codexPath);
    // Windows cannot rename a directory used as this process's current directory.
    // The stable runner works even when invoked from a managed package directory.
    const cwd = canonicalPath(process.cwd()), managed = canonicalPath(updater.home);
    if (cwd === managed || cwd.startsWith(managed + path.sep)) process.chdir(os.homedir());
    const result = await updater.execute(command, { automatic, migrate, codexPath, scheduled });
    if (scheduled) await logScheduled(updater.home, result);
    else console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = { status: "error", message: error.message };
    if (scheduled) await logScheduled(path.resolve(home || updateHome()), result);
    else console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
}

async function logScheduled(home, result) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "updates.log");
  try { if ((await stat(file)).size > 1024 * 1024) await rename(file, file + ".1"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await appendFile(file, JSON.stringify({ time: new Date().toISOString(), ...result }) + "\n", { mode: 0o600 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
