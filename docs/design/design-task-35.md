# Task #35 — Title-only issues: proposal-first immediate response

## Behaviour spec

A human's main entry point is a title-only issue. Today that issue must go
through a clarify LLM round-trip before any draft spec exists, and — once
`empress_readiness` marks it `needs_clarification` — the run driver's default
actionable set hides it forever, so a human reply can never be picked up. Both
gaps are closed here:

1. **Proposal on first detection.** The run driver's wake preflight posts the
   clarification proposal comment **immediately** for every not-ready task, in
   the same tick — before any LLM pass. The comment is the draft spec + open
   questions from `proposeSpec` (taskstore/shared.ts) in the issue's detected
   language, plus the readiness reasons. Posting is **deduped** by the
   `empress:clarify-proposal` marker already present in the task's comments, and
   a posted task is marked `needs_clarification` + `status: blocked` (same as the
   `empress_readiness` tool), so it leaves the default actionable queue.
2. **Single reply resolution.** The driver's preflight set includes
   `needs_clarification` tasks **only when they have a pending human reply**
   (`hasHumanReply`), so one human reply to the proposal is picked up on the next
   wake and drives the clarify LLM pass → `empress_apply_clarification` (existing
   path, unchanged) → actionable next pass. A fresh title-only issue with no
   reply costs **zero LLM** on first detection.
3. **No duplicate proposals.** Only one source of truth for the proposal template
   + dedupe. The `empress_readiness` tool reuses the same pure planner, so a
   driver-posted proposal is never re-posted by the tool (and vice versa).

## Non-goals

- No change to `empress_apply_clarification`, `proposeSpec`, or the l10n strings.
- Legacy `--once` mode and the `/empress` prompt flow keep using the LLM-driven
  `empress_readiness` tool — same planner, deduped.
- No change to the ready-task implementation flow.

## Interface shapes (verification arithmetic)

- `CLARIFY_PROPOSAL_MARKER = "empress:clarify-proposal"`
- `planClarifyProposals(checks: { task: Task; reasons: string[] }[]) →
  { taskId: number; comment: string }[]`
  - Pure; one Command per task whose comments do **not** contain the marker.
  - `comment` = header + marker + `Proposed:` (Purpose/Scope/Acceptance/Non-Goals
    from `proposeSpec`) + `Open questions:` + `(reason: …)`, in the detected
    language — template pinned by this doc (verbatim match with the pre-split
    `empress_readiness` output, so old proposals dedupe identically).
- `postClarifyProposals(cwd, checks) → { posted: number; pendingReply: number[] }`
  - Thin shell: re-read each task fresh (`getTask` — the gh list backend carries
    no comments, so dedupe/reply detection need the authoritative record), execute
    the planned Commands verbatim (`addComment` + `updateTask
    { needs_clarification: true, status: "blocked" }`), and report ids of fresh
    tasks whose latest comment is a human reply (`hasHumanReply`).
- Run driver (`src/cli/run.ts`): actionable set = not-done tasks + fresh
  `needs_clarification` tasks with a pending reply; after the Jev batch, post
  proposals for every not-ready task; spawn the clarify LLM pass **only** when
  `pendingReply` is non-empty (ids = the reply-bearing tasks).