import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectAuditFindings } from "../../domain/audit.ts";
import { branchExists, pruneStaleMergedBranches, pruneStaleMergedRemoteBranches } from "../../domain/git.ts";
import { listTasks } from "../../domain/tasks.ts";
import { cfg, projectDir } from "./helpers.ts";

export function register(pi: ExtensionAPI) {
  pi.registerTool({
    name: "empress_audit_scan",
    label: "Empress Audit Scan",
    description: "Deterministic idle-audit scans across three axes: modern (TODO/FIXME/HACK rot, oversized files, legacy .js residue), secure (tracked secret-ish files like .env/credentials), light (large files). Returns per-axis findings + summary. The Superintendent audit pass files REAL findings as tasks (deduped automatically by the CLI: near-identical titles are skipped); the loop then implements+lands them when idle. Output labels every task number as issue #N / PR #N (never a bare #N).",
    parameters: Type.Object({}),
    async execute(_id, params) {
      const cwd = projectDir();
      const r = collectAuditFindings(cwd);
      const lines: string[] = [r.summary, "", ...r.findings.map((f) => `[${f.axis}] ${f.title} — ${f.detail}`)];
      // Auto-prune stale merged local branches (safe delete) instead of filing a
      // housekeeping task for them — dead merged branches are cleaned up by the
      // harness itself. Default sweep protects current branch + base + main +
      // develop AND any branch checked out in an EMPRESS-managed worktree (an
      // in-progress engineer task whose branch still points at base): it never
      // kills a managed worktree in default-deny mode.
      const base = cfg().project.base_branch || "develop";
      const pr = pruneStaleMergedBranches(cwd, base);
      if (pr.pruned.length) lines.push("", `Pruned ${pr.pruned.length} stale merged local branch(es): ${pr.pruned.join(", ")}`);
      // Targeted scope sweep (#70): a DONE (closed) task's branch whose PR is
      // confirmed MERGED on GitHub leaves a managed worktree behind forever —
      // the default sweep protects managed worktrees on purpose. Opt in via an
      // explicit `scope` limited to the existing local branches of DONE tasks;
      // each is still only deleted when it is a merge-base ancestor of base OR
      // its PR reports state=MERGED (`isPrMerged`/`tryMergePRMerged`, #68), so
      // unmerged / active / superseded branches (incl. task-52/53/54) are never
      // touched (default-deny). Recompute after the default sweep so already-
      // pruned done branches don't trigger a gh round-trip.
      const doneBranches = listTasks(cwd, { includeAll: true })
        .filter((t) => t.status === "done" && t.branch && branchExists(cwd, t.branch))
        .map((t) => t.branch!);
      let scoped = { pruned: [] as string[], skipped: [] as string[] };
      if (doneBranches.length) {
        scoped = pruneStaleMergedBranches(cwd, base, { scope: doneBranches });
        const donePruned = scoped.pruned.filter((b) => !pr.pruned.includes(b));
        if (donePruned.length) lines.push("", `Pruned ${donePruned.length} confirmed-DONE merged-task branch(es) + their worktrees: ${donePruned.join(", ")}`);
      }
      if (pr.skipped.length || scoped.skipped.length) lines.push("", `Kept branch(es) (not fully merged or in use): ${[...new Set([...pr.skipped, ...scoped.skipped])].join(", ")}`);
      // Also sweep merged REMOTE tracking branches (dead weight left by merged
      // PRs) — protected/unmerged/HEAD are untouched (see decideRemotePrunes).
      const prr = pruneStaleMergedRemoteBranches(cwd, base);
      if (prr.pruned.length) lines.push("", `Pruned ${prr.pruned.length} stale merged remote branch(es): ${prr.pruned.join(", ")}`);
      if (prr.skipped.length) lines.push("", `Kept remote branch(es) (not fully merged or protected): ${prr.skipped.join(", ")}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { axisCounts: r.summary } };
    },
  });
}