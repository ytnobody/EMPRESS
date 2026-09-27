import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_update_loop_state",
    label: "Empress Update Loop State",
    description: "Persist one or more keys into .empress/superintendent-state.json (e.g. {'status':'paused'}).",
    parameters: Type.Object({ patch: Type.Object({}, { additionalProperties: true }) }),
    async execute(_id, params) {
      const { patchLoopState } = await import("../../cli/state.js");
      const state = patchLoopState(projectDir(), params.patch || {});
      return reply(JSON.stringify(state));
    },
  });
}