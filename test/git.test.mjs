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
