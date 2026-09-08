// Maintainer integration test. Requires a local Codex CLI; never registers OS jobs
// or writes the user's Codex configuration / real Market Pulse data.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createUpdater, resolveCodex, runCommand } from "./updater.mjs";
import { PROJECT, REPOSITORY, PLUGIN_ID, collectReleaseFiles, validateBundle, extractFiles, encodeBundle, sha256 } from "./release-format.mjs";
import { atomicJson, readJson, activeRuntimeLeases } from "../mcp/update-coordination.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(os.tmpdir(), "hrouter-native-updater-smoke-"));
const home = path.join(scratch, "managed"), codexHome = path.join(scratch, "codex");
const version = (await readJson(path.join(root, "package.json"))).version;
const nextVersion = version.split(".").map((n, i) => i === 2 ? Number(n) + 1 : n).join(".");
const codex = await resolveCodex(process.env.HROUTER_TEST_CODEX);
const jobs = [], calls = []; let failNextInstall = false, client, transport;
try {
  const candidate = path.join(scratch, "candidate"), files = await collectReleaseFiles(root);
  await extractFiles(validateBundle({ schemaVersion: 1, name: PROJECT, repository: REPOSITORY, version, files }, version), candidate);
  for (const relative of ["package.json", "package-lock.json", ".codex-plugin/plugin.json", `plugins/${PROJECT}/.codex-plugin/plugin.json`]) {
    const file = path.join(candidate, relative), value = await readJson(file);
    value.version = relative.endsWith("plugin.json") ? `${nextVersion}+codex.integration` : nextVersion;
    if (value.packages?.[""]) value.packages[""].version = nextVersion;
    await atomicJson(file, value);
  }
  await build({ entryPoints: [path.join(root, "mcp/server.mjs")], bundle: true, platform: "node", format: "esm", target: "node20", define: { __HROUTER_VERSION__: JSON.stringify(nextVersion) }, outfile: path.join(candidate, `plugins/${PROJECT}/mcp/server.bundle.mjs`) });
  const bundle = encodeBundle(nextVersion, await collectReleaseFiles(candidate));
  const base = `https://github.com/${REPOSITORY}/releases/download/v${nextVersion}/`, name = `${PROJECT}-${nextVersion}.bundle.json.gz`, metaName = `${PROJECT}-${nextVersion}.update.json`;
  const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, repository: REPOSITORY, version: nextVersion, bundle: { name, size: bundle.length, sha256: sha256(bundle) } }));
  const release = { tag_name: `v${nextVersion}`, draft: false, prerelease: false, assets: [[name, bundle], [metaName, metadata]].map(([name, bytes]) => ({ name, state: "uploaded", size: bytes.length, digest: `sha256:${sha256(bytes)}`, browser_download_url: base + name })) };
  const manager = createUpdater({ home, codex, env: { ...process.env, CODEX_HOME: codexHome },
    scheduler: async enabled => { jobs.push(enabled); return "integration-no-real-scheduler"; },
    run: async (command, args, options) => {
      if (args[0] === "plugin") calls.push(args);
      if (args[0] === "plugin" && args[1] === "add" && failNextInstall) { failNextInstall = false; throw new Error("injected native installation failure"); }
      return runCommand(command, args, options);
    },
    request: async url => {
      if (url.endsWith("/releases/latest")) return Buffer.from(JSON.stringify(release));
      if (url === base + metaName) return metadata;
      if (url === base + name) return bundle;
      throw new Error(`Unexpected network request: ${url}`);
    },
  });
  const data = path.join(scratch, "personal-preferences.json"); await writeFile(data, "preserve user data");
  const installed = await manager.execute("install", { root, automatic: true });
  assert.equal(installed.version, version);
  const nativeList = async () => JSON.parse(await runCommand(codex.command, [...codex.args, "plugin", "list", "--json"], { env: { ...process.env, CODEX_HOME: codexHome } }));
  const plugin = (await nativeList()).installed.find(p => p.pluginId === PLUGIN_ID);
  assert.ok(plugin.enabled);
  const cache = path.join(codexHome, "plugins/cache", PROJECT, PROJECT, plugin.version);
  const configuration = await readJson(path.join(cache, ".mcp.json"));
  assert.equal(configuration.mcpServers.hrouter_market_pulse.env.HROUTER_UPDATE_HOME, home);
  transport = new StdioClientTransport({ command: process.execPath, args: ["mcp/server.bundle.mjs", "--stdio"], cwd: cache, env: { ...process.env, ...configuration.mcpServers.hrouter_market_pulse.env, HROUTER_REPORT_DIR: path.join(scratch, "reports"), HROUTER_REPORT_PORT: "0", HROUTER_WATCHLIST: "" }, stderr: "pipe" });
  client = new Client({ name: "updater-native-smoke", version: "1.0.0" });
  await client.connect(transport);
  assert.equal((await activeRuntimeLeases(home)).length, 1);
  assert.equal((await manager.execute("check", { scheduled: true })).status, "staged-waiting-for-idle");
  assert.ok(await readFile(path.join(cache, "mcp/server.bundle.mjs")));
  await client.close(); await transport.close(); client = transport = null;
  assert.equal((await manager.execute("check", { scheduled: true })).status, "updated");
  assert.equal((await nativeList()).installed.find(p => p.pluginId === PLUGIN_ID).version, `${nextVersion}+codex.integration`);
  await assert.rejects(readFile(path.join(cache, "mcp/server.bundle.mjs")), { code: "ENOENT" });
  assert.equal((await manager.execute("rollback")).version, version);
  assert.equal((await manager.execute("status")).automatic, false);
  await manager.execute("enable"); failNextInstall = true;
  await assert.rejects(manager.execute("check"), /injected native installation failure/);
  assert.equal((await nativeList()).installed.find(p => p.pluginId === PLUGIN_ID).version.split("+")[0], version);
  assert.equal(await readFile(data, "utf8"), "preserve user data");
  assert.deepEqual((await readdir(path.join(codexHome, "plugins/cache", PROJECT, PROJECT))).length, 1);
  console.log(JSON.stringify({ status: "passed", codex: await runCommand(codex.command, [...codex.args, "--version"]), checks: ["isolated native plugin install", "isolated MCP/dashboard health", "runtime environment/lease", "active-session deferral", "native full-plugin upgrade", "manual rollback pauses updates", "failed installation recovery", "user data preserved", "no real OS jobs registered"], nativeCommands: calls.length, schedulerCallsIntercepted: jobs.length }, null, 2));
} finally {
  await client?.close(); await transport?.close();
  await rm(scratch, { recursive: true, force: true });
}
