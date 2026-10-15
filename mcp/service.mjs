// Long-running arena service (`--service`): dashboard + background matcher + round scheduler.
// Installed as a per-user login service (LaunchAgent / systemd user unit / Scheduled Task) by
// scripts/arena-service.mjs. It does not hold the updater's runtime lease; instead it exits when
// its bundle file changes so the OS service manager restarts it on the new version.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const SERVICE_HEARTBEAT_MS = 30000;
export const SERVICE_STALE_MS = 120000;

export function serviceStatusFile(arenaRoot) {
  return path.join(arenaRoot, "service-status.json");
}

export async function readServiceStatus(arenaRoot, now = Date.now()) {
  try {
    const status = JSON.parse(await readFile(serviceStatusFile(arenaRoot), "utf8"));
    const alive = now - Date.parse(status.heartbeatAt) < SERVICE_STALE_MS;
    return { ...status, state: alive ? "running" : "stopped" };
  } catch (error) {
    if (error.code === "ENOENT") return { state: "not-installed-or-never-started" };
    throw error;
  }
}

export function startServiceLoop({ arena, scheduler, bundlePath, version, port, onExit = () => process.exit(0) }) {
  const startedAt = new Date().toISOString();
  let bundleMtime = null;
  let stopping = false;
  const write = async () => {
    const status = {
      pid: process.pid, host: os.hostname(), version, bundlePath, port, startedAt, heartbeatAt: new Date().toISOString(),
      node: process.version, scheduler: scheduler?.status() ?? null,
    };
    await mkdir(arena.root, { recursive: true });
    const file = serviceStatusFile(arena.root);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(status, null, 1), "utf8");
    await rename(temporary, file);
  };
  const beat = async () => {
    if (stopping) return;
    try {
      await write();
      // An updater replaced the plugin: exit so the service manager restarts the new code.
      if (bundlePath) {
        const mtime = (await stat(bundlePath)).mtimeMs;
        if (bundleMtime === null) bundleMtime = mtime;
        else if (mtime !== bundleMtime) { console.error("Arena service: plugin bundle changed; restarting."); stopping = true; onExit("bundle-changed"); }
      }
    } catch (error) { console.error(`Arena service heartbeat: ${error.message}`); }
  };
  beat();
  const timer = setInterval(beat, SERVICE_HEARTBEAT_MS);
  return { stop() { stopping = true; clearInterval(timer); } };
}
