// CI executor backend — Command Verification style tests.
// Per PFT: assert the assembled command (buildContainerArgs) and that runCi
// dispatches/falls back correctly using an injected runner — no real container.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContainerArgs, runCi, runProjectCi, nodeModulesExtraMount, depsRelinkRepair, decidePreflight, nodeModulesHealthy } from "../src/domain/ci.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Verifies: podman args are {run --rm, mount :rw, workdir /project, image}.
test("buildContainerArgs: podman mounts project rw and sets /project workdir", () => {
  const { bin, args } = buildContainerArgs({ engine: "podman", image: "node:22-alpine", network: "default", projectPath: "/repo/.empress/worktrees/3" });
  assert.equal(bin, "podman");
  assert.deepEqual(args, ["run", "--rm", "-v", "/repo/.empress/worktrees/3:/project:rw", "-w", "/project", "node:22-alpine"]);
});

// Verifies: docker engine uses the docker binary with identical mount semantics.
test("buildContainerArgs: docker uses docker bin", () => {
  const { bin, args } = buildContainerArgs({ engine: "docker", image: "img", network: "default", projectPath: "/p" });
  assert.equal(bin, "docker");
  assert.ok(args.includes("/p:/project:rw"));
});

// Verifies: network none / host add their flags; default bridge adds none.
test("buildContainerArgs: network flag selection", () => {
  assert.deepEqual(buildContainerArgs({ engine: "podman", image: "i", network: "none", projectPath: "/p" }).args, ["run", "--rm", "--network", "none", "-v", "/p:/project:rw", "-w", "/project", "i"]);
  assert.deepEqual(buildContainerArgs({ engine: "podman", image: "i", network: "host", projectPath: "/p" }).args, ["run", "--rm", "--network", "host", "-v", "/p:/project:rw", "-w", "/project", "i"]);
  assert.ok(!buildContainerArgs({ engine: "podman", image: "i", network: "default", projectPath: "/p" }).args.includes("--network"));
});

// Verifies: no test_command is a cheap no-op (exit 0), regardless of engine.
test("runCi: no test_command no-ops", () => {
  const calls = [];
  const res = runCi("/p", { testCommand: "", engine: "podman", image: "i", _run: (c, a) => (calls.push([c, a]), { code: 0, stdout: "", stderr: "" }) });
  assert.equal(res.code, 0);
  assert.equal(calls.length, 0);
});

// Verifies: host engine probes host git, then runs `sh -c <cmd>` directly.
test("runCi: host runs sh -c", () => {
  const calls = [];
  const res = runCi("/p", { testCommand: "go test ./...", engine: "host", _run: (c, a) => (calls.push([c, a]), { code: 0, stdout: "ok", stderr: "" }) });
  const shCall = calls.find(([c, a]) => c === "sh" && a[0] === "-c");
  assert.deepEqual(shCall, ["sh", ["-c", "go test ./..."]]);
  assert.deepEqual({ code: res.code, stdout: res.stdout, engine: res.engine }, { code: 0, stdout: "ok", engine: "host" });
});

// Verifies: container path probes the engine (--version), then git in the image,
// then runs `podman run ... sh -c <cmd>`.
test("runCi: podman probes + runs container command", () => {
  const calls = [];
  const _run = (c, a) => {
    calls.push([c, a]);
    return c === "podman" && a[0] === "--version" ? { code: 0 } : { code: 0, stdout: "PASS\n", stderr: "" };
  };
  const res = runCi("/w", { testCommand: "npm test", engine: "podman", image: "node:20", network: "none", _run });
  // first call: --version probe
  assert.equal(calls[0][0], "podman");
  assert.deepEqual(calls[0][1], ["--version"]);
  // git-in-image probe
  const gitProbe = calls.find(([c, a]) => c === "podman" && a.includes("git") && a.includes("--version"));
  assert.deepEqual(gitProbe[1], ["run", "--rm", "node:20", "git", "--version"]);
  // the actual container test run
  const runCall = calls.find(([c, a]) => c === "podman" && a[0] === "run" && a.includes("sh"));
  assert.equal(runCall[0], "podman");
  assert.deepEqual(runCall[1], ["run", "--rm", "--network", "none", "-v", "/w:/project:rw", "-w", "/project", "node:20", "sh", "-c", "npm test"]);
  assert.equal(res.engine, "podman");
});

