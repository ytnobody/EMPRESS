import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addComment, clearHoldPatch, getTask, updateTask } from "../../domain/tasks.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_unhold_task",
    label: "Empress Unhold Task",
    description: "Explicitly clear a held task's hold, returning it to the actionable set (assigned/open).",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const t = getTask(cwd, params.id);
      if (!t) return reply("task not found");
      const patch = clearHoldPatch(t);
      const next = updateTask(cwd, params.id, patch);
      addComment(cwd, params.id, "empress", "**[empress]** Hold cleared — back to the actionable set.\n<!--empress:unheld-->");
      return reply(JSON.stringify({ success: true, id: params.id, status: next?.status }));
    },
  });
}
