import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addComment } from "../../domain/tasks.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_task_comment",    label: "Empress Task Comment",
    description: "Post a comment on a task (local comment log).",
    parameters: Type.Object({ id: Type.Number(), body: Type.String(), author: Type.Optional(Type.String({ default: "superintendent" })) }),
    async execute(_id, params) {
      const c = addComment(projectDir(), params.id, params.author || "superintendent", params.body);
      return reply(c ? JSON.stringify({ success: true }) : "not found");
    },
  });
}