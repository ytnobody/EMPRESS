// Task store — thin delegate over src/domain/taskstore.ts that preserves the
// historical API (cwd-first, synchronous). The active backend (local .md files
// vs GitHub issues) is chosen by config: `getTaskStore` returns the gh-backed
// store when `[github] enabled=true` (and gh is usable), else the local store.
//
// All existing call sites (CLI, superintendent/engineer tools) are unchanged.
import { loadConfig } from "../shared/config.ts";
import {
  getTaskStore,
  localTaskStore,
  ghTaskStore,
  readTaskFile,
  listTaskFiles,
  taskBrief,
  hasHumanReply,
  proposeSpec,
  detectLanguage,
  type SpecProposal,
  TASK_STATUSES,
} from "./taskstore.ts";
import type { Task, TaskComment, TaskInput, TaskListOpts, TaskStore } from "./taskstore.ts";

export {
  TASK_STATUSES,
  readTaskFile,
  listTaskFiles,
  localTaskStore,
  ghTaskStore,
  getTaskStore,
  taskBrief,
  hasHumanReply,
  proposeSpec,
  detectLanguage,
};
export type { Task, TaskComment, TaskInput, TaskListOpts, TaskStore, SpecProposal };

function store(cwd: string, s?: TaskStore): TaskStore {
  if (s) return s;
  return getTaskStore(cwd, loadConfig(cwd));
}

/** Create a new task from a title and structured body parts. */
export function createTask(cwd: string, input: TaskInput, s?: TaskStore): Task {
  return store(cwd, s).create(input);
}

/** List tasks. By default only actionable tasks (not done, not needs_clarification). */
export function listTasks(cwd: string, opts: TaskListOpts = {}, s?: TaskStore): Task[] {
  return store(cwd, s).list(opts);
}

/** Get a single task by id, including comments. */
export function getTask(cwd: string, id: number, s?: TaskStore): Task | null {
  return store(cwd, s).get(id);
}

/** Update selected task fields (and/or replace the body). */
export function updateTask(cwd: string, id: number, patch: Partial<Task> = {}, newBody?: string, s?: TaskStore): Task | null {
  return store(cwd, s).update(id, patch, newBody);
}

/** Append a comment (local: persisted in the task file; gh: posted as an issue comment). */
export function addComment(cwd: string, id: number, author: string, body: string, s?: TaskStore): Task | null {
  return store(cwd, s).addComment(id, author, body);
}

/** Close a task (mark done), optionally leaving a note comment. */
export function closeTask(cwd: string, id: number, note = "", s?: TaskStore): Task | null {
  return store(cwd, s).close(id, note);
}

/** Delete a task. */
export function removeTask(cwd: string, id: number, s?: TaskStore): boolean {
  return store(cwd, s).remove(id);
}