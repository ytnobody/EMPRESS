// Held-task sign-off readiness (task #52).
//
// A held (implemented + reviewed, left for human sign-off) branch is
// sign-off-ready ONLY when it is CI-green AND conflict-free. A branch that
// regressed (CI red, or a merge conflict after the base advanced) is not
// ready-for-human — it becomes actionable-for-fix so the loop re-engages an
// Engineer to rebase / re-implement it, instead of looping in verify-and-hold.
// Pure decision logic; the driver feeds observed {ciGreen, conflictFree} and
// turns the decision into an Engineer pass (Command verification — the body
// never touches git or CI).

export interface HeldCheck {
  ciGreen: boolean;
  conflictFree: boolean;
}

export type HeldBlocker = "ci_red" | "conflict";

export interface HeldReadiness {
  /** true means the branch is sign-off-ready (leave for the human). */
  ready: boolean;
  /** every failing axis; empty when ready. */
  blockers: HeldBlocker[];
}

/** A held branch is sign-off-ready iff CI-green AND conflict-free. */
export function heldReady(h: HeldCheck): HeldReadiness {
  const blockers: HeldBlocker[] = [];
  if (!h.ciGreen) blockers.push("ci_red");
  if (!h.conflictFree) blockers.push("conflict");
  return { ready: blockers.length === 0, blockers };
}

export type HeldAction = "sign-off-hold" | "needs-fix";

/** What the loop should do about the held branch: real work or human sign-off. */
export function decideHeldAction(r: HeldReadiness): HeldAction {
  return r.ready ? "sign-off-hold" : "needs-fix";
}

/**
 * Group held tasks by their sign-off readiness so the driver can hand the
 * regressed (needs-fix) ids to the Superintendent for an Engineer pass.
 */
export function classifyHeldStatus(inputs: Array<{ id: number; ciGreen: boolean; conflictFree: boolean }>): {
  needsFix: number[];
  hold: number[];
} {
  const needsFix: number[] = [];
  const hold: number[] = [];
  for (const h of inputs) {
    (decideHeldAction(heldReady({ ciGreen: h.ciGreen, conflictFree: h.conflictFree })) === "needs-fix" ? needsFix : hold).push(h.id);
  }
  return { needsFix, hold };
}