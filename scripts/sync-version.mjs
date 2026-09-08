import { readFile, writeFile } from "node:fs/promises";
import { stableVersion } from "./release-format.mjs";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
stableVersion(pkg.version);
const file = ".codex-plugin/plugin.json", plugin = JSON.parse(await readFile(file, "utf8"));
plugin.version = `${pkg.version}+codex.${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
await writeFile(file, JSON.stringify(plugin, null, 2) + "\n");
console.log(`Plugin version synchronized: ${plugin.version}. Run npm run build before tagging.`);
