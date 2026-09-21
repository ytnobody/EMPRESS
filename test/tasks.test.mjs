import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTask, addComment, updateTask, getTask } from "../src/domain/tasks.js";

// Verifies: createTask writes a task file with open status, an id derived from
// the next slot, preserving title/labels and starting with an empty comment log.
test("tasks: createTask round-trips a fresh task", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"));
  try {
    const t = createTask(tmp, { title: "Greeter", labels: ["core"], acceptance: ["works"] });
    assert.equal(t.id, 1);
    assert.equal(t.status, "open");
    assert.equal(t.title, "Greeter");
    assert.deepEqual(t.labels, ["core"]);
    assert.deepEqual(t.comments, []);
    // re-read from disk to prove it persisted
    const reread = getTask(tmp, 1);
    assert.deepEqual(reread.labels, ["core"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies: addComment appends a full {author, at, body} comment object that
// survives a read-back round-trip through the frontmatter (comments persist).
test("tasks: addComment persists the comment object", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"));
  try {
    createTask(tmp, { title: "Greeter" });
    addComment(tmp, 1, "empress", "hello");
    const t = getTask(tmp, 1);
    assert.equal(t.comments.length, 1);
    assert.equal(t.comments[0].author, "empress");
    assert.equal(t.comments[0].body, "hello");
    assert.ok(typeof t.comments[0].at === "string");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies: updateTask overrides the whitelisted keys (status, labels) on disk
// while preserving the persisted comment log (comments survive an update).
test("tasks: updateTask applies patch and keeps existing comments", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"));
  try {
    createTask(tmp, { title: "Greeter" });
    addComment(tmp, 1, "empress", "first");
    updateTask(tmp, 1, { status: "done", labels: ["x"] });
    const t = getTask(tmp, 1);
    assert.equal(t.status, "done");
    assert.deepEqual(t.labels, ["x"]);
    assert.equal(t.comments.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});