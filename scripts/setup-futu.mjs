// Optional, explicit setup only. Never run from build/install lifecycle hooks.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const base = process.env.HROUTER_FUTU_VENV || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "hrouter-market-pulse", "futu-venv");
const python = path.join(base, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const execute = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
};
if (!existsSync(python)) {
  const candidates = process.env.HROUTER_FUTU_PYTHON_BASE ? [process.env.HROUTER_FUTU_PYTHON_BASE] : ["python3.12", "python3.11", "python3", "python"];
  const available = candidates.find((candidate) => spawnSync(candidate, ["-c", "import sys; assert sys.version_info >= (3,10)"], { stdio: "ignore" }).status === 0);
  if (!available) throw new Error("Python 3.10+ required. Reuse an existing user-scoped Python via HROUTER_FUTU_PYTHON_BASE; no runtime is installed automatically.");
  mkdirSync(path.dirname(base), { recursive: true });
  execute(available, ["-m", "venv", base]);
}
execute(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", path.join(root, "bridges/futu/requirements.txt")]);
execute(python, ["-B", path.join(root, "bridges/futu/check_sdk.py")]);
console.log(JSON.stringify({ python, gatewayEnabled: false, environment: "SIMULATE", next: ["Start and sign in to official OpenD locally.", `Set HROUTER_FUTU_PYTHON=${python} and HROUTER_FUTU_ENABLED=1 in the plugin process environment; restart plugin.`, "Authorize one bounded experiment in the Paper trading menu. REAL remains disabled."] }, null, 2));
