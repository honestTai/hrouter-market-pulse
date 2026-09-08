import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function updateHome(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.HROUTER_UPDATE_HOME) return path.resolve(env.HROUTER_UPDATE_HOME);
  return platform === "win32"
    ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "HrouterMarketPulseUpdater")
    : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "hrouter-market-pulse-updater");
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

export async function atomicJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// Both activation and runtime startup take this lock before examining/writing leases.
export async function acquireLock(home, name, { waitMs = 0, alive = processAlive } = {}) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const dir = path.join(home, `${name}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(dir, { mode: 0o700 });
      await atomicJson(path.join(dir, "owner.json"), { pid: process.pid, createdAt: Date.now() });
      return async () => { await rm(dir, { recursive: true, force: true }); };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = await readJson(path.join(dir, "owner.json"));
      let stale = owner && !alive(owner.pid);
      if (!owner) {
        try { stale = Date.now() - (await stat(dir)).mtimeMs > 600_000; }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
      }
      if (stale) {
        // Serialize stale-lock reclamation and re-read the owner. Without this,
        // two cleaners could accidentally delete a fresh lock created by the first.
        const reaping = `${dir}.reaping`;
        let reaper = false;
        try {
          await mkdir(reaping, { mode: 0o700 }); reaper = true;
          const current = await readJson(path.join(dir, "owner.json"));
          let removable = current && !alive(current.pid);
          if (!current) {
            try { removable = Date.now() - (await stat(dir)).mtimeMs > 600_000; }
            catch (error) { if (error.code !== "ENOENT") throw error; }
          }
          if (removable) await rm(dir, { recursive: true, force: true });
        } catch (error) { if (!["EEXIST", "ENOENT"].includes(error.code)) throw error; }
        finally { if (reaper) await rm(reaping, { recursive: true, force: true }); }
        if (reaper) continue;
        if (Date.now() >= deadline) return null;
        await delay(100); continue;
      }
      if (Date.now() >= deadline) return null;
      await delay(100);
    }
  }
}

export async function activeRuntimeLeases(home, alive = processAlive) {
  const dir = path.join(home, "running");
  let files;
  try { files = await readdir(dir); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const active = [];
  for (const name of files.filter(name => name.endsWith(".json"))) {
    const file = path.join(dir, name);
    const lease = await readJson(file);
    if (lease && alive(lease.pid)) active.push(lease);
    else await rm(file, { force: true });
  }
  return active;
}

export async function acquireRuntimeLease(home = updateHome()) {
  // Ordinary/manual installs do not create an updater directory or background work.
  if (!(await readJson(path.join(home, "state.json")))) return () => {};
  const unlock = await acquireLock(home, "activation", { waitMs: 120_000 });
  if (!unlock) throw new Error("A Market Pulse update is still being activated. Please retry shortly.");
  const file = path.join(home, "running", `${process.pid}-${randomUUID()}.json`);
  try { await atomicJson(file, { pid: process.pid, startedAt: new Date().toISOString() }); }
  finally { await unlock(); }
  const release = () => { rmSync(file, { force: true }); };
  process.once("exit", release);
  return () => { process.removeListener("exit", release); release(); };
}