// Verifies: configured container engine that is UNAVAILABLE falls back to host
// (no git-in-image probe; host git probe then `sh -c`).
test("runCi: unavailable container engine falls back to host", () => {
  const calls = [];
  const _run = (c, a) => {
    calls.push([c, a]);
    return c === "podman" && a[0] === "--version" ? { code: 1, stderr: "not found" } : { code: 0, stdout: "ok", stderr: "" };
  };
  const res = runCi("/p", { testCommand: "make test", engine: "podman", image: "i", _run });
  const hostSh = calls.find(([c, a]) => c === "sh" && a[0] === "-c");
  assert.deepEqual(hostSh, ["sh", ["-c", "make test"]]);
  assert.equal(res.engine, "host");
});

// Verifies: runProjectCi reads engine/image/network from config.
test("runProjectCi: derives engine/image/network from config", () => {
  const calls = [];
  const config = { project: { test_command: "node scripts/selfcheck.js" }, ci: { engine: "podman", image: "node:22-alpine", network: "none" } };
  runProjectCi("/repo", config, { _run: (c, a) => { calls.push([c, a]); return c === "podman" && a[0] === "--version" ? { code: 0 } : { code: 0, stdout: "", stderr: "" }; } });
  const runCall = calls.find(([c, a]) => c === "podman" && a[0] === "run" && a.includes("sh"));
  assert.equal(runCall[0], "podman");
  assert.deepEqual(runCall[1], ["run", "--rm", "--network", "none", "-v", "/repo:/project:rw", "-w", "/project", "node:22-alpine", "sh", "-c", "node scripts/selfcheck.js"]);
});
// Verifies: nodeModulesExtraMount resolves a worktree node_modules symlink to a
// /deps mount (NOT /project/node_modules — the OCI runtime fails openat2 when the
// bind target is a host-absolute symlink).
test("nodeModulesExtraMount: symlink -> /deps ro mount of the real dir", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-nm-"));
  const real = path.join(base, "real");
  fs.mkdirSync(real);
  fs.mkdirSync(path.join(base, "worktree"), { recursive: true });
  fs.symlinkSync(real, path.join(base, "worktree", "node_modules"), "dir");
  const mounts = nodeModulesExtraMount(path.join(base, "worktree"));
  assert.equal(mounts.length, 1);
  assert.deepEqual(mounts[0], { host: real, container: "/deps", mode: "ro" });
});

// Verifies: no symlink -> no extra mount.
test("nodeModulesExtraMount: missing/plain node_modules -> []", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-nm2-"));
  assert.deepEqual(nodeModulesExtraMount(base), []);
});

// Verifies: runCi prefixes the container command with the relink when deps are mounted.
test("runCi: deps mount prepends the /project/node_modules relink", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pfx-"));
  fs.mkdirSync(path.join(base, "real"));
  fs.mkdirSync(path.join(base, "wt"), { recursive: true });
  fs.symlinkSync(path.join(base, "real"), path.join(base, "wt", "node_modules"), "dir");
  const calls = [];
  const _run = (c, a) => { calls.push([c, a]); return c === "podman" && a[0] === "--version" ? { code: 0 } : { code: 0, stdout: "", stderr: "" }; };
  runCi(path.join(base, "wt"), { testCommand: "bun scripts/selfcheck.ts", engine: "podman", image: "oven/bun:1.4-alpine", _run });
  const shCall = calls.find(([c, a]) => c === "podman" && a[0] === "run" && a.includes("sh"));
  const shIndex = shCall[1].lastIndexOf("sh");
  assert.equal(shCall[1][shIndex + 1], "-c");
  assert.equal(shCall[1][shIndex + 2], "rm -f /project/node_modules && ln -s /deps /project/node_modules && bun scripts/selfcheck.ts");
});

// ---------------------------------------------------------------------------
// Task 05: self-healing of the deps-relink write-back. The container relink
// (rm /project/node_modules && ln -s /deps ...) writes THROUGH the rw mount and
// leaves the HOST worktree symlink pointing at /deps (realpath ENOENT on host).
// Fix: depsRelinkRepair decides the rewrite target (pure decision), runCi applies
// it before (so this run can mount) and after (so the invariant holds on return).
// ---------------------------------------------------------------------------

