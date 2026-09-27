// Risk evaluation: deterministic heuristics (HERMIT-compatible) blended with an
// optional Jev System One judgment on the actual diff.
import { diffBetween, diffPatch } from "./git.ts";
import { jevOne, jevAvailable } from "./jev.ts";
import { detectPureRefactor, gatherFileDiffs } from "./refactor.ts";
import type { Config } from "../shared/config.ts";
import type { Task } from "./tasks.ts";

type Severity = "LOW" | "MEDIUM" | "HIGH";

const SEVERITY: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };

function matchesPath(changedFile: string, patterns: string[]): boolean {
  if (!changedFile) return false;
  for (const pat of patterns || []) {
    const p = String(pat);
    if (p === changedFile) return true;
    if (changedFile.startsWith(p)) return true;
    if (changedFile.includes("/" + p)) return true;
  }
  return false;
}

/** Deterministic risk evaluation from a diff + config. */
export function deterministicRisk(
  { files, insertions, deletions, changed }: { files: number; insertions: number; deletions: number; changed: string[] },
  risk: Config["risk"]
): { level: Severity; reasons: string[]; files: number; lines: number } {
  const lines = (insertions || 0) + (deletions || 0);
  const reasons = [];
  const highPaths = risk.high_paths || [];
  const medPaths = risk.medium_paths || [];
  const hitHigh = (changed || []).find((f) => matchesPath(f, highPaths));
  const hitMed = (changed || []).find((f) => matchesPath(f, medPaths));

  if (hitHigh) {
    reasons.push(`changed high-risk path ${hitHigh}`);
    return { level: "HIGH", reasons, files, lines };
  }
  if ((risk.high_file_threshold || 0) > 0 && files >= risk.high_file_threshold) {
    reasons.push(`${files} files changed (>= ${risk.high_file_threshold})`);
    return { level: "HIGH", reasons, files, lines };
  }
  if ((risk.high_line_threshold || 0) > 0 && lines >= risk.high_line_threshold) {
    reasons.push(`${lines} lines changed (>= ${risk.high_line_threshold})`);
    return { level: "HIGH", reasons, files, lines };
  }
  if (hitMed) {
    reasons.push(`changed medium-risk path ${hitMed}`);
    return { level: "MEDIUM", reasons, files, lines };
  }
  if ((risk.medium_file_threshold || 0) > 0 && files >= risk.medium_file_threshold) {
    reasons.push(`${files} files changed (>= ${risk.medium_file_threshold})`);
  }
  if ((risk.medium_line_threshold || 0) > 0 && lines >= risk.medium_line_threshold) {
    reasons.push(`${lines} lines changed (>= ${risk.medium_line_threshold})`);
  }
  return { level: reasons.length ? "MEDIUM" : "LOW", reasons, files, lines };
}

type RiskResult = {
  level: Severity;
  reasons: string[];
  files: number;
  lines: number;
};

/**
 * Pure downgrade: a HIGH that is mechanically proven to be a behavior-preserving pure
 * refactor is rated non-HIGH so the loop can auto-land it after full review. Any real
 * behavior difference (pure=false) stays HIGH.
 */
export function withPureRefactorDowngrade(det: RiskResult, pure: { pure: boolean; reasons: string[] }): RiskResult {
  if (det.level === "HIGH" && pure.pure) {
    return {
      ...det,
      level: "MEDIUM",
      reasons: [
        ...det.reasons,
        "mechanically-proven behavior-preserving pure refactor (equal export surface, unchanged registerTool names, no behavior-only hunks); full review still applies",
      ],
    };
  }
  return det;
}

/**
 * Full evaluation: deterministic + optional Jev choice judgment.
 * @returns {Promise<{level, reasons, deterministicLevel, jev, files, lines}>}
 */
export async function evaluateRisk(
  cwd: string,
  config: Config,
  task: Task
): Promise<{ level: Severity; reasons: string[]; deterministicLevel: Severity; jev: { level: Severity; confidence: number | null } | null; files: number; lines: number }> {
  const base = (config.project && config.project.base_branch) || "main";
  const branch = task.branch || `${
    (config.agent && config.agent.branch_prefix) || "empress/task"
  }-${task.id}`;
  const diff = diffBetween(cwd, base, branch);
  let det = deterministicRisk(diff, config.risk || {});

  // Mechanically prove behavior-preservation on the changed source files; if proven,
  // drop a false-HIGH (pure relocation) to non-HIGH. Conservative: unsure stays HIGH.
  const pure = detectPureRefactor(gatherFileDiffs(cwd, base, branch, diff.changed));
  det = withPureRefactorDowngrade(det, pure);

  const out: { level: Severity; reasons: string[]; deterministicLevel: Severity; jev: { level: Severity; confidence: number | null } | null; files: number; lines: number } = {
    level: det.level,
    reasons: [...det.reasons],
    deterministicLevel: det.level,
    jev: null,
    files: diff.files,
    lines: diff.insertions + diff.deletions,
  };

  const jev = config.risk || {};
  if (jev.use_jev && jevAvailable().available) {
    const state = `task: ${task.title}\n\n${diffPatch(cwd, base, branch)}`;
    const j = await jevOne({
      type: "choice",
      instructions: "Classify how risky this code change is to land. low means small, isolated, well-scoped; high means large or touching core/security/config.",
      state,
      options: ["low", "medium", "high"],
      model: (config.jev && config.jev.model) || "jev-latest",
    });
    if (j.ok && j.value) {
      const jLevel = String(j.value).toUpperCase() as Severity;
      if (["LOW", "MEDIUM", "HIGH"].includes(jLevel)) {
        out.jev = { level: jLevel, confidence: j.confidence };
        out.reasons.push(`Jev: ${jLevel.toLowerCase()} (conf ${j.confidence == null ? "?" : j.confidence.toFixed(2)})`);
        if (SEVERITY[jLevel] > SEVERITY[out.level]) out.level = jLevel;
      }
    }
  }

  return out;
}