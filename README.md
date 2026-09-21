# EMPRESS

**Engineered Multi-Project Process & Review Execution System** — a
fully-automatic development harness built **on [pi]**.

EMPRESS is the pi-native successor to [HERMIT](../HERMIT), with two deliberate
removals and one addition:

- **No GitHub.** Tasks live as local files (`.empress/tasks/*.md`); merges happen
  on local git branches. Fully usable offline / self-hosted.
- **No Claude Code.** The Superintendent/Engineer loop is driven by pi
  (non-interactive `pi -p`), from a small Node driver or a `/empress` prompt.
- **Jev.** Gate judgments (readiness, risk, lessons) are delegated to TypeSafe's
  [Jev](https://typesafe.ai) (System One) via the existing
  [CHARIOT](../CHARIOT) CLI — with graceful fallback to rules if Jev is absent.

> **"pi is the star. EMPRESS is the toolbox for local + judgment operations."**

See **[DESIGN.md](DESIGN.md)** for the full architecture and the
HERMIT→EMPRESS mapping.

## Quick Start

```sh
# 1. Make the CLI runnable
npm link                       # or: alias empress="node bin/empress.js"

# 2. Stand up the pi extension + /empress prompt in any EMPRESS project
pi install .                   # install the bundled extension + prompt template

# 3. In a SWE project, scaffold the harness
cd your-project
empress init                   # writes empress.toml, .empress/, role prompts

# 4. Create a task
empress task "Add a sign-in flow" --acceptance "tests pass" --purpose "..."
empress list

# 5. Run the autonomous loop (recommended)
empress run                    # spawns pi Superintendents + Engineers on demand

# …or run a single pass interactively
#   (inside pi): /empress
```

Once running, EMPRESS automatically: picks up open tasks → judges readiness
(Jev) → creates a git worktree → spawns a parallel pi Engineer per task → runs
the project's test command → evaluates risk (heuristics + Jev) → lands safe
branches into `base_branch` → records lessons. HIGH-risk changes are left for a
human, with a review comment.

## Requirements

- **pi** (the harness itself).
- **git** (local worktrees/branches/merges).
- **Node.js ≥ 18** (driver CLI).
- **chariot** (optional, for Jev): build from `../CHARIOT`, put on PATH, and set
  `TYPESAFE_API_KEY`. Without it, EMPRESS runs on deterministic rules only.

## Commands

```
empress init                       Scaffold config, .empress store, role prompts
empress task "<title>" [flags]     Create a task
empress list [--all]               List tasks
empress run [--once] [--model M]   Start the Superintendent tick loop
empress pause|resume|quit|status   Control autonomous operation
empress doctor                     Check prerequisites
empress version                    Print version
```

## How it works

```
empress run (Node driver, tick loop)
   └─ spawn  pi -p -e empress.ts --append-system-prompt superintendent.md
          Superintendent (coordinator) uses empress_* tools:
            list / readiness / assign / create_worktree / spawn_engineers
            check_ci / evaluate_risk / land_task / lessons / notify
          └─ spawn Engineers (pi subagents) in each worktree
```

- **Superintendent** coordinates only — it never edits code. All implementation
  is delegated to Engineers (a hard prohibition modeled on HERMIT).
- **Engineers** work in isolated worktrees, implement against the task's
  Purpose / Scope / Acceptance Criteria / Non-Goals, run tests, commit.
- **Development conventions:** Engineers follow two rules
  (`.empress/agents/coding-guidelines.md` + `coding-guidelines-ponytail.md`):
  **Pure Function Testing / Command Verification** — tests are verification
  arithmetic (spec-derived, not implementation-tracing), tests come first, and
  non-trivial work gets a design doc before tests; **Ponytail** — the laziest
  solution that works (YAGNI, stdlib-first), shortcuts marked `ponytail:` with a
  ceiling/upgrade path. The Superintendent verifies the mapping and runs a
  simplicity pass (via `empress_ponytail_debt`) before landing a task.
- **Judgments** (readiness, risk, lesson quality) hit Jev via `chariot`
  (`noul` / `choice` / `score`), falling back to rules when Jev is unavailable.

## Project layout

```
.empress/
├── empress.toml                 # config (no secrets: TYPESAFE_API_KEY is env)
├── superintendent-state.json    # loop status + cadence (CLI-owned)
├── lessons.md                   # learned lessons (Jev-scored)
├── agents/                      # per-project role prompts (superintendent.md,
│                                #   engineer.md, task.md.tmpl)
├── tasks/NNNN-title.md          # one task file per item
└── worktrees/                   # git worktrees (git-ignored)
```

## License

MIT

## Dogfooding (EMPRESS on itself)

EMPRESS can manage its own repo. It has been `empress init`-ed and committed:

- `.empress/empress.toml` — `test_command = "node scripts/selfcheck.js"`, and the
  harness control plane (`src/extension/`, `src/cli/`, `src/shared/`, `bin/`,
  `package.json`, `.empress/agents/`, `src/prompts/`, `scripts/`) is marked
  `high_paths` so a change to the harness itself is always flagged HIGH and never
  auto-lands without a human.
- Loops and bots resolve the project root even when an Engineer runs inside a git
  worktree, so task-store tools (`empress_task_comment`, `empress_close_task`,
  etc.) always hit the main repo's `.empress/`.

Add tasks for real refactors (e.g. `empress task "..." --acceptance "..."`), then
run the loop: `empress run`. Because refactors may touch high-risk paths, expect
them to be reviewed and left for a human rather than auto-merged.

[pi]: https://pi.dev