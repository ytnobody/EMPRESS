# Mutation-testing + Jev gate (`empress_check_mutation`)

## Context
Meaningless/tautological tests (e.g. `item.quantity = 123; assert(item.quantity === 123)`)
pass green and get 100% coverage while verifying nothing. Code review / AI review
are opportunistic; deterministic detection is needed. The proved combination
(POC in this repo: real function 100% score, tautology 0% score, Jev noul 0.94)
is:

- **Mutation testing** (deterministic): mutate a changed source file, run its
  test, and see if the test kills (fails on) the mutant. A test that survives
  every behavior-changing mutant is weak/meaningless.
- **Jev** (cheap System One): classify each surviving mutant as *equivalent
  (benign)* vs *genuine gap / weak test*, so equivalent-mutant noise is tolerated
  while real gaps gate the landing.

## Shape
- **`src/domain/mutation.ts`** — pure, bun-native (Stryker has no bun-test plugin):
  - `collectMutants(source, maxMutants?)` — small safe text mutations
    (relational/equality flips both directions, `&&↔||`, `==↔===` strictness,
    `==↔!=`, `+↔-`, `null↔undefined`, `Math.min↔Math.max`, `true↔false`,
    numeric-literal bump). Token-aware swap: composite operators (`===`, `++`,
    `+=`, `>=`, `&&=`) are never split; word tokens match at word boundaries.
    The cap comes from `[mutation] max_mutants`. Applied to *behavior-bearing
    source*, not tests.
  - `findTests(cwd)` — map each `src/*.ts` -> its `test/*.test.mjs` via import-scan.
  - `mutationTargets(...)` — changed `src/*.ts` that have tests, bounded.
  - `runMutations({cwd, relSrc, test, _run, maxMutants})` — mutate-in-place with
    try/finally restore (so the real file is always restored), run `bun test
    <test>`, count killed vs survivors.
  - `runMutationGate(cwd, changed, opts)` — shared orchestration (changed
    files → mutation → survivor classification → verdict) used by BOTH the tool
    and the optional CI job, so the two gates can never drift.
- **`src/extension/empress.ts`** — `empress_check_mutation({id})` tool (like
  `empress_vuln_check`): changed files of the task branch → mutation → Jev-classify
  survivors → verdict.
- **`src/shared/config.ts` + `empress.toml`** — `[mutation] enabled / min_score
  / scope / max_files / max_mutants` (max_mutants wired into the mutant cap).
- **`.github/workflows/mutation.yml` + `scripts/mutation-gate.ts`** — optional CI
  mirror of the gate: changed-branch scope, capped (`--max-files 1
  --max-mutants 12`), reports score + survivors + Jev genuine-gap count. Delete the
  workflow file (or `enabled=false`) to turn it off.
- **Fallback**: Jev unavailable (no TYPESAFE_API_KEY) → use `min_score` threshold
  + existing LLM review.

## Gate semantics (review + land)
- Default **disabled** until validated on real tasks.
- When enabled: survivors classified as *genuine gap* by Jev (or, without Jev, a
  score below `min_score`) → hold the landing for review (same meaning as the
  risk/triage hold), never force-past.
- Equivalent mutants are ignored (not a hard failure on a single survivor).

## Tests
`test/mutation.test.mjs`: `collectMutants` produces behavior variants; `findTests`
maps src→test; `runMutations` kill/survivor accounting with an injected `_run`;
Jev survivor classification mapping; config defaults. `bun scripts/selfcheck.ts`
must pass.

## Risks / notes
- **Performance**: mutation = N×`bun test` — scoped to changed+test-covered files,
  capped; only on review/land, not every wake.
- In-place mutate uses try/finally restore; runs synchronously in a review tool
  (default-off until validated).
- Shallow mutation operators ⇒ catches the tautology/assignment/weak-test class;
  not full-spectrum (fine for the gate, not a formal proof).