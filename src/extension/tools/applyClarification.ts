import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addComment, getTask, issueLang, updateTask, type Task } from "../../domain/tasks.ts";
import { agentL10n } from "../../domain/l10n.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_apply_clarification",
    label: "Empress Apply Clarification",
    description: "Rewrite a needs_clarification task's issue body with the RESOLVED spec and clear the needs_clarification flag / status so the task becomes actionable. Call this once the clarification Q&A (comments) has answered the open questions; the Superintendent is the one who finalizes the spec, not the human.",
    parameters: Type.Object({ id: Type.Number(), body: Type.String(), status: Type.Optional(Type.String({ default: "open" })) }),
    async execute(_id, params) {
      const cwd = projectDir();
      const t = getTask(cwd, params.id);
      if (!t) return reply(`task #${params.id} not found`);
      const updated = updateTask(cwd, params.id, { needs_clarification: false, status: params.status || "open" }, params.body);
      if (!updated) return reply(`task #${params.id} not found`);
      const l = agentL10n(issueLang(t.title, t.body, cfg().project?.language || "en"));
      addComment(cwd, params.id, "empress", l.clarifyApplied());
      return reply(JSON.stringify({ ok: true, id: params.id, status: (updated as Task).status }));
    },
  });
}