# Task #82 — persisted `held` (awaiting-human) task status

## Problem
A task whose only landing blocker is the human-gated HIGH control-plane tripwire
(issue #81) is surfaced by `empress_list_tasks` on every pass, so the loop
re-spawns / re-verifies it forever (lesson #314). The hold lives only in the
Superintendent's head (a comment), never in the task state.

## Spec (behavior)

1. **State.** Add `"held"` to the task status model plus a persisted
   `hold_reason` string. A held task is *awaiting a human*.
2. **Selection.** `listTasks` default excludes held tasks; `includeAll` includes
   them and exposes `hold_reason`. The run driver's actionable loop also skips
   held tasks.
3. **Clearing.** A hold is cleared (task actionable again) by any of:
   - explicit unhold (`clearHoldPatch` → `assigned`/`open`, `hold_reason=""`),
   - a **human** comment after the hold (`hasHumanReply`),
   - the branch already merged into base (driver closes it as `done`).
4. **Landing/force semantics unchanged.** `empress_land_task` refuses HIGH unless
   `force=true` exactly as before; as a *side effect of the refusal* it persists
   the hold so the task is not re-selected. `force=true` never holds/auto-lands
   control-plane changes (still human-gated by policy).

## Interfaces (pure)

```ts
TASK_STATUSES += "held"
interface Task { ...; hold_reason?: string }

// effective hold (merged is supplied by the impure git probe, keeping this pure)
isHeld(t: {status, comments}, merged = false): boolean

// refusal decision -> persisted patch (null = no hold)
highHoldPatch(level, force, reasons): { status:"held"; hold_reason } | null

// clearing decision -> persisted patch
clearHoldPatch(t: {assignee}, merged = false): { status; hold_reason:"" }
```

`hold_reason` crosses the gh body-metadata boundary, so it is sanitized
(`-->` / newlines stripped) before embedding — the reason may contain a git file
path, which is branch-controlled.

Storage: local frontmatter key `hold_reason`; gh HTML metadata
`<!--empress:hold_reason=...-->` + internal label `status:held`.

## Tests
`test/held.test.mjs`: pure decisions (isHeld / highHoldPatch / clearHoldPatch),
local list filtering + human-reply clear + reason, gh label/metadata round-trip
and injection sanitization. Extension smoke test updated for the 2 new tools.
