// Build the workbench UI (web/, React + TypeScript + Tailwind) into assets/app/ with Vite.
import { build } from "vite";
const result = await build({ configFile: "web/vite.config.ts", logLevel: "warn" });
// Packages that end up in the shipped UI (script modules, the fonts the stylesheet inlines,
// plus Tailwind, whose preflight is compiled into app.css), so licenses are collected only for these.
const modules = [result].flat().flatMap((output) => output.output).flatMap((chunk) => (chunk.type === "chunk" ? chunk.moduleIds : []));
export const uiPackages = [
  ...modules.map(packageOf).filter(Boolean),
  packageOf("node_modules/@fontsource-variable/geist/index.css"),
  packageOf("node_modules/@fontsource-variable/geist-mono/index.css"),
  packageOf("node_modules/tailwindcss/preflight.css"),
];
console.log("Built the workbench UI into assets/app/.");

// { name, dir } of the package a bundled file belongs to (nested node_modules included), or null.
export function packageOf(path) {
  const match = path.replaceAll("\\", "/").match(/^\0?(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  return match ? { name: match[2], dir: match[1] } : null;
}
