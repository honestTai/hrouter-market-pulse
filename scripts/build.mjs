import { build } from "esbuild";
import { mkdir, copyFile, cp, readdir, readFile, writeFile } from "node:fs/promises";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
if (manifest.version.split("+")[0] !== pkg.version) throw new Error("Run npm run version to synchronize plugin metadata before building");
await mkdir("assets/vendor", { recursive: true });
for (const [source, destination] of [
  [
    "node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js",
    "assets/vendor/lightweight-charts.js",
  ],
  ["node_modules/lucide/dist/umd/lucide.min.js", "assets/vendor/lucide.js"],
  [
    "node_modules/lightweight-charts/LICENSE",
    "assets/vendor/LICENSE-lightweight-charts",
  ],
  ["node_modules/lucide/LICENSE", "assets/vendor/LICENSE-lucide"],
])
  await copyFile(source, destination);
await mkdir("assets/vendor/licenses", { recursive: true });
for (const entry of await readdir("node_modules", { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  const packages = entry.name.startsWith("@")
    ? (await readdir(`node_modules/${entry.name}`)).map(
        (name) => `${entry.name}/${name}`,
      )
    : [entry.name];
  for (const name of packages) {
    const dir = `node_modules/${name}`;
    for (const file of await readdir(dir)) {
      if (!/^(LICENSE|LICENCE|COPYING|NOTICE)(\.(md|txt))?$/i.test(file))
        continue;
      try {
        await writeFile(
          `assets/vendor/licenses/${name.replaceAll("/", "-")}-${file}`,
          (await readFile(`${dir}/${file}`, "utf8")).replaceAll("\r\n", "\n"),
        );
      } catch (error) {
        if (error.code !== "EISDIR") throw error;
      }
    }
  }
}
await build({
  entryPoints: ["mcp/server.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  define: { __HROUTER_VERSION__: JSON.stringify(pkg.version) },
  outfile: "mcp/server.bundle.mjs",
});
const distribution = "plugins/hrouter-market-pulse";
await mkdir(`${distribution}/mcp`, { recursive: true });
for (const name of [
  ".codex-plugin",
  ".mcp.json",
  "assets",
  "skills",
  "schemas",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
])
  await cp(name, `${distribution}/${name}`, { recursive: true });
await copyFile(
  "mcp/server.bundle.mjs",
  `${distribution}/mcp/server.bundle.mjs`,
);
console.log(
  "Bundled MCP server, local dashboard assets, and installable marketplace package.",
);
