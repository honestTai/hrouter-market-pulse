// Bring outside skills into the library and keep an eye on upstream changes.
//
// Import copies Markdown only (SKILL.md plus references/*.md): no scripts are copied or run, so an
// imported skill can only change what a trader reads, never what the machine executes. Sources: a
// local folder, a Git repository (https only, shallow clone into a temp dir) or ~/.claude/skills.
//
// Update checks compare each built-in skill's pinned upstream commit with the newest commit that
// touched its upstream files (GitHub API, cached), and each Git import with its remote HEAD.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { importedDir, invalidateLibrary, loadLibrary } from "./skill-library.mjs";

const run = promisify(execFile);
const MAX_FILES = 20;
const MAX_BYTES = 200000;

export class SkillImportError extends Error {}

const slug = (text) => String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "skill";

// name / description from YAML front matter, else the first heading and paragraph.
export function describeSkill(text) {
  const front = text.match(/^---\n([\s\S]*?)\n---/);
  const field = (key) => front?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "");
  const body = front ? text.slice(front[0].length) : text;
  const heading = body.match(/^#\s+(.+)$/m)?.[1].trim();
  const paragraph = body.split(/\n\s*\n/).map((part) => part.trim()).find((part) => part && !part.startsWith("#") && !part.startsWith(">") && !part.startsWith("```"));
  return { name: field("name") ?? heading ?? null, summary: (field("description") ?? paragraph ?? "").replace(/\s+/g, " ").slice(0, 240), license: field("license") ?? null };
}

async function markdownFiles(dir) {
  const files = [];
  async function walk(current, depth) {
    if (depth > 2 || files.length >= MAX_FILES) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && depth < 2 && ["references", "api-reference", "docs"].includes(entry.name)) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && files.length < MAX_FILES && (await stat(full)).size <= MAX_BYTES) files.push(path.relative(dir, full));
    }
  }
  await walk(dir, 0);
  return files;
}

async function copySkill(sourceDir, { source, markets, name }) {
  let skillText;
  try { skillText = await readFile(path.join(sourceDir, "SKILL.md"), "utf8"); } catch { throw new SkillImportError(`${sourceDir} has no SKILL.md.`); }
  if (skillText.length > MAX_BYTES) throw new SkillImportError("SKILL.md is larger than 200 KB.");
  const described = describeSkill(skillText);
  const folder = path.basename(path.resolve(sourceDir));
  const title = String(name || described.name || folder).slice(0, 60);
  // An ASCII id from the skill's own name or folder; a hash when both are non-Latin (e.g. Chinese).
  const readable = [name, described.name, folder === "repo" ? null : folder].filter(Boolean).map(slug).find((value) => value !== "skill");
  const id = `imp-${readable ?? createHash("sha1").update(title).digest("hex").slice(0, 10)}`.slice(0, 60);
  const target = path.join(importedDir(), id);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const files = await markdownFiles(sourceDir);
  for (const file of files) {
    await mkdir(path.dirname(path.join(target, file)), { recursive: true });
    await cp(path.join(sourceDir, file), path.join(target, file));
  }
  const meta = {
    id, name: title, summary: described.summary, license: described.license, markets: (markets?.length ? markets : ["A", "HK", "US"]).filter((market) => ["A", "HK", "US"].includes(market)),
    source, files, importedAt: new Date().toISOString(),
  };
  await writeFile(path.join(target, "meta.json"), JSON.stringify(meta, null, 1));
  invalidateLibrary();
  return meta;
}

// ~/.claude/skills: skills the owner already uses in Claude Code.
export async function listClaudeSkills(home = os.homedir()) {
  const dir = path.join(home, ".claude", "skills");
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const skills = [];
  for (const entry of entries.filter((item) => item.isDirectory() || item.isSymbolicLink())) {
    try { const text = await readFile(path.join(dir, entry.name, "SKILL.md"), "utf8"); skills.push({ name: entry.name, ...describeSkill(text), path: path.join(dir, entry.name) }); } catch { /* not a skill */ }
  }
  return skills;
}

