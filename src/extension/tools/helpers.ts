// EMPRESS — shared helpers for the empress_* tool registrations in tools/.
// Kept here so empress.ts stays a thin registration index and each tool module
// only carries its own registerTool block.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import { loadConfig, resolveProjectRoot, type LoadedConfig } from "../../shared/config.ts";
import { issueLang, taskBrief, type Task } from "../../domain/tasks.ts";

const LANG_NAME: Record<string, string> = { ja: "Japanese", zh: "Chinese", ko: "Korean", en: "English" };

const here = path.dirname(fileURLToPath(import.meta.url));
// The pi extension entry (src/extension/empress.ts), passed to spawned engineers.
export const extensionEntry = path.resolve(here, "..", "empress.ts");

// Build a tool result (text content only, empty details) satisfying AgentToolResult.
export function reply(text: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: undefined };
}

// Resolve the project root (walking up from, e.g., a git worktree) so task-store
// tools always hit the main repo's .empress. Superintendent runs at the root.
export function projectDir() {
  return resolveProjectRoot();
}

export const cfg = () => loadConfig(projectDir());

// ---- Engineer spawner -------------------------------------------------------

export type SpawnResult = { task: number; code: number; report: string; err: string };

export function spawnEngineer(projectCwd: string, task: Task, worktreePath: string | undefined, { model, maxConcurrent }: { model?: string; maxConcurrent: number }) {
  const engineerPrompt = path.join(projectCwd, ".empress", "agents", "engineer.md");
  const ext = extensionEntry;
  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "-e", ext,
  ];
  if (model) args.push("--model", model);
  if (fs.existsSync(engineerPrompt)) args.push("--append-system-prompt", engineerPrompt);
  // Issue-bound output (task comments, final report) matches the issue's
  // language, with the [project] language as the default for the en/unknown slot.
  const projectLang = loadConfig(projectCwd).project?.language || "en";
  const lang = LANG_NAME[issueLang(task.title, task.body, projectLang)] || "English";
  args.push(
    `Implement the following task for EMPRESS. Work inside the provided worktree, run the project test command, commit to the branch, and report back (task id, branch, what you did, test result).\n\n${taskBrief(task)}\n\nLanguage: write all your task comments and your final report in ${lang} (resolved from this issue's language; [project] language = ${projectLang}).`
  );

  return new Promise<SpawnResult>((resolve) => {
    const proc = spawn("pi", args, { cwd: worktreePath, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => resolve({ task: task.id, code: code ?? -1, report: out.slice(0, 8000), err: err.slice(0, 2000) }));
    proc.on("error", (e) => resolve({ task: task.id, code: -1, report: "", err: String(e.message) }));
  });
}

// Node 18.11+/22 has fs.existsSync; use the imported helper.

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- Notification -----------------------------------------------------------

export async function notify(config: LoadedConfig, event: string, message: string) {
  const url = config.notification?.webhook_url;
  if (!url) return { sent: false, event };
  const text = message || event;
  let payload;
  const type = (config.notification?.type || detectType(url));
  if (type === "slack") payload = { text };
  else if (type === "discord") payload = { content: text };
  else payload = { text, event };
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return { sent: res.ok, event, status: res.status };
  } catch (e: unknown) {
    return { sent: false, event, error: String((e && (e as { message?: unknown }).message) || e) };
  }
}
function detectType(url: string) {
  if (/discord/.test(url)) return "discord";
  if (/hooks\.slack/.test(url)) return "slack";
  return "generic";
}