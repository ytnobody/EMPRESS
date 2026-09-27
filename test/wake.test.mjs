// Run-driver wake logic — zero-LLM wake + preflight readiness batch (pure-ish,
// injectable Jev). Per PFT: hash determinism, not-ready detection, and the
// single-batch Jev call are the verification-arithmetic units.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tasksHash } from "../src/domain/wake.js";
import { checkReadyTasks, nextJevFailures, JEV_DEGRADED_REASON, planClarifyProposals, postClarifyProposals, CLARIFY_PROPOSAL_MARKER } from "../src/domain/readiness.js";
import { getTask } from "../src/domain/tasks.js";
import { localTaskStore, proposeSpec } from "../src/domain/taskstore.js";

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

// Verifies: non-.md entries (.probe/temp noise) do not change the wake hash
// (only .md task files are hashed, so adding non-md content cannot change it).
test("tasksHash: non-md files leave the hash unchanged", () => {
  const { dir } = mkTasksDir({ "0001-a.md": "x" });
  const h1 = tasksHash(dir);
  fs.writeFileSync(path.join(dir, ".empress", "tasks", ".probe"), "noise");
  assert.equal(tasksHash(dir), h1); // unchanged: only .md entries count
  fs.writeFileSync(path.join(dir, ".empress", "tasks", "scratch.tmp"), "more noise");
  assert.equal(tasksHash(dir), h1); // still unchanged
  fs.writeFileSync(path.join(dir, ".empress", "tasks", "0002-b.md"), "y");
  assert.notEqual(tasksHash(dir), h1); // a real task file still wakes the loop
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

// ---------------------------------------------------------------------------
// Proposal-first clarification (Task #35): planClarifyProposals / postClarifyProposals
// ---------------------------------------------------------------------------

// Verifies: an under-specified (title-only) task plans exactly ONE proposal Command
// whose comment carries the dedupe marker, the proposeSpec draft spec, the open
// questions, and the readiness reasons — expected fields derived from proposeSpec
// (a separately specified pure function), not from the implementation's output.
test("planClarifyProposals: one proposal per under-specified task, with marker + draft spec + reasons", () => {
  const task = { id: 3, title: "Tune the watcher", body: "# Tune the watcher", comments: [] };
  const reasons = ["body too short (<40 non-whitespace chars)", "no acceptance-criteria section"];
  const plans = planClarifyProposals([{ task, reasons }]);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].taskId, 3);
  const c = plans[0].comment;
  const p = proposeSpec(task, "en"); // spec content is proposeSpec's contract
  assert.ok(c.startsWith("**[empress]** "), "agent marker prefix (local stores store it verbatim)");
  assert.ok(c.includes(`<!--${CLARIFY_PROPOSAL_MARKER}-->`), "dedupe marker present");
  assert.ok(c.includes(`- Purpose: ${p.purpose}`));
  assert.ok(c.includes(`- Scope: ${p.scope}`));
  assert.ok(c.includes(`- Acceptance Criteria: [ ] ${p.acceptance[0]}`));
  assert.ok(c.includes(`- Non-Goals: ${p.nongoals.join(", ")}`));
  for (const q of p.questions) assert.ok(c.includes(q), `open question present: ${q}`);
  assert.ok(c.includes(`(reason: ${reasons.join("; ")})`), "readiness reasons carried verbatim");
});

// Verifies: dedupe — a task whose comments already contain the proposal marker plans
// nothing (a proposal is never posted twice, whatever posted the first one).
test("planClarifyProposals: an already-proposed task plans nothing (dedupe)", () => {
  const task = { id: 4, title: "Old issue", body: "# Old issue", comments: [{ at: "", author: "empress", body: `**[empress]** draft <!--${CLARIFY_PROPOSAL_MARKER}-->` }] };
  assert.deepEqual(planClarifyProposals([{ task, reasons: ["body too short"] }]), []);
});

