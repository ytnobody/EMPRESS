// Local task store: .empress/tasks/NNNN-title.md files with YAML-frontmatter.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../shared/config.ts";
import { readMd, writeMd, parseMdFile } from "../shared/frontmatter.ts";

export const TASK_STATUSES = ["open", "assigned", "in-progress", "done", "blocked"];

function tasksDir(cwd) {
  return path.join(cwd, EMPRESS_DIR, "tasks");
}

/** Read a task file into a normalized object. */
export function readTaskFile(file) {
  const { frontmatter, body } = parseMdFile(fs.readFileSync(file, "utf-8"));
  const id = Number(frontmatter.id ?? path.basename(file).split("-")[0]);
  return {
    id,
    file,
    title: frontmatter.title ?? "",
    status: TASK_STATUSES.includes(frontmatter.status) ? frontmatter.status : "open",
    assignee: frontmatter.assignee ?? "",
    labels: frontmatter.labels ?? [],
    needs_clarification: Boolean(frontmatter.needs_clarification),
    branch: frontmatter.branch ?? "",
    created: frontmatter.created ?? "",
    comments: Array.isArray(frontmatter.comments) ? frontmatter.comments : [],
    body,
  };
}

/** List task files sorted by id ascending. */
export function listTaskFiles(cwd) {
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

/**
 * List tasks. By default only actionable tasks are returned (not needs_clarification,
 * not done). Pass includeAll to see everything.
 */
export function listTasks(cwd, { includeAll = false } = {}) {
  return listTaskFiles(cwd)
    .map(readTaskFile)
    .filter(
      (t) => includeAll || (t.status !== "done" && !t.needs_clarification)
    );
}

export function getTask(cwd, id) {
  const file = findTaskFile(cwd, id);
  if (!file) return null;
  return readTaskFile(file);
}

function findTaskFile(cwd, id) {
  const idStr = String(id).padStart(4, "0");
  for (const f of listTaskFiles(cwd)) {
    if (path.basename(f).split("-")[0] === idStr || path.basename(f).split("-")[0] === String(id)) {
      return f;
    }
  }
  return null;
}

function nextId(cwd) {
  const files = listTaskFiles(cwd);
  let max = 0;
  for (const f of files) {
    const n = parseInt(path.basename(f).split("-")[0], 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

function slugify(s) {
  return (s || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

/**
 * Create a new task file from a title and structured body parts.
 * Markdown sections mirror the readiness hearing: Purpose / Scope / Acceptance Criteria / Non-Goals.
 */
export function createTask(cwd, { title, purpose = "", scope = "", acceptance = [], nongoals = [], labels = [] }) {
  fs.mkdirSync(tasksDir(cwd), { recursive: true });
  const id = nextId(cwd);
  const file = path.join(tasksDir(cwd), `${String(id).padStart(4, "0")}-${slugify(title)}.md`);
  const body = [
    `# ${title}`,
    "",
    "## Purpose",
    purpose || "_to be filled_",
    "",
    "## Scope",
    scope || "_to be filled_",
    "",
    "## Acceptance Criteria",
    ...(acceptance && acceptance.length
      ? acceptance.map((a) => `- [ ] ${a}`)
      : ["- [ ] _to be filled_"]),
    "",
    "## Non-Goals",
    ...(nongoals && nongoals.length ? nongoals.map((n) => `- ${n}`) : ["- _none yet_"]),
    "",
    "---",
    "> **Engineer note:** follow the two project conventions — Pure Function Testing / Command Verification (`read .empress/agents/coding-guidelines.md`) for *what you verify*, and Ponytail (`read .empress/agents/coding-guidelines-ponytail.md`) for *what you build* (laziest solution that works, YAGNI, stdlib-first; mark deliberate shortcuts `ponytail:` with a ceiling + upgrade path). For non-trivial work, write a minimal design doc (behavior + Command/interface spec) first, then tests, then implementation. If a requirement is ambiguous, mark it `[ASSUMPTION]` and add it to your handoff list instead of silently deciding (§10).",
    "",
  ].join("\n");
  const fm = {
    id,
    title,
    status: "open",
    assignee: "",
    labels: labels || [],
    needs_clarification: false,
    branch: "",
    created: new Date().toISOString(),
    comments: [],
  };
  writeMd(file, fm, body);
  return readTaskFile(file);
}

/** Update selected frontmatter keys (and/or body). */
export function updateTask(cwd, id, patch = {}, newBody) {
  const file = findTaskFile(cwd, id);
  if (!file) return null;
  const cur = parseMdFile(fs.readFileSync(file, "utf-8"));
  const fm = { ...cur.frontmatter };
  for (const k of ["title", "status", "assignee", "labels", "needs_clarification", "branch", "comments"]) {
    if (k in patch) fm[k] = patch[k];
  }
  writeMd(file, fm, newBody ?? cur.body);
  return readTaskFile(file);
}

export function addComment(cwd, id, author, body) {
  const t = getTask(cwd, id);
  if (!t) return null;
  const comments = [...t.comments, { at: new Date().toISOString(), author, body }];
  return updateTask(cwd, id, { comments });
}

export function closeTask(cwd, id, note = "") {
  const t = getTask(cwd, id);
  if (!t) return null;
  if (note) addComment(cwd, id, "empress", note);
  return updateTask(cwd, id, { status: "done" });
}

export function removeTask(cwd, id) {
  const file = findTaskFile(cwd, id);
  if (!file) return false;
  fs.unlinkSync(file);
  return true;
}

/** Human-readable single-line summary of a task for passing to an Engineer. */
export function taskBrief(t) {
  return [
    `Task #${t.id}: ${t.title}`,
    `Status: ${t.status}`,
    t.branch ? `Branch/worktree: ${t.branch}` : "",
    "",
    t.body,
    "",
    t.comments.length ? `Comments:\n${t.comments.map((c) => `- [${c.author}] ${c.body}`).join("\n")}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}