# Task #70 — Auto-prune confirmed-PR-MERGED DONE-task managed worktrees

## Behaviour spec
`pruneStaleMergedBranches`'s DEFAULT sweep (no `scope`) always protects a branch
checked out in an EMPRESS-managed `.empress/worktrees/*` worktree — even when
that branch is confirmed dead weight. A DONE (closed) task whose PR is MERGED
on GitHub (squash / merge-commit → tip not a merge-base ancestor of base) leaves
its branch + managed worktree behind forever (task-30/31/34/36/37).

This task wires that confirmed-leftover prune into `empress_audit_scan`:

- Run the existing default sweep unchanged (still protects every managed
  worktree, prunes other fully-merged branches).
- THEN run a targeted `scope` sweep limited to the existing local branches of
  DONE tasks. `scope` opts in to pruning managed-worktree branches, and each
  scoped branch is still only deleted when its tip is a merge-base ancestor of
  base OR its GitHub PR reports state=MERGED (via the existing `isPrMerged` /
  `tryMergePRMerged` #68 signal). Unmerged / non-PR / active / superseded
  branches (incl. task-52/53/54) are never affected — default-deny.

## Interface shapes
- `auditScan.ts` — two calls to the existing helper, no new signatures:
  `pruneStaleMergedBranches(cwd, base)` then
  `pruneStaleMergedBranches(cwd, base, { scope: doneBranches })`, where
  `doneBranches` = `listTasks(cwd, { includeAll: true })` filtered to
  `status==="done"` whose `branch` still exists (`branchExists`) after the
  default sweep. Results unioned for the one report line.
- `test/git.test.mjs` — one new regression fixture: a PR-MERGED branch in a
  managed worktree with a non-ancestor tip is KEPT by a default (unscoped) sweep
  and pruned + worktree-removed by the scoped sweep. (#68 already covers the
  in-scope prune; this adds the explicit kept-not-scoped guarantee.)

## ponytail
Reuse `pruneStaleMergedBranches`, `tryMergePRMerged/isPrMerged`, `listTasks`,
`branchExists`. No new abstraction.