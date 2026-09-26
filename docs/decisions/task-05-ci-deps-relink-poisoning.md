# Task 05 — Fix CI deps-mount self-poisoning (decision + spec)

Status: implemented (task-5 branch)
Scope: `src/domain/ci.ts` only. No changes to `git.ts` (createWorktree symlink
creation stays as-is; the poisoning happens per-run and belongs to runCi to heal).

## Problem (Level 0 → behavior)

`createWorktree` symlinks `worktree/node_modules -> <mainRepo>/node_modules`
(host-absolute). The container CI gate mounts the real dir at `/deps:ro` and
relinks inside the container (`rm -f /project/node_modules && ln -s /deps
/project/node_modules`) because the OCI runtime refuses to bind over a symlink
whose target escapes the mount (podman 3.4.2 openat2). `/project` is a **rw**
bind of the worktree, so the relink writes back through the mount and the HOST
worktree symlink is left pointing at `/deps` (realpath ENOENT on host).

Next run: `nodeModulesExtraMount` realpath fails → returns `[]` → no `/deps`
mount, no relink prefix → container's `/project/node_modules` is a broken
`/deps` link → `tsc not found`. Intermittent CI failure on every task.

## Fix behavior spec

- **Invariant (after every container gate run):** the host worktree
  `node_modules` symlink resolves to the main repo's real `node_modules` dir
  (never `/deps`). This holds even when the container run failed or was
  interrupted mid-relink.
- **Before** a container gate run, if the host symlink is poisoned
  (readlink target is exactly `/deps` — the only value the relink prefix ever
  writes), rewrite it to the main repo's `node_modules` (derived from the
  worktree layout `<main>/.empress/worktrees/N` → `<main>` = `cwd/../../..`),
  so this run's mount discovery resolves.
- **After** the container gate run, repeat the same rewrite (the run just
  re-poisoned it).
- Rewrites are idempotent + best-effort: no symlink / valid symlink / plain dir
  → no-op; main node_modules missing → leave alone (mount discovery returns `[]`
  as today).

## Interface map (verification arithmetic)

```ts
// Pure(ish) decision — reads only the current symlink state + derived main dir.
// Returns the target the worktree node_modules symlink SHOULD have when it is
// poisoned ("/deps"), else null (no rewrite needed). fs probe only, no writes.
depsRelinkRepair(cwd: string): string | null

// Thin execution layer — applies a decided rewrite (rm link + recreate symlink),
// best-effort try/catch. Not exported; only runCi calls it.
applyDepsRelinkRepair(cwd: string, target: string): void
```

`nodeModulesExtraMount` / `depsRelinkPrefix` / `buildContainerArgs` unchanged.

## Tests (what they verify — derived independently of the implementation)

1. Poisoned link (`node_modules -> "/deps"`) under a fixture worktree layout →
   decision returns `path.join(base, "main", "node_modules")` — expected value
   derived from the documented layout, independent of any implementation
   internals.
2. Valid symlink (target = main node_modules) → `null` (no rewrite).
3. No symlink / plain dir node_modules → `null`.
4. Poisoned link but derived main node_modules absent → `null` (don't fabricate).
5. Integration (injected runner): a second `runCi` call after a simulated
   poison (the injected `_run` re-poisons the host link mid-run, as the rw
   mount does) still emits the relink-prefixed container command — i.e. the
   mount resolved again on the second consecutive run (acceptance criterion).
6. Integration: after `runCi` returns, the host symlink realpaths to the main
   repo's real dir (post-run restore; acceptance criterion "host selfcheck
   stays green").

No real container is executed in unit tests (`_run` injected). Real podman
verification (two consecutive runs) is the manual AC check.

## Assumptions (handoff)

- `cwd` given to `runCi` is the worktree `<main>/.empress/worktrees/N`
  (matches `git.ts` creation layout and `extension` calls). Non-worktree cwd
  (main repo) has a real `node_modules` dir → decision returns `null`, no harm.
- The only poison target ever written is exactly `/deps` (from
  `depsRelinkPrefix`). A worktree whose node_modules legitimately points at
  `/deps` would be rewritten — [ASSUMPTION] no such legit setup exists in
  EMPRESS-managed worktrees.