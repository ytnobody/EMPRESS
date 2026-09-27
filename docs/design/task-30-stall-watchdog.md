# task-30: Harness reliability — activity-based (stall) watchdog for passes

## Behavior spec

A `runPass` currently protects the loop with a single wall-clock cap
(`pass_timeout`, default 1800s). That catches an outright hang only after half an
hour. Real-world failure mode observed: the pi child stays a live process at
~0.9% CPU but stops producing any stdout/stderr — nothing I/O-wise marks it
"working", yet the loop waits for the whole wall-clock cap.

Add an **activity watchdog** alongside the wall-clock cap:

- A pass is **working** if it keeps producing stdout/stderr output.
- A pass is **stalled** if its pi child is **still alive** yet has produced
  **no output for `pass_stall_seconds`** (default 300).
- A stalled pass is SIGKILLed (recovering in minutes, well before
  `pass_timeout`), and the loop continues on the next wake.
- Distinction embedded in the decision: a **dead** child is never stalled — it is
  a completed/errored pass already resolved by `close`/`error`. A **live** child
  with output within the window is never stalled.
- `pass_timeout` remains the absolute wall-clock cap for slow-but-not-silent
  passes; its default is tightened to 600 so an always-talking pass also can't
  linger for 30 minutes.

## Interface map (verification-arithmetic unit)

Pure decision function `src/domain/stall.ts`:

```
shouldStallKill({ childAlive, lastActivityAt, now, stallMs }) -> boolean
```

- dead child (`childAlive=false`) → false (never kill a dead child).
- otherwise → `now - lastActivityAt >= max(1, stallMs)`.

`max(1, stallMs)` clamps a zero/negative configured window so a just-spawned
pass (elapsed 0) is never spuriously killed on the first check.

Config (`[run]` section, both configurable):

- `pass_stall_seconds` default `300` (activity threshold).
- `pass_timeout` default tightened `1800` → `600` (absolute cap).

Exec layer (`runPass` in `src/cli/run.ts`): a debounce timer armed at
`stallMs`, re-armed on every stdout/stderr data event; on fire it consults
`shouldStallKill` and SIGKILLs + resolves if stalled. The wall-clock timer stays.
No audit/clarify/land semantics or task-pickup logic changes.

## Non-goals

No change to audit/clarify/land semantics; no change to how queued tasks are
picked up; no CPU-percent or OS-level process accounting (I/O activity is the
signal).