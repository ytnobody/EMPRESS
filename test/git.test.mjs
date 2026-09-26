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
import { pruneStaleMergedBranches } from "../src/domain/git.js";

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
