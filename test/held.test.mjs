import { test } from "node:test";
import assert from "node:assert/strict";
import { heldReady, decideHeldAction, classifyHeldStatus } from "../src/domain/held.js";

// Verifies: only a branch that is BOTH CI-green and conflict-free is sign-off-ready.
// (Spec rule 1: ready iff ciGreen && conflictFree.)
test("heldReady: CI-green + conflict-free is ready with no blockers", () => {
  const r = heldReady({ ciGreen: true, conflictFree: true });
  assert.equal(r.ready, true);
  assert.deepEqual(r.blockers, []);
});

// Verifies: failing CI alone blocks sign-off — even a conflict-free branch must not
// be ready-for-human while its tests are red. (Spec rule 1.)
test("heldReady: CI-red, conflict-free is not ready (blocker ci_red)", () => {
  const r = heldReady({ ciGreen: false, conflictFree: true });
  assert.equal(r.ready, false);
  assert.deepEqual(r.blockers, ["ci_red"]);
});

// Verifies: a merge conflict alone blocks sign-off — the branch can't land cleanly
// until it is rebased/re-implemented. (Spec rule 1.)
test("heldReady: conflict, CI-green is not ready (blocker conflict)", () => {
  const r = heldReady({ ciGreen: true, conflictFree: false });
  assert.equal(r.ready, false);
  assert.deepEqual(r.blockers, ["conflict"]);
});

// Verifies: a branch that is BOTH CI-red and conflicted is not ready, and BOTH
// blockers are reported independently (each axis is its own readiness signal).
test("heldReady: CI-red AND conflict reports both blockers", () => {
  const r = heldReady({ ciGreen: false, conflictFree: false });
  assert.equal(r.ready, false);
  assert.deepEqual(r.blockers, ["ci_red", "conflict"]);
});

// Verifies: the action follows readiness — ready maps to sign-off-hold (leave for
// the human), never to an engineer fix. (Spec rule 1/2; Non-Goal: no auto-merge.)
test("decideHeldAction: ready => sign-off-hold (human sign-off, not engineer)", () => {
  const d = decideHeldAction(heldReady({ ciGreen: true, conflictFree: true }));
  assert.equal(d, "sign-off-hold");
});

// Verifies: a CI-red branch is actionable-for-fix, so the loop re-engages an
// Engineer instead of verify-and-holding a regressed branch. (Spec rule 2.)
test("decideHeldAction: CI-red => needs-fix (re-engage engineer)", () => {
  const d = decideHeldAction(heldReady({ ciGreen: false, conflictFree: true }));
  assert.equal(d, "needs-fix");
});

// Verifies: a conflicted branch is actionable-for-fix (rebase/re-implement), even
// when its own CI is green. (Spec rule 2.)
test("decideHeldAction: conflict => needs-fix (rebase/re-implement)", () => {
  const d = decideHeldAction(heldReady({ ciGreen: true, conflictFree: false }));
  assert.equal(d, "needs-fix");
});

// Verifies: classifyHeldStatus groups held tasks into needsFix vs hold by their
// decision — only regressed branches land in needsFix, and ids are preserved.
test("classifyHeldStatus: regressed held tasks go to needsFix, clean ones to hold", () => {
  const { needsFix, hold } = classifyHeldStatus([
    { id: 1, ciGreen: true, conflictFree: true },
    { id: 2, ciGreen: false, conflictFree: true },
    { id: 3, ciGreen: true, conflictFree: false },
    { id: 4, ciGreen: false, conflictFree: false },
  ]);
  assert.deepEqual(needsFix, [2, 3, 4]);
  assert.deepEqual(hold, [1]);
});