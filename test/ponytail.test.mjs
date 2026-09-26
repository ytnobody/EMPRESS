import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectPonytailDebt } from "../src/domain/ponytail.js";

// Verifies: markers are collected with a ceiling, markers naming a trigger/upgrade
// are NOT flagged no-trigger, and bare markers with no upgrade path are flagged
// no-trigger (they rot silently).
test("ponytail: counts markers and flags no-trigger ones", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "a.js"),
      [
        "// ponytail: global lock, use per-task locks if throughput matters",
        "// ponytail: naive sort, use merge sort when n is large",
        "// ponytail: quick hack",
        "x = 1",
      ].join("\n"),
    );
    const out = collectPonytailDebt(tmp);
    assert.equal(out.markers, 3);
    assert.equal(out.noTrigger, 1);
    const flagged = out.rows.filter((r) => r.noTrigger);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].ceiling, "quick hack");
    assert.equal(flagged[0].upgrade, "(none)");
    const notFlagged = out.rows.filter((r) => !r.noTrigger);
    assert.equal(notFlagged.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies: wrapped multi-line markers (marker text continuing on the following
// comment lines, e.g. ci.ts's 3-line marker) are joined, so the upgrade path on a
// later comment line is captured and the marker is NOT falsely flagged no-trigger;
// a following standalone comment (new sentence) is NOT swallowed into the body.
test("ponytail: joins wrapped marker lines so the upgrade path is captured", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "m.js"),
      [
        "// ponytail: fixed 3-ups worktree path, refuse rewrite when main absent; generalize if",
        "// EMPRESS_DIR ever gets nested or worktrees relocate.",
        "// unrelated note about the layout, must not be joined",
        "x = 1",
      ].join("\n"),
    );
    const out = collectPonytailDebt(tmp);
    const row = out.rows[0];
    // spec: the joined body exposes the "if" trigger and the upgrade path on line 2
    assert.equal(out.markers, 1);
    assert.equal(out.noTrigger, 0);
    assert.ok(row.upgrade.includes("EMPRESS_DIR"));
    assert.ok(row.upgrade.includes("worktrees relocate."));
    // line 3 is a new sentence after the marker's terminal "." -> must not be joined
    assert.ok(!row.upgrade.includes("unrelated note"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies: `;` is NOT a ceiling/upgrade split point (vuln.ts's upgrade text was
// truncated at the semicolon inside its parenthetical), and a wrapped "upgrade:"
// line is joined intact.
test("ponytail: semicolons do not split the upgrade text", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "v.js"),
      [
        "// ponytail: scans full lockfile (no --omit=dev flag exists; full coverage),",
        "// upgrade: add severity gating if dev-dep noise matters.",
        "x = 1",
      ].join("\n"),
    );
    const out = collectPonytailDebt(tmp);
    const row = out.rows[0];
    // spec: ceiling keeps the parenthetical (with its `;`) whole; upgrade is the
    // joined "upgrade:" line, unmangled.
    assert.equal(out.markers, 1);
    assert.equal(out.noTrigger, 0);
    assert.ok(row.ceiling.includes("; full coverage)"));
    assert.equal(row.upgrade, "upgrade: add severity gating if dev-dep noise matters.");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies: a following comment line that is itself a new `ponytail:` marker ends
// the wrap-join (a marker standing right after another must stay a separate row).
test("ponytail: a second marker on the next comment line ends the join", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "s.js"),
      [
        "// ponytail: first marker, upgrade: add maps if scale grows",
        "// ponytail: second marker, revisit when rooms exist",
        "x = 1",
      ].join("\n"),
    );
    const out = collectPonytailDebt(tmp);
    assert.equal(out.markers, 2);
    assert.ok(out.rows[0].upgrade.includes("maps"));
    assert.ok(!out.rows[0].upgrade.includes("second marker"));
    assert.ok(out.rows[1].upgrade.includes("rooms"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies: node_modules is skipped, so a marker buried there is NOT counted.
test("ponytail: skips node_modules", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.mkdirSync(path.join(tmp, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "node_modules", "dep.js"), "// ponytail: hidden\n");
    fs.writeFileSync(path.join(tmp, "b.js"), "// ponytail: visible, revisit when needed\n");
    const out = collectPonytailDebt(tmp);
    assert.equal(out.markers, 1);
    assert.ok(!out.rows.some((r) => r.file.includes("node_modules")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});