// EMPRESS — pi extension. Registers empress_* custom tools (mirroring HERMIT's
// GitHub MCP tools but localized: tasks live in .empress/tasks, merges happen on
// local branches, and judgments go to Jev via the chariot CLI). No GitHub, no
// Claude Code.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadConfig, resolveProjectRoot } from "../shared/config.js";
import {
  listTasks,
  getTask,
  updateTask,
  addComment,
  closeTask,
  taskBrief,
} from "../domain/tasks.js";
import {
  createWorktree,
  removeWorktree,
  listBranches,
  runTest,
  landBranch,
  isGitRepo,
} from "../domain/git.js";
import { evaluateRisk } from "../domain/risk.js";
import { checkReadiness } from "../domain/readiness.js";
import { getLessons, addLesson } from "../domain/lessons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function projectDir() {
  // Resolve the project root (walking up from, e.g., a git worktree) so task-store
  // tools always hit the main repo's .empress. Superintendent runs at the root.
  return resolveProjectRoot();
}

// ---- Engineer spawner -------------------------------------------------------

function spawnEngineer(projectCwd, task, worktreePath, { model, maxConcurrent }) {
  const engineerPrompt = path.join(projectCwd, ".empress", "agents", "engineer.md");
  const ext = path.resolve(__dirname, "empress.ts");
  const args = [
    "--mode", "json",
    "--print",
    "--no-session",
    "-e", ext,
  ];
  if (model) args.push("--model", model);
  if (fs.existsSync(engineerPrompt)) args.push("--append-system-prompt", engineerPrompt);
  args.push(`Implement the following task for EMPRESS. Work inside the provided worktree, run the project test command, commit to the branch, and report back (task id, branch, what you did, test result).\n\n${taskBrief(task)}`);

  return new Promise((resolve) => {
    const proc = spawn("pi", args, { cwd: worktreePath, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => resolve({ task: task.id, code: code ?? -1, report: out.slice(0, 8000), err: err.slice(0, 2000) }));
    proc.on("error", (e) => resolve({ task: task.id, code: -1, report: "", err: String(e.message) }));
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
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

async function notify(config, event, message) {
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
  } catch (e) {
    return { sent: false, event, error: String(e && e.message || e) };
  }
}
function detectType(url) {
  if (/discord/.test(url)) return "discord";
  if (/hooks\.slack/.test(url)) return "slack";
  return "generic";
}

// ---- Registration -----------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cfg = () => loadConfig(projectDir());

  pi.registerTool({
    name: "empress_now",
    label: "Empress Now",
    description: "Return the current wall-clock time (RFC3339). Authoritative for cadence tracking.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: JSON.stringify(new Date().toISOString()) }] };
    },
  });

  pi.registerTool({
    name: "empress_get_config",
    label: "Empress Get Config",
    description: "Return the current EMPRESS configuration (base_branch, test_command, max_engineers, loop_interval, risk/readiness prefs).",
    parameters: Type.Object({}),
    async execute() {
      const c = cfg();
      const { project, agent, risk, readiness, jev } = c;
      return {
        content: [{ type: "text", text: JSON.stringify({ project, agent, risk, readiness, jev, file: c.file }) }],
      };
    },
  });

  pi.registerTool({
    name: "empress_list_tasks",
    label: "Empress List Tasks",
    description: "List actionable tasks (open/assigned/in-progress). With include_all, also list done + needs-clarification tasks.",
    parameters: Type.Object({
      include_all: Type.Optional(Type.Boolean({ description: "Include done and blocked-out tasks", default: false })),
    }),
    async execute(_id, params) {
      const cwd = projectDir();
      const tasks = listTasks(cwd, { includeAll: Boolean(params?.include_all) });
      return {
        content: [{ type: "text", text: JSON.stringify(tasks.map((t) => ({
          Number: t.id, Title: t.title, Status: t.status, assignee: t.assignee,
          labels: t.labels, needs_clarification: t.needs_clarification, branch: t.branch, body: t.body,
        }))) }],
      };
    },
  });

  pi.registerTool({
    name: "empress_get_task",
    label: "Empress Get Task",
    description: "Return a single task by id including its body and comment log.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const t = getTask(projectDir(), params.id);
      return { content: [{ type: "text", text: t ? taskBrief(t) : `task #${params.id} not found` }] };
    },
  });

  pi.registerTool({
    name: "empress_readiness",
    label: "Empress Readiness",
    description: "Judge whether a task is ready to be implemented (deterministic guards + Jev noul). Post the hearing comment and mark needs_clarification when not ready.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t) return { content: [{ type: "text", text: `task #${params.id} not found` }] };
      const verdict = await checkReadiness(cwd, config, t);
      if (verdict.needs_clarification) {
        if (!t.needs_clarification) {
          const hearing = [
            "This task is not ready to implement. Please clarify:",
            "- **Purpose** — what we are building and why",
            "- **Scope** — what is / is not included",
            "- **Acceptance Criteria** — concrete, testable conditions",
            "- **Non-Goals** — explicit exclusions",
            "",
            `(reason: ${verdict.reasons.join("; ")})`,
          ].join("\n");
          addComment(cwd, params.id, "empress", hearing);
          updateTask(cwd, params.id, { needs_clarification: true, status: "blocked" });
          t.needs_clarification = true;
        }
        return { content: [{ type: "text", text: JSON.stringify({ ready: false, reasons: verdict.reasons, jev: verdict.jev }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ ready: true, reasons: verdict.reasons, jev: verdict.jev }) }] };
    },
  });

  pi.registerTool({
    name: "empress_assign_task",
    label: "Empress Assign Task",
    description: "Mark a task as assigned / in-progress.",
    parameters: Type.Object({
      id: Type.Number(),
      assignee: Type.Optional(Type.String({ description: "agent label, e.g. superintendent", default: "superintendent" })),
    }),
    async execute(_id, params) {
      const t = updateTask(projectDir(), params.id, { status: "assigned", assignee: params.assignee || "superintendent" });
      return { content: [{ type: "text", text: t ? JSON.stringify({ success: true, task: t.id, status: t.status }) : "not found" }] };
    },
  });

  pi.registerTool({
    name: "empress_create_worktree",
    label: "Empress Create Worktree",
    description: "Create an isolated git worktree + branch for a task (empress/task-N). Worktree lands under .empress/worktrees/N.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t) return { content: [{ type: "text", text: `task #${params.id} not found` }] };
      try {
        if (!isGitRepo(cwd)) return { content: [{ type: "text", text: "not a git repository" }] };
        const { branch, worktreePath, existed } = createWorktree(cwd, {
          taskId: params.id,
          branchPrefix: config.agent?.branch_prefix,
          baseBranch: config.project?.base_branch,
        });
        const withBranch = updateTask(cwd, params.id, { branch, status: t.status === "open" ? "assigned" : t.status });
        return {
          content: [{ type: "text", text: JSON.stringify({ worktree_path: worktreePath, branch, existed, task: withBranch.id }) }],
        };
      } catch (e) {
        return { content: [{ type: "text", text: `create_worktree failed: ${e.message}` }], isError: true };
      }
    },
  });

  pi.registerTool({
    name: "empress_spawn_engineers",
    label: "Empress Spawn Engineers",
    description: "Spawn parallel pi Engineer subagents, one per task, each in its task's worktree. Bounded by max_engineers from config. Returns one entry per engineer (exit code + report).",
    parameters: Type.Object({
      ids: Type.Array(Type.Number(), { description: "task ids to implement" }),
      model: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, onUpdate) {
      const cwd = projectDir();
      const config = cfg();
      const cap = Number(config.agent?.max_engineers ?? 4);
      const ids = (params.ids || []).slice(0, cap);
      const tasks = ids.map((id) => getTask(cwd, id)).filter(Boolean);
      if (!tasks.length) return { content: [{ type: "text", text: "no valid tasks to spawn" }] };

      onUpdate?.({ content: [{ type: "text", text: `Spawning ${tasks.length} Engineer(s)...` }] });
      const results = await mapLimit(tasks, cap, (t, i) => {
        const wt = path.join(cwd, ".empress", "worktrees", String(t.id));
        const worktreePath = fs.existsSync(wt) ? wt : undefined;
        return spawnEngineer(cwd, t, worktreePath, { model: params.model, maxConcurrent: cap });
      });
      const summary = results.map((r) => `#${r.task}: exit=${r.code} ${r.code === 0 ? "ok" : "FAILED"}`).join("\n");
      return {
        content: [{ type: "text", text: `${summary}\n\n${results.map((r) => `#${r.task}\n${r.err ? "stderr: " + r.err + "\n" : ""}${r.report}`).join("\n\n")}` }],
      };
    },
  });

  pi.registerTool({
    name: "empress_check_ci",
    label: "Empress Check CI",
    description: "Run the project's configured test_command inside a task's worktree and report pass/fail.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t) return { content: [{ type: "text", text: "task not found" }] };
      const wt = path.join(cwd, ".empress", "worktrees", String(params.id));
      const testCommand = config.project?.test_command;
      if (!testCommand) return { content: [{ type: "text", text: JSON.stringify({ passing: true, note: "no test_command configured" }) }] };
      const res = runTest(fs.existsSync(wt) ? wt : cwd, testCommand);
      return {
        content: [{ type: "text", text: JSON.stringify({ passing: res.code === 0, command: testCommand, stdout: res.stdout.slice(0, 4000), stderr: res.stderr.slice(0, 2000) }) }],
      };
    },
  });

  pi.registerTool({
    name: "empress_evaluate_risk",
    label: "Empress Evaluate Risk",
    description: "Evaluate the risk of landing a task's branch (deterministic heuristics + Jev choice judgment on the diff). Returns LOW/MEDIUM/HIGH.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t) return { content: [{ type: "text", text: "task not found" }] };
      const risk = await evaluateRisk(cwd, config, t);
      return { content: [{ type: "text", text: JSON.stringify(risk) }] };
    },
  });

  pi.registerTool({
    name: "empress_land_task",
    label: "Empress Land Task",
    description: "After CI passes and risk is acceptable, merge a task's branch into the base branch locally, clean up the worktree + branch, and record a lesson. HIGH risk (or require_human_approval) is refused unless force=true.",
    parameters: Type.Object({
      id: Type.Number(),
      force: Type.Optional(Type.Boolean({ description: "Force landing despite HIGH risk / warm-up mode", default: false })),
    }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t || !t.branch) return { content: [{ type: "text", text: "task has no branch (create_worktree first)" }] };
      const risk = config.risk || {};

      if (risk.require_human_approval && !params.force) {
        return { content: [{ type: "text", text: JSON.stringify({ merged: false, reason: "require_human_approval (warm-up mode) — pass force=true" }) }] };
      }

      const testCommand = config.project?.test_command;
      if (testCommand) {
        const wt = path.join(cwd, ".empress", "worktrees", String(params.id));
        const check = runTest(fs.existsSync(wt) ? wt : cwd, testCommand);
        if (check.code !== 0) {
          return { content: [{ type: "text", text: JSON.stringify({ merged: false, reason: `test_command failed: ${check.stderr.slice(0, 1000) || check.stdout.slice(0, 1000)}` }) }] };
        }
      }

      const riskEval = await evaluateRisk(cwd, config, t);
      if (riskEval.level === "HIGH" && !params.force) {
        addComment(cwd, params.id, "empress", `⚠️ HIGH risk — skipping auto-land. Reasons: ${riskEval.reasons.join("; ")}`);
        return { content: [{ type: "text", text: JSON.stringify({ merged: false, reason: "HIGH risk", reasons: riskEval.reasons }) }] };
      }

      const base = config.project?.base_branch;
      const res = landBranch(cwd, base, t.branch);
      if (res.merged) {
        closeTask(cwd, params.id, `Landed into ${base} (${res.note}).`);
        removeWorktree(cwd, params.id, t.branch);
        addLesson(cwd, `After landing task #${params.id}, the result was ${riskEval.level} risk — ${riskEval.reasons.join("; ") || "no concerns"}.`);
      }
      return { content: [{ type: "text", text: JSON.stringify({ ...res, branch: t.branch }) }] };
    },
  });

  pi.registerTool({
    name: "empress_task_comment",    label: "Empress Task Comment",
    description: "Post a comment on a task (local comment log).",
    parameters: Type.Object({ id: Type.Number(), body: Type.String(), author: Type.Optional(Type.String({ default: "superintendent" })) }),
    async execute(_id, params) {
      const c = addComment(projectDir(), params.id, params.author || "superintendent", params.body);
      return { content: [{ type: "text", text: c ? JSON.stringify({ success: true }) : "not found" }] };
    },
  });

  pi.registerTool({
    name: "empress_close_task",
    label: "Empress Close Task",
    description: "Mark a task done (optionally with a note).",
    parameters: Type.Object({ id: Type.Number(), note: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const t = closeTask(projectDir(), params.id, params.note || "");
      return { content: [{ type: "text", text: t ? JSON.stringify({ success: true, status: t.status }) : "not found" }] };
    },
  });

  pi.registerTool({
    name: "empress_ponytail_debt",
    label: "Empress Ponytail Debt",
    description: "Harvest every `ponytail:` comment in the repo into a debt ledger (.empress/ponytail-debt.md), flagging markers with no upgrade path as no-trigger (they rot). Report only + persist ledger.",
    parameters: Type.Object({
      persist: Type.Optional(Type.Boolean({ description: "Write the ledger to .empress/ponytail-debt.md", default: true })),
    }),
    async execute(_id, params) {
      const cwd = projectDir();
      const { collectPonytailDebt } = await import("../domain/ponytail.js");
      const { rows, markers, noTrigger } = collectPonytailDebt(cwd);
      if (params?.persist !== false && rows.length) {
        const fs2 = await import("node:fs");
        const p = path.join(cwd, ".empress", "ponytail-debt.md");
        const body = [
          "# Ponytail debt ledger",
          `generated: ${new Date().toISOString()}`,
          "",
          ...rows.map((r) => r.line),
          "",
          `${rows.length} markers, ${noTrigger} with no trigger.`,
          "",
        ].join("\n");
        fs2.writeFileSync(p, body);
      }
      const text = rows.length
        ? `${rows.map((r) => r.line).join("\n")}\n\n${rows.length} markers, ${noTrigger} with no trigger.`
        : "No ponytail: debt. Clean ledger.";
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "empress_list_branches",
    label: "Empress List Branches",
    description: "List task branches (empress/task-*).",
    parameters: Type.Object({}),
    async execute() {
      const config = cfg();
      const branches = listBranches(projectDir(), config.agent?.branch_prefix);
      return { content: [{ type: "text", text: JSON.stringify(branches) }] };
    },
  });

  pi.registerTool({
    name: "empress_get_lessons",
    label: "Empress Get Lessons",
    description: "Return lessons learned from past tasks, to avoid repeating mistakes.",
    parameters: Type.Object({}),
    async execute() {
      const lessons = getLessons(projectDir());
      return { content: [{ type: "text", text: JSON.stringify(lessons) }] };
    },
  });

  pi.registerTool({
    name: "empress_add_lesson",
    label: "Empress Add Lesson",
    description: "Append a lesson learned to .empress/lessons.md.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      const ok = addLesson(projectDir(), params.text);
      return { content: [{ type: "text", text: JSON.stringify({ added: ok }) }] };
    },
  });

  pi.registerTool({
    name: "empress_get_loop_state",
    label: "Empress Get Loop State",
    description: "Return the Superintendent loop state (status, cadence timestamps, consecutive failures) from .empress/superintendent-state.json.",
    parameters: Type.Object({}),
    async execute() {
      const { readLoopState } = await import("../cli/state.js");
      return { content: [{ type: "text", text: JSON.stringify(readLoopState(projectDir())) }] };
    },
  });

  pi.registerTool({
    name: "empress_update_loop_state",
    label: "Empress Update Loop State",
    description: "Persist one or more keys into .empress/superintendent-state.json (e.g. {'status':'paused'}).",
    parameters: Type.Object({ patch: Type.Object({}, { additionalProperties: true }) }),
    async execute(_id, params) {
      const { patchLoopState } = await import("../cli/state.js");
      const state = patchLoopState(projectDir(), params.patch || {});
      return { content: [{ type: "text", text: JSON.stringify(state) }] };
    },
  });

  pi.registerTool({
    name: "empress_notify",    label: "Empress Notify",
    description: "Send an optional webhook notification (Slack/Discord/generic). No-op when no webhook is configured.",
    parameters: Type.Object({ event: Type.String(), message: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const result = await notify(cfg(), params.event, params.message || "");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
}