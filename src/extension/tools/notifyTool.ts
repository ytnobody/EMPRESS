import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cfg, notify, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_notify",    label: "Empress Notify",
    description: "Send an optional webhook notification (Slack/Discord/generic). No-op when no webhook is configured.",
    parameters: Type.Object({ event: Type.String(), message: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const result = await notify(cfg(), params.event, params.message || "");
      return reply(JSON.stringify(result));
    },
  });
}