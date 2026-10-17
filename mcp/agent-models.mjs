// Which models and reasoning efforts each agent CLI offers, read from the CLI's own files so the
// workbench never depends on one provider: Claude Code's aliases always point at the newest model,
// Codex keeps OpenAI's model list in ~/.codex/models_cache.json, Kimi Code lists its models in
// ~/.kimi-code/config.toml. The first model is the newest and is the default for new traders.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT = "high";

const CLAUDE = [
  { id: "opus", label: "Opus", latest: true },
  { id: "fable", label: "Fable" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
// Used only when the CLI's own list cannot be read.
const FALLBACK = { codex: ["gpt-5.6-sol"], kimi: ["k3"] };

const home = () => process.env.HOME || os.homedir();

async function readText(file) {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

export async function codexModels(root = path.join(home(), ".codex")) {
  const cache = JSON.parse(await readText(path.join(root, "models_cache.json")) ?? "{}");
  const config = await readText(path.join(root, "config.toml")) ?? "";
  const configured = config.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const listed = (cache.models ?? [])
    .filter((model) => model.slug && model.visibility !== "hide")
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
    .map((model) => ({ id: model.slug, label: model.display_name ?? model.slug, efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort).filter((effort) => EFFORTS.includes(effort)) }));
  const models = listed.length ? listed : FALLBACK.codex.map((id) => ({ id, label: id }));
  if (configured && !models.some((model) => model.id === configured)) models.push({ id: configured, label: `${configured} (config.toml)` });
  return { models: models.map((model, index) => ({ ...model, latest: index === 0 })), configured, source: listed.length ? "~/.codex/models_cache.json" : "built-in" };
}

export async function kimiModels(root = path.join(home(), ".kimi-code")) {
  const config = await readText(path.join(root, "config.toml")) ?? "";
  const configured = config.match(/^default_model\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  const models = [];
  for (const block of config.split(/^\[models\."/m).slice(1)) {
    const id = block.slice(0, block.indexOf('"'));
    const efforts = (block.match(/^support_efforts\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").match(/"([^"]+)"/g)?.map((entry) => entry.slice(1, -1)).filter((effort) => EFFORTS.includes(effort)) ?? [];
    models.push({ id, label: id.replace(/^kimi-code\//, ""), efforts });
  }
  // K3 is the newest Kimi Code model; keep the owner's configured K3 variant (e.g. k3-256k) first.
  const rank = (id) => (id === configured && /\/k3/.test(id) ? 0 : /\/k3$/.test(id) ? 1 : /\/k3/.test(id) ? 2 : 3);
  models.sort((a, b) => rank(a.id) - rank(b.id));
  const list = models.length ? models : FALLBACK.kimi.map((id) => ({ id: `kimi-code/${id}`, label: id }));
  return { models: list.map((model, index) => ({ ...model, latest: index === 0 })), configured, source: models.length ? "~/.kimi-code/config.toml" : "built-in" };
}

export async function agentModels() {
  const [codex, kimi] = await Promise.all([codexModels(), kimiModels()]);
  return {
    efforts: EFFORTS, defaultEffort: DEFAULT_EFFORT,
    agents: {
      claude: { models: CLAUDE.map((model) => ({ ...model, efforts: EFFORTS })), configured: null, source: "Claude Code aliases", effortFlag: true },
      workbuddy: { models: [], configured: null, source: null, effortFlag: false },
      codex: { ...codex, effortFlag: true },
      // Kimi Code has no per-run effort flag; it uses [thinking] effort from its own config.
      kimi: { ...kimi, effortFlag: false },
    },
  };
}

export function sanitizeEffort(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!EFFORTS.includes(value)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}.`);
  return value;
}
