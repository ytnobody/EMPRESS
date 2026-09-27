import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runTriage } from "../../domain/triage.ts";
import { getTask } from "../../domain/tasks.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_triage_review",
    label: "Empress Triage Review",
    description: "Cheap review triage for a task branch: deterministic scans (secrets/dangerous patterns, code-without-tests convention signal) + ONE Jev noul call when Jev is available. Returns signal ok | review. Signal review (or degraded, or deterministic hits, or Jev error) means the Superintendent must do a full LLM review; only signal ok lets the pass fast-path (never for HIGH/trust-boundary/control-plane — those still get full review).",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t) return reply("task not found");
      const r = await runTriage(cwd, config, t);
      return reply(JSON.stringify({ signal: r.signal, reasons: r.reasons, degraded: r.degraded, deterministic: r.deterministic, convention: r.conv, jevNoul: r.jevNoul }));
    },
  });
}