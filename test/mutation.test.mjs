// Mutation-testing engine tests: mutant collection, src->test mapping, score accounting.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectMutants, findTests, mutationTargets, runMutations } from "../src/domain/mutation.js";

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