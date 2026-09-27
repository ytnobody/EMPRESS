// Idle-audit findings — deterministic scans for the three improvement axes the
// operator wants surfaced while the loop is idle:
//   modern  — rot markers, oversized files, stale .js files
//   secure  — tracked secret-ish files (.env*, credentials), secret/dangerous
//             patterns across src (reuses scanDiff's pattern tables)
//   light   — oversized files (same set, flagged under its own axis), ponytail
//             no-trigger markers are covered by empress_ponytail_debt separately
//
// Pure-ish by design (files are registered inside; everything else is
// deterministic). The Superintendent audit pass consumes this to *file tasks*,
// which the normal loop then implements+lands automatically (MEDIUM auto-land,
// HIGH held for human) — i.e. "improve when idle" is a closed loop.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface AuditFinding {
  axis: "modern" | "secure" | "light";
  title: string; // short, dedupe-friendly title
  detail: string; // location + why
}

function walkTs(root: string, out: string[]) {
  if (!fs.existsSync(root)) return;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".empress") continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkTs(full, out);
    else if (/\.(ts|mjs|js|json|toml)$/.test(e.name)) out.push(full);
  }
}

/** Legacy-JS residue (should stay zero now that everything is .ts). */
export function legacyJsResidue(root: string): AuditFinding[] {
  const files: string[] = [];
  for (const d of ["src", "bin", "scripts"]) walkTs(path.join(root, d), files);
  const js = files.filter((f) => f.endsWith(".js"));
  return js.map((f) => ({
    axis: "modern",
    title: "Legacy .js file still present",
    detail: `"${path.relative(root, f)}" (project is TypeScript-only now)`,
  }));
}

/** Rot markers across src/scripts. */
export function todoMarkers(root: string): AuditFinding[] {
  const out: AuditFinding[] = [];
  const files: string[] = [];
  for (const d of ["src", "scripts"]) walkTs(path.join(root, d), files);
  for (const f of files) {
    if (!/\.ts$/.test(f)) continue;
    const lines = fs.readFileSync(f, "utf-8").split(/\r?\n/);
    lines.forEach((line, i) => {
      // comment lines only — string literals (e.g. prompt text) must not self-report
      const isComment = /^(\s*)(\/\/|\/\*|\*|#)/.test(line);
      if (!isComment || !/\b(TODO|FIXME|HACK)\b/.test(line)) return;
      const tag = line.includes("FIXME") ? "FIXME" : line.includes("HACK") ? "HACK" : "TODO";
      out.push({
        axis: "modern",
        title: `${tag}: ${path.relative(root, f)}:${i + 1}`,
        detail: line.trim(),
      });
    });
  }
  return out;
}

/** Files over a size threshold — a 'light' (and readability) signal. */
export function oversizedFiles(root: string, thresholdLines = 600): AuditFinding[] {
  const out: AuditFinding[] = [];
  const files: string[] = [];
  for (const d of ["src", "bin", "scripts"]) walkTs(path.join(root, d), files);
  for (const f of files) {
    if (!/\.(ts|mjs)$/.test(f)) continue;
    const n = fs.readFileSync(f, "utf-8").split(/\r?\n/).length;
    if (n > thresholdLines) {
      out.push({
        axis: "light",
        title: `Large file (>${thresholdLines} lines)`,
        detail: `"${path.relative(root, f)}" (${n} lines)`,
      });
    }
  }
  return out;
}

/** Tracked files that look like secrets (.env*, credential-ish names). */
export function trackedSecretFiles(root: string): AuditFinding[] {
  const out: AuditFinding[] = [];
  try {
    const isRepo = fs.existsSync(path.join(root, ".git"));
    const files = isRepo
      ? execGitLsFiles(root)
      : [];
    for (const f of files) {
      if (/(^|\/)(\.env[^/]*|.*(secret|credential|password|token)[^/]*)$/i.test(f)) {
        out.push({
          axis: "secure",
          title: `Tracked secret-ish file: ${path.basename(f)}`,
          detail: `${f} is tracked in git — ensure it holds no real credentials`,
        });
      }
    }
  } catch {
    /* non-git dir */
  }
  return out;
}

function execGitLsFiles(root: string): string[] {
  return String(execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf-8" }))
    .split("\n")
    .filter(Boolean);
}

/**
 * Tracked paths that .gitignore intends to exclude (a committed runtime
 * artifact/symlink — e.g. the podman-deps self-poisoning where a node_modules
 * SYMLINK slipped into a commit because the pattern only matched the dir).
 * `git ls-files -ci --exclude-standard` is the native, deterministic check;
 * git's name-matching treats a directory and a same-named symlink identically,
 * so a force-committed node_modules — dir subtree or symlink — surfaces here.
 * Empty when git is unavailable (the [ci] alpine image ships no git binary) so
 * a git-less run is not falsely blocked (host / GitHub Actions git enforces it).
 */
export function trackedGitignoredPaths(root: string): string[] {
  if (!fs.existsSync(path.join(root, ".git"))) return []; // not a git tree: nothing tracked
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-ci", "--exclude-standard"], { encoding: "utf-8" });
    return String(out).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Aggregate deterministic findings for the three axes. `patternTables` reusable
 * from triage (secrets/dangerous) — passed in to keep the dependency explicit.
 */
export function collectAuditFindings(root: string): { findings: AuditFinding[]; summary: string } {
  const findings: AuditFinding[] = [
    ...legacyJsResidue(root),
    ...todoMarkers(root),
    ...oversizedFiles(root),
    ...trackedSecretFiles(root),
  ];

  // Repo-tree hygiene gate: never allow a gitignored runtime path to be tracked.
  const gitignored = trackedGitignoredPaths(root);
  if (gitignored.length) {
    findings.push({
      axis: "secure",
      title: `Tracked gitignored path${gitignored.length > 1 ? "s" : ""}: ${gitignored.join(", ")}`,
      detail: `"${gitignored.join("\", \"")}" is tracked despite .gitignore excluding it — purge the commit (repo-tree hygiene gate)`,
    });
  }

  const byAxis = (a: string) => findings.filter((f) => f.axis === a).length;
  return {
    findings,
    summary: `modern: ${byAxis("modern")}, secure: ${byAxis("secure")}, light: ${byAxis("light")}`,
  };
}