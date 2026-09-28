import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addComment, CLARIFY_FRAME, detectLanguage, getTask, issueLang, proposeSpec, taskRef, updateTask } from "../../domain/tasks.ts";

import { checkReadiness } from "../../domain/readiness.ts";

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
      // A number that resolves to a pull request is not a task issue — never
      // drive clarification / labeling / closing on it (the #14 wrong-close).
      if (t.kind === "pr") {
        return reply(JSON.stringify({ ready: false, reasons: [`${taskRef(t)} is a pull request, not an issue task — refusing to treat it as a task`], jev: null }));
      }
      const verdict = await checkReadiness(cwd, config, t);
      if (verdict.needs_clarification) {
        // Proposal-based clarification: post a concrete draft spec + open questions
        // (deduped) so the human has something to respond to in comments, instead of
        // a bare "please clarify". The Superintendent then drives the Q&A and, when
        // resolved, rewrites the body via empress_apply_clarification.
        const alreadyProposed = (t.comments || []).some((c) => String(c.body || "").includes("empress:clarify-proposal"));
        if (!alreadyProposed) {
          // Issue-bound comment: match the issue's detected language (en/ja/zh/ko), with
          // the [project] language as the default for the ambiguous en/unknown slot.
          const lang = issueLang(t.title, t.body, cfg().project?.language || "en");
          const f = CLARIFY_FRAME[lang] || CLARIFY_FRAME.en;
          const p = proposeSpec(t, lang);
          const proposal = [
            f.header,
            "<!--empress:clarify-proposal-->",
            "",
            f.proposed,
            `- Purpose: ${p.purpose}`,
            `- Scope: ${p.scope}`,
            `- Acceptance Criteria: ${p.acceptance.map((a) => `[ ] ${a}`).join(" ")}`,
            `- Non-Goals: ${p.nongoals.join(", ")}`,
            "",
            f.questions,
            ...p.questions.map((q, i) => `${i + 1}. ${q}`),
            "",
            `(reason: ${verdict.reasons.join("; ")})`,
          ].join("\n");
          addComment(cwd, params.id, "empress", proposal);

          updateTask(cwd, params.id, { needs_clarification: true, status: "blocked" });
          t.needs_clarification = true;
        }
        return reply(JSON.stringify({ ready: false, reasons: verdict.reasons, jev: verdict.jev }));
      }
      return reply(JSON.stringify({ ready: true, reasons: verdict.reasons, jev: verdict.jev }));
    },
  });
}