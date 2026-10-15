import { build } from "esbuild";
await build({
  entryPoints: ["ui/main.jsx"], bundle: true, platform: "browser", format: "iife", target: ["es2022"],
  // Escape dependency CSS template strings so generated files stay whitespace-clean.
  supported: { "template-literal": false },
  jsx: "automatic", minify: true, sourcemap: false, legalComments: "linked",
  define: { "process.env.NODE_ENV": '"production"' }, outfile: "assets/dashboard.js",
});
console.log("Bundled React workspace and Radix styles into local dashboard assets.");
