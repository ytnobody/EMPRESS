// Mutation-testing engine tests: mutant collection, src->test mapping, score accounting.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectMutants, findTests, mutationTargets, runMutationGate, runMutations } from "../src/domain/mutation.js";

const SRC = `export function f(x: number): number {
  const a = 1;
  return a === x && x < 10 ? a : 0;
}`;

test("mutation: collectMutants yields behavior-changing variants, never a no-op", () => {
  const ms = collectMutants(SRC);
  assert.ok(ms.length >= 2, `expected several mutants, got ${ms.length}`);
  for (const m of ms) {
    assert.notEqual(m.source, SRC, `mutant "${m.id}" must differ from source`);
    assert.ok(m.source.includes("export function f"), `mutant "${m.id}" must stay same-shaped`);
  }
  // specific operators present
  const all = ms.map((m) => m.id).join(" ");
  assert.ok(/===/.test(all) || /!==/.test(all), "operator-swap mutants expected");
});

test("mutation: findTests maps a module to its test via import scan", () => {
  const root = process.cwd(); // this repo
  const map = findTests(root);
  const t = map.get("src/domain/readiness.ts");
  assert.ok(t, "src/domain/readiness.ts should map to a test (wake.test.mjs)");
  assert.ok(t.endsWith(".test.mjs"), `expected a test file, got ${t}`);
});

test("mutation: mutationTargets selects changed src files that have tests", () => {
  const root = process.cwd();
  const map = findTests(root);
  const targets = mutationTargets(root, ["src/domain/readiness.ts", "README.md", "not-a-file.ts"], map, 5);
  assert.deepEqual(targets.map((t) => t.relSrc), ["src/domain/readiness.ts"]);
  assert.ok(targets[0].test.endsWith(".test.mjs"));
});

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-mut-"));
  fs.mkdirSync(path.join(dir, "src", "domain"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "domain", "foo.ts"), SRC);
  // mapping test: imports the module so findTests can index src/domain/foo.ts
  fs.writeFileSync(path.join(dir, "test", "foo.test.mjs"), `import { f } from "../src/domain/foo.js";
`);
  return dir;
}

