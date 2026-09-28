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

export interface BranchPruneResult {
  pruned: string[];
  skipped: string[];
}

/**
 * LLM-free merge-conflict check (git >= 2.38): `git merge-tree --write-tree`
 * exits non-zero iff merging `branch` into `base` conflicts. Used by the driver
 * to detect a held task branch that is stuck conflicting with the base — the
 * harness should re-engage it instead of leaving it in verify-and-hold.
 */
export function mergeConflict(cwd: string, base: string, branch: string): boolean {
  const res = run("git", ["-C", cwd, "merge-tree", "--write-tree", base, branch]);
  return res.code !== 0;
}

/**
 * Worktree paths where the given local branch is checked out, parsed from
 * `git worktree list --porcelain` ("worktree <path>" / "branch refs/heads/<b>").
 * Returns the main worktree too if it checks out the branch; empty when the
 * branch is not checked out anywhere.
 */
export function worktreesForBranch(cwd: string, branch: string): string[] {
  const porcelain = run("git", ["-C", cwd, "worktree", "list", "--porcelain"]).stdout;
  const paths: string[] = [];
  let cur: string | null = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/") && cur) {
      if (line.slice("branch refs/heads/".length) === branch) paths.push(cur);
    }
  }
  return paths;
}

/**
 * Safely delete local branches that are fully merged into `base` and are not
 * protected (the current branch, the base branch itself, `main`, `develop`, or
 * names passed via `keep`). Uses `git branch -d` (safe delete): a branch that is
 * not fully merged or is the current branch is skipped rather than force-deleted.
 * A merged branch that is checked out in a worktree has that worktree removed
 * first (`git worktree remove --force`) so `git branch -d` succeeds and leaves no
 * orphaned worktree behind. Deterministic and merge-safe — this is what lets the
 * harness auto-prune dead branches (+ their worktrees) instead of filing a
 * housekeeping task for them.
 */
export function pruneStaleMergedBranches(cwd: string, base: string, opts: { keep?: string[] } = {}): BranchPruneResult {
  const keep = new Set<string>([...(opts.keep || []), "main", "develop", base]);
  const current = currentBranch(cwd);
  if (current) keep.add(current);
  const candidates = listBranches(cwd).filter((b) => !keep.has(b));
  const pruned: string[] = [];
  const skipped: string[] = [];
  for (const b of candidates) {
    // pruned iff the branch is already an ancestor of base (fully merged in).
    const mergedIn = run("git", ["-C", cwd, "merge-base", "--is-ancestor", b, base]).code === 0;
    if (!mergedIn) {
      skipped.push(b);
      continue;
    }
    // free the branch if it is checked out in a worktree so `branch -d` succeeds,
    // and so no orphaned worktree is left behind after the prune.
    for (const wt of worktreesForBranch(cwd, b)) {
      run("git", ["-C", cwd, "worktree", "remove", "--force", wt]);
    }
    const res = run("git", ["-C", cwd, "branch", "-d", b]);
    if (res.code === 0) pruned.push(b);
    else skipped.push(b); // non-fast-forward head / could not be safely deleted
  }
  return { pruned, skipped };
}

/**
 * Pure decision for pruning stale merged REMOTE-tracking branches: given each
 * ref's short name + already-computed merge status, decide which to delete and
 * which to skip. Only refs that are merged AND not protected are pruned.
 * Protected = base / main / develop / the remote symbolic HEAD / any `keep` name;
 * unmerged refs are never pruned regardless of name. (Command-verification target
 * for the executor below — no git state consulted.)
 */
export function decideRemotePrunes(refs: Array<{ short: string; merged: boolean }>, base: string, keep: string[]): { prune: string[]; skip: string[] } {
  const keepSet = new Set<string>([...keep, "main", "develop", base, "HEAD"]);
  const prune: string[] = [];
  const skip: string[] = [];
  for (const { short, merged } of refs) {
    if (!short || keepSet.has(short) || !merged) {
      skip.push(short);
      continue;
    }
    prune.push(short);
  }
  return { prune, skip };
}

/**
 * Delete PR-dead-weight on a remote: fully-merged remote-tracking branches
 * (`git push <remote> :<short>`, then drop the local ref). Local-only repos with
 * no pushable remote are no-ops. Fail-safe: any merge-gate failure or failed push
 * leaves the branch in place (skipped) rather than risking a live branch. This is
 * what lets the harness sweep merged remote branches too, not just local ones.
 */
export function pruneStaleMergedRemoteBranches(cwd: string, base: string, opts: { keep?: string[]; remote?: string } = {}): BranchPruneResult {
  const remote = opts.remote || "origin";
  const keep = opts.keep || [];
  const refs = (git(cwd, "for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/`) || "")
    .split("\n")
    .filter(Boolean)
    .map((ref) => {
      const short = ref.slice(remote.length + 1);
      const merged = run("git", ["-C", cwd, "merge-base", "--is-ancestor", ref, base]).code === 0;
      return { short, merged };
    });
  const { prune, skip } = decideRemotePrunes(refs, base, keep);
  const pruned: string[] = [];
  const skipped = [...skip];
  for (const short of prune) {
    // fail-safe: re-verify still an ancestor immediately before destroying
    const stillMerged = run("git", ["-C", cwd, "merge-base", "--is-ancestor", `refs/remotes/${remote}/${short}`, base]).code === 0;
    if (!stillMerged) {
      skipped.push(short);
      continue;
    }
    const del = run("git", ["-C", cwd, "push", remote, `:${short}`]);
    if (del.code === 0) {
      pruned.push(short);
      run("git", ["-C", cwd, "branch", "-d", "-r", `${remote}/${short}`]);
    } else {
      skipped.push(short); // failed push => keep, never force
    }
  }
  return { pruned, skipped };
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
