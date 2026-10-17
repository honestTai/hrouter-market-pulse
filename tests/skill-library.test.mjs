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
  const hotMoney = await templateDefaults("a-share-hot-money", { market: "A" });
  assert.deepEqual(hotMoney.skills, ["lhb-hot-money", "emotion-cycle", "tuige-shortline"]);
  assert.match(await skillTextFor({ market: "A", template: "a-share-hot-money" }), /get_dragon_tiger/);
  assert.deepEqual((await templateDefaults("macro-timing", { market: "US" })).skills, ["market-regime", "investor-panel", "loss-circuit-breaker"]);
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

test("the owner's layer on a skill, imported skills (Markdown only) and Git update checks", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const data = await mkdtemp(path.join(os.tmpdir(), "skill-layer-"));
  const previous = process.env.HROUTER_REPORT_DIR;
  process.env.HROUTER_REPORT_DIR = data;
  try {
    const { importSkill, removeImported, updateImported, checkUpdates, describeSkill } = await import("../mcp/skill-import.mjs");
    const { invalidateLibrary, overrideText } = await import("../mcp/skill-library.mjs");
    const text = await skillTextFor({ market: "A", template: "a-share-swing", skillOverrides: { "a-share-trend-pullback": { params: { 快线: "10" }, append: "只做沪深 300 成分股。", references: [{ name: "我的笔记", text: "回踩不破 20 日线再买。" }] } } });
    assert.match(text, /A 股主板趋势回踩[\s\S]*本交易员的定制[\s\S]*快线 = 10[\s\S]*只做沪深 300 成分股[\s\S]*我的笔记/);
    assert.equal(overrideText(null), "");

    const folder = path.join(data, "src", "my-rules");
    await mkdir(path.join(folder, "references"), { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), "---\nname: my-rules\ndescription: 我自己的打板纪律\nlicense: MIT\n---\n# 我的纪律\n\n只做首板。");
    await writeFile(path.join(folder, "references", "notes.md"), "# 笔记");
    await writeFile(path.join(folder, "run.sh"), "rm -rf /");
    const meta = await importSkill({ kind: "folder", path: folder, markets: ["A"] });
    assert.equal(meta.id, "imp-my-rules");
    assert.deepEqual(meta.files.sort(), ["SKILL.md", path.join("references", "notes.md")].sort(), "scripts are never copied");
    invalidateLibrary();
    const library = await loadLibrary();
    const imported = library.skills.find((skill) => skill.id === "imp-my-rules");
    assert.equal(imported.summary, "我自己的打板纪律");
    assert.match(await skillTextFor({ market: "A", skills: ["imp-my-rules"] }), /只做首板/);
    await assert.rejects(importSkill({ kind: "git", url: "http://example.com/repo.git" }), /https/);
    await assert.rejects(importSkill({ kind: "folder", path: "relative/path" }), /absolute/);
    assert.equal(describeSkill("# 标题\n\n第一段。").name, "标题");

    // A Git import records its commit; the update check compares it with the remote HEAD.
    const gitImpl = async (command, args) => {
      if (args[0] === "clone") { const target = args.at(-1); await mkdir(path.join(target, "skills", "relay"), { recursive: true }); await writeFile(path.join(target, "skills", "relay", "SKILL.md"), "# Relay\n\nRelay rules."); return { stdout: "" }; }
      if (args.includes("rev-parse")) return { stdout: "a".repeat(40) + "\n" };
      if (args[0] === "ls-remote") return { stdout: `${"b".repeat(40)}\tHEAD\n` };
      throw new Error(args.join(" "));
    };
    const git = await importSkill({ kind: "git", url: "https://github.com/example/skills", subdir: "skills/relay", gitImpl });
    assert.equal(git.source.commit, "a".repeat(40));
    invalidateLibrary();
    const fetchImpl = async (url) => {
      if (/\/commits\/[a-f0-9]{40}$/.test(url)) return new Response(JSON.stringify({ commit: { committer: { date: "2026-09-01T00:00:00Z" } } }));
      return new Response(JSON.stringify([{ sha: "c".repeat(40), commit: { committer: { date: "2026-09-01T00:00:00Z" }, message: "same day" } }]));
    };
    const updates = await checkUpdates({ force: true, fetchImpl, gitImpl, cacheFile: path.join(data, "upstream.json") });
    assert.equal(updates.results.find((entry) => entry.skillId === git.id).changed, true);
    assert.ok(updates.results.filter((entry) => entry.kind === "builtin").every((entry) => entry.changed === false), "a newest commit on the pinned date is not newer");
    assert.equal((await updateImported(git.id, { gitImpl })).source.commit, "a".repeat(40));
    await removeImported("imp-my-rules");
    invalidateLibrary();
    assert.ok(!(await loadLibrary()).skills.some((skill) => skill.id === "imp-my-rules"));
  } finally {
    if (previous === undefined) delete process.env.HROUTER_REPORT_DIR; else process.env.HROUTER_REPORT_DIR = previous;
    (await import("../mcp/skill-library.mjs")).invalidateLibrary();
    await rm(data, { recursive: true, force: true });
  }
});
