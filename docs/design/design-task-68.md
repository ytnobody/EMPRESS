# Task #68 — Prune squash/PR-merged branches too

## Behaviour spec
`pruneStaleMergedBranches` today prunes a local branch only when its tip is a
`merge-base --is-ancestor` of `base`. GitHub SQUASH / merge-commit PRs collapse
the branch's commits onto `base`, so the branch tip is NOT an ancestor even
though its content is on `base` — those dead branches (+ their orphaned managed
worktrees) are never auto-pruned.

After this task a local branch is prunable when **either** signal holds:

1. `isAncestor` — the tip is a merge-base ancestor of `base` (fast-forward /
   merge-commit into base), OR
2. `prMerged` — `gh pr view --head <branch>` authoritatively reports
   `state=MERGED` (squash / merge-commit PR that landed on base).

Protected-branch rules are unchanged: current branch, `base`, `main`, `develop`,
`keep` names, and (default sweep) any branch checked out in an EMPRESS-managed
`.empress/worktrees/*` worktree are never auto-pruned. An unmerged branch that is
NOT PR-merged is always kept (default-deny). PR-merged is fail-safe: any gh
failure / gh absent / non-MERGED state returns `false` (not prunable).

Deletion detail: an ancestor-merged branch uses the existing safe `git branch -d`
(which refuses iff not-fully-merged). A non-ancestor but PR-confirmed-MERGED
branch needs `git branch -D` (force) because `-d` refuses non-ancestor tips — safe
only because gh has confirmed the PR's content landed on base.

## Interface shapes
- `decideLocalPrune(isAncestor: boolean, prMerged: boolean): boolean` — pure,
  `isAncestor || prMerged`. Lives in `src/domain/git.ts`. Command-verification
  target.
- `tryMergePRMerged(cwd: string, branch: string): boolean` — executor, best-effort
  `gh pr view --head <branch> --json state`; returns false on any failure. Fail-safe.
- `pruneStaleMergedBranches(cwd, base, opts)` — opts gains optional injected probe
  `isPrMerged(branch, cwd): boolean`, defaulting to `tryMergePRMerged`. The probe
  is the Core/Shell seam so tests can supply a deterministic PR signal without
  real gh (tmp fixtures have no GitHub).
- `src/extension/tools/auditScan.ts` — unchanged linkage (default sweep keeps
  managed-worktree protection invariant). Confirmed leftovers are pruned via
  explicit `scope`, which now benefits from the PR-merged signal.

## Accepted ambiguity (handoff `[ASSUMPTION]`)
- `gh pr view --head` matches one PR head by branch name; if a branch was
  re-pushed to more than one PR this returns the current head's state only.
  Fine for the stated scope (fresh task branches).
- The audit default sweep still protects managed-worktree branches (unscoped),
  so the 5 confirmed leftovers need an explicit scoped call to actually prune —
  the extended helper makes that possible; auto-pruning them requires inserting
  into auditScan a scope list, which is out of the "if trivial" happy-path scope.