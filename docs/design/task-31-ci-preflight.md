# Task 31 — CI environment preflight (podman): design / spec map

Level 0 (business intent): two infra (not code) incidents blocked landings —
`oven/bun:1.4-alpine` lacked `git` (task #4) and the deps `node_modules`
symlink self-poisoned via the rw bind (task #5, already healed in `ci.ts`).
Before a task's land gate we must deterministically validate/heal the podman CI
environment so that *only code-caused* CI failures block landings.

This doc is the spec/interface map (PFT §11), not an architecture essay.

## Behaviour spec

1. Before any container run, a **preflight** heals a prior run's `/deps`
   write-back on the worktree `node_modules` symlink (already pioneered by
   task #5 — `healDepsRelink`) and reports the environment.
2. The preflight reports three deterministic observations:
   - **git presence** in the run environment (`git --version` succeeds).
   - **deps symlink health** — `node_modules` resolves to a real directory.
   - whether a deps heal was applied.
3. **git-or-skip**: the report classifies the run as `skipEligible` when git is
   absent **or** deps are unresolvable — the environment cannot give a
   trustworthy code verdict, so a container/host failure is attributed to the
   environment rather than the code.
4. The run itself proceeds exactly as today (container relink prefix, host
   fallback, engine unavailable → host) — **no change to test semantics**.
5. `runProjectCi` returns the `preflight` report so callers (`empress_check_ci`,
   `empress_land_task`) can attribute failures.

## Interface shapes (Command / pure functions)

```ts
// Pure decision (Command-verifiable; no side effects).
interface Preflight {
  engineReady: boolean;   // container engine responded to --version (container path)
  gitAvailable: boolean;  // git --version succeeded in the run environment
  depsHealthy: boolean;   // node_modules symlink resolves to a real dir
  healed: boolean;        // a deps symlink repair was applied during preflight
  skipEligible: boolean;  // = !gitAvailable || !depsHealthy  (infra-caused, not code)
}
function decidePreflight(o: { engineReady; gitAvailable; depsHealthy; healed }): Preflight

// Deterministic health check (idempotent, pure-ish file probe).
function nodeModulesHealthy(cwd: string): boolean
```

`runCi`/`runProjectCi` gain a `preflight: Preflight` field in their result;
existing result fields (`code`, `stdout`, `stderr`, `engine`) are unchanged.

## Verification arithmetic (map → test cases)

- `decidePreflight` is pure: assert the `skipEligible` flip purely from inputs.
- `nodeModulesHealthy`: assert true for a real-dir-resolving symlink, false for
  a poisoned `/deps` link (realpath ENOENT) and for missing node_modules.
- `runCi` (injected `_run`, no real container):
  - container path emits a git probe `[run --rm <image> git --version]` before
    the test run; git-absent probe → `skipEligible: true`.
  - host path probes host git; deps healthy → `skipEligible: false`.
  - env skip does not change execution (same container/host commands as today).

## Handoff / assumptions

- `[ASSUMPTION]` skip-eligibility is a *reporting* classification: callers
  attribute a failed check to the environment and let the Superintendent decide
  whether to proceed/land — the code never auto-skips the actual test run
  (non-goal: don't weaken the real gate).