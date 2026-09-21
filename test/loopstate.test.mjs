import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultLoopState, mergeLoopState } from "../src/domain/loopstate.js";

// Verifies: a fresh loop state has running status, no timestamps/history set,
// and zero consecutive-failure count — the baseline all state is built upon.
test("loopstate: defaultLoopState has the running baseline", () => {
  assert.deepEqual(defaultLoopState(), {
    status: "running",
    pr_comments_since: null,
    task_comments_since: null,
    last_pass_at: null,
    consecutive_failures: 0,
    consecutive_jev_failures: 0,
    last_success_tick: null,
  });
});

// Verifies: merging a patch overrides only the patched keys and leaves the rest
// intact, and the base object is not mutated (pure function).
test("loopstate: mergeLoopState applies patch without mutating the base", () => {
  const base = defaultLoopState();
  const next = mergeLoopState(base, { status: "paused", consecutive_failures: 2 });
  assert.equal(next.status, "paused");
  assert.equal(next.consecutive_failures, 2);
  assert.equal(next.last_pass_at, null); // unpatched key preserved
  assert.equal(base.status, "running"); // base untouched
});