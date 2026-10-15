import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isHeld,
  highHoldPatch,
  clearHoldPatch,
  issueToTask,
  desiredLabels,
  buildGhBody,
  stripMetadata,
  localTaskStore,
} from "../src/domain/taskstore.js";

// Verifies: a task is effectively held only when its persisted status is "held"
// AND no human comment arrived after the hold (a human reply auto-clears), and
// that an already-merged branch (impure git probe supplied as `merged`) clears
// the hold too.
test("held: isHeld is true only for a held task with no later human comment", () => {
  assert.equal(isHeld({ status: "held", comments: [] }), true, "no comments => agent-held");
  assert.equal(
    isHeld({ status: "held", comments: [{ author: "empress", body: "held\n<!--empress:agent=abc-->" }] }),
    true,
    "latest agent comment keeps the hold"
  );
  assert.equal(isHeld({ status: "held", comments: [{ author: "alice", body: "please land it" }] }), false, "human reply clears");
  assert.equal(isHeld({ status: "held", comments: [], }, true), false, "merged branch clears");
  assert.equal(isHeld({ status: "open", comments: [] }), false, "non-held status is never held");
  assert.equal(isHeld({ status: "done", comments: [] }), false);
});

// Verifies: the land-gate refusal decision persists a hold exactly for an
// unforced HIGH and never for a forced HIGH or a non-HIGH (no change to landing
// semantics — force still bypasses the HIGH refusal as before, but is not a hold).
test("held: highHoldPatch holds exactly the unforced HIGH refusal", () => {
  assert.deepEqual(highHoldPatch("HIGH", false, ["changed high-risk path src/extension/"]), {
    status: "held",
    hold_reason: "changed high-risk path src/extension/",
  });
  assert.equal(highHoldPatch("HIGH", true, ["changed high-risk path src/extension/"]), null, "force => no hold");
  assert.equal(highHoldPatch("MEDIUM", false, ["x"]), null);
  assert.equal(highHoldPatch("LOW", false, ["x"]), null);
});

// Verifies: clearing a hold returns an assigned task to "assigned", an
// unassigned one to "open", and a merged branch to "done"; the reason is wiped.
test("held: clearHoldPatch returns actionable, merged becomes done", () => {
  assert.deepEqual(clearHoldPatch({ assignee: "superintendent" }), { status: "assigned", hold_reason: "" });
  assert.deepEqual(clearHoldPatch({ assignee: "" }), { status: "open", hold_reason: "" });
  assert.deepEqual(clearHoldPatch({ assignee: "superintendent" }, true), { status: "done", hold_reason: "" });
});

// Verifies: the local store's default list excludes held tasks while includeAll
// surfaces them WITH their persisted hold reason, and a human comment (no agent
// marker) returns the task to the actionable set.
test("held: local list hides held, includeAll shows the reason, human comment clears", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-"));
  try {
    fs.mkdirSync(path.join(dir, ".empress", "tasks"), { recursive: true });
    const store = localTaskStore(dir);
    store.create({ title: "Control-plane change" });
    store.update(1, { status: "held", hold_reason: "changed high-risk path src/extension/" });

    assert.equal(store.list().length, 0, "held is not actionable by default");
    const all = store.list({ includeAll: true });
    assert.equal(all.length, 1, "includeAll still shows it");
    assert.equal(all[0].status, "held");
    assert.equal(all[0].hold_reason, "changed high-risk path src/extension/", "hold reason persisted");

    store.addComment(1, "alice", "merge it please"); // human: no agent marker
    assert.equal(isHeld(store.get(1)), false, "human reply clears the effective hold");
    assert.equal(store.list().length, 1, "human reply returns it to the actionable set");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Verifies: the gh mapping reads the persisted hold from the status:held label
// plus the hold_reason body metadata, and filters the internal label out.
test("held: gh maps status:held + hold_reason metadata to a held task", () => {
  const issue = {
    number: 81,
    title: "Install gate",
    state: "open",
    createdAt: "x",
    body: "# t\n\n<!--empress:branch=empress/task-81-->\n<!--empress:hold_reason=changed high-risk path .empress/agents/-->",
    labels: [{ name: "status:held" }, { name: "bug" }],
  };
  const t = issueToTask(issue, "o/r");
  assert.equal(t.status, "held");
  assert.equal(t.hold_reason, "changed high-risk path .empress/agents/");
  assert.deepEqual(t.labels, ["bug"], "internal label filtered");
});

// Verifies: desiredLabels emits status:held, and buildGhBody embeds hold_reason
// as metadata while sanitizing it so a branch-controlled path containing `-->`
// or a newline cannot break out of the HTML-comment metadata field.
test("held: desiredLabels adds status:held; buildGhBody round-trips a sanitized reason", () => {
  const labels = desiredLabels({ labels: [], needs_clarification: false, assignee: "", status: "held" });
  assert.ok(labels.includes("status:held"));

  const evil = "changed high-risk path a-->b\nc";
  const full = buildGhBody("body", "", "", evil);
  const meta = full.match(/<!--empress:hold_reason=([^>]*)-->/)[1];
  assert.equal(meta.includes("-->"), false, "no premature metadata close");
  assert.equal(meta.includes("\n"), false, "no newline injection");
  assert.equal(stripMetadata(full), "body", "human body preserved");

  const t = issueToTask({ number: 1, title: "x", state: "open", createdAt: "x", body: full, labels: [] }, "o/r");
  assert.equal(t.hold_reason.includes("-->"), false);
});
