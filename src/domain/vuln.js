// Deterministic dependency vulnerability scanning for EMPRESS.
// Detects the project stack and runs the appropriate scanner:
//   go.mod          -> govulncheck
//   package.json+lock -> npm audit --omit=dev --json
//   requirements.txt / pyproject.toml -> pip-audit
// Design (PFT): stack detection and output parsing are pure functions
// (verification arithmetic); only the scanner spawn is external (injectable `_run`).

import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "../shared/shell.js";

const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1 };

/** Pure: detect which stack a project uses from its root dir. */
export function detectStack(root) {
  if (fs.existsSync(path.join(root, "go.mod"))) return "go";
  if (fs.existsSync(path.join(root, "package.json")) &&
      ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"].some((l) => fs.existsSync(path.join(root, l)))) {
    return "npm";
  }
  if (fs.existsSync(path.join(root, "requirements.txt")) || fs.existsSync(path.join(root, "pyproject.toml"))) {
    return "pip";
  }
  return null;
}

/** Pure: the scanner command for a stack (Command verification target). */
export function buildVulnCommand(stack) {
  switch (stack) {
    case "go":
      return { bin: "govulncheck", args: ["-format", "text", "./..."] };
    case "npm":
      return { bin: "npm", args: ["audit", "--omit=dev", "--json"] };
    case "pip":
      return { bin: "pip-audit", args: ["--format", "json", "--local"] };
    default:
      return null;
  }
}

/** Pure: parse `npm audit --json` output into findings. */
export function parseNpmAudit(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const vulns = data?.vulnerabilities || {};
  const findings = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (!v) continue;
    findings.push({
      name,
      severity: v.severity || "unknown",
      isDirect: Boolean(v.isDirect),
      range: v.range || "",
      fixAvailable: v.fixAvailable === true || (v.fixAvailable && typeof v.fixAvailable === "object"),
      url: typeof v.url === "string" ? v.url : "",
    });
  }
  findings.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
  return findings;
}

/** Pure: parse govulncheck text output into a compact summary (best-effort). */
export function parseGovulncheckText(text) {
  // govulncheck -format text prints "Vulnerability #1: ..." blocks.
  const findings = [];
  const blocks = String(text || "").split(/\nVulnerability #\d+: /).slice(1);
  for (const b of blocks) {
    const lines = b.split("\n");
    const title = lines[0]?.trim();
    const foundAt = lines.find((l) => l.includes("  Found in: "));
    const at = foundAt ? foundAt.split("Found in:")[1].trim() : "";
    if (title) findings.push({ title, at, severity: "unknown" });
  }
  return findings;
}

/**
 * Run the vulnerability scan for a project.
 * @returns {Promise<{ok:boolean, stack?:string, findings?:object[], summary?:string, error?:string}>}
 */
export function runVulnCheck(cwd, { stack, _run = run } = {}) {
  const detected = stack ?? detectStack(cwd);
  if (!detected) return { ok: false, error: "no supported dependency stack detected (go.mod / package.json+lock / requirements.txt)" };

  const cmd = buildVulnCommand(detected);
  // probe availability
  const probe = _run(cmd.bin, ["--version"], { cwd });
  if (probe.code !== 0 && cmd.bin !== "npm") {
    return {
      ok: false,
      stack: detected,
      error: `\`${cmd.bin}\` not available (e.g. go install golang.org/x/vuln/cmd/govulncheck@latest).`,
    };
  }

  const res = _run(cmd.bin, cmd.args, { cwd });
  let findings = [];
  if (detected === "npm") findings = parseNpmAudit(res.stdout);
  else if (detected === "go") findings = parseGovulncheckText(res.stdout);
  else findings = parseGovulncheckText(res.stdout); // pip-audit json: keep generic

  return {
    ok: true,
    stack: detected,
    findings,
    summary: `${findings.length} known vuln(s) in ${detected} dependencies`,
    raw: (res.stdout || res.stderr).slice(0, 2000),
  };
}