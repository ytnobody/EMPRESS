// `empress doctor`: prerequisite / environment checks.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR, loadConfig } from "../shared/config.ts";
import { run } from "../shared/shell.ts";
import { isGitRepo, baseDivergence } from "../domain/git.ts";
import { hygieneReport, treeHygieneViolations } from "../domain/hygiene.ts";
import { jevAvailable } from "../domain/jev.ts";

type Check = [name: string, pass: boolean, msg: string];

/**
 * Deterministic base/origin divergence check (#94): local base must not be ahead
 * of origin/<base>. A local-only repo (no origin ref) passes as skipped. Exported
 * so the indicator itself is covered by a test.
 */
export function baseDivergenceCheck(cwd: string, base: string): Check {
  const div = baseDivergence(cwd, base);
  const msg = !div.originBaseExists
    ? "no origin remote (local-only) — skipped"
    : div.diverged
      ? `local ${base} is ${div.ahead} commit(s) ahead of origin/${base} — run \`git push origin ${base}\``
      : "";
  return [`base not ahead of origin/${base}`, !div.diverged, msg];
}

export async function doctor(cwd: string) {
  const checks: Check[] = [];
  const okChecks: string[] = [];

  const gitRes = run("git", ["--version"]);
  const gitOk = gitRes.code === 0;
  checks.push(["git available", gitOk, gitOk ? "" : gitRes.stderr || "git not found"]);
  if (gitOk) okChecks.push("git");

  const repoOk = isGitRepo(cwd);
  checks.push(["cwd is a git repo", repoOk, repoOk ? "" : "not inside a git repository"]);

  const configExists = fs.existsSync(path.join(cwd, EMPRESS_DIR, "empress.toml")) || fs.existsSync(path.join(cwd, "empress.toml"));
  checks.push(["empress.toml present", configExists, configExists ? "" : "run `empress init`"]);

  const tasksDir = fs.existsSync(path.join(cwd, EMPRESS_DIR, "tasks"));
  checks.push([".empress/tasks present", tasksDir, tasksDir ? "" : "run `empress init`"]);

  const jev = jevAvailable();
  checks.push(["TYPESAFE_API_KEY set (Jev)", jev.apiKey, jev.apiKey ? "" : "Jev judgments disabled (falls back to deterministic rules — optional)"]);

  const rolePrompts = fs.existsSync(path.join(cwd, EMPRESS_DIR, "agents", "superintendent.md")) && fs.existsSync(path.join(cwd, EMPRESS_DIR, "agents", "engineer.md"));
  checks.push(["role prompts present", rolePrompts, rolePrompts ? "" : "run `empress init`"]);

  const piRes = run("pi", ["--version"]);
  checks.push(["pi available", piRes.code === 0, piRes.code === 0 ? "" : "pi not found"]);

  // gh is only needed when the project opted into GitHub ([github] enabled = true).
  const loaded = loadConfig(cwd);
  const ghEnabled = Boolean(loaded.github?.enabled);
  let ghOk = true;
  if (ghEnabled) {
    const ghRes = run("gh", ["--version"]);
    ghOk = ghRes.code === 0;
    checks.push(["gh CLI (github enabled)", ghOk, ghOk ? "" : "required because [github] enabled = true"]);
  }

  // Repo-tree hygiene (Task #54): fail if a gitignored runtime artifact is tracked.
  const hygieneViolations = treeHygieneViolations(cwd);
  checks.push([
    "repo-tree hygiene",
    hygieneViolations.length === 0,
    hygieneViolations.length === 0 ? "" : hygieneReport(cwd),
  ]);

  // Base/origin divergence (#94): with GitHub enabled, an auto-landed commit that
  // never reached origin/<base> shows up as local base being ahead. Fail loudly
  // so the one-shot sync class is unnecessary.
  if (repoOk) {
    checks.push(baseDivergenceCheck(cwd, loaded.project.base_branch));
  }

  let allOk = true;
  let warnOnly = 0;
  for (const [name, pass, msg] of checks) {
    const kind = name.startsWith("TYPESAFE") ? (pass ? "ok" : "warn") : pass ? "ok" : "fail";
    if (kind === "warn") warnOnly++;
    if (kind === "fail") allOk = false;
    const mark = kind === "ok" ? "✓" : kind === "warn" ? "⚠" : "✗";
    console.log(`${mark} ${name}${msg ? `\n    ${msg}` : ""}`);
  }

  const env = ["GIT", jev.apiKey ? "JEV" : "", "PI", ghEnabled && ghOk ? "GH" : ""].filter(Boolean);
  console.log(`\nReady: ${env.join(", ")}`);
  if (!allOk) {
    console.log("Some checks failed. See notes above.");
    process.exitCode = warnOnly < checks.length ? 1 : 0;
  }
}