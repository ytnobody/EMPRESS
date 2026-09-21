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