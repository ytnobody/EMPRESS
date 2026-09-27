import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cfg, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_get_config",
    label: "Empress Get Config",
    description: "Return the current EMPRESS configuration (base_branch, test_command, max_engineers, loop_interval, per-role models, github/gh flags, risk/readiness prefs).",
    parameters: Type.Object({}),
    async execute() {
      const c = cfg();
      const { project, agent, models, github, risk, readiness, jev, ci, run } = c;
      return reply(JSON.stringify({ project, agent, models, github, risk, readiness, jev, ci, run, file: c.file }));
    },
  });
}