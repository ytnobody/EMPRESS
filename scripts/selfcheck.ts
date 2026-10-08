// EMPRESS self-check — the CI gate (test_command). Bun-based (the CLI is bun;
// the [ci] container uses oven/bun too, so runtime is consistent).
//
// Running `bun test` imports every test module, which transitively imports the
// whole src tree — so the test suite doubles as the syntax/import check (the
// old per-file `node --check` walk is unnecessary on bun).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMPRESS_DIR, loadConfig } from "../src/shared/config.ts";
import { AGENTS_SRC, PROMPTS_SRC } from "../src/cli/init.ts";
import { installDrift, installReport } from "../src/domain/install.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const cfg = loadConfig(root);
if (!cfg.file) {
  console.error("selfcheck: no empress.toml — run `empress init` first.");
  failures++;
} else {
  console.log(`config ok: ${path.relative(root, cfg.file)}`);
}

// Install-in-sync (Task #81): the committed runtime copies (.empress/agents,
// .pi/prompts) must be byte-identical to the bundled src/ sources — the same
// dirs `empress init` copies from. Drift means the harness runs stale prompts.
const drift = installDrift([
  { label: "agents", src: AGENTS_SRC, dest: path.join(root, EMPRESS_DIR, "agents") },
  { label: "prompts", src: PROMPTS_SRC, dest: path.join(root, ".pi", "prompts") },
]);
if (drift.length) {
  console.error(`install-in-sync FAIL: ${installReport(drift)}`);
  failures++;
} else {
  console.log("install-in-sync: PASS");
}

// Type check (tsc --noEmit): the project is fully typed (371 -> 0); this step
// makes the zero-error state an enforced rule, not just a snapshot. Requires
// typescript resolvable (host: devDeps; [ci] container: baked into the image).
try {
  execFileSync(process.execPath, ["typecheck"], { stdio: "inherit" });
  console.log("typecheck: PASS");
} catch (e) {
  console.error(`typecheck FAIL: ${errMsg(e)}`);
  failures++;
}

try {
  execFileSync(process.execPath, ["test", path.join(root, "test")], { stdio: "inherit" });
  console.log("unit tests: PASS");
} catch (e) {
  console.error(`unit tests FAIL: ${errMsg(e)}`);
  failures++;
}

if (failures > 0) {
  console.error(`selfcheck FAILED: ${failures} error(s)`);
  process.exit(1);
}
console.log("selfcheck PASS");