function makeWorktreeFixture(symlinkTarget) {
  // layout: <base>/main/node_modules (real dir), <base>/main/.empress/worktrees/<n>
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-heal-"));
  const main = path.join(base, "main");
  const mainNm = path.join(main, "node_modules");
  fs.mkdirSync(mainNm, { recursive: true });
  const wt = path.join(main, ".empress", "worktrees", "9");
  fs.mkdirSync(wt, { recursive: true });
  if (symlinkTarget !== null) fs.symlinkSync(symlinkTarget, path.join(wt, "node_modules"), "dir");
  return { base, main, mainNm, wt };
}

// Verifies: a symlink left pointing at /deps by a previous container relink is
// recognized as poisoned, and the decided rewrite target is the main repo's real
// node_modules dir (= <wt>/../../.. + /node_modules, the documented layout) —
// derived from the layout spec, so a future implementation drift is caught.
test("depsRelinkRepair: /deps-poisoned link -> main repo node_modules target", () => {
  const { wt, mainNm } = makeWorktreeFixture("/deps");
  assert.equal(depsRelinkRepair(wt), mainNm);
});

// Verifies: a healthy worktree link (target = main node_modules) needs no rewrite.
test("depsRelinkRepair: valid symlink -> null (no rewrite)", () => {
  const { wt, mainNm } = makeWorktreeFixture(null);
  fs.symlinkSync(mainNm, path.join(wt, "node_modules"), "dir");
  assert.equal(depsRelinkRepair(wt), null);
});

// Verifies: no symlink or a plain dir node_modules needs no rewrite.
test("depsRelinkRepair: missing / plain node_modules -> null", () => {
  const { base, wt } = makeWorktreeFixture(null);
  assert.equal(depsRelinkRepair(wt), null);
  fs.mkdirSync(path.join(wt, "node_modules"));
  assert.equal(depsRelinkRepair(wt), null);
  assert.equal(depsRelinkRepair(base), null);
});

// Verifies: poisoning is not rewritten to a fabricated target when the derived
// main node_modules dir does not exist — leave the link alone (mount discovery
// then degrades to [] as before).
test("depsRelinkRepair: poisoned but main node_modules missing -> null", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-heal-"));
  const wt = path.join(base, "main", ".empress", "worktrees", "9");
  fs.mkdirSync(wt, { recursive: true });
  fs.symlinkSync("/deps", path.join(wt, "node_modules"), "dir");
  assert.equal(depsRelinkRepair(wt), null);
});

// Verifies (acceptance criterion, consecutive runs): a SECOND runCi call on a
// worktree whose host symlink was poisoned by run #1 (fixture pre-set to /deps)
// still resolves the mount and emits the relink-prefixed container command — i.e.
// the pre-run heal restores mount discovery, so 'tsc not found' cannot recur.
test("runCi: second consecutive run after poisoning still emits the deps relink", () => {
  const { wt, mainNm } = makeWorktreeFixture("/deps");
  const calls = [];
  const _run = (c, a) => {
    calls.push([c, a]);
    return c === "podman" && a[0] === "--version" ? { code: 0 } : { code: 0, stdout: "", stderr: "" };
  };
  runCi(wt, { testCommand: "bun scripts/selfcheck.ts", engine: "podman", image: "oven/bun:1.4-alpine", _run });
  const shCall = calls.find(([c, a]) => c === "podman" && a[0] === "run" && a.includes("sh"));
  assert.ok(shCall, "container run was issued");
  const shIndex = shCall[1].lastIndexOf("sh");
  assert.equal(shCall[1][shIndex + 2], "rm -f /project/node_modules && ln -s /deps /project/node_modules && bun scripts/selfcheck.ts");
  // and after this run the host link is healthy again (post-run heal)
  assert.equal(fs.realpathSync(path.join(wt, "node_modules")), fs.realpathSync(mainNm));
});

