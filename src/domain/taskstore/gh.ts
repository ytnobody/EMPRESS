// GitHub task store backend — tasks managed as GitHub issues via the gh CLI.
// Used only when `[github] enabled=true` (and gh is available + owner/repo
// resolve), so the whole task lifecycle lives on GitHub. Also hosts the
// cross-store sync (syncLocalToGh) and backend selection (getTaskStore).
import { run } from "../../shared/shell.ts";
import type { LoadedConfig } from "../../shared/config.ts";
import { resolveRepo, type GithubConfig } from "../github.ts";
import { localTaskStore } from "./local.ts";
import { buildMarkdown, withAgentMarker, isAgentAuthor, isHeld, sanitizeMetaValue, type StoreDeps, type Task, type TaskInput, type TaskListOpts, type TaskStore, type TaskComment } from "./shared.ts";

// EMPRESS-internal labels (kept out of the user-visible labels array).
const LBL_INPROGRESS = "status:in-progress";
const LBL_BLOCKED = "status:blocked";
const LBL_HELD = "status:held";
const LBL_NEEDS_CLARIF = "needs-clarification";
const ASSIGNEE_PREFIX = "assignee:";

// Runtime metadata (branch / pr) is stored as HTML comments hidden in the body.
const META_RE = /<!--empress:([a-z_]+)=([^>]*)-->/g;

interface GhIssueJson {
  number: number;
  title: string;
  state: string;
  body: string;
  createdAt: string;
  labels: Array<{ name: string }>;
  /** true when the number is a pull request, not an issue (PRs and issues share numbering). */
  pull_request?: boolean;
}

interface GhCommentJson {
  user?: { login?: string };
  body: string;
  created_at: string;
}

export function stripMetadata(body: string): string {
  return String(body || "").replace(META_RE, "").trim();
}

function readMeta(body: string, key: string): string {
  const m = String(body || "").match(new RegExp(`<!--empress:${key}=([^>]*)-->`));
  return m ? m[1] : "";
}

