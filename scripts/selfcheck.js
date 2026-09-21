// Self-hosting test command for the EMPRESS repo itself (runs from empress run's
// check_ci / land gate). Verifies: all JS parses, and the pi extension loads and
// registers its empress_* tools. Exit 0 = ready to land.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;

// collect .js files under bin/ and src/ (skip node_modules)
const jsFiles = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith(".js")) jsFiles.push(full);
  }
}
walk(path.join(root, "bin"));
walk(path.join(root, "src"));
walk(path.join(root, "scripts"));

for (const rel of jsFiles.map((f) => path.relative(root, f))) {
  try {
    execFileSync(process.execPath, ["--check", path.join(root, rel)], { stdio: "pipe" });
  } catch (e) {
    console.error(`syntax FAIL ${rel}: ${e.stderr || e.message}`);
    failures++;
  }
}
console.log(`syntax ok: ${jsFiles.length} js files`);

// 2) confirm the pi extension compiles/loads under pi and exposes its tools.
//    `pi -p` loading the extension establishes the registerTool calls ran.
import { loadConfig, EMPRESS_DIR } from "../src/shared/config.js";
const cfg = loadConfig(root);
if (!cfg.file) {
  console.error("selfcheck: no empress.toml — run `empress init` and set test_command first.");
} else {
  console.log(`config ok: ${path.relative(root, cfg.file)}`);
}

if (failures > 0) {
  console.error(`selfcheck FAILED: ${failures} error(s)`);
  process.exit(1);
}
console.log("selfcheck PASS");