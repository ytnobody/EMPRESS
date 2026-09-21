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

import { run } from "../shared/shell.js";

export const CI_ENGINES = ["host", "podman", "docker"];

/**
 * Pure: build the container-engine args for running the gate in a container.
 * @param {object} o
 * @param {"podman"|"docker"} o.engine
 * @param {string} [o.image]
 * @param {string} [o.network]  "default" | "none" | "host"
 * @param {string} o.projectPath  host dir mounted into the container
 * @returns {{bin:string, args:string[]}}
 */
export function buildContainerArgs({ engine, image, network = "default", projectPath }) {
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
 * @param {string} cwd
 * @param {object} opts
 * @param {string} opts.testCommand
 * @param {string} [opts.engine]           host|podman|docker
 * @param {string} [opts.image]
 * @param {string} [opts.network]
 * @param {(cmd:string,args:string[],o:object)=>object} [opts._run]  injectable runner
 */
export function runCi(cwd, { testCommand, engine = "host", image, network = "default", _run = run }) {
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
export function runProjectCi(cwd, config, { _run, engine, image, network } = {}) {
  return runCi(cwd, {
    testCommand: config.project?.test_command,
    engine: engine ?? config.ci?.engine ?? "host",
    image: image ?? config.ci?.image,
    network: network ?? config.ci?.network ?? "default",
    _run,
  });
}