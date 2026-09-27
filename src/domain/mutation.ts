// Mutation-testing engine (bun-native) + Jev survivor classification.
//
// Deterministic detector for weak / meaningless tests: mutate a behavior-bearing
// source file, run its test, and see whether the test kills the mutant. A test
// that survives every behavior-changing mutant (score ~0%) is a tautology /
// weak test. Survivors are then classified by Jev into *equivalent (benign)* vs
// *genuine gap / weak test*, so equivalent-mutant noise is tolerated.
//
// Shared by the `empress_check_mutation` tool (Superintendent review pass) and
// the optional CI mutation job (`scripts/mutation-gate.ts`); the tool is the
// canonical gate.
//
// NOTE: Stryker doesn't support the `bun test` runner, so this is a small
// purpose-built engine matching the repo's bun stack (Ponytail, stdlib-first).

import * as fs from "node:fs";
import * as path from "node:path";
import { run, type RunOpts, type RunResult } from "../shared/shell.ts";
import { jevAvailable, jevJudge } from "./jev.ts";

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
  /** Mutant cap per file (default 60); configured via [mutation] max_mutants. */
  maxMutants?: number;
}

// Below: token-aware mutation operators -------------------------------------

/** Chars that can extend an operator token (`==`, `++`, `>=`, `&&=`, ...). */
const OP_CHARS = "=!<>+\\-&|*%";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `index` in `source` sits inside a `//` line or `/*` block comment.
 *  Conservative on stray `//`/`/*` inside string literals (over-skips, which
 *  only removes a mutant — never invalidates one). */
function inComment(source: string, index: number): boolean {
  let line = false;
  let block = false;
  let i = 0;
  while (i < index) {
    const c = source[i];
    if (line) {
      if (c === "\n") line = false;
      i++;
    } else if (block) {
      if (c === "*" && source[i + 1] === "/") {
        block = false;
        i += 2;
      } else i++;
    } else if (c === "/" && source[i + 1] === "/") {
      line = true;
      i += 2;
    } else if (c === "/" && source[i + 1] === "*") {
      block = true;
      i += 2;
    } else i++;
  }
  return line || block;
}

/**
 * Replace every standalone occurrence of token `a` with `b`. Operator tokens
 * must not be adjacent to another operator char, so `==` inside `===`/`!==`,
 * `++`, `+=`, `>=`, `&&=` are never split apart; word tokens must sit at word
 * boundaries, so `truthy` / `nullish` identifiers are never corrupted. Returns
 * null when `a` does not occur (no mutant) or the swap is a no-op.
 */
function swapToken(source: string, a: string, b: string, word = false): string | null {
  const esc = escapeRegex(a);
  const re = new RegExp(word ? `\\b${esc}\\b` : `(?<![${OP_CHARS}])${esc}(?![${OP_CHARS}])`, "g");
  if (!re.test(source)) return null;
  re.lastIndex = 0;
  let out = "";
  let last = 0;
  let changed = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out += source.slice(last, m.index);
    if (inComment(source, m.index)) {
      out += m[0]; // comment text is behavior-neutral — never mutate it
    } else {
      out += b;
      changed = true;
    }
    last = m.index + m[0].length;
  }
  out += source.slice(last);
  return changed ? out : null;
}

/** Operator-pair table: each entry yields one whole-source mutant (`a`→`b`). */
const OPERATOR_PAIRS: Array<[string, string]> = [
  // equality negate
  ["===", "!=="],
  ["!==", "==="],
  // relational flips
  ["<=", ">"],
  ["<", ">="],
  [">", "<"],
  [">=", "<="],
  // logical (both directions)
  ["&&", "||"],
  ["||", "&&"],
  // equality strictness
  ["===", "=="],
  ["==", "==="],
  ["==", "!="],
  ["!=", "=="],
  // arithmetic
  ["+", "-"],
  ["-", "+"],
];

/** Word-token pairs (matched at word boundaries only). */
const WORD_PAIRS: Array<[string, string]> = [
  ["true", "false"],
  ["false", "true"],
  ["null", "undefined"],
  ["undefined", "null"],
  ["Math.min", "Math.max"],
  ["Math.max", "Math.min"],
];

