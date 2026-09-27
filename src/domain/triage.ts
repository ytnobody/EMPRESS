// Review triage — decide whether a diff needs LLM review or can be fast-pathed.
//
// Layered, cheapest-first (see docs/architecture.md §7.2):
//   L1 deterministic (free): secret/dangerous pattern scan + convention signals
//                            (code changed without tests => PFT §9 suspicion)
//   L2 Jev (only when TYPESAFE_API_KEY is set): ONE noul call — "does this
//      change warrant human review?" Low-confidence / "yes" => escalate.
//   L3 LLM (Superintendent): escalated targets get the full deep review.
//
// Safety rules baked in:
//   * Jev unavailable/error => signal "review" (preserves today's full-review
//     behavior exactly; never bypasses).
//   * Deterministic hits always escalate, regardless of what Jev says.
//   * HIGH/trust-boundary/control-plane exclusions remain the Superintendent's
//     job — triage "ok" never overrides them.
//
// PFT: scanning and decision logic are pure; only the Jev call and diff fetch
// are injectable so tests need no network.

import { diffBetween, diffPatch } from "./git.ts";
import { jevJudge, jevAvailable } from "./jev.ts";
import type { Config } from "../shared/config.ts";
import type { Task } from "./tasks.ts";

export const SECRET_PATTERNS = [
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "inline-credential", re: /(?:api[_-]?key|password|passwd|secret|token|access[_-]?key)\s*[:=]\s*["'][^"'\s]{8,}["']/i },
];

