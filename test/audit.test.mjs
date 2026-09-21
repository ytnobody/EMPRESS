// Idle-audit deterministic scan — pure-ish detection tests (tmp dirs, real fs).
// Per PFT: expected findings derive from the spec of each axis, not the impl.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { legacyJsResidue, todoMarkers, oversizedFiles, trackedSecretFiles, collectAuditFindings } from "../src/domain/audit.ts";

function mkRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content ?? "");
  }
  return root;
}

// Verifies: a stray .js under src/ is flagged as legacy residue (modern axis).
test("legacyJsResidue: flags .js under src when project is .ts-only", () => {
  const root = mkRepo({ "src/x.ts": "export const a=1;", "src/old.js": "module.exports={};" });
  const hits = legacyJsResidue(root);
  assert.ok(hits.some((h) => h.axis === "modern" && /old\.js/.test(h.detail)));
});

// Verifies: TODO/FIXME/HACK markers are surfaced with file:line.
test("todoMarkers: surfaces TODO/FIXME/HACK with location", () => {
  const root = mkRepo({ "src/a.ts": "// TODO: later\n// FIXME: broken\n// HACK: whatever\n" });
  const hits = todoMarkers(root);
  assert.equal(hits.length, 3);
  assert.ok(hits.every((h) => h.axis === "modern"));
  assert.match(hits[0].title, /TODO: src\/a\.ts:1/);
});

// Verifies: a file over the threshold is flagged under the light axis.
test("oversizedFiles: flags files over the line threshold", () => {
  const big = Array.from({ length: 610 }, (_, i) => `const l${i} = ${i};`).join("\n");
  const root = mkRepo({ "src/big.ts": big, "src/small.ts": "export const a=1;" });
  const hits = oversizedFiles(root, 600);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].axis, "light");
  assert.match(hits[0].detail, /big\.ts/);
});

// Verifies: a tracked .env file is flagged as a secure-axis concern.
test("trackedSecretFiles: flags tracked .env-ish entries", () => {
  const root = mkRepo({ "src/a.ts": "export const a=1;", ".env": "KEY=x\n", ".env.example": "KEY=\n" });
  const { execFileSync } = require("node:child_process");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", ".env", ".env.example"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "x"]);
  } catch {
    // no git available: skip
  }
  const hits = trackedSecretFiles(root);
  assert.ok(hits.some((h) => h.axis === "secure" && /\.env/.test(h.title)));
});

// Verifies: aggregate returns a per-axis summary.
test("collectAuditFindings: summarizes per axis", () => {
  const root = mkRepo({ "src/a.ts": "// TODO: later\n" });
  const { findings, summary } = collectAuditFindings(root);
  assert.equal(typeof summary, "string");
  assert.match(summary, /modern: \d+/);
  assert.ok(Array.isArray(findings));
});