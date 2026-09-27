import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evaluateRisk } from "../../domain/risk.ts";
import { getTask } from "../../domain/tasks.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_evaluate_risk",
    label: "Empress Evaluate Risk",
    description: "Evaluate the risk of landing a task's branch (deterministic heuristics + Jev choice judgment on the diff). Returns LOW/MEDIUM/HIGH.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t) return reply("task not found");
      const risk = await evaluateRisk(cwd, config, t);
      return reply(JSON.stringify(risk));
    },
  });
}