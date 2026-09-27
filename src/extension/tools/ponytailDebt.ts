import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_ponytail_debt",
    label: "Empress Ponytail Debt",
    description: "Harvest every `ponytail:` comment in the repo into a debt ledger (.empress/ponytail-debt.md), flagging markers with no upgrade path as no-trigger (they rot). Report only + persist ledger.",
    parameters: Type.Object({
      persist: Type.Optional(Type.Boolean({ description: "Write the ledger to .empress/ponytail-debt.md", default: true })),
    }),
    async execute(_id, params) {
      const cwd = projectDir();
      const { collectPonytailDebt } = await import("../../domain/ponytail.js");
      const { rows, lines, noTrigger } = collectPonytailDebt(cwd);
      if (params?.persist !== false && rows.length) {
        const fs2 = await import("node:fs");
        const p = path.join(cwd, ".empress", "ponytail-debt.md");
        const body = [
          "# Ponytail debt ledger",
          `generated: ${new Date().toISOString()}`,
          "",
          ...lines,
          "",
          `${rows.length} markers, ${noTrigger} with no trigger.`,
          "",
        ].join("\n");
        fs2.writeFileSync(p, body);
      }
      const text = rows.length
        ? `${lines.join("\n")}\n\n${rows.length} markers, ${noTrigger} with no trigger.`
        : "No ponytail: debt. Clean ledger.";
      return reply(text);
    },
  });
}