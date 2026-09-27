# EMPRESS Docs

Central documentation directory.

- **`architecture.md`** — the system design: philosophy, architecture, task
  store, Jev/risk integration, Superintendent & Engineer roles, lifecycle
  (was the root `DESIGN.md`).
- **`release.md`** — the **manual** release procedure (merge `develop` → `main`,
  tag `v0.1.0`, create a GitHub Release). Not automated by design.
- **`decisions/`** — design decision records for individual features/changes
  (what/why + behavior spec, not implementation-tracing).

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
| `task-08-triage-convention-signals.md` | triage convention signals from the `diffBetween` changed list |
| `task-10-type-shared.md` | type `src/shared/*` (shell/frontmatter/config) to zero errors |
| `task-16-bun-lock-vuln-scan.md` | `empress_vuln_check` recognizes `bun.lock` (no silent dep-CVE no-op) |
| `task-18-gh-issue-taskstore.md` | GitHub-issue-backed task store (`GhTaskStore`) when `[github] enabled` |

## Conventions
- New design decisions go under `docs/decisions/` with a descriptive kebab-case
  name. Root is reserved for `README.md`; the code/CLI live in `src/`, prompts
  in `src/agents` + `src/prompts` (installed into `.empress/` and `.pi/`).