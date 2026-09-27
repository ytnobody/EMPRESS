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
 * Deterministic: is the worktree `node_modules` resolvable to a real directory
 * (symlink to a real dir, or a plain real dir)? The preflight's symlink-health
 * signal for both container and host runs. A poisoned /deps write-back (realpath
 * ENOENT on host) or a missing name reports false.
 */
export function nodeModulesHealthy(cwd: string): boolean {
  try {
    const nm = path.join(cwd, "node_modules");
    const st = fs.lstatSync(nm);
    if (st.isSymbolicLink()) return fs.statSync(fs.realpathSync(nm)).isDirectory();
    return st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pure decision: the CI-env preflight report. `skipEligible` is true when git is
 * absent in the run environment OR deps are unresolvable — the environment cannot
 * give a trustworthy code verdict, so a failed check there is infra-caused, not
 * code-caused (git-or-skip). Engine readiness is NOT a skip condition: an
 * unavailable container engine falls back to the host (trusted). (Command-
 * verification target — assert the flip from inputs, no container needed.)
 */
export interface Preflight {
  engineReady: boolean;
  gitAvailable: boolean;
  depsHealthy: boolean;
  healed: boolean; // a deps symlink repair was applied during preflight
  skipEligible: boolean;
}
export function decidePreflight(o: {
  engineReady: boolean;
  gitAvailable: boolean;
  depsHealthy: boolean;
  healed: boolean;
}): Preflight {
  const skipEligible = !o.gitAvailable || !o.depsHealthy;
  return { ...o, skipEligible };
}

/**
 * Run the CI gate. Dispatches by engine; falls back to host when a configured
 * container engine is unavailable. Never throws (returns {code, stdout, stderr}).
 * Before any run a preflight heals a prior run's /deps write-back (task #5),
 * probes git presence + deps health, and reports the verdict (git-or-skip) so a
 * failure purely from infra state is not mistaken for a code failure.
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
): { code: number; stdout: string; stderr: string; engine: string; preflight: Preflight } {
  const { testCommand, engine = "host", image, network = "default", _run = run } = opts;
  const cleanPreflight = { engineReady: true, gitAvailable: true, depsHealthy: true, healed: false, skipEligible: false };
  if (!testCommand) return { code: 0, stdout: "(no test_command configured)", stderr: "", engine: "host", preflight: cleanPreflight };

  // Preflight (before any run): heal a previous run's /deps write-back so THIS
  // run's mount discovery works, then observe deps health.
  let healed = false;
  const healTarget = depsRelinkRepair(cwd);
  if (healTarget) {
    applyDepsRelinkRepair(cwd, healTarget);
    healed = true;
  }
  const depsHealthy = nodeModulesHealthy(cwd);

  if ((engine === "podman" || engine === "docker") && image) {
    // Bind a worktree's node_modules symlink target so the container can resolve
    // typescript/@types/bun for the typecheck step (the symlink itself only
    // resolves on the host).
    // Heal a previous run's /deps write-back BEFORE mounting, or this run's
    // discovery finds [] and repeats the 'tsc not found' failure.
    const extraMounts = nodeModulesExtraMount(cwd);
    const { bin, args } = buildContainerArgs({ engine, image, network, projectPath: cwd, extraMounts });
    const probe = _run(bin, ["--version"], { cwd });
    const engineReady = probe.code === 0;
    // git-or-skip: probe git INSIDE the image (deterministic env check) — task #4.
    const gitAvailable = engineReady ? _run(bin, ["run", "--rm", image, "git", "--version"], { cwd }).code === 0 : false;
    const preflight = decidePreflight({ engineReady, gitAvailable, depsHealthy, healed });
    if (engineReady) {
      // When deps are mounted at /deps, first relink /project/node_modules inside
      // the container (the OCI runtime can't bind over the host-absolute symlink).
      const cmd = extraMounts.length ? `${depsRelinkPrefix()} && ${testCommand}` : testCommand;
      const res = _run(bin, [...args, "sh", "-c", cmd], { cwd });
      // The relink above wrote /deps back through the rw mount and re-poisoned
      // the host symlink; restore it so the next run and host tooling still
      // resolve node_modules (acceptance: host selfcheck stays green).
      healDepsRelink(cwd);
      return { code: res.code, stdout: String(res.stdout || "").trim(), stderr: String(res.stderr || "").trim(), engine, preflight };
    }
    // engine configured but unavailable -> fall through to host
  }

  // host fallback (engine unconfigured, configured engine unavailable)
  const hostGit = _run("git", ["--version"], { cwd }).code === 0;
  const preflightHost = decidePreflight({ engineReady: true, gitAvailable: hostGit, depsHealthy, healed });
  const res = _run("sh", ["-c", testCommand], { cwd });
  return { code: res.code, stdout: String(res.stdout || "").trim(), stderr: String(res.stderr || "").trim(), engine: "host", preflight: preflightHost };
}

/**
 * Convenience: run the project's CI gate from config. Reads test_command from
 * `[project]` and `[ci]` engine/image/network from config.
 */
export function runProjectCi(
  cwd: string,
  config: { project?: { test_command?: string }; ci?: { engine?: string; image?: string; network?: string } },
  o: { _run?: CiRunner; engine?: string; image?: string; network?: string } = {}
): { code: number; stdout: string; stderr: string; engine: string; preflight: Preflight } {
  const { _run, engine, image, network } = o;
  return runCi(cwd, {
    testCommand: config.project?.test_command,
    engine: engine ?? config.ci?.engine ?? "host",
    image: image ?? config.ci?.image,
    network: network ?? config.ci?.network ?? "default",
    _run,
  });
}