export async function importSkill({ kind, path: folder, url, name, subdir, markets, home = os.homedir(), gitImpl = run } = {}) {
  if (kind === "folder") {
    if (!folder || !path.isAbsolute(folder)) throw new SkillImportError("Give the absolute path of a folder that contains SKILL.md.");
    return copySkill(folder, { source: { kind, path: folder }, markets, name });
  }
  if (kind === "claude") {
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(name ?? "")) throw new SkillImportError("Give the skill's folder name under ~/.claude/skills.");
    return copySkill(path.join(home, ".claude", "skills", name), { source: { kind, name }, markets });
  }
  if (kind === "git") {
    let parsed;
    try { parsed = new URL(String(url)); } catch { throw new SkillImportError("Give an https Git URL."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new SkillImportError("Only public https Git URLs without credentials.");
    if (subdir && (!/^[A-Za-z0-9._/-]{1,200}$/.test(subdir) || subdir.includes(".."))) throw new SkillImportError("subdir must be a plain relative path.");
    const temp = await mkdtemp(path.join(os.tmpdir(), "hrouter-skill-"));
    try {
      await gitImpl("git", ["clone", "--depth", "1", "--", parsed.href, path.join(temp, "repo")], { timeout: 90000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const { stdout } = await gitImpl("git", ["-C", path.join(temp, "repo"), "rev-parse", "HEAD"], { timeout: 10000 });
      return await copySkill(path.join(temp, "repo", subdir ?? ""), { source: { kind, url: parsed.href, subdir: subdir ?? null, commit: stdout.trim() }, markets, name });
    } finally { await rm(temp, { recursive: true, force: true }).catch(() => {}); }
  }
  throw new SkillImportError("kind must be folder, git or claude.");
}

export async function removeImported(id) {
  if (!/^imp-[a-z0-9-]{2,56}$/.test(id ?? "")) throw new SkillImportError("Only imported skills can be removed.");
  await rm(path.join(importedDir(), id), { recursive: true, force: true });
  invalidateLibrary();
  return { removed: id };
}

// Re-import a Git skill at its remote's newest commit.
export async function updateImported(id, { gitImpl = run } = {}) {
  const meta = JSON.parse(await readFile(path.join(importedDir(), id, "meta.json"), "utf8"));
  if (meta.source?.kind !== "git") throw new SkillImportError("Only skills imported from Git can be updated; re-import a folder to refresh it.");
  return importSkill({ kind: "git", url: meta.source.url, subdir: meta.source.subdir ?? undefined, name: meta.name, markets: meta.markets, gitImpl });
}

// ---------------------------------------------------------------------------
// Upstream checks
// ---------------------------------------------------------------------------

const CACHE_MS = 6 * 3600000;

async function github(pathname, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com${pathname}`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "hrouter-market-pulse" }, signal: AbortSignal.timeout(10000) });
  if (response.status === 403 || response.status === 429) throw new SkillImportError("GitHub API rate limit reached; try again later.");
  if (!response.ok) throw new SkillImportError(`GitHub API HTTP ${response.status}`);
  return response.json();
}

export async function checkUpdates({ fetchImpl = fetch, gitImpl = run, force = false, cacheFile = path.join(importedDir(), ".upstream.json") } = {}) {
  if (!force) {
    try { const cached = JSON.parse(await readFile(cacheFile, "utf8")); if (Date.now() - Date.parse(cached.checkedAt) < CACHE_MS) return cached; } catch { /* no cache */ }
  }
  const library = await loadLibrary();
  const results = [];
  const commitDates = new Map();
  const commitDate = async (repo, sha) => {
    const key = `${repo}@${sha}`;
    if (!commitDates.has(key)) commitDates.set(key, (await github(`/repos/${repo}/commits/${sha}`, fetchImpl)).commit.committer.date);
    return commitDates.get(key);
  };
  for (const skill of library.skills.filter((entry) => entry.sourceInfo?.commit && entry.source !== "imported" && entry.upstream?.length)) {
    const repo = skill.sourceInfo.repo;
    try {
      const pinnedAt = await commitDate(repo, skill.sourceInfo.commit);
      let latest = null;
      for (const upstreamPath of skill.upstream) {
        const [commit] = await github(`/repos/${repo}/commits?path=${encodeURIComponent(upstreamPath)}&per_page=1`, fetchImpl);
        if (commit && (!latest || commit.commit.committer.date > latest.date)) latest = { sha: commit.sha, date: commit.commit.committer.date, message: commit.commit.message.split("\n")[0].slice(0, 160) };
      }
      const changed = Boolean(latest && latest.sha !== skill.sourceInfo.commit && latest.date > pinnedAt);
      results.push({ skillId: skill.id, kind: "builtin", repo, pinned: { sha: skill.sourceInfo.commit, date: pinnedAt }, latest, changed, compareUrl: changed ? `https://github.com/${repo}/compare/${skill.sourceInfo.commit.slice(0, 12)}...${latest.sha.slice(0, 12)}` : null });
    } catch (error) { results.push({ skillId: skill.id, kind: "builtin", repo, error: error.message }); }
  }
  for (const skill of library.skills.filter((entry) => entry.source === "imported" && entry.imported?.source?.kind === "git")) {
    try {
      const { stdout } = await gitImpl("git", ["ls-remote", "--", skill.imported.source.url, "HEAD"], { timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const head = stdout.split(/\s+/)[0];
      results.push({ skillId: skill.id, kind: "imported", url: skill.imported.source.url, pinned: { sha: skill.imported.source.commit }, latest: head ? { sha: head } : null, changed: Boolean(head && head !== skill.imported.source.commit) });
    } catch (error) { results.push({ skillId: skill.id, kind: "imported", url: skill.imported.source.url, error: error.message }); }
  }
  const value = { checkedAt: new Date().toISOString(), results, note: "内置 skill 是改编版，上游更新不会自动覆盖：看差异后由维护者决定是否跟进；导入的 Git skill 可以一键更新。" };
  await mkdir(path.dirname(cacheFile), { recursive: true }).catch(() => {});
  await writeFile(cacheFile, JSON.stringify(value, null, 1)).catch(() => {});
  return value;
}
