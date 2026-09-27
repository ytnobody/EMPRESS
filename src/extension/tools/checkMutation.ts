import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { getTask } from "../../domain/tasks.ts";
import { diffBetween } from "../../domain/git.ts";
import { runMutationGate } from "../../domain/mutation.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_check_mutation",
    label: "Empress Check Mutation",
    description: "Deterministic weak-test gate on a task branch: mutate the branch's changed src files that have tests, run each file's test, and classify the surviving mutants via Jev (equivalent/benign vs genuine gap / weak test). Returns ok only when the mutation score is healthy and no genuine gap is found; otherwise the landing should be held for review. OFF until [mutation] enabled=true.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const mc = (config.mutation || { enabled: false, min_score: 0.8, max_files: 3, max_mutants: 60 });
      if (!mc.enabled) return reply(JSON.stringify({ ok: false, reason: "mutation gate disabled ([mutation] enabled=false)" }));
      const t = getTask(cwd, params.id);
      if (!t || !t.branch) return reply(JSON.stringify({ ok: false, reason: "task has no branch (create_worktree first)" }));
      const base = config.project?.base_branch || "develop";
      const wt = fs.existsSync(path.join(cwd, ".empress", "worktrees", String(params.id)))
        ? path.join(cwd, ".empress", "worktrees", String(params.id))
        : cwd;
      const changed = diffBetween(wt, base, t.branch).changed;
      const gate = await runMutationGate(wt, changed, {
        minScore: mc.min_score ?? 0.8,
        maxFiles: mc.max_files ?? 3,
        maxMutants: mc.max_mutants ?? 60,
        jevModel: (config.jev && config.jev.model) || "jev-latest",
      });
      return reply(
        JSON.stringify({
          ok: gate.ok,
          score: gate.score,
          low_score_files: gate.lowFiles.map((r) => ({ file: r.relSrc, score: r.score, survivors: r.survivors })),
          survivors: gate.survivors,
          genuine_gaps: gate.genuine,
          jev: gate.jevNote,
          files: gate.reports.map((r) => ({ file: r.relSrc, killed: r.killed, total: r.total, score: r.score })),
        })
      );
    },
  });
}