// Verifies (acceptance criterion, host invariant): when a container run writes
// /deps back through the rw mount mid-run (simulated by the injected runner),
// runCi restores the HOST worktree symlink to the main repo's real node_modules
// dir before returning — host selfcheck stays green between runs.
test("runCi: post-run restore leaves host symlink resolving to main node_modules", () => {
  const { wt, mainNm } = makeWorktreeFixture(null);
  fs.symlinkSync(mainNm, path.join(wt, "node_modules"), "dir"); // healthy pre-state
  const _run = (c, a) => {
    if (c === "podman" && a[0] !== "--version") {
      // simulate the container relink writing through the rw mount:
      const nm = path.join(wt, "node_modules");
      fs.rmSync(nm, { force: true });
      fs.symlinkSync("/deps", nm, "dir");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  runCi(wt, { testCommand: "bun scripts/selfcheck.ts", engine: "podman", image: "oven/bun:1.4-alpine", _run });
  // the injected runner poisoned the host link mid-run; runCi must have restored it
  assert.equal(fs.realpathSync(path.join(wt, "node_modules")), fs.realpathSync(mainNm));
});

// ---------------------------------------------------------------------------
// Task 31: CI environment preflight (git-or-skip, symlink health, deps heal).
// Before a container run the preflight heals task #5's /deps write-back and
// reports git availability + deps health so infra-caused failures are not
// reported as code failures.
// ---------------------------------------------------------------------------

// Verifies: decidePreflight is a pure flip — git absent OR deps unresolvable
// makes a run skip-eligible (infra-caused); engine readiness does not.
test("decidePreflight: git-absent or deps-unhealthy => skipEligible", () => {
  const clean = decidePreflight({ engineReady: true, gitAvailable: true, depsHealthy: true, healed: false });
  assert.equal(clean.skipEligible, false);
  const noGit = decidePreflight({ engineReady: true, gitAvailable: false, depsHealthy: true, healed: false });
  assert.equal(noGit.skipEligible, true);
  const noDeps = decidePreflight({ engineReady: true, gitAvailable: true, depsHealthy: false, healed: false });
  assert.equal(noDeps.skipEligible, true);
  // engine unavailability is NOT a skip condition (host fallback is trusted).
  const noEngine = decidePreflight({ engineReady: false, gitAvailable: true, depsHealthy: true, healed: false });
  assert.equal(noEngine.skipEligible, false);
  // healed flag is reported through transparently.
  assert.equal(noGit.healed, false);
});

// Verifies: nodeModulesHealthy returns true for a symlink resolving to a real
// dir, and false for a poisoned /deps link (realpath ENOENT) or missing name.
test("nodeModulesHealthy: resolvable link true, /deps-poisoned/missing false", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pf-"));
  const mainNm = path.join(base, "main");
  fs.mkdirSync(mainNm, { recursive: true });
  const wt = path.join(base, "wt");
  fs.mkdirSync(wt, { recursive: true });
  // healthy symlink -> real dir
  fs.symlinkSync(mainNm, path.join(wt, "node_modules"), "dir");
  assert.equal(nodeModulesHealthy(wt), true);
  // poisoned /deps link -> false
  fs.rmSync(path.join(wt, "node_modules"));
  fs.symlinkSync("/deps", path.join(wt, "node_modules"), "dir");
  assert.equal(nodeModulesHealthy(wt), false);
  // missing -> false
  fs.rmSync(path.join(wt, "node_modules"));
  assert.equal(nodeModulesHealthy(wt), false);
  // a plain real dir is healthy too
  fs.mkdirSync(path.join(wt, "node_modules"));
  assert.equal(nodeModulesHealthy(wt), true);
});

// Verifies: the container path probes git INSIDE the image (a deterministic
// preflight probe) before the test run; with git present + deps healthy it is
// NOT skip-eligible and the normal relink-prefixed container command runs.
test("runCi: container path emits a git-in-image probe; clean => not skip-eligible", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pf2-"));
  fs.mkdirSync(path.join(base, "real"));
  fs.mkdirSync(path.join(base, "wt"), { recursive: true });
  fs.symlinkSync(path.join(base, "real"), path.join(base, "wt", "node_modules"), "dir");
  const calls = [];
  const _run = (c, a) => {
    calls.push([c, a]);
    if (c === "podman" && a[0] === "--version") return { code: 0 };
    if (c === "podman" && a.includes("git")) return { code: 0 }; // git present in image
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = runCi(path.join(base, "wt"), { testCommand: "bun t", engine: "podman", image: "oven/bun:1.4-alpine", _run });
  const gitProbe = calls.find(([c, a]) => c === "podman" && a.includes("git") && a.includes("--version"));
  assert.deepEqual(gitProbe[1], ["run", "--rm", "oven/bun:1.4-alpine", "git", "--version"]);
  const runCall = calls.find(([c, a]) => c === "podman" && a[0] === "run" && a.includes("sh"));
  assert.ok(runCall, "container test run issued");
  assert.equal(res.preflight.gitAvailable, true);
  assert.equal(res.preflight.depsHealthy, true);
  assert.equal(res.preflight.skipEligible, false);
});

// Verifies: when the git probe fails (image lacks git — task #4), the run is
// classified skip-eligible (infra-caused) but the test still executes (no silent
// gate weakening — classification only, test semantics unchanged).
test("runCi: image git-absent => skipEligible, run still attempted", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pf3-"));
  fs.mkdirSync(path.join(base, "real"));
  fs.mkdirSync(path.join(base, "wt"), { recursive: true });
  fs.symlinkSync(path.join(base, "real"), path.join(base, "wt", "node_modules"), "dir");
  const calls = [];
  const _run = (c, a) => {
    calls.push([c, a]);
    if (c === "podman" && a[0] === "--version") return { code: 0 };
    if (c === "podman" && a.includes("git")) return { code: 1, stderr: "git: not found" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = runCi(path.join(base, "wt"), { testCommand: "bun t", engine: "podman", image: "oven/bun:1.4-alpine", _run });
  assert.equal(res.preflight.gitAvailable, false);
  assert.equal(res.preflight.skipEligible, true);
  const runCall = calls.find(([c, a]) => c === "podman" && a[0] === "run" && a.includes("sh"));
  assert.ok(runCall, "test run was still attempted despite missing git");
});

// Verifies: missing/unresolvable deps => skipEligible on the host fallback path
// too; run still proceeds with plain `sh -c`.
test("runCi: unresolvable deps => skipEligible, host fallback reports it", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pf4-"));
  const calls = [];
  const _run = (c, a) => { calls.push([c, a]); return { code: 0, stdout: "ok", stderr: "" }; };
  const res = runCi(base, { testCommand: "go test", engine: "host", _run });
  assert.equal(res.preflight.depsHealthy, false);
  assert.equal(res.preflight.skipEligible, true);
  assert.ok(calls.some(([c, a]) => c === "sh" && a[0] === "-c" && a[1] === "go test"));
});

// Verifies: a /deps-poisoned symlink is healed (task #5) during preflight so the
// same run is reported deps-healthy, and healed=true.
test("runCi: preflight heals /deps-poisoned link before probing deps", () => {
  const { wt, mainNm } = makeWorktreeFixture("/deps");
  const calls = [];
  const _run = (c, a) => {
    calls.push([c, a]);
    if (c === "podman" && a[0] === "--version") return { code: 0 };
    if (c === "podman" && a.includes("git")) return { code: 0 };
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = runCi(wt, { testCommand: "bun t", engine: "podman", image: "oven/bun:1.4-alpine", _run });
  assert.equal(res.preflight.healed, true);
  assert.equal(res.preflight.depsHealthy, true);
  assert.equal(res.preflight.skipEligible, false);
  // post-run restore also holds the host invariant
  assert.equal(fs.realpathSync(path.join(wt, "node_modules")), fs.realpathSync(mainNm));
});

// Verifies: runProjectCi returns the preflight report (so callers can attribute
// env-caused failures) alongside engine.
test("runProjectCi: returns preflight report", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ci-pf5-"));
  const config = { project: { test_command: "node t.js" }, ci: { engine: "podman", image: "node:22-alpine", network: "none" } };
  const calls = [];
  const _run = (c, a) => {
    calls.push([c, a]);
    if (c === "podman" && a[0] === "--version") return { code: 0 };
    if (c === "podman" && a.includes("git")) return { code: 0 };
    return { code: 0, stdout: "", stderr: "" };
  };
  const res = runProjectCi(base, config, { _run });
  assert.ok(res.preflight, "preflight present on runProjectCi result");
  assert.equal(typeof res.preflight.skipEligible, "boolean");
});