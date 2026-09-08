import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT, REPOSITORY, stableVersion, collectReleaseFiles, encodeBundle, releaseZip, sha256 } from "./release-format.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = stableVersion(pkg.version);
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error("Git tag and package.json version must match");
const files = await collectReleaseFiles(root), bundle = encodeBundle(version, files);
const output = path.join(root, "output", "releases");
await mkdir(output, { recursive: true });
const base = `${PROJECT}-${version}`;
const artifacts = new Map([
  [`${base}.bundle.json.gz`, bundle],
  [`${base}.zip`, releaseZip(files)],
  [`${base}.update.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, repository: REPOSITORY, version, bundle: { name: `${base}.bundle.json.gz`, size: bundle.length, sha256: sha256(bundle) } }, null, 2) + "\n")],
]);
for (const [name, bytes] of artifacts) await writeFile(path.join(output, name), bytes);
await writeFile(path.join(output, "SHA256SUMS.txt"), [...artifacts].map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join("\n") + "\n");
console.log(JSON.stringify({ version, output, files: files.length, artifacts: [...artifacts.keys(), "SHA256SUMS.txt"] }, null, 2));
