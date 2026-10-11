# Task #94 — Land reconciles `origin/<base>` (local base must not drift ahead)

## Behaviour spec
With `[github] enabled = true`, `empress_land_task` opens a PR for the task
branch and THEN fast-forwards the branch into the **local** base branch and
closes the task. `origin/<base>` only advances if a human merges the PR, but the
loop's auto-landed LOW/MEDIUM PRs end up CLOSED unmerged — so local `develop`
perpetually drifts ahead of `origin/develop` (3rd relapse: #77, #80, #93).

**Policy (chosen): reconcile origin on land.** After a successful local merge
with `[github]` enabled, `landBranch` pushes the base branch to `origin`
(`git push origin <base>:<base>`). Push is **never forced**: a rejected
non-fast-forward push (remote advanced / no permission) is reported, not
overridden. Because the PR's head commits then exist on base, GitHub reports the
open PR as merged. Thus:

- `origin/<base>` receives the landed commit → local and remote base do not
  diverge.
- If the push fails, `empress_land_task` does **not** close the task / remove the
  worktree: the next land retries the push (the local ff-merge is idempotent).
- A local-only repo (no `origin/<base>` ref) is unaffected — no push is emitted.

**Deterministic indicator.** `baseDivergence(cwd, base)` reports
`{ originBaseExists, ahead, diverged }` where
`diverged = originBaseExists && ahead > 0` (commits local base has that
`origin/<base>` lacks). `empress doctor` surfaces it as a hard check
(`base not ahead of origin/<base>`), so a regression fails loudly instead of
needing a manual one-shot sync task.

HIGH/control-plane sign-off and `force` semantics are unchanged. `force` still
only bypasses the risk gate; it is never a force-push.

## Interface shapes
- `originPushCommand(base, originBaseExists): { cmd, args } | null` — pure.
  Emits `git push origin <base>:<base>` iff the origin base ref exists.
  Command-verification target.
- `landBranch(cwd, base, branch, { force?, reconcileOrigin? })` — new
  `reconcileOrigin` flag; on `merged` runs the origin push and returns
  `{ merged, fastForwarded, pushed?, pushError?, note }`. No force-push.
- `decideBaseDivergence(ahead, originBaseExists): boolean` — pure,
  `originBaseExists && ahead > 0`. Command-verification target.
- `baseDivergence(cwd, base): BaseDivergence` — read-only executor
  (`rev-list --count origin/<base>..<base>`).
- `baseDivergenceCheck(cwd, base): Check` (`src/cli/doctor.ts`) — maps the
  executor to the doctor check tuple; `empress doctor` pushes it.
- `src/extension/tools/landTask.ts` — passes `reconcileOrigin: ghCfg.enabled`
  and skips close/worktree-removal when `merged && pushed === false`.

## Accepted ambiguity (handoff `[ASSUMPTION]`)
- The PR is treated as informational once the base is pushed: pushing base
  auto-closes the PR as merged. If a workflow requires a human PR merge instead,
  switch to policy (b) (refuse local land while github is enabled) — out of scope.
- Pushing base requires write access to `origin/<base>`. A rejected push is
  reported + surfaced by doctor, not retried automatically beyond the next land.

## ponytail
Reuse `landBranch`, `originUpdateCommand`, the `git`/`run` shell, and
`branchExists`; add one push-command builder + one divergence decision. No sync
framework, no new remote config.
