# Task #18 — GitHub issue-backed task store (GhTaskStore)

## Context
EMPRESS is local-first: tasks live as `.empress/tasks/NNNN-title.md` files and the
gh integration only pushed branches + opened PRs. Now that the repo is on GitHub
(`[github] enabled=true`), the task lifecycle should live on GitHub too — the same
issue tracker that receives the PRs.

## Shape
Task storage is centralized in `src/domain/tasks.ts` (createTask / listTasks /
getTask / updateTask / addComment / closeTask / removeTask), used by the CLI and
every `empress_*` superintendent/engineer tool. That is the seam: swap the
backend, not the call sites.

- **`src/domain/taskstore.ts`** — new module owning:
  - the `Task` / `TaskComment` / `TASK_STATUSES` types and `taskBrief` (moved from
    tasks.ts, re-exported by tasks.ts so no consumer changes),
  - a `TaskStore` interface,
  - `localTaskStore(cwd)` — the original `.md` behavior (unchanged, offline/local
    baseline),
  - `ghTaskStore(cwd, githubCfg)` — tasks as GitHub issues via the **gh CLI**
    (synchronous `spawnSync`, same as the existing `github.ts`),
  - `getTaskStore(cwd, config)` factory: gh when `[github] enabled=true` **and**
    gh is available **and** owner/repo resolve; otherwise local.
- **`src/domain/tasks.ts`** — becomes a thin delegate that keeps every exported
  signature (`cwd, id, ...`) and routes to `getTaskStore`. An optional trailing
  `store?` param allows tests to inject a backend.

So all existing call sites (CLI, extension tools) are unchanged; the backend is
selected purely by config.

## GitHub issue <-> Task mapping
| Task | GitHub |
|------|--------|
| id | issue number |
| title, body | issue title / body |
| status *done* | issue `state=closed` (close) |
| status *in-progress / blocked* | label `status:in-progress` / `status:blocked` (+ open issue) |
| status *assigned* | label `assignee:<agent>` (agent labels like `superintendent` are not GitHub logins, so NOT mapped to real assignees) |
| needs_clarification | label `needs-clarification` |
| labels | GitHub labels |
| branch / pr | HTML comments `<!--empress:branch=…-->` / `<!--empress:pr=…-->` appended to the body (hidden in rendered view, queryable in JSON body) |
| comments | issue comments via `gh api repos/O/R/issues/{n}/comments` (author prefix embedded in body, since gh posts as the CLI user) |
| file | `gh://owner/repo#<number>` |

## Selection + fallback
`getTaskStore` returns local unless gh is genuinely usable (enabled + installed +
repo resolvable). If gh is down or the repo can't be resolved, it silently falls
back to local so EMPRESS keeps running offline — the original local-first strength.

## Migration
`empress issue sync` reads open **local** tasks and creates a GitHub issue for
each (title + body + labels + branch/pr metadata + status/assignee/clarification
labels), returning the id → issue-number map. One-way bootstrap; not a live sync
daemon.

## Tests
- `test/taskstore.test.mjs`: local store regression (create/comment/update/close)
  + pure mapping (`issueToTask`, `desiredLabels`, metadata strip/build) + factory
  selection (gh vs local) with an injected fake `run`.
- Project gate (`bun scripts/selfcheck.ts` = `tsc --noEmit` + `bun test`) must pass.

## Risks / notes
- HIGH (control-plane, self-hosting). Manual merge.
- gh synchronous child-process per operation — acceptable (same as existing
  `github.ts`), and `gh issue list --json` bulk-reads bodies/labels in ONE call.
- GitHub comments can't fake an author; author role is embedded in the comment text.