// Wake detection for the run driver: a zero-LLM fs hash of the task queue.
// The driver only spawns an LLM pass when this hash changes (a task was
// created/edited/closed) — no more fixed 120s LLM ticks on an idle queue.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { EMPRESS_DIR } from "../shared/config.ts";

/**
 * Content hash of the task queue (file names + contents). Deterministic and
 * free; changes iff a task was created, edited, or removed.
 */
export function tasksHash(cwd: string): string {
  const dir = path.join(cwd, EMPRESS_DIR, "tasks");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).sort();
  } catch {
    files = [];
  }
  const h = createHash("sha256");
  for (const f of files) {
    if (!f.endsWith(".md")) continue; // non-task noise (.probe/temp) must not wake the loop
    h.update(f);
    try {
      h.update(fs.readFileSync(path.join(dir, f)));
    } catch {
      /* unreadable file contributes its name only */
    }
  }
  return h.digest("hex");
}