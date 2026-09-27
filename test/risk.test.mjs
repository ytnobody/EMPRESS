import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicRisk, withPureRefactorDowngrade } from "../src/domain/risk.js";

const cfg = {
  high_paths: ["src/extension/", "src/cli/", "src/shared/", "scripts/"],
  medium_paths: ["src/domain/"],
  high_file_threshold: 20,
  high_line_threshold: 500,
  medium_file_threshold: 10,
  medium_line_threshold: 200,
};

// Verifies: a small diff on a non-listed path under every threshold is LOW.
test("risk: small, non-listed diff is LOW", () => {
  const r = deterministicRisk(
    { files: 1, insertions: 5, deletions: 0, changed: ["README.md"] },
    cfg,
  );
  assert.equal(r.level, "LOW");
  assert.deepEqual(r.reasons, []);
});

// Verifies: touching a high-path prefix is HIGH immediately, regardless of size.
test("risk: a high-path hit is HIGH", () => {
  const r = deterministicRisk(
    { files: 1, insertions: 1, deletions: 0, changed: ["src/extension/empress.ts"] },
    cfg,
  );
  assert.equal(r.level, "HIGH");
  assert.match(r.reasons[0], /high-risk path/);
});

// Verifies: crossing the high file threshold alone is HIGH.
test("risk: file count at/over the high threshold is HIGH", () => {
  const r = deterministicRisk(
    { files: 25, insertions: 0, deletions: 0, changed: ["a.js"] },
    cfg,
  );
  assert.equal(r.level, "HIGH");
});

// Verifies: a HIGH result that the detector proves a behavior-preserving pure refactor
// is downgraded to non-HIGH (MEDIUM) with a reason, so a pure relocation auto-lands
// after full review instead of blocking on human sign-off.
test("risk: mechanically-proven pure refactor downgrades HIGH to MEDIUM", () => {
  const det = deterministicRisk(
    { files: 1, insertions: 700, deletions: 690, changed: ["src/extension/tools/a.ts"] },
    cfg,
  );
  assert.equal(det.level, "HIGH");
  const out = withPureRefactorDowngrade(det, { pure: true, reasons: [] });
  assert.equal(out.level, "MEDIUM");
  assert.ok(out.reasons.some((r) => /pure refactor/.test(r)));
});

// Verifies: a HIGH whose detector verdict is NOT pure (real behavior difference) is
// left HIGH and never auto-landed.
test("risk: non-pure HIGH stays HIGH (real behavior difference blocks auto-land)", () => {
  const det = deterministicRisk(
    { files: 1, insertions: 700, deletions: 690, changed: ["src/shared/config.ts"] },
    cfg,
  );
  assert.equal(det.level, "HIGH");
  const out = withPureRefactorDowngrade(det, { pure: false, reasons: ["behavior lines not purely relocated"] });
  assert.equal(out.level, "HIGH");
  assert.equal(out.reasons.length, det.reasons.length);
});

// Verifies: a downgrade leaves a non-HIGH result untouched (never raises or alters it).
test("risk: non-HIGH results pass through the downgrade unchanged", () => {
  const det = deterministicRisk(
    { files: 1, insertions: 5, deletions: 0, changed: ["README.md"] },
    cfg,
  );
  assert.equal(det.level, "LOW");
  const out = withPureRefactorDowngrade(det, { pure: true, reasons: [] });
  assert.equal(out.level, "LOW");
  assert.equal(out.reasons.length, 0);
});

// Verifies: touching a medium-path prefix (below high thresholds) is MEDIUM.
test("risk: a medium-path hit is MEDIUM", () => {
  const r = deterministicRisk(
    { files: 1, insertions: 5, deletions: 0, changed: ["src/domain/risk.js"] },
    cfg,
  );
  assert.equal(r.level, "MEDIUM");
});

// Verifies: crossing a medium line threshold (below high) is MEDIUM.
test("risk: medium line threshold crossing is MEDIUM", () => {
  const r = deterministicRisk(
    { files: 2, insertions: 250, deletions: 0, changed: ["src/foo.js"] },
    cfg,
  );
  assert.equal(r.level, "MEDIUM");
  assert.match(r.reasons[0], /lines changed/);
});