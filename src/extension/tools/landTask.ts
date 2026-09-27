import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runProjectCi } from "../../domain/ci.ts";
import { landBranch, removeWorktree } from "../../domain/git.ts";
import { pushBranchAndCreatePr } from "../../domain/github.ts";
import { addComment, closeTask, getTask, updateTask } from "../../domain/tasks.ts";
import { addLesson } from "../../domain/lessons.ts";
import { evaluateRisk } from "../../domain/risk.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
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
      if (!t || !t.branch) return reply("task has no branch (create_worktree first)");
      const risk = config.risk || {};

      if (risk.require_human_approval && !params.force) {
        return reply(JSON.stringify({ merged: false, reason: "require_human_approval (warm-up mode) — pass force=true" }));
      }

      const testCommand = config.project?.test_command;
      if (testCommand) {
        const wt = path.join(cwd, ".empress", "worktrees", String(params.id));
        const check = runProjectCi(fs.existsSync(wt) ? wt : cwd, config);
        if (check.code !== 0) {
          // git-or-skip: a failure on an env the preflight already flagged as
          // infra-caused (git absent / deps unresolvable) is not a code failure —
          // attribute it and let the Superintendent decide, rather than report a
          // spurious code-CI failure purely from prior infra state.
          if (check.preflight.skipEligible) {
            return reply(JSON.stringify({
              merged: false,
              reason: "ci_env_skip",
              note: "check failed but preflight classifies it as infra-caused (git/deps); not a code failure",
              preflight: check.preflight,
              detail: (check.stderr.slice(0, 1000) || check.stdout.slice(0, 1000)),
            }));
          }
          return reply(JSON.stringify({ merged: false, reason: `test_command failed (${check.engine}): ${check.stderr.slice(0, 1000) || check.stdout.slice(0, 1000)}` }));
        }
      }

      const riskEval = await evaluateRisk(cwd, config, t);
      if (riskEval.level === "HIGH" && !params.force) {
        addComment(cwd, params.id, "empress", `⚠️ HIGH risk — skipping auto-land. Reasons: ${riskEval.reasons.join("; ")}`);
        return reply(JSON.stringify({ merged: false, reason: "HIGH risk", reasons: riskEval.reasons }));
      }

      const base = config.project?.base_branch;
      const replyBody: Record<string, unknown> = { branch: t.branch };

      // When GitHub integration is enabled, open the remote PR BEFORE landing:
      // the local branch deletion (removeWorktree) and the ff-merge both make the
      // branch an ancestor of base, so a post-land push would open an empty PR.
      const ghCfg = config.github || { enabled: false, owner: "", repo: "" };
      if (ghCfg.enabled) {
        const prRes = pushBranchAndCreatePr(
          cwd,
          {
            base,
            branch: t.branch,
            title: `Task #${params.id}: ${t.title}`,
            body: t.body,
          },
          ghCfg
        );
        if (prRes.ok && prRes.prUrl) {
          updateTask(cwd, params.id, { pr: prRes.prUrl });
          addComment(cwd, params.id, "empress", `PR opened: ${prRes.prUrl}`);
          replyBody.prUrl = prRes.prUrl;
        } else {
          addComment(cwd, params.id, "empress", `PR step failed: ${prRes.error || "unknown"}`);
          replyBody.prError = prRes.error || "PR creation failed";
        }
      }

      const res = landBranch(cwd, base, t.branch);
      Object.assign(replyBody, res);
      if (res.merged) {
        closeTask(cwd, params.id, `Landed into ${base} (${res.note}).`);
        removeWorktree(cwd, params.id, t.branch);
        addLesson(cwd, `After landing task #${params.id}, the result was ${riskEval.level} risk — ${riskEval.reasons.join("; ") || "no concerns"}.`);
      }
      return reply(JSON.stringify(replyBody));
    },
  });
}