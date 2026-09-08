import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const JOB_NAME = "net.hrouter.market-pulse.update";
const xml = s => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const ps = s => "'" + String(s).replaceAll("'", "''") + "'";
const systemd = s => '"' + String(s).replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
const systemdArg = s => systemd(String(s).replaceAll("$", "$$"));
// Windows command-line quoting for CommandLineToArgvW / the Node executable.
export function windowsArg(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

export function schedulerPlan({ platform = process.platform, home = os.homedir(), updateDir, node = process.execPath, uid = process.getuid?.(), codexHome = process.env.CODEX_HOME || path.join(home, ".codex") }) {
  for (const value of [home, updateDir, node, codexHome]) if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Scheduler paths cannot contain control characters");
  const script = path.join(updateDir, "runner.mjs");
  const args = [script, "check", "--scheduled", "--update-home", updateDir];
  if (platform === "darwin") {
    const file = path.join(home, "Library", "LaunchAgents", `${JOB_NAME}.plist`);
    const log = path.join(updateDir, "scheduler.log");
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${JOB_NAME}</string>
<key>ProgramArguments</key><array>${[node, ...args].map(a => `<string>${xml(a)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>CODEX_HOME</key><string>${xml(codexHome)}</string></dict>
<key>StartInterval</key><integer>21600</integer><key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
    return { kind: "launchd", files: [{ path: file, content }], enable: [["launchctl", ["bootstrap", `gui/${uid}`, file]]], disable: [["launchctl", ["bootout", `gui/${uid}/${JOB_NAME}`]]] };
  }
  if (platform === "linux") {
    const dir = path.join(home, ".config", "systemd", "user");
    return { kind: "systemd-user", files: [
      { path: path.join(dir, `${JOB_NAME}.service`), content: `[Unit]\nDescription=Update the Hrouter Market Pulse Codex plugin\n[Service]\nType=oneshot\nEnvironment=${systemd(`CODEX_HOME=${codexHome}`)}\nExecStart=${[node, ...args].map(systemdArg).join(" ")}\n` },
      { path: path.join(dir, `${JOB_NAME}.timer`), content: `[Unit]\nDescription=Check Hrouter Market Pulse stable releases every six hours\n[Timer]\nOnCalendar=*-*-* 00,06,12,18:00:00\nPersistent=true\nRandomizedDelaySec=300\n[Install]\nWantedBy=timers.target\n` },
    ], enable: [["systemctl", ["--user", "daemon-reload"]], ["systemctl", ["--user", "enable", "--now", `${JOB_NAME}.timer`]]], disable: [["systemctl", ["--user", "disable", "--now", `${JOB_NAME}.timer`]]] };
  }
  if (platform === "win32") {
    const command = ["-NoProfile", "-NonInteractive", "-Command"];
    // Interactive, limited user token: no admin rights and no password storage.
    const registration = `$a=New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps(args.map(windowsArg).join(" "))}; ` +
      `$t=New-ScheduledTaskTrigger -Once (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 6); ` +
      `$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew; ` +
      `$p=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited; ` +
      `Register-ScheduledTask -TaskName ${ps(JOB_NAME)} -Action $a -Trigger $t -Settings $s -Principal $p -Force -ErrorAction Stop | Out-Null`;
    return { kind: "windows-task", files: [], enable: [["powershell.exe", [...command, registration]]], disable: [["powershell.exe", [...command, `Unregister-ScheduledTask -TaskName ${ps(JOB_NAME)} -Confirm:$false -ErrorAction Stop`]]] };
  }
  throw new Error(`Automatic scheduling is unsupported on ${platform}; run the updater manually.`);
}

export async function configureScheduler(options, enabled, run) {
  const plan = schedulerPlan(options);
  if (enabled) {
    // Stop this product's previous job only; registration is idempotent.
    for (const [cmd, args] of plan.disable) await run(cmd, args, { allowFailure: true });
    for (const file of plan.files) {
      await mkdir(path.dirname(file.path), { recursive: true });
      await writeFile(file.path, file.content, { mode: 0o600 });
    }
    try { for (const [cmd, args] of plan.enable) await run(cmd, args); }
    catch (error) {
      for (const [cmd, args] of plan.disable) await run(cmd, args, { allowFailure: true });
      for (const file of plan.files) await rm(file.path, { force: true });
      throw new Error(`Plugin installed, but automatic scheduling failed: ${error.message}. Use "enable" to retry or "check" to update manually.`, { cause: error });
    }
  } else {
    for (const [cmd, args] of plan.disable) await run(cmd, args, { allowFailure: true });
    for (const file of plan.files) await rm(file.path, { force: true });
    if (options.platform === "linux" || (!options.platform && process.platform === "linux")) await run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  }
  return plan.kind;
}
