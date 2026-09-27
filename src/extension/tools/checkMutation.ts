import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { getTask } from "../../domain/tasks.ts";
import { diffBetween } from "../../domain/git.ts";
import { findTests, mutationTargets, runMutations } from "../../domain/mutation.ts";
import { jevAvailable, jevJudge } from "../../domain/jev.ts";
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
      const testIndex = findTests(wt);
      const targets = mutationTargets(wt, changed, testIndex, mc.max_files ?? 3);
      const reports = targets.map((x) => runMutations(wt, x.relSrc, x.test));
      const survivors = reports.flatMap((r) => r.survivors.map((s) => ({ file: r.relSrc, id: s })));
      const lowFiles = reports.filter((r) => r.total > 0 && r.score < (mc.min_score ?? 0.8));

      let genuine = 0;
      let jevNote = survivors.length ? "unclassified (no Jev)" : "no survivors";
      if (survivors.length > 0 && jevAvailable().available) {
        const states = survivors.map((s) => `File ${s.file}: mutant "${s.id}" survived — the test did NOT fail when the source was changed this way. Is this an equivalent/benign mutant, or a genuine gap where the test fails to verify the changed behavior (weak/meaningless assertion)?`);
        const j = await jevJudge({ type: "noul", instructions: "For each surviving mutant: high noul means it is a GENUINE GAP / weak test (must review); low noul means it is an EQUIVALENT, benign mutant.", states, model: (config.jev && config.jev.model) || "jev-latest" });
        if (j.ok) {
          genuine = j.results.reduce<number>(
            (acc, r) => acc + (r.answer && typeof r.answer.noul === "number" && r.answer.noul >= 0.7 ? 1 : 0),
            0
          );
          jevNote = `classified ${j.results.length} survivor(s)`;
        } else {
          jevNote = `jev failed: ${j.error}`;
        }
      }

      const okFlag = lowFiles.length === 0 && genuine === 0;
      const avg = reports.length ? reports.reduce((a, r) => a + r.score, 0) / reports.length : 1;
      return reply(
        JSON.stringify({
          ok: okFlag,
          score: avg,
          low_score_files: lowFiles.map((r) => ({ file: r.relSrc, score: r.score, survivors: r.survivors })),
          survivors,
          genuine_gaps: genuine,
          jev: jevNote,
          files: reports.map((r) => ({ file: r.relSrc, killed: r.killed, total: r.total, score: r.score })),
        })
      );
    },
  });
}