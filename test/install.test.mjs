// Install-in-sync gate (Task #81): the runtime copies `empress init` installs
// (.empress/agents, .pi/prompts) must stay byte-identical to their bundled
// src/ sources. Expectations derive from the spec, not the implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compareInstall, installDrift } from "../src/domain/install.ts";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "empress-install-"));
}

function write(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body);
}

test("install: compareInstall returns no drift when bytes are identical", () => {
  // Verifies: an installed copy equal to its source is in sync (empty finding).
  const src = new Map([["superintendent.md", Buffer.from("same")]]);
  const dest = new Map([["superintendent.md", Buffer.from("same")]]);
  assert.deepEqual(compareInstall(src, dest, "agents"), []);
});

test("install: compareInstall flags a byte-differing installed file as stale", () => {
  // Verifies: a stale runtime prompt (src has newer text) is reported once.
  const src = new Map([["superintendent.md", Buffer.from("new #37 dedupe text")]]);
  const dest = new Map([["superintendent.md", Buffer.from("old text")]]);
  const drift = compareInstall(src, dest, "agents");
  assert.equal(drift.length, 1);
  assert.match(drift[0], /agents: stale installed "superintendent\.md"/);
});

test("install: compareInstall flags a missing installed file", () => {
  // Verifies: a source file with no installed counterpart is drift.
  const src = new Map([["empress.md", Buffer.from("prompt")]]);
  const drift = compareInstall(src, new Map(), "prompts");
  assert.equal(drift.length, 1);
  assert.match(drift[0], /prompts: missing installed "empress\.md"/);
});

test("install: installDrift compares each source dir against its installed copy", () => {
  // Verifies: the shell reads src/agents/* (the files the installer copies) and
  // reports only the stale one; an in-sync prompts pair contributes nothing.
  const root = tmp();
  try {
    write(path.join(root, "src", "agents"), "a.md", "same");
    write(path.join(root, "src", "agents"), "b.md", "source-b");
    write(path.join(root, ".empress", "agents"), "a.md", "same");
    write(path.join(root, ".empress", "agents"), "b.md", "stale-b");
    write(path.join(root, "src", "prompts"), "empress.md", "p");
    write(path.join(root, ".pi", "prompts"), "empress.md", "p");
    const drift = installDrift([
      { label: "agents", src: path.join(root, "src", "agents"), dest: path.join(root, ".empress", "agents") },
      { label: "prompts", src: path.join(root, "src", "prompts"), dest: path.join(root, ".pi", "prompts") },
    ]);
    assert.deepEqual(drift, ['agents: stale installed "b.md"']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
