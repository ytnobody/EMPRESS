// .empress/superintendent-state.json read/write. Thin I/O shell over the pure
// loop-state helpers in src/domain/loopstate.js (default object + patch merge).
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../shared/config.js";
import { defaultLoopState, mergeLoopState } from "../domain/loopstate.js";

function stateFile(cwd) {
  return path.join(cwd, EMPRESS_DIR, "superintendent-state.json");
}

export function readLoopState(cwd) {
  const file = stateFile(cwd);
  if (!fs.existsSync(file)) {
    return defaultLoopState();
  }
  try {
    return mergeLoopState(defaultLoopState(), JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    // Literal fallback, same as before: not a merge of the default object.
    return { status: "running", error: "state file unreadable" };
  }
}

export function writeLoopState(cwd, state) {
  fs.mkdirSync(path.join(cwd, EMPRESS_DIR), { recursive: true });
  fs.writeFileSync(stateFile(cwd), JSON.stringify(state, null, 2));
}

export function patchLoopState(cwd, patch) {
  const state = readLoopState(cwd);
  const next = mergeLoopState(state, patch);
  writeLoopState(cwd, next);
  return next;
}