// Task store tests: local-store regression + pure gh mapping + backend selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { localTaskStore, ghTaskStore, issueToTask, desiredLabels, buildGhBody, buildMarkdown, stripMetadata, getTaskStore, hasHumanReply, agentMarker, proposeSpec, detectLanguage, resolveLang, issueLang, CLARIFY_FRAME, taskBrief, taskRef, findTitleDuplicate, titlesNearMatch, normalizeTitle } from "../src/domain/taskstore.js";

import { addComment, updateTask, getTask, closeTask, listTasks, removeTask } from "../src/domain/tasks.js";
import { DEFAULTS } from "../src/shared/config.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "empress-ts-"));
}

// A fake `run` that emulates a tiny GitHub, recording invocations. `issues`
// maps number -> the NORMALIZED issue JSON that fetchIssue's `gh api --jq`
// produces (fields: number,title,state,body,createdAt,labels,pull_request).
// An absent number is a 404 (fetchIssue -> null).
function makeFakeDeps(calls, issues = { 1: ghIssue(1, { title: "gh task" }) }) {
  const run = (_cmd, args) => {
    calls.push([_cmd, ...args]);
    if (_cmd === "gh" && args[0] === "--version") return { code: 0, stdout: "", stderr: "", signal: null };
    if (_cmd === "gh" && args[0] === "issue" && args[1] === "create") {
      return { code: 0, stdout: "https://github.com/ytnobody/EMPRESS/issues/1\n", stderr: "", signal: null };
    }
    // fetchIssue: gh api repos/ytnobody/EMPRESS/issues/N --jq {...}
    if (_cmd === "gh" && args[0] === "api" && args[2] === "--jq") {
      const m = /\/issues\/(\d+)$/.exec(args[1]);
      const n = m ? Number(m[1]) : NaN;
      if (issues[n] !== undefined) return { code: 0, stdout: JSON.stringify(issues[n]), stderr: "", signal: null };
      return { code: 1, stdout: "", stderr: "HTTP 404: Not Found", signal: null };
    }
    if (_cmd === "gh" && args[0] === "issue" && args[1] === "list") {
      const arr = Object.values(issues).filter((i) => !i.pull_request);
      return { code: 0, stdout: JSON.stringify(arr), stderr: "", signal: null };
    }
    return { code: 0, stdout: "[]", stderr: "", signal: null };
  };
  return { storeDeps: { run } };
}

