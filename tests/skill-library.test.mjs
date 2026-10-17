import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { libraryDir, loadLibrary, skillsFor, skillTextFor, starterStrategyCode, templateDefaults } from "../mcp/skill-library.mjs";
import { openSandbox } from "../mcp/strategy-sandbox.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("every built-in skill has its text, a source with a pinned commit and the upstream license on disk", async () => {
  const library = await loadLibrary();
  assert.ok(library.skills.length >= 10);
  for (const skill of library.skills) {
    assert.ok(skill.sourceInfo, `${skill.id} has a source`);
    assert.ok(["MIT", "Apache-2.0"].includes(skill.sourceInfo.license), `${skill.id} license`);
    await access(path.join(root, skill.sourceInfo.licenseFile));
    if (skill.source !== "hrouter") assert.match(skill.sourceInfo.commit, /^[a-f0-9]{40}$/);
    if (skill.status === "available") {
      const body = await readFile(path.join(libraryDir(), "skills", skill.id, "SKILL.md"), "utf8");
      assert.match(body, new RegExp(skill.sourceInfo.repo.replace("/", "\\/")), `${skill.id} credits its source`);
    } else assert.ok(skill.requires?.length, `${skill.id} says which data it needs`);
  }
  const notices = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const source of Object.values(library.sources).filter((entry) => entry.commit)) assert.ok(notices.includes(source.repo), `${source.repo} in notices`);
});

test("templates bind skills by market and discipline skills always come along", async () => {
  const swing = await templateDefaults("a-share-swing", { market: "A" });
  assert.deepEqual(swing.skills, ["a-share-trend-pullback", "macd-trend-resonance"]);
  assert.ok(swing.prompt.includes("60 日线"));
  assert.equal(swing.limits, undefined, "suggested limits apply only when the owner ticks them");
  assert.deepEqual((await templateDefaults("a-share-swing", { market: "A", applySuggestedLimits: true })).limits, { maxPositions: 6, maxPositionPct: 20, maxRiskPerTradePct: 1.5 });
  await assert.rejects(templateDefaults("a-share-hot-money", { market: "A" }), /缺数据/);
  await assert.rejects(templateDefaults("a-share-swing", { market: "US" }), /不适用/);
  const ids = (await skillsFor({ market: "A", template: "a-share-swing" })).map((skill) => skill.id);
  assert.deepEqual(ids, ["pre-trade-gate", "position-sizing", "loss-circuit-breaker", "trade-review", "a-share-trend-pullback", "macd-trend-resonance"]);
  // CANSLIM is US / HK only, so an A-share trader never gets it even if listed.
  assert.ok(!(await skillsFor({ market: "A", skills: ["canslim"] })).some((skill) => skill.id === "canslim"));
  const text = await skillTextFor({ market: "US", template: "growth-momentum" });
  assert.match(text, /CANSLIM/);
  assert.match(text, /交易前纪律关卡/);
});

test("starter strategies pass the sandbox's static rules and load", async () => {
  for (const id of ["trend-pullback", "macd-resonance"]) {
    const sandbox = await openSandbox(await starterStrategyCode(id));
    assert.equal(sandbox.meta.id, id);
    await sandbox.close();
  }
});
