# Task #37 — Disambiguate issue vs PR numbers + strengthen task dedupe

## Behavior spec

GitHub shares one numbering namespace across issues **and** PRs: number N names
exactly one entity, which may be a PR. `gh issue view N` (and the REST
`/issues/{N}` endpoint it uses) happily returns a PR — the harness then treats a
PR as a task issue, drives clarification on it, and `gh issue close N` closes
the PR. This is the #14 incident.

1. Every numbered GitHub entity surfaced by tool/report output must be labeled
   `issue #N` or `PR #N`. Local (file) tasks, which can never collide with PR
   numbers, are labeled `task #N`.
2. A number that resolves to a PR must be *visible* as `PR #N` (so operators
   know what it is) but **immutable through the task store**: close / edit /
   comment / delete on a PR are refused, because they act on the wrong entity.
3. Auto-filed tasks (audit findings via `empress task "<title>"`) must dedupe
   against near-identical titles of existing non-done tasks, so repeated audit
   passes do not file the same task twice.

## Interface spec (verification arithmetic target)

- `Task.kind?: "issue" | "pr" | "local"` (optional; `undefined` ⇒ local task).
- `issueToTask(issue)` sets `kind: issue.pull_request ? "pr" : "issue"`.
- `taskRef(t) -> "PR #N" | "issue #N" | "task #N"` — the only number-labeler.
- Title dedupe (pure): `normalizeTitle`, `editDistance` (Levenshtein),
  `titlesNearMatch(a,b)` — exact after normalize, else containment only when
  the shorter side is ≥ 8 chars and ≤ ½ the longer (base-title + appended
  detail, not 1-char stubs), else edit distance ≤ max(2, 0.15·longest) — and
  `findTitleDuplicate(tasks, title)` (skips done tasks).
- gh backend `fetchIssue` uses `gh api repos/{o}/{r}/issues/{id} --jq
  '{number,title,state,body,createdAt:.created_at,
    pull_request:(.pull_request != null),
    labels:((.labels//[])|map(.name))}'` so PR-ness is detectable (the gh
  `issue view --json` whitelist has no `pull_request` field — verified live).
- Mutation guards in `ghTaskStore`: `close`/`update`/`addComment`/`remove`
  return null/false without issuing any gh command when the fetched entity is a
  PR.
- `empress_readiness` replies `ready:false` immediately for `kind === "pr"`
  (never drives clarification on a PR).
- Output sites labeled via `taskRef`: `empress_list_tasks` rows (`Ref` field +
  existing numeric `Number`), `taskBrief` (empress_get_task), CLI `list` /
  `task list` / `task` create success, spawnEngineers summaries, run.ts driver
  logs + clarify language hint.
- `empress task "<title>"` skips creation with a "skipped — duplicate" message
  when `findTitleDuplicate` hits (this is the auto-file dedupe; the old prompt
  text "dedupe by simple title match" becomes a hard code guarantee).

## Non-goals

- No change to GitHub numbering semantics (single shared namespace stays).
- No change to the "Task #N: …" PR-title naming convention (landTask/pushPr) or
  to `gh issue list`/wake hashing (issue lists never contain PRs).