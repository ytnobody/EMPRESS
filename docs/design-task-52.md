# Task #52 — Held-branch sign-off readiness + regressed-held auto-fix

## Behaviour spec

A task that is **held** (implemented + reviewed but left for human sign-off,
e.g. control-plane HIGH) is *sign-off-ready* only when its branch is **CI-green
AND conflict-free**. The held-task protocol (lesson #78) verifies-and-holds and
never re-touches the branch, so a regressed held branch (CI turned red, or a
merge conflict appears after the base advanced) loops in verify-and-hold
forever. This task embeds that judgment as a decision the loop can act on:

1. **Decision rule.** A held branch is `sign-off-hold` iff `ciGreen && conflictFree`.
   Otherwise (CI red, or a merge conflict) it is `needs-fix` — surfaced to the
   loop so an Engineer is re-engaged to rebase / re-implement it, and only a
   now-clean branch returns to `sign-off-hold`.
2. **Driver surface.** The run driver's wake block identifies held candidates
   (open tasks that already have a worktree + branch) and, each time it is about
   to pay a pass, re-assesses them on `{ciGreen, conflictFree}`. Any `needs-fix`
   held task is surfaced to the Superintendent so it spawns an Engineer rather
   than verify-and-holding a regressed branch.
3. **No auto-merge.** A `sign-off-hold` branch is never landed by the loop — the
   sign-off stays human (Non-Goal).

## Non-goals

- No change to the land path (a sign-off-hold branch is never force-landed).
- No change to readiness hearings on brand-new tasks (lesson #104: never run
  readiness on an already-implemented held task).
- No new dependencies.

## Interface shapes (verification arithmetic)

- `heldReady({ ciGreen: boolean; conflictFree: boolean }) → { ready: boolean; blockers: Array<"ci_red" | "conflict"> }`
  — `ready` iff both flip true; `blockers` lists every failing axis.
- `decideHeldAction(r: HeldReadiness) → "sign-off-hold" | "needs-fix"`
  — `"sign-off-hold"` iff ready, else `"needs-fix"`.
- `classifyHeldStatus(inputs: Array<{ id: number; ciGreen: boolean; conflictFree: boolean }>) → { needsFix: number[]; hold: number[] }`
  — groups held tasks by the decision, so the driver can hand `needsFix` to the
  Superintendent.
- `mergeTreeClean(cwd, base, branch) → boolean` (git) — deterministic
  conflict-free probe via `git merge-tree --write-tree` (exit 0 == clean).

Tests are a direct mapping of these three decision rules (derived from the
spec, independent of the implementation body).