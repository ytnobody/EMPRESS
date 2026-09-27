import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addComment, getTask, updateTask } from "../../domain/tasks.ts";
import { checkReadiness, planClarifyProposals } from "../../domain/readiness.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_readiness",
    label: "Empress Readiness",
    description: "Judge whether a task is ready to be implemented (deterministic guards + Jev noul). Post the hearing comment and mark needs_clarification when not ready.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t) return reply(`task #${params.id} not found`);
      const verdict = await checkReadiness(cwd, config, t);
      if (verdict.needs_clarification) {
        // Proposal-based clarification: post a concrete draft spec + open questions
        // (deduped by the shared planner — the run driver may already have posted it
        // on first detection) so the human has something to respond to in comments,
        // instead of a bare "please clarify". The Superintendent then drives the Q&A
        // and, when resolved, rewrites the body via empress_apply_clarification.
        const plans = planClarifyProposals([{ task: t, reasons: verdict.reasons }]);
        if (plans.length) {
          addComment(cwd, params.id, "empress", plans[0].comment);
          updateTask(cwd, params.id, { needs_clarification: true, status: "blocked" });
          t.needs_clarification = true;
        }
        return reply(JSON.stringify({ ready: false, reasons: verdict.reasons, jev: verdict.jev }));
      }
      return reply(JSON.stringify({ ready: true, reasons: verdict.reasons, jev: verdict.jev }));
    },
  });
}