function bumpNumeric(source: string): Mutant[] {
  const out: Mutant[] = [];
  const re = /\b(\d+)\b/g;
  let m: RegExpExecArray | null;
  let offset = 0;
  while ((m = re.exec(source)) !== null) {
    if (inComment(source, m.index)) {
      re.lastIndex = m.index + m[1].length; // skip behavior-neutral comment numbers
      continue;
    }
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
 * (never to the tests). Token-aware so composite operators in real code are
 * never split into junk; word tokens match at word boundaries. Capped to keep
 * runtime bounded (default 60; [mutation] max_mutants overrides it).
 */
export function collectMutants(source: string, maxMutants = 60): Mutant[] {
  const out: Mutant[] = [];
  for (const [a, b] of OPERATOR_PAIRS) {
    const m = swapToken(source, a, b);
    if (m) out.push({ id: `${a}->${b}`, source: m });
  }
  for (const [a, b] of WORD_PAIRS) {
    const m = swapToken(source, a, b, true);
    if (m) out.push({ id: `${a}->${b}`, source: m });
  }
  out.push(...bumpNumeric(source));
  // de-dupe by id + source (pairs can't collide today; cheap guard anyway)
  const seen = new Set<string>();
  return out
    .filter((mt) => {
      const k = `${mt.id}|${mt.source}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, maxMutants);
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
  const mutants = collectMutants(original, opts.maxMutants ?? 60);
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

// --- Shared gate orchestration (tool + CI script) ---------------------------

export interface Survivor {
  file: string;
  id: string;
}

export interface MutationGateOptions {
  minScore: number;
  maxFiles: number;
  maxMutants: number;
  /** Injectable test runner (default: the real `run`). */
  run?: (cmd: string, args: string[], opts?: RunOpts) => RunResult;
  /** Injectable survivor classifier; default = Jev noul, >= 0.7 is genuine. */
  classify?: (survivors: Survivor[]) => Promise<{ genuine: number; note: string }>;
  jevModel?: string;
}

export interface MutationGateResult {
  reports: MutationReport[];
  survivors: Survivor[];
  lowFiles: MutationReport[];
  genuine: number;
  jevNote: string;
  score: number;
  ok: boolean;
}

/**
 * Deterministic weak-test gate over a set of changed files: mutate the changed
 * src files that have tests (bounded), count killed vs survivors per file,
 * classify survivors (Jev by default), and return the report + verdict.
 * Verdict: not ok when any file is below minScore or any survivor is a genuine
 * gap. Effect-free except through `_run`-style injections + the classify
 * callback (network), both injectable for verification arithmetic.
 */
export async function runMutationGate(
  cwd: string,
  changed: string[],
  opts: MutationGateOptions
): Promise<MutationGateResult> {
  const testIndex = findTests(cwd);
  const targets = mutationTargets(cwd, changed, testIndex, opts.maxFiles);
  const reports = targets.map((x) =>
    runMutations(cwd, x.relSrc, x.test, { _run: opts.run, maxMutants: opts.maxMutants })
  );
  const survivors: Survivor[] = reports.flatMap((r) => r.survivors.map((id) => ({ file: r.relSrc, id })));
  const lowFiles = reports.filter((r) => r.total > 0 && r.score < opts.minScore);
  const classify = opts.classify ?? ((s: Survivor[]) => defaultClassify(s, opts.jevModel));
  const { genuine, note } = await classify(survivors);
  const jevNote = survivors.length ? note : "no survivors";
  const score = reports.length ? reports.reduce((a, r) => a + r.score, 0) / reports.length : 1;
  const ok = lowFiles.length === 0 && genuine === 0;
  return { reports, survivors, lowFiles, genuine, jevNote, score, ok };
}

/** Default survivor classification: Jev noul >= 0.7 -> genuine gap / weak test. */
async function defaultClassify(
  survivors: Survivor[],
  jevModel?: string
): Promise<{ genuine: number; note: string }> {
  if (survivors.length === 0) return { genuine: 0, note: "no survivors" };
  if (!jevAvailable().available) return { genuine: 0, note: "unclassified (no Jev)" };
  const states = survivors.map(
    (s) =>
      `File ${s.file}: mutant "${s.id}" survived — the test did NOT fail when the source was changed this way. Is this an equivalent/benign mutant, or a genuine gap where the test fails to verify the changed behavior (weak/meaningless assertion)?`
  );
  const j = await jevJudge({
    type: "noul",
    instructions:
      "For each surviving mutant: high noul means it is a GENUINE GAP / weak test (must review); low noul means it is an EQUIVALENT, benign mutant.",
    states,
    model: jevModel || "jev-latest",
  });
  if (!j.ok) return { genuine: 0, note: `jev failed: ${j.error}` };
  const genuine = j.results.reduce<number>(
    (acc, r) => acc + (r.answer && typeof r.answer.noul === "number" && r.answer.noul >= 0.7 ? 1 : 0),
    0
  );
  return { genuine, note: `classified ${j.results.length} survivor(s)` };
}