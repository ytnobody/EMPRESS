import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ghAvailable, pushBranchAndCreatePr } from "../../domain/github.ts";
import { addComment, getTask, updateTask, issueLang } from "../../domain/tasks.ts";
import { agentL10n } from "../../domain/l10n.ts";
import { cfg, projectDir, reply } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_push_pr",
    label: "Empress Push PR",
    description: "Push a task's branch to origin and open a GitHub PR into the base branch via the gh CLI. ONLY active when [github] enabled=true (default: disabled — in that case it returns 'disabled' and never touches gh or a remote).",
    parameters: Type.Object({ id: Type.Number() }),
    async execute(_id, params) {
      const cwd = projectDir();
      const config = cfg();
      const ghCfg = config.github || { enabled: false, owner: "", repo: "" };
      if (!ghCfg.enabled) {
        return reply(JSON.stringify({ ok: false, reason: "github integration disabled ([github] enabled = false)" }));
      }
      if (!ghAvailable()) {
        return reply(JSON.stringify({ ok: false, reason: "gh CLI not installed" }));
      }
      const t = getTask(cwd, params.id);
      if (!t || !t.branch) return reply("task has no branch (create_worktree first)");
      const base = config.project?.base_branch;
      const res = pushBranchAndCreatePr(
        cwd,
        {
          base,
          branch: t.branch,
          title: `Task #${params.id}: ${t.title}`,
          body: t.body,
        },
        ghCfg
      );
      if (res.ok && res.prUrl) {
        updateTask(cwd, params.id, { pr: res.prUrl });
        const l = agentL10n(issueLang(t.title, t.body, config.project?.language || "en"));
        addComment(cwd, params.id, "empress", l.prOpened(res.prUrl));
      }
      return reply(JSON.stringify(res));
    },
  });
}