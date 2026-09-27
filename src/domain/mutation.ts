// Mutation-testing engine (bun-native) + Jev survivor classification.
//
// Deterministic detector for weak / meaningless tests: mutate a behavior-bearing
// source file, run its test, and see whether the test kills the mutant. A test
// that survives every behavior-changing mutant (score ~0%) is a tautology /
// weak test. Survivors are then classified by Jev into *equivalent (benign)* vs
// *genuine gap / weak test*, so equivalent-mutant noise is tolerated.
//
// NOTE: Stryker doesn't support the `bun test` runner, so this is a small
// purpose-built engine matching the repo's bun stack (Ponytail, stdlib-first).
import * as fs from "node:fs";
import * as path from "node:path";
import { run, type RunOpts, type RunResult } from "../shared/shell.ts";

export interface Mutant {
  id: string;
  source: string;
}

export interface MutationReport {
  relSrc: string;
  test: string;
  killed: number;
  total: number;
  survivors: string[];
  score: number;
}

export interface MutationOptions {
  _run?: (cmd: string, args: string[], opts?: RunOpts) => RunResult;
}

function swapAll(source: string, pairs: Array<[string, string]>): Mutant[] {
  const out: Mutant[] = [];
  for (const [a, b] of pairs) {
    if (source.includes(a)) {
      const swapped = source.split(a).join(b);
      out.push({ id: `${a.trim()}->${b.trim()}`, source: swapped });
    }
  }
  return out;
}

function bumpNumeric(source: string): Mutant[] {
  const out: Mutant[] = [];
  const re = /\b(\d+)\b/g;
  let m: RegExpExecArray | null;
  let offset = 0;
  while ((m = re.exec(source)) !== null) {
    const num = parseInt(m[1], 10);
    const bumped = String(num + 1);
    const mutated = source.slice(0, m.index) + bumped + source.slice(m.index + m[1].length);
    // advance the regex past the replaced token to avoid infinite re-bump
    out.push({ id: `const+1:${m[1]}`, source: mutated });
    re.lastIndex = m.index + bumped.length;
    offset++;
    if (offset >= 12) break; // cap
  }
  return out;
}

/**
 * Small, safe set of behavior-changing text mutations applied to SOURCE code
 * (never to the tests). Capped to keep runtime bounded.
 */
export function collectMutants(source: string): Mutant[] {
  const out: Mutant[] = [
    ...swapAll(source, [["===", "!=="], ["!==", "==="], ["<=", ">"], ["<", ">="], ["&&", "||"], ["true", "false"], ["false", "true"]]),
    ...bumpNumeric(source),
  ];
  // de-dupe by source + id, drop no-op (unchanged) mutants
  const seen = new Set<string>();
  return out
    .filter((mt) => mt.source !== source)
    .filter((mt) => {
      const k = `${mt.id}|${mt.source}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 60);
}

/** Map each `src/**\/*.ts` module -> a `test/*.test.mjs` that imports it (by scanning test imports). */
export function findTests(cwd: string, testDir = "test"): Map<string, string> {
  const map = new Map<string, string>();
  let dir: string[] = [];
  try {
    dir = fs.readdirSync(path.join(cwd, testDir));
  } catch {
    return map;
  }
  for (const f of dir) {
    if (!f.endsWith(".test.mjs")) continue;
    const fp = path.join(cwd, testDir, f);
    let content = "";
    try {
      content = fs.readFileSync(fp, "utf-8");
    } catch {
      continue;
    }
    for (const m of content.matchAll(/(?:from\s+|import\s+)["']\.\.\/(src\/[^"']+)["']/g)) {
      const modRel = m[1].replace(/\.js$/, ".ts");
      if (!map.has(modRel)) map.set(modRel, path.join(testDir, f));
    }
  }
  return map;
}

/** Which changed src files have tests, bounded by max_files. */
export function mutationTargets(
  cwd: string,
  changed: string[],
  testIndex: Map<string, string>,
  maxFiles: number
): Array<{ relSrc: string; test: string }> {
  const out: Array<{ relSrc: string; test: string }> = [];
  for (const rel of changed) {
    if (!rel.startsWith("src/") || !rel.endsWith(".ts")) continue;
    const test = testIndex.get(rel);
    if (!test) continue;
    out.push({ relSrc: rel, test });
    if (out.length >= maxFiles) break;
  }
  return out;
}

/**
 * Run mutation on one changed src file: for each mutant, write it over the real
 * file (try/finally restores it), run the file's test, count killed vs survivors.
 * `_run` is injectable for tests.
 */
export function runMutations(cwd: string, relSrc: string, test: string, opts: MutationOptions = {}): MutationReport {
  const exec = opts._run ?? run;
  const srcPath = path.join(cwd, relSrc);
  const original = fs.readFileSync(srcPath, "utf-8");
  const mutants = collectMutants(original);
  let killed = 0;
  const survivors: string[] = [];
  for (const m of mutants) {
    fs.writeFileSync(srcPath, m.source);
    try {
      const res = exec("bun", ["test", test], { cwd });
      if (res.code === 0) survivors.push(m.id); // test still passed on mutated code -> survived
      else killed++;
    } finally {
      fs.writeFileSync(srcPath, original); // always restore the real file
    }
  }
  const total = mutants.length;
  const score = total > 0 ? killed / total : 1;
  return { relSrc, test, killed, total, survivors, score };
}