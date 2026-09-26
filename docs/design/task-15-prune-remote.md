# Task #15 — Prune stale merged remote branches

## Behavior spec

`empress_audit_scan` (and helper reuse) shall prune *fully-merged* remote-tracking
branches in the same spirit as the existing local `pruneStaleMergedBranches`,
because a merged PR leaves `origin/empress/task-N` behind as dead weight (local
auto-prune only covers `refs/heads/*`).

- Only a ref that is an **ancestor of `base`** (fully merged) is a deletion
  candidate. Unmerged branches are never touched.
- Protected names are never pruned whether merged or not: `base`, `main`,
  `develop`, the remote symbolic `HEAD`, and any `keep` names.
- Deleting means `git push <remote> :<short>` (removes the actual origin branch),
  then deleting the local remote-tracking ref `refs/remotes/<remote>/<short>`.
- A push that fails for any reason → the branch is **skipped**, never deleted
  (`fail-safe` toward keeping dead weight rather than risking a live branch).
- Held branches that are merely unmerged (e.g. empress/task-10/11) are skipped by
  the merge gate; deletion of any unmerged branch is out of scope.

## Interface shapes

```
decideRemotePrunes(refs: {short, merged}[], base: string, keep: string[]): { prune: string[]; skip: string[] }
pruneStaleMergedRemoteBranches(cwd: string, base: string, opts?: { keep?: string[]; remote?: string }): BranchPruneResult
```

- `decideRemotePrunes` is the **pure decision** (Command verification target):
  given each ref's short name + already-computed merge status, decide prune/skip.
- `pruneStaleMergedRemoteBranches` is the thin executor: enumerates
  `refs/remotes/<remote>/`, computes each ref's merge status via
  `merge-base --is-ancestor`, delegates to `decideRemotePrunes`, then push-deletes
  the decided refs.