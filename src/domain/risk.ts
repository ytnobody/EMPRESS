// Risk evaluation: deterministic heuristics (HERMIT-compatible) blended with an
// optional Jev System One judgment on the actual diff.
import { diffBetween, diffPatch } from "./git.ts";
import { jevOne, jevAvailable } from "./jev.ts";

const SEVERITY = { LOW: 1, MEDIUM: 2, HIGH: 3 };

function matchesPath(changedFile, patterns) {
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
export function deterministicRisk({ files, insertions, deletions, changed }, risk) {
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

/**
 * Full evaluation: deterministic + optional Jev choice judgment.
 * @returns {Promise<{level, reasons, deterministicLevel, jev, files, lines}>}
 */
export async function evaluateRisk(cwd, config, task) {
  const base = (config.project && config.project.base_branch) || "main";
  const branch = task.branch || `${
    (config.agent && config.agent.branch_prefix) || "empress/task"
  }-${task.id}`;
  const diff = diffBetween(cwd, base, branch);
  const det = deterministicRisk(diff, config.risk || {});

  const out = {
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
      const jLevel = String(j.value).toUpperCase();
      if (["LOW", "MEDIUM", "HIGH"].includes(jLevel)) {
        out.jev = { level: jLevel, confidence: j.confidence };
        out.reasons.push(`Jev: ${jLevel.toLowerCase()} (conf ${j.confidence == null ? "?" : j.confidence.toFixed(2)})`);
        if (SEVERITY[jLevel] > SEVERITY[out.level]) out.level = jLevel;
      }
    }
  }

  return out;
}