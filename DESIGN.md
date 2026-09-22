# EMPRESS — Design Document

**EMPRESS** (Engineered Multi-Project Process & Review Execution System) is a
fully-automatic development harness built **on pi**. It is the spiritual
successor to [HERMIT](https://github.com/ytnobody/HERMIT) with two deliberate
removals and one addition:

1. **No GitHub dependency.** Task intake, assignment, review, merge, and lessons
   all happen on the local filesystem + local git. There is no remote issue
   tracker and no remote PR. EMPRESS is fully usable offline / self-hosted.
2. **No Claude Code dependency.** The Superintendent/Engineer loop is driven
   programmatically by **pi** (non-interactive `pi -p` invocations) from a
   small Node driver process (`empress run`), or interactively via a `/empress`
   prompt template. No MCP registration, no `~/.claude/settings.json`, no
   machinery that only Claude Code understands.
3. **Jev integration.** Judgments (readiness, risk, lesson scoring) are delegated
   to [TypeSafe's Jev](https://typesafe.ai) (System One) via a **native HTTPS
   call** (`src/domain/jev.ts`, `fetch`-based) — no separate CLI — so the
   harness can use a cheap, deterministic, single-pass judgment model for gate
   decisions, with fallback to rules when `TYPESAFE_API_KEY` is unset.

---

## 1. Design Philosophy

> **"pi is the star. EMPRESS is the toolbox for local + judgment operations."**

Reasoning, orchestration, and context management are delegated to **pi**
(running as a Superintendent session). EMPRESS provides:

- a thin **domain toolbox** (local task store + git operations) exposed as a
  pi **extension** (custom tools),
- a thin **judgment layer** that calls **Jev** natively over HTTPS (`fetch`),
  with fallback to rules when no `TYPESAFE_API_KEY` is set,
- a thin **driver** (`empress run`) that keeps the loop alive and spawns
  pi Engineers in parallel, and
- **role prompts** (`superintendent.md`, `engineer.md`) that teach pi how to
  behave in each role — the pi-native replacement for HERMIT's `CLAUDE.md`.

Like HERMIT, we keep the code small. Most of the "smarts" live in pi's agent,
in the role prompts, and in Jev — not in EMPRESS's own logic.

---

## 2. Conceptual Mapping (HERMIT → EMPRESS)

| HERMIT (Claude Code + GitHub) | EMPRESS (pi + local git + Jev) |
|---|---|
| Claude Code session + `CLAUDE.md` | pi session / `pi -p` subprocess + `--append-system-prompt <agent>.md` |
| GitHub **Issue** | Local task file `.empress/tasks/NNNN-title.md` |
| Issue label / assignee | Task frontmatter `status`, `assignee`, `tags` |
| `list_issues` MCP tool | `empress_list_tasks` extension tool |
| Readiness hearing (`needs-clarification`) | `empress_readiness` Jev judgment → `needs_clarification: true` in task frontmatter |
| `assign_issue` | `empress_assign_task` (sets status `assigned`) |
| `create_worktree` | `empress_create_worktree` → branch `empress/task-NNNN`, git worktree under `.empress/worktrees/` |
| GitHub PR | Local branch `empress/task-NNNN` |
| `check_ci_status` | `empress_check_ci` → runs task's configured `test_command` and reports pass/fail |
| `evaluate_risk` | `empress_evaluate_risk` — deterministic heuristics **+ Jev `score`** judgment on the diff |
| `merge_pr` | `empress_land_task` — merges branch into configured base branch locally, cleans worktree |
| Issue/PR comments | Task frontmatter `comments[]` (local, appended via `empress_task_comment`) |
| `close_issue` | `empress_close_task` (status `done`) |
| `get_lessons` | `empress_get_lessons` → `.empress/lessons.md`, scored via Jev |
| `notify` webhook | `empress_notify` (kept, optional) |
| Claude `ScheduleWakeup` / `/loop` cron | `empress run` driver process ticking at `loop_interval`, or `/empress` prompt per pass |
| Claude **Agent** tool (spawn Engineers) | Driver / `empress_spawn_engineers` spawning `pi --mode json -p` per Engineer (bounded to `max_engineers`) |
| `get_loop_state` / `update_loop_state` | `empress_get_loop_state` / `empress_update_loop_state` on `.empress/superintendent-state.tson` |
| `hermit pause` / `resume` / `quit` | `empress pause` / `resume` / `quit` |

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  empress run (Node driver, owns the tick loop)              │
│    every loop_interval:                                      │
│      spawn:  pi -p --mode json -e empress.ts                 │
│              --append-system-prompt superintendent.md        │
│              "Run one Superintendent cycle"                  │
└───────────────────────────────┬──────────────────────────────┘
                                │  Superintendent (pi session)
                                │  acts as coordinator only (no direct edits)
   ┌────────────────────────────▼───────────────────────────┐
   │  EMPRESS extension (empress_* custom tools)            │
   │  - local task store  (list/assign/comment/close)       │
   │  - git worktrees     (create/cleanup)                  │
   │  - branches          (list)                            │
   │  - ci               (test_command)                     │
   │  - risk             (deterministic + Jev)              │
   │  - readiness         (Jev)                             │
   │  - lessons, notify, loop-state, config, now            │
   │  - spawn_engineers   (dispatch pi Engineer subagents)  │
   └───────────────────────────────┬────────────────────────┘
            domain layer (Node)     │
   ┌───────────────┬────────────────┴──────────────┬───────────────┐
   │  git CLI      │  Jev HTTPS (fetch)            │  local files  │
   │  worktrees    │  <choice|score|noul>          │  .empress/    │
   │  branches/merge│  state per stdin line         │  tasks/       │
   │               │                               │  lessons.md   │
   └───────────────┴───────────────────────────────┴───────────────┘
```

**Two ways to run the Superintendent loop:**

- **`empress run`** (recommended, unattended): a long-lived, **event-driven**
  Node process. It is cost-shaped cheapest-first:
  1. **zero-LLM fs poll** (`tasksHash`, `wake_interval`, default 60s) — a pass
     is considered only when the task queue actually changed;
  2. **preflight readiness** (deterministic + ONE Jev batch call) — the LLM is
     spawned only when at least one task is READY (skips log `no ready work`);
  3. **LLM pass** (`pi -p` Superintendent) for real work, plus an **idle
     self-audit** pass on `audit_interval` (default 3600s; 0 = off) that runs
     checks and files findings as tasks.
  No LLM/Jev runs just because a clock ticked. Checks the
  `.empress/superintendent-state.tson` `status` field before each poll
  (`running`/`paused`/`quit`). `--once` retains the legacy single-pass mode.
- **`/empress` prompt template** (interactive): expands to "run one
  Superintendent cycle now" inside an existing pi session. Use this when you
  want to supervise the loop by hand.

Engineers are always spawned as short-lived `pi --mode json -p --no-session`
subprocesses against the task's worktree, regardless of which driver mode the
Superintendent ran under.

---

## 4. Directory Structure

```
empress/
├── package.json               # pi package manifest + bin/empress + pi-package
├── tsconfig.tson
├── README.md                  # usage
├── DESIGN.md                  # this file
├── bin/
│   └── empress.ts             # CLI entry (TypeScript, run with Bun)
├── src/
│   ├── shared/
│   │   ├── frontmatter.ts     # minimal YAML frontmatter parse/serialize
│   │   ├── config.ts          # empress.toml load / defaults
│   │   └── shell.ts           # runSync / runAsync helpers
│   ├── domain/
│   │   ├── jev.ts             # native Jev client (fetch; pure request/parse)
│   │   ├── tasks.ts           # local task store (.empress/tasks)
│   │   ├── git.ts             # worktree/branch/merge/diff helpers
│   │   ├── risk.ts            # deterministic + Jev risk evaluation
│   │   ├── readiness.ts       # Jev-backed readiness check
│   │   └── lessons.ts         # lesson scoring + store
│   ├── cli/
│   │   ├── main.ts            # argument dispatch
│   │   ├── init.ts            # generate empress.toml + .empress scaffold + role prompts
│   │   ├── doctor.ts          # prereq checks
│   │   ├── state.ts           # .empress/superintendent-state.tson read/write
│   │   └── run.ts             # Superintendent tick loop
│   ├── extension/
│   │   └── empress.ts         # pi extension registering empress_* tools
│   └── agents/
│       ├── superintendent.md  # Superintendent role prompt
│       ├── engineer.md        # Engineer role prompt
│       └── task.md.tmpl       # new-task file template
```

---

## 5. Local Task Store

A task is a Markdown file under `.empress/tasks/` with YAML frontmatter.

```
.empress/
├── harness.toml            # project config (shared, committed)
├── superintendent-state.tson
├── lessons.md
├── tasks/NNNN-title.md     # one file per task
└── worktrees/              # git worktrees (gitignore'd)
```

**Task file shape:**

```markdown
---
id: 3
title: "Implement the greeter"
status: open                # open | assigned | in-progress | done | blocked
assignee: ""
created: "2025-09-20T00:00:00Z"
labels: []
needs_clarification: false
branch: ""                  # set once create_worktree runs
comments: []                # local comment log [{author, at, body}]
---
# greeter: implement the greeter

## Purpose
What we are building and why.

## Scope
What is / is not in scope.

## Acceptance Criteria
- [ ] works offline
- [ ] covered by tests

## Non-Goals
- exotic features
```

The **readability/hearing flow** (mirroring HERMIT readiness) works like this:
`empress_list_tasks` skips tasks with `needs_clarification: true`. When a task
body is too short or lacks an acceptance-criteria section, `empress_readiness`
marks it `needs_clarification: true` and posts a structured comment asking for
**Purpose / Scope / Acceptance Criteria / Non-Goals**. A human edits the task
file and sets `needs_clarification: false`; it re-enters the queue on the next
cycle.

---

## 6. Jev Integration (native)

[Jev](https://typesafe.ai) (System One) is a single-pass judgment model. EMPRESS
calls it **natively over HTTPS** (`fetch` (Bun or Node runtime)) — `src/domain/jev.ts`
builds the request and maps the answer, so there is no separate CLI to install.
It gives EMPRESS three cheap judgment primitives without pulling in a big LLM:

| Primitive | Meaning | EMPRESS uses it for |
|---|---|---|
| `noul` | probability of a statement | readiness: "is this task ready?" |
| `choice` | pick one option | risk band selection / triage categories |
| `score` | ordinal level, low→high | risk severity, lesson quality |

`jev.ts` is deliberately PFT-shaped: request construction (`buildSystemOneRequest`,
`buildCriteria`) and answer mapping (`parseAnswer`) are pure functions, and the
HTTP transport is injectable — so `test/jev.test.mjs` asserts the assembled
request/response contract (Command Verification) without real network. The
`TYPESAFE_API_KEY` env var is the only required credential.

**Graceful degradation.** If `TYPESAFE_API_KEY` is unset, every judgment-backed
tool falls back to its deterministic/rules component so EMPRESS still functions
without Jev. `empress.toml` can force Jev usage on or off. This keeps Jev an
*enhancement* of the harness, not a hard dependency.

---

## 7. Risk Evaluation (hybrid)

`empress_evaluate_risk` computes a band `LOW` / `MEDIUM` / `HIGH` for a task
branch using:

1. **Deterministic heuristics** (HERMIT-compatible, configurable via
   `[risk]`): changed-file/line counts vs thresholds; changed path prefixes
   matching `high_paths` / `medium_paths`; control-plane paths always HIGH.
2. **Jev `score`** override/confirmation: the diff is sent as `state` to a
   `score` judgment ("how risky is this change?") over e.g. `[negligible,
   minor, notable, critical]` levels. The Jev band and the deterministic band
   are combined (max severity), unless `use_jev` is off.

`empress_land_task` (the merge step) refuses HIGH without `force: true`,
requires the test command to pass, then merges the branch into the configured
base branch and cleans up the worktree/branch, and records a lesson.

### 7.1 CI gate execution (native, optional container isolation)

The "CI" is the project's `test_command` run as a land gate. `src/domain/ci.ts`
runs it either on the host or inside an isolated container, selected by `[ci]`
in `empress.toml` (`engine = host|podman|docker`, `image`, `network`). The
worktree mounts at `/project:rw` and `test_command` runs inside the container
(`buildContainerArgs` is a pure command-builder, verified by `test/ci.test.mjs`
without a real container). If a configured engine is unavailable it falls back
 to the host — the same graceful degradation as Jev. Host secrets are never
injected; container root maps to the host user via the rootless subuid range.

### 7.2 Review triage (cheap, Jev-gated)

Before the deep LLM review, `empress_triage_review` decides whether one is
even needed — a cheapest-first ladder (L1 free, L2 only when Jev is available):

1. **Deterministic (always):** secret/dangerous-pattern scan of the diff
   (`scanDiff`), a PFT §9 convention signal (code changed without tests), and
   the existing dependency vuln scan.
2. **Jev (only if `TYPESAFE_API_KEY` is set):** a *single* `noul` call — "does
   this change warrant human review?" (`src/domain/triage.ts`; the questions
   and decision thresholds are pure functions, verified by
   `test/triage.test.mjs` without network).
3. **LLM (Superintendent):** everything escalated here gets the full
   PFT/Ponytail/Security review.

Safety invariants: a deterministic hit always escalates regardless of what Jev
says; Jev error/unavailability escalates (never auto-passes; `degraded` keeps
behavior identical to the no-Jev case); and `signal: ok` never exempts HIGH /
trust-boundary / control-plane changes — those are always fully reviewed. The
result is: when Jev is available, only genuinely clear LOW/MEDIUM diffs are
fast-pathed; otherwise behavior is exactly today's full review.

---

## 8. Superintendent & Engineer Roles

The role prompts in `src/agents/` are the pi-native replacement for HERMIT's
`CLAUDE.md`. They are appended to every relevant pi invocation with
`--append-system-prompt`.

**Enforced coding conventions.** EMPRESS bakes in three complementary project
conventions (ports of the user's `pure-function-testing` skill, the `ponytail`
plugin, and the `app-security-review`/`vuln-check` skills, in `src/agents/`):

1. **Pure Function Testing / Command Verification** (`coding-guidelines.md`) —
   *what we verify*: verification arithmetic (tests derive expected values from
   spec, never from running the implementation); tests before implementation;
   design doc (Level 1/2) for non-trivial tasks (§11); pure functions with
   effects as **Commands**; Command Verification (assert the assembled Command,
   never mock); ambiguous requirements surfaced as `[ASSUMPTION]` handoff items
   (§10); tests are a mapping of the design doc (§9/§13).
2. **Ponytail** (`coding-guidelines-ponytail.md`) — *what we build*: the lazist
   solution that actually works (YAGNI ladder, stdlib/native-first, no
   speculative abstractions, shortest working diff); deliberate shortcuts carry a
   `ponytail:` comment with a ceiling + upgrade path, harvested into a debt
   ledger by `empress_ponytail_debt`.

3. **Security** (`coding-guidelines-security.md`) — *what we never compromise*:
   trust-boundary validation, secrets, auth/authz, injection, dependency CVEs.
   Includes the deterministic `empress_vuln_check` tool (`src/domain/vuln.ts`:
   auto-detects go/npm/pip, runs govulncheck / npm audit / pip-audit; pure
   detection + parsing, command-verified by `test/vuln.test.mjs`).

Together: **build the laziest correct thing, verify it as arithmetic, and never
be lazy about security.** The Superintendent enforces all three — it reviews the
design doc and spec-derived tests (PFT), runs a Ponytail simplicity pass
(`delete`/`stdlib`/`native`/`yagni`/`shrink`), runs a Security pass
(`empress_vuln_check` first, then `auth`/`authz`/`injection`/`secrets` tags;
HIGH or trust-boundary findings hold the landing for a human) — before a task is
considered ready to land, and tracks `ponytail:` debt.

**Superintendent** (coordinator only — hard prohibition on editing files it
would delegate): checks an `empress_*` tool is resolvable, retrieves open tasks,
assigns, creates worktrees, spawns Engineers (bounded, parallel), waits, checks
CI, evaluates risk, lands safe tasks, writes lessons, and ends the pass. It
delegates all implementation to Engineers. (Human-input policy: record questions
on the task, never block on a chat prompt.)

**Engineer** (implementer): works in the given worktree, implements the task
against its Purpose / Scope / Acceptance Criteria, writes tests, runs the
configured `test_command`, commits to the task branch, marks the task
`in-progress`→`done` (or leaves a comment), and reports back.

---

## 9. Lifecycle

```sh
# 1. Install dependencies + make the CLI runnable
npm install            # (pi-coding-agent is a peer dep, provided by pi itself)
npm link               # or: alias empress="bun /path/to/EMPRESS/bin/empress.ts"

# 2. Stand up the extension inside an EMPRESS project
pi install .           # installs this package (extension + prompt template) -l into .pi
# or simply let `empress init` copy .pi wiring

# 3. Initialize a project
cd your-project
empress init           # writes empress.toml, .empress/, role prompts, .pi wiring

# 4. Create a task
empress task "Implement the greeter" --acceptance "works offline"   # writes .empress/tasks/1.md

# 5. Run the loop (recommended) — or type /empress inside pi
empress run            # Superintendent loop; spawns pi Engineers on demand
```

---

## 10. Implementation Order

| Step | Content | Dependencies |
|---|---|---|
| 1 | `package.json`, tsconfig, shared/frontmatter, shell | none |
| 2 | `domain/jev.ts` | fetch (Node runtime; no external CLI) |
| 3 | `domain/tasks.ts` | shared |
| 4 | `domain/git.ts`, `risk.ts`, `readiness.ts`, `lessons.ts` | tasks, jev |
| 5 | `extension/empress.ts` | domain |
| 6 | `cli/state.ts`, `init.ts`, `doctor.ts`, `run.ts`, `main.ts` | domain, extension |
| 7 | `agents/*.md` role prompts | — |

---

## 11. Comparison vs HERMIT

| Axis | HERMIT | EMPRESS |
|---|---|---|
| Orchestrator | Claude Code | pi (`pi -p`, prompt templates) |
| Issue tracker | GitHub Issues | local task files |
| Merge target | GitHub PR | local branch → local base merge |
| Judgment | LLM-in-loop + rules | Jev (System One) + rules |
| Install | `curl sh` + `claude mcp add` | `pi install .` + `empress init` |
| Network needed | GitHub (issues/PRs) | optional (Jev); core works offline |
| Code volume | ~700 Go (MCP server) | small Node toolbox + role prompts |