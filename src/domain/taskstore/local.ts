// Local task store backend — the original `.empress/tasks/NNNN-title.md` files
// (offline / local-first baseline). Used whenever gh integration is off or
// unavailable.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../../shared/config.ts";
import { readMd, writeMd } from "../../shared/frontmatter.ts";
import { TASK_STATUSES, buildMarkdown, withAgentMarker, isAgentAuthor, type Task, type TaskInput, type TaskStore } from "./shared.ts";

function tasksDir(cwd: string): string {
  return path.join(cwd, EMPRESS_DIR, "tasks");
}

/** Read a task file into a normalized object. */
export function readTaskFile(file: string): Task {
  const { frontmatter, body } = readMd(file);
  const id = Number(frontmatter.id ?? path.basename(file).split("-")[0]);
  return {
    id,
    file,
    kind: "local", // file tasks can never be GitHub PRs — always labeled "task #N"
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
      ? (frontmatter.comments as Task["comments"])
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
    // Marker is reserved for harness-agent authors; a human-authored local
    // comment must not get it, else hasHumanReply misreads it as agent (task #32).
    const t = get(id);
    if (!t) return null;
    const b = isAgentAuthor(author) ? withAgentMarker(body) : body;
    return update(id, { comments: [...t.comments, { at: new Date().toISOString(), author, body: b }] });
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