// .empress/superintendent-state.json read/write. Thin I/O shell over the pure
// loop-state helpers in src/domain/loopstate.js (default object + patch merge).
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../shared/config.ts";
import { defaultLoopState, mergeLoopState, type LoopState } from "../domain/loopstate.ts";

// Patch accepted by patchLoopState: standard LoopState partial keys plus the
// run-driver's surface-only bookkeeping keys (last_skip_reason, pass_count) — not
// part of LoopState, but written through to the JSON for observability.
export type LoopStatePatch = Partial<LoopState> & { last_skip_reason?: string; pass_count?: number };

function stateFile(cwd: string) {
  return path.join(cwd, EMPRESS_DIR, "superintendent-state.json");
}

export function readLoopState(cwd: string): LoopState {
  const file = stateFile(cwd);
  if (!fs.existsSync(file)) {
    return defaultLoopState();
  }
  try {
    return mergeLoopState(defaultLoopState(), JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    // Literal fallback, same as before: not a merge of the default object.
    // [ASSUMPTION] cast: callers read the optional LoopState keys defensively
    // (`?? 0`, etc.), so the runtime object shape is unchanged (type-only).
    return { status: "running", error: "state file unreadable" } as unknown as LoopState;
  }
}

export function writeLoopState(cwd: string, state: LoopState) {
  fs.mkdirSync(path.join(cwd, EMPRESS_DIR), { recursive: true });
  fs.writeFileSync(stateFile(cwd), JSON.stringify(state, null, 2));
}

export function patchLoopState(cwd: string, patch: LoopStatePatch): LoopState {
  const state = readLoopState(cwd);
  const next = mergeLoopState(state, patch);
  writeLoopState(cwd, next);
  return next;
}