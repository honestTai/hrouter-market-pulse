import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("../web/src/", import.meta.url));
const unquote = (text) => text.replace(/\\(.)/g, "$1");

async function sources(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sources(full));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.startsWith("i18n")) files.push(full);
  }
  return files;
}

test("i18n: every Chinese t('…') string in the UI has an English entry with the same placeholders", async () => {
  const dictionary = new Map([...(await readFile(path.join(web, "lib/i18n-en.ts"), "utf8")).matchAll(/^ {2}'((?:[^'\\]|\\.)*)': '((?:[^'\\]|\\.)*)',$/gm)].map((match) => [unquote(match[1]), unquote(match[2])]));
  assert.ok(dictionary.size > 1000, "dictionary parsed");
  const missing = [];
  const mismatched = [];
  for (const file of await sources(web)) {
    for (const match of (await readFile(file, "utf8")).matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) {
      const key = unquote(match[1]);
      if (!/[一-鿿]/.test(key)) continue;
      if (!dictionary.has(key)) { missing.push(`${path.relative(web, file)}: ${key}`); continue; }
      const holes = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((hole) => hole[1]).sort().join();
      if (holes(key) !== holes(dictionary.get(key))) mismatched.push(key);
    }
  }
  assert.deepEqual(missing, [], "add these to web/src/lib/i18n-en.ts");
  assert.deepEqual([...new Set(mismatched)], [], "placeholders differ");
  for (const [key, value] of dictionary) assert.ok(!/[一-鿿]/.test(value), `untranslated: ${key}`);
});
