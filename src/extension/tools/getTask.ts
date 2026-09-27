import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTask, taskBrief } from "../../domain/tasks.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_get_task",
    label: "Empress Get Task",
    description: "Return a single task by id including its body and comment log.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const t = getTask(projectDir(), params.id);
      return reply(t ? taskBrief(t) : `task #${params.id} not found`);
    },
  });
}