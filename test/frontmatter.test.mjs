import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatterBlock, serializeMdFile, parseMdFile } from "../src/shared/frontmatter.js";

// Verifies: scalar values (bare/quoted string, number, int, float, boolean, null)
// are coerced to their JS types per the frontmatter-subset spec.
test("frontmatter: parses scalars to typed values", () => {
  const raw = [
    `title: "hello"`,
    "n: 42",
    "f: 3.14",
    "b: true",
    "nope: null",
  ].join("\n");
  assert.deepEqual(parseFrontmatterBlock(raw), {
    title: "hello",
    n: 42,
    f: 3.14,
    b: true,
    nope: null,
  });
});

// Verifies: a `labels: [...]` value (the task-label field) becomes an array of
// unquoted strings, elements split on commas outside quotes and stripped of quotes.
test("frontmatter: parses a string array (labels)", () => {
  const raw = "labels: [bug, \"priority\", 'docs']";
  assert.deepEqual(parseFrontmatterBlock(raw), { labels: ["bug", "priority", "docs"] });
});

// Verifies: an object-array value (the task comments field of {author,at,body}
// objects) is parsed to an array of plain objects via JSON, not flattened.
test("frontmatter: parses object-array (comments) to objects", () => {
  const raw =
    'comments: [{"author":"empress","at":"2025-09-20T00:00:00Z","body":"hi"}]';
  assert.deepEqual(parseFrontmatterBlock(raw).comments, [
    { author: "empress", at: "2025-09-20T00:00:00Z", body: "hi" },
  ]);
});

// Verifies: serialize then parse is the identity for the frontmatter subset used
// by the task store (object-array comments, labels, scalars).
// [ASSUMPTION] the body round-trips only modulo a leading-newline normalization
// (spec doesn't pin the body text exactly), so we assert the frontmatter fields.
test("frontmatter: serializeMdFile/parseMdFile round-trips the task-store shape", () => {
  const fm = {
    comments: [{ author: "empress", at: "2025-09-20T00:00:00Z", body: "hi" }],
    labels: ["core", "docs"],
    count: 3,
    active: true,
    note: "hello",
  };
  const text = serializeMdFile(fm, "body text");
  const parsed = parseMdFile(text);
  assert.deepEqual(parsed.frontmatter, fm);
  assert.match(parsed.body, /body text/);
});