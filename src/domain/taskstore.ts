// Task storage backends.
//
//   LocalTaskStore — the original `.empress/tasks/NNNN-title.md` files (offline /
//   local-first baseline). Used whenever gh integration is off or unavailable.
//   GhTaskStore    — tasks managed as GitHub issues via the gh CLI. Used only when
//                    `[github] enabled=true` (and gh is available + owner/repo
//                    resolve), so the whole task lifecycle lives on GitHub.
//
// getTaskStore() picks the backend from config. src/domain/tasks.ts is a thin
// delegate over this module, so every existing call site keeps its signature.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR, type LoadedConfig } from "../shared/config.ts";
import { readMd, writeMd, parseMdFile } from "../shared/frontmatter.ts";
import { run } from "../shared/shell.ts";
import { resolveRepo, type GithubConfig } from "./github.ts";

export const TASK_STATUSES: string[] = ["open", "assigned", "in-progress", "done", "blocked"];

export interface TaskComment {
  at: string;
  author: string;
  body: string;
}

export interface Task {
  id: number;
  file: string;
  title: string;
  status: string;
  assignee: string;
  labels: string[];
  needs_clarification: boolean;
  branch: string;
  pr: string;
  created: string;
  comments: TaskComment[];
  body: string;
  /** gh-backed tasks carry the resolved `owner/repo`; undefined for local tasks. */
  repo?: string;
}

export interface TaskInput {
  title: string;
  purpose?: string;
  scope?: string;
  acceptance?: string[];
  nongoals?: string[];
  labels?: string[];
}

export interface TaskListOpts {
  includeAll?: boolean;
}

export interface TaskStore {
  create(input: TaskInput): Task;
  list(opts?: TaskListOpts): Task[];
  get(id: number): Task | null;
  update(id: number, patch: Partial<Task>, newBody?: string): Task | null;
  addComment(id: number, author: string, body: string): Task | null;
  close(id: number, note?: string): Task | null;
  remove(id: number): boolean;
}

/** Dependencies that may be overridden in tests (fake runner / fake gh availability). */
export interface StoreDeps {
  run?: typeof run;
  ghAvailable?: () => boolean;
}

function tasksDir(cwd: string): string {
  return path.join(cwd, EMPRESS_DIR, "tasks");
}

// ---------------------------------------------------------------------------
// Local backend (original .empress/tasks/NNNN-title.md files)
// ---------------------------------------------------------------------------

/** Read a task file into a normalized object. */
export function readTaskFile(file: string): Task {
  const { frontmatter, body } = readMd(file);
  const id = Number(frontmatter.id ?? path.basename(file).split("-")[0]);
  return {
    id,
    file,
    title: String(frontmatter.title ?? ""),
    status: TASK_STATUSES.includes(frontmatter.status as string)
      ? (frontmatter.status as string)
      : "open",
    assignee: String(frontmatter.assignee ?? ""),
    labels: (frontmatter.labels as string[] | undefined) ?? [],
    needs_clarification: Boolean(frontmatter.needs_clarification),
    branch: String(frontmatter.branch ?? ""),
    pr: String(frontmatter.pr ?? ""),
    created: String(frontmatter.created ?? ""),
    comments: Array.isArray(frontmatter.comments)
      ? (frontmatter.comments as TaskComment[])
      : [],
    body,
  };
}

/** List task files sorted by id ascending. */
export function listTaskFiles(cwd: string): string[] {
  const dir = tasksDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(dir, f))
    .sort((a, b) => {
      const na = parseInt(path.basename(a), 10);
      const nb = parseInt(path.basename(b), 10);
      return (Number.isNaN(na) ? Infinity : na) - (Number.isNaN(nb) ? Infinity : nb);
    });
}

function findTaskFile(cwd: string, id: number): string | null {
  for (const f of listTaskFiles(cwd)) {
    const head = path.basename(f).split("-")[0];
    if (head === String(id).padStart(4, "0") || head === String(id)) return f;
  }
  return null;
}

