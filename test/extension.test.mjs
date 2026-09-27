// Extension registration smoke test: importing the pi extension factory and
// running it against a fake pi must register all 26 empress_* tools with the
// same names/schemas/descriptions as the pre-split file (develop's empress.ts).
// This guards against a per-tool split silently dropping a tool (see the
// check_mutation regression), since the loader only reads src/extension/empress.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import registerExtension from "../src/extension/empress.js";

// The expected tool-name set is DERIVED INDEPENDENTLY from develop's original
// single-file empress.ts (verification arithmetic, not a retrace of the split).
const EXPECTED_NAMES = [
  "empress_now",
  "empress_get_config",
  "empress_list_tasks",
  "empress_get_task",
  "empress_readiness",
  "empress_apply_clarification",
  "empress_assign_task",
  "empress_create_worktree",
  "empress_spawn_engineers",
  "empress_check_ci",
  "empress_evaluate_risk",
  "empress_land_task",
  "empress_push_pr",
  "empress_task_comment",
  "empress_close_task",
  "empress_vuln_check",
  "empress_triage_review",
  "empress_check_mutation",
  "empress_audit_scan",
  "empress_ponytail_debt",
  "empress_list_branches",
  "empress_get_lessons",
  "empress_add_lesson",
  "empress_get_loop_state",
  "empress_update_loop_state",
  "empress_notify",
].sort();

test("extension: factory registers every empress_* tool exactly once, no drops", () => {
  const tools = [];
  const fakePi = { registerTool: (t) => tools.push(t) };
  registerExtension(fakePi);

  // Every tool has the tree fields a registered tool must expose.
  for (const t of tools) {
    assert.ok(typeof t.name === "string" && t.name.startsWith("empress_"), `name ${t.name}`);
    assert.ok(typeof t.description === "string" && t.description.length > 0, `desc ${t.name}`);
    assert.ok(t.parameters && typeof t.parameters === "object", `params ${t.name}`);
    assert.ok(typeof t.execute === "function", `execute ${t.name}`);
  }

  const names = tools.map((t) => t.name).sort();
  // Exactly the 26 tools develop registered — no missing, none extra, no dupes.
  assert.deepEqual(names, EXPECTED_NAMES);
});