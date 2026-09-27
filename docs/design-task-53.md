# Task #53 — Ready-task backlog self-propagation in the run driver

## Behaviour spec
The run driver gates a pass on `changed` (task-queue hash). When a ready batch
exceeds `max_engineers`, a Superintendent pass processes only a bounded subset and
the remainder stays READY, but the next tick sees no queue-hash change and sleeps —
stranding the batch until an external nudge (#32–#37). Fix: once ready work is
created, processing **self-propagates across ticks** while a ready backlog remains,
independent of `changed`, and an interleaved audit pass must not strand it. Must not
busy-spin when there is genuinely no ready work; the zero-LLM idle cost model is
unchanged (no Jev/LLM when nothing is ready).

## Decision rules (pure functions)

- `shouldRunReadyPass({ queueChanged, backlog, auditDue }): boolean` =
  `(queueChanged || backlog) && !auditDue`.
  - `backlog` = "a ready batch was processed on the last tick and may not have been
    fully consumed → reprocess this tick even with no queue change."
  - audit deferral: an audit-due tick runs the audit pass instead; it does **not**
    clear the backlog, so a later tick reprocesses.
- `backlogAfterPreflight(readyCount): boolean` = `readyCount > 0`. After a preflight,
  ready work to process keeps the self-propagating signal on; finding none clears it
  (termination — no busy-spin).

## Wiring (`src/cli/run.ts` runLoop)
- persist `let backlog = false`.
- per tick: `wantReady = shouldRunReadyPass({ queueChanged: changed, backlog, auditDue })`.
  - if `wantReady`: build `actionable`, run the Jev preflight, then set
    `backlog = backlogAfterPreflight(readyIds.length)`; run the ready pass when
    `readyIds.length > 0` (else the existing clarify/skip path).
  - the empty-`actionable` skip path also sets `backlog = false` (no ready work → stop).
  - the audit pass (`auditDue`) is unchanged and leaves `backlog` untouched.

## Termination / cost
A preflight that finds `readyCount === 0` sets `backlog = false`; with no queue change
and no audit due, `wantReady = false` → no Jev/LLM. When a genuine backlog exists,
preflight (Jev) runs because there is real ready work — not an idle cost.