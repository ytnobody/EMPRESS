import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listTasks } from "../../domain/tasks.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_list_tasks",
    label: "Empress List Tasks",
    description: "List actionable tasks (open/assigned/in-progress). With include_all, also list done + needs-clarification tasks.",
    parameters: Type.Object({
      include_all: Type.Optional(Type.Boolean({ description: "Include done and blocked-out tasks", default: false })),
    }),
    async execute(_id, params) {
      const cwd = projectDir();
      const tasks = listTasks(cwd, { includeAll: Boolean(params?.include_all) });
      return reply(JSON.stringify(tasks.map((t) => ({
        Number: t.id, Title: t.title, Status: t.status, assignee: t.assignee,
        labels: t.labels, needs_clarification: t.needs_clarification, branch: t.branch, body: t.body,
      }))));
    },
  });
}