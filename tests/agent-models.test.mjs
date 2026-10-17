import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codexModels, kimiModels, sanitizeEffort } from "../mcp/agent-models.mjs";

test("agent models come from each CLI's own files, newest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-models-"));
  try {
    await writeFile(path.join(root, "models_cache.json"), JSON.stringify({ models: [
      { slug: "gpt-old", display_name: "Old", priority: 9, supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "gpt-new", display_name: "New", priority: 1, supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }] },
    ] }));
    await writeFile(path.join(root, "config.toml"), 'model = "provider-model"\ndefault_model = "kimi-code/k3-256k"\n[models."kimi-code/kimi-for-coding"]\nsupport_efforts = [ "low", "high", "max" ]\n[models."kimi-code/k3"]\nsupport_efforts = [ "low", "high", "max" ]\n[models."kimi-code/k3-256k"]\n');
    const codex = await codexModels(root);
    assert.deepEqual(codex.models.map((model) => [model.id, model.latest]), [["gpt-new", true], ["gpt-old", false], ["provider-model", false]]);
    assert.deepEqual(codex.models[0].efforts, ["high"], "unknown effort names are dropped");
    const kimi = await kimiModels(root);
    assert.deepEqual(kimi.models.map((model) => model.id), ["kimi-code/k3-256k", "kimi-code/k3", "kimi-code/kimi-for-coding"]);
    assert.equal((await codexModels(path.join(root, "missing"))).source, "built-in");
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.equal(sanitizeEffort("xhigh"), "xhigh");
  assert.throws(() => sanitizeEffort("turbo"), /effort must be/);
});
