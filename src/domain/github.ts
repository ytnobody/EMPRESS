// gh (GitHub CLI) integration. STRICTLY opt-in via `[github] enabled = true`:
// every function here refuses to run unless the config enables it. When
// disabled, EMPRESS stays local-only (never pushes, never opens PRs).
import { run } from "../shared/shell.ts";

export interface GithubConfig {
  enabled: boolean;
  owner: string;
  repo: string;
}

/** True when the gh CLI is installed and runnable. */
export function ghAvailable(): boolean {
  return run("gh", ["--version"]).code === 0;
}

/**
 * Resolve { owner, repo } for the project, in order:
 *   1. explicit [github] owner + repo from config,
 *   2. the `origin` remote URL (https://github.com/u/r or git@github.com:u/r.git),
 *   3. `gh repo view --json nameWithOwner` (needs an authenticated gh).
 * Returns null when none can be resolved.
 */
export function resolveRepo(cwd: string, cfg: GithubConfig): { owner: string; repo: string } | null {
  if (cfg.owner && cfg.repo) return { owner: cfg.owner, repo: cfg.repo };

  const remote = run("git", ["-C", cwd, "remote", "get-url", "origin"]);
  if (remote.code === 0) {
    const url = remote.stdout.trim();
    const m = url.match(/(?:github\.com[/:])([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
  }

  if (ghAvailable()) {
    const view = run("gh", ["repo", "view", "--json", "nameWithOwner"]);
    if (view.code === 0) {
      try {
        const json = JSON.parse(view.stdout);
        const [owner, repo] = String(json.nameWithOwner || "").split("/");
        if (owner && repo) return { owner, repo };
      } catch {
        /* unparseable output — fall through */
      }
    }
  }
  return null;
}

export interface PushPrResult {
  ok: boolean;
  pushed?: boolean;
  prUrl?: string;
  prNumber?: string;
  error?: string;
}

/**
 * Push the task branch to origin and open a PR into `base`.
 * Returns { ok: true, prUrl } on success; { ok: false, error } when disabled,
 * unresolvable, or a step failed. Pushing succeeds but PR creation fails is
 * reported as { ok: true, pushed: true, error } so callers can retry the PR.
 */
export function pushBranchAndCreatePr(
  cwd: string,
  { base, branch, title, body }: { base: string; branch: string; title: string; body: string },
  cfg: GithubConfig
): PushPrResult {
  if (!cfg.enabled) {
    return { ok: false, error: "github integration disabled ([github] enabled = false)" };
  }
  const repo = resolveRepo(cwd, cfg);
  if (!repo) {
    return { ok: false, error: "could not resolve owner/repo (set [github] owner/repo or configure an origin remote)" };
  }
  if (!ghAvailable()) {
    return { ok: false, error: "gh CLI not installed" };
  }

  const push = run("git", ["-C", cwd, "push", "-u", "origin", branch]);
  if (push.code !== 0) {
    return { ok: false, error: `git push failed: ${push.stderr.trim() || push.stdout.trim()}` };
  }

  const pr = run(
    "gh",
    [
      "pr", "create",
      "--repo", `${repo.owner}/${repo.repo}`,
      "--base", base,
      "--head", branch,
      "--title", title,
      "--body", body,
    ],
    { timeout: 120000 }
  );
  if (pr.code !== 0) {
    return { ok: true, pushed: true, error: `push ok, but gh pr create failed: ${pr.stderr.trim() || pr.stdout.trim()}` };
  }
  const url = pr.stdout.trim();
  const num = (url.match(/#(\d+)\s*$/) || [])[1];
  return { ok: true, pushed: true, prUrl: url, prNumber: num };
}