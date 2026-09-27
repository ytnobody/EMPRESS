// Repo-tree hygiene gate (Task #54): deterministic, LLM-free check that no
// gitignored runtime artifact (e.g. a committed `node_modules` symlink) is
// tracked in the tree. The `node_modules/` dir-only gitignore pattern missed the
// SYMLINK (git treats it as a file), so a self-poisoning symlink got committed
// and broke CI; this check surfaces such a violation early (doctor / CI / run).
import { run } from "../shared/shell.ts";

/**
 * LLM-free hygiene check: return the tracked paths that are also gitignored
 * (`git ls-files -i --exclude-standard`). Non-empty means a runtime artifact /
 * symlink that should never be committed got into the tree. Empty means clean.
 */
export function treeHygieneViolations(cwd: string): string[] {
  const res = run("git", ["-C", cwd, "ls-files", "-c", "-i", "--exclude-standard", "-z"]);
  if (res.code !== 0) return [];
  return res.stdout.replace(/\0/g, "\n").split("\n").filter(Boolean);
}

/** Whether a path is ignored by gitignore at all (real dir OR symlink). */
export function isGitignored(cwd: string, p: string): boolean {
  return run("git", ["-C", cwd, "check-ignore", "-q", p]).code === 0;
}

/** Human-readable hygiene summary (empty string = clean). */
export function hygieneReport(cwd: string): string {
  const v = treeHygieneViolations(cwd);
  if (!v.length) return "";
  return `Tracked-but-gitignored runtime artifact(s) in the tree: ${v.join(", ")}. Remove them (git rm --cached) — they break CI.`;
}