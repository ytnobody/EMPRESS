// mergeTreeClean: needs a real (tmp) git repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { mergeTreeClean } from "../src/domain/git.js";

function git(cwd, ...args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
}

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe", encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-git-"));
  git(dir, "init", "-q", "-b", "base");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Verifies: mergeTreeClean reports true when base and branch merge without conflict
// (disjoint changes), so a clean held branch is conflict-free.
test("mergeTreeClean: disjoint changes are conflict-free (true)", { skip: !gitAvailable() }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "base-a\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-qm", "base a");
    git(dir, "checkout", "-qb", "branch");
    fs.writeFileSync(path.join(dir, "b.txt"), "branch-b\n");
    git(dir, "add", "b.txt");
    git(dir, "commit", "-qm", "branch adds b");
    git(dir, "checkout", "-q", "base");
    fs.writeFileSync(path.join(dir, "c.txt"), "base-c\n");
    git(dir, "add", "c.txt");
    git(dir, "commit", "-qm", "base adds c");
    assert.equal(mergeTreeClean(dir, "base", "branch"), true);
  } finally {
    cleanup();
  }
});

// Verifies: mergeTreeClean reports false when the same line was changed on both
// base and branch (a genuine conflict), so a conflicted held branch is not
// sign-off-ready until rebased.
test("mergeTreeClean: same-file overlapping edits conflict (false)", { skip: !gitAvailable() }, () => {
  const { dir, cleanup } = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "f.txt"), "one\ntwo\nthree\n");
    git(dir, "add", "f.txt");
    git(dir, "commit", "-qm", "base f");
    git(dir, "checkout", "-qb", "branch");
    fs.writeFileSync(path.join(dir, "f.txt"), "ONE\ntwo\nthree\n");
    git(dir, "commit", "-qam", "branch edits f");
    git(dir, "checkout", "-q", "base");
    fs.writeFileSync(path.join(dir, "f.txt"), "one\nTWO\nthree\n");
    git(dir, "commit", "-qam", "base edits f");
    assert.equal(mergeTreeClean(dir, "base", "branch"), false);
  } finally {
    cleanup();
  }
});