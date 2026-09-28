# Design doc — prune fully-merged leftover branches + worktrees (task #64)

## Behavior spec (Level 1)

Housekeeping helper in `src/domain/git.ts` (`pruneStaleMergedBranches`) that
auto-prunes dead merged branches and their orphaned worktrees.

For every local branch `b` considered a **candidate**, when
`git merge-base --is-ancestor b base` is true (fully merged into `base`):

1. remove every worktree where `b` is checked out (`git worktree remove --force`),
2. delete the branch (`git branch -d`, safe delete).

Unmerged branches are never touched regardless of name. No origin/remote is touched.

**Candidate selection — default-sweep safety (hold-fix pass).** In a *default*
sweep (no explicit `scope`), the candidate set is all local branches except the
protected ones (current branch, base, `main`, `develop`, plus `keep`), MINUS any
branch checked out in an EMPRESS-managed worktree (a path under
`<cwd>/.empress/worktrees/`). A manager-worktree branch may be an ACTIVE
in-progress engineer task whose branch still points at `base` (zero commits →
`merge-base --is-ancestor` is true), so it must never be auto-pruned. Only
branches with no worktree, or with a stray/foreign (non-managed) worktree, are
auto-pruned by a default sweep.

A caller that has **confirmed** a branch is a leftover lists it in `opts.scope`
to opt into pruning it even though it lives in a managed worktree (the #64
targeted-execution path). `keep` still protects any named branch.

## Interface

Extension of the existing helper in `src/domain/git.ts`:

- `worktreesForBranch(cwd, branch): string[]` — parse of
  `git worktree list --porcelain` mapping branch ref -> worktree path.
- `isManagedWorktree(cwd, wtPath): boolean` — resolved-path compare against
  `<cwd>/.empress/worktrees/`.
- `pruneStaleMergedBranches(cwd, base, { keep?, scope? })` — same default call as
  today; behavior extended so (a) a merged branch in a stray/foreign worktree is
  *also* pruned (previously `skipped` because `git branch -d` refused), and (b) a
  merged branch in a MANAGED worktree is protected unless listed in `scope`.

## Verification arithmetic

- Default sweep:
  - stray/foreign-worktree merged branch -> branch gone + its worktree dir gone.
  - merged branch checked out in a managed `.empress/worktrees/*` worktree ->
    branch KEPT, worktree KEPT (not pruned, not removed).
  - unmerged -> branch still exists, worktree still exists.
  - protected (base/main/develop/current) -> untouched.
- Explicit `scope` run: a merged branch in a managed worktree IS pruned and its
  worktree dir removed.
- The tests derive these expectations from the spec, independently of the
  implementation, using a throwaway git repo fixture.

## Execution for #64 (SAFE, targeted)

The housekeeping execution already ran during the implementation pass (targeted):
`empress/task-32` and `tmp34` were verified as ancestors of `develop`, their
orphaned worktrees (`.empress/worktrees/32`, `/tmp/reb34`) were removed, and the
branches deleted — unmerged tasks and `origin` untouched. This hold-fix pass is
**code-only**: it ships the default-sweep protection so a future `auditScan`
auto-prune at the repo root can never kill an in-progress engineer worktree. Do
NOT re-run the prune against the live repo.