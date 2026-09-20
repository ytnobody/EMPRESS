# EMPRESS — Design Document

**EMPRESS** (Engineered Multi-Project Process & Review Execution System) is a
fully-automatic development harness built **on pi**. It is the spiritual
successor to [HERMIT](../HERMIT) with two deliberate removals and one addition:

1. **No GitHub dependency.** Task intake, assignment, review, merge, and lessons
   all happen on the local filesystem + local git. There is no remote issue
   tracker and no remote PR. EMPRESS is fully usable offline / self-hosted.
2. **No Claude Code dependency.** The Superintendent/Engineer loop is driven
   programmatically by **pi** (non-interactive `pi -p` invocations) from a
   small Node driver process (`empress run`), or interactively via a `/empress`
   prompt template. No MCP registration, no `~/.claude/settings.json`, no
   machinery that only Claude Code understands.
3. **Jev integration.** Judgments that HERMIT made with its own LLM or with
   hand-written rules (readiness, risk, lesson scoring) are delegated to
   [TypeSafe's Jev](https://typesafe.ai) (System One), surfaced through the
   existing [CHARIOT](../CHARIOT) CLI, so the harness can use a cheap,
   deterministic, single-pass judgment model for gate decisions.

---

## 1. Design Philosophy

> **"pi is the star. EMPRESS is the toolbox for local + judgment operations."**

Reasoning, orchestration, and context management are delegated to **pi**
(running as a Superintendent session). EMPRESS provides:

- a thin **domain toolbox** (local task store + git operations) exposed as a
  pi **extension** (custom tools),
- a thin **judgment layer** that shells out to **Jev** via the `chariot` CLI,
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
| `get_loop_state` / `update_loop_state` | `empress_get_loop_state` / `empress_update_loop_state` on `.empress/superintendent-state.json` |
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
   │  git CLI      │  chariot CLI (Jev)            │  local files  │
   │  worktrees    │  <choice|score|noul>          │  .empress/    │
   │  branches/merge│  state per stdin line         │  tasks/       │
   │               │                               │  lessons.md   │
   └───────────────┴───────────────────────────────┴───────────────┘
```

**Two ways to run the Superintendent loop:**

- **`empress run`** (recommended, unattended): a long-lived Node process owns a
  ticker. Each tick it spawns one UTC `pi -p` Superintendent pass, waits for it,
  then sleeps `loop_interval`. No overlapping passes. Checks
  `.empress/superintendent-state.json`'s `status` field before each tick
  (`running`/`paused`/`quit`).
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
├── tsconfig.json
├── README.md                  # usage
├── DESIGN.md                  # this file
├── bin/
│   └── empress.js             # CLI entry (plain Node, ESM)
├── src/
│   ├── shared/
│   │   ├── frontmatter.js     # minimal YAML frontmatter parse/serialize
│   │   ├── config.js          # empress.toml load / defaults
│   │   └── shell.js           # runSync / runAsync helpers
│   ├── domain/
│   │   ├── jev.js             # chariot wrapper (Jev judgment primitives)
│   │   ├── tasks.js           # local task store (.empress/tasks)
│   │   ├── git.js             # worktree/branch/merge/diff helpers
│   │   ├── risk.js            # deterministic + Jev risk evaluation
│   │   ├── readiness.js       # Jev-backed readiness check
│   │   └── lessons.js         # lesson scoring + store
│   ├── cli/
│   │   ├── main.js            # argument dispatch
│   │   ├── init.js            # generate empress.toml + .empress scaffold + role prompts
│   │   ├── doctor.js          # prereq checks
│   │   ├── state.js           # .empress/superintendent-state.json read/write
│   │   └── run.js             # Superintendent tick loop
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
├── superintendent-state.json
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

## 6. Jev / CHARIOT Integration

[Jev](https://typesafe.ai) (System One) is a single-pass judgment model. We
surface it through the existing `chariot` CLI so EMPRESS gets three cheap
judgment primitives without pulling in a big LLM:

| Primitive | Meaning | EMPRESS uses it for |
|---|---|---|
| `noul` | probability of a statement | readiness: "is this task ready?" |
| `choice` | pick one option | risk band selection / triage categories |
| `score` | ordinal level, low→high | risk severity, lesson quality |

The `jev` domain module pipes one `state` line per judgment into `chariot
<type> [...] <instructions>` (stdin→stdout NDJSON, streaming), exactly the
shape chariot is built for. The `TYPESAFE_API_KEY` env var is read by chariot.

**Graceful degradation.** If `chariot` is missing on PATH or `TYPESAFE_API_KEY`
is unset, every judgment-backed tool falls back to its deterministic/rules
component so EMPRESS still functions without Jev. `harness.toml` can force Jev
usage on or off. This keeps Jev an *enhancement* of the harness, not a hard
dependency — matching the "make Jev usable from the harness" goal without making
it a blocker.

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

---

## 8. Superintendent & Engineer Roles

The role prompts in `src/agents/` are the pi-native replacement for HERMIT's
`CLAUDE.md`. They are appended to every relevant pi invocation with
`--append-system-prompt`.

**Enforced coding conventions.** EMPRESS bakes in two complementary project
conventions (ports of the user's `pure-function-testing` skill and the `ponytail`
plugin, in `src/agents/`):

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

Together: **build the laziest correct thing, and verify it as arithmetic, not
by retracing it.** The Superintendent enforces both — it reviews the design doc
and spec-derived tests (PFT) **and** runs a Ponytail simplicity pass
(`delete`/`stdlib`/`native`/`yagni`/`shrink`) on every diff before a task is
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
npm link               # or: alias empress="node bin/empress.js"

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
| 2 | `domain/jev.js` | chariot CLI |
| 3 | `domain/tasks.js` | shared |
| 4 | `domain/git.js`, `risk.js`, `readiness.js`, `lessons.js` | tasks, jev |
| 5 | `extension/empress.ts` | domain |
| 6 | `cli/state.js`, `init.js`, `doctor.js`, `run.js`, `main.js` | domain, extension |
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