export const DANGEROUS_PATTERNS = [
  { name: "eval", re: /\beval\s*\(/ },
  { name: "shell-exec", re: /\b(child_process|execSync|spawnSync|\.exec\(|\.spawn\()/ },
  { name: "sql-concat", re: /(["'`]|\)\s*\+)\s*(SELECT|INSERT|UPDATE|DELETE)\s/i },
  // Group the alternation under the call posture: bare words input/req/body/
  // request in comments/strings must not fire — only a deserialization call
  // reading untrusted input (ungrouped-alternation FP, lessons #94/#97).
  { name: "deserialization", re: /\b(?:deserialize|unserialize|pickle\.loads|JSON\.parse)\s*\(\s*[^"'"`]*(?:request|req|body|input)/i },
  { name: "cors-wildcard", re: /Access-Control-Allow-Origin\s*[:=]\s*\*/i },
  // injection: SSRF to internal/private hosts (incl. cloud metadata 169.254.169.254)
  { name: "ssrf-internal-host", re: /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|169\.254\.169\.254|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])/i },
  // injection: XXE — DOCTYPE with internal subset / SYSTEM / PUBLIC, or ENTITY decl
  { name: "xxe", re: /<!(?:ENTITY\s|DOCTYPE[^>]*(?:\[|SYSTEM|PUBLIC))/i },
  // injection: shell command built from interpolated input via `sh -c ...${...}`
  // ponytail: regex heuristic (no taint tracking), upgrade to semantic/taint analysis if FP/FN matter
  { name: "sh-c-injection", re: /\b(?:sh|bash|zsh)\s+-c\b[^\n]*\$\{/ },
];

interface DiffScan { secrets: string[]; dangerous: string[] }
interface ConvSignals { testsChanged: boolean; codeWithoutTests: boolean }
type TriageSignal = "ok" | "review";

/**
 * Pure: scan diff text for secret / dangerous patterns.
 * @returns {{secrets:string[], dangerous:string[]}}
 */
export function scanDiff(patchText: string): DiffScan {
  const text = String(patchText || "");
  const secrets: string[] = [];
  const dangerous: string[] = [];
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) secrets.push(p.name);
  for (const p of DANGEROUS_PATTERNS) if (p.re.test(text)) dangerous.push(p.name);
  return { secrets, dangerous };
}

/** Pure: convention signals from the changed-file list. */
export function conventionSignals(changedFiles: string[]): ConvSignals {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const isTest = (f: string) => /(^|[/\\])(test|tests|__tests__)([/\\]|$)|\.(test|spec)\.[a-z0-9]+$/i.test(f) || /_test\./i.test(f);
  const tests = files.filter(isTest);
  const code = files.filter((f) => !isTest(f) && /\.(js|ts|jsx|tsx|go|py|rb|rs|java|c|cpp|sh|pl|php|swift)$/.test(f || ""));
  return {
    testsChanged: tests.length > 0,
    codeWithoutTests: code.length > 0 && tests.length === 0,
  };
}

/** Build the Jev state for the one-question noul call. */
export function buildTriageState({ taskTitle, diffSummary }: { taskTitle: string; diffSummary: string }): string {
  return `task: ${taskTitle}\n\n${String(diffSummary || "").slice(0, 4000)}`;
}

/**
 * Pure: decide the review signal.
 * @returns {{signal: TriageSignal, reasons:string[], degraded:boolean}}
 */
export function decideTriage({ deterministic, conv, jevNoul, jevError = false, threshold = 0.5 }: { deterministic?: DiffScan; conv?: ConvSignals; jevNoul: number | null; jevError?: boolean; threshold?: number }): { signal: TriageSignal; reasons: string[]; degraded: boolean } {
  const reasons = [];
  if (deterministic?.secrets?.length) {
    reasons.push(`deterministic: secrets ${deterministic.secrets.join(", ")}`);
    return { signal: "review", reasons, degraded: false };
  }
  if (deterministic?.dangerous?.length) {
    reasons.push(`deterministic: dangerous ${deterministic.dangerous.join(", ")}`);
    return { signal: "review", reasons, degraded: false };
  }
  if (conv?.codeWithoutTests) {
    reasons.push("convention: code changed without tests (check PFT §9)");
    return { signal: "review", reasons, degraded: false };
  }
  if (jevNoul === null) {
    reasons.push("Jev tier unavailable (no TYPESAFE_API_KEY) — preserving full review");
    return { signal: "review", reasons, degraded: true };
  }
  if (jevError) {
    reasons.push("Jev tier errored — escalating to LLM review");
    return { signal: "review", reasons, degraded: false };
  }
  if (jevNoul > threshold) {
    reasons.push(`Jev: warrants human review (${jevNoul.toFixed(2)} > ${threshold})`);
    return { signal: "review", reasons, degraded: false };
  }
  reasons.push(`Jev: low risk (${jevNoul.toFixed(2)} ≤ ${threshold}), deterministic clean — fast path ok`);
  return { signal: "ok", reasons, degraded: false };
}

/**
 * Run the full triage for a task branch.
 */
export async function runTriage(
  cwd: string,
  config: Config,
  task: Task,
  opts: { _diffPatch?: typeof diffPatch; _diffBetween?: typeof diffBetween; _jevJudge?: typeof jevJudge; forceJev?: boolean; apiKey?: string; threshold?: number } = {}
): Promise<{ signal: TriageSignal; reasons: string[]; degraded: boolean; deterministic: DiffScan; conv: ConvSignals; jevNoul: number | null }> {
  const _diffPatch = opts._diffPatch ?? diffPatch;
  const _diffBetween = opts._diffBetween ?? diffBetween;
  const _jevJudge = opts._jevJudge ?? jevJudge;
  const base = config.project?.base_branch || "main";
  const branch = task.branch || `${config.agent?.branch_prefix || "empress/task"}-${task.id}`;

  const patch = _diffPatch(cwd, base, branch);
  const deterministic = scanDiff(patch);
  // Authoritative changed list from git --numstat (not the --stat header parser).
  const changed = _diffBetween(cwd, base, branch).changed;
  const conv = conventionSignals(changed);

  // forceJev: true really forces the Jev tier (env-independent for tests);
  // otherwise gate on the ambient key (missing key => degraded deterministic).
  const available = opts.forceJev === true ? true : jevAvailable().available;
  let jevNoul = null;
  let jevError = false;
  if (available) {
    const state = buildTriageState({ taskTitle: task.title, diffSummary: patch });
    const r = await _jevJudge({
      type: "noul",
      instructions: "This code change warrants a human review before landing (security risk, trust boundary, convention violation, or unclear).",
      states: [state],
      apiKey: opts.apiKey,
    });
    if (r.ok && r.results[0]) {
      const a = r.results[0].answer;
      jevNoul = a && typeof a.noul === "number" ? a.noul : 0;
    } else {
      jevError = true;
    }
  }

  return { ...decideTriage({ deterministic, conv, jevNoul, jevError, threshold: opts.threshold ?? 0.5 }), deterministic, conv, jevNoul };
}