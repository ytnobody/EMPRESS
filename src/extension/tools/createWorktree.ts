import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createWorktree, isGitRepo } from "../../domain/git.ts";
import { getTask, updateTask } from "../../domain/tasks.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_create_worktree",
    label: "Empress Create Worktree",
    description: "Create an isolated git worktree + branch for a task (empress/task-N). Worktree lands under .empress/worktrees/N.",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const t = getTask(cwd, params.id);
      if (!t) return reply(`task #${params.id} not found`);
      try {
        if (!isGitRepo(cwd)) return reply("not a git repository");
        const { branch, worktreePath, existed } = createWorktree(cwd, {
          taskId: params.id,
          branchPrefix: config.agent?.branch_prefix,
          baseBranch: config.project?.base_branch,
        });
        updateTask(cwd, params.id, { branch, status: t.status === "open" ? "assigned" : t.status });
        return reply(JSON.stringify({ worktree_path: worktreePath, branch, existed, task: params.id }));
      } catch (e: unknown) {
        return { content: [{ type: "text", text: `create_worktree failed: ${(e as { message?: unknown }).message}` }], isError: true, details: undefined };
      }
    },
  });
}