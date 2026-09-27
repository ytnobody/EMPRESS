import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getTask, type Task } from "../../domain/tasks.ts";
import { cfg, mapLimit, projectDir, reply, spawnEngineer } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_spawn_engineers",
    label: "Empress Spawn Engineers",
    description: "Spawn parallel pi Engineer subagents, one per task, each in its task's worktree. Bounded by max_engineers from config. Returns one entry per engineer (exit code + report).",
    parameters: Type.Object({
      ids: Type.Array(Type.Number(), { description: "task ids to implement" }),
      model: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, onUpdate) {
      const cwd = projectDir();
      const config = cfg();
      const cap = Number(config.agent?.max_engineers ?? 4);
      const ids = (params.ids || []).slice(0, cap);
      const tasks = ids.map((id) => getTask(cwd, id)).filter((t): t is Task => t !== null);
      if (!tasks.length) return reply("no valid tasks to spawn");

      // Engineer model: explicit tool arg wins; else [models] engineer; else pi default.
      const engineerModel = params.model || (config.models && config.models.engineer) || undefined;
      onUpdate?.(reply(`Spawning ${tasks.length} Engineer(s)...`));
      const results = await mapLimit(tasks, cap, (t, i) => {
        const wt = path.join(cwd, ".empress", "worktrees", String(t.id));
        const worktreePath = fs.existsSync(wt) ? wt : undefined;
        return spawnEngineer(cwd, t, worktreePath, { model: engineerModel, maxConcurrent: cap });
      });
      const summary = results.map((r) => `#${r.task}: exit=${r.code} ${r.code === 0 ? "ok" : "FAILED"}`).join("\n");
      return reply(`${summary}\n\n${results.map((r) => `#${r.task}\n${r.err ? "stderr: " + r.err + "\n" : ""}${r.report}`).join("\n\n")}`);
    },
  });
}