# Task #59 — podman CI gate: git-fixture skip guards + robust in-image git probe

Spec source: issue "Fix podman CI gate: git-fixture tests (mergeConflict in
test/git.test.mjs, treeHygieneViolations in test/hygiene.test.mjs) fail
in-container — add gitAvailable skip guard". Acceptance criteria A1–A4.

## Behavior specs

- S1. In an environment with no `git` binary (the [ci] container
  oven/bun:1.4-alpine ships none), every test whose fixture needs a real git
  repo SKIPS via `t.skip("git not available in this environment")` instead of
  failing on the impossible fixture:
  - S1a. `mergeConflict` (test/git.test.mjs)
  - S1b. all three hygiene repo-fixture tests (test/hygiene.test.mjs:
    force-added gitignored path, clean tree, symlink-vs-dir isGitignored)
  - (existing precedent, unchanged: `pruneStaleMergedBranches` in
    test/git.test.mjs, `trackedSecretFiles` in test/audit.test.mjs — lessons
    #4/#12: "host runs are the authority for this spec".)
- S2. `gitProbeOk(res)` — pure predicate over a `git --version` probe result —
  is true ONLY when the probe exited 0 AND stdout starts with `git version N`
  (genuine git output). It is false for bun's git shim even when it exits 0
  (`Script not found "git"`), for empty stdout, and for any non-zero exit.
- S3. runCi reports `gitAvailable` as `gitProbeOk` of the in-image probe (and
  of the host probe on the host-fallback path), so `skipEligible` flips back
  to true when the image lacks real git (A3).

## Interface map

- `gitProbeOk(res: { code: number; stdout: string }): boolean` — new pure
  export in src/domain/ci.ts (Command-verification target: no process spawned).
- runCi probe lines change from `.code === 0` to `gitProbeOk(...)` (both the
  in-image probe and the host-fallback probe; same "is there real git" question).

## Verification arithmetic (spec-derived, independent of the impl)

- Real git probe: exit 0 + stdout `git version 2.39.1` → gitProbeOk true →
  runCi skipEligible false (host + git-laden container still run the suites).
- Bun shim probe: exit 0 + stdout `Script not found "git"` → gitProbeOk false →
  runCi gitAvailable false → skipEligible true.
- exit 1 (`git: not found`) → false. Empty stdout with exit 0 → false.