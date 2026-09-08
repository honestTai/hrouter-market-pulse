import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { PROJECT, REPOSITORY, PLUGIN_ID, RELEASE_PATHS, collectReleaseFiles, validateBundle, encodeBundle, decodeBundle, safeRelativePath, compareVersions, sha256, releaseZip, extractFiles } from "../scripts/release-format.mjs";
import { createUpdater, latestUpdate, requestBytes } from "../scripts/updater.mjs";
import { schedulerPlan, windowsArg, configureScheduler } from "../scripts/update-scheduler.mjs";
import { updateHome, atomicJson, readJson, acquireLock, activeRuntimeLeases, acquireRuntimeLease } from "../mcp/update-coordination.mjs";

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hrouter-updater-test-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function fixture(root, version) {
  const directories = new Set([".agents", ".codex-plugin", "assets", "docs", "mcp", "plugins", "schemas", "scripts", "skills", "tests"]);
  for (const item of RELEASE_PATHS) {
    if (directories.has(item)) await mkdir(path.join(root, item), { recursive: true });
    else { await mkdir(root, { recursive: true }); await writeFile(path.join(root, item), "fixture\n"); }
  }
  const files = {
    "package.json": { name: PROJECT, version },
    "package-lock.json": { name: PROJECT, version },
    ".codex-plugin/plugin.json": { name: PROJECT, version: `${version}+codex.test` },
    [`plugins/${PROJECT}/.codex-plugin/plugin.json`]: { name: PROJECT, version: `${version}+codex.test` },
    ".agents/plugins/marketplace.json": { name: PROJECT, plugins: [{ name: PROJECT, source: { source: "local", path: `./plugins/${PROJECT}` } }] },
    ".mcp.json": { mcpServers: { hrouter_market_pulse: { command: "node", args: ["mcp/server.bundle.mjs"] } } },
    [`plugins/${PROJECT}/.mcp.json`]: { mcpServers: { hrouter_market_pulse: { command: "node", args: ["mcp/server.bundle.mjs"] } } },
  };
  for (const [name, data] of Object.entries(files)) await atomicJson(path.join(root, name), data);
  for (const name of ["scripts/install.mjs", "scripts/updater.mjs", "scripts/update-scheduler.mjs", "scripts/release-format.mjs", "mcp/update-coordination.mjs", `plugins/${PROJECT}/mcp/server.bundle.mjs`]) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), `// release ${version}\nexport {};\n`);
  }
  return root;
}
async function release(root, version) {
  const files = await collectReleaseFiles(await fixture(root, version));
  const bytes = encodeBundle(version, files), prefix = `https://github.com/${REPOSITORY}/releases/download/v${version}/`;
  const name = `${PROJECT}-${version}.bundle.json.gz`, metaName = `${PROJECT}-${version}.update.json`;
  const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, repository: REPOSITORY, version, bundle: { name, size: bytes.length, sha256: sha256(bytes) } }));
  const info = { tag_name: `v${version}`, prerelease: false, draft: false, assets: [[name, bytes], [metaName, metadata]].map(([name, data]) => ({ name, size: data.length, state: "uploaded", browser_download_url: prefix + name, digest: `sha256:${sha256(data)}` })) };
  let downloads = 0;
  return { files, bytes, metadata, info, downloads: () => downloads, request: async url => {
    if (url.endsWith("/releases/latest")) return Buffer.from(JSON.stringify(info));
    if (url === prefix + metaName) return metadata;
    if (url === prefix + name) { downloads++; return bytes; }
    throw new Error(`Unexpected URL: ${url}`);
  } };
}
function nativeCodex() {
  const state = { market: null, plugin: null, calls: [], failVersion: null, failOnce: true };
  const run = async (cmd, args) => {
    state.calls.push(args); const a = args.filter(a => a !== "--json");
    if (a[0] !== "plugin") throw new Error("Unexpected native command");
    if (a[1] === "list") return JSON.stringify({ installed: state.plugin ? [state.plugin] : [] });
    if (a[1] === "marketplace" && a[2] === "list") return JSON.stringify({ marketplaces: state.market ? [state.market] : [] });
    if (a[1] === "marketplace" && a[2] === "add") {
      if (state.market && state.market.root !== a[3]) throw new Error("Marketplace source collision");
      state.market = { name: PROJECT, root: a[3], marketplaceSource: { sourceType: "local", source: a[3] } };
      return JSON.stringify({ marketplaceName: PROJECT });
    }
    if (a[1] === "marketplace" && a[2] === "remove") { state.market = null; return "removed"; }
    if (a[1] === "remove") { state.plugin = null; return "removed"; }
    if (a[1] === "add") {
      const pkg = await readJson(path.join(state.market.root, "package.json"));
      if (state.failVersion === pkg.version && state.failOnce) { state.failOnce = false; throw new Error("simulated installation failure"); }
      const version = `${pkg.version}+codex.test`;
      state.plugin = { pluginId: PLUGIN_ID, version, installed: true, enabled: true, marketplaceSource: state.market.marketplaceSource };
      return JSON.stringify({ pluginId: PLUGIN_ID, version });
    }
    throw new Error(`Unexpected command: ${a.join(" ")}`);
  };
  return { state, run };
}
async function setup(t, { scheduler, health } = {}) {
  const root = await temporary(t), home = path.join(root, "managed"), local = await fixture(path.join(root, "source"), "1.2.0");
  const remote = await release(path.join(root, "remote"), "1.2.1"), native = nativeCodex();
  const schedules = [], healthChecks = [];
  const manager = createUpdater({ home, codex: { command: "fixture-codex", args: [] }, env: { CODEX_HOME: path.join(root, "codex") }, run: native.run, request: remote.request,
    scheduler: scheduler || (async enabled => { schedules.push(enabled); return "fixture-scheduler"; }),
    health: health || (async dir => { healthChecks.push(dir); }),
  });
  return { root, home, local, remote, native, schedules, healthChecks, manager };
}

