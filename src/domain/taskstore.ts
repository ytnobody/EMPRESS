// Task storage backends — split into three modules (no behaviour change):
//   shared.ts — backend-agnostic types + spec helpers (markdown body, language
//               detection, proposal drafting, human-reply detection, brief).
//   local.ts  — LocalTaskStore (`.empress/tasks/NNNN-title.md` files).
//   gh.ts     — GhTaskStore (GitHub issues via the gh CLI) + cross-store sync
//               + getTaskStore() backend selection.
//
// getTaskStore() picks the backend from config. src/domain/tasks.ts is a thin
// delegate over this index, so every existing call site keeps its signature.
export {
  TASK_STATUSES,
  buildMarkdown,
  hasHumanReply,
  detectLanguage,
  resolveLang,
  issueLang,
  proposeSpec,
  CLARIFY_FRAME,
  taskBrief,
  isHeld,
  highHoldPatch,
  clearHoldPatch,
  sanitizeMetaValue,
agentMarker, taskRef, normalizeTitle, editDistance, titlesNearMatch, findTitleDuplicate,
} from "./taskstore/shared.ts";
export { readTaskFile, listTaskFiles, localTaskStore } from "./taskstore/local.ts";
export {
  stripMetadata,
  buildGhBody,
  issueToTask,
  desiredLabels,
  ghTaskStore,
  syncLocalToGh,
  getTaskStore,
} from "./taskstore/gh.ts";
export type {
  Task,
  TaskComment,
  TaskInput,
  TaskListOpts,
  TaskStore,
  StoreDeps,
  SpecProposal,
} from "./taskstore/shared.ts";
export type { SyncResult } from "./taskstore/gh.ts";