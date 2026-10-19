// Optional, explicit setup only. Never run from build/install lifecycle hooks.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const base = process.env.HROUTER_IBKR_VENV || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "hrouter-market-pulse", "ibkr-venv");
const python = path.join(base, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const execute = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} exited ${result.status}`);
};
if (!existsSync(python)) {
  const candidates = process.env.HROUTER_IBKR_PYTHON_BASE ? [process.env.HROUTER_IBKR_PYTHON_BASE] : ["python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"];
  const available = candidates.find((candidate) => spawnSync(candidate, ["-c", "import sys; assert sys.version_info >= (3,10)"], { stdio: "ignore" }).status === 0);
  if (!available) throw new Error("Python 3.10+ required. Point HROUTER_IBKR_PYTHON_BASE at an existing Python; no runtime is installed automatically.");
  mkdirSync(path.dirname(base), { recursive: true });
  execute(available, ["-m", "venv", base]);
}
execute(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", path.join(root, "bridges/ibkr/requirements.txt")]);
execute(python, ["-B", path.join(root, "bridges/ibkr/check_sdk.py")]);
console.log(JSON.stringify({ python, next: ["Install TWS or IB Gateway, log in (paper first), and in its API settings enable socket clients and trust 127.0.0.1.", `In the workbench open 设置 → 券商连接 → Interactive Brokers, set Python to ${python} and the port (TWS paper 7497 / live 7496, Gateway paper 4002 / live 4001).`, "Connect, pick the paper account, set the allowlist and limits. LIVE needs a separate opt-in and your confirmation on every order."] }, null, 2));
