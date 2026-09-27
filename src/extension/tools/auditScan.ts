import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectAuditFindings } from "../../domain/audit.ts";
import { pruneStaleMergedBranches, pruneStaleMergedRemoteBranches } from "../../domain/git.ts";
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
      // harness itself. protects current branch + base + main + develop.
      const base = cfg().project.base_branch || "develop";
      const pr = pruneStaleMergedBranches(cwd, base);
      if (pr.pruned.length) lines.push("", `Pruned ${pr.pruned.length} stale merged local branch(es): ${pr.pruned.join(", ")}`);
      if (pr.skipped.length) lines.push("", `Kept branch(es) (not fully merged or in use): ${pr.skipped.join(", ")}`);
      // Also sweep merged REMOTE tracking branches (dead weight left by merged
      // PRs) — protected/unmerged/HEAD are untouched (see decideRemotePrunes).
      const prr = pruneStaleMergedRemoteBranches(cwd, base);
      if (prr.pruned.length) lines.push("", `Pruned ${prr.pruned.length} stale merged remote branch(es): ${prr.pruned.join(", ")}`);
      if (prr.skipped.length) lines.push("", `Kept remote branch(es) (not fully merged or protected): ${prr.skipped.join(", ")}`);
      return { content: [{ type: "text", text: lines.join("\n") }], details: { axisCounts: r.summary } };
    },
  });
}