test("release versions are numeric stable versions, never lexical or prerelease", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  for (const v of ["v1.2.3", "1.2.3-beta", "1.02.3", "../1.2.3", "1.2", "999999999999.0.0"]) assert.throws(() => compareVersions(v, "1.0.0"));
});
test("package paths reject traversal, platform aliases and Windows reserved names", () => {
  for (const p of ["../x", "/x", "a/../../x", "a\\b", "a//b", "C:x", "CON.txt", "x/nul", "x./a", "x ", "x\0y", "x:y"]) assert.throws(() => safeRelativePath(p));
  assert.equal(safeRelativePath("plugins/hrouter-market-pulse/assets/a.js"), "plugins/hrouter-market-pulse/assets/a.js");
});
test("release packages roundtrip and reject tampering before extraction", async t => {
  const root = await temporary(t), r = await release(path.join(root, "release"), "1.2.0");
  const meta = { version: "1.2.0", size: r.bytes.length, sha256: sha256(r.bytes) };
  const decoded = decodeBundle(r.bytes, meta); assert.ok(decoded.has("scripts/updater.mjs"));
  await extractFiles(decoded, path.join(root, "extracted"));
  assert.equal((await readJson(path.join(root, "extracted/package.json"))).version, "1.2.0");
  assert.throws(() => decodeBundle(Buffer.from("tampered"), meta), /checksum/);
  const mutated = structuredClone(r.files); mutated[0].data = Buffer.from("corrupt").toString("base64");
  assert.throws(() => validateBundle({ schemaVersion: 1, name: PROJECT, repository: REPOSITORY, version: "1.2.0", files: mutated }, "1.2.0"), /checksum/);
  for (const bad of ["../outside", r.files[0].path.toUpperCase(), `${r.files[0].path}/child`]) {
    const entries = [...r.files, { ...r.files[0], path: bad }];
    assert.throws(() => validateBundle({ schemaVersion: 1, name: PROJECT, repository: REPOSITORY, version: "1.2.0", files: entries }, "1.2.0"));
  }
  const zip = releaseZip(r.files); assert.equal(zip.readUInt32LE(0), 0x04034b50); assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
});
test("release lookup rejects partial, prerelease, wrong-origin and mismatched digests", async t => {
  const root = await temporary(t), r = await release(path.join(root, "release"), "1.2.1");
  assert.equal((await latestUpdate("1.2.0", r.request)).version, "1.2.1");
  assert.equal(await latestUpdate("1.3.0", r.request), null);
  r.info.prerelease = true; await assert.rejects(latestUpdate("1.2.0", r.request), /stable/); r.info.prerelease = false;
  r.info.assets[0].browser_download_url = "https://evil.example/bundle"; await assert.rejects(latestUpdate("1.2.0", r.request), /trusted/);
  r.info.assets[0].browser_download_url = `https://github.com/${REPOSITORY}/releases/download/v1.2.1/${PROJECT}-1.2.1.bundle.json.gz`;
  r.info.assets[0].digest = "sha256:" + "0".repeat(64); await assert.rejects(latestUpdate("1.2.0", r.request), /disagree/);
  r.info.assets = []; await assert.rejects(latestUpdate("1.2.0", r.request), /missing/);
});
test("network client rejects arbitrary hosts and unsafe redirects", async t => {
  await assert.rejects(requestBytes("http://github.com/a"), /untrusted/);
  await assert.rejects(requestBytes("https://127.0.0.1/a"), /untrusted/);
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 302, headers: { location: "https://evil.example/redirect" } }));
  await assert.rejects(requestBytes("https://github.com/a"), /untrusted/);
});
test("network failures and oversized bodies fail closed", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("bad", { status: 429 }));
  await assert.rejects(requestBytes("https://api.github.com/a"), /429/);
  globalThis.fetch = async () => new Response("12345");
  await assert.rejects(requestBytes("https://github.com/a", 4), /too large/);
});
test("managed install is opt-in and binds runtime leases to its installation", async t => {
  const s = await setup(t); await s.manager.execute("install", { root: s.local });
  const status = await s.manager.execute("status"); assert.equal(status.automatic, false); assert.equal(status.version, "1.2.0");
  const mcp = await readJson(path.join(s.home, `marketplace/plugins/${PROJECT}/.mcp.json`));
  assert.equal(mcp.mcpServers.hrouter_market_pulse.env.HROUTER_UPDATE_HOME, s.home);
  assert.equal((await s.manager.execute("check", { scheduled: true })).status, "disabled");
  assert.equal(s.remote.downloads(), 0);
});
test("opted-in users upgrade the complete plugin and can roll back without touching data", async t => {
  const s = await setup(t), data = path.join(s.root, "user-preferences.json"); await writeFile(data, "keep me");
  await s.manager.execute("install", { root: s.local, automatic: true });
  assert.equal((await s.manager.execute("check", { scheduled: true })).status, "updated");
  assert.equal(s.native.state.plugin.version, "1.2.1+codex.test");
  assert.equal((await readJson(path.join(s.home, "marketplace/package.json"))).version, "1.2.1");
  assert.equal((await readJson(path.join(s.home, "previous-marketplace/package.json"))).version, "1.2.0");
  const result = await s.manager.execute("rollback"); assert.equal(result.version, "1.2.0");
  assert.equal((await s.manager.execute("status")).automatic, false);
  assert.equal(await readFile(data, "utf8"), "keep me");
  assert.equal((await s.manager.execute("check", { scheduled: true })).status, "disabled");
});
test("active runtimes defer cache replacement; cached download applies when idle", async t => {
  const s = await setup(t); await s.manager.execute("install", { root: s.local, automatic: true });
  const releaseLease = await acquireRuntimeLease(s.home); t.after(releaseLease);
  assert.equal((await s.manager.execute("check", { scheduled: true })).status, "staged-waiting-for-idle");
  assert.equal(s.native.state.plugin.version, "1.2.0+codex.test");
  releaseLease(); assert.equal((await s.manager.execute("check", { scheduled: true })).status, "updated");
  assert.equal(s.remote.downloads(), 1);
});
test("native installation failure automatically restores previous code and configuration", async t => {
  const s = await setup(t); await s.manager.execute("install", { root: s.local, automatic: true });
  s.native.state.failVersion = "1.2.1";
  await assert.rejects(s.manager.execute("check"), /simulated installation failure/);
  assert.equal((await s.manager.execute("status")).version, "1.2.0");
  assert.equal((await readJson(path.join(s.home, "marketplace/package.json"))).version, "1.2.0");
  assert.equal(s.native.state.plugin.version, "1.2.0+codex.test");
  assert.equal(await readJson(path.join(s.home, "transaction.json")), null);
});
test("failed health checks leave the installed plugin intact", async t => {
  let fail = false; const s = await setup(t, { health: async () => { if (fail) throw new Error("unhealthy"); } });
  await s.manager.execute("install", { root: s.local, automatic: true }); fail = true;
  await assert.rejects(s.manager.execute("check"), /unhealthy/);
  assert.equal(s.native.state.plugin.version, "1.2.0+codex.test");
});
test("disabled, uninstalled and manually replaced plugins are never resurrected", async t => {
  const s = await setup(t); await s.manager.execute("install", { root: s.local, automatic: true });
  s.native.state.plugin.enabled = false;
  assert.match((await s.manager.execute("check")).status, /skipped/);
  s.native.state.plugin.enabled = true; s.native.state.plugin.version = "9.0.0";
  assert.match((await s.manager.execute("check")).status, /skipped/);
  s.native.state.plugin = null;
  assert.match((await s.manager.execute("check")).status, /skipped/); assert.equal(s.remote.downloads(), 0);
});
test("existing installations require explicit migration", async t => {
  const s = await setup(t), old = await fixture(path.join(s.root, "old-marketplace"), "1.2.0");
  s.native.state.market = { name: PROJECT, root: old, marketplaceSource: { sourceType: "local", source: old } };
  await assert.rejects(s.manager.execute("install", { root: s.local }), /--migrate/);
  assert.equal(s.native.state.market.root, old);
  await s.manager.execute("install", { root: s.local, migrate: true });
  assert.equal(s.native.state.market.root, path.join(s.home, "marketplace"));
});
test("scheduler failures are visible and never falsely enable automatic updates", async t => {
  const s = await setup(t, { scheduler: async enabled => { if (enabled) throw new Error("scheduler unavailable"); return "fixture"; } });
  await assert.rejects(s.manager.execute("install", { root: s.local, automatic: true }), /scheduler unavailable/);
  assert.equal((await s.manager.execute("status")).automatic, false);
  assert.equal(s.native.state.plugin.version, "1.2.0+codex.test");
});
test("interrupted activation rolls back on the next invocation", async t => {
  const s = await setup(t); await s.manager.execute("install", { root: s.local });
  const oldState = await readJson(path.join(s.home, "state.json"));
  await rename(path.join(s.home, "marketplace"), path.join(s.home, "transaction-backup"));
  await cp(path.join(s.root, "remote"), path.join(s.home, "marketplace"), { recursive: true });
  const nextState = { ...oldState, version: "1.2.1" };
  await atomicJson(path.join(s.home, "state.json"), nextState);
  await atomicJson(path.join(s.home, "transaction.json"), { hadCurrent: true, committed: false, previousState: oldState, nextState });
  assert.equal((await s.manager.execute("check", { scheduled: true })).status, "disabled");
  assert.equal((await s.manager.execute("status")).version, "1.2.0");
});
test("locks serialize jobs and dead process leases are removed", async t => {
  const root = await temporary(t), unlock = await acquireLock(root, "job");
  assert.equal(await acquireLock(root, "job"), null); await unlock();
  await atomicJson(path.join(root, "job.lock/owner.json"), { pid: 2147483647 });
  const unlockStale = await acquireLock(root, "job", { alive: () => false }); assert.ok(unlockStale); await unlockStale();
  await atomicJson(path.join(root, "running/dead.json"), { pid: 2147483647 });
  assert.deepEqual(await activeRuntimeLeases(root, () => false), []);
});
test("runtime startup waits for activation instead of racing cache deletion", async t => {
  const root = await temporary(t); await atomicJson(path.join(root, "state.json"), { schemaVersion: 1 });
  const unlock = await acquireLock(root, "activation"); let acquired = false;
  const waiting = acquireRuntimeLease(root).then(release => { acquired = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(acquired, false);
  await unlock(); (await waiting)();
});
test("per-user schedulers use fixed executable arguments, escaped paths and no elevation", () => {
  const common = { home: path.join(os.tmpdir(), "user &'$%name"), updateDir: path.join(os.tmpdir(), "update &'$%home"), node: path.join(os.tmpdir(), "node executable"), uid: 501 };
  const mac = schedulerPlan({ ...common, platform: "darwin" });
  assert.match(mac.files[0].content, /<integer>21600<\/integer>/); assert.match(mac.files[0].content, /&amp;/); assert.match(mac.files[0].content, /runner.mjs/);
  const linux = schedulerPlan({ ...common, platform: "linux" });
  assert.match(linux.files[0].content, /%%/); assert.match(linux.files[1].content, /Persistent=true/);
  const win = schedulerPlan({ ...common, platform: "win32" });
  assert.match(win.enable[0][1].at(-1), /RunLevel Limited/); assert.match(win.enable[0][1].at(-1), /LogonType Interactive/); assert.match(win.enable[0][1].at(-1), /Hours 6/);
  assert.doesNotMatch(JSON.stringify([mac, linux, win]), /sudo|RunLevel Highest|Set-ExecutionPolicy/);
  assert.equal(windowsArg('C:\\path with spaces\\'), '"C:\\path with spaces\\\\"');
  assert.throws(() => schedulerPlan({ ...common, platform: "darwin", node: "bad\npath" }));
});
test("scheduler errors remove partial registrations and written files", async t => {
  const root = await temporary(t), commands = [];
  await assert.rejects(configureScheduler({ platform: "darwin", home: root, updateDir: path.join(root, "updates"), uid: 501 }, true, async (cmd, args) => {
    commands.push(args); if (args[0] === "bootstrap") throw new Error("no GUI session");
  }), /automatic scheduling failed/);
  assert.equal(commands.filter(args => args[0] === "bootout").length, 2);
  await assert.rejects(readFile(path.join(root, "Library/LaunchAgents/net.hrouter.market-pulse.update.plist")), { code: "ENOENT" });
});
test("storage paths are user-scoped and configurable without touching report data", () => {
  assert.equal(updateHome({}, "darwin", path.resolve("example-user")), path.join(path.resolve("example-user"), ".local", "share", "hrouter-market-pulse-updater"));
  assert.equal(updateHome({ HROUTER_UPDATE_HOME: os.tmpdir() }), path.resolve(os.tmpdir()));
});

test("a corrupt staged download is rejected before candidate execution and is retried later", async t => {
  const s = await setup(t); await s.manager.execute("install", { root: s.local, automatic: true });
  const releaseLease = await acquireRuntimeLease(s.home); t.after(releaseLease);
  await s.manager.execute("check");
  await writeFile(path.join(s.home, "pending.bundle.json.gz"), "corrupted cached package");
  const before = s.healthChecks.length;
  await assert.rejects(s.manager.execute("check"), /checksum/);
  assert.equal(s.healthChecks.length, before);
  assert.equal((await s.manager.execute("status")).version, "1.2.0");
  releaseLease(); assert.equal((await s.manager.execute("check")).status, "updated");
  assert.equal(s.remote.downloads(), 2);
});
test("simultaneous stale-lock cleaners cannot delete another contender's fresh lock", async t => {
  const root = await temporary(t);
  for (let i = 0; i < 10; i++) {
    await atomicJson(path.join(root, "job.lock/owner.json"), { pid: 2147483647 });
    const locks = (await Promise.all(Array.from({ length: 8 }, () => acquireLock(root, "job")))).filter(Boolean);
    assert.equal(locks.length, 1); await locks[0]();
  }
});
test("an initial install failure cleans up only its own marketplace", async t => {
  const s = await setup(t); s.native.state.failVersion = "1.2.0";
  await assert.rejects(s.manager.execute("install", { root: s.local }), /simulated installation failure/);
  assert.equal(s.native.state.market, null); assert.equal(s.native.state.plugin, null);
  assert.equal((await s.manager.execute("status")).status, "not-installed");
});
test("Git migration preserves pinned refs and refuses unsupported config instead of guessing", async t => {
  const { captureGitSource } = await import("../scripts/updater.mjs");
  const root = await temporary(t), source = { name: PROJECT, marketplaceSource: { sourceType: "git", source: `https://github.com/${REPOSITORY}.git` } };
  await writeFile(path.join(root, "config.toml"), `[marketplaces.hrouter-market-pulse]\nsource_type = "git"\nsource = "${source.marketplaceSource.source}"\nref = "release-pinned"\n[other]\nanything = true\n`);
  assert.equal((await captureGitSource(source, root)).marketplaceSource.ref, "release-pinned");
  await writeFile(path.join(root, "config.toml"), `[marketplaces.hrouter-market-pulse]\nsource_type = "git"\nsource = "${source.marketplaceSource.source}"\nsparse_paths = ["plugins"]\n`);
  await assert.rejects(captureGitSource(source, root), /safely preserve/);
});
