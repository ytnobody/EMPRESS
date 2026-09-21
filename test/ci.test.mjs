// CI executor backend — Command Verification style tests.
// Per PFT: assert the assembled command (buildContainerArgs) and that runCi
// dispatches/falls back correctly using an injected runner — no real container.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContainerArgs, runCi, runProjectCi } from "../src/domain/ci.js";

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

// Verifies: host engine runs `sh -c <cmd>` directly (no container).
test("runCi: host runs sh -c", () => {
  const calls = [];
  const res = runCi("/p", { testCommand: "go test ./...", engine: "host", _run: (c, a) => (calls.push([c, a]), { code: 0, stdout: "ok", stderr: "" }) });
  assert.deepEqual(calls, [["sh", ["-c", "go test ./..."]]]);
  assert.deepEqual({ code: res.code, stdout: res.stdout, engine: res.engine }, { code: 0, stdout: "ok", engine: "host" });
});

// Verifies: container path probes the engine, then runs `podman run ... sh -c <cmd>`.
test("runCi: podman probes + runs container command", () => {
  const calls = [];
  const _run = (c, a) => {
    calls.push([c, a]);
    return c === "podman" && a[0] === "--version" ? { code: 0 } : { code: 0, stdout: "PASS\n", stderr: "" };
  };
  const res = runCi("/w", { testCommand: "npm test", engine: "podman", image: "node:20", network: "none", _run });
  // first call: --version probe; second: the actual container run
  assert.equal(calls[0][0], "podman");
  assert.deepEqual(calls[0][1], ["--version"]);
  assert.equal(calls[1][0], "podman");
  assert.deepEqual(calls[1][1], ["run", "--rm", "--network", "none", "-v", "/w:/project:rw", "-w", "/project", "node:20", "sh", "-c", "npm test"]);
  assert.equal(res.engine, "podman");
});

// Verifies: configured container engine that is UNAVAILABLE falls back to host `sh -c`.
test("runCi: unavailable container engine falls back to host", () => {
  const calls = [];
  const _run = (c, a) => {
    calls.push([c, a]);
    return c === "podman" && a[0] === "--version" ? { code: 1, stderr: "not found" } : { code: 0, stdout: "ok", stderr: "" };
  };
  const res = runCi("/p", { testCommand: "make test", engine: "podman", image: "i", _run });
  assert.deepEqual(calls[1], ["sh", ["-c", "make test"]]);
  assert.equal(res.engine, "host");
});

// Verifies: runProjectCi reads engine/image/network from config.
test("runProjectCi: derives engine/image/network from config", () => {
  const calls = [];
  const config = { project: { test_command: "node scripts/selfcheck.js" }, ci: { engine: "podman", image: "node:22-alpine", network: "none" } };
  runProjectCi("/repo", config, { _run: (c, a) => { calls.push([c, a]); return c === "podman" && a[0] === "--version" ? { code: 0 } : { code: 0, stdout: "", stderr: "" }; } });
  assert.equal(calls[1][0], "podman");
  assert.deepEqual(calls[1][1], ["run", "--rm", "--network", "none", "-v", "/repo:/project:rw", "-w", "/project", "node:22-alpine", "sh", "-c", "node scripts/selfcheck.js"]);
});