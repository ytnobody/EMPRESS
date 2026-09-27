// Activity-based stall watchdog decision for runPass. Distinguishes a pass that
// is "slow but working" (its pi child is alive and keeps producing output) from
// one that is "stalled" (child alive yet silent for the whole window) — the 
// observed hang was a live child at ~0.9% CPU with no I/O.
//
// Decision is pure; the exec layer owns the timers and the SIGKILL.
export function shouldStallKill(opts: {
  childAlive: boolean;
  lastActivityAt: number;
  now: number;
  stallMs: number;
}): boolean {
  // A dead child is a completed/errored pass already resolved by `close`/`error`;
  // never kill it here.
  if (!opts.childAlive) return false;
  // Floor the window at 1ms so a zero/negative configured threshold can't
  // spuriously kill a just-spawned pass (elapsed 0) on the first check.
  const windowMs = Math.max(1, opts.stallMs);
  return opts.now - opts.lastActivityAt >= windowMs;
}