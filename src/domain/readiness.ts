// Task readiness: deterministic guards (length, acceptance-criteria section) plus
// an optional Jev `noul` judgment on whether the task is implementable as written.
// Also hosts the proposal-first clarification planner + shell (Task #35): a not-ready
// task gets its draft spec + open questions posted on first detection (deduped).
import { jevOne, jevJudge, jevAvailable } from "./jev.ts";
import { getTask, addComment, updateTask, proposeSpec, detectLanguage, hasHumanReply, type Task } from "./tasks.ts";
import type { Config } from "../shared/config.ts";

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

/** Marker that identifies an EMPRESS clarification-proposal comment (the dedupe key). */
export const CLARIFY_PROPOSAL_MARKER = "empress:clarify-proposal";

/** A planned clarification-proposal side effect: post `comment` on task `taskId`. */
export interface ClarifyPlan {
  taskId: number;
  comment: string;
}

/** Input to the proposal planner: a not-ready task + the readiness reasons that flagged it. */
export interface ClarifyPlanCheck {
  task: Task;
  reasons: string[];
}

interface ProposalFrame {
  intro: string;
  proposed: string;
  openQuestions: string;
}

// Human-visible framing of the proposal comment, keyed by detected language. The
// template is pinned by docs/design/design-task-35.md (verbatim match with the pre-split
// empress_readiness output so already-posted proposals dedupe identically); the
// spec content itself comes from proposeSpec (taskstore/shared.ts).
const EN_FRAME: ProposalFrame = {
  intro: "**[empress]** This task looks under-specified. Here is a **draft spec I inferred from the title** — please **answer the open questions below** in a reply (or confirm / adjust):",
  proposed: "**Proposed:**",
  openQuestions: "**Open questions:**",
};
const PROPOSAL_FRAME: Record<string, ProposalFrame> = {
  en: EN_FRAME,
  ja: {
    intro: "**[empress]** このタスクは仕様が不足しています。タイトルから推測した**ドラフト仕様**です。以下の**未解決の質問**に**返信で回答**（または確認・修正）してください：",
    proposed: "**提案（ドラフト）:**",
    openQuestions: "**未解決の質問:**",
  },
};

/**
 * Pure: draft the full proposal comment for one not-ready task — marker + draft
 * spec (proposeSpec) + open questions + readiness reasons, in the issue's detected
 * language. Deterministic; one field per line, numbers for questions.
 */
function buildClarifyProposalComment(task: Task, reasons: string[]): string {
  const lang = detectLanguage(`${task.title || ""} ${task.body || ""}`);
  const frame = PROPOSAL_FRAME[lang] || EN_FRAME;
  const p = proposeSpec(task, lang);
  return [
    frame.intro,
    `<!--${CLARIFY_PROPOSAL_MARKER}-->`,
    "",
    frame.proposed,
    `- Purpose: ${p.purpose}`,
    `- Scope: ${p.scope}`,
    `- Acceptance Criteria: ${p.acceptance.map((a) => `[ ] ${a}`).join(" ")}`,
    `- Non-Goals: ${p.nongoals.join(", ")}`,
    "",
    frame.openQuestions,
    ...p.questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    `(reason: ${(reasons || []).join("; ")})`,
  ].join("\n");
}

/**
 * Pure (Command planning): for each not-ready task that has NOT already received a
 * proposal (no `empress:clarify-proposal` marker in its comments), plan one proposal
 * Command. Skipped tasks produce no Command — this dedupe is what guarantees a
 * proposal is never posted twice, whoever posted the first one. Empty input → [].
 */
export function planClarifyProposals(checks: ClarifyPlanCheck[]): ClarifyPlan[] {
  const plans: ClarifyPlan[] = [];
  for (const { task, reasons } of checks) {
    const hasProposal = (task.comments || []).some((c) => String(c.body || "").includes(CLARIFY_PROPOSAL_MARKER));
    if (hasProposal) continue;
    plans.push({ taskId: task.id, comment: buildClarifyProposalComment(task, reasons) });
  }
  return plans;
}

/**
 * Thin execution shell for the run driver: re-read each check's task fresh (the gh
 * list backend carries no comments, so dedupe + reply detection need the
 * authoritative record), execute the planned Commands verbatim (addComment + mark
 * needs_clarification/blocked — same as empress_readiness), and report which tasks
 * have a pending human reply: the driver's gate for spawning the clarify LLM pass.
 */
export function postClarifyProposals(cwd: string, checks: ClarifyPlanCheck[]): { posted: number; pendingReply: number[] } {
  let posted = 0;
  const pendingReply: number[] = [];
  for (const check of checks) {
    const fresh = getTask(cwd, check.task.id);
    if (!fresh) continue;
    for (const plan of planClarifyProposals([{ task: fresh, reasons: check.reasons }])) {
      addComment(cwd, plan.taskId, "empress", plan.comment);
      updateTask(cwd, plan.taskId, { needs_clarification: true, status: "blocked" });
      posted++;
    }
    if (hasHumanReply(fresh)) pendingReply.push(fresh.id);
  }
  return { posted, pendingReply };
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