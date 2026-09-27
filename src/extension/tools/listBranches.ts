import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listBranches } from "../../domain/git.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_list_branches",
    label: "Empress List Branches",
    description: "List task branches (empress/task-*).",
    parameters: Type.Object({}),
    async execute() {
      const config = cfg();
      const branches = listBranches(projectDir(), config.agent?.branch_prefix);
      return reply(JSON.stringify(branches));
    },
  });
}