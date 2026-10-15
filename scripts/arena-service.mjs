#!/usr/bin/env node
// Install the Agent Arena as a per-user login service so matching, protective exits, digests and
// scheduled agent / strategy rounds run without any app open.
//
//   node scripts/arena-service.mjs install    # register and start (macOS / Linux / Windows)
//   node scripts/arena-service.mjs status
//   node scripts/arena-service.mjs uninstall
//   node scripts/arena-service.mjs run        # foreground, for debugging
//
// No admin rights, no PATH edits. The service keeps restarting after crashes and after plugin
// updates (it exits when its bundle changes and the service manager starts the new version).

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { windowsArg } from "./update-scheduler.mjs";

export const SERVICE_NAME = "net.hrouter.market-pulse.arena";
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const ps = (value) => `'${String(value).replaceAll("'", "''")}'`;
const unit = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;

export function bundlePath() {
  // Bundled into server.bundle.mjs itself: the running file is the service entry point.
  const self = fileURLToPath(import.meta.url);
  if (self.endsWith("server.bundle.mjs")) return self;
  const packaged = path.join(root, "plugins", "hrouter-market-pulse", "mcp", "server.bundle.mjs");
  return existsSync(packaged) ? packaged : path.join(root, "mcp", "server.bundle.mjs");
}

function storageDir(home = os.homedir()) {
  if (process.env.HROUTER_REPORT_DIR) return path.resolve(process.env.HROUTER_REPORT_DIR);
  const base = process.env.LOCALAPPDATA || (process.platform === "win32" ? path.join(home, "AppData", "Local") : path.join(home, ".hrouter-market-pulse"));
  return path.join(base, "HrouterMarketPulse");
}

// Environment the service needs: PATH so agent CLIs (claude, codex) resolve, plus proxy / data settings.
export function serviceEnvironment(env = process.env) {
  const keep = ["PATH", "HOME", "LANG", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "HROUTER_REPORT_DIR", "HROUTER_SEC_USER_AGENT", "CODEX_HOME", "LOCALAPPDATA"];
  const selected = Object.fromEntries(keep.filter((key) => env[key]).map((key) => [key, env[key]]));
  selected.HROUTER_REPORT_PORT = env.HROUTER_ARENA_PORT || "8787";
  return selected;
}

export function servicePlan({ platform = process.platform, home = os.homedir(), node = process.execPath, bundle = bundlePath(), env = serviceEnvironment(), uid = process.getuid?.() } = {}) {
  const args = [bundle, "--service"];
  const log = path.join(storageDir(home), "arena", "service.log");
  if (platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${SERVICE_NAME}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_NAME}</string>
<key>ProgramArguments</key><array>${[node, ...args].map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
    return {
      kind: "launchd", log, files: [{ path: file, content }],
      enable: [["launchctl", ["bootstrap", `gui/${uid}`, file]]],
      disable: [["launchctl", ["bootout", `gui/${uid}/${SERVICE_NAME}`]]],
      status: ["launchctl", ["print", `gui/${uid}/${SERVICE_NAME}`]],
    };
  }
  if (platform === "linux") {
    const file = path.join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`);
    const content = `[Unit]\nDescription=Hrouter Market Pulse Agent Arena service\nAfter=network-online.target\n[Service]\n${Object.entries(env).map(([key, value]) => `Environment=${unit(`${key}=${value}`)}`).join("\n")}\nExecStart=${[node, ...args].map(unit).join(" ")}\nRestart=always\nRestartSec=30\nStandardOutput=append:${log}\nStandardError=append:${log}\n[Install]\nWantedBy=default.target\n`;
    return {
      kind: "systemd-user", log, files: [{ path: file, content }],
      enable: [["systemctl", ["--user", "daemon-reload"]], ["systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`]]],
      disable: [["systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`]]],
      status: ["systemctl", ["--user", "status", "--no-pager", `${SERVICE_NAME}.service`]],
    };
  }
  if (platform === "win32") {
    const command = ["-NoProfile", "-NonInteractive", "-Command"];
    const envPrefix = Object.entries(env).map(([key, value]) => `$env:${key}=${ps(value)}; `).join("");
    // A logon task that restarts on failure; the limited user token needs no stored password.
    const action = `${envPrefix}& ${ps(node)} ${args.map(windowsArg).join(" ")} *>> ${ps(log)}`;
    const registration = `$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${ps(`-NoProfile -WindowStyle Hidden -Command ${action}`)}; `
      + "$t=New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name); "
      + "$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew; "
      + "$p=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited; "
      + `Register-ScheduledTask -TaskName ${ps(SERVICE_NAME)} -Action $a -Trigger $t -Settings $s -Principal $p -Force -ErrorAction Stop | Out-Null; Start-ScheduledTask -TaskName ${ps(SERVICE_NAME)}`;
    return {
      kind: "windows-task", log, files: [],
      enable: [["powershell.exe", [...command, registration]]],
      disable: [["powershell.exe", [...command, `Stop-ScheduledTask -TaskName ${ps(SERVICE_NAME)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${ps(SERVICE_NAME)} -Confirm:$false -ErrorAction Stop`]]],
      status: ["powershell.exe", [...command, `Get-ScheduledTask -TaskName ${ps(SERVICE_NAME)} | Format-List TaskName,State`]],
    };
  }
  throw new Error(`The arena service is not supported on ${platform}; run "node scripts/arena-service.mjs run" instead.`);
}

