// Run-driver cadence: ready-backlog self-propagation (task #53). Per PFT, the
// step functions shouldRunReadyPass / backlogAfterPreflight are the pure
// verification-arithmetic units; the test expectations are derived from the
// design doc (docs/design-task-53.md), not from running the driver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRunReadyPass, backlogAfterPreflight } from "../src/cli/run.js";

// Verifies: leftover ready work (backlog=true) triggers a ready pass next tick even
// when the task-queue hash did not change (the observed #32–#37 strand: max_engineers
// leaves a ready batch but nothing nudges the hash).
test("shouldRunReadyPass: backlog reprocesses with no queue change", () => {
  assert.equal(shouldRunReadyPass({ queueChanged: false, backlog: true, auditDue: false }), true);
});

// Verifies: with no backlog and no queue change there is no ready pass (no busy-spin /
// zero LLM when nothing is ready).
test("shouldRunReadyPass: nothing to reprocess → no pass, no spin", () => {
  assert.equal(shouldRunReadyPass({ queueChanged: false, backlog: false, auditDue: false }), false);
});

// Verifies: a queue change still triggers the preflight/pass path (existing behaviour preserved).
test("shouldRunReadyPass: queue change triggers a pass", () => {
  assert.equal(shouldRunReadyPass({ queueChanged: true, backlog: false, auditDue: false }), true);
});

// Verifies: an audit-due tick defers the ready pass altogether (audit runs instead);
// the backlog signal is NOT cleared here, so a later tick reprocesses.
test("shouldRunReadyPass: audit-due defers the ready pass (backlog survives)", () => {
  assert.equal(shouldRunReadyPass({ queueChanged: true, backlog: true, auditDue: true }), false);
});

// Verifies: a preflight that finds ready work keeps the self-propagating signal on so
// the next tick reprocesses without a queue change.
test("backlogAfterPreflight: ready work keeps the backlog", () => {
  assert.equal(backlogAfterPreflight(3), true);
});

// Verifies: a preflight that finds no ready work clears the signal (termination, no spin).
test("backlogAfterPreflight: no ready work clears the backlog", () => {
  assert.equal(backlogAfterPreflight(0), false);
});

// Verifies the acceptance criterion end-to-end as a pure state machine: a 5-task ready
// batch split across max_engineers reprocesses across ticks 1→3 with NO queue change,
// stops on tick 4 once drained. Simulated expectation derived from the design-doc rules.
test("backlog state machine: batch split across ticks reprocesses and terminates", () => {
  const ticks = [
    { changed: true, ready: 5 }, // first pass: create/see 5 ready
    { changed: false, ready: 3 }, // max_engineers consumed 2; leftover self-propagates
    { changed: false, ready: 0 }, // remaining consumed; drain clears the signal
    { changed: false, ready: 0 }, // nothing ready + no change → stop
  ];
  let backlog = false;
  const wantReady = [];
  const ranPass = [];
  for (const t of ticks) {
    const w = shouldRunReadyPass({ queueChanged: t.changed, backlog, auditDue: false });
    wantReady.push(w);
    if (w) {
      ranPass.push(t.ready > 0);
      backlog = backlogAfterPreflight(t.ready);
    }
  }
  // Ticks 2 & 3 run despite changed=false (self-propagation); tick 4 stops (no spin).
  assert.deepEqual(wantReady, [true, true, true, false]);
  assert.deepEqual(ranPass, [true, true, false]);
  assert.equal(backlog, false); // drained at the end
});

// Verifies the acceptance criterion "an interleaved audit pass does not strand them":
// an audit-due tick defers the ready pass, the backlog survives, and the next non-audit
// tick reprocesses the leftover.
test("cadence: an interleaved audit pass does not strand the backlog", () => {
  const ticks = [
    { changed: true, ready: 5, auditDue: false },
    { changed: false, ready: 0, auditDue: true }, // audit runs; defers ready pass
    { changed: false, ready: 2, auditDue: false }, // leftover reprocessed after audit
  ];
  let backlog = false;
  const wantReady = [];
  for (const t of ticks) {
    const w = shouldRunReadyPass({ queueChanged: t.changed, backlog, auditDue: t.auditDue });
    wantReady.push(w);
    if (w) backlog = backlogAfterPreflight(t.ready);
  }
  // Audit tick defers (false); backlog survives it so the next tick reprocesses (true).
  assert.deepEqual(wantReady, [true, false, true]);
});