test("mutation: runMutations counts kill vs survivor with an injected runner", () => {
  const dir = tmpProject();
  try {
    // runner returns exit 0 -> every mutant survives (score 0)
    const survive = runMutations(dir, "src/domain/foo.ts", "test/foo.test.mjs", {
      _run: () => ({ code: 0, stdout: "", stderr: "", signal: null }),
    });
    assert.equal(survive.killed, 0);
    assert.ok(survive.survivors.length > 0);
    assert.equal(survive.score, 0);
    // runner returns exit 1 -> every mutant killed (score 1)
    const kill = runMutations(dir, "src/domain/foo.ts", "test/foo.test.mjs", {
      _run: () => ({ code: 1, stdout: "", stderr: "", signal: null }),
    });
    assert.equal(kill.killed, kill.total);
    assert.deepEqual(kill.survivors, []);
    assert.equal(kill.score, 1);
    // real file restored
    assert.equal(fs.readFileSync(path.join(dir, "src", "domain", "foo.ts"), "utf-8"), SRC);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies: every new operator class (strictness, loose equality, reversed
// logical, arithmetic, null-ish, Math swap, remaining relational flips) yields a
// behavior-bearing mutant on a crafted source — ids are the operator table's
// `a->b` labels, derived from the design doc, not from the implementation.
test("mutation: expanded operator table covers each new class", () => {
  const src = `export function f(x: number, s: string): number {
  const loose = x == 1;
  const strict = x === 1;
  const notEq = x != 1;
  const rel = x >= 1 && x <= 2;
  const neg = !rel || s === "a";
  const ar = x + 1 - 2;
  const mm = Math.min(x, 2) > Math.max(x, 1);
  const nu = null != undefined;
  return neg ? strict ? 1 : 0 : mm && rel && ar > 0 && nu ? 1 : 0;
}`;
  const all = collectMutants(src).map((m) => m.id).join(" ");
  for (const want of [
    "==->===", "===->==", "==->!=", "!=->==",  // equality strictness / negate
    ">-><", ">=-><=",                            // remaining relational flips
    "||->&&",                                     // reversed logical
    "+->-", "-->+",                              // arithmetic
    "null->undefined", "undefined->null",         // null-ish interchange
    "Math.min->Math.max", "Math.max->Math.min",   // method swap
  ]) {
    assert.ok(all.includes(want), `expected mutant id ${want}`);
  }
});

// Verifies: token-aware swapping never splits composite operators — `==` inside
// `===`/`!==`, `++`, `+=`, `>=` stay whole while standalone counterparts mutate.
test("mutation: token-aware swaps never corrupt composite operator tokens", () => {
  const src = `export function f(a: boolean, b: boolean, x: number, y: number): number {
  let i = 1;
  i += 2;
  const eqs = a === b;
  const neq = a !== b;
  const ge = x >= y;
  const lt = x <= y;
  return eqs && neq && ge && lt && i++ > 0 ? 1 : 0;
}`;
  const ms = collectMutants(src);
  assert.ok(ms.length >= 8, `expected several mutants, got ${ms.length}`);
  for (const m of ms) {
    assert.ok(!m.source.includes("===="), `"${m.id}" corrupts ===`);
    assert.ok(!m.source.includes(">=<"), `"${m.id}" splits >=`);
    assert.ok(!m.source.includes("i + +"), `"${m.id}" splits ++`);
    assert.ok(!m.source.includes("i + ="), `"${m.id}" splits +=`);
    assert.ok(!m.source.includes("i -="), `"${m.id}" swaps += to something else`);
  }
  const ids = ms.map((m) => m.id).join(" ");
  // standalone forms still mutate
  assert.ok(ids.includes(">-><"), "standalone > still flipped");
  assert.ok(ids.includes(">=-><="), "standalone >= still flipped whole");
  assert.ok(ids.includes("&&->||"), "&& still swapped");
  assert.ok(ids.includes("===->=="), "=== still loosened");
});

// Verifies: tokens (operators, word literals, numbers) inside comments are never
// mutated — they are behavior-neutral noise that would only pollute the score —
// while the same tokens in code still produce mutants.
test("mutation: comment-located tokens are never mutated", () => {
  const src = `// a === b && x < 10, threshold 1
const ok = a === b && x < 10;
`;
  const comment = "// a === b && x < 10, threshold 1";
  const ms = collectMutants(src);
  assert.ok(ms.length >= 2, `expected several mutants, got ${ms.length}`);
  for (const m of ms) {
    assert.ok(m.source.includes(comment), `comment text changed by "${m.id}"`);
  }
  // code tokens still mutate
  const ids = ms.map((m) => m.id);
  assert.ok(ids.includes("===->!=="), "=== in code still swapped");
  assert.ok(ids.includes("const+1:10"), "number in code still bumped");
});

// Verifies: runMutationGate (the shared orchestration behind both the tool and
// the CI script) reports score + survivors + genuine-gap count and derives the
// verdict from them, with injectable run/classify so no test ever runs `bun`.
test("mutation: runMutationGate verdict with injected runners", async () => {
  const dir = tmpProject();
  try {
    const pass = await runMutationGate(dir, ["src/domain/foo.ts"], {
      minScore: 0.8,
      maxFiles: 3,
      maxMutants: 60,
      run: () => ({ code: 1, stdout: "", stderr: "", signal: null }), // test fails on every mutant -> all killed
      classify: async () => ({ genuine: 0, note: "classified 0 survivor(s)" }),
    });
    assert.equal(pass.score, 1);
    assert.equal(pass.survivors.length, 0);
    assert.equal(pass.genuine, 0);
    assert.equal(pass.jevNote, "no survivors");
    assert.equal(pass.ok, true);

    // all survivors + classifiers flags them genuine -> hold (ok=false), report
    // surfaces the survivors and the genuine-gap count.
    const hold = await runMutationGate(dir, ["src/domain/foo.ts"], {
      minScore: 0.8,
      maxFiles: 3,
      maxMutants: 60,
      run: () => ({ code: 0, stdout: "", stderr: "", signal: null }), // every mutant survives
      classify: async (survivors) => ({ genuine: survivors.length, note: "all genuine" }),
    });
    assert.equal(hold.score, 0);
    assert.ok(hold.survivors.length > 0, "survivors listed");
    assert.equal(hold.genuine, hold.survivors.length);
    assert.equal(hold.lowFiles.length, 1);
    assert.equal(hold.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies: runMutations honors the maxMutants cap (the config value that was
// previously ignored) — total mutants are bounded by it.
test("mutation: runMutations honors maxMutants cap", () => {
  const dir = tmpProject();
  try {
    const capped = runMutations(dir, "src/domain/foo.ts", "test/foo.test.mjs", {
      _run: () => ({ code: 1, stdout: "", stderr: "", signal: null }),
      maxMutants: 2,
    });
    assert.equal(capped.total, 2);
    assert.equal(capped.killed, 2);
    assert.equal(capped.score, 1);
    // the file is restored even when capped
    assert.equal(fs.readFileSync(path.join(dir, "src", "domain", "foo.ts"), "utf-8"), SRC);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
// runMutationGate ok-decision (Task #36 refinement / B): Jev-classified survivors
// tolerate a low score; without Jev the min_score gates; a genuine gap always holds.

function mutProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-mutg-"));
  fs.mkdirSync(path.join(dir, "src", "domain"), { recursive: true });
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "domain", "foo.ts"), SRC);
  fs.writeFileSync(path.join(dir, "test", "foo.test.mjs"), 'import { f } from "../src/domain/foo.js";\n');
  return dir;
}

test("mutation: Jev-classified benign tolerates a low score (ok=true)", async () => {
  const dir = mutProject();
  try {
    const res = await runMutationGate(dir, ["src/domain/foo.ts"], {
      minScore: 0.8, maxFiles: 3, maxMutants: 60,
      classify: async () => ({ genuine: 0, note: "classified 5 survivor(s)" }),
      run: () => ({ code: 0, stdout: "", stderr: "", signal: null }), // all survive -> low score
    });
    assert.equal(res.ok, true, "classified-equivalent survivors should not fail on low score");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mutation: without Jev (unclassified) a low score still fails (ok=false)", async () => {
  const dir = mutProject();
  try {
    const res = await runMutationGate(dir, ["src/domain/foo.ts"], {
      minScore: 0.8, maxFiles: 3, maxMutants: 60,
      classify: async () => ({ genuine: 0, note: "unclassified (no Jev)" }),
      run: () => ({ code: 0, stdout: "", stderr: "", signal: null }),
    });
    assert.equal(res.ok, false, "no-Jev fallback should gate on min_score");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mutation: a Jev-classified genuine gap always holds (ok=false)", async () => {
  const dir = mutProject();
  try {
    const res = await runMutationGate(dir, ["src/domain/foo.ts"], {
      minScore: 0.8, maxFiles: 3, maxMutants: 60,
      classify: async () => ({ genuine: 1, note: "classified 5 survivor(s)" }),
      run: () => ({ code: 0, stdout: "", stderr: "", signal: null }),
    });
    assert.equal(res.ok, false, "genuine gap must hold");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