async function exec(command, args, { allowFailure = false } = {}) {
  try { return (await run(command, args, { windowsHide: true })).stdout; }
  catch (error) { if (allowFailure) return error.stdout ?? ""; throw new Error(`${command} ${args[0] ?? ""} failed: ${error.stderr || error.message}`); }
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/arena/schedules`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    return { reachable: true, service: body.service, jobs: body.jobs?.length ?? 0 };
  } catch (error) { return { reachable: false, error: error.message }; }
}

export async function main(argv = process.argv.slice(2)) {
  const action = argv[0] ?? "status";
  if (action === "run") {
    const child = spawn(process.execPath, [bundlePath(), "--service"], { stdio: "inherit", env: { ...process.env, ...serviceEnvironment() } });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  const plan = servicePlan();
  if (!existsSync(bundlePath())) throw new Error("Build first: npm ci && npm run build");
  if (action === "install") {
    await mkdir(path.dirname(plan.log), { recursive: true });
    for (const [command, args] of plan.disable) await exec(command, args, { allowFailure: true });
    for (const file of plan.files) { await mkdir(path.dirname(file.path), { recursive: true }); await writeFile(file.path, file.content, { mode: 0o600 }); }
    for (const [command, args] of plan.enable) await exec(command, args);
    const port = serviceEnvironment().HROUTER_REPORT_PORT;
    let state = { reachable: false };
    for (let attempt = 0; attempt < 15 && !state.reachable; attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 1000)); state = await health(port); }
    console.log(JSON.stringify({ installed: plan.kind, bundle: bundlePath(), dashboard: `http://127.0.0.1:${port}/?view=arena`, log: plan.log, health: state }, null, 2));
    return;
  }
  if (action === "uninstall") {
    for (const [command, args] of plan.disable) await exec(command, args, { allowFailure: true });
    for (const file of plan.files) await rm(file.path, { force: true });
    if (plan.kind === "systemd-user") await exec("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    console.log(JSON.stringify({ uninstalled: plan.kind }, null, 2));
    return;
  }
  if (action === "status") {
    const port = serviceEnvironment().HROUTER_REPORT_PORT;
    const manager = await exec(...plan.status, { allowFailure: true });
    const installed = plan.files.length ? plan.files.every((file) => existsSync(file.path)) : Boolean(manager.trim());
    console.log(JSON.stringify({ kind: plan.kind, installed, managerRunning: /state = running|Active: active|State\s*:\s*Running/i.test(manager), log: plan.log, health: await health(port) }, null, 2));
    return;
  }
  throw new Error(`Unknown action "${action}". Use install, status, uninstall or run.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !fileURLToPath(import.meta.url).endsWith("server.bundle.mjs")) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
