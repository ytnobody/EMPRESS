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
  [Jev](https://typesafe.ai) (System One) via a **native HTTPS call** — with
  graceful fallback to rules if no `TYPESAFE_API_KEY` is set.

> **"pi is the star. EMPRESS is the toolbox for local + judgment operations."**

See **[DESIGN.md](DESIGN.md)** for the full architecture and the
HERMIT→EMPRESS mapping.

---

## 1. Prerequisites

| Tool | Required | Notes |
|---|---|---|
| **Node.js ≥ 18** | ✅ | runs the `empress` CLI |
| **pi** | ✅ | the harness brain (`pi -p`) |
| **git** | ✅ | worktrees / branches / merges |
| **TYPESAFE_API_KEY** | optional | enables Jev judgments (readiness/risk/lessons); unset = deterministic rules only |

## 2. Get the `empress` command runnable

The CLI is a single self-contained Node script — `node bin/empress.js`. Make it
callable as `empress` (pick **one**):

```sh
# A) Put the harness dir on PATH (recommended)
export PATH="/path/to/EMPRESS/bin:$PATH"      # add to ~/.bashrc / ~/.profile
alias empress="node /path/to/EMPRESS/bin/empress.js"

# B) Or symlink into a dir already on PATH
ln -s /path/to/EMPRESS/bin/empress.js ~/bin/empress

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
> image  = "node:22-alpine"
> network = "default"    # default | none | host
> ```
> The worktree is mounted read-write at `/project` and the test command runs in
> the container. If the engine is unavailable it falls back to the host.

> **After init**, the harness is just a config + role prompts. `agents/*` are
> per-project instructions like CLAUDE.md — edit them freely.

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
empress task "<title>" [flags]     Create a task
empress list [--all]               List tasks
empress run [--once] [--model M]   Superintendent tick loop / single pass
empress pause | resume | quit | status   Control autonomous operation
empress doctor                     Check prerequisites
empress version                    Print version
```

Long unattended runs: put `empress run` under systemd (user service) or tmux.

## How it works

```
empress run (Node driver, tick loop)
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

## Troubleshooting

- **`empress doctor` shows ⚠ for TYPESAFE_API_KEY** — unset. Jev judgments are
  disabled and it falls back to deterministic rules (optional).
- **`empress run` prints "Idle pass"** — no open tasks; create one with
  `empress task`.
- **A refactor of the harness itself is always HIGH** — control-plane paths
  (`high_paths` in `empress.toml`) are never auto-merged, by design. Approve and
  land manually (`git merge --no-ff <branch>`).

## License

MIT

[pi]: https://pi.dev