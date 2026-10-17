// Built-in trader skill library: adapted third-party methods plus trader templates and starter
// strategies. Skills a trader is bound to travel with every round as part of its system prompt.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let cached = null;

export function libraryDir() {
  return process.env.HROUTER_LIBRARY_DIR || path.resolve(here, "..", "library");
}

async function readJson(name) {
  return JSON.parse(await readFile(path.join(libraryDir(), name), "utf8"));
}

export async function loadLibrary() {
  if (cached && cached.dir === libraryDir()) return cached.value;
  const [catalog, templates] = await Promise.all([readJson("catalog.json"), readJson("templates.json")]);
  const value = {
    sources: catalog.sources, note: catalog.note,
    skills: catalog.skills.map((skill) => ({ ...skill, sourceInfo: catalog.sources[skill.source] ?? null })),
    templates: templates.templates, discipline: templates.discipline,
  };
  cached = { dir: libraryDir(), value };
  return value;
}

export async function skillBody(id) {
  if (!/^[a-z0-9-]{2,60}$/.test(id ?? "")) throw new Error(`Invalid skill id ${id}`);
  return readFile(path.join(libraryDir(), "skills", id, "SKILL.md"), "utf8");
}

export async function starterStrategyCode(id) {
  if (!/^[a-z0-9-]{2,60}$/.test(id ?? "")) throw new Error(`Invalid strategy id ${id}`);
  return readFile(path.join(libraryDir(), "strategies", `${id}.mjs`), "utf8");
}

// The skills a trader runs with: its own list, else its template's, plus the discipline skills.
export async function skillsFor(account) {
  const library = await loadLibrary();
  const template = library.templates.find((entry) => entry.id === account.template);
  const chosen = Array.isArray(account.skills) ? account.skills : template?.skills ?? [];
  const ids = [...new Set([...library.discipline, ...chosen])];
  return ids.map((id) => library.skills.find((skill) => skill.id === id)).filter((skill) => skill && skill.status === "available" && skill.markets.includes(account.market));
}

export async function skillTextFor(account) {
  const skills = await skillsFor(account).catch(() => []);
  const parts = [];
  for (const skill of skills) {
    try { parts.push(`## 流派 / 纪律 skill：${skill.name}\n\n${(await skillBody(skill.id)).replace(/^#\s.*\n/, "").trim()}`); } catch { /* missing file: skip */ }
  }
  return parts.join("\n\n---\n\n");
}

// Fields a template contributes to a new account; the owner's explicit input always wins.
export async function templateDefaults(templateId, input = {}) {
  if (!templateId) return {};
  const library = await loadLibrary();
  const template = library.templates.find((entry) => entry.id === templateId);
  if (!template) throw new Error(`Unknown template ${templateId}.`);
  if (template.status !== "available") throw new Error(`「${template.name}」还缺数据（${(template.requires ?? []).join("、")}），第 2 期开放。`);
  if (input.market && !template.markets.includes(input.market)) throw new Error(`「${template.name}」不适用于 ${input.market} 市场。`);
  return {
    template: template.id, skills: template.skills,
    ...(input.prompt ? {} : template.prompt ? { prompt: template.prompt } : {}),
    ...(input.applySuggestedLimits && Object.keys(template.suggestedLimits ?? {}).length ? { limits: { ...template.suggestedLimits, ...input.limits } } : {}),
    cadence: template.cadence, starterStrategy: template.starterStrategy ?? null, builtinStrategy: template.builtinStrategy ?? false,
  };
}
