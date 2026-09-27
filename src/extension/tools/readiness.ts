import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addComment, detectLanguage, getTask, proposeSpec, updateTask } from "../../domain/tasks.ts";
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
      const verdict = await checkReadiness(cwd, config, t);
      if (verdict.needs_clarification) {
        // Proposal-based clarification: post a concrete draft spec + open questions
        // (deduped) so the human has something to respond to in comments, instead of
        // a bare "please clarify". The Superintendent then drives the Q&A and, when
        // resolved, rewrites the body via empress_apply_clarification.
        const alreadyProposed = (t.comments || []).some((c) => String(c.body || "").includes("empress:clarify-proposal"));
        if (!alreadyProposed) {
          const lang = detectLanguage(`${t.title || ""} ${t.body || ""}`);
          const ja = lang === "ja";
          const p = proposeSpec(t, lang);
          const proposal = [
            ja
              ? "**[empress]** このタスクは仕様が不足しています。タイトルから推測した**ドラフト仕様**です。以下の**未解決の質問**に**返信で回答**（または確認・修正）してください："
              : "**[empress]** This task looks under-specified. Here is a **draft spec I inferred from the title** — please **answer the open questions below** in a reply (or confirm / adjust):",
            "<!--empress:clarify-proposal-->",
            "",
            ja ? "**提案（ドラフト）:**" : "**Proposed:**",
            `- Purpose: ${p.purpose}`,
            `- Scope: ${p.scope}`,
            `- Acceptance Criteria: ${p.acceptance.map((a) => `[ ] ${a}`).join(" ")}`,
            `- Non-Goals: ${p.nongoals.join(", ")}`,
            "",
            ja ? "**未解決の質問:**" : "**Open questions:**",
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