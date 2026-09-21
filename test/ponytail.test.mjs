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