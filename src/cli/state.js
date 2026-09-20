// .empress/superintendent-state.json read/write. Mirrors HERMIT's loop state.
import * as fs from "node:fs";
import * as path from "node:path";
import { EMPRESS_DIR } from "../shared/config.js";

function stateFile(cwd) {
  return path.join(cwd, EMPRESS_DIR, "superintendent-state.json");
}

export function readLoopState(cwd) {
  const file = stateFile(cwd);
  if (!fs.existsSync(file)) {
    return { status: "running", pr_comments_since: null, task_comments_since: null, last_pass_at: null, consecutive_failures: 0, last_success_tick: null };
  }
  try {
    return { status: "running", ...JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch {
    return { status: "running", error: "state file unreadable" };
  }
}

export function writeLoopState(cwd, state) {
  fs.mkdirSync(path.join(cwd, EMPRESS_DIR), { recursive: true });
  fs.writeFileSync(stateFile(cwd), JSON.stringify(state, null, 2));
}

export function patchLoopState(cwd, patch) {
  const state = readLoopState(cwd);
  const next = { ...state, ...patch };
  writeLoopState(cwd, next);
  return next;
}