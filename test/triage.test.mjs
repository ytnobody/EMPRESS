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

// Verifies: SSRF to cloud metadata / internal hosts is flagged as dangerous.
test("scanDiff: flags SSRF to internal/http hosts", () => {
  const bad = scanDiff('+const res = await fetch("http://169.254.169.254/latest/meta-data");\n+axios.get("http://localhost:3000/admin");\n+fetch("http://192.168.1.10/api");\n');
  assert.ok(bad.dangerous.includes("ssrf-internal-host"));
});

// Verifies: an HTTP request to a clearly public host is NOT an SSRF signal.
test("scanDiff: public https url -> no SSRF flag", () => {
  const ok = scanDiff('+fetch("https://exampl.e.com/api/data");\n');
  assert.ok(!ok.dangerous.includes("ssrf-internal-host"));
});

// Verifies: an XML DOCTYPE/ENTITY declaration (XXE vector) is flagged.
test("scanDiff: flags XXE DOCTYPE/ENTITY", () => {
  const bad = scanDiff('+const xml = "<!DOCTYPE foo [ <!ENTITY xxe SYSTEM \"file:///etc/passwd\"> ]><foo>&xxe;</foo>";\n');
  assert.ok(bad.dangerous.includes("xxe"));
});

// Verifies: sh -c with an interpolated ${...} payload (unfiltered shell input) is flagged.
test("scanDiff: flags sh -c with interpolated input", () => {
  const bad = scanDiff('+execSync(`sh -c ${userInput}`);\n+bash -c \"cp -r $dir /tmp\"\n');
  assert.ok(bad.dangerous.includes("sh-c-injection"));
});

// Verifies: sh -c with a fixed literal payload is not an injection signal.
test("scanDiff: sh -c literal -> no injection flag", () => {
  const ok = scanDiff('+execSync("sh -c \"echo done\"");\n');
  assert.ok(!ok.dangerous.includes("sh-c-injection"));
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

// Verifies: runTriage end-to-end with injected diff + Jev (ok path); conv is
// derived from diffBetween changed list (tests present => no PFT flag).
test("runTriage: end-to-end with injected deps -> ok (Jev used)", async () => {
  const config = { project: { base_branch: "main" }, agent: { branch_prefix: "empress/task" } };
  const task = { id: 3, title: "T", branch: "empress/task-3" };
  const r = await runTriage("/repo", config, task, {
    forceJev: true, // bypass jevAvailable check for the test
    _diffBetween: () => ({ files: 2, insertions: 5, deletions: 0, changed: ["src/a.js", "test/a.test.mjs"] }),
    _diffPatch: () => " src/a.js | 2 +-\n test/a.test.mjs | 3 ++\n 2 files changed\n\ndiff --git a/src/a.js b/src/a.js\n+export const fine = 1;\n",
    _jevJudge: async () => ({ ok: true, results: [{ answer: { noul: 0.2 } }] }),
  });
  assert.equal(r.signal, "ok");
  assert.equal(r.degraded, false);
  assert.equal(r.jevNoul, 0.2);
  assert.equal(r.conv.testsChanged, true);
  assert.equal(r.conv.codeWithoutTests, false);
});

// Verifies: convention signals come from the diffBetween changed list, not the
// --stat header in the patch text (patch header is empty here, yet code-only is caught).
test("runTriage: conv derived from diffBetween changed list (not --stat header)", async () => {
  const config = { project: { base_branch: "main" }, agent: { branch_prefix: "empress/task" } };
  const task = { id: 9, title: "T", branch: "empress/task-9" };
  const r = await runTriage("/repo", config, task, {
    forceJev: true,
    // changed says code-only (no tests) -> codeWithoutTests must be true,
    // even though the patch text has no --stat header to parse.
    _diffBetween: () => ({ files: 1, insertions: 2, deletions: 0, changed: ["src/c.js"] }),
    _diffPatch: () => "diff --git a/src/c.js b/src/c.js\n+export const c = 1;\n",
    _jevJudge: async () => ({ ok: true, results: [{ answer: { noul: 0.1 } }] }),
  });
  assert.equal(r.conv.codeWithoutTests, true);
  assert.equal(r.conv.testsChanged, false);
  assert.equal(r.signal, "review");
  assert.match(r.reasons.join(" "), /convention/);
});

// Verifies: runTriage escalates on a deterministic secret hit.
test("runTriage: deterministic secret hit -> review", async () => {
  const config = { project: { base_branch: "main" }, agent: { branch_prefix: "empress/task" } };
  const task = { id: 4, title: "T", branch: "empress/task-4" };
  const r = await runTriage("/repo", config, task, {
    forceJev: true,
    _diffBetween: () => ({ files: 1, insertions: 1, deletions: 0, changed: ["src/b.js"] }),
    _diffPatch: () => " src/b.js | 2 +-\n 1 file changed\n\ndiff --git a/src/b.js b/src/b.js\n+const token = \"x_TOP_SECRET_123456\";\n",
    _jevJudge: async () => ({ ok: true, results: [{ answer: { noul: 0.1 } }] }),
  });
  assert.equal(r.signal, "review");
  assert.match(r.reasons.join(" "), /secrets/);
});