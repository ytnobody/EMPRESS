import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runProjectCi } from "../../domain/ci.ts";
import { landBranch, removeWorktree } from "../../domain/git.ts";
import { pushBranchAndCreatePr } from "../../domain/github.ts";
import { addComment, closeTask, getTask, updateTask, issueLang, highHoldPatch } from "../../domain/tasks.ts";
import { addLesson } from "../../domain/lessons.ts";
import { agentL10n } from "../../domain/l10n.ts";
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
      // Persist the human-gated HIGH as `held` so the loop stops re-selecting it
      // every pass (lesson #314). Force semantics are unchanged: force=true still
      // bypasses this refusal and never triggers a hold.
      const hold = highHoldPatch(riskEval.level, Boolean(params.force), riskEval.reasons);
      if (hold) {
        updateTask(cwd, params.id, hold);
        // Issue-bound comment: match the issue's language (ja/zh/ko/en), [project] default.
        const l = agentL10n(issueLang(t.title, t.body, config.project?.language || "en"));
        addComment(cwd, params.id, "empress", l.highRiskSkip(riskEval.reasons.join("; ")));
        return reply(JSON.stringify({ merged: false, reason: "HIGH risk", held: true, reasons: riskEval.reasons }));
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
          const l = agentL10n(issueLang(t.title, t.body, config.project?.language || "en"));
          addComment(cwd, params.id, "empress", l.prOpened(prRes.prUrl));
          replyBody.prUrl = prRes.prUrl;
        } else {
          const l = agentL10n(issueLang(t.title, t.body, config.project?.language || "en"));
          addComment(cwd, params.id, "empress", l.prFailed(prRes.error || "unknown"));
          replyBody.prError = prRes.error || "PR creation failed";
        }
      }

      const res = landBranch(cwd, base, t.branch);
      Object.assign(replyBody, res);
      if (res.merged) {
        // Comments are issue-bound; the auto-lesson is repo-bound ([project] language).
        const l = agentL10n(issueLang(t.title, t.body, config.project?.language || "en"));
        closeTask(cwd, params.id, l.landedNote(base, res.note || ""));
        removeWorktree(cwd, params.id, t.branch);
        addLesson(cwd, agentL10n(config.project?.language || "en").lessonAfterLand(params.id, riskEval.level, riskEval.reasons.join("; ")));
      }
      return reply(JSON.stringify(replyBody));
    },
  });
}