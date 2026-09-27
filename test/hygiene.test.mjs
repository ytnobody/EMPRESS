// Repo-tree hygiene gate (Task #54): tracked-but-gitignored detection + symlink gitignore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { treeHygieneViolations, isGitignored } from "../src/domain/hygiene.js";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "empress-hyg-"));
  const g = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: "pipe" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  return dir;
}

test("hygiene: treeHygieneViolations flags a force-added gitignored path", () => {
  const dir = repo();
  try {
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "x"), "x");
    execFileSync("git", ["-C", dir, "add", "-f", "node_modules"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "x"]);
    const v = treeHygieneViolations(dir);
    assert.ok(v.some((p) => p === "node_modules" || p.includes("node_modules")), `expected node_modules listed, got ${v}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hygiene: treeHygieneViolations is empty on a clean tree", () => {
  const dir = repo();
  try {
    fs.writeFileSync(path.join(dir, "src.ts"), "export const a=1;\n");
    execFileSync("git", ["-C", dir, "add", "-A"]); execFileSync("git", ["-C", dir, "commit", "-qm", "clean"]);
    assert.deepEqual(treeHygieneViolations(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hygiene: isGitignored matches BOTH a real dir and a same-named symlink", () => {
  const dir = repo();
  try {
    // real directory
    fs.mkdirSync(path.join(dir, "node_modules"));
    assert.equal(isGitignored(dir, "node_modules"), true);
    // same name as a symlink (the case the old 'node_modules/' pattern missed)
    fs.rmdirSync(path.join(dir, "node_modules"));
    fs.symlinkSync(path.join(dir, "somewhere-else"), path.join(dir, "node_modules"));
    assert.equal(isGitignored(dir, "node_modules"), true, "symlink node_modules must be ignored (no trailing slash)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});