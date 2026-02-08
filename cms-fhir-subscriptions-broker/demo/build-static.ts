#!/usr/bin/env bun
// Build script: produces a docs/ directory for static hosting (GitHub Pages).
// Usage: bun run demo/build-static.ts
// Set BASE_PATH env var for non-root hosting, e.g.: BASE_PATH=/cms-fhir-subscriptions-broker

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";

const ROOT = resolve(dirname(import.meta.dir), "docs");
const DEMO = import.meta.dir;

// Base path for non-root hosting (e.g., GitHub Pages with custom domain)
// Must start with / and NOT end with / (or be empty for root hosting)
let BASE = (process.env.BASE_PATH || "").replace(/\/+$/, "");
if (BASE && !BASE.startsWith("/")) BASE = "/" + BASE;

console.log(`[build] Base path: "${BASE || "/"}"`);

// Clean & create output dirs
mkdirSync(ROOT, { recursive: true });
mkdirSync(`${ROOT}/client`, { recursive: true });
mkdirSync(`${ROOT}/broker`, { recursive: true });
mkdirSync(`${ROOT}/mercy-ehr`, { recursive: true });

// 1. Bundle static-runtime.ts → docs/static-runtime.js
console.log("[build] Bundling static runtime...");
const result = await Bun.build({
  entrypoints: [`${DEMO}/static-runtime.ts`],
  outdir: ROOT,
  target: "browser",
  format: "esm",
  naming: "static-runtime.js",
  define: {
    "__STATIC_MODE__": "true",
    "__BASE_PATH__": JSON.stringify(BASE),
    "import.meta.dir": "''",
  },
});
if (!result.success) {
  console.error("[build] Bundle failed:");
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("[build] → docs/static-runtime.js");

// 1b. Bundle static-bridge.ts → docs/static-bridge.js (for sub-page tabs)
console.log("[build] Bundling static bridge...");
const bridgeResult = await Bun.build({
  entrypoints: [`${DEMO}/static-bridge.ts`],
  outdir: ROOT,
  target: "browser",
  format: "iife",
  naming: "static-bridge.js",
  define: {
    "__STATIC_MODE__": "true",
    "__BASE_PATH__": JSON.stringify(BASE),
  },
});
if (!bridgeResult.success) {
  console.error("[build] Bridge bundle failed:");
  for (const log of bridgeResult.logs) console.error(log);
  process.exit(1);
}
console.log("[build] → docs/static-bridge.js");

// 2. Config values for static mode
const STATIC_CONFIG = `<script>
var __BROKER__ = "${BASE}/broker";
var __CLIENT__ = "${BASE}/client";
var __EHR__ = "${BASE}/mercy-ehr";
var __DASHBOARD__ = "${BASE}/";
var __STATIC__ = true;
</script>`;

const STATIC_CONFIG_WITH_BASE = (base: string) => `<script>
var __BROKER__ = "${BASE}/broker";
var __CLIENT__ = "${BASE}/client";
var __EHR__ = "${BASE}/mercy-ehr";
var __DASHBOARD__ = "${BASE}/";
var __BASE__ = "${BASE}${base}";
var __STATIC__ = true;
</script>`;

const RUNTIME_SCRIPT = `<script type="module" src="${BASE}/static-runtime.js"></script>`;
const BRIDGE_SCRIPT = `<script src="${BASE}/static-bridge.js"></script>`;

// 3. Copy & inject dashboard.html → docs/index.html
const dashboardHtml = readFileSync(`${DEMO}/dashboard.html`, "utf-8");
const injectedDashboard = dashboardHtml
  .replace("</head>", STATIC_CONFIG + "\n" + RUNTIME_SCRIPT + "\n</head>");
writeFileSync(`${ROOT}/index.html`, injectedDashboard);
console.log("[build] → docs/index.html (dashboard)");

// 4. Copy UI HTML files with config injection
function copyUiHtml(srcPath: string, destPath: string, base: string) {
  const html = readFileSync(srcPath, "utf-8");
  // Sub-pages get the bridge (BroadcastChannel to main page), not the full runtime
  const injected = html.replace("</head>", STATIC_CONFIG_WITH_BASE(base) + "\n" + BRIDGE_SCRIPT + "\n</head>");
  writeFileSync(destPath, injected);
}

copyUiHtml(`${DEMO}/client/ui.html`, `${ROOT}/client/index.html`, "/client");
console.log("[build] → docs/client/index.html");

copyUiHtml(`${DEMO}/broker/ui.html`, `${ROOT}/broker/index.html`, "/broker");
console.log("[build] → docs/broker/index.html");

copyUiHtml(`${DEMO}/data-source/ui.html`, `${ROOT}/mercy-ehr/index.html`, "/mercy-ehr");
console.log("[build] → docs/mercy-ehr/index.html");

console.log("\n[build] Done! Serve with: bunx serve docs");
