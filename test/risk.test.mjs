import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicRisk } from "../src/domain/risk.js";

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