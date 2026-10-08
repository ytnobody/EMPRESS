# EMPRESS Docs

Central documentation directory.

- **`architecture.md`** — the system design: philosophy, architecture, task
  store, Jev/risk integration, Superintendent & Engineer roles, lifecycle
  (was the root `DESIGN.md`).
- **`release.md`** — the **manual** release procedure (merge `develop` → `main`,
  tag `v0.1.0`, create a GitHub Release). Not automated by design.
- **`decisions/`** — design decision records for individual features/changes
  (what/why + behavior spec, not implementation-tracing).
- **`design/`** — per-task design docs (behavior spec + interface shape +
  verification arithmetic — the Level 1/2 spec that tests map to).

## README
The user-facing quickstart + command reference stays at the repo root:
**[`../README.md`](../README.md)**. That includes a **GitHub-managed issues**
section explaining that with `[github] enabled = true` tasks become GitHub
issues (`empress task`/`list`/`sync`) and that `empress sync` migrates open
local tasks to issues.

## decisions/ index

| File | Decision covered |
|---|---|
| `git-land-origin-merge.md` | drop the doomed origin-merge line in `git.landBranch` |
| `readiness-jev-degradation.md` | `checkReadyTasks` Jev-error fallback (task #7) |
| `triage-scandiff-patterns.md` | triage `scanDiff` L1 patterns (SSRF / XXE / `sh -c` injection) |
| `task-05-ci-deps-relink-poisoning.md` | heal the CI deps-mount `node_modules` relink so a container run never poisons the host symlink |
| `task-08-triage-convention-signals.md` | triage convention signals from the `diffBetween` changed list |
| `task-10-type-shared.md` | type `src/shared/*` (shell/frontmatter/config) to zero errors |
| `task-16-bun-lock-vuln-scan.md` | `empress_vuln_check` recognizes `bun.lock` (no silent dep-CVE no-op) |
| `task-18-gh-issue-taskstore.md` | GitHub-issue-backed task store (`GhTaskStore`) when `[github] enabled` |
| `task-19-mutation-jev-gate.md` | mutation-testing + Jev gate (`empress_check_mutation`) for deterministic weak-test detection |
| `task-32-agent-comment-marker.md` | agent-vs-human comment detection via the `<!--empress:agent=…-->` marker, not the `**[agent]**` prefix |

## design/ index

Per-task design docs (behavior spec + interface shape + verification arithmetic).
The `docs/` root holds only this index README plus the two top-level docs named
above (`architecture.md`, `release.md`) and the `decisions/` + `design/` dirs.

| File | Design covered |
|---|---|
| [`design-task-33.md`](design/design-task-33.md) | auto-land behavior-preserving pure refactors |
| [`design-task-34.md`](design/design-task-34.md) | language-aware output across the whole harness |
| [`design-task-35.md`](design/design-task-35.md) | title-only issues: proposal-first immediate response |
| [`design-task-36.md`](design/design-task-36.md) | mutation gate into CI + expanded mutant operators |
| [`design-task-37.md`](design/design-task-37.md) | disambiguate issue vs PR numbers + strengthen task dedupe |
| [`design-task-64.md`](design/design-task-64.md) | prune fully-merged leftover branches + worktrees |
| [`design-task-68.md`](design/design-task-68.md) | prune squash/PR-merged branches too |
| [`design-task-70.md`](design/design-task-70.md) | auto-prune confirmed-PR-MERGED DONE-task worktrees |
| [`task-15-prune-remote.md`](design/task-15-prune-remote.md) | prune stale merged remote branches |
| [`task-30-stall-watchdog.md`](design/task-30-stall-watchdog.md) | activity-based (stall) watchdog for passes |
| [`task-31-ci-preflight.md`](design/task-31-ci-preflight.md) | CI environment preflight (podman) |
| [`task-59-ci-git-fixture-skip.md`](design/task-59-ci-git-fixture-skip.md) | podman CI gate: git-fixture skip guards + in-image git probe |

## Conventions
- New per-task design docs go under `docs/design/`; new design decisions go under
  `docs/decisions/` — both with a descriptive kebab-case name. The `docs/` root
  holds this index `README.md`, the two top-level docs (`architecture.md`,
  `release.md`), and the `decisions/` + `design/` dirs; the code/CLI live in
  `src/`, prompts in `src/agents` + `src/prompts` (installed into `.empress/`
  and `.pi/`).