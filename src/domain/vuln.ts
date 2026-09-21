// Deterministic dependency vulnerability scanning for EMPRESS.
// Detects the project stack and runs the appropriate scanner:
//   go.mod          -> govulncheck
//   package.json+lock -> npm audit --omit=dev --json
//   requirements.txt / pyproject.toml -> pip-audit
// Design (PFT): stack detection and output parsing are pure functions
// (verification arithmetic); only the scanner spawn is external (injectable `_run`).

import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "../shared/shell.ts";
import type { RunOpts, RunResult } from "../shared/shell.ts";

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, moderate: 2, low: 1 };

export type Stack = "go" | "npm" | "pip";

type CiRunner = (cmd: string, args: string[], opts?: RunOpts) => RunResult;

/**
 * Unified finding shape: npm findings carry name/isDirect/range/fixAvailable/url;
 * govulncheck & pip text/json findings carry title/at. Fields a stack does not
 * produce are simply absent (optional).
 */
export interface Finding {
  severity: string;
  name?: string;
  isDirect?: boolean;
  range?: string;
  fixAvailable?: boolean;
  url?: string;
  title?: string;
  at?: string;
}

/** Pure: detect which stack a project uses from its root dir. */
export function detectStack(root: string): Stack | null {
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
export function buildVulnCommand(stack: Stack | null): { bin: string; args: string[] } | null {
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

interface NpmVuln {
  name?: string;
  severity?: string;
  isDirect?: boolean;
  range?: string;
  fixAvailable?: boolean | { name?: string };
  url?: string;
}

/** Pure: parse `npm audit --json` output into findings. */
export function parseNpmAudit(text: string): Finding[] {
  let data: { vulnerabilities?: Record<string, NpmVuln> };
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const vulns: Record<string, NpmVuln> = data?.vulnerabilities || {};
  const findings: Finding[] = [];
  for (const [name, v] of Object.entries(vulns)) {
    if (!v) continue;
    findings.push({
      name,
      severity: v.severity || "unknown",
      isDirect: Boolean(v.isDirect),
      range: v.range || "",
      fixAvailable: Boolean(v.fixAvailable === true || (v.fixAvailable && typeof v.fixAvailable === "object")),
      url: typeof v.url === "string" ? v.url : "",
    });
  }
  findings.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
  return findings;
}

/** Pure: parse govulncheck text output into a compact summary (best-effort). */
export function parseGovulncheckText(text: string): Finding[] {
  // govulncheck -format text prints "Vulnerability #1: ..." blocks.
  const findings: Finding[] = [];
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

export interface VulnResult {
  ok: boolean;
  stack?: string;
  findings: Finding[];
  summary?: string;
  error?: string;
  raw?: string;
}

/**
 * Run the vulnerability scan for a project.
 * @returns {Promise<{ok:boolean, stack?:string, findings?:object[], summary?:string, error?:string}>}
 */
export function runVulnCheck(cwd: string, opts: { stack?: Stack; _run?: CiRunner } = {}): VulnResult {
  const { stack, _run = run } = opts;
  const detected = stack ?? detectStack(cwd);
  if (!detected) return { ok: false, findings: [], error: "no supported dependency stack detected (go.mod / package.json+lock / requirements.txt)" };

  const cmd = buildVulnCommand(detected);
  if (!cmd) return { ok: false, stack: detected, findings: [], error: `unsupported stack: ${detected}` };
  // probe availability
  const probe = _run(cmd.bin, ["--version"], { cwd });
  if (probe.code !== 0 && cmd.bin !== "npm") {
    return {
      ok: false,
      stack: detected,
      findings: [],
      error: `\`${cmd.bin}\` not available (e.g. go install golang.org/x/vuln/cmd/govulncheck@latest).`,
    };
  }

  const res = _run(cmd.bin, cmd.args, { cwd });
  let findings: Finding[] = [];
  if (detected === "npm") findings = parseNpmAudit(res.stdout);
  else findings = parseGovulncheckText(res.stdout); // go text + pip-audit: keep generic

  return {
    ok: true,
    stack: detected,
    findings,
    summary: `${findings.length} known vuln(s) in ${detected} dependencies`,
    raw: (res.stdout || res.stderr).slice(0, 2000),
  };
}