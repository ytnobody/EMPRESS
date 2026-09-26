import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseToml, mergeConfig, resolveProjectRoot } from "../src/shared/config.js";

// Verifies: the TOML-subset parser turns `[section]` headers plus `key = value`
// scalars into one nested object, ignoring `#` comments and blank lines.
test("config: parseToml read a section + scalar into a nested object", () => {
  const toml = [
    "# a comment",
    "[project]",
    'base_branch = "main"',
    "",
    "[risk]",
    "use_jev = false",
  ].join("\n");
  assert.deepEqual(parseToml(toml), {
    project: { base_branch: "main" },
    risk: { use_jev: false },
  });
});

// Verifies: deep merge overrides nested scalar keys while preserving untouched
// nested defaults; independent subtrees merge independently.
test("config: mergeConfig deep-merges nested sections over defaults", () => {
  const base = {
    project: { base_branch: "main", language: "en" },
    agent: { max_engineers: 4, loop_interval: 120 },
  };
  const over = { project: { base_branch: "develop" }, agent: { max_engineers: 2 } };
  assert.deepEqual(mergeConfig(base, over), {
    project: { base_branch: "develop", language: "en" },
    agent: { max_engineers: 2, loop_interval: 120 },
  });
});

// Verifies: array values are replaced wholesale (marked by `[`/`]`), so the
// merged arrays come from the override alone, not concatenated with defaults.
test("config: mergeConfig replaces arrays wholesale", () => {
  const base = { risk: { high_paths: ["a", "b"] } };
  const over = { risk: { high_paths: ["z"] } };
  assert.deepEqual(mergeConfig(base, over).risk.high_paths, ["z"]);
});

// Verifies: resolveProjectRoot returns the dir whose `.empress/empress.toml`
// marks the project root, even when called from a deeper worktree subdir.
test("config: resolveProjectRoot walks up to .empress/empress.toml marker", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "empress-root-"));
  try {
    fs.mkdirSync(path.join(tmp, ".empress"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".empress", "empress.toml"), "[project]\n");
    const worktree = path.join(tmp, ".empress", "worktrees", "2");
    fs.mkdirSync(worktree, { recursive: true });
    assert.equal(resolveProjectRoot(worktree), tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Verifies: the [models] section parses into the per-role defaults and an
// override keeps the other role's default (both default to "" = pi's model).
test("config: [models] per-role overrides default to empty (pi default)", () => {
  const parsed = parseToml("[models]\nsuperintendent = \"anthropic/claude-sonnet-4-5\"\nengineer = \"\"\n");
  const merged = mergeConfig({ models: { superintendent: "", engineer: "" } }, parsed);
  assert.deepEqual(merged.models, {
    superintendent: "anthropic/claude-sonnet-4-5",
    engineer: "",
  });
});

// Verifies: [github] is disabled by default and only becomes active when the
// config opts in — the whole merge keeps the other defaults intact.
test("config: [github] integration is opt-in (disabled by default)", () => {
  const merged = mergeConfig(
    { github: { enabled: false, owner: "", repo: "" } },
    parseToml("[github]\nenabled = true\nowner = \"acme\"\n")
  );
  assert.deepEqual(merged.github, { enabled: true, owner: "acme", repo: "" });
  assert.equal(
    mergeConfig({ github: { enabled: false, owner: "", repo: "" } }, parseToml("[github]\n")).github.enabled,
    false
  );
});