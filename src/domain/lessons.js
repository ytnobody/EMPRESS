// Lessons store: append-only .empress/lessons.md, with optional Jev quality scoring.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../shared/config.js";
import { jevOne, jevAvailable } from "./jev.js";

function lessonsFile(cwd) {
  return path.join(cwd, EMPRESS_DIR, "lessons.md");
}

/** Read lessons as an array of {id, text}. */
export function getLessons(cwd, { limit = 15 } = {}) {
  const file = lessonsFile(cwd);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = /^- \d+\.\s+(.*)$/.exec(line.trim());
    if (m) out.push({ id: out.length + 1, text: m[1] });
  }
  return out.slice(-limit);
}

/** Append a lesson, deduping by normalized text. */
export function addLesson(cwd, text) {
  const existing = getLessons(cwd, { limit: 1000 }).map((l) => l.text.trim().toLowerCase());
  const norm = String(text).trim();
  if (!norm) return false;
  // don't keep literally duplicated lessons (near-dupes are fine to keep)
  if (existing.includes(norm.toLowerCase())) return false;
  fs.mkdirSync(path.join(cwd, EMPRESS_DIR), { recursive: true });
  const n = getLessons(cwd, { limit: 1000 }).length + 1;
  const line = `- ${n}. ${norm}`;
  fs.appendFileSync(lessonsFile(cwd), fs.existsSync(lessonsFile(cwd)) ? "\n" + line : line);
  return true;
}

/**
 * Score the quality of a task/instruction (0-100) to decide whether a lesson is warranted.
 * Deterministic baseline (HERMIT-compatible) + optional Jev score refinement.
 */
export async function evaluateInstruction(config, { riskLevel, hadClarification, multiplePRs, ciFailed }) {
  const risk = config.risk || {};
  let score = 100;
  if (riskLevel === "HIGH") score -= 30;
  if (riskLevel === "MEDIUM") score -= 15;
  if (ciFailed) score -= 20;
  if (multiplePRs) score -= 15;
  if (hadClarification) score -= 20;
  score = Math.max(0, score);

  const jev = config.jev || {};
  if (jevAvailable(jev.command || "chariot").available && score < 70) {
    const j = await jevOne({
      type: "score",
      instructions: "Score how clearly this task was specified, 0 (very unclear) to 100 (crystal clear).",
      state: `A task was implemented but generated ${riskLevel} risk and required human judgment.`,
      options: ["unclear", "mostly clear", "clear"],
      command: jev.command || "chariot",
      model: jev.model || "jev-latest",
    });
    // Jev only refines downward the "this needs a lesson" signal.
    if (j.ok && typeof j.value === "number" && j.value < 60) score = Math.min(score, Math.round(j.value));
  }
  return score;
}