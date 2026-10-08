# Design doc — install-in-sync gate (task #81)

## Problem

`empress init` copies bundled role prompts (`src/agents/*`) into `.empress/agents/*`
and the pi prompt (`src/prompts/empress.md`) into `.pi/prompts/empress.md`.
Those installed copies are committed in this repo and have drifted:
`.empress/agents/superintendent.md` lacks the task-37 near-match dedupe text and
`.pi/prompts/empress.md` lacks the task-34 output-language paragraph that the
`src/` sources carry. Nothing detects the drift, so the runtime silently runs
stale instructions.

## Behavior spec (Level 1)

Deterministic, LLM-free check: for each of the two install pairs, every regular
file under the source dir must exist in the installed dir with byte-identical
content. A missing or byte-differing file is drift. In-sync → no findings.

Pairs (same dirs/constants the installer uses, `src/cli/init.ts`):

| label   | source (AGENTS_SRC / PROMPTS_SRC) | installed                     |
| ------- | --------------------------------- | ----------------------------- |
| agents  | `src/agents`                      | `<root>/.empress/agents`      |
| prompts | `src/prompts`                     | `<root>/.pi/prompts`          |

Scope: only these two role/prompt dirs. The gitignored `.empress` runtime state
(tasks/, worktrees/, superintendent-state.json, lessons.md, …) is never scanned.

## Interface

New `src/domain/install.ts`:

- `compareInstall(src: Map<string, Buffer>, installed: Map<string, Buffer>, label): string[]`
  — **pure**; one drift line per missing/differing source file.
- `installDrift(pairs: InstallPair[]): string[]` — thin shell; reads each dir and
  delegates to `compareInstall`.
- `installReport(drift: string[]): string` — human summary ("" when clean).

`src/cli/init.ts` exports the existing `AGENTS_SRC` / `PROMPTS_SRC` constants
(no behavior change to `copyAgents` / `wirePrompts`).

Surfaced in `scripts/selfcheck.ts` (a failing step) and `empress doctor`
(a `role prompts in sync` check), mirroring the task-54 tree-hygiene indicator.

## Verification arithmetic

- Equal source/installed bytes → `compareInstall` returns `[]`.
- Byte-differing installed file → one `stale installed "<name>"` line.
- Absent installed file → one `missing installed "<name>"` line.
- `installDrift` over a tmp tree: an in-sync pair contributes nothing; a stale
  pair contributes exactly the differing file.
- The real repo passes `bun scripts/selfcheck.ts` after the two stale copies are
  refreshed from `src/`.

## Non-goals

- No change to install/copy behavior, no new framework, no extra dependency.
- No check of the wider `.empress` runtime state.
