import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { updateTask } from "../../domain/tasks.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
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
      return reply(t ? JSON.stringify({ success: true, task: t.id, status: t.status }) : "not found");
    },
  });
}