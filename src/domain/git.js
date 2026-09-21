// Local git operations: worktrees, branches, diffs, merges. No GitHub.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../shared/config.js";
import { git, run } from "../shared/shell.js";

export function isGitRepo(cwd) {
  return run("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"]).code === 0;
}

export function gitDir(cwd) {
  const out = git(cwd, "rev-parse", "--absolute-git-dir");
  return out || null;
}

export function currentBranch(cwd) {
  return git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
}

export function branchExists(cwd, branch) {
  return git(cwd, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`) !== null;
}

export function defaultBranch(cwd, fallback = "main") {
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
export function createWorktree(cwd, { taskId, branchPrefix, baseBranch }) {
  const base = baseBranch || defaultBranch(cwd);
  const branch = `${branchPrefix || "empress/task"}-${taskId}`;
  const worktreePath = path.join(cwd, EMPRESS_DIR, "worktrees", String(taskId));

  if (fs.existsSync(worktreePath) && git(cwd, "worktree", "list", "--porcelain").includes(worktreePath)) {
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
  return { branch, worktreePath, existed: false };
}

export function removeWorktree(cwd, taskId, branch) {
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

export function listBranches(cwd, prefix) {
  const lines = git(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads/") || "";
  const branches = lines.split("\n").filter((b) => b && (!prefix || b.startsWith(prefix)));
  return branches;
}

/** Diff stats between base and branch. Returns { files, insertions, deletions, changed: string[] }. */
export function diffBetween(cwd, base, branch) {
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
export function diffPatch(cwd, base, branch, cap = 60000) {
  const out = git(cwd, "diff", "--stat", `${base}...${branch}`) || "";
  const patch = git(cwd, "diff", "--unified=2", `${base}...${branch}`) || "";
  let text = `${out}\n\n${patch}`;
  if (text.length > cap) text = text.slice(0, cap) + "\n…[truncated]";
  return text;
}

export function branchIsAncestor(cwd, base, branch) {
  return run("git", ["-C", cwd, "merge-base", "--is-ancestor", base, branch]).code === 0;
}

/* eslint-disable no-unused-vars */

/**
 * Land a task branch into base locally. Returns { merged, fastForwarded, note }.
 * Does NOT run tests — callers handle CI gating before landing.
 */
export function landBranch(cwd, base, branch, { force = false } = {}) {
  const current = currentBranch(cwd);
  if (!current) return { merged: false, note: "not a git repo" };
  if (!branchExists(cwd, branch)) return { merged: false, note: `branch "${branch}" does not exist` };

  // If we're currently ON the branch (e.g. evaluating from its worktree), move to base first.
  if (current === branch) {
    const co = run("git", ["-C", cwd, "checkout", base]);
    if (co.code !== 0) return { merged: false, note: `could not checkout ${base}` };
  }

  const updateBase = run("git", ["-C", cwd, "merge", "--ff-only", "origin/" + base]);
  void updateBase;

  const merge = run("git", ["-C", cwd, "merge", "--no-edit", "--ff-only", branch]);
  if (merge.code === 0) return { merged: true, fastForwarded: true, note: "fast-forwarded" };

  // fall back to a merge commit
  const mergeCommit = run("git", ["-C", cwd, "merge", "--no-edit", branch]);
  if (mergeCommit.code === 0) return { merged: true, fastForwarded: false, note: "merged with commit" };

  return { merged: false, note: `merge failed: ${merge.stderr || mergeCommit.stderr}` };

}
