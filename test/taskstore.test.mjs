// Task store tests: local-store regression + pure gh mapping + backend selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { localTaskStore, ghTaskStore, issueToTask, desiredLabels, buildGhBody, buildMarkdown, stripMetadata, getTaskStore, hasHumanReply, proposeSpec, detectLanguage } from "../src/domain/taskstore.js";
import { addComment, updateTask, getTask, closeTask, listTasks, removeTask } from "../src/domain/tasks.js";
import { DEFAULTS } from "../src/shared/config.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "empress-ts-"));
}

// A fake `run` that emulates a tiny GitHub, recording invocations.
function makeFakeDeps(calls) {
  const run = (_cmd, args) => {
    calls.push([_cmd, ...args]);
    if (_cmd === "gh" && args[0] === "--version") return { code: 0, stdout: "", stderr: "", signal: null };
    if (_cmd === "gh" && args[0] === "issue" && args[1] === "create") {
      return { code: 0, stdout: "https://github.com/ytnobody/EMPRESS/issues/1\n", stderr: "", signal: null };
    }
    if (_cmd === "gh" && args[0] === "issue" && args[1] === "view") {
      return { code: 0, stdout: JSON.stringify({ number: 1, title: "gh task", state: "open", createdAt: "x", body: "body", labels: [] }), stderr: "", signal: null };
    }
    if (_cmd === "gh" && args[0] === "issue" && args[1] === "list") {
      return { code: 0, stdout: JSON.stringify([{ number: 1, title: "gh task", state: "open", createdAt: "x", body: "body", labels: [] }]), stderr: "", signal: null };
    }
    return { code: 0, stdout: "[]", stderr: "", signal: null };
  };
  return { storeDeps: { run } };
}

// ---------------------------------------------------------------------------
// Local store (regression via the tasks.js delegate API)
// ---------------------------------------------------------------------------
test("taskstore: local store create/list/get/comment/update/close/remove round-trip", () => {
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".empress", "tasks"), { recursive: true });

  const created = localTaskStore(dir).create({ title: "Do a thing", purpose: "p", scope: "s", acceptance: ["tests pass"], nongoals: ["no risk"] });
  assert.equal(created.id, 1);
  assert.equal(created.status, "open");
  assert.equal(created.file.endsWith(".md"), true);
  assert.deepEqual(getTask(dir, 1), created);

  const commented = addComment(dir, 1, "empress", "hearing");
  assert.equal(commented.comments.length, 1);
  assert.equal(commented.comments[0].author, "empress");

  const updated = updateTask(dir, 1, { status: "assigned", assignee: "superintendent", branch: "empress/task-1" });
  assert.equal(updated.status, "assigned");
  assert.equal(updated.branch, "empress/task-1");

  assert.equal(listTasks(dir).length, 1); // assigned is actionable
  const closed = closeTask(dir, 1, "landed");
  assert.equal(closed.status, "done");
  assert.equal(listTasks(dir).length, 0); // done excluded
  assert.equal(listTasks(dir, { includeAll: true }).length, 1);

  assert.equal(removeTask(dir, 1), true);
  assert.equal(getTask(dir, 1), null);
});

// ---------------------------------------------------------------------------
// Pure gh mapping
// ---------------------------------------------------------------------------
test("taskstore: issueToTask maps a GitHub issue JSON to a Task", () => {
  const issue = {
    number: 19,
    title: "Gh task",
    state: "open",
    createdAt: "2026-09-26T00:00:00Z",
    body: "# Gh task\n\n## Purpose\nhi\n\n<!--empress:branch=empress/task-19-->\n<!--empress:pr=42-->",
    labels: [{ name: "status:in-progress" }, { name: "status:blocked" }, { name: "needs-clarification" }, { name: "assignee:superintendent" }, { name: "bug" }],
  };
  const t = issueToTask(issue, "ytnobody/EMPRESS");
  assert.equal(t.id, 19);
  assert.equal(t.status, "blocked"); // status:blocked wins over in-progress
  assert.equal(t.assignee, "superintendent");
  assert.equal(t.needs_clarification, true);
  assert.deepEqual(t.labels, ["bug"]); // internal labels filtered out
  assert.equal(t.branch, "empress/task-19");
  assert.equal(t.pr, "42");
  assert.equal(t.body.includes("empress:"), false); // metadata stripped from human body
  assert.equal(t.file, "gh://ytnobody/EMPRESS#19");
});

test("taskstore: closed issue maps to done regardless of labels", () => {
  const t = issueToTask({ number: 1, title: "x", state: "closed", createdAt: "", body: "", labels: [] }, "o/r");
  assert.equal(t.status, "done");
});

test("taskstore: no status labels + no assignee => open", () => {
  const t = issueToTask({ number: 2, title: "y", state: "open", createdAt: "", body: "", labels: [] }, "o/r");
  assert.equal(t.status, "open");
});

