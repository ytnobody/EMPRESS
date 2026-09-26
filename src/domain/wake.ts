// Wake detection for the run driver: a zero-LLM fs hash of the task queue.
// The driver only spawns an LLM pass when this hash changes (a task was
// created/edited/closed) — no more fixed 120s LLM ticks on an idle queue.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { EMPRESS_DIR, loadConfig } from "../shared/config.ts";
import { run } from "../shared/shell.ts";

/**
 * Content hash of the task queue. Deterministic and free; changes iff a task was
 * created, edited, or removed.
 *
 * When `[github] enabled=true`, tasks are GitHub issues (not local files), so the
 * hash is derived from `gh issue list` (number/title/state/updatedAt) — this keeps
 * the zero-LLM wake poll functional for the gh-backed task store. Otherwise it
 * hashes the local `.empress/tasks/*.md` queue. If the gh call fails it falls back
 * to the (empty-on-gh) local hash so the loop stays quiescent rather than erroring.
 */
export function tasksHash(cwd: string): string {
  const cfg = loadConfig(cwd);
  const h = createHash("sha256");

  if (cfg.github && cfg.github.enabled) {
    // `gh issue list` without --repo resolves via the origin remote of `cwd`.
    const repoFlag = resolveRepoFlag(cwd);
    const args = ["issue", "list"];
    if (repoFlag) args.push("-R", repoFlag);
    args.push("--state", "all", "--limit", "1000", "--json", "number,title,state,updatedAt");
    const res = run("gh", args);
    if (res.code === 0) {
      try {
        const arr = JSON.parse(res.stdout) as Array<{ number: number; title: string; state: string; updatedAt?: string }>;
        for (const i of arr.sort((a, b) => a.number - b.number)) {
          h.update(String(i.number));
          h.update(String(i.title));
          h.update(String(i.state));
          h.update(String(i.updatedAt ?? ""));
        }
        return h.digest("hex");
      } catch {
        /* unparseable gh output — fall through to local hash */
      }
    }
    // gh unavailable/error → fall through to the (empty) local hash
  }

  const dir = path.join(cwd, EMPRESS_DIR, "tasks");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).sort();
  } catch {
    files = [];
  }
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

function resolveRepoFlag(cwd: string): string {
  // Prefer explicit owner/repo from config; else the origin remote of `cwd`.
  const g = loadConfig(cwd).github;
  if (g && g.owner && g.repo) return `${g.owner}/${g.repo}`;
  const remote = run("git", ["-C", cwd, "remote", "get-url", "origin"]);
  if (remote.code === 0) {
    const url = remote.stdout.trim();
    const m = url.match(/(?:github\.com[/:])([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return "";
}