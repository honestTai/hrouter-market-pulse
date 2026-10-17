// 打包前把可安装插件（本机服务 bundle、界面、skill、内置交易员库）放进 src-tauri/resources/plugin，随安装包分发。
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const plugin = path.join(root, "plugins", "hrouter-market-pulse");
const out = path.join(import.meta.dirname, "src-tauri", "resources", "plugin");
if (!fs.existsSync(path.join(plugin, "mcp", "server.bundle.mjs"))) throw new Error(`缺少 ${plugin}，先在仓库根目录运行 npm run build`);
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(plugin, out, { recursive: true });
console.log("resources ready:", out);
