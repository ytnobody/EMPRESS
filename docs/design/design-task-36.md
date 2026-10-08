# Task #36 — Mutation gate into CI + expand mutant operators

## Behaviour spec
The mutation+Jev weak-test gate (`empress_check_mutation`, task #19) is the
canonical gate, but it only runs in the Superintendent review pass and its
operator set is shallow (relational flip + `&&↔||` + `true↔false` + numeric
bump on the current source only covers the tautology/assignment class). This
task:

1. **Expands the mutant operator set** so the gate detects a wider class of
   weak tests. New operators must be *behavior-bearing* (not no-ops) and
   *composite-token-safe*: mutants are written over the real file transiently
   inside try/finally-restored runs, and a mutant that breaks compilation counts
   as "killed", so swapping must never split composite operators (`==` inside
   `===`, `++`, `+=`, `>=`, `&&=`, …) into broken-token junk.
2. **Surfaces the gate in GitHub Actions**: an optional, capped CI job over the
   changed-branch diff, with a report that includes **score + survivors + Jev
   genuine-gap count**. `empress_check_mutation` stays canonical; the CI script
   reuses the same domain orchestration.
3. **Wires the existing but dead `[mutation] max_mutants` config** into the
   mutant cap (today `collectMutants` hard-caps at 60 and the config is ignored).

Non-goals: `[mutation]` default stays opt-in (`enabled=false`); no full-suite
mutation (changed-code scope only); no new dependencies.

## Decision rules

### Operator table (`collectMutants`)
Swap is token-aware: an occurrence of `a` is replaced by `b` only when it is not
adjacent to an operator character (`= ! < > + - & | * %`), and word tokens
(`true`, `false`, `null`, `undefined`, `Math.min`, `Math.max`) match only at
word boundaries. Each pair yields one mutant over the whole source. Pairs:

| `a` → `b` | class | status |
|---|---|---|
| `===`↔`!==` | equality negate | existing |
| `<=`→`>`, `<`→`>=` | relational flip | existing |
| `&&`→`||` | logical | existing |
| `true`↔`false` | boolean literal | existing |
| `>`→`<`, `>=`→`<=` | relational flip (other direction) | new |
| `||`→`&&` | logical (reverse) | new |
| `===`→`==`, `==`→`===` | strictness change | new |
| `==`→`!=`, `!=`→`==` | loose equality negate | new |
| `+`→`-`, `-`→`+` | arithmetic | new |
| `null`→`undefined`, `undefined`→`null` | null-ish interchange | new |
| `Math.min`→`Math.max`, `Math.max`→`Math.min` | method swap | new |

Tokens located inside `//` line or `/*` block comments are never mutated
(behavior-neutral noise that would otherwise pollute the score); the scan is
conservative (a stray `//` inside a string literal over-skips, which only
removes a mutant, never invalidates one).

Known accepted noise (unchanged from existing design): generic-token `<`/`>`
matches (`Array<number>`) can produce a compile-broken mutant, which counts as
killed (conservative direction) and is transient (restored in `finally`).

### Gate verdict
Identical to `empress_check_mutation`: fail when a target has `score < min_score`
or Jev flags ≥1 survivor as a *genuine gap* (`noul ≥ 0.7`); else pass. Without
Jev (no `TYPESAFE_API_KEY`), survivors are reported `unclassified (no Jev)` and
only `min_score` gates.

## Interface shapes
- `collectMutants(source: string, maxMutants?: number): Mutant[]` — cap moves
  from a hard-coded 60 to the parameter (default 60).
- `MutationOptions = { _run?; maxMutants? }`; `runMutations(...)` unchanged shape.
- **NEW** `runMutationGate(cwd, changed: string[], opts): Promise<MutationGateResult>`
  — shared orchestration used by both the tool and the CI script:
  - `MutationGateOptions = { minScore, maxFiles, maxMutants, jevModel?, run?, classify? }`
    (`run` injectable test runner; `classify` injectable survivor classifier,
    default = Jev noul with the same prompt as today's tool).
  - `MutationGateResult = { reports, survivors: {file,id}[], lowFiles, genuine,
    jevNote, score, ok }` — `score` = mean of per-file scores (a file with no
    mutants scores 1), `ok` = `lowFiles.length===0 && genuine===0`.
- **NEW** `scripts/mutation-gate.ts` (bun executable): base resolves as
  `--base <ref>` | `GITHUB_BASE_REF` (`origin/<ref>`) | `origin/<config
  base_branch>`; changed = `git diff <base>...HEAD`; prints the
  score/survivors/jev report; exit 0 pass / 1 hold; prints `DISABLED` and exits
  0 when `[mutation] enabled=false` (keeps the gate opt-in even in CI).
- **NEW** `.github/workflows/mutation.yml` — optional job (delete the file to
  disable), fetch-depth 0 checkout, `bun scripts/mutation-gate.ts` capped at
  `--max-files 1 --max-mutants 12` for bounded CI runtime; optionally passes
  `TYPESAFE_API_KEY` secret to enable Jev classification.
- `swapToken` / `bumpNumeric` — comment-aware via `inComment(source, index)`
  (pure scan helper).

## Wiring
- `src/domain/mutation.ts` — token-aware `swapToken` helper, expanded pairs,
  `maxMutants` cap, `runMutationGate` + default Jev classify.
- `src/extension/tools/checkMutation.ts` — thin shell over `runMutationGate`;
  reply JSON keys unchanged (`ok, score, low_score_files, survivors,
  genuine_gaps, jev, files`).
- `docs/decisions/task-19-mutation-jev-gate.md` — operator list + CI job noted.

## Tests
`test/mutation.test.mjs`, extended:
- each new operator class yields a mutant on a crafted source (ids present);
- composite tokens are never split (`====`, `!===`→`!=`+`==`, `i++`, `+=`, `>=`
  intact) while standalone forms still mutate;
- comment-located tokens produce no mutants (code tokens still do);
- `runMutationGate` verdicts with injected `run`/`classify` (kill-all → pass;
  survive-all + genuine → hold);
- `runMutations` honors `maxMutants`. `bun scripts/selfcheck.ts` must pass.