function nextId(cwd: string): number {
  let max = 0;
  for (const f of listTaskFiles(cwd)) {
    const n = parseInt(path.basename(f).split("-")[0], 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

function slugify(s: string): string {
  return (
    (s || "task")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  );
}

/** Build the human markdown body for a task (Purpose / Scope / Acceptance / Non-Goals). */
export function buildMarkdown(input: TaskInput): string {
  return [
    `# ${input.title}`,
    "",
    "## Purpose",
    input.purpose || "_to be filled_",
    "",
    "## Scope",
    input.scope || "_to be filled_",
    "",
    "## Acceptance Criteria",
    ...(input.acceptance && input.acceptance.length
      ? input.acceptance.map((a) => `- [ ] ${a}`)
      : ["- [ ] _to be filled_"]),
    "",
    "## Non-Goals",
    ...(input.nongoals && input.nongoals.length
      ? input.nongoals.map((n) => `- ${n}`)
      : ["- _none yet_"]),
    "",
  ].join("\n");
}

export const localTaskStore = (cwd: string): TaskStore => {
  const dir = tasksDir(cwd);

  const create: TaskStore["create"] = (input) => {
    fs.mkdirSync(dir, { recursive: true });
    const id = nextId(cwd);
    const file = path.join(dir, `${String(id).padStart(4, "0")}-${slugify(input.title)}.md`);
    writeMd(
      file,
      {
        id,
        title: input.title,
        status: "open",
        assignee: "",
        labels: input.labels || [],
        needs_clarification: false,
        branch: "",
        pr: "",
        created: new Date().toISOString(),
        comments: [],
      },
      buildMarkdown(input)
    );
    return readTaskFile(file);
  };

  const list: TaskStore["list"] = (opts = {}) =>
    listTaskFiles(cwd)
      .map(readTaskFile)
      .filter((t) => opts.includeAll || (t.status !== "done" && !t.needs_clarification));

  const get: TaskStore["get"] = (id) => {
    const file = findTaskFile(cwd, id);
    return file ? readTaskFile(file) : null;
  };

  const update: TaskStore["update"] = (id, patch, newBody) => {
    const file = findTaskFile(cwd, id);
    if (!file) return null;
    const cur = readMd(file);
    const fm = { ...cur.frontmatter };
    const keys = [
      "title",
      "status",
      "assignee",
      "labels",
      "needs_clarification",
      "branch",
      "pr",
      "comments",
    ] as const;
    for (const k of keys) {
      if (k in patch) fm[k] = (patch as Record<string, unknown>)[k];
    }
    writeMd(file, fm, newBody ?? cur.body);
    return readTaskFile(file);
  };

  const addComment: TaskStore["addComment"] = (id, author, body) => {
    const t = get(id);
    if (!t) return null;
    return update(id, { comments: [...t.comments, { at: new Date().toISOString(), author, body }] });
  };

  const close: TaskStore["close"] = (id, note = "") => {
    const t = get(id);
    if (!t) return null;
    if (note) addComment(id, "empress", note);
    return update(id, { status: "done" });
  };

  const remove: TaskStore["remove"] = (id) => {
    const file = findTaskFile(cwd, id);
    if (!file) return false;
    fs.unlinkSync(file);
    return true;
  };

  return { create, list, get, update, addComment, close, remove };
};

// ---------------------------------------------------------------------------
// GitHub backend (tasks as GitHub issues via the gh CLI)
// ---------------------------------------------------------------------------

// EMPRESS-internal labels (kept out of the user-visible labels array).
const LBL_INPROGRESS = "status:in-progress";
const LBL_BLOCKED = "status:blocked";
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

export function buildGhBody(bodyHuman: string, branch: string, pr: string): string {
  const meta = [branch ? `<!--empress:branch=${branch}-->` : "", pr ? `<!--empress:pr=${pr}-->` : ""]
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
  else if (labels.includes(LBL_BLOCKED)) status = "blocked";
  else if (labels.includes(LBL_INPROGRESS)) status = "in-progress";
  else if (assignee) status = "assigned";
  else status = "open";
  return {
    id: issue.number,
    file: `gh://${repo}#${issue.number}`,
    title: issue.title,
    status,
    assignee,
    labels: labels.filter(
      (l) => l !== LBL_INPROGRESS && l !== LBL_BLOCKED && l !== LBL_NEEDS_CLARIF && !l.startsWith(ASSIGNEE_PREFIX)
    ),
    needs_clarification: labels.includes(LBL_NEEDS_CLARIF),
    branch,
    pr,
    created: issue.createdAt,
    comments,
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

  const fetchIssue = (id: number): GhIssueJson | null => {
    const res = gh(["issue", "view", String(id), ...repoFlag(), "--json", "number,title,state,body,createdAt,labels"]);
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

  const update: TaskStore["update"] = (id, patch, newBody) => {
    const issue = fetchIssue(id);
    if (!issue) return null;
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
    };

    const humanBody = newBody !== undefined ? newBody : stripMetadata(issue.body);
    const fullBody = buildGhBody(humanBody, next.branch, next.pr);

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
    const post = gh(["api", `repos/${repoFull}/issues/${id}/comments`, "--method", "POST", "-f", `body=**[${author}]** ${body}`], 60000);
    if (post.code !== 0) return null;
    return get(id);
  };

  const close: TaskStore["close"] = (id, note = "") => {
    const issue = fetchIssue(id);
    if (!issue) return null;
    if (note) {
      gh(["api", `repos/${repoFull}/issues/${id}/comments`, "--method", "POST", "-f", `body=**[empress]** ${note}`], 60000);
    }
    if (issue.state !== "closed") gh(["issue", "close", String(id), ...repoFlag()]);
    return get(id);
  };

  const remove: TaskStore["remove"] = (id) => {
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
        .filter((t) => opts.includeAll || (t.status !== "done" && !t.needs_clarification));
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
    const args = ["issue", "create", "--repo", repoFull, "--title", t.title, "--body", buildGhBody(t.body, t.branch, t.pr)];
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

/**
 * Human-readable single-line summary of a task for passing to an Engineer.
 * (Defined here and re-exported by tasks.ts for compatibility.)
 */
export function taskBrief(t: Task): string {
  return [
    `Task #${t.id}: ${t.title}`,
    `Status: ${t.status}`,
    t.branch ? `Branch/worktree: ${t.branch}` : "",
    t.pr ? `PR: ${t.pr}` : "",
    "",
    t.body,
    "",
    t.comments.length ? `Comments:\n${t.comments.map((c) => `- [${c.author}] ${c.body}`).join("\n")}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}