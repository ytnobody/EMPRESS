// Activity-based stall watchdog decision (pure). Per PFT: the decision
// `shouldStallKill` is the verification-arithmetic unit — expectations are
// derived from the spec (kill iff a LIVE child is silent past the window),
// independent of the exec-layer timers in runPass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldStallKill } from "../src/domain/stall.js";

// Verifies: a live child silent for exactly the stall window is stalled -> kill.
test("stall: live child silent exactly the window is killed", () => {
  assert.equal(shouldStallKill({ childAlive: true, lastActivityAt: 1000, now: 1000 + 300_000, stallMs: 300_000 }), true);
});

// Verifies: a live child silent past the window (more than stallMs elapsed) is killed.
test("stall: live child silent past the window is killed", () => {
  assert.equal(shouldStallKill({ childAlive: true, lastActivityAt: 5000, now: 5000 + 60_000 + 1, stallMs: 60_000 }), true);
});

// Verifies: a live child that produced output within the window (elapsed < stallMs)
// is "slow but working" and NOT killed — the core slow-vs-stalled distinction.
test("stall: live child active within the window is not killed", () => {
  assert.equal(shouldStallKill({ childAlive: true, lastActivityAt: 10_000, now: 10_000 + 59_999, stallMs: 60_000 }), false);
});

// Verifies: a dead child is never killed by the stall watchdog, even if silent
// for ages — the close/error handler already resolved that pass.
test("stall: a dead child is never killed even if long silent", () => {
  assert.equal(shouldStallKill({ childAlive: false, lastActivityAt: 0, now: 1_000_000, stallMs: 60_000 }), false);
});

// Verifies: the stallMs floor of 1ms means a just-spawned pass (elapsed 0) with a
// zero/negative configured window is never spuriously killed on the first check.
test("stall: zero/negative window clamps so elapsed-0 is never a false kill", () => {
  assert.equal(shouldStallKill({ childAlive: true, lastActivityAt: 0, now: 0, stallMs: 0 }), false);
  assert.equal(shouldStallKill({ childAlive: true, lastActivityAt: 0, now: 0, stallMs: -5 }), false);
});