// Verifies: dedupe is per-task — an already-proposed task does not suppress the fresh one.
test("planClarifyProposals: dedupe is per task (fresh tasks still planned)", () => {
  const proposed = { id: 1, title: "Old", body: "# Old", comments: [{ at: "", author: "empress", body: `x <!--${CLARIFY_PROPOSAL_MARKER}-->` }] };
  const fresh = { id: 2, title: "New", body: "# New", comments: [] };
  const plans = planClarifyProposals([{ task: proposed, reasons: [] }, { task: fresh, reasons: [] }]);
  assert.deepEqual(plans.map((x) => x.taskId), [2], "only the fresh task is planned, in input order");
});

// Verifies: language awareness — a Japanese title-only issue gets the Japanese framing
// and the Japanese draft spec (header/section labels and proposeSpec fields).
test("planClarifyProposals: Japanese issue gets a Japanese proposal", () => {
  const task = { id: 5, title: "起動を速くする", body: "# 起動を速くする", comments: [] };
  const plans = planClarifyProposals([{ task, reasons: ["body too short"] }]);
  assert.equal(plans.length, 1);
  const c = plans[0].comment;
  const p = proposeSpec(task, "ja");
  assert.ok(c.includes("仕様が不足しています"), "Japanese intro");
  assert.ok(c.includes("提案（ドラフト）:"), "Japanese Proposed label");
  assert.ok(c.includes("未解決の質問:"), "Japanese Open questions label");
  assert.ok(c.includes(`- Purpose: ${p.purpose}`));
  assert.ok(p.questions.every((q) => c.includes(q)), "Japanese questions embedded");
});

// Verifies: empty input plans nothing (no spurious comments on an empty queue).
test("planClarifyProposals: empty checks plan nothing", () => {
  assert.deepEqual(planClarifyProposals([]), []);
});

function clarifyTmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wake-clarify-"));
}

// Verifies (shell boundary smoke): postClarifyProposals executes the planned Command
// on the real local store — comment persisted with the marker, task marked
// needs_clarification + blocked, no pending reply reported (the proposal itself is
// an agent comment), and a second call posts nothing (dedupe via the fresh read).
test("postClarifyProposals: posts proposal + marks blocked; repeats dedupe to 0", () => {
  const dir = clarifyTmpdir();
  const created = localTaskStore(dir).create({ title: "Title only" });
  const r1 = postClarifyProposals(dir, [{ task: created, reasons: ["body too short"] }]);
  assert.equal(r1.posted, 1);
  assert.deepEqual(r1.pendingReply, []); // agent proposal is not a human reply
  const fresh = getTask(dir, created.id);
  assert.ok(fresh.comments.some((c) => c.body.includes(CLARIFY_PROPOSAL_MARKER)), "proposal comment persisted");
  assert.equal(fresh.needs_clarification, true);
  assert.equal(fresh.status, "blocked");
  const r2 = postClarifyProposals(dir, [{ task: fresh, reasons: ["body too short"] }]);
  assert.equal(r2.posted, 0, "no duplicate proposal on the next wake");
  assert.deepEqual(r2.pendingReply, []);
});

// Verifies: pendingReply is the single-reply pick-up gate — a plain (non-agent)
// latest comment counts as a pending human reply and no new proposal is posted for
// an already-proposed task; an agent follow-up comment does NOT count.
test("postClarifyProposals: pendingReply reports a human reply, never an agent comment", () => {
  const dir = clarifyTmpdir();
  const created = localTaskStore(dir).create({ title: "Title only" });
  postClarifyProposals(dir, [{ task: created, reasons: ["body too short"] }]);
  // the human answers in a plain comment (as on GitHub) — latest comment, no [agent] prefix
  const replied = localTaskStore(dir).addComment(created.id, "ytnobody", "Accept: do X, skip Y");
  const r = postClarifyProposals(dir, [{ task: replied, reasons: ["body too short"] }]);
  assert.equal(r.posted, 0, "already proposed — deduped");
  assert.deepEqual(r.pendingReply, [created.id], "the human reply is picked up on the next wake");
  // agent follow-up after the reply resets the gate (latest comment is agent-owned)
  localTaskStore(dir).addComment(created.id, "superintendent", "**[superintendent]** follow-up question");
  const again = postClarifyProposals(dir, [{ task: getTask(dir, created.id), reasons: ["body too short"] }]);
  assert.deepEqual(again.pendingReply, [], "agent follow-up is not a human reply");
});