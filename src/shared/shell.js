// Small synchronous process / shell helpers used by both the CLI and the
// extension. Node + Bun compatible.
import { execFileSync, spawnSync } from "node:child_process";

/** Run a command synchronously, returning { code, stdout, stderr }. Never throws. */
export function run(cmd, args, opts = {}) {
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
    return { code: -1, stdout: "", stderr: String(e && e.message || e), signal: null };
  }
}

/** Convenience: true when the command exited 0. */
export function ok(cmd, args, opts) {
  return run(cmd, args, opts).code === 0;
}

/** Run git with a given cwd, returning stdout trimmed. Returns null on failure. */
export function git(cwd, ...args) {
  const res = run("git", ["-C", cwd, ...args]);
  if (res.code !== 0) return null;
  return res.stdout.trim();
}

/** Resolve the last tool's stderr for error messages (nullable-safe). */
export function stderrOf(res) {
  return res && res.stderr ? res.stderr.trim() : "";
}

/** execFileSync convenience returning trimmed stdout (throws on error). */
export function runSyncString(cmd, args, opts = {}) {
  const out = execFileSync(cmd, args, {
    encoding: "utf-8",
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return String(out).trim();
}