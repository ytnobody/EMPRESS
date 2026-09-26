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

import * as fs from "node:fs";
import * as path from "node:path";
import { run } from "../shared/shell.ts";
import type { RunOpts, RunResult } from "../shared/shell.ts";

export const CI_ENGINES = ["host", "podman", "docker"];

type ContainerEngine = "podman" | "docker";
type CiRunner = (cmd: string, args: string[], opts?: RunOpts) => RunResult;

export interface ExtraMount {
  host: string; // resolved host path (the symlink target, a real dir)
  container: string; // container path, e.g. /project/node_modules
  mode?: "ro" | "rw";
}

/** Pure: the container-engine args for running the gate in a container. */
export function buildContainerArgs(o: {
  engine: ContainerEngine;
  image?: string;
  network?: string;
  projectPath: string;
  extraMounts?: ExtraMount[];
}): { bin: string; args: string[] } {
  const { engine, image, network = "default", projectPath, extraMounts = [] } = o;
  const bin = engine === "docker" ? "docker" : "podman";
  const args = ["run", "--rm"];
  if (network === "none") args.push("--network", "none");
  else if (network === "host") args.push("--network", "host");
  // default bridge: no flag needed
  args.push("-v", `${projectPath}:/project:rw`);
  for (const m of extraMounts) args.push("-v", `${m.host}:${m.container}:${m.mode ?? "ro"}`);
  args.push("-w", "/project");
  if (image) args.push(image);
  return { bin, args };
}

/**
 * Resolve a worktree's `node_modules` symlink (created by createWorktree to
 * point at the main repo's dir) into a real host dir mountable into a
 * container. Bound at `/deps`, NOT `/project/node_modules`: the OCI runtime
 * fails `openat2` when a bind target is itself a symlink to a host-only path
 * (podman 3.4.2 observed). The prefix command in runCi then relinks
 * `/project/node_modules -> /deps`. Returns [] when there is no symlink or the
 * target is missing.
 */
export function nodeModulesExtraMount(cwd: string): ExtraMount[] {
  try {
    const nm = path.join(cwd, "node_modules");
    const st = fs.lstatSync(nm);
    if (!st.isSymbolicLink()) return [];
    const real = fs.realpathSync(nm);
    if (!fs.statSync(real).isDirectory()) return [];
    return [{ host: real, container: "/deps", mode: "ro" }];
  } catch {
    return [];
  }
}

/** Prefix command for the container gate when deps are mounted at /deps. */
export function depsRelinkPrefix(): string {
  return "rm -f /project/node_modules && ln -s /deps /project/node_modules";
}

/**
 * Pure decision: detect the self-poisoning a previous container gate run leaves
 * on the HOST. The relink prefix runs inside the container against the rw
 * `/project` bind, so `ln -s /deps /project/node_modules` writes back through the
 * mount and overwrites the host worktree symlink to `/deps` (realpath ENOENT on
 * host — next run's mount discovery then returns [] and tsc is unresolvable).
 * When the readlink target is exactly `/deps` (the only value the prefix ever
 * writes) and the main repo's real node_modules dir exists, return that dir as
 * the rewrite target; otherwise null (no rewrite — valid link stays, missing
 * main dir leaves the link alone so discovery degrades to [] as before).
 */
export function depsRelinkRepair(cwd: string): string | null {
  const nm = path.join(cwd, "node_modules");
  let target: string | null = null;
  try {
    const st = fs.lstatSync(nm);
    if (!st.isSymbolicLink()) return null;
    target = fs.readlinkSync(nm);
  } catch {
    return null;
  }
  if (target !== "/deps") return null;
  // ponytail: worktree depth hardcoded to <main>/.empress/worktrees/N (3 ups, matches
  // createWorktree), refuse rewrite when the derived main dir is absent; generalize if
  // EMPRESS_DIR ever gets nested or worktrees relocate.
  // worktree layout <main>/.empress/worktrees/N (see createWorktree) -> <main> = cwd/../../..
  const mainNodeModules = path.join(path.resolve(cwd, "..", "..", ".."), "node_modules");
  return fs.existsSync(mainNodeModules) ? mainNodeModules : null;
}

/** Thin executor: rewrite the worktree node_modules symlink to `target`. Best-effort. */
function applyDepsRelinkRepair(cwd: string, target: string): void {
  try {
    const nm = path.join(cwd, "node_modules");
    fs.rmSync(nm, { force: true }); // removes the (poisoned) link itself, not its target
    fs.symlinkSync(target, nm, "dir");
  } catch {
    /* best-effort: mount discovery returns [] on a still-broken link */
  }
}

/** Decide + apply the /deps self-poison repair (idempotent no-op when healthy). */
function healDepsRelink(cwd: string): void {
  const target = depsRelinkRepair(cwd);
  if (target) applyDepsRelinkRepair(cwd, target);
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
    // Bind a worktree's node_modules symlink target so the container can resolve
    // typescript/@types/bun for the typecheck step (the symlink itself only
    // resolves on the host).
    // Heal a previous run's /deps write-back BEFORE mounting, or this run's
    // discovery finds [] and repeats the 'tsc not found' failure.
    healDepsRelink(cwd);
    const extraMounts = nodeModulesExtraMount(cwd);
    const { bin, args } = buildContainerArgs({ engine, image, network, projectPath: cwd, extraMounts });
    const probe = _run(bin, ["--version"], { cwd });
    if (probe.code === 0) {
      // When deps are mounted at /deps, first relink /project/node_modules inside
      // the container (the OCI runtime can't bind over the host-absolute symlink).
      const cmd = extraMounts.length ? `${depsRelinkPrefix()} && ${testCommand}` : testCommand;
      const res = _run(bin, [...args, "sh", "-c", cmd], { cwd });
      // The relink above wrote /deps back through the rw mount and re-poisoned
      // the host symlink; restore it so the next run and host tooling still
      // resolve node_modules (acceptance: host selfcheck stays green).
      healDepsRelink(cwd);
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