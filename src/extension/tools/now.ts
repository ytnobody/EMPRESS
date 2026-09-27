import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_now",
    label: "Empress Now",
    description: "Return the current wall-clock time (RFC3339). Authoritative for cadence tracking.",
    parameters: Type.Object({}),
    async execute() {
      return reply(JSON.stringify(new Date().toISOString()));
    },
  });
}