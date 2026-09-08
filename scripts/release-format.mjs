import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { lstat, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const PROJECT = "hrouter-market-pulse";
export const REPOSITORY = "honestTai/hrouter-market-pulse";
export const MARKETPLACE = PROJECT;
export const PLUGIN_ID = `${PROJECT}@${MARKETPLACE}`;
export const MAX_DOWNLOAD = 32 * 1024 * 1024;
export const MAX_UNPACKED = 96 * 1024 * 1024;
export const RELEASE_PATHS = [
  ".agents", ".codex-plugin", ".mcp.json", "assets", "docs", "mcp", "plugins",
  "schemas", "scripts", "skills", "tests", "package.json", "package-lock.json",
  "README.md", "README.en.md", "LICENSE", "SECURITY.md", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md",
];
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

export function stableVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version))
    throw new Error(`Expected a stable x.y.z version, got ${JSON.stringify(version)}`);
  return version;
}
export function compareVersions(a, b) {
  const left = stableVersion(a).split(".").map(Number), right = stableVersion(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

export function safeRelativePath(file) {
  if (typeof file !== "string" || file.length > 240 || !file || file.includes("\\") || /[\x00-\x1f<>:"|?*]/.test(file))
    throw new Error("Unsafe package path");
  const parts = file.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
    throw new Error(`Unsafe package path: ${file}`);
  return file;
}

export async function collectReleaseFiles(root) {
  const files = [];
  async function visit(relative) {
    const file = path.join(root, relative), info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed in releases: ${relative}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await visit(`${relative}/${name}`);
    } else if (info.isFile()) {
      safeRelativePath(relative);
      const bytes = await readFile(file);
      files.push({ path: relative, data: bytes.toString("base64"), size: bytes.length, sha256: sha256(bytes) });
    } else throw new Error(`Unsupported package entry: ${relative}`);
  }
  for (const entry of RELEASE_PATHS) {
    try { await lstat(path.join(root, entry)); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await visit(entry);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export function validateBundle(bundle, expectedVersion) {
  if (bundle?.schemaVersion !== 1 || bundle.name !== PROJECT || bundle.repository !== REPOSITORY || bundle.version !== stableVersion(expectedVersion))
    throw new Error("Update package identity/version mismatch");
  if (!Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 5000) throw new Error("Invalid package file count");
  const seen = new Set(), decoded = new Map(); let total = 0;
  for (const file of bundle.files) {
    const name = safeRelativePath(file.path), folded = name.toLowerCase();
    if (seen.has(folded)) throw new Error(`Duplicate/case-colliding path: ${name}`);
    seen.add(folded);
    if (typeof file.data !== "string" || file.data.length > MAX_UNPACKED * 2) throw new Error("Invalid base64 file data");
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.toString("base64") !== file.data) throw new Error("Invalid base64 file data");
    total += bytes.length;
    if (total > MAX_UNPACKED || bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`File checksum/size mismatch: ${name}`);
    decoded.set(name, bytes);
  }
  for (const name of seen) {
    const parts = name.split("/");
    while (parts.length > 1) { parts.pop(); if (seen.has(parts.join("/"))) throw new Error("File/directory collision"); }
  }
  const json = name => {
    if (!decoded.has(name)) throw new Error(`Required package file missing: ${name}`);
    return JSON.parse(decoded.get(name).toString("utf8"));
  };
  const pkg = json("package.json");
  if (pkg.name !== PROJECT || pkg.version !== expectedVersion) throw new Error("package.json version mismatch");
  const rootPlugin = json(".codex-plugin/plugin.json"), plugin = json(`plugins/${PROJECT}/.codex-plugin/plugin.json`);
  if (rootPlugin.name !== PROJECT || plugin.name !== PROJECT || rootPlugin.version !== plugin.version || plugin.version.split("+")[0] !== expectedVersion)
    throw new Error("Plugin manifests are not synchronized with the release version");
  const market = json(".agents/plugins/marketplace.json");
  if (market.name !== MARKETPLACE || market.plugins?.length !== 1 || market.plugins[0].name !== PROJECT || market.plugins[0].source?.source !== "local" || market.plugins[0].source.path !== `./plugins/${PROJECT}`)
    throw new Error("Unexpected marketplace definition");
  for (const required of [`plugins/${PROJECT}/mcp/server.bundle.mjs`, `plugins/${PROJECT}/.mcp.json`, "scripts/install.mjs", "scripts/updater.mjs", "scripts/update-scheduler.mjs", "scripts/release-format.mjs", "mcp/update-coordination.mjs"])
    if (!decoded.has(required)) throw new Error(`Required package file missing: ${required}`);
  return decoded;
}

export function encodeBundle(version, files) {
  const bundle = { schemaVersion: 1, name: PROJECT, repository: REPOSITORY, version: stableVersion(version), files };
  validateBundle(bundle, version);
  return gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 });
}
export function decodeBundle(bytes, metadata) {
  if (bytes.length > MAX_DOWNLOAD || bytes.length !== metadata.size || sha256(bytes) !== metadata.sha256) throw new Error("Update download checksum/size mismatch");
  const bundle = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED }).toString("utf8"));
  return validateBundle(bundle, metadata.version);
}
export async function extractFiles(files, directory) {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  for (const [relative, bytes] of files) {
    const target = path.join(directory, safeRelativePath(relative));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  }
}

// Small deterministic ZIP writer (stored entries, no ZIP64 or external archiver).
// Auto-updates use the separately checksummed bounded gzip manifest, not ZIP extraction.
export function releaseZip(files) {
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(safeRelativePath(file.path)), data = Buffer.from(file.data, "base64");
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(33, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, name); offset += head.length + name.length + data.length;
  }
  const end = Buffer.alloc(22), centralBytes = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
