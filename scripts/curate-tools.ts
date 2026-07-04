/**
 * Tool Curation — ADR-0059
 * Post-processes compiled JS to filter out 25 deprecated tools.
 * Usage: npx tsx scripts/curate-tools.ts [--dry-run]
 */

import { readFileSync, writeFileSync } from "fs";

const REMOVED_TOOLS = [
  "thermal_check","thermal_forensics","thermal_warroom",
  "rebuild_safety_check","laptop_verdict","full_investigation",
  "force_cooldown","reset_performance",
  "emergency_abort","emergency_cooldown","emergency_nuke","emergency_swap",
  "browser_launch_advanced","browser_extract_data",
  "browser_interact_form","browser_monitor_changes",
  "osint_dns","osint_subdomains","osint_portscan","web_crawl",
  "tech_news_search","crypto_key_generate","build_and_test",
  "security_audit","browser_search_aggregate",
];

const DRY_RUN = process.argv.includes("--dry-run");
const BUILD_PATH = "build/src/server/tool-registry.js";

let content = readFileSync(BUILD_PATH, "utf-8");

// Revert any previous curation
content = content.replace(/\/\* ADR-0059 curation \*\/[\s\S]*?\)\]\);/g, "]; // end buildToolCatalog");
content = content.replace(/return \(\(\[/g, "return [");

const marker = "// end buildToolCatalog";
const lines = content.split("\n");
const markerLine = lines.findIndex((l) => l.includes(marker));
if (markerLine === -1) { console.error("ERROR: marker not found"); process.exit(1); }

const filterCode =
  ".filter(function(t){" +
  "/* ADR-0059 curation */" +
  "var r=" + JSON.stringify(REMOVED_TOOLS) + ";" +
  "return r.indexOf(t.name)===-1;" +
  "})";

// Replace the closing bracket: ]; → filterCode + ]);
// Also strip trailing comma from previous line
lines[markerLine] = lines[markerLine].replace("];", filterCode + "]);");

// Find the last element line before the filter and remove trailing comma
for (let i = markerLine - 1; i >= 0; i--) {
  const trimmed = lines[i].trimEnd();
  if (trimmed.endsWith(",")) {
    lines[i] = trimmed.slice(0, -1); // remove trailing comma
    break;
  }
}

// Wrap return in parens: return [ → return ([
for (let i = markerLine - 1; i >= 0; i--) {
  if (lines[i].includes("return [") || lines[i].includes("return[")) {
    lines[i] = lines[i].replace("return [", "return ([");
    break;
  }
}

content = lines.join("\n");

console.log(`ADR-0059 Tool Curation — ${DRY_RUN ? "DRY RUN" : "APPLIED"}`);

if (!DRY_RUN) {
  writeFileSync(BUILD_PATH, content, "utf-8");
  console.log("  ✅ Written");
} else {
  console.log("  (dry run)");
}