test("taskstore: desiredLabels builds the internal label set for a task state", () => {
  const labels = desiredLabels({ labels: ["bug"], needs_clarification: true, assignee: "superintendent", status: "blocked" });
  assert.ok(labels.includes("status:blocked"));
  assert.ok(labels.includes("needs-clarification"));
  assert.ok(labels.includes("assignee:superintendent"));
  assert.ok(labels.includes("bug"));
  assert.ok(!labels.includes("status:in-progress"));
});

test("taskstore: buildGhBody / stripMetadata are inverse for branch+pr", () => {
  const full = buildGhBody("hello body", "empress/task-1", "7");
  assert.equal(stripMetadata(full), "hello body");
  assert.ok(full.includes("<!--empress:branch=empress/task-1-->"));
  assert.ok(full.includes("<!--empress:pr=7-->"));
});

test("taskstore: hasHumanReply flags only plain (non-agent) latest comments", () => {
  assert.equal(hasHumanReply({ comments: [{ at: "", author: "x", body: "**[empress]** draft spec" }] }), false);
  assert.equal(hasHumanReply({ comments: [{ at: "", author: "x", body: "**[superintendent]** follow-up" }, { at: "", author: "x", body: "I think it should do X" }] }), true);
  assert.equal(hasHumanReply({ comments: [] }), false);
});

test("taskstore: proposeSpec derives a draft spec + open questions from the title", () => {
  const p = proposeSpec({ title: "Speed up startup", body: "# Speed up startup" });
  assert.ok(p.purpose.includes("Speed up startup"));
  assert.ok(p.scope.includes("Speed up startup"));
  assert.ok(p.questions.length >= 3);
  assert.ok(p.acceptance.some((a) => /question/.test(a)));
});

test("taskstore: detectLanguage + proposeSpec localize for Japanese issues", () => {
  assert.equal(detectLanguage("今日はいい天気です"), "ja");
  assert.equal(detectLanguage("Hello world"), "en");
  const p = proposeSpec({ title: "導入手順をドキュメントにかく" }, "ja");
  assert.ok(p.purpose.includes("導入手順をドキュメントにかく"));
  assert.ok(p.questions[0].includes("導入手順をドキュメントにかく"));
});

test("taskstore: buildMarkdown derives Purpose/Scope from title when omitted (no _to be filled_ stubs)", () => {
  const body = buildMarkdown({ title: "Prune stale merged local branches", acceptance: ["git branch shows no test-90xx"] });
  assert.ok(body.includes("## Purpose"));
  assert.ok(!/Purpose\n_to be filled_/.test(body), "Purpose must not be a bare placeholder");
  assert.ok(!/Scope\n_to be filled_/.test(body), "Scope must not be a bare placeholder");
  assert.ok(body.includes("Prune stale merged local branches"));
  assert.ok(body.includes("git branch shows no test-90xx"));
  // explicit purpose/scope preserved verbatim
  const explicit = buildMarkdown({ title: "X", purpose: "explicit purpose", scope: "explicit scope" });
  assert.ok(explicit.includes("explicit purpose"));
  assert.ok(explicit.includes("explicit scope"));
});

// ---------------------------------------------------------------------------
// gh backend + selection (fake runner — never touches real GitHub)
// ---------------------------------------------------------------------------
test("taskstore: ghTaskStore.create issues a gh issue and returns a gh-backed task", () => {
  const dir = tmpdir();
  const calls = [];
  const { storeDeps } = makeFakeDeps(calls);
  const store = ghTaskStore(dir, { enabled: true, owner: "ytnobody", repo: "EMPRESS" }, storeDeps);
  const t = store.create({ title: "gh task" });
  assert.equal(t.id, 1);
  assert.ok(t.file.startsWith("gh://"));
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "issue" && c[2] === "create"));
});

test("taskstore: getTaskStore selects gh when enabled+available, local when disabled or gh down", () => {
  const dir = tmpdir();
  const cfgEnabled = { ...structuredClone(DEFAULTS), file: null, cwd: dir, github: { enabled: true, owner: "ytnobody", repo: "EMPRESS" } };
  const cfgDisabled = { ...structuredClone(DEFAULTS), file: null, cwd: dir };

  const ghStore = getTaskStore(dir, cfgEnabled, makeFakeDeps([]).storeDeps);
  assert.ok(ghStore.create({ title: "gh task" }).file.startsWith("gh://"));

  const local = getTaskStore(dir, cfgDisabled, makeFakeDeps([]).storeDeps);
  assert.ok(local.create({ title: "local" }).file.endsWith(".md"));

  // enabled but gh unavailable -> fall back to local
  const localFallback = getTaskStore(dir, cfgEnabled, { ghAvailable: () => false });
  assert.ok(localFallback.create({ title: "offline" }).file.endsWith(".md"));
});