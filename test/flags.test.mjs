import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "../src/cli/main.js";

// Verifies: a string-valued flag consumes the next arg greedily even when it
// starts with `-` (the convention `--acceptance "- [ ] one\n- [ ] two"`), so
// the value is a string, not boolean true, and never leaks into positionals.
test("flags: dash-prefixed value is consumed as a flag value, not a positional", () => {
  const o = parseFlags(["T", "--acceptance", "- [ ] one\n- [ ] two"]);
  assert.equal(o.acceptance, "- [ ] one\n- [ ] two");
  assert.equal(typeof o.acceptance, "string");
  assert.deepEqual(o._, ["T"]);
});

// Verifies: an acceptance value that begins with `--` is also consumed, so a
// value can never be re-parsed as a flag switch.
test("flags: double-dash-prefixed value is consumed as a value", () => {
  const o = parseFlags(["T", "--acceptance", "--verbose"]);
  assert.equal(o.acceptance, "--verbose");
  assert.deepEqual(o._, ["T"]);
});

// Verifies: `--flag=value` assignment stays unchanged for string flags.
test("flags: --flag=value form is unchanged", () => {
  const o = parseFlags(["T", "--acceptance=- [ ] eq"]);
  assert.equal(o.acceptance, "- [ ] eq");
  assert.deepEqual(o._, ["T"]);
});

// Verifies: multiple positionals are still collected into `_` even when a
// string-valued flag also uses the space form.
test("flags: multiple positionals still collected in _", () => {
  const o = parseFlags(["A", "B", "--purpose", "why"]);
  assert.equal(o.purpose, "why");
  assert.deepEqual(o._, ["A", "B"]);
});

// Verifies: boolean flags keep their bare-flag semantics — no value consumed,
// no positional swallowed, no token silently dropped.
test("flags: boolean whitelist keeps working (no value consumption)", () => {
  const o = parseFlags(["T", "--list", "--force", "--once"]);
  assert.equal(o.list, true);
  assert.equal(o.force, true);
  assert.equal(o.once, true);
  assert.deepEqual(o._, ["T"]);
});

// Verifies: every input token is accounted for — no token silently dropped.
// Greedy string consumption never discards a token; a value is always placed.
test("flags: no token silently dropped", () => {
  const o = parseFlags(["T", "--scope", "S", "--acceptance", "- ok", "P"]);
  assert.equal(o.scope, "S");
  assert.equal(o.acceptance, "- ok");
  assert.deepEqual(o._, ["T", "P"]);
});