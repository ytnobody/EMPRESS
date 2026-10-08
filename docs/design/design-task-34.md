# Task #34 — Language-aware output across the whole harness

## Behaviour spec
The harness's `detectLanguage` only feeds the clarify proposal / Q&A (task #17 fix).
Every other agent output — readiness comments on non-clarify paths, Superintendent
pass reports, audit reports, lessons, and Engineer task comments/reports — is
monolingual English prose regardless of the issue/repo language.

After this task, **all agent-authored output** (task comments, readiness hearings,
pass/audit reports, lessons, Engineer comments + final reports) is written in:

1. the **issue's detected language** when the issue text clearly matches one of
   `ja` / `zh` / `ko` (existing `detectLanguage`), else
2. the **`[project] language`** config (`[project] language` in empress.toml,
   default `en`) — this is the default for English issues, unrecognized-script
   ("unknown") issues, mixed/no-issue output like audit reports and lessons.

Deterministic tool strings (tool replies like "task not found", audit scan
findings, vuln reports) stay as-is. No translation backends, no rewriting of
already-landed history (Non-Goals).

## Decision rule (pure, over codes)
`resolveLang(detected, projectLang)`:

- `detected ∈ {ja, zh, ko}` → `detected`  (clear issue-language match, always wins)
- `detected === "en"` → `projectLang || "en"`  (the detector's "en" slot is
  ambiguous — genuinely English issue OR unrecognized script OR no issue at all —
  so the `[project] language` fills it as the default)

`projectLang` is `config.project.language` and is what a repo operator sets for
repo-wide prose (pass reports, lessons, audit reports).

## Interface shapes
- `resolveLang(detected: string, projectLang: string): string` — pure; lives in
  `src/domain/taskstore/shared.ts` next to `detectLanguage`, re-exported via
  `src/domain/taskstore.ts` and `src/domain/tasks.ts`.
- `PROPOSAL_L10N` (shared.ts) extended with `zh` and `ko` entries so
  `proposeSpec(t, lang)` drafts the clarify proposal in all four languages.
- `CLARIFY_FRAME: Record<string, { header; proposed; questions }>` (shared.ts) —
  per-language framing strings for the readiness hearing comment (en/ja/zh/ko,
  fallback en); consumed by `empress_readiness`.
- Prompt injection (thin shell, no logic):
  - `src/cli/run.ts` — one `langInstruction(config)` appended to the
    Superintendent run / clarify / audit messages (clarify keeps its per-issue
    `#id=lang` map; run/audit get the rule + `[project] language`).
  - `src/extension/tools/helpers.ts` `spawnEngineer` — append the resolved
    per-task language to the brief so Engineer comments + final report match.

## Accepted ambiguity (handoff `[ASSUMPTION]`)
- `detectLanguage` cannot distinguish a genuinely-English issue from an
  unknown-script issue (both return `"en"`); `[project] language` is the default
  for that slot. Consequence: an English issue in a project whose
  `[project] language` is non-en gets replies in the project language. A finer
  script-level detector (e.g. Cyrillic/Arabic → unknown) would fix this; not in
  scope today.
- zh/ko L10n strings are literal translations kept minimal; correctness of the
  translations is human-verifiable but not machine-checked.