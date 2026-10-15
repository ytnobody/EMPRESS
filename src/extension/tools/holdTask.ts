import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addComment, getTask, sanitizeMetaValue, updateTask } from "../../domain/tasks.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_hold_task",
    label: "Empress Hold Task",
    description: "Persist a task as held/awaiting-human so the loop stops re-selecting it (cleared by an explicit unhold, a human comment, or a merge).",
    parameters: Type.Object({
      id: Type.Number(),
      reason: Type.Optional(Type.String({ description: "why it is held, e.g. human-gated HIGH control-plane change" })),
    }),
    async execute(_id, params) {
      const cwd = projectDir();
      const t = getTask(cwd, params.id);
      if (!t) return reply("task not found");
      const reason = sanitizeMetaValue(params.reason || "awaiting human");
      const held = updateTask(cwd, params.id, { status: "held", hold_reason: reason });
      addComment(cwd, params.id, "empress", `**[empress]** Held for human: ${reason}\n<!--empress:held-->`);
      return reply(JSON.stringify({ success: true, id: params.id, status: held?.status, hold_reason: reason }));
    },
  });
}
