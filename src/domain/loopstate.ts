// Pure loop-state helpers. No I/O: I/O (fs read/write/mkdir of
// .empress/superintendent-state.json) lives in src/cli/state.js, which stays a
// thin shell over these. Same shape as HERMIT's loop state.
export interface LoopState {
  status: string;
  pr_comments_since: string | null;
  task_comments_since: string | null;
  last_pass_at: string | null;
  consecutive_failures: number;
  consecutive_jev_failures: number;
  last_success_tick: string | null;
}

export function defaultLoopState(): LoopState {
  return {
    status: "running",
    pr_comments_since: null,
    task_comments_since: null,
    last_pass_at: null,
    consecutive_failures: 0,
    consecutive_jev_failures: 0,
    last_success_tick: null,
  };
}

export function mergeLoopState(base: LoopState, patch: Partial<LoopState>): LoopState {
  return { ...base, ...patch };
}