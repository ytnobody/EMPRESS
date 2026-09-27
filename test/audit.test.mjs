// Idle-audit deterministic scan — pure-ish detection tests (tmp dirs, real fs).
// Per PFT: expected findings derive from the spec of each axis, not the impl.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  legacyJsResidue,
  todoMarkers,
  oversizedFiles,
  trackedSecretFiles,
  trackedGitignoredPaths,
  collectAuditFindings,
} from "../src/domain/audit.ts";

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
// [ASSUMPTION] When git is unavailable (the [ci] container oven/bun:1.4-alpine
// ships no git binary) the fixture can't be tracked, so the test skips instead
// of failing on an impossible setup — host runs (git present) are the
// authority for this spec.
test("trackedSecretFiles: flags tracked .env-ish entries", (t) => {
  const root = mkRepo({ "src/a.ts": "export const a=1;", ".env": "KEY=x\n", ".env.example": "KEY=\n" });
  const { execFileSync } = require("node:child_process");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  let setupOk = false;
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "add", ".env", ".env.example"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "x"]);
    setupOk = true;
  } catch {
    // git absent (e.g. CI container): nothing is tracked -> skip the spec.
  }
  if (!setupOk) {
    t.skip("git not available in this environment");
    return;
  }
  const hits = trackedSecretFiles(root);
  assert.ok(hits.some((h) => h.axis === "secure" && /\.env/.test(h.title)));
});

// Verifies: a force-committed node_modules (the podman-deps self-poisoning
// incident, committed as a SYMLINK) is surfaced as a tracked gitignored path —
// expected from the spec: .gitignore's `node_modules` intends to exclude that
// path regardless of how it is materialized in the tree.
test("trackedGitignoredPaths: flags a tracked node_modules symlink", (t) => {
  const root = mkRepo({ "src/a.ts": "export const a=1;", "keep.js": "x" });
  let setupOk = false;
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n*.log\n");
    fs.symlinkSync(path.join(root, "src"), path.join(root, "node_modules"));
    execFileSync("git", ["-C", root, "add", "-f", "node_modules", "keep.js"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "x"]);
    setupOk = true;
  } catch {
    // git absent (e.g. CI alpine image): nothing tracked -> skip the spec.
  }
  if (!setupOk) {
    t.skip("git not available in this environment");
    return;
  }
  assert.deepEqual(trackedGitignoredPaths(root), ["node_modules"]);
});

// Verifies: a file force-committed INSIDE a real gitignored directory (node_modules/)
// is also surfaced — .gitignore's `node_modules` excludes the whole subtree, not
// only a top-level symlink.
test("trackedGitignoredPaths: flags a tracked file under a gitignored dir", (t) => {
  const root = mkRepo({ "src/a.ts": "export const a=1;", "keep.js": "x" });
  let setupOk = false;
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules", "inner.js"), "x");
    execFileSync("git", ["-C", root, "add", "-f", "node_modules/inner.js", "keep.js"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "x"]);
    setupOk = true;
  } catch {
    t.skip("git not available in this environment");
    return;
  }
  assert.deepEqual(trackedGitignoredPaths(root), ["node_modules/inner.js"]);
});

// Verifies: a normal, unignored file is NOT flagged — the gate must not (and does
// not) complain about healthy tracked code.
test("trackedGitignoredPaths: clean tree is not flagged", (t) => {
  const root = mkRepo({ "src/a.ts": "export const a=1;", "keep.js": "x" });
  let setupOk = false;
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    fs.mkdirSync(path.join(root, "lib"));
    fs.writeFileSync(path.join(root, "lib", "ok.js"), "x");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-qm", "x"]);
    setupOk = true;
  } catch {
    t.skip("git not available in this environment");
    return;
  }
  assert.deepEqual(trackedGitignoredPaths(root), []);
});

// Verifies: .gitignore matches BOTH a directory and a same-named symlink — git
// matches the path/pattern, not the on-disk file type, so a `node_modules` symlink
// is ignored exactly as `node_modules/` is. (The original bug: the pattern ignored
// only the directory, letting the symlink through to a commit.)
function gitCheckIgnoreMatches(root, p) {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "--no-index", p], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
test("gitignore pattern matches both a dir and a same-named symlink", (t) => {
  const root = mkRepo({ "keep.js": "x" });
  let setupOk = false;
  let dirIgnored = false;
  let symlinkIgnored = false;
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
    // as a directory:
    fs.mkdirSync(path.join(root, "node_modules"));
    dirIgnored = gitCheckIgnoreMatches(root, "node_modules");
    // as a same-named symlink (replace the directory):
    fs.rmSync(path.join(root, "node_modules"), { recursive: true });
    fs.symlinkSync(path.join(root, "keep.js"), path.join(root, "node_modules"));
    symlinkIgnored = gitCheckIgnoreMatches(root, "node_modules");
    setupOk = true;
  } catch {
    t.skip("git not available in this environment");
    return;
  }
  if (!setupOk) {
    t.skip("git fixtures could not be constructed");
    return;
  }
  assert.equal(dirIgnored, true);
  assert.equal(symlinkIgnored, true);
});

// Verifies: aggregate returns a per-axis summary.
test("collectAuditFindings: summarizes per axis", () => {
  const root = mkRepo({ "src/a.ts": "// TODO: later\n" });
  const { findings, summary } = collectAuditFindings(root);
  assert.equal(typeof summary, "string");
  assert.match(summary, /modern: \d+/);
  assert.ok(Array.isArray(findings));
});