// Build the workbench UI (web/, React + TypeScript + Tailwind) into assets/app/ with Vite.
import { build } from "vite";
await build({ configFile: "web/vite.config.ts", logLevel: "warn" });
console.log("Built the workbench UI into assets/app/.");
