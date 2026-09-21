// Review triage — deterministic + Jev-tier decision logic (pure function tests,
// no network). Per PFT: scanDiff/conventionSignals/decideTriage are the
// verification-arithmetic units; runTriage's diff fetch + Jev call are injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDiff, conventionSignals, decideTriage, buildTriageState, runTriage } from "../src/domain/triage.js";

// Verifies: inline credentials and AWS key patterns in a diff are flagged.
test("scanDiff: flags secrets and dangerous patterns", () => {
  const bad = scanDiff("+const token = \"SECRET_ABC\";\n+spawnSync(\"sh\", [\"-c\", cmd]);\n+AKIA1234567890ABCDEF\n");
  // pattern order is definition order (aws-access-key precedes inline-credential)
  assert.deepEqual(bad.secrets, ["aws-access-key", "inline-credential"]);
  assert.ok(bad.dangerous.includes("shell-exec"));
});

// Verifies: a clean diff yields no hits.
test("scanDiff: clean diff -> no findings", () => {
  assert.deepEqual(scanDiff("+export function f(a){ return a + 1; }"), { secrets: [], dangerous: [] });
});

// Verifies: code-without-tests is a PFT §9 convention signal; with tests it isn't.
test("conventionSignals: code-only change flags PFT suspicion", () => {
  assert.deepEqual(conventionSignals(["src/cli/state.js"]), { testsChanged: false, codeWithoutTests: true });
  assert.deepEqual(conventionSignals(["src/cli/state.js", "test/state.test.mjs"]), { testsChanged: true, codeWithoutTests: false });
});

// Verifies: deterministic secrets escalate regardless of Jev saying "ok".
test("decideTriage: deterministic hit wins over a clean Jev signal", () => {
  const r = decideTriage({ deterministic: { secrets: ["inline-credential"], dangerous: [] }, conv: { testsChanged: true, codeWithoutTests: false }, jevNoul: 0.9 /* Jev: ok */ });
  assert.equal(r.signal, "review");
  assert.match(r.reasons[0], /secrets/);
});

// Verifies: Jev unavailable (no TYPESAFE_API_KEY) -> review + degraded, preserving full review.
test("decideTriage: Jev tier skipped -> review + degraded", () => {
  const r = decideTriage({ deterministic: { secrets: [], dangerous: [] }, conv: { testsChanged: true, codeWithoutTests: false }, jevNoul: null });
  assert.equal(r.signal, "review");
  assert.equal(r.degraded, true);
});

// Verifies: Jev error escalates (fail-closed, never auto-pass on error).
test("decideTriage: Jev error escalates", () => {
  const r = decideTriage({ deterministic: { secrets: [], dangerous: [] }, conv: {}, jevNoul: 0, jevError: true });
  assert.equal(r.signal, "review");
});

// Verifies: only a clean deterministic scan + low-risk, clear Jev signal fast-paths to ok.
test("decideTriage: clean + Jev low risk -> ok", () => {
  const r = decideTriage({ deterministic: { secrets: [], dangerous: [] }, conv: { testsChanged: true, codeWithoutTests: false }, jevNoul: 0.3 });
  assert.equal(r.signal, "ok");
});

// Verifies: Jev says "warrants review" -> escalate.
test("decideTriage: Jev risk signal escalates", () => {
  const r = decideTriage({ deterministic: { secrets: [], dangerous: [] }, conv: {}, jevNoul: 0.9 });
  assert.equal(r.signal, "review");
});

// Verifies: the Jev state bundles task + diff for a single noul question.
test("buildTriageState: bundles task title and diff", () => {
  const s = buildTriageState({ taskTitle: "Fix X", diffSummary: "+a\n+b" });
  assert.match(s, /task: Fix X/);
  assert.match(s, /\+a/);
});

// Verifies: runTriage end-to-end with injected diff + Jev (ok path).
test("runTriage: end-to-end with injected deps -> ok (Jev used)", async () => {
  const config = { project: { base_branch: "main" }, agent: { branch_prefix: "empress/task" } };
  const task = { id: 3, title: "T", branch: "empress/task-3" };
  const r = await runTriage("/repo", config, task, {
    forceJev: true, // bypass jevAvailable check for the test
    _diffPatch: () => " src/a.js | 2 +-\n test/a.test.mjs | 3 ++\n 2 files changed\n\ndiff --git a/src/a.js b/src/a.js\n+export const fine = 1;\n",
    _jevJudge: async () => ({ ok: true, results: [{ answer: { noul: 0.2 } }] }),
  });
  assert.equal(r.signal, "ok");
  assert.equal(r.degraded, false);
  assert.equal(r.jevNoul, 0.2);
});

// Verifies: runTriage escalates on a deterministic secret hit.
test("runTriage: deterministic secret hit -> review", async () => {
  const config = { project: { base_branch: "main" }, agent: { branch_prefix: "empress/task" } };
  const task = { id: 4, title: "T", branch: "empress/task-4" };
  const r = await runTriage("/repo", config, task, {
    forceJev: true,
    _diffPatch: () => " src/b.js | 2 +-\n 1 file changed\n\ndiff --git a/src/b.js b/src/b.js\n+const token = \"x_TOP_SECRET_123456\";\n",
    _jevJudge: async () => ({ ok: true, results: [{ answer: { noul: 0.1 } }] }),
  });
  assert.equal(r.signal, "review");
  assert.match(r.reasons.join(" "), /secrets/);
});