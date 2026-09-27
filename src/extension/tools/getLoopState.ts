import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_get_loop_state",
    label: "Empress Get Loop State",
    description: "Return the Superintendent loop state (status, cadence timestamps, consecutive failures) from .empress/superintendent-state.json.",
    parameters: Type.Object({}),
    async execute() {
      const { readLoopState } = await import("../../cli/state.js");
      return reply(JSON.stringify(readLoopState(projectDir())));
    },
  });
}