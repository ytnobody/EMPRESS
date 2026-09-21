// Local git operations: worktrees, branches, diffs, merges. No GitHub.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../shared/config.ts";
import { git, run } from "../shared/shell.ts";

export function isGitRepo(cwd: string): boolean {
  return run("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]).code === 0;
}

export function gitDir(cwd: string): string | null {
  const out = git(cwd, "rev-parse", "--absolute-git-dir");
  return out || null;
}

export function currentBranch(cwd: string): string | null {
  return git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
}

export function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`) !== null;
}

export function defaultBranch(cwd: string, fallback = "main"): string {
  const sym = git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD");
  if (sym) return sym.replace("refs/remotes/origin/", "");
  if (branchExists(cwd, "main")) return "main";
  if (branchExists(cwd, "master")) return "master";
  if (branchExists(cwd, fallback)) return fallback;
  return currentBranch(cwd) || fallback;
}

/**
 * Create a worktree for a task on an isolated branch.
 * Returns { branch, worktreePath } or throws with a message.
 */
export function createWorktree(
  cwd: string,
  { taskId, branchPrefix, baseBranch }: { taskId: number | string; branchPrefix?: string; baseBranch?: string }
): { branch: string; worktreePath: string; existed: boolean } {
  const base = baseBranch || defaultBranch(cwd);
  const branch = `${branchPrefix || "empress/task"}-${taskId}`;
  const worktreePath = path.join(cwd, EMPRESS_DIR, "worktrees", String(taskId));

  if (fs.existsSync(worktreePath) && (git(cwd, "worktree", "list", "--porcelain") ?? "").includes(worktreePath)) {
    return { branch, worktreePath, existed: true };
  }

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // make sure base exists locally
  if (!branchExists(cwd, base)) {
    throw new Error(`base branch "${base}" not found locally`);
  }
  // remove any leftover local branch of the same name
  if (branchExists(cwd, branch)) {
    const lr = run("git", ["-C", cwd, "branch", "-D", branch]);
  }
  const res = run("git", ["-C", cwd, "worktree", "add", "-b", branch, worktreePath, base]);
  if (res.code !== 0) {
    // maybe branch already exists somewhere (orphan worktree recovery)
    const lr2 = run("git", ["-C", cwd, "worktree", "add", worktreePath, branch]);
    if (lr2.code !== 0) throw new Error(`could not create worktree: ${res.stderr || res.stdout}`);
  }

  // Link the devDeps (typescript/@types/bun for the typecheck gate) into the
  // worktree: node_modules is git-ignored so it's not present in the worktree,
  // which would make the land gate's `bun typecheck` (tsc) unresolvable. A
  // symlink to the main repo's node_modules keeps host runs and the podman CI
  // (worktree mounted at /project) both able to typecheck. Ignored by git, so
  // it never enters the tree.
  const mainNodeModules = path.join(cwd, "node_modules");
  if (fs.existsSync(mainNodeModules) && !fs.existsSync(path.join(worktreePath, "node_modules"))) {
    try {
      fs.symlinkSync(mainNodeModules, path.join(worktreePath, "node_modules"), "dir");
    } catch {
      /* non-fatal: typecheck would then fail later with a clear message */
    }
  }
  return { branch, worktreePath, existed: false };
}

export function removeWorktree(cwd: string, taskId: number | string, branch?: string): boolean {
  const worktreePath = path.join(cwd, EMPRESS_DIR, "worktrees", String(taskId));
  run("git", ["-C", cwd, "worktree", "remove", "--force", worktreePath]);
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch {}
  if (branch) {
    run("git", ["-C", cwd, "branch", "-D", branch]);
  }
  return true;
}

export function listBranches(cwd: string, prefix?: string): string[] {
  const lines = git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads/") || "";
  const branches = lines.split("\n").filter((b) => b && (!prefix || b.startsWith(prefix)));
  return branches;
}

/** Diff stats between base and branch. Returns { files, insertions, deletions, changed: string[] }. */
export function diffBetween(cwd: string, base: string, branch: string): {
  files: number;
  insertions: number;
  deletions: number;
  changed: string[];
} {
  const out = git(cwd, "diff", "--numstat", `${base}...${branch}`);
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  const changed = [];
  if (out) {
    for (const line of out.split("\n")) {
      const m = line.split("\t");
      if (m.length < 3) continue;
      const [ins, del, file] = m;
      files++;
      changed.push(file);
      if (ins !== "-") insertions += parseInt(ins, 10) || 0;
      if (del !== "-") deletions += parseInt(del, 10) || 0;
    }
  }
  return { files, insertions, deletions, changed };
}

/** Raw patch text of the branch relative to base (for Jev risk judgment). */
export function diffPatch(cwd: string, base: string, branch: string, cap = 60000): string {
  const out = git(cwd, "diff", "--stat", `${base}...${branch}`) || "";
  const patch = git(cwd, "diff", "--unified=2", `${base}...${branch}`) || "";
  let text = `${out}\n\n${patch}`;
  if (text.length > cap) text = text.slice(0, cap) + "\n…[truncated]";
  return text;
}

export function branchIsAncestor(cwd: string, base: string, branch: string): boolean {
  return run("git", ["-C", cwd, "merge-base", "--is-ancestor", base, branch]).code === 0;
}

/**
 * Pure decision for landBranch: whether to emit an update-fast-forward against
 * origin/<base>. Returns a Command or null (no-op). Guards the origin path so a
 * doomed `git merge --ff-only origin/<base>` is never run when that ref is absent
 * (e.g. local-only repos with no origin remote).
 */
export function originUpdateCommand(base: string, originBaseExists: boolean): { cmd: string; args: string[] } | null {
  return originBaseExists
    ? { cmd: "git", args: ["merge", "--ff-only", "origin/" + base] }
    : null;
}

/* eslint-disable no-unused-vars */

/**
 * Land a task branch into base locally. Returns { merged, fastForwarded, note }.
 * Does NOT run tests — callers handle CI gating before landing.
 */
export function landBranch(
  cwd: string,
  base: string,
  branch: string,
  { force = false }: { force?: boolean } = {}
): { merged: boolean; fastForwarded?: boolean; note?: string } {
  const current = currentBranch(cwd);
  if (!current) return { merged: false, note: "not a git repo" };
  if (!branchExists(cwd, branch)) return { merged: false, note: `branch "${branch}" does not exist` };

  // If we're currently ON the branch (e.g. evaluating from its worktree), move to base first.
  if (current === branch) {
    const co = run("git", ["-C", cwd, "checkout", base]);
    if (co.code !== 0) return { merged: false, note: `could not checkout ${base}` };
  }

  // Update base from origin ONLY when that remote ref exists — local-only repos
  // have no origin, so the merge would be doomed (noise + confusion).
  const originRefExists =
    git(cwd, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`) !== null;
  const originCmd = originUpdateCommand(base, originRefExists);
  if (originCmd) run(originCmd.cmd, ["-C", cwd, ...originCmd.args]);

  const merge = run("git", ["-C", cwd, "merge", "--no-edit", "--ff-only", branch]);
  if (merge.code === 0) return { merged: true, fastForwarded: true, note: "fast-forwarded" };

  // fall back to a merge commit
  const mergeCommit = run("git", ["-C", cwd, "merge", "--no-edit", branch]);
  if (mergeCommit.code === 0) return { merged: true, fastForwarded: false, note: "merged with commit" };

  return { merged: false, note: `merge failed: ${merge.stderr || mergeCommit.stderr}` };

}
