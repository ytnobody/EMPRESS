# Task #102 — Persist needs_clarification in gh mode

## Bug

A not-ready gh-backed task is re-selected every pass. Two compounding causes:

1. **Dedupe guard blocks the marker write.** `empress_readiness` (tool) and
   `postClarifyProposals` (run driver) write `needs_clarification: true` only
   inside the `!alreadyProposed` branch. A task that already carries the
   `empress:clarify-proposal` comment — but whose marker was never actually
   persisted — never gets the marker retried. #101 is exactly this: the proposal
   comment exists, the issue has zero labels.
2. **The gh internal labels do not exist in the repo.** `gh issue edit
   --add-label needs-clarification` (and `status:blocked`) fails the whole edit
   when the label is absent, and the failure is swallowed. So even a first-pass
   marker write is lost. The local backend has no such failure mode.

## Behaviour spec

- When a task is judged not-ready, the held marker **must be written on every
  verdict**, independent of whether a proposal comment already exists:
  `updateTask(id, { needs_clarification: true, status: "blocked" })`.
- In gh mode the internal labels to add must exist **before** the issue edit:
  `gh label create <name> --color <c> --force` for each EMPRESS-owned label
  (`status:*`, `needs-clarification`, `assignee:*`). `--force` is idempotent;
  colors are EMPRESS-owned so no user label is clobbered.
- The existing label model is reused: `empress_list_tasks` default hides
  `needs_clarification` tasks; `include_all` surfaces them. Clearing via
  `empress_apply_clarification` (needs_clarification=false) removes the label and
  returns the task to actionable — unchanged path.

## Interface shapes (verification arithmetic)

- `issueToTask(issue).needs_clarification === labels.includes("needs-clarification")`.
- gh `update(id, { needs_clarification: true, status: "blocked" })` issues, in
  order: `gh label create needs-clarification --force` (and `status:blocked`)
  then `gh issue edit ... --add-label needs-clarification --add-label
  status:blocked`.
- `ghTaskStore.list()` omits a task whose refreshed issue carries
  `needs-clarification`; `list({ includeAll: true })` includes it.
- `postClarifyProposals` on an already-proposed but unmarked task marks it
  (needs_clarification=true, status=blocked) while posting no duplicate comment.

## Non-goals

- No new framework / no body-metadata marker; reuse the label model.
- No change to `empress_apply_clarification` or the clarify Q&A flow.
