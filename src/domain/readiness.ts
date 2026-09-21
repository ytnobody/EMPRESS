// Task readiness: deterministic guards (length, acceptance-criteria section) plus
// an optional Jev `noul` judgment on whether the task is implementable as written.
import { jevOne, jevJudge, jevAvailable } from "./jev.ts";
import type { Config } from "../shared/config.ts";
import type { Task } from "./tasks.ts";

/** Options for the deterministic readiness guards. */
interface ReadinessOptions {
  use_jev?: boolean;
  min_body_length?: number;
  skip_acceptance_criteria_check?: boolean;
  jev_threshold?: number;
}

interface ReadinessResult {
  ready: boolean;
  reasons: string[];
  jev: { probability: number } | null;
  needs_clarification: boolean;
}

// Single source for the Jev-degradation marker: shared by checkReadyTasks (per-check
// reason) and runLoop's last_skip_reason so consecutive failures surface visibly.
export const JEV_DEGRADED_REASON = "Jev unavailable (error); deterministic-only";

/** Pure: consecutive Jev-failure bookkeeping. degraded => +1, recovered => reset to 0. */
export function nextJevFailures(degraded: boolean, consecutive?: number): number {
  return degraded ? (consecutive || 0) + 1 : 0;
}

function nonWhitespaceLen(s: string): number {
  return (s || "").replace(/\s/g, "").length;
}

function hasAcceptanceCriteria(body: string): boolean {
  const b = body || "";
  return /acceptance\s+criterion/i.test(b) || /受け入れ条件/i.test(b) || /## Acceptance Criteria/i.test(b) || /- \[[ xX]\]/.test(b);
}

/** Deterministic readiness decision for a task body. */
export function deterministicReadiness(task: Task, ready: ReadinessOptions): { ready: boolean; reasons: string[] } {
  const body = task.body || "";
  const reasons = [];
  let readyFlag = true;

  if (!body.trim()) {
    reasons.push("body is empty");
    readyFlag = false;
  }
  if (nonWhitespaceLen(body) < (ready.min_body_length ?? 40)) {
    reasons.push(`body too short (<${ready.min_body_length ?? 40} non-whitespace chars)`);
    readyFlag = false;
  }
  if (!ready.skip_acceptance_criteria_check && !hasAcceptanceCriteria(body)) {
    reasons.push("no acceptance-criteria section");
    readyFlag = false;
  }
  return { ready: readyFlag, reasons };
}

/**
 * Full readiness check: deterministic guards + optional Jev noul judgment.
 * Jev can only flip a *ready* task to needs-clarification when its confidence
 * that the task is ready is below the threshold — it never overrides a
 * deterministic failure (those always need a human).
 */
export async function checkReadiness(
  cwd: string,
  config: Config,
  task: Task
): Promise<ReadinessResult> {
  const ready = (config.readiness || {}) as ReadinessOptions;
  const det = deterministicReadiness(task, ready);
  const result: ReadinessResult = { ready: det.ready, reasons: [...det.reasons], jev: null, needs_clarification: !det.ready };

  if (det.ready && ready.use_jev && jevAvailable().available) {
    const j = await jevOne({
      type: "noul",
      instructions: "This task description is ready to be implemented by an autonomous engineer: it states a clear purpose, scope, and acceptance criteria.",
      state: task.body,
      model: (config.jev && config.jev.model) || "jev-latest",
    });
    if (j.ok && typeof j.value === "number") {
      result.jev = { probability: j.value };
      const threshold = ready.jev_threshold ?? 0.6;
      if (j.value < threshold) {
        result.ready = false;
        result.needs_clarification = true;
        result.reasons.push(`Jev confidence ${j.value.toFixed(2)} < ${threshold}`);
      }
    }
  }

  return result;
}

/**
 * Batch readiness: deterministic checks for ALL tasks, then ONE Jev batch call
 * for the deterministic-ready remainder. Used by the run driver's wake preflight
 * (LLM not spawned unless at least one task is ready). Jev count = 1 call for
 * the whole batch. `_jevJudge` and `_jevAvailable` are injectable so tests are
 * independent of the ambient TYPESAFE_API_KEY (a missing key silently degrades
 * to deterministic-only — which the container CI caught as a test bug).
 * @returns {Promise<Array<{task:object, ready:boolean, reasons:string[], jev:object|null}>>}
 */
export async function checkReadyTasks(
  cwd: string,
  config: Config,
  tasks: Task[],
  { _jevJudge, _jevAvailable }: { _jevJudge?: typeof jevJudge; _jevAvailable?: typeof jevAvailable } = {}
): Promise<{ task: Task; ready: boolean; reasons: string[]; jev: { probability: number } | null }[]> {
  const ready = (config.readiness || {}) as ReadinessOptions;
  const isJev = (typeof _jevAvailable === "function" ? _jevAvailable() : jevAvailable()).available;
  const useJev = ready.use_jev && isJev;
  const results: { task: Task; ready: boolean; reasons: string[]; jev: { probability: number } | null }[] = [];
  const needJev: { t: Task; det: { ready: boolean; reasons: string[] } }[] = [];

  for (const t of tasks) {
    const det = deterministicReadiness(t, ready);
    if (!det.ready) {
      results.push({ task: t, ready: false, reasons: det.reasons, jev: null });
      continue;
    }
    if (!useJev) {
      results.push({ task: t, ready: true, reasons: det.reasons, jev: null });
      continue;
    }
    needJev.push({ t, det });
  }

  if (needJev.length) {
    const judge = _jevJudge ?? jevJudge;
    const r = await judge({
      type: "noul",
      instructions: "This task description is ready to be implemented by an autonomous engineer: it states a clear purpose, scope, and acceptance criteria.",
      states: needJev.map((x) => x.t.body),
      model: (config.jev && config.jev.model) || "jev-latest",
    });
    needJev.forEach(({ t, det }, i) => {
      const raw = r.ok ? r.results[i]?.answer : null;
      const prob = raw && typeof raw.noul === "number" ? raw.noul : null;
      const threshold = ready.jev_threshold ?? 0.6;
      const pass = prob === null ? true : prob >= threshold; // Jev error is not fail-closed here (deterministic already said ready); LLM pass re-checks.
      // Jev batch error / unparseable (prob null) => deterministic-only, exactly like the
      // no-key case (ready stays true) but VISIBLE via JEV_DEGRADED_REASON (was silent).
      results.push(
        prob === null
          ? { task: t, ready: true, reasons: [...det.reasons, JEV_DEGRADED_REASON], jev: null }
          : {
              task: t,
              ready: pass,
              reasons: pass ? det.reasons : [...det.reasons, `Jev ${prob.toFixed(2)} < ${threshold}`],
              jev: { probability: prob },
            }
      );
    });
  }

  return results;
}