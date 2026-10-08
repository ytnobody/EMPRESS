// `empress doctor`: prerequisite / environment checks.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR, loadConfig } from "../shared/config.ts";
import { run } from "../shared/shell.ts";
import { isGitRepo } from "../domain/git.ts";
import { hygieneReport, treeHygieneViolations } from "../domain/hygiene.ts";
import { installDrift, installReport } from "../domain/install.ts";
import { AGENTS_SRC, PROMPTS_SRC } from "./init.ts";
import { jevAvailable } from "../domain/jev.ts";

type Check = [name: string, pass: boolean, msg: string];

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
  const ghEnabled = Boolean(loadConfig(cwd).github?.enabled);
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

  // Install-in-sync (Task #81): installed role/prompt copies must match bundled src/.
  const installDriftFindings = installDrift([
    { label: "agents", src: AGENTS_SRC, dest: path.join(cwd, EMPRESS_DIR, "agents") },
    { label: "prompts", src: PROMPTS_SRC, dest: path.join(cwd, ".pi", "prompts") },
  ]);
  checks.push([
    "role prompts in sync",
    installDriftFindings.length === 0,
    installDriftFindings.length === 0 ? "" : installReport(installDriftFindings),
  ]);

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