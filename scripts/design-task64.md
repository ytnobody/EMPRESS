# Design doc — prune fully-merged leftover branches + worktrees (task #64)

## Behavior spec (Level 1)

For every local branch `b` (except protected: current branch, base, `main`,
`develop`, plus any `keep` names), when `git merge-base --is-ancestor b base`
is true (fully merged into `base`):

1. remove every worktree where `b` is checked out (`git worktree remove --force`),
2. delete the branch (`git branch -d`, safe delete).

Unmerged branches are never touched regardless of name. No origin/remote is touched.

## Interface

Extension of the existing helper in `src/domain/git.ts`:

- `worktreesForBranch(cwd, branch): string[]` — parse of
  `git worktree list --porcelain` mapping branch ref -> worktree path.
- `pruneStaleMergedBranches(cwd, base, opts)` — same signature as today; behavior
  extended so a merged branch that is checked out in a worktree is *also* pruned
  (previously such a branch was `skipped` because `git branch -d` refuses).

## Verification arithmetic

- Candidate = local branch, not protected, `merge-base --is-ancestor b base == 0`.
  - merged -> branch gone + its worktree dir gone after pruning.
  - unmerged -> branch still exists, worktree still exists.
  - protected (base/main/develop) -> untouched.
- The test derives these expectations from the spec, independently of the
  implementation, using a throwaway git repo fixture.

## Execution for #64 (SAFE, targeted)

The `pruneStaleMergedBranches` sweep protects only the branch checked out at the
given `cwd` (the main repo root checks out `develop`), so an *active* engineer
worktree under `.empress/worktrees/` whose task branch still points at `develop`
(no commits yet) would NOT be protected and could be wrongly pruned. Therefore the
housekeeping execution for #64 must target the confirmed leftovers EXPLICITLY:
`empress/task-32` and `tmp34` — verify each is merged, remove their orphaned
worktrees (`.empress/worktrees/32`, `/tmp/reb34`) and delete the branches — and
never run a blind sweep that could catch an in-progress task branch.