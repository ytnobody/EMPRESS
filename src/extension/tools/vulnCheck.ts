import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runVulnCheck } from "../../domain/vuln.ts";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_vuln_check",
    label: "Empress Vuln Check",
    description: "Deterministic dependency vulnerability scan (govulncheck / npm audit / pip-audit, auto-detected by stack). Returns findings sorted by severity. Run before landing any change touching dependencies.",
    parameters: Type.Object({
      cwd: Type.Optional(Type.String({ description: "project dir to scan (default: resolved project root)" })),
    }),
    async execute(_id, params) {
      const dir = params?.cwd ? path.resolve(projectDir(), params.cwd) : projectDir();
      const r = runVulnCheck(dir);
      const lines = r.ok ? [r.summary ?? "", ...r.findings.map((f) => `[${f.severity}]${f.isDirect ? " (direct)" : ""} ${f.name} ${f.range}${f.fixAvailable ? " [fix available]" : ""}`)].slice(0, 50) : [r.error];
      return reply(lines.join("\n"));
    },
  });
}