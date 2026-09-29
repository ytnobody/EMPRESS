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

// Verifies: an explicit "upgrade:" keyword wins over the comma-split even when a
// comma precedes it inside the ceiling (refactor.ts:33 shape): the upgrade field
// is exactly the explicit upgrade text, not a comma-slice that also carries the
// ceiling sentence. Old behavior truncated the ceiling at the first comma and
// merged the "upgrade:" line into the mangled comma-slice.
test("ponytail: explicit upgrade: keyword beats a comma earlier in the ceiling", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "r.js"),
      [
        "// ponytail: narrow-structural filter, exact behavior-line bag parity — ceiling: misses",
        "// pure relocations that tweak type-only lines (they stay HIGH),",
        "// upgrade: token-level AST comparison if those false-pure risks matter.",
        "x = 1",
      ].join("\n"),
    );
    const out = collectPonytailDebt(tmp);
    const row = out.rows[0];
    // spec: upgrade is exactly the explicit keyword body; ceiling is everything
    // before the keyword (trailing comma dropped), NOT a truncation at the first
    // comma, which sits inside the ceiling sentence.
    assert.equal(out.markers, 1);
    assert.equal(out.noTrigger, 0);
    assert.equal(row.upgrade, "upgrade: token-level AST comparison if those false-pure risks matter.");
    assert.ok(row.ceiling.includes("exact behavior-line bag parity"));
    assert.ok(row.ceiling.endsWith("(they stay HIGH)"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies: a comma inside a parenthetical is part of the ceiling, not a
// ceiling/upgrade split point (ci.ts:100 shape): the ceiling keeps the full
// parenthetical "(3 ups, matches createWorktree)" and the upgrade starts after
// it. With no explicit upgrade keyword the first comma at paren depth 0 (i.e.
// the comma after the parenthetical closes) separates the upgrade path;
// no-trigger classification (trigger present + upgrade present) is unchanged.
test("ponytail: comma inside a parenthetical stays part of the ceiling", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "c.js"),
      [
        "// ponytail: depth hardcoded to <main>/.empress/N (3 ups, matches createWorktree),",
        "// refuse rewrite when the derived main dir is absent; generalize if",
        "// EMPRESS_DIR ever gets nested or worktrees relocate.",
        "x = 1",
      ].join("\n"),
    );
    const out = collectPonytailDebt(tmp);
    const row = out.rows[0];
    // spec: ceiling keeps "(3 ups, matches createWorktree)" whole (old behavior
    // truncated it at "(3 ups"); upgrade is the rest of the joined body.
    assert.equal(out.markers, 1);
    assert.equal(out.noTrigger, 0); // "if" trigger + upgrade present -> unchanged
    assert.equal(row.ceiling, "depth hardcoded to <main>/.empress/N (3 ups, matches createWorktree)");
    assert.equal(row.upgrade, "refuse rewrite when the derived main dir is absent; generalize if EMPRESS_DIR ever gets nested or worktrees relocate.");
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

// Verifies: an explicit "upgrade:"/"Upgrade path:" paragraph that opens on a
// SEPARATE comment paragraph AFTER the marker sentence's terminal '.' is still
// joined into the marker body, so its upgrade path is captured and the marker
// is NOT falsely flagged no-trigger (taskstore/shared.ts:202 case).
test("ponytail: joins an upgrade paragraph that follows the marker sentence's terminal dot", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "t.js"),
      [
        "// ponytail: detection is marker-presence — the UUID nonce is not verified",
        "// against a registry and comments predating this change are treated as human.",
        "// Upgrade path: track posted agent comment ids (repo body metadata) if",
        "// deliberate marker forgery or rollover over pre-marker threads ever matters.",
        "x = 1",
      ].join("\n"),
    );
    const out = collectPonytailDebt(tmp);
    const row = out.rows[0];
    assert.equal(out.markers, 1);
    assert.equal(out.noTrigger, 0); // the following-paragraph upgrade path is no longer missed
    assert.ok(row.ceiling.includes("treated as human."));
    assert.ok(row.upgrade.includes("Upgrade path: track posted agent comment ids"));
    assert.ok(row.upgrade.includes("ever matters."));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies: a following standalone note with NO upgrade keyword after a marker's
// terminal '.' is still NOT swallowed into the body (sentence-boundary preserved),
// and a marker whose body carries a trigger word but genuinely names no upgrade
// path (no comma, no explicit upgrade prefix) is still flagged no-trigger.
test("ponytail: non-upgrade following note stays separate and no-upgrade markers stay flagged", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "n.js"),
      [
        "// ponytail: quick hack.",
        "// unrelated note, must not be joined",
        "x = 1",
      ].join("\n"),
    );
    const out = collectPonytailDebt(tmp);
    const row = out.rows[0];
    assert.equal(out.noTrigger, 1);
    assert.equal(row.upgrade, "(none)");
    assert.ok(!row.ceiling.includes("unrelated note"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies (issue #78): collectPonytailDebt's raw row render does NOT embed the
// full joined body and then re-append the split fields, so a continuation-upgrade
// marker (upgrade on a wrapped comment line) yields ONE copy of the upgrade/ceiling
// text with a single 'upgrade:' prefix — never 'upgrade: upgrade:' or duplicated
// paragraphs — while still naming file:line, ceiling, and upgrade as labeled fields.
test("ponytail: raw row names ceiling/upgrade once, no duplicated upgrade: prefix", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ponytail-"));
  try {
    fs.writeFileSync(
      path.join(tmp, "r.js"),
      [
        "// ponytail: spins CPU with zero output, caught only by pass_timeout.",
        "// upgrade: add per-pid sampling if pass-spinning ever matters.",
        "x = 1",
      ].join("\n"),
    );
    const out = collectPonytailDebt(tmp);
    const row = out.rows[0];
    // spec: raw = "file:line, ceiling: <once>. upgrade: <once>" — no body re-embed.
    assert.equal(out.markers, 1);
    assert.equal(out.noTrigger, 0); // trigger + explicit upgrade present
    assert.ok(!row.raw.includes("upgrade: upgrade:"), "no duplicated upgrade: prefix");
    assert.equal((row.raw.match(/upgrade:/g) || []).length, 1, "single 'upgrade:' label");
    // the joined paragraph text appears exactly once in raw, never duplicated
    assert.equal((row.raw.match(/pass_timeout\./g) || []).length, 1);
    assert.equal((row.raw.match(/add per-pid sampling/g) || []).length, 1);
    // separate labeled fields preserved: file:line + ceiling + upgrade + [no-trigger]
    assert.ok(row.raw.startsWith(`${row.file}:${row.line}, ceiling:`));
    assert.ok(row.raw.includes(". upgrade:"));
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