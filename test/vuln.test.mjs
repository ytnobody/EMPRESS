// Dependency vuln scanning — Command Verification style tests.
// Per PFT: assert stack detection + command building + output parsing as pure
// functions; runVulnCheck uses an injected runner (no real scanner).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectStack, buildVulnCommand, parseNpmAudit, parseBunAudit, parseGovulncheckText, runVulnCheck } from "../src/domain/vuln.js";

function tmpdirWith(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vuln-"));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(d, name), content ?? "");
  }
  return d;
}

// Verifies: stack detection keys off the marker files present in the project.
test("detectStack: detects go/npm/pip by marker files", () => {
  const go = tmpdirWith({ "go.mod": "module x\n" });
  const npm = tmpdirWith({ "package.json": "{}", "package-lock.json": "{}" });
  const yarn = tmpdirWith({ "package.json": "{}", "yarn.lock": "" });
  const pip = tmpdirWith({ "requirements.txt": "requests==2.0\n" });
  const none = tmpdirWith({});
  assert.equal(detectStack(go), "go");
  assert.equal(detectStack(npm), "npm");
  assert.equal(detectStack(yarn), "npm");
  assert.equal(detectStack(pip), "pip");
  assert.equal(detectStack(none), null);
});

// Verifies: each stack maps to the exact scanner command (Command).
test("buildVulnCommand: exact scanner per stack", () => {
  assert.deepEqual(buildVulnCommand("go"), { bin: "govulncheck", args: ["-format", "text", "./..."] });
  assert.deepEqual(buildVulnCommand("npm"), { bin: "npm", args: ["audit", "--omit=dev", "--json"] });
  assert.deepEqual(buildVulnCommand("bun"), { bin: "bun", args: ["audit", "--json"] });
  assert.deepEqual(buildVulnCommand("pip"), { bin: "pip-audit", args: ["--format", "json", "--local"] });
  assert.equal(buildVulnCommand("bogus"), null);
});

// Verifies: a bun-managed project (package.json + bun.lock) is its own stack,
// so empress_vuln_check runs a real scan instead of a silent no-op.
test("detectStack: package.json + bun.lock -> bun", () => {
  const bun = tmpdirWith({ "package.json": "{}", "bun.lock": "" });
  assert.equal(detectStack(bun), "bun");
});

// Verifies: bun audit clean output ({}), as observed on a real bun 1.4.2 run,
// parses to zero findings — a passing audit reports clean, not an error.
test("parseBunAudit: clean output {} -> []", () => {
  assert.deepEqual(parseBunAudit("{}"), []);
});

// Verifies: bun audit vulnerable JSON ({pkg -> advisories[]}) flattens to one
// finding per advisory with name/severity/range/url/title, sorted by severity desc.
test("parseBunAudit: flattens pkg->advisories into severity-sorted findings", () => {
  const findings = parseBunAudit(JSON.stringify({
    lodash: [
      { id: 1106913, url: "https://github.com/advisories/GHSA-35jh-r3h4-6jhm", title: "Command Injection in lodash", severity: "high", vulnerable_versions: "<4.17.21" },
      { id: 1106920, url: "https://github.com/advisories/GHSA-p6mc-m468-83gw", title: "Prototype Pollution in lodash", severity: "moderate", vulnerable_versions: ">=3.7.0 <4.17.19" },
    ],
    "left-pad": [
      { id: 1, url: "https://example.com/a", title: "t", severity: "critical", vulnerable_versions: "*" },
    ],
  }));
  assert.deepEqual(findings.map((f) => [f.name, f.severity]), [["left-pad", "critical"], ["lodash", "high"], ["lodash", "moderate"]]);
  assert.equal(findings[1].range, "<4.17.21");
  assert.equal(findings[1].url, "https://github.com/advisories/GHSA-35jh-r3h4-6jhm");
  assert.equal(findings[1].title, "Command Injection in lodash");
});

// Verifies: malformed or non-object bun audit output yields no findings (no crash).
test("parseBunAudit: malformed -> []", () => {
  assert.deepEqual(parseBunAudit("not json"), []);
  assert.deepEqual(parseBunAudit("null"), []);
});

