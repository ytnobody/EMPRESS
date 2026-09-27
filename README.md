# EMPRESS

**Engineered Multi-Project Process & Review Execution System** — a
fully-automatic development harness built **on [pi]**.

EMPRESS is a fully-automatic development harness with three shaping decisions:

- **Local-first.** Tasks live as local files (`.empress/tasks/*.md`); merges happen
  on local git branches. No remote issue tracker, no remote PR — fully usable
  offline / self-hosted.
- **pi-driven.** The Superintendent/Engineer loop is driven by pi
  (non-interactive `pi -p`), from a small driver process or a `/empress` prompt.
- **Jev judgments.** Gate judgments (readiness, risk, review triage are delegated
  to TypeSafe's [Jev](https://typesafe.ai) (System One) via a **native HTTPS
  call** — with graceful fallback to rules if no `TYPESAFE_API_KEY` is set.

> **"pi is the star. EMPRESS is the toolbox for local + judgment operations."**

See **[docs/architecture.md](docs/architecture.md)** for the full architecture.

---

## 1. Prerequisites

| Tool | Required | Notes |
|---|---|---|
| **Bun ≥ 1.4** | ✅ | runs the `empress` CLI (using a single self-contained TypeScript entry) |
| **pi** | ✅ | the harness brain (`pi -p`) |
| **git** | ✅ | worktrees / branches / merges |
| **TYPESAFE_API_KEY** | optional | enables Jev judgments (readiness/risk/lessons); unset = deterministic rules only |

## 2. Get the `empress` command runnable

The CLI is a single self-contained TypeScript entry — `bin/empress.ts`, run with Bun. Make it
callable as `empress` (pick **one**):

```sh
# A) Put the harness dir on PATH (recommended)
export PATH="/path/to/EMPRESS/bin:$PATH"      # add to ~/.bashrc / ~/.profile
alias empress="bun /path/to/EMPRESS/bin/empress.ts"

# B) Or symlink into a dir already on PATH
bun /path/to/EMPRESS/bin/empress.ts   # or: cd /path/to/EMPRESS && npm link (bin/empress.ts)

# C) Or npm link (installs a global `empress` bin)
cd /path/to/EMPRESS && npm link
```

Verify it's on PATH, then check your environment:

```sh
empress --version
empress doctor        # all ✓ = ready; ✗ tells you what to fix
```

## 3. Set up in a project

```sh
cd your-project
git init                  # REQUIRED — EMPRESS needs a git repo (+ an initial commit)
empress init              # writes .empress/empress.toml + role prompts; asks base branch, test command
```

`empress init` asks for:
- **base branch** (`main`) — the branch work lands onto,
- **test command** (e.g. `go test ./...` / `node test`) — the "CI" gate run before
  a merge; leave empty to skip,
- **max engineers** / **loop interval** / **language**.

> **Containerized CI (optional).** Add a `[ci]` section to run the test command
> inside an isolated container instead of on the host:
> ```
> [ci]
> engine = "podman"     # host (default) | podman | docker
> image  = "oven/bun:1.4-alpine"
> network = "default"    # default | none | host
> ```
> The worktree is mounted read-write at `/project` and the test command runs in
> the container. If the engine is unavailable it falls back to the host.

> **After init**, the harness is just a config + role prompts. `agents/*` are
> per-project instructions like CLAUDE.md — edit them freely.

### Run the full EMPRESS loop (setup → resident)

Once `empress` is callable (§2) and a project is configured (§3), stand up the
**full autonomous loop** end-to-end:

1. **Configure `.empress/empress.toml`.** `empress init` writes sane defaults; tune
the loop before going live. The key fields:

   ```toml
   base_branch = "main"      # branch that task branches land onto
   test_command = "bun scripts/selfcheck.ts"  # the "CI" gate run before a merge
   max_engineers = 3         # parallel Engineers spawned per pass
   loop_interval = 60        # idle-tick / wake cadence (seconds)
   language = "en"           # issue language
   ```

   `base_branch`, `test_command`, `max_engineers`, `loop_interval` and `language`
   mirror the `empress init` prompts and can be passed as CLI flags
   (`empress init --base_branch main --test_command "…"`). For the optional
   `[ci]` container engine, per-role `[models]`, and `[github]` sections, see the
   [Configuration](#configuration-empresstoml) section below.

2. **Health-check the project.** Run the same self-check that CI uses as its gate:

   ```sh
   bun scripts/selfcheck.ts
   ```

   It verifies the config loads, the project type-checks, and the unit tests
   pass. Fix anything it reports before starting the loop.

3. **Start the loop and keep it resident.** The Superintendent/Engineer loop is
   driven by pi; launch it so it keeps ticking:

   ```sh
   empress run                       # stays resident, ticks on loop_interval
   # or a single supervised pass:
   empress run --once
   ```

   Inside pi you can also run a pass by hand with `/empress` (needs the extension:
   `pi install /path/to/EMPRESS`). For long unattended runs, put `empress run`
   under systemd (user service) or tmux.

4. **Opt into GitHub (optional).** EMPRESS is **local-only by default** — it never
   pushes or opens a PR until you opt in:

   ```toml
   [github]
   enabled = true
   owner = ""                # optional — resolved from `origin` or `gh repo view`
   repo = ""
   ```

   With `[github] enabled = true`, landing a task pushes its branch to `origin`
   and opens a PR into `base_branch`. You need the `gh` CLI installed and
   authenticated, plus an `origin` remote (or explicit `owner`/`repo`). Tasks
   then live as GitHub issues; run `empress sync` once to migrate existing local
   tasks into issues (see [GitHub-managed issues](#github-managed-issues) below).

See **[docs/architecture.md](docs/architecture.md)** for how the loop fits
together (Superintendent, Engineers, Jev judgments, risk gates).

## 4. Create a task and run it

```sh
empress task "Add a sign-in flow" --acceptance "tests pass" --purpose "handle login"
empress list                          # see open tasks
empress run --once                    # run a single Superintendent pass (supervised)
# or leave it running unattended:
empress run                           # tick loop, spawns Engineers on demand
```

Inside pi, you can also run a pass by hand with `/empress` (needs the extension:
`pi install /path/to/EMPRESS`).

Once running, EMPRESS automatically: picks up open tasks → judges readiness (Jev)
→ creates a git worktree → spawns a parallel pi Engineer per task → runs the
project's test command → evaluates risk (heuristics + Jev) → lands safe branches
into `base_branch` → records lessons. **HIGH-risk changes are left for a human**
with a review comment, never auto-merged.

> **No tasks?** With an empty queue, a pass is an **idle pass** — it verifies
> tool resolution, sees 0 tasks, and ends. That's normal; it re-checks each tick.

## 5. Operations

```
empress init [flags]               Scaffold .empress config + role prompts
empress task "<title>" [flags]     Create a task
empress list [--all]               List open tasks
empress sync                      Migrate open local tasks to GitHub issues ([github] enabled)
empress run [--once] [--model M]   Event-driven loop / single pass
empress pause | resume | quit | status   Control autonomous operation
empress doctor                     Check prerequisites
empress version                    Print version

Supported flags:
- `empress task "<title>" --purpose "…" --scope "…" --acceptance "…" --nongoal "…"` (set the task's Purpose / Scope / Acceptance Criteria / Non-Goals) and `--remove <id>` (delete a task).
- `empress run --thinking <level>` (reasoning effort) in addition to `--once` / `--model M`. The wake cadence comes from `[run] wake_interval`.
- `empress init` mirrors the interactive prompts as flags: `--base_branch` `--test_command` `--max_engineers` `--loop_interval` `--language` (non-interactive when all are provided).
```

Long unattended runs: put `empress run` under systemd (user service) or tmux.

**Releases.** Cutting a release (merge `develop` → `main`, tag, GitHub Release) is
a **manual** procedure — see **[`docs/release.md`](docs/release.md)**. It is not
automated.

**Cost model.** `empress run` is event-driven, cheapest-first: a zero-LLM fs
poll (60s) wakes only when the task queue changes; a preflight readiness check
(deterministic + ONE Jev batch call) spawns the LLM only when a task is actually
ready; an idle self-audit LLM runs on `[run] audit_interval` (3600s, 0 = off)
and files findings as tasks. An idle queue costs ~zero. Stalled passes recover
fast: a pass whose pi child is alive but silent for `[run] pass_stall_seconds`
(300s, default) is killed, and `[run] pass_timeout` (600s, default) caps any
pass that keeps talking; both are configurable.

## How it works

```
empress run (Node driver, event-driven: fs-wake + Jev preflight + idle audit)
   └─ spawn  pi -p -e empress.ts --append-system-prompt superintendent.md
          Superintendent (coordinator) uses empress_* tools:
            list / readiness / assign / create_worktree / spawn_engineers
            check_ci / evaluate_risk / land_task / lessons / notify
          └─ spawn Engineers (pi subagents) in each worktree
```

- **Superintendent** coordinates only — it never edits code; it verifies the
  mapping (task → design doc → tests → implementation) and minimality.
- **Engineers** work in isolated worktrees against the task's Purpose / Scope /
  Acceptance Criteria / Non-Goals, run tests, commit.
- **Judgments** (readiness, risk, lessons) hit Jev via a native HTTPS request
  (`noul`/`choice`/`score`), falling back to rules when `TYPESAFE_API_KEY` is
  unset.

## Development conventions (baked in)

Engineers follow three rules (`.empress/agents/coding-guidelines.md` +
`coding-guidelines-ponytail.md` + `coding-guidelines-security.md`):

- **Pure Function Testing / Command Verification** — tests are verification
  arithmetic (spec-derived, not implementation-tracing), tests come first,
  non-trivial work gets a design doc before tests.
- **Ponytail** — the laziest solution that works (YAGNI, stdlib-first); deliberate
  shortcuts carry a `ponytail:` comment harvested by `empress_ponytail_debt`.
- **Security** — the boundary that is never lazied away (trust-boundary
  validation, secrets, auth/authz, injection, dependency CVEs). The
  Superintendent runs a security pass (`empress_vuln_check` first, then a diff
  review with `auth`/`authz`/`injection`/`secrets`/… tags) before every landing;
  HIGH or trust-boundary findings hold the merge for a human.

**Cheap review triage.** Before the deep review, `empress_triage_review` runs
free deterministic scans (secrets/dangerous patterns, code-without-tests) plus
— *only when Jev is available* — a single cheap Jev `noul` question. If
`signal: ok` (no hits + low-risk, clear Jev verdict) and the change is
LOW/MEDIUM and not trust-boundary/control-plane, the pass fast-paths; anything
else (deterministic hit, degraded, Jev error, HIGH) gets the full LLM review.

## Project layout

```
.empress/
├── empress.toml              # config — COMMIT these (share with the team)
├── agents/                   # role prompts (superintendent.md, engineer.md, …)
├── tasks/NNNN-title.md       # task queue — RUNTIME (git-ignored, created via `empress task`)
├── superintendent-state.json # loop status/cadence — RUNTIME (git-ignored)
├── lessons.md                # learned lessons — RUNTIME (git-ignored)
├── ponytail-debt.md          # simplicity-debt ledger — RUNTIME (git-ignored)
└── worktrees/                # git worktrees — RUNTIME (git-ignored)
```

## Configuration (`empress.toml`)

`empress init` writes `.empress/empress.toml` with sane defaults. Two optional
sections let you pin models per role and opt into GitHub:

```toml
# Per-role model overrides. Empty = pi's default model (whatever your pi
# session runs with). Set a model id/pattern to pin a role to a specific model.
# Example: superintendent = "anthropic/claude-sonnet-4-5"
[models]
superintendent = ""   # coordinator pass (empress run) — CLI --model still wins
engineer = ""         # spawned Engineer subagents

# GitHub integration via the gh CLI. OFF by default: EMPRESS is local-only
# (never pushes, never opens PRs) unless you opt in here.
[github]
enabled = false
owner = ""            # optional — resolved from origin remote or `gh repo view`
repo = ""
```

When `[github] enabled = true`, landing a task pushes its branch to `origin`
and opens a PR against `base_branch` (best-effort; local merge still happens if
the PR step fails). You must have the `gh` CLI installed and authenticated, and
the repo needs an `origin` remote (or explicit `owner`/`repo`).

### GitHub-managed issues

With `[github] enabled = true`, tasks are stored as **GitHub issues** (backed by
the `gh` CLI) instead of local `.empress/tasks/*.md` files. In this mode:

- **`empress task "…"`** creates a GitHub issue (task id = issue number).
- **`empress list`** lists the repo's open issues as tasks.
- **`empress sync`** migrates open **local** tasks (created while GitHub was
  disabled) into GitHub issues — a one-way bootstrap from local files to
  issues, not a live sync. Run it once after enabling `[github]`.

Status and labels map to issue state/labels (see
`docs/decisions/task-18-gh-issue-taskstore.md`). If gh is unavailable or the
repo can't be resolved, EMPRESS silently falls back to the local task store so
it keeps running offline.

## Troubleshooting

- **`empress doctor` shows ⚠ for TYPESAFE_API_KEY** — unset. Jev judgments are
  disabled and it falls back to deterministic rules (optional).
- **`empress run` sits idle** — with an empty or not-ready queue it logs
  `skip (zero LLM)` and costs ~nothing; create a task with `empress task`.
- **A refactor of the harness itself is always HIGH** — control-plane paths
  (`high_paths` in `empress.toml`) are never auto-merged, by design. Approve and
  land manually (`git merge --no-ff <branch>`).

## License

MIT

[pi]: https://pi.dev