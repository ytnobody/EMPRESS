// CI executor backend, native to EMPRESS.
//
// The "CI" is the project's configured test_command run as a gate before a
// branch is landed. This module lets that gate run either on the HOST or inside
// an isolated container (podman/docker), selected by `[ci] engine` in
// `empress.toml`. If a container engine is configured but unavailable, it falls
// back to the host (the same graceful-degradation pattern as Jev).
//
// Design (Pure Function Testing): `buildContainerArgs` is a pure function
// (Command verification — assert the assembled command, don't execute it). The
// only side effect is the process spawn, which is injectable (`_run`) so tests
// never touch a real container.

import { run } from "../shared/shell.ts";
import type { RunOpts, RunResult } from "../shared/shell.ts";

export const CI_ENGINES = ["host", "podman", "docker"];

type ContainerEngine = "podman" | "docker";
type CiRunner = (cmd: string, args: string[], opts?: RunOpts) => RunResult;

/** Pure: the container-engine args for running the gate in a container. */
export function buildContainerArgs(o: {
  engine: ContainerEngine;
  image?: string;
  network?: string;
  projectPath: string;
}): { bin: string; args: string[] } {
  const { engine, image, network = "default", projectPath } = o;
  const bin = engine === "docker" ? "docker" : "podman";
  const args = ["run", "--rm"];
  if (network === "none") args.push("--network", "none");
  else if (network === "host") args.push("--network", "host");
  // default bridge: no flag needed
  args.push("-v", `${projectPath}:/project:rw`, "-w", "/project");
  if (image) args.push(image);
  return { bin, args };
}

/**
 * Run the CI gate. Dispatches by engine; falls back to host when a configured
 * container engine is unavailable. Never throws (returns {code, stdout, stderr}).
 */
export function runCi(
  cwd: string,
  opts: {
    testCommand?: string;
    engine?: string;
    image?: string;
    network?: string;
    _run?: CiRunner;
  }
): { code: number; stdout: string; stderr: string; engine: string } {
  const { testCommand, engine = "host", image, network = "default", _run = run } = opts;
  if (!testCommand) return { code: 0, stdout: "(no test_command configured)", stderr: "", engine: "host" };

  if ((engine === "podman" || engine === "docker") && image) {
    const { bin, args } = buildContainerArgs({ engine, image, network, projectPath: cwd });
    const probe = _run(bin, ["--version"], { cwd });
    if (probe.code === 0) {
      const res = _run(bin, [...args, "sh", "-c", testCommand], { cwd });
      return { code: res.code, stdout: String(res.stdout || "").trim(), stderr: String(res.stderr || "").trim(), engine };
    }
    // engine configured but unavailable -> fall through to host
  }

  const res = _run("sh", ["-c", testCommand], { cwd });
  return { code: res.code, stdout: String(res.stdout || "").trim(), stderr: String(res.stderr || "").trim(), engine: "host" };
}

/**
 * Convenience: run the project's CI gate from config. Reads test_command from
 * `[project]` and `[ci]` engine/image/network from config.
 */
export function runProjectCi(
  cwd: string,
  config: { project?: { test_command?: string }; ci?: { engine?: string; image?: string; network?: string } },
  o: { _run?: CiRunner; engine?: string; image?: string; network?: string } = {}
): { code: number; stdout: string; stderr: string; engine: string } {
  const { _run, engine, image, network } = o;
  return runCi(cwd, {
    testCommand: config.project?.test_command,
    engine: engine ?? config.ci?.engine ?? "host",
    image: image ?? config.ci?.image,
    network: network ?? config.ci?.network ?? "default",
    _run,
  });
}