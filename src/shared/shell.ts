// Small synchronous process / shell helpers used by both the CLI and the
// extension. Node + Bun compatible.
import { execFileSync, spawnSync } from "node:child_process";

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  signal: string | null;
}

/** Run a command synchronously, returning { code, stdout, stderr }. Never throws. */
export function run(cmd: string, args: string[], opts: RunOpts = {}): RunResult {
  try {
    const res = spawnSync(cmd, args, {
      encoding: "utf-8",
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      timeout: typeof opts.timeout === "number" ? opts.timeout : undefined,
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      code: res.status === null ? -1 : res.status,
      stdout: String(res.stdout || ""),
      stderr: String(res.stderr || ""),
      signal: res.signal || null,
    };
  } catch (e) {
    return { code: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e), signal: null };
  }
}

/** Convenience: true when the command exited 0. */
export function ok(cmd: string, args: string[], opts?: RunOpts): boolean {
  return run(cmd, args, opts).code === 0;
}

/** Run git with a given cwd, returning stdout trimmed. Returns null on failure. */
export function git(cwd: string, ...args: string[]): string | null {
  const res = run("git", ["-C", cwd, ...args]);
  if (res.code !== 0) return null;
  return res.stdout.trim();
}

/** Resolve the last tool's stderr for error messages (nullable-safe). */
export function stderrOf(res?: RunResult | null): string {
  return res && res.stderr ? res.stderr.trim() : "";
}

/** execFileSync convenience returning trimmed stdout (throws on error). */
export function runSyncString(cmd: string, args: string[], opts: RunOpts = {}): string {
  const out = execFileSync(cmd, args, {
    encoding: "utf-8",
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return String(out).trim();
}