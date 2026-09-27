import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { closeTask } from "../../domain/tasks.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_close_task",
    label: "Empress Close Task",
    description: "Mark a task done (optionally with a note).",
    parameters: Type.Object({ id: Type.Number(), note: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const t = closeTask(projectDir(), params.id, params.note || "");
      return reply(t ? JSON.stringify({ success: true, status: t.status }) : "not found");
    },
  });
}