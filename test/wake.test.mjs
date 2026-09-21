// Run-driver wake logic — zero-LLM wake + preflight readiness batch (pure-ish,
// injectable Jev). Per PFT: hash determinism, not-ready detection, and the
// single-batch Jev call are the verification-arithmetic units.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tasksHash } from "../src/domain/wake.js";
import { checkReadyTasks, nextJevFailures, JEV_DEGRADED_REASON } from "../src/domain/readiness.js";

function mkTasksDir(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-"));
  const tasks = path.join(dir, ".empress", "tasks");
  fs.mkdirSync(tasks, { recursive: true });
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(tasks, name), content);
  return { dir, tasks };
}

const keepBody = (id, title) =>
  ["---", `id: ${id}`, 'title: "x"', "status: open", "comments: []", "---", "", `# ${title}`, "",
    "## Purpose", "purpose text", "", "## Scope", "scope", "", "## Acceptance Criteria", "- [ ] pass", ""].join("\n");

// Verifies: the task-queue hash is stable for identical content and changes when a file is added.
test("tasksHash: stable for same content, changes on mutation", () => {
  const { dir } = mkTasksDir({ "0001-a.md": "x" });
  const h1 = tasksHash(dir);
  assert.equal(tasksHash(dir), h1); // stable
  fs.writeFileSync(path.join(dir, ".empress", "tasks", "0002-b.md"), "y");
  assert.notEqual(tasksHash(dir), h1); // changed
  fs.unlinkSync(path.join(dir, ".empress", "tasks", "0001-a.md"));
  assert.notEqual(tasksHash(dir), h1);
});

// Verifies: empty/missing tasks dir produces a hash (no throw).
test("tasksHash: missing dir is handled (empty hash, no throw)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-empty-"));
  assert.equal(typeof tasksHash(dir), "string");
  assert.ok(tasksHash(dir).length > 0);
});

// Verifies: deterministic readiness rejects a too-short / AC-less body without Jev.
test("checkReadyTasks: deterministic guards (Jev off)", async () => {
  const { dir } = mkTasksDir();
  const shortTask = { id: 1, title: "t", body: "# t\n## Purpose\nshort" };
  const config = { readiness: { use_jev: false, min_body_length: 40 }, jev: { model: "jev-latest" } };
  const res = await checkReadyTasks(dir, config, [shortTask]);
  assert.equal(res[0].ready, false);
  assert.ok(res[0].reasons.some((r) => /too short|acceptance/i.test(r)));
});

// Verifies: a spec-complete body passes deterministic readiness without Jev.
test("checkReadyTasks: complete body passes (Jev off)", async () => {
  const { dir } = mkTasksDir();
  const goodTask = { id: 2, title: "t", body: keepBody(2, "t") };
  const config = { readiness: { use_jev: false, min_body_length: 40 }, jev: { model: "jev-latest" } };
  const res = await checkReadyTasks(dir, config, [goodTask]);
  assert.equal(res[0].ready, true);
});

// Verifies: with Jev enabled, the batch issues exactly ONE call for all tasks.
test("checkReadyTasks: one batch Jev call for the ready-needed group", async () => {
  const { dir } = mkTasksDir();
  const tasks = [1, 2, 3].map((i) => ({ id: i, title: `t${i}`, body: keepBody(i, `t${i}`) }));
  const calls = [];
  const fakeJudge = async (opts) => {
    calls.push({ type: opts.type, states: opts.states });
    return { ok: true, results: opts.states.map((s) => ({ answer: { noul: 0.9 } })) };
  };
  const config = { readiness: { use_jev: true, jev_threshold: 0.6 }, jev: { model: "jev-latest" } };
  const res = await checkReadyTasks(dir, config, tasks, { _jevJudge: fakeJudge, _jevAvailable: () => ({ available: true }) });
  assert.equal(calls.length, 1); // ONE call total
  assert.equal(calls[0].type, "noul");
  assert.equal(calls[0].states.length, 3); // all three in one batch
  assert.deepEqual(res.map((r) => r.ready), [true, true, true]);
});

// Verifies: Jev low probability flips an otherwise-ready task to not-ready (per threshold).
test("checkReadyTasks: Jev below threshold marks not-ready", async () => {
  const { dir } = mkTasksDir();
  const task = { id: 7, title: "t", body: keepBody(7, "t") };
  const fakeJudge = async (opts) => ({ ok: true, results: opts.states.map((s, i) => ({ answer: { noul: i === 0 ? 0.3 : 0.9 } })) });
  const config = { readiness: { use_jev: true, jev_threshold: 0.6 }, jev: {} };
  const res = await checkReadyTasks(dir, config, [task], { _jevJudge: fakeJudge, _jevAvailable: () => ({ available: true }) });
  assert.equal(res[0].ready, false);
  assert.match(res[0].reasons.join(" "), /Jev 0\.30 < 0\.6/);
});

// Verifies: a Jev BATCH ERROR degrades to deterministic-only readiness (reasons tagged
// visibly), i.e. ready is unchanged from the no-key case but no longer silent.
test("checkReadyTasks: Jev batch error degrades to deterministic-ready, visibly", async () => {
  const { dir } = mkTasksDir();
  const task = { id: 9, title: "t", body: keepBody(9, "t") };
  const fakeJudge = async (opts) => ({ ok: false, results: [], error: "network down" });
  const config = { readiness: { use_jev: true, jev_threshold: 0.6 }, jev: {} };
  const res = await checkReadyTasks(dir, config, [task], { _jevJudge: fakeJudge, _jevAvailable: () => ({ available: true }) });
  assert.equal(res[0].ready, true); // deterministic said ready; Jev error must NOT flip it
  assert.equal(res[0].jev, null); // no usable probability
  assert.ok(res[0].reasons.includes(JEV_DEGRADED_REASON)); // degradation is visible
});

// Verifies: an unparseable-but-ok Jev answer (no noul) is treated like an error
// (deterministic-only, visible marker) — no usable probability.
test("checkReadyTasks: unparseable Jev answer degrades like a batch error", async () => {
  const { dir } = mkTasksDir();
  const task = { id: 10, title: "t", body: keepBody(10, "t") };
  const fakeJudge = async (opts) => ({ ok: true, results: opts.states.map(() => ({ answer: { weird: 1 } })) });
  const config = { readiness: { use_jev: true, jev_threshold: 0.6 }, jev: {} };
  const res = await checkReadyTasks(dir, config, [task], { _jevJudge: fakeJudge, _jevAvailable: () => ({ available: true }) });
  assert.equal(res[0].ready, true);
  assert.equal(res[0].jev, null);
  assert.ok(res[0].reasons.includes(JEV_DEGRADED_REASON));
});

// Verifies: consecutive-Jev-failure arithmetic is pure — increments on error, resets on success.
test("nextJevFailures: increments while degraded, resets on recovery", () => {
  assert.equal(nextJevFailures(true, 0), 1); // first Jev failure
  assert.equal(nextJevFailures(true, 3), 4); // consecutive run continues
  assert.equal(nextJevFailures(false, 3), 0); // success -> reset
  assert.equal(nextJevFailures(false, undefined), 0); // never degraded
});