import { test } from "node:test";
import assert from "node:assert/strict";
import { detectPureRefactor } from "../src/domain/refactor.js";

// ---- PURE REFACTOR: a clean relocation must be flagged pure ----

// Verifies: moving one exported function verbatim from fileA.ts into a new fileB.ts
// (leaving a re-export) preserves export surface, registerTool names, and has no
// behavior-only hunks -> pure. Export set before {openA,openB} == after {openA,openB}
// (openB re-exported). Behavior lines are verbatim moves with no net-new statement.
test("refactor: verbatim function relocation is a pure refactor", () => {
  const files = [
    {
      path: "src/a.ts",
      before: [
        "export function openA(): number {",
        "  const x = 1;",
        "  return x + 1;",
        "}",
        "export function openB(): number {",
        "  return 2;",
        "}",
      ].join("\n"),
      after: [
        "export function openA(): number {",
        "  const x = 1;",
        "  return x + 1;",
        "}",
        "export { openB } from \"./b.ts\";",
      ].join("\n"),
    },
    {
      path: "src/b.ts",
      before: "",
      after: [
        "export function openB(): number {",
        "  return 2;",
        "}",
      ].join("\n"),
    },
  ];
  const v = detectPureRefactor(files);
  assert.equal(v.pure, true, v.reasons.join("; "));
  assert.deepEqual(v.reasons, []);
});

// Verifies: moving a tool registration verbatim between files keeps the registerTool
// name set unchanged (alpha only before and after) -> export/tool/behavior all conserved.
test("refactor: relocated registerTool with unchanged name set is pure", () => {
  const files = [
    {
      path: "src/all.ts",
      before: `import { register } from "./x.ts";\nregister({ name: "alpha" });`,
      after: `import { register } from "./y.ts";\nregister({ name: "alpha" });`,
    },
    {
      path: "src/x.ts",
      before: `export function register(x) {\n  return x;\n}`,
      after: "",
    },
    {
      path: "src/y.ts",
      before: "",
      after: `export function register(x) {\n  return x;\n}`,
    },
  ];
  const v = detectPureRefactor(files);
  assert.equal(v.pure, true, v.reasons.join("; "));
});

// Verifies: a re-export-only surface change (openB exported from b.ts rather than
// defined in a.ts) preserves the union export surface {openA,openB} -> still pure.
test("refactor: split with re-export preserves union export surface", () => {
  const files = [
    {
      path: "src/a.ts",
      before: `export function openA() {\n  return 1;\n}\nexport function openB() {\n  return 2;\n}`,
      after: `export function openA() {\n  return 1;\n}\nexport { openB } from "./b.ts";`,
    },
    {
      path: "src/b.ts",
      before: "",
      after: `export function openB() {\n  return 2;\n}`,
    },
  ];
  const v = detectPureRefactor(files);
  assert.equal(v.pure, true, v.reasons.join("; "));
});

// ---- REAL BEHAVIOR CHANGES: must stay non-pure (fail-safe) ----

// Verifies: changing a function body (return a+b -> return a*b) without any export or
// tool surface change still fails the no-behavior-hunks check -> not pure (stays HIGH).
test("refactor: altered arithmetic inside a moved body is NOT pure", () => {
  const files = [
    {
      path: "src/calc.ts",
      before: `export function mul(a, b) {\n  return a + b;\n}`,
      after: `export function mul(a, b) {\n  return a * b;\n}`,
    },
  ];
  const v = detectPureRefactor(files);
  assert.equal(v.pure, false);
  assert.ok(v.reasons.some((r) => /behavior/.test(r)));
});

// Verifies: a brand-new exported entry point with no matching removal changes the
// export surface -> not pure.
test("refactor: added exported function changes export surface", () => {
  const files = [
    {
      path: "src/a.ts",
      before: `export function openA() {\n  return 1;\n}`,
      after: `export function openA() {\n  return 1;\n}\nexport function openB() {\n  return 2;\n}`,
    },
  ];
  const v = detectPureRefactor(files);
  assert.equal(v.pure, false);
  assert.ok(v.reasons.some((r) => /export/.test(r)));
});

// Verifies: adding a NEW registerTool name (alpha -> alpha,beta) changes the tool set.
test("refactor: added registerTool name changes the tool set", () => {
  const files = [
    {
      path: "src/a.ts",
      before: `registerTool({ name: "alpha" });`,
      after: `registerTool({ name: "alpha" });\nregisterTool({ name: "beta" });`,
    },
  ];
  const v = detectPureRefactor(files);
  assert.equal(v.pure, false);
  assert.ok(v.reasons.some((r) => /registerTool/.test(r)));
});

// Verifies: net-new executable statement (log side-effect) appended with no matching
// removal is a behavior-only hunk -> not pure.
test("refactor: net-new behavior line is not pure", () => {
  const files = [
    {
      path: "src/a.ts",
      before: `export function go() {\n  return 1;\n}`,
      after: `export function go() {\n  return 1;\n  console.log("side effect");\n}`,
    },
  ];
  const v = detectPureRefactor(files);
  assert.equal(v.pure, false);
  assert.ok(v.reasons.some((r) => /behavior/.test(r)));
});

// Verifies: deleting an exported function without relocating it changes export surface.
test("refactor: removed export is not pure", () => {
  const files = [
    { path: "src/a.ts", before: `export function openA() {\n  return 1;\n}\nexport function openB() {\n  return 2;\n}`, after: `export function openA() {\n  return 1;\n}` },
  ];
  const v = detectPureRefactor(files);
  assert.equal(v.pure, false);
  assert.ok(v.reasons.some((r) => /export/.test(r)));
});