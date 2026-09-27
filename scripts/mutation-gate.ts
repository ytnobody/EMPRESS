// Optional CI mutation gate — the same deterministic weak-test detector as the
// `empress_check_mutation` tool (which stays canonical), runnable outside the pi
// harness (GitHub Actions, local shells).
//
//   bun scripts/mutation-gate.ts [--base <git-ref>] [--max-files N] [--max-mutants N]
//
// Scope: the changed `src/*.ts` files of the current branch that have tests
// (git diff <base>...HEAD; base = --base | GITHUB_BASE_REF | origin/<config
// base_branch>), capped by --max-files / --max-mutants to keep CI bounded.
// Output includes the score, the survivor list, and the Jev genuine-gap count;
// exit 0 = pass, 1 = hold for review.
//
// Opt-in: when `[mutation] enabled=false` in empress.toml it prints a note and
// exits 0 (delete the workflow file to turn the CI job off entirely). Jev needs
// TYPESAFE_API_KEY; without it, survivors are reported unclassified and only
// min_score gates (identical to the local gate's no-Jev fallback).
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/shared/config.ts";
import { run } from "../src/shared/shell.ts";
import { diffBetween } from "../src/domain/git.ts";
import { runMutationGate } from "../src/domain/mutation.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function int(name: string, fallback: number): number {
  const v = Number(flag(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const cfg = loadConfig(root);
const mc = cfg.mutation;
if (!mc.enabled) {
  console.log("mutation-gate: DISABLED ([mutation] enabled=false) — skipped");
  process.exit(0);
}

const maxFiles = int("--max-files", mc.max_files ?? 3);
const maxMutants = int("--max-mutants", mc.max_mutants ?? 60);
const base =
  flag("--base") ||
  (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : `origin/${cfg.project.base_branch}`);

const changed = diffBetween(root, base, "HEAD").changed;
if (changed.length === 0) {
  console.log(`mutation-gate: no changed files (base=${base}) — skipped`);
  process.exit(0);
}

const gate = await runMutationGate(root, changed, {
  minScore: mc.min_score,
  maxFiles,
  maxMutants,
  jevModel: cfg.jev.model,
  // bound each bun test run so a hanging test cannot stall the job forever
  run: (cmd, args, opts) => run(cmd, args, { ...(opts || {}), timeout: 120_000 }),
});

console.log(`mutation-gate: base=${base} changed=${changed.length} file(s), targets=${gate.reports.length}`);
for (const r of gate.reports) {
  const surv = r.survivors.length ? ` survivors: [${r.survivors.join(", ")}]` : "";
  console.log(`  ${r.relSrc}: ${r.killed}/${r.total} killed (score ${r.score.toFixed(2)})${surv}`);
}
console.log(
  `mutation-gate: score=${gate.score.toFixed(2)} survivors=${gate.survivors.length} jev=${gate.jevNote} genuine_gaps=${gate.genuine}`
);

if (!gate.ok) {
  console.error(
    "mutation-gate: FAIL — a changed file is below min_score or a survivor is a genuine gap; hold for review"
  );
  process.exit(1);
}
console.log(`mutation-gate: PASS (min_score ${mc.min_score})`);