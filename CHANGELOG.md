# Changelog

All notable changes to EMPRESS are documented here.

## [0.2.0] - 2026-09-28

### Added
- **GitHub-issue task store (`GhTaskStore`)** — with `[github] enabled=true`, tasks
  are managed as GitHub issues (create/list/get/update/close/comments); local
  `.empress/tasks/*.md` remains the offline baseline. `empress sync` migrates
  local tasks.
- **Proposal-based clarification Q&A** — thin / title-only issues get a draft spec
  + open questions in the issue's language; the Superintendent drives the Q&A via
  comments and rewrites the issue body once resolved (`empress_apply_clarification`).
- **Language-aware output** — issue-bound output matches the detected issue language
  (ja/zh/ko/en); repo-wide output uses `[project] language`.
- **Mutation-testing + Jev weak-test gate** (`empress_check_mutation` + CI
  `mutation.yml`) — deterministic weak/tautological test detection on changed code;
  survivors classified by Jev (equivalent vs genuine gap). A fixed decision rule no
  longer false-holds low scores whose survivors are Jev-confirmed equivalent.
- **Resilience / self-healing loop**:
  - inactivity watchdog for stalled passes (`[run] pass_timeout` / activity),
  - LLM-free driver heals: ready-backlog continuation (#53), held-task conflict
    detection + escalation (#52), targeted FIX pass for regressed held tasks (R1-R4).
- **Repo-tree hygiene gate** — `git ls-files -c -i` check in `empress doctor` and CI
  (no committed gitignored runtime artifacts / symlinks).
- Disambiguate issue vs PR numbers (`taskRef`), near-match title dedupe for
  auto-filed tasks, robust agent-vs-human comment detection, proposal-first
  immediate response, empress task flag-parsing fix, per-tool extension split
  (`src/extension/tools/`).

### Fixed
- gh mode wake detection (`tasksHash`), podman CI git-missing skip, deps-mount
  self-poisoning, committed `node_modules` symlink + gitignore, stale-branch
  auto-prune.
- 100% test suite green (selfcheck) across 21 test files.

## [0.1.0] - Initial release

- Local-first task harness on pi: Superintendent/Engineer loop, local git merges,
  readiness/risk/lessons via Jev, entropy-aware audit, GitHub Actions CI.