function ghIssue(n, over = {}) {
  return { number: n, title: `task ${n}`, state: "open", createdAt: "x", body: "body", labels: [], ...over };
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

// Verifies: an issue whose GitHub JSON carries a pull_request marker is mapped
// to kind "pr" (the #14-mis-identification vector), a plain issue to "issue".
// `issue view N` returns PRs too — the kind must come from the API's
// pull_request field, never from the number alone.
test("taskstore: issueToTask labels a PR vs an issue by the pull_request field", () => {
  const pr = issueToTask({ number: 14, title: "Some PR", state: "open", createdAt: "x", body: "b", labels: [], pull_request: true }, "o/r");
  assert.equal(pr.kind, "pr");
  assert.equal(pr.id, 14); // same numbering slot, now disambiguated
  const issue = issueToTask({ number: 37, title: "An issue", state: "open", createdAt: "x", body: "b", labels: [] }, "o/r");
  assert.equal(issue.kind, "issue");
});

// Verifies: taskRef is the single number-labeler — "PR #N"/"issue #N" for
// gh-backed entities, "task #N" (never a bare #N) for local/unknown.
test("taskstore: taskRef labels every number as PR/issue/task — never bare", () => {
  assert.equal(taskRef({ id: 14, kind: "pr" }), "PR #14");
  assert.equal(taskRef({ id: 37, kind: "issue" }), "issue #37");
  assert.equal(taskRef({ id: 5, kind: "local" }), "task #5");
  assert.equal(taskRef({ id: 5 }), "task #5"); // no kind -> local-style, still labeled
});

// Verifies: taskBrief (the empress_get_task payload) starts with the labeled
// reference, so a PR number can never be reported as a bare task number.
test("taskstore: taskBrief leads with the labeled reference", () => {
  const b = taskBrief(issueToTask({ number: 14, title: "X", state: "open", createdAt: "x", body: "body text", labels: [], pull_request: true }, "o/r"));
  assert.ok(b.startsWith("PR #14: X"));
  const bi = taskBrief(issueToTask({ number: 37, title: "Y", state: "open", createdAt: "x", body: "body text", labels: [] }, "o/r"));
  assert.ok(bi.startsWith("issue #37: Y"));
});

// ---------------------------------------------------------------------------
// Title near-match dedupe (pure)
// ---------------------------------------------------------------------------
// Verifies: normalization is case/punctuation/whitespace-insensitive so the
// same audit finding spelled differently still collides.
test("dedupe: normalizeTitle collapses case, punctuation, whitespace", () => {
  assert.equal(normalizeTitle("  Legacy .js FILE !! still-present "), "legacy js file still present");
  assert.equal(normalizeTitle("Speed up startup"), "speed up startup");
});

// Verifies: exact and containment matches are near-matches — audit findings
// often append a location/detail to a shared base title.
test("dedupe: exact + containment titles are near-matches", () => {
  assert.equal(titlesNearMatch("Legacy .js file still present", "legacy js file still present"), true); // exact after normalize
  assert.equal(titlesNearMatch("Legacy .js file", "Legacy .js file still present"), true); // base title + appended detail
  assert.equal(titlesNearMatch("Tracked secret-ish file", "Tracked secret-ish file: .env.prod"), true); // base title + appended location
  assert.equal(titlesNearMatch("a", "abcdefghij"), false); // 1-char stub must not collide with everything
});

// Verifies: small edit-distance titles (typo / singular-plural) collide, while
// genuinely different titles never do — the near-match bound is the
// verification arithmetic (distance <= max(2, 0.15 * longest)).
test("dedupe: near-identical edit-distance titles collide; far titles do not", () => {
  assert.equal(titlesNearMatch("fix typo", "fix typos"), true); // 1 edit on 9-char longest <= max(2, 1)
  assert.equal(titlesNearMatch("prune stale branch", "prune stale branches"), true); // 1 edit on 19 chars <= max(2, 2)
  assert.equal(titlesNearMatch("a", "abcdefghij"), false); // 9 edits > max(2, 1)
  assert.equal(titlesNearMatch("enable cve scanning", "prune stale branches"), false); // unrelated
  assert.equal(titlesNearMatch("add tests", "add more tests for the parser"), false); // containment excluded (longer > 2x shorter)
});

// Verifies: findTitleDuplicate returns an existing non-done task whose title
// near-matches, and ignores done tasks (a re-file after landing is allowed).
test("dedupe: findTitleDuplicate hits open/assigned tasks, skips done", () => {
  const tasks = [
    { id: 1, title: "Prune stale merged remote branches", status: "done" },
    { id: 2, title: "Prune stale merged local branches", status: "open" },
    { id: 3, title: "Fix typo", status: "assigned" },
  ];
  assert.equal(findTitleDuplicate(tasks, "Prune stale merged local branch").id, 2); // trailing-s plural is 1 edit
  assert.equal(findTitleDuplicate(tasks, "Prune stale merged remote branches"), null); // word swap = 6 edits > max(2, 4)
  assert.equal(findTitleDuplicate(tasks, "Fix tyop").id, 3); // near-match on spelling
  assert.equal(findTitleDuplicate(tasks, "Add a brand new feature"), null);
});

// ---------------------------------------------------------------------------
// gh backend mutation guards: a PR number must never be closed/edited/commented/deleted
// ---------------------------------------------------------------------------
// Verifies: the gh store surfaces a PR as kind "pr" but refuses every mutating
// operation on it — no `issue close/edit`, no comment POST, no delete — so the
// #14 wrong-close cannot recur (the guard is the Command: fewer gh commands).
test("taskstore: gh store refuses close/update/comment/remove on a PR number", () => {
  const calls = [];
  const deps = makeFakeDeps(calls, { 29: ghIssue(29, { title: "PR-29", pull_request: true, state: "closed" }) }).storeDeps;
  const store = ghTaskStore(process.cwd(), { enabled: true, owner: "ytnobody", repo: "EMPRESS" }, deps);

  const t = store.get(29);
  assert.ok(t);
  assert.equal(t.kind, "pr");
  assert.equal(store.close(29, "landed"), null);
  assert.equal(store.update(29, { status: "done", labels: ["needs-clarification"] }), null);
  assert.equal(store.addComment(29, "empress", "clarify"), null);
  assert.equal(store.remove(29), false);

  const issued = calls.filter((c) => c[0] === "gh");
  assert.ok(!issued.some((c) => c[1] === "issue" && c[2] === "close"), "must not close the PR");
  assert.ok(!issued.some((c) => c[1] === "issue" && c[2] === "edit"), "must not edit the PR");
  assert.ok(!issued.some((c) => c[1] === "issue" && c[2] === "delete"), "must not delete the PR");
  assert.ok(!issued.some((c) => c[1] === "api" && String(c[2]).endsWith("/comments") && c.includes("POST")), "must not POST a comment on the PR");
  assert.ok(issued.some((c) => c[1] === "api" && String(c[2]).endsWith("/comments") && !c.includes("POST")), "reads (comments GET for get/29) are fine");
});

// Verifies: the same ops still work on a genuine issue (guards are PR-specific,
// not a blanket freeze) — close issues an `issue close`, update issues an edit.
test("taskstore: gh store still closes/edits genuine issues", () => {
  const calls = [];
  const deps = makeFakeDeps(calls, { 7: ghIssue(7) }).storeDeps;
  const store = ghTaskStore(process.cwd(), { enabled: true, owner: "ytnobody", repo: "EMPRESS" }, deps);

  const t = store.get(7);
  assert.equal(t.kind, "issue");
  assert.ok(store.close(7) !== null);
  assert.ok(calls.some((c) => c[0] === "gh" && c[1] === "issue" && c[2] === "close" && c[3] === "7"));
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

// Verifies: an agent comment is one carrying the machine marker; a human who
// mimics the readable **[agent]** prefix (no marker) is still a human reply,
// and an agent comment missing the prefix is still an agent comment.
test("taskstore: hasHumanReply = marker presence only (prefix is not a signal)", () => {
  assert.equal(hasHumanReply({ comments: [{ at: "", author: "x", body: "**[empress]** I agree, please proceed" }] }), true, "human mimicking the agent prefix is still a human reply");
  assert.equal(hasHumanReply({ comments: [{ at: "", author: "x", body: "draft spec\n<!--empress:agent=abc-->" }] }), false, "agent comment with marker (no prefix) is agent");
  assert.equal(hasHumanReply({ comments: [{ at: "", author: "x", body: "**[superintendent]** follow-up" }, { at: "", author: "x", body: "I think it should do X" }] }), true, "plain-text latest reply is human");
  assert.equal(hasHumanReply({ comments: [{ at: "", author: "x", body: "proposal\n<!--empress:agent=abc-->" }, { at: "", author: "x", body: "answer\n<!--empress:agent=def-->" }] }), false, "latest agent comment wins");
  assert.equal(hasHumanReply({ comments: [] }), false, "no comments => no human reply");
});

test("taskstore: agentMarker emits a unique machine-checkable marker", () => {
  // Verifies: each posted agent comment carries an HTML-comment marker with a
  // UUID v4 nonce — a shape humans would not reproduce by accident, unique per post.
  const m = agentMarker();
  assert.match(m, /^<!--empress:agent=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-->$/);
  assert.notEqual(agentMarker(), m);
});

test("taskstore: gh addComment POSTs the readable prefix AND the agent marker", () => {
  // Verifies (Command verification): the gh api comment POST keeps the
  // human-readable **[author]** prefix and appends the machine marker line, so
  // humans can read who posted and hasHumanReply can decide by marker alone.
  const dir = tmpdir();
  const calls = [];
  const store = ghTaskStore(dir, { enabled: true, owner: "ytnobody", repo: "EMPRESS" }, makeFakeDeps(calls).storeDeps);
  store.addComment(1, "empress", "please answer");
  const post = calls.find((c) => c[0] === "gh" && c[1] === "api" && c[2] === "repos/ytnobody/EMPRESS/issues/1/comments" && c[3] === "--method");
  assert.ok(post, "gh api comment POST was issued");
  const body = post[6]; // the `-f body=...` argument
  assert.ok(body.startsWith("body=**[empress]** please answer"), "readable [agent] prefix kept");
  assert.match(body, /\n<!--empress:agent=[0-9a-f-]{36}-->$/, "machine marker appended");
});

test("taskstore: local addComment stores the agent marker with the comment", () => {
  // Verifies: local-store agent comments carry the same marker so the shared
  // hasHumanReply sees one unambiguous signal in both backends, and the
  // truthful author field is preserved.
  const dir = tmpdir();
  fs.mkdirSync(path.join(dir, ".empress", "tasks"), { recursive: true });
  localTaskStore(dir).create({ title: "T" });
  const t = localTaskStore(dir).addComment(1, "empress", "proposal");
  assert.equal(t.comments.length, 1);
  assert.equal(t.comments[0].author, "empress");
  assert.ok(t.comments[0].body.startsWith("proposal"), "original body preserved");
  assert.match(t.comments[0].body, /\n<!--empress:agent=/, "machine marker appended");
  assert.equal(hasHumanReply(t), false, "the stored agent comment is not a human reply");
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

// ---------------------------------------------------------------------------
// Language-aware output across the harness (task #34)
// ---------------------------------------------------------------------------
test("taskstore: resolveLang picks a detected CJK language over the project default", () => {
  // Verifies: a clear ja/zh/ko detection from the issue always wins, whatever
  // the [project] language — the harness replies in the issue's language.
  assert.equal(resolveLang("ja", "en"), "ja");
  assert.equal(resolveLang("zh", "en"), "zh");
  assert.equal(resolveLang("ko", "ja"), "ko");
});

test("taskstore: resolveLang makes [project] language the default for ambiguous en/unknown", () => {
  // Verifies: the detector's 'en' slot (English issue OR unknown script) is the
  // ambiguous case; [project] language fills it as the default (default en).
  // [ASSUMPTION] a genuinely-English issue under a non-en [project] language
  // gets the project language — detectLanguage cannot separate English from
  // unrecognized-script issues (both return 'en').
  assert.equal(resolveLang("en", "en"), "en");
  assert.equal(resolveLang("en", "ja"), "ja");
  assert.equal(resolveLang("en", ""), "en");
});

test("taskstore: issueLang resolves end-to-end for a task (detect + project default)", () => {
  // Verifies: the composition callers use for issue-bound output — a Japanese
  // issue resolves to ja in an en-default project; a title-less or English task
  // falls back to the [project] language.
  assert.equal(issueLang("導入手順のドキュメント", "", "en"), "ja");
  assert.equal(issueLang("Bump deps", "# Bump deps", "en"), "en");
  assert.equal(issueLang("", "", "ja"), "ja");
  assert.equal(issueLang("", "", ""), "en");
});

test("taskstore: proposeSpec localizes for Chinese and Korean issues (no English fallback)", () => {
  // Verifies: zh/ko issues get a clarification proposal drafted in their own
  // language (anchored by the issue title), not the English template.
  const zh = proposeSpec({ title: "启动时加速" }, "zh");
  assert.ok(zh.purpose.includes("启动时加速"));
  assert.ok(zh.questions[0].includes("为什么"));
  assert.ok(!/What should/.test(zh.questions[0]));
  const ko = proposeSpec({ title: "시작 속도 개선" }, "ko");
  assert.ok(ko.purpose.includes("시작 속도 개선"));
  assert.ok(ko.questions[0].includes("무엇을"));
  assert.ok(!/What should/.test(ko.questions[0]));
});

test("taskstore: CLARIFY_FRAME covers every supported language", () => {
  // Verifies: the readiness hearing frame exists for en/ja/zh/ko — a Chinese or
  // Korean task never gets an English framing string around its proposal.
  for (const lang of ["en", "ja", "zh", "ko"]) {
    assert.ok(CLARIFY_FRAME[lang], `CLARIFY_FRAME[${lang}]`);
    assert.ok(CLARIFY_FRAME[lang].header.includes("[empress]"));
    assert.ok(CLARIFY_FRAME[lang].questions.length > 0);
  }
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
test("taskstore: ghTaskStore.close posts a marker-carrying note comment", () => {
  // Verifies: the close note goes through the same marked comment convention.
  const dir = tmpdir();
  const calls = [];
  const store = ghTaskStore(dir, { enabled: true, owner: "ytnobody", repo: "EMPRESS" }, makeFakeDeps(calls).storeDeps);
  store.close(1, "landed");
  const post = calls.find((c) => c[0] === "gh" && c[2] === "repos/ytnobody/EMPRESS/issues/1/comments" && c[3] === "--method");
  assert.ok(post, "close note comment was posted");
  assert.ok(post[6].startsWith("body=**[empress]** landed"));
  assert.match(post[6], /\n<!--empress:agent=[0-9a-f-]{36}-->$/, "close note carries the marker");
});

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

// Verifies: list (gh issue list) surfaces issues with kind "issue" — PRs never
// appear in an issue list, but every row is still labeled for the reader.
test("taskstore: gh list rows are kind issue (PRs never listed as tasks)", () => {
  const calls = [];
  const deps = makeFakeDeps(calls, { 7: ghIssue(7), 29: ghIssue(29, { title: "PR-29", pull_request: true, state: "closed" }) }).storeDeps;
  const store = ghTaskStore(process.cwd(), { enabled: true, owner: "ytnobody", repo: "EMPRESS" }, deps);
  const rows = store.list({ includeAll: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 7);
  assert.equal(rows[0].kind, "issue");
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