export function buildGhBody(bodyHuman: string, branch: string, pr: string, holdReason = ""): string {
  const reason = sanitizeMetaValue(holdReason);
  const meta = [
    branch ? `<!--empress:branch=${branch}-->` : "",
    pr ? `<!--empress:pr=${pr}-->` : "",
    reason ? `<!--empress:hold_reason=${reason}-->` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const b = String(bodyHuman || "").trim();
  return meta ? `${b}\n\n${meta}\n` : b;
}

function labelsOf(issue: GhIssueJson): string[] {
  return (issue.labels || []).map((l) => l.name);
}

/** Pure: map a GitHub issue (JSON) to an internal Task. */
export function issueToTask(issue: GhIssueJson, repo: string, comments: TaskComment[] = []): Task {
  const labels = labelsOf(issue);
  const state = String(issue.state || "").toLowerCase(); // gh returns OPEN/CLOSED (uppercase)
  const branch = readMeta(issue.body, "branch");
  const pr = readMeta(issue.body, "pr");
  const assignee = labels.find((l) => l.startsWith(ASSIGNEE_PREFIX))?.slice(ASSIGNEE_PREFIX.length) ?? "";
  let status: string;
  if (state === "closed") status = "done";
  else if (labels.includes(LBL_HELD)) status = "held";
  else if (labels.includes(LBL_BLOCKED)) status = "blocked";
  else if (labels.includes(LBL_INPROGRESS)) status = "in-progress";
  else if (assignee) status = "assigned";
  else status = "open";
  return {
    id: issue.number,
    file: `gh://${repo}#${issue.number}`,
    kind: issue.pull_request ? "pr" : "issue",
    title: issue.title,
    status,
    assignee,
    labels: labels.filter(
      (l) => l !== LBL_INPROGRESS && l !== LBL_BLOCKED && l !== LBL_HELD && l !== LBL_NEEDS_CLARIF && !l.startsWith(ASSIGNEE_PREFIX)
    ),
    needs_clarification: labels.includes(LBL_NEEDS_CLARIF),
    branch,
    pr,
    created: issue.createdAt,
    comments,
    hold_reason: readMeta(issue.body, "hold_reason"),
    body: stripMetadata(issue.body),
    repo,
  };
}

/** Pure: internal -> GitHub label set for a task state. Internal labels only. */
export function desiredLabels(t: Pick<Task, "labels" | "needs_clarification" | "assignee" | "status">): string[] {
  const s = new Set<string>(t.labels);
  if (t.needs_clarification) s.add(LBL_NEEDS_CLARIF);
  if (t.assignee) s.add(`${ASSIGNEE_PREFIX}${t.assignee}`);
  if (t.status === "in-progress") s.add(LBL_INPROGRESS);
  if (t.status === "blocked") s.add(LBL_BLOCKED);
  if (t.status === "held") s.add(LBL_HELD);
  return [...s];
}

export const ghTaskStore = (cwd: string, cfg: GithubConfig, deps: StoreDeps = {}): TaskStore => {
  const exec = deps.run ?? run;
  const repo = resolveRepo(cwd, cfg);
  if (!repo) {
    throw new Error("could not resolve owner/repo for the GitHub task store (set [github] owner/repo or configure an origin remote)");
  }
  const repoFull = `${repo.owner}/${repo.repo}`;
  const repoFlag = (): string[] => ["--repo", repoFull];

  const gh = (args: string[], timeout?: number) => exec("gh", args, typeof timeout === "number" ? { timeout } : {});

  // gh `issue view --json` has no `pull_request` field (verified), yet the REST
  // /issues/{n} endpoint returns PRs too — so PR-ness is only detectable via
  // `gh api ... --jq`. This single call both fetches and disambiguates.
  const fetchIssue = (id: number): GhIssueJson | null => {
    const res = gh([
      "api",
      `repos/${repoFull}/issues/${id}`,
      "--jq",
      "{number,title,state,body,createdAt:.created_at,pull_request:(.pull_request != null),labels:((.labels//[])|map(.name))}",
    ]);
    if (res.code !== 0) return null;
    try {
      return JSON.parse(res.stdout) as GhIssueJson;
    } catch {
      return null;
    }
  };

  const fetchComments = (id: number): TaskComment[] => {
    const res = gh(["api", `repos/${repoFull}/issues/${id}/comments`]);
    if (res.code !== 0) return [];
    try {
      const raw = JSON.parse(res.stdout) as GhCommentJson[];
      return raw.map((c) => ({ at: c.created_at, author: c.user?.login ?? "", body: c.body }));
    } catch {
      return [];
    }
  };

  const get: TaskStore["get"] = (id) => {
    const issue = fetchIssue(id);
    return issue ? issueToTask(issue, repoFull, fetchComments(id)) : null;
  };

  const create: TaskStore["create"] = (input) => {
    const args = ["issue", "create", ...repoFlag(), "--title", input.title, "--body", buildMarkdown(input)];
    for (const l of input.labels || []) args.push("--label", l);
    const res = gh(args, 60000);
    if (res.code !== 0) throw new Error(`gh issue create failed: ${res.stderr.trim() || res.stdout.trim()}`);
    const num = Number((res.stdout.trim().match(/(\d+)\s*$/) || [])[1]);
    const created = fetchIssue(num);
    if (!created) throw new Error(`gh issue create: created #${num} but could not re-read it`);
    return issueToTask(created, repoFull);
  };

  // A PR number shares the issue namespace but is NOT a task issue — closing,
  // editing or labeling it acts on the (wrong) pull request (the #14 incident).
  const refusePr = (issue: GhIssueJson | null): issue is null => !issue || Boolean(issue.pull_request);

  const update: TaskStore["update"] = (id, patch, newBody) => {
    const issue = fetchIssue(id);
    if (refusePr(issue)) return null;
    const current = issueToTask(issue, repoFull, fetchComments(id));
    const next: Task = {
      ...current,
      status: patch.status ?? current.status,
      assignee: patch.assignee ?? current.assignee,
      labels: patch.labels ?? current.labels,
      needs_clarification:
        patch.needs_clarification ?? current.needs_clarification,
      branch: patch.branch ?? current.branch,
      pr: patch.pr ?? current.pr,
      title: patch.title ?? current.title,
      hold_reason: patch.hold_reason ?? current.hold_reason,
    };

    const humanBody = newBody !== undefined ? newBody : stripMetadata(issue.body);
    const fullBody = buildGhBody(humanBody, next.branch, next.pr, next.hold_reason);

    const desired = new Set(desiredLabels(next));
    const currentLabels = new Set(labelsOf(issue));
    const toAdd = [...desired].filter((l) => !currentLabels.has(l));
    const toRemove = [...currentLabels].filter((l) => !desired.has(l));

    const args = ["issue", "edit", String(id), ...repoFlag(), "--body", fullBody];
    if (patch.title !== undefined) args.push("--title", patch.title);
    for (const l of toAdd) args.push("--add-label", l);
    for (const l of toRemove) args.push("--remove-label", l);
    gh(args);

    if (next.status === "done") gh(["issue", "close", String(id), ...repoFlag()]);
    else if (issue.state === "closed") gh(["issue", "reopen", String(id), ...repoFlag()]);

    return get(id);
  };

  const addComment: TaskStore["addComment"] = (id, author, body) => {
      const issue = fetchIssue(id);
      if (refusePr(issue)) return null;
      // Readable **[agent]** prefix for humans + invisible machine marker for
      // hasHumanReply (task #32) — the marker is the only agent signal and is
      // reserved for harness-agent authors (gh posts are all agent-authored here).
      const marked = isAgentAuthor(author) ? withAgentMarker(`**[${author}]** ${body}`) : `**[${author}]** ${body}`;
      const post = gh(["api", `repos/${repoFull}/issues/${id}/comments`, "--method", "POST", "-f", `body=${marked}`], 60000);

    if (post.code !== 0) return null;
    return get(id);
  };

  const close: TaskStore["close"] = (id, note = "") => {
    const issue = fetchIssue(id);
    if (refusePr(issue)) return null;
    if (note) {
      gh(["api", `repos/${repoFull}/issues/${id}/comments`, "--method", "POST", "-f", `body=${withAgentMarker(`**[empress]** ${note}`)}`], 60000);
    }
    if (issue.state !== "closed") gh(["issue", "close", String(id), ...repoFlag()]);
    return get(id);
  };

  const remove: TaskStore["remove"] = (id) => {
    const issue = fetchIssue(id);
    if (refusePr(issue)) return false; // never delete a PR as if it were a task
    const res = gh(["issue", "delete", String(id), "--yes", ...repoFlag()], 60000);
    return res.code === 0;
  };

  const list: TaskStore["list"] = (opts = {}) => {
    const res = gh(["issue", "list", ...repoFlag(), "--state", "all", "--limit", "1000", "--json", "number,title,state,body,createdAt,labels"]);
    if (res.code !== 0) return [];
    try {
      const arr = (JSON.parse(res.stdout) as GhIssueJson[]).sort((a, b) => a.number - b.number);
      return arr
        .map((i) => issueToTask(i, repoFull))
        .filter((t) => opts.includeAll || (t.status !== "done" && !t.needs_clarification && !isHeld(t)));
    } catch {
      return [];
    }
  };

  return { create, list, get, update, addComment, close, remove };
};

/**
 * One-way bootstrap: create a GitHub issue for each open/local task in the local
 * store, preserving title, body, labels, status/assignee/clarification, and
 * branch/pr metadata. Returns an id -> issue-number map.
 */
export interface SyncResult {
  id: number;
  ghNumber: number;
  title: string;
}

export function syncLocalToGh(cwd: string, config: LoadedConfig, deps: StoreDeps = {}): SyncResult[] {
  const exec = deps.run ?? run;
  const repo = resolveRepo(cwd, config.github);
  if (!repo) {
    throw new Error("could not resolve owner/repo for GitHub task store (set [github] owner/repo or configure an origin remote)");
  }
  const repoFull = `${repo.owner}/${repo.repo}`;
  const out: SyncResult[] = [];
  for (const t of localTaskStore(cwd).list({ includeAll: true })) {
    if (t.status === "done") continue;
    const args = ["issue", "create", "--repo", repoFull, "--title", t.title, "--body", buildGhBody(t.body, t.branch, t.pr, t.hold_reason)];
    for (const l of desiredLabels(t)) args.push("--label", l);
    const res = exec("gh", args, { timeout: 60000 });
    if (res.code !== 0) throw new Error(`gh issue create failed for task #${t.id}: ${res.stderr.trim() || res.stdout.trim()}`);
    const num = Number((res.stdout.trim().match(/(\d+)\s*$/) || [])[1]);
    out.push({ id: t.id, ghNumber: num, title: t.title });
  }
  return out;
}

/** Pick the active backend: gh when genuinely usable, else local. */
export function getTaskStore(cwd: string, config: LoadedConfig, deps: StoreDeps = {}): TaskStore {
  const ghAvail = deps.ghAvailable ? deps.ghAvailable() : ((): boolean => {
    const r = (deps.run ?? run)("gh", ["--version"]);
    return r.code === 0;
  })();
  const g = config && config.github;
  if (g && g.enabled && ghAvail) {
    try {
      return ghTaskStore(cwd, g, deps);
    } catch {
      // repo unresolvable / constructor error → fall back to local
    }
  }
  return localTaskStore(cwd);
}