# Design — checkReadyTasks Jev-error fallback (task #7)

Scope: `src/domain/readiness.js` `checkReadyTasks` + `src/cli/run.js` `runLoop`
skip-reason plumbing only. No fail-closed preflight (Non-Goal); triage untouched.

## Behavior spec

1. A Jev **batch error** (or unparseable answer) makes the Jev probability
   `null`. Readiness must then behave **exactly like the no-key case**:
   deterministic checks only → ready iff deterministic-ready. This already holds;
   the bug is that it is **silent** (fail-open with no signal).
2. Make the degradation **visible**:
   - `checkReadyTasks` tags each Jev-degraded task's `reasons` with the constant
     `JEV_DEGRADED_REASON = "Jev unavailable (error); deterministic-only"`.
   - `runLoop` counts **consecutive** Jev-failure runs and logs the same reason
     via `last_skip_reason` (loop-state), so an operator can see sustained
     Jev-degradation without it stalling the queue.
3. Readiness parity with no-key is preserved: the marker changes only visibility,
   not the `ready`/`jev` decision (ready stays true for deterministic-ready).

## Interface shapes (verification arithmetic)

- `checkReadyTasks(cwd, config, tasks, {_jevJudge,_jevAvailable})` → `Array<Check>`,
  unchanged shape (`{task, ready, reasons, jev}`). Jev-affecting check:
  - `prob === null` → `{ ready:true, reasons:[...det.reasons, JEV_DEGRADED_REASON], jev:null }`
  - else → existing threshold decision (unchanged).
- `JEV_DEGRADED_REASON` exported constant (single source for check reasons + runLoop
  `last_skip_reason`).
- `nextJevFailures(degraded, consecutive)` pure ⇒ `degraded ? consecutive+1 : 0`.
- `runLoop` (imperative shell): after `checkReadyTasks`, if
  `checks.some(c => c.reasons.includes(JEV_DEGRADED_REASON))` or prior counter>0,
  patch loop state with `{ consecutive_jev_failures: nextJevFailures(...) }` and,
  when degraded, `last_skip_reason: JEV_DEGRADED_REASON`.

## Assumptions
- `[ASSUMPTION]` An unparseable-but-`ok` Jev answer (prob `null`) is treated with
  the same "Jev unavailable (error)" marker as a batch error, since both mean no
  usable probability and both degrade to deterministic-only. Triage (separate
  module) distinguishes them; readiness keeps it lazy with a single marker.