// Verifies: npm audit JSON parses into findings sorted by severity desc.
test("parseNpmAudit: sorts findings by severity and flags direct/fix", () => {
  const findings = parseNpmAudit(JSON.stringify({
    vulnerabilities: {
      lodash: { name: "lodash", severity: "moderate", isDirect: true, range: ">=4.0.0", fixAvailable: { name: "lodash@4.17.21" } },
      minimist: { name: "minimist", severity: "critical", isDirect: false, range: "*", fixAvailable: true },
      leftpad: { name: "leftpad", severity: "low", isDirect: true, range: "^1.0.0", fixAvailable: false },
    },
  }));
  assert.deepEqual(findings.map((f) => f.name), ["minimist", "lodash", "leftpad"]);
  assert.equal(findings[0].isDirect, false);
  assert.equal(findings[0].fixAvailable, true);
  assert.equal(findings[1].fixAvailable, true);
  assert.equal(findings[2].severity, "low");
});

// Verifies: malformed npm audit output yields no findings (no crash).
test("parseNpmAudit: malformed JSON -> []", () => {
  assert.deepEqual(parseNpmAudit("not json"), []);
});

// Verifies: govulncheck text output block is captured best-effort.
test("parseGovulncheckText: extracts vulnerability blocks", () => {
  const out = parseGovulncheckText("\n=== === ===\nVulnerability #1: GO-2024-1234 in module io/fs\n  More info: https://go.dev/vuln/GO-2024-1234\n  Found in: io/fs@v1.0.0\n");
  assert.ok(out.length >= 1);
  assert.match(out[0].title, /GO-2024-1234/);
  assert.match(out[0].at, /io\/fs@v1\.0\.0/);
});

// Verifies: runVulnCheck dispatches to npm audit and returns parsed findings.
test("runVulnCheck: runs npm audit via injected runner", () => {
  const calls = [];
  const npm = tmpdirWith({ "package.json": "{}", "package-lock.json": "{}" });
  const auditJson = JSON.stringify({ vulnerabilities: { "bad@1.0.0": { name: "bad@1.0.0", severity: "high", isDirect: true, range: "*", fixAvailable: true } } });
  const r = runVulnCheck(npm, { _run: (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "npm" && args[0] === "--version") return { code: 0 };
    return { code: 0, stdout: auditJson, stderr: "" };
  } });
  assert.deepEqual(calls[1], ["npm", ["audit", "--omit=dev", "--json"]]);
  assert.equal(r.ok, true);
  assert.equal(r.stack, "npm");
  assert.equal(r.findings.length, 1);
  assert.match(r.summary, /1 known vuln/);
});

// Verifies: bun.lock dispatches to `bun audit --json` and a passing audit
// (clean {}) reports ok with 0 findings.
test("runVulnCheck: bun.lock passing audit -> ok, 0 findings", () => {
  const calls = [];
  const bun = tmpdirWith({ "package.json": "{}", "bun.lock": "" });
  const r = runVulnCheck(bun, { _run: (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "bun" && args[0] === "--version") return { code: 0 };
    return { code: 0, stdout: "{}", stderr: "" };
  } });
  assert.deepEqual(calls[1], ["bun", ["audit", "--json"]]);
  assert.equal(r.ok, true);
  assert.equal(r.stack, "bun");
  assert.equal(r.findings.length, 0);
  assert.match(r.summary, /0 known vuln/);
});

// Verifies: a failing bun audit (vulnerable JSON, exit 1) is parsed and
// reported — findings are not swallowed or hidden behind the non-zero exit.
test("runVulnCheck: bun.lock failing audit -> findings parsed", () => {
  const bun = tmpdirWith({ "package.json": "{}", "bun.lock": "" });
  const auditJson = JSON.stringify({ "bad-pkg@1.0.0": [{ id: 1, severity: "high", vulnerable_versions: "<2.0.0", url: "https://github.com/advisories/GHSA-x", title: "bad vuln" }] });
  const r = runVulnCheck(bun, { _run: (cmd, args) => {
    if (cmd === "bun" && args[0] === "--version") return { code: 0 };
    return { code: 1, stdout: auditJson, stderr: "" };
  } });
  assert.equal(r.ok, true);
  assert.equal(r.stack, "bun");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].name, "bad-pkg@1.0.0");
  assert.equal(r.findings[0].severity, "high");
  assert.match(r.summary, /1 known vuln/);
});

// Verifies: missing scanner for go reports a clear error (not a false "clean").
test("runVulnCheck: unavailable govulncheck surfaces error", () => {
  const go = tmpdirWith({ "go.mod": "module x\n" });
  const r = runVulnCheck(go, { _run: (cmd) => (cmd === "govulncheck" ? { code: 1, stderr: "not found" } : { code: 0 }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /govulncheck/);
  assert.match(r.error, /go install/);
});

// Verifies: unsupported stack is reported, not silently passed.
test("runVulnCheck: no stack -> explicit error", () => {
  const empty = tmpdirWith({});
  const r = runVulnCheck(empty, { _run: () => ({ code: 0 }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /no supported dependency stack/);
});