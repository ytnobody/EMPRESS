---
id: 1
title: "Split state.js loop-state helpers into a tiny pure module"
status: "open"
assignee: ""
labels: []
needs_clarification: false
branch: ""
created: "2026-09-21T08:00:37.369Z"
comments: []
---

# Split state.js loop-state helpers into a tiny pure module

## Purpose
prepare dogfooding: first refactor of EMPRESS on EMPRESS

## Scope
_to be filled_

## Acceptance Criteria
- [ ] state read/write stay byte-identical; behavior-preserving refactor must not change callers

## Non-Goals
- _none yet_

---
> **Engineer note:** follow the two project conventions — Pure Function Testing / Command Verification (`read .empress/agents/coding-guidelines.md`) for *what you verify*, and Ponytail (`read .empress/agents/coding-guidelines-ponytail.md`) for *what you build* (laziest solution that works, YAGNI, stdlib-first; mark deliberate shortcuts `ponytail:` with a ceiling + upgrade path). For non-trivial work, write a minimal design doc (behavior + Command/interface spec) first, then tests, then implementation. If a requirement is ambiguous, mark it `[ASSUMPTION]` and add it to your handoff list instead of silently deciding (§10).
