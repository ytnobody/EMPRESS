// Task readiness: deterministic guards (length, acceptance-criteria section) plus
// an optional Jev `noul` judgment on whether the task is implementable as written.
import { jevOne, jevAvailable } from "./jev.js";

function nonWhitespaceLen(s) {
  return (s || "").replace(/\s/g, "").length;
}

function hasAcceptanceCriteria(body) {
  const b = body || "";
  return /acceptance\s+criterion/i.test(b) || /受け入れ条件/i.test(b) || /## Acceptance Criteria/i.test(b) || /- \[[ xX]\]/.test(b);
}

/** Deterministic readiness decision for a task body. */
export function deterministicReadiness(task, ready) {
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
export async function checkReadiness(cwd, config, task) {
  const ready = config.readiness || {};
  const det = deterministicReadiness(task, ready);
  const result = { ready: det.ready, reasons: [...det.reasons], jev: null, needs_clarification: !det.ready };

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