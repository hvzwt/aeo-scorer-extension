import { build } from "esbuild";
import { cpSync, rmSync, mkdirSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
for (const f of ["manifest.json", "background.js", "content.js", "sidepanel.html", "sidepanel.css", "icons"]) {
  cpSync(`src/${f}`, `dist/${f}`, { recursive: true });
}
cpSync("node_modules/axe-core/axe.min.js", "dist/axe.min.js");
await build({
  entryPoints: ["src/sidepanel.js"],
  bundle: true,
  format: "esm",
  target: "chrome116",
  outfile: "dist/sidepanel.js",
  legalComments: "none",
  minify: true,
  logLevel: "info",
});
