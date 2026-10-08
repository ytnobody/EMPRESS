import { test } from "node:test";
import assert from "node:assert/strict";
import { originUpdateCommand } from "../src/domain/git.js";

// Verifies: when origin's base ref does NOT exist (local-only repo), no update
// Command is emitted — so a doomed `git merge --ff-only origin/<base>` is never run
// by landBranch. (Spec: drop the doomed origin-merge path.)
test("originUpdateCommand: returns null when origin base ref is absent", () => {
  assert.equal(originUpdateCommand("main", false), null);
});

// Verifies: when origin's base ref DOES exist, the fast-forward Command against
// `origin/<base>` is emitted, with base safely interpolated into the ref name.
// (Spec: behavior with an origin remote is guarded, not removed.)
test("originUpdateCommand: emits guarded origin ff Command when ref exists", () => {
  const cmd = originUpdateCommand("main", true);
  assert.deepEqual(cmd, { cmd: "git", args: ["merge", "--ff-only", "origin/main"] });
});

// Verifies: the base name is the only interpolated part — the ref is formed by
// prefixing "origin/" to base, independent of any other branch.
test("originUpdateCommand: interpolates base into origin/<base> ref", () => {
  const cmd = originUpdateCommand("release/v1", true);
  assert.deepEqual(cmd.args, ["merge", "--ff-only", "origin/release/v1"]);
});
// pruneStaleMergedBranches: needs a real (tmp) git repo.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pruneStaleMergedBranches, decideRemotePrunes, worktreesForBranch } from "../src/domain/git.js";

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-git-prune-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf-8" });
  g(["init", "-q", "-b", "develop"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  g(["commit", "-q", "--allow-empty", "-m", "A"]);
  // a branch fully merged into develop (fast-forward) => should be pruned
  g(["checkout", "-q", "-b", "empress/test-9000"]); g(["commit", "-q", "--allow-empty", "-m", "B"]);
  g(["checkout", "-q", "develop"]); g(["merge", "-q", "empress/test-9000", "-m", "merge B"]);
  // a branch NOT fully merged into develop => should be kept (skipped, -d refuses)
  g(["checkout", "-q", "-b", "empress/test-unmerged"]); g(["commit", "-q", "--allow-empty", "-m", "C"]);
  g(["checkout", "-q", "develop"]);
  return dir;
}

test("pruneStaleMergedBranches: deletes merged, keeps unmerged + protected", (t) => {
  if (!gitAvailable()) {
    // git absent (e.g. CI container): the fixture can't be set up -> skip the
    // spec. Host runs (git present) are the authority for this behavior.
    t.skip("git not available in this environment");
    return;
  }
  const dir = gitRepo();
  try {
    const res = pruneStaleMergedBranches(dir, "develop");
    assert.ok(res.pruned.includes("empress/test-9000"), `merged branch pruned, got ${res.pruned}`);
    assert.ok(!res.pruned.includes("empress/test-unmerged"), "unmerged branch must not be pruned");
    assert.ok(!res.pruned.includes("develop") && !res.pruned.includes("main"), "protected branches kept");
    // merged branch is gone; unmerged remains
    const names = execFileSync("git", ["-C", dir, "branch", "--format=%(refname:short)"], { encoding: "utf-8" }).split("\n").filter(Boolean);
    assert.ok(!names.includes("empress/test-9000"));
    assert.ok(names.includes("empress/test-unmerged"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies: a merged branch that is checked OUT in a worktree is also pruned —
// before pruning, its worktree is removed (`git worktree remove --force`), which
// unblocks `git branch -d`. (Spec: merged branches get cleaned up in full, not
// left dangling because a live worktree holds the branch checkout.) The worktree
// dir no longer exists after pruning. This is the #64 housekeeping behavior.
// Note: this worktree is a STRAY (non-managed) one — it is not under
// `.empress/worktrees/` — so a default sweep prunes it. (Managed worktrees are
// protected; see the next test.)
test("pruneStaleMergedBranches: merged branch checked out in a worktree is pruned AND its worktree removed", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-git-wt-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf-8" });
  try {
    g(["init", "-q", "-b", "develop"]);
    g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    g(["commit", "-q", "--allow-empty", "-m", "A"]);
    g(["checkout", "-q", "-b", "empress/task-32"]);
    g(["commit", "-q", "--allow-empty", "-m", "B"]);
    // merge back into develop (branch fully merged)
    g(["checkout", "-q", "develop"]);
    g(["merge", "-q", "empress/task-32", "-m", "merge B"]);
    // check it out in a worktree so it is NOT the current/main checkout
    const wt = path.join(dir, "wt32");
    g(["worktree", "add", "-q", wt, "empress/task-32"]);
    assert.ok(fs.existsSync(path.join(wt, ".git")), "worktree fixture exists");
    assert.deepEqual(worktreesForBranch(dir, "empress/task-32"), [wt]);

    const res = pruneStaleMergedBranches(dir, "develop");
    assert.ok(res.pruned.includes("empress/task-32"), `merged+checked-out branch pruned, got ${res.pruned}`);
    assert.ok(!fs.existsSync(wt), "worktree dir removed by pruning");
    // branch gone, worktree gone
    const names = execFileSync("git", ["-C", dir, "branch", "--format=%(refname:short)"], { encoding: "utf-8" }).split("\n").filter(Boolean);
    assert.ok(!names.includes("empress/task-32"));
    assert.deepEqual(worktreesForBranch(dir, "empress/task-32"), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies (hold-fix / default-sweep safety): a merged branch checked out in an
// EMPRESS-MANAGED worktree (under `<dir>/.empress/worktrees/`) is NEVER pruned by
// a DEFAULT sweep. Such a branch may be an ACTIVE in-progress engineer task whose
// branch still points at `develop` (zero commits -> `merge-base --is-ancestor` is
// true even though it is not a leftover). The default sweep must not kill its
// worktree or delete its branch. (Spec: a default sweep can never kill an
// in-progress EMPRESS task worktree.)
test("pruneStaleMergedBranches: default sweep protects a merged branch in a managed .empress/worktrees worktree", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-git-mgd-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf-8" });
  try {
    g(["init", "-q", "-b", "develop"]);
    g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    g(["commit", "-q", "--allow-empty", "-m", "A"]);
    g(["checkout", "-q", "-b", "empress/task-64"]);
    g(["commit", "-q", "--allow-empty", "-m", "B"]);
    g(["checkout", "-q", "develop"]);
    g(["merge", "-q", "empress/task-64", "-m", "merge B"]); // fully merged
    // check it out in an EMPRESS-managed worktree (like the harness creates).
    const wt = path.join(dir, ".empress", "worktrees", "64");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    g(["worktree", "add", "-q", wt, "empress/task-64"]);
    assert.ok(fs.existsSync(path.join(wt, ".git")), "managed worktree fixture exists");

    const res = pruneStaleMergedBranches(dir, "develop"); // DEFAULT sweep
    assert.ok(!res.pruned.includes("empress/task-64"), `managed-worktree branch must NOT be auto-pruned, got ${res.pruned}`);
    assert.ok(res.skipped.includes("empress/task-64"), "managed-worktree branch reported skipped/protected");
    // worktree AND branch both intact after the default sweep
    assert.ok(fs.existsSync(path.join(wt, ".git")), "managed worktree dir NOT removed by default sweep");
    const names = execFileSync("git", ["-C", dir, "branch", "--format=%(refname:short)"], { encoding: "utf-8" }).split("\n").filter(Boolean);
    assert.ok(names.includes("empress/task-64"), "managed-worktree branch kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies: a caller who has CONFIRMED a merged branch in a managed worktree is a
// leftover can opt into pruning it via `opts.scope` — the managed-worktree
// protection applies only to an un-scoped DEFAULT sweep, not to an explicit
// targeted run. The worktree is removed and the branch deleted. This is the #64
// targeted-execution path for `empress/task-32` / `tmp34`.
test("pruneStaleMergedBranches: explicit scope prunes a confirmed merged branch even inside a managed worktree", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-git-scope-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf-8" });
  try {
    g(["init", "-q", "-b", "develop"]);
    g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    g(["commit", "-q", "--allow-empty", "-m", "A"]);
    g(["checkout", "-q", "-b", "empress/task-32"]);
    g(["commit", "-q", "--allow-empty", "-m", "B"]);
    g(["checkout", "-q", "develop"]);
    g(["merge", "-q", "empress/task-32", "-m", "merge B"]); // fully merged
    const wt = path.join(dir, ".empress", "worktrees", "32");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    g(["worktree", "add", "-q", wt, "empress/task-32"]);

    const res = pruneStaleMergedBranches(dir, "develop", { scope: ["empress/task-32"] });
    assert.ok(res.pruned.includes("empress/task-32"), `scoped confirmed leftover pruned, got ${res.pruned}`);
    assert.ok(!fs.existsSync(wt), "managed worktree removed by scoped prune");
    const names = execFileSync("git", ["-C", dir, "branch", "--format=%(refname:short)"], { encoding: "utf-8" }).split("\n").filter(Boolean);
    assert.ok(!names.includes("empress/task-32"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies: worktreesForBranch maps only the worktrees that check out the given
// branch. The main worktree is included when it checks the branch (here, develop
// is checked out in the main repo dir), while worktrees on other branches and
// branches with no worktree are excluded. Derived from `git worktree list
// --porcelain` (branch ref -> worktree path).
test("worktreesForBranch: maps branch->worktree paths", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-git-wtmap-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf-8" });
  try {
    g(["init", "-q", "-b", "develop"]);
    g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    g(["commit", "-q", "--allow-empty", "-m", "A"]);
    g(["checkout", "-q", "-b", "empress/task-32"]);
    g(["commit", "-q", "--allow-empty", "-m", "B"]);
    g(["checkout", "-q", "develop"]);
    const wt = path.join(dir, "wt32");
    g(["worktree", "add", "-q", wt, "empress/task-32"]);
    // only the matching worktree for task-32; develop is the main repo dir;
    // a branch with no worktree maps to nothing.
    assert.deepEqual(worktreesForBranch(dir, "empress/task-32"), [wt]);
    assert.deepEqual(worktreesForBranch(dir, "develop"), [dir]);
    assert.deepEqual(worktreesForBranch(dir, "nonexistent"), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies: a remote-tracking ref that is FULLY merged into base and not protected
// is the only thing pruned — the deletion candidates are decided from merge status
// (spec) + protected-name gate, independent of any push/git state.
test("decideRemotePrunes: prunes merged+unprotected, keeps unmerged/protected/HEAD", () => {
  const refs = [
    { short: "empress/task-3", merged: true },
    { short: "empress/task-4", merged: true },
    { short: "empress/task-10", merged: false }, // held, unmerged
    { short: "develop", merged: true },           // base branch
    { short: "main", merged: true },
    { short: "HEAD", merged: true },              // symbolic default ref
  ];
  const res = decideRemotePrunes(refs, "develop", []);
  assert.deepEqual(res.prune.sort(), ["empress/task-3", "empress/task-4"]);
  const kept = new Set(res.skip);
  assert.ok(kept.has("empress/task-10"), "unmerged held branch never pruned");
  assert.ok(kept.has("develop") && kept.has("main") && kept.has("HEAD"), "protected/HEAD always kept");
});

// Verifies: a merged branch protected via `keep` is exempted even though it is
// fully merged — the protected-name gate dominates the merge gate.
test("decideRemotePrunes: keep-list protects merged branches from pruning", () => {
  const res = decideRemotePrunes([{ short: "empress/task-1", merged: true }], "develop", ["empress/task-1"]);
  assert.deepEqual(res.prune, []);
  assert.deepEqual(res.skip, ["empress/task-1"]);
});

// mergeConflict (Task #52): LLM-free conflict detection via git merge-tree.
import { mergeConflict } from "../src/domain/git.js";

function conflictRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-mc-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: "pipe" });
  g(["init", "-q", "-b", "develop"]);
  g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "x.txt"), "A\n");
  g(["add", "-A"]); g(["commit", "-qm", "base A"]);
  // diverging branch B: change A -> B
  g(["checkout", "-q", "-b", "branch-b"]);
  fs.writeFileSync(path.join(dir, "x.txt"), "B\n");
  g(["add", "-A"]); g(["commit", "-qm", "B"]);
  // develop: change A -> C (same line) => conflict with branch-b
  g(["checkout", "-q", "develop"]);
  fs.writeFileSync(path.join(dir, "x.txt"), "C\n");
  g(["add", "-A"]); g(["commit", "-qm", "C"]);
  // non-conflicting branch: new file only
  g(["checkout", "-q", "-b", "branch-clean"]);
  fs.writeFileSync(path.join(dir, "y.txt"), "Y\n");
  g(["add", "-A"]); g(["commit", "-qm", "Y"]);
  return dir;
}

test("mergeConflict: true for diverging same-line changes, false for additive branch", (t) => {
  if (!gitAvailable()) {
    // git absent (e.g. CI container): fixture can't be built -> skip the spec.
    t.skip("git not available in this environment");
    return;
  }
  const dir = conflictRepo();
  try {
    assert.equal(mergeConflict(dir, "develop", "branch-b"), true, "branch-b should conflict with develop");
    assert.equal(mergeConflict(dir, "develop", "branch-clean"), false, "branch-clean should merge cleanly");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #68 — squash/PR-merged branch pruning.
// Alternative decision (spec): a branch is prunable iff its tip is a merge-base
// ancestor of base OR its GitHub PR is confirmed MERGED (squash/merge-commit
// PRs leave a non-ancestor tip). Verify the pure decision arithmetically.
import { decideLocalPrune, tryMergePRMerged } from "../src/domain/git.js";

// Verifies: an ancestor-merged branch (fast-forward/merge-commit into base) is
// prunable regardless of any PR signal — the git ancestry check alone is enough.
test("decideLocalPrune: ancestor-merged branch is prunable even without a PR signal", () => {
  assert.equal(decideLocalPrune(true, false), true);
});

// Verifies: a non-ancestor branch whose PR is confirmed MERGED (squash/merge-
// commit PR) is prunable — this is the extended signal that catches GitHub
// squash merges which git ancestry misses.
test("decideLocalPrune: PR-merged (non-ancestor) branch is prunable", () => {
  assert.equal(decideLocalPrune(false, true), true);
});

// Verifies: an unmerged branch that is NOT PR-merged is never prunable
// (default-deny — this is the active/in-progress task case).
test("decideLocalPrune: non-merged + non-PR branch is kept", () => {
  assert.equal(decideLocalPrune(false, false), false);
});

// Verifies: tryMergePRMerged is fail-safe — when gh is unavailable or errors it
// returns false (never prunes), and only an explicit ,MERGED` state is true.
// (Pure parse of a fake gh state payload, no real gh/bin call.)
 test("tryMergePRMerged: parses only an explicit MERGED state into true", () => {
  assert.equal(tryMergePRMerged("/nonexistent", "x"), false);
});

// #72 — gh 2.74.0 rejects `gh pr view --head <branch>` with "unknown flag", so
// tryMergePRMerged fail-safed to false and PR-MERGED branch pruning never ran
// (task-30/31/34/36/37 + worktrees stayed as dead weight). Regression: the probe
// must use the POSITIONAL form `gh pr view <branch> --json state`. This exercises
// the REAL probe path with a fake `gh` executable shim on PATH (records argv,
// emits a state payload) — not a mock of `tryMergePRMerged` or the shell helper.
test("tryMergePRMerged: positional gh pr view, real probe path via a fake gh shim on PATH", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-ghshim-"));
  const bindir = path.join(dir, "bin");
  fs.mkdirSync(bindir);
  const recordFile = path.join(dir, "argv.txt");
  // Shim: resolves `--version` (so ghAvailable() passes), records argv for any
  // `pr view` call, and echoes the state configured by FAKE_GH_STATE.
  fs.writeFileSync(
    path.join(bindir, "gh"),
    `#!/bin/sh\n` +
      `if [ "$1" = "--version" ]; then echo \"gh version 2.74.0\"; exit 0; fi\n` +
      `if [ "$1" = "pr" ]; then echo "PR_VIEW $*" >> "$FAKE_GH_RECORD"; echo "$FAKE_GH_STATE"; exit 0; fi\n` +
      `exit 1\n`
  );
  fs.chmodSync(path.join(bindir, "gh"), 0o755);
  const env = { ...process.env, PATH: `${bindir}${path.delimiter}${process.env.PATH}`, FAKE_GH_RECORD: recordFile, FAKE_GH_STATE: '{"state":"MERGED"}' };
  try {
    // Real cwd so the probe runs with a real working dir (no git needed here).
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "empress-ghshim-cwd-"));
    const probe = (b) => tryMergePRMerged(cwd, b);
    // Restore env for the duration so the shim on PATH is actually consulted.
    const savedPath = process.env.PATH; const savedRec = process.env.FAKE_GH_RECORD; const savedState = process.env.FAKE_GH_STATE;
    process.env.PATH = env.PATH; process.env.FAKE_GH_RECORD = recordFile; process.env.FAKE_GH_STATE = env.FAKE_GH_STATE;
    try {
      // MERGED => true, positional, no --head.
      assert.equal(probe("empress/task-30"), true, "MERGED state returns true");
      const mergedArgs = fs.readFileSync(recordFile, "utf-8").trim().split(/\n+/).map((l) => l.slice("PR_VIEW ".length).split(/\s+/));
      const last = mergedArgs[0]; // pr view <branch> --json state
      assert.deepEqual(last, ["pr", "view", "empress/task-30", "--json", "state"], `positional form recorded, got ${JSON.stringify(last)}`);
      assert.ok(!last.includes("--head"), "no --head flag anywhere");

      // CLOSED => false (fail-safe kept; superseded CLOSED-PR branches stay put).
      process.env.FAKE_GH_STATE = '{"state":"CLOSED"}';
      assert.equal(probe("empress/task-52"), false, "CLOSED state returns false");
      const closedArgs = fs.readFileSync(recordFile, "utf-8").trim().split(/\n+/).map((l) => l.slice("PR_VIEW ".length).split(/\s+/));
      assert.deepEqual(closedArgs[1], ["pr", "view", "empress/task-52", "--json", "state"], "positional form preserved for CLOSED probe");
    } finally {
      process.env.PATH = savedPath; process.env.FAKE_GH_RECORD = savedRec; process.env.FAKE_GH_STATE = savedState;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies (extended helper end-to-end on a fixture): a fake squash-merged
// branch — tip NOT an ancestor of base (content re-implemented on base, like a
// GitHub squash PR) but its injected PR signal says MERGED — IS pruned (branch
// deleted, worktree removed). The injected probe is the Core/Shell seam: real
// tmp fixtures have no GitHub, so the PR-merged signal is supplied
// deterministically; per spec the default probe is the real `gh pr view` call.
test("pruneStaleMergedBranches: prunes a fake squash-merged (PR-merged, non-ancestor) branch", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-git-squash-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf-8" });
  try {
    g(["init", "-q", "-b", "develop"]);
    g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
    g(["add", "-A"]); g(["commit", "-qm", "A"]);
    // branch commits a change on f.txt
    g(["checkout", "-q", "-b", "empress/task-squash"]);
    fs.writeFileSync(path.join(dir, "f.txt"), "feature\n");
    g(["add", "-A"]); g(["commit", "-qm", "F"]);
    // develop stays at A (branch tip F is NOT a merge-base ancestor of base)
    g(["checkout", "-q", "develop"]);
    // develop stays at A, so the squash-merged branch tip is NOT a merge-base
    // ancestor of base — the scenario git ancestry alone would MISS. Confirm by
    // asserting the ancestry probe fails (execFileSync throws on non-zero exit).
    assert.throws(() => { execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", "empress/task-squash", "develop"], { stdio: "pipe" }); });
    // a non-merged, non-PR branch that must stay intact
    g(["checkout", "-q", "develop"]);
    g(["checkout", "-q", "-b", "empress/task-nopr"]);
    fs.writeFileSync(path.join(dir, "g.txt"), "keep\n");
    g(["add", "-A"]); g(["commit", "-qm", "G"]);
    g(["checkout", "-q", "develop"]);
    // squash-merged branch checked out in a managed worktree (like the harness)
    const wt = path.join(dir, ".empress", "worktrees", "squash");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    g(["worktree", "add", "-q", wt, "empress/task-squash"]);

    // Injected PR probe: confirms MERGED only for the squash-merged leftover.
    const probe = (b) => b === "empress/task-squash";
    const res = pruneStaleMergedBranches(dir, "develop", { scope: ["empress/task-squash", "empress/task-nopr"], isPrMerged: probe });
    assert.ok(res.pruned.includes("empress/task-squash"), `squash-merged branch pruned, got ${res.pruned}`);
    assert.ok(!fs.existsSync(wt), "squash-merged managed worktree removed");
    assert.ok(!res.pruned.includes("empress/task-nopr"), "non-merged non-PR branch must not be pruned");
    assert.ok(res.skipped.includes("empress/task-nopr"), "non-merged branch reported skipped");
    const names = execFileSync("git", ["-C", dir, "branch", "--format=%(refname:short)"], { encoding: "utf-8" }).split("\n").filter(Boolean);
    assert.ok(!names.includes("empress/task-squash"), "squash-merged branch deleted");
    assert.ok(names.includes("empress/task-nopr"), "non-merged branch kept");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// #70: a PR-MERGED branch whose tip is NOT a merge-base ancestor, checked out in
// an EMPRESS-MANAGED worktree, is dead weight — but the DEFAULT sweep protects
// managed worktrees on purpose, so it must be KEPT by an unscoped run. Only a
// caller-confirmed `scope` opts into pruning it (branch deleted + worktree
// removed), still gated on the confirmed PR-MERGED signal. Verifies both sides
// of the boundary on one fixture: default keeps, scope prunes.
test("pruneStaleMergedBranches: PR-merged managed-worktree branch KEPT unscoped, pruned+worktree-removed when scoped", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-git-donebranch-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf-8" });
  try {
    g(["init", "-q", "-b", "develop"]);
    g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
    g(["add", "-A"]); g(["commit", "-qm", "A"]);
    // DONE-task branch: content changed, tip NOT an ancestor of base (squash PR)
    g(["checkout", "-q", "-b", "empress/task-70b"]);
    fs.writeFileSync(path.join(dir, "f.txt"), "feature\n");
    g(["add", "-A"]); g(["commit", "-qm", "F"]);
    g(["checkout", "-q", "develop"]); // develop stays at A => non-ancestor tip
    assert.throws(() => { execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", "empress/task-70b", "develop"], { stdio: "pipe" }); });
    // checked out in an EMPRESS-managed worktree (like the harness creates)
    const wt = path.join(dir, ".empress", "worktrees", "70");
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    g(["worktree", "add", "-q", wt, "empress/task-70b"]);
    // PR signal: confirmed MERGED only for the DONE leftover
    const probe = (b) => b === "empress/task-70b";

    // (1) unscoped DEFAULT sweep => KEPT, managed worktree intact
    const kept = pruneStaleMergedBranches(dir, "develop", { isPrMerged: probe });
    assert.ok(!kept.pruned.includes("empress/task-70b"), `PR-merged managed-worktree branch must be KEPT by default sweep, got ${kept.pruned}`);
    assert.ok(kept.skipped.includes("empress/task-70b"), "PR-merged managed-worktree branch reported skipped/protected");
    assert.ok(fs.existsSync(path.join(wt, ".git")), "managed worktree INTACT after default sweep");

    // (2) caller-confirmed scope => pruned + worktree removed (still PR-gated)
    const scoped = pruneStaleMergedBranches(dir, "develop", { scope: ["empress/task-70b"], isPrMerged: probe });
    assert.ok(scoped.pruned.includes("empress/task-70b"), `scoped PR-merged leftover pruned, got ${scoped.pruned}`);
    assert.ok(!fs.existsSync(wt), "managed worktree removed by scoped prune");
    const names = execFileSync("git", ["-C", dir, "branch", "--format=%(refname:short)"], { encoding: "utf-8" }).split("\n").filter(Boolean);
    assert.ok(!names.includes("empress/task-70b"), "PR-merged DONE branch deleted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// #94 — land must not leave origin/<base> behind (local base divergence).
// Policy (a): after a successful local merge with github enabled, push the base
// branch to origin; a deterministic doctor check detects any residual drift.
import { originPushCommand, decideBaseDivergence, baseDivergence, landBranch } from "../src/domain/git.js";
import { baseDivergenceCheck } from "../src/cli/doctor.js";

// Verifies: a local-only repo (no origin/<base> ref) emits NO push Command, so a
// doomed `git push origin <base>` is never run. (Spec: local-only repos are
// unaffected by origin reconciliation.)
test("originPushCommand: returns null when origin base ref is absent", () => {
  assert.equal(originPushCommand("develop", false), null);
});

// Verifies: when origin/<base> exists, the reconcile Command pushes the LOCAL
// base to the remote base (`<base>:<base>`), with base safely interpolated.
// (Spec: origin receives exactly the landed commit.)
test("originPushCommand: emits non-forced base push when origin ref exists", () => {
  const cmd = originPushCommand("develop", true);
  assert.deepEqual(cmd, { cmd: "git", args: ["push", "origin", "develop:develop"] });
  assert.ok(!cmd.args.includes("--force"), "reconcile never force-pushes");
});

// Verifies: a branch base name is the only interpolated part of the refspec.
test("originPushCommand: interpolates the base branch into <base>:<base>", () => {
  assert.deepEqual(originPushCommand("release/v1", true).args, ["push", "origin", "release/v1:release/v1"]);
});

// Verifies: divergence is decided arithmetically from (ahead, originExists) —
// ahead>0 with an origin ref is divergent; zero-ahead or no-origin is not.
test("decideBaseDivergence: only ahead>0 with an origin ref is divergent", () => {
  assert.equal(decideBaseDivergence(3, true), true);
  assert.equal(decideBaseDivergence(0, true), false);
  assert.equal(decideBaseDivergence(3, false), false);
});

// Fixture: a repo with a bare `origin` remote and develop pushed to it.
function repoWithOrigin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-origin-"));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "empress-remote-"));
  const g = (args, cwd = dir) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", encoding: "utf-8" });
  g(["init", "-q", "-b", "develop"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  g(["commit", "-q", "--allow-empty", "-m", "A"]);
  g(["init", "-q", "--bare", remote]);
  g(["remote", "add", "origin", remote]);
  g(["push", "-q", "-u", "origin", "develop"]);
  return { dir, remote, g };
}

// Verifies (end-to-end on a real fixture): landing with reconcileOrigin:true
// pushes base, so origin/develop receives the commit and baseDivergence reports
// no drift; a SECOND land keeps origin in sync too (the one-shot sync class
// #77/#80/#93 is not needed). Spec: origin/<base> is never left behind.
test("landBranch: reconcileOrigin pushes base, and a second land keeps origin in sync", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const { dir, remote, g } = repoWithOrigin();
  try {
    const feature = (name) => {
      g(["checkout", "-q", "-b", name]);
      fs.writeFileSync(path.join(dir, `${name.replace(/\//g, "-")}.txt`), `${name}\n`);
      g(["add", "-A"]); g(["commit", "-qm", name]);
      g(["checkout", "-q", "develop"]);
    };
    feature("empress/task-94a");
    const first = landBranch(dir, "develop", "empress/task-94a", { reconcileOrigin: true });
    assert.equal(first.merged, true, `first land merged: ${JSON.stringify(first)}`);
    assert.equal(first.pushed, true, `first land pushed: ${JSON.stringify(first)}`);
    assert.equal(baseDivergence(dir, "develop").diverged, false, "origin/develop not left behind after first land");

    feature("empress/task-94b");
    const second = landBranch(dir, "develop", "empress/task-94b", { reconcileOrigin: true });
    assert.equal(second.merged, true);
    assert.equal(second.pushed, true);
    assert.equal(baseDivergence(dir, "develop").diverged, false, "second land does not reintroduce divergence");

    // origin/develop tip equals local develop tip (both commits landed remotely)
    const originTip = execFileSync("git", ["-C", dir, "rev-parse", "origin/develop"], { encoding: "utf-8" }).trim();
    const localTip = execFileSync("git", ["-C", dir, "rev-parse", "develop"], { encoding: "utf-8" }).trim();
    assert.equal(originTip, localTip);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

// Verifies: without reconciliation, local develop drifts ahead of origin/develop
// — and the doctor indicator detects + surfaces it (fail + "ahead" message).
// Spec: a deterministic check catches the divergence the root cause used to hide.
test("baseDivergence + doctor check: detect local base ahead of origin/<base>", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const { dir, remote, g } = repoWithOrigin();
  try {
    g(["checkout", "-q", "-b", "empress/task-94c"]);
    fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
    g(["add", "-A"]); g(["commit", "-qm", "C"]);
    g(["checkout", "-q", "develop"]);
    const res = landBranch(dir, "develop", "empress/task-94c"); // NO reconcile -> drift created
    assert.equal(res.merged, true);
    assert.equal(res.pushed, undefined, "no push attempted without reconcileOrigin");

    const div = baseDivergence(dir, "develop");
    assert.equal(div.originBaseExists, true);
    assert.equal(div.diverged, true);
    assert.ok(div.ahead > 0, `ahead should be >0, got ${div.ahead}`);

    const [name, pass, msg] = baseDivergenceCheck(dir, "develop");
    assert.match(name, /base not ahead of origin\/develop/);
    assert.equal(pass, false, "doctor check fails on drift");
    assert.match(msg, /ahead/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

// Verifies: a local-only repo (no origin remote) is never reported divergent —
// the doctor indicator skips it rather than failing a remote-less project.
test("baseDivergence: local-only repo (no origin) is not divergent", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-localonly-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", encoding: "utf-8" });
  try {
    g(["init", "-q", "-b", "develop"]);
    g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
    g(["commit", "-q", "--allow-empty", "-m", "A"]);
    const div = baseDivergence(dir, "develop");
    assert.equal(div.originBaseExists, false);
    assert.equal(div.diverged, false);
    const [, pass] = baseDivergenceCheck(dir, "develop");
    assert.equal(pass, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
