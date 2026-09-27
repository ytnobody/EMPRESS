import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runProjectCi } from "../../domain/ci.ts";
import { getTask } from "../../domain/tasks.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_check_ci",
    label: "Empress Check CI",
    description: "Run the project's configured test_command inside a task's worktree and report pass/fail.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t) return reply("task not found");
      const wt = path.join(cwd, ".empress", "worktrees", String(params.id));
      const testCommand = config.project?.test_command;
      if (!testCommand) return reply(JSON.stringify({ passing: true, note: "no test_command configured" }));
      const res = runProjectCi(fs.existsSync(wt) ? wt : cwd, config);
      return reply(JSON.stringify({ passing: res.code === 0, engine: res.engine, command: testCommand, stdout: res.stdout.slice(0, 4000), stderr: res.stderr.slice(0, 2000) }));
    },
  });
}